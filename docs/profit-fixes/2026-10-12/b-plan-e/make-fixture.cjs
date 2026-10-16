#!/usr/bin/env node
"use strict";
/**
 * PROFIT FIXES B — freeze the selftest's inputs. READ-ONLY on the repo; writes ONLY fixtures/inputs.json in this folder (writeJsonAtomic).
 *   node docs/profit-fixes/2026-10-12/b-plan-e/make-fixture.cjs
 * It copies, from the profit program's own cache and evidence files (nothing is fetched):
 *   bars      QQQ SPY GLD EFA DBMF IEF daily adjusted closes       backend/data/profit-program/planE-inputs.json
 *   crypto    BTC ETH completed UTC daily closes (no holes)        the same file
 *   calendar  the NYSE sessions of 2026-09 and 2026-10             the same file (every FINISHED month before them is cut from the SPY bar
 *             dates at run time by lib.cjs sessionsByMonth — a session is a day SPY has a bar — so nothing more needs storing here)
 *   dtb3      the 3-month T-bill, last value of each month         backend/data/training/fred/DTB3.csv
 *   znRows    the real ten-year-note month-end windows 2019-06..   backend/profit-program/planE-model.js znWindows()
 *   known     the answers the evidence files hold                  planE-buildbook-defect.json, planE-baseline.json
 * and refuses to write unless the frozen inputs reproduce the model's stated rate two ways (the model library and this package's own
 * arithmetic) and the recorded hole pattern of the old Coinbase loop.
 */
const fs = require("fs"), path = require("path");
const L = require("./lib.cjs");
const B = (f) => path.join(L.REPO, "backend", f), PP = (f) => B(path.join("data", "profit-program", f));
const must = (c, m) => { if (!c) { console.error("REFUSED — fixture not written: " + m); process.exit(1); } };
const shaOf = (f) => L.sha256(fs.readFileSync(f));

const inp = JSON.parse(fs.readFileSync(PP("planE-inputs.json"), "utf8")), defect = JSON.parse(fs.readFileSync(PP("planE-buildbook-defect.json"), "utf8")), base = JSON.parse(fs.readFileSync(PP("planE-baseline.json"), "utf8"));
const M = require(B("profit-program/planE-model.js"));
const SYMS = ["QQQ", "SPY", "GLD", "EFA", "DBMF", "IEF"];
const bars = {}; for (const s of SYMS) { must(Array.isArray(inp.bars[s]) && inp.bars[s].length > 1000, `bars ${s} missing`); bars[s] = inp.bars[s].map((b) => [b.t.slice(0, 10), b.c]); }
const crypto = {}; for (const c of ["BTC", "ETH"]) { const ks = Object.keys(inp.crypto[c]).sort(); for (let i = 1; i < ks.length; i++) must((Date.parse(ks[i]) - Date.parse(ks[i - 1])) / L.DAY === 1, `crypto ${c} has a hole at ${ks[i]}`); crypto[c] = Object.fromEntries(ks.map((k) => [k, inp.crypto[c][k]])); }
const dtb3 = {}; let dtbLast = null; for (const l of fs.readFileSync(B("data/training/fred/DTB3.csv"), "utf8").trim().split(/\r?\n/).slice(1)) { const [d, v] = l.split(","); if (d >= "2018-01-01" && v && v !== "." && Number.isFinite(+v)) { dtb3[d.slice(0, 7)] = +v; dtbLast = d; } }
const znRows = M.znWindows().filter((r) => r.m >= "2019-06" && r.m <= "2026-09").map((r) => ({ m: r.m, tb: r.tb, tre: r.tre }));
must(znRows.length === 88, `88 ten-year-note windows expected, got ${znRows.length}`);
const holes = Object.keys(inp.crypto.BTC).filter((d) => !(d in inp.cryptoRiskManagerStyle.BTC)).sort();

const fix = {
  spec: "pfb-fixture-v1", builtAt: new Date().toISOString(),
  source: { "planE-inputs.json": { sha256: shaOf(PP("planE-inputs.json")), fetchedAt: inp.fetchedAt, feed: inp.feed, adjustment: inp.adjustment }, "planE-buildbook-defect.json": shaOf(PP("planE-buildbook-defect.json")), "planE-baseline.json": shaOf(PP("planE-baseline.json")),
    "DTB3.csv": { sha256: shaOf(B("data/training/fred/DTB3.csv")), lastRow: dtbLast }, "futures-month-end.json": shaOf(B("data/futures-month-end.json")), "futures-daily/ZN.json": shaOf(B("data/futures-daily/ZN.json")) },
  bars, crypto, calendar: { "2026-09": inp.calendar["2026-09"], "2026-10": inp.calendar["2026-10"] }, dtb3, znRows,
  known: {
    inputsFetchedAt: inp.fetchedAt,
    forward: defect.forward.rows.map((r) => ({ d: r.d, file: r.file, asCoded: r.asCoded, fixed: r.fixed })),
    compoundedAsWrittenPct: defect.forward.compoundedAsWrittenPct, compoundedFixedPct: defect.forward.compoundedFixedPct, defectUsdPer100k: defect.forward.defectUsdPer100k,
    hypotheticalYear: defect.hypotheticalYear, octoberFlags: defect.octoberFlags, coinbaseLive: defect.coinbaseLive,
    statedPct: base.py.E.annualReturnPct, statedMonths: base.py.E.months, statedOnHoledSeriesPct: base.coinbaseHoles.E_repoPattern, oldHeadlinePct: base.rm["asCoded@2026-09-30"].cagrPct, financedProxyPct: base.rm["windowFixed+financed@2026-09-30"].cagrPct,
    recordedHoles: holes,
  },
};
// the frozen inputs must reproduce the model's own number, two ways
const lib = M.monthlyStats(M.pyBuild({ bars: inp.bars, crypto: inp.crypto }, { asOf: "2026-09-30" }).run("2019-06", "2026-09", M.PYW.E).mo).annualReturnPct, own = L.statedRate(fix);
must(lib === base.py.E.annualReturnPct, `the model library gives ${lib}, planE-baseline.json says ${base.py.E.annualReturnPct}`);
must(own.months === 88 && own.annualReturnPct.toFixed(2) === base.py.E.annualReturnPct.toFixed(2), `this package's arithmetic gives ${own.annualReturnPct} over ${own.months} months, the model's output says ${base.py.E.annualReturnPct}`);
const fa = Date.parse(inp.fetchedAt), pred = []; for (let k = 1; k <= 10; k++) pred.push(L.iso(fa - (300 * k - 1) * L.DAY));
must(JSON.stringify(pred.sort()) === JSON.stringify(holes), `the recorded holes (${holes.join(" ")}) are not the chunk boundaries of a run at ${inp.fetchedAt}`);
fs.mkdirSync(path.dirname(L.FIXTURE_FILE), { recursive: true });
L.atomic().writeJsonAtomic(L.FIXTURE_FILE, fix, { pretty: 0 });
console.log(`fixtures/inputs.json written: ${fs.statSync(L.FIXTURE_FILE).size} bytes · bars ${SYMS.map((s) => `${s} ${bars[s].length}`).join(", ")} · crypto ${Object.keys(crypto.BTC).length} days · ${znRows.length} note windows · T-bill through ${dtbLast}`);
console.log(`  stated rate from the frozen inputs: model library ${lib}% · this package ${own.annualReturnPct.toFixed(4)}% over ${own.months} months · planE-baseline.json ${base.py.E.annualReturnPct}%`);
console.log(`  recorded holes of the old Coinbase loop (${holes.length}): ${holes.join(" ")}`);
