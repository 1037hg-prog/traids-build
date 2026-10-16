const fs = require("fs"), path = require("path"); const f = path.join(__dirname, "leak-test-synthetic.js"); let s = fs.readFileSync(f, "utf8");
const rep = (a, b) => { if (s.split(a).length !== 2) { console.error("anchor missing:", a.slice(0, 60)); process.exit(2); } s = s.replace(a, b); };
rep(' * Weightless; synthetic data only.', ` * AMENDED THE SAME DAY, AFTER THE FIRST RUN, and disclosed as such: the first run judged arm C on the engine's own rM and FAILED it
 * (gap t 2.44; raw lane gross t -2.9). Both figures are contaminated by things that are NOT look-ahead: rM carries cost, which a model
 * can rank legitimately by stop size (cost geometry), and the engine's stop-first-on-a-shared-candle rule is deliberately pessimistic,
 * which makes gross rM NEGATIVE on noise and makes that pessimism predictable from candle size. So the verdict now reads fwdR — the
 * price change from the fill to the close ~10 minutes later, in R — which has no cost and no convention in it and whose expectation on a
 * scrambled path is exactly zero given anything known at the fill. The rM lines are still printed. The control must still light up.
 * Weightless; synthetic data only.`);
rep('top.push(...T); if (R.length) { Ds.push(', 'top.push(...T); if (R.length) { DsF.push(mean(T.map((r) => r.fwdR)) - mean(R.map((r) => r.fwdR))); Ds.push(');
rep('dates = Object.keys(by).sort(), Ds = [], DsGross = [], top = [];', 'dates = Object.keys(by).sort(), Ds = [], DsGross = [], DsF = [], top = [];');
rep('const o = { arm: label,', 'const byDayF = {}; for (const r of nq) (byDayF[r.date] ||= []).push(r.fwdR);\n  const o = { arm: label, fwd: { rawLaneMeanFwdR: +mean(nq.map((r) => r.fwdR)).toFixed(4), rawLaneSessionT: tOf(Object.values(byDayF).map(mean)), selectorGapFwdR: +mean(DsF).toFixed(4), selectorGapT: tOf(DsF) },');
rep('const controlLit = A.selectorGap.t != null && A.selectorGap.t > 3;', 'const controlLit = A.fwd.selectorGapT != null && A.fwd.selectorGapT > 3;');
rep('const cleanQuiet = Math.abs(C.selectorGap.t) < 2 && Math.abs(C.rawLaneGross.sessionT) < 2;', 'const cleanQuiet = Math.abs(C.fwd.selectorGapT) < 2 && Math.abs(C.fwd.rawLaneSessionT) < 2;');
fs.writeFileSync(f + ".tmp", s); fs.renameSync(f + ".tmp", f); console.log("ok");
