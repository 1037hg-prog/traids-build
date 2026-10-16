#!/usr/bin/env node
/**
 * ROLLBACK — undo W1c / W2a, 2026-10-08 (docs/server/wave1c-2a). Each part refuses rather than guess; --dry prints the plan.
 *
 *   node docs/server/wave1c-2a/rollback.cjs --wave w1c       ONE command per wave: the own.cjs <wave> home path (W1's standing
 *   node docs/server/wave1c-2a/rollback.cjs --wave w2a       machinery: the VPS map pushed first so the VPS stops, a final pull brings
 *        its file home, home's map -> home and home's gated .bat line runs again), plus what own.cjs cannot do for these units:
 *        w2a  traids-fills is ONE long-running process, which a map change does not stop (ExecCondition is read at start only): the
 *             service and its keeper timer are stopped BEFORE own.cjs (after its --dry guards pass), so the final pull reads a closed
 *             file; the keeper timer is started again afterwards (from then on it only condition-skips).
 *        both the wave's shadow timer disabled and its service stopped (they are gated "home" and would start again).
 *        own.cjs checks R323's weekend calendar on every wave's rollback; that is a W1 matter (no R323 recorder moves here), so this
 *        passes --accept-r323-weekend-gaps and omits own.cjs's R323 text. Pass-through: --dry · --no-pull · --server-down ·
 *        --accept-lost-files (own.cjs's meanings; --server-down cannot stop the VPS process: split-brain until the VPS is reachable and
 *        this runs again without it). Then: node docs/server/wave1c-2a/register.cjs --rollback <wave>.
 *   node docs/server/wave1c-2a/rollback.cjs --shadow         the 4 shadow units removed and /home/traids/w1c2a-shadow deleted (any time)
 *   node docs/server/wave1c-2a/rollback.cjs --server         after both waves are home-owned on BOTH maps: the shadow, the 4 real units,
 *        /etc/traids/{w1c-spread,w2a-fills}.env, and the two scripts this package copied (only while still the copies it sent).
 *        R309's and W1's units, files and env are never named. VPS data files are kept.
 *   node docs/server/wave1c-2a/rollback.cjs --home           an EXACT restore of every home patch (home-patch revertAll: each anchor
 *        line back in place, byte for byte; the 4 new files removed, an edited one kept and named; each .pre-w1c2a.bak record removed
 *        when byte-equal to the restored file, kept and named otherwise). It leaves backend/data/crypto-symbols.json (data; nothing at
 *        home reads it once the chain step is gone) and the map entries w1c-spread / w2a-fills (own.cjs's map). REFUSED while either map gives
 *        w1c-spread / w2a-fills to the server (fail-closed over ssh; --vps-gone skips the VPS for a VPS really destroyed), inside the
 *        chain / intraday windows, outside the preflight.bat window, or while a preflight / intraday / board-discipline .bat runs (M6).
 *        Run it BEFORE W1's own package removal (docs/server/wave1-crypto/rollback.cjs --home), whose chain / preflight lines anchor ours.
 *   node docs/server/wave1c-2a/rollback.cjs --selftest       pure parts and a fake VPS; no ssh
 * Never touches home backend/data/r309-HALT, any R309 or W1 file or unit, the registry or a governance file.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", ".."), DS = path.join(REPO, "deploy", "server");
const PS = require(path.join(DS, "pull-server.cjs")), OWN = require(path.join(DS, "own.cjs"));
const HP = require(path.join(HERE, "home-patch.cjs")), UN = require(path.join(HERE, "units.cjs")), DEP = require(path.join(HERE, "deploy.cjs"));
const { sha, q } = PS;
const RB = "/home/traids/traids/backend", RD = RB + "/data", SYSD = "/etc/systemd/system", SHADOW_ROOT = "/home/traids/w1c2a-shadow";
const OURS = DEP.OURS, X = { w1c: "spread", w2a: "fills" };
const COPIED = ["crypto-spread-snapshot.js", "alpaca-fills-stream.js"];
let SSH = PS.sshReal("traids"), log = (s) => console.log(s);
let RUN_OWN = (args) => { const r = cp.spawnSync(process.execPath, [path.join(DS, "own.cjs"), ...args], { cwd: REPO, encoding: "utf8", windowsHide: true, timeout: 3600000 }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") }; };
const must = (r, what) => { if (!r.ok) throw new Error(`${what} failed (exit ${r.status}): ${String(r.err || r.out).trim().slice(0, 300)}`); return String(r.out); };

/** own.cjs's argv for a rollback of these units (always home; R323's acceptance passed: W1-only) */
function ownArgs(wave, o = {}) {
  if (!X[wave]) throw new Error("bad wave");
  return [wave, "home", "--accept-r323-weekend-gaps", ...(o.dry ? ["--dry"] : []), ...(o.noPull ? ["--no-pull"] : []), ...(o.serverDown ? ["--server-down"] : []), ...(o.acceptLost ? ["--accept-lost-files"] : [])];
}
/** own.cjs's R323 weekend-gap text concerns W1 only: drop it (a line of its own) or cut it off a longer line */
const R323_TEXT = "R323's snapshot calendar is 7-day";
function scrubR323(line) { if (/^R323: /.test(line)) return null; const i = line.indexOf(R323_TEXT); return i < 0 ? line : line.slice(0, i).trimEnd() + " [own.cjs's R323 weekend-gap text omitted: it concerns W1 only]"; }
const show = (out) => { for (const l of String(out).split(/\r?\n/).filter(Boolean)) { const s = scrubR323(l); if (s != null) log("   own.cjs: " + s); } };
const unitsCommand = (units) => `sudo -n systemctl disable --now ${units.filter((u) => u.endsWith(".timer")).join(" ")} >/dev/null 2>&1 || true; sudo -n systemctl stop ${units.filter((u) => u.endsWith(".service")).join(" ")} >/dev/null 2>&1 || true; for u in ${units.join(" ")}; do sudo -n rm -f -- ${SYSD}/$u; done; sudo -n systemctl daemon-reload && sudo -n systemctl reset-failed ${units.filter((u) => u.endsWith(".service")).join(" ")} >/dev/null 2>&1; echo REMOVED`;
function vpsMapUnits() {
  const r = SSH(`cat ${q(RD + "/host-ownership.json")} 2>/dev/null || echo ABSENT`);
  if (!r.ok) throw new Error(`reading the VPS map failed (exit ${r.status}) — REFUSED (an unreadable map is never read as 'home')`);
  const t = String(r.out).trim(); if (t === "ABSENT") return null;
  try { return JSON.parse(t); } catch { throw new Error("the VPS map does not parse — REFUSED"); }
}
const serverOwned = (map) => OURS.filter((u) => map && map.units && map.units[u] === "server");

function wave(w, o = {}) {
  if (!X[w]) throw new Error("--wave needs w1c or w2a");
  const x = X[w];
  log(`== --wave ${w}: own.cjs ${w} home${w === "w2a" ? " (traids-fills stopped first, its keeper timer started after)" : ""}, then the ${w} shadow disabled`);
  if (o.dry || o.serverDown) {
    const r = RUN_OWN(ownArgs(w, o)); show(r.out);
    if (r.status !== 0) throw new Error(`own.cjs ${w} home${o.dry ? " --dry" : " --server-down"} exited ${r.status} (above)`);
    if (o.serverDown) log(`   --server-down: the VPS was not touched — if it is alive traids-${x} keeps running (split-brain). When it is reachable: node docs/server/wave1c-2a/rollback.cjs --wave ${w}`);
    return 0;
  }
  if (w === "w2a") {
    const d = RUN_OWN(ownArgs(w, { ...o, dry: true })); show(d.out);
    if (d.status !== 0) throw new Error(`own.cjs w2a home --dry refused (above) — nothing stopped, nothing changed`);
    const s = must(SSH("sudo -n systemctl stop traids-fills.timer traids-fills.service; echo \"FILLS $(systemctl is-active traids-fills.service) $(systemctl is-active traids-fills.timer)\""), "stop traids-fills");
    if (!/FILLS inactive inactive/.test(s)) throw new Error(`traids-fills did not stop (${s.trim()}) — own.cjs NOT run; nothing else changed`);
    log("   traids-fills.service and its keeper timer stopped (the final pull reads a closed file)");
  }
  const r = RUN_OWN(ownArgs(w, o)); show(r.out);
  if (r.status !== 0) {
    if (w === "w2a") throw new Error(`own.cjs w2a home exited ${r.status} (above). traids-fills and its timer are STOPPED on the VPS. Fix the cause and re-run this command; or resume the VPS instead: ssh traids sudo systemctl start traids-fills.timer traids-fills.service`);
    throw new Error(`own.cjs ${w} home exited ${r.status} (above — it says which host runs the unit now)`);
  }
  if (w === "w2a") { const t = must(SSH("sudo -n systemctl start traids-fills.timer; echo \"TIMER $(systemctl is-active traids-fills.timer)\""), "start the keeper timer"); log(`   keeper timer: ${t.trim().replace(/^TIMER /, "")} (it now only condition-skips: home owns w2a-fills)`); }
  const sh = SSH(`sudo -n systemctl disable --now traids-${x}-shadow.timer >/dev/null 2>&1; sudo -n systemctl stop traids-${x}-shadow.service >/dev/null 2>&1; echo "SHADOW $(systemctl is-active traids-${x}-shadow.service 2>/dev/null)"`);
  log(sh.ok && /SHADOW inactive/.test(String(sh.out)) ? `   shadow traids-${x}-shadow: off (it is gated "home" and would start again)` : `   note: the shadow could not be confirmed off — node docs/server/wave1c-2a/rollback.cjs --shadow`);
  log(`   done. Record it: node docs/server/wave1c-2a/register.cjs --rollback ${w}`);
  return 0;
}
function shadow({ dry = false } = {}) {
  log(`== --shadow: ${UN.SHADOW_UNITS.join(", ")} stopped, disabled, removed; ${SHADOW_ROOT} deleted`);
  if (dry) { log("   (dry: nothing done)"); return 0; }
  must(SSH(unitsCommand(UN.SHADOW_UNITS)), "remove the shadow units");
  must(SSH(`case ${q(SHADOW_ROOT)} in /home/traids/w1c2a-shadow) rm -rf -- ${q(SHADOW_ROOT)} && echo GONE;; *) exit 3;; esac`), "delete the shadow tree");
  const left = must(SSH(`ls ${UN.SHADOW_UNITS.map((u) => SYSD + "/" + u).join(" ")} 2>/dev/null | wc -l; test -e ${q(SHADOW_ROOT)} && echo TREE || echo NOTREE`), "verify").trim().split("\n");
  if (left[0] !== "0" || left[1] !== "NOTREE") throw new Error("verification failed: " + left.join(" "));
  log("   done: no shadow unit file, no shadow tree");
  return 0;
}
function server({ dry = false } = {}) {
  let hm = null; try { hm = JSON.parse(fs.readFileSync(path.join(PS.HOME_DATA, "host-ownership.json"), "utf8")); } catch { hm = null; }
  if (!hm) throw new Error("home's map is unreadable — REFUSED");
  const hs = serverOwned(hm), vs = serverOwned(vpsMapUnits());
  if (hs.length || vs.length) throw new Error(`REFUSED: ${[...new Set([...hs, ...vs])].join(", ")} server-owned (home map: ${hs.join(", ") || "none"}; VPS map: ${vs.join(", ") || "none"}) — run --wave <w1c|w2a> first`);
  const cur = PS.remoteShas(SSH, RB, COPIED), sent = Object.fromEntries(COPIED.map((f) => [f, sha(fs.readFileSync(path.join(HERE, "backend", f)))]));
  const remove = COPIED.filter((f) => cur.get(f) && cur.get(f) === sent[f]), keep = COPIED.filter((f) => cur.get(f) && cur.get(f) !== sent[f]);
  log(`== --server: the shadow, then ${UN.REAL_UNITS.join(", ")} removed; /etc/traids/{w1c-spread,w2a-fills}.env removed; scripts removed: ${remove.join(", ") || "none"}${keep.length ? `; KEPT (not the copy this package sent): ${keep.join(", ")}` : ""}`);
  if (dry) { log("   (dry: nothing done)"); return 0; }
  shadow();
  must(SSH(unitsCommand(UN.REAL_UNITS)), "remove the real units");
  must(SSH(`sudo -n rm -f -- /etc/traids/w1c-spread.env /etc/traids/w2a-fills.env; echo RM`), "remove the env files");
  if (remove.length) must(SSH(`cd ${q(RB)} || exit 7; rm -f -- ${remove.map(q).join(" ")}; echo RM`), "remove the copied scripts");
  const left = must(SSH(`ls ${UN.REAL_UNITS.map((u) => SYSD + "/" + u).join(" ")} /etc/traids/w1c-spread.env /etc/traids/w2a-fills.env 2>/dev/null | wc -l; systemctl is-active traids-r309.timer 2>/dev/null; true`), "verify").trim().split("\n");
  if (left[0] !== "0") throw new Error("verification failed (unit or env files left): " + left.join(" "));
  log(`   done: no W1c / W2a unit or env file on the VPS; traids-r309.timer ${left[1] || "?"} (untouched)`);
  return 0;
}
function home({ dry = false, now = Date.now(), procs, vpsGone = false, homeDir = PS.HOME_DATA, root = REPO } = {}) {
  const mr = PS.readMap(path.join(homeDir, "host-ownership.json"));
  if (!mr.ok) throw new Error(`REFUSED: home's ${mr.why} — an unreadable map is never read as "nothing server-owned"`);
  const hs = serverOwned(mr.map); if (hs.length) throw new Error(`REFUSED: ${hs.join(", ")} server-owned in home's map — run --wave first (reverting the gates would start home's recorder beside the VPS)`);
  if (!vpsGone) {
    const vs = serverOwned(vpsMapUnits());
    if (vs.length) throw new Error(`REFUSED: the VPS map still gives ${vs.join(", ")} to the server (the --server-down state: it keeps running there) — run --wave <w> without --server-down first`);
    log("   the VPS map gives neither unit to the server");
  } else log("   --vps-gone: the VPS map is NOT checked (only for a VPS that has really been destroyed)");
  let cs = null; try { cs = JSON.parse(fs.readFileSync(path.join(homeDir, "chain-status.json"), "utf8")); } catch { cs = null; }
  const g = DEP.editWindow(now, { procs: procs !== undefined ? procs : OWN.procScan(), chainStatus: cs }); if (g) throw new Error(g);
  log("== --home: home-patch revertAll (exact restore)");
  for (const l of HP.revertAll(root, { dry })) log("   " + l);
  return 0;
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + String(d).slice(0, 500) : "")); } };
  const err = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const saveSsh = SSH, saveLog = log, saveRun = RUN_OWN, lines = [];
  log = (s) => lines.push(String(s));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w1c2a-rollback-"));
  try {
    ok("own.cjs argv: always '<wave> home --accept-r323-weekend-gaps' + the pass-through flags; never 'server'", JSON.stringify(ownArgs("w1c")) === JSON.stringify(["w1c", "home", "--accept-r323-weekend-gaps"]) && JSON.stringify(ownArgs("w2a", { dry: true, noPull: true, acceptLost: true })) === JSON.stringify(["w2a", "home", "--accept-r323-weekend-gaps", "--dry", "--no-pull", "--accept-lost-files"]) && !/server"/.test(JSON.stringify(ownArgs("w2a", { serverDown: true }))) && /bad wave/.test(err(() => ownArgs("w1")) || ""));
    ok("own.cjs's R323 text is omitted (its own line dropped, a tail cut), every other line kept", scrubR323("R323: R323's snapshot calendar is 7-day and stays so") === null && /^w2a: HOME RESUMED .* \[own\.cjs's R323 weekend-gap text omitted/.test(scrubR323("w2a: HOME RESUMED without reaching the VPS. R323's snapshot calendar is 7-day ...") || "") && scrubR323("1 VPS map pushed") === "1 VPS map pushed");
    // --wave w2a: the order, and a failed own.cjs leaves the service stopped with the resume command
    const seq = [], vps = (fills = "inactive inactive") => (s) => { seq.push(/systemctl stop traids-fills\.timer/.test(s) ? "stop" : /systemctl start traids-fills\.timer/.test(s) ? "start-timer" : /fills-shadow|spread-shadow/.test(s) ? "shadow" : "other"); return { ok: true, status: 0, out: /stop traids-fills\.timer/.test(s) ? `FILLS ${fills}\n` : /start traids-fills\.timer/.test(s) ? "TIMER active\n" : "SHADOW inactive\n", err: "" }; };
    SSH = vps(); RUN_OWN = (a) => { seq.push("own " + a.filter((x) => x !== "--accept-r323-weekend-gaps").slice(1).join(" ")); return { status: 0, out: "1 VPS map pushed\nR323: R323's snapshot calendar is 7-day\n" }; };
    wave("w2a");
    ok("--wave w2a: own --dry guards FIRST, then traids-fills + its timer stopped, then own.cjs, then the keeper timer started, then the shadow off", seq.join(",") === "own home --dry,stop,own home,start-timer,shadow" && !lines.some((l) => /R323's snapshot/.test(l)), seq.join(","));
    seq.length = 0; RUN_OWN = (a) => { seq.push("own " + a.slice(1).filter((x) => x !== "--accept-r323-weekend-gaps").join(" ")); return { status: a.includes("--dry") ? 0 : 1, out: "the final pull did not complete" }; };
    const e1 = err(() => wave("w2a"));
    ok("--wave w2a: own.cjs fails after the stop -> the error says traids-fills is STOPPED and prints the resume command; the timer is NOT restarted", /STOPPED on the VPS[^]*ssh traids sudo systemctl start traids-fills\.timer traids-fills\.service/.test(e1 || "") && !seq.includes("start-timer"), e1);
    seq.length = 0; RUN_OWN = (a) => { seq.push("own"); return { status: 1, out: "REFUSED (nothing changed): the close chain is due or running" }; };
    const e2 = err(() => wave("w2a"));
    ok("--wave w2a: own.cjs's --dry guards refuse -> nothing stopped (no ssh at all)", /--dry refused/.test(e2 || "") && seq.join(",") === "own", seq.join(","));
    SSH = vps("active inactive"); seq.length = 0; RUN_OWN = (a) => { seq.push("own" + (a.includes("--dry") ? " dry" : "")); return { status: 0, out: "" }; };
    ok("--wave w2a: the service does not stop -> own.cjs is NOT run", /did not stop[^]*own\.cjs NOT run/.test(err(() => wave("w2a")) || "") && seq.join(",") === "own dry,stop", seq.join(","));
    SSH = vps(); seq.length = 0; RUN_OWN = (a) => { seq.push("own " + a.slice(1).filter((x) => x !== "--accept-r323-weekend-gaps").join(" ")); return { status: 0, out: "" }; };
    wave("w1c");
    ok("--wave w1c: own.cjs home (a oneshot: its final pull waits on the unit's flock), then the shadow off; traids-fills untouched", seq.join(",") === "own home,shadow", seq.join(","));
    seq.length = 0; wave("w2a", { dry: true });
    ok("--wave --dry: only own.cjs --dry runs — nothing stopped, no ssh", seq.join(",") === "own home --dry", seq.join(","));
    // --server / --home guards (fail-closed)
    const map = (o) => ({ schema: "host-ownership-v1", units: { r309: "server", "w1-whales": "server", "w1-funding": "server", "w1-social": "server", "w1c-spread": o, "w2a-fills": "home" }, history: [] });
    const H = path.join(tmp, "data"); fs.mkdirSync(H); fs.writeFileSync(path.join(H, "host-ownership.json"), JSON.stringify(map("server")));
    SSH = () => ({ ok: true, status: 0, out: JSON.stringify(map("home")), err: "" });
    ok("--home: home's map gives w1c-spread to the server -> REFUSED", /server-owned in home's map/.test(err(() => home({ homeDir: H, procs: [], now: Date.parse("2026-10-10T18:00:00Z") })) || ""));
    fs.writeFileSync(path.join(H, "host-ownership.json"), JSON.stringify(map("home")));
    SSH = () => ({ ok: true, status: 0, out: JSON.stringify(map("server")), err: "" });
    ok("--home: the VPS map still gives a unit to the server (--server-down state) -> REFUSED", /VPS map still gives w1c-spread/.test(err(() => home({ homeDir: H, procs: [], now: Date.parse("2026-10-10T18:00:00Z") })) || ""));
    SSH = () => ({ ok: false, status: 255, out: "", err: "down" });
    ok("--home: the VPS map unreadable over ssh -> REFUSED (fail-closed), unless --vps-gone", /REFUSED \(an unreadable map/.test(err(() => home({ homeDir: H, procs: [], now: Date.parse("2026-10-10T18:00:00Z") })) || "") && /intraday window/.test(err(() => home({ homeDir: H, procs: [], vpsGone: true, now: Date.parse("2026-10-09T16:25:00Z") })) || ""));
    ok("--server: refused while either map gives a unit to the server; its unit list is only the 4 real units (never R309 / W1)", /REFUSED: w1c-spread server-owned/.test((() => { SSH =() => ({ ok: true, status: 0, out: JSON.stringify(map("server")), err: "" }); return err(() => server({ dry: true })) || ""; })()) && UN.REAL_UNITS.length === 4 && [...UN.REAL_UNITS, ...UN.SHADOW_UNITS].every((u) => /^traids-(spread|fills)(-shadow)?\.(service|timer)$/.test(u)) && !/r309|w1-/.test(unitsCommand(UN.REAL_UNITS)));
    // --home on a temp root: the EXACT restore of every home patch (byte for byte)
    const R = path.join(tmp, "root");
    for (const e of HP.EDITS) { const f = path.join(R, e.rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, HP.baseText(e)); }
    const before = Object.fromEntries(HP.EDITS.map((e) => [e.rel, fs.readFileSync(path.join(R, e.rel))]));
    HP.applyAll(R);
    SSH = () => ({ ok: true, status: 0, out: JSON.stringify(map("home")), err: "" });
    home({ homeDir: H, root: R, procs: [], now: Date.parse("2026-10-10T18:30:00Z") });
    ok("--home: every edited home file restored BYTE-EXACT, the 4 new files removed", HP.EDITS.every((e) => fs.readFileSync(path.join(R, e.rel)).equals(before[e.rel])) && HP.NEW.every((e) => !fs.existsSync(path.join(R, e.rel))));
    ok("--home: refused while a preflight / board-discipline .bat runs", /is running/.test(err(() => home({ homeDir: H, root: R, procs: ['cmd /c "C:\\x\\automation\\board-discipline.bat"'], now: Date.parse("2026-10-10T18:30:00Z") })) || ""));
  } finally { SSH = saveSsh; log = saveLog; RUN_OWN = saveRun; fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`rollback selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2), flags = new Set(a.filter((x) => x.startsWith("--"))), pos = a.filter((x) => !x.startsWith("--"));
  const known = new Set(["--wave", "--shadow", "--server", "--home", "--selftest", "--dry", "--no-pull", "--server-down", "--accept-lost-files", "--vps-gone"]);
  const modes = ["--wave", "--shadow", "--server", "--home", "--selftest"].filter((m) => flags.has(m));
  try {
    const bad = [...flags].filter((f) => !known.has(f));
    if (bad.length || modes.length !== 1 || (modes[0] === "--wave" ? pos.length !== 1 : pos.length) || (modes[0] !== "--wave" && ["--no-pull", "--server-down", "--accept-lost-files"].some((f) => flags.has(f))) || (modes[0] !== "--home" && flags.has("--vps-gone"))) {
      console.error("usage: rollback.cjs --wave <w1c|w2a> [--dry] [--no-pull] [--server-down] [--accept-lost-files] · --shadow [--dry] · --server [--dry] · --home [--dry] [--vps-gone] · --selftest"); process.exitCode = 2;
    } else {
      const dry = flags.has("--dry");
      if (modes[0] === "--selftest") process.exitCode = selftest() ? 0 : 1;
      else if (modes[0] === "--wave") process.exitCode = wave(pos[0], { dry, noPull: flags.has("--no-pull"), serverDown: flags.has("--server-down"), acceptLost: flags.has("--accept-lost-files") });
      else if (modes[0] === "--shadow") process.exitCode = shadow({ dry });
      else if (modes[0] === "--server") process.exitCode = server({ dry });
      else process.exitCode = home({ dry, vpsGone: flags.has("--vps-gone") });
    }
  } catch (e) { console.error("rollback: " + e.message); process.exitCode = 1; }
}
module.exports = { wave, shadow, server, home, ownArgs, scrubR323, unitsCommand };
