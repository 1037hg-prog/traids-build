"use strict";
/**
 * W7 LIB — what deploy.cjs, rollback.cjs, record-evidence-start.cjs and fetch-day.cjs share (docs/server/wave7-pm, R352's recorder).
 * 2026-10-11. Three things:
 *   1. the names and paths of the unit on the VPS, and EVERY remote script this package sends, as plain text built in one place
 *      (REMOTE.*). Each starts with a comment line "# w7:<name>" so a reader of the journal, and the fake VPS below, can tell them apart;
 *   2. the chunked transfers (chunksOf / shasOf / pushVerified), the rule learned on 2026-10-10 by deploy/server/w3-sync.cjs: a remote
 *      script travels as ONE ssh argument and arrived cut at about 8,190 characters, so no script here may grow with a file list;
 *   3. a fake VPS in memory (fakeVps) for the selftests: no ssh, no network. It keeps files, unit states and a clock, answers the
 *      scripts above and pull-server's / own.cjs's own, REFUSES any script longer than the cut (as the real one did), runs the real
 *      own-check decision for the unit's ExecCondition, and the recorder's real --health on the status it holds. The stop and the
 *      timer scripts act on the unit names THEY hold and on no other, do nothing when sudo refuses systemctl (the stop still prints
 *      STOPPED, as on the VPS: every command in it ends "|| true"), and a recorder that is running stops by itself a minute after
 *      the map stops giving it the unit, as the real one does.
 * Nothing here reads the test registry, a ledger, a key file or a switch file.
 */
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", ".."), DS = path.join(REPO, "deploy", "server");
const PS = require(path.join(DS, "pull-server.cjs")), OWN = require(path.join(DS, "own.cjs")), OC = require(path.join(DS, "own-check.cjs"));
const UN = require(path.join(HERE, "units.cjs"));
const { sha, q } = PS;

const HOST = "traids", RB = UN.RB, RD = RB + "/data", PM = RD + "/pm-book", SYSD = "/etc/systemd/system", NODE = UN.NODE;
const UNIT = UN.UNIT, WAVE = "w7-pm", SERVICE = "traids-pm-book.service", TIMERS = UN.TIMERS, ONESHOTS = UN.SERVICES.filter((u) => u !== SERVICE);
/** what the copy step sends (home path -> path under the VPS backend) and what must already be there, equal to home's */
const CODE = [{ rel: "pm-book-recorder.js", home: "backend/pm-book-recorder.js" }, { rel: "lib/pm-feeds.js", home: "backend/lib/pm-feeds.js" }];
const SHARED = [{ rel: "lib/atomic-write.js", home: "backend/lib/atomic-write.js" }, { rel: "own-check.cjs", home: "deploy/server/own-check.cjs" }];
const GiB = 1024 ** 3;
/**
 * DISK, measured (not assumed): the recorder's own --probe from the operator's PC, sizes and rates only — probe-2026-10-12.json, and
 * `node docs/server/wave7-pm/disk-estimate.cjs` prints the table: 10.27 GiB a day plain, 1.12 GiB a day after the nightly gzip. The
 * figures here are those plus under a tenth (deploy.cjs's selftest holds them between the measured value and a quarter above it).
 * plainPerDay = what one UTC day writes before the nightly gzip; gzPerDay = the same day afterwards. Both probes ran in quiet hours,
 * so the precheck's floors are a minimum, never a promise: the first server day's `--status` gives the real rate, and the health
 * check pages when under 24 h of disk is left.
 *   needBytes(days) = the guard (5 GiB, where the recorder refuses to write) + 2 plain days (today's, and yesterday's until the nightly
 *   run has archived it) + `days` archived days.
 */
const DISK = Object.freeze({ guardBytes: 5 * GiB, plainPerDay: Math.round(11.1 * GiB), gzPerDay: Math.round(1.2 * GiB), floorDays: 7, spanDays: 32,
  needBytes(days) { return this.guardBytes + 2 * this.plainPerDay + days * this.gzPerDay; } });

const must = (r, what) => { if (!r || !r.ok) throw new Error(`${what} failed (ssh exit ${r ? r.status : "?"}): ${String((r && (r.err || r.out)) || "").trim().slice(0, 400)}`); return String(r.out); };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const sleepMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const homeBytes = (repo, rel) => fs.readFileSync(path.join(repo, ...rel.split("/")));

// ── chunked transfers ────────────────────────────────────────────────────────────────────────────────────────────────────────
const SCRIPT_MAX = 5000;     // well under the ~8,190 characters at which a script arrived cut (w3-sync.cjs, 2026-10-10)
function chunksOf(items, costOf, base) {
  const out = []; let cur = [], len = base;
  for (const it of items) { const add = costOf(it); if (cur.length && len + add > SCRIPT_MAX) { out.push(cur); cur = []; len = base; } cur.push(it); len += add; }
  if (cur.length) out.push(cur);
  return out;
}
/** sha256 of remote files, asked in chunks (Map rel -> sha | null = absent); an ssh failure THROWS (fail-closed) */
function shasOf(ssh, dir, rels) {
  const m = new Map();
  for (const part of chunksOf(rels, (r) => r.length + 3, 200 + dir.length)) for (const [k, v] of PS.remoteShas(ssh, dir, part)) m.set(k, v);
  return m;
}
/** push files [{ rel, data, mode }] in chunks; each chunk is read back by sha before the next goes (anything else throws) */
function pushVerified(ssh, dir, files) {
  let pushed = 0;
  for (const part of chunksOf(files, (f) => 2 * f.rel.length + 80, 600 + 2 * dir.length)) {
    const r = PS.pushRemote(ssh, dir, part, { lock: null }); if (r.busy) throw new Error(`${dir}: busy`);
    const after = PS.remoteShas(ssh, dir, part.map((f) => f.rel));
    for (const f of part) if (after.get(f.rel) !== sha(f.data)) throw new Error(`${dir}/${f.rel}: the server's copy is not what was pushed`);
    pushed += r.pushed;
  }
  return pushed;
}

// ── the remote scripts (every one this package sends, besides pull-server's and own.cjs's own) ───────────────────────────────
const LIVE_PROGRAM = 'const fs=require("fs"),f="data/pm-book/live.json";let j=null;try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){if(e.code!=="ENOENT")throw e}' +
  'if(j){if(!j.liveAt)throw new Error("live.json holds no liveAt");console.log("LIVE kept "+JSON.stringify(j))}' +
  'else{j=Object.assign({schema:"pm-book-live-v1",liveAt:new Date().toISOString()},JSON.parse(process.argv[1]));const t=f+".tmp-"+process.pid;fs.writeFileSync(t,JSON.stringify(j,null,1));fs.chmodSync(t,0o444);fs.renameSync(t,f);console.log("LIVE written "+JSON.stringify(j))}';
const startLine = (verb) => `sudo -n systemctl ${verb} ${SERVICE}; echo "START rc=$? $(systemctl is-active ${SERVICE}) $(systemctl show ${SERVICE} -p Result --value)"`;
const REMOTE = {
  /** read-only: who we are there, node, sudo, systemd, the alert path, the clock, free space on the data volume */
  probe: () => ["# w7:probe", "set -u", "whoami", `${NODE} -v`, "sudo -n true && echo SUDO_OK", "systemctl --version | head -n 1",
    `test -d ${q(RB)} && echo BACKEND_OK`, `test -f ${q(RB + "/traids-alert.cjs")} && echo ALERT_OK`, `test -f ${SYSD}/traids-alert@.service && echo ALERT_UNIT_OK`,
    'echo "NTP=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)"',
    `echo "AVAIL=$(df -B1 --output=avail ${q(RD)} 2>/dev/null | tail -n 1 | tr -d ' ')"`, "date -u +%s"].join("\n"),
  /** one unit file from stdin -> /etc/systemd/system, root:root 0644, only when its sha256 is the staged one (the house install) */
  install: (unit, shaHex) => [`# w7:install ${unit}`, "set -eu", `t=${q(SYSD + "/." + unit + ".w7-")}$$`, 'sudo -n tee "$t" > /dev/null', 's=$(sudo -n sha256sum "$t" | cut -c1-64)',
    `if [ "$s" != "${shaHex}" ]; then sudo -n rm -f "$t"; echo "sha256 mismatch" >&2; exit 9; fi`, 'sudo -n chmod 644 "$t"', 'sudo -n chown root:root "$t"', `sudo -n mv -f "$t" ${q(SYSD + "/" + unit)}`, "echo installed"].join("\n"),
  verify: (units) => `# w7:verify\nsystemd-analyze verify ${units.map((u) => `${SYSD}/${u}`).join(" ")} && echo VERIFIED`,
  /** ENABLED, NOT STARTED: enable without --now */
  enable: (units) => `# w7:enable\nsudo -n systemctl daemon-reload && sudo -n systemctl enable ${units.join(" ")} >/dev/null 2>&1 && echo ENABLED`,
  unitState: (units) => `# w7:unit-state\nfor u in ${units.join(" ")}; do echo "U $u $(systemctl is-enabled "$u" 2>/dev/null || true) $(systemctl is-active "$u" 2>/dev/null || true)"; done`,
  start: () => "# w7:start\n" + startLine("start"),
  restart: () => "# w7:restart\n" + startLine("restart"),
  timersOn: () => `# w7:timers-on\nsudo -n systemctl enable --now ${TIMERS.join(" ")} >/dev/null 2>&1 && echo TIMERS_ON`,
  /** the recorder's own selftest ON THE SERVER (offline: fake feeds only) and node --check of what was copied */
  serverSelftest: () => ["# w7:server-selftest", `cd ${q(RB)} || exit 7`, `for f in ${CODE.map((c) => c.rel).join(" ")}; do ${NODE} --check "$f" && echo "check ok $f"; done`,
    `${NODE} pm-book-recorder.js --selftest 2>&1 | tail -n 1`, 'echo "SELFTEST_AT $(date -u +%Y-%m-%dT%H:%M:%SZ)"'].join("\n"),
  /** read-only: is the unit active, its status file, and the recorder's own --status and --health as the unit's user sees them */
  health: () => ["# w7:health", `cd ${q(RB)} || exit 7`, 'echo "@@NOW $(date -u +%s)"', `echo "@@ACTIVE $(systemctl is-active ${SERVICE})"`, 'echo "@@STATUSJSON"', "cat data/pm-book/status.json 2>/dev/null || echo null", "echo",
    'echo "@@STATUS"', `${NODE} pm-book-recorder.js --status 2>&1`, 'echo "@@HEALTH"', `${NODE} pm-book-recorder.js --health 2>&1`, 'echo "@@RC $?"'].join("\n"),
  /** data/pm-book/live.json, written ONCE with the server's own clock; an existing one is kept and printed, never replaced */
  liveMarker: (extra) => ["# w7:live-marker", `cd ${q(RB)} || exit 7`, `${NODE} -e '${LIVE_PROGRAM}' ${q(JSON.stringify(extra))}`].join("\n"),
  readLive: () => `# w7:read-live\ncat ${q(PM + "/live.json")} 2>/dev/null || echo ABSENT`,
  /** the health timer first (a check that finds the recorder stopped would page), then the recorder, which closes its files on SIGTERM */
  stop: () => ["# w7:stop", `sudo -n systemctl disable --now ${[...TIMERS].reverse().join(" ")} >/dev/null 2>&1 || true`, `sudo -n systemctl stop ${ONESHOTS.join(" ")} >/dev/null 2>&1 || true`,
    `sudo -n systemctl disable --now ${SERVICE} >/dev/null 2>&1 || true`, `sudo -n systemctl reset-failed ${UN.SERVICES.join(" ")} >/dev/null 2>&1 || true`, "echo STOPPED"].join("\n"),
  removeUnits: (units) => `# w7:remove-units\nfor u in ${units.join(" ")}; do sudo -n rm -f -- ${SYSD}/$u; done; sudo -n systemctl daemon-reload && echo REMOVED`,
  cat: (abs) => `# w7:cat\ncat -- ${q(abs)}`,
};
/** every script above, with the longest arguments this package ever gives them (the selftest proves none comes near the cut) */
function everyScript() {
  const big = { unit: SERVICE, by: "docs/server/wave7-pm/deploy.cjs (units)", selftest: { passed: 999, at: "2026-10-12T18:00:00Z" }, code: Object.fromEntries(CODE.map((c) => [c.rel, "f".repeat(64)])) };
  return { probe: REMOTE.probe(), install: REMOTE.install("traids-pm-nightly.service", "0".repeat(64)), verify: REMOTE.verify(UN.ALL_UNITS), enable: REMOTE.enable(UN.ENABLED), unitState: REMOTE.unitState(UN.ALL_UNITS),
    start: REMOTE.start(), restart: REMOTE.restart(), timersOn: REMOTE.timersOn(), serverSelftest: REMOTE.serverSelftest(), health: REMOTE.health(), liveMarker: REMOTE.liveMarker(big), readLive: REMOTE.readLive(),
    stop: REMOTE.stop(), removeUnits: REMOTE.removeUnits(UN.ALL_UNITS), cat: REMOTE.cat(PM + "/pm5/2026-10-13/ws.0042.jsonl.gz") };
}

// ── parsers of what those scripts print ──────────────────────────────────────────────────────────────────────────────────────
function parseUnitState(out) {
  const m = {};
  for (const l of String(out).split("\n")) { const x = /^U (\S+) (\S*) ?(\S*)$/.exec(l.trimEnd()); if (x) m[x[1]] = x[3] === "" && /^(active|inactive|failed|activating|deactivating)$/.test(x[2]) ? { enabled: "", active: x[2] } : { enabled: x[2], active: x[3] }; }
  return m;
}
function parseStart(out) { const x = /^START rc=(\d+) (\S+) ?(\S*)$/m.exec(String(out)); return x ? { rc: Number(x[1]), active: x[2], result: x[3] } : null; }
function parseSelftest(out) {
  const o = String(out), x = /selftest: (\d+) passed, (\d+) failed/.exec(o), at = /^SELFTEST_AT (\S+)$/m.exec(o);
  return { checks: (o.match(/^check ok /gm) || []).length, passed: x ? Number(x[1]) : null, failed: x ? Number(x[2]) : null, green: !!x && Number(x[1]) > 0 && Number(x[2]) === 0 && /ALL PASSED/.test(o), at: at ? at[1] : null,
    line: (o.split("\n").find((l) => /selftest:/.test(l)) || "").trim() };
}
function parseHealth(out) {
  const o = String(out), now = /^@@NOW (\d+)$/m.exec(o), act = /^@@ACTIVE (\S+)$/m.exec(o), rc = /^@@RC (\d+)$/m.exec(o);
  const js = /@@STATUSJSON\n([\s\S]*?)\n@@STATUS\n/.exec(o), text = /@@STATUS\n([\s\S]*?)\n@@HEALTH\n/.exec(o), hl = /@@HEALTH\n([\s\S]*?)\n@@RC /.exec(o);
  let status = null; try { status = js ? JSON.parse(js[1]) : null; } catch { status = null; }
  const lines = hl ? hl[1].split("\n").filter(Boolean) : [], v = lines.map((l) => /^pm-book health: (PASS|FAIL|UNKNOWN)$/.exec(l)).find(Boolean);
  return { nowMs: now ? Number(now[1]) * 1000 : null, active: act ? act[1] : null, status, statusText: text ? text[1] : "", lines: lines.filter((l) => !/^pm-book health: /.test(l)), verdict: v ? v[1] : null, rc: rc ? Number(rc[1]) : null };
}
function parseLive(out) { const x = /^LIVE (kept|written) (\{.*\})$/m.exec(String(out)); if (!x) return null; try { const j = JSON.parse(x[2]); return j && j.schema === "pm-book-live-v1" && Number.isFinite(Date.parse(j.liveAt)) ? { how: x[1], live: j } : null; } catch { return null; } }
/** the three feeds of a status file: { name: { state, lastRx, why } } and which have received something */
function feedsOf(status) {
  const out = {}; if (!status || !status.feeds) return out;
  for (const [v, name] of [["spot", "spot.ws"], ["k15", "k15.book"], ["pm5", "pm5.ws"]]) {
    const f = status.feeds[name] || null, b = status.venues && status.venues[v] && status.venues[v].blocked;
    out[name] = { state: b ? "blocked" : f ? f.state : "not started", lastRx: f ? f.lastRx : null, why: b ? b.why : f && f.down ? f.down.why : null };
  }
  return out;
}

// ── the home map: one entry, never another unit's ────────────────────────────────────────────────────────────────────────────
/** home's map with w7-pm set to `to` (the same object when it already is); no other unit is touched */
function withUnit(map, to, by, at = new Date().toISOString()) {
  if (to !== "server" && to !== "home") throw new Error("withUnit: bad host");
  if (map.units[UNIT] === to) return map;
  const first = !(UNIT in map.units);
  return { ...map, units: { ...map.units, [UNIT]: to }, updatedAt: at, history: [...(Array.isArray(map.history) ? map.history : []), { at, wave: WAVE, to, units: [UNIT], by, ...(first ? { note: "first entry: a server-only unit (there is no home version of it)" } : {}) }] };
}
/**
 * A HALF-DONE STEP of this package: the map goes to the VPS first and is written at home next, so a run that died between the two
 * leaves the VPS holding exactly home's map plus that one step (w7-pm set to `to`, and its history line). -> that map (its bytes are
 * `vpsBuf`), or null when the VPS map is anything else — one byte more or less and it is not ours to take home.
 */
function halfDone(homeMap, vpsBuf, to) {
  let vm; try { vm = JSON.parse(Buffer.from(vpsBuf).toString("utf8")); } catch { return null; }
  const h = vm && Array.isArray(vm.history) && vm.history.length ? vm.history[vm.history.length - 1] : null;
  if (!vm || !vm.units || vm.units[UNIT] !== to || !homeMap || !homeMap.units || homeMap.units[UNIT] === to || !h || h.wave !== WAVE || h.to !== to || typeof h.by !== "string" || typeof h.at !== "string") return null;
  const next = withUnit(homeMap, to, h.by, h.at);
  return OWN.mapBytes(next).equals(Buffer.from(vpsBuf)) ? next : null;
}
/**
 * What differs between home's map and the VPS's, in words, and THE COMMAND THAT SETTLES IT. Home's map is the master, and the shared
 * mover is what pushes it whole: re-running the move of the wave that was cut short (to `home` while home owns that wave's units, to
 * `server` to finish its cutover). The wave named is the one of the last move in home's map that is not this package's.
 */
function mapDifference(homeMap, vpsMap) {
  const hu = (homeMap && homeMap.units) || {}, vu = (vpsMap && vpsMap.units) || {}, owners = [...new Set([...Object.keys(hu), ...Object.keys(vu)])].filter((u) => hu[u] !== vu[u]);
  const moves = (Array.isArray(homeMap && homeMap.history) ? homeMap.history : []).filter((x) => x && x.wave && x.wave !== WAVE), last = moves.length ? moves[moves.length - 1] : null, w = last ? String(last.wave) : "<wave>";
  return { owners,
    text: !vpsMap ? "the VPS map does not parse as an ownership map" : owners.length ? `they differ in the owner of ${owners.map((u) => `${u} (home ${JSON.stringify(hu[u])}, VPS ${JSON.stringify(vu[u])})`).join(", ")}` : "they agree on every owner and differ only in their bookkeeping (history, updatedAt): a move was written at home and never pushed",
    how: `Home's map is the master, and the mover pushes it whole: node deploy/server/own.cjs ${w} home (while home owns that wave's units), or node deploy/server/own.cjs ${w} server (to finish its move to the server)${last ? ` — ${w} is the wave of the last move in home's map (${last.at}, to ${last.to}${last.aborted ? ", aborted" : ""})` : ""}. Both maps side by side: node deploy/server/own.cjs --status ${w}` };
}

// ── a fake VPS (selftests only) ──────────────────────────────────────────────────────────────────────────────────────────────
const FAKE_CUT = 8000;
function fakeVps(o = {}) {
  const S = {
    files: new Map(), modes: new Map(), units: new Map(), calls: [], pages: [], longest: 0,
    clock: o.now || Date.parse("2026-10-12T18:00:00.000Z"),
    whoami: "traids", nodeV: "v24.16.0", sudo: true, systemd: 255, backend: true, alert: true, alertUnit: true, ntp: "yes", avail: 120 * GiB, skewMs: 0,
    selftestGreen: true, selftestN: 121, down: false, corruptPush: false, blocked: null, staleStatus: false, condition: null, ownCheck: null, feedsSilent: false, host: "vps-fake",
    // systemctlRefused: sudo lets the map push through (its chown and chmod) and refuses systemctl, as a sudoers file that names its
    // commands does. stuck: units on which a start or a stop is answered with exit 0 and whose state does not change.
    systemctlRefused: false, stuck: new Set(),
  };
  const sysOk = () => S.sudo && !S.systemctlRefused;
  // (the fake holds NO temp folder of its own between calls: the one a health read needs is made and removed inside that call, in a
  // finally — so a selftest that throws, or is killed, leaves no w7-fakevps-* folder behind)
  const REC = require(path.join(REPO, "backend", "pm-book-recorder.js"));
  const put = (abs, data, mode = "0644") => { S.files.set(abs, Buffer.isBuffer(data) ? data : Buffer.from(String(data))); S.modes.set(abs, mode); };
  const get = (abs) => S.files.get(abs) || null;
  const iso = (ms) => new Date(ms).toISOString();
  const R = (status, out, err = "") => ({ ok: status === 0, status, out, err });
  const mapText = () => { const b = get(RD + "/host-ownership.json"); return b ? b.toString("utf8") : null; };
  const unit = (u) => S.units.get(u) || null;
  const codeOk = () => CODE.every((c) => get(RB + "/" + c.rel));
  /** the status file the recorder would hold right now (written by the fake on start, refreshed on every read while active) */
  const statusNow = (startedAt, stopped = null) => {
    const feeds = {}, venues = {};
    for (const [v, name] of [["spot", "spot.ws"], ["k15", "k15.book"], ["pm5", "pm5.ws"]]) {
      const b = S.blocked === v ? { venue: v, at: iso(startedAt + 2000), status: 403, why: "refusal (HTTP 403)", url: "https://example.invalid/x", head: "", retries: 0, lastRetryAt: null } : null;
      const rx = b || S.feedsSilent ? null : S.clock - 300;
      feeds[name] = { state: b ? "blocked" : rx == null ? "down" : "ok", lastRx: rx, down: b ? { since: iso(startedAt + 2000), why: "the venue is stopped (blocked): refusal (HTTP 403)" } : null, live: 1, lastRxIso: rx == null ? null : iso(rx) };
      venues[v] = { enabled: true, state: b ? "blocked" : "ok", sends: 3, blocked: b };
    }
    return { schema: "pm-book-status-v1", version: REC.VERSION, code: (unit(SERVICE) && unit(SERVICE).code) || null, sid: iso(startedAt) + "-4242", pid: 4242, host: S.host, startedAt: iso(startedAt),
      asOf: iso(S.staleStatus ? S.clock - 600000 : S.clock), ...(stopped ? { stopped } : {}), feeds, streams: { "spot/ws": { date: iso(S.clock).slice(0, 10), rows: 40, gaps: 0, bytes: 6000, bytesPerHour: 3000000 } }, venues,
      disk: { freeBytes: S.avail, minFreeBytes: 5 * GiB, refusing: false, unknown: false, refusingSince: null, bytesPerHour: 3000000, hoursToGuard: 9999 }, counters: { refusedRows: 0, writeErrors: 0, lastWriteError: null, foreignEvents: 0, clockSteps: 0 }, statuses: {} };
  };
  const writeStatus = (stopped) => { const u = unit(SERVICE); if (u && u.startedAt != null) put(PM + "/status.json", JSON.stringify(statusNow(u.running ? u.runningSince : u.startedAt, stopped), null, 1)); };
  /** systemd starting the recorder: its ExecCondition is the real own-check decision on the map the fake holds */
  const startService = () => {
    const u = unit(SERVICE); if (!u) return { rc: 5, active: "inactive", result: "" };
    const code = S.condition != null ? S.condition : OC.decide(mapText(), UNIT, "server").code;
    if (code === OC.SKIP) { u.active = "inactive"; u.result = "exec-condition"; return { rc: 0, active: "inactive", result: "exec-condition" }; }
    if (code !== 0 || !codeOk()) { u.active = "failed"; u.result = "exit-code"; S.pages.push(SERVICE); return { rc: 1, active: "failed", result: "exit-code" }; }
    u.active = "active"; u.result = "success"; u.running = true; u.startedAt = S.clock; u.runningSince = S.clock; u.starts = (u.starts || 0) + 1;
    u.code = Object.fromEntries(CODE.map((c) => [c.rel, sha(get(RB + "/" + c.rel))]));   // what the process read when it started: a later copy does not change it
    writeStatus(null);
    return { rc: 0, active: "active", result: "success" };
  };
  /**
   * What the running recorder does by itself (Recorder.checkOwner): it re-reads the map once a minute, and once the map gives the
   * unit to home it closes its files and ends with exit 0 — inactive, not failed, still enabled, no page. Here: at the first call
   * that comes a full minute after the map stopped saying server. A map it cannot read (own-check's 255) is never read as that.
   */
  const selfStop = () => {
    const u = unit(SERVICE); if (!u || u.active !== "active") return;
    const d = OC.decide(mapText(), UNIT, "server");
    if (d.code !== OC.SKIP) { u.notOursSince = null; return; }
    if (u.notOursSince == null) { u.notOursSince = S.clock; return; }
    if (S.clock - u.notOursSince < REC.Recorder.OWN_EVERY_MS) return;
    u.active = "inactive"; u.result = "success"; u.running = false; u.notOursSince = null; writeStatus(`not server-owned (${d.why})`);
  };
  const ssh = (script, opt = {}) => {
    script = String(script); S.calls.push(script); S.longest = Math.max(S.longest, script.length); S.clock += 1000;
    const bin = !!opt.binary, none = bin ? Buffer.alloc(0) : "";
    selfStop();
    if (S.down) return R(255, none, "ssh: connect to host traids port 22: Connection timed out");
    if (script.length > FAKE_CUT) return R(2, none, "bash: line 9: warning: here-document at line 9 delimited by end-of-file (wanted `EOF_SHA')");
    const input = opt.input == null ? null : Buffer.isBuffer(opt.input) ? opt.input : Buffer.from(String(opt.input));
    // own.cjs: the map push (atomic, root:root 0444) and the per-unit own-check
    if (/\.host-ownership\.json\.push-/.test(script)) {
      const want = (/!= "([0-9a-f]{64})"/.exec(script) || [])[1];
      if (!input || sha(input) !== want) return R(9, "", "sha256 mismatch after upload");
      if (!S.sudo) return R(10, "", "chown/chmod failed");
      put(RD + "/host-ownership.json", input, "0444"); return R(0, `MAP ${sha(input)}\n`);
    }
    if (/own-check\.cjs "\$u" (server|home)/.test(script)) { const want = /own-check\.cjs "\$u" (server|home)/.exec(script)[1], us = /for u in (.+?); do/.exec(script)[1].split(" ").map((x) => x.replace(/'/g, "")); return R(0, us.map((u) => `OWN ${u} ${S.ownCheck != null ? S.ownCheck : OC.decide(mapText(), u, want).code}`).join("\n") + "\n"); }
    // pull-server: sha256 of named files; a tar of entries; a verified push
    if (/sha256sum -- "\$f"/.test(script)) { const dir = /cd '([^']+)' \|\| exit 7/.exec(script)[1], rels = /for f in (.+?); do if/.exec(script)[1].split(" ").map((x) => x.replace(/^'|'$/g, "")); return R(0, rels.map((r) => `${get(dir + "/" + r) ? sha(get(dir + "/" + r)) : "ABSENT"}  ${r}`).join("\n") + "\n"); }
    if (/tar --format=ustar -cf -/.test(script)) {
      const dir = /cd '([^']+)' \|\| exit 7/.exec(script)[1], named = [...script.matchAll(/'([^']+)'/g)].map((x) => x[1]), out = [];
      for (const [abs, data] of S.files) { if (!abs.startsWith(dir + "/")) continue; const rel = abs.slice(dir.length + 1), top = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : null; if (named.includes(rel) || (top && named.includes(top) && /\.json$/.test(rel))) out.push({ name: rel, data }); }
      return R(0, PS.tarOf(out));
    }
    if (/sha256sum -c --quiet --strict/.test(script)) {
      const dir = /^D='([^']+)'$/m.exec(script)[1], want = new Map(script.split("EOF_SHA")[1].split("\n").filter((l) => /^[0-9a-f]{64} {2}/.test(l)).map((l) => [l.slice(66), l.slice(0, 64)]));
      const modes = new Map(script.split("EOF_MV")[1].split("\n").filter((l) => /^0\d{3} /.test(l)).map((l) => [l.slice(5), l.slice(0, 4)]));
      const ents = PS.untar(input); for (const t of ents) if (want.get(t.name) !== sha(t.data)) return R(1, "", `sha256sum: ${t.name}: FAILED`);
      for (const t of ents) { const d = S.corruptPush ? Buffer.concat([t.data, Buffer.from("\n// altered on the way\n")]) : t.data; put(dir + "/" + t.name, d, modes.get(t.name) || "0644"); }
      return R(0, `PUSHED ${ents.length}\n`);
    }
    const mk = /^# w7:([a-z-]+)(?: (\S+))?/.exec(script), name = mk ? mk[1] : null;
    if (name === "probe") return R(0, [S.whoami, S.nodeV, ...(S.sudo ? ["SUDO_OK"] : []), `systemd ${S.systemd} (${S.systemd}.4-1ubuntu8)`, ...(S.backend ? ["BACKEND_OK"] : []), ...(S.alert ? ["ALERT_OK"] : []), ...(S.alertUnit ? ["ALERT_UNIT_OK"] : []), `NTP=${S.ntp}`, `AVAIL=${Math.round(S.avail)}`, String(Math.round((S.clock + S.skewMs) / 1000))].join("\n") + "\n");
    if (name === "install") {
      const u = mk[2], want = (/!= "([0-9a-f]{64})"/.exec(script) || [])[1];
      if (!S.sudo) return R(1, "", "sudo: a password is required");
      if (!input || sha(input) !== want) return R(9, "", "sha256 mismatch");
      put(SYSD + "/" + u, input, "0644"); if (!S.units.has(u)) S.units.set(u, { enabled: false, active: "inactive", result: "" });
      return R(0, "installed\n");
    }
    if (name === "verify") { const us = [...script.matchAll(new RegExp(SYSD + "/(\\S+)", "g"))].map((x) => x[1]); return us.every((u) => get(SYSD + "/" + u)) ? R(0, "VERIFIED\n") : R(1, "", "Failed to load unit file"); }
    if (name === "enable") {
      if (!sysOk()) return R(1, "", "sudo: a password is required");
      const words = /systemctl enable (.+?) >/.exec(script)[1].split(" "), now = words.includes("--now"), us = words.filter((w) => w !== "--now"); if (!us.every((u) => unit(u))) return R(1, "");
      for (const u of us) { unit(u).enabled = true; if (now) { if (u === SERVICE) startService(); else unit(u).active = "active"; } }   // --now would START them: the step must not ask for it
      return R(0, "ENABLED\n");
    }
    if (name === "unit-state") { const us = /for u in (.+?); do/.exec(script)[1].split(" "); return R(0, us.map((u) => `U ${u} ${unit(u) ? (unit(u).enabled ? "enabled" : "disabled") : ""} ${unit(u) ? unit(u).active : "inactive"}`).join("\n") + "\n"); }
    if (name === "start" || name === "restart") { if (!sysOk()) return R(0, "START rc=1 inactive \n"); const u = unit(SERVICE); if (name === "restart" && u) u.running = false; const r = startService(); return R(0, `START rc=${r.rc} ${r.active} ${r.result}\n`); }
    // the timers the SCRIPT names are the ones acted on (a script that names one timer starts one); `&& echo TIMERS_ON` only when systemctl exits 0
    if (name === "timers-on") {
      const m = /^sudo -n systemctl enable --now (.+?) >\/dev\/null 2>&1 && echo TIMERS_ON$/m.exec(script), us = m ? m[1].split(" ") : [];
      if (!m || !sysOk() || !us.every((t) => unit(t))) return R(1, "");
      for (const t of us) { unit(t).enabled = true; if (!S.stuck.has(t)) unit(t).active = "active"; }
      return R(0, "TIMERS_ON\n");
    }
    if (name === "server-selftest") {
      const lines = CODE.filter((c) => get(RB + "/" + c.rel)).map((c) => `check ok ${c.rel}`);
      return R(0, [...lines, codeOk() ? `pm-book-recorder selftest: ${S.selftestGreen ? S.selftestN : S.selftestN - 2} passed, ${S.selftestGreen ? 0 : 2} failed — ${S.selftestGreen ? "ALL PASSED" : "FAILED"}` : "Error: Cannot find module", `SELFTEST_AT ${iso(S.clock).replace(/\.\d+Z$/, "Z")}`].join("\n") + "\n");
    }
    if (name === "health") {
      const u = unit(SERVICE), running = !!(u && u.active === "active"); if (running) writeStatus(null);
      const sj = get(PM + "/status.json"), root = fs.mkdtempSync(path.join(os.tmpdir(), "w7-fakevps-")); let h;
      try { if (sj) fs.writeFileSync(path.join(root, "status.json"), sj); h = REC.health(root, { nowMs: S.clock, statfs: () => ({ bavail: S.avail / 4096, bsize: 4096 }), cfg: REC.mergeConfig() }); }
      finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* a scanner may hold a file for a moment */ } }
      return R(0, [`@@NOW ${Math.round(S.clock / 1000)}`, `@@ACTIVE ${u ? u.active : "inactive"}`, "@@STATUSJSON", sj ? sj.toString("utf8") : "null", "", "@@STATUS", `PM BOOK RECORDER — ${PM} (fake VPS)`, "@@HEALTH", ...REC.health.print(h), `@@RC ${h.exit}`].join("\n") + "\n");   // (what the recorder's own --health prints, and its exit code)
    }
    if (name === "live-marker") {
      const cur = get(PM + "/live.json"); if (cur) return R(0, `LIVE kept ${JSON.stringify(JSON.parse(cur.toString("utf8")))}\n`);
      const arg = /' '(.*)'$/.exec(script.split("\n").pop()), extra = JSON.parse(arg[1].replace(/'\\''/g, "'")), j = { schema: "pm-book-live-v1", liveAt: iso(S.clock), ...extra };
      put(PM + "/live.json", JSON.stringify(j, null, 1), "0444"); return R(0, `LIVE written ${JSON.stringify(j)}\n`);
    }
    if (name === "read-live") { const cur = get(PM + "/live.json"); return R(0, cur ? cur.toString("utf8") : "ABSENT\n"); }
    // THE STOP, as the VPS runs it: each line acts on the units IT names and on no other (a script that no longer names the recorder
    // leaves it running), only when sudo lets systemctl through — and, since every command ends "|| true", the script prints STOPPED
    // whatever happened. So STOPPED proves nothing: the caller's read-back of the units' state is the only check there is.
    if (name === "stop") {
      for (const line of script.split("\n")) {
        const m = /^sudo -n systemctl (disable --now|stop|reset-failed) (.+?) >\/dev\/null 2>&1 \|\| true$/.exec(line); if (!m || !sysOk()) continue;
        for (const u of m[2].split(" ")) {
          const x = unit(u); if (!x) continue;
          if (m[1] === "reset-failed") { if (x.active === "failed") { x.active = "inactive"; x.result = ""; } continue; }
          if (m[1] === "disable --now") x.enabled = false;
          if (S.stuck.has(u) || x.active !== "active") continue;
          x.active = "inactive"; if (u === SERVICE) { x.running = false; writeStatus("SIGTERM"); }
        }
      }
      return R(0, /^echo STOPPED$/m.test(script) ? "STOPPED\n" : "");
    }
    if (name === "remove-units") { const us = /for u in (.+?); do/.exec(script)[1].split(" "); for (const u of us) { S.files.delete(SYSD + "/" + u); S.modes.delete(SYSD + "/" + u); S.units.delete(u); } return R(0, "REMOVED\n"); }
    if (name === "cat") { const abs = /^cat -- '([^']+)'$/m.exec(script)[1], b = get(abs); return b ? R(0, bin ? b : b.toString("utf8")) : R(1, none, `cat: ${abs}: No such file or directory`); }
    return R(127, none, "fake VPS: unexpected command " + script.slice(0, 80));
  };
  /** a VPS as the earlier waves left it: the shared code, the alert path, home's map */
  const seed = (repo, mapBuf) => { for (const c of SHARED) put(RB + "/" + c.rel, homeBytes(repo, c.home)); put(RB + "/traids-alert.cjs", "// alert"); put(SYSD + "/traids-alert@.service", "[Unit]\n"); if (mapBuf) put(RD + "/host-ownership.json", mapBuf, "0444"); };
  const snapshot = () => [...S.files.entries()].map(([k, v]) => k + ":" + sha(v)).sort().join("\n") + "\n" + [...S.units.entries()].map(([k, v]) => `${k}:${v.enabled}:${v.active}`).sort().join("\n");
  return { ssh, S, put, get, unit, seed, snapshot, cleanup: () => { /* nothing is held between calls (see above); kept for the callers that take a fake VPS down */ } };
}

module.exports = { HERE, REPO, DS, PS, OWN, OC, UN, sha, q, HOST, RB, RD, PM, SYSD, NODE, UNIT, WAVE, SERVICE, TIMERS, ONESHOTS, CODE, SHARED, GiB, DISK, must, readJson, sleepMs, homeBytes,
  SCRIPT_MAX, FAKE_CUT, chunksOf, shasOf, pushVerified, REMOTE, everyScript, parseUnitState, parseStart, parseSelftest, parseHealth, parseLive, feedsOf, withUnit, halfDone, mapDifference, fakeVps };
