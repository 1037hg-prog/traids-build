#!/usr/bin/env node
/**
 * BACKUP STATUS CHECK, package "backup" (health sweep 2026-10-05). Read-only; writes nothing.
 *
 *   node check-status.cjs [--tier nightly|full] [--date YYYY-MM-DD] [--file <backup-status.json>] [--json]
 *
 * WHY THIS EXISTS. The close chain logs only "ok   backup  Ns" for a step that exits 0, and keeps a step's output only when it
 * fails. So the backup's WARN lines and its offDisk=... line never reach daily-run.log; their one record is
 * backend/data/backup-status.json, which backup.cjs writes on every run. This reads that record and gives every item a
 * verdict, so "did tonight's backup carry futures-1m, and did it reach the mirror?" has an answer that does not depend on
 * someone remembering field names.
 *
 * Every item ends PASS, FAIL or UNKNOWN. UNKNOWN is as loud as FAIL: exit 0 = PASS, 1 = FAIL, 2 = UNKNOWN (nothing FAILed
 * but something could not be judged). A missing or stale record is UNKNOWN, never a quiet pass: a run the chain killed at
 * its step timeout writes no record, and that must not read like a good night.
 *
 * Items (nightly): record (written on --date, ET), step ok, archive present at the recorded size, futures-1m inside it,
 * off-disk mirror (not configured = FAIL: every archive is on the repo's own disk), FULL age (no FULL newer than 8 days =
 * FAIL), temp orphans (archives left in TEMP by killed runs = FAIL until deleted by hand).
 * Items (full): record (no older than 8 days), step ok, archive, futures-1m, mirror, temp orphans.
 */
const fs = require("fs"), path = require("path");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FILE = path.resolve(opt("--file", path.join(REPO, "backend", "data", "backup-status.json")));
const TIER = opt("--tier", "nightly");
const etDate = (d) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const DATE = opt("--date", etDate(new Date()));
const JSON_OUT = argv.includes("--json");
if (!["nightly", "full"].includes(TIER) || !/^\d{4}-\d{2}-\d{2}$/.test(DATE)) { console.error("usage: check-status.cjs [--tier nightly|full] [--date YYYY-MM-DD] [--file f] [--json]"); process.exit(2); }

const items = [];
const item = (name, verdict, detail) => items.push({ name, verdict, detail });
const fileSize = (p) => { try { return fs.statSync(p).size; } catch { return null; } };
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);

function judge() {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch (e) { return item("record", "UNKNOWN", e.code === "ENOENT" ? `${FILE} does not exist — the new backup.cjs has not run yet (or was never deployed)` : `${FILE} unreadable (${e.message})`); }
  if (!doc || doc.spec !== "backup-status-v1") return item("record", "UNKNOWN", `${FILE} is not a backup-status-v1 record`);
  const rec = doc[TIER];
  if (!rec) {
    return TIER === "full"
      ? item("record", "FAIL", "no FULL run has been recorded in backup-status.json at all")
      : item("record", "UNKNOWN", "no nightly record in backup-status.json");
  }
  const at = new Date(rec.at), atET = Number.isNaN(at.getTime()) ? null : etDate(at);
  if (!atET) return item("record", "UNKNOWN", `record has no valid time (at=${rec.at})`);
  const when = `${atET} ${at.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} ET`;
  if (TIER === "nightly" && atET !== DATE) {
    return item("record", "UNKNOWN", `newest nightly record was written ${when}, not on ${DATE} — that night's backup wrote nothing (not run yet, or killed by the chain's step timeout before it could record)`);
  }
  if (TIER === "full") {
    const age = dayDiff(DATE, atET);
    if (age > 8) item("record", "FAIL", `newest FULL record is ${age} days old (${when}) — the weekly FULL has stopped running`);
    else if (age < 0) return item("record", "UNKNOWN", `newest FULL record (${when}) is after --date ${DATE}`);
    else item("record", "PASS", `written ${when} (${age} day(s) before ${DATE})`);
  } else item("record", "PASS", `written ${when}`);

  item("step", rec.ok === true ? "PASS" : "FAIL", rec.ok === true ? "ok" : `failed: ${rec.why || "no reason recorded"}`);

  if (!rec.out || !Number.isFinite(rec.sizeBytes)) item("archive", "FAIL", `no archive recorded${rec.out ? ` (${rec.out})` : ""}`);
  else {
    const sz = fileSize(rec.out);
    if (sz == null) item("archive", "FAIL", `${rec.out} is gone`);
    else if (sz !== rec.sizeBytes) item("archive", "FAIL", `${rec.out} is ${sz} bytes, recorded ${rec.sizeBytes}`);
    else item("archive", "PASS", `${rec.out} (${(sz / 1e6).toFixed(1)} MB)`);
  }

  if (!Array.isArray(rec.carved) || !rec.carved.length) item("futures-1m", "UNKNOWN", "no carve-in result recorded");
  else {
    const out = rec.carved.filter((c) => c.inArchive !== true);
    item("futures-1m", out.length ? "FAIL" : "PASS", out.length ? `NOT in the archive: ${out.map((c) => c.rel).join(", ")}` : `in the archive: ${rec.carved.map((c) => c.rel).join(", ")}`);
  }

  const m = rec.mirror;
  if (!m || typeof m !== "object") item("off-disk mirror", "UNKNOWN", "no mirror result recorded");
  else if (m.configured !== true) item("off-disk mirror", "FAIL", "TRAIDS_BACKUP_MIRROR not set for this run — every archive is on the repo's own disk (if you have set it, the close task did not see it)");
  else if (m.ok !== true) item("off-disk mirror", "FAIL", `mirror ${m.dir}: ${m.error || "failed"}`);
  else if (rec.offDisk !== true) item("off-disk mirror", "FAIL", `copied to ${m.file}, but not confirmed on another physical disk (${m.diskCheck || "no disk check recorded"})`);
  else {
    const dirSeen = m.file && fs.existsSync(path.dirname(m.file)), sz = m.file ? fileSize(m.file) : null;
    if (dirSeen && sz == null) item("off-disk mirror", "FAIL", `${m.file} is gone from the mirror`);
    else if (dirSeen && Number.isFinite(rec.sizeBytes) && sz !== rec.sizeBytes) item("off-disk mirror", "FAIL", `${m.file} is ${sz} bytes, the archive is ${rec.sizeBytes}`);
    else item("off-disk mirror", "PASS", `${m.file} (size + sha256 verified at backup time; ${m.diskCheck})${dirSeen ? "" : " — mirror not reachable from this session, so not re-checked now"}`);
  }

  if (TIER === "nightly") {
    if (rec.fullAgeDays === undefined) item("FULL age", "UNKNOWN", "not recorded");
    else if (rec.fullAgeDays === null) item("FULL age", "FAIL", "no traids-FULL archive has ever been written — the bar history is in no backup");
    else if (rec.fullAgeDays > 8) item("FULL age", "FAIL", `newest FULL is ${rec.fullNewest}, ${rec.fullAgeDays} days old`);
    else item("FULL age", "PASS", `${rec.fullNewest}, ${rec.fullAgeDays} day(s) old`);
  }

  if (!Array.isArray(rec.orphanTempZips)) item("temp orphans", "UNKNOWN", "not recorded");
  else {
    const left = [...rec.orphanTempZips, ...(rec.tempZipLeft ? [`${rec.tempZipLeft} (this run's own, could not be removed)`] : [])];
    item("temp orphans", left.length ? "FAIL" : "PASS", left.length ? `${left.length} archive(s) in TEMP from killed or failed runs — delete by hand: ${left.join(", ")}` : "none");
  }
}
judge();

const nFail = items.filter((i) => i.verdict === "FAIL"), nUnk = items.filter((i) => i.verdict === "UNKNOWN");
const verdict = nFail.length ? "FAIL" : nUnk.length ? "UNKNOWN" : "PASS";
if (JSON_OUT) console.log(JSON.stringify({ tier: TIER, date: DATE, file: FILE, verdict, items }, null, 1));
else {
  console.log(`backup status check — ${TIER} ${DATE} (${FILE})`);
  for (const i of items) console.log(`  ${i.verdict.padEnd(7)} ${i.name.padEnd(16)} ${i.detail}`);
  console.log(`VERDICT ${verdict}${verdict === "PASS" ? "" : ` (${nFail.length} FAIL, ${nUnk.length} UNKNOWN): ${[...nFail, ...nUnk].map((i) => i.name).join(", ")}`}`);
}
process.exit(verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 2);
