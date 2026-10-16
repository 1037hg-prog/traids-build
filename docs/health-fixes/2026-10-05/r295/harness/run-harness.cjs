#!/usr/bin/env node
// R295-V7 end-to-end harness: the 15:44 close-out (via closeArm), the after-close (row, FLATTEN, wire, defect rows, FT-11 auto-resolve)
// and --resolve-overexit, run on HARNESS COPIES of v6 (the live file) and v7 (staged) against a FAKE broker seeded from the GET-only
// fixture of the real TV paper account (fixture-broker-2026-10-05.json) and COPIES of the real session states and ledger.
// Nothing under backend/ is written; no runner is require()d or given a runner flag (the copy's dispatcher is replaced by a direct call
// chosen by the spec); no network (preload.cjs throws on any host but the fake). Scratch dirs: $R295V7_TMP or <os tmp>/r295-v7-harness.
// Usage: node run-harness.cjs [--live-file <path>] [--staged-file <path>]
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const H = __dirname, PKG = path.resolve(H, ".."), ROOT = path.resolve(PKG, "..", "..", "..", ".."), REAL_BK = path.join(ROOT, "backend");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const V6 = arg("--live-file", path.join(REAL_BK, "r295-orb-forward.js")), V7 = arg("--staged-file", path.join(PKG, "staged", "backend", "r295-orb-forward.js"));
const TMP = process.env.R295V7_TMP || path.join(os.tmpdir(), "r295-v7-harness");
const FIX = JSON.parse(fs.readFileSync(path.join(H, "fixture-broker-2026-10-05.json"), "utf8"));
let pass = 0, fail = 0; const ok = (c, m, x) => { if (c) { pass++; console.log("  ok   " + m); } else { fail++; console.log("  FAIL " + m + (x !== undefined ? " :: " + (typeof x === "string" ? x : JSON.stringify(x)).slice(0, 600) : "")); } };
const DISPATCH = `(async () => { const H = globalThis.__H_SPEC;
  if (H.fn === "closeArm") return closeArm();
  if (H.fn === "afterClose") return afterClose(H.date);
  if (H.fn === "resolve") { if (typeof resolveOverExit !== "function") throw new Error("no resolver in this version"); return resolveOverExit(H.date, !!H.apply); }
  if (H.fn === "checkFlattens") { if (typeof checkFlattens !== "function") throw new Error("no --check-flattens in this version"); return checkFlattens(); }
  throw new Error("harness: unknown fn " + H.fn); })().catch((e) => { log("ERROR", e.message); process.exit(1); });
`;
function harnessCopy(src, dst) {
  let s = fs.readFileSync(src, "utf8");
  const a = 'const LIVE = process.argv.includes("--live");'; if (s.split(a).length !== 2) throw new Error("LIVE line not found once in " + src);
  s = s.replace(a, "const LIVE = globalThis.__H_LIVE === true;").split('process.argv.includes("--live")').join("(globalThis.__H_LIVE === true)");
  const i = s.lastIndexOf('(async () => {\n  if (mode === "--selftest")'); if (i < 0) throw new Error("dispatcher not found in " + src);
  s = s.slice(0, i) + DISPATCH; if (/process\.argv\.includes\("--live"\)/.test(s)) throw new Error("a --live read survived");
  fs.writeFileSync(dst, s);
}
// R295-V7R: the session states and the ledger come from fixture-states/ (snapshots of backend/data taken 2026-10-05 ~12:54 ET, mid-session:
// 10-05 not yet closed out or reconciled), so the harness gives the same answers after tonight's chain changes the real files.
const FS = path.join(H, "fixture-states");
function env(name, { states = ["2026-10-01", "2026-10-02", "2026-10-05"], stateOverride = {}, ledger = null, chain = { started: "2026-10-05T20:15:00Z", finished: "2026-10-05T21:30:00Z" } } = {}) {
  const bk = path.join(TMP, "env-" + name, "backend"); fs.rmSync(path.join(TMP, "env-" + name), { recursive: true, force: true });
  const c = path.join(bk, "data", "training", "r295"); fs.mkdirSync(path.join(bk, "lib"), { recursive: true }); fs.mkdirSync(c, { recursive: true });
  fs.copyFileSync(path.join(REAL_BK, "lib", "atomic-write.js"), path.join(bk, "lib", "atomic-write.js"));
  fs.writeFileSync(path.join(bk, "lib", "alpaca-bars.js"), "module.exports = { fetchBars: async (syms, o) => { const b = globalThis.__H_SPEC.bars || {}, out = {}; for (const s of syms) if (b[s]) out[s] = b[s].map((x) => ({ t: o.start, v: 1000, ...x })); return { bars: out }; } };\n");
  fs.writeFileSync(path.join(bk, "notify.js"), "module.exports = { notify: async (t, m) => { globalThis.__H_NOTIFY.push({ t, m }); } };\n");
  for (const d of states) fs.copyFileSync(stateOverride[d] || path.join(FS, `session-${d}.json`), path.join(c, `session-${d}.json`));
  fs.copyFileSync(path.join(FS, "superset.json"), path.join(c, "superset.json"));
  fs.writeFileSync(path.join(c, "session-2026-10-05.lock"), JSON.stringify({ pid: 999999, at: "2026-10-05T12:00:00Z" }));   // a pid that does not exist: the session process is "gone"
  fs.copyFileSync(ledger || path.join(FS, "r295-ledger.jsonl"), path.join(bk, "data", "r295-ledger.jsonl"));
  if (chain) fs.writeFileSync(path.join(bk, "data", "chain-status.json"), JSON.stringify(chain));
  return bk;
}
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PKG, "manifest.json"), "utf8"));
let runN = 0;
function run(bk, ver, spec) {
  const copy = path.join(bk, "r295-orb-forward.js"); harnessCopy(ver === "v6" ? V6 : V7, copy);
  const sf = path.join(bk, `spec-${++runN}.json`), of = path.join(bk, `out-${runN}.json`); fs.writeFileSync(sf, JSON.stringify(spec));
  const r = cp.spawnSync(process.execPath, ["-r", path.join(H, "preload.cjs"), copy], { cwd: bk, encoding: "utf8", timeout: 180000, env: { ...process.env, H_SPEC: sf, H_OUT: of, NODE_PATH: path.join(REAL_BK, "node_modules"), ALPACA_TV_KEY_ID: "", ALPACA_TV_SECRET_KEY: "", ALPACA_KEY_ID: "", ALPACA_SECRET_KEY: "" } });
  const out = fs.existsSync(of) ? JSON.parse(fs.readFileSync(of, "utf8")) : { calls: [], orders: [], positions: {}, notify: [] };
  out.stdout = r.stdout; out.stderr = r.stderr; out.status = r.status; out.posts = out.calls.filter((c) => c.method === "POST").map((c) => c.body); out.dels = out.calls.filter((c) => c.method === "DELETE").map((c) => c.path.split("/").pop());
  out.state = (d) => JSON.parse(fs.readFileSync(path.join(bk, "data", "training", "r295", `session-${d}.json`), "utf8"));
  out.ledger = () => fs.readFileSync(path.join(bk, "data", "r295-ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  out.defects = () => { const f = path.join(bk, "data", "r295-defect-cleanup.jsonl"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
  out.bk = bk; return out;
}
const PX = { CTVA: 11.9, PTC: 195.5, NU: 15.3, CVE: 31.5, UMC: 23.9 };
const bars = () => { const b = {}; for (const s of ["OUST", "UMC", "NU", "XP", "CVE", "RXO", "DKNG", "LW", "SITE", "PCVX", "CTVA", "MRP", "CBRS", "CHRW", "PCOR", "PBR", "VIRT", "AZTA", "VST", "PTC"]) { const c = PX[s] || 50; b[s] = [{ o: c, h: c, l: c, c }]; } return b; };
const close = (o) => ({ symbol: o.symbol, qty: o.qty, side: o.side, type: o.type, time_in_force: o.time_in_force, client_order_id: o.client_order_id });
const R295 = (b) => /^r295-/.test(b.client_order_id || "");

console.log("H1 close-out 15:45:30 ET via closeArm (session process gone), broker = the account as read 10-05 ~11:55 ET");
const base = { now: "2026-10-05T19:45:30Z", fn: "closeArm", date: "2026-10-05", live: true, orders: FIX.orders, positions: FIX.positions, fillMarket: "auto", px: PX };
const h1v6 = run(env("h1v6"), "v6", base), h1v7 = run(env("h1v7"), "v7", base);
ok(h1v6.status === 0 && h1v7.status === 0, "both close-arms exit 0", (h1v6.stderr + h1v7.stderr).slice(-400));
const v6Close = h1v6.posts.filter(R295).map(close), v7Close = h1v7.posts.filter((b) => /-CLOSE$/.test(b.client_order_id)).map(close);
ok(v6Close.length === 2 && JSON.stringify(v6Close.map((b) => b.client_order_id).sort()) === JSON.stringify(["r295-CTVA-20261005-CLOSE", "r295-PTC-20261005-CLOSE"]), "v6 sends CLOSE for the two open lots only (CTVA 5, PTC 31) and nothing for NU/CVE/UMC", v6Close);
ok(JSON.stringify(v7Close) === JSON.stringify(v6Close), "v7 CLOSE orders are byte-identical to v6's (normal lots unchanged)", { v6Close, v7Close });
const v7Clean = h1v7.posts.filter((b) => /-CLEANUP$/.test(b.client_order_id)).map((b) => `${b.symbol} ${b.side} ${b.qty}`).sort();
ok(JSON.stringify(v7Clean) === JSON.stringify(["CVE sell 150", "NU buy 284", "UMC sell 153"]), "v7 closes exactly the three reversals at 15:44 as -CLEANUP (NU buy 284, CVE sell 150, UMC sell 153)", v7Clean);
ok(["NU", "CVE", "UMC", "CTVA", "PTC"].every((s) => !h1v7.positions[s]) && h1v6.positions.NU === -284 && h1v6.positions.CVE === 150 && h1v6.positions.UMC === 153, "after v7 every R295 symbol is flat; after v6 the three reversals ride overnight", { v7: ["NU", "CVE", "UMC"].map((s) => h1v7.positions[s]), v6: ["NU", "CVE", "UMC"].map((s) => h1v6.positions[s]) });
ok(JSON.stringify(h1v6.dels.sort()) === JSON.stringify(h1v7.dels.sort()), "the same orders are cancelled by both (CTVA STOP1, PTC leg)", { v6: h1v6.dels, v7: h1v7.dels });
ok(h1v7.defects().length === 3 && h1v7.defects().every((r) => r.evidence === false && /cleanup at the close-out/.test(r.kind)), "v7 records 3 defect-cleanup rows (evidence:false)", h1v7.defects());
ok(h1v6.posts.filter((b) => !R295(b)).length === 0 && h1v7.posts.filter((b) => !R295(b)).length === 0, "no order outside r295-* client ids");

console.log("H2 v7 after-close 16:30 ET after the v7 close-out (CLEANUP filled): FIFO booking, no FLATTEN, FT-11 auto-resolve of 10-01 / 10-02 and of 10-05 itself");
const s7 = h1v7.state("2026-10-05"), st7 = path.join(TMP, "state-after-h1v7.json"); fs.writeFileSync(st7, JSON.stringify(s7));
const h2 = run(env("h2v7", { stateOverride: { "2026-10-05": st7 } }), "v7", { now: "2026-10-05T20:30:00Z", fn: "afterClose", date: "2026-10-05", live: true, orders: h1v7.orders, positions: h1v7.positions, bars: bars() });
ok(h2.status === 0, "v7 after-close exits 0", h2.stderr.slice(-400));
const r5 = h2.ledger().find((r) => r.date === "2026-10-05"), p5 = (s) => h2.state("2026-10-05").picks.find((p) => p.sym === s);
ok(r5 && r5.overExit === 587 && (r5.openLotsAtClose || []).length === 0 && h2.posts.length === 0, "10-05 row: over-exit 587 sh, nothing left open, NO FLATTEN sent (the -CLEANUPs closed it)", r5 && { overExit: r5.overExit, open: r5.openLotsAtClose, posts: h2.posts });
ok(p5("NU").realized === -17.04 && p5("CVE").realized === -16.33 && p5("UMC").realized === -10.71, "NU/CVE/UMC booked at the LEG fill (FIFO): -17.04 / -16.33 / -10.71", ["NU", "CVE", "UMC"].map((s) => p5(s).realized));
ok(r5.overExitDetail && r5.overExitDetail.length === 3 && r5.overExitDetail.every((d) => d.cleanup && d.cleanup.filled === d.qty && d.toFlatten === 0), "overExitDetail: each reversal closed share for share by its -CLEANUP", r5.overExitDetail);
const L = h2.ledger(), r1 = L.find((r) => r.date === "2026-10-01"), r2 = L.find((r) => r.date === "2026-10-02");
ok(r1.overExitResolved && r2.overExitResolved, "FT-11: the --live after-close resolved the 10-01 and 10-02 rows from broker fills", { r1: r1.overExitResolution && r1.overExitResolution.evidenceDelta, r2: r2.overExitResolution && r2.overExitResolution.evidenceDelta });
ok(r2.restated && r2.restated.was.netPnl === -465.9 && r2.overExitResolution.lots.length === 7 && r2.overExitResolution.lots.every((l) => l.final), "10-02: 7 lots resolved; old numbers kept under restated.was", r2.restated);
ok(["2026-10-01", "2026-10-02"].every((d) => { const r = L.find((x) => x.date === d), w = MANIFEST.ft11.expected[d]; return !!r && r.netPnl === w.netPnlNow && r.restated?.was?.netPnl === w.netPnlWas && r.overExitResolution?.defectPnl === w.defectPnl && r.overExitResolution?.evidenceDelta === w.evidenceDelta && r.overExitResolution?.overQty === w.overQty && r.overExitResolution?.lots.length === w.lots; }), "FT-11 numbers equal the reviewed numbers in manifest.json (10-01 and 10-02)", { r1: [r1.netPnl, r1.overExitResolution?.defectPnl], r2: [r2.netPnl, r2.overExitResolution?.defectPnl] });
ok(r5.overExitResolved === true && !!r5.overExitResolution && r5.overExitResolution.lots.length === 3 && r5.overExitResolution.defectPnl === r5.overExitPnl && r5.overExitResolution.evidenceDelta === 0 && !r5.restated && r5.overExitResolution.lots.every((l) => l.closeOrders.length === 1 && /-CLEANUP:/.test(l.closeOrders[0])), "R295-V7R: 10-05 resolved the same night from its -CLEANUP fills (defect P&L = the row's overExitPnl; no restatement — booked FIFO already)", r5.overExitResolution);
ok(h2.defects().filter((d) => /resolved/.test(d.kind)).length === 14 && !h2.notify.some((n) => /unresolved/.test(n.t)), "14 resolved defect rows (4 on 10-01, 7 on 10-02, 3 on 10-05), evidence:false; no 'over-exit unresolved' message", h2.defects().map((d) => d.key));
console.log(`     10-01 net ${r1.restated ? r1.restated.was.netPnl + " -> " : ""}${r1.netPnl}, defect P&L ${r1.overExitResolution?.defectPnl}; 10-02 net ${r2.restated?.was.netPnl} -> ${r2.netPnl}, defect P&L ${r2.overExitResolution?.defectPnl}; 10-05 defect P&L ${r5.overExitResolution?.defectPnl} (CLEANUP)`);

console.log("H2b the review case: a CLEANUP-closed row written WITHOUT --live (no auto-resolve), then --resolve-overexit 2026-10-05 --apply by hand");
const e2b = env("h2b", { stateOverride: { "2026-10-05": st7 } });
const h2b0 = run(e2b, "v7", { now: "2026-10-05T20:30:00Z", fn: "afterClose", date: "2026-10-05", live: false, orders: h1v7.orders, positions: h1v7.positions, bars: bars() }), r5b0 = h2b0.ledger().find((r) => r.date === "2026-10-05");
ok(h2b0.status === 0 && r5b0.overExit === 587 && !r5b0.overExitResolved && !(r5b0.markedToClose || []).some((s) => /OVER-EXIT/.test(s)) && r5b0.overExitDetail.length === 3, "the row: over-exit 587 in overExitDetail and NO 'OVER-EXIT' marker in markedToClose (pre-review v7 refused exactly this)", r5b0 && { markedToClose: r5b0.markedToClose, d: r5b0.overExitDetail });
const h2b = run(e2b, "v7", { now: "2026-10-05T22:00:00Z", fn: "resolve", date: "2026-10-05", apply: true, live: false, orders: h1v7.orders, positions: h1v7.positions }), r5b = h2b.ledger().find((r) => r.date === "2026-10-05");
ok(h2b.status === 0 && r5b.overExitResolved === true && r5b.overExitResolution.defectPnl === r5b0.overExitPnl && r5b.overExitResolution.defectPnl === -9.45 && JSON.stringify(h2b.ledger().filter((r) => r.date !== "2026-10-05")) === JSON.stringify(h2b0.ledger().filter((r) => r.date !== "2026-10-05")), "--apply resolves it: defect P&L -9.45 = NU 284 x (15.24 - 15.30) + CVE 150 x (31.50 - 31.48) + UMC 153 x (23.90 - 23.87); other rows untouched", (h2b.stdout + h2b.stderr).slice(-500));

console.log("H3 the realistic tonight: v6 close-out happened, then the after-close by v6 vs v7 (FLATTEN sized from the broker)");
const s6 = h1v6.state("2026-10-05"), st6 = path.join(TMP, "state-after-h1v6.json"); fs.writeFileSync(st6, JSON.stringify(s6));
const spec3 = { now: "2026-10-05T20:30:00Z", fn: "afterClose", date: "2026-10-05", live: true, orders: h1v6.orders, positions: h1v6.positions, bars: bars() };
const h3v6 = run(env("h3v6", { stateOverride: { "2026-10-05": st6 } }), "v6", spec3), h3v7 = run(env("h3v7", { stateOverride: { "2026-10-05": st6 } }), "v7", spec3);
ok(h3v6.status === 0 && h3v7.status === 0, "both after-closes exit 0", (h3v6.stderr + h3v7.stderr).slice(-400));
const fl6 = h3v6.posts.map(close), fl7 = h3v7.posts.map(close);
ok(fl6.length === 3 && JSON.stringify(fl7) === JSON.stringify(fl6), "v7 FLATTENs == v6's when the broker position equals the lot arithmetic (NU buy 284, CVE sell 150, UMC sell 153)", { fl6, fl7 });
const n6 = h3v6.state("2026-10-05").picks, n7 = h3v7.state("2026-10-05").picks, flip = ["NU", "CVE", "UMC"];
ok(n6.filter((p) => !flip.includes(p.sym)).every((p) => n7.find((q) => q.sym === p.sym).realized === p.realized), "every normal lot books the same realized P&L in v6 and v7", n6.filter((p) => !flip.includes(p.sym)).map((p) => [p.sym, p.realized, n7.find((q) => q.sym === p.sym).realized]).filter((x) => x[1] !== x[2]));
ok(flip.every((s) => n6.find((p) => p.sym === s).realized !== n7.find((p) => p.sym === s).realized), "the three flipped lots: v6 averaged the over-exit into the lot, v7 books the leg", flip.map((s) => [s, n6.find((p) => p.sym === s).realized, n7.find((p) => p.sym === s).realized]));
const w6 = (h3v6.notify[0] || {}).m || "", w7 = (h3v7.notify[0] || {}).m || "";
ok(w7.startsWith(w6) && w7.slice(w6.length) === " · defect cleanup, not evidence: CVE sell 150, NU buy 284, UMC sell 153", "wire: v7 = v6's text + ' · defect cleanup, not evidence: CVE sell 150, NU buy 284, UMC sell 153' (pick order)", { w6, w7 });
ok(h3v7.defects().filter((d) => /FLATTEN/.test(d.kind)).length === 3, "3 FLATTEN defect rows (evidence:false)");
{ const r = h3v7.ledger().find((x) => x.date === "2026-10-05");
  ok(!h3v7.notify.some((n) => /unresolved/.test(n.t)) && r && !r.overExitResolved && r.overExitResolveCheck && r.overExitResolveCheck.status === "not resolved" && /working/.test(r.overExitResolveCheck.why), "R295-V7R: 10-05 waits for its queued FLATTENs — the refusal is recorded on the row (overExitResolveCheck), no alert the same night", r && r.overExitResolveCheck); }
const cap = run(env("h3cap", { stateOverride: { "2026-10-05": st6 } }), "v7", { ...spec3, positions: { ...h1v6.positions, NU: -100, UMC: 0, CVE: -20 } });
const capP = cap.posts.map((b) => `${b.symbol} ${b.side} ${b.qty}`);
ok(JSON.stringify(capP) === JSON.stringify(["NU buy 100"]), "reduce-only FLATTEN: NU short 100 -> buy 100; UMC flat -> none; CVE SHORT 20 (opposite) -> no sell (it would enlarge it)", capP);
{ const tail = (((cap.notify[0] || {}).m || "").split(" · sized by broker position: ")[1] || "");
  ok(["NU buy 284 -> 100 (position -100)", "CVE sell 150 (position -20)", "UMC sell 153 (position 0)"].every((x) => tail.includes(x)) && / · defect cleanup, not evidence: NU buy 100 · /.test((cap.notify[0] || {}).m), "wire names every capped / refused FLATTEN, and only what was sent as defect cleanup", (cap.notify[0] || {}).m); }

console.log("H4 --resolve-overexit 2026-10-02 (FT-11) on the staged copy (newest session 10-02, reconciled): dry writes nothing, apply resolves, a working FLATTEN refuses");
const e4 = env("h4", { states: ["2026-10-01", "2026-10-02"] }), before = fs.readFileSync(path.join(e4, "data", "r295-ledger.jsonl"), "utf8");
const d4 = run(e4, "v7", { now: "2026-10-05T23:00:00Z", fn: "resolve", date: "2026-10-02", apply: false, live: false, orders: FIX.orders, positions: FIX.positions });
ok(d4.status === 0 && fs.readFileSync(path.join(e4, "data", "r295-ledger.jsonl"), "utf8") === before && d4.defects().length === 0 && d4.posts.length === 0, "dry: exit 0, ledger byte-identical, no defect file, no order", d4.stderr.slice(-300));
const a4 = run(e4, "v7", { now: "2026-10-05T23:00:00Z", fn: "resolve", date: "2026-10-02", apply: true, live: false, orders: FIX.orders, positions: FIX.positions });
const rr = a4.ledger().find((r) => r.date === "2026-10-02"), others = a4.ledger().filter((r) => r.date !== "2026-10-02"), was = before.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.date !== "2026-10-02");
ok(a4.status === 0 && rr.overExitResolved === true && a4.posts.length === 0 && JSON.stringify(others) === JSON.stringify(was), "apply: 10-02 resolved; every other row byte-identical; no order", a4.stderr.slice(-300));
const again = run(e4, "v7", { now: "2026-10-05T23:00:00Z", fn: "resolve", date: "2026-10-02", apply: true, live: false, orders: FIX.orders, positions: FIX.positions });
ok(again.status === 0 && /already resolved/.test(again.stdout) && again.defects().length === 7, "re-run: 'already resolved', no duplicate defect rows");
const busy = FIX.orders.map((o) => (o.client_order_id === "r295-TH-20261002-FLATTEN" ? { ...o, status: "new", filled_qty: "0", filled_avg_price: null } : o));
const e4b = env("h4b", { states: ["2026-10-01", "2026-10-02"] }), b4 = run(e4b, "v7", { now: "2026-10-05T23:00:00Z", fn: "resolve", date: "2026-10-02", apply: true, live: false, orders: busy, positions: FIX.positions });
ok(b4.status === 1 && /TH: not resolvable yet/.test(b4.stdout) && fs.readFileSync(path.join(e4b, "data", "r295-ledger.jsonl"), "utf8") === before, "a FLATTEN still working: refuses (exit 1), ledger untouched", b4.stdout.slice(-300));

console.log("H5 fail closed: the position read fails at the close-out -> no order for that lot (6 passes, ~50 s)");
const h5 = run(env("h5"), "v7", { ...base, posFail: ["PTC", "NU"] });
ok(!h5.posts.some((b) => ["PTC", "NU"].includes(b.symbol)) && h5.posts.some((b) => b.client_order_id === "r295-CVE-20261005-CLEANUP"), "PTC / NU: nothing sent while their position is unreadable; other lots proceed", h5.posts.map((b) => b.client_order_id));
ok(/PTC, NU NOT closed after 6 pass/.test(h5.state("2026-10-05").notes.join(" | ")), "the close-out notes say they were NOT closed", h5.state("2026-10-05").notes.slice(-3));

console.log("H6 close-out reduce-only (review): CTVA short 3 at 15:44 while the lot's orders say 5 open -> CLOSE buy exactly 3");
const h6 = run(env("h6"), "v7", { ...base, positions: { ...FIX.positions, CTVA: -3 } });
const c6 = h6.posts.filter((b) => /-CLOSE$/.test(b.client_order_id)).map((b) => `${b.symbol} ${b.side} ${b.qty}`).sort();
ok(h6.status === 0 && JSON.stringify(c6) === JSON.stringify(["CTVA buy 3", "PTC buy 31"]) && /CTVA R295-V7: close-out capped 5 -> 3/.test(h6.state("2026-10-05").notes.join(" | ")), "CLOSE CTVA buy 3 (capped by the position, noted), PTC 31 unchanged", c6);

console.log("H7 --resolve-overexit --apply by hand: refused unless the close chain finished after the newest R295 session and it is reconciled (fail closed)");
const rec5 = path.join(TMP, "state-10-05-reconciled.json"); fs.writeFileSync(rec5, JSON.stringify(h2.state("2026-10-05")));
const ch2 = { started: "2026-10-02T20:15:47.738Z", finished: "2026-10-02T21:37:31.398Z" };   // the real chain-status.json during tonight's run (written only at the END of a run)
const g7 = (name, envOpt, specOpt = {}) => { const e = env("h7" + name, envOpt), before = fs.readFileSync(path.join(e, "data", "r295-ledger.jsonl"), "utf8");
  const r = run(e, "v7", { now: "2026-10-05T22:00:00Z", fn: "resolve", date: "2026-10-02", apply: true, live: false, orders: FIX.orders, positions: FIX.positions, ...specOpt });
  return { r, same: fs.readFileSync(path.join(e, "data", "r295-ledger.jsonl"), "utf8") === before, out: r.stdout + r.stderr }; };
const refused = (x, re) => x.r.status === 1 && x.same && /refusing to write the ledger by hand/.test(x.out) && re.test(x.out) && x.r.posts.length === 0;
{ const a = g7("a", {}); ok(refused(a, /2026-10-05 is not reconciled/), "10-05 not reconciled yet (tonight's R295 after-close has not run): refused, ledger byte-identical", a.out.slice(-300)); }
{ const b = g7("b", { stateOverride: { "2026-10-05": rec5 }, chain: ch2 }); ok(refused(b, /before R295 session 2026-10-05 closed/), "chain-status.json still the 10-02 run (tonight's chain still running): refused", b.out.slice(-300)); }
{ const c = g7("c", { states: ["2026-10-01", "2026-10-02"], chain: ch2 }); ok(refused(c, /today's close chain has not finished/), "no R295 session today, weekday 18:00 ET, chain not finished today: refused", c.out.slice(-300)); }
{ const d = g7("d", { stateOverride: { "2026-10-05": rec5 } }, { procs: ['"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\x\\traids-bundle\\automation\\close-chain.cjs'] }); ok(refused(d, /running now: .*close-chain\.cjs/), "a visible close-chain.cjs process: refused", d.out.slice(-300)); }
{ const f = g7("f", { stateOverride: { "2026-10-05": rec5 } }, { procScanFail: true }); ok(refused(f, /process scan failed/), "the process scan failed: refused (fail closed)", f.out.slice(-300)); }
{ const n = g7("n", { stateOverride: { "2026-10-05": rec5 }, chain: null }); ok(refused(n, /no finished run/), "no chain-status.json: refused", n.out.slice(-300)); }
{ const k = g7("k", { stateOverride: { "2026-10-05": rec5 } }, { procs: ["node backend\\alpaca-mark-bridge.js --live", "node mcp/alpaca-paper-mcp.mjs"] }); ok(k.r.status === 0 && !k.same && /chain guard: close chain finished/.test(k.out) && k.r.ledger().find((r) => r.date === "2026-10-02").overExitResolved === true, "control: tonight's chain finished, 10-05 reconciled, unrelated node processes -> applied", k.out.slice(-300)); }

console.log("H8 --check-flattens (GET only) after tonight's v6 after-close queued the three FLATTENs");
const h8a = run(env("h8a"), "v7", { now: "2026-10-05T22:30:00Z", fn: "checkFlattens", date: "2026-10-05", live: false, orders: h3v6.orders, positions: h3v6.positions });
ok(h8a.status === 0 && /3 queued r295 FLATTEN\/CLEANUP order\(s\) in 3 symbol\(s\); 0 would not reduce/.test(h8a.stdout) && h8a.calls.length > 0 && h8a.calls.every((c) => c.method === "GET"), "reversals still open: each FLATTEN reduces its position (exit 0); GET only", h8a.stdout.slice(-400));
const h8b = run(env("h8b"), "v7", { now: "2026-10-05T22:30:00Z", fn: "checkFlattens", date: "2026-10-05", live: false, orders: h3v6.orders, positions: { ...h3v6.positions, NU: 0, CVE: 0, UMC: 0 } });
ok(h8b.status === 2 && (h8b.stdout.match(/^!!/gm) || []).length === 3 && /r295-NU-20261005-FLATTEN buy 284 .*NU position 0: would OPEN or enlarge a long by 284/.test(h8b.stdout) && h8b.calls.every((c) => c.method === "GET"), "closed by hand: exit 2, all three flagged as opening a position, cancel before 09:30 ET", h8b.stdout.slice(-600));

console.log("H9 the hand-close trap: reversals closed by hand, v6's FLATTENs fill at the 10-06 open and OPEN new positions -> the resolver refuses");
const st6r = path.join(TMP, "state-after-h3v6.json"); fs.writeFileSync(st6r, JSON.stringify(h3v6.state("2026-10-05")));
const led6 = path.join(h3v6.bk, "data", "r295-ledger.jsonl");
const fl9 = h3v6.orders.map((o) => (/^r295-(NU|CVE|UMC)-20261005-FLATTEN$/.test(o.client_order_id || "") ? { ...o, status: "filled", filled_qty: o.qty, filled_avg_price: String(PX[o.symbol]), filled_at: "2026-10-06T13:30:01.123456Z" } : o));
const ch6 = { started: "2026-10-06T20:15:00Z", finished: "2026-10-06T21:30:00Z" };
const e9a = env("h9a", { stateOverride: { "2026-10-05": st6r }, ledger: led6, chain: ch6 }), b9 = fs.readFileSync(path.join(e9a, "data", "r295-ledger.jsonl"), "utf8");
const h9a = run(e9a, "v7", { now: "2026-10-06T22:00:00Z", fn: "resolve", date: "2026-10-05", apply: true, live: false, orders: fl9, positions: { ...h3v6.positions, NU: 284, CVE: -150, UMC: -153 } });
ok(h9a.status === 1 && /broker position (284|-150|-153) after its closers/.test(h9a.stdout) && fs.readFileSync(path.join(e9a, "data", "r295-ledger.jsonl"), "utf8") === b9, "hand-closed + FLATTEN filled (now long NU 284 etc.): refused, ledger untouched — never booked at the wrong prices", h9a.stdout.slice(-300));
const e9b = env("h9b", { stateOverride: { "2026-10-05": st6r }, ledger: led6, chain: ch6 });
const h9b = run(e9b, "v7", { now: "2026-10-06T22:00:00Z", fn: "resolve", date: "2026-10-05", apply: true, live: false, orders: fl9, positions: { ...h3v6.positions, NU: 0, CVE: 0, UMC: 0 } }), r9 = h9b.ledger().find((r) => r.date === "2026-10-05");
ok(h9b.status === 0 && r9.overExitResolved === true && r9.restated && Math.abs(r9.overExitResolution.evidenceDelta - 10.35) < 0.011, "control (the normal case: the FLATTENs closed the reversals, flat): resolved; v6's averaged NU/CVE/UMC re-booked FIFO (+$10.35 = 2.84 + 4.45 + 3.06)", r9 && r9.overExitResolution && { d: r9.overExitResolution.evidenceDelta, lots: r9.overExitResolution.lots.map((l) => [l.sym, l.storedRealized, l.lotRealized, l.defectPnl]) });
console.log(`r295 v7 harness: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
