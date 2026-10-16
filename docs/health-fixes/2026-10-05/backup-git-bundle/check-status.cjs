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
 *
 * OneDrive mirror review fix (package backup-onedrive, 2026-10-05):
 *   secret scan     — PASS only when the scan was complete (tar exit 0, scanned bytes == the central directory's uncompressed
 *                     total, > 0 needles) and found nothing; FAIL on hits (key names shown) or an incomplete scan; when no mirror
 *                     was configured nothing left the repo disk and the item says so (PASS, "not run"); a mirror record with no
 *                     scan result (written by an older backup.cjs) is UNKNOWN.
 *   off-disk mirror — for a OneDrive mirror, PASS only when the record says OneDrive sync was CONFIRMED (an earlier archive is a
 *                     cloud placeholder, the signed-in account folder is the OneDrive root) and that confirmation is no more than
 *                     its maxAgeWeekdays (2) weekdays before --date; pending / stale / unconfirmed FAIL with the recorded reason.
 *                     TRAIDS_BACKUP_MIRROR=none and a refused default are named as such.
 *
 * Git bundle (package backup-git-bundle, 2026-10-05) — FULL tier only; the nightly report is unchanged:
 *   git bundle      — PASS only when the FULL run's bundle was created, verified (git bundle verify AND the pack checksum), is in
 *                     DEST at its recorded size, and — when a mirror was configured — the history scan was COMPLETE (objects and
 *                     content bytes scanned == the --batch-check totals, git exit 0, > 0 needles) with 0 hits and the bundle was
 *                     mirrored (the mirror copy re-checked for size when the mirror is reachable). FAIL on hits (key names and
 *                     history paths shown), on an incomplete scan, a failed verify, a missing file, or a bundle that started and
 *                     never finished (state "running": the step was killed, e.g. by the chain's 45-min timeout). A FULL record
 *                     with no bundle at all (written by an older backup.cjs) is UNKNOWN.
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
// Weekdays (Mon-Fri) d with from < d <= to (YYYY-MM-DD); -1 if to is before from; NaN if unparseable. Same rule as backup.cjs.
function weekdaysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  if (b < a) return -1;
  let n = 0;
  for (let t = a + 864e5; t <= b; t += 864e5) { const d = new Date(t).getUTCDay(); if (d !== 0 && d !== 6) n++; }
  return n;
}

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
  const cs = m && m.cloudSynced && typeof m.cloudSynced === "object" ? m.cloudSynced : null;
  if (!m || typeof m !== "object") item("off-disk mirror", "UNKNOWN", "no mirror result recorded");
  else if (m.configured !== true) {
    item("off-disk mirror", "FAIL", m.source === "none" ? "mirror disabled for this run (TRAIDS_BACKUP_MIRROR=none) — every archive is on the repo's own disk"
      : m.source === "refused" ? "the default OneDrive mirror was refused (backup.cjs did not run from the canonical repo) — every archive is on the repo's own disk"
      : "TRAIDS_BACKUP_MIRROR not set for this run and no default mirror applied — every archive is on the repo's own disk (if you have set it, the close task did not see it)");
  }
  else if (m.ok !== true) item("off-disk mirror", "FAIL", `mirror ${m.dir}: ${m.error || "failed"}`);
  else if (rec.offDisk !== true) {
    item("off-disk mirror", "FAIL", cs ? `copied to ${m.file}, but OneDrive sync is ${cs.state}: ${cs.why || "no reason recorded"}`
      : `copied to ${m.file}, but not confirmed on another physical disk (${m.diskCheck || "no disk check recorded"})`);
  }
  else if (cs && cs.state !== "confirmed") item("off-disk mirror", "FAIL", `record says offDisk=true but OneDrive sync is ${cs.state} (${cs.why || "no reason"}) — inconsistent record`);
  else if (cs && !(weekdaysBetween(cs.confirmedDate || "", DATE) >= 0 && weekdaysBetween(cs.confirmedDate || "", DATE) <= (cs.maxAgeWeekdays ?? 2))) {
    item("off-disk mirror", "FAIL", `OneDrive sync was last confirmed from ${cs.confirmedFile || "?"} (${cs.confirmedDate || "no date"}), ${weekdaysBetween(cs.confirmedDate || "", DATE)} weekday(s) before ${DATE} — not within ${cs.maxAgeWeekdays ?? 2}: stale`);
  }
  else {
    const dirSeen = m.file && fs.existsSync(path.dirname(m.file)), sz = m.file ? fileSize(m.file) : null;
    if (dirSeen && sz == null) item("off-disk mirror", "FAIL", `${m.file} is gone from the mirror`);
    else if (dirSeen && Number.isFinite(rec.sizeBytes) && sz !== rec.sizeBytes) item("off-disk mirror", "FAIL", `${m.file} is ${sz} bytes, the archive is ${rec.sizeBytes}`);
    else item("off-disk mirror", "PASS", `${m.file} (size + sha256 verified at backup time; ${m.diskCheck})${dirSeen ? "" : " — mirror not reachable from this session, so not re-checked now"}`);
  }

  // secret scan (review m2)
  const sc = rec.scan;
  const mirrorWanted = m && typeof m === "object" && m.configured === true;
  if (sc === undefined || sc === null) {
    item("secret scan", mirrorWanted ? "UNKNOWN" : "PASS", mirrorWanted ? "no scan result recorded for a mirrored run (written by a backup.cjs older than the 2026-10-05 OneDrive fix?)" : "not run: no mirror this run, so no archive left the repo disk");
  } else if (sc.skipped) {
    item("secret scan", mirrorWanted ? "FAIL" : "PASS", mirrorWanted ? `not run (${sc.skipped}) although a mirror was configured` : `not run (${sc.skipped}): no archive left the repo disk`);
  } else {
    const hits = Array.isArray(sc.hitKeys) ? sc.hitKeys : [];
    const complete = Number.isFinite(sc.expectedBytes) && sc.expectedBytes > 0 && sc.scannedBytes === sc.expectedBytes && sc.tarExit === 0;
    if (hits.length) item("secret scan", "FAIL", `secret VALUES inside the archive: ${hits.join(", ")} — the mirror was refused; find and remove them, then re-run`);
    else if (sc.ok !== true || !complete || !(sc.needles > 0)) item("secret scan", "FAIL", `scan not complete: ${sc.error || "no error recorded"} (scanned ${sc.scannedBytes ?? "?"} of ${sc.expectedBytes ?? "?"} bytes, tar exit ${sc.tarExit ?? "?"}, ${sc.needles ?? 0} needles)`);
    else item("secret scan", "PASS", `${sc.needles} needles over ${(sc.scannedBytes / 1e9).toFixed(2)} GB (= the central directory total), no hits${sc.secs != null ? `, ${sc.secs} s` : ""}`);
  }

  if (TIER === "nightly") {
    if (rec.fullAgeDays === undefined) item("FULL age", "UNKNOWN", "not recorded");
    else if (rec.fullAgeDays === null) item("FULL age", "FAIL", "no traids-FULL archive has ever been written — the bar history is in no backup");
    else if (rec.fullAgeDays > 8) item("FULL age", "FAIL", `newest FULL is ${rec.fullNewest}, ${rec.fullAgeDays} days old`);
    else item("FULL age", "PASS", `${rec.fullNewest}, ${rec.fullAgeDays} day(s) old`);
  }

  if (TIER === "full") judgeBundle(rec.bundle);

  if (!Array.isArray(rec.orphanTempZips)) item("temp orphans", "UNKNOWN", "not recorded");
  else {
    const left = [...rec.orphanTempZips, ...(rec.tempZipLeft ? [`${rec.tempZipLeft} (this run's own, could not be removed)`] : [])];
    item("temp orphans", left.length ? "FAIL" : "PASS", left.length ? `${left.length} archive(s) in TEMP from killed or failed runs — delete by hand: ${left.join(", ")}` : "none");
  }
}
/** The FULL run's git bundle (package backup-git-bundle). Names, paths and counts only — the record holds no value. */
function judgeBundle(b) {
  const N = "git bundle";
  if (!b || typeof b !== "object") return item(N, "UNKNOWN", "no git bundle recorded for this FULL run (backup.cjs older than the git-bundle package, or the bundle step never reached)");
  if (b.state === "running") return item(N, "FAIL", `started ${b.startedAt || "?"} and never finished — the step was killed mid-bundle (the chain's 45-min timeout?); the FULL archive above was recorded before it began`);
  const sc = b.scan && typeof b.scan === "object" ? b.scan : null;
  const hits = sc && Array.isArray(sc.hitKeys) ? sc.hitKeys : [];
  const where = sc && Array.isArray(sc.hitPaths) && sc.hitPaths.length ? sc.hitPaths.map((h) => `${h.path} -> ${(h.keys || []).join(", ")}`).join("; ") : hits.join(", ");
  const exp = (sc && sc.expected) || {};
  const complete = !!sc && !sc.skipped && sc.complete !== false && exp.objects > 0 && sc.objects === exp.objects && Number.isFinite(exp.bytes) && sc.bytes === exp.bytes && sc.gitExit === 0;
  if (hits.length) {
    return item(N, "FAIL", `${complete ? "" : `history scan NOT complete (${sc.error || "no error recorded"}) and before it stopped found `}secret VALUES in git history: ${where} — ${b.path ? `bundle kept local (${b.path}), ` : ""}NOT mirrored. Rotate those keys, then re-run the FULL tier`);
  }
  if (b.ok !== true) return item(N, "FAIL", `failed: ${b.why || "no reason recorded"}`);
  if (!b.verify || b.verify.ok !== true || b.verify.packChecksumOk !== true) return item(N, "FAIL", `recorded ok but not verified (git bundle verify exit ${b.verify ? b.verify.gitVerifyExit : "?"}, pack checksum ${b.verify ? b.verify.packChecksumOk : "?"}) — inconsistent record`);
  if (!b.path || !Number.isFinite(b.sizeBytes)) return item(N, "FAIL", "recorded ok but no bundle path/size — inconsistent record");
  const sz = fileSize(b.path);
  if (sz == null) return item(N, "FAIL", `${b.path} is gone`);
  if (sz !== b.sizeBytes) return item(N, "FAIL", `${b.path} is ${sz} bytes, recorded ${b.sizeBytes}`);
  const head = `${path.basename(b.path)} (${(b.sizeBytes / 1e6).toFixed(1)} MB, ${b.objects} objects, ${b.refs} refs; git verify + pack checksum ok)`;
  const m = b.mirror && typeof b.mirror === "object" ? b.mirror : null;
  if (!m || m.configured !== true) {
    if (sc && !sc.skipped) return item(N, "FAIL", `${head}; a history scan ran but no mirror is recorded — inconsistent record`);
    return item(N, "PASS", `${head}; kept local only — no mirror this run (${m && m.source ? `mirror source ${m.source}` : "not configured"}), so no history scan was needed; the off-disk mirror item covers that`);
  }
  if (!sc || sc.skipped) return item(N, "FAIL", `${head}; mirror configured but the history scan did not run (${sc ? sc.skipped : "no scan recorded"})`);
  if (!(complete && sc.ok === true && !sc.error && sc.needles > 0)) return item(N, "FAIL",`${head}; history scan not complete: ${sc.error || "no error recorded"} (${sc.objects ?? "?"} of ${exp.objects ?? "?"} objects, ${sc.bytes ?? "?"} of ${exp.bytes ?? "?"} bytes, git exit ${sc.gitExit ?? "?"}, ${sc.needles ?? 0} needles)`);
  if (b.mirrored !== true || m.ok !== true || !m.file) return item(N, "FAIL", `${head}; history clean but NOT mirrored: ${m.error || "no reason recorded"}`);
  const dirSeen = fs.existsSync(path.dirname(m.file)), msz = fileSize(m.file);
  if (dirSeen && msz == null) return item(N, "FAIL", `${head}; ${m.file} is gone from the mirror`);
  if (dirSeen && msz !== b.sizeBytes) return item(N, "FAIL", `${head}; ${m.file} is ${msz} bytes, the bundle is ${b.sizeBytes}`);
  item(N, "PASS", `${head}; history scan ${sc.objects} objects / ${(sc.bytes / 1e9).toFixed(2)} GB (= the --batch-check totals), ${sc.needles} needles, no hits${sc.secs != null ? `, ${sc.secs} s` : ""}; mirrored to ${m.file}${dirSeen ? "" : " (mirror not reachable from this session, so not re-checked now)"}`);
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
