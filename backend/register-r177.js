#!/usr/bin/env node
/** Registers R177 — the Trend-only replay-ranker lead, tested where it was NOT found. 2026-09-24, operator: "pursue the trend-only lead".
 *  The lead (Trend-strategy tickets only: ridge top-minus-bottom t 1.94 vs a 1.93 bar) was found AFTER the fact on the 2024-01..2026-09
 *  replay, so that span can never confirm it. Two independent legs, both registered before either is computed:
 *    (a) HISTORICAL HOLDOUT — the board replay extended to 2021-01..2023-12 (never built or looked at), scored by the FROZEN artifact
 *        data/replay-ranker.json (ridge, primary) — no refit, no retuning;
 *    (b) FORWARD — the same frozen scorer stamped on live Trend signal tickets from 2026-09-25 (obs.replayRank). */
const fs = require("fs"), path = require("path"), crypto = require("crypto"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R177")) { console.error("R177 already exists — refusing"); process.exit(2); }
const artRaw = fs.readFileSync(D("replay-ranker.json")), art = JSON.parse(artRaw);
const BAR_A = +nullBar({ variants: 1, n: 600, trials: 20000 }).p95.toFixed(3), BAR_B = +nullBar({ variants: 1, n: 30, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: "R177", name: "Trend-only replay ranker — frozen scorer on a 2021-2023 holdout and forward on live Trend tickets",
  registered: "2026-09-24", evidenceStart: "(a) 2021-01-04..2023-12-29 replay, built after this registration; (b) live tickets opened from 2026-09-25",
  evidenceNote: `Post-hoc lead from the 2024-2026 replay (Trend subset t 1.94 vs bar 1.93) — that span is excluded from both legs. Frozen artifact ${art.version} (ridge, ${art.features.length} features, fitted through ${art.trainedThrough}); may not be refit for this test.`,
  artifact: { file: "backend/data/replay-ranker.json", version: art.version, model: "ridge", sha256: crypto.createHash("sha256").update(artRaw).digest("hex") },
  status: "REGISTERED 2026-09-24 — (a) replay 2021-2023 to be built; (b) stamping from 2026-09-25",
  script: "backend/board-replay.js --from 2021-01-04 --to 2023-12-29 (build) + backend/r177-trend-holdout.js (read); forward via lib/entry-ml.js replayStamp",
  parent: "Operator 2026-09-24: 'pursue the trend-only lead'. Lead source: replay-ranker-fit.js post-hoc subset table.",
  multiplicityFamily: "TREND-LEAD-2 — two independent legs, each with its own single-variant bar; (a) decides whether the lead is real history, (b) whether it may ever act.",
  rule: "Population: replay (a) or live (b) EQUITY signal tickets with strategy Trend. Score = the frozen ridge's prediction from the ticket's entry-time fields and obs. Per session with >= 4 Trend tickets: top half minus bottom half mean R (gross; ties broken by a seeded random key, never row order).",
  statistic: "t over sessions of the per-session gap. Secondary (must also be > 0 for a pass): the same gap computed WITHIN direction (longs ranked among longs, shorts among shorts), because the parent result was mostly a long-vs-short split.",
  bar: { fixedInAdvance: true, a: { unit: "sessions (~600-700 in 2021-2023)", tRequired: BAR_A, variants: 1 }, b: { unit: "sessions with >= 4 live Trend tickets", minSessions: 30, tRequired: BAR_B, variants: 1 }, source: "nullBar variants 1 at n 600 (a) and n 30 (b), 20,000 trials, computed 2026-09-24" },
  controls: { leak: "within-session label shuffle through the same pipeline: |t| < 2", peek: "rank by realised R: must clear the bar", survivorship: "report the pitLiquid (liquid-at-the-time) subset beside the full roster; today's roster applied to 2021 is more survivor-biased than 2024" },
  interimKill: "(b): at 15 sessions, t <= -2 -> stop and report",
  decisionRule: { pass: "(a) passes primary and secondary -> the lead is real history; (b) decides action: if (b) also passes at 30 sessions, memo to the operator proposing the ranker as a Trend-only input to the central head. The gap must still be compared with ~0.1R cost — a ranker, not a standalone strategy.", fail: "(a) fails -> the lead was a post-hoc accident; (b) keeps stamping as a record and is read once for the file." },
  readCondition: "(a) once the 2021-2023 replay is built and sanity-checked (fidelity is inherited from the 2024-2026 live-overlap check; no live overlap exists for 2021-2023); (b) 30 qualifying sessions.",
  expectation: "I expect (a) DID NOT PASS: a subset found at the bar's edge after the fact usually regresses, and older years carry more survivorship.",
  knownWeaknesses: ["Survivorship worsens backward: today's roster in 2021 includes names that were not yet large or liquid.", "Entry at the 09:40 5-minute price; the live board sometimes scanned later.", "Gross R; ~0.1R/ticket cost makes a small gap untradeable on its own.", "Trend tickets per session may be few; sessions with < 4 are skipped."],
  ip: "none — our board", writerExists: false,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-24", area: "R177 Trend-only replay-ranker lead — registered", category: "registration", breaksComparability: false, change: `Frozen ${art.version} tested on a 2021-2023 replay holdout (bar ${BAR_A}) and forward on live Trend tickets (bar ${BAR_B}); entry-ml replayStamp turned on (stamp only, weight zero).`, why: "Operator: 'pursue the trend-only lead'.", doesNotEstablish: "Anything until the reads; the 2024-2026 t 1.94 is post-hoc.", operator: "Josh 2026-09-24" });
writeJsonAtomic(D("change-registry.json"), cr);
const cfg = JSON.parse(fs.readFileSync(D("entry-ml-config.json"), "utf8")); cfg.replayStamp = true; cfg.note += " | 2026-09-24: replayStamp -> true (R177 forward leg; stamp only)."; writeJsonAtomic(D("entry-ml-config.json"), cfg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R177"], detail: `Trend-only lead: holdout bar ${BAR_A}, forward bar ${BAR_B}; artifact ${art.version}` }) + "\n");
console.log(`R177 registered · (a) bar ${BAR_A} · (b) bar ${BAR_B} · artifact ${art.version}`);
