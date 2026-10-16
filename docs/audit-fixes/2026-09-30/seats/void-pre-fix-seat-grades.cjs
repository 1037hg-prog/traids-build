#!/usr/bin/env node
/**
 * VOID THE PRE-FIX SEAT GRADES — nightly audit 2026-09-30, agents#1. Operator 2026-10-01: "throw out those results; fix the bugs".
 *
 * The operator-approved grader fix of 2026-09-24 (change-registry 2026-09-24 "seat-claims grader — graded on the sealed statistics";
 * audit A0923-024/025/026) replaced the would-do, exit, allocation and halt resolvers, but only for claims graded after it: the grade
 * ledger is append-only and a seq is graded once, so the 32 grades made before it stayed the grades of record and the published seat
 * record (seat-grades.json -> agent-book-status.json seatGrades -> the App.jsx agent-book panel) still carried them.
 *
 * This script withdraws them WITHOUT deleting them: one VOID row per seq is APPENDED to data/seat-grades.jsonl (backend/seat-claims-grader.js
 * reads a void row as "every earlier grade row for this seq is withdrawn"), then the grader is run, which re-resolves exactly those seqs
 * under the current, operator-approved resolvers and appends superseding rows, and rewrites seat-grades.json (writeJsonAtomic) and
 * seat-weights.jsonl (recorded, not applied). The earlier rows stay in the ledger, flagged by the void row with the reason and date.
 *
 *   node docs/audit-fixes/2026-09-30/seats/void-pre-fix-seat-grades.cjs           DRY (default): lists the void rows, previews the record
 *                                                                                  through the grader's own --dry --regrade path; writes nothing
 *   node docs/audit-fixes/2026-09-30/seats/void-pre-fix-seat-grades.cjs --apply   appends the void rows, runs the grader, reports before/after
 *
 * Fails closed: the voidable set must equal the 32 seqs the audit and its three refuters reproduced, or nothing is written. Refuses
 * --apply while the close chain could be running its own grader step (14:05-17:00 MT). Idempotent: a second --apply finds nothing to void.
 */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const D = (f) => path.join(ROOT, "backend", "data", f);
const GRADES = D("seat-grades.jsonl"), OUT = D("seat-grades.json");
const APPLY = process.argv.includes("--apply");
const FIX_DATE = "2026-09-24";   // the grader fix; the first post-fix grades are the 2026-09-24T20:24Z close-chain run
const EXPECTED = [3, 6, 7, 8, 9, 12, 13, 14, 15, 18, 19, 20, 21, 24, 25, 26, 27, 30, 31, 32, 33, 36, 37, 38, 39, 42, 43, 44, 45, 50, 51, 56];
const KINDS = new Set(["would-do", "exit", "allocation", "halt"]);   // the four resolvers the 09-24 fix replaced
const rl = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch (e) { console.error("UNKNOWN — cannot read " + f + ": " + e.message); process.exit(2); } };

const rows = rl(GRADES);
const history = new Map(), latest = new Map();
for (const g of rows) { if (g.void === true) { latest.delete(g.seq); history.set(g.seq, []); continue; } latest.set(g.seq, g); (history.get(g.seq) || history.set(g.seq, []).get(g.seq)).push(g); }
const retiredPath = (g) => {
  const m = String(g.method || ""), n = String(g.note || "");
  if (g.kind === "halt") return "halt resolver read the seat's magnitude (exposure overage) as a session-loss threshold ('" + m + "')";
  if (g.kind === "would-do") return /settled P&L/.test(m) ? "would-do graded on the named ticket's raw P&L, not the registered HT1 statistic ('" + m + "')" : "pre-fix would-do subject parser ('" + n + "'), not the registered HT1 statistic";
  if (g.kind === "exit") return /settled P&L/.test(m) ? "exit graded on the named ticket's own P&L, not R54's twin d ('" + m + "')" : /R54 twin d/.test(m) ? "pre-fix exit resolver version; its R54-twin-d path survived the fix, so re-resolution is expected to reproduce this grade" : "pre-fix exit resolver path ('" + n + "'), removed by the fix";
  if (g.kind === "allocation") return /not settled yet/.test(n) ? "allocation read settled tickets from agent-book.json `closed`, which holds a COUNT ('" + n + "')" : "pre-fix allocation resolver ('" + n + "'), replaced by the sealed-falsifier read";
  return "pre-fix resolver";
};
const voidable = [...latest.values()].filter((g) => KINDS.has(g.kind) && !g.hand && String(g.gradedAt) < FIX_DATE).sort((a, b) => a.seq - b.seq);
const got = voidable.map((g) => g.seq);
const same = got.length === EXPECTED.length && got.every((s, i) => s === EXPECTED[i]);

const pub = (() => { try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { return null; } })();
const rec = (bySeat) => Object.fromEntries(Object.entries(bySeat || {}).map(([s, v]) => [s, `${v.held}-${v.failed} (unres ${v.unresolved}, pend ${v.pending})`]));
const tot = (bySeat) => { let h = 0, f = 0; for (const v of Object.values(bySeat || {})) { h += v.held; f += v.failed; } return `${h}-${f}`; };
const before = pub ? pub.bySeat : null;

console.log(`VOID PRE-FIX SEAT GRADES — ${APPLY ? "APPLY" : "DRY RUN (nothing written)"} · ledger ${rows.length} rows · published asOf ${pub ? pub.asOf : "unreadable"}`);
if (!voidable.length) { console.log("  nothing to void: no grade of record of kind would-do/exit/allocation/halt predates " + FIX_DATE + " (already applied?)"); process.exit(0); }
if (!same) { console.log(`  FAIL — the voidable set (${got.length}: ${got.join(",")}) is not the 32 the audit reproduced (${EXPECTED.join(",")}); refusing to write anything.`); process.exit(2); }

const now = new Date().toISOString();
const WHY = "graded before the operator-approved 2026-09-24 seat-claims-grader fix (change-registry 2026-09-24 'seat-claims grader — graded on the sealed statistics'; audit A0923-024/025/026) by a resolver that fix retired; voided by the 2026-09-30 nightly audit (agents#1) on the operator's 2026-10-01 instruction 'throw out those results; fix the bugs'. The voided row(s) stay in this ledger; the seq is re-resolved under the current resolvers and the fresh row supersedes.";
const voidRows = voidable.map((g) => ({ seq: g.seq, seat: g.seat, kind: g.kind, session: g.session, void: true,
  voids: (history.get(g.seq) || []).map((r) => ({ gradedAt: r.gradedAt, verdict: r.verdict, number: r.number, method: r.method })),
  retiredPath: retiredPath(g), why: WHY, voidedOn: "2026-10-01", at: now }));
for (const v of voidRows) console.log(`  VOID #${v.seq} ${v.seat} ${v.kind} — voids ${v.voids.length} row(s), latest ${v.voids[v.voids.length - 1].verdict} — ${v.retiredPath}`);

const grader = (args) => { const r = spawnSync(process.execPath, [path.join(ROOT, "backend", "seat-claims-grader.js"), ...args], { cwd: path.join(ROOT, "backend"), encoding: "utf8", timeout: 180000 }); return { status: r.status, out: (r.stdout || "") + (r.stderr || "") }; };

if (!APPLY) {
  const p = grader(["--dry", "--regrade", EXPECTED.join(",")]);
  console.log("\n  PREVIEW (the grader's own --dry --regrade path on the same seqs; writes nothing):");
  console.log(p.out.split("\n").filter((l) => /SEAT CLAIMS GRADER|record /.test(l)).map((l) => "   " + l).join("\n"));
  console.log(`\n  published now: ${JSON.stringify(rec(before))} · all seats ${tot(before)}`);
  console.log("  re-run with --apply to append " + voidRows.length + " void rows and re-resolve them.");
  process.exit(p.status === 0 ? 0 : 2);
}

// ── APPLY ──
const mt = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Denver", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
if (mt >= "14:05" && mt < "17:00") { console.log(`  REFUSED — ${mt} MT is inside the close chain's window; its own grader step would race this append. Run before 14:05 or after 17:00 MT.`); process.exit(2); }
const BK = path.join(ROOT, "docs", "audit-fixes", "2026-09-30", "backups");
for (const f of ["seat-grades.jsonl", "seat-grades.json", "seat-weights.jsonl"]) { const b = path.join(BK, "backend__data__" + f + ".orig"); if (!fs.existsSync(b)) { fs.mkdirSync(BK, { recursive: true }); fs.copyFileSync(D(f), b); console.log("  backup " + b); } }
fs.appendFileSync(GRADES, voidRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`  appended ${voidRows.length} void rows to data/seat-grades.jsonl`);
const g = grader([]);
console.log(g.out.split("\n").map((l) => "   " + l).join("\n"));
if (g.status !== 0) { console.log("  FAIL — the grader exited " + g.status + "; the void rows are in the ledger and the seqs will re-resolve on the next grader run (close chain). Check the output above."); process.exit(1); }
// verify accrual, not the fix: every voided seq must now carry a fresh superseding grade of record
const after = rl(GRADES), lat = new Map(); for (const r of after) { if (r.void === true) lat.delete(r.seq); else lat.set(r.seq, r); }
const missing = EXPECTED.filter((s) => { const r = lat.get(s); return !r || !(String(r.gradedAt) >= now.slice(0, 10)) || r.supersedes !== true; });
const pub2 = JSON.parse(fs.readFileSync(OUT, "utf8"));
console.log(`\n  BEFORE (published ${pub ? pub.asOf : "?"}): all seats ${tot(before)}`);
for (const s of Object.keys(pub2.bySeat)) console.log(`    ${s.padEnd(22)} ${(rec(before)[s] || "n/a").padEnd(28)} -> ${rec(pub2.bySeat)[s]}`);
console.log(`  AFTER  (published ${pub2.asOf}): all seats ${tot(pub2.bySeat)}`);
console.log(missing.length ? `  FAIL — ${missing.length} voided seq(s) have no fresh superseding grade of record yet (PENDING or not re-resolved): ${missing.join(",")}` : "  PASS — all 32 voided seqs carry a fresh superseding grade of record");
process.exit(missing.length ? 1 : 0);
