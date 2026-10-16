#!/usr/bin/env node
/**
 * HOME PATCH — the PC-side changes of W-P (remainder) + W1, as ANCHORED, reversible edits. 2026-10-07 (docs/server/wave1-crypto).
 * Applied ONLY by deploy.cjs (step home); reverted by rollback.cjs --home. Nothing here runs a chain step, and close-chain.cjs is read
 * as TEXT only — never require()d (the 2026-09-08 incident); `node --check` is the only check run on it.
 *
 * WHY ANCHORS, NOT A WHOLE-FILE SHA. automation/close-chain.cjs changes almost daily; a sha pin would refuse every deploy. Each edit is
 * pinned instead to EXACT anchor text that must occur exactly once (refused otherwise, nothing written): an insert is placed at its
 * anchor; a replace swaps one exact line. "applied" = every inserted block sits at its anchor exactly once and every replaced line is
 * in its new form; "base" = every anchor present once and none of the new text; anything else is DRIFT (refused, file by file named).
 * Revert removes exactly what was inserted and swaps the lines back, so later unrelated edits of the same file survive a rollback.
 * A copy of each file as it was before the edit is kept as <file>.pre-w1-2026-10-08.bak (a record; revert does not need it).
 *
 *   automation/close-chain.cjs  "pull server files" FIRST and "pull server files (before git snapshot)" just before "git snapshot";
 *                               the four W1 steps tagged { ownedBy }; the runner skips a step whose unit the map gives to the server
 *                               ("skipped (server-owned)") and never guesses on an unreadable map (not run, warned, never "failed")
 *   automation/preflight.bat    the pull line before `node backend\preflight.js` (in the file's own line endings: it is LF today)
 *   backend/preflight.js        "w1 server recorders" (lib/w1-health.cjs): started beside R309's probe, collected before the verdict,
 *                               level WARN for FAIL / WARN / UNKNOWN (DEGRADED, never NO-GO)
 *   backend/ops-health.js       section 7: the same check; anything but PASS is a finding
 *   NEW deploy/server/{pull-server.cjs, own.cjs, manifests/r309.json, manifests/w1.json, own-check.cjs, w1-run.cjs, w1-probe.cjs,
 *       systemd/traids-w1{,s}-{whales,funding,social}.{service,timer}} (the deployed truth) and backend/lib/w1-health.cjs
 *
 *   node docs/server/wave1-crypto/home-patch.cjs --plan       each entry's state now (no write)
 *   node docs/server/wave1-crypto/home-patch.cjs --selftest   every edit on temp copies of the CURRENT files (or their reconstructed
 *        base), node --check, then a SCRATCH copy of close-chain.cjs with a fake step list run as a child (never the real one)
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", "..");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const STAMP = "2026-10-08";
const BAK = (rel) => `${rel}.pre-w1-${STAMP}.bak`;
const count = (t, s) => { let n = 0; for (let i = t.indexOf(s); i >= 0; i = t.indexOf(s, i + 1)) n++; return n; };

// ── close-chain.cjs ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const PULL_FIRST = `  // SERVER PULL (2026-10-08, server migration M3, docs/server/wave1-crypto) — FIRST, so every later step reads the VPS-owned units'
  // files as of now. Pulls only units backend/data/host-ownership.json marks "server" (none before the W1 cutover: then no pull ssh);
  // validated, atomic, one way; never a switch or a lock. --probe-ssh close-chain: one read-only \`ssh traids true\` from THIS task's
  // principal (S4U), recorded in pull-server-status.json — own.cjs w1 server refuses until it has succeeded. Exit 1 = a unit refused /
  // ssh failed (FAIL); 3 = a unit busy on the VPS, the home lock held, or the probe failed (WARN, named); 4 = home r309-HALT missing.
  ["pull server files", "deploy/server/pull-server.cjs", 5, { args: ["--wave", "w1", "--probe-ssh", "close-chain"], warnExit: [3] }],
`;
const PULL_GIT = `  ["pull server files (before git snapshot)", "deploy/server/pull-server.cjs", 5, { args: ["--wave", "w1"], warnExit: [3] }],   // 2026-10-08 (server migration M3): brings home what the VPS recorded since the chain-start pull (funding 16:30 ET, social 16:35 ET) for tonight's commit. NOT that evening's whales + R323: their 21:30 UTC run starts about when this step runs in daylight time (git snapshot ~21:30 UTC on 10-06), so they reach home at the next preflight pull and git a night later; a run still holding its lock reads busy -> WARN (exit 3)
`;
const RUNNER_OWN = `  /**
   * SERVER OWNERSHIP (2026-10-08, server migration M2, docs/server/wave1-crypto). A step tagged { ownedBy: "<unit>" } runs here only
   * while backend/data/host-ownership.json says "home" for that unit; "server" -> not run, status "skipped (server-owned)" (the VPS runs
   * it; "pull server files" brings its files home). A map that cannot be read, or that names no host for the unit, is never a guess:
   * the step is NOT run and is recorded with a warning (status.warned), never as failed (self-heal replays only failed steps). The map
   * changes only through deploy/server/own.cjs.
   */
  if (opts.ownedBy) {
    let owner = null, ownWhy = null;
    try { const m = JSON.parse(fs.readFileSync(D("host-ownership.json"), "utf8")); owner = m && m.schema === "host-ownership-v1" && m.units ? m.units[opts.ownedBy] : undefined; if (owner !== "home" && owner !== "server") ownWhy = \`host-ownership.json names no host for \${opts.ownedBy} (\${JSON.stringify(owner)})\`; }
    catch (e) { ownWhy = \`host-ownership.json unreadable (\${e.code || String(e.message).slice(0, 60)})\`; }
    if (ownWhy) { status.steps.push({ name, skipped: true, ownedBy: opts.ownedBy, why: "not run — ownership unknown", warn: \`ownership unknown, not run (refusing to guess the host): \${ownWhy}\` }); console.log(\`  WARN \${name.padEnd(24)} not run — \${ownWhy}\`); continue; }
    if (owner === "server") { status.steps.push({ name, skipped: true, ownedBy: opts.ownedBy, why: "skipped (server-owned)" }); console.log(\`  SKIP \${name.padEnd(24)} skipped (server-owned)\`); continue; }
  }
`;
const TAGS = [
  ['  ["funding carry collector (#55)", "backend/funding-carry-v2.js", 6],', '  ["funding carry collector (#55)", "backend/funding-carry-v2.js", 6, { ownedBy: "w1-funding" }],'],
  ['  ["social mentions record", "backend/social-mentions-record.js", 2, { allowExit: [1] }],', '  ["social mentions record", "backend/social-mentions-record.js", 2, { allowExit: [1], ownedBy: "w1-social" }],'],
  ['  ["hyperliquid whales record", "backend/hyperliquid-whales-record.js", 5, { allowExit: [1] }],', '  ["hyperliquid whales record", "backend/hyperliquid-whales-record.js", 5, { allowExit: [1], ownedBy: "w1-whales" }],'],
  ['  ["r323 hl copy leaders (score)", "backend/r323-hl-copy-leaders.js", 25, { args: ["--score"], allowExit: [4] }],', '  ["r323 hl copy leaders (score)", "backend/r323-hl-copy-leaders.js", 25, { args: ["--score"], allowExit: [4], ownedBy: "w1-whales" }],'],
];
const CHAIN_OPS = [
  { kind: "insert", anchor: "const STEPS = [\n", text: PULL_FIRST, where: "after" },
  { kind: "insert", anchor: '  ["git snapshot", "automation/git-snapshot.cjs", 10],\n', text: PULL_GIT, where: "before" },
  ...TAGS.map(([from, to]) => ({ kind: "replace", from, to })),
  { kind: "insert", anchor: "  if (opts.onlyOn != null && ![].concat(opts.onlyOn).includes(DOW)) {\n", text: RUNNER_OWN, where: "before" },
];
// ── preflight.bat (LF today; inserted in the file's own line endings) ───────────────────────────────────────────────────────
const BAT_LINE = `:: 2026-10-08 (server migration M3, docs\\server\\wave1-crypto): pull the VPS-owned units' files home first - one way, validated, atomic;
:: only units backend\\data\\host-ownership.json marks "server" (none before the W1 cutover: then only the probe ssh). --probe-ssh: one
:: read-only "ssh traids true" from this task's principal (S4U), recorded in pull-server-status.json (own.cjs w1 server needs it to have
:: succeeded). Its exit code is not used here: preflight's "w1 server recorders" line reports a failing pull or stale files (DEGRADED).
node deploy\\server\\pull-server.cjs --wave w1 --probe-ssh preflight.bat >> automation\\pull-server.log 2>&1
`;
const BAT_OPS = [{ kind: "insert", anchor: "node backend\\preflight.js >> automation\\preflight.log 2>&1\n", text: BAT_LINE, where: "before" }];
// ── preflight.js ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const PF_HEAD_ANCHOR = ` * 2026-10-06 (R309 go-live): "r309 server cycle" — lib/r309-health.cjs probes the VPS over ssh (read-only); FAIL / UNKNOWN level warn (DEGRADED, never NO-GO).\n`;
const PF_HEAD = ` * 2026-10-08 (server migration W1): "w1 server recorders" — lib/w1-health.cjs judges the VPS-owned W1 recorders (no ssh while home owns them); FAIL / WARN / UNKNOWN level warn (DEGRADED, never NO-GO).\n`;
const PF_START_ANCHOR = `  const r309P = R309H ? R309H.check({ host: "traids" }).catch((e) => ({ name: "r309 server cycle", level: "warn", ok: false, detail: \`UNKNOWN — the check crashed (\${String(e.message).slice(0, 80)}); R309's hourly cycle on the VPS is unverified\`, status: "UNKNOWN" })) : null;\n`;
const PF_START = `  // W1 SERVER RECORDERS (2026-10-08, server migration M4): the crypto recorders the VPS owns (lib/w1-health.cjs; no ssh while home owns
  // them). Started now, collected before the verdict. FAIL / WARN / UNKNOWN are all level WARN, ok=false (DEGRADED, never NO-GO): the
  // W1 recorders gate no home trading. A module that will not load is UNKNOWN, never a silent skip.
  let W1H = null, W1H_ERR = null;
  try { W1H = require("./lib/w1-health.cjs"); } catch (e) { W1H_ERR = e; }
  const w1P = W1H ? W1H.check({ host: "traids" }).catch((e) => ({ name: "w1 server recorders", level: "warn", ok: false, detail: \`UNKNOWN — the check crashed (\${String(e.message).slice(0, 80)}); the W1 recorders are unverified\`, status: "UNKNOWN" })) : null;
`;
const PF_COLLECT_ANCHOR = `  else add("r309 server cycle", "warn", false, \`UNKNOWN — lib/r309-health.cjs failed to load (\${String(R309H_ERR && R309H_ERR.message).slice(0, 90)}); R309's hourly cycle on the VPS is unverified\`, "UNKNOWN");\n`;
const PF_COLLECT = `
  // W1 SERVER RECORDERS (2026-10-08) — started at the top, collected here.
  if (w1P) addR(await w1P);
  else add("w1 server recorders", "warn", false, \`UNKNOWN — lib/w1-health.cjs failed to load (\${String(W1H_ERR && W1H_ERR.message).slice(0, 90)}); the W1 recorders are unverified\`, "UNKNOWN");
`;
const PF_OPS = [
  { kind: "insert", anchor: PF_HEAD_ANCHOR, text: PF_HEAD, where: "after" },
  { kind: "insert", anchor: PF_START_ANCHOR, text: PF_START, where: "after" },
  { kind: "insert", anchor: PF_COLLECT_ANCHOR, text: PF_COLLECT, where: "after" },
];
// ── ops-health.js ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const OH_HEAD_ANCHOR = ` *   6. R309      — the VPS completes R309's hourly cycle (lib/r309-health.cjs; 2026-10-06). UNKNOWN counts as a finding.\n`;
const OH_HEAD = ` *   7. W1        — the VPS-owned W1 recorders are current (lib/w1-health.cjs; 2026-10-08). UNKNOWN counts as a finding.\n`;
const OH_ANCHOR = `  } catch (e) { note("r309", "R309 hourly cycle (VPS)", "UNKNOWN — the check could not run (" + String(e.message).slice(0, 70) + ")"); }\n`;
const OH_INSERT = `
  // ── 7. W1 RECORDERS ON THE VPS (2026-10-08, server migration M4) ─────────
  // lib/w1-health.cjs: PASS while home owns them (no ssh); otherwise one read-only ssh. Anything but PASS is a finding, UNKNOWN included.
  try {
    const v = await require("./lib/w1-health.cjs").run({ host: "traids" });
    if (v.status !== "PASS") note("w1", "W1 recorders (VPS)", \`\${v.status} — \${v.detail}\`);
  } catch (e) { note("w1", "W1 recorders (VPS)", "UNKNOWN — the check could not run (" + String(e.message).slice(0, 70) + ")"); }
`;
const OH_OPS = [
  { kind: "insert", anchor: OH_HEAD_ANCHOR, text: OH_HEAD, where: "after" },
  { kind: "insert", anchor: OH_ANCHOR, text: OH_INSERT, where: "after" },
];

const S = (rel) => path.join(HERE, rel);
const EDITS = [
  { rel: "automation/close-chain.cjs", ops: CHAIN_OPS, check: "node" },
  { rel: "automation/preflight.bat", ops: BAT_OPS, check: "bat" },
  { rel: "backend/preflight.js", ops: PF_OPS, check: "node" },
  { rel: "backend/ops-health.js", ops: OH_OPS, check: "node" },
];
const NEW = [
  ["deploy/server/pull-server.cjs", "pull-server.cjs"], ["deploy/server/own.cjs", "own.cjs"],
  ["deploy/server/manifests/r309.json", "manifests/r309.json"], ["deploy/server/manifests/w1.json", "manifests/w1.json"],
  ["deploy/server/own-check.cjs", "backend/own-check.cjs"], ["deploy/server/w1-run.cjs", "backend/w1-run.cjs"], ["deploy/server/w1-probe.cjs", "backend/w1-probe.cjs"],
  ...["whales", "funding", "social"].flatMap((x) => ["", "s"].flatMap((s) => ["service", "timer"].map((k) => [`deploy/server/systemd/traids-w1${s}-${x}.${k}`, `systemd/traids-w1${s}-${x}.${k}`]))),
  ["backend/lib/w1-health.cjs", "w1-health.cjs"],
].map(([rel, from]) => ({ rel, from: S(from) }));

// ── the anchored-edit engine (pure on text) ──────────────────────────────────────────────────────────────────────────────────
const eolOf = (t) => { const crlf = count(t, "\r\n"), lf = count(t, "\n"); return crlf === 0 ? "\n" : crlf === lf ? "\r\n" : null; };
const conv = (s, eol) => (eol === "\r\n" ? s.replace(/\r?\n/g, "\r\n") : s);
const placed = (op, eol) => { const a = conv(op.anchor, eol), x = conv(op.text, eol); return op.where === "after" ? a + x : x + a; };
/** one op's state in text t: "base" | "applied" | why-not (string) */
function opState(op, t, eol) {
  if (op.kind === "insert") {
    const a = conv(op.anchor, eol), x = conv(op.text, eol), p = placed(op, eol);
    if (count(t, p) === 1 && count(t, x) === 1) return "applied";
    if (count(t, a) === 1 && count(t, x) === 0) return "base";
    return `anchor ${JSON.stringify(op.anchor.slice(0, 70))} found ${count(t, a)}x, inserted block found ${count(t, x)}x`;
  }
  const f = conv(op.from, eol), to = conv(op.to, eol);
  if (count(t, to) === 1 && count(t, f) === 0) return "applied";
  if (count(t, f) === 1 && count(t, to) === 0) return "base";
  return `line ${JSON.stringify(op.from.slice(0, 70))} found ${count(t, f)}x, its new form ${count(t, to)}x`;
}
function textState(entry, t) {
  const eol = eolOf(t);
  if (eol == null) return { state: "drift", why: `${entry.rel} has mixed line endings` };
  const st = entry.ops.map((op) => opState(op, t, eol));
  if (st.every((s) => s === "base")) return { state: "base", eol };
  if (st.every((s) => s === "applied")) return { state: "applied", eol };
  return { state: "drift", why: `${entry.rel}: ${st.map((s, i) => (s === "base" || s === "applied" ? null : `op ${i + 1}: ${s}`)).filter(Boolean).join("; ") || "partly applied (" + st.join(",") + ")"}` };
}
const once = (t, s, r) => { const i = t.indexOf(s); if (i < 0 || t.indexOf(s, i + 1) >= 0) throw new Error(`not found exactly once: ${JSON.stringify(s.slice(0, 70))}`); return t.slice(0, i) + r + t.slice(i + s.length); };
function applyText(entry, t) {
  const eol = eolOf(t);
  for (const op of entry.ops) t = op.kind === "insert" ? once(t, conv(op.anchor, eol), placed(op, eol)) : once(t, conv(op.from, eol), conv(op.to, eol));
  return t;
}
function revertText(entry, t) {
  const eol = eolOf(t);
  for (const op of [...entry.ops].reverse()) t = op.kind === "insert" ? once(t, placed(op, eol), conv(op.anchor, eol)) : once(t, conv(op.to, eol), conv(op.from, eol));
  return t;
}
function nodeCheckText(text, name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "w1-check-")), f = path.join(d, path.basename(name));
  try { fs.writeFileSync(f, text); const r = cp.spawnSync(process.execPath, ["--check", f], { encoding: "utf8", windowsHide: true }); if (r.status !== 0) throw new Error(`node --check ${name} FAILED: ${String(r.stderr).trim().slice(0, 300)}`); }
  finally { fs.rmSync(d, { recursive: true, force: true }); }
}
const atomicWrite = (f, data) => { const tmp = f + ".tmp-w1-" + process.pid; fs.writeFileSync(tmp, data); fs.renameSync(tmp, f); };

// ── per-entry state, apply, revert against a repo root ───────────────────────────────────────────────────────────────────────
/** a NEW file is "the staged copy" when equal byte for byte, or equal once CRLF is read as LF: git checks these files out under
 *  core.autocrlf=true, and backend/lib/w1-health.cjs and deploy/server/manifests/*.json have no eol attribute (review 2026-10-07) */
const lfOf = (b) => Buffer.from(b.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
const sameStaged = (cur, want) => cur.equals(want) || lfOf(cur).equals(lfOf(want));
function stateOf(entry, root = REPO) {
  const f = path.join(root, entry.rel);
  if (entry.from) {
    const want = fs.readFileSync(entry.from), cur = fs.existsSync(f) ? fs.readFileSync(f) : null;
    return cur == null ? { state: "base" } : sameStaged(cur, want) ? { state: "applied" } : { state: "drift", why: `${entry.rel} exists and is not the staged copy` };
  }
  if (!fs.existsSync(f)) return { state: "drift", why: `${entry.rel} is missing` };
  return textState(entry, fs.readFileSync(f, "utf8"));
}
const ALL = () => [...NEW, ...EDITS];
function applyAll(root = REPO, { dry = false } = {}) {
  const st = ALL().map((e) => ({ e, s: stateOf(e, root) })), drift = st.filter((x) => x.s.state === "drift");
  if (drift.length) throw new Error("REFUSED (nothing changed): " + drift.map((x) => x.s.why).join(" | "));
  const lines = [], plan = [];
  for (const { e, s } of st) {   // compute every new text first (and node --check it) before writing anything
    if (s.state === "applied") { lines.push(`already applied  ${e.rel}`); continue; }
    if (e.from) { plan.push({ e, data: fs.readFileSync(e.from), isNew: true }); continue; }
    const cur = fs.readFileSync(path.join(root, e.rel), "utf8"), next = applyText(e, cur);
    if (e.check === "node") nodeCheckText(next, e.rel);
    if (textState(e, next).state !== "applied") throw new Error(`REFUSED (nothing changed): ${e.rel} would not read as applied after the edit`);
    plan.push({ e, data: next, cur });
  }
  for (const p of plan) {   // NEW files first (the edits reference them), then the edits
    lines.push(`${dry ? "would apply" : "apply"}      ${p.e.rel}${p.isNew ? " (new)" : ` (anchored; copy kept as ${path.basename(BAK(p.e.rel))})`}`);
    if (dry) continue;
    const f = path.join(root, p.e.rel); fs.mkdirSync(path.dirname(f), { recursive: true });
    if (!p.isNew) fs.writeFileSync(path.join(root, BAK(p.e.rel)), p.cur);
    atomicWrite(f, p.data);
  }
  if (!dry) for (const e of EDITS) if (e.check === "node") { const r = cp.spawnSync(process.execPath, ["--check", path.join(root, e.rel)], { encoding: "utf8", windowsHide: true }); if (r.status !== 0) throw new Error(`node --check ${e.rel} FAILED after the write — run rollback.cjs --home: ${r.stderr}`); }
  return lines;
}
function revertAll(root = REPO, { dry = false } = {}) {
  const lines = [], todo = [];
  for (const e of [...EDITS].reverse()) {
    const f = path.join(root, e.rel); if (!fs.existsSync(f)) throw new Error(`REFUSED (nothing reverted): ${e.rel} is missing`);
    const cur = fs.readFileSync(f, "utf8"), s = textState(e, cur);
    if (s.state === "base") { lines.push(`nothing to undo  ${e.rel}`); continue; }
    if (s.state !== "applied") throw new Error(`REFUSED (nothing reverted): ${s.why} — revert it by hand (the pre-edit copy is ${path.basename(BAK(e.rel))})`);
    const back = revertText(e, cur); if (e.check === "node") nodeCheckText(back, e.rel);
    todo.push(() => atomicWrite(f, back)); lines.push(`${dry ? "would revert" : "revert"}     ${e.rel} (the inserted blocks removed, the tagged lines restored)`);
  }
  // a NEW file someone edited is KEPT and named (remove it by hand) — it never blocks the revert of the chain / preflight edits
  const kept = [];
  for (const e of NEW) {
    const f = path.join(root, e.rel); if (!fs.existsSync(f)) { lines.push(`nothing to undo  ${e.rel}`); continue; }
    if (!sameStaged(fs.readFileSync(f), fs.readFileSync(e.from))) { kept.push(e.rel); lines.push(`KEPT             ${e.rel} — not the staged copy any more (edited after the deploy): remove it by hand once reviewed`); continue; }
    todo.push(() => fs.unlinkSync(f)); lines.push(`${dry ? "would remove" : "remove"}     ${e.rel}`);
  }
  if (!dry) for (const t of todo) t();
  if (kept.length) lines.push(`NOTE: ${kept.length} new file(s) kept (edited since the deploy): ${kept.join(", ")}`);
  return lines;
}

// ── selftest ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** the chain text with its STEPS array replaced by a fake list (scratch only) */
function withFakeSteps(chainText, stepsJs) {
  const i = chainText.indexOf("const STEPS = [\n"), j = chainText.indexOf("\n];\n", i);
  if (i < 0 || j < 0) throw new Error("STEPS array not found");
  const region = chainText.slice(i, j + 4);
  if (!region.includes('["git snapshot", "automation/git-snapshot.cjs", 10]')) throw new Error("the cut region is not the step list");
  return chainText.slice(0, i) + `const STEPS = [\n${stepsJs}\n];\n` + chainText.slice(j + 4);
}
/** parse a chain step line (text) -> [name, script, mins, optsText] */
function chainLine(t, name) {
  const l = t.split(/\r?\n/).find((x) => x.startsWith(`  [${JSON.stringify(name)},`));
  if (!l) return null;
  const m = /^  \["([^"]+)", "([^"]+)", (\d+)(?:, (\{.*?\}))?\],/.exec(l);
  return m ? { name: m[1], script: m[2], mins: Number(m[3]), opts: m[4] ? Function(`"use strict"; return (${m[4]});`)() : {} } : null;
}
function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + String(d).slice(0, 600) : "")); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w1-homepatch-"));
  try {
    console.log("home-patch selftest (" + tmp + ")");
    // 1. the real home files: no drift; each edit's BASE reconstructed (reverting the anchored edits of an applied file) into a temp tree
    const real = ALL().map((e) => ({ e, s: stateOf(e, REPO) })), drift = real.filter((x) => x.s.state === "drift");
    ok(`the real home files: no drift (${real.filter((x) => x.s.state === "base").length} at base, ${real.filter((x) => x.s.state === "applied").length} applied); every anchor found exactly once`, !drift.length, drift.map((x) => x.s.why).join(" | "));
    const T = path.join(tmp, "repo");
    for (const { e, s } of real) {
      if (e.from) continue;                                                               // NEW files: base = absent
      const cur = fs.readFileSync(path.join(REPO, e.rel), "utf8"), base = s.state === "applied" ? revertText(e, cur) : cur;
      fs.mkdirSync(path.dirname(path.join(T, e.rel)), { recursive: true }); fs.writeFileSync(path.join(T, e.rel), base);
    }
    ok("the temp tree holds every entry's base", ALL().every((e) => stateOf(e, T).state === "base"), ALL().map((e) => e.rel + ":" + stateOf(e, T).state).join(" "));
    const baseText = Object.fromEntries(EDITS.map((e) => [e.rel, fs.readFileSync(path.join(T, e.rel), "utf8")]));
    const lines = applyAll(T);
    ok(`apply: ${NEW.length} new files + ${EDITS.length} anchored edits`, lines.filter((l) => /^apply/.test(l)).length === NEW.length + EDITS.length, lines.join(" | "));
    ok("apply again: idempotent (everything 'already applied')", applyAll(T).every((l) => /^already applied/.test(l)));
    for (const rel of ["automation/close-chain.cjs", "backend/preflight.js", "backend/ops-health.js", "backend/lib/w1-health.cjs", "deploy/server/pull-server.cjs", "deploy/server/own.cjs", "deploy/server/own-check.cjs", "deploy/server/w1-run.cjs", "deploy/server/w1-probe.cjs"]) {
      const r = cp.spawnSync(process.execPath, ["--check", path.join(T, rel)], { encoding: "utf8" }); ok(`node --check ${rel}`, r.status === 0, r.stderr);
    }
    const ch = fs.readFileSync(path.join(T, "automation/close-chain.cjs"), "utf8"), steps = ch.slice(ch.indexOf("const STEPS = ["), ch.indexOf("\n];\n", ch.indexOf("const STEPS = [")));
    const stepNames = [...steps.matchAll(/^  \["([^"]+)",/gm)].map((m) => m[1]);
    ok("chain: \"pull server files\" is the FIRST step; \"pull server files (before git snapshot)\" sits immediately before \"git snapshot\"", stepNames[0] === "pull server files" && stepNames[stepNames.indexOf("git snapshot") - 1] === "pull server files (before git snapshot)" && stepNames.filter((n) => /^pull server files/.test(n)).length === 2, stepNames.slice(0, 3).join(" | "));
    const own = { "funding carry collector (#55)": "w1-funding", "social mentions record": "w1-social", "hyperliquid whales record": "w1-whales", "r323 hl copy leaders (score)": "w1-whales" };
    ok("chain: exactly the four W1 steps are tagged, each with its unit; nothing else carries ownedBy", Object.entries(own).every(([n, u]) => (chainLine(ch, n) || {}).opts.ownedBy === u) && count(steps, "ownedBy:") === 4 && stepNames.indexOf("r323 hl copy leaders (score)") === stepNames.indexOf("hyperliquid whales record") + 1);
    ok("chain: the tagged lines keep their scripts, minutes and options (only ownedBy added)", Object.keys(own).every((n) => { const a = chainLine(baseText["automation/close-chain.cjs"], n), b = chainLine(ch, n); const { ownedBy, ...rest } = b.opts; return a && a.script === b.script && a.mins === b.mins && JSON.stringify(a.opts) === JSON.stringify(rest); }));
    // the server wrapper's table = the chain lines (scripts, minutes, args, allowExit)
    const W = require(path.join(HERE, "backend", "w1-run.cjs")).UNITS;
    const wr = Object.values(W).flat().map(([name, script, mins, o]) => ({ name, script, mins, args: o.args || [], allowExit: o.allowExit || [] }));
    ok("w1-run.cjs's table matches the chain lines exactly (script, minutes, args, allowExit) for all four steps", wr.length === 4 && wr.every((x) => { const c = chainLine(ch, x.name); return c && c.script === "backend/" + x.script && c.mins === x.mins && JSON.stringify(c.opts.args || []) === JSON.stringify(x.args) && JSON.stringify(c.opts.allowExit || []) === JSON.stringify(x.allowExit); }), JSON.stringify(wr));
    // the patched (real) chain OBEYS the map by the same text check own.cjs (cutover) and w1-health (every run) apply; the base does not
    const PSX = require(path.join(HERE, "pull-server.cjs")), W1DEFS = Object.entries(PSX.loadManifest("w1", path.join(HERE, "manifests")).units);
    ok("chain tags: the patched chain passes pull-server's chainTagIssues for every W1 unit; the unpatched base fails it (so the check can see a lost tag)", PSX.chainTagIssues(ch, W1DEFS).length === 0 && PSX.chainTagIssues(baseText["automation/close-chain.cjs"], W1DEFS).length >= 5, PSX.chainTagIssues(ch, W1DEFS).join(" | "));
    { const pf = chainLine(ch, "pull server files"), pg = chainLine(ch, "pull server files (before git snapshot)");
      ok("chain: both pull steps record exit 3 as WARN (warnExit [3]: busy / lock held / probe failed is never a quiet ok); the first probes ssh as close-chain", pf && pg && JSON.stringify(pf.opts.warnExit) === "[3]" && JSON.stringify(pg.opts.warnExit) === "[3]" && JSON.stringify(pf.opts.args) === JSON.stringify(["--wave", "w1", "--probe-ssh", "close-chain"]) && JSON.stringify(pg.opts.args) === JSON.stringify(["--wave", "w1"]), JSON.stringify([pf, pg])); }
    // the INSTALLED copies work in the installed layout (deploy/server/ holds pull-server, own, own-check side by side; manifests/)
    fs.mkdirSync(path.join(T, "backend", "data"), { recursive: true }); fs.copyFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"), path.join(T, "backend", "lib", "atomic-write.js"));
    for (const s of ["pull-server.cjs", "own.cjs", "own-check.cjs", "w1-run.cjs", "w1-probe.cjs"]) {
      const r = cp.spawnSync(process.execPath, [path.join(T, "deploy", "server", s), "--selftest"], { cwd: T, encoding: "utf8", timeout: 300000, windowsHide: true });
      ok(`installed layout: deploy/server/${s} --selftest passes`, r.status === 0 && / 0 failed/.test(r.stdout), String(r.stdout).split("\n").filter((l) => /FAIL|Error/.test(l)).join(" | ") + String(r.stderr).slice(0, 300));
    }
    { const r = cp.spawnSync(process.execPath, [path.join(T, "backend", "lib", "w1-health.cjs"), "--selftest"], { cwd: T, encoding: "utf8", timeout: 120000, windowsHide: true }); ok("installed layout: backend/lib/w1-health.cjs --selftest passes", r.status === 0 && / 0 failed/.test(r.stdout), r.stdout.slice(-300)); }
    fs.rmSync(path.join(T, "backend", "lib", "atomic-write.js")); fs.rmSync(path.join(T, "backend", "data"), { recursive: true, force: true });
    // 2. the patched RUNNER on a SCRATCH copy with a fake step list, run as a child (the real chain is never required or run)
    const SC = path.join(tmp, "scratch"); fs.mkdirSync(path.join(SC, "automation"), { recursive: true }); fs.mkdirSync(path.join(SC, "backend", "lib"), { recursive: true }); fs.mkdirSync(path.join(SC, "backend", "data"));
    fs.writeFileSync(path.join(SC, "backend", "lib", "run-window.js"), "module.exports = { guardOrExit() {} };\n");
    fs.writeFileSync(path.join(SC, "backend", "mark.js"), "require('fs').appendFileSync(require('path').join(__dirname, 'data', 'marks.txt'), process.argv[2] + '\\n');\n");
    const fake = [
      '  ["untagged", "backend/mark.js", 1, { args: ["untagged"] }],',
      '  ["owned-home", "backend/mark.js", 1, { args: ["owned-home"], ownedBy: "u-home" }],',
      '  ["owned-server", "backend/mark.js", 1, { args: ["owned-server"], ownedBy: "u-server" }],',
      '  ["owned-unnamed", "backend/mark.js", 1, { args: ["owned-unnamed"], ownedBy: "u-unnamed" }],',
      '  ["weekly", "backend/mark.js", 1, { args: ["weekly"], onlyOn: [9] }],',
    ].join("\n");
    fs.writeFileSync(path.join(SC, "automation", "close-chain.cjs"), withFakeSteps(ch, fake));
    const runChain = (map) => {
      const D2 = path.join(SC, "backend", "data"); for (const f of ["marks.txt", "chain-status.json"]) fs.rmSync(path.join(D2, f), { force: true });
      if (map === null) fs.rmSync(path.join(D2, "host-ownership.json"), { force: true }); else fs.writeFileSync(path.join(D2, "host-ownership.json"), map);
      const r = cp.spawnSync(process.execPath, [path.join(SC, "automation", "close-chain.cjs")], { cwd: SC, encoding: "utf8", timeout: 60000, windowsHide: true });
      let st = null; try { st = JSON.parse(fs.readFileSync(path.join(D2, "chain-status.json"), "utf8")); } catch { st = null; }
      const marks = fs.existsSync(path.join(D2, "marks.txt")) ? fs.readFileSync(path.join(D2, "marks.txt"), "utf8").trim().split(/\r?\n/) : [];
      return { r, st, marks, by: (n) => st && st.steps.find((s) => s.name === n) };
    };
    const A = runChain(JSON.stringify({ schema: "host-ownership-v1", units: { "u-home": "home", "u-server": "server" } }));
    ok("scratch chain: home-owned and untagged steps RUN; the server-owned step is NOT run and reads 'skipped (server-owned)'", A.r.status === 0 && A.marks.join(",") === "untagged,owned-home" && A.by("owned-server").skipped === true && A.by("owned-server").why === "skipped (server-owned)" && A.by("owned-server").ok === undefined, (A.st && JSON.stringify(A.st.steps)) + A.r.stdout + A.r.stderr);
    ok("scratch chain: a unit the map does not name is NOT run, recorded as a warning (status.warned), never as failed", A.by("owned-unnamed").skipped && /ownership unknown/.test(A.by("owned-unnamed").warn || "") && A.st.warned.includes("owned-unnamed") && !A.st.failed.length && A.by("owned-unnamed").ok === undefined);
    ok("scratch chain: the weekly (onlyOn) gate still applies after the ownership check", A.by("weekly").skipped && /weekly step/.test(A.by("weekly").why));
    const B = runChain("{ torn");
    ok("scratch chain: an unreadable map -> every tagged step NOT run (warned), the untagged step runs, nothing 'failed'", B.marks.join(",") === "untagged" && ["owned-home", "owned-server", "owned-unnamed"].every((n) => /unreadable|does not parse|Unexpected|JSON/i.test((B.by(n) || {}).warn || "")) && !B.st.failed.length, B.st && JSON.stringify(B.st.steps));
    const C = runChain(null);
    ok("scratch chain: a missing map -> tagged steps not run (warned: ENOENT), never guessed", C.marks.join(",") === "untagged" && /ENOENT/.test((C.by("owned-home") || {}).warn || ""));
    const Dd = runChain(JSON.stringify({ schema: "host-ownership-v1", units: { "u-home": "server", "u-server": "home", "u-unnamed": "home" } }));
    ok("scratch chain: flipping the map flips which steps run (rollback restores home runs with no chain edit)", Dd.marks.join(",") === "untagged,owned-server,owned-unnamed" && Dd.by("owned-home").why === "skipped (server-owned)");
    // 3. preflight.bat: one pull line before preflight.js, the file's own LF endings kept
    const bat = fs.readFileSync(path.join(T, "automation/preflight.bat"), "utf8"), bl = bat.split("\n");
    const iPull = bl.findIndex((l) => /^node deploy\\server\\pull-server\.cjs --wave w1 --probe-ssh preflight\.bat >> automation\\pull-server\.log 2>&1$/.test(l)), iPf = bl.findIndex((l) => /^node backend\\preflight\.js >> automation\\preflight\.log 2>&1$/.test(l));
    ok("preflight.bat: the pull line sits right before node backend\\preflight.js; line endings unchanged (" + (eolOf(baseText["automation/preflight.bat"]) === "\n" ? "LF" : "CRLF") + ")", iPull >= 0 && iPf === iPull + 1 && eolOf(bat) === eolOf(baseText["automation/preflight.bat"]) && count(bat, "pull-server.cjs") === 1);
    // 4. preflight.js / ops-health.js placement and levels
    const pf = fs.readFileSync(path.join(T, "backend/preflight.js"), "utf8"), oh = fs.readFileSync(path.join(T, "backend/ops-health.js"), "utf8");
    ok("preflight: the W1 probe starts after R309's and is collected after R309's, before the verdict", pf.indexOf("const w1P") > pf.indexOf("const r309P") && pf.indexOf("addR(await w1P)") > pf.indexOf("addR(await r309P)") && pf.indexOf("addR(await w1P)") < pf.indexOf("// ── verdict"));
    const w1Block = PF_START + PF_COLLECT;
    ok("preflight: every W1 line is level warn (the check, its crash, its load failure) — never critical", !/"critical"/.test(w1Block) && (w1Block.match(/"warn"/g) || []).length === 2);
    ok("ops-health: section 7 sits after section 6 and before the report", oh.indexOf("7. W1 RECORDERS ON THE VPS") > oh.indexOf("6. R309 ON THE VPS") && oh.indexOf("7. W1 RECORDERS ON THE VPS") < oh.indexOf("── report + transition alarm"));
    // 5. revert: byte-equal to the base, new files gone; drift refuses
    const rv = revertAll(T);
    ok("revert: every edited file byte-equal to its base, every new file removed", EDITS.every((e) => fs.readFileSync(path.join(T, e.rel), "utf8") === baseText[e.rel]) && NEW.every((e) => !fs.existsSync(path.join(T, e.rel))), rv.join(" | "));
    applyAll(T);
    fs.appendFileSync(path.join(T, "automation/close-chain.cjs"), "\n// someone's later edit\n");
    const rv2 = revertAll(T);
    ok("revert after an unrelated later edit of close-chain.cjs: our blocks removed, the later edit kept", fs.readFileSync(path.join(T, "automation/close-chain.cjs"), "utf8") === baseText["automation/close-chain.cjs"] + "\n// someone's later edit\n", rv2.join(" | "));
    fs.writeFileSync(path.join(T, "automation/close-chain.cjs"), baseText["automation/close-chain.cjs"]);
    applyAll(T);
    { const crlf = (rel) => { const f = path.join(T, rel); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/\r?\n/g, "\r\n")); };
      crlf("backend/lib/w1-health.cjs"); crlf("deploy/server/manifests/w1.json");   // what a checkout under core.autocrlf=true gives (no eol attribute)
      fs.appendFileSync(path.join(T, "deploy/server/own.cjs"), "\n// a hand edit after the deploy\n");
      const nf = NEW.find((e) => e.rel === "backend/lib/w1-health.cjs");
      ok("NEW files: a CRLF checkout of a staged copy still reads 'applied' (not drift)", stateOf(nf, T).state === "applied");
      const rv3 = revertAll(T);
      ok("revert: CRLF copies are removed; an EDITED new file is KEPT and named — and the chain / preflight / ops-health edits are reverted anyway (never one refusal for all)", EDITS.every((e) => fs.readFileSync(path.join(T, e.rel), "utf8") === baseText[e.rel]) && !fs.existsSync(path.join(T, "backend/lib/w1-health.cjs")) && !fs.existsSync(path.join(T, "deploy/server/manifests/w1.json")) && fs.existsSync(path.join(T, "deploy/server/own.cjs")) && rv3.some((l) => /^KEPT\s+deploy\/server\/own\.cjs/.test(l)), rv3.join(" | "));
      fs.rmSync(path.join(T, "deploy/server/own.cjs")); }
    fs.writeFileSync(path.join(T, "automation/close-chain.cjs"), baseText["automation/close-chain.cjs"].replace('  ["git snapshot", "automation/git-snapshot.cjs", 10],\n', '  ["git snapshot", "automation/git-snapshot.cjs", 12],\n'));
    let e1 = null; try { applyAll(T); } catch (e) { e1 = e.message; }
    ok("drift: an anchor line changed (git snapshot's minutes) -> the whole apply refuses, nothing written", /REFUSED \(nothing changed\)[^]*close-chain\.cjs: op 2/.test(e1 || "") && !fs.existsSync(path.join(T, "deploy/server/pull-server.cjs")), e1);
    fs.writeFileSync(path.join(T, "automation/close-chain.cjs"), baseText["automation/close-chain.cjs"].replace('  ["social mentions record"', '  ["social mentions record", "backend/social-mentions-record.js", 2, { allowExit: [1] }],\n  ["social mentions record"'));
    let e2 = null; try { applyAll(T); } catch (e) { e2 = e.message; }
    ok("drift: a tagged line present twice -> refused", /REFUSED[^]*found 2x/.test(e2 || ""), e2);
    fs.writeFileSync(path.join(T, "automation/close-chain.cjs"), baseText["automation/close-chain.cjs"].replace("const status = { started", "const status = {{ started"));
    let e3 = null; try { const ent = EDITS[0], nt = applyText(ent, fs.readFileSync(path.join(T, ent.rel), "utf8")); nodeCheckText(nt, ent.rel); } catch (e) { e3 = e.message; }
    ok("a syntax error in the result is caught by node --check before any write", /node --check automation\/close-chain\.cjs FAILED/.test(e3 || ""), e3);
    ok("the bak name and no require() of close-chain.cjs anywhere in this file", BAK("automation/close-chain.cjs") === "automation/close-chain.cjs.pre-w1-2026-10-08.bak" && !/require\([^)]*close-chain/.test(fs.readFileSync(__filename, "utf8").replace(/\/\/[^\n]*|\/\*[^]*?\*\//g, "").replace(/"[^"\n]*"/g, '""')));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`home-patch selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  try {
    if (a.includes("--selftest")) process.exitCode = selftest() ? 0 : 1;
    else if (a.includes("--plan")) { for (const e of ALL()) { const s = stateOf(e); console.log(`${s.state.padEnd(8)} ${e.rel}${s.why ? " — " + s.why : ""}`); } process.exitCode = 0; }
    else { console.log("home-patch is applied by deploy.cjs (step home) and reverted by rollback.cjs --home. --plan / --selftest here."); process.exitCode = 2; }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { EDITS, NEW, ALL, stateOf, applyAll, revertAll, textState, applyText, revertText, BAK, withFakeSteps, chainLine };
