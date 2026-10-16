#!/usr/bin/env node
/**
 * R352 — two dated PRE-EVIDENCE notes (2026-10-12), each one the entry itself calls for. Only R352.amendments and the registry's asOf
 * change; every registered term stays as it is (docs/server/wave7-pm/record-evidence-start.cjs hashes the terms the same way).
 *
 *  (1) THE KALSHI FEE (rule[9]: "Until a dated amendment records the fee from that schedule (the operator opens it in his own browser),
 *      both K15 cells are CANNOT MEASURE ... The amendment may record the fee (its formula, who pays it, its rounding) and nothing
 *      else"). The operator opened https://kalshi.com/docs/kalshi-fee-schedule.pdf in his own browser on 2026-10-12 and handed the file
 *      over (sha256 below). The site's bot check was not gone around by anyone. Read with pdftotext: the general schedule, "Last updated
 *      and effective: July 7, 2026", and its table of non-standard series (86 series codes), in which KXBTC15M does not appear.
 *  (2) THE SPOT-GAP READING (rule[11], and the same words in rule[7]: "the spot record has no gap longer than 10 s"). The recorder build
 *      of 2026-10-12 found the text does not say whether a gap is the FEED delivering nothing or no TRADE for that long; the evidence
 *      start refuses until exactly one dated note fixes it. Fixed here as "feed-silent", the reading the recorder's library gates on.
 *
 *   node backend/amend-r352-fee-and-spot-gap.js --dry     prints both notes, writes nothing, takes no lock
 *   node backend/amend-r352-fee-and-spot-gap.js           writes them (refused 13:50-15:50 MT on a trading day)
 * Exit 0 written and verified (or --dry) · 2 refused, nothing written · 3 the registry is written but a record beside it is owed · 1 other.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), DRY = process.argv.includes("--dry"), ID = "R352", DAY = "2026-10-12";
const refuse = (m) => { console.error(`REFUSED: ${m}`); process.exit(2); };
const extra = process.argv.slice(2).filter((a) => a !== "--dry"); if (extra.length) refuse(`unknown argument ${extra[0]}`);
const P = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
const today = `${P.year}-${P.month}-${P.day}`, hm = `${P.hour === "24" ? "00" : P.hour}:${P.minute}`, weekend = P.weekday === "Sat" || P.weekday === "Sun";
if (today !== DAY) refuse(`these notes are dated ${DAY} and today is ${today} MT`);
if (!DRY && !weekend && hm >= "13:50" && hm < "15:50") refuse(`${hm} MT is inside the close chain's registry window`);

// pre-evidence: no recorded day, no scorer, no r352 data, no evidence-start note
const preEvidenceProblems = (e) => {
  const out = [];
  if (fs.existsSync(D("pm-book"))) out.push("backend/data/pm-book exists (recorded data)");
  if (fs.existsSync(path.join(__dirname, "r352-pm-short-window.js"))) out.push("the scorer backend/r352-pm-short-window.js exists");
  const stray = fs.readdirSync(path.join(__dirname, "data")).filter((f) => /^r352/i.test(f)); if (stray.length) out.push(`r352 data file(s): ${stray.join(", ")}`);
  if ((e.amendments || []).some((a) => a && a.evidenceStart !== undefined)) out.push("the entry already records an evidence start");
  return out;
};
const FEE_SHA = "c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601";
const NOTES = [
  {
    id: "R352-kalshi-fee-2026-10-12", date: DAY, key: "kalshi-fee-from-schedule-2026-10-12", preEvidence: true, ruleChange: false,
    kind: "the fee rule[9] left open — Kalshi's fee for the two K15 cells, from the venue's own schedule (formula, who pays it, its rounding; nothing else)",
    was: "NOT ON RECORD (rule[9]): both K15 cells CANNOT MEASURE and nothing scored on Kalshi",
    feeK15: {
      taker: "fee = round up(M x 0.07 x C x P x (1 - P)) dollars, with M = 1 (the schedule's default multiplier), C = the number of contracts in the fill, P = the fill price of a contract in dollars",
      maker: "nothing. The schedule's maker formula is round up(M x 0.0175 x C x P x (1 - P)) with M = 0 'unless otherwise indicated', and KXBTC15M is not indicated",
      whoPays: "the order that is immediately matched with an order resting on the book (the taker), on each fill. An order left resting on the book pays nothing on this series, also when it later trades",
      rounding: "the schedule's own words: 'round up = rounds up such that the fee + positionCost is rounded to a centicent'. Read per fill as: the fee is the smallest amount not below the formula's value for which (C x P + fee) is a whole multiple of $0.0001",
      settlementFee: "none ('There is no settlement fee.')",
    },
    source: {
      document: "Kalshi fee schedule, kalshi-fee-schedule.pdf — 'Last updated and effective: July 7, 2026'",
      url: "https://kalshi.com/docs/kalshi-fee-schedule.pdf",
      obtained: "the operator opened it in his own browser on 2026-10-12 and handed the file over (the route rule[9] registers). The bot check the site showed a plain request on 2026-10-11 was not repeated or gone around",
      sha256: FEE_SHA,
      read: "text extracted with pdftotext (layout and raw). The general formula and the maker formula are quoted above. The table 'Non-Standard Fees' lists 86 series codes with a maker and a taker multiplier each; KXBTC15M is not among them (its bitcoin rows are KXBTCMAX150 at 1 / 1 and KXBTCY at 0 / 0), so the general schedule applies to KXBTC15M",
      agreesWith: "the venue's API as recorded at registration (venueFacts.K15.fee.seen): fee_type quadratic, fee_multiplier 1, no scheduled fee change; and the 0.07 x P x (1 - P) pointer that was 'not used' there",
    },
    consequence: "As rule[9] registers it, and no further: the two K15 cells (A|K15, B|K15) become gradable; K15 days count only from the first full UTC day after this note's date, so from 2026-10-13 (UTC) at the earliest and never before the recorder's evidence start. Arm A's resting bids pay no fee on K15; arm B's orders and arm A's exit variant pay the taker fee on every fill",
    scorerNote: "The scorer (not built) takes its known answers for the rounding from the venue's own fee-rounding page. If that page contradicts the reading of the rounding sentence above, a dated note before the first K15 day corrects the reading; the formula and who pays stand.",
    unchanged: ["every other K15 number (tick, stake, delays, coverage, the 96 windows and the 77-window day)", "every PM5 term", "the bar 2.683, the unit (UTC days), the 30-day span, the interim look, the decision rule", "rule[] itself: this note is read beside it, the frozen text is not edited"],
    disclosed: "Written before any R352 evidence exists: the recorder is not on the server, the scorer is not built, no fill, P&L, fair value or outcome of any kind has been computed by anyone. Seen so far: the scout's and the recorder build's keyless probes (counts, field names, sizes and rates only).",
    runnerGates: ["feeK15:taker 0.07 x C x P x (1 - P), M 1; maker nothing; round up so fee + position cost is a whole centicent"],
    recordedBy: "assistant (main loop), from the file the operator handed over on 2026-10-12",
  },
  {
    id: "R352-spot-gap-2026-10-12", date: DAY, preEvidence: true, ruleChange: false,
    kind: "reading — what a gap in the spot record is (rule[11], rule[7])",
    spotGapReading: "feed-silent",
    text: "In rule[11] and in the same words of rule[7], 'the spot record has no gap longer than 10 s' means: the spot FEED delivered nothing — no trade, no ticker and no heartbeat row — for more than 10 seconds. A stretch with no TRADE while the feed is alive is not a gap: the last trade's price stands for it, exactly as the registered fair-odds input treats it (a ten-second return of zero). The other reading ('no-trade') is computed and stated for every day by the recorder (capturedIfTradeQuietCounted, qualifiesIfTradeQuietCounted) and is reported at the read beside the registered one; it is never graded.",
    why: "The coverage rule exists to drop windows the recorder did not see, not windows in which the market was quiet. Counting a quiet stretch as a gap would drop calm windows — a selection on the market's own state — and at night and at weekends would drop whole days. The registration assumed about 15 Coinbase trades a second, where the two readings are the same thing; the recorder build's two quiet-hour probes measured about 2.4 trades a second, no-trade stretches of 7.1 s and 5.2 s inside one minute, and a feed that was never silent for more than 1.1 s (it carries a heartbeat every second).",
    disclosed: "Outcome-blind: fixed from the purpose of the control and from counts and rates of two keyless probes. No fill, P&L, fair value or outcome has been computed. It is the reading the recorder's library already gates on (backend/lib/pm-feeds.js SPOT_GAP_READING), so no gate changes.",
    recordedBy: "assistant (main loop) as registrar, on the operator's standing instruction of 2026-09-26 to decide research-process choices and report them",
  },
];
const problemsWith = (e) => {
  const out = preEvidenceProblems(e), have = e.amendments || [];
  if (!Array.isArray(have)) out.push("the entry's amendments is not a list");
  for (const n of NOTES) if (have.some((a) => a && (a.id === n.id || (n.key && a.key === n.key)))) out.push(`${n.id} is already in the entry`);
  if (have.some((a) => a && a.spotGapReading !== undefined)) out.push("the entry already holds a note that fixes the spot-gap reading");
  if (have.some((a) => a && a.feeK15 !== undefined)) out.push("the entry already holds a note that records the Kalshi fee");
  if (!/K15: NOT ON RECORD/.test(String((e.rule || [])[9]))) out.push("rule[9] no longer reads 'K15: NOT ON RECORD' — the entry is not the one this note was written for");
  if (!/the spot record has no gap longer than 10 s/.test(String((e.rule || [])[11]))) out.push("rule[11] no longer carries the sentence this note reads");
  return out;
};
const load = () => { const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); const e = (reg.preregistered || []).find((x) => x && x.id === ID); if (!e) refuse(`no ${ID} in the registry`); return { reg, e }; };
const termsOf = (e) => JSON.stringify({ ...e, amendments: null });
const othersOf = (reg, e) => JSON.stringify({ ...reg, asOf: null, preregistered: reg.preregistered.map((x) => (x === e ? null : x)) });
{
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests || {})[ID]) refuse(`${ID} is sealed`);
  const { e } = load(), p = problemsWith(e); if (p.length) refuse(p.join("; "));
  try { const lib = require("./lib/pm-feeds.js"); if (lib.SPOT_GAP_READING !== NOTES[1].spotGapReading) refuse(`the recorder's library gates on "${lib.SPOT_GAP_READING}", not "${NOTES[1].spotGapReading}"`); } catch (err) { refuse(`backend/lib/pm-feeds.js could not be read (${String(err.message).slice(0, 80)})`); }
}
const changeRow = { id: "r352-amend-kalshi-fee-and-spot-gap-2026-10-12", date: DAY, recordedAt: Date.now(), area: "registry — R352 prediction-market short-window test (two pre-evidence notes: Kalshi's fee from its own schedule; the reading of a spot-record gap)", category: "registration", breaksComparability: false,
  change: `(1) ${NOTES[0].feeK15.taker}; maker: ${NOTES[0].feeK15.maker}; rounding: ${NOTES[0].feeK15.rounding}. Source: ${NOTES[0].source.document}, sha256 ${FEE_SHA}. (2) ${NOTES[1].text}`,
  why: `(1) rule[9] left the Kalshi fee open until the operator read the schedule in his own browser; he did on ${DAY}. (2) ${NOTES[1].why}` };
if (DRY) { console.log(JSON.stringify(NOTES, null, 1)); console.log("\nchange-registry row (rehearsed):\n" + JSON.stringify(changeRow, null, 1)); console.log(`\n--dry: nothing written, no lock taken. ${ID}.amendments would gain 2 notes: ${NOTES.map((n) => n.id).join(", ")}`); process.exit(0); }

const LOCK = D("registry-write.lock"), sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let held = false;
for (let i = 0; i < 60 && !held; i++) { try { fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, by: "amend-r352-fee-and-spot-gap.js", at: new Date().toISOString() }), { flag: "wx" }); held = true; } catch (err) { if (err.code !== "EEXIST") throw err; sleep(2000); } }
if (!held) refuse("backend/data/registry-write.lock is held by another writer for two minutes — theirs is left in place; run again later");
let code = 1;
try {
  const { reg, e } = load(), p = problemsWith(e); if (p.length) refuse(`(inside the lock) ${p.join("; ")}`);
  const terms0 = termsOf(e), others0 = othersOf(reg, e), n0 = (e.amendments || []).length;
  e.amendments = [...(e.amendments || []), ...NOTES]; reg.asOf = new Date().toISOString();
  if (termsOf(e) !== terms0 || othersOf(reg, e) !== others0) throw new Error("internal: something other than R352.amendments and asOf would change — nothing written");
  writeJsonAtomic(D("test-registry.json"), reg);
  const back = load();
  if (termsOf(back.e) !== terms0 || othersOf(back.reg, back.e) !== others0 || (back.e.amendments || []).length !== n0 + 2 || back.e.amendments[n0].id !== NOTES[0].id || back.e.amendments[n0 + 1].spotGapReading !== "feed-silent") throw new Error("the registry does not read back as written");
  code = 3;
  const c = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8")); if (!c.some((x) => x && x.id === changeRow.id)) { c.push(changeRow); writeJsonAtomic(D("change-registry.json"), c); }
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-pre-evidence", tests: [ID], notes: NOTES.map((n) => n.id), spotGapReading: "feed-silent", feeSource: FEE_SHA.slice(0, 16), runnerGates: NOTES[0].runnerGates }) + "\n");
  code = 0;
  console.log(`${ID} amended (pre-evidence): amendments ${n0} -> ${n0 + 2} (${NOTES.map((n) => n.id).join(", ")}); every registered term unchanged; change-registry + agent-ledger recorded.`);
} catch (err) {
  console.error(code === 3 ? `PARTIAL: the registry holds the two notes but a record beside it is owed (${String(err.message).slice(0, 200)}) — add the change-registry row ${changeRow.id} and the ledger line by hand` : `FAILED: ${String(err.message).slice(0, 300)}`);
} finally { try { fs.unlinkSync(LOCK); } catch { /* the lock was ours; nothing else to do */ } }
process.exit(code);
