// now.js — current trigger readings, as of the last completed session and the last month-end (read-only; cached data)
// usage: node now.js
const fs = require('fs');
const CUT = '2026-10-06';
const load = f => JSON.parse(fs.readFileSync(`${__dirname}/data/${f}.json`)).filter(r => r.d <= CUT);
const ser = (f, k = 'a') => load(f).map(r => ({ d: r.d, v: k === 'v' ? r.v : r[k] })).filter(r => r.v != null);
const last = s => s.at(-1);
const monthEnds = s => s.filter((r, i) => i === s.length - 1 ? false : r.d.slice(0, 7) !== s[i + 1].d.slice(0, 7));
const sma = (s, n) => s.slice(-n).reduce((a, r) => a + r.v, 0) / n;
const p = (x, d = 1) => (x * 100).toFixed(d);
function trend(name, s) {
  const me = monthEnds(s); const lastME = me.at(-1); const sma10 = sma(me, 10); const sma200 = sma(s, 200); const L = last(s);
  let pk = s[0]; for (const r of s) if (r.v > pk.v) pk = r;
  // provisional 10-mo reading if the month ended today: replace the forming month with today's close
  const prov = [...me.slice(-9), L]; const smaProv = prov.reduce((a, r) => a + r.v, 0) / 10;
  console.log(`${name.padEnd(14)} ME ${lastME.d} ${lastME.v.toFixed(2)} vs 10-mo ${sma10.toFixed(2)} (${p(lastME.v / sma10 - 1)}%) ${lastME.v > sma10 ? 'IN ' : 'OUT'} | provisional ${L.d}: ${p(L.v / smaProv - 1)}% vs 10-mo | 200d ${sma200.toFixed(2)}: ${p(L.v / sma200 - 1)}% ${L.v > sma200 ? 'IN ' : 'OUT'} | from peak ${pk.d}: ${p(L.v / pk.v - 1)}%`);
  return { meAbove: lastME.v / sma10 - 1, dAbove: L.v / sma200 - 1 };
}
console.log(`=== CURRENT READINGS (last completed session ${CUT}; last month-end 2026-09-30) ===`);
console.log('-- (a)/(b) price trend (dividend-adjusted closes) --');
for (const s of ['QQQ', 'SPY', 'SMH', 'SOXX', 'RSP']) trend(s, ser(s));
console.log('-- (c) breadth: 9 original sector SPDRs --');
const SECT = ['XLB', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLU', 'XLV', 'XLY']; let c10 = 0, c200 = 0;
for (const s of SECT) { const x = ser(s); const me = monthEnds(x); const a10 = me.at(-1).v > sma(me, 10), a200 = last(x).v > sma(x, 200); c10 += a10; c200 += a200;
  console.log(`   ${s} ME vs 10-mo ${p(me.at(-1).v / sma(me, 10) - 1).padStart(6)}%  | vs 200d ${p(last(x).v / sma(x, 200) - 1).padStart(6)}%`); }
console.log(`   sectors above 10-mo (09-30): ${c10} of 9 (rule c1 IN needs >=5) | above 200d (${CUT}): ${c200} of 9 (rule c2 IN needs >=5)`);
function ratioRead(name, a, b) {
  const A = ser(a), B = new Map(ser(b).map(r => [r.d, r.v])); const R = A.filter(r => B.has(r.d)).map(r => ({ d: r.d, v: r.v / B.get(r.d) }));
  const me = monthEnds(R); const L = last(R); const yr = R[R.length - 253];
  console.log(`   ${name.padEnd(13)} ${L.v.toFixed(4)} | vs 200d ${p(L.v / sma(R, 200) - 1)}% ${L.v > sma(R, 200) ? 'IN ' : 'OUT'} | ME ${me.at(-1).d} vs 10-mo ${p(me.at(-1).v / sma(me, 10) - 1)}% ${me.at(-1).v > sma(me, 10) ? 'IN ' : 'OUT'} | 12m change ${p(L.v / yr.v - 1)}%`);
}
ratioRead('RSP/SPY', 'RSP', 'SPY');
console.log('-- (d) credit --');
ratioRead('HYG/LQD', 'HYG', 'LQD'); ratioRead('VWEHX/VFITX', 'VWEHX', 'VFITX');
for (const id of ['BAA10Y', 'BAMLH0A0HYM2']) { const x = ser('FRED_' + id, 'v'); const L = last(x); const m = sma(x, 200); const sorted = x.map(r => r.v).sort((a, b) => a - b);
  const pctile = sorted.filter(v => v <= L.v).length / sorted.length;
  console.log(`   ${id.padEnd(13)} ${L.d} ${L.v.toFixed(2)}pp vs 200d avg ${m.toFixed(2)} -> ${L.v > m ? 'widening (OUT)' : 'not widening (IN)'} | percentile of ${x[0].d}..: ${p(pctile, 0)}% | min ${sorted[0]} max ${sorted.at(-1)}`); }
console.log('-- (e) rates: FRED DGS10 --');
{ const x = ser('FRED_DGS10', 'v'); const L = last(x), ref = x[x.length - 253]; console.log(`   10y ${L.d} ${L.v.toFixed(2)}% vs ${ref.d} ${ref.v.toFixed(2)}% -> 12m change ${(L.v - ref.v >= 0 ? '+' : '') + ((L.v - ref.v) * 100).toFixed(0)}bp -> ${L.v - ref.v > 1 ? 'OUT' : 'IN'}`);
  // first date the rule flipped OUT in the current spell
  let i = x.length - 1; while (i > 252 && x[i].v - x[i - 252].v > 1) i--; console.log(`   current OUT spell began after ${x[i].d} (first OUT reading ${x[i + 1]?.d})`);
  // if the 10y stays at today's level, when does the 252-session-back reference rise above (today - 100bp)?
  const need = L.v - 1.0; let k = x.length - 252; let clearOn = null; for (let j = 0; j < 260 && k + j < x.length; j++) if (x[k + j].v > need) { clearOn = j; break; }
  console.log(`   if the 10y stayed at ${L.v.toFixed(2)}%, the rule clears when the year-ago 10y exceeds ${need.toFixed(2)}%: ${clearOn == null ? 'not within 12 months' : 'in ~' + clearOn + ' sessions (year-ago date ' + x[k + clearOn].d + ', ' + x[k + clearOn].v + '%)'}`);
  for (const [lab, back] of [['3m', 63], ['6m', 126], ['12m', 252], ['24m', 504]]) console.log(`   10y change ${lab}: ${((L.v - x[x.length - 1 - back].v) * 100).toFixed(0)}bp (from ${x[x.length - 1 - back].d} ${x[x.length - 1 - back].v}%)`);
}
