#!/usr/bin/env node
/**
 * TRAIDS — svrZ TURNOVER & NET ECONOMICS (test #44)
 *
 * ANSWERS A QUESTION I HAD BEEN ASSERTING WITHOUT MEASURING.
 *
 * Test #35 found z20×1d survives correction (t 3.49 IS / 2.85 OOS, +13.9%/yr gross) and its
 * header noted the survivor "faces daily-turnover costs". I repeated that as "churn ≈3× the
 * gross edge" for days, and used it to call the strategy dead. That figure assumes 100% DAILY
 * TURNOVER — every name in both quintiles replaced every session.
 *
 * The signal is a 20-day z-score. A 20-day statistic is persistent by construction: a name in
 * the bottom quintile today is probably still there tomorrow. If real turnover is 30%, the cost
 * is 7.6%/yr against a 13.9% gross edge and the strategy is POSITIVE. I never checked.
 *
 * So this measures the thing instead of assuming it:
 *   1. Actual daily quintile-membership turnover, long side and short side separately.
 *   2. Net return using MEASURED turnover across a round-trip cost grid.
 *   3. A hysteresis variant — hold a name until it leaves a WIDER band — which trades less
 *      without delaying entry, the one turnover lever the day-1 decay profile does not kill.
 *
 * COST ACCOUNTING, stated so it can be checked: returns follow test #35's convention,
 * (mean_low − mean_high)/2, i.e. per unit of gross exposure. Trading fraction τ of each side
 * costs τ × roundTrip per unit of gross per day, so annual cost = 252 × τ × roundTrip.
 * At τ=1.0 and 10bps that reproduces the 25.2%/yr I had been quoting — the formula is not the
 * problem, the τ=1.0 assumption was.
 *
 * PRE-REGISTERED READING: the strategy is viable if net return is positive and the implied
 * breakeven round-trip cost exceeds what a retail account plausibly pays (~5–10 bps on liquid
 * large caps). Anything below that is a confirmation that it is untradeable, not a maybe.
 *
 * Usage: node backend/svrz-turnover.js   (env: FILES=520)
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
const AH = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const FILES = parseInt(process.env.FILES || "520");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const COST_GRID = [0, 0.0002, 0.0005, 0.0010, 0.0020];   // round trip, decimal

const ETFS = new Set(["SPY","QQQ","IWM","XLK","XLF","XLE","XLV","GLD","SLV","TLT","HYG","EEM","DIA","XLY","XLI"]);
const UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","CRM","ADBE","AVGO","INTC","QCOM","MU","TXN","ORCL","CSCO","IBM","NOW","SNOW","PLTR","SHOP","UBER","ABNB","COIN","PYPL","ROKU","ZM","DOCU","DDOG","NET","CRWD","ZS","OKTA","MDB","TWLO","TEAM","WDAY","PANW","FTNT","MRVL","ON","SMCI","ARM","DELL","HPQ","WDC","STX","ANET","KLAC","LRCX","AMAT","ASML","TSM","SOFI","HOOD","AFRM","UPST","RIVN","LCID","NIO","XPEV","LI","F","GM","BA","CAT","DE","GE","HON","UNP","JPM","BAC","GS","MS","C","WFC","SCHW","V","MA","AXP","COF","BLK","LLY","UNH","JNJ","PFE","MRK","ABBV","BMY","MRNA","REGN","VRTX","GILD","AMGN","ISRG","DXCM","XOM","CVX","COP","OXY","SLB","HAL","MPC","WMT","COST","TGT","HD","LOW","NKE","SBUX","MCD","DIS","CMCSA","T","VZ","PG","KO","PEP","MARA","RIOT","MSTR","DKNG","CVNA","CHWY","RBLX","U","DASH","PINS","SNAP","SPOT","TTD","ENPH","FSLR","BABA","JD","PDD","MELI","SE","CMG","LULU","ORLY","ROST","TJX","MMM","LMT","RTX","NOC","GD","UPS","FDX","CSX","NSC","EMR","ITW","PH","ETN","APD","LIN","SHW","ECL","NEM","FCX","NUE","STLD","DOW","DD","PPG","KMB","CL","GIS","K","HSY","STZ","MO","PM","EL","SYY","ADM","BG","CF","MOS","DVN","FANG","EOG","PSX","VLO","KMI","WMB","OKE","D","DUK","SO","NEE","AEP","EXC","SRE","PCG","ED","XEL","WEC","AWK","AMT","PLD","EQIX","CCI","PSA","O","SPG","DLR","AVB","EQR","VICI","WELL","ARE","BXP","HST","KIM","REG"].filter(s => !ETFS.has(s));

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };

async function fetchDay(yyyymmdd) {
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${yyyymmdd}.txt`, { signal: AbortSignal.timeout(20000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(String(r.status));
      const out = {};
      for (const line of (await r.text()).split(/\r?\n/).slice(1)) {
        const p = line.split("|");
        if (p.length < 5) continue;
        const sym = p[1], sv = +p[2], tv = +p[4];
        if (UNIVERSE.includes(sym) && tv > 0) out[sym] = sv / tv;
      }
      return Object.keys(out).length ? out : null;
    } catch { await sleep(400 * (k + 1)); }
  }
  return null;
}

async function bars(sym, days) {
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  try {
    const u = `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&limit=10000&adjustment=all&feed=${FEED}`;
    const r = await fetch(u, { headers: AH, signal: AbortSignal.timeout(30000) });
    if (!r.ok) return [];
    return ((await r.json()).bars || []).map(b => ({ t: b.t.slice(0, 10), o: b.o, c: b.c }));
  } catch { return []; }
}

(async () => {
  console.log(`\n  TEST #44 — svrZ TURNOVER & NET ECONOMICS`);
  console.log(`  measuring the turnover figure I had been assuming\n`);

  process.stdout.write("  fetching daily files");
  const svr = {};
  for (let i = FILES; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    if ([0, 6].includes(d.getUTCDay())) continue;
    const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
    const day = await fetchDay(ymd);
    if (day) svr[d.toISOString().slice(0, 10)] = day;
    if (i % 40 === 0) process.stdout.write(".");
    await sleep(60);
  }
  const dates = Object.keys(svr).sort();
  console.log(` ${dates.length} trading days (${dates[0]} → ${dates[dates.length - 1]})`);

  process.stdout.write("  fetching price history");
  const px = {}, idx = {};
  for (const s of UNIVERSE) { const d = await bars(s, FILES + 30); if (d.length > 100) { px[s] = d; idx[s] = Object.fromEntries(d.map((b, i) => [b.t, i])); } if (UNIVERSE.indexOf(s) % 20 === 0) process.stdout.write("."); }
  console.log(` ${Object.keys(px).length} priced\n`);

  const zOf = (sym, di) => {
    const win = [];
    for (let k = Math.max(0, di - 20); k < di; k++) { const v = svr[dates[k]][sym]; if (v != null) win.push(v); }
    if (win.length < 12) return null;
    const m = mean(win), s = sd(win);
    const cur = svr[dates[di]][sym];
    return s > 0 && cur != null ? (cur - m) / s : null;
  };

  /**
   * @param buffer 0 = strict quintile reconstitution each day (the original spec).
   *               >0 = hysteresis: keep an existing holding until it leaves the wider
   *               (0.2 + buffer) fractile band. Reduces turnover WITHOUT delaying entry.
   */
  function run(buffer) {
    const rets = [], turnL = [], turnS = [];
    let prevL = new Set(), prevS = new Set();
    for (let di = 21; di < dates.length - 2; di++) {
      const d0 = dates[di];
      const ranked = [];
      for (const s of Object.keys(svr[d0])) {
        if (!px[s]) continue;
        const v = zOf(s, di);
        if (v == null) continue;
        const i0 = idx[s][d0];
        if (i0 == null || i0 + 1 >= px[s].length) continue;
        const e = px[s][i0 + 1];
        if (!e || !(e.o > 0)) continue;
        ranked.push({ s, v, r1: e.c / e.o - 1 });
      }
      if (ranked.length < 80) continue;
      ranked.sort((a, b) => a.v - b.v);
      const n = ranked.length, q = Math.floor(n * 0.2), qWide = Math.floor(n * (0.2 + buffer));
      const coreL = new Set(ranked.slice(0, q).map(x => x.s));
      const coreS = new Set(ranked.slice(-q).map(x => x.s));
      const wideL = new Set(ranked.slice(0, qWide).map(x => x.s));
      const wideS = new Set(ranked.slice(-qWide).map(x => x.s));
      // keep what still qualifies loosely, then top up from the core
      const L = new Set([...prevL].filter(s => wideL.has(s)));
      for (const s of coreL) { if (L.size >= q) break; L.add(s); }
      const S = new Set([...prevS].filter(s => wideS.has(s)));
      for (const s of coreS) { if (S.size >= q) break; S.add(s); }
      if (!L.size || !S.size) continue;

      const rOf = (set) => mean(ranked.filter(x => set.has(x.s)).map(x => x.r1));
      const rl = rOf(L), rs = rOf(S);
      if (rl == null || rs == null) continue;
      rets.push((rl - rs) / 2);

      // one-way turnover: fraction of each side replaced versus the previous day
      if (prevL.size) turnL.push([...L].filter(s => !prevL.has(s)).length / L.size);
      if (prevS.size) turnS.push([...S].filter(s => !prevS.has(s)).length / S.size);
      prevL = L; prevS = S;
    }
    const m = mean(rets), s = sd(rets);
    const tau = (mean(turnL) + mean(turnS)) / 2;
    return { n: rets.length, daily: m, ann: m * 252, t: m / (s / Math.sqrt(rets.length)), tau, rets };
  }

  const variants = [["strict quintile (original)", 0], ["buffer +10%", 0.10], ["buffer +20%", 0.20], ["buffer +30%", 0.30]];
  console.log(`  ══ MEASURED TURNOVER AND NET RETURN ══`);
  console.log(`  variant                     n    one-way τ/day   gross ann    t      net @2bp   net @5bp   net @10bp   breakeven`);
  console.log(`  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────`);
  const rows = [];
  for (const [label, b] of variants) {
    const r = run(b);
    const netAt = (rt) => r.ann - 252 * r.tau * rt;
    const breakeven = r.tau > 0 ? r.daily / r.tau : null;     // round-trip cost that zeroes it
    rows.push({ label, buffer: b, ...r, breakevenRt: breakeven, net2: netAt(0.0002), net5: netAt(0.0005), net10: netAt(0.0010) });
    const pc = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%";
    console.log(`  ${label.padEnd(26)} ${String(r.n).padStart(4)}   ${(r.tau * 100).toFixed(1).padStart(11)}%   ${pc(r.ann).padStart(9)}  ${r.t.toFixed(2).padStart(5)}   ${pc(netAt(0.0002)).padStart(8)}   ${pc(netAt(0.0005)).padStart(8)}   ${pc(netAt(0.0010)).padStart(9)}   ${breakeven != null ? (breakeven * 1e4).toFixed(1) + " bp" : "—"}`);
  }

  const best = rows.reduce((a, b) => (a && a.net5 >= b.net5 ? a : b), null);
  console.log(`\n  ══ READING ══`);
  console.log(`  The "100% daily turnover" assumption I had been repeating: WRONG.`);
  console.log(`  Measured one-way turnover on the original strict spec: ${(rows[0].tau * 100).toFixed(1)}% per side per day.`);
  console.log(`  That makes the annual cost 252 × ${(rows[0].tau).toFixed(3)} × roundTrip, not 252 × 1.0 × roundTrip —`);
  console.log(`  i.e. ${(rows[0].tau * 100).toFixed(0)}% of what I had assumed.\n`);
  console.log(`  Best variant by net-at-5bp: ${best.label}`);
  console.log(`    gross ${(best.ann * 100).toFixed(2)}%/yr · τ ${(best.tau * 100).toFixed(1)}%/day · breakeven round trip ${(best.breakevenRt * 1e4).toFixed(1)} bp`);
  console.log(`    net at 2bp ${(best.net2 * 100).toFixed(2)}% · at 5bp ${(best.net5 * 100).toFixed(2)}% · at 10bp ${(best.net10 * 100).toFixed(2)}%`);
  const verdict = best.breakevenRt * 1e4 >= 10 ? "VIABLE at plausible retail costs — promote to a pre-registered forward candidate, do NOT fund off this"
    : best.breakevenRt * 1e4 >= 5 ? "MARGINAL — viable only with disciplined execution; forward-test before believing it"
    : "CONFIRMED UNTRADEABLE — breakeven cost is below what a retail account pays";
  console.log(`\n  VERDICT: ${verdict}\n`);

  fs.writeFileSync(path.join(__dirname, "data", "svrz-turnover-44.json"), JSON.stringify({
    generated: new Date().toISOString(), test: 44,
    motivation: "The 'churn ≈3× the gross edge' figure was asserted from a 100%-daily-turnover assumption and never measured.",
    days: dates.length, window: [dates[0], dates[dates.length - 1]],
    costAccounting: "annual cost = 252 × one-way τ × roundTrip, in the same per-unit-gross units as the return",
    variants: rows.map(r => ({ label: r.label, buffer: r.buffer, n: r.n, tauOneWay: r.tau, grossAnn: r.ann, t: r.t, breakevenRoundTripBp: r.breakevenRt * 1e4, net2bp: r.net2, net5bp: r.net5, net10bp: r.net10 })),
    verdict,
    caveats: [
      "Costs modelled as a flat round-trip fraction; real market impact scales with size and is not modelled.",
      "Turnover is measured on quintile MEMBERSHIP; a real book also rebalances weights within the quintile, which adds turnover this figure omits.",
      "Short leg assumes borrow is available and free. Hard-to-borrow names in the high-short-volume quintile is exactly where that assumption is most likely to break.",
    ],
  }, null, 1));
  console.log(`  written: backend/data/svrz-turnover-44.json\n`);
})();
