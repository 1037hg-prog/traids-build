#!/usr/bin/env node
/** Registers the seven #4 alpha-hunt hypotheses (R164-R170) from their frozen specs (backend/data/hunt/<KEY>-spec.json), BEFORE any
 *  control or real-data statistic. 2026-09-23/24, operator's ordered plan item #4. Each script's own bar stays (t >= spec.barTRequired);
 *  on top, the hunt pays for seven shots: a hypothesis PASSES only if its holdout t also clears the best-of-7 family bar simulated here.
 *  Refuses if any of R164-R170 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const KEYS = ["PENSION_REBAL", "FOMC_DAYS", "INTRADAY_MOM", "OVN_INTRA_FREQ", "TURN_OF_MONTH", "ETF_TSMOM", "SALIENCE"], IDS = KEYS.map((_, i) => "R" + (164 + i));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => IDS.includes(t.id))) { console.error("R164-R170 already exist — refusing"); process.exit(2); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a, L = 3) { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let k = 1; k <= L; k++) { let c = 0; for (let i = k; i < n; i++) c += d[i] * d[i - k]; v += 2 * (1 - k / (L + 1)) * c / n; } return m / Math.sqrt(v / n); }
const rng = mulberry(1647), mx = []; for (let t = 0; t < 20000; t++) { let b = -Infinity; for (let v = 0; v < 7; v++) { const s = []; for (let i = 0; i < 57; i++) s.push(rng() * 2 - 1); b = Math.max(b, nwT(s)); } mx.push(b); }
mx.sort((a, b) => a - b); const FAMILY = +mx[Math.floor(0.95 * mx.length)].toFixed(3);
const EXTRA = {
  TURN_OF_MONTH: ["Coverage check tolerates missing weekdays (re-review 2026-09-23); verified the same night that SPY daily bars cover all 2,506 official Alpaca calendar sessions 2016-10-01..2026-09-22 with none missing, so the shift cannot occur on this data."],
  PENSION_REBAL: ["SPY and TLT verified complete against the official calendar (2,506 of 2,506 sessions)."],
  INTRADAY_MOM: ["v2 panel truncation censors the +300% jump of a held name (flatters the short leg). Measured 2026-09-23: only 2 truncated names were in the liquid top-1,500 universe in their cut month (AMC 2021-01-27 discovery; WOLF 2025-09-29 holdout) — an effect of a few hundredths of a percent per month; disclosed, not corrected.", "Dollar volume on adjustment=all prices embeds later dividends (volume is split-adjusted only): the $5M screen and top-1,500 rank depend mildly on future payouts; not removable without per-name dividend history."],
  OVN_INTRA_FREQ: ["v2 truncation censoring: only AMC (2021-01) and WOLF (2025-09) were in the universe in their cut month; disclosed.", "Dollar volume on adjusted prices embeds later dividends; disclosed."],
  SALIENCE: ["v2 truncation censoring: only AMC (2021-01) and WOLF (2025-09) were in the universe in their cut month; disclosed.", "Dollar volume on adjustment=all prices embeds the cumulative factor of dividends paid after t (volume is split-adjusted only); universe membership near the $5M screen and the rank-1,500 margin depends mildly on future payouts; not removable without per-name dividend history (re-review 2026-09-23)."],
};
KEYS.forEach((k, i) => {
  const sp = JSON.parse(fs.readFileSync(D(`hunt/${k}-spec.json`), "utf8"));
  reg.preregistered.push({ id: IDS[i], name: `Alpha hunt #4 — ${sp.name || k}`, registered: "2026-09-24", evidenceStart: "2017-01-01 (discovery); 2022-01-01 (holdout, sealed)",
    status: "REGISTERED 2026-09-24 — controls, discovery, then one holdout read", script: sp.script || `backend/hunt/${k}.js`, huntKey: k,
    evidenceNote: "Historical. Built by the #4 hunt workflow (one builder agent + an adversarial code reviewer + a fix round with a fresh re-reviewer); no real-data outcome was computed before this registration (builders were forbidden to, and each reported touchedRealOutcomes=false).",
    parent: "Operator 2026-09-23: ordered plan item #4 (multi-agent alpha hunt), seeded from the web survey docs/alpha-research-2026-09-23.md.",
    sources: sp.sources, rule: sp.rule, statistic: sp.statistic, unit: sp.unit, variants: sp.variants,
    multiplicityFamily: `ALPHA-HUNT-7 (R164-R170): seven hypotheses tested together; each must clear its own script bar (t >= ${sp.barTRequired}) AND the best-of-7 family bar t >= ${FAMILY}.`,
    bar: { fixedInAdvance: true, scriptBar: sp.barTRequired, familyBar: FAMILY, statistic: "Newey-West t (script-specific lag/unit, see spec)", passRule: `holdout net mean > 0, t >= max(${sp.barTRequired}, ${FAMILY}), both holdout halves positive`, source: `family bar simulated in register-hunt-2026-09-23.js: best of 7 NW(lag 3) t on iid noise, n=57, 20,000 trials, seed 1647, p95 = ${FAMILY}` },
    controls: sp.controls, costModel: sp.costModel, discovery: sp.discovery, holdout: sp.holdout,
    decisionRule: { pass: "A clearing hypothesis earns a forward paper test (registered separately) — nothing is traded on a backtest.", fail: "DID NOT PASS: closed on these data." },
    readCondition: `node ${sp.script || "backend/hunt/" + k + ".js"} --controls; --discovery; --holdout (once).`, expectation: sp.expectation,
    knownWeaknesses: [...(sp.knownWeaknesses || []), ...(EXTRA[k] || [])], specFile: `backend/data/hunt/${k}-spec.json`, writerExists: true });
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8")); cr.push({ date: "2026-09-24", area: "R164-R170 alpha hunt — registered", category: "registration", breaksComparability: false, change: `Seven hunt hypotheses registered before any statistic (${KEYS.join(", ")}); per-script bars plus a best-of-7 family bar t >= ${FAMILY}.`, why: "Operator's ordered plan, item #4.", doesNotEstablish: "Anything until each holdout is read.", operator: "Josh 2026-09-23" }); writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: IDS, detail: `alpha hunt x7, family bar ${FAMILY}` }) + "\n");
console.log(`registered ${IDS.map((id, i) => id + " " + KEYS[i]).join(" · ")} · family bar t >= ${FAMILY}`);
