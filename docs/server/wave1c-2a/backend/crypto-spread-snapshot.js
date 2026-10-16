#!/usr/bin/env node
/**
 * CRYPTO SPREAD SNAPSHOT — the instrument that was never switched on.
 *
 * FOUND 2026-09-03. trade-autopsy's own spreadSource tally shows 0 of 297 settled Crypto tickets
 * ever carried a "stamped" (real, measured) spread — every single one falls back to the flat
 * DECLARED constant in cost-model.json (perClass.Crypto: roundTripPct 0.2%, source "DECLARED —
 * Coinbase majors; stamp the quote spread at track to measure"). Equity, FX and Futures also lean
 * on modeled/declared spread for most of their book, but Crypto is 100% modeled, ALWAYS has been,
 * and is the class the pooling audit hits hardest for CONCENTRATION (15 of 288 tickets carrying
 * 274% of the class's net P&L, 2026-08-26 and again 2026-09-03).
 *
 * The gap is not that crypto spread is unmeasurable. Alpaca serves a live quotes endpoint
 * (v1beta3/crypto/us/latest/quotes) that this codebase has NEVER called — crypto-bars.js only
 * ever requests the /bars OHLCV endpoint. Confirmed live 2026-09-03 22:09 UTC on 5 symbols
 * (motivating check only, weight zero, NOT evidence):
 *   BTC/USD   1.96 bps RT   (10x BELOW the declared 20bps constant)
 *   ETH/USD   2.99 bps RT   (7x below)
 *   DOGE/USD 33.10 bps RT   (1.7x ABOVE)
 *   SHIB/USD 36.87 bps RT   (1.8x ABOVE)
 *   PEPE/USD 53.55 bps RT   (2.7x ABOVE)
 * The flat constant overcharges the deep majors and undercharges the thin alt/meme names — the
 * exact sub-bucket the pooling audit already flags for carrying most of the class's swings. If
 * that pattern holds, the class's true cost is currently mis-booked in the direction that hides
 * risk on the tickets that matter most, not a random noise term.
 *
 * WHAT THIS SCRIPT DOES AND DOES NOT DO.
 *   DOES:    poll Alpaca's real crypto quotes for the traded universe (read dynamically from the
 *            settled ledger via reconcile.js, so new symbols are picked up automatically),
 *            compute round-trip bps per symbol, append ONE timestamped row per symbol per run to
 *            data/crypto-spread-log.jsonl. Purely additive. Touches no other file.
 *   DOES NOT: write to trade_log.json, touch src/App.jsx, gate or refuse anything, or change any
 *            registered test. It is a measurement instrument, not a policy. A reader (modeled on
 *            r49-spread-gate.js) is proposed separately, once this log has coverage, to twin R49
 *            onto Crypto using REAL spread instead of the class-model constant.
 *
 * WHY A SNAPSHOT LOG AND NOT A LIVE STAMP AT ORDER TIME: entry-time NBBO stamping for Equity
 * happens client-side in src/App.jsx, which this agent may not modify. This script is the
 * backend-only alternative: it cannot stamp a ticket's own obs field, but a reader can look up
 * the nearest-preceding snapshot to a ticket's openedAt (lookback bounded, ticket excluded from
 * the gated arm otherwise — exactly how R49 already treats a missing stamp) and use that as the
 * measured spread. This needs a RECURRING invocation (crypto trades 24/7) to build coverage; it
 * does nothing run once. Operator action needed: add one line to the existing cron rotation
 * (automation/ already runs several timed jobs) at a 5-15 minute cadence.
 *
 * Output: data/crypto-spread-log.jsonl (append-only, one line per {symbol, run})
 *
 * COVERAGE FIX, 2026-10-05 (health sweep FR-6: "18 of 54 symbols every run"). Not chunking, not a
 * symbol-format mismatch, not a rate limit: the 36 missing names are coins ALPACA DOES NOT LIST. Its
 * crypto asset list (GET /v2/assets?asset_class=crypto, checked 2026-10-05) has none of them; the
 * quotes endpoint returns nothing for 32 and a year-plus-dead book for 4 (ALGO 1.0/1.0 from 2025-05,
 * MKR/NEAR/TRX 0/0 from 2025-2023). They trade on the ledger because the board prices crypto off
 * Yahoo with Coinbase as the settle fallback (traids-server-v2.js /api/crypto/bars), not off Alpaca.
 * So every symbol is now ATTEMPTED: Alpaca first, exactly as before, for every name Alpaca runs a
 * live book for; a name Alpaca returns no quote for, or only a book older than a day, is measured on
 * the Coinbase Exchange public level-1 book (keyless, the venue the board already settles against).
 * Every row now carries `venue` ("alpaca" | "coinbase"; rows before 2026-10-05 carry none and are all
 * Alpaca) — a Coinbase book is a different venue's spread, and a reader must be able to keep them
 * apart. A symbol with no quote anywhere is dropped with a per-symbol reason naming both venues.
 * The fail-closed gates are unchanged and apply to both venues: no zero/one-sided book, nothing older
 * than MAX_QUOTE_AGE_S, nothing crossed or zero-width, and on Coinbase nothing in auction mode.
 * `--dry` fetches and prints everything but appends nothing.
 *
 * W1c SERVER MIGRATION, 2026-10 (docs/server/wave1c-2a). `--symbols-file` (the VPS unit traids-spread, every 15 min, 24/7) takes the
 * universe from data/crypto-symbols.json instead of the ledger: home builds it nightly (deploy/server/w1c-symbols.cjs: this file's
 * cryptoUniverse() over data/trade_log.json, the same names home measures) and every pull pushes it read-only. Missing, torn or empty
 * -> exit 1 (the unit pages); never a default list. Without the flag nothing changes (home).
 */
try { require("dotenv").config({ path: require("path").join(__dirname, ".env") }); } catch {}   // optional since 2026-10 (W1c): on the VPS the keys come from the unit's EnvironmentFile
const fs = require("fs"), path = require("path");
// (2026-10, W1c) lib/reconcile.js is not loaded here any more: this script never used it, and the VPS has no ledger (--symbols-file)

const D = (f) => path.join(__dirname, "data", f);
const OUT = D("crypto-spread-log.jsonl");
/** a quote older than this is a dead book, not a measurement — drop it rather than log a placeholder. */
const MAX_QUOTE_AGE_S = 300;
/** an Alpaca book this old is not a momentarily stale quote, it is a book Alpaca no longer runs (delisted / never listed) — route to Coinbase. */
const ALPACA_DEAD_AFTER_S = 86400;
/** Coinbase Exchange public REST allows ~10 req/s; stay well under it, and bound the whole fallback. */
const CB_SPACING_MS = 150, CB_TIMEOUT_MS = 8000, CB_BUDGET_MS = 90000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HDRS = () => {
  const id = process.env.ALPACA_KEY_ID, secret = process.env.ALPACA_SECRET_KEY;
  if (!id || !secret) throw new Error("ALPACA_KEY_ID / ALPACA_SECRET_KEY not set in backend/.env");
  return { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": secret, Accept: "application/json" };
};

/** the traded crypto universe, read dynamically off the ledger so new symbols are picked up. */
function cryptoUniverse() {
  const log = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8"));
  const syms = new Set();
  for (const t of log) if (t && t.cls === "Crypto" && t.sym) syms.add(t.sym);
  return [...syms].sort();
}

/**
 * W1c (2026-10): the universe as home last built it — data/crypto-symbols.json (schema crypto-symbols-v1), pushed read-only to the VPS
 * by every pull. Missing, torn, empty, or a symbol that is not XXX/USD -> throws (exit 1, the unit pages); never a guessed list.
 */
function symbolsFromFile(file = D("crypto-symbols.json")) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`--symbols-file: ${path.basename(file)} unreadable (${e.code || "does not parse"})`); }
  const s = j && j.schema === "crypto-symbols-v1" && Array.isArray(j.symbols) ? j.symbols : null;
  if (!s || !s.length || s.some((x) => typeof x !== "string" || !/^[A-Z0-9]{1,15}\/USD$/.test(x))) throw new Error(`--symbols-file: ${path.basename(file)} is not a non-empty crypto-symbols-v1 list of XXX/USD symbols`);
  return { symbols: [...new Set(s)].sort(), builtAt: j.builtAt || null };
}

async function fetchLatestQuotes(symbols) {
  const out = {};
  const CH = 100; // Alpaca crypto quotes endpoint accepts a large symbol batch; chunk defensively
  for (let i = 0; i < symbols.length; i += CH) {
    const chunk = symbols.slice(i, i + CH);
    const p = new URLSearchParams({ symbols: chunk.join(",") });
    const r = await fetch(`https://data.alpaca.markets/v1beta3/crypto/us/latest/quotes?${p}`, { headers: HDRS() });
    if (!r.ok) throw new Error(`crypto latest quotes ${r.status} for ${chunk.length} symbol(s)`);
    const j = await r.json();
    Object.assign(out, j.quotes || {});
  }
  return out;
}

/**
 * Coinbase Exchange public level-1 book for one ledger symbol ("ATOM/USD" -> ATOM-USD). Keyless GET.
 * Returns { quote } or { reason } — never throws, so one bad product cannot sink the run.
 * The book's own `time` is the snapshot time; it is what the age gate is applied to.
 */
async function fetchCoinbaseL1(sym) {
  const product = String(sym).toUpperCase().replace("/", "-");
  if (!/^[A-Z0-9]{2,10}-USD$/.test(product)) return { reason: `coinbase: ${product} is not a -USD product id` };
  for (let attempt = 0; attempt < 2; attempt++) {
    let r;
    try {
      r = await fetch(`https://api.exchange.coinbase.com/products/${product}/book?level=1`,
        { headers: { Accept: "application/json", "User-Agent": "traids-crypto-spread-snapshot" }, signal: AbortSignal.timeout(CB_TIMEOUT_MS) });
    } catch (e) { return { reason: `coinbase: request failed (${e && e.name === "TimeoutError" ? "timeout " + CB_TIMEOUT_MS / 1000 + "s" : (e && e.message || e)})` }; }
    if (r.status === 429 && attempt === 0) { await sleep(1000); continue; }
    if (r.status === 404) return { reason: `coinbase: no ${product} product (404)` };
    if (!r.ok) return { reason: `coinbase: HTTP ${r.status} for ${product}` };
    const j = await r.json().catch(() => null);
    const receivedAt = Date.now();
    const bid = j && Array.isArray(j.bids) && j.bids[0], ask = j && Array.isArray(j.asks) && j.asks[0];
    if (!bid || !ask) return { reason: `coinbase: ${product} book has no bid/ask` };
    return { quote: { product, bp: +bid[0], bs: +bid[1], ap: +ask[0], as: +ask[1], t: j.time || null, auction: !!j.auction_mode, receivedAt } };
  }
  return { reason: `coinbase: ${product} rate-limited (429 twice)` };
}

/** Alpaca first (one batched call, unchanged); Coinbase for every name Alpaca runs no live book for. */
async function collect(syms) {
  const quotes = await fetchLatestQuotes(syms);
  const now = new Date().toISOString();
  const rows = [], dropped = [], toCoinbase = [];
  for (const sym of syms) {
    const q = quotes[sym];
    const qAgeS = q && q.t ? (Date.parse(now) - Date.parse(q.t)) / 1000 : null;
    if (!q) { toCoinbase.push([sym, "alpaca: no quote returned"]); continue; }
    if (Number.isFinite(qAgeS) && qAgeS > ALPACA_DEAD_AFTER_S) { toCoinbase.push([sym, `alpaca: dead book (last quote ${Math.round(qAgeS / 86400)}d old)`]); continue; }
    if (!(q.ap > 0) || !(q.bp > 0)) { dropped.push([sym, 'no bid/ask']); continue; }
    // FAIL CLOSED (added 2026-09-04). A quote that is stale, crossed or zero-width is not a
    // measurement — it is a placeholder, and logging it here would understate cost on exactly the
    // thin/dead names where cost is highest, reproducing the bias this instrument exists to fix.
    // Found live: ALGO/USD quoted ap=bp=1.0 from a book 477 DAYS stale, logged as 0.00bps — the
    // tightest 'spread' in the whole log. Every genuine quote observed is under 90s old (median 5s).
    const ageS = q.t ? (Date.parse(now) - Date.parse(q.t)) / 1000 : Infinity;
    if (!Number.isFinite(ageS) || ageS > MAX_QUOTE_AGE_S) { dropped.push([sym, Number.isFinite(ageS) ? "stale " + Math.round(ageS) + "s" : "no quote timestamp"]); continue; }
    const mid = (q.ap + q.bp) / 2;
    const rtBps = mid > 0 ? 10000 * (q.ap - q.bp) / mid : null;
    if (!Number.isFinite(rtBps)) { dropped.push([sym, 'non-finite bps']); continue; }
    if (rtBps <= 0) { dropped.push([sym, "degenerate " + rtBps.toFixed(2) + "bps (crossed or zero-width)"]); continue; }
    rows.push({ sym, venue: "alpaca", runAt: now, quoteAt: q.t || null, quoteAgeS: +ageS.toFixed(1), ap: q.ap, bp: q.bp, as: q.as, bs: q.bs, mid: +mid.toFixed(8), rtBps: +rtBps.toFixed(2) });
  }

  // ── Coinbase fallback: same fail-closed gates, its own snapshot clock ──
  const cbStart = Date.now();
  for (const [sym, why] of toCoinbase) {
    if (Date.now() - cbStart > CB_BUDGET_MS) { dropped.push([sym, `${why}; coinbase: not attempted — ${CB_BUDGET_MS / 1000}s fallback budget spent`]); continue; }
    const r = await fetchCoinbaseL1(sym);
    await sleep(CB_SPACING_MS);
    if (!r.quote) { dropped.push([sym, `${why}; ${r.reason}`]); continue; }
    const q = r.quote;
    if (!(q.ap > 0) || !(q.bp > 0)) { dropped.push([sym, `${why}; coinbase: no bid/ask`]); continue; }
    if (q.auction) { dropped.push([sym, `${why}; coinbase: ${q.product} in auction mode (not a continuous book)`]); continue; }
    const ageS = q.t ? (q.receivedAt - Date.parse(q.t)) / 1000 : NaN;
    if (!Number.isFinite(ageS)) { dropped.push([sym, `${why}; coinbase: no quote timestamp`]); continue; }
    if (ageS > MAX_QUOTE_AGE_S) { dropped.push([sym, `${why}; coinbase: stale ${Math.round(ageS)}s`]); continue; }
    if (ageS < -60) { dropped.push([sym, `${why}; coinbase: quote time ${Math.round(-ageS)}s in the future (clock skew)`]); continue; }
    const mid = (q.ap + q.bp) / 2;
    const rtBps = mid > 0 ? 10000 * (q.ap - q.bp) / mid : null;
    if (!Number.isFinite(rtBps)) { dropped.push([sym, `${why}; coinbase: non-finite bps`]); continue; }
    if (rtBps <= 0) { dropped.push([sym, `${why}; coinbase: degenerate ${rtBps.toFixed(2)}bps (crossed or zero-width)`]); continue; }
    rows.push({ sym, venue: "coinbase", product: q.product, runAt: now, quoteAt: q.t, quoteAgeS: +ageS.toFixed(1), ap: q.ap, bp: q.bp, as: q.as, bs: q.bs, mid: +mid.toFixed(8), rtBps: +rtBps.toFixed(2) });
  }
  return { now, rows, dropped, attempted: syms.length, routedToCoinbase: toCoinbase.length };
}

async function main() {
  const dry = process.argv.includes("--dry");
  const list = process.argv.includes("--symbols-file") ? symbolsFromFile() : null;   // W1c (2026-10): the VPS reads home's pushed list
  const syms = list ? list.symbols : cryptoUniverse();
  if (list) console.log(`crypto-spread-snapshot: universe from crypto-symbols.json (${syms.length} symbols, built ${list.builtAt || "?"})`);
  if (!syms.length) { console.log("no Crypto symbols found in the ledger — nothing to poll"); return; }
  const { rows, dropped, routedToCoinbase } = await collect(syms);
  if (!rows.length) { console.log("quotes fetched but none usable (no finite bid/ask) — nothing appended"); return; }
  if (!dry) fs.appendFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const byBps = [...rows].sort((a, b) => b.rtBps - a.rtBps);
  const nA = rows.filter((r) => r.venue === "alpaca").length, nC = rows.length - nA;
  console.log(`crypto-spread-snapshot: ${rows.length}/${syms.length} symbols quoted (alpaca ${nA} · coinbase ${nC}; ${syms.length} attempted, ${routedToCoinbase} routed to coinbase), ${dry ? "DRY RUN — nothing appended" : "appended to " + path.basename(OUT)}`);
  if (dropped.length) console.log(`  no quote for ${dropped.length}: ` + dropped.map((d) => d[0] + " (" + d[1] + ")").join(", "));
  console.log(`  widest: ${byBps.slice(0, 5).map((r) => `${r.sym} ${r.rtBps}bps`).join(", ")}`);
  console.log(`  tightest: ${byBps.slice(-5).map((r) => `${r.sym} ${r.rtBps}bps`).join(", ")}`);
}

if (require.main === module) main().catch((e) => { console.error("crypto-spread-snapshot FAILED:", e.message); process.exit(1); });

module.exports = { cryptoUniverse, symbolsFromFile, fetchLatestQuotes, fetchCoinbaseL1, collect };
