#!/usr/bin/env node
"use strict";
/**
 * CAPITAL MODEL — MEASURED COST (2026-10-16) — the selftest's FIXTURE TREE: a tiny, plainly synthetic copy of the data the Plan E model
 * reads, built from a seed with the four arithmetic operations and an integer PRNG only, so every machine builds the same bytes.
 *
 *   node docs/capital-model-measured-cost/2026-10-16/make-fixture.cjs --out <dir> [--which base|staged]
 *   node docs/capital-model-measured-cost/2026-10-16/make-fixture.cjs --freeze          rewrite fixtures/fixture-spec.json (the shas)
 *
 * WHY A SYNTHETIC TREE: this clean copy carries no data at all (README.md, "What is not here"). The real inputs this model reads —
 * backend/data/profit-program/planE-inputs.json, backend/data/futures-month-end.json, backend/data/futures-daily/ZN.json,
 * backend/data/training/fred/DTB3.csv — are all missing here, so the selftest builds its own and states that they are made up.
 * NOTHING in the tree is market data: the prices are a seeded random walk started at 100 (BTC at 1000, ETH at 100), the T-bill is a
 * seeded saw-tooth, and the ZN windows are seeded numbers. NOTES.md says so too.
 *
 * ONE thing is tuned: the two knobs (alpha on the note windows, beta on the risky drift) were solved once, at build time, so that the
 * fixture satisfies planE-baseline.js's OWN asserts (PY E 24.24 %/yr and D2 28.16 %/yr within 0.05) — otherwise the script stops at its
 * assert and the selftest could not run it end to end. The knobs are frozen in fixtures/fixture-spec.json; no solver runs here, so the
 * generator is pure arithmetic and its output is byte-stable.
 *
 * The tree: backend/{risk-manager.js, lib/atomic-write.js} copied from the repo · backend/profit-program/{planE-model.js,
 * planE-baseline.js} copied from this package's base/ or staged/ · the four data files above, generated.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");
const SPEC_FILE = path.join(PKG, "fixtures", "fixture-spec.json");
const { writeJsonAtomic, writeTextAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
/** mulberry32: integer arithmetic only — the same stream on every platform and every Node */
const mulberry32 = (a) => () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const r4 = (x) => Math.round(x * 1e4) / 1e4, r8 = (x) => Math.round(x * 1e8) / 1e8;
const allDays = (from, to) => { const out = []; for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z"); t += DAY) out.push(iso(t)); return out; };
const isWeekday = (d) => { const w = new Date(d + "T12:00:00Z").getUTCDay(); return w >= 1 && w <= 5; };
const sessions = (from, to) => allDays(from, to).filter(isWeekday);

/** the knobs and the seeds, frozen in fixtures/fixture-spec.json; loadSpec() is what everything else reads */
const loadSpec = () => JSON.parse(fs.readFileSync(SPEC_FILE, "utf8"));
const DEFAULTS = Object.freeze({
  first: "2018-06-01", last: "2026-10-09", alpha: 2.009, beta: 1.125,
  paths: { QQQ: { seed: 1001, volBp: 95, driftBp: 22, flipP: 0.012, start: 100 }, SPY: { seed: 1002, volBp: 70, driftBp: 18, flipP: 0.011, start: 100 },
    GLD: { seed: 1003, volBp: 60, driftBp: 12, flipP: 0.010, start: 100 }, EFA: { seed: 1004, volBp: 65, driftBp: 10, flipP: 0.013, start: 100 },
    DBMF: { seed: 1005, volBp: 45, driftBp: 8, flipP: 0.009, start: 100 }, IEF: { seed: 1006, volBp: 35, driftBp: 5, flipP: 0.008, start: 100 },
    BTC: { seed: 2001, volBp: 320, driftBp: 48, flipP: 0.008, start: 1000 }, ETH: { seed: 2002, volBp: 380, driftBp: 42, flipP: 0.009, start: 100 } },
  tbillSeed: 777, znSeed: 3003, holeEvery: 300, septGrossWindow: 0.0071, septPrevClose: 110,
});

/** one price path: a two-state drift regime and a bounded uniform shock, rounded to 4 decimals at every step */
function pricePath(days, p, beta) {
  const rnd = mulberry32(p.seed), out = []; let px = p.start, up = 1;
  for (const d of days) {
    if (rnd() < p.flipP) up = -up;
    px = r4(px * (1 + (2 * rnd() - 1) * p.volBp / 1e4 + beta * up * p.driftBp / 1e4));
    if (px < 1) px = 1;
    out.push([d, px]);
  }
  return out;
}
/** the T-bill csv: a seeded saw-tooth between 0.05 % and 5.5 %, one row a weekday (the model reads the last row of each month) */
function dtb3Text(S, seed) {
  const rnd = mulberry32(seed), lines = ["DATE,DTB3"]; let rate = 2;
  for (const d of S) { rate = Math.round((rate + (2 * rnd() - 1) * 0.04) * 100) / 100; if (rate < 0.05) rate = 0.05; if (rate > 5.5) rate = 5.5; lines.push(`${d},${rate.toFixed(2)}`); }
  return lines.join("\n") + "\n";
}
const monthsBetween = (from, to) => { const out = []; let [y, m] = from.split("-").map(Number); for (;;) { const k = `${y}-${String(m).padStart(2, "0")}`; out.push(k); if (k >= to) break; m++; if (m > 12) { m = 1; y++; } } return out; };

/** every generated file of the tree, as bytes, from the spec alone */
function files(spec = loadSpec()) {
  const S = sessions(spec.first, spec.last), C = allDays(spec.first, spec.last);
  const bars = {}; for (const s of ["QQQ", "SPY", "GLD", "EFA", "DBMF", "IEF"]) bars[s] = pricePath(S, spec.paths[s], s === "IEF" ? 1 : spec.beta).map(([d, c]) => ({ t: d + "T04:00:00Z", c }));
  const cryptoFull = {}; for (const c of ["BTC", "ETH"]) cryptoFull[c] = Object.fromEntries(pricePath(C, spec.paths[c], spec.beta));
  // the repo's old Coinbase loop dropped one candle at every chunk boundary; the fixture drops every 300th day so the baseline's hole count has something to count
  const holed = {}; for (const c of ["BTC", "ETH"]) { holed[c] = {}; const ks = Object.keys(cryptoFull[c]); ks.forEach((d, i) => { if (i === 0 || i === ks.length - 1 || (i + 1) % spec.holeEvery !== 0) holed[c][d] = cryptoFull[c][d]; }); }
  // the calendar covers the WHOLE month, bars or no bars: that is what the month-end-window fix asks it for (sessions still to come)
  const calendar = {}; for (const ym of ["2026-09", "2026-10"]) { const [y, m] = ym.split("-").map(Number); calendar[ym] = sessions(`${ym}-01`, iso(Date.UTC(y, m, 0))); }
  const inputs = { spec: "planE-inputs-fixture (SYNTHETIC — no market data)", fetchedAt: spec.last + "T23:00:00.000Z", feed: "fixture", adjustment: "none", bars, crypto: cryptoFull, cryptoRiskManagerStyle: holed, calendar };
  const dtb3 = dtb3Text(S, spec.tbillSeed);
  // the note windows: a seeded gross window return scaled by alpha, with the stored 4 bps round trip already subtracted (as the real store has it)
  const tbm = {}; for (const l of dtb3.trim().split("\n").slice(1)) { const [d, v] = l.split(","); tbm[d.slice(0, 7)] = +v / 100; }
  const rnd = mulberry32(spec.znSeed), rowsOut = [];
  for (const m of monthsBetween(spec.first.slice(0, 7), "2026-08")) rowsOut.push({ m, tb: r8((tbm[m] || 0.04) / 12), tre: r8(spec.alpha * ((2 * rnd() - 1) * 0.0115 + 0.0016) - 0.0004) });
  const monthEnd = { spec: "futures-month-end-fixture (SYNTHETIC)", rowsOut };
  // September 2026 is left OUT of rowsOut on purpose, so znWindows() builds that row from the daily note store — the branch the baseline prints a source line for
  const sep = sessions("2026-09-01", "2026-09-30"), last = r4(spec.septPrevClose * (1 + spec.alpha * spec.septGrossWindow)), n = sep.length, step = (last - spec.septPrevClose) / (n - 1);
  const znBars = sep.map((d, i) => ({ d, c: i === n - 1 ? last : r4(spec.septPrevClose + step * i + ((i % 3) - 1) * 0.02) }));
  const znDaily = { spec: "ZN-daily-fixture (SYNTHETIC)", bars: znBars };
  return { inputs, dtb3, monthEnd, znDaily, sessionCount: S.length, cryptoDays: C.length };
}

const REL = Object.freeze({
  inputs: "backend/data/profit-program/planE-inputs.json", dtb3: "backend/data/training/fred/DTB3.csv",
  monthEnd: "backend/data/futures-month-end.json", znDaily: "backend/data/futures-daily/ZN.json",
});
/** write the whole tree under dir (which = the package folder the two live files come from) -> { dir, shas } */
function buildTree(dir, { which = "staged", spec = loadSpec() } = {}) {
  const F = files(spec), put = (rel, buf) => { const p = path.join(dir, ...rel.split("/")); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); };
  fs.mkdirSync(path.join(dir, "backend", "data", "profit-program"), { recursive: true });
  for (const rel of ["backend/risk-manager.js", "backend/lib/atomic-write.js"]) put(rel, fs.readFileSync(path.join(REPO, ...rel.split("/"))));
  for (const f of ["planE-model.js", "planE-baseline.js"]) put(`backend/profit-program/${f}`, fs.readFileSync(path.join(PKG, which, "backend", "profit-program", f)));
  const shas = {}, at = (rel) => { const p = path.join(dir, ...rel.split("/")); fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };
  writeJsonAtomic(at(REL.inputs), F.inputs, { pretty: 0 });
  writeTextAtomic(at(REL.dtb3), F.dtb3);
  writeJsonAtomic(at(REL.monthEnd), F.monthEnd, { pretty: 1 });
  writeJsonAtomic(at(REL.znDaily), F.znDaily, { pretty: 1 });
  for (const [k, rel] of Object.entries(REL)) shas[k] = sha(fs.readFileSync(path.join(dir, ...rel.split("/"))));
  return { dir, which, shas, sessionCount: F.sessionCount, cryptoDays: F.cryptoDays };
}

module.exports = { PKG, REPO, SPEC_FILE, DEFAULTS, REL, loadSpec, files, buildTree, sessions, allDays, mulberry32, sha, monthsBetween };

if (require.main === module) {
  const a = process.argv.slice(2), get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
  if (a.includes("--freeze")) {
    const old = fs.existsSync(SPEC_FILE) ? loadSpec() : null, spec = { spec: "capital-model-measured-cost-fixture-v1", ...DEFAULTS, ...(old ? { known: old.known } : {}) };
    const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "cmmc-freeze-")), r = buildTree(tmp, { which: "base", spec });
    spec.shas = r.shas; spec.sessionCount = r.sessionCount; spec.cryptoDays = r.cryptoDays;
    writeJsonAtomic(SPEC_FILE, spec, { pretty: 1 });
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`fixtures/fixture-spec.json written — ${r.sessionCount} sessions, ${r.cryptoDays} crypto days\n  ${Object.entries(r.shas).map(([k, v]) => `${k} ${v.slice(0, 16)}`).join("\n  ")}`);
    console.log("  known answers are NOT touched by --freeze: selftest.cjs --freeze-known writes those.");
    process.exit(0);
  }
  const out = get("--out");
  if (!out) { console.log("usage: node docs/capital-model-measured-cost/2026-10-16/make-fixture.cjs --out <dir> [--which base|staged]\n       node docs/capital-model-measured-cost/2026-10-16/make-fixture.cjs --freeze\nNothing was done."); process.exit(2); }
  const r = buildTree(path.resolve(out), { which: get("--which") || "staged" });
  console.log(`fixture tree (${r.which}) at ${r.dir} — ${r.sessionCount} sessions, ${r.cryptoDays} crypto days`);
  for (const [k, v] of Object.entries(r.shas)) console.log(`  ${k.padEnd(9)} ${v}  ${REL[k]}`);
}
