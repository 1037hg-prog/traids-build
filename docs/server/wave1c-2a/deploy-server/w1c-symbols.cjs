#!/usr/bin/env node
/**
 * W1C SYMBOLS — builds backend/data/crypto-symbols.json, the crypto universe the VPS's spread snapshot reads (crypto-spread-snapshot.js
 * --symbols-file). 2026-10-08 (docs/server/wave1c-2a). Installed at home as deploy/server/w1c-symbols.cjs; run nightly by the close-chain
 * step "crypto symbols for the VPS (W1c)", right before "pull server files (w1c, w2a)", which pushes it to the VPS read-only (0444) while
 * W1c is server-owned (pull-server.cjs input entry). Home-only: it reads the ledger; the VPS never does.
 *
 * THE UNIVERSE IS NOT CHANGED BY THE MOVE. symbols = crypto-spread-snapshot.js's own cryptoUniverse() — every Crypto row of
 * data/trade_log.json — exactly what home measures today, so the VPS measures the same names. lib/reconcile.js cleanEraLedger() reads
 * the SAME file, and its settled signals and controls are a subset of those rows. So the check below (every settled Crypto symbol must be
 * in the list, else REFUSED and the previous file kept) is a CONSISTENCY check between two readers of one file, not an independent
 * source: on today's code it cannot refuse; it refuses only if the two readers ever diverge (e.g. reconcile.js reading another file).
 * The settled set is narrower (pre-epoch and unsettled names omitted; --check on 2026-10-08: 52 of the 54); building from it alone would
 * drop names from the instrument, a population change this package does not make.
 *
 *   node deploy/server/w1c-symbols.cjs            build + write (atomic, backend/lib/atomic-write.js)
 *   node deploy/server/w1c-symbols.cjs --check    build and print, write nothing
 *   node deploy/server/w1c-symbols.cjs --selftest temp trees only
 * Exit 0 written / unchanged · 1 refused (nothing written; the previous file stays) · 2 bad arguments.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const findRepo = (from) => { for (let d = from; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, "backend", "data")) && fs.existsSync(path.join(d, "deploy"))) return d; if (path.dirname(d) === d) return null; } };
const REPO = findRepo(__dirname);
const SYM_RE = /^[A-Z0-9]{1,15}\/USD$/;

/** build the file's content from a backend dir (its crypto-spread-snapshot.js, lib/reconcile.js and data/) -> { doc } | throws */
function build(backendDir, now = new Date()) {
  const universe = require(path.join(backendDir, "crypto-spread-snapshot.js")).cryptoUniverse();
  const L = require(path.join(backendDir, "lib", "reconcile.js")).cleanEraLedger();
  const canon = [...new Set([...(L.signals || []), ...(L.controls || [])].filter((t) => t && t.cls === "Crypto" && t.sym).map((t) => t.sym))].sort();
  if (!Array.isArray(universe) || !universe.length) throw new Error("the ledger holds no Crypto symbol — REFUSED (an empty universe is never pushed)");
  const bad = universe.filter((s) => typeof s !== "string" || !SYM_RE.test(s));
  if (bad.length) throw new Error(`symbol(s) not of the form XXX/USD: ${bad.slice(0, 5).map((s) => JSON.stringify(s)).join(", ")} — REFUSED (the VPS would refuse the file)`);
  const missing = canon.filter((s) => !universe.includes(s));
  if (missing.length) throw new Error(`the canonical clean-era ledger (lib/reconcile.js cleanEraLedger) holds Crypto symbol(s) the universe lacks: ${missing.slice(0, 8).join(", ")} — REFUSED (the two reads of the same ledger disagree)`);
  return { doc: { schema: "crypto-symbols-v1", builtAt: now.toISOString(), by: "deploy/server/w1c-symbols.cjs",
    source: "data/trade_log.json — every Crypto row, as backend/crypto-spread-snapshot.js cryptoUniverse() reads it (the universe home measures)",
    canonical: { read: "lib/reconcile.js cleanEraLedger()", settledCryptoSymbols: canon.length, allInUniverse: true, notSettled: universe.filter((s) => !canon.includes(s)) },
    symbols: universe } };
}
function main(argv) {
  if (argv.some((x) => x !== "--check") || argv.length > 1) { console.error("usage: w1c-symbols.cjs [--check] · --selftest"); return 2; }
  if (!REPO) { console.error("w1c-symbols: repo root not found"); return 2; }
  const B = path.join(REPO, "backend"), OUT = path.join(B, "data", "crypto-symbols.json");
  let r; try { r = build(B); } catch (e) { console.error(`w1c-symbols: ${e.message}`); return 1; }
  const d = r.doc; let prev = null; try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { prev = null; }
  const same = prev && JSON.stringify(prev.symbols) === JSON.stringify(d.symbols);
  const line = `w1c-symbols: ${d.symbols.length} symbols (canonical settled ${d.canonical.settledCryptoSymbols}, all in the list; not settled: ${d.canonical.notSettled.join(", ") || "none"})${prev ? same ? " · list unchanged" : ` · list CHANGED (was ${(prev.symbols || []).length})` : " · first build"}`;
  if (argv[0] === "--check") { console.log(line + " · --check: nothing written"); return 0; }
  require(path.join(B, "lib", "atomic-write.js")).writeJsonAtomic(OUT, d);
  console.log(line + ` · written data/crypto-symbols.json (built ${d.builtAt})`);
  return 0;
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, x) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (x ? " — " + x : "")); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w1c-symbols-"));
  const STAGED = path.join(__dirname, "..", "backend", "crypto-spread-snapshot.js"), INSTALLED_SNAP = path.join(REPO, "backend", "crypto-spread-snapshot.js");
  const snapSrc = fs.existsSync(STAGED) ? STAGED : INSTALLED_SNAP;
  const tree = (name, ledger, reconcile = null) => {
    const B = path.join(tmp, name); fs.mkdirSync(path.join(B, "lib"), { recursive: true }); fs.mkdirSync(path.join(B, "data"));
    fs.copyFileSync(snapSrc, path.join(B, "crypto-spread-snapshot.js"));
    if (reconcile) fs.writeFileSync(path.join(B, "lib", "reconcile.js"), reconcile); else fs.copyFileSync(path.join(REPO, "backend", "lib", "reconcile.js"), path.join(B, "lib", "reconcile.js"));
    fs.writeFileSync(path.join(B, "data", "trade_log.json"), JSON.stringify(ledger)); fs.writeFileSync(path.join(B, "data", "change-registry.json"), "[]");
    return B;
  };
  const closed = Date.parse("2026-09-01T12:00:00Z"), pre = Date.parse("2026-07-01T12:00:00Z");
  const T = (sym, o = {}) => ({ cls: "Crypto", sym, rMult: 0.5, pnl: 10, closedAt: closed, ...o });
  try {
    const saved = {}; for (const k of Object.keys(process.env)) if (/^ALPACA/.test(k)) { saved[k] = process.env[k]; delete process.env[k]; }
    try {
      const B1 = tree("a", [T("SOL/USD"), T("BTC/USD"), T("ARB/USD", { closedAt: pre }), T("JUP/USD", { rMult: undefined, pnl: undefined }), T("BTC/USD"), { cls: "Equity", sym: "AAPL", rMult: 1, pnl: 1, closedAt: closed }]);
      const r = build(B1, new Date("2026-10-09T21:00:00Z"));
      ok("universe = every Crypto row of the ledger (as cryptoUniverse reads it), sorted, unique — pre-epoch and unsettled names KEPT", JSON.stringify(r.doc.symbols) === JSON.stringify(["ARB/USD", "BTC/USD", "JUP/USD", "SOL/USD"]));
      ok("cross-check recorded: the canonical settled set (2) is inside the list; the names outside it are named", r.doc.canonical.settledCryptoSymbols === 2 && r.doc.canonical.allInUniverse === true && JSON.stringify(r.doc.canonical.notSettled) === JSON.stringify(["ARB/USD", "JUP/USD"]) && r.doc.schema === "crypto-symbols-v1");
      const SN = require(path.join(B1, "crypto-spread-snapshot.js"));
      fs.writeFileSync(path.join(B1, "data", "crypto-symbols.json"), JSON.stringify(r.doc));
      ok("round trip: the VPS reader (symbolsFromFile) reads back exactly the built list", JSON.stringify(SN.symbolsFromFile(path.join(B1, "data", "crypto-symbols.json")).symbols) === JSON.stringify(r.doc.symbols));
      const th = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
      ok("an empty universe -> REFUSED", /no Crypto symbol/.test(th(() => build(tree("b", [{ cls: "Equity", sym: "AAPL" }]))) || ""));
      ok("a symbol the VPS reader would refuse (not XXX/USD) -> REFUSED here, before it is pushed", /not of the form XXX\/USD/.test(th(() => build(tree("c", [T("BTC/USD"), T("btc-usd")]))) || ""));
      const fakeRec = 'module.exports = { cleanEraLedger: () => ({ signals: [{ cls: "Crypto", sym: "XYZ/USD" }], controls: [] }) };';
      ok("the canonical ledger names a symbol the universe lacks (two reads disagree) -> REFUSED", /canonical clean-era ledger[^]*XYZ\/USD[^]*REFUSED/.test(th(() => build(tree("d", [T("BTC/USD")], fakeRec))) || ""));
    } finally { Object.assign(process.env, saved); }
    // the CLI in a temp repo: writes atomically; a refusal keeps the previous file
    const R = path.join(tmp, "repo"); fs.mkdirSync(path.join(R, "deploy", "server"), { recursive: true }); fs.mkdirSync(path.join(R, "backend", "data"), { recursive: true }); fs.mkdirSync(path.join(R, "backend", "lib"));
    fs.copyFileSync(__filename, path.join(R, "deploy", "server", "w1c-symbols.cjs")); fs.copyFileSync(snapSrc, path.join(R, "backend", "crypto-spread-snapshot.js"));
    for (const f of ["reconcile.js", "atomic-write.js"]) fs.copyFileSync(path.join(REPO, "backend", "lib", f), path.join(R, "backend", "lib", f));
    fs.writeFileSync(path.join(R, "backend", "data", "change-registry.json"), "[]"); fs.writeFileSync(path.join(R, "backend", "data", "trade_log.json"), JSON.stringify([T("ETH/USD"), T("BTC/USD")]));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/ALPACA|TELEGRAM|SMTP|SCHWAB|TASTY/i.test(k)));
    const run = (...a) => require("child_process").spawnSync(process.execPath, [path.join(R, "deploy", "server", "w1c-symbols.cjs"), ...a], { encoding: "utf8", windowsHide: true, env });
    const OUT = path.join(R, "backend", "data", "crypto-symbols.json");
    const c = run("--check");
    ok("--check: prints the list size, writes nothing", c.status === 0 && /2 symbols/.test(c.stdout) && !fs.existsSync(OUT), c.stdout + c.stderr);
    const w = run(); const doc = JSON.parse(fs.readFileSync(OUT, "utf8"));
    ok("run: writes data/crypto-symbols.json (exit 0)", w.status === 0 && JSON.stringify(doc.symbols) === JSON.stringify(["BTC/USD", "ETH/USD"]) && /first build/.test(w.stdout), w.stdout + w.stderr);
    fs.writeFileSync(path.join(R, "backend", "data", "trade_log.json"), JSON.stringify([T("bad")]));
    const bad = run();
    ok("a refused build: exit 1, the previous file left byte for byte", bad.status === 1 && JSON.stringify(JSON.parse(fs.readFileSync(OUT, "utf8"))) === JSON.stringify(doc), bad.stderr);
    ok("bad arguments -> exit 2", run("--dry").status === 2 && run("--check", "x").status === 2);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`w1c-symbols selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  if (process.argv[2] === "--selftest" && process.argv.length === 3) process.exitCode = selftest() ? 0 : 1;
  else process.exitCode = main(process.argv.slice(2));
}
module.exports = { build, main };
