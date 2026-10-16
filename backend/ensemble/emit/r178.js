#!/usr/bin/env node
"use strict";
/**
 * Library emitter — R178 Swift Trades LVN pullback (k = 3 x ATR ZigZag): primary ETF pool (SPY+QQQ+IWM) -> "R178", and the BTC/USD
 * family member k3-BTC -> "R178-BTC". READ-ONLY.
 *
 * Source: backend/r178-lvn.js. VERIFIED require()-safe: main() runs only under `if (require.main === module)` (line 556); line 557
 * exports buildInstrument, buildEvents, simulate, CHOOSERS, summarize — used unchanged. The loaders are not exported, so these are
 * COPIED verbatim: ET time helpers (lines 96-110), loadRows / calendar / loadEtf / loadBtc (lines 174-194). Data: the script's own
 * raw-bar cache data/training/r178 (Alpaca SIP 5Min split-adjusted ETFs; Coinbase BTC-USD 5-minute) — nothing is fetched.
 *
 * UNIT CONVERSION. The sealed statistic is in R (planned-risk multiples: gross = dir x (exit - entry)/risk, cost $0.04/share / risk
 * for ETFs, 0.001 x (entry + exit)/risk for BTC). The library needs a RETURN ON CAPITAL, so each trade is re-expressed at 1x notional
 * (the whole sleeve's capital in the instrument at the entry price), with the SAME cost in dollars:
 *   ETF  ret = dir x (exit - entry)/entry - 0.04/entry
 *   BTC  ret = dir x (exit - entry)/entry - 0.001 x (entry + exit)/entry
 * DAILY. ETF trades never survive their session (time exit at 15:55 / the session's last bar), so each trade is booked on its
 * session date. Sequential trades in one instrument reuse the same capital (one open trade per instrument), so they SUM within the
 * instrument; the day's return is then the equal-weight mean over the instruments that traded that session.
 * BTC trades last up to 24h: each is marked to market at UTC midnight (close of the last 5-minute bar of the UTC day), P&L on the
 * entry notional; entry cost (0.1% of entry) on the fill's UTC day, exit cost (0.1% x exit/entry) on the exit's UTC day; one
 * instrument, sequential trades on the same capital, so the day's contributions sum.
 * Reproduction: the script's own summarize() on the SAME trade list (per ET session mean net R, plain t) for both splits.
 */
const fs = require("fs"), path = require("path");
const { writeEntry } = require("../lib-entry.js");
const { buildInstrument, buildEvents, simulate, CHOOSERS, summarize } = require("../../r178-lvn.js");
const CACHE = path.join(__dirname, "..", "..", "data", "training", "r178");
const ETFS = ["SPY", "QQQ", "IWM"], K = 3, HOUR = 3600000;
const WIN = { etf: { disc: ["2018-01-02", "2022-12-31"], hold: ["2023-01-01", "2026-08-31"] }, btc: { disc: ["2021-01-01", "2022-12-31"], hold: ["2023-01-01", "2026-08-31"] } };  // lines 86-89
const SESSIONS = { etf: { disc: 1259, hold: 918 }, btc: { disc: 730, hold: 1339 } };   // data/r178-lvn.json sessions (display-only inputs of summarize)

// ── copied verbatim from r178-lvn.js lines 96-110 ──
const FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const offCache = new Map();
function etOffsetMs(ms) {
  const hk = Math.floor(ms / HOUR);
  let o = offCache.get(hk);
  if (o === undefined) {
    const p = Object.fromEntries(FMT.formatToParts(new Date(hk * HOUR)).map((x) => [x.type, x.value]));
    o = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - hk * HOUR;
    offCache.set(hk, o);
  }
  return o;
}
function etOf(ms) { const d = new Date(ms + etOffsetMs(ms)); return { date: d.toISOString().slice(0, 10), mod: d.getUTCHours() * 60 + d.getUTCMinutes() }; }
// ── copied verbatim from r178-lvn.js lines 174-194 ──
function loadRows(prefix) {
  const files = fs.readdirSync(CACHE).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).sort();
  if (!files.length) throw new Error(`no cached bars for ${prefix} — run --fetch`);
  const m = new Map();
  for (const f of files) for (const r of JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8")).rows) m.set(r[0], r);
  return [...m.values()].sort((a, b) => a[0] - b[0]);
}
let CAL = null;
function calendar() {
  if (CAL) return CAL;
  const f = path.join(CACHE, "calendar.json");
  if (!fs.existsSync(f)) throw new Error("no calendar cached — run --fetch");
  const hm = (x) => +x.slice(0, 2) * 60 + +x.slice(3, 5);
  CAL = new Map(JSON.parse(fs.readFileSync(f, "utf8")).days.map((d) => [d.date, [hm(d.open), hm(d.close)]]));
  return CAL;
}
function loadEtf(sym) {
  const cal = calendar();
  return loadRows(`etf-${sym}-`).filter((r) => { const { date, mod } = etOf(r[0]); const oc = cal.get(date); return oc && mod >= oc[0] && mod < oc[1]; });
}
function loadBtc() { return loadRows("btc-").filter((r) => r[5] >= 0 && r[2] >= r[3]); }

const inWin = (s, w) => s >= w[0] && s <= w[1];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function tOf(a) { const n = a.length; if (n < 3) return NaN; const m = mean(a); const s = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1)); return s > 0 ? m / (s / Math.sqrt(n)) : NaN; }
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// ══ ETF pool ══════════════════════════════════════════════════════════════════════════════════════
function etf() {
  const all = [], perSessInst = new Map();                             // sess -> Map(inst -> summed ret)
  for (const s of ETFS) {
    const I = buildInstrument(s, loadEtf(s), true), E = buildEvents(I, K);
    const tr = simulate(I, E, CHOOSERS.lvn(), { leakCheck: true });   // exactly the sealed member run (runMember, line 456)
    for (const x of tr) {
      if (I.sess[x.xi] !== x.sess) throw new Error(`ETF trade crosses a session ${s} ${x.sess}`);
      all.push(x);
      if (!(inWin(x.sess, WIN.etf.disc) || inWin(x.sess, WIN.etf.hold))) continue;
      const ret = x.dir * (x.exit - x.entry) / x.entry - 0.04 / x.entry;
      if (!perSessInst.has(x.sess)) perSessInst.set(x.sess, new Map());
      const m = perSessInst.get(x.sess); m.set(s, (m.get(s) || 0) + ret);
    }
  }
  const hold = summarize(all, WIN.etf.hold, SESSIONS.etf.hold), disc = summarize(all, WIN.etf.disc, SESSIONS.etf.disc);
  const series = [...perSessInst.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, m]) => ({ d, r: mean([...m.values()]) }));
  const multi = [...perSessInst.values()].filter((m) => m.size > 1).length;
  const tH = tOf(series.filter((x) => inWin(x.d, WIN.etf.hold)).map((x) => x.r)), tD = tOf(series.filter((x) => inWin(x.d, WIN.etf.disc)).map((x) => x.r));
  const tradesIn = all.filter((x) => inWin(x.sess, WIN.etf.disc) || inWin(x.sess, WIN.etf.hold));
  const avgRiskPct = mean(tradesIn.map((x) => x.risk / x.entry)), avgCostR = mean(tradesIn.map((x) => x.gross - x.net)), avgCostPct = mean(tradesIn.map((x) => 0.04 / x.entry));
  console.log(`  ETF k3: holdout ${hold.trades} trades t ${hold.tNet} (sealed 0.35) · discovery ${disc.trades} t ${disc.tNet} (sealed -1.172) · %-return t hold ${tH.toFixed(3)} disc ${tD.toFixed(3)}`);
  const match = Math.abs(hold.tNet - 0.35) <= 0.02 && hold.trades === 1432 && Math.abs(disc.tNet - -1.172) <= 0.02 && disc.trades === 2055;
  writeEntry({
    id: "R178", name: "LVN pullback k3, ETF pool (SPY/QQQ/IWM, 5-minute)", registryId: "R178",
    script: "backend/r178-lvn.js", emitter: "backend/ensemble/emit/r178.js", unit: "daily", net: true,
    costModel: "$0.04/share round trip ($0.02 spread + $0.01/side), as sealed; expressed as 0.04/entry of notional per trade",
    window: [WIN.etf.disc[0], WIN.etf.hold[1]], calendar: "us-equity", series,
    reproduction: { statistic: "holdout per-session mean net R, plain t over sessions with trades (k3 ETF pool)", sealed: 0.35, emitted: hold.tNet, tolerance: 0.02, match },
    construction: "Each intraday LVN trade re-expressed as a 1x-notional return (dir x (exit-entry)/entry - $0.04/entry) and booked on its session; "
      + "sequential trades in one ETF sum (same capital), then the day's return is the equal-weight mean over the ETFs that traded that session.",
    notes: `Series spans discovery (${WIN.etf.disc.join("..")}) + holdout (${WIN.etf.hold.join("..")}); trades are identical to the sealed run `
      + `(holdout ${hold.trades} trades, mean net ${hold.sessionMeanNetR}R/session, t ${hold.tNet}; discovery ${disc.trades} trades, t ${disc.tNet} vs sealed -1.172). `
      + `UNIT: the sealed stat is in R; mean planned risk is ${(100 * avgRiskPct).toFixed(3)}% of entry, so 1R ~ ${(100 * avgRiskPct).toFixed(2)}% of notional and the cost `
      + `that averages ${avgCostR.toFixed(3)}R per trade is only ${(100 * avgCostPct).toFixed(4)}% of notional. On the %-of-capital series the per-session t is ${tH.toFixed(3)} (holdout) / ${tD.toFixed(3)} (discovery) — it `
      + `differs from the R t because R-sizing weights tight-stop trades more. Equal weight over the instruments that traded a given session uses same-day knowledge of which `
      + `ETFs trade (${multi} of ${series.length} sessions had >1 ETF); a fixed 1/3-per-ETF sleeve would scale those days down.`,
  });
}

// ══ BTC arm (k3-BTC) ══════════════════════════════════════════════════════════════════════════════
function btc() {
  const I = buildInstrument("BTC", loadBtc(), false), E = buildEvents(I, K);
  const tr = simulate(I, E, CHOOSERS.lvn(), { leakCheck: true });
  const acc = new Map(), add = (d, r) => acc.set(d, (acc.get(d) || 0) + r);
  let recon = 0;
  for (const x of tr) {
    if (!(inWin(x.sess, WIN.btc.disc) || inWin(x.sess, WIN.btc.hold))) continue;
    const d = x.dir, e0 = x.entry; let mark = e0, sum = 0;
    add(utcDay(I.t[x.fi]), -0.001); sum -= 0.001;                       // entry cost 0.001 x entry / entry
    for (let i = x.fi; i < x.xi; i++) {
      if (utcDay(I.t[i + 1]) !== utcDay(I.t[i])) { const r = d * (I.c[i] - mark) / e0; add(utcDay(I.t[i]), r); sum += r; mark = I.c[i]; }   // UTC-midnight mark
    }
    const rx = d * (x.exit - mark) / e0 - 0.001 * x.exit / e0; add(utcDay(I.t[x.xi]), rx); sum += rx;
    recon = Math.max(recon, Math.abs(sum - (d * (x.exit - e0) / e0 - 0.001 * (e0 + x.exit) / e0)));
  }
  const hold = summarize(tr, WIN.btc.hold, SESSIONS.btc.hold), disc = summarize(tr, WIN.btc.disc, SESSIONS.btc.disc);
  const series = [...acc.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, r]) => ({ d, r }));
  console.log(`  BTC k3: holdout ${hold.trades} trades t ${hold.tNet} (sealed -39.765) · discovery ${disc.trades} t ${disc.tNet} (sealed -20.565) · recon ${recon.toExponential(2)}`);
  const match = Math.abs(hold.tNet - -39.765) <= 0.02 && hold.trades === 3765 && Math.abs(disc.tNet - -20.565) <= 0.02 && disc.trades === 2082;
  writeEntry({
    id: "R178-BTC", name: "LVN pullback k3, BTC/USD (5-minute, 24h)", registryId: "R178",
    script: "backend/r178-lvn.js", emitter: "backend/ensemble/emit/r178.js", unit: "daily", net: true,
    costModel: "0.1% of notional per side (0.001 x (entry + exit) / entry), as sealed",
    window: [WIN.btc.disc[0], WIN.btc.hold[1]], calendar: "crypto-24x7", series,
    reproduction: { statistic: "holdout per-ET-session mean net R, plain t over sessions with trades (k3 BTC member)", sealed: -39.765, emitted: hold.tNet, tolerance: 0.02, match },
    construction: "Each LVN trade at 1x notional, marked to market at every UTC midnight crossed (close of the day's last 5-minute bar), entry cost on the fill's UTC day and "
      + "exit cost on the exit's UTC day; sequential trades on the one instrument sum per UTC day.",
    notes: `Family member k3-BTC of R178 (not the primary). Same trades as the sealed run (holdout ${hold.trades}, t ${hold.tNet}; discovery ${disc.trades}, t ${disc.tNet} vs sealed -20.565). `
      + `The sealed stat groups trades by the ET date of the fill; the library books by UTC day. Max per-trade |sum of daily pieces - trade return| ${recon.toExponential(2)}. `
      + `The 0.2% round-trip cost on ~3 trades/day dominates: this arm is a heavy, near-certain loser in return terms.`,
  });
}

etf();
btc();
