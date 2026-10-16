#!/usr/bin/env node
"use strict";
/**
 * SELFTEST — filing wording collector (backlog row 25), 2026-10-16. Proves the package on its fixtures, with no network, no key
 * and no data of any kind: the five filings under fixtures/ are a few paragraphs written for this package about two companies that
 * do not exist.
 *
 *   node docs/wording-change/2026-10-16/selftest.cjs            every check; the last line is ALL <n> CHECKS PASSED or FAILED
 *   node docs/wording-change/2026-10-16/selftest.cjs --keep     the same, and leaves the scratch tree behind, printing where
 *
 * ── WHY A SCRATCH TREE ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * The three staged files are CommonJS, because backend/package.json has no "type" field. Under docs/ the ROOT package.json applies
 * and it says "type": "module", so a staged .js file run where it sits is read as an ES module and will not even load. So every
 * check that runs the code copies the staged files into a scratch tree shaped like the repo — <tmp>/package.json (no type),
 * <tmp>/backend/..., plus the live backend/lib/atomic-write.js the collector writes JSON through — and runs them there. That is
 * also how deploy.cjs --apply is exercised: against the scratch tree, never against this repository.
 *
 * ── WHAT IS CHECKED ────────────────────────────────────────────────────────────────────────────────────────────────────────
 *   1 package      the staged files are the bytes deploy.cjs records, they parse, and the fixture manifest is current
 *   2 units        each staged file's own --selftest, run as a child process, must end PASSED
 *   3 fixtures     the parse layer on the five saved filings: the sections found and the scores, stated here as numbers
 *   4 store        a real run writes one file per company, through writeJsonAtomic, and re-running changes nothing
 *   5 fetch        the fetch layer over a fake EDGAR built from the same fixtures: the rate limit, a 429, a missing document
 *   6 house rules  no network, no secret, no personal detail, no test registration, no order, no JSON written any other way
 *   7 deploy       a whole apply and rollback in the scratch tree, including a refusal on drift
 */
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", ".."), PKG_REL = "docs/wording-change/2026-10-16";
const D = require(path.join(PKG, "deploy.cjs"));
const R = require(path.join(PKG, "rollback.cjs"));
const MK = require(path.join(PKG, "fixtures", "make-fixtures.cjs"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : " — " + detail)); } };
const head = (s) => console.log("\n== " + s);
const threw = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

/** the scratch tree: the repo's shape, the staged files, and the one live file they require */
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wording-selftest-"));
  fs.mkdirSync(path.join(root, "backend", "lib"), { recursive: true });
  // no "type" field, so the staged .js files are read as CommonJS exactly as they are at backend/ in the real repo
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "wording-selftest-tree", private: true }, null, 1) + "\n");
  for (const f of D.FILES) fs.copyFileSync(path.join(PKG, ...f.staged.split("/")), path.join(root, ...f.rel.split("/")));
  fs.copyFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"), path.join(root, "backend", "lib", "atomic-write.js"));
  return root;
}
const node = (file, args, cwd) => cp.spawnSync(process.execPath, [file, ...args], { cwd: cwd || REPO, encoding: "utf8", timeout: 600000, windowsHide: true, maxBuffer: 64 << 20 });

const TREE = makeTree();
const C = require(path.join(TREE, "backend", "filing-wording-collector.js"));
const S = require(path.join(TREE, "backend", "lib", "filing-sections.js"));
const F = require(path.join(TREE, "backend", "lib", "sec-fetch.js"));
const FIX = path.join(PKG, "fixtures");

// ── 1 package ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
head("1 package");
ok("the package ships exactly three new files, all under backend/, and nothing else is staged",
  D.FILES.length === 3 && D.FILES.every((f) => f.rel.startsWith("backend/")) &&
  JSON.stringify(D.FILES.map((f) => f.rel).sort()) === JSON.stringify(["backend/filing-wording-collector.js", "backend/lib/filing-sections.js", "backend/lib/sec-fetch.js"]),
  JSON.stringify(D.FILES.map((f) => f.rel)));
ok("every staged file hashes to the sha256 deploy.cjs records (run deploy.cjs --restage after editing staged/)",
  D.FILES.every((f) => sha(fs.readFileSync(path.join(PKG, ...f.staged.split("/")))) === f.stagedSha),
  D.FILES.map((f) => `${f.rel} ${sha(fs.readFileSync(path.join(PKG, ...f.staged.split("/")))).slice(0, 12)} vs ${f.stagedSha.slice(0, 12)}`).join("; "));
ok("every staged file parses under this Node", D.FILES.every((f) => node("--check", [path.join(PKG, ...f.staged.split("/"))]).status === 0));
ok("none of the three files exists in the live tree yet, so this package only creates", D.plan().states.every((s) => s.state === "absent" || s.state === "applied"), JSON.stringify(D.plan().states.map((s) => [s.rel, s.state])));
ok("base/ is empty but for the note that says why", fs.readdirSync(path.join(PKG, "base")).join() === "EMPTY.md");
ok("the fixture manifest on disk is what make-fixtures.cjs generates (it is written through writeJsonAtomic, never by hand)", node(path.join(PKG, "fixtures", "make-fixtures.cjs"), ["--check"]).status === 0);
ok("the fixtures the manifest names are all there, and there is no fixture the manifest does not name",
  MK.FILINGS.every((f) => fs.existsSync(path.join(FIX, f.file))) &&
  fs.readdirSync(FIX).filter((n) => /\.(txt|htm|html)$/.test(n)).sort().join() === MK.FILINGS.map((f) => f.file).sort().join(),
  fs.readdirSync(FIX).join());

// ── 2 each file's own selftest ─────────────────────────────────────────────────────────────────────────────────────────────
head("2 the staged files' own selftests");
for (const f of D.FILES) {
  const r = node(path.join(TREE, ...f.rel.split("/")), ["--selftest"], TREE);
  const out = String(r.stdout || "") + String(r.stderr || "");
  const last = out.trim().split("\n").pop() || "";
  const counted = /(\d+) passed, 0 failed — PASSED$/.exec(last);
  ok(`${f.rel} --selftest passes (${counted ? counted[1] : "?"} checks)`, r.status === 0 && !!counted && Number(counted[1]) > 0, last || `exit ${r.status}`);
}
ok("the three selftests together run more than sixty checks, so a file that quietly stopped testing itself would show",
  [...D.FILES].reduce((n, f) => n + Number((/(\d+) passed, 0 failed/.exec(String(node(path.join(TREE, ...f.rel.split("/")), ["--selftest"], TREE).stdout || "").trim().split("\n").pop() || "") || [0, 0])[1]), 0) >= 60,
  String([...D.FILES].reduce((n, f) => n + Number((/(\d+) passed, 0 failed/.exec(String(node(path.join(TREE, ...f.rel.split("/")), ["--selftest"], TREE).stdout || "").trim().split("\n").pop() || "") || [0, 0])[1]), 0)));

// ── 3 the parse layer on the saved filings ─────────────────────────────────────────────────────────────────────────────────
head("3 the parse layer on the five saved filings");
const text = (file) => fs.readFileSync(path.join(FIX, file), "utf8");
const k24 = S.splitSections(text("zzzz-10k-2024.txt"), { form: "10-K" });
const k25 = S.splitSections(text("zzzz-10k-2025.txt"), { form: "10-K" });
const q24 = S.splitSections(text("zzzz-10q-2024q1.txt"), { form: "10-Q" });
const q25 = S.splitSections(text("zzzz-10q-2025q1.txt"), { form: "10-Q" });
const y25 = S.splitSections(text("yyyy-10k-2025.htm"), { form: "10-K" });

ok("the 2024 10-K splits into Item 1, 1A, 1B and 3 of Part I and Item 7 of Part II — and the table of contents at its front is not mistaken for them",
  k24.found.join() === "item1,item1a,item1b,item3,item7" && k24.warnings.length === 0 && !/TABLE OF CONTENTS/.test(k24.sections[0].text), JSON.stringify(k24.found) + " " + JSON.stringify(k24.warnings));
ok("the 2025 10-K splits into the same five plus Item 7A, which that year's filing added",
  k25.found.join() === "item1,item1a,item1b,item3,item7,item7a" && k25.warnings.length === 0, JSON.stringify(k25.found));
ok("each section holds its own text and stops where the next one starts",
  /designs, assembles and sells widgets/.test(k25.sections[0].text) && !/Risk Factors|out of fashion/.test(k25.sections[0].text) &&
  /contract manufacturer/.test(k25.sections[1].text) && k25.sections[2].text === "beta gamma gamma delta", JSON.stringify(k25.sections[2].text));
ok("the last section stops at the signature page, so the signature paragraph is in no section",
  k25.sections.every((s) => !/thereunto duly authorised/.test(s.text)) && k24.sections.every((s) => !/thereunto duly authorised/.test(s.text)));
ok("the two 10-Qs split into Part I Items 1, 2 and 4 and Part II Items 1, 1A and 6, with the two Item 1s kept apart",
  q24.found.join() === "p1item1,p1item2,p1item4,p2item1,p2item1a,p2item6" && q25.found.join() === q24.found.join() &&
  /unaudited condensed financial statements/.test(S.sectionTexts(q25).p1item1) && /no material pending legal proceedings/.test(S.sectionTexts(q25).p2item1), JSON.stringify(q24.found));
ok("the filing saved as HTML is read as text: the tags, the script and the style block are gone, the entities are decoded, and it splits into four sections",
  y25.found.join() === "item1,item1a,item3,item7" && !/<|&nbsp;|&#39;|page-break/.test(y25.sections.map((s) => s.text).join(" ")) &&
  /builders & fitters/.test(S.sectionTexts(y25).item1) && /Management's Discussion/.test(y25.sections[3].title), JSON.stringify(y25.found));
ok("a 10-K read as a 10-Q, or the other way round, does not quietly produce sections of the wrong form",
  S.splitSections(text("zzzz-10k-2025.txt"), { form: "10-Q" }).found.every((id) => /^p[12]item/.test(id)) && S.splitSections(text("zzzz-10q-2025q1.txt"), { form: "10-K" }).found.every((id) => /^item/.test(id)));

// ── 4 the collector, and what it records ───────────────────────────────────────────────────────────────────────────────────
head("4 the collector on the fixtures, and the store");
const DATA = path.join(TREE, "backend", "data");
const run1 = C.runFromDir({ dir: FIX, dataRoot: DATA, dry: true, now: () => new Date("2026-10-16T00:00:00Z"), log: () => { } });
ok("--dry reads every fixture, scores it, and writes nothing", run1.dry === true && run1.wrote.length === 0 && !fs.existsSync(path.join(DATA, "filing-wording")) && run1.companies.length === 2);

const run2 = C.runFromDir({ dir: FIX, dataRoot: DATA, now: () => new Date("2026-10-16T00:00:00Z"), log: () => { } });
ok("a real run writes one file per company and nothing else", run2.wrote.length === 2 && fs.readdirSync(path.join(DATA, "filing-wording")).sort().join() === "0000000001.json,0000000002.json", fs.readdirSync(path.join(DATA, "filing-wording")).join());
ok("no temporary file is left behind by the atomic write", fs.readdirSync(path.join(DATA, "filing-wording")).every((n) => !/\.tmp/.test(n)));

const store1 = JSON.parse(fs.readFileSync(path.join(DATA, "filing-wording", "0000000001.json"), "utf8"));
const row = (acc) => store1.filings.find((r) => r.accession === acc);
const sc = (r, id) => { const s = (r.sections || []).find((x) => x.id === id); return s ? s.cosine : undefined; };
const K25 = row("0000000001-25-000003"), K24 = row("0000000001-24-000002"), Q25 = row("0000000001-25-000009"), Q24 = row("0000000001-24-000006");

ok("the company's four filings are stored in filing-date order, each with its filing date and its form",
  store1.filings.map((r) => `${r.filingDate} ${r.form}`).join(" | ") === "2024-02-20 10-K | 2024-05-07 10-Q | 2025-02-18 10-K | 2025-05-06 10-Q",
  store1.filings.map((r) => `${r.filingDate} ${r.form}`).join(" | "));
ok("the first 10-K and the first 10-Q have no previous filing of their form, and no score at all — not a score of zero",
  K24.prev === null && K24.overall === null && K24.sections.every((s) => s.cosine === null) && Q24.prev === null && Q24.overall === null);
ok("the 2025 10-K is scored against the 2024 10-K, 364 days earlier",
  K25.prev.accession === "0000000001-24-000002" && K25.prev.filingDate === "2024-02-20" && K25.prev.daysBefore === 364, JSON.stringify(K25.prev));
ok("the 2025 10-Q is scored against the 2024 10-Q — not against the 10-K filed in between",
  Q25.prev.accession === "0000000001-24-000006" && Q25.prev.filingDate === "2024-05-07", JSON.stringify(Q25.prev));

// the known answers. Item 1B and Part II Item 1A are four words each, chosen so the arithmetic can be done by hand:
//   "alpha beta beta gamma" -> {alpha:1, beta:2, gamma:1};  "beta gamma gamma delta" -> {beta:1, gamma:2, delta:1}
//   dot = 2*1 + 1*2 = 4;  |a| = |b| = sqrt(1+4+1) = sqrt 6;  4 / 6 = 0.666667 to six places
ok("Item 1B of the 2025 10-K scores 0.666667 against Item 1B of the 2024 10-K (4/6, worked out by hand)", sc(K25, "item1b") === 0.666667, String(sc(K25, "item1b")));
ok("Part II Item 1A of the 2025 10-Q scores the same 0.666667 against the 2024 10-Q's", sc(Q25, "p2item1a") === 0.666667, String(sc(Q25, "p2item1a")));
ok("the sections that were re-filed unchanged score exactly 1",
  sc(K25, "item1") === 1 && sc(K25, "item3") === 1 && sc(Q25, "p1item1") === 1 && sc(Q25, "p1item4") === 1 && sc(Q25, "p2item1") === 1 && sc(Q25, "p2item6") === 1,
  JSON.stringify([sc(K25, "item1"), sc(K25, "item3"), sc(Q25, "p1item1"), sc(Q25, "p1item4"), sc(Q25, "p2item1"), sc(Q25, "p2item6")]));
ok("Item 1A, which gained one paragraph about a contract manufacturer, scores 0.956603 — moved, but barely", sc(K25, "item1a") === 0.956603, String(sc(K25, "item1a")));
ok("Item 7, which was rewritten from growth to decline, scores 0.519779 — the lowest score in the filing", sc(K25, "item7") === 0.519779 && sc(K25, "item7") === Math.min(...K25.sections.filter((s) => s.cosine !== null).map((s) => s.cosine)), String(sc(K25, "item7")));
ok("the 10-Q's MD&A, rewritten the same way, scores 0.834814", sc(Q25, "p1item2") === 0.834814, String(sc(Q25, "p1item2")));
ok("Item 7A, which the 2024 10-K did not have, is listed in onlyHere and scored null — a new section has no similarity",
  K25.onlyHere.join() === "item7a" && sc(K25, "item7a") === null && /previous filing has no such section/.test(K25.sections.find((s) => s.id === "item7a").note) && K25.onlyPrev.length === 0);
ok("the filing's overall score is recorded with its sections, and lies between the lowest and the highest of them",
  K25.overall === 0.944959 && K25.overall > sc(K25, "item7") && K25.overall < 1 && Q25.overall === 0.979577, `${K25.overall} / ${Q25.overall}`);
ok("every section records its word count, its predecessor's, and the title the form gives it",
  K25.sections.find((s) => s.id === "item1b").words === 4 && K25.sections.find((s) => s.id === "item1b").prevWords === 4 &&
  K25.sections.find((s) => s.id === "item1").words === 89 && K25.sections.find((s) => s.id === "item1a").title === "Risk Factors",
  JSON.stringify(K25.sections.map((s) => [s.id, s.words, s.prevWords])));
ok("each filing records the sha256 and the byte length of the text it was read from",
  K25.source.sha256 === sha(fs.readFileSync(path.join(FIX, "zzzz-10k-2025.txt"))) && K25.source.bytes === fs.statSync(path.join(FIX, "zzzz-10k-2025.txt")).size, K25.source.sha256);

const store2 = JSON.parse(fs.readFileSync(path.join(DATA, "filing-wording", "0000000002.json"), "utf8"));
ok("the company with one filing on record has that filing, with no score and no previous filing",
  store2.cik === "0000000002" && store2.symbol === "YYYY" && store2.filings.length === 1 && store2.filings[0].prev === null && store2.filings[0].sectionsFound === 4);

// idempotence
const before = fs.readFileSync(path.join(DATA, "filing-wording", "0000000001.json"), "utf8");
C.runFromDir({ dir: FIX, dataRoot: DATA, now: () => new Date("2026-10-16T00:00:00Z"), log: () => { } });
ok("running the collector again over the same saved text gives byte-identical files: the same text always gives the same score",
  fs.readFileSync(path.join(DATA, "filing-wording", "0000000001.json"), "utf8") === before);
C.runFromDir({ dir: FIX, dataRoot: DATA, now: () => new Date("2026-10-17T00:00:00Z"), log: () => { } });
const after = JSON.parse(fs.readFileSync(path.join(DATA, "filing-wording", "0000000001.json"), "utf8"));
ok("a later run moves updatedAt and nothing else — no filing is added twice",
  after.updatedAt === "2026-10-17T00:00:00.000Z" && after.filings.length === 4 && JSON.stringify(after.filings) === JSON.stringify(JSON.parse(before).filings));
ok("the store names its schema", after.schema === "filing-wording-v1" && typeof after.version === "string");

// a manifest that is wrong is refused before anything is read
{
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), "wording-badfix-"));
  try {
    ok("a folder with no filings.json is refused", threw(() => C.runFromDir({ dir: bad, dataRoot: DATA, log: () => { } }), /filings\.json is missing/));
    fs.writeFileSync(path.join(bad, "filings.json"), "[{\"cik\":\"1\",\"form\":\"8-K\",\"filingDate\":\"2025-13-01\",\"accession\":\"a\",\"file\":\"../../etc/passwd\"}]");
    const why = (() => { try { C.runFromDir({ dir: bad, dataRoot: DATA, log: () => { } }); return ""; } catch (e) { return e.message; } })();
    ok("a manifest row with an impossible date, an unsupported form or a path that climbs out of the folder is refused, and every problem is named at once",
      /filingDate "2025-13-01" is not a date/.test(why) && /is not a 10-K or a 10-Q/.test(why) && /must be a name inside the folder/.test(why), why);
  } finally { fs.rmSync(bad, { recursive: true, force: true }); }
}

// ── 5 the fetch layer over a fake EDGAR ────────────────────────────────────────────────────────────────────────────────────
head("5 the fetch layer, over a fake EDGAR built from the same fixtures");
const UA = "TRAIDS research collector (operator contact set in the server environment)";
const SUB1 = {
  cik: "1", name: "SAMPLE WIDGETS INC", tickers: ["ZZZZ"],
  filings: {
    recent: {
      form: ["10-Q", "10-K", "8-K", "10-Q", "10-K"],
      filingDate: ["2025-05-06", "2025-02-18", "2024-09-09", "2024-05-07", "2024-02-20"],
      reportDate: ["2025-03-31", "2024-12-31", "2024-09-09", "2024-03-31", "2023-12-31"],
      accessionNumber: ["0000000001-25-000009", "0000000001-25-000003", "0000000001-24-000008", "0000000001-24-000006", "0000000001-24-000002"],
      primaryDocument: ["zzzz-10q-2025q1.htm", "zzzz-10k-2025.htm", "ev.htm", "zzzz-10q-2024q1.htm", "zzzz-10k-2024.htm"],
    },
  },
};
const EDGAR = { "https://data.sec.gov/submissions/CIK0000000001.json": JSON.stringify(SUB1) };
for (const [acc, doc, file] of [
  ["0000000001-24-000002", "zzzz-10k-2024.htm", "zzzz-10k-2024.txt"], ["0000000001-24-000006", "zzzz-10q-2024q1.htm", "zzzz-10q-2024q1.txt"],
  ["0000000001-25-000003", "zzzz-10k-2025.htm", "zzzz-10k-2025.txt"], ["0000000001-25-000009", "zzzz-10q-2025q1.htm", "zzzz-10q-2025q1.txt"],
]) EDGAR[F.documentUrl("1", acc, doc)] = text(file);

async function fetchChecks() {
  {
    const clk = F.fakeClock(), asked = [];
    const fetcher = async (url, opt) => { asked.push({ url, at: clk.now(), ua: opt.headers["User-Agent"] }); return EDGAR[url] === undefined ? { status: 404, headers: {}, text: "" } : { status: 200, headers: {}, text: EDGAR[url] }; };
    const r = await C.runFetch({ ciks: ["1"], fetcher, userAgent: UA, dataRoot: path.join(TREE, "backend", "data-fetch"), now: () => new Date("2026-10-16T00:00:00Z"), clock: clk.now, sleep: clk.sleep, log: () => { } });
    ok("the fetch layer reads the submissions document, then the four 10-K and 10-Q documents, and skips the 8-K: five requests",
      asked.length === 5 && r.stats.requests === 5 && asked.every((a) => a.ua === UA), JSON.stringify(asked.map((a) => a.url.replace(/^https:\/\/[^/]+/, ""))));
    const st = JSON.parse(fs.readFileSync(path.join(TREE, "backend", "data-fetch", "filing-wording", "0000000001.json"), "utf8"));
    const fK25 = st.filings.find((x) => x.accession === "0000000001-25-000003");
    ok("fetching the same text gives exactly the scores the parse layer gave: the layers share one implementation",
      fK25.overall === K25.overall && JSON.stringify(fK25.sections) === JSON.stringify(K25.sections) && fK25.prev.filingDate === "2024-02-20", `${fK25.overall} vs ${K25.overall}`);
    ok("the url each filing came from is recorded with it", /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/1\//.test(fK25.source.url), String(fK25.source.url));
  }
  {
    // 25 documents, 10 a second: the injected clock must move at least two whole seconds
    const clk = F.fakeClock(), t0 = clk.now();
    const sec = F.makeSecFetcher({ fetcher: async () => ({ status: 200, headers: {}, text: "x" }), userAgent: UA, now: clk.now, sleep: clk.sleep });
    for (let i = 0; i < 25; i++) await sec.get("https://www.sec.gov/Archives/edgar/data/1/x.htm");
    ok("SEC's fair-access limit holds across a whole run: 25 requests take at least two seconds and never more than 10 start in a second",
      clk.now() - t0 >= 2000 && sec.limiter.maxPerSecond === 10, `${clk.now() - t0} ms`);
  }
  {
    const clk = F.fakeClock();
    let first = true;
    const fetcher = async (url) => { if (first && url.endsWith(".json")) { first = false; return { status: 429, headers: { "Retry-After": "5" }, text: "" }; } return EDGAR[url] === undefined ? { status: 404, headers: {}, text: "" } : { status: 200, headers: {}, text: EDGAR[url] }; };
    const t0 = clk.now();
    const r = await C.runFetch({ ciks: ["1"], fetcher, userAgent: UA, dry: true, clock: clk.now, sleep: clk.sleep, log: () => { } });
    ok("a 429 with Retry-After is waited out and the run then finishes, counting the retry as a request", clk.now() - t0 >= 5000 && r.stats.retries === 1 && r.companies[0].filings === 4, `${clk.now() - t0} ms, ${JSON.stringify(r.stats)}`);
  }
  {
    const clk = F.fakeClock();
    const fetcher = async (url) => (url.endsWith("zzzz-10k-2025.htm") ? { status: 404, headers: {}, text: "" } : EDGAR[url] === undefined ? { status: 404, headers: {}, text: "" } : { status: 200, headers: {}, text: EDGAR[url] });
    const r = await C.runFetch({ ciks: ["1"], fetcher, userAgent: UA, dry: true, clock: clk.now, sleep: clk.sleep, log: () => { } });
    ok("a document EDGAR does not have is recorded as missing and the other three are still scored", r.missing.length === 1 && /0000000001-25-000003/.test(r.missing[0]) && r.companies[0].filings === 3, JSON.stringify(r.missing));
  }
  {
    let why = null;
    await C.runFetch({ ciks: ["1"], fetcher: async () => ({ status: 200, headers: {}, text: "{}" }), userAgent: "", log: () => { } }).catch((e) => { why = e.message; });
    ok("without a declared User-Agent the fetch layer refuses before it asks for anything", /User-Agent/.test(why || ""), String(why));
    let why2 = null;
    await C.runFetch({ ciks: ["1"], fetcher: undefined, userAgent: UA, log: () => { } }).catch((e) => { why2 = e.message; });
    ok("with no fetcher injected it refuses rather than reaching for the network itself", /a fetcher must be injected/.test(why2 || ""), String(why2));
  }
}

// ── 6 the house rules ──────────────────────────────────────────────────────────────────────────────────────────────────────
function houseRules() {
  head("6 the house rules");
  // A scan has to look at CODE. Each staged file carries its own selftest, and those selftests name the very words being looked
  // for ("secret", "alpaca", "writeFileSync", "https://example.com"): scanning them would make every check below fail on its own
  // test. So the selftests, the test helpers and the comments come out first — and the first check proves they really did.
  const codeOf = (src) => src
    // the closing newline is a LOOKAHEAD, not part of the match: two of these functions sit on consecutive lines, and a match that
    // ate the newline between them left the next one with no leading newline to match against
    .replace(/\n(?:async )?function (?:selftest|rest|fakeClock|fixture10K)\s*\([^)]*\)\s*\{[\s\S]*?\n\}(?=\n)/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  const staged = D.FILES.map((f) => { const src = fs.readFileSync(path.join(PKG, ...f.staged.split("/")), "utf8"); return { rel: f.rel, src, code: codeOf(src) }; });
  const all = staged.map((s) => s.code).join("\n");
  const fixtures = fs.readdirSync(FIX).map((n) => fs.readFileSync(path.join(FIX, n), "utf8")).join("\n");
  // selftest.cjs is left out of the word scan for the same reason — a scanner cannot scan itself for the words it scans for
  const shipped = all + "\n" + ["deploy.cjs", "rollback.cjs", "fixtures/make-fixtures.cjs", "NOTES.md", "base/EMPTY.md"].map((n) => fs.readFileSync(path.join(PKG, ...n.split("/")), "utf8")).join("\n") + "\n" + fixtures;
  const everything = staged.map((s) => s.src).join("\n") + "\n" + fs.readFileSync(path.join(PKG, "selftest.cjs"), "utf8") + "\n" + shipped;
  // every line of JavaScript this package would ever RUN, selftests included but this file and the prose excluded: this file and
  // NOTES.md both name the APIs being looked for, so scanning them would make the check fail on its own description
  const runnable = staged.map((s) => s.src).join("\n") + "\n" + ["deploy.cjs", "rollback.cjs", "fixtures/make-fixtures.cjs"].map((n) => fs.readFileSync(path.join(PKG, ...n.split("/")), "utf8")).join("\n");

  ok("the scan looks at code: each staged file's own selftest, its test helpers and its comments were cut out, and what is left is still the working code",
    staged.every((s) => s.code.length > 2000 && s.code.length < s.src.length * 0.75 && !/  ok\s*\(/.test(s.code)) &&
    /function splitSections\(/.test(staged[0].code) && /function makeSecFetcher\(/.test(staged[1].code) && /function collect\(/.test(staged[2].code),
    staged.map((s) => `${s.rel} ${s.src.length}->${s.code.length}`).join("; "));
  ok("no key, token, password or account number is anywhere in what this package ships",
    !/\b(?:api[_-]?key|apikey|secret|password|passwd|bearer\s+[A-Za-z0-9._-]{8,}|sk-[A-Za-z0-9]{8,}|account[_-]?number)\b/i.test(shipped.replace(/SEC_USER_AGENT/g, "")),
    (/\b(?:api[_-]?key|apikey|secret|password|passwd|account[_-]?number)\b/i.exec(shipped.replace(/SEC_USER_AGENT/g, "")) || [])[0]);
  ok("no personal detail anywhere in the package, selftest and notes included: no e-mail address, no telephone number, no host address",
    !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(everything) && !/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/.test(everything) && !/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(everything),
    (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(everything) || [])[0]);
  ok("the only host the staged code will talk to is sec.gov",
    F.SEC_HOSTS.join() === "www.sec.gov,sec.gov,data.sec.gov" && !/https?:\/\/(?!www\.sec\.gov|data\.sec\.gov)[a-z0-9.-]+\.[a-z]{2,}/i.test(all),
    (/https?:\/\/(?!www\.sec\.gov|data\.sec\.gov)[a-z0-9.-]+\.[a-z]{2,}/i.exec(all) || [])[0]);
  ok("nothing in the staged code registers a test or writes any registry, seal or ledger", !/register-test|registerTest|test-registry|read-seals|change-registry|agent-ledger/.test(all), (/register-test|registerTest|test-registry|read-seals|change-registry|agent-ledger/.exec(all) || [])[0]);
  ok("nothing in the staged code places an order, calls a broker, or starts or schedules anything",
    !/alpaca|schwab|tastytrade|placeOrder|submitOrder|\bbroker\b|schtasks|systemctl|crontab|close-chain/i.test(all), (/alpaca|schwab|tastytrade|placeOrder|submitOrder|\bbroker\b|schtasks|systemctl|crontab|close-chain/i.exec(all) || [])[0]);
  ok("JSON is written only through backend/lib/atomic-write.js, in one place",
    /require\("\.\/lib\/atomic-write\.js"\)/.test(staged.find((s) => s.rel === "backend/filing-wording-collector.js").code) &&
    !/writeFileSync|appendFileSync|createWriteStream/.test(all),
    (/writeFileSync|appendFileSync|createWriteStream/.exec(all) || [])[0]);
  ok("the staged code requires nothing but node's own small modules and its two sibling libraries",
    (all.match(/require\((["'])([^"']+)\1\)/g) || []).every((r) => /"(?:fs|path|crypto)"|\.\/lib\/(?:filing-sections|sec-fetch|atomic-write)\.js/.test(r)),
    JSON.stringify([...new Set(all.match(/require\((["'])([^"']+)\1\)/g) || [])]));
  ok("the fixtures are invented: two companies that do not exist, CIK 1 and CIK 2, made-up accession numbers",
    /SAMPLE WIDGETS INC/.test(fixtures) && /SAMPLE GADGETS CORP/.test(fixtures) && MK.FILINGS.every((f) => /^00000000(?:01|02)-\d\d-\d{6}$/.test(f.accession)) && MK.FILINGS.every((f) => ["0000000001", "0000000002"].includes(f.cik)));
  // the cloud has Node 22 and home has 24, so nothing here may need an API that only 24 has. A regular expression's flags cannot be
  // read reliably out of source text (too many false matches), so the flags are checked where they can be: a built RegExp.
  ok("nothing in this package needs a Node newer than the server's 22 (no Object.groupBy, no fs.glob, no Array.fromAsync, no Promise.withResolvers, no v-flag RegExp)",
    !/Object\.groupBy|Map\.groupBy|fs\.glob|Array\.fromAsync|Promise\.withResolvers|RegExp\([^)]*,\s*(["'])[a-z]*v[a-z]*\1\)/.test(runnable),
    (/Object\.groupBy|Map\.groupBy|fs\.glob|Array\.fromAsync|Promise\.withResolvers/.exec(runnable) || [])[0]);
}

// ── 7 deploy and rollback, in the scratch tree ─────────────────────────────────────────────────────────────────────────────
function deployChecks() {
  head("7 deploy and rollback, against a scratch tree");
  ok("deploy.cjs --selftest passes", node(path.join(PKG, "deploy.cjs"), ["--selftest"]).status === 0, String(node(path.join(PKG, "deploy.cjs"), ["--selftest"]).stdout || "").trim().split("\n").pop());
  ok("rollback.cjs --selftest passes", node(path.join(PKG, "rollback.cjs"), ["--selftest"]).status === 0, String(node(path.join(PKG, "rollback.cjs"), ["--selftest"]).stdout || "").trim().split("\n").pop());
  ok("deploy.cjs --plan is read-only and says the same three files", node(path.join(PKG, "deploy.cjs"), ["--plan"]).status === 0 && /read-only, nothing is written/.test(String(node(path.join(PKG, "deploy.cjs"), ["--plan"]).stdout)));
  ok("rollback.cjs --plan is read-only", node(path.join(PKG, "rollback.cjs"), ["--plan"]).status === 0 && /nothing is removed/.test(String(node(path.join(PKG, "rollback.cjs"), ["--plan"]).stdout)));
  ok("neither tool takes two modes at once, or an argument it does not know",
    node(path.join(PKG, "deploy.cjs"), ["--plan", "--apply"]).status === 2 && node(path.join(PKG, "deploy.cjs"), ["--force"]).status === 2 && node(path.join(PKG, "rollback.cjs"), []).status === 2);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wording-deployrun-"));
  try {
    const a = D.apply({ repo: tmp, gate: null, log: () => { } });
    ok("a whole apply into an empty tree creates the three files and they all parse there",
      a.result === "done" && a.wrote.length === 3 && D.FILES.every((f) => node("--check", [path.join(tmp, ...f.rel.split("/"))]).status === 0), JSON.stringify(a.why || a.wrote));
    ok("the files written are byte-identical to the staged copies", D.FILES.every((f) => sha(fs.readFileSync(path.join(tmp, ...f.rel.split("/")))) === f.stagedSha));
    ok("a second apply writes nothing (it is idempotent)", D.apply({ repo: tmp, gate: null, log: () => { } }).wrote.length === 0);
    ok("a gate that does not pass refuses the apply", (() => { const t2 = fs.mkdtempSync(path.join(os.tmpdir(), "wording-gate-")); try { const r = D.apply({ repo: t2, gate: { what: "a gate that fails", run: () => ({ ok: false, why: "no" }) }, log: () => { } }); return r.result === "refused" && !fs.existsSync(path.join(t2, "backend")); } finally { fs.rmSync(t2, { recursive: true, force: true }); } })());
    const b = R.rollbackApply({ repo: tmp, log: () => { } });
    ok("rollback takes the tree back to where it started: the three files are gone again", b.result === "done" && b.removed.length === 3 && D.FILES.every((f) => !fs.existsSync(path.join(tmp, ...f.rel.split("/")))));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
fetchChecks().then(() => {
  houseRules();
  deployChecks();
  const keep = process.argv.includes("--keep");
  if (keep) console.log(`\nscratch tree kept at ${TREE}`);
  else fs.rmSync(TREE, { recursive: true, force: true });
  console.log("");
  console.log(fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} of ${pass + fail} CHECKS FAILED`);
  process.exitCode = fail === 0 ? 0 : 1;
}, (e) => {
  console.error("selftest threw: " + (e && e.stack ? e.stack : e));
  try { fs.rmSync(TREE, { recursive: true, force: true }); } catch { /* the temp folder outlives this run; that is all */ }
  console.log(`${fail + 1} of ${pass + fail + 1} CHECKS FAILED`);
  process.exitCode = 1;
});
