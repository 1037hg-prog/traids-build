#!/usr/bin/env node
/**
 * TRAIDS — Intraday Lab: Opening-Range Breakout (ORB) validation
 *
 * The one genuinely INTRADAY candidate. Fetches 5-min IEX bars straight from Alpaca
 * (the /api/equities/intraday endpoint caps at 10 days; this isn't an Alpaca limit,
 * so we go direct for a longer window), groups them into ET regular-hours sessions,
 * and tests: take the high/low of the first `orMin` minutes; go long on a break above
 * the range, short on a break below; stop at the opposite end; exit on stop or at the
 * close. Judged the honest way — TRAIN/TEST split by session date, net of costs, and
 * compared to the intraday buy-&-hold benchmark (long the open → sell the close).
 *
 * HONEST LIMITS (read these):
 *  • Free IEX is a THIN feed (one venue, ~2-3% of consolidated volume). Breakouts and
 *    fills look different on SIP/consolidated data. Treat results as indicative only.
 *  • The sample is modest (a few dozen sessions × a dozen names). Wide error bars.
 *  • Fills are assumed at the breakout level; real slippage on a thin feed is worse.
 *  • This is VALIDATION ONLY — it does not touch the live board or the running test.
 *
 * Usage:  node backend/intraday-lab.js            (needs ALPACA keys in backend/.env)
 *         DAYS=75 ORMIN=30 node backend/intraday-lab.js
 */
const fs = require("fs");
const path = require("path");

// ── load ALPACA keys from backend/.env (dotenv isn't installed) ───────────────
function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}
loadEnv();

const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY;
const FEED = process.env.ALPACA_FEED || "iex";
const DAYS = parseInt(process.env.DAYS || "75");
const ORMIN_ENV = process.env.ORMIN ? [parseInt(process.env.ORMIN)] : null;
const COST_BPS = parseFloat(process.env.COST_BPS || "10");   // round-trip, basis points
const TRAIN_FRAC = 0.6;
const SYMBOLS = ["AAPL","MSFT","NVDA","AMZN","META","TSLA","AMD","GOOGL","JPM","NFLX","AVGO","COST"];

if (!KEY || !SEC || /your_|xxx|changeme/i.test(KEY)) {
  console.error("\n  No real ALPACA keys in backend/.env — can't fetch intraday bars.\n");
  process.exit(1);
}
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };

// ── ET wall-clock parts for a timestamp (DST-safe via Intl) ───────────────────
const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
function etParts(iso) {
  const p = {}; for (const o of etFmt.formatToParts(new Date(iso))) if (o.type !== "literal") p[o.type] = o.value;
  let hh = parseInt(p.hour); if (hh === 24) hh = 0;
  return { day: `${p.year}-${p.month}-${p.day}`, minOfDay: hh * 60 + parseInt(p.minute) };
}
const OPEN_MIN = 9 * 60 + 30, CLOSE_MIN = 16 * 60;   // 9:30 → 16:00 ET

async function fetchIntraday(sym) {
  const start = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const out = []; let pageToken = null;
  do {
    const params = new URLSearchParams({ symbols: sym, timeframe: "5Min", start, limit: "10000", feed: FEED, adjustment: "raw" });
    if (pageToken) params.set("page_token", pageToken);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${params}`, { headers });
    if (!r.ok) { console.warn(`  [${sym}] ${r.status}`); break; }
    const j = await r.json();
    for (const b of (j.bars?.[sym] || [])) out.push(b);
    pageToken = j.next_page_token || null;
  } while (pageToken);
  return out;
}

// group bars into regular-hours sessions: { day: [{minOfDay,o,h,l,c,v}] }
function sessionize(bars) {
  const byDay = {};
  for (const b of bars) {
    const { day, minOfDay } = etParts(b.t);
    if (minOfDay < OPEN_MIN || minOfDay >= CLOSE_MIN) continue;   // regular hours only
    (byDay[day] ||= []).push({ minOfDay, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  for (const d of Object.keys(byDay)) byDay[d].sort((a, b) => a.minOfDay - b.minOfDay);
  return byDay;
}

// one ORB trade for a session → { ret, benchRet } in fraction (net of cost), or null
function orbTrade(sess, orMin) {
  if (sess.length < 4) return null;
  const orEnd = OPEN_MIN + orMin;
  const orBars = sess.filter(b => b.minOfDay < orEnd);
  const rest   = sess.filter(b => b.minOfDay >= orEnd);
  if (orBars.length < 1 || rest.length < 2) return null;
  const orHi = Math.max(...orBars.map(b => b.h)), orLo = Math.min(...orBars.map(b => b.l));
  if (!(orHi > orLo)) return null;
  const sessClose = sess[sess.length - 1].c;
  const cost = COST_BPS / 10000;
  // intraday buy&hold benchmark: enter at first post-OR open, exit at close
  const benchEntry = rest[0].o;
  const benchRet = (sessClose - benchEntry) / benchEntry - cost;
  // find first breakout
  let dir = 0, entry = 0, stop = 0;
  for (const b of rest) {
    if (b.h >= orHi) { dir = 1; entry = orHi; stop = orLo; break; }
    if (b.l <= orLo) { dir = -1; entry = orLo; stop = orHi; break; }
  }
  if (!dir) return { ret: 0 - 0, benchRet, traded: false };   // no breakout → flat (no cost)
  // walk forward from the breakout: stop-out or hold to close
  const startIdx = rest.findIndex(b => dir > 0 ? b.h >= orHi : b.l <= orLo);
  let exit = sessClose;
  for (let i = startIdx + 1; i < rest.length; i++) {
    const b = rest[i];
    if (dir > 0 && b.l <= stop) { exit = stop; break; }
    if (dir < 0 && b.h >= stop) { exit = stop; break; }
  }
  const gross = dir * (exit - entry) / entry;
  return { ret: gross - cost, benchRet, traded: true };
}

function stats(rets) {
  const n = rets.length || 1;
  const mean = rets.reduce((s, r) => s + r, 0) / n;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / n) || 1e-9;
  let eq = 1; for (const r of rets) eq *= 1 + r;
  return { mean, sharpe: (mean / sd) * Math.sqrt(252), total: eq - 1, n };
}

(async () => {
  console.log(`\n  TRAIDS — Intraday Lab: Opening-Range Breakout  (validation only, does NOT touch the live test)`);
  console.log(`  ${SYMBOLS.length} names · last ${DAYS}d · 5-min ${FEED.toUpperCase()} bars · ${COST_BPS}bps round-trip · ${(TRAIN_FRAC*100)|0}/${100-((TRAIN_FRAC*100)|0)} train/test\n`);

  // collect all sessions across symbols, tagged by date for the time split
  const allDays = new Set();
  const symSessions = {};
  for (const s of SYMBOLS) {
    const bars = await fetchIntraday(s);
    const sess = sessionize(bars);
    symSessions[s] = sess;
    Object.keys(sess).forEach(d => allDays.add(d));
  }
  const days = [...allDays].sort();
  if (days.length < 12) { console.error(`  Only ${days.length} sessions returned — IEX history too short to judge. Try fewer symbols or DAYS.\n`); process.exit(1); }
  const splitDay = days[Math.floor(days.length * TRAIN_FRAC)];
  console.log(`  ${days.length} sessions ${days[0]} → ${days[days.length-1]}  (test from ${splitDay})\n`);

  const grid = ORMIN_ENV || [15, 30];
  const rows = [];
  for (const orMin of grid) {
    const tr = [], te = [], teBench = []; let trades = 0, trTotal = 0;
    for (const s of SYMBOLS) {
      for (const [day, sess] of Object.entries(symSessions[s])) {
        const t = orbTrade(sess, orMin); if (!t) continue;
        const isTest = day >= splitDay;
        if (isTest) { te.push(t.ret); teBench.push(t.benchRet); if (t.traded) trades++; }
        else { tr.push(t.ret); if (t.traded) trTotal++; }
      }
    }
    const trS = stats(tr), teS = stats(te), benchS = stats(teBench);
    const wins = te.filter(r => r > 0).length, losses = te.filter(r => r < 0).length;
    const winRate = (wins + losses) ? wins / (wins + losses) : 0;
    rows.push({ orMin, trSharpe: trS.sharpe, teSharpe: teS.sharpe, teMean: teS.mean, teTotal: teS.total,
      benchMean: benchS.mean, benchTotal: benchS.total, winRate, trades,
      survives: teS.sharpe > 0.5 && teS.mean > 0 && teS.mean > benchS.mean });
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log("  " + pad("OR window", 12) + pad("Train Sh", 10) + pad("OOS Sh", 9) + pad("OOS avg/trade", 15) + pad("OOS total", 11) + pad("vs intraday B&H", 17) + pad("Win%", 8) + "Survives?");
  console.log("  " + "─".repeat(104));
  for (const r of rows)
    console.log("  " + pad(r.orMin + " min", 12) + pad(r.trSharpe.toFixed(2), 10) + pad(r.teSharpe.toFixed(2), 9) +
      pad((r.teMean*100).toFixed(3)+"%", 15) + pad((r.teTotal*100).toFixed(1)+"%", 11) +
      pad((r.benchMean*100).toFixed(3)+"% B&H", 17) + pad((r.winRate*100).toFixed(0)+"%", 8) + (r.survives ? "✅ YES" : "❌ no"));
  const surv = rows.filter(r => r.survives).length;
  console.log(`\n  ${surv} of ${rows.length} ORB variants beat intraday buy-&-hold out-of-sample, net of costs.`);
  if (!surv) console.log("  → Honest outcome on a thin IEX sample: no intraday edge here. A real SIP feed could differ — but don't assume it.");
  else console.log("  → Indicative only (thin IEX, small sample). Re-validate on consolidated SIP data before trusting it.");
  console.log("");
})().catch(e => { console.error("\n  Intraday Lab error:", e.message, "\n"); process.exit(1); });
