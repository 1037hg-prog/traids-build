#!/usr/bin/env node
/**
 * ROLLBACK — undo the W5 board cell, one step at a time or whole. 2026-10-11 (docs/server/wave5-board; the model is
 * docs/server/wave3-sleeves/rollback.cjs). Each part refuses rather than guess; --dry prints the plan. Run BY THE OPERATOR from the
 * repo root on the PC.
 *
 *   node docs/server/wave5-board/rollback.cjs --cutover     ONE command: the nine units back to home.
 *        1  the VPS is quiesced: the two real servers stopped and the nine real timers disabled (nothing there writes any more)
 *        2  the final pull of the board's files (deploy/server/w5-mirror.cjs --pull, while home's map still says server): a conflict
 *           or a refused file STOPS here — home is NOT resumed on an older ledger (fix it, run again; or --no-pull to resume without
 *           the VPS's latest files, said plainly)
 *        3  deploy/server/own.cjs w5 home (the VPS map first, the units' stamps pulled, then home's map)
 *        4  the real timers enabled again (they are gated: home-owned -> skipped; a later cutover needs them), home's ssh tunnel to the
 *           VPS board ended (it holds 127.0.0.1:3001 / :3002, which home's own servers need), backend/data/w5-cutover-HOLD removed
 *           (that hold file is removed on EVERY path of this command that is not --dry: also when home already owns every unit,
 *           with --server-down, and when a step above refuses — a cutover that was killed must not leave home's board held)
 *        Home's next TRAIDS Servers fire starts the two servers; the gated .bat lines and the chain run the board again from their
 *        next fire. Pass-through to own.cjs: --no-pull · --server-down · --accept-lost-files (own.cjs's meanings; --server-down
 *        cannot stop the VPS: split-brain until it is reachable and this runs again without it). Then: register.cjs --rollback.
 *   node docs/server/wave5-board/rollback.cjs --shadow      the 18 shadow units stopped, disabled, removed and /home/traids/w5-shadow
 *        deleted (any time: the shadow sends nothing; the dry period then ends). Undoes the seed. THE DRY PERIOD ENDS AT HOME TOO:
 *        home's shadow state file (backend/data/w5-shadow-state.json) is rewritten to say so (`removed`), and home's daily refresh
 *        (preflight.bat: w5-mirror.cjs --shadow) sends nothing while that marker is there — without it the next morning's first fire
 *        would seed the whole board state again. To begin a dry period again: deploy.cjs --step seed, then --step units-shadow
 *        (units-shadow clears the marker). The home step itself stays in (the gates say "run"); --home takes it out.
 *   node docs/server/wave5-board/rollback.cjs --server      after EVERY W5 unit is home-owned on BOTH maps: the shadow (as above), the
 *        18 real units, /etc/traids/w5-board.env and w5-shadow.env, and only the files this package CREATED in the real tree
 *        (deploy-state copy.created) that are still the copies it sent. Undoes units-shadow, keys and copy. No R309 / W1 / W1c / W2a /
 *        W2b / W3 file, unit or env file is ever named; the VPS's data files are kept.
 *   node docs/server/wave5-board/rollback.cjs --home        an EXACT restore of every home edit (home-patch revertAll: each anchor line
 *        back in place, byte for byte; a sibling package's edit of the same file is kept). REFUSED while either map gives a W5 unit
 *        to the server (fail-closed over ssh; --vps-gone skips the VPS for a VPS really destroyed) and outside the home step's
 *        window (deploy.cjs editWindow, M6). The map entries w5-* stay (own.cjs's map).
 *   node docs/server/wave5-board/rollback.cjs --all         the whole package: --cutover (when a unit is server-owned), --home, --server
 *        — in that order, each under its own guards, stopping at the first refusal.
 *   node docs/server/wave5-board/rollback.cjs --selftest    pure parts and a fake VPS; no ssh
 * Never touches home backend/data/r309-HALT, another package's file or unit, the registry or a governance file.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", ".."), DS = path.join(REPO, "deploy", "server");
const PS = require(path.join(DS, "pull-server.cjs")), OWN = require(path.join(DS, "own.cjs"));
const HP = require("./home-patch.cjs"), UN = require("./units.cjs"), MF = require("./manifests.cjs"), DEP = require("./deploy.cjs"), SEED = require("./deploy-server/w5-seed.cjs");
const { sha, q } = PS;
const RT = MF.ROOT, RD = MF.DATA, SYSD = "/etc/systemd/system", SHADOW_ROOT = MF.SHADOW, W5 = MF.WAVE_UNITS;
let SSH = PS.sshReal("traids"), log = (s) => console.log(s), STATE = path.join(HERE, "deploy-state.json"), NOW = () => Date.now();
let RUN_OWN = (args) => { const r = cp.spawnSync(process.execPath, [path.join(DS, "own.cjs"), ...args], { cwd: REPO, encoding: "utf8", windowsHide: true, timeout: 3600000 }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") }; };
let RUN_MIRROR = (args) => { const f = path.join(DS, "w5-mirror.cjs"); if (!fs.existsSync(f)) return { status: 1, out: "deploy/server/w5-mirror.cjs is not installed" }; const r = cp.spawnSync(process.execPath, [f, ...args], { cwd: REPO, encoding: "utf8", windowsHide: true, timeout: 3600000 }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") }; };
/** end home's tunnel: the ssh process that LISTENS on home's :3001 / :3002 (found by port: its command line is not readable from another session) */
const tunnelPids = (L) => [...new Set(["3001", "3002"].map((p) => L && L[p]).filter((x) => x && x.name === "ssh" && x.pid).map((x) => x.pid))];
let KILL_TUNNEL = () => { let n = 0; for (const pid of tunnelPids(DEP.homeListeners())) { try { process.kill(pid); n++; } catch {} } return n; };
/** is this command line home's W5 tunnel (ssh -N with the two loopback forwards to the VPS board)? */
const isTunnel = (cmd) => /\s-N\b/.test(" " + cmd) && /-L\s+127\.0\.0\.1:3001:127\.0\.0\.1:3001/.test(cmd) && /-L\s+127\.0\.0\.1:3002:127\.0\.0\.1:3002/.test(cmd);
const must = (r, what) => { if (!r.ok) throw new Error(`${what} failed (exit ${r.status}): ${String(r.err || r.out).trim().slice(0, 300)}`); return String(r.out); };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const ownArgs = (o = {}) => ["w5", "home", "--accept-r323-weekend-gaps", ...(o.dry ? ["--dry"] : []), ...(o.noPull ? ["--no-pull"] : []), ...(o.serverDown ? ["--server-down"] : []), ...(o.acceptLost ? ["--accept-lost-files"] : [])];
const R323_TEXT = "R323's snapshot calendar is 7-day";
function scrubR323(line) { if (/^R323: /.test(line)) return null; const i = line.indexOf(R323_TEXT); return i < 0 ? line : line.slice(0, i).trimEnd() + " [own.cjs's R323 weekend-gap text omitted: it concerns W1 only]"; }
const show = (out, tag = "own.cjs") => { for (const l of String(out).split(/\r?\n/).filter(Boolean)) { const s = scrubR323(l); if (s != null) log(`   ${tag}: ${s}`); } };
const REAL_T = () => UN.REAL_UNITS.filter((u) => u.endsWith(".timer")), REAL_S = () => UN.REAL_UNITS.filter((u) => u.endsWith(".service"));
const quiesceScript = () => `sudo -n systemctl disable --now ${REAL_T().join(" ")} >/dev/null 2>&1; sudo -n systemctl stop ${REAL_S().filter((u) => /-(board|yahoo)\.service$/.test(u)).join(" ")} >/dev/null 2>&1; for u in ${REAL_S().join(" ")}; do echo "STATE $u $(systemctl is-active $u)"; done; echo QUIESCED`;
const resumeTimersScript = () => `sudo -n systemctl enable --now ${REAL_T().join(" ")} >/dev/null 2>&1 && echo TIMERS_ON`;
/**
 * THE VPS MAP READ (2026-10-11 review, round 3). It was `cat <map> 2>/dev/null || echo ABSENT`: a cat that FAILED (the file there but
 * not readable, an I/O error) answered ABSENT, which reads as "no unit is server-owned" and let --home and --server go on. The file is
 * tested for first: only a map that is really not there answers ABSENT; when it is there, cat's own exit code is the command's — a
 * failed read is a failed ssh call and REFUSES, like any unreadable map. (-e or -L: a dangling link is "there", and its cat fails.)
 */
const vpsMapScript = () => { const m = q(RD + "/host-ownership.json"); return `if [ -e ${m} ] || [ -L ${m} ]; then cat ${m}; else echo ABSENT; fi`; };
function vpsMapUnits() {
  const r = SSH(vpsMapScript());
  if (!r.ok) throw new Error(`reading the VPS map failed (exit ${r.status}) — REFUSED (an unreadable map is never read as 'home')`);
  const t = String(r.out).trim(); if (t === "ABSENT") return null;
  try { return JSON.parse(t); } catch { throw new Error("the VPS map does not parse — REFUSED"); }
}
const serverOwned = (map) => W5.filter((u) => map && map.units && map.units[u] === "server");

/**
 * THE HOLD FILE (2026-10-11 review): backend/data/w5-cutover-HOLD is removed on EVERY path of --cutover that is not --dry — the clean
 * one, the one that finds home already owning every unit, --server-down, and each refusal. A rollback means no cutover is in
 * progress, so a hold that is still there is a leftover of a cutover that was killed; home's ensure-servers ignores such a hold by
 * itself (its writer is gone), and this makes sure nothing keeps the file.
 */
function cutoverBack(o = {}) {
  const homeData = o.homeData || PS.HOME_DATA, hold = path.join(homeData, DEP.HOLD_NAME);
  if (o.dry) { const r = cutoverBack0(o); if (fs.existsSync(hold)) log("   DRY: backend/data/w5-cutover-HOLD is present (a leftover of a cutover): the real run removes it on every path. Nothing changed."); return r; }
  try { return cutoverBack0(o); }
  finally { if (DEP.dropHold(hold)) log("   backend/data/w5-cutover-HOLD (a cutover's hold) was still there — removed: home's ensure-servers is not held by it any more"); }
}
function cutoverBack0(o = {}) {
  log("== --cutover: the nine W5 units back to home");
  const homeData = o.homeData || PS.HOME_DATA, mr = PS.readMap(path.join(homeData, "host-ownership.json"));
  if (!mr.ok) throw new Error(mr.why + " — REFUSED");
  if (!serverOwned(mr.map).length && !o.serverDown) { log("   home's map gives no W5 unit to the server — nothing to roll back here (own.cjs w5 home pushes home's map if the VPS's differs)"); const r = RUN_OWN(ownArgs(o)); show(r.out); return r.status === 0 ? 0 : (() => { throw new Error(`own.cjs w5 home exited ${r.status} (above)`); })(); }
  if (o.dry || o.serverDown) {
    const r = RUN_OWN(ownArgs(o)); show(r.out);
    if (r.status !== 0) throw new Error(`own.cjs w5 home${o.dry ? " --dry" : " --server-down"} exited ${r.status} (above)`);
    if (o.dry) log("   DRY: would first stop the VPS's two servers and disable its nine real timers, pull the board's files (w5-mirror --pull), then run the above for real, enable the timers again, end home's tunnel and remove the hold file. Nothing changed.");
    else { const n = KILL_TUNNEL(); log(`   --server-down: the VPS was not touched — if it is alive it keeps running the board (SPLIT-BRAIN: two ledgers). Home's tunnel ended (${n} process(es)); home's servers start at the next TRAIDS Servers fire. When the VPS is reachable: node docs/server/wave5-board/rollback.cjs --cutover`); }
    return 0;
  }
  const d = RUN_OWN(ownArgs({ ...o, dry: true })); show(d.out);
  if (d.status !== 0) throw new Error("own.cjs w5 home --dry refused (above) — nothing stopped, nothing changed");
  const qz = must(SSH(quiesceScript(), { timeout: 300000 }), "quiesce the VPS units");
  const running = [...qz.matchAll(/^STATE (\S+) (\S+)$/gm)].filter((m) => m[2] === "active" || m[2] === "activating").map((m) => m[1]);
  if (!/QUIESCED/.test(qz) || running.length) { SSH(resumeTimersScript()); throw new Error(`a W5 unit is still running on the VPS (${running.join(", ") || "no answer"}) — its timers are enabled again and nothing else changed; run this again when it has finished (a rollback never cuts a chain in the middle)`); }
  log("   1 the VPS is quiesced: the two servers stopped, the nine real timers disabled, no unit running");
  try {
    if (!o.noPull) {
      const p = RUN_MIRROR(["--pull"]); show(p.out, "w5-mirror");
      if (p.status !== 0) throw new Error(`the final pull of the board's files did not complete cleanly (w5-mirror --pull exit ${p.status}, above). HOME IS NOT RESUMED: resuming now would run home's board on an older ledger. Fix what it names and run this again — or resume without the VPS's latest files: node docs/server/wave5-board/rollback.cjs --cutover --no-pull --accept-lost-files`);
      log("   2 the board's files are home (validated: the ledger only grew, no settled row was rewritten)");
    } else log("   2 the final pull of the board's files SKIPPED (--no-pull): what the VPS board wrote since home's last pull is NOT at home — tickets it opened or closed since then are missing from home's ledger (accepted)");
    const r = RUN_OWN(ownArgs(o)); show(r.out);
    if (r.status !== 0) throw new Error(`own.cjs w5 home exited ${r.status} (above — it says which host owns the units now)`);
    log("   3 own.cjs: the nine units are home-owned on both maps");
  } catch (e) { const t = SSH(resumeTimersScript()); throw new Error(`${e.message}${/TIMERS_ON/.test(String(t.out)) ? " The VPS's real timers are enabled again (the map decides who runs)." : " The VPS's real timers could NOT be enabled again: ssh traids sudo systemctl enable --now " + REAL_T().join(" ")}`); }
  const t = SSH(resumeTimersScript()), n = KILL_TUNNEL(), hold = path.join(homeData, "w5-cutover-HOLD"); let held = false; try { fs.unlinkSync(hold); held = true; } catch { held = false; }
  log(`   4 the VPS's real timers ${/TIMERS_ON/.test(String(t.out)) ? "are enabled again (gated: home-owned -> skipped)" : "could NOT be enabled again (a later cutover needs them: ssh traids sudo systemctl enable --now " + REAL_T().join(" ") + ")"}; home's tunnel ended (${n} process(es))${held ? "; the hold file removed" : ""}`);
  log("   done: home's next TRAIDS Servers fire starts :3001 and :3002 (or run automation\\ensure-servers.bat now). Record it: node docs/server/wave5-board/register.cjs --rollback");
  return 0;
}
/** the ONE rm -rf of this package, as the VPS runs it: only /home/traids/w5-shadow is ever deleted (a literal case pattern on the VPS) */
const rmShadowScript = (root = SHADOW_ROOT) => `p=${q(root)}; case "$p" in /home/traids/w5-shadow) rm -rf -- "$p"; echo "REMOVED $p";; *) echo "REFUSED $p" >&2; exit 3;; esac`;
const dropUnitsScript = (units) => `sudo -n systemctl disable --now ${units.filter((u) => u.endsWith(".timer")).join(" ")} >/dev/null 2>&1 || true; sudo -n systemctl stop ${units.filter((u) => u.endsWith(".service")).join(" ")} >/dev/null 2>&1 || true; for u in ${units.join(" ")}; do sudo -n rm -f ${SYSD}/$u; done; sudo -n systemctl daemon-reload; n=0; for u in ${units.join(" ")}; do [ -e ${SYSD}/$u ] && n=$((n+1)); done; echo "LEFT $n"`;
/**
 * THE DRY PERIOD ENDS AT HOME TOO (2026-10-11 review, round 2). Home's preflight.bat runs w5-mirror.cjs --shadow on every fire while the
 * map names the nine units as home; with the shadow tree and home's record of it simply gone, the next morning's first fire seeded the
 * whole board state again. So --shadow REWRITES home's shadow state file instead of deleting it: no file rows (nothing is on the VPS any
 * more) and `removed` — the marker shadowRefresh honours (it sends nothing, makes no ssh, even with --now) until
 * deploy.cjs --step units-shadow has run again and cleared it. The marker is written only once the units and the tree are gone.
 */
const SHADOW_STATE = "w5-shadow-state.json", REMOVED_BY = "docs/server/wave5-board/rollback.cjs --shadow";
function shadow(o = {}) {
  log(`== --shadow: the ${UN.SHADOW_UNITS.length} shadow units and ${SHADOW_ROOT}`);
  if (o.dry) { log(`   DRY: would stop + disable + remove ${UN.SHADOW_UNITS.length} units (traids-w5s-*), then delete ${SHADOW_ROOT} on the VPS (the seed and every shadow record), then mark the dry period ended in home's shadow state file (home's daily refresh sends nothing until deploy.cjs --step units-shadow has run again). Nothing changed.`); return 0; }
  const r = must(SSH(dropUnitsScript(UN.SHADOW_UNITS), { timeout: 300000 }), "remove the shadow units"); if (!/LEFT 0/.test(r)) throw new Error("shadow unit files remain on the VPS: " + r.trim());
  const d = must(SSH(rmShadowScript()), "delete the shadow tree"); if (!new RegExp(`REMOVED ${SHADOW_ROOT}$`, "m").test(d)) throw new Error("the shadow tree was not removed: " + d.trim());
  require(path.join(REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic(path.join(o.homeData || PS.HOME_DATA, SHADOW_STATE), { schema: "w5-shadow-state-v1", files: {}, removed: { at: new Date(NOW()).toISOString(), by: REMOVED_BY } });
  log(`   removed: ${UN.SHADOW_UNITS.length} units, ${SHADOW_ROOT}. The dry period is ended at home too: backend/data/${SHADOW_STATE} says so, and home's daily refresh of the shadow (preflight.bat) sends nothing from now on. To begin one again: node docs/server/wave5-board/deploy.cjs --step seed, then --step units-shadow`);
  return 0;
}
function server(o = {}) {
  log("== --server: everything this package put on the VPS (after every W5 unit is home-owned on both maps)");
  const mr = PS.readMap(path.join(o.homeData || PS.HOME_DATA, "host-ownership.json")); if (!mr.ok) throw new Error(mr.why + " — REFUSED");
  const hs = serverOwned(mr.map), vm = vpsMapUnits(), vs = serverOwned(vm);
  if (hs.length || vs.length) throw new Error(`REFUSED (nothing removed): ${hs.length ? "home's map gives " + hs.join(", ") + " to the server" : "the VPS's map gives " + vs.join(", ") + " to the server"} — roll the cutover back first: node docs/server/wave5-board/rollback.cjs --cutover`);
  const st = readJson(o.stateFile || STATE) || { steps: {} }, copy = (st.steps && st.steps.copy) || {}, created = (copy.created || []).filter((r) => typeof r === "string"), sent = copy.real || {};
  if (o.dry) { log(`   DRY: would remove the shadow (as --shadow), the ${UN.REAL_UNITS.length} real units, ${MF.ENV.real}, ${MF.ENV.shadow}, and ${created.length} file(s) this package created in ${RT} that are still its copies. The VPS's data stays. Nothing changed.`); return 0; }
  shadow({ homeData: o.homeData });
  // nothing of this package is left on the VPS: home's shadow state file goes whole (with no seed recorded and no tree there, home's
  // daily refresh refuses by itself — w5-mirror.cjs shadowRefresh — until the package is deployed again from --step seed)
  try { fs.unlinkSync(path.join(o.homeData || PS.HOME_DATA, SHADOW_STATE)); } catch { /* none */ }
  const r = must(SSH(dropUnitsScript(UN.REAL_UNITS), { timeout: 300000 }), "remove the real units"); if (!/LEFT 0/.test(r)) throw new Error("real unit files remain on the VPS: " + r.trim());
  must(SSH(`sudo -n rm -f ${MF.ENV.real} ${MF.ENV.shadow}; echo KEYS_GONE`), "remove the key files");
  const cur = created.length ? SEED.shasOf(PS.remoteShas, SSH, RT, created) : new Map(), mine = created.filter((rel) => cur.get(rel) && cur.get(rel) === sent[rel]), kept = created.filter((rel) => cur.get(rel) && cur.get(rel) !== sent[rel]);
  if (mine.length) { const d = SSH(`cd ${q(RT)} || exit 7; n=0; while IFS= read -r f; do rm -f -- "$f" && n=$((n+1)); done; echo "DELETED $n"`, { input: mine.join("\n") + "\n", timeout: 300000 }); if (!d.ok || !new RegExp(`DELETED ${mine.length}\\b`).test(String(d.out))) throw new Error("removing this package's files did not complete: " + String(d.out || d.err).trim().slice(0, 200)); }
  log(`   removed: ${UN.REAL_UNITS.length} real units, the two key files, ${mine.length} file(s) this package created${kept.length ? `; KEPT ${kept.length} that changed since (${kept.slice(0, 5).join(", ")})` : ""}. Files other waves share and the VPS's data are untouched.`);
  return 0;
}
function home(o = {}) {
  log("== --home: every home edit restored byte for byte (home-patch revertAll)");
  const root = o.root || REPO, homeData = o.homeData || PS.HOME_DATA, mr = PS.readMap(path.join(homeData, "host-ownership.json"));
  if (!mr.ok) throw new Error(mr.why + " — REFUSED");
  if (serverOwned(mr.map).length) throw new Error(`REFUSED (nothing reverted): home's map gives ${serverOwned(mr.map).join(", ")} to the server — the gates and tags are what keep home from running the board beside the VPS. Roll the cutover back first: node docs/server/wave5-board/rollback.cjs --cutover`);
  if (!o.vpsGone) { const vs = serverOwned(vpsMapUnits()); if (vs.length) throw new Error(`REFUSED (nothing reverted): the VPS's map gives ${vs.join(", ")} to the server — roll the cutover back first (or --vps-gone for a VPS that is really destroyed)`); }
  else log("   --vps-gone: the VPS's map was not read");
  const pr = o.procs !== undefined ? o.procs : OWN.procScan(), w = DEP.editWindow(o.now != null ? o.now : NOW(), { procs: pr, chainStatus: readJson(path.join(homeData, "chain-status.json")) });
  if (w) throw new Error(`REFUSED (nothing reverted): ${w}`);
  if (!OWN.normProcs(pr).ok) throw new Error("REFUSED (nothing reverted): the process scan failed — this edits files that may be running (M6); try again");
  for (const l of HP.revertAll(root, { dry: !!o.dry })) log("   " + l);
  if (!o.dry) { const left = HP.ALL().filter((e) => HP.stateOf(e, root).state !== "base").map((e) => e.rel); if (left.length) log(`   NOTE: not back to base (kept on purpose, see above): ${left.join(", ")}`); else log("   every entry reads base: home is as it was before this package's home step"); }
  return 0;
}
function all(o = {}) {
  const mr = PS.readMap(path.join(o.homeData || PS.HOME_DATA, "host-ownership.json"));
  if (mr.ok && serverOwned(mr.map).length) cutoverBack(o); else log("== --all: no W5 unit is server-owned at home — the cutover step is skipped");
  home(o); server(o);
  log("the whole package is rolled back: home reads base, the VPS holds none of this package's units, keys or files (its data is kept)");
  return 0;
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + String(d).slice(0, 600) : "")); } };
  const thrown = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const saved = { SSH, log, STATE, NOW, RUN_OWN, RUN_MIRROR, KILL_TUNNEL }, tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w5-rollback-"));
  try {
    const lines = []; log = (l) => lines.push(l); KILL_TUNNEL = () => 1;
    const hd = path.join(tmp, "data"); fs.mkdirSync(hd, { recursive: true });
    const mapOf = (owner) => ({ schema: "host-ownership-v1", units: { r309: "server", ...Object.fromEntries(W5.map((u) => [u, owner])) }, history: [] }), putMap = (owner) => fs.writeFileSync(path.join(hd, "host-ownership.json"), JSON.stringify(mapOf(owner)));
    ok("the tunnel is found by PORT: an ssh process listening on home's :3001 / :3002 (one pid when it holds both); a node listening there (home's own board) is never taken for it; nothing listening -> none", JSON.stringify(tunnelPids({ 3001: { name: "ssh", pid: 77 }, 3002: { name: "ssh", pid: 77 } })) === "[77]" && tunnelPids({ 3001: { name: "node", pid: 5 }, 3002: { name: "node", pid: 6 } }).length === 0 && tunnelPids({ 3001: { name: "none", pid: null } }).length === 0 && tunnelPids(null).length === 0);
    ok("the tunnel is recognised by its two loopback forwards and -N only: home's W5 tunnel yes; an interactive ssh, a tunnel to another port, the pull's ssh — no", isTunnel("ssh -N -o BatchMode=yes -L 127.0.0.1:3001:127.0.0.1:3001 -L 127.0.0.1:3002:127.0.0.1:3002 traids") && !isTunnel("ssh traids") && !isTunnel("ssh -N -L 127.0.0.1:8080:127.0.0.1:8080 traids") && !isTunnel("ssh -o BatchMode=yes traids cat x"));
    ok("the scripts name ONLY this package's units and files: 9 real timers / services (traids-w5-*), 18 shadow units (traids-w5s-*); no other wave's unit, no data file; each under 5,000 characters", !/traids-(w1|w3|spread|fills|r309|gex|flow)/.test(quiesceScript() + dropUnitsScript(UN.ALL_UNITS) + resumeTimersScript()) && (quiesceScript().match(/traids-w5-[a-z]+\.timer/g) || []).length === 9 && Math.max(quiesceScript().length, dropUnitsScript(UN.ALL_UNITS).length, resumeTimersScript().length) < 5000 && UN.SHADOW_UNITS.length === 18 && UN.SHADOW_UNITS.every((u) => /^traids-w5s-/.test(u)));
    ok("the ONE rm -rf deletes /home/traids/w5-shadow and nothing else: the real tree, a parent, '/' and a look-alike are each REFUSED by the script's own literal case (run under sh where available)", /\/home\/traids\/w5-shadow\) rm -rf -- "\$p"/.test(rmShadowScript()) && (() => { const sh = ["sh", "bash"].find((s) => { try { return cp.spawnSync(s, ["-c", "exit 0"]).status === 0; } catch { return false; } }); if (!sh) return true; return ["/home/traids/traids", "/home/traids", "/", "/home/traids/w5-shadow/../traids", "/home/traids/w5-shadow2"].every((p) => { const r = cp.spawnSync(sh, ["-c", rmShadowScript(p).replace("rm -rf --", "echo WOULD-RM")], { encoding: "utf8" }); return r.status === 3 && !/WOULD-RM/.test(r.stdout); }) && /WOULD-RM \/home\/traids\/w5-shadow/.test(cp.spawnSync(sh, ["-c", rmShadowScript().replace("rm -rf --", "echo WOULD-RM")], { encoding: "utf8" }).stdout); })());
    // --cutover: the order, and each way it stops
    const mk = (o = {}) => { const calls = []; SSH = (script) => { calls.push("ssh " + (/QUIESCED/.test(script) ? "quiesce" : /TIMERS_ON/.test(script) ? "timers-on" : script.slice(0, 30))); if (/QUIESCED/.test(script)) return { ok: true, status: 0, out: REAL_S().map((u) => `STATE ${u} ${o.running === u ? o.runningAs || "active" : "inactive"}`).join("\n") + "\nQUIESCED\n", err: "" }; if (/TIMERS_ON/.test(script)) return { ok: true, status: 0, out: "TIMERS_ON\n", err: "" }; return { ok: false, status: 127, out: "", err: "unexpected" }; };
      RUN_OWN = (args) => { calls.push("own " + args.join(" ")); return { status: args.includes("--dry") ? (o.dryRefuses ? 1 : 0) : o.ownFails ? 1 : 0, out: args.includes("--dry") ? "w5 home (DRY): would push the map" : "w5: home resumed" }; };
      RUN_MIRROR = (args) => { calls.push("mirror " + args.join(" ")); return { status: o.pullFails ? 1 : 0, out: o.pullFails ? "pulled 0 · CONFLICTS 1: trade_log.json: home changed a VPS-owned file" : "pulled 12 · pushed 0" }; };
      let killed = 0; KILL_TUNNEL = () => { calls.push("kill-tunnel"); killed++; return 1; }; return { calls, killed: () => killed }; };
    putMap("server"); fs.writeFileSync(path.join(hd, "w5-cutover-HOLD"), "x");
    { const m = mk(); const x = cutoverBack({ homeData: hd });
      ok("--cutover, the ORDER: own.cjs --dry (its guards) -> the VPS quiesced -> the board's files pulled -> own.cjs w5 home -> the real timers on again -> home's tunnel ended; the hold file is removed", x === 0 && m.calls.join(" | ") === "own w5 home --accept-r323-weekend-gaps --dry | ssh quiesce | mirror --pull | own w5 home --accept-r323-weekend-gaps | ssh timers-on | kill-tunnel" && !fs.existsSync(path.join(hd, "w5-cutover-HOLD")), m.calls.join(" | ")); }
    { const m = mk({ dryRefuses: true }); const e = thrown(() => cutoverBack({ homeData: hd }));
      ok("--cutover while own.cjs's guards refuse (the chain window): NOTHING is stopped on the VPS, nothing pulled", /nothing stopped, nothing changed/.test(e || "") && m.calls.length === 1); }
    { const m = mk({ running: "traids-w5-chain.service" }); const e = thrown(() => cutoverBack({ homeData: hd }));
      ok("--cutover while the VPS chain is still running: REFUSED (a rollback never cuts a chain in the middle), the timers are enabled again, home is not touched", /still running on the VPS \(traids-w5-chain\.service\)/.test(e || "") && m.calls.join(" | ") === "own w5 home --accept-r323-weekend-gaps --dry | ssh quiesce | ssh timers-on"); }
    { const m = mk({ running: "traids-w5-chain.service", runningAs: "activating" }); const e = thrown(() => cutoverBack({ homeData: hd })), mapAfter = PS.readMap(path.join(hd, "host-ownership.json"));
      const m2 = mk({ running: "traids-w5-chain.service", runningAs: "failed" }); const x2 = thrown(() => cutoverBack({ homeData: hd })) || 0;
      ok("--cutover while the VPS chain runs AS SYSTEMD REPORTS A RUNNING ONESHOT — 'activating', not 'active' (2026-10-11 review, round 2): REFUSED the same way, naming the unit; the timers are enabled again; nothing is pulled, own.cjs w5 home is not run, home's tunnel is not ended, home's map still gives the units to the server. A unit that only reads 'failed' is not running: the rollback goes on", /still running on the VPS \(traids-w5-chain\.service\)/.test(e || "") && /timers are enabled again and nothing else changed/.test(e || "") && m.calls.join(" | ") === "own w5 home --accept-r323-weekend-gaps --dry | ssh quiesce | ssh timers-on" && m.killed() === 0 && mapAfter.ok && W5.every((u) => mapAfter.map.units[u] === "server") && x2 === 0 && m2.calls.includes("mirror --pull") && m2.calls.includes("own w5 home --accept-r323-weekend-gaps"), `${e} | ${m.calls.join(" | ")} | ${m2.calls.join(" | ")}`); }
    { const m = mk({ pullFails: true }); const e = thrown(() => cutoverBack({ homeData: hd }));
      ok("--cutover when the final pull reports a conflict: HOME IS NOT RESUMED (no own.cjs run: home would run on an older ledger), the VPS timers are enabled again, and the message names --no-pull --accept-lost-files", /HOME IS NOT RESUMED/.test(e || "") && /--no-pull --accept-lost-files/.test(e || "") && !m.calls.includes("own w5 home --accept-r323-weekend-gaps") && m.calls[m.calls.length - 1] === "ssh timers-on" && m.killed() === 0, m.calls.join(" | ")); }
    { const hf = path.join(hd, "w5-cutover-HOLD"); fs.writeFileSync(hf, "x"); const n0 = lines.length, m = mk({ ownFails: true }), e = thrown(() => cutoverBack({ homeData: hd })), mapAfter = PS.readMap(path.join(hd, "host-ownership.json")), said = lines.slice(n0);
      ok("--cutover when own.cjs w5 home ITSELF FAILS (not --dry: exit 1, after the VPS was quiesced and the board's files pulled): the rollback THROWS naming that exit — it never reports done while the VPS may still own the units; the VPS's real timers are enabled again (the last call made), home's tunnel is NOT ended, home's map still gives the nine units to the server, and neither 'the nine units are home-owned' nor 'done' is printed. The cutover's hold file goes as on every path of this command (the map, not the hold, keeps home's board off)",
        /own\.cjs w5 home exited 1/.test(e || "") && /The VPS's real timers are enabled again/.test(e || "") && m.calls.join(" | ") === "own w5 home --accept-r323-weekend-gaps --dry | ssh quiesce | mirror --pull | own w5 home --accept-r323-weekend-gaps | ssh timers-on" && m.killed() === 0 && mapAfter.ok && W5.every((u) => mapAfter.map.units[u] === "server") && !said.some((l) => /the nine units are home-owned|^\s+done:|^\s+4 the VPS's real timers/.test(l)) && !fs.existsSync(hf), `${e} | ${m.calls.join(" | ")} | ${said.join(" | ")}`); }
    { const m = mk(); cutoverBack({ homeData: hd, noPull: true, acceptLost: true });
      ok("--cutover --no-pull --accept-lost-files: no mirror pull, own.cjs gets both flags, and the output says plainly what is lost", !m.calls.some((c) => /^mirror/.test(c)) && m.calls.includes("own w5 home --accept-r323-weekend-gaps --no-pull --accept-lost-files") && lines.some((l) => /is NOT at home/.test(l))); }
    { const m = mk(); cutoverBack({ homeData: hd, dry: true });
      ok("--cutover --dry: only own.cjs --dry runs; nothing is stopped, pulled or killed", m.calls.join(" | ") === "own w5 home --accept-r323-weekend-gaps --dry" && lines.some((l) => /DRY: would first stop/.test(l))); }
    // THE HOLD FILE is removed on every path that is not --dry (2026-10-11 review: a killed cutover left home's board down)
    { const hf = path.join(hd, "w5-cutover-HOLD"), stale = () => fs.writeFileSync(hf, JSON.stringify({ pid: 999999, at: "2026-10-17T13:00:00.000Z" }) + "\n");
      stale(); const m1 = mk({ dryRefuses: true }), e1 = thrown(() => cutoverBack({ homeData: hd })), gone1 = !fs.existsSync(hf);
      stale(); const m2 = mk({ pullFails: true }), e2 = thrown(() => cutoverBack({ homeData: hd })), gone2 = !fs.existsSync(hf);
      stale(); mk(); cutoverBack({ homeData: hd, dry: true }); const keptDry = fs.existsSync(hf), saidDry = lines.some((l) => /DRY: backend\/data\/w5-cutover-HOLD is present/.test(l));
      const m4 = mk(); const x4 = cutoverBack({ homeData: hd, serverDown: true }), gone4 = !fs.existsSync(hf);
      putMap("home"); stale(); const m5 = mk(), x5 = cutoverBack({ homeData: hd }), gone5 = !fs.existsSync(hf); putMap("server");
      ok("THE HOLD FILE on every path: --cutover with a HOME-OWNED map and a stale hold returns 0 and the hold is GONE (it used to stay); it is also removed when own.cjs's guards refuse, when the final pull stops on a conflict, and with --server-down; --dry leaves it and says the real run removes it",
        x5 === 0 && gone5 && m5.calls.join(" | ") === "own w5 home --accept-r323-weekend-gaps" && /nothing stopped, nothing changed/.test(e1 || "") && gone1 && m1.calls.length === 1 && /HOME IS NOT RESUMED/.test(e2 || "") && gone2 && keptDry && saidDry && x4 === 0 && gone4 && lines.some((l) => /w5-cutover-HOLD \(a cutover's hold\) was still there — removed/.test(l)) && !!m2 && !!m4, JSON.stringify({ x5, gone5, c5: m5.calls, gone1, gone2, keptDry, saidDry, x4, gone4 })); }
    // --server / --home refusals while server-owned
    { mk(); SSH = () => ({ ok: true, status: 0, out: JSON.stringify(mapOf("server")), err: "" });
      ok("--server and --home while a W5 unit is server-owned: both REFUSED naming --cutover (the gates and tags are what keep home off the board)", /roll the cutover back first/.test(thrown(() => server({ homeData: hd })) || "") && /Roll the cutover back first/.test(thrown(() => home({ homeData: hd, procs: [] })) || ""));
      { const seen = [], vps = (owner) => (script) => { seen.push(script); return script === vpsMapScript() ? { ok: true, status: 0, out: JSON.stringify(mapOf(owner)), err: "" } : { ok: false, status: 127, out: "", err: "unexpected " + script.slice(0, 60) }; };
        putMap("home"); SSH = vps("server"); const eV = thrown(() => server({ homeData: hd })) || "", nV = seen.length;
        putMap("server"); SSH = vps("home"); const eH = thrown(() => server({ homeData: hd })) || "", nH = seen.length - nV;
        ok("--server with only ONE map still giving a W5 unit to the server (either one is enough): home's map home-owned and the VPS's server-owned -> 'REFUSED (nothing removed)' naming the VPS's map; home's map server-owned and the VPS's home-owned -> 'REFUSED (nothing removed)' naming home's map. In both the ONLY ssh made is the read of the VPS's map: no unit, key file, tree or file is removed",
          /^REFUSED \(nothing removed\): the VPS's map gives w5-board, /.test(eV) && /roll the cutover back first/.test(eV) && /^REFUSED \(nothing removed\): home's map gives w5-board, /.test(eH) && /roll the cutover back first/.test(eH) && nV === 1 && nH === 1 && seen.every((c) => /host-ownership\.json/.test(c) && !/systemctl|rm -/.test(c)), `${eV} | ${eH} | ${nV}/${nH}`);
        SSH = () => ({ ok: true, status: 0, out: JSON.stringify(mapOf("server")), err: "" }); }
      putMap("home");
      ok("--home with home's map home-owned but the VPS's map still server-owned: REFUSED (fail-closed over ssh); an unreadable VPS map REFUSES too; --vps-gone skips the read", /the VPS's map gives/.test(thrown(() => home({ homeData: hd, procs: [], now: Date.parse("2026-10-17T16:30:00Z") })) || "") && (() => { SSH = () => ({ ok: false, status: 255, out: "", err: "" }); return /unreadable map is never read as 'home'/.test(thrown(() => home({ homeData: hd, procs: [] })) || ""); })()); }
    // 2026-10-11 review, round 3: a FAILED read of the VPS map is not "no map"
    { putMap("home"); const sh = ["sh", "bash"].find((s) => { try { return cp.spawnSync(s, ["-c", "exit 0"]).status === 0; } catch { return false; } });
      const scr = vpsMapScript(), sat = Date.parse("2026-10-17T16:30:00Z"), seen = [];
      // the remote command run for real under sh (where there is one), on a temp "VPS data dir": a map, no map, a map that cannot be read (a directory in its place: cat exits non-zero)
      const runOn = (dir) => { const r = cp.spawnSync(sh, ["-c", scr.split(q(RD + "/host-ownership.json")).join(q(dir.replace(/\\/g, "/") + "/host-ownership.json"))], { encoding: "utf8" }); return { ok: r.status === 0, status: r.status, out: String(r.stdout || ""), err: String(r.stderr || "") }; };
      const dOk = path.join(tmp, "vps-ok"), dNo = path.join(tmp, "vps-none"), dBad = path.join(tmp, "vps-bad"); for (const d of [dOk, dNo, dBad]) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(dOk, "host-ownership.json"), JSON.stringify(mapOf("server"))); fs.mkdirSync(path.join(dBad, "host-ownership.json"));
      const real = sh ? { ok: runOn(dOk), none: runOn(dNo), bad: runOn(dBad) } : null;
      const viaSsh = (ans) => { SSH = (script) => { seen.push(script); return script === scr ? ans : { ok: false, status: 127, out: "", err: "unexpected" }; }; };
      viaSsh({ ok: false, status: 1, out: "", err: "cat: host-ownership.json: Permission denied" }); const eHome = thrown(() => home({ homeData: hd, procs: [], now: sat })) || "", eSrv = thrown(() => server({ homeData: hd })) || "", nFail = seen.length;
      viaSsh({ ok: true, status: 0, out: "ABSENT\n", err: "" }); const absent = vpsMapUnits();
      viaSsh({ ok: true, status: 0, out: "", err: "" }); const eEmpty = thrown(() => vpsMapUnits()) || "";
      ok("THE VPS MAP READ tells 'no map' from 'the read failed' (KNOWN ANSWER): the command tests for the file first — `if [ -e <map> ] || [ -L <map> ]; then cat <map>; else echo ABSENT; fi` — with no `2>/dev/null ||` that would turn a failed cat into ABSENT. Run for real under sh: a map answers its JSON (exit 0); no map answers ABSENT (exit 0); a map that is there and cannot be read EXITS NON-ZERO and never says ABSENT",
        /^if \[ -e '[^']+\/host-ownership\.json' \] \|\| \[ -L '[^']+\/host-ownership\.json' \]; then cat '[^']+\/host-ownership\.json'; else echo ABSENT; fi$/.test(scr) && !/\|\| echo ABSENT|2>\/dev\/null/.test(scr) && scr.length < 300 &&
        (!real || (real.ok.ok && JSON.parse(real.ok.out).units["w5-board"] === "server" && real.none.ok && real.none.out.trim() === "ABSENT" && !real.bad.ok && !/ABSENT/.test(real.bad.out))), JSON.stringify(real).slice(0, 400));
      ok("a FAILED read of the VPS map REFUSES (KNOWN ANSWER): with home's map home-owned and the VPS's cat failing (exit 1, 'Permission denied'), --home is 'reading the VPS map failed (exit 1) — REFUSED' and reverts nothing, --server the same and removes nothing — the only ssh either made is the map read. It used to answer ABSENT, which reads as 'no unit is server-owned', and both went on. A map that is really not there still reads as none (null); an EMPTY answer does not parse and REFUSES",
        /^reading the VPS map failed \(exit 1\) — REFUSED \(an unreadable map is never read as 'home'\)$/.test(eHome) && /^reading the VPS map failed \(exit 1\) — REFUSED/.test(eSrv) && nFail === 2 && seen.slice(0, 2).every((c) => c === scr) && absent === null && /the VPS map does not parse — REFUSED/.test(eEmpty), `${eHome} | ${eSrv} | ${nFail} | ${absent} | ${eEmpty}`);
      SSH = () => ({ ok: true, status: 0, out: JSON.stringify(mapOf("server")), err: "" }); }
    // --home: byte-exact on a temp mirror of the real home files, whichever side home is on
    { const R = path.join(tmp, "root"); for (const e of HP.EDITS) { const f = path.join(R, e.rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, HP.baseText(e)); }
      const snap = () => HP.EDITS.map((e) => sha(fs.readFileSync(path.join(R, e.rel)))).join(), s0 = snap(); HP.applyAll(R); const s1 = snap();
      SSH = () => ({ ok: true, status: 0, out: JSON.stringify(mapOf("home")), err: "" });
      const sat = Date.parse("2026-10-17T16:30:00Z"), wed = Date.parse("2026-10-14T16:30:00Z");   // Sat 10:30 MT · Wed 10:30 MT
      const eW = thrown(() => home({ root: R, homeData: hd, procs: [], now: wed })), sW = snap();
      const eD = home({ root: R, homeData: hd, procs: [], now: sat, dry: true }), sD = snap();
      { const eS = thrown(() => home({ root: R, homeData: hd, procs: { ok: false, lines: [] }, now: sat })) || "", sS = snap(), eN = thrown(() => home({ root: R, homeData: hd, procs: null, now: sat })) || "", sN = snap();
        ok("--home when the PROCESS SCAN FAILED (inside the edit window — Saturday 10:30 MT — with both maps home-owned): 'REFUSED (nothing reverted)' naming the scan (this edits files that may be running, M6); a scan that returned nothing at all refuses the same way; every edited file, new file and .pre-w5.bak record is as it was", /^REFUSED \(nothing reverted\): the process scan failed/.test(eS) && sS === s1 && /^REFUSED \(nothing reverted\): the process scan failed/.test(eN) && sN === s1 && HP.NEW.every((e) => fs.existsSync(path.join(R, e.rel))) && HP.EDITS.every((e) => fs.existsSync(path.join(R, HP.BAK(e.rel)))), `${eS} | ${eN}`); }
      home({ root: R, homeData: hd, procs: [], now: sat });
      ok("--home on a temp mirror of the real home files with the patch applied: refused inside the board's hours (nothing reverted); --dry changes nothing; the real run restores EVERY edited file byte for byte, removes the new files and the .pre-w5.bak records", /board's hours/.test(eW || "") && sW === s1 && eD === 0 && sD === s1 && s1 !== s0 && snap() === s0 && HP.NEW.every((e) => !fs.existsSync(path.join(R, e.rel))) && HP.EDITS.every((e) => !fs.existsSync(path.join(R, HP.BAK(e.rel)))) && lines.some((l) => /every entry reads base/.test(l))); }
    // --shadow ends the dry period AT HOME too (2026-10-11 review, round 2): the marker it leaves, and home's daily refresh honouring it
    { putMap("home"); const sf = path.join(hd, "w5-shadow-state.json"), calls = [], seeded = JSON.stringify({ schema: "w5-shadow-state-v1", trainingAllow: ["futures-1m"], files: { "trade_log.json": { h: [2, 1], s: [2, 1] } }, refreshedEtDay: "2026-10-16", seededAt: "2026-10-12T22:00:00.000Z" });
      const vps = (rmOk) => (script) => { calls.push(script); if (/LEFT \$n/.test(script)) return { ok: true, status: 0, out: "LEFT 0\n", err: "" }; if (/REMOVED/.test(script)) return rmOk ? { ok: true, status: 0, out: `REMOVED ${SHADOW_ROOT}\n`, err: "" } : { ok: false, status: 1, out: "", err: "rm: cannot remove: Device or resource busy" }; return { ok: false, status: 127, out: "", err: "unexpected" }; };
      fs.writeFileSync(sf, seeded); NOW = () => Date.parse("2026-10-17T16:30:00Z");
      SSH = vps(true); const xDry = shadow({ homeData: hd, dry: true }), dryKept = fs.readFileSync(sf, "utf8") === seeded && calls.length === 0;
      SSH = vps(false); const eRm = thrown(() => shadow({ homeData: hd })), rmKept = fs.readFileSync(sf, "utf8") === seeded;
      SSH = vps(true); const x = shadow({ homeData: hd }), st = readJson(sf) || {};
      const MIR = require("./deploy-server/w5-mirror.cjs"); let sshN = 0; const noSsh = () => { sshN++; return { ok: false, status: 255, out: "", err: "no ssh in a selftest" }; };
      const fire = (o = {}) => MIR.shadowRefresh({ deps: { repo: path.join(tmp, "no-repo"), dataDir: hd, ssh: noSsh, now: () => Date.parse("2026-10-19T07:30:00-04:00"), ...o } });   // Monday 07:30 ET: inside the refresh window, a new day
      const next = fire(), forced = fire({ force: true });
      ok("--shadow ENDS THE DRY PERIOD AT HOME TOO: home's shadow state file is REWRITTEN, not deleted — no file rows, no seed record, and `removed` with the time and this command's name; --dry changes nothing; when the VPS's tree could NOT be removed the file is left as it was (the marker is written only once the units and the tree are gone)",
        xDry === 0 && dryKept && /delete the shadow tree failed/.test(eRm || "") && rmKept && x === 0 && st.schema === "w5-shadow-state-v1" && JSON.stringify(st.files) === "{}" && !!st.removed && st.removed.at === "2026-10-17T16:30:00.000Z" && st.removed.by === "docs/server/wave5-board/rollback.cjs --shadow" && !("seededAt" in st) && !("refreshedEtDay" in st) && lines.some((l) => /The dry period is ended at home too/.test(l) && /--step seed, then --step units-shadow/.test(l)), JSON.stringify({ xDry, dryKept, eRm, rmKept, st }));
      ok("the NEXT MORNING at home (what preflight.bat runs: w5-mirror.cjs shadowRefresh on the state --shadow left, every W5 unit still home-owned, Monday 07:30 ET): NOTHING is sent and NO ssh is made — it says the dry period was ended and names units-shadow; the same with --now. The whole board state is not seeded again in front of the session", next.exit === 0 && /the dry period was ended by rollback\.cjs --shadow \(2026-10-17T16:30:00\.000Z\)/.test(next.lines.join(" | ")) && /--step units-shadow/.test(next.lines.join(" | ")) && forced.exit === 0 && /the dry period was ended/.test(forced.lines.join(" | ")) && sshN === 0 && JSON.stringify(readJson(sf)) === JSON.stringify(st), JSON.stringify({ next, forced, sshN }));
      NOW = saved.NOW; }
    // --server on a fake VPS: only this package's created files, only while still its copies
    { putMap("home"); const stF = path.join(tmp, "state.json"); fs.writeFileSync(stF, JSON.stringify({ steps: { copy: { ok: true, created: ["backend/w5-run.cjs", "backend/gap-watcher.js", "dist/index.html"], real: { "backend/w5-run.cjs": "a".repeat(64), "backend/gap-watcher.js": "b".repeat(64), "dist/index.html": "c".repeat(64), "backend/lib/atomic-write.js": "d".repeat(64) } } } }));
      const calls = [], deleted = []; SSH = (script, o2 = {}) => { calls.push(script); if (script === vpsMapScript()) return { ok: true, status: 0, out: JSON.stringify(mapOf("home")), err: "" }; if (/LEFT \$n/.test(script)) return { ok: true, status: 0, out: "LEFT 0\n", err: "" }; if (/REMOVED/.test(script)) return { ok: true, status: 0, out: `REMOVED ${SHADOW_ROOT}\n`, err: "" }; if (/KEYS_GONE/.test(script)) return { ok: true, status: 0, out: "KEYS_GONE\n", err: "" };
        if (/sha256sum -- "\$f"/.test(script)) return { ok: true, status: 0, out: [`${"a".repeat(64)}  backend/w5-run.cjs`, `${"e".repeat(64)}  backend/gap-watcher.js`, "ABSENT  dist/index.html"].join("\n") + "\n", err: "" };
        if (/DELETED \$n/.test(script)) { deleted.push(...String(o2.input).split("\n").filter(Boolean)); return { ok: true, status: 0, out: `DELETED ${deleted.length}\n`, err: "" }; } return { ok: false, status: 127, out: "", err: "unexpected " + script.slice(0, 60) }; };
      fs.writeFileSync(path.join(hd, "w5-shadow-state.json"), "{}");
      const x = server({ homeData: hd, stateFile: stF });
      ok("--server removes home's shadow state file in ITS data dir (the temp one here; the repo's is never touched by a selftest)", !fs.existsSync(path.join(hd, "w5-shadow-state.json")));
      ok("--server: the shadow, the 18 real units and the two key files go; of the files this package CREATED only the one still its copy is deleted (names on stdin) — a file changed since is KEPT, a shared file it did not create (lib/atomic-write.js) is never named, no data file is named", x === 0 && deleted.join() === "backend/w5-run.cjs" && lines.some((l) => /KEPT 1 that changed since \(backend\/gap-watcher\.js\)/.test(l)) && !calls.some((c) => /atomic-write|trade_log|backend\/data\/[a-z]/.test(c.replace(/host-ownership\.json/g, ""))) && calls.some((c) => c.includes(MF.ENV.real) && c.includes(MF.ENV.shadow)), deleted.join()); }
    // --all (2026-10-11 review: it had no case): the three parts in order, each under its own guards, stopping at the first refusal
    { const R = path.join(tmp, "root"), snap = () => HP.EDITS.map((e) => sha(fs.readFileSync(path.join(R, e.rel)))).join() + "|" + HP.NEW.map((e) => (fs.existsSync(path.join(R, e.rel)) ? 1 : 0)).join(""), s0 = snap();
      const stA = path.join(tmp, "state-all.json"); fs.writeFileSync(stA, JSON.stringify({ steps: { copy: { ok: true, created: [], real: {} } } }));
      const sat = Date.parse("2026-10-17T16:30:00Z"), wed = Date.parse("2026-10-14T16:30:00Z");   // Sat 10:30 MT (inside the edit window) · Wed 10:30 MT (the board's hours)
      const mkAll = (o = {}) => { const calls = []; let vpsOwner = o.vps || "server";
        SSH = (script) => {
          if (/QUIESCED/.test(script)) { calls.push("ssh quiesce"); return { ok: true, status: 0, out: REAL_S().map((u) => `STATE ${u} inactive`).join("\n") + "\nQUIESCED\n", err: "" }; }
          if (/TIMERS_ON/.test(script)) { calls.push("ssh timers-on"); return { ok: true, status: 0, out: "TIMERS_ON\n", err: "" }; }
          if (script === vpsMapScript()) { calls.push(`ssh vps-map [home files ${snap() === s0 ? "at base" : "patched"}]`); return { ok: true, status: 0, out: JSON.stringify(mapOf(vpsOwner)), err: "" }; }
          if (/LEFT \$n/.test(script)) { calls.push(/traids-w5s-/.test(script) ? "ssh drop-shadow-units" : "ssh drop-real-units"); return { ok: true, status: 0, out: "LEFT 0\n", err: "" }; }
          if (/REMOVED/.test(script)) { calls.push("ssh rm-shadow-tree"); return { ok: true, status: 0, out: `REMOVED ${SHADOW_ROOT}\n`, err: "" }; }
          if (/KEYS_GONE/.test(script)) { calls.push("ssh rm-key-files"); return { ok: true, status: 0, out: "KEYS_GONE\n", err: "" }; }
          calls.push("ssh UNEXPECTED " + script.slice(0, 40)); return { ok: false, status: 127, out: "", err: "unexpected" }; };
        RUN_OWN = (args) => { calls.push("own " + args.join(" ")); if (args.includes("--dry")) return { status: o.dryRefuses ? 1 : 0, out: "w5 home (DRY)" }; putMap("home"); vpsOwner = "home"; return { status: 0, out: "w5: home resumed" }; };   // the real own.cjs moves both maps
        RUN_MIRROR = (args) => { calls.push("mirror " + args.join(" ")); return { status: 0, out: "pulled 3 · pushed 0" }; };
        KILL_TUNNEL = () => { calls.push("kill-tunnel"); return 1; };
        return calls; };
      const CUT = "own w5 home --accept-r323-weekend-gaps --dry | ssh quiesce | mirror --pull | own w5 home --accept-r323-weekend-gaps | ssh timers-on | kill-tunnel", HOME = "ssh vps-map [home files patched]", SERVER = "ssh vps-map [home files at base] | ssh drop-shadow-units | ssh rm-shadow-tree | ssh drop-real-units | ssh rm-key-files";
      HP.applyAll(R); const s1 = snap(), O = { root: R, homeData: hd, procs: [], stateFile: stA }, tryAll = (o) => { try { return all(o); } catch (e) { return "THREW " + e.message; } };
      putMap("server"); const c1 = mkAll({ dryRefuses: true }), e1 = thrown(() => all({ ...O, now: sat })) || "", k1 = snap() === s1;
      putMap("server"); const c2 = mkAll(), e2 = thrown(() => all({ ...O, now: wed })) || "", k2 = snap() === s1, m2 = PS.readMap(path.join(hd, "host-ownership.json"));
      putMap("server"); const n3 = lines.length, c3 = mkAll(), x3 = tryAll({ ...O, now: sat }), said3 = lines.slice(n3), k3 = snap() === s0;
      ok("--all while a W5 unit is server-owned: the CUTOVER part first (own.cjs --dry, quiesce, pull, own.cjs w5 home, timers on, tunnel ended), THEN --home (it asks the VPS's map while home's files are still patched, then reverts them), THEN --server (it asks the map again with home's files at base, then the shadow units, the shadow tree, the real units, the key files) — exactly that order, nothing else; it ends 'the whole package is rolled back'",
        x3 === 0 && c3.join(" | ") === [CUT, HOME, SERVER].join(" | ") && k3 && s1 !== s0 && said3.some((l) => /^the whole package is rolled back/.test(l)) && !said3.some((l) => /the cutover step is skipped/.test(l)), `${x3} | ${c3.join(" | ")}`);
      ok("--all STOPS AT THE FIRST REFUSAL: when the cutover part refuses (own.cjs's guards) nothing else runs — one call, home's files stay patched, nothing on the VPS is touched; when the cutover part is done and --home refuses (the board's hours) the units ARE home-owned again, home's files stay patched and --server is NOT run (no unit, tree or key file removed)",
        /nothing stopped, nothing changed/.test(e1) && c1.join(" | ") === "own w5 home --accept-r323-weekend-gaps --dry" && k1 && /REFUSED \(nothing reverted\): .*board's hours/.test(e2) && c2.join(" | ") === [CUT, HOME].join(" | ") && k2 && m2.ok && W5.every((u) => m2.map.units[u] === "home"), `${e1} | ${c1.join(" | ")} || ${e2} | ${c2.join(" | ")}`);
      HP.applyAll(R); putMap("home"); const n4 = lines.length, c4 = mkAll({ vps: "home" }), x4 = tryAll({ ...O, now: sat }), said4 = lines.slice(n4);
      ok("--all when no W5 unit is server-owned: the cutover part is SKIPPED and said (own.cjs is never run, nothing is quiesced or pulled), then --home and --server as above", x4 === 0 && c4.join(" | ") === [HOME, SERVER].join(" | ") && snap() === s0 && said4.some((l) => /no W5 unit is server-owned at home — the cutover step is skipped/.test(l)) && said4.some((l) => /^the whole package is rolled back/.test(l)), `${x4} | ${c4.join(" | ")}`); }
  } finally { ({ SSH, log, STATE, NOW, RUN_OWN, RUN_MIRROR, KILL_TUNNEL } = saved); fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`rollback selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2), flags = new Set(a.filter((x) => x.startsWith("--"))), modes = ["--cutover", "--shadow", "--server", "--home", "--all", "--selftest"].filter((m) => flags.has(m));
  const known = new Set(["--cutover", "--shadow", "--server", "--home", "--all", "--selftest", "--dry", "--no-pull", "--server-down", "--accept-lost-files", "--vps-gone"]);
  if (modes.length !== 1 || a.some((x) => !known.has(x))) { console.log("usage: node rollback.cjs --cutover [--dry] [--no-pull] [--server-down] [--accept-lost-files] | --shadow [--dry] | --server [--dry] | --home [--dry] [--vps-gone] | --all | --selftest"); process.exitCode = 2; }
  else if (modes[0] === "--selftest") process.exitCode = selftest() ? 0 : 1;
  else { const o = { dry: flags.has("--dry"), noPull: flags.has("--no-pull"), serverDown: flags.has("--server-down"), acceptLost: flags.has("--accept-lost-files"), vpsGone: flags.has("--vps-gone") };
    try { ({ "--cutover": cutoverBack, "--shadow": shadow, "--server": server, "--home": home, "--all": all })[modes[0]](o); process.exitCode = 0; } catch (e) { console.log("REFUSED / FAILED: " + e.message); process.exitCode = 1; } }
}
module.exports = { cutoverBack, shadow, server, home, all, isTunnel, quiesceScript, resumeTimersScript, rmShadowScript, dropUnitsScript, ownArgs };
