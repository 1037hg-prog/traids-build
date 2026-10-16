#!/usr/bin/env node
/**
 * FAKE CLAUDE — stands in for the Claude Code CLI in the package selftests. NEVER deployed (the install refuses any path under test/).
 * Behaviour comes from ./.fake-mode.json in the working directory (claude-run.cjs runs the CLI with cwd = factory/), because the
 * child environment is an allowlist and cannot carry a test switch. Records ./.fake-last.json: argv (the prompt as its length), the
 * environment NAMES it received, its cwd. Prints what `claude -p --output-format json` prints (the documented result object).
 *   modes: ok | write-cards | bad-cards | limit | auth | error | budget | not-json | killed | slow
 */
"use strict";
const fs = require("fs"), path = require("path");
const argv = process.argv.slice(2), at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const mode = (() => { try { return JSON.parse(fs.readFileSync(".fake-mode.json", "utf8")); } catch { return { mode: "ok" }; } })();
const prompt = argv[0] === "-p" ? argv[1] : "";
fs.writeFileSync(".fake-last.json", JSON.stringify({ argv: argv.map((x) => (x === prompt ? `<prompt ${prompt.length}>` : x)), envNames: Object.keys(process.env).sort(), cwd: process.cwd(), promptHead: prompt.slice(0, 400), resumed: /RESUMED RUN/.test(prompt), jsonPath: (/`(out\/scout\/[^`\s]+\.json)`/.exec(prompt) || [])[1] || null }));
const session = at("--session-id") || at("--resume") || "00000000-0000-4000-8000-000000000000";
const usage = { input_tokens: 1200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 90000, output_tokens: 4100, server_tool_use: { web_search_requests: 9, web_fetch_requests: 14 } };
const model = at("--model") === "fable" ? "claude-fable" : "claude-opus";
const result = (o) => JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 5000, duration_api_ms: 4800, num_turns: 12, result: "done", session_id: session, total_cost_usd: mode.cost ?? 2.41, usage, modelUsage: { [model]: { inputTokens: 1200, outputTokens: 4100, cacheReadInputTokens: 90000, cacheCreationInputTokens: 3000, webSearchRequests: 9, costUSD: 2.2 }, "claude-haiku": { inputTokens: 30000, outputTokens: 900, costUSD: 0.21 } }, permission_denials: [], ...o });
function cards(ok = true) {
  // the two paths and the lane exactly as the prompt names them (a --job-suffix job has its own <date>-<lane>-<suffix> files)
  const pj = /`(out\/scout\/[^`\s]+\.json)`/.exec(prompt), pm = /`(out\/scout\/[^`\s]+\.md)`/.exec(prompt), pl = /"lane": "([a-z-]+)"/.exec(prompt), pd = /"asOf": "(\d{4}-\d\d-\d\d)"/.exec(prompt);
  if (!pj || !pm || !pl || !pd) return;
  const lane = pl[1], date = pd[1], dir = path.join(process.cwd(), "out", "scout"); fs.mkdirSync(dir, { recursive: true });
  const card = (i) => ({ rank: i, key: `FAKE_CARD_${i}`, name: `Fake candidate ${i}`, rule: "universe X; signal Y; entry Z; exit W", sources: [{ title: "t", url: "https://example.org/p", year: 2025 }], effect: "UNVERIFIED 3 bps/day", mechanism: "who pays", decay: "n/a", dataWeHave: true, dataSource: "Alpaca SIP daily", dataGap: "none", capacity: "small", testDesign: { unit: "days", nEstimate: 1500, variants: 1, window: "2016..2026", controls: "random-timing null" }, prior: "LOW", priorWhy: "base rate", nearestExistingTest: "none" });
  const n = ok ? 5 : 2;
  fs.writeFileSync(path.join(process.cwd(), pj[1]), JSON.stringify({ lane, asOf: date, scope: "fake", candidates: Array.from({ length: n }, (_, i) => card(i + 1)), trapsSeen: [] }, null, 1));
  fs.writeFileSync(path.join(process.cwd(), pm[1]), `# Alpha research: server scout, ${date}\n\n## Top 3\n` + "x".repeat(400) + "\n");
}
const out = (s, code) => { process.stdout.write(s + "\n"); process.exitCode = code; };
switch (mode.mode) {
  case "write-cards": cards(true); out(result({ result: "Wrote both files." }), 0); break;
  case "bad-cards": cards(false); out(result({ result: "Wrote both files." }), 0); break;
  case "limit": out(result({ is_error: true, total_cost_usd: 0.31, result: mode.line || "You've hit your session limit · resets 8:50pm (America/Denver)" }), 1); break;
  case "auth": out(result({ is_error: true, total_cost_usd: 0, result: "API Error: 401 OAuth access token has expired. Re-authenticate to continue." }), 1); break;
  case "error": out(result({ is_error: true, total_cost_usd: 0.02, result: "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com." }), 1); break;
  case "budget": out(result({ is_error: true, subtype: "error_max_budget_usd", total_cost_usd: 8.01, result: "" }), 1); break;
  case "not-json": out("this is not json", 0); break;
  case "killed": process.exitCode = 143; break;   // no stdout at all (a wrapper timeout, an OOM kill, an argv refusal)
  case "slow": setTimeout(() => out(result({ result: "ok" }), 0), mode.ms || 5000); break;
  default: out(result({ result: mode.result || "ok" }), 0);
}
