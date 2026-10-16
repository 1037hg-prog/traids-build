#!/usr/bin/env node
"use strict";
/**
 * INDEX CHANGE COLLECTOR (2026-10-16) — SELFTEST.
 *
 *   node docs/index-change-collector/2026-10-16/selftest.cjs [--keep]
 *
 * It proves THIS PACKAGE'S STAGED BYTES, not the repository's: the staged files are copied into a
 * scratch tree under the OS temp directory (together with the one live file they depend on,
 * backend/lib/atomic-write.js, byte for byte from the repository) and everything is required from
 * there. Nothing in the repository is written. --keep leaves the scratch tree for inspection.
 *
 * It makes NO network call and needs no data: every check runs on the saved announcement pages in
 * fixtures/, which are FICTIONAL (invented companies, invented tickers, example.invalid URLs). The
 * expected answers below were written by hand from those pages, not generated from the code.
 *
 * WHAT IT CHECKS
 *   A. the staged files parse (node --check) and the two library layers hold no network client at all
 *   B. every well-formed fixture page, row by row: index, action, symbol, ANNOUNCEMENT date and basis,
 *      EFFECTIVE date and timing, the deletion reason, the name on the other side, the flags
 *   C. the refusals: a page whose only dates are effective dates yields NOTHING; misaligned table rows
 *      are counted and the rows around them are still read; indices we do not collect are counted
 *   D. the separation invariant: knownAt reads the announcement, no scalar date key exists,
 *      visibleAsOf and effectiveOn cannot be made to use an effective date as a knowledge date,
 *      and a postponement supersedes by changeKey while both effective dates stay selectable
 *   E. the fetch layer: it refuses to run without an injected fetcher, and a dead or empty page is a
 *      recorded problem rather than "zero changes"
 *   F. the write path: the dated JSONL and its provenance sidecar, written through
 *      backend/lib/atomic-write.js, idempotent on a second run, and --audit passes over the result
 *
 * It ends with one line: "ALL n CHECKS PASSED".
 */
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto");

const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");
const STAGED = path.join(PKG, "staged");
const FIX = path.join(PKG, "fixtures", "pages"), FIX_REFUSED = path.join(PKG, "fixtures", "refused");
const KEEP = process.argv.includes("--keep");
/** the live files the staged code requires and does NOT change: copied in byte for byte */
const LIVE_DEPS = Object.freeze(["backend/lib/atomic-write.js"]);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const checks = [];
function ok(name, pass, got, want) { checks.push({ name, pass: !!pass, got, want }); return !!pass; }
function eq(name, got, want) { const g = JSON.stringify(got), w = JSON.stringify(want); return ok(name, g === w, got, want); }

/* ─────────────────────── the scratch tree ─────────────────────── */

function copyTree(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyTree(s, d); }
    else fs.copyFileSync(s, d);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "index-change-collector-"));
fs.mkdirSync(path.join(TMP, "backend"), { recursive: true });
copyTree(STAGED, TMP);
for (const rel of LIVE_DEPS) {
  const src = path.join(REPO, ...rel.split("/"));
  if (!fs.existsSync(src)) { console.error(`SELFTEST CANNOT RUN: ${rel} is not in this repository, and the staged code requires it.`); process.exit(2); }
  const dst = path.join(TMP, ...rel.split("/"));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

const STAGED_FILES = Object.freeze(["backend/lib/index-changes.js", "backend/lib/index-changes-fetch.js", "backend/index-change-collector.js"]);

async function main() {
  /* ═══ A. the staged files, and what they can reach ═══ */

  for (const rel of STAGED_FILES) {
    const f = path.join(TMP, ...rel.split("/"));
    const r = cp.spawnSync(process.execPath, ["--check", f], { encoding: "utf8", windowsHide: true });
    ok(`A ${rel} parses (node --check)`, r.status === 0, String(r.stderr || "").trim().split("\n")[0] || "ok");
  }
  const SRC = {};
  for (const rel of STAGED_FILES) SRC[rel] = fs.readFileSync(path.join(TMP, ...rel.split("/")), "utf8");
  const NET_REQUIRE = /require\(\s*["'](?:node:)?(?:https?|net|tls|dns|dgram|child_process)["']\s*\)/;
  for (const rel of ["backend/lib/index-changes.js", "backend/lib/index-changes-fetch.js"]) {
    ok(`A ${rel} calls no fetch()`, !/\bfetch\s*\(/.test(SRC[rel]), (SRC[rel].match(/\bfetch\s*\(/g) || []).length);
    ok(`A ${rel} requires no transport module`, !NET_REQUIRE.test(SRC[rel]), (SRC[rel].match(NET_REQUIRE) || [])[0] || "none");
  }
  ok("A the parse layer reads no file and no clock", !/require\(\s*["'](?:node:)?fs["']/.test(SRC["backend/lib/index-changes.js"]) && !/Date\.now|new Date\s*\(\s*\)/.test(SRC["backend/lib/index-changes.js"]), "pure");
  eq("A exactly one fetch() in the whole change, in the collector's networkFetcher", (SRC["backend/index-change-collector.js"].match(/\bfetch\s*\(/g) || []).length, 1);
  ok("A the collector reaches the network only under --network", /if \(a\.dir\)[\s\S]{0,600}networkFetcher\(\)/.test(SRC["backend/index-change-collector.js"]), "guarded");

  const C = require(path.join(TMP, "backend", "index-change-collector.js"));
  const IC = C.IC, FETCH = C.FETCH;

  /* the collector's own embedded selftest, as a child process */
  const own = cp.spawnSync(process.execPath, [path.join(TMP, "backend", "index-change-collector.js"), "--selftest"], { encoding: "utf8", windowsHide: true, timeout: 120000 });
  const ownLast = String(own.stdout || "").trim().split("\n").pop() || "";
  ok(`A the collector's own --selftest is green (${ownLast})`, own.status === 0 && /^ALL \d+ CHECKS PASSED$/.test(ownLast), ownLast);

  /* ═══ B. the well-formed fixture pages, row by row ═══ */

  const sig = (r) => `${r.index}|${r.action}|${r.symbol}|${r.effective.iso || "-"}|${r.effective.timing || "-"}`;
  const parseFixture = (dir, name) => {
    const mf = JSON.parse(fs.readFileSync(path.join(dir, "sources.json"), "utf8"));
    const m = mf.find((x) => x.name === name);
    if (!m) throw new Error(`no source named ${name} in ${dir}/sources.json`);
    const raw = fs.readFileSync(path.join(dir, m.file), "utf8");
    const text = /\.html?$/i.test(m.file) ? C.htmlToText(raw) : raw;
    return IC.parsePage({ text, source: { name: m.name, url: m.url }, announced: m.announced || null, wantIndexes: m.indexes || null });
  };

  // ── the S&P table release, announced Friday 2026-09-04, effective Tuesday 2026-09-22 ──
  const T = parseFixture(FIX, "fixture-spdji-table");
  eq("B table: the 6 rows, written out by hand from the page", T.rows.map(sig).sort(), [
    "SP400|add|OMIC|2026-09-22|prior-to-open",
    "SP400|delete|KAPX|2026-09-22|prior-to-open",
    "SP500|add|ZETA|2026-09-22|prior-to-open",
    "SP500|delete|LMEX|2026-09-22|prior-to-open",
    "SP500|delete|OMIC|2026-09-22|prior-to-open",
    "SP600|add|KAPX|2026-09-22|prior-to-open",
  ]);
  eq("B table: the announcement date is the dateline, not the Tuesday in the same sentence", [T.release.announced.iso, T.release.announced.basis], ["2026-09-04", "dateline"]);
  eq("B table: every row is announced 2026-09-04", [...new Set(T.rows.map((r) => r.announced.iso))], ["2026-09-04"]);
  eq("B table: the two indices we do not collect are refused and named", T.skipped.map((s) => `${s.reason}:${s.detail}`).sort(), [
    `unknown-index:"S&P 500 ESG Index" is not one of SP500, SP400, SP600, NDX100`,
    `unknown-index:"S&P Composite 1500" is not one of SP500, SP400, SP600, NDX100`,
  ]);
  const zeta = T.rows.find((r) => r.symbol === "ZETA");
  eq("B table: ZETA carries LMEX as the name on the other side (from the replace sentence)", [zeta.counterparty.symbol, zeta.counterparty.company], ["LMEX", "Lambda Example Industries"]);
  const lmex = T.rows.find((r) => r.symbol === "LMEX");
  eq("B table: LMEX leaves because of an acquisition, and the words are kept", [lmex.reason, /being\s+acquired/.test(lmex.reasonRaw)], ["acquisition", true]);
  eq("B table: the deletion/addition split is 3 and 3", [T.rows.filter((r) => r.action === "add").length, T.rows.filter((r) => r.action === "delete").length], [3, 3]);
  eq("B table: OMIC moves down one index and KAPX moves down one index", T.rows.filter((r) => ["OMIC", "KAPX"].includes(r.symbol)).map((r) => `${r.symbol}:${r.index}:${r.action}`).sort(), ["KAPX:SP400:delete", "KAPX:SP600:add", "OMIC:SP400:add", "OMIC:SP500:delete"]);
  ok("B table: the trailing Company/Ticker table, which names no index or action, is not read", !T.rows.some((r) => r.parse.line > 20), T.rows.map((r) => r.parse.line));

  // ── the replace release, announced 2026-10-01 at 5:15 PM ET, effective Wednesday 2026-10-07 ──
  const R = parseFixture(FIX, "fixture-spdji-replace");
  eq("B replace: the 4 rows", R.rows.map(sig).sort(), [
    "SP400|add|IOTX|2026-10-07|prior-to-open",
    "SP400|delete|GAMM|2026-10-07|prior-to-open",
    "SP500|add|GAMM|2026-10-07|prior-to-open",
    "SP500|delete|DELT|2026-10-07|prior-to-open",
  ]);
  eq("B replace: the announcement clock time is read and kept with its zone", [R.release.announced.iso, R.release.announced.time, R.release.announced.timezone], ["2026-10-01", "17:15", "ET"]);
  eq("B replace: DELT leaves for an acquisition; GAMM is the name that replaces it", [R.rows.find((r) => r.symbol === "DELT").reason, R.rows.find((r) => r.symbol === "DELT").counterparty.symbol], ["acquisition", "GAMM"]);
  eq("B replace: the sentence and the table that repeat each other make ONE row for GAMM in the S&P 500", R.rows.filter((r) => r.symbol === "GAMM" && r.index === "SP500").length, 1);
  eq("B replace: IOTX comes from the one-sided sentence, not a table", R.rows.find((r) => r.symbol === "IOTX").parse.rule, "one-sided");

  // ── the postponement, announced 2026-09-10 ──
  const P = parseFixture(FIX, "fixture-spdji-postponed");
  eq("B postponed: the 2 rows, on the NEW effective date", P.rows.map(sig).sort(), [
    "SP500|add|ZETA|2026-09-29|prior-to-open",
    "SP500|delete|LMEX|2026-09-29|prior-to-open",
  ]);
  eq("B postponed: the page's own date is 2026-09-10 — NOT the 'announced on September 4, 2026' it refers to", [P.release.announced.iso, P.release.announced.basis], ["2026-09-10", "dateline"]);

  // ── the HTML page, announced 2026-08-03, effective Monday 2026-08-10 ──
  const H = parseFixture(FIX, "fixture-spdji-smallcap-html");
  eq("B html: the 2 rows, through html-to-text", H.rows.map(sig).sort(), [
    "SP600|add|MUEX|2026-08-10|prior-to-open",
    "SP600|delete|XIEX|2026-08-10|prior-to-open",
  ]);
  eq("B html: the Reason column is read on both rows", H.rows.map((r) => `${r.symbol}:${r.reason}`).sort(), ["MUEX:market-cap", "XIEX:acquisition"]);
  eq("B html: the date inside the <script> tag is not read as anything", [H.release.announced.iso, H.release.announced.time], ["2026-08-03", "17:15"]);

  // ── the Nasdaq-100 annual reconstitution, announced 2025-12-12, effective Monday 2025-12-22 ──
  const N = parseFixture(FIX, "fixture-nasdaq-recon");
  eq("B recon: the 6 rows, three added and three removed", N.rows.map(sig).sort(), [
    "NDX100|add|ALEX|2025-12-22|prior-to-open",
    "NDX100|add|CHIX|2025-12-22|prior-to-open",
    "NDX100|add|UPSX|2025-12-22|prior-to-open",
    "NDX100|delete|BEXI|2025-12-22|prior-to-open",
    "NDX100|delete|NUEX|2025-12-22|prior-to-open",
    "NDX100|delete|RHOX|2025-12-22|prior-to-open",
  ]);
  eq("B recon: the abbreviated dateline month is read (Dec. 12, 2025)", N.release.announced.iso, "2025-12-12");
  eq("B recon: every row says its effective date came from the release's prose, not its own section", [...new Set(N.rows.map((r) => r.flags.join(",")))], ["effective-from-release-default"]);
  eq("B recon: the Company Name / Ticker header line is not read as a constituent", N.rows.filter((r) => /company|ticker/i.test(r.company || "")).length, 0);
  eq("B recon: the prose after the second list does not become rows", N.rows.length, 6);

  // ── the Nasdaq-100 interim change, announced 2026-02-02 by a labelled field ──
  const I = parseFixture(FIX, "fixture-nasdaq-interim");
  eq("B interim: the 3 rows, one of them with no effective date yet", I.rows.map(sig).sort(), [
    "NDX100|add|NUEX|2026-02-06|prior-to-open",
    "NDX100|delete|PHIX|-|-",
    "NDX100|delete|PSIM|2026-02-06|prior-to-open",
  ]);
  eq("B interim: the announcement date comes from the labelled field", [I.release.announced.iso, I.release.announced.basis], ["2026-02-02", "explicit-field"]);
  const phix = I.rows.find((r) => r.symbol === "PHIX");
  eq("B interim: PHIX is announced but not yet dated, and says so", [phix.effective.iso, phix.effective.qualifier, phix.flags, phix.eventKey], [null, "to-be-announced", ["no-effective-date"], "NDX100|delete|PHIX|effective-unknown"]);
  eq("B interim: PHIX is still knowable — on 2026-02-02", phix.knownAt.iso, "2026-02-02");

  /* ═══ C. the refusals ═══ */

  const E = parseFixture(FIX_REFUSED, "fixture-effective-only");
  eq("C a page whose only dates are EFFECTIVE dates produces no rows at all", E.rows.length, 0);
  eq("C and says exactly why", E.skipped.map((s) => s.reason), ["no-announcement-date"]);
  ok("C and the problem names the trap", E.problems.some((p) => /never read as an announcement date/.test(p)), E.problems);
  eq("C its 3 effective dates are counted, not promoted", /states 3 date\(s\)/.test(E.skipped[0].detail), true);

  const M = parseFixture(FIX_REFUSED, "fixture-misaligned");
  eq("C a misaligned row does not cost the rows around it", M.rows.map(sig).sort(), ["SP400|add|SIGX|2026-09-28|prior-to-open", "SP600|delete|TAUX|2026-09-28|prior-to-open"]);
  eq("C both misaligned rows are counted as unparsed-row", M.skipped.filter((s) => s.reason === "unparsed-row").length, 2);
  ok("C and the count is reported as a problem, not swallowed", M.problems.some((p) => /2 table row\(s\) did not match their header/.test(p)), M.problems);

  eq("C a lower-case or prose cell is not a ticker", [IC.normalizeTicker("zeta"), IC.normalizeTicker("Information Technology"), IC.normalizeTicker("BRK.B"), IC.normalizeTicker("BF-B")], [null, null, "BRK.B", "BF-B"]);
  eq("C an ambiguous d/m/Y date is refused, not guessed", [IC.parseDateLoose("22/09/2026"), (IC.parseDateLoose("09/22/2026") || {}).iso], [null, "2026-09-22"]);
  eq("C an impossible date is refused", [IC.parseDateLoose("February 30, 2026"), (IC.parseDateLoose("February 29, 2028") || {}).iso], [null, "2028-02-29"]);
  eq("C a style or sector index is not one of the four", [IC.normalizeIndex("S&P 500 ESG Index"), IC.normalizeIndex("S&P 500 Equal Weight Index"), IC.normalizeIndex("S&P Composite 1500"), IC.normalizeIndex("S&P 500"), IC.normalizeIndex("Nasdaq-100 Index")], [null, null, null, "SP500", "NDX100"]);

  /* ═══ D. the separation invariant ═══ */

  const ALL = [].concat(T.rows, R.rows, P.rows, H.rows, N.rows, I.rows);
  eq("D every row's knownAt reads the announcement, with basis \"announced\"", ALL.filter((r) => !(r.knownAt.basis === "announced" && r.knownAt.iso === r.announced.iso)).length, 0);
  eq("D no row carries a scalar date key", ALL.filter((r) => IC.FORBIDDEN_ROW_KEYS.some((k) => k in r)).length, 0);
  eq("D auditSeparation passes over all 23 rows", [IC.auditSeparation(ALL).ok, IC.auditSeparation(ALL).checked], [true, 23]);
  for (const k of ["date", "effectiveDate", "announcedDate", "timestamp"]) ok(`D auditSeparation FAILS a row that grows a scalar "${k}" key`, !IC.auditSeparation([{ ...ALL[0], [k]: "2026-09-22" }]).ok, "refused");
  ok("D auditSeparation FAILS a row whose knownAt was set from the effective date", !IC.auditSeparation([{ ...zeta, knownAt: { iso: zeta.effective.iso, basis: "announced" } }]).ok, "refused");
  ok("D makeRow THROWS on an announcement basis that is not one of the three", (() => { try { IC.makeRow({ indexPhrase: "S&P 500", actionPhrase: "add", ticker: "ZZZZ", company: "Zzz Example", announced: { iso: "2026-09-04", basis: "from-effective" }, effective: { iso: "2026-09-22" }, source: {}, parse: {} }); return false; } catch (e) { return /may never be derived from an effective date/.test(e.message); } })(), "threw");
  eq("D the closed list of announcement bases does not mention the effective date", IC.ANNOUNCED_BASES, ["dateline", "explicit-field", "supplied"]);

  eq("D visibleAsOf: nothing is known the day before the announcement", IC.visibleAsOf(T.rows, "2026-09-03").length, 0);
  eq("D visibleAsOf: nothing is known ON the announcement day by default", IC.visibleAsOf(T.rows, "2026-09-04").length, 0);
  eq("D visibleAsOf: everything is known the day after", IC.visibleAsOf(T.rows, "2026-09-05").length, 6);
  eq("D visibleAsOf: sameDay \"include\" is the caller's explicit choice", IC.visibleAsOf(T.rows, "2026-09-04", { sameDay: "include" }).length, 6);
  eq("D visibleAsOf: sameDay \"time\" compares the announcement clock, 5:15 PM ET", [IC.visibleAsOf(R.rows, "2026-10-01T16:00", { sameDay: "time" }).length, IC.visibleAsOf(R.rows, "2026-10-01T18:00", { sameDay: "time" }).length], [0, 4]);
  eq("D visibleAsOf: the EFFECTIVE date never makes a row visible", IC.visibleAsOf(T.rows, "2026-09-22").length, 6);
  eq("D visibleAsOf: and never hides one either", IC.visibleAsOf(T.rows, "2026-09-05").length, IC.visibleAsOf(T.rows, "2027-01-01").length);
  ok("D visibleAsOf refuses an unknown sameDay mode", (() => { try { IC.visibleAsOf(T.rows, "2026-09-05", { sameDay: "effective" }); return false; } catch { return true; } })(), "threw");
  ok("D effectiveOn refuses to run without an explicit asOf", (() => { try { IC.effectiveOn(T.rows, "2026-09-22"); return false; } catch (e) { return /not a knowledge date/.test(e.message); } })(), "threw");
  eq("D effectiveOn(2026-09-22, asOf 2026-09-05) is the 6 changes of that day", IC.effectiveOn(T.rows, "2026-09-22", { asOf: "2026-09-05" }).length, 6);
  eq("D effectiveOn(2026-09-22, asOf 2026-09-03) is empty: nobody knew yet", IC.effectiveOn(T.rows, "2026-09-22", { asOf: "2026-09-03" }).length, 0);

  const Z = [].concat(T.rows, P.rows);
  eq("D the postponement: the plan for ZETA on 2026-09-08 is still the 22nd", IC.planKnownAsOf(Z, "2026-09-08").filter((r) => r.symbol === "ZETA").map((r) => r.effective.iso), ["2026-09-22"]);
  eq("D the postponement: the plan for ZETA on 2026-09-12 is the 29th", IC.planKnownAsOf(Z, "2026-09-12").filter((r) => r.symbol === "ZETA").map((r) => r.effective.iso), ["2026-09-29"]);
  eq("D both effective dates stay selectable by eventKey, because the flow moved day", IC.latestKnownAsOf(Z, "2026-09-12").filter((r) => r.symbol === "ZETA").map((r) => r.effective.iso), ["2026-09-22", "2026-09-29"]);
  eq("D the postponement shares ZETA's changeKey and not its eventKey", [Z.filter((r) => r.changeKey === "SP500|add|ZETA").length, new Set(Z.filter((r) => r.symbol === "ZETA").map((r) => r.eventKey)).size], [2, 2]);

  const back = IC.makeRow({ indexPhrase: "S&P 500", actionPhrase: "delete", ticker: "WIER", company: "Wier Example Co", announced: { iso: "2026-09-10", basis: "dateline" }, effective: { iso: "2026-09-04" }, source: {}, parse: {} }).row;
  eq("D an effective date BEFORE its announcement is kept and flagged, never dropped", [back.flags, IC.auditSeparation([back]).counts.effectiveBeforeAnnounced], [["effective-before-announced"], 1]);
  ok("D and auditSeparation fails it if the flag is ever removed", !IC.auditSeparation([{ ...back, flags: [] }]).ok, "refused");

  /* ═══ E. the fetch layer ═══ */

  ok("E collect() throws without an injected fetcher", await (async () => { try { await FETCH.collect({ sources: [{ name: "x", url: "u" }] }); return false; } catch (e) { return /a fetcher must be injected/.test(e.message); } })(), "threw");
  ok("E collect() refuses a source with an unknown field", await (async () => { try { await FETCH.collect({ sources: [{ name: "x", url: "u", file: "p.txt" }], fetcher: FETCH.textFetcher({}) }); return false; } catch (e) { return /unknown field "file"/.test(e.message); } })(), "threw");
  ok("E collect() refuses a source asking for an index we do not collect", await (async () => { try { await FETCH.collect({ sources: [{ name: "x", url: "u", indexes: ["DJIA"] }], fetcher: FETCH.textFetcher({}) }); return false; } catch (e) { return /not one of SP500/.test(e.message); } })(), "threw");
  const dead = await FETCH.collect({ sources: [{ name: "dead", url: "u" }], fetcher: async () => ({ ok: false, status: 503, text: "" }) });
  eq("E a dead page is a recorded problem, not zero changes", [dead.rows.length, dead.pages[0].ok, dead.problems.length], [0, false, 1]);
  const empty = await FETCH.collect({ sources: [{ name: "empty", url: "u" }], fetcher: async () => ({ ok: true, status: 200, text: "   \n  " }) });
  ok("E an empty page is a recorded problem, not zero changes", empty.problems.length === 1 && /NOT as zero changes/.test(empty.problems[0]), empty.problems);
  const threw = await FETCH.collect({ sources: [{ name: "boom", url: "u" }, { name: "fine", url: "v" }], fetcher: async (u) => { if (u === "u") throw new Error("socket closed"); return { ok: true, status: 200, text: fs.readFileSync(path.join(FIX, "spdji-table-2026-09-04.txt"), "utf8") }; } });
  eq("E one source throwing does not lose the others", [threw.rows.length, threw.problems.length], [6, 1]);
  const PROV = "NEW YORK, September 4, 2026: Zeta Example Corp (NYSE: ZETA) will replace Lambda Example Industries (NYSE: LMEX) in the S&P 500 effective prior to the open of trading on Tuesday, September 22, 2026.\n";
  const prov = await FETCH.collect({ sources: [{ name: "p", url: "u" }], fetcher: FETCH.textFetcher({ u: PROV }), now: () => Date.parse("2026-10-16T12:00:00Z") });
  eq("E provenance: every row carries the sha256 and byte length of the text that was parsed, and when", [
    prov.rows.length,
    prov.rows.every((r) => r.source.sha256 === FETCH.sha256(PROV)),
    prov.rows.every((r) => r.source.bytes === Buffer.byteLength(PROV, "utf8")),
    prov.rows[0].source.fetchedAt,
    prov.pages[0].sha256 === FETCH.sha256(PROV),
  ], [2, true, true, "2026-10-16T12:00:00.000Z", true]);

  /* ═══ F. the write path ═══ */

  const OUT = path.join(TMP, "out");
  const sp = C.savedPages(FIX);
  eq("F the manifest names 6 pages and strips its own \"file\" field before the fetch layer", [sp.sources.length, sp.sources.every((s) => !("file" in s))], [6, true]);
  const run1 = await C.collectRun({ sources: sp.sources, fetcher: sp.fetcher, outDir: OUT, date: "2026-10-16", now: () => Date.parse("2026-10-16T12:00:00Z") });
  eq("F the run would add 23 rows to a dated file and report no problem", [run1.added.length, run1.already.length, run1.problems.length, path.basename(run1.file)], [23, 0, 0, "index-changes-2026-10-16.jsonl"]);

  fs.mkdirSync(OUT, { recursive: true });
  const { writeJsonAtomic, writeTextAtomic } = require(path.join(TMP, "backend", "lib", "atomic-write.js"));
  writeTextAtomic(run1.file, run1.rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeJsonAtomic(run1.pagesFile, C.pagesRecord(run1, sp.sources));
  const lines = fs.readFileSync(run1.file, "utf8").trim().split("\n");
  eq("F the file holds 23 one-line JSON rows", [lines.length, lines.every((l) => { try { return JSON.parse(l).schema === IC.SCHEMA; } catch { return false; } })], [23, true]);
  const side = JSON.parse(fs.readFileSync(run1.pagesFile, "utf8"));
  eq("F the sidecar records every page's sha256 and byte length", [side.pages.length, side.pages.every((p) => p.sha256.length === 64 && p.bytes > 0), side.counts.added], [6, true, 23]);
  eq("F the sidecar keeps the refused rows with their reasons", side.skipped.map((s) => s.reason).sort(), ["unknown-index", "unknown-index"]);

  const run2 = await C.collectRun({ sources: sp.sources, fetcher: sp.fetcher, outDir: OUT, date: "2026-10-16", now: () => Date.parse("2026-10-17T12:00:00Z") });
  eq("F a second run on the same pages adds nothing and still reads 23 rows", [run2.added.length, run2.already.length, run2.rows.length], [0, 23, 23]);

  const au = cp.spawnSync(process.execPath, [path.join(TMP, "backend", "index-change-collector.js"), "--audit", "--date", "2026-10-16", "--out", OUT], { encoding: "utf8", windowsHide: true, timeout: 120000 });
  ok("F --audit over the written file passes", au.status === 0 && /AUDIT PASSED\./.test(String(au.stdout)), String(au.stdout || "").trim().split("\n").pop());

  const dry = cp.spawnSync(process.execPath, [path.join(TMP, "backend", "index-change-collector.js"), "--dir", FIX, "--dry", "--date", "2026-10-16", "--out", path.join(TMP, "nowhere")], { encoding: "utf8", windowsHide: true, timeout: 120000 });
  ok("F --dry writes nothing and says so", dry.status === 0 && /DRY RUN — nothing was written\. 23 row\(s\) would be added/.test(String(dry.stdout)) && !fs.existsSync(path.join(TMP, "nowhere")), String(dry.stdout || "").trim().split("\n").pop());
  const noMode = cp.spawnSync(process.execPath, [path.join(TMP, "backend", "index-change-collector.js")], { encoding: "utf8", windowsHide: true });
  ok("F with no mode the collector refuses and never reaches the network", noMode.status === 2 && /no mode given/.test(String(noMode.stderr)), String(noMode.stderr || "").trim().split("\n")[0]);
  const idx = cp.spawnSync(process.execPath, [path.join(TMP, "backend", "index-change-collector.js"), "--dir", FIX, "--dry", "--indexes", "NDX100"], { encoding: "utf8", windowsHide: true, timeout: 120000 });
  ok("F --indexes NDX100 keeps only the Nasdaq-100 rows (9 of the 23)", idx.status === 0 && /9 row\(s\) would be added/.test(String(idx.stdout)), String(idx.stdout || "").trim().split("\n").pop());

  /* ═══ G. the package's own deploy and rollback, against a scratch repository ═══
     A cloud session never applies at home (AGENTS.md), so the write modes are driven here with an
     injected repo: a scratch tree holding only the live file the staged code needs. */

  const L = require(path.join(PKG, "lib.cjs"));
  eq("G the file table says every path is NEW (no base copy to restore)", L.FILES.map((f) => f.baseSha), [null, null, null]);
  eq("G the staged sha256 in the file table is the staged bytes on disk", L.FILES.map((f) => sha(fs.readFileSync(path.join(PKG, ...f.staged.split("/")))) === f.stagedSha), [true, true, true]);
  eq("G base/ holds no file copy, only its README", fs.readdirSync(path.join(PKG, "base")).sort(), ["README.md"]);

  const SREPO = path.join(TMP, "scratch-repo");
  for (const rel of LIVE_DEPS) { const dst = path.join(SREPO, ...rel.split("/")); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(REPO, ...rel.split("/")), dst); }
  const P0 = L.plan({ repo: SREPO, pkg: PKG });
  eq("G a repository without the files: every path absent, nothing refused", [P0.absent, P0.toCreate.length, P0.problems.length], [true, 3, 0]);

  const Mk = L.make({ repo: SREPO, pkg: PKG, log: () => {} });
  const up = Mk.writeUnit({ to: "staged", gate: null });
  eq("G deploy's write unit creates all three paths", [up.result, up.done], ["done", L.FILES.map((f) => f.rel)]);
  eq("G each written path is byte for byte the staged copy and parses", L.FILES.map((f) => {
    const p = path.join(SREPO, ...f.rel.split("/"));
    return sha(fs.readFileSync(p)) === f.stagedSha && cp.spawnSync(process.execPath, ["--check", p], { windowsHide: true }).status === 0;
  }), [true, true, true]);
  eq("G the plan now reads applied, and a second apply is a no-op", [L.plan({ repo: SREPO, pkg: PKG }).applied, Mk.writeUnit({ to: "staged", gate: null }).result], [true, "noop"]);

  fs.writeFileSync(path.join(SREPO, "backend", "lib", "index-changes.js"), "// someone else's bytes\n");
  const drift = L.plan({ repo: SREPO, pkg: PKG });
  ok("G a path holding other bytes is DRIFT and refuses the whole unit", drift.problems.some((p) => /exists at home with other bytes/.test(p)) && Mk.writeUnit({ to: "staged", gate: null }).result === "refused", drift.problems);
  ok("G and a rollback refuses it too — it never deletes bytes it did not write", Mk.writeUnit({ to: "absent", gate: null }).result === "refused", "refused");
  L.writeExact(path.join(SREPO, "backend", "lib", "index-changes.js"), fs.readFileSync(path.join(PKG, "staged", "backend", "lib", "index-changes.js")));

  const down = Mk.writeUnit({ to: "absent", gate: null });
  eq("G rollback's write unit removes all three paths", [down.result, down.done], ["done", L.FILES.map((f) => f.rel)]);
  eq("G the scratch repository is back to the base state: the three paths are absent", [L.plan({ repo: SREPO, pkg: PKG }).absent, fs.existsSync(path.join(SREPO, "backend", "index-change-collector.js"))], [true, false]);
  eq("G and the live file the code needed was never touched", sha(fs.readFileSync(path.join(SREPO, "backend", "lib", "atomic-write.js"))), sha(fs.readFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"))));

  const notGreen = L.make({ repo: SREPO, pkg: PKG, log: () => {}, run: () => ({ status: 1, out: "3 of 94 CHECKS FAILED\n" }) }).selftestGate;
  ok("G the gate refuses a selftest that is not green", !notGreen.run().ok, notGreen.run().line);
  const green = L.make({ repo: SREPO, pkg: PKG, log: () => {}, run: () => ({ status: 0, out: "ALL 94 CHECKS PASSED\n" }) }).selftestGate;
  ok("G and accepts one that is", green.run().ok, green.run().line);
  const gated = L.make({ repo: SREPO, pkg: PKG, log: () => {}, run: () => ({ status: 1, out: "1 of 94 CHECKS FAILED\n" }) });
  const refusedByGate = gated.writeUnit({ to: "staged", gate: gated.selftestGate });
  eq("G a failing gate means nothing is written", [refusedByGate.result, fs.existsSync(path.join(SREPO, "backend", "index-change-collector.js"))], ["refused", false]);

  const dp = cp.spawnSync(process.execPath, [path.join(PKG, "deploy.cjs"), "--plan"], { encoding: "utf8", windowsHide: true, timeout: 120000 });
  ok("G deploy.cjs --plan is read-only and exits 0 in this repository", dp.status === 0 && /read-only, nothing is written/.test(String(dp.stdout)) && !fs.existsSync(path.join(REPO, "backend", "index-change-collector.js")), `exit ${dp.status}`);
  const rp = cp.spawnSync(process.execPath, [path.join(PKG, "rollback.cjs"), "--plan"], { encoding: "utf8", windowsHide: true, timeout: 120000 });
  ok("G rollback.cjs --plan is read-only and exits 0 in this repository", rp.status === 0 && /nothing was written/.test(String(rp.stdout)), `exit ${rp.status}`);
  for (const s of ["deploy.cjs", "rollback.cjs"]) { const u = cp.spawnSync(process.execPath, [path.join(PKG, s)], { encoding: "utf8", windowsHide: true }); ok(`G ${s} with no mode prints usage and does nothing (exit 2)`, u.status === 2 && /Nothing was done\./.test(String(u.stdout) + String(u.stderr)), `exit ${u.status}`); }
  // ICC_NESTED stops record.cjs running THIS selftest again (it cites it as evidence), which would recurse.
  const rec = cp.spawnSync(process.execPath, [path.join(PKG, "record.cjs"), "--dry"], { encoding: "utf8", windowsHide: true, timeout: 300000, env: { ...process.env, ICC_NESTED: "1" } });
  const recOut = String(rec.stdout || "");
  ok("G record.cjs --dry prints the change-registry row and registers no test", rec.status === 0 && /this change registers no test/.test(recOut) && /"registersNoTest": true/.test(recOut) && /"category": "tooling"/.test(recOut), `exit ${rec.status}: ${recOut.split("\n")[0]}`);
  ok("G record.cjs never names test-registry.json as something it writes", !/would (?:append|write) to test-registry/.test(recOut) && !/"tests": \[[^\]]/.test(recOut), "clean");

  /* ─── the verdict ─── */

  const bad = checks.filter((c) => !c.pass);
  for (const c of checks) console.log(`  ${c.pass ? "ok  " : "FAIL"} ${c.name}${c.pass ? "" : `\n         got:  ${JSON.stringify(c.got)}\n         want: ${JSON.stringify(c.want)}`}`);
  console.log("");
  if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`  scratch tree kept: ${TMP}`);
  if (bad.length) { console.log(`${bad.length} of ${checks.length} CHECKS FAILED`); return 1; }
  console.log(`staged files proven: ${STAGED_FILES.map((f) => `${f} sha256 ${sha(fs.readFileSync(path.join(STAGED, ...f.split("/")))).slice(0, 12)}`).join("  ·  ")}`);
  console.log(`ALL ${checks.length} CHECKS PASSED`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { try { if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* the scratch tree stays */ } console.error(`SELFTEST THREW: ${e && e.stack ? e.stack : e}`); process.exit(1); });
