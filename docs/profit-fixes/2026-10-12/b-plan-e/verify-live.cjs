#!/usr/bin/env node
"use strict";
/**
 * PROFIT FIXES B (Plan E) — VERIFY THE LIVE FILES, after the apply. READ-ONLY: it writes nothing, sends nothing, restarts nothing.
 *   node docs/profit-fixes/2026-10-12/b-plan-e/verify-live.cjs
 * It checks the files as they are on disk now:
 *   1  every staged edit reads "applied" and the four files parse
 *   2  the live risk-manager.js, run offline on the frozen inputs, gives the evidence file's true-window book on all ten forward nights,
 *      fetches a complete candle series, and throws on a failed fetch or an unreadable calendar
 *   3  the live planE-model.js rebuilds the evidence file's as-coded and window-fixed books from the live risk-manager.js
 *   4  the model's own output file still says what the frozen inputs give (the stated yearly rate)
 *   5  the live scoreboard's own selftest (offline) passes with no check fewer than at staging
 *   6  the live all-activity-per-day.js prints the Plan E row that the model's output file dictates
 *   7  what the nightly run has stored since the apply (lib.cjs nightlyState): risk-manager.json — a run that ended UNKNOWN since the apply is said as that,
 *      with its reason (never as "has not run yet"); UNKNOWN until a run has happened — and the forward file: every session since the apply must have its
 *      row, and a session without one is named (UNKNOWN); the day an OK snapshot is for must have its row too (a --preview run writes none: UNKNOWN,
 *      never taken for a row that was written)
 *   8  the board package's server copy of risk-manager.js against the live file (owed work, not a failure)
 * Each line ends PASS, FAIL or UNKNOWN. Exit 0 = all PASS · 1 = a FAIL · 3 = no FAIL but an UNKNOWN (never read as a pass).
 * It starts two of the repo's own read-only commands: the scoreboard's --selftest and all-activity-per-day.js.
 * PFB_VERIFY_ROOT=<a temp copy of the tree> points checks 1-4 at that copy instead (the selftest does this); checks 5, 6 and 8 need the real tree and are
 * then skipped, said so on a line each; check 7 runs on the copy when it holds a risk-manager.json, against the copy's own deploy-state.json and the clock
 * named by PFB_VERIFY_NOW. Nothing is written in either case. deploy.cjs starts this script without any PFB_* variable (lib.cjs gateRun).
 */
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const L = require("./lib.cjs");
let nFail = 0, nUnk = 0, nPass = 0;
const say = (verdict, what, detail) => { if (verdict === "PASS") nPass++; else if (verdict === "FAIL") nFail++; else nUnk++; console.log(`${verdict.padEnd(7)} ${what}${detail ? ` — ${detail}` : ""}`); };
const check = (cond, what, detail) => say(cond ? "PASS" : "FAIL", what, cond ? "" : detail);
const ROOT = process.env.PFB_VERIFY_ROOT ? path.resolve(process.env.PFB_VERIFY_ROOT) : L.REPO, TEMP = ROOT !== L.REPO;
const B = (f) => path.join(ROOT, "backend", f), money = (x) => (x < 0 ? "-$" : "+$") + Math.abs(Math.round(x)).toLocaleString("en-US");
const SCOREBOARD_CHECKS_AT_STAGING = 240;

(async () => {
  const E = L.loadEdits(), fix = L.loadFixture(), K = fix.known, P = L.plan(E, ROOT), RM = "backend/risk-manager.js";
  console.log(`VERIFY ${TEMP ? "A TEMP COPY (" + ROOT + ")" : "LIVE"} — profit fixes B (Plan E) — ${L.mtNow().dow} ${L.mtNow().date} ${L.mtNow().hms} MT`);
  // 1
  const applied = P.every((f) => f.state === "applied");
  check(applied, "every staged edit is applied on the live files", P.filter((f) => f.state !== "applied").map((f) => `${f.rel}: ${f.problem || f.state}${f.states ? " (" + f.states.filter((x) => x.state !== "applied").map((x) => `${x.id} ${x.state}`).join(", ") + ")" : ""}`).join("; "));
  for (const f of P) { const c = cp.spawnSync(process.execPath, ["--check", path.join(ROOT, f.rel)], { encoding: "utf8", windowsHide: true }); check(c.status === 0, `${f.rel} parses (node --check)`, String(c.stderr || "").trim().split("\n")[0]); }
  if (!applied) { console.log(`\n${nFail} FAIL — the unit is not applied; the remaining checks describe the fixed files and were not run.`); process.exit(1); }
  // 2
  const live = fs.readFileSync(B("risk-manager.js"), "utf8"), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pfb-verify-")), dtb = path.join(tmp, "DTB3.csv"); fs.writeFileSync(dtb, L.dtb3Csv(fix));
  try {
    let maxE = 0, tsyOct = 0; for (const k of K.forward) { const r = await L.nightRows(live, fix, k.d, { dtb3File: dtb }), last = r.rows[r.rows.length - 1]; maxE = Math.max(maxE, Math.abs(last.book - k.fixed)); if (k.d.startsWith("2026-10") && last.legs.TSY !== 0) tsyOct++; }
    check(maxE < 1e-9 && tsyOct === 0, "live risk-manager.js, offline on the frozen inputs: the true-window book on all 10 forward nights, no Treasury proxy on an October night before the window", `max error ${maxE}, October nights with the proxy ${tsyOct}`);
    const now = Date.parse(K.inputsFetchedAt), mk = (fault) => { const cb = L.coinbaseServer(L.cryptoUpTo(fix, L.iso(now)), fault); return L.rmApi(live, { fetch: L.makeFetch({ coinbase: cb }), fetchBars: async () => ({}), nowMs: now, dtb3File: dtb }).coinbase("BTC", "2018-06-01"); };
    const m = await mk({}), miss = Object.keys(fix.crypto.BTC).filter((d) => !m.has(d));
    check(miss.length === 0, `live coinbase(): all ${Object.keys(fix.crypto.BTC).length} recorded days, no hole`, `missing ${miss.slice(0, 5).join(", ")}`);
    const t1 = await mk({ at: 1, kind: "rate-limit" }).then(() => null, (e) => e.message), t2 = await mk({ drop: ["2026-08-14"] }).then(() => null, (e) => e.message), t3 = await L.nightRows(live, fix, "2026-10-08", { dtb3File: dtb, calendarFault: { status: 401 } }).then(() => null, (e) => e.message);
    const t4 = await L.nightRows(live, fix, "2026-10-08", { dtb3File: dtb, coinbaseFault: { staleAfter: "2026-10-07" } }).then(() => null, (e) => e.message);   // a feed that stopped inside the last day
    check(/HTTP 429/.test(t1 || "") && /missing/.test(t2 || "") && /calendar .*HTTP 401/.test(t3 || "") && /no candle for 2026-10-08, the last bar's day/.test(t4 || ""), "live risk-manager.js throws on a rate-limited fetch, on a list with a day missing, on a feed without the candle of the last bar's day, and on an unreadable calendar", JSON.stringify([t1, t2, t3, t4]));
    // 3
    try { const M = require(B("profit-program/planE-model.js")), inp = { bars: L.barsOf(fix, "9999-12-31"), crypto: fix.crypto, calendar: fix.calendar }, k8 = K.forward.find((x) => x.d === "2026-10-08");
      const a = (await M.rmRows(inp, { asOf: "2026-10-08", verbatim: true })).rows, f = (await M.rmRows(inp, { asOf: "2026-10-08", verbatim: true, fixWindow: true })).rows;
      check(Math.abs(a[a.length - 1].book - k8.asCoded) < 1e-5 && Math.abs(f[f.length - 1].book - k8.fixed) < 1e-5,   // 1e-5: the live T-bill file may have gained rows since staging (the two books differ by 1.2e-2)
         "live planE-model.js on the live risk-manager.js: 'as coded' and 'window fixed' still give the evidence file's two 10-08 books", `${a[a.length - 1].book} / ${f[f.length - 1].book} against ${k8.asCoded} / ${k8.fixed}`); }
    catch (e) { say("FAIL", "live planE-model.js on the live risk-manager.js", String(e.message).slice(0, 200)); }
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  // 4
  let base = null; try { base = JSON.parse(fs.readFileSync(B("data/profit-program/planE-baseline.json"), "utf8")); } catch (e) { say("UNKNOWN", "the model's output file backend/data/profit-program/planE-baseline.json", `cannot be read (${String(e.message).slice(0, 100)}) — the live files print UNKNOWN for the stated return until node backend/profit-program/planE-baseline.js has written it`); }
  const own = L.statedRate(fix).annualReturnPct, stated = base && base.py && base.py.E ? base.py.E.annualReturnPct : null;
  if (base) { if (typeof stated === "number" && stated.toFixed(2) === own.toFixed(2)) say("PASS", `the model's output file states ${stated}% a year = ${money(L.usdYear(stated))} a year, ${money(L.usdDay(stated))} a trading day on $100,000 — what the frozen inputs give (${own.toFixed(4)}%)`); else say("UNKNOWN", "the model's output file", `it states ${stated}; the inputs frozen at staging give ${own.toFixed(2)} — the model was re-run on other inputs or the file is damaged: read why before quoting either`); }
  // 7 as a function (lib.cjs nightlyState reads the two files risk-manager.js writes): a run that ended UNKNOWN since the apply is said first, and every session since
  // the apply must have its forward row. On a temp copy it runs when the copy holds the snapshot, against the copy's own deploy-state.json and the clock the harness names.
  const night7 = () => { const st = TEMP ? L.readState(path.join(ROOT, "deploy-state.json")) : L.readState(), appliedIso = st.applied && st.applied.at ? st.applied.at : null, nowMs = TEMP && process.env.PFB_VERIFY_NOW ? Date.parse(process.env.PFB_VERIFY_NOW) : Date.now();
    for (const l of L.nightlyState({ snapshotFile: B("data/risk-manager.json"), forwardFile: B("data/risk-manager-forward.jsonl"), appliedIso, stated, nowMs })) { if (l.verdict === "INFO") console.log(`INFO    ${l.what}`); else say(l.verdict, l.what, l.detail); } };
  if (TEMP) { const has7 = fs.existsSync(B("data/risk-manager.json")); for (const w of ["5 the scoreboard's own selftest", "6 all-activity-per-day.js", ...(has7 ? [] : ["7 what the nightly run stored"]), "8 the board package's server copy"]) console.log(`SKIP    ${w} — needs the real tree`); if (has7) night7(); console.log(`
${nPass} PASS · ${nFail} FAIL · ${nUnk} UNKNOWN (checks 1-4${has7 ? " and 7" : ""} on a temp copy)`); process.exit(nFail ? 1 : nUnk ? 3 : 0); }
  // 5
  { const r = cp.spawnSync(process.execPath, [B("planE-paper-scoreboard.js"), "--selftest"], { encoding: "utf8", cwd: L.REPO, timeout: 300000, windowsHide: true, maxBuffer: 64 << 20 }), m = /selftest: (\d+) passed, (\d+) failed/.exec(String(r.stdout || ""));
    check(r.status === 0 && m && +m[2] === 0 && +m[1] >= SCOREBOARD_CHECKS_AT_STAGING, `the live scoreboard's own selftest: ${m ? m[1] + " passed, " + m[2] + " failed" : "no result line"} (at staging: ${SCOREBOARD_CHECKS_AT_STAGING})`, String(r.stdout || "").split("\n").filter((l) => /FAIL/.test(l)).slice(0, 4).join(" | ") + String(r.stderr || "").slice(0, 160)); }
  // 6
  { const r = cp.spawnSync(process.execPath, [B("all-activity-per-day.js")], { encoding: "utf8", cwd: L.REPO, timeout: 300000, windowsHide: true, maxBuffer: 64 << 20 }), row = (String(r.stdout || "").split("\n").find((l) => /the last seven years repeat/.test(l)) || "").replace(/\s+/g, " ").trim();
    if (r.status !== 0 || !row) say("UNKNOWN", "all-activity-per-day.js", `exit ${r.status}, no Plan E row (${String(r.stderr || "").trim().split("\n")[0].slice(0, 140)}) — it reads the board's ledgers; run it by hand`);
    else if (typeof stated !== "number") say(/UNKNOWN a year/.test(row) ? "PASS" : "FAIL", `all-activity-per-day.js prints UNKNOWN for Plan E while the model's output file is unreadable: "${row.slice(0, 90)}"`);
    else check(row.startsWith(`the last seven years repeat (${stated.toFixed(2)}% a year) ${money(L.usdDay(stated))} ${money(L.usdYear(stated))} a year`), `all-activity-per-day.js prints the row the model's output file dictates: "${row.slice(0, 110)}"`, `wanted (${stated.toFixed(2)}% a year) ${money(L.usdDay(stated))} ${money(L.usdYear(stated))} a year`); }
  // 7
  night7();
  // 8
  try { const w5 = JSON.parse(fs.readFileSync(path.join(L.REPO, "docs", "server", "wave5-board", "deploy-state.json"), "utf8")), rec = (((w5.steps || {}).copy || {}).real || {})[RM], now = L.sha256(fs.readFileSync(B("risk-manager.js")));
    console.log(`INFO    board package (docs/server/wave5-board): its recorded server copy of ${RM} is ${rec ? rec.slice(0, 12) : "not on record"}; the live file is ${now.slice(0, 12)} — ${rec === now ? "the same" : "DIFFERENT: its copy step is owed (NOTES), until then the server's shadow run of the risk manager is the old file"}`); }
  catch { console.log("INFO    board package: docs/server/wave5-board/deploy-state.json not read"); }
  console.log(`\n${nPass} PASS · ${nFail} FAIL · ${nUnk} UNKNOWN${nFail ? " — FAILED" : nUnk ? " — not a pass: an UNKNOWN line is owed an answer" : " — all checks passed"}`);
  process.exit(nFail ? 1 : nUnk ? 3 : 0);
})().catch((e) => { console.log(`FAIL    verify-live could not run: ${e.stack}`); process.exit(1); });
