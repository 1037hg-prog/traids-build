#!/usr/bin/env node
/**
 * R24 FIX — APPLY the staged correction (operator's step; nothing runs this automatically).
 *   node docs/r24-fix/apply-r24-fix.cjs --dry    show exactly what would change, write nothing
 *   node docs/r24-fix/apply-r24-fix.cjs          apply
 *
 * Steps (fail closed at each):
 *   (0) checks: the staged file backend/data/best-ideas-forward.corrected.json exists and was built from the live file — either the
 *       live file's sha256 equals the staged baseSha256, or the live open cohort is still exactly the defective 2026-06-30 cohort
 *       formed 2026-08-14 (same tickers and entries) and no cohort was added since. Anything else refuses.
 *   (i)   backs up backend/data/best-ideas-forward.json to backend/data/best-ideas-forward.backup-<stamp>.json (writeJsonAtomic) and
 *         checks the backup parses to the same object.
 *   (ii)  marks the defective open cohort SUPERSEDED (kept in place, flagged with the reason and date, no result, never counted);
 *         annotates the 2026-03-31 stub (kept with its result, countsTowardRead false, corrected cohort recorded beside it).
 *   (iii) appends the corrected 2026-06-30 cohort (formed at the 2026-08-17 close) as the current open cohort, so tonight's Friday
 *         close-chain step "r24 sleeve sync" (backend/r24-sleeve.js, last open cohort) re-syncs the board on its own: it closes the
 *         names that left (reason "rebalance") and adds the new ones at live prices.
 *   Also persists the staged CUSIP->ticker additions to backend/data/cusip-map.json (writeJsonAtomic).
 * Re-reads the result and checks the selection rule of every reader (r24-sleeve.js, r24-alpaca-mirror.js, best-ideas-forward.js).
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..", "..");
const BK = path.join(ROOT, "backend");
const { writeJsonAtomic } = require(path.join(BK, "lib", "atomic-write.js"));
const FWD = path.join(BK, "data", "best-ideas-forward.json"), STG = path.join(BK, "data", "best-ideas-forward.corrected.json");
const CMAP = path.join(BK, "data", "cusip-map.json"), BOARD = path.join(BK, "data", "board_positions.json");
const DRY = process.argv.includes("--dry");
const die = (m) => { console.error(`\n  apply-r24-fix REFUSED: ${m}\n`); process.exit(1); };
const sig = (c) => JSON.stringify({ period: c.period, formed: c.formed, legs: (c.legs || []).map((l) => [l.tk, l.entry]) });

(() => {
  if (!fs.existsSync(STG)) die(`staged file missing: ${path.relative(ROOT, STG)} (run docs/r24-fix/build-corrected.cjs first)`);
  const liveText = fs.readFileSync(FWD, "utf8"), live = JSON.parse(liveText), stg = JSON.parse(fs.readFileSync(STG, "utf8"));
  const liveSha = crypto.createHash("sha256").update(liveText).digest("hex");
  const corr = (stg.corrections || []).slice(-1)[0];
  if (!corr || !corr.baseSha256) die("staged file has no corrections[].baseSha256");
  if ((live.corrections || []).some((c) => c.rule === corr.rule)) die(`best-ideas-forward.json already carries correction ${corr.rule} — already applied`);

  // (0) the live file must still be the base the staging was built from
  const stgOld = stg.cohorts.find((c) => c.superseded && c.period === "2026-06-30");
  const stgNew = stg.cohorts.filter((c) => !c.closed && !c.superseded).slice(-1)[0];
  const stgQ1 = stg.cohorts.find((c) => c.period === "2026-03-31" && c.result);
  if (!stgOld || !stgNew || !stgQ1 || stgNew.period !== "2026-06-30" || stgNew.formed !== "2026-08-17") die("staged file does not have the expected superseded / corrected / 2026-03-31 cohorts");
  const liveOpen = live.cohorts.filter((c) => !c.closed && !c.superseded);
  const sameBase = liveSha === corr.baseSha256;
  if (!sameBase) {
    if (liveOpen.length !== 1 || sig(liveOpen[0]) !== sig(stgOld)) die("the live open cohort is no longer the defective 2026-06-30/2026-08-14 cohort the staging was built from — rebuild the staged file");
    if (live.cohorts.length !== stg.cohorts.length - 1) die(`the live file has ${live.cohorts.length} cohorts; the staging expected ${stg.cohorts.length - 1} — rebuild the staged file`);
  }
  const liveQ1 = live.cohorts.find((c) => c.period === "2026-03-31" && c.result);
  if (!liveQ1 || JSON.stringify(liveQ1.result) !== JSON.stringify(stgQ1.result)) die("the live 2026-03-31 cohort result differs from the staged one");
  console.log(`\n  R24 FIX APPLY ${DRY ? "(DRY — nothing written)" : ""}\n  live file ${sameBase ? "is byte-identical to the staging base" : "changed bytes since staging but its cohorts match the staging base"} (sha256 ${liveSha.slice(0, 16)}…)`);

  // build the new state from the LIVE file (keeps anything else in it), applying the staged decisions
  const next = JSON.parse(liveText);
  const old = next.cohorts.find((c) => !c.closed && !c.superseded && c.period === "2026-06-30");
  Object.assign(old, { superseded: stgOld.superseded, closed: stgOld.closed });
  const q1 = next.cohorts.find((c) => c.period === "2026-03-31" && c.result);
  Object.assign(q1, { countsTowardRead: stgQ1.countsTowardRead, annotations: stgQ1.annotations, correctedForRecord: stgQ1.correctedForRecord });
  next.cohorts.push(stgNew);
  next.managerConfig = stg.managerConfig;
  next.corrections = [...(next.corrections || []), { ...corr, appliedAt: new Date().toISOString(), appliedBy: "docs/r24-fix/apply-r24-fix.cjs", liveSha256AtApply: liveSha }];

  // checks on the result, by each reader's own selection rule
  const sleevePick = next.cohorts.filter((c) => !c.closed).slice(-1)[0];                  // r24-sleeve.js
  const mirrorPick = next.cohorts.filter((c) => !c.closed && !c.superseded).slice(-1)[0];  // r24-alpaca-mirror.js
  const fwdOpen = next.cohorts.filter((c) => !c.closed && !c.superseded);                  // best-ideas-forward.js (exactly one)
  if (sleevePick !== stgNew || mirrorPick !== stgNew || fwdOpen.length !== 1) die("post-merge selection check failed — nothing written");
  const counted = next.cohorts.filter((c) => c.result && !c.superseded && c.countsTowardRead !== false);

  const names = stgNew.legs.map((l) => l.tk);
  console.log(`  (ii)  superseded: 2026-06-30 formed 2026-08-14 (${old.legs.length} names) — dropped ${stgOld.superseded.dropped.join(" ")}`);
  console.log(`        2026-03-31 stub kept, countsTowardRead=false (closed cohorts counted toward the read after apply: ${counted.length})`);
  console.log(`  (iii) current: 2026-06-30 formed ${stgNew.formed} (${names.length}): ${names.join(" ")}`);
  let board = []; try { board = JSON.parse(fs.readFileSync(BOARD, "utf8")).filter((p) => p && p.strategy === "R24-13F-clone"); } catch {}
  const have = new Set(board.map((p) => p.sym));
  console.log(`  tonight's "r24 sleeve sync" will: add ${names.filter((s) => !have.has(s)).join(" ") || "nothing"} · rotate out ${[...have].filter((s) => !names.includes(s)).join(" ") || "nothing"} (board holds ${have.size} R24 names now)`);
  const adds = stg.pendingCusipAdds || {};
  if (Object.keys(adds).length) console.log(`  cusip-map.json additions: ${JSON.stringify(adds)}`);
  if (DRY) { console.log("\n  DRY — nothing written.\n"); return; }

  // (i) backup, verified
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const BAK = path.join(BK, "data", `best-ideas-forward.backup-${stamp}.json`);
  writeJsonAtomic(BAK, live);
  if (JSON.stringify(JSON.parse(fs.readFileSync(BAK, "utf8"))) !== JSON.stringify(live)) die(`backup ${BAK} does not round-trip — nothing else written`);
  console.log(`  (i)   backup: ${path.relative(ROOT, BAK)}`);
  writeJsonAtomic(FWD, next);
  const back = JSON.parse(fs.readFileSync(FWD, "utf8"));
  if (back.cohorts.filter((c) => !c.closed).slice(-1)[0].formed !== "2026-08-17") die("re-read check failed after write — restore from the backup above");
  if (Object.keys(adds).length) { let cm = {}; try { cm = JSON.parse(fs.readFileSync(CMAP, "utf8")); } catch {} writeJsonAtomic(CMAP, { ...cm, ...adds }, { pretty: 0 }); }
  console.log(`  written: backend/data/best-ideas-forward.json${Object.keys(adds).length ? " + cusip-map.json" : ""}. The staged file is left in place for the record.\n`);
})();
