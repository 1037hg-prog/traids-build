#!/usr/bin/env node
/** Registers R158 — Payne's IPO-reversal price rule on a survivorship-reduced IPO universe. 2026-09-23, operator: "AI SuperTrend then
 *  1-3". Filed after the selftest and BEFORE any control or real trade. Refuses if R158 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R158")) { console.error("R158 already exists — refusing"); process.exit(2); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return m / Math.sqrt(v / n); }
const rng = mulberry(158), T = 50000, N = 117, V = 2, mx = [];
for (let t = 0; t < T; t++) { let b = -Infinity; for (let v = 0; v < V; v++) { const s = []; for (let i = 0; i < N; i++) s.push(rng() * 2 - 1); b = Math.max(b, nwT(s)); } mx.push(b); }
mx.sort((a, b) => a - b); const BAR = +mx[Math.floor(0.95 * T)].toFixed(3);
const uni = JSON.parse(fs.readFileSync(D("ipo-universe.json"), "utf8"));
reg.preregistered.push({
  id: "R158", name: "Payne 'IPO reversal' — the mechanical price rule (>=1 year public, >=50% down, 40-day base, breakout) on 2016-2025 IPOs incl. delisted",
  registered: "2026-09-23", evidenceStart: "2017-01-01",
  evidenceNote: `Historical. Universe data/ipo-universe.json (sha ${uni.sha}): ${uni.names.length} US common stocks listed 2016-01..2025-09 from Alpha Vantage LISTING_STATUS active + delisted (${uni.counts.delisted} since delisted); daily Alpaca SIP bars (which keep delisted symbols). Registered after the selftest, before any control or real trade. One read, sealed.`,
  status: "REGISTERED 2026-09-23 — controls, then one read", script: "backend/r158-ipo-reversal.js",
  parent: "Payne's Education webinar replay (screen recording 2026-09-23 162359): 'IPO reversals' checklist — public at least a year, fell by at least 50%, price stabilization, breaks out above its upper trend line; examples Samsara, Lemonade, AppLovin, Robinhood, Root. The fundamental items are judgement and are not tested.",
  multiplicityFamily: "PAYNE-IPO-REVERSAL-2 — HOLD-126 and HOLD-252. The base length (40), base range (1.35x), 50% threshold and 1-year age are fixed from Payne's words or chosen once before any computation; none is searched.",
  rule: "Eligible on day t: >= 252 bars since the first bar; the 40-bar base (t-40..t-1) has max/min close <= 1.35 and its max close <= 50% of the highest close since the first bar; breakout: close_t > the base max. Entry next open. Exit: close below the base min -> next open, else after HOLD bars at the close. One open position per name; open positions marked at the last close (delisted names at their last bar). A name is used only if its first Alpaca bar is within 10 days of its listed IPO date.",
  statistic: "Per member: daily strategy-return series (equal weight across open positions), summed per month 2017-01..2026-09 (117), 0.30% round trip; Newey-West lag 1.",
  bar: { fixedInAdvance: true, unit: "months", statistic: "Newey-West t, lag 1", variants: 2, tRequired: BAR, minTrades: 100, minMonths: 36,
    memberBar: "family bar + max(0, member's mean t on 10 arithmetic drift-free scrambles)",
    source: `simulated in register-r158.js: best of 2 NW(lag 1) t on zero-mean iid noise, n=117, 50,000 trials, seed 158, p95 = ${BAR}` },
  controls: { leakTest: "10 arithmetic drift-free scrambles per symbol: every member's mean noise t < 2", floor: "drift-kept scrambles (seeds 1, 2) — the 'any beaten-down IPO bought at random' baseline", positiveControl: "winners-only t >= member bar" },
  interimKill: "none — one read over a fixed sample",
  decisionRule: { pass: "A member with >= 100 trades over >= 36 months, monthly mean > 0 and above its floor, t >= member bar, both halves positive. Adopts nothing: post-read audit (concentration, size, delisting treatment), then only if it survives a forward paper test.", fail: "DID NOT PASS: the mechanical IPO-reversal rule is closed on these data; Payne's discretionary version (fundamentals, 'hits Charles' radar') remains untestable." },
  readCondition: "Immediately after the controls print READY: node backend/r158-ipo-reversal.js --read, then node backend/seal-r158.js.",
  expectation: "I expect DID NOT PASS: beaten-down IPOs have poor average forward returns in the literature (the long-run IPO underperformance), and a base-breakout filter is a thin edge; the right tail (a few 5-10x names) may produce a high mean with a low median.",
  knownWeaknesses: [
    "SURVIVORSHIP REDUCED, NOT REMOVED: Alpha Vantage's delisted list misses some prominent failures (e.g. SDC, IRNT, RIDE) and reuses symbols (FSR = Flagstone, not Fisker). Missing failures are the worst outcomes, so the result is biased UP.",
    "De-SPAC companies enter with the SPAC shell's listing date and are mostly dropped by the first-bar/IPO-date check or the name filter.",
    "Delisting returns: an open position is marked at the last traded close; a bankruptcy delisting can be worse.",
    "Only the price checklist; Payne's fundamental and discretionary screens are not replicated.",
    "Right-tail concentration: a handful of names can carry the mean; the audit must report the median and top-10 share.",
  ],
  ip: "Payne's Education material; the rule is paraphrased from a public webinar; nothing of theirs is republished.", writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-23", area: "R158 Payne IPO reversal — registered", category: "registration", breaksComparability: false, change: `R158 registered after the selftest, before any control or real trade: mechanical IPO-reversal rule on ${uni.names.length} 2016-2025 IPOs incl. ${uni.counts.delisted} delisted; best-of-2 NW bar ${BAR}.`, why: "Operator: 'AI SuperTrend then 1-3' (#3).", doesNotEstablish: "Anything about Payne's discretionary picks.", operator: "Josh 2026-09-23" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R158"], detail: `Payne IPO reversal x2, NW bar ${BAR}` }) + "\n");
console.log(`R158 registered · family bar t_NW >= ${BAR}`);
