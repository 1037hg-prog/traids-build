// oas.js — recent path of the clean credit spreads (FRED; HY OAS is only served for the last 3 years) and the 10y
// usage: node oas.js
const fs = require('fs'); const ld = id => JSON.parse(fs.readFileSync(`${__dirname}/data/FRED_${id}.json`));
const hy = ld('BAMLH0A0HYM2'), baa = ld('BAA10Y'), t = ld('DGS10');
const at = (s, d) => { let v = null; for (const r of s) { if (r.d > d) break; v = r; } return v; };
const ends = []; for (let y = 2025, m = 6; y < 2026 || m <= 10; m++) { if (m > 12) { m = 1; y++; } ends.push(`${y}-${String(m).padStart(2, '0')}-31`); if (y === 2026 && m === 10) break; }
console.log('month-end   HY OAS   Baa-10y   10y');
for (const d of ends) { const a = at(hy, d), b = at(baa, d), c = at(t, d); console.log(a.d, String(a.v).padStart(7), String(b.v).padStart(9), String(c.v).padStart(6)); }
const last = hy.at(-1); const y1 = hy.filter(r => r.d >= '2025-10-05'); const mn = y1.reduce((a, r) => r.v < a.v ? r : a);
console.log(`HY OAS ${last.d} ${last.v} | 12m low ${mn.v} on ${mn.d} | change from low +${((last.v - mn.v) * 100).toFixed(0)}bp`);
