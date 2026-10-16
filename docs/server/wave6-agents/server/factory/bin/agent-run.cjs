#!/usr/bin/env node
/**
 * AGENT-RUN — the launcher of every research-engine agent of stages 2-4 (triage judge, registrar, builder, reviewer, refuter), as user
 * scout under systemd. 2026-10-09 (docs/server/wave6-agents). It is research-stage01's claude-run.cjs extended to the later roles, built
 * BESIDE it (claude-run.cjs, which runs smoke and the scout, is unchanged and shared): the SAME budget ledger factory/var/budget.jsonl
 * under the SAME lock (var/budget.lock), the same lib/budget.cjs (the 15-point weekly HARD cap, the plan week, the ramp, builds per
 * week), lib/limit.cjs (usage-limit park / auth / error), the same child-environment allowlist (no ANTHROPIC_* ever: the subscription
 * token CLAUDE_CODE_OAUTH_TOKEN from /etc/traids/claude.env only), the same breaker and PAUSE / RESEARCH-OFF switches.
 *
 *   node factory/bin/agent-run.cjs --next              production (traids-w6-fagent.service): the next due job, at most one
 *   node factory/bin/agent-run.cjs --job <jobId>       one named job (operator, tests)
 *   node factory/bin/agent-run.cjs --print-argv --job <jobId>   the argv + child env names; nothing runs, nothing written
 *   node factory/bin/agent-run.cjs --status | --selftest
 *
 * JOBS are written ONLY by fcode.cjs (user traids) into factory/queue/<jobId>.json (scout reads them, cannot write them). This file
 * re-validates every job: the role, the F id, every path under the role's own prefixes. Job state lives in factory/var/jobs/ (as
 * claude-run's does); fcode.cjs reads it.
 *
 * ON TOP OF claude-run's guards (all inside the lock, before the reserve row):
 *   - the ramp must enable the role today (caps.json ramp), and reads/refuters only from stage 4;
 *   - the role's WINDOW (America/Denver): triage 18:15-06:00, registrar / build / review / refuter 22:30-06:00 (design §2: builds at
 *     night only; daytime is the scout's); outside it -> parked (75), the job waits;
 *   - the WINDOW SPEND CAP: 22:30-01:00 at most $143 (50M eff), 01:00-06:00 at most $68.6 (24M eff: the window that rolls into Josh's
 *     morning) — spend so far in the window instance + this job's worst case must fit; no launch after 06:00;
 *   - Fable never for registrar / build / review / refuter (triage may use it only if caps.json says so after an ELIGIBLE trial).
 * PERMISSIONS per role: --permission-mode dontAsk + an explicit --allowedTools list of paths under the job's own F / item, and a
 * --disallowedTools list that closes argv (Agent, Task, NotebookEdit, mcp__* always; Bash except the builder's two commands; web tools
 * except triage; every node eval / preload form). The unit is the second fence (tmpfs over /home/traids, the factory read-only except
 * var, work, out/<agent dirs>).
 * EXIT 0 ok / nothing due · 75 parked · 76 an error under the breaker threshold · 77 auth (PAUSE) · 70 breaker / unreadable ledger ·
 * 2 refused setup · 1 crash. The unit's SuccessExitStatus=75 76, so only STOP-class exits page.
 * Test mode (FACTORY_TEST=1): FACTORY_ROOT, FACTORY_NOW, CLAUDE_BIN_PREFIX_JSON, FACTORY_LOCK=excl, as claude-run.cjs.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto");
const TEST = process.env.FACTORY_TEST === "1";
const FACTORY = TEST && process.env.FACTORY_ROOT ? path.resolve(process.env.FACTORY_ROOT) : path.resolve(__dirname, "..");
const LIB = (n) => require(path.join(FACTORY, "lib", n));
const CR = () => require(path.join(FACTORY, "bin", "claude-run.cjs"));
const V = (...p) => path.join(FACTORY, "var", ...p);
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const nowMs = () => (TEST && process.env.FACTORY_NOW ? Date.parse(process.env.FACTORY_NOW) : Date.now());
const F_ID = /^F\d{4}(?:-[A-Z0-9]{1,12})?$/, ITEM = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z-]+-[A-Za-z0-9_]{1,48}$/, JOB = /^[a-z]+-[A-Za-z0-9_-]{1,100}$/;
const ROLES = ["triage", "registrar", "build", "review", "refuter"];
const NEVER_FABLE = new Set(["registrar", "build", "review", "refuter"]);
const EVAL_DENY = ["Bash(node -e *)", "Bash(node --eval *)", "Bash(node -p *)", "Bash(node --print *)", "Bash(node -)", "Bash(node - *)", "Bash(node --input-type *)",
  "Bash(node -r *)", "Bash(node --require *)", "Bash(node --import *)", "Bash(node --loader *)", "Bash(NODE_OPTIONS=*)", "Bash(env *)"];

// ── roles ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Pure: the tools / allow / deny of one job. Every path is derived from the job's own id, never taken from the job text. */
function profile(job) {
  const F = job.fId, I = job.item, base = ["Agent", "Task", "NotebookEdit", "mcp__*"];
  switch (job.role) {
    case "triage": return { tools: "Read,Write,WebSearch,WebFetch", allow: ["WebSearch", "WebFetch", "Read(/in/**)", "Read(/out/scout/**)", "Read(/state/factory-registry.json)", `Read(/queue/${job.jobId}.json)`, "Edit(/out/triage/**)"], deny: ["Bash", ...base] };
    case "registrar": return { tools: "Read,Write", allow: ["Read(/in/**)", "Read(/out/scout/**)", "Read(/out/triage/**)", "Read(/state/factory-registry.json)", `Read(/queue/${job.jobId}.json)`, "Read(/prompts/harness-api.md)", `Edit(/out/register/${I}.json)`], deny: ["Bash", "WebSearch", "WebFetch", ...base] };
    case "build": return { tools: "Read,Write,Edit,Bash", allow: [`Read(/queue/${job.jobId}.json)`, "Read(/state/factory-registry.json)", "Read(/prompts/harness-api.md)", "Read(/prompts/example-signal.cjs)", `Read(/work/${F}/**)`, `Read(/out/review/${F}*)`, `Edit(/work/${F}/**)`, `Bash(node --check work/${F}/signal.cjs)`, `Bash(node bin/fcode.cjs check-signal ${F})`], deny: ["WebSearch", "WebFetch", ...base, ...EVAL_DENY] };
    case "review": return { tools: "Read,Write", allow: [`Read(/queue/${job.jobId}.json)`, "Read(/state/factory-registry.json)", "Read(/prompts/harness-api.md)", `Read(/work/${F}/**)`, `Read(/out/review/${F}*)`, `Edit(/out/review/${F}*)`], deny: ["Bash", "WebSearch", "WebFetch", ...base] };
    case "refuter": return { tools: "Read,Write", allow: [`Read(/queue/${job.jobId}.json)`, "Read(/state/**)", "Read(/prompts/harness-api.md)", `Read(/work/${F}/**)`, `Read(/out/review/${F}*)`, `Edit(/out/refute/${F}-r${job.k}.json)`], deny: ["Bash", "WebSearch", "WebFetch", ...base] };
    default: throw new Error(`role ${job.role} has no profile`);
  }
}
/** Pure: the CLI argv. The prompt first; the variadic allow / deny lists close the line. */
function buildArgv({ job, model, prompt, caps, sessionId, resume = false, factory = FACTORY }) {
  const rc = caps.roles[job.role], p = profile(job);
  if (!rc) throw new Error(`caps.json has no role ${job.role}`);
  return ["-p", prompt, "--model", model, "--output-format", "json", "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--max-budget-usd", String(rc.maxBudgetUsd), "--max-turns", String(rc.maxTurns || 60),
    "--strict-mcp-config", "--mcp-config", path.join(factory, "policy", "mcp-none.json"),
    "--setting-sources", "project", "--settings", path.join(factory, "policy", `${job.role}.settings.json`),
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
    "--tools", p.tools, "--allowedTools", ...p.allow, "--disallowedTools", ...p.deny];
}
/** Pure: is this job well-formed? -> null or the reason. Paths are recomputed from ids; nothing in the job text widens them. */
function jobProblem(job) {
  if (!job || job.spec !== "w6-job-v1") return "not a w6-job-v1";
  if (!JOB.test(String(job.jobId || ""))) return `bad jobId ${JSON.stringify(job.jobId)}`;
  if (!ROLES.includes(job.role)) return `role ${job.role} is not an agent role`;
  if (["build", "review", "refuter"].includes(job.role) && !F_ID.test(String(job.fId || ""))) return `${job.role} needs an F id`;
  if (job.role === "registrar" && !ITEM.test(String(job.item || ""))) return "registrar needs an item key";
  if (job.role === "refuter" && ![1, 2, 3].includes(job.k)) return "refuter needs k 1..3";
  if (!/^prompts\/[a-z-]+\.md$/.test(String(job.prompt && job.prompt.file || ""))) return "prompt.file must be prompts/<role>.md";
  const want = { triage: /^out\/triage\/\d{4}-\d{2}-\d{2}-[a-z-]+\.json$/, registrar: new RegExp(`^out/register/${job.item}\\.json$`), build: new RegExp(`^work/${job.fId}/signal\\.cjs$`), review: new RegExp(`^out/review/${job.fId}(?:-r1)?\\.json$`), refuter: new RegExp(`^out/refute/${job.fId}-r${job.k}\\.json$`) }[job.role];
  if (!want.test(String(job.output || ""))) return `output ${JSON.stringify(job.output)} is not the ${job.role} role's own path`;
  return null;
}
/** Pure: render a prompt template ({{NAME}} fields from job.prompt.vars + JOB_FILE/OUTPUT/JOB_ID). Unfilled -> throws. */
function render(template, job, extra = {}) {
  const vars = { JOB_FILE: `queue/${job.jobId}.json`, OUTPUT: job.output, JOB_ID: job.jobId, F: job.fId || "", ITEM: job.item || "", K: job.k == null ? "" : String(job.k), ...(job.prompt.vars || {}), ...extra };
  const out = template.replace(/<!--[\s\S]*?-->\n?/, "").replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
  if (/\{\{[A-Z_]+\}\}/.test(out)) throw new Error("prompt has an unfilled field: " + /\{\{[A-Z_]+\}\}/.exec(out)[0]);
  return out;
}

// ── windows (America/Denver wall clock) ─────────────────────────────────────────────────────────────────────────────────────
const mtParts = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return { day: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute }; };
const hm = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
const inSpan = (min, [a, b]) => (hm(a) <= hm(b) ? min >= hm(a) && min < hm(b) : min >= hm(a) || min < hm(b));
/** Pure: may this role launch now? -> null or why not */
function windowRefusal(caps, role, ms) {
  const spans = ((caps.windows || {}).roles || {})[role]; if (!spans || !spans.length) return `caps.json windows.roles has no window for ${role} — REFUSED`;
  const { min } = mtParts(ms); return spans.some((s) => inSpan(min, s)) ? null : `${role} launches only ${spans.map((s) => s.join("-")).join(", ")} America/Denver`;
}
/** Pure: the spend window instance containing ms -> { from, to (ms), capUsd } | null (outside every spend window) */
function spendWindow(caps, ms) {
  const { min } = mtParts(ms);
  for (const w of ((caps.windows || {}).spend || [])) {
    if (!inSpan(min, [w.from, w.to])) continue;
    const back = (min - hm(w.from) + 1440) % 1440, fwd = (hm(w.to) - min + 1440) % 1440;
    return { from: ms - back * 60000 - (ms % 60000), to: ms + fwd * 60000 - (ms % 60000), capUsd: Number(w.capUsd), label: `${w.from}-${w.to}` };
  }
  return null;
}
/** Pure: spend inside [from, to) from the ledger rows (run rows: the larger cost; open reservations: their worst case) */
function windowSpend(rows, from, to, B) {
  const res = new Map(), runs = []; for (const r of rows) { const t = Date.parse(r.ts); if (!(t >= from && t < to)) continue; if (r.kind === "reserve") res.set(r.rid, r); else if (r.kind === "run") runs.push(r); }
  let usd = 0; const closed = new Set(); for (const r of runs) { closed.add(r.rid); usd += B.runCost(r, res.get(r.rid)); }
  for (const [rid, r] of res) if (!closed.has(rid)) usd += Number(r.maxBudgetUsd) || 0;
  return +usd.toFixed(4);
}

// ── output checks (per role) ────────────────────────────────────────────────────────────────────────────────────────────────
const readJ = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
function checkOutput(factory, job) {
  const f = path.join(factory, job.output), p = [];
  if (!fs.existsSync(f)) return { ok: false, problems: [`${job.output} was not written`], file: f };
  if (job.role === "build") {
    const src = fs.readFileSync(f, "utf8"), why = LIB("harness.cjs").screenSignal(src); if (why) p.push(why);
    try { LIB("harness.cjs").compileSignal(src); } catch (e) { p.push("signal.cjs does not compile: " + String(e.message).slice(0, 160)); }
    return { ok: !p.length, problems: p, file: f };
  }
  let j = null; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return { ok: false, problems: [`${job.output} does not parse`], file: f }; }
  if (job.role === "triage") {
    const keys = String((job.prompt.vars || {}).KEYS || "").split(",").filter(Boolean), sc = Array.isArray(j.scores) ? j.scores : null;
    if (!sc) p.push("scores[] missing");
    else { for (const k of keys) if (!sc.some((s) => s && s.key === k)) p.push(`no score for ${k}`); for (const s of sc) { if (!["mechanism", "oos", "decay", "data"].every((x) => Number.isInteger(s[x]) && s[x] >= 0 && s[x] <= 3)) p.push(`${s.key}: scores must be integers 0..3`); if (typeof s.keep !== "boolean") p.push(`${s.key}: keep must be boolean`); } }
  } else if (job.role === "registrar") { if (j.key !== job.item) p.push(`key ${JSON.stringify(j.key)} != ${job.item}`); if (j.refuse === true && !(typeof j.why === "string" && j.why.length > 10)) p.push("a refusal needs why"); }
  else if (job.role === "review") { if (j.id !== job.fId) p.push("id mismatch"); if (!["pass", "block"].includes(j.verdict)) p.push('verdict must be "pass" or "block"'); if (!["none", "found"].includes(j.lookAhead)) p.push('lookAhead must be "none" or "found"'); if (!Array.isArray(j.reasons)) p.push("reasons[] missing"); }
  else if (job.role === "refuter") { if (j.id !== job.fId || j.k !== job.k) p.push("id / k mismatch"); if (typeof j.refuted !== "boolean") p.push("refuted must be boolean"); if (!(typeof j.reason === "string" && j.reason.length >= 20)) p.push("reason (>= 20 chars) missing"); }
  return { ok: !p.length, problems: p, file: f };
}

// ── state, under the shared lock ────────────────────────────────────────────────────────────────────────────────────────────
function writeJ(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.tmp-${process.pid}`; fs.writeFileSync(t, JSON.stringify(o, null, 1)); fs.renameSync(t, f); }
function appendRow(f, row) { const fd = fs.openSync(f, "a"); try { fs.writeSync(fd, JSON.stringify(row) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function loadCaps() { const c = readJ(V("caps.json")); if (!c || c.spec !== "research-caps-v1") throw new Error("factory/var/caps.json missing or not research-caps-v1 — REFUSED"); if (!c.windows) throw new Error("factory/var/caps.json has no windows (the W6 caps migration has not run: deploy.cjs --step caps) — REFUSED"); return c; }
function opBegin(p) {
  const B = LIB("budget.cjs"), caps = loadCaps(), now = p.nowMs;
  const park = (reason, exit = 75) => ({ go: false, exit, reason });
  if (fs.existsSync(V("RESEARCH-OFF"))) return park("factory/var/RESEARCH-OFF is present — the research engine is switched off");
  if (fs.existsSync(V("PAUSE"))) return park(`factory/var/PAUSE is present (${String(fs.readFileSync(V("PAUSE"), "utf8")).trim().slice(0, 160)}) — fix the cause, then remove the file`);
  const br = readJ(V("breaker.json"), { consecutive: 0, tripped: false, history: [] });
  if (br.tripped) { br.tripped = false; br.consecutive = 0; br.history = [...(br.history || []), { at: new Date(now).toISOString(), ev: "operator reset (PAUSE removed)" }].slice(-50); writeJ(V("breaker.json"), br); }
  const pk = readJ(V("park.json")); if (pk && Date.parse(pk.until) > now) return park(`parked until ${pk.until} (${pk.kind || "?"})`);
  const en = B.roleEnabled(caps, p.role, now); if (!en.ok) return park(en.reason);
  const wr = windowRefusal(caps, p.role, now); if (wr) return park(wr);
  const jf = V("jobs", `${p.jobId}.json`), job = readJ(jf, { jobId: p.jobId, role: p.role, attempts: 0, status: "new", history: [] });
  if (job.status === "done") return { go: false, exit: 0, reason: `job ${p.jobId} is already done (${job.doneAt})` };
  if (job.status === "failed" || job.status === "budget-stop") return { go: false, exit: 0, reason: `job ${p.jobId} is ${job.status} — fcode decides what follows` };
  if (job.status === "running" && now - Date.parse(job.startedAt) < 5 * 3600000) return park(`job ${p.jobId} is already running (since ${job.startedAt})`);
  if (job.status === "running") { job.attempts++; job.history.push({ at: new Date(now).toISOString(), ev: "found running with no finish — counted as an attempt" }); }
  const max = Number(caps.maxAttemptsPerJob) || 2;
  if (job.attempts >= max) { job.status = "failed"; writeJ(jf, job); return { go: false, exit: 76, reason: `job ${p.jobId} used its ${max} attempts — failed` }; }
  const led = fs.existsSync(V("budget.jsonl")) ? B.parseLedger(fs.readFileSync(V("budget.jsonl"), "utf8")) : { rows: [], bad: [] };
  const d = B.decideLaunch({ rows: led.rows, bad: led.bad, nowMs: now, caps, role: p.role });
  if (!d.ok) return { go: false, exit: d.alert ? 70 : 75, reason: d.reason };
  const worst = B.worstCase(caps.roles[p.role]), sw = spendWindow(caps, now);
  if (sw) { const spent = windowSpend(led.rows, sw.from, sw.to, B); if (spent + worst > sw.capUsd) return park(`window ${sw.label} MT spend cap: spent $${spent.toFixed(2)} + this job's worst case $${worst.toFixed(2)} > $${sw.capUsd} — parked until ${new Date(sw.to).toISOString()}`); }
  else if (p.role !== "triage") return park("outside every spend window (no launch after 06:00 MT)");
  const resume = job.status === "limit-cut" && !!job.sessionId, sessionId = resume ? job.sessionId : (p.sessionId || crypto.randomUUID()), rid = crypto.randomUUID();
  appendRow(V("budget.jsonl"), { kind: "reserve", rid, ts: new Date(now).toISOString(), planWeek: d.weekStart, role: p.role, jobId: p.jobId, model: p.model, estimateUsd: Number(caps.roles[p.role].estimateUsd) || 0, maxBudgetUsd: worst, by: "agent-run" });
  Object.assign(job, { role: p.role, status: "running", startedAt: new Date(now).toISOString(), rid, sessionId, model: p.model });
  job.history.push({ at: job.startedAt, ev: resume ? `resume after a limit cut (attempt ${job.attempts + 1})` : `launch (attempt ${job.attempts + 1})` });
  writeJ(jf, job);
  return { go: true, rid, sessionId, resume, attempt: job.attempts + 1, planWeek: d.weekStart, spentUsd: d.spentUsd, capUsd: d.capUsd, worstUsd: worst, stage: en.stage };
}
function opFinish(p) {
  const caps = loadCaps(), now = p.nowMs, o = p.outcome, ts = new Date(now).toISOString(), C = { costOrNull: (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null) };
  const r = o.result || {}, tc = C.costOrNull(r.total_cost_usd), mc = p.modelUsageCost;
  appendRow(V("budget.jsonl"), { kind: "run", rid: p.rid, ts, planWeek: p.planWeek, role: p.role, jobId: p.jobId, model: p.model, modelsUsed: p.modelsUsed || [], class: o.class, errKind: o.kind || null,
    total_cost_usd: tc, modelUsageCostUsd: mc, costKnown: tc != null || mc != null, usage: p.usage || null, num_turns: r.num_turns ?? null, duration_ms: p.durationMs, session_id: r.session_id || p.sessionId, exitCode: p.exitCode, by: "agent-run" });
  const jf = V("jobs", `${p.jobId}.json`), job = readJ(jf, { jobId: p.jobId, attempts: 0, history: [] });
  const br = readJ(V("breaker.json"), { consecutive: 0, tripped: false, history: [] }), thr = Number(caps.breakerThreshold) || 5;
  let exit;
  if (o.class === "ok") { job.status = "done"; job.doneAt = ts; br.consecutive = 0; exit = 0; }
  else if (o.class === "usage-limit") { job.status = "limit-cut"; exit = 75; writeJ(V("park.json"), { until: o.parkUntil, resetAt: o.resetAt, kind: o.kind, line: o.line, long: Date.parse(o.parkUntil) - now > 24 * 3600000, jobId: p.jobId, setAt: ts }); }
  else if (o.class === "auth-failed") { job.status = "auth-failed"; br.tripped = true; exit = 77; fs.writeFileSync(V("PAUSE"), `${ts} AUTH FAILED (${p.jobId}): ${String(o.line || "").slice(0, 160)} — re-create the token (claude setup-token at home), place it, then remove this file\n`); }
  else if (o.kind === "budget" && p.role === "build") { job.status = "budget-stop"; exit = 76; br.consecutive++; }   // design §3: a build that hits its cap goes to Josh, never retried
  else {
    job.attempts++; job.status = job.attempts >= (Number(caps.maxAttemptsPerJob) || 2) ? "failed" : "error"; br.consecutive++; exit = 76;
    if (br.consecutive >= thr) { br.tripped = true; exit = 70; fs.writeFileSync(V("PAUSE"), `${ts} BREAKER: ${br.consecutive} non-limit failures in a row (last ${p.jobId}: ${o.kind}: ${String(o.line || "").slice(0, 120)}) — fix the cause, then remove this file\n`); }
  }
  job.lastClass = o.class; job.lastKind = o.kind || null; job.history.push({ at: ts, ev: `${o.class}${o.kind ? "/" + o.kind : ""}`, cost: tc });
  br.history = [...(br.history || []), { at: ts, job: p.jobId, class: o.class, kind: o.kind || null, consecutive: br.consecutive }].slice(-50);
  writeJ(jf, job); writeJ(V("breaker.json"), br);
  return { exit, breaker: { consecutive: br.consecutive, tripped: br.tripped } };
}
const OPS = { begin: opBegin, finish: opFinish };
function locked(op, payload) {
  const lock = V("budget.lock");
  if (TEST && process.env.FACTORY_LOCK === "excl") {
    const x = lock + ".excl", t0 = Date.now();
    for (;;) { try { fs.closeSync(fs.openSync(x, "wx")); break; } catch (e) { if (e.code !== "EEXIST") throw e; if (Date.now() - t0 > 30000) throw new Error("lock timeout"); cp.spawnSync(process.execPath, ["-e", "setTimeout(()=>{},50)"]); } }
    try { return OPS[op](payload); } finally { try { fs.unlinkSync(x); } catch { /* gone */ } }
  }
  if (!fs.existsSync("/usr/bin/flock")) throw new Error("/usr/bin/flock not found — REFUSED");
  const env = { ...process.env }; delete env.CLAUDE_CODE_OAUTH_TOKEN;   // the lock child does state only and never gets the token
  const r = cp.spawnSync("/usr/bin/flock", ["-w", "120", lock, process.execPath, __filename, "--locked-op", op], { input: JSON.stringify(payload), encoding: "utf8", env, timeout: 180000 });
  if (r.status !== 0) throw new Error(`locked ${op} failed (exit ${r.status}): ${String(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return JSON.parse(String(r.stdout).trim().split("\n").pop());
}

// ── the child ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function claudeCommand() {
  if (TEST && process.env.CLAUDE_BIN_PREFIX_JSON) { const a = JSON.parse(process.env.CLAUDE_BIN_PREFIX_JSON); return { bin: a[0], pre: a.slice(1) }; }
  const rec = readJ(V("claude-bin.json")), cands = [rec && rec.path, "/usr/bin/claude", "/usr/local/bin/claude"].filter(Boolean);
  const bin = cands.find((c) => { try { fs.accessSync(c, fs.constants.X_OK); return true; } catch { return false; } });
  if (!bin) throw new Error("claude CLI not found (" + cands.join(", ") + ")");
  return { bin, pre: [] };
}
function runChild(argv, env, timeoutMs) {
  return new Promise((resolve) => {
    const { bin, pre } = claudeCommand(), t0 = Date.now(), child = cp.spawn(bin, [...pre, ...argv], { cwd: FACTORY, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "", timedOut = false, procNames = null, leak = null;
    child.stdout.on("data", (d) => { if (out.length < 8e6) out += d; }); child.stderr.on("data", (d) => { if (err.length < 2e6) err += d; });
    child.on("spawn", () => { if (process.platform === "linux") { try { procNames = fs.readFileSync(`/proc/${child.pid}/environ`).toString("utf8").split("\0").filter(Boolean).map((kv) => kv.split("=")[0]); } catch { procNames = null; } } const bad = (procNames || []).filter((k) => CR().ENV_FORBIDDEN.test(k)); if (bad.length) { leak = bad; child.kill("SIGKILL"); } });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 30000).unref(); }, timeoutMs);
    child.on("error", (e) => { err += `\nspawn error: ${e.message}`; });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ exitCode: code, signal, stdout: out, stderr: err, timedOut, procNames, leak, durationMs: Date.now() - t0 }); });
  });
}
/** Pure-ish: the due jobs, in order (read-only; the lock re-checks). */
function dueJobs(factory, caps, ms) {
  const qd = path.join(factory, "queue"); let names = []; try { names = fs.readdirSync(qd).filter((f) => /\.json$/.test(f)); } catch { return []; }
  const B = LIB("budget.cjs"), out = [];
  for (const n of names) {
    const job = readJ(path.join(qd, n)); if (!job || jobProblem(job) || `${job.jobId}.json` !== n) continue;
    const st = readJ(path.join(factory, "var", "jobs", `${job.jobId}.json`)); if (st && ["done", "failed", "budget-stop", "auth-failed"].includes(st.status)) continue;
    if (job.notBefore && Date.parse(job.notBefore) > ms) continue;
    if (!B.roleEnabled(caps, job.role, ms).ok || windowRefusal(caps, job.role, ms)) continue;
    out.push(job);
  }
  return out.sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.createdAt).localeCompare(String(b.createdAt)));
}
function modelFor(caps, job) {
  const m = (caps.roles[job.role] && caps.roles[job.role].model) || "opus";
  if (!/^(opus|fable)$/.test(m)) throw new Error(`caps.json roles.${job.role}.model must be the alias opus or fable`);
  if (m === "fable" && NEVER_FABLE.has(job.role)) throw new Error(`Fable is never used for ${job.role}`);
  return m;
}
async function runJob(job) {
  const caps = loadCaps(), now = nowMs(), jp = jobProblem(job); if (jp) { console.error("agent-run: REFUSED job — " + jp); return 2; }
  const model = modelFor(caps, job), tp = CR().tokenProblem(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  if (tp) { console.error("agent-run: AUTH — " + tp); return 77; }
  const template = fs.readFileSync(path.join(FACTORY, job.prompt.file), "utf8");
  const b = locked("begin", { role: job.role, jobId: job.jobId, model, nowMs: now });
  if (!b.go) { console.log(`agent-run: ${b.exit === 0 ? "nothing to do" : b.exit === 75 ? "PARKED" : "REFUSED"} — ${b.reason}`); return b.exit; }
  const prompt = render(template, job, b.resume ? { RUN_NOTE: `RESUMED RUN: the previous attempt (session ${b.sessionId}) was stopped by a usage limit. Continue; do not redo finished work.` } : { RUN_NOTE: "" });
  const argv = buildArgv({ job, model, prompt, caps, sessionId: b.sessionId, resume: b.resume }), env = CR().childEnv(process.env, { home: os.userInfo().homedir });
  console.log(`agent-run: ${job.jobId} (${job.role}) attempt ${b.attempt}${b.resume ? " resuming" : ""} · model ${model} · stage ${b.stage} · week spent $${b.spentUsd.toFixed(2)} of $${b.capUsd.toFixed(2)} · cap this job $${b.worstUsd} · token length ${process.env.CLAUDE_CODE_OAUTH_TOKEN.length}`);
  const runDir = V("runs", job.jobId, `a${b.attempt}-${new Date(now).toISOString().replace(/[:.]/g, "").slice(0, 15)}`); fs.mkdirSync(runDir, { recursive: true });
  writeJ(path.join(runDir, "request.json"), { job: job.jobId, role: job.role, model, cwd: FACTORY, resume: b.resume, sessionId: b.sessionId, envNames: Object.keys(env).sort(), argv: argv.map((x) => (x === prompt ? `<prompt ${prompt.length} chars sha256 ${sha(prompt)}>` : x)) });
  const r = await runChild(argv, env, (Number(caps.roles[job.role].timeoutMin) || 60) * 60000);
  const L = LIB("limit.cjs");
  let outcome = L.classify({ exitCode: r.exitCode, signal: r.signal, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, nowMs: nowMs(), tz: "America/Denver" });
  if (r.leak) outcome = { class: "error", kind: "env-leak", attempt: true, line: "the child's environment carried " + r.leak.join(", "), result: null };
  const res = L.parseResult(r.stdout) || {};
  let oc = null;
  if (outcome.class === "ok") { oc = checkOutput(FACTORY, job); if (!oc.ok) { outcome = { ...outcome, class: "error", kind: "output-invalid", attempt: true, line: oc.problems.slice(0, 4).join("; ") }; try { if (fs.existsSync(oc.file)) fs.renameSync(oc.file, `${oc.file}.invalid-a${b.attempt}-${Date.now()}`); } catch { /* left */ } } }
  fs.writeFileSync(path.join(runDir, "stdout.txt"), String(r.stdout).slice(0, 4e6)); fs.writeFileSync(path.join(runDir, "stderr.txt"), String(r.stderr).slice(-65536));
  const mu = res.modelUsage && typeof res.modelUsage === "object" ? res.modelUsage : null;
  writeJ(path.join(runDir, "outcome.json"), { ...outcome, exitCode: r.exitCode, signal: r.signal, durationMs: r.durationMs, procEnvNames: r.procNames, outputCheck: oc });
  const f = locked("finish", { rid: b.rid, planWeek: b.planWeek, role: job.role, jobId: job.jobId, model, modelsUsed: mu ? Object.keys(mu) : [], usage: res.usage || null, modelUsageCost: CR().modelUsageCost(mu), outcome, nowMs: nowMs(), durationMs: r.durationMs, sessionId: b.sessionId, exitCode: r.exitCode });
  console.log(`agent-run: ${job.jobId} -> ${outcome.class}${outcome.kind ? "/" + outcome.kind : ""} · $${CR().costOrNull(res.total_cost_usd) ?? "?"} · ${Math.round(r.durationMs / 1000)} s${outcome.line ? " · " + String(outcome.line).slice(0, 160) : ""}`);
  if (r.procNames) console.log(`agent-run: child env (from /proc, names only): ANTHROPIC vars: ${r.procNames.some((k) => /^ANTHROPIC/i.test(k)) ? "PRESENT" : "none"}`);
  return f.exit;
}
function parseArgs(argv) {
  const modes = [], o = { mode: null, job: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], val = () => { const v = argv[++i]; if (v == null || v.startsWith("--")) throw new Error(`${a} needs a value`); return v; };
    if (["--next", "--status", "--selftest", "--print-argv"].includes(a)) modes.push(a.slice(2));
    else if (a === "--job") { if (o.job) throw new Error("give --job once"); o.job = val(); if (!JOB.test(o.job)) throw new Error("bad --job id"); }
    else if (a === "--locked-op") { modes.push("locked-op"); o.op = val(); }
    else throw new Error(`unknown argument ${JSON.stringify(a)} — nothing was done`);
  }
  if (modes.length > 1) throw new Error("give one mode");
  o.mode = modes[0] || (o.job ? "job" : null);
  if (!o.mode) throw new Error("give --next, --job <id>, --print-argv --job <id>, --status or --selftest");
  if (o.mode === "print-argv" && !o.job) throw new Error("--print-argv needs --job <id>");
  if (["next", "status", "selftest"].includes(o.mode) && o.job) throw new Error("--job goes alone or with --print-argv");
  return o;
}
async function main() {
  let o; try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error("agent-run: " + e.message); return 2; }
  if (o.mode === "selftest") return selftest() ? 0 : 1;
  if (o.mode === "locked-op") { console.log(JSON.stringify(OPS[o.op](JSON.parse(fs.readFileSync(0, "utf8"))))); return 0; }
  if (o.mode === "status") { const caps = loadCaps(), B = LIB("budget.cjs"), led = fs.existsSync(V("budget.jsonl")) ? B.parseLedger(fs.readFileSync(V("budget.jsonl"), "utf8")) : { rows: [], bad: [] }, n = nowMs(); console.log(JSON.stringify({ now: new Date(n).toISOString(), due: dueJobs(FACTORY, caps, n).map((j) => j.jobId), week: B.weekSpend(led.rows, new Date(B.planWeekStart(n, caps.planWeekReset)).toISOString()), capUsd: B.capUsd(caps), stage: (B.rampRow(caps, n) || {}).stage ?? null, window: spendWindow(caps, n) }, null, 1)); return led.bad.length ? 1 : 0; }
  if (!TEST && !process.env.INVOCATION_ID) { console.error("agent-run: REFUSED — run only through systemd (traids-w6-fagent.service), so the token comes from EnvironmentFile=/etc/traids/claude.env"); return 2; }
  const caps = loadCaps(), now = nowMs();
  let job;
  if (o.mode === "next") { const due = dueJobs(FACTORY, caps, now); if (!due.length) { console.log("agent-run: nothing due"); return 0; } job = due[0]; }
  else { job = readJ(path.join(FACTORY, "queue", `${o.job}.json`)); if (!job) { console.error(`agent-run: no queue/${o.job}.json`); return 2; } }
  if (o.mode === "print-argv") { const jp = jobProblem(job); if (jp) { console.error("agent-run: " + jp); return 2; } const p = render(fs.readFileSync(path.join(FACTORY, job.prompt.file), "utf8"), job, { RUN_NOTE: "" }), a = buildArgv({ job, model: modelFor(caps, job), prompt: p, caps, sessionId: "00000000-0000-4000-8000-000000000000" }); console.log(JSON.stringify({ job: job.jobId, argv: a.map((x) => (x === p ? `<prompt ${p.length} chars>` : x)), envNames: Object.keys(CR().childEnv(process.env, { home: os.homedir() })).sort() }, null, 1)); return 0; }
  return runJob(job);
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + String(d).slice(0, 300) : "")); } };
  const J = (o) => ({ spec: "w6-job-v1", prompt: { file: `prompts/${o.role}.md`, vars: {} }, ...o });
  const build = J({ jobId: "build-F0007", role: "build", fId: "F0007", output: "work/F0007/signal.cjs" });
  const caps = { roles: { build: { maxBudgetUsd: 65, maxTurns: 400 }, triage: { maxBudgetUsd: 3 }, review: { maxBudgetUsd: 12 }, refuter: { maxBudgetUsd: 12 }, registrar: { maxBudgetUsd: 5 } } };
  const a = buildArgv({ job: build, model: "opus", prompt: "P", caps, sessionId: "S", factory: "/F" }), at = (f) => a[a.indexOf(f) + 1];
  const allow = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools")), deny = a.slice(a.indexOf("--disallowedTools") + 1);
  ok("build argv: dontAsk, prompts none, $65, strict empty MCP, project settings only, the role's settings file, session id", a[0] === "-p" && a[1] === "P" && at("--permission-mode") === "dontAsk" && at("--permission-prompts") === "none" && at("--max-budget-usd") === "65" && a.includes("--strict-mcp-config") && /mcp-none\.json$/.test(at("--mcp-config")) && at("--setting-sources") === "project" && /build\.settings\.json$/.test(at("--settings")) && at("--session-id") === "S");
  ok("build: writes ONLY its own work/F0007/**; Bash ONLY node --check of its signal and fcode check-signal F0007; every node eval form denied", allow.filter((x) => /^Edit\(/.test(x)).join() === "Edit(/work/F0007/**)" && allow.filter((x) => /^Bash\(/.test(x)).join("|") === "Bash(node --check work/F0007/signal.cjs)|Bash(node bin/fcode.cjs check-signal F0007)" && EVAL_DENY.every((x) => deny.includes(x)) && deny.includes("Agent") && deny.includes("WebFetch"));
  ok("no role has a bare Read / Edit / Write / Bash allow, an interpreter wildcard, or a bypass token", ROLES.every((role) => { const p = profile(J({ jobId: `${role}-x`, role, fId: "F0001", item: "2026-10-12-equities-X", k: 1, output: "x" })); return !p.allow.some((r) => /^(Read|Edit|Write|Bash)$|^Bash\(node \*\)|^Bash\(\*/.test(r)); }) && !a.some((x) => /bypass|dangerously|skip-permissions|^--bare$/i.test(x)));
  ok("only triage has web tools; only build has Bash; every role denies Agent / Task / NotebookEdit / mcp__*", ROLES.every((role) => { const p = profile(J({ jobId: `${role}-x`, role, fId: "F0001", item: "2026-10-12-equities-X", k: 2, output: "x" })); return (role === "triage") === p.allow.includes("WebFetch") && (role === "build") === !p.deny.includes("Bash") && ["Agent", "Task", "NotebookEdit", "mcp__*"].every((d) => p.deny.includes(d)); }));
  ok("the refuter writes only out/refute/<F>-r<k>.json; the registrar only out/register/<item>.json", profile(J({ jobId: "refute-F0003-r2", role: "refuter", fId: "F0003", k: 2, output: "x" })).allow.includes("Edit(/out/refute/F0003-r2.json)") && profile(J({ jobId: "reg-x", role: "registrar", item: "2026-10-12-equities-AB_C", output: "x" })).allow.includes("Edit(/out/register/2026-10-12-equities-AB_C.json)"));
  ok("jobProblem: well-formed jobs pass; a foreign output path, a bad F id, a non-role, a prompt outside prompts/ are refused", jobProblem(build) === null && /own path/.test(jobProblem({ ...build, output: "state/factory-registry.json" }) || "") && /F id/.test(jobProblem({ ...build, fId: "R313" }) || "") && /not an agent role/.test(jobProblem({ ...build, role: "scout" }) || "") && /prompt\.file/.test(jobProblem({ ...build, prompt: { file: "../x.md" } }) || "") && jobProblem(J({ jobId: "triage-2026-10-12-equities", role: "triage", output: "out/triage/2026-10-12-equities.json" })) === null);
  ok("render: fills job fields and vars; an unfilled field throws", render("Do {{F}} -> {{OUTPUT}} {{X}}", { ...build, prompt: { file: "prompts/build.md", vars: { X: "y" } } }) === "Do F0007 -> work/F0007/signal.cjs y" && (() => { try { render("{{NOPE}}", build); return false; } catch { return true; } })());
  const W = { windows: { roles: { triage: [["18:15", "06:00"]], build: [["22:30", "06:00"]] }, spend: [{ from: "22:30", to: "01:00", capUsd: 143 }, { from: "01:00", to: "06:00", capUsd: 68.6 }] } };
  const MT = (d, h, m) => Date.parse(`${d}T00:00:00Z`) + ((h + 6) * 60 + m) * 60000;   // MDT = UTC-6
  ok("windows: build refused at 21:00 and 06:10 MT, allowed 23:00 and 05:50; triage allowed 18:20", /22:30-06:00/.test(windowRefusal(W, "build", MT("2026-10-15", 21, 0)) || "") && windowRefusal(W, "build", MT("2026-10-15", 23, 0)) === null && windowRefusal(W, "build", MT("2026-10-16", 5, 50)) === null && /launches only/.test(windowRefusal(W, "build", MT("2026-10-16", 6, 10)) || "") && windowRefusal(W, "triage", MT("2026-10-15", 18, 20)) === null && /no window/.test(windowRefusal(W, "review", MT("2026-10-15", 23, 0)) || ""));
  const sw1 = spendWindow(W, MT("2026-10-15", 23, 30)), sw2 = spendWindow(W, MT("2026-10-16", 2, 0));
  ok("spend windows: 23:30 MT -> 22:30-01:00 ($143, from 22:30 to 01:00); 02:00 -> 01:00-06:00 ($68.6); 12:00 -> none", sw1 && sw1.capUsd === 143 && sw1.from === MT("2026-10-15", 22, 30) && sw1.to === MT("2026-10-16", 1, 0) && sw2.capUsd === 68.6 && sw2.from === MT("2026-10-16", 1, 0) && spendWindow(W, MT("2026-10-16", 12, 0)) === null);
  const Bstub = { runCost: (r) => Math.max(r.total_cost_usd || 0, r.modelUsageCostUsd || 0) };
  const rows = [{ kind: "reserve", rid: "a", ts: new Date(MT("2026-10-15", 22, 40)).toISOString(), maxBudgetUsd: 65 }, { kind: "run", rid: "a", ts: new Date(MT("2026-10-15", 23, 50)).toISOString(), total_cost_usd: 40.5 }, { kind: "reserve", rid: "b", ts: new Date(MT("2026-10-16", 0, 10)).toISOString(), maxBudgetUsd: 65 }, { kind: "run", rid: "z", ts: new Date(MT("2026-10-15", 20, 0)).toISOString(), total_cost_usd: 99 }];
  ok("window spend: a finished build (its larger cost 40.5) + an open reservation (its worst case 65) = 105.5; a run before the window is not counted", windowSpend(rows, sw1.from, sw1.to, Bstub) === 105.5);
  ok("model: opus by default; fable refused for build / review / refuter / registrar; triage may follow caps", modelFor({ roles: { build: {} } }, build) === "opus" && (() => { try { modelFor({ roles: { build: { model: "fable" } } }, build); return false; } catch (e) { return /never used/.test(e.message); } })() && modelFor({ roles: { triage: { model: "fable" } } }, { role: "triage" }) === "fable");
  const P = (s) => { try { return parseArgs(s.split(" ").filter(Boolean)); } catch (e) { return { err: e.message }; } };
  ok("args: --next / --job / --print-argv --job / --status; unknown flags refused; a bad job id refused", P("--next").mode === "next" && P("--job build-F0001").job === "build-F0001" && P("--print-argv --job build-F0001").mode === "print-argv" && /unknown argument/.test(P("--force").err || "") && /bad --job/.test(P("--job ../x").err || "") && /needs --job/.test(P("--print-argv").err || ""));
  console.log(`agent-run selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}
if (require.main === module) main().then((c) => { process.exitCode = c; }, (e) => { console.error("agent-run: CRASH — " + (e && e.stack || e)); process.exitCode = 1; });
module.exports = { profile, buildArgv, jobProblem, render, windowRefusal, spendWindow, windowSpend, checkOutput, dueJobs, modelFor, parseArgs, ROLES, EVAL_DENY };
