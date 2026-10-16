#!/usr/bin/env node
"use strict";
/**
 * PROFIT FIXES B (Plan E) — EVIDENCE: every number NOTES.md quotes, printed with its arithmetic. READ-ONLY and offline: it writes nothing and
 * fetches nothing. The code it runs is the real text of risk-manager.js as it is today ("before") and with the staged edits ("after"), on the
 * frozen inputs (fixtures/inputs.json = the profit program's cache). Dollar figures are MODEL ARITHMETIC on $100,000 over history, 252 trading
 * days a year — not a forecast and not advice.
 *   node docs/profit-fixes/2026-10-12/b-plan-e/evidence.cjs            everything
 *   node docs/profit-fixes/2026-10-12/b-plan-e/evidence.cjs --no-scan  without the scan for the old figure (sections 1-6 only)
 */
const fs = require("fs"), path = require("path"), os = require("os");
const L = require("./lib.cjs");
const B = (f) => path.join(L.REPO, "backend", f);
const usd = (x, dp = 0) => (x < 0 ? "-$" : "+$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pct = (x, dp = 2) => `${x.toFixed(dp)}%`, compound = (xs) => xs.reduce((g, x) => g * (1 + x), 1) - 1, cagr = (xs) => 100 * ((1 + compound(xs)) ** (252 / xs.length) - 1);
const r2 = (p) => +p.toFixed(2), perYear = (p) => `${usd(L.usdYear(r2(p)))} a year, ${usd(L.usdDay(r2(p)), 2)} a trading day`;   // dollars from the rate as quoted (2 decimals)

(async () => {
  const E = L.loadEdits(), fix = L.loadFixture(), K = fix.known, T = L.texts(E), RM = "backend/risk-manager.js", before = T[RM].base, after = T[RM].staged;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pfb-evidence-")), dtb = path.join(tmp, "DTB3.csv"); fs.writeFileSync(dtb, L.dtb3Csv(fix));
  const night = (text, d) => L.nightRows(text, fix, d, { dtb3File: dtb }), last = (r) => r.rows[r.rows.length - 1];
  const ief = new Map(fix.bars.IEF.map((r, i, a) => [r[0], i ? r[1] / a[i - 1][1] - 1 : null]));
  console.log(`PROFIT FIXES B (Plan E) — EVIDENCE · live files are ${[...new Set(Object.values(T).map((t) => t.state))].join("/")} · inputs frozen from the cache fetched ${K.inputsFetchedAt} · all dollars are model arithmetic on $100,000, not advice\n`);

  // ── 1. the month-end window
  console.log("1. THE MONTH-END WINDOW (risk-manager.js buildBook) — the shadow book's forward rows, night by night");
  console.log("   night        file as written   today's code   staged code   Treasury proxy today / staged   in the true window");
  const rb = [], rs = [];
  for (const k of K.forward) { const b = last(await night(before, k.d)), s = last(await night(after, k.d)); rb.push(b.book); rs.push(s.book);
    console.log(`   ${k.d}   ${(100 * k.file).toFixed(3).padStart(9)}%      ${(100 * b.book).toFixed(3).padStart(8)}%     ${(100 * s.book).toFixed(3).padStart(8)}%       ${(100 * b.legs.TSY).toFixed(3).padStart(7)}% / ${(100 * s.legs.TSY).toFixed(3).padStart(6)}%          ${s.legs.TSY !== 0}`); }
  const cFile = compound(K.forward.map((k) => k.file)), cB = compound(rb), cS = compound(rs);
  console.log(`   ${K.forward.length} forward nights compounded: the file as written ${pct(100 * cFile, 4)} = ${usd(100000 * cFile)} · today's code rebuilt ${pct(100 * cB, 4)} = ${usd(100000 * cB)} · staged ${pct(100 * cS, 4)} = ${usd(100000 * cS)}`);
  console.log(`   the defect over those nights: ${usd(100000 * (cFile - cS), 1)} per $100,000 (the evidence file: $${K.defectUsdPer100k}); nights where today's code is off by more than 5 bps: ${K.forward.filter((k, i) => Math.abs(rb[i] - rs[i]) > 5e-4).length} of ${K.forward.length}`);
  const yr = (await night(after, "2026-09-30")).rows.filter((r) => r.d >= "2025-10-01" && r.d <= "2026-09-30"), asWritten = yr.map((r) => r.book - r.legs.TSY + (ief.get(r.d) == null ? 0 : 4.2 * 0.79 * ief.get(r.d) - (0.0004 * 4.2) / 2)), fixedS = yr.map((r) => r.book);
  const cA = cagr(asWritten), cF = cagr(fixedS);
  console.log(`   a whole year of nightly rows, 2025-10-01..2026-09-30 (${yr.length} sessions, ${yr.filter((r) => r.legs.TSY === 0).length} outside the true window):`);
  console.log(`     BEFORE (every night books the proxy on its own row): ${pct(cA)} = ${perYear(cA)}`);
  console.log(`     AFTER  (the proxy only on the last 5 sessions)      : ${pct(cF)} = ${perYear(cF)}      (evidence file: ${K.hypotheticalYear.asWritten.cagrPct}% / ${K.hypotheticalYear.fixed.cagrPct}%)`);
  console.log("     on the PAPER record: $0 a year, $0 a day — the paper book never read this file (the scoreboard's model has always used the full calendar)");
  try { const rows = fs.readFileSync(B("data/risk-manager-forward.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l)); console.log(`   live forward file today: ${rows.length} rows ${rows[0].d}..${rows[rows.length - 1].d} (R270's evidence; rows dated before the first post-apply run carry the defect)`); } catch (e) { console.log(`   live forward file: UNKNOWN (${e.message})`); }

  // ── 2. the Coinbase fetch
  console.log("\n2. THE COINBASE FETCH (risk-manager.js coinbase) — at the cache's fetch time, against the recorded candles");
  const now = Date.parse(K.inputsFetchedAt), run = async (text, coin) => { const cb = L.coinbaseServer(L.cryptoUpTo(fix, L.iso(now))); const m = await L.rmApi(text, { fetch: L.makeFetch({ coinbase: cb }), fetchBars: async () => ({}), nowMs: now, dtb3File: dtb }).coinbase(coin, "2018-06-01"); return { m, calls: cb.calls.length }; };
  const bB = await run(before, "BTC"), bE = await run(before, "ETH"), sB = await run(after, "BTC"), all = Object.keys(fix.crypto.BTC), holes = all.filter((d) => !bB.m.has(d));
  console.log(`   BEFORE: ${bB.m.size} of ${all.length} days in ${bB.calls} requests — ${holes.length} holes: ${holes.join(" ")}`);
  console.log(`   AFTER : ${sB.m.size} of ${all.length} days in ${sB.calls} requests — ${all.filter((d) => !sB.m.has(d)).length} holes`);
  const holed = { BTC: Object.fromEntries([...bB.m]), ETH: Object.fromEntries([...bE.m]) }, rH = L.statedRate(fix, holed).annualReturnPct, rC = L.statedRate(fix).annualReturnPct;
  console.log(`   the stated model on each series: BEFORE ${pct(rH)} = ${perYear(rH)} · AFTER ${pct(rC)} = ${perYear(rC)} · the holes cost the model's reading ${(r2(rC) - r2(rH)).toFixed(2)} pt = ${usd(L.usdYear(r2(rC) - r2(rH)))} a year, ${usd(L.usdDay(r2(rC) - r2(rH)), 2)} a trading day`);
  const b930 = (await night(before, "2026-09-30")).rows.map((r) => r.book), s930 = (await night(after, "2026-09-30")).rows.map((r) => r.book);
  console.log(`   the shadow book itself, 2019-06-03..2026-09-30 (${s930.length} days; the window is the same on a finished month, so this is the fetch alone): BEFORE ${pct(cagr(b930))} · AFTER ${pct(cagr(s930))}`);
  console.log("   a failed or partial answer: BEFORE the loop stops and the book is built on what arrived (exit 0, a forward row written); AFTER the run ends UNKNOWN (exit 1, no row, the snapshot marked) — selftest cases '(b) ...'");
  // a feed that stopped inside the last day: every day through yesterday (UTC) is there, the candle of the last bar's own day is not
  for (const [d, staleAfter, what] of [["2026-10-08", "2026-10-07", "candles through 10-07 only: the row's whole crypto leg is missing"], ["2026-10-05", "2026-10-04", "a Monday, candles through Sunday: the weekend's part of the leg is booked without Monday's"]]) {
    const run = (text) => L.nightRows(text, fix, d, { dtb3File: dtb, coinbaseFault: { staleAfter } }), healthy = last(await night(before, d)), staleB = last(await run(before)), off = staleB.book - healthy.book;
    const staleA = await run(after).then((r) => `a row is written (${last(r).book})`, (e) => `UNKNOWN, no row ("${String(e.message).split(" — ")[0]}")`);
    console.log(`   a feed that stopped inside the last day — the night of ${d}, ${what}: BEFORE the row is written with the crypto leg at ${(100 * staleB.legs.CRYPTO).toFixed(4)}% instead of ${(100 * healthy.legs.CRYPTO).toFixed(4)}%, the book off by ${(1e4 * Math.abs(off)).toFixed(2)} bps = ${usd(100000 * off, 2)} per $100,000 on that row, exit 0; AFTER ${staleA}`); }
  { // what the close chain keeps of an UNKNOWN night: the last 400 characters of the failed step's stderr (automation/close-chain.cjs is READ as text here, never loaded)
    let at = "?"; try { at = fs.readFileSync(path.join(L.REPO, "automation", "close-chain.cjs"), "utf8").split(/\r?\n/).findIndex((l) => l.includes('String(r.stderr || r.stdout || "").slice(-400)')) + 1 || "not found"; } catch {}
    let baseline = null; try { baseline = fs.readFileSync(B("data/profit-program/planE-baseline.json"), "utf8"); } catch {}
    const noLast = after.replace(" console.error(`RISK MANAGER UNKNOWN (shadow): ${why}`);", ""), FAULTS = [["HTTP 429", { coinbaseFault: { at: 1, kind: "rate-limit" } }, /HTTP 429/], ["a missing candle", { coinbaseFault: { drop: ["2026-09-20"] } }, /missing/], ["the calendar refused", { calendarFault: { status: 401 } }, /HTTP 401/], ["the calendar cut", { calendarFault: { until: "2026-10-09" } }, /cut answer/], ["no candle for the last bar's day", { coinbaseFault: { staleAfter: "2026-10-07" } }, /no candle for/]];
    const named = (text) => FAULTS.filter(([, scen, re]) => { const r = L.runRiskManager(text, fix, { asOf: "2026-10-08", baseline, ...scen }); return r.status === 1 && re.test(String(r.stderr || r.stdout || "").slice(-400)); }).map(([n]) => n);
    const a = named(after), b = noLast === after ? null : named(noLast);
    console.log(`   what the close chain records of an UNKNOWN night — the last 400 characters of the step's stderr (automation/close-chain.cjs line ${at}), ${FAULTS.length} faults run as a process: AFTER (the stack first, the one-line reason last) the cause is in that record on ${a.length} of ${FAULTS.length}; with the reason on stdout only, as it was first staged, on ${b ? b.length : "?"} of ${FAULTS.length}${b ? ` (${b.join(", ") || "none"})` : ""}`); }

  // ── 3. the headline rate
  console.log("\n3. THE HEADLINE RATE");
  const rows930 = (await night(after, "2026-09-30")).rows, rf = (d) => (fix.dtb3[d.slice(0, 7)] ?? fix.dtb3[Object.keys(fix.dtb3).sort().pop()]) / 100 / 252;
  const byM = {}; for (const r of rows930) (byM[r.d.slice(0, 7)] = byM[r.d.slice(0, 7)] || []).push(r.d); const winDays = new Set(Object.values(byM).flatMap((ds) => ds.slice(-5)));   // every month through 2026-09 is complete
  const proxy = cagr(rows930.map((r) => r.book)), financed = cagr(rows930.map((r) => r.book - (winDays.has(r.d) ? 4.2 * 0.79 * rf(r.d) : 0)));
  console.log(`   OLD headline — the shadow book's own history, ZN proxied by IEF total return, no financing: ${pct(proxy)} = ${perYear(proxy)}      (planE-baseline.json rm asCoded@2026-09-30: ${K.oldHeadlinePct}%)`);
  console.log(`   STATED model — the monthly family on the real ten-year-note windows, recomputed here from its inputs: ${pct(rC, 4)} -> ${pct(rC)} = ${perYear(rC)}`);
  console.log(`   the old figure was ${(r2(proxy) - r2(rC)).toFixed(2)} pt too high = ${usd(L.usdYear(r2(proxy) - r2(rC)))} a year, ${usd(L.usdYear(r2(proxy) - r2(rC)) / 12)} a month, ${usd(L.usdDay(r2(proxy) - r2(rC)), 2)} a trading day per $100,000`);
  console.log(`   the scoreboard's model line: BEFORE = that proxy book's rule (${pct(proxy)}); AFTER = the same with the T-bill charged on the proxied notional on window days: ${pct(financed)} = ${perYear(financed)}      (planE-baseline.json rm windowFixed+financed@2026-09-30: ${K.financedProxyPct}%)`);
  const lastRf = fix.dtb3[Object.keys(fix.dtb3).sort().pop()];
  console.log(`   the financing the model line now pays: 4.2 x 0.79 x ${lastRf}% x 5/252 x $100,000 = ${usd(4.2 * 0.79 * (lastRf / 100) * (5 / 252) * 100000, 2)} a window (5 sessions), ${usd(4.2 * 0.79 * (lastRf / 100) * (60 / 252) * 100000)} a year of 12 windows — that much false paper shortfall comes out of the comparison`);
  try { const sb = JSON.parse(fs.readFileSync(B("data/planE-paper-scoreboard.json"), "utf8")), days = sb.daily.filter((r) => !r.start), cal = [...fix.calendar["2026-09"], ...fix.calendar["2026-10"]], win = new Set(["2026-09", "2026-10"].flatMap((ym) => fix.calendar[ym].slice(-5))), hit = days.filter((r) => win.has(r.date) && typeof r.modelPct === "number");
    const g0 = days.reduce((g, r) => g * (1 + r.modelPct / 100), 1), g1 = days.reduce((g, r) => g * (1 + (r.modelPct - (win.has(r.date) ? 100 * 4.2 * 0.79 * rf(r.date) : 0)) / 100), 1);
    console.log(`   the paper record as stored (${sb.start}..${sb.asOf}, written ${String(sb.writtenAt || sb.generatedAt).slice(0, 16)}Z): ${days.length} model days, ${hit.length} of them a window day (${hit.map((r) => r.date).join(", ") || "none"}); model cumulative ${pct(100 * (g0 - 1), 4)} = ${usd(100000 * (g0 - 1), 2)} -> restated with the financing ${pct(100 * (g1 - 1), 4)} = ${usd(100000 * (g1 - 1), 2)}: the 'vs model' line moves by ${(100 * (g0 - g1)).toFixed(4)} pp = ${usd(100000 * (g0 - g1), 2)} at the first run after the apply (stored summary: model ${sb.summary.modelCumPct.toFixed(4)}%, paper ${sb.summary.cumPct.toFixed(4)}%, vs model ${sb.summary.vsModelPp.toFixed(4)} pp)`);
    console.log(`   October's window ${fix.calendar["2026-10"].slice(-5)[0]}..${fix.calendar["2026-10"].slice(-5)[4]} (5 sessions of the ${cal.length} in the two months) is the first one inside the record with a paper ZN position`); }
  catch (e) { console.log(`   the paper record as stored: UNKNOWN (${String(e.message).slice(0, 120)})`); }
  try { const k = JSON.parse(fs.readFileSync(B("data/profit-program/skeptic-planE.json"), "utf8")).S6; console.log(`   what stays after the correction (stored skeptic check S6, ${k.windows} windows; read, not re-run): real note minus the proxy per window, unfinanced mean ${usd(k.meanRealMinusProxyUsd)} (sd $${k.sdUsd}); with the T-bill charged mean ${usd(k.financedMeanUsd)} (sd $${k.financedSdUsd}) — the bias goes, the +/- $${k.financedSdUsd} a window of proxy noise does not; windows needed to see the old bias at t=2: ${k.windowsToDetect}`); } catch (e) { console.log(`   stored skeptic check S6: UNKNOWN (${String(e.message).slice(0, 100)})`); }
  try { const j = JSON.parse(fs.readFileSync(B("data/profit-program/planE-baseline.json"), "utf8")); console.log(`   the model's own output file today: py.E.annualReturnPct ${j.py.E.annualReturnPct} over ${j.py.E.months} months ${j.py.E.from}..${j.py.E.to} (inputs fetched ${j.inputsFetchedAt}) — what the staged files read at run time`); } catch (e) { console.log(`   the model's own output file: UNKNOWN (${e.message}) — the staged files would print UNKNOWN`); }
  try { const s = JSON.parse(fs.readFileSync(B("data/risk-manager.json"), "utf8")); console.log(`   stored today in backend/data/risk-manager.json (as of ${s.asOf}): preview unmanaged ${s.preview["2019-06..now"].unmanaged.cagrPct}% / managed ${s.preview["2019-06..now"].managed.cagrPct}% — the proxy book's level, unlabelled until the fix`); } catch {}
  { // the one place the staged file still STORES the proxy book's level: the labelled preview block of its snapshot (the real file run as a process, offline, on three nights)
    let baseline = null; try { baseline = fs.readFileSync(B("data/profit-program/planE-baseline.json"), "utf8"); } catch {}
    const OLD = ["27.36", "27.1", "27.2", "27.3", "27.4", "27.5"], seen = [];
    for (const d of ["2026-09-30", "2026-10-08", "2026-10-09"]) { const s = L.runRiskManager(after, fix, { asOf: d, baseline }), pv = s.snapshot && s.snapshot.preview && s.snapshot.preview["2019-06..now"], out = { ...s.snapshot, preview: null };
      const b = L.runRiskManager(before, fix, { asOf: d, baseline }), pb = b.snapshot && b.snapshot.preview && b.snapshot.preview["2019-06..now"];
      seen.push(`${d}: today's file prints the level ${pb ? pb.unmanaged.cagrPct : "?"}%; staged stores preview unmanaged ${pv ? pv.unmanaged.cagrPct : "?"}% (managed ${pv ? pv.managed.cagrPct : "?"}%), prints ${OLD.filter((x) => s.stdout.includes(x)).join("/") || "none of them"}, stores outside preview ${OLD.filter((x) => JSON.stringify(out).includes(x)).join("/") || "none of them"}`); }
    console.log(`   the staged risk-manager.js run as a process, and where ${OLD.join(" / ")} still appear: ${seen.join(" · ")} — the level stays ONLY in the snapshot's labelled preview block (R270 discloses it; backend/ensemble/emit/plan-e-core.js reads it as its reproduction target)`); }
  for (const [f, pick] of [["plans-a-e.json", (j) => `plans.E.cagrPct ${j.plans.E.cagrPct} (ran ${j.ranAt.slice(0, 10)}, exploratory ${j.exploratory})`], ["plan-e-leverage.json", (j) => `rows[k=1].cagr ${j.rows[0].cagr} (ran ${j.ranAt.slice(0, 10)}, exploratory ${j.exploratory})`]]) { try { console.log(`   stored, no generator in the repo: backend/data/${f} ${pick(JSON.parse(fs.readFileSync(B("data/" + f), "utf8")))} — NOT changed by this package (NOTES)`); } catch {} }

  // two more stored tables on the old basis, each written by a hand-run script (read here by name; neither is changed by this package)
  try { const j = JSON.parse(fs.readFileSync(B("data/book-frontier.json"), "utf8")), v = []; (function walk(o, k) { if (o && typeof o === "object") for (const [kk, x] of Object.entries(o)) walk(x, kk); else if (typeof o === "number" && /cagr/i.test(k || "")) v.push(o); })(j, ""); const hit = v.filter((x) => x >= 27.3 && x < 27.7);
    console.log(`   stored by a hand-run script (backend/book-frontier.js): backend/data/book-frontier.json holds ${hit.length} rate(s) between 27.3 and 27.7 (${hit.length ? Math.min(...hit) + " .. " + Math.max(...hit) : "none"}) among its ${v.length} (ran ${String(j.ranAt).slice(0, 10)}, exploratory ${j.exploratory}) — NOT changed by this package (NOTES)`); } catch (e) { console.log(`   backend/data/book-frontier.json: UNKNOWN (${String(e.message).slice(0, 80)})`); }
  try { const j = JSON.parse(fs.readFileSync(B("data/strategy-library/PLAN-E-CORE.json"), "utf8")), n = JSON.stringify(j.notes || "");
    console.log(`   stored by backend/ensemble/emit/plan-e-core.js: backend/data/strategy-library/PLAN-E-CORE.json, named "${String(j.name).slice(0, 43)} ...", reproduction.sealed "${j.reproduction.sealed}" (rate / vol / Sharpe / drawdown of the unfinanced proxy book); its notes name the proxy and the missing financing: ${/proxy/i.test(n) && /financ/i.test(n)} — NOT changed by this package (NOTES)`); } catch (e) { console.log(`   backend/data/strategy-library/PLAN-E-CORE.json: UNKNOWN (${String(e.message).slice(0, 80)})`); }

  // ── 4. the proposed diff, line by line against today's file
  console.log("\n4. backend/data/profit-program/planE-buildbook-fix.diff against today's risk-manager.js");
  try { const d = fs.readFileSync(B("data/profit-program/planE-buildbook-fix.diff"), "utf8").split(/\r?\n/).filter((l) => !/^(---|\+\+\+|@@)/.test(l) && l.length), bl = new Set(before.split("\n")), al = new Set(after.split("\n"));
    const ctx = d.filter((l) => l[0] === " ").map((l) => l.slice(1)), del = d.filter((l) => l[0] === "-").map((l) => l.slice(1)), add = d.filter((l) => l[0] === "+").map((l) => l.slice(1));
    console.log(`   ${ctx.filter((l) => bl.has(l)).length} of ${ctx.length} context lines and ${del.filter((l) => bl.has(l)).length} of ${del.length} removed lines are in today's file verbatim; ${del.filter((l) => !al.has(l)).length} of the ${del.length} removed lines are gone from the staged file; ${add.filter((l) => al.has(l)).length} of its ${add.length} added lines are staged verbatim (the rest are restated — NOTES says how and why)`); }
  catch (e) { console.log(`   UNKNOWN (${e.message})`); }

  // ── 5. the registry (through the house redaction; ids that are not ours print as such)
  console.log("\n5. REGISTRY — entries that name these files or freeze Plan E's legs");
  try { const b = require(path.join(L.REPO, "docs", "server", "research-stage01", "make-avoid-list.cjs")).build(); if (b.problems.length) throw new Error("redaction screens failed");
    const all2 = [...b.red.preregistered, ...b.red.tests].filter(Boolean), names = /risk-manager\.js|planE-paper-scoreboard\.js|all-activity-per-day\.js|planE-model\.js/, outs = /risk-manager\.json|risk-manager-forward\.jsonl|planE-paper-scoreboard(-history)?\.jsonl?/;
    const readable = all2.filter((t) => !t.ipRedacted), idOnly = all2.filter((t) => t.ipRedacted);
    console.log(`   through the house redaction: ${all2.length} entries — ${readable.length} READ here, ${idOnly.length} come back as an id only (their text was not read through it)`);
    console.log(`   of the ${readable.length} read, the entries whose text names a file of the unit: ${readable.filter((t) => names.test(JSON.stringify(t))).map((t) => t.id).join(", ") || "none"}`);
    // The id-only entries cannot be read through the redaction, so the home registry is scanned for IDS AND FLAGS ONLY — does an entry name a file of the unit or one of its
    // output files, does it hold a sha of one — and no entry text is printed. A sha "of one" = the sha256 (or its first 12+ characters) of a unit file as it is today, as
    // staged, or as any commit holds it; or any 12-64 character hex string within 60 characters of a unit file's name.
    const home = [...(b.reg.preregistered || []), ...(b.reg.tests || [])].filter(Boolean), red = new Map(all2.map((t) => [String(t.id), !!t.ipRedacted])), cp = require("child_process"), known = new Set(); let commits = 0, git = true;
    for (const rel of L.filesOf(E)) { known.add(T[rel].liveSha); known.add(L.sha256(Buffer.from(T[rel].base, "utf8"))); known.add(L.sha256(Buffer.from(T[rel].staged, "utf8")));
      try { for (const c of cp.execFileSync("git", ["log", "--format=%H", "--", rel], { cwd: L.REPO, encoding: "utf8", windowsHide: true }).trim().split("\n").filter(Boolean)) { const buf = cp.execFileSync("git", ["show", `${c}:${rel}`], { cwd: L.REPO, windowsHide: true, maxBuffer: 64 << 20 }); known.add(L.sha256(buf)); known.add(L.sha256(Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8"))); commits++; } } catch { git = false; } }
    const holdsSha = (s) => (s.match(/\b[0-9a-f]{12,64}\b/g) || []).some((h) => [...known].some((k) => k.startsWith(h))) || new RegExp(`(?:${names.source})[^0-9a-f]{0,60}\\b[0-9a-f]{12,64}\\b|\\b[0-9a-f]{12,64}\\b[^0-9a-f]{0,60}(?:${names.source})`).test(s);
    const hits = home.map((t) => ({ t, s: JSON.stringify(t) })).filter(({ s }) => names.test(s) || outs.test(s));
    console.log(`   ids-and-flags scan of the home registry (${home.length} entries, every one scanned, no text printed; ${git ? `${commits} committed version(s) of the unit files hashed` : "git history not read"}):`);
    for (const { t, s } of hits) { const id = String(t.id), sealed = /^SEALED \d{4}-\d{2}-\d{2}/.exec(String(t.status || ""));
      console.log(`     ${id}: ${red.get(id) === false ? "readable (ours)" : red.get(id) ? "ID ONLY through the redaction" : "not in the redacted set"} · names ${[...new Set(s.match(new RegExp(names.source, "g")) || [])].join(", ") || "no unit file"} · names an output file: ${outs.test(s)} · holds a sha of a unit file: ${holdsSha(s)} · status starts: ${sealed ? sealed[0] : String(t.status || "").split(/\s/)[0] || "?"}`); }
    console.log(`     entries naming a unit file or an output: ${hits.length} (${hits.map(({ t }) => t.id).join(", ") || "none"}) · entries holding a sha of a unit file, among all ${home.length}: ${home.filter((t) => holdsSha(JSON.stringify(t))).map((t) => t.id).join(", ") || "none"}`);
    try { const ss = fs.readFileSync(B("data/read-seals.json"), "utf8"); console.log(`     read-seals.json (counts only): names a unit file ${(ss.match(new RegExp(names.source, "g")) || []).length} time(s) · holds a sha of one: ${holdsSha(ss)}`); } catch (e) { console.log(`     read-seals.json: UNKNOWN (${String(e.message).slice(0, 80)})`); }
    // what else carries buildBook: ported COPIES of its window line in other files (read from the code, not from any registry entry). This package edits none of them.
    for (const f of ["r330-net-liquidity.js", "ensemble/emit/plan-e-core.js"]) { try { const src = fs.readFileSync(B(f), "utf8").split(/\r?\n/), at = src.map((l, i) => (l.includes("allDays.forEach((d) => (byMonth[d.slice(0, 7)] = byMonth[d.slice(0, 7)] || []).push(d))") ? i + 1 : 0)).filter(Boolean), req = src.some((l) => /require\([^)]*risk-manager/.test(l)), unit = L.filesOf(E).includes(`backend/${f}`);
        console.log(`     backend/${f}: its own copy of buildBook's old window line ("the latest 5 sessions so far") at line ${at.join(", ") || "none"} · requires risk-manager.js: ${req} · a file of this unit: ${unit} — a ported copy on its own frozen data; NOT changed here, it still carries the window defect`); }
      catch (e) { console.log(`     backend/${f}: UNKNOWN (${String(e.message).slice(0, 80)})`); } }
    for (const id of ["R270", "R235", "R186", "R219", "R191", "R353"]) { const t = all2.find((x) => String(x.id) === id); if (!t) { console.log(`   ${id}: not found`); continue; } if (t.ipRedacted) { console.log(`   ${id}: not ours (id only)`); continue; } const s = JSON.stringify(t);
      console.log(`   ${id}: script ${String(t.script || "").slice(0, 70)} · evidence from ${String(t.evidenceStart || "").slice(0, 60)} · read: ${String(t.readCondition || "").slice(0, 70)} · names a unit file: ${names.test(s)} · carries a sha of one: ${/risk-manager\.js["':\s]+[0-9a-f]{12,}/.test(s)}`); } }
  catch (e) { console.log(`   UNKNOWN (${String(e.message).slice(0, 160)})`); }

  // ── 6. who else holds these files
  console.log("\n6. OTHER PACKAGES");
  try { const w5 = JSON.parse(fs.readFileSync(path.join(L.REPO, "docs", "server", "wave5-board", "deploy-state.json"), "utf8")), real = ((w5.steps || {}).copy || {}).real || {};
    for (const rel of L.filesOf(E)) console.log(`   ${rel.padEnd(42)} live ${T[rel].liveSha.slice(0, 12)} · board package's server copy: ${real[rel] ? real[rel].slice(0, 12) + (real[rel] === T[rel].liveSha ? " (the same file today)" : " (DIFFERENT)") : "not in its code set"}`);
    console.log(`   the board package's copy step last ran ${((w5.steps || {}).copy || {}).at || "?"}`); }
  catch (e) { console.log(`   docs/server/wave5-board/deploy-state.json: UNKNOWN (${e.message})`); }
  try { const c = JSON.parse(fs.readFileSync(B("data/profit-program/planE-inputs.json"), "utf8")), lastBar = c.bars.SPY[c.bars.SPY.length - 1].t.slice(0, 10), lastOf = (m) => Object.keys(m).sort().pop(), lb = lastOf(c.crypto.BTC), le = lastOf(c.crypto.ETH);
    console.log(`   the model library's cache (backend/data/profit-program/planE-inputs.json, fetched ${c.fetchedAt}): last SPY bar ${lastBar}, last BTC candle ${lb}, last ETH candle ${le} — ${lb >= lastBar && le >= lastBar ? "the candles reach the last bar: the library's rebuilds are not touched by the check on the last bar's candle" : "the candles STOP BEFORE the last bar: after the apply a rebuild to the last bar stops with 'no candle for the last bar's day' (pass asOf no later than " + (lb < le ? lb : le) + ")"}`); }
  catch (e) { console.log(`   the model library's cache: UNKNOWN (${String(e.message).slice(0, 120)})`); }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (process.argv.includes("--no-scan")) return;

  // ── 7. where the old figure is written (the allowed scope only)
  console.log("\n7. THE OLD FIGURE IN TEXT — backend/*.js, backend/lib, automation, src, docs/profit-program, docs/*.md (27.36, 27.4%, 27.3%, 27.5% beside Plan E / unmanaged / headline)");
  const files = [], top = (dir, ok) => { for (const f of fs.readdirSync(path.join(L.REPO, dir), { withFileTypes: true })) if (f.isFile() && ok(f.name)) files.push(`${dir}/${f.name}`); }, rec = (dir, ok) => { for (const f of fs.readdirSync(path.join(L.REPO, dir), { withFileTypes: true })) { if (f.isDirectory()) { if (!/^(node_modules|data)$/.test(f.name)) rec(`${dir}/${f.name}`, ok); } else if (ok(f.name)) files.push(`${dir}/${f.name}`); } };
  const code = (n) => /\.(js|cjs|jsx|bat|ps1|md|html)$/.test(n) && !/\.bak/.test(n);
  top("backend", code); rec("backend/lib", code); top("automation", code); top("src", code); rec("docs/profit-program", code); top("docs", (n) => /\.md$/.test(n));
  const re = /27\.36|(unmanaged|headline|Plan E|plan e|planE)[^\n]{0,80}27\.[345]\d?\s?%|27\.[345]\d?\s?%[^\n]{0,80}(unmanaged|headline|Plan E)/; let n = 0;
  for (const f of files) { let s; try { s = fs.readFileSync(path.join(L.REPO, f), "utf8"); } catch { continue; } s.split(/\r?\n/).forEach((l, i) => { const m = re.exec(l); if (m) { n++; console.log(`   ${f}:${i + 1}: ...${l.slice(Math.max(0, m.index - 70), m.index + 110).trim()}...`); } }); }
  console.log(`   ${n} line(s) in ${files.length} files`);
  // read BY NAME, outside the folders the scan may search (no folder is searched for these; line numbers only): carriers the reviews named
  console.log("   read by name, outside those folders — lines that carry 27.3 / 27.36 / 27.4:");
  for (const f of ["backend/ensemble/emit/plan-e-core.js", "docs/handover/memory/traids-known-rules-no-test.md", "docs/handover/memory/traids-profit-goal.md", "docs/handover/memory/traids-capital-model-plan-e.md"]) {
    try { const hits = fs.readFileSync(path.join(L.REPO, f), "utf8").split(/\r?\n/).map((l, i) => (/27\.(36|3|4)(?!\d)/.test(l) ? i + 1 : 0)).filter(Boolean); console.log(`     ${f}: ${hits.length ? "line " + hits.join(", ") : "none"}`); }
    catch (e) { console.log(`     ${f}: UNKNOWN (${String(e.message).slice(0, 80)})`); } }
})().catch((e) => { console.error(`evidence FAILED: ${e.stack}`); process.exit(1); });
