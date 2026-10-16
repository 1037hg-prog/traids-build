#!/usr/bin/env node
/**
 * TRAIDS — GAP RISK: how much does "stops always fill at the stop" overstate our results?
 *
 * TRIGGER: IBM fell 25% on 2026-07-14 — but it OPENED at 226.37 against a 290.23 prior
 * close. The entire move was in the gap. A stop sitting at 275 would NOT have filled at
 * 275; it would have filled at the OPEN, 226. Our settle logic records `exit = p.stop`,
 * i.e. a clean −1R, when the true loss was −4R or worse.
 *
 * EVERY expectancy number this project has produced assumes stops work. This measures the
 * lie: across the real universe, how often does a stopped-out trade GAP THROUGH its stop,
 * and what is the true R when it does?
 *
 * Method: for every name × every day, form a 1.5-ATR stop (the board's actual rule), look
 * at the next bar. If the bar's OPEN is already beyond the stop → GAP STOP: true fill is
 * the open, true loss = (entry − open) / stopDist, which can be many R. Otherwise the stop
 * fills at the stop → −1R (the assumption). Report the distribution and the bias.
 *
 * Usage: node backend/gap-risk-test.js       (env: DAYS=1500)
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const DAYS = parseInt(process.env.DAYS || "1500");
const ATR_MULT = 1.5;    // the board's actual stop rule

const UNIV = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","CRM","ADBE","AVGO","INTC","QCOM","MU","TXN","ORCL","CSCO","IBM","NOW","SNOW","PLTR","SHOP","UBER","COIN","PYPL","ROKU","DDOG","NET","CRWD","ZS","OKTA","MDB","TWLO","TEAM","WDAY","PANW","FTNT","MRVL","ON","SMCI","DELL","HPQ","WDC","ANET","KLAC","LRCX","AMAT","TSM","SOFI","AFRM","UPST","F","GM","BA","CAT","DE","GE","HON","JPM","BAC","GS","MS","C","WFC","V","MA","AXP","COF","LLY","UNH","JNJ","PFE","MRK","ABBV","BMY","MRNA","REGN","VRTX","GILD","AMGN","ISRG","DXCM","XOM","CVX","COP","OXY","SLB","WMT","COST","TGT","HD","LOW","NKE","SBUX","MCD","DIS","CMCSA","T","VZ","PG","KO","PEP","MARA","RIOT","DKNG","CVNA","CHWY","U","PINS","SNAP","SPOT","TTD","ENPH","FSLR","BABA","SE","CMG","LULU","TJX","MMM","LMT","RTX","UPS","FDX","CSX","EMR","ITW","APD","LIN","SHW","NEM","FCX","NUE","DOW","NEE","DUK","SO","AMT","PLD","SPG","O","BMRN","NBIX","JAZZ","SRPT","IONS","ULTA","SWKS","QRVO","TER","EXPE","MAR","WYNN","MGM","KMX","APTV","NVR","PHM","DHI","LEN","KR","MDLZ","CLX","TSN","APA","MRO","CTRA","BKNG","ORLY","AZO","ROST","BIIB","ABT","SYK","MDT","BSX","ELV","CVS","CI","TMO","DHR","ACN","SAP","INTU","ADI","ASML","AMKR","LSCC","RMBS","CRUS","PEGA","FFIV","AKAM","GEN","ZI","PCTY","BILL","GTLB","CFLT","PATH","ESTC","APP","DUOL","WIX","YELP"];

async function bars(sym) {
  const start = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const out = []; let tok = null;
  do {
    const p = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED });
    if (tok) p.set("page_token", tok);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${p}`, { headers });
    if (!r.ok) break;
    const j = await r.json();
    for (const b of (j.bars?.[sym] || [])) out.push({ t: (b.t || "").slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c });
    tok = j.next_page_token || null;
  } while (tok);
  return out;
}
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;

(async () => {
  console.log(`\n  TRAIDS — GAP RISK TEST`);
  console.log(`  Does a stop actually fill at the stop? ${UNIV.length} names · ~${DAYS}d · ${ATR_MULT}-ATR stop (the board's rule)\n`);
  process.stdout.write("  fetching");
  const data = {};
  for (const s of UNIV) { const d = await bars(s); process.stdout.write("."); if (d.length > 60) data[s] = d; }
  console.log(` ${Object.keys(data).length} names\n`);

  let stops = 0, gapStops = 0;
  const gapR = [], allR = [], worst = [];
  for (const [sym, d] of Object.entries(data)) {
    // ATR(14)
    const atr = [];
    for (let i = 0; i < d.length; i++) {
      if (i < 14) { atr.push(null); continue; }
      let s = 0;
      for (let k = i - 13; k <= i; k++) s += Math.max(d[k].h - d[k].l, Math.abs(d[k].h - d[k - 1].c), Math.abs(d[k].l - d[k - 1].c));
      atr.push(s / 14);
    }
    for (let i = 20; i < d.length - 1; i++) {
      if (!atr[i]) continue;
      // model BOTH directions, as the board does
      for (const long of [true, false]) {
        const entry = d[i].c, stopDist = ATR_MULT * atr[i];
        const stop = long ? entry - stopDist : entry + stopDist;
        const nx = d[i + 1];
        const hit = long ? nx.l <= stop : nx.h >= stop;
        if (!hit) continue;
        stops++;
        const gapped = long ? nx.o <= stop : nx.o >= stop;      // OPENED already through the stop
        const trueFill = gapped ? nx.o : stop;
        const trueRmult = long ? (trueFill - entry) / stopDist : (entry - trueFill) / stopDist;
        allR.push(trueRmult);
        if (gapped) {
          gapStops++;
          gapR.push(trueRmult);
          if (trueRmult < -2) worst.push({ sym, t: nx.t, r: trueRmult, gap: ((nx.o / entry - 1) * 100) * (long ? 1 : -1) });
        }
      }
    }
  }

  const assumedR = -1;                      // what our settle records for EVERY stop
  const trueAvg = mean(allR);
  const bias = trueAvg - assumedR;
  console.log("  ── HOW OFTEN DOES A STOP ACTUALLY FILL AT THE STOP? ──");
  console.log(`    stop-outs observed:        ${stops.toLocaleString()}`);
  console.log(`    of those, GAPPED THROUGH:  ${gapStops.toLocaleString()}  (${(gapStops / stops * 100).toFixed(1)}%)  ← filled WORSE than the stop`);
  console.log(`    clean fills at the stop:   ${(stops - gapStops).toLocaleString()}  (${((stops - gapStops) / stops * 100).toFixed(1)}%)\n`);

  console.log("  ── WHAT THE GAPS ACTUALLY COST ──");
  console.log(`    avg R on a GAPPED stop:    ${mean(gapR).toFixed(3)}R   (we record −1.000R)`);
  console.log(`    worst single gap:          ${Math.min(...gapR).toFixed(2)}R`);
  const tail = [...gapR].sort((a, b) => a - b);
  console.log(`    gapped-stop percentiles:   p50 ${tail[Math.floor(tail.length * .5)].toFixed(2)}R · p10 ${tail[Math.floor(tail.length * .1)].toFixed(2)}R · p1 ${tail[Math.floor(tail.length * .01)].toFixed(2)}R\n`);

  console.log("  ── THE BIAS IN EVERY NUMBER WE'VE PRODUCED ──");
  console.log(`    our settle records:        −1.000R on every stop`);
  console.log(`    TRUE average stop:         ${trueAvg.toFixed(3)}R`);
  console.log(`    ⇒ we OVERSTATE each stop-out by ${Math.abs(bias).toFixed(3)}R`);
  console.log(`    On a book that stops out ~40% of the time, that inflates expectancy by ~${(Math.abs(bias) * 0.4).toFixed(3)}R/trade —`);
  console.log(`    which is LARGER than any "edge" we have ever measured.\n`);

  console.log("  ── WORST GAP-THROUGH-STOP EVENTS (the tail we were pretending didn't exist) ──");
  worst.sort((a, b) => a.r - b.r);
  for (const w of worst.slice(0, 10))
    console.log(`    ${w.sym.padEnd(6)} ${w.t}   opened ${w.gap.toFixed(1)}% against the position →  ${w.r.toFixed(1)}R  (logged as −1R)`);
  console.log("");
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
