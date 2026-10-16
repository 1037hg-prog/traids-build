#!/usr/bin/env node
"use strict";
/**
 * R275 + R192 FORWARD SHADOWS (2026-10-16) — SELFTEST. Known-answer tests on small fixtures. No network, no broker,
 * no clock of its own (every run is given a fixed `now`), nothing outside its own scratch directory.
 *
 *   node docs/r275-r192-shadows/2026-10-16/selftest.cjs
 *
 * WHAT IT PROVES, in four groups:
 *   A  the record          shadow-ledger.js: append-only, one row per kind+key, re-running adds nothing, a holed
 *                          record throws rather than shrinking the sample, ET session dates across the DST change.
 *   B  the rules           the two decision expressions of R275 and the whole of R192's arithmetic are held to the
 *                          SEALED READS in two independent ways: the text of each expression must appear in both
 *                          files, and the sealed text is EVALUATED out of those files and run against this package's
 *                          functions over a grid of cases — if either copy of the rule is edited, this fails.
 *                          Plus hand-computed answers for the exposure rule, the window excess, Welch and the t.
 *   C  the shadows         both runners end to end on fixtures: the rows they write, the hand-computed forward
 *                          statistics, idempotency, the gap rows, the grace rule, and — structurally — that a run
 *                          touches NO file but its own two, and that any network call throws.
 *   D  the package         deploy/rollback on a scratch tree: create, drift refusal, the selftest gate, the fences
 *                          (clock, close chain, unreadable process list), rollback's unwiring refusal, and
 *                          record.cjs --dry writing nothing.
 *
 * The last line is "ALL <n> CHECKS PASSED" — deploy.cjs --apply refuses unless it reads exactly that.
 */
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");
const STAGED = path.join(PKG, "staged", "backend");
const SEALED_R275 = path.join(REPO, "backend", "r275-release-filter.js");
const SEALED_R192 = path.join(REPO, "backend", "r192-bond-month-end.js");

let N = 0; const FAIL = [];
function check(name, fn) {
  N++;
  try { fn(); } catch (e) { FAIL.push(`${name}: ${e && e.message ? e.message : e}`); console.log(`  FAIL  ${name}\n        ${e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n        ") : e}`); return; }
  console.log(`  ok    ${name}`);
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
const near = (a, b, tol, what) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${what}: got ${a}, want ${b} (tol ${tol})`); };
const ok = (c, what) => { if (!c) throw new Error(what); };
const throws = (fn, re, what) => { let t = null; try { fn(); } catch (e) { t = e; } if (!t) throw new Error(`${what}: nothing threw`); if (re && !re.test(String(t.message))) throw new Error(`${what}: threw ${t.message}`); };
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

// ── the scratch tree: the staged files beside the repo's own lib, with a data/ of fixtures ────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "r275-r192-shadows-"));
const SB = path.join(TMP, "backend"), SDATA = path.join(SB, "data");
fs.mkdirSync(path.join(SB, "lib"), { recursive: true });
fs.mkdirSync(SDATA, { recursive: true });
for (const f of ["r275-release-shadow.js", "r192-month-end-shadow.js"]) fs.copyFileSync(path.join(STAGED, f), path.join(SB, f));
fs.copyFileSync(path.join(STAGED, "lib", "shadow-ledger.js"), path.join(SB, "lib", "shadow-ledger.js"));
fs.copyFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"), path.join(SB, "lib", "atomic-write.js"));
fs.copyFileSync(SEALED_R275, path.join(SB, "r275-release-filter.js"));
fs.copyFileSync(SEALED_R192, path.join(SB, "r192-bond-month-end.js"));
const { writeJsonAtomic } = require(path.join(SB, "lib", "atomic-write.js"));

const SL = require(path.join(SB, "lib", "shadow-ledger.js"));
const R275 = require(path.join(SB, "r275-release-shadow.js"));
const R192 = require(path.join(SB, "r192-month-end-shadow.js"));

const sealedText275 = fs.readFileSync(SEALED_R275, "utf8"), sealedText192 = fs.readFileSync(SEALED_R192, "utf8");
const shadowText275 = fs.readFileSync(path.join(STAGED, "r275-release-shadow.js"), "utf8");
const shadowText192 = fs.readFileSync(path.join(STAGED, "r192-month-end-shadow.js"), "utf8");
const shadowTextLedger = fs.readFileSync(path.join(STAGED, "lib", "shadow-ledger.js"), "utf8");
/** the three staged files with their comments taken out — what the banned-token scans below read */
let CODE = null;   // filled once codeOnly is defined

/**
 * the initialiser of a declaration, wherever it sits on a line: `const mean = ...`, and `sd = ...` further along
 * the same `const a = ..., b = ...;` (which is how the sealed reads declare their statistics). Brackets and quotes
 * are balanced, so the scan stops at the declaration's OWN comma or semicolon and nowhere else.
 */
function declSrc(text, name) {
  let i = -1, head = "";
  for (const p of [`const ${name} = `, `let ${name} = `, `, ${name} = `]) { const k = text.indexOf(p); if (k >= 0 && (i < 0 || k < i)) { i = k; head = p; } }
  if (i < 0) throw new Error(`the declaration of ${name} was not found`);
  let j = i + head.length, depth = 0, q = null;
  for (; j < text.length; j++) {
    const c = text[j];
    if (q) { if (c === "\\") { j++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (depth === 0) break; depth--; }
    else if ((c === "," || c === ";" || c === "\n") && depth === 0) break;
  }
  return text.slice(i + head.length, j).trim();
}
/**
 * the file with its comments taken out, so a banned token in prose ("never writes read-seals.json") is not read as
 * code. Strings are respected; a regex literal holding "//" or "/*" would confuse it, and none of the three staged
 * files has one (the selftest would fail loudly rather than quietly pass if that changed, because the scan below
 * also runs over the raw text for the sentences it expects to find).
 */
function codeOnly(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") { const q = c; out += c; i++; while (i < src.length) { if (src[i] === "\\") { out += src[i] + (src[i + 1] || ""); i += 2; continue; } out += src[i]; const done = src[i] === q; i++; if (done) break; } continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}
/** the source of `function NAME(...) {...}` as one line */
function fnSrc(text, name) {
  const head = `function ${name}(`, i = text.indexOf(head);
  if (i < 0) throw new Error(`function ${name} not found`);
  const nl = text.indexOf("\n", i);
  return text.slice(i, nl === -1 ? text.length : nl).trim();
}
const squash = (s) => s.replace(/\s+/g, " ").trim();
CODE = [["shadow-ledger.js", codeOnly(shadowTextLedger)], ["r275-release-shadow.js", codeOnly(shadowText275)], ["r192-month-end-shadow.js", codeOnly(shadowText192)]];

console.log(`R275 + R192 forward shadows — selftest (scratch ${TMP})\n`);

// ══ A — the record ════════════════════════════════════════════════════════════════════════════════════════════
const LF = path.join(TMP, "ledger-a.jsonl");
check("A1 readRows on a file that is not there is an empty record", () => { eq(SL.readRows(path.join(TMP, "nope.jsonl")).length, 0, "rows"); });
check("A2 appendRows writes the rows and stamps ts", () => {
  const r = SL.appendRows(LF, [{ kind: "session", key: "2026-11-05", v: 1 }, { kind: "session", key: "2026-11-06", v: 2 }], { now: Date.parse("2026-11-07T00:00:00Z") });
  eq(r.appended.length, 2, "appended"); eq(r.skipped.length, 0, "skipped");
  const rows = SL.readRows(LF); eq(rows.length, 2, "rows"); eq(rows[0].ts, "2026-11-07T00:00:00.000Z", "ts"); eq(rows[1].v, 2, "v");
});
check("A3 a key already in the record is never written twice", () => {
  const before = fs.readFileSync(LF, "utf8");
  const r = SL.appendRows(LF, [{ kind: "session", key: "2026-11-05", v: 99 }], { now: 0 });
  eq(r.appended.length, 0, "appended"); eq(r.skipped.length, 1, "skipped");
  eq(fs.readFileSync(LF, "utf8"), before, "the file is untouched");
});
check("A4 a duplicate key inside one batch is written once", () => {
  const f = path.join(TMP, "ledger-b.jsonl");
  const r = SL.appendRows(f, [{ kind: "run", key: "d" }, { kind: "run", key: "d" }, { kind: "run", key: "e" }], { now: 0 });
  eq(r.appended.length, 2, "appended"); eq(SL.readRows(f).length, 2, "rows");
});
check("A5 a row without a kind or a key is refused", () => {
  throws(() => SL.appendRows(path.join(TMP, "x.jsonl"), [{ key: "a" }], { now: 0 }), /string kind/, "no kind");
  throws(() => SL.appendRows(path.join(TMP, "x.jsonl"), [{ kind: "a" }], { now: 0 }), /string key/, "no key");
  eq(fs.existsSync(path.join(TMP, "x.jsonl")), false, "nothing was created");
});
check("A6 a holed record throws rather than becoming a smaller sample", () => {
  const f = path.join(TMP, "ledger-c.jsonl");
  fs.writeFileSync(f, '{"kind":"run","key":"a"}\nnot json\n{"kind":"run","key":"b"}\n');
  throws(() => SL.readRows(f), /is not JSON/, "holed record");
});
check("A7 ET session dates, both sides of the DST change", () => {
  eq(SL.etDate(Date.parse("2026-11-05T01:30:00Z")), "2026-11-04", "EST (UTC-5)");
  eq(SL.etParts(Date.parse("2026-11-05T01:30:00Z")).time, "20:30", "EST time");
  eq(SL.etDate(Date.parse("2026-07-05T01:30:00Z")), "2026-07-04", "EDT (UTC-4)");
  eq(SL.etParts(Date.parse("2026-07-05T01:30:00Z")).time, "21:30", "EDT time");
});
check("A8 a start row needs a real evidence start, and is found again", () => {
  throws(() => SL.startRow({ test: "R1", evidenceStart: "nope" }), /YYYY-MM-DD/, "bad date");
  const s = SL.startRow({ test: "R1", evidenceStart: "2026-11-01", ruleSource: "x.js", ruleSha: null, spec: "s", note: "n" });
  eq(SL.startOf([{ kind: "run", key: "a" }, s]).evidenceStart, "2026-11-01", "startOf");
  eq(SL.startOf([{ kind: "run", key: "a" }]), null, "no start row");
});

// ══ B — the rules, held to the sealed reads ═══════════════════════════════════════════════════════════════════
const EV_T = R275.releaseSets({ CPI: ["2026-11-10", "2026-11-25"], NFP: [{ date: "2026-11-06" }], FOMC: ["2026-11-05", { d: "2026-11-18" }, "2026-12-16"] });

check("B1 R275's two decision expressions appear verbatim in the sealed read AND in the shadow", () => {
  const A = "types.some((k) => EV[k].has(d))";
  const B = "(d > r.d || (k === \"FOMC\" && d === r.d)) && d <= r.expiry";
  for (const [what, s] of [["anyRelease", A], ["exposedTo", B]]) {
    ok(sealedText275.includes(s), `${what} is not in backend/r275-release-filter.js as written here — the rule moved; re-derive this package`);
    ok(shadowText275.includes(s), `${what} is not in the staged shadow`);
  }
});
check("B2 R275's statistics appear verbatim in both files (mean, vr, tOne, welch)", () => {
  for (const name of ["mean", "vr", "tOne", "welch"]) {
    const a = squash(declSrc(sealedText275, name)), b = squash(declSrc(shadowText275, name));
    eq(b, a, `${name} differs from the sealed read`);
  }
});
check("B3 R275's rule, EVALUATED out of the sealed read, agrees with the shadow on every case in a grid", () => {
  const sealedAny = new Function("EV", `return (${declSrc(sealedText275, "anyRelease")});`)(EV_T);
  const sealedExp = new Function("EV", `return (${declSrc(sealedText275, "exposedTo")});`)(EV_T);
  const days = [];
  for (let i = 1; i <= 31; i++) days.push(`2026-11-${String(i).padStart(2, "0")}`, `2026-12-${String(i).padStart(2, "0")}`);
  const typeSets = [["CPI", "NFP", "FOMC"], ["CPI"], ["NFP"], ["FOMC"], ["CPI", "FOMC"]];
  let n = 0;
  for (const d of days) for (const ts of typeSets) {
    eq(R275.anyRelease(EV_T, d, ts), sealedAny(d, ts), `anyRelease(${d}, ${ts})`);
    for (const e of days) { const w = { d, expiry: e }; eq(R275.exposedTo(EV_T, w, ts), sealedExp(w, ts), `exposedTo(${d}->${e}, ${ts})`); n++; }
  }
  ok(n >= 15000, `only ${n} exposure cases compared`);
});
check("B4 R275 exposure — the hand-reasoned cases, including the FOMC-on-the-entry-day asymmetry", () => {
  const E = (d, expiry) => R275.exposedTo(EV_T, { d, expiry });
  eq(E("2026-11-18", "2026-11-18"), true, "FOMC ON the entry day, expiring that day, IS exposed");
  eq(E("2026-11-25", "2026-11-27"), false, "a CPI on the entry day is NOT exposure (only FOMC is)");
  eq(E("2026-11-09", "2026-11-10"), true, "a CPI after entry and on the expiry day is exposure");
  eq(E("2026-11-09", "2026-11-09"), false, "nothing between entry and expiry");
  eq(E("2026-11-05", "2026-11-04"), false, "an expiry before the entry exposes nothing, FOMC on the day or not");
  eq(R275.anyRelease(EV_T, "2026-11-05"), true, "FOMC day");
  eq(R275.anyRelease(EV_T, "2026-11-10"), true, "CPI day");
  eq(R275.anyRelease(EV_T, "2026-11-11"), false, "an ordinary session");
  eq(JSON.stringify(R275.releaseTypesOn(EV_T, "2026-11-06")), '["NFP"]', "the type named");
});
check("B5 R275 event dates are read in all three shapes the sealed read accepts, and bounded", () => {
  eq(EV_T.NFP.has("2026-11-06"), true, "{date}"); eq(EV_T.FOMC.has("2026-11-18"), true, "{d}"); eq(EV_T.CPI.has("2026-11-10"), true, "string");
  const bounded = R275.releaseSets({ CPI: ["2026-01-10", "2026-11-10"] }, { from: "2026-06-01", to: "2026-12-31" });
  eq(bounded.CPI.size, 1, "out-of-window dates dropped"); eq(bounded.NFP.size, 0, "a missing series is empty, not an error");
  eq(R275.calendarCover(EV_T).from, "2026-11-05", "cover from"); eq(R275.calendarCover(EV_T).to, "2026-12-16", "cover to");
});
check("B6 R275 statistics — hand-computed answers", () => {
  near(R275.welch([-1, -3], [1, 3]), -4 / Math.sqrt(2), 1e-12, "welch of means -2 and 2, each var 2");
  near(R275.tOne([-1, -2, -3]), -2 / Math.sqrt(1 / 3), 1e-12, "tOne of -1,-2,-3");
  eq(R275.tOne([1, 2]), null, "fewer than three observations is not a t");
  eq(R275.welch([1], [1, 2]), null, "a one-sided single observation is not a t");
  near(R275.vr([1, 3]), 2, 1e-12, "sample variance uses n-1");
});

check("B7 R192's arithmetic is the sealed read's, line for line (excessAt, lastStart, mulberry)", () => {
  eq(squash(declSrc(shadowText192, "excessAt")), squash(declSrc(sealedText192, "excessAt")), "excessAt differs from the sealed read");
  eq(squash(declSrc(shadowText192, "lastStart")), squash(declSrc(sealedText192, "lastStart")), "lastStart differs");
  eq(squash(fnSrc(shadowText192, "mulberry")), squash(fnSrc(sealedText192, "mulberry")), "mulberry differs");
  for (const name of ["mean", "sd"]) eq(squash(declSrc(shadowText192, name)), squash(declSrc(sealedText192, name)), `${name} differs`);
  eq(squash(declSrc(shadowText192, "tOf")), squash(declSrc(sealedText192, "tOf")), "tOf differs");
});
check("B8 R192's registered constants are the sealed read's (2 bps a side, >= 15 returns, the placebo draw)", () => {
  eq(declSrc(sealedText192, "COST"), "0.0004", "the sealed read's cost moved");
  eq(declSrc(shadowText192, "COST"), declSrc(sealedText192, "COST"), "the shadow's cost is not the sealed read's");
  eq(R192.COST, 0.0004, "COST"); eq(R192.MIN_RETURNS, 15, "MIN_RETURNS"); eq(R192.DRAWS, 200, "DRAWS"); eq(R192.SEED_BASE, 192000, "SEED_BASE");
  ok(sealedText192.includes(">= 15"), "the sealed read's >= 15 month filter moved");
  ok(sealedText192.includes("mulberry(192000 + k)") && shadowText192.includes("mulberry(SEED_BASE + k)") && /SEED_BASE = 192000/.test(shadowText192), "the placebo seed moved");
  const draw = "Math.floor(rng() * (a.length - 4))";
  ok(sealedText192.includes(draw) && shadowText192.includes(draw), "the placebo's window draw moved");
  ok(sealedText192.includes("draws[Math.floor(0.95 * draws.length)]") && shadowText192.includes("draws[Math.floor(0.95 * draws.length)]"), "the placebo's p95 index moved");
});
check("B9 R192's excessAt, EVALUATED out of the sealed read, agrees with the shadow on 2000 random months", () => {
  const sealedExcess = new Function("mean", "COST", `return (${declSrc(sealedText192, "excessAt")});`)(R192.mean, 0.0004);
  const rng = R192.mulberry(7);
  for (let k = 0; k < 2000; k++) {
    const n = 16 + Math.floor(rng() * 8), a = Array.from({ length: n }, () => (rng() - 0.5) * 0.04);
    const start = Math.floor(rng() * (n - 4));
    eq(R192.excessAt(a, start), sealedExcess(a, start), `excessAt at draw ${k}`);
  }
});
check("B10 R192's mulberry produces the sealed read's stream, bit for bit", () => {
  const sealedMul = new Function(`${fnSrc(sealedText192, "mulberry")}; return mulberry;`)();
  for (const seed of [192000, 192001, 192199, 0, 42]) {
    const a = R192.mulberry(seed), b = sealedMul(seed);
    for (let i = 0; i < 50; i++) eq(a(), b(), `mulberry(${seed})[${i}]`);
  }
});
check("B11 R192 window excess — three exact hand-computed answers", () => {
  near(R192.excessAt([...Array(15).fill(0), ...Array(5).fill(0)], 15), -0.0004, 1e-18, "a flat month costs exactly the 2 bps a side");
  near(R192.excessAt([...Array(15).fill(0), ...Array(5).fill(0.25)], 15), 1.25 ** 5 - 1 - 0.0004, 1e-15, "window 1.25^5 - 1, no drift");
  near(R192.excessAt([...Array(15).fill(0.5), ...Array(5).fill(0)], 15), -2.5 - 0.0004, 1e-15, "no window move, drift 5 x 0.5");
  eq(R192.lastStart(Array(21).fill(0)), 16, "the window starts five returns from the end");
});
check("B12 R192 month admission and completeness", () => {
  const mk = (n) => Array.from({ length: n + 1 }, (_, i) => ({ d: `2026-11-${String(i + 1).padStart(2, "0")}`, c: 100 }));
  const { byM } = R192.byMonth({ AGG: mk(14), LQD: mk(20), MUB: mk(20), HYG: mk(20) });
  eq(R192.admittedMonths(byM).length, 0, "a primary fund with 14 returns excludes the month");
  const { byM: b2 } = R192.byMonth({ AGG: mk(15), LQD: mk(15), MUB: mk(15), HYG: mk(2) });
  eq(JSON.stringify(R192.admittedMonths(b2)), '["2026-11"]', "15 returns in every primary fund admits it; HYG does not gate");
  eq(R192.monthComplete(b2, "2026-11"), false, "no later month yet");
});
check("B13 R192 builds a month's first return from the previous month's last close", () => {
  const bars = { AGG: [{ d: "2026-10-30", c: 100 }, { d: "2026-11-02", c: 101 }, { d: "2026-11-03", c: 101 }] };
  const { byM } = R192.byMonth(bars);
  eq(byM.AGG["2026-11"].length, 2, "two November returns");
  near(byM.AGG["2026-11"][0].r, 0.01, 1e-12, "the first November return is measured from 2026-10-30's close");
  eq(byM.AGG["2026-10"], undefined, "the very first bar of the series carries no return");
});
check("B14 R192 plannedWindow is the month's last five scheduled sessions", () => {
  const s = Array.from({ length: 21 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
  const pw = R192.plannedWindow(s);
  eq(pw.exitDay, "2026-11-21", "exit"); eq(pw.firstLongDay, "2026-11-17", "first long day"); eq(pw.entryDay, "2026-11-16", "entry (the close before)");
  eq(pw.window.length, 5, "five sessions");
  eq(R192.plannedWindow(["a", "b"]), null, "a month with no non-window day has no window");
  eq(R192.plannedWindow(undefined), null, "no calendar, no window");
});

// ══ C — the shadows, end to end on fixtures ═══════════════════════════════════════════════════════════════════
const NOW_275 = Date.parse("2026-12-02T22:00:00Z");          // ET 2026-12-02 17:00
const T275 = {
  cal: { CPI: ["2026-11-10", "2026-11-25"], NFP: [{ date: "2026-11-06" }], FOMC: ["2026-11-05", { d: "2026-11-18" }, "2026-12-16"] },
  log: [
    { id: "Z1", strategy: "R25-0dte", sym: "SPY", openedAt: Date.parse("2026-11-03T14:30:00Z"), closedAt: Date.parse("2026-11-03T21:00:00Z"), rMult: 0.2, pnl: 20 },
    { id: "Z2", strategy: "R25-0dte", sym: "SPY", openedAt: Date.parse("2026-11-05T14:30:00Z"), closedAt: Date.parse("2026-11-05T21:00:00Z"), rMult: -0.5, pnl: -50 },
    { id: "Z3", strategy: "R25-0dte", sym: "SPY", openedAt: Date.parse("2026-11-05T15:30:00Z"), closedAt: Date.parse("2026-11-05T21:00:00Z"), rMult: -1.5, pnl: -150 },
    { id: "Z4", strategy: "R25-0dte", sym: "SPY", openedAt: Date.parse("2026-11-06T14:30:00Z"), closedAt: Date.parse("2026-11-06T21:00:00Z"), rMult: -3, pnl: -300 },
    { id: "Z5", strategy: "R25-0dte", sym: "SPY", openedAt: Date.parse("2026-11-09T14:30:00Z"), closedAt: Date.parse("2026-11-09T21:00:00Z"), rMult: 1, pnl: 100 },
    { id: "Z6", strategy: "R25-0dte", sym: "SPY", openedAt: Date.parse("2026-11-12T14:30:00Z"), closedAt: Date.parse("2026-11-12T21:00:00Z"), rMult: 3, pnl: 300 },
    { id: "ZC", strategy: "R25-0dte", sym: "SPY", ctrl: true, openedAt: Date.parse("2026-11-12T14:30:00Z"), closedAt: Date.parse("2026-11-12T21:00:00Z"), rMult: 99, pnl: 9999 },
    { id: "W_A_e", strategy: "R21-premium", sym: "SPY", openedAt: Date.parse("2026-11-09T14:35:00Z"), closedAt: Date.parse("2026-11-10T20:00:00Z"), obs: { optExpiry: "2026-11-10" }, rMult: -0.5, pnl: -50 },
    { id: "W_A_u", strategy: "R21-premium", sym: "QQQ", openedAt: Date.parse("2026-11-09T14:35:00Z"), closedAt: Date.parse("2026-11-09T20:00:00Z"), obs: { optExpiry: "2026-11-09" }, rMult: 0.5, pnl: 50 },
    { id: "W_B_e", strategy: "R21-premium", sym: "SPY", openedAt: Date.parse("2026-11-11T14:35:00Z"), closedAt: Date.parse("2026-11-18T20:00:00Z"), obs: { optExpiry: "2026-11-18" }, rMult: -1, pnl: -100 },
    { id: "W_B_u", strategy: "R21-premium", sym: "QQQ", openedAt: Date.parse("2026-11-11T14:35:00Z"), closedAt: Date.parse("2026-11-13T20:00:00Z"), obs: { optExpiry: "2026-11-13" }, rMult: 1, pnl: 100 },
    { id: "W_C_e", strategy: "R21-premium", sym: "SPY", openedAt: Date.parse("2026-11-19T14:35:00Z"), closedAt: Date.parse("2026-11-25T20:00:00Z"), obs: { optExpiry: "2026-11-25" }, rMult: -1.5, pnl: -150 },
    { id: "W_C_u", strategy: "R21-premium", sym: "QQQ", openedAt: Date.parse("2026-11-19T14:35:00Z"), closedAt: Date.parse("2026-11-20T20:00:00Z"), obs: { optExpiry: "2026-11-20" }, rMult: 1.5, pnl: 150 },
    { id: "W_F", strategy: "R21-premium", sym: "IWM", openedAt: Date.parse("2026-11-18T14:35:00Z"), closedAt: Date.parse("2026-11-18T20:00:00Z"), obs: { optExpiry: "2026-11-18" }, rMult: -0.25, pnl: -25 },
    { id: "W_K", strategy: "R21-premium", sym: "IWM", openedAt: Date.parse("2026-11-25T14:35:00Z"), closedAt: Date.parse("2026-11-27T20:00:00Z"), obs: { optExpiry: "2026-11-27" }, rMult: 0.25, pnl: 25 },
  ],
  board: [
    { id: "Z7", strategy: "R25-0dte", sym: "SPY", addedAt: Date.parse("2026-11-20T14:30:00Z") },
    { id: "Z8", strategy: "R25-0dte", sym: "SPY", addedAt: Date.parse("2026-11-30T14:30:00Z") },
    { id: "W_O", strategy: "R21-premium", sym: "SPY", addedAt: Date.parse("2026-12-01T14:35:00Z"), optExpiry: "2026-12-18" },
    { id: "W_B_u", strategy: "R21-premium", sym: "QQQ", addedAt: Date.parse("2026-11-11T14:35:00Z"), optExpiry: "2026-11-13" },
    { id: "ZX", strategy: "R24-13F-clone", sym: "AAPL", addedAt: Date.parse("2026-11-12T14:30:00Z") },
    { id: "ZR", strategy: "R25-0dte", sym: "SPY", ctrlRand: true, addedAt: Date.parse("2026-11-12T14:30:00Z") },
  ],
};
writeJsonAtomic(path.join(SDATA, "macro-calendar.json"), T275.cal);
writeJsonAtomic(path.join(SDATA, "trade_log.json"), T275.log);
writeJsonAtomic(path.join(SDATA, "board_positions.json"), T275.board);
writeJsonAtomic(path.join(SDATA, "test-registry.json"), { spec: "fixture", preregistered: [{ id: "R192", bar: { tRequired: 2.356 } }] });

check("C1 R275 population: only the two sleeves, no control twins, closed beats open, obs.optExpiry found", () => {
  const T = R275.sleeveTickets({ tradeLog: T275.log, board: T275.board });
  eq(T.filter((t) => t.id === "ZC" || t.id === "ZR" || t.id === "ZX").length, 0, "control twins and other strategies are out");
  eq(T.filter((t) => t.id === "W_B_u").length, 1, "the duplicate id appears once");
  eq(T.find((t) => t.id === "W_B_u").state, "closed", "the settled copy wins over the open one");
  eq(T.find((t) => t.id === "W_A_e").expiry, "2026-11-10", "obs.optExpiry");
  eq(T.find((t) => t.id === "W_O").expiry, "2026-12-18", "a board wing's own optExpiry");
  eq(T.find((t) => t.id === "W_O").d, "2026-12-01", "an open position's addedAt is its entry session");
  eq(T.find((t) => t.id === "Z7").R, null, "an unsettled ticket has no R");
  eq(T.find((t) => t.id === "Z2").R, -0.5, "rMult is the R — net P&L over the defined max loss");
});

const JL275 = path.join(SDATA, "r275-release-shadow.jsonl"), OUT275 = path.join(SDATA, "r275-release-shadow.json");
let run275 = null;
check("C2 R275 forward shadow writes the sessions, the gap and the cells a month of fixtures implies", () => {
  SL.appendRows(JL275, [SL.startRow({ test: "R275", spec: "x", evidenceStart: "2026-11-01", ruleSource: "r275-release-filter.js", ruleSha: null, note: "seeded by the selftest" })], { now: Date.parse("2026-11-01T22:00:00Z") });
  const noFetch = () => { throw new Error("a shadow must make no network call"); };
  const realFetch = globalThis.fetch; globalThis.fetch = noFetch;
  try { run275 = R275.run({ now: NOW_275, log: () => {} }); } finally { globalThis.fetch = realFetch; }
  const rows = SL.readRows(JL275);
  const S = rows.filter((r) => r.kind === "session");
  eq(S.length, 14, "session rows");
  eq(S.filter((r) => r.gap).length, 1, "gap rows");
  eq(S.find((r) => r.gap).key, "2026-11-03", "the gap is the session the macro calendar does not reach");
  eq(JSON.stringify(S.filter((r) => !r.gap).map((r) => r.key)), JSON.stringify(["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-25", "2026-11-27", "2026-12-01"]), "the sessions recorded");
  eq(rows.filter((r) => r.kind === "wing-cell").length, 5, "wing cells");
  eq(rows.filter((r) => r.kind === "run").length, 1, "run rows");
  eq(rows.filter((r) => r.kind === "start").length, 1, "the start row is not written twice");
});
check("C3 R275 session rows say what the filter would have done, with the day's releases named", () => {
  const S = Object.fromEntries(SL.readRows(JL275).filter((r) => r.kind === "session").map((r) => [r.key, r]));
  eq(S["2026-11-05"].release.isRelease, true, "FOMC session"); eq(JSON.stringify(S["2026-11-05"].release.types), '["FOMC"]', "type");
  eq(S["2026-11-05"].v1.wouldSkip, true, "the filter skips a release session");
  near(S["2026-11-05"].v1.meanR, -1, 1e-12, "the session's mean R is the mean of its two 0DTE tickets");
  eq(S["2026-11-05"].v1.pnl, -200, "the session's P&L");
  eq(S["2026-11-12"].v1.wouldSkip, false, "an ordinary session is kept");
  near(S["2026-11-12"].v1.meanR, 3, 1e-12, "the control twin is not in the mean");
  const w = S["2026-11-09"].v2.opened.find((x) => x.id === "W_A_e");
  eq(w.wouldDecline, true, "the exposed wing would be declined");
  eq(JSON.stringify(w.exposingReleases), '["2026-11-10 CPI"]', "the release that exposes it is named");
  eq(S["2026-11-09"].v2.opened.find((x) => x.id === "W_A_u").wouldDecline, false, "the unexposed wing is kept");
  eq(S["2026-12-01"].v2.opened[0].id, "W_O", "an open wing's decision is recorded the session it is opened");
  eq(S["2026-12-01"].v2.opened[0].exposed, true, "it is exposed to the December FOMC");
  eq(S["2026-11-10"].v2.settled.find((x) => x.id === "W_A_e").R, -0.5, "a wing's outcome lands on the session it settles");
});
check("C4 R275 grace: a session held while a 0DTE ticket is open, and recorded once the grace is spent", () => {
  const rows = SL.readRows(JL275), run = rows.find((r) => r.kind === "run");
  ok(run.held.some((h) => h.session === "2026-11-30"), "2026-11-30 is held — its 0DTE ticket has not settled");
  eq(rows.some((r) => r.kind === "session" && r.key === "2026-11-30"), false, "and no session row was written for it");
  const late = rows.find((r) => r.kind === "session" && r.key === "2026-11-20");
  eq(JSON.stringify(late.v1.unsettledIds), '["Z7"]', "a ticket still open past the grace is named in the row");
  eq(late.v1.meanR, null, "and is not quietly averaged in");
  ok(run.held.some((h) => h.session === "2026-12-01"), "the 12-01 wing cell waits for its wing to settle");
});
check("C5 R275 wing cells — the hand-computed within-session differences", () => {
  const C = Object.fromEntries(SL.readRows(JL275).filter((r) => r.kind === "wing-cell").map((r) => [r.key, r]));
  near(C["2026-11-09"].diff, -1, 1e-12, "cell 11-09"); near(C["2026-11-11"].diff, -2, 1e-12, "cell 11-11"); near(C["2026-11-19"].diff, -3, 1e-12, "cell 11-19");
  eq(C["2026-11-18"].diff, null, "a cell with only exposed wings has no difference"); eq(C["2026-11-18"].exposed, 1, "but it is counted");
  eq(C["2026-11-25"].diff, null, "a cell with only unexposed wings has no difference"); eq(C["2026-11-25"].unexposed, 1, "and counted");
});
check("C6 R275 read-out — the forward statistics, hand-computed", () => {
  const R = run275.report;
  eq(R.V1.releaseSessions, 2, "release sessions"); eq(R.V1.otherSessions, 2, "other sessions");
  near(R.V1.diff, -4, 1e-9, "release minus other"); eq(R.V1.t, -2.828, "Welch t of (-1,-3) against (1,3)");
  eq(R.V2.sessionsWithBoth, 3, "cells with both sides"); eq(R.V2.t, -3.464, "one-sample t of -1,-2,-3");
  eq(R.V2.exposedWings, 4, "exposed wings"); eq(R.V2.unexposedWings, 4, "unexposed wings");
  eq(R.wouldHaveSkipped.releaseSessions, 5, "release sessions the filter would have skipped");
  eq(R.wouldHaveSkipped.wingsDeclined, 5, "wings the filter would have declined"); eq(R.wouldHaveSkipped.wingsSeen, 9, "wings seen");
  eq(R.bar.oneSided, -2.006, "the sealed bar is reported");
  ok(/not a read of R275/.test(R.kind) && /seals nothing/.test(R.bar.note), "the read-out says plainly that it is not a read");
  eq(JSON.stringify(JSON.parse(fs.readFileSync(OUT275, "utf8")).V1), JSON.stringify(R.V1), "the JSON beside the record is the same read-out");
  eq(R.evidenceStart, "2026-11-01", "the forward evidence start is the record's own");
});
check("C7 R275 is idempotent — a second run on the same night adds nothing", () => {
  const before = fs.readFileSync(JL275, "utf8");
  const r = R275.run({ now: NOW_275, log: () => {} });
  eq(r.appended.length, 0, "appended"); eq(fs.readFileSync(JL275, "utf8"), before, "the record is untouched");
});
check("C8 R275 on a night when the sleeves did nothing adds only the run row that proves it fired", () => {
  const n = SL.readRows(JL275).length;
  const r = R275.run({ now: Date.parse("2026-12-03T22:00:00Z"), log: () => {} });
  eq(r.appended.length, 1, "appended"); eq(r.appended[0].kind, "run", "a run row"); eq(r.appended[0].key, "2026-12-03", "dated the run");
  eq(SL.readRows(JL275).length, n + 1, "rows");
  ok(r.appended[0].held.some((h) => h.session === "2026-12-01"), "the open wing's cell is still held, and the row says so");
});
check("C9 R275 without a macro calendar classifies nothing and says so", () => {
  const dir = fs.mkdtempSync(path.join(TMP, "nocal-"));
  writeJsonAtomic(path.join(dir, "trade_log.json"), T275.log);
  writeJsonAtomic(path.join(dir, "board_positions.json"), []);
  const jl = path.join(dir, "rec.jsonl");
  SL.appendRows(jl, [SL.startRow({ test: "R275", spec: "x", evidenceStart: "2026-11-01", ruleSource: "r.js", ruleSha: null, note: "" })], { now: 0 });
  R275.run({ dir, jsonl: jl, out: path.join(dir, "rec.json"), now: NOW_275, log: () => {} });
  const S = SL.readRows(jl).filter((r) => r.kind === "session");
  ok(S.length > 0, "sessions are still recorded");
  eq(S.every((r) => r.gap === true), true, "every one is a gap row");
  ok(/holds no CPI\/NFP\/FOMC dates/.test(S[0].why), "and says why");
});

// R192 fixtures — three funds that move only on two days a month, so every number is checkable by hand
const weekdays = (ym) => { const [y, m] = ym.split("-").map(Number), out = []; for (let d = 1; d <= 31; d++) { const dt = new Date(Date.UTC(y, m - 1, d)); if (dt.getUTCMonth() !== m - 1) break; const w = dt.getUTCDay(); if (w >= 1 && w <= 5) out.push(dt.toISOString().slice(0, 10)); } return out; };
const FIRST_RET = { "2026-10": 0.0625, "2026-11": 0.0625, "2026-12": 0.125, "2027-01": 0 };
const SESSIONS_192 = [...weekdays("2026-10"), ...weekdays("2026-11"), ...weekdays("2026-12"), "2027-01-04"];
function buildBars() {
  const byMonthDates = {};
  for (const d of SESSIONS_192) (byMonthDates[d.slice(0, 7)] = byMonthDates[d.slice(0, 7)] || []).push(d);
  const retOf = (d) => { const m = d.slice(0, 7), list = byMonthDates[m]; if (d === list[0]) return FIRST_RET[m]; if (list.length >= 3 && d === list[list.length - 3]) return 0.03125; return 0; };
  const bars = {};
  for (const s of R192.SYMS) { let c = 100; bars[s] = SESSIONS_192.map((d) => { c = c * (1 + (s === "HYG" ? 0 : retOf(d))); return { d, c }; }); }
  return { bars, retOf, byMonthDates };
}
const B192 = buildBars();
const CAL_192 = Object.fromEntries(["2026-10", "2026-11", "2026-12", "2027-01"].map((m) => [m, weekdays(m)]));
const NOW_192 = Date.parse("2027-01-05T22:00:00Z");           // ET 2027-01-05 17:00
const JL192 = path.join(SDATA, "r192-month-end-shadow.jsonl"), OUT192 = path.join(SDATA, "r192-month-end-shadow.json");
/** the registered statistic, written out again from the registry's words — independent of the module under test */
function expectedExcess(rets) {
  const w = rets.slice(rets.length - 5), o = rets.slice(0, rets.length - 5);
  let prod = 1; for (const r of w) prod *= 1 + r;
  let s = 0; for (const r of o) s += r;
  return prod - 1 - 5 * (s / o.length) - 0.0004;
}
const novRets = () => { const l = B192.byMonthDates["2026-11"]; return l.map((d) => B192.retOf(d)); };
const decRets = () => { const l = B192.byMonthDates["2026-12"]; return l.map((d) => B192.retOf(d)); };

const FEED_192 = { bars: B192.bars, effectiveEnd: "2027-01-04", walkedBack: 1 };
/** one r192 run with the network barred outright, so a stray call fails rather than going out */
async function run192Once(opts) {
  const realFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error("a shadow must make no network call"); };
  try { return await R192.run({ log: () => {}, fetchBars: async () => FEED_192, calendar: async () => CAL_192, ...opts }); } finally { globalThis.fetch = realFetch; }
}

async function r192Checks() {
  SL.appendRows(JL192, [SL.startRow({ test: "R192", spec: "x", evidenceStart: "2026-11-01", ruleSource: "r192-bond-month-end.js", ruleSha: null, note: "seeded by the selftest" })], { now: Date.parse("2026-11-01T22:00:00Z") });
  const R = await run192Once({ now: NOW_192 });
  check("C10 R192 forward shadow opens the record once and writes a run row", () => {
    const rows = SL.readRows(JL192);
    eq(rows.filter((r) => r.kind === "start").length, 1, "the start row is not written twice");
    eq(rows.filter((r) => r.kind === "run").length, 1, "run rows");
    const runRow = rows.find((r) => r.kind === "run");
    eq(runRow.barsThrough, "2027-01-04", "the bar window actually served is recorded");
    eq(runRow.orders, "none — this runner places no order of any kind", "and that nothing was ordered");
  });
  check("C11 R192 session rows: one per completed session from the funds' own bars", () => {
    const S = SL.readRows(JL192).filter((r) => r.kind === "session");
    eq(S.length, weekdays("2026-11").length + weekdays("2026-12").length + 1, "session rows (November, December and 2027-01-04)");
    eq(S[0].key, weekdays("2026-11")[0], "the first recorded session is the forward start, never earlier");
    ok(S.every((r) => r.key >= "2026-11-01"), "no session before the record's start — a forward shadow never backfills");
  });
  check("C12 R192 session rows say whether the rule would have been long, decided from the session calendar", () => {
    const S = Object.fromEntries(SL.readRows(JL192).filter((r) => r.kind === "session").map((r) => [r.key, r]));
    const nov = weekdays("2026-11"), last5 = nov.slice(-5);
    for (const d of nov) eq(S[d].plan.long, last5.includes(d), `2026-11 ${d} long?`);
    eq(JSON.stringify(S[last5[0]].wouldHold), JSON.stringify(R192.PRIMARY), "the three primary funds are held");
    eq(JSON.stringify(S[nov[0]].wouldHold), "[]", "flat outside the window");
    eq(S[last5[0]].plan.entryDay, nov[nov.length - 6], "the entry close is the sixth-to-last session");
    near(S[nov[0]].funds.AGG, FIRST_RET["2026-11"], 1e-12, "the day's fund return is in the row");
    eq(S[nov[0]].funds.HYG, 0, "and the contrast fund's");
  });
  check("C13 R192 month rows: the registered statistic, against an independent re-derivation", () => {
    const M = Object.fromEntries(SL.readRows(JL192).filter((r) => r.kind === "month").map((r) => [r.key, r]));
    eq(Object.keys(M).sort().join(","), "2026-10,2026-11,2026-12", "October (a gap), November and December");
    eq(M["2026-10"].gap, true, "October is before the forward start");
    ok(/never backfills/.test(M["2026-10"].why), "and says why");
    for (const [m, rets] of [["2026-11", novRets()], ["2026-12", decRets()]]) {
      near(M[m].primary, expectedExcess(rets), 1e-15, `${m} primary against the independent re-derivation`);
      for (const s of R192.PRIMARY) near(M[m].each[s].excess, expectedExcess(rets), 1e-15, `${m} ${s}`);
      eq(M[m].each.AGG.windowPct, 3.125, `${m} window is exactly +3.125% (one 1/32 move inside the last five sessions)`);
      near(M[m].contrast, -0.0004, 1e-18, `${m} HYG contrast is the cost alone — it never moves`);
      eq(M[m].calendarAgreed, true, `${m} the calendar's window was the realized one`);
      eq(M[m].cost, 0.0004, "2 bps a side");
      eq(M[m].rets.AGG.length, M[m].sessions, "the month's own returns are kept in the row");
    }
  });
  check("C14 R192 read-out: re-derived from the record, with the registered placebo and the registry's bar", () => {
    const R2 = R.report;
    eq(R2.months, 2, "scored months"); eq(R2.primary.months, 2, "months in the primary series");
    near(R2.primary.meanPct, 100 * (expectedExcess(novRets()) + expectedExcess(decRets())) / 2, 1e-3, "mean %/month");
    eq(R2.bar.tRequired, 2.356, "the bar comes from the registry, not from this file");
    ok(/test-registry\.json/.test(R2.bar.source), "and says where");
    ok(R2.placebo && R2.placebo.draws === 200, "200 placebo draws, as registered");
    eq(R2.recordSelfCheck.months, 2, "the record was checked against itself");
    near(Number(R2.recordSelfCheck.maxAbsDiffStoredVsRederived), 0, 1e-15, "stored and re-derived agree exactly");
    eq(R2.calendarDisagreements.length, 0, "no calendar disagreement");
    eq(R2.undecidedSessions, 0, "every session was decidable");
    ok(/not a read of R192/.test(R2.kind) && /seals nothing/.test(R2.bar.note) && /not independent of R180/.test(R2.bar.note), "the read-out repeats the governance facts");
    eq(JSON.parse(fs.readFileSync(OUT192, "utf8")).months, 2, "the JSON beside the record agrees");
  });
  const before = fs.readFileSync(JL192, "utf8");
  const again = await run192Once({ now: NOW_192 });
  check("C15 R192 is idempotent — a second run on the same night adds nothing", () => {
    eq(again.appended.length, 0, "appended"); eq(fs.readFileSync(JL192, "utf8"), before, "the record is untouched");
  });
  const dir2 = fs.mkdtempSync(path.join(TMP, "nocal192-"));
  const jl2 = path.join(dir2, "rec.jsonl");
  SL.appendRows(jl2, [SL.startRow({ test: "R192", spec: "x", evidenceStart: "2026-11-01", ruleSource: "r.js", ruleSha: null, note: "" })], { now: 0 });
  const noCal = await run192Once({ dir: dir2, jsonl: jl2, out: path.join(dir2, "rec.json"), now: NOW_192, calendar: async () => ({ __error: "no keys here" }) });
  check("C16 R192 without a session calendar records the day as undecided, never guessed", () => {
    const S = SL.readRows(jl2).filter((r) => r.kind === "session");
    eq(S.every((r) => r.plan.long === null && r.plan.from === "unavailable"), true, "every session is undecided");
    eq(S.every((r) => r.wouldHold === null), true, "and holds nothing by assumption");
    eq(noCal.report.undecidedSessions, S.length, "the read-out counts them");
    const runRow = SL.readRows(jl2).find((r) => r.kind === "run");
    eq(runRow.calendar.read, false, "the run row says the calendar was not read");
    ok(SL.readRows(jl2).some((r) => r.kind === "month" && !r.gap), "the months are still scored from the realized bars");
  });
  check("C17 R192 reads its bar from the registry and says so when it cannot", () => {
    eq(R192.registeredBar(SDATA).bar, 2.356, "the fixture registry's bar");
    const d = fs.mkdtempSync(path.join(TMP, "noreg-"));
    eq(R192.registeredBar(d).bar, null, "no registry, no bar");
    ok(/could not be read/.test(R192.registeredBar(d).barSource), "and it says so rather than hardcoding one");
    writeJsonAtomic(path.join(d, "test-registry.json"), { preregistered: [{ id: "R275", screenRedacted: true }] });
    ok(/no R192 entry/.test(R192.registeredBar(d).barSource), "a redacted registry is named, not filled in");
  });
}

// ── C18: structurally, a run writes nothing but its own record ────────────────────────────────────────────────
async function c18() {
  const dir = fs.mkdtempSync(path.join(TMP, "touch-"));
  for (const f of ["macro-calendar.json", "trade_log.json", "board_positions.json", "test-registry.json"]) fs.copyFileSync(path.join(SDATA, f), path.join(dir, f));
  const snap = () => Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
  const before = snap();
  const jl = path.join(dir, "r275-release-shadow.jsonl"), jl2 = path.join(dir, "r192-month-end-shadow.jsonl");
  const realFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error("a shadow must make no network call"); };
  try {
    R275.run({ dir, jsonl: jl, out: path.join(dir, "r275-release-shadow.json"), now: NOW_275, log: () => {} });
    await R192.run({ dir, jsonl: jl2, out: path.join(dir, "r192-month-end-shadow.json"), now: NOW_192, log: () => {}, fetchBars: async () => ({ bars: B192.bars }), calendar: async () => CAL_192 });
  } finally { globalThis.fetch = realFetch; }
  const after = snap();
  check("C18 a run touches no file but its own two — the ledger, the board and the calendar are read-only", () => {
    for (const f of Object.keys(before)) eq(after[f], before[f], `${f} was changed by a run`);
    const added = Object.keys(after).filter((f) => !(f in before)).sort();
    eq(JSON.stringify(added), JSON.stringify(["r192-month-end-shadow.json", "r192-month-end-shadow.jsonl", "r275-release-shadow.json", "r275-release-shadow.jsonl"]), "the only new files are the two records and their read-outs");
  });
  check("C19 no order, no broker, no network, no seal anywhere in the three staged files' CODE", () => {
    const banned = [/\bsubmitOrder\b/, /\bplaceOrder\b/, /\/v2\/orders/, /broker-adapter/, /tasty-broker/, /read-seals/, /agent-ledger/, /alpaca-mirror/, /"POST"/, /'POST'/, /method:\s*"POST"/, /board_tombstones/, /trade_log\.jsonl/];
    for (const [name, txt] of CODE) for (const re of banned) ok(!re.test(txt), `${name} contains ${re} in code`);
    // every write in the three files goes to the runner's own `out`/`file`, nowhere else
    const allowed = new Set(["out", "file", "tmp"]);
    for (const [name, txt] of CODE) {
      for (const m of txt.matchAll(/(writeJsonAtomic|appendFileSync|writeFileSync|unlinkSync|renameSync|rmSync|truncateSync)\s*\(\s*([A-Za-z_$][\w$]*)/g)) {
        ok(allowed.has(m[2]), `${name}: ${m[1]}(${m[2]}) writes somewhere other than the shadow's own record`);
      }
    }
    // the only host either runner can reach is the exchange's read-only session calendar
    const urls = [...CODE.flatMap(([, t]) => [...t.matchAll(/https?:\/\/[^"'`\s)]+/g)].map((m) => m[0]))];
    eq(JSON.stringify(urls), JSON.stringify(["https://paper-api.alpaca.markets/v2/calendar?start=${ym}-01&end=${end}"]), "the URLs in the code");
    ok(/places no order of any kind/i.test(shadowText275) && /places no order of any kind/i.test(shadowText192), "each runner says so in its own header");
  });
}

// ══ D — the package ═══════════════════════════════════════════════════════════════════════════════════════════
const DEP = require(path.join(PKG, "deploy.cjs"));
const RB = require(path.join(PKG, "rollback.cjs"));
const REC = require(path.join(PKG, "record.cjs"));
const scratchRepo = () => { const r = fs.mkdtempSync(path.join(TMP, "repo-")); fs.mkdirSync(path.join(r, "backend", "lib"), { recursive: true }); fs.mkdirSync(path.join(r, "automation"), { recursive: true }); return r; };
const noProcs = () => [];
const SAT = Date.parse("2026-10-17T18:00:00Z");               // a Saturday: the clock fence is clear
const deps = (repo, extra = {}) => ({ repo, pkg: PKG, now: () => SAT, log: () => {}, listProcs: noProcs, holidays: {}, run: () => ({ status: 0, out: "ALL 1 CHECKS PASSED\n" }), ...extra });

check("D1 deploy --plan on a clean tree: three new files, all absent, nothing refused", () => {
  const repo = scratchRepo(), P = DEP.plan({ repo, pkg: PKG });
  eq(P.problems.length, 0, "problems"); eq(P.todo.length, 3, "files to create"); eq(P.applied, false, "not applied");
  eq(P.files.every((x) => x.state === "absent" && x.baseSha === null), true, "every file is new");
  eq(P.files.every((x) => x.staged === x.stagedSha), true, "the staged copies are the bytes pinned in deploy.cjs");
});
check("D2 deploy --apply creates the three files, byte exact, and they parse", () => {
  const repo = scratchRepo(), M = DEP.make(deps(repo));
  const r = M.writeUnit({ to: "staged", gate: M.selftestGate });
  eq(r.result, "done", `writeUnit: ${JSON.stringify(r.why || "")}`); eq(r.written.length, 3, "written");
  for (const f of DEP.FILES) {
    eq(DEP.sha(fs.readFileSync(path.join(repo, ...f.rel.split("/")))), f.stagedSha, `${f.rel} bytes`);
    eq(cp.spawnSync(process.execPath, ["--check", path.join(repo, ...f.rel.split("/"))]).status, 0, `${f.rel} parses`);
  }
  eq(DEP.plan({ repo, pkg: PKG }).applied, true, "the plan now reads applied");
  const again = DEP.make(deps(repo)).writeUnit({ to: "staged", gate: M.selftestGate });
  eq(again.written.length, 0, "a second apply writes nothing");
});
check("D3 deploy refuses DRIFT — a file already there that is not the staged one", () => {
  const repo = scratchRepo();
  fs.writeFileSync(path.join(repo, "backend", "r275-release-shadow.js"), "// somebody else's file\n");
  const P = DEP.plan({ repo, pkg: PKG });
  ok(P.problems.some((x) => /DRIFT/.test(x)), "the plan says DRIFT");
  const r = DEP.make(deps(repo)).writeUnit({ to: "staged", gate: null });
  eq(r.result, "refused", "refused");
  eq(fs.readFileSync(path.join(repo, "backend", "r275-release-shadow.js"), "utf8"), "// somebody else's file\n", "and the file is untouched");
  eq(fs.existsSync(path.join(repo, "backend", "r192-month-end-shadow.js")), false, "nothing else was written either");
});
check("D4 deploy refuses when the package's own staged copy is not the reviewed bytes", () => {
  const repo = scratchRepo(), pkg = fs.mkdtempSync(path.join(TMP, "pkg-"));
  fs.cpSync(path.join(PKG, "staged"), path.join(pkg, "staged"), { recursive: true });
  fs.appendFileSync(path.join(pkg, "staged", "backend", "r192-month-end-shadow.js"), "\n// tampered\n");
  const P = DEP.plan({ repo, pkg });
  ok(P.problems.some((x) => /staged copy/.test(x)), "the plan says the staged copy differs");
  eq(DEP.make(deps(repo, { pkg })).writeUnit({ to: "staged", gate: null }).result, "refused", "refused");
  eq(fs.existsSync(path.join(repo, "backend", "r192-month-end-shadow.js")), false, "nothing written");
});
check("D5 deploy refuses when the selftest gate does not pass, and writes nothing", () => {
  const repo = scratchRepo(), M = DEP.make(deps(repo, { run: () => ({ status: 1, out: "2 CHECKS FAILED\n" }) }));
  const r = M.writeUnit({ to: "staged", gate: M.selftestGate });
  eq(r.result, "refused", "refused"); ok(/selftest/.test(r.why.join(" ")), "the reason names the selftest");
  eq(fs.existsSync(path.join(repo, "backend", "r275-release-shadow.js")), false, "nothing written");
});
check("D6 the fences: the trading-day clock, the close chain, and an unreadable process list", () => {
  eq(DEP.clockFence(Date.parse("2026-10-20T16:00:00Z"), {}) === null, false, "Tuesday 10:00 MT refuses");
  eq(DEP.clockFence(Date.parse("2026-10-20T23:00:00Z"), {}), null, "Tuesday 17:00 MT is clear");
  eq(DEP.clockFence(Date.parse("2026-10-17T16:00:00Z"), {}), null, "Saturday is clear");
  eq(DEP.clockFence(Date.parse("2026-10-20T16:00:00Z"), { "2026-10-20": "holiday" }), null, "a market holiday is not a trading day");
  const chainy = () => [{ pid: 999, cmd: "node automation/close-chain.cjs" }];
  ok(DEP.procFence(chainy, "/repo").length === 1, "a running close chain refuses");
  ok(/could not be read/.test(DEP.procFence(() => { throw new Error("no ps"); }, "/repo")[0]), "an unreadable process list is fail-closed");
  eq(DEP.procFence(noProcs, "/repo").length, 0, "a quiet machine is clear");
  const repo = scratchRepo();
  eq(DEP.make(deps(repo, { listProcs: chainy })).writeUnit({ to: "staged", gate: null }).result, "refused", "and the write mode refuses");
  eq(fs.existsSync(path.join(repo, "backend", "r275-release-shadow.js")), false, "nothing written");
});
check("D7 rollback removes exactly what the package added, and leaves the records alone", () => {
  const repo = scratchRepo();
  eq(DEP.make(deps(repo)).writeUnit({ to: "staged", gate: null }).result, "done", "applied first");
  fs.mkdirSync(path.join(repo, "backend", "data"), { recursive: true });
  const rec = path.join(repo, "backend", "data", "r275-release-shadow.jsonl");
  fs.writeFileSync(rec, '{"kind":"run","key":"2026-10-17"}\n');
  const r = RB.rollback(deps(repo));
  eq(r.result, "done", "rolled back"); eq(r.written.length, 3, "three files removed");
  for (const f of DEP.FILES) eq(fs.existsSync(path.join(repo, ...f.rel.split("/"))), false, `${f.rel} is gone`);
  eq(fs.readFileSync(rec, "utf8"), '{"kind":"run","key":"2026-10-17"}\n', "the record the shadow wrote is kept");
  eq(DEP.plan({ repo, pkg: PKG }).todo.length, 3, "the tree is back where it started");
  eq(RB.rollback(deps(repo)).written.length, 0, "a second rollback removes nothing");
});
check("D8 rollback refuses while the nightly chain still names a runner", () => {
  const repo = scratchRepo();
  eq(DEP.make(deps(repo)).writeUnit({ to: "staged", gate: null }).result, "done", "applied first");
  fs.writeFileSync(path.join(repo, "automation", "close-chain.cjs"), 'step("node backend/r192-month-end-shadow.js");\n');
  const W = DEP.wiring(repo);
  eq(W.chainPresent, true, "the chain is there"); eq(W.wired["backend/r192-month-end-shadow.js"], true, "and names the runner");
  eq(W.wired["backend/r275-release-shadow.js"], false, "but not the other one");
  const r = RB.rollback(deps(repo));
  eq(r.result, "refused", "refused"); ok(/still named in/.test(r.why.join(" ")), "the reason says to unwire first");
  eq(fs.existsSync(path.join(repo, "backend", "r192-month-end-shadow.js")), true, "nothing was removed");
});
check("D9 deploy reads the chain as text and never requires it", () => {
  ok(/READ AS TEXT, never required/.test(fs.readFileSync(path.join(PKG, "deploy.cjs"), "utf8")), "the header says so");
  ok(!/require\([^)]*close-chain/.test(fs.readFileSync(path.join(PKG, "deploy.cjs"), "utf8")), "and it never requires close-chain.cjs");
  const repo = scratchRepo();
  eq(DEP.wiring(repo).chainPresent, false, "a tree without the chain is reported, not an error");
});
check("D10 record.cjs --dry prints both records and writes nothing", () => {
  const repo = scratchRepo(), data = fs.mkdtempSync(path.join(TMP, "recdata-"));
  writeJsonAtomic(path.join(data, "change-registry.json"), []);
  fs.writeFileSync(path.join(data, "agent-ledger.jsonl"), "");
  const before = fs.readdirSync(data).map((f) => [f, fs.readFileSync(path.join(data, f), "utf8")]);
  const r = REC.run({ dataDir: data, repo, pkg: PKG, dry: true, now: () => SAT, holidays: {}, log: () => {} });
  eq(r.code, 0, "exit"); eq(r.result, "dry", "dry");
  ok(r.wouldRefuse.some((x) => /deploy\.cjs --apply first/.test(x)), "it refuses to record a change that is not in yet");
  eq(JSON.stringify(fs.readdirSync(data).map((f) => [f, fs.readFileSync(path.join(data, f), "utf8")])), JSON.stringify(before), "nothing was written");
  const rows = REC.records({ nowMs: SAT, mtDate: "2026-10-17" });
  eq(rows.row.id, "r275-r192-shadows-2026-10-16", "the row id");
  eq(rows.row.breaksComparability, false, "nothing that exists changes");
  eq(JSON.stringify(rows.row.tests), '["R275","R192"]', "both tests named");
  ok(/No order of any kind/.test(rows.row.doesNotChange) && /untouched/.test(rows.row.doesNotChange), "the row states what does not change");
  ok(/redacted/.test(rows.row.notGiven), "and names the one thing the operator must check");
});
check("D11 the package never writes a seal, a registry status or a ledger row from the runners", () => {
  for (const [name, txt] of CODE.filter(([n]) => n !== "shadow-ledger.js")) {
    ok(!/read-seals/.test(txt), `${name} touches read-seals.json`);
    ok(!/\.status\s*=[^=]/.test(txt), `${name} writes a registry status`);
    ok(!/sealedOn/.test(txt), `${name} seals`);
  }
  const code192 = CODE.find(([n]) => n === "r192-month-end-shadow.js")[1];
  ok(/test-registry\.json/.test(code192), "R192's shadow does READ the registry (for the bar)");
  ok(!/writeJsonAtomic\([^)]*test-registry/.test(code192), "but never writes it");
  ok(/seals nothing/.test(shadowText275) && /seals nothing/.test(shadowText192), "and each header says so");
});

// ── the driver: the async checks, then the verdict ────────────────────────────────────────────────────────────
(async () => {
  await r192Checks();
  await c18();
  console.log("");
  if (FAIL.length) { console.log(`${FAIL.length} of ${N} CHECKS FAILED:`); for (const f of FAIL) console.log(`  - ${f}`); rm(TMP); process.exit(1); }
  rm(TMP);
  console.log(`ALL ${N} CHECKS PASSED`);
})().catch((e) => { console.error("selftest FAILED:", e && e.stack ? e.stack : e); try { rm(TMP); } catch {} process.exit(1); });
