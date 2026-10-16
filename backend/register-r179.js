#!/usr/bin/env node
/** Registers R179 — does retail chatter predict the move, or mark the top? 2026-09-24, operator: "yes". Filed before any outcome exists:
 *  the first chatter snapshot (data/social-mentions/2026-09-24.json) was taken at 13:41 MT today; its earliest entry is the 09-25 open. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R179")) { console.error("R179 already exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 16, n: 40, trials: 20000 }).p95.toFixed(3);   // 8 leg x horizon cells, both signs (buy or fade) = 16
reg.preregistered.push({
  id: "R179", name: "Retail chatter vs subsequent movement — Reddit mention spikes, Stocktwits new-trending, crypto mention spikes (buy or fade)",
  registered: "2026-09-24", evidenceStart: "2026-09-24 snapshot (entries from the 2026-09-25 open)",
  status: "REGISTERED 2026-09-24 — accruing nightly", script: "backend/r179-chatter-grade.js (nightly; --read once)",
  parent: "Operator 2026-09-24: 'is our scout testing chatter against movement' -> 'yes'. Data: backend/social-mentions-record.js (ApeWisdom + Stocktwits, daily from 2026-09-24).",
  multiplicityFamily: "CHATTER-16 — legs {S1 Reddit stock spike, S2 Stocktwits new-trending, S3 Reddit crypto spike} x horizons {S1,S2: 1/5/20 trading days; S3: 1/5 days} = 8 cells, each read two-sided (momentum or fade) = 16. Primary: S1 at 5 days.",
  rule: [
    "Snapshot for day D = data/social-mentions/<D>.json (ET date). A name enters on D only if it is a US-listed stock or ETF with an Alpaca SIP daily bar on D and a raw close >= $2 (crypto: a Coinbase <COIN>-USD product).",
    "S1 (Reddit stock spike): ApeWisdom all-stocks row with mentions >= 20, rank <= 100 and mentions >= 3 x max(mentions_24h_ago, 3).",
    "S2 (Stocktwits new-trending): in D's trending list and absent from the previous recorded day's list (first eligible D = 2026-09-25).",
    "S3 (Reddit crypto spike): ApeWisdom all-crypto row with mentions >= 10 and mentions >= 3 x max(mentions_24h_ago, 3); ticker XXX.X -> Coinbase XXX-USD.",
    "Entry: stocks at the next session's open (D+1 open, raw SIP); exit at the close h trading days later. Crypto: 00:00 UTC open of the UTC day after the snapshot; exit h days later at 00:00 UTC.",
    "Control (stocks): for each signal name, 5 names drawn at random (seed = hash of D and the name) from D's ApeWisdom all-stocks rows that did NOT spike and pass the same listing and price screen — already retail-followed names, so the test isolates the SPIKE, not being talked about at all. Crypto control: BTC.",
  ],
  statistic: "Per signal day and cell: mean over that day's signal names of (signal return - mean control return). Newey-West t over signal days with lag h-1 (overlapping holds). Two-sided: a positive t says chatter predicts continuation, a negative t says it marks the top.",
  bar: { fixedInAdvance: true, unit: "signal days per cell", minSignalDays: 40, tRequired: BAR, twoSided: true, variants: 16, source: `nullBar({variants:16, n:40, trials:20000}).p95 = ${BAR} applied to |t|` },
  interimKill: "none (a measurement; nothing trades)",
  decisionRule: { pass: "A cell whose |t| >= bar with >= 40 signal days: register a forward paper test of that direction (buy or fade) through the Alpaca mirror, operator's word.", fail: "DID NOT PASS: retail chatter spikes carry no measurable next-day to next-month information beyond being talked about; the recorder continues as data." },
  readCondition: "node backend/r179-chatter-grade.js --read once the primary cell (S1, 5 days) has >= 40 signal days (~late November 2026); every cell is read at that moment, read-once.",
  expectation: "I expect the 20-day cells to lean negative (the literature on retail attention: brief pop, later underperformance) but not clear a 16-way two-sided bar in ~40 days.",
  knownWeaknesses: ["No history: ApeWisdom/Stocktwits give only current counts, so the sample starts now and is small.", "ApeWisdom's 24h-ago counts are its own; a spike threshold on them is only as good as their parser.", "Snapshot time varies (the close chain runs ~16:15 ET; the first snapshot was intraday).", "Stocktwits 'trending' is a black-box score.", "Controls are not size-matched."],
  ip: "none", writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R179 retail chatter vs movement — registered", category: "registration", breaksComparability: false, change: `Nightly grader joins social-mention snapshots to next-day..20-day returns vs non-spiking retail-followed controls; 16-way two-sided bar ${BAR}.`, why: "Operator: 'yes' to testing chatter against movement.", doesNotEstablish: "Anything before 40 signal days.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R179"], detail: `chatter vs movement, bar ${BAR} two-sided` }) + "\n");
console.log(`R179 registered · |t| bar ${BAR}`);
