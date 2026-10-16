#!/usr/bin/env node
/**
 * COMPOSITION PROBE — does W5's home patch compose with every sibling package's home patch on every file BOTH edit, in either
 * order, and does each package's own judge still read "applied" once the other's edit is in? 2026-10-11 (docs/server/wave5-board;
 * the model is docs/server/wave-r309fold/compose-w3.cjs). Read-only: everything is done in memory on the real home files.
 *
 * For each sibling S and each file both packages edit, from the file as it is at home today:
 *   - each judge reads base or applied on the real file (never drift)
 *   - a common base is derived (S's edit and W5's edit both out; every OTHER package's edit stays as it is at home)
 *   - W5 then S, and S then W5, both apply and give BYTE-IDENTICAL text
 *   - on that text both judges read applied
 *   - reverting W5 leaves exactly S's edit; reverting S leaves exactly W5's edit; both revert orders return the base byte for byte
 *   - a text that is neither (one of W5's own lines removed from the composed text) reads DRIFT to W5's judge
 *   - the lines the two packages touch are disjoint, except an anchor line they are DECLARED to share (home-patch.cjs SIBLINGS:
 *     the chain's "learning tracker" line with the R309 fold — W5 reads the fold's edit out in memory and puts it back)
 *   - W5's home step on TODAY'S file gives the composed text
 * REQUIRED siblings (a failure fails the probe): W1c-2a, the R309 fold, W3, W2b. REPORTED siblings (shown, not counted — W1 is cut
 * over and never comes out again; W4 is a draft): the same checks, printed as notes.
 *   node docs/server/wave5-board/compose.cjs     ends "COMPOSE OK (n/n)" (exit 0) or "COMPOSE FAIL" (exit 1)
 */
"use strict";
const fs = require("fs"), path = require("path");
const REPO = path.resolve(__dirname, "..", "..", "..");
const W = require("./home-patch.cjs");
const REQUIRED = [["W1c-2a", "wave1c-2a"], ["the R309 fold", "wave-r309fold"], ["W3", "wave3-sleeves"], ["W2b", "wave2b-schwab"]];
const REPORTED = [["W1", "wave1-crypto"], ["W4 (draft)", "wave4-marks"]];
let pass = 0, fail = 0, notes = 0;
const mk = (soft) => (name, cond, detail) => { if (cond) { if (soft) { notes++; console.log("  note " + name); } else { pass++; console.log("  ok   " + name); } } else if (soft) { notes++; console.log("  NOTE (not counted) " + name + (detail ? " — " + String(detail).slice(0, 300) : "")); } else { fail++; console.log("  FAIL " + name + (detail ? " — " + String(detail).slice(0, 300) : "")); } };
const tryIt = (fn) => { try { return { v: fn() }; } catch (e) { return { err: String(e.message).split("\n")[0].slice(0, 260) }; } };
const linesOf = (t) => t.split(/\r?\n/);
/** the lines an op list touches: every anchor, and every line a block adds */
const touched = (ops) => { const s = new Set(); for (const op of ops || []) { if (typeof op.from === "string") s.add(op.from); for (const l of Array.isArray(op.to) ? op.to : []) s.add(l); for (const k of ["anchor", "text"]) if (typeof op[k] === "string") for (const l of op[k].split(/\r?\n/)) if (l) s.add(l); if (typeof op.to === "string") s.add(op.to); } return s; };
const declaredShared = (rel, dir) => W.SIBLINGS.some((x) => x.rel === rel && x.pkg.includes(`/${dir}/`));

function probe(label, dir, soft) {
  const ok = mk(soft), f = path.join(REPO, "docs", "server", dir, "home-patch.cjs");
  if (!fs.existsSync(f)) { ok(`${label}: its package is present`, false, `${dir}/home-patch.cjs not found`); return; }
  const L = tryIt(() => require(f)); if (L.err || !Array.isArray(L.v.EDITS) || !["textState", "applyText", "revertText"].every((k) => typeof L.v[k] === "function")) { ok(`${label}: its home patch loads with its judge`, false, L.err || "no EDITS / textState / applyText / revertText"); return; }
  const S = L.v, shared = W.EDITS.map((we) => [we, S.EDITS.find((e) => e.rel === we.rel)]).filter(([, se]) => se);
  console.log(`${label} (docs/server/${dir}) — ${shared.length ? "files both edit: " + shared.map(([we]) => we.rel).join(", ") : "edits no file W5 edits"}`);
  for (const [we, se] of shared) {
    const rel = we.rel, cur = fs.readFileSync(path.join(REPO, ...rel.split("/")), "utf8");
    const w0 = tryIt(() => W.textState(we, cur).state), s0 = tryIt(() => S.textState(se, cur).state);
    ok(`${rel}: on the real file each judge reads base or applied (W5 ${w0.v || w0.err}, ${label} ${s0.v || s0.err})`, ["base", "applied"].includes(w0.v) && ["base", "applied"].includes(s0.v));
    // disjoint lines (text only; no apply needed)
    { const wops = tryIt(() => (we.gen === "chain" ? we.ops : we.ops)), sops = Array.isArray(se.ops) ? se.ops : [];
      if (wops.err) ok(`${rel}: W5's ops can be read`, false, wops.err);
      else { const a = touched(wops.v), b = touched(sops), both = [...a].filter((l) => b.has(l) && l.trim() && !/^\s*(\/\/|::|REM)/.test(l));
        const allowed = declaredShared(rel, dir) ? both.filter((l) => !/^  \["learning tracker", /.test(l)) : both;
        ok(`${rel}: the lines W5 touches and the lines ${label} touches are disjoint${declaredShared(rel, dir) ? " but for the declared shared anchor (the 'learning tracker' line, kept byte for byte by both)" : ""}`, allowed.length === 0, allowed.slice(0, 2).map((l) => l.slice(0, 90)).join(" | ")); } }
    if (!["base", "applied"].includes(w0.v) || !["base", "applied"].includes(s0.v)) continue;
    if (soft && s0.v === "applied") {   // a reported sibling that is IN and never comes out again (W1: other packages sit on its lines): W5 in and out around it
      const nx = tryIt(() => (w0.v === "base" ? W.applyText(we, cur) : cur)), back = nx.err ? nx : tryIt(() => W.revertText(we, nx.v)), base0 = w0.v === "base" ? cur : (tryIt(() => W.revertText(we, cur)).v);
      ok(`${rel}: with ${label} in (it stays in): W5 applies, ${label}'s judge reads applied before and after, and W5's revert returns the file byte for byte`, !nx.err && !back.err && tryIt(() => S.textState(se, nx.v).state).v === "applied" && back.v === base0 && W.textState(we, nx.v).state === "applied", nx.err || back.err);
      continue;
    }
    const b = tryIt(() => { let t = cur; if (W.textState(we, t).state === "applied") t = W.revertText(we, t); if (S.textState(se, t).state === "applied") t = S.revertText(se, t); if (W.textState(we, t).state === "applied") t = W.revertText(we, t); return t; });
    if (b.err || W.textState(we, b.v).state !== "base" || S.textState(se, b.v).state !== "base") { ok(`${rel}: a common base can be derived from the real file`, false, b.err || `a judge does not read base on it (W5 ${W.textState(we, b.v).state}, ${label} ${S.textState(se, b.v).state})`); continue; }
    const base = b.v, wOnly = tryIt(() => W.applyText(we, base)), sOnly = tryIt(() => S.applyText(se, base));
    if (wOnly.err || sOnly.err) { ok(`${rel}: each package applies alone on the common base`, false, wOnly.err || sOnly.err); continue; }
    const A = tryIt(() => S.applyText(se, wOnly.v)), B = tryIt(() => W.applyText(we, sOnly.v));
    ok(`${rel}: W5 THEN ${label} applies`, !A.err, A.err); ok(`${rel}: ${label} THEN W5 applies`, !B.err, B.err);
    if (A.err || B.err) continue;
    ok(`${rel}: both orders give BYTE-IDENTICAL text`, A.v === B.v);
    for (const [lab, t] of [[`W5 then ${label}`, A.v], [`${label} then W5`, B.v]]) {
      const sw = tryIt(() => W.textState(we, t).state), ss = tryIt(() => S.textState(se, t).state);
      ok(`${rel}: ${lab} — W5's judge reads applied (${sw.v || sw.err}) and ${label}'s reads applied (${ss.v || ss.err})`, sw.v === "applied" && ss.v === "applied");
      const rw = tryIt(() => W.revertText(we, t)), rs = tryIt(() => S.revertText(se, t));
      ok(`${rel}: ${lab} — reverting W5 leaves exactly ${label}'s edit`, rw.v === sOnly.v, rw.err);
      ok(`${rel}: ${lab} — reverting ${label} leaves exactly W5's edit`, rs.v === wOnly.v, rs.err);
      const r1 = tryIt(() => S.revertText(se, W.revertText(we, t))), r2 = tryIt(() => W.revertText(we, S.revertText(se, t)));
      ok(`${rel}: ${lab} — both revert orders return the base byte for byte`, r1.v === base && r2.v === base, r1.err || r2.err);
    }
    // neither base nor applied -> drift: one line only W5 added, removed from the composed text
    { const mine = [...touched(tryIt(() => (we.gen === "chain" ? require("./deploy-server/w5-split.cjs").chainOps(base, W.SPLIT()) : we.ops)).v || [])].filter((l) => !linesOf(base).includes(l) && linesOf(A.v).includes(l));
      const cut = mine.length ? linesOf(A.v).filter((l) => l !== mine[mine.length - 1]).join(A.v.includes("\r\n") && !/[^\r]\n/.test(A.v) ? "\r\n" : "\n") : null, st = cut == null ? { err: "no W5-added line found" } : tryIt(() => W.textState(we, cut).state);
      ok(`${rel}: the composed text with ONE of W5's lines removed reads DRIFT to W5's judge (neither base nor applied)`, st.v === "drift", st.err || st.v); }
    if (w0.v === "base") { const nx = tryIt(() => W.applyText(we, cur)), want = s0.v === "applied" ? A.v : wOnly.v; ok(`${rel}: W5's home step on TODAY'S file (${label} ${s0.v === "applied" ? "already in" : "not in"}) gives the ${s0.v === "applied" ? "composed" : "W5-only"} text`, nx.v === want, nx.err); }
  }
}
for (const [label, dir] of REQUIRED) probe(label, dir, false);
for (const [label, dir] of REPORTED) probe(label, dir, true);
// the files W5 once shared and no longer edits: said plainly, so a reviewer does not look for them
console.log("no longer shared: backend/lib/schwab.js (W3's edit hands the token to W2b's reader; W5 edits nothing there), automation/ensure-servers.bat (the fold's; W5 edits ensure-servers.cjs, which no sibling edits), backend/ops-health.js (W1's; W5's port is withdrawn)");
{ const stillShared = ["backend/lib/schwab.js", "backend/ops-health.js", "automation/ensure-servers.bat", "automation/r21-roll.bat"].filter((r) => W.EDITS.some((e) => e.rel === r));
  if (stillShared.length) { fail++; console.log("  FAIL W5 edits a file the line above says it does not: " + stillShared.join(", ")); } else { pass++; console.log("  ok   W5 edits none of backend/lib/schwab.js, backend/ops-health.js, automation/ensure-servers.bat, automation/r21-roll.bat"); } }
console.log(fail ? `COMPOSE FAIL (${pass} ok, ${fail} failed; ${notes} note(s) on the reported siblings)` : `COMPOSE OK (${pass}/${pass})${notes ? ` — ${notes} note(s) on the reported siblings (W1, W4: shown, not counted)` : ""}`);
process.exit(fail ? 1 : 0);
