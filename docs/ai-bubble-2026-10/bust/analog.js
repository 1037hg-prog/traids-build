// analog.js — (1) every time the rates rule fired (10y up >100bp in 12m): what QQQ/SPY did next;
//             (2) month-end "state analogs" for today's mix (price trend IN, sector breadth <=4/9, 10y +100bp) and
//                 the forward 12-month QQQ return / max drawdown that followed. Descriptive only; overlapping windows.
// usage: node analog.js
const fs = require('fs'); const CUT = '2026-10-06';
const load = f => JSON.parse(fs.readFileSync(`${__dirname}/data/${f}.json`)).filter(r => r.d <= CUT);
const G = load('_GSPC'); const dates = G.map(r => r.d); const N = dates.length;
const align = (rows, k) => { const m = new Map(rows.map(r => [r.d, r[k]])); let l = null; return dates.map(d => { const v = m.get(d); if (v != null) l = v; return l; }); };
const Y = (s, k = 'a') => align(load(s), k);
function splice(pr, px) { const p = Y(pr), q = Y(px, 'c'); const s0 = p.findIndex(v => v != null); const L = p.slice(); for (let i = s0 - 1; i >= 0; i--) { if (q[i] == null) break; L[i] = L[i + 1] * q[i] / q[i + 1]; } return L; }
const QQQ = splice('QQQ', '_NDX'), SPY = splice('SPY', '_GSPC'); const d10 = align(load('FRED_DGS10'), 'v');
const p = x => x == null ? '  --' : (x * 100).toFixed(1);
const fwd = (L, i, n) => i + n < N ? L[i + n] / L[i] - 1 : null;
const fwdDD = (L, i, n) => { if (i + 1 >= N) return null; let pk = L[i], dd = 0; for (let k = i; k <= Math.min(N - 1, i + n); k++) { pk = Math.max(pk, L[k]); dd = Math.min(dd, L[k] / pk - 1); } return dd; };

// (1) rates-rule events: OUT readings clustered when separated by < 63 sessions
const out = dates.map((_, i) => i >= 252 && d10[i] != null && d10[i - 252] != null && d10[i] - d10[i - 252] > 1.0);
const ev = []; for (let i = 0; i < N; i++) if (out[i]) { if (ev.length && i - ev.at(-1).last < 63) ev.at(-1).last = i; else ev.push({ first: i, last: i }); }
console.log('=== (1) RATES RULE EVENTS: 10y up >100bp vs 252 sessions earlier (OUT readings < 63 sessions apart merged) ===');
console.log('first OUT    last OUT     10y then  12m chg | QQQ: 3m    6m   12m  maxDD12m | SPY: 12m maxDD12m | QQQ>10-mo at start?');
const me = dates.map((d, i) => i < N - 1 && d.slice(0, 7) !== dates[i + 1].slice(0, 7));
const above10 = i => { const idx = []; for (let k = i; k >= 0 && idx.length < 10; k--) if (me[k]) idx.push(k); if (idx.length < 10) return null; const s = idx.reduce((a, k) => a + QQQ[k], 0) / 10; return QQQ[idx[0]] > s; };
for (const e of ev) { const i = e.first;
  console.log(`${dates[i]}   ${dates[e.last]}   ${d10[i].toFixed(2)}%   +${((d10[i] - d10[i - 252]) * 100).toFixed(0)}bp | ${p(fwd(QQQ, i, 63)).padStart(5)} ${p(fwd(QQQ, i, 126)).padStart(5)} ${p(fwd(QQQ, i, 252)).padStart(5)} ${p(fwdDD(QQQ, i, 252)).padStart(8)} | ${p(fwd(SPY, i, 252)).padStart(5)} ${p(fwdDD(SPY, i, 252)).padStart(8)} | ${above10(i) ? 'yes' : 'no'}`); }
// unconditional comparison over the same span
{ const st = ev[0].first; const r12 = [], dd12 = []; for (let i = st; i + 252 < N; i += 21) { r12.push(fwd(QQQ, i, 252)); dd12.push(fwdDD(QQQ, i, 252)); }
  const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const evs = ev.filter(e => e.first + 252 < N);
  console.log(`events with a full 12m forward: ${evs.length}; median QQQ 12m ${p(med(evs.map(e => fwd(QQQ, e.first, 252))))}% / median maxDD12m ${p(med(evs.map(e => fwdDD(QQQ, e.first, 252))))}%; share with maxDD12m <= -15%: ${evs.filter(e => fwdDD(QQQ, e.first, 252) <= -0.15).length}/${evs.length}`);
  console.log(`unconditional (every 21st session from ${dates[st]}, n=${r12.length}): median QQQ 12m ${p(med(r12))}% / median maxDD12m ${p(med(dd12))}%; share maxDD12m <= -15%: ${p(dd12.filter(x => x <= -0.15).length / dd12.length)}%`); }

// (2) month-end state analogs since sector data (1999-10)
const SECT = ['XLB', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLU', 'XLV', 'XLY'].map(s => Y(s));
const MEi = []; for (let i = 0; i < N; i++) if (me[i]) MEi.push(i);
const rows = [];
MEi.forEach((i, j) => { if (j < 10) return; const win = MEi.slice(j - 9, j + 1); if (SECT.some(S => S[win[0]] == null)) return;
  const cnt = SECT.filter(S => S[i] > win.reduce((a, k) => a + S[k], 0) / 10).length;
  const qIn = QQQ[i] > win.reduce((a, k) => a + QQQ[k], 0) / 10;
  const rates = i >= 252 && d10[i] - d10[i - 252] > 1.0;
  rows.push({ i, d: dates[i], cnt, qIn, rates, r12: fwd(QQQ, i, 252), dd12: fwdDD(QQQ, i, 252) }); });
const summarize = (lab, rs) => { const f = rs.filter(r => r.r12 != null); const med = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
  // distinct episodes = runs of consecutive qualifying months
  let runs = 0, prev = -2; for (const r of rs) { const j = rows.indexOf(r); if (j !== prev + 1) runs++; prev = j; }
  console.log(`${lab.padEnd(58)} months ${String(rs.length).padStart(3)} (runs ${String(runs).padStart(2)}) | with 12m fwd ${String(f.length).padStart(3)}: median QQQ 12m ${p(med(f.map(r => r.r12))).padStart(5)}%  median maxDD12m ${p(med(f.map(r => r.dd12))).padStart(6)}%  share maxDD<=-15% ${p(f.length ? f.filter(r => r.dd12 <= -0.15).length / f.length : null).padStart(5)}%`); };
console.log(`\n=== (2) MONTH-END STATE ANALOGS ${rows[0].d}..${rows.at(-1).d} (QQQ = NDX-spliced adj; sectors = 9 SPDRs vs own 10-mo SMA) ===`);
summarize('all month-ends', rows);
summarize('QQQ above 10-mo', rows.filter(r => r.qIn));
summarize('QQQ above 10-mo AND sectors <=4/9 (narrow)', rows.filter(r => r.qIn && r.cnt <= 4));
summarize('QQQ above 10-mo AND 10y +100bp/12m', rows.filter(r => r.qIn && r.rates));
summarize('QQQ above 10-mo AND narrow AND 10y +100bp (= today)', rows.filter(r => r.qIn && r.cnt <= 4 && r.rates));
console.log('narrow-and-QQQ-IN months:', rows.filter(r => r.qIn && r.cnt <= 4).map(r => `${r.d.slice(0, 7)}(${r.cnt}${r.rates ? ',R' : ''})`).join(' '));
console.log('latest rows:', rows.slice(-4).map(r => `${r.d} cnt ${r.cnt} qIn ${r.qIn} rates ${r.rates}`).join(' | '));
