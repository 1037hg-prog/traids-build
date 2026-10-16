#!/usr/bin/env node
/**
 * UNITS — every systemd unit of the W5 board cell, generated from manifests.cjs (real and SHADOW units from ONE template below, the
 * shadow with shadow=true), so systemd/ can never drift from the table. 2026-10-11 (docs/server/wave5-board; the model is
 * docs/server/wave3-sleeves/units.cjs).
 *
 *   node docs/server/wave5-board/units.cjs --write    (re)write systemd/*.{service,timer}
 *   node docs/server/wave5-board/units.cjs --check    exit 0 when every file equals what expected() makes (and no stray file) AND every
 *                                                     service file on disk passes semanticIssues() (the gate side, the tree, the key
 *                                                     file, the loopback bind read from the file itself) AND every timer file on
 *                                                     disk passes timerIssues() (a fire is never replayed late, never spread)
 *
 * Template (plan v2 M5): User=traids · TZ=America/Denver · OnCalendar=… America/New_York · OnFailure=traids-alert@%n.service ·
 * EnvironmentFile = the cell's key file (/etc/traids/w5-board.env real, /etc/traids/w5-shadow.env shadow; root:traids 0640, deploy.cjs
 * --step keys) and the SAME file bound read-only over the tree's backend/.env (BindReadOnlyPaths: the scripts read backend/.env
 * themselves; without the bind the real tree's scripts would read R309's file there — w5-run.cjs refuses a fire whose backend/.env
 * does not carry this tree's W5_ENV_FILE marker) · a unit that reads Schwab also: SCHWAB_MD_TOKEN_FILE and
 * EnvironmentFile=-/etc/traids/w2b-schwab.env (W2b's market-data-only app; optional: without a usable token every Schwab step is
 * refused / skipped in the shadow) · oneshots run under /usr/bin/flock -F -w 600 data/w5-<x>.flock (the lock pull-server takes).
 * ExecCondition = W1's /bin/sh wrapper around own-check.cjs (0 run · 77 -> 1 skip · else 255 -> fail -> page), asked of the REAL
 * tree's map: `<unit> server` for a real unit, `<unit> home` for a shadow one.
 *   the two servers   Type=simple under the keeper (w5-run.cjs --serve board|yahoo: it stops the server within half a minute when
 *                     the map gives the unit to the other host), bound to 127.0.0.1 ONLY (reaching the dashboard is the operator's
 *                     Tailscale step, NOTES.md); Restart=on-failure; a keeper TIMER (every 5 min, and 1 min after boot) starts it —
 *                     a no-op while it runs, a condition-skip while the other host owns it (own.cjs needs a timer per unit)
 * A SHADOW unit (traids-w5s-*) differs only in: the tree (/home/traids/w5-shadow), ExecCondition "<unit> home", W5_SHADOW=1 (no
 * --live: nothing is ever sent; metered steps skipped; no Telegram token in its key file), the key file, SyslogIdentifier,
 * Description, the timer's Unit= and its calendar (W5_SLOT_SHIFT_MIN minutes after the real slot, so the dry period never fires in
 * the same minute as home's task; w5-run.cjs branches on the slot). Persistent=false everywhere: a missed fire is never replayed.
 */
"use strict";
const fs = require("fs"), path = require("path");
const M = require("./manifests.cjs");
const OC = require(path.join(__dirname, "..", "..", "..", "deploy", "server", "own-check.cjs"));
const SD = path.join(__dirname, "systemd"), NODE = "/usr/local/bin/node", TZ = "America/New_York";
const RB = M.ROOT + "/backend", SB = M.SHADOW + "/backend", MAP = RB + "/data/host-ownership.json";
const name = (x, shadow, kind) => `traids-w5${shadow ? "s" : ""}-${x}.${kind}`;
const MEM = { open: "3G", chain: "4G" };

/** "Mon..Fri *-*-* 10..16:10,40:00" moved `shift` minutes later (hours carry only for a single hour; a range with a carry is refused) */
function shiftCal(cal, shift) {
  const m = /^(\S+ \*-\*-\* )(\d{2}(?:\.\.\d{2})?):((?:\d{2})(?:,\d{2})*):(\d{2})$/.exec(cal); if (!m) throw new Error("shiftCal: not a calendar line this generator shifts: " + cal);
  const mins = m[3].split(",").map(Number).map((x) => x + shift), carry = Math.floor(Math.min(...mins) / 60);
  if (mins.some((x) => Math.floor(x / 60) !== carry)) throw new Error(`shiftCal: ${cal} + ${shift} min splits across hours`);
  if (carry && m[2].includes("..")) throw new Error(`shiftCal: ${cal} + ${shift} min carries an hour range`);
  const hh = carry ? String(Number(m[2]) + carry).padStart(2, "0") : m[2]; if (Number(hh.slice(0, 2)) > 23) throw new Error("shiftCal: past midnight");
  return `${m[1]}${hh}:${mins.map((x) => String(x % 60).padStart(2, "0")).join(",")}:${m[4]}`;
}
function service(u, shadow) {
  const d = M.UNITS[u], svc = d.type === "service", B = shadow ? SB : RB, envFile = shadow ? M.ENV.shadow : M.ENV.real, want = shadow ? "home" : "server";
  const exec = svc ? `${NODE} ${B}/w5-run.cjs --serve ${d.x}` : `/usr/bin/flock -F -w 600 ${B}/data/w5-${d.x}.flock ${NODE} ${B}/w5-run.cjs ${d.run}`;
  return [
    `# TRAIDS W5 ${shadow ? "SHADOW " : ""}(server migration, docs/server/wave5-board; generated by units.cjs from manifests.cjs) — ${d.title}.`,
    `# ${shadow ? `DRY: no order is ever sent (every --live removed), metered steps skipped, no Telegram token; runs only while HOME owns ${u}, in the shadow tree ${M.SHADOW} (compare.cjs reads its session digests).` : `Runs only while home's map gives ${u} to the server (ExecCondition).`}`,
    svc ? "# The keeper (w5-run.cjs --serve) stops the server within half a minute when the map gives the unit to the other host. 127.0.0.1 only." : "# A nonzero exit pages through traids-alert@ (the same failure re-pages at most every 3 h).",
    "[Unit]",
    `Description=TRAIDS W5 ${shadow ? "SHADOW " : ""}${d.x} (${shadow ? "dry; runs only while home-owned" : "runs only while server-owned"})`,
    "After=network-online.target time-sync.target",
    "Wants=network-online.target",
    "OnFailure=traids-alert@%n.service",
    ...(svc ? ["StartLimitIntervalSec=900", "StartLimitBurst=5"] : []),
    "",
    "[Service]",
    `Type=${svc ? "simple" : "oneshot"}`,
    "User=traids",
    "Group=traids",
    `WorkingDirectory=${B}`,
    "Environment=TZ=America/Denver",
    `Environment=W5_TREE=${shadow ? "shadow" : "real"}`,
    ...(shadow ? ["Environment=W5_SHADOW=1", ...(svc ? [] : [`Environment=W5_SLOT_SHIFT_MIN=${d.shadowShift}`])] : []),
    `Environment=W5_OWNERSHIP_MAP=${MAP}`,
    `Environment=PLAYWRIGHT_BROWSERS_PATH=${M.ROOT}/.playwright`,
    ...Object.entries(d.env || {}).map(([k, v]) => `Environment=${k}=${v}`),
    `EnvironmentFile=${envFile}`,
    `BindReadOnlyPaths=${envFile}:${B}/.env`,
    ...(d.schwab ? [`Environment=SCHWAB_MD_TOKEN_FILE=${M.ENV.schwabMdToken}`, `EnvironmentFile=-${M.ENV.schwabMdEnv}`] : []),
    `ExecCondition=${OC.conditionCommand(u, want)}`,
    `ExecStart=${exec}`,
    ...(svc ? ["Restart=on-failure", "RestartSec=30"] : []),
    `SyslogIdentifier=traids-w5${shadow ? "s" : ""}-${d.x}`,
    ...(svc ? [] : [`TimeoutStartSec=${d.mins}min`]),
    `TimeoutStopSec=${svc ? "45s" : "60s"}`,
    "KillMode=control-group",
    `MemoryMax=${svc ? d.memMax : MEM[d.x] || "1536M"}`,
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectSystem=full",
    "",
  ].join("\n");
}
function timer(u, shadow) {
  const d = M.UNITS[u], svc = d.type === "service";
  const cals = svc ? ["OnCalendar=*-*-* *:00/5:00", "OnBootSec=1min"] : d.cal.map((c) => `OnCalendar=${shadow ? shiftCal(c, d.shadowShift) : c} ${TZ}`);
  return [
    svc ? `# TRAIDS W5 ${shadow ? "SHADOW " : ""}KEEPER timer (generated by units.cjs) — every 5 minutes and 1 minute after boot it starts ${name(d.x, shadow, "service")}: a no-op` : `# TRAIDS W5 ${shadow ? "SHADOW " : ""}timer (generated by units.cjs from manifests.cjs) — ${d.title}. Times are America/New_York, so they follow DST`,
    svc ? "# while the server runs, a condition-skip while the other host owns it. own.cjs needs a timer per unit; this one bounds the start after a cutover to 5 minutes." : `# exactly as the home tasks' local MT triggers did.${shadow ? ` The shadow fires ${d.shadowShift} min after the real slot (never in the same minute as home's task).` : ""} Persistent=false: a missed fire is never replayed late.`,
    "[Unit]",
    `Description=TRAIDS W5 ${shadow ? "SHADOW " : ""}${d.x} ${svc ? "keeper" : "timer"}`,
    "",
    "[Timer]",
    ...cals,
    "AccuracySec=1s",
    "RandomizedDelaySec=0",
    "Persistent=false",
    `Unit=${name(d.x, shadow, "service")}`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}
function expected() {
  const m = {};
  for (const u of M.WAVE_UNITS) for (const shadow of [false, true]) { const x = M.UNITS[u].x; m[name(x, shadow, "service")] = service(u, shadow); m[name(x, shadow, "timer")] = timer(u, shadow); }
  return m;
}
/**
 * SEMANTIC CHECK of service files, independent of service() above (a generator that gated real units on "home", consistently
 * regenerated, would pass a files == generator check). Everything is read from the FILE: its name says the side and the unit.
 * files: { name: text } -> [{ name, why }] (empty = every service file right)
 */
const FORBIDDEN = /SCHWAB_APP_KEY|SCHWAB_APP_SECRET|SCHWAB_REFRESH_TOKEN|TASTY_|SMTP_|ANTHROPIC_API_KEY|LIVE-ARMED/;
function semanticIssues(files) {
  const out = [], byX = Object.fromEntries(M.WAVE_UNITS.map((u) => [M.UNITS[u].x, u]));
  for (const [n, text] of Object.entries(files)) {
    const m = /^traids-w5(s?)-(.+)\.service$/.exec(n); if (!m) continue;
    const shadow = m[1] === "s", u = byX[m[2]], bad = (why) => out.push({ name: n, why });
    if (!u) { bad(`no unit ${m[2]} in manifests.cjs`); continue; }
    const d = M.UNITS[u], side = shadow ? "home" : "server", tree = shadow ? M.SHADOW : M.ROOT, envFile = shadow ? M.ENV.shadow : M.ENV.real, lines = String(text).split("\n"), one = (k) => lines.filter((l) => l.startsWith(k + "=")), envs = lines.filter((l) => l.startsWith("Environment="));
    const cond = one("ExecCondition"); if (cond.length !== 1 || cond[0] !== `ExecCondition=${OC.conditionCommand(u, side)}`) bad(`ExecCondition is not the ${side} gate of ${u} (own-check ${u} ${side}): ${cond.join(" | ").slice(0, 140) || "none"}`);
    const ex = one("ExecStart"); if (ex.length !== 1 || !ex[0].includes(` ${tree}/backend/w5-run.cjs `) || (d.type === "service" ? !ex[0].endsWith(` --serve ${d.x}`) : !ex[0].endsWith(`/w5-run.cjs ${d.run}`) || !ex[0].includes(`/usr/bin/flock -F -w 600 ${tree}/backend/data/w5-${d.x}.flock `))) bad(`ExecStart does not run w5-run.cjs ${d.type === "service" ? "--serve " + d.x : d.run} in ${tree}: ${ex.join(" | ").slice(0, 140)}`);
    if (one("WorkingDirectory").join() !== `WorkingDirectory=${tree}/backend`) bad(`WorkingDirectory is not ${tree}/backend`);
    if (envs.filter((l) => l === "Environment=W5_SHADOW=1").length !== (shadow ? 1 : 0)) bad(shadow ? "a shadow unit without W5_SHADOW=1 (it would send orders: --live is removed only in the shadow)" : "a real unit carries W5_SHADOW=1");
    const ef = one("EnvironmentFile").filter((l) => !l.startsWith("EnvironmentFile=-")); if (ef.length !== 1 || ef[0] !== `EnvironmentFile=${envFile}`) bad(`its key file is not ${envFile}: ${ef.join(" | ") || "none"}`);
    if (shadow && lines.some((l) => l.includes(M.ENV.real))) bad("a shadow unit names the REAL key file (it holds the ops-bot token)");
    const bind = one("BindReadOnlyPaths"); if (bind.length !== 1 || bind[0] !== `BindReadOnlyPaths=${envFile}:${tree}/backend/.env`) bad(`backend/.env is not bound to this tree's key file: ${bind.join(" | ") || "none"}`);
    if (!envs.includes(`Environment=W5_OWNERSHIP_MAP=${MAP}`)) bad("W5_OWNERSHIP_MAP is not the real tree's map (the one authority)");
    if (FORBIDDEN.test(text)) bad("it names a trading-app / SMTP / LLM-key / arming name — none may exist on the VPS");
    const md = lines.filter((l) => l.startsWith("EnvironmentFile=-")); if (d.schwab ? md.join() !== `EnvironmentFile=-${M.ENV.schwabMdEnv}` || !envs.includes(`Environment=SCHWAB_MD_TOKEN_FILE=${M.ENV.schwabMdToken}`) : md.length || envs.some((l) => /SCHWAB/.test(l))) bad(d.schwab ? "a unit that reads Schwab does not load W2b's market-data env and token file (and only those)" : "a unit that reads no Schwab names a Schwab file");
    if (d.type === "service") {
      const host = envs.filter((l) => /^Environment=(TRAIDS_BIND_HOST|YAHOO_BIND_HOST)=/.test(l)); if (host.length !== 1 || !host[0].endsWith("=127.0.0.1")) bad(`the server is not bound to 127.0.0.1 only: ${host.join(" | ") || "no bind host"}`);
      if (one("Type").join() !== "Type=simple" || one("Restart").join() !== "Restart=on-failure") bad("a server unit must be Type=simple with Restart=on-failure");
      if (d.x === "board" && !envs.includes("Environment=TRAIDS_W5_BOARD=1")) bad("the board unit does not set TRAIDS_W5_BOARD=1 (JWT_SECRET required, loopback bind, Schwab only through the market-data reader)");
    } else if (one("Type").join() !== "Type=oneshot") bad("not Type=oneshot");
    if (one("OnFailure").join() !== "OnFailure=traids-alert@%n.service") bad("no OnFailure=traids-alert@%n.service");
  }
  return out;
}
/** every traids-w5*.timer holds EXACTLY ONE each of Persistent=false, AccuracySec=1s and RandomizedDelaySec=0, and starts its own service */
const TIMER_MUST = ["Persistent=false", "AccuracySec=1s", "RandomizedDelaySec=0"];
function timerIssues(files) {
  const out = [];
  for (const [n, text] of Object.entries(files)) {
    const m = /^(traids-w5s?-.+)\.timer$/.exec(n); if (!m) continue;
    const lines = String(text).split("\n").map((l) => l.trim());
    for (const want of TIMER_MUST) { const key = want.slice(0, want.indexOf("=") + 1), have = lines.filter((l) => l.startsWith(key)); if (have.length !== 1 || have[0] !== want) out.push({ name: n, why: `wants exactly one "${want}" (a missed fire is never replayed late, never spread): ${have.join(" | ") || "none"}` }); }
    const un = lines.filter((l) => l.startsWith("Unit=")); if (un.length !== 1 || un[0] !== `Unit=${m[1]}.service`) out.push({ name: n, why: `it does not start ${m[1]}.service: ${un.join(" | ") || "none"}` });
    const cal = lines.filter((l) => l.startsWith("OnCalendar=")); if (!cal.length) out.push({ name: n, why: "no OnCalendar" });
    for (const c of cal) if (!/^OnCalendar=\*-\*-\* \*:00\/5:00$/.test(c) && !c.endsWith(" " + TZ)) out.push({ name: n, why: `a market calendar is not in ${TZ}: ${c}` });
  }
  return out;
}
const ALL_UNITS = Object.keys(expected());
const REAL_UNITS = ALL_UNITS.filter((u) => /^traids-w5-/.test(u)), SHADOW_UNITS = ALL_UNITS.filter((u) => /^traids-w5s-/.test(u));

function check(log = console.log) {
  let bad = 0; const want = expected(), ok = (c, okLine, badLine) => { if (c) log("ok   " + okLine); else { bad++; log("DIFF " + (badLine || okLine)); } };
  for (const [f, t] of Object.entries(want)) { let cur = null; try { cur = fs.readFileSync(path.join(SD, f), "utf8"); } catch { cur = null; } ok(cur === t, `systemd/${f}`); }
  for (const f of fs.existsSync(SD) ? fs.readdirSync(SD) : []) if (!(f in want)) { bad++; log(`DIFF systemd/${f} (not generated)`); }
  const read = (re) => Object.fromEntries((fs.existsSync(SD) ? fs.readdirSync(SD) : []).filter((f) => re.test(f)).map((f) => [f, fs.readFileSync(path.join(SD, f), "utf8")]));
  const disk = read(/\.service$/), iss = semanticIssues(disk);
  for (const f of Object.keys(disk).sort()) { const i = iss.filter((x) => x.name === f); if (i.length) { bad++; for (const x of i) log(`DIFF semantic systemd/${f}: ${x.why}`); } else log(`ok   semantic systemd/${f}: gated ${/^traids-w5s-/.test(f) ? "home (shadow tree, W5_SHADOW=1, the shadow key file)" : "server (real tree, the real key file)"}`); }
  const tdisk = read(/\.timer$/), tiss = timerIssues(tdisk);
  for (const f of Object.keys(tdisk).sort()) { const i = tiss.filter((x) => x.name === f); if (i.length) { bad++; for (const x of i) log(`DIFF semantic systemd/${f}: ${x.why}`); } else log(`ok   semantic systemd/${f}: ${TIMER_MUST.join(", ")} (exactly once each), starts its own service`); }
  // the semantic checks catch each way a unit file could be wrong, whatever the generator made (mutations of the generated files)
  const svcs = Object.entries(want).filter(([f]) => /\.service$/.test(f)), nSvc = svcs.length, flagged = (mut, re, only = () => true) => svcs.filter(([f]) => only(f)).every(([f, t]) => { const x = mut(f, t); return x !== t && semanticIssues({ [f]: x }).some((i) => re.test(i.why)); });
  const sideOf = (f) => (/^traids-w5s-/.test(f) ? "home" : "server"), unitOf = (f) => M.WAVE_UNITS.find((u) => M.UNITS[u].x === f.replace(/^traids-w5s?-/, "").replace(/\.service$/, ""));
  ok(nSvc === 18 && flagged((f, t) => t.replace(OC.conditionCommand(unitOf(f), sideOf(f)), OC.conditionCommand(unitOf(f), sideOf(f) === "home" ? "server" : "home")), /ExecCondition is not the (home|server) gate/), `semantic: all ${nSvc} service files with their gate side swapped (a real unit gated on 'home', a shadow on 'server') are each flagged`);
  ok(flagged((f, t) => t.replace("Environment=W5_SHADOW=1\n", ""), /without W5_SHADOW=1/, (f) => /^traids-w5s-/.test(f)), "semantic: all 9 shadow service files with W5_SHADOW=1 removed (they would send orders) are each flagged");
  { const reals = svcs.filter(([f]) => /^traids-w5-/.test(f));
    ok(reals.length === 9 && flagged((f, t) => t.replace("[Service]\n", "[Service]\nEnvironment=W5_SHADOW=1\n"), /a real unit carries W5_SHADOW=1/, (f) => /^traids-w5-/.test(f)) && reals.every(([f, t]) => !/W5_SHADOW/.test(t) && semanticIssues({ [f]: t }).length === 0), "semantic: all 9 REAL service files given W5_SHADOW=1 (they would run dry after the cutover and send nothing) are each flagged; as generated none carries it and none is flagged"); }
  ok(flagged((f, t) => t.replace(M.ENV.shadow, M.ENV.real), /REAL key file|its key file is not/, (f) => /^traids-w5s-/.test(f)), "semantic: all 9 shadow service files pointed at the REAL key file (the ops-bot token) are each flagged");
  ok(flagged((f, t) => t.replace(/^BindReadOnlyPaths=.*\n/m, ""), /backend\/\.env is not bound/), `semantic: all ${nSvc} service files without the key-file bind over backend/.env are each flagged`);
  ok(flagged((f, t) => t.replace("=127.0.0.1\n", "=0.0.0.0\n"), /not bound to 127\.0\.0\.1 only/, (f) => /-(board|yahoo)\.service$/.test(f)), "semantic: all 4 server unit files bound to 0.0.0.0 are each flagged (the dashboard is never public)");
  ok(flagged((f, t) => t.replace("[Service]\n", "[Service]\nEnvironment=SCHWAB_APP_KEY=x\n"), /trading-app/), `semantic: all ${nSvc} service files given a trading-app name are each flagged`);
  const tms = Object.entries(want).filter(([f]) => /\.timer$/.test(f)), tflag = (mut) => tms.every(([f, t]) => mut(t) !== t && timerIssues({ [f]: mut(t) }).length >= 1);
  ok(tms.length === 18 && [(t) => t.replace("Persistent=false\n", "Persistent=true\n"), (t) => t.replace("Persistent=false\n", ""), (t) => t.replace("AccuracySec=1s\n", "AccuracySec=1min\n"), (t) => t.replace("RandomizedDelaySec=0\n", "RandomizedDelaySec=30\n"), (t) => t.replace(/^Unit=.*$/m, "Unit=traids-other.service")].every(tflag), `semantic: all ${tms.length} timer files are each flagged with Persistent=true / the line removed / AccuracySec=1min / RandomizedDelaySec=30 / another Unit=`);
  // known answers of the calendar shift
  const sc = [shiftCal("Mon..Fri *-*-* 09:35:00", 7), shiftCal("Mon..Fri *-*-* 10..16:10,40:00", 7), shiftCal("Mon..Fri *-*-* 16:15:00", 105), shiftCal("Mon..Fri *-*-* 17:30:00", 120), shiftCal("Mon *-*-* 08:00:00", 7)];
  const thrown = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
  ok(sc.join("|") === "Mon..Fri *-*-* 09:42:00|Mon..Fri *-*-* 10..16:17,47:00|Mon..Fri *-*-* 18:00:00|Mon..Fri *-*-* 19:30:00|Mon *-*-* 08:07:00" && /carries an hour range/.test(thrown(() => shiftCal("Mon..Fri *-*-* 10..16:10,40:00", 60))) && /splits across hours/.test(thrown(() => shiftCal("Mon..Fri *-*-* 10:10,40:00", 30))), "the shadow calendars: 09:35 +7 = 09:42 · 10..16:10,40 +7 = :17,:47 · 16:15 +105 = 18:00 · 17:30 +120 = 19:30 · Mon 08:00 +7 = 08:07; a shift that would carry an hour range or split a minute list is refused", sc.join("|"));
  return bad;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.length === 1 && a[0] === "--write") { fs.mkdirSync(SD, { recursive: true }); for (const [f, t] of Object.entries(expected())) fs.writeFileSync(path.join(SD, f), t); console.log(`written ${ALL_UNITS.length} unit files in systemd/`); process.exitCode = 0; }
  else if (a.length === 1 && a[0] === "--check") process.exitCode = check() ? 1 : 0;
  else { console.log("usage: node units.cjs --write | --check"); process.exitCode = 2; }
}
module.exports = { expected, semanticIssues, timerIssues, shiftCal, check, TIMER_MUST, ALL_UNITS, REAL_UNITS, SHADOW_UNITS, name, RB, SB, MAP, NODE };
