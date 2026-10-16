#!/usr/bin/env node
/**
 * FAKE CLAUDE (W6) — stands in for the Claude Code CLI in the W6 package tests. NEVER deployed. Like research-stage01's fake, its
 * behaviour comes from ./.fake-mode.json in the working directory (the factory root: the child env is an allowlist), and it records
 * ./.fake-last.json (argv with the prompt as its length, env NAMES, cwd). It plays every agent role of stages 2-4 by WRITING the role's
 * output file exactly where the rendered prompt says, so the plain-code pipeline (fcode.cjs) can be driven end to end:
 *   triage     keep every item key named in the prompt (mode.triageKeep: a list of card keys to keep; default all)
 *   registrar  a valid draft (window inside the COVERAGE the prompt carries) — mode.registrar "refuse" | "stat" (a result key) | "ok"
 *   build      a one-day momentum signal — mode.build "lookahead" writes one that reads lag -1
 *   review     pass — mode.review "block" blocks
 *   refuter    refuted false — mode.refute "true" refutes
 * mode.mode: ok (default) | limit | auth | error | budget (as stage01's fake)
 */
"use strict";
const fs = require("fs"), path = require("path");
const argv = process.argv.slice(2), at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const mode = (() => { try { return JSON.parse(fs.readFileSync(".fake-mode.json", "utf8")); } catch { return {}; } })();
const prompt = argv[0] === "-p" ? argv[1] : "";
const role = (/policy[\\/]([a-z]+)\.settings\.json$/.exec(at("--settings") || "") || [])[1] || "?";
fs.writeFileSync(".fake-last.json", JSON.stringify({ role, argv: argv.map((x) => (x === prompt ? `<prompt ${prompt.length}>` : x)), envNames: Object.keys(process.env).sort(), cwd: process.cwd() }));
const calls = (() => { try { return JSON.parse(fs.readFileSync(".fake-calls.json", "utf8")); } catch { return []; } })(); calls.push(role); fs.writeFileSync(".fake-calls.json", JSON.stringify(calls));
const session = at("--session-id") || at("--resume") || "00000000-0000-4000-8000-000000000000";
const result = (o) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 9, result: "done", session_id: session, total_cost_usd: mode.cost ?? 1.25, usage: { input_tokens: 100, output_tokens: 200 }, modelUsage: { "claude-opus": { costUSD: 1.2 } }, ...o });
const out = (s, code) => { process.stdout.write(s + "\n"); process.exitCode = code; };
const outPath = (/`((?:out\/[a-z]+\/[^`\s]+\.json)|(?:work\/F\d{4}\/signal\.cjs))`/.exec(prompt) || [])[1];
const write = (rel, text) => { const f = path.join(process.cwd(), rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
function play() {
  if (!outPath) return;
  if (role === "triage") {
    const keys = ((/item keys, in the\s+same order: ([^)]+)\)/.exec(prompt) || [])[1] || "").split(",").map((s) => s.trim()).filter(Boolean);
    const keep = mode.triageKeep || null, batch = (/batch "?([0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z-]+)/.exec(prompt) || [])[1] || "x";
    write(outPath, JSON.stringify({ batch, scores: keys.map((k) => ({ key: k, mechanism: 2, oos: 2, decay: 2, data: 3, keep: !keep || keep.some((c) => k.endsWith("-" + c)), why: "fake judge" })) }));
  } else if (role === "registrar") {
    const item = (/registration draft for item `([^`]+)`/.exec(prompt) || [])[1];
    const cov = JSON.parse((/Data on this server: (\{.*\})/.exec(prompt) || [])[1] || "{}")["eq-daily"];
    if (mode.registrar === "refuse") return write(outPath, JSON.stringify({ key: item, refuse: true, why: "not expressible on daily bars (fake)" }));
    const from = new Date(Date.parse(cov.from) + 40 * 86400000).toISOString().slice(0, 10), to = new Date(Date.parse(cov.to) - 10 * 86400000).toISOString().slice(0, 10);
    const d = { key: item, noComputedStatistic: true, name: "One-day cross-sectional momentum (fake)", hypothesis: "Stocks that rose today keep rising tomorrow [paper] (fake card).", rule: "Each close: long names whose close rose versus yesterday, short names whose close fell; equal weight; hold one day.", family: "SHORT-TERM MOMENTUM", variantsInThisTest: 1, dataset: "eq-daily", universe: { kind: "all" }, entry: "close", rebalanceDays: 1, costBps: 10, window: { from, to }, minN: 200, mdeDailyBps: 30, controls: { blockDays: 1 }, knownWeaknesses: ["Synthetic fixture; survivorship not modelled."] };
    if (mode.registrar === "stat") d.backtest = { t: 3.1 };
    write(outPath, JSON.stringify(d));
  } else if (role === "build") {
    const lag = mode.build === "lookahead" ? "-1" : "1";
    write(outPath, `module.exports = { meta: { lookbackDays: 2 }, signal(ctx) { const out = []; for (const i of ctx.universe()) { const a = ctx.close(i, 0), b = ctx.close(i, ${lag}); if (a > 0 && b > 0) out.push([i, a > b ? 1 : -1]); } return out; } };\n`);
  } else if (role === "review") {
    const F = (/review of (F\d{4})/.exec(prompt) || [])[1];
    write(outPath, JSON.stringify({ id: F, verdict: mode.review === "block" ? "block" : "pass", lookAhead: "none", conformance: mode.review === "block" ? "deviates" : "ok", reasons: mode.review === "block" ? ["work/x:1 — fake block"] : [] }));
  } else if (role === "refuter") {
    const F = (/PASS audit of (F\d{4})/.exec(prompt) || [])[1], k = +((/refuter (\d) of 3/.exec(prompt) || [])[1]);
    write(outPath, JSON.stringify({ id: F, k, refuted: mode.refute === "true", severity: "minor", reason: "fake refuter: read the signal and the records; nothing found" }));
  }
}
switch (mode.mode) {
  case "limit": out(result({ is_error: true, total_cost_usd: 0.3, result: "You've hit your session limit · resets 11:50pm (America/Denver)" }), 1); break;
  case "auth": out(result({ is_error: true, total_cost_usd: 0, result: "API Error: 401 OAuth access token has expired. Re-authenticate to continue." }), 1); break;
  case "budget": out(result({ is_error: true, subtype: "error_max_budget_usd", total_cost_usd: 65.01, result: "" }), 1); break;
  case "error": out(result({ is_error: true, total_cost_usd: 0.02, result: "API Error: 529 Overloaded." }), 1); break;
  default: play(); out(result({}), 0);
}
