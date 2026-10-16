#!/usr/bin/env node
/** R316 pre-evidence amendment (2026-10-02): the interim kill becomes ONE look at the first after-close with >= 40 round trips, at
 *  bar t <= -3.13 on the registered statistic (entry-day clustered t of fill-to-fill returns). The 2026-10-02 measurement review found
 *  nightly looks at -2.0 stop a zero-edge arm 46.8% of the time within 24 months (14.9% before the 60-trip read) and a single look at
 *  -2.0 still 11.7%; -3.13 is its calibrated one-look threshold. No R316 order has been sent. Refuses if already amended or evidence began. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R316"); if (!t) throw new Error("no R316");
if ((t.amendments || []).some((a) => a.field === "interimKill")) throw new Error("already amended");
if (fs.existsSync(D("r316-ledger.jsonl")) && /"kind":"(fill|order|round-trip)"/.test(fs.readFileSync(D("r316-ledger.jsonl"), "utf8"))) throw new Error("evidence has begun — amendment illegal");
const was = t.interimKill;
t.interimKill = "AMENDED 2026-10-02 (pre-evidence): ONE look, at the first after-close with >= 40 completed round trips: entry-day clustered t of fill-to-fill net return <= -3.13 -> stop new entries (exits continue under the rule; kill only). Any order sent outside 15:50-15:59 ET or to a non-paper endpoint -> HALT and alert (unchanged). The calendar-time Newey-West (lag 10) t of the daily book P&L is reported beside it, ungated.";
(t.amendments ||= []).push({ date: "2026-10-02", preEvidence: true, field: "interimKill", was, becomes: t.interimKill,
  why: "Pre-live measurement review (2026-10-02): the registered nightly check at t <= -2.0 stops a zero-edge arm on noise 46.8% of the time within 24 months (14.9% before the 60-trip execution read); a single look at -2.0 is still 11.7%; -3.13 is the reviewer's calibrated one-look threshold for this statistic. No R316 order has been sent. Runner constant INTERIM_T changed in backend/r316-ibs-forward.js (backup docs/r316/r316-ibs-forward.pre-killbar.js); selftest PASS." });
t.status = "REGISTERED 2026-10-02 (interim-kill amendment 2026-10-02, pre-evidence) — forward; evidence from the first session the reviewed runner trades; runner built and reviewed"; t.writerExists = true;
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-10-02", area: "registry — R316 interim-kill amendment (pre-evidence)", category: "registration", breaksComparability: false, change: "R316 interim kill: nightly t <= -2.0 -> one look at >= 40 round trips, t <= -3.13 (calibrated); runner built + reviewed (selftest 45/45), schedule TRAIDS R316 1354/1357 pending operator creation; close-chain --after-close step added.", why: "Review calibration; operator 2026-10-02 'run R313 forward'.", doesNotEstablish: "Any result.", operator: "Josh 2026-10-02" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-pre-evidence", tests: ["R316"], detail: "interim kill one look at -3.13" }) + "\n");
console.log("R316 amended (pre-evidence): interim kill one look at t <= -3.13");
