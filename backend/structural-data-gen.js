#!/usr/bin/env node
/**
 * TRAIDS — STRUCTURAL TRAINING-DATA GENERATOR
 *
 * WHY THIS EXISTS. Test #39 trained a gradient-boosted model on 150,316 episodes and got
 * AUC 0.5013 against a shuffled control of 0.4979 — no skill. Every one of its 19 features
 * was a PRICE or VOLUME pattern. This project's own record, cross-tabbed on 2026-07-28, is
 * that price-pattern hypotheses are 2-for-35 (and both survivors failed re-measurement, so
 * effectively 0-for-35), while STRUCTURAL hypotheses — ones naming a counterparty with a
 * motive — are 12-for-12, never once killed.
 *
 * So #39 tested the losing category and reported the losing category's result. This
 * regenerates the same kind of dataset from ORDER-FLOW DISCLOSURE instead of chart shapes.
 *
 * WHAT THE FEATURES ARE, AND WHY THEY ARE NOT PRICE PATTERNS. FINRA publishes, for every
 * consolidated-tape symbol every session, the share of volume that was executed SHORT. That is
 * not a shape in a chart — it is a disclosure about WHO traded and HOW, filed under rule, with
 * an identifiable population behind it (short sellers who had to locate a borrow, and market
 * makers whose exempt flow is separately reported). Test #35 already found the 20-day z-score
 * of this ratio survives Bonferroni AND out-of-sample (t 3.32 / 3.09) — it was shelved only
 * because it was cost-locked at daily turnover, not because the signal was absent.
 *
 * THAT SHELVING IS THE OPENING THIS EXPLOITS. #35 tested ONE feature at 1-day and 5-day holds
 * with daily formation, so transaction costs ate it. Two things change here:
 *   1. MULTIPLE structural features, combined by a model, rather than one z-score alone.
 *   2. LONGER horizons (20 days), where the same per-trade cost is amortised over 20× the
 *      holding period and the turnover problem shrinks proportionally.
 *
 * ── LEAKAGE DISCIPLINE, inherited from training-data-gen.js ────────────────────────────────
 * PUBLICATION LAG IS THE KILLER HERE and it is handled explicitly. The FINRA daily file for
 * session t publishes ~6pm ET AFTER that session closes. So a feature built from file t cannot
 * inform a decision until session t+1, and every label therefore starts from the t+1 CLOSE.
 * There is exactly one place in this file that looks forward and it is the label block.
 *
 * MARKET-ADJUSTED LABELS. Raw forward returns would let the model learn "the market went up",
 * which is beta, not selection — the error that killed the "+30%/yr long leg" in #28/#29.
 * Every label subtracts SPY over the identical window.
 *
 * Usage:  node backend/structural-data-gen.js            (env: DAYS=750)
 *         FINRA files are cached under backend/data/finra-cache/ so re-runs are cheap.
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
const AH = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "750");
const CACHE = path.join(__dirname, "data", "finra-cache");
const OUT = path.join(__dirname, "data", "structural-dataset.json");
const HORIZONS = [1, 5, 20];
const Z_WIN = 20, PCT_WIN = 250;

const UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","CRM","ADBE","AVGO","INTC","QCOM","MU","TXN","ORCL","CSCO","IBM","NOW","SNOW","PLTR","SHOP","UBER","ABNB","COIN","PYPL","ROKU","ZM","DOCU","DDOG","NET","CRWD","ZS","OKTA","MDB","TWLO","TEAM","WDAY","PANW","FTNT","MRVL","ON","SMCI","ARM","DELL","HPQ","WDC","STX","ANET","KLAC","LRCX","AMAT","ASML","TSM","SOFI","HOOD","AFRM","UPST","RIVN","LCID","NIO","XPEV","LI","F","GM","BA","CAT","DE","GE","HON","UNP","JPM","BAC","GS","MS","C","WFC","SCHW","V","MA","AXP","COF","BLK","LLY","UNH","JNJ","PFE","MRK","ABBV","BMY","MRNA","REGN","VRTX","GILD","AMGN","ISRG","DXCM","XOM","CVX","COP","OXY","SLB","HAL","MPC","WMT","COST","TGT","HD","LOW","NKE","SBUX","MCD","DIS","CMCSA","T","VZ","PG","KO","PEP","MARA","RIOT","MSTR","DKNG","CVNA","CHWY","RBLX","U","DASH","PINS","SNAP","SPOT","TTD","ENPH","FSLR","BABA","JD","PDD","MELI","SE","CMG","LULU","ORLY","ROST","TJX","MMM","LMT","RTX","NOC","GD","UPS","FDX","CSX","NSC","EMR","ITW","PH","ETN","APD","LIN","SHW","ECL","NEM","FCX","NUE","STLD","DOW","DD","PPG","KMB","CL","GIS","K","HSY","STZ","MO","PM","EL","SYY","ADM","BG","CF","MOS","DVN","FANG","EOG","PSX","VLO","KMI","WMB","OKE","D","DUK","SO","NEE","AEP","EXC","SRE","PCG","ED","XEL","WEC","AWK","AMT","PLD","EQIX","CCI","PSA","O","SPG","DLR","AVB","EQR","VICI","WELL","ARE","BXP","HST","KIM","REG"];
const SYMSET = new Set(UNIVERSE);

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** One FINRA daily short-volume file, cached. Returns {SYM: {short, exempt, total}} or null. */
async function finraDay(yyyymmdd) {
  const cf = path.join(CACHE, yyyymmdd + ".json");
  if (fs.existsSync(cf)) { try { return JSON.parse(fs.readFileSync(cf, "utf8")); } catch {} }
  let txt = null;
  try {
    const r = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${yyyymmdd}.txt`, { signal: AbortSignal.timeout(30000) });
    if (r.ok) txt = await r.text();
  } catch {}
  if (!txt) { fs.writeFileSync(cf, "null"); return null; }          // cache the miss too (weekends/holidays)
  const out = {};
  for (const line of txt.trim().split(/\r?\n/).slice(1)) {
    const p = line.split("|");
    if (p.length < 5 || !SYMSET.has(p[1])) continue;
    const short = +p[2], exempt = +p[3], total = +p[4];
    if (!(total > 0) || !Number.isFinite(short)) continue;
    out[p[1]] = { short, exempt: Number.isFinite(exempt) ? exempt : 0, total };
  }
  fs.writeFileSync(cf, JSON.stringify(out));
  return out;
}

async function bars(sym) {
  const start = new Date(Date.now() - (DAYS + 400) * 86400000).toISOString().slice(0, 10);
  const out = []; let tok = null;
  do {
    const p = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED });
    if (tok) p.set("page_token", tok);
    let r; try { r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${p}`, { headers: AH }); } catch { break; }
    if (!r.ok) break;
    const j = await r.json();
    for (const b of (j.bars?.[sym] || [])) out.push({ d: (b.t || "").slice(0, 10), c: b.c });
    tok = j.next_page_token || null;
  } while (tok);
  return out;
}

(async () => {
  console.log(`\n  TRAIDS — STRUCTURAL TRAINING-DATA GENERATOR`);
  console.log(`  order-flow disclosure, not chart shapes · ${UNIVERSE.length} names · ~${DAYS} sessions`);
  console.log(`  publication lag honoured: file for session t is only actionable from t+1\n`);
  fs.mkdirSync(CACHE, { recursive: true });

  // ── 1. pull the FINRA daily series ──────────────────────────────────────────
  const dayKeys = [];
  for (let k = 0; k < DAYS + 60; k++) {
    const dt = new Date(Date.now() - k * 86400000);
    const dow = dt.getUTCDay(); if (dow === 0 || dow === 6) continue;
    dayKeys.push(dt.toISOString().slice(0, 10).replace(/-/g, ""));
  }
  dayKeys.reverse();
  process.stdout.write(`  fetching ${dayKeys.length} FINRA files`);
  const byDay = new Map();
  let got = 0, hit = 0;
  for (const k of dayKeys) {
    const cached = fs.existsSync(path.join(CACHE, k + ".json"));
    const d = await finraDay(k);
    if (cached) hit++; else await sleep(90);
    if (d && Object.keys(d).length) { byDay.set(`${k.slice(0,4)}-${k.slice(4,6)}-${k.slice(6,8)}`, d); got++; }
    if (got % 50 === 0 && !cached) process.stdout.write(".");
  }
  console.log(`\n  ${got} session files with data (${hit} from cache)\n`);
  const finraDates = [...byDay.keys()].sort();
  if (finraDates.length < 100) { console.error("  too few FINRA sessions — aborting."); process.exit(1); }
  console.log(`  FINRA window: ${finraDates[0]} → ${finraDates[finraDates.length - 1]}`);

  // ── 2. prices, incl. SPY for the market adjustment ──────────────────────────
  process.stdout.write("  fetching prices");
  const spyBars = await bars("SPY");
  const SPY = new Map(spyBars.map(b => [b.d, b.c]));
  const px = {};
  for (const s of UNIVERSE) { px[s] = new Map((await bars(s)).map(b => [b.d, b.c])); process.stdout.write("."); }
  console.log("");

  // ── 3. build per-symbol structural series, then rows ────────────────────────
  const rows = [];
  let skippedLag = 0;
  for (const sym of UNIVERSE) {
    // svr(t) for every session the symbol appears in
    const svr = [], dates = [];
    for (const d of finraDates) {
      const rec = byDay.get(d)?.[sym];
      if (!rec) continue;
      dates.push(d);
      svr.push({ d, svr: rec.short / rec.total, exempt: rec.exempt / Math.max(1, rec.short), total: rec.total });
    }
    if (svr.length < PCT_WIN + Math.max(...HORIZONS) + 5) continue;

    for (let i = PCT_WIN; i < svr.length; i++) {
      const hist = svr.slice(i - Z_WIN, i).map(x => x.svr);          // strictly BEFORE i
      const m = mean(hist), s = sd(hist);
      if (m == null || !(s > 0)) continue;
      const long = svr.slice(Math.max(0, i - PCT_WIN), i).map(x => x.svr);
      const volHist = svr.slice(Math.max(0, i - PCT_WIN), i).map(x => x.total);

      // ── THE LAG. The file for session i publishes after that close, so the earliest
      // actionable price is the NEXT session's close. Everything forward starts there.
      const fileDate = svr[i].d;
      const iNext = dates.indexOf(fileDate) + 1;
      const entryDate = svr[iNext]?.d;
      if (!entryDate) { skippedLag++; continue; }
      const p0 = px[sym].get(entryDate), spy0 = SPY.get(entryDate);
      if (!(p0 > 0) || !(spy0 > 0)) { skippedLag++; continue; }

      const f = {
        svr: svr[i].svr,
        svrZ: (svr[i].svr - m) / s,
        svrPctile: long.length > 50 ? long.filter(v => v <= svr[i].svr).length / long.length : null,
        svrChg5: i >= 5 ? svr[i].svr - svr[i - 5].svr : null,
        svrVol20: s,                                   // dispersion of the ratio itself
        exemptRatio: svr[i].exempt,                    // market-maker/arb share of the short flow
        volPctile: volHist.length > 50 ? volHist.filter(v => v <= svr[i].total).length / volHist.length : null,
      };
      if (Object.values(f).some(v => v == null || !Number.isFinite(v))) continue;

      // ── labels: market-adjusted forward returns from the entry close ────────
      const lab = {};
      let ok = true;
      for (const h of HORIZONS) {
        const iExit = iNext + h;
        const exitDate = svr[iExit]?.d;
        const p1 = exitDate ? px[sym].get(exitDate) : null, spy1 = exitDate ? SPY.get(exitDate) : null;
        if (!(p1 > 0) || !(spy1 > 0)) { ok = false; break; }
        lab["fwd" + h] = (p1 / p0 - 1) - (spy1 / spy0 - 1);   // excess of SPY over the SAME window
      }
      if (!ok) continue;

      rows.push({ sym, fileDate, entryDate, ...f, ...lab });
    }
    process.stdout.write(".");
  }
  console.log("");

  const dts = [...new Set(rows.map(r => r.entryDate))].sort();
  console.log(`\n  ${rows.length.toLocaleString()} labeled rows · ${new Set(rows.map(r => r.sym)).size} symbols · ${dts.length} sessions`);
  console.log(`  ${dts[0]} → ${dts[dts.length - 1]}   (${skippedLag.toLocaleString()} rows dropped for missing lag/price)`);
  console.log(`  features (ALL order-flow disclosure, none a chart shape): svr · svrZ · svrPctile · svrChg5 · svrVol20 · exemptRatio · volPctile`);
  console.log(`  labels: market-adjusted forward excess at ${HORIZONS.join(", ")} sessions`);

  fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    source: "FINRA CNMSshvol daily short-volume files + Alpaca adjusted daily bars",
    lagPolicy: "the FINRA file for session t publishes ~6pm ET after that close; entry is therefore the t+1 CLOSE and every label runs from there. No feature reads any file dated on or after its own entry date.",
    labelPolicy: "market-adjusted: forward return minus SPY over the identical window, so the model cannot learn beta and call it selection (the #28/#29 error).",
    universe: UNIVERSE.length, horizons: HORIZONS, rows,
  }));
  console.log(`\n  written: backend/data/structural-dataset.json\n`);
})();
