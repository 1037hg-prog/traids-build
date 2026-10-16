#!/usr/bin/env node
"use strict";
/**
 * WINGS DOUBLE COUNT (2026-10-16) — SELFTEST. Known-answer tests on the fixtures in fixtures.cjs.
 *
 * No network, no broker, no real data file: every row is synthesized by fixtures.cjs into a scratch repo
 * under the OS temp directory, and the scratch repo is torn down at the end (--keep leaves it).
 *
 * WHAT IT PROVES, in three layers:
 *   A. the rule itself — lib/ticket-rows.js collapseByTicket on hand-written arrays: a clean ledger is an
 *      EXACT no-op (same array, same object references), one ticket id is one row, the successor stamp wins
 *      where the latest-close tiebreak would lose, an unexplained duplicate is reported and never silent,
 *      an id-less row passes through, and the answer does not depend on row order.
 *   B. the canonical read — lib/reconcile.js cleanEraLedger() and journalLag(), BASE and STAGED, on the
 *      same fixture, under both change registries. Base counts the six wings twice where the retire rule
 *      does not happen to cover them; staged counts them once under either registry.
 *   C. the reports — daily-postmortem.js, integrity-audit.js and options-news-shadow.js run as the
 *      operator runs them, BASE and STAGED, and their printed numbers compared with the hand answers.
 *
 * Every number asserted here is written out by hand in fixtures.cjs (EXPECT) with the arithmetic shown.
 *   node docs/wings-double-count/2026-10-16/selftest.cjs [--keep]
 *
 * TWO HOOKS, for mutants.cjs and nothing else:
 *   WDC_SECTIONS   run only these sections (e.g. "ABC"). A PARTIAL RUN'S LAST LINE DOES NOT MATCH the
 *                  deploy gate's "ALL <n> CHECKS PASSED", on purpose: a partial run can never pass the gate.
 *   WDC_REPO       where to read the files this package does not ship (backend/lib/session.js,
 *                  backend/lib/atomic-write.js, backend/package.json) when the package itself is a copy.
 * Neither is read by deploy.cjs, rollback.cjs or record.cjs.
 */
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const PKG = __dirname, REPO = process.env.WDC_REPO || path.resolve(PKG, "..", "..", "..");
const SEC = (process.env.WDC_SECTIONS || "ABCDE").toUpperCase(), want = (s) => SEC.includes(s);
const F = require("./fixtures.cjs"), E = F.EXPECT;

let pass = 0; const fails = [];
const chk = (name, ok, got) => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fails.push(name); console.log(`  FAIL  ${name}${got === undefined ? "" : `   got ${JSON.stringify(got)}`}`); } };
const eq = (name, got, want) => chk(name, got === want, got);
const near = (name, got, want, tol = 5e-5) => chk(name, Number.isFinite(got) && Math.abs(got - want) <= tol, got);

/* ─────────────────────────────────────────────────────────────────────────────
 * the scratch repo: the five files of this package plus what they require, and the fixture data.
 * Home loads backend/*.js as CommonJS (backend/package.json declares no "type", while the repo root
 * declares "module"), so the scratch repo carries that package.json too and the files are loaded
 * exactly as they are at home.
 * ───────────────────────────────────────────────────────────────────────────── */
const CARRY = ["backend/lib/session.js", "backend/lib/atomic-write.js"];
const UNDER = ["backend/lib/reconcile.js", "backend/daily-postmortem.js", "backend/options-news-shadow.js",
  "backend/integrity-audit.js", "backend/trade-postmortem.js", "backend/skip-filter-monitor.js"];
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "wings-double-count-"));
/**
 * backend/lib/feature-manifest.js is NOT in this code-only copy (screened out), so
 * backend/skip-filter-monitor.js cannot be required here at all — before this change or after it. The
 * scratch repo gets a plainly-fake stub returning an empty banned list. It is never reached by the checks
 * below: the monitor prints its settle count and then returns at "under 100 settles", before any feature
 * work. NOTES.md says the operator must run that file once at home, unstubbed, after applying.
 */
const FEATURE_MANIFEST_STUB = `"use strict";
// FIXTURE STUB — not the real file. backend/lib/feature-manifest.js is not in this code-only copy.
module.exports = { boardObsBanned: () => [] };
`;

/** a scratch repo holding `which` ("base" | "staged") copies of the files under test */
function scratch(which, dataOpts) {
  const dir = fs.mkdtempSync(path.join(ROOT, which + "-"));
  fs.mkdirSync(path.join(dir, "backend", "lib"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "backend", "package.json"), path.join(dir, "backend", "package.json"));
  for (const rel of CARRY) fs.copyFileSync(path.join(REPO, rel), path.join(dir, rel));
  for (const rel of UNDER) {
    const from = path.join(PKG, which, rel);
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(fs.existsSync(from) ? from : path.join(PKG, "staged", rel), path.join(dir, rel));
  }
  // ticket-rows.js exists only in staged: a base scratch repo must NOT have it (base must not need it)
  if (which === "staged") fs.copyFileSync(path.join(PKG, "staged", "backend/lib/ticket-rows.js"), path.join(dir, "backend/lib/ticket-rows.js"));
  fs.writeFileSync(path.join(dir, "backend", "lib", "feature-manifest.js"), FEATURE_MANIFEST_STUB);
  F.writeData(path.join(dir, "backend", "data"), dataOpts);
  return dir;
}
const run = (dir, rel, args = []) => {
  const r = cp.spawnSync(process.execPath, [path.join(dir, rel), ...args], { encoding: "utf8", timeout: 120000, windowsHide: true });
  return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
};
/** require a scratch copy of reconcile.js in a child, print one JSON line, read it back */
function reconcileIn(dir) {
  const probe = path.join(dir, "probe.cjs");
  fs.writeFileSync(probe, `const R = require(${JSON.stringify(path.join(dir, "backend", "lib", "reconcile.js"))});
const L = R.cleanEraLedger(), J = R.journalLag();
const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
process.stdout.write(JSON.stringify({
  L: pick(L, ["rowsInFile", "settled", "retiredExcluded", "n", "controlN", "meanR", "controlMeanR", "pooledEdgeR", "tickets", "duplicateTicketIds", "supersededRowsDropped", "unexplainedDuplicateTicketIds"]),
  signalPnl: L.signals.reduce((a, t) => a + (t.pnl || 0), 0),
  wingPnl: L.signals.filter((t) => /^w\\d$/.test(t.id)).reduce((a, t) => a + (t.pnl || 0), 0),
  J: pick(J, ["journalRows", "settledInCanon", "settledRowsInCanon", "missing", "journaledUnderSupersededCount", "duplicateTicketIds"]),
  amb: R.knownAmbiguities().map((a) => ({ id: a.id, affects: a.affects })),
}));
`);
  const r = cp.spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 120000, windowsHide: true });
  if (r.status !== 0) throw new Error(`probe failed in ${dir}: ${String(r.stderr).trim().split("\n").slice(0, 4).join(" | ")}`);
  return JSON.parse(r.stdout);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * A. THE RULE — lib/ticket-rows.js, loaded from a scratch repo exactly as home loads it
 * ───────────────────────────────────────────────────────────────────────────── */
if (want("A")) {
const TR = require(path.join(scratch("staged", { order: "prepend", registry: "bare" }), "backend", "lib", "ticket-rows.js"));
console.log("A. the rule (lib/ticket-rows.js collapseByTicket)");
{
  // A1 a clean ledger is an exact no-op, references included
  const clean = [{ id: "a", closedAt: 1, pnl: 1 }, { id: "b", closedAt: 2, pnl: 2 }, { id: "c", closedAt: 3, pnl: 3 }];
  const c = TR.collapseByTicket(clean);
  eq("A1  clean ledger: same length", c.rows.length, 3);
  chk("A1  clean ledger: the same row objects, in order", c.rows.every((r, i) => r === clean[i]));
  eq("A1  clean ledger: no duplicate reported", c.duplicates.length, 0);
  eq("A1  clean ledger: nothing dropped", c.dropped.length, 0);
  eq("A1  clean ledger: tickets = rows", c.tickets, 3);
  eq("A1  clean ledger: the line says so", TR.collapseLine(c), "tickets 3 = rows (no ticket id appears twice)");
  // the report line's CONTENT, not just its shape: the ids it names are how a reader finds the rows
  {
    const many = [];
    for (let i = 1; i <= 8; i++) many.push({ id: `d${i}`, closedAt: 1, pnl: -1, voidForEvidence: true }, { id: `d${i}`, closedAt: 2, pnl: 1 });
    const line = TR.collapseLine(TR.collapseByTicket(many));
    eq("A1  the line names the duplicate ids, up to six, then an ellipsis", line,
      "tickets 8 · 8 ticket id(s) held 16 rows: 8 superseded row(s) are NOT counted (ids d1, d2, d3, d4, d5, d6, …)");
    const amb = TR.collapseLine(TR.collapseByTicket([{ id: "u", closedAt: 1 }, { id: "u", closedAt: 1 }]));
    eq("A1  and the unexplained tail names them and says to look", amb,
      "tickets 1 · 1 ticket id(s) held 2 rows: 1 superseded row(s) are NOT counted (ids u) · 1 UNEXPLAINED duplicate ticket id(s): u — the rule kept the latest close; look at them");
  }

  // A2 a voided close and a later close of one ticket: one row, the later one
  const voided = { id: "w", closedAt: 10, pnl: -400, retired: "t", retireNote: "n", voidForEvidence: true };
  const settle = { id: "w", closedAt: 20, pnl: 100 };
  for (const [lab, arr] of [["settle first", [settle, voided]], ["voided first", [voided, settle]]]) {
    const r = TR.collapseByTicket(arr);
    eq(`A2  one ticket, two closes (${lab}): one row`, r.rows.length, 1);
    chk(`A2  one ticket, two closes (${lab}): it is the later close`, r.rows[0] === settle);
    eq(`A2  one ticket, two closes (${lab}): reported as a duplicate`, r.duplicates.length, 1);
    eq(`A2  one ticket, two closes (${lab}): nothing unexplained`, r.ambiguous.length, 0);
  }

  // A3 the successor stamp decides where the latest close would decide wrong
  const pred = { id: "s", closedAt: 30, pnl: -500, retired: "vs" };                       // LATER, and not voidForEvidence
  const succ = { id: "s", closedAt: 20, pnl: 120, voidedPredecessor: "s", restoredAfter: "vs" };
  const s = TR.collapseByTicket([pred, succ]);
  eq("A3  successor stamp: one row", s.rows.length, 1);
  chk("A3  successor stamp: the stamped row wins, not the later close", s.rows[0] === succ);
  eq("A3  successor stamp: nothing unexplained", s.ambiguous.length, 0);
  chk("A3  the stamp alone, as a predicate", TR.supersedes(succ, pred) === true && TR.supersedes(pred, succ) === false);

  // A4 a duplicate the rule cannot explain is REPORTED, and still counts once
  const d1 = { id: "d", closedAt: 40, pnl: 5 }, d2 = { id: "d", closedAt: 40, pnl: 9 };
  const d = TR.collapseByTicket([d1, d2]);
  eq("A4  unexplained duplicate: still one row", d.rows.length, 1);
  chk("A4  unexplained duplicate: file order breaks the tie", d.rows[0] === d1);
  chk("A4  unexplained duplicate: named in ambiguous", d.ambiguous.length === 1 && d.ambiguous[0] === "d", d.ambiguous);
  chk("A4  unexplained duplicate: said on the line", /UNEXPLAINED/.test(TR.collapseLine(d)), TR.collapseLine(d));

  // A4b a duplicate with DIFFERENT closes that no rule explains: the later close is kept, the id is
  //     still reported as unexplained (a tiebreak is not an explanation), and it still counts once
  const x1 = { id: "x", closedAt: 50, pnl: 5 }, x2 = { id: "x", closedAt: 60, pnl: 9 };
  for (const [lab, arr] of [["later last", [x1, x2]], ["later first", [x2, x1]]]) {
    const x = TR.collapseByTicket(arr);
    eq(`A4b unexplained duplicate, different closes (${lab}): one row`, x.rows.length, 1);
    chk(`A4b unexplained duplicate, different closes (${lab}): the LATER close is kept`, x.rows[0] === x2);
    chk(`A4b unexplained duplicate, different closes (${lab}): the id is reported as unexplained`, x.ambiguous.length === 1 && x.ambiguous[0] === "x", x.ambiguous);
  }

  // A5 a row with no id is not a ticket: it passes through, every one of them
  const n = TR.collapseByTicket([{ sym: "X", pnl: 1 }, { sym: "Y", pnl: 2 }, { id: "a", pnl: 3 }, null, 7]);
  eq("A5  id-less rows pass through", n.rows.length, 3);
  eq("A5  id-less rows counted", n.idless, 2);
  eq("A5  id-less rows are not tickets", n.tickets, 1);
  eq("A5  entries that are not rows at all are COUNTED, not silently dropped", n.notRows, 2);
  chk("A5  and said on the line", /2 entries in the file is not a row at all \(DAMAGED FILE\)/.test(TR.collapseLine(n)), TR.collapseLine(n));

  // A5b a FALSY-BUT-PRESENT id is still a ticket id. `!r.id` is the obvious test and the wrong one: under
  //     it two rows sharing id 0 both pass through and the ticket counts twice, silently.
  const falsy = TR.collapseByTicket([{ id: 0, closedAt: 3 }, { id: 0, closedAt: 4 }, { id: false, closedAt: 5 }, { id: false, closedAt: 6 }]);
  eq("A5b id 0 and id false are ticket ids: two tickets, two rows", falsy.rows.length, 2);
  eq("A5b and they are counted as tickets", falsy.tickets, 2);
  eq("A5b and the duplicates are reported", falsy.duplicates.length, 2);
  eq("A5b and nothing is called id-less", falsy.idless, 0);
  chk("A5b hasId: 0 and false are ids, '' / null / undefined are not",
    TR.hasId({ id: 0 }) && TR.hasId({ id: false }) && !TR.hasId({ id: "" }) && !TR.hasId({ id: null }) && !TR.hasId({}));
  const empty = TR.collapseByTicket([{ id: "", closedAt: 1 }, { id: "", closedAt: 2 }]);
  eq("A5b an EMPTY-STRING id identifies nothing: id-less, reported", empty.idless, 2);
  eq("A5b and never collapsed into one ticket", empty.rows.length, 2);

  // A5c ids are never coerced into each other
  const coerce = TR.collapseByTicket([{ id: 1, closedAt: 1 }, { id: "1", closedAt: 2 }, { id: "01", closedAt: 3 }]);
  eq("A5c id 1, \"1\" and \"01\" are three tickets", coerce.tickets, 3);
  eq("A5c and three rows", coerce.rows.length, 3);
  const nocase = TR.collapseByTicket([{ id: "W1", closedAt: 1 }, { id: "w1", closedAt: 2 }]);
  eq("A5c ids are case-SENSITIVE: two tickets", nocase.tickets, 2);

  // A5d the boundary in rule (2): two voided closes at the SAME instant supersede nothing, and the
  //     duplicate is reported. With >= instead of > they would supersede each other and go unreported.
  const sameInstant = [{ id: "v", closedAt: 9, pnl: -1, voidForEvidence: true }, { id: "v", closedAt: 9, pnl: -2, voidForEvidence: true }];
  const si = TR.collapseByTicket(sameInstant);
  eq("A5d two voided closes at the same instant: one row", si.rows.length, 1);
  chk("A5d and the duplicate is reported, not explained", si.ambiguous.length === 1 && si.ambiguous[0] === "v", si.ambiguous);
  chk("A5d neither supersedes the other", TR.supersedes(sameInstant[0], sameInstant[1]) === false && TR.supersedes(sameInstant[1], sameInstant[0]) === false);

  // A5e a row with NO usable close never beats a row that has one
  const noClose = { id: "k", pnl: 1 }, withClose = { id: "k", closedAt: 7, pnl: 2 };
  for (const [lab, arr] of [["no-close first", [noClose, withClose]], ["no-close last", [withClose, noClose]]]) {
    const r = TR.collapseByTicket(arr);
    chk(`A5e the row WITH a close is kept (${lab})`, r.rows[0] === withClose, r.rows[0] && r.rows[0].pnl);
  }
  for (const bad of [null, undefined, NaN, "2026-09-18", {}]) {
    const r = TR.collapseByTicket([{ id: "z", closedAt: bad, pnl: 1 }, { id: "z", closedAt: 5, pnl: 2 }]);
    eq(`A5e a non-numeric closedAt (${JSON.stringify(bad) ?? String(bad)}) never wins`, r.rows[0].pnl, 2);
  }

  // A5f supersedes() is a predicate about ONE ticket: it must refuse rows of two, whatever they carry
  chk("A5f supersedes() is false across different ticket ids",
    TR.supersedes({ id: "t", voidedPredecessor: "OTHER", restoredAfter: "T1" }, { id: "OTHER", retired: "T1" }) === false);
  {
    // two identical stamped twins each stamp the ticket and each carry the stamped tag, so each supersedes
    // the other: the rule explains nothing, which is exactly what must be REPORTED rather than picked silently
    const tw = [{ id: "s", voidedPredecessor: "s", restoredAfter: "T", retired: "T", closedAt: 4 }, { id: "s", voidedPredecessor: "s", restoredAfter: "T", retired: "T", closedAt: 4 }];
    const r = TR.collapseByTicket(tw);
    eq("A5f identical stamped twins: still one row", r.rows.length, 1);
    chk("A5f and the duplicate is reported as unexplained", r.ambiguous.length === 1 && r.ambiguous[0] === "s", r.ambiguous);
  }
  {
    const self = { id: "s", voidedPredecessor: "s", restoredAfter: "T", retired: "T", closedAt: 1 };
    chk("A5f a row that is its own successor stamp supersedes nothing", TR.supersedes(self, self) === false);
    eq("A5f and alone it is simply the ticket's row", TR.collapseByTicket([self]).rows.length, 1);
  }
  {
    // a stamp naming another ticket must not reach across: both tickets keep a row
    const across = TR.collapseByTicket([{ id: "a", voidedPredecessor: "b", restoredAfter: "T", closedAt: 1 }, { id: "b", retired: "T", closedAt: 2 }]);
    eq("A5f a stamp naming ANOTHER ticket collapses nothing", across.rows.length, 2);
    eq("A5f and both are tickets", across.tickets, 2);
  }

  // A5g three or more rows, and a chain of stamps
  {
    const v1 = { id: "m", closedAt: 1, pnl: -1, voidForEvidence: true }, v2 = { id: "m", closedAt: 2, pnl: -2, voidForEvidence: true }, real = { id: "m", closedAt: 3, pnl: 9 };
    const r = TR.collapseByTicket([v1, v2, real]);
    chk("A5g three rows, two voided: the real close is the ticket", r.rows.length === 1 && r.rows[0] === real);
    eq("A5g and two rows are dropped", r.dropped.length, 2);
    eq("A5g and nothing is unexplained", r.ambiguous.length, 0);
    const c1 = { id: "c", retired: "T1", closedAt: 30 }, c2 = { id: "c", retired: "T2", voidedPredecessor: "c", restoredAfter: "T1", closedAt: 20 },
      c3 = { id: "c", voidedPredecessor: "c", restoredAfter: "T2", closedAt: 10 };
    const ch = TR.collapseByTicket([c1, c2, c3]);
    chk("A5g a chain of three stamps keeps the last link, not the latest close", ch.rows.length === 1 && ch.rows[0] === c3, ch.rows[0] && ch.rows[0].closedAt);
    eq("A5g and the chain is fully explained", ch.ambiguous.length, 0);
  }

  // A5h the linear rule must agree with the pairwise reference on randomized groups — this is what holds
  //     pickRow's O(k) form to supersedes()'s own definition, rather than a comment claiming it does
  {
    let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const tags = [undefined, "T1", "T2"], closes = [undefined, NaN, 1, 2, 2, 3];
    let disagree = 0, groups = 0, withDup = 0;
    for (let t = 0; t < 4000; t++) {
      const k = 2 + Math.floor(rnd() * 4), g = [];
      for (let i = 0; i < k; i++) g.push({ id: "g", pnl: i,
        closedAt: closes[Math.floor(rnd() * closes.length)],
        ...(rnd() < 0.4 ? { retired: tags[Math.floor(rnd() * tags.length)] } : {}),
        ...(rnd() < 0.4 ? { voidForEvidence: true } : {}),
        ...(rnd() < 0.4 ? { voidedPredecessor: rnd() < 0.8 ? "g" : "other", restoredAfter: tags[Math.floor(rnd() * tags.length)] } : {}) });
      const a = TR.pickRow(g), b = TR.pickRowPairwise(g);
      groups++; if (a.dropped.length) withDup++;
      if (a.at !== b.at || a.ambiguous !== b.ambiguous || a.dropped.length !== b.dropped.length) disagree++;
    }
    eq("A5h linear pickRow agrees with the pairwise reference on 4000 random groups", disagree, 0);
    chk("A5h (and the groups were not all trivial)", groups === 4000 && withDup === 4000, { groups, withDup });
  }

  // A5i determinism and no mutation of the caller's data
  {
    const input = Object.freeze([Object.freeze({ id: "p", closedAt: 2, pnl: 1, voidForEvidence: true }), Object.freeze({ id: "p", closedAt: 3, pnl: 2 }), Object.freeze({ id: "q", closedAt: 1 })]);
    const a = TR.collapseByTicket(input), b = TR.collapseByTicket(input);
    chk("A5i frozen rows and a frozen array do not throw", a.rows.length === 2);
    chk("A5i the same input gives the same answer", a.rows.every((r, i) => r === b.rows[i]));
    chk("A5i the input array is untouched", input.length === 3 && input[0].pnl === 1 && input[1].pnl === 2);
    chk("A5i the kept rows are the caller's own objects, in file order", a.rows[0] === input[1] && a.rows[1] === input[2]);
  }

  // A5j one ticket with many rows must not be quadratic: a malformed ledger may not look like a hang
  {
    const big = []; for (let i = 0; i < 40000; i++) big.push({ id: "one", closedAt: i, pnl: i });
    const t0 = Date.now(); const r = TR.collapseByTicket(big); const ms = Date.now() - t0;
    eq("A5j 40,000 rows under ONE ticket id collapse to one row", r.rows.length, 1);
    chk(`A5j and in linear time (${ms} ms, bar 3000)`, ms < 3000, ms);
  }

  // A6 the fixture ledger: same answer in either write order
  for (const order of ["prepend", "append"]) {
    const r = TR.collapseByTicket(F.ledger(order));
    eq(`A6  fixture (${order}): rows in file`, F.ledger(order).length, E.rowsInFile);
    eq(`A6  fixture (${order}): tickets`, r.tickets, E.tickets);
    eq(`A6  fixture (${order}): duplicate ticket ids`, r.duplicates.length, E.duplicateTicketIds);
    eq(`A6  fixture (${order}): superseded rows dropped`, r.dropped.length, E.supersededRows);
    eq(`A6  fixture (${order}): nothing unexplained`, r.ambiguous.length, 0);
    const wings = (rows) => rows.filter((t) => /^w\d$/.test(t.id)).reduce((a, t) => a + t.pnl, 0);
    eq(`A6  fixture (${order}): the six wings per ROW`, wings(F.ledger(order)), E.wings.perRow);
    eq(`A6  fixture (${order}): the six wings per TICKET`, wings(r.rows), E.wings.perTicket);
    const sig = (rows) => rows.filter((t) => !t.ctrl).reduce((a, t) => a + t.pnl, 0);
    eq(`A6  fixture (${order}): signal book per ROW`, sig(F.ledger(order)), E.signalPnl.perRow);
    eq(`A6  fixture (${order}): signal book per TICKET`, sig(r.rows), E.signalPnl.perTicket);
  }
}
}

/* ─────────────────────────────────────────────────────────────────────────────
 * B. THE CANONICAL READ — cleanEraLedger() and journalLag(), base vs staged
 * ───────────────────────────────────────────────────────────────────────────── */
if (want("B")) {
console.log("\nB. the canonical read (lib/reconcile.js), base vs staged, on one fixture");
for (const registry of ["bare", "registered"]) {
  const want = registry === "bare" ? E.ledgerBare : E.ledgerRegistered;
  for (const which of ["base", "staged"]) {
    const dir = scratch(which, { order: "prepend", registry });
    const g = reconcileIn(dir), w = want[which];
    const tag = `B  ${registry} registry · ${which}`;
    eq(`${tag}: rows in file`, g.L.rowsInFile, E.rowsInFile);
    eq(`${tag}: settled`, g.L.settled, w.settled);
    eq(`${tag}: retired excluded`, g.L.retiredExcluded, w.retiredExcluded);
    eq(`${tag}: signal n`, g.L.n, w.n);
    near(`${tag}: signal meanR`, g.L.meanR, w.meanR);
    if (w.controlMeanR !== undefined) near(`${tag}: control meanR`, g.L.controlMeanR, w.controlMeanR);
    if (w.pooledEdgeR !== undefined) near(`${tag}: pooled edge`, g.L.pooledEdgeR, w.pooledEdgeR);
    if (which === "staged") {
      eq(`${tag}: tickets`, g.L.tickets, E.tickets);
      eq(`${tag}: duplicate ticket ids`, g.L.duplicateTicketIds, E.duplicateTicketIds);
      eq(`${tag}: superseded rows dropped`, g.L.supersededRowsDropped, E.supersededRows);
      eq(`${tag}: nothing unexplained`, g.L.unexplainedDuplicateTicketIds.length, 0);
      eq(`${tag}: the six wings count ONCE`, g.wingPnl, E.wings.perTicket);
      eq(`${tag}: signal book per ticket`, g.signalPnl, E.signalPnl.perTicket);
      eq(`${tag}: the void-tag ambiguity is surfaced`, g.amb.some((a) => a.id === "void-tag-on-surviving-close"), true);
    }
    if (which === "base" && registry === "bare") {
      eq(`${tag}: the six wings count TWICE (the defect)`, g.wingPnl, E.wings.perRow);
      eq(`${tag}: signal book per row (the defect)`, g.signalPnl, E.signalPnl.perRow);
    }
    // the journal, keyed on the ticket id
    if (which === "staged") {
      eq(`${tag}: journal entries`, g.J.journalRows, E.journal.entries);
      eq(`${tag}: settled TICKETS in canon`, g.J.settledInCanon, E.journal.settledTicketsInCanon);
      eq(`${tag}: settled ROWS in canon, said beside it`, g.J.settledRowsInCanon, E.journal.settledRowsInCanon);
      eq(`${tag}: journal not behind`, g.J.missing, E.journal.missing);
      eq(`${tag}: tickets sealed under a superseded close`, g.J.journaledUnderSupersededCount, E.journal.sealedUnderSuperseded);
    } else {
      eq(`${tag}: journal entries`, g.J.journalRows, E.journal.base.journalRows);
      eq(`${tag}: settled in canon counts ROWS (the disagreement)`, g.J.settledInCanon, E.journal.base.settledInCanon);
      eq(`${tag}: and reports no lag while disagreeing`, g.J.missing, E.journal.base.missing);
    }
  }
}
// the staged answer must not depend on the write order either
{
  const a = reconcileIn(scratch("staged", { order: "prepend", registry: "bare" }));
  const b = reconcileIn(scratch("staged", { order: "append", registry: "bare" }));
  eq("B  staged: the signal book is the same in either write order", a.signalPnl, b.signalPnl);
  eq("B  staged: and the same n", a.L.n, b.L.n);
  eq("B  staged: and the same as under the other registry", a.signalPnl, E.signalPnl.perTicket);
}
// THE NOTE ON THE SUPERSEDED ROW ONLY: the surviving close carries the void tag, the superseded row carries
// the retireNote. reconcile.js's retire rule must read the COLLAPSED rows, or a dropped row's note validates
// a tag that then excludes the ticket's real close — counted twice, then not at all.
for (const which of ["base", "staged"]) {
  const w = E.tagNoNote[which], tag = `B  note on the superseded row only · registered registry · ${which}`;
  const g = reconcileIn(scratch(which, { order: "prepend", registry: "registered", tagNoNote: true }));
  eq(`${tag}: settled`, g.L.settled, w.settled);
  eq(`${tag}: retired excluded`, g.L.retiredExcluded, w.retiredExcluded);
  eq(`${tag}: signal n`, g.L.n, w.n);
  eq(`${tag}: the six wings`, g.wingPnl, w.wingPnl);
}

// THE INHERITED VOID TAG: the collapse makes each wing one ticket; whether that one ticket counts at
// all is the retired-row rule's answer, and the new known ambiguity says so instead of guessing.
for (const registry of ["registered", "bare"]) {
  const w = E.inheritedTag[registry === "registered" ? "stagedRegistered" : "stagedBare"];
  const g = reconcileIn(scratch("staged", { order: "prepend", registry, inheritedTag: true }));
  const tag = `B  inherited void tag · ${registry} registry · staged`;
  eq(`${tag}: settled`, g.L.settled, w.settled);
  eq(`${tag}: retired excluded`, g.L.retiredExcluded, w.retiredExcluded);
  eq(`${tag}: signal n`, g.L.n, w.n);
  eq(`${tag}: signal book`, g.signalPnl, w.signalPnl);
  eq(`${tag}: still one ticket per id`, g.L.duplicateTicketIds, E.duplicateTicketIds);
  const amb = g.amb.find((x) => x.id === "void-tag-on-surviving-close");
  chk(`${tag}: the ambiguity is reported`, !!amb);
  eq(`${tag}: and names all six wings`, amb && amb.affects, E.inheritedTag.ambiguityAffects);
  if (registry === "registered") eq(`${tag}: the wings now count ZERO times — reported, never guessed at`, g.wingPnl, 0);
  else eq(`${tag}: the wings count once (a bare tag excludes nothing)`, g.wingPnl, E.wings.perTicket);
}
}

/* ─────────────────────────────────────────────────────────────────────────────
 * C. THE REPORTS — run as the operator runs them, base vs staged
 * ───────────────────────────────────────────────────────────────────────────── */
if (want("C")) {
console.log("\nC. the reports, base vs staged");
for (const which of ["base", "staged"]) {
  const dir = scratch(which, { order: "prepend", registry: "bare" });
  const w = E.postmortem[which], tag = `C  daily-postmortem · ${which}`;
  const r = run(dir, "backend/daily-postmortem.js");
  chk(`${tag}: ran`, r.status === 0, r.out.slice(0, 300));
  const head = /DAILY POST-MORTEM · (\d{4}-\d{2}-\d{2})/.exec(r.out);
  eq(`${tag}: target session`, head && head[1], E.postmortem.target);
  const day = /(\d+) settles · win .* · (-?\$[\d,]+)\s*$/m.exec(r.out);
  eq(`${tag}: today's settles`, day && +day[1], E.postmortem.todaySettles);
  eq(`${tag}: today's realized cash (unchanged by the fix)`, day && day[2], `-$${Math.abs(E.postmortem.todayPnl)}`);
  const curve = /equity curve: (.+)$/m.exec(r.out);
  const pts = curve ? curve[1].split(" -> ") : [];
  eq(`${tag}: sessions in the curve`, pts.length, w.sessions);
  eq(`${tag}: where the curve ends`, pts[pts.length - 1], `${E.postmortem[which].curveEnd < 0 ? "-$" : "$"}${Math.abs(w.curveEnd).toLocaleString()}`);
  const ns = /(\d+) sessions · mean/.exec(r.out);
  eq(`${tag}: session count in section 5`, ns && +ns[1], w.sessions);
  if (which === "staged") chk(`${tag}: says what it collapsed`, /ticket id\(s\) held 14 rows: 7 superseded row\(s\) are NOT counted/.test(r.out), /ledger: .*/.exec(r.out)?.[0]);
  if (which === "staged") chk(`${tag}: and reports the FILE's row count, not the collapsed one`, new RegExp(`ledger: ${E.rowsInFile} rows · tickets ${E.tickets} `).test(r.out), /ledger: .*/.exec(r.out)?.[0]);
}
for (const which of ["base", "staged"]) {
  const dir = scratch(which, { order: "prepend", registry: "bare" });
  const w = E.integrity[which], tag = `C  integrity-audit · ${which}`;
  const r = run(dir, "backend/integrity-audit.js");
  chk(`${tag}: ran and PASSED (the fixture has no impossible value)`, r.status === 0 && /VERDICT: PASS/.test(r.out), r.out.slice(-400));
  const j = JSON.parse(fs.readFileSync(path.join(dir, "backend", "data", "integrity-audit.json"), "utf8"));
  eq(`${tag}: too-good tripwire n`, j.cleanN, w.cleanN);
  near(`${tag}: too-good tripwire win rate`, j.winRate, w.winRate);
  near(`${tag}: too-good tripwire meanR`, j.meanR, w.meanR);
  eq(`${tag}: no tripwire flag on this fixture`, j.tooGoodFlags.length, 0);
  eq(`${tag}: options rows in the signal ledger (the blast-radius count)`, j.optionsInSignalLedger, w.optionsInSignalLedger);
  if (which === "staged") {
    eq(`${tag}: rows in file still audited per row`, j.rowsInFile, E.rowsInFile);
    eq(`${tag}: tickets`, j.tickets, w.tickets);
    eq(`${tag}: duplicate ticket ids reported`, j.duplicateTicketIds, w.duplicateTicketIds);
    eq(`${tag}: superseded rows not counted`, j.supersededRowsNotCounted, E.supersededRows);
    chk(`${tag}: section 2b printed`, /2b\. ROWS VS TICKETS/.test(r.out));
    chk(`${tag}: section 2b names each duplicate ticket id and its closes`,
      /^\s+w1\s+2 rows · counted close \d+ · superseded \d+$/m.test(r.out) && (r.out.match(/^\s+\S+\s+2 rows · counted close /gm) || []).length === E.duplicateTicketIds,
      (r.out.match(/^\s+\S+\s+2 rows · counted close .*$/gm) || []).slice(0, 2));
    chk(`${tag}: section 2b prints the FILE's row count`, new RegExp(`${E.rowsInFile} rows · tickets ${E.tickets} `).test(r.out));
    chk(`${tag}: and does not turn the verdict`, /VERDICT: PASS/.test(r.out));
  }
}
for (const order of ["prepend", "append"]) {
  for (const which of ["base", "staged"]) {
    const dir = scratch(which, { order, registry: "bare" });
    const w = E.newsShadow[order + "Order"][which], tag = `C  options-news-shadow · ${order} · ${which}`;
    const r = run(dir, "backend/options-news-shadow.js");
    chk(`${tag}: ran`, r.status === 0, r.out.slice(0, 300));
    const j = JSON.parse(fs.readFileSync(path.join(dir, "backend", "data", "options-news-shadow.json"), "utf8"));
    const wings = j.summary["R21-premium"];
    eq(`${tag}: wings exposed to the USD release`, wings.exposed.tickets, E.newsShadow.exposedTickets);
    eq(`${tag}: and none not exposed`, wings.notExposed.tickets, E.newsShadow.notExposedTickets);
    eq(`${tag}: exposed wings' P&L`, wings.exposed.sumPnl, w.sumPnl);
    near(`${tag}: exposed wings' meanR`, wings.exposed.meanR, w.meanR);
    if (which === "staged") eq(`${tag}: ledger block says the duplicates`, j.ledger.duplicateTicketIds, E.duplicateTicketIds);
  }
}
for (const which of ["base", "staged"]) {
  const dir = scratch(which, { order: "prepend", registry: "bare" });
  const w = E.tradePostmortem[which], tag = `C  trade-postmortem · ${which}`;
  const r = run(dir, "backend/trade-postmortem.js");
  chk(`${tag}: ran`, r.status === 0, r.out.slice(0, 300));
  const sleeve = /R21-premium\s+n (\d+)\s+win \d+%\s+avg [+-][\d.]+R\s+tot ([+-][\d.]+)R/.exec(r.out);
  eq(`${tag}: the sleeve's ticket count`, sleeve && +sleeve[1], w.sleeveN);
  near(`${tag}: the sleeve's total R`, sleeve && +sleeve[2], w.sleeveTotR, 0.05);
  const clus = /(\d+) trades settled on (\d+) days/.exec(r.out);
  eq(`${tag}: trades in the day-clustering line`, clus && +clus[1], w.trades);
  eq(`${tag}: days in the day-clustering line`, clus && +clus[2], w.days);
  if (which === "staged") chk(`${tag}: says what it collapsed, with the FILE's row count`, new RegExp(`ledger: ${E.rowsInFile} rows · tickets ${E.tickets} `).test(r.out), /ledger: .*/.exec(r.out)?.[0]);
}
for (const which of ["base", "staged"]) {
  const dir = scratch(which, { order: "prepend", registry: "bare" });
  const w = E.skipFilter[which], tag = `C  skip-filter-monitor · ${which}`;
  const r = run(dir, "backend/skip-filter-monitor.js");
  chk(`${tag}: ran (on a plainly-fake feature-manifest stub — see the top of this file)`, r.status === 0, r.out.slice(0, 300));
  const n = /clean signal settles with observers: (\d+)/.exec(r.out);
  eq(`${tag}: the training sample`, n && +n[1], w.n);
  chk(`${tag}: it stops under 100 settles, as it always has`, /first run fires at n=100|Not at a new 100-boundary/.test(r.out), r.out.slice(-200));
  if (which === "staged") chk(`${tag}: and says the sample is TICKETS`, /settles with observers: \d+ TICKETS/.test(r.out));
}
// the one that matters: base is right only by the write order, staged is right in both
chk("C  options-news-shadow: base's answer DEPENDS on the write order (the latent defect)",
  E.newsShadow.prependOrder.base.sumPnl !== E.newsShadow.appendOrder.base.sumPnl);
chk("C  options-news-shadow: staged's answer does not",
  E.newsShadow.prependOrder.staged.sumPnl === E.newsShadow.appendOrder.staged.sumPnl);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * D. every file of the package parses, and no staged file lost its base behaviour by accident
 * ───────────────────────────────────────────────────────────────────────────── */
if (want("D")) {
console.log("\nD. the package itself");
for (const rel of [...UNDER, "backend/lib/ticket-rows.js"]) {
  const p = path.join(PKG, "staged", rel);
  if (!fs.existsSync(p)) { chk(`D  staged/${rel} exists`, false); continue; }
  const c = cp.spawnSync(process.execPath, ["--check", p], { encoding: "utf8", windowsHide: true });
  chk(`D  staged/${rel} parses`, c.status === 0, String(c.stderr).trim().split("\n")[0]);
}
for (const rel of UNDER) {
  const p = path.join(PKG, "base", rel);
  chk(`D  base/${rel} is present (byte-exact start point)`, fs.existsSync(p));
}
chk("D  base/ holds no ticket-rows.js (it is new with this package)", !fs.existsSync(path.join(PKG, "base", "backend/lib/ticket-rows.js")));
for (const rel of UNDER) {
  const a = fs.readFileSync(path.join(PKG, "base", rel), "utf8"), b = fs.readFileSync(path.join(PKG, "staged", rel), "utf8");
  chk(`D  ${rel} actually changes`, a !== b);
}
}

/* ─────────────────────────────────────────────────────────────────────────────
 * E. THE PACKAGE'S OWN MACHINERY — apply, rollback, drift refusal and the gate, on a scratch repo.
 *    deploy.cjs/rollback.cjs both go through lib.cjs make(); it takes the repo it writes to, so this
 *    exercises the real code paths without touching this checkout.
 * ───────────────────────────────────────────────────────────────────────────── */
if (want("E")) {
console.log("\nE. the package's machinery (lib.cjs), on a scratch repo");
const LIB = require("./lib.cjs");
/** a scratch repo at BASE: the four changed files from base/, and no ticket-rows.js */
function baseRepo() {
  const dir = fs.mkdtempSync(path.join(ROOT, "unit-"));
  for (const rel of UNDER) { fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true }); fs.copyFileSync(path.join(PKG, "base", rel), path.join(dir, rel)); }
  return dir;
}
const shaOf = (p) => (fs.existsSync(p) ? LIB.sha(fs.readFileSync(p)) : null);
const okGate = { what: "stub gate (the real one runs selftest.cjs, which is this file)", run: () => ({ ok: true, line: "ALL 0 CHECKS PASSED (stub)" }) };
const badGate = { what: "stub gate that fails", run: () => ({ ok: false, why: "stub refusal", line: "" }) };
{
  const repo = baseRepo();
  const P0 = LIB.plan({ repo });
  eq("E1  at base: no refusal", P0.problems.length, 0);
  eq("E1  at base: six files read base, one is new", P0.todoApply.length, 7);
  chk("E1  at base: ticket-rows.js is 'new'", P0.files.find((x) => x.isNew).state === "new");
  chk("E1  at base: atBase", P0.atBase === true && P0.applied === false);

  // the gate is real: a failing gate refuses and writes nothing
  const before = Object.fromEntries(UNDER.map((rel) => [rel, shaOf(path.join(repo, rel))]));
  const refused = LIB.make({ repo, log: () => {} }).writeUnit({ to: "staged", gate: badGate });
  eq("E2  a failing gate refuses", refused.result, "refused");
  chk("E2  and nothing was written", UNDER.every((rel) => shaOf(path.join(repo, rel)) === before[rel]));
  chk("E2  and the new file was not created", !fs.existsSync(path.join(repo, "backend/lib/ticket-rows.js")));

  // apply
  const ap = LIB.make({ repo, log: () => {} }).writeUnit({ to: "staged", gate: okGate });
  eq("E3  apply: done", ap.result, "done");
  eq("E3  apply: seven files written", ap.written.length, 7);
  for (const f of LIB.FILES) eq(`E3  apply: ${f.rel} is the staged bytes`, shaOf(path.join(repo, ...f.rel.split("/"))), f.stagedSha);
  const P1 = LIB.plan({ repo });
  chk("E3  apply: the plan now reads applied", P1.applied === true && P1.todoApply.length === 0);
  eq("E3  apply again is a no-op", LIB.make({ repo, log: () => {} }).writeUnit({ to: "staged", gate: okGate }).written.length, 0);

  // rollback restores base byte for byte, and deletes the new file
  const rb = LIB.make({ repo, log: () => {} }).writeUnit({ to: "base" });
  eq("E4  rollback: done", rb.result, "done");
  for (const f of LIB.FILES.filter((x) => !x.isNew)) eq(`E4  rollback: ${f.rel} is the base bytes, byte for byte`, shaOf(path.join(repo, ...f.rel.split("/"))), f.baseSha);
  chk("E4  rollback: the new file is gone (that IS its base state)", !fs.existsSync(path.join(repo, "backend/lib/ticket-rows.js")));
  chk("E4  rollback: the plan reads base again", LIB.plan({ repo }).atBase === true);
  eq("E4  rollback again is a no-op", LIB.make({ repo, log: () => {} }).writeUnit({ to: "base" }).written.length, 0);
}
{
  // drift: a file at home that is neither base nor staged refuses both directions and writes nothing
  const repo = baseRepo();
  const drifted = path.join(repo, "backend", "daily-postmortem.js");
  fs.writeFileSync(drifted, fs.readFileSync(drifted, "utf8") + "\n// a hand edit nobody told this package about\n");
  const P = LIB.plan({ repo });
  chk("E5  drift: the plan says DRIFT and names the file", P.problems.some((p) => /daily-postmortem\.js is DRIFT/.test(p)), P.problems);
  const before = Object.fromEntries(UNDER.map((rel) => [rel, shaOf(path.join(repo, rel))]));
  for (const to of ["staged", "base"]) {
    const r = LIB.make({ repo, log: () => {} }).writeUnit({ to, gate: to === "staged" ? okGate : null });
    eq(`E5  drift: writeUnit(${to}) refuses`, r.result, "refused");
  }
  chk("E5  drift: nothing was written in either direction", UNDER.every((rel) => shaOf(path.join(repo, rel)) === before[rel]));
  chk("E5  drift: the new file was not created", !fs.existsSync(path.join(repo, "backend/lib/ticket-rows.js")));
}
{
  // a file this package changes but that is MISSING at home is refused, not created
  const repo = baseRepo();
  fs.unlinkSync(path.join(repo, "backend", "integrity-audit.js"));
  const P = LIB.plan({ repo });
  chk("E6  a changed file missing at home is refused", P.problems.some((p) => /integrity-audit\.js is missing at home/.test(p)), P.problems);
  eq("E6  and the write mode refuses", LIB.make({ repo, log: () => {} }).writeUnit({ to: "staged", gate: okGate }).result, "refused");
}
{
  // the real gate is wired to this package's selftest, and the plan/usage modes write nothing
  const M = LIB.make({ repo: baseRepo(), log: () => {} });
  chk("E7  the real gate names selftest.cjs", /selftest\.cjs/.test(M.selftestGate.what));
  const d = cp.spawnSync(process.execPath, [path.join(PKG, "deploy.cjs")], { encoding: "utf8", windowsHide: true });
  chk("E7  deploy.cjs with no mode exits 2 and does nothing", d.status === 2 && /Nothing was done/.test(d.stdout), d.status);
  const rp = cp.spawnSync(process.execPath, [path.join(PKG, "rollback.cjs"), "--plan"], { encoding: "utf8", windowsHide: true });
  chk("E7  rollback.cjs --plan is read-only and exits 0", rp.status === 0 && /read-only, nothing is written/.test(rp.stdout), rp.status);
  const dp = cp.spawnSync(process.execPath, [path.join(PKG, "deploy.cjs"), "--plan"], { encoding: "utf8", windowsHide: true });
  chk("E7  deploy.cjs --plan is read-only and exits 0", dp.status === 0 && /read-only, nothing is written/.test(dp.stdout), dp.status);
  const rd = cp.spawnSync(process.execPath, [path.join(PKG, "record.cjs"), "--dry"], { encoding: "utf8", windowsHide: true });
  chk("E7  record.cjs --dry exits 0 and writes nothing", rd.status === 0 && /would append to backend\/data\/change-registry\.json/.test(rd.stdout), rd.status);
  chk("E7  record.cjs --dry marks the row breaksComparability true", /"breaksComparability": true/.test(rd.stdout));
}
}

if (!process.argv.includes("--keep")) fs.rmSync(ROOT, { recursive: true, force: true });
else console.log(`\nscratch kept: ${ROOT}`);

console.log("");
if (fails.length) { console.log(`${fails.length} CHECK(S) FAILED of ${pass + fails.length}:\n  - ${fails.join("\n  - ")}`); process.exit(1); }
// A PARTIAL RUN'S last line deliberately does NOT match the deploy gate's /^ALL \d+ CHECKS PASSED/
if (SEC !== "ABCDE") { console.log(`PARTIAL RUN (sections ${SEC} only) — ALL ${pass} CHECKS PASSED. This line cannot pass deploy.cjs's gate; run the whole selftest for that.`); process.exit(0); }
console.log(`ALL ${pass} CHECKS PASSED — one row per ticket: the six wings count once, in either write order and under either change registry.`);
process.exit(0);
