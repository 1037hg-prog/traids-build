// sweep.js — (1) how much of each trigger's value comes from the two big busts (reads out-<ASSET>.json written by triggers.js);
//            (2) parameter sensitivity on QQQ (NDX-spliced) for the 10-month, 200-day, credit and rates rules.
// usage: node triggers.js QQQ && node sweep.js
const fs = require('fs'); const CUT = '2026-10-06', COST = 0.0005;
for (const A of ['QQQ', 'SPY']) {
  const o = JSON.parse(fs.readFileSync(`${__dirname}/out-${A}.json`));
  const big = o.episodes.filter(e => e.depth <= -0.45).map(e => e.peak);
  console.log(`=== (1) ${A}: mean cycle pp per episode, all live episodes vs excluding the two >45% busts (${big.join(', ')}) ===`);
  for (const s of o.signals) { const r = s.episodes.filter(Boolean); const ex = r.filter(q => !big.includes(q.peak));
    const m = a => a.length ? (a.reduce((t, q) => t + q.cyc, 0) / a.length * 100).toFixed(1) : '--';
    console.log(`  ${s.name.padEnd(32)} all n=${String(r.length).padStart(2)} ${m(r).padStart(6)} | ex-big n=${String(ex.length).padStart(2)} ${m(ex).padStart(6)} | ex-big episodes where it helped (cycle>0): ${ex.filter(q => q.cyc > 0).length}`); }
}
// (2) sensitivity
const load = f => JSON.parse(fs.readFileSync(`${__dirname}/data/${f}.json`)).filter(r => r.d <= CUT);
const G = load('_GSPC'); const dates = G.map(r => r.d); const N = dates.length;
const align = (rows, k) => { const m = new Map(rows.map(r => [r.d, r[k]])); let l = null; return dates.map(d => { const v = m.get(d); if (v != null) l = v; return l; }); };
const Y = (s, k = 'a') => align(load(s), k);
function splice(pr, px) { const p = Y(pr), q = Y(px, 'c'); const s0 = p.findIndex(v => v != null); const L = p.slice(); for (let i = s0 - 1; i >= 0; i--) { if (q[i] == null) break; L[i] = L[i + 1] * q[i] / q[i + 1]; } return L; }
const L = splice('QQQ', '_NDX'); const irx = Y('_IRX', 'c'); const cash = dates.map((_, i) => i && irx[i - 1] != null ? Math.max(irx[i - 1], 0) / 100 / 252 : 0);
const d10 = align(load('FRED_DGS10'), 'v'); const vw = Y('VWEHX'), vf = Y('VFITX'); const cr = vw.map((v, i) => v != null && vf[i] != null ? v / vf[i] : null);
const isME = dates.map((d, i) => i < N - 1 && d.slice(0, 7) !== dates[i + 1].slice(0, 7));
const sma = (a, i, n) => { let s = 0; for (let k = i - n + 1; k <= i; k++) { if (k < 0 || a[k] == null) return null; s += a[k]; } return s / n; };
const nMonth = (S, n) => { const out = new Array(N).fill(null), me = []; let cur = null; for (let i = 0; i < N; i++) { if (isME[i]) { me.push(i); if (me.length >= n && me.slice(-n).every(k => S[k] != null)) cur = S[i] > me.slice(-n).reduce((a, k) => a + S[k], 0) / n ? 1 : 0; } out[i] = cur; } return out; };
const nDay = (S, n) => S.map((v, i) => { const m = sma(S, i, n); return m == null || v == null ? null : (v > m ? 1 : 0); });
const rates = bp => dates.map((_, i) => i < 252 || d10[i] == null || d10[i - 252] == null ? null : (d10[i] - d10[i - 252] > bp / 100 ? 0 : 1));
const and = (a, b) => a.map((v, i) => v == null || b[i] == null ? null : (v && b[i] ? 1 : 0));
const START = dates.findIndex(d => d >= '1993-01-04'); // common start where every rule below is live
function run(sig) { let E = 1, pk = 1, mdd = 0, sw = 0, prev = null; const ex = [];
  for (let i = START + 1; i < N; i++) { const p = sig[i - 2]; if (p == null) throw new Error('signal not live ' + dates[i]); let g = 1 + (p ? L[i] / L[i - 1] - 1 : cash[i]); if (prev != null && p !== prev) { g *= 1 - COST; sw++; } prev = p; E *= g; pk = Math.max(pk, E); mdd = Math.min(mdd, E / pk - 1); ex.push(g - 1 - cash[i]); }
  const y = (new Date(dates[N - 1]) - new Date(dates[START])) / 3.15576e10; const mu = ex.reduce((a, v) => a + v, 0) / ex.length, sd = Math.sqrt(ex.reduce((a, v) => a + (v - mu) ** 2, 0) / ex.length);
  return { cagr: E ** (1 / y) - 1, mdd, sh: mu / sd * Math.sqrt(252), swy: sw / y }; }
const bh = run(dates.map(() => 1));
console.log(`\n=== (2) PARAMETER SENSITIVITY, QQQ (NDX-spliced) ${dates[START]}..${CUT}, next-close execution, 5 bps/switch, T-bills when out ===`);
console.log(`  buy&hold                          CAGR ${(bh.cagr * 100).toFixed(1)}  maxDD ${(bh.mdd * 100).toFixed(1)}  Sharpe ${bh.sh.toFixed(2)}`);
const rows = [];
for (const n of [6, 8, 10, 12]) rows.push([`price ${n}-month SMA`, nMonth(L, n)]);
for (const n of [100, 150, 200, 250]) rows.push([`price ${n}-day SMA`, nDay(L, n)]);
for (const n of [8, 10, 12]) rows.push([`credit VWEHX/VFITX ${n}-month`, nMonth(cr, n)]);
for (const bp of [75, 100, 150]) rows.push([`rates 10y +${bp}bp/12m`, rates(bp)]);
for (const n of [8, 10, 12]) rows.push([`price ${n}-mo AND credit ${n}-mo`, and(nMonth(L, n), nMonth(cr, n))]);
for (const [name, s] of rows) { const r = run(s); console.log(`  ${name.padEnd(32)}  CAGR ${(r.cagr * 100).toFixed(1).padStart(5)}  maxDD ${(r.mdd * 100).toFixed(1).padStart(6)}  Sharpe ${r.sh.toFixed(2)}  switches/yr ${r.swy.toFixed(1)}`); }
