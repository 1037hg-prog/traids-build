"use strict";
/**
 * SEAT-SDK TRIAL (work order 4.31, 2026-10-12) — what this folder knows about the six nightly seats, in one place.
 *
 * THE TABLE BELOW IS A MIRROR of `const SEATS = [...]` in automation/seat-wave.cjs: which seats, how many minutes, which dollar cap,
 * which model override. The wave stays the source: it hands its own values to the hook, and the runner REFUSES a seat whose cap, minutes
 * or model are wider than this table (run-seat.cjs). The package's selftest and verify-live.cjs fail when the two drift apart
 * (waveFacts() below reads the wave's source as text; nothing here ever require()s the wave: it runs on load).
 *
 * A module: nothing happens on load.
 */

/** seat · wall-clock minutes · dollar cap for the seat's night · model override the wave passes (null = the seat definition's own tier) */
const SEATS = [
  { seat: "risk-governor", minutes: 12, budget: 2.0, model: null },
  { seat: "portfolio-constructor", minutes: 12, budget: 2.0, model: null },
  { seat: "news-trader", minutes: 12, budget: 2.0, model: null },
  { seat: "stop-manager", minutes: 12, budget: 2.0, model: null },
  { seat: "portfolio-manager", minutes: 15, budget: 2.5, model: null },
  { seat: "head-trader", minutes: 18, budget: 4.0, model: "opus" },
];
const SEAT_NAMES = SEATS.map((s) => s.seat);
const seatOf = (name) => SEATS.find((s) => s.seat === name) || null;

/** what the command-line path passes today (automation/seat-wave.cjs runSeat): --max-turns 60 --permission-mode bypassPermissions */
const MAX_TURNS = 60, PERMISSION_MODE = "bypassPermissions";
/** the one follow-up turn a seat gets when it ran and sealed nothing: the wave's own text and minutes */
const FOLLOW_UP_MINUTES = 6;
const followUpPrompt = (seat) => `You did not seal a claim. Seal exactly ONE now with node backend/seal-claim.js --seat ${seat} ... (NAMED, SIZED, DATED, FALSIFIABLE, --closes sessions:N), then record with backend/agent-ledger.js, then stop.`;

/** the trial (operator 2026-10-12: "build it for a trial period"; the $200 promotional API credit expires 2026-11-14) */
const GRANT_USD = 200;                 // the promotional credit: no cap of this trial may be set above it
const TRIAL_END = "2026-11-14";        // from 00:00 UTC of this date the SDK path refuses (the earliest reading of "expires 2026-11-14")
const DEFAULT_LIMITS = Object.freeze({ nightCapUsd: 12, trialCapUsd: 180, trialEnd: TRIAL_END });

/**
 * The facts of automation/seat-wave.cjs this folder mirrors, read from its SOURCE TEXT (never by loading it).
 * -> { seats: [{ seat, minutes, budget, model }], maxTurns, permissionMode, followUpTemplate, followUpMinutes, hasSelftest, problems: [] }
 */
function waveFacts(src) {
  const out = { seats: [], maxTurns: null, permissionMode: null, followUpTemplate: null, followUpMinutes: null, hasSelftest: /--selftest/.test(src), problems: [] };
  const a = src.indexOf("const SEATS = ["), b = a < 0 ? -1 : src.indexOf("\n];", a);
  if (a < 0 || b < 0) out.problems.push("the SEATS list was not found");
  else {
    const block = src.slice(a, b);
    for (const m of block.matchAll(/\{\s*seat:\s*"([^"]+)",\s*minutes:\s*(\d+),\s*budget:\s*([0-9.]+),(?:\s*model:\s*"([^"]+)",)?/g)) out.seats.push({ seat: m[1], minutes: Number(m[2]), budget: Number(m[3]), model: m[4] || null });
    const named = [...block.matchAll(/\{\s*seat:\s*"([^"]+)"/g)].length;
    if (named !== out.seats.length) out.problems.push(`${named} seats are named in the SEATS list but ${out.seats.length} could be read in full`);
  }
  const mt = /"--max-turns",\s*"(\d+)"/.exec(src); if (mt) out.maxTurns = Number(mt[1]); else out.problems.push("--max-turns was not found");
  const pm = /"--permission-mode",\s*"([A-Za-z]+)"/.exec(src); if (pm) out.permissionMode = pm[1]; else out.problems.push("--permission-mode was not found");
  const fu = /runSeat\(s,\s*\["--resume",\s*r\.sessionId\],\s*`([^`]*)`,\s*(\d+)\)/.exec(src);
  if (fu) { out.followUpTemplate = fu[1]; out.followUpMinutes = Number(fu[2]); } else out.problems.push("the follow-up turn was not found");
  return out;
}
/** [] when this folder's mirror equals the wave's facts, else what differs (in words) */
function driftFrom(src) {
  const f = waveFacts(src), bad = [...f.problems];
  if (JSON.stringify(f.seats) !== JSON.stringify(SEATS)) bad.push(`the seat list differs — the wave: ${JSON.stringify(f.seats)} — this folder: ${JSON.stringify(SEATS)}`);
  if (f.maxTurns !== MAX_TURNS) bad.push(`--max-turns is ${f.maxTurns} in the wave, ${MAX_TURNS} here`);
  if (f.permissionMode !== PERMISSION_MODE) bad.push(`--permission-mode is ${f.permissionMode} in the wave, ${PERMISSION_MODE} here`);
  if (f.followUpMinutes !== FOLLOW_UP_MINUTES) bad.push(`the follow-up turn has ${f.followUpMinutes} minutes in the wave, ${FOLLOW_UP_MINUTES} here`);
  if (f.followUpTemplate != null && f.followUpTemplate.replace("${s.seat}", "SEAT") !== followUpPrompt("SEAT")) bad.push("the follow-up prompt differs from the wave's");
  return bad;
}

/**
 * A seat definition (.claude/agents/<seat>.md) -> { tools: [names], model, bodyChars } — or throws with the reason. Only the two
 * frontmatter lines the runner holds a run to are read; the definition itself is loaded by the launcher, exactly as on the
 * command-line path (the same file, the same loader).
 */
function readDefinition(root, seat) {
  const path = require("path"), fs = require("fs");
  const file = path.join(root, ".claude", "agents", seat + ".md");
  const text = fs.readFileSync(file, "utf8"), m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) throw new Error(`${seat}.md has no frontmatter`);
  const line = (k) => { const x = new RegExp("^" + k + ":[ \\t]*(.*)$", "m").exec(m[1]); return x ? x[1].trim() : null; };
  if (line("name") !== seat) throw new Error(`${seat}.md names itself ${JSON.stringify(line("name"))}`);
  const tools = String(line("tools") || "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!tools.length) throw new Error(`${seat}.md lists no tools (a definition without a tool list would inherit every tool)`);
  if (tools.some((t) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(t))) throw new Error(`${seat}.md has a tool name this runner cannot hold a run to`);
  return { tools, model: line("model") || null, bodyChars: text.length - m[0].length };
}

module.exports = { SEATS, SEAT_NAMES, seatOf, MAX_TURNS, PERMISSION_MODE, FOLLOW_UP_MINUTES, followUpPrompt, GRANT_USD, TRIAL_END, DEFAULT_LIMITS, waveFacts, driftFrom, readDefinition };
