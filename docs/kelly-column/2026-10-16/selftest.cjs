#!/usr/bin/env node
"use strict";
/**
 * KELLY COLUMN (2026-10-16) — SELFTEST. Known answers for everything this package builds. It writes nothing in the repo (scratch
 * trees in the OS temp folder only), makes no network call, reads no key, places no order and touches no broker.
 * Last line: "ALL <n> CHECKS PASSED", or the failures and exit 1.
 *
 *   node docs/kelly-column/2026-10-16/selftest.cjs
 *
 *   A  the package: the base copy is home's bytes this was built from; both staged files parse; every staged sha in deploy.cjs
 *      matches disk; the staged printer differs from the base one ONLY in the four places this change is allowed to touch
 *   B  lib/kelly.js, known answers by hand: mean over the sample variance; the cap at 1.0 and the floor at 0; half is half of the
 *      CAPPED fraction; the shrunk pair on the lower end of the mean's two-sided 80% CI; z; conf; the printable line; every bad
 *      input answered with a reason and never a throw; clusterReturnsOf's key order and its refusals
 *   C  THE BYTE-IDENTITY PROOF. The base printer and the staged printer are run over the SAME fixtures (twelve sealed reads of
 *      every shape, plus the empty-table day). The staged HTML with the new column mechanically removed — one <th>, one <td> per
 *      row, colspan 4 -> 3 — is the base HTML BYTE FOR BYTE; the three existing cells of every row are equal cell by cell; the
 *      summary and the four returned counts are equal; and the column is not vacuous (the rows that carry returns print the
 *      hand-computed line, the rest an em dash). Changing a read's returns changes the Kelly cell and nothing else.
 *   D  deploy and rollback on scratch repos: new + base -> staged -> back byte-exact (and the new file removed again); drift
 *      refused on each file; every fence; a red gate; a second apply writes nothing
 *   E  MUTATION: fifteen mutants of the two staged files, each one caught by a named check of B or C
 *   F  record.cjs: --dry on the real tree writes nothing; on scratch data the write, already-recorded, the no-write window, a
 *      lock held by another writer, and home not applied
 */
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");
const D = require("./deploy.cjs"), RB = require("./rollback.cjs"), REC = require("./record.cjs"), SY = require("./sync-shas.cjs");
const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const PJ = (root, rel) => path.join(root, ...rel.split("/"));
const BASE_PRINTER = fs.readFileSync(PJ(PKG, "base/backend/progress-tests.js"), "utf8");
const STAGED_PRINTER = fs.readFileSync(PJ(PKG, "staged/backend/progress-tests.js"), "utf8");
const STAGED_KELLY = fs.readFileSync(PJ(PKG, "staged/backend/lib/kelly.js"), "utf8");

let pass = 0, failN = 0; const failed = [];
function ok(name, cond, detail) { if (cond) { pass++; console.log(`  ok   ${name}`); } else { failN++; failed.push(name); console.log(`  FAIL ${name}${detail === undefined ? "" : " — " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 700)}`); } }
const section = (s) => console.log(`\n${s}`);
const close = (a, b, tol = 1e-12) => typeof a === "number" && Number.isFinite(a) && Math.abs(a - b) <= tol;
/** an exact text replacement that must match once (a mutant) */
function mutate(text, from, to) { const n = text.split(from).length - 1; if (n !== 1) throw new Error(`mutation anchor found ${n} times, not once: ${String(from).slice(0, 90)}`); return text.replace(from, () => to); }
const TMP = [];
function tmpDir(tag) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `kelly-${tag}-`)); TMP.push(d); return d; }
const rmAll = () => { for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } } };

// ── the fixtures: one day's sealed reads, of every shape this column can meet ───────────────────────────────────────────────
const TODAY = "2026-10-16";
/** [5,-3,1,1,1,1,1,1,1]: n 9, mean 1, sample variance 4 (SS 32 / 8), sd 2, se 2/3 — all exact by hand */
const HAND_A = [5, -3, 1, 1, 1, 1, 1, 1, 1];
/** [10,-6,2,...]: n 9, mean 2, sample variance 16 (SS 128 / 8), sd 4, se 4/3 */
const HAND_B = [10, -6, 2, 2, 2, 2, 2, 2, 2];
const TEXT_A = "full 0.250 / half 0.125 · shrunk 0.036 / 0.018 · n 9";
const TEXT_B = "full 0.125 / half 0.063 · shrunk 0.018 / 0.009 · n 9";
const TEXT_CAP = "full 1.000 / half 0.500 · shrunk 1.000 / 0.500 · n 4";
const TEXT_FLOOR = "full 0.000 / half 0.000 · shrunk 0.000 / 0.000 · n 3";
const DASH = "&mdash;";

function seals(day = TODAY, overrides = {}) {
  const t = {
    R401: { sealedOn: day, sessions: 42, unit: "sessions", verdict: "CONFIRMED — day-clustered mean R -0.21, t -2.4 <= -2.0", clusterReturns: HAND_A },
    R402: { sealedOn: day, sessions: 9, unit: "months", verdict: "DID NOT PASS — month-clustered t 1.1 vs bar 2.0", output: "data/r402-read.json" },
    R403: { sealedOn: day, unit: "auctions", verdict: "NOT-ESTABLISHED — t 0.4 vs bar 2.0; no per-unit series kept" },
    R404: { sealedOn: day, sessions: 4, unit: "weeks", verdict: "PASS — a & b <bar> \"quoted\" >= 2.0", clusterReturns: [0.01, 0.02, 0.03, 0.04] },
    R405: { sealedOn: day, sessions: 3, unit: "days", verdict: "KILL — mean -2.0R", clusterReturns: [-1, -2, -3] },
    R406: { sealedOn: day, sessions: 5, unit: "events", verdict: "SURVIVES — every unit the same", clusterReturns: [2, 2, 2, 2, 2] },
    R407: { sealedOn: day, unit: "months", verdict: "PASS — output file is gone", output: "data/does-not-exist.json" },
    R408: { sealedOn: day, unit: "months", verdict: "PASS — output path climbs out of data", output: "data/../../secret.json" },
    R409: { sealedOn: day, unit: "months", verdict: "PASS — output file is corrupt", output: "data/r409-corrupt.json" },
    R410: { sealedOn: day, unit: "months", verdict: "PASS — absolute output path", output: "/etc/passwd" },
    R411: { sealedOn: day, unit: "months", verdict: "PASS — one unit only", clusterReturns: [0.5] },
    R412: { sealedOn: day, unit: "months", verdict: "PASS — a non-finite among the returns", clusterReturns: [1, 2, null, 4] },
    R413: { sealedOn: day, sessions: 9, unit: "sessions", verdict: "PASS — carries its own series AND an output file", clusterReturns: HAND_A, output: "data/r402-read.json" },
    R399: { sealedOn: "2026-01-02", unit: "months", verdict: "sealed on another day — never in today's table", clusterReturns: HAND_A },
  };
  for (const [k, v] of Object.entries(overrides)) t[k] = v;
  return { lastRun: `${day}T23:00:00.000Z`, tests: t };
}
const SEAL_IDS_TODAY = ["R401", "R402", "R403", "R404", "R405", "R406", "R407", "R408", "R409", "R410", "R411", "R412", "R413"];
/** the Kelly cell each fixture row must show (R413 carries both: the seal's own series wins over its output file) */
const WANT_CELL = { R401: TEXT_A, R402: TEXT_B, R403: DASH, R404: TEXT_CAP, R405: TEXT_FLOOR, R406: DASH, R407: DASH, R408: DASH, R409: DASH, R410: DASH, R411: DASH, R412: DASH, R413: TEXT_A };

/** a scratch tree holding one copy of the printer, its lib and a backend/data of fixtures */
function tree({ staged, printerText = null, kellyText = null, sealsJson = seals(), day = TODAY }) {
  const dir = tmpDir(staged ? "staged" : "base"), data = PJ(dir, "backend/data");
  fs.mkdirSync(PJ(dir, "backend/lib"), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(PJ(dir, "backend/progress-tests.js"), printerText !== null ? printerText : (staged ? STAGED_PRINTER : BASE_PRINTER));
  if (staged) {
    fs.writeFileSync(PJ(dir, "backend/lib/kelly.js"), kellyText !== null ? kellyText : STAGED_KELLY);
    fs.copyFileSync(PJ(REPO, "backend/lib/selection-luck.js"), PJ(dir, "backend/lib/selection-luck.js"));
  }
  writeJsonAtomic(path.join(data, "read-seals.json"), sealsJson);
  writeJsonAtomic(path.join(data, "r402-read.json"), { spec: "r402", latest: { monthMeans: HAND_B } });
  writeJsonAtomic(path.join(dir, "secret.json"), { clusterReturns: HAND_A });                       // reachable only by climbing out of data/
  fs.writeFileSync(path.join(data, "r409-corrupt.json"), "{ this is not json");                      // a corrupt file is not writable through writeJsonAtomic, by design
  writeJsonAtomic(path.join(data, "adjudicator.json"), { rows: [
    { id: "R500", verdict: "READY TO READ", detail: "30 sessions and 60 shadows: at its bar" },
    { id: "R501", verdict: "ACCRUING", detail: "12 of 30 sessions" },
    { id: "R502", verdict: "READ-PARTIAL", detail: "the holdout half is not in" },
  ] });
  writeJsonAtomic(path.join(data, "chain-status.json"), { started: `${day}T20:05:00.000Z`, finished: `${day}T20:41:00.000Z`, steps: [1, 2, 3, 4], failed: [] });
  writeJsonAtomic(path.join(data, "ops-health.json"), { findings: [{ kind: "stale", id: "futures-daily" }, { kind: "gap", id: "sip-minutes" }] });
  writeJsonAtomic(path.join(data, "retire-requests.json"), { requests: [{ id: "RR-7", ids: ["t1", "t2"], scope: "two tickets priced from a bar that never traded" }] });
  writeJsonAtomic(path.join(data, "c2-ares-forward.json"), { feed: { state: "STALE — last CSV 2026-10-01" } });
  return dir;
}
const buildIn = (dir, day = TODAY) => require(PJ(dir, "backend/progress-tests.js")).build({ today: day });
/**
 * lib/kelly.js, loaded from a scratch tree. The package's own copy cannot be required where it sits: the repo root's
 * package.json says "type": "module", so a .js under docs/ loads as ESM, while at home backend/package.json (no "type") makes
 * every backend/**\/*.js CommonJS. The scratch tree has no package.json above it, so it loads the way home loads it.
 */
function libTree(kellyText = STAGED_KELLY) {
  const dir = tmpDir("lib");
  fs.writeFileSync(PJ(dir, "kelly.js"), kellyText);
  fs.copyFileSync(PJ(REPO, "backend/lib/selection-luck.js"), PJ(dir, "selection-luck.js"));
  return require(PJ(dir, "kelly.js"));
}

// ── the byte-identity machinery ────────────────────────────────────────────────────────────────────────────────────────────
/** remove exactly the column this change adds: one header cell, the LAST <td> of every row, and colspan 4 -> 3 */
function stripKellyColumn(html) {
  let th = 0, td = 0, cs = 0;
  let out = html.replace("<th>Kelly (descriptive)</th>", () => { th++; return ""; });
  out = out.replace(/<td>[^<]*<\/td><\/tr>/g, () => { td++; return "</tr>"; });
  out = out.replace(/colspan="4"/g, () => { cs++; return 'colspan="3"'; });
  return { out, th, td, cs };
}
/** the <tbody> rows of the table, each as its list of cell bodies (cells never contain '<': esc escapes it) */
function rowsOf(html) {
  const m = /<tbody>([\s\S]*?)<\/tbody>/.exec(html); if (!m) return null;
  return m[1].split("</tr>").filter((s) => s.includes("<tr>")).map((r) => [...r.matchAll(/<td(?: [^>]*)?>([^<]*(?:<b>[^<]*<\/b>[^<]*)*)<\/td>/g)].map((x) => x[1]));
}

// ── B as a function, so every mutant can be put through the same checks ────────────────────────────────────────────────────
/** every known answer for lib/kelly.js -> [{ name, ok, detail }] */
function kellyChecks(K) {
  const out = [], add = (name, cond, detail) => out.push({ name, ok: !!cond, detail });
  let a; try { a = K.kellyLine(HAND_A); } catch (e) { a = { reason: "THREW: " + e.message }; }
  add("B1 hand case: n 9, mean 1, sample variance 4 (n-1), sd 2, se 2/3",
    a && a.reason === null && a.n === 9 && close(a.mean, 1) && close(a.variance, 4) && close(a.sd, 2) && close(a.se, 2 / 3), a);
  add("B2 hand case: full = mean/variance = 0.25, half = 0.125", a && close(a.full, 0.25) && close(a.half, 0.125) && close(a.rawFull, 0.25), a);
  add("B3 hand case: meanLo = 1 - z*2/3 and shrunkFull = meanLo/4, shrunkHalf = half of it",
    a && close(a.meanLo, 1 - a.z * (2 / 3)) && close(a.shrunkFull, (1 - a.z * (2 / 3)) / 4) && close(a.shrunkHalf, a.shrunkFull / 2), a);
  add("B4 hand case: the printable line", a && a.text === TEXT_A, a && a.text);
  let b; try { b = K.kellyLine(HAND_B); } catch (e) { b = { reason: "THREW: " + e.message }; }
  add("B5 second hand case: mean 2, variance 16 -> full 0.125, line as printed", b && close(b.mean, 2) && close(b.variance, 16) && close(b.full, 0.125) && b.text === TEXT_B, b && b.text);
  let cap; try { cap = K.kellyLine([0.01, 0.02, 0.03, 0.04]); } catch (e) { cap = { reason: "THREW: " + e.message }; }
  add("B6 CAP: mean/variance is 150, full is 1.0 and half is 0.5 (half of the CAPPED fraction, not 75)",
    cap && cap.reason === null && close(cap.rawFull, 150, 1e-9) && cap.full === 1 && cap.half === 0.5 && cap.text === TEXT_CAP, cap && { raw: cap.rawFull, full: cap.full, half: cap.half, text: cap.text });
  let flo; try { flo = K.kellyLine([-1, -2, -3]); } catch (e) { flo = { reason: "THREW: " + e.message }; }
  add("B7 FLOOR: a negative mean gives raw -2 and a floored full of 0, half 0, shrunk 0",
    flo && flo.reason === null && close(flo.rawFull, -2) && flo.full === 0 && flo.half === 0 && flo.shrunkFull === 0 && flo.text === TEXT_FLOOR, flo && { raw: flo.rawFull, full: flo.full, text: flo.text });
  add("B8 z is probit(0.90) for the 80% interval, 1.28155157 to 1e-8", K.Z80 != null && close(K.Z80, 1.2815515655446004, 1e-8), K.Z80);
  let c95; try { c95 = K.kellyLine(HAND_A, { conf: 0.95 }); } catch (e) { c95 = { reason: "THREW: " + e.message }; }
  add("B9 conf 0.95 uses probit(0.975) and shrinks harder than 0.80 (same full)",
    c95 && c95.reason === null && close(c95.z, 1.959963984540054, 1e-7) && close(c95.full, 0.25) && c95.shrunkFull < (a ? a.shrunkFull : -1), c95 && { z: c95.z, sf: c95.shrunkFull });
  add("B10 the shrunk fraction is never above the full one, on 200 random samples", (() => {
    let s = 1; for (let i = 0; i < 200; i++) { const n = 2 + (i % 40), r = Array.from({ length: n }, (_, j) => Math.sin(i * 7.3 + j * 1.7) * (1 + (i % 5))); const k = K.kellyLine(r); if (k.reason) continue; if (!(k.shrunkFull <= k.full + 1e-15 && k.full >= 0 && k.full <= 1 && k.shrunkFull >= 0 && k.shrunkFull <= 1 && close(k.half, k.full / 2) && close(k.shrunkHalf, k.shrunkFull / 2))) s = 0; } return s; })());
  const zv = K.kellyLine([2, 2, 2, 2, 2]);
  add("B11 no variance -> a reason and null numbers, never a number", zv && zv.reason && /no variance/.test(zv.reason) && zv.full === null && zv.text === null, zv);
  const one = K.kellyLine([0.5]);
  add("B12 one clustering unit -> 'need >= 2 clustering units'", one && one.reason && /need >= 2 clustering units/.test(one.reason), one && one.reason);
  add("B13 bad input -> a reason, never a throw", (() => {
    const bad = [null, undefined, "x", 3, [], [1, "2"], [1, NaN, 3], [1, Infinity], [1, 2, null]];
    try { return bad.every((x) => { const r = K.kellyLine(x); return r && r.reason && r.full === null; }) && !!K.kellyLine(HAND_A, { conf: 0 }).reason && !!K.kellyLine(HAND_A, { conf: 1 }).reason && !!K.kellyLine(HAND_A, { round: -1 }).reason; } catch (e) { return false; }
  })());
  add("B14 the sample variance is n-1, not n (the n form would read 3.5555 here, not 4)", a && close(a.variance, 32 / 8) && !close(a.variance, 32 / 9, 1e-6), a && a.variance);
  // why this is here: a mutant that drops esc() around the Kelly cell changes no byte of any output, because the line is drawn
  // from a closed character set that esc() never touches. That is not a hole, it is a property — so it is checked directly
  // instead of mutated. The esc() call stays: the printer must not depend on a library keeping its character set.
  add("B18 the printable line never contains a character esc() would change (& < >), over 500 samples and every extreme", (() => {
    const bad = /[&<>]/, samples = [];
    for (let i = 0; i < 500; i++) { const n = 2 + (i % 60); samples.push(Array.from({ length: n }, (_, j) => Math.tan(i * 2.1 + j * 0.9) * Math.pow(10, (i % 13) - 6))); }
    samples.push([1e308, -1e308], [1e-308, 2e-308], [-1, 1], [0, 1e-12], HAND_A, HAND_B, [0.01, 0.02, 0.03, 0.04], [-1, -2, -3]);
    for (const s of samples) for (const o of [undefined, { conf: 0.5 }, { conf: 0.999 }, { round: 0 }, { round: 12 }]) {
      const k = K.kellyLine(s, o); if (k.reason) continue;
      if (typeof k.text !== "string" || bad.test(k.text) || !/^full [\d.]+ \/ half [\d.]+ · shrunk [\d.]+ \/ [\d.]+ · n \d+$/.test(k.text)) return false;
    }
    return true;
  })());
  const cr = K.clusterReturnsOf;
  add("B15 clusterReturnsOf: the key order is clusterReturns before clusterMeans before sessionMeans",
    cr({ sessionMeans: [9, 9], clusterMeans: [8, 8], clusterReturns: [7, 7] }).key === "clusterReturns" && cr({ sessionMeans: [9, 9], clusterMeans: [8, 8] }).key === "clusterMeans");
  add("B16 clusterReturnsOf: the containers are read after the top level, in order",
    cr({ latest: { monthMeans: HAND_B } }).key === "latest.monthMeans" && cr({ summary: { dayMeans: [1, 2] }, latest: { dayMeans: [3, 4] } }).key === "latest.dayMeans" && cr({ dayMeans: [5, 6], latest: { dayMeans: [3, 4] } }).key === "dayMeans");
  add("B17 clusterReturnsOf refuses what is not a series of >= 2 finite numbers, and never throws", (() => {
    try { return [null, undefined, 7, "x", [1, 2], {}, { clusterReturns: [1] }, { clusterReturns: [] }, { clusterReturns: [1, "2"] }, { clusterReturns: [1, NaN] }, { clusterReturns: { 0: 1, 1: 2 } }, { nope: [1, 2] }, { latest: [1, 2] }, { latest: null }].every((x) => { const r = cr(x); return r && r.returns === null && !!r.reason; }); } catch { return false; }
  })());
  return out;
}

// ── C as a function, so every printer mutant can be put through the same checks ────────────────────────────────────────────
/** the byte-identity proof and the column's own values -> [{ name, ok, detail }] */
function printerChecks({ printerText = null, kellyText = null } = {}) {
  const out = [], add = (name, cond, detail) => out.push({ name, ok: !!cond, detail });
  let baseOut, stagedOut, baseEmpty, stagedEmpty;
  try {
    baseOut = buildIn(tree({ staged: false }));
    stagedOut = buildIn(tree({ staged: true, printerText, kellyText }));
    baseEmpty = buildIn(tree({ staged: false, sealsJson: seals("2026-01-02") }));
    stagedEmpty = buildIn(tree({ staged: true, printerText, kellyText, sealsJson: seals("2026-01-02") }));
  } catch (e) {
    add("C0 both printers build over the same fixtures without throwing", false, String(e && e.stack).slice(0, 400));
    return out;
  }
  add("C0 both printers build over the same fixtures without throwing", true);
  const s = stripKellyColumn(stagedOut.html);
  add(`C1 BYTE-IDENTICAL: the staged HTML minus the new column is the base HTML, byte for byte (${SEAL_IDS_TODAY.length} sealed reads)`,
    s.out === baseOut.html && s.th === 1 && s.td === SEAL_IDS_TODAY.length && s.cs === 0,
    s.out === baseOut.html ? { th: s.th, td: s.td, cs: s.cs } : { firstDiffAt: (() => { for (let i = 0; i < Math.max(s.out.length, baseOut.html.length); i++) if (s.out[i] !== baseOut.html[i]) return { i, staged: s.out.slice(i, i + 90), base: baseOut.html.slice(i, i + 90) }; return null; })() });
  const bRows = rowsOf(baseOut.html), sRows = rowsOf(stagedOut.html);
  add("C2 every row: three cells before, four after, and the first three equal cell by cell",
    bRows && sRows && bRows.length === SEAL_IDS_TODAY.length && sRows.length === SEAL_IDS_TODAY.length &&
    bRows.every((r) => r.length === 3) && sRows.every((r) => r.length === 4) &&
    bRows.every((r, i) => r[0] === sRows[i][0] && r[1] === sRows[i][1] && r[2] === sRows[i][2]),
    { base: bRows && bRows.map((r) => r.length), staged: sRows && sRows.map((r) => r.length), b0: bRows && bRows[0], s0: sRows && sRows[0] });
  add("C3 the verdict cell is still the seal's own text, escaped exactly as before (the one with & < > \" in it)",
    bRows && sRows && bRows[3] && bRows[3][2] === sRows[3][2] && sRows[3][2] === "PASS — a &amp; b &lt;bar&gt; \"quoted\" &gt;= 2.0",
    sRows && sRows[3] && sRows[3][2]);
  add("C4 the summary and the four returned counts are unchanged",
    stagedOut.summary === baseOut.summary && stagedOut.sealedToday === baseOut.sealedToday && stagedOut.ready === baseOut.ready && stagedOut.waiting === baseOut.waiting && Object.keys(stagedOut).join() === Object.keys(baseOut).join(),
    { base: { s: baseOut.summary, t: baseOut.sealedToday, r: baseOut.ready, w: baseOut.waiting }, staged: { s: stagedOut.summary, t: stagedOut.sealedToday, r: stagedOut.ready, w: stagedOut.waiting } });
  const e = stripKellyColumn(stagedEmpty.html);
  add("C5 the empty-table day: the only differences are the header cell and colspan 4 -> 3",
    e.out === baseEmpty.html && e.th === 1 && e.td === 0 && e.cs === 1 && /colspan="3"/.test(baseEmpty.html) && /colspan="4"/.test(stagedEmpty.html),
    { eq: e.out === baseEmpty.html, th: e.th, td: e.td, cs: e.cs });
  const cells = {}; if (sRows) SEAL_IDS_TODAY.forEach((id, i) => { cells[id] = sRows[i] && sRows[i][3]; });
  add("C6 NOT VACUOUS: the Kelly cell of every fixture read is the hand-computed line, or an em dash where it cannot be computed; a seal's own series beats its output file",
    sRows && SEAL_IDS_TODAY.every((id) => cells[id] === WANT_CELL[id]) && Object.values(WANT_CELL).filter((v) => v !== DASH).length === 5 && cells.R413 === TEXT_A && cells.R402 === TEXT_B,
    cells);
  add("C7 the row ids are in the seal's own order and the read sealed on another day is not in the table",
    sRows && sRows.map((r) => r[0]).join() === SEAL_IDS_TODAY.map((id) => `<b>${id}</b>`).join() && !stagedOut.html.includes("R399"),
    sRows && sRows.map((r) => r[0]));
  // the output file is only read from under backend/data: the climbing path, the absolute path and the corrupt file all give a dash
  add("C8 a read's output file is read from backend/data only (data/../../secret.json, /etc/passwd), and a corrupt or missing one is a dash, never a throw",
    cells.R407 === DASH && cells.R408 === DASH && cells.R409 === DASH && cells.R410 === DASH, { R407: cells.R407, R408: cells.R408, R409: cells.R409, R410: cells.R410 });
  // changing one read's returns moves its Kelly cell and nothing else in the document
  let moved = null;
  try {
    const alt = buildIn(tree({ staged: true, printerText, kellyText, sealsJson: seals(TODAY, { R401: { sealedOn: TODAY, sessions: 42, unit: "sessions", verdict: "CONFIRMED — day-clustered mean R -0.21, t -2.4 <= -2.0", clusterReturns: HAND_B } }) }));
    const aRows = rowsOf(alt.html);
    moved = { changed: aRows && aRows[0][3] === TEXT_B && sRows && sRows[0][3] === TEXT_A, restEqual: stripKellyColumn(alt.html).out === baseOut.html, summary: alt.summary === baseOut.summary };
  } catch (err) { moved = { threw: String(err && err.message) }; }
  add("C9 changing a read's returns changes its Kelly cell and NOTHING else in the document", moved && moved.changed && moved.restEqual && moved.summary, moved);
  return out;
}

(async () => {
  // ── A. the package ───────────────────────────────────────────────────────────────────────────────────────────────────────
  section("A. the package");
  {
    const live = (() => { try { return fs.readFileSync(PJ(REPO, "backend/progress-tests.js")); } catch { return null; } })();
    const f = D.FILES.find((x) => x.rel === "backend/progress-tests.js"), k = D.FILES.find((x) => x.rel === "backend/lib/kelly.js");
    ok("A1 the base copy is the bytes deploy.cjs was built against", sha(Buffer.from(BASE_PRINTER)) === f.baseSha, { base: sha(Buffer.from(BASE_PRINTER)), want: f.baseSha });
    ok("A2 home's backend/progress-tests.js reads base or applied (this tree is a clean copy, so base)", live && [f.baseSha, f.stagedSha].includes(sha(live)), live ? sha(live) : "missing");
    ok("A3 backend/lib/kelly.js is a NEW file: no baseSha, no base copy, and nothing of that name at home", k.baseSha === null && k.base === null && !fs.existsSync(PJ(REPO, "backend/lib/kelly.js")));
    const st = SY.states();
    ok("A4 every staged sha in deploy.cjs matches disk (sync-shas.cjs --check)", st.every((x) => x.ok), st);
    for (const rel of ["staged/backend/progress-tests.js", "staged/backend/lib/kelly.js", "base/backend/progress-tests.js", "deploy.cjs", "rollback.cjs", "record.cjs", "sync-shas.cjs", "selftest.cjs"]) {
      const r = cp.spawnSync(process.execPath, ["--check", PJ(PKG, rel)], { encoding: "utf8", windowsHide: true });
      ok(`A5 ${rel} parses`, r.status === 0, String(r.stderr).trim().split("\n")[0]);
    }
    ok("A6 NOTES.md is in the package and names the two files", (() => { let t = ""; try { t = fs.readFileSync(path.join(PKG, "NOTES.md"), "utf8"); } catch { return false; } return t.includes("backend/lib/kelly.js") && t.includes("backend/progress-tests.js") && t.length > 1200; })());
    // the staged printer differs from the base one only where this change is allowed to touch
    const added = STAGED_PRINTER.split("\n").filter((l) => !BASE_PRINTER.includes(l));
    const removed = BASE_PRINTER.split("\n").filter((l) => !STAGED_PRINTER.includes(l));
    ok("A7 the staged printer removes exactly three lines: the two table lines it rewrites and the header row",
      removed.length === 3 && removed.some((l) => l.includes("<th>Verdict, as sealed</th></tr>")) && removed.some((l) => l.includes('colspan="3"')) && removed.some((l) => l.includes("esc(v.verdict)}</td></tr>")), removed);
    ok("A8 nothing outside the table and the new helper changed: every other line of the base printer is still there, in order", (() => {
      const b = BASE_PRINTER.split("\n"), s = STAGED_PRINTER.split("\n"); let i = 0;
      for (const line of b) { if (removed.includes(line)) continue; const j = s.indexOf(line, i); if (j < 0) return false; i = j + 1; }
      return true;
    })());
    ok("A9 the staged printer touches no registered rule, bar, population or read condition (no new comparison, no new threshold)",
      !/\bBAR\b|tRequired|minSessions|killT|>=\s*\d|<=\s*-?\d/.test(added.join("\n")), added.filter((l) => /\bBAR\b|tRequired|>=\s*\d/.test(l)));
    ok("A10 neither staged file reads the network, a key, a broker or process.env", !/fetch\(|https?:|process\.env|ALPACA|SCHWAB|TASTY|api[_-]?key/i.test(STAGED_KELLY + STAGED_PRINTER));
    ok("A11 lib/kelly.js does no I/O at all", !/require\("fs"\)|require\("path"\)|readFileSync|writeFileSync|child_process/.test(STAGED_KELLY));
  }

  // ── B. lib/kelly.js, known answers ───────────────────────────────────────────────────────────────────────────────────────
  section("B. lib/kelly.js — known answers by hand");
  const K = libTree();
  for (const c of kellyChecks(K)) ok(c.name, c.ok, c.detail);

  // ── C. the byte-identity proof ───────────────────────────────────────────────────────────────────────────────────────────
  section("C. the shared read printer — every existing read's other output byte for byte");
  for (const c of printerChecks()) ok(c.name, c.ok, c.detail);

  // ── D. deploy and rollback on scratch repos ──────────────────────────────────────────────────────────────────────────────
  section("D. deploy.cjs / rollback.cjs on scratch repos");
  {
    const SAT = Date.parse("2026-10-17T18:00:00Z");          // Saturday: no clock fence, no chain fence
    const THU_SESSION = Date.parse("2026-10-15T18:00:00Z");  // Thursday 12:00 MT: inside 05:30-16:00 MT
    const THU_EVENING = Date.parse("2026-10-15T22:05:00Z");  // Thursday 18:05 ET / 16:05 MT: past the close, chain not finished
    const greenGate = { what: "the gate", run: () => ({ ok: true, line: "ALL 99 CHECKS PASSED" }) };
    const redGate = { what: "the gate", run: () => ({ ok: false, line: "3 OF 99 CHECKS FAILED", why: "3 OF 99 CHECKS FAILED" }) };
    const quiet = () => {};
    const mkRepo = ({ printer = BASE_PRINTER, kelly = null } = {}) => {
      const r = tmpDir("repo"); fs.mkdirSync(PJ(r, "backend/lib"), { recursive: true });
      fs.writeFileSync(PJ(r, "backend/progress-tests.js"), printer);
      if (kelly !== null) fs.writeFileSync(PJ(r, "backend/lib/kelly.js"), kelly);
      return r;
    };
    const deps = (repo, extra = {}) => ({ repo, now: () => SAT, log: quiet, listProcs: () => [], chainStatus: () => null, holidays: {}, ...extra });

    { const repo = mkRepo();
      const p0 = D.plan({ repo });
      ok("D1 a clean tree plans as new + base", p0.problems.length === 0 && p0.files.map((x) => x.state).join() === "new,base", p0.files.map((x) => `${x.rel} ${x.state}`));
      const r1 = D.make(deps(repo)).writeUnit({ to: "staged", gate: greenGate });
      const applied = D.plan({ repo });
      ok("D2 apply writes both files; home then reads applied, byte for byte the staged copies",
        r1.result === "done" && r1.written.length === 2 && applied.applied &&
        fs.readFileSync(PJ(repo, "backend/progress-tests.js"), "utf8") === STAGED_PRINTER && fs.readFileSync(PJ(repo, "backend/lib/kelly.js"), "utf8") === STAGED_KELLY, r1);
      const r2 = D.make(deps(repo)).writeUnit({ to: "staged", gate: greenGate });
      ok("D3 a second apply writes nothing", r2.result === "done" && r2.written.length === 0, r2);
      const r3 = RB.rollback(deps(repo));
      ok("D4 rollback puts the printer back byte for byte and removes the file this package created",
        r3.result === "done" && fs.readFileSync(PJ(repo, "backend/progress-tests.js"), "utf8") === BASE_PRINTER && !fs.existsSync(PJ(repo, "backend/lib/kelly.js")), r3);
      const r4 = RB.rollback(deps(repo));
      ok("D5 a second rollback does nothing", r4.result === "done" && r4.written.length === 0, r4);
    }
    { const repo = mkRepo({ printer: BASE_PRINTER + "\n// somebody edited this at home\n" });
      const r = D.make(deps(repo)).writeUnit({ to: "staged", gate: greenGate });
      ok("D6 DRIFT on the changed file refuses, writes nothing, and says to read the change",
        r.result === "refused" && r.why.some((w) => /progress-tests\.js is DRIFT/.test(w)) && !fs.existsSync(PJ(repo, "backend/lib/kelly.js")), r.why);
    }
    { const repo = mkRepo({ kelly: "// a kelly.js that is not ours\n" });
      const r = D.make(deps(repo)).writeUnit({ to: "staged", gate: greenGate });
      ok("D7 DRIFT on the NEW file (home already has one) refuses and leaves it alone",
        r.result === "refused" && r.why.some((w) => /kelly\.js is DRIFT/.test(w)) && fs.readFileSync(PJ(repo, "backend/lib/kelly.js"), "utf8") === "// a kelly.js that is not ours\n", r.why);
    }
    { const repo = mkRepo(); fs.rmSync(PJ(repo, "backend/progress-tests.js"));
      const r = D.make(deps(repo)).writeUnit({ to: "staged", gate: greenGate });
      ok("D8 a missing live file refuses", r.result === "refused" && r.why.some((w) => /is missing at home/.test(w)), r.why);
    }
    { const repo = mkRepo();
      const r = D.make(deps(repo)).writeUnit({ to: "staged", gate: redGate });
      ok("D9 a red gate refuses and nothing is written", r.result === "refused" && /did not pass/.test(r.why.join()) && !fs.existsSync(PJ(repo, "backend/lib/kelly.js")) && fs.readFileSync(PJ(repo, "backend/progress-tests.js"), "utf8") === BASE_PRINTER, r.why);
    }
    { const repo = mkRepo();
      const inSession = D.make(deps(repo, { now: () => THU_SESSION })).writeUnit({ to: "staged", gate: greenGate });
      const chainDue = D.make(deps(repo, { now: () => THU_EVENING })).writeUnit({ to: "staged", gate: greenGate });
      const chainDone = D.make(deps(repo, { now: () => THU_EVENING, chainStatus: () => ({ started: "2026-10-15T20:05:00Z", finished: "2026-10-15T20:40:00Z" }) })).writeUnit({ to: "staged", gate: greenGate });
      ok("D10 the clock fence: a trading weekday inside 05:30-16:00 MT refuses", inSession.result === "refused" && /05:30-16:00 MT/.test(inSession.why.join()), inSession.why);
      ok("D11 the chain fence: a session evening whose chain has not finished refuses; a finished chain does not", chainDue.result === "refused" && /close chain is due or running/.test(chainDue.why.join()) && chainDone.result === "done", { chainDue: chainDue.why, chainDone: chainDone.result });
      RB.rollback(deps(repo));
    }
    { const repo = mkRepo();
      const running = D.make(deps(repo, { listProcs: () => [{ pid: 4242, cmd: `node ${repo}/automation/close-chain.cjs` }] })).writeUnit({ to: "staged", gate: greenGate });
      const unreadable = D.make(deps(repo, { listProcs: () => { throw new Error("ps is not here"); } })).writeUnit({ to: "staged", gate: greenGate });
      const mail = D.make(deps(repo, { listProcs: () => [{ pid: 7, cmd: "node backend/mail-reports.js" }] })).writeUnit({ to: "staged", gate: greenGate });
      ok("D12 the process fence: the close chain running refuses", running.result === "refused" && /close-chain\.cjs is running/.test(running.why.join()), running.why);
      ok("D13 the process fence fails closed when the list cannot be read", unreadable.result === "refused" && /could not be read/.test(unreadable.why.join()), unreadable.why);
      ok("D14 the process fence covers the progress email too", mail.result === "refused" && /mail-reports\.js is running/.test(mail.why.join()), mail.why);
      ok("D15 nothing was written by any refused run", fs.readFileSync(PJ(repo, "backend/progress-tests.js"), "utf8") === BASE_PRINTER && !fs.existsSync(PJ(repo, "backend/lib/kelly.js")));
    }
    { // a tampered package copy refuses, and a tampered STAGED copy still allows a rollback
      const pkg2 = tmpDir("pkg"); for (const rel of ["base/backend/progress-tests.js", "staged/backend/progress-tests.js", "staged/backend/lib/kelly.js"]) { fs.mkdirSync(path.dirname(PJ(pkg2, rel)), { recursive: true }); fs.copyFileSync(PJ(PKG, rel), PJ(pkg2, rel)); }
      fs.appendFileSync(PJ(pkg2, "staged/backend/lib/kelly.js"), "// tampered\n");
      const repo = mkRepo();
      const r = D.make(deps(repo, { pkg: pkg2 })).writeUnit({ to: "staged", gate: greenGate });
      ok("D16 a tampered staged copy in the package refuses the apply", r.result === "refused" && /staged copy/.test(r.why.join()), r.why);
      const repo2 = mkRepo({ printer: STAGED_PRINTER, kelly: STAGED_KELLY });
      const rb = D.make(deps(repo2, { pkg: pkg2 })).writeUnit({ to: "base" });
      ok("D17 a tampered staged copy does NOT stop a rollback (only the base copy must be intact)", rb.result === "done" && fs.readFileSync(PJ(repo2, "backend/progress-tests.js"), "utf8") === BASE_PRINTER && !fs.existsSync(PJ(repo2, "backend/lib/kelly.js")), rb);
      fs.appendFileSync(PJ(pkg2, "base/backend/progress-tests.js"), "// tampered\n");
      const repo3 = mkRepo({ printer: STAGED_PRINTER, kelly: STAGED_KELLY });
      const rb2 = D.make(deps(repo3, { pkg: pkg2 })).writeUnit({ to: "base" });
      ok("D18 a tampered BASE copy stops the rollback", rb2.result === "refused" && /base copy/.test(rb2.why.join()), rb2.why);
    }
  }

  // ── E. mutation ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("E. mutation — every mutant is caught by a named check of B or C");
  {
    const KELLY_MUTANTS = [
      ["the cap and the floor removed", "const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);", "const clamp01 = (x) => x;"],
      ["the floor removed (a negative Kelly is printed)", "(x < 0 ? 0 : x > 1 ? 1 : x)", "(x > 1 ? 1 : x)"],
      ["the cap removed (150x capital is printed)", "(x < 0 ? 0 : x > 1 ? 1 : x)", "(x < 0 ? 0 : x)"],
      ["the population variance (n) instead of the sample one (n-1)", "return s / (a.length - 1);", "return s / a.length;"],
      ["the UPPER end of the interval instead of the lower", "const meanLo = m - z * se", "const meanLo = m + z * se"],
      ["half taken of the UNCAPPED fraction", "const half = full / 2, shrunkHalf = shrunkFull / 2;", "const half = rawFull / 2, shrunkHalf = shrunkFull / 2;"],
      ["the shrunk fraction divided by the sd, not the variance", "rawShrunk = meanLo / v;", "rawShrunk = meanLo / sd;"],
      ["the standard error without the sqrt(n)", "se = sd / Math.sqrt(n)", "se = sd"],
      ["a zero variance let through", "if (!(v > 0) || !Number.isFinite(v))", "if (!(v >= 0) || !Number.isFinite(v))"],
      ["one clustering unit let through", "if (returns.length < 2)", "if (returns.length < 1)"],
      ["a 90% interval where the spec says 80%", "const Z80 = probit(0.9);", "const Z80 = probit(0.95);"],
      ["clusterReturnsOf takes a single-value series", 'if (isNumArr(obj[k], 2)) return { returns: obj[k], key: k, reason: null };', 'if (isNumArr(obj[k], 1)) return { returns: obj[k], key: k, reason: null };'],
      ["clusterReturnsOf prefers clusterMeans over clusterReturns", 'const CLUSTER_KEYS = Object.freeze(["clusterReturns", "clusterMeans"', 'const CLUSTER_KEYS = Object.freeze(["clusterMeans", "clusterReturns"'],
    ];
    for (const [what, from, to] of KELLY_MUTANTS) {
      let caught = null;
      try { caught = kellyChecks(libTree(mutate(STAGED_KELLY, from, to))).filter((c) => !c.ok).map((c) => c.name.split(" ")[0]); }
      catch (e) { caught = ["threw: " + String(e && e.message).slice(0, 80)]; }
      ok(`E-kelly: ${what} — caught by ${caught && caught.length ? caught.join(", ") : "NOTHING"}`, caught && caught.length > 0);
    }
    const PRINTER_MUTANTS = [
      ["the Kelly line folded into the verdict cell", "<td>${esc(v.verdict)}</td><td>${kellyCell(v)}</td>", "<td>${esc(v.verdict)} ${kellyCell(v)}</td>"],
      ["the colspan of the empty row left at 3", 'colspan="4"', 'colspan="3"'],
      ["the column header dropped", "<th>Kelly (descriptive)</th>", ""],
      ["a reason printed in place of the em dash", 'return k.reason ? "&mdash;" : esc(k.text);', "return k.reason ? esc(k.reason) : esc(k.text);"],
      ["the seal's own series no longer beats its output file", 'if (!r.returns && v && typeof v.output === "string")', 'if (v && typeof v.output === "string")'],
      ["the output path guard removed (a file outside backend/data is read)", 'return /^data\\/[\\w.-]+(\\/[\\w.-]+)*\\.json$/.test(s) && !s.split("/").includes("..") ? rd(s.slice(5)) : null;', 'return rd(s.replace(/^data\\//, ""));'],
      ["a 99% interval forced at the call site", "const k = K.kellyLine(r.returns);", "const k = K.kellyLine(r.returns, { conf: 0.99 });"],
      ["the sample cell fed from Kelly", '<td>${esc(v.sessions ?? "")} ${esc(v.unit || "")}</td>', '<td>${esc(v.sessions ?? "")} ${esc(v.unit || "")} ${kellyCell(v)}</td>'],
    ];
    for (const [what, from, to] of PRINTER_MUTANTS) {
      let caught = null;
      try { caught = printerChecks({ printerText: mutate(STAGED_PRINTER, from, to) }).filter((c) => !c.ok).map((c) => c.name.split(" ")[0]); }
      catch (e) { caught = ["threw: " + String(e && e.message).slice(0, 80)]; }
      ok(`E-printer: ${what} — caught by ${caught && caught.length ? caught.join(", ") : "NOTHING"}`, caught && caught.length > 0);
    }
    ok("E-control: the UNMUTATED staged files pass every check of B and C (a mutation test that cannot pass proves nothing)",
      kellyChecks(K).every((c) => c.ok) && printerChecks().every((c) => c.ok));
  }

  // ── F. record.cjs ────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("F. record.cjs");
  {
    const SAT = () => Date.parse("2026-10-17T18:00:00Z"), INWIN = () => Date.parse("2026-10-15T20:00:00Z"); // Thu 14:00 MT
    const quiet = () => {};
    const mkData = ({ cr = [], ledger = "" } = {}) => { const d = tmpDir("rec"); writeJsonAtomic(path.join(d, "change-registry.json"), cr); fs.writeFileSync(path.join(d, "agent-ledger.jsonl"), ledger); return d; };
    const mkApplied = () => { const r = tmpDir("repoR"); fs.mkdirSync(PJ(r, "backend/lib"), { recursive: true }); fs.writeFileSync(PJ(r, "backend/progress-tests.js"), STAGED_PRINTER); fs.writeFileSync(PJ(r, "backend/lib/kelly.js"), STAGED_KELLY); fs.copyFileSync(PJ(REPO, "backend/lib/atomic-write.js"), PJ(r, "backend/lib/atomic-write.js")); return r; };
    const R = REC.records({ nowMs: Date.parse("2026-10-16T22:00:00Z"), mtDate: "2026-10-16" });
    ok("F1 the row says what changed, what did not, and that it does not break comparability",
      R.row.id === REC.CR_ID && R.row.breaksComparability === false && R.row.tests.length === 0 &&
      /byte for byte/.test(R.row.doesNotChange) && /verdict/.test(R.row.doesNotChange) && /bar/.test(R.row.doesNotChange) &&
      R.row.files["backend/lib/kelly.js"].before === null && R.row.files["backend/progress-tests.js"].before === D.FILES[1].baseSha &&
      R.line.kind === "GOVERNANCE" && R.line.changeRegistry === REC.CR_ID, R.row);
    { const repo = mkApplied(), dataDir = mkData();
      const r = REC.run({ dataDir, repo, dry: true, now: SAT, holidays: {}, log: quiet });
      ok("F2 --dry on a clean tree writes nothing and would go through", r.code === 0 && r.result === "dry" && r.wouldRefuse.length === 0 && JSON.parse(fs.readFileSync(path.join(dataDir, "change-registry.json"), "utf8")).length === 0 && fs.readFileSync(path.join(dataDir, "agent-ledger.jsonl"), "utf8") === "", r.result);
      const w = REC.run({ dataDir, repo, now: SAT, holidays: {}, log: quiet });
      const cr = JSON.parse(fs.readFileSync(path.join(dataDir, "change-registry.json"), "utf8")), led = fs.readFileSync(path.join(dataDir, "agent-ledger.jsonl"), "utf8").trim().split("\n");
      ok("F3 the write adds one row and one GOVERNANCE line, each read back", w.code === 0 && w.result === "written" && cr.length === 1 && cr[0].id === REC.CR_ID && led.length === 1 && JSON.parse(led[0]).changeRegistry === REC.CR_ID, w.result);
      const again = REC.run({ dataDir, repo, now: SAT, holidays: {}, log: quiet });
      ok("F4 a second run is 'already recorded' and writes nothing", again.code === 0 && again.result === "already" && JSON.parse(fs.readFileSync(path.join(dataDir, "change-registry.json"), "utf8")).length === 1, again.result);
      ok("F5 no lock file is left behind", !fs.existsSync(path.join(dataDir, "registry-write.lock")));
    }
    { const repo = mkApplied(), dataDir = mkData();
      const r = REC.run({ dataDir, repo, now: INWIN, holidays: {}, log: quiet });
      ok("F6 the 13:50-15:50 MT no-write window on a trading day refuses", r.code === 2 && r.result === "refused" && JSON.parse(fs.readFileSync(path.join(dataDir, "change-registry.json"), "utf8")).length === 0);
    }
    { const repo = tmpDir("repoB"); fs.mkdirSync(PJ(repo, "backend/lib"), { recursive: true }); fs.writeFileSync(PJ(repo, "backend/progress-tests.js"), BASE_PRINTER);
      const dataDir = mkData();
      const r = REC.run({ dataDir, repo, now: SAT, holidays: {}, log: quiet });
      ok("F7 home not applied refuses (a change is recorded after it is in)", r.code === 2 && r.result === "refused" && JSON.parse(fs.readFileSync(path.join(dataDir, "change-registry.json"), "utf8")).length === 0);
    }
    { const repo = mkApplied(), dataDir = mkData();
      fs.writeFileSync(path.join(dataDir, "registry-write.lock"), JSON.stringify({ token: "someone-else" }) + "\n");
      const r = REC.run({ dataDir, repo, now: SAT, holidays: {}, log: quiet, lockWaitMs: 5, sleep: () => {} });
      ok("F8 another writer's lock refuses, is never removed, and nothing is written",
        r.code === 2 && r.result === "refused" && fs.existsSync(path.join(dataDir, "registry-write.lock")) && JSON.parse(fs.readFileSync(path.join(dataDir, "change-registry.json"), "utf8")).length === 0, r.lines && r.lines.slice(-1));
    }
    { const repo = mkApplied(), dataDir = mkData({ cr: [{ id: REC.CR_ID }] });
      const r = REC.run({ dataDir, repo, now: SAT, holidays: {}, log: quiet });
      ok("F9 half a record already there refuses, saying which half", r.code === 2 && r.result === "refused" && /a PART of this record/.test(r.lines.join(" ")));
    }
    { const r = cp.spawnSync(process.execPath, [path.join("docs", "kelly-column", "2026-10-16", "record.cjs"), "--dry"], { cwd: REPO, encoding: "utf8", windowsHide: true, timeout: 120000 });
      // in this clean copy backend/data holds only test-registry.json, so --dry refuses (exit 2) at the first file it cannot
      // read — before any clock, lock or write. That is the documented behaviour, and it writes nothing.
      ok("F10 record.cjs --dry on this clean copy writes nothing and refuses for the right reason (change-registry.json is not in a clean copy)",
        r.status === 2 && /REFUSED — nothing written: change-registry\.json cannot be read \(ENOENT\)/.test(String(r.stdout) + String(r.stderr)) && !fs.existsSync(PJ(REPO, "backend/data/change-registry.json")) && !fs.existsSync(PJ(REPO, "backend/data/registry-write.lock")),
        { status: r.status, tail: String(r.stdout).trim().split("\n").slice(-2) });
    }
  }

  rmAll();
  console.log(failN ? `\n${failN} OF ${pass + failN} CHECKS FAILED: ${failed.join(" | ")}` : `\nALL ${pass} CHECKS PASSED`);
  process.exitCode = failN ? 1 : 0;
})().catch((e) => { try { rmAll(); } catch { /* temp */ } console.log(`  FAIL the selftest crashed — ${e && e.stack ? e.stack : e}`); console.log(`\n${failN + 1} OF ${pass + failN + 1} CHECKS FAILED (crash)`); process.exitCode = 1; });
