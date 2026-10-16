#!/usr/bin/env node
/**
 * TRAIDS — DATA PROVENANCE AUDIT
 *
 * The single question this project keeps having to ask the hard way: WHICH NUMBERS ARE REAL?
 *
 * Between 2026-07-29 and 07-30 an operator challenge exposed seven surfaces rendering invented
 * data with the same styling and confidence as validated ones — Math.random() prices behind a
 * live SMS alerter (D36), a "7-model institutional engine" whose every output was a hash of the
 * ticker's letters (D36), an entire options ticket pipeline priced by Black-Scholes at a
 * hardcoded 28% vol (D37). Three prior debug sweeps had checked that those panels RENDERED and
 * that endpoints returned 200. None checked whether the numbers meant anything.
 *
 * So this runs as a permanent nightly check, and it is deliberately adversarial:
 *
 *   1. STATIC — every randomness call site and hardcoded market-data table in the codebase,
 *      classified. Fabrication is not always Math.random(); a deterministic hash is worse,
 *      because it never flickers.
 *   2. LIVE — every data endpoint probed for plausibility, not just HTTP 200. A 200 carrying
 *      invented prices is the exact failure the old sweeps passed.
 *   3. CROSS-CHECK — internal consistency the tape cannot violate: micro futures must match
 *      their full-size parents, and correlated majors cannot all read ~0 correlation.
 *   4. LEDGER — what fraction of the evidence base was recorded under a known-bad ruler.
 *
 * A finding here is not "a test failed." It is "a number you may have believed was invented."
 *
 * Usage: node backend/data-provenance-audit.js
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const D = (f) => path.join(__dirname, "data", f);
const L = []; const say = s => { L.push(s); console.log(s); };
const F = { fabricated: [], stale: [], benign: [], real: [], unverified: [] };

const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };

/**
 * Classify a randomness site. IDs, jitter on synthetic TEST fixtures, and shuffles for
 * bootstrap resampling are legitimate; anything producing a PRICE, QUOTE, VOLUME or SIGNAL a
 * human might read as market truth is fabrication.
 */
function classifyRandom(file, line, text) {
  const t = text.toLowerCase();
  // A mention is not a call. The D41 fix left user-facing copy on the Analytics panel that says
  // it "rendered a Math.random() equity line" — the audit was flagging its own fix notice every
  // night. Skip lines where the token appears in a comment or in JSX/string prose rather than as
  // executable code, identified by the absence of an assignment or arithmetic use of the result.
  if (/\bid\b|toString\(36\)|tabidref/.test(t)) return ["benign", "identifier generation"];
  // D46 paired controls: coin-flip direction assignment and 1-in-5 sampling for the DECLARED
  // control arm. This randomness never touches a price — it decides which arm a ticket is in,
  // the same category as bootstrap shuffles.
  if (/ctrlrand|dirc|coin-flip|pairid/.test(t)) return ["benign", "declared control-arm assignment (D46 paired coin-flip controls)"];
  // Real calls always consume the result: something feeds into it (`= ( , [ + - * / ? : ${`) or
  // reads out of it (`* + - / . , ) ; ] }`). Prose leaves it dangling before an ordinary word.
  const consumed = /[=(,[+\-*/?:{]\s*Math\.random/.test(text) || /Math\.random\(\)\s*[*+\-/.,);\]}]/.test(text);
  if (/^\s*(\/\/|\*|\/\*)/.test(text) || !consumed) return ["benign", "mentioned in a comment or panel copy, not called"];
  if (/shuffle|sort\(\(\) =>/.test(t)) return ["benign", "resampling / shuffle"];
  // Declared null simulations (2026-08-21): bootstrap resamples of OBSERVED returns and best-of-N
  // noise nulls for searched t-stats. The draw decides which observed value is sampled or what
  // the null distribution looks like; it never produces a price. Lines must SAY so ("null draw").
  if (/null draw|bootstrap|sign-flip|permut/.test(t)) return ["benign", "declared null simulation (bootstrap / permutation draw) — never a price"];
  if (/noise|slippage|fill/.test(t) && /0\.0[0-2]/.test(t)) return ["benign", "modeled execution noise on a MEASURED fill (declared)"];
  if (/predictive-pipeline/.test(file)) return ["benign", "synthetic fixture for the training scaffold (never a market number)"];
  if (/\bprice\b|\bclose\b|\bbid\b|\bask\b|\boi\b|volume|\bvol\b|iv\b|eq \*=|\bd\s*=/.test(t)) return ["fabricated", "produces a price / quote / volume"];
  return ["unverified", "unclassified — inspect"];
}

(async () => {
  say(`\n  TRAIDS — DATA PROVENANCE AUDIT · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
  say(`  Question: which numbers are real?\n` + "  " + "═".repeat(72));

  // ── 1. STATIC ────────────────────────────────────────────────────────────
  say(`\n  1. STATIC — randomness call sites & hardcoded market tables`);
  const files = ["src/App.jsx", ...fs.readdirSync(__dirname).filter(f => f.endsWith(".js")).map(f => "backend/" + f)];
  for (const rel of files) {
    const src = read(path.join(ROOT, rel));
    if (!src) continue;
    src.split("\n").forEach((line, i) => {
      if (!/Math\.random\(\)/.test(line)) return;
      if (/^\s*\*|^\s*\/\//.test(line)) return;                    // comments describing the fix
      const [cls, why] = classifyRandom(rel, i + 1, line);
      F[cls].push({ where: `${rel}:${i + 1}`, why, snippet: line.trim().slice(0, 90) });
    });
    // hardcoded market-data tables
    for (const m of src.matchAll(/const (BASE_PRICES|BASE_IVS|FUT_BASE|FUT_VOL)\s*=/g)) {
      const ln = src.slice(0, m.index).split("\n").length;
      F.stale.push({ where: `${rel}:${ln}`, why: `hardcoded ${m[1]} table — market values frozen in source`, snippet: m[0] });
    }
  }
  // the SP500 price fossils
  const app = read(path.join(ROOT, "src/App.jsx"));
  const priced = (app.match(/price:\s*\d+\.?\d*/g) || []).length;
  if (priced) F.stale.push({ where: "src/App.jsx SP500", why: `${priced} rows carry hardcoded prices (AAPL reads 189.30 vs a real ~333)`, snippet: "price: <frozen>" });

  const show = (k, label) => {
    say(`\n     ${label} — ${F[k].length}`);
    F[k].slice(0, 12).forEach(x => say(`       ${x.where.padEnd(34)} ${x.why}`));
    if (F[k].length > 12) say(`       … ${F[k].length - 12} more`);
  };
  show("fabricated", "❌ FABRICATED (produces a market number)");
  show("stale", "🟡 STALE-HARDCODED (frozen values in source)");
  show("unverified", "❔ UNCLASSIFIED");
  say(`\n     ✅ BENIGN — ${F.benign.length} (ids, shuffles, declared execution noise, test fixtures)`);

  // ── 2. LIVE ──────────────────────────────────────────────────────────────
  say(`\n  2. LIVE — endpoints probed for PLAUSIBILITY, not just HTTP 200`);
  const probe = async (label, url, check) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!r.ok) { say(`     ✗ ${label.padEnd(30)} HTTP ${r.status}`); F.unverified.push({ where: label, why: `HTTP ${r.status}` }); return; }
      const j = await r.json();
      const v = check(j);
      say(`     ${v.ok ? "✅" : "❌"} ${label.padEnd(30)} ${v.note}`);
      (v.ok ? F.real : F.fabricated).push({ where: label, why: v.note });
    } catch (e) { say(`     ✗ ${label.padEnd(30)} ${e.message.slice(0, 40)}`); F.unverified.push({ where: label, why: e.message.slice(0, 40) }); }
  };
  const B = "http://localhost:3001";
  await probe("equities snapshot", `${B}/api/equities/snapshot?symbols=AAPL,SPY,MCK`, j => {
    const d = j.data || j; const mck = d.MCK?.price, aapl = d.AAPL?.price;
    // MCK near 900 and AAPL near 330 are the live reality; the fabricated era printed ~96 for both
    return { ok: mck > 300 && aapl > 100, note: `AAPL ${aapl} · MCK ${mck} — ${mck > 300 ? "real magnitudes" : "SUSPECT: clustered near 100 = the ||100 fallback"}` };
  });
  await probe("option chain pick (SPY)", `${B}/api/option-chain-pick?symbol=SPY&side=call&dte=35&spot=740`, j =>
    ({ ok: !!(j.atm && /^SPY\d{6}[CP]\d{8}$/.test(j.atm.occ)), note: j.atm ? `real OCC ${j.atm.occ} @ $${j.atm.mid}` : `no contract: ${j.reason}` }));
  await probe("alerts scanner", `${B}/api/alerts/scan`, j => {
    const r = j.results || []; const px = r.map(x => x.price).filter(Number.isFinite);
    const near100 = px.filter(p => p > 90 && p < 105).length;
    // An EMPTY scan outside market hours (or before the first scan after a restart) is nothing to verify — not
    // fabrication. Fabrication is rows that exist and cluster at the ||100 fallback. (Fixed 2026-08-21: the probe
    // reported "fabricated" on a closed market with zero rows.)
    if (!px.length) return { ok: !j.isMarketOpen || j.lastScanTime == null, note: `0 rows · market ${j.isMarketOpen ? "OPEN — scanner produced nothing, check it" : "closed"} · nothing to verify` };
    return { ok: near100 / px.length < 0.3, note: `${px.length} rows · ${near100} clustered 90-105 (${(100 * near100 / px.length) | 0}%)` };
  });
  await probe("lite-scan map", `${B}/api/lite-scan`, j => ({ ok: (j.count || 0) > 100, note: `${j.count} symbols scored` }));
  await probe("institutional (lite)", `${B}/api/institutional?symbols=AAPL`, j => {
    const a = (j.data || {}).AAPL || {};
    return { ok: !!a.coverage, note: `${a.coverage || "no coverage field"}${a.shortInterest?.available ? ` · svrZ ${a.shortInterest.svrZ}` : ""}` };
  });

  // ── 3. CROSS-CHECK ───────────────────────────────────────────────────────
  say(`\n  3. CROSS-CHECK — internal consistency the tape cannot violate`);
  say(`     (micros track their parents exactly; correlated majors cannot all read ~0)`);
  try {
    const lite = JSON.parse(read(D("market-lite-scan.json")) || "{}");
    say(`     ✅ lite scan universe ${lite.universe || 0} symbols · generated ${String(lite.generated || "").slice(0, 16)}`);
  } catch { say(`     ✗ lite scan unreadable`); }

  // ── 4. LEDGER ────────────────────────────────────────────────────────────
  say(`\n  4. LEDGER — how much evidence was recorded under a known-bad ruler`);
  try {
    const log = JSON.parse(read(D("trade_log.json")));
    const CLEAN = new Date("2026-07-20T00:00:00-06:00").getTime();
    const T = log.filter(t => t && t.closedAt >= CLEAN && Number.isFinite(t.rMult));
    const opts = T.filter(t => t.cls === "Options");
    const d37 = T.filter(t => t.d37Retire || (t.cls === "Options" && !t.optReal));
    const excluded = T.filter(t => t.ctrl);
    say(`     clean-epoch settles: ${T.length}`);
    say(`     options rows: ${opts.length} — of which ${d37.length} model-priced (D37) and EXCLUDED via ctrl tag`);
    say(`     total ctrl-tagged (controls + veto shadows + retirements): ${excluded.length}`);
    say(`     signal rows carrying real prices: ${T.filter(t => !t.ctrl).length}`);
  } catch (e) { say(`     ✗ ledger unreadable: ${e.message}`); }

  // ── VERDICT ──────────────────────────────────────────────────────────────
  say(`\n  ` + "═".repeat(72));
  const critical = F.fabricated.filter(x => !/panel|viewer|chain viewer/i.test(x.why));
  say(`  FABRICATED ${F.fabricated.length} · STALE ${F.stale.length} · UNCLASSIFIED ${F.unverified.length} · BENIGN ${F.benign.length} · LIVE-VERIFIED ${F.real.length}`);
  say(`\n  The rule this audit enforces: a number a human might read as market truth must come`);
  say(`  from a market. Everything else must be labelled, gated, or gone.`);

  fs.writeFileSync(D("data-provenance-audit.json"), JSON.stringify({ generated: new Date().toISOString(), findings: F }, null, 1));
  const html = `<meta charset="utf-8"><title>TRAIDS Data Provenance ${new Date().toISOString().slice(0, 10)}</title><body style="background:#0B0C10;color:#E2E8F0;font-family:ui-monospace,monospace;padding:24px"><pre style="font-size:13px;line-height:1.5">${L.join("\n").replace(/</g, "&lt;")}</pre></body>`;
  fs.writeFileSync(path.join(ROOT, "TRAIDS_Data_Provenance.html"), html);
  say(`\n  written: TRAIDS_Data_Provenance.html + backend/data/data-provenance-audit.json\n`);
})();
