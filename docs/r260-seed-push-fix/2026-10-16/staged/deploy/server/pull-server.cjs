#!/usr/bin/env node
/**
 * PULL SERVER — VPS -> home, one way, driven by a per-wave MANIFEST. 2026-10-07 (server migration M3; docs/server/wave1-crypto).
 * Generalizes deploy/server/pull-r309.cjs (whose rules are reproduced as data in manifests/r309.json — selftest proves parity) so
 * every wave pulls the same way. Installed at home as deploy/server/pull-server.cjs (+ deploy/server/manifests/<wave>.json).
 *
 * WHAT IS PULLED. For each UNIT of the wave whose owner in home's backend/data/host-ownership.json is "server": that unit's files
 * (manifest entries with pull != false). A home-owned unit is never pulled (no ssh at all): before the cutover the server's copies
 * are seeds or nothing, and pulling them would overwrite home's newer files. An unreadable map, or a unit it does not name, is an
 * error for that unit (nothing pulled, exit 1) — never a guess.
 *
 * HOW. One ssh per unit (Windows OpenSSH, BatchMode). The server, read-only except for opening the unit's flock file, lists the
 * entries' regular files (never a symlink; a directory entry = its files matching the manifest glob) and streams ONE ustar of them
 * while holding the unit's lock (flock -w, so a pull never reads a unit mid-run; a unit busy past the wait is skipped this pull, not
 * an error). Home parses the tar in node (no home tar), validates every file against home's copy (manifests.cjs header: json /
 * jsonl-prefix / jsonl-rewritten / dir-of-json), and only then stages the changed files in a temp dir inside backend/data, fsyncs,
 * re-reads, and renames each atomically into place. A unit is all-or-nothing on validation; a refused unit does not block the others.
 * Then the unit's INPUT entries (home-owned, e.g. risk-policy.json) are pushed to the server read-only (0444) when they differ.
 *
 * NEVER SYNCED, either way: *.lock, *.flock, *lock.json, *-OFF, *-HALT, TRAIDS_STOP, .schwab-token.json, telegram-offset.json,
 * .env, and home's governance/state files (host-ownership.json, test-registry.json, read-seals.json, agent-ledger.jsonl,
 * change-registry.json, board_positions.json, trade_log.json, chain-status.json). A manifest naming one is refused at load; a tar
 * entry naming one is refused. Home backend/data/r309-HALT (the backstop that keeps the PC from ever sending for R309) must exist
 * BEFORE and AFTER every pull, whatever the wave (exit 4 otherwise).
 *
 *   node deploy/server/pull-server.cjs --wave w1 [--dry] [--host traids] [--lock-wait 20] [--probe-ssh <from>]
 *   node deploy/server/pull-server.cjs --wave w1,r309            several waves, in order
 *   node deploy/server/pull-server.cjs --status                   the last result per wave (backend/data/pull-server-status.json)
 *   node deploy/server/pull-server.cjs --selftest                 temp dirs and a fake ssh only (no network, no repo data file)
 * --dry fetches and validates, stages in the OS temp dir, renames nothing, pushes nothing and writes no status.
 * --probe-ssh <from> (preflight.bat | close-chain): also run ONE read-only `ssh traids true` (even while every unit is home-owned, when
 *   the pull itself makes no ssh) and record the result as sshProbe[<from>] in pull-server-status.json. This is how the scheduled tasks'
 *   principal (S4U: TRAIDS Preflight, TRAIDS Market Close) proves it can reach the VPS BEFORE the cutover; own.cjs w1 server refuses
 *   until both sources have a recent successful probe (plan v2 W-P "dry test", M3).
 * Run from: the close chain (first step "pull server files" with --probe-ssh close-chain, and again just before "git snapshot") and
 * automation\preflight.bat (before preflight.js, with --probe-ssh preflight.bat). One run at a time: backend/data/pull-server.lock (a
 * second run is skipped; a lock left by a dead process — e.g. one the chain SIGKILLed — is replaced at once, any other after 30 min).
 * Exit 0 ok (pulled / no change / home-owned) · 1 a unit refused or ssh failed (nothing written for it) · 2 bad arguments ·
 * 3 WARN: nothing wrong was written, but a unit was busy on the server (skipped this pull), the home lock was held by another run, or
 *   the ssh probe failed — the chain records it as WARN (warnExit [3]) with this run's last stderr line, never as a quiet ok ·
 * 4 home r309-HALT missing (refused, or vanished during the pull).
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto");

const findRepo = (from) => { for (let d = from; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, "backend", "data")) && fs.existsSync(path.join(d, "deploy"))) return d; if (path.dirname(d) === d) return null; } };
const REPO = findRepo(__dirname);
const HOME_DATA = REPO ? path.join(REPO, "backend", "data") : null;
const MANIFEST_DIR = path.join(__dirname, "manifests");
const HOST = "traids";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const get = (o, p) => String(p).split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);

// ── never-sync rules ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const NEVER = [/\.lock$/i, /\.flock$/i, /(^|[-_.])lock\.json$/i, /-OFF$/, /-HALT$/, /^TRAIDS_STOP$/, /^\.schwab-token\.json$/, /^telegram-offset\.json$/, /^\.env$/];
const HOME_ONLY = new Set(["host-ownership.json", "pull-server-status.json", "test-registry.json", "read-seals.json", "agent-ledger.jsonl", "change-registry.json", "board_positions.json", "trade_log.json", "chain-status.json"]);
const base = (rel) => String(rel).split("/").pop();
const isNever = (rel) => NEVER.some((re) => re.test(base(rel)));
const SAFE_REL = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const KINDS = new Set(["json", "jsonl-prefix", "jsonl-rewritten", "dir-of-json"]);

// ── manifest ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Load and check one manifest; throws on anything unsafe. Entries get pull/seed defaults and a compiled pattern. */
function loadManifest(wave, dir = MANIFEST_DIR) {
  if (!/^[a-z0-9-]+$/.test(String(wave || ""))) throw new Error(`bad wave id ${JSON.stringify(wave)}`);
  const f = path.join(dir, wave + ".json");
  let m; try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { throw new Error(`manifest ${wave}: cannot read ${f} (${e.code || e.message})`); }
  return checkManifest(m, wave);
}
function checkManifest(m, wave) {
  if (!m || m.schema !== "pull-manifest-v1" || m.wave !== wave) throw new Error(`manifest ${wave}: not a pull-manifest-v1 for wave ${wave}`);
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(m.remoteData || "")) throw new Error(`manifest ${wave}: remoteData must be a plain absolute path`);
  if (!m.units || !Object.keys(m.units).length) throw new Error(`manifest ${wave}: no units`);
  for (const [u, def] of Object.entries(m.units)) {
    if (!/^[a-z0-9-]+$/.test(u)) throw new Error(`manifest ${wave}: bad unit name ${u}`);
    if (def.lock != null && (!/^[A-Za-z0-9._-]+\.flock$/.test(def.lock))) throw new Error(`manifest ${wave}/${u}: lock must be a *.flock file name in remoteData`);
    if (!Array.isArray(def.entries) || !def.entries.length) throw new Error(`manifest ${wave}/${u}: no entries`);
    def.entries = def.entries.map((e) => {
      const x = { pull: true, seed: true, input: false, cache: false, ...e };
      if (!SAFE_REL.test(x.path || "") || x.path.split("/").includes("..")) throw new Error(`manifest ${wave}/${u}: unsafe path ${JSON.stringify(x.path)}`);
      if (isNever(x.path)) throw new Error(`manifest ${wave}/${u}: ${x.path} is a switch / lock / secret — it is never synced`);
      if (HOME_ONLY.has(base(x.path)) && !x.input) throw new Error(`manifest ${wave}/${u}: ${x.path} is home-owned — it is never pulled`);
      if (!KINDS.has(x.kind)) throw new Error(`manifest ${wave}/${u}: ${x.path} has unknown kind ${x.kind}`);
      x.dir = x.kind === "dir-of-json";
      if (x.dir) { if (!x.glob || !/^[A-Za-z0-9*?\[\]._-]+$/.test(x.glob) || !x.pattern) throw new Error(`manifest ${wave}/${u}: ${x.path} (dir-of-json) needs a safe glob and a pattern`); x.re = new RegExp(x.pattern); }
      if (x.input && (x.kind !== "json" || x.dir || x.pull)) throw new Error(`manifest ${wave}/${u}: input ${x.path} must be a json file with pull:false`);
      if (x.mode != null && !/^0[0-7]{3}$/.test(x.mode)) throw new Error(`manifest ${wave}/${u}: ${x.path} bad mode`);
      if (x.kind === "jsonl-rewritten" && !(x.rules && x.rules.idField && x.rules.next)) throw new Error(`manifest ${wave}/${u}: ${x.path} needs rules (idField, next)`);
      return x;
    });
  }
  return m;
}
const pullEntries = (def) => def.entries.filter((e) => e.pull && !e.input);
const seedEntries = (def) => def.entries.filter((e) => e.seed && !e.input);
const inputEntries = (def) => def.entries.filter((e) => e.input);
/** does a tar / listing name belong to this entry? */
function owns(e, rel) {
  if (!e.dir) return rel === e.path;
  if (!rel.startsWith(e.path + "/")) return false;
  const rest = rel.slice(e.path.length + 1);
  return !rest.includes("/") && e.re.test(rest);
}

// ── ownership map (home-owned; pushed read-only to the server by own.cjs) ───────────────────────────────────────────────────
function readMap(file) {
  let txt; try { txt = fs.readFileSync(file); } catch (e) { return { ok: false, why: `host-ownership.json unreadable (${e.code || e.message})` }; }
  let m; try { m = JSON.parse(txt.toString("utf8")); } catch (e) { return { ok: false, why: "host-ownership.json does not parse" }; }
  if (!m || m.schema !== "host-ownership-v1" || !m.units || typeof m.units !== "object") return { ok: false, why: "host-ownership.json is not a host-ownership-v1 map" };
  for (const [u, h] of Object.entries(m.units)) if (h !== "home" && h !== "server") return { ok: false, why: `host-ownership.json: ${u} has host ${JSON.stringify(h)} (want home | server)` };
  return { ok: true, map: m, sha: sha(txt), buf: txt };
}
function ownerOf(mapRes, unit, def) {
  if (!mapRes.ok) return { owner: null, why: mapRes.why };
  const h = mapRes.map.units[unit];
  if (h === "home" || h === "server") return { owner: h };
  if (def && def.fixedOwner) return { owner: def.fixedOwner, fixed: true };
  return { owner: null, why: `host-ownership.json does not name ${unit}` };
}

// ── ustar (read; and write for pushes and the selftest) ──────────────────────────────────────────────────────────────────────
function untar(buf) {
  const out = [];
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString("latin1").replace(/\0[\s\S]*$/, "");
    const name = str(0, 100), size = parseInt(str(124, 136).trim() || "0", 8), type = String.fromCharCode(h[156] || 48), prefix = str(345, 500);
    const sum = parseInt(str(148, 156).trim(), 8); let calc = 0; for (let i = 0; i < 512; i++) calc += i >= 148 && i < 156 ? 32 : h[i];
    if (!Number.isFinite(sum) || sum !== calc) throw new Error(`tar header checksum mismatch at offset ${off}`);
    if (!/^ustar/.test(str(257, 263))) throw new Error(`not a ustar header at offset ${off}`);
    if (type !== "0" && type !== "\0") throw new Error(`tar entry ${JSON.stringify(name)} is type ${JSON.stringify(type)} — only regular files are accepted`);
    if (!Number.isFinite(size) || size < 0) throw new Error(`tar entry ${JSON.stringify(name)}: bad size`);
    const full = (prefix ? prefix + "/" : "") + name, start = off + 512;
    if (start + size > buf.length) throw new Error(`tar entry ${JSON.stringify(full)} truncated`);
    out.push({ name: full.replace(/^\.\//, ""), data: Buffer.from(buf.subarray(start, start + size)) });
    off = start + Math.ceil(size / 512) * 512;
  }
  return out;
}
function tarOf(entries) {   // entries: [{ name, data, type? }] — ustar, names <= 100 bytes, mode 0644
  const blocks = [];
  for (const e of entries) {
    const h = Buffer.alloc(512), data = Buffer.from(e.data || "");
    if (Buffer.byteLength(e.name) > 100) throw new Error(`tar name too long: ${e.name}`);
    h.write(e.name, 0, 100, "latin1"); h.write("0000644\0", 100); h.write("0001750\0", 108); h.write("0001750\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124); h.write("15000000000\0", 136); h.write("        ", 148);
    h.write(e.type || "0", 156); h.write("ustar\0", 257); h.write("00", 263);
    let s = 0; for (let i = 0; i < 512; i++) s += h[i]; h.write(s.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// ── validation (pure) ────────────────────────────────────────────────────────────────────────────────────────────────────────
function parseLines(name, buf) {
  const txt = buf.toString("utf8");
  if (txt.length && !txt.endsWith("\n")) throw new Error(`${name}: the last line has no newline (caught mid-write?)`);
  return txt.split("\n").filter((l) => l.trim()).map((l, i) => { try { return JSON.parse(l); } catch { throw new Error(`${name}: line ${i + 1} does not parse`); } });
}
/** jsonl-rewritten (R309's ledger rules as data): ids only grow; immutable fields stay; once-fields fixed after their status;
 *  onceSet fields fixed once non-null; non-mutable kinds immutable entirely; status only moves forward. */
function checkRewritten(name, oldRows, newRows, R, L) {
  const id = R.idField, kf = R.kindField || "kind", sf = R.statusField || "status";
  const ids = new Map();
  for (const r of newRows) { if (!r || r[id] == null) throw new Error(`${name}: a row on ${L.B} has no ${id}`); if (ids.has(r[id])) throw new Error(`${name}: duplicate ${id} ${r[id]} on ${L.B}`); ids.set(r[id], r); }
  for (const h of oldRows) {
    const s = ids.get(h[id]);
    if (!s) throw new Error(`${name}: ${h[id]} is on ${L.A} but not on ${L.B} (ids must only grow)`);
    if (R.mutableKind && h[kf] !== R.mutableKind) { if (!same(h, s)) throw new Error(`${name}: ${h[kf]} row ${h[id]} changed (it is immutable)`); continue; }
    for (const p of R.immutable || []) if (!same(get(h, p), get(s, p))) throw new Error(`${name}: ${h[id]} immutable field ${p} changed (${JSON.stringify(get(h, p))} -> ${JSON.stringify(get(s, p))})`);
    for (const w of R.onceWhenStatus || []) if (w.statuses.includes(h[sf])) for (const p of w.fields) if (!same(get(h, p), get(s, p))) throw new Error(`${name}: ${h[id]} ${w.what || "fixed"} field ${p} changed after the lot was ${h[sf]}`);
    for (const p of R.onceSet || []) { const v = get(h, p); if (v != null && !same(v, get(s, p))) throw new Error(`${name}: ${h[id]} ${p} changed after it settled`); }
    const allowed = R.next[h[sf]];
    if (!allowed) throw new Error(`${name}: ${h[id]} has an unknown ${sf} ${JSON.stringify(h[sf])} on ${L.A}`);
    if (!allowed.includes(s[sf])) throw new Error(`${name}: ${h[id]} ${sf} ${h[sf]} -> ${s[sf]} moves backward`);
  }
}
/** grows: every leaf under path p on the older side exists, equal, on the newer side (an append-only keyed store) */
function checkGrows(name, oldObj, newObj, p, L) {
  const o = get(oldObj, p), n = get(newObj, p);
  if (o == null) return;
  if (n == null || typeof n !== "object") throw new Error(`${name}: ${p} exists on ${L.A} but not on ${L.B} (the store only grows)`);
  let missing = 0, changed = 0, firstBad = null;
  const walk = (a, b, at) => {
    if (a !== null && typeof a === "object" && !Array.isArray(a)) {
      for (const k of Object.keys(a)) {
        if (!b || typeof b !== "object" || !(k in b)) { missing++; firstBad = firstBad || `${at}.${k} missing`; continue; }
        walk(a[k], b[k], `${at}.${k}`);
      }
    } else if (!same(a, b)) { changed++; firstBad = firstBad || `${at} ${JSON.stringify(a)} -> ${JSON.stringify(b)}`; }
  };
  walk(o, n, p);
  if (missing || changed) throw new Error(`${name}: ${L.B}'s ${p} is not a superset of ${L.A}'s (${missing} missing, ${changed} changed; first: ${firstBad}) — the store only grows`);
}
/**
 * Validate the newer side's files against the older side's, entry by entry. oldFiles / newFiles: Map rel -> Buffer (only names the
 * entries own). mode "pull": older = home, newer = server. mode "seed": older = the server, newer = home. Returns the plan
 * [{ rel, data, changed }] (newer files, changed = differs from the older side); throws on any refusal.
 */
function checkGrowth(entries, oldFiles, newFiles, { mode = "pull" } = {}) {
  const L = mode === "pull" ? { A: "home", B: "the server" } : { A: "the server", B: "home" };
  const plan = [];
  const push = (rel, data) => { const o = oldFiles.get(rel); plan.push({ rel, data, changed: !(o && o.equals(data)) }); };
  for (const e of entries) {
    const oldNames = [...oldFiles.keys()].filter((n) => owns(e, n)).sort(), newNames = [...newFiles.keys()].filter((n) => owns(e, n)).sort();
    if (e.cache) { for (const n of newNames) if (!oldFiles.has(n)) push(n, newFiles.get(n)); continue; }   // seed-only cache: add missing, never overwrite
    if (e.input) { const n = newFiles.get(e.path); if (n) { try { JSON.parse(n.toString("utf8")); } catch { throw new Error(`${e.path}: not valid JSON`); } push(e.path, n); } continue; }
    if (e.dir) {
      for (const n of newNames) { try { JSON.parse(newFiles.get(n).toString("utf8")); } catch (x) { throw new Error(`${n}: not valid JSON (${String(x.message).slice(0, 60)})`); } }
      for (const n of oldNames) {
        const nb = newFiles.get(n);
        if (!nb) throw new Error(`${n} exists on ${L.A} but not on ${L.B} (a dated record is never removed — wrong host, or a reset?)`);
        if (e.frozenWhen) { let oj = null; try { oj = JSON.parse(oldFiles.get(n).toString("utf8")); } catch { oj = null; } if (oj && get(oj, e.frozenWhen) === true && !nb.equals(oldFiles.get(n))) throw new Error(`${n}: ${e.frozenWhen} on ${L.A}, and ${L.B}'s copy differs (a ${e.frozenWhen} record is never rewritten)`); }
      }
      for (const n of newNames) push(n, newFiles.get(n));
      continue;
    }
    const o = oldFiles.get(e.path), n = newFiles.get(e.path);
    if (!n) {
      if (o && (mode === "seed" || e.kind !== "json")) throw new Error(`${e.path} exists on ${L.A} but not on ${L.B} (wrong host, or a reset?)`);
      continue;   // pull: a json file the server has not written yet is skipped
    }
    if (e.kind === "jsonl-prefix") {
      parseLines(e.path, n);
      if (o && !(n.length >= o.length && n.subarray(0, o.length).equals(o))) throw new Error(`${e.path}: the copy on ${L.A} (${o.length} bytes) is not an exact prefix of the copy on ${L.B} (${n.length} bytes) — the log is append-only`);
    } else if (e.kind === "jsonl-rewritten") {
      const nr = parseLines(e.path, n), or = o ? parseLines(e.path + ` (${L.A})`, o) : [];
      checkRewritten(e.path, or, nr, e.rules, L);
    } else {
      let nj; try { nj = JSON.parse(n.toString("utf8")); } catch (x) { throw new Error(`${e.path}: not valid JSON (${String(x.message).slice(0, 60)})`); }
      if (o) {
        let oj = null; try { oj = JSON.parse(o.toString("utf8")); } catch { oj = null; }
        if (oj) {
          for (const p of e.frozenOnceSet || []) { const v = get(oj, p); if (v != null && v !== false && v !== "" && !same(v, get(nj, p))) throw new Error(`${e.path}: ${p} ${JSON.stringify(v).slice(0, 60)} on ${L.A} -> ${JSON.stringify(get(nj, p)).slice(0, 60)} on ${L.B} (it never changes once set)`); }
          if (e.grows) checkGrows(e.path, oj, nj, e.grows, L);
        } else if (e.grows && mode === "seed") throw new Error(`${e.path}: the copy on ${L.A} does not parse — refusing to overwrite a store that may hold more`);
      }
    }
    push(e.path, n);
  }
  return plan;
}
/** read the entries' files from a local data dir -> Map rel -> Buffer (regular files only, never a symlink) */
function readLocal(entries, dir) {
  const m = new Map();
  const isFile = (f) => { try { const s = fs.lstatSync(f); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } };
  for (const e of entries) {
    if (!e.dir) { const f = path.join(dir, ...e.path.split("/")); if (isFile(f)) m.set(e.path, fs.readFileSync(f)); continue; }
    const d = path.join(dir, ...e.path.split("/"));
    let names = []; try { if (fs.lstatSync(d).isDirectory()) names = fs.readdirSync(d); } catch { names = []; }
    for (const n of names) { const rel = e.path + "/" + n; if (owns(e, rel) && isFile(path.join(d, n))) m.set(rel, fs.readFileSync(path.join(d, n))); }
  }
  return m;
}
/** the tar's entries -> Map, refusing anything the entries do not own, duplicates, and never-sync names */
function tarFiles(entries, tarBuf) {
  const m = new Map();
  for (const t of untar(tarBuf)) {
    if (isNever(t.name)) throw new Error(`the server's tar holds ${JSON.stringify(t.name)} — a switch / lock / secret is never synced`);
    if (!entries.some((e) => owns(e, t.name))) throw new Error(`unexpected file ${JSON.stringify(t.name)} in the server's tar — only ${entries.map((e) => e.path + (e.dir ? "/" + e.glob : "")).join(", ")} are pulled`);
    if (m.has(t.name)) throw new Error(`duplicate ${t.name} in the tar`);
    m.set(t.name, t.data);
  }
  return m;
}

/** Validate + stage + (unless dry) rename one unit's pulled files into homeDir. Never touches anything else; HALT before and after. */
function applyUnit(def, tarBuf, homeDir, { dry = false, requireHalt = true, haltFile = null } = {}) {
  const halt = haltFile || path.join(homeDir, "r309-HALT");
  if (requireHalt && !fs.existsSync(halt)) return { ok: false, code: 4, why: "home backend/data/r309-HALT is missing — refusing to pull (it is the backstop that keeps the PC from sending for R309; restore it first)" };
  const ents = pullEntries(def);
  let plan;
  try { const srv = tarFiles(ents, tarBuf); plan = checkGrowth(ents, readLocal(ents, homeDir), srv, { mode: "pull" }); } catch (e) { return { ok: false, code: 1, why: e.message }; }
  const stage = fs.mkdtempSync(dry ? path.join(os.tmpdir(), "pull-server-") : path.join(homeDir, ".pull-stage-"));
  const actions = [];
  try {
    for (const p of plan) {
      if (!p.changed) continue;
      const f = path.join(stage, ...p.rel.split("/")); fs.mkdirSync(path.dirname(f), { recursive: true });
      const fd = fs.openSync(f, "w"); try { fs.writeFileSync(fd, p.data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    for (const p of plan) if (p.changed && !fs.readFileSync(path.join(stage, ...p.rel.split("/"))).equals(p.data)) return { ok: false, code: 1, why: `${p.rel}: staged copy differs from what was received` };
    for (const p of plan) {
      if (!p.changed) continue;
      actions.push(`${dry ? "would update" : "update"} ${p.rel} (${p.data.length} bytes)`);
      if (!dry) { const to = path.join(homeDir, ...p.rel.split("/")); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(path.join(stage, ...p.rel.split("/")), to); }
    }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  if (requireHalt && !fs.existsSync(halt)) return { ok: false, code: 4, why: "home backend/data/r309-HALT VANISHED during the pull — restore it now", actions };
  return { ok: true, code: 0, actions, files: plan.map((p) => p.rel) };
}

// ── remote commands (built here, run over ssh) ───────────────────────────────────────────────────────────────────────────────
/** read-only listing + ONE ustar of the entries' regular files, under the unit's flock (exit 75 = busy, 7 = no data dir) */
function remoteTarCommand(remoteData, entries, { lock = null, lockWait = 20 } = {}) {
  const files = entries.filter((e) => !e.dir).map((e) => q(e.path)), dirs = entries.filter((e) => e.dir);
  return [
    "set -o pipefail",
    `cd ${q(remoteData)} || exit 7`,
    lock ? `exec 9>>${q(lock)} && flock -w ${Math.max(1, Math.floor(lockWait))} 9 || exit 75` : ":",
    `{ for f in ${files.join(" ") || "''"}; do if [ -n "$f" ] && [ -f "$f" ] && [ ! -L "$f" ]; then printf '%s\\0' "$f"; fi; done; ` +
      dirs.map((e) => `if [ -d ${q(e.path)} ] && [ ! -L ${q(e.path)} ]; then find ${q(e.path)} -mindepth 1 -maxdepth 1 -type f -name ${q(e.glob)} -print0; fi;`).join(" ") +
      ` } | tar --format=ustar -cf - --null --no-recursion -T -`,
  ].join("\n");
}
/** home -> server: one ustar on stdin, staged inside remoteData, sha256-verified, each file chmod'ed and renamed into place */
function remotePushCommand(remoteData, files, { lock = null, lockWait = 60 } = {}) {
  for (const f of files) if (!SAFE_REL.test(f.rel) || isNever(f.rel) || !/^0[0-7]{3}$/.test(f.mode || "0644")) throw new Error(`refusing to push ${f.rel}`);
  return [
    "set -euo pipefail",
    `D=${q(remoteData)}`,
    `cd "$D" || exit 7`,
    lock ? `exec 9>>${q(lock)} && flock -w ${Math.max(1, Math.floor(lockWait))} 9 || exit 75` : ":",
    `st=$(mktemp -d "$D/.push-stage-XXXXXX")`,
    `trap 'rm -rf "$st"' EXIT`,
    `tar -x -f - -C "$st" --no-same-owner --no-same-permissions`,
    `cd "$st"`,
    "sha256sum -c --quiet --strict - <<'EOF_SHA'",
    ...files.map((f) => `${sha(f.data)}  ${f.rel}`),
    "EOF_SHA",
    `n=0; while read -r mode rel; do mkdir -p -- "$(dirname -- "$D/$rel")"; chmod "$mode" -- "$rel"; mv -f -- "$rel" "$D/$rel"; n=$((n+1)); done <<'EOF_MV'`,
    ...files.map((f) => `${f.mode || "0644"} ${f.rel}`),
    "EOF_MV",
    `echo "PUSHED $n"`,
  ].join("\n");
}
function sshReal(host = HOST) {
  if (!/^[A-Za-z0-9._@-]+$/.test(host)) throw new Error("bad --host");
  return (script, { input = null, timeout = 180000, binary = false } = {}) => {
    const r = cp.spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", host, script], { input: input || undefined, encoding: binary ? undefined : "utf8", timeout, maxBuffer: 512 * 1024 * 1024, windowsHide: true });
    return { ok: !r.error && r.status === 0, status: r.error ? null : r.status, out: r.stdout == null ? (binary ? Buffer.alloc(0) : "") : r.stdout, err: String(r.stderr || "") + (r.error ? " " + r.error.message : "") };
  };
}
/** fetch the given entries' files from a server data dir (Map rel -> Buffer) or { busy } / throws on ssh failure */
function fetchRemote(ssh, remoteData, entries, { lock = null, lockWait = 20 } = {}) {
  const r = ssh(remoteTarCommand(remoteData, entries, { lock, lockWait }), { binary: true, timeout: (lockWait + 120) * 1000 });
  if (r.status === 75) return { busy: true };
  if (!r.ok) throw Object.assign(new Error(`ssh: ${r.status == null ? "failed" : "exit " + r.status} ${String(r.err).trim().slice(0, 240)}`), { unreachable: r.status == null || r.status === 255 });
  return { files: tarFiles(entries, r.out) };
}
/** push files home -> server (seeds, inputs). files: [{ rel, data, mode }] */
function pushRemote(ssh, remoteData, files, { lock = null, lockWait = 60 } = {}) {
  if (!files.length) return { pushed: 0 };
  const r = ssh(remotePushCommand(remoteData, files, { lock, lockWait }), { input: tarOf(files.map((f) => ({ name: f.rel, data: f.data }))), timeout: (lockWait + 300) * 1000 });
  if (r.status === 75) return { busy: true };
  if (!r.ok || !/PUSHED \d+/.test(String(r.out))) throw new Error(`push to ${remoteData} failed (exit ${r.status}): ${String(r.err || r.out).trim().slice(0, 300)}`);
  return { pushed: Number(/PUSHED (\d+)/.exec(String(r.out))[1]) };
}
/** sha256 of remote files (null = absent); an ssh failure THROWS (fail-closed) */
const remoteShasCommand = (remoteData, rels) => `cd ${q(remoteData)} || exit 7; for f in ${rels.map(q).join(" ")}; do if [ -f "$f" ]; then sha256sum -- "$f"; else echo "ABSENT  $f"; fi; done`;
function remoteShas(ssh, remoteData, rels) {
  const r = ssh(remoteShasCommand(remoteData, rels));
  if (!r.ok) throw new Error(`ssh sha256: exit ${r.status} ${String(r.err).trim().slice(0, 200)}`);
  const m = new Map();
  for (const l of String(r.out).split("\n").filter(Boolean)) { const x = /^([0-9a-f]{64}|ABSENT)\s+\*?(.+)$/.exec(l.trim()); if (!x) throw new Error(`ssh sha256: unexpected line ${JSON.stringify(l.slice(0, 80))}`); m.set(x[2], x[1] === "ABSENT" ? null : x[1]); }
  for (const f of rels) if (!m.has(f)) throw new Error(`ssh sha256: no answer for ${f}`);
  return m;
}
/** push a unit's INPUT entries (home-owned, read-only on the server) when the server's copy differs */
function pushInputs(ssh, remoteData, def, homeDir, { dry = false } = {}) {
  const ins = inputEntries(def); if (!ins.length) return [];
  const local = readLocal(ins, homeDir), lines = [];
  for (const e of ins) if (!local.has(e.path)) throw new Error(`input ${e.path} is missing at home`);
  for (const e of ins) { try { JSON.parse(local.get(e.path).toString("utf8")); } catch { throw new Error(`input ${e.path} does not parse at home — not pushed`); } }
  const cur = remoteShas(ssh, remoteData, ins.map((e) => e.path));
  const todo = ins.filter((e) => cur.get(e.path) !== sha(local.get(e.path))).map((e) => ({ rel: e.path, data: local.get(e.path), mode: e.mode || "0444" }));
  if (!todo.length) return [`inputs: ${ins.map((e) => e.path).join(", ")} already current on the server`];
  if (dry) return todo.map((f) => `would push input ${f.rel} (read-only ${f.mode})`);
  const r = pushRemote(ssh, remoteData, todo, { lock: def.lock, lockWait: 60 });
  if (r.busy) return [`inputs: the unit is running on the server — pushed next pull`];
  const after = remoteShas(ssh, remoteData, todo.map((f) => f.rel));
  for (const f of todo) if (after.get(f.rel) !== sha(f.data)) throw new Error(`input ${f.rel}: the server's copy is not what was pushed`);
  return todo.map((f) => `pushed input ${f.rel} (read-only ${f.mode})`);
}

// ── CHUNKED push + sha read (R260-SEED-PUSH-FIX 2026-10-16, docs/r260-seed-push-fix/2026-10-16) ─────────────────────────────────────
// WHAT WENT WRONG. remotePushCommand lists EVERY file twice in the script it sends (its sha256 line in the EOF_SHA here-document, its mode
// line in EOF_MV), so the script grows with the number of files. A script over ~8,190 characters arrives CUT on the VPS (seen 2026-10-10 by
// w3-sync.cjs; docs/server/wave7-pm/w7-lib.cjs SCRIPT_MAX): bash then reads to the end of what arrived inside the EOF_SHA here-document —
// "here-document at line 9 delimited by end-of-file (wanted `EOF_SHA')" (line 9 = the sha256sum line of remotePushCommand) — checks only the
// sha lines that arrived, never reaches EOF_MV, moves nothing and prints no "PUSHED n": the push fails. The w3-r260 seed (own.cjs w3-r260
// server) is a large set of files in ONE pushRemote call, so its script was far over the cut.
// THE FIX. pushChunked sends the same files in chunks whose script (remotePushCommand, measured exactly, not estimated) stays under
// SCRIPT_MAX, each chunk under the same lock, and reads each chunk back by sha256 (remoteShasChunked) BEFORE the next goes: a chunk that does
// not land as sent throws and nothing more is sent. pushRemote itself is UNCHANGED (one script, as before: its callers that already chunk —
// W7's pushVerified, W2b's pushInputs, w3-sync — and their selftests' controls rely on it). A caller with a list that can grow uses pushChunked.
const SCRIPT_MAX = 5000;   // well under the ~8,190 characters at which a script arrived cut (the same limit as W7 and W2b)
/**
 * split items into runs whose script (build(run).length) stays <= max; an item over the limit on its own still goes alone (never dropped);
 * order kept. Linear: each item's share is measured once (build([it]) - build([])), and every run is then measured
 * EXACTLY with build(run); a run over max (an estimate that was short) is split in two and measured again.
 */
function chunkByScript(items, build, max = SCRIPT_MAX) {
  if (!items.length) return [];
  const base = build([]).length, cost = items.map((it) => build([it]).length - base), runs = []; let cur = [], len = base;
  items.forEach((it, i) => { if (cur.length && len + cost[i] > max) { runs.push(cur); cur = []; len = base; } cur.push(it); len += cost[i]; });
  if (cur.length) runs.push(cur);
  const out = [], fit = (run) => { if (run.length > 1 && build(run).length > max) { const h = Math.ceil(run.length / 2); fit(run.slice(0, h)); fit(run.slice(h)); } else out.push(run); };
  for (const r of runs) fit(r);
  return out;
}
/** remoteShas in chunks, each script <= SCRIPT_MAX (Map rel -> sha | null = absent); an ssh failure THROWS (fail-closed) */
function remoteShasChunked(ssh, remoteData, rels, { max = SCRIPT_MAX } = {}) {
  const m = new Map();
  for (const part of chunkByScript(rels, (run) => remoteShasCommand(remoteData, run), max)) for (const [k, v] of remoteShas(ssh, remoteData, part)) m.set(k, v);
  return m;
}
/**
 * pushRemote in chunks: files [{ rel, data, mode }] -> { pushed, chunks } | { busy: true, pushed, partial } (the lock was busy at chunk k: the
 * chunks before it landed and were verified; nothing after it was sent). A chunk not read back byte-equal THROWS (nothing more is sent).
 */
function pushChunked(ssh, remoteData, files, { lock = null, lockWait = 60, max = SCRIPT_MAX } = {}) {
  if (!files.length) return { pushed: 0, chunks: 0 };
  const parts = chunkByScript(files, (run) => remotePushCommand(remoteData, run, { lock, lockWait }), max);
  let pushed = 0, chunks = 0;
  for (const part of parts) {
    let r; try { r = pushRemote(ssh, remoteData, part, { lock, lockWait }); }
    catch (e) { throw new Error(`${e.message} (chunk ${chunks + 1} of ${parts.length}; ${pushed} file(s) landed and were verified before it)`); }
    if (r.busy) return { busy: true, pushed, partial: pushed > 0, chunks };
    const after = remoteShasChunked(ssh, remoteData, part.map((f) => f.rel), { max });
    for (const f of part) if (after.get(f.rel) !== sha(f.data)) throw new Error(`push to ${remoteData}: ${f.rel} is not what was sent (chunk ${chunks + 1} of ${parts.length}; ${pushed} file(s) landed before it) — nothing more sent`);
    pushed += r.pushed; chunks++;
  }
  return { pushed, chunks };
}

// ── home lock + status ───────────────────────────────────────────────────────────────────────────────────────────────────────
const LOCK_STALE_MS = 30 * 60000;
/** is this pid a live process? (signal 0 = existence check only; EPERM = it exists but is not ours) */
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
function takeLock(file, what) {
  const body = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), what });
  try { fs.writeFileSync(file, body, { flag: "wx" }); return { ok: true }; }
  catch (e) {
    if (e.code !== "EEXIST") return { ok: false, why: `cannot create ${path.basename(file)} (${e.code})` };
    let j = null; try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { j = null; }
    const age = j ? Date.now() - Date.parse(j.at) : Infinity;
    // a lock whose process is gone (the chain SIGKILLs a step at its timeout) is stale NOW, not after 30 min of silently skipped pulls
    const dead = j && Number.isInteger(j.pid) && j.pid !== process.pid && !pidAlive(j.pid);
    if (age < LOCK_STALE_MS && !dead) return { ok: false, busy: true, why: `another pull-server run holds ${path.basename(file)} (pid ${j && j.pid}, ${j && j.what}, since ${j && j.at})` };
    try { fs.unlinkSync(file); fs.writeFileSync(file, body, { flag: "wx" }); return { ok: true, stale: j }; } catch (x) { return { ok: false, why: `stale lock could not be replaced (${x.code})` }; }
  }
}
const dropLock = (file) => { try { const j = JSON.parse(fs.readFileSync(file, "utf8")); if (j.pid === process.pid) fs.unlinkSync(file); } catch {} };
function writeStatus(file, waveId, rec, probe = null) {
  let st = null; try { st = JSON.parse(fs.readFileSync(file, "utf8")); } catch { st = null; }
  if (!st || typeof st !== "object" || !st.waves) st = { schema: "pull-server-status-v1", waves: {} };
  st.waves[waveId] = rec; st.updatedAt = rec.at;
  if (probe) st.sshProbe = { ...(st.sshProbe && typeof st.sshProbe === "object" ? st.sshProbe : {}), [probe.from]: probe };
  const aw = REPO ? require(path.join(REPO, "backend", "lib", "atomic-write.js")) : null;
  if (aw) aw.writeJsonAtomic(file, st); else fs.writeFileSync(file, JSON.stringify(st, null, 1));
}

/**
 * Pull one wave. Returns { exit, lines, units }. deps (selftest): homeDir, manifestDir, ssh, mapFile, haltFile, statusFile, lockHeld.
 */
const PROBE_FROM = /^(preflight\.bat|close-chain)$/;
/** ONE read-only `ssh <host> true` -> { from, at, ok, why, user } (who ran it: the scheduled task's principal is the point) */
function sshProbe(ssh, from) {
  const at = new Date().toISOString(); let user = null; try { user = os.userInfo().username; } catch { user = null; }
  const r = ssh("true", { timeout: 45000 });
  return { from, at, ok: !!r.ok, why: r.ok ? null : `ssh ${r.status == null ? "failed" : "exit " + r.status}: ${String(r.err || "").trim().slice(0, 200)}`, user, interactive: !!(process.stdout && process.stdout.isTTY) };
}
function pullWave(waveId, { homeDir = HOME_DATA, manifestDir = MANIFEST_DIR, ssh = null, host = HOST, dry = false, lockWait = 20, mapFile = null, haltFile = null, statusFile = null, lockHeld = false, writeStatusFile = true, onlyUnits = null, probeSsh = null } = {}) {
  const lines = [], units = {}, at = new Date().toISOString();
  const halt = haltFile || path.join(homeDir, "r309-HALT");
  if (!fs.existsSync(halt)) return { exit: 4, lines: ["REFUSED (exit 4): home backend/data/r309-HALT is missing — restore it before pulling"], units };
  let M; try { M = loadManifest(waveId, manifestDir); } catch (e) { return { exit: 1, lines: ["REFUSED: " + e.message], units }; }
  if (probeSsh != null && !PROBE_FROM.test(String(probeSsh))) return { exit: 1, lines: [`REFUSED: --probe-ssh must name preflight.bat or close-chain (got ${JSON.stringify(probeSsh)})`], units };
  const lockFile = path.join(homeDir, "pull-server.lock");
  if (!lockHeld && !dry) { const L = takeLock(lockFile, `pull --wave ${waveId}`); if (!L.ok) return { exit: L.busy ? 0 : 1, lines: [`${L.busy ? "skipped" : "REFUSED"}: ${L.why}`], units, busy: !!L.busy }; }
  let exit = 0, probe = null;
  try {
    const mapRes = readMap(mapFile || path.join(homeDir, "host-ownership.json"));
    const S = ssh || sshReal(host);
    for (const [u, def] of Object.entries(M.units)) {
      if (onlyUnits && !onlyUnits.includes(u)) continue;
      const own = ownerOf(mapRes, u, def);
      if (!own.owner) { units[u] = { owner: null, result: "error: " + own.why }; lines.push(`${u}: NOT pulled — ownership unknown (${own.why})`); exit = Math.max(exit, 1); continue; }
      if (own.owner !== "server") { units[u] = { owner: "home", result: "home-owned — not pulled" }; lines.push(`${u}: home-owned — not pulled`); continue; }
      try {
        const ents = pullEntries(def);
        const f = fetchRemote(S, M.remoteData, ents, { lock: def.lock, lockWait });
        if (f.busy) { units[u] = { owner: "server", result: "busy — the unit holds its lock on the server; retried next pull" }; lines.push(`${u}: busy on the server (running) — skipped this pull`); continue; }
        const res = applyUnit(def, tarOf([...f.files].map(([name, data]) => ({ name, data }))), homeDir, { dry, haltFile: halt });
        if (!res.ok) { units[u] = { owner: "server", result: `refused: ${res.why}` }; lines.push(`${u}: REFUSED (nothing written for it): ${res.why}`); exit = Math.max(exit, res.code === 4 ? 4 : 1); if (res.code === 4) break; continue; }
        const inp = pushInputs(S, M.remoteData, def, homeDir, { dry });
        units[u] = { owner: "server", result: res.actions.length ? "pulled" : "no change", changed: res.actions, files: res.files.length, inputs: inp };
        lines.push(`${u}: ${res.actions.length ? res.actions.join("; ") : "no change"} (${res.files.length} server file(s))${inp.length ? " · " + inp.join("; ") : ""}`);
      } catch (e) {
        units[u] = { owner: "server", result: "error: " + e.message.slice(0, 300) }; lines.push(`${u}: FAILED (nothing written for it): ${e.message.slice(0, 300)}`); exit = Math.max(exit, 1);
        // ssh itself could not connect (exit 255 / killed): the other units would wait out the same timeout — skip them (bounded run time)
        if (e.unreachable) { for (const [u2] of Object.entries(M.units)) if (!units[u2] && (!onlyUnits || onlyUnits.includes(u2))) { units[u2] = { owner: ownerOf(mapRes, u2, M.units[u2]).owner, result: "error: skipped — the VPS is unreachable" }; } lines.push("the VPS is unreachable — the remaining units were not tried"); break; }
      }
    }
    if (probeSsh && !dry) {
      probe = sshProbe(S, String(probeSsh));
      lines.push(`ssh probe (${probe.from}, as ${probe.user || "?"}): ${probe.ok ? "ok — this principal reaches the VPS" : "FAILED — " + probe.why}`);
    }
    if (!fs.existsSync(halt)) { lines.push("home backend/data/r309-HALT VANISHED during the pull — restore it now (exit 4)"); exit = 4; }
    else lines.push("home r309-HALT present");
    if (!dry && writeStatusFile) { try { writeStatus(statusFile || path.join(homeDir, "pull-server-status.json"), waveId, { at, ok: exit === 0, exit, units }, probe); } catch (e) { lines.push("note: status file not written: " + e.message.slice(0, 120)); } }
  } finally { if (!lockHeld && !dry) dropLock(lockFile); }
  return { exit, lines, units, probe };
}
/** main's exit for one wave's result: 3 (WARN) when nothing failed but something was skipped (busy unit, held home lock) or the probe failed */
function exitOf(r) {
  if (r.exit !== 0) return { exit: r.exit, warn: null };
  const busy = Object.entries(r.units || {}).filter(([, x]) => /^busy/.test(String(x.result))).map(([u]) => u);
  const why = [r.busy ? "another pull-server run held the home lock — nothing pulled this run" : null, busy.length ? `busy on the server (skipped this pull, retried next pull): ${busy.join(", ")}` : null, r.probe && !r.probe.ok ? `ssh probe (${r.probe.from}) FAILED: ${r.probe.why}` : null].filter(Boolean);
  return why.length ? { exit: 3, warn: why.join(" · ") } : { exit: 0, warn: null };
}
/**
 * The close chain obeys the ownership map for these units (text only: close-chain.cjs is never require()d). Every step name of every
 * unit sits on exactly one STEPS line, that line carries ownedBy "<unit>", every other STEPS line that runs one of the unit's scripts is
 * tagged too, and the runner's ownership block is present once. Returns [] or the reasons. Used by own.cjs (before a cutover) and by
 * lib/w1-health.cjs (every run, while a unit is server-owned): a later edit of the chain that drops a tag makes home run the step again.
 */
function chainTagIssues(text, defs) {
  if (typeof text !== "string" || !text) return ["automation/close-chain.cjs could not be read"];
  const bad = [], lines = text.split(/\r?\n/), steps = lines.filter((l) => /^\s*\["/.test(l));
  for (const [u, d] of defs) {
    for (const name of d.steps || []) {
      const hit = steps.filter((l) => l.trimStart().startsWith(`[${JSON.stringify(name)},`));
      if (hit.length !== 1) bad.push(`chain step "${name}" is on ${hit.length} STEPS lines (want exactly 1)`);
      else if (!hit[0].includes(`ownedBy: ${JSON.stringify(u)}`)) bad.push(`chain step "${name}" is not tagged ownedBy: "${u}" — home would run it`);
    }
    for (const f of (d.code || []).filter((x) => /\.js$/.test(x) && !x.includes("/"))) {
      const untagged = steps.filter((l) => l.includes(`"backend/${f}"`) && !l.includes(`ownedBy: ${JSON.stringify(u)}`));
      if (untagged.length) bad.push(`a STEPS line runs backend/${f} without ownedBy: "${u}" (${untagged[0].trim().slice(0, 60)}…) — home would run it`);
    }
  }
  const block = lines.filter((l) => l.trim() === "if (opts.ownedBy) {").length;
  if (block !== 1) bad.push(`the runner's ownership check ("if (opts.ownedBy) {") is in the chain ${block}x (want 1)`);
  if (!lines.some((l) => l.includes('if (owner === "server") {') && l.includes('"skipped (server-owned)"'))) bad.push("the runner's server-owned skip line is missing");
  return bad;
}

// ── selftest ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function selftest() {
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail ? " — " + detail : "")); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pull-server-selftest-"));
  // the shipped manifests (manifests/*.json beside this file: the package's, or deploy/server's once installed)
  const mdir = path.join(tmp, "manifests"); fs.mkdirSync(mdir);
  for (const k of ["r309", "w1"]) fs.copyFileSync(path.join(MANIFEST_DIR, k + ".json"), path.join(mdir, k + ".json"));
  const T = (files) => tarOf(Object.entries(files).map(([name, data]) => ({ name, data })));
  const jl = (rows) => rows.map((x) => JSON.stringify(x)).join("\n") + "\n";
  try {
    console.log("pull-server selftest (" + tmp + ")");
    // ── A. R309 PARITY: pull-r309.cjs's own selftest cases, through pull-server + manifests/r309.json ──
    const r309 = loadManifest("r309", mdir).units.r309;
    const H = path.join(tmp, "home"); fs.mkdirSync(H);
    const w = (n, s) => fs.writeFileSync(path.join(H, n), s), r = (n) => fs.readFileSync(path.join(H, n), "utf8"), ex = (n) => fs.existsSync(path.join(H, n));
    const lot = (o = {}) => ({ kind: "lot", id: "r309-BTC-2026101013", coin: "BTC", day: "2026-10-10", signalHour: "2026-10-10T13:00:00Z", signalClose: 100, stats: { ret: 0.1 }, twin: { hour: "2026-10-09T02:00:00Z", seedKey: "k", seed: 1, entryClose: 99, exitHour: "2026-10-11T02:00:00Z", poolSize: 60, net: null }, shadow: { exitHour: "2026-10-12T13:00:00Z" }, entry: { cid: "r309-BTC-2026101013-B", notionalOrdered: 2000, submittedAt: "2026-10-10T14:02:31Z" }, exit: { legs: [] }, status: "submitting", notes: [], ...o });
    const cyc1 = jl([{ ts: "a", live: true }]), cyc2 = cyc1 + jl([{ ts: "b", live: true }]);
    w("r309-HALT", "home backstop\n"); w("r309-OFF", "home off\n"); w("seat-claims.jsonl", "untouched\n"); w("TRAIDS_STOP", "stop\n"); w("x.lock", "lock\n");
    const P = (files, o = {}) => applyUnit(r309, T(files), H, o);
    const t1 = { "r309-cycles.jsonl": cyc1, "r309-ledger.jsonl": jl([lot()]), "r309-surge-hold48.json": JSON.stringify({ config: { evidenceStart: null } }) };
    const d = P(t1, { dry: true });
    check("r309 parity: dry validates and plans, renames nothing", d.ok && d.actions.length === 3 && !ex("r309-cycles.jsonl") && !ex("r309-ledger.jsonl"), JSON.stringify(d));
    const a = P(t1);
    check("r309 parity: first pull lands the three present files; r309-interim.json absent on the server is skipped", a.ok && r("r309-cycles.jsonl") === cyc1 && ex("r309-ledger.jsonl") && !ex("r309-interim.json"), JSON.stringify(a));
    check("r309 parity: HALT, OFF, TRAIDS_STOP, a .lock and other files untouched; no stage directory left behind", r("r309-HALT") === "home backstop\n" && r("r309-OFF") === "home off\n" && r("TRAIDS_STOP") === "stop\n" && r("x.lock") === "lock\n" && r("seat-claims.jsonl") === "untouched\n" && !fs.readdirSync(H).some((f) => f.startsWith(".pull-stage")));
    check("r309 parity: the same tar again -> nothing to do", P(t1).actions.length === 0);
    const filled = lot({ status: "open", entry: { ...lot().entry, avgPx: 101, filledQty: "0.0198", filledAt: "2026-10-10T14:02:33Z", orderId: "o1" } });
    const MISSED = { kind: "missed", id: "r309-ETH-2026101015", day: "2026-10-10", reason: "late" }, LED = jl([filled, MISSED]);
    const b = P({ "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": LED });
    check("r309 parity: append + a lot rewritten in place (submitting -> open) + a new missed row: accepted", b.ok && r("r309-cycles.jsonl") === cyc2 && JSON.parse(r("r309-ledger.jsonl").split("\n")[0]).status === "open", JSON.stringify(b));
    const snap = () => fs.readdirSync(H).map((f) => f + ":" + (fs.statSync(path.join(H, f)).isFile() ? fs.readFileSync(path.join(H, f)).length : "d")).join(",");
    const refuse = (name, files, re, o) => { const before = snap(); const x = P(files, o); check(name, !x.ok && re.test(x.why || "") && before === snap(), x.why); };
    refuse("r309 parity: cycles not an extension of home's (an edited row) -> refused, nothing written", { "r309-cycles.jsonl": jl([{ ts: "a", live: false }]) + jl([{ ts: "b", live: true }, { ts: "c" }]), "r309-ledger.jsonl": LED }, /exact prefix/);
    refuse("r309 parity: cycles shorter than home (a reset) -> refused", { "r309-cycles.jsonl": cyc1, "r309-ledger.jsonl": LED }, /exact prefix/);
    refuse("r309 parity: a cycles row caught mid-append (no newline) -> refused", { "r309-cycles.jsonl": cyc2 + '{"ts":"c"', "r309-ledger.jsonl": LED }, /mid-write|does not parse/);
    refuse("r309 parity: a ledger id that disappeared -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([filled]) }, /not on the server/);
    refuse("r309 parity: an immutable field changed (signal close) -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([{ ...filled, signalClose: 101 }, MISSED]) }, /immutable field signalClose/);
    refuse("r309 parity: the twin draw changed -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([{ ...filled, twin: { ...filled.twin, hour: "2026-10-09T03:00:00Z" } }, MISSED]) }, /twin\.hour/);
    refuse("r309 parity: the entry fill price changed after the fill -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([{ ...filled, entry: { ...filled.entry, avgPx: 102 } }, MISSED]) }, /entry\.avgPx/);
    refuse("r309 parity: status moved backward (open -> submitted) -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([{ ...filled, status: "submitted" }, MISSED]) }, /moves backward/);
    refuse("r309 parity: a missed row edited -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([filled, { ...MISSED, reason: "OFF" }]) }, /immutable/);
    refuse("r309 parity: a torn ledger line -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([filled]) + "{\"kind\":\"lot\"\n" }, /does not parse/);
    refuse("r309 parity: r309-interim.json that does not parse -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": LED, "r309-interim.json": "{ half" }, /not valid JSON/);
    refuse("r309 parity: a file outside the four (r309-HALT) inside the tar -> refused", { "r309-cycles.jsonl": cyc2, "r309-HALT": "x" }, /never synced|unexpected file "r309-HALT"/);
    { const x = applyUnit(r309, tarOf([{ name: "r309-cycles.jsonl", data: "", type: "2" }]), H); check("r309 parity: a symlink entry in the tar -> refused", !x.ok && /only regular files/.test(x.why), x.why); }
    { const bad = Buffer.from(T({ "r309-cycles.jsonl": cyc2 })); bad[10] ^= 1; const x = applyUnit(r309, bad, H); check("r309 parity: a corrupted tar header -> refused", !x.ok && /checksum/.test(x.why), x.why); }
    w("r309-surge-hold48.json", JSON.stringify({ config: { evidenceStart: "2026-10-12" } }));
    refuse("r309 parity: evidenceStart set at home changed on the server -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": LED, "r309-surge-hold48.json": JSON.stringify({ config: { evidenceStart: "2026-10-13" } }) }, /evidenceStart/);
    const closed = { ...filled, status: "closed", net: 0.01, gross: 0.015, holdHours: 48, exit: { legs: [{ cid: "x-S", status: "filled" }], avgPx: 102.5, soldQty: "0.0197", filledAt: "2026-10-12T14:02:40Z" } };
    const c = P({ "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([closed, MISSED]), "r309-surge-hold48.json": JSON.stringify({ config: { evidenceStart: "2026-10-12" } }) });
    check("r309 parity: open -> closed accepted", c.ok && JSON.parse(r("r309-ledger.jsonl").split("\n")[0]).status === "closed", JSON.stringify(c));
    refuse("r309 parity: a closed lot's net changed -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([{ ...closed, net: 0.02 }, MISSED]) }, /net changed/);
    refuse("r309 parity: ledger missing on the server while home has one -> refused", { "r309-cycles.jsonl": cyc2 }, /exists on home but not on the server/);
    { const tn = jl([{ ...closed, twin: { ...closed.twin, net: 0.003 } }, MISSED]); P({ "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": tn }); const x = P({ "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([{ ...closed, twin: { ...closed.twin, net: 0.004 } }, MISSED]) }); check("r309 parity: twin.net, once settled at home, never changes -> refused", !x.ok && /twin\.net changed after it settled/.test(x.why), x.why); }
    fs.unlinkSync(path.join(H, "r309-HALT"));
    { const h = P(t1); check("r309 parity: home r309-HALT missing -> refused before anything (exit 4)", !h.ok && h.code === 4 && /r309-HALT is missing/.test(h.why)); }
    w("r309-HALT", "home backstop\n");
    const rc = remoteTarCommand("/home/traids/traids/backend/data", pullEntries(r309), { lock: r309.lock });
    check("r309 parity: the server command tars only the four names, regular files only, read-only (no lock for R309: its unit uses flock -n)", /tar --format=ustar -cf - --null --no-recursion -T -/.test(rc) && ["r309-ledger.jsonl", "r309-cycles.jsonl", "r309-surge-hold48.json", "r309-interim.json"].every((f) => rc.includes(f)) && !/r309-HALT|r309-OFF|\.flock|\brm\b|\bmv\b|chmod|unlink|>/.test(rc), rc);

    // ── B. W1 kinds ──
    const W1 = loadManifest("w1", mdir), WH = W1.units["w1-whales"], FU = W1.units["w1-funding"], SO = W1.units["w1-social"];
    const H2 = path.join(tmp, "home2"); fs.mkdirSync(path.join(H2, "hyperliquid-whales"), { recursive: true }); fs.mkdirSync(path.join(H2, "social-mentions"));
    const w2 = (n, s) => { fs.mkdirSync(path.dirname(path.join(H2, n)), { recursive: true }); fs.writeFileSync(path.join(H2, n), s); }, r2 = (n) => fs.readFileSync(path.join(H2, n), "utf8"), ex2 = (n) => fs.existsSync(path.join(H2, n));
    w2("r309-HALT", "x\n"); w2("w1-whales-OFF", "off\n");
    const snapW = (day, o = {}) => JSON.stringify({ spec: "hyperliquid-whales-v1", day, recordedAt: day + "T21:31:00Z", accounts: [], positions: {}, errors: [], complete: true, ...o });
    w2("hyperliquid-whales/2026-10-08.json", snapW("2026-10-08")); w2("r323-ledger.jsonl", jl([{ kind: "interval", day: "2026-10-05" }])); w2("r323-state.json", "{}");
    const A = (def, files, o) => applyUnit(def, T(files), H2, o);
    const okW = A(WH, { "hyperliquid-whales/2026-10-08.json": snapW("2026-10-08"), "hyperliquid-whales/2026-10-10.json": snapW("2026-10-10"), "r323-ledger.jsonl": jl([{ kind: "interval", day: "2026-10-05" }, { kind: "interval", day: "2026-10-08" }]), "r323-state.json": JSON.stringify({ updatedAt: "x" }), "w1-run-whales.json": JSON.stringify({ ok: true }) });
    check("w1 whales: a new dated snapshot + an appended R323 ledger + state + run stamp -> pulled; the OFF switch untouched", okW.ok && ex2("hyperliquid-whales/2026-10-10.json") && r2("r323-ledger.jsonl").split("\n").filter(Boolean).length === 2 && ex2("w1-run-whales.json") && r2("w1-whales-OFF") === "off\n", JSON.stringify(okW));
    const refW = (name, files, re) => { const x = A(WH, files); check(name, !x.ok && re.test(x.why || ""), x.why); };
    const W2 = { "hyperliquid-whales/2026-10-08.json": snapW("2026-10-08"), "hyperliquid-whales/2026-10-10.json": snapW("2026-10-10"), "r323-ledger.jsonl": r2("r323-ledger.jsonl") };
    refW("w1 whales: a complete snapshot rewritten on the server -> refused", { ...W2, "hyperliquid-whales/2026-10-08.json": snapW("2026-10-08", { kept: 5 }) }, /complete on home, and the server's copy differs/);
    refW("w1 whales: a dated snapshot home holds is missing on the server -> refused", { "hyperliquid-whales/2026-10-10.json": snapW("2026-10-10"), "r323-ledger.jsonl": W2["r323-ledger.jsonl"] }, /2026-10-08\.json exists on home but not on the server/);
    refW("w1 whales: a file in the snapshot dir that is not a dated name -> refused (the server lists by glob; anything else is not ours)", { ...W2, "hyperliquid-whales/notes.json": "{}" }, /unexpected file/);
    refW("w1 whales: the R323 ledger not an extension of home's -> refused", { ...W2, "r323-ledger.jsonl": jl([{ kind: "interval", day: "2026-10-06" }]) }, /exact prefix/);
    refW("w1 whales: the hl-cache (seed-only) is never pulled -> refused in a pull tar", { ...W2, "training/r323/hl-cache/BTC-x.json": "{}" }, /unexpected file/);
    refW("w1 whales: a unit flock in the tar -> refused (never synced)", { ...W2, "w1-whales.flock": "" }, /never synced/);
    refW("w1 whales: r323-lock.json in the tar -> refused (never synced)", { ...W2, "r323-lock.json": "{}" }, /never synced/);
    { const inc = snapW("2026-10-11", { complete: false }); A(WH, { ...W2, "hyperliquid-whales/2026-10-11.json": inc }); const x = A(WH, { ...W2, "hyperliquid-whales/2026-10-11.json": snapW("2026-10-11") }); check("w1 whales: an INCOMPLETE snapshot may still be completed by a later run that UTC day -> accepted", x.ok && JSON.parse(r2("hyperliquid-whales/2026-10-11.json")).complete === true, x.why); }
    const store = (periods) => JSON.stringify({ started: "2026-07-28", periods });
    w2("funding-carry-store.json", store({ BTC: { 1: { f: 1, b: 2 }, 2: { f: 3, b: 4 } } })); w2("risk-policy.json", JSON.stringify({ current: { hardCeiling: 0.2 } }));
    const fOk = A(FU, { "funding-carry-store.json": store({ BTC: { 1: { f: 1, b: 2 }, 2: { f: 3, b: 4 }, 3: { f: 5, b: 6 } }, ETH: { 1: { f: 0, b: 0 } } }) });
    check("w1 funding: the store gained periods and a coin -> pulled", fOk.ok && JSON.parse(r2("funding-carry-store.json")).periods.BTC[3].f === 5, JSON.stringify(fOk));
    { const x = A(FU, { "funding-carry-store.json": store({ BTC: { 1: { f: 1, b: 2 }, 3: { f: 5, b: 6 } }, ETH: { 1: { f: 0, b: 0 } } }) }); check("w1 funding: a period home holds is missing on the server (a store restarted from scratch) -> refused", !x.ok && /not a superset/.test(x.why), x.why); }
    { const x = A(FU, { "funding-carry-store.json": store({ BTC: { 1: { f: 1, b: 9 }, 2: { f: 3, b: 4 }, 3: { f: 5, b: 6 } }, ETH: { 1: { f: 0, b: 0 } } }) }); check("w1 funding: a stored period's value changed -> refused", !x.ok && /1 changed/.test(x.why), x.why); }
    { const x = A(FU, { "risk-policy.json": "{}" }); check("w1 funding: risk-policy.json (a home input) is never pulled -> refused in a pull tar", !x.ok && /unexpected file/.test(x.why), x.why); }
    const so = (day, o = {}) => JSON.stringify({ spec: "social-mentions-v1", day, recordedAt: day + "T20:35:00Z", sources: {}, errors: [], complete: true, ...o });
    w2("social-mentions/2026-10-09.json", so("2026-10-09"));
    const sOk = A(SO, { "social-mentions/2026-10-09.json": so("2026-10-09"), "social-mentions/2026-10-10.json": so("2026-10-10"), "social-mentions/2026-10-11.json": so("2026-10-11") });
    check("w1 social: the weekend's two dated files -> pulled; the existing one unchanged", sOk.ok && ex2("social-mentions/2026-10-11.json") && sOk.actions.length === 2, JSON.stringify(sOk));
    // ── C. manifest load refuses never-sync and home-owned names ──
    const badM = (entries) => { try { checkManifest({ schema: "pull-manifest-v1", wave: "zz", remoteData: "/x", units: { u: { lock: null, entries } } }, "zz"); return null; } catch (e) { return e.message; } };
    const nevers = ["r309-HALT", "w1-whales-OFF", "TRAIDS_STOP", "x.lock", "w1-whales.flock", "r323-lock.json", ".schwab-token.json", "telegram-offset.json", ".env", "sub/TRAIDS_STOP"];
    check("manifest: every never-sync name (HALT, OFF, TRAIDS_STOP, *.lock, *.flock, *lock.json, .schwab-token.json, telegram-offset.json, .env) is refused at load", nevers.every((n) => /never synced|unsafe path/.test(badM([{ path: n, kind: "json" }]) || "")), nevers.map((n) => n + ": " + badM([{ path: n, kind: "json" }])).join(" | "));
    check("manifest: home-owned governance files (host-ownership, test-registry, read-seals, agent-ledger, change-registry, chain-status) are refused for pulls", ["host-ownership.json", "test-registry.json", "read-seals.json", "agent-ledger.jsonl", "change-registry.json", "chain-status.json"].every((n) => /home-owned/.test(badM([{ path: n, kind: "json" }]) || "")));
    check("manifest: unsafe paths (.., absolute, backslash) are refused", ["../x.json", "/etc/passwd", "a\\b.json", "a/../b.json"].every((n) => /unsafe path/.test(badM([{ path: n, kind: "json" }]) || "")));
    check("manifest: the shipped r309 and w1 manifests load", !!loadManifest("r309", mdir) && !!loadManifest("w1", mdir));
    // ── D. ownership-driven pullWave with a fake ssh ──
    const H3 = path.join(tmp, "home3"); fs.mkdirSync(H3); fs.writeFileSync(path.join(H3, "r309-HALT"), "x\n"); fs.writeFileSync(path.join(H3, "risk-policy.json"), JSON.stringify({ current: { hardCeiling: 0.2 } }));
    const mapOf = (units) => { fs.writeFileSync(path.join(H3, "host-ownership.json"), JSON.stringify({ schema: "host-ownership-v1", units })); };
    const calls = []; let srvFiles = {}, busyUnits = new Set(), probeOk = true; const srvInputs = {};   // the fake server: pulled files, input shas
    const fake = (script, o = {}) => {
      calls.push({ script, input: o.input ? o.input.length : 0 });
      if (script === "true") return probeOk ? { ok: true, status: 0, out: "", err: "" } : { ok: false, status: 255, out: "", err: "traids: Permission denied (publickey)." };
      if (/tar --format=ustar -cf -/.test(script)) { const lk = /exec 9>>'([^']+)'/.exec(script); if (lk && busyUnits.has(lk[1])) return { ok: false, status: 75, out: Buffer.alloc(0), err: "" }; const want = Object.entries(srvFiles).filter(([n]) => script.includes(n.split("/")[0])); return { ok: true, status: 0, out: T(Object.fromEntries(want)), err: "" }; }
      if (/sha256sum -- "\$f"/.test(script)) return { ok: true, status: 0, out: ["risk-policy.json"].map((f) => `${srvInputs[f] || "ABSENT"}  ${f}`).join("\n") + "\n", err: "" };
      if (/sha256sum -c/.test(script)) { const sh = script.split("EOF_SHA")[1].split("\n").filter((l) => /^[0-9a-f]{64}  /.test(l)); for (const l of sh) srvInputs[l.slice(66)] = l.slice(0, 64); return { ok: true, status: 0, out: `PUSHED ${sh.length}\n`, err: "" }; }
      return { ok: false, status: 1, out: "", err: "unexpected" };
    };
    mapOf({ "w1-whales": "home", "w1-funding": "home", "w1-social": "home" });
    let pw = pullWave("w1", { homeDir: H3, manifestDir: mdir, ssh: fake });
    check("ownership: every W1 unit home-owned -> nothing pulled, NO ssh call at all, exit 0", pw.exit === 0 && calls.length === 0 && Object.values(pw.units).every((u) => /home-owned/.test(u.result)), JSON.stringify(pw));
    srvFiles = { "social-mentions/2026-10-10.json": so("2026-10-10"), "funding-carry-store.json": store({ BTC: { 1: { f: 1, b: 2 } } }) };
    mapOf({ "w1-whales": "home", "w1-funding": "server", "w1-social": "server" });
    pw = pullWave("w1", { homeDir: H3, manifestDir: mdir, ssh: fake });
    check("ownership: only the server-owned units are pulled (funding, social); whales (home-owned) is not; risk-policy.json pushed read-only 0444", pw.exit === 0 && fs.existsSync(path.join(H3, "social-mentions/2026-10-10.json")) && fs.existsSync(path.join(H3, "funding-carry-store.json")) && /home-owned/.test(pw.units["w1-whales"].result) && calls.some((x) => /0444 risk-policy\.json/.test(x.script)) && !calls.some((x) => /hyperliquid-whales/.test(x.script)), JSON.stringify(pw));
    check("status file written atomically with the per-unit result", JSON.parse(fs.readFileSync(path.join(H3, "pull-server-status.json"), "utf8")).waves.w1.units["w1-social"].result === "pulled");
    check("inputs: after the push the server holds exactly home's risk-policy.json (verified by sha)", srvInputs["risk-policy.json"] === sha(fs.readFileSync(path.join(H3, "risk-policy.json"))));
    calls.length = 0;
    pw = pullWave("w1", { homeDir: H3, manifestDir: mdir, ssh: fake });
    check("inputs: risk-policy.json already current on the server -> not pushed again", pw.exit === 0 && !calls.some((x) => /sha256sum -c/.test(x.script)), JSON.stringify(pw.lines));
    busyUnits.add("w1-social.flock");
    pw = pullWave("w1", { homeDir: H3, manifestDir: mdir, ssh: fake });
    check("busy: a unit holding its lock on the server is skipped this pull, the others still pulled; main exits 3 (the chain shows WARN naming the unit)", pw.exit === 0 && /busy/.test(pw.units["w1-social"].result) && /no change|pulled/.test(pw.units["w1-funding"].result) && exitOf(pw).exit === 3 && /busy on the server[^]*w1-social/.test(exitOf(pw).warn || ""), JSON.stringify(pw.units));
    busyUnits.clear();
    // the S4U ssh probe: recorded per source, even while every unit is home-owned (the pull itself then makes no ssh)
    { mapOf({ "w1-whales": "home", "w1-funding": "home", "w1-social": "home" }); calls.length = 0; probeOk = true;
      const p1 = pullWave("w1", { homeDir: H3, manifestDir: mdir, ssh: fake, probeSsh: "preflight.bat" });
      const st1 = JSON.parse(fs.readFileSync(path.join(H3, "pull-server-status.json"), "utf8"));
      check("--probe-ssh preflight.bat: all home-owned -> exactly ONE ssh call (`true`), recorded as sshProbe['preflight.bat'] ok; exit 0", p1.exit === 0 && calls.length === 1 && calls[0].script === "true" && st1.sshProbe["preflight.bat"].ok === true && exitOf(p1).exit === 0, JSON.stringify(st1.sshProbe));
      probeOk = false;
      const p2 = pullWave("w1", { homeDir: H3, manifestDir: mdir, ssh: fake, probeSsh: "close-chain" });
      const st2 = JSON.parse(fs.readFileSync(path.join(H3, "pull-server-status.json"), "utf8"));
      check("--probe-ssh close-chain failing -> recorded ok:false with the reason, the other source kept; main exits 3 (WARN)", st2.sshProbe["close-chain"].ok === false && /Permission denied/.test(st2.sshProbe["close-chain"].why) && st2.sshProbe["preflight.bat"].ok === true && exitOf(p2).exit === 3, JSON.stringify(st2.sshProbe));
      probeOk = true;
      check("--probe-ssh with another source name -> refused (exit 1)", pullWave("w1", { homeDir: H3, manifestDir: mdir, ssh: fake, probeSsh: "anything" }).exit === 1);
      mapOf({ "w1-whales": "home", "w1-funding": "server", "w1-social": "server" }); }
    { const dead = (script) => { calls.push({ script }); return { ok: false, status: 255, out: Buffer.alloc(0), err: "ssh: connect to host traids port 22: Connection timed out" }; }; calls.length = 0;
      const pd = pullWave("w1", { homeDir: H3, manifestDir: mdir, ssh: dead });
      check("unreachable: ssh exit 255 on the first server-owned unit -> the others are not tried (bounded time), exit 1", pd.exit === 1 && calls.length === 1 && /unreachable/.test(pd.lines.join(" ")) && Object.values(pd.units).filter((x) => /unreachable/.test(x.result)).length === 1, JSON.stringify(pd)); }
    mapOf({ "w1-funding": "server" });
    pw = pullWave("w1", { homeDir: H3, manifestDir: mdir, ssh: fake });
    check("ownership: a unit the map does not name -> error for that unit (exit 1), never a guess", pw.exit === 1 && /does not name w1-social/.test(pw.units["w1-social"].result), JSON.stringify(pw.units));
    fs.writeFileSync(path.join(H3, "host-ownership.json"), "{ torn"); calls.length = 0;
    pw = pullWave("w1", { homeDir: H3, manifestDir: mdir, ssh: fake });
    check("ownership: an unreadable map -> nothing pulled, no ssh, exit 1", pw.exit === 1 && calls.length === 0 && Object.values(pw.units).every((u) => /ownership unknown|does not parse/.test(u.result) || /error/.test(u.result)), JSON.stringify(pw.units));
    mapOf({ "w1-whales": "server", "w1-funding": "server", "w1-social": "server" });
    fs.writeFileSync(path.join(H3, "pull-server.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), what: "other" }));   // a LIVE holder
    pw = pullWave("w1", { homeDir: H3, manifestDir: mdir, ssh: fake });
    check("home lock: a second concurrent run (live holder) is skipped, touching nothing; main exits 3 (WARN, never a quiet ok)", pw.exit === 0 && pw.busy === true && exitOf(pw).exit === 3 && /held the home lock/.test(exitOf(pw).warn || ""), JSON.stringify(pw));
    fs.unlinkSync(path.join(H3, "pull-server.lock"));
    { const dead = cp.spawnSync(process.execPath, ["-e", "0"]).pid;   // a pid that has exited (e.g. a pull the chain SIGKILLed)
      fs.writeFileSync(path.join(H3, "pull-server.lock"), JSON.stringify({ pid: dead, at: new Date().toISOString(), what: "killed pull" }));
      const pk = pullWave("w1", { homeDir: H3, manifestDir: mdir, ssh: fake });
      check("home lock: a lock left by a DEAD process is replaced at once (not 30 min of skipped pulls); released after", !pidAlive(dead) && !pk.busy && pk.exit === 0 && !fs.existsSync(path.join(H3, "pull-server.lock")), JSON.stringify(pk.lines)); }
    const before = fs.readdirSync(H3).sort().join(","); fs.unlinkSync(path.join(H3, "r309-HALT"));
    pw = pullWave("w1", { homeDir: H3, manifestDir: mdir, ssh: fake });
    check("halt: home r309-HALT missing -> exit 4 for ANY wave, nothing touched", pw.exit === 4 && fs.readdirSync(H3).sort().join(",") === before.split(",").filter((x) => x !== "r309-HALT").join(","), JSON.stringify(pw));
    fs.writeFileSync(path.join(H3, "r309-HALT"), "x\n");
    const sw0 = ["r309-HALT"].map((f) => fs.readFileSync(path.join(H3, f), "utf8")).join("|"); fs.writeFileSync(path.join(H3, "w1-social-OFF"), "o"); fs.writeFileSync(path.join(H3, "TRAIDS_STOP"), "s");
    srvFiles = { ...srvFiles, "social-mentions/2026-10-11.json": so("2026-10-11") };
    pw = pullWave("w1", { homeDir: H3, manifestDir: mdir, ssh: fake });
    check("switch files: a real pull never touches r309-HALT, w1-*-OFF or TRAIDS_STOP at home", pw.exit === 0 && fs.readFileSync(path.join(H3, "r309-HALT"), "utf8") === sw0 && fs.readFileSync(path.join(H3, "w1-social-OFF"), "utf8") === "o" && fs.readFileSync(path.join(H3, "TRAIDS_STOP"), "utf8") === "s", JSON.stringify(pw.lines));
    const dryBefore = fs.readdirSync(H3).sort().join(","); srvFiles["social-mentions/2026-10-12.json"] = so("2026-10-12");
    pw = pullWave("w1", { homeDir: H3, manifestDir: mdir, ssh: fake, dry: true });
    check("--dry: validates, plans, writes nothing at home (no file, no status, no lock), pushes nothing", pw.exit === 0 && fs.readdirSync(H3).sort().join(",") === dryBefore && !fs.existsSync(path.join(H3, "social-mentions/2026-10-12.json")) && /would update/.test(pw.lines.join(" ")), JSON.stringify(pw.lines));
    // ── E. seed mode (the cutover's push: the server's copy must be a prefix / subset of home's) ──
    const homeF = readLocal(seedEntries(WH), H2), srvOld = new Map([["hyperliquid-whales/2026-10-08.json", homeF.get("hyperliquid-whales/2026-10-08.json")], ["r323-ledger.jsonl", Buffer.from(jl([{ kind: "interval", day: "2026-10-05" }]))]]);
    const sp = checkGrowth(seedEntries(WH), srvOld, homeF, { mode: "seed" });
    check("seed: the server's older seed is a subset of home's -> plan pushes only what changed", sp.filter((x) => x.changed).map((x) => x.rel).includes("hyperliquid-whales/2026-10-10.json") && !sp.filter((x) => x.changed).some((x) => x.rel === "hyperliquid-whales/2026-10-08.json"), JSON.stringify(sp.map((x) => x.rel + ":" + x.changed)));
    let se = null; try { checkGrowth(seedEntries(WH), new Map([...srvOld, ["hyperliquid-whales/2026-10-13.json", Buffer.from(snapW("2026-10-13"))]]), homeF, { mode: "seed" }); } catch (e) { se = e.message; }
    check("seed: the server holds a snapshot home does not (it ran after a rollback without a pull) -> refused", /2026-10-13\.json exists on the server but not on home/.test(se || ""), se);
    se = null; try { checkGrowth(seedEntries(WH), new Map([["r323-ledger.jsonl", Buffer.from(jl([{ kind: "interval", day: "2026-10-05" }, { kind: "interval", day: "2026-10-08" }, { kind: "gap", day: "2026-10-09" }]))]]), homeF, { mode: "seed" }); } catch (e) { se = e.message; }
    check("seed: the server's R323 ledger is longer than home's -> refused", /exact prefix/.test(se || ""), se);
    const cacheP = checkGrowth([{ ...WH.entries.find((e) => e.cache) }], new Map([["training/r323/hl-cache/BTC-a.json", Buffer.from("{\"v\":2}")]]), new Map([["training/r323/hl-cache/BTC-a.json", Buffer.from("{\"v\":1}")], ["training/r323/hl-cache/ETH-b.json", Buffer.from("{}")]]), { mode: "seed" });
    check("seed: the hl-cache adds files the server lacks and never overwrites one it has", cacheP.length === 1 && cacheP[0].rel === "training/r323/hl-cache/ETH-b.json");
    const pc = remotePushCommand("/home/traids/traids/backend/data", [{ rel: "risk-policy.json", data: Buffer.from("{}"), mode: "0444" }], { lock: "w1-funding.flock" });
    check("push command: staged in the data dir, sha256-verified BEFORE any rename, chmod 0444, per-file mv, under the unit lock", /mktemp -d "\$D\/\.push-stage-/.test(pc) && pc.indexOf("sha256sum -c") < pc.indexOf("mv -f") && /0444 risk-policy\.json/.test(pc) && /flock -w 60 9/.test(pc));
    let pe = null; try { remotePushCommand("/x", [{ rel: "r309-HALT", data: Buffer.from(""), mode: "0644" }]); } catch (e) { pe = e.message; }
    check("push command: refuses a switch file", /refusing to push r309-HALT/.test(pe || ""));
    const wc = remoteTarCommand("/home/traids/traids/backend/data", pullEntries(WH), { lock: WH.lock, lockWait: 20 });
    check("w1 server command: under the unit's flock (-w, exit 75 when busy), find by dated glob, regular files only, never rm/mv/chmod", /exec 9>>'w1-whales\.flock' && flock -w 20 9 \|\| exit 75/.test(wc) && /find 'hyperliquid-whales' -mindepth 1 -maxdepth 1 -type f -name/.test(wc) && !/hl-cache/.test(wc) && !/\brm\b|\bmv\b|chmod|unlink/.test(wc), wc);
    // ── F. the close chain obeys the map (text only) ──
    const defs = Object.entries(W1.units);
    const chainOk = ["const STEPS = [",
      '  ["funding carry collector (#55)", "backend/funding-carry-v2.js", 6, { ownedBy: "w1-funding" }],',
      '  ["social mentions record", "backend/social-mentions-record.js", 2, { allowExit: [1], ownedBy: "w1-social" }],   // a comment',
      '  ["hyperliquid whales record", "backend/hyperliquid-whales-record.js", 5, { allowExit: [1], ownedBy: "w1-whales" }],',
      '  ["r323 hl copy leaders (score)", "backend/r323-hl-copy-leaders.js", 25, { args: ["--score"], allowExit: [4], ownedBy: "w1-whales" }],',
      "];", "  if (opts.ownedBy) {", '    if (owner === "server") { status.steps.push({ name, skipped: true, ownedBy: opts.ownedBy, why: "skipped (server-owned)" }); continue; }', "  }"].join("\n");
    check("chain tags: the tagged chain + the runner block -> no issue", chainTagIssues(chainOk, defs).length === 0, chainTagIssues(chainOk, defs).join(" | "));
    check("chain tags: a later edit drops a tag -> named (home would run it)", /"social mentions record" is not tagged ownedBy: "w1-social"/.test(chainTagIssues(chainOk.replace(', ownedBy: "w1-social"', ""), defs).join(" | ")));
    check("chain tags: a recorder re-added on a second, untagged line -> named", /backend\/hyperliquid-whales-record\.js without ownedBy/.test(chainTagIssues(chainOk.replace("];", '  ["whales again", "backend/hyperliquid-whales-record.js", 5],\n];'), defs).join(" | ")));
    check("chain tags: the runner's ownership block gone -> named; an unreadable chain -> named", /ownership check/.test(chainTagIssues(chainOk.replace("  if (opts.ownedBy) {", "  if (false) {"), defs).join(" | ")) && /could not be read/.test(chainTagIssues(null, defs).join("")));
    check("chain tags: a commented-out copy of a step line is not a step line", chainTagIssues(chainOk.replace("];", '  // ["social mentions record", "backend/social-mentions-record.js", 2],\n];'), defs).length === 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`pull-server selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

function main() {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf("--" + k); return i >= 0 ? a[i + 1] : undefined; };
  const stamp = () => new Date().toISOString();
  const known = new Set(["--wave", "--dry", "--host", "--lock-wait", "--status", "--selftest", "--probe-ssh"]);
  for (let i = 0; i < a.length; i++) { if (!known.has(a[i])) { console.error(`pull-server: unknown argument ${JSON.stringify(a[i])} — nothing done`); process.exitCode = 2; return; } if (["--wave", "--host", "--lock-wait", "--probe-ssh"].includes(a[i])) i++; }
  if (a.includes("--selftest")) { process.exitCode = selftest() ? 0 : 1; return; }
  if (!REPO) { console.error("pull-server: repo root not found above " + __dirname); process.exitCode = 2; return; }
  if (a.includes("--status")) { try { console.log(fs.readFileSync(path.join(HOME_DATA, "pull-server-status.json"), "utf8")); } catch { console.log("no pull-server-status.json yet"); } process.exitCode = 0; return; }
  const waves = String(opt("wave") || "").split(",").filter(Boolean), lockWait = Number(opt("lock-wait") || 20), host = opt("host") || HOST;
  if (!waves.length || !waves.every((w) => /^[a-z0-9-]+$/.test(w))) { console.error("pull-server: --wave <id>[,<id>] is required (e.g. --wave w1)"); process.exitCode = 2; return; }
  if (!(lockWait >= 1 && lockWait <= 3600)) { console.error("pull-server: --lock-wait must be 1..3600 s"); process.exitCode = 2; return; }
  const probeFrom = opt("probe-ssh");
  if (a.includes("--probe-ssh") && !PROBE_FROM.test(String(probeFrom || ""))) { console.error("pull-server: --probe-ssh needs preflight.bat or close-chain"); process.exitCode = 2; return; }
  let exit = 0; const warns = [];
  for (const [i, w] of waves.entries()) {
    const r = pullWave(w, { host, dry: a.includes("--dry"), lockWait, probeSsh: i === 0 ? probeFrom || null : null });
    for (const l of r.lines) console.log(`[${stamp()}] pull-server ${a.includes("--dry") ? "DRY " : ""}${w}: ${l}`);
    const e = exitOf(r); if (e.warn) warns.push(`${w}: ${e.warn}`);
    const SEV = { 0: 0, 3: 1, 1: 2, 4: 3 };   // severity: HALT (4) > refused / failed (1) > WARN (3) > ok (0)
    if ((SEV[e.exit] ?? 2) > (SEV[exit] ?? 2)) exit = e.exit;
    if (r.exit === 4) break;
  }
  // the chain records exit 3 as WARN with the last stderr line: make that line say what was skipped
  if (warns.length && exit === 3) console.error(`pull-server WARN: ${warns.join(" | ")}`);
  process.exitCode = exit;
}

if (require.main === module) main();
module.exports = { SCRIPT_MAX, chunkByScript, remoteShasCommand, remoteShasChunked, pushChunked, loadManifest, checkManifest, readMap, ownerOf, untar, tarOf, checkGrowth, readLocal, tarFiles, applyUnit, remoteTarCommand, remotePushCommand, fetchRemote, pushRemote, remoteShas, pushInputs, pullWave, exitOf, sshProbe, chainTagIssues, takeLock, dropLock, pidAlive, sshReal, pullEntries, seedEntries, inputEntries, owns, isNever, sha, q, REPO, HOME_DATA, MANIFEST_DIR, NEVER, HOME_ONLY };
