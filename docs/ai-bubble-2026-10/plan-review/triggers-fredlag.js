// triggers.js — "which bust triggers worked" lens (read-only; public data cached by fetch.js).
// usage: node triggers.js [ASSET] [--from YYYY-MM-DD]     ASSET = QQQ (default) | SPY | SMH
//
// Definitions (printed again at run time):
//  * Held asset: dividend-adjusted daily close. QQQ before 1999-03-10 = ^NDX price; SPY before 1993-01-29 =
//    ^GSPC price; SMH before 2000-06-05 = ^SOX price (proxies carry no dividends).
//  * Signal is read at the close of day t; the trade executes at the close of t+1 (one-day lag).
//    Out of market earns the 13-week T-bill (^IRX/100/252 per session). Each switch costs 5 bps.
//  * Episode: close falls >=15% below its running peak. Trough = lowest close until the peak is regained,
//    or until a +75% rally off the trough (that reset binds once: it separates the 2000-02 bust from 2008).
//  * Per episode: exit lag = sessions from peak to the first exit trade; "DD at exit" = drawdown from peak at
//    that trade; avoided = strategy return minus buy-and-hold return, peak -> trough (pp);
//    re-entry lag = sessions from trough to the first buy-back; "+trough" = how far above the trough it bought;
//    cycle = strategy return minus buy-and-hold return (pp), peak -> recovery date (or the +75% reset date).
//  * Out-spells: every contiguous out-of-market stretch. BUST = overlaps an episode's peak->trough window;
//    LATE = starts after an episode's trough but before its recovery date (sold after the low);
//    FALSE ALARM = neither. Spell value = ln(cash growth) - ln(asset growth) - 2 x 5 bps.
//  * Sharpe = mean/sd of daily (return - T-bill) x sqrt(252).
const fs = require('fs');
const ASSET = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'QQQ';
const FROM = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : null;
const CUT = '2026-10-06';            // last completed session (10-07 bar is still forming)
const COST = 0.0005, DD_TH = 0.15, RESET = 0.75;
const load = f => JSON.parse(fs.readFileSync(`${__dirname}/../bust/data/${f}.json`)).filter(r => r.d <= CUT);

const G = load('_GSPC'); const dates = G.map(r => r.d); const N = dates.length;
function align(rows, key) {
  const m = new Map(rows.map(r => [r.d, r[key]])); const out = new Array(N).fill(null); let last = null;
  for (let i = 0; i < N; i++) { const v = m.get(dates[i]); if (v != null) last = v; out[i] = last; }
  return out;
}
const Y = (s, k = 'a') => align(load(s), k), F = id => { const a = align(load('FRED_' + id), 'v'); return a.map((_, i) => i ? a[i - 1] : null); }; // FRED lagged 1 session: value dated t-1 used at close t
function splice(primary, proxy) {
  const p = Y(primary), q = Y(proxy, 'c'); const s0 = p.findIndex(v => v != null); const L = p.slice();
  for (let i = s0 - 1; i >= 0; i--) { if (q[i] == null || q[i + 1] == null) break; L[i] = L[i + 1] * q[i] / q[i + 1]; }
  return L;
}
const ASSETS = { QQQ: () => splice('QQQ', '_NDX'), SPY: () => splice('SPY', '_GSPC'), SMH: () => splice('SMH', '_SOX') };
const L = ASSETS[ASSET]();
const irx = Y('_IRX', 'c'); const cash = dates.map((_, i) => i && irx[i - 1] != null ? Math.max(irx[i - 1], 0) / 100 / 252 : 0);
const isME = dates.map((d, i) => i < N - 1 && d.slice(0, 7) !== dates[i + 1].slice(0, 7));

// ---------- signal builders: return array of 1 (in) / 0 (out) / null (not yet available) at close i ----------
function sma(arr, i, n) { let s = 0; for (let k = i - n + 1; k <= i; k++) { if (k < 0 || arr[k] == null) return null; s += arr[k]; } return s / n; }
function monthly(fn) { // fn(i, meIdxList) -> 1/0/null evaluated at month-ends; carried forward
  const out = new Array(N).fill(null); const me = []; let cur = null;
  for (let i = 0; i < N; i++) { if (isME[i]) { me.push(i); const v = fn(i, me); if (v != null) cur = v; } out[i] = cur; }
  return out;
}
const tenMonth = S => monthly((i, me) => { if (me.length < 10) return null; const v = me.slice(-10).map(k => S[k]); if (v.some(x => x == null)) return null; return S[i] > v.reduce((a, b) => a + b) / 10 ? 1 : 0; });
function dailyTrend(S, n, band = 0) {
  const out = new Array(N).fill(null); let prev = null;
  for (let i = 0; i < N; i++) { const m = sma(S, i, n); if (m == null || S[i] == null) { out[i] = prev; continue; }
    let v; if (band === 0 || prev == null) v = S[i] > m ? 1 : 0; else v = prev === 1 ? (S[i] < m * (1 - band) ? 0 : 1) : (S[i] > m * (1 + band) ? 1 : 0);
    out[i] = prev = v; }
  return out;
}
const ratio = (a, b) => a.map((v, i) => v != null && b[i] != null ? v / b[i] : null);
const SECT = ['XLB', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLU', 'XLV', 'XLY'].map(s => Y(s));
const sectMonthly = monthly((i, me) => { if (me.length < 10) return null; let c = 0;
  for (const S of SECT) { const v = me.slice(-10).map(k => S[k]); if (v.some(x => x == null)) return null; if (S[i] > v.reduce((a, b) => a + b) / 10) c++; }
  return c >= 5 ? 1 : 0; });
const sectDaily = (() => { const t = SECT.map(S => dailyTrend(S, 200)); return dates.map((_, i) => t.some(x => x[i] == null) ? null : (t.reduce((a, x) => a + x[i], 0) >= 5 ? 1 : 0)); })();
const baa = F('BAA10Y'), d10 = F('DGS10');
const baaRule = dates.map((_, i) => { const m = sma(baa, i, 200); return m == null ? null : (baa[i] > m ? 0 : 1); });
const ratesRule = dates.map((_, i) => i < 252 || d10[i] == null || d10[i - 252] == null ? null : (d10[i] - d10[i - 252] > 1.0 ? 0 : 1));
const and = (...s) => dates.map((_, i) => s.some(x => x[i] == null) ? null : (s.every(x => x[i] === 1) ? 1 : 0)); // in only if all in = out if any out
const or = (...s) => dates.map((_, i) => s.some(x => x[i] == null) ? null : (s.some(x => x[i] === 1) ? 1 : 0));   // out only if all out

const own10 = tenMonth(L), own200 = dailyTrend(L, 200), own200b = dailyTrend(L, 200, 0.02);
const hyLq = ratio(Y('HYG'), Y('LQD')), vwVf = ratio(Y('VWEHX'), Y('VFITX')), rspSpy = ratio(Y('RSP'), Y('SPY'));
const SIG = [
  ['a  10-mo SMA (own, monthly)', own10],
  ['a2 10-mo SMA of SPY (monthly)', tenMonth(splice('SPY', '_GSPC'))],
  ['b  200-day SMA (own, daily)', own200],
  ['b2 200-day +/-2% band', own200b],
  ['c1 sectors >10-mo: >=5 of 9', sectMonthly],
  ['c2 sectors >200d: >=5 of 9', sectDaily],
  ['c3 RSP/SPY > its 10-mo SMA', tenMonth(rspSpy)],
  ['d1 HYG/LQD > 200d SMA', dailyTrend(hyLq, 200)],
  ['d2 HYG/LQD > 10-mo SMA', tenMonth(hyLq)],
  ['d3 VWEHX/VFITX > 200d SMA', dailyTrend(vwVf, 200)],
  ['d5 VWEHX/VFITX > 10-mo SMA', tenMonth(vwVf)],
  ['d4 Baa-10y spread <= 200d avg', baaRule],
  ['e  10y not up >100bp in 12m', ratesRule],
  ['x1 a AND d3 (out if either)', and(own10, dailyTrend(vwVf, 200))],
  ['x2 b OR d3 (out only if both)', or(own200, dailyTrend(vwVf, 200))],
  ['x3 a AND e (out if either)', and(own10, ratesRule)],
  ['x4 a AND d5 (out if either)', and(own10, tenMonth(vwVf))],
];

// ---------- episodes ----------
const s0 = L.findIndex(v => v != null) ; const startI = FROM ? Math.max(s0, dates.findIndex(d => d >= FROM)) : s0;
const EP = []; { let pk = startI, tr = null, inEp = false;
  for (let i = startI + 1; i < N; i++) {
    if (!inEp) { if (L[i] >= L[pk]) pk = i; else if (L[i] / L[pk] - 1 <= -DD_TH) { inEp = true; tr = i; } }
    else { if (L[i] < L[tr]) tr = i; if (L[i] >= L[pk] || L[i] >= L[tr] * (1 + RESET)) { EP.push({ pk, tr, end: i, rec: L[i] >= L[pk] }); inEp = false; pk = i; } }
  }
  if (inEp) EP.push({ pk, tr, end: N - 1, rec: false, open: true }); }

// ---------- strategy engine ----------
function run(sig) {
  const pos = new Array(N).fill(null), E = new Array(N).fill(null); let st = -1;
  for (let i = 2; i < N; i++) { pos[i] = sig[i - 2]; if (st < 0 && pos[i] != null && L[i - 1] != null && i - 1 >= startI) st = i - 1; }
  if (st < 0) return null; E[st] = 1;
  let sw = 0; for (let i = st + 1; i < N; i++) { const p = pos[i]; let g = 1 + (p ? L[i] / L[i - 1] - 1 : cash[i]);
    if (i > st + 1 && p !== pos[i - 1]) { g *= 1 - COST; sw++; } E[i] = E[i - 1] * g; }
  return { pos, E, st, sw };
}
const yrs = (a, b) => (new Date(dates[b]) - new Date(dates[a])) / 3.15576e10;
function stats(S, a, b) { let pk = S[a], mdd = 0; for (let i = a; i <= b; i++) { pk = Math.max(pk, S[i]); mdd = Math.min(mdd, S[i] / pk - 1); }
  return { cagr: (S[b] / S[a]) ** (1 / yrs(a, b)) - 1, mdd }; }
const pct = (x, d = 1) => x == null ? '   --' : (x * 100).toFixed(d);
const pad = (s, n) => String(s).padStart(n);

console.log(`\n=== ASSET ${ASSET} (adj close; proxy splice before ETF inception) ${dates[startI]} .. ${CUT}; ${EP.length} episodes >= ${DD_TH * 100}% ===`);
for (const e of EP) console.log(`  peak ${dates[e.pk]}  trough ${dates[e.tr]}  depth ${pct(L[e.tr] / L[e.pk] - 1)}%  ${e.open ? 'OPEN' : (e.rec ? 'recovered ' : 'reset(+75%) ') + dates[e.end]}  (${e.tr - e.pk} sessions down, ${e.end - e.tr} back)`);

const SUM = [];
for (const [name, sig] of SIG) {
  const R = run(sig); if (!R) continue; const { pos, E, st, sw } = R; const b = N - 1;
  const bh = L.map((v, i) => i >= st ? v / L[st] : null);
  const s = stats(E, st, b), h = stats(bh, st, b); const Y_ = yrs(st, b);
  let inDays = 0; for (let i = st + 1; i <= b; i++) inDays += pos[i] ? 1 : 0;
  // out-spells
  const spells = []; for (let i = st + 1; i <= b; i++) { if (pos[i] === 0 && pos[i - 1] !== 0) { let m = i; while (m + 1 <= b && pos[m + 1] === 0) m++;
      let cg = 0; for (let k = i; k <= m; k++) cg += Math.log(1 + cash[k]);
      const val = cg - Math.log(L[m] / L[i - 1]) + 2 * Math.log(1 - COST);
      const bust = EP.some(e => i - 1 < e.tr && m > e.pk); const late = !bust && EP.some(e => i - 1 >= e.tr && i - 1 < e.end);
      spells.push({ from: dates[i - 1], to: dates[m], open: m === b && pos[b] === 0, val, bust, late }); i = m; } }
  const fa = spells.filter(x => !x.bust && !x.late), bu = spells.filter(x => x.bust), la = spells.filter(x => x.late);
  const ex = [], exh = []; for (let i = st + 1; i <= b; i++) { ex.push(E[i] / E[i - 1] - 1 - cash[i]); exh.push(L[i] / L[i - 1] - 1 - cash[i]); }
  const shp = a => { const mu = a.reduce((t, v) => t + v, 0) / a.length; return mu / Math.sqrt(a.reduce((t, v) => t + (v - mu) ** 2, 0) / a.length) * Math.sqrt(252); };
  const sumv = a => a.reduce((t, x) => t + x.val, 0);
  // episodes
  const rows = [];
  for (const e of EP) {
    if (e.pk < st) { rows.push(null); continue; }
    const bhDD = L[e.tr] / L[e.pk] - 1, stDD = E[e.tr] / E[e.pk] - 1;
    let exitI = null, already = pos[e.pk + 1] === 0; if (!already) for (let k = e.pk + 1; k <= e.tr; k++) if (pos[k] === 0) { exitI = k - 1; break; }
    let outN = 0; for (let k = e.pk + 1; k <= e.tr; k++) outN += pos[k] === 0 ? 1 : 0;
    let reI = null; if (pos[e.tr] === 0 || pos[e.tr + 1] === 0) for (let k = e.tr + 1; k <= b; k++) if (pos[k] === 1) { reI = k - 1; break; }
    const cyc = (E[e.end] / E[e.pk]) - (L[e.end] / L[e.pk]);
    rows.push({ ep: e, already, exitLag: exitI == null ? null : exitI - e.pk, ddExit: exitI == null ? null : L[exitI] / L[e.pk] - 1,
      outFrac: outN / (e.tr - e.pk), avoided: stDD - bhDD, stDD, bhDD, reLag: reI == null ? null : reI - e.tr, reAbove: reI == null ? null : L[reI] / L[e.tr] - 1,
      reNever: (pos[e.tr] === 0 && reI == null), cyc });
  }
  SUM.push({ name, st, s, h, Y_, sw, inFrac: inDays / (b - st), spells, fa, bu, la, faCostYr: sumv(fa) / Y_, buValYr: sumv(bu) / Y_, laValYr: sumv(la) / Y_, sh: shp(ex), shh: shp(exh), rows, nowPos: pos[b], nowSig: sig[b] });
}

console.log(`\n--- WHOLE-PERIOD (each signal from its own first date; B&H over the same dates) ---`);
console.log('signal'.padEnd(32), pad('from', 10), pad('CAGR', 5), pad('B&H', 5), pad('Shrp', 5), pad('B&H', 5), pad('maxDD', 6), pad('B&HDD', 6), pad('%in', 4), pad('sw/yr', 5), pad('bustN', 5), pad('val/y', 6), pad('lateN', 5), pad('val/y', 6), pad('falsN', 5), pad('val/y', 6), pad('now', 4));
for (const x of SUM) console.log(x.name.padEnd(32), pad(dates[x.st], 10), pad(pct(x.s.cagr), 5), pad(pct(x.h.cagr), 5), pad(x.sh.toFixed(2), 5), pad(x.shh.toFixed(2), 5), pad(pct(x.s.mdd), 6), pad(pct(x.h.mdd), 6), pad(pct(x.inFrac, 0), 4), pad((x.sw / x.Y_).toFixed(1), 5), pad(x.bu.length, 5), pad(pct(x.buValYr, 2), 6), pad(x.la.length, 5), pad(pct(x.laValYr, 2), 6), pad(x.fa.length, 5), pad(pct(x.faCostYr, 2), 6), pad(x.nowSig === 1 ? 'IN' : x.nowSig === 0 ? 'OUT' : '--', 4));
console.log('  val/y = summed log value (%) of those out-spells per year of history. Reconcile: bust+late+false vs ln(1+CAGR)-ln(1+B&H):');
for (const x of SUM) { const chk = Math.log((x.s.cagr + 1) / (x.h.cagr + 1)) * 100, tot = (x.buValYr + x.laValYr + x.faCostYr) * 100; console.log('   ', x.name.padEnd(32), 'spells', tot.toFixed(2), 'vs CAGR gap', chk.toFixed(2), Math.abs(chk - tot) > 0.3 ? '  <-- MISMATCH' : 'ok'); }

const tag = x => x.name.slice(0, 3).trim();
const med = a => { const v = a.filter(q => q != null).sort((p, q) => p - q); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
console.log(`\n--- MATRIX 1: avoided pp, peak->trough  [drawdown already taken at the exit trade; pk = out at peak; . = never exited; '-' = signal not live] ---`);
console.log('peak       depth' + SUM.map(x => pad(tag(x), 10)).join(''));
EP.forEach((e, j) => console.log(dates[e.pk] + pad(pct(L[e.tr] / L[e.pk] - 1, 0), 6) + SUM.map(x => { const r = x.rows[j]; if (!r) return pad('-', 10);
  const t = r.already ? '[pk]' : r.exitLag == null ? '[.]' : '[' + pct(r.ddExit, 0) + ']'; return pad(pct(r.avoided, 0) + t, 10); }).join('')));
console.log(`\n--- MATRIX 2: cycle pp, peak->recovery (strategy return minus B&H return over the whole round trip; includes late re-entry) ---`);
console.log('peak       depth' + SUM.map(x => pad(tag(x), 6)).join(''));
EP.forEach((e, j) => console.log(dates[e.pk] + pad(pct(L[e.tr] / L[e.pk] - 1, 0), 6) + SUM.map(x => { const r = x.rows[j]; return pad(r ? pct(r.cyc, 0) : '-', 6); }).join('')));
console.log(`\n--- PER-SIGNAL EPISODE SUMMARY (episodes live at the peak) ---`);
console.log('signal'.padEnd(32), pad('live', 4), pad('caught', 6), pad('medExitDD', 9), pad('medExitLag', 10), pad('medAvoid', 8), pad('medReLag', 8), pad('med+trgh', 8), pad('meanCycle', 9));
for (const x of SUM) { const r = x.rows.filter(Boolean); const ex = r.filter(q => q.already || q.exitLag != null);
  console.log(x.name.padEnd(32), pad(r.length, 4), pad(r.filter(q => q.avoided >= 0.05).length, 6), pad(pct(med(ex.map(q => q.already ? 0 : q.ddExit))), 9), pad(med(ex.map(q => q.already ? 0 : q.exitLag)) ?? '--', 10), pad(pct(med(r.map(q => q.avoided))), 8), pad(med(r.map(q => q.reLag)) ?? '--', 8), pad(pct(med(r.map(q => q.reAbove))), 8), pad(pct(r.reduce((a, q) => a + q.cyc, 0) / (r.length || 1)), 9)); }
console.log('  caught = avoided >= 5 pp; exit medians over episodes with an exit (out@peak = lag 0, DD 0); re-entry medians over episodes with a buy-back after the trough');

if (process.argv.includes('--detail')) {
console.log(`\n--- PER EPISODE: exit lag (sessions) / DD at exit / avoided pp (peak->trough) / re-entry lag (sessions) / +above trough / cycle pp (peak->recovery) ---`);
EP.forEach((e, j) => {
  console.log(`\n# ${dates[e.pk]} -> ${dates[e.tr]}  B&H ${pct(L[e.tr] / L[e.pk] - 1)}%  ${e.open ? '(OPEN)' : 'end ' + dates[e.end]}`);
  for (const x of SUM) { const r = x.rows[j]; if (!r) { console.log('  ' + x.name.padEnd(32), 'n/a (signal not live at peak)'); continue; }
    const ex = r.already ? 'out@peak' : r.exitLag == null ? 'no exit' : `${r.exitLag}s @${pct(r.ddExit, 0)}%`;
    const re = r.reNever ? 'still out' : r.reLag == null ? (r.already || r.exitLag != null ? 'in@trough' : '--') : `${r.reLag}s +${pct(r.reAbove, 0)}%`;
    console.log('  ' + x.name.padEnd(32), 'exit', ex.padEnd(13), 'out', pad(pct(r.outFrac, 0) + '%', 4), ' strat', pad(pct(r.stDD), 6), ' avoided', pad(pct(r.avoided), 6), ' re-entry', re.padEnd(13), ' cycle', pad(pct(r.cyc), 6));
  }
});

console.log(`\n--- FALSE ALARMS (out-spells overlapping no episode decline): worst 5 and best 3 per signal ---`);
for (const x of SUM) { const f = [...x.fa].sort((a, b) => a.val - b.val);
  console.log(x.name.padEnd(32), `n=${x.fa.length}`, 'worst:', f.slice(0, 5).map(s => `${s.from}..${s.to} ${pct(s.val)}%`).join(' | '), '|| best:', f.slice(-3).reverse().map(s => `${s.from}..${s.to} ${pct(s.val)}%`).join(' | ')); }
}

fs.writeFileSync(`${__dirname}/out-${ASSET}${FROM ? '-' + FROM : ''}.json`, JSON.stringify({ asset: ASSET, cut: CUT, episodes: EP.map(e => ({ peak: dates[e.pk], trough: dates[e.tr], depth: L[e.tr] / L[e.pk] - 1, end: dates[e.end], recovered: e.rec, open: !!e.open })),
  signals: SUM.map(x => ({ name: x.name, from: dates[x.st], cagr: x.s.cagr, bh: x.h.cagr, mdd: x.s.mdd, bhmdd: x.h.mdd, inFrac: x.inFrac, swPerYr: x.sw / x.Y_, spells: x.spells.length, falseAlarms: x.fa.length, faCostYr: x.faCostYr, bustValYr: x.buValYr, now: x.nowSig,
    episodes: x.rows.map(r => r && { peak: dates[r.ep.pk], exitLag: r.exitLag, ddExit: r.ddExit, already: r.already, outFrac: r.outFrac, avoided: r.avoided, reLag: r.reLag, reAbove: r.reAbove, reNever: r.reNever, cyc: r.cyc }) })) }, null, 1));
