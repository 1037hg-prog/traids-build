#!/usr/bin/env node
/**
 * R16 — VRP SLEEVE. Forward paper monthly index-call overwrite on XSP.
 * Registered 2026-08-03 before the first cycle. Operator: "wire the vrp sleeve".
 *
 * RULE (fixed, no discretion): hold long index exposure of one XSP contract's notional via SPY.
 * On the first trading day after each monthly expiry, sell ONE at-the-money XSP call expiring at
 * the next monthly expiry. Hold to expiry. Settle intrinsic against SPX/10. Re-strike.
 *
 * XSP not SPXW: one SPXW contract is ~$612k notional, 6x a $100k paper account. Sizing that
 * cannot be executed is not a test.
 *
 * EXPECTATION, SO NOBODY READS THIS WRONG: the target is +0.8 to +1.2%/yr over a BETA-MATCHED
 * index position — roughly $50-75 a month on one contract. Against unhedged buy-and-hold it will
 * TRAIL, by about 8pp/yr in a rising market (R15 measured 13.52% vs 21.54%). That is the strategy
 * working, not failing. It is a structural premium, not alpha, and it must never be counted as edge.
 *
 * Idempotent: safe to run every night. Opens a cycle when one is due, settles when expiry passes,
 * marks to market in between. Runs in the nightly close chain.
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch { } })();
const AH = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
const D = (f) => path.join(__dirname, "data", f);
const STATE = D("vrp-sleeve.json");
const MULT = 100, CIRCUIT_BREAKER_PCT = 8;

const thirdFriday = (y, m) => { const d = new Date(Date.UTC(y, m - 1, 1)); let c = 0; while (true) { if (d.getUTCDay() === 5) { c++; if (c === 3) break; } d.setUTCDate(d.getUTCDate() + 1); } return d.toISOString().slice(0, 10); };
const occ = (root, exp, cp, k) => { const [y, m, d] = exp.split("-"); return `${root}${y.slice(2)}${m}${d}${cp}${String(Math.round(k * 1000)).padStart(8, "0")}`; };
const etToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

async function spxSeries() {
  const r = await fetch("http://localhost:3002/api/yahoo/%5EGSPC/history?days=90&interval=1d", { signal: AbortSignal.timeout(30000) });
  const b = ((await r.json()).bars || []).filter(x => Number.isFinite(x.close));
  return new Map(b.map(x => [x.date, x.close]));
}
async function optClose(sym) {
  try {
    const p = new URLSearchParams({ symbols: sym, timeframe: "1Day", start: "2026-01-01", limit: "500" });
    const r = await fetch(`https://data.alpaca.markets/v1beta1/options/bars?${p}`, { headers: AH, signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    const b = ((await r.json()).bars || {})[sym] || [];
    return b.length ? { close: b[b.length - 1].c, asOf: String(b[b.length - 1].t).slice(0, 10) } : null;
  } catch { return null; }
}
// the expiry we should currently be short: the next third Friday strictly after today
function currentCycle(today) {
  const d = new Date(today + "T00:00:00Z");
  for (let i = 0; i < 3; i++) {
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1 + i;
    const exp = thirdFriday(m > 12 ? y + 1 : y, ((m - 1) % 12) + 1);
    if (exp > today) return exp;
  }
  return null;
}

(async () => {
  const st = (() => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return { spec: "R16-v1", open: null, closed: [], suspended: false }; } })();
  if (st.suspended) { console.log(`R16 SUSPENDED — circuit breaker fired on ${st.suspendedOn}. Manual review required; no new cycles.`); process.exit(0); }
  const today = etToday();
  const spx = await spxSeries();
  const level = spx.get(today) ?? [...spx.entries()].sort((a, b) => a[0] < b[0] ? 1 : -1)[0]?.[1];
  if (!level) { console.error("no SPX level — refusing to act"); process.exit(1); }
  const xsp = level / 10;
  console.log(`R16 VRP SLEEVE · ${today} · SPX ${level.toFixed(0)} → XSP ${xsp.toFixed(1)}`);

  // 1 — SETTLE an open cycle whose expiry has passed
  if (st.open && today >= st.open.exp) {
    const settleLvl = spx.get(st.open.exp) ?? level;
    const settleXsp = settleLvl / 10;
    const callPayoff = Math.max(0, settleXsp - st.open.strike) * MULT;
    const indexPnl = (settleXsp - st.open.xspAtEntry) * MULT;
    const pnl = indexPnl + st.open.premium * MULT - callPayoff;
    const notional = st.open.xspAtEntry * MULT;
    const pct = 100 * pnl / notional;
    st.closed.push({ ...st.open, settledOn: st.open.exp, settleXsp: +settleXsp.toFixed(2), callPayoff: +callPayoff.toFixed(2), indexPnl: +indexPnl.toFixed(2), pnl: +pnl.toFixed(2), pctOfNotional: +pct.toFixed(3) });
    console.log(`  SETTLED ${st.open.exp}: index ${indexPnl >= 0 ? "+" : ""}$${indexPnl.toFixed(0)}, premium +$${(st.open.premium * MULT).toFixed(0)}, call -$${callPayoff.toFixed(0)} → ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)} (${pct.toFixed(2)}% of notional)`);
    if (pct <= -CIRCUIT_BREAKER_PCT) {
      st.suspended = true; st.suspendedOn = today;
      st.suspendReason = `cycle loss ${pct.toFixed(2)}% exceeded the registered ${CIRCUIT_BREAKER_PCT}% circuit breaker`;
      console.log(`  !! CIRCUIT BREAKER — ${st.suspendReason}. Sleeve suspended, no new cycles.`);
    }
    st.open = null;
  }

  // 2 — OPEN the cycle we should be short, if flat
  if (!st.open && !st.suspended) {
    const exp = currentCycle(today);
    const strike = Math.round(xsp);                        // XSP lists 1-point strikes near the money
    const sym = occ("XSP", exp, "C", strike);
    const q = await optClose(sym);
    if (!q) console.log(`  no bar for ${sym} — nothing opened; will retry tomorrow (never guess a premium)`);
    else {
      st.open = { openedOn: today, exp, strike, sym, premium: q.close, premiumAsOf: q.asOf, xspAtEntry: +xsp.toFixed(2), notional: +(xsp * MULT).toFixed(0) };
      console.log(`  OPENED short ${sym} @ ${q.close} (as of ${q.asOf}) · strike ${strike} · notional $${(xsp * MULT).toFixed(0)} · premium $${(q.close * MULT).toFixed(0)} = ${(100 * q.close / xsp).toFixed(2)}% of notional`);
    }
  } else if (st.open) {
    const q = await optClose(st.open.sym);
    const mtm = q ? (st.open.premium - q.close) * MULT : null;
    const idxMtm = (xsp - st.open.xspAtEntry) * MULT;
    console.log(`  HOLDING ${st.open.sym} exp ${st.open.exp} · index ${idxMtm >= 0 ? "+" : ""}$${idxMtm.toFixed(0)} · call ${mtm == null ? "unpriced" : (mtm >= 0 ? "+" : "") + "$" + mtm.toFixed(0)} · net ${mtm == null ? "n/a" : ((idxMtm + mtm) >= 0 ? "+" : "") + "$" + (idxMtm + mtm).toFixed(0)}`);
  }

  // 3 — record
  const cl = st.closed;
  if (cl.length) {
    const tot = cl.reduce((s, c) => s + c.pctOfNotional, 0);
    console.log(`\n  ${cl.length} completed cycle(s) · cumulative ${tot >= 0 ? "+" : ""}${tot.toFixed(2)}% of notional · mean ${(tot / cl.length).toFixed(2)}%/cycle`);
    console.log(`  bar: 12 cycles vs a BETA-MATCHED index position (not buy-and-hold). ${12 - cl.length} to go.`);
  }
  /**
   * 2026-09-10 (test-triage COUNT NOT EXPOSED fix). R16's bar is minCycles:12 — the unit is
   * COMPLETED CYCLES since evidenceStart (2026-08-04). Every entry in st.closed is already since
   * evidenceStart (the sleeve did not exist earlier), so no additional date filter is needed.
   * estimate is the mean pctOfNotional across completed cycles — the sleeve's own headline number;
   * it is NOT yet netted against the registered BETA-MATCHED benchmark (this writer does not
   * compute that comparison), so it is reported honestly as the raw sleeve return, not the
   * registered statistic proper. bySession exposes one entry per completed cycle for a future MDE
   * calculation. Nothing here changes the rule, the bar, or the circuit breaker.
   */
  st.dailyClock = {
    sessions: cl.length,
    estimate: cl.length ? +(cl.reduce((s, c) => s + c.pctOfNotional, 0) / cl.length).toFixed(4) : null,
    unit: "completed monthly overwrite cycles",
    note: "estimate is mean pctOfNotional of the sleeve itself, RAW — not yet netted against the registered beta-matched benchmark, which this writer does not compute",
  };
  st.bySession = cl.map((c) => ({ session: c.settledOn, mean: c.pctOfNotional }));
  st.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  console.log(`\nwritten: vrp-sleeve.json`);
})();
