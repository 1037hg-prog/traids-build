#!/usr/bin/env node
/** R155 amendment (2026-09-23, BEFORE the read; only the winners-only look-ahead subset had been computed). The positive control's fixed
 *  t >= 3 cannot be met by BTC-PUB even with perfect foresight: the published configuration makes only 9 winning out-of-sample trades in
 *  67 months, and the winners-only subset reads t 2.717. The control's purpose is to show the pipeline CAN clear the bar when an edge
 *  exists; the requirement becomes "winners-only t_NW >= the member's own bar" for every member. Disclosed with it: BTC-PUB's power is
 *  very low — only a near-perfect strategy could clear its bar — so a BTC-PUB fail is weak evidence. Refuses if already amended. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R155");
if (!t) { console.error("R155 not found"); process.exit(2); }
if ((t.amendments || []).some((a) => a.id === "positive-control-member-bar")) { console.error("already amended"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R155) { console.error("R155 sealed — amendments closed"); process.exit(2); }
if (fs.existsSync(D("r155-delta-rsi-oos.json"))) { console.error("R155 already read — amendments closed"); process.exit(2); }
(t.amendments ||= []).push({ id: "positive-control-member-bar", date: "2026-09-23", beforeRead: true,
  change: "positiveControl.requirement: 't_NW >= 3 for every member' -> 'winners-only t_NW >= the member's own bar (family bar + noise mean) for every member'",
  why: "controls v1: BTC-PUB winners-only t 2.717 on 9 trades (bar 2.242); STOCKS-PUB 11.4, STOCKS-DEF 23.1. A fixed 3 ignores sample size; the control asks whether the pipeline can clear the member's bar given an edge, and it can.",
  disclosure: "BTC-PUB is very under-powered: even perfect foresight reads t 2.72 against a 2.24 bar. A BTC-PUB DID NOT PASS says little; a PASS would need near-perfect trades.",
  seen: "Only the controls' outputs (scrambles and the winners-only subset). No unfiltered real statistic had been computed." });
t.controls.positiveControl.requirement = "winners-only t_NW >= the member's own bar (amended 2026-09-23, pre-read)";
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-23", area: "R155 amendment — positive control scaled to the member bar", category: "amendment", breaksComparability: false, change: "R155 positive control: winners-only t must beat each member's own bar instead of a fixed 3 (pre-read).", why: "BTC-PUB has 9 winning out-of-sample trades; perfect foresight reads t 2.72, above its 2.24 bar but below 3.", doesNotEstablish: "Anything about the real out-of-sample result, which had not been computed.", operator: "Josh 2026-09-23 ('keep mining')" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-pre-read", test: "R155", detail: "positive control scaled to member bar; BTC-PUB power disclosed" }) + "\n");
console.log("R155 amended (pre-read): positive control = winners-only t >= member bar");
