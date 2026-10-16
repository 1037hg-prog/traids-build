// flip-levels.cjs - month-end flip levels for the October 2026 month-end, rule = month-end value > mean of the last 10 month-end
// values INCLUDING the current one (book-etf-rebalancer.js:64; bust/triggers.js tenMonth). Flip level X* = mean of the 9 completed
// month-ends (Jan..Sep 2026). Inputs: ../bust/data/*.json (Yahoo :3002 adjClose 'a'), cut 2026-10-06.
const fs = require('fs'); const B = __dirname + '/../bust/data/'; const CUT = '2026-10-06';
const ld = s => JSON.parse(fs.readFileSync(B + s + '.json')).filter(r => r.d <= CUT && r.a != null).map(r => ({ d: r.d, v: r.a }));
const monthEnds = s => s.filter((r, i) => i < s.length - 1 && r.d.slice(0, 7) !== s[i + 1].d.slice(0, 7));
function flip(name, s) {
  const me = monthEnds(s).filter(r => r.d < '2026-10-01'); const last9 = me.slice(-9); const X = last9.reduce((a, r) => a + r.v, 0) / 9; const L = s.at(-1);
  const sma10_0930 = me.slice(-10).reduce((a, r) => a + r.v, 0) / 10;
  console.log(`${name.padEnd(12)} 9 month-ends ${last9[0].d}..${last9[8].d}: X* = ${X.toFixed(4)} | latest ${L.d} ${L.v.toFixed(4)} -> ${((X / L.v - 1) * 100).toFixed(2)}% to flip | 09-30 ME ${me.at(-1).v.toFixed(4)} vs its 10-mo SMA ${sma10_0930.toFixed(4)} = ${((me.at(-1).v / sma10_0930 - 1) * 100).toFixed(2)}% | latest vs 09-30 SMA ${((L.v / sma10_0930 - 1) * 100).toFixed(2)}%`);
}
for (const s of ['QQQ', 'SPY']) flip(s, ld(s));
const a = ld('VWEHX'), bm = new Map(ld('VFITX').map(r => [r.d, r.v]));
const R = a.filter(r => bm.has(r.d)).map(r => ({ d: r.d, v: r.v / bm.get(r.d) }));
flip('VWEHX/VFITX', R);
console.log(`last VWEHX bar ${a.at(-1).d}; last VFITX bar ${[...bm.keys()].at(-1)}`);
