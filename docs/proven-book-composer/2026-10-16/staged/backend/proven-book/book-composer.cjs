#!/usr/bin/env node
/**
 * BOOK COMPOSER — the proven book (R353) and the Stacker on ONE account. 2026-10-16 (docs/proven-book-composer/2026-10-16).
 * Installed at home as backend/proven-book/book-composer.cjs. It COMPOSES; it never decides a sleeve's rule and never sends anything:
 * it reads tonight's sleeve intents and the book, and writes a plan. No broker call, no network, no order.
 *
 * THE SLEEVES (each one's own runner decides its signals; the composer only sizes and fits them):
 *   R180  month-end Treasuries: IEF held from the close of the month's 6th-to-last session through the close of its last session (R180's
 *         registered rule, N3). r180Want() gives that state from the month's session list; the plan sizes it.
 *   R313  IBS dip-buy on 20 ETFs, R328 RSI-2 dip-buy on 20 ETFs: each night their runners hand over EXITS (held names their rule closes at
 *         the close) and ENTRIES (names their rule buys at the close).
 * THE COMPOSITION (config: proven-book-composer-v1):
 *   - ONE capital, NO MARGIN: after the plan, gross exposure <= exposureCap x equity (exposureCap <= 1, refused above), and buys are paid from
 *     cash on hand (config.countExitProceeds: proceeds of tonight's exits count only when true; default false — a cash account does not
 *     spend what has not settled).
 *   - DIP-BUYS AT FULL SIZE: every dip entry is its sleeve's slotUsd, or it is SKIPPED (never shrunk). Order: config.entryPriority (sleeve
 *     order), then each sleeve's own rank, then symbol. Held dip positions are never cut by the composer (only their own exits close them).
 *   - R180 TAKES WHAT IS LEFT up to its targetUsd and YIELDS to dip-buys: when tonight's dip entries need room, the IEF position is trimmed
 *     (config.r180YieldsToDips, default true) — it is the one sleeve sized to fit; it is never grown past targetUsd.
 *   - IDLE CASH IS OFFERED to the second layer (the Stacker): offer = min(cash after the plan, cap room after the plan) - reserveUsd, never
 *     below 0. The composer only states the offer; the Stacker's own rule (registered at home) decides whether and how to use it, and its
 *     positions come back as held positions of sleeve "stacker" the next night (then they count against the cap like any other, and they
 *     are what yields FIRST when a dip entry, or R180's window, needs room: config.stackerYields, default true). In a CASH account
 *     (countExitProceeds false) a Stacker sale frees cap room tonight but cash only tomorrow: the offer therefore holds back reserveUsd (set
 *     it to the dips' usual nightly demand) and, on the night before R180's window opens, R180's missing amount; the Stacker should hold
 *     instruments that can be sold at the close.
 *   - OVER THE CAP before any buy (held positions grew, or equity fell): the Stacker, then R180, are cut back toward the cap; held dip positions
 *     are never cut, and nothing is bought while they alone are over it.
 *   - Integer shares: a dip entry buys floor(slotUsd / price) shares (0 shares = skipped); IEF floor((target) / price).
 *
 *   node backend/proven-book/book-composer.cjs --input <nightly.json> --config <config.json> --out <plan.json>   writes the plan (atomic)
 *   node backend/proven-book/book-composer.cjs --input <nightly.json> --config <config.json>                    prints it, writes nothing
 * TIMING: every order of the plan is meant to fill at asOf's CLOSE (the dip rules and R180 are close-to-close). If the proven book executes
 * the plan later (the next session), each sleeve shifts by a session — confirm at home before use.
 * nightly.json (proven-book-nightly-v1): { asOf: "YYYY-MM-DD", cash, positions: [{ sleeve, sym, qty, price }], prices: { SYM: last close },
 *   intents: { R313: { exits: [sym], entries: [{ sym, rank }] }, R328: {...}, R180: { want: true|false } | { monthSessions: [dates], closedWeekdays: [dates] } } }
 */
"use strict";
const fs = require("fs"), path = require("path");
const fin = Number.isFinite, r2 = (x) => Math.round(x * 100) / 100;
// money comparisons with a hundredth-of-a-cent tolerance: an exact fit (room equal to the cost, give or take float noise) FITS (checker D1)
const EPS = 1e-4, short = (have, need) => have < need - EPS;
const DIP = ["R313", "R328"], CAL = "R180", STACKER = "stacker", SLEEVES = [...DIP, CAL, STACKER];

/**
 * R180's registered window (N3): after the close of `asOf`, hold IEF iff asOf is one of the month's sessions -6..-2 (the entry is at the
 * close of session -6, the exit at the close of session -1). The month's FULL calendar is required (checker cycle 2, X2/X3): monthSessions =
 * its trading sessions, closedWeekdays = its weekdays the exchange is closed (holidays); together they must be EVERY weekday of the month,
 * each once — so a list of "the sessions seen so far" can never pass for the month. -> { want, wantNext } (wantNext: the state after the
 * NEXT session's close; false after the month's last session, since a month's first sessions are never in its window).
 */
function r180Window(asOf, monthSessions, closedWeekdays = []) {
  const okDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d + "T12:00:00Z").toISOString().slice(0, 10) === d;
  if (!okDate(asOf)) throw new Error(`R180: asOf ${JSON.stringify(asOf)} is not a date`);
  if (!Array.isArray(monthSessions) || !monthSessions.length) throw new Error("R180: monthSessions must be a non-empty list of dates");
  if (!Array.isArray(closedWeekdays)) throw new Error("R180: closedWeekdays must be a list of dates");
  const ym = asOf.slice(0, 7), all = [...monthSessions, ...closedWeekdays];
  for (const d of all) {
    if (!okDate(d)) throw new Error(`R180: ${JSON.stringify(d)} is not a date`);
    if (d.slice(0, 7) !== ym) throw new Error(`R180: ${d} is not in asOf's month`);
    const g = new Date(d + "T12:00:00Z").getUTCDay(); if (g === 0 || g === 6) throw new Error(`R180: ${d} is a weekend day`);
  }
  if (new Set(all).size !== all.length) throw new Error("R180: a date is given twice (monthSessions and closedWeekdays must not repeat or overlap)");
  const [y, m] = ym.split("-").map(Number), dim = new Date(Date.UTC(y, m, 0)).getUTCDate(), have = new Set(all);
  for (let d = 1; d <= dim; d++) { const t = `${ym}-${String(d).padStart(2, "0")}`, g = new Date(t + "T12:00:00Z").getUTCDay(); if (g !== 0 && g !== 6 && !have.has(t)) throw new Error(`R180: the weekday ${t} is neither a session nor a closed weekday — the month's whole calendar is required`); }
  const s = [...monthSessions].sort(), i = s.indexOf(asOf);
  if (i < 0) throw new Error(`R180: ${asOf} is not a session of the month given`);
  const inWin = (k) => { const fromEnd = s.length - k; return fromEnd >= 2 && fromEnd <= 6; };   // fromEnd 1 = the last session
  return { want: inWin(i), wantNext: i + 1 < s.length ? inWin(i + 1) : false };
}
const r180Want = (asOf, monthSessions, closedWeekdays = []) => r180Window(asOf, monthSessions, closedWeekdays).want;

/** check a config (throws listing every problem) */
function checkConfig(c) {
  const bad = [], e = (x) => bad.push(x);
  if (!c || c.schema !== "proven-book-composer-v1") e('schema must be "proven-book-composer-v1"');
  if (!(fin(c && c.capitalUsd) && c.capitalUsd > 0)) e("capitalUsd > 0");
  if (!(fin(c && c.exposureCap) && c.exposureCap > 0 && c.exposureCap <= 1)) e("exposureCap in (0, 1] — above 1 is margin, refused");
  for (const s of DIP) if (!(c && c.sleeves && c.sleeves[s] && fin(c.sleeves[s].slotUsd) && c.sleeves[s].slotUsd > 0)) e(`sleeves.${s}.slotUsd > 0 (R353's per-name size)`);
  if (!(c && c.sleeves && c.sleeves[CAL] && fin(c.sleeves[CAL].targetUsd) && c.sleeves[CAL].targetUsd >= 0 && typeof c.sleeves[CAL].sym === "string")) e(`sleeves.${CAL}: targetUsd >= 0 and sym (IEF)`);
  if (!(c && Array.isArray(c.entryPriority) && c.entryPriority.length === DIP.length && DIP.every((s) => c.entryPriority.includes(s)))) e(`entryPriority: an order of ${DIP.join(", ")}`);
  if (!(fin(c && c.reserveUsd) && c.reserveUsd >= 0)) e("reserveUsd >= 0");
  if (bad.length) throw new Error("the config is refused:\n  - " + bad.join("\n  - "));
  return { countExitProceeds: false, r180YieldsToDips: true, stackerYields: true, ...c };
}
/** check tonight's input (throws listing every problem) */
function checkNightly(n) {
  const bad = [], e = (x) => bad.push(x);
  if (!n || n.schema !== "proven-book-nightly-v1") e('schema must be "proven-book-nightly-v1"');
  if (!/^\d{4}-\d{2}-\d{2}$/.test((n && n.asOf) || "")) e("asOf YYYY-MM-DD");
  if (!(fin(n && n.cash) && n.cash >= 0)) e("cash >= 0 (a negative cash balance is margin in use — refused)");
  const P = (n && n.prices) || {};
  for (const [i, p] of ((n && n.positions) || []).entries()) {
    if (!SLEEVES.includes(p.sleeve)) e(`positions[${i}]: unknown sleeve ${JSON.stringify(p.sleeve)}`);
    if (!(Number.isInteger(p.qty) && p.qty > 0)) e(`positions[${i}] ${p.sym}: qty a positive integer (no shorts)`);
    if (!(fin(P[p.sym]) && P[p.sym] > 0)) e(`positions[${i}] ${p.sym}: no price tonight`);
  }
  const seen = new Set(); for (const p of (n && n.positions) || []) { const k = p.sleeve + " " + p.sym; if (seen.has(k)) e(`positions: ${k} twice`); seen.add(k); }
  const I = (n && n.intents) || {};
  for (const s of DIP) {
    const x = I[s];   // REQUIRED: a missing block means its runner did not report — never read as "nothing to do" (checker D2)
    if (!x || !Array.isArray(x.exits) || !Array.isArray(x.entries)) { e(`intents.${s}: exits [] and entries [] (an empty list when none; a missing block is refused)`); continue; }
    for (const [k, en] of x.entries.entries()) if (!en || typeof en !== "object" || typeof en.sym !== "string" || !en.sym || (en.rank != null && !fin(en.rank))) e(`intents.${s}.entries[${k}]: { sym, rank? (a number) }`);
    for (const [k, sym] of x.exits.entries()) if (typeof sym !== "string" || !sym) e(`intents.${s}.exits[${k}]: a symbol`);
  }
  if (!I[CAL] || !(typeof I[CAL].want === "boolean" || Array.isArray(I[CAL].monthSessions))) e(`intents.${CAL}: want (true/false) or monthSessions (+ closedWeekdays)`);
  if (bad.length) throw new Error("tonight's input is refused:\n  - " + bad.join("\n  - "));
  return n;
}

/**
 * COMPOSE (pure). -> { asOf, equity, capUsd, orders: [{ sleeve, sym, side, qty, estUsd, why }], skipped: [...], after: {...}, offer: {...}, checks }
 * The "orders" are a PLAN for the sleeves' own order paths; the composer sends nothing.
 */
function compose(nightly, config) {
  const C = checkConfig(config), N = checkNightly(nightly), P = N.prices, px = (s) => P[s];
  for (const p of N.positions) if (p.sleeve === CAL && p.sym !== C.sleeves[CAL].sym) throw new Error(`a held R180 position is ${p.sym}, but the config's R180 instrument is ${C.sleeves[CAL].sym} — refused (it could never be closed by R180's window)`);
  const held = N.positions.map((p) => ({ ...p, usd: p.qty * px(p.sym) }));
  const equity = N.cash + held.reduce((a, p) => a + p.usd, 0), capUsd = C.exposureCap * equity;
  const orders = [], skipped = [], notes = [];
  // 1. the dip sleeves' exits (their rule closes them at the close): they leave the book
  const pos = new Map(held.map((p) => [p.sleeve + " " + p.sym, { ...p }]));
  let cash = N.cash, pending = 0;            // pending: tonight's sale proceeds (spendable only when countExitProceeds)
  for (const s of DIP) for (const sym of [...new Set(N.intents[s] ? N.intents[s].exits : [])].sort()) {
    const k = s + " " + sym, p = pos.get(k);
    if (!p) { notes.push(`${s} exit ${sym}: not held by ${s} — ignored`); continue; }
    orders.push({ sleeve: s, sym, side: "sell", qty: p.qty, estUsd: r2(p.usd), why: "its rule's exit" }); pending += p.usd; pos.delete(k);
  }
  // 2. R180's wanted state tonight
  const cal = C.sleeves[CAL], win = typeof N.intents[CAL].want === "boolean" ? { want: N.intents[CAL].want, wantNext: null } : r180Window(N.asOf, N.intents[CAL].monthSessions, N.intents[CAL].closedWeekdays || []), want = win.want;
  const calKey = CAL + " " + cal.sym, calHeld = pos.get(calKey);
  const gross = () => [...pos.values()].reduce((a, p) => a + p.qty * px(p.sym), 0);
  const spendable = () => cash + (C.countExitProceeds ? pending : 0);
  const room = () => Math.min(capUsd - gross(), spendable());
  // when R180 is not wanted, it is sold first (its proceeds behave like any exit's)
  if (calHeld && !want) { orders.push({ sleeve: CAL, sym: cal.sym, side: "sell", qty: calHeld.qty, estUsd: r2(calHeld.qty * px(cal.sym)), why: "R180 window closed" }); pending += calHeld.qty * px(cal.sym); pos.delete(calKey); }
  // 2b. OVER THE CAP before any buy (held positions grew, or equity fell): the yielding layers are cut back toward the cap — the Stacker
  //     first, then R180 — whatever the yield flags (a cap is a cap). Held dip positions are never cut: only their own exits close them;
  //     until then nothing is bought.
  const overCap = () => gross() - capUsd;
  const trimFor = (sleeve) => {
    for (const [k, p] of [...pos.entries()].filter(([, p]) => p.sleeve === sleeve).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (overCap() <= 1e-9) break;
      const price = px(p.sym), q = Math.min(p.qty, Math.ceil(overCap() / price));
      orders.push({ sleeve, sym: p.sym, side: "sell", qty: q, estUsd: r2(q * price), why: "over the exposure cap — trimmed back toward it" }); pending += q * price; p.qty -= q; if (p.qty === 0) pos.delete(k);
    }
  };
  if (overCap() > 1e-9) { trimFor(STACKER); trimFor(CAL); if (overCap() > 1e-9) notes.push(`over the exposure cap by ${r2(overCap())} with held dip positions alone — nothing is bought until their exits bring the book under it`); }
  const dipHeldAfterExits = [...pos.values()].filter((p) => DIP.includes(p.sleeve)).reduce((a, p) => a + p.qty * px(p.sym), 0);
  // 3. dip entries, full size or skipped, in priority order; R180 and then the Stacker yield room when allowed
  const yieldFrom = (sleeve, needUsd, forWhat = "a dip-buy") => {   // sell whole shares of a yielding position to free needUsd; returns usd freed into `pending`
    let freed = 0;
    for (const [k, p] of [...pos.entries()].filter(([, p]) => p.sleeve === sleeve).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (freed >= needUsd) break;
      const price = px(p.sym), q = Math.min(p.qty, Math.ceil((needUsd - freed) / price));
      orders.push({ sleeve, sym: p.sym, side: "sell", qty: q, estUsd: r2(q * price), why: `yields to ${forWhat} (${sleeve === STACKER ? "the second layer never crowds out the first" : "R180 is sized to fit"})` });
      freed += q * price; p.qty -= q; if (p.qty === 0) pos.delete(k);
    }
    return freed;
  };
  const entries = [];
  for (const s of C.entryPriority) for (const x of (N.intents[s] ? N.intents[s].entries : []).slice().sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || String(a.sym).localeCompare(String(b.sym)))) entries.push({ sleeve: s, ...x });
  for (const x of entries) {
    const price = px(x.sym), slot = C.sleeves[x.sleeve].slotUsd;
    if (!(fin(price) && price > 0)) { skipped.push({ sleeve: x.sleeve, sym: x.sym, why: "no price tonight" }); continue; }
    if (pos.has(x.sleeve + " " + x.sym)) { skipped.push({ sleeve: x.sleeve, sym: x.sym, why: "already held by this sleeve (one position per name)" }); continue; }
    const qty = Math.floor(slot / price), usd = qty * price;
    if (qty < 1) { skipped.push({ sleeve: x.sleeve, sym: x.sym, why: `one share (${price}) is more than the slot (${slot})` }); continue; }
    if (short(room(), usd)) {
      // free room from the yielding layers: the Stacker first, then R180 — both are SALES, so the room they add is in `pending`: it counts
      // against the CAP at once, and against CASH only when countExitProceeds (a cash account spends settled cash). Nothing is sold unless
      // the entry then fits at full size: a yield that would not make room is never made.
      const yieldable = [[STACKER, C.stackerYields], [CAL, C.r180YieldsToDips]].filter(([, on]) => on).reduce((a, [sl]) => a + [...pos.values()].filter((p) => p.sleeve === sl).reduce((b, p) => b + p.qty * px(p.sym), 0), 0);
      const fits = !short(capUsd - gross() + yieldable, usd) && !short(spendable() + (C.countExitProceeds ? yieldable : 0), usd);
      if (fits) for (const [sl, onOff] of [[STACKER, C.stackerYields], [CAL, C.r180YieldsToDips]]) {
        if (!onOff || !short(room(), usd)) continue;
        const capShort = usd - (capUsd - gross()), cashShort = usd - spendable();
        const need = Math.max(capShort, C.countExitProceeds ? cashShort : 0);
        if (need > EPS) { const f = yieldFrom(sl, need - EPS); pending += f; }
      }
    }
    if (short(room(), usd)) { skipped.push({ sleeve: x.sleeve, sym: x.sym, why: `no room at full size (needs ${r2(usd)}, room ${r2(Math.max(0, room()))}) — skipped, never shrunk` }); continue; }
    orders.push({ sleeve: x.sleeve, sym: x.sym, side: "buy", qty, estUsd: r2(usd), why: "its rule's entry, full slot" });
    if (C.countExitProceeds) { const fromPending = Math.min(pending, usd); pending -= fromPending; cash -= usd - fromPending; } else cash -= usd;
    pos.set(x.sleeve + " " + x.sym, { sleeve: x.sleeve, sym: x.sym, qty, price });
  }
  // 4. R180 up to its target, with what is left (never past the target; trimmed to the target if above)
  if (want) {
    const price = px(cal.sym); if (!(fin(price) && price > 0)) throw new Error(`no price tonight for ${cal.sym}`);
    const cur = pos.get(calKey), curQ = cur ? cur.qty : 0, targetQ = Math.floor(cal.targetUsd / price);
    if (curQ > targetQ) { const q = curQ - targetQ; orders.push({ sleeve: CAL, sym: cal.sym, side: "sell", qty: q, estUsd: r2(q * price), why: "R180 above its target" }); pending += q * price; if (targetQ) cur.qty = targetQ; else pos.delete(calKey); }
    else if (curQ < targetQ) {
      // the second layer never crowds out the first (checker cycle 2, X1): the Stacker yields to R180's buy-up too — for the cap at once, and
      // for cash only when proceeds count (a cash account cannot spend tonight's Stacker sale tonight)
      if (C.stackerYields) {
        const want$ = (targetQ - curQ) * price, capRoom = capUsd - gross(), capShort = want$ - capRoom;
        const need = C.countExitProceeds ? Math.max(capShort, want$ - spendable()) : Math.min(capShort, spendable() - capRoom);
        if (need > EPS && [...pos.values()].some((p) => p.sleeve === STACKER)) { const f = yieldFrom(STACKER, need, "R180's window"); pending += f; }
      }
      const q = Math.min(targetQ - curQ, Math.floor((Math.max(0, room()) + EPS) / price));
      if (q > 0) { orders.push({ sleeve: CAL, sym: cal.sym, side: "buy", qty: q, estUsd: r2(q * price), why: q < targetQ - curQ ? "R180 up to what is left" : "R180 to its target" }); if (C.countExitProceeds) { const u = q * price, fp = Math.min(pending, u); pending -= fp; cash -= u - fp; } else cash -= q * price; if (cur) cur.qty += q; else pos.set(calKey, { sleeve: CAL, sym: cal.sym, qty: q, price }); }
      if (curQ + q < targetQ) notes.push(`R180 below its target: ${curQ + q} of ${targetQ} shares (the cap or the settled cash is taken by the dip-buys, or is in the Stacker and not settled until tomorrow)`);
    }
  }
  // 5. the offer to the second layer
  const grossAfter = gross(), cashAfter = cash + (C.countExitProceeds ? pending : 0);
  // in a cash account the Stacker's money is not free again until the day after it sells: on the night before R180's window opens, R180's
  // missing amount is held back from the offer, so tomorrow's entry finds settled cash (checker cycle 2, X1). Tomorrow's DIP demand is
  // unknown tonight: reserveUsd is that hold-back (NOTES: set it from R353 to the dip sleeves' usual nightly demand).
  const calNowUsd = [...pos.values()].filter((p) => p.sleeve === CAL).reduce((a, p) => a + p.qty * px(p.sym), 0);
  const holdBackR180 = !C.countExitProceeds && win.wantNext === true && !want ? Math.max(0, cal.targetUsd - calNowUsd) : 0;
  const offerUsd = Math.max(0, Math.min(capUsd - grossAfter, cashAfter) - C.reserveUsd - holdBackR180);
  const bySleeve = Object.fromEntries(SLEEVES.map((s) => [s, r2([...pos.values()].filter((p) => p.sleeve === s).reduce((a, p) => a + p.qty * px(p.sym), 0))]));
  const checks = {
    grossWithinCap: grossAfter <= Math.max(capUsd, dipHeldAfterExits) + 2 * EPS && (grossAfter <= capUsd + 2 * EPS || !orders.some((o) => o.side === "buy")),
    noMargin: cash >= -2 * EPS && C.exposureCap <= 1,
    dipEntriesFullSlotOrSkipped: orders.filter((o) => o.side === "buy" && DIP.includes(o.sleeve)).every((o) => o.qty === Math.floor(C.sleeves[o.sleeve].slotUsd / px(o.sym))),
    heldDipsUntouchedExceptExits: orders.filter((o) => o.side === "sell" && DIP.includes(o.sleeve)).every((o) => o.why === "its rule's exit"),
    offerNonNegative: offerUsd >= 0,
  };
  if (!Object.values(checks).every(Boolean)) throw new Error(`composer invariant broken: ${JSON.stringify(checks)}`);
  return {
    schema: "proven-book-plan-v1", asOf: N.asOf, equity: r2(equity), capUsd: r2(capUsd), cashBefore: r2(N.cash),
    orders, skipped, notes,
    after: { grossUsd: r2(grossAfter), cashUsd: r2(cash), unsettledProceedsUsd: r2(pending), bySleeve, positions: [...pos.values()].map((p) => ({ sleeve: p.sleeve, sym: p.sym, qty: p.qty })).sort((a, b) => (a.sleeve + a.sym).localeCompare(b.sleeve + b.sym)) },
    offer: { toLayer: STACKER, usd: r2(offerUsd), reserveUsd: C.reserveUsd, heldBackForR180Usd: r2(holdBackR180), note: "idle cash the second layer may use tonight; its rule decides (registered at home)" },
    r180: { want, wantNext: win.wantNext, targetUsd: cal.targetUsd }, checks,
    config: { exposureCap: C.exposureCap, countExitProceeds: C.countExitProceeds, r180YieldsToDips: C.r180YieldsToDips, stackerYields: C.stackerYields, entryPriority: C.entryPriority },
  };
}

function main(argv, deps = {}) {
  const log = deps.log || console.log, err = deps.err || console.error, a = argv.slice(), opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const known = new Set(["--input", "--config", "--out"]);
  for (let i = 0; i < a.length; i += 2) if (!known.has(a[i]) || a[i + 1] == null) { err("usage: node backend/proven-book/book-composer.cjs --input <nightly.json> --config <config.json> [--out <plan.json>]"); return 2; }
  if (!opt("--input") || !opt("--config")) { err("usage: --input and --config are required"); return 2; }
  try {
    const plan = compose(JSON.parse(fs.readFileSync(opt("--input"), "utf8")), JSON.parse(fs.readFileSync(opt("--config"), "utf8")));
    if (opt("--out")) { (deps.writeJson || require(path.join(__dirname, "..", "lib", "atomic-write.js")).writeJsonAtomic)(opt("--out"), plan); log(`PLAN ${plan.asOf}: ${plan.orders.length} order(s), ${plan.skipped.length} skipped, gross ${plan.after.grossUsd} of cap ${plan.capUsd}, offer to the ${plan.offer.toLayer} ${plan.offer.usd} — written ${opt("--out")}`); }
    else log(JSON.stringify(plan, null, 1));
    return 0;
  } catch (e) { err("REFUSED: " + e.message); return 1; }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { DIP, CAL, STACKER, r180Want, r180Window, checkConfig, checkNightly, compose, main };
