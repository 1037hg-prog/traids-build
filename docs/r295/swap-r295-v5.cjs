// Swaps R295 v4 -> v5 after today's session (operator 2026-10-02: "yes fix it after close"). Waits until 14:00 MT (20:00Z), confirms the
// session process is gone, that the live file is still the v4 it was patched from, and that the pending file rebuilds byte-identically;
// backs up v4, swaps atomically, syntax-checks and selftests. Usage: node swap-r295-v5.js <backend dir>
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { execFileSync } = require("child_process");
const BK = process.argv[2], LIVE = path.join(BK, "r295-orb-forward.js"), PEND = path.join(BK, "r295-orb-forward.v5-pending.js"), CHK = path.join(BK, "r295-orb-forward.v5-check.js");
const PATCH = path.join(BK, "..", "docs", "r295", "patch-r295-v5.cjs"), BAK = path.join(BK, "..", "docs", "r295", "r295-orb-forward.v4.js");
const V4_PREFIX = "a54ac52f3a2d2bfa", sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const log = (...a) => console.log(new Date().toISOString(), ...a);
(async () => {
  while (Date.now() < Date.parse("2026-10-02T20:00:00Z")) await new Promise((r) => setTimeout(r, 30000));
  const lock = path.join(BK, "data", "training", "r295", "session-2026-10-02.lock");
  for (let i = 0; i < 40; i++) { let alive = false; try { const l = JSON.parse(fs.readFileSync(lock, "utf8")); process.kill(l.pid, 0); alive = true; } catch {} if (!alive) break; log("session process still alive — waiting"); await new Promise((r) => setTimeout(r, 30000)); }
  if (!sha(LIVE).startsWith(V4_PREFIX)) { log("ABORT: live file changed since the patch was prepared"); process.exit(2); }
  execFileSync(process.execPath, [PATCH, BK, CHK]); if (sha(CHK) !== sha(PEND)) { log("ABORT: pending file does not rebuild identically"); process.exit(2); } fs.unlinkSync(CHK);
  fs.copyFileSync(LIVE, BAK); fs.copyFileSync(PEND, LIVE + ".tmp"); fs.renameSync(LIVE + ".tmp", LIVE); fs.unlinkSync(PEND);
  execFileSync(process.execPath, ["-c", LIVE]); const st = execFileSync(process.execPath, [LIVE, "--selftest"]).toString();
  log("SWAPPED to v5 · backup", BAK, "·", st.trim().split("\n").pop());
})().catch((e) => { log("FAILED", e.message); process.exit(1); });
