#!/usr/bin/env node
/** Registers R139 — ares forward (Collective2 #131145247). 2026-09-21, operator: "register the ares forward test". Refuses if R139 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R139")) { console.error("R139 already exists — refusing"); process.exit(2); }
const entry = {
  id: "R139",
  name: "ares forward — does following a broker-evidenced outside futures strategy make money after our cost?",
  registered: "2026-09-21",
  evidenceStart: "2026-09-22",
  status: "REGISTERED 2026-09-21 — evidence from trades OPENED on/after 2026-09-22; operator-fed writer (CSV download ~weekly); read at 78 trading weeks",
  script: "backend/c2-ares-forward.js",
  parent: "Operator 2026-09-21 after losing trust in TRAIDS's own data: 'is there any website out there that follows a bunch of winning day traders' -> shortlist of Collective2 / Kinfo -> fill check of ares (backend/c2-ares-fill-check.js).",
  origin: "Collective2 strategy 'ares' by ares_Systemtrading, #131145247, MNQ futures, record since 2020-09-15 (761 closed trades at registration).",
  multiplicityFamily: "EXT-C2 — outside Collective2 strategies followed forward. Four were shortlisted on 2026-09-21 (ares, SmartFutures, Easy Value, Sage Volatility Margin) from 13 screened on drawdown and live followers; ares is the only one run. The bar is charged best-of-4 so the family can grow to four without re-pricing.",
  motivatingEvidence: "WEIGHTLESS, disclosed: (1) ares' PAST record: +33%/yr compounded per Collective2, max drawdown -14%, every calendar year 2020-2026 positive in dollars; weekly mean +21.27 net pts/contract/trade after 0.75 pt, weekly sd 85.16, t 4.12 over 272 trading weeks (2020-09..2026-09). (2) Fill check 2026-09-21 on the 115 trades inside our NQ 1-minute coverage (2025-08-19..2026-09-21): 110/115 entries and 111/115 exits inside the real NQ minute range, misses <8 pts and mostly AGAINST ares; recorded worst prices unbiased (18 milder / 20 harsher). (3) For 1,068 of 1,522 legs the strategy price equals the volume-weighted average of real follower fills at IBKR/Tradovate. None of this is evidence for the forward question.",
  rule: "Every ares trade OPENED on or after 2026-09-22, exactly as it appears in the Collective2 trading-record CSV (Trade ID, Side, Avg Price Open, Avg Price Closed). Per trade: netPts = (Avg Price Closed - Avg Price Open) x (+1 LONG, -1 SHORT) - 0.75 pt. Size is ignored: one MNQ contract per trade. Nothing is selected, filtered or re-timed.",
  statistic: "Mean over TRADING WEEKS (Monday-start, ET; a week with no ares trade opened contributes nothing) of the week's mean netPts; t across trading weeks. Clustering unit: trading week.",
  bar: { fixedInAdvance: true, unit: "trading weeks", minTradingWeeks: 78, tRequired: 2.287, variants: 4, source: "lib/null-bar.js nullBar({variants:4, n:78, trials:20000}).p95 = 2.287", powerNote: "From the past record: if the forward edge equals history (+21.27 pts/week, sd 85.16) the expected t is 1.27 at 26 weeks, 1.80 at 52, 2.21 at 78, 2.55 at 104. The test is slow by construction; 78 weeks is ~18 months of trading weeks." },
  interimKill: "Kill-only, from 26 trading weeks: if the forward weekly mean is <= 0 AND it sits below the historical +21.27 at t <= -2.0, the read may be taken early as DID NOT PASS. There is no early PASS.",
  decisionRule: {
    pass: "t >= 2.287 over >= 78 trading weeks with a positive mean, and no restatement of the pre-evidence record: ares' signals made money after our cost. This adopts NOTHING. It routes to the operator as a candidate to paper-mirror at a futures-capable broker (Interactive Brokers paper or equivalent) with our own fills, which is a separate registered test; subscription, funding, size and venue are the operator's decisions.",
    fail: "Otherwise DID NOT PASS: the past record did not carry forward at the bar, ares is dropped, and no other EXT-C2 member is substituted on this evidence.",
    restated: "If any pre-evidence trade in the 2026-09-21 baseline is changed or deleted in a later CSV, the verdict is NOT ESTABLISHED regardless of t: a record that moves cannot be graded.",
  },
  readCondition: ">= 78 trading weeks of forward trades (or the interim kill condition). node backend/c2-ares-forward.js --read. Refuses before the sample condition.",
  knownWeaknesses: [
    "SELECTION: ares was chosen off a leaderboard for having the best past drawdown and most live followers. Leaderboard winners regress; that is exactly what this forward test measures, but the prior should be low.",
    "WE CANNOT TRADE ALONG: without a subscription we see a trade only after it closes, in the CSV. This grades ares' own record forward, NOT our ability to follow it (lag, our fills). A PASS earns a separate execution test; it does not answer it.",
    "THE RECORD IS THE VENDOR'S: fills in the CSV are Collective2's (often the average of real follower fills). The 2026-09-21 fill check covered only 115 past trades inside our bar coverage; forward trades can be re-checked against our NQ bars at the read, and the read should do so.",
    "OPERATOR-FED WRITER: Collective2 is behind a Cloudflare bot check that this project will not bypass, so every new trade enters only when the operator downloads the CSV. A missed download delays, not loses, evidence (the CSV is the full history), and the nightly preview goes STALE loudly after 8 days.",
    "COST: 0.75 pt per round trip is the house MNQ figure (the wire's). Real commission + slippage for a follower could be higher; the statistic is net of our cost only.",
    "SIZE IGNORED: ares varies contracts (1.55 to 11 in the record). One contract per trade tests the signals, not the sizing; ares' dollar record includes its sizing.",
    "SLOW: even an edge equal to history needs ~78 trading weeks to clear. A null result at 78 weeks does not prove no edge; it says the forward record did not show one at the bar.",
  ],
  ip: "ares is a third party's commercial strategy. Outcomes only; its trade list stays local (backend/data) and is never republished or sent to other tools.",
  writerExists: true,
};
reg.preregistered.push(entry); reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-21", area: "R139 ares forward — registered", category: "registration", breaksComparability: false, change: "R139 registered: Collective2 strategy ares followed forward from trades opened 2026-09-22; operator-fed CSV writer c2-ares-forward.js (ingest + nightly preview), wired into the close chain.", why: "Operator no longer trusts TRAIDS's own record; ares is the first outside record to survive a fill check against real NQ prices.", doesNotEstablish: "That ares has an edge, or that it can be followed profitably by us.", operator: "Josh: 'register the ares forward test' 2026-09-21" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R139"], detail: "ares forward, bar t>=2.287 at 78 trading weeks, best-of-4" }) + "\n");
console.log("R139 registered");
