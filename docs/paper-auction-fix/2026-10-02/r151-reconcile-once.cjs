#!/usr/bin/env node
"use strict";
/**
 * R151 ONE-TIME RECONCILE — PAPER-AUCTION-FIX 2026-10-02 (operator "yes" 2026-10-02).
 *
 * WHY. R151 traded market-on-open / market-on-close orders that Alpaca paper barely fills. A partially filled auction order ends
 * "expired" with filled_qty > 0, and R151's reconcile read EXITS by status alone: six partial exits were logged "exit-not-filled", the
 * lots stayed at their full quantity, and the state drifted from the broker (C CRM sold 3 of 4, lot still 4). Entries were already
 * taken at filled_qty. This script rebuilds every R151 lot from the broker's own fills, once, before the patched runner (R311 on day
 * orders) takes over the same state file.
 *
 * WHAT. GETs every order whose client_order_id starts "r151-" on the MAIN paper account, walks each arm x symbol chain in submission
 * order and rebuilds the lot from filled_qty / filled_avg_price only:
 *   - partial entry          -> lot qty = filled_qty
 *   - partial exit           -> lot qty = remaining, a trade row for the filled part, the remainder EXIT-OWED (re-sent at the arm's next
 *                               window by the patched runner, -S2 client_order_id)
 *   - fills the ledger missed -> trade rows
 *   - an in-flight order the state still calls pending/exiting is resolved exactly as the patched runner would resolve it
 * and compares the result with backend/data/r151-state.json and backend/data/r151-ledger.jsonl.
 *
 *   node docs/paper-auction-fix/2026-10-02/r151-reconcile-once.cjs            DRY (default): prints the full diff; writes NOTHING
 *   node docs/paper-auction-fix/2026-10-02/r151-reconcile-once.cjs --apply    writes backend/data/r151-state.json (atomic, via
 *        backend/lib/atomic-write.js) and APPENDS kind "reconcile-correction" / test "R151" rows to backend/data/r151-ledger.jsonl.
 *        History is never rewritten: a correction row supersedes, it does not edit. Refuses inside the runner's ET windows, when the
 *        state changed while it ran, when it was already applied, or when any r311- order exists (it is a pre-R311 tool).
 *
 * BROKER ACCESS IS GET ONLY (orders list, calendar). Nothing is ever sent, cancelled or replaced.
 */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../../.."), BK = path.join(ROOT, "backend"), DATA_DIR = path.join(BK, "data");
const STATE = path.join(DATA_DIR, "r151-state.json"), LEDGER = path.join(DATA_DIR, "r151-ledger.jsonl");
const APPLY = process.argv.includes("--apply"), BASE = "https://paper-api.alpaca.markets";
const TERMINAL = ["filled", "canceled", "expired", "rejected", "done_for_day"];
const CID_RE = /^r151-([ABC])-(.+)-(\d{8})-(B|S\d*)$/;
const iso = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
const LOT_FIELDS = ["status", "qty", "entryCid", "entryFill", "entryFilledAt", "exitCid", "exitOwed", "exitSeq", "test"];
const pick = (l) => (l ? Object.fromEntries(["arm", "sym", ...LOT_FIELDS].filter((k) => l[k] !== undefined).map((k) => [k, l[k]])) : null);
const same = (a, b) => (a ?? null) === (b ?? null);

/**
 * PURE. state + ledger rows + broker orders -> { state (rebuilt), corrections (ledger rows to append), diff (lines), anomalies, info }.
 * prevSession(isoDate) -> previous trading date (only used to date the signal of a lot the state does not know at all).
 * lastSession = the latest trading session that has CLOSED (see lastClosedSession): a lot whose LAST exit order ended incomplete on that
 * session has had no later exit window, so its exit is still owed — exactly what the patched runner's reconcile would have recorded.
 */
/**
 * PURE. The latest session on or before `today` whose close has passed: today counts only from its close + 15 min ET (review 2026-10-02 —
 * applied on Monday 10-05 before the open, "on or before today" made 10-05 the last session, and A|NOW / A|UNH, whose 10-02 exits
 * expired unfilled, lost exitOwed and would have waited for the signal again). cal = Alpaca calendar rows { date, close "HH:MM" }.
 */
function lastClosedSession(cal, today, mins) {
  const closeMins = (c) => { const [h, m] = String(c.close || "16:00").split(":").map(Number); return h * 60 + m; };
  return cal.filter((c) => c.date < today || (c.date === today && mins >= closeMins(c) + 15)).map((c) => c.date).sort().pop() || null;
}
function rebuild(state, rows, orders, prevSession, nowIso, lastSession) {
  const diff = [], corrections = [], anomalies = [], info = [];
  const mine = orders.filter((o) => CID_RE.test(o.client_order_id || "")).sort((a, b) => (a.submitted_at < b.submitted_at ? -1 : a.submitted_at > b.submitted_at ? 1 : 0));
  const byCid = new Map(mine.map((o) => [o.client_order_id, o]));
  const chains = new Map();
  for (const o of mine) { const [, arm, sym, d, leg] = CID_RE.exec(o.client_order_id); const k = `${arm}|${sym}`; if (!chains.has(k)) chains.set(k, []); chains.get(k).push({ o, arm, sym, d, leg }); }

  // 1. broker truth per arm x symbol
  const truth = new Map(), parts = [];
  for (const [k, ch] of chains) {
    let lot = null;
    for (const { o, arm, sym, d } of ch) {
      const cid = o.client_order_id, f = Number(o.filled_qty) || 0, px = Number(o.filled_avg_price) || null, working = !TERMINAL.includes(o.status), at = o.filled_at || o.updated_at || null;
      if (f > 0 && !px) { anomalies.push(`${k}: ${cid} reports filled_qty ${f} without a price — left out`); continue; }
      if (o.side === "buy") {
        if (lot) { if (f > 0 || working) anomalies.push(`${k}: buy ${cid} while lot ${lot.entryCid} still holds ${lot.qty} — not merged`); continue; }
        if (working) { lot = { arm, sym, status: "pending", qty: Number(o.qty), entryCid: cid, signalDay: d }; continue; }
        if (f > 0) lot = { arm, sym, status: "open", qty: f, ordered: Number(o.qty), entryCid: cid, entryFill: px, entryOrderId: o.id, entryFilledAt: at, signalDay: d, filledParts: 0, lastSell: null };
        continue;
      }
      if (!lot || lot.status === "pending") { if (f > 0 || working) anomalies.push(`${k}: sell ${cid} (${o.status}, filled ${f}) with no filled lot on this arm`); continue; }
      if (working) { lot.status = "exiting"; lot.exitCid = cid; continue; }
      const sold = Math.min(f, lot.qty);
      if (f > lot.qty) anomalies.push(`${k}: ${cid} sold ${f} > lot ${lot.qty} — ${f - lot.qty} share(s) belonged to another arm or runner`);
      if (sold > 0) { parts.push({ arm, sym, qty: sold, entryDate: (lot.entryFilledAt || "").slice(0, 10), exitDate: (at || "").slice(0, 10), entryFill: lot.entryFill, exitFill: px, ret: +(px / lot.entryFill - 1).toFixed(6), entryCid: lot.entryCid, exitCid: cid, ...(sold < lot.qty ? { partialExit: true, remainingQty: lot.qty - sold } : {}), brokerStatus: o.status, orderQty: Number(o.qty) }); lot.qty -= sold; lot.filledParts++; }
      lot.lastSell = { cid, sold, status: o.status, day: iso(d) };
      if (lot.qty === 0) lot = null; else { lot.status = "open"; lot.exitCid = null; }
    }
    if (lot) truth.set(k, lot);
  }

  // 2. lots: state vs truth
  const st = JSON.parse(JSON.stringify(state)), stateBy = new Map(st.lots.map((l) => [`${l.arm}|${l.sym}`, l])), signalOf = new Map();
  for (const l of st.lots) if (l.entryCid) signalOf.set(l.entryCid, l.signalDate);
  for (const r of rows) if (r.entryCid && r.signalDate) signalOf.set(r.entryCid, r.signalDate);
  const signalDateFor = (t) => signalOf.get(t.entryCid) || (t.arm === "A" ? iso(t.signalDay) : prevSession(iso(t.signalDay)));
  const out = [], seen = new Set();
  const settle = (k, s0) => {
    seen.add(k); const t = truth.get(k);
    if (s0 && !/^r151-/.test(s0.entryCid || "")) { info.push(`${k}: lot ${s0.entryCid} is not an r151- entry — untouched`); return s0; }
    if (!t) {
      if (!s0) return null;
      const eo = byCid.get(s0.entryCid), reason = s0.status === "pending" && eo && TERMINAL.includes(eo.status) && !(Number(eo.filled_qty) > 0) ? "entry order ended unfilled" : "the broker shows this arm's position closed";
      diff.push(`REMOVE lot ${k} (${s0.entryCid}, state ${s0.status} qty ${s0.qty}) — ${reason}`);
      if (reason === "entry order ended unfilled") corrections.push({ action: "unfilled-entry", arm: s0.arm, sym: s0.sym, signalDate: s0.signalDate, cid: s0.entryCid, brokerStatus: eo.status, limit: s0.limit ?? null });
      corrections.push({ action: "remove-lot", arm: s0.arm, sym: s0.sym, entryCid: s0.entryCid, before: pick(s0), reason });
      return null;
    }
    const base = s0 && s0.entryCid === t.entryCid ? { ...s0 } : { arm: t.arm, sym: t.sym, signalDate: signalDateFor(t), rebuiltFromBroker: true };
    const nl = { ...base, arm: t.arm, sym: t.sym, qty: t.qty, status: t.status, entryCid: t.entryCid, test: "R151" };
    if (t.status !== "pending") Object.assign(nl, { entryFill: t.entryFill, entryOrderId: t.entryOrderId, entryFilledAt: t.entryFilledAt });
    // the orders LIST prints microseconds, by_client_order_id nanoseconds: the same instant is not a change — keep the state's string
    if (s0 && s0.entryFilledAt && nl.entryFilledAt && Math.abs(Date.parse(s0.entryFilledAt) - Date.parse(nl.entryFilledAt)) < 1000) nl.entryFilledAt = s0.entryFilledAt;
    nl.exitCid = t.status === "exiting" ? t.exitCid : null;
    const partialRemainder = t.status === "open" && t.filledParts > 0;
    const inflightIncomplete = s0 && s0.status === "exiting" && t.status === "open" && t.lastSell && t.lastSell.cid === s0.exitCid;
    const lastWindowIncomplete = t.status === "open" && t.lastSell && t.lastSell.day === lastSession;   // no exit window has passed since
    if (partialRemainder || inflightIncomplete || lastWindowIncomplete || (s0 && s0.exitOwed)) nl.exitOwed = true;
    if (partialRemainder) nl.exitSeq = Math.max(1, nl.exitSeq || 0);   // the next exit order is -S2
    const changed = !s0 ? LOT_FIELDS : LOT_FIELDS.filter((f) => !same(s0[f], nl[f]));
    const material = changed.filter((f) => f !== "test");
    if (!s0) diff.push(`ADD lot ${k} ${JSON.stringify(pick(nl))} — broker fill the state does not know`);
    else if (material.length) diff.push(`SET lot ${k} (${t.entryCid}): ${material.map((f) => `${f} ${JSON.stringify(s0[f] ?? null)} -> ${JSON.stringify(nl[f] ?? null)}`).join(", ")}${partialRemainder ? ` [partial exit: ${t.filledParts} filled part(s); remainder owed]` : inflightIncomplete || lastWindowIncomplete ? ` [exit ${t.lastSell.cid} ended ${t.lastSell.status} with ${t.lastSell.sold} filled on the last session ${t.lastSell.day}; owed]` : ""}`);
    if (!s0 || material.length) corrections.push({ action: s0 ? "set-lot" : "add-lot", arm: t.arm, sym: t.sym, entryCid: t.entryCid, before: pick(s0), after: pick(nl) });
    return nl;
  };
  for (const l of st.lots) { const k = `${l.arm}|${l.sym}`; if (seen.has(k)) { anomalies.push(`${k}: the state holds two lots for one arm x symbol — second kept as is`); out.push(l); continue; } const nl = settle(k, l); if (nl) out.push(nl); }
  for (const k of [...truth.keys()].sort()) if (!seen.has(k)) { const nl = settle(k, null); if (nl) out.push(nl); }
  const stamped = out.filter((l) => l.test === "R151" && /^r151-/.test(l.entryCid || "")).length;
  st.lots = out;

  // 3. trade parts vs ledger (trade rows and earlier add-trade corrections, matched by exitCid)
  const ledgerParts = rows.filter((r) => r.kind === "trade" || (r.kind === "reconcile-correction" && r.action === "add-trade"));
  for (const p of parts) {
    const have = ledgerParts.filter((r) => r.exitCid === p.exitCid), prior = rows.filter((r) => r.cid === p.exitCid).map((r) => r.kind);
    if (!have.length) {
      diff.push(`ADD trade ${p.arm}|${p.sym} ${p.qty} @ ${p.exitFill} on ${p.exitDate} (entry ${p.entryFill} ${p.entryDate}, ret ${(100 * p.ret).toFixed(3)}%) from ${p.exitCid} [broker ${p.brokerStatus} ${p.qty}/${p.orderQty}${p.partialExit ? `, ${p.remainingQty} left` : ""}; ledger had: ${prior.join(", ") || "nothing"}]`);
      corrections.push({ action: "add-trade", arm: p.arm, sym: p.sym, qty: p.qty, signalDate: signalOf.get(p.entryCid) || null, entryDate: p.entryDate, exitDate: p.exitDate, entryFill: p.entryFill, exitFill: p.exitFill, ret: p.ret, entryCid: p.entryCid, exitCid: p.exitCid, ...(p.partialExit ? { partialExit: true, remainingQty: p.remainingQty } : {}), supersedes: prior.length ? prior : null });
    } else {
      const q = have.reduce((a, r) => a + (Number(r.qty) || 0), 0);
      if (q !== p.qty) { diff.push(`AMEND trade ${p.exitCid}: ledger qty ${q} vs broker-attributable ${p.qty}`); corrections.push({ action: "amend-trade", arm: p.arm, sym: p.sym, entryCid: p.entryCid, exitCid: p.exitCid, ledgerQty: q, brokerQty: p.qty }); }
    }
  }
  const brokerExitCids = new Set(parts.map((p) => p.exitCid));
  for (const r of ledgerParts) if (r.exitCid && /^r151-/.test(r.exitCid) && !brokerExitCids.has(r.exitCid)) anomalies.push(`ledger trade ${r.exitCid} has no broker fill behind it`);

  // 4. ledger completeness (information only — the lot and trade corrections above carry the substance)
  const rowCids = new Set(rows.flatMap((r) => [r.cid, r.entryCid, r.exitCid]).filter(Boolean));
  for (const o of mine) if (TERMINAL.includes(o.status) && !rowCids.has(o.client_order_id) && !(Number(o.filled_qty) > 0 && [...stateBy.values()].some((l) => l.entryCid === o.client_order_id)))
    info.push(`no ledger row for ${o.client_order_id} (${o.side} ${o.status}, filled ${Number(o.filled_qty) || 0}/${o.qty})`);

  // 5. a queue not yet sent: a queued sell must match the rebuilt lot (the pre-fix runner sends the QUEUED qty); drop sells for lots
  //    that are gone. A queue whose pre-open already ran is history and left alone.
  const qBefore = (st.queue && st.queue.orders) || [], unsent = st.queue && st.queue.date && (st.lastRun || {}).preOpen !== st.queue.date;
  if (unsent) st.queue.orders = qBefore.flatMap((q) => {
    if (q.side !== "sell") return [q];
    const l = out.find((x) => x.arm === q.arm && x.sym === q.sym && x.status === "open");
    if (!l) { diff.push(`QUEUE drop ${q.cid || q.arm + "|" + q.sym} sell ${q.qty} — no open lot after the rebuild`); return []; }
    if (l.qty !== q.qty) { diff.push(`QUEUE ${q.cid || q.arm + "|" + q.sym} sell qty ${q.qty} -> ${l.qty}`); return [{ ...q, qty: l.qty }]; }
    return [q];
  });
  if (stamped) diff.push(`STAMP test "R151" on ${stamped} r151- lot(s) (no field meant R151 already; made explicit)`);
  st.auctionFix = { reconciledAt: nowIso, by: "docs/paper-auction-fix/2026-10-02/r151-reconcile-once.cjs", brokerOrders: mine.length, corrections: corrections.length, anomalies: anomalies.length };
  const stamp = nowIso;
  const ledgerRows = corrections.map((c) => ({ ts: stamp, kind: "reconcile-correction", test: "R151", ...c, source: "Alpaca paper GET /v2/orders filled_qty / filled_avg_price (PAPER-AUCTION-FIX 2026-10-02)" }));
  return { state: st, ledgerRows, diff, anomalies, info, counts: { brokerOrders: mine.length, chains: chains.size, truthLots: truth.size, parts: parts.length } };
}

// ── I/O (only when run directly) ──────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  require(require.resolve("dotenv", { paths: [BK] })).config({ path: path.join(BK, ".env") });
  const { writeJsonAtomic } = require(path.join(BK, "lib", "atomic-write.js"));
  const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
  if (!process.env.ALPACA_KEY_ID) throw new Error("no Alpaca main-account keys in backend/.env");
  const get = async (p) => { const r = await fetch(BASE + p, { method: "GET", headers: H }); const j = await r.json().catch(() => null); if (!r.ok) throw new Error(`GET ${p.split("?")[0]} -> ${r.status}`); return j; };
  const et = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const today = `${et.year}-${et.month}-${et.day}`, mins = (+et.hour % 24) * 60 + +et.minute, weekday = !["Sat", "Sun"].includes(et.weekday);
  if (APPLY && weekday && ((mins >= 7 * 60 + 50 && mins <= 9 * 60 + 35) || (mins >= 15 * 60 + 25 && mins <= 17 * 60 + 45))) throw new Error(`refusing --apply at ${et.hour}:${et.minute} ET — inside the runner's pre-open / close-arm / after-close windows; run it outside 07:50-09:35 and 15:25-17:45 ET`);
  const state = JSON.parse(fs.readFileSync(STATE, "utf8")), asOf0 = state.asOf;
  if (APPLY && state.auctionFix && state.auctionFix.reconciledAt) throw new Error(`already applied at ${state.auctionFix.reconciledAt} — one-time script`);
  const rows = fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  let orders = [], after = "2026-09-23T00:00:00Z";
  for (let page = 0; page < 40; page++) {
    const j = await get(`/v2/orders?status=all&limit=500&direction=asc&nested=false&after=${encodeURIComponent(after)}`); if (!Array.isArray(j)) throw new Error("orders list is not an array");
    orders.push(...j); if (j.length < 500) break; after = new Date(Date.parse(j[j.length - 1].submitted_at) - 1).toISOString();
  }
  const ids = new Set(); orders = orders.filter((o) => !ids.has(o.id) && ids.add(o.id));
  const r311 = orders.filter((o) => /^r311-/.test(o.client_order_id || ""));
  if (r311.length) { const m = `${r311.length} r311- order(s) already exist — this pre-R311 tool must not rebuild lots the patched runner has traded`; if (APPLY) throw new Error(m); console.log("WARNING " + m); }
  const cal = await get(`/v2/calendar?start=2026-09-01&end=${today}`), days = cal.map((c) => c.date).sort();
  const prevSession = (d) => days.filter((x) => x < d).pop() || null, lastSession = lastClosedSession(cal, today, mins);   // PAPER-AUCTION-FIX review 2026-10-02: today only after its close
  const res = rebuild(state, rows, orders, prevSession, new Date().toISOString(), lastSession);
  console.log(`r151 reconcile-once ${APPLY ? "APPLY" : "DRY"} — ${orders.length} order(s) on the main paper account since 2026-09-23, ${res.counts.brokerOrders} r151- in ${res.counts.chains} arm x symbol chain(s); broker shows ${res.counts.truthLots} live lot(s) and ${res.counts.parts} filled exit part(s); state asOf ${asOf0}; last session ${lastSession}`);
  console.log(`\nDIFF (${res.diff.length})`); for (const d of res.diff) console.log("  " + d);
  console.log(`\nLEDGER ROWS TO APPEND (${res.ledgerRows.length}, kind reconcile-correction, test R151)`); for (const r of res.ledgerRows) console.log("  " + JSON.stringify({ ...r, ts: undefined, source: undefined }));
  console.log(`\nANOMALIES (${res.anomalies.length})`); for (const a of res.anomalies) console.log("  " + a);
  console.log(`\nINFO (${res.info.length})`); for (const a of res.info) console.log("  " + a);
  const lots = res.state.lots;
  console.log(`\nREBUILT STATE: ${lots.length} lot(s) — open ${lots.filter((l) => l.status === "open").length} (owed ${lots.filter((l) => l.exitOwed).length}), pending ${lots.filter((l) => l.status === "pending").length}, exiting ${lots.filter((l) => l.status === "exiting").length}; queue ${res.state.queue ? res.state.queue.orders.length : 0} for ${res.state.queue ? res.state.queue.date : "-"}`);
  if (!APPLY) return console.log("\nDRY — nothing written. Apply once, outside the runner windows, BEFORE the patched runner's first order-sending run: --apply");
  const now = JSON.parse(fs.readFileSync(STATE, "utf8")); if (now.asOf !== asOf0) throw new Error(`state changed while this ran (asOf ${asOf0} -> ${now.asOf}) — re-run`);
  if (res.ledgerRows.length) fs.appendFileSync(LEDGER, res.ledgerRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  res.state.asOf = new Date().toISOString(); writeJsonAtomic(STATE, res.state);
  console.log(`\nAPPLIED — appended ${res.ledgerRows.length} correction row(s) to ${path.relative(ROOT, LEDGER)}; wrote ${path.relative(ROOT, STATE)}`);
}
if (require.main === module) main().catch((e) => { console.error("r151 reconcile-once FAILED:", e.message); process.exit(1); });
else module.exports = { rebuild, lastClosedSession, CID_RE, TERMINAL };
