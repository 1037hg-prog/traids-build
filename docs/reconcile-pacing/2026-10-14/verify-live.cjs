#!/usr/bin/env node
"use strict";
/**
 * RECONCILE PACING (2026-10-14) — VERIFY LIVE, after deploy.cjs --apply. READ-ONLY for the repo's data: it makes ONE --dry-print run of the
 * LIVE backend/alpaca-reconcile.js against the real main paper account, GETs only, and judges it. The main session's command, run once.
 *
 *   node docs/reconcile-pacing/2026-10-14/verify-live.cjs
 *
 * REFUSED (exit 2, nothing asked): the live file is not the staged one; or any of deploy.cjs's fences (a trading weekday 05:30-16:00 MT,
 * tonight's close chain due or running, a reconcile already running, a process list that cannot be read).
 * THE RUN: node --require harness/get-only.cjs backend/alpaca-reconcile.js --dry-print <temp file> (cwd: the repo). The guard refuses any
 * request that is not a GET to https://paper-api.alpaca.markets before it leaves the process, and records each GET's time and path (no
 * header, no key). The script loads its own keys from backend/.env, as every night; this file never reads .env and prints no value of it.
 * The output goes to the temp file only: backend/data/alpaca-reconcile.json (last night's) must be byte for byte the same afterwards.
 *
 * ONE LINE EACH, PASS / FAIL / UNKNOWN:
 *   code       backend/alpaca-reconcile.js is the staged file (else no run)
 *   run        the run ended 0 (no UNKNOWN) or 3 (some UNKNOWN), and wrote its output to the temp file
 *   untouched  backend/data/alpaca-reconcile.json is byte for byte what it was before the run
 *   get-only   every request that left the process was a GET to the paper API's /v2/orders/ (none refused)
 *   calls      the guard's count of requests = the script's own out.calls.made (said with the count)
 *   peak       the most requests in any 60 s, measured by the guard: PASS at or under 120 (the limiter's maxInAnyMinute)
 *   unknown    out.unknown = 0: PASS; more: UNKNOWN, with the reasons by httpStatus
 *   rows       tonight's rows against last night's for the same tickets: equal; or last night's was not settled (moved on: the ticket
 *              was open or unpriced); or a settled row whose only change is the ledger's side (ourExit / ourPnl / ourReason / pnlGap) AND
 *              tonight's values are what trade_log.json says now (the board's record changed since: explained). FAIL: a settled row
 *              whose broker side changed, a ledger-side change the ledger does not explain, or a ticket of last night missing tonight.
 *              UNKNOWN rows tonight are counted in the unknown line and not compared.
 * Exit 0 every line PASS · 1 a line FAILS · 3 no FAIL but a line UNKNOWN · 2 refused or usage. It writes only temp files.
 */
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const D = require("./deploy.cjs");
const GUARD = path.join(D.PKG, "harness", "get-only.cjs"), LIMIT = 120, RUN_TIMEOUT_MS = 5 * 60000;
const BROKER_SIDE = ["sym", "side", "qty", "qtyOrdered", "ticketEntry", "brokerFill", "slippagePct", "brokerExit", "brokerExitReason", "brokerExitQty", "exitQtyMismatch", "brokerStatus", "issue", "brokerPnl", "httpStatus"];
const LEDGER_SIDE = ["ourExit", "ourPnl", "ourReason", "pnlGap"];
const SETTLED = (p) => !!p && p.brokerExit != null && p.ourExit != null && !p.exitQtyMismatch && !p.issue && !p.reconcileStatus;

// ── pure parts (the selftest gives them known answers) ─────────────────────────────────────────────────────────────────────────
/** the peak number of requests in any 60-second window (half-open) */
function peakOf(ts) { const s = [...ts].sort((a, b) => a - b); let best = 0; for (let i = 0, j = 0; i < s.length; i++) { while (s[i] - s[j] >= 60000) j++; best = Math.max(best, i - j + 1); } return best; }
/** last night's rows against tonight's -> the counts and the problem lists; ledgerNow(id) -> the ledger row now (or undefined) */
function compareRows(lastRows, nowRows, ledgerNow = () => undefined) {
  const L = new Map(lastRows.map((p) => [p.ticketId, p])), N = new Map(nowRows.map((p) => [p.ticketId, p]));
  const r = { same: 0, movedOn: 0, ledgerExplained: 0, unknownNow: 0, newSince: 0, brokerChanged: [], ledgerUnexplained: [], gone: [] };
  const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  for (const [id, a] of L) {
    const b = N.get(id); if (!b) { r.gone.push(id); continue; }
    if (b.reconcileStatus === "UNKNOWN") { r.unknownNow++; continue; }
    if (JSON.stringify(a) === JSON.stringify(b)) { r.same++; continue; }
    if (!SETTLED(a)) { r.movedOn++; continue; }
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])], diff = keys.filter((k) => !same(a[k], b[k]));
    const broker = diff.filter((k) => !LEDGER_SIDE.includes(k)); if (broker.length) { r.brokerChanged.push({ id, fields: broker }); continue; }
    const t = ledgerNow(id), want = { ourExit: t && Number.isFinite(t.exit) ? t.exit : null, ourPnl: t && Number.isFinite(t.pnl) ? t.pnl : null, ourReason: t ? t.reason : null };
    if (same(b.ourExit, want.ourExit) && same(b.ourPnl, want.ourPnl) && same(b.ourReason, want.ourReason)) r.ledgerExplained++; else r.ledgerUnexplained.push({ id, fields: diff });
  }
  for (const id of N.keys()) if (!L.has(id)) r.newSince++;
  return r;
}
/** the judged lines from what the run left -> [{ name, verdict, text }] */
function judge({ codeOk, code, run, beforeSha, afterSha, guard, out, cmp }) {
  const L = [], add = (name, verdict, text) => L.push({ name, verdict, text });
  add("code", codeOk ? "PASS" : "FAIL", codeOk ? "backend/alpaca-reconcile.js is the staged file" : `backend/alpaca-reconcile.js is ${code.state} (${String(code.home).slice(0, 12)}), not the staged ${code.stagedSha.slice(0, 12)} — no run was made`);
  if (!codeOk) return L;
  add("run", run && (run.status === 0 || run.status === 3) && out ? "PASS" : "FAIL", run ? `exit ${run.status}${run.error ? " (" + run.error + ")" : ""}; ${out ? "output written to the temp file" : "NO output"}${run.last ? " · " + run.last.slice(0, 220) : ""}` : "not run");
  add("untouched", beforeSha && beforeSha === afterSha ? "PASS" : "FAIL", beforeSha === afterSha ? "backend/data/alpaca-reconcile.json is byte for byte what it was" : `backend/data/alpaca-reconcile.json changed during the run (${String(beforeSha).slice(0, 12)} -> ${String(afterSha).slice(0, 12)})`);
  if (!guard) { add("get-only", "UNKNOWN", "the guard wrote no report"); add("calls", "UNKNOWN", "the guard wrote no report"); add("peak", "UNKNOWN", "the guard wrote no report"); }
  else {
    const odd = guard.calls.filter((c) => !/^\/v2\/orders\//.test(c.path));
    add("get-only", !guard.refused.length && !odd.length ? "PASS" : "FAIL", !guard.refused.length && !odd.length ? `${guard.calls.length} GET(s), every one to the paper API's /v2/orders/` : `${guard.refused.length} request(s) REFUSED by the guard, ${odd.length} GET(s) outside /v2/orders/`);
    const made = out && out.calls ? out.calls.made : null;
    add("calls", made === guard.calls.length ? "PASS" : made == null ? "UNKNOWN" : "FAIL", `${guard.calls.length} request(s) left the process; the script says ${made == null ? "nothing" : made}${out && out.calls ? ` (${out.calls.retried} retried, ${out.calls.rateLimited} rate-limited, ${out.calls.spentSec} s)` : ""}`);
    const pk = peakOf(guard.calls.map((c) => c.at));
    add("peak", pk <= LIMIT ? "PASS" : "FAIL", `${pk} request(s) in the busiest minute (limit ${LIMIT}; the account allows 200 across every runner)`);
  }
  if (!out) { add("unknown", "UNKNOWN", "no output"); add("rows", "UNKNOWN", "no output"); return L; }
  const by = {}; for (const p of out.perTicket || []) if (p.reconcileStatus === "UNKNOWN") by[p.httpStatus] = (by[p.httpStatus] || 0) + 1;
  add("unknown", out.unknown === 0 ? "PASS" : "UNKNOWN", out.unknown === 0 ? "no ticket UNKNOWN" : `${out.unknown} ticket(s) UNKNOWN (${Object.entries(by).map(([k, v]) => `${k} x${v}`).join(", ")}) — not confirmed tonight`);
  if (!cmp) add("rows", "UNKNOWN", "last night's output could not be read");
  else {
    const bad = cmp.brokerChanged.length + cmp.ledgerUnexplained.length + cmp.gone.length;
    add("rows", bad ? "FAIL" : "PASS", `${cmp.same} equal, ${cmp.movedOn} moved on (not settled last night), ${cmp.ledgerExplained} with the board's record changed since (explained by trade_log.json now), ${cmp.unknownNow} UNKNOWN tonight, ${cmp.newSince} new since${bad ? ` · PROBLEMS: broker side changed on ${JSON.stringify(cmp.brokerChanged.slice(0, 5))}; ledger side unexplained on ${JSON.stringify(cmp.ledgerUnexplained.slice(0, 5))}; missing tonight ${JSON.stringify(cmp.gone.slice(0, 5))}` : ""}`);
  }
  return L;
}
module.exports = { peakOf, compareRows, judge, SETTLED, BROKER_SIDE, LEDGER_SIDE, LIMIT };

if (require.main === module) {
  if (process.argv.length > 2) { console.log("usage: node docs/reconcile-pacing/2026-10-14/verify-live.cjs   (no arguments)\nNothing was done."); process.exit(2); }
  const Pl = D.plan(), code = Pl.files[0], codeOk = code.state === "applied" && !Pl.problems.length;
  console.log(`VERIFY LIVE — reconcile pacing — ${new Date().toISOString().slice(0, 16)}Z (${D.mtWords(Date.now())} MT)`);
  if (!codeOk) { for (const l of judge({ codeOk, code })) console.log(`${l.verdict.padEnd(8)} ${l.name.padEnd(10)} ${l.text}`); process.exit(1); }
  const fz = D.make().fences(); if (fz.length) { console.error(`REFUSED — nothing asked:\n  - ${fz.join("\n  - ")}`); process.exit(2); }
  const live = path.join(D.REPO, "backend", "data", "alpaca-reconcile.json"), shaOf = (f) => { try { return D.sha(fs.readFileSync(f)); } catch { return null; } };
  let lastRows = null; try { lastRows = JSON.parse(fs.readFileSync(live, "utf8")).perTicket || null; } catch { lastRows = null; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rp-verify-")), outFile = path.join(tmp, "alpaca-reconcile.dry.json"), guardOut = path.join(tmp, "get-only.json"), before = shaOf(live);
  console.log("  one --dry-print run of the live script, GETs only (about 90 s at the limiter's pace) …");
  const r = cp.spawnSync(process.execPath, ["--require", GUARD, path.join("backend", "alpaca-reconcile.js"), "--dry-print", outFile], { cwd: D.REPO, env: { ...process.env, GET_ONLY_OUT: guardOut }, encoding: "utf8", timeout: RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 << 20 });
  const after = shaOf(live), last = String(r.stdout || "").trim().split(/\r?\n/).pop() || String(r.stderr || "").trim().split(/\r?\n/).pop() || "";
  let out = null, guard = null; try { out = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch { out = null; } try { guard = JSON.parse(fs.readFileSync(guardOut, "utf8")); } catch { guard = null; }
  let cmp = null;
  if (out && lastRows) { let byId = new Map(); try { const t0 = JSON.parse(fs.readFileSync(path.join(D.REPO, "backend", "data", "trade_log.json"), "utf8")); byId = new Map((Array.isArray(t0) ? t0 : t0.trades).map((t) => [t.id, t])); } catch { byId = null; } cmp = byId ? compareRows(lastRows, out.perTicket || [], (id) => byId.get(id)) : null; }
  const L = judge({ codeOk, code, run: { status: r.status, error: r.error ? String(r.error.message || r.error) : null, last }, beforeSha: before, afterSha: after, guard, out, cmp });
  for (const l of L) console.log(`${l.verdict.padEnd(8)} ${l.name.padEnd(10)} ${l.text}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  const fail = L.some((l) => l.verdict === "FAIL"), unk = L.some((l) => l.verdict === "UNKNOWN");
  console.log(fail ? "VERIFY: FAIL — see the FAIL line(s); roll back with node docs/reconcile-pacing/2026-10-14/rollback.cjs --apply if the code is at fault" : unk ? "VERIFY: UNKNOWN — no FAIL, but a line could not be confirmed; run it again on a quieter evening" : "VERIFY: ALL PASS — record it: node docs/reconcile-pacing/2026-10-14/record.cjs --dry, then without --dry");
  process.exit(fail ? 1 : unk ? 3 : 0);
}
