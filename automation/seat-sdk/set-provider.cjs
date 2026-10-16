#!/usr/bin/env node
"use strict";
/**
 * SEAT-SDK TRIAL — SET THE SWITCH. The one writer of backend/data/seat-provider.json (through backend/lib/atomic-write.js).
 *
 *   node automation/seat-sdk/set-provider.cjs sdk --seats news-trader      the FIRST NIGHT: one seat on the SDK, the other five as today
 *                                                                          (news-trader: the seat NOTES.md names for it, and why)
 *   node automation/seat-sdk/set-provider.cjs sdk                          every seat on the SDK
 *   node automation/seat-sdk/set-provider.cjs cli                          BACK to the command-line path, every seat (one command)
 *   node automation/seat-sdk/set-provider.cjs --show                       read-only: the file as it is, and what each seat would take
 *   options   --dry                 print what would be written; write nothing
 *             --note "<text>"       kept in the file (why, who)
 *             --night-cap <usd> --trial-cap <usd> --trial-end <YYYY-MM-DD>   the limits (defaults $12, $180, 2026-11-14); never above the
 *                                   $200 grant, never after the day it expires
 *             --root <dir>          another tree (the selftest's temp folders)
 *
 * A LIMIT SET ONCE STAYS. Every call writes the whole file, but a limit this call does not name is taken from the file as it is: after
 * `sdk --seats news-trader --night-cap 5`, a plain `sdk` (or `cli`, then `sdk` again) still has $5 a night. A limit changes only when a
 * command names it (to go back to a default, name the default: --night-cap 12 --trial-cap 180 --trial-end 2026-11-14), and the
 * command says which limits it kept. A file that cannot be read has no limits to keep: the defaults were in force, and they stay.
 *
 * It writes ONE file and nothing else: no order, no restart, no registry row, no scheduled-task change. The seat wave reads the file once
 * per seat, so the change holds from the next seat that starts. A request this command refuses writes nothing and exits 2.
 * Exit 0 written / shown / dry · 2 refused or usage.
 */
const fs = require("fs"), path = require("path");
const S = require("./seats.cjs"), P = require("./provider.cjs");
const HERE_ROOT = path.resolve(__dirname, "..", "..");

/** build the document for a request -> { doc } | { refused: [why] } (pure) */
function build({ provider, seats, limits, note, now = Date.now() }) {
  const doc = { schema: P.SCHEMA, provider };
  if (seats != null) doc.seats = seats;
  if (limits && Object.keys(limits).length) doc.limits = limits;
  doc.setAt = new Date(now).toISOString(); doc.setBy = "automation/seat-sdk/set-provider.cjs";
  if (note) doc.note = String(note).slice(0, 300);
  const bad = P.validate(doc);
  return bad.length ? { refused: bad } : { doc };
}
/** does the seat wave in this tree carry the staged line that reads the switch? (read-only; null = the wave cannot be read) */
function waveReadsSwitch(root) { try { return fs.readFileSync(path.join(root, "automation", "seat-wave.cjs"), "utf8").includes("seat-sdk/wave-hook.cjs"); } catch { return null; } }
/**
 * A LIMIT SET ONCE STAYS: the limits a request ends with are every limit it names and — for a limit it does not name — the one the
 * file as it is already holds. So a limit is never put back to its default by a command that does not mention it.
 * named: the request's own limits (or null) -> { limits, carried: [the keys taken from the file] }   (read-only; a file that is absent
 * or cannot be read holds nothing to keep: the defaults were in force)
 */
function carryLimits(root, named) {
  const cur = P.read(root), held = (cur.state === "ok" && cur.doc.limits) || {};   // read() hands back a document only for a file that validates
  const merged = { ...(named || {}) }, carried = [];
  for (const k of P.LIMIT_KEYS) if (merged[k] === undefined && held[k] !== undefined) { merged[k] = held[k]; carried.push(k); }
  // written in the file's usual order: the three limits, then whatever else the request named (validate() refuses that by name)
  const limits = {}; for (const k of [...P.LIMIT_KEYS, ...Object.keys(merged)]) if (k in merged && !(k in limits)) limits[k] = merged[k];
  return { limits, carried };
}
/** the kept limits, in words: "$5.00 a night · $60.00 for the trial · an end on 2026-11-07" */
function carriedWords(doc, carried) {
  const L = (doc && doc.limits) || {}, w = { nightCapUsd: (v) => `$${Number(v).toFixed(2)} a night`, trialCapUsd: (v) => `$${Number(v).toFixed(2)} for the trial`, trialEnd: (v) => `an end on ${v}` };
  return (carried || []).map((k) => w[k](L[k])).join(" · ");
}
/** write the switch -> { result: "written" | "dry" | "refused", doc, why, file, carried: [the limits kept from the file as it was] } */
function setProvider({ root = HERE_ROOT, provider, seats = null, limits = null, note = null, dry = false, now = Date.now() }) {
  const kept = carryLimits(root, limits);
  const b = build({ provider, seats, limits: kept.limits, note, now }), file = P.fileOf(root);
  if (b.refused) return { result: "refused", why: b.refused, file, carried: kept.carried, keptLimits: Object.fromEntries(kept.carried.map((k) => [k, kept.limits[k]])) };
  if (dry) return { result: "dry", doc: b.doc, file, carried: kept.carried };
  try {
    if (!fs.statSync(path.dirname(file)).isDirectory()) throw new Error("not a directory");
    require(path.join(root, "backend", "lib", "atomic-write.js")).writeJsonAtomic(file, b.doc);
  } catch (e) { return { result: "refused", why: [`${P.REL} could not be written (${e.code || e.message})`], file, carried: kept.carried }; }
  const back = P.read(root);
  if (back.state !== "ok" || JSON.stringify(back.doc) !== JSON.stringify(b.doc)) return { result: "refused", why: [`${P.REL} was written but does not read back as written (${back.why || back.state})`], file, carried: kept.carried };
  return { result: "written", doc: b.doc, file, carried: kept.carried };
}
/** the lines --show prints (pure but for the two reads) */
function show(root = HERE_ROOT) {
  const R = P.read(root), L = P.limitsOf(R), out = [];
  out.push(`${P.REL}: ${R.state === "absent" ? "ABSENT — every seat takes the command-line path (the default)" : R.state === "unreadable" ? `UNREADABLE (${R.why}) — every seat takes the command-line path (the default)` : `provider "${R.provider}"${R.seats ? ", seats " + R.seats.join(", ") : R.provider === "sdk" ? ", every seat" : ""}${R.doc.setAt ? ", set " + R.doc.setAt : ""}${R.doc.note ? ` — ${R.doc.note}` : ""}`}`);
  for (const s of S.SEATS) out.push(`  ${s.seat.padEnd(22)} ${P.route(R, s.seat) === "sdk" ? "SDK (API credit)  " : "command line      "} cap $${s.budget.toFixed(2)} · ${s.minutes} min${s.model ? " · model " + s.model : ""}`);
  out.push(`  limits on the SDK path: $${L.nightCapUsd.toFixed(2)} a night · $${L.trialCapUsd.toFixed(2)} for the trial · the SDK path refuses from ${L.trialEnd} 00:00 UTC`);
  const w = waveReadsSwitch(root);
  out.push(`  automation/seat-wave.cjs ${w === null ? "cannot be read" : w ? "reads this switch (the staged edit is applied)" : "does NOT read this switch yet: the staged edit is not applied (docs/seat-sdk-trial/2026-10-12/deploy.cjs) — every seat runs on the command line whatever this file says"}`);
  return out;
}

module.exports = { build, setProvider, show, waveReadsSwitch, carryLimits, carriedWords };

if (require.main === module) {
  const a = process.argv.slice(2), val = (k) => { const i = a.indexOf(k); return i >= 0 && i + 1 < a.length ? a[i + 1] : null; }, has = (k) => a.includes(k);
  const usage = () => { console.log("usage: node automation/seat-sdk/set-provider.cjs cli | sdk [--seats a,b] [--note \"...\"] [--night-cap N] [--trial-cap N] [--trial-end YYYY-MM-DD] [--dry]\n       node automation/seat-sdk/set-provider.cjs --show\nNothing was done."); process.exit(2); };
  const root = val("--root") ? path.resolve(val("--root")) : HERE_ROOT;
  const FLAGS = ["--seats", "--note", "--night-cap", "--trial-cap", "--trial-end", "--root"], BOOLS = ["--dry", "--show"];
  // every argument must be a known one: a mistyped flag is refused, never ignored (a lost --seats would put all six seats on the SDK)
  const rest = []; for (let i = 0; i < a.length; i++) { if (FLAGS.includes(a[i])) { if (i + 1 >= a.length) usage(); i++; } else if (!BOOLS.includes(a[i])) rest.push(a[i]); }
  if (has("--show")) { if (rest.length || has("--dry")) usage(); for (const l of show(root)) console.log(l); process.exit(0); }
  if (rest.length !== 1 || (rest[0] !== "cli" && rest[0] !== "sdk")) usage();
  const num = (k) => { const v = val(k); if (v == null) return undefined; const n = Number(v); if (!/^\d+(\.\d+)?$/.test(v) || !Number.isFinite(n)) { console.log(`${k} needs a number of dollars; got ${JSON.stringify(v)}. Nothing was done.`); process.exit(2); } return n; };
  const limits = {}; { const n = num("--night-cap"), t = num("--trial-cap"), e = val("--trial-end"); if (n !== undefined) limits.nightCapUsd = n; if (t !== undefined) limits.trialCapUsd = t; if (e != null) limits.trialEnd = e; }
  const seats = val("--seats") != null ? val("--seats").split(",").map((x) => x.trim()).filter(Boolean) : null;
  const r = setProvider({ root, provider: rest[0], seats, limits, note: val("--note"), dry: has("--dry") });
  const NAME_IT = "name a limit on the command to change it (--night-cap, --trial-cap, --trial-end)";
  if (r.result === "refused") {
    console.log(`REFUSED — nothing was written:\n  - ${r.why.join("\n  - ")}`);
    if (r.keptLimits && r.carried && r.carried.length) console.log(`  (kept from the file as it is, not named on this command: ${carriedWords({ limits: r.keptLimits }, r.carried)} — ${NAME_IT})`);
    process.exit(2);
  }
  console.log(`${r.result === "dry" ? "DRY — this would be written to" : "WRITTEN"} ${P.REL}:`);
  console.log(JSON.stringify(r.doc, null, 1));
  // a limit this command did not name is the file's own, never the default again: said every time one was kept
  if (r.carried.length) console.log(`  LIMITS KEPT from the file as it was (not named on this command): ${carriedWords(r.doc, r.carried)} — ${NAME_IT}`);
  if (r.result === "dry") console.log("nothing was written.");
  else {
    for (const l of show(root)) console.log(l);
    if (r.doc.provider === "sdk") console.log("  NOTE: the seat tests need the dated note of this switch recorded with it (docs/seat-sdk-trial/2026-10-12/NOTES.md, 'The note for the seat tests').");
  }
  process.exit(0);
}
