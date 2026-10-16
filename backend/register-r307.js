#!/usr/bin/env node
/** Registers R307 — "ride the wave to just before the crest and then bail" (operator 2026-10-01). Crypto surge entries with three
 *  mechanical bail-out exits, historical on Coinbase hourly candles for the coins Alpaca can actually trade. Written BEFORE any candle is
 *  pulled for this purpose (R306's BTC/ETH cache exists; no surge statistic has been computed on it). Bar = nullBar({variants:3, n:500}).p95.
 *  Refuses if the id exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { nullBar } = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const ID = "R307", TODAY = "2026-10-01", CELLS = 3, N = 500;
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === ID)) { console.error(`${ID} exists — refusing`); process.exit(2); }
const b = +nullBar({ variants: CELLS, n: N, trials: 20000 }).p95.toFixed(3);
const COINS = "BTC ETH SOL XRP DOGE ADA AVAX LINK LTC BCH DOT UNI AAVE SHIB PEPE BONK WIF TRUMP HYPE RENDER POL YFI XTZ BAT CRV SKY FIL GRT LDO SUSHI ARB ONDO";
reg.preregistered.push({
  id: ID, registered: TODAY, name: "Ride the wave, bail before the crest — long crypto surges with mechanical early exits (trailing stop / volume fade / fixed 6 h)",
  status: `REGISTERED ${TODAY} — historical, read once; builder assigned`, script: "backend/r307-ride-the-wave.js",
  parent: "Operator 2026-10-01: 'ride the wave to just before the crest and then bail' (context: whale/influencer-driven crypto pumps that jump within minutes and give it back within days). Priors: R190/R230 crypto trend DID NOT PASS (daily horizon); R302 listing fade refuted; R306 level breaks DID NOT PASS. Untested here: hour-scale surge entries with early exits.",
  multiplicityFamily: "WAVE — R307 alone; 3 cells (exit rules TRAIL, FADE, T6), long only, 32 coins pooled.",
  evidenceStart: "historical: Coinbase Exchange hourly candles 2021-01-01..2026-09-30 (registered window); 2019-2020 discovery reported only",
  rule: [
    `UNIVERSE (fixed today): the 32 non-stablecoin USD pairs Alpaca can trade on 2026-10-01 — ${COINS} — priced from Coinbase Exchange hourly candles (X-USD); a coin Coinbase does not list, or before its first Coinbase candle, simply has no events (reported).`,
    "SURGE (the wave starting), on the close of hour t, all inputs from bars <= t: hourly return >= 3 x the coin's trailing 7-day (168 h) hourly return standard deviation, AND hourly volume >= 3 x its trailing 7-day median hourly volume, AND the close is above the prior 24-hour high. At most one entry per coin per 24 hours. ENTER LONG at the close of hour t (taker).",
    "EXITS (the bail), evaluated on hourly closes from t+1, hard cap 48 hours:",
    "  TRAIL: exit at the first close more than 1.5 x the entry-time 24-hour ATR (hourly true ranges, mean over 24 h) below the highest close since entry;",
    "  FADE: exit at the first hour whose volume falls below 1.0 x the trailing 7-day median hourly volume (the wave losing participation), or at TRAIL's stop if that comes first;",
    "  T6: exit at the close of t+6 (a fixed early bail).",
    "COST: 0.50% round trip per trade (Alpaca crypto taker 0.25% per side; spread not added separately — disclosed).",
  ].join(" "),
  statistic: "Per UTC day with entries: mean net trade return across all coins entering that day (day clustering, because surges cluster market-wide). One-sample t over days, registered window; best-of-3 cells.",
  unit: "days", nExpected: N,
  controls: {
    placebo: "RANDOM ENTRIES: the same coins, the same calendar days and hours-of-day as the real entries, random hours that did NOT meet the surge rule, the same exit rule per cell; 500 draws; the observed cell mean must beat the placebo p95.",
    halves: "first and second half of the registered window; both must be positive.",
    concentration: "per coin, per year, BTC+ETH-only vs alts, and the share of P&L from the top 10 days, reported.",
    crestCheck: "for each trade, how far the exit landed from the trade's 48-hour peak (fraction of the peak gain captured), reported — the literal 'before the crest' question.",
  },
  bar: { fixedInAdvance: true, unit: "days", tRequired: b, variants: CELLS, source: `nullBar({variants:${CELLS}, n:${N}, trials:20000}).p95 = ${b}` },
  interimKill: "none (single historical read)",
  decisionRule: {
    pass: "PASS only if the better cell's net t >= bar AND the random-entry placebo is beaten AND both halves are positive. A PASS proposes a forward paper test on the Alpaca crypto account (operator's call); nothing is adopted or funded.",
    fail: "DID NOT PASS: recorded with the numbers; surges in these coins are not rideable after costs with these exits.",
    cannotMeasure: "CANNOT MEASURE if fewer than 20 coins have Coinbase candles in the registered window, or fewer than 300 days with entries.",
  },
  knownWeaknesses: [
    "Survivorship: the universe is today's Alpaca list, so coins that pumped and died (delisted) are missing — this FLATTERS a long-surge strategy.",
    "Entry at the surge hour's close assumes the close is tradeable; in real pumps the first minutes are taken by faster traders — the hourly close is already late, which is the honest retail case.",
    "Cost is a flat 0.50%; thin alts can cost more in spread, which flatters the alt results.",
    "Exit parameters (1.5 ATR, 1.0 x volume, 6 h, 48 h cap) and surge thresholds (3 sigma, 3 x volume, 24 h high) are fixed here once from common practice, not searched; the bar is best-of-3 over the exit cells.",
    "Long only (Alpaca spot cannot short crypto).",
  ],
  readCondition: "read once after --selftest passes its known answers; the builder pulls candles, computes events, then returns once.",
  writerExists: false, writerNote: "runner written by a builder agent on 2026-10-01; CANNOT MEASURE is a legitimate outcome, never a silent substitution",
  ip: "ours",
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: TODAY, area: "registry — R307 ride the wave", category: "registration", breaksComparability: false, change: `Registered R307 before any surge statistic: 32 Alpaca-tradable coins on Coinbase hourly candles 2021-2026, surge entry (3 sigma hourly + 3x volume + 24 h high), exits TRAIL/FADE/T6 (48 h cap), 0.50% round trip, day-clustered t, bar ${b} (best-of-3, n ${N}), random-entry placebo + halves.`, why: "Operator 2026-10-01: 'ride the wave to just before the crest and then bail'.", doesNotEstablish: "Any result.", operator: "Josh 2026-10-01" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "register", tests: [ID], family: "WAVE" }) + "\n");
console.log(`${ID} registered · bar ${b} (days, best-of-${CELLS}) · ${reg.preregistered.length} preregistered`);
