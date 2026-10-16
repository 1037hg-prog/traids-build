#!/usr/bin/env node
/**
 * ROLLBACK — undo the W1 package, 2026-10-07 (docs/server/wave1-crypto). Each part refuses rather than guess; --dry prints the plan.
 *
 *   node deploy/server/own.cjs w1 home                         FIRST, and usually ALL you need (one command): the VPS map is pushed so
 *                                                              the VPS stops, a final pull brings its files home, home resumes. The
 *                                                              real units stay installed and skip themselves (their ExecCondition); the
 *                                                              shadow timers (gated "home") are disabled by it.
 *   node docs/server/wave1-crypto/rollback.cjs --shadow        the shadow units (traids-w1s-*) stopped, disabled and removed, and the shadow
 *                                                              tree /home/traids/w1-shadow deleted. Any time (it is disposable); the normal
 *                                                              clean-up after a good cutover.
 *   node docs/server/wave1-crypto/rollback.cjs --server        everything W1 on the VPS: the shadow (as --shadow), the real units
 *                                                              (traids-w1-*) disabled and removed, daemon-reload, and the seven scripts this
 *                                                              package copied into /home/traids/traids/backend removed when they are still
 *                                                              the copies it sent. REFUSED while home's map OR the VPS's map gives any W1 unit
 *                                                              to the server (run own.cjs w1 home first). The VPS data files and its map are
 *                                                              left in place (data is never deleted; R309 is untouched).
 *   node docs/server/wave1-crypto/rollback.cjs --home          home-patch revertAll: the anchored blocks removed and the tagged chain lines
 *                                                              restored (later unrelated edits survive), the new files removed if unchanged
 *                                                              (CRLF/LF-insensitive; one that was edited is KEPT and named for hand removal).
 *                                                              REFUSED while home's map is unreadable or gives any W1 unit to the server;
 *                                                              REFUSED while the VPS map is unreadable or gives any W1 unit to the server, or
 *                                                              while the real W1 units are still installed on the VPS (run --server first:
 *                                                              this step removes own.cjs and the health check, the only tools that stop and
 *                                                              watch them) — `--home --vps-gone` skips the VPS checks for a VPS that has
 *                                                              really been destroyed; refused while the close chain is due or running and
 *                                                              outside the preflight.bat window (M6: :20-:50 or after 18:00 MT, and no
 *                                                              preflight.bat process running). The map backend/data/host-ownership.json stays.
 *   node docs/server/wave1-crypto/rollback.cjs --selftest      pure parts and a fake VPS; no ssh
 * Never touches home backend/data/r309-HALT, any R309 file or unit, the registry or a governance file. Every guard read over ssh is
 * FAIL-CLOSED: an ssh failure refuses.
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", "..");
const PS = require(path.join(HERE, "pull-server.cjs")), OWN = require(path.join(HERE, "own.cjs")), HP = require(path.join(HERE, "home-patch.cjs")), UN = require(path.join(HERE, "units.cjs"));
const { sha, q } = PS;
const RB = "/home/traids/traids/backend", RD = RB + "/data", SYSD = "/etc/systemd/system", SHADOW_ROOT = "/home/traids/w1-shadow";
const W1 = ["w1-whales", "w1-funding", "w1-social"];
const SHADOW_UNITS = UN.ALL_UNITS.filter((u) => /traids-w1s-/.test(u)), REAL_UNITS = UN.ALL_UNITS.filter((u) => /traids-w1-/.test(u));
const COPIED = ["hyperliquid-whales-record.js", "r323-hl-copy-leaders.js", "funding-carry-v2.js", "social-mentions-record.js", "w1-run.cjs", "own-check.cjs", "w1-probe.cjs"];
let SSH = PS.sshReal("traids");
const must = (r, what) => { if (!r.ok) throw new Error(`${what} failed (exit ${r.status}): ${String(r.err || r.out).trim().slice(0, 300)}`); return String(r.out); };
let log = (s) => console.log(s);

/** the W1 units a map (object) gives to the server */
const serverOwned = (map) => W1.filter((u) => map && map.units && map.units[u] === "server");
function vpsMapUnits() {
  const r = SSH(`cat ${q(RD + "/host-ownership.json")} 2>/dev/null || echo ABSENT`);
  if (!r.ok) throw new Error(`reading the VPS map failed (exit ${r.status}) — REFUSED (an unreadable map is never read as 'home')`);
  const t = String(r.out).trim(); if (t === "ABSENT") return null;
  try { return JSON.parse(t); } catch { throw new Error("the VPS map does not parse — REFUSED"); }
}
function unitsCommand(units) { return `sudo -n systemctl disable --now ${units.filter((u) => u.endsWith(".timer")).join(" ")} >/dev/null 2>&1 || true; sudo -n systemctl stop ${units.filter((u) => u.endsWith(".service")).join(" ")} >/dev/null 2>&1 || true; for u in ${units.join(" ")}; do sudo -n rm -f -- ${SYSD}/$u; done; sudo -n systemctl daemon-reload && sudo -n systemctl reset-failed ${units.filter((u) => u.endsWith(".service")).join(" ")} >/dev/null 2>&1; echo REMOVED`; }
function shadow({ dry = false } = {}) {
  log(`== --shadow: ${SHADOW_UNITS.join(", ")} stopped, disabled, removed; ${SHADOW_ROOT} deleted`);
  if (dry) { log("   (dry: nothing done)"); return 0; }
  must(SSH(unitsCommand(SHADOW_UNITS)), "remove the shadow units");
  must(SSH(`case ${q(SHADOW_ROOT)} in /home/traids/w1-shadow) rm -rf -- ${q(SHADOW_ROOT)} && echo GONE;; *) exit 3;; esac`), "delete the shadow tree");
  const left = must(SSH(`ls ${SHADOW_UNITS.map((u) => SYSD + "/" + u).join(" ")} 2>/dev/null | wc -l; test -e ${q(SHADOW_ROOT)} && echo TREE || echo NOTREE`), "verify").trim().split("\n");
  if (left[0] !== "0" || left[1] !== "NOTREE") throw new Error("verification failed: " + left.join(" "));
  log("   done: no shadow unit file, no shadow tree");
  return 0;
}
function server({ dry = false } = {}) {
  let hm = null; try { hm = JSON.parse(fs.readFileSync(path.join(PS.HOME_DATA, "host-ownership.json"), "utf8")); } catch { hm = null; }
  const hs = serverOwned(hm), vs = serverOwned(vpsMapUnits());
  if (hs.length || vs.length) throw new Error(`REFUSED: ${[...new Set([...hs, ...vs])].join(", ")} server-owned (home map: ${hs.join(", ") || "none"}; VPS map: ${vs.join(", ") || "none"}) — run node deploy/server/own.cjs w1 home first`);
  let st = {}; try { st = JSON.parse(fs.readFileSync(path.join(HERE, "deploy-state.json"), "utf8")).steps || {}; } catch { st = {}; }
  const sent = (st.copy && st.copy.shas) || {};
  const cur = PS.remoteShas(SSH, RB, COPIED), remove = COPIED.filter((f) => cur.get(f) && cur.get(f) === sent[f]), keep = COPIED.filter((f) => cur.get(f) && cur.get(f) !== sent[f]);
  log(`== --server: the shadow, then ${REAL_UNITS.join(", ")} disabled and removed; scripts removed: ${remove.join(", ") || "none"}${keep.length ? `; KEPT (not the copy this package sent): ${keep.join(", ")}` : ""}`);
  if (dry) { log("   (dry: nothing done)"); return 0; }
  shadow();
  must(SSH(unitsCommand(REAL_UNITS)), "remove the real W1 units");
  if (remove.length) must(SSH(`cd ${q(RB)} || exit 7; rm -f -- ${remove.map(q).join(" ")}; echo RM`), "remove the copied scripts");
  const left = must(SSH(`ls ${REAL_UNITS.map((u) => SYSD + "/" + u).join(" ")} 2>/dev/null | wc -l; systemctl list-timers 'traids-w1*' --no-pager 2>/dev/null | grep -c traids-w1 || true; systemctl is-active traids-r309.timer`), "verify").trim().split("\n");
  if (left[0] !== "0" || left[1] !== "0") throw new Error("verification failed (unit files or timers left): " + left.join(" "));
  log(`   done: no W1 unit file or timer on the VPS; traids-r309.timer ${left[2]} (untouched)`);
  return 0;
}
/** the real W1 unit files still installed on the VPS (fail-closed: an ssh failure throws) */
function installedRealUnits() {
  const r = SSH(`for u in ${REAL_UNITS.join(" ")}; do if [ -e ${SYSD}/$u ]; then echo "HAS $u"; fi; done; echo DONE`);
  if (!r.ok || !/DONE/.test(String(r.out))) throw new Error(`listing the W1 units on the VPS failed (exit ${r.status}) — REFUSED (fail-closed)`);
  return (String(r.out).match(/^HAS \S+/gm) || []).map((l) => l.slice(4));
}
function home({ dry = false, now = Date.now(), procs, vpsGone = false, homeDir = PS.HOME_DATA, root = REPO } = {}) {
  const mr = PS.readMap(path.join(homeDir, "host-ownership.json"));
  if (!mr.ok) throw new Error(`REFUSED: home's ${mr.why} — an unreadable map is never read as "nothing server-owned"; restore backend/data/host-ownership.json first`);
  const hs = serverOwned(mr.map); if (hs.length) throw new Error(`REFUSED: ${hs.join(", ")} server-owned in home's map — run node deploy/server/own.cjs w1 home first (the chain would never run them again)`);
  if (!vpsGone) {
    const vs = serverOwned(vpsMapUnits());
    if (vs.length) throw new Error(`REFUSED: the VPS map still gives ${vs.join(", ")} to the server (the --server-down state: they keep running there), and this step removes own.cjs and the W1 health check, the only tools at home that stop and watch them — run node deploy/server/own.cjs w1 home first (it pushes home's map)`);
    const inst = installedRealUnits();
    if (inst.length) throw new Error(`REFUSED: the real W1 units are still installed on the VPS (${inst.join(", ")}) — run node docs/server/wave1-crypto/rollback.cjs --server first. For a VPS that has really been destroyed: node docs/server/wave1-crypto/rollback.cjs --home --vps-gone`);
    log("   the VPS: its map gives no W1 unit to the server, and no real W1 unit is installed");
  } else log("   --vps-gone: the VPS map and units are NOT checked (only for a VPS that has really been destroyed)");
  let cs = null; try { cs = JSON.parse(fs.readFileSync(path.join(homeDir, "chain-status.json"), "utf8")); } catch { cs = null; }
  const P = procs !== undefined ? procs : OWN.procScan();
  const g = OWN.chainGuard(now, { chainStatus: cs, procs: P }); if (g) throw new Error(g);
  const D = require(path.join(HERE, "deploy.cjs")), b = D.batWindow(now, P); if (b) throw new Error(b);
  log("== --home: home-patch revertAll");
  for (const l of HP.revertAll(root, { dry })) log("   " + l);
  return 0;
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };
  ok("serverOwned: names exactly the W1 units given to the server (r309 never counts)", serverOwned({ units: { r309: "server", "w1-whales": "server", "w1-social": "home" } }).join() === "w1-whales" && serverOwned(null).length === 0);
  const calls = [], fake = (map, okSsh = true) => (s) => { calls.push(s); if (!okSsh) return { ok: false, status: 255, out: "", err: "down" }; if (/cat '.*host-ownership\.json'/.test(s)) return { ok: true, status: 0, out: map == null ? "ABSENT\n" : JSON.stringify(map), err: "" }; return { ok: true, status: 0, out: "", err: "" }; };
  SSH = fake({ schema: "host-ownership-v1", units: { "w1-whales": "server" } });
  let e1 = null; try { const hmFile = path.join(PS.HOME_DATA, "host-ownership.json"); if (!fs.existsSync(hmFile) || serverOwned(JSON.parse(fs.readFileSync(hmFile, "utf8"))).length === 0) server({ dry: true }); else e1 = "REFUSED (home)"; } catch (e) { e1 = e.message; }
  ok("--server: the VPS map gives a W1 unit to the server -> REFUSED (run own.cjs w1 home first)", /REFUSED[^]*w1-whales[^]*own\.cjs w1 home/.test(e1 || ""), e1);
  SSH = fake(null, false); let e2 = null; try { vpsMapUnits(); } catch (e) { e2 = e.message; }
  ok("--server: an unreadable VPS map -> REFUSED (never read as 'home')", /REFUSED/.test(e2 || ""));
  const uc = unitsCommand(SHADOW_UNITS);
  ok("--shadow removes only traids-w1s-* units; --server's unit list is only traids-w1-*; R309 never named", SHADOW_UNITS.length === 6 && SHADOW_UNITS.every((u) => /^traids-w1s-/.test(u)) && REAL_UNITS.length === 6 && REAL_UNITS.every((u) => /^traids-w1-/.test(u)) && !/r309|traids-alert/.test(uc) && !/r309/.test(unitsCommand(REAL_UNITS)));
  ok("the shadow tree deletion is pinned to /home/traids/w1-shadow (a case guard), nothing else", /case '\/home\/traids\/w1-shadow' in \/home\/traids\/w1-shadow\) rm -rf/.test(fs.readFileSync(__filename, "utf8").replace(/\$\{q\(SHADOW_ROOT\)\}/g, "'/home/traids/w1-shadow'")));
  ok("--server removes a copied script only when it is still the copy this package sent (sha in deploy-state.json)", /cur\.get\(f\) === sent\[f\]/.test(fs.readFileSync(__filename, "utf8")));
  // --home, against a temp data dir (never the real map) and a fake VPS; dry, so revertAll only reads
  const os = require("os"), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w1-rollback-")), realLog = log;
  log = () => {};
  try {
    const mapTo = (h) => fs.writeFileSync(path.join(tmp, "host-ownership.json"), JSON.stringify({ schema: "host-ownership-v1", units: { r309: "server", "w1-whales": h, "w1-funding": h, "w1-social": h } }));
    const SAT_1030 = Date.parse("2026-10-10T16:30:00Z"), idle = { ok: true, lines: [], unreadable: 0 };
    const vps = (vmap, units = [], sshOk = true) => (s) => { calls.push(s); if (!sshOk) return { ok: false, status: 255, out: "", err: "down" }; if (/cat '.*host-ownership\.json'/.test(s)) return { ok: true, status: 0, out: vmap == null ? "ABSENT\n" : JSON.stringify(vmap), err: "" }; if (/echo "HAS \$u"/.test(s)) return { ok: true, status: 0, out: units.map((u) => "HAS " + u).join("\n") + "\nDONE\n", err: "" }; return { ok: false, status: 1, out: "", err: "unexpected" }; };
    const H = (o = {}) => { try { home({ dry: true, now: SAT_1030, procs: idle, homeDir: tmp, ...o }); return null; } catch (e) { return e.message; } };
    const vHome = { schema: "host-ownership-v1", units: { "w1-whales": "home", "w1-funding": "home", "w1-social": "home" } };
    fs.writeFileSync(path.join(tmp, "host-ownership.json"), "{ torn"); SSH = vps(vHome);
    ok("--home: home's map unreadable -> REFUSED (never read as 'nothing server-owned')", /REFUSED: home's host-ownership\.json does not parse/.test(H() || ""), H());
    mapTo("server");
    ok("--home: home's map gives W1 to the server -> REFUSED", /server-owned in home's map/.test(H() || ""));
    mapTo("home"); SSH = vps({ schema: "host-ownership-v1", units: { "w1-whales": "server", "w1-funding": "server", "w1-social": "server" } });
    ok("--home after `own.cjs w1 home --server-down` (home says home, the VPS map still says server) -> REFUSED", /the VPS map still gives w1-whales, w1-funding, w1-social to the server/.test(H() || ""), H());
    SSH = vps(vHome, [], false);
    ok("--home: the VPS unreachable -> REFUSED (fail-closed); --vps-gone skips the VPS checks", /REFUSED/.test(H() || "") && H({ vpsGone: true }) === null, H({ vpsGone: true }));
    SSH = vps(vHome, ["traids-w1-whales.service", "traids-w1-whales.timer"]);
    ok("--home: the real units still installed on the VPS -> REFUSED (run --server first)", /still installed on the VPS[^]*rollback\.cjs --server first/.test(H() || ""));
    SSH = vps(vHome, []);
    ok("--home: VPS clean (map home, no unit) -> passes to the guards (Saturday 10:30 MT: in the window) and the dry revert", H() === null, H());
    ok("--home: a running preflight.bat (cmd.exe) -> REFUSED even inside the :20-:50 window", /preflight\.bat is running/.test(H({ procs: { ok: true, lines: ['cmd.exe /c "C:\\x\\automation\\preflight.bat"'], unreadable: 0 } }) || ""));
    ok("--home: a trading day 15:00 MT with no finished chain today -> refused", /due or running/.test(H({ now: Date.UTC(2026, 9, 8, 21, 0) }) || ""));
  } finally { log = realLog; fs.rmSync(tmp, { recursive: true, force: true }); }
  SSH = PS.sshReal("traids");
  console.log(`rollback selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2), modes = a.filter((x) => ["--shadow", "--server", "--home", "--selftest"].includes(x)), bad = a.filter((x) => !["--shadow", "--server", "--home", "--selftest", "--dry", "--vps-gone"].includes(x));
  try {
    if (bad.length || modes.length !== 1 || (a.includes("--vps-gone") && modes[0] !== "--home")) throw Object.assign(new Error("usage: rollback.cjs --shadow | --server | --home [--vps-gone] [--dry] · --selftest   (first: node deploy/server/own.cjs w1 home)"), { code2: true });
    const dry = a.includes("--dry");
    process.exitCode = modes[0] === "--selftest" ? (selftest() ? 0 : 1) : modes[0] === "--shadow" ? shadow({ dry }) : modes[0] === "--server" ? server({ dry }) : home({ dry, vpsGone: a.includes("--vps-gone") });
  } catch (e) { console.error("rollback: " + e.message); process.exitCode = e.code2 ? 2 : 1; }
}
module.exports = { shadow, server, home, serverOwned, unitsCommand };
