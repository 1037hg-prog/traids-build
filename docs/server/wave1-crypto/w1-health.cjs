#!/usr/bin/env node
/**
 * W1 HEALTH — are the W1 recorders the VPS owns running, current and in step with home — and does exactly ONE host run each? 2026-10-07
 * (server migration M4; docs/server/wave1-crypto). Home side, read-only. Installed as backend/lib/w1-health.cjs; preflight.js ("w1
 * server recorders") and ops-health.js (section 7) require it. Same conventions as lib/r309-health.cjs.
 *
 * HOME CHECKS (no ssh, every run): automation/close-chain.cjs read as TEXT (never require()d) and backend/data/chain-status.json:
 *   FAIL  a server-owned unit's chain step is no longer tagged ownedBy (or the runner's ownership block is gone): home would run it
 *         again beside the VPS · the last chain RAN a server-owned unit's step at home after its cutover (both hosts recorded) · the last
 *         chain did NOT run a W1 step because the ownership map was unreadable ("ownership unknown": that day is a permanent gap)
 * WHILE EVERY W1 UNIT IS HOME-OWNED: PASS "W1 runs at home" with NO ssh — unless home's map history shows a W1 unit was ever handed to
 *   the server (or rolled back with --server-down). Then one read-only ssh reads the VPS's map and which real W1 unit files are
 *   installed (no W1 script needed): FAIL "split-brain" when the VPS map still gives an installed unit to the server while home runs it
 *   (the state `own.cjs w1 home --server-down` leaves, or a restored pre-cutover map); UNKNOWN when the VPS cannot be read.
 * OTHERWISE one read-only ssh runs backend/w1-probe.cjs on the VPS (run stamps, newest snapshots, funding store, the server's map, code
 *   shas, the alert path) plus systemctl show / is-enabled / is-active per unit, judged here on node's Date.now() (never `date`):
 *   FAIL     per server-owned unit, any of: its timer not enabled+active · no run stamp although cut over more than cadence + 1 h ago ·
 *            the last run older than cadence + 1 h (25 h) · the last run FAILED (step and exit named) · the last run's OUTPUT CHECK failed
 *            (w1-run.cjs: whales snapshot incomplete, funding store stale) · the newest COMPLETE whales / social snapshot older than 25 h
 *            (that day is a permanent gap) · the funding store's newest period older than 33 h · the server's ownership map differs from
 *            home's (split-brain risk) · the server's code differs from home's (a home edit never deployed; own-check.cjs and
 *            w1-probe.cjs included) · server clock > 5 min off · home's last pull of the unit refused · the PAGING PATH broken on the
 *            VPS (traids-alert.cjs, traids-alert@.service, or a readable backend/.env naming TELEGRAM_BOT_TOKEN — R309's rollback removes
 *            them, and every W1 unit's OnFailure= depends on them)
 *   WARN     a deliberate switch on the server (TRAIDS_STOP / w1-<unit>-OFF) stops the unit · a SHARED lib (lib/atomic-write.js, R309's
 *            too) differs between home and the VPS: the VPS runs its reviewed copy; no W1 step deploys it (NOTES "Later edits")
 *   UNKNOWN  the VPS could not be read, the probe could not be parsed, or home's map / manifest could not be read. As loud as FAIL.
 *   PASS     everything else (including "cut over less than cadence + 1 h ago, awaiting the first server run").
 * In preflight all of FAIL / WARN / UNKNOWN are level WARN, ok=false (DEGRADED, never NO-GO: the W1 recorders gate no home trading);
 * ops-health (section 7, in the chain) pages on a transition.
 *
 *   node backend/lib/w1-health.cjs [--json] [--host traids]      exit 0 PASS · 5 WARN · 3 FAIL · 1 UNKNOWN
 *   node backend/lib/w1-health.cjs --selftest                     fixtures only; no ssh, no file
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");

const NAME = "w1 server recorders";
const LIB = __dirname, BACKEND = path.dirname(LIB), REPO = path.dirname(BACKEND);
const MAP_FILE = path.join(BACKEND, "data", "host-ownership.json"), STATUS_FILE = path.join(BACKEND, "data", "pull-server-status.json");
const CHAIN_FILE = path.join(REPO, "automation", "close-chain.cjs"), CHAIN_STATUS = path.join(BACKEND, "data", "chain-status.json");
const MANIFEST = path.join(REPO, "deploy", "server", "manifests", "w1.json"), PULL_SERVER = path.join(REPO, "deploy", "server", "pull-server.cjs");
const RB = "/home/traids/traids/backend";
const CODE = { PASS: 0, WARN: 5, FAIL: 3, UNKNOWN: 1 }, RANK = { PASS: 0, WARN: 1, FAIL: 2, UNKNOWN: 3 };
const H = 3600000, SKEW_MS = 5 * 60000, SHARED = /^lib\//;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const ago = (ms) => (ms < 90 * 60000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`);
const worstOf = (list) => list.reduce((w, s) => (RANK[s] > RANK[w] ? s : w), "PASS");
/** home path of a code file the server runs: the backend script, or the deploy/server copy of a server-only script */
const homeCodePath = (f) => (/^(w1-run|own-check|w1-probe)\.cjs$/.test(f) ? path.join(REPO, "deploy", "server", f) : path.join(BACKEND, ...f.split("/")));

function probeCommand(units) {
  const parts = [`cd ${RB} || exit 7`, `echo "@@PROBE"; /usr/local/bin/node w1-probe.cjs 2>&1 | tail -n 1`];
  for (const [u, def] of units) parts.push(`echo "@@UNIT ${u}"; systemctl show ${def.systemd.service} --timestamp=unix -p Result -p ExecMainExitTimestamp -p ActiveState 2>&1; echo "timer-enabled=$(systemctl is-enabled ${def.systemd.timer} 2>&1)"; echo "timer-active=$(systemctl is-active ${def.systemd.timer} 2>&1)"`);
  parts.push('echo "@@END"');
  return parts.join("; ");
}
/** while home owns every W1 unit: the VPS's map and which real W1 unit files are installed (read-only; needs no W1 script, so it still
 *  works after rollback.cjs --server removed them) */
function mapProbeCommand(units) {
  return [`cd ${RB}/data || exit 7`, 'echo "@@MAP"', "if [ -f host-ownership.json ]; then cat host-ownership.json; else echo ABSENT; fi", "echo", 'echo "@@UNITS"',
    ...units.map(([u, d]) => `if [ -e /etc/systemd/system/${d.systemd.service} ]; then echo "installed ${u}"; fi`), 'echo "@@END"'].join("; ");
}
function sections(text) {
  const out = {}; let cur = null;
  for (const ln of String(text || "").split(/\r?\n/)) { const m = /^@@(PROBE|UNIT \S+|MAP|UNITS|END)$/.exec(ln.trim()); if (m) { cur = m[1]; out[cur] = []; continue; } if (cur) out[cur].push(ln); }
  return out;
}
/** home facts: the map, the manifest, the pull status, home code shas, the chain's text (tags) and its last status */
function homeFacts() {
  const mapBuf = fs.readFileSync(MAP_FILE), map = JSON.parse(mapBuf.toString("utf8"));
  if (!map || map.schema !== "host-ownership-v1" || !map.units) throw new Error("host-ownership.json is not a host-ownership-v1 map");
  const man = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  let pull = null; try { pull = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")); } catch { pull = null; }
  const code = {}; for (const def of Object.values(man.units)) for (const f of def.code || []) { try { code[f] = sha(fs.readFileSync(homeCodePath(f))); } catch { code[f] = null; } }
  let chainStatus = null; try { chainStatus = JSON.parse(fs.readFileSync(CHAIN_STATUS, "utf8")); } catch { chainStatus = null; }
  const owned = Object.entries(man.units).filter(([u]) => map.units[u] === "server");
  let tagIssues = [];
  if (owned.length) { let text = null; try { text = fs.readFileSync(CHAIN_FILE, "utf8"); } catch { text = null; } tagIssues = require(PULL_SERVER).chainTagIssues(text, owned); }
  return { map, mapSha: sha(mapBuf), man, pull, code, chainStatus, tagIssues };
}
/** the last time each unit was handed to the server (map history) */
function cutoverAt(map, unit) {
  const h = (Array.isArray(map.history) ? map.history : []).filter((x) => x && x.to === "server" && Array.isArray(x.units) && x.units.includes(unit));
  return h.length ? Date.parse(h[h.length - 1].at) : NaN;
}
/** was any W1 unit EVER handed to the server (or rolled back without reaching the VPS)? Then the VPS map can disagree with home's. */
function everServer(map, units) {
  return (Array.isArray(map.history) ? map.history : []).some((x) => x && (x.to === "server" || x.serverDown) && Array.isArray(x.units) && x.units.some((u) => units.includes(u)));
}

/** Pure, no ssh: what the chain text and the last chain-status say. [{ s, d }] */
function homeChainIssues(home) {
  const out = [], cs = home.chainStatus, steps = cs && Array.isArray(cs.steps) ? cs.steps : [], started = cs ? Date.parse(cs.started) : NaN;
  for (const t of home.tagIssues || []) out.push({ s: "FAIL", d: `the close chain does not obey the map: ${t} (re-apply: node docs/server/wave1-crypto/deploy.cjs --step home)` });
  for (const [u, def] of Object.entries(home.man.units)) {
    const names = def.steps || [];
    if (home.map.units[u] === "server") {
      const cut = cutoverAt(home.map, u), ran = steps.filter((x) => x && names.includes(x.name) && x.ok === true);
      if (ran.length && Number.isFinite(started) && Number.isFinite(cut) && started > cut) out.push({ s: "FAIL", d: `SPLIT-BRAIN: the chain of ${cs.started} RAN ${ran.map((x) => `"${x.name}"`).join(", ")} at home although ${u} is server-owned since ${new Date(cut).toISOString()} — both hosts recorded; the next pull of ${u} will be refused` });
    }
    const unk = steps.filter((x) => x && names.includes(x.name) && /ownership unknown/.test(String(x.warn || "")));
    if (unk.length) out.push({ s: "FAIL", d: `the chain of ${cs.started} did NOT run ${unk.map((x) => `"${x.name}"`).join(", ")}: ownership unknown (${String(unk[0].warn).replace(/^ownership unknown, not run \(refusing to guess the host\): /, "").slice(0, 120)}) — that day's ${u} record is a permanent gap; fix backend/data/host-ownership.json` });
  }
  return out;
}
/** Pure: judge the home-owned map probe. Returns { status, code, klass, detail }. */
function evaluateHomeOwned(text, home) {
  const S = sections(text);
  if (!S.MAP || !S.END) throw new Error("incomplete map probe reply");
  const raw = S.MAP.join("\n").trim(), w1 = Object.keys(home.man.units);
  const installed = new Set((S.UNITS || []).map((l) => (/^installed (\S+)$/.exec(l.trim()) || [])[1]).filter(Boolean));
  let vm = null, torn = false; if (raw !== "ABSENT") { try { vm = JSON.parse(raw); } catch { torn = true; } }
  const live = w1.filter((u) => installed.has(u)), v = (status, detail) => ({ status, code: CODE[status], klass: status === "PASS" ? null : status === "FAIL" ? "split-brain" : status.toLowerCase(), detail });
  if (torn || (vm && (vm.schema !== "host-ownership-v1" || !vm.units))) return live.length ? v("FAIL", `W1 runs at home, but the VPS map is not a readable host-ownership-v1 map while ${live.join(", ")} are installed there (own-check fails them at every timer) — push home's map: node deploy/server/own.cjs w1 home`) : v("PASS", "W1 runs at home (the VPS map is unreadable, but no real W1 unit is installed there)");
  const split = w1.filter((u) => vm && vm.units[u] === "server" && home.map.units[u] !== "server");
  const splitLive = split.filter((u) => installed.has(u));
  if (splitLive.length) return v("FAIL", `SPLIT-BRAIN: the VPS map gives ${splitLive.join(", ")} to the server while home's map runs them at home (the state own.cjs w1 home --server-down leaves, or a restored home map) — BOTH hosts record. Stop the VPS: node deploy/server/own.cjs w1 home`);
  if (!vm && live.length) return v("WARN", `W1 runs at home; the VPS has NO map while ${live.join(", ")} are installed there (own-check fails them at every timer, which pages) — push home's map: node deploy/server/own.cjs w1 home`);
  return v("PASS", `W1 runs at home; the VPS map agrees (${vm ? (split.length ? `stale for ${split.join(", ")}, but those units are not installed` : "no W1 unit server-owned there") : "absent, no real W1 unit installed"})`);
}
/** Pure: judge one probe reply. Returns { status, code, klass, detail, units }. */
function evaluate(text, nowMs, home) {
  const serverUnits = Object.entries(home.man.units).filter(([u]) => home.map.units[u] === "server");
  const S = sections(text);
  if (!S.PROBE || !S.END) throw new Error("incomplete probe reply");
  let p; try { p = JSON.parse((S.PROBE.filter((l) => l.trim()).pop() || "").trim()); } catch { throw new Error("w1-probe.cjs output does not parse (missing on the server?)"); }
  if (!p || p.probe !== "w1-probe-v1") throw new Error("not a w1-probe-v1 reply");
  const results = {}, wide = [];
  const skew = Math.abs(p.now - nowMs);
  if (!(skew <= SKEW_MS)) wide.push({ s: "FAIL", d: `server clock is ${Math.round(skew / 1000)} s off` });
  if (!p.map || p.map.sha !== home.mapSha) wide.push({ s: "FAIL", d: `the server's ownership map ${p.map ? p.map.sha.slice(0, 12) : "is MISSING"} differs from home's ${home.mapSha.slice(0, 12)} — split-brain risk: re-run own.cjs` });
  const al = p.alert, alBad = !al ? ["the probe reported no alert path"] : [!al.script && "backend/traids-alert.cjs missing", !al.unit && "traids-alert@.service missing", !al.env && "backend/.env not readable", al.env && !al.token && "backend/.env names no TELEGRAM_BOT_TOKEN"].filter(Boolean);
  if (alBad.length) wide.push({ s: "FAIL", d: `the PAGING PATH on the VPS is broken (${alBad.join(", ")}) — a failing W1 unit would not page (R309's package installs it; its rollback removes it)` });
  const sharedSeen = new Set();
  for (const [u, def] of serverUnits) {
    const bad = [], cad = (def.cadenceHours || 24) * H, limit = cad + H, short = u.replace(/^w1-/, "");
    const sec = (S[`UNIT ${u}`] || []).join("\n");
    if (!/timer-enabled=enabled/.test(sec) || !/timer-active=active/.test(sec)) bad.push({ s: "FAIL", d: `${def.systemd.timer} not enabled+active (${(/timer-enabled=(\S*)/.exec(sec) || [])[1] || "?"}/${(/timer-active=(\S*)/.exec(sec) || [])[1] || "?"})` });
    for (const f of def.code || []) {
      if (p.code && p.code[f] === home.code[f]) continue;
      const d = `code drift: ${f} on the server ${p.code && p.code[f] ? p.code[f].slice(0, 12) : "missing"} ≠ home ${home.code[f] ? home.code[f].slice(0, 12) : "missing"}`;
      if (SHARED.test(f) && p.code && p.code[f] && home.code[f]) { if (!sharedSeen.has(f)) { sharedSeen.add(f); wide.push({ s: "WARN", d: `${d} — a SHARED lib (R309's too): the VPS runs its reviewed copy; no W1 step deploys it (NOTES "Later edits")` }); } }
      else bad.push({ s: "FAIL", d: `${d} (deploy the reviewed change, or roll it back)` });
    }
    const run = p.runs ? p.runs[u] : null, cut = cutoverAt(home.map, u);
    if (!run) { if (Number.isFinite(cut) && nowMs - cut <= limit) bad.push({ s: "PASS", d: `cut over ${ago(nowMs - cut)} ago — awaiting the first server run` }); else bad.push({ s: "FAIL", d: `no run stamp (data/w1-run-${short}.json) on the server${Number.isFinite(cut) ? ` ${ago(nowMs - cut)} after the cutover` : ""}` }); }
    else {
      const fin = Date.parse(run.finishedAt), age = nowMs - fin;
      if (run.stopped) bad.push({ s: "WARN", d: `stopped by data/${run.stopped} on the server` });
      if (!(age <= limit)) bad.push({ s: "FAIL", d: `last run ${Number.isFinite(age) ? ago(age) : "?"} ago (> ${def.cadenceHours || 24} h + 1 h)` });
      if (run.ok === false) { const st = (run.steps || []).find((x) => !x.ok); bad.push({ s: "FAIL", d: `last run FAILED: ${st ? `${st.name} ${st.why || "exit " + st.exit}` : "?"}` }); }
      for (const c of (Array.isArray(run.checks) ? run.checks : []).filter((x) => x && x.ok === false)) bad.push({ s: "FAIL", d: `last run's output check FAILED: ${c.name} — ${String(c.why || "").slice(0, 160)}` });
    }
    if (u === "w1-whales" || u === "w1-social") {
      const nc = (u === "w1-whales" ? p.whales : p.social) || {}, c = nc.newestComplete, age = c ? nowMs - Date.parse(c.recordedAt) : NaN;
      if (!(Number.isFinite(cut) && nowMs - cut <= limit) && !(age <= limit)) bad.push({ s: "FAIL", d: `newest COMPLETE ${short} snapshot ${c ? `${c.day}, ${ago(age)} old` : "absent"} (> 25 h: that day is a permanent gap)${nc.newest && !nc.newest.complete ? ` · the newest (${nc.newest.day}) is incomplete` : ""}` });
    }
    if (u === "w1-funding") {
      const t = p.funding ? p.funding.newestT : null, age = nowMs - t;
      if (!(Number.isFinite(cut) && nowMs - cut <= limit) && !(t && age <= 33 * H)) bad.push({ s: "FAIL", d: `funding store's newest period ${t ? ago(age) + " old" : "absent"} (> 33 h)` });
    }
    const pr = home.pull && home.pull.waves && home.pull.waves.w1 && home.pull.waves.w1.units ? home.pull.waves.w1.units[u] : null;
    if (pr && /^(refused|error)/.test(String(pr.result))) bad.push({ s: "FAIL", d: `home's last pull (${home.pull.waves.w1.at}) ${String(pr.result).slice(0, 160)}` });
    const worst = worstOf(bad.map((x) => x.s));
    results[u] = { status: worst, detail: bad.filter((x) => x.s !== "PASS" || worst === "PASS").map((x) => x.d).join("; ") || `last run ${run ? ago(nowMs - Date.parse(run.finishedAt)) + " ago, ok" : "?"}` };
  }
  const worst = worstOf([...wide.map((x) => x.s), ...Object.values(results).map((r) => r.status)]);
  const detail = [...wide.map((x) => x.d), ...Object.entries(results).map(([u, r]) => `${u} ${r.status === "PASS" ? "ok" : r.status}: ${r.detail}`)].join(" · ");
  return { status: worst, code: CODE[worst], klass: worst === "PASS" ? null : worst.toLowerCase(), detail: `server-owned ${serverUnits.map(([u]) => u).join(", ")} — ${detail}`, units: results };
}
/** fold the home (no-ssh) chain issues into a verdict */
function withChain(v, chainBad) {
  if (!chainBad.length) return v;
  const status = worstOf([v.status, ...chainBad.map((x) => x.s)]);
  return { ...v, status, code: CODE[status], klass: status === "PASS" ? null : v.status === status ? v.klass : "chain", detail: `${chainBad.map((x) => x.d).join(" · ")} · ${v.detail}` };
}

function probe({ host = "traids", timeoutMs = 45000, units, mode = "full" }) {
  return new Promise((res) => {
    if (!/^[A-Za-z0-9._@-]+$/.test(host)) return res({ ok: false, why: "bad host name" });
    cp.execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=12", host, mode === "map" ? mapProbeCommand(units) : probeCommand(units)], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && !stdout) return res({ ok: false, why: `ssh ${host}: ${String(err.killed ? "timed out" : err.message || err).split("\n")[0].slice(0, 120)}${stderr ? " — " + String(stderr).trim().slice(0, 120) : ""}` });
      res({ ok: true, text: stdout });
    });
  });
}
/** One verdict: { status, code, klass, detail }. */
async function run({ host = "traids", nowImpl = Date.now, probeImpl = probe, homeImpl = homeFacts } = {}) {
  let home; try { home = homeImpl(); } catch (e) { return { status: "UNKNOWN", code: 1, klass: "home", detail: `home's ownership map / W1 manifest could not be read (${String(e.message).slice(0, 100)}) — W1 ownership unverified` }; }
  const chainBad = homeChainIssues(home);
  const all = Object.entries(home.man.units), units = all.filter(([u]) => home.map.units[u] === "server");
  const unknown = (klass, detail) => withChain({ status: "UNKNOWN", code: 1, klass, detail }, chainBad);
  if (!units.length) {
    const atHome = `W1 runs at home (no W1 unit server-owned: ${all.map(([u]) => `${u} ${home.map.units[u] || "?"}`).join(", ")})`;
    if (!everServer(home.map, all.map(([u]) => u))) return withChain({ status: "PASS", code: 0, klass: null, detail: atHome }, chainBad);
    // a cutover was made before: the VPS map may still give a unit to the server (--server-down, a restored home map) -> check it
    const p = await probeImpl({ host, units: all, mode: "map" });
    if (!p.ok) return unknown("ssh", `${atHome}, but a cutover was made before and the VPS map could not be read (${p.why}) — split-brain unverified`);
    try { return withChain(evaluateHomeOwned(p.text, home), chainBad); } catch (e) { return unknown("probe", `${atHome}; the VPS map probe could not be judged (${String(e.message).slice(0, 120)})`); }
  }
  const p = await probeImpl({ host, units });
  if (!p.ok) return unknown("ssh", `the VPS could not be read (${p.why}) — the W1 recorders are unverified`);
  try { return withChain(evaluate(p.text, nowImpl(), home), chainBad); } catch (e) { return unknown("probe", `the probe could not be judged (${String(e.message).slice(0, 120)})`); }
}
/** Preflight-shaped: level WARN for FAIL / WARN / UNKNOWN alike (ok=false, DEGRADED), never critical. */
async function check(opts = {}) {
  const v = await run(opts);
  const status = v.status === "PASS" ? "ok" : v.status === "FAIL" ? "CRITICAL" : v.status;
  const detail = v.status === "PASS" ? v.detail : v.status === "UNKNOWN" ? (/^UNKNOWN/.test(v.detail) ? v.detail : `UNKNOWN — ${v.detail}`) : `${v.status} — ${v.detail}`;
  return { name: NAME, level: status === "ok" ? "info" : "warn", ok: status === "ok", detail, status };
}

async function selftest() {
  let pass = 0, fail = 0;
  const chk = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };
  const NOW = Date.parse("2026-10-12T13:00:00Z");
  const man = { units: {
    "w1-whales": { cadenceHours: 24, steps: ["hyperliquid whales record", "r323 hl copy leaders (score)"], systemd: { service: "traids-w1-whales.service", timer: "traids-w1-whales.timer" }, code: ["hyperliquid-whales-record.js", "lib/atomic-write.js", "w1-run.cjs", "own-check.cjs"] },
    "w1-funding": { cadenceHours: 24, steps: ["funding carry collector (#55)"], systemd: { service: "traids-w1-funding.service", timer: "traids-w1-funding.timer" }, code: ["funding-carry-v2.js"] },
    "w1-social": { cadenceHours: 24, steps: ["social mentions record"], systemd: { service: "traids-w1-social.service", timer: "traids-w1-social.timer" }, code: ["social-mentions-record.js", "lib/atomic-write.js"] } } };
  const code = { "hyperliquid-whales-record.js": "a".repeat(64), "w1-run.cjs": "b".repeat(64), "funding-carry-v2.js": "c".repeat(64), "social-mentions-record.js": "d".repeat(64), "lib/atomic-write.js": "f".repeat(64), "own-check.cjs": "9".repeat(64) };
  const CUT = { at: "2026-10-09T21:40:00Z", wave: "w1", to: "server", units: ["w1-whales", "w1-funding", "w1-social"] };
  const mapAll = (h, hist = [CUT]) => ({ schema: "host-ownership-v1", units: { "w1-whales": h, "w1-funding": h, "w1-social": h }, history: hist });
  const home = (o = {}) => ({ map: mapAll("server"), mapSha: "m".repeat(64), man, pull: null, code, chainStatus: null, tagIssues: [], ...o });
  const run0 = (fin, ok = true, o = {}) => ({ unit: "x", finishedAt: fin, ok, steps: ok ? [{ name: "s", ok: true, exit: 0 }] : [{ name: "hyperliquid whales record", ok: false, exit: null, why: "TIMEOUT after 5m" }], checks: [], ...o });
  const ALERT = { script: true, unit: true, env: true, token: true };
  const P = (o = {}) => {
    const pr = { probe: "w1-probe-v1", now: NOW, map: { sha: "m".repeat(64) }, code: { ...code }, alert: ALERT, runs: { "w1-whales": run0("2026-10-11T21:40:00Z"), "w1-funding": run0("2026-10-11T20:31:00Z"), "w1-social": run0("2026-10-11T20:35:20Z") },
      whales: { newestComplete: { day: "2026-10-11", recordedAt: "2026-10-11T21:31:00Z", complete: true }, newest: { day: "2026-10-11", complete: true } },
      social: { newestComplete: { day: "2026-10-11", recordedAt: "2026-10-11T20:35:10Z", complete: true }, newest: { day: "2026-10-11", complete: true } },
      funding: { newestT: Date.parse("2026-10-12T08:00:00Z") }, ...o };
    const timers = o.timers || {};
    return ["@@PROBE", JSON.stringify(pr), ...Object.keys(man.units).flatMap((u) => [`@@UNIT ${u}`, "Result=success", `timer-enabled=${(timers[u] || "enabled/active").split("/")[0]}`, `timer-active=${(timers[u] || "enabled/active").split("/")[1]}`]), "@@END"].join("\n");
  };
  const E = (o, h = home(), now = NOW) => evaluate(P(o), now, h);
  chk("all three current on the server -> PASS", E({}).status === "PASS", E({}).detail);
  const st = E({ runs: { "w1-whales": run0("2026-10-11T10:00:00Z"), "w1-funding": run0("2026-10-11T20:31:00Z"), "w1-social": run0("2026-10-11T20:35:20Z") } });
  chk("a unit's last run older than 25 h -> FAIL (stale), named", st.status === "FAIL" && /w1-whales FAIL: last run 27\.0 h ago/.test(st.detail), st.detail);
  const fl = E({ runs: { "w1-whales": run0("2026-10-11T21:40:00Z", false), "w1-funding": run0("2026-10-11T20:31:00Z"), "w1-social": run0("2026-10-11T20:35:20Z") } });
  chk("the last run FAILED -> FAIL naming the step and why", fl.status === "FAIL" && /hyperliquid whales record TIMEOUT after 5m/.test(fl.detail), fl.detail);
  const oc = E({ runs: { "w1-whales": run0("2026-10-11T21:40:00Z"), "w1-funding": run0("2026-10-11T20:31:00Z", true, { checks: [{ name: "funding store current", ok: false, why: "the store's newest period is older than 9 h for BTC 28.5 h" }] }), "w1-social": run0("2026-10-11T20:35:20Z") } });
  chk("the last run's OUTPUT CHECK failed (w1-run exit 2: funding stale though the collector exited 0) -> FAIL naming it", oc.status === "FAIL" && /w1-funding FAIL: last run's output check FAILED: funding store current/.test(oc.detail), oc.detail);
  const inc = E({ whales: { newestComplete: { day: "2026-10-10", recordedAt: "2026-10-10T21:31:00Z" }, newest: { day: "2026-10-11", complete: false } } });
  chk("whales ran but the newest snapshot is INCOMPLETE and the last complete one is > 25 h old -> FAIL (a permanent gap)", inc.status === "FAIL" && /newest COMPLETE whales snapshot 2026-10-10/.test(inc.detail) && /is incomplete/.test(inc.detail), inc.detail);
  chk("funding store's newest period > 33 h old -> FAIL", E({ funding: { newestT: Date.parse("2026-10-11T00:00:00Z") } }).status === "FAIL");
  chk("a timer disabled -> FAIL", /traids-w1-social\.timer not enabled\+active/.test(E({ timers: { "w1-social": "disabled/inactive" } }).detail));
  chk("the server's map differs from home's -> FAIL (split-brain risk)", /split-brain/.test(E({ map: { sha: "z".repeat(64) } }).detail) && E({ map: { sha: "z".repeat(64) } }).status === "FAIL");
  chk("code drift (a home edit not deployed) -> FAIL naming the file", /code drift: hyperliquid-whales-record\.js/.test(E({ code: { ...code, "hyperliquid-whales-record.js": "e".repeat(64) } }).detail));
  chk("code drift of the GATE (own-check.cjs) -> FAIL", E({ code: { ...code, "own-check.cjs": "8".repeat(64) } }).status === "FAIL" && /code drift: own-check\.cjs/.test(E({ code: { ...code, "own-check.cjs": "8".repeat(64) } }).detail));
  const sl = E({ code: { ...code, "lib/atomic-write.js": "0".repeat(64) } });
  chk("drift of the SHARED lib/atomic-write.js (R309's too) -> WARN once, not a permanent FAIL", sl.status === "WARN" && (sl.detail.match(/code drift: lib\/atomic-write\.js/g) || []).length === 1 && /SHARED lib/.test(sl.detail), sl.detail);
  chk("server clock 6 min off -> FAIL", /clock/.test(E({ now: NOW + 6 * 60000 }).detail) && E({ now: NOW + 6 * 60000 }).status === "FAIL");
  chk("a deliberate OFF switch -> WARN, named", E({ runs: { "w1-whales": run0("2026-10-11T21:40:00Z", true, { stopped: "w1-whales-OFF" }), "w1-funding": run0("2026-10-11T20:31:00Z"), "w1-social": run0("2026-10-11T20:35:20Z") } }).status === "WARN");
  const ap = E({ alert: { ...ALERT, script: false, token: false } });
  chk("the paging path broken on the VPS (R309's rollback removed traids-alert.cjs) -> FAIL naming what is missing", ap.status === "FAIL" && /PAGING PATH[^]*traids-alert\.cjs missing/.test(ap.detail), ap.detail);
  const fresh = home({ map: mapAll("server", [{ at: "2026-10-12T12:30:00Z", wave: "w1", to: "server", units: ["w1-whales", "w1-funding", "w1-social"] }]) });
  chk("cut over 30 min ago, no run yet -> PASS 'awaiting the first server run'", E({ runs: {}, whales: {}, social: {}, funding: null }, fresh).status === "PASS" && /awaiting the first server run/.test(E({ runs: {}, whales: {}, social: {}, funding: null }, fresh).detail));
  chk("cut over 3 days ago and never ran -> FAIL", E({ runs: {} }).status === "FAIL" && /no run stamp/.test(E({ runs: {} }).detail));
  chk("home's last pull of a unit refused -> FAIL naming it", /home's last pull/.test(E({}, home({ pull: { waves: { w1: { at: "t", units: { "w1-social": { result: "refused: social-mentions/2026-10-10.json: complete on home" } } } } } })).detail));
  let threw = null; try { evaluate("@@PROBE\nnot json\n@@END", NOW, home()); } catch (e) { threw = e.message; }
  chk("an unparsable probe throws (run() reads it as UNKNOWN)", /does not parse/.test(threw || ""));
  const okProbe = async () => ({ ok: true, text: P() });
  // the home (no-ssh) chain checks
  const rTag = await run({ homeImpl: () => home({ tagIssues: ['chain step "social mentions record" is not tagged ownedBy: "w1-social" — home would run it'] }), probeImpl: okProbe, nowImpl: () => NOW });
  chk("server-owned and a later chain edit dropped a tag -> FAIL (home would run it beside the VPS)", rTag.status === "FAIL" && /does not obey the map[^]*social mentions record/.test(rTag.detail), rTag.detail);
  const ranHome = { started: "2026-10-12T20:15:00Z", steps: [{ name: "hyperliquid whales record", ok: true }, { name: "social mentions record", skipped: true, why: "skipped (server-owned)" }] };
  const rRan = await run({ homeImpl: () => home({ chainStatus: ranHome }), probeImpl: okProbe, nowImpl: () => NOW });
  chk("server-owned and the last chain (after the cutover) RAN a W1 step at home -> FAIL split-brain", rRan.status === "FAIL" && /SPLIT-BRAIN: the chain of 2026-10-12T20:15:00Z RAN "hyperliquid whales record"/.test(rRan.detail), rRan.detail);
  const rPre = await run({ homeImpl: () => home({ chainStatus: { ...ranHome, started: "2026-10-09T20:15:00Z" } }), probeImpl: okProbe, nowImpl: () => NOW });
  chk("... but the same day's chain from BEFORE the cutover (it ran the step legitimately) -> no finding", rPre.status === "PASS", rPre.detail);
  const unk = { started: "2026-10-08T20:15:00Z", steps: [{ name: "social mentions record", skipped: true, ownedBy: "w1-social", why: "not run — ownership unknown", warn: "ownership unknown, not run (refusing to guess the host): host-ownership.json unreadable (ENOENT)" }] };
  const rUnk = await run({ homeImpl: () => home({ map: mapAll("home", []), chainStatus: unk }), probeImpl: async () => { throw new Error("must not ssh"); } });
  chk("home-owned and the last chain did NOT run a W1 step (ownership unknown) -> FAIL naming the gap, still no ssh", rUnk.status === "FAIL" && /did NOT run "social mentions record": ownership unknown \(host-ownership\.json unreadable \(ENOENT\)\)/.test(rUnk.detail), rUnk.detail);
  // home-owned
  const rHome = await run({ homeImpl: () => home({ map: mapAll("home", []) }), probeImpl: async () => { throw new Error("must not ssh"); } });
  chk("every W1 unit home-owned and NEVER cut over -> PASS 'W1 runs at home', no ssh", rHome.status === "PASS" && /W1 runs at home/.test(rHome.detail), rHome.detail);
  const sdHist = [CUT, { at: "2026-10-12T15:00:00Z", wave: "w1", to: "home", units: ["w1-whales", "w1-funding", "w1-social"], serverDown: true }];
  const MP = (vmap, inst = ["w1-whales", "w1-funding", "w1-social"]) => async (o) => (o.mode === "map" ? { ok: true, text: ["@@MAP", vmap == null ? "ABSENT" : typeof vmap === "string" ? vmap : JSON.stringify(vmap), "@@UNITS", ...inst.map((u) => "installed " + u), "@@END"].join("\n") } : { ok: false, why: "wrong probe" });
  const srvMap = { schema: "host-ownership-v1", units: { "w1-whales": "server", "w1-funding": "server", "w1-social": "server" } };
  const rSplit = await run({ homeImpl: () => home({ map: mapAll("home", sdHist) }), probeImpl: MP(srvMap) });
  chk("home-owned after `own.cjs w1 home --server-down`, the VPS map still says server and the units are installed -> FAIL SPLIT-BRAIN (it used to PASS with no ssh)", rSplit.status === "FAIL" && /SPLIT-BRAIN: the VPS map gives w1-whales, w1-funding, w1-social to the server/.test(rSplit.detail), rSplit.detail);
  const rRestored = await run({ homeImpl: () => home({ map: mapAll("home", [CUT]) }), probeImpl: MP(srvMap) });
  chk("a home map restored to a pre-cutover version (history has the cutover) while the VPS runs W1 -> FAIL SPLIT-BRAIN", rRestored.status === "FAIL" && /SPLIT-BRAIN/.test(rRestored.detail));
  const rAgree = await run({ homeImpl: () => home({ map: mapAll("home", sdHist) }), probeImpl: MP({ schema: "host-ownership-v1", units: { "w1-whales": "home", "w1-funding": "home", "w1-social": "home" } }) });
  chk("home-owned after a rollback, the VPS map agrees -> PASS", rAgree.status === "PASS" && /the VPS map agrees/.test(rAgree.detail), rAgree.detail);
  const rGone = await run({ homeImpl: () => home({ map: mapAll("home", sdHist) }), probeImpl: MP(srvMap, []) });
  chk("home-owned, a stale VPS map but no real W1 unit installed (rollback.cjs --server ran) -> PASS (nothing can run)", rGone.status === "PASS", rGone.detail);
  const rTorn = await run({ homeImpl: () => home({ map: mapAll("home", sdHist) }), probeImpl: MP("{ torn") });
  chk("home-owned, the VPS map torn while its units are installed -> FAIL", rTorn.status === "FAIL" && /not a readable host-ownership-v1 map/.test(rTorn.detail));
  const rDown = await run({ homeImpl: () => home({ map: mapAll("home", sdHist) }), probeImpl: async () => ({ ok: false, why: "ssh traids: timed out" }) });
  chk("home-owned after a cutover and the VPS unreachable -> UNKNOWN (split-brain unverified), never PASS", rDown.status === "UNKNOWN" && /split-brain unverified/.test(rDown.detail), rDown.detail);
  const rSsh = await run({ homeImpl: () => home(), probeImpl: async () => ({ ok: false, why: "ssh traids: timed out" }), nowImpl: () => NOW });
  chk("server-owned and the VPS unreachable -> UNKNOWN (exit 1)", rSsh.status === "UNKNOWN" && rSsh.code === 1);
  const rMap = await run({ homeImpl: () => { throw new Error("ENOENT host-ownership.json"); } });
  chk("home's map unreadable -> UNKNOWN", rMap.status === "UNKNOWN" && /could not be read/.test(rMap.detail));
  const c1 = await check({ homeImpl: () => home(), probeImpl: async () => ({ ok: true, text: P({ runs: {} }) }), nowImpl: () => NOW });
  const c2 = await check({ homeImpl: () => home(), probeImpl: async () => ({ ok: false, why: "down" }) });
  chk("preflight shape: FAIL and UNKNOWN are both level warn, ok=false (DEGRADED, never NO-GO)", c1.level === "warn" && !c1.ok && c1.status === "CRITICAL" && c2.level === "warn" && !c2.ok && c2.status === "UNKNOWN" && c1.name === NAME);
  chk("the probe commands are read-only (node w1-probe.cjs / cat the map / test -e unit files + systemctl show / is-enabled / is-active; no redirection but 2>&1)", [probeCommand(Object.entries(man.units)), mapProbeCommand(Object.entries(man.units))].every((c) => !/\brm\b|\bmv\b|>|chmod|systemctl (start|stop|enable|disable|restart)/.test(c.replace(/2>&1/g, ""))));
  console.log(`w1-health selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf("--" + k); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  (async () => {
    if (a.includes("--selftest")) { process.exitCode = (await selftest()) ? 0 : 1; return; }
    const v = await run({ host: opt("host", "traids") });
    if (a.includes("--json")) console.log(JSON.stringify({ name: NAME, at: new Date().toISOString(), ...v }));
    else console.log(`W1 HEALTH ${v.status}: ${v.detail}`);
    process.exitCode = v.code;
  })().catch((e) => { console.error("w1-health crashed:", e && e.message); process.exitCode = 1; });
}
module.exports = { evaluate, evaluateHomeOwned, homeChainIssues, run, check, probe, probeCommand, mapProbeCommand, homeFacts, NAME };
