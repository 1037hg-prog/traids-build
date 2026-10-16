#!/usr/bin/env node
/**
 * TRAIDS — STRUCTURAL FORWARD COLLECTION (forward leg of test #52)
 *
 * DECLARED 2026-07-28. Model frozen the same day, fingerprint 688c617f4bcd2c72.
 *
 * WHAT THIS IS. Test #52 tested whether FINRA short-volume disclosure predicts 20-session
 * market-adjusted excess returns. It returned NOT-ESTABLISHED: 20d AUC 0.5118 against a
 * shuffled control of 0.4991, decile spread +1.25% per 20 sessions, and a session-clustered
 * t of 2.39 that collapsed to 1.06 once corrected for the 19/20 window overlap. All three
 * pre-registered gates failed.
 *
 * This collects the same specification FORWARD, where no overlap correction is needed because
 * formations are recorded before their outcomes exist.
 *
 * ── THE MODEL IS FROZEN AND WILL NOT BE REFIT ──────────────────────────────────────────────
 * Coefficients, feature list, and the standardisation moments were fit ONCE on all 61,885
 * historical rows and written to structural-spec-frozen.json with a fingerprint. Every run
 * verifies that fingerprint and REFUSES to score if it has changed. Refitting mid-flight would
 * make this a rolling in-sample exercise wearing the word "forward".
 *
 * ── HOW LONG THIS HONESTLY TAKES, stated before collection starts ──────────────────────────
 * At the effect size actually observed (0.993% per non-overlapping formation, sd 3.239%):
 *     t = 2.0 needs  43 formations = 860 sessions  ~ 3.4 years
 *     t = 2.5 needs  67 formations = 1340 sessions ~ 5.3 years
 * That is the real cost of confirming a weak effect without cheating, and it is written here
 * so nobody is surprised in 2028. If the effect is real it is also economically meaningful —
 * ~1% per 20 sessions across ~12.6 formations a year is ~12.5%/yr gross on a long-short decile
 * book, a per-formation ratio near 0.31 which annualises close to 1.09. The problem is not that
 * the effect would be small. It is that it cannot be distinguished from zero quickly.
 *
 * ── OVERLAP, HANDLED BY DESIGN THIS TIME ───────────────────────────────────────────────────
 * Formations are recorded EVERY session, because recording is free and the daily series is
 * useful context. But the PRIMARY adjudication uses only NON-OVERLAPPING formations — every
 * 20th session — so the observations are genuinely independent and no Newey-West rescue is
 * needed. The overlapping series is reported as secondary, always with its lag-19 correction
 * attached, so the two can never be confused again.
 *
 * DECISION RULE — fixed now
 *   CONFIRMED       non-overlapping mean spread > 0 with t >= 2.0 at n >= 43 formations.
 *                   2.0 rather than 2.5 because this is now ONE pre-specified hypothesis being
 *                   confirmed, not a family being searched. The search already happened in #52
 *                   and paid its multiplicity there.
 *   REFUTED         non-overlapping mean spread <= 0 at n >= 43.
 *   COLLECTING      otherwise. Expected to read COLLECTING until roughly 2029.
 *
 * NOTHING HERE TRADES. It records what the frozen model would have selected. Even a CONFIRMED
 * verdict licenses a cost-and-capacity study, never an order — test #35 found a real signal in
 * this exact data family that was unharvestable at daily turnover, and nothing here models a fill.
 *
 * Usage:  node backend/structural-forward.js            (daily, after ~6:30pm ET)
 *         node backend/structural-forward.js --status   (read only, no write)
 */
const fs = require("fs"), path = require("path");
const crypto = require("crypto");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
const AH = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const D = (f) => path.join(__dirname, "data", f);
const SPEC_PATH = D("structural-spec-frozen.json");
const STORE = D("structural-forward.json");
const CACHE = D("finra-cache");
const HORIZON = 20, DECILE = 0.10, TARGET_N = 43, T_BAR = 2.0;
const STATUS_ONLY = process.argv.includes("--status");

const UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","CRM","ADBE","AVGO","INTC","QCOM","MU","TXN","ORCL","CSCO","IBM","NOW","SNOW","PLTR","SHOP","UBER","ABNB","COIN","PYPL","ROKU","ZM","DOCU","DDOG","NET","CRWD","ZS","OKTA","MDB","TWLO","TEAM","WDAY","PANW","FTNT","MRVL","ON","SMCI","ARM","DELL","HPQ","WDC","STX","ANET","KLAC","LRCX","AMAT","ASML","TSM","SOFI","HOOD","AFRM","UPST","RIVN","LCID","NIO","XPEV","LI","F","GM","BA","CAT","DE","GE","HON","UNP","JPM","BAC","GS","MS","C","WFC","SCHW","V","MA","AXP","COF","BLK","LLY","UNH","JNJ","PFE","MRK","ABBV","BMY","MRNA","REGN","VRTX","GILD","AMGN","ISRG","DXCM","XOM","CVX","COP","OXY","SLB","HAL","MPC","WMT","COST","TGT","HD","LOW","NKE","SBUX","MCD","DIS","CMCSA","T","VZ","PG","KO","PEP","MARA","RIOT","MSTR","DKNG","CVNA","CHWY","RBLX","U","DASH","PINS","SNAP","SPOT","TTD","ENPH","FSLR","BABA","JD","PDD","MELI","SE","CMG","LULU","ORLY","ROST","TJX","MMM","LMT","RTX","NOC","GD","UPS","FDX","CSX","NSC","EMR","ITW","PH","ETN","APD","LIN","SHW","ECL","NEM","FCX","NUE","STLD","DOW","DD","PPG","KMB","CL","GIS","K","HSY","STZ","MO","PM","EL","SYY","ADM","BG","CF","MOS","DVN","FANG","EOG","PSX","VLO","KMI","WMB","OKE","D","DUK","SO","NEE","AEP","EXC","SRE","PCG","ED","XEL","WEC","AWK","AMT","PLD","EQIX","CCI","PSA","O","SPG","DLR","AVB","EQR","VICI","WELL","ARE","BXP","HST","KIM","REG"];
const SYMSET = new Set(UNIVERSE);
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function finraDay(yyyymmdd) {
  const cf = path.join(CACHE, yyyymmdd + ".json");
  if (fs.existsSync(cf)) { try { return JSON.parse(fs.readFileSync(cf, "utf8")); } catch {} }
  let txt = null;
  try { const r = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${yyyymmdd}.txt`, { signal: AbortSignal.timeout(30000) }); if (r.ok) txt = await r.text(); } catch {}
  if (!txt) { fs.writeFileSync(cf, "null"); return null; }
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
async function bars(sym, days) {
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
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
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
  const fp = crypto.createHash("sha256").update(JSON.stringify({ w: spec.weights, b: spec.intercept, mu: spec.mu, sg: spec.sg })).digest("hex").slice(0, 16);
  console.log(`\n  TRAIDS — STRUCTURAL FORWARD COLLECTION (test #52 forward leg)`);
  console.log(`  spec frozen ${spec.frozen} · fingerprint ${spec.fingerprint}`);
  if (fp !== spec.fingerprint) {
    console.log(`\n  REFUSING TO SCORE — the frozen model has been altered.`);
    console.log(`  recomputed ${fp} vs declared ${spec.fingerprint}. A refit mid-flight would turn this`);
    console.log(`  into a rolling in-sample exercise wearing the word "forward".\n`);
    process.exit(2);
  }
  console.log(`  fingerprint verified — model intact\n`);

  const store = (() => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return { declared: "2026-07-28", specFingerprint: spec.fingerprint, formations: [] }; } })();

  if (!STATUS_ONLY) {
    // ── build today's formation from the newest published FINRA file ───────────
    const keys = [];
    for (let k = 0; k < 400; k++) { const dt = new Date(Date.now() - k * 86400000); const dw = dt.getUTCDay(); if (dw === 0 || dw === 6) continue; keys.push(dt.toISOString().slice(0, 10).replace(/-/g, "")); }
    keys.reverse();
    const series = new Map();
    for (const k of keys) { const d = await finraDay(k); if (d && Object.keys(d).length) series.set(`${k.slice(0,4)}-${k.slice(4,6)}-${k.slice(6,8)}`, d); }
    const dates = [...series.keys()].sort();
    const fileDate = dates[dates.length - 1];
    if (store.formations.some(f => f.fileDate === fileDate)) {
      console.log(`  already recorded a formation for FINRA file ${fileDate} — append-only, nothing written.`);
    } else if (dates.length < 260) {
      console.log(`  only ${dates.length} FINRA sessions cached — need 260 for the trailing windows. Nothing written.`);
    } else {
      const i = dates.length - 1;
      const picks = [];
      for (const sym of UNIVERSE) {
        const hist = [], vols = [];
        for (let k = Math.max(0, i - 250); k <= i; k++) { const r = series.get(dates[k])?.[sym]; if (r) { hist.push({ d: dates[k], svr: r.short / r.total, exempt: r.exempt / Math.max(1, r.short), total: r.total }); } }
        if (hist.length < 200 || hist[hist.length - 1].d !== fileDate) continue;
        const cur = hist[hist.length - 1];
        const win = hist.slice(-21, -1).map(x => x.svr);
        const m = mean(win), s = sd(win);
        if (m == null || !(s > 0)) continue;
        const long = hist.slice(0, -1).map(x => x.svr), lv = hist.slice(0, -1).map(x => x.total);
        const back5 = hist[hist.length - 6];
        const f = { svr: cur.svr, svrZ: (cur.svr - m) / s,
          svrPctile: long.filter(v => v <= cur.svr).length / long.length,
          svrChg5: back5 ? cur.svr - back5.svr : null, svrVol20: s,
          exemptRatio: cur.exempt, volPctile: lv.filter(v => v <= cur.total).length / lv.length };
        if (Object.values(f).some(v => v == null || !Number.isFinite(v))) continue;
        let z = spec.intercept;
        spec.features.forEach((k2, j) => { z += spec.weights[j] * ((f[k2] - spec.mu[k2]) / spec.sg[k2]); });
        picks.push({ sym, score: z });
      }
      if (picks.length < 100) console.log(`  only ${picks.length} scorable names — below the 100 needed for deciles. Nothing written.`);
      else {
        picks.sort((a, b) => a.score - b.score);
        const k = Math.max(1, Math.floor(picks.length * DECILE));
        const rec = { fileDate, recordedAt: new Date().toISOString(), n: picks.length,
          long: picks.slice(-k).map(p => p.sym), short: picks.slice(0, k).map(p => p.sym),
          resolved: false };
        store.formations.push(rec);
        console.log(`  formation recorded for ${fileDate}: ${picks.length} names scored · long ${rec.long.length} / short ${rec.short.length}`);
        console.log(`     long  ${rec.long.slice(0, 8).join(" ")}${rec.long.length > 8 ? " …" : ""}`);
        console.log(`     short ${rec.short.slice(0, 8).join(" ")}${rec.short.length > 8 ? " …" : ""}`);
      }
    }

    // ── resolve any formation that has aged HORIZON sessions ──────────────────
    const unresolved = store.formations.filter(f => !f.resolved);
    if (unresolved.length) {
      const spy = await bars("SPY", 400);
      const SPY = new Map(spy.map(b => [b.d, b.c]));
      const tradingDays = spy.map(b => b.d);
      const need = new Set(unresolved.flatMap(f => [...f.long, ...f.short]));
      const px = {};
      for (const s of need) { px[s] = new Map((await bars(s, 400)).map(b => [b.d, b.c])); await sleep(30); }
      let done = 0;
      for (const f of unresolved) {
        const i0 = tradingDays.findIndex(d => d > f.fileDate);        // entry = next session close
        if (i0 < 0 || i0 + HORIZON >= tradingDays.length) continue;
        const dEntry = tradingDays[i0], dExit = tradingDays[i0 + HORIZON];
        const ex = (sym) => { const a = px[sym]?.get(dEntry), b = px[sym]?.get(dExit); return (a > 0 && b > 0) ? (b / a - 1) : null; };
        const mkt = (SPY.get(dExit) / SPY.get(dEntry)) - 1;
        const L = f.long.map(ex).filter(Number.isFinite), S = f.short.map(ex).filter(Number.isFinite);
        if (L.length < f.long.length * 0.8 || S.length < f.short.length * 0.8) continue;
        f.resolved = true; f.entryDate = dEntry; f.exitDate = dExit;
        f.longExcess = mean(L) - mkt; f.shortExcess = mean(S) - mkt;
        f.spread = f.longExcess - f.shortExcess;
        done++;
      }
      if (done) console.log(`  resolved ${done} formation(s) that reached ${HORIZON} sessions`);
    }
    fs.writeFileSync(STORE, JSON.stringify(store, null, 1));
  }

  // ── report ────────────────────────────────────────────────────────────────
  const res = store.formations.filter(f => f.resolved);
  const all = store.formations;
  console.log(`\n  ${all.length} formation(s) recorded · ${res.length} resolved · ${all.length - res.length} still maturing`);
  if (!res.length) { console.log(`  first resolutions arrive ${HORIZON} sessions after the first formation.\n`); return; }

  // PRIMARY: non-overlapping only — every HORIZON-th resolved formation
  const sorted = res.slice().sort((a, b) => a.fileDate.localeCompare(b.fileDate));
  const nonOv = [];
  let lastIdx = -Infinity;
  sorted.forEach((f, idx) => { if (idx - lastIdx >= HORIZON) { nonOv.push(f); lastIdx = idx; } });
  const sp = nonOv.map(f => f.spread), m = mean(sp), s = sd(sp);
  const t = (m != null && s && sp.length > 2) ? m / (s / Math.sqrt(sp.length)) : null;
  console.log(`\n  PRIMARY — non-overlapping formations (independent by construction, no correction needed)`);
  console.log(`    n=${sp.length}/${TARGET_N}   mean spread ${m == null ? "—" : (m >= 0 ? "+" : "") + (100 * m).toFixed(3) + "%"}   t ${t == null ? "—" : t.toFixed(2)}`);
  const overlapT = (() => { const a = res.map(f => f.spread); const mm = mean(a), ss = sd(a); return (mm != null && ss && a.length > 2) ? mm / (ss / Math.sqrt(a.length)) : null; })();
  console.log(`  SECONDARY — all resolved formations, OVERLAPPING (context only; its t is inflated by ~sqrt(${HORIZON}))`);
  console.log(`    n=${res.length}   mean ${(100 * mean(res.map(f => f.spread))).toFixed(3)}%   naive t ${overlapT == null ? "—" : overlapT.toFixed(2)}`);

  const verdict = sp.length < TARGET_N ? `COLLECTING — ${TARGET_N - sp.length} more non-overlapping formations needed (~${(((TARGET_N - sp.length) * HORIZON) / 252).toFixed(1)} years). Expected to read this until roughly 2029.`
    : (m > 0 && t >= T_BAR) ? `CONFIRMED — licenses a cost-and-capacity study, NOT an order.`
      : (m <= 0) ? `REFUTED — the forward spread is not positive at n >= ${TARGET_N}.`
        : `NOT CONFIRMED — spread positive but t ${t.toFixed(2)} below the ${T_BAR} bar at n=${sp.length}.`;
  console.log(`\n  VERDICT: ${verdict}\n`);
})();
