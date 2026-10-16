#!/usr/bin/env node
/**
 * ROLLBACK — undo the R309 go-live package, 2026-10-06. Each part refuses rather than guess; --dry prints the plan only.
 *
 *   node docs/server/phase0-golive/rollback.cjs --unflip [--lots-open-ok]
 *        --live -> --dry in traids-r309.service (sha-checked). REFUSED while the VPS ledger has an unfinished lot (submitting /
 *        submitted / open / exiting / error) unless --lots-open-ok: a dry unit sends no SELL, so such a lot would be held past its
 *        48 h. Writes data/r309-unflipped (time + flags) so r309-health knows a DRY unit with live history is deliberate
 *        (deploy --flip-live clears it), and records "unflip" in deploy-state.json. Judged on the unit FILE and on what systemd
 *        has LOADED (systemctl show NeedDaemonReload / ExecStart): an earlier unflip whose daemon-reload was lost (file --dry,
 *        systemd still --live) is completed — reload, verify, marker — never reported "nothing to do"; a dry unit whose marker
 *        is missing or older than the last live row gets the marker. To stop NEW entries while exits continue, prefer:  ssh traids 'touch /home/traids/traids/backend/data/r309-OFF'
 *        To stop ALL sending at once:                              ssh traids 'touch /home/traids/traids/backend/data/r309-HALT'
 *   node docs/server/phase0-golive/rollback.cjs --server
 *        Back to Phase 0: the r309-v1 file from its .bak (sha-checked = fc31af45…), traids-alert.cjs removed, the exact Phase 0
 *        units (phase0-units/: --dry, local-time :02 timer, no OnFailure) restored, traids-alert@.service removed, daemon-reload,
 *        timer restarted, then the loaded state verified (--dry, no reload pending). REFUSED if the VPS has ANY ledger row or live
 *        cycle row, or the unit is --live in the file OR as loaded: r309-v1 trades the MAIN account and must never run over lots
 *        bought on TV — use OFF / HALT instead.
 *   node docs/server/phase0-golive/rollback.cjs --remove-secrets
 *        removes /etc/traids/traids.env and the backend/.env symlink (only if it is that symlink). Refused while the unit is --live
 *        (in the file or as loaded) or a daemon-reload is pending.
 *   node docs/server/phase0-golive/rollback.cjs --home
 *        home-patch revertAll: every patched home file restored from its .pre-r309-golive-2026-10-06.bak if it is still exactly
 *        what the package wrote; new files removed. Refused file by file otherwise (nothing reverted).
 *   node docs/server/phase0-golive/rollback.cjs --selftest       (pure parts; no ssh)
 * Never touches home backend/data/r309-HALT, the VPS data files (beyond the r309-unflipped marker), or the registry note (a dated
 * note is history, not state). Every guard read is FAIL-CLOSED: an ssh / read failure refuses; it is never read as an empty
 * ledger, no live rows, or a --dry unit (a missing file is told apart from a failed read).
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const HERE = __dirname;
const D = require(path.join(HERE, "deploy.cjs"));
const HOST = "traids", RB = "/home/traids/traids/backend", RD = RB + "/data", SYSD = "/etc/systemd/system";
const R309_BASE = "fc31af454553a43f9a808cbbf23a06f80cf543a00fc49ed641febad3717bb369";
const PHASE0 = { "traids-r309.service": "773b96f9a9cf117f2a3ca088555a95759d28018e47085777097d55ebae9d0cdb", "traids-r309.timer": "a64ba6bf19b524af6fdddc2d597d43e3d0438bd3484ddb0d45e2b346c4012fb4" };
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const cp = require("child_process");
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function ssh(script, input = "") { const r = cp.spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", HOST, script], { input, encoding: "utf8", timeout: 180000, windowsHide: true }); return { ok: !r.error && r.status === 0, out: r.stdout || "", err: String(r.stderr || "") + (r.error ? r.error.message : "") }; }
function must(r, what) { if (!r.ok) throw new Error(`${what} failed: ${String(r.err || r.out).trim().slice(0, 300)}`); return r.out; }
function upload(remote, buf) {   // root-owned unit file: temp in the same dir, sha-verified, renamed
  const t = `${path.posix.dirname(remote)}/.${path.posix.basename(remote)}.rollback-`;
  must(ssh([`set -eu`, `t=${q(t)}$$`, `sudo -n tee "$t" > /dev/null`, `[ "$(sudo -n sha256sum "$t" | cut -c1-64)" = "${sha(buf)}" ] || { sudo -n rm -f "$t"; echo "sha mismatch" >&2; exit 9; }`,
    `sudo -n chmod 644 "$t"`, `sudo -n chown root:root "$t"`, `sudo -n mv -f "$t" ${q(remote)}`].join("\n"), buf), "upload " + remote);
}
/** Pure: the VPS ledger text + cycles text -> what is unfinished / whether any evidence exists */
function ledgerFacts(ledgerText, cyclesText) {
  const rows = String(ledgerText || "").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return { unreadable: true }; } });
  const unfinished = rows.filter((r) => r.unreadable || (r.kind === "lot" && ["submitting", "submit-error", "submitted", "open", "exiting", "error"].includes(r.status)));
  const liveLines = String(cyclesText || "").split("\n").filter((l) => /"live":true/.test(l));
  let lastLiveMs = null; for (const l of liveLines) { try { const ms = Date.parse(JSON.parse(l).ts); if (Number.isFinite(ms) && (lastLiveMs == null || ms > lastLiveMs)) lastLiveMs = ms; } catch { /* a torn line: counted, not dated */ } }
  return { rows: rows.length, unfinished: unfinished.map((r) => r.unreadable ? "an unreadable row" : `${r.id} ${r.status}`), liveRows: liveLines.length, lastLiveMs };
}
/** Pure: is the deliberate-unflip marker (its first token is the UTC time rollback wrote it) current — newer than the last live row? */
function markerCurrent(markerText, lastLiveMs) {
  if (lastLiveMs == null) return true;                                 // no live history: nothing for r309-health to excuse
  const ms = Date.parse(String(markerText || "").trim().split(/\s+/)[0] || "");
  return Number.isFinite(ms) && ms >= lastLiveMs;
}
/** Pure: the reply of readOrAbsent's remote command -> the file text ("" when absent); anything malformed THROWS */
const ABSENT = "@@R309-ABSENT@@";
function parseReadReply(out, what) {
  const s = String(out || "");
  if (s === ABSENT + "\n" || s === ABSENT) return "";
  if (!s.startsWith("@@R309-FILE@@\n")) throw new Error(`${what}: unexpected reply (not a file, not absent) — REFUSED`);
  return s.slice("@@R309-FILE@@\n".length);
}
/** read a VPS file fail-closed: a missing file is "", an ssh / read failure THROWS (never read as an empty ledger) */
function readOrAbsent(p, what) {
  const r = ssh(`set -o pipefail; if [ -e ${q(p)} ]; then printf '@@R309-FILE@@\\n' && cat ${q(p)}; else printf '${ABSENT}\\n'; fi`);
  if (!r.ok) throw new Error(`${what}: could not read ${p} over ssh (exit ${r.status}) — REFUSED (a failed read is never an empty ledger): ${r.err.trim().slice(0, 160)}`);
  return parseReadReply(r.out, what);
}
const facts = () => ledgerFacts(readOrAbsent(RD + "/r309-ledger.jsonl", "ledger"), readOrAbsent(RD + "/r309-cycles.jsonl", "cycle log"));
/** the unit's mode in the file AND as loaded (deploy.cjs unitState: fail-closed) */
const loaded = (what) => D.unitState(what);
const writeMarker = (f) => must(ssh(`printf '%s rollback.cjs --unflip%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ${q(f.unfinished.length ? " --lots-open-ok (" + f.unfinished.join(", ") + ")" : "")} > ${q(RD + "/r309-unflipped")}`), "write data/r309-unflipped");

function unflip({ dry, lotsOpenOk }) {
  const w = D.windowRefusal(Date.now()); if (w) throw new Error(w);
  const p = `${SYSD}/traids-r309.service`, U = loaded("unflip"), f = facts();
  if (U.fileMode === "dry" && U.loadedMode === "dry" && !U.needReload) {
    // already dry where it counts — but an unflip interrupted after its reload may not have written the marker
    if (markerCurrent(readOrAbsent(RD + "/r309-unflipped", "unflip marker"), f.lastLiveMs)) return console.log("unflip: the unit is --dry (file and loaded) and the marker is current — nothing to do");
    console.log(`unflip: the unit is --dry (file and loaded) but data/r309-unflipped is missing or older than the last live row — ${dry ? "would write" : "writing"} it`);
    if (dry) return;
    writeMarker(f); D.record("unflip", { ok: true, completed: "marker" });
    return console.log("unflip: done — data/r309-unflipped written");
  }
  // systemd may still run --live (the file, or the loaded definition, or a pending reload): the lots guard applies
  if (f.unfinished.length && !lotsOpenOk) throw new Error(`unflip REFUSED: unfinished lot(s) on the VPS: ${f.unfinished.join(", ")} — a dry unit would not sell them at 48 h. Use r309-OFF (exits continue) or pass --lots-open-ok deliberately.`);
  const next = Buffer.from(D.withMode(U.text, "dry"));
  console.log(`unflip: ${U.fileMode === "live" ? `${dry ? "would set" : "setting"} ExecStart ... --cycle --dry` : `the unit file is already --dry but systemd runs --${U.loadedMode}${U.needReload ? " (reload pending)" : ""} — ${dry ? "would complete" : "completing"} the earlier unflip`}${f.unfinished.length ? " (lots left open: " + f.unfinished.join(", ") + ")" : ""}`);
  if (dry) return;
  if (U.fileMode === "live") upload(p, next);
  must(ssh("sudo -n systemctl daemon-reload"), "daemon-reload");
  const A = loaded("unflip (after the reload)");
  if (A.fileMode !== "dry" || A.loadedMode !== "dry" || A.needReload) throw new Error(`unflip: verification failed — file --${A.fileMode}, systemd runs --${A.loadedMode}, NeedDaemonReload ${A.needReload ? "yes" : "no"}`);
  // the deliberate-unflip marker: r309-health reads it while the unit is DRY. Without it, a DRY unit with live history is an
  // accidental un-flip (FAIL); with it (newer than the last live row) the dry state is the operator's. deploy --flip-live clears it.
  writeMarker(f); D.record("unflip", { ok: true });
  console.log("unflip: done — " + must(ssh(`grep '^ExecStart=' ${q(p)}`), "verify").trim() + " · systemd runs --dry · data/r309-unflipped written");
}
function server({ dry }) {
  const w = D.windowRefusal(Date.now()); if (w) throw new Error(w);
  const f = facts();
  if (f.rows || f.liveRows) throw new Error(`--server REFUSED: the VPS has ${f.rows} ledger row(s) and ${f.liveRows} live cycle row(s). r309-v1 trades the MAIN account and must never run over TV lots. Use r309-OFF / r309-HALT (and --unflip once nothing is open).`);
  { const U = loaded("--server"); if (U.fileMode === "live" || U.loadedMode === "live" || U.needReload) throw new Error(`--server REFUSED: the unit is --${U.fileMode} in the file and --${U.loadedMode} as loaded${U.needReload ? " (reload pending)" : ""}; --unflip first`); }
  const bak = `${RB}/r309-surge-hold48.js.pre-golive-2026-10-06.bak`, bs = must(ssh(`if [ -e ${q(bak)} ]; then sha256sum ${q(bak)} | cut -c1-64; else echo ABSENT; fi`), "sha of the r309 .bak").trim();
  const curR = must(ssh(`sha256sum ${q(RB + "/r309-surge-hold48.js")} | cut -c1-64`), "sha of the VPS r309").trim();
  const plan = [];
  if (curR !== R309_BASE) { if (bs !== R309_BASE) throw new Error("--server REFUSED: no r309 .bak with the Phase 0 sha on the VPS"); plan.push(["restore r309-v1 from its .bak", `cd ${q(RB)} && cp -p r309-surge-hold48.js.pre-golive-2026-10-06.bak .r309-rollback.tmp && mv -f .r309-rollback.tmp r309-surge-hold48.js`]); }
  plan.push(["remove traids-alert.cjs", `rm -f ${q(RB + "/traids-alert.cjs")}`]);
  for (const u of Object.keys(PHASE0)) plan.push([`restore Phase 0 ${u}`, null, u]);
  plan.push(["remove traids-alert@.service", `sudo -n rm -f ${q(SYSD + "/traids-alert@.service")}`]);
  plan.push(["daemon-reload + timer restart", "sudo -n systemctl daemon-reload && sudo -n systemctl restart traids-r309.timer"]);
  for (const [what] of plan) console.log(`--server: ${dry ? "would " : ""}${what}`);
  if (dry) return;
  for (const [what, cmd, u] of plan) {
    if (u) { const buf = fs.readFileSync(path.join(HERE, "phase0-units", u)); if (sha(buf) !== PHASE0[u]) throw new Error(`phase0-units/${u} is not the Phase 0 file`); upload(`${SYSD}/${u}`, buf); }
    else must(ssh(cmd), what);
  }
  const A = loaded("--server (after)");
  if (A.fileMode !== "dry" || A.loadedMode !== "dry" || A.needReload) throw new Error(`--server: verification failed — file --${A.fileMode}, systemd runs --${A.loadedMode}, NeedDaemonReload ${A.needReload ? "yes" : "no"}`);
  console.log("--server: done — " + must(ssh(`grep '^ExecStart=' ${q(SYSD + "/traids-r309.service")}; sha256sum ${q(RB + "/r309-surge-hold48.js")} | cut -c1-12`), "verify").replace(/\n/g, " · ") + " · systemd runs --dry, no reload pending");
}
function removeSecrets({ dry }) {
  { const U = loaded("--remove-secrets"); if (U.fileMode === "live" || U.loadedMode === "live" || U.needReload) throw new Error("--remove-secrets REFUSED: the unit is --live (in the file or as loaded) or a reload is pending (it would run keyless); --unflip first"); }
  console.log(`--remove-secrets: ${dry ? "would remove" : "removing"} /etc/traids/traids.env and the backend/.env symlink`);
  if (dry) return;
  must(ssh(`cd ${q(RB)} && if [ -L .env ] && [ "$(readlink .env)" = /etc/traids/traids.env ]; then rm -f .env; fi; sudo -n rm -f /etc/traids/traids.env; ls -la .env 2>&1 | head -1; sudo -n ls -la /etc/traids`), "remove secrets");
  console.log("--remove-secrets: done");
}
function home({ dry }) {
  const HP = require(path.join(HERE, "home-patch.cjs"));
  for (const l of HP.revertAll(undefined, { dry })) console.log("--home: " + l);
}
function selftest() {
  let pass = 0, fail = 0;
  const ok = (name, cond, d) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (d ? " — " + d : "")); } };
  const L = (o) => JSON.stringify(o);
  const f1 = ledgerFacts([L({ kind: "lot", id: "a", status: "closed" }), L({ kind: "lot", id: "b", status: "exiting" }), L({ kind: "missed", id: "c" })].join("\n") + "\n", '{"live":true}\n{"live":false}\n');
  ok("ledger facts: an exiting lot is unfinished; closed and missed are not; live rows counted", f1.unfinished.join() === "b exiting" && f1.rows === 3 && f1.liveRows === 1);
  ok("ledger facts: an unreadable row counts as unfinished (refuse rather than guess)", ledgerFacts("{bad\n", "").unfinished.length === 1);
  ok("ledger facts: empty VPS -> nothing unfinished, no rows", ledgerFacts("", "").rows === 0 && ledgerFacts("", "").liveRows === 0);
  let e1 = null; try { parseReadReply("", "ledger"); } catch (e) { e1 = e.message; }
  let e2 = null; try { parseReadReply("garbage\n", "ledger"); } catch (e) { e2 = e.message; }
  ok("fail-closed reads: an absent file is \"\", a file is its text, an empty / malformed reply (a failed ssh) THROWS — never an empty ledger", parseReadReply(ABSENT + "\n", "x") === "" && parseReadReply("@@R309-FILE@@\n{\"a\":1}\n", "x") === '{"a":1}\n' && /unexpected reply/.test(e1 || "") && /unexpected reply/.test(e2 || ""));
  for (const [u, s] of Object.entries(PHASE0)) ok(`phase0-units/${u} is byte-identical to what Phase 0 installed (sha ${s.slice(0, 12)})`, sha(fs.readFileSync(path.join(HERE, "phase0-units", u))) === s);
  const p0 = fs.readFileSync(path.join(HERE, "phase0-units", "traids-r309.service"), "utf8");
  ok("the Phase 0 unit is --dry (a server rollback never lands live)", D.modeOf(p0) === "dry");
  // re-verification 2026-10-06: an unflip whose daemon-reload was lost reported "already --dry — nothing to do" while systemd ran --live
  const cyc = '{"ts":"2026-10-08T14:02:09Z","live":true}\n{"ts":"2026-10-08T15:02:09Z","live":true}\n{"live":true,"ts":"2026-10-08T16:0';
  const fx = ledgerFacts("", cyc);
  ok("the last live row is dated (a torn tail counted, not dated); the marker is current only when newer than it; no live history needs none", fx.liveRows === 3 && fx.lastLiveMs === Date.parse("2026-10-08T15:02:09Z") && markerCurrent("2026-10-08T15:30:00Z rollback.cjs --unflip\n", fx.lastLiveMs) && !markerCurrent("2026-10-08T14:30:00Z rollback.cjs --unflip\n", fx.lastLiveMs) && !markerCurrent("", fx.lastLiveMs) && markerCurrent("", null));
  const src = fs.readFileSync(__filename, "utf8");
  ok("unflip / --server / --remove-secrets judge the LOADED state (deploy unitState), never the file alone; unflip verifies after its reload", !src.includes("function " + "unitMode") && /U = loaded\("unflip"\)/.test(src) && /loaded\("unflip \(after the reload\)"\)/.test(src) && /loaded\("--server"\)/.test(src) && /loaded\("--remove-secrets"\)/.test(src));
  console.log(`rollback selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2), dry = a.includes("--dry");
  try {
    if (a.includes("--selftest")) process.exitCode = selftest() ? 0 : 1;
    else {
      let did = false;
      if (a.includes("--unflip")) { unflip({ dry, lotsOpenOk: a.includes("--lots-open-ok") }); did = true; }
      if (a.includes("--server")) { server({ dry }); did = true; }
      if (a.includes("--remove-secrets")) { removeSecrets({ dry }); did = true; }
      if (a.includes("--home")) { home({ dry }); did = true; }
      if (!did) { console.log("rollback: give --unflip, --server, --remove-secrets and/or --home (add --dry to see the plan). See the header."); process.exitCode = 2; }
      else process.exitCode = 0;
    }
  } catch (e) { console.error("rollback: " + e.message); process.exitCode = 1; }
}
module.exports = { ledgerFacts, parseReadReply, markerCurrent };
