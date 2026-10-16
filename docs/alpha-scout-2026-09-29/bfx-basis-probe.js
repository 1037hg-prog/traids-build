// Read-only probe: Bitfinex 1h candles, perp (tBTCF0:USTF0) vs spot (tBTCUSD), 2019-07 -> now.
// Counts hours where spot fell >= X% over the trailing 3h AND the perp closed below spot by >= Y bps,
// then reports forward 4h / 24h spot returns. A scout-side count only, not a registered read.
const fs = require("fs");
const OUT = __dirname + "/bfx-basis-probe.json";
async function hist(sym, start, end) {
  const rows = [];
  let s = start;
  while (s < end) {
    const u = `https://api-pub.bitfinex.com/v2/candles/trade:1h:${sym}/hist?start=${s}&end=${end}&limit=10000&sort=1`;
    const r = await fetch(u);
    if (!r.ok) { console.log("HTTP", r.status, sym); await new Promise(r => setTimeout(r, 3000)); continue; }
    const j = await r.json();
    if (!j.length) break;
    rows.push(...j);
    s = j[j.length - 1][0] + 1;
    await new Promise(r => setTimeout(r, 400));
  }
  return rows;
}
(async () => {
  const start = Date.UTC(2019, 6, 1), end = Date.now();
  const perp = await hist("tBTCF0:USTF0", start, end);
  const spot = await hist("tBTCUSD", start, end);
  console.log("rows perp", perp.length, "spot", spot.length);
  const P = new Map(perp.map(r => [r[0], r]));
  const S = spot.filter(r => P.has(r[0]));
  const res = {};
  for (const drop of [0.02, 0.03, 0.05]) for (const bps of [10, 20, 40]) {
    let n = 0, r4 = [], r24 = [], last = -1e15;
    for (let i = 3; i < S.length - 24; i++) {
      const t = S[i][0];
      const c = S[i][2], c3 = S[i - 3][2];
      const p = P.get(t)[2];
      const basis = (p - c) / c;
      if ((c / c3 - 1) <= -drop && basis <= -bps / 1e4 && t - last > 24 * 3600e3) {
        n++; last = t;
        r4.push(S[i + 4][2] / c - 1); r24.push(S[i + 24][2] / c - 1);
      }
    }
    const m = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
    const sd = a => { const mu = m(a); return Math.sqrt(a.reduce((x, y) => x + (y - mu) ** 2, 0) / Math.max(1, a.length - 1)); };
    const t = a => a.length > 1 ? m(a) / (sd(a) / Math.sqrt(a.length)) : 0;
    res[`drop${drop}_bps${bps}`] = { n, mean4h: +(m(r4) * 1e4).toFixed(1), t4h: +t(r4).toFixed(2), mean24h: +(m(r24) * 1e4).toFixed(1), t24h: +t(r24).toFixed(2) };
  }
  // unconditional: same drop, basis NOT dislocated (placebo)
  for (const drop of [0.03]) {
    let n = 0, r4 = [], r24 = [], last = -1e15;
    for (let i = 3; i < S.length - 24; i++) {
      const t = S[i][0]; const c = S[i][2], c3 = S[i - 3][2]; const p = P.get(t)[2]; const basis = (p - c) / c;
      if ((c / c3 - 1) <= -drop && basis > -10 / 1e4 && t - last > 24 * 3600e3) { n++; last = t; r4.push(S[i + 4][2] / c - 1); r24.push(S[i + 24][2] / c - 1); }
    }
    const m = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
    res[`placebo_drop${drop}_basisOK`] = { n, mean4h: +(m(r4) * 1e4).toFixed(1), mean24h: +(m(r24) * 1e4).toFixed(1) };
  }
  // basis distribution
  const b = S.map(r => (P.get(r[0])[2] - r[2]) / r[2]).sort((a, b) => a - b);
  res.basisPct = { p1: +(b[Math.floor(b.length * 0.01)] * 1e4).toFixed(1), p5: +(b[Math.floor(b.length * 0.05)] * 1e4).toFixed(1), p50: +(b[Math.floor(b.length * 0.5)] * 1e4).toFixed(1), p95: +(b[Math.floor(b.length * 0.95)] * 1e4).toFixed(1), p99: +(b[Math.floor(b.length * 0.99)] * 1e4).toFixed(1) };
  res.hours = S.length; res.first = new Date(S[0][0]).toISOString(); res.lastT = new Date(S[S.length - 1][0]).toISOString();
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
})().catch(e => console.log("ERR", e.message));
