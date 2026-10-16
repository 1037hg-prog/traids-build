#!/usr/bin/env node
/**
 * TRAIDS — DAILY SHORT-VOLUME TEST (test #35): do the FINRA Reg SHO daily files predict?
 *
 * DATA: cdn.finra.org/equity/regsho/daily/CNMSshvolYYYYMMDD.txt — daily short-sale VOLUME
 * per symbol across FINRA facilities (off-exchange/TRF), free, years of depth. This is
 * FLOW, not positions (test #34 covered positions).
 *
 * THE TRAP, STATED UP FRONT: "short volume" here includes MARKET-MAKER liquidity
 * provision — an intermediary filling a BUY order sells short mechanically. High short-
 * volume ratio therefore often proxies buying pressure being intermediated, not bearish
 * conviction. Retail dashboards read it as "short attack"; the mechanics suggest the
 * sign could go either way. Accordingly this is a TWO-SIDED test with no assumed
 * direction, and every cell is Bonferroni-corrected.
 *
 * PRE-REGISTERED DESIGN (fixed before running):
 *   • Universe: the same 220 single names as test #34 (ETFs excluded).
 *   • Signals: (A) LEVEL — the day's shortVol/totalVol ratio; (B) ABNORMAL — z-score of
 *     today's ratio vs the name's own trailing 20-day mean/sd.
 *   • Timing honesty: the file publishes ~6pm after close of day t → positions form at
 *     the next OPEN. Holds tested: 1d (open t+1 → close t+1) and 5d (open t+1 → close t+5).
 *   • Portfolio: quintiles, LONG low-signal − SHORT high-signal, equal-weight,
 *     dollar-neutral, daily formation.
 *   • Stats: day-clustered (portfolio return per formation day), OOS 60/40 split,
 *     Bonferroni across the 4 cells (2 signals × 2 holds): p < 0.0125.
 *   • PRIOR, on the record: mostly market-making noise; nothing survives correction —
 *     and even a survivor would face daily-turnover costs that killed the cross-sectional
 *     test. The bar for caring is high and stated now.
 *
 * Usage: node backend/short-volume-test.js   (env: FILES=520)
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
const AH = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const FILES = parseInt(process.env.FILES || "520");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ETFS = new Set(["SPY","QQQ","IWM","XLK","XLF","XLE","XLV","GLD","SLV","TLT","HYG","EEM","DIA","XLY","XLI"]);
const UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","CRM","ADBE","AVGO","INTC","QCOM","MU","TXN","ORCL","CSCO","IBM","NOW","SNOW","PLTR","SHOP","UBER","ABNB","COIN","PYPL","ROKU","ZM","DOCU","DDOG","NET","CRWD","ZS","OKTA","MDB","TWLO","TEAM","WDAY","PANW","FTNT","MRVL","ON","SMCI","ARM","DELL","HPQ","WDC","STX","ANET","KLAC","LRCX","AMAT","ASML","TSM","SOFI","HOOD","AFRM","UPST","RIVN","LCID","NIO","XPEV","LI","F","GM","BA","CAT","DE","GE","HON","UNP","JPM","BAC","GS","MS","C","WFC","SCHW","V","MA","AXP","COF","BLK","LLY","UNH","JNJ","PFE","MRK","ABBV","BMY","MRNA","REGN","VRTX","GILD","AMGN","ISRG","DXCM","XOM","CVX","COP","OXY","SLB","HAL","MPC","WMT","COST","TGT","HD","LOW","NKE","SBUX","MCD","DIS","CMCSA","T","VZ","PG","KO","PEP","MARA","RIOT","MSTR","DKNG","CVNA","CHWY","RBLX","U","DASH","PINS","SNAP","SPOT","TTD","ENPH","FSLR","BABA","JD","PDD","MELI","SE","CMG","LULU","ORLY","ROST","TJX","MMM","LMT","RTX","NOC","GD","UPS","FDX","CSX","NSC","EMR","ITW","PH","ETN","APD","LIN","SHW","ECL","NEM","FCX","NUE","STLD","DOW","DD","PPG","KMB","CL","GIS","K","HSY","STZ","MO","PM","EL","SYY","ADM","BG","CF","MOS","DVN","FANG","EOG","PSX","VLO","KMI","WMB","OKE","D","DUK","SO","NEE","AEP","EXC","SRE","PCG","ED","XEL","WEC","AWK","AMT","PLD","EQIX","CCI","PSA","O","SPG","DLR","AVB","EQR","VICI","WELL","ARE","BXP","HST","KIM","REG"].filter(s => !ETFS.has(s));
const USET = new Set(UNIVERSE);

async function fetchDay(yyyymmdd) {
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${yyyymmdd}.txt`);
      if (r.status === 404) return null;             // weekend/holiday
      if (!r.ok) { await sleep(1200); continue; }
      const txt = await r.text();
      const out = {};
      for (const line of txt.split("\n")) {
        const p = line.split("|");
        if (p.length < 5 || !USET.has(p[1])) continue;
        const sv = +p[2], tv = +p[4];
        if (tv > 0) out[p[1]] = sv / tv;
      }
      return out;
    } catch { await sleep(1500 * (k + 1)); }
  }
  return null;
}
async function bars(sym, days) {
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const out = []; let tok = null;
  do {
    const p = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED });
    if (tok) p.set("page_token", tok);
    let r; try { r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${p}`, { headers: AH }); } catch { break; }
    if (!r.ok) break;
    const j = await r.json();
    for (const b of (j.bars?.[sym] || [])) out.push({ t: (b.t || "").slice(0, 10), o: b.o, c: b.c });
    tok = j.next_page_token || null;
  } while (tok);
  return out;
}
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const tOf = a => a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0;
const pOf = (t) => { const z = Math.abs(t); return Math.min(1, Math.exp(-0.717 * z - 0.416 * z * z)); };

(async () => {
  console.log(`\n  TRAIDS — DAILY SHORT-VOLUME TEST (test #35) · Reg SHO flow files as a signal`);
  console.log(`  ${UNIVERSE.length} names · ~${FILES} calendar days of files · signals: level + 20d z · holds: 1d, 5d (next-open entry) · two-sided · Bonferroni ×4\n`);

  // 1 — panel of daily short-volume ratios
  process.stdout.write("  fetching daily files");
  const svr = {};            // date -> {sym: ratio}
  const today = new Date();
  let got = 0;
  for (let d = FILES; d >= 3; d--) {
    const dt = new Date(today.getTime() - d * 86400000);
    const key = dt.toISOString().slice(0, 10).replace(/-/g, "");
    const day = await fetchDay(key);
    if (day && Object.keys(day).length > 50) { svr[dt.toISOString().slice(0, 10)] = day; got++; if (got % 25 === 0) process.stdout.write("."); }
    await sleep(60);
  }
  const svDates = Object.keys(svr).sort();
  console.log(` ${svDates.length} trading days (${svDates[0]} → ${svDates[svDates.length - 1]})`);

  // 2 — prices
  process.stdout.write("  fetching price history");
  const px = {}, idx = {};
  for (const s of UNIVERSE) { const d = await bars(s, FILES + 30); if (d.length > 100) { px[s] = d; idx[s] = Object.fromEntries(d.map((b, i) => [b.t, i])); } process.stdout.write("."); }
  console.log(` ${Object.keys(px).length} priced\n`);

  // trailing 20d z-score per name
  const zOf = (sym, di) => {
    const win = [];
    for (let k = Math.max(0, di - 20); k < di; k++) { const v = svr[svDates[k]][sym]; if (v != null) win.push(v); }
    if (win.length < 12) return null;
    const m = mean(win), s = sd(win);
    const cur = svr[svDates[di]][sym];
    return s > 0 && cur != null ? (cur - m) / s : null;
  };

  // 3 — portfolios per formation day
  const cells = { "level×1d": [], "level×5d": [], "z20×1d": [], "z20×5d": [] };
  for (let di = 21; di < svDates.length - 6; di++) {
    const d0 = svDates[di];
    for (const [sigName, sigFn] of [["level", (s) => svr[d0][s]], ["z20", (s) => zOf(s, di)]]) {
      const ranked = [];
      for (const s of Object.keys(svr[d0])) {
        if (!px[s]) continue;
        const v = sigFn(s);
        if (v == null) continue;
        const i0 = idx[s][d0];
        if (i0 == null || i0 + 5 >= px[s].length) continue;
        const e = px[s][i0 + 1];                       // next session (entry at its open)
        if (!e || !(e.o > 0)) continue;
        ranked.push({ s, v, r1: px[s][i0 + 1].c / e.o - 1, r5: px[s][i0 + 5].c / e.o - 1 });
      }
      if (ranked.length < 80) continue;
      ranked.sort((a, b) => a.v - b.v);
      const q = Math.floor(ranked.length / 5);
      const lo = ranked.slice(0, q), hi = ranked.slice(-q);
      cells[sigName + "×1d"].push((mean(lo.map(x => x.r1)) - mean(hi.map(x => x.r1))) / 2);
      cells[sigName + "×5d"].push((mean(lo.map(x => x.r5)) - mean(hi.map(x => x.r5))) / 2);
    }
  }

  const BONF = 0.05 / 4;
  console.log("  cell        days    avg L−S/day     ann      t       p        OOS t   verdict (Bonferroni p<" + BONF + ")");
  console.log("  " + "-".repeat(100));
  for (const [name, arr] of Object.entries(cells)) {
    if (arr.length < 60) { console.log("  " + name.padEnd(10) + " insufficient"); continue; }
    const t = tOf(arr), p = pOf(t);
    const cut = Math.floor(arr.length * 0.6);
    const oosT = tOf(arr.slice(cut));
    const annR = mean(arr) * 252 * 100 / (name.includes("5d") ? 5 : 1);
    console.log("  " + name.padEnd(10) + String(arr.length).padStart(6) + "   " +
      ((mean(arr) >= 0 ? "+" : "") + (mean(arr) * 100).toFixed(4) + "%").padStart(10) +
      ((annR >= 0 ? "+" : "") + annR.toFixed(1) + "%").padStart(9) + t.toFixed(2).padStart(8) + p.toExponential(1).padStart(9) +
      oosT.toFixed(2).padStart(8) + "    " + (p < BONF && Math.sign(t) === Math.sign(oosT) && Math.abs(oosT) > 1.96 ? "★ SURVIVES" : p < BONF ? "sig full-sample, fails OOS" : "noise"));
  }

  console.log("\n  ── PRE-REGISTERED VERDICT ──");
  console.log("    Read the table against the stated bar: Bonferroni p<" + BONF + " AND same-sign OOS |t|>1.96.");
  console.log("    Sign convention: positive = LOW short-volume names outperform (dashboard folklore's");
  console.log("    'high short volume = bearish' would ALSO show positive); negative = high short-volume");
  console.log("    names outperform (the market-maker/buying-pressure mechanics). Either way, a survivor");
  console.log("    faces daily-turnover costs before it means anything.\n");
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
