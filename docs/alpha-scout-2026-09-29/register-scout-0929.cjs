#!/usr/bin/env node
/** Registers the 2026-09-29 alpha-scout ten + operator card 11 (SCOUT-0929 family) from docs/alpha-scout-2026-09-29/picked-11.json BEFORE any runner exists or any
 *  price/signal is fetched. Operator 2026-09-29: "have the alpha scout find 10 new strategies and have them tested for presentation; 09-29 evening: run alpha testing".
 *  One multiplicity family, best-of-11: each test's bar = nullBar({variants:11 x its cells, n: its own unit count}).p95 (the family's shots) — a test
 *  whose own card examines V parameter cells owes variants = 11 x V. Ids R284..R294 in rank order. Refuses if any id exists.
 *  Usage: node register-scout-0929.js <backend dir> <picked-10.json> */
const fs = require("fs"), path = require("path"); const [BK, PICK] = process.argv.slice(2);
const { writeJsonAtomic } = require(path.join(BK, "lib", "atomic-write.js")); const { nullBar } = require(path.join(BK, "lib", "null-bar.js"));
const D = (f) => path.join(BK, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const picked = JSON.parse(fs.readFileSync(PICK, "utf8")).picked; if (picked.length !== 11) throw new Error("expected 11 picks, got " + picked.length);
const have = new Set([...(reg.tests || []), ...(reg.preregistered || [])].map((t) => t.id));
const ids = picked.map((_, i) => "R" + (284 + i)); for (const id of ids) if (have.has(id)) { console.error(`${id} exists — refusing`); process.exit(2); }
const TODAY = "2026-09-29", FAM = "SCOUT-0929 — the 09-29 alpha scout ten + operator card 11 (R284-R294), one family, best-of-11 x each card's own variants; bars from lib/null-bar.js at each test's own unit count";
const ORIGIN = "Alpha scout 2026-09-29 (four lane agents + judge; cards in docs/alpha-research-2026-09-29.md); operator: 'find 10 new strategies and have them tested for presentation; 09-29 evening: run alpha testing'.";
const slug = (k) => k.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const out = [];
picked.forEach((c, i) => {
  const id = ids[i], td = c.testDesign || {}, V = Math.max(1, +td.variants || 1), n = Math.max(8, +td.nEstimate || 60);
  const bar = +nullBar({ variants: 11 * V, n, trials: 20000 }).p95.toFixed(3);
  const entry = {
    id, name: `${c.name} (${(c.sources || []).map((s) => s.title.split(",")[0]).slice(0, 1).join("")}${c.sources?.[0]?.year ? " " + c.sources[0].year : ""})`,
    registered: TODAY, evidenceStart: `${td.window || "post-publication window"} (historical, read once)`, script: `backend/${id.toLowerCase()}-${slug(c.key)}.js`, scoutKey: c.key, lane: c.lane || null,
    status: `REGISTERED ${TODAY} — historical, read once (--selftest, then --read); builder assigned the same evening`,
    parent: ORIGIN + " Source: " + (c.sources || []).map((s) => `${s.title} ${s.url}`).join(" · "),
    multiplicityFamily: FAM + (V > 1 ? ` · this card examines ${V} cells, so its bar is best-of-${11 * V}` : ""),
    rule: c.rule, mechanism: c.mechanism || null, reportedEffect: c.effect || null,
    statistic: `Per-${td.unit || "unit"} net return of the rule (cost model: equities $0.01/share + half spread, futures 1 tick + $2.50/side, crypto 25 bps/side, options full crossing); one-sample t over ${td.unit || "units"} (clustering unit = ${td.unit || "unit"}, never tickets). Gross reported beside.`,
    unit: td.unit || null, nExpected: n,
    bar: { fixedInAdvance: true, unit: td.unit || null, tRequired: bar, variants: 11 * V, source: `nullBar({variants:${11 * V}, n:${n}, trials:20000}).p95 = ${bar}` },
    controls: { placebo: td.controls || "random-timing null (>=200 draws) — the true rule must beat its 95th percentile", halves: "first/second half of the window must share the sign" },
    interimKill: "none (single historical read)", readCondition: "read once after --selftest passes its known answer",
    decisionRule: { pass: "Presented as PASS; a forward paper test is the operator's call — nothing is adopted or funded by a pass.", fail: "Presented as DID NOT PASS with the numbers; the card is closed unless materially new evidence appears." },
    expectation: `${c.prior || "LOW"} — ${c.priorWhy || ""}`, knownWeaknesses: [c.dataGap ? "Data gap: " + c.dataGap : "none declared by the scout", "Registered the same evening it was found; the window is post-publication where the card allows, so the read is out of sample to the source but not to the scout's own reading of it."],
    buildNotes: c.buildNotes || null, nearestExistingTest: c.nearestExistingTest || null,
    ip: "ours (public sources; the rule text is ours)", writerExists: false, writerNote: "runner written by the builder agent the same evening; if it cannot be built the entry is marked CANNOT MEASURE, never left starving",
  };
  reg.preregistered.push(entry); out.push({ id, key: c.key, bar, n, variants: 11 * V, script: entry.script });
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: TODAY, area: "registry — SCOUT-0929 family", category: "registration", breaksComparability: false, change: `Registered R284-R294 (alpha scout 09-29 ten cards + operator card 11, best-of-11 family) before any runner or data: ${out.map((o) => o.id + " " + o.key).join(", ")}`, why: "Operator: find 10 new strategies and test them for presentation.", doesNotEstablish: "Any result.", operator: "Josh 2026-09-29" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "register", tests: ids, family: "SCOUT-0929", detail: "eleven cards registered before evidence; builders assigned" }) + "\n");
fs.writeFileSync(path.join(path.dirname(PICK), "registered-ids.json"), JSON.stringify(out, null, 1));
console.log(out.map((o) => `${o.id} ${o.key} bar ${o.bar} (n ${o.n}, best-of-${o.variants}) -> ${o.script}`).join("\n"));
