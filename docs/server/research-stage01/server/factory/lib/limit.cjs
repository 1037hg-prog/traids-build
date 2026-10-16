"use strict";
/**
 * LIMIT — classify one `claude -p --output-format json` run. 2026-10-06 (research engine, stage 0).
 *
 *   classify({ exitCode, signal, stdout, stderr, timedOut, nowMs, tz }) ->
 *     { class, kind, attempt, line, resetAt, parkUntil, result }
 *   class      ok            the run finished normally (exit 0, a result object, is_error false)
 *              usage-limit   the PLAN's limit (5-hour / weekly / Opus / extra usage): park EVERY launch until reset + jitter; the cut
 *                            is NOT an attempt (attempt=false)
 *              auth-failed   the token is expired / revoked / wrong kind, or the CLI is billing an API key: STOP, alert (attempt=false)
 *              error         anything else: budget stop, max turns, transient 5xx/overload/network, timeout, no JSON, unknown (attempt=true)
 *   kind       usage-limit: session | weekly | opus | extra | unknown;  error: budget | max_turns | transient | timeout | no-json | unknown
 *   resetAt    ISO, parsed from the message (Intl, never the shell clock): "resets 8:50pm (America/Denver)", "Resets 3:00 PM",
 *              "resets Mon 9am", "resets Oct 9, 5pm", "...|1759999999", or a JSON resetsAt epoch; the NEXT occurrence after nowMs
 *   parkUntil  resetAt + 2-5 min jitter; an unparseable reset parks 60 min (then the caller backs off)
 *
 * WHERE THE PATTERNS COME FROM. LIMIT_RE is the pending seat-wave port's (automation/seat-wave.pending-server.cjs:137-171) with the
 * four defects named in docs/server/RESEARCH-FACTORY-SPEC-2026-10-02.md fixed: (1) a limit is never "completed" — the caller parks
 * and re-queues; (2)/(3) are argv issues handled in claude-run.cjs (no node eval, strict empty MCP); (4) the reset time is parsed here.
 * Added: the claude.ai wording ("Usage limit reached ∙ Resets 3:00 PM ∙ [limits shared with Claude Code]"), the JSON shape the CLI
 * records on a limit ("error":"rate_limit", apiErrorStatus 429, quotaLimits.resetsAt), auth and transient classes. The corpus
 * (limit-corpus.json) holds the lines actually seen in this machine's transcripts (CLI 2.1.261) and the documented older forms.
 *
 * GATING (why prose never trips it). A scout's own text can say "position limit reached" or quote a 401. A limit/auth pattern counts
 * only when the run did not end normally (exit != 0, is_error true, or no result object), or — limits only — when the whole result is
 * one short line in the CLI's shape (it always says when it resets, or carries an epoch).
 */

const LIMIT_RE = [
  /you(?:'|’)?ve hit your\b[^\n]{0,40}?\blimit\b/i,
  /\bclaude(?: ai)? usage limit reached\b/i,
  /\b(?:5-hour|five-hour|weekly|opus|sonnet|fable|usage|session) limit reached\b/i,
  /\bout of extra usage\b/i,
  /\byour limit will reset\b/i,
];
const CLI_SHAPE = /\bresets?\b|\|\d{9,}/i;
const AUTH_RE = [
  /\bAPI Error: 401\b/i, /\bAPI Error: 403\b/i,
  /\bOAuth (?:access )?token (?:has )?(?:expired|been revoked|is invalid)/i, /\binvalid (?:x-api-key|api key|bearer token|oauth token)\b/i,
  /\bauthentication_(?:error|failed)\b/i, /\boauth_org_not_allowed\b/i, /\baccount_on_hold\b/i,
  /\bplease run \/login\b/i, /\bnot logged in\b/i, /\blogin expired\b/i, /\bre-?authenticate to continue\b/i,
  /\bcredit balance is too low\b/i,   // API-key billing wording: on this host it means the CLI is NOT on the subscription token -> STOP
];
const TRANSIENT_RE = [/\bAPI Error: (?:5\d\d|429)\b/i, /\boverloaded(?:_error)?\b/i, /\bECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up\b/i, /\bInternal server error\b/i];
const BUDGET_RE = /\bReached maximum budget\b|\bBudget limit reached\b/i;

/** The CLI's result object from stdout: the whole stdout as JSON, else the last line that parses to {type:"result"}. null if none. */
function parseResult(stdout) {
  const s = String(stdout || "").trim();
  if (!s) return null;
  try { const j = JSON.parse(s); if (j && typeof j === "object" && !Array.isArray(j)) return j; } catch { /* stream / mixed */ }
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) { try { const j = JSON.parse(lines[i]); if (j && j.type === "result") return j; } catch { /* not JSON */ } }
  return null;
}
/** Every JSON object on stdout that carries the CLI's quota record (stream-json / transcript lines). */
function quotaRecords(stdout) {
  const out = [];
  for (const l of String(stdout || "").split(/\r?\n/)) {
    if (!/quotaLimits|rate_limit/.test(l)) continue;
    try { const j = JSON.parse(l); if (j && (j.quotaLimits || j.error === "rate_limit")) out.push(j); } catch { /* skip */ }
  }
  return out;
}

// ── time: wall clock in a zone, via Intl ────────────────────────────────────────────────────────────────────────────────────
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
function validTz(tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }
function partsIn(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: WD[p.weekday] };
}
/** The UTC ms of a wall-clock time in tz (the first one, at a DST fold). */
function wallToUtc(y, mo, d, h, mi, tz) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let g = want;
  for (let i = 0; i < 4; i++) { const p = partsIn(g, tz), got = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi); if (got === want) break; g -= got - want; }
  return g;
}
/** The next occurrence (strictly after nowMs) of h:mi in tz, optionally on weekday wd, or on month/day. */
function nextWall({ h, mi = 0, wd = null, mo = null, d = null }, tz, nowMs) {
  const n = partsIn(nowMs, tz);
  if (mo != null && d != null) {
    for (const y of [n.y, n.y + 1]) { const t = wallToUtc(y, mo, d, h, mi, tz); if (t > nowMs) return t; }
    return null;
  }
  for (let k = 0; k <= 8; k++) {
    const c = new Date(Date.UTC(n.y, n.mo - 1, n.d + k)), cy = c.getUTCFullYear(), cmo = c.getUTCMonth() + 1, cd = c.getUTCDate();
    if (wd != null && c.getUTCDay() !== wd) continue;
    const t = wallToUtc(cy, cmo, cd, h, mi, tz);
    if (t > nowMs) return t;
  }
  return null;
}
const RESET_TEXT = /\b(?:resets?|reset at|will reset at)\s+(?:at\s+)?(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+)?(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;
/** resetAt (ms) from a message line, or null. Epoch forms win; text forms are the next occurrence after nowMs in the stated (or default) zone. */
function resetAtFrom(line, nowMs, tz = "America/Denver") {
  const s = String(line || "");
  const ep = /\|(\d{10})\b/.exec(s); if (ep) return +ep[1] * 1000;
  const m = RESET_TEXT.exec(s); if (!m) return null;
  let h = +m[4]; const mi = m[5] ? +m[5] : 0, ap = m[6] ? m[6].toLowerCase() : null;
  if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap === "pm" ? 12 : 0); } else if (h > 23) return null;
  if (mi > 59) return null;
  const zone = m[7] && validTz(m[7].trim()) ? m[7].trim() : tz;
  const wd = m[1] ? WD[m[1].slice(0, 1).toUpperCase() + m[1].slice(1, 3).toLowerCase()] : null;
  const mo = m[2] ? MON[m[2].slice(0, 1).toUpperCase() + m[2].slice(1, 3).toLowerCase()] : null;
  return nextWall({ h, mi, wd, mo, d: m[3] ? +m[3] : null }, zone, nowMs);
}
function limitKind(line, rec) {
  const s = String(line || "") + " " + (rec && rec.quotaLimits ? String(rec.quotaLimits.rateLimitType || "") : "");
  if (/\bopus\b/i.test(s)) return "opus";
  if (/out of extra usage/i.test(s)) return "extra";
  if (/weekly|seven_day|7_day/i.test(s)) return "weekly";
  if (/session|5-hour|five[-_ ]hour/i.test(s)) return "session";
  return "unknown";
}
const jitterMs = (rng = Math.random) => 120000 + Math.round(rng() * 180000);   // 2-5 min
/**
 * PARK BOUNDS (2026-10-07 review fix). The CLI prints the reset to the minute and the run ends after it, so a stated time can have
 * JUST passed when the child exits ("resets 8:50pm" read at 20:50:05): the "next occurrence" is then a day, a week or (for
 * "Oct 9, 5pm") a year away, and every launch would park silently that long. So: a stated wall time that occurred in the last
 * JUST_PASSED_MS counts as passed (park = now + jitter); a reset farther away than the longest window of its kind is a parse slip
 * (park 60 min and retry, never the far date); a reset in the past parks jitter only.
 */
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const JUST_PASSED_MS = 30 * MIN;
const PARK_MAX_MS = { session: 5 * HOUR + 15 * MIN, weekly: 7 * DAY + 10 * MIN, opus: 7 * DAY + 10 * MIN, extra: 8 * DAY, unknown: 8 * DAY };
/** Pure: { resetMs, parkMs, note } for a limit, from the parsed reset (epoch or text). */
function parkFor({ kind, reset, fromText, line, nowMs, tz, rng }) {
  if (reset != null && fromText) { const prev = resetAtFrom(line, nowMs - JUST_PASSED_MS, tz); if (prev != null && prev <= nowMs) return { resetMs: prev, parkMs: nowMs + jitterMs(rng), note: "the stated reset time has just passed — park 2-5 min only" }; }
  if (reset == null) return { resetMs: null, parkMs: nowMs + 60 * MIN, note: "no reset time could be read — park 60 min, then retry" };
  if (reset <= nowMs) return { resetMs: reset, parkMs: nowMs + jitterMs(rng), note: "the reset time is already past — park 2-5 min only" };
  const max = PARK_MAX_MS[kind] || PARK_MAX_MS.unknown;
  if (reset - nowMs > max) return { resetMs: reset, parkMs: nowMs + 60 * MIN, note: `the parsed reset is ${((reset - nowMs) / HOUR).toFixed(1)} h away, beyond the longest ${kind} window (${(max / HOUR).toFixed(2)} h) — treated as a parse slip: park 60 min, then retry` };
  return { resetMs: reset, parkMs: reset + jitterMs(rng), note: null };
}

/** The classification. Pure (nowMs / tz / rng injected). */
function classify({ exitCode, signal = null, stdout = "", stderr = "", timedOut = false, nowMs = Date.now(), tz = "America/Denver", rng = Math.random } = {}) {
  const res = parseResult(stdout);
  const result = res && typeof res.result === "string" ? res.result : null;
  const isError = res ? res.is_error === true : null;
  const abnormal = exitCode !== 0 || isError === true || !res || signal != null;
  const summary = res ? { subtype: res.subtype || null, is_error: res.is_error ?? null, total_cost_usd: Number.isFinite(res.total_cost_usd) ? res.total_cost_usd : null, num_turns: res.num_turns ?? null, session_id: res.session_id || null } : null;
  const mk = (cls, kind, line, extra = {}) => ({ class: cls, kind, attempt: cls === "error", line: line ? String(line).slice(0, 300) : null, resetAt: null, parkUntil: null, result: summary, ...extra });
  if (timedOut) return mk("error", "timeout", `killed by the wrapper's timeout${signal ? " (" + signal + ")" : ""}`);

  // the texts to scan: the result, stderr, and (no result object) the stdout tail
  const texts = [result || "", String(stderr || ""), res ? "" : String(stdout || "").slice(-4000)];
  const lines = [].concat(...texts.map((t) => t.split(/\r?\n/))).map((l) => l.trim()).filter(Boolean);

  // usage limit: a CLI-shaped line, or the JSON quota record
  const recs = quotaRecords(stdout), rec = recs.find((r) => r.quotaLimits && r.quotaLimits.status === "rejected") || recs.find((r) => r.error === "rate_limit") || null;
  let limitLine = null;
  for (const L of lines) {
    if (!LIMIT_RE.some((re) => re.test(L))) continue;
    if (abnormal || (L === (result || "").trim() && L.length <= 200 && CLI_SHAPE.test(L))) { limitLine = L; break; }
  }
  if (!limitLine && rec && abnormal) limitLine = JSON.stringify({ error: rec.error || null, apiErrorStatus: rec.apiErrorStatus || null, rateLimitType: rec.quotaLimits ? rec.quotaLimits.rateLimitType : null });
  if (limitLine) {
    let reset = rec && rec.quotaLimits && Number.isFinite(rec.quotaLimits.resetsAt) ? rec.quotaLimits.resetsAt * 1000 : null, fromText = false;
    if (reset == null) { reset = resetAtFrom(limitLine, nowMs, tz); fromText = reset != null && !/\|\d{10}\b/.test(limitLine); }
    const kind = limitKind(limitLine, rec), p = parkFor({ kind, reset, fromText, line: limitLine, nowMs, tz, rng });
    return mk("usage-limit", kind, limitLine, { attempt: false, resetAt: p.resetMs != null ? new Date(p.resetMs).toISOString() : null, parkUntil: new Date(p.parkMs).toISOString(), parkNote: p.note });
  }
  if (abnormal) {
    const a = lines.find((L) => AUTH_RE.some((re) => re.test(L)));
    if (a) return mk("auth-failed", "auth", a, { attempt: false });
  }
  if (res && res.subtype === "error_max_budget_usd") return mk("error", "budget", result || "error_max_budget_usd");
  if (abnormal && lines.find((L) => BUDGET_RE.test(L))) return mk("error", "budget", lines.find((L) => BUDGET_RE.test(L)));
  if (res && res.subtype === "error_max_turns") return mk("error", "max_turns", result || "error_max_turns");
  if (abnormal) {
    const t = lines.find((L) => TRANSIENT_RE.some((re) => re.test(L)));
    if (t) return mk("error", "transient", t);
  }
  if (exitCode === 0 && res && res.type === "result" && isError === false && (!res.subtype || res.subtype === "success")) return mk("ok", null, null, { attempt: true });
  if (!res) return mk("error", "no-json", lines.slice(-1)[0] || `exit ${exitCode} with no result object`);
  return mk("error", "unknown", result || lines.slice(-1)[0] || `exit ${exitCode}`);
}

// ── selftest: the corpus ─────────────────────────────────────────────────────────────────────────────────────────────────────
function selftest() {
  const path = require("path"), fs = require("fs");
  let pass = 0, fail = 0;
  const ok = (name, cond, d) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (d ? " — " + d : "")); } };
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "limit-corpus.json"), "utf8"));
  const resultJson = (o) => JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 4100, duration_api_ms: 3900, num_turns: 1, result: "ok", session_id: "00000000-0000-4000-8000-000000000000", total_cost_usd: 0.0123, usage: { input_tokens: 4, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, ...o });
  for (const c of corpus.cases) {
    const stdout = c.stdout != null ? c.stdout : c.result != null ? resultJson({ result: c.result, is_error: !!c.is_error, ...(c.subtype ? { subtype: c.subtype } : {}), ...(c.extra || {}) }) : "";
    const got = classify({ exitCode: c.exit ?? 0, stdout, stderr: c.stderr || "", timedOut: !!c.timedOut, nowMs: Date.parse(c.now || "2026-10-06T23:59:00-06:00"), tz: "America/Denver", rng: () => 0 });
    const want = c.want;
    const okCls = got.class === want.class && (want.kind === undefined || got.kind === want.kind) && (want.resetAt === undefined || got.resetAt === want.resetAt) && (want.attempt === undefined || got.attempt === want.attempt);
    ok(`[${c.source}] ${c.name} -> ${want.class}${want.kind ? "/" + want.kind : ""}${want.resetAt ? " reset " + want.resetAt : ""}`, okCls, JSON.stringify({ class: got.class, kind: got.kind, resetAt: got.resetAt, attempt: got.attempt }));
  }
  // the spec's acceptance line: "resets 5:20pm (America/Denver)" seen at 23:59 MT -> tomorrow 17:20 MT
  ok("spec: 'resets 5:20pm (America/Denver)' at 23:59 MT -> the next day 17:20 MT", new Date(resetAtFrom("You've hit your session limit · resets 5:20pm (America/Denver)", Date.parse("2026-10-06T23:59:00-06:00"))).toISOString() === "2026-10-07T23:20:00.000Z");
  ok("DST: 'resets 1am (America/Denver)' at 2026-10-31 23:30 MDT -> 2026-11-01 01:00 MDT (the first of the two 1 ams)", new Date(resetAtFrom("resets 1am (America/Denver)", Date.parse("2026-10-31T23:30:00-06:00"))).toISOString() === "2026-11-01T07:00:00.000Z");
  ok("a zone the CLI names that Intl rejects falls back to the host zone", new Date(resetAtFrom("resets 9pm (Mars/Olympus)", Date.parse("2026-10-06T12:00:00-06:00"))).toISOString() === "2026-10-07T03:00:00.000Z");
  ok("park = reset + 2..5 min jitter; unparseable reset parks 60 min", (() => {
    const now = Date.parse("2026-10-06T12:00:00-06:00");
    const a = classify({ exitCode: 1, stdout: resultJson({ result: "You've hit your session limit · resets 1pm (America/Denver)", is_error: true }), nowMs: now, rng: () => 1 });
    const b = classify({ exitCode: 1, stdout: resultJson({ result: "Weekly limit reached", is_error: true }), nowMs: now });
    return Date.parse(a.parkUntil) - Date.parse(a.resetAt) === 300000 && b.resetAt === null && Date.parse(b.parkUntil) - now === 3600000;
  })());
  // 2026-10-07 review: a reset that has JUST passed must not park a day / a week / a year; a far parse is a slip, never the park
  {
    const lim = (line, nowIso) => classify({ exitCode: 1, stdout: resultJson({ result: line, is_error: true }), nowMs: Date.parse(nowIso), rng: () => 0 });
    const h = (c, nowIso) => (Date.parse(c.parkUntil) - Date.parse(nowIso)) / 3600000;
    const a1 = lim("Opus weekly limit reached ∙ resets Oct 9, 5pm", "2026-10-09T17:00:20-06:00"), a2 = lim("You've hit your weekly limit · resets Thu 4am", "2026-10-15T04:00:10-06:00"), a3 = lim("You've hit your session limit · resets 8:50pm (America/Denver)", "2026-10-13T20:50:05-06:00");
    ok("just passed: 'Oct 9, 5pm' at 17:00:20, 'Thu 4am' at 04:00:10, '8:50pm' at 20:50:05 -> park 2-5 min (never a year / a week / a day)", [[a1, "2026-10-09T17:00:20-06:00"], [a2, "2026-10-15T04:00:10-06:00"], [a3, "2026-10-13T20:50:05-06:00"]].every(([c, n]) => c.class === "usage-limit" && h(c, n) > 0 && h(c, n) <= 0.09 && /just passed/.test(c.parkNote)), JSON.stringify([a1.parkUntil, a2.parkUntil, a3.parkUntil]));
    const b1 = lim("5-hour limit reached ∙ resets 3pm", "2026-10-06T23:59:00-06:00"), b2 = lim("You've hit your weekly limit · resets Mon 9am", "2026-10-06T23:59:00-06:00");
    ok("a session reset 15 h away is a parse slip (park 60 min, retry); a weekly reset 5.4 days away is kept (reset + jitter)", Math.abs(h(b1, "2026-10-06T23:59:00-06:00") - 1) < 1e-9 && /parse slip/.test(b1.parkNote) && b2.parkUntil === "2026-10-12T15:02:00.000Z" && b2.parkNote === null, JSON.stringify([b1.parkUntil, b1.parkNote, b2.parkUntil]));
    const c1 = lim("Claude AI usage limit reached|1759999999", "2026-10-06T23:59:00-06:00");
    ok("an epoch reset already in the past parks 2-5 min, not 60", h(c1, "2026-10-06T23:59:00-06:00") <= 0.09 && /already past/.test(c1.parkNote), c1.parkNote);
  }
  console.log(`limit selftest: ${pass} passed, ${fail} failed (${corpus.cases.length} corpus cases)`);
  return fail === 0;
}

if (require.main === module) {
  if (process.argv.includes("--selftest")) process.exitCode = selftest() ? 0 : 1;
  else { console.log("limit.cjs: classify() for claude-run.cjs; --selftest runs the corpus"); process.exitCode = 2; }
}
module.exports = { classify, parseResult, resetAtFrom, nextWall, wallToUtc, partsIn, parkFor, LIMIT_RE, AUTH_RE, PARK_MAX_MS };
