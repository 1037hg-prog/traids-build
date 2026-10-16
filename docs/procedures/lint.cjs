#!/usr/bin/env node
/**
 * PROCEDURES LINT — keeps docs/procedures/ usable by ANY model and in step with the skill files it was written from.
 * 2026-10-11, operator: "make it so any llm can operate"; "it needs to be ready for codex first".
 *
 * docs/procedures/*.md are the house rituals as plain steps a model with no vendor-specific tool can follow from a shell. Each one
 * was written from a skill file under .claude/skills/ (or a workflow script under .claude/workflows/), which stays where it is.
 * This file FAILS (exit 1) when:
 *   claude-only            a procedure names a mechanism only one vendor's tool has (the Workflow / Skill / Agent tools, a capitalised
 *                          Agent or Task to spawn, an agent type, AskUserQuestion, TodoWrite, the built-in tools by name — Bash tool,
 *                          Read tool, WebFetch, WebSearch, NotebookEdit, ExitPlanMode, run_in_background, --permission-mode — plan
 *                          mode, the auto-memory, an mcp__ tool name, the claude program in any spelling (claude, claude.exe,
 *                          claude.cmd, "the claude CLI"), CLAUDE.md, a slash command of a ritual or a built-in one (/loop, /schedule,
 *                          /compact …), a saved workflow called by name, the scratchpad, MEMORY.md, the vendor or its maker by name)
 *                          anywhere except on a line that starts with "Claude Code note:". Lower-case "claude" is legal in one
 *                          place only: as a value in a list of providers (claude | codex | …);
 *   missing-reference      a procedure references a script, file, folder or npm script that does not exist (a path with a placeholder
 *                          such as <date> is checked up to its last fixed folder; a switch file — …-OFF, …-HALT, …-LIVE-ARMED,
 *                          TRAIDS_STOP — is there or not by design and is never required). Checked: every path under a top folder of
 *                          the repo wherever it stands; in a COMMAND (a code-block line or inline code that starts node / npm / npx)
 *                          the script whatever its folder, with backslashes read as slashes, and npm test / start / stop / restart
 *                          like npm run; and inline code that is ONE file name or path (`GONE.md`, `dist/index.html`): from the
 *                          repo root, a bare file name anywhere under the root or a top folder. The three pages a newcomer starts
 *                          from (AGENTS.md, docs/handover/CODEX-SETUP.md, docs/handover/TAKEOVER-DRILL.md) are checked for this
 *                          too, and only for this: they are about a vendor's tool and may name it;
 *   short-path             a path is written as lib/… or data/… instead of from the repo root, so it cannot be checked;
 *   source-drift           a source file's sha256 differs from the one recorded in docs/procedures/sources.json — the skill changed, so
 *                          its procedure must be reviewed (then: --record <procedure>.md "<what you checked>");
 *   source-missing         a recorded source file is gone;
 *   no-procedure           a ritual in .claude/skills (or a script in .claude/workflows) is the source of no procedure;
 *   unrecorded-procedure   a procedure file is not listed in sources.json;   missing-procedure-file   a listed one is gone;
 *   no-source-line         a procedure does not name its source on a "Claude Code note:" line near its top;
 *   structure              a procedure lacks one of its six sections, has a purpose longer than two lines, or steps without numbers
 *                          or without a command;
 *   stub                   the public stub of a local-only procedure says more than that the procedure exists and where;
 *   local-missing / local-drift   a local-only procedure is gone from docs/handover/memory-local-only/ (docs/handover/export-memory.cjs
 *                          rewrites that folder on every run), or differs from the recorded text;
 *   agents-md              AGENTS.md is missing, is larger than Codex reads by default (32,768 bytes), or does not list a procedure;
 *   sources-unreadable     sources.json cannot be read (nothing can be checked: that is a failure, never a pass).
 * Two whole-tree absences are NOT failures, and the last line says so: no .claude/ on this host (nothing to drift from), and no
 * docs/handover/memory-local-only/ on this host (that folder never leaves the operator's machine).
 *
 *   node docs/procedures/lint.cjs                       check; last line "PROCEDURES OK (n files)" exit 0, or "PROCEDURES FAIL …" exit 1
 *   node docs/procedures/lint.cjs --json                the same, as JSON
 *   node docs/procedures/lint.cjs --record <procedure>.md "<note>"   AFTER reviewing THAT procedure against its changed source: record
 *                                                       its new hashes, and only its own. One note stands for one review: every other
 *                                                       procedure whose source changed stays failing until it is recorded itself (a
 *                                                       source two procedures share is recorded for each of them separately)
 *   node docs/procedures/lint.cjs --record "<note>"     the same without a name: only when at most ONE procedure has changed; refused
 *                                                       when several have (review 2026-10-11: one note used to bless them all)
 *   node docs/procedures/lint.cjs --record --all "<note>"   every changed procedure at once — for when each one was reviewed
 *   node docs/procedures/lint.cjs --selftest            every failure above proven on fixtures in a temp folder; ends "N passed, 0 failed"
 *   (--root <dir> points any of them at another copy of the repo; the selftest uses it.)
 * Reads only, except --record, which writes docs/procedures/sources.json through backend/lib/atomic-write.js.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto"), cp = require("child_process");

const REPO = path.resolve(__dirname, "..", "..");
const PROC = "docs/procedures", SOURCES = PROC + "/sources.json", LOCAL = "docs/handover/memory-local-only";
const SECTIONS = ["Purpose", "When to use it", "Fences", "Steps", "How to know it worked", "What to record and where"];
const NOTE_RE = /^\s*(?:[-*>]\s+)*Claude Code note:/;
const CODEX_DOC_LIMIT = 32768;      // Codex's documented default project_doc_max_bytes (32 KiB) for AGENTS.md
const STUB_MAX_LINES = 12, PURPOSE_MAX_LINES = 2, SOURCE_LINE_WITHIN = 8, MIN_NOTE = 10;
const ALSO_REFERENCES = ["AGENTS.md", "docs/handover/CODEX-SETUP.md", "docs/handover/TAKEOVER-DRILL.md"];   // checked for dead references only
const TOPS = ["backend", "automation", "docs", "deploy", "mcp", "src", "assessment-agents", ".claude"];
const PATH_RE = /(?<![\w.\/\\~<>{}*-])(?:\.\/)?((?:backend|automation|docs|deploy|mcp|src|assessment-agents|\.claude)\/[A-Za-z0-9_.<>*{}\/-]*)/g;
const SHORT_RE = /(?<![\w.\/\\~<>{}*-])((?:lib|data)\/[A-Za-z0-9_.<>*{}-]+)/g;
const PLACEHOLDER_RE = /[<>*{}]|YYYY|NNN/;
const SWITCH_RE = /(?:-OFF|-HALT|-LIVE-ARMED)$|(?:^|\/)TRAIDS_STOP$/;
const NPM_RE = /\bnpm run ([A-Za-z0-9:_-]+)/g;
// a command: a code-block line, or inline code, that starts node / npm / npx (after any VAR=value before it)
const TOPS_RE = /^(?:backend|automation|docs|deploy|mcp|src|assessment-agents|\.claude)\//;
const CMD_RE = /^(node|npm|npx)(?:\.exe|\.cmd)?(?:\s+|$)/;
const ENV_PREFIX_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;
const INLINE_RE = /`([^`]+)`/g;
const NODE_NO_SCRIPT = new Set(["-e", "--eval", "-p", "--print", "-i", "--interactive", "-v", "--version", "-h", "--help"]);   // the code is given inline, or nothing is started
const NODE_FLAG_WITH_VALUE = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "-C", "--conditions"]);
const NOT_FROM_ROOT_RE = /^(?:[A-Za-z]:|\/|~|\$|%)/;    // a drive, an absolute or home path, a variable: cannot be checked from the repo root
const SHORT_START_RE = /^(?:lib|data)\//;                // the short-path rule reports these
const NPM_LIFECYCLE_RE = /\bnpm (test|start|stop|restart)\b(?![\w:-])/g;   // each needs its script in package.json, like npm run
const NPM_LIFECYCLE = new Set(["test", "start", "stop", "restart"]);
const NPM_FLAG_WITH_VALUE = new Set(["--prefix", "-C", "-w", "--workspace", "--registry", "--cache", "--userconfig", "--loglevel"]);
const NPM_BUILTINS = new Set(["install", "i", "add", "ci", "uninstall", "remove", "rm", "un", "update", "up", "ls", "list", "exec", "x", "init", "create", "version", "view", "info", "show", "audit", "outdated", "link", "pack", "publish", "config", "cache", "prune", "rebuild", "dedupe", "doctor", "help", "root", "prefix", "why", "explain", "fund", "pkg", "search", "login", "logout", "whoami", "run", "run-script", "access", "token", "owner", "ping", "query", "sbom", "set", "get"]);
// inline code that is ONE file name or path: it ends in a file extension (`.log` is left out: console.log is not a file), or is a folder (dist/)
// (a name that starts with a dot is a tool's own configuration — .mcp.json, .codex/config.toml — there or not by design: not required)
const FILE_TOKEN_RE = /^[A-Za-z0-9_][A-Za-z0-9_@.\\\/-]*$/;
const FILE_EXTS = ["md", "json", "jsonl", "js", "cjs", "mjs", "jsx", "html", "bat", "cmd", "sh", "ps1", "ics", "txt", "csv"];   // the kinds of file this repo's pages name
const FILE_EXT_RE = new RegExp("\\.(?:" + FILE_EXTS.join("|") + ")$", "i");
const WALK_SKIP = new Set(["node_modules", ".git"]);

/** the slash commands the vendor's tool has built in (a slash command per ritual name is added at run time) */
const BUILTIN_SLASH = ["loop", "schedule", "compact", "clear", "init", "review", "agents", "mcp", "model", "config", "memory", "resume"];
/** lower-case "claude" is the vendor's program. Legal in ONE place: as a value in a list of providers, beside another provider's name */
const PROVIDERS = "codex|gemini|ollama|none";
const IN_PROVIDER_LIST = new RegExp(`(?<![\\w.\\/-])claude(?=\\s*\\|\\s*(?:${PROVIDERS})\\b)|(?<=\\b(?:${PROVIDERS})\\s*\\|\\s*)claude(?![\\w\\/-]|\\.\\w)`, "g");
const lowerCaseVendor = (text) => /(?<![\w.\/])claude(?![\w\/])/.test(text.replace(IN_PROVIDER_LIST, ""));   // not inside a longer word or a path (.claude/skills/…)

/** the mechanisms only one vendor's tool has. [label, pattern or (line) => boolean] — the slash commands and the workflow names are added at run time */
const MECHANISMS = [
  ["the Workflow tool", /\bWorkflow\b/],
  ["a saved workflow (run automation/orchestrate.cjs, or follow the steps by hand)", /\bsaved workflows?\b/i],
  ["a skill (name the procedure file instead)", /(?<![\w\/.-])skills?\b(?![\w\/])/i],
  ["the Agent / Task tool", /\bAgent tool\b|\bAgent\s*\(|\bTask tool\b|\bsubagent_type\b|\bgeneral-purpose\b/],
  ["a capitalised Agent / Task as a thing to start (say: an independent model run)", /(?<=[a-z0-9,;:]\s)(?:Agents?|Tasks?)\b(?!\s+(?:Scheduler|Manager)\b)/],
  ["an agent type (give the role's text in the prompt instead)", /\bagent[- ]types?\b/i],
  ["a subagent / background agent", /\bsub-?agents?\b|\bbackground agents?\b/i],
  ["AskUserQuestion", /\bAskUserQuestion\b/],
  ["TodoWrite", /\bTodoWrite\b/],
  ["a built-in tool of one vendor by its name", /\b(?:Bash|Read|Write|Edit|Grep|Glob|Monitor)\s+tool\b|\b(?:WebFetch|WebSearch|NotebookEdit|ExitPlanMode|EnterPlanMode|MultiEdit|ToolSearch|run_in_background)\b|--permission-mode\b/],
  ["plan mode", /\bplan mode\b/i],
  ["the vendor's auto-memory", /\bauto-?memory\b/i],
  ["an MCP tool by its vendor name", /\bmcp__\w+/],
  ["the claude CLI", /\bclaude\s+(?:-p\b|--[a-z])|\bclaude\.(?:cmd|exe|ps1)\b|\bclaude setup-token\b|\bclaude (?:CLI|cli)\b/],
  ["the vendor's program by name (lower-case claude is legal only as a value in a list of providers)", lowerCaseVendor],
  ["the vendor by name", /\bClaude\b/],
  ["the vendor's own instruction file", /\bCLAUDE(?:\.local)?\.md\b/],
  ["the vendor's maker by name", /\banthropic\b/i],
  ["the scratchpad", /\bscratchpad\b/i],
  ["the vendor's memory index", /\bMEMORY\.md\b/],
];
const mentions = (test, text) => (typeof test === "function" ? test(text) : test.test(text));

const posix = (p) => String(p).replace(/\\/g, "/");
const sha = (text) => crypto.createHash("sha256").update(String(text).replace(/\r\n/g, "\n")).digest("hex");
const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const isDir = (f) => { try { return fs.statSync(f).isDirectory(); } catch { return false; } };
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** every ritual source on this host: .claude/skills/<name>/SKILL.md and .claude/workflows/<name>.js -> [{ path, name }] (null: no .claude/ here) */
function ritualSources(root) {
  if (!isDir(path.join(root, ".claude"))) return null;
  const out = [], sk = path.join(root, ".claude", "skills"), wf = path.join(root, ".claude", "workflows");
  if (isDir(sk)) for (const d of fs.readdirSync(sk).sort()) if (isFile(path.join(sk, d, "SKILL.md"))) out.push({ path: `.claude/skills/${d}/SKILL.md`, name: d });
  if (isDir(wf)) for (const f of fs.readdirSync(wf).sort()) if (/\.js$/.test(f) && isFile(path.join(wf, f))) out.push({ path: `.claude/workflows/${f}`, name: f.replace(/\.js$/, "") });
  return out;
}
/** the ritual names a slash command could carry: from the folders on this host and from the recorded source paths */
function ritualNames(rituals, recorded) {
  const names = new Set((rituals || []).map((r) => r.name));
  for (const p of recorded) { const m = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(p) || /^\.claude\/workflows\/([^/]+)\.js$/.exec(p); if (m) names.add(m[1]); }
  return [...names].sort();
}
const slashRe = (names) => (names.length ? new RegExp("(?<![\\w\\/.:-])\\/(?:" + names.map(escRe).join("|") + ")\\b(?![\\w\\/.-])") : null);
/** the names of the workflow scripts (on this host and in the record): "the workflow <name>" / "the <name> workflow" calls one by name */
function workflowNames(rituals, recorded) {
  const out = new Set();
  for (const p of [...(rituals || []).map((r) => r.path), ...recorded]) { const m = /^\.claude\/workflows\/([^/]+)\.js$/.exec(p); if (m) out.add(m[1]); }
  return [...out].sort();
}
const workflowRe = (names) => (names.length ? new RegExp("\\bworkflows?\\s+(?:named\\s+|called\\s+)?[\"'`]?(?:" + names.map(escRe).join("|") + ")\\b(?![\\w\\/.-])|(?<![\\w\\/.-])(?:" + names.map(escRe).join("|") + ")[\"'`]?\\s+workflow\\b", "i") : null);

/** the words of a command line: quoted runs kept whole, the quotes dropped */
const words = (cmd) => (String(cmd).match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^(["'])(.*)\1$/, "$2"));
/** the script a node command starts (the first word that is not a flag or a flag's value), or null when the code is given inline */
function nodeScript(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (NODE_NO_SCRIPT.has(a)) return null;
    if (NODE_FLAG_WITH_VALUE.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}
/** every file name under the repo root and its top folders (node_modules and .git left out) — built once per run, only when a bare name needs it */
function fileNames(root) {
  const out = new Set();
  const walk = (dir) => { let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const e of ents) { if (e.isDirectory()) { if (!WALK_SKIP.has(e.name)) walk(path.join(dir, e.name)); } else out.add(e.name); } };
  let top; try { top = fs.readdirSync(root, { withFileTypes: true }); } catch { top = []; }
  for (const e of top) { if (!e.isDirectory()) out.add(e.name); else if (TOPS.includes(e.name)) walk(path.join(root, e.name)); }
  return out;
}

/** the lines of a markdown text with their fence state -> [{ n, text, fence: null | "" | "text" | …, heading: "Steps" | null }] */
function scan(text) {
  const out = []; let fence = null;
  for (const [i, raw] of String(text).split(/\r?\n/).entries()) {
    const m = /^\s*```\s*([A-Za-z0-9_-]*)\s*$/.exec(raw);
    if (m) { if (fence === null) { fence = m[1] || ""; out.push({ n: i + 1, text: raw, fence: "open", heading: null }); } else { fence = null; out.push({ n: i + 1, text: raw, fence: "close", heading: null }); } continue; }
    const h = fence === null ? /^##\s+(.+?)\s*$/.exec(raw) : null;
    out.push({ n: i + 1, text: raw, fence, heading: h ? h[1] : null });
  }
  return out;
}
/** the sections of a scanned text: name -> its lines (between its "## " heading and the next) */
function sectionsOf(lines) {
  const out = new Map(); let cur = null;
  for (const l of lines) { if (l.heading) { cur = l.heading; if (!out.has(cur)) out.set(cur, []); continue; } if (cur) out.get(cur).push(l); }
  return out;
}

/**
 * check one copy of the repo. -> { files, checked: [paths], problems: [{ file, line, rule, msg }], notes: [text] }
 * Never throws for a missing or broken input: that is a problem in the list (a check that could not be made is never a pass).
 */
function lint(root = REPO) {
  const problems = [], notes = [], checked = [];
  const bad = (file, line, rule, msg) => problems.push({ file, line: line || 0, rule, msg });
  const abs = (rel) => path.join(root, rel);

  const srcText = readText(abs(SOURCES));
  let S = null;
  if (srcText == null) bad(SOURCES, 0, "sources-unreadable", "the file is missing or cannot be read — nothing can be checked against it");
  else { try { S = JSON.parse(srcText); } catch (e) { bad(SOURCES, 0, "sources-unreadable", `not valid JSON (${String(e.message).slice(0, 80)})`); } }
  if (S && (typeof S.procedures !== "object" || S.procedures === null || Array.isArray(S.procedures))) { bad(SOURCES, 0, "sources-unreadable", "no \"procedures\" map"); S = null; }
  const P = S ? S.procedures : {}, allowAbsent = new Set(Object.keys((S && S.allowAbsent) || {}).map(posix));

  const rituals = ritualSources(root), hasLocal = isDir(abs(LOCAL));
  if (rituals === null) notes.push("no .claude/ on this host: the drift and coverage checks were SKIPPED (the procedures are the only copy here)");
  if (!hasLocal) notes.push(`no ${LOCAL}/ on this host: the local-only procedures were SKIPPED (that folder never leaves the operator's machine)`);
  const recordedPaths = Object.values(P).flatMap((e) => Object.keys((e && e.sources) || {}));
  const SLASH = slashRe([...new Set([...ritualNames(rituals, recordedPaths), ...BUILTIN_SLASH])].sort());
  const WORKFLOW = workflowRe(workflowNames(rituals, recordedPaths));
  let pkgScripts = null; { const t = readText(abs("package.json")); if (t != null) { try { pkgScripts = Object.keys(JSON.parse(t).scripts || {}); } catch { pkgScripts = null; } } }
  let NAMES = null; const anywhere = (name) => { if (NAMES === null) NAMES = fileNames(root); return NAMES.has(name); };

  /** why a path from the repo root (forward slashes) is a dead reference, or null */
  const dead = (tok) => {
    if (allowAbsent.has(tok) || SWITCH_RE.test(tok)) return null;   // a switch file is there or not by design (and a LIVE-ARMED one must not be)
    if (tok.startsWith(".claude/") && rituals === null) return null;
    if ((tok === LOCAL || tok.startsWith(LOCAL + "/")) && !hasLocal) return null;
    const ph = PLACEHOLDER_RE.exec(tok);
    if (ph) { const fixed = tok.slice(0, tok.lastIndexOf("/", ph.index) + 1); return fixed && !isDir(abs(fixed)) ? `${tok}: the folder ${fixed} does not exist` : null; }
    return fs.existsSync(abs(tok)) ? null : `${tok} does not exist`;
  };
  /** a path as a command or inline code gives it -> from the repo root with forward slashes, or null when another rule reports it or it cannot be checked from here */
  const fromRoot = (given) => {
    const p = posix(given).replace(/^\.\//, "");
    if (!p || NOT_FROM_ROOT_RE.test(p) || SHORT_START_RE.test(p)) return null;     // not under the repo root; or the short-path rule's
    if (TOPS_RE.test(p) && !String(given).includes("\\")) return null;             // written with forward slashes under a top folder: the path rule above reports it
    return p;
  };
  /** the script of a node / npx command, and an npm word that is neither an npm command nor a script */
  const checkCommand = (rel, n, cmd) => {
    const w = words(cmd.replace(ENV_PREFIX_RE, "")), m = CMD_RE.exec(w.length ? w[0] + " " : "");
    if (!m) return false;
    const args = w.slice(1);
    if (m[1] === "npm") {
      const sub = args.find((a, i) => !a.startsWith("-") && !NPM_FLAG_WITH_VALUE.has(args[i - 1]));
      if (sub && /^[a-z][a-z0-9:_-]*$/.test(sub) && !NPM_BUILTINS.has(sub) && !NPM_LIFECYCLE.has(sub)) bad(rel, n, "missing-reference", `npm ${sub}: not an npm command (a script of package.json is started with npm run ${sub})`);
      return true;
    }
    let script = m[1] === "node" ? nodeScript(args) : (args.find((a) => !a.startsWith("-")) || null);
    if (script && m[1] === "npx" && !/^\.{1,2}[\\/]/.test(script) && !/\.[cm]?js$/i.test(script)) script = null;   // npx <package>: not a file of this repo
    const p = script ? fromRoot(script) : null, why = p ? dead(p) : null;
    if (why) bad(rel, n, "missing-reference", why);
    return true;
  };
  /** inline code that is ONE file name or path */
  const checkToken = (rel, n, tok) => {
    if (!FILE_TOKEN_RE.test(tok)) return;
    const folder = /[\\/]$/.test(tok), p0 = posix(tok).replace(/\/+$/, "");
    if (!(FILE_EXT_RE.test(p0) || (folder && !p0.split("/")[0].includes(".")))) return;   // not a file name; a.b.c/ is a site, not a folder
    const p = fromRoot(tok.replace(/[\\/]+$/, "")); if (!p) return;
    if (p.includes("/") || folder) { const why = dead(p); if (why) bad(rel, n, "missing-reference", why); return; }
    if (allowAbsent.has(p) || SWITCH_RE.test(p) || fs.existsSync(abs(p)) || anywhere(p)) return;
    bad(rel, n, "missing-reference", `${p}: no file of that name at the repo root or under ${TOPS.join("/, ")}/`);
  };

  /** mechanisms and references of one markdown file (refsOnly: a page that is ABOUT a vendor's tool — only its references are checked) */
  const checkText = (rel, text, refsOnly = false) => {
    const lines = scan(text);
    for (const l of lines) {
      if (l.fence === "open" || l.fence === "close") continue;
      if (!refsOnly && !NOTE_RE.test(l.text)) {
        for (const [label, test] of MECHANISMS) if (mentions(test, l.text)) bad(rel, l.n, "claude-only", `names ${label} outside a "Claude Code note:" line`);
        if (SLASH && SLASH.test(l.text)) bad(rel, l.n, "claude-only", `names a slash command outside a "Claude Code note:" line`);
        if (WORKFLOW && WORKFLOW.test(l.text)) bad(rel, l.n, "claude-only", `calls a saved workflow by its name outside a "Claude Code note:" line`);
      }
      for (const m of l.text.matchAll(PATH_RE)) { const why = dead(posix(m[1]).replace(/[.,;:]+$/, "")); if (why) bad(rel, l.n, "missing-reference", why); }
      // commands and file names: a code-block line is a command (a ```text block is a prompt quoted verbatim, not commands); outside a block, each inline code
      if (l.fence === null) { for (const m of l.text.matchAll(INLINE_RE)) { const c = m[1].trim(); if (!checkCommand(rel, l.n, c) && !/\s/.test(c)) checkToken(rel, l.n, c); } }
      else if (l.fence !== "text") checkCommand(rel, l.n, l.text.trim());
      if (!refsOnly && l.fence !== "text") for (const m of l.text.matchAll(SHORT_RE)) bad(rel, l.n, "short-path", `${m[1]}: write the path from the repo root (backend/${m[1]}) so that it can be checked`);
      for (const m of l.text.matchAll(NPM_RE)) { if (pkgScripts === null) bad(rel, l.n, "missing-reference", `npm run ${m[1]}: package.json cannot be read`); else if (!pkgScripts.includes(m[1])) bad(rel, l.n, "missing-reference", `npm run ${m[1]}: package.json has no such script`); }
      for (const m of l.text.matchAll(NPM_LIFECYCLE_RE)) { if (pkgScripts === null) bad(rel, l.n, "missing-reference", `npm ${m[1]}: package.json cannot be read`); else if (!pkgScripts.includes(m[1])) bad(rel, l.n, "missing-reference", `npm ${m[1]}: package.json has no "${m[1]}" script`); }
    }
    return lines;
  };
  /** the six sections, the two-line purpose, numbered steps with a command */
  const checkStructure = (rel, lines) => {
    const sec = sectionsOf(lines), names = lines.filter((l) => l.heading).map((l) => l.heading);
    const missing = SECTIONS.filter((s) => !sec.has(s));
    for (const s of missing) bad(rel, 0, "structure", `no "## ${s}" section`);
    if (!missing.length && JSON.stringify(names.filter((n) => SECTIONS.includes(n))) !== JSON.stringify(SECTIONS)) bad(rel, 0, "structure", `the sections are not in the house order (${SECTIONS.join(" · ")})`);
    if (sec.has("Purpose")) { const n = sec.get("Purpose").filter((l) => l.text.trim()).length; if (n < 1 || n > PURPOSE_MAX_LINES) bad(rel, 0, "structure", `the purpose is ${n} lines (it is one or two)`); }
    if (sec.has("Steps")) {
      const st = sec.get("Steps");
      if (!st.some((l) => l.fence === null && /^\d+\.\s/.test(l.text))) bad(rel, 0, "structure", "the steps are not numbered");
      if (!st.some((l) => l.fence === "open" || (l.fence === null && /`[^`]+`/.test(l.text)))) bad(rel, 0, "structure", "the steps name no command or file");
    }
    for (const s of SECTIONS) if (sec.has(s) && !sec.get(s).some((l) => l.text.trim())) bad(rel, 0, "structure", `the "## ${s}" section is empty`);
  };
  const checkSourceLine = (rel, lines, sources) => {
    const top = lines.slice(0, SOURCE_LINE_WITHIN).filter((l) => NOTE_RE.test(l.text)).map((l) => l.text).join("\n");
    for (const s of sources) if (!top.includes(s)) bad(rel, 0, "no-source-line", `its first ${SOURCE_LINE_WITHIN} lines have no "Claude Code note:" line naming ${s}`);
  };

  // the procedure files on disk against the record
  const onDisk = isDir(abs(PROC)) ? fs.readdirSync(abs(PROC)).filter((f) => /\.md$/.test(f)).sort() : [];
  if (!isDir(abs(PROC))) bad(PROC, 0, "missing-procedure-file", "the folder does not exist");
  for (const f of onDisk) {
    const rel = `${PROC}/${f}`, text = readText(abs(rel));
    if (text == null) { bad(rel, 0, "missing-procedure-file", "cannot be read"); continue; }
    checked.push(rel);
    const lines = checkText(rel, text);
    if (f === "README.md") continue;
    const e = P[f];
    if (!e) { if (S) bad(rel, 0, "unrecorded-procedure", `not listed in ${SOURCES} (every procedure names its source there)`); continue; }
    const sources = Object.keys(e.sources || {});
    if (!sources.length) bad(rel, 0, "unrecorded-procedure", `${SOURCES} lists no source for it`);
    checkSourceLine(rel, lines, sources);
    if (e.localOnly) {
      const body = lines.filter((l) => l.text.trim());
      if (!text.includes(e.localOnly)) bad(rel, 0, "stub", `does not say where the local-only procedure is (${e.localOnly})`);
      if (body.length > STUB_MAX_LINES) bad(rel, 0, "stub", `is ${body.length} lines: the public file of a local-only procedure says only that it exists and where (at most ${STUB_MAX_LINES} lines)`);
      if (lines.some((l) => l.fence === "open") || lines.some((l) => l.fence === null && /^\d+\.\s/.test(l.text)) || lines.some((l) => l.heading === "Steps")) bad(rel, 0, "stub", "holds steps or a command block: those belong in the local-only file");
    } else checkStructure(rel, lines);
  }
  for (const [f, e] of Object.entries(P)) {
    const rel = `${PROC}/${f}`;
    if (!onDisk.includes(f)) bad(rel, 0, "missing-procedure-file", `listed in ${SOURCES} but the file is gone`);
    if (AGENTS_TEXT(root) != null && !AGENTS_TEXT(root).includes(rel)) bad("AGENTS.md", 0, "agents-md", `does not list ${rel}`);
    // drift of each source
    if (rituals !== null) for (const [s, want] of Object.entries((e && e.sources) || {})) {
      const t = readText(abs(s));
      if (t == null) bad(rel, 0, "source-missing", `its source ${s} is gone (renamed or deleted)`);
      else if (sha(t) !== want) bad(rel, 0, "source-drift", `its source ${s} changed since it was recorded — review this procedure against it, then: node ${PROC}/lint.cjs --record ${f} "<what you checked>"`);
    }
    // the local-only twin
    if (e && e.localOnly && hasLocal) {
      const lrel = posix(e.localOnly), t = readText(abs(lrel));
      if (t == null) { bad(lrel, 0, "local-missing", `the local-only procedure is gone (docs/handover/export-memory.cjs rewrites ${LOCAL}/ on every run) — restore it from git or a backup, or rewrite it from its source ${Object.keys(e.sources || {}).join(", ")} (that source carries the same material: only a model the operator has approved for it opens it — AGENTS.md section 9)`); continue; }
      checked.push(lrel);
      if (sha(t) !== e.localSha256) bad(lrel, 0, "local-drift", `differs from the recorded text — review it, then: node ${PROC}/lint.cjs --record ${f} "<what you checked>"`);
      const lines = checkText(lrel, t);
      checkSourceLine(lrel, lines, Object.keys(e.sources || {}));
      checkStructure(lrel, lines);
    }
  }
  // every ritual has a procedure
  if (rituals !== null && S) { const have = new Set(recordedPaths); for (const r of rituals) if (!have.has(r.path)) bad(r.path, 0, "no-procedure", `no procedure in ${PROC}/ names this ritual as its source`); }
  // AGENTS.md: there, and small enough for Codex to read whole
  const A = AGENTS_TEXT(root);
  if (A == null) bad("AGENTS.md", 0, "agents-md", "the file is missing: Codex and every other model start from it");
  else { const bytes = Buffer.byteLength(A, "utf8"); if (bytes > CODEX_DOC_LIMIT) bad("AGENTS.md", 0, "agents-md", `is ${bytes} bytes: Codex reads at most ${CODEX_DOC_LIMIT} bytes of instruction files by default and would cut it`); }
  // the pages a newcomer starts from: every file they point at must be there (references only: they may name any vendor's tool)
  const pages = [];
  for (const rel of ALSO_REFERENCES) { const t = rel === "AGENTS.md" ? A : readText(abs(rel)); if (t == null) continue; pages.push(rel); checkText(rel, t, true); }
  AGENTS_CACHE.delete(root);
  return { files: checked.length, checked, pages, problems, notes };
}
const AGENTS_CACHE = new Map();
function AGENTS_TEXT(root) { if (!AGENTS_CACHE.has(root)) AGENTS_CACHE.set(root, readText(path.join(root, "AGENTS.md"))); return AGENTS_CACHE.get(root); }

/** the report as text. -> { text, ok } */
function report(r) {
  const out = [];
  for (const p of r.problems) out.push(`${p.file}${p.line ? ":" + p.line : ""}  ${p.rule}  ${p.msg}`);
  for (const n of r.notes) out.push(`note: ${n}`);
  const ok = r.problems.length === 0;
  const skipped = r.notes.length ? `; ${r.notes.length} whole-tree check(s) SKIPPED, see the note(s)` : "";
  out.push(ok ? `PROCEDURES OK (${r.files} files${skipped})` : `PROCEDURES FAIL (${r.problems.length} problem(s) in ${r.files} files${skipped})`);
  return { text: out.join("\n"), ok };
}

/**
 * record the current hashes (after a review). -> { ok, why?, changed: [paths], procedures: [files recorded], stillChanged: [files NOT
 * recorded whose source changed] }. Refuses without a note, with a source missing, or with a procedure file missing. Writes
 * sources.json through backend/lib/atomic-write.js of the same root.
 * ONE NOTE STANDS FOR ONE REVIEW (review 2026-10-11: one note used to re-hash every changed source of every procedure, so reviewing
 * one procedure silently blessed the drift in all the others):
 *   only: "<procedure>.md"   that procedure's hashes and no other's — the rest stay changed, and the lint keeps failing for them;
 *   neither only nor all     allowed while at most ONE procedure has changed (the note can only be about that one); with several
 *                            changed it is refused and nothing is written;
 *   all: true                every changed procedure — the caller says each one was reviewed.
 */
function record(root, note, now = new Date(), { only = null, all = false } = {}) {
  const no = (why) => ({ ok: false, why, changed: [], procedures: [], stillChanged: [] });
  if (typeof note !== "string" || note.trim().length < MIN_NOTE) return no(`say what you reviewed, in at least ${MIN_NOTE} characters: --record <procedure>.md "<note>"`);
  let S; try { S = JSON.parse(fs.readFileSync(path.join(root, SOURCES), "utf8")); } catch (e) { return no(`${SOURCES} cannot be read (${String(e.message).slice(0, 80)})`); }
  if (!S || typeof S.procedures !== "object" || S.procedures === null) return no(`${SOURCES} has no "procedures" map`);
  if (only != null && all) return no("name ONE procedure, or pass --all: not both — nothing recorded");
  let name = null;
  if (only != null) {
    name = posix(String(only)).trim().replace(/^\.\//, ""); if (name.startsWith(PROC + "/")) name = name.slice(PROC.length + 1);
    if (!Object.prototype.hasOwnProperty.call(S.procedures, name)) return no(`${String(only).slice(0, 80)} is not a procedure listed in ${SOURCES} (listed: ${Object.keys(S.procedures).join(", ")}) — nothing recorded`);
  }
  // what a recording WOULD change, per procedure. Nothing is changed yet: a refusal below must leave the record as it was.
  const pending = new Map(), hasLocal = isDir(path.join(root, LOCAL));
  for (const [f, e] of Object.entries(S.procedures)) {
    if (!isFile(path.join(root, PROC, f))) return no(`${PROC}/${f} is listed but the file is gone — nothing recorded`);
    const list = [];
    for (const s of Object.keys(e.sources || {})) {
      const t = readText(path.join(root, s));
      if (t == null) return no(`the source ${s} of ${f} cannot be read — nothing recorded`);
      const h = sha(t); if (e.sources[s] !== h) list.push({ source: s, hash: h });
    }
    if (e.localOnly && hasLocal) {
      const t = readText(path.join(root, e.localOnly));
      if (t == null) return no(`the local-only procedure ${e.localOnly} is gone — restore it first; nothing recorded`);
      const h = sha(t); if (e.localSha256 !== h) list.push({ local: posix(e.localOnly), hash: h });
    }
    if (list.length) pending.set(f, list);
  }
  const drifted = [...pending.keys()];
  if (!name && !all && drifted.length > 1) return no(`${drifted.length} procedures have a changed source (${drifted.join(", ")}): one note cannot stand for the review of each. Name the one you reviewed — --record <procedure>.md "<note>" — or pass --all if you reviewed every one of them; nothing recorded`);
  const scope = name ? [name] : drifted, changed = [];
  for (const f of scope) for (const c of pending.get(f) || []) { const e = S.procedures[f]; if (c.source) { e.sources[c.source] = c.hash; changed.push(c.source); } else { e.localSha256 = c.hash; changed.push(c.local); } }
  S.reviews = Array.isArray(S.reviews) ? S.reviews : [];
  S.reviews.push({ at: now.toISOString(), note: note.trim(), procedures: scope, changed });
  const { writeJsonAtomic } = require(path.join(root, "backend", "lib", "atomic-write.js"));
  writeJsonAtomic(path.join(root, SOURCES), S);
  return { ok: true, changed, procedures: scope, stillChanged: drifted.filter((f) => !scope.includes(f)) };
}

/**
 * the words after --record -> { only, all, note } or null (not a form of the command: the usage is printed).
 *   "<note>" · <procedure>.md "<note>" · --all "<note>"   (--all may stand anywhere among them)
 * A single word that is a procedure's file name is the NAME with no note — never a note: "nightly-audit.md" is sixteen characters
 * and says nothing of what was reviewed.
 */
const PROC_NAME_RE = /^(?:(?:\.[\\/])?docs[\\/]procedures[\\/])?[A-Za-z0-9_.-]+\.md$/;
function recordArgs(rest) {
  const all = rest.filter((x) => x === "--all").length, pos = rest.filter((x) => x !== "--all");
  if (all > 1 || pos.length > 2 || pos.some((x) => x.startsWith("--"))) return null;
  if (pos.length === 2) return { only: pos[0], all: all === 1, note: pos[1] };
  if (pos.length === 1 && PROC_NAME_RE.test(pos[0])) return { only: pos[0], all: all === 1, note: "" };
  return { only: null, all: all === 1, note: pos[0] || "" };
}

module.exports = { lint, report, record, recordArgs, scan, sectionsOf, sha, ritualSources, words, nodeScript, fileNames, MECHANISMS, BUILTIN_SLASH, FILE_EXTS, NPM_BUILTINS, NPM_FLAG_WITH_VALUE, NODE_NO_SCRIPT, NODE_FLAG_WITH_VALUE, SECTIONS, CODEX_DOC_LIMIT, STUB_MAX_LINES };

// ── selftest: every failure proven on a fixture ──────────────────────────────────────────────────────────────────────────────
function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "traids-proc-lint-"));
  let pass = 0, fail = 0, seq = 0;
  const ok = (name, cond, got) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + " — got " + JSON.stringify(got === undefined ? null : got).slice(0, 700)); } };
  const W = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const R = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const proc = (title, source, extraStep = "") => [
    `# ${title}`, "", `Claude Code note: this is the tool-neutral twin of \`${source}\`; \`node docs/procedures/lint.cjs\` keeps the two in step.`, "",
    "## Purpose", "Do the thing the house way.", "So that the record stays true.", "",
    "## When to use it", "When the operator asks for the thing.", "",
    "## Fences", "- JSON is written only through `backend/lib/atomic-write.js`.", "",
    "## Steps", "1. Run the tool:", "", "```", "node backend/tool.js", "```", "", "2. Write `backend/data/out/<date>.json`.", extraStep, "",
    "## How to know it worked", "The tool prints OK.", "",
    "## What to record and where", "One line in `backend/data/out/`.", "",
  ].join("\n");
  const SKILL_A = "---\nname: alpha\n---\n# Alpha\nDo alpha.\n", SKILL_B = "---\nname: beta\n---\n# Beta\nDo beta.\n", WF = "export const meta = { name: 'loop' }\n";
  const LOCAL_B = proc("Beta (local only)", ".claude/skills/beta/SKILL.md");
  const STUB_B = ["# Beta", "", "Claude Code note: the source is `.claude/skills/beta/SKILL.md`.", "", `This procedure exists and is kept only on the operator's machine: \`${LOCAL}/procedure-beta.md\`.`, ""].join("\n");
  /** a clean fixture repo */
  const fresh = () => {
    const root = path.join(tmp, "r" + (++seq));
    W(root, "AGENTS.md", "# manual\n\nProcedures: docs/procedures/alpha.md docs/procedures/beta.md docs/procedures/loop.md\n");
    W(root, "package.json", JSON.stringify({ scripts: { build: "x" } }));
    W(root, "backend/tool.js", "console.log('OK')\n"); W(root, `${PROC}/lint.cjs`, "// the fixture's stand-in for this file: the procedures name it on their source line\n");
    W(root, "backend/lib/atomic-write.js", fs.readFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"), "utf8"));
    fs.mkdirSync(path.join(root, "backend", "data", "out"), { recursive: true });
    W(root, ".claude/skills/alpha/SKILL.md", SKILL_A); W(root, ".claude/skills/beta/SKILL.md", SKILL_B); W(root, ".claude/workflows/loop.js", WF);
    W(root, `${PROC}/alpha.md`, proc("Alpha", ".claude/skills/alpha/SKILL.md"));
    W(root, `${PROC}/loop.md`, proc("Loop", ".claude/workflows/loop.js"));
    W(root, `${PROC}/beta.md`, STUB_B);
    W(root, `${LOCAL}/procedure-beta.md`, LOCAL_B);
    W(root, SOURCES, JSON.stringify({ schema: "procedure-sources-v1", procedures: {
      "alpha.md": { sources: { ".claude/skills/alpha/SKILL.md": sha(SKILL_A) } },
      "loop.md": { sources: { ".claude/workflows/loop.js": sha(WF) } },
      "beta.md": { sources: { ".claude/skills/beta/SKILL.md": sha(SKILL_B) }, localOnly: `${LOCAL}/procedure-beta.md`, localSha256: sha(LOCAL_B) },
    }, allowAbsent: {}, reviews: [] }, null, 1));
    return root;
  };
  const rules = (r) => r.problems.map((p) => p.rule);
  const only = (r, rule, n = 1) => r.problems.length === n && r.problems.every((p) => p.rule === rule);
  const addStep = (root, file, line) => W(root, file, R(root, file).replace("## How to know it worked", `3. ${line}\n\n## How to know it worked`));

  console.log("procedures lint selftest (fixtures in " + tmp + ")");
  try {
    { const root = fresh(), r = lint(root), rep = report(r);
      ok("a clean set: no problem, 4 files (3 public, 1 local-only), last line PROCEDURES OK (4 files)", r.problems.length === 0 && r.files === 4 && rep.ok && /\nPROCEDURES OK \(4 files\)$/.test("\n" + rep.text) && r.notes.length === 0, [r.problems, rep.text]); }

    // 1. vendor-only mechanisms, each kind, and the exempt line
    const MECH = [
      ["the Workflow tool", "Call Workflow({ name: \"x\" }) and wait."],
      ["a skill", "Then follow the register-test skill."],
      ["the Agent tool", "Spawn it with the Agent tool."],
      ["Agent( call", "Start Agent(prompt) for the reader."],
      ["an agent type", "Use the general-purpose type."],
      ["a subagent", "Hand it to a subagent."],
      ["a background agent", "Hand it to a background agent with the rule quoted."],
      ["AskUserQuestion", "Use AskUserQuestion to get the choice."],
      ["TodoWrite", "Track it with TodoWrite."],
      ["an mcp__ tool name", "Read the account with mcp__alpaca-paper__get_account."],
      ["the claude CLI (print mode)", "Run claude -p \"go\" --output-format text in the repo."],
      ["the claude CLI (a flag)", "Run claude --version first."],
      ["the vendor by name", "Ask Claude to do it."],
      ["the scratchpad", "Save the frames to the scratchpad."],
      ["MEMORY.md", "Check the registry names and MEMORY.md."],
      ["a slash command of a ritual", "Run /alpha when the operator says so."],
      ["a slash command in backticks", "The operator types `/beta now`."],
      ["a slash command of a workflow", "Then (/loop) once."],
    ];
    for (const [name, line] of MECH) { const root = fresh(); addStep(root, `${PROC}/alpha.md`, line); const r = lint(root);
      ok(`claude-only: ${name} in a step fails`, r.problems.length >= 1 && r.problems.every((p) => p.rule === "claude-only" && p.file === `${PROC}/alpha.md` && p.line > 0) && !report(r).ok, r.problems); }
    { const root = fresh(); W(root, `${PROC}/alpha.md`, R(root, `${PROC}/alpha.md`).replace("## How to know it worked", "Claude Code note: Claude runs this as /alpha through Workflow({ name: \"x\" }) with a subagent; `claude -p \"/alpha\"` headless.\n- Claude Code note: the scratchpad and MEMORY.md are its own.\n\n## How to know it worked")); const r = lint(root);
      ok("the same mechanisms on lines that START with \"Claude Code note:\" (a list marker before it is allowed) are not a problem", r.problems.length === 0, r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "As the Claude Code note: says, use Workflow."); const r = lint(root);
      ok("\"Claude Code note:\" in the MIDDLE of a line exempts nothing", r.problems.length >= 2 && r.problems.every((p) => p.rule === "claude-only"), r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Open `docs/procedures/alpha.md`, the workflow script `.claude/workflows/loop.js`, the folder `.claude/skills/alpha/SKILL.md` and http://localhost:3001/alpha/loop; a skilled reader needs no agent."); const r = lint(root);
      ok("not flagged: a path that ends in a ritual name, the lower-case word workflow, a skills/ path, a URL segment, the words skilled and agent", r.problems.length === 0, r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Not commands: ./alpha, C:/alpha/x, the file /alpha.md, the folder /alpha/notes, the word /alpha-beta, x-/loop, and and/or beta."); const r = lint(root);
      ok("not flagged as a slash command: a relative or drive path, a file name, a folder, a longer word, a ritual name after a hyphen or a letter", r.problems.length === 0, r.problems); }
    { const root = fresh(); W(root, `${PROC}/alpha.md`, R(root, `${PROC}/alpha.md`).replace("node backend/tool.js", "claude -p \"/alpha\"")); const r = lint(root);
      ok("a vendor command INSIDE a code block is still flagged", r.problems.length >= 1 && r.problems.every((p) => p.rule === "claude-only"), r.problems); }
    { const root = fresh(); W(root, `${LOCAL}/procedure-beta.md`, LOCAL_B.replace("## How to know it worked", "3. Use TodoWrite.\n\n## How to know it worked")); const S = JSON.parse(R(root, SOURCES)); S.procedures["beta.md"].localSha256 = sha(R(root, `${LOCAL}/procedure-beta.md`)); W(root, SOURCES, JSON.stringify(S)); const r = lint(root);
      ok("a local-only procedure is held to the same rule", only(r, "claude-only") && r.problems[0].file === `${LOCAL}/procedure-beta.md`, r.problems); }
    { const root = fresh(); W(root, `${PROC}/README.md`, "# Procedures\n\nUse the Workflow tool.\n"); const r = lint(root);
      ok("README.md is checked for mechanisms and references too (and counted), but needs no sections and no record", only(r, "claude-only") && r.problems[0].file === `${PROC}/README.md` && r.files === 5, [r.problems, r.files]); }

    // 1b. the vendor-only wording a review found unflagged (2026-10-11): each line, and WHICH rule names it (one problem per rule, in the rules' order)
    const CAP = "a capitalised Agent / Task", TYPE = "an agent type", TOOL = "a built-in tool of one vendor", CLI = "names the claude CLI", LOWER = "the vendor's program by name", FILE = "the vendor's own instruction file", MAKER = "the vendor's maker by name", SLASHED = "names a slash command", SAVED = "a saved workflow (run", BYNAME = "calls a saved workflow by its name";
    const SKILL = "names a skill (name the procedure file instead)", AGENT_TOOL = "names the Agent / Task tool", SUB = "names a subagent / background agent", SCRATCH = "names the scratchpad";
    const MECH2 = [
      ["a capitalised Agent to spawn (the wording of the lens ritual's own source)", "Spawn one Agent with the house preamble and the lens scope.", [CAP]],
      ["a capitalised Task to start", "Start a Task per lens and wait for all of them.", [CAP]],
      ["capitalised Agents after a number", "Then 3 Agents read it, each alone.", [CAP]],
      ["an agent type by its name", "Hand the read to the backtest-auditor agent type.", [TYPE]],
      ["an agent-type, hyphenated", "Pick the agent-type that fits the lens.", [TYPE]],
      ["the claude CLI by that name", "Start it with the claude CLI in the repo folder.", [CLI, LOWER]],
      ["claude.exe", "Run claude.exe with the prompt on standard input.", [CLI, LOWER]],
      ["claude.exe in inline code", "Run `claude.exe -p \"go\"` in the repo.", [CLI, LOWER]],
      ["claude.ps1", "Or start claude.ps1 from the profile folder.", [CLI, LOWER]],
      ["the bare program name in inline code", "Start `claude` in the repo and paste the prompt.", [LOWER]],
      ["lower-case claude in a sentence", "Ask claude to run it.", [LOWER]],
      ["lower-case claude piped into another program (that is not a list of providers)", "Run claude | tee out.log and read what it wrote.", [LOWER]],
      ["lower-case claude as the value of the provider setting in a command", "Set TRAIDS_AGENT_PROVIDER=claude and start the loop.", [LOWER]],
      ["lower-case claude after a provider's name without the list bar", "Use codex or claude for it.", [LOWER]],
      ["lower-case claude in a hyphenated name", "Open the page with claude-in-chrome, or any non-claude browser tool.", [LOWER]],
      ["CLAUDE.md", "The rule is in CLAUDE.md; read it first.", [FILE]],
      ["CLAUDE.local.md", "Put it in CLAUDE.local.md on your machine.", [FILE]],
      ["the vendor's maker by name", "Use Anthropic's own tool for it.", [MAKER]],
      ["the maker's package scope", "Install @anthropic-ai/some-tool first.", [MAKER]],
      ["two built-in slash commands on one line", "Run /compact first, then /clear.", [SLASHED]],
      ["plan mode", "Enter plan mode first.", ["names plan mode"]],
      ["the auto-memory", "Save a note to the auto-memory folder.", ["auto-memory"]],
      ["the automemory, written as one word", "It goes into automemory by itself.", ["auto-memory"]],
      ["--permission-mode", "Pass --permission-mode acceptEdits.", [TOOL]],
      ["a saved workflow", "Call the saved workflow build-check-loop with the args.", [SAVED]],
      ["a workflow called by its name", "Run the workflow loop with these args.", [BYNAME]],
      ["a workflow called by its name, in inline code after \"named\"", "Run the workflow named `loop` now.", [BYNAME]],
      ["a workflow called by its name, the name first", "Start the loop workflow, then wait.", [BYNAME]],
      ...["Bash", "Read", "Write", "Edit", "Grep", "Glob", "Monitor"].map((t) => [`the ${t} tool`, `Use the ${t} tool for this step.`, [TOOL]]),
      ...["WebFetch", "WebSearch", "NotebookEdit", "ExitPlanMode", "EnterPlanMode", "MultiEdit", "ToolSearch", "run_in_background"].map((t) => [t, `Then ${t} does the rest.`, [TOOL]]),
      ...BUILTIN_SLASH.filter((n) => n !== "loop").map((n) => [`the built-in slash command /${n}`, `Then run /${n} once.`, [SLASHED]]),
      // review 2026-10-11 (surviving mutants): the capitalised spellings of three patterns, and four alternatives no line had tried
      ["the Skill tool, with a capital", "Use the Skill tool to load it.", [SKILL]],
      ["a Subagent, with a capital", "Hand it to a Subagent.", [SUB]],
      ["a Background agent, with a capital", "A Background agent does it.", [SUB]],
      ["the Scratchpad, with a capital", "Save it to the Scratchpad.", [SCRATCH]],
      ["the Task tool (named by the tool rule AND by the capitalised-Task rule)", "Use the Task tool.", [AGENT_TOOL, CAP]],
      ["subagent_type", "Set subagent_type to the reader.", [AGENT_TOOL]],
      ["claude.cmd", "Start claude.cmd from the task.", [CLI, LOWER]],
      ["claude setup-token", "Run claude setup-token once.", [CLI, LOWER]],
    ];
    for (const [name, line, want] of MECH2) { const root = fresh(); addStep(root, `${PROC}/alpha.md`, line); const r = lint(root), msgs = r.problems.map((p) => p.msg);
      ok(`claude-only: ${name} in a step fails, named by its own rule`, r.problems.length === want.length && r.problems.every((p) => p.rule === "claude-only" && p.file === `${PROC}/alpha.md` && p.line > 0) && want.every((frag, i) => msgs[i].includes(frag)) && !report(r).ok, r.problems); }
    ok("the built-in slash commands are the twelve a review named", JSON.stringify([...BUILTIN_SLASH].sort()) === JSON.stringify(["agents", "clear", "compact", "config", "init", "loop", "mcp", "memory", "model", "resume", "review", "schedule"]), BUILTIN_SLASH);
    /** a clean fixture with NO ritual named loop (so that /loop can only be the built-in command) */
    const freshNoLoop = () => { const root = fresh(); fs.rmSync(path.join(root, ".claude", "workflows", "loop.js")); fs.rmSync(path.join(root, PROC, "loop.md")); const S = JSON.parse(R(root, SOURCES)); delete S.procedures["loop.md"]; W(root, SOURCES, JSON.stringify(S)); W(root, "AGENTS.md", R(root, "AGENTS.md").replace(" docs/procedures/loop.md", "")); return root; };
    { const root = freshNoLoop(), r0 = lint(root); addStep(root, `${PROC}/alpha.md`, "Start it with /loop 5m."); const r = lint(root);
      ok("the built-in slash command /loop is flagged where no ritual is named loop", r0.problems.length === 0 && r0.files === 3 && only(r, "claude-only") && r.problems[0].msg.includes(SLASHED), [r0.problems, r.problems]); }
    { const root = freshNoLoop(); addStep(root, `${PROC}/alpha.md`, "Run the workflow loop until it is green; a loop workflow is nothing special."); const r = lint(root);
      ok("a workflow is called by name only when that name IS a workflow script here or in the record: without one named loop the same words are plain", r.problems.length === 0, r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "The setting `TRAIDS_AGENT_PROVIDER` = claude | codex | gemini | ollama | none (the default starts nothing); written the other way, codex | claude."); const r = lint(root);
      ok("lower-case claude is legal as a value in a list of providers, before or after another provider's name", r.problems.length === 0, r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Add a Task Scheduler entry for it, or look in the Task Manager. Agents on any model can follow this. Tasks are listed below."); const r = lint(root);
      ok("not flagged: the Windows Task Scheduler and Task Manager, and Agents / Tasks as the first word of a sentence", r.problems.length === 0, r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "No `ANTHROPIC_API_KEY` on the server; `.claude/skills/alpha/SKILL.md` is a path and `.claude` is the folder it is in; claudette and unclaude are longer words; a planning mode, an agent of any type, a tool to read a file, a bash script and background jobs are plain words."); const r = lint(root);
      ok("not flagged: the key's name, a .claude/ path and the folder's name .claude, a longer word that holds claude, and the plain words planning mode, agent of any type, a tool to read, bash script", r.problems.length === 0, r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Not commands: /models, /configs, a config/model pair, the folder /memory/notes, /clear-all, plan/review and x-/schedule."); const r = lint(root);
      ok("not flagged as a built-in slash command: a longer word, a word after a letter or a hyphen, a folder, a hyphenated name", r.problems.length === 0, r.problems); }

    // 2. references
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Then run `node backend/gone.js`."); const r = lint(root);
      ok("missing-reference: a script that does not exist", only(r, "missing-reference") && /backend\/gone\.js does not exist/.test(r.problems[0].msg) && r.problems[0].line > 0, r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Read automation/nowhere/ and ./backend/missing.json."); const r = lint(root);
      ok("missing-reference: a folder, and a path written with ./, outside backticks", only(r, "missing-reference", 2), r.problems); }
    // review 2026-10-11 (surviving mutant): the mark after a path that ends a sentence or a clause is not part of the path. (Windows
    // finds "tool.js." as tool.js, so the cases that show it on every system are the switch file, the allowAbsent path and the message.)
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Run backend/tool.js. Then docs/procedures/alpha.md, and backend/lib/atomic-write.js: done; never remove backend/data/x-OFF. The first run writes backend/data/made-later.json."); const S = JSON.parse(R(root, SOURCES)); S.allowAbsent = { "backend/data/made-later.json": "written by the first run of the ritual" }; W(root, SOURCES, JSON.stringify(S)); const r = lint(root);
      ok("a path that ends a sentence or a clause, outside backticks (a full stop, comma, colon or semicolon after it), is read without that mark: files that are there, a switch file and an allowAbsent path give no problem", r.problems.length === 0, r.problems);
      addStep(root, `${PROC}/alpha.md`, "Then read backend/gone.js."); const r2 = lint(root);
      ok("… and a missing path that ends a sentence is named without its full stop", only(r2, "missing-reference") && r2.problems[0].msg === "backend/gone.js does not exist", r2.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Write `backend/data/out/<date>-<lens>.json`, read `backend/*.js` and `backend/data/out/YYYY-MM-DD.json`, then `backend/data/out/{date}.json` and `backend/register-rNNN.js`."); const r = lint(root);
      ok("a path with a placeholder (<x>, *, {x}, YYYY, NNN) is fine when its last fixed folder exists", r.problems.length === 0, r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Dead: backend/gone.js, automation/gone.cjs, docs/gone.md, deploy/gone.sh, mcp/gone.mjs, src/gone.jsx, assessment-agents/gone.js and .claude/gone.md."); const r = lint(root);
      ok("missing-reference: a path under every top-level folder of the repo is checked (8 folders, 8 problems)", only(r, "missing-reference", 8) && ["backend/", "automation/", "docs/", "deploy/", "mcp/", "src/", "assessment-agents/", ".claude/"].every((t, i) => r.problems[i].msg.startsWith(t)), r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Write `backend/data/nowhere/<date>.json`."); const r = lint(root);
      ok("missing-reference: a placeholder path whose fixed folder does not exist", only(r, "missing-reference") && /the folder backend\/data\/nowhere\/ does not exist/.test(r.problems[0].msg), r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "The bar comes from `lib/null-bar.js` and the seals are in data/read-seals.json."); const r = lint(root);
      ok("short-path: lib/… and data/… must be written from the repo root", only(r, "short-path", 2) && /backend\/lib\/null-bar\.js/.test(r.problems[0].msg), r.problems); }
    { const root = fresh(); W(root, `${PROC}/alpha.md`, R(root, `${PROC}/alpha.md`).replace("## How to know it worked", "```text\nYou check lib/reconcile.js and backend/gone.js.\n```\n\n## How to know it worked")); const r = lint(root);
      ok("inside a ```text block (a prompt quoted verbatim) a short path is allowed, a full path that does not exist is still a problem", only(r, "missing-reference") && /backend\/gone\.js/.test(r.problems[0].msg), r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Rebuild with `npm run build`, then `npm run deploy-all`."); const r = lint(root);
      ok("missing-reference: an npm script package.json does not have (one that it has is fine)", only(r, "missing-reference") && /npm run deploy-all/.test(r.problems[0].msg), r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "The first run writes `backend/data/made-later.json`."); const r1 = lint(root); const S = JSON.parse(R(root, SOURCES)); S.allowAbsent = { "backend/data/made-later.json": "written by the first run of the ritual" }; W(root, SOURCES, JSON.stringify(S)); const r2 = lint(root);
      ok("a path listed under allowAbsent in sources.json (with its reason) may be absent; unlisted it is a problem", only(r1, "missing-reference") && r2.problems.length === 0, [r1.problems, r2.problems]); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Never create `backend/data/x-LIVE-ARMED`; never remove `backend/data/x-OFF`, `backend/data/x-HALT` or `backend/data/TRAIDS_STOP` on your own."); const r = lint(root);
      ok("a switch file (…-OFF, …-HALT, …-LIVE-ARMED, TRAIDS_STOP) may be absent: it is there or not by design", r.problems.length === 0, r.problems);
      addStep(root, `${PROC}/alpha.md`, "But `backend/data/x-OFF.json` and `backend/data/TRAIDS_STOP_NOW` are ordinary files."); const r2 = lint(root);
      ok("… only by that exact naming: a name that merely contains OFF or TRAIDS_STOP is checked like any path", only(r2, "missing-reference", 2), r2.problems); }
    { const root = fresh(); W(root, "AGENTS.md", R(root, "AGENTS.md") + "\nRun `node backend/gone.js`; the switch `backend/data/x-LIVE-ARMED` is the operator's. Claude runs /alpha through the Workflow tool and its scratchpad; see lib/x.js.\n"); const r = lint(root);
      ok("AGENTS.md is checked for dead references (and only for those: it may name any vendor's tool), without being counted as a procedure", only(r, "missing-reference") && r.problems[0].file === "AGENTS.md" && /backend\/gone\.js/.test(r.problems[0].msg) && r.files === 4 && JSON.stringify(r.pages) === JSON.stringify(["AGENTS.md"]), [r.problems, r.files, r.pages]); }
    { const root = fresh(); W(root, "docs/handover/CODEX-SETUP.md", "# Codex\n\nRun `node docs/handover/drill-check.cjs` and read `docs/handover/TAKEOVER-DRILL.md`. Claude has skills.\n"); const r1 = lint(root); W(root, "docs/handover/drill-check.cjs", "//\n"); W(root, "docs/handover/TAKEOVER-DRILL.md", "# Drill\n\nSee `backend/tool.js` and `automation/never-built.cjs`.\n"); const r2 = lint(root);
      ok("the Codex setup page and the drill page are checked for dead references too, when they are there", only(r1, "missing-reference", 2) && r1.problems.every((p) => p.file === "docs/handover/CODEX-SETUP.md") && only(r2, "missing-reference") && r2.problems[0].file === "docs/handover/TAKEOVER-DRILL.md" && /never-built/.test(r2.problems[0].msg) && r2.pages.length === 3, [r1.problems, r2.problems, r2.pages]); }

    // 2b. the dead references a review found unchecked (2026-10-11): a script under any folder, a bare script, a root file, a backslash path, npm test
    const DEAD = [
      ["a script under a folder that is not a top folder of the repo", "Then run `node scripts/gone.js`.", [/^scripts\/gone\.js does not exist$/]],
      ["two such scripts on one line", "Then `node tools/gone.cjs` and `node server/gone.js`.", [/^tools\/gone\.cjs does not exist$/, /^server\/gone\.js does not exist$/]],
      ["a bare script name (a command is started from the repo root)", "Then `node gone-runner.js`.", [/^gone-runner\.js does not exist$/]],
      ["a root file, and a file under dist/ and under node_modules/", "Keep `package-lock.json`, `dist/index.html` and `node_modules/x/y.js`.", [/^package-lock\.json: no file of that name at the repo root or under backend\//, /^dist\/index\.html does not exist$/, /^node_modules\/x\/y\.js does not exist$/]],
      ["a script written with a backslash", "Then `node backend\\gone.js`.", [/^backend\/gone\.js does not exist$/]],
      ["a script under a top folder written in another letter case", "Then `node Backend/gone.js`.", [/^Backend\/gone\.js does not exist$/]],
      ["a bare file name that is nowhere in the repo", "Read `GONE.md` first.", [/^GONE\.md: no file of that name at the repo root or under /]],
      ["npm test without a test script in package.json", "Then `npm test`.", [/^npm test: package\.json has no "test" script$/]],
      ["the script after a flag of node", "Check it: `node --check scripts/gone.js`.", [/^scripts\/gone\.js does not exist$/]],
      ["the script after a flag that takes a value (the value is a file too, and is there)", "Then `node --require ./backend/tool.js scripts/gone.js --dry`.", [/^scripts\/gone\.js does not exist$/]],
      ["the script after a setting written before the command", "Then `TRAIDS_X=1 OTHER=two node scripts/gone.js`.", [/^scripts\/gone\.js does not exist$/]],
      ["a script started with node.exe, the path in quotes", "Then `node.exe \"scripts/gone.js\"`.", [/^scripts\/gone\.js does not exist$/]],
      ["a script started with ./ under a folder that is not a top folder", "Then `node ./scripts/gone.js`.", [/^scripts\/gone\.js does not exist$/]],
      ["a file given to npx by its path, and one by its extension", "Then `npx ./scripts/gone.js` or `npx tools/gone.mjs`.", [/^scripts\/gone\.js does not exist$/, /^tools\/gone\.mjs does not exist$/]],
      ["a file given to npx by ./ that has no script extension", "Then `npx ./tools/gone-bin`.", [/^tools\/gone-bin does not exist$/]],
      ["an npm word that is neither an npm command nor a script", "Then `npm deploy-all`.", [/^npm deploy-all: not an npm command/]],
      ["an npm word after a flag with its value", "Then `npm --prefix backend deploy-all`.", [/^npm deploy-all: not an npm command/]],
      ["an npm word given to npm.cmd", "Then `npm.cmd deploy-all`.", [/^npm deploy-all: not an npm command/]],
      ["a folder in inline code that is not there", "The bundle is in `gone-folder/`.", [/^gone-folder does not exist$/]],
      ["a path in inline code written with a backslash", "Open `backend\\gone.js`.", [/^backend\/gone\.js does not exist$/]],
      ["a path in inline code under a top folder in another letter case", "Open `Docs/gone.md`.", [/^Docs\/gone\.md does not exist$/]],
      ...["start", "stop", "restart"].map((s) => [`npm ${s} without that script, in a sentence`, `Then npm ${s} and wait.`, [new RegExp(`^npm ${s}: package\\.json has no "${s}" script$`)]]),
    ];
    for (const [name, line, want] of DEAD) { const root = fresh(); addStep(root, `${PROC}/alpha.md`, line); const r = lint(root);
      ok(`missing-reference: ${name}`, only(r, "missing-reference", want.length) && want.every((re, i) => re.test(r.problems[i].msg)) && r.problems.every((p) => p.file === `${PROC}/alpha.md` && p.line > 0) && !report(r).ok, r.problems); }
    /** the same fixture with the files those lines name put there */
    const withFiles = () => { const root = fresh(); W(root, "scripts/there.js", "//\n"); W(root, "tool-at-root.js", "//\n"); W(root, "dist/index.html", "<html></html>\n"); W(root, "docs/server/w1/NOTES.md", "# notes\n"); W(root, "package.json", JSON.stringify({ scripts: { build: "x", test: "x", start: "x", stop: "x", restart: "x" } })); return root; };
    { const root = withFiles(); addStep(root, `${PROC}/alpha.md`, "Then `node scripts/there.js`, `node backend\\tool.js`, `node tool-at-root.js`, `node ./scripts/there.js --flag`, `npx ./scripts/there.js`; read `package.json`, `NOTES.md`, `dist/index.html`, `dist/` and `backend\\tool.js`; then `npm test`, npm start, npm stop and npm restart."); const r = lint(root);
      ok("the same kinds of reference are fine when the file is there: a script under any folder, with a backslash, at the root; a root file; a bare name that is somewhere under a top folder; a folder; the four npm scripts", r.problems.length === 0, r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Not scripts of this repo: `node -e \"require('./scripts/gone.js')\"`, `node -p 1`, `node --check`, `node --version`, `node`, `node C:\\tools\\x.js`, `node /usr/local/x.js`, `node ~/x.js`, `node $HOME/x.js`, `node %TEMP%\\x.js`, `node <script>.js`, `nodemon scripts/gone.js`."); const r = lint(root);
      ok("not resolved: code given inline (-e, -p), a flag alone, node alone, a drive / absolute / home path, a path from a variable, a placeholder, and a program whose name merely starts with node", r.problems.length === 0, r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Fine: `npm ci`, `npm install -g some-tool`, `npm --prefix backend ci`, `npm run build`, `npx vite build`, `npx --yes @scope/tool`; and npm is not needed for the rest."); const r = lint(root);
      ok("not flagged: npm's own commands (also after a flag with its value), npm run with a script that is there, npx with a package, and the word npm in a sentence", r.problems.length === 0, r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Not files: `console.log`, `process.argv`, `bar.tRequired`, `mcp.example.co`, `docs.example.com/guide`, `docs.example.com/`, `America/Denver`, `.codex/config.toml`, `.mcp.json`, `<id>-read.json`, `procedure-*.md`, `--check`, `:3001`, `v1.2.3`."); const r = lint(root);
      ok("not taken for a file name: a property, a site, a time zone, a dot-file or dot-folder (a tool's own configuration), a placeholder, a flag, a port, a version", r.problems.length === 0, r.problems); }
    { const root = fresh(); W(root, `${PROC}/alpha.md`, R(root, `${PROC}/alpha.md`).replace("node backend/tool.js", "node scripts/gone.js")); const r1 = lint(root);
      W(root, `${PROC}/alpha.md`, R(root, `${PROC}/alpha.md`).replace("node scripts/gone.js", "TRAIDS_X=1 node scripts\\gone.js --dry")); const r2 = lint(root);
      W(root, `${PROC}/alpha.md`, R(root, `${PROC}/alpha.md`).replace("TRAIDS_X=1 node scripts\\gone.js --dry", "npm deploy-all")); const r3 = lint(root);
      ok("a command line INSIDE a code block is resolved the same way (a script under any folder; after a setting and with a backslash; an npm word)", only(r1, "missing-reference") && /^scripts\/gone\.js does not exist$/.test(r1.problems[0].msg) && only(r2, "missing-reference") && /^scripts\/gone\.js does not exist$/.test(r2.problems[0].msg) && only(r3, "missing-reference") && /^npm deploy-all/.test(r3.problems[0].msg), [r1.problems, r2.problems, r3.problems]); }
    { const root = fresh(); W(root, `${PROC}/alpha.md`, R(root, `${PROC}/alpha.md`).replace("## How to know it worked", "```text\nnode scripts/gone.js is what the reader may be told to run; `GONE.md` and `node tools/gone.cjs` are words of the prompt.\nnpm deploy-all\n```\n\n## How to know it worked")); const r = lint(root);
      ok("inside a ```text block (a prompt quoted verbatim) a line is not a command and its inline code is not resolved", r.problems.length === 0, r.problems); }
    { const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Read `GONE.md` first."); const S = JSON.parse(R(root, SOURCES)); S.allowAbsent = { "GONE.md": "a file the page says must never be created" }; W(root, SOURCES, JSON.stringify(S)); const r = lint(root);
      ok("a bare file name listed under allowAbsent (with its reason) may be nowhere", r.problems.length === 0, r.problems); }
    { const root = fresh(); W(root, "node_modules/x/ONLY-IN-MODULES.md", "x\n"); W(root, "other/ONLY-IN-OTHER.md", "x\n"); W(root, "docs/deep/a/b/DEEP.md", "x\n"); W(root, ".git/ONLY-IN-GIT.md", "x\n"); W(root, "docs/node_modules/y/NESTED-MODULES.md", "x\n"); W(root, "docs/sub/.git/NESTED-GIT.md", "x\n");
      addStep(root, `${PROC}/alpha.md`, "Read `DEEP.md`, `ONLY-IN-MODULES.md`, `ONLY-IN-OTHER.md`, `ONLY-IN-GIT.md`, `NESTED-MODULES.md` and `NESTED-GIT.md`."); const r = lint(root), n = fileNames(root);
      ok("a bare file name is looked for at the repo root and under the top folders only: deep under docs/ it is found; under node_modules/ or .git/ (at any depth) or a folder that is not a top folder it is not", only(r, "missing-reference", 5) && ["ONLY-IN-MODULES.md", "ONLY-IN-OTHER.md", "ONLY-IN-GIT.md", "NESTED-MODULES.md", "NESTED-GIT.md"].every((f, i) => r.problems[i].msg.startsWith(f + ":")) && n.has("DEEP.md") && n.has("AGENTS.md") && n.has("tool.js") && !n.has("ONLY-IN-OTHER.md") && !n.has("ONLY-IN-MODULES.md"), [r.problems, [...n].sort()]); }
    { const root = fresh(); W(root, "AGENTS.md", R(root, "AGENTS.md") + "\nRun `node scripts/gone.js`; read `GONE.md`; then `npm test`.\n"); const r = lint(root);
      ok("AGENTS.md is held to the same reference rules (a script under any folder, a bare file name, npm test)", only(r, "missing-reference", 3) && r.problems.every((p) => p.file === "AGENTS.md"), r.problems); }
    // the lists behind those rules, each entry by a known answer (the lists are written out here by hand, not read from the lint)
    { const EXTS = ["md", "json", "jsonl", "js", "cjs", "mjs", "jsx", "html", "bat", "cmd", "sh", "ps1", "ics", "txt", "csv"], NOT_EXTS = ["log", "toml", "exe", "co", "com", "argv"];
      const got = EXTS.map((x) => { const root = fresh(); addStep(root, `${PROC}/alpha.md`, `Read \`GONE-FILE.${x}\` first.`); const r = lint(root); return only(r, "missing-reference") && r.problems[0].msg.startsWith(`GONE-FILE.${x}:`); });
      const root = fresh(); addStep(root, `${PROC}/alpha.md`, "Not house files: " + NOT_EXTS.map((x) => `\`GONE-FILE.${x}\``).join(", ") + "."); const r = lint(root);
      ok("a bare name is taken for a file by each of the 15 extensions this repo's pages use (.MD as well as .md), and not by .log, .toml, .exe or the end of a site or a property", JSON.stringify(FILE_EXTS) === JSON.stringify(EXTS) && got.every(Boolean) && r.problems.length === 0 && (() => { const r2 = fresh(); addStep(r2, `${PROC}/alpha.md`, "Read `GONE-FILE.MD` first."); return only(lint(r2), "missing-reference"); })(), [got, r.problems]); }
    { const BUILTINS = ["install", "i", "add", "ci", "uninstall", "remove", "rm", "un", "update", "up", "ls", "list", "exec", "x", "init", "create", "version", "view", "info", "show", "audit", "outdated", "link", "pack", "publish", "config", "cache", "prune", "rebuild", "dedupe", "doctor", "help", "root", "prefix", "why", "explain", "fund", "pkg", "search", "login", "logout", "whoami", "run", "run-script", "access", "token", "owner", "ping", "query", "sbom", "set", "get"];
      const root = fresh(); addStep(root, `${PROC}/alpha.md`, "npm's own: " + BUILTINS.filter((b) => b !== "run" && b !== "run-script").map((b) => `\`npm ${b}\``).join(", ") + ", `npm run build`, `npm run-script build`."); const r = lint(root);
      ok("each of npm's own 52 commands is known and none is taken for a missing script", JSON.stringify([...NPM_BUILTINS].sort()) === JSON.stringify([...BUILTINS].sort()) && BUILTINS.length === 52 && r.problems.length === 0, [r.problems, [...NPM_BUILTINS].filter((b) => !BUILTINS.includes(b))]); }
    { const FLAGS = ["--prefix", "-C", "-w", "--workspace", "--registry", "--cache", "--userconfig", "--loglevel"];
      const got = FLAGS.map((f) => { const a = fresh(); addStep(a, `${PROC}/alpha.md`, `Then \`npm ${f} somewhere ci\`.`); const b = fresh(); addStep(b, `${PROC}/alpha.md`, `Then \`npm ${f} somewhere deploy-all\`.`); const rb = lint(b); return lint(a).problems.length === 0 && only(rb, "missing-reference") && /^npm deploy-all: not an npm command/.test(rb.problems[0].msg); });
      ok("after each of the 8 npm flags that take a value, the value is skipped and the word after it is the command", JSON.stringify([...NPM_FLAG_WITH_VALUE].sort()) === JSON.stringify([...FLAGS].sort()) && got.every(Boolean), got); }
    { const NO_SCRIPT = ["-e", "--eval", "-p", "--print", "-i", "--interactive", "-v", "--version", "-h", "--help"], WITH_VALUE = ["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "-C", "--conditions"];
      ok("nodeScript: after each of the 10 flags that start no script file the answer is null; after each of the 8 flags that take a value, the value is skipped", JSON.stringify([...NODE_NO_SCRIPT].sort()) === JSON.stringify([...NO_SCRIPT].sort()) && NO_SCRIPT.every((f) => nodeScript([f, "a.js"]) === null && nodeScript(["--check", f, "a.js"]) === null) && JSON.stringify([...NODE_FLAG_WITH_VALUE].sort()) === JSON.stringify([...WITH_VALUE].sort()) && WITH_VALUE.every((f) => nodeScript([f, "value.js", "a.js"]) === "a.js"), [NO_SCRIPT.map((f) => nodeScript([f, "a.js"])), WITH_VALUE.map((f) => nodeScript([f, "value.js", "a.js"]))]); }
    ok("words: a command line split into its words, quoted runs kept whole and the quotes dropped", JSON.stringify(words("node  \"my scripts/a b.js\" --note 'x y' z")) === JSON.stringify(["node", "my scripts/a b.js", "--note", "x y", "z"]) && words("").length === 0, words("node  \"my scripts/a b.js\" --note 'x y' z"));
    ok("nodeScript: the first word that is not a flag or a flag's value; null when the code is given inline or nothing is started", nodeScript(["--check", "a.js", "b.js"]) === "a.js" && nodeScript(["-r", "x.js", "--import", "y.mjs", "a.js"]) === "a.js" && nodeScript(["--permission", "--allow-fs-read=*", "a.js"]) === "a.js" && nodeScript(["-e", "a.js"]) === null && nodeScript(["--check", "--eval", "a.js"]) === null && nodeScript(["-p", "1"]) === null && nodeScript(["--version"]) === null && nodeScript(["--check"]) === null && nodeScript([]) === null, [nodeScript(["--check", "a.js", "b.js"]), nodeScript(["-r", "x.js", "--import", "y.mjs", "a.js"])]);

    // 3. drift
    { const root = fresh(); W(root, ".claude/skills/alpha/SKILL.md", SKILL_A + "One more rule.\n"); const r = lint(root);
      ok("source-drift: a changed skill file fails its procedure, and only that one", only(r, "source-drift") && r.problems[0].file === `${PROC}/alpha.md` && /--record/.test(r.problems[0].msg), r.problems); }
    { const root = fresh(); W(root, ".claude/workflows/loop.js", WF + "// changed\n"); const r = lint(root);
      ok("source-drift: a changed workflow script fails its procedure", only(r, "source-drift") && r.problems[0].file === `${PROC}/loop.md`, r.problems); }
    { const root = fresh(); W(root, ".claude/skills/alpha/SKILL.md", SKILL_A.replace(/\n/g, "\r\n")); const r = lint(root);
      ok("a source that differs only in line endings (CRLF for LF) is not drift", r.problems.length === 0, r.problems); }
    { const root = fresh(); fs.rmSync(path.join(root, ".claude", "skills", "alpha", "SKILL.md")); const r = lint(root);
      ok("source-missing: a recorded source that is gone (and the procedure's own line naming it is a missing reference)", JSON.stringify(rules(r)) === JSON.stringify(["missing-reference", "source-missing"]) && r.problems.every((p) => p.file === `${PROC}/alpha.md`) && /SKILL\.md is gone/.test(r.problems[1].msg), r.problems); }

    // 4. coverage
    { const root = fresh(); W(root, ".claude/skills/gamma/SKILL.md", "# Gamma\n"); const r = lint(root);
      ok("no-procedure: a new ritual in .claude/skills with no procedure", only(r, "no-procedure") && r.problems[0].file === ".claude/skills/gamma/SKILL.md", r.problems); }
    { const root = fresh(); W(root, ".claude/workflows/other.js", "//\n"); const r = lint(root);
      ok("no-procedure: a new workflow script with no procedure", only(r, "no-procedure") && r.problems[0].file === ".claude/workflows/other.js", r.problems); }
    { const root = fresh(); W(root, `${PROC}/delta.md`, proc("Delta", ".claude/skills/alpha/SKILL.md")); const r = lint(root);
      ok("unrecorded-procedure: a procedure file that sources.json does not list", only(r, "unrecorded-procedure") && r.problems[0].file === `${PROC}/delta.md`, r.problems); }
    // review 2026-10-11 (surviving mutant): a procedure listed with NO source could never drift, so nothing would ever force its review
    for (const [how, entry] of [["an empty sources map", { sources: {} }], ["no sources map at all", {}]]) { const root = fresh(); W(root, `${PROC}/delta.md`, proc("Delta", ".claude/skills/alpha/SKILL.md")); const S = JSON.parse(R(root, SOURCES)); S.procedures["delta.md"] = entry; W(root, SOURCES, JSON.stringify(S)); W(root, "AGENTS.md", R(root, "AGENTS.md") + "docs/procedures/delta.md\n");
      const r = lint(root); fs.rmSync(path.join(root, ".claude"), { recursive: true }); const r2 = lint(root);
      ok(`unrecorded-procedure: a procedure listed in sources.json with ${how} (every ritual otherwise covered)`, only(r, "unrecorded-procedure") && r.problems[0].file === `${PROC}/delta.md` && r.problems[0].msg === `${SOURCES} lists no source for it` && r.files === 5, r.problems);
      ok(`… and the same on a host without .claude/ (${how}): the record alone shows it`, only(r2, "unrecorded-procedure") && r2.problems[0].msg === `${SOURCES} lists no source for it` && r2.notes.length === 1, [r2.problems, r2.notes]); }
    { const root = fresh(); fs.rmSync(path.join(root, PROC, "loop.md")); const r = lint(root);
      ok("missing-procedure-file: a listed procedure whose file is gone (and AGENTS.md, which lists it, now points at nothing)", JSON.stringify(rules(r)) === JSON.stringify(["missing-procedure-file", "missing-reference"]) && r.problems[0].file === `${PROC}/loop.md` && r.problems[1].file === "AGENTS.md" && r.files === 3, r.problems); }
    { const root = fresh(); W(root, `${PROC}/alpha.md`, R(root, `${PROC}/alpha.md`).replace(/^Claude Code note:.*$/m, "Source: the alpha ritual.")); const r = lint(root);
      ok("no-source-line: the procedure does not name its source on a \"Claude Code note:\" line near the top", only(r, "no-source-line"), r.problems); }
    { const root = fresh(); const t = R(root, `${PROC}/alpha.md`), note = /^Claude Code note:.*$/m.exec(t)[0]; W(root, `${PROC}/alpha.md`, t.replace(note + "\n", "").replace("## What to record and where", note + "\n\n## What to record and where")); const r = lint(root);
      ok("no-source-line: the note is there, but far below the top", only(r, "no-source-line"), r.problems); }
    // review 2026-10-11 (surviving mutant): the edge of "near the top" — line 8 is the last line the note may stand on
    { const noteAt = (n) => { const root = fresh(), t = R(root, `${PROC}/alpha.md`), note = /^Claude Code note:.*$/m.exec(t)[0], text = ["# Alpha", "", ...Array.from({ length: n - 3 }, (_, i) => `Preface line ${i + 1}.`), note, "", t.slice(t.indexOf("## Purpose"))].join("\n"); W(root, `${PROC}/alpha.md`, text); return { r: lint(root), line: text.split("\n").indexOf(note) + 1 }; };
      const a8 = noteAt(8), a9 = noteAt(9);
      ok("the source note on line 8 of a procedure is accepted (the last line it may stand on)", a8.line === 8 && a8.r.problems.length === 0 && SOURCE_LINE_WITHIN === 8, [a8.line, a8.r.problems]);
      ok("… and on line 9 it is too far down: no-source-line, saying the first 8 lines", a9.line === 9 && only(a9.r, "no-source-line") && /^its first 8 lines have no "Claude Code note:" line naming /.test(a9.r.problems[0].msg), [a9.line, a9.r.problems]); }

    // 5. structure
    for (const s of SECTIONS) { const root = fresh(); W(root, `${PROC}/alpha.md`, R(root, `${PROC}/alpha.md`).replace(`## ${s}\n`, `### ${s}\n`)); const r = lint(root);
      ok(`structure: no "## ${s}" section`, r.problems.length >= 1 && r.problems.every((p) => p.rule === "structure") && r.problems.some((p) => p.msg.includes(`"## ${s}"`)), r.problems); }
    // review 2026-10-11 (surviving mutant): a "## " line inside a code block is a line of that block, not a section heading
    for (const [how, open] of [["a code block", "```"], ["a ```text block", "```text"]]) { const root = fresh(), t = R(root, `${PROC}/alpha.md`); W(root, `${PROC}/alpha.md`, t.replace("## Fences\n", open + "\n## Fences\n```\n")); const r = lint(root);
      ok(`structure: a "## Fences" line inside ${how} is no section heading — the section is missing`, t.includes("## Fences\n") && only(r, "structure") && r.problems[0].msg === 'no "## Fences" section', r.problems); }
    { const root = fresh(); W(root, `${PROC}/alpha.md`, R(root, `${PROC}/alpha.md`).replace("So that the record stays true.", "So that the record stays true.\nAnd a third line.")); const r = lint(root);
      ok("structure: a purpose of three lines", only(r, "structure") && /purpose is 3 lines/.test(r.problems[0].msg), r.problems); }
    { const root = fresh(); W(root, `${PROC}/alpha.md`, R(root, `${PROC}/alpha.md`).replace("1. Run the tool:", "- Run the tool:").replace("2. Write", "- Write")); const r = lint(root);
      ok("structure: steps that are not numbered", only(r, "structure") && /not numbered/.test(r.problems[0].msg), r.problems); }
    { const root = fresh(); W(root, `${PROC}/alpha.md`, R(root, `${PROC}/alpha.md`).replace("```\nnode backend/tool.js\n```\n", "").replace("2. Write `backend/data/out/<date>.json`.", "2. Write the file.")); const r = lint(root);
      ok("structure: steps that name no command and no file", only(r, "structure") && /name no command/.test(r.problems[0].msg), r.problems); }
    { const root = fresh(); W(root, `${PROC}/alpha.md`, R(root, `${PROC}/alpha.md`).replace("2. Write `backend/data/out/<date>.json`.", "2. Write the file.")); const r1 = lint(root);
      W(root, `${PROC}/loop.md`, R(root, `${PROC}/loop.md`).replace("```\nnode backend/tool.js\n```\n", "")); const r2 = lint(root);
      ok("steps with a command block and no inline code are fine, and so are steps with inline code and no block", r1.problems.length === 0 && r2.problems.length === 0, [r1.problems, r2.problems]); }
    { const root = fresh(); const t = R(root, `${PROC}/alpha.md`), a = t.indexOf("## Fences"), b = t.indexOf("## Steps"), c = t.indexOf("## How to know it worked"); W(root, `${PROC}/alpha.md`, t.slice(0, a) + t.slice(b, c) + t.slice(a, b) + t.slice(c)); const r = lint(root);
      ok("structure: the six sections out of the house order", only(r, "structure") && /house order/.test(r.problems[0].msg), r.problems); }
    { const root = fresh(); W(root, `${PROC}/alpha.md`, R(root, `${PROC}/alpha.md`).replace("The tool prints OK.\n", "\n")); const r = lint(root);
      ok("structure: an empty section", only(r, "structure") && /"## How to know it worked" section is empty/.test(r.problems[0].msg), r.problems); }

    // 6. local-only procedures and their public stubs
    { const root = fresh(); fs.rmSync(path.join(root, LOCAL, "procedure-beta.md")); const r = lint(root);
      ok("local-missing: the folder is there and the local-only procedure is gone (what the memory export does); the stub's pointer to it is a missing reference as well", JSON.stringify(rules(r)) === JSON.stringify(["missing-reference", "local-missing"]) && r.problems[0].file === `${PROC}/beta.md` && r.problems[1].file === `${LOCAL}/procedure-beta.md` && /export-memory\.cjs/.test(r.problems[1].msg) && r.files === 3, r.problems);
      ok("local-missing: the message that names the source to rewrite it from says in the same breath that the source carries the same material and who may open it", /or rewrite it from its source \.claude\/[^()]+ \(that source carries the same material: only a model the operator has approved for it opens it — AGENTS\.md section 9\)$/.test(r.problems[1].msg), r.problems[1]); }
    { const root = fresh(); fs.rmSync(path.join(root, LOCAL), { recursive: true }); const r = lint(root), rep = report(r);
      ok("no local-only folder at all (another host): not a problem, said in a note and on the last line", r.problems.length === 0 && r.files === 3 && r.notes.length === 1 && /SKIPPED/.test(r.notes[0]) && /PROCEDURES OK \(3 files; 1 whole-tree check\(s\) SKIPPED/.test(rep.text), [r.problems, rep.text]); }
    { const root = fresh(); W(root, `${LOCAL}/procedure-beta.md`, LOCAL_B + "\nOne more line.\n"); const r = lint(root);
      ok("local-drift: the local-only procedure differs from the recorded text", only(r, "local-drift"), r.problems); }
    { const root = fresh(); W(root, `${LOCAL}/procedure-beta.md`, LOCAL_B.replace("## Fences\n", "")); const S = JSON.parse(R(root, SOURCES)); S.procedures["beta.md"].localSha256 = sha(R(root, `${LOCAL}/procedure-beta.md`)); W(root, SOURCES, JSON.stringify(S)); const r = lint(root);
      ok("the local-only procedure must have the six sections too", only(r, "structure") && r.problems[0].file === `${LOCAL}/procedure-beta.md`, r.problems); }
    { const root = fresh(); W(root, `${PROC}/beta.md`, STUB_B.replace(`\`${LOCAL}/procedure-beta.md\``, "a local file")); const r = lint(root);
      ok("stub: the public file does not say where the local-only procedure is", only(r, "stub") && /does not say where/.test(r.problems[0].msg), r.problems); }
    { const root = fresh(); W(root, `${PROC}/beta.md`, STUB_B + "\n## Steps\n1. Save the raw text.\n"); const r = lint(root);
      ok("stub: the public file holds steps", only(r, "stub") && /holds steps/.test(r.problems[0].msg), r.problems); }
    for (const [what, extra] of [["a Steps heading alone", "\n## Steps\nSave the raw text.\n"], ["a numbered line alone", "\n1. Save the raw text.\n"], ["a command block alone", "\n```\nnode backend/tool.js\n```\n"]]) { const root = fresh(); W(root, `${PROC}/beta.md`, STUB_B + extra); const r = lint(root);
      ok(`stub: ${what} is already too much`, only(r, "stub") && /holds steps/.test(r.problems[0].msg), r.problems); }
    { const root = fresh(); W(root, `${LOCAL}/procedure-beta.md`, LOCAL_B.replace(/^Claude Code note:.*\n/m, "")); const S = JSON.parse(R(root, SOURCES)); S.procedures["beta.md"].localSha256 = sha(R(root, `${LOCAL}/procedure-beta.md`)); W(root, SOURCES, JSON.stringify(S)); const r = lint(root);
      ok("the local-only procedure must name its source too", only(r, "no-source-line") && r.problems[0].file === `${LOCAL}/procedure-beta.md`, r.problems); }
    { const root = fresh(); W(root, `${PROC}/beta.md`, STUB_B + Array.from({ length: STUB_MAX_LINES }, (_, i) => `More about it, line ${i}.`).join("\n") + "\n"); const r = lint(root);
      ok(`stub: the public file is longer than ${STUB_MAX_LINES} lines`, only(r, "stub") && /at most 12 lines/.test(r.problems[0].msg), r.problems); }
    { const root = fresh(); W(root, `${PROC}/beta.md`, STUB_B + Array.from({ length: 9 }, (_, i) => `More about it, line ${i}.`).join("\n") + "\n"); const r = lint(root);
      ok("a stub of exactly 12 lines is allowed", r.problems.length === 0 && STUB_MAX_LINES === 12 && STUB_B.split("\n").filter((l) => l.trim()).length === 3, r.problems);
      W(root, `${PROC}/beta.md`, STUB_B + Array.from({ length: 10 }, (_, i) => `More about it, line ${i}.`).join("\n") + "\n"); const r2 = lint(root);
      ok("… and one of 13 lines is not", only(r2, "stub") && /is 13 lines/.test(r2.problems[0].msg), r2.problems); }
    { const root = fresh(); const S = JSON.parse(R(root, SOURCES)); W(root, `${PROC}/beta.md`, STUB_B.replace(/^Claude Code note:.*\n/m, "")); const r = lint(root);
      ok("a stub must name its source too", only(r, "no-source-line") && r.problems[0].file === `${PROC}/beta.md` && !!S, r.problems); }

    // 7. AGENTS.md
    { const root = fresh(); W(root, "AGENTS.md", R(root, "AGENTS.md") + "x".repeat(CODEX_DOC_LIMIT)); const r = lint(root);
      ok("agents-md: larger than Codex reads by default (32,768 bytes)", only(r, "agents-md") && /32768 bytes/.test(r.problems[0].msg), r.problems); }
    { const root = fresh(); const base = R(root, "AGENTS.md"); W(root, "AGENTS.md", base + "x".repeat(CODEX_DOC_LIMIT - Buffer.byteLength(base))); const r = lint(root);
      ok("AGENTS.md of exactly 32,768 bytes is allowed", r.problems.length === 0 && fs.statSync(path.join(root, "AGENTS.md")).size === 32768 && CODEX_DOC_LIMIT === 32768, r.problems);
      W(root, "AGENTS.md", R(root, "AGENTS.md") + "x"); const r2 = lint(root);
      ok("… and one of 32,769 bytes is not", only(r2, "agents-md") && /is 32769 bytes/.test(r2.problems[0].msg), r2.problems); }
    // review 2026-10-11 (surviving mutant): the limit is in BYTES. The real manual is full of long dashes, three bytes each.
    { const root = fresh(), DASH = String.fromCharCode(0x2014), text = R(root, "AGENTS.md") + DASH.repeat(11000) + "\n"; W(root, "AGENTS.md", text); const r = lint(root), bytes = Buffer.byteLength(text, "utf8");
      ok("agents-md: a manual of fewer than 32,768 CHARACTERS that long dashes take over 32,768 BYTES is too large (it is measured as Codex reads it, in bytes)", Buffer.byteLength(DASH, "utf8") === 3 && text.length < CODEX_DOC_LIMIT && bytes > CODEX_DOC_LIMIT && bytes === text.length + 22000 && only(r, "agents-md") && r.problems[0].msg.startsWith(`is ${bytes} bytes:`), [text.length, bytes, r.problems]);
      const fits = R(root, "AGENTS.md").replace(DASH.repeat(11000), DASH.repeat(10000)); W(root, "AGENTS.md", fits); const r2 = lint(root);
      ok("… and the same manual with fewer dashes, under the limit in bytes too, is allowed", Buffer.byteLength(fits, "utf8") < CODEX_DOC_LIMIT && Buffer.byteLength(fits, "utf8") > fits.length && r2.problems.length === 0, [Buffer.byteLength(fits, "utf8"), r2.problems]); }
    { const root = fresh(); W(root, "AGENTS.md", R(root, "AGENTS.md").replace("docs/procedures/loop.md", "the loop")); const r = lint(root);
      ok("agents-md: a procedure that AGENTS.md does not list", only(r, "agents-md") && /does not list docs\/procedures\/loop\.md/.test(r.problems[0].msg), r.problems); }
    { const root = fresh(); fs.rmSync(path.join(root, "AGENTS.md")); const r = lint(root);
      ok("agents-md: AGENTS.md is missing", only(r, "agents-md") && /missing/.test(r.problems[0].msg), r.problems); }

    // 8. whole-tree absences and unreadable inputs
    { const root = fresh(); fs.rmSync(path.join(root, ".claude"), { recursive: true }); const r = lint(root), rep = report(r);
      ok("no .claude/ at all (a host with only the procedures): not a problem, said in a note and on the last line; the slash commands are still known from the record", r.problems.length === 0 && r.notes.length === 1 && /drift and coverage checks were SKIPPED/.test(r.notes[0]) && /SKIPPED/.test(rep.text.split("\n").pop()), [r.problems, rep.text]);
      addStep(root, `${PROC}/alpha.md`, "Run /alpha now."); const r2 = lint(root);
      ok("… and a slash command is still flagged there", only(r2, "claude-only"), r2.problems); }
    { const root = fresh(); fs.rmSync(path.join(root, SOURCES)); const r = lint(root);
      ok("sources-unreadable: sources.json is missing — a failure, never a pass", r.problems.some((p) => p.rule === "sources-unreadable") && !report(r).ok, r.problems); }
    { const root = fresh(); W(root, SOURCES, "{ not json"); const r = lint(root);
      ok("sources-unreadable: sources.json is not JSON", r.problems.some((p) => p.rule === "sources-unreadable") && !report(r).ok, r.problems); }
    { const root = fresh(); W(root, SOURCES, JSON.stringify({ procedures: [] })); const r = lint(root);
      ok("sources-unreadable: sources.json has no procedures map", r.problems.some((p) => p.rule === "sources-unreadable") && !report(r).ok, r.problems); }
    { const root = fresh(); fs.rmSync(path.join(root, PROC), { recursive: true }); const r = lint(root);
      ok("the procedures folder itself is gone: a failure", r.problems.length >= 1 && !report(r).ok, r.problems); }

    // 9. --record
    { const root = fresh(); W(root, ".claude/skills/alpha/SKILL.md", SKILL_A + "One more rule.\n"); W(root, `${LOCAL}/procedure-beta.md`, LOCAL_B + "\nReviewed.\n");
      const no1 = record(root, ""), no2 = record(root, "ok"), before = R(root, SOURCES);
      ok("--record without a note of what was reviewed (or with a three-letter one) is refused and writes nothing", no1.ok === false && no2.ok === false && R(root, SOURCES) === before && /at least 10 characters/.test(no1.why), [no1, no2]);
      const no3 = record(root, "123456789"), no4 = record(root, "   12345   "), no5 = record(root, null);
      ok("a note of 9 characters, one that is 10 only with its spaces, and no note at all are refused; nothing is written", no3.ok === false && no4.ok === false && no5.ok === false && R(root, SOURCES) === before, [no3, no4, no5]);
      { const r10 = fresh(); const yes10 = record(r10, "1234567890"); ok("a note of exactly 10 characters is accepted", yes10.ok === true && JSON.parse(R(r10, SOURCES)).reviews[0].note === "1234567890", yes10); }
      // review 2026-10-11: this call used to record both changes under the one note WITHOUT being told to — the defect. Two procedures
      // have changed here (alpha.md by its source, beta.md by its local file): recording both now takes --all, and the same two hashes,
      // note, time and clean lint are expected of it as before. What happens without --all is proven right below.
      const blind = record(root, "alpha: the new rule is step 3 now", new Date("2026-10-11T12:00:00Z"));
      ok("--record with one note and NO procedure named, while two procedures have changed, is refused: it names both, says how to name one or pass --all, and writes nothing", blind.ok === false && blind.changed.length === 0 && /^2 procedures have a changed source \(alpha\.md, beta\.md\): one note cannot stand for the review of each\./.test(blind.why) && /--record <procedure>\.md "<note>"/.test(blind.why) && /--all/.test(blind.why) && /nothing recorded$/.test(blind.why) && R(root, SOURCES) === before, blind);
      const yes = record(root, "alpha: the new rule is step 3 now", new Date("2026-10-11T12:00:00Z"), { all: true }), S = JSON.parse(R(root, SOURCES)), r = lint(root);
      ok("--record with a note: the two changed hashes are recorded, the note and what changed are kept with a time, and the lint is clean again", yes.ok && JSON.stringify(yes.changed) === JSON.stringify([".claude/skills/alpha/SKILL.md", `${LOCAL}/procedure-beta.md`]) && S.reviews.length === 1 && S.reviews[0].note === "alpha: the new rule is step 3 now" && S.reviews[0].at === "2026-10-11T12:00:00.000Z" && S.reviews[0].changed.length === 2 && S.procedures["alpha.md"].sources[".claude/skills/alpha/SKILL.md"] === sha(SKILL_A + "One more rule.\n") && r.problems.length === 0, [yes, S.reviews, r.problems]);
      ok("--record leaves no temp file beside sources.json", fs.readdirSync(path.join(root, PROC)).every((f) => !/\.tmp-/.test(f)), fs.readdirSync(path.join(root, PROC))); }
    { const root = fresh(); fs.rmSync(path.join(root, ".claude", "workflows", "loop.js")); const before = R(root, SOURCES), no = record(root, "reviewed everything today");
      ok("--record with a source missing is refused and writes nothing", no.ok === false && /cannot be read/.test(no.why) && R(root, SOURCES) === before, no); }
    { const root = fresh(); fs.rmSync(path.join(root, LOCAL, "procedure-beta.md")); const before = R(root, SOURCES), no = record(root, "reviewed everything today");
      ok("--record with a local-only procedure gone is refused (restore it first)", no.ok === false && /restore it first/.test(no.why) && R(root, SOURCES) === before, no); }
    { const root = fresh(); fs.rmSync(path.join(root, LOCAL), { recursive: true }); const yes = record(root, "reviewed on the server copy"), S = JSON.parse(R(root, SOURCES));
      ok("--record on a host without the local-only folder keeps the recorded local hash", yes.ok && S.procedures["beta.md"].localSha256 === sha(LOCAL_B), [yes, S.procedures["beta.md"]]); }
    // review 2026-10-11: one note re-hashed every changed source of every procedure, so the review of one blessed the drift in the others
    { const root = fresh(), A2 = SKILL_A + "One more rule.\n", B2 = LOCAL_B + "\nReviewed.\n"; W(root, ".claude/skills/alpha/SKILL.md", A2); W(root, `${LOCAL}/procedure-beta.md`, B2);
      const T1 = new Date("2026-10-11T12:00:00Z"), T2 = new Date("2026-10-11T13:00:00Z");
      const a = record(root, "alpha: step 3 holds the new rule", T1, { only: "alpha.md" }), S1 = JSON.parse(R(root, SOURCES)), r1 = lint(root);
      ok("--record <procedure>.md: only that procedure's hash is recorded — the other changed procedure keeps its OLD hash, is reported as still to review, and the lint still fails for it and for nothing else",
        a.ok && JSON.stringify(a.changed) === JSON.stringify([".claude/skills/alpha/SKILL.md"]) && JSON.stringify(a.procedures) === JSON.stringify(["alpha.md"]) && JSON.stringify(a.stillChanged) === JSON.stringify(["beta.md"]) && S1.procedures["alpha.md"].sources[".claude/skills/alpha/SKILL.md"] === sha(A2) && S1.procedures["beta.md"].localSha256 === sha(LOCAL_B) && sha(LOCAL_B) !== sha(B2)
        && S1.reviews.length === 1 && S1.reviews[0].note === "alpha: step 3 holds the new rule" && JSON.stringify(S1.reviews[0].procedures) === JSON.stringify(["alpha.md"]) && JSON.stringify(S1.reviews[0].changed) === JSON.stringify([".claude/skills/alpha/SKILL.md"]) && only(r1, "local-drift") && r1.problems[0].file === `${LOCAL}/procedure-beta.md` && /--record beta\.md "<what you checked>"$/.test(r1.problems[0].msg), [a, S1.reviews, r1.problems]);
      const b = record(root, "beta: the local steps were re-read", T2, { only: `${PROC}/beta.md` }), S2 = JSON.parse(R(root, SOURCES)), r2 = lint(root);
      ok("… and the second procedure is recorded by its own note (its name given as a path from the repo root works as well): two reviews on record, each with its procedure, and the lint is clean", b.ok && JSON.stringify(b.changed) === JSON.stringify([`${LOCAL}/procedure-beta.md`]) && b.stillChanged.length === 0 && S2.procedures["beta.md"].localSha256 === sha(B2) && S2.reviews.length === 2 && S2.reviews[1].at === "2026-10-11T13:00:00.000Z" && JSON.stringify(S2.reviews.map((x) => x.procedures)) === JSON.stringify([["alpha.md"], ["beta.md"]]) && r2.problems.length === 0, [b, S2.reviews, r2.problems]); }
    // the same source read by two procedures (as the audit's script is by the audit and by one lens): recording one leaves the other open
    { const root = fresh(), WF2 = WF + "// a new lens\n"; W(root, `${PROC}/delta.md`, proc("Delta", ".claude/workflows/loop.js")); W(root, "AGENTS.md", R(root, "AGENTS.md") + "docs/procedures/delta.md\n");
      const S0 = JSON.parse(R(root, SOURCES)); S0.procedures["delta.md"] = { sources: { ".claude/workflows/loop.js": sha(WF) } }; W(root, SOURCES, JSON.stringify(S0, null, 1));
      const clean = lint(root); W(root, ".claude/workflows/loop.js", WF2); const both = lint(root), before = R(root, SOURCES);
      const blind = record(root, "loop: the new lens is in step 2"), afterBlind = R(root, SOURCES), one = record(root, "loop: the new lens is in step 2", new Date("2026-10-11T12:00:00Z"), { only: "loop.md" }), S1 = JSON.parse(R(root, SOURCES)), r1 = lint(root);
      ok("a source that TWO procedures were written from: its change fails both; a note with no name is refused (nothing written); the note for one records that one's hash only, and the other still fails with its own source-drift",
        clean.problems.length === 0 && clean.files === 5 && only(both, "source-drift", 2) && blind.ok === false && /^2 procedures have a changed source \(loop\.md, delta\.md\)/.test(blind.why) && afterBlind === before && one.ok && JSON.stringify(one.changed) === JSON.stringify([".claude/workflows/loop.js"]) && JSON.stringify(one.stillChanged) === JSON.stringify(["delta.md"])
        && S1.procedures["loop.md"].sources[".claude/workflows/loop.js"] === sha(WF2) && S1.procedures["delta.md"].sources[".claude/workflows/loop.js"] === sha(WF) && only(r1, "source-drift") && r1.problems[0].file === `${PROC}/delta.md` && /--record delta\.md "<what you checked>"$/.test(r1.problems[0].msg), [blind, one, r1.problems, before.length]); }
    { const root = fresh(), A2 = SKILL_A + "One more rule.\n"; W(root, ".claude/skills/alpha/SKILL.md", A2);
      const solo = record(root, "alpha: step 3 holds the new rule"), S1 = JSON.parse(R(root, SOURCES));
      ok("with exactly ONE procedure changed, a note without a name is about that one and is recorded (the review entry says which)", solo.ok && JSON.stringify(solo.changed) === JSON.stringify([".claude/skills/alpha/SKILL.md"]) && JSON.stringify(solo.procedures) === JSON.stringify(["alpha.md"]) && JSON.stringify(S1.reviews[0].procedures) === JSON.stringify(["alpha.md"]) && lint(root).problems.length === 0, [solo, S1.reviews]); }
    { const root = fresh(); W(root, ".claude/skills/alpha/SKILL.md", SKILL_A + "One more rule.\n"); W(root, `${LOCAL}/procedure-beta.md`, LOCAL_B + "\nReviewed.\n"); const before = R(root, SOURCES);
      const no1 = record(root, "gamma: reviewed it today", new Date(), { only: "gamma.md" }), no2 = record(root, "everything was reviewed", new Date(), { only: "alpha.md", all: true }), no3 = record(root, "short", new Date(), { only: "alpha.md" }), no4 = record(root, "the lint itself was reviewed", new Date(), { only: "lint.cjs" });
      ok("--record refuses, and writes nothing: a name that is not a listed procedure (the listed ones are given), a name together with --all, a named procedure with a note under 10 characters, and a file of the folder that is no procedure", no1.ok === false && /^gamma\.md is not a procedure listed in docs\/procedures\/sources\.json \(listed: alpha\.md, loop\.md, beta\.md\)/.test(no1.why) && no2.ok === false && /not both/.test(no2.why) && no3.ok === false && /at least 10 characters/.test(no3.why) && no4.ok === false && /is not a procedure listed/.test(no4.why) && R(root, SOURCES) === before, [no1, no2, no3, no4]);
      const none = record(root, "loop: read again, nothing to change", new Date("2026-10-11T12:00:00Z"), { only: "loop.md" }), S1 = JSON.parse(R(root, SOURCES));
      ok("--record of a named procedure whose sources did NOT change records the review and no hash — and none of the two procedures that did change", none.ok && none.changed.length === 0 && JSON.stringify(none.stillChanged) === JSON.stringify(["alpha.md", "beta.md"]) && S1.reviews.length === 1 && JSON.stringify(S1.reviews[0].procedures) === JSON.stringify(["loop.md"]) && S1.procedures["alpha.md"].sources[".claude/skills/alpha/SKILL.md"] === sha(SKILL_A) && S1.procedures["beta.md"].localSha256 === sha(LOCAL_B) && lint(root).problems.length === 2, [none, S1.reviews]); }
    ok("recordArgs: \"<note>\" · <procedure>.md \"<note>\" · --all \"<note>\" (--all anywhere); a single word that is a procedure's file name is a NAME with no note, never a note; three words, --all twice or another flag are no form of the command",
      JSON.stringify(recordArgs(["what I checked"])) === '{"only":null,"all":false,"note":"what I checked"}' && JSON.stringify(recordArgs(["alpha.md", "what I checked"])) === '{"only":"alpha.md","all":false,"note":"what I checked"}' && JSON.stringify(recordArgs(["--all", "what I checked"])) === '{"only":null,"all":true,"note":"what I checked"}' && JSON.stringify(recordArgs(["what I checked", "--all"])) === '{"only":null,"all":true,"note":"what I checked"}'
      && JSON.stringify(recordArgs(["nightly-audit.md"])) === '{"only":"nightly-audit.md","all":false,"note":""}' && JSON.stringify(recordArgs(["docs/procedures/nightly-audit.md"])) === '{"only":"docs/procedures/nightly-audit.md","all":false,"note":""}' && JSON.stringify(recordArgs([])) === '{"only":null,"all":false,"note":""}' && JSON.stringify(recordArgs(["--all"])) === '{"only":null,"all":true,"note":""}' && JSON.stringify(recordArgs(["alpha.md", "--all", "note here"])) === '{"only":"alpha.md","all":true,"note":"note here"}'
      && recordArgs(["a.md", "note one", "note two"]) === null && recordArgs(["--all", "--all", "note"]) === null && recordArgs(["--force", "note"]) === null && recordArgs(["alpha.md", "--json"]) === null, [recordArgs(["nightly-audit.md"]), recordArgs(["a.md", "note one", "note two"])]);

    // 10. the command line, end to end
    { const root = fresh(), run = (args) => cp.spawnSync(process.execPath, [__filename, ...args], { encoding: "utf8", windowsHide: true });
      const a = run(["--root", root]); ok("command line, clean copy: exit 0 and the last line is PROCEDURES OK (4 files)", a.status === 0 && a.stdout.trim().split(/\r?\n/).pop() === "PROCEDURES OK (4 files)", [a.status, a.stdout, a.stderr]);
      addStep(root, `${PROC}/alpha.md`, "Then run `node backend/gone.js` with TodoWrite.");
      const b = run(["--root", root]); ok("command line, two problems: exit 1, each on its own line with file:line and rule, last line PROCEDURES FAIL (2 problem(s) in 4 files)", b.status === 1 && /docs\/procedures\/alpha\.md:\d+  claude-only  /.test(b.stdout) && /docs\/procedures\/alpha\.md:\d+  missing-reference  /.test(b.stdout) && b.stdout.trim().split(/\r?\n/).pop() === "PROCEDURES FAIL (2 problem(s) in 4 files)" && !/PROCEDURES OK/.test(b.stdout), [b.status, b.stdout]);
      const c = run(["--root", root, "--json"]); let j = null; try { j = JSON.parse(c.stdout); } catch { /* reported below */ }
      ok("command line --json: the same result as JSON, exit 1", c.status === 1 && j && j.ok === false && j.problems.length === 2 && j.files === 4, [c.status, c.stdout.slice(0, 300)]);
      const d = run(["--root", root, "--record"]); ok("command line --record with no note: exit 2, nothing recorded", d.status === 2 && /at least 10 characters/.test(d.stdout), [d.status, d.stdout]);
      const e = run(["--root", path.join(tmp, "not-there")]); ok("command line on a folder that is not a repo: exit 1, never PROCEDURES OK", e.status === 1 && !/PROCEDURES OK/.test(e.stdout), [e.status, e.stdout]);
      const f = run(["--what"]); ok("command line with an unknown argument: exit 2 and the usage, nothing checked", f.status === 2 && /usage/.test(f.stdout) && !/PROCEDURES/.test(f.stdout), [f.status, f.stdout]);
      // review 2026-10-11: --record takes the name of the procedure that was reviewed
      { const root2 = fresh(); W(root2, ".claude/skills/alpha/SKILL.md", SKILL_A + "One more rule.\n"); W(root2, `${LOCAL}/procedure-beta.md`, LOCAL_B + "\nReviewed.\n"); const before = R(root2, SOURCES);
        const n0 = run(["--root", root2, "--record", "the two were both looked at"]);
        ok("command line --record \"<note>\" with two procedures changed: exit 2, \"not recorded: 2 procedures have a changed source …\", nothing written", n0.status === 2 && /^not recorded: 2 procedures have a changed source \(alpha\.md, beta\.md\)/.test(n0.stdout) && R(root2, SOURCES) === before, [n0.status, n0.stdout]);
        const n1 = run(["--root", root2, "--record", "alpha.md"]);
        ok("command line --record <procedure>.md with no note: exit 2 (a procedure's name is never taken for the note), nothing written", n1.status === 2 && /^not recorded: say what you reviewed, in at least 10 characters/.test(n1.stdout) && R(root2, SOURCES) === before, [n1.status, n1.stdout]);
        const n2 = run(["--root", root2, "--record", "alpha.md", "alpha: step 3 holds the new rule"]), l2 = n2.stdout.trim().split(/\r?\n/);
        ok("command line --record <procedure>.md \"<note>\": that one is recorded, the other is named as still to review, and the lint that follows still fails for it — exit 1, last line PROCEDURES FAIL (1 problem(s) in 4 files)", n2.status === 1 && l2[0] === `recorded: .claude/skills/alpha/SKILL.md (${SOURCES}) — for alpha.md` && l2[1] === "NOT recorded, still to review: beta.md" && /  local-drift  /.test(n2.stdout) && !/source-drift/.test(n2.stdout) && l2[l2.length - 1] === "PROCEDURES FAIL (1 problem(s) in 4 files)", [n2.status, l2]);
        const n3 = run(["--root", root2, "--record", "beta.md", "beta: the local steps were re-read"]), l3 = n3.stdout.trim().split(/\r?\n/);
        ok("… and once the second procedure is recorded by its own note: exit 0, PROCEDURES OK (4 files), two reviews on record", n3.status === 0 && l3[0] === `recorded: ${LOCAL}/procedure-beta.md (${SOURCES}) — for beta.md` && l3.length === 2 && l3[1] === "PROCEDURES OK (4 files)" && JSON.parse(R(root2, SOURCES)).reviews.length === 2, [n3.status, l3]);
        const root3 = fresh(); W(root3, ".claude/skills/alpha/SKILL.md", SKILL_A + "One more rule.\n"); W(root3, `${LOCAL}/procedure-beta.md`, LOCAL_B + "\nReviewed.\n");
        const before3 = R(root3, SOURCES), n5 = run(["--root", root3, "--record", "alpha.md", "a note of some length", "and one word too many"]), n6 = run(["--root", root3, "--record", "alpha.md", "--all", "both of them reviewed"]), untouched = R(root3, SOURCES) === before3;
        const n4 = run(["--root", root3, "--record", "--all", "both reviewed: alpha step 3, beta steps"]), l4 = n4.stdout.trim().split(/\r?\n/);
        ok("command line: three words after --record are exit 2 with the usage; a name together with --all is exit 2 \"not both\"; --record --all \"<note>\" records both under the one note the caller vouches for (exit 0, clean)", n5.status === 2 && /^usage: /.test(n5.stdout) && /--record <procedure>\.md/.test(n5.stdout) && n6.status === 2 && /^not recorded: name ONE procedure, or pass --all: not both/.test(n6.stdout) && untouched && n4.status === 0 && l4[0] === `recorded: .claude/skills/alpha/SKILL.md, ${LOCAL}/procedure-beta.md (${SOURCES}) — for alpha.md, beta.md` && l4[l4.length - 1] === "PROCEDURES OK (4 files)" && JSON.parse(R(root3, SOURCES)).reviews.length === 1, [n5.status, n6.status, n6.stdout, n4.status, l4]); } }
  } catch (e) { fail++; console.log("  FAIL the selftest itself threw — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a temp folder left behind harms nothing */ } }
  console.log(`procedures lint selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2), take = (k) => { const i = a.indexOf(k); if (i < 0) return undefined; const v = a[i + 1]; a.splice(i, v === undefined ? 1 : 2); return v === undefined ? "" : v; };
  const rootArg = take("--root"), root = rootArg ? path.resolve(rootArg) : REPO;
  const USAGE = "usage: node docs/procedures/lint.cjs [--json] | --record <procedure>.md \"<what you reviewed>\" | --record --all \"<what you reviewed>\" | --selftest   (--root <dir> for another copy of the repo)";
  const rec = a[0] === "--record" ? recordArgs(a.slice(1)) : null;
  if (a.length === 1 && a[0] === "--selftest") process.exitCode = selftest() ? 0 : 1;
  else if (rec) {
    let r; try { r = record(root, rec.note, new Date(), { only: rec.only, all: rec.all }); } catch (e) { r = { ok: false, why: `could not record (${String(e && e.message).slice(0, 200)})`, changed: [] }; }
    if (!r.ok) { console.log("not recorded: " + r.why); process.exitCode = 2; }
    else {
      console.log(`recorded: ${r.changed.length ? r.changed.join(", ") : "no hash changed"} (${SOURCES})${r.procedures.length ? " — for " + r.procedures.join(", ") : ""}`);
      if (r.stillChanged.length) console.log(`NOT recorded, still to review: ${r.stillChanged.join(", ")}`);
      const rep = report(lint(root)); console.log(rep.text); process.exitCode = rep.ok ? 0 : 1;
    }
  } else if (a.length === 0 || (a.length === 1 && a[0] === "--json")) {
    let r; try { r = lint(root); } catch (e) { r = { files: 0, checked: [], pages: [], notes: [], problems: [{ file: PROC, line: 0, rule: "lint-error", msg: `the lint itself failed (${String(e && e.message).slice(0, 200)}) — nothing was checked` }] }; }
    const rep = report(r);
    console.log(a[0] === "--json" ? JSON.stringify({ ok: rep.ok, files: r.files, checked: r.checked, pages: r.pages || [], problems: r.problems, notes: r.notes }, null, 1) : rep.text);
    process.exitCode = rep.ok ? 0 : 1;
  } else { console.log(USAGE); process.exitCode = 2; }
}
