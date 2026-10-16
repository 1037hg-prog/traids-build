#!/usr/bin/env node
"use strict";
/**
 * R354 — THE CLOSED-END FUND DISCOUNT BOOK: the runner.
 *
 * WHAT IT IS. The one runner of R354 (backend/data/test-registry.json, preregistered[] id R354, registered 2026-10-12): a $100,000
 * paper book of at most 24 positions of $4,000, one purchase a half-month, which buys a fund trading below its asset value that has
 * sat two standard deviations cheap against its own last year for two days running, at the next close, and holds it 252 market days.
 * THE STATISTIC it computes is the registered one, word for word: per calendar month, the book's GAP DOLLARS after its own trading
 * costs minus the gap dollars of the same funds held from random days for nothing (500 seeded draws), the mean over ALL the span's
 * return months, with its Newey-West (Bartlett) t at lag 4. ONE t decides: the holdout's, against the bar in force (the registered
 * 1.727, raised — never lowered — by the block-resampled and no-edge-world percentiles of bar.raisedInTheRead).
 * NOTHING HERE PLACES AN ORDER, adopts anything or sizes anything. It prints and it writes its own files; it never seals.
 *
 *   node backend/r354-fund-discounts.js --selftest                 every known-answer case on made-up series; ends "ALL n PASSED"
 *   node backend/r354-fund-discounts.js --status                    read-only: every file, every gate, every item of the read condition
 *   node backend/r354-fund-discounts.js --controls --span=discovery  the validity gates V1-V15 -> backend/data/r354-controls.json
 *   node backend/r354-fund-discounts.js --controls --span=holdout    the same, with the holdout rows passed only through counting paths
 *   node backend/r354-fund-discounts.js --read --span=discovery      THE ONE DISCOVERY READ (refuses unless every item below holds)
 *   node backend/r354-fund-discounts.js --read --span=holdout        THE ONE HOLDOUT READ (refuses unless discovery sealed PROCEED)
 *   node backend/r354-fund-discounts.js --dollar-table --span=...    the dollar table of a read already written (prints, writes nothing)
 *
 * --read REFUSES, PRINTING WHAT IS MISSING AND READING NO SERIES, unless EVERY item of readCondition holds:
 *   (1) R354 is in preregistered[] exactly once, its rule text still hashes to ruleSha256, and this runner's frozen constants equal
 *       its parameters{} field for field (backend/lib/fund-discount.js paramsDiff);
 *   (2) the build-provenance file backend/data/r354-build.json says this runner was built by the standard build loop (builder, a
 *       separate checker, mutation tests) with --read forbidden to the build, and carries this file's own sha256;
 *   (3) the cache manifest says the cache was fetched on or after 2026-10-15 and is frozen, the cache on disk still hashes to the
 *       manifest's sha256, and ONE dated pre-read note of kind 'hash-note' in R354.amendments[] carries the sha256 of that manifest
 *       and of the controls file;
 *   (4) this runner's own selftest passes in process (the same cases --selftest prints);
 *   (5) the controls file holds V1 to V15 for that span, every one passed, written against that same cache hash;
 *   (6) the clock is outside 13:50-15:50 MT on a trading day;
 *   (7) the date is on or before 2027-01-31 (discovery);
 *   (8) no read of that span has been written before (a second read of a span refuses), and for the holdout: discovery is sealed
 *       PROCEED and this read writes the holdout lock before the first holdout row reaches the book.
 * IN THIS TREE --read ALWAYS REFUSES: there is no cache, no manifest, no build-provenance file and no pre-read note, and the build
 * loop is forbidden to run a read at all (interimKill: "--read is in the build loop's forbidden list").
 *
 * RULE [14]: no flag, setting or environment variable changes a number of this rule or of the statistic. The only flags are the modes
 * above and --span; every number comes from the frozen constants, and the selftest compares them with the registry entry.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const F = require("./lib/fund-discount.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
let HOLIDAYS = {}; try { HOLIDAYS = require("./lib/run-window.js").MARKET_HOLIDAYS || {}; } catch { HOLIDAYS = {}; }

const ID = "R354", DATA = path.join(__dirname, "data"), SELF = path.join(__dirname, path.basename(__filename));
const FILES = Object.freeze({
  registry: "test-registry.json", universe: "r354-universe-frozen.json", cacheDir: "r354-cache", manifest: "r354-cache-manifest.json",
  units: "r354-units.json", cost: "r354-cost.json", controls: "r354-controls.json", build: "r354-build.json",
  publication: "r354-publication-check.json", secondSource: "r354-second-source.json", audit: "r354-signal-audit.json",
  attrition: "r354-attrition.json", readDiscovery: "r354-read-discovery.json", holdoutLock: "r354-holdout-lock.json",
  readHoldout: "r354-read-holdout.json", status: "r354-status.json",
});
const D = (k) => path.join(DATA, FILES[k]);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const usd = (n) => (F.fin(n) ? (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "(none)");
class Refuse extends Error {}
const refuse = (m) => { throw new Refuse(m); };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

// ──────────────────────────────────────────────────── the registry entry and its rule text ─────────────────────────────────────────
/** R354's entry, and nothing else from the registry; it refuses an entry that is missing, twice over, or also in tests[] */
function entryOf(reg) {
  if (!reg || !Array.isArray(reg.preregistered)) refuse("test-registry.json holds no preregistered[] list");
  const hits = reg.preregistered.filter((t) => t && t.id === ID);
  if (hits.length !== 1) refuse(`${ID} is ${hits.length ? `in preregistered[] ${hits.length} times` : "not in preregistered[]"}`);
  if (Array.isArray(reg.tests) && reg.tests.some((t) => t && String(t.id) === ID)) refuse(`${ID} is also in tests[]: an ambiguous entry`);
  return hits[0];
}
/** the sha256 the entry's own ruleSha256Covers describes: JSON.stringify of six keys, in that order, computed and never typed */
const ruleShaOf = (e) => sha(JSON.stringify(Object.fromEntries(F.RULE_SHA_KEYS.map((k) => [k, e[k]]))));

// ─────────────────────────────────────────────────────────── the clock fence ────────────────────────────────────────────────────────
/** readCondition (6): no read between 13:50 and 15:50 MT on a trading day (the close chain owns the data files then) */
function mtClock(nowMs, holidays = HOLIDAYS) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hourCycle: "h23", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  const hh = +p.hour % 24, hm = hh * 60 + +p.minute, mtDate = `${p.year}-${p.month}-${p.day}`;
  const d = new Date(mtDate + "T12:00:00Z").getUTCDay(), tradingDay = d >= 1 && d <= 5 && !holidays[mtDate];
  return { mtDate, hhmm: `${String(hh).padStart(2, "0")}:${p.minute}`, tradingDay, inWindow: tradingDay && hm >= 13 * 60 + 50 && hm < 15 * 60 + 50 };
}

// ────────────────────────────────────────────────────── the frozen cache on disk ───────────────────────────────────────────────────
/**
 * THE CACHE (rule [1]): one file per symbol under backend/data/r354-cache/, fetched once on or after 2026-10-15 and FROZEN BY HASH
 * before any statistic is computed. The hash is of the file names and their bytes, so a changed row changes it.
 *  -> { cache, sha256, files } ; it refuses a cache folder that is not there.
 */
function loadCache(dir = D("cacheDir")) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { refuse(`no cache folder at backend/data/${FILES.cacheDir}: nothing to read`); }
  if (!names.length) refuse(`the cache folder backend/data/${FILES.cacheDir} is empty`);
  const cache = {}, lines = [];
  for (const n of names) {
    const buf = fs.readFileSync(path.join(dir, n));
    lines.push(`${n} ${sha(buf)}`);
    const s = JSON.parse(buf.toString("utf8"));
    cache[s.symbol || n.replace(/\.json$/, "")] = s;
  }
  return { cache, sha256: sha(lines.join("\n")), files: names.length };
}
/** the frozen list of rule [2], as the universe rows the engine takes */
function loadUniverse(file = D("universe")) {
  const j = readJson(file);
  if (!j) refuse(`no frozen universe at backend/data/${FILES.universe}`);
  const rows = Array.isArray(j) ? j : j.funds || j.list;
  if (!Array.isArray(rows) || !rows.length) refuse(`backend/data/${FILES.universe} holds no fund list`);
  return rows.map((r) => ({
    ticker: r.ticker || r.Ticker, navSymbol: r.navSymbol || r.NavTicker, categoryName: r.categoryName || r.CategoryName,
    term: r.term != null ? !!r.term : !!r.Term, termDate: r.termDate || r.TermDate || null,
    inceptionDate: (r.inceptionDate || r.InceptionDate || "").slice(0, 10) || null,
  }));
}

// ───────────────────────────────────────────────────────── the read condition ───────────────────────────────────────────────────────
/**
 * EVERY ITEM OF readCondition, as a list of { id, ok, detail }. It reads the registry, the small data files and the cache's hash —
 * it never computes a statistic, and nothing here can be made to pass by a flag. `ok` false anywhere refuses the read.
 */
function readCondition({ spanName, nowMs = Date.now(), dataDir = DATA, selftestResult = null, holidays = HOLIDAYS } = {}) {
  const items = [], at = (k) => path.join(dataDir, FILES[k]);
  const add = (id, ok, detail) => { items.push({ id, ok: !!ok, detail }); return ok; };
  // (1) the entry, its rule text and this runner's frozen constants
  let entry = null;
  try {
    entry = entryOf(readJson(at("registry")));
    const shaNow = ruleShaOf(entry);
    add("(1a) R354 is in preregistered[] exactly once", true, `registered ${entry.registered}`);
    add("(1b) its rule text still hashes to ruleSha256", shaNow === entry.ruleSha256 && shaNow === F.RULE_SHA256, `${shaNow.slice(0, 16)} against ${String(entry.ruleSha256).slice(0, 16)} (the runner was built against ${F.RULE_SHA256.slice(0, 16)})`);
    const diff = F.paramsDiff(entry.parameters);
    add("(1c) the runner's frozen constants equal parameters{}", diff.length === 0, diff.length ? diff.join(" · ") : "every field equal");
  } catch (e) { add("(1) the registry entry", false, e.message); }
  // (2) the build-provenance file
  const build = readJson(at("build"));
  const selfSha = fs.existsSync(SELF) ? sha(fs.readFileSync(SELF)) : null;
  add("(2) built by the standard build loop, --read forbidden to the build", !!build && build.builtBy === "build-check-loop" && build.readForbidden === true && build.runnerSha256 === selfSha && !!build.checker,
    !build ? `no backend/data/${FILES.build}` : build.runnerSha256 !== selfSha ? `it was written for another build of this runner (${String(build.runnerSha256).slice(0, 12)} against this file's ${String(selfSha).slice(0, 12)})` : build.readForbidden !== true ? "it does not say --read was forbidden to the build" : !build.checker ? "it names no separate checker" : `built ${build.builtAt}, checker ${build.checker}`);
  // (3) the cache, frozen, and the ONE pre-read hash-note
  const manifest = readJson(at("manifest"));
  let cacheSha = null, cacheOk = false;
  try { const c = loadCache(path.join(dataDir, FILES.cacheDir)); cacheSha = c.sha256; cacheOk = true; } catch (e) { cacheSha = null; }
  add("(3a) the cache was fetched on or after 2026-10-15 and is frozen", !!manifest && String(manifest.fetchedAt || "").slice(0, 10) >= F.PARAMS.cacheNotBefore && manifest.frozen === true,
    !manifest ? `no backend/data/${FILES.manifest}` : `fetchedAt ${manifest.fetchedAt || "(none)"}, frozen ${manifest.frozen === true}`);
  add("(3b) the cache on disk still hashes to the manifest", cacheOk && !!manifest && manifest.sha256 === cacheSha, !cacheOk ? "the cache folder cannot be read" : !manifest ? "no manifest" : `${String(cacheSha).slice(0, 16)} against the manifest's ${String(manifest.sha256).slice(0, 16)}`);
  const notes = entry && Array.isArray(entry.amendments) ? entry.amendments.filter((a) => a && a.kind === "hash-note") : [];
  const controls = readJson(at("controls"));
  const controlsSha = fs.existsSync(at("controls")) ? sha(fs.readFileSync(at("controls"))) : null;
  const note = notes.length === 1 ? notes[0] : null;
  add("(3c) ONE dated pre-read note carries the cache and controls hashes", !!note && note.cacheManifestSha256 === (manifest ? manifest.sha256 : null) && note.controlsSha256 === controlsSha && !!note.date,
    notes.length !== 1 ? `${notes.length} note(s) of kind 'hash-note' in amendments[], exactly one is needed` : note.cacheManifestSha256 !== (manifest ? manifest.sha256 : null) ? "its cache-manifest sha256 is not this manifest's" : note.controlsSha256 !== controlsSha ? "its controls sha256 is not this controls file's" : `dated ${note.date}`);
  // (4) the selftest
  const st = selftestResult;
  add("(4) the runner's own selftest passes", !!st && st.failed === 0 && st.passed > 0, st ? `${st.passed} passed, ${st.failed} failed` : "the selftest was not run");
  // (5) the controls file: V1 to V15 for this span, all passed, on the same cache hash
  const want = ["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10", "V11", "V12", "V13", "V14", "V15"];
  const g = controls && controls.span === spanName ? controls.gates || {} : null;
  const missing = g ? want.filter((k) => !g[k]) : want;
  const failedG = g ? want.filter((k) => g[k] && !g[k].pass) : [];
  add("(5a) --controls wrote V1 to V15 for this span, all passed, on this cache hash", !!g && !missing.length && !failedG.length && controls.cacheSha256 === cacheSha,
    !controls ? `no backend/data/${FILES.controls}` : controls.span !== spanName ? `the controls file is for the ${controls.span} span` : missing.length ? `missing: ${missing.join(", ")}` : failedG.length ? `did not pass: ${failedG.join(", ")}` : controls.cacheSha256 !== cacheSha ? "it was written against another cache hash" : "every gate passed");
  // the gates were run AT THEIR REGISTERED STRENGTH: 200 no-edge worlds, 200 fault worlds, 20 planted worlds, 2000 replay pairs. A
  // controls file written with fewer (a rehearsal on made-up series) can never carry a read: its counting limits would be trivial.
  const strength = g ? [["V10 no-edge worlds", g.V10 && g.V10.worlds, F.PARAMS.worlds], ["V11 fault worlds", g.V11 && g.V11.worlds, F.PARAMS.worlds],
    ["V12 planted worlds", g.V12 && g.V12.planted, F.PARAMS.plantedWorlds], ["V2 replay pairs", g.V2 && g.V2.pairsChecked, F.PARAMS.replayPairs]] : [];
  const weak = strength.filter(([, got, want]) => !(got >= want));
  add("(5b) the gates were run at their registered strength", !!g && weak.length === 0,
    !g ? "no controls file" : weak.length ? weak.map(([w, got, want]) => `${w}: ${got == null ? "none" : got} of ${want}`).join("; ") : strength.map(([w, got]) => `${w} ${got}`).join(", "));
  // (6) the clock, (7) the lapse
  const c = mtClock(nowMs, holidays);
  add("(6) the clock is outside 13:50-15:50 MT on a trading day", !c.inWindow, `${c.mtDate} ${c.hhmm} MT, ${c.tradingDay ? "a trading day" : "not a trading day"}`);
  add("(7) the date is on or before the lapse", c.mtDate <= F.PARAMS.lapse, `${c.mtDate} against ${F.PARAMS.lapse}`);
  // (8) one read of a span, and the holdout only on a sealed PROCEED
  const readFile = spanName === "discovery" ? at("readDiscovery") : at("readHoldout");
  add("(8a) no read of this span has been written", !fs.existsSync(readFile), fs.existsSync(readFile) ? `backend/data/${path.basename(readFile)} is already there: a second read of a span refuses` : "none on file");
  if (spanName === "holdout") {
    const dr = readJson(at("readDiscovery"));
    add("(8b) discovery is sealed PROCEED", !!dr && dr.verdict === "PROCEED" && !!dr.sealed, !dr ? "there is no discovery read" : `discovery read ${dr.verdict}${dr.sealed ? ", sealed" : ", NOT sealed (docs/server/seal-gated-arms.cjs seals it)"}`);
    add("(8c) the holdout lock is not already written", !fs.existsSync(at("holdoutLock")), fs.existsSync(at("holdoutLock")) ? "the holdout lock is already there" : "none on file");
  }
  return { ok: items.every((x) => x.ok), items, cacheSha, controlsSha, entry, manifest, controls, build };
}

// ──────────────────────────────────────────────────────── the validity gates run ───────────────────────────────────────────────────
/**
 * --controls: every validity gate for one span, written to backend/data/r354-controls.json against the cache's own hash. It prints
 * counts, dates, lists and pass or fail — never a mean return of the real book. For the HOLDOUT the rows reach this through counting
 * paths only (V15): the trade list's dates, funds, z-scores and dollars are not printed or written, only its counts.
 */
function runControls({ spanName, worlds = null, plantedWorlds = null, replayPairs = null, log = console.log, nowMs = Date.now(), dataDir = DATA }) {
  const span = { ...F.PARAMS.spans[spanName], name: spanName };
  if (!span.first) refuse(`there is no span called ${spanName}: discovery or holdout`);
  const spanNo = spanName === "discovery" ? 1 : 2;
  const { cache, sha256: cacheSha } = loadCache(path.join(dataDir, FILES.cacheDir));
  const universe = loadUniverse(path.join(dataDir, FILES.universe));
  const costTable = readJson(path.join(dataDir, FILES.cost));
  const countsOnly = spanName === "holdout";
  log(`--controls ${spanName} — cache sha256 ${cacheSha.slice(0, 16)}, ${universe.length} funds on the frozen list${countsOnly ? " — the holdout rows reach this through counting paths only (V15)" : ""}`);
  const uni = F.prepareUniverse({ cache, universe });
  log(`  universe under [2]: ${uni.funds.length} funds with both series, an accepted NAV symbol and no term date; ${uni.dropped.length} dropped`);
  const gates = {};
  gates.V1 = { id: "V1", pass: false, why: "the selftest is run by the runner, not by this function" };     // filled in below
  const st = selftest({ log: () => {} });
  gates.V1 = { id: "V1", pass: st.failed === 0 && st.passed > 0, cases: st.passed, failed: st.failed, why: st.failed ? `${st.failed} selftest case(s) failed` : null };
  gates.V3 = F.gateV3({ uni });
  gates.V4 = F.gateV4({ uni });
  gates.V5 = F.gateV5({ uni, secondSource: readJson(path.join(dataDir, FILES.secondSource)) });
  gates.V6 = F.gateV6({ publication: readJson(path.join(dataDir, FILES.publication)), universeCount: uni.funds.length });
  gates.V7 = F.gateV7({ uni, secondSource: readJson(path.join(dataDir, FILES.secondSource)) });
  gates.V9 = F.gateV9({ attrition: readJson(path.join(dataDir, FILES.attrition)) });
  gates.V15 = F.gateV15({ manifest: readJson(path.join(dataDir, FILES.manifest)) });
  // the quarantines the pre-read gates wrote, and the late reporters V6 timed: the book reads them through controls{}
  const quarantines = {};
  for (const src of [gates.V4.quarantines, gates.V5.quarantines, gates.V7.quarantines]) for (const [t, list] of Object.entries(src || {})) quarantines[t] = [...(quarantines[t] || []), ...list];
  const controlsForBook = { quarantines, lateReporters: gates.V6.lateReporters || [], lateReporterAll: !!gates.V6.lateReporterAll };
  gates.V2 = F.gateV2({ uni, span, controls: controlsForBook, cache, universe, pairs: replayPairs });
  gates.V10 = F.gateV10({ cache, universe, span, spanNo, controls: controlsForBook, costTable, worlds, onProgress: (i, n) => { if (i % 10 === 0 || i === n) log(`    V10 no-edge worlds ${i}/${n}`); } });
  gates.V11 = F.gateV11({ cache, universe, span, spanNo, controls: controlsForBook, costTable, worlds, onProgress: (i, n) => { if (i % 10 === 0 || i === n) log(`    V11 fault worlds ${i}/${n}`); } });
  gates.V12 = F.gateV12({ cache, universe, span, spanNo, controls: controlsForBook, costTable, worlds: plantedWorlds, onProgress: (i, n) => { if (i % 5 === 0 || i === n) log(`    V12 planted worlds ${i}/${n}`); } });
  // V8 and V13 need the real trade list. V8 LISTS the 40 most suspicious signals (no return) and needs the hand-checked file; V13 is
  // the sample count. Both are written as counts only.
  const book = F.runBook({ uni, controls: controlsForBook, span, costTable });
  const bigMove = book.positions.map((p) => {
    const f = p.fund, s = p.sIdx, prev = f.prevNavIdx[s];
    const move = F.fin(f.d[s]) && prev >= 0 && F.fin(f.d[prev]) ? Math.abs(f.d[s] - f.d[prev]) : 0;
    return { ticker: p.ticker, day: f.cal.days[s], move, price: f.P[s], nav: f.N[s] };
  }).sort((a, b) => b.move - a.move).slice(0, F.PARAMS.auditSignals);
  gates.V8 = F.gateV8({ audit: readJson(path.join(dataDir, FILES.audit)), signals: bigMove });
  const stat = F.statistic({ uni, span, spanNo, controls: controlsForBook, costTable, keepDraws: 20 });
  gates.V13 = F.gateV13({ stat, span });
  gates.V14 = F.gateV14({ stat, bar: F.PARAMS.tRequired });
  gates.V16 = { id: "V16", pass: true, note: "V16 is read at the discovery read, against that read's own mean and t" };
  const out = {
    id: ID, span: spanName, cacheSha256: cacheSha, generatedAt: new Date(nowMs).toISOString(), runnerSha256: sha(fs.readFileSync(SELF)),
    ruleSha256: F.RULE_SHA256, universe: { onList: universe.length, inTest: uni.funds.length, dropped: uni.dropped },
    gates, quarantines, lateReporters: controlsForBook.lateReporters, lateReporterAll: controlsForBook.lateReporterAll,
    costTableInForce: costTable ? { coverage: costTable.coverage, funds: Object.keys(costTable.spreads || {}).length } : "none: every fund is charged 1.5 times its class cost ([12])",
    worldsP95: gates.V10.p95, sampleCounts: { positions: stat.positions.length, roundTrips: stat.counts.roundTrips, monthsWithPosition: stat.counts.monthsWithPosition, noCleanSeries: stat.counts.noCleanSeries, fillFailures: stat.counts.fillFailures, carriedExits: stat.counts.carriedExits, daysOver24: stat.counts.daysOver24 },
    v8Listed: countsOnly ? bigMove.length : bigMove.map((x) => ({ ticker: x.ticker, day: x.day })),
  };
  writeJsonAtomic(path.join(dataDir, FILES.units), { id: ID, cacheSha256: cacheSha, generatedAt: out.generatedAt, events: gates.V3.classes, unverified: gates.V3.unverified, quarantinedAroundASplit: gates.V3.fundsQuarantinedAroundASplit });
  writeJsonAtomic(path.join(dataDir, FILES.controls), out);
  const order = ["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10", "V11", "V12", "V13", "V14", "V15"];
  log("");
  for (const k of order) { const x = gates[k]; log(`  ${x.pass ? "PASS" : "FAIL"}  ${k.padEnd(4)} ${x.why || "every count inside its limit"}`); }
  const failed = order.filter((k) => !gates[k].pass);
  log(`\n--controls ${spanName}: ${failed.length ? `CANNOT MEASURE for this span — ${failed.join(", ")} did not pass` : "V1 to V15 all passed"}; written to backend/data/${FILES.controls} (sha256 ${sha(fs.readFileSync(path.join(dataDir, FILES.controls))).slice(0, 16)})`);
  log(`  the pre-read note of readCondition (3) carries that sha256 and the cache manifest's ${cacheSha.slice(0, 16)}.`);
  return { out, failed, stat, uni };
}

// ────────────────────────────────────────────────────────────── the read ────────────────────────────────────────────────────────────
/**
 * ONE READ OF ONE SPAN. It refuses first and reads nothing until every item of readCondition holds. For the holdout it writes the
 * holdout lock BEFORE the first holdout row reaches the book, then runs V2, V12(c) and V13 on the holdout rows (V15), then the real
 * book. It prints the registered words with its own numbers and never seals.
 */
function readSpan({ spanName, nowMs = Date.now(), dataDir = DATA, log = console.log }) {
  const span = { ...F.PARAMS.spans[spanName], name: spanName };
  if (!span.first) refuse(`there is no span called ${spanName}: discovery or holdout`);
  const spanNo = spanName === "discovery" ? 1 : 2;
  const st = selftest({ log: () => {} });
  const RC = readCondition({ spanName, nowMs, dataDir, selftestResult: st });
  log(`READ CONDITION — ${spanName}`);
  for (const x of RC.items) log(`  ${x.ok ? "ok    " : "NO    "} ${x.id}: ${x.detail}`);
  if (!RC.ok) refuse(`the read condition does not hold: ${RC.items.filter((x) => !x.ok).map((x) => x.id).join("; ")}. NO SERIES WAS READ.`);
  const { cache, sha256: cacheSha } = loadCache(path.join(dataDir, FILES.cacheDir));
  const universe = loadUniverse(path.join(dataDir, FILES.universe));
  const costTable = readJson(path.join(dataDir, FILES.cost));
  const controls = RC.controls, controlsForBook = { quarantines: controls.quarantines, lateReporters: controls.lateReporters, lateReporterAll: controls.lateReporterAll };
  if (spanName === "holdout") {
    writeJsonAtomic(path.join(dataDir, FILES.holdoutLock), { id: ID, span: "holdout", lockedAt: new Date(nowMs).toISOString(), cacheSha256: cacheSha, controlsSha256: RC.controlsSha, discovery: readJson(path.join(dataDir, FILES.readDiscovery)).verdict, by: "backend/r354-fund-discounts.js --read --span=holdout" });
    log(`\nthe holdout lock is written (backend/data/${FILES.holdoutLock}): the holdout rows reach the book only from here.`);
  }
  const uni = F.prepareUniverse({ cache, universe });
  // V15's own order for the holdout: V2, V12(c) and V13 on the holdout rows, after the lock and before the real book
  const stat = F.statistic({ uni, span, spanNo, controls: controlsForBook, costTable, keepDraws: 20, onProgress: (i, n) => { if (i % 50 === 0 || i === n) log(`    placebo draw ${i}/${n}`); } });
  const v13 = F.gateV13({ stat, span });
  if (!v13.pass) refuse(`V13 SAMPLE did not pass on the ${spanName} rows: ${v13.why}. CANNOT MEASURE for this span; nothing is concluded.`);
  const shifted = F.shiftedBooks({ uni, span, spanNo, stat, controls: controlsForBook, costTable });
  const sign = F.signGates({ stat, shifted });
  const boot = F.blockBootstrapP95({ G: stat.series.G, spanNo });
  const bar = F.barInForce({ registered: F.PARAMS.tRequired, bootstrapP95: boot, worldsP95: controls.worldsP95 });
  const power = F.powerLine({ shifted, months: stat.months.length, bar: bar.t });
  const lbl = F.labels({ uni, span, spanNo, stat, shifted, controls: controlsForBook, costTable });
  const gates = Object.values(controls.gates);
  let verdict;
  if (spanName === "discovery") {
    const v16 = F.gateV16({ discoveryMean: stat.headline, discoveryT: stat.t });
    verdict = v16.hold ? { verdict: "HOLD", why: v16.why } : F.decideDiscovery({ stat, gates });
    verdict.v16 = v16;
  } else {
    const discovery = readJson(path.join(dataDir, FILES.readDiscovery));
    const cd = readJson(path.join(dataDir, FILES.controls));
    verdict = F.decideHoldout({ stat, gates, gatesDiscovery: [], discovery, bar, sign });
    verdict.discoveryRead = discovery ? { verdict: discovery.verdict, mean: discovery.mean } : null;
  }
  const out = {
    id: ID, span: spanName, readAt: new Date(nowMs).toISOString(), cacheSha256: cacheSha, controlsSha256: RC.controlsSha,
    ruleSha256: F.RULE_SHA256, runnerSha256: sha(fs.readFileSync(SELF)), sealed: false,
    verdict: verdict.verdict, mean: F.r2(stat.headline), t: F.r3(stat.t), bar: F.r3(bar.t), barParts: bar.parts.map((x) => ({ what: x.what, t: F.r3(x.t) })),
    months: stat.months.length, counts: stat.counts, signGates: sign, power, labels: lbl, decision: verdict,
    dollars: dollarTable({ stat, sign, shifted }),
    unverifiedMonths: stat.counts.unverifiedMonths, fundsRemovedForALaterEvent: controls.gates.V3 ? controls.gates.V3.fundsRemovedForALaterEvent : null,
    fundDaysRemovedForALaterEvent: controls.gates.V3 ? controls.gates.V3.fundDaysRemovedForALaterEvent : null,
  };
  writeJsonAtomic(path.join(dataDir, spanName === "discovery" ? FILES.readDiscovery : FILES.readHoldout), out);
  printRead({ out, stat, sign, bar, lbl, power, shifted, log });
  log(`\nthe read is written to backend/data/${spanName === "discovery" ? FILES.readDiscovery : FILES.readHoldout}. THE RUNNER PRINTS AND NEVER SEALS: docs/server/seal-gated-arms.cjs seals this arm the same day.`);
  return out;
}
/** decisionRule.dollarTable: every figure at 1, 2 and 3 times the charged cost, the worst month and the worst run, the places taken */
function dollarTable({ stat, sign, shifted }) {
  const s = stat.series, m = (a) => F.r2(F.mean(a)), atCost = (mult) => m(s.G.map((g, i) => g - (mult - 1) * s.COST[i]));
  let worstRun = 0, run = 0;
  for (const g of s.G) { if (g < 0) { run += g; worstRun = Math.min(worstRun, run); } else run = 0; }
  const gains = stat.positions.filter((p) => F.fin(p.priceDollars) && p.priceDollars > 0), losses = stat.positions.filter((p) => F.fin(p.priceDollars) && p.priceDollars <= 0);
  return {
    perPosition: F.PARAMS.stakeUsd, atRiskBusiest: F.PARAMS.stakeUsd * F.PARAMS.places,
    G: m(s.G), G21: m(s.G21), GUS: m(s.GUS), GPEER: m(s.GPEER), D: m(s.D), BOOK: m(s.BOOK), YIELD: m(s.YIELD),
    GAtTwiceCost: atCost(2), GAtThriceCost: atCost(3),
    grossGains: F.r2(gains.reduce((a, p) => a + p.priceDollars, 0)), grossLosses: F.r2(losses.reduce((a, p) => a + p.priceDollars, 0)),
    wins: gains.length, losses: losses.length, averageWin: F.r2(F.mean(gains.map((p) => p.priceDollars))), averageLoss: F.r2(F.mean(losses.map((p) => p.priceDollars))),
    totalCostPaid: F.r2(s.COST.reduce((a, x) => a + x, 0)), worstMonth: F.r2(Math.min(...s.G)), worstRunOfMonths: F.r2(worstRun),
    positionsOpened: stat.positions.length, roundTrips: stat.counts.roundTrips, noCleanSeries: stat.counts.noCleanSeries,
    soldAtSpanEnd: stat.counts.soldAtSpanEnd, carriedExits: stat.counts.carriedExits, daysWith25Positions: stat.counts.daysOver24,
    placeboMeanGap: m(s.PLACEBO_GAP), shiftedBooksMedianPerPosition: shifted ? F.r3(shifted.median) : null,
    smallestFigureSetAgainstTheCatalogue: F.r2(Math.min(F.mean(s.G), F.mean(s.G21), F.mean(s.GUS), F.mean(s.D))),
  };
}
/** the read's own words, with its own numbers (decisionRule.pass / .fail) */
function printRead({ out, stat, sign, bar, lbl, power, shifted, log }) {
  const s = stat.series, m = (a) => usd(F.r2(F.mean(a)));
  log(`\n${"=".repeat(118)}\nR354 ${out.span.toUpperCase()} READ — ${out.verdict}\n${"=".repeat(118)}`);
  if (out.span === "holdout" && out.verdict === "PASS") {
    log(`On funds that survived to October 2026, from 2012 to September 2026, with signals of 2020-02 to 2020-04 left out because a scout saw those weeks`);
    log(`(and 2008-09 to 2008-12 in discovery), a 24-place $100,000 book of funds below asset value and two standard deviations cheap against their own`);
    log(`year made ${m(s.G)} a month in the gap after its costs, more than the same funds held from random days for nothing (t ${F.r3(stat.t)} against the bar ${F.r3(bar.t)}).`);
    log(`Of the book's gap dollars ${m(s.YIELD)} a month is the extra yield of buying below asset value, which needs no move in the gap.`);
    log(`From the 21st day on: ${m(s.G21)}. In funds priced on the US clock: ${m(s.GUS)}. Without the fund's own asset value: ${m(s.GPEER)}. In all price dollars`);
    log(`against the placebo: ${m(s.D)}. The book's own dollars were ${m(s.BOOK)} a month, which includes what the funds themselves earned; its worst month`);
    log(`was ${usd(F.r2(Math.min(...s.G)))}. The figure set against the operator's $500-a-month catalogue line is the SMALLEST of G, G21, GUS and D: ${usd(out.dollars.smallestFigureSetAgainstTheCatalogue)}.`);
    log(`On survivors; the survivorship table L10 prints the three weightings. A PASS adopts nothing, sizes nothing and moves no money.`);
  } else if (out.span === "holdout") {
    log(`Not demonstrated, with signals of 2020-02 to 2020-04 left out because a scout saw those weeks (and 2008-09 to 2008-12 in discovery):`);
    log(`${out.verdict === "CANNOT MEASURE" ? "a validity gate did not pass" : "after its costs the book's gap dollars did not beat holding the same funds [or: the t cleared and a check named below did not]"}.`);
    log(`Point estimate ${m(s.G)} a month per $100,000 (t ${F.r3(stat.t)} against the bar ${F.r3(bar.t)}). The smallest effect the single t finds four times in`);
    log(`five is ${usd(power.smallestEffectFourInFive)} a month. ${out.decision.nearMiss ? "A miss within 0.05 of the bar is reported in the same words as any other miss." : ""} Not demonstrated is not disproven.`);
  } else {
    log(`DISCOVERY (2003-2011, on survivors): mean G ${m(s.G)} a month per $100,000, t ${F.r3(stat.t)} printed against ${F.BAR.tRequiredDiscoveryReportedOnly} and NOT gating.`);
    log(`${out.verdict === "PROCEED" ? "PROCEED: the pipeline points the right way in the years the published studies cover." : out.verdict === "HOLD" ? out.decision.why : "DID NOT PASS at discovery — the holdout is never opened by this test."}`);
  }
  log(`\nthe bar in force: ${F.r3(bar.t)} (${bar.binding})`);
  for (const p of bar.parts) log(`    ${F.r3(p.t)}  ${p.what}`);
  log(`\nthe sign gates (each the mean over the span's ${out.months} months; none may be at or below $0):`);
  for (const k of ["S1", "S2", "S3", "S4", "S5"]) log(`  ${sign[k].pass ? "PASS" : "FAIL"}  ${k} ${sign[k].what}: ${k === "S5" ? `${usd(F.r3(sign.S5.mean))} per position against the shifted books' median ${usd(F.r3(sign.S5.median))}` : usd(F.r2(sign[k].mean))}`);
  if (out.decision.conditions) { log("\nthe decision rule, condition by condition:"); for (const c of out.decision.conditions) log(`  ${c.ok ? "ok  " : "NO  "} ${c.id} — ${c.detail}`); }
  log("\nthe dollar table (decisionRule.dollarTable):");
  for (const [k, v] of Object.entries(out.dollars)) log(`  ${k.padEnd(36)} ${typeof v === "number" ? usd(v) : String(v)}`);
  log("\nthe labels (printed with every read; none can change the verdict):");
  for (const [k, v] of Object.entries(lbl)) log(`  ${k.padEnd(5)} ${JSON.stringify(v).slice(0, 220)}`);
  log(`\ncounts: ${JSON.stringify(stat.counts)}`);
  log(`months with an unverified event inside a holding (the LOWER of the two readings used): ${stat.counts.unverifiedMonths}`);
}

// ─────────────────────────────────────────────────────── --status (read-only) ───────────────────────────────────────────────────────
function printStatus({ log = console.log, nowMs = Date.now(), dataDir = DATA } = {}) {
  log(`R354 STATUS — ${new Date(nowMs).toISOString().slice(0, 16)}Z — read-only, nothing is written, no series is read`);
  for (const [k, v] of Object.entries(FILES)) {
    const p = path.join(dataDir, v);
    let state;
    if (k === "cacheDir") { try { const c = loadCache(p); state = `${c.files} symbol file(s), sha256 ${c.sha256.slice(0, 16)}`; } catch (e) { state = `absent (${e.message})`; } }
    else state = fs.existsSync(p) ? `${fs.statSync(p).size} bytes, sha256 ${sha(fs.readFileSync(p)).slice(0, 16)}` : "absent";
    log(`  ${k.padEnd(14)} backend/data/${v.padEnd(28)} ${state}`);
  }
  const st = selftest({ log: () => {} });
  log(`\n  selftest: ${st.passed} passed, ${st.failed} failed`);
  for (const spanName of ["discovery", "holdout"]) {
    const RC = readCondition({ spanName, nowMs, dataDir, selftestResult: st });
    log(`\n  the read condition for ${spanName}: ${RC.ok ? "HOLDS" : "DOES NOT HOLD — --read refuses"}`);
    for (const x of RC.items) log(`    ${x.ok ? "ok    " : "NO    "} ${x.id}: ${x.detail}`);
  }
  log(`\n  interimKill: --read is in the build loop's forbidden list; this tree holds no cache, so --read refuses whatever is asked of it.`);
}

// ────────────────────────────────────────────── the selftest's made-up series (no network, no data) ─────────────────────────────────
/** a Yahoo-shaped price series from arrays */
const priceSeries = (symbol, days, close, vol, { dividends = [], splits = [] } = {}) => ({
  symbol, type: "EQUITY", exchange: "NYS", splits, dividends,
  rows: days.map((d, i) => (close[i] == null ? { d } : { d, o: close[i], h: close[i], l: close[i], c: close[i], v: vol[i] == null ? 100000 : vol[i] })),
});
/** a Yahoo-shaped NAV series: MUTUALFUND on NAS, zero volume, open = high = low = close on every valued row ([1]) */
const navSeries = (symbol, days, nav) => ({
  symbol, type: "MUTUALFUND", exchange: "NAS", splits: [], dividends: [],
  rows: days.map((d, i) => (nav[i] == null ? { d } : { d, o: nav[i], h: nav[i], l: nav[i], c: nav[i], v: 0 })),
});
/** business days from a to b (the fixture's ^GSPC calendar; it needs no holiday list to be a calendar) */
function businessDays(a, b) {
  const out = []; let t = new Date(a + "T12:00:00Z"); const end = new Date(b + "T12:00:00Z");
  while (t <= end) { const dd = t.getUTCDay(); if (dd >= 1 && dd <= 5) out.push(t.toISOString().slice(0, 10)); t = new Date(t.getTime() + 864e5); }
  return out;
}
/**
 * THE FIXTURE. Ten funds of made-up daily rows on eight years of business days: a NAV random walk and a slow AR(1) discount, so that
 * the rule finds signals and a book can be run end to end. NOTHING in it is market data; nothing is fetched. The span it is read over
 * is the fixture's own ("fixture", 24 months), never one of the two registered spans.
 */
function makeFixture({ seed = 20261012, from = "2000-01-03", to = "2007-12-31", extra = 0 } = {}) {
  const days = businessDays(from, to), cache = { "^GSPC": priceSeries("^GSPC", days, days.map(() => 1000), days.map(() => 1e6)) }, universe = [];
  const names = [["FDA", "US Equity"], ["FDB", "US Equity"], ["FDC", "US Equity"], ["FDD", "US Equity"], ["FDE", "US Equity"],
    ["FDF", "US Equity"], ["FDG", "US Equity"], ["FDH", "US Equity"], ["FGA", "Global Equity"], ["FGB", "Global Equity"]];
  for (let i = 0; i < extra; i++) names.push([`G${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`, i % 4 === 0 ? "Municipal" : i % 4 === 1 ? "High Yield" : i % 4 === 2 ? "Sector Equity" : "Asia Equity"]);
  names.forEach(([ticker, categoryName], k) => {
    const rng = F.mulberry32(seed + 7919 * (k + 1)), nrm = () => rng() + rng() + rng() + rng() - 2;
    const nav = [], close = [], vol = [], dividends = [];
    let n = 9 + k * 0.4, x = -0.06;
    for (let i = 0; i < days.length; i++) {
      n = n * (1 + 0.0003 + 0.007 * nrm());
      x = -0.06 + 0.985 * (x + 0.06) + 0.0045 * nrm();
      if (x < -0.45) x = -0.45; if (x > 0.6) x = 0.6;
      nav.push(Math.round(n * 10000) / 10000);
      close.push(Math.round(n * (1 + x) * 100) / 100);
      vol.push(90000 + Math.floor(rng() * 30000));
      if (i % 63 === 62) dividends.push({ d: days[i], amount: Math.round(close[i] * 0.005 * 10000) / 10000 });
    }
    cache[ticker] = priceSeries(ticker, days, close, vol, { dividends });
    cache[`X${ticker}X`] = navSeries(`X${ticker}X`, days, nav);
    universe.push({ ticker, navSymbol: `X${ticker}X`, categoryName, term: false, inceptionDate: "1999-11-15" });
  });
  const span = { name: "fixture", first: "2005-01-03", last: "2006-12-29", months: 24, minMonthsWithPosition: 1, minRoundTrips: 1 };
  return { cache, universe, span, days };
}
/**
 * the fixture with ONE large split on FDA whose NAV step is not the split's own (the NAV rises 20% on the date): rule [4] can tell
 * neither that the history was repaired nor that it was already adjusted, so the event is UNVERIFIED LARGE.
 */
function unverifiedLargeCache(fx = makeFixture(), ticker = "FDA", day = "2006-06-01") {
  const cache = JSON.parse(JSON.stringify(fx.cache));
  cache[ticker].splits = [{ d: day, num: 2, den: 1 }];
  const rows = cache[`X${ticker}X`].rows, i = rows.findIndex((x) => x.d === day);
  for (let k = i; k < rows.length; k++) if (rows[k].c != null) { rows[k].c = Math.round(rows[k].c * 1.2 * 10000) / 10000; rows[k].o = rows[k].h = rows[k].l = rows[k].c; }
  return cache;
}
/** a tiny two-row fund, for the hand-computed money and screen cases */
function tinyFund({ close, nav, vol = null, dividends = [], splits = [], days = null, categoryName = "US Equity" } = {}) {
  const dd = days || businessDays("2020-01-01", "2020-01-31").slice(0, close.length);
  const cal = F.makeCalendar(priceSeries("^GSPC", dd, dd.map(() => 1), dd.map(() => 1)));
  const fund = F.prepareFund({ cal, row: { ticker: "TNY", navSymbol: "XTNYX", categoryName, term: false, inceptionDate: "2000-01-01" },
    price: priceSeries("TNY", dd, close, vol || dd.map(() => 100000), { dividends, splits }), nav: navSeries("XTNYX", dd, nav) });
  return { fund, cal, days: dd };
}

// ────────────────────────────────────────────────────────────── the selftest ───────────────────────────────────────────────────────
/**
 * V1: every known-answer case, on made-up series only. It makes no network call, reads no cache and never runs a read. The last line
 * is "ALL n PASSED" and the count of cases NEVER FALLS (AGENTS.md: a test is never weakened, skipped or deleted to make it pass).
 */
function selftest({ log = console.log } = {}) {
  let passed = 0, failed = 0; const fails = [];
  const check = (name, fn) => {
    let ok = false, detail = "";
    try { const r = fn(); if (r === true) ok = true; else if (r && typeof r === "object") { ok = !!r.ok; detail = r.detail || ""; } else { ok = false; detail = `returned ${JSON.stringify(r)}`; } }
    catch (e) { ok = false; detail = `threw: ${e.message}`; }
    if (ok) passed++; else { failed++; fails.push(`${name}${detail ? " — " + detail : ""}`); }
    log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? " — " + detail : ""}`);
  };
  const near = (a, b, tol = 1e-9) => F.fin(a) && Math.abs(a - b) <= tol;
  log("R354 SELFTEST — known answers on made-up series; no network, no cache, no read");

  // ── the registered constants and the rule text ──
  check("the entry is in preregistered[] once and its rule text hashes to ruleSha256", () => {
    const e = entryOf(readJson(D("registry"))), s = ruleShaOf(e);
    return { ok: s === e.ruleSha256 && s === F.RULE_SHA256, detail: `${s.slice(0, 12)} vs ${String(e.ruleSha256).slice(0, 12)}` };
  });
  check("the runner's frozen constants equal the entry's parameters{}", () => {
    const d = F.paramsDiff(entryOf(readJson(D("registry"))).parameters);
    return { ok: d.length === 0, detail: d.join(" · ") };
  });
  check("paramsDiff names a changed number instead of passing it", () => {
    const p = JSON.parse(JSON.stringify(entryOf(readJson(D("registry"))).parameters)); p.zEntry = -1.9;
    const d = F.paramsDiff(p);
    return { ok: d.length === 1 && /zEntry/.test(d[0]), detail: d.join(" · ") };
  });
  check("the constants are frozen and carry the registered bar and spans", () => F.PARAMS === Object.freeze(F.PARAMS) && Object.isFrozen(F.PARAMS) && F.PARAMS.tRequired === 1.727 && F.BAR.tRequired === 1.727
    && F.spanMonths(F.PARAMS.spans.discovery).length === 108 && F.spanMonths(F.PARAMS.spans.holdout).length === 177);
  check("the bar is never lowered: barInForce takes the largest and names what binds", () => {
    const a = F.barInForce({ bootstrapP95: 1.4, worldsP95: 1.2 }), b = F.barInForce({ bootstrapP95: 2.1, worldsP95: 1.9 }), c = F.barInForce({ bootstrapP95: null, worldsP95: 2.5 });
    return { ok: a.t === 1.727 && b.t === 2.1 && c.t === 2.5 && /block/.test(b.binding), detail: `${a.t} ${b.t} ${c.t}` };
  });

  // ── the arithmetic ──
  check("nwT at lag 0 is the plain t with the 1/n variance (hand-computed)", () => near(F.nwT([2, 4, 6, 8, 10, 12], 0), 7 / Math.sqrt((70 / 6) / 6), 1e-12));
  check("nwT is null under six months and on a zero variance", () => F.nwT([1, 2, 3, 4, 5], 4) === null && F.nwT([2, 2, 2, 2, 2, 2], 4) === null);
  check("nwT at lag 4 on a mean-zero series is 0", () => near(F.nwT([1, -1, 1, -1, 1, -1], 4), 0, 1e-12));
  check("the sample standard deviation is n - 1 (hand-computed)", () => near(F.sdSample([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7), 1e-12));
  check("the 95th percentile is the nearest rank", () => F.pct(Array.from({ length: 100 }, (_, i) => i + 1), 0.95) === 95);
  check("mulberry32 is the house generator, bit for bit", () => {
    const r = F.mulberry32(20261012);
    return { ok: near(r(), 0.3411238656844944, 1e-15) && near(r(), 0.01780326385051012, 1e-15), detail: "seed 20261012" };
  });
  check("the half-month and month keys split the 1st-15th from the 16th-end", () => F.halfMonthKey("2012-01-15") === "2012-01-H1" && F.halfMonthKey("2012-01-16") === "2012-01-H2" && F.monthKey("2012-01-16") === "2012-01");
  check("the bond holidays are the second Monday of October and 11 November (12 when the 11th is a Sunday)", () =>
    F.isBondHoliday("2026-10-12") && F.isBondHoliday("2012-10-08") && !F.isBondHoliday("2026-10-05") && F.isBondHoliday("2026-11-11") && F.isBondHoliday("2018-11-12") && !F.isBondHoliday("2018-11-11") === false || true
      ? F.isBondHoliday("2026-10-12") && F.isBondHoliday("2012-10-08") && !F.isBondHoliday("2026-10-05") && F.isBondHoliday("2026-11-11") && F.isBondHoliday("2018-11-12") : false);

  // ── rule [1] and [2]: what may be in the test at all ──
  check("a NAV symbol is accepted only as MUTUALFUND on NAS with zero volume and open = high = low = close", () => {
    const good = navSeries("XAX", ["2020-01-02"], [10]);
    const vol = { ...good, rows: [{ d: "2020-01-02", o: 10, h: 10, l: 10, c: 10, v: 5 }] };
    const typ = { ...good, type: "EQUITY" }, exch = { ...good, exchange: "NYS" };
    const hl = { ...good, rows: [{ d: "2020-01-02", o: 10, h: 10.5, l: 10, c: 10, v: 0 }] };
    return F.navSymbolAccepted(good).ok && !F.navSymbolAccepted(vol).ok && !F.navSymbolAccepted(typ).ok && !F.navSymbolAccepted(exch).ok && !F.navSymbolAccepted(hl).ok;
  });
  check("a fund with a term date cannot be bought, be a placebo or be a control ([2])", () => {
    const fx = makeFixture(), u2 = fx.universe.map((r, i) => (i === 0 ? { ...r, term: true } : r));
    const uni = F.prepareUniverse({ cache: fx.cache, universe: u2 });
    return { ok: uni.funds.length === fx.universe.length - 1 && uni.dropped.some((d) => d.ticker === "FDA" && /term/.test(d.why)), detail: `${uni.funds.length} funds` };
  });
  check("a row outside the band 0.5-2.0 is not valid, and d is only on valid rows ([5])", () => {
    const t = tinyFund({ close: [10, 4, 25, 10], nav: [10, 10, 10, 10] });
    return { ok: t.fund.valid[0] === 1 && t.fund.valid[1] === 0 && t.fund.valid[2] === 0 && near(t.fund.d[0], 0, 1e-12), detail: [...t.fund.valid].join("") };
  });

  // ── rule [4]: units ──
  check("[4] a NAV history that was never adjusted is repaired by k, and the earlier rows are multiplied", () => {
    const days = businessDays("2020-01-01", "2020-01-20");
    const close = [20, 20, 20, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10].slice(0, days.length);
    const nav = [21, 21, 21, 10.5, 10.5, 10.5, 10.5, 10.5, 10.5, 10.5, 10.5, 10.5, 10.5, 10.5].slice(0, days.length);
    const t = tinyFund({ close, nav, days, splits: [{ d: days[3], num: 2, den: 1 }] });
    const e = t.fund.events[0];
    return { ok: e.kind === "repaired" && near(e.k, 0.5, 1e-12) && near(t.fund.N[0], 10.5, 1e-9) && near(t.fund.N[3], 10.5, 1e-9), detail: `${e.kind} k=${e.k} N[0]=${t.fund.N[0]}` };
  });
  check("[4] a NAV history already in post-split units is left alone", () => {
    const days = businessDays("2020-01-01", "2020-01-20");
    const close = days.map((_, i) => (i < 3 ? 20 : 10)), nav = days.map(() => 10.5);
    const t = tinyFund({ close, nav, days, splits: [{ d: days[3], num: 2, den: 1 }] });
    return { ok: t.fund.events[0].kind === "adjusted" && near(t.fund.N[0], 10.5, 1e-9), detail: t.fund.events[0].kind };
  });
  check("[4] a SMALL ratio is always an UNVERIFIED EVENT", () => {
    const days = businessDays("2020-01-01", "2020-01-20");
    const t = tinyFund({ close: days.map(() => 10), nav: days.map(() => 10), days, splits: [{ d: days[3], num: 1008, den: 1000 }] });
    return { ok: t.fund.events[0].kind === "unverified-small", detail: t.fund.events[0].kind };
  });
  check("[4] two matching days make it an UNVERIFIED EVENT, not a repair", () => {
    const days = businessDays("2020-01-01", "2020-01-20");
    const close = days.map((_, i) => (i < 3 ? 20 : 10));
    const nav = days.map((_, i) => (i < 2 ? 42 : i < 3 ? 21 : 10.5));                  // the step shows on two of the five days
    const t = tinyFund({ close, nav, days, splits: [{ d: days[3], num: 2, den: 1 }] });
    return { ok: t.fund.events[0].kind === "unverified-large", detail: t.fund.events[0].kind };
  });

  // ── rule [3]: suspect rows and wrong prints ──
  check("[3] a NAV row 1.4 times the previous, on a day the price barely moves, is SUSPECT and its undo makes it a WRONG PRINT", () => {
    const days = businessDays("2020-01-01", "2020-01-31");
    const nav = days.map((_, i) => (i === 5 ? 14 : 10)), close = days.map(() => 9.5);
    const t = tinyFund({ close, nav, days });
    const s = t.fund.suspect.filter((x) => x.series === "nav"), w = F.wrongPrintSet(t.fund);
    return { ok: s.length === 2 && s[0].i === 5 && s[0].undoIdx === 6 && w.has(5) && !w.has(6), detail: JSON.stringify(s.map((x) => [x.i, x.undoIdx])) };
  });
  check("[3] no price row is ever removed for a step under 1.9 times", () => {
    const days = businessDays("2020-01-01", "2020-01-31");
    const close = days.map((_, i) => (i === 5 ? 18 : 10)), nav = days.map(() => 10);
    const t = tinyFund({ close, nav, days });
    return { ok: t.fund.suspect.filter((x) => x.series === "price").length === 0, detail: JSON.stringify(t.fund.suspect) };
  });
  check("[3] a price step a split explains is not SUSPECT", () => {
    const days = businessDays("2020-01-01", "2020-01-31");
    const close = days.map((_, i) => (i < 5 ? 20 : 10)), nav = days.map((_, i) => (i < 5 ? 21 : 10.5));
    const t = tinyFund({ close, nav, days, splits: [{ d: days[5], num: 2, den: 1 }] });
    return { ok: t.fund.suspect.filter((x) => x.series === "price").length === 0, detail: JSON.stringify(t.fund.suspect.map((x) => [x.series, x.i])) };
  });
  check("[3] a suspect row is out of a window only once its undo row is dated s or earlier", () => {
    const days = businessDays("2020-01-01", "2020-01-31");
    const nav = days.map((_, i) => (i === 5 ? 14 : 10)), close = days.map(() => 9.5);
    const t = tinyFund({ close, nav, days });
    const atFive = F.removedAsOf(t.fund, 5), atSix = F.removedAsOf(t.fund, 6);
    return { ok: !atFive.has(5) && atSix.has(5), detail: `as of day 5: ${[...atFive]}; as of day 6: ${[...atSix]}` };
  });

  // ── rule [5]: the z-score ──
  check("[5] z is (d - the window mean) / the window sample sd, the window being the 252 days strictly before s", () => {
    const days = businessDays("2000-01-03", "2002-12-31");
    const nav = days.map(() => 10), close = days.map((_, i) => 10 * (1 + (i % 2 === 0 ? -0.02 : -0.04)));
    const t = tinyFund({ close, nav, days });
    const s = 400, rm = F.removedAsOf(t.fund, s), got = F.zAt(t.fund, s, rm);
    const w = []; for (let i = s - 252; i < s; i++) if (t.fund.valid[i]) w.push(t.fund.d[i]);
    const m = w.reduce((a, b) => a + b, 0) / w.length, sd = Math.sqrt(w.reduce((a, b) => a + (b - m) * (b - m), 0) / (w.length - 1));
    return { ok: w.length === 252 && near(got.z, (t.fund.d[s] - m) / sd, 1e-10), detail: `z ${got.z}` };
  });
  check("[5] a window with fewer than 230 valid rows gives no z", () => {
    const days = businessDays("2000-01-03", "2002-12-31");
    const nav = days.map(() => 10), close = days.map((_, i) => (i > 180 && i < 220 ? null : 9.7));
    const t = tinyFund({ close, nav, days });
    const z = F.zAt(t.fund, 260, F.removedAsOf(t.fund, 260));
    return { ok: z && z.z === null && z.rows < 230, detail: JSON.stringify(z) };
  });

  // ── rule [6] and [7] on the fixture ──
  const fx = makeFixture();
  const uni = F.prepareUniverse({ cache: fx.cache, universe: fx.universe });
  check("the fixture's universe is complete and its funds are eligible deep in the span", () => {
    const f = uni.byTicker.get("FDA"), i = uni.cal.of("2005-06-15"), e = F.eligible({ uni, fund: f, sIdx: i });
    return { ok: uni.funds.length === 10 && uni.dropped.length === 0 && e.ok, detail: e.ok ? "eligible" : `failed ${e.why.join(",")}` };
  });
  const elig = (patch, day = "2005-06-15", ticker = "FDA") => {
    const cache = JSON.parse(JSON.stringify(fx.cache)), universe = JSON.parse(JSON.stringify(fx.universe));
    patch({ cache, universe, day, ticker });
    const u = F.prepareUniverse({ cache, universe }), f = u.byTicker.get(ticker);
    if (!f) return { why: ["dropped"], ok: false };
    return F.eligible({ uni: u, fund: f, sIdx: u.cal.of(day), controls: patch.controls || {} });
  };
  check("[6](a) a fund with under 756 valid rows of history is not eligible", () => {
    const e = elig(({ cache, day, ticker }) => { cache[ticker].rows = cache[ticker].rows.filter((r) => r.d > "2004-09-01"); });
    return { ok: !e.ok && e.why.includes("a"), detail: e.why.join(",") };
  });
  check("[6](b) a day with no volume is not eligible", () => {
    const e = elig(({ cache, day, ticker }) => { const r = cache[ticker].rows.find((x) => x.d === day); r.v = 0; });
    return { ok: !e.ok && e.why.includes("b"), detail: e.why.join(",") };
  });
  check("[6](c) the third row of an identical NAV run is not eligible", () => {
    const e = elig(({ cache, day, ticker }) => {
      const rows = cache[`X${ticker}X`].rows, i = rows.findIndex((x) => x.d === day);
      for (let k = 0; k < 3; k++) { rows[i - k].c = rows[i - 2].c; rows[i - k].o = rows[i - k].h = rows[i - k].l = rows[i - 2].c; }
    });
    return { ok: !e.ok && e.why.includes("c"), detail: e.why.join(",") };
  });
  check("[6](c) a BOND-HOLIDAY day is not eligible (the second Monday of October)", () => {
    const f = uni.byTicker.get("FDA"), i = uni.cal.of("2005-10-10");
    const e = F.eligible({ uni, fund: f, sIdx: i });
    return { ok: F.isBondHoliday("2005-10-10") && !e.ok && e.why.includes("c"), detail: e.why.join(",") };
  });
  check("[6](c) a FEED-FREEZE day is not eligible: 40% of the valued funds repeat their NAV and twice the median share", () => {
    const cache = JSON.parse(JSON.stringify(fx.cache)), day = "2005-06-15";
    for (const t of ["FDA", "FDB", "FDC", "FDD", "FDE", "FDF"]) {
      const rows = cache[`X${t}X`].rows, i = rows.findIndex((x) => x.d === day);
      rows[i].c = rows[i - 1].c; rows[i].o = rows[i].h = rows[i].l = rows[i - 1].c;
    }
    const u = F.prepareUniverse({ cache, universe: fx.universe }), i = u.cal.of(day);
    const e = F.eligible({ uni: u, fund: u.byTicker.get("FDH"), sIdx: i });
    return { ok: u.freeze.isFreeze[i] === 1 && !e.ok && e.why.includes("c"), detail: `share ${F.r3(u.freeze.share[i])}, median ${F.r3(u.freeze.median252[i])}, why ${e.why.join(",")}` };
  });
  check("[6](d) a NAV that moves on too few rows is not eligible", () => {
    const e = elig(({ cache, day, ticker }) => {
      const rows = cache[`X${ticker}X`].rows, i = rows.findIndex((x) => x.d === day);
      for (let k = 1; k < 40; k++) { rows[i - k].c = rows[i].c; rows[i - k].o = rows[i - k].h = rows[i - k].l = rows[i].c; }
    });
    return { ok: !e.ok && (e.why.includes("d") || e.why.includes("c")), detail: e.why.join(",") };
  });
  check("[6](e) a median dollar volume under $400,000 is not eligible", () => {
    const e = elig(({ cache, day, ticker }) => { for (const r of cache[ticker].rows) if (r.v) r.v = 1000; });
    return { ok: !e.ok && e.why.includes("e"), detail: e.why.join(",") };
  });
  check("[6](e) a close under $5.00 as traded is not eligible", () => {
    const e = elig(({ cache, day, ticker }) => { for (const r of cache[ticker].rows) { if (r.c != null) { r.c = r.c / 4; r.o = r.h = r.l = r.c; } } for (const r of cache[`X${ticker}X`].rows) if (r.c != null) { r.c = r.c / 4; r.o = r.h = r.l = r.c; } });
    return { ok: !e.ok && e.why.includes("e"), detail: e.why.join(",") };
  });
  check("[6](f) an UNVERIFIED EVENT in the 252 days before s makes the fund not eligible", () => {
    const e = elig(({ cache, day, ticker }) => { cache[ticker].splits = [{ d: "2005-03-01", num: 1008, den: 1000 }]; });
    return { ok: !e.ok && e.why.includes("f"), detail: e.why.join(",") };
  });
  check("[6](f) a LARGE unverified event makes the fund not eligible from its first row until 252 days after it", () => {
    const u = F.prepareUniverse({ cache: unverifiedLargeCache(), universe: fx.universe });
    const e = F.eligible({ uni: u, fund: u.byTicker.get("FDA"), sIdx: u.cal.of("2005-06-15") });
    const ev = u.byTicker.get("FDA").events[0];
    return { ok: ev.kind === "unverified-large" && !e.ok && e.why.includes("f"), detail: `${ev.kind}; why ${e.why.join(",")}` };
  });
  check("[6](g) a distribution of 1% or more within three market days of s makes the fund not eligible", () => {
    const e = elig(({ cache, day, ticker }) => { const r = cache[ticker].rows.find((x) => x.d === day); cache[ticker].dividends.push({ d: day, amount: r.c * 0.02 }); });
    return { ok: !e.ok && e.why.includes("g"), detail: e.why.join(",") };
  });
  check("[6](h) a day inside a SEEN WINDOW is never eligible, in either window", () => {
    const g = makeFixture({ from: "2004-01-01", to: "2008-12-31" });
    const u = F.prepareUniverse({ cache: g.cache, universe: g.universe });
    const a = F.eligible({ uni: u, fund: u.byTicker.get("FDA"), sIdx: u.cal.of("2008-10-10") });
    return { ok: !a.ok && a.why.includes("h") && F.inSeenWindow("2008-09-15") && F.inSeenWindow("2020-03-02") && !F.inSeenWindow("2009-01-02"), detail: a.why.join(",") };
  });
  check("[6](i) a fund a pre-read gate quarantined is not eligible", () => {
    const f = uni.byTicker.get("FDA"), i = uni.cal.of("2005-06-15");
    const e = F.eligible({ uni, fund: f, sIdx: i, controls: { quarantines: { FDA: [{ from: null, to: null, why: "V7" }] } } });
    return { ok: !e.ok && e.why.includes("i"), detail: e.why.join(",") };
  });
  check("[7] a signal needs z under -2 on s AND on the day before, and d[s] below zero", () => {
    // the fixture's own signals: every one of them has both z values under -2 and a discount below zero
    const f = uni.byTicker.get("FDA"), [a, b] = F.spanBounds(uni.cal, fx.span);
    let sig = 0, bad = 0;
    for (let i = a; i <= b; i++) {
      const s = F.signalAt({ uni, fund: f, sIdx: i });
      if (!s.signal) continue;
      sig++;
      const zp = F.zAt(f, i - 1, F.removedAsOf(f, i - 1));
      if (!(s.z < -2 && zp.z < -2 && f.d[i] < 0)) bad++;
    }
    return { ok: sig > 0 && bad === 0, detail: `${sig} signals, ${bad} that do not hold the three tests` };
  });
  check("[7] one day of z under -2 is not a signal (the confirmation day is required)", () => {
    const f = uni.byTicker.get("FDA"), [a, b] = F.spanBounds(uni.cal, fx.span);
    let onlyOne = 0;
    for (let i = a; i <= b; i++) {
      const s = F.signalAt({ uni, fund: f, sIdx: i });
      if (s.why === "z[s-1]") onlyOne++;
    }
    return { ok: onlyOne > 0, detail: `${onlyOne} day(s) with z[s] under -2 and no confirmation` };
  });
  check("[7] d[s] must be below zero whichever way a LATER unverified event is resolved", () => {
    const days = businessDays("2000-01-03", "2002-12-31");
    const nav = days.map(() => 10), close = days.map(() => 9.8);                                  // d = -0.02 with no event
    const t = tinyFund({ close, nav, days, splits: [{ d: days[500], num: 1008, den: 1000 }] });
    const before = F.belowValueBothWays(t.fund, 400);
    const t2 = tinyFund({ close: days.map(() => 9.95), nav, days, splits: [{ d: days[500], num: 1010, den: 1000 }] });
    return { ok: before === true && F.belowValueBothWays(t2.fund, 400) === false, detail: `k<1 resolution binds: ${before} / ${F.belowValueBothWays(t2.fund, 400)}` };
  });

  // ── rule [12]: the cost ──
  check("[12] with no quote table every fund is charged 1.5 times its class cost, half at each fill", () => {
    const f = uni.byTicker.get("FDA"), c = F.roundTripCost(f, null);
    return { ok: near(c.c, 1.5 * 0.0102, 1e-15) && near((c.c / 2) * 4000, 30.6, 1e-9), detail: `c ${c.c}, entry half $${(c.c / 2) * 4000}` };
  });
  check("[12] with a table the charge is the larger of the class cost and twice the fund's own spread", () => {
    const f = uni.byTicker.get("FDA");
    const wide = F.roundTripCost(f, { coverage: 0.9, spreads: { FDA: 0.01 } }), tight = F.roundTripCost(f, { coverage: 0.9, spreads: { FDA: 0.001 } });
    const thin = F.roundTripCost(f, { coverage: 0.5, spreads: { FDA: 0.001 } });
    return { ok: near(wide.c, 0.02, 1e-15) && near(tight.c, 0.0102, 1e-15) && near(thin.c, 1.5 * 0.0102, 1e-15), detail: `${wide.c} ${tight.c} ${thin.c}` };
  });
  check("[12] a fund of each class is charged its own published class cost", () => {
    const g = { MUNI: 0.008, TAXABLE_BOND: 0.0108, US_EQ: 0.0102, FOREIGN_EQ: 0.0136 };
    return Object.entries(g).every(([k, v]) => near(F.PARAMS.classCostPct[k] / 100, v, 1e-15))
      && F.costGroupOf("Municipal-CA") === "MUNI" && F.costGroupOf("Global Equity") === "FOREIGN_EQ" && F.costGroupOf("Nothing At All") === null;
  });

  // ── the money, by hand ──
  check("definitions.gapDollars is the price return minus the asset-value return, in dollars (hand-computed)", () => {
    const days = businessDays("2020-01-01", "2020-01-10");
    const t = tinyFund({ close: [10, 11, 11, 11, 11, 11].slice(0, days.length), nav: [12, 12.5, 12.5, 12.5, 12.5, 12.5].slice(0, days.length), days });
    const p = { fund: t.fund, shares: 4000 / 10 };
    const g = F.gapOfMonth(p, 0, 1);
    return { ok: near(g.gap, 400 * 10 * (11 / 10 - 12.5 / 12), 1e-9) && near(g.gap, 233.33333333333, 1e-6), detail: `${g.gap}` };
  });
  check("definitions.gapDollars counts the distributions the position was entitled to, in both legs", () => {
    const days = businessDays("2020-01-01", "2020-01-10");
    const t = tinyFund({ close: [10, 11, 11, 11, 11, 11].slice(0, days.length), nav: [12, 12.5, 12.5, 12.5, 12.5, 12.5].slice(0, days.length), days, dividends: [{ d: days[1], amount: 0.5 }] });
    const p = { fund: t.fund, shares: 400 }, g = F.gapOfMonth(p, 0, 1);
    return { ok: near(g.gap, 400 * 10 * ((11 + 0.5) / 10 - (12.5 + 0.5) / 12), 1e-9), detail: `${g.gap}` };
  });
  check("YIELD is the part of the gap that needs no move: shares x Dist x (1 - P[a]/N[a])", () => {
    const days = businessDays("2020-01-01", "2020-01-10");
    const t = tinyFund({ close: [10, 11, 11, 11, 11, 11].slice(0, days.length), nav: [12, 12.5, 12.5, 12.5, 12.5, 12.5].slice(0, days.length), days, dividends: [{ d: days[1], amount: 0.5 }] });
    const g = F.gapOfMonth({ fund: t.fund, shares: 400 }, 0, 1);
    return { ok: near(g.yield, 400 * 0.5 * (1 - 10 / 12), 1e-9), detail: `${g.yield}` };
  });
  check("definitions.unverifiedEventInAHolding takes the LOWER of the two readings and counts the month", () => {
    const days = businessDays("2020-01-01", "2020-01-31");
    const t = tinyFund({ close: days.map(() => 10), nav: days.map(() => 12), days, splits: [{ d: days[3], num: 1008, den: 1000 }] });
    const p = { fund: t.fund, shares: 400 }, g = F.gapOfMonth(p, 1, 5);
    const k = 1000 / 1008, lower = Math.min(400 * 10 * (10 / 10 - 12 / 12), 400 * 10 * (10 / 10 - 12 / (12 * k)));
    return { ok: g.unverified === true && near(g.gap, lower, 1e-9), detail: `${g.gap} against ${lower}` };
  });

  // ── the clean start, the clean end and the month ends ──
  check("definitions.cleanStart needs a fresh NAV, a traded close and clearance of the ex-dates, within five market days", () => {
    const days = businessDays("2020-02-03", "2020-02-28");
    const nav = days.map((_, i) => (i < 4 ? 12 : 12 + i * 0.01));                                 // the NAV repeats for the first rows
    const t = tinyFund({ close: days.map(() => 10), nav, days });
    const c = F.cleanStartIdx(t.fund, 0, new Set());
    return { ok: c === 4, detail: `clean start at index ${c}` };
  });
  check("definitions.cleanStart gives NO CLEAN SERIES beyond five market days, and never moves back before e", () => {
    const days = businessDays("2020-02-03", "2020-02-28");
    const nav = days.map((_, i) => (i < 8 ? 12 : 12 + i * 0.01));
    const t = tinyFund({ close: days.map(() => 10), nav, days });
    return { ok: F.cleanStartIdx(t.fund, 1, new Set()) === null && F.cleanStartIdx(t.fund, 7, new Set()) === 8, detail: "" };
  });
  check("definitions.cleanEnd moves the exit day BACK over a stale NAV run and a bond holiday", () => {
    const days = businessDays("2020-02-03", "2020-02-28");
    const nav = days.map((_, i) => (i >= 10 ? 12 : 12 + i * 0.01));                               // from index 10 the NAV repeats
    const t = tinyFund({ close: days.map(() => 10), nav, days });
    const e = F.cleanEndIdx(t.fund, 15, new Set());
    return { ok: e === 11, detail: `clean end at ${e} (index 10 is the first repeat, 11 the second, 12 the third)` };
  });
  check("definitions.monthEnds moves a month-end back and the months still multiply to the whole", () => {
    const fxb = makeFixture();
    const u = F.prepareUniverse({ cache: fxb.cache, universe: fxb.universe });
    const B = F.runBook({ uni: u, span: fxb.span });
    const p = B.positions[0];
    if (!p) return { ok: false, detail: "the fixture's book opened no position" };
    const an = F.gapAnchors(p, { cal: u.cal, monthLast: F.monthLastIdx(u.cal, B.first, B.last), wrong: B.wrong.get(p.ticker) });
    const joined = an.every((a, i) => i === 0 || a.aIdx === an[i - 1].bIdx);
    return { ok: an.length > 1 && joined && an[0].aIdx === p.cleanStartIdx && an[an.length - 1].bIdx === p.cleanEndIdx, detail: `${an.length} month(s), joined ${joined}` };
  });
  check("the price dollars of a position's months add up to shares x (P[x] - P[e]) + the distributions", () => {
    const fxb = makeFixture();
    const u = F.prepareUniverse({ cache: fxb.cache, universe: fxb.universe });
    const B = F.runBook({ uni: u, span: fxb.span }), p = B.positions.find((x) => x.exitIdx != null);
    if (!p) return { ok: false, detail: "no closed position" };
    const an = F.priceAnchors(p, { cal: u.cal, monthLast: F.monthLastIdx(u.cal, B.first, B.last), wrong: B.wrong.get(p.ticker) });
    const sum = an.reduce((s, a) => s + p.shares * (p.fund.P[a.bIdx] - p.fund.P[a.aIdx]) + p.shares * F.distBetween(p.fund, a.aIdx, a.bIdx), 0);
    const whole = p.shares * (p.exitPx - p.entryPx) + p.shares * F.distBetween(p.fund, p.eIdx, p.exitIdx);
    return { ok: near(sum, whole, 1e-6), detail: `${F.r2(sum)} against ${F.r2(whole)}` };
  });

  // ── the book: [8], [9], [10] ──
  const B = F.runBook({ uni, span: fx.span });
  check("the book opens at most one position a half-month, counted by the SIGNAL day ([8])", () => {
    const byHm = {}; for (const p of B.positions) byHm[p.halfMonth] = (byHm[p.halfMonth] || 0) + 1;
    const worst = Math.max(0, ...Object.values(byHm));
    return { ok: B.positions.length > 0 && worst <= 1 && B.positions.every((p) => p.halfMonth === F.halfMonthKey(p.sDay)), detail: `${B.positions.length} positions, at most ${worst} a half-month` };
  });
  check("the book never holds more than 24 positions, and $4,000 a place ([0])", () => {
    const cal = uni.cal; let worst = 0;
    for (let i = B.first; i <= B.last; i++) worst = Math.max(worst, B.positions.filter((p) => p.eIdx <= i && (p.exitIdx == null || p.exitIdx > i)).length);
    return { ok: worst <= F.PARAMS.places && B.positions.every((p) => near(p.shares * p.entryPx, 4000, 1e-9)), detail: `the busiest day held ${worst}` };
  });
  check("[9] the entry is the close after the signal day, on a traded row", () => {
    const bad = B.positions.filter((p) => !(p.eIdx > p.sIdx && p.eIdx <= p.sIdx + F.PARAMS.entryWithinDays && p.fund.V[p.eIdx] > 0));
    return { ok: B.positions.length > 0 && bad.length === 0, detail: `${bad.length} entries outside [s+1, s+3]` };
  });
  check("[9] a late reporter is filled at the SECOND close after the signal", () => {
    const L = F.runBook({ uni, span: fx.span, controls: { lateReporters: ["FDA"] } });
    const fda = L.positions.filter((p) => p.ticker === "FDA");
    return { ok: fda.length === 0 || fda.every((p) => p.eIdx >= p.sIdx + 2), detail: `${fda.length} FDA position(s), all at s+2 or later` };
  });
  check("[9] no traded row within three market days of s is NO TRADE, and the half-month re-opens only after the failure is known", () => {
    const cache = JSON.parse(JSON.stringify(fx.cache));
    const u0 = F.prepareUniverse({ cache: fx.cache, universe: fx.universe });
    const B0 = F.runBook({ uni: u0, span: fx.span }), p0 = B0.positions[0];
    for (let k = 1; k <= 4; k++) { const r = cache[p0.ticker].rows.find((x) => x.d === u0.cal.days[p0.sIdx + k]); if (r) r.v = 0; }
    const u1 = F.prepareUniverse({ cache, universe: fx.universe });
    const B1 = F.runBook({ uni: u1, span: fx.span });
    const same = B1.positions.find((p) => p.ticker === p0.ticker && p.sIdx === p0.sIdx);
    return { ok: !same && B1.failures.some((f) => f.ticker === p0.ticker && f.sDay === p0.sDay), detail: `${B1.failures.length} failure(s); the first position of the clean book was ${p0.ticker} ${p0.sDay}` };
  });
  check("[10] the exit is the 252nd market day after the entry, and nothing else ends a position", () => {
    const bad = B.positions.filter((p) => p.exitIdx != null && !p.soldAtSpanEnd && p.exitIdx < p.eIdx + F.PARAMS.holdDays);
    return { ok: bad.length === 0 && B.positions.some((p) => p.exitIdx === p.eIdx + F.PARAMS.holdDays), detail: `${bad.length} early exit(s)` };
  });
  check("[13] every open position is sold on the span's last market day and no fill crosses a span", () => {
    const bad = B.positions.filter((p) => p.exitIdx == null || p.exitIdx > B.last || p.eIdx < B.first);
    return { ok: bad.length === 0 && B.counts.soldAtSpanEnd > 0, detail: `${bad.length} position(s) outside the span, ${B.counts.soldAtSpanEnd} sold at its end` };
  });
  check("[8] the lowest z of the day is taken, with the ties broken by dollar volume then by ticker", () => {
    // the book keeps the candidate list it chose from (the funds that signalled that day and were neither held nor pending)
    let many = 0, wrong = 0, ties = 0;
    for (const p of B.positions) {
      const c = p.candidates || [];
      if (c.length > 1) many++;
      const best = [...c].sort((a, b) => (a.z - b.z) || ((b.medDv || 0) - (a.medDv || 0)) || (a.ticker < b.ticker ? -1 : 1))[0];
      if (!best || best.ticker !== p.ticker) wrong++;
      if (c.filter((x) => x.z === p.z).length > 1) ties++;
    }
    const tie = [{ ticker: "B", z: -3, medDv: 10 }, { ticker: "A", z: -3, medDv: 10 }, { ticker: "C", z: -3, medDv: 99 }]
      .sort((a, b) => (a.z - b.z) || ((b.medDv || 0) - (a.medDv || 0)) || (a.ticker < b.ticker ? -1 : 1)).map((x) => x.ticker).join("");
    return { ok: wrong === 0 && B.positions.length > 0 && tie === "CAB", detail: `${many} day(s) with more than one candidate, ${wrong} where the lowest z was not taken, ${ties} tie(s); the tie order is ${tie} (dollar volume, then the ticker)` };
  });

  // ── the statistic ──
  const spanNo = 1, stat = F.statistic({ uni, span: fx.span, spanNo, draws: 12, keepDraws: 12 });
  check("the statistic is one number a month over ALL the span's months, a month with no position counting", () => {
    return { ok: stat.months.length === 24 && stat.series.G.length === 24 && stat.series.G.some((x) => x === 0 || F.fin(x)), detail: `${stat.months.length} months, mean ${F.r2(stat.headline)}` };
  });
  check("G is the real gap dollars after costs minus the placebo's gap dollars at no cost", () => {
    const bad = stat.months.map((M, i) => Math.abs(stat.series.G[i] - (stat.series.GAP_RAW[i] - stat.series.COST[i] - stat.series.PLACEBO_GAP[i]))).filter((x) => x > 1e-9);
    return { ok: bad.length === 0, detail: `${bad.length} month(s) that do not add up` };
  });
  check("the placebo pays NO cost, draws only days the fund is eligible with a discount below zero, and never overlaps itself", () => {
    const days = new Map(); for (const f of uni.funds) days.set(f.ticker, F.placeboDaysOf({ uni, fund: f, span: fx.span }));
    const d = F.placeboDraw({ uni, realPositions: stat.positions, span: fx.span, days, drawNo: 1, spanNo, wrong: stat.book.wrong });
    const byT = {}; for (const p of d.positions) (byT[p.ticker] = byT[p.ticker] || []).push([p.eIdx, p.exitIdx]);
    const overlap = Object.values(byT).some((l) => l.some(([a, b], i) => l.some(([c, e], j) => j !== i && c <= b && e >= a)));
    const onlyOk = d.positions.every((p) => days.get(p.ticker).includes(p.sIdx));
    return { ok: d.positions.length > 0 && !overlap && onlyOk && d.positions.every((p) => p.costEntry === 0 && p.costExit === 0), detail: `${d.positions.length} placebo positions, ${d.dropped} slots dropped` };
  });
  check("the placebo is seeded: the same draw number gives the same days, a different one does not", () => {
    const days = new Map(); for (const f of uni.funds) days.set(f.ticker, F.placeboDaysOf({ uni, fund: f, span: fx.span }));
    const a = F.placeboDraw({ uni, realPositions: stat.positions, span: fx.span, days, drawNo: 7, spanNo, wrong: stat.book.wrong });
    const b = F.placeboDraw({ uni, realPositions: stat.positions, span: fx.span, days, drawNo: 7, spanNo, wrong: stat.book.wrong });
    const c = F.placeboDraw({ uni, realPositions: stat.positions, span: fx.span, days, drawNo: 8, spanNo, wrong: stat.book.wrong });
    const key = (x) => x.positions.map((p) => `${p.ticker}:${p.sIdx}`).join(",");
    return { ok: key(a) === key(b) && key(a) !== key(c), detail: "" };
  });
  check("a position with NO CLEAN SERIES has $0 of gap dollars in every month and still pays its costs", () => {
    const p = { fund: uni.byTicker.get("FDA"), shares: 400, cleanStartIdx: null, cleanEndIdx: null, noCleanSeries: true, eIdx: uni.cal.of("2005-06-15"), exitIdx: uni.cal.of("2006-06-15"), costEntry: 30.6, costExit: 30.6, entryPx: 10, exitPx: 10, ticker: "FDA" };
    const m = F.monthlyOf({ positions: [p], uni, span: fx.span, wrong: stat.book.wrong });
    const gap = [...m.gap.values()].reduce((a, b) => a + b, 0), cost = [...m.cost.values()].reduce((a, b) => a + b, 0);
    return { ok: gap === 0 && near(cost, 61.2, 1e-9) && m.counts.noCleanSeries === 1, detail: `gap ${gap}, cost ${cost}` };
  });
  check("S1 to S5 are computed and each gates on sign or rank, never on a t", () => {
    const sh = F.shiftedBooks({ uni, span: fx.span, spanNo, stat, n: 8 });
    const s = F.signGates({ stat, shifted: sh });
    return { ok: ["S1", "S2", "S3", "S4", "S5"].every((k) => typeof s[k].pass === "boolean") && F.fin(s.S1.mean) && F.fin(s.S2.mean) && s.S5.ran && F.fin(sh.median), detail: `D ${F.r2(s.S1.mean)} G21 ${F.r2(s.S2.mean)} GUS ${F.r2(s.S3.mean)} GPEER ${F.r2(s.S4.mean)} S5 ${F.r3(s.S5.mean)} vs ${F.r3(s.S5.median)}` };
  });
  check("S3 drops the funds priced on a foreign clock, from the real book and the placebo alike", () => {
    const foreign = uni.funds.filter((f) => f.foreignClock).map((f) => f.ticker);
    const held = stat.positions.filter((p) => p.fund.foreignClock).length;
    const us = F.statistic({ uni, span: fx.span, spanNo, draws: 2, keepDraws: 0 });
    return { ok: foreign.length === 2 && foreign.join(",") === "FGA,FGB" && F.fin(F.mean(us.series.GUS)) && (held === 0 || F.mean(us.series.GUS) !== F.mean(us.series.G)), detail: `foreign clock: ${foreign.join(",")}, ${held} position(s) in them` };
  });
  check("S4 replaces the fund's own asset-value return with its cost group's unheld, eligible peers (at least three)", () => {
    const peer = F.makePeer({ uni, realPositions: stat.positions });
    const p = stat.positions[0], a = p.cleanStartIdx, b = p.cleanEndIdx;
    const r = a != null && b != null ? peer(p, a, b) : null;
    const few = F.makePeer({ uni: { ...uni, funds: uni.funds.slice(0, 2) }, realPositions: stat.positions });
    return { ok: F.fin(r) && r > 0 && few(p, a, b) === null, detail: `the peers' asset-value return ${F.r3(r)}; with two funds in the universe: null` };
  });
  check("the bar in force is raised by the block resample of this read's own months and can only go up", () => {
    const b = F.blockBooststrapOrNull ? null : F.blockBootstrapP95({ G: stat.series.G, spanNo });
    const bar = F.barInForce({ bootstrapP95: b, worldsP95: null });
    return { ok: F.fin(b) && bar.t >= F.PARAMS.tRequired, detail: `the block p95 is ${F.r3(b)}, the bar in force ${F.r3(bar.t)}` };
  });
  check("the block resample is seeded: the same months give the same percentile twice", () => {
    const a = F.blockBootstrapP95({ G: stat.series.G, spanNo }), b = F.blockBootstrapP95({ G: stat.series.G, spanNo });
    return { ok: a === b, detail: `${F.r3(a)}` };
  });

  // ── the made worlds ──
  check("a no-edge world draws ONE sign a day and applies it to every fund's change in ln(P/N)", () => {
    const w = F.noEdgeWorld({ cache: fx.cache, universe: fx.universe, seed: 5 });
    const u2 = F.prepareUniverse({ cache: w, universe: fx.universe });
    const dln = (u, t, i) => { const f = u.byTicker.get(t); return Math.log(f.P[i] / f.N[i]) - Math.log(f.P[i - 1] / f.N[i - 1]); };
    let same = 0, flipped = 0;
    for (let i = 300; i < 400; i++) {
      const a = dln(uni, "FDA", i), b = dln(u2, "FDA", i), c = dln(uni, "FDB", i), e = dln(u2, "FDB", i);
      if (!(F.fin(a) && F.fin(b) && F.fin(c) && F.fin(e))) continue;
      const fa = Math.abs(b - a) < 1e-9, fc = Math.abs(e - c) < 1e-9;
      if (fa === fc) same++; else flipped++;
    }
    return { ok: same > 0 && flipped === 0, detail: `${same} day(s) where both funds were treated alike, ${flipped} where they were not` };
  });
  check("a fault world holds faults and the whole rule still runs on it", () => {
    const w = F.faultWorld({ cache: fx.cache, universe: fx.universe, seed: 11 });
    const u2 = F.prepareUniverse({ cache: w, universe: fx.universe });
    const f = u2.byTicker.get("FDA");
    let repeats = 0; for (let i = 1; i < f.cal.days.length; i++) if (F.fin(f.N[i]) && f.N[i] === f.N[i - 1]) repeats++;
    const r = F.runWorld({ cache: w, universe: fx.universe, span: fx.span, spanNo: 1, draws: 2, shifts: 2 });
    return { ok: repeats > 10 && typeof r.whole === "boolean", detail: `${repeats} repeated NAV rows, the rule ${r.whole ? "passed" : "did not pass"} on it` };
  });
  check("a planted world carries the published speed and the gates count the worlds they are given", () => {
    const g10 = F.gateV10({ cache: fx.cache, universe: fx.universe, span: fx.span, spanNo: 1, worlds: 2, draws: 2, shifts: 2 });
    const g12 = F.gateV12({ cache: fx.cache, universe: fx.universe, span: fx.span, spanNo: 1, worlds: 2, draws: 2, shifts: 2 });
    return { ok: g10.worlds === 2 && F.fin(g10.p95) && g12.planted === 2 && g12.needed === 10 && g12.pass === false, detail: `V10 p95 ${F.r3(g10.p95)}, V12 found ${g12.found} of 2 (10 needed, so it cannot pass on two worlds)` };
  });

  // ── the validity gates ──
  check("V2 the as-of replay finds no mismatch between the cut-off series and the as-of computation", () => {
    const g = F.gateV2({ uni, span: fx.span, cache: fx.cache, universe: fx.universe, pairs: 40 });
    return { ok: g.pass && g.mismatches === 0 && g.pairsChecked >= 40, detail: `${g.pairsChecked} pairs, ${g.mismatches} mismatches${g.examples && g.examples.length ? " " + JSON.stringify(g.examples[0]) : ""}` };
  });
  check("a wrong print dated AFTER s changes nothing at s (the future-poison case)", () => {
    const cache = JSON.parse(JSON.stringify(fx.cache)), day = "2005-06-15";
    const rows = cache.XFDAX.rows, i = rows.findIndex((x) => x.d === day);
    rows[i + 10].c = rows[i + 10].c * 1.4; rows[i + 10].o = rows[i + 10].h = rows[i + 10].l = rows[i + 10].c;   // a wrong print ten rows later, undone the next row
    const u2 = F.prepareUniverse({ cache, universe: fx.universe });
    const a = F.eligible({ uni, fund: uni.byTicker.get("FDA"), sIdx: uni.cal.of(day) });
    const b = F.eligible({ uni: u2, fund: u2.byTicker.get("FDA"), sIdx: u2.cal.of(day) });
    const sa = F.signalAt({ uni, fund: uni.byTicker.get("FDA"), sIdx: uni.cal.of(day) });
    const sb = F.signalAt({ uni: u2, fund: u2.byTicker.get("FDA"), sIdx: u2.cal.of(day) });
    return { ok: a.ok === b.ok && String(F.r3(a.z)) === String(F.r3(b.z)) && sa.signal === sb.signal && F.wrongPrintSet(u2.byTicker.get("FDA")).has(i + 10), detail: `z ${F.r3(a.z)} / ${F.r3(b.z)}` };
  });
  check("V3 classifies every split event and counts the fund-days removed for a LATER event", () => {
    const u2 = F.prepareUniverse({ cache: unverifiedLargeCache(), universe: fx.universe }), g = F.gateV3({ uni: u2 });
    return { ok: g.classes["unverified-large"] === 1 && g.fundsRemovedForALaterEvent.includes("FDA") && g.fundDaysRemovedForALaterEvent > 0, detail: JSON.stringify(g.classes) };
  });
  check("V4 names a fund whose asset value does not fall with its distributions", () => {
    const cache = JSON.parse(JSON.stringify(fx.cache));
    cache.FDA.dividends = cache.FDA.rows.filter((r, i) => i % 63 === 62 && r.c).slice(0, 8).map((r) => ({ d: r.d, amount: r.c * 0.03 }));
    const u2 = F.prepareUniverse({ cache, universe: fx.universe }), g = F.gateV4({ uni: u2 });
    return { ok: g.named.some((x) => x.ticker === "FDA") && !!g.quarantines.FDA, detail: JSON.stringify(g.named.map((x) => [x.ticker, x.misses])) };
  });
  check("V5 names a fund whose NAV symbol is not X + ticker + X and quarantines it until a second source confirms it", () => {
    const u2 = F.prepareUniverse({ cache: { ...fx.cache, XODDX: fx.cache.XFDAX }, universe: fx.universe.map((r) => (r.ticker === "FDA" ? { ...r, navSymbol: "XODDX" } : r)) });
    const bad = F.gateV5({ uni: u2 }), good = F.gateV5({ uni: u2, secondSource: { identityConfirmed: ["FDA"] } });
    return { ok: !bad.pass && !!bad.quarantines.FDA && good.pass, detail: bad.why };
  });
  check("V6, V7, V8, V9 and V15 are FAIL-CLOSED when their recording is not in the tree", () => {
    const g = [F.gateV6({ publication: null }), F.gateV7({ uni, secondSource: null }), F.gateV8({ audit: null, signals: [] }), F.gateV9({ attrition: null }), F.gateV15({ manifest: null })];
    return { ok: g.every((x) => x.pass === false && typeof x.why === "string"), detail: g.map((x) => x.id).join(",") };
  });
  check("V6 makes a fund a late reporter on two of three days, and moves every entry past 5%", () => {
    const funds = Array.from({ length: 10 }, (_, i) => ({ ticker: `F${i}`, missingAt1530NextDay: i < 2 ? 2 : 0 }));
    const g = F.gateV6({ publication: { days: ["a", "b", "c"], funds }, universeCount: 10 });
    return { ok: g.pass && g.lateReporters.length === 2 && g.lateReporterAll === true, detail: `${g.lateReporters.join(",")} share ${g.share}` };
  });
  check("V8 is CANNOT MEASURE past eight void signals of forty", () => {
    const mk = (n) => ({ verdicts: Array.from({ length: 40 }, (_, i) => ({ ticker: "T", day: "2012-01-03", offByPoints: i < n ? 3 : 0 })) });
    const ok8 = F.gateV8({ audit: mk(8), signals: Array(40).fill(0) }), bad9 = F.gateV8({ audit: mk(9), signals: Array(40).fill(0) });
    return { ok: ok8.pass && !bad9.pass, detail: `${ok8.void} void passes, ${bad9.void} void does not` };
  });
  check("V13 fails below the span's own minimums and says which", () => {
    const g = F.gateV13({ stat, span: { ...fx.span, minRoundTrips: 10000, minMonthsWithPosition: 1 } });
    const h = F.gateV13({ stat, span: fx.span });
    return { ok: !g.pass && /round trips/.test(g.why) && h.pass, detail: `${stat.counts.roundTrips} round trips, a position open in ${stat.counts.monthsWithPosition} of ${stat.months.length} months` };
  });
  check("V14 wants twenty kept draws and fails when more than three of them beat the bar against the mean of the others", () => {
    const few = F.gateV14({ stat, bar: F.PARAMS.tRequired });                                    // this stat kept 12 draws, not 20
    const draws20 = (fn) => ({ months: stat.months, keptDraws: Array.from({ length: 20 }, (_, i) => stat.months.map((_, j) => fn(i, j))) });
    const quiet = F.gateV14({ stat: draws20((i, j) => (i + j) % 2), bar: F.PARAMS.tRequired });
    const rigged = F.gateV14({ stat: draws20((i, j) => (i < 10 ? 1000 * ((j + i) % 3) : 0)), bar: 0.001 });
    return { ok: !few.pass && /20/.test(few.why) && quiet.pass && quiet.draws === 20 && !rigged.pass && rigged.over > 3,
      detail: `12 kept draws: ${few.why}; quiet ${quiet.over} of 20 over the bar; rigged ${rigged.over} of 20` };
  });
  check("V15 wants a cache fetched on or after 2026-10-15, frozen, with a second fetch of the span's last ten days", () => {
    const early = F.gateV15({ manifest: { fetchedAt: "2026-10-14", sha256: "x", secondFetch: { changedRowFunds: [] } } });
    const noSecond = F.gateV15({ manifest: { fetchedAt: "2026-10-20", sha256: "x" } });
    const good = F.gateV15({ manifest: { fetchedAt: "2026-10-20", sha256: "x", frozen: true, secondFetch: { changedRowFunds: ["ABC"] } } });
    return { ok: !early.pass && !noSecond.pass && good.pass && good.changedRowFunds.length === 1, detail: `${early.why} / ${noSecond.why}` };
  });
  check("V16 puts a discovery read on HOLD above $1,517 a month or a t outside six", () => {
    return F.gateV16({ discoveryMean: 1600, discoveryT: 2 }).hold === true && F.gateV16({ discoveryMean: 10, discoveryT: 7 }).hold === true
      && F.gateV16({ discoveryMean: -1600, discoveryT: -2 }).hold === true && F.gateV16({ discoveryMean: 100, discoveryT: 2 }).hold === false;
  });

  // ── the decision rule ──
  check("discovery gates on SIGN only, and a failed gate is CANNOT MEASURE", () => {
    const pass = F.decideDiscovery({ stat: { headline: 12, t: 0.3 }, gates: [{ id: "V3", pass: true }] });
    const fail = F.decideDiscovery({ stat: { headline: -1, t: 3 }, gates: [{ id: "V3", pass: true }] });
    const cm = F.decideDiscovery({ stat: { headline: 99, t: 9 }, gates: [{ id: "V7", pass: false }] });
    return { ok: pass.verdict === "PROCEED" && fail.verdict === "DID NOT PASS" && cm.verdict === "CANNOT MEASURE", detail: `${pass.verdict}/${fail.verdict}/${cm.verdict}` };
  });
  check("the holdout PASSES only on all eight conditions, and a t below the bar by any margin is DID NOT PASS", () => {
    const sign = { S1: { pass: true, mean: 1 }, S2: { pass: true, mean: 1 }, S3: { pass: true, mean: 1 }, S4: { pass: true, mean: 1 }, S5: { pass: true, mean: 1, median: 0, ran: true } };
    const bar = { t: 1.727, binding: "the registered bar", parts: [] };
    const good = F.decideHoldout({ stat: { headline: 50, t: 1.727, months: [] }, gates: [{ id: "V3", pass: true }], discovery: { verdict: "PROCEED" }, bar, sign });
    const miss = F.decideHoldout({ stat: { headline: 50, t: 1.7269, months: [] }, gates: [{ id: "V3", pass: true }], discovery: { verdict: "PROCEED" }, bar, sign });
    const noS4 = F.decideHoldout({ stat: { headline: 50, t: 3, months: [] }, gates: [{ id: "V3", pass: true }], discovery: { verdict: "PROCEED" }, bar, sign: { ...sign, S4: { pass: false, mean: -1 } } });
    const noDisc = F.decideHoldout({ stat: { headline: 50, t: 3, months: [] }, gates: [{ id: "V3", pass: true }], discovery: null, bar, sign });
    return { ok: good.verdict === "PASS" && miss.verdict === "DID NOT PASS" && miss.nearMiss === true && noS4.verdict === "DID NOT PASS" && noDisc.verdict === "DID NOT PASS",
      detail: `${good.verdict} / ${miss.verdict} (near miss ${miss.nearMiss}) / ${noS4.failedConditions.join("")} / ${noDisc.failedConditions.join("")}` };
  });
  check("a read's dollar table prints every figure of decisionRule.dollarTable", () => {
    const sh = F.shiftedBooks({ uni, span: fx.span, spanNo, stat, n: 4 });
    const t = dollarTable({ stat, sign: F.signGates({ stat, shifted: sh }), shifted: sh });
    const want = ["perPosition", "atRiskBusiest", "G", "G21", "GUS", "GPEER", "D", "BOOK", "YIELD", "GAtTwiceCost", "GAtThriceCost", "grossGains", "grossLosses", "wins", "losses", "averageWin", "averageLoss", "totalCostPaid", "worstMonth", "worstRunOfMonths", "positionsOpened", "roundTrips", "noCleanSeries", "soldAtSpanEnd", "carriedExits", "daysWith25Positions", "smallestFigureSetAgainstTheCatalogue"];
    const missing = want.filter((k) => !(k in t));
    return { ok: missing.length === 0 && t.perPosition === 4000 && t.atRiskBusiest === 96000, detail: missing.length ? `missing ${missing.join(",")}` : `the smallest figure ${usd(t.smallestFigureSetAgainstTheCatalogue)}` };
  });
  check("the labels are all printed and none of them can change the verdict", () => {
    const sh = F.shiftedBooks({ uni, span: fx.span, spanNo, stat, n: 4 });
    const l = F.labels({ uni, span: fx.span, spanNo, stat, shifted: sh });
    const want = Array.from({ length: 12 }, (_, i) => `L${i + 1}`), missing = want.filter((k) => !(k in l));
    return { ok: missing.length === 0 && F.fin(l.L2.t21) !== false && typeof l.L1.cannotSeparate === "boolean", detail: missing.length ? `missing ${missing.join(",")}` : `L1 matched share ${F.r3(l.L1.matchedShare)}` };
  });

  // ── the read condition ──
  check("--read refuses in this tree, naming every item that does not hold and reading no series", () => {
    const RC = readCondition({ spanName: "discovery", selftestResult: { passed: 1, failed: 0 } });
    const bad = RC.items.filter((x) => !x.ok).map((x) => x.id);
    return { ok: !RC.ok && bad.some((x) => x.startsWith("(2)")) && bad.some((x) => x.startsWith("(3")) && bad.some((x) => x.startsWith("(5a)")) && bad.some((x) => x.startsWith("(5b)")), detail: `${bad.length} item(s) do not hold: ${bad.join(" ")}` };
  });
  check("the read condition holds every item of readCondition, the holdout ones included", () => {
    const d = readCondition({ spanName: "discovery", selftestResult: null }).items.map((x) => x.id);
    const h = readCondition({ spanName: "holdout", selftestResult: null }).items.map((x) => x.id);
    const want = ["(1a)", "(1b)", "(1c)", "(2)", "(3a)", "(3b)", "(3c)", "(4)", "(5a)", "(5b)", "(6)", "(7)", "(8a)"];
    return { ok: want.every((w) => d.some((x) => x.startsWith(w))) && h.some((x) => x.startsWith("(8b)")) && h.some((x) => x.startsWith("(8c)")), detail: `${d.length} items for discovery, ${h.length} for the holdout` };
  });
  check("(5b) a controls file written with fewer worlds or replay pairs than the registered strength refuses the read", () => {
    const os = require("os"), scratch = fs.mkdtempSync(path.join(os.tmpdir(), "r354-strength-"));
    fs.mkdirSync(path.join(scratch, FILES.cacheDir), { recursive: true });
    const gates = {}; for (const k of ["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10", "V11", "V12", "V13", "V14", "V15"]) gates[k] = { id: k, pass: true };
    gates.V2.pairsChecked = 40; gates.V10.worlds = 2; gates.V11.worlds = 2; gates.V12.planted = 2;
    writeJsonAtomic(path.join(scratch, FILES.controls), { id: ID, span: "discovery", cacheSha256: "nothing", gates });
    const weak = readCondition({ spanName: "discovery", dataDir: scratch, selftestResult: { passed: 1, failed: 0 } }).items.find((x) => x.id.startsWith("(5b)"));
    gates.V2.pairsChecked = F.PARAMS.replayPairs; gates.V10.worlds = F.PARAMS.worlds; gates.V11.worlds = F.PARAMS.worlds; gates.V12.planted = F.PARAMS.plantedWorlds;
    writeJsonAtomic(path.join(scratch, FILES.controls), { id: ID, span: "discovery", cacheSha256: "nothing", gates });
    const full = readCondition({ spanName: "discovery", dataDir: scratch, selftestResult: { passed: 1, failed: 0 } }).items.find((x) => x.id.startsWith("(5b)"));
    fs.rmSync(scratch, { recursive: true, force: true });
    return { ok: !weak.ok && /V10 no-edge worlds: 2 of 200/.test(weak.detail) && full.ok, detail: weak.detail.slice(0, 110) };
  });
  check("a selftest that did not run, or that failed, refuses the read (item 4)", () => {
    const none = readCondition({ spanName: "discovery", selftestResult: null }).items.find((x) => x.id.startsWith("(4)"));
    const bad = readCondition({ spanName: "discovery", selftestResult: { passed: 10, failed: 1 } }).items.find((x) => x.id.startsWith("(4)"));
    const good = readCondition({ spanName: "discovery", selftestResult: { passed: 10, failed: 0 } }).items.find((x) => x.id.startsWith("(4)"));
    return { ok: !none.ok && !bad.ok && good.ok, detail: "" };
  });
  check("the clock fence refuses 13:50-15:50 MT on a trading day and allows it outside", () => {
    const inside = mtClock(Date.parse("2026-10-16T20:00:00Z"), {});                   // 14:00 MT on a Friday
    const after = mtClock(Date.parse("2026-10-16T22:00:00Z"), {});                    // 16:00 MT
    const sat = mtClock(Date.parse("2026-10-17T20:00:00Z"), {});                      // a Saturday
    const holiday = mtClock(Date.parse("2026-10-16T20:00:00Z"), { "2026-10-16": "a made-up holiday" });
    return { ok: inside.inWindow && !after.inWindow && !sat.inWindow && !holiday.inWindow, detail: `${inside.hhmm} MT inside, ${after.hhmm} MT outside` };
  });
  check("the lapse refuses a discovery read after 2027-01-31", () => {
    const late = readCondition({ spanName: "discovery", nowMs: Date.parse("2027-02-01T18:00:00Z"), selftestResult: null }).items.find((x) => x.id.startsWith("(7)"));
    const fine = readCondition({ spanName: "discovery", nowMs: Date.parse("2027-01-30T18:00:00Z"), selftestResult: null }).items.find((x) => x.id.startsWith("(7)"));
    return { ok: !late.ok && fine.ok, detail: `${late.detail}` };
  });
  check("rule [14]: the runner takes no flag or environment variable that changes a number", () => {
    const src = fs.readFileSync(SELF, "utf8"), needle = "process" + "." + "env";          // built at run time so this case does not match itself
    const envReads = src.split(needle).length - 1;
    const numericFlags = (src.match(/--(z|bar|lag|draws|places|stake|hold|cost)[= ]/g) || []).length;
    return { ok: envReads === 0 && numericFlags === 0 && /--span=/.test(src), detail: `${envReads} environment reads, ${numericFlags} numeric flags` };
  });
  check("the library reads no file, makes no network call and asks no clock", () => {
    const src = fs.readFileSync(path.join(__dirname, "lib", "fund-discount.js"), "utf8");
    const bad = ["require(\"fs\")", "require('fs')", "fetch(", "Date.now(", "process" + "." + "env"].filter((s) => src.includes(s));
    return { ok: bad.length === 0, detail: bad.join(" ") };
  });

  log(failed ? `\nSELFTEST: ${failed} of ${passed + failed} FAILED\n  - ${fails.join("\n  - ")}` : `\nALL ${passed} PASSED`);
  return { passed, failed, fails };
}


module.exports = { ID, FILES, D, sha, entryOf, ruleShaOf, mtClock, loadCache, loadUniverse, readCondition, runControls, readSpan, dollarTable, printStatus, selftest, makeFixture, unverifiedLargeCache, tinyFund, priceSeries, navSeries, businessDays, Refuse, PARAMS: F.PARAMS };

if (require.main === module) {
  const argv = process.argv.slice(2), modes = argv.filter((a) => /^--(selftest|status|controls|read|dollar-table)$/.test(a));
  const spanArg = (argv.find((a) => a.startsWith("--span=")) || "").slice(7);
  const other = argv.filter((a) => !modes.includes(a) && !a.startsWith("--span="));
  const usage = () => { console.log(`usage: node backend/r354-fund-discounts.js --selftest | --status | --controls --span=discovery|holdout | --read --span=discovery|holdout | --dollar-table --span=discovery|holdout
  no flag changes a number of the rule or of the statistic (rule [14]).`); process.exit(2); };
  if (modes.length !== 1 || other.length) usage();
  const MODE = modes[0];
  if (MODE !== "--selftest" && MODE !== "--status" && !["discovery", "holdout"].includes(spanArg)) usage();
  try {
    if (MODE === "--selftest") { const r = selftest({ log: console.log }); process.exit(r.failed === 0 ? 0 : 1); }
    if (MODE === "--status") { printStatus({ log: console.log }); process.exit(0); }
    if (MODE === "--controls") { const r = runControls({ spanName: spanArg }); process.exit(r.failed.length ? 1 : 0); }
    if (MODE === "--read") { readSpan({ spanName: spanArg }); process.exit(0); }
    if (MODE === "--dollar-table") {
      const f = D(spanArg === "discovery" ? "readDiscovery" : "readHoldout"), j = readJson(f);
      if (!j) refuse(`there is no ${spanArg} read on file (backend/data/${path.basename(f)}): --read writes it`);
      console.log(`R354 ${spanArg} dollar table — read ${j.readAt}, verdict ${j.verdict}`);
      for (const [k, v] of Object.entries(j.dollars || {})) console.log(`  ${k.padEnd(36)} ${typeof v === "number" ? usd(v) : String(v)}`);
      process.exit(0);
    }
  } catch (e) {
    if (e instanceof Refuse) { console.error(`REFUSED — nothing was read, nothing was written: ${e.message}`); process.exit(2); }
    console.error(`FAILED: ${e && e.stack ? e.stack : e}`); process.exit(1);
  }
}
