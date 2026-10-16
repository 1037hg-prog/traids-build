#!/usr/bin/env node
/**
 * SCHWAB AUTH (home wrapper) — how the VPS gets and keeps its Schwab token. Server migration W2b, 2026-10-09; reworked 2026-10-11 on the
 * operator's decision "yes use the existing app" (docs/server/wave2b-schwab). Run BY JOSH at home; an agent never runs it.
 *
 * ONE APP: the VPS uses the operator's one Schwab app, the app home uses. There are two ways to give the VPS a token, and which one
 * lasts depends on something only Schwab knows: whether a second sign-in for the same app ends the first.
 *
 *   node docs/server/wave2b-schwab/schwab-auth.cjs --login            (a) the VPS's OWN sign-in: the browser paste-back; the token is
 *                                                                     made on the VPS. Then run --check-home once.
 *   node docs/server/wave2b-schwab/schwab-auth.cjs --check-home       ONE refresh of HOME'S own token through backend/lib/schwab.js:
 *                                                                     did home's sign-in survive the VPS's? It says which, and what
 *                                                                     to do in each case.
 *   node docs/server/wave2b-schwab/schwab-auth.cjs --share-from-home [--if-newer]
 *                                                                     (b) home's token SHARED: for the case where Schwab keeps one
 *                                                                     live sign-in per app. Home's SCHWAB_REFRESH_TOKEN goes to the VPS
 *                                                                     token file on ssh STDIN (never printed, never argv). Then there
 *                                                                     is ONE weekly sign-in, at home, followed by this command.
 *                                                                     --if-newer sends nothing when the VPS's token is already
 *                                                                     home's, or is not older than home's.
 *   node docs/server/wave2b-schwab/schwab-auth.cjs --status           read-only: which way the VPS's token came, its age and hours
 *                                                                     left, the last permission verdict
 *   node docs/server/wave2b-schwab/schwab-auth.cjs --selftest         a fake VPS and a fake home library; no ssh, no network
 *
 * THE PERMISSION GATE, the last step of both ways: on the VPS, Schwab's ACCOUNTS side must REFUSE the new token (401 or 403; the status
 * code only) before it is stored. If that side ACCEPTS it, it is not stored, the VPS's token file is deleted and this command fails
 * loudly. Nothing is printed here but names, lengths, times and status codes.
 * --login, in order: 1. the VPS helper and library are the copies this package sends (sha256); 2. the VPS's env file holds exactly the
 * SCHWAB_MD_* names; 3. the authorize URL is built ON the VPS and printed here; log into Schwab, approve, and the browser lands on an
 * https://127.0.0.1/?code=... error page (expected); 4. copy that FULL address and press Enter (the clipboard is read) — or paste it;
 * the CODE alone goes to the VPS on ssh STDIN; 5. the VPS exchanges it, checks the new token on the accounts side, stores it (0600);
 * 6. the status is read back. Codes expire in about 30 seconds: copy, then press Enter at once.
 * A --login that FAILS AFTER the VPS exchanged the code (step 5: the accounts side accepted the new token or gave no verdict, the new
 * token's first refresh failed, the stored token does not check out) ends by saying that Schwab DID issue a new sign-in for the app
 * and sends the operator to --check-home: if Schwab keeps one sign-in per app, home's own has ended whatever became of the new token.
 * THE CLIPBOARD supplies ONLY that address: it must be the app's own callback (https://127.0.0.1…, read from the authorize URL) and
 * carry ?code=. Anything else found there — a word, a password just pasted into Schwab's login page, another site's address — is never
 * taken and never leaves this PC. A bare code is accepted only when typed or pasted at the prompt.
 * A token already on the VPS that belongs to ANOTHER app key (the key in its env file was replaced) does not stop --login or
 * --share-from-home: the sign-in is what replaces it; one line says so.
 * Exit 0 ok · 1 refused / failed / home's sign-in did not survive · 2 bad arguments.
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), readline = require("readline"), crypto = require("crypto");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", "..");
const PS = require(path.join(REPO, "deploy", "server", "pull-server.cjs")), MG = require(path.join(HERE, "md-guard.cjs"));
const { extractCode, TOKEN_RE, ISO_RE, AFTER_EXCHANGE } = require(path.join(HERE, "vps", "schwab-md-auth.cjs"));
const RB = "/home/traids/traids/backend", HELPER = `/usr/local/bin/node ${RB}/schwab-md-auth.cjs`, SELF = "node docs/server/wave2b-schwab/schwab-auth.cjs";
const LIFE_MS = 7 * 864e5, HOME_BAT = "automation\\schwab-auth.bat";
/**
 * said by a --login that FAILS AFTER the VPS had exchanged the code (the helper's AFTER_EXCHANGE lines, or a stored token that does not
 * check out): Schwab has then issued a new sign-in for the app, whatever became of the token. If Schwab keeps one live sign-in per app,
 * home's own sign-in ended at that moment — so the failure itself sends the operator to --check-home, as a successful --login does.
 */
const NEW_SIGN_IN = `Schwab DID issue a new sign-in for the app in this attempt (the VPS had exchanged the code before this failed). If Schwab keeps one live sign-in per app, home's own sign-in has ended: run ${SELF} --check-home now; if home did not survive, run ${HOME_BAT}`;
const SENT = () => ({ "schwab-md-auth.cjs": PS.sha(fs.readFileSync(path.join(HERE, "vps", "schwab-md-auth.cjs"))), "lib/schwab-md.js": PS.sha(fs.readFileSync(path.join(HERE, "backend", "lib", "schwab-md.js"))) });
let SSH = PS.sshReal("traids"), log = (s) => console.log(s), NOW = () => Date.now();
let HOME_ENV_TEXT = () => fs.readFileSync(path.join(REPO, "backend", ".env"), "utf8");
/** home's NON-SECRET record of when its token was signed in (backend/schwab-auth.js writes it: a time and a 16-hex fingerprint) */
let HOME_META_TEXT = () => fs.readFileSync(path.join(REPO, "backend", "data", "schwab-auth-meta.json"), "utf8");
let HOME_LIB = path.join(REPO, "backend", "lib", "schwab.js");
/** ONE forced refresh of home's own token: the library is loaded fresh (no cached token), so its token() makes exactly one refresh grant */
let HOME_REFRESH = async () => {
  if (process.env.SCHWAB_MD_TOKEN_FILE) throw new Error("SCHWAB_MD_TOKEN_FILE is set in this shell — that is the VPS's token path, not home's; unset it and run again");
  delete require.cache[require.resolve(HOME_LIB)];
  const t = await require(HOME_LIB).token();
  return typeof t === "string" && t.length > 0;
};
let ASK = (q) => new Promise((res) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); res(a); }); });
let CLIPBOARD = () => { try { return cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"], { encoding: "utf8", timeout: 15000, windowsHide: true }).trim(); } catch { return ""; } };

/** home's app and token, in memory (backend/.env read here and dropped) */
function homeEnv() { let t = HOME_ENV_TEXT(); const h = MG.readHomeEnv(t); t = null; return h; }
/** when home's CURRENT token was signed in -> { ok, issuedAt, issuedMs, hoursLeft } or { ok: false, why } (the record must be for this very token) */
function homeIssue(h) {
  if (!h.home.refresh) return { ok: false, why: "SCHWAB_REFRESH_TOKEN is not in backend/.env" };
  let m; try { m = JSON.parse(HOME_META_TEXT()); } catch { return { ok: false, why: `home's sign-in time is not on record (backend/data/schwab-auth-meta.json is missing or does not parse) — run ${HOME_BAT} once: it records the time` }; }
  const iss = Date.parse(m && m.refreshTokenIssuedAt);
  if (!Number.isFinite(iss)) return { ok: false, why: `backend/data/schwab-auth-meta.json holds no sign-in time — run ${HOME_BAT} once: it records the time` };
  const fp = crypto.createHash("sha256").update("schwab-refresh:" + String(h.home.refresh)).digest("hex").slice(0, 16);
  if (m.refreshTokenFingerprint !== fp) return { ok: false, why: `the sign-in time on record is not for the token now in backend/.env (the fingerprints differ: the token was restored or edited by hand) — run ${HOME_BAT}: it records the time` };
  if (iss > NOW() + 5 * 60000) return { ok: false, why: "the sign-in time on record is in the future of this PC's clock" };
  return { ok: true, issuedMs: iss, issuedAt: new Date(iss).toISOString(), hoursLeft: +((iss + LIFE_MS - NOW()) / 3600000).toFixed(1) };
}
function helperIsOurs() {
  const cur = PS.remoteShas(SSH, RB, ["schwab-md-auth.cjs", "lib/schwab-md.js"]), want = SENT(), bad = Object.keys(want).filter((f) => cur.get(f) !== want[f]);
  if (bad.length) throw new Error(`the VPS's ${bad.join(", ")} ${bad.length > 1 ? "are" : "is"} not the copy this package sends (absent or edited) — run node docs/server/wave2b-schwab/deploy.cjs --step copy first — REFUSED`);
}
function vpsStatus() { const r = SSH(MG.STATUS_CMD); const st = MG.parseStatus(r.out); if (!st) throw new Error(`the VPS's Schwab status could not be read (ssh exit ${r.status}) — REFUSED`); return st; }
const keysHint = (problems) => (/env file is not usable/.test(problems.join()) ? " — node docs/server/wave2b-schwab/deploy.cjs --step keys" : "");
/** the stored token must be traids's own and 0600 (read-only check) */
function tokenFileIsPrivate() {
  const r = SSH(MG.TOKEN_STAT_CMD), got = String(r.out || "").trim().split("\n").pop();
  if (!r.ok || got !== "traids 600") throw new Error(`the token file on the VPS is not traids's own with mode 0600 (it reads ${JSON.stringify(got.replace(/[^\x20-\x7e]/g, "?").slice(0, 40))}) — fix it on the VPS before any unit uses it: chown traids:traids and chmod 600 ${MG.TOKEN_FILE}`);
  return "the token file is traids's own, mode 0600";
}
/** after a token was stored: the status read back must show it usable and REFUSED on the accounts side just now */
function storedRight(st, hs, { mode, minHours }) {
  const j = MG.judgeStatus(st, { requireToken: true, minHours, requirePermission: "record", home: hs }), p = [...j.problems], t = st.token || {}, perm = st.permission || {};
  if (t.ok && t.mode !== mode) p.push(`the VPS's token reads as mode ${t.mode}, not ${mode}`);
  if (!(perm.verdict === "refused" && perm.fresh)) p.push("the VPS records no fresh 'refused' verdict for the token it stored (a token is stored only after Schwab's accounts side refused it)");
  if (p.length) throw new Error("the token was stored but its status is not right: " + [...new Set(p)].join("; "));
  return j.lines;
}

/** the app's callback, from the authorize URL the VPS built (its redirect_uri) -> "https://127.0.0.1…", or "" */
function callbackOf(authorizeUrl) { try { return new URL(String(authorizeUrl)).searchParams.get("redirect_uri") || ""; } catch { return ""; } }
/**
 * what the CLIPBOARD may supply -> the authorization code, or null. ONLY the address the browser landed on is taken: the app's own
 * callback (https, the same host, port and path) carrying ?code=. A bare word is never taken from the clipboard — it can be anything
 * that was copied last, a password included — and neither is an address of any other site, with or without a code= parameter.
 */
function clipboardCode(text, callback) {
  const s = String(text || "").trim(); if (!s || /\s/.test(s)) return null;
  let u, cb; try { u = new URL(s); cb = new URL(String(callback || "")); } catch { return null; }
  const dir = (p) => p.replace(/\/+$/, "");
  if (cb.protocol !== "https:" || u.protocol !== "https:" || u.origin !== cb.origin || dir(u.pathname) !== dir(cb.pathname)) return null;
  return extractCode(s);
}
/** the wrapper's sentence after an ACCEPTED answer: what the VPS said became of its token file — deleted, or not */
const afterAccepted = (out) => (/COULD NOT be deleted/.test(out) ? `It was not stored, but the VPS's token file COULD NOT be deleted — remove it by hand on the VPS (rm ${MG.TOKEN_FILE}); until then every unit there still asks Schwab's accounts side first and refuses while that side accepts the app's token.` : "It was not stored and the VPS's token file is deleted: no unit on the VPS can read Schwab.");

async function login() {
  helperIsOurs();
  const hs = MG.homeShas(homeEnv().home), j0 = MG.judgeStatus(vpsStatus(), { requireToken: false, home: hs, signingIn: true });
  if (!j0.ok) throw new Error("REFUSED before any Schwab call: " + j0.problems.join("; ") + keysHint(j0.problems));
  for (const l of j0.lines) log("   " + l);
  const u = SSH(`${HELPER} --authorize-url`), url = String(u.out || "").trim().split("\n").pop();
  if (!u.ok || !/^https:\/\/api\.schwabapi\.com\/v1\/oauth\/authorize\?response_type=code&client_id=[A-Za-z0-9]+&redirect_uri=\S+$/.test(url)) throw new Error(`the VPS could not build the authorize URL (ssh exit ${u.status}) — REFUSED`);
  const callback = callbackOf(url);
  log("\n1. Open this URL, log into Schwab and approve (the same app as home's):\n");
  log("   " + url + "\n");
  log("2. You land on an https://127.0.0.1/... ERROR PAGE — expected.");
  log("3. Copy the FULL address from the address bar, then press Enter here at once (codes expire in about 30 s).\n");
  let input = String(await ASK("Copied the address? Press ENTER (or paste it here): ") || "").trim(), code = null;
  if (input) code = extractCode(input);   // typed or pasted at the prompt: the address, or the bare code
  else {
    input = CLIPBOARD(); log(`   (read the clipboard: ${input ? "an address of length " + input.length : "empty"})`);
    code = clipboardCode(input, callback);   // from the clipboard: only the app's own callback address carrying ?code=
    if (input && !code) { input = null; throw new Error(`the clipboard does not hold the address this sign-in lands on (it must start with ${callback.replace(/[^\x21-\x7e]/g, "?").slice(0, 80) || "the app's callback"} and carry ?code=) — nothing was sent and nothing of it was kept. Run --login again and copy the FULL address from the browser's address bar before pressing Enter, or paste it at the prompt`); }
  }
  input = null;
  if (!code) throw new Error("no ?code= in what was given (copy the FULL https://127.0.0.1/?code=... address, then press Enter) — nothing sent");
  const x = SSH(`${HELPER} --exchange`, { input: code + "\n", timeout: 150000 }); code = null;
  const out = String(x.out || "");
  for (const l of out.trim().split("\n").filter(Boolean)) log("   VPS: " + l);
  if (!x.ok) {
    const exchanged = AFTER_EXCHANGE.test(out);   // the helper failed AFTER the code was exchanged: Schwab has issued a new sign-in for the app
    throw new Error((/ACCOUNTS ACCEPTED/.test(out) ? `LOGIN FAILED — Schwab's accounts side ACCEPTED the new token. ${afterAccepted(out)} Do not run --login again until you have read NOTES.md, 'If the accounts side ever accepts the token'`
      : /NOT VERIFIED/.test(out) ? `LOGIN FAILED — Schwab's accounts side gave no verdict, so the new token was not stored (a token is stored only after that side refused it). Run ${SELF} --login again when Schwab answers`
        : exchanged ? `LOGIN FAILED after the VPS had exchanged the code (exit ${x.status}; its line is above): no usable token came of this sign-in. Run ${SELF} --login again`
          : `the exchange on the VPS failed (exit ${x.status}) — run --login again (a code is single-use)`) + (exchanged ? ". " + NEW_SIGN_IN : ""));
  }
  try {   // the token is stored: whatever is wrong from here on, Schwab has issued the new sign-in
    for (const l of storedRight(vpsStatus(), hs, { mode: "login", minHours: 160 })) log("   " + l);
    log("   " + tokenFileIsPrivate());
  } catch (e) { throw new Error(`${e.message}. ${NEW_SIGN_IN}`); }
  log("done: the VPS has its own sign-in. It lasts 7 days; traids-schwab-md-check pages 36 h before it ends.");
  log(`NEXT, once: ${SELF} --check-home   (one refresh of home's own token: did home's sign-in survive this second one for the same app?)`);
  return 0;
}

const scrub = (s) => String(s || "").replace(/[A-Za-z0-9._~+/=@-]{24,}/g, "[redacted]").replace(/[^\x20-\x7e]/g, "?").slice(0, 160);
async function checkHome() {
  if (process.env.SCHWAB_MD_TOKEN_FILE) { log("NOT CONCLUDED: SCHWAB_MD_TOKEN_FILE is set in this shell — that is the VPS's token path, not home's. Nothing was asked. Unset it and run this again."); return 1; }
  const iss = homeIssue(homeEnv());
  log(`home's own token: ${iss.ok ? `signed in ${iss.issuedAt}, ${iss.hoursLeft} h of its 7 days left` : "its sign-in time is not known (" + iss.why + ")"}`);
  log("asking Schwab once with home's own token (ONE refresh, through backend/lib/schwab.js) ...");
  let res; try { res = (await HOME_REFRESH()) ? { ok: true } : { ok: false, msg: "the library returned no token" }; } catch (e) { res = { ok: false, msg: String((e && e.message) || e) }; }
  if (res.ok) {
    log("HOME'S SIGN-IN SURVIVED: Schwab still takes home's token after the VPS's own sign-in. Two sign-ins for the one app live side by side.");
    log(`  Keep both weekly: ${HOME_BAT} for home, ${SELF} --login for the VPS. Nothing else to do.`);
    return 0;
  }
  const m = /schwab token refresh (\d{3})/.exec(res.msg), http = m ? Number(m[1]) : null;
  if (/schwab not configured/.test(res.msg)) { log(`NOT CONCLUDED: home has no Schwab token in backend/.env to ask with — sign in at home first (${HOME_BAT}), then run this again.`); return 1; }
  if (http === 400 || http === 401) {
    if (iss.ok && !(iss.hoursLeft > 0)) { log(`NOT CONCLUDED: Schwab refused home's token (HTTP ${http}), but that token had reached its own 7 days (signed in ${iss.issuedAt}) — this says nothing about the VPS's sign-in.`); log(`  Sign in at home (${HOME_BAT}), then on the VPS (${SELF} --login), then run this again.`); return 1; }
    log(`HOME'S SIGN-IN DID NOT SURVIVE: Schwab refused home's token (HTTP ${http})${iss.ok ? ` with ${iss.hoursLeft} h of its 7 days left` : ""}. Schwab keeps ONE live sign-in for the app: the VPS's sign-in ended home's.`);
    if (!iss.ok) log("  (Home's sign-in time is not on record, so the token's own 7 days cannot be ruled out as the cause. The steps below are right either way.)");
    log("  From now on there is ONE weekly sign-in, at home, and the VPS takes home's token:");
    log(`    1. ${HOME_BAT}                                   (home signs in again; this ends the VPS's own token)`);
    log(`    2. ${SELF} --share-from-home    (home's token to the VPS, checked on Schwab's accounts side)`);
    log(`  Every week after: step 1, then ${SELF} --share-from-home --if-newer. Do not use --login again.`);
    return 1;
  }
  log(`NOT CONCLUDED: Schwab gave no usable answer to home's refresh (${http ? "HTTP " + http : scrub(res.msg)}). Nothing is known yet about the two sign-ins — run this again in a few minutes.`);
  return 1;
}

async function share({ ifNewer = false } = {}) {
  helperIsOurs();
  const h = homeEnv(), tk = h.home.refresh;
  if (!tk) throw new Error(`home has no SCHWAB_REFRESH_TOKEN in backend/.env — sign in at home first (${HOME_BAT}) — nothing sent`);
  if (!TOKEN_RE.test(tk)) throw new Error(`home's SCHWAB_REFRESH_TOKEN (length ${tk.length}) is not a token this step can send (one line, 40 or more characters, no spaces) — sign in at home first (${HOME_BAT}) — nothing sent`);
  const iss = homeIssue(h);
  if (!iss.ok) throw new Error(`nothing sent: ${iss.why}`);
  if (!ISO_RE.test(iss.issuedAt)) throw new Error("nothing sent: home's sign-in time does not read as an ISO time");
  if (!(iss.hoursLeft > 1)) throw new Error(`nothing sent: home's own token ${iss.hoursLeft > 0 ? `has ${iss.hoursLeft} h of its 7 days left` : "is past its 7 days"} (signed in ${iss.issuedAt}) — sign in at home first (${HOME_BAT}), then run this again`);
  const hs = MG.homeShas(h.home), st0 = vpsStatus(), j0 = MG.judgeStatus(st0, { requireToken: false, home: hs, signingIn: true });
  if (!j0.ok) throw new Error("REFUSED, nothing sent: " + j0.problems.join("; ") + keysHint(j0.problems));
  if (!hs.key || st0.env.keySha256 !== hs.key) throw new Error("REFUSED, nothing sent: the VPS's SCHWAB_MD_APP_KEY is not home's SCHWAB_APP_KEY. Home's token belongs to home's app and cannot be used with another key. Run node docs/server/wave2b-schwab/deploy.cjs --step keys again (with no SCHWAB_MD_* pair in backend/.env it takes home's app), or give the VPS its own sign-in: --login");
  for (const l of j0.lines) log("   " + l);
  const t0 = st0.token || {};
  if (ifNewer && t0.ok) {
    if (t0.refreshSha256 === hs.refresh) { log(`nothing to do: the VPS already holds home's current token (signed in ${t0.issuedAt}, ${t0.hoursLeft} h left) — nothing sent`); return 0; }
    if (Date.parse(t0.issuedAt) >= iss.issuedMs) { log(`nothing to do: the VPS's token (${t0.mode === "shared" ? "shared" : "its own sign-in"}, signed in ${t0.issuedAt}) is not older than home's (signed in ${iss.issuedAt}) — nothing sent`); return 0; }
  }
  log(`   sending home's token (length ${tk.length}, signed in ${iss.issuedAt}, ${iss.hoursLeft} h left) to the VPS on ssh stdin ...`);
  const x = SSH(`${HELPER} --install-token --issued-at ${iss.issuedAt}`, { input: tk + "\n", timeout: 150000 }), out = String(x.out || "");
  for (const l of out.trim().split("\n").filter(Boolean)) log("   VPS: " + l);
  if (!x.ok) throw new Error(/ACCOUNTS ACCEPTED/.test(out) ? `SHARE FAILED — Schwab's accounts side ACCEPTED home's token on the VPS. ${afterAccepted(out)} Read NOTES.md, 'If the accounts side ever accepts the token', before anything else`
    : /NOT VERIFIED/.test(out) ? `SHARE FAILED — Schwab's accounts side gave no verdict, so the token was not stored. Run ${SELF} --share-from-home again when Schwab answers`
      : `the share failed on the VPS (exit ${x.status}) — its lines are above; nothing was stored`);
  const st1 = vpsStatus();
  for (const l of storedRight(st1, hs, { mode: "shared", minHours: 0 })) log("   " + l);
  if (st1.token.refreshSha256 !== hs.refresh) throw new Error("the VPS stored a token, but it is not home's current token (the fingerprints differ) — run this again");
  log("   " + tokenFileIsPrivate());
  log(`done: the VPS runs on home's token. ONE weekly sign-in from now on: ${HOME_BAT}, then ${SELF} --share-from-home --if-newer.`);
  return 0;
}

function status() {
  helperIsOurs();
  const j = MG.judgeStatus(vpsStatus(), { requireToken: true, minHours: 0, requirePermission: "record", home: MG.homeShas(homeEnv().home) });
  for (const l of j.lines) log(l);
  for (const p of j.problems) log("NOT OK: " + p);
  return j.ok ? 0 : 1;
}
/** argv -> { mode, ifNewer } or null (bad arguments) */
function parseArgs(argv) {
  const a = argv.join(" ");
  if (a === "--share-from-home --if-newer") return { mode: "share", ifNewer: true };
  const m = { "--selftest": "selftest", "--login": "login", "--status": "status", "--check-home": "check-home", "--share-from-home": "share" }[a];
  return m ? { mode: m, ifNewer: false } : null;
}

async function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + String(d).slice(0, 500) : "")); } };
  const sha = (s) => PS.sha(Buffer.from(s)), os = require("os");
  const K = "MDKEYmdkeyMDKEYmdkeyMDKEYmdkey12", S = "mdSecretXYZ12345", HK = "HOMEKEYhomekeyHOMEKEYhomekeyHO99", HS = "homeSecret98765", CODE = "C0.b2F1dGgyLmJkYy5zY2h3YWIuY29t.code-xyz@";
  const HR = "home-refresh-token-" + "h".repeat(60) + "@", fpOf = (t) => crypto.createHash("sha256").update("schwab-refresh:" + t).digest("hex").slice(0, 16);
  const T0 = Date.parse("2026-10-14T02:00:00Z"), H = 3600000, HOME_ISS = "2026-10-13T16:28:30.122Z";
  const ENV = [`SCHWAB_APP_KEY=${HK}`, `SCHWAB_APP_SECRET=${HS}`, `SCHWAB_REFRESH_TOKEN=${HR}`, "ALPACA_KEY_ID=PKxxxxxxxxxxxxxxxxxx"].join("\n");
  const META = (o = {}) => JSON.stringify({ refreshTokenIssuedAt: HOME_ISS, refreshTokenExpiresAt: "2026-10-20T16:28:30.122Z", refreshTokenFingerprint: fpOf(HR), recordedBy: "backend/schwab-auth.js", ...o });
  /** the address the browser lands on, as the operator copies it: the code is in it URL-ENCODED (its @ is %40) */
  const ADDR = (session) => `https://127.0.0.1/?code=${encodeURIComponent(CODE)}&session=${session}`;
  const SECRETS = [K, S, HK, HS, HR, CODE, encodeURIComponent(CODE), ADDR("s1"), ADDR("s2"), sha(HR), sha(HK)];
  const save = { SSH, log, HOME_ENV_TEXT, HOME_META_TEXT, HOME_REFRESH, HOME_LIB, ASK, CLIPBOARD, NOW };
  /** what a --login that fails AFTER the code was exchanged must end with — written out here, not taken from the code under test */
  const HINT = "Schwab DID issue a new sign-in for the app in this attempt (the VPS had exchanged the code before this failed). If Schwab keeps one live sign-in per app, home's own sign-in has ended: run node docs/server/wave2b-schwab/schwab-auth.cjs --check-home now; if home did not survive, run automation\\schwab-auth.bat";
  const NONE = { verdict: "none", status: null, at: null, ageHours: null, fresh: false }, REF = { verdict: "refused", status: 401, at: "2026-10-14T02:00:00.000Z", ageHours: 0, fresh: true }, ACC = { verdict: "accepted", status: 200, at: "2026-10-14T02:00:00.000Z", ageHours: 0, fresh: false };
  const st = (o = {}) => ({ schema: "schwab-md-status-v2", tokenFile: MG.TOKEN_FILE, env: { ok: true, names: MG.REQUIRED, keyLen: 32, secretLen: 15, keySha256: sha(HK), secretSha256: sha(HS), ...(o.env || {}) }, token: { present: false, ok: false, why: "no token on this host yet", mode: null, issuedAt: null, ageHours: null, hoursLeft: null, refreshSha256: null, foreignApp: false, ...(o.token || {}) }, permission: o.permission || NONE });
  const tokenOf = (o = {}) => ({ present: true, ok: true, why: null, mode: "login", issuedAt: "2026-10-14T02:00:00.000Z", ageHours: 0, refreshExpiresAt: "2026-10-21T02:00:00.000Z", hoursLeft: 167.9, refreshSha256: sha("vps-own-refresh"), ...o });
  const URL_ = `https://api.schwabapi.com/v1/oauth/authorize?response_type=code&client_id=${HK}&redirect_uri=https%3A%2F%2F127.0.0.1`;
  /** the FAKE VPS: the helper's modes over a fake ssh; its state is the status the helper would report */
  const vps = (o = {}) => {
    const calls = []; let cur = o.status || st();
    const fn = (script, opt = {}) => {
      calls.push({ script, input: opt.input == null ? null : String(opt.input) });
      if (/sha256sum -- "\$f"/.test(script)) { const w = SENT(); return { ok: true, status: 0, out: Object.keys(w).map((f) => `${o.badHelper && f === "schwab-md-auth.cjs" ? "0".repeat(64) : w[f]}  ${f}`).join("\n") + "\n", err: "" }; }
      if (script === MG.STATUS_CMD) return { ok: true, status: 0, out: "@@STATUS " + JSON.stringify(cur) + "\n", err: "" };
      if (script === MG.TOKEN_STAT_CMD) return { ok: true, status: 0, out: (cur.token.present ? o.stat || "traids 600" : "ABSENT") + "\n", err: "" };
      if (/--authorize-url$/.test(script)) return { ok: true, status: 0, out: (o.url || URL_) + "\n", err: "" };
      const inst = /--install-token --issued-at (\S+)$/.exec(script), exch = /--exchange$/.test(script);
      if (exch || inst) {
        const what = exch ? "SIGN-IN" : "SHARE";
        if (o.fails) return { ok: false, status: 1, out: exch ? "FAILED: token exchange HTTP 400 (invalid_grant) — nothing stored\n" : "SHARE FAILED: Schwab answered HTTP 400 to the first refresh with this token. Nothing stored; no token is here.\n", err: "" };
        if (o.accepted && o.stuck) { cur = st({ env: cur.env, token: cur.token, permission: ACC }); return { ok: false, status: 1, out: `${what} FAILED — ACCOUNTS ACCEPTED: Schwab's accounts side ANSWERED this app's new token (HTTP 200). The server takes only an app that is refused there (market data only).\nThe new token was NOT stored, but the token file that was here COULD NOT be deleted — remove it by hand: rm ${MG.TOKEN_FILE}. Until then the gate is what stops its use: every unit asks Schwab's accounts side first and refuses while that side accepts this app's token. Nothing was sent anywhere else.\n`, err: "" }; }
        if (o.accepted) { cur = st({ env: cur.env, permission: ACC }); return { ok: false, status: 1, out: `${what} FAILED — ACCOUNTS ACCEPTED: Schwab's accounts side ANSWERED this app's new token (HTTP 200). The server takes only an app that is refused there (market data only).\nThe new token was NOT stored and the token file is deleted (the one that was here is gone): no Schwab call can be made from this host.\n`, err: "" }; }
        if (o.unverified) return { ok: false, status: 1, out: `${what} FAILED — NOT VERIFIED: Schwab's accounts side gave no verdict in 3 tries (HTTP 503). A token is stored only after that side has refused it.\n`, err: "" };
        if (exch && o.noReadBack) return { ok: false, status: 1, out: "FAILED: the token file was written but does not read back (the token file does not parse)\n", err: "" };
        if (exch && o.firstRefresh) return { ok: false, status: 1, out: "FAILED: the new token's first refresh got no answer — nothing stored. Run the sign-in again\n", err: "" };
        const tk = exch ? tokenOf({ mode: o.wrongMode || "login" }) : tokenOf({ mode: "shared", issuedAt: inst[1], ageHours: 9.5, refreshExpiresAt: "2026-10-20T16:28:30.122Z", hoursLeft: 158.5, refreshSha256: o.storesOther ? sha("something-else") : sha(String(opt.input).trim()) });
        cur = st({ env: cur.env, token: tk, permission: o.noVerdict ? NONE : REF });
        return { ok: true, status: 0, out: `stored: ${exch ? "the refresh token of the VPS's own sign-in" : "home's refresh token, shared"} (length 99) in ${MG.TOKEN_FILE} (0600); refresh life ends ${tk.refreshExpiresAt} (7 days after ${tk.issuedAt}).\npermission: Schwab's accounts side REFUSED this token (HTTP 401) — market data only, as the server requires.\n`, err: "" };
      }
      return { ok: false, status: 127, out: "", err: "fake VPS: unexpected " + script.slice(0, 50) };
    };
    return { fn, calls, status: () => cur };
  };
  const kind = (c) => (/sha256sum/.test(c.script) ? "sha" : c.script === MG.STATUS_CMD ? "status" : c.script === MG.TOKEN_STAT_CMD ? "stat" : /--authorize-url/.test(c.script) ? "url" : /--exchange/.test(c.script) ? "exchange" : /--install-token/.test(c.script) ? "install" : "?");
  const seq = (V) => V.calls.map(kind).join();
  const lines = [], err = async (p) => { try { await p(); return null; } catch (e) { return e.message; } };
  const leaks = (V) => [...lines.filter((l) => SECRETS.some((x) => l.includes(x) && !(x === HK && l.includes("client_id=")))), ...V.calls.filter((c) => SECRETS.some((x) => c.script.includes(x))).map((c) => c.script)];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w2b-schwab-auth-")), saveMdEnv = process.env.SCHWAB_MD_TOKEN_FILE;
  delete process.env.SCHWAB_MD_TOKEN_FILE;   // --check-home asks nothing while it is set; one case below sets it on purpose
  try {
    log = (s) => lines.push(String(s)); HOME_ENV_TEXT = () => ENV; HOME_META_TEXT = () => META(); NOW = () => T0; HOME_REFRESH = async () => { throw new Error("the selftest never asks Schwab"); };
    CLIPBOARD = () => `https://127.0.0.1/?code=${encodeURIComponent(CODE)}&session=s1`;
    // ── --login
    let V = vps(); SSH = V.fn; ASK = async () => "";
    const e0 = await err(login), ex = V.calls.find((c) => /--exchange$/.test(c.script));
    ok("--login: helper sha checked, the env judged, the URL printed, the clipboard read, the CODE ALONE sent on stdin of --exchange, the status read back (its own sign-in, 167.9 h, the accounts side refused it just now), the token file checked traids 0600", e0 === null && seq(V) === "sha,status,url,exchange,status,stat" && ex && ex.input === CODE + "\n" && lines.some((l) => l.includes(URL_)) && lines.some((l) => /the VPS's own sign-in[^]*167\.9 h left/.test(l)) && lines.some((l) => /refused the token \(HTTP 401/.test(l)) && lines.some((l) => /traids's own, mode 0600/.test(l)), e0 || lines.join(" | "));
    ok("--login ends by telling the operator to run --check-home once (did home's sign-in survive the second one?)", /^NEXT, once: node docs\/server\/wave2b-schwab\/schwab-auth\.cjs --check-home /.test(lines[lines.length - 1]));
    ok("the code is in NO log line and NO ssh command line (stdin only); no home value anywhere", leaks(V).length === 0 && V.calls.filter((c) => c.input && c.input.includes(CODE)).length === 1, leaks(V).join(" | "));
    ok("--login reading the CLIPBOARD says only how LONG the address is: its one line about the clipboard is known to the character, and neither the address nor the code AS THE BROWSER SHOWS IT (URL-encoded: %40 for @) is in any log line or ssh command line — the encoded code is one of the secrets this selftest looks for", encodeURIComponent(CODE) !== CODE && /%40$/.test(encodeURIComponent(CODE)) && SECRETS.includes(encodeURIComponent(CODE)) && SECRETS.includes(ADDR("s1")) && lines.filter((l) => /clipboard/.test(l)).join(" | ") === `   (read the clipboard: an address of length ${ADDR("s1").length})`
      && lines.every((l) => !l.includes(encodeURIComponent(CODE)) && !l.includes(ADDR("s1")) && !/[?&]code=/.test(l) && !l.includes("%40")) && V.calls.every((c) => !c.script.includes(encodeURIComponent(CODE)) && !/[?&]code=/.test(c.script)) && V.calls.filter((c) => c.input != null).length === 1 && ex.input === CODE + "\n", lines.filter((l) => /clipboard|code=/.test(l)).join(" | "));
    ASK = async () => `https://127.0.0.1/?code=${encodeURIComponent(CODE)}&session=s2`; CLIPBOARD = () => { throw new Error("must not be read"); }; V = vps(); SSH = V.fn; lines.length = 0;
    ok("--login with the address pasted: the clipboard is not read; the decoded code is sent", (await err(login)) === null && V.calls.find((c) => /--exchange$/.test(c.script)).input === CODE + "\n");
    ASK = async () => CODE; CLIPBOARD = () => "";
    V = vps({ status: st({ env: { keySha256: sha(HK), secretSha256: sha(HS) } }) }); SSH = V.fn; lines.length = 0;
    const e1 = await err(login);
    ok("ONE APP — --login when the VPS env holds HOME'S app key and secret (the same app, the expected case): NO refusal — the URL is built, the code exchanged, the token stored; the status line says it is the same app as home's", e1 === null && seq(V) === "sha,status,url,exchange,status,stat" && lines.some((l) => /the same app as home's SCHWAB_APP_KEY/.test(l)), e1);
    V = vps({ status: st({ env: { ok: false, names: ["SCHWAB_MD_APP_KEY", "SCHWAB_APP_KEY"], why: "/etc/traids/w2b-schwab.env holds SCHWAB_APP_KEY — home's env names never go into this file: REFUSED" } }) }); SSH = V.fn;
    ok("--login when the VPS env file holds one of home's NAMES -> REFUSED before any Schwab call, pointing at the keys step of deploy.cjs", /REFUSED before any Schwab call[^]*env file is not usable[^]*--step keys/.test((await err(login)) || "") && !V.calls.some((c) => /--authorize-url|--exchange/.test(c.script)));
    V = vps({ badHelper: true }); SSH = V.fn;
    ok("--login when the VPS helper is not the copy this package sends -> REFUSED (deploy --step copy), nothing else asked", /not the copy this package sends[^]*--step copy/.test((await err(login)) || "") && V.calls.length === 1);
    V = vps(); SSH = V.fn; ASK = async () => "nothing useful";
    ok("--login with no code in what was given -> REFUSED, nothing sent to --exchange", /no \?code= in what was given[^]*— nothing sent/.test((await err(login)) || "") && !V.calls.some((c) => /--exchange/.test(c.script)));
    ASK = async () => CODE;
    V = vps({ fails: true }); SSH = V.fn; lines.length = 0;
    ok("--login whose exchange the VPS refuses (400) -> exit 1, the VPS's line shown, no status claimed", /exchange on the VPS failed/.test((await err(login)) || "") && lines.some((l) => /VPS: FAILED: token exchange HTTP 400/.test(l)) && !lines.some((l) => /h left/.test(l) && /signed in/.test(l)));
    V = vps({ status: st({ token: tokenOf({ issuedAt: "2026-10-08T02:00:00.000Z", hoursLeft: 24, refreshSha256: sha("last-weeks-token") }), permission: REF }), accepted: true }); SSH = V.fn; lines.length = 0;
    const eA = await err(login);
    ok("THE PERMISSION GATE — --login whose new token Schwab's accounts side ACCEPTS: the VPS did not store it and DELETED its token file (the status after: no token, verdict accepted); --login FAILS LOUDLY ('LOGIN FAILED') and claims nothing done — no printed line says 'done' or names --check-home (the success line 'NEXT, once' is not printed); the FAILURE itself ends by sending the operator to --check-home, because Schwab did issue a new sign-in before the refusal (review, 2026-10-11)", /^LOGIN FAILED — Schwab's accounts side ACCEPTED the new token[^]*token file is deleted/.test(eA || "") && V.status().token.present === false && V.status().permission.verdict === "accepted" && seq(V) === "sha,status,url,exchange" && lines.some((l) => /VPS: SIGN-IN FAILED — ACCOUNTS ACCEPTED/.test(l)) && !lines.some((l) => /^done|--check-home/.test(l)) && (eA || "").endsWith(". " + HINT), eA);
    V = vps({ unverified: true }); SSH = V.fn; lines.length = 0;
    const eU = await err(login);
    ok("--login when the accounts side gives NO verdict (the VPS tried three times) -> FAILS: the token was not stored; run --login again", /^LOGIN FAILED — Schwab's accounts side gave no verdict, so the new token was not stored[^]*--login again/.test(eU || "") && V.status().token.present === false && !lines.some((l) => /^done/.test(l)), eU);
    for (const [label, o, re] of [["stores a token but records NO verdict for it", { noVerdict: true }, /records no fresh 'refused' verdict/], ["stores it as another mode", { wrongMode: "shared" }, /reads as mode shared, not login/], ["leaves the token file root-owned 0644", { stat: "root 644" }, /not traids's own with mode 0600 \(it reads "root 644"\)/]]) {
      V = vps(o); SSH = V.fn; lines.length = 0; const e = await err(login);
      ok(`--login is not believed on the VPS's word alone: a VPS that ${label} -> FAILS, nothing claimed done`, re.test(e || "") && !lines.some((l) => /^done/.test(l)), e); }
    // ── known answers added 2026-10-11 (review, fix cycle 1, second batch): what the clipboard may supply, a token of another app key
    //    on the VPS, and a token file the VPS could not delete
    { const junk = ["Correct-Horse.Battery42", "hunter2hunter2", "sk_test_ABCDEFGH12345678", CODE, "https://example.com/reset?code=ABCDEFGHIJ123456", "https://127.0.0.1.example.com/?code=ABCDEFGHIJ123456", "http://127.0.0.1/?code=ABCDEFGHIJ123456", "https://127.0.0.1:8182/?code=ABCDEFGHIJ123456", "https://127.0.0.1/cb?code=ABCDEFGHIJ123456", "https://127.0.0.1/?session=only"], res = [];
      for (const j of junk) { V = vps(); SSH = V.fn; ASK = async () => ""; CLIPBOARD = () => j; lines.length = 0; const e = await err(login); res.push({ e, seq: seq(V), sent: V.calls.filter((c) => c.input != null).length, shown: lines.some((l) => l.includes(j)) || String(e).includes(j), clip: lines.filter((l) => /clipboard/.test(l)).join("|") }); }
      ok("--login, Enter pressed with SOMETHING ELSE IN THE CLIPBOARD — a password-like word ('Correct-Horse.Battery42', 'hunter2hunter2'), a key-like word, a bare authorization code, another site's address with a code= parameter, a look-alike host, http instead of https, another port, another path, the callback with no code: NOTHING IS SENT (no --exchange call, nothing on any ssh stdin), the sign-in fails 'the clipboard does not hold the address … nothing was sent', and what was in the clipboard is in no log line and not in the error — only its length is shown",
        res.length === 10 && res.every((r, i) => /^the clipboard does not hold the address this sign-in lands on \(it must start with https:\/\/127\.0\.0\.1 and carry \?code=\) — nothing was sent/.test(r.e || "") && r.seq === "sha,status,url" && r.sent === 0 && !r.shown && r.clip === `   (read the clipboard: an address of length ${junk[i].length})`), JSON.stringify(res.map((r) => [String(r.e).slice(0, 70), r.seq, r.sent, r.shown])));
      V = vps(); SSH = V.fn; ASK = async () => ""; CLIPBOARD = () => ""; lines.length = 0; const eE = await err(login);
      ok("--login, Enter pressed with an EMPTY clipboard -> 'no ?code= in what was given … nothing sent'; no --exchange call", /^no \?code= in what was given[^]*— nothing sent$/.test(eE || "") && seq(V) === "sha,status,url" && lines.includes("   (read the clipboard: empty)") && V.calls.every((c) => c.input == null), eE);
      V = vps(); SSH = V.fn; ASK = async () => CODE; CLIPBOARD = () => { throw new Error("must not be read"); }; lines.length = 0; const eT = await err(login);
      ok("a BARE CODE is accepted only when typed or pasted AT THE PROMPT: typed there it is sent on stdin of --exchange and the clipboard is not read; the same bare code found IN THE CLIPBOARD is refused with nothing sent (the case above)", eT === null && seq(V) === "sha,status,url,exchange,status,stat" && V.calls.find((c) => /--exchange$/.test(c.script)).input === CODE + "\n" && junk[3] === CODE && res[3].sent === 0 && /^the clipboard does not hold/.test(res[3].e || ""), eT);
      const URL_CB = `https://api.schwabapi.com/v1/oauth/authorize?response_type=code&client_id=${HK}&redirect_uri=${encodeURIComponent("https://127.0.0.1:8182/cb")}`, CB_ADDR = `https://127.0.0.1:8182/cb?code=${encodeURIComponent(CODE)}&session=s3`;
      V = vps({ url: URL_CB }); SSH = V.fn; ASK = async () => ""; CLIPBOARD = () => CB_ADDR; lines.length = 0; const eC = await err(login), exC = V.calls.find((c) => /--exchange$/.test(c.script)), leakC = lines.filter((l) => l.includes(CB_ADDR) || l.includes(encodeURIComponent(CODE)) || l.includes(CODE));
      const V2 = vps({ url: URL_CB }); SSH = V2.fn; CLIPBOARD = () => ADDR("s1"); lines.length = 0; const eD = await err(login);
      ok("THE CLIPBOARD ADDRESS MUST BE THE APP'S OWN CALLBACK, read from the authorize URL the VPS built: with the callback https://127.0.0.1:8182/cb, the address https://127.0.0.1:8182/cb?code=… in the clipboard is taken (its code alone goes on stdin of --exchange; neither appears in a log line), and https://127.0.0.1/?code=… — the default callback, not this app's — is refused with nothing sent",
        eC === null && !!exC && exC.input === CODE + "\n" && leakC.length === 0 && /^the clipboard does not hold the address this sign-in lands on \(it must start with https:\/\/127\.0\.0\.1:8182\/cb and carry \?code=\)/.test(eD || "") && V2.calls.every((c) => c.input == null) && seq(V2) === "sha,status,url" && callbackOf(URL_CB) === "https://127.0.0.1:8182/cb" && callbackOf(URL_) === "https://127.0.0.1" && callbackOf("not a url") === "", JSON.stringify([eC, eD, seq(V2)]));
      const A16 = "ABCDEFGHIJ123456";
      ok("clipboardCode (pure): the callback address carrying ?code= -> the decoded code, a trailing slash on either side being the same address; everything else -> null: a bare word, a bare code, text with a space in it, another host, another path, no code, a code under 10 characters, a callback that is not https, no callback, nothing",
        clipboardCode(ADDR("s1"), "https://127.0.0.1") === CODE && clipboardCode(ADDR("s1"), "https://127.0.0.1/") === CODE && clipboardCode(`https://127.0.0.1:8182/cb/?code=${A16}`, "https://127.0.0.1:8182/cb") === A16
        && [["hunter2hunter2", "https://127.0.0.1"], [CODE, "https://127.0.0.1"], [`two words https://127.0.0.1/?code=${A16}`, "https://127.0.0.1"], [`https://example.com/?code=${A16}`, "https://127.0.0.1"], [`https://127.0.0.1/x?code=${A16}`, "https://127.0.0.1"], ["https://127.0.0.1/?code=short", "https://127.0.0.1"], [`http://127.0.0.1/?code=${A16}`, "http://127.0.0.1"], [ADDR("s1"), ""], ["", "https://127.0.0.1"]].every(([t, cb]) => clipboardCode(t, cb) === null));
      ok("clipboardCode (pure): NOTHING MAY RIDE ALONG WITH THE ADDRESS — the callback address followed by other words, by a tab, or by a second line (whatever else was copied with it) is not taken at all (-> null: no part of that text can become part of the code); the address alone with only a line break after it is taken",
        [`https://127.0.0.1/?code=${A16} and more words`, `https://127.0.0.1/?code=${A16}\tpasted-next`, `https://127.0.0.1/?code=${A16}\nhunter2hunter2`, `https://127.0.0.1/?code=${A16}\r\nsecond line`, `${ADDR("s1")} ${ADDR("s2")}`].every((t) => clipboardCode(t, "https://127.0.0.1") === null)
        && clipboardCode(`https://127.0.0.1/?code=${A16}\r\n`, "https://127.0.0.1") === A16 && clipboardCode(`  ${ADDR("s1")}\n`, "https://127.0.0.1") === CODE); }
    { const FOREIGN = { present: true, ok: false, foreignApp: true, why: "the token was issued to ANOTHER app key than SCHWAB_MD_APP_KEY — refused; sign this app in again", refreshSha256: sha("another-apps-refresh") }, NOTE = "   the token on the VPS belongs to another app key; this sign-in replaces it";
      V = vps({ status: st({ token: FOREIGN }) }); SSH = V.fn; ASK = async () => CODE; CLIPBOARD = () => ""; lines.length = 0; const eF = await err(login), lF = lines.slice();
      const VS = vps({ status: st({ token: FOREIGN }) }); SSH = VS.fn; lines.length = 0; const sF = await err(() => share()), lS = lines.slice();
      const VN = vps({ status: st({ token: FOREIGN }) }); SSH = VN.fn; lines.length = 0; const sN = await err(() => share({ ifNewer: true }));
      ok("A TOKEN OF ANOTHER APP KEY ON THE VPS (the key in its env file was replaced after the last sign-in) does NOT dead-end the sign-in: --login is not refused — one line says 'the token on the VPS belongs to another app key; this sign-in replaces it', the code is exchanged, the new token stored and read back usable; --share-from-home the same (home's token on stdin, stored, read back as shared); --share-from-home --if-newer sends too (a token no unit can use is never 'new enough')",
        eF === null && seq(V) === "sha,status,url,exchange,status,stat" && lF.includes(NOTE) && V.status().token.ok === true && V.status().token.foreignApp === false && /^NEXT, once/.test(lF[lF.length - 1])
        && sF === null && seq(VS) === "sha,status,install,status,stat" && lS.includes(NOTE) && VS.status().token.mode === "shared" && VS.calls.find((c) => /--install-token/.test(c.script)).input === HR + "\n" && /^done: the VPS runs on home's token/.test(lS[lS.length - 1]) && sN === null && seq(VN) === "sha,status,install,status,stat" && ![...lF, ...lS].some((l) => SECRETS.some((x) => l.includes(x) && !(x === HK && l.includes("client_id=")))), JSON.stringify([eF, seq(V), sF, seq(VS), sN, seq(VN)])); }
    { V = vps({ status: st({ token: tokenOf({ issuedAt: "2026-10-08T02:00:00.000Z", hoursLeft: 24, refreshSha256: sha("last-weeks-token") }), permission: REF }), accepted: true, stuck: true }); SSH = V.fn; ASK = async () => CODE; CLIPBOARD = () => ""; lines.length = 0; const eS = await err(login), lL = lines.slice();
      const VS = vps({ status: st({ token: tokenOf({ mode: "shared", issuedAt: "2026-10-06T16:00:00.000Z", hoursLeft: 14, refreshSha256: sha("last-weeks-token") }), permission: REF }), accepted: true, stuck: true }); SSH = VS.fn; lines.length = 0; const sS = await err(() => share());
      ok("ACCEPTED on the accounts side and the VPS COULD NOT DELETE its token file: the wrapper repeats what the VPS found — 'LOGIN FAILED … It was not stored, but the VPS's token file COULD NOT be deleted — remove it by hand on the VPS (rm /home/traids/.traids/schwab-md-token.json)', and the same after 'SHARE FAILED'; neither says 'is deleted'; the VPS's own line is shown; nothing is claimed done (no printed line says 'done' or names --check-home); the failed LOGIN — not the failed share — ends by sending the operator to --check-home, because Schwab did issue a new sign-in (review, 2026-10-11)",
        /^LOGIN FAILED — Schwab's accounts side ACCEPTED the new token\. It was not stored, but the VPS's token file COULD NOT be deleted — remove it by hand on the VPS \(rm \/home\/traids\/\.traids\/schwab-md-token\.json\)/.test(eS || "") && !/is deleted/.test(eS || "") && V.status().token.present === true && seq(V) === "sha,status,url,exchange" && lL.some((l) => /^   VPS: The new token was NOT stored, but the token file that was here COULD NOT be deleted/.test(l)) && !lL.some((l) => /^done|--check-home/.test(l))
        && /^SHARE FAILED — Schwab's accounts side ACCEPTED home's token on the VPS\. It was not stored, but the VPS's token file COULD NOT be deleted — remove it by hand on the VPS \(rm \/home\/traids\/\.traids\/schwab-md-token\.json\)/.test(sS || "") && !/is deleted/.test(sS || "") && VS.status().token.present === true && !lines.some((l) => /^done/.test(l)) && (eS || "").endsWith(". " + HINT) && !/--check-home|new sign-in/.test(sS || ""), [eS, sS].join(" | ")); }
    ASK = async () => CODE; CLIPBOARD = () => "";
    // ── --status
    V = vps(); SSH = V.fn; lines.length = 0;
    ok("--status with no token -> exit 1 'NOT OK' naming --login; with a fresh token -> exit 0", status() === 1 && lines.some((l) => /NOT OK: [^]*schwab-auth\.cjs --login[^]*--share-from-home/.test(l)) && seq(V) === "sha,status" && (() => { SSH = vps({ status: st({ token: tokenOf(), permission: REF }) }).fn; return status() === 0; })());
    V = vps({ status: st({ token: tokenOf({ ageHours: 30.2, hoursLeft: 137.8 }), permission: { ...REF, ageHours: 2.5 } }) }); SSH = V.fn; lines.length = 0;
    ok("--status with a token of the VPS's own sign-in -> exit 0: WHICH WAY it came, its AGE and HOURS LEFT, and the LAST PERMISSION VERDICT (status code, time, age); read-only (no probing status command)", status() === 0 && lines.some((l) => /VPS token: ok, the VPS's own sign-in, signed in 2026-10-14T02:00:00\.000Z \(30\.2 h ago\)[^]*\(137\.8 h left\) — not home's current token/.test(l)) && lines.some((l) => /permission: Schwab's accounts side refused the token \(HTTP 401 at 2026-10-14T02:00:00\.000Z, 2\.5 h ago\)/.test(l)) && V.calls.every((c) => !/--probe/.test(c.script)), lines.join(" | "));
    V = vps({ status: st({ token: tokenOf({ mode: "shared", refreshSha256: sha(HR) }), permission: REF }) }); SSH = V.fn; lines.length = 0;
    ok("--status with home's token shared -> 'shared from home ... home's current token'", status() === 0 && lines.some((l) => /shared from home[^]*— home's current token/.test(l)));
    V = vps({ status: st({ token: tokenOf(), permission: ACC }) }); SSH = V.fn; lines.length = 0;
    ok("--status when the last verdict on record is ACCEPTED -> exit 1 'NOT OK: PERMISSION GATE'", status() === 1 && lines.some((l) => /^NOT OK: PERMISSION GATE: Schwab's accounts side ACCEPTS/.test(l)));
    // ── --share-from-home
    V = vps(); SSH = V.fn; lines.length = 0;
    const s0 = await err(() => share()), inst = V.calls.find((c) => /--install-token/.test(c.script));
    ok("--share-from-home: home's SCHWAB_REFRESH_TOKEN goes to the VPS on ssh STDIN — the whole stdin is the token and a newline, the command line carries only home's sign-in time (--issued-at, from home's non-secret record); the status read back shows it SHARED, home's current token, refused on the accounts side; the file checked traids 0600", s0 === null && seq(V) === "sha,status,install,status,stat" && inst.input === HR + "\n" && inst.script === `${HELPER} --install-token --issued-at ${HOME_ISS}` && lines.some((l) => /shared from home[^]*— home's current token/.test(l)) && lines.some((l) => /traids's own, mode 0600/.test(l)) && /^done: the VPS runs on home's token/.test(lines[lines.length - 1]), s0 || lines.join(" | "));
    ok("--share-from-home NEVER PRINTS the token and never puts it in a command line: it is in no log line and no ssh script — only its length and times are shown", leaks(V).length === 0 && lines.some((l) => l.includes(`length ${HR.length}`)) && V.calls.filter((c) => c.input && c.input.includes(HR)).length === 1 && V.calls.every((c) => !c.script.includes(HR)), leaks(V).join(" | "));
    const refusedShare = async (setup, o = {}) => { const v = vps(o); SSH = v.fn; lines.length = 0; const s = { HOME_ENV_TEXT, HOME_META_TEXT, NOW }; setup(); const e = await err(() => share()); HOME_ENV_TEXT = s.HOME_ENV_TEXT; HOME_META_TEXT = s.HOME_META_TEXT; NOW = s.NOW; return { e, sent: v.calls.some((c) => /--install-token/.test(c.script)), leak: SECRETS.filter((x) => String(e).includes(x)) }; };
    { const cases = [["home has no SCHWAB_REFRESH_TOKEN", () => { HOME_ENV_TEXT = () => `SCHWAB_APP_KEY=${HK}\nSCHWAB_APP_SECRET=${HS}`; }, /no SCHWAB_REFRESH_TOKEN in backend\/\.env[^]*nothing sent/], ["home's token is not one line without spaces", () => { HOME_ENV_TEXT = () => ENV.replace(HR, "two parts " + "x".repeat(50)); }, /\(length 60\) is not a token this step can send[^]*nothing sent/],
        ["home's sign-in time is not on record", () => { HOME_META_TEXT = () => { throw new Error("ENOENT"); }; }, /nothing sent: home's sign-in time is not on record/], ["the time on record is for ANOTHER token (fingerprint mismatch)", () => { HOME_META_TEXT = () => META({ refreshTokenFingerprint: fpOf("an-older-token") }); }, /nothing sent: the sign-in time on record is not for the token now in backend\/\.env/],
        ["home's own token is past its 7 days", () => { NOW = () => Date.parse("2026-10-20T17:00:00Z"); }, /nothing sent: home's own token is past its 7 days[^]*sign in at home first/], ["home's own token has under an hour left", () => { NOW = () => Date.parse("2026-10-20T16:00:00Z"); }, /nothing sent: home's own token has 0\.5 h of its 7 days left/]];
      const res = []; for (const [, setup] of cases) res.push(await refusedShare(setup));
      ok("--share-from-home REFUSES with NOTHING SENT and no value in the message: " + cases.map((c) => c[0]).join("; "), res.every((r, i) => cases[i][2].test(r.e || "") && !r.sent && r.leak.length === 0), res.map((r) => r.e).join(" | "));
      const other = await refusedShare(() => {}, { status: st({ env: { keySha256: sha(K), secretSha256: sha(S) } }) });
      ok("--share-from-home when the VPS's app key is NOT home's (another app's key in its env file) -> REFUSED, nothing sent: home's token belongs to home's app", /the VPS's SCHWAB_MD_APP_KEY is not home's SCHWAB_APP_KEY[^]*--step keys/.test(other.e || "") && !other.sent && other.leak.length === 0, other.e); }
    { const run = async (status0, ifNewer) => { const v = vps({ status: status0 }); SSH = v.fn; lines.length = 0; const e = await err(() => share({ ifNewer })); return { e, sent: v.calls.filter((c) => /--install-token/.test(c.script)).length, out: lines.join(" | ") }; };
      const same = await run(st({ token: tokenOf({ mode: "shared", issuedAt: HOME_ISS, refreshSha256: sha(HR) }), permission: REF }), true), newer = await run(st({ token: tokenOf({ issuedAt: "2026-10-13T20:00:00.000Z" }), permission: REF }), true);
      const older = await run(st({ token: tokenOf({ mode: "shared", issuedAt: "2026-10-06T16:00:00.000Z", hoursLeft: 14, refreshSha256: sha("last-weeks-token") }), permission: REF }), true), none = await run(st(), true), force = await run(st({ token: tokenOf({ mode: "shared", issuedAt: HOME_ISS, refreshSha256: sha(HR) }), permission: REF }), false);
      ok("--share-from-home --if-newer (what the weekly home sign-in is followed by): the VPS already holds home's current token -> nothing sent; the VPS's own sign-in is NEWER than home's -> nothing sent; the VPS holds LAST WEEK'S token -> sent; the VPS has no token -> sent. Without --if-newer it is always sent", same.e === null && same.sent === 0 && /nothing to do: the VPS already holds home's current token/.test(same.out) && newer.e === null && newer.sent === 0 && /is not older than home's/.test(newer.out) && older.e === null && older.sent === 1 && none.e === null && none.sent === 1 && force.e === null && force.sent === 1, JSON.stringify([same, newer, older, none, force].map((x) => [x.e, x.sent]))); }
    V = vps({ status: st({ token: tokenOf({ mode: "shared", issuedAt: "2026-10-06T16:00:00.000Z", hoursLeft: 14, refreshSha256: sha("last-weeks-token") }), permission: REF }), accepted: true }); SSH = V.fn; lines.length = 0;
    const sA = await err(() => share());
    ok("THE PERMISSION GATE — --share-from-home whose token Schwab's accounts side ACCEPTS on the VPS: not stored, the VPS's token file deleted, the command FAILS LOUDLY ('SHARE FAILED'), nothing claimed done", /^SHARE FAILED — Schwab's accounts side ACCEPTED home's token on the VPS[^]*token file is deleted/.test(sA || "") && V.status().token.present === false && !lines.some((l) => /^done/.test(l)), sA);
    { const a = vps({ unverified: true }); SSH = a.fn; lines.length = 0; const eu = await err(() => share()); const b = vps({ fails: true }); SSH = b.fn; const ef = await err(() => share()); const c = vps({ storesOther: true }); SSH = c.fn; const eo = await err(() => share());
      ok("--share-from-home: no verdict from the accounts side -> FAILS (not stored, run it again); Schwab refuses the token at its first refresh on the VPS -> FAILS; a VPS that stored some OTHER token -> FAILS (the fingerprints differ)", /^SHARE FAILED — Schwab's accounts side gave no verdict[^]*--share-from-home again/.test(eu || "") && /the share failed on the VPS \(exit 1\)/.test(ef || "") && /it is not home's current token/.test(eo || ""), [eu, ef, eo].join(" | ")); }
    // ── known answers added 2026-10-11 (review, fix cycle 1, third batch): a --login that fails AFTER the VPS exchanged the code sends the
    //    operator to --check-home; one that fails before, and a failed share, do not; a share to a VPS whose env file is not usable sends nothing
    { const run = async (o) => { V = vps(o); SSH = V.fn; ASK = async () => CODE; CLIPBOARD = () => ""; lines.length = 0; const e = await err(login); return { e: e || "", seq: seq(V), printed: lines.slice() }; };
      const acc = await run({ accepted: true }), unv = await run({ unverified: true }), rb = await run({ noReadBack: true }), fr = await run({ firstRefresh: true });
      ok("A --login THAT FAILS AFTER THE VPS EXCHANGED THE CODE SENDS THE OPERATOR TO --check-home (Schwab has issued a new sign-in for the app; if it keeps one per app, home's has ended): the accounts side ACCEPTED the new token, it gave NO VERDICT, the new token's first refresh failed, the stored token did not read back — each failure ends, known to the character, 'Schwab DID issue a new sign-in for the app in this attempt … run … --check-home now; if home did not survive, run automation\\schwab-auth.bat'; none prints 'done' or the success line 'NEXT, once'",
        [acc, unv, rb, fr].every((r) => r.e.endsWith(". " + HINT) && r.seq === "sha,status,url,exchange" && !r.printed.some((l) => /^done|^NEXT, once/.test(l))) && /^LOGIN FAILED — Schwab's accounts side ACCEPTED the new token\. [^]*Do not run --login again until you have read NOTES\.md, 'If the accounts side ever accepts the token'\. Schwab DID issue/.test(acc.e) && /^LOGIN FAILED — Schwab's accounts side gave no verdict[^]*--login again when Schwab answers\. Schwab DID issue/.test(unv.e)
        && [rb, fr].every((r) => r.e === `LOGIN FAILED after the VPS had exchanged the code (exit 1; its line is above): no usable token came of this sign-in. Run node docs/server/wave2b-schwab/schwab-auth.cjs --login again. ${HINT}`) && rb.printed.some((l) => /^   VPS: FAILED: the token file was written but does not read back/.test(l)) && fr.printed.some((l) => /^   VPS: FAILED: the new token's first refresh/.test(l)), JSON.stringify([acc.e, unv.e, rb.e, fr.e]));
      const stored = []; for (const o of [{ noVerdict: true }, { wrongMode: "shared" }, { stat: "root 644" }]) stored.push(await run(o));
      ok("… and so does a --login whose token WAS stored but does not check out (no verdict recorded for it; another mode; a token file that is not traids 0600): the token is on the VPS, so Schwab has issued the new sign-in — each failure ends with the same sentence, and none prints 'done' or 'NEXT, once'", stored.every((r) => r.e.endsWith(". " + HINT) && r.seq.startsWith("sha,status,url,exchange,status") && !r.printed.some((l) => /^done|^NEXT, once/.test(l))) && /records no fresh 'refused' verdict/.test(stored[0].e) && /reads as mode shared, not login/.test(stored[1].e) && /not traids's own with mode 0600/.test(stored[2].e), JSON.stringify(stored.map((r) => r.e)));
      const pre = [await run({ fails: true }), await run({ badHelper: true }), await run({ status: st({ env: { ok: false, names: ["SCHWAB_MD_APP_KEY"], why: "SCHWAB_MD_APP_SECRET missing" } }) })];
      V = vps(); SSH = V.fn; ASK = async () => "nothing useful"; lines.length = 0; const noCode = (await err(login)) || ""; ASK = async () => CODE;
      ok("A --login THAT FAILS BEFORE ANY SIGN-IN WAS ISSUED says nothing of a new sign-in and does not name --check-home: the exchange refused by Schwab (400: the code was not taken — its message is the old one, to the character), the helper not this package's copy, the VPS env file not usable, no code given",
        [...pre.map((r) => r.e), noCode].every((e) => e && !/new sign-in|--check-home/.test(e)) && pre[0].e === "the exchange on the VPS failed (exit 1) — run --login again (a code is single-use)" && pre[0].seq === "sha,status,url,exchange" && /not the copy this package sends/.test(pre[1].e) && /^REFUSED before any Schwab call/.test(pre[2].e) && /^no \?code= in what was given/.test(noCode), JSON.stringify([...pre.map((r) => r.e), noCode]));
      const shareFails = []; for (const o of [{ accepted: true }, { unverified: true }, { fails: true }, { storesOther: true }]) { const v = vps(o); SSH = v.fn; lines.length = 0; shareFails.push((await err(() => share())) || ""); }
      ok("A FAILED --share-from-home never names --check-home and never says a new sign-in was issued (a share is one refresh with home's token: it ends no sign-in) — the accounts side accepting the token, no verdict, Schwab refusing the token on the VPS, a VPS that stored another token",
        shareFails.length === 4 && shareFails.every((e) => e && !/--check-home|new sign-in/.test(e)) && /^SHARE FAILED — Schwab's accounts side ACCEPTED/.test(shareFails[0]) && /^SHARE FAILED — Schwab's accounts side gave no verdict/.test(shareFails[1]) && /^the share failed on the VPS \(exit 1\)/.test(shareFails[2]) && /it is not home's current token/.test(shareFails[3]), JSON.stringify(shareFails));
      const unusable = st({ env: { ok: false, names: ["SCHWAB_MD_APP_KEY", "SCHWAB_MD_APP_SECRET", "SCHWAB_APP_KEY"], why: "/etc/traids/w2b-schwab.env holds SCHWAB_APP_KEY — home's env names never go into this file: REFUSED" } });
      const r1 = await refusedShare(() => {}, { status: unusable }), v2 = vps({ status: unusable }); SSH = v2.fn; lines.length = 0; const e2 = (await err(() => share({ ifNewer: true }))) || "";
      ok("--share-from-home when the VPS's ENV FILE IS NOT USABLE (it holds one of home's names; its key's fingerprint still reads as home's app): REFUSED with NOTHING SENT — no --install-token call, nothing on any ssh stdin, the only ssh calls are the helper's sha256 and the read-only status — and it points at the keys step; the same with --if-newer; no value in either message",
        /^REFUSED, nothing sent: the VPS env file is not usable: [^]*SCHWAB_APP_KEY[^]* — node docs\/server\/wave2b-schwab\/deploy\.cjs --step keys$/.test(r1.e || "") && !r1.sent && r1.leak.length === 0 && /^REFUSED, nothing sent: the VPS env file is not usable: /.test(e2) && seq(v2) === "sha,status" && v2.calls.every((c) => c.input == null) && !SECRETS.some((x) => e2.includes(x)), [r1.e, e2].join(" | ")); }
    // ── --check-home
    { const run = async (refresh, o = {}) => { lines.length = 0; let n = 0; const s = { HOME_META_TEXT, NOW }; HOME_REFRESH = async () => { n++; return refresh(); }; if (o.now) NOW = () => o.now; if (o.meta) HOME_META_TEXT = o.meta; let code = null, e = null; try { code = await checkHome(); } catch (x) { e = x.message; } HOME_META_TEXT = s.HOME_META_TEXT; NOW = s.NOW; return { code, e, n, out: lines.join("\n") }; };
      const surv = await run(async () => true);
      ok("--check-home, home's refresh SUCCEEDS -> exit 0 'HOME'S SIGN-IN SURVIVED': two sign-ins live side by side, keep both weekly; exactly ONE refresh was made", surv.code === 0 && surv.n === 1 && /HOME'S SIGN-IN SURVIVED/.test(surv.out) && /automation\\schwab-auth\.bat for home, node docs\/server\/wave2b-schwab\/schwab-auth\.cjs --login for the VPS/.test(surv.out) && /signed in 2026-10-13T16:28:30\.122Z, 158\.5 h of its 7 days left/.test(surv.out), surv.out);
      const dead = await run(async () => { throw new Error("schwab token refresh 400 — token likely expired (7-day rot); run automation/schwab-auth.bat"); });
      ok("--check-home, Schwab REFUSES home's refresh (400) with days left -> exit 1 'HOME'S SIGN-IN DID NOT SURVIVE': Schwab keeps one live sign-in; it names the two steps (the home sign-in, then --share-from-home) and the weekly form (--share-from-home --if-newer); exactly ONE refresh was made", dead.code === 1 && dead.n === 1 && /HOME'S SIGN-IN DID NOT SURVIVE: Schwab refused home's token \(HTTP 400\) with 158\.5 h of its 7 days left/.test(dead.out) && /1\. automation\\schwab-auth\.bat/.test(dead.out) && /2\. node docs\/server\/wave2b-schwab\/schwab-auth\.cjs --share-from-home /.test(dead.out) && /--share-from-home --if-newer\. Do not use --login again/.test(dead.out), dead.out);
      const old = await run(async () => { throw new Error("schwab token refresh 401 — token likely expired (7-day rot); run automation/schwab-auth.bat"); }, { now: Date.parse("2026-10-21T00:00:00Z") });
      const net = await run(async () => { throw new Error("fetch failed"); }), s5 = await run(async () => { throw new Error("schwab token refresh 503 — token likely expired (7-day rot); run automation/schwab-auth.bat"); }), nocfg = await run(async () => { throw new Error("schwab not configured — run automation/schwab-auth.bat"); });
      ok("--check-home concludes NOTHING when it cannot: home's token had reached its own 7 days (a refusal then says nothing about the VPS's sign-in); no answer from Schwab ('fetch failed'); an HTTP 503; home not configured — each exit 1 'NOT CONCLUDED', never 'SURVIVED' or 'DID NOT SURVIVE'", [old, net, s5, nocfg].every((r) => r.code === 1 && r.n === 1 && /NOT CONCLUDED/.test(r.out) && !/SURVIVED|DID NOT SURVIVE/.test(r.out)) && /had reached its own 7 days/.test(old.out) && /no usable answer to home's refresh \(fetch failed\)/.test(net.out) && /\(HTTP 503\)/.test(s5.out) && /no Schwab token in backend\/\.env/.test(nocfg.out), [old, net, s5, nocfg].map((r) => r.out).join(" || "));
      const nometa = await run(async () => { throw new Error("schwab token refresh 400 — x"); }, { meta: () => { throw new Error("ENOENT"); } }), leak = await run(async () => { throw new Error("boom " + HR); });
      ok("--check-home with no sign-in time on record still reports a refusal as DID NOT SURVIVE (it cannot rule out the 7 days, and says the time is not known); an error text is scrubbed (a token-shaped run is never printed)", nometa.code === 1 && /its sign-in time is not known/.test(nometa.out) && /HOME'S SIGN-IN DID NOT SURVIVE: Schwab refused home's token \(HTTP 400\)\. Schwab keeps ONE/.test(nometa.out) && leak.code === 1 && !leak.out.includes(HR) && /\[redacted\]/.test(leak.out), nometa.out + " || " + leak.out); }
    { // the real HOME_REFRESH against a FAKE home library (a temp file): a fresh load each time, one token() call each time
      const lib = path.join(tmp, "schwab.js");
      fs.writeFileSync(lib, 'globalThis.__w2bLoads = (globalThis.__w2bLoads || 0) + 1; let cached = null; module.exports = { token: async () => { if (cached) return cached; globalThis.__w2bGrants = (globalThis.__w2bGrants || 0) + 1; if (globalThis.__w2bDead) throw new Error("schwab token refresh 400 — token likely expired (7-day rot); run automation/schwab-auth.bat"); cached = "an-access-token"; return cached; } };\n');
      HOME_REFRESH = save.HOME_REFRESH; HOME_LIB = lib; globalThis.__w2bLoads = 0; globalThis.__w2bGrants = 0; globalThis.__w2bDead = false; lines.length = 0;
      const a = await checkHome(), b = await checkHome(), g2 = globalThis.__w2bGrants, l2 = globalThis.__w2bLoads; globalThis.__w2bDead = true; const c = await checkHome();
      process.env.SCHWAB_MD_TOKEN_FILE = "/x/tok.json"; lines.length = 0; const d = await checkHome(), dOut = lines.join("\n"), g4 = globalThis.__w2bGrants;
      delete process.env.SCHWAB_MD_TOKEN_FILE;
      ok("--check-home's ONE FORCED REFRESH through the home library (a fake library file here): the library is loaded FRESH each run, so a token cached by an earlier call cannot answer — two runs make two refresh grants; a refusal comes back as DID NOT SURVIVE; with SCHWAB_MD_TOKEN_FILE set in the shell it asks nothing (that path is the VPS's) and concludes nothing", a === 0 && b === 0 && l2 === 2 && g2 === 2 && c === 1 && g4 === 3 && globalThis.__w2bLoads === 3 && d === 1 && /^NOT CONCLUDED: SCHWAB_MD_TOKEN_FILE is set in this shell[^]*Nothing was asked/.test(dOut), JSON.stringify({ a, b, l2, g2, c, d, g4, dOut })); }
    ok("arguments: each mode alone; --share-from-home takes --if-newer; anything else (a typo, --if-newer alone, two modes) is refused", parseArgs(["--login"]).mode === "login" && parseArgs(["--check-home"]).mode === "check-home" && parseArgs(["--status"]).mode === "status" && parseArgs(["--share-from-home"]).ifNewer === false && parseArgs(["--share-from-home", "--if-newer"]).ifNewer === true && parseArgs(["--share-from-home", "--if-newer"]).mode === "share" && [["--if-newer"], ["--login", "--status"], ["--share"], [], ["--login", "--if-newer"]].every((a) => parseArgs(a) === null));
    const src = fs.readFileSync(__filename, "utf8").split("async function selftest")[0];
    ok("the wrapper prints no value: every log line is built from names, lengths, times and status codes; home's token reaches ssh only as `input`; nothing here refuses a VPS app for being home's", !/log\([^;]*(?:\b(tk|code|h\.home\.refresh)\b(?!\.length)|\binput\b(?!\.length|\s*\?))[^;]*\);/.test(src.replace(/input: (tk|code) \+ "\\n"/g, "input: X")) && /log\([^;]*\binput\b(?!\.length|\s*\?)[^;]*\);/.test('log(`   (read the clipboard: ${input ? "an address of length " + input.length + " " + input : "empty"})`);') && (src.match(/\$\{input \? "an address of length " \+ input\.length : "empty"\}/g) || []).length === 1 &&(src.match(/input: tk \+ "\\n"/g) || []).length === 1 && (src.match(/input: code \+ "\\n"/g) || []).length === 1 && !/EQUALS home|TRADING app/.test(src));
  } finally { SSH = save.SSH; log = save.log; HOME_ENV_TEXT = save.HOME_ENV_TEXT; HOME_META_TEXT = save.HOME_META_TEXT; HOME_REFRESH = save.HOME_REFRESH; HOME_LIB = save.HOME_LIB; ASK = save.ASK; CLIPBOARD = save.CLIPBOARD; NOW = save.NOW; fs.rmSync(tmp, { recursive: true, force: true }); if (saveMdEnv === undefined) delete process.env.SCHWAB_MD_TOKEN_FILE; else process.env.SCHWAB_MD_TOKEN_FILE = saveMdEnv; }
  console.log(`schwab-auth selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const A = parseArgs(process.argv.slice(2));
  const fin = (p) => Promise.resolve().then(p).then((c) => { process.exitCode = c; }, (e) => { console.error("schwab-auth: " + e.message); process.exitCode = 1; });
  if (!A) { console.error("usage: node docs/server/wave2b-schwab/schwab-auth.cjs --login | --check-home | --share-from-home [--if-newer] | --status | --selftest"); process.exitCode = 2; }
  else if (A.mode === "selftest") selftest().then((x) => { process.exitCode = x ? 0 : 1; });
  else if (A.mode === "login") fin(login);
  else if (A.mode === "check-home") fin(checkHome);
  else if (A.mode === "share") fin(() => share({ ifNewer: A.ifNewer }));
  else fin(status);
}
module.exports = { login, status, checkHome, share, parseArgs, homeIssue, clipboardCode, callbackOf };
