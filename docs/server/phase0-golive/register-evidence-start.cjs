#!/usr/bin/env node
/**
 * REGISTER EVIDENCE START — the registered dated note for R309's evidence start (runner N16), written AT HOME from the PULLED
 * config. 2026-10-06 (go-live package; re-verification finding: R309's registry entry says the start is "recorded as a dated note
 * in this entry when it happens", and nothing produced or checked that note — one fire-and-forget Telegram was the only prompt).
 *
 * Reads backend/data/r309-surge-hold48.json — the copy pull-r309 brings from the VPS (never edited here): config.evidenceStart (the
 * day the live runner wrote), config.evidenceStartFirst24At (the 24th consecutive fully evaluated hour; else the status's
 * gaps.first24ConsecutiveAt), config.evidenceStartSetAt and config.evidenceStartBy. Appends ONE amendment
 * "R309-evidence-start-<day>" to R309's entry in backend/data/test-registry.json, plus one agent-ledger row.
 * REFUSES (nothing written): no pulled file, or no evidenceStart in it; the day is not the UTC day the 24th hour closed; an
 * evidence-start note is already there (the same day: done; another day: investigate — the start never changes); R309 missing, or
 * also in tests[]; anything other than R309.amendments and asOf would change; R309's registered terms would change. JSON through
 * backend/lib/atomic-write.js writeJsonAtomic (the registry's own format); the agent ledger is appended. The VPS is not touched.
 * r309-health warns while the note is missing and fails 24 h after the start was set.
 *
 *   node docs/server/phase0-golive/register-evidence-start.cjs --dry       print the note, write nothing
 *   node docs/server/phase0-golive/register-evidence-start.cjs             write it
 *   node docs/server/phase0-golive/register-evidence-start.cjs --selftest  on temp copies (the real registry is only read)
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const HERE = __dirname, HOUR = 3600000;
const REPO = (() => { for (let d = HERE; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, "backend", "data")) && fs.existsSync(path.join(d, "deploy"))) return d; if (path.dirname(d) === d) throw new Error("repo root not found"); } })();
const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
const { termsSha } = require(path.join(HERE, "register-tv-note.cjs"));
const validDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
const isNote = (a) => !!a && /evidence-start/.test(String(a.kind || "") + " " + String(a.id || "")) && !!a.evidenceStart;

/** Pure on file paths: plan (dry) or write the note. Returns lines. Throws on any refusal (nothing written). */
function apply({ outFile, regFile, ledgerFile, dry = false, now = new Date() }) {
  if (!fs.existsSync(outFile)) throw new Error(`${path.basename(outFile)} is not at home — the pull has not brought it yet (deploy\\server\\pull-r309.bat)`);
  const o = JSON.parse(fs.readFileSync(outFile, "utf8")), cfg = (o && o.config) || {};
  const day = cfg.evidenceStart;
  if (!day) throw new Error("the pulled config has no evidenceStart — the live runner has not completed 24 consecutive fully evaluated hours yet (or the pull is behind)");
  if (!validDay(day)) throw new Error(`the pulled evidenceStart is not a day: ${JSON.stringify(day)}`);
  const fromNote = (/hour (\d{4}-\d\d-\d\dT\d\d:00:00Z)/.exec(String(cfg.evidenceStartNote || "")) || [])[1];
  const first24 = cfg.evidenceStartFirst24At || (o.gaps && o.gaps.first24ConsecutiveAt) || fromNote || null;
  if (!first24 || !Number.isFinite(Date.parse(first24))) throw new Error("the pulled file names no 24th consecutive hour (config.evidenceStartFirst24At / gaps.first24ConsecutiveAt) — cannot write a checked note");
  const completedAt = new Date(Date.parse(first24) + HOUR).toISOString().replace(".000Z", "Z");
  if (completedAt.slice(0, 10) !== day) throw new Error(`evidenceStart ${day} is not the UTC day the 24th hour ${first24} closed (${completedAt}) — refusing; investigate on the VPS (--status)`);
  const before = fs.readFileSync(regFile, "utf8"), reg = JSON.parse(before), list = reg.preregistered || [], e = list.find((t) => t && t.id === "R309");
  if (!e) throw new Error("R309 not found in test-registry.json preregistered");
  if ((reg.tests || []).some((t) => t && t.id === "R309")) throw new Error("R309 is also in tests[] — refusing (ambiguous entry)");
  const have = (e.amendments || []).filter(isNote);
  if (have.some((a) => a.evidenceStart === day)) throw new Error(`already noted: R309's registry entry records evidence start ${day} (${have.find((a) => a.evidenceStart === day).id || "note"})`);
  if (have.length) throw new Error(`R309's registry entry already records a DIFFERENT evidence start (${have.map((a) => a.evidenceStart).join(", ")}) but the VPS says ${day} — the start never changes; investigate before writing anything`);
  const ts0 = termsSha(e), today = now.toISOString().slice(0, 10);
  const note = {
    id: `R309-evidence-start-${day}`, date: today, kind: "evidence-start — the registered dated note", preEvidence: false, ruleChange: false,
    evidenceStart: day, first24ConsecutiveAt: first24, completedAt, evidenceStartSetAt: cfg.evidenceStartSetAt || null, evidenceStartBy: cfg.evidenceStartBy || null,
    text: `Evidence start ${day}: the first UTC day the runner completed 24 consecutive hourly cycles on the always-on host (fully evaluated: both coins, the TV account check passed — runner N16/N18). ` +
      `The 24th hour was ${first24}, closed ${completedAt}. Written into the runner's config on the VPS ${cfg.evidenceStartSetAt || "(time not recorded)"} by ${cfg.evidenceStartBy || "(not recorded)"}. ` +
      "Lots whose day is on or after it are evidence; earlier lots are shakeout. Recorded here from the pulled config, as the registered evidenceStart text requires.",
    source: "backend/data/r309-surge-hold48.json config, pulled from the VPS by pull-r309.cjs (docs/server/phase0-golive/register-evidence-start.cjs)",
    operator: `Josh ${today} (run at home)`,
  };
  const lines = [`R309 amendment ${note.id}: ${note.text.slice(0, 200)}…`];
  if (dry) return [...lines, "DRY — nothing written"];
  const other = JSON.stringify({ ...reg, asOf: null, preregistered: list.map((t) => (t === e ? null : t)) });
  e.amendments = [...(e.amendments || []), note];
  reg.asOf = now.toISOString();
  if (JSON.stringify({ ...reg, asOf: null, preregistered: list.map((t) => (t === e ? null : t)) }) !== other) throw new Error("internal: something other than R309 would change — refusing");
  if (termsSha(e) !== ts0) throw new Error("internal: R309's registered terms would change — refusing");
  writeJsonAtomic(regFile, reg);
  const re = JSON.parse(fs.readFileSync(regFile, "utf8")), r309 = re.preregistered.find((t) => t.id === "R309");
  if (termsSha(r309) !== ts0 || !r309.amendments.some((a) => a.id === note.id)) throw new Error("verification after the write FAILED — restore test-registry.json from git");
  fs.appendFileSync(ledgerFile, JSON.stringify({ at: now.toISOString(), agent: "operator", kind: "GOVERNANCE", target: `test-registry.json R309 amendment ${note.id}`,
    what: `R309 evidence start ${day} recorded as the registered dated note (24th consecutive fully evaluated hour ${first24}, closed ${completedAt}; set on the VPS ${cfg.evidenceStartSetAt || "?"} by ${cfg.evidenceStartBy || "?"}). From the pulled config; nothing else changed.` }) + "\n");
  return [...lines, "written: test-registry.json (R309 amendments + asOf), agent-ledger.jsonl (+1 row)"];
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (name, cond, d) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (d ? " — " + d : "")); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r309-evstart-"));
  try {
    const f = { outFile: path.join(tmp, "r309-surge-hold48.json"), regFile: path.join(tmp, "test-registry.json"), ledgerFile: path.join(tmp, "agent-ledger.jsonl") };
    fs.copyFileSync(path.join(REPO, "backend/data/test-registry.json"), f.regFile); fs.writeFileSync(f.ledgerFile, "");
    const put = (config, extra = {}) => fs.writeFileSync(f.outFile, JSON.stringify({ id: "R309", config, ...extra }));
    const T = (opt) => { try { return { lines: apply({ ...f, now: new Date("2026-10-09T15:00:00Z"), ...opt }) }; } catch (e) { return { err: e.message }; } };
    ok("no pulled file -> refused (nothing written)", /not at home/.test(T().err || ""));
    put({ evidenceStart: null }); ok("the pulled config has no evidenceStart -> refused", /no evidenceStart/.test(T().err || ""));
    const cfg = { evidenceStart: "2026-10-09", evidenceStartFirst24At: "2026-10-09T00:00:00Z", evidenceStartSetAt: "2026-10-09T01:02:40Z", evidenceStartBy: "runner (N16, automatic)", evidenceStartNotifiedAt: null };
    put({ ...cfg, evidenceStart: "2026-10-10" }); ok("a day that is not the UTC day the 24th hour closed -> refused", /is not the UTC day the 24th hour/.test(T().err || ""));
    put({ ...cfg, evidenceStartFirst24At: undefined }); ok("no 24th hour anywhere in the pulled file -> refused", /names no 24th consecutive hour/.test(T().err || ""));
    put(cfg);
    const reg0 = fs.readFileSync(f.regFile, "utf8"), d = T({ dry: true });
    ok("--dry prints the note and writes nothing", /DRY/.test((d.lines || []).join()) && fs.readFileSync(f.regFile, "utf8") === reg0 && fs.readFileSync(f.ledgerFile, "utf8") === "", d.err);
    const w = T();
    const r0 = JSON.parse(reg0), r1 = JSON.parse(fs.readFileSync(f.regFile, "utf8")), e0 = r0.preregistered.find((t) => t.id === "R309"), e1 = r1.preregistered.find((t) => t.id === "R309"), a = e1.amendments[e1.amendments.length - 1];
    ok("written: one amendment with the day, the 24th hour, its close, the VPS set time and writer; one agent-ledger row", !w.err && a.id === "R309-evidence-start-2026-10-09" && a.evidenceStart === "2026-10-09" && a.first24ConsecutiveAt === "2026-10-09T00:00:00Z" && a.completedAt === "2026-10-09T01:00:00Z" && a.evidenceStartSetAt === "2026-10-09T01:02:40Z" && /runner/.test(a.evidenceStartBy) && a.date === "2026-10-09" && e1.amendments.length === (e0.amendments || []).length + 1 && fs.readFileSync(f.ledgerFile, "utf8").trim().split("\n").length === 1, w.err);
    const strip = (r) => JSON.stringify({ ...r, asOf: null, preregistered: r.preregistered.map((t) => (t.id === "R309" ? { ...t, amendments: null } : t)) });
    ok("nothing else in the registry changed (only R309.amendments and asOf); R309's registered terms unchanged", strip(r0) === strip(r1) && termsSha(e0) === termsSha(e1));
    ok("a second run refuses (already noted)", /already noted/.test(T().err || ""));
    let health = null; try { health = require(path.join(HERE, "r309-health.cjs")).noteCheck(cfg, e1, Date.parse("2026-10-10T12:00:00Z")); } catch (x) { health = x.message; }
    ok("r309-health accepts the written note (no WARN / FAIL), 35 h after the start was set", health === null, JSON.stringify(health));
    put({ ...cfg, evidenceStart: "2026-10-11", evidenceStartFirst24At: "2026-10-11T03:00:00Z" });
    ok("a DIFFERENT pulled day while a note exists -> refused loudly (the start never changes)", /DIFFERENT evidence start \(2026-10-09\)/.test(T().err || ""));
    fs.copyFileSync(path.join(REPO, "backend/data/test-registry.json"), f.regFile);
    put({ evidenceStart: "2026-10-09", evidenceStartSetAt: "2026-10-09T01:02:40Z", evidenceStartBy: "operator (--set-evidence-start; the mechanical candidate, N16)" }, { gaps: { first24ConsecutiveAt: "2026-10-09T00:00:00Z" } });
    const g = T();
    ok("the fallback-set start (no evidenceStartFirst24At in config) takes the 24th hour from the status's gaps", !g.err && JSON.parse(fs.readFileSync(f.regFile, "utf8")).preregistered.find((t) => t.id === "R309").amendments.some((x) => x.id === "R309-evidence-start-2026-10-09" && /operator/.test(x.evidenceStartBy)), g.err);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`register-evidence-start selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  try {
    if (a.includes("--selftest")) process.exitCode = selftest() ? 0 : 1;
    else {
      const D = (n) => path.join(REPO, "backend", "data", n);
      for (const l of apply({ outFile: D("r309-surge-hold48.json"), regFile: D("test-registry.json"), ledgerFile: D("agent-ledger.jsonl"), dry: a.includes("--dry") })) console.log(l);
      process.exitCode = 0;
    }
  } catch (e) { console.error("register-evidence-start REFUSED (nothing written): " + e.message); process.exitCode = 1; }
}
module.exports = { apply };
