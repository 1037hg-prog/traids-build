#!/usr/bin/env node
/** Registers R156 — QQE MOD + SSL Hybrid + WAE, the author's defaults out of sample on BTC 1h. 2026-09-23, operator: "keep mining".
 *  Filed after the selftest and BEFORE any control or out-of-sample trade was computed. Refuses if R156 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R156")) { console.error("R156 already exists — refusing"); process.exit(2); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n, c = 0; for (let i = 1; i < n; i++) c += d[i] * d[i - 1]; v += c / n; return m / Math.sqrt(v / n); }
const rng = mulberry(156), T = 50000, N = 53, xs = []; for (let t = 0; t < T; t++) { const s = []; for (let i = 0; i < N; i++) s.push(rng() * 2 - 1); xs.push(nwT(s)); }
xs.sort((a, b) => a - b); const BAR = +xs[Math.floor(0.95 * T)].toFixed(3);
reg.preregistered.push({
  id: "R156", name: "QQE MOD + SSL Hybrid + Waddah Attar Explosion (kevinmck100) — the author's defaults out of sample on BTC 1h",
  registered: "2026-09-23", evidenceStart: "2022-05-06",
  evidenceNote: "Historical but out of sample for the configuration: the author's report is BINANCE:BTCUSDT 1h 2022-01-01..2022-05-05, published 2022-05-05. Evaluation window 2022-05-06..2026-09-22 on Coinbase BTC-USD hourly. Registered after the selftest (108 in-sample trades vs TradingView's 109), before any control or out-of-sample trade. One read, sealed.",
  status: "REGISTERED 2026-09-23 — controls, then one read", script: "backend/r156-qqe-ssl-wae-oos.js",
  parent: "R153 second verification: backend/r153-qqe-verify.js reproduces the author's report — 98/109 trades match on entry within 1h, exit within 2h and 1%; 102/109 entries (HMA(15) half-length floored, as Pine truncates). Excluded from R152 as too large; now verified.",
  source: "TradingView /script/YCob5r03/ ; report +28.40%, 66/108 winners, max DD 13.99%",
  multiplicityFamily: "QQE-SSL-WAE-OOS-1 — one member, the author's own defaults; no parameter was chosen by us (HMA half-length is a translation detail fixed by the R153 match, not a searched parameter).",
  rule: "As published: long when the QQE MOD bar turns blue (RsiMa2-50 > 3 and RsiMa-50 above its Bollinger upper band, first bar), close > HMA(60)+0.2*EMA(TR,60) and > HMA(60), and WAE trend-up > 0 and > explosion line; short mirrored. Entry at next open; stop = 10-bar swing low/high; exit when close crosses the SSL exit line (HMA(high/low,15)) against the position AND the trade is in profit at the close -> next open. Size: risk 2% of equity per trade (weight = 2% / stop distance).",
  statistic: "Monthly strategy return = sum over trades exiting in the month of weight x (direction x price return - 0.10% round trip); 53 months 2022-05..2026-09; Newey-West lag 1.",
  bar: { fixedInAdvance: true, unit: "months", statistic: "Newey-West t, lag 1", variants: 1, tRequired: BAR, minTrades: 50,
    memberBar: "bar + max(0, mean t on 10 arithmetic drift-free hourly scrambles)",
    source: `simulated in register-r156.js: NW(lag 1) t on zero-mean iid noise, n=53, 50,000 trials, seed 156, p95 = ${BAR}` },
  controls: { leakTest: "10 arithmetic drift-free scrambles of the hourly bars: mean noise t < 2", floor: "drift-kept scrambles (seeds 1, 2): the real monthly mean must beat it", positiveControl: "winners-only subset t >= member bar" },
  interimKill: "none — one read over a fixed sample",
  decisionRule: { pass: "trades >= 50, monthly mean > 0 and above the floor, t >= member bar, both halves positive. Adopts nothing: post-read audit, then only if it survives a forward paper test.", fail: "DID NOT PASS: the published report did not carry forward; closed on these data." },
  readCondition: "Immediately after the controls print READY: node backend/r156-qqe-ssl-wae-oos.js --read, then node backend/seal-r156.js.",
  expectation: "I expect DID NOT PASS: a four-month hourly in-sample report on one asset is thin, and R155's showcase collapsed out of sample.",
  knownWeaknesses: ["Coinbase BTC-USD, not Binance BTCUSDT; hourly signals are price-sensitive (R153 matched 98/109 in sample regardless).", "Risk-based sizing makes weight = 2%/stop distance; tight stops mean leverage above 1x, as the author's code does.", "Exit-month booking instead of a daily mark (holds are hours to days).", "House cost 0.10% round trip vs the author's 0.02%."],
  ip: "TradingView House Rules forbid republishing the code; our re-implementation stays in this repo.", writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-23", area: "R156 QQE+SSL+WAE out of sample — registered", category: "registration", breaksComparability: false, change: `R156 registered after the selftest, before any control or OOS trade: the author's defaults on BTC 1h 2022-05-06..2026-09-22; NW bar ${BAR}.`, why: "Operator: 'keep mining'; translation verified 98/109 (R153).", doesNotEstablish: "Anything about other settings or assets.", operator: "Josh 2026-09-23" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R156"], detail: `QQE+SSL+WAE OOS, NW bar ${BAR}` }) + "\n");
console.log(`R156 registered · bar t_NW >= ${BAR}`);
