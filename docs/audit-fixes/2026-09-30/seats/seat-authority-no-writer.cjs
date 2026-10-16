#!/usr/bin/env node
/**
 * SEAT AUTHORITY — MAKE THE RECORD TELL THE TRUTH. Nightly audit 2026-09-30, agents#3 (first filed 2026-09-23 agents lens, lows[2]).
 *
 * data/seat-authority.json has said portfolio-manager and stop-manager are applied:true since the 2026-08-29 grant. Nothing has ever
 * written their seals on a schedule: pm-allocation-seal.json and stop-manager-seal.json were written once, by hand, on 2026-08-30
 * (session 2026-08-31; change-registry 1788113152546), and no code, seat-wave charge or agent definition names either file. So
 * lib/seat-authority.js has failed open for both since the seals aged past 3 sessions: the PM last sized a ticket on 2026-09-03
 * (11 tickets, 09-01..09-03) and the stop-manager has never stamped obs.seatStop (tighten has been [] since the grant).
 *
 * This records that fact: both seats -> applied:false with a dated noWriter block. NO BEHAVIOUR CHANGES — with seals 31 days old
 * every hook already skips both seats (applyEntryAuthority's PM branch and tightenedStop both require a seal <= 3 sessions old), and
 * applied:false skips them one test earlier. Restoring either seat (give it a writer, then applied:true) is the operator's decision.
 *
 *   node docs/audit-fixes/2026-09-30/seats/seat-authority-no-writer.cjs           DRY (default): prints the change, writes nothing
 *   node docs/audit-fixes/2026-09-30/seats/seat-authority-no-writer.cjs --apply   writes data/seat-authority.json via writeJsonAtomic
 *
 * Fails closed: refuses if either seal file is fresh (<= 3 sessions — then a writer exists and this premise is false) or if a seat
 * charge in automation/seat-wave.cjs now names the seal file.
 */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const D = (f) => path.join(ROOT, "backend", "data", f);
const { writeJsonAtomic } = require(path.join(ROOT, "backend", "lib", "atomic-write.js"));
const APPLY = process.argv.includes("--apply");
const J = (f) => JSON.parse(fs.readFileSync(D(f), "utf8"));
const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const days = (a, b) => Math.abs(Date.parse(b) - Date.parse(a)) / 864e5;

const sa = J("seat-authority.json");
const wave = fs.readFileSync(path.join(ROOT, "automation", "seat-wave.cjs"), "utf8");
const chargeOf = (seat) => { const i = wave.indexOf(`seat: "${seat}"`); if (i < 0) return ""; const j = wave.indexOf('seat: "', i + 1); return wave.slice(i, j < 0 ? undefined : j); };
const SEATS = {
  "portfolio-manager": { file: "pm-allocation-seal.json", inert: "since 2026-09-04: the last seat-sized tickets were 11 Crypto/FX tickets opened 2026-09-01..09-03 (obs.seatSizeMult 0.6/0.65); nothing since" },
  "stop-manager": { file: "stop-manager-seal.json", inert: "since the grant: the only seal carries tighten:[] and obs.seatStop is on 0 ledger/board rows, ever" },
};
const problems = [];
const next = JSON.parse(JSON.stringify(sa));
for (const [seat, s] of Object.entries(SEATS)) {
  const g = sa.seats && sa.seats[seat]; if (!g) { problems.push(`${seat} missing from seat-authority.json`); continue; }
  let seal; try { seal = J(s.file); } catch (e) { problems.push(`${s.file} unreadable (${e.message})`); continue; }
  const age = seal.session ? days(seal.session, todayET) : null;
  if (age == null || age <= 3) problems.push(`${s.file} session ${seal.session} is ${age}d old — a fresh seal means a writer exists; refusing`);
  if (chargeOf(seat).includes(s.file)) problems.push(`the seat-wave ${seat} charge now names ${s.file} — a writer exists; refusing`);
  if (g.applied === false && g.noWriter) { console.log(`  ${seat}: already applied:false with a noWriter record (${g.appliedFalseOn}) — nothing to do`); continue; }
  next.seats[seat] = { ...g, applied: false, appliedFalseOn: "2026-10-01",
    noWriter: { sealFile: s.file, lastSealSession: seal.session, lastSealedAt: seal.sealedAt || null,
      writtenBy: "a one-off manual commission on 2026-08-30 (change-registry 1788113152546); no code, seat-wave charge (automation/seat-wave.cjs) or agent definition (.claude/agents) has ever written it",
      inert: s.inert, behaviourChange: "none — lib/seat-authority.js already failed open on this seal (older than MAX_SEAL_AGE_SESSIONS = 3); applied:false skips the seat one test earlier" },
    why: "nightly audit 2026-09-30 agents#3 (first filed 2026-09-23 agents lens): the grant read as live while the seat had no writer; daily-health printed FAIL every night with the remedy 'run the seat wave', which cannot write this file. Recorded on the operator's 2026-10-01 instruction 'fix the bugs'.",
    restore: `operator decision: give the seat a writer (e.g. the seat-wave ${seat} charge writes ${s.file}${seat === "portfolio-manager" ? " {session, weights}" : " {session, tighten}"}), then set applied:true — the hook in lib/seat-authority.js needs no code change` };
}
console.log(`SEAT AUTHORITY NO-WRITER — ${APPLY ? "APPLY" : "DRY RUN (nothing written)"} · today ${todayET}`);
if (problems.length) { console.log("  FAIL — " + problems.join(" · ")); process.exit(2); }
for (const seat of Object.keys(SEATS)) console.log(`  ${seat}: applied ${sa.seats[seat].applied} -> ${next.seats[seat].applied} · last seal ${next.seats[seat].noWriter ? next.seats[seat].noWriter.lastSealSession : "?"}`);
const changed = JSON.stringify(next) !== JSON.stringify(sa);
if (!changed) { console.log("  no change"); process.exit(0); }
if (!APPLY) { console.log("  re-run with --apply to write data/seat-authority.json"); console.log(JSON.stringify({ "portfolio-manager": next.seats["portfolio-manager"], "stop-manager": next.seats["stop-manager"] }, null, 1)); process.exit(0); }
const BK = path.join(ROOT, "docs", "audit-fixes", "2026-09-30", "backups", "backend__data__seat-authority.json.orig");
if (!fs.existsSync(BK)) { fs.mkdirSync(path.dirname(BK), { recursive: true }); fs.copyFileSync(D("seat-authority.json"), BK); console.log("  backup " + BK); }
writeJsonAtomic(D("seat-authority.json"), next);
const back = J("seat-authority.json");
const ok = back.seats["portfolio-manager"].applied === false && back.seats["stop-manager"].applied === false && back.seats["head-trader"].applied === sa.seats["head-trader"].applied && back.granted === sa.granted;
console.log(ok ? "  PASS — written; portfolio-manager and stop-manager applied:false, every other seat and the grant unchanged" : "  FAIL — read-back does not match");
process.exit(ok ? 0 : 1);
