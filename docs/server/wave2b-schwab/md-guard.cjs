#!/usr/bin/env node
/**
 * MD GUARD — the home side's checks of the Schwab app on the VPS (server migration W2b, 2026-10-09; reworked 2026-10-11 on the
 * operator's decision "yes use the existing app", docs/server/wave2b-schwab). Shared by deploy.cjs (its keys, units-shadow and home
 * steps and its cutover) and schwab-auth.cjs. Pure on its inputs: home's backend/.env is read by the caller, in memory.
 *
 * ONE APP. Schwab allows one app per API product: the VPS uses the operator's existing app, the one home uses. Nothing here refuses a
 * VPS app equal to home's (that rule is void). The gate is the LIVE PERMISSION CHECK the VPS makes (lib/schwab-md.js): Schwab's accounts
 * side must REFUSE the token; judgeStatus reads the VPS's answer.
 *
 * THE KEYS. The VPS env file holds only SCHWAB_MD_APP_KEY, SCHWAB_MD_APP_SECRET (and SCHWAB_MD_CALLBACK when set). Their VALUES come
 * from home's SCHWAB_MD_* when the operator has set both, else from home's SCHWAB_APP_KEY / SCHWAB_APP_SECRET (the same app). No other
 * Schwab name ever goes into that file; the refresh token never goes into an env file. Every message names keys and lengths, never a
 * value or a hash.
 *   node docs/server/wave2b-schwab/md-guard.cjs --selftest
 */
"use strict";
const path = require("path"), crypto = require("crypto");
const MD = require(path.join(__dirname, "backend", "lib", "schwab-md.js"));
const ENV_FILE = "/etc/traids/w2b-schwab.env", UNIT_ENV = "w2b-schwab", TOKEN_FILE = "/home/traids/.traids/schwab-md-token.json";
/** read-only: the token file's owner and mode on the VPS ("traids 600" is the only right answer; "ABSENT" when it is not there) */
const TOKEN_STAT_CMD = `stat -c '%U %a' ${TOKEN_FILE} 2>/dev/null || echo ABSENT`;
const REQUIRED = ["SCHWAB_MD_APP_KEY", "SCHWAB_MD_APP_SECRET"], OPTIONAL = ["SCHWAB_MD_CALLBACK"], HOME_NAMES = ["SCHWAB_APP_KEY", "SCHWAB_APP_SECRET", "SCHWAB_REFRESH_TOKEN"];
/** where a VPS name's value comes from at home when the operator has not set the SCHWAB_MD_* pair */
const HOME_SOURCE = { SCHWAB_MD_APP_KEY: "SCHWAB_APP_KEY", SCHWAB_MD_APP_SECRET: "SCHWAB_APP_SECRET" };
const ALLOWED_KEY = /^SCHWAB_MD_(APP_KEY|APP_SECRET|CALLBACK)$/;
const LIVE_MONEY = /^(SCHWAB_(?!MD_)|TASTY|SMTP|MAIL|TELEGRAM|NTFY|TWILIO|RESEND|ALPACA|ANTHROPIC|GEMINI|OPENAI|MASSIVE|FINNHUB)|ARM|LIVE|TOKEN|REFRESH|PASS/i;
const sha = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const AUTH = "node docs/server/wave2b-schwab/schwab-auth.cjs";
const SIGN_IN = `${AUTH} --login (the VPS's own sign-in) or ${AUTH} --share-from-home (home's token)`;

/** null when every name of the plan (the names written INTO the VPS env file) is a SCHWAB_MD_* name; else the refusal (nothing read, nothing sent) */
function keyPlanGuard(names) {
  const bad = [];
  if (!Array.isArray(names) || !REQUIRED.every((n) => names.includes(n))) bad.push(`the plan must name ${REQUIRED.join(" and ")}`);
  for (const n of names || []) { if (LIVE_MONEY.test(n)) bad.push(`${n} is a LIVE-MONEY / home / credential name — never written into the VPS env file`); else if (!ALLOWED_KEY.test(n)) bad.push(`${n} is not a name of the VPS env file (${[...REQUIRED, ...OPTIONAL].join(", ")})`); }
  return bad.length ? "key plan REFUSED (nothing read, nothing sent): " + bad.join("; ") : null;
}
/**
 * home's .env text -> { md: { VPS NAME: value }, source: { VPS NAME: the home name it came from }, problems, home: { key, secret, refresh } }.
 * The SCHWAB_MD_* pair when home has BOTH; else home's SCHWAB_APP_KEY / SCHWAB_APP_SECRET when it has both; else nothing (md is empty).
 * A half-set pair is a problem (a key is never paired with another app's secret). Every other line of the file is dropped.
 */
function readHomeEnv(text) {
  const v = MD.parseEnvText(text).values, md = {}, source = {}, problems = [];
  const mdSet = REQUIRED.filter((n) => v[n]), homeSet = REQUIRED.filter((n) => v[HOME_SOURCE[n]]);
  if (mdSet.length === REQUIRED.length) for (const n of REQUIRED) { md[n] = v[n]; source[n] = n; }
  else if (mdSet.length) problems.push(`backend/.env sets ${mdSet.join(", ")} but not ${REQUIRED.filter((n) => !v[n]).join(", ")} — set both or neither (a key is never paired with another app's secret)`);
  else if (homeSet.length === REQUIRED.length) for (const n of REQUIRED) { md[n] = v[HOME_SOURCE[n]]; source[n] = HOME_SOURCE[n]; }
  else if (homeSet.length) problems.push(`backend/.env sets ${homeSet.map((n) => HOME_SOURCE[n]).join(", ")} but not ${REQUIRED.filter((n) => !v[HOME_SOURCE[n]]).map((n) => HOME_SOURCE[n]).join(", ")} — the app needs both`);
  if (md.SCHWAB_MD_APP_KEY && v.SCHWAB_MD_CALLBACK) { md.SCHWAB_MD_CALLBACK = v.SCHWAB_MD_CALLBACK; source.SCHWAB_MD_CALLBACK = "SCHWAB_MD_CALLBACK"; }
  return { md, source, problems, home: { key: v.SCHWAB_APP_KEY || null, secret: v.SCHWAB_APP_SECRET || null, refresh: v.SCHWAB_REFRESH_TOKEN || null } };
}
/** home's own fingerprints, computed in memory (never printed, never sent): only to SAY whether the VPS holds the same app / token */
const homeShas = (h) => ({ key: h && h.key ? sha(h.key) : null, secret: h && h.secret ? sha(h.secret) : null, refresh: h && h.refresh ? sha(h.refresh) : null });
/** problems with the values that would be sent (names / lengths only) */
function mdProblems(md) {
  const p = [];
  for (const n of REQUIRED) if (!md[n]) p.push(`${n} has no value at home (neither the SCHWAB_MD_* pair nor SCHWAB_APP_KEY / SCHWAB_APP_SECRET is in backend/.env)`);
  if (p.length) return p;
  try { MD.appFrom(md); } catch (e) { p.push(e.message.replace(/^schwab-md: /, "")); }
  return p;
}
function envContent(md, stamp = new Date().toISOString()) {
  return [`# ${ENV_FILE} — written by docs/server/wave2b-schwab/deploy.cjs (its keys step) ${stamp}. The operator's ONE Schwab app, for`,
    "# traids-gex / traids-flow (+ shadows), traids-schwab-md-check, schwab-md-auth.cjs and every other VPS unit that reads Schwab.",
    "# root:traids 0640. Never print it, never copy it. ONLY these names belong here; the refresh token is never in an env file: it lives",
    "# in /home/traids/.traids/schwab-md-token.json (0600). The units use the token only while Schwab's accounts side refuses it.",
    ...[...REQUIRED, ...OPTIONAL].filter((n) => md[n]).map((n) => `${n}=${md[n]}`), ""].join("\n");
}
/** the remote side of a place: the content arrives on STDIN only */
const placeScript = () => ["set -eu", "umask 077", `F=${ENV_FILE}`, "sudo -n test -d /etc/traids || sudo -n install -d -m 0750 -o root -g traids /etc/traids",
  `tmp=$(sudo -n mktemp /etc/traids/.${UNIT_ENV}.env.XXXXXX)`, 'sudo -n tee "$tmp" > /dev/null', 'sudo -n chown root:traids "$tmp"', 'sudo -n chmod 0640 "$tmp"', 'sudo -n mv -f "$tmp" "$F"',
  `echo "@@PLACED ${UNIT_ENV} $(sudo -n stat -c '%U:%G %a' "$F")"`].join("\n");
/** read-only: NAME LENGTH SHA256 per NAME=value line, a LINE NUMBER for any other line — never a value */
const checkScript = () => ["set -u", "export LC_ALL=C", `F=${ENV_FILE}`,
  'if ! sudo -n test -f "$F"; then echo "@@ABSENT"; echo "@@END"; exit 0; fi',
  `echo "@@STAT $(sudo -n stat -c '%U:%G %a' "$F" 2>&1)"`,
  `i=0; sudo -n cat "$F" | while IFS= read -r line; do i=$((i+1)); case "$line" in '#'*|'') continue;; esac; case "$line" in *=*) ;; *) printf '@@BADLINE %s\\n' "$i"; continue;; esac; n=\${line%%=*}; case "$n" in ''|*[!A-Z0-9_]*) printf '@@BADLINE %s\\n' "$i"; continue;; esac; v=\${line#*=}; printf '@@VAR %s %s %s\\n' "$n" "\${#v}" "$(printf %s "$v" | sha256sum | cut -c1-64)"; done`,
  'echo "@@END"'].join("\n");
/**
 * pure: the env-file check's output -> { ok, absent, lines, problems }. mdValues (copy mode): each name must equal the value sent (by sha);
 * null (verify-only: the operator wrote the file by sudoedit) — the names and the mode still apply.
 */
function judgeEnvCheck(out, mdValues) {
  const o = String(out || "");
  if (!/@@END/.test(o)) return { ok: false, absent: false, lines: [], problems: ["the check did not complete"] };
  if (/@@ABSENT/.test(o)) return { ok: false, absent: true, lines: ["absent"], problems: ["absent"] };
  const problems = [], lines = [], st = ((/@@STAT (.*)/.exec(o) || [])[1] || "").trim().replace(/[^\x20-\x7e]/g, "?").slice(0, 40);
  if (st !== "root:traids 640") problems.push(`mode is ${st || "?"}, want root:traids 640`);
  const bl = [...o.matchAll(/@@BADLINE (\d+)/g)].map((m) => m[1]); if (bl.length) problems.push(`line(s) ${bl.join(", ")} are not NAME=value (contents not printed)`);
  const vars = [...o.matchAll(/@@VAR (\S+) (\d+) ([0-9a-f]{64})/g)].map((m) => ({ name: m[1], len: +m[2], sha: m[3] }));
  const names = vars.map((v) => v.name), want = mdValues ? Object.keys(mdValues) : null;
  for (const n of REQUIRED) if (!names.includes(n)) problems.push(`${n} missing`);
  const foreign = names.filter((n) => !ALLOWED_KEY.test(n)); if (foreign.length) problems.push(`name(s) that do not belong: ${foreign.filter((n) => /^[A-Z0-9_]+$/.test(n)).join(", ")}${foreign.some((n) => HOME_NAMES.includes(n)) ? " — home's env names never go into this file (the app goes in as SCHWAB_MD_APP_KEY / SCHWAB_MD_APP_SECRET; the refresh token only in the token file): REFUSED" : ""}`);
  if (new Set(names).size !== names.length) problems.push("a name appears twice");
  for (const v of vars.filter((x) => ALLOWED_KEY.test(x.name))) {
    let same = null; if (want) { same = mdValues[v.name] != null && v.sha === sha(mdValues[v.name]); if (!same) problems.push(`${v.name} differs from home`); }
    lines.push(`${v.name} length ${v.len}${same == null ? "" : same ? " · equals home" : " · DIFFERS from home"}`);
  }
  if (want) for (const n of want) if (!names.includes(n)) problems.push(`${n} missing`);
  return { ok: problems.length === 0, absent: false, lines, problems: [...new Set(problems)] };
}
/** the "@@STATUS {...}" line of schwab-md-auth.cjs --status --json [--probe] -> the object, or null */
function parseStatus(out) { const m = /^@@STATUS (\{.*\})\s*$/m.exec(String(out || "")); if (!m) return null; try { const j = JSON.parse(m[1]); return j && j.schema === "schwab-md-status-v2" ? j : null; } catch { return null; } }
const modeText = (m) => (m === "shared" ? "shared from home" : m === "login" ? "the VPS's own sign-in" : "?");
/** one line for the permission verdict on record (status code and times only) */
function permissionLine(p) {
  if (!p || p.verdict === "none" || !p.verdict) return "permission: no verdict on record yet (the first sign-in or share records one)";
  if (p.verdict === "accepted") return `permission: Schwab's accounts side ACCEPTED the token (HTTP ${p.status} at ${p.at}) — every Schwab call on the VPS refuses`;
  return `permission: Schwab's accounts side refused the token (HTTP ${p.status} at ${p.at}, ${p.ageHours} h ago${p.fresh ? "" : " — older than 24 h, it no longer counts"}) — market data only`;
}
/**
 * pure: the VPS's status -> { ok, problems, lines }.
 *   requireToken false = before a sign-in (the env must be right; no token yet); minHours = the refresh life the caller needs
 *   (units-shadow 72 h, home 72 h, the cutover 24 h).
 *   requirePermission (default: as requireToken) = THE GATE: the status must carry the VPS's LIVE answer (--probe) and that answer must
 *   be "allowed" — Schwab's accounts side refused the token now, or gave no verdict while a refusal under 24 h old is on record. An
 *   ACCEPTED answer (the app can see accounts) refuses every step.
 *   home (optional { key, secret, refresh } fingerprints): only to SAY whether the VPS holds home's app and home's token.
 *   A token on the VPS that was issued to ANOTHER app key (the key in the env file was replaced after the sign-in) is a problem only
 *   where a token is required (the deploy steps, --status). Before a sign-in (requireToken false) it is reported as a fourth line and
 *   nothing more: the sign-in is what replaces it, so it must not be what refuses the sign-in. signingIn words that line for the
 *   sign-in commands.
 */
function judgeStatus(st, { requireToken = true, minHours = 24, requirePermission = requireToken, home = null, signingIn = false } = {}) {   // requirePermission "record": only an ACCEPTED verdict on record refuses (a read-only status carries no live answer)
  if (!st) return { ok: false, problems: ["the VPS's schwab-md-auth.cjs --status --json gave no readable status (not installed, or an older copy? run the copy step of deploy.cjs)"], lines: [] };
  const p = [], e = st.env || {}, t = st.token || {}, perm = st.permission || {}, live = st.live || null;
  if (!e.ok) p.push(`the VPS env file is not usable: ${e.why || "?"}`);
  if (requireToken) {
    if (t.foreignApp) p.push(`the VPS's token was issued to another app key than its SCHWAB_MD_APP_KEY — sign in again: ${SIGN_IN}`);
    if (!t.ok) p.push(`the Schwab token is not on the VPS or not usable (${t.why || "?"}) — the operator's step: ${SIGN_IN}`);
    else if (!(t.hoursLeft >= minHours)) p.push(`the token has ${t.hoursLeft} h of refresh life left (this step wants >= ${minHours} h) — sign in first: ${t.mode === "shared" ? "automation\\schwab-auth.bat at home, then " + AUTH + " --share-from-home" : AUTH + " --login"}`);
  }
  if (requirePermission) {
    if (perm.verdict === "accepted" || (live && live.kind === "accounts-accepted")) p.push(`PERMISSION GATE: Schwab's accounts side ACCEPTS this app's token (HTTP ${live && live.status != null ? live.status : perm.status}) — the VPS takes only an app that is refused there (market data only): REFUSED; every Schwab call on the VPS refuses too`);
    else if (requirePermission === "record") { /* nothing more is asked of a read-only status */ }
    else if (!live) p.push("PERMISSION GATE: the VPS gave no live permission verdict (an older helper on the VPS? run the copy step of deploy.cjs) — REFUSED (fail-closed)");
    else if (!live.allowed && t.ok) p.push(`PERMISSION GATE: not proven — ${String(live.why || "the VPS's check did not allow the call").slice(0, 400)}`);
  }
  const same = (a, b) => (a && b ? a === b : null), app = home ? same(e.keySha256, home.key) : null, tk = home ? same(t.refreshSha256, home.refresh) : null;
  const lines = [`VPS env: ${e.ok ? `the app's ${(e.names || []).join(", ")} (key length ${e.keyLen}, secret length ${e.secretLen})${app == null ? "" : app ? " — the same app as home's SCHWAB_APP_KEY" : " — NOT home's SCHWAB_APP_KEY (another app)"}` : "NOT OK"}`,
    `VPS token: ${t.ok ? `ok, ${modeText(t.mode)}, signed in ${t.issuedAt} (${t.ageHours} h ago), refresh life ends ${t.refreshExpiresAt} (${t.hoursLeft} h left)${tk == null ? "" : tk ? " — home's current token" : " — not home's current token"}` : `none usable (${t.why || "?"})`}`,
    permissionLine(perm) + (live ? ` · asked now: ${live.allowed ? "allowed" : "NOT allowed"}` : "")];
  if (t.foreignApp && !requireToken) lines.push(signingIn ? "the token on the VPS belongs to another app key; this sign-in replaces it" : `the token on the VPS belongs to another app key than its SCHWAB_MD_APP_KEY: no unit can use it, and the next sign-in replaces it (${SIGN_IN})`);
  return { ok: p.length === 0, problems: [...new Set(p)], lines };
}
const STATUS_CMD = "/usr/local/bin/node /home/traids/traids/backend/schwab-md-auth.cjs --status --json";
/** the same, with the VPS's live check (one refresh and the permission gate, on the VPS; a record younger than 15 minutes is reused) */
const PROBE_CMD = STATUS_CMD + " --probe";

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + String(d).slice(0, 400) : "")); } };
  const K = "MDKEYmdkeyMDKEYmdkeyMDKEYmdkey12", S = "mdSecretXYZ12345", HK = "HOMEKEYhomekeyHOMEKEYhomekeyHO99", HS = "homeSecret98765", HR = "home-refresh-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@";
  const HOME = [`SCHWAB_APP_KEY=${HK}`, `SCHWAB_APP_SECRET="${HS}"`, `SCHWAB_REFRESH_TOKEN=${HR}`, "ALPACA_KEY_ID=PKxxxxxxxxxxxxxxxxxx", "TASTY_CLIENT_SECRET=zzz"];
  const ENV = [...HOME, `SCHWAB_MD_APP_KEY=${K}`, `SCHWAB_MD_APP_SECRET=${S}`].join("\r\n");
  const SECRETS = [K, S, HK, HS, HR, sha(K), sha(S), sha(HK), sha(HS), sha(HR)], leaks = (s) => SECRETS.filter((x) => String(s).includes(x));
  ok("key plan: the market-data names pass; the optional callback passes", keyPlanGuard(REQUIRED) === null && keyPlanGuard([...REQUIRED, ...OPTIONAL]) === null);
  ok("the names written INTO the VPS env file: SCHWAB_APP_KEY, SCHWAB_APP_SECRET, SCHWAB_REFRESH_TOKEN, SCHWAB_MD_REFRESH_TOKEN, TASTY_*, SMTP_PASS, *_LIVE_ARMED, TELEGRAM_BOT_TOKEN, ALPACA_KEY_ID are each REFUSED, named (home's app goes in under the SCHWAB_MD_* names only; the refresh token never)", ["SCHWAB_APP_KEY", "SCHWAB_APP_SECRET", "SCHWAB_REFRESH_TOKEN", "SCHWAB_MD_REFRESH_TOKEN", "TASTY_CLIENT_SECRET", "SMTP_PASS", "R295_LIVE_ARMED", "TELEGRAM_BOT_TOKEN", "ALPACA_KEY_ID"].every((n) => new RegExp(`${n} is a LIVE-MONEY`).test(keyPlanGuard([...REQUIRED, n]) || "")) && /not a name of the VPS env file/.test(keyPlanGuard([...REQUIRED, "SCHWAB_MD_OTHER"]) || "") && /must name/.test(keyPlanGuard(["SCHWAB_MD_APP_KEY"]) || ""));
  const h = readHomeEnv(ENV);
  ok("readHomeEnv, home has BOTH pairs: the SCHWAB_MD_* pair is taken (quotes stripped, CRLF), each value's source named; home's three are read for fingerprints; nothing else kept", JSON.stringify(Object.keys(h.md)) === JSON.stringify(REQUIRED) && h.md.SCHWAB_MD_APP_KEY === K && h.md.SCHWAB_MD_APP_SECRET === S && JSON.stringify(h.source) === JSON.stringify({ SCHWAB_MD_APP_KEY: "SCHWAB_MD_APP_KEY", SCHWAB_MD_APP_SECRET: "SCHWAB_MD_APP_SECRET" }) && h.problems.length === 0 && h.home.key === HK && h.home.secret === HS && h.home.refresh === HR && !JSON.stringify(h).includes("PKxxx") && !JSON.stringify(h).includes("zzz"));
  const h1 = readHomeEnv(HOME.join("\n"));
  ok("ONE APP — readHomeEnv, home has only SCHWAB_APP_KEY / SCHWAB_APP_SECRET: their VALUES are taken under the VPS names SCHWAB_MD_APP_KEY / SCHWAB_MD_APP_SECRET (source named); the refresh token is never among the values to send", JSON.stringify(Object.keys(h1.md)) === JSON.stringify(REQUIRED) && h1.md.SCHWAB_MD_APP_KEY === HK && h1.md.SCHWAB_MD_APP_SECRET === HS && JSON.stringify(h1.source) === JSON.stringify({ SCHWAB_MD_APP_KEY: "SCHWAB_APP_KEY", SCHWAB_MD_APP_SECRET: "SCHWAB_APP_SECRET" }) && h1.problems.length === 0 && !Object.values(h1.md).includes(HR) && mdProblems(h1.md).length === 0);
  const h0 = readHomeEnv("ALPACA_KEY_ID=PKxxxxxxxxxxxxxxxxxx\nSCHWAB_REFRESH_TOKEN=" + HR), hHalf = readHomeEnv([...HOME, `SCHWAB_MD_APP_KEY=${K}`].join("\n")), hHalf2 = readHomeEnv(`SCHWAB_APP_KEY=${HK}`);
  ok("readHomeEnv, home has NEITHER pair: nothing to send (md empty, no problem; mdProblems names both). A HALF-SET pair (SCHWAB_MD_APP_KEY without its secret, even with home's app there; or SCHWAB_APP_KEY without its secret) -> a problem and nothing to send: a key is never paired with another app's secret", Object.keys(h0.md).length === 0 && h0.problems.length === 0 && mdProblems(h0.md).length === 2 && /SCHWAB_MD_APP_KEY has no value at home/.test(mdProblems(h0.md)[0]) && Object.keys(hHalf.md).length === 0 && /sets SCHWAB_MD_APP_KEY but not SCHWAB_MD_APP_SECRET — set both or neither/.test(hHalf.problems[0]) && Object.keys(hHalf2.md).length === 0 && /sets SCHWAB_APP_KEY but not SCHWAB_APP_SECRET/.test(hHalf2.problems[0]) && !leaks([...hHalf.problems, ...hHalf2.problems, ...mdProblems(h0.md)].join()).length);
  { const hc = readHomeEnv([...HOME, "SCHWAB_MD_CALLBACK=https://127.0.0.1:8182/cb"].join("\n")), hn = readHomeEnv("SCHWAB_MD_CALLBACK=https://127.0.0.1:8182/cb");
    ok("the optional callback rides along when the operator set it (whichever pair supplied the app); alone it is nothing to send", hc.md.SCHWAB_MD_CALLBACK === "https://127.0.0.1:8182/cb" && hc.source.SCHWAB_MD_APP_KEY === "SCHWAB_APP_KEY" && Object.keys(hn.md).length === 0); }
  ok("mdProblems: the SCHWAB_MD_* pair -> none", mdProblems(h.md).length === 0);
  const same = mdProblems({ SCHWAB_MD_APP_KEY: HK, SCHWAB_MD_APP_SECRET: HS });
  ok("ONE APP: SCHWAB_MD_APP_KEY / SECRET equal to home's SCHWAB_APP_KEY / SECRET is the EXPECTED case — no problem, no refusal", same.length === 0);
  ok("mdProblems: missing -> named; malformed -> its length only", /SCHWAB_MD_APP_KEY has no value at home/.test(mdProblems({ SCHWAB_MD_APP_SECRET: S })[0] || "") && /\(length 3\) is malformed/.test(mdProblems({ SCHWAB_MD_APP_KEY: "abc", SCHWAB_MD_APP_SECRET: S })[0] || ""));
  const txt = envContent(h.md, "T"), txt1 = envContent(h1.md, "T"), body = (t) => t.split("\n").filter((l) => l && !l.startsWith("#"));
  ok("envContent: EXACTLY the two SCHWAB_MD_* lines whichever home names supplied the values (home's own names never appear as names; the refresh token never appears at all)", JSON.stringify(body(txt)) === JSON.stringify([`SCHWAB_MD_APP_KEY=${K}`, `SCHWAB_MD_APP_SECRET=${S}`]) && JSON.stringify(body(txt1)) === JSON.stringify([`SCHWAB_MD_APP_KEY=${HK}`, `SCHWAB_MD_APP_SECRET=${HS}`]) && ![txt, txt1].some((t) => /^SCHWAB_APP_|^SCHWAB_REFRESH|^TASTY|^ALPACA/m.test(t) || t.includes(HR)));
  // the env check's output, as the remote loop prints it
  const out = (vars, stat = "root:traids 640", extra = "") => `@@STAT ${stat}\n${vars.map(([n, v]) => `@@VAR ${n} ${v.length} ${sha(v)}`).join("\n")}\n${extra}@@END\n`;
  ok("judgeEnvCheck: the market-data pair, root:traids 640, equal to home's -> ok (names, lengths only)", judgeEnvCheck(out([["SCHWAB_MD_APP_KEY", K], ["SCHWAB_MD_APP_SECRET", S]]), h.md).ok && judgeEnvCheck(out([["SCHWAB_MD_APP_KEY", K], ["SCHWAB_MD_APP_SECRET", S]]), h.md).lines.every((l) => !/[0-9a-f]{64}/.test(l) && !leaks(l).length));
  const jt = judgeEnvCheck(out([["SCHWAB_MD_APP_KEY", HK], ["SCHWAB_MD_APP_SECRET", HS]]), null), jt1 = judgeEnvCheck(out([["SCHWAB_MD_APP_KEY", HK], ["SCHWAB_MD_APP_SECRET", HS]]), h1.md);
  ok("ONE APP — judgeEnvCheck: a VPS file holding HOME'S app key / secret under the SCHWAB_MD_* names -> ok, verify-only and copy mode alike (it is the same app; no refusal)", jt.ok && jt.problems.length === 0 && jt1.ok && jt1.lines.every((l) => / · equals home$/.test(l)), [...jt.problems, ...jt1.problems].join(" | "));
  const jn = judgeEnvCheck(out([["SCHWAB_MD_APP_KEY", K], ["SCHWAB_MD_APP_SECRET", S], ["SCHWAB_APP_KEY", HK]]), null), jr = judgeEnvCheck(out([["SCHWAB_MD_APP_KEY", K], ["SCHWAB_MD_APP_SECRET", S], ["SCHWAB_REFRESH_TOKEN", HR]]), null);
  ok("judgeEnvCheck: one of home's NAMES in the VPS file (SCHWAB_APP_KEY; or SCHWAB_REFRESH_TOKEN — a refresh token never goes into an env file) -> REFUSED, named", !jn.ok && jn.problems.some((p) => /SCHWAB_APP_KEY — home's env names never go into this file/.test(p)) && !jr.ok && jr.problems.some((p) => /SCHWAB_REFRESH_TOKEN — home's env names never go into this file[^]*the refresh token only in the token file/.test(p)));
  ok("judgeEnvCheck: wrong mode / a bad line / a rotated value / absent", /mode is root:root 644/.test(judgeEnvCheck(out([["SCHWAB_MD_APP_KEY", K], ["SCHWAB_MD_APP_SECRET", S]], "root:root 644"), h.md).problems.join()) && /line\(s\) 4/.test(judgeEnvCheck(out([["SCHWAB_MD_APP_KEY", K], ["SCHWAB_MD_APP_SECRET", S]], "root:traids 640", "@@BADLINE 4\n"), h.md).problems.join()) && /SCHWAB_MD_APP_SECRET differs from home/.test(judgeEnvCheck(out([["SCHWAB_MD_APP_KEY", K], ["SCHWAB_MD_APP_SECRET", "anotherSecret1234"]]), h.md).problems.join()) && judgeEnvCheck("@@ABSENT\n@@END\n", h.md).absent);
  // the status gate
  const REF = { verdict: "refused", status: 401, at: "2026-10-14T19:42:00.000Z", ageHours: 2.1, fresh: true }, LIVE_OK = { allowed: true, kind: null, why: null, status: null };
  const st = (o = {}) => ({ schema: "schwab-md-status-v2", env: { ok: true, names: REQUIRED, keyLen: 32, secretLen: 16, keySha256: sha(K), secretSha256: sha(S), ...(o.env || {}) }, token: { present: true, ok: true, mode: "login", issuedAt: "2026-10-13T23:00:00Z", ageHours: 18, refreshExpiresAt: "2026-10-20T23:00:00Z", hoursLeft: 150, refreshSha256: sha("md-refresh"), foreignApp: false, ...(o.token || {}) }, permission: o.permission === undefined ? REF : o.permission, ...(o.live === null ? {} : { live: o.live || LIVE_OK }) });
  const noTok = { token: { ok: false, present: false, why: "no token on this host yet", mode: null, hoursLeft: null }, permission: { verdict: "none", status: null, at: null, ageHours: null, fresh: false }, live: null };
  const J = (o, opt) => judgeStatus(st(o), opt), P = (o, opt) => J(o, opt).problems.join(" | ");
  ok("judgeStatus: the market-data app with a fresh token -> ok (lines carry no hash or value)", J().ok && J().problems.length === 0 && J().lines.length === 3 && J().lines.every((l) => !/[0-9a-f]{64}/.test(l) && !leaks(l).length));
  ok("judgeStatus's three lines name the token's way in, its age and hours left, and the verdict of Schwab's accounts side with its status code and the VPS's answer now", /the VPS's own sign-in, signed in 2026-10-13T23:00:00Z \(18 h ago\)[^]*\(150 h left\)/.test(J().lines[1]) && /refused the token \(HTTP 401 at 2026-10-14T19:42:00\.000Z, 2\.1 h ago\) — market data only · asked now: allowed/.test(J().lines[2]), J().lines.join(" | "));
  ok("judgeStatus: NO TOKEN on the VPS -> REFUSED with the paste-back command; the first login (requireToken false) passes", /not on the VPS or not usable[^]*schwab-auth\.cjs --login[^]*--share-from-home/.test(P(noTok)) && J(noTok, { requireToken: false }).ok && /no verdict on record yet/.test(J(noTok, { requireToken: false }).lines[2]));
  ok("judgeStatus: 20 h left with minHours 24 -> REFUSED (re-authorize first); 30 h -> ok", /20 h of refresh life left[^]*schwab-auth\.cjs --login$/.test(P({ token: { hoursLeft: 20 } }, { minHours: 24 })) && /automation\\schwab-auth\.bat at home, then [^]*--share-from-home$/.test(P({ token: { hoursLeft: 20, mode: "shared" } }, { minHours: 24 })) && J({ token: { hoursLeft: 30 } }, { minHours: 24 }).ok);
  ok("ONE APP — judgeStatus: the VPS app key EQUAL to home's SCHWAB_APP_KEY -> ok at every step (it is the same app), and the line says so; another app's key -> ok too, and the line says that", J({ env: { keySha256: sha(HK) } }, { home: homeShas(h.home) }).ok && /the same app as home's SCHWAB_APP_KEY/.test(J({ env: { keySha256: sha(HK) } }, { home: homeShas(h.home) }).lines[0]) && J({}, { home: homeShas(h.home) }).ok && /NOT home's SCHWAB_APP_KEY \(another app\)/.test(J({}, { home: homeShas(h.home) }).lines[0]) && !leaks(J({ env: { keySha256: sha(HK) } }, { home: homeShas(h.home) }).lines.join()).length);
  ok("ONE APP — judgeStatus: the VPS token EQUAL to home's SCHWAB_REFRESH_TOKEN (shared from home) -> ok, and the line says it is home's current token", J({ token: { mode: "shared", refreshSha256: sha(HR) } }, { home: homeShas(h.home) }).ok && /shared from home[^]*— home's current token$/.test(J({ token: { mode: "shared", refreshSha256: sha(HR) } }, { home: homeShas(h.home) }).lines[1]) && /not home's current token$/.test(J({}, { home: homeShas(h.home) }).lines[1]));
  const ACC = { permission: { verdict: "accepted", status: 200, at: "2026-10-14T19:42:00.000Z", ageHours: 0, fresh: false }, live: { allowed: false, kind: "accounts-accepted", why: "REFUSED — Schwab's accounts side ACCEPTED this app's token (HTTP 200 at 2026-10-14T19:42:00.000Z)", status: 200 } };
  ok("THE PERMISSION GATE — judgeStatus: Schwab's accounts side ACCEPTS the token (the VPS's live answer 200) -> REFUSED at every step (72 h, 24 h, 0 h), whatever the token's life; before a sign-in (requirePermission off) it is reported, not refused", [72, 24, 0].every((m) => /PERMISSION GATE: Schwab's accounts side ACCEPTS this app's token \(HTTP 200\)[^]*REFUSED/.test(P(ACC, { minHours: m }))) && J(ACC, { requireToken: false }).ok && /ACCEPTED the token \(HTTP 200/.test(J(ACC, { requireToken: false }).lines[2]));
  ok("THE PERMISSION GATE — judgeStatus: an 'accepted' verdict on RECORD refuses even when the status carries no live answer", /PERMISSION GATE: Schwab's accounts side ACCEPTS this app's token \(HTTP 200\)/.test(P({ permission: ACC.permission, live: null })));
  const UNK = { allowed: false, kind: "accounts-unknown", why: "REFUSED — the accounts-permission check gave no verdict (HTTP 503) and no 'refused' verdict is on record", status: 503 };
  ok("THE PERMISSION GATE — judgeStatus: NO verdict (the VPS's probe got a 503 and no refusal under 24 h old is on record) -> REFUSED 'not proven', quoting the VPS; a status with NO live answer at all (an older helper) -> REFUSED fail-closed; a 503 now WITH a fresh refusal on record (the VPS allowed it) -> ok", /PERMISSION GATE: not proven — REFUSED — the accounts-permission check gave no verdict \(HTTP 503\)/.test(P({ permission: { verdict: "none" }, live: UNK })) && /PERMISSION GATE: the VPS gave no live permission verdict[^]*fail-closed/.test(P({ live: null })) && J({ live: LIVE_OK }).ok);
  ok("judgeStatus for a read-only status (requirePermission 'record', what schwab-auth.cjs --status asks): no live answer is wanted — a refused or missing verdict passes; an ACCEPTED verdict on record still refuses", J({ live: null }, { requirePermission: "record" }).ok && J({ live: null, permission: { verdict: "none" } }, { requirePermission: "record" }).ok && /PERMISSION GATE: Schwab's accounts side ACCEPTS/.test(P({ live: null, permission: ACC.permission }, { requirePermission: "record" })));
  ok("judgeStatus: a foreign-app token -> REFUSED; an unreadable status -> REFUSED; a v1 status (the helper of before 2026-10-11) is not read", /another app key/.test(P({ token: { foreignApp: true } })) && !judgeStatus(null).ok && parseStatus("@@STATUS " + JSON.stringify({ ...st(), schema: "schwab-md-status-v1" })) === null);
  { const FOR = { token: { ok: false, present: true, foreignApp: true, why: "the token was issued to ANOTHER app key than SCHWAB_MD_APP_KEY — refused; sign this app in again", mode: null, hoursLeft: null }, permission: { verdict: "none", status: null, at: null, ageHours: null, fresh: false }, live: null };
    const before = J(FOR, { requireToken: false }), signing = J(FOR, { requireToken: false, signingIn: true }), need = J(FOR, { minHours: 24 }), rec = J(FOR, { requireToken: true, minHours: 0, requirePermission: "record" });
    ok("A TOKEN ISSUED TO ANOTHER APP KEY (the key in the VPS env file was replaced after the sign-in) never refuses the sign-in that replaces it: before a sign-in (requireToken false) the status is OK — no problem at all — and a FOURTH line says what is there ('… belongs to another app key … the next sign-in replaces it', with the two commands; worded 'this sign-in replaces it' for the sign-in commands themselves); where a token is required (the deploy steps; --status) it is still REFUSED, naming the two sign-in commands; a status without such a token keeps its three lines",
      before.ok && before.problems.length === 0 && before.lines.length === 4 && /^the token on the VPS belongs to another app key than its SCHWAB_MD_APP_KEY: no unit can use it, and the next sign-in replaces it \([^]*schwab-auth\.cjs --login[^]*schwab-auth\.cjs --share-from-home[^]*\)$/.test(before.lines[3]) && signing.ok && signing.problems.length === 0 && signing.lines.length === 4 && signing.lines[3] === "the token on the VPS belongs to another app key; this sign-in replaces it"
      && !need.ok && need.lines.length === 3 && need.problems.some((x) => /^the VPS's token was issued to another app key than its SCHWAB_MD_APP_KEY — sign in again: [^]*schwab-auth\.cjs --login[^]*schwab-auth\.cjs --share-from-home/.test(x)) && !rec.ok && rec.problems.some((x) => /issued to another app key/.test(x)) && J({}, { requireToken: false }).lines.length === 3 && J({}, { requireToken: false, signingIn: true }).lines.length === 3 && ![...before.lines, ...signing.lines, ...need.problems].some((l) => leaks(l).length), JSON.stringify([before, signing, need.problems, rec.problems])); }
  ok("parseStatus: the @@STATUS line in noisy output -> the object; garbage -> null", parseStatus("motd\n@@STATUS " + JSON.stringify(st()) + "\n").env.ok === true && parseStatus("@@STATUS {torn") === null && parseStatus("nothing") === null);
  ok("place / check scripts carry no value (stdin only) and set root:traids 0640 under /etc/traids", ![placeScript(), checkScript()].some((s) => /SCHWAB_MD_APP_KEY=|SECRET=/.test(s)) && /chown root:traids/.test(placeScript()) && /chmod 0640/.test(placeScript()) && /F=\/etc\/traids\/w2b-schwab\.env/.test(checkScript()));
  ok("the two status commands: the read-only one never probes; the probing one (what units-shadow, home and the cutover ask) is the same command plus --probe; the token-file check is a read-only stat of the units' token path", PROBE_CMD === STATUS_CMD + " --probe" && !/--probe/.test(STATUS_CMD) && /--status --json$/.test(STATUS_CMD) && TOKEN_STAT_CMD === "stat -c '%U %a' /home/traids/.traids/schwab-md-token.json 2>/dev/null || echo ABSENT");
  const src = require("fs").readFileSync(__filename, "utf8").split("function selftest")[0];
  ok("the void rule is gone from the code: nothing here refuses a VPS app, key, secret or token for being EQUAL to home's (no 'EQUALS home' refusal; home's fingerprints only feed two report lines)", !/EQUALS home|TRADING app/.test(src) && (src.match(/home\.(key|secret|refresh)\)/g) || []).length === 2);
  console.log(`md-guard selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}
module.exports = { keyPlanGuard, readHomeEnv, homeShas, mdProblems, envContent, placeScript, checkScript, judgeEnvCheck, parseStatus, judgeStatus, permissionLine, REQUIRED, OPTIONAL, HOME_NAMES, HOME_SOURCE, ENV_FILE, TOKEN_FILE, TOKEN_STAT_CMD, STATUS_CMD, PROBE_CMD, LIVE_MONEY, AUTH, sha };
if (require.main === module) {
  if (process.argv.slice(2).join(" ") === "--selftest") process.exitCode = selftest() ? 0 : 1;
  else { console.log("usage: node md-guard.cjs --selftest"); process.exitCode = 2; }
}
