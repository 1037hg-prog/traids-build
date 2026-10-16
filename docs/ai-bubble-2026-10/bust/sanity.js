// sanity.js — prints start/end close+adj and CAGR (price vs adj) for each cached series, and checks for gaps / spikes
const fs = require('fs');
for (const f of fs.readdirSync('data')) {
  const x = JSON.parse(fs.readFileSync('data/' + f));
  if (f.startsWith('FRED')) { const v = x.map(r => r.v); console.log(f.padEnd(24), x[0].d, x[0].v, x.at(-1).d, x.at(-1).v, 'min', Math.min(...v), 'max', Math.max(...v)); continue; }
  const a = x[0], b = x.at(-1); const yrs = (new Date(b.d) - new Date(a.d)) / 3.156e10;
  let big = 0, gap = 0; for (let i = 1; i < x.length; i++) { const r = x[i].a / x[i - 1].a - 1; if (Math.abs(r) > 0.25) big++; if ((new Date(x[i].d) - new Date(x[i - 1].d)) / 864e5 > 6) gap++; }
  console.log(f.padEnd(24), a.d, 'c', a.c, 'a', a.a, '|', b.d, 'c', b.c, 'a', b.a, '| CAGR px', ((b.c / a.c) ** (1 / yrs) - 1).toFixed(4), 'adj', ((b.a / a.a) ** (1 / yrs) - 1).toFixed(4), '| >25% day moves', big, 'gaps>6d', gap);
}
