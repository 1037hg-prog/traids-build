"use strict";
/**
 * SCHWAB MARKET DATA (VPS) — the token of the operator's ONE Schwab app, as the VPS may use it. Server migration W2b, 2026-10-09;
 * reworked 2026-10-11 on the operator's decision "yes use the existing app" (docs/server/wave2b-schwab). Installed as
 * backend/lib/schwab-md.js at home (inert there: nothing at home loads it while SCHWAB_MD_TOKEN_FILE is unset) and on the VPS. Loaded by a
 * recorder started with --schwab-md (traids-gex / traids-flow and their shadows) and, through W3's lib/schwab.js token(), by every other
 * VPS unit that reads Schwab. Home keeps lib/schwab.js and backend/.env, unchanged.
 *
 * ONE APP. Schwab allows one app per API product, so the VPS uses the operator's existing app — the one home uses. That app is
 * market-data-only by Schwab's own permissions (checked live 2026-10-11: quotes 200, the accounts side 401). The old rule "the VPS app
 * must differ from home's" is void and is not enforced anywhere. What IS enforced, here, before any market-data call:
 *
 * THE PERMISSION GATE. token() hands out an access token only while Schwab's ACCOUNTS side REFUSES it. The probe is one GET of
 * ACCOUNTS_PROBE_URL with the access token; ONLY the status code is taken — the body is never read, logged, stored or returned.
 *   401 or 403        refused  = market-data-only        -> allowed
 *   any 2xx           accepted = the app can see accounts -> every call refuses; the token file is left as it is; the unit exits
 *                                nonzero and pages through OnFailure=traids-alert@ (this library has no alert path of its own)
 *   anything else     unknown  (no answer, a timeout, 5xx, any other code) -> allowed only while a 'refused' verdict no older than
 *                                24 h is on record; with none, refused
 * The record: schwab-md-permission.json beside the token file, 0600, holding the time and the status code of the last DEFINITIVE answer
 * (refused or accepted) and nothing else. An unknown answer never replaces it. A probe is made at each token refresh, except that a
 * verdict younger than 15 minutes is reused (so several units refreshing within minutes send one probe), and the accounts side is
 * never asked twice within 15 minutes — by one process, or by several: the time of the last question, whatever its answer, is kept in
 * schwab-md-permission-asked.json beside the record (0600, a time and nothing else), so a unit that starts minutes after another unit's
 * unanswered question does not ask again; it decides on the record. (Only the sign-in helper's proof of a NEW token asks regardless.)
 * An 'accepted' record refuses every call at once, without a network call, and is re-probed after 15 minutes.
 * A CACHED access token is handed out only while the verdict still allows it (looked up without a network call: a refusal that has
 * passed its 24 hours, a record that is gone or an 'accepted' record ends the cache's use at once), and it is cached for 30 minutes at
 * most, whatever life the token endpoint states.
 *
 * WHAT IT READS, and nothing else:
 *   process.env.SCHWAB_MD_APP_KEY / SCHWAB_MD_APP_SECRET (/ SCHWAB_MD_CALLBACK)   the unit's EnvironmentFile /etc/traids/w2b-schwab.env
 *   the token file: process.env.SCHWAB_MD_TOKEN_FILE (the units set /home/traids/.traids/schwab-md-token.json), written ONLY by the VPS
 *     helper schwab-md-auth.cjs: after the VPS's own sign-in (mode "login") or from home's token (mode "shared"); 0600; never pulled.
 *     It records the sha256 of the app key it belongs to, so a token is never used with another app's key.
 *     THERE IS NO DEFAULT PATH (2026-10-11, review): with the variable unset or empty, tokenFile / permissionFile / askedFile throw and
 *     token() and the gate refuse (kind env) — nothing is ever read from, or written under, the user's home folder by a guess.
 * REFUSES (throws BEFORE any network call; a message names keys, lengths, times and status codes, never a value):
 *   - home's env names or a live-money name anywhere in the environment (SCHWAB_APP_KEY, SCHWAB_APP_SECRET, SCHWAB_REFRESH_TOKEN,
 *     SCHWAB_ACCESS_TOKEN, any TASTY_*): on the VPS the app goes in only under the SCHWAB_MD_* names and the refresh token only in the
 *     token file, never in an environment;
 *   - a missing or malformed key / secret / callback; SCHWAB_MD_TOKEN_FILE unset;
 *   - a token file that is missing, torn, of another schema, issued to ANOTHER app key, or past its 7-day refresh life.
 * It never reads backend/.env (dotenv is not loaded under --schwab-md) and calls nothing but the OAuth token endpoint and the accounts
 * probe; the callers make the market-data calls themselves. NO REDIRECT IS EVER FOLLOWED: the POST to the token endpoint carries the app
 * secret and the refresh token, so it names redirect "error" (a 3xx fails the grant; nothing is sent to the Location); the probe names
 * redirect "manual" (a 3xx is an answer with no verdict). Schwab's refresh token lives 7 days from the sign-in: the operator signs in
 * weekly (docs/server/wave2b-schwab/NOTES.md); traids-schwab-md-check pages 36 h before it dies.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const AUTHORIZE_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const ACCOUNTS_PROBE_URL = "https://api.schwabapi.com/trader/v1/accounts/accountNumbers";
const SCHEMA = "schwab-md-token-v1", REFRESH_LIFE_MS = 7 * 864e5;
const PERMISSION_NAME = "schwab-md-permission.json", PERM_FRESH_MS = 24 * 3600000, PERM_REPROBE_MS = 15 * 60000, PROBE_TIMEOUT_MS = 15000;
/** beside the record: the time the accounts side was last ASKED (a time only). ACCESS_CACHE_MAX_S: the longest an access token is cached */
const ASKED_NAME = "schwab-md-permission-asked.json", ACCESS_CACHE_MAX_S = 1800;
const FORBIDDEN_ENV = /^(SCHWAB_APP_KEY|SCHWAB_APP_SECRET|SCHWAB_REFRESH_TOKEN|SCHWAB_ACCESS_TOKEN|TASTY_[A-Z0-9_]*)$/;
const ENV_NAMES = ["SCHWAB_MD_APP_KEY", "SCHWAB_MD_APP_SECRET", "SCHWAB_MD_CALLBACK"];
const KEY_RE = /^[A-Za-z0-9]{16,64}$/, SECRET_RE = /^[A-Za-z0-9._~+/=-]{8,128}$/, CALLBACK_RE = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;
const SIGN_IN = "at home: node docs/server/wave2b-schwab/schwab-auth.cjs --login (the VPS's own sign-in) or --share-from-home (home's token)";
const sha = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
/** an error whose message names no value; kind: env | token | refresh | accounts-accepted | accounts-unknown */
const refusal = (kind, msg, extra = {}) => Object.assign(new Error("schwab-md: " + msg), { kind, ...extra });
/**
 * the token file's path: SCHWAB_MD_TOKEN_FILE and nothing else. There is NO default: unset or empty, it throws (kind env) — a guessed
 * path under the user's home folder was once written to by a selftest (review, 2026-10-11). Every unit sets the variable.
 */
function tokenFile(env = process.env) {
  const f = env && env.SCHWAB_MD_TOKEN_FILE;
  if (typeof f !== "string" || !f.trim()) throw refusal("env", "REFUSED — SCHWAB_MD_TOKEN_FILE is not set: this library has no default token path (every unit names its token file there; the VPS's is /home/traids/.traids/schwab-md-token.json)");
  return f;
}
/** the permission record: always beside the token file */
const permissionFile = (env = process.env) => path.join(path.dirname(tokenFile(env)), PERMISSION_NAME);
/** the time of the last question to the accounts side: beside the record */
const askedFile = (env = process.env) => path.join(path.dirname(tokenFile(env)), ASKED_NAME);

/** the app from an environment object -> { key, secret, callback }; throws (names / lengths only) */
function appFrom(env) {
  const bad = Object.keys(env || {}).filter((k) => FORBIDDEN_ENV.test(k));
  if (bad.length) throw refusal("env", `REFUSED — the environment holds ${bad.join(", ")} (home's env names / live-money names); on the VPS the app goes in only as SCHWAB_MD_APP_KEY / SCHWAB_MD_APP_SECRET and the refresh token only in the token file`);
  const key = env.SCHWAB_MD_APP_KEY, secret = env.SCHWAB_MD_APP_SECRET, callback = env.SCHWAB_MD_CALLBACK || "https://127.0.0.1";
  if (!key || !secret) throw refusal("env", "SCHWAB_MD_APP_KEY / SCHWAB_MD_APP_SECRET missing (the unit's EnvironmentFile /etc/traids/w2b-schwab.env)");
  if (!KEY_RE.test(key)) throw refusal("env", `SCHWAB_MD_APP_KEY (length ${String(key).length}) is malformed (16-64 letters / digits)`);
  if (!SECRET_RE.test(secret)) throw refusal("env", `SCHWAB_MD_APP_SECRET (length ${String(secret).length}) is malformed`);
  if (!CALLBACK_RE.test(callback)) throw refusal("env", `SCHWAB_MD_CALLBACK (length ${String(callback).length}) is not an https:// callback URL`);
  return { key, secret, callback };
}

/** NAME=value text (an env file) -> { values, names, badLines } — a line that is not NAME=value is reported by number only */
function parseEnvText(text) {
  const values = {}, names = [], badLines = [];
  String(text || "").replace(/^﻿/, "").split(/\r?\n/).forEach((ln, i) => {
    if (!ln.trim() || /^\s*#/.test(ln)) return;
    const m = /^\s*([A-Za-z0-9_]+)\s*=(.*)$/.exec(ln);
    if (!m || !/^[A-Z0-9_]+$/.test(m[1])) { badLines.push(i + 1); return; }
    let v = m[2].trim(); if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    names.push(m[1]); values[m[1]] = v;
  });
  return { values, names, badLines };
}

/** pure: the token file's text, the app key now in use and the time -> { ok, why, refresh?, issuedAt?, refreshExpiresAt?, hoursLeft?, mode? } */
function judgeToken(text, appKey, nowMs) {
  if (text == null) return { ok: false, present: false, why: "no token on this host yet (the operator's first sign-in or share has not run)" };
  let j; try { j = JSON.parse(text); } catch { return { ok: false, present: true, why: "the token file does not parse" }; }
  if (!j || j.schema !== SCHEMA) return { ok: false, present: true, why: `the token file is not a ${SCHEMA} record` };
  if (typeof j.refresh_token !== "string" || j.refresh_token.length < 20) return { ok: false, present: true, why: "the token file holds no refresh token" };
  if (!/^[0-9a-f]{64}$/.test(String(j.appKeySha256 || ""))) return { ok: false, present: true, why: "the token file does not record the app key it was issued to" };
  if (appKey == null || j.appKeySha256 !== sha(appKey)) return { ok: false, present: true, foreign: true, why: "the token was issued to ANOTHER app key than SCHWAB_MD_APP_KEY — refused; sign this app in again" };
  const iss = Date.parse(j.issuedAt), exp = Date.parse(j.refreshExpiresAt), mode = j.mode === "shared" ? "shared" : "login";
  if (!Number.isFinite(iss) || !Number.isFinite(exp) || exp - iss > REFRESH_LIFE_MS + 60000 || exp <= iss) return { ok: false, present: true, why: "the token file's issue / expiry times are not a 7-day refresh life" };
  const hoursLeft = +((exp - nowMs) / 3600000).toFixed(2);
  if (!(hoursLeft > 0)) return { ok: false, present: true, expired: true, mode, issuedAt: j.issuedAt, refreshExpiresAt: j.refreshExpiresAt, hoursLeft, why: `the refresh token expired at ${j.refreshExpiresAt} (7 days after ${j.issuedAt})` };
  return { ok: true, present: true, mode, refresh: j.refresh_token, issuedAt: j.issuedAt, refreshExpiresAt: j.refreshExpiresAt, hoursLeft };
}
function readToken(file, appKey, nowMs) { let t = null; try { t = fs.readFileSync(file, "utf8"); } catch { t = null; } return judgeToken(t, appKey, nowMs); }

/** the token record the helper stores (refresh token + the sign-in time + the app key's sha256 + where it came from: "login" | "shared") */
function tokenDoc(refresh, appKey, issuedMs, by = "schwab-md-auth.cjs --exchange", mode = "login") {
  return { schema: SCHEMA, appKeySha256: sha(appKey), refresh_token: refresh, issuedAt: new Date(issuedMs).toISOString(), refreshExpiresAt: new Date(issuedMs + REFRESH_LIFE_MS).toISOString(), by, mode: mode === "shared" ? "shared" : "login" };
}
/** write a private file: dir 0700, file 0600, atomic (temp file in the same dir, fsync, rename) */
function writePrivate(file, text) {
  const dir = path.dirname(file); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir, 0o700); } catch {}
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, file);
}
const writeToken = (file, doc) => writePrivate(file, JSON.stringify(doc, null, 1) + "\n");

// ── the permission gate ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** a status code -> "refused" (401 / 403: market-data-only) | "accepted" (any 2xx: the app can see accounts) | "unknown" (anything else) */
const verdictOf = (status) => (status === 401 || status === 403 ? "refused" : Number.isInteger(status) && status >= 200 && status <= 299 ? "accepted" : "unknown");
/** the record on disk -> { at, status, verdict, ageMs, fresh } or null (absent, torn, not a definitive answer, or dated in the future) */
function readVerdict(file, nowMs) {
  let j; try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  if (!j || typeof j !== "object" || !Number.isInteger(j.status)) return null;
  const at = Date.parse(j.at), verdict = verdictOf(j.status);
  if (!Number.isFinite(at) || verdict === "unknown") return null;
  const ageMs = nowMs - at; if (ageMs < -60000) return null;   // a record from the future vouches for nothing
  return { at: new Date(at).toISOString(), status: j.status, verdict, ageMs: Math.max(0, ageMs), fresh: verdict === "refused" && ageMs <= PERM_FRESH_MS };
}
/** the record: the time and the status code, nothing else; 0600 */
const writeVerdict = (file, status, nowMs) => writePrivate(file, JSON.stringify({ at: new Date(nowMs).toISOString(), status }) + "\n");
/** ONE GET of the accounts side with the access token -> its status code, or null (no answer). The body is never read. */
async function probeAccounts(access, { fetchFn = globalThis.fetch } = {}) {
  let r = null;
  try { r = await fetchFn(ACCOUNTS_PROBE_URL, { method: "GET", redirect: "manual", headers: { Authorization: "Bearer " + access, Accept: "application/json" }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }); } catch { return null; }
  const status = r && Number.isInteger(r.status) && r.status >= 100 && r.status <= 599 ? r.status : null;
  try { if (r && r.body && typeof r.body.cancel === "function") await r.body.cancel(); } catch {}   // dropped unread
  return status;
}
const hoursOf = (ms) => +(ms / 3600000).toFixed(1);
const answerText = (status) => (status == null ? "no answer" : "HTTP " + status);
/** pure: the newest definitive record (or null) and this call's probe -> { allowed, verdict, status, at, why } */
function decide(rec, probe = { tried: false, status: null }) {
  if (rec && rec.verdict === "accepted") return { allowed: false, verdict: "accepted", status: rec.status, at: rec.at,
    why: `REFUSED — Schwab's accounts side ACCEPTED this app's token (HTTP ${rec.status} at ${rec.at}). The VPS runs only an app that is refused there, so every Schwab call here refuses; the token file was left as it is. The operator decides what happens next (docs/server/wave2b-schwab/NOTES.md)` };
  if (rec && rec.fresh) return { allowed: true, verdict: "refused", status: rec.status, at: rec.at, why: null };
  const last = rec ? `the last 'refused' verdict is ${hoursOf(rec.ageMs)} h old (HTTP ${rec.status} at ${rec.at})` : "no 'refused' verdict is on record";
  return { allowed: false, verdict: "unknown", status: probe.status, at: null,
    why: `REFUSED — the accounts-permission check gave no verdict (${probe.tried ? answerText(probe.status) : "not asked again within 15 minutes"}) and ${last}; a verdict counts for 24 h. Fail-closed: no Schwab call is made. It is asked again on the next run` };
}
let _tok = { value: null, exp: 0, id: null }, _probeAt = null, _mem = null;
/**
 * the newest definitive verdict known here: the record on disk, or this process's own last answer when it COULD NOT BE RECORDED (_mem
 * is kept only then). An answer that was recorded lives on disk alone: once that record is gone, nothing in this process vouches for it.
 */
function verdictNow(file, nowMs) {
  const disk = readVerdict(file, nowMs), age = _mem && _mem.file === file ? nowMs - Date.parse(_mem.at) : NaN;
  const mem = age >= 0 ? { at: _mem.at, status: _mem.status, verdict: verdictOf(_mem.status), ageMs: age, fresh: verdictOf(_mem.status) === "refused" && age <= PERM_FRESH_MS } : null;
  return !disk ? mem : !mem ? disk : Date.parse(mem.at) > Date.parse(disk.at) ? mem : disk;
}
/** the time on disk of the last question to the accounts side -> ms, or null (absent, torn, not a time, or dated in the future: it caps nothing) */
function readAsked(file, nowMs) {
  let j; try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  const at = j && typeof j === "object" ? Date.parse(j.at) : NaN;
  return Number.isFinite(at) && nowMs - at >= -60000 ? at : null;
}
/** the time and nothing else; 0600 */
const writeAsked = (file, nowMs) => writePrivate(file, JSON.stringify({ at: new Date(nowMs).toISOString() }) + "\n");
/**
 * true while the accounts side was asked less than 15 minutes ago — by this process (it never probes twice in that time), or by ANY
 * process using this token file (the time on disk in askedFile): the cap holds across units also when no answer gave a verdict
 */
function probedLately(nowMs, asked = null) {
  if (_probeAt != null && nowMs >= _probeAt && nowMs - _probeAt < PERM_REPROBE_MS) return true;
  const at = asked ? readAsked(asked, nowMs) : null;
  return at != null && nowMs - at < PERM_REPROBE_MS;
}
/**
 * the gate for one access token -> { allowed, verdict, status, at, why, probed, probeStatus, recorded }. force: probe now, whatever the
 * record's age (the helper, for a token that has just arrived). Otherwise a record younger than 15 minutes is reused, and the accounts
 * side is asked at most once in 15 minutes: by this process, and — through the time kept in askedFile — by all processes together.
 */
async function permissionGate(access, { env = process.env, fetchFn = globalThis.fetch, now = Date.now, force = false } = {}) {
  const file = permissionFile(env), asked = askedFile(env);
  let rec = verdictNow(file, now()), tried = false, status = null, recorded = null;
  const due = force || !rec || rec.ageMs >= PERM_REPROBE_MS, capped = !force && probedLately(now(), asked);
  if (due && !capped) {
    tried = true; _probeAt = now();
    try { writeAsked(asked, _probeAt); } catch { /* the cap then holds in this process only */ }   // BEFORE the question: a unit starting while it is open does not ask too
    status = await probeAccounts(access, { fetchFn });
    const v = verdictOf(status);
    if (v !== "unknown") {
      const t = now(), at = new Date(t).toISOString();
      // a live definitive answer stands even when it cannot be recorded: then, and only then, this process keeps it in memory. Once it is
      // on disk the record is the one place it lives, so a record that is later deleted is not outlived by a copy held here
      try { writeVerdict(file, status, t); recorded = true; if (_mem && _mem.file === file) _mem = null; } catch { recorded = false; _mem = { file, at, status }; }
      rec = { at, status, verdict: v, ageMs: 0, fresh: v === "refused" };
    }
  }
  return { ...decide(rec, { tried, status }), probed: tried, probeStatus: tried ? status : undefined, recorded };
}
/**
 * one refresh grant -> { ok, status, access?, expiresIn? } (status null: no answer); the response is read only for the access token.
 * redirect "error": this POST carries the app secret (Basic auth) and the refresh token (the form body), and a fetch that follows a
 * 307 / 308 re-sends the body to the Location — so a redirect fails the grant (no answer) and nothing is sent anywhere else.
 */
async function refreshAccess(app, refresh, { fetchFn = globalThis.fetch } = {}) {
  let r = null;
  try {
    r = await fetchFn(TOKEN_URL, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: "Basic " + Buffer.from(`${app.key}:${app.secret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
      signal: AbortSignal.timeout(20000),
    });
  } catch { return { ok: false, status: null }; }
  if (!r || !r.ok) return { ok: false, status: r && Number.isInteger(r.status) ? r.status : null };
  let j = null; try { j = await r.json(); } catch { j = null; }
  if (!j || typeof j.access_token !== "string" || !j.access_token) return { ok: false, status: r.status, empty: true };
  return { ok: true, status: r.status, access: j.access_token, expiresIn: Number(j.expires_in) || 1800 };
}

/** an access token for /marketdata/v1 (cached per process), handed out only while the accounts side refuses it; throws (kind on the error) */
async function token({ env = process.env, fetchFn = globalThis.fetch, now = Date.now } = {}) {
  const app = appFrom(env), tf = tokenFile(env), id = sha(app.key) + "|" + tf;
  const rec0 = verdictNow(permissionFile(env), now());
  const cached = () => (_tok.value && _tok.id === id && now() < _tok.exp - 60000 ? _tok.value : null);
  // a cached token is handed out only while the verdict known now (no network call) still allows it: not once 'accepted' is on record,
  // not once the last refusal has passed its 24 hours, not once the record is gone — then the gate below decides, with a live question
  if (cached() && decide(rec0).allowed) return cached();
  // when no probe can be made now (the record is younger than 15 minutes, or the accounts side was asked within 15 minutes — by this
  // process or by another unit) and what is on record does not allow the call, it refuses at once: no network call at all
  if (!((!rec0 || rec0.ageMs >= PERM_REPROBE_MS) && !probedLately(now(), askedFile(env)))) {
    const d = decide(rec0);
    if (!d.allowed) { _tok = { value: null, exp: 0, id: null }; throw refusal(d.verdict === "accepted" ? "accounts-accepted" : "accounts-unknown", d.why, { status: d.status }); }
  }
  const t = readToken(tf, app.key, now());
  if (!t.ok) throw refusal("token", `${t.why} — ${SIGN_IN}`);
  let access = cached(), exp = _tok.exp;
  if (!access) {
    const r = await refreshAccess(app, t.refresh, { fetchFn });
    if (!r.ok && r.empty) throw refusal("refresh", "the token refresh answered without an access token", { status: r.status });
    if (!r.ok) throw refusal("refresh", `token refresh ${r.status == null ? "got no answer" : "HTTP " + r.status} — ${r.status === 400 || r.status === 401 ? "the refresh token was refused (its 7 days are over, or a newer sign-in for the same app replaced it)" : "Schwab did not answer the refresh"}; ${SIGN_IN}`, { status: r.status });
    access = r.access; exp = now() + Math.min(r.expiresIn, ACCESS_CACHE_MAX_S) * 1000;   // cached for 30 minutes at most, whatever the endpoint states
  }
  const g = await permissionGate(access, { env, fetchFn, now });
  if (!g.allowed) { _tok = { value: null, exp: 0, id: null }; throw refusal(g.verdict === "accepted" ? "accounts-accepted" : "accounts-unknown", g.why, { status: g.status }); }
  _tok = { value: access, exp, id };
  return access;
}
const _reset = () => { _tok = { value: null, exp: 0, id: null }; _probeAt = null; _mem = null; };

module.exports = { token, appFrom, parseEnvText, judgeToken, readToken, tokenDoc, writeToken, tokenFile, sha, SCHEMA, REFRESH_LIFE_MS, FORBIDDEN_ENV, ENV_NAMES, TOKEN_URL, AUTHORIZE_URL, KEY_RE, SECRET_RE, CALLBACK_RE, _reset,
  ACCOUNTS_PROBE_URL, PERMISSION_NAME, PERM_FRESH_MS, PERM_REPROBE_MS, permissionFile, verdictOf, readVerdict, writeVerdict, probeAccounts, decide, permissionGate, refreshAccess,
  ASKED_NAME, ACCESS_CACHE_MAX_S, askedFile, readAsked, writeAsked };
