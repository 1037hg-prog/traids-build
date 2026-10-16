#!/usr/bin/env node
/** R149 pre-read amendment (2026-09-23). The registered controls failed on their first run, for reasons that are about the controls,
 *  not the pipeline; no real read has been made. Recorded as a dated amendment, never a silent edit. Refuses to run twice. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R149");
if (!t) { console.error("R149 not found"); process.exit(2); }
if ((t.amendments || []).some((a) => a.id === "controls-v2-2026-09-23")) { console.error("already amended"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R149) { console.error("R149 already sealed — an amendment now would be post-evidence"); process.exit(2); }
if (fs.existsSync(D("r149-tv-family.json"))) { console.error("an R149 read file exists — refusing"); process.exit(2); }
(t.amendments ||= []).push({ id: "controls-v2-2026-09-23", date: "2026-09-23", preEvidence: true,
  what: "Leak test moved to DRIFT-FREE scrambled prices (each symbol's shuffled path demeaned to zero drift); the drift-KEPT scrambles still set each member's floor. Positive control changed from 'close 5 bars after entry on the winning side' to 'the trade's own realised net return is positive'.",
  why: "Controls v1 failed on their first run. (1) Drift, not leakage: a bar shuffle keeps each symbol's own mean return, so the long-only TQQQ member earned TQQQ's 2016-2026 drift on noise (t 3.07) and the always-in-market crossovers picked it up too (WMA-EMA 2.44, PMAX 2.30). A leak test must be run on noise with no drift; the drift belongs in the floor, where it already was. (2) A 5-bar peek cannot decide a trade held for weeks: PMAX reached only t 1.61 with the peek. Pipeline code, the rule, the statistic, the bar and the decision rule are unchanged.",
  evidenceSeen: "Only the controls' outputs: scrambled-price runs and the look-ahead (winners-only) subset of real trades. No unfiltered real statistic has been computed." });
t.controls.leakTest = { amended: "2026-09-23", method: "every bar's shape shuffled within its symbol with the symbol's drift removed (seeds 1, 2)", requirement: "no member reaches t_NW >= 2 on drift-free scrambled prices", floor: "from drift-kept scrambles (seeds 1, 2), as registered" };
t.controls.positiveControl = { amended: "2026-09-23", method: "keep only trades whose realised net return is positive (outcome look-ahead)", requirement: "t_NW >= 3 for every member" };
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-23", area: "R149 controls amended pre-read", category: "amendment", breaksComparability: false, change: "Leak test on drift-free scrambles; floor unchanged (drift-kept); positive control on trade outcome.", why: "v1 controls failed on drift and on a peek too short for multi-week holds; no real read made.", operator: "assistant, disclosed to Josh 2026-09-23" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-pre-read", test: "R149", detail: "controls v2: drift-free leak test, outcome look-ahead" }) + "\n");
console.log("R149 amended (controls v2), pre-read");
