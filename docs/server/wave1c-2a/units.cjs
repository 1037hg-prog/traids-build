#!/usr/bin/env node
/**
 * UNITS — every systemd unit of W1c + W2a, generated (the real ones from the templates below, the SHADOW ones mechanically from the
 * real ones), so the files in systemd/ can never drift from this source. 2026-10-08 (docs/server/wave1c-2a).
 *
 *   node docs/server/wave1c-2a/units.cjs --write    (re)write systemd/*.{service,timer}
 *   node docs/server/wave1c-2a/units.cjs --check    exit 0 when every file equals what expected() makes
 *
 * Unit template (plan v2 M5, as W1): User=traids · TZ=America/Denver · OnFailure=traids-alert@%n.service (the server's de-duplicated
 * ops-bot path; neither script has an alert path of its own) · its own EnvironmentFile /etc/traids/<unit>.env · ExecCondition = W1's
 * /bin/sh wrapper around own-check.cjs (own-check.cjs conditionCommand: 0 run · 77 -> 1 skip · anything else -> 255 fail -> alert).
 *   traids-spread   oneshot, every 15 min 24/7, under the pull flock w1c-spread.flock
 *   traids-fills    ONE long-running process (Type=simple, Restart=on-failure); its timer is a keeper (every 15 min a start is a no-op
 *                   while it runs, and is skipped by the ExecCondition while home owns it). own.cjs requires every unit to have a timer.
 * A SHADOW unit differs from its real unit only in: the tree (/home/traids/w1c2a-shadow/backend: the same script bytes, which write
 * that tree's data/ only — never pulled), ExecCondition "<unit> home" (it runs only while home owns the unit, i.e. beside home: the
 * dry period), SyslogIdentifier, Description and the timer's Unit=. The real and shadow units share the env file.
 * Names avoid the traids-w1* prefix on purpose: W1's rollback.cjs --server counts `systemctl list-timers 'traids-w1*'`.
 */
"use strict";
const fs = require("fs"), path = require("path");
const REPO = path.resolve(__dirname, "..", "..", "..");
const OC = require(path.join(REPO, "deploy", "server", "own-check.cjs"));
const SD = path.join(__dirname, "systemd"), REAL_B = "/home/traids/traids/backend", SHADOW_B = "/home/traids/w1c2a-shadow/backend";
const NODE = "/usr/local/bin/node";
const UNITS = {
  spread: { unit: "w1c-spread", wave: "w1c", env: "/etc/traids/w1c-spread.env" },
  fills: { unit: "w2a-fills", wave: "w2a", env: "/etc/traids/w2a-fills.env" },
};

function realService(x) {
  const u = UNITS[x];
  if (x === "spread") return [
    "# TRAIDS W1c (server migration, docs/server/wave1c-2a): backend/crypto-spread-snapshot.js --symbols-file appends one row per quoted",
    "# symbol per run to data/crypto-spread-log.jsonl (Alpaca latest quotes, the Coinbase level-1 book for names Alpaca does not run).",
    "# The universe is home's data/crypto-symbols.json (built nightly at home from the canonical ledger; pushed read-only by every pull).",
    "# Every 15 min, 24/7 (traids-spread.timer). Runs ONLY while home's map says \"w1c-spread\": \"server\". Keys: /etc/traids/w1c-spread.env",
    "# (the main paper pair, data only; root:traids 0640). A nonzero exit pages through traids-alert@ (the same failure re-pages at most",
    "# every 3 h).",
    "[Unit]",
    "Description=TRAIDS W1c crypto spread snapshot (runs only while server-owned)",
    `Documentation=file://${REAL_B}/crypto-spread-snapshot.js`,
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
    `EnvironmentFile=${u.env}`,
    `ExecCondition=${OC.conditionCommand(u.unit, "server")}`,
    `ExecStart=/usr/bin/flock -w 600 ${REAL_B}/data/w1c-spread.flock ${NODE} ${REAL_B}/crypto-spread-snapshot.js --symbols-file`,
    "SyslogIdentifier=traids-spread",
    "TimeoutStartSec=10min",
    "TimeoutStopSec=60s",
    "KillMode=control-group",
    "MemoryMax=512M",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectSystem=full",
    "",
  ].join("\n");
  return [
    "# TRAIDS W2a (server migration, docs/server/wave1c-2a): backend/alpaca-fills-stream.js --tv-24x7, the read-only trade_updates",
    "# recorder (places, cancels and changes nothing) -> data/alpaca-trade-updates.jsonl. ONE long-running process: the TV account (R309",
    "# trades crypto on weekends) is recorded around the clock, main and book weekdays 06:00-18:30 ET as at home. Restart=on-failure; the",
    "# keeper timer re-starts it within 15 min after any clean exit. Runs ONLY while home's map says \"w2a-fills\": \"server\" (checked at",
    "# every start). Keys: /etc/traids/w2a-fills.env (the main, BOOK and TV paper pairs; root:traids 0640). OnFailure pages through",
    "# traids-alert@ once the restart limit is hit.",
    "[Unit]",
    "Description=TRAIDS W2a Alpaca fills stream (runs only while server-owned)",
    `Documentation=file://${REAL_B}/alpaca-fills-stream.js`,
    "After=network-online.target time-sync.target",
    "Wants=network-online.target",
    "OnFailure=traids-alert@%n.service",
    "StartLimitIntervalSec=900",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "User=traids",
    "Group=traids",
    `WorkingDirectory=${REAL_B}`,
    "Environment=TZ=America/Denver",
    `EnvironmentFile=${u.env}`,
    `ExecCondition=${OC.conditionCommand(u.unit, "server")}`,
    `ExecStart=${NODE} ${REAL_B}/alpaca-fills-stream.js --tv-24x7`,
    "Restart=on-failure",
    "RestartSec=30",
    "SyslogIdentifier=traids-fills",
    "TimeoutStopSec=30s",
    "KillMode=control-group",
    "MemoryMax=512M",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectSystem=full",
    "",
  ].join("\n");
}
function realTimer(x) {
  if (x === "spread") return [
    "# TRAIDS W1c crypto spread snapshot — every 15 minutes, 24/7: the cadence the script's own docstring asks for. At home it ran every",
    "# 30 min on weekdays 07:40-14:40 MT (intraday.bat -> board-discipline.bat); the change is recorded by register.cjs w1c (change",
    "# registry). Persistent=false: a missed snapshot is a missed measurement, never replayed later.",
    "[Unit]",
    "Description=TRAIDS W1c crypto spread snapshot, every 15 minutes",
    "",
    "[Timer]",
    "OnCalendar=*-*-* *:00/15:00",
    "AccuracySec=1s",
    "RandomizedDelaySec=0",
    "Persistent=false",
    "Unit=traids-spread.service",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return [
    "# TRAIDS W2a fills stream KEEPER timer: every 15 minutes (and 2 min after boot) it starts traids-fills.service, which is a no-op",
    "# while the stream runs and a condition-skip while home owns it. own.cjs needs a timer per unit; this one bounds any gap after a",
    "# clean exit to 15 minutes.",
    "[Unit]",
    "Description=TRAIDS W2a Alpaca fills stream keeper, every 15 minutes",
    "",
    "[Timer]",
    "OnCalendar=*-*-* *:00/15:00",
    "OnBootSec=2min",
    "AccuracySec=1s",
    "RandomizedDelaySec=0",
    "Persistent=false",
    "Unit=traids-fills.service",
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
    if (/^Description=/.test(m)) m = m.replace(/^Description=TRAIDS (W1c|W2a) /, "Description=TRAIDS $1 SHADOW ").replace(/\(runs only while server-owned\)/, "(dry period; runs only while home-owned)");
    if (/^WorkingDirectory=/.test(m)) m = `WorkingDirectory=${SHADOW_B}`;
    if (/^ExecCondition=/.test(m)) { const n = m.replace(`own-check.cjs ${u.unit} server;`, `own-check.cjs ${u.unit} home;`); if (n === m) throw new Error(`units.cjs: traids-${x}.${kind}'s ExecCondition has no "own-check.cjs ${u.unit} server;"`); m = n; cond++; }
    if (/^ExecStart=/.test(m)) m = m.split(`${REAL_B}/`).join(`${SHADOW_B}/`);
    if (/^SyslogIdentifier=/.test(m)) m = `SyslogIdentifier=traids-${x}-shadow`;
    if (/^Unit=/.test(m)) m = `Unit=traids-${x}-shadow.service`;
    out.push(m);
  }
  if (kind === "service" && cond !== 1) throw new Error(`units.cjs: traids-${x}.service has ${cond} ExecCondition lines (want 1)`);
  const head = kind === "service"
    ? [`# TRAIDS ${u.wave.toUpperCase()} SHADOW (dry period, docs/server/wave1c-2a) — derived by units.cjs from traids-${x}.service. The same script`,
      `# bytes from the shadow tree ${SHADOW_B}; they write ${SHADOW_B}/data only, which is never pulled; compare.cjs ${u.wave}`,
      `# compares it with home's same period. ExecCondition "home": it starts only while home owns the unit; deploy.cjs --cutover ${u.wave}`,
      "# stops and disables it (a running process is not stopped by a condition). OnFailure stays on: a failing shadow pages."]
    : [`# TRAIDS ${u.wave.toUpperCase()} SHADOW timer — derived by units.cjs from traids-${x}.timer: the same calendar as the real unit.`];
  return [...head, ...out].join("\n");
}
function expected() {
  const m = {};
  for (const x of Object.keys(UNITS)) {
    m[`traids-${x}.service`] = realService(x); m[`traids-${x}.timer`] = realTimer(x);
    m[`traids-${x}-shadow.service`] = shadowOf(realService(x), "service", x); m[`traids-${x}-shadow.timer`] = shadowOf(realTimer(x), "timer", x);
  }
  return m;
}
const ALL_UNITS = Object.keys(expected());
const REAL_UNITS = ALL_UNITS.filter((u) => !/-shadow\./.test(u)), SHADOW_UNITS = ALL_UNITS.filter((u) => /-shadow\./.test(u));
const unitsOf = (wave) => ALL_UNITS.filter((f) => UNITS[f.replace(/^traids-/, "").replace(/(-shadow)?\.(service|timer)$/, "")].wave === wave);

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.length === 1 && a[0] === "--write") { fs.mkdirSync(SD, { recursive: true }); for (const [f, t] of Object.entries(expected())) { fs.writeFileSync(path.join(SD, f), t); console.log("written systemd/" + f); } process.exitCode = 0; }
  else if (a.length === 1 && a[0] === "--check") { let bad = 0; for (const [f, t] of Object.entries(expected())) { let cur = null; try { cur = fs.readFileSync(path.join(SD, f), "utf8"); } catch { cur = null; } const ok = cur === t; if (!ok) bad++; console.log(`${ok ? "ok  " : "DIFF"} systemd/${f}`); } process.exitCode = bad ? 1 : 0; }
  else { console.log("usage: node units.cjs --write | --check"); process.exitCode = 2; }
}
module.exports = { expected, shadowOf, UNITS, ALL_UNITS, REAL_UNITS, SHADOW_UNITS, unitsOf, REAL_B, SHADOW_B };
