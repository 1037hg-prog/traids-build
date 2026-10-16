#!/usr/bin/env node
/**
 * SEAT WAVE — the escrowed seats run themselves every session. 2026-09-01.
 *
 * Operator's decision ("1 2 3"): automate the seats. Until today the ONLY way a seat produced its
 * daily output was a human invoking it by hand inside a Claude Code session. The synthesis seat
 * (head-trader, HT1) needs 20 memo-days to read and had 2 after four days of the seats existing.
 * An architecture with 27 seats and no clock accrues nothing.
 *
 * WHAT RUNS. The bundled Claude Code binary, headless (-p), one seat at a time, in a fixed order:
 * the brake first, construction second, the three book seats, and the synthesis seat LAST so it
 * reads what the others wrote tonight. Sequential on purpose — head-trader's inputs are the other
 * seats' outputs, and parallel runs would race on the ledgers.
 *
 * WHAT EVERY SEAT MUST DO BEFORE IT STOPS — enforced by the charge and VERIFIED here:
 *   1. seal exactly one NAMED / SIZED / DATED / FALSIFIABLE claim via backend/seal-claim.js
 *   2. record its intervention via backend/agent-ledger.js
 * A seat that ran and sealed nothing gets ONE follow-up turn (--continue) telling it so. If it
 * still has not sealed, that is recorded as a failure — seat-seal-accrual.js will fail the chain
 * on it tomorrow, which is the correct outcome. The wave never seals on a seat's behalf: a claim
 * the seat did not make is not the seat's record.
 *
 * WHAT IT NEVER DOES. Places no orders. Every seat's permission surface is the agent definition's
 * own tool list; lib/agent-book.js throws on any write aimed at the measurement book. Runs only on
 * a day the close chain actually finished (so: no Saturday, no holiday), and never twice a day.
 *
 * COST. Six runs a session, five on sonnet and one (head-trader) on opus, each capped by
 * --max-budget-usd and a wall-clock timeout. The whole wave is capped too, so it cannot run into
 * the evening: the operator's 5pm MT job stop stands.
 *
 * Output: data/seat-wave-status.json (latest) · data/seat-wave-history.jsonl (append) ·
 *         automation/seat-wave.log
 * Usage:  node automation/seat-wave.cjs [--only <seat>] [--dry] [--force]
 *
 * ── SERVER PORT — PENDING (2026-10-02) ─────────────────────────────────────────────────────────────────────────────────
 * This file is automation/seat-wave.pending-server.cjs. It is NOT live: automation/seat-wave.cjs stays the wave until the
 * operator promotes this copy over it. House rule — one home for registry/ledger state: the wave moves to the server only
 * together with the close chain and backend/data (phase 2+), so the server unit (deploy/server/traids-seat-wave.*) ships
 * DISABLED. Until then this copy runs nowhere.
 *
 *   SAME        seats, charges, order, budgets, per-seat timeouts, the 85-minute wave cap, both guards (the close chain
 *               finished today; never twice a day), the seal / ledger verification, the one follow-up turn, the status and
 *               history files, the exit code. The SEATS block keeps its exact shape: backend/seat-seal-accrual.js reads the
 *               seat list out of the wave's source text.
 *   SAME ON WINDOWS  the binary search (now automation/claude-bin.cjs: same candidates, same order, same refusal) and the
 *               spawn argv + options, byte for byte. Checked by deploy/server/tests/seat-wave-parity.cjs, which runs this
 *               file and the live one in a sandbox with a recording spawn (no claude is ever started) and compares.
 *   NEW 1  Linux/macOS discovery via claude-bin.cjs resolve() (CLAUDE_BIN, command -v, ~/.local/bin, ~/.claude/local,
 *          npm -g) plus `claude --version` up front, so a broken install refuses before the first seat.
 *   NEW 2  PERMISSIONS OFF WINDOWS. The Windows argv keeps `--permission-mode bypassPermissions` — unchanged, because the
 *          port must not change the live argv (operator decision pending: keep that parity, or move the PC to the allow-list
 *          after a supervised `--permissions allowlist` trial). `--permissions legacy` is REFUSED on any other platform
 *          (exit 2), so no flag, wrapper edit or hand run can put a bypass on the server. Everywhere else a seat runs on an
 *          allow-list of ENTRY POINTS, per seat — never an interpreter (`Bash(node *)` matched `node -e`, `node -p`, `node -`
 *          and `node /tmp/x.js`: arbitrary code as user traids):
 *              shared   Read Grep Glob "Bash(node backend/seal-claim.js *)" "Bash(node backend/agent-ledger.js --record *)"
 *                       "Bash(node backend/lib/reconcile.js)"
 *              own      the seat's own output file (Edit(<file>)), the agent-book CLI for the four seats authorized on the
 *                       agent book (deploy/server/seat-tools/agent-book-cli.cjs), backend/ht-memo-archive.js for head-trader
 *              denied   web tools, every node eval / preload form, the measurement book, the registry, tasty-*, code and
 *                       configuration paths, secret files, /proc, and the claude.ai connector in .claude/settings.local.json
 *          plus --setting-sources project (no user or local settings: the operator's interactive approvals and the tracked
 *          settings.local.json do not reach a seat) and --strict-mcp-config (no MCP server). Allow-list mode also appends a
 *          short TOOLS ON THIS HOST note to the prompt, because the agent definitions tell the book seats to require()
 *          lib/agent-book.js inline, which the allow-list refuses. The systemd unit is the second layer (no secrets in the
 *          environment, home read-only, the measurement files read-only). `--print-permission-args [--seat <s>]` prints the
 *          allow-list argv one per line, so deploy/server/smoke-test.sh probes the REAL seat surface.
 *          `--permissions legacy|allowlist` overrides the platform default on Windows, so the allow-list can be trialled on
 *          the PC under supervision.
 *   NEW 4  STATE-HOME GATE IN THE SCRIPT. Off Windows, a non --dry run refuses (exit 1) unless TRAIDS_STATE_HOME=server, so
 *          a hand run of the promoted file (`node automation/seat-wave.cjs --force`) cannot skip the phase gate that
 *          deploy/server/run-seat-wave.sh applies.
 *   NEW 3  USAGE-LIMIT GUARD. If a seat's output says the Claude account / session limit is reached ("You've hit your
 *          session limit · resets 8:50pm", seen in automation/nightly-audit.log in September), no later seat can run
 *          either, so the wave STOPS: the remaining seats are listed as skipped "usage limit", seat-wave-status.json carries
 *          stopped {reason "usage-limit", seat, line}, the exit code is 1, and the operator is alerted ONCE per session via
 *          backend/notify.js (dedupe state: data/seat-wave-alerts.json). A stopped wave still counts as this session's wave
 *          (the never-twice guard is unchanged); --force re-runs it after the limit resets. On the server the wave's unit
 *          carries no Telegram token (it would be readable by the seats), so this in-process send records "NOT delivered"
 *          and the alert goes out from traids-alert@.service (OnFailure=, the one unit that loads alerts.env), which reads
 *          the stopped line from data/seat-wave-status.json.
 *   ZONES  The session date is ET through Intl (etDay), never the host zone; log stamps are UTC ISO. The server units also
 *          pin TZ=UTC so nothing can lean on the host zone by accident.
 *
 * Usage:  node automation/seat-wave.pending-server.cjs [--only <seat>] [--dry] [--force] [--permissions legacy|allowlist]
 *         node automation/seat-wave.pending-server.cjs --selftest     (no spawn, no files: detector + argv known answers)
 *         node automation/seat-wave.pending-server.cjs --print-permission-args [--seat <seat>]   (allow-list argv, one per line)
 */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const claudeBin = require("./claude-bin.cjs");
const ROOT = path.join(__dirname, "..");
const D = (f) => path.join(ROOT, "backend", "data", f);
const LOG = path.join(__dirname, "seat-wave.log");
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : null; };
const DRY = argv.includes("--dry"), FORCE = argv.includes("--force"), ONLY = arg("only");
const WIN = process.platform === "win32";
const PERMS = arg("permissions") || (WIN ? "legacy" : "allowlist");

const log = (s) => { const line = `[${new Date().toISOString()}] ${s}`; console.log(line); try { fs.appendFileSync(LOG, line + "\n"); } catch {} };
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return d; } };
const etDay = (v = Date.now()) => new Date(typeof v === "number" ? v : Date.parse(v)).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const TODAY = etDay();

// ── the binary: automation/claude-bin.cjs (Windows: the search this file used to carry, unchanged) ──

// ── the seats, in order. head-trader LAST. ──
const SEATS = [
  { seat: "risk-governor", minutes: 12, budget: 2.0,
    charge: "Answer your one question for the NEXT session: may the book open another ticket tomorrow? Read data/portfolio-risk.jsonl, data/circuit-breaker.json, data/risk-policy.json and data/pooling-audit.json. Update data/risk-governor.json. Your sealed claim is kind 'halt' with direction 'allow' or 'halt' for tomorrow's session, falsifier stated in session P&L terms, window closes at tomorrow's 16:05 ET (--closes sessions:1)." },
  { seat: "portfolio-constructor", minutes: 12, budget: 2.0,
    charge: "Propose tomorrow's construction for the paper book: weights by class and factor group, concentration you would cap, and the real risk versus stated risk. Read data/portfolio-risk.jsonl, the cluster ledger and data/pooling-audit.json. Your sealed claim is kind 'construction' with a magnitude (your proposed gross risk as a fraction of capital) and a falsifier in realised risk-adjusted terms, window --closes sessions:5." },
  { seat: "news-trader", minutes: 12, budget: 2.0,
    charge: "Read today's news stamps (data/news-stamp.json, data/news-fetch.json) and R85's state (data/news-gate.json if present). You remain ESCROWED: no live news-conditioned trade. Your sealed claim is kind 'news' naming ONE instrument and direction for tomorrow's session that your conditioning would take, with the falsifier stated in R, window --closes sessions:1." },
  { seat: "stop-manager", minutes: 12, budget: 2.0,
    charge: "Read today's exits from the canonical ledger via backend/lib/reconcile.js and the R54 twin state (data/r54-stop-twin.json). You remain ESCROWED HARDEST. Your sealed claim is kind 'exit' naming ONE open ticket by id and the exit variant you would apply, with the falsifier stated in R versus the board's own stop, window --closes sessions:3." },
  { seat: "portfolio-manager", minutes: 15, budget: 2.5,
    charge: "Write tomorrow's allocation order-of-operations for the agent book and act on it through backend/lib/agent-book.js where your charter allows (attribution agent 'portfolio-manager'; the mechanical factor-cap arm runs separately and is NOT yours to duplicate). Append your plan to data/portfolio-manager-plans.jsonl. Your sealed claim is kind 'allocation' naming the first ticket you would open tomorrow with direction and a magnitude in risk dollars, falsifier in R, window --closes sessions:3." },
  { seat: "head-trader", minutes: 18, budget: 4.0, model: "opus",
    charge: "Write tonight's desk memo for session " + TODAY + " exactly per your definition, reading every seat's output written tonight (data/risk-governor.json, data/seat-claims.jsonl, data/portfolio-manager-plans.jsonl, data/agent-book.json, the gate reads, data/pooling-audit.json FIRST). Write data/ht-memo-seal.json (backend/ht-memo-archive.js banks it). Your sealed claim is the WOULD-DO: kind 'would-do', ONE named instrument, direction, magnitude in risk dollars, falsifier = D_d fails the HT1 bar, window --closes sessions:1." },
];

const COMMON = (seat) => `
It is the post-close seat wave for session ${TODAY}. You are running headless with no operator present.

BEFORE YOU STOP you MUST do both of these, in this order, from the repo root:
  1. Seal exactly ONE claim:
       node backend/seal-claim.js --seat ${seat} --kind <kind> --subject "<named subject>" --direction <dir> [--magnitude <n>] --falsifier "<what would prove you wrong>" --closes sessions:N --links <ids>
     The sealer REFUSES hedged wording (consider/monitor/watch/may/might), missing size, or a window already closed. If refused, restate and retry. Do not stop until it prints "sealed".
  2. Record your intervention:
       node backend/agent-ledger.js --record --agent ${seat} --kind MEASUREMENT --target "<file or test>" --what "<one line>"
     Use --kind TRADING only if you opened or closed an agent-book ticket.

STANDING RULES. Paper only; place no orders. Never write to board_positions.json or trade_log.json. All JSON writes through node scripts, never PowerShell or heredocs. Ledger figures only via backend/lib/reconcile.js. Effective N is sessions or episodes, never tickets. Every number you quote is read from its file tonight. Keep the run short: read what you need, write your outputs, seal, record, stop.
`;

// ── permissions (NEW 2). legacy = the live Windows argv, byte for byte (refused off Windows); allowlist = entry points ──
/**
 * The allow-list IS the confinement off Windows, so it names entry points, never an interpreter. Anything not allowed is
 * refused without a prompt (-p cannot ask). A deny rule beats an allow rule from any source, so the eval forms stay shut
 * even if some settings file allows them. Rule semantics are Claude Code's documented ones; deploy/server/smoke-test.sh
 * --with-claude probes this exact argv (node -e, a redirect, a command outside the list) against the installed CLI.
 */
const AGENT_BOOK_CLI = "deploy/server/seat-tools/agent-book-cli.cjs";
const SEAT_SHARED = ["Read", "Grep", "Glob",
  "Bash(node backend/seal-claim.js *)", "Bash(node backend/agent-ledger.js --record *)", "Bash(node backend/lib/reconcile.js)"];
const SEAT_OWN = {   // what each seat's charge needs beyond the shared surface — nothing generic
  "risk-governor":         ["Edit(backend/data/risk-governor.json)"],
  "portfolio-constructor": [],
  "news-trader":           [`Bash(node ${AGENT_BOOK_CLI} *)`],
  "stop-manager":          [`Bash(node ${AGENT_BOOK_CLI} *)`],
  "portfolio-manager":     [`Bash(node ${AGENT_BOOK_CLI} *)`, "Edit(backend/data/portfolio-manager-plans.jsonl)"],
  "head-trader":           [`Bash(node ${AGENT_BOOK_CLI} *)`, "Edit(backend/data/ht-memo-seal.json)", "Bash(node backend/ht-memo-archive.js)"],
};
const SEAT_DISALLOWED = ["WebFetch", "WebSearch", "NotebookEdit",
  // interpreter eval / stdin / preload forms
  "Bash(node -e *)", "Bash(node --eval *)", "Bash(node -p *)", "Bash(node --print *)", "Bash(node -)", "Bash(node - *)",
  "Bash(node --input-type *)", "Bash(node -r *)", "Bash(node --require *)", "Bash(node --import *)", "Bash(node --loader *)",
  "Bash(NODE_OPTIONS=*)", "Bash(env *)", "Bash(node backend/tasty-*)",
  // the measurement book, the registry, live-money arming, code and configuration
  "Edit(backend/data/board_positions.json)", "Edit(backend/data/trade_log.json)", "Edit(backend/data/test-registry.json)",
  "Edit(backend/data/read-seals.json)", "Edit(backend/data/tasty-*)", "Edit(backend/.env)",
  "Edit(.claude/**)", "Edit(automation/**)", "Edit(deploy/**)", "Edit(backend/*.js)", "Edit(backend/lib/**)",
  "Edit(~/.claude/**)", "Edit(~/.ssh/**)", "Edit(~/.bashrc)", "Edit(~/.profile)",
  // secrets a Read could otherwise carry into a sealed claim or an output file
  "Read(backend/.env)", "Read(~/.claude/.credentials.json)", "Read(~/.ssh/**)", "Read(//etc/traids/**)", "Read(//proc/**)",
  // the claude.ai connector pre-approved in the tracked .claude/settings.local.json
  "mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c"];
const seatAllowed = (seat) => [...SEAT_SHARED, ...(SEAT_OWN[seat] || [])];
const permissionArgs = (mode, seat) => (mode === "legacy" ? ["--permission-mode", "bypassPermissions"]
  : ["--setting-sources", "project", "--strict-mcp-config", "--allowedTools", ...seatAllowed(seat), "--disallowedTools", ...SEAT_DISALLOWED]);
/** Allow-list mode only: the agent definitions tell the book seats to require() lib/agent-book.js inline, which is refused here. */
const HOST_TOOLS = (seat) => {
  const own = seatAllowed(seat);
  const writes = own.filter((r) => r.startsWith("Edit(")).map((r) => r.slice(5, -1));
  const cmds = own.filter((r) => r.startsWith("Bash(")).map((r) => "    " + r.slice(5, -1).replace(/ \*$/, " ..."));
  return `
TOOLS ON THIS HOST. An explicit allow-list: anything else is refused without a prompt, so do not retry a refused form.
  Read, Grep, Glob on repo files. Write or Edit ONLY: ${writes.length ? writes.join(", ") : "nothing (your record is the sealed claim and the ledger line)"}.
  Bash ONLY these commands, from the repo root, exactly as shown, one command per call (no pipes, &&, ;, redirection, node -e or temp scripts):
${cmds.join("\n")}${own.includes(`Bash(node ${AGENT_BOOK_CLI} *)`) ? `
  The agent book is ${AGENT_BOOK_CLI} (--help for usage): it calls backend/lib/agent-book.js open() / close() / state() for you.` : ""}
  Put free text in single quotes, and keep $, backticks, < and > out of every argument.
`;
};
const seatArgs = (s, prompt, extraArgs, mode) => ["-p", mode === "allowlist" ? prompt + HOST_TOOLS(s.seat) : prompt, "--agent", s.seat,
  ...permissionArgs(mode, s.seat), "--output-format", "json",
  "--max-turns", "60", "--max-budget-usd", String(s.budget), ...(s.model ? ["--model", s.model] : []), ...extraArgs];

// ── usage-limit detector (NEW 3) ──
/**
 * The CLI's own wording when the plan's limit is hit, as observed and as documented over CLI versions:
 *   "You've hit your session limit · resets 8:50pm (America/Denver)"   (automation/nightly-audit.log, 2026-09)
 *   "Claude AI usage limit reached|1759999999"                         (older CLI)
 *   "5-hour limit reached ∙ resets 3pm" / "Weekly limit reached" / "Opus weekly limit reached" / "out of extra usage"
 * A seat's own prose can mention limits ("position limit reached", "halt: session limit reached"), so a match counts only
 * when the run did not end normally (exit != 0 or is_error) OR the whole result is that one short line in the CLI's shape
 * (it always says when the limit resets, or appends an epoch). The per-seat --max-budget-usd stop ("budget") is NOT an
 * account limit and never matches.
 */
const LIMIT_RE = [
  /you(?:'|’)?ve hit your\b[^\n]{0,40}?\blimit\b/i,
  /\bclaude(?: ai)? usage limit reached\b/i,
  /\b(?:5-hour|five-hour|weekly|opus|sonnet|usage|session) limit reached\b/i,
  /\bout of extra usage\b/i,
];
const CLI_SHAPE = /\bresets?\b|\|\d{9,}/i;
function usageLimitLine({ result, stdout, stderr, isError, status }) {
  const abnormal = status !== 0 || isError === true;
  const res = result == null ? "" : String(result);
  const texts = [res, String(stderr || ""), result == null ? String(stdout || "").slice(-4000) : ""];
  for (const t of texts) for (const line of t.split(/\r?\n/)) {
    const L = line.trim();
    if (!L || !LIMIT_RE.some((re) => re.test(L))) continue;
    if (abnormal || (t === res && res.trim().length <= 200 && CLI_SHAPE.test(L))) return L.slice(0, 300);
  }
  return null;
}

// ── selftest: pure functions only — exits before the guards, the binary search, any spawn and any file write ──
function selftest() {
  let pass = 0, fail = 0;
  const eq = (name, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + "\n       got  " + g + "\n       want " + w); } };
  console.log("seat-wave (pending server port) selftest");
  const hit = (o) => usageLimitLine({ result: null, stdout: "", stderr: "", isError: false, status: 0, ...o });
  eq("limit: observed CLI line, is_error", hit({ result: "You've hit your session limit · resets 8:50pm (America/Denver)", isError: true, status: 1 }), "You've hit your session limit · resets 8:50pm (America/Denver)");
  eq("limit: curly apostrophe, exit 1", hit({ result: "You’ve hit your weekly limit · resets Mon 9am", status: 1 }), "You’ve hit your weekly limit · resets Mon 9am");
  eq("limit: older wording on stderr, no JSON", hit({ result: null, stdout: "", stderr: "Claude AI usage limit reached|1759999999", status: 1 }), "Claude AI usage limit reached|1759999999");
  eq("limit: 5-hour wording as the whole (short) result even with exit 0", hit({ result: "5-hour limit reached ∙ resets 3pm" }), "5-hour limit reached ∙ resets 3pm");
  eq("limit: out of extra usage", hit({ result: "You're out of extra usage · resets 7pm", isError: true, status: 1 }), "You're out of extra usage · resets 7pm");
  eq("no limit: a seat's long successful prose that mentions a session limit", hit({ result: "Sealed. Risk governor: allow. The daily session limit reached 80% of its cap but no breach; " + "x".repeat(220) }), null);
  eq("no limit: a short successful seat result in its own words", hit({ result: "Sealed halt: session limit reached." }), null);
  eq("no limit: position limit reached (a trading phrase) even on error", hit({ result: "position limit reached for ES", isError: true, status: 1 }), null);
  eq("no limit: the per-seat --max-budget-usd stop", hit({ result: "Reached maximum budget ($2.00)", isError: true, status: 1 }), null);
  eq("no limit: a timeout with no output", hit({ result: null, stdout: "", stderr: "", status: null }), null);
  const s0 = SEATS[0], s5 = SEATS[5];
  eq("argv legacy (the live Windows argv) — risk-governor", seatArgs(s0, "P", [], "legacy"),
    ["-p", "P", "--agent", "risk-governor", "--permission-mode", "bypassPermissions", "--output-format", "json", "--max-turns", "60", "--max-budget-usd", "2"]);
  eq("argv legacy — head-trader follow-up turn", seatArgs(s5, "P", ["--resume", "sid"], "legacy"),
    ["-p", "P", "--agent", "head-trader", "--permission-mode", "bypassPermissions", "--output-format", "json", "--max-turns", "60", "--max-budget-usd", "4", "--model", "opus", "--resume", "sid"]);
  const al = seatArgs(s0, "P", [], "allowlist");
  eq("argv allowlist — risk-governor: entry points + its own file, eval forms denied, no bypass mode", al,
    ["-p", "P" + HOST_TOOLS("risk-governor"), "--agent", "risk-governor", "--setting-sources", "project", "--strict-mcp-config",
     "--allowedTools", "Read", "Grep", "Glob", "Bash(node backend/seal-claim.js *)", "Bash(node backend/agent-ledger.js --record *)",
     "Bash(node backend/lib/reconcile.js)", "Edit(backend/data/risk-governor.json)",
     "--disallowedTools", ...SEAT_DISALLOWED, "--output-format", "json", "--max-turns", "60", "--max-budget-usd", "2"]);
  eq("allowlist argv carries no bypass / skip-permissions token", al.filter((x) => /bypass|dangerously|skip-permissions/i.test(x)), []);
  const generic = /^(Bash|Edit|Write|NotebookEdit)$|^Bash\((node|sh|bash|cd|env|npx|npm|cat|tee|cp|mv)( \*)?\)$|^Bash\(\*|^(Edit|Write)\([^)]*\*/;
  eq("no seat's allow-list holds an interpreter, a bare Bash/Edit/Write, or a wildcard write path",
    SEATS.map((s) => [s.seat, seatAllowed(s.seat).filter((r) => generic.test(r))]).filter(([, bad]) => bad.length), []);
  eq("every node eval / stdin / preload form is denied",
    ["Bash(node -e *)", "Bash(node --eval *)", "Bash(node -p *)", "Bash(node --print *)", "Bash(node -)", "Bash(node - *)", "Bash(node --input-type *)", "Bash(node -r *)", "Bash(node --require *)", "Bash(node --import *)"].filter((r) => !SEAT_DISALLOWED.includes(r)), []);
  eq("write surface per seat", Object.fromEntries(SEATS.map((s) => [s.seat, seatAllowed(s.seat).filter((r) => r.startsWith("Edit("))])),
    { "risk-governor": ["Edit(backend/data/risk-governor.json)"], "portfolio-constructor": [], "news-trader": [], "stop-manager": [],
      "portfolio-manager": ["Edit(backend/data/portfolio-manager-plans.jsonl)"], "head-trader": ["Edit(backend/data/ht-memo-seal.json)"] });
  eq("agent-book CLI only for the four seats lib/agent-book.js authorizes", SEATS.filter((s) => seatAllowed(s.seat).includes(`Bash(node ${AGENT_BOOK_CLI} *)`)).map((s) => s.seat),
    ["news-trader", "stop-manager", "portfolio-manager", "head-trader"]);
  eq("no allowed path is also denied (a deny would silently beat it)", SEATS.flatMap((s) => seatAllowed(s.seat)).filter((r) => SEAT_DISALLOWED.includes(r)), []);
  eq("the allow-list prompt note is appended only in allowlist mode", [seatArgs(s0, "P", [], "legacy")[1], seatArgs(s0, "P", [], "allowlist")[1].startsWith("P\nTOOLS ON THIS HOST.")], ["P", true]);
  eq("platform default: win32 -> legacy, else allowlist", [WIN ? "legacy" : "allowlist"], [process.platform === "win32" ? "legacy" : "allowlist"]);
  eq("seat order unchanged, head-trader last", SEATS.map((s) => s.seat), ["risk-governor", "portfolio-constructor", "news-trader", "stop-manager", "portfolio-manager", "head-trader"]);
  console.log(`seat-wave selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}
if (argv.includes("--selftest")) process.exit(selftest() ? 0 : 1);
if (argv.includes("--print-permission-args")) {
  const seat = arg("seat") || "risk-governor";
  if (!Object.prototype.hasOwnProperty.call(SEAT_OWN, seat)) { console.error(`--seat must be one of ${Object.keys(SEAT_OWN).join(", ")} (got ${seat})`); process.exit(2); }
  console.log(permissionArgs("allowlist", seat).join("\n"));
  process.exit(0);
}
if (!["legacy", "allowlist"].includes(PERMS)) { console.error(`--permissions must be legacy or allowlist (got ${PERMS})`); process.exit(2); }
if (PERMS === "legacy" && !WIN) { console.error(`--permissions legacy (--permission-mode bypassPermissions) exists only for Windows argv parity — refused on ${process.platform}`); process.exit(2); }
if (!WIN && !DRY && process.env.TRAIDS_STATE_HOME !== "server") {
  log(`SEAT WAVE REFUSED — TRAIDS_STATE_HOME=${process.env.TRAIDS_STATE_HOME || "unset"}: backend/data's home is not this host (phase 1). Nothing run.`);
  process.exit(1);
}

// ── guards ──
const chain = rd("chain-status.json", null);
const chainDay = chain && chain.finished ? etDay(chain.finished) : null;
if (!FORCE && chainDay !== TODAY) { log(`SKIP — close chain has not finished today (last finished ${chain ? chain.finished : "never"}); no session to run seats on.`); process.exit(0); }
const prior = rd("seat-wave-status.json", null);
if (!FORCE && !ONLY && prior && prior.session === TODAY && prior.completed) { log(`SKIP — wave already completed for ${TODAY}.`); process.exit(0); }

const SEALS_BEFORE = () => { try { return fs.readFileSync(D("seat-claims.jsonl"), "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const sealedToday = (seat) => SEALS_BEFORE().filter((r) => r.seat === seat && r.session === TODAY).length;

// Windows: find() — the exact search the live file runs, no extra spawn. Elsewhere: resolve() also runs `claude --version`.
const BIN = WIN ? claudeBin.find() : claudeBin.resolve();
const EXE = BIN.path;
const WAVE_CAP_MS = 85 * 60 * 1000;
const t0 = Date.now();
log(`SEAT WAVE ${TODAY} — exe ${EXE} · ${DRY ? "DRY RUN" : "live"} · ${ONLY ? "only " + ONLY : SEATS.length + " seats"}`);
if (!WIN) log(`  claude ${BIN.version} (${BIN.how}) · platform ${process.platform}`);
if (PERMS !== "legacy" || !WIN) log(`  permissions: ${PERMS}${PERMS === "allowlist" ? ` — per-seat entry points (shared ${SEAT_SHARED.join(", ")}); ${SEAT_DISALLOWED.length} deny rules; --setting-sources project --strict-mcp-config` : " — --permission-mode bypassPermissions"}`);

function runSeat(s, extraArgs, prompt, minutes) {
  const args = seatArgs(s, prompt, extraArgs, PERMS);
  if (DRY) { log(`  dry: ${s.seat} would run ${minutes}m budget $${s.budget}`); return { ok: true, dry: true }; }
  const r = spawnSync(EXE, args, { cwd: ROOT, encoding: "utf8", timeout: minutes * 60 * 1000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  // A SPAWN failure and a seat that ran and exited non-zero are different facts; "EXIT null" conflated
  // them on 2026-09-09 and cost an hour of reading. Name the spawn error where it happens.
  if (r.error && !/ETIMEDOUT/.test(String(r.error.code || r.error))) log(`  ${s.seat} — SPAWN FAILED (${r.error.code || r.error.message}) using exe ${EXE}`);
  const limit = usageLimitLine({ result: j ? j.result : null, stdout: r.stdout, stderr: r.stderr, isError: j ? j.is_error : null, status: r.status });
  return { ok: r.status === 0, status: r.status, spawnError: r.error ? String(r.error.code || r.error.message) : null,
    timedOut: !!r.error && /ETIMEDOUT/.test(String(r.error.code || r.error)), cost: j ? j.total_cost_usd : null,
    turns: j ? j.num_turns : null, sessionId: j ? j.session_id : null, stderr: (r.stderr || "").slice(-600), result: j ? String(j.result || "").slice(0, 400) : (r.stdout || "").slice(-400),
    limit };
}

const results = [];
let STOP = null;   // set once a seat reports the account/session usage limit; every later seat is skipped
for (const s of SEATS) {
  if (ONLY && s.seat !== ONLY) continue;
  if (STOP) { log(`  USAGE LIMIT — ${s.seat} not run`); results.push({ seat: s.seat, skipped: "usage limit" }); continue; }
  if (Date.now() - t0 > WAVE_CAP_MS) { log(`  WAVE CAP — ${s.seat} not run, 85 minutes elapsed`); results.push({ seat: s.seat, skipped: "wave cap" }); continue; }
  const before = sealedToday(s.seat);
  log(`  ${s.seat} — start (sealed today before: ${before})`);
  const st = Date.now();
  let r = runSeat(s, [], s.charge + "\n" + COMMON(s.seat), s.minutes);
  let sealed = sealedToday(s.seat) - before;
  let retried = false;
  if (!DRY && sealed < 1 && r.sessionId && !r.limit) {
    retried = true;
    log(`  ${s.seat} — ran but sealed nothing; one follow-up turn`);
    const r2 = runSeat(s, ["--resume", r.sessionId], `You did not seal a claim. Seal exactly ONE now with node backend/seal-claim.js --seat ${s.seat} ... (NAMED, SIZED, DATED, FALSIFIABLE, --closes sessions:N), then record with backend/agent-ledger.js, then stop.`, 6);
    r.cost = (r.cost || 0) + (r2.cost || 0);
    sealed = sealedToday(s.seat) - before;
    if (r2.limit) r.limit = r2.limit;
  }
  if (r.limit) STOP = { reason: "usage-limit", seat: s.seat, at: new Date().toISOString(), line: r.limit };
  const secs = Math.round((Date.now() - st) / 1000);
  const row = { seat: s.seat, ok: r.ok, sealed, retried, secs, cost: r.cost, turns: r.turns, timedOut: r.timedOut || false, exit: r.status, note: r.result, stderr: r.ok ? undefined : r.stderr,
    usageLimit: r.limit || undefined };
  results.push(row);
  log(`  ${s.seat} — ${r.ok ? "ok" : "EXIT " + r.status}${r.timedOut ? " TIMEOUT" : ""} · sealed ${sealed} · ${secs}s · $${r.cost == null ? "?" : r.cost.toFixed(2)}`);
  if (r.limit) log(`  ${s.seat} — USAGE LIMIT: "${r.limit}" — the wave stops here; no later seat can run on this account until the limit resets`);
}

const out = { spec: "seat-wave-v1", session: TODAY, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString(), exe: EXE, dry: DRY,
  completed: !ONLY, seats: results, sealedSeats: results.filter((r) => r.sealed >= 1).length, ranSeats: results.filter((r) => !r.skipped).length,
  totalCost: +results.reduce((s, r) => s + (r.cost || 0), 0).toFixed(2), totalMinutes: +((Date.now() - t0) / 60000).toFixed(1),
  verifiedBy: "backend/seat-seal-accrual.js fails the close chain on any seat that acted without sealing; this file reports, that file enforces.",
  stopped: STOP || undefined, platform: process.platform, permissions: PERMS, exeVersion: BIN.version || undefined };
if (!DRY) {
  fs.writeFileSync(D("seat-wave-status.json"), JSON.stringify(out, null, 1));
  fs.appendFileSync(D("seat-wave-history.jsonl"), JSON.stringify(out) + "\n");
}
log(`WAVE DONE — ${out.sealedSeats}/${out.ranSeats} seats sealed · $${out.totalCost} · ${out.totalMinutes} min${STOP ? " · STOPPED: usage limit (" + STOP.seat + ")" : ""}`);

/**
 * ALERT ONCE per session. The state is written after the send attempt with the delivery result; a later run the same
 * session (--force) re-alerts only if the earlier send did not go through. notify() never throws into the caller.
 */
function alertUsageLimitOnce(stop) {
  const ALERTS = "seat-wave-alerts.json";
  const st = rd(ALERTS, {}) || {};
  if (st.usageLimit && st.usageLimit.session === TODAY && st.usageLimit.sent) {
    log(`  usage-limit alert already sent for ${TODAY} (${st.usageLimit.sentAt}) — not repeated`);
    return Promise.resolve();
  }
  const notRun = results.filter((r) => r.skipped === "usage limit").map((r) => r.seat);
  const title = "TRAIDS — seat wave stopped: Claude usage limit";
  const msg = `${TODAY}: ${stop.seat} reported the account/session limit and the wave stopped.\n"${stop.line}"\n` +
    `sealed ${out.sealedSeats}/${out.ranSeats}` + (notRun.length ? ` · not run: ${notRun.join(", ")}` : "") +
    `\nhost ${require("os").hostname()} · the wave counts as run for this session; re-run after the reset with --force.`;
  const save = (sent, why) => {
    try { fs.writeFileSync(D(ALERTS), JSON.stringify({ ...st, usageLimit: { session: TODAY, seat: stop.seat, line: stop.line, sent, why: why || undefined, sentAt: new Date().toISOString() } }, null, 1)); }
    catch (e) { log(`  usage-limit alert state not written: ${e.message}`); }
  };
  let notify;
  try { ({ notify } = require(path.join(ROOT, "backend", "notify.js"))); }
  catch (e) { log(`  usage-limit alert NOT sent — backend/notify.js did not load: ${e.message}`); save(false, "notify.js did not load"); return Promise.resolve(); }
  return Promise.resolve()
    .then(() => notify(title, msg, { priority: "high", tags: "warning" }))
    .then((ok) => { log(`  usage-limit alert ${ok ? "sent" : "NOT delivered (see [notify] lines)"}`); save(!!ok, ok ? null : "notify returned false"); },
          (e) => { log(`  usage-limit alert failed: ${e && e.message}`); save(false, String(e && e.message).slice(0, 120)); });
}

const EXIT = (out.ranSeats && out.sealedSeats < out.ranSeats) || STOP ? 1 : 0;
if (STOP && !DRY) alertUsageLimitOnce(STOP).then(() => process.exit(EXIT), () => process.exit(EXIT));
else process.exit(EXIT);
