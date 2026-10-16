#!/usr/bin/env node
/**
 * ROLLBACK — undo the W3 cell, one unit at a time or whole. 2026-10-09 (docs/server/wave3-sleeves). Each part refuses rather than guess;
 * --dry prints the plan. Run BY JOSH from the repo root on the PC.
 *
 *   node docs/server/wave3-sleeves/rollback.cjs --unit <w3-x>   ONE command per unit: the own.cjs <w3-x> home path (the VPS map pushed
 *        first so the VPS stops, a final pull brings the unit's records home — it waits for a running entry's lock —, home's map -> home;
 *        home's gated .bat lines, its close-arm runner step and its chain lines run the unit again from their next fire; the shadow runs
 *        its dry form again because the unit is home-owned). What own.cjs cannot do for this cell:
 *        w3-r295  its SESSION is one day-long process that a map change does not stop (ExecCondition is read at start only): after
 *                 own.cjs --dry passes, traids-w3-r295s.service is STOPPED first (home's R295 close-arm tasks then close out the
 *                 day's lots at 13:41 / 13:47 MT; the OTO stop legs stay at the broker).
 *        a CLOSE-ARM STEP's unit (r151 r160 r283 r186 r218 r219 r260) on a weekday before 16:45 ET: the VPS runner's record of TODAY is read
 *                 first (close-arm-status-vps.json + close-arm-blocks-vps.jsonl, fail-closed over ssh). Home's runner reads only its OWN
 *                 status and block record, so if the VPS blocked the step today (e.g. "failed after sending orders"), left its orders
 *                 unknown (suspect) or has an attempt in flight, home's next fire today would re-run it — orders twice. REFUSED then,
 *                 unless --accept-vps-block (the operator checked the step's paper account and reconciled); after 16:45 ET (home's
 *                 runner has no fire left today) or on a weekend nothing is read.
 *        own.cjs asks for --accept-r323-weekend-gaps on every wave once R323 is 7-day (a W1 matter; no R323 recorder moves here): it is
 *        passed and own.cjs's R323 text omitted. Pass-through: --dry · --no-pull · --server-down · --accept-lost-files (own.cjs's
 *        meanings; --server-down cannot stop the VPS: split-brain until it is reachable and this runs again without it).
 *        Then: node docs/server/wave3-sleeves/register.cjs --rollback <w3-x>.
 *        EMERGENCY STOP of one sleeve on the VPS without a rollback (any time, the script's own switch): ssh traids touch
 *        /home/traids/traids/backend/data/<its OFF switch> (r151-OFF, r316-OFF, ...: cell.cjs `switches`); remove it to resume.
 *   node docs/server/wave3-sleeves/rollback.cjs --shadow        the 18 shadow units stopped, disabled, removed and /home/traids/w3-shadow
 *        deleted (any time: the shadow sends nothing; a unit still home-owned then has no dry run — its dry period ends).
 *   node docs/server/wave3-sleeves/rollback.cjs --server        after EVERY W3 unit is home-owned on BOTH maps: the shadow, the 22 real
 *        units, /etc/traids/w3-sleeves.env, and only the files this package CREATED on the VPS (deploy-state copy.created) that are still
 *        the copies it sent. R309, W1, W1c, W2a and W2b files, units and env files are never named; VPS data files are kept.
 *   node docs/server/wave3-sleeves/rollback.cjs --home          an EXACT restore of every home edit (home-patch revertAll; a sibling
 *        package's edit of the same file is kept). REFUSED while either map gives a W3 unit to the server (fail-closed over ssh;
 *        --vps-gone skips the VPS for a VPS really destroyed) and outside the home step's window (deploy.cjs editWindow, M6). The map
 *        entries w3-* stay (own.cjs's map). Run it BEFORE W1c-2a's own --home (its gate is what these lines call) and W1's.
 *   node docs/server/wave3-sleeves/rollback.cjs --selftest      pure parts and a fake VPS; no ssh
 * Never touches home backend/data/r309-HALT, any R309 / W1 / W1c / W2a / W2b file or unit, the registry or a governance file.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", ".."), DS = path.join(REPO, "deploy", "server");
const PS = require(path.join(DS, "pull-server.cjs")), OWN = require(path.join(DS, "own.cjs"));
const C = require("./cell.cjs"), HP = require("./home-patch.cjs"), UN = require("./units.cjs"), DEP = require("./deploy.cjs");
const { sha, q } = PS;
const RT = C.TREE.real, RB = RT + "/backend", RD = RB + "/data", SYSD = "/etc/systemd/system", SHADOW_ROOT = C.TREE.shadow;
let SSH = PS.sshReal("traids"), log = (s) => console.log(s), STATE = path.join(HERE, "deploy-state.json");
let NOW = () => Date.now();
let RUN_OWN = (args) => { const r = cp.spawnSync(process.execPath, [path.join(DS, "own.cjs"), ...args], { cwd: REPO, encoding: "utf8", windowsHide: true, timeout: 3600000 }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") }; };
const must = (r, what) => { if (!r.ok) throw new Error(`${what} failed (exit ${r.status}): ${String(r.err || r.out).trim().slice(0, 300)}`); return String(r.out); };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

/** own.cjs's argv for a rollback of one unit (always home; R323's acceptance passed: a W1 matter) */
function ownArgs(u, o = {}) {
  if (!C.UNITS[u]) throw new Error(`not a W3 unit: ${u}`);
  return [u, "home", "--accept-r323-weekend-gaps", ...(o.dry ? ["--dry"] : []), ...(o.noPull ? ["--no-pull"] : []), ...(o.serverDown ? ["--server-down"] : []), ...(o.acceptLost ? ["--accept-lost-files"] : [])];
}
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
const serverOwned = (map) => C.UNIT_IDS.filter((u) => map && map.units && map.units[u] === "server");

/** home's close-arm runner fires at 15:37 / 15:40 (intraday) / 15:44 ET (12:37 / 12:44 on early closes) and a run ends well before this */
const RUNNER_DAY_END_ET = 16 * 60 + 45;
/**
 * pure: why rolling the unit of runner step `key` home TODAY could let home's runner re-run a step the VPS runner stopped — the VPS's
 * record for `today` shows it BLOCKED, its last attempt's orders UNKNOWN (suspect) or an attempt IN FLIGHT; null when none. statusText /
 * blocksText: close-arm-status-vps.json / close-arm-blocks-vps.jsonl as read on the VPS (null = absent). A record that does not parse -> why.
 */
function closeArmHazard(statusText, blocksText, key, today) {
  let st = null;
  if (statusText != null) { try { st = JSON.parse(statusText); } catch { return "has a close-arm-status-vps.json that does not parse (today's blocks unknown)"; } }
  const ss = st && st.days && st.days[today] && st.days[today].steps && st.days[today].steps[key], why = [];
  if (ss && ss.blocked) why.push(`BLOCKED it (${String(ss.blocked).slice(0, 160)})`);
  if (ss && ss.suspect) why.push(`left its last attempt's orders UNKNOWN (${String(ss.suspect.why || "").slice(0, 120)})`);
  if (ss && ss.inFlight) why.push(`has an attempt IN FLIGHT since ${ss.inFlight.at}`);
  for (const ln of String(blocksText || "").split(/\r?\n/)) {
    if (!ln.trim()) continue; let b; try { b = JSON.parse(ln); } catch { return "has a close-arm-blocks-vps.jsonl line that does not parse (today's blocks unknown)"; }
    if (b && b.date === today && b.key === key && !why.some((w) => /^BLOCKED/.test(w))) why.push(`BLOCKED it (close-arm-blocks-vps.jsonl: ${String(b.blocked || "").slice(0, 160)})`);
  }
  return why.length ? why.join("; ") : null;
}
/** the VPS runner's record of today for the unit's runner step, while home's runner can still fire today; null = no hazard, else why */
function closeArmCheck(u, nowMs) {
  const ca = C.UNITS[u].entries["close-arm"], key = ca && ca.runnerKey; if (!key) return null;
  const e = C.etParts(nowMs); if (e.wd === "Sat" || e.wd === "Sun" || e.mins >= RUNNER_DAY_END_ET) return null;
  const r = SSH(`cd ${q(RD)} || exit 7; echo "@@S"; if [ -f close-arm-status-vps.json ]; then cat close-arm-status-vps.json; else echo "@@ABSENT"; fi; echo; echo "@@B"; if [ -f close-arm-blocks-vps.jsonl ]; then tail -n 400 close-arm-blocks-vps.jsonl; fi; echo "@@END"`);
  const o = String((r && r.out) || "");
  if (!r || !r.ok || !/@@END\s*$/.test(o) || o.indexOf("@@S") < 0 || o.indexOf("@@B") < 0) return `the VPS's close-arm record of today could not be read (ssh exit ${r ? r.status : "?"}) — whether the VPS runner blocked ${key} today is unknown`;
  const sPart = o.slice(o.indexOf("@@S") + 3, o.indexOf("@@B")).trim(), bPart = o.slice(o.indexOf("@@B") + 3, o.lastIndexOf("@@END"));
  const h = closeArmHazard(sPart === "@@ABSENT" ? null : sPart, bPart, key, e.date);
  return h ? `the VPS's close-arm runner ${h} — ${key}, today ${e.date}` : null;
}
function unit(u, o = {}) {
  if (!C.UNITS[u]) throw new Error(`--unit needs a W3 unit (${C.UNIT_IDS.join(", ")})`);
  const session = u === "w3-r295";
  log(`== --unit ${u}: own.cjs ${u} home${session ? " (R295's day-long session stopped on the VPS first)" : ""}`);
  const hz = closeArmCheck(u, NOW());
  if (hz) {
    const key = C.UNITS[u].entries["close-arm"].runnerKey;
    const msg = `${hz}. Home's close-arm runner reads only its OWN close-arm-status.json / close-arm-blocks.jsonl, so after this rollback its next fire today would RE-RUN ${key} (a step that failed after sending orders: orders twice). Check ${key}'s paper account for its orders since the attempt and reconcile, then run again with --accept-vps-block — or roll back after 16:45 ET, when home's runner has no fire left today`;
    if (o.dry) log(`   NOTE: the real run would be REFUSED: ${msg}`);
    else if (!o.acceptVpsBlock) throw new Error(`REFUSED (nothing changed): ${msg}`);
    else log(`   --accept-vps-block: ${hz} — accepted (home's runner may re-run ${key} today)`);
  }
  if (o.dry || o.serverDown) {
    const r = RUN_OWN(ownArgs(u, o)); show(r.out);
    if (r.status !== 0) throw new Error(`own.cjs ${u} home${o.dry ? " --dry" : " --server-down"} exited ${r.status} (above)`);
    if (o.serverDown) log(`   --server-down: the VPS was not touched — if it is alive it keeps running ${u} (split-brain). When it is reachable: node docs/server/wave3-sleeves/rollback.cjs --unit ${u}`);
    return 0;
  }
  if (session) {
    const d = RUN_OWN(ownArgs(u, { ...o, dry: true })); show(d.out);
    if (d.status !== 0) throw new Error(`own.cjs ${u} home --dry refused (above) — nothing stopped, nothing changed`);
    const s = must(SSH("sudo -n systemctl stop traids-w3-r295s.service; echo \"SESSION $(systemctl is-active traids-w3-r295s.service)\""), "stop R295's session");
    if (!/SESSION inactive/.test(s)) throw new Error(`traids-w3-r295s did not stop (${s.trim()}) — own.cjs NOT run; nothing else changed`);
    log("   traids-w3-r295s.service stopped (today's lots: home's R295 close-arm tasks close them out; the broker's stop legs stay)");
  }
  const r = RUN_OWN(ownArgs(u, o)); show(r.out);
  if (r.status !== 0) throw new Error(`own.cjs ${u} home exited ${r.status} (above — it says which host runs the unit now)${session ? ". R295's VPS session is STOPPED; if the VPS still owns the unit, its timer starts the next session at 08:00 ET" : ""}`);
  log(`   done: ${u} is home-owned; the shadow runs its dry form again. Record it: node docs/server/wave3-sleeves/register.cjs --rollback ${u}`);
  return 0;
}
/**
 * the ONE rm -rf of this package, as the VPS runs it: the path is checked ON THE VPS by a literal case pattern — only /home/traids/w3-shadow
 * is ever deleted; any other path (the real tree, a parent, "/") exits 3 with nothing removed. root is a parameter only so the selftest can
 * prove the guard with other paths; shadow() always sends shadowRmScript() (= SHADOW_ROOT).
 */
const shadowRmScript = (root = SHADOW_ROOT) => `case ${q(root)} in /home/traids/w3-shadow) rm -rf -- ${q(root)} && echo GONE;; *) exit 3;; esac`;
/** a POSIX shell this host can start (the selftest proves the VPS-side guard with it): /bin/sh; on Windows Git's own sh.exe (under Program Files, or
 *  beside the git on the PATH); else "sh" on the PATH; null when none. Read-only: it only runs `echo`. */
function posixShell() {
  const pf = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432, "C:\\Program Files"].filter(Boolean), win = [];
  if (process.platform === "win32") {
    for (const d of [...new Set(pf)]) win.push(path.join(d, "Git", "usr", "bin", "sh.exe"), path.join(d, "Git", "bin", "sh.exe"));
    const g = cp.spawnSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true, timeout: 30000 }), ex = !g.error && g.status === 0 ? String(g.stdout).trim() : "";   // <git root>/mingw64/libexec/git-core
    if (ex) win.push(path.resolve(ex, "..", "..", "..", "usr", "bin", "sh.exe"), path.resolve(ex, "..", "..", "..", "bin", "sh.exe"));
  }
  const cands = [...(process.platform === "win32" ? win : ["/bin/sh", "/usr/bin/sh"]), "sh"];
  for (const c of cands) { if (c !== "sh" && !fs.existsSync(c)) continue; const r = cp.spawnSync(c, ["-c", "echo W3SH"], { encoding: "utf8", windowsHide: true, timeout: 30000 }); if (!r.error && r.status === 0 && /W3SH/.test(String(r.stdout))) return c; }
  return null;
}
function shadow({ dry = false } = {}) {
  let hm = null; try { hm = JSON.parse(fs.readFileSync(path.join(PS.HOME_DATA, "host-ownership.json"), "utf8")); } catch { hm = null; }
  const still = C.UNIT_IDS.filter((u) => !(hm && hm.units && hm.units[u] === "server"));
  log(`== --shadow: ${UN.SHADOW_UNITS.length} shadow unit files stopped, disabled, removed; ${SHADOW_ROOT} deleted${still.length ? ` (home-owned, their dry period ends: ${still.map(C.short).join(" ")})` : ""}`);
  if (dry) { log("   (dry: nothing done)"); return 0; }
  must(SSH(unitsCommand(UN.SHADOW_UNITS)), "remove the shadow units");
  must(SSH(shadowRmScript()), "delete the shadow tree");
  const left = must(SSH(`ls ${UN.SHADOW_UNITS.map((u) => SYSD + "/" + u).join(" ")} 2>/dev/null | wc -l; test -e ${q(SHADOW_ROOT)} && echo TREE || echo NOTREE`), "verify").trim().split("\n");
  if (left[0].trim() !== "0" || left[1] !== "NOTREE") throw new Error("verification failed: " + left.join(" "));
  log("   done: no shadow unit file, no shadow tree");
  return 0;
}
/** the files --server may remove: created by this package (deploy-state copy.created) and still byte-equal to the copy it sent */
function removable(stateCopy, vpsShas) {
  const created = (stateCopy && stateCopy.created) || [], sent = (stateCopy && stateCopy.real) || {};
  const keep = /^backend\/(own-check\.cjs|lib\/atomic-write\.js|lib\/schwab-md\.js|traids-alert\.cjs|notify\.js)$/;   // the standing machinery and other waves' files: never
  return { remove: created.filter((k) => !keep.test(k) && sent[k] && vpsShas.get(k) === sent[k]), kept: created.filter((k) => keep.test(k) || !sent[k] || (vpsShas.get(k) && vpsShas.get(k) !== sent[k])) };
}
function server({ dry = false } = {}) {
  const hm = readJson(path.join(PS.HOME_DATA, "host-ownership.json")); if (!hm) throw new Error("home's map is unreadable — REFUSED");
  const hs = serverOwned(hm), vs = serverOwned(vpsMapUnits());
  if (hs.length || vs.length) throw new Error(`REFUSED: ${[...new Set([...hs, ...vs])].join(", ")} server-owned (home map: ${hs.join(", ") || "none"}; VPS map: ${vs.join(", ") || "none"}) — run --unit <w3-x> for each first`);
  const st = (readJson(STATE) || { steps: {} }).steps || {}, cpy = st.copy || {}, keys = (cpy.created || []);
  const byDir = { backend: RB, automation: RT + "/automation" }, v = new Map();
  for (const d of Object.keys(byDir)) { const rels = keys.filter((k) => k.startsWith(d + "/")).map((k) => k.slice(d.length + 1)); if (rels.length) { const m = PS.remoteShas(SSH, byDir[d], rels); for (const r of rels) v.set(`${d}/${r}`, m.get(r)); } }
  const plan = removable(cpy, v);
  log(`== --server: the shadow, then ${UN.REAL_UNITS.length} real unit files removed; /etc/traids/w3-sleeves.env removed; files removed: ${plan.remove.length}${plan.kept.length ? `; KEPT (standing machinery, or changed since this package sent it): ${plan.kept.join(", ")}` : ""}`);
  if (dry) { log("   (dry: nothing done)"); return 0; }
  shadow();
  must(SSH(unitsCommand(UN.REAL_UNITS)), "remove the real units");
  must(SSH(`sudo -n rm -f -- /etc/traids/w3-sleeves.env; echo RM`), "remove the env file");
  for (const d of Object.keys(byDir)) { const rels = plan.remove.filter((k) => k.startsWith(d + "/")).map((k) => k.slice(d.length + 1)); if (rels.length) must(SSH(`cd ${q(byDir[d])} || exit 7; rm -f -- ${rels.map(q).join(" ")}; echo RM`), `remove the copied ${d} files`); }
  const left = must(SSH(`ls ${UN.REAL_UNITS.map((u) => SYSD + "/" + u).join(" ")} /etc/traids/w3-sleeves.env 2>/dev/null | wc -l; systemctl is-active traids-r309.timer 2>/dev/null; true`), "verify").trim().split("\n");
  if (left[0].trim() !== "0") throw new Error("verification failed (unit or env files left): " + left.join(" "));
  log(`   done: no W3 unit or env file on the VPS; traids-r309.timer ${left[1] || "?"} (untouched)`);
  return 0;
}
function home({ dry = false, now = Date.now(), procs, vpsGone = false, homeDir = PS.HOME_DATA, root = REPO } = {}) {
  const mr = PS.readMap(path.join(homeDir, "host-ownership.json"));
  if (!mr.ok) throw new Error(`REFUSED: home's ${mr.why} — an unreadable map is never read as "nothing server-owned"`);
  const hs = serverOwned(mr.map); if (hs.length) throw new Error(`REFUSED: ${hs.join(", ")} server-owned in home's map — run --unit <w3-x> first (reverting the gates would start home's sleeve beside the VPS)`);
  if (!vpsGone) { const vs = serverOwned(vpsMapUnits()); if (vs.length) throw new Error(`REFUSED: the VPS map still gives ${vs.join(", ")} to the server (the --server-down state: it keeps running there) — run --unit <w3-x> without --server-down first`); log("   the VPS map gives no W3 unit to the server"); }
  else log("   --vps-gone: the VPS map is NOT checked (only for a VPS that has really been destroyed)");
  const g = DEP.editWindow(now, { procs: procs !== undefined ? procs : OWN.procScan(), chainStatus: readJson(path.join(homeDir, "chain-status.json")) }); if (g) throw new Error(g);
  log("== --home: home-patch revertAll (exact restore; a sibling package's edit of the same file is kept)");
  for (const l of HP.revertAll(root, { dry })) log("   " + l);
  return 0;
}

// ── selftest ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + String(d).slice(0, 500) : "")); } };
  const err = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const save = { SSH, log, RUN_OWN, STATE, NOW }, tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w3-rollback-"));
  NOW = () => Date.parse("2026-10-17T18:00:00Z");   // a Saturday: the close-arm check reads nothing (its own cases below set the clock)
  try {
    ok("own.cjs argv: always 'home' + --accept-r323-weekend-gaps; the pass-through flags exactly as given; a non-W3 unit refused", ownArgs("w3-r283").join(" ") === "w3-r283 home --accept-r323-weekend-gaps" && ownArgs("w3-r316", { dry: true, noPull: true, acceptLost: true }).join(" ") === "w3-r316 home --accept-r323-weekend-gaps --dry --no-pull --accept-lost-files" && /not a W3 unit/.test(err(() => ownArgs("w3-r24m")) || ""));
    ok("own.cjs's R323 text is omitted (its own line dropped, a tail cut), every other line kept", scrubR323("R323: something") === null && /omitted/.test(scrubR323(`x. ${R323_TEXT} and so on`)) && scrubR323("1 VPS map pushed") === "1 VPS map pushed");
    // --unit on a fake VPS + fake own.cjs
    const calls = [], owns = []; let ownExit = 0, sessionState = "inactive";
    SSH = (s) => { calls.push(s); if (/systemctl stop traids-w3-r295s/.test(s)) return { ok: true, status: 0, out: `SESSION ${sessionState}\n`, err: "" }; return { ok: false, status: 127, out: "", err: "unexpected" }; };
    RUN_OWN = (args) => { owns.push(args.join(" ")); return { status: args.includes("--dry") ? 0 : ownExit, out: "1 VPS map pushed\nR323: weekend text\n" }; };
    const lines = []; log = (s) => lines.push(s);
    unit("w3-r283");
    ok("--unit w3-r283: one own.cjs call (home), NO ssh of its own (own.cjs pushes the map, pulls, resumes home); the register hint printed; R323's text omitted", owns.join("|") === "w3-r283 home --accept-r323-weekend-gaps" && calls.length === 0 && lines.some((l) => /register\.cjs --rollback w3-r283/.test(l)) && !lines.some((l) => /weekend text/.test(l)));
    owns.length = 0; calls.length = 0; unit("w3-r295");
    ok("--unit w3-r295: own.cjs --dry FIRST, then the day-long session stopped on the VPS, then own.cjs home", owns.join("|") === "w3-r295 home --accept-r323-weekend-gaps --dry|w3-r295 home --accept-r323-weekend-gaps" && calls.length === 1 && /systemctl stop traids-w3-r295s\.service/.test(calls[0]));
    owns.length = 0; calls.length = 0; sessionState = "active";
    const e1 = err(() => unit("w3-r295"));
    ok("--unit w3-r295 whose session does not stop -> REFUSED, own.cjs home NOT run (only its --dry)", /did not stop/.test(e1 || "") && owns.join("|") === "w3-r295 home --accept-r323-weekend-gaps --dry");
    sessionState = "inactive"; owns.length = 0; ownExit = 1; const e2 = err(() => unit("w3-r316"));
    ok("own.cjs home failing -> the error says to read own.cjs's message (it names the host that runs the unit)", /own\.cjs w3-r316 home exited 1/.test(e2 || ""));
    owns.length = 0; calls.length = 0; ownExit = 0; unit("w3-r151", { dry: true }); unit("w3-r151", { serverDown: true, acceptLost: true });
    ok("--dry / --server-down pass straight to own.cjs (no session stop, no ssh)", owns.join("|") === "w3-r151 home --accept-r323-weekend-gaps --dry|w3-r151 home --accept-r323-weekend-gaps --server-down --accept-lost-files" && calls.length === 0);
    // --server's removal list
    const rec = { real: { "backend/r151-rsi2-forward.js": "a".repeat(64), "backend/lib/tv-pit-panel.js": "b".repeat(64), "backend/w3-run.cjs": "c".repeat(64), "backend/notify.js": "d".repeat(64) }, created: ["backend/r151-rsi2-forward.js", "backend/lib/tv-pit-panel.js", "backend/w3-run.cjs", "backend/notify.js"] };
    const rv = removable(rec, new Map([["backend/r151-rsi2-forward.js", "a".repeat(64)], ["backend/lib/tv-pit-panel.js", "e".repeat(64)], ["backend/w3-run.cjs", "c".repeat(64)], ["backend/notify.js", "d".repeat(64)]]));
    ok("--server removes ONLY files this package created that are still its copies: a changed one and the standing machinery (notify.js, own-check, atomic-write, lib/schwab-md.js) are KEPT", rv.remove.join() === "backend/r151-rsi2-forward.js,backend/w3-run.cjs" && rv.kept.join() === "backend/lib/tv-pit-panel.js,backend/notify.js");
    ok("--server with no copy record removes no file (only units and the env file)", removable(null, new Map()).remove.length === 0);
    // --server / --home refusals on a fake VPS map
    const vmap = (units) => { SSH = (s) => (/host-ownership\.json/.test(s) ? { ok: true, status: 0, out: JSON.stringify({ schema: "host-ownership-v1", units }), err: "" } : { ok: false, status: 127, out: "", err: "" }); };
    vmap({ "w3-r283": "server" });
    ok("--server: the VPS map still gives w3-r283 to the server -> REFUSED (nothing removed)", /REFUSED: w3-r283 server-owned/.test(err(() => server({ dry: true })) || ""));
    SSH = () => ({ ok: false, status: 255, out: "", err: "down" });
    ok("--server with the VPS unreachable -> REFUSED (an unreadable map is never read as 'home')", /reading the VPS map failed/.test(err(() => server({ dry: true })) || ""));
    { const H = path.join(tmp, "home"); fs.mkdirSync(H); fs.writeFileSync(path.join(H, "host-ownership.json"), JSON.stringify({ schema: "host-ownership-v1", units: { "w3-r151": "server", "w3-r283": "home" } }));
      ok("--home: a unit server-owned in home's map -> REFUSED before anything", /w3-r151 server-owned in home's map/.test(err(() => home({ homeDir: H, procs: [], now: Date.parse("2026-10-17T18:30:00Z") })) || ""));
      fs.writeFileSync(path.join(H, "host-ownership.json"), JSON.stringify({ schema: "host-ownership-v1", units: { "w3-r151": "home" } })); vmap({ "w3-r151": "server" });
      ok("--home: home's map says home but the VPS's still says server (--server-down state) -> REFUSED", /VPS map still gives w3-r151/.test(err(() => home({ homeDir: H, procs: [], now: Date.parse("2026-10-17T18:30:00Z") })) || ""));
      vmap({ "w3-r151": "home" });
      ok("--home inside the sleeve hours (Wed 10:00 MT) -> REFUSED by the home step's own window (M6)", /sleeve hours/.test(err(() => home({ homeDir: H, procs: [], now: Date.parse("2026-10-14T16:00:00Z") })) || ""));
      // BOTH SIDES OF THE HOME STEP (2026-10-11). This case asserted the real repo as it was BEFORE the home step ("not yet applied"); the step ran on
      // 2026-10-11 at 08:20 MT and the case went red. It now asks the package's own judge (deploy.cjs homeSide: home-patch.cjs stateOf of every
      // entry on the real files) which side the real home is on and asserts THAT side's known answer of the SAME dry call:
      //   BEFORE   exactly what it always asserted: the revertAll header, 'nothing to undo' for each of the 11 edits + 15 new files
      //   AFTER    each of the 11 applied edits listed once as 'would revert', each of the 15 new files once as 'would remove', each .pre-w3.bak
      //            record once ('would remove', or 'KEPT' when a later sibling edit made it differ), no 'nothing to undo', no line of a real run
      //   NEITHER  (a drifted entry, a partly applied patch) the case FAILS with the judge's reason; it never passes
      // On every side: no throw, and NOTHING written (the fingerprint of every file the patch edits or creates, and of the .bak records, is the same
      // after the call as before — the name always said so; now it is checked). The real repo is asked only AFTER the same call on a temp mirror
      // of it answered right and wrote nothing there: a dry run that writes is caught on the mirror, never on the real files.
      // The side the real home is NOT on is asserted on that mirror, put there by home-patch's own revertAll / applyAll.
      const RNAME = "--home --dry on the real repo (not yet applied): every edit reads 'nothing to undo' and nothing is written", N = HP.EDITS.length + HP.NEW.length;
      const dryHome = (root) => { const out = [], keepLog = log, s0 = DEP.homeSnap(root); let e = null; log = (s) => out.push(s); try { home({ homeDir: H, procs: [], now: Date.parse("2026-10-17T18:30:00Z"), dry: true, root }); } catch (x) { e = x.message; } finally { log = keepLog; } return { out, e, same: DEP.homeSnap(root) === s0 }; };
      const answer = (root, side) => {
        const r = dryHome(root), L = r.out.map((l) => String(l).replace(/^ {3}/, "")), d = `${r.e ? "threw: " + r.e + " | " : ""}${r.same ? "" : "the dry run WROTE a file | "}${r.out.join(" | ")}`;
        const head = r.e === null && r.same && r.out.some((l) => /home-patch revertAll/.test(l));
        if (side === "before") return { pass: head && r.out.filter((l) => /nothing to undo/.test(l)).length === N, d };
        const once = (test) => L.filter(test).length === 1, baks = HP.EDITS.filter((e) => fs.existsSync(path.join(root, ...HP.BAK(e.rel).split("/"))));
        return { pass: head && L.filter((l) => l.startsWith("would revert     ")).length === HP.EDITS.length && HP.EDITS.every((e) => once((l) => l.startsWith(`would revert     ${e.rel} (each anchor line restored in place`)))
          && HP.NEW.every((e) => once((l) => l === `would remove     ${e.rel}`)) && baks.every((e) => once((l) => l.startsWith(`would remove     ${HP.BAK(e.rel)} (`) || l.startsWith(`KEPT             ${HP.BAK(e.rel)} — `)))
          && !L.some((l) => /nothing to undo/.test(l) || /^(revert|remove) /.test(l)), d };
      };
      const caseOn = (root) => { const at = DEP.homeSide(root); return { at, ...(at.side === "neither" ? { pass: false, d: at.why } : answer(root, at.side)) }; };
      const M = path.join(tmp, "home-mirror"), at = DEP.homeSide(REPO), rs = at.side, s0 = DEP.homeSnap(REPO); let real = { at, pass: false, d: at.why }, first = null;
      if (rs !== "neither") {
        DEP.homeMirror(M); first = caseOn(M);   // the SAME dry call on a mirror of the real files first
        real = first.at.side === rs && first.pass ? caseOn(REPO) : { at, pass: false, d: `the real repo was NOT asked: on a temp mirror of the real home files the dry call did not give the ${rs.toUpperCase()} answer or wrote a file — ${first.d}` };
      }
      ok(`${RNAME} (${rs === "before" ? `home is BEFORE its home step, ${at.of}` : rs === "after" ? `home is AFTER its home step, ${at.of}, so the real repo is asked the other way: each of the ${HP.EDITS.length} applied edits is listed once as 'would revert', each of the ${HP.NEW.length} new files once as 'would remove', each .pre-w3.bak record once, nothing reads 'nothing to undo'` : `home is on NEITHER side of its home step, ${at.of}: the case fails with the judge's reason`}; no throw, and the fingerprint of every file the patch edits or creates is the same after the dry call as before)`, real.pass && DEP.homeSnap(REPO) === s0, real.d);
      { const want = rs === "after" ? "before" : rs === "before" ? "after" : null; let o = null, why = null;
        try { if (rs === "after") HP.revertAll(M); else if (rs === "before") HP.applyAll(M); else throw new Error(at.why); o = caseOn(M); } catch (x) { why = x.message; }   // the package's own engine, on the mirror only
        ok(`the OTHER side of the home step, on a temp mirror of the real home files (${rs === "after" ? "the home patch REVERTED there by home-patch's own revertAll: the judge reads the mirror as BEFORE and --home --dry on it reads 'nothing to undo' for every one of the " + N + " entries — what the case above asserted before the home step ran" : rs === "before" ? "the home patch APPLIED there by home-patch's own applyAll: the judge reads the mirror as AFTER and --home --dry on it lists every edit as 'would revert' and every new file as 'would remove'" : "not judged: the real home is on neither side"}); before the real repo was asked, the same dry call on the mirror as copied gave the real side's answer and wrote nothing; the real files are never written`,
          why === null && !!want && !!first && first.at.side === rs && first.pass && o.at.side === want && o.at.of === `${want === "after" ? N : 0} of ${N} entries applied` && o.pass && DEP.homeSnap(REPO) === s0, why || JSON.stringify([rs, first && [first.at, first.pass], o && [o.at, o.pass, o.d]]));
        // a home on NEITHER side never passes: the same case on the mirror, applied, with ONE new file missing (partly applied), then with one new file edited by a byte (drift)
        let n1 = null, n2 = null, whyN = null;
        try {
          if (DEP.homeSide(M).side !== "after") HP.applyAll(M);
          const cellF = path.join(M, "deploy", "server", "w3-cell.cjs"), syncF = path.join(M, "deploy", "server", "w3-sync.cjs"), keepCell = fs.readFileSync(cellF);
          fs.rmSync(cellF); n1 = caseOn(M); fs.writeFileSync(cellF, keepCell);
          fs.appendFileSync(syncF, "\n// edited after the deploy\n"); n2 = caseOn(M);
        } catch (x) { whyN = x.message; }
        ok("a home that is on NEITHER side of its home step makes the case above FAIL with the judge's reason, never pass (the applied mirror with ONE new file missing, deploy/server/w3-cell.cjs -> 'the home patch as PARTLY applied', naming it; with one new file edited by a byte, deploy/server/w3-sync.cjs -> 'DRIFT: deploy/server/w3-sync.cjs exists and is not the staged copy')",
          whyN === null && n1.at.side === "neither" && n1.pass === false && n1.d === `home-patch.cjs stateOf reads the home patch as PARTLY applied (${N - 1} of ${N} entries applied; not applied: deploy/server/w3-cell.cjs)`
          && n2.at.side === "neither" && n2.pass === false && n2.d === "home-patch.cjs stateOf reads DRIFT: deploy/server/w3-sync.cjs exists and is not the staged copy" && DEP.homeSnap(REPO) === s0, whyN || JSON.stringify([n1, n2])); } }
    // the VPS runner's blocks: a same-day rollback must not let home's runner re-run a step the VPS stopped
    { const D = "2026-10-14", stat = (steps, day = D) => JSON.stringify({ spec: "close-arm-status-v1", days: { [day]: { runs: [], alerts: {}, alertAttempts: {}, steps } } });
      const blk = (o) => JSON.stringify({ date: D, key: "r151", blocked: "failed after printing a SENT order (exit 1) — a re-run could send or sell twice", at: "2026-10-14T19:38:30Z", by: "task", ...o }) + "\n";
      ok("closeArmHazard: today's r151 BLOCKED, its orders UNKNOWN (suspect) or IN FLIGHT on the VPS -> a reason each; a block row of today in close-arm-blocks-vps.jsonl alone -> BLOCKED; done / another day / another step / nothing recorded -> null; a record that does not parse -> a reason (fail-closed)",
        /BLOCKED it \(failed after/.test(closeArmHazard(stat({ r151: { blocked: "failed after printing a SENT order" } }), "", "r151", D) || "") && /orders UNKNOWN \(killed/.test(closeArmHazard(stat({ r151: { suspect: { why: "killed at its 120s timeout" } } }), "", "r151", D) || "") && /IN FLIGHT since 2026-10-14T19:37:10Z/.test(closeArmHazard(stat({ r151: { inFlight: { at: "2026-10-14T19:37:10Z" } } }), "", "r151", D) || "")
        && /BLOCKED it \(close-arm-blocks-vps\.jsonl/.test(closeArmHazard(null, blk({}), "r151", D) || "") && closeArmHazard(stat({ r151: { doneAt: "2026-10-14T19:37:40Z" } }), "", "r151", D) === null && closeArmHazard(stat({ r151: { blocked: "x" } }, "2026-10-13"), blk({ date: "2026-10-13" }), "r151", D) === null && closeArmHazard(stat({ r160: { blocked: "x" } }), blk({ key: "r160" }), "r151", D) === null && closeArmHazard(null, "", "r151", D) === null
        && /does not parse/.test(closeArmHazard("{ torn", "", "r151", D) || "") && /does not parse/.test(closeArmHazard(null, "{ torn\n", "r151", D) || ""));
      const owns2 = [], calls2 = []; let vps = { ok: true, status: stat({ r151: { blocked: "failed after printing a SENT order (exit 1)" } }), blocks: "" };
      SSH = (s) => { calls2.push(s); if (!/@@S/.test(s)) return { ok: false, status: 127, out: "", err: "unexpected" }; if (!vps.ok) return { ok: false, status: 255, out: "", err: "down" }; return { ok: true, status: 0, out: `@@S\n${vps.status == null ? "@@ABSENT" : vps.status}\n@@B\n${vps.blocks}@@END\n`, err: "" }; };
      RUN_OWN = (args) => { owns2.push(args.join(" ")); return { status: 0, out: "ok\n" }; }; const lines2 = []; log = (s) => lines2.push(s);
      NOW = () => Date.parse("2026-10-14T19:41:00Z");   // Wed 15:41 ET: home's 15:44 ET fire is still ahead
      const eB = err(() => unit("w3-r151"));
      ok("--unit w3-r151 at 15:41 ET while the VPS runner BLOCKED r151 today -> REFUSED before own.cjs (home's 15:44 fire would re-run it: orders twice), naming the block and --accept-vps-block; one read-only ssh", /REFUSED \(nothing changed\)[^]*BLOCKED it[^]*RE-RUN r151[^]*--accept-vps-block/.test(eB || "") && owns2.length === 0 && calls2.length === 1, eB);
      unit("w3-r151", { acceptVpsBlock: true }); unit("w3-r151", { dry: true });
      ok("--accept-vps-block (the operator checked the account) -> own.cjs home runs, the acceptance logged; --dry -> own.cjs --dry runs and says the real run would be REFUSED", owns2.join("|") === "w3-r151 home --accept-r323-weekend-gaps|w3-r151 home --accept-r323-weekend-gaps --dry" && lines2.some((l) => /--accept-vps-block: the VPS's close-arm runner BLOCKED it/.test(l)) && lines2.some((l) => /NOTE: the real run would be REFUSED/.test(l)));
      owns2.length = 0; vps = { ok: false }; const eD = err(() => unit("w3-r160"));
      vps = { ok: true, status: null, blocks: blk({ key: "r283" }) }; const eK = err(() => unit("w3-r283"));
      vps = { ok: true, status: stat({ r186: { doneAt: "2026-10-14T19:37:20Z" } }), blocks: "" }; unit("w3-r186");
      ok("--unit at 15:41 ET: the VPS unreadable -> REFUSED (fail-closed: whether it blocked r160 is unknown); a block row for r283 in the blocks record alone -> REFUSED; r186 done cleanly on the VPS -> own.cjs runs", /could not be read[^]*r160 today is unknown/.test(eD || "") && /BLOCKED it \(close-arm-blocks-vps\.jsonl/.test(eK || "") && owns2.join("|") === "w3-r186 home --accept-r323-weekend-gaps", JSON.stringify([eD, eK]));
      owns2.length = 0; calls2.length = 0; vps = { ok: true, status: stat({ r151: { blocked: "x" } }), blocks: "" }; unit("w3-r236");
      NOW = () => Date.parse("2026-10-14T21:10:00Z"); unit("w3-r151");
      ok("no read, no refusal: a unit without a runner step (w3-r236) at 15:41 ET; r151 after 16:45 ET (17:10: home's runner has no fire left today)", calls2.length === 0 && owns2.join("|") === "w3-r236 home --accept-r323-weekend-gaps|w3-r151 home --accept-r323-weekend-gaps");
      NOW = () => Date.parse("2026-10-17T18:00:00Z"); }
    ok("the shadow root deleted is exactly /home/traids/w3-shadow (a case guard on the VPS), never the real tree", SHADOW_ROOT === "/home/traids/w3-shadow" && RT === "/home/traids/traids" && UN.SHADOW_UNITS.every((u) => /^traids-w3s-/.test(u)) && UN.REAL_UNITS.every((u) => /^traids-w3-/.test(u)) && UN.SHADOW_UNITS.length === 18 && UN.REAL_UNITS.length === 22);
    // the shadow tree's delete: the EXACT script shadow() sends (a fake ssh capture), then that script's guard run by a real POSIX shell
    { const sent = [], okR = (out) => ({ ok: true, status: 0, out, err: "" });
      SSH = (s) => { sent.push(s); if (/systemctl disable --now/.test(s)) return okR("REMOVED\n"); if (/^case /.test(s)) return okR("GONE\n"); if (/^ls /.test(s)) return okR("0\nNOTREE\n"); return { ok: false, status: 127, out: "", err: "unexpected" }; };
      log = () => {}; const rc = shadow(), rm = sent.filter((s) => /\brm -rf\b/.test(s)), WANT = "case '/home/traids/w3-shadow' in " + "/home/traids/w3-shadow) " + "rm -rf -- '/home/traids/w3-shadow' && echo GONE;; *) exit 3;; esac";
      ok("--shadow sends exactly ONE rm -rf and it is the guarded one, byte for byte: case '/home/traids/w3-shadow' in /home/traids/w3-shadow) rm -rf -- '/home/traids/w3-shadow' && echo GONE;; *) exit 3;; esac — after the 18 shadow units are removed (no traids-w3-* real unit named), before the verification",
        rc === 0 && sent.length === 3 && rm.length === 1 && rm[0] === WANT && sent[1] === WANT && shadowRmScript() === WANT && rm[0].includes("case '/home/traids/w3-shadow' in " + "/home/traids/w3-shadow) " + "rm -rf") && /systemctl disable --now traids-w3s-/.test(sent[0]) && !/traids-w3-/.test(sent[0]) && /^ls /.test(sent[2]), JSON.stringify(sent.map((s) => s.slice(0, 140))));
      const n0 = sent.length; shadow({ dry: true });
      ok("--shadow --dry sends nothing (no ssh at all)", sent.length === n0);
      // the guard itself: the script as sent, in a real shell, with `rm` replaced by a shell function that only prints (and no PATH to find a real rm)
      const sh = posixShell(), runCase = (root) => { const r = cp.spawnSync(sh, ["-c", `rm() { echo "RM $*"; }\n${shadowRmScript(root)}`], { encoding: "utf8", windowsHide: true, timeout: 30000, env: { ...(sh === "sh" ? process.env : {}), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(sh === "sh" ? {} : { PATH: "/nonexistent-w3-selftest" }) } }); return { status: r.status, out: String(r.stdout || "").replace(/\r/g, "") }; };
      const good = sh ? runCase(SHADOW_ROOT) : null, bad = sh ? ["/home/traids/traids", "/home/traids/traids/backend", "/home/traids", "/home/traids/w3-shadow/", "/home/traids/w3-shadow/../traids", "/home/traids/w3-shadow2", "/", "*", ""].map((p) => [p, runCase(p)]) : [];
      ok("the VPS-side guard run by a real POSIX shell (rm replaced by a printing shell function): SHADOW_ROOT /home/traids/w3-shadow -> 'rm -rf -- /home/traids/w3-shadow', GONE, exit 0; a SHADOW_ROOT of /home/traids/traids (the REAL tree), its backend, /home/traids, a trailing slash, a ../ path, a longer name, '/', '*' or '' -> exit 3 and rm NEVER called",
        !!sh && good.status === 0 && good.out === "RM -rf -- /home/traids/w3-shadow\nGONE\n" && bad.length === 9 && bad.every(([, r]) => r.status === 3 && r.out === ""), sh ? JSON.stringify([good, ...bad.filter(([, r]) => !(r.status === 3 && r.out === ""))]) : "no POSIX shell found on this host (Git for Windows' sh.exe, /bin/sh, or sh on the PATH) — the guard could not be proven"); }
  } finally { ({ SSH, log, RUN_OWN, STATE, NOW } = save); fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`rollback selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2), has = (f) => a.includes(f), arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const known = new Set(["--unit", "--shadow", "--server", "--home", "--selftest", "--dry", "--no-pull", "--server-down", "--accept-lost-files", "--accept-vps-block", "--vps-gone"]);
  const bad = a.filter((x, i) => (x.startsWith("--") ? !known.has(x) : a[i - 1] !== "--unit"));
  const modes = ["--unit", "--shadow", "--server", "--home", "--selftest"].filter(has);
  if (bad.length || modes.length !== 1 || (has("--unit") && !C.UNITS[arg("--unit")]) || ((has("--no-pull") || has("--server-down") || has("--accept-lost-files") || has("--accept-vps-block")) && !has("--unit")) || (has("--vps-gone") && !has("--home"))) {
    console.error(`usage: rollback.cjs --unit <${C.UNIT_IDS.join("|")}> [--dry] [--no-pull] [--server-down] [--accept-lost-files] [--accept-vps-block] · --shadow [--dry] · --server [--dry] · --home [--dry] [--vps-gone] · --selftest`); process.exitCode = 2;
  } else {
    try {
      if (has("--selftest")) process.exitCode = selftest() ? 0 : 1;
      else if (has("--unit")) process.exitCode = unit(arg("--unit"), { dry: has("--dry"), noPull: has("--no-pull"), serverDown: has("--server-down"), acceptLost: has("--accept-lost-files"), acceptVpsBlock: has("--accept-vps-block") });
      else if (has("--shadow")) process.exitCode = shadow({ dry: has("--dry") });
      else if (has("--server")) process.exitCode = server({ dry: has("--dry") });
      else process.exitCode = home({ dry: has("--dry"), vpsGone: has("--vps-gone") });
    } catch (e) { console.error(e.message); process.exitCode = 1; }
  }
}
module.exports = { ownArgs, scrubR323, unit, shadow, shadowRmScript, server, home, removable, closeArmHazard, closeArmCheck };
