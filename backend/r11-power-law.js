#!/usr/bin/env node
/**
 * R11 POWER-LAW RIDER — buys announced turns in crash survivors, exits only on trend break.
 * Registered 2026-07-31 (test-registry R11); rules fixed there, executed mechanically here.
 *
 *   ENTRY (all three): R8-settled earnings gap >= +8% raw · the name traded >=50% below its
 *   3y high within the last 18 months · post-gap close above its 50d MA. $1,000 notional,
 *   max 12 open. EXIT: close below the 200d MA. No targets, no time stops — a target is how
 *   a 12x becomes a +30% trade. Judged on TOTAL return and skew, never hit rate (~25-40%
 *   expected — low hit rate with intact tails is the design working).
 *
 * Paper only. Forward only — the survivorship-poisoned backtest was refused in the registry.
 * Wired into daily-close.bat after the R8 settle.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const STATE = D("r11-power-law.json");
const YAHOO = "http://localhost:3002/api/yahoo";
const GAP_MIN = 8, DD_MIN = 0.50, NOTIONAL = 1000, MAX_OPEN = 12;

async function bars(sym, days) {
  try { const r = await fetch(`${YAHOO}/${encodeURIComponent(sym)}/history?days=${days}&interval=1d`, { signal: AbortSignal.timeout(45000) });
    return ((await r.json()).bars || []).filter(b => b.close > 0); } catch { return []; }
}
const ma = (b, n) => b.length >= n ? b.slice(-n).reduce((s, x) => s + x.close, 0) / n : null;

(async () => {
  console.log(`\n  R11 POWER-LAW RIDER — announced turns in crash survivors (paper, forward-only)\n`);
  let st = { spec: "r11-v1", open: {}, closed: [], scanned: {} };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE, "utf8")) }; } catch { }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  // ── EXITS first (a rule that checks entries before exits eventually holds a broken book) ──
  for (const [sym, p] of Object.entries(st.open)) {
    const b = await bars(sym, 400);
    if (b.length < 210) continue;
    const last = b[b.length - 1], m200 = ma(b, 200);
    if (m200 && last.close < m200) {
      const ret = last.close / p.entry - 1;
      st.closed.push({ sym, entry: p.entry, entryDate: p.entryDate, exit: last.close, exitDate: last.date, retPct: +(100 * ret).toFixed(1), reason: "close below 200d MA" });
      delete st.open[sym];
      console.log(`  EXIT ${sym}: $${p.entry} → $${last.close} (${ret >= 0 ? "+" : ""}${(100 * ret).toFixed(1)}%) — trend break`);
    } else {
      console.log(`  hold ${sym}: $${p.entry} → $${last.close.toFixed(2)} (${((last.close / p.entry - 1) * 100).toFixed(1)}%) · 200d floor $${m200 ? m200.toFixed(2) : "?"}`);
    }
  }

  // ── ENTRIES from the R8 gap feed ─────────────────────────────────────────
  let r8 = null; try { r8 = JSON.parse(fs.readFileSync(D("r8-earnings-shadow.json"), "utf8")); } catch { }
  const gaps = Object.values(r8?.settledGaps || {}).filter(g => !g.missed && g.rawGap >= GAP_MIN);
  for (const g of gaps) {
    const key = `${g.sym}@${g.printDate}`;
    if (st.scanned[key] || st.open[g.sym]) continue;
    st.scanned[key] = true;
    if (Object.keys(st.open).length >= MAX_OPEN) { console.log(`  ${g.sym}: qualified gap but sleeve is full (${MAX_OPEN}) — logged, not entered`); continue; }
    const b = await bars(g.sym, 1150);
    if (b.length < 300) { console.log(`  ${g.sym}: +${g.rawGap}% gap but <300 bars of history — skipped, counted`); continue; }
    const last = b[b.length - 1];
    const hi3y = Math.max(...b.map(x => x.close));
    // crash-survivor check: >=50% below the 3y high at some point in the last ~18 months
    const cut = b.slice(-378);
    const wasCrashed = cut.some(x => x.close <= hi3y * (1 - DD_MIN));
    const m50 = ma(b, 50);
    if (!wasCrashed) { console.log(`  ${g.sym}: +${g.rawGap}% turn but never crashed (${Math.round(100 * (1 - Math.min(...cut.map(x => x.close)) / hi3y))}% max DD) — not the pattern`); continue; }
    if (!(m50 && last.close > m50)) { console.log(`  ${g.sym}: crashed + turned but still below its 50d — announced turns get ONE confirmation`); continue; }
    st.open[g.sym] = { entry: last.close, entryDate: last.date, printDate: g.printDate, gapPct: g.rawGap, shares: +(NOTIONAL / last.close).toFixed(3) };
    console.log(`  ★ ENTER ${g.sym} @ $${last.close.toFixed(2)} — crash survivor (${Math.round(100 * (1 - Math.min(...cut.map(x => x.close)) / hi3y))}% off high) with a +${g.rawGap}% announced turn`);
  }

  // ── SCOREBOARD — total and skew, never hit rate alone ────────────────────
  const rets = st.closed.map(c => c.retPct);
  const openN = Object.keys(st.open).length;
  const tot = rets.reduce((s, v) => s + v, 0);
  console.log(`\n  sleeve: ${openN} open · ${st.closed.length} closed · closed sum ${tot >= 0 ? "+" : ""}${tot.toFixed(1)}% ` +
    (rets.length ? `· best ${Math.max(...rets)}% · worst ${Math.min(...rets)}% · hits ${rets.filter(v => v > 0).length}/${rets.length} (low hit rate + fat best = design working)` : "· awaiting its first announced turn"));
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  console.log(`  written: backend/data/r11-power-law.json`);
})().catch(e => { console.error("  R11 failed:", e.message); process.exit(1); });
