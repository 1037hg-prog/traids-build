"use strict";
/**
 * FSTATE — the F#### namespace on the research server: its ONLY writer. 2026-10-09 (docs/server/wave6-agents; research engine stage 3).
 * Operator decision 2026-10-06: server-run tests get their own F#### ids in factory-registry.json / factory-seals.json /
 * factory-ledger.jsonl and the SERVER writes them alone; home stays the only writer of the four R files. These files live in
 * factory/state/ (traids:traids-research 2750): user traids (fcode.cjs) writes them, user scout (the agents) can read them and can
 * write nothing there. The home pull (deploy/server/w6-research-sync.cjs) checks owner + mode from the tar headers, the hash chain,
 * and that no F test, frozen field or seal ever changes or disappears.
 *
 *   factory-registry.json   { spec: "factory-registry-v1", tests: [entry] }            entry.regSha256 = sha256(canonical frozen spec)
 *   factory-seals.json      { spec: "factory-seals-v1", seals: { F0001: { sealedAt, verdict, ... } } }   one seal per F id, never changed
 *   factory-ledger.jsonl    one row per event; row.prev = sha256 of the previous line's exact text ("GENESIS" first);
 *                           every F id has exactly one {ev:"register"} row, every seal one {ev:"seal"} row
 * Writes: temp file + rename (mode 0640), the ledger appended + fsynced, all under state/.fstate.lock (exclusive create; a lock whose
 * pid is dead is replaced). An R id (R### or a bare number) is refused everywhere: the server never writes R governance.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const F_ID = /^F\d{4}(?:-[A-Z0-9]{1,12})?$/;
const REG_SPEC = "factory-registry-v1", SEAL_SPEC = "factory-seals-v1";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
/** the fields a registration freezes (pull-factory FROZEN_FIELDS plus every field the harness reads) */
const FROZEN = ["name", "hypothesis", "rule", "family", "multiplicityFamily", "familyMembers", "variantsInThisTest", "dataset", "universe", "entry", "rebalanceDays",
  "costBps", "statistic", "window", "minN", "mdeDailyBps", "controls", "decisionGates", "bar", "evidenceStart", "registered", "knownWeaknesses", "source"];
const canonical = (v) => (Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}" : JSON.stringify(v));
const frozenSpec = (e) => Object.fromEntries(FROZEN.filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
const regShaOf = (e) => sha(canonical(frozenSpec(e)));

function paths(stateDir) {
  return { dir: stateDir, reg: path.join(stateDir, "factory-registry.json"), seals: path.join(stateDir, "factory-seals.json"), ledger: path.join(stateDir, "factory-ledger.jsonl"), lock: path.join(stateDir, ".fstate.lock") };
}
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { if (e.code === "ENOENT") return d; throw new Error(`${path.basename(f)} unreadable: ${e.message}`); } };
function writeAtomic(f, text) { const t = `${f}.tmp-${process.pid}`; fs.writeFileSync(t, text, { mode: 0o640 }); const fd = fs.openSync(t, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(t, f); }
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** run fn under the state lock */
function withLock(stateDir, fn) {
  const P = paths(stateDir), body = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(P.lock, body, { flag: "wx", mode: 0o640 }); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      let j = null; try { j = JSON.parse(fs.readFileSync(P.lock, "utf8")); } catch { j = null; }
      if (!j || !pidAlive(j.pid)) { try { fs.unlinkSync(P.lock); } catch { /* raced */ } continue; }
      if (i > 200) throw new Error(`state lock held by pid ${j.pid} since ${j.at}`);
      const until = Date.now() + 50; while (Date.now() < until) { /* short spin: locks are held for milliseconds */ }
    }
  }
  try { return fn(P); } finally { try { const j = JSON.parse(fs.readFileSync(P.lock, "utf8")); if (j.pid === process.pid) fs.unlinkSync(P.lock); } catch { /* gone */ } }
}
/** ledger lines -> rows, verifying the hash chain; THROWS on a break (the state is never written on top of a broken chain) */
function readLedger(file) {
  let t = ""; try { t = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return { rows: [], lines: [], last: null }; throw e; }
  if (t && !t.endsWith("\n")) throw new Error("factory-ledger.jsonl: the last line has no newline (torn write) — REFUSED");
  const lines = t.split("\n"); lines.pop();
  const rows = lines.map((l, i) => { const r = JSON.parse(l); const want = i === 0 ? "GENESIS" : sha(Buffer.from(lines[i - 1], "utf8")); if (r.prev !== want) throw new Error(`factory-ledger.jsonl: hash chain broken at row ${i + 1}`); return r; });
  return { rows, lines, last: lines.length ? lines[lines.length - 1] : null };
}
function appendLedger(P, row) {
  const L = readLedger(P.ledger), line = JSON.stringify({ prev: L.last == null ? "GENESIS" : sha(Buffer.from(L.last, "utf8")), ...row });
  const fd = fs.openSync(P.ledger, "a", 0o640); try { fs.writeSync(fd, line + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return JSON.parse(line);
}
function loadAll(stateDir) {
  const P = paths(stateDir), reg = readJ(P.reg, { spec: REG_SPEC, tests: [] }), seals = readJ(P.seals, { spec: SEAL_SPEC, seals: {} });
  if (reg.spec !== REG_SPEC || !Array.isArray(reg.tests)) throw new Error("factory-registry.json is not factory-registry-v1");
  if (seals.spec !== SEAL_SPEC || !seals.seals || typeof seals.seals !== "object") throw new Error("factory-seals.json is not factory-seals-v1");
  return { P, reg, seals, ledger: readLedger(P.ledger) };
}
const nextId = (tests) => { const n = tests.map((t) => /^F(\d{4})/.exec(String(t.id))).filter(Boolean).map((m) => +m[1]); const k = (n.length ? Math.max(...n) : 0) + 1; if (k > 9999) throw new Error("F namespace exhausted"); return "F" + String(k).padStart(4, "0"); };
/**
 * Register one frozen spec. entry: every FROZEN field except registered (set here). Mints F#### under the lock, computes regSha256,
 * writes the registry, appends the register row. Idempotent per source.key: a second call for the same source returns the existing id.
 */
function register(stateDir, entry, { now = Date.now() } = {}) {
  return withLock(stateDir, (P) => {
    const { reg, ledger } = loadAll(stateDir);
    const key = entry.source && entry.source.key; if (!key) throw new Error("register: entry.source.key is required (idempotence)");
    const dup = reg.tests.find((t) => t.source && t.source.key === key); if (dup) return { id: dup.id, regSha256: dup.regSha256, existing: true };
    if (entry.id != null) throw new Error("register: the id is minted here, never supplied");
    const id = nextId(reg.tests), e = { id, ...entry, registered: new Date(now).toISOString(), status: "REGISTERED" };
    e.multiplicityFamily = `${e.family} — ${id}${(e.familyMembers || []).length ? " with " + e.familyMembers.join(", ") : ""} (research server F namespace)`;
    e.regSha256 = regShaOf(e);
    if (ledger.rows.some((r) => r.ev === "register" && r.id === id)) throw new Error(`register: the ledger already holds a register row for ${id} — REFUSED`);
    const next = { ...reg, tests: [...reg.tests, e] };
    writeAtomic(P.reg, JSON.stringify(next, null, 1) + "\n");
    appendLedger(P, { ev: "register", id, at: e.registered, regSha256: e.regSha256, family: e.family, key });
    return { id, regSha256: e.regSha256, existing: false, entry: e };
  });
}
/** a status change (not frozen): the registry entry's status + a ledger row */
function setStatus(stateDir, id, status, { now = Date.now(), note = null } = {}) {
  if (!F_ID.test(id)) throw new Error(`setStatus: ${id} is not an F id`);
  return withLock(stateDir, (P) => {
    const { reg } = loadAll(stateDir), i = reg.tests.findIndex((t) => t.id === id); if (i < 0) throw new Error(`setStatus: ${id} is not registered`);
    if (reg.tests[i].status === status) return false;
    const tests = reg.tests.slice(); tests[i] = { ...tests[i], status, statusAt: new Date(now).toISOString(), ...(note ? { statusNote: String(note).slice(0, 300) } : {}) };
    if (regShaOf(tests[i]) !== tests[i].regSha256) throw new Error(`setStatus: ${id}'s frozen spec no longer matches its regSha256 — REFUSED`);
    writeAtomic(P.reg, JSON.stringify({ ...reg, tests }, null, 1) + "\n");
    appendLedger(P, { ev: "status", id, at: new Date(now).toISOString(), status });
    return true;
  });
}
/** the ONE seal of an F id. Refused when already sealed, unregistered, or the frozen spec does not match its sha. */
function seal(stateDir, id, record, { now = Date.now() } = {}) {
  if (!F_ID.test(id)) throw new Error(`seal: ${id} is not an F#### id — the server never seals an R test`);
  return withLock(stateDir, (P) => {
    const { reg, seals } = loadAll(stateDir), e = reg.tests.find((t) => t.id === id);
    if (!e) throw new Error(`seal: ${id} is not registered`);
    if (seals.seals[id]) throw new Error(`seal: ${id} is already sealed (${seals.seals[id].verdict} ${seals.seals[id].sealedAt}) — one sealed read per F id`);
    if (regShaOf(e) !== e.regSha256) throw new Error(`seal: ${id}'s registration does not match its regSha256 — REFUSED`);
    if (!["PASS", "DID NOT PASS", "CANNOT MEASURE"].includes(record.verdict)) throw new Error(`seal: verdict ${record.verdict}`);
    const s = { sealedAt: new Date(now).toISOString(), regSha256: e.regSha256, ...record };
    writeAtomic(P.seals, JSON.stringify({ ...seals, seals: { ...seals.seals, [id]: s } }, null, 1) + "\n");
    appendLedger(P, { ev: "seal", id, at: s.sealedAt, verdict: s.verdict, recordSha: sha(canonical(s)) });
    return s;
  });
}

function selftest() {
  const os = require("os"); let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + String(d).slice(0, 300) : "")); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w6-fstate-")), err = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  try {
    const base = { name: "n", hypothesis: "h", rule: "r", family: "FAM-A", familyMembers: [], variantsInThisTest: 1, dataset: "eq-daily", universe: { kind: "all" }, entry: "close", rebalanceDays: 1, costBps: 10, statistic: { kind: "daily-portfolio", nwLag: 5 }, window: { from: "2016-01-04", to: "2026-09-22" }, minN: 250, mdeDailyBps: 5, controls: { blockDays: 5 }, decisionGates: ["t>=bar"], bar: { bar: 2 }, evidenceStart: "2016-01-04", knownWeaknesses: ["x"] };
    const a = register(tmp, { ...base, source: { key: "k1" } }, { now: Date.parse("2026-10-15T05:00:00Z") });
    const b = register(tmp, { ...base, family: "FAM-B", source: { key: "k2" } });
    ok("mint: F0001 then F0002, each with a regSha256 over the frozen spec; the same source key again returns the same id", a.id === "F0001" && b.id === "F0002" && /^[0-9a-f]{64}$/.test(a.regSha256) && register(tmp, { ...base, source: { key: "k1" } }).id === "F0001");
    const L = readLedger(paths(tmp).ledger);
    ok("ledger: GENESIS, then each row's prev = sha256 of the previous line; one register row per id", L.rows.length === 2 && L.rows[0].prev === "GENESIS" && L.rows[1].prev === sha(Buffer.from(L.lines[0], "utf8")) && L.rows.every((r) => r.ev === "register"));
    ok("a supplied id or an R-shaped id is refused", /minted here/.test(err(() => register(tmp, { ...base, id: "R999", source: { key: "k3" } })) || "") && /not an F#### id/.test(err(() => seal(tmp, "R313", { verdict: "PASS" })) || ""));
    ok("status: changes the status and appends a status row; the frozen spec still matches", setStatus(tmp, "F0001", "BUILDING") === true && loadAll(tmp).reg.tests[0].status === "BUILDING" && regShaOf(loadAll(tmp).reg.tests[0]) === a.regSha256);
    const s = seal(tmp, "F0001", { verdict: "DID NOT PASS", stats: { t: 0.4 } });
    ok("seal: once; a second seal of the same id is refused; the seal row carries the record's sha", s.verdict === "DID NOT PASS" && /already sealed/.test(err(() => seal(tmp, "F0001", { verdict: "PASS" })) || "") && readLedger(paths(tmp).ledger).rows.filter((r) => r.ev === "seal").length === 1);
    const R = JSON.parse(fs.readFileSync(paths(tmp).reg, "utf8")); R.tests[1].rule = "rewritten"; fs.writeFileSync(paths(tmp).reg, JSON.stringify(R));
    ok("a frozen field edited behind the writer's back: the seal refuses on the regSha256 mismatch", /does not match its regSha256/.test(err(() => seal(tmp, "F0002", { verdict: "PASS" })) || ""));
    fs.appendFileSync(paths(tmp).ledger, JSON.stringify({ prev: "0".repeat(64), ev: "x" }) + "\n");
    ok("a broken ledger chain: every later write refuses", /hash chain broken/.test(err(() => register(tmp, { ...base, source: { key: "k9" } })) || ""));
    ok("files are written 0640-or-stricter (the pull refuses a group/other-writable F file)", process.platform === "win32" || (fs.statSync(paths(tmp).reg).mode & 0o022) === 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`fstate selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}
if (require.main === module) { if (process.argv[2] === "--selftest") process.exitCode = selftest() ? 0 : 1; else { console.log("fstate.cjs: library; --selftest"); process.exitCode = 2; } }
module.exports = { register, setStatus, seal, loadAll, readLedger, paths, regShaOf, frozenSpec, canonical, withLock, F_ID, FROZEN, REG_SPEC, SEAL_SPEC, sha };
