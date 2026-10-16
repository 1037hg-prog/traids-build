#!/usr/bin/env node
/**
 * MARKET STATE — HOURLY LIVE LAYER. (2026-08-19, operator: "lets update the market state
 * every half hour ... or every hour")
 *
 * WHAT THIS IS. A PROVISIONAL intraday reading of the sentiment gauge's light components,
 * recomputed hourly during market hours with live prices, percentile-ranked against the SAME
 * completed-session history the nightly gauge uses.
 *
 * WHAT THIS IS NOT — the integrity constraint that shaped it:
 *   - It NEVER writes to sentiment-gauge.json. That file's history is the evidence base for
 *     test #66 (the Fear & Greed contrarian claim) and must contain completed sessions only.
 *     This script owns its own file (market-state-live.json), overwritten hourly, superseded
 *     every evening by the official close row.
 *   - It scores only the four LIGHT components (momentum, volatility, safe haven, junk bond).
 *     Breadth and 52-week strength stay nightly-only BY DESIGN: the gauge's own header
 *     documents how intraday forming-bar extremes made those two churn dishonestly (86 -> 100
 *     between runs minutes apart). Put/call is carried from the last official close, labeled.
 *   - Every output is stamped provisional with its own asOf; the UI shows it as a LIVE line
 *     beside the official close reading, never in place of it.
 */
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "data", "market-state-live.json");
const GAUGE = path.join(__dirname, "data", "sentiment-gauge.json");
const API = process.env.TRAIDS_API || "http://localhost:3001";
const YAHOO = process.env.TRAIDS_YAHOO || "http://localhost:3002";
const LOOKBACK = 250;

const post = (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(90000) }).then(r => r.ok ? r.json() : Promise.reject(new Error(`${u} ${r.status}`)));
const etDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const pct = (hist, v) => { const h = hist.filter(Number.isFinite); if (h.length < 40 || !Number.isFinite(v)) return null; return Math.round(100 * h.filter(x => x <= v).length / h.length); };
const sma = (a, i, n) => { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; };

(async () => {
  // MARKET-HOURS GUARD — the task fires on weekday wall-clock, but wall-clock does not know
  // holidays or half-days. Alpaca's clock does; when the market is closed this exits without
  // writing, so the LIVE line simply goes stale and the UI's 75-minute freshness window hides it.
  try {
    const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/).filter(l => l.includes("=") && !l.startsWith("#")).map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
    const clock = await fetch("https://api.alpaca.markets/v2/clock", { headers: { "APCA-API-KEY-ID": env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY }, signal: AbortSignal.timeout(15000) }).then(r => r.json());
    if (!clock.is_open) { console.log("MARKET STATE LIVE — market closed (" + (clock.next_open || "") + " next open); nothing written."); return; }
  } catch { /* clock unreachable: proceed, the snapshot fetch fails closed anyway */ }
  const today = etDay();
  // completed closes only — today's forming bar is dropped, live price appended explicitly
  const core = await post(`${API}/api/equities/bars`, { symbols: ["SPY", "TLT", "HYG"], days: 800 });
  const closed = (s) => (core.data[s] || []).filter(b => String(b.t).slice(0, 10) < today).map(b => b.c);
  const spyC = closed("SPY"), tltC = closed("TLT"), hygC = closed("HYG");

  const snap = await fetch(`${API}/api/equities/snapshot?symbols=SPY,TLT,HYG`, { signal: AbortSignal.timeout(30000) }).then(r => r.json());
  const liveOf = (s) => { const q = snap[s]; const p = q && (q.price ?? q.p ?? q.last); return Number.isFinite(p) && p > 0 ? p : null; };
  const missing = ["SPY", "TLT", "HYG"].filter(s => !liveOf(s));
  if (missing.length) { console.error(`MARKET STATE LIVE — no live price for ${missing.join(",")}; refusing to fabricate. Nothing written.`); process.exit(2); }

  let vixC = [], vixLive = null;
  try {
    const y = await post(`${YAHOO}/api/yahoo/batch`, { symbols: ["^VIX"], days: 800 });
    const rows = y.data["^VIX"] || [];
    vixC = rows.filter(b => String(b.t).slice(0, 10) < today).map(b => b.c).filter(Number.isFinite);
    const t = rows[rows.length - 1]; if (t && String(t.t).slice(0, 10) === today && Number.isFinite(t.c)) vixLive = t.c;
  } catch { /* volatility goes unscored */ }

  const comp = {};
  const put = (key, label, value, score, detail) => { comp[key] = { label, value, score, detail, live: true }; };

  { // momentum — SPY live vs 125d SMA of completed closes
    const series = spyC.map((c, i) => { const m = sma(spyC, i, 125); return m ? 100 * (c / m - 1) : null; }).filter(Number.isFinite);
    const withLive = [...spyC, liveOf("SPY")];
    const m = sma(withLive, withLive.length - 1, 125);
    const v = m ? 100 * (liveOf("SPY") / m - 1) : null;
    put("momentum", "Market Momentum", v == null ? null : +v.toFixed(2), pct(series.slice(-LOOKBACK), v), `S&P proxy ${v >= 0 ? "+" : ""}${v?.toFixed(2)}% vs its 125-day average (live)`);
  }
  if (vixC.length > 60 && vixLive != null) { // volatility — inverted
    const series = vixC.map((c, i) => { const m = sma(vixC, i, 50); return m ? 100 * (c / m - 1) : null; }).filter(Number.isFinite);
    const withLive = [...vixC, vixLive];
    const m = sma(withLive, withLive.length - 1, 50);
    const v = m ? 100 * (vixLive / m - 1) : null;
    const p = pct(series.slice(-LOOKBACK), v);
    put("volatility", "Market Volatility", v == null ? null : +v.toFixed(2), p == null ? null : 100 - p, `VIX ${vixLive.toFixed(2)}, ${v >= 0 ? "+" : ""}${v?.toFixed(1)}% vs its 50-day average (live)`);
  }
  const r20live = (hist, live) => hist.length >= 20 ? 100 * (live / hist[hist.length - 20] - 1) : null;
  { // safe haven — 20d stocks minus bonds, live last point
    const n = Math.min(spyC.length, tltC.length);
    const series = [];
    for (let i = 20; i < n; i++) series.push(100 * (spyC[i] / spyC[i - 20] - 1) - 100 * (tltC[i] / tltC[i - 20] - 1));
    const v = r20live(spyC, liveOf("SPY")) - r20live(tltC, liveOf("TLT"));
    put("safeHaven", "Safe Haven Demand", +v.toFixed(2), pct(series.slice(-LOOKBACK), v), `stocks ${v >= 0 ? "beating" : "trailing"} bonds by ${Math.abs(v).toFixed(2)}pp over 20 sessions (live)`);
  }
  { // junk bond — HYG minus TLT, 20d, live last point
    const n = Math.min(hygC.length, tltC.length);
    const series = [];
    for (let i = 20; i < n; i++) series.push(100 * (hygC[i] / hygC[i - 20] - 1) - 100 * (tltC[i] / tltC[i - 20] - 1));
    const v = r20live(hygC, liveOf("HYG")) - r20live(tltC, liveOf("TLT"));
    put("junkBond", "Junk Bond Demand", +v.toFixed(2), pct(series.slice(-LOOKBACK), v), `high yield ${v >= 0 ? "beating" : "trailing"} treasuries by ${Math.abs(v).toFixed(2)}pp over 20 sessions (live)`);
  }

  // carry the heavy/rationed components from the last OFFICIAL close, labeled as carried
  let carried = 0;
  try {
    const g = JSON.parse(fs.readFileSync(GAUGE, "utf8"));
    const last = (g.history || []).slice(-1)[0];
    for (const k of ["strength", "breadth", "putCall"]) {
      const c = last?.components?.[k];
      if (c && !(k in comp)) { comp[k] = { ...c, live: false, detail: `${c.detail} — carried from ${last.date} close` }; carried++; }
    }
  } catch { /* live-only */ }

  const scored = Object.values(comp).filter(c => c.score != null);
  const liveScored = scored.filter(c => c.live).length;
  const composite = scored.length ? Math.round(scored.reduce((s, c) => s + c.score, 0) / scored.length) : null;
  const band = composite == null ? null : composite >= 76 ? "EXTREME GREED" : composite >= 56 ? "GREED" : composite > 44 ? "NEUTRAL" : composite > 24 ? "FEAR" : "EXTREME FEAR";

  const out = {
    asOf: new Date().toISOString(), etDate: today, provisional: true,
    note: "hourly LIVE reading — 4 components on live prices, heavy components carried from last close; the official row lands in sentiment-gauge.json at the close and this file never touches it",
    composite, band, scoredOf: `${liveScored} live + ${carried} carried`, components: comp,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`MARKET STATE LIVE — ${composite} (${band}) · ${out.scoredOf} · ${today} ${new Date().toISOString().slice(11, 16)}Z · provisional`);
})();
