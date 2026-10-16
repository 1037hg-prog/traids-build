#!/usr/bin/env node
"use strict";
/**
 * INSIDER CLUSTERS (2026-10-16) — SELFTEST. Known answers for everything this package builds.
 *
 *   node docs/insider-clusters/2026-10-16/selftest.cjs
 *
 * It writes nothing in the repository (scratch trees in the OS temp folder only), makes NO network call of any kind (harness/no-net.cjs
 * is its first require, so every fetch and socket of this process is refused, and the collector's fetcher is harness/fixture-fetch.cjs
 * reading the saved fixture filings), reads no key, and places no order. Last line: "ALL <n> CHECKS PASSED", or the failures and exit 1.
 *
 *   A  the package: every staged file's sha256 against deploy.cjs, node --check, the fixture tree against its own builder, and the
 *      repository's own rules (no key, no address, no person's name, no network call of its own, the clock and the fetcher injected)
 *   B  sec-fetch's pure parts: the User-Agent the SEC asks for (missing / short / long / a line break / a placeholder / a browser
 *      string / good), the host allowlist, Retry-After, and the limiter on a fake clock — 400 calls never exceed ten in ANY rolling
 *      second, a hold stops every call, a slot past the budget is refused, a rate above ten is refused
 *   C  sec-fetch over the fixture fetcher: a 200; a 404 is an ANSWER and is not retried; a 403 stops at once (the UA block); a 429
 *      with Retry-After holds then succeeds; a 5xx, a timeout and an unreadable answer are retried then reported failed; a missing
 *      injected fetcher is refused; the declared User-Agent really is on the request
 *   D  form4-parse on each saved fixture filing: the purchase, the sale / award / exercise, the no-price and preferred rows, the
 *      ten-percent-owner-only filing, the amendment, the joint filing, the truncated one, and the one whose exhibit comes FIRST
 *   E  insider-buys-lib: the per-insider dollars add up to the day's dollars; merging is idempotent and order-independent; the
 *      shrink guard; unreadable lines are reported, not skipped
 *   F  the collector end to end over the fixtures: the nine company-days to the dollar, exit 3 for the day that did not read whole,
 *      a re-run that changes nothing byte for byte, a 503 filing left unresolved, a 404 index on a trading day vs on a weekend,
 *      --dry writing nothing, the write read back
 *   G  the cluster finder's known answers: the AAAA cluster that exists ONLY because Thanksgiving is closed, the BBBB cluster whose
 *      first buy is dated on a Saturday, EEEE's three insiders eleven trading days apart that are NOT a cluster, the spent-day rule,
 *      distinct insiders counted as people, and the calendar refusal outside the holiday table
 *   H  mutation-proof: each of thirty-one mutants of the staged files is caught by a check above
 *   I  deploy and rollback on scratch repos: absent -> staged -> absent, drift refused, a red gate refused
 *   J  record.cjs: --dry on the real repository writes nothing; on scratch data the write, already-recorded and partial cases
 */
require("./harness/no-net.cjs");
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");
const T = require("./harness/tree.cjs"), FX = require("./harness/fixture-fetch.cjs"), FB = require("./fixtures/build-fixtures.cjs");
const D = require("./deploy.cjs"), RB = require("./rollback.cjs"), REC = require("./record.cjs");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const UA = "TRAIDS-selftest insider-buys (operator contact set at home)";
const DAYS = ["2026-11-17", "2026-11-18", "2026-11-25", "2026-12-01"];
const J = (x) => JSON.stringify(x);

let pass = 0, failN = 0; const failed = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; failed.push(name); console.log(`  FAIL ${name}${detail === undefined ? "" : " — " + String(typeof detail === "string" ? detail : J(detail)).slice(0, 700)}`); }
}
const section = (s) => console.log(`\n${s}`);
const tried = (fn) => { try { const v = fn(); return { ok: true, v }; } catch (e) { return { ok: false, why: e.message }; } };
const triedAsync = async (fn) => { try { const v = await fn(); return { ok: true, v }; } catch (e) { return { ok: false, why: e.message }; } };

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// the probe: everything a mutant could change, in one deterministic object. H compares each mutant's probe against the clean one.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** the highest number of calls the limiter allows inside ANY rolling second, over `n` back-to-back takes */
async function burstPeak(SEC, n, perSecond) {
  let ms = 0;
  const lim = SEC.makeLimiter({ perSecond, now: () => ms, sleep: async (d) => { ms += d; } });
  const at = [];
  for (let i = 0; i < n; i++) { await lim.take(); at.push(ms); }
  let peak = 0;
  for (let i = 0; i < at.length; i++) { let c = 0; for (let k = 0; k < at.length; k++) if (at[k] > at[i] - 1000 && at[k] <= at[i]) c++; peak = Math.max(peak, c); }
  return { peak, spanMs: at[at.length - 1] - at[0], stats: lim.stats().taken };
}

/** one collector run over the fixtures into a fresh scratch data folder */
async function collectRun(t, collect, { dates = DAYS, answers = {}, outDir = null, dry = false, collectedOn = "2026-12-01" } = {}) {
  const dir = outDir || fs.mkdtempSync(path.join(os.tmpdir(), "ic-out-"));
  const clock = FX.makeClock(), f = FX.make({ now: clock.now, tick: clock.tick, answers });
  const r = await collect.run({ dates, fetchFn: f.fetchFn, userAgent: UA, outDir: dir, collectedOn, now: clock.now, sleep: clock.sleep, log: () => {}, dry });
  return { ...r, dir, calls: f.calls, byUrl: f.byUrl };
}
/** what a dated-file folder holds, as a comparable object */
function readOut(dir) {
  const BL = require(path.join(REPO, "backend", "lib", "run-window.js")) && null;    // never used: kept out of the probe deliberately
  const out = {};
  for (const n of fs.readdirSync(dir).sort()) {
    const text = fs.readFileSync(path.join(dir, n), "utf8");
    out[n] = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  return out;
}
/** the company-days only, flattened to the numbers a reader cares about */
function dayRows(outByFile) {
  const rows = [];
  for (const file of Object.keys(outByFile).sort()) for (const r of outByFile[file]) {
    if (r.kind !== "company-day") continue;
    rows.push([r.sym, r.tradeDate, r.insiders, r.usd, r.shares, r.roleList.join("+"), r.filings, r.jointFilings, r.byInsider.map((i) => `${i.ownerCik}:${i.role}:${i.usd}`).join(","), r.lastFiledOn]);
  }
  return rows.sort((a, b) => J(a).localeCompare(J(b)));
}
/** the clusters, flattened */
const clusterRows = (cs) => cs.map((c) => [c.sym, c.insiders, c.usd, c.firstBuy, c.triggerBuy, c.lastBuy, c.spanTradingDays, c.publicOn, c.publicLagTradingDays, c.roleList.join("+"), c.offCalendarDays, c.insiderList.map((i) => `${i.ownerCik}:${i.role}:${i.usd}`).join(",")]);

async function probe(t) {
  const SEC = T.load(t, "backend/lib/sec-fetch.js"), P4 = T.load(t, "backend/lib/form4-parse.js");
  const BL = T.load(t, "backend/lib/insider-buys-lib.js"), CL = T.load(t, "backend/lib/insider-cluster-lib.js");
  const collect = T.load(t, "backend/insider-buys-collect.js"), clusters = T.load(t, "backend/insider-clusters.js");
  const HOL = require(path.join(REPO, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS;
  const p = {};

  // --- the pure guards ---
  p.ua = [undefined, "", "short", "x".repeat(201), "TRAIDS\nX-Evil: 1", "TRAIDS REPLACE_ME build", "Mozilla/5.0 (Windows NT)", UA]
    .map((u) => { const r = tried(() => SEC.checkUserAgent(u)); return r.ok ? "ok" : "refused"; });
  p.url = ["https://www.sec.gov/Archives/x.txt", "https://data.sec.gov/api/x", "http://www.sec.gov/Archives/x.txt", "https://not-sec.invalid/Archives/x.txt", "sec.gov/x", "https://www.sec.gov.not-sec.invalid/x"]
    .map((u) => { const r = tried(() => SEC.checkUrl(u)); return r.ok ? "ok" : "refused"; });
  p.rate = [0, -1, 11, 100, 10, 5].map((n) => (tried(() => SEC.makeLimiter({ perSecond: n })).ok ? "ok" : "refused"));
  p.retryAfter = [["30", 30000], ["0", 0], ["99999", 120000], [null, null], ["not a date", null], ["Tue, 01 Dec 2026 22:00:30 GMT", 30000], ["Tue, 01 Dec 2026 21:00:00 GMT", 0]]
    .map(([v]) => SEC.retryAfterMs(v, Date.parse("2026-12-01T22:00:00Z")));
  p.burst10 = await burstPeak(SEC, 400, 10);
  p.burst3 = await burstPeak(SEC, 20, 3);
  p.noFetcher = tried(() => SEC.makeSecFetcher({ userAgent: UA })).ok ? "ok" : "refused";
  // a 403 on sec.gov is the User-Agent block: it must stop at once, after exactly one request
  { const c = FX.makeClock(), f = FX.make({ now: c.now, tick: c.tick, answers: { [FB.acc(1)]: { status: 403 } } });
    const sec = SEC.makeSecFetcher({ fetchFn: f.fetchFn, userAgent: UA, now: c.now, sleep: c.sleep, log: () => {} });
    const r = await triedAsync(() => sec.get(`https://www.sec.gov/Archives/edgar/data/1000001/${FB.acc(1)}.txt`));
    p.forbidden = { threw: !r.ok, mentionsUa: !r.ok && /User-Agent/.test(r.why), requests: f.calls.length }; }

  // --- the parser on each fixture ---
  const fx = (n) => fs.readFileSync(path.join(PKG, "fixtures", "filings", `${FB.acc(n)}.txt`), "utf8");
  p.parse = {};
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]) {
    const r = P4.parseForm4(fx(n));
    p.parse[n] = r.ok
      ? [r.documentType, r.amendment, r.issuer.symbol, r.qualifyingOwners.map((o) => `${o.cik}:${o.role}`).join(","), r.buys.map((b) => `${b.tradeDate}:${b.shares}:${b.usd}:${b.usdPerOwner}`).join(","), J(r.excluded), r.jointFiling]
      : ["unreadable", r.why];
  }

  // --- the collector over the fixtures ---
  const clean = await collectRun(t, collect);
  p.collect = { code: clean.code, rows: dayRows(readOut(clean.dir)), requests: clean.calls.length, uaSent: [...new Set(clean.calls.map((c) => c.ua))] };
  p.runLines = Object.values(readOut(clean.dir)).flat().filter((r) => r.kind === "run")
    .map((r) => [r.filingDay, r.tradingDay, r.index.found, r.filings.listed, r.filings.read, r.filings.purchases, r.filings.amendments, r.filings.noPurchase, r.filings.notOfficerOrDirector, r.filings.unreadable, r.filings.unfetched, r.unresolved.length, r.complete]);

  // a re-run of the same days over the same folder must leave every COMPANY-DAY line byte for byte as it was. (The run line is new
  // each run by design: it says what THAT run asked and read, and that is the record of a partial read.)
  const dayBytes = (dir) => fs.readdirSync(dir).sort().map((n) => sha(Buffer.from(fs.readFileSync(path.join(dir, n), "utf8").split("\n").filter((l) => l.includes('"kind":"company-day"')).join("\n"))));
  const before = dayBytes(clean.dir);
  const again = await collectRun(t, collect, { outDir: clean.dir });
  p.rerun = {
    same: J(before) === J(dayBytes(clean.dir)),
    added: again.days.reduce((s, d) => s + (d.merged ? d.merged.added : 0), 0),
    updated: again.days.reduce((s, d) => s + (d.merged ? d.merged.updated : 0), 0),
    unchanged: again.days.reduce((s, d) => s + (d.merged ? d.merged.unchanged : 0), 0),
  };

  // one filing answered 503 on every try: unresolved, and no company-day for it
  const sick = await collectRun(t, collect, { dates: ["2026-11-25"], answers: { [FB.acc(17)]: { status: 503 } } });
  p.filing503 = { code: sick.code, rows: dayRows(readOut(sick.dir)).length, unresolved: sick.days[0].day.unresolved.map((u) => `${u.accession}:${u.why.slice(0, 20)}`) };

  // the index 404: a weekend is the expected answer; a trading day is a failed read
  const sat = await collectRun(t, collect, { dates: ["2026-11-21"] });
  const trading404 = await collectRun(t, collect, { dates: ["2026-11-19"] });
  p.index404 = { weekendCode: sat.code, weekendUnresolved: sat.days[0].day.unresolved.length, tradingCode: trading404.code, tradingUnresolved: trading404.days[0].day.unresolved.length };

  // --dry writes nothing
  const dryDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-dry-"));
  const dry = await collectRun(t, collect, { outDir: dryDir, dry: true });
  p.dry = { code: dry.code, files: fs.existsSync(dryDir) ? fs.readdirSync(dryDir).length : -1 };

  // a company-day in the file that THIS run did not see is kept, not dropped — a dated file is a record, not a snapshot of one run
  const keepDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-keep-"));
  {
    const rows = fs.readFileSync(path.join(clean.dir, "insider-buys-2026-11-18.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const other = { ...rows[0], cik: "0001099999", sym: "ZZZZ", tradeDate: "2026-11-12" };
    fs.writeFileSync(path.join(keepDir, "insider-buys-2026-11-18.jsonl"), [J(rows[0]), J(other), J(rows[rows.length - 1])].join("\n") + "\n");
  }
  const kept = await collectRun(t, collect, { dates: ["2026-11-18"], outDir: keepDir });
  p.keepsOthers = { code: kept.code, zzzz: readOut(keepDir)["insider-buys-2026-11-18.jsonl"].filter((r) => r.sym === "ZZZZ").length, unchanged: kept.days[0].merged ? kept.days[0].merged.unchanged : null };

  // the shrink guard, where it can really fire: a company-day in the file DAMAGED by hand (a filing entry naming no reporting
  // owner) cannot be merged, so the write would lose it — the run refuses and leaves the file exactly as it is
  const shrinkDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-shrink-"));
  let shrinkBefore = null;
  {
    const rows = fs.readFileSync(path.join(clean.dir, "insider-buys-2026-11-18.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const damaged = { ...rows[0], cik: "0001099999", sym: "ZZZZ", tradeDate: "2026-11-12", accessions: [{ accession: "0009000001-26-099999", filedOn: "2026-11-12", usd: 1, shares: 1, owners: [] }] };
    fs.writeFileSync(path.join(shrinkDir, "insider-buys-2026-11-18.jsonl"), [J(rows[0]), J(damaged), J(rows[rows.length - 1])].join("\n") + "\n");
    shrinkBefore = sha(fs.readFileSync(path.join(shrinkDir, "insider-buys-2026-11-18.jsonl")));
  }
  const refused = await collectRun(t, collect, { dates: ["2026-11-18"], outDir: shrinkDir });
  p.shrink = {
    code: refused.code,
    refused: refused.days[0].refused || null,
    untouched: sha(fs.readFileSync(path.join(shrinkDir, "insider-buys-2026-11-18.jsonl"))) === shrinkBefore,
    said: refused.lines.some((l) => /never shrinks its own history/.test(l)),
  };
  // and the guard itself, held to a known answer rather than only to a case that should not happen
  p.lostDaysOf = [
    BL.lostDaysOf([{ cik: "a", tradeDate: "2026-11-16" }, { cik: "b", tradeDate: "2026-11-16" }], [{ cik: "a", tradeDate: "2026-11-16" }]),
    BL.lostDaysOf([{ cik: "a", tradeDate: "2026-11-16" }], [{ cik: "a", tradeDate: "2026-11-16" }, { cik: "b", tradeDate: "2026-11-17" }]),
  ];
  p.unmergeable = (() => {
    const good = { spec: "insider-buys-v1", kind: "company-day", cik: "a", tradeDate: "2026-11-16", insiders: 1, accessions: [{ accession: "x", owners: ["o"], usd: 1, shares: 1 }], byInsider: [{ ownerCik: "o", role: "officer", usd: 1, shares: 1, accessions: ["x"] }] };
    const bad = { ...good, cik: "b", accessions: [{ accession: "y", owners: [], usd: 1, shares: 1 }] };
    const r = BL.mergeJsonl([J(good), J(bad)].join("\n") + "\n", []);
    return [r.unmergeable.length, r.unmergeable[0] && r.unmergeable[0].key, r.lostDays.length, r.records.length];
  })();

  // the lib's own invariants
  const recs = Object.values(readOut(clean.dir)).flat().filter((r) => r.kind === "company-day");
  p.libAddsUp = recs.every((r) => Math.abs(r.byInsider.reduce((s, i) => s + i.usd, 0) - r.usd) < 0.005);
  p.libIdempotent = recs.every((r) => J(BL.mergeDay(r, r)) === J(r));
  p.libAddTwice = (() => {
    const day = BL.emptyDay("0001000001", "2026-11-16"), f = { accession: "a-1", filedOn: "2026-11-17", sym: "AAAA", issuer: "X", owners: [{ cik: "o1", role: "officer" }], usd: 100, shares: 10 };
    const first = BL.addFiling(day, f), second = BL.addFiling(day, f), fin = BL.finalizeDay(day, { collectedOn: "2026-12-01" });
    return [first.added, second.added, fin.usd, fin.filings, fin.insiders];
  })();
  p.libOrder = (() => {
    const two = recs.filter((r) => r.cik === "0001000001" && r.tradeDate === "2026-11-16");
    const a = BL.mergeDays([...recs]), b = BL.mergeDays([...recs].reverse()), c = BL.mergeDays([...recs, ...two]);
    return [J(a) === J(b), J(a) === J(c), a.length];
  })();
  p.libBad = (() => { const r = BL.parseJsonl('{"spec":"insider-buys-v1","kind":"company-day","cik":"1","tradeDate":"2026-11-16","insiders":1}\n{bad\n{"spec":"other"}\n'); return [r.records.length, r.bad.length]; })();
  p.libShrinkReported = BL.mergeJsonl('{"spec":"insider-buys-v1","kind":"company-day","cik":"1","tradeDate":"2026-11-16","insiders":1,"accessions":[{"accession":"a","owners":["x"],"usd":1,"shares":1}],"byInsider":[{"ownerCik":"x","role":"officer","usd":1,"shares":1,"accessions":["a"]}]}\n', []).lostDays.length;

  // --- the cluster finder ---
  const run1 = clusters.run({ inDir: clean.dir, outDir: fs.mkdtempSync(path.join(os.tmpdir(), "ic-cl-")), asOf: "2026-12-02", dry: true, print: false, log: () => {} });
  p.clusters = { code: run1.code, rows: clusterRows(run1.out.clusters), summary: [run1.out.summary.issuers, run1.out.summary.companyDays, run1.out.summary.insiderCompanyPairs, run1.out.summary.clusters, run1.out.summary.calendar.tradingDays, run1.out.summary.calendar.holidaysInRange, run1.out.summary.calendar.uncovered] };
  p.incomplete = run1.out.source.incompleteFilingDays.map((d) => d.filingDay);
  // the Thanksgiving check: take the holiday out and the AAAA cluster must disappear
  const noTg = { ...HOL }; delete noTg["2026-11-26"];
  const run2 = clusters.run({ inDir: clean.dir, outDir: fs.mkdtempSync(path.join(os.tmpdir(), "ic-cl2-")), holidays: noTg, asOf: "2026-12-02", dry: true, print: false, log: () => {} });
  p.clustersNoThanksgiving = clusterRows(run2.out.clusters);
  // two insiders is a different question; a per-insider floor drops one; a total floor drops a cluster
  const run3 = clusters.run({ inDir: clean.dir, outDir: fs.mkdtempSync(path.join(os.tmpdir(), "ic-cl3-")), minInsiders: 2, asOf: "2026-12-02", dry: true, print: false, log: () => {} });
  p.clustersMin2 = clusterRows(run3.out.clusters).map((r) => [r[0], r[1], r[2], r[4]]);
  const run4 = clusters.run({ inDir: clean.dir, outDir: fs.mkdtempSync(path.join(os.tmpdir(), "ic-cl4-")), minUsdPerInsider: 5000, asOf: "2026-12-02", dry: true, print: false, log: () => {} });
  p.clustersMinUsd = clusterRows(run4.out.clusters).map((r) => [r[0], r[1], r[2]]);
  const run5 = clusters.run({ inDir: clean.dir, outDir: fs.mkdtempSync(path.join(os.tmpdir(), "ic-cl5-")), minUsdTotal: 10000, asOf: "2026-12-02", dry: true, print: false, log: () => {} });
  p.clustersMinTotal = clusterRows(run5.out.clusters).map((r) => [r[0], r[1], r[2]]);
  // the calendar: a range the holiday table does not cover is refused, and allowed deliberately it is MARKED
  p.calRefusal = tried(() => CL.tradingCalendar({ from: "2019-01-02", to: "2019-02-01", holidays: HOL })).ok ? "ok" : "refused";
  p.calAllowed = tried(() => CL.tradingCalendar({ from: "2019-01-02", to: "2019-02-01", holidays: HOL, allowUncovered: true }));
  p.calAllowedMarked = p.calAllowed.ok ? p.calAllowed.v.uncovered : null;
  p.calAllowed = p.calAllowed.ok ? "ok" : "refused";
  p.calEmpty = tried(() => CL.tradingCalendar({ from: "2026-11-16", to: "2026-12-01", holidays: {} })).ok ? "ok" : "refused";
  // the window, counted on the calendar itself
  {
    const cal = CL.tradingCalendar({ from: "2026-11-09", to: "2026-12-11", holidays: HOL });
    p.calIndex = ["2026-11-16", "2026-11-17", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-30", "2026-12-01"].map((d) => { const x = cal.place(d); return x ? `${d}->${x.index}${x.offCalendar ? "*" : ""}` : `${d}->none`; });
    p.satPlacement = J(cal.place("2026-11-21"));
  }
  // one write, read back
  const wdir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-w-"));
  const wrote = clusters.run({ inDir: clean.dir, outDir: wdir, asOf: "2026-12-02", print: false, log: () => {} });
  p.write = { code: wrote.code, file: path.basename(wrote.file), clusters: JSON.parse(fs.readFileSync(wrote.file, "utf8")).clusters.length, grades: JSON.parse(fs.readFileSync(wrote.file, "utf8")).grades };
  // an empty / absent input folder is a refusal, not an empty answer
  p.noInput = clusters.run({ inDir: path.join(wdir, "nope"), outDir: wdir, print: false, log: () => {} }).code;
  p.emptyInput = clusters.run({ inDir: fs.mkdtempSync(path.join(os.tmpdir(), "ic-e-")), outDir: wdir, print: false, log: () => {} }).code;

  for (const d of [clean.dir, sick.dir, sat.dir, trading404.dir, dryDir, keepDir, shrinkDir, wdir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
  return p;
}

(async () => {
  // ── A. the package ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("A. the package");
  for (const f of D.FILES) {
    const p = path.join(PKG, f.staged);
    const have = fs.existsSync(p) ? sha(fs.readFileSync(p)) : null;
    ok(`A1 ${f.rel}: the staged copy is the reviewed bytes (sha ${f.stagedSha.slice(0, 12)})`, have === f.stagedSha, have);
  }
  ok("A2 every staged file is NEW at home (this package replaces nothing, so base/ holds no bytes)", D.FILES.every((f) => f.baseSha === null), D.FILES.map((f) => f.baseSha));
  for (const f of D.FILES) {
    const c = cp.spawnSync(process.execPath, ["--check", path.join(PKG, f.staged)], { encoding: "utf8", windowsHide: true });
    ok(`A3 node --check ${f.rel}`, c.status === 0, c.stderr);
  }
  { const r = FB.check(); ok(`A4 all ${r.total} saved fixture files are byte-identical to fixtures/build-fixtures.cjs (a doctored fixture fails here)`, r.ok, { differ: r.differ, missing: r.missing, extra: r.extra }); }
  { const staged = D.FILES.map((f) => fs.readFileSync(path.join(PKG, f.staged), "utf8")).join("\n");
    const fixtures = [...FB.files().keys()].map((rel) => fs.readFileSync(path.join(PKG, "fixtures", ...rel.split("/")), "utf8")).join("\n");
    const all = staged + "\n" + fixtures + "\n" + [ "selftest.cjs", "deploy.cjs", "rollback.cjs", "record.cjs", "harness/tree.cjs", "harness/fixture-fetch.cjs", "harness/no-net.cjs", "fixtures/build-fixtures.cjs" ].map((n) => fs.readFileSync(path.join(PKG, n), "utf8")).join("\n");
    const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, PHONE = /\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g;
    const KEYISH = /\b(api[_-]?key|secret|password|passwd|token|bearer|authorization)\b\s*[:=]\s*["'][^"']{6,}/gi;
    const IP = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
    ok("A5 no email address, phone number, IP address or key-shaped assignment anywhere in this package", !EMAIL.test(all) && !PHONE.test(all) && !KEYISH.test(all) && !IP.test(all),
      { email: (all.match(EMAIL) || []).slice(0, 3), phone: (all.match(PHONE) || []).slice(0, 3), keyish: (all.match(KEYISH) || []).slice(0, 2), ip: (all.match(IP) || []).slice(0, 3) }); }
  { // the CODE of each staged file, with its comments taken out — a claim about what the code does must be read from the code
    const codeOnly = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");
    const staged = Object.fromEntries(D.FILES.map((f) => [f.rel, codeOnly(fs.readFileSync(path.join(PKG, f.staged), "utf8"))]));
    const sec = staged["backend/lib/sec-fetch.js"];
    ok("A6 sec-fetch.js NEVER reaches for a global fetch: its one call site is the injected fetchFn, and a missing one is refused",
      !/globalThis\.fetch/.test(sec) && (sec.match(/(?<!Fn)\bfetch\(/g) || []).length === 0 && (sec.match(/\bfetchFn\(/g) || []).length === 1 && /typeof fetchFn !== "function"/.test(sec),
      { globalThis: /globalThis\.fetch/.test(sec), fetch: (sec.match(/(?<!Fn)\bfetch\(/g) || []).length, fetchFn: (sec.match(/\bfetchFn\(/g) || []).length });
    const collector = staged["backend/insider-buys-collect.js"];
    ok("A7 only the collector's CLI hands the real fetch in (one place, where it can be read); nothing else in the package does",
      (collector.match(/globalThis\.fetch/g) || []).length === 1 && /require\.main === module/.test(collector) && collector.indexOf("require.main === module") < collector.indexOf("globalThis.fetch")
      && D.FILES.filter((f) => f.rel !== "backend/insider-buys-collect.js").every((f) => !/globalThis\.fetch|\bfetch\(/.test(staged[f.rel])),
      (collector.match(/globalThis\.fetch/g) || []).length);
    const PURE = ["backend/lib/form4-parse.js", "backend/lib/insider-buys-lib.js", "backend/lib/insider-cluster-lib.js"];
    ok("A8 the pure libraries hold no clock of their own, no disk read and no require of anything but each other",
      PURE.every((r) => !/require\(|Date\.now\(\)|new Date\(\)/.test(staged[r])), PURE.filter((r) => /require\(|Date\.now\(\)|new Date\(\)/.test(staged[r])));
    ok("A9 no order, no broker, no key, and every write goes through backend/lib/atomic-write.js",
      !/placeOrder|submitOrder|alpaca|tastytrade|schwab|ALPACA_|process\.env\.(?!SEC_USER_AGENT)/i.test(Object.values(staged).join("\n"))
      && /writeTextAtomic/.test(collector) && /writeJsonAtomic/.test(staged["backend/insider-clusters.js"])
      && !/writeFileSync|appendFileSync/.test(Object.values(staged).join("\n")),
      Object.values(staged).join("\n").match(/writeFileSync|appendFileSync/g));
    ok("A10 no staged file requires automation/close-chain.cjs (it runs the nightly chain)", !/close-chain/.test(Object.values(staged).join("\n")));
    ok("A11 the collector refuses a rate above the SEC's ten a second, and defaults to it", /MAX_PER_SECOND/.test(collector) && /perSecond > MAX_PER_SECOND/.test(sec) && /const MAX_PER_SECOND = 10\b/.test(sec)); }

  // ── the clean probe: everything below is measured against it ───────────────────────────────────────────────────────────────
  const t0 = T.makeTree();
  const P = await probe(t0);

  // ── B. sec-fetch's pure parts ──────────────────────────────────────────────────────────────────────────────────────────────
  section("B. sec-fetch: the User-Agent, the host allowlist, Retry-After, the limiter");
  ok("B1 the User-Agent: missing, empty, too short, too long, a line break, a placeholder and a browser string are all REFUSED; a declared one passes",
    J(P.ua) === J(["refused", "refused", "refused", "refused", "refused", "refused", "refused", "ok"]), P.ua);
  ok("B2 the host allowlist: https www.sec.gov and data.sec.gov pass; plain http, another host, a non-URL and a look-alike host are REFUSED",
    J(P.url) === J(["ok", "ok", "refused", "refused", "refused", "refused"]), P.url);
  ok("B3 the rate: 0, a negative, 11 and 100 a second are REFUSED; 10 and 5 pass (the SEC's own limit is the ceiling, not a default to raise)",
    J(P.rate) === J(["refused", "refused", "refused", "refused", "ok", "ok"]), P.rate);
  ok("B4 Retry-After: seconds, zero, a clamp at two minutes, none, unreadable, an HTTP date, and a date in the past",
    J(P.retryAfter) === J([30000, 0, 120000, null, null, 30000, 0]), P.retryAfter);
  ok("B5 the limiter: 400 back-to-back calls never exceed TEN in any rolling second (and take the 39 seconds that implies)",
    P.burst10.peak === 10 && P.burst10.stats === 400 && P.burst10.spanMs === 39000, P.burst10);
  ok("B6 the limiter obeys a lower rate too: 20 calls at 3 a second peak at 3", P.burst3.peak === 3 && P.burst3.spanMs === 6000, P.burst3);
  ok("B7 a fetcher that was not injected is REFUSED (so a test can never make a network call by forgetting one)", P.noFetcher === "refused");
  { const SEC = T.load(t0, "backend/lib/sec-fetch.js");
    let ms = 0; const lim = SEC.makeLimiter({ perSecond: 10, now: () => ms, sleep: async (d) => { ms += d; } });
    for (let i = 0; i < 10; i++) await lim.take();
    lim.hold(ms + 5000);
    const t = ms; await lim.take();
    ok("B8 a hold (what a 429's Retry-After does) stops EVERY call, not only the one that was refused", ms === t + 5000, { t, ms });
    let ms2 = 0; const lim2 = SEC.makeLimiter({ perSecond: 10, now: () => ms2, sleep: async (d) => { ms2 += d; } });
    for (let i = 0; i < 10; i++) await lim2.take();                              // the rolling second is full: the next slot is 1s away
    const r = await triedAsync(() => lim2.take(ms2 + 10));                       // …and the deadline is 10 ms
    ok("B9 a slot that would come after the run's budget is REFUSED there and then (nothing is asked)", !r.ok && /past this run's budget/.test(r.why), r);
    ok("B10 and that refusal did not spend a slot: the limiter's own count is still ten", lim2.stats().taken === 10, lim2.stats()); }

  // ── C. sec-fetch over the fixture fetcher ──────────────────────────────────────────────────────────────────────────────────
  section("C. sec-fetch over the saved fixtures: the answers, the retries, the refusals");
  { const SEC = T.load(t0, "backend/lib/sec-fetch.js");
    const IDX = "https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/master.20261117.idx";
    const F1 = `https://www.sec.gov/Archives/edgar/data/1000001/${FB.acc(1)}.txt`;
    const mk = (answers, opts = {}) => { const c = FX.makeClock(), f = FX.make({ now: c.now, tick: c.tick, answers }); return { c, f, sec: SEC.makeSecFetcher({ fetchFn: f.fetchFn, userAgent: UA, now: c.now, sleep: c.sleep, log: () => {}, ...opts }) }; };
    { const { f, sec } = mk({}); const r = await sec.get(IDX);
      ok("C1 a 200: the text comes back, one request, and the declared User-Agent is on it", r.ok && r.text.includes("CIK|Company Name") && r.tries === 1 && f.calls.length === 1 && f.calls[0].ua === UA, { ok: r.ok, tries: r.tries, ua: f.calls[0] && f.calls[0].ua }); }
    { const { f, sec } = mk({}); const r = await sec.get("https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/master.20261119.idx");
      ok("C2 a 404 is an ANSWER (notFound), is not retried, and is not a failure", r.notFound === true && r.failed === undefined && r.tries === 1 && f.calls.length === 1, r); }
    ok("C3 a 403 THROWS at once naming the User-Agent, after exactly ONE request (on sec.gov it is the UA block; retrying it earns a longer one)",
      P.forbidden.threw === true && P.forbidden.mentionsUa === true && P.forbidden.requests === 1, P.forbidden);
    { let n = 0; const c = FX.makeClock();
      const f = { calls: [], fetchFn: async () => { n++; c.tick(5); if (n === 1) return { ok: false, status: 429, headers: FX.headers({ "Retry-After": "2" }), async text() { return ""; } }; return { ok: true, status: 200, headers: FX.headers({}), async text() { return "fine"; } }; } };
      const sec = SEC.makeSecFetcher({ fetchFn: f.fetchFn, userAgent: UA, now: c.now, sleep: c.sleep, log: () => {} });
      const t = c.ms, r = await sec.get(IDX);
      ok("C4 a 429 with Retry-After: every call holds for the time it asks, then the retry succeeds", r.ok && r.text === "fine" && r.tries === 2 && n === 2 && c.ms - t >= 2000, { tries: r.tries, waited: c.ms - t }); }
    { const { f, sec } = mk({ [FB.acc(1)]: { status: 503 } }); const r = await sec.get(F1);
      ok("C5 a 5xx on every try: four requests, then `failed` with the reason — never an empty answer", r.failed === true && r.tries === 4 && f.calls.length === 4 && /503/.test(r.why), r); }
    { const { f, sec } = mk({ [FB.acc(1)]: { throw: true } }); const r = await sec.get(F1);
      ok("C6 no answer at all (a timeout) is retried, then reported failed", r.failed === true && r.tries === 4 && f.calls.length === 4 && /no answer/.test(r.why), r); }
    { const { f, sec } = mk({ [FB.acc(1)]: { unreadable: true } }); const r = await sec.get(F1);
      ok("C7 a 200 whose body cannot be read is retried, then reported failed (it is not read as an empty filing)", r.failed === true && /could not be read/.test(r.why) && f.calls.length === 4, r); }
    { const { sec } = mk({}); const r = await triedAsync(() => sec.get("https://not-sec.invalid/Archives/x.txt"));
      ok("C8 a URL off the SEC's hosts is refused before any request", !r.ok && /not an SEC host/.test(r.why), r); }
    { const { f, sec } = mk({ [FB.acc(1)]: { status: 503 } }, { budgetMs: 1000 }); const r = await sec.get(F1);
      ok("C9 the budget cuts the retries short and says so, rather than running on", r.failed === true && r.tries < 4 && /budget/.test(r.why) && f.calls.length < 4, r); }
    { const { f, sec } = mk({}, { perSecond: 2 });
      const t = FX.makeClock(); const r1 = await sec.get(IDX); const r2 = await sec.get(F1);
      ok("C10 two reads at 2 a second both answer, and the stats count them", r1.ok && r2.ok && sec.stats().requests === 2 && sec.stats().taken === 2 && f.calls.length === 2, sec.stats()); } }

  // ── D. the parser, filing by filing ────────────────────────────────────────────────────────────────────────────────────────
  section("D. form4-parse on each saved fixture filing");
  const noneExcluded = J({ notPurchase: 0, disposed: 0, nonCommon: 0, noPrice: 0, noShares: 0, noDate: 0, notOfficerOrDirector: 0, amendment: 0, equitySwap: 0 });
  ok("D1 filing 1 — an officer buys 1,000 at $10.00 on 2026-11-16: $10,000, one qualifying owner, nothing excluded",
    J(P.parse[1]) === J(["4", false, "AAAA", "0002000001:officer", "2026-11-16:1000:10000:10000", noneExcluded, false]), P.parse[1]);
  ok("D2 filing 2 — a DIRECTOR buys 500 at $12.00: $6,000, role director", J(P.parse[2]) === J(["4", false, "AAAA", "0002000002:director", "2026-11-16:500:6000:6000", noneExcluded, false]), P.parse[2]);
  ok("D3 filing 3 — a TEN-PERCENT OWNER buys: read, but no qualifying owner and no purchase summed (what the people who run the company do is the question)",
    P.parse[3][3] === "" && P.parse[3][4] === "" && JSON.parse(P.parse[3][5]).notOfficerOrDirector === 1, P.parse[3]);
  ok("D4 filing 4 — a sale, an award and an exercise: no purchase, three rows counted as not-a-purchase",
    P.parse[4][4] === "" && JSON.parse(P.parse[4][5]).notPurchase === 3, P.parse[4]);
  ok("D5 filing 5 — a purchase with NO PRICE (a footnote) and a purchase of PREFERRED stock: both excluded, counted as noPrice and nonCommon, no dollars invented",
    P.parse[5][4] === "" && JSON.parse(P.parse[5][5]).noPrice === 1 && JSON.parse(P.parse[5][5]).nonCommon === 1, P.parse[5]);
  ok("D6 filing 6 — a 4/A AMENDMENT of filing 1: read, marked an amendment, and NOT summed (it restates a purchase already counted)",
    P.parse[6][0] === "4/A" && P.parse[6][1] === true && P.parse[6][4] === "" && JSON.parse(P.parse[6][5]).amendment === 1, P.parse[6]);
  ok("D7 filing 7 — a JOINT filing: $20,000 ONCE for the filing, two qualifying owners, $10,000 each as the even split, jointFiling true",
    J(P.parse[7]) === J(["4", false, "EEEE", "0002000006:officer,0002000007:director", "2026-11-16:800:20000:10000", noneExcluded, true]), P.parse[7]);
  ok("D8 filing 7 — the Form 4 document is read, NOT the EX-24 exhibit that comes first in the submission", P.parse[7][2] === "EEEE" && P.parse[7][1] === false, P.parse[7]);
  ok("D9 filing 8 — a TRUNCATED submission is UNREADABLE, never a filing with no purchases", P.parse[8][0] === "unreadable" && /no Form 4 ownership document|documentType/.test(P.parse[8][1]), P.parse[8]);
  ok("D10 filing 10 — an owner who is BOTH an officer and a director reads as officer-and-director", P.parse[10][3] === "0002000002:officer-and-director", P.parse[10]);
  ok("D11 filing 15 — a purchase dated on a SATURDAY parses as it is written (the calendar, not the parser, decides where it lands)", P.parse[15][4] === "2026-11-21:100:700:700", P.parse[15]);
  ok("D14 filing 11 — code P but marked DISPOSED: not a purchase whatever the code says, counted as `disposed`, no dollars summed",
    P.parse[11][4] === "" && JSON.parse(P.parse[11][5]).disposed === 1 && JSON.parse(P.parse[11][5]).notPurchase === 0, P.parse[11]);
  { const P4 = T.load(t0, "backend/lib/form4-parse.js");
    ok("D12 the XML helpers: a tag is matched by NAME (transactionShares is not transactionSharesOwned), a self-closing tag is empty, entities are decoded",
      P4.textOf("<a><transactionSharesOwned><value>9</value></transactionSharesOwned><transactionShares><value>7</value></transactionShares></a>", "transactionShares") === "7"
      && P4.allBlocks("<x/><x>1</x>", "x").join(",") === ",1" && P4.decodeEntities("A &amp; B &lt;c&gt; &#39;d&#39;") === "A & B <c> 'd'"
      && P4.cik10("1000001") === "0001000001" && P4.cik10("x1") === null && P4.isoDay("2026-11-16") === "2026-11-16" && P4.isoDay("16-NOV-2026") === null);
    ok("D13 an empty text, a non-Form-4 document and a Form 4 with no issuer CIK each read as UNREADABLE with a reason",
      [P4.parseForm4(""), P4.parseForm4("<ownershipDocument><documentType>3</documentType><issuer><issuerCik>1</issuerCik></issuer><reportingOwner><reportingOwnerId><rptOwnerCik>2</rptOwnerCik></reportingOwnerId></reportingOwner></ownershipDocument>"), P4.parseForm4("<ownershipDocument><documentType>4</documentType></ownershipDocument>")].every((r) => r.ok === false && typeof r.why === "string" && r.why.length > 5)); }

  // ── E. the record and its merge ────────────────────────────────────────────────────────────────────────────────────────────
  section("E. insider-buys-lib: the record, the merge, the guards");
  ok("E1 the per-insider dollars add up to the day's dollars on every record (a joint filing's even split is the only one, and it closes)", P.libAddsUp === true);
  ok("E2 merging a record with itself returns it unchanged (every sum is keyed by accession)", P.libIdempotent === true);
  ok("E3 merging is order-independent, and a duplicate record adds nothing", J(P.libOrder) === J([true, true, 9]), P.libOrder);
  ok("E4 an unreadable line and a line of another spec are REPORTED, not skipped quietly", J(P.libBad) === J([1, 2]), P.libBad);
  ok("E5 an ordinary merge loses no company-day", P.libShrinkReported === 0);
  ok("E5b the shrink guard itself: a day that is in the file and not in what would replace it is NAMED; a day only in the new records is not a loss",
    J(P.lostDaysOf) === J([["b|2026-11-16"], []]), P.lostDaysOf);
  ok("E5c a company-day DAMAGED by hand (a filing entry naming no reporting owner) is set aside with its reason — the other days still merge, and the set-aside day counts as a loss so the write is refused",
    J(P.unmergeable) === J([1, "b|2026-11-16", 1, 1]), P.unmergeable);
  ok("E6 the same accession added twice is added ONCE, and says so (a re-read of a filing costs nothing and adds nothing)",
    J(P.libAddTwice) === J([true, false, 100, 1, 1]), P.libAddTwice);
  { const BL = T.load(t0, "backend/lib/insider-buys-lib.js");
    ok("E7 a filing with no owner, or an owner with no CIK, is REFUSED rather than counted as an anonymous insider",
      !tried(() => BL.addFiling(BL.emptyDay("c", "2026-11-16"), { accession: "x", owners: [] })).ok && !tried(() => BL.addFiling(BL.emptyDay("c", "2026-11-16"), { accession: "x", owners: [{ role: "officer" }] })).ok);
    ok("E8 mergeDay refuses two different company-days", !tried(() => BL.mergeDay({ cik: "a", tradeDate: "2026-11-16" }, { cik: "b", tradeDate: "2026-11-16" })).ok); }

  // ── F. the collector, end to end ───────────────────────────────────────────────────────────────────────────────────────────
  section("F. the collector over the fixture filings");
  const WANT_ROWS = [
    ["AAAA", "2026-11-16", 2, 16000, 1500, "director+officer", 2, 0, "0002000001:officer:10000,0002000002:director:6000", "2026-11-17"],
    ["AAAA", "2026-11-17", 2, 5500, 500, "officer+officer-and-director", 2, 0, "0002000001:officer:2200,0002000002:officer-and-director:3300", "2026-11-18"],
    ["AAAA", "2026-11-30", 1, 5200, 400, "officer-and-director", 1, 0, "0002000009:officer-and-director:5200", "2026-12-01"],
    ["AAAA", "2026-12-01", 1, 1950, 150, "director", 1, 0, "0002000010:director:1950", "2026-12-01"],
    ["BBBB", "2026-11-21", 1, 700, 100, "officer", 1, 0, "0002000011:officer:700", "2026-11-25"],
    ["BBBB", "2026-11-23", 1, 1400, 200, "director", 1, 0, "0002000012:director:1400", "2026-11-25"],
    ["BBBB", "2026-11-24", 1, 2100, 300, "officer", 1, 0, "0002000013:officer:2100", "2026-11-25"],
    ["EEEE", "2026-11-16", 2, 20000, 800, "director+officer", 1, 1, "0002000006:officer:10000,0002000007:director:10000", "2026-11-17"],
    ["EEEE", "2026-12-01", 1, 2600, 100, "officer", 1, 0, "0002000008:officer:2600", "2026-12-01"],
  ].sort((a, b) => J(a).localeCompare(J(b)));
  ok("F1 the nine company-days, to the dollar and the share — insiders counted over OWNERS, dollars summed over ACCESSIONS", J(P.collect.rows) === J(WANT_ROWS), P.collect.rows);
  ok("F2 the run exits 3 because one filing did not read whole (a partial read never looks like a clean one)", P.collect.code === 3);
  ok("F3 one request per index and one per original Form 4 — the same accession listed per filer AND for the issuer is ONE read", P.collect.requests === 4 + (7 + 3 + 3 + 3), P.collect.requests);
  ok("F4 the declared User-Agent is on every request, and nothing else is", J(P.collect.uaSent) === J([UA]), P.collect.uaSent);
  ok("F5 the run lines: what was listed, read, summed and NOT read, per filing day",
    J(P.runLines) === J([
      ["2026-11-17", true, true, 7, 6, 3, 1, 2, 1, 1, 0, 1, false],
      ["2026-11-18", true, true, 3, 3, 2, 0, 1, 0, 0, 0, 0, true],
      ["2026-11-25", true, true, 3, 3, 3, 0, 0, 0, 0, 0, 0, true],
      ["2026-12-01", true, true, 3, 3, 3, 0, 0, 0, 0, 0, 0, true],
    ]), P.runLines);
  ok("F6 a second run of the same days leaves every company-day line byte for byte as it was: nothing added, nothing updated, all nine unchanged",
    P.rerun.same === true && P.rerun.added === 0 && P.rerun.updated === 0 && P.rerun.unchanged === 9, P.rerun);
  ok("F7 a filing answered 503 on every try is UNRESOLVED and gets no company-day — exit 3, never a quietly short day",
    P.filing503.code === 3 && P.filing503.rows === 2 && P.filing503.unresolved.length === 1 && P.filing503.unresolved[0].startsWith(FB.acc(17)), P.filing503);
  ok("F8 a 404 daily index: on a SATURDAY the day is clean (exit 0, nothing unresolved); on a TRADING day it is a failed read (exit 3)",
    P.index404.weekendCode === 0 && P.index404.weekendUnresolved === 0 && P.index404.tradingCode === 3 && P.index404.tradingUnresolved === 1, P.index404);
  ok("F9 --dry reads and parses everything and writes nothing", P.dry.code === 3 && P.dry.files === 0, P.dry);
  ok("F10 a company-day in the file that this run did not see is KEPT and counted unchanged (a dated file is a record, not a snapshot of one run)",
    P.keepsOthers.code === 0 && P.keepsOthers.zzzz === 1 && P.keepsOthers.unchanged === 2, P.keepsOthers);
  ok("F11 a company-day in the file DAMAGED by hand cannot be merged, so the write is REFUSED, the file is left byte for byte as it is, and the run exits 3",
    P.shrink.code === 3 && P.shrink.untouched === true && P.shrink.said === true && /lose/.test(String(P.shrink.refused)), P.shrink);
  { const collect = T.load(t0, "backend/insider-buys-collect.js");
    ok("F12 the daily master index: the Form 4s, the amendments counted once each, the other forms, and an unreadable line",
      (() => { const r = collect.parseMasterIndex(fs.readFileSync(path.join(PKG, "fixtures", "daily-index", "master.20261117.idx"), "utf8"), { day: "2026-11-17" });
        return r.form4.length === 7 && r.counts.form4A === 1 && r.counts.otherForms === 2 && new Set(r.form4.map((x) => x.accession)).size === 7; })(),
      collect.parseMasterIndex(fs.readFileSync(path.join(PKG, "fixtures", "daily-index", "master.20261117.idx"), "utf8"), {}).counts);
    ok("F13 the index URL is the SEC's own daily master index for that day and quarter",
      collect.masterIndexUrl("2026-11-17") === "https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/master.20261117.idx" && collect.masterIndexUrl("2026-02-03") === "https://www.sec.gov/Archives/edgar/daily-index/2026/QTR1/master.20260203.idx",
      collect.masterIndexUrl("2026-02-03"));
    ok("F14 a line whose filename is not an edgar/data/<cik>/<accession>.txt is counted unreadable, not guessed at",
      collect.parseMasterIndex("CIK|Company Name|Form Type|Date Filed|File Name\n1|X|4|2026-11-17|edgar/data/1/not-an-accession.txt\n2|Y|4|2026-11-17|somewhere/else.txt\n").counts.unreadable === 2);
    const r = await triedAsync(() => collect.run({ dates: ["2026-11-17"], fetchFn: async () => ({ ok: true, status: 200, async text() { return ""; } }), userAgent: "REPLACE_ME", outDir: os.tmpdir(), log: () => {} }));
    ok("F15 a placeholder User-Agent refuses the whole run before anything is written", !r.ok && /placeholder/.test(r.why), r); }

  // ── G. the cluster finder ──────────────────────────────────────────────────────────────────────────────────────────────────
  section("G. the cluster finder: three insiders inside ten TRADING days");
  const WANT_CLUSTERS = [
    ["BBBB", 3, 4200, "2026-11-21", "2026-11-24", "2026-11-24", 2, "2026-11-25", 1, "director+officer", 1, "0002000013:officer:2100,0002000012:director:1400,0002000011:officer:700"],
    ["AAAA", 3, 26700, "2026-11-16", "2026-11-30", "2026-11-30", 10, "2026-12-01", 1, "officer+officer-and-director", 0, "0002000001:officer:12200,0002000002:officer-and-director:9300,0002000009:officer-and-director:5200"],
  ];
  ok("G1 the two clusters, exactly: AAAA (3 insiders, $26,700, ten trading days 11-16..11-30) and BBBB (3 insiders, $4,200, one buy dated on a Saturday)",
    J(P.clusters.rows) === J(WANT_CLUSTERS), P.clusters.rows);
  ok("G2 the summary: 3 issuers, 9 company-days, 10 insider-company pairs, 2 clusters, 26 trading days, 1 holiday in range, calendar covered",
    J(P.clusters.summary) === J([3, 9, 10, 2, 26, 1, false]), P.clusters.summary);
  ok("G3 THE TRADING-DAY CHECK: take Thanksgiving out of the holiday table and the AAAA cluster is a DIFFERENT, smaller one — it no longer reaches back to 2026-11-16 (eleven weekdays from 11-30, ten trading days), so it starts 11-17 and holds $10,700 of the $26,700",
    P.clustersNoThanksgiving.length === 2 && J(P.clustersNoThanksgiving.find((r) => r[0] === "AAAA").slice(0, 7)) === J(["AAAA", 3, 10700, "2026-11-17", "2026-11-30", "2026-11-30", 10])
    && J(P.clustersNoThanksgiving.find((r) => r[0] === "BBBB")) === J(P.clusters.rows.find((r) => r[0] === "BBBB")), P.clustersNoThanksgiving);
  ok("G4 EEEE has THREE distinct insiders and is NOT a cluster: 2026-11-16 and 2026-12-01 are eleven trading days apart",
    !P.clusters.rows.some((r) => r[0] === "EEEE") && P.clusters.summary[2] === 10, P.clusters.rows.map((r) => r[0]));
  ok("G5 a day a cluster has SPENT starts no second cluster at the same company (AAAA 2026-12-01 is one insider on its own)",
    P.clusters.rows.filter((r) => r[0] === "AAAA").length === 1, P.clusters.rows.filter((r) => r[0] === "AAAA").length);
  ok("G6 DISTINCT insiders are people, not filings: OWNER ONE buys on two days inside the AAAA cluster and counts once ($12,200 over both)",
    P.clusters.rows.find((r) => r[0] === "AAAA")[11].includes("0002000001:officer:12200") && P.clusters.rows.find((r) => r[0] === "AAAA")[1] === 3);
  ok("G7 the trade dates are placed on the calendar: 11-16 is day 5, Thanksgiving is not a day at all, 11-30 is day 14, and a Saturday is placed FORWARD on 11-23",
    J(P.calIndex) === J(["2026-11-16->5", "2026-11-17->6", "2026-11-25->12", "2026-11-26->13*", "2026-11-27->13", "2026-11-30->14", "2026-12-01->15"])
    && J(JSON.parse(P.satPlacement)) === J({ day: "2026-11-23", index: 10, offCalendar: true, dated: "2026-11-21" }), { calIndex: P.calIndex, sat: P.satPlacement });
  ok("G8 --min-insiders 2 is a different question and finds five: AAAA three times (11-16, 11-17, then 11-30+12-01), EEEE's joint pair, and BBBB's first two",
    J(P.clustersMin2) === J([["AAAA", 2, 16000, "2026-11-16"], ["EEEE", 2, 20000, "2026-11-16"], ["AAAA", 2, 5500, "2026-11-17"], ["BBBB", 2, 2100, "2026-11-23"], ["AAAA", 2, 7150, "2026-12-01"]]), P.clustersMin2);
  ok("G9 --min-usd-per-insider 5000 drops the insiders under it: AAAA keeps three ($12,200 / $9,300 / $5,200) and BBBB falls away",
    P.clustersMinUsd.length === 1 && P.clustersMinUsd[0][0] === "AAAA" && P.clustersMinUsd[0][1] === 3, P.clustersMinUsd);
  ok("G10 --min-usd 10000 drops BBBB's $4,200 cluster and keeps AAAA's $26,700", J(P.clustersMinTotal) === J([["AAAA", 3, 26700]]), P.clustersMinTotal);
  ok("G11 a date range the holiday table does not cover is REFUSED (a holiday there would count as a trading day); allowed deliberately, the calendar is MARKED uncovered",
    P.calRefusal === "refused" && P.calAllowed === "ok" && P.calAllowedMarked === true, { refusal: P.calRefusal, allowed: P.calAllowed, marked: P.calAllowedMarked });
  ok("G12 an empty holiday table is refused outright", P.calEmpty === "refused");
  ok("G13 a filing day that did not read whole is named in the cluster run's own output (three insiders is a different claim when a filing was never read)", J(P.incomplete) === J(["2026-11-17"]), P.incomplete);
  ok("G14 the written file: one dated JSON, the clusters in it, and it grades nothing", P.write.code === 0 && P.write.file === "insider-clusters-2026-12-02.json" && P.write.clusters === 2 && /grades nothing|nothing —/.test(P.write.grades), P.write);
  ok("G15 no input folder, and an empty one, are REFUSED (exit 2) rather than reported as no clusters", P.noInput === 2 && P.emptyInput === 2, { noInput: P.noInput, emptyInput: P.emptyInput });
  { const CL = T.load(t0, "backend/lib/insider-cluster-lib.js");
    ok("G16 findClusters refuses a missing calendar, a window under one day and fewer than two insiders",
      !tried(() => CL.findClusters([], {})).ok && !tried(() => CL.findClusters([], { calendar: { place: () => null }, windowTradingDays: 0 })).ok && !tried(() => CL.findClusters([], { calendar: { place: () => null }, minInsiders: 1 })).ok); }

  // ── H. mutation-proof ──────────────────────────────────────────────────────────────────────────────────────────────────────
  section("H. mutation-proof: each mutant of the staged code must change a known answer above");
  const MUTANTS = [
    ["the limiter accepts a rate above the SEC's ten a second", "backend/lib/sec-fetch.js", `if (perSecond > MAX_PER_SECOND) throw new Error(\`SEC fetch: perSecond \${perSecond} is above the SEC's own limit of \${MAX_PER_SECOND} a second — refused.\`);`, ""],
    ["the limiter lets a burst past the rolling second", "backend/lib/sec-fetch.js", "stamps.length >= perSecond ? stamps[0] + 1000 : t", "t"],
    ["a placeholder User-Agent is accepted", "backend/lib/sec-fetch.js", "if (PLACEHOLDER.test(s))", "if (false && PLACEHOLDER.test(s))"],
    ["a missing injected fetcher falls back to the global fetch", "backend/lib/sec-fetch.js", 'if (typeof fetchFn !== "function") throw new Error("SEC fetch: a fetcher must be injected (fetchFn). This layer never reaches for a global fetch, so a test can never make a network call by forgetting one.");', ""],
    ["any host is read, not only the SEC's", "backend/lib/sec-fetch.js", "if (!SEC_HOSTS.includes(u.host))", "if (false && !SEC_HOSTS.includes(u.host))"],
    ["a 404 is treated as a failure instead of an answer", "backend/lib/sec-fetch.js", "if (status === 404) { counts.notFound++; return { ok: false, notFound: true, status, url: u, tries: attempt + 1 }; }", ""],
    ["a 403 is retried like a transient failure", "backend/lib/sec-fetch.js", "if (status === 403) throw new Error(", "if (false && status === 403) throw new Error("],
    ["any transaction code counts, not only P", "backend/lib/form4-parse.js", "if (r.code !== CODE_PURCHASE) { excluded.notPurchase++; continue; }", ""],
    ["a disposal counts as a purchase", "backend/lib/form4-parse.js", "if (r.acquiredDisposed !== ACQUIRED) { excluded.disposed++; continue; }", ""],
    ["a ten-percent holder counts as an insider", "backend/lib/form4-parse.js", "qualifies: Boolean(isOfficer || isDirector),", "qualifies: Boolean(isOfficer || isDirector || flagOf(rel, \"isTenPercentOwner\")),"],
    ["an amendment is summed on top of the filing it restates", "backend/lib/form4-parse.js", "if (!qualifyingOwners.length || amendment) continue;", "if (!qualifyingOwners.length) continue;"],
    ["a purchase with no price is counted at $0", "backend/lib/form4-parse.js", "if (!(r.pricePerShare > 0)) { excluded.noPrice++; continue; }", ""],
    ["preferred stock counts as common", "backend/lib/form4-parse.js", "if (commonOnly && !COMMON_RE.test(String(r.securityTitle || \"\"))) { excluded.nonCommon++; continue; }", ""],
    ["the first ownership document in the submission is read, exhibit or not", "backend/lib/form4-parse.js", 'if (type !== "4" && type !== "4/A") continue;', ""],
    ["a joint filing's dollars are given to each owner in full", "backend/lib/insider-buys-lib.js", "s + a.usd / a.owners.length", "s + a.usd"],
    ["a filing already in the record is added again", "backend/lib/insider-buys-lib.js", "if (day.acc.has(accession)) return { added: false };", ""],
    ["a merge that loses a company-day is not reported", "backend/lib/insider-buys-lib.js", "return [...new Set((oldRecords || []).map((r) => `${r.cik}|${r.tradeDate}`))].filter((k) => !have.has(k));", "return [];"],
    ["a company-day that cannot be merged takes the whole run down instead of being set aside", "backend/lib/insider-buys-lib.js", "catch (e) { unmergeable.push({ key: k, why: String(e && e.message || e).slice(0, 200) }); }", "catch (e) { throw e; }"],
    ["a damaged company-day is passed over without being counted a loss", "backend/lib/insider-buys-lib.js", "catch (e) { unmergeable.push({ key: k, why: String(e && e.message || e).slice(0, 200) }); }", "catch (e) { merged.push(list[0]); }"],
    ["the ten-day window is counted one day too wide", "backend/lib/insider-cluster-lib.js", "all[j].idx - (windowTradingDays - 1)", "all[j].idx - windowTradingDays"],
    ["the calendar counts weekdays, holidays included", "backend/lib/insider-cluster-lib.js", "if (dow === 0 || dow === 6 || holidays[d]) continue;", "if (dow === 0 || dow === 6) continue;"],
    ["insiders are counted per buy day instead of per person", "backend/lib/insider-cluster-lib.js", "for (const w of inWindow) for (const i of w.insiders) owners.add(i.ownerCik);", "for (const w of inWindow) for (const i of w.insiders) owners.add(w.rec.tradeDate + i.ownerCik);"],
    ["a company-day may join more than one cluster", "backend/lib/insider-cluster-lib.js", "fromPos = j + 1;", ""],
    ["a date on a closed day is placed BACKWARD, pulling the window earlier", "backend/lib/insider-cluster-lib.js", "for (let d = addDays(d0, 1); d <= b; d = addDays(d, 1)) if (index.has(d)) return { day: d, index: index.get(d), offCalendar: true, dated: d0 };", "for (let d = addDays(d0, -1); d >= a; d = addDays(d, -1)) if (index.has(d)) return { day: d, index: index.get(d), offCalendar: true, dated: d0 };"],
    ["an uncovered date range runs instead of refusing", "backend/lib/insider-cluster-lib.js", "if (uncovered && !allowUncovered) {", "if (false && uncovered && !allowUncovered) {"],
    ["a filing that could not be fetched is passed over in silence", "backend/insider-buys-collect.js", 'out.unresolved.push({ what: "filing", accession: f.accession, url: f.url, why: res.notFound ? "HTTP 404" : (res.why || `HTTP ${res.status}`) });', ""],
    ["a missing index on a TRADING day reads as an empty day", "backend/insider-buys-collect.js", 'if (out.tradingDay) out.unresolved.push({ what: "daily index", url: out.index.url, why: "HTTP 404 on a trading day" });', ""],
    ["the same filing is fetched once per filer line in the index", "backend/insider-buys-collect.js", "if (seen.has(accession)) continue;", ""],
    ["a refused write still reports the day complete", "backend/insider-buys-collect.js", "if (merged.lostDays.length) {", "if (false && merged.lostDays.length) {"],
    ["an unreadable filing is counted as a filing with no purchase", "backend/insider-buys-collect.js", 'if (!p.ok) { out.filings.unreadable++; out.unresolved.push({ what: "filing", accession: f.accession, url: f.url, why: p.why }); continue; }', "if (!p.ok) { out.filings.noPurchase++; continue; }"],
    ["the cluster run hides the filing days that did not read whole", "backend/insider-clusters.js", "for (const r of p.runs) { out.runs.push(r); if (r.complete === false) out.incompleteDays.push({ filingDay: r.filingDay, unresolved: (r.unresolved || []).length }); }", "for (const r of p.runs) out.runs.push(r);"],
  ];
  const GOLD = J(P);
  let caught = 0;
  for (const [why, rel, from, to] of MUTANTS) {
    let t = null, verdict = "NOT CAUGHT";
    try {
      t = T.makeTree({ edits: { [rel]: (text) => T.mutate(text, from, to) } });
      const q = await triedAsync(() => probe(t));
      verdict = !q.ok ? "caught (it threw)" : J(q.v) === GOLD ? "NOT CAUGHT" : "caught";
    } catch (e) { verdict = `the mutation itself failed: ${e.message}`; }
    finally { if (t) t.cleanup(); }
    const good = verdict.startsWith("caught");
    if (good) caught++;
    ok(`H${caught + (good ? 0 : 1)} mutant — ${why} (${path.basename(rel)}): ${verdict}`, good, verdict);
  }
  ok(`H* all ${MUTANTS.length} mutants were caught`, caught === MUTANTS.length, `${caught} of ${MUTANTS.length}`);

  // ── I. deploy and rollback ─────────────────────────────────────────────────────────────────────────────────────────────────
  section("I. deploy and rollback on scratch repos");
  { const mkRepo = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ic-repo-")); fs.mkdirSync(path.join(d, "backend", "lib"), { recursive: true }); for (const rel of T.FROM_REPO) fs.copyFileSync(T.P(REPO, rel), T.P(d, rel)); return d; };
    const repo = mkRepo();
    const pl0 = D.plan({ repo });
    ok("I1 a scratch repo with none of these files: the plan reads every one 'absent — to create', and nothing refuses it",
      pl0.problems.length === 0 && pl0.files.every((x) => x.state === "absent") && pl0.todo.length === D.FILES.length, { problems: pl0.problems, states: pl0.files.map((x) => x.state) });
    const M = D.make({ repo, now: () => Date.parse("2026-10-17T23:30:00Z"), listProcs: () => [], log: () => {} });
    const w = M.writeUnit({ to: "staged" });
    ok("I2 --apply writes every staged file, read back by sha256 and node --check", w.result === "done" && w.written.length === D.FILES.length && D.FILES.every((f) => sha(fs.readFileSync(T.P(repo, f.rel))) === f.stagedSha), w);
    const pl1 = D.plan({ repo });
    ok("I3 after the write every file reads 'applied', and a second --apply writes nothing", pl1.applied === true && M.writeUnit({ to: "staged" }).written.length === 0, pl1.files.map((x) => x.state));
    const back = M.writeUnit({ to: "base" });
    ok("I4 rollback removes exactly the files this package created and leaves the repo as it was", back.result === "done" && D.FILES.every((f) => !fs.existsSync(T.P(repo, f.rel))) && fs.existsSync(T.P(repo, "backend/lib/atomic-write.js")), back);
    fs.writeFileSync(T.P(repo, D.FILES[0].rel), "// someone else's file\n");
    const drift = D.plan({ repo });
    ok("I5 a file that is neither absent nor the staged bytes is DRIFT: the apply AND the rollback refuse, and nothing is written",
      drift.problems.some((s) => /DRIFT/.test(s)) && M.writeUnit({ to: "staged" }).result === "refused" && M.writeUnit({ to: "base" }).result === "refused" && fs.readFileSync(T.P(repo, D.FILES[0].rel), "utf8") === "// someone else's file\n", drift.problems);
    fs.unlinkSync(T.P(repo, D.FILES[0].rel));
    const red = D.make({ repo, now: () => Date.parse("2026-10-17T23:30:00Z"), listProcs: () => [], log: () => {} })
      .writeUnit({ to: "staged", gate: { what: "a gate that fails", run: () => ({ ok: false, why: "red" }) } });
    ok("I6 a red gate refuses the apply and writes nothing", red.result === "refused" && D.FILES.every((f) => !fs.existsSync(T.P(repo, f.rel))), red);
    const busy = D.make({ repo, now: () => Date.parse("2026-10-17T23:30:00Z"), listProcs: () => [{ pid: 999, cmd: `node ${repo}/backend/insider-buys-collect.js --date 2026-11-17` }], log: () => {} });
    ok("I7 the apply refuses while the collector itself is running, and refuses when the process list cannot be read at all",
      busy.writeUnit({ to: "staged" }).result === "refused" && D.make({ repo, now: () => Date.parse("2026-10-17T23:30:00Z"), listProcs: () => { throw new Error("no ps"); }, log: () => {} }).writeUnit({ to: "staged" }).result === "refused");
    const inHours = D.make({ repo, now: () => Date.parse("2026-10-16T18:00:00Z"), listProcs: () => [], log: () => {} });
    ok("I8 the apply refuses inside the trading-day session hours (05:30-16:00 MT)", inHours.writeUnit({ to: "staged" }).result === "refused", inHours.fences());
    ok("I9 rollback's plan and the refusal words are its own (and --plan writes nothing)", typeof RB.printPlan === "function" && D.plan({ repo }).files.every((x) => x.state === "absent"));
    fs.rmSync(repo, { recursive: true, force: true }); }

  // ── J. record.cjs ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("J. record.cjs");
  { const r = REC.run({ dry: true, log: () => {} });
    ok("J1 --dry on the real repository: it prints the two records and writes nothing (and it is not refused for being unable to read them)", r.code === 0 && r.result === "dry", r.lines.slice(-2));
    const rec = REC.records({ nowMs: Date.parse("2026-10-17T23:30:00Z"), mtDate: "2026-10-17" });
    ok("J2 the row names every file this package adds, says it registers no test, and breaks no comparability",
      rec.row.id === REC.CR_ID && Object.keys(rec.row.files).length === D.FILES.length && rec.row.breaksComparability === false && rec.row.tests.length === 0
      && /registers NO test/.test(rec.row.notGiven) && /registered at home, before any of this data is read/.test(rec.row.notGiven)
      && Object.values(rec.row.files).every((f) => f.before === null), { files: Object.keys(rec.row.files).length, tests: rec.row.tests, notGiven: rec.row.notGiven.slice(0, 80) });
    ok("J3 the ledger line is a GOVERNANCE line naming the row", rec.line.kind === "GOVERNANCE" && rec.line.changeRegistry === REC.CR_ID);
    const dd = fs.mkdtempSync(path.join(os.tmpdir(), "ic-data-"));
    fs.writeFileSync(path.join(dd, "change-registry.json"), "[]");
    fs.writeFileSync(path.join(dd, "agent-ledger.jsonl"), "");
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ic-repo2-"));
    fs.mkdirSync(path.join(repo, "backend", "lib"), { recursive: true });
    for (const rel of T.FROM_REPO) fs.copyFileSync(T.P(REPO, rel), T.P(repo, rel));
    const at = (iso) => () => Date.parse(iso);
    const notApplied = REC.run({ dataDir: dd, repo, now: at("2026-10-17T23:30:00Z"), log: () => {} });
    ok("J4 refused while the files are not at home yet (a change is recorded after it is in), and nothing is written",
      notApplied.code === 2 && /deploy\.cjs --apply/.test(notApplied.lines.join(" ")) && fs.readFileSync(path.join(dd, "change-registry.json"), "utf8") === "[]", notApplied.lines.slice(-1));
    for (const f of D.FILES) { const p = T.P(repo, f.rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.copyFileSync(path.join(PKG, f.staged), p); }
    const win = REC.run({ dataDir: dd, repo, now: at("2026-10-16T20:00:00Z"), log: () => {} });
    ok("J5 refused inside the 13:50-15:50 MT no-write window on a trading day", win.code === 2 && /no-write window/.test(win.lines.join(" ")), win.lines.slice(-1));
    const wrote = REC.run({ dataDir: dd, repo, now: at("2026-10-17T23:30:00Z"), log: () => {} });
    const cr = JSON.parse(fs.readFileSync(path.join(dd, "change-registry.json"), "utf8"));
    const led = fs.readFileSync(path.join(dd, "agent-ledger.jsonl"), "utf8").trim().split("\n");
    ok("J6 the write: one change-registry row and one GOVERNANCE ledger line, each read back", wrote.code === 0 && wrote.result === "written" && cr.length === 1 && cr[0].id === REC.CR_ID && led.length === 1 && JSON.parse(led[0]).changeRegistry === REC.CR_ID, wrote.lines.slice(-1));
    const twice = REC.run({ dataDir: dd, repo, now: at("2026-10-17T23:30:00Z"), log: () => {} });
    ok("J7 run again: ALREADY RECORDED, nothing added", twice.code === 0 && twice.result === "already" && JSON.parse(fs.readFileSync(path.join(dd, "change-registry.json"), "utf8")).length === 1, twice.lines.slice(-1));
    fs.writeFileSync(path.join(dd, "agent-ledger.jsonl"), "");
    const part = REC.run({ dataDir: dd, repo, now: at("2026-10-17T23:30:00Z"), log: () => {} });
    ok("J8 a PART of the record there already: refused, nothing written", part.code === 2 && /PART of this record/.test(part.lines.join(" ")) && fs.readFileSync(path.join(dd, "agent-ledger.jsonl"), "utf8") === "", part.lines.slice(-1));
    for (const d of [dd, repo]) fs.rmSync(d, { recursive: true, force: true }); }

  t0.cleanup();
  console.log(failN ? `\n${failN} OF ${pass + failN} CHECKS FAILED: ${failed.join(" | ")}` : `\nALL ${pass} CHECKS PASSED`);
  process.exitCode = failN ? 1 : 0;
})().catch((e) => {
  console.log(`  FAIL the selftest crashed — ${e && e.stack ? e.stack : e}`);
  console.log(`\n${failN + 1} OF ${pass + failN + 1} CHECKS FAILED (crash)`);
  process.exitCode = 1;
});
