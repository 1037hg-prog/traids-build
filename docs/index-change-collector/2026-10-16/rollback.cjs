#!/usr/bin/env node
"use strict";
/**
 * INDEX CHANGE COLLECTOR (2026-10-16) — ROLLBACK: the base state back, which for this package is the
 * ABSENCE of three files.
 *
 *   node docs/index-change-collector/2026-10-16/rollback.cjs --plan     READ-ONLY: what would be removed
 *   node docs/index-change-collector/2026-10-16/rollback.cjs --apply    the write mode
 *
 * Every file this package ships is NEW, so `base/` holds no file copies and there is nothing to restore
 * byte for byte: rolling back means the three paths are not there any more, exactly as before the apply.
 * A path is removed ONLY when it is byte for byte the staged copy (sha256). A path that holds other
 * bytes is DRIFT and the whole rollback is refused — someone edited the file after the apply, and
 * deleting their work is not this script's call. A path already absent needs nothing.
 *
 * WHAT A ROLLBACK DOES NOT UNDO:
 *   · the JSONL files the collector already wrote (backend/data/index-changes/*.jsonl and their
 *     .pages.json sidecars). They are collected observations, not code, and they stay. Removing the
 *     collector only means nothing adds to them; the rows already there remain readable and remain
 *     exactly what the pages said, with their own provenance.
 *   · a change-registry row or an agent-ledger line, if record.cjs was run. Registry rows are never
 *     removed; a later row says the change was rolled back.
 *
 * AFTER A ROLLBACK there is no index-change collector at home: nothing records announced S&P 500 / 400 /
 * 600 or Nasdaq-100 additions and deletions, and nothing reads those pages. Nothing else breaks,
 * because nothing else requires these files (if something does by then, --plan says so and refuses).
 *
 * Exit 0 the paths are absent again, or already were · 1 failed · 2 refused or usage.
 */
const fs = require("fs"), path = require("path");
const L = require("./lib.cjs");

const USAGE = `usage: node ${L.PKG_REL}/rollback.cjs --plan | --apply
  --plan   read-only: which paths would be removed, and what holds them back
  --apply  the write mode: removes the three paths when each is byte for byte the staged copy
Nothing was done.`;

/** anything at home that requires the paths this would remove: a rollback must not break a caller */
function callers({ repo = L.REPO } = {}) {
  const names = L.FILES.map((f) => path.basename(f.rel, ".js"));
  const out = [];
  const skip = new Set([".git", "node_modules", "docs"]);
  const walk = (dir, rel) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(p, r); continue; }
      if (!/\.(c?js|mjs)$/.test(e.name)) continue;
      if (L.FILES.some((f) => f.rel === r)) continue;                  // the shipped files may require each other
      let text; try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
      for (const n of names) if (new RegExp(`require\\([^)]*${n}(?:\\.js)?["']`).test(text)) { out.push(`${r} requires ${n}`); break; }
    }
  };
  walk(repo, "");
  return out;
}

module.exports = { callers };

if (require.main === module) {
  const args = process.argv.slice(2), MODE = args.length === 1 && ["--plan", "--apply"].includes(args[0]) ? args[0] : null;
  if (!MODE) { console.log(USAGE); process.exit(2); }

  const P = L.plan({ forRollback: true });
  const who = callers();
  const dataDir = path.join(L.REPO, ...L.DATA_DIR.split("/"));
  const written = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter((f) => /\.jsonl$/.test(f)) : [];

  console.log(`ROLLBACK ${MODE === "--plan" ? "PLAN (nothing is written)" : ""} — index change collector — ${new Date().toISOString().slice(0, 16)}Z (${L.mtWords(Date.now())} MT)`);
  for (const x of P.files) console.log(`  ${x.rel.padEnd(40)} ${x.state === "applied" ? `applied (sha ${x.stagedSha.slice(0, 12)}) -> would be REMOVED` : x.state === "absent" ? "already absent — nothing to do" : `DRIFT (sha ${String(x.home).slice(0, 12)}) — refused, it is not the staged copy`}`);
  console.log(`  data kept: ${written.length ? `${written.length} file(s) in ${L.DATA_DIR}/ (${written.join(", ")}) and their sidecars stay — observations, not code` : `${L.DATA_DIR}/ holds no collected file yet`}`);
  if (who.length) console.log(`  CALLERS: ${who.join("; ")} — removing these paths would break them`);

  const refusals = [...P.problems, ...who.map((w) => `${w}: a rollback would break it, so it is refused`)];
  if (MODE === "--plan") {
    console.log(`\n  unit: ${refusals.length ? "REFUSED by the write mode:\n    - " + refusals.join("\n    - ") : P.toRemove.length ? `the write mode would remove ${P.toRemove.map((x) => x.rel).join(", ")}` : "nothing to roll back"}`);
    console.log("  nothing was written.");
    process.exit(refusals.length ? 1 : 0);
  }

  if (refusals.length) { console.error(`REFUSED — nothing changed:\n  - ${refusals.join("\n  - ")}`); process.exit(2); }
  const M = L.make(), r = M.writeUnit({ to: "absent", gate: null });
  if (r.result === "refused") { console.error(`REFUSED — nothing changed:\n  - ${r.why.join("\n  - ")}`); process.exit(2); }
  if (r.result === "noop") { console.log(`nothing to roll back: ${r.why.join("; ")}.`); process.exit(0); }
  if (r.result === "failed") {
    console.error(`ROLLBACK FAILED: ${r.why.join("; ")}`);
    console.error(r.restored ? "  every path is back the way this run found it (the staged files are still at home)." : `  NOT RESTORED: ${(r.notRestored || []).join("; ")} — put those paths back from ${L.PKG_REL}/staged/ by hand, or re-run deploy.cjs --apply.`);
    process.exit(1);
  }
  console.log(`\nROLLED BACK: ${r.done.join(", ")} ${r.done.length === 1 ? "is" : "are"} not at home any more — the base state of this package.`);
  console.log("  Nothing to restart. No index-change collector is at home: nothing records index additions and deletions now.");
  if (written.length) console.log(`  ${written.length} already-collected file(s) in ${L.DATA_DIR}/ were NOT removed and are still readable.`);
  process.exit(0);
}
