// Crypto vs Nasdaq-100 in drawdowns. READ-ONLY public market data via Alpaca data API (main paper keys from backend/.env, never printed).
// QQQ daily bars adjustment=all (total return); BTC/USD, ETH/USD daily bars (Alpaca crypto, UTC days).
// Weekly returns = last available close of each ISO week (Fri for QQQ; same calendar date for crypto).
const fs = require("fs"), path = require("path");
const ROOT = "C:/Users/joshc/Downloads/traids (2)/traids-bundle";
const env = {}; for (const l of fs.readFileSync(path.join(ROOT, "backend/.env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const H = { "APCA-API-KEY-ID": env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY };
const START = process.argv[2] || "2019-01-01";
async function pages(url, key) {
  let out = [], tok = null;
  do { const r = await (await fetch(url + (tok ? "&page_token=" + tok : ""), { headers: H })).json(); out = out.concat(key(r) || []); tok = r.next_page_token; } while (tok);
  return out;
}
(async () => {
  const q = await pages(`https://data.alpaca.markets/v2/stocks/QQQ/bars?timeframe=1Day&adjustment=all&feed=${env.ALPACA_FEED || "iex"}&start=${START}&limit=10000`, r => r.bars);
  const c = {};
  for (const s of ["BTC/USD", "ETH/USD"]) c[s] = await pages(`https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(s)}&timeframe=1Day&start=${START}&limit=10000`, r => r.bars && r.bars[s]);
  const day = b => b.t.slice(0, 10);
  const qm = new Map(q.map(b => [day(b), b.c])), bm = new Map(c["BTC/USD"].map(b => [day(b), b.c])), em = new Map(c["ETH/USD"].map(b => [day(b), b.c]));
  const dates = q.map(day).filter(d => bm.has(d) && em.has(d));
  console.log(`inputs: QQQ ${q.length} daily bars (${day(q[0])}..${day(q[q.length - 1])}, feed ${env.ALPACA_FEED || "iex"}, adjustment=all); BTC ${c["BTC/USD"].length} bars from ${day(c["BTC/USD"][0])}; ETH ${c["ETH/USD"].length} bars from ${day(c["ETH/USD"][0])}; common dates ${dates.length}`);
  // weekly: last common date per ISO week
  const wk = d => { const t = new Date(d + "T00:00:00Z"); const th = new Date(t); th.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7)); return th.toISOString().slice(0, 10); };
  const lastOfWeek = new Map(); for (const d of dates) lastOfWeek.set(wk(d), d);
  const W = [...lastOfWeek.values()];
  const R = []; for (let i = 1; i < W.length; i++) R.push({ d: W[i], q: qm.get(W[i]) / qm.get(W[i - 1]) - 1, b: bm.get(W[i]) / bm.get(W[i - 1]) - 1, e: em.get(W[i]) / em.get(W[i - 1]) - 1 });
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const corr = (x, y) => { const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
  const beta = (x, y) => { const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0; for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; } return sxy / sxx; };
  const f = (x, d = 2) => x.toFixed(d), p = x => (100 * x).toFixed(1) + "%";
  console.log(`\nweekly returns n=${R.length} (${R[0].d}..${R[R.length - 1].d})`);
  for (const [lab, set] of [["all weeks", R], ["QQQ down weeks", R.filter(r => r.q < 0)], ["QQQ worst 10% weeks", [...R].sort((a, b) => a.q - b.q).slice(0, Math.round(R.length / 10))], ["2022", R.filter(r => r.d.startsWith("2022"))], ["last 104 weeks", R.slice(-104)]]) {
    const xq = set.map(r => r.q);
    console.log(`${lab.padEnd(20)} n=${String(set.length).padStart(3)} | corr BTC ${f(corr(xq, set.map(r => r.b)))} ETH ${f(corr(xq, set.map(r => r.e)))} | beta BTC ${f(beta(xq, set.map(r => r.b)))} ETH ${f(beta(xq, set.map(r => r.e)))} | mean weekly QQQ ${p(mean(xq))} BTC ${p(mean(set.map(r => r.b)))} ETH ${p(mean(set.map(r => r.e)))}`);
  }
  // QQQ drawdown episodes >= 10% on daily closes: peak -> trough; crypto return over the same dates
  console.log(`\nQQQ drawdowns >= 10% (daily total-return closes, common dates) and crypto over the same peak->trough dates:`);
  let peak = dates[0], trough = dates[0], inDD = false;
  const eps = [];
  for (const d of dates) {
    if (qm.get(d) >= qm.get(peak)) { if (inDD) { eps.push([peak, trough]); inDD = false; } peak = d; trough = d; }
    else { if (qm.get(d) < qm.get(trough)) trough = d; if (qm.get(trough) / qm.get(peak) - 1 <= -0.10) inDD = true; }
  }
  if (inDD) eps.push([peak, trough]);
  console.log("peak | trough | QQQ | BTC | ETH");
  for (const [a, b] of eps) console.log(`${a} | ${b} | ${p(qm.get(b) / qm.get(a) - 1)} | ${p(bm.get(b) / bm.get(a) - 1)} | ${p(em.get(b) / em.get(a) - 1)}`);
  // crypto own max drawdown over the window
  const mdd = m => { let pk = -Infinity, dd = 0; for (const d of dates) { pk = Math.max(pk, m.get(d)); dd = Math.min(dd, m.get(d) / pk - 1); } return dd; };
  console.log(`\nmax drawdown on common dates: QQQ ${p(mdd(qm))}, BTC ${p(mdd(bm))}, ETH ${p(mdd(em))}`);
})();
