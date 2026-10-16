#!/usr/bin/env node
/**
 * UNITS — every systemd unit of W2b, generated (the real ones from the templates below, the SHADOW ones mechanically from the real ones),
 * so the files in systemd/ can never drift from this source. 2026-10-09 (docs/server/wave2b-schwab).
 *
 *   node docs/server/wave2b-schwab/units.cjs --write    (re)write systemd/*.{service,timer}
 *   node docs/server/wave2b-schwab/units.cjs --check    exit 0 when every file equals what expected() makes
 *
 * Unit template (plan v2 M5, as W1 / W1c): User=traids · TZ=America/Denver · market timers OnCalendar=... America/New_York · flock ·
 * OnFailure=traids-alert@%n.service (the server's de-duplicated ops-bot path; neither recorder has an alert path of its own) · its own
 * EnvironmentFile /etc/traids/w2b-schwab.env (the operator's ONE Schwab app, market-data-only by Schwab's own permissions, under the
 * names SCHWAB_MD_APP_KEY / SCHWAB_MD_APP_SECRET, nothing else; lib/schwab-md.js hands out a token only while Schwab's accounts side
 * refuses it) ·
 * ExecCondition = W1's /bin/sh wrapper around own-check.cjs (0 run · 77 -> 1 skip · anything else -> 255 fail -> alert).
 *   traids-gex    oneshot: backend/gex-record.js --schwab-md under the pull flock w2b-gex.flock. Mon-Fri 09:41 and 15:42 ET: the
 *                 open (09:40-10:15) and close (15:30-15:55) slots, at the times home recorded them (gex/summary.jsonl: open 09:40, close
 *                 15:42 ET on 10-01..10-09). The script self-gates (once per slot; weekends; market holidays under --schwab-md).
 *   traids-flow   oneshot: backend/options-flow-record.js --schwab-md under w2b-flow.flock. Mon-Fri 15:40 ET: home's fire (every
 *                 options-flow file 09-28..10-09 has etMinutes 940 = 15:40 ET). R272's rule: one snapshot between 15:30 and 15:55 ET.
 *   traids-schwab-md-check   oneshot, 07:00 and 18:00 America/Denver every day: schwab-md-auth.cjs --check --min-hours 36 — one refresh
 *                 and one question to Schwab's accounts side (the status code only). Exit 1 pages through OnFailure when that side
 *                 ACCEPTS the token, when no verdict can be had and none under 24 h old is on record, when the refresh is refused (a
 *                 newer sign-in replaced the token), or when the token dies within 36 h (the weekly sign-in is due). Twice a day
 *                 also keeps the 24-hour verdict fresh over a weekend. Gated on THE TOKEN FILE BEING THERE (ExecCondition
 *                 /usr/bin/test -f <the token file>), not on who owns a recorder: the token is also what other packages' server units
 *                 read Schwab with (W3's Schwab sleeves, W5), before this package's cutover and after its rollback, so the check
 *                 watches the token for as long as one is on the VPS (review, 2026-10-11; until then it was gated on "w2b-gex
 *                 server" and nothing paged for the token in those states). No token file (before the first sign-in, after
 *                 rollback.cjs --server): skipped, no page. No shadow twin.
 * Every unit sets SCHWAB_MD_TOKEN_FILE=/home/traids/.traids/schwab-md-token.json (written only by schwab-md-auth.cjs; 0600; never pulled);
 * the permission record schwab-md-permission.json sits beside it (0600: the time and the status code of the last definitive answer),
 * and schwab-md-permission-asked.json (0600: the time the accounts side was last asked, so all units together ask at most once in 15 min).
 * AFTER `rollback.cjs --wave w2b` the check unit KEEPS RUNNING (it is gated on the token file, not on the recorders' owner): it still
 * pages for the token's age and for an accepted answer while other packages' units read Schwab with it. `rollback.cjs --server` removes
 * it together with the token; `--server --keep-shared` removes it and keeps the token (then nothing pages: NOTES.md, "Rollback").
 * A SHADOW unit differs from its real unit only in: the tree (/home/traids/w2b-shadow/backend: the same script bytes, writing that tree's
 * data/ only — never pulled), ExecCondition "<unit> home" (it runs only while home owns the unit: the dry period), SyslogIdentifier,
 * Description and the timer's Unit=. Names avoid traids-w1* (W1's rollback.cjs --server counts those timers).
 */
"use strict";
const fs = require("fs"), path = require("path");
const REPO = path.resolve(__dirname, "..", "..", "..");
const OC = require(path.join(REPO, "deploy", "server", "own-check.cjs"));
const SD = path.join(__dirname, "systemd"), REAL_B = "/home/traids/traids/backend", SHADOW_B = "/home/traids/w2b-shadow/backend";
const NODE = "/usr/local/bin/node", ENV = "/etc/traids/w2b-schwab.env", TOKEN = "/home/traids/.traids/schwab-md-token.json", PERMISSION = "/home/traids/.traids/schwab-md-permission.json";
/** beside the record: the time the accounts side was last asked (lib/schwab-md.js ASKED_NAME) */
const ASKED = "/home/traids/.traids/schwab-md-permission-asked.json";
/**
 * the check unit's start condition: a token file is on this host (exit 0 run · 1 skip, no page). NOT "the VPS owns w2b-gex": the token
 * is watched for every unit that reads Schwab with it, whichever host owns the two recorders.
 */
const CHECK_CONDITION = `/usr/bin/test -f ${TOKEN}`;
const UNITS = {
  gex: { unit: "w2b-gex", script: "gex-record.js", lock: "w2b-gex.flock", times: ["09:41:00", "15:42:00"], what: "GEX recorder (SPX / SPY / QQQ open interest + gamma)" },
  flow: { unit: "w2b-flow", script: "options-flow-record.js", lock: "w2b-flow.flock", times: ["15:40:00"], what: "R272 options-flow recorder (the r147-earnings names)" },
};

function realService(x) {
  if (x === "check") return [
    "# TRAIDS W2b (server migration, docs/server/wave2b-schwab): the Schwab token's twice-daily check. schwab-md-auth.cjs --check makes one",
    "# refresh and asks Schwab's ACCOUNTS side once (the status code only). It exits 1 when that side ACCEPTS the token (the app must be",
    "# market-data-only), when no verdict can be had and none under 24 h old is on record, when the refresh is refused, or when fewer",
    "# than 36 h of the token's 7 days remain (the weekly sign-in is due). OnFailure pages through traids-alert@ (the same failure",
    "# re-pages at most every 3 h). What to do, at home: node docs/server/wave2b-schwab/schwab-auth.cjs --status, then NOTES.md.",
    "# Runs whenever a token file is on this host (ExecCondition: test -f), whichever host owns the recorders: every unit here that",
    "# reads Schwab uses that token (the recorders and their shadows, W3's Schwab sleeves, W5's units). No token file: skipped, no page.",
    "# It writes two small files beside the token file: the permission record and the time of its last question to the accounts side.",
    "[Unit]",
    "Description=TRAIDS W2b Schwab market-data token check (runs while a token file is on this host)",
    `Documentation=file://${REAL_B}/schwab-md-auth.cjs`,
    "After=network-online.target time-sync.target",
    "Wants=network-online.target",
    "OnFailure=traids-alert@%n.service",
    "",
    "[Service]",
    "Type=oneshot",
    "User=traids",
    "Group=traids",
    `WorkingDirectory=${REAL_B}`,
    "Environment=TZ=America/Denver",
    `Environment=SCHWAB_MD_TOKEN_FILE=${TOKEN}`,
    `ExecCondition=${CHECK_CONDITION}`,
    `ExecStart=${NODE} ${REAL_B}/schwab-md-auth.cjs --check --min-hours 36`,
    "SyslogIdentifier=traids-schwab-md-check",
    "TimeoutStartSec=2min",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectSystem=full",
    "",
  ].join("\n");
  const u = UNITS[x];
  return [
    `# TRAIDS W2b (server migration, docs/server/wave2b-schwab): backend/${u.script} --schwab-md — the ${u.what}, the same script`,
    "# bytes as home's (the flag: the token from lib/schwab-md.js — the operator's one Schwab app, used only while Schwab's accounts side",
    "# REFUSES the token (401 / 403); if that side ever answers 2xx this unit exits nonzero and pages; dotenv not loaded; market",
    `# holidays skipped as home's intraday.bat does). Mon-Fri ${u.times.map((t) => t.slice(0, 5)).join(" and ")} America/New_York (traids-${x}.timer). Runs ONLY while home's map says`,
    `# "${u.unit}": "server". Keys: ${ENV} (SCHWAB_MD_APP_KEY / SECRET only; root:traids 0640); refresh token: ${TOKEN}`,
    "# (0600, written by schwab-md-auth.cjs, never pulled). A nonzero exit pages through traids-alert@ (re-paged at most every 3 h).",
    "[Unit]",
    `Description=TRAIDS W2b ${u.what} (runs only while server-owned)`,
    `Documentation=file://${REAL_B}/${u.script}`,
    "After=network-online.target time-sync.target",
    "Wants=network-online.target",
    "OnFailure=traids-alert@%n.service",
    "",
    "[Service]",
    "Type=oneshot",
    "User=traids",
    "Group=traids",
    `WorkingDirectory=${REAL_B}`,
    "Environment=TZ=America/Denver",
    `Environment=SCHWAB_MD_TOKEN_FILE=${TOKEN}`,
    `EnvironmentFile=${ENV}`,
    `ExecCondition=${OC.conditionCommand(u.unit, "server")}`,
    `ExecStart=/usr/bin/flock -w 600 ${REAL_B}/data/${u.lock} ${NODE} ${REAL_B}/${u.script} --schwab-md`,
    `SyslogIdentifier=traids-${x}`,
    "TimeoutStartSec=10min",
    "TimeoutStopSec=60s",
    "KillMode=control-group",
    "MemoryMax=768M",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectSystem=full",
    "",
  ].join("\n");
}
function realTimer(x) {
  if (x === "check") return [
    "# TRAIDS W2b Schwab market-data token check — 07:00 and 18:00 America/Denver, every day (a token dying on a weekend still kills",
    "# Monday's 09:41 ET record). Persistent=true: a check missed while the VPS was down runs at boot.",
    "[Unit]",
    "Description=TRAIDS W2b Schwab market-data token check, twice a day",
    "",
    "[Timer]",
    "OnCalendar=*-*-* 07:00:00 America/Denver",
    "OnCalendar=*-*-* 18:00:00 America/Denver",
    "AccuracySec=1min",
    "Persistent=true",
    "Unit=traids-schwab-md-check.service",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  const u = UNITS[x];
  return [
    `# TRAIDS W2b ${u.what} — Mon-Fri ${u.times.map((t) => t.slice(0, 5)).join(" and ")} America/New_York (DST-safe), the times home's records were taken.`,
    "# Persistent=false: a missed slot is a missed record (Schwab keeps no historical chains), never replayed later (three record types).",
    "[Unit]",
    `Description=TRAIDS W2b ${u.what}, Mon-Fri ${u.times.map((t) => t.slice(0, 5)).join(" / ")} ET`,
    "",
    "[Timer]",
    ...u.times.map((t) => `OnCalendar=Mon..Fri *-*-* ${t} America/New_York`),
    "AccuracySec=1s",
    "RandomizedDelaySec=0",
    "Persistent=false",
    `Unit=traids-${x}.service`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}
/** the shadow unit, mechanically from the real one (throws when an expected line is missing: the two can never drift) */
function shadowOf(text, kind, x) {
  const out = [], u = UNITS[x];
  let header = true, cond = 0;
  for (const l of text.split("\n")) {
    if (header && l.startsWith("#")) continue;
    header = false;
    let m = l;
    if (/^Description=/.test(m)) m = m.replace(/^Description=TRAIDS W2b /, "Description=TRAIDS W2b SHADOW ").replace(/\(runs only while server-owned\)/, "(dry period; runs only while home-owned)");
    if (/^WorkingDirectory=/.test(m)) m = `WorkingDirectory=${SHADOW_B}`;
    if (/^ExecCondition=/.test(m)) { const n = m.replace(`own-check.cjs ${u.unit} server;`, `own-check.cjs ${u.unit} home;`); if (n === m) throw new Error(`units.cjs: traids-${x}.${kind}'s ExecCondition has no "own-check.cjs ${u.unit} server;"`); m = n; cond++; }
    if (/^ExecStart=/.test(m)) m = m.split(`${REAL_B}/`).join(`${SHADOW_B}/`);
    if (/^SyslogIdentifier=/.test(m)) m = `SyslogIdentifier=traids-${x}-shadow`;
    if (/^Unit=/.test(m)) m = `Unit=traids-${x}-shadow.service`;
    out.push(m);
  }
  if (kind === "service" && cond !== 1) throw new Error(`units.cjs: traids-${x}.service has ${cond} ExecCondition lines (want 1)`);
  const head = kind === "service"
    ? [`# TRAIDS W2B SHADOW (dry period, docs/server/wave2b-schwab) — derived by units.cjs from traids-${x}.service. The same script bytes`,
      `# from the shadow tree ${SHADOW_B}; they write ${SHADOW_B}/data only, which is never pulled; compare.cjs`,
      `# compares it with home's same session. ExecCondition "home": it starts only while home owns ${u.unit}; deploy.cjs --cutover`,
      "# stops and disables it. OnFailure stays on: a failing shadow pages."]
    : [`# TRAIDS W2B SHADOW timer — derived by units.cjs from traids-${x}.timer: the same calendar as the real unit.`];
  return [...head, ...out].join("\n");
}
function expected() {
  const m = {};
  for (const x of Object.keys(UNITS)) {
    m[`traids-${x}.service`] = realService(x); m[`traids-${x}.timer`] = realTimer(x);
    m[`traids-${x}-shadow.service`] = shadowOf(realService(x), "service", x); m[`traids-${x}-shadow.timer`] = shadowOf(realTimer(x), "timer", x);
  }
  m["traids-schwab-md-check.service"] = realService("check"); m["traids-schwab-md-check.timer"] = realTimer("check");
  return m;
}
const ALL_UNITS = Object.keys(expected());
const SHADOW_UNITS = ALL_UNITS.filter((u) => /-shadow\./.test(u)), REAL_UNITS = ALL_UNITS.filter((u) => !/-shadow\./.test(u));
/**
 * RECORDER_SERVICES: the two real services gated on OWNERSHIP ("<unit> server") — what the deploy's gate proof starts while home owns
 * them. GATED_SERVICES: every real service with an ExecCondition (the check unit's is the token file, so it is not part of that proof).
 */
const RECORDER_SERVICES = ["traids-gex.service", "traids-flow.service"], GATED_SERVICES = [...RECORDER_SERVICES, "traids-schwab-md-check.service"];

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.length === 1 && a[0] === "--write") { fs.mkdirSync(SD, { recursive: true }); for (const [f, t] of Object.entries(expected())) { fs.writeFileSync(path.join(SD, f), t); console.log("written systemd/" + f); } process.exitCode = 0; }
  else if (a.length === 1 && a[0] === "--check") { let bad = 0; for (const [f, t] of Object.entries(expected())) { let cur = null; try { cur = fs.readFileSync(path.join(SD, f), "utf8"); } catch { cur = null; } const ok = cur === t; if (!ok) bad++; console.log(`${ok ? "ok  " : "DIFF"} systemd/${f}`); } process.exitCode = bad ? 1 : 0; }
  else { console.log("usage: node units.cjs --write | --check"); process.exitCode = 2; }
}
module.exports = { expected, shadowOf, UNITS, ALL_UNITS, REAL_UNITS, SHADOW_UNITS, RECORDER_SERVICES, GATED_SERVICES, CHECK_CONDITION, REAL_B, SHADOW_B, ENV, TOKEN, PERMISSION, ASKED, NODE };
