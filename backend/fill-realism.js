#!/usr/bin/env node
/**
 * FILL-REALISM STUDY — kill-test #45 (registered concern: paper-only blindness).
 * 2026-08-03, "fix it all". v2 — first run had two defects, both fixed here:
 *   (1) 150ms call spacing = ~400 req/min, double the Alpaca free limit; ~95% of rows 429'd
 *       into the skip bucket. Now 350ms + one retry after 3s on 429.
 *   (2) IEX top-of-book quotes are NOT the NBBO — median "spread" measured 463bps on liquid
 *       names, pure junk that swamped the real effect. Spread is now a DECLARED ASSUMPTION
 *       reported as a sensitivity grid, never a fake measurement.
 *
 * QUESTION: how much paper P&L survives realistic fills? Paper marks entries at the price the
 * app SAW; a live market order gets the NEXT minute's price. That timing slip is MEASURED here
 * from trade-time 1-min bars — the real, unarguable component. The spread/impact component
 * cannot be measured without SIP data (paid, decision #39), so it is applied as a labeled
 * grid: 0 / 5 / 10 / 20 bps per side.
 *
 * METHOD (stated before running):
 *   sample   settled clean Equity rows (no ctrl/ctrlRand/vetoShadow), newest first, cap 150
 *   entry    realistic = open of first 1-min bar STRICTLY AFTER openedAt's minute
 *   exit     closedAt inside 15:45–16:10 ET → MOC at the paper exit (auction, no slip);
 *            otherwise next-minute open after closedAt
 *   output   timing-slip haircut in R (measured) + total haircut under each spread assumption;
 *            fill-realism.json for the daily report
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const D = (f) => path.join(__dirname, "data", f);
const KEY = process.env.ALPACA_KEY_ID || process.env.APCA_API_KEY_ID;
const SEC = process.env.ALPACA_SECRET_KEY || process.env.APCA_API_SECRET_KEY;
if (!KEY || !SEC) { console.error("no Alpaca creds in backend/.env"); process.exit(1); }
const H = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const FEED = process.env.ALPACA_FEED || "iex";
const CAP = 150, GAP_MS = 350, SPREAD_GRID_BPS = [0, 5, 10, 20];

const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
const etMin = (ms) => { const p = {}; for (const o of etFmt.formatToParts(new Date(ms))) if (o.type !== "literal") p[o.type] = o.value; return (parseInt(p.hour) % 24) * 60 + parseInt(p.minute); };
const sleep = (ms) => new Promise(z => setTimeout(z, ms));

async function minuteBars(sym, fromMs, toMs) {
  const p = new URLSearchParams({ symbols: sym, timeframe: "1Min", start: new Date(fromMs).toISOString(), end: new Date(toMs).toISOString(), limit: "10000", feed: FEED, adjustment: "raw" });
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${p}`, { headers: H, signal: AbortSignal.timeout(25000) });
    if (r.status === 429 && attempt === 0) { await sleep(3000); continue; }
    if (!r.ok) throw new Error(`${sym} bars ${r.status}`);
    return (await r.json()).bars?.[sym] || [];
  }
}
const nextOpen = (bars, ts) => { const floor = Math.floor(ts / 60000) * 60000; const b = bars.find(b => new Date(b.t).getTime() > floor); return b ? { px: b.o, t: b.t } : null; };

(async () => {
  const log = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8"));
  const rows = (Array.isArray(log) ? log : log.trades || log.rows || [])
    .filter(r => r.cls === "Equity" && Number.isFinite(r.rMult) && Number.isFinite(r.entry) && Number.isFinite(r.exit) &&
      Number.isFinite(r.stopDist) && r.stopDist > 0 && !r.ctrl && !r.ctrlRand && !r.vetoShadow &&
      Number.isFinite(r.openedAt) && Number.isFinite(r.closedAt))
    .sort((a, b) => b.openedAt - a.openedAt).slice(0, CAP);
  console.log(`fill-realism v2: ${rows.length} settled clean equity rows (cap ${CAP})`);

  const out = []; const skipReasons = {};
  for (const r of rows) {
    try {
      const eb = await minuteBars(r.sym, r.openedAt - 5 * 60000, r.openedAt + 60 * 60000);
      await sleep(GAP_MS);
      const en = nextOpen(eb, r.openedAt);
      if (!en) { skipReasons["no entry bar"] = (skipReasons["no entry bar"] || 0) + 1; continue; }
      const closeMin = etMin(r.closedAt);
      const closeDow = new Date(r.closedAt).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });
      const offHours = closeMin >= 15 * 60 + 45 || closeMin < 9 * 60 + 30 || closeDow === "Sat" || closeDow === "Sun";
      let realExit, exitMode;
      // Off-hours settles mark at the session close; live, the same rule exits via the closing
      // auction (MOC ≈ official close, no spread) — so paper exit IS the realistic exit there.
      // Weekend/pre-market settles are batch-timing artifacts of when the cycle ran, not of
      // when the rule would have exited. Only true intraday exits face next-minute slip.
      if (offHours) { realExit = r.exit; exitMode = "close-mark"; }
      else {
        const xb = await minuteBars(r.sym, r.closedAt - 5 * 60000, r.closedAt + 60 * 60000);
        await sleep(GAP_MS);
        const xn = nextOpen(xb, r.closedAt);
        if (!xn) { skipReasons["no exit bar"] = (skipReasons["no exit bar"] || 0) + 1; continue; }
        realExit = xn.px; exitMode = "next-min";
      }
      const paperR = (r.exit - r.entry) * r.dir / r.stopDist;
      const timingR = (realExit - en.px) * r.dir / r.stopDist;   // same rule, honest prices, zero spread
      out.push({
        sym: r.sym, dir: r.dir, openedAt: r.openedAt, exitMode,
        paperEntry: r.entry, realEntry: en.px,
        entrySlipBps: +((en.px / r.entry - 1) * r.dir * 1e4).toFixed(1),
        paperR: +paperR.toFixed(4), timingR: +timingR.toFixed(4), dR: +(timingR - paperR).toFixed(4),
        // R cost of spread per bps-per-side, so the grid is pure arithmetic downstream
        spreadRperBps: +(((r.entry / r.stopDist) * 1e-4) * (exitMode === "close-mark" ? 1 : 2)).toFixed(5),
        units: r.units || 0, stopDist: r.stopDist,
      });
    } catch (e) { skipReasons[e.message.replace(/^\S+ /, "")] = (skipReasons[e.message.replace(/^\S+ /, "")] || 0) + 1; }
  }

  const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const dRs = out.map(o => o.dR);
  const grid = {};
  for (const bps of SPREAD_GRID_BPS) {
    const tot = out.map(o => o.dR - bps * o.spreadRperBps);
    grid[`${bps}bps/side`] = { meanHaircutR: +mean(tot).toFixed(4), medianHaircutR: +med(tot).toFixed(4), signFlips: out.filter((o, i) => Math.sign(o.paperR) !== Math.sign(o.paperR + tot[i]) && Math.abs(o.paperR) > 0.02).length };
  }
  const summary = {
    ranAt: new Date().toISOString(), n: out.length, skipped: rows.length - out.length, skipReasons,
    timingOnly: { meanHaircutR: +mean(dRs).toFixed(4), medianHaircutR: +med(dRs).toFixed(4), entrySlipMedianBps: med(out.map(o => o.entrySlipBps)) },
    exitModes: out.reduce((m, o) => (m[o.exitMode] = (m[o.exitMode] || 0) + 1, m), {}),
    spreadSensitivity: grid,
    method: "timing slip MEASURED from trade-time 1-min bars (iex); spread is a DECLARED grid, not measured — real NBBO needs SIP data (decision #39)",
  };
  fs.writeFileSync(D("fill-realism.json"), JSON.stringify({ summary, trades: out }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  console.log("written: fill-realism.json");
})();
