#!/usr/bin/env node
/**
 * DEPLOY — W-P remainder + W1 (crypto 24/7 recorders), 2026-10-07 (docs/server/wave1-crypto). Ordered, idempotent; every step re-reads
 * the real state first and skips what is done. Run BY JOSH from the repo root on the PC (server deploys are his). Nothing here places
 * an order, registers anything, or runs a recorder at home; the only runs on the VPS are selftests and the gate proof (below).
 *
 *   node docs/server/wave1-crypto/deploy.cjs                    precheck, copy, seeds, units-shadow, home — in that order
 *   node docs/server/wave1-crypto/deploy.cjs --step <name>      one step: precheck | copy | seeds | units-shadow | home
 *   node docs/server/wave1-crypto/deploy.cjs --step seeds --reseed-shadow   start the shadow over (deletes ONLY the shadow tree's W1 files)
 *   node docs/server/wave1-crypto/deploy.cjs --cutover          SEPARATE and explicit: `node deploy/server/own.cjs w1 server`, refused
 *                                                               until copy / seeds / units-shadow / home are recorded ok
 *   node docs/server/wave1-crypto/deploy.cjs --status           read-only: every step, both maps, units, the shadow's last runs
 *   node docs/server/wave1-crypto/deploy.cjs --selftest         pure parts; no ssh
 * No --dry: it and any unknown argument are refused (exit 2) before anything runs (a flag this script ignored would mean "do it").
 * Every guard read over ssh is FAIL-CLOSED: an ssh failure refuses; it is never read as "absent" or "nothing there".
 *
 * STEPS
 *   precheck      read-only. Refuses on: a W1 script at home that is not the reviewed version (SCRIPT_PINS — re-pin after a review);
 *                 any home file the package edits in DRIFT (an anchor not found exactly once); the staged manifests / shadow units not
 *                 what their generators make; home r309-HALT missing; the staged selftests failing; on the VPS: not user traids, node
 *                 not v24, no flock / sudo -n / GNU tar, systemd < 243 (ExecCondition), lib/atomic-write.js differing from home's,
 *                 traids-alert@.service or traids-alert.cjs missing, an installed W1 unit that is neither absent nor the staged copy.
 *   copy          the four W1 scripts (home's reviewed bytes) + w1-run.cjs, own-check.cjs, w1-probe.cjs -> /home/traids/traids/backend;
 *                 the same scripts + w1-run.cjs + lib/atomic-write.js + package.json -> the SHADOW tree /home/traids/w1-shadow/backend.
 *                 sha256-verified; then on the VPS: own-check / w1-run / w1-probe --selftest, r323 --selftest (temp dir), node --check
 *                 of the three recorders in both trees. The recorders are never run here.
 *   seeds         home's current W1 files -> the SHADOW tree's data dir, validated first (the shadow's copy must be a prefix / subset of
 *                 home's), each unit under its shadow lock; risk-policy.json read-only; a seed marker w1-shadow-seeded.json (time, R323
 *                 ledger rows, the funding store's newest period) for compare-w1.cjs. Refused once the shadow has run (its files would be
 *                 overwritten) unless --reseed-shadow.
 *                 The REAL data dir is seeded at the cutover by own.cjs (fresh: the shadow nights move home's files on).
 *   units-shadow  home map backend/data/host-ownership.json created if absent (every W1 unit "home", r309 "server") and pushed to the
 *                 VPS read-only (root:root 0444) when the VPS has none; the 12 units (traids-w1-* real, gated "server"; traids-w1s-*
 *                 shadow, gated "home") installed root:root 0644, systemd-analyze verify, daemon-reload, the six timers enabled. GATE
 *                 PROOF: each REAL unit is started once — its ExecCondition must skip it (Result=exec-condition) and no w1-run stamp may
 *                 appear in the real data dir; own-check must say "run" for the shadow side. Shadow units are NOT started by hand (their
 *                 first run is the 10-08 schedule, so a shadow night is a real night).
 *                 ONLY WHILE EVERY W1 UNIT IS HOME-OWNED (both maps): once W1 is server-owned a start would RUN the real recorders
 *                 off-slot, so a re-run after the cutover checks / installs only the real units and SKIPS the gate proof (and copy and
 *                 seeds leave the shadow alone). Deploy stays safe to re-run at any time.
 *   home          refused while the close chain is due or running (trading day 14:00 MT until chain-status.json shows today's finish, or
 *                 a close-chain.cjs / daily-close.bat process) and outside the preflight.bat edit window (:20-:50 past an hour, or
 *                 after 18:00 MT, and never while a preflight.bat process is running — M6).
 *                 home-patch.cjs applyAll (anchored edits + new files, node --check), then the installed pull-server (all W1 home-owned:
 *                 no ssh, exit 0), the installed pull-server / own selftests, and lib/w1-health.cjs, which must PASS ("W1 runs at home")
 *                 for the step to be recorded.
 *   On a failure deploy prints the steps that remain, in order.
 * Exit 0 ok · 1 a step failed or refused · 2 bad arguments (nothing done).
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", "..");
const PS = require(path.join(HERE, "pull-server.cjs")), OWN = require(path.join(HERE, "own.cjs")), HP = require(path.join(HERE, "home-patch.cjs")), UN = require(path.join(HERE, "units.cjs")), OC = require(path.join(HERE, "backend", "own-check.cjs"));
const { sha, q } = PS;
const HOST = "traids", RB = "/home/traids/traids/backend", RD = RB + "/data", SB = UN.SHADOW_B, SBD = SB + "/data", SYSD = "/etc/systemd/system";
const STATE = path.join(HERE, "deploy-state.json");
const M = PS.loadManifest("w1", path.join(HERE, "manifests"));
/** the reviewed W1 scripts (sha256 at staging, 2026-10-07). A home edit of any of them refuses the deploy until reviewed and re-pinned. */
const SCRIPT_PINS = {
  "hyperliquid-whales-record.js": "6ad72554bb3452ca3ede23f6feb66c75475dbb88bb01bed84915e12b4304f741",
  "r323-hl-copy-leaders.js": "9c2c556b9e03d487ce284000bc9ec8327d7475f5676f8c96ab006f23a424c2e1",
  "funding-carry-v2.js": "90c13e1933f433f424a27e66cb4f99ea2a06f2e50da11ce65ae738277f26792e",
  "social-mentions-record.js": "c47b8502a4752c5bc0eb96336d2a6e53835bf7e7eb398ac602d2ba82e9fb422c",
};
const SERVER_SCRIPTS = ["w1-run.cjs", "own-check.cjs", "w1-probe.cjs"];
const REAL_UNITS = ["whales", "funding", "social"].map((x) => `traids-w1-${x}.service`), TIMERS = UN.ALL_UNITS.filter((u) => u.endsWith(".timer"));

// ── ssh plumbing (fail-closed) ───────────────────────────────────────────────────────────────────────────────────────────────
const sshReal = PS.sshReal(HOST);
let SSH = sshReal;
function must(r, what) { if (!r.ok) throw new Error(`${what} failed (exit ${r.status}): ${String(r.err || r.out).trim().slice(0, 400)}`); return String(r.out); }
const ssh = (script, o) => SSH(script, o);
function uploadFiles(dir, files) { const r = PS.pushRemote(SSH, dir, files, { lock: null }); if (r.busy) throw new Error("upload: busy"); const after = PS.remoteShas(SSH, dir, files.map((f) => f.rel)); for (const f of files) if (after.get(f.rel) !== sha(f.data)) throw new Error(`${dir}/${f.rel}: not what was uploaded`); return r.pushed; }

// ── state ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return { steps: {} }; } };
function record(step, obj) { const st = readState(); st.steps = st.steps || {}; st.steps[step] = { at: new Date().toISOString(), ...obj }; require(path.join(REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic(STATE, st); }
const log = (s) => console.log(s);

// ── pure helpers (selftested) ────────────────────────────────────────────────────────────────────────────────────────────────
/** M6: preflight.bat may be edited only between :20 and :50 past an hour, or after 18:00 MT (cmd reads a .bat while it runs) — AND never
 *  while a preflight.bat is running (a 16:00 fire's self-heal replays can run past :20, and fires also start off-schedule, e.g. 17:58 on
 *  10-06). procs: a process scan (own.cjs procScan) — positive evidence only: a failed scan leaves the clock window as the guard. */
function batWindow(nowMs, procs = null) {
  const P = OWN.normProcs(procs), hit = P.lines.filter((l) => /preflight\.bat/i.test(l));
  if (procs != null && hit.length) return `a preflight.bat is running (${hit[0].trim().slice(0, 100)}) — cmd reads a .bat while it runs; wait until it has finished (M6)`;
  const t = OWN.mtParts(nowMs); return t.hour >= 18 || (t.minute >= 20 && t.minute <= 50) ? null : `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")} MT is outside the preflight.bat edit window (:20-:50 past an hour, or after 18:00 MT — M6)`;
}
/** the W1 units home's map gives to the server ([] when the map is absent or every unit is home-owned); throws on an unreadable map */
function w1ServerOwned() {
  const f = path.join(PS.HOME_DATA, "host-ownership.json"); if (!fs.existsSync(f)) return [];
  const mr = PS.readMap(f); if (!mr.ok) throw new Error(mr.why + " — the master map must be readable; REFUSED");
  return Object.keys(M.units).filter((u) => mr.map.units[u] === "server");
}
/** the newest funding period (ms) in home's store, for the seed marker (compare-w1 judges only periods after it) */
function fundingNewest(dir = PS.HOME_DATA) { let s = null; try { s = JSON.parse(fs.readFileSync(path.join(dir, "funding-carry-store.json"), "utf8")); } catch { return null; } let n = null; for (const m of Object.values((s && s.periods) || {})) for (const k of Object.keys(m || {})) { const t = Number(k); if (Number.isFinite(t) && (n == null || t > n)) n = t; } return n; }
function homeScripts() { return Object.keys(SCRIPT_PINS).map((f) => { const p = path.join(REPO, "backend", f), b = fs.existsSync(p) ? fs.readFileSync(p) : null; return { f, data: b, ok: b && sha(b) === SCRIPT_PINS[f], sha: b ? sha(b) : null }; }); }
function stagedUnits() { return Object.fromEntries(UN.ALL_UNITS.map((u) => [u, fs.readFileSync(path.join(HERE, "systemd", u))])); }
/** generator checks: the manifests and shadow units on disk are exactly what manifests.cjs / units.cjs make */
function generatorsOk() {
  const MAN = require(path.join(HERE, "manifests.cjs")).ALL, bad = [];
  for (const [k, v] of Object.entries(MAN)) { let cur = null; try { cur = JSON.parse(fs.readFileSync(path.join(HERE, "manifests", k + ".json"), "utf8")); } catch { cur = null; } if (!cur || JSON.stringify(cur) !== JSON.stringify(v)) bad.push(`manifests/${k}.json`); }
  for (const [f, t] of Object.entries(UN.expected())) { let cur = null; try { cur = fs.readFileSync(path.join(HERE, "systemd", f), "utf8"); } catch { cur = null; } if (cur !== t) bad.push(`systemd/${f}`); }
  return bad;
}

// ── steps ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function precheck({ quick = false } = {}) {
  log("== 0 precheck (read-only)");
  const hs = homeScripts(), off = hs.filter((x) => !x.ok);
  if (off.length) throw new Error("W1 scripts at home differ from the reviewed versions — REFUSED: " + off.map((x) => `${x.f} ${x.sha ? x.sha.slice(0, 12) : "missing"} (pinned ${SCRIPT_PINS[x.f].slice(0, 12)})`).join(", ") + ". Review the change, then re-pin SCRIPT_PINS in deploy.cjs.");
  log("   home W1 scripts: the four reviewed versions (pinned sha256)");
  const drift = HP.ALL().map((e) => ({ e, s: HP.stateOf(e) })).filter((x) => x.s.state === "drift");
  if (drift.length) throw new Error("home files drifted (an anchor not found exactly once) — REFUSED: " + drift.map((x) => x.s.why).join(" | "));
  log(`   home files: every edit anchor found exactly once (${HP.ALL().filter((e) => HP.stateOf(e).state === "applied").length} of ${HP.ALL().length} entries already applied)`);
  const gen = generatorsOk(); if (gen.length) throw new Error("staged files differ from their generators — REFUSED: " + gen.join(", ") + " (node manifests.cjs --write / units.cjs --write, then review)");
  if (!fs.existsSync(path.join(REPO, "backend", "data", "r309-HALT"))) throw new Error("home backend/data/r309-HALT is missing — REFUSED");
  log("   staged manifests + shadow units = their generators; home r309-HALT present");
  if (!quick) {
    const r = cp.spawnSync(process.execPath, [path.join(HERE, "selftest.cjs")], { encoding: "utf8", timeout: 900000, windowsHide: true });
    if (r.status !== 0) throw new Error("staged selftests FAILED — REFUSED:\n" + String(r.stdout).split("\n").filter((l) => /FAIL|ALL|SELFTEST/.test(l)).join("\n"));
    log("   staged selftests: " + (String(r.stdout).trim().split("\n").pop() || ""));
  }
  const f = must(ssh(`set -u; whoami; /usr/local/bin/node -v; command -v flock; sudo -n true && echo SUDO_OK; tar --version | head -1; systemctl --version | head -1; test -d ${q(RB)} && echo BACKEND_OK; test -f ${q(RB + "/traids-alert.cjs")} && echo ALERT_OK; test -f ${SYSD}/traids-alert@.service && echo ALERT_UNIT_OK; date -u +%s`), "ssh traids");
  for (const want of ["traids", "v24.", "/usr/bin/flock", "SUDO_OK", "GNU tar", "BACKEND_OK", "ALERT_OK", "ALERT_UNIT_OK"]) if (!f.includes(want)) throw new Error(`VPS precondition missing: ${want} (got ${f.replace(/\s+/g, " ").slice(0, 240)})`);
  const sv = Number((/systemd (\d+)/.exec(f) || [])[1]); if (!(sv >= 243)) throw new Error(`VPS systemd ${sv || "?"} < 243: no ExecCondition — REFUSED`);
  const skew = Math.abs(Number(f.trim().split("\n").pop()) * 1000 - Date.now()); if (!(skew < 5 * 60000)) throw new Error(`VPS clock differs from this PC by ${Math.round(skew / 1000)} s — REFUSED`);
  log(`   VPS: traids, node ${(/v24\.\S+/.exec(f) || [""])[0]}, flock, sudo -n, GNU tar, systemd ${sv}, traids-alert present, clock within ${Math.round(skew / 1000)} s`);
  const aw = PS.remoteShas(SSH, RB, ["lib/atomic-write.js"]).get("lib/atomic-write.js");
  if (aw !== sha(fs.readFileSync(path.join(REPO, "backend", "lib", "atomic-write.js")))) throw new Error(`VPS lib/atomic-write.js (${String(aw).slice(0, 12)}) differs from home's — REFUSED`);
  const us = PS.remoteShas(SSH, SYSD, UN.ALL_UNITS), staged = stagedUnits(), badU = UN.ALL_UNITS.filter((u) => us.get(u) && us.get(u) !== sha(staged[u]));
  if (badU.length) throw new Error(`VPS units neither absent nor the staged copy — REFUSED (drift): ${badU.join(", ")}`);
  log(`   VPS lib/atomic-write.js = home's; W1 units: ${UN.ALL_UNITS.filter((u) => us.get(u)).length} of ${UN.ALL_UNITS.length} installed (each the staged copy)`);
  const w = must(ssh(`cd ${q(RD)} && for p in hyperliquid-whales social-mentions r323-ledger.jsonl r323-state.json funding-carry-store.json risk-policy.json host-ownership.json; do [ -e "$p" ] && echo "real-has $p"; done; test -d ${q(SBD)} && echo SHADOW_DATA; test -f ${q(SBD + "/w1-shadow-seeded.json")} && echo SHADOW_SEEDED; ls ${q(SBD)}/w1-run-*.json 2>/dev/null | sed 's#.*/#shadow-ran #'; true`), "VPS W1 state");
  log(`   VPS W1 state: ${w.trim().replace(/\n/g, " · ") || "nothing yet (no W1 file in the real data dir, no shadow tree)"}`);
}
function stepCopy() {
  log("== 1 copy (W1 scripts -> the real tree and the shadow tree on the VPS)");
  const hs = homeScripts(); if (hs.some((x) => !x.ok)) throw new Error("home W1 scripts are not the reviewed versions — run --step precheck");
  const owned = w1ServerOwned(), withShadow = !owned.length;   // after a cutover the shadow is never re-created (it would only skip itself)
  const real = [...hs.map((x) => ({ rel: x.f, data: x.data, mode: "0644" })), ...SERVER_SCRIPTS.map((f) => ({ rel: f, data: fs.readFileSync(path.join(HERE, "backend", f)), mode: "0644" }))];
  const shadow = [...hs.map((x) => ({ rel: x.f, data: x.data, mode: "0644" })), { rel: "w1-run.cjs", data: fs.readFileSync(path.join(HERE, "backend", "w1-run.cjs")), mode: "0644" },
    { rel: "lib/atomic-write.js", data: fs.readFileSync(path.join(REPO, "backend", "lib", "atomic-write.js")), mode: "0644" }, { rel: "package.json", data: Buffer.from('{\n "type": "commonjs"\n}\n'), mode: "0644" }];
  if (withShadow) must(ssh(`mkdir -p ${q(SB + "/lib")} ${q(SBD)} && test -d ${q(RB)} && echo OK`), "mkdir shadow tree");
  else log(`   W1 is server-owned (${owned.join(", ")}): the shadow tree is not touched or re-created`);
  for (const [dir, files, name] of [[RB, real, "real"], ...(withShadow ? [[SB, shadow, "shadow"]] : [])]) {
    const cur = PS.remoteShas(SSH, dir, files.map((f) => f.rel)), todo = files.filter((f) => cur.get(f.rel) !== sha(f.data));
    if (todo.length) uploadFiles(dir, todo);
    log(`   ${name} tree ${dir}: ${todo.length ? `${todo.length} file(s) uploaded and verified (${todo.map((f) => f.rel).join(", ")})` : "already current"}${files.length - todo.length && todo.length ? `, ${files.length - todo.length} already current` : ""}`);
  }
  const trees = withShadow ? [RB, SB] : [RB], want = trees.length * 5;
  const t = ssh([`set -o pipefail`, `cd ${q(RB)}`, `for s in own-check.cjs w1-run.cjs w1-probe.cjs; do /usr/local/bin/node "$s" --selftest 2>&1 | tail -n 1; done`,
    `/usr/local/bin/node r323-hl-copy-leaders.js --selftest > /tmp/w1-r323-selftest.$$ 2>&1; rc=$?; grep -m1 '"selftest"' /tmp/w1-r323-selftest.$$; rm -f /tmp/w1-r323-selftest.$$; echo "r323 selftest exit $rc"`,
    `for d in ${trees.map(q).join(" ")}; do for s in hyperliquid-whales-record.js funding-carry-v2.js social-mentions-record.js r323-hl-copy-leaders.js w1-run.cjs; do /usr/local/bin/node --check "$d/$s" && echo "check ok $d/$s"; done; done`].join("\n"), { timeout: 600000 });
  const out = String(t.out);
  const sts = ["own-check selftest:", "w1-run selftest:", "w1-probe selftest:"].map((p) => new RegExp(p.replace(/[-]/g, "\\-") + " \\d+ passed, 0 failed").test(out));
  const r323 = /"selftest": "PASS"/.test(out) && /r323 selftest exit 0/.test(out), checks = (out.match(/^check ok /gm) || []).length;
  if (!sts.every(Boolean) || !r323 || checks !== want) throw new Error(`VPS selftests / checks FAILED (own-check ${sts[0]}, w1-run ${sts[1]}, w1-probe ${sts[2]}, r323 ${r323}, node --check ${checks}/${want}):\n${out.slice(-1200)}`);
  log(`   VPS: own-check (incl. its ExecCondition wrapper under /bin/sh), w1-run, w1-probe --selftest passed; r323 --selftest PASS; node --check ${checks}/${want} (the recorders are never run here)`);
  record("copy", { ok: true, shas: Object.fromEntries(real.map((f) => [f.rel, sha(f.data)])) });
}
function stepSeeds({ reseed = false } = {}) {
  log("== 2 seeds (home's W1 files -> the SHADOW tree's data dir)");
  const owned = w1ServerOwned();
  if (owned.length) { log(`   W1 is server-owned (${owned.join(", ")}): the shadow is not re-seeded (the real data dir is seeded only by own.cjs at a cutover)`); return; }
  const ran = must(ssh(`cd ${q(SBD)} || exit 7; ls w1-run-*.json 2>/dev/null; test -f w1-shadow-seeded.json && echo SEEDED; true`), "shadow state").trim().split("\n").filter(Boolean);
  const hasRun = ran.some((l) => /^w1-run-/.test(l));
  if (hasRun && !reseed) { log(`   the shadow has already run (${ran.filter((l) => /^w1-run-/.test(l)).join(", ")}) — not re-seeded (that would overwrite its nights). To start the shadow over: --step seeds --reseed-shadow`); return; }
  if (reseed) {
    const paths = [...new Set(Object.values(M.units).flatMap((d) => d.entries.map((e) => e.path))), "w1-shadow-seeded.json"];
    if (!SBD.startsWith("/home/traids/w1-shadow/") || paths.some((p) => !/^[A-Za-z0-9_][A-Za-z0-9._\/-]*$/.test(p) || p.includes(".."))) throw new Error("reseed: refusing an unexpected path");
    must(ssh(`cd ${q(SBD)} || exit 7; rm -rf -- ${paths.map(q).join(" ")}; echo CLEARED`), "clear the shadow tree's W1 files");
    log(`   --reseed-shadow: the shadow tree's W1 files removed (${SBD} only)`);
  }
  let n = 0;
  for (const [u, def] of Object.entries(M.units)) {
    const ents = PS.seedEntries(def), f = PS.fetchRemote(SSH, SBD, ents, { lock: def.lock, lockWait: 120 });
    if (f.busy) throw new Error(`${u}: the shadow unit holds its lock — try again in a few minutes`);
    const plan = PS.checkGrowth(ents, f.files, PS.readLocal(ents, PS.HOME_DATA), { mode: "seed" });
    const ins = PS.inputEntries(def), insLocal = PS.readLocal(ins, PS.HOME_DATA);
    for (const e of ins) if (!insLocal.has(e.path)) throw new Error(`${u}: input ${e.path} missing at home`);
    const files = [...plan.filter((p) => p.changed).map((p) => ({ rel: p.rel, data: p.data, mode: "0644" })), ...ins.map((e) => ({ rel: e.path, data: insLocal.get(e.path), mode: e.mode || "0444" }))];
    const r = PS.pushRemote(SSH, SBD, files, { lock: def.lock, lockWait: 120 }); if (r.busy) throw new Error(`${u}: the shadow unit holds its lock`);
    const after = files.length ? PS.remoteShas(SSH, SBD, files.map((x) => x.rel)) : new Map();
    for (const x of files) if (after.get(x.rel) !== sha(x.data)) throw new Error(`${u}: ${x.rel} in the shadow tree is not what was pushed`);
    n += files.length; log(`   ${u}: ${plan.length} file(s) validated, ${files.length} pushed and verified`);
  }
  let rows = 0; try { rows = fs.readFileSync(path.join(PS.HOME_DATA, "r323-ledger.jsonl"), "utf8").split("\n").filter((l) => l.trim()).length; } catch { rows = 0; }
  const fNewest = fundingNewest();
  const marker = { at: new Date().toISOString(), by: "docs/server/wave1-crypto/deploy.cjs --step seeds", r323LedgerRows: rows, fundingNewestT: fNewest, note: "compare-w1.cjs counts a shadow file as a shadow night only when it was recorded after this time, an R323 row only past r323LedgerRows, and a funding period only when newer than fundingNewestT" };
  uploadFiles(SBD, [{ rel: "w1-shadow-seeded.json", data: Buffer.from(JSON.stringify(marker, null, 1)), mode: "0644" }]);
  log(`   seed marker w1-shadow-seeded.json at ${marker.at} (R323 ledger rows at seed: ${rows}; funding store's newest period ${fNewest ? new Date(fNewest).toISOString() : "none"})`);
  record("seeds", { ok: true, files: n, seededAt: marker.at });
}
function stepUnitsShadow() {
  log("== 3 units-shadow (ownership map + the 12 W1 units; real units gated 'server', shadow units gated 'home')");
  const mapFile = path.join(PS.HOME_DATA, "host-ownership.json");
  let mr = PS.readMap(mapFile);
  if (!mr.ok && !fs.existsSync(mapFile)) { OWN.writeMap(mapFile, OWN.initialMap()); mr = PS.readMap(mapFile); log("   home map backend/data/host-ownership.json created (r309 server; w1-whales, w1-funding, w1-social home)"); }
  if (!mr.ok) throw new Error(mr.why + " — fix it by hand (it is the master map); REFUSED");
  for (const u of Object.keys(M.units)) if (!(u in mr.map.units)) throw new Error(`home map does not name ${u} — REFUSED`);
  const srv = PS.remoteShas(SSH, RD, ["host-ownership.json"]).get("host-ownership.json");
  if (!srv) { if (OWN.pushMap(SSH, RD, mr.buf, null) !== "pushed") throw new Error("pushing the map to the VPS did not land (sudo -n chown / chmod?) — nothing installed"); log(`   VPS map pushed (root:root 0444, read back: sha ${mr.sha.slice(0, 12)} = home's)`); }
  else if (srv !== mr.sha) throw new Error(`the VPS map (${srv.slice(0, 12)}) differs from home's (${mr.sha.slice(0, 12)}) — only own.cjs changes it: node deploy/server/own.cjs --status w1`);
  else log("   VPS map = home's — unchanged");
  // the gate proof below STARTS the real units: it is meaningful — and safe — only while every W1 unit is home-owned (both maps equal,
  // checked above). After a cutover a start would RUN the real recorders off-slot (review 2026-10-07): no proof, no shadow re-install.
  const owned = Object.keys(M.units).filter((u) => mr.map.units[u] === "server"), homeOwned = !owned.length;
  const want = homeOwned ? UN.ALL_UNITS : UN.ALL_UNITS.filter((u) => !/^traids-w1s-/.test(u)), timers = want.filter((u) => u.endsWith(".timer"));
  if (!homeOwned) log(`   W1 is server-owned (${owned.join(", ")}): only the real units are checked; the shadow units are not re-installed and the gate proof is SKIPPED (it was proved at the original deploy; starting a real unit now would run it)`);
  const staged = stagedUnits(), cur = PS.remoteShas(SSH, SYSD, UN.ALL_UNITS), todo = want.filter((u) => cur.get(u) !== sha(staged[u]));
  const drift = todo.filter((u) => cur.get(u)); if (drift.length) throw new Error(`installed units differ from the staged copies — REFUSED (drift): ${drift.join(", ")}`);
  for (const u of todo) {
    const s = sha(staged[u]), script = [`set -eu`, `t=${q(SYSD + "/." + u + ".w1-")}$$`, `sudo -n tee "$t" > /dev/null`, `s=$(sudo -n sha256sum "$t" | cut -c1-64)`, `if [ "$s" != "${s}" ]; then sudo -n rm -f "$t"; echo "sha256 mismatch" >&2; exit 9; fi`, `sudo -n chmod 644 "$t"`, `sudo -n chown root:root "$t"`, `sudo -n mv -f "$t" ${q(SYSD + "/" + u)}`, `echo installed`].join("\n");
    must(ssh(script, { input: staged[u] }), "install " + u);
  }
  log(`   units: ${todo.length ? `${todo.length} installed root:root 0644` : `all ${want.length} already installed`} (${want.length - todo.length} already current)`);
  must(ssh(`systemd-analyze verify ${want.map((u) => `${SYSD}/${u}`).join(" ")}`), "systemd-analyze verify");
  must(ssh(`sudo -n systemctl daemon-reload && sudo -n systemctl enable --now ${timers.join(" ")} >/dev/null 2>&1 && echo ENABLED`), "daemon-reload / enable timers");
  const tst = must(ssh(timers.map((t) => `echo "${t} $(systemctl is-enabled ${t}) $(systemctl is-active ${t})"`).join("; ")), "timer state");
  const bad = timers.filter((t) => !new RegExp(`^${t.replace(/\./g, "\\.")} enabled active$`, "m").test(tst)); if (bad.length) throw new Error("timers not enabled+active: " + bad.join(", ") + "\n" + tst);
  log(`   ${timers.length} timers enabled + active; next: ` + must(ssh("systemctl list-timers 'traids-w1*' --no-pager | sed -n '2,7p'"), "list-timers").trim().split("\n").map((l) => l.replace(/\s+/g, " ").slice(0, 70)).join(" | "));
  if (!homeOwned) { record("units-shadow", { ok: true, installed: todo.length, gateProof: "skipped (server-owned)" }); return; }
  // GATE PROOF (home-owned only, re-checked on the map read above): each REAL unit started once -> its ExecCondition skips it; no run
  // stamp appears in the real data dir
  { const pg = proofGuard(PS.readMap(mapFile), M); if (pg) throw new Error(pg); }
  const proof = must(ssh([...REAL_UNITS.map((u) => `sudo -n systemctl start ${u}; echo "${u} start=$? $(systemctl show ${u} -p Result --value)"`), `ls ${q(RD)}/w1-run-*.json 2>/dev/null | wc -l | sed 's/^/stamps=/'`].join("; "), { timeout: 300000 }), "gate proof");
  // judged on what matters: systemd recorded the start as skipped by the condition (Result=exec-condition) and w1-run.cjs never ran (no
  // stamp in the real data dir). systemctl start's own exit code for a condition-skipped oneshot is printed but not relied on.
  const skipped = REAL_UNITS.every((u) => new RegExp(`^${u.replace(/\./g, "\\.")} start=\\d+ exec-condition$`, "m").test(proof)), stamps = Number((/stamps=(\d+)/.exec(proof) || [])[1]);
  // (the map said home for every W1 unit when the proof ran — checked just above — so disabling the real timers stops nothing that records)
  if (!skipped || stamps !== 0) { ssh(`sudo -n systemctl reset-failed ${REAL_UNITS.join(" ")} 2>/dev/null || true`); throw new Error(`GATE PROOF FAILED — a real unit was not skipped by its ExecCondition while home-owned (or a run stamp appeared):\n${proof}\nW1 is home-owned, so the real timers record nothing yet — disable them now: ssh traids sudo systemctl disable --now ${TIMERS.filter((t) => !/w1s-/.test(t)).join(" ")}`); }
  const oc = OWN.ownChecks(SSH, Object.keys(M.units), "home"); if (Object.values(oc).some((c) => c !== 0)) throw new Error("own-check does not say run for the shadow side: " + JSON.stringify(oc));
  log("   GATE PROOF: each real unit started once and skipped by its ExecCondition (Result=exec-condition), no run stamp in the real data dir; own-check says the shadow units run");
  record("units-shadow", { ok: true, installed: todo.length, gateProof: true });
}
/** null when the gate proof may start the real units: home's map readable and EVERY W1 unit home-owned; else why not */
function proofGuard(mr, man) {
  if (!mr || !mr.ok) return `gate proof REFUSED: home's map ${mr ? mr.why : "unreadable"}`;
  const s = Object.keys(man.units).filter((u) => mr.map.units[u] !== "home");
  return s.length ? `gate proof REFUSED: ${s.join(", ")} not home-owned in home's map — starting a real unit would RUN it` : null;
}
function stepHome() {
  log("== 4 home (anchored edits + new files; the chain pulls and skips server-owned steps; preflight / ops-health W1 check)");
  const procs = OWN.procScan();
  let cs = null; try { cs = JSON.parse(fs.readFileSync(path.join(PS.HOME_DATA, "chain-status.json"), "utf8")); } catch { cs = null; }
  const g = OWN.chainGuard(Date.now(), { chainStatus: cs, procs }); if (g) throw new Error(g + " — the home step edits close-chain.cjs (M6)");
  const b = batWindow(Date.now(), procs); if (b) throw new Error(b);
  if (!procs.ok) log("   note: the process scan was unavailable — relying on the chain-status time guard and the clock window");
  if (!PS.readMap(path.join(PS.HOME_DATA, "host-ownership.json")).ok) throw new Error("home map backend/data/host-ownership.json missing or unreadable — run --step units-shadow first (the chain's tagged steps need it)");
  for (const l of HP.applyAll(REPO)) log("   " + l);
  const run = (args, t = 300000) => cp.spawnSync(process.execPath, args, { cwd: REPO, encoding: "utf8", timeout: t, windowsHide: true });
  const p = run([path.join(REPO, "deploy", "server", "pull-server.cjs"), "--wave", "w1"]);
  if (p.status !== 0) throw new Error("the installed pull-server.cjs --wave w1 did not exit 0:\n" + p.stdout + p.stderr);
  log("   installed pull-server --wave w1: " + String(p.stdout).trim().split("\n").map((l) => l.replace(/^\[[^\]]+\] /, "")).join(" · "));
  for (const s of ["pull-server.cjs", "own.cjs"]) { const r = run([path.join(REPO, "deploy", "server", s), "--selftest"], 600000); if (r.status !== 0) throw new Error(`installed deploy/server/${s} --selftest FAILED:\n${String(r.stdout).split("\n").filter((l) => /FAIL|selftest:/.test(l)).join("\n")}`); log(`   installed ${s} --selftest: ${String(r.stdout).trim().split("\n").pop()}`); }
  const h = run([path.join(REPO, "backend", "lib", "w1-health.cjs")], 60000);
  log("   " + String(h.stdout).trim() + ` (exit ${h.status})`);
  if (h.status !== 0) { record("home", { ok: false, health: h.status }); throw new Error("the installed w1-health did not PASS — the home step is NOT recorded as done. Fix and re-run --step home (the patch is idempotent), or undo it: rollback.cjs --home"); }
  record("home", { ok: true, health: "PASS" });
}
function cutover() {
  const st = readState().steps || {}, missing = ["copy", "seeds", "units-shadow", "home"].filter((s) => !(st[s] && st[s].ok));
  if (missing.length) throw new Error(`not deployed: ${missing.join(", ")} not recorded ok — run them first (deploy.cjs --step <name>)`);
  if (HP.ALL().some((e) => HP.stateOf(e).state !== "applied")) throw new Error("the home patch is not fully applied — run --step home");
  log("== CUTOVER: node deploy/server/own.cjs w1 server");
  const r = cp.spawnSync(process.execPath, [path.join(REPO, "deploy", "server", "own.cjs"), "w1", "server"], { cwd: REPO, stdio: "inherit", windowsHide: true });
  if (r.status !== 0) throw new Error(`own.cjs w1 server exited ${r.status} — read its message above (it says which host runs the units now)`);
  record("cutover", { ok: true });
  for (const l of ["Next (Josh):", "  1. node docs/server/wave1-crypto/register-w1.cjs --dry   then without --dry (the governance rows)",
    "  2. Sat 10-10 21:31 UTC: ssh traids 'systemctl list-timers traids-w1*; cat ~/traids/backend/data/w1-run-whales.json'",
    "  3. Mon 10-12: node backend/lib/w1-health.cjs (PASS) · the weekend files at home after the 06:00 MT preflight pull · chain-status.json shows the four steps 'skipped (server-owned)'",
    "  Rollback, one command: node deploy/server/own.cjs w1 home"]) log(l);
}
function status() {
  const st = readState().steps || {};
  for (const k of ["copy", "seeds", "units-shadow", "home", "cutover"]) log(`${k.padEnd(13)} ${st[k] ? `${st[k].ok ? "ok" : "NOT ok"} at ${st[k].at}` : "not run"}`);
  for (const e of HP.ALL()) { const s = HP.stateOf(e); if (s.state !== "applied") log(`home         ${s.state.padEnd(8)} ${e.rel}${s.why ? " — " + s.why : ""}`); }
  log(`home         ${HP.ALL().filter((e) => HP.stateOf(e).state === "applied").length} of ${HP.ALL().length} entries applied`);
  const mr = PS.readMap(path.join(PS.HOME_DATA, "host-ownership.json"));
  log(`map (home)   ${mr.ok ? Object.entries(mr.map.units).map(([u, h]) => `${u}=${h}`).join(" ") + " · sha " + mr.sha.slice(0, 12) : mr.why}`);
  try {
    const s = PS.remoteShas(SSH, RD, ["host-ownership.json"]).get("host-ownership.json");
    log(`map (VPS)    ${s ? s.slice(0, 12) + (mr.ok && s === mr.sha ? " = home's" : " DIFFERS from home's") : "absent"}`);
    const u = must(ssh(UN.ALL_UNITS.filter((x) => x.endsWith(".service")).map((x) => `if [ -f ${SYSD}/${x} ]; then echo "${x} Result=$(systemctl show ${x} -p Result --value) last-exit $(systemctl show ${x} -p ExecMainExitTimestamp --value)"; else echo "${x} not installed"; fi`).concat([`systemctl list-timers 'traids-w1*' --no-pager | sed -n '2,7p'`, `cd ${q(SBD)} 2>/dev/null && for f in w1-run-*.json; do [ -f "$f" ] && /usr/local/bin/node -e 'const j=require("./"+process.argv[1]); console.log("shadow " + process.argv[1] + " " + j.finishedAt + " ok=" + j.ok + " exit=" + j.exit)' "$f"; done; true`]).join("; ")), "VPS state");
    for (const l of u.trim().split("\n")) log("VPS          " + l.replace(/\s+/g, " ").slice(0, 150));
  } catch (e) { log("VPS          unreadable: " + e.message.slice(0, 200)); }
}

// ── args, plan, selftest ─────────────────────────────────────────────────────────────────────────────────────────────────────
const STEPS = ["precheck", "copy", "seeds", "units-shadow", "home"];
function parseArgs(argv) {
  const out = { mode: "deploy", step: null, reseed: false }, modes = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--dry") throw new Error("deploy.cjs has NO dry mode — nothing was done. Use --status (read-only), home-patch.cjs --plan, or own.cjs w1 server --dry");
    if (["--selftest", "--status", "--cutover"].includes(x)) modes.push(x);
    else if (x === "--reseed-shadow") out.reseed = true;
    else if (x === "--step") { const v = argv[++i]; if (!STEPS.includes(v)) throw new Error(`--step needs one of ${STEPS.join(" | ")} (got ${JSON.stringify(v)})`); if (out.step) throw new Error("give --step once"); out.step = v; }
    else throw new Error(`unknown argument ${JSON.stringify(x)} — nothing was done. deploy.cjs takes: --step <${STEPS.join("|")}> [--reseed-shadow] · --cutover · --status · --selftest`);
  }
  if (modes.length > 1 || (modes.length && (out.step || out.reseed))) throw new Error(`give one of --selftest / --status / --cutover on its own (got ${argv.join(" ")}) — nothing was done`);
  if (out.reseed && out.step !== "seeds") throw new Error("--reseed-shadow goes with --step seeds only");
  if (modes.length) out.mode = modes[0].slice(2);
  return out;
}
const planOf = (A) => (A.step ? [A.step] : STEPS.slice(1));
function remainingSteps(plan, failed) {
  const i = failed === "precheck" ? 0 : plan.indexOf(failed), left = i < 0 ? plan : plan.slice(i);
  return ["Fix the cause, then run, in order (each step re-reads the real state and skips what is done):", ...left.map((s) => `  node docs/server/wave1-crypto/deploy.cjs --step ${s}`), "--cutover stays separate and explicit (Fri 10-09 after the home chain)."];
}
function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };
  const P = (s) => { try { return parseArgs(s.split(" ").filter(Boolean)); } catch (e) { return { err: e.message }; } };
  ok("args: --dry refused everywhere (no dry mode); unknown flags and typos refused before anything runs", /NO dry mode/.test(P("--dry").err || "") && /NO dry mode/.test(P("--step home --dry").err || "") && /unknown argument/.test(P("--cutovr").err || "") && /unknown argument/.test(P("--status --force").err || ""));
  ok("args: modes alone; --reseed-shadow only with --step seeds; bad step refused", /on its own/.test(P("--status --cutover").err || "") && /on its own/.test(P("--cutover --step home").err || "") && /goes with --step seeds/.test(P("--reseed-shadow").err || "") && /--step needs/.test(P("--step bogus").err || ""));
  ok("args: the valid forms parse", P("").mode === "deploy" && P("--step units-shadow").step === "units-shadow" && P("--step seeds --reseed-shadow").reseed && P("--cutover").mode === "cutover" && P("--status").mode === "status");
  ok("a failure prints the steps that remain, in order (seeds failed -> seeds, units-shadow, home)", /--step seeds\n\s+node \S+ --step units-shadow\n\s+node \S+ --step home/.test(remainingSteps(planOf({}), "seeds").join("\n")) && !/--step copy/.test(remainingSteps(planOf({}), "seeds").join("\n")));
  const at = (h, m) => Date.UTC(2026, 9, 8, h + 6, m);   // MDT = UTC-6
  ok("M6 window: 09:19 refused, 09:20 ok, 09:50 ok, 09:51 refused, 18:05 ok", batWindow(at(9, 19)) && !batWindow(at(9, 20)) && !batWindow(at(9, 50)) && batWindow(at(9, 51)) && !batWindow(at(18, 5)));
  { const pf = { ok: true, lines: ['cmd.exe /c "C:\\x\\automation\\preflight.bat"'], unreadable: 0 };
    ok("M6: a RUNNING preflight.bat (a 16:00 fire still in self-heal at 16:25, or an off-schedule fire after 18:00) -> refused inside the window; a failed scan leaves the clock window", /preflight\.bat is running/.test(batWindow(at(16, 25), pf) || "") && /preflight\.bat is running/.test(batWindow(at(18, 5), pf) || "") && !batWindow(at(16, 25), { ok: true, lines: ["node backend\\r295-orb-forward.js"], unreadable: 0 }) && !batWindow(at(16, 25), { ok: false, lines: [], unreadable: 0 })); }
  { const map = (h) => ({ ok: true, map: { units: { r309: "server", "w1-whales": h, "w1-funding": "home", "w1-social": "home" } } });
    ok("gate proof guard: runs only while EVERY W1 unit is home-owned; server-owned or an unreadable map -> refused (a start would RUN the real recorder)", proofGuard(map("home"), M) === null && /w1-whales not home-owned/.test(proofGuard(map("server"), M) || "") && /REFUSED/.test(proofGuard({ ok: false, why: "unreadable" }, M) || "")); }
  const units = stagedUnits();
  const realS = REAL_UNITS.map((u) => units[u].toString()), shadowS = ["whales", "funding", "social"].map((x) => units[`traids-w1s-${x}.service`].toString());
  ok("real units (M5): User=traids, TZ, flock -w, OnFailure=traids-alert@%n.service, ExecCondition = own-check <unit> server inside the /bin/sh wrapper (own-check.cjs's conditionCommand: a crash FAILS the unit), w1-run <unit>, NoNewPrivileges", realS.every((t, i) => { const x = ["whales", "funding", "social"][i]; return /^User=traids$/m.test(t) && /^Environment=TZ=America\/Denver$/m.test(t) && /^OnFailure=traids-alert@%n\.service$/m.test(t) && t.split("\n").includes("ExecCondition=" + OC.conditionCommand(`w1-${x}`, "server")) && t.split("\n").filter((l) => /^ExecCondition=/.test(l)).length === 1 &&new RegExp(`^ExecStart=/usr/bin/flock -w 600 /home/traids/traids/backend/data/w1-${x}\\.flock /usr/local/bin/node /home/traids/traids/backend/w1-run\\.cjs w1-${x}$`, "m").test(t) && /^NoNewPrivileges=yes$/m.test(t); }));
  ok("shadow units: the shadow tree, ExecCondition '<unit> home', their own SyslogIdentifier — and nothing else differs (units.cjs)", shadowS.every((t, i) => { const x = ["whales", "funding", "social"][i]; return /^WorkingDirectory=\/home\/traids\/w1-shadow\/backend$/m.test(t) && t.split("\n").includes("ExecCondition=" + OC.conditionCommand(`w1-${x}`, "home")) &&/w1-shadow\/backend\/data\/w1-/.test(t) && !/\/home\/traids\/traids\/backend\/data/.test(t); }) && generatorsOk().length === 0, generatorsOk().join(","));
  const tm = (x, s = "") => units[`traids-w1${s}-${x}.timer`].toString();
  ok("timers: whales 21:30 UTC (Persistent=false), funding 16:30 New York (Persistent=true), social 16:35 New York (Persistent=false); shadow timers the same calendars", /^OnCalendar=\*-\*-\* 21:30:00 UTC$/m.test(tm("whales")) && /^Persistent=false$/m.test(tm("whales")) && /^OnCalendar=\*-\*-\* 16:30:00 America\/New_York$/m.test(tm("funding")) && /^Persistent=true$/m.test(tm("funding")) && /^OnCalendar=\*-\*-\* 16:35:00 America\/New_York$/m.test(tm("social")) && /^Persistent=false$/m.test(tm("social")) && ["whales", "funding", "social"].every((x) => tm(x).match(/^OnCalendar=.*$/m)[0] === tm(x, "s").match(/^OnCalendar=.*$/m)[0]) && tm("whales").split("\n").includes(`OnCalendar=*-*-* ${M.units["w1-whales"].slotUtc}:00 UTC`));
  ok("no unit loads a secret file, escalates or names another user (W1 is keyless)", Object.values(units).every((b) => !/^EnvironmentFile=|^Exec[A-Za-z]*=[-@:|]*[+!]|^User=(?!traids$)|AmbientCapabilities|CapabilityBoundingSet/m.test(b.toString())));
  ok("the four W1 scripts at home are the reviewed versions (SCRIPT_PINS)", homeScripts().every((x) => x.ok), homeScripts().filter((x) => !x.ok).map((x) => x.f).join(","));
  const src = fs.readFileSync(__filename, "utf8").split("function selftest")[0];   // the code, not this test's own patterns
  ok("the gate proof starts only REAL units (never a shadow unit) and requires Result=exec-condition with no run stamp", /REAL_UNITS\.map\(\(u\) => `sudo -n systemctl start \$\{u\}/.test(src) && !/systemctl start traids-w1s/.test(src) && /exec-condition\$/.test(src) && /stamps !== 0/.test(src));
  ok("the gate proof is unreachable once W1 is server-owned: units-shadow returns before it, and the proof re-checks the map right before starting a unit", src.indexOf('if (!homeOwned) { record("units-shadow"') > 0 && src.indexOf('if (!homeOwned) { record("units-shadow"') < src.indexOf("const proof = must(ssh(") && src.indexOf("const pg = proofGuard(") > 0 && src.indexOf("const pg = proofGuard(") < src.indexOf("const proof = must(ssh("));
  ok("deploy never runs a W1 recorder: only --selftest / node --check are run on the VPS", !/node (hyperliquid-whales-record|funding-carry-v2|social-mentions-record)\.js(?! --)/.test(src.replace(/node --check "\$d\/\$s"/g, "")) && !/r323-hl-copy-leaders\.js --(score|read|controls|seal)/.test(src.split("function selftest")[0]));
  console.log(`deploy selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  let A, RUNNING = null;
  try { A = parseArgs(process.argv.slice(2)); } catch (e) { console.error("deploy: " + e.message); process.exitCode = 2; }
  if (A) try {
    if (A.mode === "selftest") process.exitCode = selftest() ? 0 : 1;
    else if (A.mode === "status") { status(); process.exitCode = 0; }
    else if (A.mode === "cutover") { RUNNING = "cutover"; precheck({ quick: true }); cutover(); process.exitCode = 0; }
    else {
      const one = A.step, run = (name, fn) => { RUNNING = name; fn(); };
      run("precheck", () => precheck({ quick: !!one && one !== "precheck" }));
      if (!one || one === "copy") run("copy", stepCopy);
      if (!one || one === "seeds") run("seeds", () => stepSeeds({ reseed: A.reseed }));
      if (!one || one === "units-shadow") run("units-shadow", stepUnitsShadow);
      if (!one || one === "home") run("home", stepHome);
      RUNNING = null;
      log(`deploy: done${one ? ` (step ${one})` : ""}. --cutover is separate and explicit (Fri 10-09, after the home chain, after compare-w1.cjs).`);
      process.exitCode = 0;
    }
  } catch (e) {
    console.error("deploy: " + (RUNNING ? `step ${RUNNING} FAILED — ` : "") + e.message);
    if (A && A.mode === "deploy" && RUNNING) for (const l of remainingSteps(planOf(A), RUNNING)) console.error(l);
    process.exitCode = 1;
  }
}
module.exports = { parseArgs, planOf, remainingSteps, batWindow, proofGuard, fundingNewest, homeScripts, generatorsOk, SCRIPT_PINS, setSsh: (f) => { SSH = f; } };
