#!/usr/bin/env node
/**
 * OPS HEALTH FIX 2026-10-05 — scratch harness for the circuit-breaker change in POST /api/board-positions.
 * Slices the board handlers (and the helpers they use) out of a server FILE, evaluates them with a fake `app` (no port is bound, nothing
 * starts), and points EVERY path the handler writes at a temp directory: board, tombstones, breaker, hits log, veto ledger, audit log.
 * __dirname is the temp backend dir, so trade_log.json is a SYNTHETIC ledger written there. A guard throws if the handler's fs tries to
 * write outside the temp dir. The real gate libs (enforcement-gates, seat-authority, entry-ml, cost-size, act-policy, scanner-stamp)
 * are required from backend/lib and only READ data (checked: none of them writes a file).
 *   node harness-breaker.cjs                  staged server + staged lib/risk-policy.js   (expects every check to PASS)
 *   node harness-breaker.cjs --live           live server + live lib/risk-policy.js       (shows the defects: some checks FAIL by design)
 *   node harness-breaker.cjs --deployed       live server + live lib (after deploy: expects PASS — deploy.cjs runs this)
 * Exit 0 only when every check passes.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), Module = require("module");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..", ".."), B = path.join(REPO, "backend");
const LIVE = process.argv.includes("--live"), DEPLOYED = process.argv.includes("--deployed");
const SERVER = (LIVE || DEPLOYED) ? path.join(B, "traids-server-v2.js") : path.join(PKG, "staged", "backend", "traids-server-v2.js");
const RPFILE = (LIVE || DEPLOYED) ? path.join(B, "lib", "risk-policy.js") : path.join(PKG, "staged", "backend", "lib", "risk-policy.js");
const SRC = fs.readFileSync(SERVER, "utf8");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ops-breaker-harness-")), TB = path.join(TMP, "backend"), TD = path.join(TB, "data");
fs.mkdirSync(TD, { recursive: true });
const inTmp = (p) => path.resolve(String(p)).toLowerCase().startsWith(path.resolve(TMP).toLowerCase() + path.sep);
const guard = (name) => (...a) => { if (!inTmp(a[0])) throw new Error(`HARNESS GUARD: ${name} outside temp dir: ${a[0]}`); return fs[name](...a); };
const sfs = { ...fs, writeFileSync: guard("writeFileSync"), appendFileSync: guard("appendFileSync"), unlinkSync: guard("unlinkSync"), mkdirSync: guard("mkdirSync"), copyFileSync: guard("copyFileSync"),
  renameSync: (a, b) => { if (!inTmp(a) || !inTmp(b)) throw new Error("HARNESS GUARD: rename outside temp dir"); return fs.renameSync(a, b); } };
const AW = require(path.join(B, "lib", "atomic-write.js"));
const __atomicText = (f, t) => { if (!inTmp(f)) throw new Error("HARNESS GUARD: atomic write outside temp dir: " + f); return AW.writeTextAtomic(f, t); };
const breq = Module.createRequire(path.join(B, "harness-anchor.js"));
const cut = (start, end, { inclusive = true, from = 0 } = {}) => {
  const a = SRC.indexOf(start, from); if (a < 0) throw new Error("slice start not found: " + start.slice(0, 60));
  const b = SRC.indexOf(end, a + start.length); if (b < 0) throw new Error("slice end not found: " + end.slice(0, 60));
  return SRC.slice(a, inclusive ? b + end.length : b);
};
const helpersRead = cut("const readJsonFile = ", "p.dollarPerPoint * p.entry > 50000;");
const helpersAudit = cut("const auditLine = ", "\nconst portfolioRisk", { inclusive: false });
const postAt = SRC.indexOf('app.post("/api/board-positions"'); if (postAt < 0) throw new Error("board POST not found");
const routesAt = SRC.indexOf("const portfolioRisk = "); if (routesAt < 0 || routesAt > postAt) throw new Error("portfolioRisk block not found before the board POST");
const routes = SRC.slice(routesAt, SRC.indexOf("\n}));", postAt) + "\n}));".length);   // portfolioRisk .. /api/circuit-breaker .. the board POST handler
const P = { BOARD_POS_PATH: path.join(TD, "board_positions.json"), BOARD_TOMBS_PATH: path.join(TD, "board_tombstones.json"), BREAKER_PATH: path.join(TD, "circuit-breaker.json"),
  AUDIT_LOG: path.join(TMP, "audit.log"), VETO_LEDGER_PATH: path.join(TD, "veto-shadows.json") };
const realRP = require(RPFILE);
const CS = require(path.join(B, "lib", "cost-size.js")), AP = require(path.join(B, "lib", "act-policy.js")), SS = require(path.join(B, "lib", "scanner-stamp.js"));
const mkApp = (RP) => {
  const get = {}, post = {}; const app = { get: (r, ...f) => { get[r] = f[f.length - 1]; }, post: (r, ...f) => { post[r] = f[f.length - 1]; } };
  const body = `const { BOARD_POS_PATH, BOARD_TOMBS_PATH, BREAKER_PATH, AUDIT_LOG, VETO_LEDGER_PATH } = P;\n${helpersRead}\n${helpersAudit}\n${routes}`;
  new Function("app", "rateLimit", "wrap", "fs", "path", "__dirname", "require", "RP", "CS", "AP", "SS", "__atomicText", "P", "console", body)(
    app, () => (q, s, n) => n(), (fn) => fn, sfs, path, TB, breq, RP, CS, AP, SS, __atomicText, P, { ...console, log: () => {}, warn: () => {} });
  return { get, post };
};
const call = async (h, b, query = {}) => { const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } }; await h({ body: b, query, ip: "h" }, res); return res; };
const rd = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };
const lines = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean); } catch { return []; } };
const results = []; const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const now = Date.now(), today = etDay(now), stake = realRP.policyStakePct("Equity");
let seq = 0;
const SYMS = ["AAPL", "MSFT", "JPM", "XOM", "UNH", "HD", "PG", "KO", "CAT", "NEE", "AMT", "LIN", "NFLX", "COST", "ABBV", "MRK", "GS", "BA", "DE", "ORCL"];
const tk = (riskDollars, extra = {}) => { const sym = SYMS[seq % SYMS.length]; seq++; return { id: `${now}-Equity-${sym}-h${seq}`, cls: "Equity", sym, dir: 1, addedAt: now - 60000, entry: 100, stop: 98, stopDist: 2, target: 104,
  riskDollars, units: riskDollars / 2, dollarPerPoint: riskDollars / 2, riskPctApplied: stake, riskPctConfigured: stake, strategy: "Ensemble", obs: {}, ...extra }; };
const ctl = (t) => ({ ...JSON.parse(JSON.stringify(t)), id: t.id + "c", ctrl: true, ctrlRand: true, strategy: "ctrl-coinflip", pairId: t.id });
const reset = ({ book = [], log = [], breaker = null } = {}) => {
  for (const f of fs.readdirSync(TD)) fs.rmSync(path.join(TD, f), { force: true }); try { fs.rmSync(P.AUDIT_LOG, { force: true }); } catch {}
  fs.writeFileSync(P.BOARD_POS_PATH, JSON.stringify(book)); fs.writeFileSync(P.BOARD_TOMBS_PATH, "[]"); fs.writeFileSync(P.VETO_LEDGER_PATH, "[]");
  fs.writeFileSync(path.join(TD, "trade_log.json"), JSON.stringify(log)); if (breaker) fs.writeFileSync(P.BREAKER_PATH, JSON.stringify(breaker));
};
const HITS = path.join(TD, "circuit-breaker-hits.jsonl");

(async () => {
  console.log(`server ${path.relative(REPO, SERVER)} · risk-policy ${path.relative(REPO, RPFILE)} (${realRP.RISK_POLICY.version}) · temp ${TMP}\n`);
  const A = mkApp(realRP);
  const POST = A.post["/api/board-positions"], CB = A.get["/api/circuit-breaker"], PR = A.get["/api/portfolio-risk"];

  // ── S1: controls are not exposure. 10 signals ($2,500) + 92 controls ($23,000) open = $25,500 gross; a batch of 12 more controls. ──
  { const sigs = Array.from({ length: 10 }, () => tk(250)), ctrls = Array.from({ length: 92 }, () => ctl(tk(250)));
    const yesterday = etDay(now - 864e5);
    reset({ book: [...sigs, ...ctrls], breaker: { date: yesterday, halted: true, since: "x", reason: "old", refusedToday: 0, wouldRefuseToday: 1739, events: [] } });
    const batch = Array.from({ length: 12 }, () => ctl(tk(250)));
    const r = await call(POST, { positions: [...sigs, ...ctrls, ...batch] });
    const b = rd(P.BREAKER_PATH, {});
    check("S1a controls (92 open = $23,000 + 12 incoming) do not trip the breaker; the gross book alone is over the ceiling", r.body && r.body.breaker && r.body.breaker.observedHalt === false && !b.halted, `observedHalt ${r.body?.breaker?.observedHalt} · ${b.reason || "no reason"}`);
    check("S1b wouldRefuseToday resets at the ET date change (was 1739 on the previous date)", b.date === today && b.wouldRefuseToday === 0, `date ${b.date} wouldRefuseToday ${b.wouldRefuseToday}`);
    check("S1c the closing day is kept in bst.days", Array.isArray(b.days) && b.days.length === 1 && b.days[0].date === yesterday && b.days[0].wouldRefuse === 1739, JSON.stringify(b.days || null).slice(0, 120));
    const pr = await call(PR, {}); const cb = await call(CB, {});
    check("S1d /api/portfolio-risk keeps the GROSS view (controls counted, no basis key)", pr.body && pr.body.openTickets === 114 && pr.body.worstCaseOpenCurrentEpoch >= 25000 && !("basis" in pr.body), `openTickets ${pr.body?.openTickets} worstCaseOpen ${pr.body?.worstCaseOpen}`);
    check("S1e /api/circuit-breaker.live is the breaker's own view; liveGrossBook carries the gross one", cb.body && cb.body.live && cb.body.liveGrossBook && cb.body.live.halted === false, `live ${JSON.stringify(cb.body?.live?.halted)} gross ${JSON.stringify(cb.body?.liveGrossBook?.halted)}`);
  }

  // ── S2: the batch that crosses the ceiling is named. Book: 96 signals x $250 = $24,000. Batch: +250, ctrl, +500 (24,750), +300 (25,050 BREACH), ctrl, +250. ──
  const breachScenario = () => {
    const book = Array.from({ length: 96 }, () => tk(250));
    const a = tk(250, { addedAt: now }), b2 = tk(500, { addedAt: now }), c = tk(300, { addedAt: now }), d = tk(250, { addedAt: now });
    return { book, batch: [a, ctl(a), b2, c, ctl(c), d], a, b2, c, d };
  };
  { const S = breachScenario(); reset({ book: S.book });
    const r = await call(POST, { positions: [...S.book, ...S.batch] });
    const b = rd(P.BREAKER_PATH, {}), ev = (b.events || [])[0] || {}, hits = lines(HITS).map((l) => JSON.parse(l)), audit = fs.existsSync(P.AUDIT_LOG) ? fs.readFileSync(P.AUDIT_LOG, "utf8") : "";
    check("S2a the breaching batch halts THIS post (observe: WOULD-HALT recorded now, not on the next POST)", b.halted === true && ev.type === "WOULD-HALT" && ev.batchBreach && ev.batchBreach.id === S.c.id, `event ${JSON.stringify(ev).slice(0, 160)}`);
    check("S2b the hits are the breaching ticket and every new ticket after it (3), in posting order", JSON.stringify(hits.map((h) => h.id)) === JSON.stringify([S.c.id, S.c.id + "c", S.d.id]) && b.wouldRefuseToday === 3, `hits ${hits.map((h) => h.sym + (h.ctrl ? "c" : "")).join(",")} · wouldRefuseToday ${b.wouldRefuseToday}`);
    check("S2c observe mode refuses nothing: every ticket is saved", r.body.refused.length === 0 && r.body.saved === S.book.length + S.batch.length, `saved ${r.body.saved} refused ${r.body.refused.length}`);
    check("S2d the audit log names the would-refuse tickets; the reason keeps 'ceiling $25000' (R304's parser)", /WOULD be refused if enforced: .*\(ctrl\)/.test(audit) && /ceiling \$25000/.test(b.reason) && /signals only/.test(b.reason), (b.reason || "").slice(0, 140));
    check("S2e hits rows carry date, mode, basis, policyVersion", hits.length === 3 && hits.every((h) => h.date === today && h.mode === "observe" && h.basis === "signals" && h.policyVersion === realRP.RISK_POLICY.version && h.enforced === false));
    check("S2f response carries hitsThisPost (append-only key)", r.body.breaker.hitsThisPost === 3 && r.body.breaker.basis === "signals");
    // ── S3: sticky for the session: the next POST's new ticket is a hit too ──
    const e = tk(100, { addedAt: now }); const r3 = await call(POST, { positions: [...S.book, ...S.batch, e] }); const b3 = rd(P.BREAKER_PATH, {});
    check("S3 the halt is day-sticky: a later new ticket is a hit (counted once)", b3.wouldRefuseToday === 4 && lines(HITS).length === 4 && JSON.parse(lines(HITS)[3]).id === e.id && r3.body.breaker.hitsThisPost === 1, `wouldRefuseToday ${b3.wouldRefuseToday}`);
    // ── S4: the dry run moves nothing ──
    const before = fs.readFileSync(P.BREAKER_PATH, "utf8"), hitsBefore = lines(HITS).length, auditBefore = fs.readFileSync(P.AUDIT_LOG, "utf8");
    const f = tk(100, { addedAt: now }); const r4 = await call(POST, { positions: [f, ctl(f)] }, { dryRun: "1" });
    check("S4 dry run: breaker file, hits log and audit log untouched; the response shows the hit", fs.readFileSync(P.BREAKER_PATH, "utf8") === before && lines(HITS).length === hitsBefore && fs.readFileSync(P.AUDIT_LOG, "utf8") === auditBefore && r4.body.dryRun && r4.body.breaker.hitsThisPost === 2, `hitsThisPost ${r4.body?.breaker?.hitsThisPost}`);
  }

  // ── S5: enforce mode refuses from the breaching ticket on (and nothing before it) ──
  { const S = breachScenario(); reset({ book: S.book });
    const RPe = { ...realRP, RISK_POLICY: { ...realRP.RISK_POLICY, breakerMode: "enforce" } }, Ae = mkApp(RPe);
    const r = await call(Ae.post["/api/board-positions"], { positions: [...S.book, ...S.batch] });
    const ids = (r.body.refused || []).map((x) => x.id), board = rd(P.BOARD_POS_PATH, []), b = rd(P.BREAKER_PATH, {});
    check("S5 enforce: the breaching ticket, its control and the later ticket are refused; the earlier ones are booked", JSON.stringify(ids) === JSON.stringify([S.c.id, S.c.id + "c", S.d.id]) && board.some((p) => p.id === S.b2.id) && !board.some((p) => p.id === S.c.id) && b.refusedToday === 3 && (b.wouldRefuseToday || 0) === 0 && lines(HITS).every((l) => JSON.parse(l).enforced === true), `refused ${ids.length} · refusedToday ${b.refusedToday}`);
  }

  // ── S6: the realized side counts signals only ──
  { const closedToday = new Date(now - 3600e3).toISOString();
    const row = (pnl, extra = {}) => ({ id: `r${++seq}`, cls: "Equity", sym: "X", pnl, rMult: pnl / 250, closedAt: closedToday, openedAt: now - 7200e3, ...extra });
    reset({ log: [row(-1000, { ctrl: true }), row(-1000, { ctrl: true }), row(-1000, { ctrl: true }), row(-500)] });
    const t = tk(250, { addedAt: now }); const r = await call(POST, { positions: [t, ctl(t)] }); const b = rd(P.BREAKER_PATH, {});
    check("S6a realized -$3,500 of which -$3,000 is controls: no halt (signals -$500)", !b.halted && r.body.breaker.observedHalt === false, b.reason || "clear");
    reset({ log: [row(-1000, { ctrl: true }), row(-2100)] });
    const t2 = tk(250, { addedAt: now }); await call(POST, { positions: [t2, ctl(t2)] }); const b2 = rd(P.BREAKER_PATH, {});
    check("S6b signals realized -$2,100: halt on the realized leg, every new ticket is a hit", b2.halted && /realized day P&L \$-2100 <= -\$2000 — signals only/.test(b2.reason) && b2.wouldRefuseToday === 2, b2.reason);
  }

  // ── S7: OP8 / OP10 shadow-on-entry tickets add no exposure ──
  { const book = Array.from({ length: 96 }, () => tk(250)); reset({ book });
    const fx = { ...tk(3000, { addedAt: now }), cls: "FX", sym: "EURUSD", riskPctApplied: realRP.policyStakePct("FX"), id: `${now}-FX-EURUSD-h${++seq}` };
    const tr = tk(3000, { addedAt: now, strategy: "Trend" });
    const r = await call(POST, { positions: [...book, fx, tr] }); const b = rd(P.BREAKER_PATH, {});
    const off = (realRP.RISK_POLICY.boardClassesOff || []).includes("FX") && (realRP.RISK_POLICY.boardStrategiesOff || []).includes("Trend");
    check("S7 an FX signal (OP8) and a Trend signal (OP10) of $3,000 each do not breach a $24,000 book", off && !b.halted && r.body.breaker.observedHalt === false, `halted ${b.halted}`);
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  const fails = results.filter((x) => !x.ok).length;
  console.log(`\n${fails ? "FAIL" : "PASS"} — ${results.length - fails}/${results.length} checks${LIVE ? " (LIVE files: failures here document the defects)" : ""}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.stack || e.message); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(1); });
