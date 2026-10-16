#!/usr/bin/env node
/**
 * OPTIONS EXPIRY SETTLE — server-side. Written 2026-08-19, the day the gap was found.
 *
 * WHY. R21's first wings expired Monday 08-17 and by Wednesday ZERO had settled: the app marks
 * open wings from live OCC quotes, and an expired contract has no quotes, so optMark returns
 * null and the fail-closed rule (correct for marking!) left every expired wing frozen on the
 * board forever. The premium-harvest test reads at n>=200 SETTLED wings — with no settlement
 * path it would have read at n=0 in perpetuity. This is also the top item from the hardening
 * list: settlement is evidence, and evidence cannot depend on a browser tab being open.
 *
 * WHAT IT DOES. For every board Option past expiry (credit verticals only — the only structure
 * R21 writes), fetch the underlying's completed daily close on the expiry date and settle at
 * intrinsic:
 *     short put spread  (sell K1, buy K2 < K1): cost = clamp(K1 - S, 0, K1 - K2)
 *     short call spread (sell K1, buy K2 > K1): cost = clamp(S - K1, 0, K2 - K1)
 *     pnl = (creditKept - cost) * 100 * contracts - commissions
 * Commissions: 2 legs in at $0.65 (Schwab); expiry itself is commission-free (worthless legs
 * just die, ITM legs cash out via exercise/assignment at no per-leg fee). The app's live mark
 * charges 4 legs because closing early crosses the spread twice — expiry does not.
 *
 * Settled wings land in trade_log.json (reason "expiry") and the wing is removed from
 * board_positions.json with a tombstone, exactly like any other close. Idempotent by trade id.
 *
 * FAIL-CLOSED RULES (the D37/D48 family):
 *   - a wing settles only when its expiry date's daily bar EXISTS and is complete
 *     (expiry < today ET, or == today and past 16:10 ET)
 *   - a non-credit expired option is REPORTED, never guessed at
 *   - if expired wings exist and none could be settled, exit 2 so the chain surfaces it
 *
 * 2026-10-01 audit (settle#1/ledger#1, settle#5/ledger#2, nightly audit 2026-09-30; operator "fix the bugs"):
 *   - EXPIRY FROM THE OCC SYMBOL. The App's generic Options track (directional DEBIT verticals) never stamps optExpiry; the
 *     expiry lives only in occAtm/occK2. The old filter kept `p.optExpiry` rows only, so 5 expired debit verticals (QQQ 09-04,
 *     DIA/IWM 09-11, META/GOOGL 09-18; ctrl:false) sat on the board 2-4 weeks with no ledger row, and the "NOT SETTLING" report
 *     below never saw them either (it ran after the filter). Expiry is now optExpiry, else the OCC expiry when both legs agree.
 *   - DEBIT VERTICALS SETTLE at intrinsic by the same rule, opposite sign (long K1 = optAtm, short K2 = optK2):
 *         long call spread: value = clamp(S - K1, 0, K2 - K1);   long put spread: value = clamp(K1 - S, 0, K1 - K2)
 *         pnl = (value - entryNet) * 100 * contracts - commissions     (entryNet = optEntryNet ?? debit, as optMark uses)
 *     Only when the OCC legs agree with optAtm/optK2/optCall (the optStruct TEXT disagrees on all 5 and is ignored).
 *   - IDEMPOTENCY ON LIVE ROWS. "Already settled" counted retired ledger rows too, so the 6 R21 wings voided under
 *     wing-cap-quote-defect-2026-09-14 and restored to the board "to hold to expiry" could never settle and the step printed a
 *     false "Idempotent no-op". A board wing whose only ledger row is retired AND whose obs.restoredAfter names that row's tag
 *     settles under the successor id <id>-exp (voidedPredecessor links back); the id-keyed journal/autopsy stay one row per id.
 *   - LOUD, NOT SILENT. An Options row with no derivable expiry, an expired structure with no registered settle rule, or a
 *     retired-without-restore id is listed and the run exits 2 after settling everything else — never a quiet exit 0.
 *   - --dry prints what would settle and writes nothing.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const { fetchBars } = require("./lib/alpaca-bars");

const BOARD = D("board_positions.json");
const TOMBS = D("board_tombstones.json");
const TLOG = D("trade_log.json");
const COMMISSION_PER_LEG = 0.65, LEGS_AT_ENTRY = 2;

const etToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const etHM = () => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
const DRY = process.argv.includes("--dry");

// 2026-10-01 audit (settle#1): OCC option symbol ROOT YYMMDD C|P STRIKE*1000 (8 digits); spaces in a padded root are dropped. null if it does not parse.
const occParse = (s) => { const m = /^([A-Z][A-Z0-9.]{0,5})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(s || "").replace(/\s+/g, "").toUpperCase()); return m ? { root: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, call: m[5] === "C", strike: +m[6] / 1000 } : null; };
/** expiry of a board option: the stamped optExpiry, else the OCC expiry when BOTH legs parse and agree. null = unknown (reported, exit 2). */
const expiryOf = (p) => { if (p.optExpiry) return { exp: p.optExpiry, src: "optExpiry" }; const a = occParse(p.occAtm), k = occParse(p.occK2); return a && k && a.expiry === k.expiry ? { exp: a.expiry, src: "occ" } : null; };
/** a long (debit) vertical whose OCC legs agree with optAtm/optK2/optCall: long call K2 > K1, long put K2 < K1. Returns why-not text, or null when settleable. */
const debitProblem = (p) => {
  if (p.optCredit) return "credit spread without optAtm/optK2";
  const a = occParse(p.occAtm), k = occParse(p.occK2);
  if (!a || !k) return "no parseable OCC legs";
  if (a.strike !== p.optAtm || k.strike !== p.optK2 || a.call !== !!p.optCall || k.call !== !!p.optCall) return `OCC legs ${p.occAtm}/${p.occK2} disagree with optAtm ${p.optAtm} / optK2 ${p.optK2} / optCall ${!!p.optCall}`;
  if (p.optCall ? !(p.optK2 > p.optAtm) : !(p.optK2 < p.optAtm)) return `not a long ${p.optCall ? "call" : "put"} vertical (K1 ${p.optAtm}, K2 ${p.optK2})`;
  if (!Number.isFinite(p.optEntryNet ?? p.debit) || !(p.riskDollars > 0)) return "no entry debit or riskDollars";
  return null;
};

(async () => {
  const board = JSON.parse(fs.readFileSync(BOARD, "utf8"));
  const today = etToday(), hm = etHM();
  const barComplete = (d) => d < today || (d === today && hm >= "16:10");

  // 2026-10-01 audit (settle#1): expiry from optExpiry OR the OCC legs; an Options row with neither is UNKNOWN and fails the step loudly below
  const opts = board.filter((p) => p.cls === "Options");
  const noExpiry = opts.filter((p) => !expiryOf(p));
  if (noExpiry.length) console.error(`  UNKNOWN EXPIRY on ${noExpiry.length} board option(s): ${noExpiry.map((p) => `${p.sym} ${p.id}`).join(", ")} — no optExpiry and no agreeing OCC legs; cannot tell whether they expired.`);
  const expOf = new Map(opts.map((p) => [p.id, expiryOf(p)]));
  const expired = opts.filter((p) => expOf.get(p.id) && barComplete(expOf.get(p.id).exp));
  if (!expired.length) { console.log("OPTIONS SETTLE — no wings past expiry. Nothing to do."); if (noExpiry.length) process.exit(2); return; }

  const credit = expired.filter((p) => p.optCredit && p.optAtm != null && p.optK2 != null);
  const debit = expired.filter((p) => !credit.includes(p) && !debitProblem(p));
  const other = expired.filter((p) => !credit.includes(p) && !debit.includes(p));
  if (other.length) console.error(`  NOT SETTLING ${other.length} expired option(s) with no registered settle rule: ${other.map((p) => `${p.sym} (${debitProblem(p)})`).join(", ")} — handle by hand.`);

  const tlog = (() => { try { const t = JSON.parse(fs.readFileSync(TLOG, "utf8")); return Array.isArray(t) ? t : []; } catch { return []; } })();
  // 2026-10-01 audit (settle#5/ledger#2): "already settled" means a LIVE (non-retired) row; a retired row only blocks unless the board row was restored after it
  const liveIds = new Set(tlog.filter((t) => t && !t.retired).map((t) => t.id));
  const retiredTag = new Map(tlog.filter((t) => t && t.retired).map((t) => [t.id, t.retired]));
  const restoreBlocked = [], todo = [];
  let alreadyN = 0;
  for (const p of [...credit, ...debit]) {
    if (liveIds.has(p.id)) { alreadyN++; continue; }
    if (retiredTag.has(p.id)) {
      const tag = retiredTag.get(p.id);
      if (p.obs?.restoredAfter !== tag) { restoreBlocked.push(`${p.sym} ${p.id} (ledger row retired '${tag}', board row carries no obs.restoredAfter for it)`); continue; }
      if (liveIds.has(`${p.id}-exp`)) { alreadyN++; continue; }
      todo.push({ p, sid: `${p.id}-exp`, voided: tag });
      continue;
    }
    todo.push({ p, sid: p.id, voided: null });
  }
  if (restoreBlocked.length) console.error(`  NOT SETTLING ${restoreBlocked.length} expired wing(s) blocked by a retired ledger row: ${restoreBlocked.join("; ")}`);
  const loud = noExpiry.length + other.length + restoreBlocked.length;   // anything here is a FAIL of this step, never a quiet exit 0
  if (!todo.length) {
    console.log(`OPTIONS SETTLE — ${alreadyN} expired option(s) already settled (live ledger rows)${loud ? `; ${loud} UNSETTLEABLE (listed above)` : ". Idempotent no-op."}`);
    if (loud) process.exit(2);
    return;
  }

  // one bar fetch covering every expiry involved
  const syms = [...new Set(todo.map(({ p }) => p.sym))];
  const earliest = todo.map(({ p }) => expOf.get(p.id).exp).sort()[0];
  const bars = await fetchBars(syms, { start: earliest, end: today, timeframe: "1Day", minBars: 1, quiet: true }).then((r) => r.bars || r).catch((e) => { console.error(`  bars fetch failed: ${e.message}`); return {}; });
  const closeOn = (s, d) => { const b = (bars[s] || []).find((x) => String(x.t).slice(0, 10) === d); return b ? b.c : null; };

  const settled = [], stuck = [], boardIdOf = new Map();   // ledger id -> board id (differs only for a restored wing's successor row)
  for (const { p, sid, voided } of todo) {
    const { exp, src: expSrc } = expOf.get(p.id);
    const S = closeOn(p.sym, exp);
    if (S == null) { stuck.push(`${p.sym} ${exp} (no completed bar)`); continue; }
    const contracts = p.contracts || 1;
    const width = Math.abs(p.optK2 - p.optAtm);
    const isDebit = !p.optCredit;
    // credit (short vertical, K1 = optAtm sold): cost to close at expiry; debit (long vertical, K1 = optAtm bought): value at expiry
    const cost = p.optCall
      ? Math.min(Math.max(S - p.optAtm, 0), width)   // short call spread breached from below | long call spread in the money
      : Math.min(Math.max(p.optAtm - S, 0), width);  // short put spread breached from above | long put spread in the money
    const creditKept = p.optEntryNet ?? p.debit;      // credit: the crossed credit kept; debit: the crossed debit paid (optMark's entryNet)
    const commissions = COMMISSION_PER_LEG * LEGS_AT_ENTRY * contracts;
    const pnl = (isDebit ? cost - creditKept : creditKept - cost) * 100 * contracts - commissions;
    const rMult = p.riskDollars ? pnl / p.riskDollars : null;
    settled.push({
      // 2026-09-07: a retire tag stamped on the OPEN position (holiday-entry-2026-09-07 and any later tag) must reach the ledger row, or lib/reconcile.js can never honour it
      ...(p.retired ? { retired: p.retired, retireNote: p.retireNote, voidForEvidence: p.voidForEvidence } : {}),
      id: sid, sym: p.sym, cls: "Options", dir: p.dir, sizeLabel: p.sizeLabel,
      ...(voided ? { voidedPredecessor: p.id, restoredAfter: voided } : {}),   // 2026-10-01 audit (settle#5): successor of a voided-then-restored wing
      // OP4a (2026-09-13): a put wing posted as a veto shadow must settle AS a shadow, or the control arm leaks into the signal book
      ctrl: !!p.ctrl, vetoShadow: !!p.vetoShadow, veto: p.veto ?? null, ctrlRand: !!p.ctrlRand, ...(p.vetoWhy ? { vetoWhy: p.vetoWhy, vetoAt: p.vetoAt } : {}),
      entry: creditKept, exit: +cost.toFixed(4), rMult, pnl: +pnl.toFixed(2),
      reason: "expiry", openedAt: p.addedAt, closedAt: Date.parse(exp + "T20:00:00Z"),
      // debit rows carry the signal features the App's recordOf writes for an Options close; credit rows unchanged (null)
      conf: p.conf ?? null, strategy: p.strategy ?? (isDebit ? null : "R21-premium"), rr: null, score: isDebit ? p.score ?? null : null,
      nBull: isDebit ? p.nBull ?? null : null, nBear: isDebit ? p.nBear ?? null : null, total: isDebit ? p.total ?? null : null,
      /**
       * THE RISK DENOMINATOR AND THE STRUCTURE, CARRIED THROUGH (fixed 2026-08-28).
       *
       * This row was built field-by-field and simply never copied them, so 42 of 42 settled
       * R25-0dte tickets reached the ledger with `strategy` and `entry` and nothing else —
       * no riskDollars, no optStruct, no contracts, no debit, no stopDist. Line 79 above
       * READS p.riskDollars to compute rMult and then dropped it, which is why the ledger has
       * an R-multiple for these tickets and no idea what one R is worth.
       *
       * The cost was concrete: R25-0dte is the only positive program on the board (+$302 over
       * 42 tickets, 86% win) and the operator could not be told whether it was safe to size up,
       * because the maximum loss per ticket had never reached the ledger. You cannot size what
       * you did not record. maxLoss = (width - credit) x 100 x contracts is computed at entry
       * in zero-dte-sleeve.js and is the number that belongs here.
       *
       * Third instance of this same defect class found today — after veto shadows and news
       * stamps — all of them state that exists at entry and is lost on the way to the ledger.
       */
      riskDollars: p.riskDollars ?? null,
      optStruct: p.optStruct ?? null,
      contracts: p.contracts ?? contracts ?? null,
      optEntryNet: p.optEntryNet ?? null,
      debit: p.debit ?? null,
      stopDist: p.stopDist ?? null,
      sleeve: p.sleeve ?? null,
      // 2026-10-01 audit (settle#1): optExpiry is the settled expiry (stamped or OCC-derived, expirySrc says which). A debit row names its legs the
      // other way round (bought K1 = optAtm, sold K2 = optK2) and carries debitMid/debitCross — the App's own entry fields since 08-28 (debitMid =
      // debit, debitCross = optEntryNet), filled from them when the position predates that — so lib/options-cost.js prices it, exit crossing 0 at expiry.
      obs: { ...(p.obs || {}), settleUnder: S, width, optCall: !!p.optCall, ...(isDebit ? { structure: "debit-vertical", longK: p.optAtm, shortK: p.optK2, debitMid: p.obs?.debitMid ?? p.debit ?? null, debitCross: p.obs?.debitCross ?? p.optEntryNet ?? null, ...(p.obs?.debitMid == null ? { debitObsFromEntryFields: true } : {}) } : { shortK: p.optAtm, longK: p.optK2 }), optExpiry: exp, expirySrc: expSrc, sleeve: p.sleeve ?? null },
    });
    boardIdOf.set(sid, p.id);
  }

  if (!settled.length) { console.error(`OPTIONS SETTLE — ${todo.length} option(s) expired, NONE settleable: ${stuck.join("; ")}`); process.exit(2); }

  const wins = settled.filter((s) => s.pnl > 0).length, total = settled.reduce((a, s) => a + s.pnl, 0);
  const sumR = settled.reduce((a, s) => a + (Number.isFinite(s.rMult) ? s.rMult : 0), 0);
  if (DRY) {
    console.log(`OPTIONS SETTLE [DRY — nothing written] — would settle ${settled.length} option(s) at expiry intrinsic${stuck.length ? `; ${stuck.length} stuck: ${stuck.join("; ")}` : ""}`);
  } else {
    // append to the ledger, drop from the board, tombstone the BOARD ids — same order a manual close uses
    writeJsonAtomic(TLOG, [...settled, ...tlog]);
    const boardIds = new Set(settled.map((s) => boardIdOf.get(s.id)));
    writeJsonAtomic(BOARD, board.filter((p) => !boardIds.has(p.id)));
    const tombs = (() => { try { const t = JSON.parse(fs.readFileSync(TOMBS, "utf8")); return Array.isArray(t) ? t : []; } catch { return []; } })();
    writeJsonAtomic(TOMBS, [...tombs, ...[...boardIds].map((id) => ({ id, ts: Date.now() }))]);
    console.log(`OPTIONS SETTLE — ${settled.length} option(s) settled at expiry intrinsic${stuck.length ? `; ${stuck.length} stuck: ${stuck.join("; ")}` : ""}`);
  }
  for (const s of settled) console.log(`    ${s.sym.padEnd(5)} ${s.obs.optExpiry}${s.obs.expirySrc === "occ" ? "(occ)" : ""} ${s.obs.structure === "debit-vertical" ? `LONG ${s.obs.optCall ? "C" : "P"} ${s.obs.longK}/${s.obs.shortK}  under ${s.obs.settleUnder}  debit ${s.entry}  value ${s.exit}` : `${s.obs.optCall ? "C" : "P"} ${s.obs.shortK}/${s.obs.longK}  under ${s.obs.settleUnder}  credit ${s.entry}  cost ${s.exit}`}  $${s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(2)}  ${Number.isFinite(s.rMult) ? (s.rMult >= 0 ? "+" : "") + s.rMult.toFixed(3) + "R" : ""}${s.ctrl ? " ctrl" : ""}${s.voidedPredecessor ? `  [successor of voided ${s.voidedPredecessor}]` : ""}  id ${s.id}`);
  console.log(`    ${wins}/${settled.length} finished positive · net $${total >= 0 ? "+" : ""}${total.toFixed(2)} · sum ${sumR >= 0 ? "+" : ""}${sumR.toFixed(3)}R · R21 settled count now feeds the n>=200 bar`);
  if (loud) { console.error(`OPTIONS SETTLE — ${loud} option(s) UNSETTLEABLE (listed above): exit 2 so the chain surfaces it`); process.exit(2); }
})();
