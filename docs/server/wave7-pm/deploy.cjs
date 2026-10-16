#!/usr/bin/env node
/**
 * DEPLOY — W7, the prediction-market book recorder for R352 (backend/pm-book-recorder.js), 2026-10-11 (docs/server/wave7-pm).
 * A SERVER-ONLY unit: there is no home version, so no home patch, no shadow, no compare and no cutover. It reuses the standing
 * machinery (deploy/server/pull-server.cjs, own.cjs, own-check.cjs, the ownership map, traids-alert@). Ordered and idempotent: each
 * step re-reads the real state and skips what is done. Run BY JOSH from the repo root on the PC. Nothing here places an order, opens
 * an account, sends a key (the recorder is keyless), reads the test registry, or runs the recorder at home.
 *
 *   node docs/server/wave7-pm/deploy.cjs                    precheck, copy, units — in that order
 *   node docs/server/wave7-pm/deploy.cjs --step <name>      one step: precheck | copy | units | status
 *   node docs/server/wave7-pm/deploy.cjs --status           read-only (the same as --step status)
 *   node docs/server/wave7-pm/deploy.cjs --restart          restart the recorder so it runs the code a later copy step sent (a gap of a
 *                                                           few seconds, which the recorder writes down as a gap)
 *   node docs/server/wave7-pm/deploy.cjs --selftest         pure parts and a fake VPS; no ssh
 * No --dry: it and any unknown argument are refused (exit 2) before anything runs. Every read over ssh is FAIL-CLOSED: an ssh failure
 * refuses; it is never read as "absent". No remote script grows with a file list (w7-lib.cjs chunks them).
 *
 * STEPS
 *   precheck   read-only on both machines. Home: the staged units and manifest equal their generators; the recorder and its library
 *              parse; home's map is readable; the staged selftests pass. VPS: user traids, node v24 or newer, sudo -n, systemd >= 243
 *              (ExecCondition), the backend tree, traids-alert present, own-check.cjs and lib/atomic-write.js equal to home's, the VPS
 *              map equal to home's (or exactly home's plus this unit's own entry: see units, 3), our units absent or the staged copies, the clock within 5 minutes of this PC, and free space on
 *              the data volume: REFUSED under the guard + 2 plain days + 7 archived days at the measured rate (w7-lib.cjs DISK), a
 *              loud line when it cannot hold the registered 30-day span. An unsynchronised clock is a loud line, not a refusal.
 *   copy       backend/pm-book-recorder.js and backend/lib/pm-feeds.js -> /home/traids/traids/backend, in chunks, each read back by
 *              sha256; then, on the VPS, node --check of both and the recorder's own --selftest (offline: fake feeds only), which
 *              must be green or the step fails. A recorder that is already running keeps the code it started with: the step says so
 *              and names --restart.
 *   units      refused unless the VPS holds home's recorder. In order:
 *                1  the recorder's selftest on the VPS, green NOW;
 *                2  the pull manifest installed at home as deploy/server/manifests/w7-pm.json (the staged bytes);
 *                3  the map entry "w7-pm": "server" — pushed to the VPS first (root:root 0444, read back), then written at home, by this
 *                   step and never by hand; no other unit's owner is touched; own-check on the VPS must then say run. A run that died
 *                   between those two writes is finished by the next one: when the VPS holds EXACTLY home's map plus this entry and
 *                   its history line, those bytes are written at home (no second push). Any other difference between the two maps
 *                   is refused here and in the precheck, with what differs and the command that settles it (home's is the master);
 *                4  the 5 units installed root:root 0644 (each only when its sha256 is the staged one), systemd-analyze verify,
 *                   daemon-reload, and `systemctl enable` WITHOUT --now: enabled, NOT started — read back and printed;
 *                5  the recorder started; it must be active, with a fresh status file of its own and the copied code's sha256 in it
 *                   (a recorder that was ALREADY running and still runs older code stops the step there — no timer, no live marker:
 *                   --restart first, then this step again);
 *                   the step then waits up to 90 s for each feed to receive something. A venue that refuses the server (a block) is
 *                   REPORTED, loudly, not a failed step: the registered rule says that venue's cells are then CANNOT MEASURE;
 *                6  the two timers started (nightly compress + summary 00:40 UTC; health every 5 minutes);
 *                7  data/pm-book/live.json written ONCE with the server's own clock (liveAt): the unit is enabled on the host and its
 *                   selftest is green there. record-evidence-start.cjs reads it; nothing here touches the registry.
 *   status     read-only: the recorded steps, both maps, the units, the code on the VPS against home's and against what is RUNNING, the
 *              live marker, and the recorder's own --status and --health as the server answers them.
 * Exit 0 ok · 1 a step failed or refused · 2 bad arguments (nothing done).
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), os = require("os");
const HERE = __dirname;
const L = require(path.join(HERE, "w7-lib.cjs")), MF = require(path.join(HERE, "manifests.cjs"));
const { PS, OWN, UN, sha, RB, RD, SYSD, UNIT, WAVE, SERVICE, CODE, SHARED, GiB, DISK, REMOTE, must } = L;
const { writeJsonAtomic } = require(path.join(L.REPO, "backend", "lib", "atomic-write.js"));
const BY = "docs/server/wave7-pm/deploy.cjs (units)";
const STEPS = ["precheck", "copy", "units", "status"];
const gib = (b) => (b / GiB).toFixed(1) + " GiB";

// ── pure parts ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
function parseProbe(out) {
  const lines = String(out).trim().split("\n").map((l) => l.trim()), hit = (re) => { for (const l of lines) { const m = re.exec(l); if (m) return m; } return null; };
  return { who: lines[0] || "", node: (hit(/^(v\d+\.\S+)$/) || [])[1] || null, nodeMajor: Number((hit(/^v(\d+)\./) || [])[1]), sudo: lines.includes("SUDO_OK"), systemd: Number((hit(/^systemd (\d+)/) || [])[1]),
    backend: lines.includes("BACKEND_OK"), alert: lines.includes("ALERT_OK"), alertUnit: lines.includes("ALERT_UNIT_OK"), ntp: (hit(/^NTP=(.*)$/) || [])[1] || "unknown", avail: Number((hit(/^AVAIL=(\d+)$/) || [])[1]), epoch: Number(lines[lines.length - 1]) };
}
/** what the probe refuses on, and what it only says loudly: { refuse: [...], attention: [...] } */
function probeJudge(p, nowMs) {
  const refuse = [], attention = [];
  if (p.who !== "traids") refuse.push(`the ssh user is ${JSON.stringify(p.who)}, not traids`);
  if (!(p.nodeMajor >= 24)) refuse.push(`${UN.NODE} is ${p.node || "missing"}: the recorder needs Node 24 or newer (its websocket client is the built-in one; no npm package is installed)`);
  if (!p.sudo) refuse.push("sudo -n does not work for traids (installing a unit needs it)");
  if (!(p.systemd >= 243)) refuse.push(`systemd ${p.systemd || "?"} is older than 243: no ExecCondition, so no ownership gate`);
  if (!p.backend) refuse.push(`${RB} is missing`);
  if (!p.alert || !p.alertUnit) refuse.push("the alert path is missing (backend/traids-alert.cjs or traids-alert@.service): a failure would page nobody");
  const skew = Math.abs(p.epoch * 1000 - nowMs);
  if (!(skew < 5 * 60000)) refuse.push(`the VPS clock differs from this PC by ${Number.isFinite(skew) ? Math.round(skew / 1000) + " s" : "an unreadable amount"}`);
  const floor = DISK.needBytes(DISK.floorDays), span = DISK.needBytes(DISK.spanDays);
  if (!Number.isFinite(p.avail)) refuse.push("free space on the data volume could not be read");
  else if (p.avail < floor) refuse.push(`${gib(p.avail)} free on the data volume is under ${gib(floor)}: the guard (${gib(DISK.guardBytes)}) + 2 plain days + ${DISK.floorDays} archived days at the measured rate (${gib(DISK.plainPerDay)} a day plain, ${gib(DISK.gzPerDay)} after gzip) — make room first`);
  else if (p.avail < span) attention.push(`${gib(p.avail)} free holds about ${Math.floor((p.avail - DISK.guardBytes - 2 * DISK.plainPerDay) / DISK.gzPerDay)} archived days at the measured rate; the registered 30-day span plus its lead needs about ${gib(span)}. The recorder stops writing ${gib(DISK.guardBytes)} before the disk is full and the health check pages a day ahead — plan the room (NOTES.md, "Disk")`);
  if (p.ntp !== "yes") attention.push(`the VPS says its clock is NOT synchronised (timedatectl NTPSynchronized = ${p.ntp}): every row is stamped with that clock — fix time sync before the evidence starts`);
  return { refuse, attention, skewMs: skew };
}
function parseArgs(argv) {
  const out = { mode: "deploy", step: null }, modes = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--dry") throw new Error("deploy.cjs has NO dry mode — nothing was done. Use --status (read-only) or --step precheck (read-only)");
    if (["--selftest", "--status", "--restart"].includes(x)) modes.push(x);
    else if (x === "--step") { const v = argv[++i]; if (!STEPS.includes(v)) throw new Error(`--step needs one of ${STEPS.join(" | ")} (got ${JSON.stringify(v)})`); if (out.step) throw new Error("give --step once"); out.step = v; }
    else throw new Error(`unknown argument ${JSON.stringify(x)} — nothing was done. deploy.cjs takes: --step <${STEPS.join("|")}> · --status · --restart · --selftest`);
  }
  if (modes.length > 1 || (modes.length && out.step)) throw new Error(`give one of --selftest / --status / --restart on its own (got ${argv.join(" ")}) — nothing was done`);
  if (modes.length) out.mode = modes[0].slice(2);
  if (out.step === "status") { out.mode = "status"; out.step = null; }
  return out;
}
const planOf = (A) => (A.step ? [A.step] : ["copy", "units"]);
function remainingSteps(plan, failed) {
  const i = failed === "precheck" ? 0 : plan.indexOf(failed), left = i < 0 ? plan : plan.slice(i);
  return ["Fix the cause, then run, in order (each step re-reads the real state and skips what is done):", ...left.map((s) => `  node docs/server/wave7-pm/deploy.cjs --step ${s}`)];
}

// ── the steps, on injected dependencies (the selftest gives a fake VPS and temp files) ───────────────────────────────────────
function make(deps = {}) {
  const d = { ssh: null, log: (s) => console.log(s), repo: L.REPO, stagedDir: HERE, mapFile: path.join(PS.HOME_DATA, "host-ownership.json"), stateFile: path.join(HERE, "deploy-state.json"), manifestDir: path.join(L.DS, "manifests"),
    homePm: path.join(PS.HOME_DATA, "pm-book"), now: () => Date.now(), sleep: L.sleepMs, waitMs: 90000, pollMs: 10000, stagedSelftest: null, ...deps };
  const ssh = (script, o) => { if (!d.ssh) d.ssh = PS.sshReal(L.HOST); return d.ssh(script, o); };
  const readState = () => { try { return JSON.parse(fs.readFileSync(d.stateFile, "utf8")); } catch { return { steps: {} }; } };
  const record = (step, obj) => { const st = readState(); st.steps = st.steps || {}; st.steps[step] = { at: new Date(d.now()).toISOString(), ...obj }; writeJsonAtomic(d.stateFile, st); };
  const homeCode = () => CODE.map((c) => ({ rel: c.rel, data: L.homeBytes(d.repo, c.home), mode: "0644" }));
  const stagedUnits = () => Object.fromEntries(UN.ALL_UNITS.map((u) => [u, fs.readFileSync(path.join(d.stagedDir, "systemd", u))]));
  function generatorsOk() {
    const bad = [...UN.semanticIssues()];
    for (const [f, t] of Object.entries(UN.expected())) { let cur = null; try { cur = fs.readFileSync(path.join(d.stagedDir, "systemd", f), "utf8"); } catch { cur = null; } if (cur !== t) bad.push(`systemd/${f} is not what units.cjs generates`); }
    return [...bad, ...MF.issues(path.join(d.stagedDir, "manifests"))];
  }
  const unitState = (units = UN.ALL_UNITS) => { const m = L.parseUnitState(must(ssh(REMOTE.unitState(units)), "reading the units' state")); for (const u of units) if (!m[u]) throw new Error(`reading the units' state: no answer for ${u}`); return m; };
  const readHealth = () => L.parseHealth(must(ssh(REMOTE.health(), { timeout: 120000 }), "reading the recorder's state"));
  function serverSelftest() {
    const r = ssh(REMOTE.serverSelftest(), { timeout: 900000 }), s = L.parseSelftest(must(r, "the recorder's selftest on the VPS"));
    if (s.checks !== CODE.length || !s.green) throw new Error(`the recorder's selftest on the VPS is NOT green (node --check ${s.checks}/${CODE.length}; ${s.line || "no selftest line"}) — REFUSED, nothing further was done:\n${String(r.out).slice(-600)}`);
    return s;
  }
  const codeIs = (running, files) => !!running && files.every((f) => running[f.rel] === sha(f.data));
  /**
   * The VPS map when its sha256 is not home's, read whole (fail-closed) -> { half, buf, text, how }.
   * half = the map to take home when the VPS holds EXACTLY home's map plus this step's own entry and history line: an earlier run of
   * the units step pushed the map and died before home's was written (the push comes first). Anything else is not this step's to
   * settle: `text` says what differs and `how` names the command that does settle it.
   */
  function vpsMapDiff(mr, srvSha) {
    if (!srvSha) return { half: null, text: "the VPS holds no ownership map (every server unit's gate reads that file)", how: "Look at the VPS before anything else: node deploy/server/own.cjs --status w1" };
    const buf = Buffer.from(must(ssh(REMOTE.cat(RD + "/host-ownership.json")), "reading the VPS map"));
    let vm = null; try { vm = JSON.parse(buf.toString("utf8")); } catch { vm = null; }
    if (!vm || vm.schema !== "host-ownership-v1" || !vm.units) vm = null;
    // (the bytes read here must be the bytes whose sha256 the VPS just gave: a map that changed between the two reads is not taken home)
    return { half: vm && sha(buf) === srvSha ? L.halfDone(mr.map, buf, "server") : null, buf, ...L.mapDifference(mr.map, vm) };
  }
  /** the recorder is up: active, a status file of its own that is fresh; then up to waitMs for each feed to receive (or be blocked) */
  function waitForFeeds() {
    const t0 = d.now(); let h;
    for (;;) {
      h = readHealth();
      if (h.active !== "active") throw new Error(`${SERVICE} is ${h.active || "in an unknown state"}: it did not stay up. Read why: ssh traids journalctl -u ${SERVICE} -n 40 --no-pager`);
      const f = L.feedsOf(h.status), names = Object.keys(f);
      if (names.length === 3 && names.every((n) => f[n].lastRx != null || f[n].state === "blocked")) break;
      if (d.now() - t0 >= d.waitMs) break;
      d.sleep(d.pollMs);
    }
    if (!h.status || h.status.schema !== "pm-book-status-v1") throw new Error(`${SERVICE} is active but wrote no status file (data/pm-book/status.json): ssh traids journalctl -u ${SERVICE} -n 40 --no-pager`);
    const age = h.nowMs - Date.parse(h.status.asOf);
    if (h.status.stopped || !(age <= 60000)) throw new Error(`${SERVICE} is active but its status file is ${h.status.stopped ? `marked stopped (${h.status.stopped})` : Math.round(age / 1000) + " s old"}: the recorder is not writing — ssh traids journalctl -u ${SERVICE} -n 40 --no-pager`);
    return h;
  }
  function sayFeeds(h) {
    const f = L.feedsOf(h.status), got = Object.entries(f).filter(([, x]) => x.lastRx != null).map(([n]) => n), blocked = Object.entries(f).filter(([, x]) => x.state === "blocked"), quiet = Object.entries(f).filter(([, x]) => x.lastRx == null && x.state !== "blocked");
    d.log(`   feeds: ${got.length ? got.join(", ") + " receiving" : "none receiving yet"}${quiet.length ? ` · NOT yet: ${quiet.map(([n, x]) => n + (x.why ? ` (${x.why})` : "")).join(", ")}` : ""}`);
    for (const [n, x] of blocked) d.log(`   ATTENTION — ${n} is BLOCKED: ${x.why}. The venue refused the server; the recorder stopped calling it, recorded the answer and will page. It is never routed around (R352 fences): that venue's cells are CANNOT MEASURE.`);
    d.log(`   health (the recorder's own --health on the VPS): ${h.verdict || "no verdict"}${h.lines.length ? " — " + h.lines.join(" | ").slice(0, 600) : ""}`);
    return { receiving: got, blocked: blocked.map(([n]) => n), quiet: quiet.map(([n]) => n) };
  }

  function precheck({ quick = false } = {}) {
    d.log("== 0 precheck (read-only: nothing is written on either machine)");
    const gen = generatorsOk(); if (gen.length) throw new Error("staged files are not what their generators make — REFUSED: " + gen.join("; ") + " (node docs/server/wave7-pm/units.cjs --write · manifests.cjs --write, then review)");
    const files = homeCode();
    for (const c of CODE) { const r = cp.spawnSync(process.execPath, ["--check", path.join(d.repo, ...c.home.split("/"))], { encoding: "utf8", windowsHide: true }); if (r.status !== 0) throw new Error(`${c.home} does not parse — REFUSED: ${String(r.stderr).trim().split("\n").slice(0, 2).join(" ")}`); }
    const mr = PS.readMap(d.mapFile); if (!mr.ok) throw new Error(`home's map: ${mr.why} — REFUSED`);
    d.log(`   home: the 5 units and the manifest equal their generators; ${CODE.map((c) => c.home).join(" + ")} parse; the map is readable (${UNIT}: ${mr.map.units[UNIT] || "not named yet"})`);
    if (!quick) {
      const r = d.stagedSelftest ? d.stagedSelftest() : cp.spawnSync(process.execPath, [path.join(HERE, "selftest.cjs")], { encoding: "utf8", timeout: 1800000, windowsHide: true });
      if (r.status !== 0) throw new Error("the staged selftests FAILED — REFUSED:\n" + String(r.stdout).split("\n").filter((l) => /FAIL|SELFTEST/.test(l)).slice(0, 12).join("\n"));
      d.log("   staged selftests: " + (String(r.stdout).trim().split("\n").pop() || ""));
    }
    const p = parseProbe(must(ssh(REMOTE.probe()), "ssh traids")), j = probeJudge(p, d.now());
    if (j.refuse.length) throw new Error("the VPS is not ready — REFUSED: " + j.refuse.join("; "));
    d.log(`   VPS: traids, node ${p.node}, sudo -n, systemd ${p.systemd}, the alert path present, clock within ${Math.round(j.skewMs / 1000)} s of this PC, time sync ${p.ntp === "yes" ? "on" : "NOT confirmed"}, ${gib(p.avail)} free on the data volume`);
    for (const a of j.attention) d.log("   ATTENTION — " + a);
    const shared = L.shasOf(ssh, RB, SHARED.map((c) => c.rel)), off = SHARED.filter((c) => shared.get(c.rel) !== sha(L.homeBytes(d.repo, c.home)));
    if (off.length) throw new Error(`the VPS's ${off.map((c) => c.rel).join(", ")} ${off.length > 1 ? "differ" : "differs"} from home's (the standing gate and atomic write, shared with every other unit) — REFUSED`);
    const vm = L.shasOf(ssh, RD, ["host-ownership.json"]).get("host-ownership.json"); let halfMap = false;
    if (vm !== mr.sha) {
      const df = vpsMapDiff(mr, vm);
      if (!df.half) throw new Error(`the VPS map (${String(vm).slice(0, 12)}) differs from home's (${mr.sha.slice(0, 12)}) — REFUSED: both must be equal before a unit is added; ${df.text}. ${df.how}`);
      halfMap = true;
      d.log(`   ATTENTION — the VPS map already holds "${UNIT}": "server" and home's does not: an earlier run of the units step pushed the map and stopped before home's was written. The units step takes those bytes home and goes on (nothing else differs between the two maps)`);
    }
    const us = L.shasOf(ssh, SYSD, UN.ALL_UNITS), staged = stagedUnits(), drift = UN.ALL_UNITS.filter((u) => us.get(u) && us.get(u) !== sha(staged[u]));
    if (drift.length) throw new Error(`units on the VPS are neither absent nor the staged copies — REFUSED (drift): ${drift.join(", ")}. Remove them first: node docs/server/wave7-pm/rollback.cjs --server, then --units`);
    const cs = L.shasOf(ssh, RB, CODE.map((c) => c.rel));
    d.log(`   VPS: own-check.cjs + lib/atomic-write.js = home's; map = home's${halfMap ? " plus this unit's entry (the half-done units step above)" : ""}; units ${UN.ALL_UNITS.filter((u) => us.get(u)).length} of ${UN.ALL_UNITS.length} installed (each the staged copy); recorder code: ${files.map((f) => `${f.rel} ${!cs.get(f.rel) ? "absent" : cs.get(f.rel) === sha(f.data) ? "= home's" : "differs (the copy step replaces it)"}`).join(", ")}`);
    return { probe: p, attention: j.attention };
  }

  function stepCopy() {
    d.log("== 1 copy (the recorder and its library -> the VPS backend, chunked, each chunk read back by sha256; then its selftest THERE)");
    const files = homeCode(), cur = L.shasOf(ssh, RB, files.map((f) => f.rel)), todo = files.filter((f) => cur.get(f.rel) !== sha(f.data));
    if (todo.length) L.pushVerified(ssh, RB, todo);
    d.log(`   ${RB}: ${todo.length ? `${todo.length} file(s) uploaded and verified (${todo.map((f) => f.rel).join(", ")})` : "already current"}${todo.length && files.length - todo.length ? `, ${files.length - todo.length} already current` : ""}`);
    const st = serverSelftest();
    d.log(`   VPS: node --check ${st.checks}/${CODE.length}; ${st.line} (offline there too: fake feeds only; nothing was recorded)`);
    const h = readHealth(), stale = h.active === "active" && !codeIs(h.status && h.status.code, files);
    if (stale) d.log(`   ATTENTION — ${SERVICE} is running and still runs the code it started with, not what was just copied. To switch (a gap of a few seconds, written down as a gap): node docs/server/wave7-pm/deploy.cjs --restart`);
    record("copy", { ok: true, shas: Object.fromEntries(files.map((f) => [f.rel, sha(f.data)])), uploaded: todo.map((f) => f.rel), selftest: st.line, selftestPassed: st.passed, selftestAt: st.at, restartNeeded: stale });
    return { uploaded: todo.length, selftest: st, restartNeeded: stale };
  }

  /** the pull manifest at home: the staged bytes, written once; a different file there is never overwritten */
  function installManifest() {
    const src = fs.readFileSync(path.join(d.stagedDir, "manifests", WAVE + ".json")), to = path.join(d.manifestDir, WAVE + ".json");
    let cur = null; try { cur = fs.readFileSync(to); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (cur && cur.equals(src)) return "already installed";
    if (cur) throw new Error(`${to} exists and is not the staged manifest — REFUSED (nothing installed). It is never overwritten: compare it with docs/server/wave7-pm/manifests/${WAVE}.json and move it aside if it is stale`);
    writeJsonAtomic(to, MF.ALL[WAVE]);
    if (!fs.readFileSync(to).equals(src)) throw new Error(`${to} was written but is not byte-equal to the staged manifest`);
    PS.loadManifest(WAVE, d.manifestDir);
    return "installed";
  }

  function stepUnits() {
    d.log("== 2 units (map entry, the 5 units installed and ENABLED BUT NOT STARTED, then the recorder started, then its timers)");
    const files = homeCode(), cur = L.shasOf(ssh, RB, files.map((f) => f.rel)), missing = files.filter((f) => cur.get(f.rel) !== sha(f.data));
    if (missing.length) throw new Error(`the VPS does not hold home's recorder (${missing.map((f) => `${f.rel} ${cur.get(f.rel) ? "differs" : "absent"}`).join(", ")}) — REFUSED, nothing installed. Run the copy step first: node docs/server/wave7-pm/deploy.cjs --step copy`);
    const mr = PS.readMap(d.mapFile); if (!mr.ok) throw new Error(`home's map: ${mr.why} — REFUSED, nothing installed`);
    const srv = L.shasOf(ssh, RD, ["host-ownership.json"]).get("host-ownership.json"); let half = null;
    if (srv !== mr.sha) {   // equal, or exactly this step's own half-done push (adopted in 3, below); anything else is refused, with the command that settles it
      half = vpsMapDiff(mr, srv);
      if (!half.half) throw new Error(`the VPS map (${String(srv).slice(0, 12)}) differs from home's (${mr.sha.slice(0, 12)}) — REFUSED, nothing installed: ${half.text}. ${half.how}`);
    }
    const staged = stagedUnits(), ucur = L.shasOf(ssh, SYSD, UN.ALL_UNITS), todo = UN.ALL_UNITS.filter((u) => ucur.get(u) !== sha(staged[u])), drift = todo.filter((u) => ucur.get(u));
    if (drift.length) throw new Error(`installed units differ from the staged copies — REFUSED (drift), nothing installed: ${drift.join(", ")}. Remove them first: node docs/server/wave7-pm/rollback.cjs --server, then --units`);
    const st = serverSelftest();
    d.log(`   1 the recorder's selftest on the VPS, now: ${st.line}`);
    d.log(`   2 home's pull manifest deploy/server/manifests/${WAVE}.json: ${installManifest()} (summaries and status only; the day archives are fetched on demand)`);
    const next = half ? half.half : L.withUnit(mr.map, "server", BY, new Date(d.now()).toISOString());
    if (half) {
      // an earlier run of this step pushed the map and died before the next statement: the VPS's bytes are taken home (no second push)
      OWN.writeMap(d.mapFile, next);
      if (!fs.readFileSync(d.mapFile).equals(half.buf)) throw new Error("home's map was written but is not byte-equal to the VPS's — nothing installed; look at both: node deploy/server/own.cjs --status");
      d.log(`   3 map: the VPS already held "${UNIT}": "server" (an earlier run of this step pushed it and stopped before home's map was written) — home's map now holds the VPS's exact bytes; no second push, no other unit touched`);
    } else if (next !== mr.map) {
      if (OWN.pushMap(ssh, RD, OWN.mapBytes(next), mr.sha) !== "pushed") throw new Error("pushing the map to the VPS did not land — nothing installed, home's map unchanged");
      OWN.writeMap(d.mapFile, next);
      d.log(`   3 map: "${UNIT}": "server" ${UNIT in mr.map.units ? `(was "${mr.map.units[UNIT]}")` : "added"} — pushed to the VPS first (root:root 0444, read back = home's bytes), then written at home; no other unit touched`);
    } else d.log(`   3 map: "${UNIT}" is already "server" on both hosts — unchanged`);
    const oc = OWN.ownChecks(ssh, [UNIT], "server"); if (oc[UNIT] !== 0) throw new Error(`own-check on the VPS does not say run for ${UNIT} (exit ${oc[UNIT]}) — nothing installed`);
    for (const u of todo) must(ssh(REMOTE.install(u, sha(staged[u])), { input: staged[u] }), "installing " + u);
    if (!/VERIFIED/.test(must(ssh(REMOTE.verify(UN.ALL_UNITS)), "systemd-analyze verify"))) throw new Error("systemd-analyze verify did not pass");
    if (!/ENABLED/.test(must(ssh(REMOTE.enable(UN.ENABLED)), "daemon-reload / enable"))) throw new Error("the units were not enabled");
    let us = unitState();
    const notEn = UN.ENABLED.filter((u) => us[u].enabled !== "enabled"); if (notEn.length) throw new Error(`not enabled after systemctl enable: ${notEn.join(", ")}`);
    const wasRunning = us[SERVICE].active === "active";
    d.log(`   4 units: ${todo.length ? `${todo.length} installed root:root 0644` : `all ${UN.ALL_UNITS.length} already installed`}; systemd-analyze verify ok; ${UN.ENABLED.join(", ")} ENABLED — ${wasRunning ? `${SERVICE} was already running (an earlier run of this step); not started again` : `NOT started (${UN.ENABLED.map((u) => `${u.replace(/^traids-pm-/, "")} ${us[u].active}`).join(", ")})`}`);
    if (!wasRunning) {
      const s = L.parseStart(must(ssh(REMOTE.start(), { timeout: 120000 }), "starting " + SERVICE));
      if (!s || s.active !== "active") throw new Error(`${SERVICE} did not start (${s ? `state ${s.active}, result ${s.result || "?"}` : "no answer"})${s && s.result === "exec-condition" ? " — its ownership gate skipped it: the VPS map does not give w7-pm to the server" : ""}. Nothing is recording; the timers were not started. Read why: ssh traids journalctl -u ${SERVICE} -n 40 --no-pager`);
    }
    const h = waitForFeeds();
    const fresh = codeIs(h.status.code, files);
    if (!fresh && !wasRunning) throw new Error(`${SERVICE} started but its status file does not name the copied code (${JSON.stringify(h.status.code || null).slice(0, 160)}) — the timers were not started`);
    // The live marker is written ONCE and its liveAt anchors R352's evidence start: it may only ever name a recorder that IS the code
    // that was copied and selftested. A recorder that was already running and still runs what it started with (a copy went over
    // since) is not that — the step stops here, before the timers and before the marker, and says what to do.
    if (!fresh) throw new Error(`${SERVICE} is running, but NOT the code that was copied and selftested on the VPS: it was started before the last copy and still runs what it started with (its status file names ${JSON.stringify(h.status.code || null).slice(0, 160)}). The live marker is written once and for the copied code only, so it was NOT written (and this run started no timer). Restart first: node docs/server/wave7-pm/deploy.cjs --restart — then this step again: node docs/server/wave7-pm/deploy.cjs --step units`);
    d.log(`   5 ${SERVICE}: active since ${h.status.startedAt} (its own status file, ${Math.round((h.nowMs - Date.parse(h.status.asOf)) / 1000)} s old); it runs the copied code (sha256 in its status)`);
    const feeds = sayFeeds(h);
    if (!/TIMERS_ON/.test(must(ssh(REMOTE.timersOn()), "starting the timers"))) throw new Error("the timers were not started");
    us = unitState();
    const bad = UN.ENABLED.filter((u) => us[u].enabled !== "enabled" || us[u].active !== "active"); if (bad.length) throw new Error(`not enabled + active after the start: ${bad.map((u) => `${u} ${us[u].enabled}/${us[u].active}`).join(", ")}`);
    d.log(`   6 timers: ${L.TIMERS.join(", ")} enabled + active (nightly compress and summary 00:40 UTC; health every 5 minutes, which is what pages)`);
    const lv = L.parseLive(must(ssh(REMOTE.liveMarker({ unit: SERVICE, by: BY, selftest: { passed: st.passed, at: st.at }, code: Object.fromEntries(files.map((f) => [f.rel, sha(f.data)])) })), "the live marker"));
    if (!lv) throw new Error("data/pm-book/live.json could not be written or read back — the unit is running, but record-evidence-start.cjs will refuse until this step succeeds (re-run it)");
    d.log(`   7 LIVE: ${lv.live.liveAt} (the server's clock) — ${lv.how === "kept" ? "the marker of the first time the unit went live is kept; it is never rewritten" : "data/pm-book/live.json written, read-only"}. R352's dated evidence-start note is YOUR command, not this step's: node docs/server/wave7-pm/record-evidence-start.cjs --dry`);
    record("units", { ok: true, installed: todo, liveAt: lv.live.liveAt, live: lv.how, health: h.verdict, feeds, restartNeeded: false, selftest: st.line });   // (the step ends here only with the running recorder on the copied code)
    return { liveAt: lv.live.liveAt, how: lv.how, health: h.verdict, feeds, installed: todo.length };
  }

  function restart() {
    d.log(`== restart (${SERVICE}: the running recorder is replaced by one that runs the copied code; the seconds in between are a gap row)`);
    const us = unitState([SERVICE]); if (us[SERVICE].enabled !== "enabled") throw new Error(`${SERVICE} is not installed and enabled — run the units step, not --restart`);
    const files = homeCode(), cur = L.shasOf(ssh, RB, files.map((f) => f.rel)), off = files.filter((f) => cur.get(f.rel) !== sha(f.data));
    if (off.length) throw new Error(`the VPS does not hold home's recorder (${off.map((f) => f.rel).join(", ")}) — REFUSED: run the copy step first (a restart would start code that was not selftested there)`);
    const s = L.parseStart(must(ssh(REMOTE.restart(), { timeout: 120000 }), "restarting " + SERVICE));
    if (!s || s.active !== "active") throw new Error(`${SERVICE} did not come back (${s ? `state ${s.active}, result ${s.result || "?"}` : "no answer"}) — NOTHING IS RECORDING. Read why: ssh traids journalctl -u ${SERVICE} -n 40 --no-pager`);
    const h = waitForFeeds();
    if (!codeIs(h.status.code, files)) throw new Error(`${SERVICE} restarted but its status file does not name the copied code`);
    d.log(`   active since ${h.status.startedAt}; it runs the copied code`); const feeds = sayFeeds(h);
    record("restart", { ok: true, startedAt: h.status.startedAt, health: h.verdict, feeds });
    return { startedAt: h.status.startedAt, health: h.verdict };
  }

  function status() {
    const st = readState().steps || {};
    for (const k of ["copy", "units", "restart"]) if (st[k] || k !== "restart") d.log(`${k.padEnd(12)} ${st[k] ? `${st[k].ok ? "ok" : "NOT ok"} at ${st[k].at}${st[k].liveAt ? ` · live at ${st[k].liveAt}` : ""}` : "not run"}`);
    const mr = PS.readMap(d.mapFile), files = homeCode();
    d.log(`map (home)   ${mr.ok ? `${UNIT} = ${mr.map.units[UNIT] || "not named"} · sha ${mr.sha.slice(0, 12)}` : mr.why}`);
    { let s = "not installed"; try { s = fs.readFileSync(path.join(d.manifestDir, WAVE + ".json")).equals(fs.readFileSync(path.join(d.stagedDir, "manifests", WAVE + ".json"))) ? "installed (the staged bytes)" : "DIFFERS from the staged manifest"; } catch { /* not installed */ } d.log(`manifest     deploy/server/manifests/${WAVE}.json ${s}`); }
    { let n = 0, last = null; try { const names = fs.readdirSync(path.join(d.homePm, "summary")).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort(); n = names.length; last = names[n - 1] || null; } catch { n = 0; } const hs = L.readJson(path.join(d.homePm, "status.json")); d.log(`home copies  ${n} day summar${n === 1 ? "y" : "ies"}${last ? ` (newest ${last.slice(0, 10)})` : ""}; the server's status as of ${hs && hs.asOf ? hs.asOf : "never pulled"} (node deploy/server/pull-server.cjs --wave ${WAVE})`); }
    try {
      const vm = L.shasOf(ssh, RD, ["host-ownership.json"]).get("host-ownership.json");
      d.log(`map (VPS)    ${vm ? vm.slice(0, 12) + (mr.ok && vm === mr.sha ? " = home's" : " DIFFERS from home's") : "absent"}`);
      if (mr.ok && vm && vm !== mr.sha) { const df = vpsMapDiff(mr, vm); d.log("             " + (df.half ? `it is home's map plus "${UNIT}": "server": a units step that stopped between its two map writes. Run that step again (it takes the VPS's bytes home), or stop everything: node docs/server/wave7-pm/rollback.cjs --server` : `${df.text}. ${df.how}`)); }
      const cs = L.shasOf(ssh, RB, CODE.map((c) => c.rel)), us = L.shasOf(ssh, SYSD, UN.ALL_UNITS), staged = stagedUnits(), state = unitState(), h = readHealth();
      d.log(`code (VPS)   ${files.map((f) => `${f.rel} ${!cs.get(f.rel) ? "absent" : cs.get(f.rel) === sha(f.data) ? "= home's" : "DIFFERS from home's"}`).join(", ")}${h.active === "active" ? ` · running: ${codeIs(h.status && h.status.code, files) ? "this code" : "OLDER code — node docs/server/wave7-pm/deploy.cjs --restart"}` : ""}`);
      for (const u of UN.ALL_UNITS) d.log(`unit         ${u.padEnd(28)} ${!us.get(u) ? "not installed" : us.get(u) === sha(staged[u]) ? "the staged copy" : "DIFFERS from the staged copy"} · ${state[u].enabled || "-"} · ${state[u].active || "-"}`);
      const lv = String(must(ssh(REMOTE.readLive()), "reading the live marker")).trim(); let live = null; try { live = lv === "ABSENT" ? null : JSON.parse(lv); } catch { live = undefined; }
      d.log(`live marker  ${live ? `liveAt ${live.liveAt} (written once by the units step)` : live === null ? "absent — the units step has not completed" : "UNREADABLE"}`);
      for (const l of String(h.statusText).split("\n").filter(Boolean)) d.log("VPS          " + l);
      d.log(`health       ${h.verdict || "no verdict"}${h.lines.length ? " — " + h.lines.join(" | ") : ""}`);
    } catch (e) { d.log("VPS          unreadable: " + e.message.slice(0, 300)); }
  }
  return { d, precheck, stepCopy, stepUnits, restart, status, readState, generatorsOk, installManifest, unitState, readHealth };
}

// ── selftest: a fake VPS in memory, temp files; no ssh, no network, no repo data file ────────────────────────────────────────
function sandbox(o = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w7-deploy-")), mapFile = path.join(tmp, "host-ownership.json"), lines = []; let V = null;
  const done = () => { try { if (V) V.cleanup(); } finally { fs.rmSync(tmp, { recursive: true, force: true }); } };
  try {
    fs.mkdirSync(path.join(tmp, "manifests"));
    OWN.writeMap(mapFile, { schema: "host-ownership-v1", note: "selftest", units: { r309: "server", "w1-whales": "server", "w2a-fills": "home", ...(o.units || {}) }, updatedAt: "2026-10-11T00:00:00.000Z", history: [] });
    V = L.fakeVps(); V.seed(L.REPO, fs.readFileSync(mapFile));
    const D = make({ ssh: V.ssh, log: (s) => lines.push(s), mapFile, stateFile: path.join(tmp, "deploy-state.json"), manifestDir: path.join(tmp, "manifests"), homePm: path.join(tmp, "pm-book"), now: () => V.S.clock, sleep: (ms) => { V.S.clock += ms; }, stagedSelftest: () => ({ status: 0, stdout: "selftest stub: green\n" }), ...(o.deps || {}) });
    return { tmp, mapFile, lines, V, D, text: () => lines.join("\n"), map: () => JSON.parse(fs.readFileSync(mapFile, "utf8")), done };
  } catch (e) { try { done(); } catch { /* the first error is the one to show */ } throw e; }   // a sandbox that could not be built leaves no temp folder
}
/** take every sandbox of a selftest down, each on its own (one that fails does not keep the others) — called from a FINALLY */
function closeAll(boxes) { for (const b of boxes) { try { b.done(); } catch { /* a scanner may hold a file for a moment */ } } }
/** cases = the selftest's body, given the list every sandbox it makes goes into. The sandboxes' temp folders are removed in a FINALLY: a check that throws leaves none behind */
function selftest(cases = selftestCases) {
  const boxes = [];
  try { return cases(boxes); } finally { closeAll(boxes); }
}
function selftestCases(boxes) {
  let pass = 0, fail = 0;
  const ok = (n, c, det) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (det !== undefined ? " — " + String(typeof det === "string" ? det : JSON.stringify(det)).slice(0, 700) : "")); } };
  const err = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const P = (s) => { try { return parseArgs(s.split(" ").filter(Boolean)); } catch (e) { return { err: e.message }; } };
  const box = (o) => { const b = sandbox(o); boxes.push(b); return b; };

  ok("args: --dry is refused everywhere (there is no dry mode); an unknown flag or a typo is refused before anything runs", /NO dry mode/.test(P("--dry").err || "") && /NO dry mode/.test(P("--step units --dry").err || "") && /unknown argument/.test(P("--stauts").err || "") && /unknown argument/.test(P("--status --force").err || "") && /unknown argument/.test(P("units").err || ""));
  ok("args: one mode on its own; a bad step is refused; the valid forms parse (--step status is --status)", /on its own/.test(P("--status --restart").err || "") && /on its own/.test(P("--restart --step copy").err || "") && /--step needs/.test(P("--step home").err || "") && /--step needs/.test(P("--step").err || "") && P("").mode === "deploy" && P("--step copy").step === "copy" && P("--step status").mode === "status" && P("--restart").mode === "restart" && JSON.stringify(planOf(P(""))) === '["copy","units"]');
  ok("a failure prints the steps that remain, in order (copy failed -> copy, units; units failed -> units only)", /--step copy\n\s+node \S+ --step units$/.test(remainingSteps(planOf({}), "copy").join("\n")) && !/--step copy/.test(remainingSteps(planOf({}), "units").join("\n")) && /--step copy\n\s+node \S+ --step units$/.test(remainingSteps(planOf({}), "precheck").join("\n")));

  // every remote script: short, and none grows with a list
  { const all = L.everyScript(), longest = Math.max(...Object.values(all).map((s) => s.length));
    ok(`every remote script this package sends starts with its "# w7:<name>" line and is short: the longest of ${Object.keys(all).length} is ${longest} characters, far under the ~8,190 at which a script arrived cut (limit here ${L.SCRIPT_MAX})`, Object.entries(all).every(([, s]) => /^# w7:[a-z-]+/.test(s)) && longest < L.SCRIPT_MAX && longest > 300, longest); }
  { const b = box(), many = Array.from({ length: 300 }, (_, i) => ({ rel: `pm-book/selftest/a-rather-long-file-name-${String(i).padStart(4, "0")}.jsonl.gz`, data: Buffer.from("row " + i + "\n"), mode: "0644" }));
    const before = b.V.S.calls.length, n = L.pushVerified(b.V.ssh, RD, many), pushScripts = b.V.S.calls.slice(before).filter((s) => /EOF_MV/.test(s)), landed = many.filter((f) => { const g = b.V.get(RD + "/" + f.rel); return g && g.equals(f.data); }).length;
    ok(`CHUNKING: 300 files with long names go over in ${pushScripts.length} chunks, each script under ${L.SCRIPT_MAX} characters (the longest ${Math.max(...pushScripts.map((s) => s.length))}), each chunk read back by sha256 before the next; all 300 landed`, n === 300 && landed === 300 && pushScripts.length >= 8 && pushScripts.every((s) => s.length < L.SCRIPT_MAX) && b.V.S.longest < L.FAKE_CUT, { n, landed, chunks: pushScripts.length });
    const one = err(() => PS.pushRemote(b.V.ssh, RD, many, { lock: null }));
    ok("the control: the SAME 300 files in ONE script are cut on the way and refused (what happened on 2026-10-10) — so a return to unchunked lists fails this selftest", /push to .* failed/.test(one || "") && /here-document/.test(one || ""), one);
    const names = many.map((f) => f.rel).concat(Array.from({ length: 200 }, (_, i) => `pm-book/selftest/absent-${i}.json`)), c0 = b.V.S.calls.length, m = L.shasOf(b.V.ssh, RD, names), shaScripts = b.V.S.calls.slice(c0);
    ok(`chunked sha256 read-back of 500 names (${shaScripts.length} scripts, each under the limit): every present file's sha, every absent one null, none missing`, m.size === 500 && many.every((f) => m.get(f.rel) === sha(f.data)) && m.get("pm-book/selftest/absent-7.json") === null && shaScripts.length >= 5 && shaScripts.every((s) => s.length < L.SCRIPT_MAX), shaScripts.length);
    ok("chunksOf: an empty list makes no chunk; one item over the limit still goes alone (never dropped); order is kept", L.chunksOf([], () => 1, 10).length === 0 && L.chunksOf(["x"], () => 99999, 10).length === 1 && L.chunksOf([1, 2, 3, 4, 5], () => 2000, 100).map((c) => c.join("")).join("|") === "12|34|5"); }

  // the live marker's program, RUN for real (it is plain node: the exact text the VPS runs, in a temp folder here)
  { const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w7-live-")), f = path.join(tmp, "data", "pm-book", "live.json"); fs.mkdirSync(path.dirname(f), { recursive: true });
    const prog = (/ -e '(.*)' '/.exec(REMOTE.liveMarker({}).split("\n").pop()) || [])[1], run = (extra) => cp.spawnSync(process.execPath, ["-e", prog, JSON.stringify(extra)], { cwd: tmp, encoding: "utf8", windowsHide: true });
    try {
      const t0 = Date.now(), r1 = run({ unit: SERVICE, by: BY, selftest: { passed: 121, at: "2026-10-12T18:00:00Z" } }), a = L.parseLive(r1.stdout), bytes1 = fs.existsSync(f) ? fs.readFileSync(f) : null;
      const r2 = run({ unit: "another", by: "a later run" }), b2 = L.parseLive(r2.stdout);
      ok("the live marker's program, RUN here exactly as the VPS runs it: the first run writes data/pm-book/live.json with its own clock's liveAt and what it was given; a SECOND run keeps the file byte-for-byte and prints the first liveAt (the marker is never rewritten)", r1.status === 0 && a && a.how === "written" && a.live.unit === SERVICE && a.live.selftest.passed === 121 && Date.parse(a.live.liveAt) >= t0 - 1000 && Date.parse(a.live.liveAt) <= Date.now() + 1000 && bytes1 && JSON.parse(bytes1.toString()).liveAt === a.live.liveAt && r2.status === 0 && b2 && b2.how === "kept" && b2.live.liveAt === a.live.liveAt && b2.live.unit === SERVICE && fs.readFileSync(f).equals(bytes1) && fs.readdirSync(path.dirname(f)).join() === "live.json", [r1.stdout, r1.stderr, r2.stdout].join(" | "));
      fs.chmodSync(f, 0o666); fs.writeFileSync(f, "{ torn"); const r3 = run({ unit: SERVICE }), torn = fs.readFileSync(f, "utf8"); fs.writeFileSync(f, '{"schema":"pm-book-live-v1"}'); const r4 = run({ unit: SERVICE });
      ok("a live marker that does not parse, or holds no liveAt, makes the program FAIL and is left as it is (a damaged marker is investigated, never replaced with a new liveAt)", r3.status !== 0 && torn === "{ torn" && !/LIVE (written|kept)/.test(r3.stdout) && r4.status !== 0 && fs.readFileSync(f, "utf8") === '{"schema":"pm-book-live-v1"}' && /holds no liveAt/.test(r4.stderr), [r3.status, r4.status, r4.stderr.split("\n")[0]]);
    } finally { try { fs.chmodSync(f, 0o666); } catch { /* gone */ } fs.rmSync(tmp, { recursive: true, force: true }); } }

  // the probe's judgement
  { const good = { who: "traids", node: "v24.16.0", nodeMajor: 24, sudo: true, systemd: 255, backend: true, alert: true, alertUnit: true, ntp: "yes", avail: 120 * GiB, epoch: 1791828000 }, now = 1791828000000, J = (o) => probeJudge({ ...good, ...o }, now);
    const floor = DISK.needBytes(DISK.floorDays), span = DISK.needBytes(DISK.spanDays);
    ok("probe: a ready VPS passes with nothing to say; each missing piece is a named refusal (user, node, sudo, systemd < 243, backend, alert path, clock 5 minutes off)", J({}).refuse.length === 0 && J({}).attention.length === 0 && /not traids/.test(J({ who: "root" }).refuse.join()) && /Node 24 or newer/.test(J({ nodeMajor: 22, node: "v22.11.0" }).refuse.join()) && /sudo -n/.test(J({ sudo: false }).refuse.join()) && /older than 243/.test(J({ systemd: 242 }).refuse.join()) && J({ systemd: 243 }).refuse.length === 0 && /is missing/.test(J({ backend: false }).refuse.join()) && /alert path/.test(J({ alertUnit: false }).refuse.join()) && /differs from this PC by 300 s/.test(J({ epoch: 1791828300 }).refuse.join()) && J({ epoch: 1791828299 }).refuse.length === 0, J({ epoch: 1791828300 }));
    ok(`probe, DISK: under the floor (${gib(floor)} = guard + 2 plain days + 7 archived days) -> REFUSED; exactly at the floor -> not refused, but a loud line (it cannot hold the 30-day span, ${gib(span)}); at the span -> silent; unreadable -> refused`, /under/.test(J({ avail: floor - 1 }).refuse.join()) && J({ avail: floor }).refuse.length === 0 && /registered 30-day span/.test(J({ avail: floor }).attention.join()) && /holds about 7 archived days/.test(J({ avail: floor }).attention.join()) && J({ avail: span }).attention.length === 0 && /could not be read/.test(J({ avail: NaN }).refuse.join()), [J({ avail: floor }).attention]);
    ok("probe: a clock the VPS itself calls unsynchronised is a loud line (every row is stamped with it), never a silent pass and not a refusal", /NOT synchronised/.test(J({ ntp: "no" }).attention.join()) && J({ ntp: "no" }).refuse.length === 0 && /NOT synchronised/.test(J({ ntp: "unknown" }).attention.join()));
    const EST = require(path.join(HERE, "disk-estimate.cjs")), E = EST.estimate(), near = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
    ok(`DISK: the precheck's figures come from the measurement, with a margin and no more — ${gib(DISK.plainPerDay)} plain and ${gib(DISK.gzPerDay)} archived a day against the probes' ${(E.plainPerDay / GiB).toFixed(2)} and ${(E.gzPerDay / GiB).toFixed(2)} GiB (never under the measured figure, never more than a quarter above it); the 7 lines add up to the totals`, DISK.plainPerDay >= E.plainPerDay && DISK.plainPerDay <= 1.25 * E.plainPerDay && DISK.gzPerDay >= E.gzPerDay && DISK.gzPerDay <= 1.25 * E.gzPerDay && Object.keys(E.rows).length === 7 && near(Object.values(E.rows).reduce((a, r) => a + r.plain, 0), E.plainPerDay) && near(Object.values(E.rows).reduce((a, r) => a + r.gz, 0), E.gzPerDay) && Object.values(E.rows).every((r) => r.plain > 0 && r.ratio > 2 && r.gz < r.plain) && E.rows["pm5/ws"].plain > 0.8 * E.plainPerDay, [E.plainPerDay, E.gzPerDay]);
    const st0 = (bytes, gz6Bytes, spanMs, kinds = {}) => ({ bytes, gz6Bytes, spanMs, kinds }), H0 = EST.estimate({ scout: { k15Prints: 100, k15PrintSeconds: 10 }, probes: [{ id: 1, startedUtc: "x", seconds: 10, tapeReads: { pm5: [{ rows: 10, done: true }], k15: [] },
      streams: { "pm5/ws": st0(1000, 100, 10000), "k15/book": st0(200, 100, 10000), "spot/ws": st0(300, 100, 10000), "pm5/tape": st0(500, 250, 0), "k15/tape": st0(2000, 500, 0, { tr: { rows: 10, bytes: 2000 } }), "pm5/ref": st0(900, 300, 0, { mk: { rows: 3, bytes: 900 } }), "k15/ref": st0(400, 200, 0, { mk: { rows: 4, bytes: 400 } }) } }] });
    ok("the estimate's arithmetic on a hand-built probe file: 100 B/s for a day = 8,640,000 B and a tenth of it archived; a 500 B tape x 288 windows = 144,000; 200 B a print x 10 prints a second x 86,400 = 172,800,000; 300 B a record x 3 x 288 = 259,200; 100 B x 4 x 96 = 38,400; totals 186,201,600 plain and 45,969,600 archived", near(H0.rows["pm5/ws"].plain, 8640000) && near(H0.rows["pm5/ws"].gz, 864000) && near(H0.rows["k15/book"].plain, 1728000) && near(H0.rows["spot/ws"].gz, 864000) && near(H0.rows["pm5/tape"].plain, 144000) && near(H0.rows["pm5/tape"].gz, 72000) && near(H0.rows["k15/tape"].plain, 172800000) && near(H0.rows["k15/tape"].gz, 43200000) && near(H0.rows["pm5/ref"].plain, 259200) && near(H0.rows["k15/ref"].plain, 38400) && near(H0.plainPerDay, 186201600) && near(H0.gzPerDay, 45969600), [H0.plainPerDay, H0.gzPerDay]);
    const pp = parseProbe("traids\nv24.16.0\nSUDO_OK\nsystemd 255 (255.4-1ubuntu8.4)\nBACKEND_OK\nALERT_OK\nALERT_UNIT_OK\nNTP=yes\nAVAIL=128849018880\n1791828000\n");
    ok("probe: the answer is read line by line (user, node, sudo, systemd, the three presence marks, time sync, free bytes, the clock)", pp.who === "traids" && pp.node === "v24.16.0" && pp.nodeMajor === 24 && pp.sudo && pp.systemd === 255 && pp.backend && pp.alert && pp.alertUnit && pp.ntp === "yes" && pp.avail === 128849018880 && pp.epoch === 1791828000 && parseProbe("traids\nv24.1.0\n1791828000\n").sudo === false, pp); }

  // precheck against the fake VPS
  { const b = box(), snap = b.V.snapshot(), mapBytes = fs.readFileSync(b.mapFile), e = err(() => b.D.precheck({ quick: false }));
    ok("precheck on a ready VPS passes and is READ-ONLY: no file, unit or map changes on the VPS, home's map is untouched, no manifest is installed, no state file is written", e === null && b.V.snapshot() === snap && fs.readFileSync(b.mapFile).equals(mapBytes) && fs.readdirSync(path.join(b.tmp, "manifests")).length === 0 && !fs.existsSync(path.join(b.tmp, "deploy-state.json")) && /staged selftests: selftest stub: green/.test(b.text()) && /recorder code: pm-book-recorder\.js absent, lib\/pm-feeds\.js absent/.test(b.text()), e || b.text());
    const R = (mut, re, name) => { const x = box(); mut(x); const m = err(() => x.D.precheck({ quick: true })); ok(name, re.test(m || ""), m); };
    R((x) => { x.V.S.whoami = "root"; }, /not ready — REFUSED: .*not traids/, "precheck: the wrong ssh user -> refused");
    R((x) => { x.V.S.down = true; }, /ssh traids failed \(ssh exit 255\)/, "precheck: the VPS unreachable -> refused (an ssh failure is never read as 'absent')");
    R((x) => { x.V.put(RB + "/own-check.cjs", "// another gate"); }, /own-check\.cjs differs from home's/, "precheck: the VPS's own-check.cjs is not home's (the standing gate) -> refused");
    R((x) => { x.V.put(RD + "/host-ownership.json", '{"schema":"host-ownership-v1","units":{}}', "0444"); }, /the VPS map \(.*differs from home's/, "precheck: the VPS map is not home's -> refused before any unit could be added");
    R((x) => { x.V.put(SYSD + "/traids-pm-health.timer", "[Timer]\nOnCalendar=minutely\n"); }, /neither absent nor the staged copies — REFUSED \(drift\): traids-pm-health\.timer/, "precheck: a unit on the VPS that is not the staged copy -> refused (drift)");
    R((x) => { x.V.S.avail = DISK.needBytes(DISK.floorDays) - GiB; }, /free on the data volume is under/, "precheck: too little disk for even a week of recording -> refused");
    R((x) => { fs.writeFileSync(x.mapFile, "{ torn"); }, /home's map: host-ownership\.json does not parse — REFUSED/, "precheck: home's map unreadable -> refused before any ssh");
    const x2 = box(); x2.V.S.ntp = "no"; x2.V.S.avail = DISK.needBytes(10); const e2 = err(() => x2.D.precheck({ quick: true }));
    ok("precheck: an unsynchronised VPS clock and a disk that cannot hold the span pass WITH two ATTENTION lines", e2 === null && (x2.text().match(/ATTENTION — /g) || []).length === 2 && /time sync NOT confirmed/.test(x2.text()), e2 || x2.text());
    const x3 = box({ deps: { stagedSelftest: () => ({ status: 1, stdout: "FAIL  deploy --selftest\nSELFTEST: 1 of 9 checks FAILED\n" }) } }), e3 = err(() => x3.D.precheck({ quick: false }));
    ok("precheck: failing staged selftests refuse BEFORE any ssh call is made", /staged selftests FAILED — REFUSED/.test(e3 || "") && x3.V.S.calls.length === 0, e3); }

  // copy
  { const b = box(), r1 = b.D.stepCopy(), st = b.D.readState().steps.copy, home = CODE.map((c) => L.homeBytes(L.REPO, c.home));
    ok("copy: both files uploaded and read back by sha256 (the VPS holds home's exact bytes), node --check 2/2 and the recorder's selftest green ON THE VPS; recorded with the selftest line and the shas", r1.uploaded === 2 && CODE.every((c, i) => b.V.get(RB + "/" + c.rel).equals(home[i])) && st.ok === true && /121 passed, 0 failed/.test(st.selftest) && st.selftestPassed === 121 && st.shas["lib/pm-feeds.js"] === sha(home[1]) && st.restartNeeded === false && /2 file\(s\) uploaded and verified/.test(b.text()), st);
    const n0 = b.V.S.calls.filter((s) => /EOF_MV/.test(s)).length, r2 = b.D.stepCopy();
    ok("copy again: idempotent — nothing is uploaded ('already current'), the selftest is run again", r2.uploaded === 0 && b.V.S.calls.filter((s) => /EOF_MV/.test(s)).length === n0 && /already current/.test(b.text()));
    const x = box(); x.V.S.selftestGreen = false; const e = err(() => x.D.stepCopy());
    ok("copy: the recorder's selftest NOT green on the VPS -> the step FAILS and is not recorded ok", /selftest on the VPS is NOT green/.test(e || "") && !(x.D.readState().steps || {}).copy, e);
    const y = box(); y.V.S.corruptPush = true; const e2 = err(() => y.D.stepCopy());
    ok("copy: a file that arrives altered is caught by the read-back ('not what was pushed'); the step fails", /the server's copy is not what was pushed/.test(e2 || "") && !(y.D.readState().steps || {}).copy, e2); }

  // units
  { const b = box(), mapBefore = fs.readFileSync(b.mapFile);
    const e0 = err(() => b.D.stepUnits());
    ok("units before copy: REFUSED ('run the copy step first') — nothing installed, the map untouched on both hosts, no manifest at home", /does not hold home's recorder .*absent.* — REFUSED, nothing installed/.test(e0 || "") && b.V.S.units.size === 0 && fs.readFileSync(b.mapFile).equals(mapBefore) && b.V.get(RD + "/host-ownership.json").equals(mapBefore) && fs.readdirSync(path.join(b.tmp, "manifests")).length === 0, e0);
    b.D.stepCopy();
    // watch the order of what the step does on the VPS
    const seen = []; const real = b.V.ssh; let atStart = null;
    b.D.d.ssh = (script, o) => { const m = /^# w7:([a-z-]+)/.exec(script); const tag = m ? m[1] : /\.host-ownership\.json\.push-/.test(script) ? "map-push" : null; if (tag) seen.push(tag); if (tag === "start") atStart = { svc: { ...b.V.unit(SERVICE) }, timers: L.TIMERS.map((t) => ({ ...b.V.unit(t) })), homeMap: JSON.parse(fs.readFileSync(b.mapFile, "utf8")).units[UNIT], vpsMap: JSON.parse(b.V.get(RD + "/host-ownership.json").toString()).units[UNIT] }; return real(script, o); };
    const r = b.D.stepUnits(), m = b.map(), staged = UN.expected(), st = b.D.readState().steps.units, live = JSON.parse(b.V.get(L.PM + "/live.json").toString());
    ok("units: the map entry is made by the step — \"w7-pm\": \"server\" pushed to the VPS FIRST, then written at home; both maps byte-equal afterwards; no other unit's owner changed; one history line names this step", m.units[UNIT] === "server" && m.units.r309 === "server" && m.units["w1-whales"] === "server" && m.units["w2a-fills"] === "home" && Object.keys(m.units).length === 4 && b.V.get(RD + "/host-ownership.json").equals(fs.readFileSync(b.mapFile)) && m.history.length === 1 && m.history[0].by === BY && m.history[0].to === "server" && seen.indexOf("map-push") >= 0 && seen.indexOf("map-push") < seen.indexOf("install") && b.V.S.modes.get(RD + "/host-ownership.json") === "0444", { units: m.units, seen: seen.slice(0, 8) });
    ok("units: the 5 unit files on the VPS are byte-for-byte the staged ones (each installed only under its own sha256), and the order is install -> verify -> enable -> start -> timers -> live marker", UN.ALL_UNITS.every((u) => b.V.get(SYSD + "/" + u).toString() === staged[u]) && seen.filter((t) => t === "install").length === 5 && seen.join(",").replace(/(install,)+/, "install,").includes("install,verify,enable,unit-state,start,health,timers-on,unit-state,live-marker"), seen.join(","));
    ok("ENABLED BUT NOT STARTED, then started: at the moment the start is sent the recorder is enabled and inactive, both timers enabled and inactive, and BOTH maps already give w7-pm to the server; the step says so", atStart && atStart.svc.enabled === true && atStart.svc.active === "inactive" && atStart.timers.every((t) => t.enabled === true && t.active === "inactive") && atStart.homeMap === "server" && atStart.vpsMap === "server" && /ENABLED — NOT started \(book\.service inactive, nightly\.timer inactive, health\.timer inactive\)/.test(b.text()), atStart);
    ok("units: afterwards the recorder is active (started once, through its real ownership gate), both timers enabled + active, health PASS, all three feeds receiving; recorded with liveAt", b.V.unit(SERVICE).active === "active" && b.V.unit(SERVICE).starts === 1 && L.TIMERS.every((t) => b.V.unit(t).enabled && b.V.unit(t).active === "active") && r.health === "PASS" && r.feeds.receiving.length === 3 && r.feeds.blocked.length === 0 && st.ok === true && st.liveAt === r.liveAt && b.V.S.pages.length === 0, { r, st });
    ok("units: data/pm-book/live.json is written ONCE, read-only, with the SERVER's clock (not this PC's), naming the unit, the green selftest and the code's sha256", r.how === "written" && live.schema === "pm-book-live-v1" && live.liveAt === r.liveAt && Date.parse(live.liveAt) > Date.parse("2026-10-12T18:00:00Z") && Date.parse(live.liveAt) < Date.parse("2026-10-12T18:10:00Z") && live.unit === SERVICE && live.selftest.passed === 121 && live.code["pm-book-recorder.js"] === sha(L.homeBytes(L.REPO, CODE[0].home)) && b.V.S.modes.get(L.PM + "/live.json") === "0444", live);
    ok("units: home's pull manifest is installed as the staged bytes, and the standing pull-server loads it", fs.readFileSync(path.join(b.tmp, "manifests", WAVE + ".json")).equals(fs.readFileSync(path.join(HERE, "manifests", WAVE + ".json"))) && Object.keys(PS.loadManifest(WAVE, path.join(b.tmp, "manifests")).units).join() === UNIT);
    const pull = PS.pullWave(WAVE, { homeDir: b.tmp, manifestDir: path.join(b.tmp, "manifests"), ssh: b.V.ssh, mapFile: b.mapFile, haltFile: b.mapFile, writeStatusFile: false });
    ok("the standing pull then brings home what the manifest names and nothing else: the recorder's status and the live marker (no summary exists yet), JSON only", pull.exit === 0 && fs.existsSync(path.join(b.tmp, "pm-book", "status.json")) && fs.existsSync(path.join(b.tmp, "pm-book", "live.json")) && JSON.parse(fs.readFileSync(path.join(b.tmp, "pm-book", "live.json"), "utf8")).liveAt === r.liveAt && /pulled|update/.test(JSON.stringify(pull.units)), pull.lines);
    // again: idempotent
    b.D.d.ssh = real; const nInst = b.V.S.calls.filter((s) => /^# w7:install/.test(s)).length, nStart = b.V.S.calls.filter((s) => /^# w7:start/.test(s)).length, mapAfter = fs.readFileSync(b.mapFile), r2 = b.D.stepUnits();
    ok("units again: idempotent — nothing reinstalled, the recorder NOT started a second time, the map unchanged, and the live marker KEPT (the first liveAt stands)", b.V.S.calls.filter((s) => /^# w7:install/.test(s)).length === nInst && b.V.S.calls.filter((s) => /^# w7:start/.test(s)).length === nStart && fs.readFileSync(b.mapFile).equals(mapAfter) && r2.how === "kept" && r2.liveAt === r.liveAt && b.V.unit(SERVICE).starts === 1 && /already "server" on both hosts/.test(b.text()), r2);
    // status: read-only
    const snap = b.V.snapshot(), calls = b.V.S.calls.length, l0 = b.lines.length; b.D.status(); const stText = b.lines.slice(l0).join("\n");
    const mutating = b.V.S.calls.slice(calls).filter((s) => /^# w7:(install|enable|start|restart|timers-on|live-marker|stop|remove-units)|EOF_MV|push-/.test(s));
    ok("status is read-only (no mutating script is sent) and shows the steps, both maps equal, each unit as the staged copy + enabled + active, the code as home's and RUNNING, the live marker and the health verdict", mutating.length === 0 && /copy\s+ok at /.test(stText) && /units\s+ok at .* live at /.test(stText) && /map \(home\)\s+w7-pm = server/.test(stText) && /map \(VPS\).* = home's/.test(stText) && /traids-pm-book\.service\s+the staged copy · enabled · active/.test(stText) && /running: this code/.test(stText) && /live marker\s+liveAt /.test(stText) && /health\s+PASS/.test(stText) && /manifest\s+.*installed \(the staged bytes\)/.test(stText), stText);
    ok("status changes nothing on the VPS: every file and every unit state is the same before and after", b.V.snapshot().replace(/status\.json:[0-9a-f]+/, "") === snap.replace(/status\.json:[0-9a-f]+/, ""));
    // the recorder was started on OLDER code than what the VPS holds now (a copy step ran since): seen, said, and fixed only by --restart
    b.V.unit(SERVICE).code = { "pm-book-recorder.js": "0".repeat(64), "lib/pm-feeds.js": "0".repeat(64) };
    const l1 = b.lines.length, rc = b.D.stepCopy(), copyText = b.lines.slice(l1).join("\n"), l2 = b.lines.length; b.D.status(); const st2 = b.lines.slice(l2).join("\n"), startedBefore = JSON.parse(b.V.get(L.PM + "/status.json").toString()).startedAt;
    ok("a copy while the recorder runs: the RUNNING recorder still has the code it started with (its status file names another sha256) — the copy step says so (ATTENTION, --restart), records restartNeeded, and does NOT restart it; --status says OLDER code", rc.restartNeeded === true && /ATTENTION — traids-pm-book\.service is running and still runs the code it started with/.test(copyText) && b.D.readState().steps.copy.restartNeeded === true && b.V.unit(SERVICE).starts === 1 && /running: OLDER code — node docs\/server\/wave7-pm\/deploy\.cjs --restart/.test(st2), copyText);
    const rr = b.D.restart(), startedAfter = JSON.parse(b.V.get(L.PM + "/status.json").toString()).startedAt;
    ok("--restart: the recorder is restarted exactly once, comes back active with a later start time and the copied code's sha256 in its status; recorded", rr.health === "PASS" && b.V.unit(SERVICE).starts === 2 && b.V.S.calls.filter((s) => /^# w7:restart/.test(s)).length === 1 && Date.parse(startedAfter) > Date.parse(startedBefore) && rr.startedAt === startedAfter && b.D.readState().steps.restart.ok === true && /it runs the copied code/.test(b.text()), rr);
    const z = box(), ez = err(() => z.D.restart());
    ok("--restart on a VPS where the unit is not installed and enabled -> refused (it is not a way to start the recorder)", /is not installed and enabled — run the units step/.test(ez || "") && z.V.S.calls.filter((s) => /^# w7:restart/.test(s)).length === 0, ez); }

  // units: the refusals and the honest outcomes
  { const U = (mut, name, check) => { const x = box(); x.D.stepCopy(); const before = fs.readFileSync(x.mapFile); mut(x); const m = err(() => x.D.stepUnits()); ok(name, check(m, x, before), m || x.text().split("\n").slice(-6).join(" / ")); };
    U((x) => { x.V.put(RD + "/host-ownership.json", '{"schema":"host-ownership-v1","units":{"r309":"server"}}', "0444"); }, "units: the VPS map differs from home's -> REFUSED before anything: nothing installed, home's map unchanged, no manifest", (m, x, before) => /VPS map .* differs from home's .* — REFUSED, nothing installed/.test(m || "") && x.V.S.units.size === 0 && fs.readFileSync(x.mapFile).equals(before) && fs.readdirSync(path.join(x.tmp, "manifests")).length === 0);
    U((x) => { x.V.S.selftestGreen = false; }, "units: the recorder's selftest on the VPS is not green NOW -> REFUSED: nothing installed, no map entry, no live marker", (m, x, before) => /selftest on the VPS is NOT green/.test(m || "") && x.V.S.units.size === 0 && fs.readFileSync(x.mapFile).equals(before) && !x.V.get(L.PM + "/live.json"));
    U((x) => { x.V.put(SYSD + "/traids-pm-book.service", "[Service]\nExecStart=/bin/true\n"); }, "units: an installed unit that is not the staged copy -> REFUSED (drift), never overwritten", (m, x) => /differ from the staged copies — REFUSED \(drift\), nothing installed: traids-pm-book\.service/.test(m || "") && x.V.get(SYSD + "/traids-pm-book.service").toString() === "[Service]\nExecStart=/bin/true\n");
    U((x) => { x.V.S.sudo = false; }, "units: the map push does not land on the VPS (sudo refused there) -> home's map is NOT changed (the two never differ), nothing installed", (m, x, before) => /pushing the map to the VPS did not land — nothing installed, home's map unchanged/.test(m || "") && fs.readFileSync(x.mapFile).equals(before) && x.V.get(RD + "/host-ownership.json").equals(before) && x.V.S.units.size === 0);
    U((x) => { fs.writeFileSync(path.join(x.tmp, "manifests", WAVE + ".json"), '{"schema":"pull-manifest-v1","wave":"w7-pm","someone":"else"}'); }, "units: a different manifest already at home is never overwritten -> REFUSED before the map or any unit is touched", (m, x, before) => /exists and is not the staged manifest — REFUSED/.test(m || "") && fs.readFileSync(x.mapFile).equals(before) && x.V.S.units.size === 0 && /someone/.test(fs.readFileSync(path.join(x.tmp, "manifests", WAVE + ".json"), "utf8")));
    U((x) => { x.V.S.ownCheck = 255; }, "units: own-check ON THE VPS does not say 'run' for the unit after the map entry (its gate would fail every start and page) -> the step stops there: no unit is installed, nothing is started, no live marker", (m, x) => /own-check on the VPS does not say run for w7-pm \(exit 255\) — nothing installed/.test(m || "") && x.V.S.units.size === 0 && x.V.S.calls.filter((s) => /^# w7:(install|enable|start)/.test(s)).length === 0 && !x.V.get(L.PM + "/live.json") && !(x.D.readState().steps || {}).units);
    U((x) => { x.V.S.condition = 77; }, "units: the recorder's ownership gate SKIPS it at the start (Result=exec-condition) -> the step fails saying so; the timers are NOT started and NO live marker is written", (m, x) => /did not start \(state inactive, result exec-condition\) — its ownership gate skipped it/.test(m || "") && L.TIMERS.every((t) => x.V.unit(t).active === "inactive") && !x.V.get(L.PM + "/live.json") && !(x.D.readState().steps || {}).units);
    U((x) => { x.V.S.condition = 255; }, "units: the recorder FAILS to start -> the step fails ('NOTHING' is recording is never reported as live): timers not started, no live marker, not recorded ok", (m, x) => /did not start \(state failed, result exit-code\)/.test(m || "") && L.TIMERS.every((t) => x.V.unit(t).active === "inactive") && !x.V.get(L.PM + "/live.json") && !(x.D.readState().steps || {}).units);
    U((x) => { x.V.S.staleStatus = true; }, "units: the unit is active but its status file is not fresh -> the step fails (a recorder that is up and not writing is not live): no timers, no live marker", (m, x) => /is active but its status file is 6\d\d s old/.test(m || "") && L.TIMERS.every((t) => x.V.unit(t).active === "inactive") && !x.V.get(L.PM + "/live.json"));
    U((x) => { x.V.S.blocked = "k15"; }, "units: a venue that REFUSES the server (Kalshi blocked at the first start) is reported loudly and is NOT a failed step: the unit is live, the marker is written, health FAIL is recorded, the other two feeds receive", (m, x) => m === null && /ATTENTION — k15\.book is BLOCKED: refusal \(HTTP 403\).*never routed around.*CANNOT MEASURE/.test(x.text()) && x.D.readState().steps.units.health === "FAIL" && x.D.readState().steps.units.feeds.blocked.join() === "k15.book" && x.D.readState().steps.units.feeds.receiving.length === 2 && !!x.V.get(L.PM + "/live.json") && L.TIMERS.every((t) => x.V.unit(t).active === "active"));
    U((x) => { x.V.S.feedsSilent = true; x.h0 = x.V.S.calls.filter((s) => /^# w7:health/.test(s)).length; x.t0 = x.V.S.clock; }, "units: feeds that receive nothing are waited for — 10 looks over the full 90 s, not sooner and not forever — then named ('NOT yet'); the unit is live and the health timer pages if they stay silent", (m, x) => m === null && /feeds: none receiving yet · NOT yet: spot\.ws \(.*\), k15\.book \(.*\), pm5\.ws \(.*\)|feeds: none receiving yet · NOT yet: spot\.ws, k15\.book, pm5\.ws/.test(x.text()) && x.V.S.calls.filter((s) => /^# w7:health/.test(s)).length === x.h0 + 10 && x.V.S.clock - x.t0 >= 90000 && x.V.S.clock - x.t0 < 150000 && x.D.readState().steps.units.feeds.quiet.length === 3);
    U((x) => { OWN.writeMap(x.mapFile, { ...JSON.parse(fs.readFileSync(x.mapFile, "utf8")), units: { ...JSON.parse(fs.readFileSync(x.mapFile, "utf8")).units, [UNIT]: "home" } }); x.V.put(RD + "/host-ownership.json", fs.readFileSync(x.mapFile), "0444"); }, "units after a rollback (the map says \"w7-pm\": \"home\" on both): the step sets it back to \"server\" itself, VPS first, and says what it was", (m, x) => m === null && x.map().units[UNIT] === "server" && /"w7-pm": "server" \(was "home"\)/.test(x.text()) && x.V.get(RD + "/host-ownership.json").equals(fs.readFileSync(x.mapFile))); }

  // THE TIMERS ARE BELIEVED ONLY ON THEIR READ-BACK (the review of 2026-10-12): the fake VPS now starts the timers the script NAMES,
  // and a timer can be answered with exit 0 and not be active — only the units' state, read afterwards, shows it
  { const HT = "traids-pm-health.timer", x = box(); x.D.stepCopy(); x.V.S.stuck.add(HT);
    const sent = (name) => x.V.S.calls.filter((s) => new RegExp("^# w7:" + name).test(s)).length, m = err(() => x.D.stepUnits());
    ok("units: THE TIMERS DO NOT COME UP (systemctl answers the start with exit 0, the script prints TIMERS_ON, and the health timer — the pager — is not active): the step FAILS at its read-back and names it ('traids-pm-health.timer enabled/inactive'); NO live marker is written (the marker's script is not even sent) and the step is not recorded ok, although the recorder itself is running",
      /^not enabled \+ active after the start: traids-pm-health\.timer enabled\/inactive$/.test(m || "") && sent("timers-on") === 1 && sent("live-marker") === 0 && !x.V.get(L.PM + "/live.json") && !(x.D.readState().steps || {}).units && x.V.unit(SERVICE).active === "active" && x.V.unit("traids-pm-nightly.timer").active === "active" && x.V.unit(HT).active === "inactive" && !/ 7 LIVE/.test(x.text()), m);
    x.V.S.stuck.clear(); const r = x.D.stepUnits(), live = x.V.get(L.PM + "/live.json");
    ok("…and once the timer does start, the same step goes through: the recorder is not started a second time, both timers are enabled + active, and the live marker is written THEN", r.how === "written" && !!live && JSON.parse(live.toString()).liveAt === r.liveAt && x.V.unit(SERVICE).starts === 1 && L.TIMERS.every((t) => x.V.unit(t).enabled === true && x.V.unit(t).active === "active") && x.D.readState().steps.units.ok === true && sent("live-marker") === 1, r);
    const y = box(); y.D.stepCopy(); const real = y.V.ssh; y.D.d.ssh = (s, o) => { if (/^# w7:timers-on/.test(s)) y.V.S.systemctlRefused = true; return real(s, o); };
    const m2 = err(() => y.D.stepUnits());
    ok("units: sudo REFUSES the timers' start (the script then prints no TIMERS_ON and exits 1): the step fails there — no timer is active, no live marker, not recorded ok", /starting the timers failed/.test(m2 || "") && L.TIMERS.every((t) => y.V.unit(t).active === "inactive") && !y.V.get(L.PM + "/live.json") && !(y.D.readState().steps || {}).units, m2); }

  // THE MAP, when the two copies are not byte-equal (the review of 2026-10-12): this step's own half is finished; anything else is refused with the command that settles it
  { const b = box(); b.D.stepCopy(); const homeBefore = fs.readFileSync(b.mapFile), realWrite = OWN.writeMap, mapPushes = () => b.V.S.calls.filter((s) => /\.host-ownership\.json\.push-/.test(s)).length;
    OWN.writeMap = () => { throw new Error("EIO: i/o error, write"); };   // the statement after the push does not happen (the disk, or the PC, gave out)
    let e1; try { e1 = err(() => b.D.stepUnits()); } finally { OWN.writeMap = realWrite; }
    const vpsHalf = b.V.get(RD + "/host-ownership.json"), halfState = [JSON.parse(vpsHalf.toString()).units[UNIT], UNIT in b.map().units, fs.readFileSync(b.mapFile).equals(homeBefore), b.V.S.units.size, mapPushes()];
    const l0 = b.lines.length, ePre = err(() => b.D.precheck({ quick: true })), preText = b.lines.slice(l0).join("\n"), ls = b.lines.length; b.D.status(); const halfStatus = b.lines.slice(ls).join("\n");
    ok("…and --status says what that state is, and the two ways out of it (the units step again, or the rollback)", /map \(VPS\)\s+\S+ DIFFERS from home's\n\s+it is home's map plus "w7-pm": "server": a units step that stopped between its two map writes\. Run that step again \(it takes the VPS's bytes home\), or stop everything: node docs\/server\/wave7-pm\/rollback\.cjs --server/.test(halfStatus) && fs.readFileSync(b.mapFile).equals(homeBefore), halfStatus.split("\n").filter((l) => /map|home's/.test(l)));
    const l1 = b.lines.length, r = b.D.stepUnits(), unitsText = b.lines.slice(l1).join("\n");
    ok("A UNITS STEP THAT DIED BETWEEN ITS TWO MAP WRITES (the map pushed to the VPS, home's write failed): the VPS names \"w7-pm\": \"server\", home's map does not name it, nothing is installed. The precheck does not refuse it (one ATTENTION line), and the step, run again, takes the VPS's exact bytes home — no second push — and goes on to the end: units installed, the recorder running, the live marker written", /EIO/.test(e1 || "") && halfState.join() === "server,false,true,0,1" && ePre === null && /ATTENTION — the VPS map already holds "w7-pm": "server" and home's does not/.test(preText) && /map = home's plus this unit's entry/.test(preText) && fs.readFileSync(b.mapFile).equals(vpsHalf) && b.V.get(RD + "/host-ownership.json").equals(vpsHalf) && mapPushes() === 1 && b.map().units[UNIT] === "server" && b.map().history.length === 1 && /3 map: the VPS already held "w7-pm": "server" .* home's map now holds the VPS's exact bytes; no second push/.test(unitsText) && r.how === "written" && r.installed === 5 && b.V.unit(SERVICE).active === "active" && r.health === "PASS", { e1, halfState, ePre, pushes: mapPushes(), r });
    // exactness: home's map plus the entry AND anything else is not this step's half — it is refused, never taken home
    const N = (name, mutVps, re) => { const x = box(); x.D.stepCopy(); const hb = fs.readFileSync(x.mapFile), vm = L.withUnit(x.map(), "server", BY, "2026-10-12T18:30:00.000Z"); mutVps(vm); x.V.put(RD + "/host-ownership.json", OWN.mapBytes(vm), "0444"); const m = err(() => x.D.stepUnits()), p = err(() => x.D.precheck({ quick: true })); ok(name, re.test(m || "") && /REFUSED, nothing installed/.test(m || "") && /the VPS map \(.*differs from home's .* — REFUSED/.test(p || "") && re.test(p || "") && fs.readFileSync(x.mapFile).equals(hb) && x.V.S.units.size === 0 && x.V.S.calls.filter((s) => /\.host-ownership\.json\.push-/.test(s)).length === 0, m); };
    N("a VPS map that holds this unit's entry AND gives another unit to another host is not a half-done step: REFUSED by the units step and by the precheck, naming the unit whose owner differs; home's map untouched, nothing pushed, nothing installed", (vm) => { vm.units["w1-whales"] = "home"; }, /they differ in the owner of w1-whales \(home "server", VPS "home"\), w7-pm \(home undefined, VPS "server"\)/);
    N("…and one that holds the entry with one more history line (someone else's): REFUSED the same way — one byte more than this step's own push and it is not taken home", (vm) => { vm.history.push({ at: "2026-10-12T19:00:00.000Z", wave: "w3", to: "home", units: [], by: "someone" }); }, /they differ in the owner of w7-pm \(home undefined, VPS "server"\)/);
    { const x = box(); x.D.stepCopy(); const hb = fs.readFileSync(x.mapFile), halfMap = L.withUnit(x.map(), "server", BY, "2026-10-12T18:30:00.000Z"), real = x.V.ssh;
      x.V.put(RD + "/host-ownership.json", OWN.mapBytes({ ...halfMap, updatedAt: "2026-10-12T18:31:00.000Z" }), "0444");
      x.D.d.ssh = (s, o) => { if (/^# w7:cat/.test(s)) x.V.put(RD + "/host-ownership.json", OWN.mapBytes(halfMap), "0444"); return real(s, o); };   // the map is replaced between the sha256 read and the read of its bytes
      const m = err(() => x.D.stepUnits());
      ok("a VPS map that CHANGES between the two reads of it (its sha256 first, then its bytes) is not taken home, even when the bytes read are exactly this step's own half: they are not the bytes the sha256 was of — REFUSED, home's map untouched, nothing installed", /differs from home's .* — REFUSED, nothing installed/.test(m || "") && fs.readFileSync(x.mapFile).equals(hb) && x.V.S.units.size === 0, m); }
    { const x = box(); x.V.S.files.delete(RD + "/host-ownership.json"); const p = err(() => x.D.precheck({ quick: true })); x.D.stepCopy(); const u = err(() => x.D.stepUnits());
      ok("a VPS that holds NO ownership map: the precheck and the units step refuse and say so (an absent map is never read as 'nothing to compare'), naming where to look; nothing is pushed, nothing installed", [p, u].every((m) => /the VPS map \(null\) differs from home's .*the VPS holds no ownership map/.test(m || "") && /node deploy\/server\/own\.cjs --status w1/.test(m || "")) && /REFUSED, nothing installed/.test(u || "") && x.V.S.units.size === 0 && !x.V.get(RD + "/host-ownership.json"), [p, u]); }
    // bookkeeping only: the two agree on every owner; home's map holds another wave's aborted move that was never pushed
    const y = box(); y.D.stepCopy(); y.D.stepUnits(); const hm = y.map(); hm.history.push({ at: "2026-10-13T20:00:00.000Z", wave: "w2a", to: "server", units: ["w2a-fills"], by: "deploy/server/own.cjs" }, { at: "2026-10-13T20:00:07.000Z", wave: "w2a", to: "home", units: ["w2a-fills"], by: "deploy/server/own.cjs", aborted: "seed: its lock on the VPS is held" }); hm.updatedAt = "2026-10-13T20:00:07.000Z"; OWN.writeMap(y.mapFile, hm);
    const yHome = fs.readFileSync(y.mapFile), yVps = y.V.get(RD + "/host-ownership.json"), nInst = y.V.S.calls.filter((s) => /^# w7:(install|start)/.test(s)).length, eu = err(() => y.D.stepUnits()), ep = err(() => y.D.precheck({ quick: true })), l2 = y.lines.length; y.D.status(); const stText = y.lines.slice(l2).join("\n");
    ok("the two maps agree on every owner and differ only in bookkeeping (another wave's cutover that aborted: two history lines at home, never pushed): the units step and the precheck REFUSE — neither map is changed, nothing is reinstalled or started — and both name the command that settles it, the mover's own for that wave (node deploy/server/own.cjs w2a home); --status says the same. (The stop is not held up by this: rollback.cjs --server pushes home's map)", [eu, ep].every((m) => /they agree on every owner and differ only in their bookkeeping/.test(m || "") && /node deploy\/server\/own\.cjs w2a home \(while home owns that wave's units\), or node deploy\/server\/own\.cjs w2a server/.test(m || "") && /w2a is the wave of the last move in home's map \(2026-10-13T20:00:07\.000Z, to home, aborted\)/.test(m || "")) && /REFUSED, nothing installed/.test(eu || "") && fs.readFileSync(y.mapFile).equals(yHome) && y.V.get(RD + "/host-ownership.json").equals(yVps) && y.V.S.calls.filter((s) => /^# w7:(install|start)/.test(s)).length === nInst && y.V.unit(SERVICE).active === "active" && /map \(VPS\)\s+\S+ DIFFERS from home's\n\s+they agree on every owner and differ only in their bookkeeping.*node deploy\/server\/own\.cjs w2a home/.test(stText), [eu, stText.split("\n").filter((l) => /map|agree/.test(l))]); }

  // THE LIVE MARKER NAMES ONLY A RECORDER THAT IS THE COPIED CODE (the review of 2026-10-12). liveAt is written once and anchors R352's
  // evidence start: a recorder that still runs what it started with, while newer code was copied, never gets it.
  { const b = box(); b.D.stepCopy(); const real = b.V.ssh, zeros = { "pm-book-recorder.js": "0".repeat(64), "lib/pm-feeds.js": "0".repeat(64) }; let failTimers = true;
    const sent = (name) => b.V.S.calls.filter((s) => new RegExp("^# w7:" + name).test(s)).length, liveFile = () => b.V.get(L.PM + "/live.json"), homeSha = Object.fromEntries(CODE.map((c) => [c.rel, sha(L.homeBytes(L.REPO, c.home))]));
    b.D.d.ssh = (s, o) => (failTimers && /^# w7:timers-on/.test(s) ? { ok: false, status: 1, out: "", err: "Failed to enable unit" } : real(s, o));
    const e1 = err(() => b.D.stepUnits()), after1 = [b.V.unit(SERVICE).active, b.V.unit(SERVICE).starts, !!liveFile(), !!(b.D.readState().steps || {}).units].join();   // the recorder is up; the step died before the timers and the marker
    failTimers = false; b.V.unit(SERVICE).code = zeros;   // …and the process that runs is NOT what the VPS holds now (a copy went over since it started)
    const t0 = sent("timers-on"), m0 = sent("live-marker"), s0 = sent("start"), l0 = b.lines.length, e2 = err(() => b.D.stepUnits()), text2 = b.lines.slice(l0).join("\n");
    ok("a units step that started the recorder and died before its marker, then newer code copied, then the units step again WITHOUT --restart: the recorder that runs is not the copied code, so the step STOPS — it names both commands (--restart, then this step again), writes NO live marker (no marker script is even sent), starts no timer and is not recorded ok; the recorder is not started a second time", /starting the timers failed/.test(e1 || "") && after1 === "active,1,false,false"
      && /traids-pm-book\.service is running, but NOT the code that was copied and selftested on the VPS/.test(e2 || "") && /The live marker is written once and for the copied code only, so it was NOT written \(and this run started no timer\)\. Restart first: node docs\/server\/wave7-pm\/deploy\.cjs --restart — then this step again: node docs\/server\/wave7-pm\/deploy\.cjs --step units$/.test(e2 || "")
      && !liveFile() && sent("live-marker") === m0 && sent("timers-on") === t0 && sent("start") === s0 && L.TIMERS.every((t) => b.V.unit(t).active === "inactive") && !(b.D.readState().steps || {}).units && !/ 7 LIVE/.test(text2) && b.V.unit(SERVICE).starts === 1, { e1, after1, e2 });
    const rr = b.D.restart(), r3 = b.D.stepUnits(), live = JSON.parse(liveFile().toString()), running = JSON.parse(b.V.get(L.PM + "/status.json").toString());
    ok("…after --restart the same step goes through: the marker is written THEN, and the code it names is the code that is running (the sha256 in the recorder's own status file) — liveAt is the moment a recorder on the copied code was up, not the earlier start", rr.health === "PASS" && r3.how === "written" && JSON.stringify(live.code) === JSON.stringify(homeSha) && JSON.stringify(running.code) === JSON.stringify(live.code) && Date.parse(live.liveAt) > Date.parse(rr.startedAt) && b.V.unit(SERVICE).starts === 2 && L.TIMERS.every((t) => b.V.unit(t).active === "active") && b.D.readState().steps.units.ok === true && b.D.readState().steps.units.restartNeeded === false, { r3, live: live.code, running: running.code });
    // the same with a marker ALREADY on record: the step still stops (its end state is a recorder on the copied code), and the marker is not touched
    b.V.unit(SERVICE).code = zeros; const bytes = Buffer.from(liveFile()), m1 = sent("live-marker"), e4 = err(() => b.D.stepUnits());
    ok("a recorder running older code with the marker already on record (a copy went over after the unit went live): the units step stops the same way and names --restart; the marker is not asked for and is byte-identical", /is running, but NOT the code that was copied and selftested on the VPS/.test(e4 || "") && /--restart — then this step again/.test(e4 || "") && sent("live-marker") === m1 && liveFile().equals(bytes), e4); }

  // THE PAGER: the health unit's exit status is what the alert path tells one failure from another by
  { const AL = require(path.join(L.DS, "traids-alert.cjs")), b = box(); b.D.stepCopy(); b.D.stepUnits();
    const HU = "traids-pm-health.service", at = (hhmm) => Date.parse(`2026-10-13T${hhmm}:00.000Z`), rcAt = (hhmm) => { b.V.S.clock = at(hhmm); return b.D.readHealth().rc; };
    b.V.S.blocked = "k15"; const rc1 = rcAt("12:00"); b.V.S.feedsSilent = true; const rc2 = rcAt("12:30"); b.V.S.staleStatus = true; const rc3 = rcAt("13:00");
    /** the pages the alert path SENDS for a health check that fails with these exit codes, half an hour apart from 12:00 (its real signature and its real 3-hour hold) */
    const pages = (codes) => { let st = {}; const sent = []; codes.forEach((rc, i) => { const t = at("12:00") + i * 1800000, sig = AL.signature(HU, { Result: "exit-code", ExecMainStatus: String(rc) }, "", t), dd = AL.dedupe(HU, sig, st, t); if (dd.send) { sent.push(i); st = { [HU]: { sig, sentAt: new Date(t).toISOString(), held: 0 } }; } else st = { [HU]: { ...st[HU], held: dd.held } }; }); return sent.join(); };
    ok("THE PAGER, through the alert path's own signature and its own 3-hour hold: 12:00 Kalshi blocked, 12:30 two feeds silent as well, 13:00 the recorder hung — the health check exits 17, 19 and 21, three different failures to the alert path, so all three are sent at once. Were every FAIL exit 1, as it was, only the first would be sent and the other two held until 15:00; the same failure seen again is still held (one page in the 3 hours)", rc1 === 17 && rc2 === 19 && rc3 === 21 && pages([rc1, rc2, rc3]) === "0,1,2" && pages([1, 1, 1]) === "0" && pages([rc1, rc1, rc1, rc1, rc1, rc1, rc1]) === "0,6", { rc: [rc1, rc2, rc3], sent: pages([rc1, rc2, rc3]), before: pages([1, 1, 1]), same: pages([rc1, rc1, rc1, rc1, rc1, rc1, rc1]) }); }

  // NO TEMP FOLDER IS LEFT BEHIND, also when a check throws (the review of 2026-10-12: cleanup was not in a finally)
  { const made = []; let threw = null;
    try { selftest((bs) => { for (let i = 0; i < 2; i++) { const s = sandbox(); bs.push(s); made.push(s.tmp); } fs.writeFileSync(path.join(made[1], "deploy-state.json"), "{}"); throw new Error("a check threw"); }); } catch (e) { threw = e.message; }
    ok("a selftest whose body THROWS leaves no temp folder behind: the two sandboxes it had made (one holding a file) are gone — the cleanup is in a finally — and the error still reaches the caller", threw === "a check threw" && made.length === 2 && made.every((dir) => /w7-deploy-/.test(dir) && !fs.existsSync(dir)), { threw, left: made.filter((dir) => fs.existsSync(dir)) });
    const realFake = L.fakeVps, realMk = fs.mkdtempSync, seen = []; let threw2 = null;
    L.fakeVps = () => { throw new Error("the fake VPS could not be built"); }; fs.mkdtempSync = (...a) => { const dir = realMk(...a); seen.push(dir); return dir; };
    try { sandbox(); } catch (e) { threw2 = e.message; } finally { L.fakeVps = realFake; fs.mkdtempSync = realMk; }
    ok("a sandbox that cannot be BUILT (it fails after its temp folder was made) removes that folder itself and passes the error on", threw2 === "the fake VPS could not be built" && seen.length === 1 && /w7-deploy-/.test(seen[0]) && !fs.existsSync(seen[0]), { threw2, seen });
    const made3 = []; let n0 = null, n1 = null; fs.mkdtempSync = (...a) => { const dir = realMk(...a); made3.push(dir); return dir; };
    try { const V = L.fakeVps(); n0 = made3.length; V.ssh(REMOTE.health()); n1 = made3.length; V.cleanup(); } finally { fs.mkdtempSync = realMk; }
    ok("the fake VPS holds NO temp folder between calls (so a run that is killed leaves none of its): building one makes no folder, and the one a health read needs is made and removed inside that read", n0 === 0 && n1 === 1 && /w7-fakevps-/.test(made3[0]) && !fs.existsSync(made3[0]), { n0, n1, made3 }); }

  // what the deploy is not
  { const src = fs.readFileSync(__filename, "utf8").split("\n// ── selftest:")[0] + fs.readFileSync(path.join(HERE, "w7-lib.cjs"), "utf8").split("\n// ── a fake VPS")[0];
    const modes = src.match(/pm-book-recorder\.js --[a-z]+/g) || [];
    ok("the deploy never names the test registry file, the seals, the change registry or the agent ledger, a key file or a switch file; on the VPS it runs the recorder only as --selftest, --status and --health (the unit alone runs it for real)", !/test-registry|read-seals|change-registry|agent-ledger/.test(src) && !/\.env\b|-OFF\b|-HALT\b|LIVE-ARMED/.test(src.replace(/process\.env/g, "")) && modes.length >= 3 && modes.every((x) => /--(selftest|status|health)$/.test(x)), modes);
    const rms = src.match(/\brm -\S+ .{0,22}/g) || [];
    ok("no remote script deletes data: the only two rm commands are of a temp unit file whose sha256 did not match, and of the 5 unit files in the rollback's --units", rms.length === 2 && rms.every((x) => /^rm -f "\$t"/.test(x) || /^rm -f -- \$\{SYSD\}\/\$u/.test(x)), rms); }

  console.log(`deploy selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;   // (the sandboxes are taken down by selftest()'s finally, whether this line is reached or not)
}

if (require.main === module) {
  let A, RUNNING = null;
  try { A = parseArgs(process.argv.slice(2)); } catch (e) { console.error("deploy: " + e.message); process.exitCode = 2; }
  if (A) try {
    if (A.mode === "selftest") process.exitCode = selftest() ? 0 : 1;
    else {
      const D = make();
      if (A.mode === "status") { D.status(); process.exitCode = 0; }
      else if (A.mode === "restart") { RUNNING = "restart"; D.restart(); process.exitCode = 0; }
      else {
        const one = A.step, run = (name, fn) => { RUNNING = name; fn(); };
        run("precheck", () => D.precheck({ quick: !!one && one !== "precheck" }));
        if (!one || one === "copy") run("copy", D.stepCopy);
        if (!one || one === "units") run("units", D.stepUnits);
        RUNNING = null;
        console.log(`deploy: done${one ? ` (step ${one})` : ""}.${!one || one === "units" ? " Next: node docs/server/wave7-pm/deploy.cjs --status · then, on your word, node docs/server/wave7-pm/record-evidence-start.cjs --dry" : ""}`);
        process.exitCode = 0;
      }
    }
  } catch (e) {
    console.error("deploy: " + (RUNNING ? `step ${RUNNING} FAILED — ` : "") + e.message);
    if (A && A.mode === "deploy" && RUNNING) for (const l of remainingSteps(planOf(A), RUNNING)) console.error(l);
    process.exitCode = 1;
  }
}
module.exports = { make, parseArgs, parseProbe, probeJudge, planOf, remainingSteps, sandbox, closeAll, STEPS, BY };
