#!/usr/bin/env node
/**
 * W2B MANIFEST — the pull manifest of W2b (server migration plan v2 §W2b, the Schwab recorders), GENERATED at home for a rolling date
 * window, plus the chain's check that today's records reached home. 2026-10-09 (docs/server/wave2b-schwab). Installed at home as
 * deploy/server/w2b-manifest.cjs by docs/server/wave2b-schwab/deploy.cjs (step home); it writes deploy/server/manifests/w2b.json, which the
 * standing deploy/server/pull-server.cjs and own.cjs read (pull-manifest-v1; their code is not changed).
 *
 * WHY GENERATED. gex/ and options-flow/ grow ~12 MB per trading day (2026-10-09: options-flow ~7.2 MB a day, gex ~4.8 MB). A
 * dir-of-json entry would make every pull tar and send the whole history (and every dated file home holds must stay on the VPS). So the
 * manifest names each dated file of the window — 21 days back to 7 days ahead (ET), weekdays that are not market holidays — EXCEPT the
 * ones home already holds as final (a gex file present; an options-flow file present with complete: true). A pull then sends only what
 * home lacks (a json entry the VPS has not written is skipped), and the 7 days ahead keep a manifest left stale for a week correct.
 *   w2b-gex   gex/summary.jsonl (jsonl-prefix: append-only; seeded at the cutover) + gex/<day>-<open|close>-<SPX|SPY|QQQ>.json
 *             (json, seed false, frozenOnceSet date/slot/sym/at: a record home holds is never replaced by a different one)
 *   w2b-flow  options-flow/<day>.json (json, seed false; frozenOnceSet date/recordedAt — only date when home's copy is incomplete, so a
 *             complete VPS record may replace it)
 * THE INPUTS ARE NOT IN THE MANIFEST (2026-10-11). options-flow-record.js reads its universe from data/r147-earnings — the same names as
 * home — so the VPS needs home's files there, read-only. Named as manifest inputs, the standing push would send all of them in ONE remote
 * script (100 names on 2026-10-11: 12,251 characters), and a remote script travels as one ssh argument that arrives cut at about 8,190
 * (W3's first deploy, 2026-10-10). So this file pushes them itself, IN CHUNKS whose scripts stay under 5,000 characters (W3's w3-sync.cjs
 * chunksOf / shasOf / pushVerified), each chunk read back by sha256, mode 0444: pushInputs().
 * WHEN. The chain's "w2b pull window (W2b)" step (before "pull server files (w2b)") runs this file with no argument: it regenerates the
 * manifest and, while home's map gives w2b-flow to the SERVER, pushes the inputs that differ (home-owned: no ssh). deploy.cjs (its home
 * step and its cutover) and rollback.cjs --wave w2b (before the standing final pull) regenerate the manifest alone (--manifest-only);
 * the cutover pushes the inputs itself before it hands over. The manifest is rewritten only when its content changes.
 *
 * --verify (the chain step "w2b records at home (W2b)", after the pull): for each W2b unit the map gives to the SERVER, on a trading day
 *   after the close slot (15:56 ET): today's six gex files (open + close x SPX / SPY / QQQ) and options-flow/<today>.json must be at home,
 *   the flow record complete and recording exactly home's r147-earnings names. Exit 0 ok / home-owned / not a trading day · 1 FAIL (a
 *   record missing, a population mismatch, or the ownership unknown) · 3 WARN (the flow record is incomplete: R272 excludes the day).
 *
 *   node deploy/server/w2b-manifest.cjs            write the manifest for now, then push the inputs when w2b-flow is server-owned
 *                                                  (exit 0; 1 refused / the inputs push failed)
 *   node deploy/server/w2b-manifest.cjs --manifest-only   the manifest alone: never an ssh call
 *   node deploy/server/w2b-manifest.cjs --print    print it, write nothing
 *   node deploy/server/w2b-manifest.cjs --verify
 *   node deploy/server/w2b-manifest.cjs --selftest temp dirs only
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const findRepo = (from) => { for (let d = from; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, "backend", "data")) && fs.existsSync(path.join(d, "deploy", "server", "pull-server.cjs"))) return d; if (path.dirname(d) === d) return null; } };
const REPO = findRepo(__dirname);
const PS = require(path.join(REPO, "deploy", "server", "pull-server.cjs"));
const HOME_DATA = path.join(REPO, "backend", "data"), OUT = path.join(REPO, "deploy", "server", "manifests", "w2b.json");
const DATA = "/home/traids/traids/backend/data", BACKEND = "/home/traids/traids/backend", SHADOW_B = "/home/traids/w2b-shadow/backend";
const BACK_DAYS = 21, AHEAD_DAYS = 7, SLOTS = ["open", "close"], SYMS = ["SPX", "SPY", "QQQ"];
const NAME_RE = /^[A-Z0-9][A-Z0-9.-]{0,14}\.json$/;
let HOLIDAYS = {}; try { HOLIDAYS = require(path.join(REPO, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS || {}; } catch { HOLIDAYS = {}; }

const etParts = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return { day: `${p.year}-${p.month}-${p.day}`, mins: Number(p.hour) * 60 + Number(p.minute), wd: p.weekday }; };
const addDay = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const dow = (d) => new Date(d + "T12:00:00Z").getUTCDay();
const tradingDay = (d, hol = HOLIDAYS) => dow(d) !== 0 && dow(d) !== 6 && !hol[d];
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return undefined; } };

const UNIT_DEFS = {
  "w2b-gex": { lock: "w2b-gex.flock", steps: [], cadenceHours: 24, systemd: { service: "traids-gex.service", timer: "traids-gex.timer", shadowService: "traids-gex-shadow.service", shadowTimer: "traids-gex-shadow.timer" },
    code: ["gex-record.js", "lib/schwab-md.js", "lib/run-window.js", "lib/atomic-write.js", "own-check.cjs"] },
  "w2b-flow": { lock: "w2b-flow.flock", steps: [], cadenceHours: 24, systemd: { service: "traids-flow.service", timer: "traids-flow.timer", shadowService: "traids-flow-shadow.service", shadowTimer: "traids-flow-shadow.timer" },
    code: ["options-flow-record.js", "lib/schwab-md.js", "lib/run-window.js", "lib/atomic-write.js", "own-check.cjs"] },
};
/** home's r147-earnings names (the options-flow universe) -> sorted file names; throws when empty or a file does not parse */
function earningsFiles(homeData) {
  const dir = path.join(homeData, "r147-earnings");
  let names; try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch (e) { throw new Error(`data/r147-earnings unreadable at home (${e.code || e.message}) — REFUSED (the VPS's options-flow universe comes from it)`); }
  if (!names.length) throw new Error("data/r147-earnings is empty at home — REFUSED (options-flow would record no name)");
  const bad = names.filter((f) => !NAME_RE.test(f)); if (bad.length) throw new Error(`data/r147-earnings holds name(s) the pull cannot carry safely: ${bad.slice(0, 5).join(", ")} — REFUSED`);
  const torn = names.filter((f) => readJson(path.join(dir, f)) === undefined); if (torn.length) throw new Error(`data/r147-earnings/${torn[0]} does not parse at home — REFUSED (it is pushed to the VPS as an input)`);
  return names;
}
/** the manifest for `nowMs` against home's data (pure on the files it reads) */
function build({ homeData = HOME_DATA, nowMs = Date.now(), holidays = HOLIDAYS } = {}) {
  const today = etParts(nowMs).day, from = addDay(today, -BACK_DAYS), to = addDay(today, AHEAD_DAYS);
  const gex = [{ path: "gex/summary.jsonl", kind: "jsonl-prefix" }], flow = [];
  let held = 0;
  for (let d = from; d <= to; d = addDay(d, 1)) {
    if (!tradingDay(d, holidays)) continue;
    for (const slot of SLOTS) for (const sym of SYMS) {
      const rel = `gex/${d}-${slot}-${sym}.json`, j = readJson(path.join(homeData, ...rel.split("/")));
      if (j !== undefined) { held++; continue; }
      gex.push({ path: rel, kind: "json", seed: false, frozenOnceSet: ["date", "slot", "sym", "at"] });
    }
    const rel = `options-flow/${d}.json`, j = readJson(path.join(homeData, ...rel.split("/")));
    if (j && j.complete === true) { held++; continue; }
    flow.push({ path: rel, kind: "json", seed: false, frozenOnceSet: j ? ["date"] : ["date", "recordedAt"] });
  }
  const inputs = earningsFiles(homeData).length;   // checked here (an empty or torn universe refuses the manifest), pushed by pushInputs()
  const m = { schema: "pull-manifest-v1", wave: "w2b", title: "W2b Schwab recorders (gex-record.js / options-flow-record.js --schwab-md, the market-data-only app)",
    remoteData: DATA, remoteBackend: BACKEND, shadow: { backend: SHADOW_B, data: SHADOW_B + "/data" },
    generatedBy: "deploy/server/w2b-manifest.cjs (docs/server/wave2b-schwab)", window: { etDay: today, from, to, heldAtHome: held }, inputsPushedInChunks: { dir: "r147-earnings", files: inputs },
    units: { "w2b-gex": { ...UNIT_DEFS["w2b-gex"], entries: gex }, "w2b-flow": { ...UNIT_DEFS["w2b-flow"], entries: flow } } };
  PS.checkManifest(JSON.parse(JSON.stringify(m)), "w2b");   // the standing loader's own rules (throws on anything unsafe)
  return m;
}
/** the static part (everything but the generated entries / window) — what deploy.cjs's precheck compares */
const staticOf = (m) => ({ ...m, window: undefined, units: Object.fromEntries(Object.entries(m.units || {}).map(([u, d]) => [u, { ...d, entries: undefined }])) });
function write({ out = OUT, ...o } = {}) {
  const m = build(o), cur = readJson(out);
  if (cur && JSON.stringify(cur) === JSON.stringify(m)) return { changed: false, m };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  require(path.join(REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic(out, m);
  return { changed: true, m };
}
const summaryOf = (m) => { const g = m.units["w2b-gex"].entries, f = m.units["w2b-flow"].entries; return `window ${m.window.from}..${m.window.to} (ET ${m.window.etDay}): ${g.length - 1} gex + ${f.length} options-flow dated file(s) home lacks, ${m.window.heldAtHome} held at home; gex/summary.jsonl; ${m.inputsPushedInChunks.files} r147-earnings name(s) pushed apart, in chunks`; };

// ── the inputs: home's data/r147-earnings on the VPS, read-only, pushed IN CHUNKS (see the header) ───────────────────────────────
/** W3's chunk helpers (chunksOf / shasOf / pushVerified): beside this file once W3's home step installed them, else in W3's package */
function syncLib() {
  const tried = [path.join(__dirname, "w3-sync.cjs"), path.join(REPO, "deploy", "server", "w3-sync.cjs"), path.join(REPO, "docs", "server", "wave3-sleeves", "deploy-server", "w3-sync.cjs")];
  for (const f of tried) { if (!fs.existsSync(f)) continue; const m = require(f); if (["chunksOf", "shasOf", "pushVerified"].every((k) => typeof m[k] === "function")) return m; }
  throw new Error("the chunk helpers (w3-sync.cjs: chunksOf / shasOf / pushVerified) are neither in deploy/server nor in docs/server/wave3-sleeves/deploy-server");
}
/** home's r147-earnings as the VPS holds it: [{ rel: "r147-earnings/<name>.json", data, mode: "0444" }] (throws when empty or torn) */
const inputFiles = (homeData = HOME_DATA) => earningsFiles(homeData).map((f) => ({ rel: "r147-earnings/" + f, data: fs.readFileSync(path.join(homeData, "r147-earnings", f)), mode: "0444" }));
/**
 * push the inputs that differ to a VPS data dir, each chunk under the unit's flock and read back by sha256 (an ssh failure throws:
 * fail-closed) -> { files, pushed, current } or { busy: true, files, pushed } (the lock was held: what was sent is whole and verified).
 * A name removed at home is NOT removed on the VPS: the chain's "w2b records at home (W2b)" then FAILs on the other population.
 */
function pushInputs({ ssh, homeData = HOME_DATA, dir = DATA, lock = UNIT_DEFS["w2b-flow"].lock, sync = syncLib() } = {}) {
  const files = inputFiles(homeData), cur = sync.shasOf(ssh, dir, files.map((f) => f.rel)), todo = files.filter((f) => cur.get(f.rel) !== PS.sha(f.data));
  const r = sync.pushVerified(ssh, dir, todo, lock);
  return r.busy ? { busy: true, files: files.length, pushed: r.pushed || 0 } : { files: files.length, pushed: todo.length, current: files.length - todo.length };
}
/** the chain's part: push only while home's map gives w2b-flow to the SERVER -> { code, line } (0 ok / nothing to do · 1 failed) */
function chainInputs({ homeData = HOME_DATA, ssh = null } = {}) {
  const mr = PS.readMap(path.join(homeData, "host-ownership.json"));
  if (!mr.ok) return { code: 1, line: `inputs NOT pushed: ownership unknown (${mr.why}) — which host records options-flow is not known` };
  const owner = mr.map.units["w2b-flow"];
  if (owner !== "server") return { code: 0, line: owner === "home" ? "inputs: w2b-flow is home-owned — home reads its own data/r147-earnings; nothing pushed (no ssh)" : "inputs: host-ownership.json does not name w2b-flow — nothing pushed (no ssh)" };
  try {
    const r = pushInputs({ ssh: ssh || PS.sshReal("traids"), homeData });
    if (r.busy) return { code: 1, line: `inputs NOT all pushed: the w2b-flow lock on the VPS is held (${r.pushed} sent and verified) — the next run sends the rest` };
    return { code: 0, line: `inputs: ${r.files} r147-earnings name(s) on the VPS, read-only — ${r.pushed} pushed in chunks and read back, ${r.current} already current` };
  } catch (e) { return { code: 1, line: "inputs push FAILED: " + String(e.message).slice(0, 300) }; }
}
/**
 * a FAKE VPS for selftests (this file's and deploy.cjs's): files in memory, answering the standing machinery's two file commands — the
 * sha256 read (PS.remoteShas) and the verified push (PS.pushRemote: a ustar on stdin, each name listed with its sha256 and its mode).
 * fn returns null for any other command, for the caller's own fake to answer. busy: a function of the lock name -> true = exit 75.
 */
function fakeTreeVps({ busy = () => false } = {}) {
  const files = new Map(), modes = new Map(), calls = [];
  const fn = (script, o = {}) => {
    const sh = /^cd '([^']+)' \|\| exit 7; for f in (.+?); do if \[ -f/.exec(script);
    if (sh) { calls.push({ kind: "sha", dir: sh[1], script }); const names = [...sh[2].matchAll(/'([^']+)'/g)].map((m) => m[1]); return { ok: true, status: 0, out: names.map((n) => (files.has(sh[1] + "/" + n) ? `${PS.sha(files.get(sh[1] + "/" + n))}  ${n}` : `ABSENT  ${n}`)).join("\n") + "\n", err: "" }; }
    const pu = /^set -euo pipefail\nD='([^']+)'\n/.exec(script);
    if (pu && script.includes("<<'EOF_MV'\n")) {
      const lock = (/exec 9>>'([^']+)' && flock/.exec(script) || [])[1] || null; calls.push({ kind: "push", dir: pu[1], lock, script });
      if (lock && busy(lock)) return { ok: false, status: 75, out: "", err: "" };
      const got = new Map(PS.untar(Buffer.isBuffer(o.input) ? o.input : Buffer.from(String(o.input || ""), "latin1")).map((x) => [x.name, x.data]));
      const shas = new Map(script.split("<<'EOF_SHA'\n")[1].split("\nEOF_SHA")[0].split("\n").map((l) => [l.slice(66), l.slice(0, 64)]));
      const mv = script.split("<<'EOF_MV'\n")[1].split("\nEOF_MV")[0].split("\n").map((l) => [l.slice(0, 4), l.slice(5)]);
      for (const [, rel] of mv) if (!got.has(rel) || PS.sha(got.get(rel)) !== shas.get(rel)) return { ok: false, status: 1, out: "", err: `sha256sum: ${rel}: FAILED` };
      for (const [mode, rel] of mv) { files.set(pu[1] + "/" + rel, got.get(rel)); modes.set(pu[1] + "/" + rel, mode); }
      return { ok: true, status: 0, out: `PUSHED ${mv.length}\n`, err: "" };
    }
    return null;
  };
  return { fn, files, modes, calls };
}

/** the chain's check after the pull -> { code, lines } */
function verify({ homeData = HOME_DATA, nowMs = Date.now(), holidays = HOLIDAYS } = {}) {
  const mr = PS.readMap(path.join(homeData, "host-ownership.json"));
  if (!mr.ok) return { code: 1, lines: [`FAIL ownership unknown: ${mr.why} — nothing can be verified (the recorders may run on neither host)`] };
  const own = { gex: mr.map.units["w2b-gex"], flow: mr.map.units["w2b-flow"] };
  if (![own.gex, own.flow].every((h) => h === "home" || h === "server")) return { code: 1, lines: [`FAIL host-ownership.json does not name w2b-gex / w2b-flow (${JSON.stringify(own)}) — the intraday.bat gates read "unknown" and do not run them`] };
  if (own.gex === "home" && own.flow === "home") return { code: 0, lines: ["w2b-gex and w2b-flow are home-owned: home records them (intraday.bat; the close-arm backup) — nothing to verify"] };
  const t = etParts(nowMs);
  if (!tradingDay(t.day, holidays)) return { code: 0, lines: [`${t.day} is not a trading day — no record is due`] };
  if (t.mins < 15 * 60 + 56) return { code: 0, lines: [`${t.day} ${String(Math.floor(t.mins / 60)).padStart(2, "0")}:${String(t.mins % 60).padStart(2, "0")} ET: the close slot (15:30-15:55 ET) has not ended — nothing verified yet`] };
  const fails = [], warns = [], lines = [];
  if (own.gex === "server") {
    const miss = SLOTS.flatMap((s) => SYMS.map((y) => `gex/${t.day}-${s}-${y}.json`)).filter((rel) => readJson(path.join(homeData, ...rel.split("/"))) === undefined);
    if (miss.length) fails.push(`w2b-gex (server-owned): ${miss.length} of today's 6 gex records are not at home: ${miss.join(", ")} — the VPS missed the slot, or the pull did not bring them (node deploy/server/pull-server.cjs --status)`);
    else lines.push(`w2b-gex: today's 6 gex records (open + close, SPX / SPY / QQQ) are at home`);
  }
  if (own.flow === "server") {
    const rel = `options-flow/${t.day}.json`, j = readJson(path.join(homeData, ...rel.split("/")));
    let names = null; try { names = earningsFiles(homeData).map((f) => f.replace(/\.json$/, "")); } catch (e) { fails.push(e.message); }
    if (j === undefined) fails.push(`w2b-flow (server-owned): data/${rel} is not at home (the R272 record of today) — the VPS missed the slot, or the pull did not bring it`);
    else {
      const got = Object.keys((j && j.names) || {}).concat(Object.keys((j && j.errors) || {})).sort();
      if (names && JSON.stringify(got) !== JSON.stringify([...names].sort())) { const a = names.filter((n) => !got.includes(n)), b = got.filter((n) => !names.includes(n)); fails.push(`w2b-flow: the VPS recorded a different population than home's r147-earnings (${a.length} missing: ${a.slice(0, 6).join(", ")}; ${b.length} extra: ${b.slice(0, 6).join(", ")}) — an input did not reach the VPS, or one was removed at home`); }
      if (!j || j.complete !== true) warns.push(`w2b-flow: data/${rel} is INCOMPLETE (coverage ${j && j.coverage}) — R272 excludes the day (the VPS unit paged at 15:40 ET)`);
      if (!fails.length && !warns.length) lines.push(`w2b-flow: data/${rel} at home, complete (coverage ${j.coverage}), ${got.length} names = home's r147-earnings`);
    }
  }
  if (fails.length) return { code: 1, lines: [...lines, ...fails.map((x) => "FAIL " + x), ...warns.map((x) => "WARN " + x)] };
  if (warns.length) return { code: 3, lines: [...lines, ...warns.map((x) => "WARN " + x)] };
  return { code: 0, lines };
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + String(d).slice(0, 400) : "")); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w2b-manifest-"));
  try {
    const H = path.join(tmp, "data"), w = (rel, o) => { const f = path.join(H, ...rel.split("/")); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof o === "string" ? o : JSON.stringify(o)); };
    for (const s of ["AAPL", "MSFT", "BRK.B"]) w(`r147-earnings/${s}.json`, { sym: s });
    const gexDoc = (d, slot, sym, at) => ({ spec: "rows", at, date: d, slot, sym: sym === "SPX" ? "$SPX" : sym, rows: [["X", d, "C", 1, 10, 0.1]] });
    for (const d of ["2026-10-12", "2026-10-13"]) for (const s of SLOTS) for (const y of SYMS) w(`gex/${d}-${s}-${y}.json`, gexDoc(d, s, y, `${d}T14:00:00Z`));
    w("options-flow/2026-10-12.json", { date: "2026-10-12", recordedAt: "2026-10-12T19:40:00Z", complete: true, names: { AAPL: {}, MSFT: {}, "BRK.B": {} } });
    w("options-flow/2026-10-13.json", { date: "2026-10-13", recordedAt: "2026-10-13T19:40:00Z", complete: false, coverage: 0.5, names: { AAPL: {} } });
    w("gex/summary.jsonl", '{"date":"2026-10-12"}\n');
    const NOW = Date.parse("2026-10-14T22:15:00Z");   // Wed 18:15 ET
    const m = build({ homeData: H, nowMs: NOW });
    const G = m.units["w2b-gex"].entries, F = m.units["w2b-flow"].entries, dated = (es) => es.filter((e) => !e.input && e.kind === "json").map((e) => e.path);
    ok("window: 21 days back to 7 ahead of the ET day, weekdays only (2026-09-23 .. 2026-10-21)", m.window.from === "2026-09-23" && m.window.to === "2026-10-21" && m.window.etDay === "2026-10-14" && dated(F).every((p) => tradingDay(p.slice(13, 23))));
    ok("home's FINAL records are not named (the six gex of 10-12 and 10-13; the complete flow of 10-12): a pull never re-sends them", !dated(G).some((p) => /2026-10-1[23]-/.test(p)) && !dated(F).includes("options-flow/2026-10-12.json") && m.window.heldAtHome === 13);
    ok("home's INCOMPLETE flow record of 10-13 IS named, frozen on its date only (a complete VPS record may replace it); an absent one frozen on date + recordedAt", JSON.stringify(F.find((e) => e.path === "options-flow/2026-10-13.json").frozenOnceSet) === '["date"]' && JSON.stringify(F.find((e) => e.path === "options-flow/2026-10-14.json").frozenOnceSet) === '["date","recordedAt"]');
    ok("gex entries: json, seed false, frozen on date / slot / sym / at; gex/summary.jsonl is the one seeded jsonl-prefix entry", G[0].path === "gex/summary.jsonl" && G[0].kind === "jsonl-prefix" && G.slice(1).every((e) => e.kind === "json" && e.seed === false && JSON.stringify(e.frozenOnceSet) === '["date","slot","sym","at"]') && dated(G).length === 6 * (dated(F).length - 1));
    ok("r147-earnings is NOT in the manifest (no entry names it, no input entry at all: the standing push would send every name in ONE remote script); the manifest only counts them; inputFiles lists one read-only (0444) file per home name, the same names", !JSON.stringify(m.units).includes("r147-earnings") && F.every((e) => !e.input) && G.every((e) => !e.input) && JSON.stringify(m.inputsPushedInChunks) === '{"dir":"r147-earnings","files":3}' && JSON.stringify(inputFiles(H).map((f) => [f.rel, f.mode])) === JSON.stringify([["r147-earnings/AAPL.json", "0444"], ["r147-earnings/BRK.B.json", "0444"], ["r147-earnings/MSFT.json", "0444"]]) && inputFiles(H)[0].data.equals(Buffer.from('{"sym":"AAPL"}')));
    { const hol = build({ homeData: H, nowMs: Date.parse("2026-11-24T22:15:00Z") }); ok("a market holiday (Thanksgiving 2026-11-26) and weekends are never named", !JSON.stringify(hol).includes("2026-11-26") && !JSON.stringify(hol).includes("2026-11-28")); }
    // the standing machinery reads it as it is
    const md = path.join(tmp, "manifests"), out = path.join(md, "w2b.json"), r1 = write({ homeData: H, nowMs: NOW, out }), r2 = write({ homeData: H, nowMs: NOW, out });
    const L = PS.loadManifest("w2b", md), gx = L.units["w2b-gex"], fl = L.units["w2b-flow"];
    ok("written once, then 'unchanged'; pull-server's loader accepts it", r1.changed && !r2.changed && PS.pullEntries(gx).length === G.length && PS.pullEntries(fl).length === F.length && PS.inputEntries(fl).length === 0 && PS.inputEntries(gx).length === 0);
    ok("the standing cutover's seeds: only gex/summary.jsonl (dated files are never seeded)", PS.seedEntries(gx).map((e) => e.path).join() === "gex/summary.jsonl" && PS.seedEntries(fl).length === 0);
    // the inputs, pushed apart IN CHUNKS (a fake VPS: files in memory, the standing machinery's own sha read and verified push)
    { const HB = path.join(tmp, "big"), NAMES = Array.from({ length: 100 }, (_, i) => "SYM" + String(i).padStart(3, "0")), SYNC = syncLib();
      fs.mkdirSync(path.join(HB, "r147-earnings"), { recursive: true }); for (const s of NAMES) fs.writeFileSync(path.join(HB, "r147-earnings", s + ".json"), JSON.stringify({ sym: s }));
      const all = inputFiles(HB), oneScript = PS.remotePushCommand(DATA, all, { lock: "w2b-flow.flock" }).length;
      const V = fakeTreeVps(), r = pushInputs({ ssh: V.fn, homeData: HB }), longest = Math.max(...V.calls.map((c) => c.script.length)), pushes = V.calls.filter((c) => c.kind === "push");
      ok("REMOTE COMMANDS STAY SHORT: 100 r147-earnings names in ONE push script are " + oneScript + " characters (over the 8,190 at which a remote script arrives cut); pushInputs sends them in " + pushes.length + " chunks, every remote script — each push and each sha read — under 5,000 characters, each chunk under the w2b-flow lock",
        oneScript > 8190 && SYNC.SCRIPT_MAX === 5000 && r.files === 100 && r.pushed === 100 && r.current === 0 && pushes.length >= 3 && longest < 5000 && pushes.every((c) => c.lock === "w2b-flow.flock" && c.dir === DATA), JSON.stringify({ oneScript, longest, pushes: pushes.length, r }));
      ok("pushInputs: all 100 land byte-equal and read-only (0444) under the VPS data dir; nothing else is written there", V.files.size === 100 && all.every((f) => V.files.get(DATA + "/" + f.rel).equals(f.data) && V.modes.get(DATA + "/" + f.rel) === "0444"));
      const n1 = V.calls.length, r2b = pushInputs({ ssh: V.fn, homeData: HB }), again = V.calls.slice(n1);
      fs.writeFileSync(path.join(HB, "r147-earnings", "SYM007.json"), JSON.stringify({ sym: "SYM007", changed: true })); fs.writeFileSync(path.join(HB, "r147-earnings", "NEWNAME.json"), "{}");
      const n2 = V.calls.length, r3 = pushInputs({ ssh: V.fn, homeData: HB }), third = V.calls.slice(n2).filter((c) => c.kind === "push");
      ok("pushInputs is idempotent: a second run reads the shas and pushes NOTHING; after one file changed and one name was added at home, exactly those two are pushed", r2b.pushed === 0 && r2b.current === 100 && again.every((c) => c.kind === "sha") && again.length >= 1 && r3.files === 101 && r3.pushed === 2 && r3.current === 99 && third.length === 1 && /SYM007\.json/.test(third[0].script) && /NEWNAME\.json/.test(third[0].script) && !/SYM008/.test(third[0].script) && V.files.size === 101);
      const VB = fakeTreeVps({ busy: () => true }), rb = pushInputs({ ssh: VB.fn, homeData: HB });
      let eDown = null; try { pushInputs({ ssh: () => ({ ok: false, status: 255, out: "", err: "down" }), homeData: HB }); } catch (x) { eDown = x.message; }
      fs.writeFileSync(path.join(HB, "r147-earnings", "SYM001.json"), '{"again":1}');
      let eTorn = null; try { pushInputs({ ssh: (s, o) => (/EOF_MV/.test(s) ? { ok: true, status: 0, out: "PUSHED 1\n", err: "" } : V.fn(s, o)), homeData: HB }); } catch (x) { eTorn = x.message; }
      ok("pushInputs fails closed: the unit's lock held on the VPS -> { busy } and nothing written; the VPS unreachable -> throws; a push that reports done but whose file does not read back by sha -> throws 'not what was pushed'", rb.busy === true && rb.pushed === 0 && VB.files.size === 0 && /ssh sha256/.test(eDown || "") && /SYM001\.json: not what was pushed/.test(eTorn || ""), JSON.stringify([rb, eDown, eTorn]));
      // the chain's part: only while home's map gives w2b-flow to the server
      const mapAt = (o) => fs.writeFileSync(path.join(HB, "host-ownership.json"), JSON.stringify({ schema: "host-ownership-v1", units: o })), noSsh = () => { throw new Error("no ssh while home-owned"); };
      mapAt({ "w2b-gex": "home", "w2b-flow": "home" }); const cH = chainInputs({ homeData: HB, ssh: noSsh });
      mapAt({ "w2b-gex": "server" }); const cN = chainInputs({ homeData: HB, ssh: noSsh });
      fs.writeFileSync(path.join(HB, "host-ownership.json"), "{ torn"); const cT = chainInputs({ homeData: HB, ssh: noSsh });
      mapAt({ "w2b-gex": "server", "w2b-flow": "server" }); const VC = fakeTreeVps(), cS = chainInputs({ homeData: HB, ssh: VC.fn }), cS2 = chainInputs({ homeData: HB, ssh: VC.fn }), cB = chainInputs({ homeData: HB, ssh: fakeTreeVps({ busy: () => true }).fn }), cD = chainInputs({ homeData: HB, ssh: () => ({ ok: false, status: 255, out: "", err: "down" }) });
      ok("the chain's inputs push (this file with no argument): w2b-flow HOME-owned or not named in the map -> nothing pushed, NO ssh, exit 0; a torn map -> exit 1 (ownership unknown); SERVER-owned -> the 101 names pushed in chunks, exit 0, then 'already current'; the lock held or the VPS down -> exit 1, said plainly",
        cH.code === 0 && /home-owned[^]*no ssh/.test(cH.line) && cN.code === 0 && /does not name w2b-flow/.test(cN.line) && cT.code === 1 && /ownership unknown/.test(cT.line) && cS.code === 0 && /^inputs: 101 r147-earnings name\(s\) on the VPS, read-only — 101 pushed in chunks and read back, 0 already current$/.test(cS.line) && VC.files.size === 101 && /0 pushed in chunks and read back, 101 already current/.test(cS2.line) && cB.code === 1 && /lock on the VPS is held/.test(cB.line) && cD.code === 1 && /^inputs push FAILED: ssh sha256/.test(cD.line), JSON.stringify([cH, cN, cT, cS, cS2, cB, cD])); }
    ok("steady state is small: with home holding every past day, the manifest names today + the days ahead only (<= 6 weekdays)", (() => { const H2 = path.join(tmp, "steady"); fs.mkdirSync(path.join(H2, "r147-earnings"), { recursive: true }); fs.writeFileSync(path.join(H2, "r147-earnings", "AAPL.json"), "{}"); for (let d = "2026-09-23"; d < "2026-10-14"; d = addDay(d, 1)) { if (!tradingDay(d)) continue; for (const s of SLOTS) for (const y of SYMS) { const f = path.join(H2, "gex", `${d}-${s}-${y}.json`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "{}"); } const f = path.join(H2, "options-flow", `${d}.json`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '{"complete":true}'); } const s = build({ homeData: H2, nowMs: NOW }); return dated(s.units["w2b-flow"].entries).length === 6 && s.units["w2b-flow"].entries.filter((e) => !e.input)[0].path === "options-flow/2026-10-14.json"; })());
    // the pull through pull-server's own applyUnit: what lands, what is refused
    const T = (files) => PS.tarOf(Object.entries(files).map(([name, data]) => ({ name, data: typeof data === "string" ? data : JSON.stringify(data) })));
    const a1 = PS.applyUnit(gx, T({ "gex/summary.jsonl": '{"date":"2026-10-12"}\n{"date":"2026-10-14"}\n', "gex/2026-10-14-close-SPX.json": gexDoc("2026-10-14", "close", "SPX", "2026-10-14T19:42:20Z") }), H, { requireHalt: false });
    ok("pull: a new gex record + the appended summary land at home", a1.ok && readJson(path.join(H, "gex", "2026-10-14-close-SPX.json")).at === "2026-10-14T19:42:20Z", JSON.stringify(a1));
    w("gex/2026-10-14-close-SPY.json", gexDoc("2026-10-14", "close", "SPY", "2026-10-14T19:42:30Z"));   // home recorded it too (split brain)
    const a2 = PS.applyUnit(gx, T({ "gex/summary.jsonl": '{"date":"2026-10-12"}\n{"date":"2026-10-14"}\n', "gex/2026-10-14-close-SPY.json": gexDoc("2026-10-14", "close", "SPY", "2026-10-14T19:42:59Z") }), H, { requireHalt: false });
    ok("pull: a gex record home already holds, recorded at another time on the VPS -> REFUSED (never replaced; 'at' is frozen)", !a2.ok && /2026-10-14-close-SPY\.json: at .* \(it never changes once set\)/.test(a2.why), a2.why);
    const a3 = PS.applyUnit(gx, T({ "gex/summary.jsonl": '{"date":"2026-10-12"}\n' }), H, { requireHalt: false });
    ok("pull: the summary shorter than home's (a reset VPS) -> REFUSED (append-only)", !a3.ok && /exact prefix/.test(a3.why));
    const a4 = PS.applyUnit(fl, T({ "options-flow/2026-10-13.json": { date: "2026-10-13", recordedAt: "2026-10-13T19:47:00Z", complete: true, coverage: 1, names: { AAPL: {}, MSFT: {}, "BRK.B": {} } } }), H, { requireHalt: false });
    ok("pull: a COMPLETE VPS flow record replaces home's incomplete one of the same day", a4.ok && readJson(path.join(H, "options-flow", "2026-10-13.json")).complete === true, JSON.stringify(a4));
    const a5 = PS.applyUnit(fl, T({ "r147-earnings/AAPL.json": "{}" }), H, { requireHalt: false });
    ok("pull: an r147-earnings file in a pull tar -> REFUSED (an input is pushed, never pulled)", !a5.ok && /unexpected file/.test(a5.why));
    // --verify
    const map = (gex, flw) => w("host-ownership.json", { schema: "host-ownership-v1", units: { "w2b-gex": gex, "w2b-flow": flw } });
    const V = (now = NOW) => verify({ homeData: H, nowMs: now });
    map("home", "home"); ok("verify: both home-owned -> exit 0 (home records them)", V().code === 0 && /home-owned/.test(V().lines[0]));
    map("server", "server");
    for (const s of SLOTS) for (const y of SYMS) w(`gex/2026-10-14-${s}-${y}.json`, gexDoc("2026-10-14", s, y, "2026-10-14T13:41:00Z"));
    w("options-flow/2026-10-14.json", { date: "2026-10-14", complete: true, coverage: 1, names: { AAPL: {}, MSFT: {}, "BRK.B": {} }, errors: {} });
    ok("verify: server-owned, all six gex + a complete flow with home's names -> exit 0", V().code === 0, V().lines.join(" | "));
    fs.unlinkSync(path.join(H, "gex", "2026-10-14-close-QQQ.json"));
    ok("verify: today's close QQQ record missing at home -> exit 1 (FAIL) naming it", V().code === 1 && /gex\/2026-10-14-close-QQQ\.json/.test(V().lines.join()), V().lines.join(" | "));
    w("gex/2026-10-14-close-QQQ.json", gexDoc("2026-10-14", "close", "QQQ", "x"));
    w("options-flow/2026-10-14.json", { date: "2026-10-14", complete: false, coverage: 0.4, names: { AAPL: {} }, errors: { MSFT: "500", "BRK.B": "500" } });
    ok("verify: the flow record incomplete (same population) -> exit 3 (WARN: R272 excludes the day)", V().code === 3 && /INCOMPLETE/.test(V().lines.join()), V().lines.join(" | "));
    w("options-flow/2026-10-14.json", { date: "2026-10-14", complete: true, coverage: 1, names: { AAPL: {}, MSFT: {}, TSLA: {} }, errors: {} });
    ok("verify: the VPS recorded another population (TSLA instead of BRK.B) -> exit 1 (FAIL)", V().code === 1 && /1 missing: BRK\.B; 1 extra: TSLA/.test(V().lines.join()), V().lines.join(" | "));
    fs.unlinkSync(path.join(H, "options-flow", "2026-10-14.json"));
    ok("verify: the flow record missing -> exit 1", V().code === 1 && /options-flow\/2026-10-14\.json is not at home/.test(V().lines.join()));
    ok("verify: a Saturday, Thanksgiving, or 15:50 ET (the slot not ended) -> exit 0, nothing verified", V(Date.parse("2026-10-17T22:15:00Z")).code === 0 && V(Date.parse("2026-11-26T22:15:00Z")).code === 0 && V(Date.parse("2026-10-14T19:50:00Z")).code === 0);
    w("host-ownership.json", "{ torn"); ok("verify: a torn map -> exit 1 (ownership unknown)", V().code === 1 && /ownership unknown/.test(V().lines[0]));
    w("host-ownership.json", { schema: "host-ownership-v1", units: { r309: "server" } }); ok("verify: the map does not name the W2b units -> exit 1", V().code === 1);
    fs.rmSync(path.join(H, "r147-earnings"), { recursive: true }); fs.mkdirSync(path.join(H, "r147-earnings"));
    let e = null; try { build({ homeData: H, nowMs: NOW }); } catch (x) { e = x.message; }
    ok("an EMPTY r147-earnings at home -> build REFUSED (nothing written)", /is empty at home — REFUSED/.test(e || ""));
    w("r147-earnings/AAPL.json", "{ torn"); e = null; try { build({ homeData: H, nowMs: NOW }); } catch (x) { e = x.message; }
    ok("a torn r147-earnings file -> REFUSED (it would be pushed)", /AAPL\.json does not parse/.test(e || ""));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`w2b-manifest selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  try {
    if (a.length === 1 && a[0] === "--selftest") process.exitCode = selftest() ? 0 : 1;
    else if (a.length === 1 && a[0] === "--verify") { const v = verify(); for (const l of v.lines) console.log(l); process.exitCode = v.code; }
    else if (a.length === 1 && a[0] === "--print") { console.log(JSON.stringify(build(), null, 1)); process.exitCode = 0; }
    else if (a.length === 0 || (a.length === 1 && a[0] === "--manifest-only")) {
      const r = write(); console.log(`w2b manifest ${r.changed ? "written" : "unchanged"}: ${summaryOf(r.m)}`); process.exitCode = 0;
      if (!a.length) { const p = chainInputs(); console.log(p.line); process.exitCode = p.code; }   // the chain's step; --manifest-only never makes an ssh call
    }
    else { console.log("usage: node w2b-manifest.cjs [--manifest-only | --print | --verify | --selftest]"); process.exitCode = 2; }
  } catch (e) { console.error("w2b-manifest: REFUSED — " + e.message); process.exitCode = 1; }
}
module.exports = { build, write, verify, staticOf, summaryOf, earningsFiles, inputFiles, pushInputs, chainInputs, syncLib, fakeTreeVps, tradingDay, etParts, UNIT_DEFS, OUT, DATA, BACKEND, SHADOW_B, BACK_DAYS, AHEAD_DAYS };
