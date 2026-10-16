#!/usr/bin/env node
/**
 * PULL R309 — server -> home, one way. 2026-10-06 (replaces deploy/server/pull-r309.cjs, review finding F1).
 *
 * The VPS (`ssh traids`, /home/traids/traids/backend/data) is the ONE home of R309's run files: it alone runs `--cycle`. The PC
 * keeps read-only copies for its readers (status pages, the adjudicator, the nightly git snapshot, the eventual --read).
 *
 * EXACTLY FOUR FILES: r309-ledger.jsonl · r309-cycles.jsonl · r309-surge-hold48.json · r309-interim.json. One server-side
 * `tar` of just those (a missing one is skipped, not an error; symlinks are never packed). NEVER r309-HALT, r309-OFF,
 * r309.lock or r309.flock, in either direction: home's backend/data/r309-HALT is the backstop that keeps the PC from ever
 * sending for R309 and it must exist before AND after every pull (the old pull deleted it when the server had none).
 *
 * VALIDATED BEFORE ANYTHING IS RENAMED IN (any failure -> nothing written, exit 1, the next pull retries):
 *   tar         plain ustar regular files only, names exactly from the set, no duplicates, checksums good
 *   cycles      append-only (r309 appends one row per live cycle): the home copy must be an EXACT BYTE PREFIX of the server's,
 *               and every server line must parse (a row caught mid-append refuses this pull)
 *   ledger      rewritten in place by r309 (lot rows change as orders fill), so NOT a prefix: every line parses; the server's ids
 *               are a superset of home's; each row's immutable fields are unchanged (the signal, the twin draw, the entry intent;
 *               the entry fill once the lot was filled at home; the exit and net once closed at home; a missed row entirely);
 *               a lot's status only moves forward (submitting -> submitted/open/... -> closed; never back)
 *   json        parse; r309-surge-hold48.json's config.evidenceStart and read, once set at home, never change
 * then each file is renamed atomically (same directory) into backend/data. --dry stages and validates in a temp directory
 * and renames nothing.
 *
 *   node deploy/server/pull-r309.cjs [--dry] [--host traids] [--remote-dir /home/traids/traids/backend/data]
 *   node deploy/server/pull-r309.cjs --selftest       (temp directories only; no ssh, no repo file)
 * (the same file is staged as docs/server/phase0-golive/pull-r309.cjs; deploy.cjs puts it at deploy/server/pull-r309.cjs.)
 * Hourly: deploy\server\pull-r309.bat from the scheduled task "TRAIDS R309 Pull" (docs/server/phase0-golive/make-pull-task.cjs builds
 * it; Josh creates it) -> automation\r309-pull.log; the .bat then runs backend\lib\r309-health.cjs --alert --pull-rc <this exit code>.
 * Exit 0 pulled (or nothing to do) · 1 refused / ssh failed (nothing written) · 4 home r309-HALT missing (refused, or vanished).
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");

const FILES = ["r309-ledger.jsonl", "r309-cycles.jsonl", "r309-surge-hold48.json", "r309-interim.json"];
const NEVER = ["r309-HALT", "r309-OFF", "r309.lock", "r309.flock"];
// the repo root: the nearest ancestor holding both backend/data and deploy/ (works from docs/server/phase0-golive and deploy/server)
const REPO = (() => { for (let d = __dirname; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, "backend", "data")) && fs.existsSync(path.join(d, "deploy"))) return d; if (path.dirname(d) === d) throw new Error("pull-r309: repo root not found above " + __dirname); } })();
const HOME_DATA = path.join(REPO, "backend", "data");
const DEFAULT_REMOTE = "/home/traids/traids/backend/data";

// ── ustar (read and, for the selftest, write) ───────────────────────────────────────────────────────────────────────────────
function untar(buf) {
  const out = [];
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;                                                  // end-of-archive block
    const str = (a, b) => h.subarray(a, b).toString("latin1").replace(/\0[\s\S]*$/, "");
    const name = str(0, 100), size = parseInt(str(124, 136).trim() || "0", 8), type = String.fromCharCode(h[156] || 48), prefix = str(345, 500);
    const sum = parseInt(str(148, 156).trim(), 8); let calc = 0; for (let i = 0; i < 512; i++) calc += i >= 148 && i < 156 ? 32 : h[i];
    if (!Number.isFinite(sum) || sum !== calc) throw new Error(`tar header checksum mismatch at offset ${off}`);
    if (!/^ustar/.test(str(257, 263))) throw new Error(`not a ustar header at offset ${off}`);
    if (type !== "0" && type !== "\0") throw new Error(`tar entry ${JSON.stringify(name)} is type ${JSON.stringify(type)} — only regular files are accepted`);
    if (!Number.isFinite(size) || size < 0) throw new Error(`tar entry ${JSON.stringify(name)}: bad size`);
    const full = (prefix ? prefix + "/" : "") + name, start = off + 512;
    if (start + size > buf.length) throw new Error(`tar entry ${JSON.stringify(full)} truncated`);
    out.push({ name: full, data: Buffer.from(buf.subarray(start, start + size)) });
    off = start + Math.ceil(size / 512) * 512;
  }
  return out;
}
function tarOf(entries) {   // selftest only: a minimal ustar writer (entries: [{ name, data, type? }])
  const blocks = [];
  for (const e of entries) {
    const h = Buffer.alloc(512), data = Buffer.from(e.data || "");
    h.write(e.name, 0, 100, "latin1"); h.write("0000644\0", 100); h.write("0001750\0", 108); h.write("0001750\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124); h.write("15000000000\0", 136); h.write("        ", 148);
    h.write(e.type || "0", 156); h.write("ustar\0", 257); h.write("00", 263);
    let s = 0; for (let i = 0; i < 512; i++) s += h[i]; h.write(s.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// ── validation (pure) ───────────────────────────────────────────────────────────────────────────────────────────────────────
const linesOf = (buf) => buf.toString("utf8").split("\n").filter((l) => l.trim());
function parseLines(name, buf) {
  const txt = buf.toString("utf8");
  if (txt.length && !txt.endsWith("\n")) throw new Error(`${name}: the last line has no newline (caught mid-write?)`);
  return linesOf(buf).map((l, i) => { try { return JSON.parse(l); } catch { throw new Error(`${name}: line ${i + 1} does not parse`); } });
}
const get = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const IMMUTABLE = ["kind", "id", "coin", "signalHour", "day", "signalClose", "stats", "twin.hour", "twin.seedKey", "twin.seed", "twin.entryClose", "twin.exitHour", "twin.poolSize", "shadow.exitHour", "entry.cid", "entry.notionalOrdered", "entry.submittedAt"];
const ONCE_FILLED = ["entry.avgPx", "entry.filledQty", "entry.filledAt", "entry.orderId"];
const ONCE_CLOSED = ["net", "gross", "holdHours", "exit.avgPx", "exit.soldQty", "exit.filledAt"];
const FILLED = new Set(["open", "exiting", "closed", "error"]);
/** lot status -> the statuses it may move to (itself included). "error" may resolve (N13 retries); nothing goes back to an entry state. */
const NEXT = {
  "submitting": ["submitting", "submit-error", "submitted", "open", "unfilled", "not-sent", "missed"],
  "submit-error": ["submit-error", "submitted", "open", "unfilled", "not-sent"],
  "submitted": ["submitted", "open", "unfilled", "not-sent"],
  "open": ["open", "exiting", "closed", "error"],
  "exiting": ["exiting", "closed", "error"],
  "error": ["error", "exiting", "closed"],
  "closed": ["closed"], "unfilled": ["unfilled"], "not-sent": ["not-sent"], "missed": ["missed"],
};
function checkLedger(homeRows, serverRows) {
  const ids = new Map(); for (const r of serverRows) { if (!r || !r.id) throw new Error("ledger: a server row has no id"); if (ids.has(r.id)) throw new Error(`ledger: duplicate id ${r.id} on the server`); ids.set(r.id, r); }
  for (const h of homeRows) {
    const s = ids.get(h.id);
    if (!s) throw new Error(`ledger: ${h.id} is at home but not on the server (ids must only grow)`);
    if (h.kind !== "lot") { if (!same(h, s)) throw new Error(`ledger: ${h.kind} row ${h.id} changed (it is immutable)`); continue; }
    for (const p of IMMUTABLE) if (!same(get(h, p), get(s, p))) throw new Error(`ledger: ${h.id} immutable field ${p} changed (${JSON.stringify(get(h, p))} -> ${JSON.stringify(get(s, p))})`);
    if (FILLED.has(h.status)) for (const p of ONCE_FILLED) if (!same(get(h, p), get(s, p))) throw new Error(`ledger: ${h.id} entry fill field ${p} changed after the fill`);
    if (h.status === "closed") for (const p of ONCE_CLOSED) if (!same(get(h, p), get(s, p))) throw new Error(`ledger: ${h.id} closed-lot field ${p} changed after the close`);
    if (h.twin && h.twin.net != null && !same(h.twin.net, s.twin && s.twin.net)) throw new Error(`ledger: ${h.id} twin.net changed after it settled`);
    const allowed = NEXT[h.status];
    if (!allowed) throw new Error(`ledger: ${h.id} has an unknown status ${JSON.stringify(h.status)} at home`);
    if (!allowed.includes(s.status)) throw new Error(`ledger: ${h.id} status ${h.status} -> ${s.status} moves backward`);
  }
  return { rows: serverRows.length, newIds: serverRows.length - homeRows.length };
}
function checkStatusJson(homeObj, serverObj) {
  const hc = (homeObj && homeObj.config) || {}, sc = (serverObj && serverObj.config) || {};
  if (hc.evidenceStart && hc.evidenceStart !== sc.evidenceStart) throw new Error(`r309-surge-hold48.json: evidenceStart ${hc.evidenceStart} at home -> ${JSON.stringify(sc.evidenceStart)} on the server (it never changes once set)`);
  if (homeObj && homeObj.read && !same(homeObj.read, serverObj && serverObj.read)) throw new Error("r309-surge-hold48.json: the sealed read changed");
}
/** Validate the server's files against the home copies. entries: [{ name, data }]. Returns the plan; throws on any refusal. */
function validate(entries, homeDir) {
  const seen = new Map();
  for (const e of entries) {
    if (!FILES.includes(e.name)) throw new Error(`unexpected file ${JSON.stringify(e.name)} in the server's tar — only ${FILES.join(", ")} are pulled`);
    if (seen.has(e.name)) throw new Error(`duplicate ${e.name} in the tar`);
    seen.set(e.name, e.data);
  }
  const home = (n) => { const p = path.join(homeDir, n); return fs.existsSync(p) ? fs.readFileSync(p) : null; };
  const plan = [];
  for (const name of FILES) {
    const srv = seen.get(name), hm = home(name);
    if (!srv) { if (hm && (name === "r309-ledger.jsonl" || name === "r309-cycles.jsonl")) throw new Error(`${name} exists at home but not on the server (wrong host, or a reset on the server?)`); continue; }
    if (name === "r309-cycles.jsonl") {
      parseLines(name, srv);
      if (hm && !(srv.length >= hm.length && srv.subarray(0, hm.length).equals(hm))) throw new Error(`${name}: the home copy (${hm.length} bytes) is not an exact prefix of the server's (${srv.length} bytes) — the log is append-only`);
    } else if (name === "r309-ledger.jsonl") {
      const s = parseLines(name, srv), h = hm ? parseLines(name + " (home)", hm) : [];
      checkLedger(h, s);
    } else {
      let so; try { so = JSON.parse(srv.toString("utf8")); } catch (e) { throw new Error(`${name}: not valid JSON (${e.message.slice(0, 60)})`); }
      if (name === "r309-surge-hold48.json" && hm) { let ho = null; try { ho = JSON.parse(hm.toString("utf8")); } catch { ho = null; } checkStatusJson(ho, so); }
    }
    plan.push({ name, data: srv, changed: !(hm && hm.equals(srv)) });
  }
  return plan;
}

/** Stage + validate + (unless dry) rename into homeDir. Never touches anything but the four names; asserts HALT before and after. */
function applyPull(tarBuf, homeDir, { dry = false, requireHalt = true } = {}) {
  const halt = path.join(homeDir, "r309-HALT");
  if (requireHalt && !fs.existsSync(halt)) return { ok: false, code: 4, why: "home backend/data/r309-HALT is missing — refusing to pull (it is the backstop that keeps the PC from sending for R309; restore it first)" };
  let plan;
  try { plan = validate(untar(tarBuf), homeDir); } catch (e) { return { ok: false, code: 1, why: e.message }; }
  const stage = dry ? fs.mkdtempSync(path.join(os.tmpdir(), "r309-pull-")) : fs.mkdtempSync(path.join(homeDir, ".r309-pull-stage-"));
  const actions = [];
  try {
    for (const p of plan) { const f = path.join(stage, p.name), fd = fs.openSync(f, "w"); try { fs.writeFileSync(fd, p.data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    for (const p of plan) {   // re-read what was staged and compare before it goes live
      if (!fs.readFileSync(path.join(stage, p.name)).equals(p.data)) return { ok: false, code: 1, why: `${p.name}: staged copy differs from what was received` };
    }
    for (const p of plan) {
      if (!p.changed) continue;
      actions.push(`${dry ? "would update" : "update"} ${p.name} (${p.data.length} bytes)`);
      if (!dry) fs.renameSync(path.join(stage, p.name), path.join(homeDir, p.name));
    }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  if (requireHalt && !fs.existsSync(halt)) return { ok: false, code: 4, why: "home backend/data/r309-HALT VANISHED during the pull — restore it now", actions };
  return { ok: true, code: 0, actions, files: plan.map((p) => p.name) };
}

function remoteCommand(dir) {
  // read-only on the server: lists the four names that exist as regular files (never a symlink) and tars only those
  return `cd '${dir}' || exit 7; set --; for f in ${FILES.join(" ")}; do if [ -f "$f" ] && [ ! -L "$f" ]; then set -- "$@" "$f"; fi; done; ` +
    `if [ $# -gt 0 ]; then tar --format=ustar -cf - -- "$@"; fi`;
}

function selftest() {
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail ? " — " + detail : "")); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r309-pull-selftest-"));
  const H = path.join(tmp, "home"); fs.mkdirSync(H);
  const w = (n, s) => fs.writeFileSync(path.join(H, n), s), r = (n) => fs.readFileSync(path.join(H, n), "utf8"), ex = (n) => fs.existsSync(path.join(H, n));
  const lot = (o = {}) => ({ kind: "lot", id: "r309-BTC-2026101013", coin: "BTC", day: "2026-10-10", signalHour: "2026-10-10T13:00:00Z", signalClose: 100, stats: { ret: 0.1 }, twin: { hour: "2026-10-09T02:00:00Z", seedKey: "k", seed: 1, entryClose: 99, exitHour: "2026-10-11T02:00:00Z", poolSize: 60, net: null }, shadow: { exitHour: "2026-10-12T13:00:00Z" }, entry: { cid: "r309-BTC-2026101013-B", notionalOrdered: 2000, submittedAt: "2026-10-10T14:02:31Z" }, exit: { legs: [] }, status: "submitting", notes: [], ...o });
  const jl = (rows) => rows.map((x) => JSON.stringify(x)).join("\n") + "\n";
  const cyc1 = jl([{ ts: "a", live: true }]), cyc2 = cyc1 + jl([{ ts: "b", live: true }]);
  const T = (files) => tarOf(Object.entries(files).map(([name, data]) => ({ name, data })));
  try {
    console.log("pull-r309 selftest (" + tmp + ")");
    w("r309-HALT", "home backstop\n"); w("r309-OFF", "home off\n"); w("seat-claims.jsonl", "untouched\n");
    const t1 = T({ "r309-cycles.jsonl": cyc1, "r309-ledger.jsonl": jl([lot()]), "r309-surge-hold48.json": JSON.stringify({ config: { evidenceStart: null } }) });
    const d = applyPull(t1, H, { dry: true });
    check("dry: validates and plans, renames nothing", d.ok && d.actions.length === 3 && !ex("r309-cycles.jsonl") && !ex("r309-ledger.jsonl"), JSON.stringify(d));
    const a = applyPull(t1, H);
    check("first pull: the three present files land; r309-interim.json absent on the server is skipped", a.ok && r("r309-cycles.jsonl") === cyc1 && ex("r309-ledger.jsonl") && !ex("r309-interim.json"), JSON.stringify(a));
    check("HALT, OFF and other files untouched; no stage directory left behind", r("r309-HALT") === "home backstop\n" && r("r309-OFF") === "home off\n" && r("seat-claims.jsonl") === "untouched\n" && !fs.readdirSync(H).some((f) => f.startsWith(".r309-pull-stage")));
    check("the same tar again: nothing to do", applyPull(t1, H).actions.length === 0);
    const filled = lot({ status: "open", entry: { ...lot().entry, avgPx: 101, filledQty: "0.0198", filledAt: "2026-10-10T14:02:33Z", orderId: "o1" } });
    const t2 = T({ "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([filled, { kind: "missed", id: "r309-ETH-2026101015", day: "2026-10-10", reason: "late" }]) });
    const b = applyPull(t2, H);
    check("append + a lot rewritten in place (submitting -> open) + a new missed row: accepted", b.ok && r("r309-cycles.jsonl") === cyc2 && JSON.parse(r("r309-ledger.jsonl").split("\n")[0]).status === "open", JSON.stringify(b));
    const refuse = (name, files, re) => { const before = fs.readdirSync(H).map((f) => f + ":" + fs.readFileSync(path.join(H, f)).length).join(","); const x = applyPull(T(files), H); const after = fs.readdirSync(H).map((f) => f + ":" + fs.readFileSync(path.join(H, f)).length).join(","); check(name, !x.ok && re.test(x.why || "") && before === after, x.why); };
    refuse("cycles: a server log that is not an extension of home's (an edited row) -> refused, nothing written", { "r309-cycles.jsonl": jl([{ ts: "a", live: false }]) + jl([{ ts: "b", live: true }, { ts: "c" }]), "r309-ledger.jsonl": jl([filled, { kind: "missed", id: "r309-ETH-2026101015", day: "2026-10-10", reason: "late" }]) }, /exact prefix/);
    refuse("cycles: shorter than home (a reset) -> refused", { "r309-cycles.jsonl": cyc1, "r309-ledger.jsonl": jl([filled, { kind: "missed", id: "r309-ETH-2026101015", day: "2026-10-10", reason: "late" }]) }, /exact prefix/);
    const LED = jl([filled, { kind: "missed", id: "r309-ETH-2026101015", day: "2026-10-10", reason: "late" }]);
    refuse("cycles: a row caught mid-append (no newline) -> refused", { "r309-cycles.jsonl": cyc2 + '{"ts":"c"', "r309-ledger.jsonl": LED }, /mid-write|does not parse/);
    refuse("ledger: an id that disappeared -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([filled]) }, /not on the server/);
    refuse("ledger: an immutable field changed (signal close) -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([{ ...filled, signalClose: 101 }, { kind: "missed", id: "r309-ETH-2026101015", day: "2026-10-10", reason: "late" }]) }, /immutable field signalClose/);
    refuse("ledger: the twin draw changed -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([{ ...filled, twin: { ...filled.twin, hour: "2026-10-09T03:00:00Z" } }, { kind: "missed", id: "r309-ETH-2026101015", day: "2026-10-10", reason: "late" }]) }, /twin\.hour/);
    refuse("ledger: the entry fill price changed after the fill -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([{ ...filled, entry: { ...filled.entry, avgPx: 102 } }, { kind: "missed", id: "r309-ETH-2026101015", day: "2026-10-10", reason: "late" }]) }, /entry\.avgPx/);
    refuse("ledger: status moved backward (open -> submitted) -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([{ ...filled, status: "submitted" }, { kind: "missed", id: "r309-ETH-2026101015", day: "2026-10-10", reason: "late" }]) }, /moves backward/);
    refuse("ledger: a missed row edited -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([filled, { kind: "missed", id: "r309-ETH-2026101015", day: "2026-10-10", reason: "OFF" }]) }, /immutable/);
    refuse("ledger: a torn line -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([filled]) + "{\"kind\":\"lot\"\n" }, /does not parse/);
    refuse("json: r309-interim.json that does not parse -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": LED, "r309-interim.json": "{ half" }, /not valid JSON/);
    refuse("a file outside the four (r309-HALT) inside the tar -> refused", { "r309-cycles.jsonl": cyc2, "r309-HALT": "x" }, /unexpected file "r309-HALT"/);
    { const x = applyPull(tarOf([{ name: "r309-cycles.jsonl", data: "", type: "2" }]), H); check("a symlink entry in the tar -> refused", !x.ok && /only regular files/.test(x.why), x.why); }
    { const bad = Buffer.from(T({ "r309-cycles.jsonl": cyc2 })); bad[10] ^= 1; const x = applyPull(bad, H); check("a corrupted tar header -> refused", !x.ok && /checksum/.test(x.why), x.why); }
    w("r309-surge-hold48.json", JSON.stringify({ config: { evidenceStart: "2026-10-12" } }));
    refuse("json: evidenceStart set at home changed on the server -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": LED, "r309-surge-hold48.json": JSON.stringify({ config: { evidenceStart: "2026-10-13" } }) }, /evidenceStart/);
    const closed = { ...filled, status: "closed", net: 0.01, gross: 0.015, holdHours: 48, exit: { legs: [{ cid: "x-S", status: "filled" }], avgPx: 102.5, soldQty: "0.0197", filledAt: "2026-10-12T14:02:40Z" } };
    const c = applyPull(T({ "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([closed, { kind: "missed", id: "r309-ETH-2026101015", day: "2026-10-10", reason: "late" }]), "r309-surge-hold48.json": JSON.stringify({ config: { evidenceStart: "2026-10-12" } }) }), H);
    check("open -> closed accepted", c.ok && JSON.parse(r("r309-ledger.jsonl").split("\n")[0]).status === "closed", JSON.stringify(c));
    refuse("ledger: a closed lot's net changed -> refused", { "r309-cycles.jsonl": cyc2, "r309-ledger.jsonl": jl([{ ...closed, net: 0.02 }, { kind: "missed", id: "r309-ETH-2026101015", day: "2026-10-10", reason: "late" }]) }, /net changed/);
    refuse("ledger missing on the server while home has one -> refused", { "r309-cycles.jsonl": cyc2 }, /exists at home but not on the server/);
    fs.unlinkSync(path.join(H, "r309-HALT"));
    const h = applyPull(t1, H);
    check("home r309-HALT missing -> refused before anything (exit 4)", !h.ok && h.code === 4 && /r309-HALT is missing/.test(h.why));
    check("the server command tars only the four names, regular files only, read-only", /tar --format=ustar -cf - --/.test(remoteCommand(DEFAULT_REMOTE)) && FILES.every((f) => remoteCommand(DEFAULT_REMOTE).includes(f)) && !NEVER.some((f) => remoteCommand(DEFAULT_REMOTE).includes(f)) && !/\brm\b|>\s*\S|mv |chmod|unlink/.test(remoteCommand(DEFAULT_REMOTE)));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`pull-r309 selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

function main() {
  const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf("--" + k); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  const stamp = () => new Date().toISOString();
  if (a.includes("--selftest")) { process.exitCode = selftest() ? 0 : 1; return; }
  const host = opt("host", "traids"), dir = opt("remote-dir", DEFAULT_REMOTE), DRY = a.includes("--dry");
  if (!/^[A-Za-z0-9._@-]+$/.test(host)) { console.error(`[${stamp()}] pull-r309 REFUSED: bad --host`); process.exitCode = 1; return; }
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(dir)) { console.error(`[${stamp()}] pull-r309 REFUSED: --remote-dir must be a plain absolute path`); process.exitCode = 1; return; }
  if (!fs.existsSync(path.join(HOME_DATA, "r309-HALT"))) { console.error(`[${stamp()}] pull-r309 REFUSED (exit 4): home backend/data/r309-HALT is missing — restore it before pulling`); process.exitCode = 4; return; }
  const r = cp.spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", host, remoteCommand(dir)], { maxBuffer: 512 * 1024 * 1024, timeout: 180000, windowsHide: true });
  if (r.error || r.status !== 0) { console.error(`[${stamp()}] pull-r309 FAILED (nothing written): ssh ${host} — ${r.error ? r.error.message : "exit " + r.status} ${String(r.stderr || "").trim().slice(0, 300)}`); process.exitCode = 1; return; }
  const res = applyPull(r.stdout || Buffer.alloc(0), HOME_DATA, { dry: DRY });
  if (!res.ok) { console.error(`[${stamp()}] pull-r309 REFUSED (nothing written): ${res.why}`); process.exitCode = res.code || 1; return; }
  console.log(`[${stamp()}] pull-r309 ${DRY ? "DRY " : ""}ok from ${host}:${dir} — server files ${res.files.length ? res.files.join(", ") : "none yet"}: ${res.actions.length ? res.actions.join("; ") : "no change"} · home r309-HALT present`);
  process.exitCode = 0;
}

if (require.main === module) main();
module.exports = { untar, tarOf, validate, applyPull, checkLedger, remoteCommand, FILES };
