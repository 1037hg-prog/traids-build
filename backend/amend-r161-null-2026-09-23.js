#!/usr/bin/env node
/** R161 amendment (2026-09-23, BEFORE discovery; no real-data statistic computed). The registered leak test ("scrambled panel, |t| < 2")
 *  failed three times for reasons in the NULL, not the study: (v1) the rebuilt scrambled path fell back to the real close after data gaps;
 *  (v2) a PERMUTATION fixes each stock's total return, so a strong past forces a weak future (momentum t -10 on noise); (v3) the test read
 *  NET spreads, which on noise are negative by exactly their cost. Now: iid bootstrap with replacement, drift removed, gross spreads.
 *  Result v4: every anomaly |gross t| < 2 on noise (max 1.64), positive control t 20.6. Refuses if already applied or discovery sealed. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R161");
if (fs.existsSync(D("r161-discovery.json"))) { console.error("discovery sealed — amendments closed"); process.exit(2); }
if ((t.amendments || []).some((a) => a.id === "null-bootstrap-gross")) { console.error("already amended"); process.exit(2); }
(t.amendments ||= []).push({ id: "null-bootstrap-gross", date: "2026-09-23", beforeDiscovery: true, change: "leak test: drift-free iid BOOTSTRAP (with replacement) instead of permutation; the path rebuild never reverts to real closes; the leak test reads GROSS spreads", why: "v1 path mixing; v2 permutation's fixed total forces reversal (momentum t -10 on noise); v3 net spreads on noise are negative by their cost", seen: "controls output only; no real-data statistic" });
t.controls.leakTest = "drift-free iid bootstrap panel: every anomaly's discovery |GROSS t| < 2 (amended 2026-09-23)";
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8")); cr.push({ date: "2026-09-23", area: "R161 amendment — null construction", category: "amendment", breaksComparability: false, change: "Leak test uses an iid bootstrap and gross spreads.", why: "Permutation and net-cost artifacts in the null.", doesNotEstablish: "Anything about real-data results (none computed).", operator: "Josh 2026-09-23" }); writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-pre-read", test: "R161", detail: "null: bootstrap + gross" }) + "\n");
console.log("R161 amended (pre-discovery): bootstrap null, gross leak test");
