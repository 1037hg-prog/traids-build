// fetch.js — pulls daily bars from the home Yahoo proxy (:3002) and FRED CSVs; caches to ./data/
// usage: node fetch.js
const fs = require('fs'); const path = require('path');
const OUT = path.join(__dirname, 'data'); fs.mkdirSync(OUT, { recursive: true });
const YAHOO = ['QQQ','^NDX','SPY','^GSPC','SMH','SOXX','^SOX','HYG','LQD','^TNX','^IRX','RSP','^SPXEW',
  'XLB','XLE','XLF','XLI','XLK','XLP','XLU','XLV','XLY','VWEHX','VFITX','VUSTX'];
const FRED = ['BAA10Y','AAA10Y','DGS10','BAMLH0A0HYM2','TB3MS'];
(async () => {
  for (const s of YAHOO) {
    try {
      const r = await fetch(`http://localhost:3002/api/yahoo/${encodeURIComponent(s)}/history?days=15000&interval=1d`);
      const j = await r.json();
      if (!j.bars) { console.log(s, 'ERR', JSON.stringify(j).slice(0,120)); continue; }
      fs.writeFileSync(path.join(OUT, s.replace('^','_') + '.json'), JSON.stringify(j.bars.map(b => ({ d: b.date, c: b.close, a: b.adjClose }))));
      console.log(s.padEnd(8), j.count, j.bars[0]?.date, '->', j.bars.at(-1)?.date, j.degraded ? 'DEGRADED' : '');
    } catch (e) { console.log(s, 'FAIL', e.message); }
  }
  for (const id of FRED) {
    try {
      const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const t = await r.text();
      const rows = t.trim().split('\n').slice(1).map(l => l.split(',')).filter(x => x[1] && x[1] !== '.' && !isNaN(+x[1])).map(x => ({ d: x[0], v: +x[1] }));
      fs.writeFileSync(path.join(OUT, 'FRED_' + id + '.json'), JSON.stringify(rows));
      console.log(('FRED ' + id).padEnd(18), rows.length, rows[0]?.d, '->', rows.at(-1)?.d, 'http', r.status);
    } catch (e) { console.log('FRED', id, 'FAIL', e.message); }
  }
})();
