#!/usr/bin/env node
/** R158 amendment (2026-09-23, BEFORE the read; only the controls had run). Controls v1 printed a drift-kept floor of +10,788% per month
 *  — impossible. A data-integrity diagnostic (data/ipo-universe-extremes-2026-09-23.json, no strategy computed) found: Nasdaq TEST
 *  symbols in the universe (ZWZZT +2.5 billion % in a day, ZAZZT, ZBZZT, ZCZZT, ZVZZT, ZVV...), and bankruptcy re-listings spliced onto
 *  the old stock (GPOR +52,648%, CBL +33,461%, SD +16,567% one-day moves); 276 names with a one-day move above +300%.
 *  Amendment: (1) drop exchange test symbols (Z?ZZT / ZVV / ZXIET patterns and names containing 'test'); (2) drop any name with a
 *  one-day close-to-close or gap move above +300% or below -90% (restructurings, bad adjustments); (3) entries only when the breakout
 *  close is >= $2. Disclosed with it: (2) also removes a few genuine squeeze names, biasing the result slightly DOWN. Refuses if applied. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R158");
if (!t) { console.error("R158 not found"); process.exit(2); }
if ((t.amendments || []).some((a) => a.id === "data-hygiene")) { console.error("already amended"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R158) { console.error("R158 sealed — amendments closed"); process.exit(2); }
if (fs.existsSync(D("r158-ipo-reversal.json"))) { console.error("R158 already read — amendments closed"); process.exit(2); }
(t.amendments ||= []).push({ id: "data-hygiene", date: "2026-09-23", beforeRead: true,
  change: "(1) exclude exchange test symbols; (2) exclude names with any one-day move > +300% or < -90%; (3) enter only when the breakout close >= $2",
  why: "controls v1 drift-kept floor +10,788%/month; diagnostic found Nasdaq test tickers and bankruptcy re-listings spliced onto old histories",
  disclosure: "(2) also drops a few genuine squeeze names (biases DOWN); (3) excludes penny stocks nobody would trade this way.",
  seen: "Only controls output and a data-integrity scan of one-day move sizes. No strategy statistic on real data had been computed." });
t.rule += " AMENDED 2026-09-23 (pre-read): exchange test symbols excluded; names with any one-day move > +300% or < -90% excluded; entry only when the breakout close >= $2.";
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-23", area: "R158 amendment — data hygiene", category: "amendment", breaksComparability: false, change: "Test symbols and >300%/-90% one-day-move names excluded; $2 minimum entry.", why: "Impossible control floor traced to bad data.", doesNotEstablish: "Anything about the real result, which had not been computed.", operator: "Josh 2026-09-23" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "amend-pre-read", test: "R158", detail: "data hygiene: test symbols, >300% moves, $2 min" }) + "\n");
console.log("R158 amended (pre-read): data hygiene");
