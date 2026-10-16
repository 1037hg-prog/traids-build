/**
 * SIGNAL-TIME FEATURES for intraday rows (R41). Everything here is observable at the signal bar —
 * nothing after it. Shared by the history grader (intraday-history.js) and the forward scorer
 * (intraday-model.js --forward) so history rows and forward rows are stamped by one function.
 *
 *   sigMin          minutes after 09:30 of the signal bar
 *   dir             +1 / -1
 *   mag             ORB: opening-range width as a fraction of price; VWAPR: |deviation from VWAP|
 *   symRetToSig     the name's close at the signal bar / its session open − 1
 *   spyRetToSig     SPY's close at the same bar / SPY's session open − 1
 *   spyRet25m       SPY's close at the signal bar / its close five bars earlier − 1
 *   gapPct          session open / previous session close − 1 (null when no previous session on disk)
 *   prevRet         previous session close / previous session open − 1
 *   sigBarRangePct  (high − low) / close of the signal bar
 */
const FEATURES = ["sigMin", "dir", "mag", "symRetToSig", "spyRetToSig", "spyRet25m", "gapPct", "prevRet", "sigBarRangePct"];
const minOf = (t) => (+t.slice(0, 2) - 9) * 60 + (+t.slice(3, 5) - 30);
const r4 = (x) => Number.isFinite(x) ? +x.toFixed(4) : null;

function features(row, bars, spyBars, prev) {
  const i = bars.findIndex((b) => b.t === row.sig); if (i < 0) return FEATURES.map(() => null);
  const b = bars[i], open = bars[0].o;
  const si = spyBars.findIndex((s) => s.t === row.sig);
  const sp = si >= 0 ? spyBars[si] : null, spOpen = spyBars[0]?.o, spPrev = si >= 0 ? spyBars[Math.max(0, si - 5)] : null;
  const mag = row.dev != null ? Math.abs(row.dev) / 100 : (() => { const or = bars.filter((x) => x.t >= "09:30" && x.t <= "09:55"); const hi = Math.max(...or.map((x) => x.h)), lo = Math.min(...or.map((x) => x.l)); return (hi - lo) / or[or.length - 1].c; })();
  return [minOf(row.sig), row.dir, r4(mag), r4(b.c / open - 1), sp && spOpen ? r4(sp.c / spOpen - 1) : null, sp && spPrev ? r4(sp.c / spPrev.c - 1) : null,
    prev?.close ? r4(open / prev.close - 1) : null, prev?.close && prev?.open ? r4(prev.close / prev.open - 1) : null, r4((b.h - b.l) / b.c)];
}
/** previous-session map {sym: {open, close}} from a session file's symbols */
const sessionEdges = (symbols) => Object.fromEntries(Object.entries(symbols).map(([s, b]) => [s, { open: b[0].o, close: b[b.length - 1].c }]));

module.exports = { FEATURES, features, sessionEdges };
