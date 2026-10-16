#!/usr/bin/env node
/**
 * R24 FIX — STAGE the corrected forward state (2026-10-02, operator: "fix this"). Writes ONE file:
 *   backend/data/best-ideas-forward.corrected.json
 * and never touches backend/data/best-ideas-forward.json, cusip-map.json or the board.
 *
 * The corrected 2026-06-30 cohort is formed with the patched forward script's own formCohort() (backend/best-ideas-forward.js,
 * rule r24-fix-2026-10-02, managers from backend/lib/r24-managers.js), so the staged cohort is exactly what that script forms:
 *   period 2026-06-30, window closed 2026-08-14, formed at the close of 2026-08-17 (first NYSE session after the window), filings
 *   accepted by 16:00 ET 2026-08-17, entries = Alpaca SIP daily closes (raw) of 2026-08-17.
 * Also recorded (NOT counted): the corrected 2026-03-31 cohort, formed at the 2026-05-18 close and closed at the 2026-08-17 close.
 *
 *   node docs/r24-fix/build-corrected.cjs
 * Then review, and apply with docs/r24-fix/apply-r24-fix.cjs (backs up, supersedes, writes).
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..", "..");
const BK = path.join(ROOT, "backend");
const { writeJsonAtomic } = require(path.join(BK, "lib", "atomic-write.js"));
const R = require(path.join(BK, "lib", "r24-managers.js"));
const F = require(path.join(BK, "best-ideas-forward.js"));          // guarded runner: require() does not run it
const FWD = path.join(BK, "data", "best-ideas-forward.json"), OUT = path.join(BK, "data", "best-ideas-forward.corrected.json");
const TODAY = "2026-10-02";

(async () => {
  const text = fs.readFileSync(FWD, "utf8"), base = JSON.parse(text);
  const baseSha = crypto.createHash("sha256").update(text).digest("hex");
  const state = JSON.parse(text);
  const q1 = state.cohorts.find((c) => c.period === "2026-03-31" && c.result);
  const open = state.cohorts.filter((c) => !c.closed && !c.superseded);
  if (!q1) throw new Error("expected the closed 2026-03-31 cohort in best-ideas-forward.json");
  if (open.length !== 1 || open[0].period !== "2026-06-30" || open[0].formed !== "2026-08-14") throw new Error("expected exactly one open cohort: 2026-06-30 formed 2026-08-14");
  const old = open[0];

  const cal = await F.sessions("2025-06-01", "2027-03-31");
  const F2 = R.formationDate("2026-06-30", cal), F1 = R.formationDate("2026-03-31", cal);
  if (F2 !== "2026-08-17" || F1 !== "2026-05-18") throw new Error(`formation dates ${F1}/${F2} differ from the expected 2026-05-18/2026-08-17 — refusing`);

  console.log("\n  CORRECTED 2026-06-30 (current) cohort");
  const { cohort: cur, cusipAdds: add2 } = await F.formCohort("2026-06-30", F2);
  console.log("\n  CORRECTED 2026-03-31 (previous) cohort — for the record, not counted");
  const { cohort: prev, cusipAdds: add1 } = await F.formCohort("2026-03-31", F1);
  await F.closeCohort(prev, F2, cur.legs);

  cur.reconstructed = { on: TODAY, why: "Re-formed under rule r24-fix-2026-10-02 after r24-attribution.js found 8 of the 16 names in the pre-fix cohort came from stale or wrong filings. Membership is fixed by EDGAR filings accepted by 16:00 ET 2026-08-17 and entries are the official 2026-08-17 SIP closes: no discretion, no look-ahead, and every name still trades, so the reconstruction carries no survivorship. It is nevertheless a reconstruction, not a live observation, and is flagged as such." };
  const oldNames = old.legs.map((l) => l.tk), newNames = cur.legs.map((l) => l.tk);
  old.superseded = { date: TODAY, by: `2026-06-30 formed 2026-08-17 (rule ${F.RULE})`,
    reason: "Pre-fix rule: formed ON the deadline day (2026-08-14) at live quotes, before Third Point's on-time Q2 filing (accepted 17:18 ET) was on EDGAR; each manager's latest filing filled in whatever its period (Greenlight 2023-12-31 under a dead CIK, Scion 2025-09-30, Pershing Q1 under the old CIK, Third Point Q1); Baupost's stored CIK was a 2002 /ADV shell; CRH and CONSOL dropped silently as unmapped. 8 of 16 names were from current-period filings.",
    dropped: oldNames.filter((s) => !newNames.includes(s)), added: newNames.filter((s) => !oldNames.includes(s)), kept: newNames.filter((s) => oldNames.includes(s)) };
  old.closed = { date: TODAY, superseded: true, note: "Superseded, not closed at a price: no result is recorded and it never counts toward the read. Kept for the audit trail." };

  q1.countsTowardRead = false;
  q1.annotations = [...(q1.annotations || []), { date: TODAY, note: "Formed at the forward leg's first run (2026-07-23, live quotes) under the pre-fix rule: a 16-session stub, not a full formation-to-formation quarter, with stale filings (Greenlight 2023-12-31, Scion 2025-09-30) and Baupost absent. Kept with its recorded result; excluded from the read count (registry amendment 2026-10-02). The corrected cohort for the same period is in correctedForRecord (reconstructed, also not counted)." }];
  q1.correctedForRecord = { period: prev.period, formed: prev.formed, closed: prev.closed.date, rule: F.RULE, names: prev.legs.map((l) => l.tk), skippedUnmapped: prev.skippedUnmapped, result: prev.result,
    members: prev.members.map((m) => ({ manager: m.manager, cik: m.cik, accession: m.accession, contributes: m.contributes, top3: m.top3.map((e) => e.ticker || e.issuer), ...(m.why ? { why: m.why } : {}) })) };

  state.cohorts.push(cur);
  state.managerConfig = { source: "backend/lib/r24-managers.js", rule: F.RULE, managers: R.MANAGERS };
  state.corrections = [...(state.corrections || []), { date: TODAY, rule: F.RULE, by: "docs/r24-fix/build-corrected.cjs", baseFile: "backend/data/best-ideas-forward.json", baseSha256: baseSha,
    summary: `2026-06-30 cohort re-formed at the 2026-08-17 close (${newNames.length} names; dropped ${old.superseded.dropped.join(" ")}; added ${old.superseded.added.join(" ")}); the 2026-08-14 cohort kept as superseded; the 2026-03-31 stub kept, excluded from the read count.` }];
  const pend = { ...add1, ...add2 };
  if (Object.keys(pend).length) state.pendingCusipAdds = pend;       // persisted to cusip-map.json only by the apply step

  writeJsonAtomic(OUT, state);
  const chk = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const sleevePick = chk.cohorts.filter((c) => !c.closed).slice(-1)[0];           // backend/r24-sleeve.js selection rule
  console.log(`\n  staged ${path.relative(ROOT, OUT)} · base sha256 ${baseSha.slice(0, 16)}… (original file untouched)`);
  console.log(`  r24-sleeve.js would hold: ${sleevePick.period} formed ${sleevePick.formed} · ${sleevePick.legs.map((l) => l.tk).join(" ")}`);
  console.log(`  dropped ${old.superseded.dropped.join(" ")} · added ${old.superseded.added.join(" ")} · kept ${old.superseded.kept.length}`);
  console.log(`  corrected 2026-03-31 (record only): ${prev.legs.length} names, ${prev.formed} -> ${prev.closed.date}: portfolio ${(100 * prev.result.port).toFixed(2)}% vs SPY ${(100 * prev.result.spy).toFixed(2)}%`);
  if (Object.keys(pend).length) console.log(`  pending cusip-map additions (written by the apply step): ${JSON.stringify(pend)}`);
  if (base.cohorts.length !== chk.cohorts.length - 1) throw new Error("staged file cohort count is off");
})().catch((e) => { console.error("\n  build-corrected FAILED:", e.message, "\n"); process.exit(1); });
