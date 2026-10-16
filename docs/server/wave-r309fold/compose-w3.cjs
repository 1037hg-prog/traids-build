#!/usr/bin/env node
/**
 * COMPOSITION PROBE (main loop, 2026-10-10) — does the R309 fold's home patch compose with the W3 sleeves' home patch on the files
 * BOTH edit (automation/close-chain.cjs, automation/preflight.bat), in either order, and does each package's own judge still read
 * "applied" once the other's edit is in? Found 2026-10-10: both insert right above W1's "pull server files (before git snapshot)"
 * line in the close chain, so whichever lands second made the other read DRIFT and its revert throw.
 * Read-only: everything is done in memory on the real home files. Also asks W3's own guard whether W2b's package is re-pinned.
 *   node docs/server/wave-r309fold/compose-w3.cjs     ends "COMPOSE OK (n/n)" (exit 0) or "COMPOSE FAIL" (exit 1)
 */
"use strict";
const fs = require("fs"), path = require("path");
const REPO = path.resolve(__dirname, "..", "..", "..");
const F = require("./home-patch.cjs"), W = require(path.join(REPO, "docs", "server", "wave3-sleeves", "home-patch.cjs"));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail ? " — " + String(detail).slice(0, 300) : "")); } };
const tryIt = (fn) => { try { return { v: fn() }; } catch (e) { return { err: e.message }; } };
for (const rel of ["automation/close-chain.cjs", "automation/preflight.bat"]) {
  const fe = F.EDITS.find((e) => e.rel === rel), we = W.EDITS.find((e) => e.rel === rel);
  if (!fe || !we) { ok(`${rel}: both packages edit it`, false, `fold ${!!fe} W3 ${!!we}`); continue; }
  const cur = fs.readFileSync(path.join(REPO, ...rel.split("/")), "utf8");
  const fs0 = tryIt(() => F.textState(fe, cur).state), ws0 = tryIt(() => W.textState(we, cur).state);
  ok(`${rel}: on the real file each judge reads base or applied (fold ${fs0.v || fs0.err}, W3 ${ws0.v || ws0.err})`, ["base", "applied"].includes(fs0.v) && ["base", "applied"].includes(ws0.v));
  // the common base: both edits read out, in whichever order the real file needs
  const b = tryIt(() => { let t = cur; if (W.textState(we, t).state === "applied") t = W.revertText(we, t); if (F.textState(fe, t).state === "applied") t = F.revertText(fe, t); if (W.textState(we, t).state === "applied") t = W.revertText(we, t); return t; });
  if (b.err || F.textState(fe, b.v).state !== "base" || W.textState(we, b.v).state !== "base") { ok(`${rel}: a common base can be derived from the real file`, false, b.err || "a judge does not read base"); continue; }
  const base = b.v, fOnly = F.applyText(fe, base), wOnly = W.applyText(we, base);
  const A = tryIt(() => W.applyText(we, fOnly)), B = tryIt(() => F.applyText(fe, wOnly));
  ok(`${rel}: fold THEN W3 applies`, !A.err, A.err); ok(`${rel}: W3 THEN fold applies`, !B.err, B.err);
  if (A.err || B.err) continue;
  ok(`${rel}: both orders give BYTE-IDENTICAL text`, A.v === B.v);
  for (const [lab, t] of [["fold then W3", A.v], ["W3 then fold", B.v]]) {
    const sf = tryIt(() => F.textState(fe, t).state), sw = tryIt(() => W.textState(we, t).state);
    ok(`${rel}: ${lab} — the fold's judge reads applied (${sf.v || sf.err}) and W3's reads applied (${sw.v || sw.err})`, sf.v === "applied" && sw.v === "applied");
    const rf = tryIt(() => F.revertText(fe, t)), rw = tryIt(() => W.revertText(we, t));
    ok(`${rel}: ${lab} — reverting the fold leaves exactly W3's edit`, rf.v === wOnly, rf.err);
    ok(`${rel}: ${lab} — reverting W3 leaves exactly the fold's edit`, rw.v === fOnly, rw.err);
    const r1 = tryIt(() => W.revertText(we, F.revertText(fe, t))), r2 = tryIt(() => F.revertText(fe, W.revertText(we, t)));
    ok(`${rel}: ${lab} — both revert orders return the base byte for byte`, r1.v === base && r2.v === base, r1.err || r2.err);
  }
  if (fs0.v === "applied" && ws0.v === "base") { const nx = tryIt(() => W.applyText(we, cur)); ok(`${rel}: W3's home step on TODAY'S file (fold already in) gives the composed text`, nx.v === A.v, nx.err); }
}
{ const g = tryIt(() => W.w2bGuard()); ok(`W3's guard on W2b's package: the home step may run (${g.err ? "threw: " + g.err : g.v ? "REFUSES" : "passes"})`, !g.err && !g.v, g.v); }
console.log(fail ? `COMPOSE FAIL (${pass} ok, ${fail} failed)` : `COMPOSE OK (${pass}/${pass})`);
process.exit(fail ? 1 : 0);
