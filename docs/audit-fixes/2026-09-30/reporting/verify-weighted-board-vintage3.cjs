#!/usr/bin/env node
/**
 * 2026-10-01 audit fix vintage#3 — VERIFY weighted-board.js: compile the ORIGINAL (backup) and the NEW buildContributors() against the
 * same canonical ledger and diff the contributor lists. Expected: identical ids; the only change is that the guard-2026-09-29.1 post-entry
 * keys present on the ledger become BLOCKED (with the reason), and the quarantined news keys keep their block. Read-only: nothing is
 * written; the board itself is not computed (that is the chain's 8-13 minute step) — buildContributors is the code that changed.
 */
const fs = require("fs"), path = require("path"), Module = require("module");
const ROOT = path.resolve(__dirname, "..", "..", "..", ".."), LIVE = path.join(ROOT, "backend", "weighted-board.js");
const ORIG = path.join(ROOT, "docs", "audit-fixes", "2026-09-30", "backups", "backend__weighted-board.js.orig");
const load = (srcFile) => { const m = new Module(LIVE, null); m.filename = LIVE; m.paths = Module._nodeModulePaths(path.dirname(LIVE)); m._compile(fs.readFileSync(srcFile, "utf8") + "\nmodule.exports.__bc = buildContributors;\n", LIVE); return m.exports; };
const oldW = load(ORIG), newW = load(LIVE);
const L = require(path.join(ROOT, "backend", "lib", "reconcile.js")).cleanEraLedger();
const trades = L.signals.concat(L.controls).filter((t) => t && Number.isFinite(t.rMult));
const FM = require(path.join(ROOT, "backend", "lib", "feature-manifest.js"));
const a = oldW.__bc(trades), b = newW.__bc(trades);
const ia = a.map((c) => c.id), ib = b.map((c) => c.id);
let pass = true; const check = (n, ok, d = "") => { console.log(`${ok ? "ok  " : "BAD "} ${n}${d ? " — " + d : ""}`); if (!ok) pass = false; };
console.log(`VERIFY vintage#3 — ${trades.length} canonical trades; guard ${FM.BOARD_GUARD_VERSION}; ${a.length} contributors before, ${b.length} after`);
check("same contributor ids, same order (none dropped, none added)", JSON.stringify(ia) === JSON.stringify(ib));
const changed = b.filter((c, i) => (!!c.blocked) !== (!!a[i].blocked) || c.source !== a[i].source || c.scope !== a[i].scope);
const banned = FM.boardObsBanned();
for (const c of changed) console.log(`  changed: ${c.id.padEnd(22)} before: ${a[ia.indexOf(c.id)].blocked ? "BLOCKED" : "eligible"} · ${a[ia.indexOf(c.id)].source} · ${a[ia.indexOf(c.id)].scope || "-"}${a[ia.indexOf(c.id)].apply ? " · W1 replay " + JSON.stringify(a[ia.indexOf(c.id)].apply) : ""}\n           after : ${c.blocked ? "BLOCKED — " + c.blocked.slice(0, 90) + "…" : "eligible"} · ${c.source}`);
check("every changed contributor is a banned obs key", changed.every((c) => c.id.startsWith("obs:") && banned.has(c.name)));
const nowEligibleBanned = b.filter((c) => c.id.startsWith("obs:") && banned.has(c.name) && !c.blocked);
check("no banned obs key left eligible", nowEligibleBanned.length === 0, nowEligibleBanned.map((c) => c.id).join(", "));
const dropped = changed.filter((c) => !a[ia.indexOf(c.id)].blocked && c.blocked).map((c) => c.name);
check("the three keys the finding names drop out (those on the ledger with >= 60 values)", ["daysToEarnings", "macroDaysOut", "stampLagMin"].every((k) => !ib.includes("obs:" + k) || dropped.includes(k)), "dropped: " + dropped.join(", "));
const others = b.filter((c, i) => !changed.includes(c));
check("every other contributor unchanged (blocked flag, source, scope, apply rule)", others.every((c) => { const o = a[ia.indexOf(c.id)]; return JSON.stringify([!!o.blocked, o.source, o.scope, o.apply]) === JSON.stringify([!!c.blocked, c.source, c.scope, c.apply]); }));
let wb = null; try { wb = JSON.parse(fs.readFileSync(path.join(ROOT, "backend", "data", "weighted-board.json"), "utf8")); } catch {}
if (wb) { const w = (id) => (wb.contributors || []).find((c) => c.id === id); console.log(`  on the 09-30 board (generated ${wb.generated}): ` + dropped.map((k) => { const c = w("obs:" + k); return c ? `${k} weight ${c.weight}, t ${c.t}, ${c.sessions} sess, "${c.status}"` : `${k} absent`; }).join(" | "));
  check("none of the newly blocked dials carried weight on the 09-30 board", dropped.every((k) => { const c = w("obs:" + k); return !c || c.weight === 0; })); }
console.log(pass ? "VERIFY PASS" : "VERIFY FAIL"); process.exit(pass ? 0 : 1);
