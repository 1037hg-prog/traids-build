#!/usr/bin/env node
"use strict";
/**
 * SEAT-SDK TRIAL (work order 4.31; operator 2026-10-12: "build it for a trial period") — RUN ONE SEAT THROUGH THE AGENT SDK.
 *
 * WHAT IT IS. The six nightly seats have always been launched by automation/seat-wave.cjs as
 *     claude.exe -p <prompt> --agent <seat> --permission-mode bypassPermissions --output-format json --max-turns 60
 *                --max-budget-usd <cap> [--model opus] [--resume <id>]          (cwd: the repo root)
 * on the command line's own sign-in. This file runs the SAME seat — the same seat definition (.claude/agents/<seat>.md, loaded by the
 * launcher's own loader), the same prompt text, the same model tier, the same cap, the same working directory, the same permission
 * mode and turn limit — through Anthropic's Agent SDK (@anthropic-ai/claude-agent-sdk, ONE pinned version installed in this folder
 * and nowhere else), which bills the home API key. It returns the envelope the command line prints (type "result": result,
 * total_cost_usd, num_turns, session_id ...), so the seat wave seals the seat's row exactly as it does now, plus a `seatSdk` block.
 *
 * TOOLS, NO WIDER. The SDK is told the seat definition's own tool list and nothing else (options.tools), and to start no MCP server
 * at all (strictMcpConfig). When the session starts the launcher reports what it really gave the seat; this runner STOPS the run when
 * that report shows the subscription sign-in instead of the API key, another working directory, another permission mode, another
 * model tier, or a tool the seat definition does not list.
 *
 * THE KEY. Read from the process environment only. When it is not there, backend/.env is parsed with the house's own loader (dotenv)
 * and ONLY that one name is taken into this process's environment. It is handed to the SDK in an environment built from the house
 * allow-list (backend/lib/agent-cli.js childEnv: what a program needs to run, never a broker key, never another ANTHROPIC_* name).
 * It is never printed, logged, written to a file or put on a command line: every text this runner returns or records has each
 * credential value of its environment replaced by its <NAME> first.
 *
 * NEVER A SILENT SKIP, NEVER THE OTHER PATH. Every launch ends in exactly one of
 *     OK        the seat ran and its sealed claim is in backend/data/seat-claims.jsonl
 *     UNKNOWN   with a one-line reason: no key · the key file cannot be read · the SDK did not load · the request was refused ·
 *               the start-of-session check failed · the run timed out or broke · the seat ended without its sealed output
 *     REFUSED   with the reason: a limit of the trial (automation/seat-sdk/ledger.cjs) or the switch said no before anything started
 * and writes its row to the spend ledger. It runs each launch ONCE: no retry, and nothing here can start the command-line path.
 *
 * A REFUSED REQUEST AND A RUN THAT BROKE ARE TOLD APART. An error result is "the request was refused" when it carries a refusal — an
 * assistant error code other than the service-side ones (server_error, overloaded, rate_limit, unknown, max_output_tokens), or an
 * HTTP 4xx other than 429 — and also when nothing had run (no cost above $0, or one turn at most). It gets no follow-up turn. An
 * error result with no refusal on it, a reported cost above $0 and more than one turn is "the run ended with an error after it had
 * worked": the seat ran, so — when it sealed nothing and its session passed the start-of-session check — it may have the ONE
 * follow-up turn the command line gives it (canFollowUp), inside what is left of its cap. On the record that turn sealed the seat
 * (portfolio-manager, 2026-10-07: "API Error: Server error mid-response", then sealed 1).
 *
 * THE SESSION LABEL (--session) keys the seat's cap and the night's cap, so it is checked, not trusted: a day YYYY-MM-DD that is the
 * runner's own ET day or the day before it; anything else is not started. The ledger also counts the night by its own clock (the last
 * 20 hours) and uses the larger of the two counts, so a second label on the same evening opens no second night.
 * THE LEDGER IS HELD AGAINST THE SEAT WAVE'S OWN HISTORY: SDK spend that history shows and the ledger holds no run for (a ledger that
 * was deleted, moved or put back from an older copy) refuses every seat. And no launch is started on less than $0.25 of the seat's cap.
 * THE END DATE holds for the whole launch: a launch whose minutes would not be over by the trial's end is refused, and the run's own
 * time limit never reaches past that instant.
 * A COST OF $0 is believed only for a refused request; any other result's zero is recorded UNKNOWN and counted at the full cap.
 *
 *   node automation/seat-sdk/run-seat.cjs --seat <seat> --budget <usd> --minutes <n> [--model <m>] [--resume <session id>] [--session YYYY-MM-DD]
 *                                         the prompt on STANDARD INPUT; prints ONE line, the envelope. Exit 0 the run ended cleanly ·
 *                                         1 it ran and ended in an error · 3 REFUSED · 4 not started / runner error (UNKNOWN)
 *   node automation/seat-sdk/run-seat.cjs --status      READ-ONLY: the switch, each seat's route and what the limits would say now, the
 *                                         ledger's totals, the SDK pin, whether a key is present (and its length, never its value)
 *
 * The seat wave does not call this file directly: automation/seat-sdk/wave-hook.cjs does, once per launch, as a child process.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto"), cp = require("child_process"), { pathToFileURL } = require("url");
const S = require("./seats.cjs"), PROVIDER = require("./provider.cjs"), LEDGER = require("./ledger.cjs");

const HERE = __dirname, HERE_ROOT = path.resolve(HERE, "..", "..");
const SDK_NAME = "@anthropic-ai/claude-agent-sdk", KEY_NAME = "ANTHROPIC_API_KEY", SEAL_ENV = "TRAIDS_SEAT_SDK_SELFTEST";
const MIN_KEY_CHARS = 20, CLIENT_APP = "traids-seat-sdk/1.0.0";
const EXIT = { clean: 0, error: 1, refused: 3, notStarted: 4 };

const one = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
/** the calendar day before a YYYY-MM-DD day */
const dayBefore = (day) => new Date(Date.parse(day + "T12:00:00Z") - 86400000).toISOString().slice(0, 10);
/**
 * THE SESSION LABEL keys the per-seat and per-night caps, so it is not taken as given: it must be a day YYYY-MM-DD and either the
 * runner's own ET day or the day before it (a wave that started before midnight ET and is still running after it).
 * -> null when it may be used, else the reason in words (the label itself is quoted by the caller, redacted)
 */
function sessionProblem(label, ownDay) {
  if (typeof label !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(label)) return "is not a day YYYY-MM-DD";
  if (label !== ownDay && label !== dayBefore(ownDay)) return `is neither this runner's own ET day (${ownDay}) nor the day before it`;
  return null;
}
const houseLib = (root) => require(path.join(root, "backend", "lib", "agent-cli.js"));

// ── redaction: replace first, cut second ─────────────────────────────────────────────────────────────────────────────────────────────
/** every credential value of `env` (the house's credValues, and the key by name whatever its shape) -> { text(s), deep(v) } */
function redactor(AC, env) {
  const secrets = AC ? AC.credValues(env) : [];
  const key = env && env[KEY_NAME];
  if (key && !secrets.some(([, v]) => v === String(key))) secrets.push([KEY_NAME, String(key)]);
  const sorted = [...secrets].filter(([, v]) => v).sort((a, b) => b[1].length - a[1].length);
  const text = (s) => { let t = String(s == null ? "" : s); for (const [n, v] of sorted) t = t.split(v).join(`<${n}>`); return t; };
  const deep = (v) => (typeof v === "string" ? text(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), deep(x)])) : v);
  return { text, deep, count: sorted.length };
}

// ── the key: the process environment only; backend/.env loaded the house's way, one name taken ───────────────────────────────────────
/** -> { ok: true, source, length } (env[KEY_NAME] is set) | { ok: false, reason }. Never returns, prints or stores the value. */
function loadKey(root, env) {
  const shaped = (v, source) => {
    const s = String(v);
    if (s.length < MIN_KEY_CHARS || /\s/.test(s)) return { ok: false, reason: `${KEY_NAME} (${source}) is present but is not key-shaped (length ${s.length})` };
    return { ok: true, source, length: s.length };
  };
  if (env[KEY_NAME] != null && String(env[KEY_NAME]) !== "") return shaped(env[KEY_NAME], "the environment");
  let buf;
  try { buf = fs.readFileSync(path.join(root, "backend", ".env")); }
  catch (e) { return { ok: false, reason: `no ${KEY_NAME} in the environment and the key file backend/.env cannot be read (${(e && e.code) || "error"})` }; }
  let parsed;
  try { parsed = require(path.join(root, "backend", "node_modules", "dotenv")).parse(buf); }
  catch (e) { return { ok: false, reason: `no ${KEY_NAME} in the environment and backend/.env could not be loaded the house's way (dotenv: ${(e && e.code) || "error"})` }; }
  const v = parsed && Object.prototype.hasOwnProperty.call(parsed, KEY_NAME) ? parsed[KEY_NAME] : null;
  if (v == null || String(v) === "") return { ok: false, reason: `no ${KEY_NAME} in the environment or in backend/.env` };
  const r = shaped(v, "backend/.env");
  if (r.ok) env[KEY_NAME] = String(v);   // into the process environment, and read from there from here on
  return r;
}

// ── the SDK: the one pinned package of this folder, by injection in every test ───────────────────────────────────────────────────────
function pinnedVersion() {
  const p = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")), deps = Object.keys(p.dependencies || {});
  const v = p.dependencies && p.dependencies[SDK_NAME];
  if (deps.length !== 1 || !/^\d+\.\d+\.\d+$/.test(String(v))) throw new Error(`automation/seat-sdk/package.json must pin ${SDK_NAME} to one exact version and name no other dependency`);
  return v;
}
/** read-only: { pinned, installed, fake, dir, problem } */
function sdkInfo() {
  const dir = path.join(HERE, "node_modules", ...SDK_NAME.split("/")), out = { pinned: null, installed: null, fake: false, dir, problem: null };
  try { out.pinned = pinnedVersion(); } catch (e) { out.problem = one(e.message); return out; }
  let pkg; try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch (e) { out.problem = `${SDK_NAME} is not installed in automation/seat-sdk (${(e && e.code) || "unreadable"}): run \`npm ci\` in that folder`; return out; }
  out.installed = pkg.version; out.fake = pkg.traidsFake === true; out.pkg = pkg;
  if (pkg.name !== SDK_NAME) out.problem = `the package in ${SDK_NAME}'s folder names itself ${JSON.stringify(pkg.name)}`;
  else if (pkg.version !== out.pinned) out.problem = `the installed ${SDK_NAME} is ${pkg.version}, not the pinned ${out.pinned}`;
  return out;
}
/**
 * load the SDK's entry point -> { query, version }, or throws with the reason. THE SEAL: with TRAIDS_SEAT_SDK_SELFTEST=1 (every
 * selftest) only a package that says it is a fake is loaded — the real SDK never is; without it a fake is refused.
 */
async function loadSdk(env = process.env) {
  const info = sdkInfo(); if (info.problem) throw new Error(info.problem);
  const sealed = env[SEAL_ENV] === "1" || process.env[SEAL_ENV] === "1";   // either one seals: a test that hands over its own environment is sealed by the process's
  if (sealed && !info.fake) throw new Error(`sealed: ${SEAL_ENV}=1 (a selftest) never loads the real SDK`);
  if (!sealed && info.fake) throw new Error("the installed SDK is a selftest's fake: refused outside a selftest");
  const ex = info.pkg.exports && info.pkg.exports["."], entry = (ex && typeof ex === "object" && (ex.default || ex.import)) || (typeof ex === "string" ? ex : null) || info.pkg.main;
  if (typeof entry !== "string") throw new Error("the SDK package names no entry point");
  const mod = await import(pathToFileURL(path.join(info.dir, entry)).href);
  if (!mod || typeof mod.query !== "function") throw new Error("the SDK has no query() entry point");
  return { query: mod.query, version: info.installed };
}

// ── what the launcher reports when the session starts, held against what the seat may have ──────────────────────────────────────────
const normPath = (p) => {
  let s = String(p).replace(/\\/g, "/");
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(s); if (m && process.platform === "win32") s = `${m[1]}:/${m[2]}`;
  s = path.resolve(s).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
};
/** does a reported model id belong to the tier the seat runs on? ("opus" in claude-opus-…; a full id must be that id) */
function tierMatches(model, tier) {
  const m = String(model).toLowerCase(), t = String(tier).toLowerCase();
  if (t === "inherit") return true;
  if (/^[a-z]+$/.test(t)) return new RegExp(`(^|[^a-z])${t}([^a-z]|$)`).test(m);
  return m === t || m.startsWith(t);
}
/** null when the session the launcher started is the one this seat may have, else the one-line reason the run is stopped for */
function initProblem(init, { root, def, tier }) {
  const src = init.apiKeySource == null ? null : one(init.apiKeySource);
  if (src != null && /^(oauth|none)$/i.test(src)) return `the launcher did not take the API key (it reports key source "${src}": the subscription sign-in) — stopped, so nothing is spent on that path`;
  if (init.cwd != null && normPath(init.cwd) !== normPath(root)) return `the launcher's working directory is not the repo root (${one(init.cwd).slice(0, 120)})`;
  if (init.permissionMode != null && init.permissionMode !== S.PERMISSION_MODE) return `the launcher's permission mode is ${one(init.permissionMode).slice(0, 40)}, not ${S.PERMISSION_MODE}`;
  if (tier && init.model != null && !tierMatches(init.model, tier)) return `the launcher's model is ${one(init.model).slice(0, 60)}, not the seat's ${tier} tier`;
  if (Array.isArray(init.tools)) {
    const extra = init.tools.map(String).filter((t) => !def.tools.includes(t));
    if (extra.length) return `the launcher offers ${extra.length} tool(s) the seat definition does not list (${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ", ..." : ""})`;
  }
  return null;
}
/** the part of the start-of-session report kept in the ledger row (names and counts; nothing the seat wrote) */
function initRecord(init, { root, def, seat }) {
  if (!init) return null;
  const tools = Array.isArray(init.tools) ? init.tools.map(String) : null, agents = Array.isArray(init.agents) ? init.agents.map(String) : null;
  return { keySource: init.apiKeySource == null ? null : one(init.apiKeySource).slice(0, 40), model: init.model == null ? null : one(init.model).slice(0, 80), cwdIsRoot: init.cwd == null ? null : normPath(init.cwd) === normPath(root),
    permissionMode: init.permissionMode == null ? null : one(init.permissionMode).slice(0, 40), tools: tools ? tools.slice(0, 40) : null, toolsBeyondDefinition: tools ? tools.filter((t) => !def.tools.includes(t)).length : null,
    mcpServers: Array.isArray(init.mcp_servers) ? init.mcp_servers.length : null, agentsReported: agents ? agents.length : null, seatListed: agents ? agents.includes(seat) : null,
    claudeCodeVersion: init.claude_code_version == null ? null : one(init.claude_code_version).slice(0, 40) };
}
/** rows the seat sealed for this session (backend/data/seat-claims.jsonl, written by backend/seal-claim.js: never by this runner) */
function countSealed(root, seat, session) {
  let n = 0;
  try { for (const l of fs.readFileSync(path.join(root, "backend", "data", "seat-claims.jsonl"), "utf8").split(/\r?\n/)) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r && r.seat === seat && r.session === session) n++; } catch { /* not a row */ } } } catch { /* no ledger yet */ }
  return n;
}
/**
 * THE SDK'S ASSISTANT ERROR CODES THAT ARE NOT A REFUSAL (sdk.d.ts SDKAssistantMessageError): the service broke or was busy; the request
 * itself was not turned down. Every other code — authentication_failed, oauth_org_not_allowed, billing_error, invalid_request,
 * model_not_found, and any code this runner does not know (fail closed) — is a refusal: asked again, it would be refused again.
 */
const BREAK_CODES = ["server_error", "overloaded", "rate_limit", "unknown", "max_output_tokens"];
/** an HTTP status that turns the request itself down: 4xx, except 429 (busy: the request was not judged) */
const refusalStatus = (st) => typeof st === "number" && st >= 400 && st < 500 && st !== 429;
/**
 * WAS THE REQUEST REFUSED? -> { refused, what }   refused: an assistant error code or an HTTP status says the request itself was
 * turned down · what: the codes and the status the result carries, for the reason ("billing_error, HTTP 402"; "" when it carries none)
 */
function refusalOf(result, apiErrors) {
  const codes = [...new Set(apiErrors || [])], st = result ? result.api_error_status : null;
  return { refused: codes.some((c) => !BREAK_CODES.includes(c)) || refusalStatus(st), what: [...codes, typeof st === "number" ? "HTTP " + st : null].filter(Boolean).join(", ") };
}
/**
 * DID THE RUN BREAK AFTER IT HAD WORKED? An error result with no refusal on it, whose cost is a reported number above $0 and whose
 * turn count is above one: the seat ran, and then the run broke (a server error in the middle of a response). Everything else that
 * ends in an error is a refusal or a run nothing is known about, and gets no follow-up turn.
 */
function brokeAfterWork(result, apiErrors, costUsd) {
  if (!result || refusalOf(result, apiErrors).refused) return false;
  const turns = result.num_turns;
  return typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0 && typeof turns === "number" && Number.isFinite(turns) && turns > 1;
}
/** why an error result is an error, in one line. worked: brokeAfterWork() said so — it is then worded as an error, never as a refusal */
function errorResultReason(result, apiErrors, worked) {
  const codes = [...new Set(apiErrors)], st = result.api_error_status, launcherSaid = result.subtype === "success" && result.is_error === true;
  const what = [...codes, typeof st === "number" ? "HTTP " + st : null].filter(Boolean).join(", ");
  const text = one(typeof result.result === "string" ? result.result : Array.isArray(result.errors) ? result.errors.join("; ") : "").slice(0, 160);
  if (worked === true) return `the run ended with an error after it had worked (${[what, launcherSaid ? null : one(result.subtype) || "no subtype"].filter(Boolean).join(", ") || "the launcher reported an error"})${text ? ": " + text : ""}`;
  if (codes.length || (typeof st === "number" && st >= 400) || launcherSaid) return `the request was refused (${what || "the launcher reported an error"})${text ? ": " + text : ""}`;
  return `the run ended with an error (${one(result.subtype) || "no subtype"})${text ? ": " + text : ""}`;
}

/**
 * THE RUN'S OWN WALL-CLOCK LIMIT, in milliseconds: the launch's minutes (the seat's 12, 15 or 18; 6 for a follow-up turn) — and never
 * past the trial's end, whatever time was lost between the check and the start. untilEndMs: what is left until the trial's end (below
 * zero = it has passed: a limit of zero, never a negative one) · overrideMs: a selftest's own limit in place of the minutes.
 * -> { ms, endFirst }   endFirst: the trial's end comes before the launch's own limit, so the end is what stops it
 */
function timeLimit(minutes, untilEndMs, overrideMs) {
  const ownMs = overrideMs != null ? overrideMs : minutes * 60000, toEndMs = Math.max(0, untilEndMs), endFirst = !(toEndMs >= ownMs);
  return { ms: endFirst ? toEndMs : ownMs, endFirst };
}

/**
 * Run ONE launch of ONE seat. Never throws; runs the SDK at most once.
 * o: { seat, prompt, budget, minutes, model, resume, session, root, env, now, sdk, timeoutMs, graceMs }
 *    sdk — the SDK's entry point BY INJECTION: { query } or a function returning it (every test passes a fake); left out, the pinned
 *    package of this folder is loaded.
 * -> the envelope: { type: "result", subtype, is_error, result, total_cost_usd, num_turns, session_id, seatSdk: { launcher, outcome,
 *    reason, limit, runId, seat, session, exit, canFollowUp, timedOut, costReported, costCountedUsd, capUsd, budgetUsd, sealedDelta,
 *    sdkVersion, key, stderr, ms, ledger } }
 */
async function runSeat(o) {
  const root = path.resolve((o && o.root) || HERE_ROOT), env = (o && o.env) || process.env, now = (o && o.now) || Date.now;
  const t0 = now(), ownDay = etDay(t0), seat = one(o && o.seat).slice(0, 60);
  // the label handed over is used only when it is this night's; a label that is refused never reaches the ledger as a session
  const labelGiven = o && o.session != null && o.session !== "" ? o.session : null, labelBad = labelGiven == null ? null : sessionProblem(labelGiven, ownDay);
  const session = labelGiven != null && !labelBad ? labelGiven : ownDay;
  let AC = null, R = redactor(null, {}), ledgerNote = null;
  const base = { launcher: LEDGER.LAUNCHER, seat, session };
  /** write the ledger row, build the envelope: every string of both has each credential value replaced first */
  const close = (row, env0, extra) => {
    if (row) { try { LEDGER.append(root, R.deep(row), now()); } catch (e) { ledgerNote = `the ledger row could not be written (${(e && e.code) || "error"})`; } }
    const sx = { ...base, ...extra, ms: now() - t0, ledger: ledgerNote || "written" };
    if (ledgerNote && sx.reason) sx.reason = `${sx.reason}; ${ledgerNote}`;
    return R.deep({ type: "result", ...env0, seatSdk: sx });
  };
  const notStarted = (reason) => close({ kind: "not-started", session, seat, outcome: "UNKNOWN", reason, countedUsd: 0 },
    { subtype: "not_started", is_error: true, result: reason, total_cost_usd: 0, num_turns: 0, session_id: null },
    { outcome: "UNKNOWN", reason, exit: EXIT.notStarted, canFollowUp: false, timedOut: false, costReported: true, costCountedUsd: 0, sealedDelta: 0 });
  const refused = (chk) => close({ kind: "refused", session, seat, outcome: "REFUSED", limit: chk.limit, reason: chk.reason, figures: chk.figures || {}, countedUsd: 0 },
    { subtype: "refused", is_error: true, result: chk.reason, total_cost_usd: 0, num_turns: 0, session_id: null },
    { outcome: "REFUSED", reason: chk.reason, limit: chk.limit, exit: EXIT.refused, canFollowUp: false, timedOut: false, costReported: true, costCountedUsd: 0, sealedDelta: 0 });

  try {
    // 1. the house's allow-list and redaction: without them nothing is started
    try { AC = houseLib(root); if (typeof AC.childEnv !== "function" || typeof AC.credValues !== "function") throw new Error("not the adapter"); }
    catch { AC = null; return notStarted("backend/lib/agent-cli.js (the house's environment allow-list and redaction) could not be loaded: not started"); }
    R = redactor(AC, env);
    // 2. the arguments: the seat, and nothing wider than its own cap, minutes and model
    const T = S.seatOf(seat);
    if (!T) return notStarted(`${JSON.stringify(seat)} is not one of the six seats`);
    if (labelBad) return notStarted(`the session label handed over (${one(R.text(JSON.stringify(String(labelGiven)))).slice(0, 60)}) ${labelBad}: not started — another label would open another night's cap and another seat cap on the same evening`);
    const prompt = o.prompt, budget = Number(o.budget), minutes = Number(o.minutes), model = o.model || null, resume = o.resume || null;
    if (typeof prompt !== "string" || !prompt.trim()) return notStarted("no prompt was handed over");
    if (!(budget > 0) || LEDGER.micro(budget) > LEDGER.micro(T.budget)) return notStarted(`the cap handed over (${JSON.stringify(o.budget)}) is not within this seat's cap of $${T.budget.toFixed(2)}`);
    if (!(minutes > 0) || minutes > T.minutes) return notStarted(`the minutes handed over (${JSON.stringify(o.minutes)}) are not within this seat's ${T.minutes}`);
    if (model !== T.model) return notStarted(`the model handed over (${JSON.stringify(model)}) is not this seat's (${JSON.stringify(T.model)})`);
    if (resume != null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(String(resume))) return notStarted("the session id to resume is not a session id");
    // 3. the switch: this seat must be on the SDK path, by a file that validates
    const P = PROVIDER.read(root);
    if (PROVIDER.route(P, seat) !== "sdk") return refused({ limit: "switch", reason: `${PROVIDER.REL} does not put ${seat} on the SDK path (${P.state === "ok" ? `provider "${P.provider}"${P.seats ? ", seats " + P.seats.join(", ") : ""}` : P.state === "absent" ? "the file is absent" : "the file is unreadable: " + P.why})` });
    // 4. the limits, from the ledger, BEFORE anything is loaded or started
    //    (the launch's own minutes go in: a launch that would not be over by the trial's end is refused, not cut short)
    //    (the floor goes in: no launch on a remainder of the seat's cap that one turn would pass · the wave's own history goes in: a
    //    ledger that is gone, or older than the history, is not read as "nothing spent")
    const limits = PROVIDER.limitsOf(P), chk = LEDGER.check({ led: LEDGER.read(root), session, seat, seatCapUsd: budget, limits, nowMs: now(), minutes, minLaunchUsd: LEDGER.MIN_LAUNCH_USD, witness: LEDGER.witness(root) });
    if (!chk.ok) return refused(chk);
    const budgetUsd = chk.budgetUsd, endMs = Date.parse(limits.trialEnd + "T00:00:00Z");
    // 5. the key
    const key = loadKey(root, env);
    R = redactor(AC, env);
    if (!key.ok) return notStarted(key.reason);
    // 6. the SDK
    let sdk;
    try { sdk = o.sdk ? (typeof o.sdk === "function" ? await o.sdk() : o.sdk) : await loadSdk(env); if (!sdk || typeof sdk.query !== "function") throw new Error("no query() entry point"); }
    catch (e) { return notStarted(`the SDK failed to load: ${one(R.text(e && e.message)).slice(0, 200)}`); }
    // 7. the seat definition (the launcher loads it itself; the runner reads the two lines it holds the run to)
    let def; try { def = S.readDefinition(root, seat); } catch (e) { return notStarted(`the seat definition cannot be used: ${one(R.text((e && (e.code || e.message)) || e)).slice(0, 160)}`); }
    const tier = model || def.model || null;
    // 8. the launcher's environment: the house allow-list, plus the one key BY NAME
    const ce = AC.childEnv({ env: { [KEY_NAME]: [KEY_NAME] }, envPlain: ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH"] }, env).env;
    if (!ce[KEY_NAME]) return notStarted("the launcher's environment could not be given the key: not started");
    ce.CLAUDE_AGENT_SDK_CLIENT_APP = CLIENT_APP;
    // asks the launcher to keep the key out of the commands the seat runs. NOT VERIFIED in this build, and the SDK's typings do not name
    // the variable: the morning after an SDK night, docs/seat-sdk-trial/2026-10-12/key-check.cjs looks for the key's value in what the
    // seats wrote (their claims, their output files, the ledger, the wave's own files) and prints file names and counts only
    ce.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
    // 9. reserve the seat's full cap in the ledger BEFORE the run: a run that never reports back stays counted at the cap
    const runId = `${session}.${seat}.${t0.toString(36)}.${crypto.randomBytes(3).toString("hex")}`, sealedBefore = countSealed(root, seat, session);
    try { LEDGER.append(root, R.deep({ kind: "start", runId, session, seat, capUsd: budget, budgetUsd, reservedUsd: budget, model: tier, resume: !!resume, sdkVersion: sdk.version || null, minutes }), now()); }
    catch (e) { return close(null, { subtype: "not_started", is_error: true, result: "the spend ledger cannot be written: not started", total_cost_usd: 0, num_turns: 0, session_id: null },
      { outcome: "UNKNOWN", reason: `the spend ledger cannot be written (${(e && e.code) || "error"}): not started, so nothing is spent that the limits cannot see`, exit: EXIT.notStarted, canFollowUp: false, timedOut: false, costReported: true, costCountedUsd: 0, sealedDelta: 0 }); }

    // 10. the run — once
    // the run's own time limit: the seat's minutes — and never past the trial's end, whatever time was lost between the check and here
    const ac = new AbortController(), { ms: minutesMs, endFirst } = timeLimit(minutes, endMs - now(), o.timeoutMs);
    const graceMs = o.graceMs != null ? o.graceMs : 15000;
    let q = null, init = null, initBad = null, result = null, stopWhy = null, timedOut = false, thrown = null, stderrBuf = "", hard = null, timer = null, graceTimer = null;
    const apiErrors = [], gaveUp = new Promise((res) => { hard = res; });
    const stop = (why) => {
      if (!stopWhy) stopWhy = why;
      try { ac.abort(); } catch { /* already */ }
      try { if (q && typeof q.close === "function") q.close(); } catch { /* already */ }
      if (!graceTimer) graceTimer = setTimeout(() => hard("gave-up"), graceMs);   // a launcher that does not end after it was stopped is not waited on
    };
    const options = {
      cwd: root, agent: seat,                                                     // = cwd and --agent
      permissionMode: S.PERMISSION_MODE, allowDangerouslySkipPermissions: true,   // = --permission-mode bypassPermissions
      maxTurns: S.MAX_TURNS, maxBudgetUsd: budgetUsd,                             // = --max-turns 60 --max-budget-usd
      ...(model ? { model } : {}), ...(resume ? { resume: String(resume) } : {}), // = --model / --resume
      settingSources: ["user", "project", "local"],                               // what the command line loads by default (the seat definition is a project file)
      systemPrompt: { type: "preset", preset: "claude_code" },                    // the command line's own system prompt, as when no flag changes it
      tools: [...def.tools], strictMcpConfig: true,                               // no wider: the definition's tool list, and no MCP server at all
      env: ce, abortController: ac,
      stderr: (d) => { stderrBuf = (stderrBuf + String(d)).slice(-65536); },
    };
    timer = setTimeout(() => { timedOut = true; stop(endFirst ? `the trial's end (${limits.trialEnd} 00:00 UTC) came before the run was over: the run was stopped` : `no result within ${minutes} minute(s): the run was stopped`); }, minutesMs);
    const iterate = (async () => {
      q = sdk.query({ prompt, options });
      for await (const raw of q) {
        if (!raw || typeof raw !== "object") continue;
        const m = R.deep(raw);   // REPLACE FIRST, CUT SECOND: every text of a message has each credential value replaced before anything is cut from it
        if (m.type === "system" && m.subtype === "init" && !init) { init = m; initBad = initProblem(m, { root, def, tier }); if (initBad) { stop(initBad); break; } }
        else if (m.type === "assistant" && m.error) apiErrors.push(one(m.error).slice(0, 40));
        else if (m.type === "result") { result = m; break; }
      }
    })().catch((e) => { thrown = e; });
    await Promise.race([iterate, gaveUp]);
    clearTimeout(timer); clearTimeout(graceTimer);
    try { if (q && typeof q.close === "function") q.close(); } catch { /* already */ }

    // 11. what happened
    const sealedDelta = countSealed(root, seat, session) - sealedBefore;
    const clean = !!result && result.subtype === "success" && result.is_error !== true;
    const capped = !!result && (result.subtype === "error_max_turns" || result.subtype === "error_max_budget_usd");
    // a cost counts as reported only when it is a number of dollars at or above zero — and a ZERO is believed for one kind of result
    // only: a request that was refused (subtype "success" with is_error true: nothing ran). Every other result's zero is not a cost
    // ("crash/startup-error results may carry zeroed values", and the turn count they carry may be zeroed with it).
    const c = result ? result.total_cost_usd : undefined;
    const refusedRequest = !!result && result.subtype === "success" && result.is_error === true;
    const costIsNumber = typeof c === "number" && Number.isFinite(c) && c >= 0, zeroNotBelieved = costIsNumber && c === 0 && !refusedRequest;
    const costOk = costIsNumber && !zeroNotBelieved;
    const counted = costOk ? c : budget;                                          // not reported = UNKNOWN = the seat's FULL cap
    const verified = !!init && !initBad;                                          // a session whose start-of-session check failed is never OK, whatever else happened to it
    const sessionId = (result && result.session_id) || (init && init.session_id) || null;
    // an error result is a refusal, or a run that broke after it had worked: only the second may have the seat's one follow-up turn.
    // (`worked` is read in two places, both reached by an error result only: its reason, and the follow-up turn of a failure)
    const errored = !!result && !clean && !capped, worked = brokeAfterWork(result, apiErrors, c);
    let failure = null;
    if (initBad) failure = initBad;
    else if (stopWhy && !result) failure = stopWhy;
    else if (thrown && !result) failure = `the SDK call failed: ${one(R.text((thrown && thrown.message) || thrown)).slice(0, 200)}`;
    else if (!result) failure = "the run ended without a result";
    else if (errored) failure = errorResultReason(result, apiErrors, worked);
    else if (!init) failure = "the launcher sent no start-of-session report: the key source, the model and the tools were not checked";
    let outcome, reason, canFollowUp = false;
    if (verified && sealedDelta >= 1) { outcome = "OK"; reason = null; }
    // the one follow-up turn after an error: the run had worked (so there is an error result, with its cost), the session was checked as
    // the seat's (so the failure is that error and no failed check), and there is a session to resume
    else if (failure) { outcome = "UNKNOWN"; reason = failure; canFollowUp = worked && verified && !!sessionId; }
    else { outcome = "UNKNOWN"; reason = `the seat ended without its sealed output${capped ? ` (${result.subtype})` : ""}`; canFollowUp = costOk; }
    if (!costOk) reason = `${reason ? reason + "; " : ""}${zeroNotBelieved ? "the SDK reported $0 for a run that was not a refused request, which is not believed" : "the SDK reported no cost for this run"}: recorded as UNKNOWN and counted at the seat's full cap of $${budget.toFixed(2)}`;
    const ms = now() - t0;
    try {
      LEDGER.append(root, R.deep({ kind: "end", runId, session, seat, outcome, reason, cost: costOk ? c : "UNKNOWN", costReportedUsd: costOk ? c : null, countedUsd: counted, capUsd: budget, budgetUsd,
        turns: result && Number.isFinite(Number(result.num_turns)) ? Number(result.num_turns) : null, sessionId, subtype: result ? one(result.subtype).slice(0, 60) : null, isError: result ? result.is_error === true : null,
        timedOut, sealedDelta, resume: !!resume, model: tier, sdkVersion: sdk.version || null, init: initRecord(init, { root, def, seat }), key: { present: true, length: key.length, from: key.source }, ms }), now());
    } catch (e) { ledgerNote = `the ledger's end row could not be written (${(e && e.code) || "error"}): the start row's reservation of the full cap stands`; }
    return close(null, {
      subtype: result ? result.subtype : timedOut ? "timeout" : "no_result", is_error: !clean,
      result: result && typeof result.result === "string" ? result.result : (reason || ""),
      total_cost_usd: costOk ? c : null, num_turns: result && result.num_turns != null ? result.num_turns : null, session_id: sessionId,
    }, { outcome, reason, runId, exit: clean ? EXIT.clean : EXIT.error, canFollowUp, timedOut, costReported: costOk, costCountedUsd: counted, capUsd: budget, budgetUsd, sealedDelta,
      sdkVersion: sdk.version || null, key: { present: true, length: key.length, from: key.source }, stderr: R.text(stderrBuf).slice(-600), stopped: !!stopWhy });
  } catch (e) {
    // the runner itself broke: said as such, redacted, never thrown on. A start row already written keeps its reservation.
    const reason = `the runner failed: ${one(R.text((e && e.message) || e)).slice(0, 200)}`;
    return close(null, { subtype: "runner_error", is_error: true, result: reason, total_cost_usd: null, num_turns: null, session_id: null },
      { outcome: "UNKNOWN", reason, exit: EXIT.notStarted, canFollowUp: false, timedOut: false, costReported: false, costCountedUsd: null, sealedDelta: 0 });
  }
}

/** READ-ONLY: what the SDK path would do now -> lines. The key is checked on a COPY of the environment: presence and length only. */
function status({ root = HERE_ROOT, env = process.env, now = Date.now() } = {}) {
  const P = PROVIDER.read(root), L = PROVIDER.limitsOf(P), led = LEDGER.read(root), seen = LEDGER.witness(root), session = etDay(now), out = [];
  const gone = led.state === "unreadable" || seen.state !== "ok" ? [] : LEDGER.lost(led.rows, seen.launches);
  out.push(`SEAT-SDK STATUS — session ${session} (ET) — ${new Date(now).toISOString()}`);
  out.push(`  switch ${PROVIDER.REL}: ${P.state === "absent" ? "ABSENT: every seat on the command line (the default)" : P.state === "unreadable" ? `UNREADABLE (${P.why}): every seat on the command line (the default)` : `provider "${P.provider}"${P.seats ? ", seats " + P.seats.join(", ") : P.provider === "sdk" ? ", every seat" : ""}`}`);
  out.push(`  limits: $${L.nightCapUsd.toFixed(2)} a night · $${L.trialCapUsd.toFixed(2)} for the trial · the SDK path refuses from ${L.trialEnd} 00:00 UTC, and a launch whose minutes would not be over by then${now >= Date.parse(L.trialEnd + "T00:00:00Z") ? "  <-- THE TRIAL HAS ENDED" : ""}`);
  const sum = LEDGER.summary(root);
  out.push(`  ledger ${LEDGER.REL}: ${gone.length ? `MISSING AFTER THE TRIAL BEGAN — ${led.state === "absent" ? "the file is not there" : "it holds no run for them"}, and ${LEDGER.WITNESS_REL} shows SDK spend on ${gone.length} seat-night(s): every SDK seat would be REFUSED` : seen.state === "unreadable" ? `it cannot be held against the wave's history (${seen.why}): every SDK seat would be REFUSED` : led.state === "absent" ? "absent (nothing spent yet)" : led.state === "unreadable" ? `UNREADABLE (${led.why}): every SDK seat would be REFUSED` : `${led.rows.length} row(s) · counted in the trial $${sum.trialCountedUsd.toFixed(2)} · tonight $${(LEDGER.spend(led.rows, { session, seat: "" }).night / 1e6).toFixed(2)} · runs with an unknown cost ${sum.unknownCostRuns}`}`);
  for (const s of S.SEATS) {
    const via = PROVIDER.route(P, s.seat);
    if (via !== "sdk") { out.push(`  ${s.seat.padEnd(22)} command line`); continue; }
    const c = LEDGER.check({ led, session, seat: s.seat, seatCapUsd: s.budget, limits: L, nowMs: now, minutes: s.minutes, minLaunchUsd: LEDGER.MIN_LAUNCH_USD, witness: seen });
    out.push(`  ${s.seat.padEnd(22)} SDK · cap $${s.budget.toFixed(2)} · ${c.ok ? `would start with $${c.budgetUsd.toFixed(2)}` : `would be REFUSED (${c.limit}): ${c.reason}`}`);
  }
  const copy = { ...env }; let AC = null; try { AC = houseLib(root); } catch { AC = null; }
  const k = loadKey(root, copy);
  // the last launch on the SDK path: what the launcher reported when the session started (the first night's check of the instrument)
  const lastEnd = led.state === "ok" ? [...led.rows].reverse().find((r) => r.kind === "end") : null;
  if (lastEnd) {
    const i = lastEnd.init || null;
    out.push(`  last SDK launch: ${lastEnd.seat} · session ${lastEnd.session} · ${lastEnd.outcome}${lastEnd.reason ? " (" + one(lastEnd.reason).slice(0, 140) + ")" : ""} · cost ${lastEnd.cost === "UNKNOWN" ? "UNKNOWN, counted $" + Number(lastEnd.countedUsd).toFixed(2) : "$" + Number(lastEnd.countedUsd).toFixed(2)} · sealed ${lastEnd.sealedDelta == null ? "?" : lastEnd.sealedDelta}`);
    out.push(i ? `    the launcher reported: key source ${i.keySource} · model ${i.model} · Claude Code ${i.claudeCodeVersion} · permission mode ${i.permissionMode} · in the repo root ${i.cwdIsRoot} · tools ${(i.tools || []).join(", ") || "none listed"} · beyond the seat definition ${i.toolsBeyondDefinition} · MCP servers ${i.mcpServers} · the seat in its agent list ${i.seatListed}`
      : "    the launcher sent no start-of-session report for it");
  }
  out.push(`  key ${KEY_NAME}: ${k.ok ? `present (${k.source}), length ${k.length}` : "NOT USABLE — " + redactor(AC, copy).text(k.reason)}`);
  const info = sdkInfo();
  out.push(`  SDK ${SDK_NAME}: pinned ${info.pinned || "?"} · installed ${info.installed || "none"}${info.pkg && info.pkg.claudeCodeVersion ? ` (it carries Claude Code ${info.pkg.claudeCodeVersion})` : ""}${info.problem ? " — PROBLEM: " + info.problem : ""}`);
  let wave = null; try { wave = fs.readFileSync(path.join(root, "automation", "seat-wave.cjs"), "utf8"); } catch { wave = null; }
  out.push(`  automation/seat-wave.cjs: ${wave == null ? "cannot be read" : wave.includes("seat-sdk/wave-hook.cjs") ? "reads the switch (the staged edit is applied)" : "does NOT read the switch yet (the staged edit is not applied): every seat runs on the command line"}`);
  if (wave != null) { const d = S.driftFrom(wave); out.push(`  the seat table here against the wave's: ${d.length ? "DIFFERS — " + d.join("; ") : "equal"}`); }
  out.push("  nothing was started, nothing was written.");
  return out;
}

module.exports = { runSeat, status, loadKey, loadSdk, sdkInfo, pinnedVersion, redactor, initProblem, initRecord, tierMatches, normPath, countSealed, errorResultReason, refusalOf, brokeAfterWork, BREAK_CODES, sessionProblem, dayBefore, timeLimit, SDK_NAME, KEY_NAME, SEAL_ENV, MIN_KEY_CHARS, EXIT, HERE_ROOT };

// ── the command ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const a = process.argv.slice(2), val = (k) => { const i = a.indexOf(k); return i >= 0 && i + 1 < a.length ? a[i + 1] : null; };
  /** the ONE line this command prints, written synchronously so it is out before the process ends */
  const emit = (env0) => { try { fs.writeSync(1, JSON.stringify(env0) + "\n"); } catch { /* the reader is gone */ } };
  if (a.length === 1 && a[0] === "--status") { for (const l of status()) console.log(l); process.exit(0); }
  if (!val("--seat") || !val("--budget") || !val("--minutes")) {
    console.log("usage: node automation/seat-sdk/run-seat.cjs --seat <seat> --budget <usd> --minutes <n> [--model <m>] [--resume <id>] [--session YYYY-MM-DD]   (the prompt on standard input)\n       node automation/seat-sdk/run-seat.cjs --status\nNothing was done.");
    process.exit(2);
  }
  process.exitCode = EXIT.notStarted;   // failing until the run has returned: a runner that ends early is never read as a clean run
  // whatever the SDK leaves behind after its run was stopped must not print a stack of its own
  process.on("unhandledRejection", () => {}); process.on("uncaughtException", (e) => { emit({ type: "result", subtype: "runner_error", is_error: true, result: "the runner failed", total_cost_usd: null, num_turns: null, session_id: null, seatSdk: { launcher: LEDGER.LAUNCHER, seat: one(val("--seat")).slice(0, 60), outcome: "UNKNOWN", reason: `the runner failed (${one(e && e.name).slice(0, 40) || "error"})`, exit: EXIT.notStarted, canFollowUp: false, timedOut: false, costReported: false } }); process.exit(EXIT.notStarted); });
  const chunks = [];
  process.stdin.on("data", (b) => chunks.push(b));
  process.stdin.on("error", () => {});
  process.stdin.on("end", async () => {
    const out = await runSeat({ seat: val("--seat"), budget: Number(val("--budget")), minutes: Number(val("--minutes")), model: val("--model") || null, resume: val("--resume") || null, session: val("--session") || undefined, prompt: Buffer.concat(chunks).toString("utf8") });
    emit(out);
    const code = out && out.seatSdk && Number.isInteger(out.seatSdk.exit) ? out.seatSdk.exit : EXIT.notStarted;
    // a run that was stopped (a failed start-of-session check, a timeout) may have left the launcher's process behind: end the whole tree
    if (out && out.seatSdk && out.seatSdk.stopped && process.platform === "win32") { try { cp.spawnSync("taskkill", ["/pid", String(process.pid), "/T", "/F"], { windowsHide: true, timeout: 15000, stdio: "ignore" }); } catch { /* ends below */ } }
    process.exit(code);
  });
}
