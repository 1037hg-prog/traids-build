#!/usr/bin/env node
"use strict";
/**
 * AI-BUBBLE LADDER MONITOR (2026-10-16) — SELFTEST. Proves the staged files on synthetic closes only. It makes no
 * network call, no broker call and no HTTP request of any kind, it reads no real market data, and it writes nothing
 * outside one scratch directory it makes and removes itself.
 *
 *   node docs/ai-bubble-ladder-monitor/2026-10-16/selftest.cjs
 *
 * THE SCRATCH TREE. staged/backend/{ai-bubble-ladder.js, ai-bubble-ladder-monitor.js} are copied into
 * <scratch>/backend/ beside a copy of the repo's backend/lib/atomic-write.js and a package.json with no "type" field —
 * which is what backend/package.json is, so the staged files run there exactly as they will at home (the repo ROOT
 * package.json says "type": "module", so a .js file under docs/ would be read as an ES module and these are not).
 * fixtures/specs.cjs writes the stores. Nothing in the repository is read for data and nothing in it is written.
 *
 * AI_BUBBLE_LADDER_SELFTEST_STAGED, if set, is the directory the two staged files are copied FROM instead of
 * staged/backend — the one door mutants.cjs uses to serve this selftest a deliberately broken copy. deploy.cjs and
 * rollback.cjs never set it: they run this selftest on the package's own staged/ bytes.
 *
 * HOW THE KNOWN ANSWERS ARE KNOWN. Two ways, and every rung of every fixture goes through both:
 *   1. DESIGNED NUMBERS — each fixture is built so the arithmetic can be done by hand; fixtures/specs.cjs carries the
 *      derivation of every number asserted below (the 200-day mean 99.985 and its arm level 97.9853, the 10-month mean
 *      116.2, the two exact-equality cases, and so on). These are typed here as literals, never read from the code.
 *   2. AN INDEPENDENT RE-DERIVATION — refBand and refTenMonth below are a second implementation of the two rules,
 *      written from the definitions in docs/ai-bubble-2026-10/bust/triggers.js (lines 44-57 and 45-50) in a different
 *      style, sharing no code with the staged files. Every rung of every fixture must agree with them.
 *
 * Every group of checks runs inside T(), which turns a throw into a named FAIL and carries on: a broken copy of the
 * staged files must be REPORTED by this selftest, never allowed to end it early and hide the checks that follow.
 *
 * Exit 0 every check passed · 1 a check failed or threw. The last line reads ALL <n> CHECKS PASSED.
 */
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto");

const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");
const SPECS = require(path.join(PKG, "fixtures", "specs.cjs"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  fail++;
  console.log(`FAIL  ${name}`);
  if (detail !== undefined) console.log(`      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  return false;
}
/** a group of checks: a throw inside it is a FAIL named after the group, and the rest of the selftest still runs */
function T(label, fn) {
  try { fn(); } catch (e) { fail++; console.log(`FAIL  ${label} — it threw: ${String((e && e.message) || e).slice(0, 300)}`); }
}
/** two numbers equal to the last place the status rounds to (1e-4) */
const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 5e-5;

// ───────────────────────────── the independent re-derivation (shares no code with staged/) ─────────────────────────────

/**
 * bust/triggers.js:44-57 dailyTrend(S, n, band), written again: at each session with n closes behind it, the first
 * reading is close > mean; after that the band holds the previous reading until the close clears its far side.
 * -> array of "ARMED" / "in" / null
 */
function refBand(values, n, band) {
  const out = [];
  let state = null;
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < n) { out.push(null); continue; }
    const win = values.slice(i + 1 - n, i + 1);
    const mean = win.reduce((a, b) => a + b, 0) / win.length, v = values[i];
    if (state === null) state = v > mean ? "in" : "ARMED";
    else if (state === "in") state = v < mean * (1 - band) ? "ARMED" : "in";
    else state = v > mean * (1 + band) ? "in" : "ARMED";
    out.push(state);
  }
  return out;
}
/**
 * bust/triggers.js:41,45-50 tenMonth, written again: group the sessions by calendar month, take the last session of
 * each month EXCEPT the month the series ends in, and judge each such month-end against the mean of the last n of
 * them including itself — IN only when strictly above. -> { monthEnds, monthEnd, value, threshold, armed, star }
 */
function refTenMonth(dates, values, n) {
  const byMonth = new Map();
  for (let i = 0; i < dates.length; i++) byMonth.set(dates[i].slice(0, 7), [dates[i], values[i]]);
  const months = [...byMonth.keys()];
  const monthEnds = months.slice(0, -1).map((m) => byMonth.get(m));          // the last month of the series is forming
  if (monthEnds.length < n) return { monthEnds, armed: null, value: null, threshold: null };
  const win = monthEnds.slice(-n).map((x) => x[1]);
  const threshold = win.reduce((a, b) => a + b, 0) / n, last = monthEnds[monthEnds.length - 1];
  const prior = monthEnds.slice(-(n - 1)).map((x) => x[1]);
  return { monthEnds, monthEnd: last[0], value: last[1], threshold, armed: !(last[1] > threshold),
    star: prior.reduce((a, b) => a + b, 0) / (n - 1) };
}

// ───────────────────────────── the scratch tree ─────────────────────────────

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bubble-ladder-selftest-"));
process.on("exit", () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* a scratch dir left behind is harmless */ } });
const BE = path.join(SCRATCH, "backend");
fs.mkdirSync(path.join(BE, "lib"), { recursive: true });
fs.mkdirSync(path.join(BE, "data"), { recursive: true });
fs.writeFileSync(path.join(SCRATCH, "package.json"), '{ "name": "scratch", "version": "0.0.0" }\n');
fs.writeFileSync(path.join(BE, "package.json"), '{ "name": "scratch-backend", "version": "0.0.0" }\n');
const STAGED = ["ai-bubble-ladder.js", "ai-bubble-ladder-monitor.js"];
const OWN = path.join(PKG, "staged", "backend"), FROM = process.env.AI_BUBBLE_LADDER_SELFTEST_STAGED || OWN;
if (FROM !== OWN) console.log(`  (the staged files are read from ${FROM} — mutants.cjs does this; deploy.cjs never does)`);
for (const f of STAGED) fs.copyFileSync(path.join(FROM, f), path.join(BE, f));
fs.copyFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"), path.join(BE, "lib", "atomic-write.js"));

/** a fixture's store on disk, built once and reused */
const FX = {};
function fixture(name) {
  if (FX[name]) return FX[name];
  const dir = path.join(SCRATCH, "fx", name);
  fs.mkdirSync(dir, { recursive: true });
  const st = SPECS.store(name);
  for (const [sym, rows] of Object.entries(st)) fs.writeFileSync(path.join(dir, `${sym}.json`), JSON.stringify(rows));
  FX[name] = { dir, rows: st };
  return FX[name];
}
/** every file under a directory, by sha256 — the "nothing else changed" snapshot */
function snapshot(dir) {
  const out = {};
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(p, r); else out[r] = sha(fs.readFileSync(p)); } };
  walk(dir, "");
  return out;
}

const LAD = require(path.join(BE, "ai-bubble-ladder.js"));
const MON = require(path.join(BE, "ai-bubble-ladder-monitor.js"));
/** the monitor, in memory, on a fixture: lines are captured, the clock is fixed, a throw is an answer and not a crash */
function run(argv, extra = {}) {
  const lines = [];
  try {
    const r = MON.run({ argv, log: (s) => lines.push(s), now: () => "2026-10-16T12:00:00.000Z", ...extra });
    return { ...r, lines, text: lines.join("\n"), threw: null };
  } catch (e) { return { code: -1, status: null, wrote: null, lines, text: lines.join("\n"), threw: String((e && e.message) || e) }; }
}
const rung = (st, id) => (st.rungs.find((x) => x.id === id) || { id, missing: true });

console.log(`AI-BUBBLE LADDER MONITOR — SELFTEST (synthetic closes only; scratch ${SCRATCH})`);

// ───────────────────────────── 1. the staged files parse, and are read-only by construction ─────────────────────────────

T("the staged files parse", () => {
  for (const f of STAGED) {
    const r = cp.spawnSync(process.execPath, ["--check", path.join(BE, f)], { encoding: "utf8" });
    ok(`${f} passes node --check`, r.status === 0, String(r.stderr || "").trim().split("\n")[0]);
  }
});
T("the staged files are read-only by construction", () => {
  const src = Object.fromEntries(STAGED.map((f) => [f, fs.readFileSync(path.join(FROM, f), "utf8")]));
  const all = Object.values(src).join("\n");
  const NET = [/\bfetch\s*\(/, /\brequire\(\s*["'](https?|net|tls|dgram|http2)["']\s*\)/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /https?:\/\//];
  for (const re of NET) ok(`no network in the staged files: ${re}`, !re.test(all), (all.match(re) || [])[0]);
  // the order-placing surface itself: the broker's paths and fields, its keys, and the verbs that send one. The WORD
  // "order" is not forbidden — the monitor's own summary says no order was placed — but none of this may be there.
  const ORDER = [/\/v2\/orders/, /paper-api|api\.alpaca|alpaca\.markets/i, /APCA-API/i, /\btime_in_force\b/, /\bclient_order_id\b/,
    /\bsubmitOrder\b|\bplaceOrder\b|\bcreateOrder\b|\bsendOrder\b/i, /\bqty\b/, /\bside\s*[:=]/, /\bALPACA_\w*KEY\b/, /\bmarket_value\b/, /\bpositions?\b\s*[:=]/];
  for (const re of ORDER) ok(`no order-placing surface in the staged files: ${re}`, !re.test(all), (all.match(re) || [])[0]);
  const RAWWRITE = [/\bwriteFileSync\b/, /\bappendFileSync\b/, /\bcreateWriteStream\b/, /\bunlinkSync\b/, /\brmSync\b/, /\brenameSync\b/, /\bmkdirSync\b/, /\bchild_process\b/, /\bspawn/, /\bexec/];
  for (const re of RAWWRITE) ok(`the staged files do no writing of their own: ${re}`, !re.test(all), (all.match(re) || [])[0]);
  ok("the staged files require nothing but path, fs and the one atomic-write helper",
    [...all.matchAll(/require\((["'])([^"']+)\1\)/g)].every((m) => ["fs", "path", "./ai-bubble-ladder.js", "./lib/atomic-write.js"].includes(m[2])),
    [...all.matchAll(/require\((["'])([^"']+)\1\)/g)].map((m) => m[2]));
  ok("the monitor's one write goes through backend/lib/atomic-write.js writeJsonAtomic", /require\("\.\/lib\/atomic-write\.js"\)/.test(src["ai-bubble-ladder-monitor.js"]) && /write = writeJsonAtomic/.test(src["ai-bubble-ladder-monitor.js"]));
  ok("the library writes nothing at all (it does not load atomic-write)", !/atomic-write/.test(src["ai-bubble-ladder.js"]));
  ok("every rung names the line of docs/ai-bubble-2026-10/ its rule comes from", LAD.LADDER.every((r) => /^(bust|plan-review|dalio-plan|plan-sizing)/.test(r.source) && /:\d+/.test(r.source)), LAD.LADDER.map((r) => r.source));
  ok("the ladder is the six rungs of the two levels", JSON.stringify(LAD.LADDER.map((r) => r.id)) === JSON.stringify(["B1-QQQ", "B1-SPY", "B1-SMH", "B2-QQQ", "B2-SPY", "B2-CREDIT"]), LAD.LADDER.map((r) => r.id));
});

// ───────────────────────────── 2. the two rules, against the independent re-derivation ─────────────────────────────

T("the B1 band rule", () => {
  // a hand-made run of closes: 199 at 90, then 100s, then the designed tail
  const base = [...Array(199).fill(90), ...Array(199).fill(100)];
  const tail = [97, 99, 99.5, 101.5, 104];
  const vals = [...base, ...tail];
  const got = LAD.bandTrend(vals, 200, 0.02), want = refBand(vals, 200, 0.02);
  ok("the band rule agrees with the independent re-derivation at every session", got.every((v, i) => (v === null ? want[i] === null : (v === 0 ? "ARMED" : "in") === want[i])),
    { got: got.slice(-6), want: want.slice(-6) });
  const i0 = base.length - 1;                                    // the last all-100 session: mean 100, close 100
  ok("the band holds IN while the close sits ON its 200-day mean (100 vs 100: it is not below 98)", got[i0] === 1);
  ok("a close below 0.98 x the mean ARMS the band", got[i0 + 1] === 0, { close: 97, mean: (199 * 100 + 97) / 200 });
  ok("once armed, a close back above 0.98 x the mean but below 1.02 x it stays ARMED (hysteresis)", got[i0 + 2] === 0 && got[i0 + 3] === 0,
    { closes: [99, 99.5], armLevels: [0.98 * ((198 * 100 + 97 + 99) / 200), 0.98 * ((197 * 100 + 97 + 99 + 99.5) / 200)] });
  ok("a close above the mean but NOT above 1.02 x it still does not disarm (101.5 against a disarm level of 101.9847)", got[i0 + 4] === 0, { close: 101.5, disarm: 1.02 * ((196 * 100 + 97 + 99 + 99.5 + 101.5) / 200) });
  ok("a close above 1.02 x the mean disarms it (104 against a disarm level of 102.005)", got[i0 + 5] === 1, { close: 104, disarm: 1.02 * ((195 * 100 + 97 + 99 + 99.5 + 101.5 + 104) / 200) });
  ok("the band is null until there are 200 closes, and not before", got.slice(0, 199).every((v) => v === null) && got[199] !== null);
  ok("the first available reading of a rising series is IN", LAD.bandTrend(vals.map((_, i) => 100 + i * 0.1), 200, 0.02)[199] === 1);
  ok("the FIRST reading of a flat series is ARMED: the plain test is close > mean, and 100 is not above 100",
    LAD.bandTrend(Array(200).fill(100), 200, 0.02)[199] === 0, LAD.bandTrend(Array(200).fill(100), 200, 0.02).slice(-1));
  ok("a 200-day mean is not taken over fewer than 200 closes", LAD.sma(Array(199).fill(100), 198, 200) === null && LAD.sma(Array(200).fill(100), 199, 200) === 100);
});
T("the month-end calendar", () => {
  const d = SPECS.sessions("2024-10-01", "2026-10-06");
  const me = LAD.monthEndIdx(d);
  ok("a month-end is a session whose next session is in another month", me.every((i) => i + 1 < d.length && d[i].slice(0, 7) !== d[i + 1].slice(0, 7)), me.slice(-3).map((i) => [d[i], d[i + 1]]));
  ok("the last session of the series is never a month-end (the month is still forming)", !me.includes(d.length - 1));
  ok("there is one month-end per completed calendar month", me.length === new Set(d.map((x) => x.slice(0, 7))).size - 1, { monthEnds: me.length, months: new Set(d.map((x) => x.slice(0, 7))).size });
});

// ───────────────────────────── 3. every fixture: the whole ladder vs the re-derivation ─────────────────────────────

for (const name of Object.keys(SPECS.SPECS)) T(`${name}: the whole ladder against the re-derivation`, () => {
  const fx = fixture(name), r = run(["--data", fx.dir]);
  ok(`${name}: the monitor reads it and exits 0`, r.code === 0 && r.status, r.threw || r.lines.slice(0, 3));
  if (!r.status) return;
  for (const spec of LAD.LADDER) {
    const g = rung(r.status, spec.id);
    const sym = spec.ratio ? null : spec.sym;
    // the series the rung reads, re-built here from the fixture's own rows and trimmed to the status's date
    let dates, values;
    if (sym) { const rows = fx.rows[sym].filter((x) => x.d <= r.status.date); dates = rows.map((x) => x.d); values = rows.map((x) => x.a); }
    else { const den = new Map(fx.rows[spec.ratio[1]].map((x) => [x.d, x.a])); const rows = fx.rows[spec.ratio[0]].filter((x) => x.d <= r.status.date && den.has(x.d));
      dates = rows.map((x) => x.d); values = rows.map((x) => x.a / den.get(x.d)); }
    ok(`${name}/${spec.id}: it was read as of the status's date`, !g.available || g.asOf === r.status.date, { asOf: g.asOf, date: r.status.date });
    ok(`${name}/${spec.id}: exactly one of armedSince / notArmedSince is set, and it agrees with ARMED`,
      !g.available || (g.armed ? g.armedSince !== null && g.notArmedSince === null : g.notArmedSince !== null && g.armedSince === null), { armed: g.armed, armedSince: g.armedSince, notArmedSince: g.notArmedSince });
    if (spec.kind === "band200") {
      const want = refBand(values, spec.n, spec.band), last = want[want.length - 1];
      ok(`${name}/${spec.id}: ARMED agrees with the re-derivation`, (last === null ? g.armed === null && !g.available : g.armed === (last === "ARMED")), { got: g.armed, want: last, available: g.available });
      if (last !== null) {
        const mean = values.slice(-spec.n).reduce((a, b) => a + b, 0) / spec.n;
        ok(`${name}/${spec.id}: the value is the last adjusted close and the mean is the 200-day mean`, near(g.value, values[values.length - 1]) && near(g.sma, mean), { value: g.value, sma: g.sma, want: [values[values.length - 1], mean] });
        ok(`${name}/${spec.id}: the arm level is 0.98 x the mean and the disarm level 1.02 x it`, near(g.armThreshold, mean * 0.98) && near(g.disarmThreshold, mean * 1.02), { arm: g.armThreshold, disarm: g.disarmThreshold, mean });
        ok(`${name}/${spec.id}: the threshold shown is the one its current reading is judged against`, near(g.threshold, g.armed ? mean * 1.02 : mean * 0.98), { armed: g.armed, threshold: g.threshold });
      }
    } else {
      const want = refTenMonth(dates, values, spec.n);
      ok(`${name}/${spec.id}: ARMED agrees with the re-derivation`, (want.armed === null ? g.armed === null && !g.available : g.armed === want.armed), { got: g.armed, want: want.armed, available: g.available });
      if (want.armed !== null) {
        ok(`${name}/${spec.id}: the value is the last completed month-end's close`, g.monthEnd === want.monthEnd && near(g.value, want.value), { got: [g.monthEnd, g.value], want: [want.monthEnd, want.value] });
        ok(`${name}/${spec.id}: the threshold is the mean of the last 10 month-ends including it`, near(g.threshold, want.threshold), { got: g.threshold, want: want.threshold });
        ok(`${name}/${spec.id}: the provisional threshold is the flip level X*, the mean of the 9 completed month-ends`, near(g.provisional.threshold, want.star) && near(g.provisional.value, values[values.length - 1]), { got: g.provisional, want: want.star });
      }
    }
  }
});

// ───────────────────────────── 4. the designed known answers, typed as literals ─────────────────────────────

T("b1-cross: the crossing day", () => {
  const st = run(["--data", fixture("b1-cross").dir]).status, q = rung(st, "B1-QQQ");
  ok("b1-cross: the status is dated the last session every series reaches", st.date === "2026-10-06", st.date);
  ok("b1-cross B1-QQQ: ARMED, close 97, 200-day mean 99.985, arm level 97.9853, disarm level 101.9847",
    q.armed === true && q.value === 97 && q.sma === 99.985 && q.armThreshold === 97.9853 && q.disarmThreshold === 101.9847, q);
  ok("b1-cross B1-QQQ: armed on 2026-10-06 and on no earlier session (the crossing day)", q.armedSince === "2026-10-06", q.armedSince);
  ok("b1-cross B1-SPY and B1-SMH: not armed, close 100 against an arm level of 98",
    ["B1-SPY", "B1-SMH"].every((id) => { const g = rung(st, id); return g.armed === false && g.value === 100 && g.armThreshold === 98; }), st.rungs.map((g) => [g.id, g.armed, g.value, g.armThreshold]));
  const p = rung(run(["--data", fixture("b1-cross").dir, "--as-of", "2026-10-05"]).status, "B1-QQQ");
  ok("b1-cross: the day BEFORE the crossing day, B1-QQQ is not armed (close 100 vs arm level 98)",
    p.armed === false && p.value === 100 && p.armThreshold === 98 && p.asOf === "2026-10-05", p);
  ok("b1-cross B2-CREDIT: not armed, the ratio 1.23 against a 10-month mean of 1.185", (() => { const g = rung(st, "B2-CREDIT"); return g.armed === false && g.value === 1.23 && g.threshold === 1.185; })(), rung(st, "B2-CREDIT"));
  ok("b1-cross: exactly B1-QQQ, B2-QQQ and B2-SPY are armed", JSON.stringify(st.armed) === JSON.stringify(["B1-QQQ", "B2-QQQ", "B2-SPY"]), st.armed);
  ok("b1-cross B2-QQQ: a flat run of month-ends sits EXACTLY on its 10-month mean, and equality arms it (100 vs 100)",
    rung(st, "B2-QQQ").armed === true && rung(st, "B2-QQQ").value === 100 && rung(st, "B2-QQQ").threshold === 100, rung(st, "B2-QQQ"));
});
T("b1-no-cross: the no-crossing day", () => {
  const q = rung(run(["--data", fixture("b1-no-cross").dir]).status, "B1-QQQ");
  ok("b1-no-cross B1-QQQ: NOT armed — close 98, mean 99.99, arm level 97.9902 (0.0098 below the close)",
    q.armed === false && q.value === 98 && q.sma === 99.99 && q.armThreshold === 97.9902, q);
  ok("b1-no-cross B1-QQQ: the threshold shown is the arm level, and the close is +0.01% from it", q.threshold === 97.9902 && near(q.distanceToThresholdPct, 0.0100002), q.distanceToThresholdPct);
});
T("b1-equal: a close exactly on the arm level", () => {
  const q = rung(run(["--data", fixture("b1-equal").dir]).status, "B1-QQQ");
  ok("b1-equal B1-QQQ: a close EXACTLY on the arm level does not arm (9751 vs 0.98 x 9950 = 9751; the rule needs strictly below)",
    q.armed === false && q.value === 9751 && q.sma === 9950 && q.armThreshold === 9751 && q.distanceToThresholdPct === 0, q);
});
T("b2-cross: the crossing month-end", () => {
  const st = run(["--data", fixture("b2-cross").dir]).status, q = rung(st, "B2-QQQ"), s = rung(st, "B2-SPY");
  ok("b2-cross B2-QQQ: ARMED — month-end 2026-09-30 at 100 against a 10-month mean of 116.2",
    q.armed === true && q.monthEnd === "2026-09-30" && q.value === 100 && q.threshold === 116.2, q);
  ok("b2-cross B2-QQQ: armed from the 2026-09-30 month-end (the crossing month-end)", q.armedSince === "2026-09-30", q.armedSince);
  const p = rung(run(["--data", fixture("b2-cross").dir, "--as-of", "2026-09-30"]).status, "B2-QQQ");
  ok("b2-cross B2-QQQ: the month-end BEFORE it did not arm — 2026-08-31 at 122 against a mean of 117.5",
    p.armed === false && p.monthEnd === "2026-08-31" && p.value === 122 && p.threshold === 117.5, p);
  ok("b2-cross B2-SPY: not armed on the same month-end — 140 against a mean of 120.2 (the ladder reads rung by rung)",
    s.armed === false && s.value === 140 && s.threshold === 120.2, s);
});
T("b2-no-cross: the no-crossing month-end", () => {
  const q = rung(run(["--data", fixture("b2-no-cross").dir]).status, "B2-QQQ");
  ok("b2-no-cross B2-QQQ: NOT armed — month-end 119 against a 10-month mean of 118.1", q.armed === false && q.value === 119 && q.threshold === 118.1, q);
});
T("b2-equal: a month-end exactly on the 10-month mean", () => {
  const q = rung(run(["--data", fixture("b2-equal").dir]).status, "B2-QQQ");
  ok("b2-equal B2-QQQ: a month-end EXACTLY on the 10-month mean ARMS (118 vs 118; the rule is IN only when strictly above)",
    q.armed === true && q.value === 118 && q.threshold === 118 && q.distanceToThresholdPct === 0, q);
  ok("b2-equal B2-QQQ: it arms AT that month-end, 2026-09-30, and not before", q.armedSince === "2026-09-30", q.armedSince);
});
T("short: too little history", () => {
  const r = run(["--data", fixture("short").dir]), st = r.status;
  ok("short: every rung is NOT READ — not one of them is reported 'not armed'", st.rungs.every((g) => g.available === false && g.armed === null) && st.armedCount === 0 && st.available === 0, st.rungs.map((g) => [g.id, g.available, g.armed]));
  ok("short: each unread rung says why", st.rungs.filter((g) => g.level === "B1").every((g) => /fewer than 200 closes \(113\)/.test(g.note)) && st.rungs.filter((g) => g.level === "B2").every((g) => /fewer than 10 completed month-ends \(5\)/.test(g.note)), st.rungs.map((g) => g.note));
  ok("short: the run still ends 0 and says so plainly", r.code === 0 && /NOT READ/.test(r.text) && /0 of 0 read rung\(s\) ARMED/.test(r.text));
});
T("lag: one series ends earlier than the others", () => {
  const r = run(["--data", fixture("lag").dir]), st = r.status;
  ok("lag: the status is dated the one day EVERY series reaches, not the newest", st.date === "2026-09-25", st.date);
  ok("lag: the lagging series is named", st.behind.length === 1 && /VFITX ends 2026-09-25/.test(st.behind[0]) && /one or more series lag/.test(r.text), st.behind);
  ok("lag: B1-QQQ is NOT armed — the arming close of 2026-10-06 is past the day the ladder was read", rung(st, "B1-QQQ").armed === false && rung(st, "B1-QQQ").asOf === "2026-09-25", rung(st, "B1-QQQ"));
  ok("lag: every rung was read as of the same day", st.rungs.every((g) => !g.available || g.asOf === "2026-09-25"), st.rungs.map((g) => [g.id, g.asOf]));
});
T("credit-gap: a hole in the denominator series", () => {
  const fx = fixture("credit-gap"), r = run(["--data", fx.dir]), g = rung(r.status, "B2-CREDIT");
  ok("credit-gap: the two series end on the same day, so nothing is trimmed", r.status.date === "2026-10-06" && r.status.behind.length === 0, r.status.behind);
  const s = LAD.ratioSeries(LAD.readSeries(fx.dir, "VWEHX"), LAD.readSeries(fx.dir, "VFITX"));
  ok("credit-gap: the ratio is taken only on the dates BOTH series have", s.rows === fx.rows.VFITX.length && !s.dates.includes("2026-05-29") && !s.dates.includes("2026-06-10"), { ratio: s.rows, vfitx: fx.rows.VFITX.length, vwehx: fx.rows.VWEHX.length });
  ok("credit-gap: every ratio value is a finite number (never a close divided by a price that is not there)", s.values.every((v) => Number.isFinite(v)), s.values.filter((v) => !Number.isFinite(v)).length);
  ok("credit-gap B2-CREDIT: its May month-end is 2026-05-28, the last May session both series have", (() => {
    const me = LAD.monthEndIdx(s.dates).map((i) => s.dates[i]);
    return me.includes("2026-05-28") && !me.includes("2026-05-29");
  })(), LAD.monthEndIdx(s.dates).map((i) => s.dates[i]).filter((d) => d.startsWith("2026-05")));
  ok("credit-gap B2-CREDIT: read, with a finite value and threshold", g.available === true && Number.isFinite(g.value) && Number.isFinite(g.threshold) && g.threshold === 1.185, g);
});

// ───────────────────────────── 5. the summary it prints ─────────────────────────────

T("the plain summary", () => {
  const r = run(["--data", fixture("b2-cross").dir]);
  ok("the summary names every rung once", LAD.LADDER.every((s) => r.lines.filter((l) => l.includes(s.id)).length >= 1));
  ok("each read rung's line carries ARMED or not armed, its value and its threshold",
    LAD.LADDER.every((s) => { const l = r.lines.find((x) => x.trim().startsWith(s.id)); const g = rung(r.status, s.id);
      return l && /ARMED|not armed/.test(l) && l.includes(String(g.value)) && l.includes(String(g.threshold)); }), r.lines);
  ok("the summary says what it is and is not", /read-only/.test(r.text) && /no order was placed/i.test(r.text) && /This is a reading, not an instruction/.test(r.text));
  ok("the summary counts the armed rungs and names them", /2 of 6 read rung\(s\) ARMED: B1-QQQ, B2-QQQ/.test(r.text), r.lines[r.lines.length - 3]);
  ok("the summary carries the status's date", r.lines[0].includes("2026-10-06"), r.lines[0]);
  ok("every summary line is plain text — no escape codes, no box drawing", r.lines.every((l) => !/[\u001b─-╿]/.test(l)));
  ok("each B2 line carries the provisional reading and its flip level", r.lines.filter((l) => /provisional: latest close .* vs flip level X\*/.test(l)).length === 3, r.lines.filter((l) => /provisional/.test(l)).length);
});

// ───────────────────────────── 6. it writes nothing unless it is told to, and then only its own file ─────────────────────────────

const OUT = path.join(BE, "data", "ai-bubble-ladder-status.json");
T("a read-only run writes nothing", () => {
  const before = snapshot(SCRATCH);
  const r = run(["--data", fixture("b1-cross").dir]);
  ok("a run with no --write changes nothing at all", JSON.stringify(snapshot(SCRATCH)) === JSON.stringify(before) && r.wrote === null);
  ok("a run with no --write says it wrote nothing", /nothing was written/.test(r.text));
  let asked = 0;
  const r2 = run(["--data", fixture("b1-cross").dir], { write: () => { asked++; throw new Error("the write path was reached on a read-only run"); } });
  ok("a read-only run never reaches the write path", asked === 0 && r2.code === 0, r2.threw);
});
T("--write writes one file and nothing else", () => {
  const before = snapshot(SCRATCH);
  const r = run(["--data", fixture("b1-cross").dir, "--write"]);
  const after = snapshot(SCRATCH);
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
  ok("--write writes exactly one file, the status file", r.code === 0 && changed.length === 1 && changed[0] === "backend/data/ai-bubble-ladder-status.json", changed);
  ok("--write leaves no temp file behind", !Object.keys(after).some((k) => /\.tmp-/.test(k)), Object.keys(after).filter((k) => /\.tmp/.test(k)));
  const doc = JSON.parse(fs.readFileSync(OUT, "utf8"));
  ok("the status file holds one key per date, and that date's whole status", doc.spec === LAD.STATUS_SPEC && JSON.stringify(doc.dates) === JSON.stringify(["2026-10-06"]) && doc.days["2026-10-06"].armed.length === 3, { dates: doc.dates, armed: doc.days["2026-10-06"] && doc.days["2026-10-06"].armed });
  ok("the written day carries every rung with armed, value and threshold", doc.days["2026-10-06"].rungs.length === LAD.LADDER.length &&
    doc.days["2026-10-06"].rungs.every((g) => "armed" in g && "value" in g && "threshold" in g && "what" in g && "source" in g));
  ok("the written day says it was read-only", doc.days["2026-10-06"].readOnly === true);
  ok("the run says which file it wrote and that nothing else was", /written: .*ai-bubble-ladder-status\.json — the key 2026-10-06/.test(r.text) && /the only thing this run wrote/.test(r.text));
});
T("writing the same day twice", () => {
  const first = fs.readFileSync(OUT, "utf8");
  run(["--data", fixture("b1-cross").dir, "--write"]);
  ok("running the same day twice writes the same document (it is idempotent)", fs.readFileSync(OUT, "utf8") === first);
});
T("a second day joins the first", () => {
  const r = run(["--data", fixture("b1-cross").dir, "--as-of", "2026-10-05", "--write"]);
  const doc = JSON.parse(fs.readFileSync(OUT, "utf8"));
  ok("a second day is added and the first is kept, byte for byte", JSON.stringify(doc.dates) === JSON.stringify(["2026-10-05", "2026-10-06"]) &&
    (doc.days["2026-10-06"] || {}).armed.includes("B1-QQQ") && !(doc.days["2026-10-05"] || {}).armed.includes("B1-QQQ"), doc.dates);
  ok("the run says how many other dates it kept", /1 other date\(s\) kept unchanged/.test(r.text), r.lines[r.lines.length - 2]);
});
T("re-running a day replaces only that day", () => {
  const doc0 = JSON.parse(fs.readFileSync(OUT, "utf8"));
  ok("the file still holds both days to work on", !!doc0.days["2026-10-05"] && !!doc0.days["2026-10-06"], doc0.dates);
  if (!doc0.days["2026-10-06"] || !doc0.days["2026-10-05"]) return;
  doc0.days["2026-10-06"].armed = ["TAMPERED"];
  fs.writeFileSync(OUT, JSON.stringify(doc0, null, 1));
  run(["--data", fixture("b1-cross").dir, "--write"]);
  const doc = JSON.parse(fs.readFileSync(OUT, "utf8"));
  ok("re-running a day replaces that day and leaves the others alone", !doc.days["2026-10-06"].armed.includes("TAMPERED") &&
    JSON.stringify(doc.days["2026-10-05"]) === JSON.stringify(doc0.days["2026-10-05"]));
});
T("a status file that cannot be read is never replaced", () => {
  const bad = path.join(SCRATCH, "not-json.json");
  fs.writeFileSync(bad, "{ this is not json");
  const r = run(["--data", fixture("b1-cross").dir, "--write", "--out", bad]);
  ok("a status file that does not parse is NOT replaced: the run refuses and says so", r.code === 1 && r.wrote === null && /does not parse/.test(r.text) && fs.readFileSync(bad, "utf8") === "{ this is not json", { code: r.code, text: r.text.slice(-200) });
});
T("a write that fails", () => {
  const r = run(["--data", fixture("b1-cross").dir, "--write", "--out", path.join(SCRATCH, "x.json")], { write: () => { throw new Error("disk full"); } });
  ok("a failed write ends 1, writes nothing, and says the file is as it was", r.code === 1 && r.wrote === null && /NOT WRITTEN/.test(r.text) && !fs.existsSync(path.join(SCRATCH, "x.json")), { code: r.code, text: r.text.slice(-200) });
});

// ───────────────────────────── 7. bad input, usage, and the shape of the store ─────────────────────────────

T("a store that is not there", () => {
  const r = run(["--data", path.join(SCRATCH, "no-such-store")]);
  ok("a store that is not there: exit 1, nothing computed, and the store's shape is explained", r.code === 1 && r.status === null && /CANNOT READ THE STORED CLOSES/.test(r.text) && /QQQ, SPY, SMH, VWEHX, VFITX/.test(r.text), { code: r.code, threw: r.threw });
  ok("it says it never fetches", /never fetches/.test(r.text));
});
T("one missing series", () => {
  const dir = path.join(SCRATCH, "missing-one");
  fs.mkdirSync(dir, { recursive: true });
  for (const [sym, rows] of Object.entries(fixture("b1-cross").rows)) if (sym !== "SMH") fs.writeFileSync(path.join(dir, `${sym}.json`), JSON.stringify(rows));
  const r = run(["--data", dir]);
  ok("one missing series stops the whole run (no half ladder)", r.code === 1 && r.status === null && /SMH: cannot read/.test(r.text), { code: r.code, threw: r.threw, first: r.lines[0] });
});
T("rows with no adjusted close", () => {
  const dir = path.join(SCRATCH, "nulls");
  fs.mkdirSync(dir, { recursive: true });
  const src = fixture("b1-cross").rows;
  for (const [sym, rows] of Object.entries(src)) {
    const copy = rows.map((x, i) => (sym === "QQQ" && i > 0 && i % 50 === 0 ? { d: x.d, c: x.c, a: null } : x));
    fs.writeFileSync(path.join(dir, `${sym}.json`), JSON.stringify(copy));
  }
  const s = LAD.readSeries(dir, "QQQ");
  ok("rows with no adjusted close are dropped, as the lenses drop them", s.rows < src.QQQ.length && s.values.every((v) => Number.isFinite(v)), { kept: s.rows, of: src.QQQ.length });
});
T("two rows for one date", () => {
  const dir = path.join(SCRATCH, "dupes");
  fs.mkdirSync(dir, { recursive: true });
  const rows = fixture("b1-cross").rows.QQQ;
  fs.writeFileSync(path.join(dir, "QQQ.json"), JSON.stringify([...rows, rows[rows.length - 1]]));
  let why = "";
  try { LAD.readSeries(dir, "QQQ"); } catch (e) { why = e.message; }
  ok("two rows for one date is refused, never silently taken twice", /holds two rows for/.test(why), why);
});
T("rows out of order", () => {
  const dir = path.join(SCRATCH, "unsorted");
  fs.mkdirSync(dir, { recursive: true });
  const rows = fixture("b1-cross").rows.QQQ.slice();
  fs.writeFileSync(path.join(dir, "QQQ.json"), JSON.stringify(rows.slice().reverse()));
  const s = LAD.readSeries(dir, "QQQ");
  ok("rows out of order are put in order before anything is computed", s.dates.every((d, i) => i === 0 || d > s.dates[i - 1]) && s.to === "2026-10-06", { to: s.to });
});
T("the adjusted close is the series", () => {
  const dir = path.join(SCRATCH, "wrong-field");
  fs.mkdirSync(dir, { recursive: true });
  for (const [sym, rows] of Object.entries(fixture("b1-cross").rows)) fs.writeFileSync(path.join(dir, `${sym}.json`), JSON.stringify(rows.map((x) => ({ d: x.d, c: x.c, a: x.c }))));
  const q = rung(run(["--data", dir]).status, "B1-QQQ");
  ok("the adjusted close `a` is the series, not the price close `c` (the fixtures make them differ)", q.value === 194 && q.sma === 199.97, q);
});
T("usage", () => {
  const r = run(["--data", fixture("b1-cross").dir, "--as-of", "nonsense"]);
  ok("a bad --as-of is usage (exit 2), not a run", r.code === 2 && /--as-of needs a YYYY-MM-DD date/.test(r.text), { code: r.code, text: r.text.slice(0, 120) });
  ok("an unknown argument is usage (exit 2)", run(["--wat"]).code === 2);
  ok("the usage text says no order is ever placed", /No order is ever placed/.test(run(["--wat"]).text));
});
T("--json", () => {
  const r = run(["--data", fixture("b1-cross").dir, "--json"]);
  const doc = JSON.parse(r.lines[0]);
  ok("--json prints the status document as one block of JSON and still writes nothing", doc.spec === LAD.STATUS_SPEC && doc.rungs.length === 6 && r.wrote === null);
  ok("--json prints no summary line before the document", r.lines[0].startsWith("{"));
});

// ───────────────────────────── 8. no network, and the command line itself ─────────────────────────────

T("no network", () => {
  const real = global.fetch;
  global.fetch = () => { throw new Error("the monitor made a network call"); };
  let r;
  try { r = run(["--data", fixture("b1-cross").dir]); } finally { global.fetch = real; }
  ok("the monitor runs with every network call poisoned to throw", r.code === 0 && r.threw === null, r.threw);
});
T("the command line", () => {
  const r = cp.spawnSync(process.execPath, [path.join(BE, "ai-bubble-ladder-monitor.js"), "--data", fixture("b2-cross").dir],
    { encoding: "utf8", timeout: 120000, env: { ...process.env, NO_COLOR: "1" } });
  ok("the command line runs it and exits 0", r.status === 0, { status: r.status, stderr: String(r.stderr).slice(0, 300) });
  ok("the command line prints the same summary", /AI-BUBBLE LADDER — status for 2026-10-06/.test(r.stdout) && /B2-QQQ     ARMED/.test(r.stdout), String(r.stdout).split("\n").slice(0, 4));
  const bad = cp.spawnSync(process.execPath, [path.join(BE, "ai-bubble-ladder-monitor.js"), "--nope"], { encoding: "utf8", timeout: 120000 });
  ok("the command line exits 2 on usage", bad.status === 2, bad.status);
});

// ───────────────────────────── 9. the package itself: deploy and rollback on a scratch repository ─────────────────────────────

const DEP = require(path.join(PKG, "deploy.cjs"));
let repoN = 0;
/** a scratch repository with an empty backend/ — deploy writes the two files into it */
function scratchRepo() {
  const repo = path.join(SCRATCH, "repo" + ++repoN);
  fs.mkdirSync(path.join(repo, "backend", "data"), { recursive: true });
  fs.writeFileSync(path.join(repo, "backend", "package.json"), '{ "name": "scratch-backend", "version": "0.0.0" }\n');
  return repo;
}
const CLEAR = { procList: [], holidays: {}, now: () => Date.parse("2026-10-17T18:00:00Z") };   // a Saturday: outside every window
const PASSES = { what: "a fake gate that passes", run: () => ({ ok: true, line: "ALL 1 CHECKS PASSED", note: "" }) };
const quiet = (o) => ({ log: () => {}, ...o });

T("deploy: the staged bytes are the ones pinned in deploy.cjs", () => {
  for (const f of DEP.FILES) {
    const live = fs.readFileSync(path.join(PKG, ...f.staged.split("/")));
    ok(`deploy.cjs pins the sha256 of ${f.staged}`, DEP.sha(live) === f.stagedSha, { pinned: f.stagedSha, actual: DEP.sha(live) });
  }
  ok("deploy.cjs ships exactly the two new files, and no base copy of either", DEP.FILES.length === 2 && DEP.FILES.every((f) => !("base" in f)), DEP.FILES.map((f) => f.rel));
});
T("deploy: plan, apply, idempotence, rollback", () => {
  const repo = scratchRepo(), M = DEP.make(quiet({ repo, pkg: PKG, ...CLEAR }));
  const p0 = M.plan();
  ok("plan on a repository without them: both files are absent and there is no problem", p0.allAbsent && p0.toCreate.length === 2 && p0.problems.length === 0, p0.problems);
  const r = M.apply({ gate: PASSES });
  ok("apply creates both files", r.result === "applied" && r.created.length === 2, { result: r.result, why: r.why });
  ok("each created file is byte-for-byte the staged one", DEP.FILES.every((f) => DEP.sha(fs.readFileSync(path.join(repo, ...f.rel.split("/")))) === f.stagedSha));
  ok("plan after the apply: both applied", M.plan().allApplied);
  ok("a second apply does nothing", M.apply({ gate: PASSES }).result === "noop");
  // the monitor's own record must survive the rollback
  const data = path.join(repo, "backend", "data", "ai-bubble-ladder-status.json");
  fs.writeFileSync(data, '{ "spec": "ai-bubble-ladder-status-v1", "dates": [], "days": {} }');
  const b = M.rollback();
  ok("rollback removes both files", b.result === "rolled-back" && b.removed.length === 2 && DEP.FILES.every((f) => !fs.existsSync(path.join(repo, ...f.rel.split("/")))), { result: b.result, why: b.why });
  ok("rollback leaves the monitor's own dated readings where they are", fs.existsSync(data));
  ok("a second rollback does nothing", M.rollback().result === "noop");
});
T("deploy: DRIFT is refused by both write modes", () => {
  const repo = scratchRepo(), M = DEP.make(quiet({ repo, pkg: PKG, ...CLEAR }));
  const f = path.join(repo, ...DEP.FILES[0].rel.split("/"));
  fs.writeFileSync(f, "// something else wrote this file\n");
  const p = M.plan();
  ok("a file that is there and is not the staged bytes reads DRIFT", p.files[0].state === "DRIFT" && p.problems.some((w) => /is DRIFT/.test(w)), p.problems);
  const a = M.apply({ gate: PASSES });
  ok("apply refuses on DRIFT and writes nothing", a.result === "refused" && a.created.length === 0 && !fs.existsSync(path.join(repo, ...DEP.FILES[1].rel.split("/"))), a.result);
  const b = M.rollback();
  ok("rollback refuses on DRIFT and deletes nothing", b.result === "refused" && fs.readFileSync(f, "utf8") === "// something else wrote this file\n", b.result);
  ok("the refusal says to read the change first", b.why.some((w) => /never deletes a file it does not recognise/.test(w)), b.why);
});
T("deploy: the fences", () => {
  const wed = Date.parse("2026-10-14T20:00:00Z");                      // Wednesday 14:00 MT — inside the close chain's window
  const SAT = Date.parse("2026-10-17T18:00:00Z"), clear = { now: SAT, holidays: {} };   // a Saturday: outside every window
  ok("13:50-15:50 MT on a trading weekday is a refusal", DEP.fences({ now: wed, procList: [], holidays: {} }).some((w) => /13:50-15:50 MT/.test(w)), DEP.fences({ now: wed, procList: [], holidays: {} }));
  ok("the same clock time on a market holiday is not", DEP.fences({ now: wed, procList: [], holidays: { "2026-10-14": "made-up test holiday" } }).length === 0);
  ok("the same clock time on a Saturday is not", DEP.fences({ now: Date.parse("2026-10-17T20:00:00Z"), procList: [], holidays: {} }).length === 0);
  ok("just before the window is clear and just inside it is not",
    DEP.fences({ now: Date.parse("2026-10-14T19:49:00Z"), procList: [], holidays: {} }).length === 0 &&
    DEP.fences({ now: Date.parse("2026-10-14T19:50:00Z"), procList: [], holidays: {} }).length === 1);
  ok("the end of the window is clear again", DEP.fences({ now: Date.parse("2026-10-14T21:50:00Z"), procList: [], holidays: {} }).length === 0);
  const busy = [{ pid: 999, cmd: "node /home/x/backend/ai-bubble-ladder-monitor.js --write" }];
  ok("the monitor running is a refusal", DEP.fences({ ...clear, procList: busy }).some((w) => /a process of this unit is running/.test(w)));
  ok("the library running is a refusal too", DEP.fences({ ...clear, procList: [{ pid: 997, cmd: "node backend/ai-bubble-ladder.js" }] }).some((w) => /a process of this unit is running/.test(w)));
  ok("the close chain running is a refusal", DEP.fences({ ...clear, procList: [{ pid: 998, cmd: "node automation/close-chain.cjs" }] }).some((w) => /a process of this unit is running/.test(w)));
  ok("this process itself is never counted", DEP.fences({ ...clear, procList: [{ pid: process.pid, cmd: "node backend/ai-bubble-ladder-monitor.js" }] }).length === 0);
  ok("an unrelated process is not a refusal", DEP.fences({ ...clear, procList: [{ pid: 996, cmd: "node backend/console.js" }] }).length === 0);
  ok("a process list that cannot be read is a refusal (fail-closed)",
    DEP.fences({ ...clear, procList: () => { throw new Error("no process list here"); } }).some((w) => /cannot be read/.test(w)));
  const repo = scratchRepo(), M = DEP.make(quiet({ repo, pkg: PKG, procList: () => { throw new Error("no process list here"); }, holidays: {}, now: CLEAR.now }));
  const a = M.apply({ gate: PASSES });
  ok("an apply behind a fence writes nothing", a.result === "refused" && DEP.FILES.every((f) => !fs.existsSync(path.join(repo, ...f.rel.split("/")))), a.result);
});
T("deploy: the selftest gate", () => {
  const repo = scratchRepo(), M = DEP.make(quiet({ repo, pkg: PKG, ...CLEAR }));
  const a = M.apply({ gate: { what: "a fake gate that fails", run: () => ({ ok: false, why: "exit 1; FAIL something", note: "" }) } });
  ok("an apply whose gate fails writes nothing", a.result === "refused" && a.why.some((w) => /did not pass/.test(w)) && DEP.FILES.every((f) => !fs.existsSync(path.join(repo, ...f.rel.split("/")))), a);
  ok("the gate passes only on exit 0 AND 'ALL n CHECKS PASSED' as the last line of stdout",
    DEP.selftestVerdict({ status: 0, stdout: "x\nALL 430 CHECKS PASSED\n", stderr: "" }).ok === true &&
    DEP.selftestVerdict({ status: 1, stdout: "ALL 430 CHECKS PASSED\n", stderr: "" }).ok === false &&
    DEP.selftestVerdict({ status: 0, stdout: "2 CHECK(S) FAILED of 430\n", stderr: "" }).ok === false &&
    DEP.selftestVerdict({ status: 0, stdout: "", stderr: "" }).ok === false);
  ok("the gate never reads stderr as a verdict", DEP.selftestVerdict({ status: 0, stdout: "ALL 430 CHECKS PASSED", stderr: "(node:1) Warning: something advisory" }).ok === true);
  ok("a failed gate's reason carries the selftest's FAIL lines", /FAIL  a check/.test(DEP.selftestVerdict({ status: 1, stdout: "FAIL  a check\n1 CHECK(S) FAILED of 2", stderr: "" }).why));
  ok("the gate's child never inherits AI_BUBBLE_LADDER_SELFTEST_STAGED, so it always judges the package's own staged/",
    /delete env\.AI_BUBBLE_LADDER_SELFTEST_STAGED;/.test(fs.readFileSync(path.join(PKG, "deploy.cjs"), "utf8")));
  ok("the gate really does strip it: a child started by deploy's own run() cannot see it", (() => {
    process.env.AI_BUBBLE_LADDER_SELFTEST_STAGED = "/nowhere-at-all";
    try {
      const r = DEP.make(quiet({ repo: SCRATCH, pkg: PKG })).d.run(["-e", "process.stdout.write(String(process.env.AI_BUBBLE_LADDER_SELFTEST_STAGED))"]);
      return r.status === 0 && r.stdout === "undefined";
    } finally { delete process.env.AI_BUBBLE_LADDER_SELFTEST_STAGED; }
  })());
});
T("deploy: a write that fails leaves nothing behind", () => {
  const repo = scratchRepo();
  let n = 0;
  const M = DEP.make(quiet({ repo, pkg: PKG, ...CLEAR, write: (file, buf) => { if (++n === 2) throw new Error("disk full"); DEP.writeExact(file, buf); } }));
  const a = M.apply({ gate: PASSES });
  ok("a failed write ends 'failed' and every file the run created is removed", a.result === "failed" && a.undone === true && DEP.FILES.every((f) => !fs.existsSync(path.join(repo, ...f.rel.split("/")))), a);
});
T("the package writes nothing when it is only read", () => {
  const before = snapshot(PKG);
  DEP.plan();
  DEP.make(quiet({ repo: scratchRepo(), pkg: PKG, ...CLEAR })).plan();
  ok("nothing in the package itself is ever written by a plan", JSON.stringify(snapshot(PKG)) === JSON.stringify(before));
  const src = fs.readFileSync(path.join(PKG, "record.cjs"), "utf8");
  ok("record.cjs --dry writes nothing: every write sits behind the DRY return", /if \(DRY\) \{ console\.log\("\\n--dry: nothing was written\."\); process\.exit\(0\); \}/.test(src) &&
    src.indexOf("if (DRY)") < src.indexOf("writeJsonAtomic(F(CR_REL)"), { dryAt: src.indexOf("if (DRY)"), writeAt: src.indexOf("writeJsonAtomic(F(CR_REL)") });
  ok("record.cjs records no comparability break and names the package", /breaksComparability: false/.test(src) && /package: D\.PKG_REL/.test(src));
});

// ───────────────────────────── the verdict ─────────────────────────────

if (fail) { console.log(`\n${fail} CHECK(S) FAILED of ${pass + fail}`); process.exit(1); }
console.log(`ALL ${pass} CHECKS PASSED`);
