// precedent.cjs - QQQ adj close 1999-11-30 -> 2000-03-27 (the "+60.2%" claim) and exact 200d-band distances at 10-06.
// inputs: ../bust/data/{QQQ,SPY,SMH}.json (Yahoo :3002 adjClose cached by bust/fetch.js), cut 2026-10-06
const fs = require('fs'); const B = __dirname + '/../bust/data/';
const ld = s => JSON.parse(fs.readFileSync(B + s + '.json')).filter(r => r.d <= '2026-10-06' && r.a != null);
const q = ld('QQQ'); const at = d => q.find(r => r.d === d);
const a = at('1999-11-30'), b = at('2000-03-27');
console.log(`QQQ adj ${a.d} ${a.a} -> ${b.d} ${b.a} = ${((b.a / a.a - 1) * 100).toFixed(1)}%`);
for (const s of ['QQQ', 'SPY', 'SMH']) { const x = ld(s); const L = x.at(-1); const sma = x.slice(-200).reduce((t, r) => t + r.a, 0) / 200;
  console.log(`${s} ${L.d} close ${L.a} 200d ${sma.toFixed(2)} -> SMA/close-1 ${((sma / L.a - 1) * 100).toFixed(2)}% ; band exit 0.98*SMA ${(0.98 * sma).toFixed(2)} -> ${((0.98 * sma / L.a - 1) * 100).toFixed(2)}% ; band re-entry 1.02*SMA ${(1.02 * sma).toFixed(2)}`); }
