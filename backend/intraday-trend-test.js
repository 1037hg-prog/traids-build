#!/usr/bin/env node
/**
 * TEST #56 — INTRADAY DAY-TREND ALIGNMENT WITH FAST CUTS AND RE-ENTRY
 *
 * PRE-REGISTERED 2026-07-28, before any result was computed.
 *
 * THE OPERATOR'S SPECIFICATION, in their words: "the system should be designed to stop the
 * bleed and follow the trend for the day; all the signals should point to this; it doesn't have
 * to trade one set of positions all day to the end of trading."
 *
 * WHY THIS IS NOT WHAT THE BOARD DOES. On 2026-07-28 the board held 18 longs and 22 shorts
 * SIMULTANEOUSLY. That is not a trend position — the two sides net out, and a book holding both
 * directions cannot capture a day's direction by construction. It also picks its setups once at
 * the open from DAILY bars and holds to the bell, so it has no mechanism for noticing that the
 * day turned, and no mechanism for re-entering after being stopped.
 *
 * This tests the opposite design:
 *   1. Establish the day's trend from INTRADAY data, after the open.
 *   2. Trade ONLY that direction. One side, every position.
 *   3. Cut fast — the 0.5R cap the operator specified on 2026-07-28.
 *   4. RE-ENTER when stopped, as long as the day's trend still holds.
 *   5. Flat before the close.
 *
 * ── THE PRIOR, STATED HONESTLY BEFORE RUNNING ──────────────────────────────────────────────
 * This is an intraday price pattern, and this project's record on those is 0-for-35. Three
 * neighbours are already dead: #1 trend-following (OOS Sharpe -0.12), #8 opening-range breakout
 * (0/2 beat intraday buy-and-hold), and #11 an exhaustive intraday entry x exit timing grid where
 * EVERY cell was net-negative and the significant ones were significantly negative.
 *
 * #11 is the one that matters most, because it searched this space and found it empty. What it
 * did NOT test is the specific combination here: cross-sectional alignment to a single day
 * direction, a hard 0.5R cut, and re-entry. That is the only reason this is worth a test rather
 * than a citation.
 *
 * SPECIFICATION — declared now, ONE configuration, no search
 *   · Day trend: SPY return from the 09:30 open measured at 10:00 ET. |move| >= 0.15% sets the
 *     direction; below that the day is NO-TRADE. Measured at 10:00 and FIXED for the session —
 *     re-deciding the trend intraday is a free parameter and #11 is what that produces.
 *   · Universe: the most liquid names, equities only.
 *   · Entry: at each 5-minute bar from 10:00, hold the N names whose own from-open move is most
 *     aligned with the day trend and that are not already stopped out for the day.
 *   · R unit: 1.5 x the 20-bar realised range, floored at 0.20% of price.
 *   · Exit: hard cut at 0.5R adverse (the operator's rule), else flat at 15:55.
 *   · Re-entry: up to 3 times per name per day, only while the day trend is unchanged.
 *   · Cost: 5bp round trip per entry, charged on every entry INCLUDING re-entries — re-entry is
 *     the expensive part of this design and pretending otherwise would flatter it.
 *
 * DECISION RULE — fixed now
 *   PASS  if mean daily P&L > 0 with a session-clustered t >= 2.0 across the out-of-sample half,
 *         AND the equity curve's max drawdown is <= 20%.
 *   FAIL  if the OOS mean is <= 0.
 *   Otherwise NOT-ESTABLISHED.
 *
 * EXPECTED OUTCOME, ON THE RECORD: negative after cost. The re-entry rule multiplies the number
 * of paid entries, and #11 already found every intraday timing cell negative before re-entry was
 * even involved. I expect the trend-alignment to show a small positive GROSS and the cost of
 * repeated entry to consume it. If it survives, it is the first intraday pattern to do so here.
 *
 * Usage: node backend/intraday-trend-test.js
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
const FEED = "sip";
const TREND_BAR = "10:00", FLAT_BAR = "15:55", TREND_MIN = 0.0015;
const R_MULT = 1.5, R_FLOOR = 0.002, CAP_R = 0.5, MAX_ENTRIES = 3, HOLD_N = 8;
const COST = 0.0005;
const RISK = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "risk-policy.json"), "utf8"));
const DD_CEILING = RISK.current.hardCeiling;
const UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","NFLX","AVGO","JPM","BAC","XOM","CVX","UNH","LLY","JNJ","WMT","HD","COST","CRM","ORCL","INTC","QCOM","MU","GS","MS","CAT","BA","DIS"];

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const usd = (v) => (v < 0 ? "-" : "") + "$" + Math.abs(Math.round(v)).toLocaleString();
const et = (iso) => new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
const etDay = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

async function bars(sym) {
  const start = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const out = []; let tok = null, pages = 0;
  do {
    const p = new URLSearchParams({ symbols: sym, timeframe: "5Min", start, limit: "10000", feed: FEED });
    if (tok) p.set("page_token", tok);
    let r; try { r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${p}`, { headers: H, signal: AbortSignal.timeout(90000) }); } catch { break; }
    if (!r.ok) break;
    const j = await r.json();
    for (const b of (j.bars?.[sym] || [])) out.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
    tok = j.next_page_token || null; pages++;
  } while (tok && pages < 30);
  return out;
}

(async () => {
  console.log(`\n  TEST #56 — INTRADAY DAY-TREND ALIGNMENT, FAST CUTS, RE-ENTRY`);
  console.log(`  pre-registered 2026-07-28 · ONE declared configuration, no search`);
  console.log(`  trend fixed at ${TREND_BAR} ET · cut at ${CAP_R}R · up to ${MAX_ENTRIES} entries/name/day · flat ${FLAT_BAR}\n`);

  process.stdout.write("  fetching SPY");
  const spy = await bars("SPY");
  const byDaySpy = {};
  for (const b of spy) (byDaySpy[etDay(b.t)] ||= []).push(b);
  console.log(` ${spy.length.toLocaleString()} bars · ${Object.keys(byDaySpy).length} sessions`);

  const px = {};
  process.stdout.write("  fetching universe");
  for (const s of UNIVERSE) { px[s] = await bars(s); process.stdout.write("."); }
  console.log("");

  const byDay = {};
  for (const s of UNIVERSE) { byDay[s] = {}; for (const b of px[s]) (byDay[s][etDay(b.t)] ||= []).push(b); }

  const sessions = Object.keys(byDaySpy).filter(d => byDaySpy[d].length > 50).sort();
  const results = [];
  let noTrade = 0;

  for (const d of sessions) {
    const sb = byDaySpy[d];
    const open = sb[0]?.o;
    const trendBar = sb.find(b => et(b.t) >= TREND_BAR);
    if (!(open > 0) || !trendBar) continue;
    const move = trendBar.c / open - 1;
    if (Math.abs(move) < TREND_MIN) { noTrade++; results.push({ d, dir: 0, pnl: 0, trades: 0 }); continue; }
    const dir = Math.sign(move);

    // rank names by their OWN from-open move, aligned with the day
    const cands = [];
    for (const s of UNIVERSE) {
      const b = byDay[s][d]; if (!b || b.length < 30) continue;
      const o = b[0].o, tb = b.find(x => et(x.t) >= TREND_BAR);
      if (!(o > 0) || !tb) continue;
      cands.push({ s, align: (tb.c / o - 1) * dir, bars: b });
    }
    cands.sort((a, b) => b.align - a.align);
    const picks = cands.slice(0, HOLD_N).filter(c => c.align > 0);

    let dayPnl = 0, nTrades = 0;
    for (const c of picks) {
      const b = c.bars;
      const i0 = b.findIndex(x => et(x.t) >= TREND_BAR);
      const iEnd = b.findIndex(x => et(x.t) >= FLAT_BAR);
      const last = iEnd > 0 ? iEnd : b.length - 1;
      let entries = 0, i = i0;
      while (entries < MAX_ENTRIES && i < last) {
        const entry = b[i].c;
        const win = b.slice(Math.max(0, i - 20), i);
        const rng = win.length ? mean(win.map(x => x.h - x.l)) : entry * R_FLOOR;
        const rUnit = Math.max(rng * R_MULT, entry * R_FLOOR);
        const capPx = entry - dir * rUnit * CAP_R;
        let exit = null, j = i + 1;
        for (; j <= last; j++) {
          const hit = dir > 0 ? b[j].l <= capPx : b[j].h >= capPx;
          if (hit) { exit = (dir > 0 ? Math.min(b[j].o, capPx) : Math.max(b[j].o, capPx)); break; }
        }
        if (exit == null) { exit = b[last].c; j = last; }
        const gross = ((exit - entry) * dir) / entry;
        dayPnl += gross - COST; nTrades++; entries++;
        i = j + 1;
        if (exit === b[last].c) break;              // reached the flat bar
      }
    }
    results.push({ d, dir, pnl: dayPnl / Math.max(1, HOLD_N), trades: nTrades });
  }

  const traded = results.filter(r => r.dir !== 0);
  console.log(`\n  ${results.length} sessions · ${traded.length} traded · ${noTrade} NO-TRADE (|SPY move| < ${(TREND_MIN * 100).toFixed(2)}% at ${TREND_BAR})`);
  console.log(`  ${mean(traded.map(r => r.trades)).toFixed(1)} entries per traded session on average (re-entries included)\n`);

  const half = Math.floor(traded.length / 2);
  const IS = traded.slice(0, half), OOS = traded.slice(half);
  const score = (rows, lbl) => {
    const p = rows.map(r => r.pnl);
    const m = mean(p), s = sd(p);
    let eq = 1, pk = 1, dd = 0;
    for (const x of p) { eq *= 1 + x; pk = Math.max(pk, eq); dd = Math.max(dd, (pk - eq) / pk); }
    const t = (m != null && s) ? m / (s / Math.sqrt(p.length)) : null;
    console.log(`  ${lbl.padEnd(22)} n=${String(p.length).padStart(3)}  mean/session ${((m >= 0 ? "+" : "") + (100 * m).toFixed(4) + "%").padStart(10)}  t ${(t == null ? "—" : t.toFixed(2)).padStart(6)}  maxDD ${("-" + (100 * dd).toFixed(1) + "%").padStart(7)}  total ${((eq - 1) * 100).toFixed(1)}%`);
    return { n: p.length, mean: m, t, maxDD: dd, total: eq - 1 };
  };
  console.log(`  window                 sessions   mean/session      t        maxDD     total`);
  const a = score(IS, "IN-SAMPLE (first half)");
  const b = score(OOS, "OUT-OF-SAMPLE");
  const all = score(traded, "full period");

  const gates = { pos: b.mean > 0, t: b.t != null && b.t >= 2.0, dd: b.maxDD <= DD_CEILING };
  console.log(`\n  ══ ADJUDICATION on the out-of-sample half ══`);
  console.log(`  ${gates.pos ? "✓" : "✗"} mean > 0            ${(100 * b.mean).toFixed(4)}% per session`);
  console.log(`  ${gates.t ? "✓" : "✗"} t ≥ 2.0             ${b.t == null ? "—" : b.t.toFixed(2)}`);
  console.log(`  ${gates.dd ? "✓" : "✗"} maxDD ≤ ${(DD_CEILING * 100).toFixed(0)}%        -${(100 * b.maxDD).toFixed(1)}%`);
  const verdict = !gates.pos ? `FAIL — negative out of sample net of ${(COST * 1e4).toFixed(0)}bp per entry.`
    : Object.values(gates).every(Boolean) ? `PASS — the first intraday pattern to survive in this project. Forward confirmation required before any capital.`
      : `NOT-ESTABLISHED — ${Object.entries(gates).filter(([, v]) => !v).map(([k]) => k).join(", ")} gate(s) failed.`;
  console.log(`\n  VERDICT: ${verdict}\n`);

  // cost sensitivity — re-entry is what makes this expensive
  console.log(`  ══ COST SENSITIVITY — re-entry multiplies the toll ══`);
  const avgEntries = mean(traded.map(r => r.trades)) / HOLD_N;
  for (const c of [0, 0.0002, 0.0005, 0.0010]) {
    const p = traded.map(r => r.pnl + (COST - c) * avgEntries);
    const m = mean(p), s = sd(p);
    console.log(`    ${((c * 1e4).toFixed(0) + "bp").padStart(5)} per entry:  mean/session ${((m >= 0 ? "+" : "") + (100 * m).toFixed(4) + "%").padStart(10)}   t ${(s ? m / (s / Math.sqrt(p.length)) : 0).toFixed(2)}`);
  }

  fs.writeFileSync(path.join(__dirname, "data", "intraday-trend-56.json"), JSON.stringify({
    generated: new Date().toISOString(), test: 56,
    preRegistered: "2026-07-28. One declared configuration, no parameter search — #11 is what searching this space produces.",
    spec: { trendBar: TREND_BAR, trendMin: TREND_MIN, capR: CAP_R, maxEntries: MAX_ENTRIES, holdN: HOLD_N, flatBar: FLAT_BAR, cost: COST },
    sessions: results.length, traded: traded.length, noTrade,
    inSample: a, outOfSample: b, full: all, gates, verdict,
    caveats: [
      "5-minute bars: intrabar path is unknown, so a cap and a target touched in the same bar cannot be ordered. The cap is assumed to fill first, which is the conservative direction.",
      "Fills are modelled at the cap level or the bar open on a gap; no slippage beyond the stated cost.",
      "13 months only — one regime. An intraday trend rule is exactly the kind of thing that works in one regime and not the next.",
      "Equities only, 30 large caps. Capacity and behaviour differ elsewhere.",
    ],
  }, null, 1));
  console.log(`\n  written: backend/data/intraday-trend-56.json\n`);
})();
