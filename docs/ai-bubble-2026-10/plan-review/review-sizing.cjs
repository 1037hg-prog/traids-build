// review-sizing.cjs - re-derivations for the 10-07 adversarial review of docs/ai-bubble-contingency-plan-2026-10-07.md
// input: ../ai-exposure/paper-positions.json (Alpaca PAPER GETs fetched 2026-10-07T16:20Z by fetch-paper.js); account labels only, no ids.
const j = require('../ai-exposure/paper-positions.json');
const f = x => '$' + Math.round(x).toLocaleString('en-US'); const p = (x, d = 1) => (x * 100).toFixed(d) + '%';
const LINKED = new Set(['MSTR', 'BMNR']);   // crypto-linked equities that classify.js puts in the CRYPTO bucket
let coins = 0, linked = 0, eqAll = 0; const lines = [];
for (const a of j.accounts) {
  const lab = ['main', 'book', 'tv'].includes(a.acct) ? a.acct : '?'; eqAll += +a.equity;
  const c = a.positions.filter(x => x.asset_class === 'crypto'), l = a.positions.filter(x => LINKED.has(x.symbol));
  const cs = c.reduce((t, x) => t + +x.market_value, 0), ls = l.reduce((t, x) => t + +x.market_value, 0); coins += cs; linked += ls;
  lines.push(`${lab}: coins (asset_class crypto, n=${c.length}) ${f(cs)}; crypto-linked equities ${l.map(x => x.symbol + ' ' + f(+x.market_value)).join(', ') || 'none'} = ${f(ls)}`);
  if (lab === 'book') { const g = s => +(a.positions.find(x => x.symbol === s) || { market_value: 0 }).market_value;
    lines.push(`book: QQQ ${f(g('QQQ'))} + SPY ${f(g('SPY'))} = ${f(g('QQQ') + g('SPY'))}; DBMF ${f(g('DBMF'))} = ${p(g('DBMF') / 73584)} of the Plan E sub-book $73,584 (paper-exposure.out.txt); JAAA ${f(g('JAAA'))}; SGOV ${f(g('SGOV'))}`); }
  if (lab === 'main') { const g = s => +(a.positions.find(x => x.symbol === s) || { market_value: 0 }).market_value; lines.push(`main: BTCUSD ${f(g('BTCUSD'))}, ETHUSD ${f(g('ETHUSD'))}`); }
}
lines.forEach(l => console.log(l));
console.log(`all 3: coins ${f(coins)} + crypto-linked equities ${f(linked)} = ${f(coins + linked)} (${p((coins + linked) / eqAll)} of ${f(eqAll)}); coins alone ${p(coins / eqAll)}`);
console.log(`2022 replay, coins only (BTC -60.2% .. ETH -62.1%, crypto-vs-nasdaq.out.txt): ${f(coins * 0.602)} .. ${f(coins * 0.621)}`);
console.log(`Plan E DBMF target weight = 15/73 = ${p(15 / 73)} (book-etf-rebalancer.js:42, rule "hold")`);
