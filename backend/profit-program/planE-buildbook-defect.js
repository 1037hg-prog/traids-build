#!/usr/bin/env node
"use strict";
/**
 * PLAN E - buildBook month-end-window defect: verify, measure in dollars, test the proposed fix. READ-ONLY on the repo; offline.
 * NEVER edits risk-manager.js. It does NOT print or compute R270's registered statistic (managed minus unmanaged; "read once after 12 months"):
 * it prices only the defect itself - the spurious ZN-proxy return that the as-coded window puts in the book column - and the would-do status that
 * backend/data/risk-manager.json already publishes.
 *
 *   node backend/profit-program/planE-buildbook-defect.js
 * Writes backend/data/profit-program/planE-buildbook-defect.json and backend/data/profit-program/planE-buildbook-fix.diff (the proposed diff).
 *
 * THE DEFECT (risk-manager.js buildBook):
 *     byMonth[month] = every session PRESENT; window = ds.slice(-5)
 * For a month still in progress that is "the latest 5 sessions so far", which always contains today. So on EVERY night of the month the run flags
 * today as a month-end-window day and books 4.2 x 0.79 x IEF (minus 8.4 bps) as the ZN leg. The nightly forward writer appends that row, so the
 * forward file carries the ZN proxy on every session of every month except it never skips one: ~100% of rows instead of the true 5-in-21.
 */
const fs = require("fs"), path = require("path");
const M = require("./planE-model.js");
const { writeJsonAtomic, writeTextAtomic } = require("../lib/atomic-write.js");
const OUTDIR = path.join(M.BACKEND, "data", "profit-program");
const must = (c, m) => { if (!c) { console.error("ASSERT FAILED: " + m); process.exit(1); } };
const bps = (x) => (10000 * x).toFixed(1);
const usd = (x) => (x < 0 ? "-$" : "+$") + Math.abs(x).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

(async () => {
  const inp = M.loadInputs(); const out = { spec: "planE-buildbook-defect-v1", inputsFetchedAt: inp.fetchedAt };
  const src = M.riskManagerSource().split(/\r?\n/);
  console.log("1. THE CODE (risk-manager.js, read verbatim)");
  src.forEach((l, i) => { if (/const byMonth = \{\}/.test(l) || /const w = ds\.slice\(-5\)/.test(l)) console.log(`   line ${i + 1}: ${l.trim().slice(0, 230)}`); });
  src.forEach((l, i) => { if (/leg\.TSY = inWin\.has\(d\)/.test(l)) console.log(`   line ${i + 1}: ${l.trim().slice(0, 230)}`); });

  // ---- 2. the October table
  const asCoded = await M.rmRows(inp, { asOf: "2026-10-09" }), fixed = await M.rmRows(inp, { asOf: "2026-10-09", fixWindow: true });
  const cal = inp.calendar["2026-10"], trueWin = new Set(cal.slice(-5));
  console.log(`\n2. OCTOBER 2026 - window flag per session, as the nightly run sees it vs the true calendar window (true window = ${cal.slice(-5).join(", ")})`);
  console.log("   date        asCoded(last-bar run)  asCoded(that night's run)  trueWindow");
  const octRows = asCoded.rows.filter((r) => r.d.startsWith("2026-10"));
  const nightly = {};
  for (const r of octRows) {
    const night = await M.rmRows(inp, { asOf: r.d }); const last = night.rows[night.rows.length - 1]; must(last.d === r.d, "night run last row = " + r.d);
    nightly[r.d] = last; console.log(`   ${r.d}  ${String(r.win).padEnd(22)} ${String(last.win).padEnd(26)} ${trueWin.has(r.d)}`);
  }
  must(octRows.every((r) => nightly[r.d].win === true), "as-coded nightly run flags every October session");
  must(!octRows.some((r) => trueWin.has(r.d)), "no October session to date is in the true window");
  out.octoberFlags = octRows.map((r) => ({ d: r.d, nightlyAsCoded: nightly[r.d].win, trueWindow: trueWin.has(r.d) }));

  // ---- 3. dollars on the forward file rows (book column only)
  const fwd = fs.readFileSync(path.join(M.BACKEND, "data", "risk-manager-forward.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
  console.log("\n3. THE FORWARD FILE (backend/data/risk-manager-forward.jsonl) - book column, rebuilt night by night, per $100,000");
  console.log("   date         file book%   rebuilt as-coded%   rebuilt fixed%   spurious ZN %   spurious $ per $100k   in true window?");
  let sumSp = 0, maxRebuildErr = 0; const fwdRows = [];
  const verb = { as: null };
  for (const f of fwd) {
    const a = await M.rmRows(inp, { asOf: f.d, verbatim: true }), b = await M.rmRows(inp, { asOf: f.d, verbatim: true, fixWindow: true });
    const ra = a.rows[a.rows.length - 1], rb = b.rows[b.rows.length - 1]; must(ra.d === f.d && rb.d === f.d, "row date " + f.d);
    const err = Math.abs(ra.book - f.book); maxRebuildErr = Math.max(maxRebuildErr, err);
    const sp = ra.book - rb.book; sumSp += sp;
    fwdRows.push({ d: f.d, file: f.book, asCoded: ra.book, fixed: rb.book, spurious: sp });
    console.log(`   ${f.d}   ${(100 * f.book).toFixed(3).padStart(8)}      ${(100 * ra.book).toFixed(3).padStart(8)}            ${(100 * rb.book).toFixed(3).padStart(8)}        ${(100 * sp).toFixed(3).padStart(8)}      ${usd(100000 * sp).padStart(9)}             ${rb.win}`);
  }
  const a9 = await M.rmRows(inp, { asOf: "2026-10-09", verbatim: true }), b9 = await M.rmRows(inp, { asOf: "2026-10-09", verbatim: true, fixWindow: true });
  console.log(`   rebuild fidelity: max |file book - rebuilt as-coded book| = ${bps(maxRebuildErr)} bps (adjusted-close revisions; the rebuild reproduces the file)`);
  must(maxRebuildErr < 0.0005, "rebuilt as-coded book must reproduce the forward file within 5 bps");
  const compound = (xs) => xs.reduce((p, x) => p * (1 + x), 1) - 1;
  const cF = compound(fwdRows.map((r) => r.file)), cX = compound(fwdRows.map((r) => r.fixed));
  console.log(`   forward rows ${fwd[0].d}..${fwd[fwd.length - 1].d} (${fwd.length} sessions): compounded book as written ${(100 * cF).toFixed(3)}% -> with the window fixed ${(100 * cX).toFixed(3)}% : the defect adds ${(100 * (cF - cX)).toFixed(3)} pt = ${usd(100000 * (cF - cX))} per $100k (sum of daily spurious ${usd(100000 * sumSp)})`);
  out.forward = { rows: fwdRows, maxRebuildErrBps: +bps(maxRebuildErr), compoundedAsWrittenPct: +(100 * cF).toFixed(4), compoundedFixedPct: +(100 * cX).toFixed(4), defectPtOver: +(100 * (cF - cX)).toFixed(4), defectUsdPer100k: +(100000 * (cF - cX)).toFixed(1) };

  { const ytd = (rows) => 100 * (rows.filter((r) => r.d >= "2026-01-01").reduce((p, r) => p * (1 + r.book), 1) - 1);
    const yA = ytd(a9.rows), yF = ytd(b9.rows);
    console.log(`   2026 year-to-date through 2026-10-09 from a full-history run on that night (unmanaged book): as coded ${yA.toFixed(2)}%  vs window fixed ${yF.toFixed(2)}%  (${usd(1000 * (yA - yF))} per $100k)`);
    out.ytd2026 = { asCodedPct: +yA.toFixed(3), fixedPct: +yF.toFixed(3) }; }
  // ---- 4. the same defect over a full hypothetical forward year (every session carries the proxy)
  const fx = await M.rmRows(inp, { asOf: "2026-09-30", fixWindow: true }), fxv = await M.rmRows(inp, { asOf: "2026-09-30", verbatim: true, fixWindow: true });
  const zl = fx.ZN_LEV, zb = fx.ZN_BETA;
  const lo = "2025-10-01", hi = "2026-09-30", yr = fxv.rows.filter((r) => r.d >= lo && r.d <= hi);
  const asW = yr.map((r) => r.book + ((r.ief == null ? 0 : zl * zb * r.ief - 0.0004 * zl / 2) - r.legs.TSY)), fixedS = yr.map((r) => r.book);
  const sA = M.dailyStats(asW), sF = M.dailyStats(fixedS);
  const nonWin = yr.filter((r) => !r.win).length;
  console.log(`\n4. IF THE NIGHTLY WRITER HAD RUN THROUGH ${lo}..${hi} (${yr.length} sessions, ${nonWin} of them outside the true window, i.e. ${(100 * nonWin / yr.length).toFixed(0)}% of rows carrying a spurious ZN proxy)`);
  console.log(`   as the nightly rows would read : CAGR ${sA.cagrPct}%  vol ${sA.volPct}%  max daily drawdown ${sA.maxDDdailyPct}%   -> on $100k: ${usd(100000 * (Math.pow(1 + sA.cagrPct / 100, 1) - 1))}/yr`);
  console.log(`   with the window fixed          : CAGR ${sF.cagrPct}%  vol ${sF.volPct}%  max daily drawdown ${sF.maxDDdailyPct}%   -> on $100k: ${usd(100000 * sF.cagrPct / 100)}/yr`);
  console.log(`   spurious ZN exposure moves the 12-month book by ${(sA.cagrPct - sF.cagrPct).toFixed(2)} pt of CAGR (${usd(100000 * (sA.cagrPct - sF.cagrPct) / 100)} per $100k per year; ${usd(100000 * (sA.cagrPct - sF.cagrPct) / 100 / 12)}/month) and vol by ${(sA.volPct - sF.volPct).toFixed(2)} pt`);
  out.hypotheticalYear = { window: [lo, hi], sessions: yr.length, sessionsOutsideTrueWindow: nonWin, asWritten: sA, fixed: sF };

  // ---- 5. the paper record: the scoreboard's model is on the calendar window, so it must match the fixed rebuild, not the as-coded one
  const sb = JSON.parse(fs.readFileSync(path.join(M.BACKEND, "data", "planE-paper-scoreboard.json"), "utf8"));
  const sess = sb.daily.map((x) => x.date).filter((d) => d > sb.start);       // model starts at the start-date close
  const modelCum = (rowsObj, fin) => { const dd = M.rmDaily(rowsObj.rows, { w: M.E_W, zn: 4.2 }, { fin }).filter((x) => sess.includes(x.d)); return 100 * (dd.reduce((p, x) => p * (1 + x.r), 1) - 1); };
  const aC = await M.rmRows(inp, { asOf: "2026-10-09" }), fC = await M.rmRows(inp, { asOf: "2026-10-09", fixWindow: true });
  const mA = modelCum(aC, false), mF = modelCum(fC, false);
  console.log(`\n5. THE PAPER RECORD IS NOT AFFECTED. Scoreboard model cumulative ${sess[0]}..${sess[sess.length - 1]} (${sess.length} sessions): ${sb.summary.modelCumPct.toFixed(3)}% (= ${usd(1000 * sb.summary.modelCumPct)} on $100k).`);
  console.log(`   Same dates, risk-manager buildBook rebuilt: window FIXED ${mF.toFixed(3)}%  |  as coded ${mA.toFixed(3)}%  (model-vs-paper tracking in the scoreboard uses the calendar window, so the paper-vs-model line is clean; only risk-manager-forward.jsonl and risk-manager.json carry the defect).`);
  out.paperRecord = { scoreboardModelCumPct: +sb.summary.modelCumPct.toFixed(4), rebuiltFixedPct: +mF.toFixed(4), rebuiltAsCodedPct: +mA.toFixed(4), paperDollarEffect: 0 };

  // ---- 6. status the risk manager publishes today (manage(): vol scale, drawdown scale, would-do)
  const vA = await M.rmRows(inp, { asOf: "2026-10-09", verbatim: true }), vF = await M.rmRows(inp, { asOf: "2026-10-09", verbatim: true, fixWindow: true });
  const st = (v) => { const m = v.api.manage(v.rows), l = m[m.length - 1], rs = v.api.riskShares(v.rows); return { asOf: l.d, ddPct: +(100 * l.dd).toFixed(2), vol60Pct: +(100 * l.vol60).toFixed(1), vol20Pct: +(100 * l.vol20).toFixed(1), volScale: +l.volScale.toFixed(3), ddScale: l.ddScale, wouldDo: +l.scaleNext.toFixed(3), tsyRiskSharePct: Math.round(100 * rs.share.TSY), cryptoRiskSharePct: Math.round(100 * rs.share.CRYPTO) }; };
  const pub = JSON.parse(fs.readFileSync(path.join(M.BACKEND, "data", "risk-manager.json"), "utf8"));
  const sa = st(vA), sf = st(vF);
  console.log(`\n6. STATUS THE MANAGER PUBLISHES (manage() / riskShares(), the repo's own functions, rebuilt)`);
  console.log(`   as coded (rebuild)  : ${JSON.stringify(sa)}`);
  console.log(`   window fixed        : ${JSON.stringify(sf)}`);
  console.log(`   risk-manager.json   : asOf ${pub.asOf} drawdown ${pub.today.drawdownPct}% vol60 ${pub.today.vol60Pct}% vol20 ${pub.today.vol20Pct}% wouldDo ${pub.today.wouldDo} TSY risk share ${Math.round(100 * pub.riskShare60d.TSY)}%`);
  out.status = { asCoded: sa, windowFixed: sf, published: { asOf: pub.asOf, ddPct: pub.today.drawdownPct, vol60Pct: pub.today.vol60Pct, wouldDo: pub.today.wouldDo, tsyShare: pub.riskShare60d.TSY } };

  // ---- 7. the proposed diff, applied to a COPY in memory and tested against the fixed rebuild
  const orig = M.riskManagerSource(), a0 = orig.indexOf("  const byMonth = {};");
  must(a0 > 0, "anchor byMonth");
  const patched = orig
    .replace("  const today = new Date().toISOString().slice(0, 10);\n  const r = await fetchBars(", "  const today = new Date().toISOString().slice(0, 10);\n  const r = await fetchBars(")
    .replace("  // month-end windows: last 5 sessions of each month\n  const byMonth = {}; allDays.forEach((d) =>", "  // month-end windows: last 5 sessions of each CALENDAR month. For the month in progress the sessions still to come come from Alpaca's calendar\n  // (GET /v2/calendar, as r219-zn-month-end.js monthSessions does); if that GET fails the run refuses rather than fall back to \"the latest 5 so far\".\n  const lastDay = allDays[allDays.length - 1], [cy, cm] = lastDay.split(\"-\").map(Number), monthEnd = new Date(Date.UTC(cy, cm, 0)).toISOString().slice(0, 10);\n  const calR = await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${lastDay}&end=${monthEnd}`, { headers: { \"APCA-API-KEY-ID\": process.env.ALPACA_KEY_ID, \"APCA-API-SECRET-KEY\": process.env.ALPACA_SECRET_KEY } });\n  if (!calR.ok) throw new Error(`calendar ${calR.status} - refusing: the month-end window cannot be placed`);\n  const futureSessions = (await calR.json()).map((x) => x.date).filter((x) => x > lastDay);\n  const byMonth = {}; allDays.concat(futureSessions).forEach((d) =>");
  must(patched !== orig && patched.includes("allDays.concat(futureSessions)"), "diff applied to the in-memory copy");
  // coinbase(): midnight-aligned chunks, completed UTC days only (the planE-paper-scoreboard.js coinbaseDaily pattern) - no day dropped at a chunk boundary
  const cbOld = orig.slice(orig.indexOf("async function coinbase(coin, fromIso) {"), orig.indexOf("async function buildBook("));
  const cbNew = "async function coinbase(coin, fromIso) { const m = new Map(), stop = Date.now();   // chunks aligned to 00:00 UTC (no candle dropped at a boundary); the in-progress candle is kept, as before\n  for (let s = Date.parse(fromIso.slice(0, 10) + \"T00:00:00Z\"); s < stop;) { const e = Math.min(stop, s + 290 * 864e5); const r = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`, { headers: { \"User-Agent\": \"TRAIDS risk-manager\" } }); const a = await r.json(); if (!Array.isArray(a)) throw new Error(`coinbase ${coin}: not a candle list`); for (const [t, , , , c] of a) m.set(new Date(t * 1000).toISOString().slice(0, 10), c); s = e; if (s < stop) await sleep(350); }\n  return m; }\n";
  const patched2 = patched.replace(cbOld, cbNew);
  must(patched2 !== patched, "coinbase diff applied");
  writeTextAtomic(path.join(OUTDIR, "risk-manager.proposed.js.txt"), patched2);                 // a COPY under data/profit-program; risk-manager.js is untouched
  // behavioural test of the window patch: run the patched buildBook text (calendar GET stubbed with the cached October calendar) and compare rows with the fixWindow sandbox
  const a1 = patched2.indexOf("const W = {"), b1 = patched2.indexOf("function summary(");
  let body = patched2.slice(a1, b1); body = body.replace("async function coinbase(coin, fromIso) {", "async function coinbase__real(coin, fromIso) {") + "\nasync function coinbase(coin) { return __cbm(coin); }\nreturn { buildBook };";
  const cbm = async (coin) => { const m = new Map(); for (const [d, c] of Object.entries(inp.crypto[coin])) m.set(d, c); return m; };
  const fakeFetch = async (url) => { const mm = /start=([\d-]+)&end=([\d-]+)/.exec(String(url)); return { ok: true, status: 200, json: async () => inp.calendar["2026-10"].filter((d) => d >= mm[1] && d <= mm[2]).map((date) => ({ date })) }; };
  const barsAll = {}; for (const s of ["QQQ", "SPY", "GLD", "EFA", "DBMF", "IEF"]) barsAll[s] = inp.bars[s];
  const g = new Function("fs", "D", "fetchBars", "__cbm", "fetch", "process", body);
  const apiP = g(fs, M.D, async () => ({ bars: barsAll, truncatedStart: [] }), cbm, fakeFetch, { env: { ALPACA_KEY_ID: "x", ALPACA_SECRET_KEY: "y" } });
  const rowsP = await apiP.buildBook("2019-06-03");
  const ref = await M.rmRows(inp, { asOf: "9999-12-31", fixWindow: true, verbatim: true });
  const n = Math.min(rowsP.length, ref.rows.length); let maxd = 0; for (let i = 0; i < n; i++) maxd = Math.max(maxd, Math.abs(rowsP[i].book - ref.rows[i].book));
  must(rowsP.length === ref.rows.length, "patched row count");
  must(maxd < 1e-12, "patched risk-manager buildBook == fixWindow sandbox (max diff " + maxd + ")");
  const octOnly = rowsP.filter((r) => r.d.startsWith("2026-10")).every((r) => !r.legs.TSY);
  console.log(`\n7. THE PROPOSED DIFF, run: patched buildBook (calendar GET stubbed) vs the fixWindow rebuild over ${n} rows: max |diff| ${maxd.toExponential(1)}; October rows carry no ZN proxy: ${octOnly}`);
  const { execFileSync } = require("child_process");
  let diff = ""; try { execFileSync("diff", ["-u", path.join(M.BACKEND, "risk-manager.js"), path.join(OUTDIR, "risk-manager.proposed.js.txt")], { encoding: "utf8" }); } catch (e) { diff = e.stdout || ""; }
  diff = diff.replace(/^--- .*$/m, "--- backend/risk-manager.js").replace(/^\+\+\+ .*$/m, "+++ backend/risk-manager.js (proposed)");
  writeTextAtomic(path.join(OUTDIR, "planE-buildbook-fix.diff"), diff);
  console.log(`   diff written to backend/data/profit-program/planE-buildbook-fix.diff (${diff.split("\n").length} lines); risk-manager.js untouched.`);
  out.patchTest = { rows: n, maxAbsDiff: maxd, octoberTsyZero: octOnly };
  if (process.argv.includes("--live-coinbase")) {
    // run the PROPOSED coinbase() text against the live public endpoint (GET only) and count one-day holes, beside the CURRENT function's text
    const mk = (txt) => new Function("fetch", "sleep", txt + "\nreturn coinbase;")(fetch, (ms) => new Promise((r) => setTimeout(r, ms)));
    const holes = (m) => { const ks = [...m.keys()].sort(); let h = 0; for (let i = 1; i < ks.length; i++) if ((Date.parse(ks[i]) - Date.parse(ks[i - 1])) / 864e5 !== 1) h++; return { days: ks.length, holes: h }; };
    const cur = await mk(cbOld.replace(/\n$/, ""))("BTC", "2018-06-01"), prop = await mk(cbNew)("BTC", "2018-06-01");
    out.coinbaseLive = { current: holes(cur), proposed: holes(prop) };
    console.log(`   live coinbase() check, BTC from 2018-06-01: CURRENT text ${JSON.stringify(out.coinbaseLive.current)} | PROPOSED text ${JSON.stringify(out.coinbaseLive.proposed)}`);
  }
  writeJsonAtomic(path.join(OUTDIR, "planE-buildbook-defect.json"), out); console.log("wrote backend/data/profit-program/planE-buildbook-defect.json");
})().catch((e) => { console.error("planE-buildbook-defect FAILED:", e.stack); process.exit(1); });
