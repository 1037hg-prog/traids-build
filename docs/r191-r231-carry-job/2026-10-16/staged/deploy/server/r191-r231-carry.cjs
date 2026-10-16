#!/usr/bin/env node
/**
 * R191 / R231 CARRY — home -> the VPS's TWO data folders, until the board moves to the server. 2026-10-16 (docs/r191-r231-carry-job/2026-10-16).
 * Installed at home as deploy/server/r191-r231-carry.cjs; run from home by a scheduled task (NOTES.md).
 *
 * WHY. R191 (backend/r191-crypto-trend-forward.js) and R231 (backend/r231-crypto-vote-sized-forward.js) trade the SAME paper account, and since the
 * sell repairs (R231 2026-10-12, R191 2026-10-14) each one's sell guard reads the OTHER sleeves' own files from ITS OWN data folder (otherSleeves):
 *   R191 reads  r231-crypto-vote-sized.json  + the board mirror's alpaca-mirror.jsonl and alpaca-mirror-exits.jsonl
 *   R231 reads  r191-crypto-trend.json       + the same two board files
 * A file it cannot read is "unreadable": NO SELL of that coin (R191: of any coin) that run, and exit 1. W3 moves w3-r191 and w3-r231 to the VPS ONE
 * UNIT AT A TIME (docs/server/wave3-sleeves/manifests.cjs: per-unit cutover), while the board (alpaca-mirror.js) keeps writing its files AT HOME until
 * W5 moves it. The W3 manifests do not carry these files: each unit's manifest names only its own files, and its json INPUTS (KNOWN_INPUTS has
 * none for w3-r191 / w3-r231; the board's files are jsonl, which pull-server inputs cannot be). So without this job:
 *   - the REAL tree (/home/traids/traids/backend/data): a server-owned R191 or R231 finds no board files, and no state file of a sleeve that is
 *     still home-owned -> it can never sell;
 *   - the SHADOW tree (/home/traids/w3-shadow/backend/data, never pulled): its DRY runs of the home-owned unit(s) read their own state and the
 *     other files from the shadow folder, which nothing refreshes -> the shadow decides on stale or missing files and compare.cjs compares noise.
 *
 * WHAT IS CARRIED (planCarry, a pure function of home's backend/data/host-ownership.json):
 *   file                          owner          read by
 *   r191-crypto-trend.json        w3-r191        R231 (and R191's own shadow run)
 *   r231-crypto-vote-sized.json   w3-r231        R191 (and R231's own shadow run)
 *   alpaca-mirror.jsonl           the board      both
 *   alpaca-mirror-exits.jsonl     the board      both
 *   r191-crypto-trend.jsonl       w3-r191        R191 itself (its client ids) — the shadow tree only
 *   r231-crypto-vote-sized.jsonl  w3-r231        R231 itself — the shadow tree only
 *   REAL tree:   a file is carried from home when its owner is HOME and a reader of it is SERVER-owned. A file whose owner is server-owned is never
 *                written there (the VPS writes it; home's copy is a pulled copy, never pushed back).
 *   SHADOW tree: a file is carried when a HOME-owned unit's shadow run reads it (its own state included): from home when its owner is home, else
 *                copied on the VPS from the real tree (the writer's own copy, under the real tree's locks).
 *   The board's owner is every "w5-*" unit of the map: none named = home (W5 not deployed) · all home = home · all server = server · a mix =
 *   the board's two files are REFUSED (exit 1), the other files still go. w3-r191 / w3-r231 must each be named "home" or "server".
 *   Nothing to carry anywhere (both units server-owned and the board on the server) = this job is RETIRED: it says so and exits 0, no ssh.
 * NEVER carried: a switch (r191-OFF, r231-OFF, *-HALT), a lock, any other file. A file is carried only after it validates at home (the state:
 * JSON with a coins table; a jsonl: every line JSON, the file ending in a newline) — a bad file is not pushed over the server's copy.
 *
 * HOW. One read-only ssh asks the sha256 of every target (and of every real-tree source); only files that differ go. Home's bytes go up by scp to
 * temp names INSIDE the target folder (.carry-in-<run>-<file>), then ONE ssh per tree, under that tree's w3-r191.flock and w3-r231.flock (the
 * locks w3-run.cjs runs each unit's entry under, so a unit never reads a half-carried set), checks every temp's sha256, copies a real-tree source
 * for the shadow (a jsonl copy must end in a newline: a mid-append copy is dropped for this run), sets 0644 and renames each into place. Any
 * temp left is removed. A lock busy past the wait: nothing is moved in that tree this run (exit 3, WARN); a lock file
 * that cannot be opened is a FAULT (exit 1). Just before each tree's upload home's map is read again: if its bytes changed since the plan (a
 * cutover meanwhile), nothing moves in that tree (exit 1). Every carry run, an early refusal too, writes the status file. Each script stays under SCRIPT_MAX
 * characters (scripts over ~8,190 characters have arrived cut from home — see docs/server/wave7-pm/w7-lib.cjs).
 *
 *   node deploy/server/r191-r231-carry.cjs              carry (ssh/scp to host "traids")
 *   node deploy/server/r191-r231-carry.cjs --plan       what the map says to carry; NO ssh
 *   node deploy/server/r191-r231-carry.cjs --dry        the plan + one read-only ssh: what differs and would go; nothing written anywhere
 *   node deploy/server/r191-r231-carry.cjs --status     the last result (backend/data/r191-r231-carry-status.json)
 * Exit 0 ok (carried / already current / retired) · 1 refused or failed (the reason last on stderr) · 2 bad arguments · 3 WARN: a tree's lock was
 * busy, or a shadow copy was dropped this run.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto");

const HOST = "traids";
const REAL = "/home/traids/traids/backend/data", SHADOW = "/home/traids/w3-shadow/backend/data";
const TREES = [{ id: "real", dir: REAL }, { id: "shadow", dir: SHADOW }];
const UNITS = ["w3-r191", "w3-r231"], LOCKS = ["w3-r191.flock", "w3-r231.flock"];
const BOARD = "board";
/** the carried files: owner (a W3 unit or the board), who reads it, its kind */
const FILES = [
  { file: "r191-crypto-trend.json", owner: "w3-r191", readers: ["w3-r231"], kind: "state" },
  { file: "r231-crypto-vote-sized.json", owner: "w3-r231", readers: ["w3-r191"], kind: "state" },
  { file: "alpaca-mirror.jsonl", owner: BOARD, readers: ["w3-r191", "w3-r231"], kind: "jsonl" },
  { file: "alpaca-mirror-exits.jsonl", owner: BOARD, readers: ["w3-r191", "w3-r231"], kind: "jsonl" },
  // each runner's OWN ledger (the client ids it has used): read only by itself, so carried only into the SHADOW tree while it is home-owned
  { file: "r191-crypto-trend.jsonl", owner: "w3-r191", readers: [], kind: "jsonl" },
  { file: "r231-crypto-vote-sized.jsonl", owner: "w3-r231", readers: [], kind: "jsonl" },
];
const SCRIPT_MAX = 5000, LOCK_WAIT = 120;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const findRepo = (from) => { for (let d = from; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, "backend", "lib", "atomic-write.js"))) return d; if (path.dirname(d) === d) return null; } };

/** owner side of every unit the plan needs -> { side: { "w3-r191": "home"|"server", ..., board: ... }, errors: [] } */
function sidesOf(map) {
  const errors = [], side = {};
  if (!map || map.schema !== "host-ownership-v1" || !map.units || typeof map.units !== "object") return { side, errors: ["host-ownership.json is not a host-ownership-v1 map"] };
  for (const u of UNITS) { const v = map.units[u]; if (v === "home" || v === "server") side[u] = v; else errors.push(`the map does not give ${u} to "home" or "server" (${JSON.stringify(v)})`); }
  const w5 = Object.entries(map.units).filter(([k]) => /^w5-/.test(k)), vals = [...new Set(w5.map(([, v]) => v))];
  if (!w5.length) side[BOARD] = "home";
  else if (vals.length === 1 && (vals[0] === "home" || vals[0] === "server")) side[BOARD] = vals[0];
  else side[BOARD] = null;   // half moved / unknown: refused for the board's files
  return { side, errors };
}
/**
 * THE PLAN (pure). map -> { real: [{ file, from: "home" }], shadow: [{ file, from: "home"|"real" }], errors (map-level: nothing carried),
 *   refused: [{ file, why }] (that file only: the board half moved), notes, retired }
 */
function planCarry(map) {
  const { side, errors } = sidesOf(map), notes = [], real = [], shadow = [], refused = [];
  if (errors.length) return { real, shadow, errors, refused, notes, retired: false };
  const srv = UNITS.filter((u) => side[u] === "server"), home = UNITS.filter((u) => side[u] === "home");
  for (const f of FILES) {
    const own = side[f.owner];
    const realNeed = f.readers.some((r) => srv.includes(r));
    const shadowNeed = [...f.readers, ...(f.owner === BOARD ? [] : [f.owner])].some((r) => home.includes(r));
    if (own == null) { if (realNeed || shadowNeed) refused.push({ file: f.file, why: "the board is half moved (the map's w5-* units are not all on one side) — not carried until they are" }); continue; }
    if (realNeed) { if (own === "home") real.push({ file: f.file, from: "home" }); else notes.push(`${f.file}: written on the VPS (its owner is server-owned) — never pushed into the real tree`); }
    if (shadowNeed) shadow.push({ file: f.file, from: own === "home" ? "home" : "real" });
  }
  return { real, shadow, errors, refused, notes, retired: !real.length && !shadow.length && !refused.length, side };
}

/** validate home's bytes of a carried file (null = fine, else why) */
function invalid(f, buf) {
  if (buf == null) return "absent at home";
  const t = buf.toString("utf8");
  if (f.kind === "state") { let j; try { j = JSON.parse(t); } catch (e) { return `does not parse (${e.message.slice(0, 60)})`; } return j && j.coins && typeof j.coins === "object" && !Array.isArray(j.coins) ? null : "has no coins table"; }
  if (t.length && !t.endsWith("\n")) return "does not end in a newline (cut mid-append?)";
  const lines = t.split("\n").filter((l) => l.trim());
  for (let i = 0; i < lines.length; i++) { try { JSON.parse(lines[i]); } catch { return `line ${i + 1} is not JSON`; } }
  return null;
}

// ── the remote scripts ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** read-only: sha256 of each named absolute path (ABSENT when missing) */
function readScript(paths) {
  return ["# carry:read", `for f in ${paths.map(q).join(" ")}; do if [ -f "$f" ] && [ ! -L "$f" ]; then sha256sum -- "$f"; else echo "ABSENT  $f"; fi; done`].join("\n");
}
/**
 * one tree: under its two flocks (and, when a source is the real tree, the real tree's two flocks too) verify each uploaded temp, copy each
 * real-tree source, rename into place. items: [{ file, sha, from: "home"|"real" }]
 */
/** open the lock file (exit 76 when it cannot be opened: a fault, never "busy"), then wait for it (exit 75: busy) */
const lockLines = (fd, f, w) => [`{ exec ${fd}>>${q(f)}; } 2>/dev/null || { echo "LOCKFILE ${f}" >&2; exit 76; }`, `flock -w ${w} ${fd} || exit 75`];
function moveScript(dir, run, items, lockWait = LOCK_WAIT) {
  const tmp = (f) => `.carry-in-${run}-${f}`, needReal = items.some((i) => i.from === "real");
  const L = ["# carry:move", "set -u", `D=${q(dir)}`, `cd "$D" || exit 7`, `trap 'rm -f -- .carry-in-${run}-*' EXIT`,
    ...lockLines(8, LOCKS[0], lockWait), ...lockLines(9, LOCKS[1], lockWait)];
  if (needReal) L.push(...lockLines(6, REAL + "/" + LOCKS[0], lockWait), ...lockLines(7, REAL + "/" + LOCKS[1], lockWait));
  for (const i of items) {
    const t = tmp(i.file);
    if (i.from === "home") L.push(`s=$(sha256sum -- ${q(t)} 2>/dev/null | cut -c1-64); if [ "$s" != "${i.sha}" ]; then echo "MISMATCH ${i.file}" >&2; exit 9; fi`);
    else {
      L.push(`if [ ! -f ${q(REAL + "/" + i.file)} ]; then echo "NOSOURCE ${i.file}"; else cp -- ${q(REAL + "/" + i.file)} ${q(t)} || exit 8;`,
        /\.jsonl$/.test(i.file) ? `  if [ -s ${q(t)} ] && [ "$(tail -c 1 ${q(t)} | od -An -tx1 | tr -d ' ')" != "0a" ]; then echo "TORN ${i.file}"; rm -f -- ${q(t)}; fi; fi` : "fi");
    }
  }
  for (const i of items) L.push(`if [ -f ${q(tmp(i.file))} ]; then chmod 0644 -- ${q(tmp(i.file))} && mv -f -- ${q(tmp(i.file))} ${q(i.file)} || exit 8; echo "CARRIED $(sha256sum -- ${q(i.file)})"; fi`);
  L.push("echo DONE");
  return L.join("\n");
}

// ── ssh / scp (real) ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3"];
function sshReal(host = HOST) {
  return (script, { timeout = 300000 } = {}) => {
    const r = cp.spawnSync("ssh", [...OPTS, host, script], { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return { ok: !r.error && r.status === 0, status: r.error ? null : r.status, out: r.stdout || "", err: String(r.stderr || "") + (r.error ? " " + r.error.message : "") };
  };
}
function scpReal(host = HOST) {
  return (local, remote, { timeout = 300000 } = {}) => {
    // run from the local file's folder and name it by its basename: a Windows path ("C:\\...") is never taken for host:path
    const r = cp.spawnSync("scp", ["-B", "-q", ...OPTS, path.basename(local), `${host}:${remote}`], { cwd: path.dirname(local), encoding: "utf8", timeout, windowsHide: true });
    return { ok: !r.error && r.status === 0, status: r.error ? null : r.status, err: String(r.stderr || "") + (r.error ? " " + r.error.message : "") };
  };
}

/**
 * RUN. deps: { homeData, ssh, scp, mode: "carry"|"plan"|"dry", now, statusFile, tmpDir, lockWait, writeJson, scriptMax (selftest) }
 * -> { exit, lines, plan, carried: { real: [...], shadow: [...] } }
 */
function run(deps = {}) {
  const homeData = deps.homeData, mode = deps.mode || "carry", lines = [], say = (s) => lines.push(s), carried = { real: [], shadow: [] };
  const mapFile = path.join(homeData, "host-ownership.json");
  // every carry-mode exit records its result (an early refusal too, so --status never shows an older run's success)
  const done = (exit, why) => {
    if (why) say(why);
    if (mode === "carry" && deps.statusFile) {
      const repo = findRepo(__dirname) || findRepo(path.dirname(deps.statusFile));
      const rec = { schema: "r191-r231-carry-status-v1", at: (deps.now ? deps.now() : new Date()).toISOString(), exit, carried, lines };
      try { const w = deps.writeJson || (repo ? require(path.join(repo, "backend", "lib", "atomic-write.js")).writeJsonAtomic : null); if (w) w(deps.statusFile, rec); } catch (e) { lines.splice(lines.length - 1, 0, `note the status file could not be written (${e.message.slice(0, 80)})`); }
    }
    return { exit, lines, plan, carried };
  };
  let plan = null, map = null, mapBuf = null;
  try { mapBuf = fs.readFileSync(mapFile); map = JSON.parse(mapBuf.toString("utf8")); } catch (e) { return done(1, `REFUSED: home's backend/data/host-ownership.json cannot be read (${String(e.message).slice(0, 80)}) — nothing carried`); }
  plan = planCarry(map);
  if (plan.errors.length) { for (const e of plan.errors) say("REFUSED: " + e); return done(1, "REFUSED: the map does not say where to carry — nothing carried"); }
  for (const n of plan.notes) say("note " + n);
  for (const x of plan.refused) say(`REFUSED ${x.file}: ${x.why}`);
  if (plan.retired) return done(0, "RETIRED: w3-r191, w3-r231 and the board are all server-owned — nothing to carry (remove this job's schedule)");
  for (const t of TREES) for (const i of plan[t.id]) say(`plan ${t.id.padEnd(6)} ${i.file} <- ${i.from === "home" ? "home" : "the VPS's real tree"}`);
  // home's bytes, validated
  const local = new Map(); let bad = 0;
  for (const f of FILES) {
    if (!TREES.some((t) => plan[t.id].some((i) => i.file === f.file && i.from === "home"))) continue;
    let buf = null; try { buf = fs.readFileSync(path.join(homeData, f.file)); } catch { buf = null; }
    const why = invalid(f, buf); if (why) { bad++; say(`REFUSED ${f.file}: ${why} — not carried`); continue; }
    local.set(f.file, buf);
  }
  bad += plan.refused.length;
  if (mode === "plan") return done(bad ? 1 : 0, bad ? "PLAN: a file would be refused (above)" : "PLAN: nothing sent (no ssh)");
  // what is on the VPS now (one read-only ssh)
  const ssh = deps.ssh || sshReal(), scp = deps.scp || scpReal();
  const ask = [...new Set(TREES.flatMap((t) => plan[t.id].flatMap((i) => [`${t.dir}/${i.file}`, ...(i.from === "real" ? [`${REAL}/${i.file}`] : [])])))];
  const scriptMax = deps.scriptMax || SCRIPT_MAX;
  if (!ask.length) return done(bad ? 1 : 0, bad ? `FAILED: ${bad} file(s) not carried (above)` : "nothing to carry");
  const rs = readScript(ask); if (rs.length > scriptMax) return done(1, `REFUSED: the read script is ${rs.length} characters (max ${scriptMax})`);
  const r = ssh(rs, { timeout: 60000 });
  if (!r.ok) return done(1, `FAILED: ssh (read) ${r.status == null ? "failed" : "exit " + r.status}: ${String(r.err).trim().slice(0, 200)} — nothing carried`);
  const cur = new Map();
  for (const l of String(r.out).split("\n").filter(Boolean)) { const x = /^([0-9a-f]{64}|ABSENT)\s+\*?(\/.+)$/.exec(l.trim()); if (!x) return done(1, `FAILED: unexpected reply ${JSON.stringify(l.slice(0, 80))}`); cur.set(x[2], x[1] === "ABSENT" ? null : x[1]); }
  for (const p of ask) if (!cur.has(p)) return done(1, `FAILED: no answer for ${p}`);
  let warn = 0, fail = bad;
  const run_ = `${(deps.now ? deps.now() : new Date()).toISOString().replace(/\D/g, "").slice(0, 14)}-${process.pid}`;
  for (const t of TREES) {
    const items = [];
    for (const i of plan[t.id]) {
      if (i.from === "home") { if (!local.has(i.file)) continue; const s = sha(local.get(i.file)); if (cur.get(`${t.dir}/${i.file}`) === s) say(`ok   ${t.id.padEnd(6)} ${i.file} already current`); else items.push({ ...i, sha: s }); }
      else { const src = cur.get(`${REAL}/${i.file}`); if (src == null) { fail++; say(`FAIL ${t.id.padEnd(6)} ${i.file}: absent in the VPS's real tree — nothing to copy`); } else if (cur.get(`${t.dir}/${i.file}`) === src) say(`ok   ${t.id.padEnd(6)} ${i.file} already current`); else items.push({ ...i, sha: src }); }
    }
    if (!items.length) continue;
    if (mode === "dry") { for (const i of items) say(`DRY  ${t.id.padEnd(6)} would carry ${i.file} <- ${i.from === "home" ? "home" : "the real tree"}`); continue; }
    const lw = deps.lockWait || LOCK_WAIT, ms = moveScript(t.dir, run_, items, lw);
    if (ms.length > scriptMax) { fail++; say(`FAIL ${t.id}: the move script is ${ms.length} characters (max ${scriptMax}) — nothing sent to this tree`); continue; }
    // the map again, just before this tree's move: a cutover since the plan was made could have given a file's owner to the server
    let now = null; try { now = fs.readFileSync(mapFile); } catch { now = null; }
    if (!now || !now.equals(mapBuf)) { fail++; say(`FAIL ${t.id}: home's host-ownership.json changed since this run's plan — nothing moved in this tree (run again)`); continue; }
    // upload home's bytes to temp names in the target folder
    let upFail = null;
    for (const i of items.filter((x) => x.from === "home")) {
      const lf = path.join(deps.tmpDir || os.tmpdir(), `carry-${run_}-${i.file}`);
      fs.writeFileSync(lf, local.get(i.file));
      try { const u = scp(lf, `${t.dir}/.carry-in-${run_}-${i.file}`); if (!u.ok) { upFail = `scp ${i.file}: ${u.status == null ? "failed" : "exit " + u.status} ${String(u.err).trim().slice(0, 160)}`; break; } }
      finally { fs.rmSync(lf, { force: true }); }
    }
    if (upFail) { fail++; say(`FAIL ${t.id}: ${upFail} — nothing moved in this tree`); ssh(`cd ${q(t.dir)} && rm -f -- .carry-in-${run_}-*`, { timeout: 60000 }); continue; }
    const m = ssh(ms, { timeout: (lw * 4 + 120) * 1000 });
    if (m.status === 75) { warn++; say(`WARN ${t.id}: a unit's lock was busy past ${lw}s — nothing moved in this tree; carried next run`); continue; }
    if (!m.ok || !/^DONE$/m.test(String(m.out))) { fail++; say(`FAIL ${t.id}: ssh (move) exit ${m.status}: ${String(m.err || m.out).trim().slice(0, 200)}`); continue; }
    const got = new Map([...String(m.out).matchAll(/^CARRIED ([0-9a-f]{64})\s+(\S+)$/gm)].map((x) => [x[2], x[1]]));
    for (const x of String(m.out).matchAll(/^(TORN|NOSOURCE) (\S+)$/gm)) { warn++; say(`WARN ${t.id.padEnd(6)} ${x[2]}: ${x[1] === "TORN" ? "the real tree's copy was mid-append (no final newline)" : "absent in the real tree"} — not copied this run`); }
    for (const i of items) {
      if (!got.has(i.file)) continue;
      if (i.from === "home" && got.get(i.file) !== i.sha) { fail++; say(`FAIL ${t.id.padEnd(6)} ${i.file}: the VPS's copy is not what was sent`); continue; }
      carried[t.id].push(i.file); say(`ok   ${t.id.padEnd(6)} carried ${i.file} <- ${i.from === "home" ? "home" : "the real tree"} (${got.get(i.file).slice(0, 12)})`);
    }
  }
  if (fail) return done(1, `FAILED: ${fail} file(s) not carried (above)`);
  if (warn) return done(3, "WARN: something was not carried this run (above)");
  return done(0, mode === "dry" ? "DRY: nothing written" : `CARRIED: real ${carried.real.length}, shadow ${carried.shadow.length} (the rest already current)`);
}

if (require.main === module) {
  const a = process.argv.slice(2), repo = findRepo(__dirname);
  const modes = { "": "carry", "--plan": "plan", "--dry": "dry" };
  if (a.length === 1 && a[0] === "--status") {
    try { const s = JSON.parse(fs.readFileSync(path.join(repo, "backend", "data", "r191-r231-carry-status.json"), "utf8")); console.log(`${s.at} exit ${s.exit}\n${s.lines.join("\n")}`); } catch { console.log("no status yet"); }
    process.exitCode = 0;
  } else if (a.length > 1 || !(a.join("") in modes)) { console.error("usage: node deploy/server/r191-r231-carry.cjs [--plan | --dry | --status]"); process.exitCode = 2; }
  else if (!repo) { console.error("REFUSED: run from the repository (backend/lib/atomic-write.js not found above this file)"); process.exitCode = 1; }
  else {
    const homeData = path.join(repo, "backend", "data");
    const r = run({ homeData, mode: modes[a.join("")], statusFile: path.join(homeData, "r191-r231-carry-status.json") });
    const out = r.lines.slice(0, -1), last = r.lines[r.lines.length - 1];
    for (const l of out) console.log(l);
    (r.exit ? console.error : console.log)(last);
    process.exitCode = r.exit;
  }
}
module.exports = { HOST, REAL, SHADOW, TREES, UNITS, LOCKS, FILES, SCRIPT_MAX, sidesOf, planCarry, invalid, readScript, moveScript, sshReal, scpReal, run };
