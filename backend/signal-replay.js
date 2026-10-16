#!/usr/bin/env node
/**
 * TRAIDS — SIGNAL REPLAY LOADER (2026-07-25)
 *
 * Makes the board's OWN signal functions callable from Node, so historical replay and live
 * scanning cannot disagree.
 *
 * WHY NOT JUST COPY THE FUNCTIONS: because then there would be two implementations of the
 * signal logic, they would drift, and every number produced by the historical generator would
 * be a claim about code that is no longer running. The training set would slowly stop
 * describing the system it is meant to train. That failure is silent and unrecoverable — you
 * cannot tell a drifted dataset from a good one by looking at it.
 *
 * So instead the functions are EXTRACTED FROM src/App.jsx at load time and evaluated here.
 * There is exactly one copy of the signal logic in the repository, and it is the one the board
 * runs. If someone edits a signal in App.jsx, the next replay uses the edit automatically.
 *
 * This works because every signal function is a pure top-level function of (bars, i) that
 * slices only up to i — no component state, no closures over React, and no look-ahead. That
 * property is asserted by the self-test below rather than assumed.
 *
 * Dependencies are resolved transitively: give it the signal names and it pulls in whatever
 * indicators and constants those reference, from the same source.
 *
 * Usage
 *   const S = require("./signal-replay");
 *   S.breakoutSignal(bars, i)  ·  S.meanRevSignal(bars, i)  ·  S.trendSignal(bars, i)
 *   S.ensembleSignal(bars, i)
 *
 * Self-test:  node backend/signal-replay.js
 */
const fs = require("fs"), path = require("path");

const APP = path.join(__dirname, "..", "src", "App.jsx");

/**
 * Index every top-level declaration in App.jsx that could be a signal dependency.
 * Top-level here means the declaration starts at column 0, which in this file reliably
 * distinguishes module scope from anything nested inside a component.
 */
/**
 * Extract ONE named top-level declaration by brace-matching from its opening brace.
 *
 * Two earlier attempts at this failed in instructive ways and are worth recording, since both
 * failed SILENTLY on some declarations while succeeding on others:
 *   1. "scan forward to a `}` at column 0" — mis-parsed single-line functions, whose closing
 *      brace is mid-line, so the scan ran on and swallowed the following function whole.
 *   2. per-line bracket-depth counting — corrupted by multi-line template literals and by
 *      braces inside regex literals (`/\}/` contributes an unmatched brace).
 * Hence: extract only the declarations actually needed, by character scan, with string,
 * template, comment and regex state tracked properly.
 */
function extractDecl(src, name) {
  const pat = new RegExp(`(^|\\n)(function\\s+${name}\\s*\\(|const\\s+${name}\\s*=)`);
  const m = pat.exec(src);
  if (!m) return null;
  const start = m.index + (m[1] ? 1 : 0);

  // An arrow-function or scalar const with no block body ends at its terminating semicolon.
  const firstBrace = src.indexOf("{", start);
  const firstSemi = src.indexOf(";", start);
  const nl = src.indexOf("\n", start);
  if (/^const/.test(src.slice(start, start + 5)) && firstSemi > -1 && (firstBrace === -1 || firstSemi < firstBrace) && firstSemi < nl) {
    return src.slice(start, firstSemi + 1);
  }
  if (firstBrace === -1) return null;

  let depth = 0, i = firstBrace, str = null, tmpl = false, line = false, block = false, re = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1], p = src[i - 1];
    if (line) { if (c === "\n") line = false; continue; }
    if (block) { if (c === "*" && n === "/") { block = false; i++; } continue; }
    if (str) { if (c === "\\") { i++; continue; } if (c === str) str = null; continue; }
    if (tmpl) { if (c === "\\") { i++; continue; } if (c === "`") tmpl = false; continue; }
    if (re) { if (c === "\\") { i++; continue; } if (c === "/") re = false; continue; }
    if (c === "/" && n === "/") { line = true; i++; continue; }
    if (c === "/" && n === "*") { block = true; i++; continue; }
    if (c === '"' || c === "'") { str = c; continue; }
    if (c === "`") { tmpl = true; continue; }
    // A `/` starts a regex only where a value is expected — after an operator or delimiter.
    if (c === "/" && /[=(,:[!&|?{};+\-*%~^<>]/.test((src.slice(0, i).match(/\S(?=\s*$)/) || [""])[0])) { re = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

/** Identifiers in a chunk of source that are themselves top-level declarations in App.jsx. */
function referencedDecls(src, body, cache) {
  const out = [];
  for (const id of new Set(body.match(/[A-Za-z_$][\w$]*/g) || [])) {
    if (cache.has(id)) { if (cache.get(id)) out.push(id); continue; }
    const found = extractDecl(src, id);
    cache.set(id, found);
    if (found) out.push(id);
  }
  return out;
}

// Signal functions, plus the indicators that CALLERS use directly. The indicators are listed
// explicitly rather than left to the transitive closure: `atr` is referenced by no signal
// function, so it silently failed to export until a caller needed it. A dependency a consumer
// relies on should be declared, not inherited by coincidence.
const SEEDS = [
  "ensembleSignal", "breakoutSignal", "meanRevSignal", "trendSignal",
  "ensembleSignalWithRegime", "detectRegime", "getRegimeWeights",
  "sma", "ema", "rsi", "atr", "adx", "roc", "macdIndicator", "bollingerBands",
];

function build() {
  const src = fs.readFileSync(APP, "utf8");
  const cache = new Map();
  const decls = new Map();
  const missingSeeds = [];

  // Transitive closure over the seeds, resolving dependencies on demand.
  const queue = [];
  for (const s of SEEDS) {
    const d = extractDecl(src, s);
    cache.set(s, d);
    if (d) { decls.set(s, d); queue.push(s); } else missingSeeds.push(s);
  }
  while (queue.length) {
    const name = queue.shift();
    for (const dep of referencedDecls(src, decls.get(name), cache)) {
      if (!decls.has(dep)) { decls.set(dep, cache.get(dep)); queue.push(dep); }
    }
  }

  // `const` does not hoist, so emit declarations in their original source order — which is
  // also the order the app itself relies on.
  const order = [...decls.keys()].sort((a, b) => src.indexOf(decls.get(a)) - src.indexOf(decls.get(b)));
  const code = order.map(n => decls.get(n)).join("\n\n");

  let exported;
  try {
    exported = new Function(`"use strict";\n${code}\nreturn { ${order.join(", ")} };`)();
  } catch (e) {
    throw new Error(`signal-replay could not evaluate the extracted signal code — ${e.message}\n` +
      `This usually means App.jsx changed in a way the extractor does not handle. Fix the extractor ` +
      `rather than copying the functions here: two divergent copies of the signal logic is the exact ` +
      `failure this module exists to prevent.`);
  }
  return { fns: exported, included: order, missingSeeds, decls: decls.size };
}

const built = build();
module.exports = { ...built.fns, _meta: { included: built.included, missingSeeds: built.missingSeeds, indexed: built.decls } };

// ── self-test ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const S = module.exports;
  console.log(`\n  TRAIDS — SIGNAL REPLAY LOADER SELF-TEST\n`);
  console.log(`  indexed ${built.decls} top-level declarations in src/App.jsx`);
  console.log(`  extracted ${built.included.length}: ${built.included.join(", ")}`);
  if (built.missingSeeds.length) console.log(`  ⚠ seeds not found: ${built.missingSeeds.join(", ")}`);

  // Synthetic series with a known shape: 120 bars of uptrend, then a volume-confirmed
  // breakout on the last bar. Known-answer rather than "did it run without throwing".
  const bars = [];
  for (let i = 0; i < 140; i++) {
    const base = 100 + i * 0.5 + Math.sin(i / 7) * 1.5;
    bars.push({ date: `d${i}`, open: base - 0.2, high: base + 0.6, low: base - 0.6, close: base, volume: 1e6 });
  }
  const last = bars.length - 1;
  bars[last] = { date: "brk", open: 168, high: 178, low: 167.5, close: 177.5, volume: 5e6 };  // clear break, 5× volume

  const checks = [];
  const b = S.breakoutSignal(bars, last);
  checks.push(["breakoutSignal fires on a volume-confirmed new high", b.vote > 0 && b.confidence > 0.5, `vote ${b.vote?.toFixed(3)} conf ${b.confidence?.toFixed(3)}`]);

  const bNoVol = bars.map((x, i) => i === last ? { ...x, volume: 1e5 } : x);   // break, but no volume
  const b2 = S.breakoutSignal(bNoVol, last);
  checks.push(["breakoutSignal refuses an unconfirmed break", b2.vote === 0, `vote ${b2.vote}`]);

  const t = S.trendSignal(bars, last - 1);
  checks.push(["trendSignal recognises the uptrend", t.vote > 0, `vote ${t.vote?.toFixed(3)} — ${t.rationale || "no rationale"}`]);

  const e = S.ensembleSignal(bars, last - 1);
  checks.push(["ensembleSignal returns a weighted vote", Number.isFinite(e.vote) && Number.isFinite(e.confidence), `vote ${e.vote?.toFixed(3)} conf ${e.confidence?.toFixed(3)}`]);

  // THE CRITICAL PROPERTY: a signal at index i must not change when future bars are appended.
  // If it does, the function peeks, and every label in the training set would be contaminated.
  const mid = 100;
  const truncated = bars.slice(0, mid + 1);
  const sameOnTruncated = ["breakoutSignal", "meanRevSignal", "trendSignal", "ensembleSignal"].every(n => {
    const full = JSON.stringify(S[n](bars, mid)), trunc = JSON.stringify(S[n](truncated, mid));
    if (full !== trunc) console.log(`      ${n}: full=${full} truncated=${trunc}`);
    return full === trunc;
  });
  checks.push(["NO LOOK-AHEAD — signals at i are identical with and without future bars", sameOnTruncated, "all four signal functions"]);

  let fail = 0;
  for (const [label, pass, detail] of checks) {
    console.log(`  ${pass ? "✓" : "✗ FAIL"}  ${label}`);
    console.log(`       ${detail}`);
    if (!pass) fail++;
  }
  console.log(`\n  ${fail ? `✗ ${fail} check(s) failed — do not generate a training set from this` : "✓ all checks passed — the board's own signal functions are callable and look-ahead-free"}\n`);
  process.exit(fail ? 1 : 0);
}
