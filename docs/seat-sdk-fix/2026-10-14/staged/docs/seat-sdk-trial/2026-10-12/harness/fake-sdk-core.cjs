"use strict";
/**
 * SEAT-SDK TRIAL — THE SELFTEST'S FAKE. A stand-in for the Agent SDK's entry point (query) and for the command line's output. It makes
 * no network call and starts no process: it yields the messages a behaviour describes and records what it was asked. Nothing outside
 * the selftest loads this file (the runner refuses a package that says it is a fake unless TRAIDS_SEAT_SDK_SELFTEST=1).
 *
 * A BEHAVIOUR (all fields optional):
 *   seal: true                 append one sealed claim for the seat to the claims file (what a real seat does through backend/seal-claim.js)
 *   result: { ... } | false    fields laid over the default result message; false = no result message at all
 *   costMissing: true          the result carries no total_cost_usd
 *   init: { ... } | false      fields laid over the default start-of-session report; false = none is sent
 *   assistantError: "<code>"   an assistant message carrying an API error code, before the result
 *   throwBefore / throwMid     throw this text before the first message / after the start-of-session report
 *   hang: true | "forever"     wait until the run is stopped (true: then end as a stopped run does; "forever": never end)
 *   sealFirst: true            append the sealed claim BEFORE the start-of-session report (a launcher that acts before it reports)
 *   stuck: true                never finish closing: the run does not end even after it was stopped or its messages were all read
 *   stderr / rawStderr / rawStdout   text for the stderr callback / written straight to the process's own stderr / stdout
 *   in every text "{{KEY}}" becomes the key the fake was handed (the leak attempts of the secrecy check)
 *
 * THE START-OF-SESSION REPORT is the one the real launcher sends (seat-sdk-fix 2026-10-14, measured by its no-spend probe of Claude Code
 * 2.1.227, docs/seat-sdk-fix/2026-10-14/NOTES.md): key source "ANTHROPIC_API_KEY" when the key is in the launcher's environment by name,
 * and permission mode "default" whenever CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is on (1/true/yes/on) in that environment, whatever mode was
 * asked for; without the variable, the mode asked for. A behaviour's `init` fields are laid over it as before.
 */
const fs = require("fs"), crypto = require("crypto");
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const KNOWN = ["cwd", "agent", "permissionMode", "allowDangerouslySkipPermissions", "maxTurns", "maxBudgetUsd", "model", "resume", "settingSources", "systemPrompt", "tools", "strictMcpConfig", "canUseTool", "env", "abortController", "stderr"];
/** the launcher's own rule (NOTES.md of seat-sdk-fix 2026-10-14): the scrub variable on forces "default" */
const scrubOn = (env) => /^(1|true|yes|on)$/i.test(String((env && env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB) == null ? "" : env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).trim());
const fill = (v, key) => (typeof v === "string" ? v.split("{{KEY}}").join(key == null ? "" : String(key)) : v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, key)])) : v);

/** the behaviour of a seat's n-th launch (0-based) under a script { seats: { "<seat>": [behaviour, ...] }, default: behaviour } */
function behaviourFor(script, seat, n) {
  const list = script && script.seats && script.seats[seat];
  if (Array.isArray(list) && list.length) return list[Math.min(n, list.length - 1)] || {};
  return (script && script.default) || {};
}
/** the result message of a launch: the SAME object for the fake SDK and for the fake command line ("the same fake output") */
function resultOf(B, seat, n, key) {
  if (B.result === false) return null;
  const r = { type: "result", subtype: "success", is_error: false, result: `fake ${seat} done`, total_cost_usd: 0.5, num_turns: 3, session_id: `sess-${seat}-${n}`, duration_ms: 1, ...fill(B.result || {}, key) };
  if (B.costMissing) delete r.total_cost_usd;
  return r;
}
/** what a real seat does through backend/seal-claim.js, reduced to the two fields the wave counts */
function appendClaim(claimsFile, seat, session) { fs.appendFileSync(claimsFile, JSON.stringify({ seat, session, kind: "selftest", sealedAt: "fake" }) + "\n"); }

/**
 * the fake query(). o: { script | behaviour(seat, n), record(row), claimsFile, session }
 * record rows: what the SDK was asked (never a key: its length and a hash only), and { closed } when the run was closed.
 */
function makeQuery(o) {
  const launches = new Map();
  let calls = 0;
  const query = ({ prompt, options }) => {
    const opt = options || {}, seat = opt.agent, call = ++calls;
    const n = typeof o.launchIndex === "function" ? o.launchIndex(seat) : (launches.get(seat) || 0); launches.set(seat, n + 1);
    const B = (typeof o.behaviour === "function" ? o.behaviour(seat, n) : behaviourFor(o.script, seat, n)) || {};
    const env = opt.env || {}, key = env.ANTHROPIC_API_KEY, sessionId = `sess-${seat}-${n}`;
    o.record({ call, seat, launch: n, promptSha: sha(prompt), promptChars: String(prompt).length, cwd: opt.cwd, agent: opt.agent, permissionMode: opt.permissionMode, allowDangerouslySkipPermissions: opt.allowDangerouslySkipPermissions,
      maxTurns: opt.maxTurns, maxBudgetUsd: opt.maxBudgetUsd, model: opt.model === undefined ? null : opt.model, resume: opt.resume === undefined ? null : opt.resume, settingSources: opt.settingSources, systemPrompt: opt.systemPrompt,
      tools: opt.tools, strictMcpConfig: opt.strictMcpConfig, envNames: Object.keys(env).sort(), keyChars: key ? String(key).length : 0, keySha: key ? sha(key) : null, hasAbort: !!opt.abortController, hasStderr: typeof opt.stderr === "function",
      unknownOptions: Object.keys(opt).filter((k) => !KNOWN.includes(k)) });
    const gen = (async function* () { try {
      if (B.throwBefore) throw new Error(fill(B.throwBefore, key));
      if (B.sealFirst) appendClaim(o.claimsFile, seat, o.session);
      if (B.stderr && typeof opt.stderr === "function") opt.stderr(fill(B.stderr, key));
      if (B.rawStderr) process.stderr.write(fill(B.rawStderr, key) + "\n");
      if (B.rawStdout) process.stdout.write(fill(B.rawStdout, key) + "\n");
      if (B.init !== false) yield { type: "system", subtype: "init", apiKeySource: key ? "ANTHROPIC_API_KEY" : "none", cwd: opt.cwd, tools: Array.isArray(opt.tools) ? [...opt.tools] : [], mcp_servers: [], model: `claude-${opt.model || "sonnet"}-fake-1`, permissionMode: scrubOn(env) ? "default" : opt.permissionMode,
        slash_commands: [], output_style: "default", skills: [], plugins: [], agents: [seat, "general-purpose"], claude_code_version: "0.0.0-fake", uuid: "u-init", session_id: sessionId, ...fill(B.init || {}, key) };
      if (B.assistantError) yield { type: "assistant", error: B.assistantError, message: { content: [] }, parent_tool_use_id: null, uuid: "u-a", session_id: sessionId };
      if (B.seal) appendClaim(o.claimsFile, seat, o.session);
      if (B.hang) {
        const sig = opt.abortController && opt.abortController.signal;
        await new Promise((res) => { if (sig) { if (sig.aborted) res(); else sig.addEventListener("abort", res); } });
        if (B.hang === "forever") await new Promise(() => {});
        throw Object.assign(new Error("the run was stopped"), { name: "AbortError" });
      }
      if (B.throwMid) throw new Error(fill(B.throwMid, key));
      const r = resultOf(B, seat, n, key); if (r) yield r;
    } finally { if (B.stuck) await new Promise(() => {}); } })();
    gen.close = () => { o.record({ call, seat, closed: true }); };
    gen.interrupt = async () => undefined;
    return gen;
  };
  return query;
}

/** the entry of the fake PACKAGE (a child process of the patched wave): everything comes from the script file named in the environment */
function fromEnv(env = process.env) {
  const file = env.SEAT_SDK_FAKE_SCRIPT; if (!file) throw new Error("the fake SDK was loaded without SEAT_SDK_FAKE_SCRIPT");
  const script = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = () => { try { return fs.readFileSync(script.sdkRecord, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return makeQuery({ script, claimsFile: script.claims, session: script.session, record: (row) => fs.appendFileSync(script.sdkRecord, JSON.stringify(row) + "\n"),
    // every launch is its own process: a seat's launch number is the number of launches of it already recorded
    launchIndex: (seat) => rows().filter((r) => r.seat === seat && !r.closed).length });
}

module.exports = { makeQuery, fromEnv, behaviourFor, resultOf, appendClaim, fill, sha, KNOWN };
