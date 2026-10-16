#!/usr/bin/env node
"use strict";
/**
 * RECONCILE PACING (2026-10-14) — SELFTEST. Known answers for everything this package builds. It writes nothing in the repo (scratch trees,
 * scratch repos and scratch data folders in the OS temp folder only), makes no network call (every reconcile run is under the fake broker,
 * harness/fake-broker.cjs, which refuses anything else), reads no key. Last line: "ALL <n> CHECKS PASSED", or the failures and exit 1.
 *
 *   node docs/reconcile-pacing/2026-10-14/selftest.cjs
 *
 *   A  the package: base / staged copies intact; staged parses; W5's judge still reads the file applied (and can still revert its own
 *      edit); the six source lines the R355 draft quotes are still there; one fetch call site; PACE inside the account's limit and the
 *      chain step's 4 minutes
 *   B  the limiter on a fake clock: a burst of 400 calls never exceeds burst + rate in any window; a hold (Retry-After) stops every
 *      call and empties the bucket; a wait past the deadline is refused at once; Retry-After parsing; the peak-per-minute count
 *   C  one broker read on a fake clock: 429 with and without Retry-After, 5xx and no answer on every try, 404, 401 (and the stop after
 *      it), an unreadable answer, the budget, X-RateLimit-Remaining
 *   D  the replay, as processes in scratch trees under the fake broker and its virtual clock: the RECORDED NIGHT (harness/recorded,
 *      2026-10-14: 155 answers) — the base copy writes the night's file byte for byte, the staged one the same rows byte for byte and
 *      the same file apart from its three new keys, asking exactly the same calls; with --split-eras too; failures injected (UNKNOWN,
 *      never "no record"; 404 still "no record"; a 429 that recovers is the night's row); a later success replaces UNKNOWN; Retry-After
 *      holds every call; 400 tickets against the budget (the oldest are UNKNOWN "not asked"); a 401; --dry-print; nothing mirrored
 *   E  mutation-proof: each of nine mutants of the staged file is caught by a check of D
 *   F  deploy and rollback on scratch repos: base -> staged -> base byte-exact, drift refused, every fence, a red gate
 *   G  record.cjs: --dry on the real data writes nothing; on scratch data: the write, already recorded, the window, another's lock,
 *      not applied, a partial record
 *   H  verify-live.cjs's pure parts (the row comparison, the judged lines) and its GET-only guard
 */
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");
const D = require("./deploy.cjs"), RB = require("./rollback.cjs"), REC = require("./record.cjs"), VL = require("./verify-live.cjs");
const T = require("./harness/tree.cjs"), B = require("./harness/build-recorded.cjs");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const STAGED = fs.readFileSync(path.join(PKG, "staged", "backend", "alpaca-reconcile.js"), "utf8"), BASE = fs.readFileSync(path.join(PKG, "base", "backend", "alpaca-reconcile.js"), "utf8");
let pass = 0, failN = 0; const failed = [];
function ok(name, cond, detail) { if (cond) { pass++; console.log(`  ok   ${name}`); } else { failN++; failed.push(name); console.log(`  FAIL ${name}${detail === undefined ? "" : " — " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 600)}`); } }
const section = (s) => console.log(`\n${s}`);
/** an exact text replacement that must match once (a mutant, or a scratch edit) */
function mutate(text, from, to) { const n = text.split(from).length - 1; if (n !== 1) throw new Error(`mutation anchor found ${n} times, not once: ${from.slice(0, 80)}`); return text.replace(from, () => to); }
const withoutNew = (o) => { const c = { ...o }; delete c.failedCalls; delete c.unknown; delete c.calls; return c; };
const NEWKEYS_ORDER = (o) => { const k = Object.keys(o), i = k.indexOf("reading"); return k.slice(i + 1, i + 4).join(","); };

(async () => {
  // ── A. the package ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("A. the package");
  const F0 = D.FILES[0];
  ok("A1 base/backend/alpaca-reconcile.js is the bytes the package was built against (deploy.cjs FILES baseSha)", sha(Buffer.from(BASE)) === F0.baseSha, sha(Buffer.from(BASE)));
  ok("A2 staged/backend/alpaca-reconcile.js is the reviewed bytes (deploy.cjs FILES stagedSha)", sha(Buffer.from(STAGED)) === F0.stagedSha, sha(Buffer.from(STAGED)));
  { const c = cp.spawnSync(process.execPath, ["--check", path.join(PKG, "staged", "backend", "alpaca-reconcile.js")], { encoding: "utf8", windowsHide: true }); ok("A3 node --check on the staged file", c.status === 0, c.stderr); }
  { let HP = null, why = null; try { HP = require(path.join(REPO, "docs", "server", "wave5-board", "home-patch.cjs")); } catch (e) { why = e.message; }
    const e = HP && HP.EDITS.find((x) => x.rel === "backend/alpaca-reconcile.js");
    const sb = e ? HP.textState(e, BASE).state : null, ss = e ? HP.textState(e, STAGED).state : null; let rv = null; try { rv = e ? HP.textState(e, HP.revertText(e, STAGED)).state : null; } catch (x) { rv = "revert threw: " + x.message; }
    ok("A4 W5's home-patch judge reads the base copy AND the staged copy as 'applied' (its fix-4 blocks are byte for byte where it put them)", sb === "applied" && ss === "applied", { why, sb, ss });
    ok("A5 W5's own revert still works on the staged file (it reads 'base' after W5 takes its edit out)", rv === "base", rv); }
  { const NEEDLES = ["const brokerPnl = exits.reduce((a, e) => a + (e.px - fill) * (r.side === \"buy\" ? 1 : -1) * e.q, 0);", "exitQtyMismatch: true", "const lateRows = all.filter((r) => r.late), rows = all.filter((r) => !r.late);", "ledger = Array.isArray(log0) ? log0 : log0.trades;", "writeJsonAtomic(D(\"alpaca-reconcile.json\"), out);", "const fill = Number(o.filled_avg_price) || null, fq = Number(o.filled_qty) || 0;"];
    const reg = fs.readFileSync(path.join(REPO, "docs", "wide-spread-twin", "2026-10-14", "register-wide-spread.js"), "utf8");   // read as text, never required
    const quoted = NEEDLES.filter((n) => reg.includes(JSON.stringify(n).slice(1, -1))), kept = NEEDLES.filter((n) => STAGED.includes(n));
    ok("A6 the six source lines the R355 draft quotes for this file (register-wide-spread.js SRC_FACTS) are still in the staged file", quoted.length === 6 && kept.length === 6, { quoted: quoted.length, kept: kept.length }); }
  { const fetches = (STAGED.match(/\bfetch\(/g) || []).length, viaFn = (STAGED.match(/\bfetchFn\(/g) || []).length, api = (STAGED.match(/\bapi\(/g) || []).length;
    ok("A7 ONE fetch call site (the default of askBroker's fetch), ONE fetchFn( call (inside brokerGet, after limiter.take), and no unpaced api( left", fetches === 1 && viaFn === 1 && api === 0 && STAGED.indexOf("await limiter.take(latest)") < STAGED.indexOf("await fetchFn("), { fetches, viaFn, api }); }
  const tmpM = T.makeTree({ scriptText: STAGED }); let M = null; try { M = require(path.join(tmpM.bk, "alpaca-reconcile.js")); } catch (e) { ok("A8 the staged file loads as a module without running (require.main guard)", false, e.message); }
  if (!M) { console.log("\ncannot go on without the module"); process.exit(1); }
  { const PA = M.PACE, parsed = D.paceOf(STAGED);
    ok("A8 the staged file loads as a module without running, and deploy.cjs reads the same PACE from its text", JSON.stringify(parsed) === JSON.stringify({ ...PA }), parsed);
    ok("A9 PACE stays well under the account's 200 a minute: perMinute + burst <= maxInAnyMinute <= 120", PA.perMinute + PA.burst <= PA.maxInAnyMinute && PA.maxInAnyMinute <= 120, PA);
    const chain = fs.readFileSync(path.join(REPO, "automation", "close-chain.cjs"), "utf8");   // text only, never required
    ok("A10 the chain step is unchanged and gives the step 4 minutes; the budget (plus a 30 s margin for the reads and the write) fits inside it", chain.includes('["alpaca reconcile (broker vs our ledger)", "backend/alpaca-reconcile.js", 4],') && PA.budgetMs + 30000 <= 4 * 60000 && PA.tries >= 2 && PA.tries <= 5, PA.budgetMs); }

  // ── B. the limiter, fake clock ────────────────────────────────────────────────────────────────────────────────────────────
  section("B. the limiter on a fake clock");
  const fakeClock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; }, set: (v) => { t = v; } }; };
  const winMax = (ts, w) => { const s = [...ts].sort((a, b) => a - b); let best = 0; for (let i = 0, j = 0; i < s.length; i++) { while (s[i] - s[j] >= w) j++; best = Math.max(best, i - j + 1); } return best; };
  { const c = fakeClock(), L = M.makeLimiter({ now: c.now, sleep: c.sleep }), ts = []; for (let i = 0; i < 400; i++) { await L.take(); ts.push(c.now()); }
    const PA = M.PACE, msPer = 60000 / PA.perMinute, bounds = [1000, 10000, 60000, 300000].map((w) => ({ w, got: winMax(ts, w), max: Math.floor(PA.burst + PA.perMinute * w / 60000) }));
    ok("B1 a burst of 400 calls: in no 60 s window more than 120 (burst + perMinute), nor more than burst + rate x window in 1 s, 10 s, 300 s windows", bounds.every((b) => b.got <= b.max) && winMax(ts, 60000) <= PA.maxInAnyMinute, bounds);
    ok("B2 the burst is 10 calls at once, then one call every 60/110 s (the 400th at about 390 x 545 ms)", ts.slice(0, 10).every((t) => t === 0) && ts[10] >= msPer - 1 && Math.abs(ts[399] - 390 * msPer) < 400 && ts.slice(11).every((t, i) => t - ts[10 + i] >= msPer - 1), { first11: ts.slice(0, 12), last: ts[399] }); }
  { const c = fakeClock(), L = M.makeLimiter({ now: c.now, sleep: c.sleep }); L.hold(7000); await L.take(); const a = c.now(); await L.take(); const b = c.now();
    ok("B3 a hold of 7 s (a 429's Retry-After) stops the next call until it has passed, and empties the bucket (no burst after it)", a >= 7000 && b - a >= 60000 / M.PACE.perMinute - 1, { a, b }); }
  { const c = fakeClock(), L = M.makeLimiter({ now: c.now, sleep: c.sleep }); for (let i = 0; i < 10; i++) await L.take(); const r = await L.take(100);
    ok("B4 take(latest) answers false at once when the wait would end after latest (the clock does not move; no call is made)", r === false && c.now() === 0, { r, t: c.now() }); }
  { const now = Date.parse("2026-10-15T00:00:00Z");
    ok("B5 Retry-After: '7' -> 7000 ms, '1.5' -> 1500, an HTTP date 10 s ahead -> 10000, empty / absent / 'soon' -> null", M.retryAfterMs("7", now) === 7000 && M.retryAfterMs("1.5", now) === 1500 && M.retryAfterMs(new Date(now + 10000).toUTCString(), now) === 10000 && M.retryAfterMs("", now) === null && M.retryAfterMs(null, now) === null && M.retryAfterMs("soon", now) === null);
    ok("B6 peakPerMinute: [0, 59999, 60000] -> 2 (half-open minutes), [0, 0, 0] -> 3, [] -> 0", M.peakPerMinute([0, 59999, 60000]) === 2 && M.peakPerMinute([0, 0, 0]) === 3 && M.peakPerMinute([]) === 0); }

  // ── C. one broker read, fake clock ────────────────────────────────────────────────────────────────────────────────────────
  section("C. one broker read (brokerGet) on a fake clock");
  const resp = (oc) => { const h = {}; for (const [k, v] of Object.entries(oc.headers || {})) h[k.toLowerCase()] = String(v); return { ok: oc.status >= 200 && oc.status < 300, status: oc.status, headers: { get: (k) => (k.toLowerCase() in h ? h[k.toLowerCase()] : null) }, json: async () => (oc.body !== undefined ? JSON.parse(oc.body) : oc.json) }; };
  function harness(script, { budget = M.PACE.budgetMs } = {}) {
    const c = fakeClock(), calls = [];
    const fetchFn = async (url) => { calls.push({ at: c.now(), url }); const oc = script(calls.length, url); if (oc.network) throw Object.assign(new TypeError("fetch failed"), { cause: { code: oc.network } }); return resp(oc); };
    const ctx = { limiter: M.makeLimiter({ now: c.now, sleep: c.sleep }), now: c.now, sleep: c.sleep, fetchFn, deadline: c.now() + budget, stats: { starts: [], retried: 0, rateLimited: 0, reserveHolds: 0 }, stop: null };
    return { c, calls, ctx, get: (p = "/v2/orders/X?nested=true") => M.brokerGet(p, ctx) };
  }
  const GOOD = { status: 200, json: { id: "X", filled_qty: "1", filled_avg_price: "10" } };
  { const H = harness((n) => (n === 1 ? { status: 429, headers: { "Retry-After": "7" } } : GOOD)), r = await H.get();
    ok("C1 429 with Retry-After 7 s, then an answer: answered on try 2, which starts 7 s or more after try 1", r.ok && r.tries === 2 && H.calls[1].at - H.calls[0].at >= 7000 && H.ctx.stats.rateLimited === 1 && H.ctx.stats.retried === 1, { r, calls: H.calls }); }
  { const H = harness((n) => (n === 1 ? { status: 429 } : GOOD)), r = await H.get();
    ok("C2 429 with no Retry-After: answered on try 2 after the 1 s backoff at least", r.ok && r.tries === 2 && H.calls[1].at - H.calls[0].at >= 1000, H.calls); }
  { const H = harness(() => ({ status: 503 })), r = await H.get(), g = H.calls.slice(1).map((x, i) => x.at - H.calls[i].at);
    ok("C3 503 on every try: NOT an answer — httpStatus 503 after 4 tries, waiting 1, 2, 4 s between them, and never thrown", !r.ok && r.httpStatus === 503 && r.tries === 4 && H.calls.length === 4 && g[0] >= 1000 && g[1] >= 2000 && g[2] >= 4000 && /on all 4 tries/.test(r.why), { r, g }); }
  { const H = harness(() => ({ network: "ECONNRESET" })), r = await H.get();
    ok("C4 no answer at all (the network) on every try: httpStatus 'network', 4 tries, the reason named", !r.ok && r.httpStatus === "network" && r.tries === 4 && /ECONNRESET/.test(r.why), r); }
  { const H = harness(() => ({ status: 404, json: { message: "order not found" } })), r = await H.get();
    ok("C5 404 is the broker's own answer: httpStatus 404 on try 1, not retried", !r.ok && r.httpStatus === 404 && r.tries === 1 && H.calls.length === 1, r); }
  { const H = harness(() => ({ status: 401 })), r = await H.get(), r2 = await H.get("/v2/orders/Y?nested=true");
    ok("C6 401 is not retried, and stops every later call of the run ('not asked', no request made)", !r.ok && r.httpStatus === 401 && r.tries === 1 && !r2.ok && r2.httpStatus === "not asked" && r2.tries === 0 && H.calls.length === 1 && /refused the key/.test(r2.why), { r, r2 }); }
  { const H = harness(() => ({ status: 200, body: "<html>busy</html>" })), r = await H.get(), H2 = harness(() => ({ status: 200, json: [1, 2] })), r2 = await H2.get();
    ok("C7 a 200 whose body is not a JSON object (text, or a list) is not an answer: 'unreadable' after 4 tries", !r.ok && r.httpStatus === "unreadable" && r.tries === 4 && !r2.ok && r2.httpStatus === "unreadable", { r, r2 }); }
  { const H = harness(() => GOOD, { budget: 1000 }), r = await H.get();
    ok("C8 a budget that is spent: 'not asked', 0 tries, no request made", !r.ok && r.httpStatus === "not asked" && r.tries === 0 && H.calls.length === 0, r); }
  { const H = harness(() => ({ status: 503 }), { budget: 4000 }), r = await H.get();
    ok("C9 a retry that would end past the budget is not made: the last status stands (503), with the reason", !r.ok && r.httpStatus === 503 && r.tries === 2 && /no time left/.test(r.why) && H.calls.length === 2, { r, n: H.calls.length }); }
  { const reset = String(Math.floor(Date.now() / 1000) + 30), H = harness((n) => (n === 1 ? { ...GOOD, headers: { "X-RateLimit-Remaining": "5", "X-RateLimit-Reset": reset } } : GOOD)); await H.get(); await H.get("/v2/orders/Y?nested=true");
    const H2 = harness(() => ({ ...GOOD, headers: { "X-RateLimit-Remaining": "150", "X-RateLimit-Reset": reset } })); await H2.get(); await H2.get("/v2/orders/Y?nested=true");
    ok("C10 X-RateLimit-Remaining at or under 20: the next call waits for the account's window to reset (~30 s); at 150 it does not", H.calls[1].at - H.calls[0].at >= 28000 && H.ctx.stats.reserveHolds === 1 && H2.calls[1].at - H2.calls[0].at < 1000 && H2.ctx.stats.reserveHolds === 0, { gap: H.calls[1].at - H.calls[0].at, gap2: H2.calls[1].at - H2.calls[0].at }); }
  tmpM.done();

  // ── D. the replay in scratch trees ────────────────────────────────────────────────────────────────────────────────────────
  section("D. the replay of the recorded night (processes in scratch trees, fake broker, virtual clock)");
  let SET = null; try { SET = B.loadSet(); } catch (e) { ok("D0 harness/recorded matches its MANIFEST.json", false, e.message); }
  if (!SET) { console.log(`\n${failN} OF ${pass + failN} CHECKS FAILED (no recorded set)`); process.exit(1); }
  const files = SET.files, NIGHT = JSON.parse(files["last-night.json"]), REC_R = JSON.parse(files["responses.json"]), nightBy = new Map(NIGHT.perTicket.map((p) => [p.ticketId, p]));
  ok("D0 harness/recorded matches its MANIFEST.json (sha256 of every file) and holds the night of 2026-10-14: 109 order rows, 155 calls (109 entry + 46 close) on 151 paths (two close orders each serve three crypto tickets)", SET.manifest.night === NIGHT.asOf && NIGHT.mirrored === 109 && SET.manifest.counts.calls === 155 && SET.manifest.counts.entryCalls === 109 && SET.manifest.counts.closeCalls === 46 && Object.keys(REC_R.responses).length === 151, { counts: SET.manifest.counts, paths: Object.keys(REC_R.responses).length });
  const callBag = (fake) => (fake ? fake.calls.map((c) => c.path).sort().join("|") : null);
  const baseRun = B.runOnSet(BASE, files);
  ok("D1 the BASE copy on the recorded set writes the night's alpaca-reconcile.json BYTE FOR BYTE (the set is the night)", baseRun.outText === files["last-night.json"] && baseRun.status === 0, { status: baseRun.status, err: baseRun.stderr.slice(0, 200) });
  /** D2's checks on one script text -> [[name, bool, detail]] */
  function replayChecks(text) {
    const r = B.runOnSet(text, files), o = r.out, fk = r.fake;
    if (!o || !fk) return [["the run wrote its output and the fake broker its report", false, { status: r.status, err: r.stderr.slice(0, 300) }]];
    const rowsSame = o.perTicket.length === NIGHT.perTicket.length && o.perTicket.every((p, i) => JSON.stringify(p) === JSON.stringify(NIGHT.perTicket[i]));
    return [
      ["D2 the STAGED copy writes every one of the 109 rows byte for byte as the night's", rowsSame, rowsSame ? "" : JSON.stringify(o.perTicket.find((p, i) => JSON.stringify(p) !== JSON.stringify(NIGHT.perTicket[i])))],
      ["D3 ... and the whole file is the night's byte for byte once its three new keys (failedCalls, unknown, calls, right after reading) are taken out", JSON.stringify(withoutNew(o), null, 1) === files["last-night.json"] && NEWKEYS_ORDER(o) === "failedCalls,unknown,calls" && o.failedCalls === 0 && o.unknown === 0, NEWKEYS_ORDER(o)],
      ["D4 ... asking exactly the calls the base copy asked (the same 155 paths), nothing refused, exit 0", callBag(fk) === callBag(baseRun.fake) && fk.calls.length === 155 && !fk.refused.length && r.status === 0, { n: fk.calls.length, status: r.status }],
      ["D5 ... paced: the fake broker measured at most 120 calls in any minute, the script's own count agrees, and the run's last line says 0 UNKNOWN", T.peakOf(fk.calls) <= 120 && o.calls.peakPerMinute === T.peakOf(fk.calls) && o.calls.made === fk.calls.length && /0 UNKNOWN/.test(r.lastLine), { peak: T.peakOf(fk.calls), calls: o.calls, last: r.lastLine.slice(0, 160) }],
    ];
  }
  for (const [n, c, d] of replayChecks(STAGED)) ok(n, c, d);
  { const b = B.runOnSet(BASE, files, { args: ["--split-eras"] }), s = B.runOnSet(STAGED, files, { args: ["--split-eras"] });
    ok("D6 with --split-eras (W5's fix 4) the staged file minus its new keys is the base file byte for byte", !!(b.out && s.out && b.out.eras) && JSON.stringify(withoutNew(s.out), null, 1) === b.outText, { b: b.status, s: s.status }); }
  // failures injected on six tickets of the recorded night
  const nonLate = files["alpaca-mirror.jsonl"].trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.late);
  const ePath = (r) => `/v2/orders/${r.orderId}?nested=true`, closePath = (r) => Object.keys(REC_R.responses).find((p) => p !== ePath(r) && p.startsWith("/v2/orders/") && !p.includes("?") && (() => { const ex = files["alpaca-mirror-exits.jsonl"].trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.ticketId === r.ticketId).pop(); return ex && p === `/v2/orders/${ex.closeOrderId}`; })());
  const withClose = nonLate.filter((r) => closePath(r)), noClose = nonLate.filter((r) => !closePath(r));
  // (the failing set stays inside the budget: a call that never answers costs 4 x the call timeout, so it has a run of its own, D7e)
  const PICK = { e503: noClose[3], eNet: noClose[10], eHang: noClose[20], e404: noClose[30], r429: noClose[40], c429: withClose.filter((r) => !/Crypto/.test(r.ticketId))[5] };
  const FAILING = (() => { const R = JSON.parse(JSON.stringify(REC_R.responses));
    R[ePath(PICK.e503)] = [{ status: 503, json: { message: "service unavailable" } }]; R[ePath(PICK.eNet)] = [{ network: "ECONNRESET" }];
    R[ePath(PICK.e404)] = { status: 404, json: { code: 40410000, message: "order not found" } }; R[ePath(PICK.r429)] = [{ status: 429, headers: { "Retry-After": "20" }, json: { message: "too many requests" } }, REC_R.responses[ePath(PICK.r429)]];
    R[closePath(PICK.c429)] = [{ status: 429, json: { message: "too many requests" } }]; return R; })();
  /** D7-D9's checks on one script text, failures injected -> { checks, run } */
  function failureChecks(text) {
    const tree = T.makeTree({ scriptText: text, data: { "alpaca-mirror.jsonl": files["alpaca-mirror.jsonl"], "alpaca-mirror-exits.jsonl": files["alpaca-mirror-exits.jsonl"], "trade_log.json": files["trade_log.json"] } });
    try {
      const r = T.runTree(tree, { cfg: { nowIso: REC_R.nowIso, responses: FAILING, fallback: null } }), o = r.out, fk = r.fake;
      if (!o || !fk) return { checks: [["the run with failures wrote its output", false, { status: r.status, err: r.stderr.slice(0, 300) }]], run: r };
      const by = new Map(o.perTicket.map((p) => [p.ticketId, p])), U = (k, st, call) => { const p = by.get(PICK[k].ticketId); return !!p && p.reconcileStatus === "UNKNOWN" && p.issue === M.UNKNOWN_ISSUE && p.httpStatus === st && p.call === call && p.tries === 4 && typeof p.unknownReason === "string" && !("brokerFill" in p); };
      const failedIds = new Set(["e503", "eNet", "e404", "c429"].map((k) => PICK[k].ticketId));
      const others = o.perTicket.filter((p) => !failedIds.has(p.ticketId)), othersSame = others.length === 105 && others.every((p) => JSON.stringify(p) === JSON.stringify(nightBy.get(p.ticketId)));
      const expGaps = NIGHT.perTicket.filter((p) => !failedIds.has(p.ticketId) && p.slippagePct != null).map((p) => p.slippagePct), expFate = NIGHT.fateGaps.filter((g) => !failedIds.has(g.ticketId));
      const t429 = fk.calls.find((c) => c.path === ePath(PICK.r429)), after429 = fk.calls.filter((c) => c.at > t429.at || (c.at === t429.at && c !== t429)), firstAfter = after429.length ? Math.min(...after429.map((c) => c.at)) : null;
      // the second ask of the r429 ticket comes after the hold, and no call of any path starts inside the 20 s Retry-After
      const retried = fk.calls.filter((c) => c.path === ePath(PICK.r429)).length === 2;
      return { run: r, checks: [
        ["D7 a 503 on every try, and no answer at all on every try: each ticket UNKNOWN (httpStatus 503 / 'network', 4 tries), never 'broker has no record'", U("e503", 503, "entry order") && U("eNet", "network", "entry order") && !o.perTicket.some((p) => p.reconcileStatus === "UNKNOWN" && /no record/.test(p.issue)), [by.get(PICK.e503.ticketId), by.get(PICK.eNet.ticketId)]],
        ["D7b a close order that is rate-limited on every try: its ticket UNKNOWN (call 'close order', httpStatus 429) — not priced on the legs alone", U("c429", 429, "close order"), by.get(PICK.c429.ticketId)],
        ["D7c a 404 is the broker's answer and stays as before: { ticketId, sym, issue: 'broker has no record of this order', httpStatus: 404 }", JSON.stringify(by.get(PICK.e404.ticketId)) === JSON.stringify({ ticketId: PICK.e404.ticketId, sym: PICK.e404.sym, issue: "broker has no record of this order", httpStatus: 404 }), by.get(PICK.e404.ticketId)],
        ["D7d a 429 with Retry-After 20 s that then answers: the night's row byte for byte; every other answered row too (105 rows)", othersSame && JSON.stringify(by.get(PICK.r429.ticketId)) === JSON.stringify(nightBy.get(PICK.r429.ticketId)) && retried, { othersSame, retried }],
        ["D8 the counts leave the UNKNOWN tickets out: filled 105 (109 less 3 UNKNOWN and the 404), unfilled 0, missing 1, unknown 3, failedCalls 4; fillGaps and fateGaps are the night's without those four", o.filled === 105 && o.unfilled === 0 && o.missingAtBroker === 1 && o.unknown === 3 && o.failedCalls === 4 && JSON.stringify(o.fillGaps) === JSON.stringify(expGaps) && JSON.stringify(o.fateGaps) === JSON.stringify(expFate), { filled: o.filled, missing: o.missingAtBroker, unknown: o.unknown, failedCalls: o.failedCalls }],
        ["D8b the reading STARTS 'UNKNOWN: 3 of 109 mirrored ticket(s)', the last line says '3 UNKNOWN', and the run exits 3", /^UNKNOWN: 3 of 109 mirrored ticket\(s\) have no broker answer tonight/.test(o.reading) && /, 3 UNKNOWN ·/.test(r.lastLine) && r.status === 3, { reading: String(o.reading).slice(0, 160), last: r.lastLine.slice(0, 120), status: r.status }],
        ["D9 Retry-After holds EVERY call: after the 429 (Retry-After 20 s) no call of any path starts for 20 s, and the ticket is asked again", firstAfter != null && firstAfter - t429.at >= 20000 && retried, { gap: firstAfter == null ? null : firstAfter - t429.at }],
        ["D9b paced through it all (at most 120 calls in any minute by the fake's own clock), nothing refused", T.peakOf(fk.calls) <= 120 && !fk.refused.length, T.peakOf(fk.calls)],
      ] };
    } finally { tree.done(); }
  }
  const FC = failureChecks(STAGED); for (const [n, c, d] of FC.checks) ok(n, c, d);
  { // a call that never answers, on every try: its own run (4 x the call timeout plus the backoffs come out of the budget)
    const R = { ...REC_R.responses, [ePath(PICK.eHang)]: [{ hang: true }] }, r = B.runOnSet(STAGED, files, { responses: R }), o = r.out, p = o && o.perTicket.find((x) => x.ticketId === PICK.eHang.ticketId);
    const tries = r.fake ? r.fake.calls.filter((c) => c.path === ePath(PICK.eHang)).map((c) => c.at) : [], gaps = tries.slice(1).map((t, i) => t - tries[i]), rest = o ? o.perTicket.filter((x) => x.ticketId !== PICK.eHang.ticketId) : [];
    ok("D7e no answer within the call timeout on every try: UNKNOWN httpStatus 'network' after 4 tries, each try given the full timeout; every other row the night's; exit 3", !!p && p.reconcileStatus === "UNKNOWN" && p.httpStatus === "network" && p.tries === 4 && /no answer within 10 s/.test(p.unknownReason) && tries.length === 4 && gaps.every((g, i) => g >= M.PACE.callTimeoutMs + 1000 * 2 ** i) && rest.length === 108 && rest.every((x) => JSON.stringify(x) === JSON.stringify(nightBy.get(x.ticketId))) && r.status === 3, { p, gaps, status: r.status }); }
  { // the defect, shown on the base copy with the same failures
    const tree = T.makeTree({ scriptText: BASE, data: { "alpaca-mirror.jsonl": files["alpaca-mirror.jsonl"], "alpaca-mirror-exits.jsonl": files["alpaca-mirror-exits.jsonl"], "trade_log.json": files["trade_log.json"] } });
    try { const r = T.runTree(tree, { cfg: { nowIso: REC_R.nowIso, responses: FAILING } }), by = new Map((r.out ? r.out.perTicket : []).map((p) => [p.ticketId, p]));
      ok("D10 (the defect, on the base copy with the same failures) a 503, no answer, and even a 429 that one retry would have answered each become 'broker has no record of this order' (missing 4 with the 404), and the rate-limited close order is silently dropped", !!r.out && r.out.missingAtBroker === 4 && ["e503", "eNet", "r429"].every((k) => by.get(PICK[k].ticketId).issue === "broker has no record of this order") && JSON.stringify(by.get(PICK.c429.ticketId)) !== JSON.stringify(nightBy.get(PICK.c429.ticketId)), r.out ? r.out.missingAtBroker : r.stderr.slice(0, 200)); }
    finally { tree.done(); } }
  { // a later success replaces UNKNOWN: the same tree, the failing night, then a healthy one
    const tree = T.makeTree({ scriptText: STAGED, data: { "alpaca-mirror.jsonl": files["alpaca-mirror.jsonl"], "alpaca-mirror-exits.jsonl": files["alpaca-mirror-exits.jsonl"], "trade_log.json": files["trade_log.json"] } });
    try { const r1 = T.runTree(tree, { cfg: { nowIso: REC_R.nowIso, responses: FAILING } }), r2 = T.runTree(tree, { cfg: { nowIso: REC_R.nowIso, responses: REC_R.responses } });
      ok("D11 a later run whose calls are answered replaces every UNKNOWN: the night's rows byte for byte, unknown 0, exit 0 (nothing is carried over from the failing run)", r1.out && r1.out.unknown === 3 && r2.out && r2.out.unknown === 0 && r2.status === 0 && JSON.stringify(withoutNew(r2.out), null, 1) === files["last-night.json"], { u1: r1.out && r1.out.unknown, u2: r2.out && r2.out.unknown, s2: r2.status }); }
    finally { tree.done(); } }
  /** 400 tickets against the budget -> [[name, bool, detail]] */
  const BIG = (() => { const rows = [], responses = {}; for (let i = 0; i < 400; i++) { const id = `T${String(i).padStart(3, "0")}`, oid = `o-${id}`; rows.push({ ts: `2026-10-14T14:${String(Math.floor(i / 10)).padStart(2, "0")}:00Z`, ticketId: id, sym: "AAA", side: "buy", qty: 10, ticketEntry: 10, orderId: oid }); responses[`/v2/orders/${oid}?nested=true`] = { status: 200, json: { id: oid, status: "filled", filled_qty: "10", filled_avg_price: "10.01", legs: [] } }; } return { rows, responses }; })();
  function budgetChecks(text) {
    const tree = T.makeTree({ scriptText: text, data: { "alpaca-mirror.jsonl": BIG.rows, "alpaca-mirror-exits.jsonl": "", "trade_log.json": [] } });
    try {
      const r = T.runTree(tree, { cfg: { nowIso: "2026-10-14T20:20:00.000Z", responses: BIG.responses } }), o = r.out, fk = r.fake; if (!o || !fk) return [["the 400-ticket run wrote its output", false, r.stderr.slice(0, 300)]];
      const PA = M.PACE, cap = PA.burst + Math.floor(PA.perMinute * (PA.budgetMs - PA.minCallMs) / 60000), u = o.perTicket.filter((p) => p.reconcileStatus === "UNKNOWN");
      const oldestFirst = u.length > 0 && u.every((p, i) => p.ticketId === BIG.rows[i].ticketId && p.httpStatus === "not asked" && p.tries === 0), newestAnswered = o.perTicket[399].brokerFill === 10.01;
      return [
        ["D12 400 tickets, a burst of 400 calls: the fake broker measured at most 120 in any minute, and the calls stop at the budget (no more than burst + rate x budget)", T.peakOf(fk.calls) <= 120 && fk.calls.length <= cap && fk.calls.length >= cap - 2 && fk.vnow <= PA.budgetMs + 1000, { peak: T.peakOf(fk.calls), calls: fk.calls.length, cap, vnow: fk.vnow }],
        ["D12b the tickets never asked are UNKNOWN 'not asked' (0 tries) and they are the OLDEST rows; the newest are answered; exit 3 and the reading starts UNKNOWN", oldestFirst && u.length === 400 - fk.calls.length && newestAnswered && r.status === 3 && /^UNKNOWN: /.test(o.reading) && o.calls.notAsked === u.length, { unknown: u.length, first: u[0] && u[0].ticketId, status: r.status }],
      ];
    } finally { tree.done(); }
  }
  for (const [n, c, d] of budgetChecks(STAGED)) ok(n, c, d);
  { const R = { ...REC_R.responses, [ePath(nonLate[nonLate.length - 1])]: { status: 401, json: { message: "unauthorized" } } }, r = B.runOnSet(STAGED, files, { responses: R }), o = r.out;
    ok("D13 a 401 on the first call (the newest row): no other call is made; that ticket UNKNOWN 401, the other 108 UNKNOWN 'not asked'; nothing reads as missing or unfilled; exit 3", !!o && r.fake.calls.length === 1 && o.unknown === 109 && o.missingAtBroker === 0 && o.unfilled === 0 && o.filled === 0 && o.perTicket.filter((p) => p.httpStatus === "not asked").length === 108 && o.perTicket[108].httpStatus === 401 && r.status === 3 && /^UNKNOWN: 109 of 109/.test(o.reading), o ? { calls: r.fake.calls.length, unknown: o.unknown, reading: o.reading.slice(0, 100) } : r.stderr.slice(0, 200)); }
  { const tree = T.makeTree({ scriptText: STAGED, data: { "alpaca-mirror.jsonl": files["alpaca-mirror.jsonl"], "alpaca-mirror-exits.jsonl": files["alpaca-mirror-exits.jsonl"], "trade_log.json": files["trade_log.json"] } });
    try { const dry = path.join(tree.dir, "dry.json"), r = T.runTree(tree, { cfg: { nowIso: REC_R.nowIso, responses: REC_R.responses }, args: ["--dry-print", dry], outFile: dry }), inData = fs.existsSync(path.join(tree.dd, "alpaca-reconcile.json"));
      const r2 = T.runTree(tree, { cfg: { nowIso: REC_R.nowIso, responses: REC_R.responses }, args: ["--dry-print", path.join(tree.dd, "x.json")], outFile: path.join(tree.dd, "x.json") }), r3 = T.runTree(tree, { cfg: { nowIso: REC_R.nowIso, responses: REC_R.responses }, args: ["--dry-print"] });
      ok("D14 --dry-print <file>: the same output written to that file only (backend/data gets nothing), the last line says DRY", r.status === 0 && !!r.out && JSON.stringify(withoutNew(r.out), null, 1) === files["last-night.json"] && !inData && /DRY: written to/.test(r.lastLine), { status: r.status, inData });
      ok("D14b --dry-print into backend/data, or with no file: refused, exit 2, nothing asked, nothing written", r2.status === 2 && r2.fake && r2.fake.calls.length === 0 && !fs.existsSync(path.join(tree.dd, "x.json")) && r3.status === 2 && r3.fake && r3.fake.calls.length === 0 && !fs.existsSync(path.join(tree.dd, "alpaca-reconcile.json")), { s2: r2.status, s3: r3.status }); }
    finally { tree.done(); } }
  { const mk = (text) => { const tree = T.makeTree({ scriptText: text, data: { "trade_log.json": [] } }); try { return T.runTree(tree, { cfg: { nowIso: REC_R.nowIso, responses: {} } }); } finally { tree.done(); } };
    const b = mk(BASE), s = mk(STAGED);
    ok("D15 nothing mirrored yet (no mirror log): the staged file writes what the base file writes, byte for byte, asks nothing, exit 0", b.outText && s.outText === b.outText && s.status === 0 && s.fake.calls.length === 0, { b: b.outText, s: s.outText }); }

  // ── E. mutation-proof ─────────────────────────────────────────────────────────────────────────────────────────────────────
  section("E. mutation-proof: each mutant of the staged file must be caught by the check of D written for it");
  const failedIds = (list) => list.filter((x) => !x[1]).map((x) => String(x[0]).split(" ")[0]);
  const viaReplay = (t) => failedIds(replayChecks(t)), viaFailures = (t) => failedIds(failureChecks(t).checks), viaBudget = (t) => failedIds(budgetChecks(t));
  const MUT = [   // [name, [exact text, replacement], the checks that run it, the check that must catch it]
    ["E1 remove the limiter (every call at once)", ["if (!(await limiter.take(latest))) return", "if (!(true)) return"], viaReplay, "D5"],
    ["E2 write 'no record' on a failed call (the old shape)", ["const unknownRow = (r, a, call) => { U.unknown++; U.failedCalls++; out.perTicket.push({ ticketId: r.ticketId, sym: r.sym, reconcileStatus: \"UNKNOWN\", issue: UNKNOWN_ISSUE, unknownReason: `${call}: ${a.why}`, httpStatus: a.httpStatus, call, tries: a.tries }); };", "const unknownRow = (r, a, call) => { U.failedCalls++; out.missingAtBroker++; out.perTicket.push({ ticketId: r.ticketId, sym: r.sym, issue: \"broker has no record of this order\" }); };"], viaFailures, "D7"],
    ["E3 drop the retry (one try only)", ["tries: 4,", "tries: 1,"], viaFailures, "D7d"],
    ["E4 ignore Retry-After (the backoff alone)", ["limiter.hold(Math.max(wait, ra == null ? 0 : ra)); wait = 0;", "limiter.hold(wait); wait = 0;"], viaFailures, "D9"],
    ["E5 a reading that does not say UNKNOWN", ["if (U.unknown) {   // RECONCILE-PACING 2026-10-14: the reading starts", "if (false) {   // RECONCILE-PACING 2026-10-14: the reading starts"], viaFailures, "D8b"],
    ["E6 exit 0 on a night with UNKNOWN tickets", ["if (out.unknown) process.exitCode = 3;", "if (false) process.exitCode = 3;"], viaFailures, "D8b"],
    ["E7 no time budget", ["budgetMs: 180000,", "budgetMs: 1e9,"], viaBudget, "D12"],
    ["E8 a 404 made UNKNOWN instead of the broker's answer", ["if (A && A.entry.httpStatus === 404) {", "if (false) {"], viaFailures, "D7c"],
    ["E9 a failed close-order lookup priced on the legs (the old silent catch)", ["    if (A.close && !A.close.ok) { unknownRow(r, A.close, \"close order\"); continue; }", "    if (A.close && !A.close.ok) A.close.json = {};"], viaFailures, "D7b"],
  ];
  for (const [name, [from, to], via, want] of MUT) { let got = null, why = ""; try { got = via(mutate(STAGED, from, to)); } catch (e) { why = e.message; } ok(`${name}: caught by ${want}${got ? ` (failing: ${got.join(", ")})` : ""}`, !!got && got.includes(want), why || `the checks that failed: ${got ? got.join(", ") || "none" : "-"}`); }

  // ── F. deploy and rollback on scratch repos ───────────────────────────────────────────────────────────────────────────────
  section("F. deploy and rollback on scratch repos");
  const at = (iso) => () => Date.parse(iso);
  const SAT = "2026-10-17T16:00:00Z" /* Sat 10:00 MT */, THU10 = "2026-10-15T16:00:00Z" /* Thu 10:00 MT */, THU0529 = "2026-10-15T11:29:00Z", THU1630 = "2026-10-15T22:30:00Z" /* Thu 16:30 MT = 18:30 ET */;
  const finishedToday = { started: "2026-10-15T20:15:00Z", finished: "2026-10-15T21:30:00Z" }, yesterday = { started: "2026-10-14T20:15:52Z", finished: "2026-10-14T21:33:27Z" };
  function scratchRepo(bytes) {   // backend/alpaca-reconcile.js with the given bytes, and the atomic-write library record.cjs loads from the repo it records for
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-repo-")); fs.mkdirSync(path.join(dir, "backend", "data"), { recursive: true }); fs.mkdirSync(path.join(dir, "backend", "lib"), { recursive: true });
    fs.writeFileSync(path.join(dir, "backend", "alpaca-reconcile.js"), bytes); fs.copyFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"), path.join(dir, "backend", "lib", "atomic-write.js")); return dir; }
  const liveOf = (dir) => fs.readFileSync(path.join(dir, "backend", "alpaca-reconcile.js"));
  const okGate = { what: "fake gate", n: 0, run() { this.n++; return { ok: true, line: "ALL 1 CHECKS PASSED" }; } }, redGate = { what: "fake red gate", run: () => ({ ok: false, why: "1 OF 2 CHECKS FAILED" }) };
  const deps = (dir, more = {}) => ({ repo: dir, pkg: PKG, now: at(SAT), listProcs: () => [], chainStatus: () => yesterday, holidays: D.HOLIDAYS, log: () => {}, ...more });
  { const dir = scratchRepo(Buffer.from(BASE));
    try {
      ok("F1 a scratch repo holding the base bytes plans as 'base'", D.plan({ repo: dir }).files[0].state === "base");
      const a = D.make(deps(dir)).writeUnit({ to: "staged", gate: okGate });
      ok("F2 --apply on it (fences clear, gate green): writes the staged bytes, read back by sha256, the gate run once", a.result === "done" && a.written.length === 1 && sha(liveOf(dir)) === F0.stagedSha && okGate.n === 1, a);
      const a2 = D.make(deps(dir)).writeUnit({ to: "staged", gate: okGate });
      ok("F3 --apply again: nothing to write (applied), the gate not run again", a2.result === "done" && a2.written.length === 0 && okGate.n === 1, a2);
      const rb = RB.rollback(deps(dir));
      ok("F4 rollback: the base bytes back, BYTE-EXACT (Buffer equal to base/backend/alpaca-reconcile.js)", rb.result === "done" && rb.written.length === 1 && liveOf(dir).equals(fs.readFileSync(path.join(PKG, "base", "backend", "alpaca-reconcile.js"))), rb);
      const red = D.make(deps(dir)).writeUnit({ to: "staged", gate: redGate });
      ok("F5 a red selftest gate refuses the apply; nothing written", red.result === "refused" && sha(liveOf(dir)) === F0.baseSha, red.why);
      fs.writeFileSync(path.join(dir, "backend", "alpaca-reconcile.js"), BASE + "// someone's edit\n"); const before = liveOf(dir);
      const dr = D.make(deps(dir)).writeUnit({ to: "staged", gate: okGate }), dr2 = RB.rollback(deps(dir));
      ok("F6 DRIFT (the file is neither base nor staged): the apply AND the rollback refuse, the file is left as it is", dr.result === "refused" && /DRIFT/.test(dr.why.join(" ")) && dr2.result === "refused" && liveOf(dir).equals(before), { dr: dr.why, dr2: dr2.why });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
  { const H = D.HOLIDAYS;
    ok("F7 the clock fence: Thu 10-15 10:00 MT refused; 05:29 MT and 16:00 MT clear; Sat 10:00 MT clear; Thanksgiving (11-26) 10:00 MT clear", !!D.clockFence(Date.parse(THU10), H) && !D.clockFence(Date.parse(THU0529), H) && !D.clockFence(Date.parse("2026-10-15T22:00:00Z"), H) && !D.clockFence(Date.parse(SAT), H) && !D.clockFence(Date.parse("2026-11-26T17:00:00Z"), H));
    ok("F8 the chain fence: Thu 16:30 MT with yesterday's chain-status (due), or today's with no finished stamp (running): refused; today's finished run: clear; a Saturday or 10:00 ET: clear", !!D.chainFence(Date.parse(THU1630), yesterday, H) && !!D.chainFence(Date.parse(THU1630), { started: finishedToday.started }, H) && !D.chainFence(Date.parse(THU1630), finishedToday, H) && !D.chainFence(Date.parse(SAT), yesterday, H) && !D.chainFence(Date.parse("2026-10-15T14:00:00Z"), yesterday, H) && !!D.chainFence(Date.parse(THU1630), null, H));
    const W = (s) => s.replace(/\//g, "\\"), R = REPO;
    const chainAbs = [{ pid: 11, cmd: `"C:\\Program Files\\nodejs\\node.exe" "${W(path.join(R, "automation", "close-chain.cjs"))}"` }], chainRel = [{ pid: 12, cmd: "node  automation\\close-chain.cjs" }], recAbs = [{ pid: 13, cmd: `"node.exe" "${W(path.join(R, "backend", "alpaca-reconcile.js"))}" --dry-print x` }];
    const harmless = [{ pid: 14, cmd: `node "${W(path.join(os.tmpdir(), "rp-tree-abc", "backend", "alpaca-reconcile.js"))}"` }, { pid: 15, cmd: "node docs/reconcile-pacing/2026-10-14/deploy.cjs --apply" }, { pid: 16, cmd: "node backend/traids-server-v2.js" }];
    ok("F9 the process fence: the chain (by its absolute path or `node automation\\close-chain.cjs`) and the reconcile refuse; a scratch tree's copy, this package's own scripts and other node processes do not; an unreadable list refuses (fail-closed)",
      D.procFence(() => chainAbs, R).length === 1 && D.procFence(() => chainRel, R).length === 1 && /reconcile.js is running/.test(D.procFence(() => recAbs, R).join(" ")) && D.procFence(() => harmless, R).length === 0 && /could not be read/.test(D.procFence(() => { throw new Error("access denied"); }, R).join(" ")));
    const dir = scratchRepo(Buffer.from(BASE));
    try { const recHere = [{ pid: 17, cmd: `"node.exe" "${W(path.join(dir, "backend", "alpaca-reconcile.js"))}"` }];   // the scratch repo's own reconcile
      const cases = [["a trading-day clock", { now: at(THU10) }], ["the chain due", { now: at(THU1630) }], ["the chain running", { listProcs: () => chainRel }], ["the reconcile running", { listProcs: () => recHere }], ["no process list", { listProcs: () => { throw new Error("denied"); } }]];
      const res = cases.map(([n, m]) => [n, D.make(deps(dir, m)).writeUnit({ to: "staged", gate: okGate }).result]);
      ok("F10 the apply is refused under each fence and writes nothing", res.every(([, r]) => r === "refused") && sha(liveOf(dir)) === F0.baseSha, res); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
    let procs = null, why = null; try { procs = D.listNodeProcs(); } catch (e) { why = e.message; }
    ok("F11 the real process list can be read here (read-only) and holds this selftest's own node process", Array.isArray(procs) && procs.some((p) => p.pid === process.pid), why || (procs || []).length); }

  // ── G. record.cjs ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("G. record.cjs");
  { const dd = path.join(REPO, "backend", "data"), shaF = (f) => { try { return sha(fs.readFileSync(path.join(dd, f))); } catch { return null; } };
    const b0 = [shaF("change-registry.json"), shaF("agent-ledger.jsonl")], lock0 = fs.existsSync(path.join(dd, "registry-write.lock"));
    const r = REC.run({ dry: true, log: () => {} }), b1 = [shaF("change-registry.json"), shaF("agent-ledger.jsonl")], lock1 = fs.existsSync(path.join(dd, "registry-write.lock"));
    ok("G1 --dry on the REAL data: exit 0, nothing written (both files' sha256 unchanged), no lock taken", r.code === 0 && r.result !== "written" && b0.join() === b1.join() && (lock0 || !lock1), { result: r.result, code: r.code }); }
  function scratchData() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-data-")); fs.writeFileSync(path.join(dir, "change-registry.json"), JSON.stringify([{ id: "earlier-row" }], null, 1)); fs.writeFileSync(path.join(dir, "agent-ledger.jsonl"), JSON.stringify({ at: "x", kind: "NOTE" }) + "\n"); return dir; }
  { const repoA = scratchRepo(fs.readFileSync(path.join(PKG, "staged", "backend", "alpaca-reconcile.js"))), repoB = scratchRepo(Buffer.from(BASE)), dd = scratchData(), q = { log: () => {}, holidays: D.HOLIDAYS, pkg: PKG, lockWaitMs: 0, sleep: () => {} };
    try {
      const w = REC.run({ ...q, dataDir: dd, repo: repoA, now: at(SAT) }), cr = JSON.parse(fs.readFileSync(path.join(dd, "change-registry.json"), "utf8")), led = fs.readFileSync(path.join(dd, "agent-ledger.jsonl"), "utf8").trim().split("\n");
      ok("G2 the write (home applied, Saturday): ONE change-registry row (reconcile-pacing-2026-10-14, breaksComparability false, the code before/after) and ONE GOVERNANCE line; the lock removed", w.code === 0 && w.result === "written" && cr.length === 2 && cr[1].id === REC.CR_ID && cr[1].breaksComparability === false && cr[1].files["backend/alpaca-reconcile.js"].before === F0.baseSha && cr[1].files["backend/alpaca-reconcile.js"].after === F0.stagedSha && led.length === 2 && JSON.parse(led[1]).kind === "GOVERNANCE" && JSON.parse(led[1]).changeRegistry === REC.CR_ID && !fs.existsSync(path.join(dd, "registry-write.lock")), { w: w.result, cr: cr.length, led: led.length });
      const again = REC.run({ ...q, dataDir: dd, repo: repoA, now: at(SAT) });
      ok("G3 a second run: ALREADY RECORDED, exit 0, nothing more written", again.code === 0 && again.result === "already" && JSON.parse(fs.readFileSync(path.join(dd, "change-registry.json"), "utf8")).length === 2);
      const dd2 = scratchData(), s0 = sha(fs.readFileSync(path.join(dd2, "change-registry.json")));
      const win = REC.run({ ...q, dataDir: dd2, repo: repoA, now: at("2026-10-15T20:00:00Z") /* Thu 14:00 MT */ }), notApplied = REC.run({ ...q, dataDir: dd2, repo: repoB, now: at(SAT) });
      ok("G4 refused inside 13:50-15:50 MT on a trading day, and refused while home's file is not the staged one; nothing written", win.code === 2 && notApplied.code === 2 && /no-write window/.test(win.lines.join(" ")) && /not the staged one/.test(notApplied.lines.join(" ")) && sha(fs.readFileSync(path.join(dd2, "change-registry.json"))) === s0);
      const lockF = path.join(dd2, "registry-write.lock"); fs.writeFileSync(lockF, JSON.stringify({ token: "another-writer" }) + "\n");
      const held = REC.run({ ...q, dataDir: dd2, repo: repoA, now: at(SAT) });
      ok("G5 another writer's lock (flag wx finds it): refused, nothing written, and that lock is left in place untouched", held.code === 2 && /held by another writer/.test(held.lines.join(" ")) && fs.readFileSync(lockF, "utf8").includes("another-writer") && sha(fs.readFileSync(path.join(dd2, "change-registry.json"))) === s0, held.lines.slice(-1));
      fs.unlinkSync(lockF); const crP = JSON.parse(fs.readFileSync(path.join(dd2, "change-registry.json"), "utf8")); crP.push({ id: REC.CR_ID }); fs.writeFileSync(path.join(dd2, "change-registry.json"), JSON.stringify(crP));
      const part = REC.run({ ...q, dataDir: dd2, repo: repoA, now: at(SAT) });
      ok("G6 a PART of the record already there (the row, no line): refused, nothing written", part.code === 2 && /PART of this record/.test(part.lines.join(" ")) && fs.readFileSync(path.join(dd2, "agent-ledger.jsonl"), "utf8").trim().split("\n").length === 1);
      fs.rmSync(dd2, { recursive: true, force: true });
    } finally { for (const d of [repoA, repoB, dd]) fs.rmSync(d, { recursive: true, force: true }); } }

  // ── H. verify-live's pure parts and its guard ─────────────────────────────────────────────────────────────────────────────
  section("H. verify-live.cjs: the row comparison, the judged lines, the GET-only guard");
  { const settled = { ticketId: "A", sym: "A", side: "buy", qty: 1, ticketEntry: 10, brokerFill: 10, slippagePct: 0, brokerExit: 11, brokerExitReason: "limit", ourExit: 11, ourPnl: 1, ourReason: "target", brokerPnl: 1, pnlGap: 0 };
    const open = { ...settled, ticketId: "B", brokerExit: null, brokerExitReason: null, ourExit: null, ourPnl: null, ourReason: null }; delete open.brokerPnl; delete open.pnlGap;
    const last = [settled, open, { ...settled, ticketId: "C" }, { ...settled, ticketId: "D" }, { ...settled, ticketId: "E" }, { ...settled, ticketId: "F" }, { ...settled, ticketId: "G" }];
    const now = [settled, { ...settled, ticketId: "B" }, { ...settled, ticketId: "C", ourPnl: 2, pnlGap: -1 }, { ...settled, ticketId: "D", ourPnl: 3, pnlGap: -2 }, { ...settled, ticketId: "E", brokerExit: 12, brokerPnl: 2 }, { ticketId: "F", sym: "F", reconcileStatus: "UNKNOWN", httpStatus: 429 }, { ...settled, ticketId: "N" }];
    const c = VL.compareRows(last, now, (id) => (id === "C" ? { exit: 11, pnl: 2, reason: "target" } : id === "D" ? { exit: 11, pnl: 9, reason: "target" } : undefined));
    ok("H1 compareRows: equal / moved on (open last night) / the board's record changed and trade_log says so (explained) / not explained / the broker side changed / UNKNOWN tonight / missing tonight / new", c.same === 1 && c.movedOn === 1 && c.ledgerExplained === 1 && c.ledgerUnexplained.length === 1 && c.ledgerUnexplained[0].id === "D" && c.brokerChanged.length === 1 && c.brokerChanged[0].id === "E" && c.unknownNow === 1 && c.gone.length === 1 && c.gone[0] === "G" && c.newSince === 1, c);
    const code = { state: "applied", home: F0.stagedSha, stagedSha: F0.stagedSha }, out = { unknown: 0, perTicket: [], calls: { made: 3, retried: 0, rateLimited: 0, spentSec: 1 } }, guard = { calls: [0, 1, 2].map((i) => ({ at: i * 600, path: "/v2/orders/x" })), refused: [] };
    const good = VL.judge({ codeOk: true, code, run: { status: 0, last: "x" }, beforeSha: "s", afterSha: "s", guard, out, cmp: { same: 3, movedOn: 0, ledgerExplained: 0, unknownNow: 0, newSince: 0, brokerChanged: [], ledgerUnexplained: [], gone: [] } });
    const v = (L, n) => (L.find((l) => l.name === n) || {}).verdict;
    const bad = VL.judge({ codeOk: true, code, run: { status: 3, last: "x" }, beforeSha: "s", afterSha: "t", guard: { calls: Array.from({ length: 121 }, (_, i) => ({ at: i, path: "/v2/orders/x" })), refused: [{ method: "POST" }] }, out: { ...out, unknown: 2, perTicket: [{ reconcileStatus: "UNKNOWN", httpStatus: 503 }, { reconcileStatus: "UNKNOWN", httpStatus: 503 }] }, cmp: null });
    const noCode = VL.judge({ codeOk: false, code: { state: "base", home: F0.baseSha, stagedSha: F0.stagedSha } });
    ok("H2 the judged lines: a clean run is PASS on all eight; a changed data file, a refused POST, 121 calls in a minute, a count that disagrees are FAIL; UNKNOWN tickets are UNKNOWN; a live file that is not staged is FAIL with no run", good.length === 8 && good.every((l) => l.verdict === "PASS") && v(bad, "untouched") === "FAIL" && v(bad, "get-only") === "FAIL" && v(bad, "peak") === "FAIL" && v(bad, "calls") === "FAIL" && v(bad, "unknown") === "UNKNOWN" && v(bad, "rows") === "UNKNOWN" && noCode.length === 1 && noCode[0].verdict === "FAIL", { good, bad }); }
  { const g = path.join(PKG, "harness", "get-only.cjs"), repF = path.join(os.tmpdir(), `rp-guard-${process.pid}.json`);
    const prog = `globalThis.fetch = async (u, i) => { (globalThis.__hits = globalThis.__hits || []).push(String(u)); return { ok: true, status: 200 }; }; require(${JSON.stringify(g)}); (async () => { const out = []; for (const [u, m] of [["https://paper-api.alpaca.markets/v2/orders/abc?nested=true", "GET"], ["https://paper-api.alpaca.markets/v2/orders", "POST"], ["https://api.alpaca.markets/v2/orders/abc", "GET"], ["http://paper-api.alpaca.markets/v2/orders/abc", "GET"]]) { try { await fetch(u, { method: m }); out.push("passed"); } catch (e) { out.push("refused"); } } console.log(JSON.stringify({ out, hits: globalThis.__hits || [] })); })();`;
    const r = cp.spawnSync(process.execPath, ["-e", prog], { encoding: "utf8", windowsHide: true, env: { ...process.env, GET_ONLY_OUT: repF } }); let res = null, rep = null; try { res = JSON.parse(r.stdout.trim()); rep = JSON.parse(fs.readFileSync(repF, "utf8")); } catch { /* the check says so */ } try { fs.unlinkSync(repF); } catch { /* none */ }
    ok("H3 the GET-only guard: a GET to https://paper-api passes (and is recorded by path only); a POST, the LIVE host and plain http are refused BEFORE the real fetch is called", !!res && res.out.join() === "passed,refused,refused,refused" && res.hits.length === 1 && rep && rep.calls.length === 1 && rep.calls[0].path === "/v2/orders/abc" && rep.refused.length === 3, { res, rep, err: r.stderr }); }

  console.log(failN ? `\n${failN} OF ${pass + failN} CHECKS FAILED: ${failed.join(" | ")}` : `\nALL ${pass} CHECKS PASSED`);
  process.exitCode = failN ? 1 : 0;
})().catch((e) => { console.log(`  FAIL the selftest crashed — ${e && e.stack ? e.stack : e}`); console.log(`\n${failN + 1} OF ${pass + failN + 1} CHECKS FAILED (crash)`); process.exitCode = 1; });
