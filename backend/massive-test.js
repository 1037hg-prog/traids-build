#!/usr/bin/env node
/**
 * TRAIDS — Massive.com futures-data connectivity test.
 *
 * Confirms your MASSIVE_API_KEY works against the futures aggregates endpoint and shows the
 * EXACT auth that succeeds, so the full integration is built on a verified request — not a
 * guess. Tries Bearer-header auth first, then ?apiKey= query-param as a fallback.
 *
 * Prereq: add MASSIVE_API_KEY=... to backend/.env  (optional: MASSIVE_API_BASE_URL).
 * Run:    node backend/massive-test.js
 */
const fs = require("fs"), path = require("path");
function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.MASSIVE_API_KEY;
const BASE = (process.env.MASSIVE_API_BASE_URL || "https://api.massive.com").replace(/\/$/, "");
if (!KEY || /your_|_here|xxxx/i.test(KEY)) { console.error("\n  Add a real MASSIVE_API_KEY to backend/.env first, then re-run.\n"); process.exit(1); }

const today = new Date().toISOString().slice(0, 10);
const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
// a few likely-active contracts to try (front-month ES, Dec ES, micro ES, gold)
const TICKERS = ["ESU6", "ESZ6", "MESU6", "GCQ6", "ESH6"];

async function tryFetch(ticker, mode) {
  const qp = `resolution=1session&window_start.gte=${from}&window_start.lte=${today}&limit=10`;
  const url = mode === "query"
    ? `${BASE}/futures/v1/aggs/${ticker}?${qp}&apiKey=${KEY}`
    : `${BASE}/futures/v1/aggs/${ticker}?${qp}`;
  const opts = mode === "bearer" ? { headers: { Authorization: `Bearer ${KEY}` } } : {};
  try {
    const r = await fetch(url, opts);
    const body = await r.text();
    let j = null; try { j = JSON.parse(body); } catch {}
    return { status: r.status, ok: r.ok, results: j?.results || null, raw: body.slice(0, 240) };
  } catch (e) { return { status: 0, ok: false, err: e.message }; }
}

(async () => {
  console.log(`\n  Massive.com futures test  ·  base ${BASE}\n`);
  let authMode = null;
  for (const mode of ["bearer", "query"]) {
    const t = await tryFetch(TICKERS[0], mode);
    console.log(`  auth via ${mode.padEnd(7)} → HTTP ${t.status}${t.ok ? " OK" : ""}` + (t.status === 401 || t.status === 403 ? "  (auth rejected)" : ""));
    if (t.ok) { authMode = mode; break; }
    if (t.raw && !t.ok) console.log(`     ${t.raw}`);
  }
  if (!authMode) { console.error(`\n  Neither Bearer nor apiKey worked. Check the key (and that the futures product is enabled on your plan).\n`); process.exit(1); }
  console.log(`\n  ✓ Working auth: ${authMode === "bearer" ? "Authorization: Bearer <key>" : "?apiKey=<key>"}\n`);

  // pull a few daily session bars from whichever test ticker returns data
  for (const tk of TICKERS) {
    const t = await tryFetch(tk, authMode);
    if (t.ok && t.results && t.results.length) {
      console.log(`  ${tk}: ${t.results.length} session bars (most recent):`);
      for (const b of t.results.slice(-3)) {
        const d = b.session_end_date || (b.window_start ? new Date(b.window_start / 1e6).toISOString().slice(0, 10) : "?");
        console.log(`    ${d}  O ${b.open}  H ${b.high}  L ${b.low}  C ${b.close}  VOL ${b.volume}  settle ${b.settlement_price ?? "-"}`);
      }
      console.log(`\n  ✓ Futures data flowing — WITH volume. This is the gap Yahoo couldn't fill.`);
      console.log(`  Tell me it worked and I'll wire it into the board's futures scan + the trend-following test.\n`);
      return;
    }
  }
  console.log(`  Auth works, but none of the test tickers (${TICKERS.join(", ")}) returned bars.`);
  console.log(`  The contract codes may differ on Massive — tell me and I'll query the snapshot endpoint to list live tickers.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
