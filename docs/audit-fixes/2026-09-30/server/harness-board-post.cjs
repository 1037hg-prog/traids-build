#!/usr/bin/env node
// 2026-10-01 audit (cost#1, entry#1, entry#3, frontend#3): scratch harness for the PREPARED board/trade-log POST handlers.
// It slices the two handlers and their module-level helpers out of a server file (default: backend/traids-server-v2.pending-0930.js;
// --live runs the same scenarios on backend/traids-server-v2.js to show the defects), evaluates them with a fake `app` (no port is bound,
// no scheduler starts), and points EVERY write at a temp directory: board, tombstones, breaker, veto ledger, audit log, trade log. A guard
// throws if anything tries to write outside that directory. notify() is stubbed (nothing is sent). The real data files are read only:
// trade_log.json (RP.aggregate), the frozen R56 model, the universe, act-policy.json, entry-ml config, quarantine ids, news stamps.
// Usage: node docs/audit-fixes/2026-09-30/server/harness-board-post.cjs [--live]
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), Module = require("module");
const ROOT = path.resolve(__dirname, "..", "..", "..", ".."), B = path.join(ROOT, "backend");
const LIVE = process.argv.includes("--live");
const SRC = fs.readFileSync(path.join(B, LIVE ? "traids-server-v2.js" : "traids-server-v2.pending-0930.js"), "utf8");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "traids-board-harness-"));
const inTmp = (p) => path.resolve(String(p)).startsWith(path.resolve(TMP));
const guard = (name) => (...a) => { if (!inTmp(a[0])) throw new Error(`HARNESS GUARD: ${name} outside temp dir: ${a[0]}`); return fs[name](...a); };
const sfs = { ...fs, writeFileSync: guard("writeFileSync"), appendFileSync: guard("appendFileSync"), unlinkSync: guard("unlinkSync"), mkdirSync: guard("mkdirSync"), copyFileSync: guard("copyFileSync"),
  renameSync: (a, b) => { if (!inTmp(a) || !inTmp(b)) throw new Error("HARNESS GUARD: rename outside temp dir"); return fs.renameSync(a, b); } };
const AW = require(path.join(B, "lib", "atomic-write.js"));
const __atomicText = (f, t) => { if (!inTmp(f)) throw new Error("HARNESS GUARD: atomic write outside temp dir: " + f); return AW.writeTextAtomic(f, t); };
const notes = []; const notifyStub = { notify: async (title, msg) => { notes.push(`${title}: ${msg}`); return true; } };
const breq = Module.createRequire(path.join(B, "harness-anchor.js"));
const hreq = (id) => (id === "./notify.js" ? notifyStub : breq(id));
const cut = (start, endMarker, { optional = false, inclusive = true } = {}) => {
  const a = SRC.indexOf(start); if (a < 0) { if (optional) return ""; throw new Error("slice start not found: " + start.slice(0, 60)); }
  const b = SRC.indexOf(endMarker, a + start.length); if (b < 0) throw new Error("slice end not found: " + endMarker.slice(0, 60));
  return SRC.slice(a, inclusive ? b + endMarker.length : b);
};
const helpersVeto = cut("const VETO_PENDING_PATH", "const readJsonFile = ", { optional: true, inclusive: false })
  .replace('const VETO_PENDING_PATH = path.join(__dirname, "data", "veto-shadows.pending.jsonl");', "const VETO_PENDING_PATH = P.VETO_PENDING_PATH;");   // the parked-row file goes to temp too
const helpersRead = cut("const readJsonFile = ", "p.dollarPerPoint * p.entry > 50000;");
const helpersAudit = cut("const auditLine = ", "\nconst portfolioRisk", { inclusive: false });
const hTrade = cut('app.post("/api/tradelog"', "\n}));");
const hBoard = cut('app.post("/api/board-positions"', "\n}));");
const P = { VETO_LEDGER_PATH: path.join(TMP, "veto-shadows.json"), BOARD_POS_PATH: path.join(TMP, "board_positions.json"), BOARD_TOMBS_PATH: path.join(TMP, "board_tombstones.json"),
  BREAKER_PATH: path.join(TMP, "circuit-breaker.json"), AUDIT_LOG: path.join(TMP, "audit.log"), TRADELOG_PATH: path.join(TMP, "trade_log.json"), VETO_PENDING_PATH: path.join(TMP, "veto-shadows.pending.jsonl") };
if (helpersVeto && !helpersVeto.includes("P.VETO_PENDING_PATH")) throw new Error("could not redirect VETO_PENDING_PATH to the temp dir");
const realRP = require(path.join(B, "lib", "risk-policy.js"));
let forceHalt = null;   // when set, RP.aggregate reports this breaker halt (scenario G)
const RP = { ...realRP, aggregate: (...a) => { const r = realRP.aggregate(...a); return forceHalt ? { ...r, breaker: { ...r.breaker, halted: true, reason: forceHalt() } } : r; } };
const CS = require(path.join(B, "lib", LIVE ? "cost-size.js" : "cost-size.pending-0930.js")), AP = require(path.join(B, "lib", "act-policy.js")), SS = require(path.join(B, "lib", "scanner-stamp.js"));
const routes = {}; const app = { post: (r, ...fns) => { routes[r] = fns[fns.length - 1]; } };
const body = `const { VETO_LEDGER_PATH, BOARD_POS_PATH, BOARD_TOMBS_PATH, BREAKER_PATH, AUDIT_LOG, TRADELOG_PATH } = P;\n${helpersVeto}\n${helpersRead}\n${helpersAudit}\n${hTrade}\n${hBoard}`;
new Function("app", "rateLimit", "wrap", "fs", "path", "__dirname", "require", "RP", "CS", "AP", "SS", "__atomicText", "P", "console", body)(
  app, () => (q, s, n) => n(), (fn) => fn, sfs, path, B, hreq, RP, CS, AP, SS, __atomicText, P, { ...console, warn: (...a) => notes.push("warn: " + a.join(" ")), error: (...a) => notes.push("error: " + a.join(" ")) });
const call = async (route, b, query = {}) => { const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } }; await routes[route]({ body: b, query, path: route, ip: "h" }, res, (e) => { throw e; }); return res; };
const rdT = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };
const clone = (x) => JSON.parse(JSON.stringify(x));
const results = []; const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

(async () => {
  console.log(`server file: ${LIVE ? "LIVE backend/traids-server-v2.js" : "PREPARED backend/traids-server-v2.pending-0930.js"} · temp dir ${TMP}\n`);
  const now = Date.now(), stake = realRP.policyStakePct("Equity");
  // a priced, predictable equity signal (AAPL is in the universe) + its control twin + an FX signal OP8 turns into a veto shadow
  const sig = { id: `${now}-Equity-AAPL-hns1`, cls: "Equity", sym: "AAPL", dir: 1, addedAt: now, entry: 200, stop: 196, stopDist: 4, target: 208, riskDollars: 250, units: 62.5, dollarPerPoint: 62.5,
    riskPctApplied: stake, riskPctConfigured: stake, strategy: "Ensemble", obs: { atr14: 4, volRatio: 1.1, clientStamp: "kept" } };
  const twin = { ...clone(sig), id: `${now}-Equity-AAPL-hns1c`, ctrl: true, ctrlRand: true, pairId: sig.id };
  const fx = { id: `${now}-FX-EURUSD-hns2`, cls: "FX", sym: "EURUSD", dir: -1, addedAt: now, entry: 1.1, stop: 1.11, stopDist: 0.01, riskDollars: 75, units: 7500, dollarPerPoint: 7500, riskPctApplied: realRP.policyStakePct("FX"), obs: {} };
  const tab = [clone(sig), clone(twin), clone(fx)];          // what the posting tab holds — it never learns the server's entry changes
  // the ledger has existed since 08-27: seed the temp copy from the real one (read-only copy; the real file is never written)
  fs.writeFileSync(P.VETO_LEDGER_PATH, fs.readFileSync(path.join(B, "data", "veto-shadows.json"), "utf8"));
  const seeded = rdT(P.VETO_LEDGER_PATH, []).length;

  // ── A: first post (the batch) ──
  let r = await call("/api/board-positions", { positions: clone(tab) });
  let board = rdT(P.BOARD_POS_PATH, []), s1 = board.find((p) => p.id === sig.id);
  check("A1 batch accepted and stamped server-side (era, cost stamp)", s1 && s1.era === "v4" && Number.isFinite(s1.obs?.costSizeMult), s1 && `era ${s1.era} costSizeMult ${s1.obs?.costSizeMult} riskDollars ${s1.riskDollars} units ${s1.units} stop ${s1.stop}`);
  const serverCopy = clone(s1);
  if (!LIVE) check("A2 srvStamp records the entry pass's changes with the client's pre-images", s1.srvStamp && s1.srvStamp.keys.includes("era") && s1.srvStamp.obsKeys.includes("costSizeMult"), s1.srvStamp && `keys ${JSON.stringify(s1.srvStamp.keys)} pre ${JSON.stringify(s1.srvStamp.pre)} obsKeys ${s1.srvStamp.obsKeys.length}`);
  if (!LIVE) check("A3 response returns the stamped fields per id", Array.isArray(r.body.stamped) && r.body.stamped.some((x) => x.id === sig.id && x.set.era === "v4"), `stamped ${r.body.stamped && r.body.stamped.length} row(s)`);
  { const l = rdT(P.VETO_LEDGER_PATH, []); check("A4 OP8 vetoed the FX signal; the ledger appended it and kept every seeded row", l.some((v) => v.id === fx.id) && l.length === seeded + 1, `gateVetoes ${JSON.stringify(r.body.gateVetoes.map((v) => v.test))} · ledger ${seeded} -> ${l.length}`); }

  // ── B: the tab re-posts its stale copies (an exit-monitor alert flip) ──
  const tabB = clone(tab); tabB[0].alerted = true;
  r = await call("/api/board-positions", { positions: tabB });
  board = rdT(P.BOARD_POS_PATH, []); const s2 = board.find((p) => p.id === sig.id), f2 = board.find((p) => p.id === fx.id), t2 = board.find((p) => p.id === twin.id);
  const keptAll = s2 && s2.era === serverCopy.era && JSON.stringify(s2.obs) === JSON.stringify(serverCopy.obs) && s2.riskDollars === serverCopy.riskDollars && s2.units === serverCopy.units && s2.stop === serverCopy.stop && s2.dollarPerPoint === serverCopy.dollarPerPoint;
  check("B1 re-post of stale copies keeps every server-owned field (era, obs stamps, riskDollars, units, dpp, stop)", keptAll, s2 && `era ${s2.era} costSizeMult ${s2.obs?.costSizeMult} riskDollars ${s2.riskDollars} (server ${serverCopy.riskDollars}) units ${s2.units} stop ${s2.stop}`);
  check("B2 the client's real edit (alerted) and its own obs stamp survive", s2 && s2.alerted === true && s2.obs?.clientStamp === "kept");
  check("B3 control twin keeps era + scanner stamp; veto shadow keeps veto and era", t2 && t2.era === "v4" && f2 && f2.vetoShadow && f2.vetoAt && f2.era === "v4");

  // ── C: a client value that is neither the pre-image nor the server's is a real edit and wins ──
  const tabC = clone(tabB); tabC[0].stop = 195.5;
  await call("/api/board-positions", { positions: tabC });
  const s3 = rdT(P.BOARD_POS_PATH, []).find((p) => p.id === sig.id);
  check("C1 a real client edit (stop 195.5) wins over the server's value", s3 && s3.stop === 195.5 && s3.era === "v4", s3 && `stop ${s3.stop}`);

  // ── E: veto ledger — unreadable ledger refuses the rewrite, parks rows, alarms; good read merges them back ──
  const ledBefore = fs.readFileSync(P.VETO_LEDGER_PATH, "utf8"), truncated = ledBefore.slice(0, Math.floor(ledBefore.length / 2));
  fs.writeFileSync(P.VETO_LEDGER_PATH, truncated);
  const fx2 = { ...clone(fx), id: `${now}-FX-GBPUSD-hns3`, sym: "GBPUSD" };
  notes.length = 0; await call("/api/board-positions", { positions: [...clone(tabC), clone(fx2)] });
  const ledAfterBad = fs.readFileSync(P.VETO_LEDGER_PATH, "utf8"), pendPath = path.join(TMP, "veto-shadows.pending.jsonl");
  check("E1 an unreadable ledger is NOT rewritten (bytes unchanged)", ledAfterBad === truncated, LIVE ? `ledger now ${ledAfterBad.length} bytes, parse ${(() => { try { return JSON.parse(ledAfterBad).length + " rows"; } catch { return "fails"; } })()}` : "");
  if (!LIVE) {
    check("E2 the refused batch's veto row is parked append-only", fs.existsSync(pendPath) && fs.readFileSync(pendPath, "utf8").includes(fx2.id));
    check("E3 the failure is loud: audit line + notify (stubbed)", notes.some((n) => /veto ledger UNKNOWN/.test(n)) && fs.readFileSync(P.AUDIT_LOG, "utf8").includes("VETO-LEDGER UNKNOWN"), notes.filter((n) => /UNKNOWN/.test(n)).slice(0, 1).join(""));
    // F: trade-log re-stamp while the ledger is unreadable: the parked row still re-stamps, and the failure alarms
    notes.length = 0;
    const rT = await call("/api/tradelog", { log: [{ id: fx2.id, sym: "GBPUSD", cls: "FX", openedAt: new Date(now).toISOString(), closedAt: now + 1, rMult: 0.5, pnl: 10, entry: 1.1, exit: 1.105, dir: 1, vetoShadow: false }] });
    const tl = rdT(P.TRADELOG_PATH, []); const row = tl.find((t) => t.id === fx2.id);
    check("F1 trade-log write re-stamps from the parked row while the ledger is unreadable", rT.code === 200 && row && row.vetoShadow === true && row.ctrl === true, row && `veto ${row.veto}`);
    check("F2 the unreadable ledger at re-stamp time is loud (UNKNOWN)", notes.some((n) => /could not read the veto ledger/.test(n)));
    // repair the ledger -> the next veto merges the parked row back and removes the parked file
    fs.writeFileSync(P.VETO_LEDGER_PATH, ledBefore);
    const fx3 = { ...clone(fx), id: `${now}-FX-AUDUSD-hns4`, sym: "AUDUSD" };
    await call("/api/board-positions", { positions: [...clone(tabC), clone(fx2), clone(fx3)] });
    const led = rdT(P.VETO_LEDGER_PATH, null);
    check("E4 good read merges the parked row + the new one, keeps the old rows, removes the parked file", Array.isArray(led) && led.length === seeded + 3 && led.some((v) => v.id === fx.id) && led.some((v) => v.id === fx2.id) && led.some((v) => v.id === fx3.id) && !fs.existsSync(pendPath), led && `${led.length} rows (seeded ${seeded})`);
    // a MISSING ledger is UNKNOWN too (it has existed since 08-27): nothing is created from one batch
    fs.unlinkSync(P.VETO_LEDGER_PATH); notes.length = 0;
    const fx4 = { ...clone(fx), id: `${now}-FX-USDJPY-hns5`, sym: "USDJPY" };
    await call("/api/board-positions", { positions: [...clone(tabC), clone(fx2), clone(fx3), clone(fx4)] });
    check("E5 a missing ledger is not re-created from one batch; the row is parked and the failure alarms", !fs.existsSync(P.VETO_LEDGER_PATH) && fs.existsSync(pendPath) && fs.readFileSync(pendPath, "utf8").includes(fx4.id) && notes.some((n) => /ENOENT/.test(n)));
    fs.writeFileSync(P.VETO_LEDGER_PATH, JSON.stringify(led, null, 2));
  }

  // ── G: breaker — 5 dry-run probes with a live, unsaved halt (dollar figure moving), then a real post, then 3 more probes ──
  let k = 0; forceHalt = () => `current-epoch capped exposure $${29000 + 7 * (k++)} >= ceiling $25000 (25% of book)`;
  const n0 = (fs.existsSync(P.AUDIT_LOG) ? fs.readFileSync(P.AUDIT_LOG, "utf8") : "").split("\n").filter((l) => l.includes("CIRCUIT-BREAKER")).length;
  for (let i = 0; i < 5; i++) await call("/api/board-positions", { positions: [] }, { dryRun: "1" });
  const n1 = fs.readFileSync(P.AUDIT_LOG, "utf8").split("\n").filter((l) => l.includes("CIRCUIT-BREAKER")).length - n0;
  const dr = await call("/api/board-positions", { positions: [] }, { dryRun: "1" });
  await call("/api/board-positions", { positions: clone(tabC) });
  const n2 = fs.readFileSync(P.AUDIT_LOG, "utf8").split("\n").filter((l) => l.includes("CIRCUIT-BREAKER")).length - n0;
  for (let i = 0; i < 3; i++) await call("/api/board-positions", { positions: [] }, { dryRun: "1" });
  const n3 = fs.readFileSync(P.AUDIT_LOG, "utf8").split("\n").filter((l) => l.includes("CIRCUIT-BREAKER")).length - n0;
  check("G1 six dry-run probes over an unsaved halt write ONE audit line (the first sighting), not one per probe", n1 === 1, `probe lines ${n1}`);
  check("G2 the dry-run response still reports the halt", dr.body && dr.body.dryRun && dr.body.breaker && dr.body.breaker.halted === true);
  check("G3 the real post logs and saves the halt; later probes add nothing", n2 === 2 && n3 === 2 && rdT(P.BREAKER_PATH, {}).halted === true, `after real post ${n2}, after 3 more probes ${n3}`);
  forceHalt = null;

  const bad = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - bad}/${results.length} checks passed${bad ? ` — ${bad} FAILED` : ""}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("UNKNOWN — harness error:", e.stack || e.message); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { } process.exit(2); });
