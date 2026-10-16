"use strict";
/**
 * SSH plumbing for the research-stage01 package (home side, Windows OpenSSH). Same fail-closed rules as phase0-golive/deploy.cjs:
 * every guard read THROWS on an ssh / read failure — a failed read is never "absent", "empty" or "not running".
 */
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const HOST = "traids";
const ROOT = "/home/traids/traids", FACTORY = ROOT + "/factory", SYSD = "/etc/systemd/system";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function ssh(script, { input = "", timeout = 180000, encoding = "utf8" } = {}) {
  const r = cp.spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", HOST, script], { input, encoding, timeout, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  return { ok: !r.error && r.status === 0, status: r.status, out: r.stdout || (encoding ? "" : Buffer.alloc(0)), err: String(r.stderr || "") + (r.error ? r.error.message : "") };
}
function must(r, what) { if (!r.ok) throw new Error(`${what} failed (exit ${r.status}): ${String(r.err || r.out).trim().slice(0, 500)}`); return r.out; }
/** upload a buffer atomically: temp in the same directory, sha256-verified, mode/owner set, renamed in */
function upload(remote, buf, { sudo = false, mode = "640", owner = null } = {}) {
  const S = sudo ? "sudo -n " : "", tmpBase = `${path.posix.dirname(remote)}/.${path.posix.basename(remote)}.rs01-`;
  const script = ["set -eu", `t=${q(tmpBase)}$$`, `${S}tee "$t" > /dev/null`, `s=$(${S}sha256sum "$t" | cut -c1-64)`,
    `if [ "$s" != "${sha(buf)}" ]; then ${S}rm -f "$t"; echo "sha256 mismatch after upload" >&2; exit 9; fi`,
    `${S}chmod ${mode} "$t"`, owner ? `${S}chown ${owner} "$t"` : ":", `${S}mv -f "$t" ${q(remote)}`, "echo uploaded"].join("\n");
  return must(ssh(script, { input: buf }), `upload ${remote}`);
}
/** sha256 of a remote file, or null when ABSENT; an ssh / read failure THROWS */
function remoteSha(p, sudo = false) {
  const S = sudo ? "sudo -n " : "";
  const out = must(ssh(`set -o pipefail; if ${S}test -e ${q(p)}; then ${S}sha256sum ${q(p)} | cut -c1-64; else echo ABSENT; fi`), `sha256 of ${p}`).trim();
  if (out === "ABSENT") return null;
  if (!/^[0-9a-f]{64}$/.test(out)) throw new Error(`sha256 of ${p}: unexpected reply ${JSON.stringify(out.slice(0, 80))}`);
  return out;
}
/** exactly YES or NO, anything else THROWS */
function remoteYes(test, what) {
  const out = must(ssh(`if ${test}; then echo YES; else echo NO; fi`), what).trim();
  if (out !== "YES" && out !== "NO") throw new Error(`${what}: unexpected reply ${JSON.stringify(out.slice(0, 60))} — REFUSED`);
  return out === "YES";
}
module.exports = { HOST, ROOT, FACTORY, SYSD, sha, q, ssh, must, upload, remoteSha, remoteYes };
