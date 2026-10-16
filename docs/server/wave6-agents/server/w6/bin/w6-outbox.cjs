#!/usr/bin/env node
/**
 * W6 OUTBOX — a finished agent run on the VPS -> ONE immutable record of exactly the deltas home may apply. 2026-10-09
 * (docs/server/wave6-agents). Plain code, user traids, from traids-w6-outbox.service every 15 minutes, under the pull lock
 * (/usr/bin/flock .../backend/data/w6-outbox.flock, the lock deploy/server/pull-server.cjs takes for the w6s / w6a units).
 *
 *   node /home/traids/w6/bin/w6-outbox.cjs              every run/<runId> with DONE.json and no record yet -> backend/data/w6-outbox/<runId>.json
 *   node /home/traids/w6/bin/w6-outbox.cjs --selftest
 *
 * The agents (user scout) write only inside run/<runId>; this file (another uid) reads it and decides what is relayable:
 *   seats  APPENDS  seat-claims.jsonl (the new rows' hash chain re-verified from the base's last hash — seat-seal.js's rule),
 *                   agent-ledger.jsonl, portfolio-manager-plans.jsonl, agent-book-ledger.jsonl, ht-memo-history.jsonl,
 *                   seat-wave-history.jsonl — each: the run's file must START with the base bytes; only the new lines, each parsed
 *          REPLACES risk-governor.json, agent-book.json, ht-memo-seal.json, seat-wave-status.json — { baseSha, newSha, json }
 *   audit  the new backend/data/audit-nightly/<session>.json (the record the server skill writes; its filedItems become home's
 *          audit-fix-queue entries) — nothing else
 *   every other changed / added / removed file is listed under `unexpected` and NEVER relayed; a seat run that changed code
 *   (backend/ automation/ deploy/ .claude/) or rewrote an append-only file is REFUSED whole (refused: <why>) — home applies nothing
 *   of it and says so. An audit run may write scratch scripts (its allow-list is Write + node); they are listed, never relayed.
 * A record is written once (atomic rename, complete: true) and never rewritten; pull-server's dir-of-json entry freezes it at home.
 * Shadow runs (runId ...-shadow) get a record too (compare.cjs reads it); pull-server's pattern never pulls them and w6-apply never
 * applies them. Test mode (W6_TEST=1): W6_RUN, W6_OUTBOX.
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), os = require("os");
const TEST = process.env.W6_TEST === "1";
const RUN = TEST && process.env.W6_RUN ? process.env.W6_RUN : "/home/traids/w6/run";
const OUTBOX = TEST && process.env.W6_OUTBOX ? process.env.W6_OUTBOX : "/home/traids/traids/backend/data/w6-outbox";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const readJ = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const SEAT_APPENDS = ["seat-claims.jsonl", "agent-ledger.jsonl", "portfolio-manager-plans.jsonl", "agent-book-ledger.jsonl", "ht-memo-history.jsonl", "seat-wave-history.jsonl"];
const SEAT_REPLACES = ["risk-governor.json", "agent-book.json", "ht-memo-seal.json", "seat-wave-status.json"];
const IGNORE = /^(W6-RUN\.json|DONE\.json|w6-run\.log|automation\/seat-wave\.log|automation\/nightly-audit\.log|backend\/data\/audit-nightly\.lock\.json|backend\/data\/seat-wave-alerts\.json|\.w6-base\/.*)$/;
const CODE = /^(backend\/(?!data\/)|automation\/(?!.*\.log$)|deploy\/|\.claude\/)/;
/** seat-seal.js hashOf, verbatim: the chain of seat-claims.jsonl */
const hashOf = (row, prev) => crypto.createHash("sha256").update(JSON.stringify({ seat: row.seat, kind: row.kind, subject: row.subject, magnitude: row.magnitude, direction: row.direction, falsifier: row.falsifier, window: row.window, sealedAt: row.sealedAt }) + "|" + (prev || "")).digest("hex");
const walk = (d, base = d, out = []) => { if (!fs.existsSync(d)) return out; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, base, out); else if (e.isFile()) out.push(path.relative(base, p).replace(/\\/g, "/")); } return out; };
/** Pure-ish: the new lines of an append-only file -> { rows } | { error } */
function appended(baseBuf, runBuf) {
  const b = baseBuf || Buffer.alloc(0);
  if (!runBuf) return b.length ? { error: "removed" } : { rows: [] };
  if (!(runBuf.length >= b.length && runBuf.subarray(0, b.length).equals(b))) return { error: "rewritten (the base is not an exact prefix)" };
  const tail = runBuf.subarray(b.length).toString("utf8"); if (!tail) return { rows: [] };
  if (!tail.endsWith("\n")) return { error: "the last appended line has no newline (torn)" };
  const rows = []; for (const l of tail.split("\n")) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch { return { error: "an appended line does not parse" }; } }
  return { rows };
}
/** Pure: verify the new seat-claims rows continue the chain from the base's last row */
function chainOk(baseRows, newRows) {
  let prev = baseRows.length ? baseRows[baseRows.length - 1].hash : "";
  for (const r of newRows) { if (r.prevHash !== prev || r.hash !== hashOf(r, prev)) return false; prev = r.hash; }
  return true;
}
const jsonlRows = (buf) => (buf ? buf.toString("utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);
/** build one record from a finished run dir (pure on the files) */
function buildRecord(dir, runId) {
  const run = readJ(path.join(dir, "W6-RUN.json")), done = readJ(path.join(dir, "DONE.json"));
  if (!run || run.spec !== "w6-run-v1" || !done) throw new Error(`${runId}: W6-RUN.json / DONE.json missing`);
  const shadow = /-shadow$/.test(runId), kind = run.kind, base = run.files || {};
  const now = walk(dir).filter((r) => !IGNORE.test(r)), nowSet = new Set(now), changes = [];
  for (const r of now) { const h = sha(fs.readFileSync(path.join(dir, r))); if (!(r in base)) changes.push({ path: r, change: "added" }); else if (h !== base[r]) changes.push({ path: r, change: "modified" }); }
  for (const r of Object.keys(base)) if (!nowSet.has(r) && !IGNORE.test(r)) changes.push({ path: r, change: "removed" });
  const rec = { spec: "w6-outbox-v1", kind, runId, session: run.session, shadow, complete: true, builtAt: new Date().toISOString(), host: os.hostname(), inputsSha: run.inputsSha,
    run: { startedAt: run.startedAt, finishedAt: done.finishedAt, exit: done.exit, wave: done.wave || null, skipped: done.skipped || null }, appends: {}, replaces: {}, unexpected: [], refused: null };
  const D = (f) => `backend/data/${f}`;
  if (kind === "seats") {
    for (const c of changes) if (CODE.test(c.path)) { rec.refused = `the run changed code (${c.path} ${c.change}) — nothing of this run is relayed`; break; }
    for (const f of SEAT_APPENDS) {
      const bb = fs.existsSync(path.join(dir, ".w6-base", f)) ? fs.readFileSync(path.join(dir, ".w6-base", f)) : null, rb = fs.existsSync(path.join(dir, D(f))) ? fs.readFileSync(path.join(dir, D(f))) : null;
      const a = appended(bb, rb);
      if (a.error) { if (!rec.refused) rec.refused = `${f}: ${a.error} — append-only files only grow`; continue; }
      if (f === "seat-claims.jsonl" && a.rows.length && !chainOk(jsonlRows(bb), a.rows)) { if (!rec.refused) rec.refused = "seat-claims.jsonl: the new rows do not continue the hash chain"; continue; }
      if (a.rows.length) rec.appends[f] = a.rows;
    }
    for (const f of SEAT_REPLACES) {
      const bp = path.join(dir, ".w6-base", f), rp = path.join(dir, D(f)), bb = fs.existsSync(bp) ? fs.readFileSync(bp) : null, rb = fs.existsSync(rp) ? fs.readFileSync(rp) : null;
      if (!rb || (bb && bb.equals(rb))) continue;
      let j = null; try { j = JSON.parse(rb.toString("utf8")); } catch { if (!rec.refused) rec.refused = `${f}: does not parse`; continue; }
      rec.replaces[f] = { baseSha: bb ? sha(bb) : null, newSha: sha(rb), json: j };
    }
    const relayed = new Set([...SEAT_APPENDS, ...SEAT_REPLACES].map(D));
    rec.unexpected = changes.filter((c) => !relayed.has(c.path));
  } else if (kind === "audit") {
    const recPath = D(`audit-nightly/${run.session}.json`), c = changes.find((x) => x.path === recPath && x.change === "added");
    if (c) { let j = null; try { j = JSON.parse(fs.readFileSync(path.join(dir, recPath), "utf8")); } catch { j = null; } if (j) rec.auditRecord = j; else rec.refused = `${recPath} does not parse`; }
    rec.unexpected = changes.filter((x) => x.path !== recPath).map((x) => ({ path: x.path, change: x.change }));
  } else throw new Error(`${runId}: unknown kind ${kind}`);
  return rec;
}
function main() {
  fs.mkdirSync(OUTBOX, { recursive: true });
  let names = []; try { names = fs.readdirSync(RUN).filter((n) => /^(seats|audit)-\d{4}-\d{2}-\d{2}(-shadow)?$/.test(n)); } catch { names = []; }
  const lines = [];
  for (const n of names.sort()) {
    const out = path.join(OUTBOX, `${n}.json`); if (fs.existsSync(out) || !fs.existsSync(path.join(RUN, n, "DONE.json"))) continue;
    let rec; try { rec = buildRecord(path.join(RUN, n), n); } catch (e) { lines.push(`${n}: NOT recorded — ${e.message}`); continue; }
    const t = `${out}.tmp-${process.pid}`; fs.writeFileSync(t, JSON.stringify(rec, null, 1) + "\n", { mode: 0o644 }); fs.renameSync(t, out);
    lines.push(`${n}: recorded${rec.refused ? " — REFUSED: " + rec.refused : ""} · appends ${Object.entries(rec.appends).map(([f, r]) => `${f} +${r.length}`).join(", ") || "none"} · replaces ${Object.keys(rec.replaces).join(", ") || "none"}${rec.auditRecord ? " · audit record" : ""} · unexpected ${rec.unexpected.length}`);
  }
  for (const l of lines) console.log("w6-outbox: " + l);
  if (!lines.length) console.log("w6-outbox: nothing new");
  return lines.some((l) => /NOT recorded/.test(l)) ? 1 : 0;
}
function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + String(d).slice(0, 300) : "")); } };
  const row = (o, prev) => { const r = { seat: "risk-governor", kind: "halt", subject: "s", magnitude: null, direction: "allow", falsifier: "f", window: { opensAt: "a", closesAt: "b" }, sealedAt: o, prevHash: prev }; r.hash = hashOf(r, prev); return r; };
  const r1 = row("2026-10-13T21:00:00Z", ""), r2 = row("2026-10-14T21:30:00Z", r1.hash), r3 = row("2026-10-14T21:31:00Z", r2.hash);
  ok("chain: rows continuing the base's last hash pass; a row that skips one, or an edited row, fails", chainOk([r1], [r2, r3]) && !chainOk([r1], [r3]) && !chainOk([r1], [{ ...r2, subject: "edited" }]));
  const B = Buffer.from(JSON.stringify(r1) + "\n");
  ok("appended: only the new lines; a rewritten / removed / torn file is an error", appended(B, Buffer.concat([B, Buffer.from(JSON.stringify(r2) + "\n")])).rows.length === 1 && /rewritten/.test(appended(B, Buffer.from("{}\n")).error) && /removed/.test(appended(B, null).error) && /torn/.test(appended(B, Buffer.concat([B, Buffer.from("{}")])).error) && appended(null, null).rows.length === 0);
  ok("ignored run files: the run's own markers, logs, the bases, the guard claim", ["W6-RUN.json", "DONE.json", "w6-run.log", "automation/seat-wave.log", ".w6-base/seat-claims.jsonl", "backend/data/audit-nightly.lock.json"].every((p) => IGNORE.test(p)) && !IGNORE.test("backend/data/seat-claims.jsonl") && CODE.test("backend/lib/reconcile.js") && !CODE.test("backend/data/x.json") && CODE.test(".claude/agents/head-trader.md"));
  console.log(`w6-outbox selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}
if (require.main === module) { const a = process.argv.slice(2); if (a[0] === "--selftest") process.exitCode = selftest() ? 0 : 1; else if (!a.length) { try { process.exitCode = main(); } catch (e) { console.error("w6-outbox: FAILED — " + e.message); process.exitCode = 1; } } else { console.error("usage: w6-outbox.cjs [--selftest]"); process.exitCode = 2; } }
module.exports = { buildRecord, appended, chainOk, hashOf, SEAT_APPENDS, SEAT_REPLACES, IGNORE, CODE };
