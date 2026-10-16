#!/usr/bin/env node
/**
 * BOOK RISK MANAGER — SHADOW MODE (built 2026-09-26, operator: "build the risk manager"). Watches the whole Plan E book every night and
 * records what it WOULD do; it changes no position until its effect is measured (registered forward test R270).
 *
 * MODEL BOOK (daily, from market prices, so it exists from day one and does not depend on any leg's paper fills):
 *   ETF sleeves (weights of a $100k book): QQQ .15, SPY .15, GLD .10, EFA .10 on the 10-month rule (signal from the prior month-end close,
 *   held through the next month), DBMF .15 always; crypto .15 = BTC .075 + ETH .075 on the 50-day rule (close > SMA50 at t -> held on
 *   t+1, 25 bps per switch, out = T-bill); ZN month-end overlay 4.2x on the whole book, PROXIED as 4.2 x 0.79 x IEF daily return on the
 *   last 5 sessions of each month (0.79 = ZN-on-IEF beta, futures-month-end.js), 4 bps x 4.2 on entry and exit; all uninvested weight
 *   earns the 3-month T-bill (FRED DTB3). Prices: Alpaca SIP daily adjustment=all (feed sip, truncation asserted), Coinbase daily.
 * MEASURES (each night, trailing): book vol 20d/60d annualised, drawdown from peak, each leg's share of book risk over 60d
 *   (w_i * cov(r_i, r_book) / var(r_book)), pairwise 60d correlations between legs (equity, gold, DBMF, crypto, treasury).
 * RULES (fixed 2026-09-26, before any preview number was seen; standard practice values, not tuned):
 *   vol scale  = clamp(0.15 / vol60, 0.5, 1.25)
 *   dd scale   = 1.00; <= -8% drawdown -> 0.75; <= -12% -> 0.50; back to 1.00 once drawdown recovers above -4% (hysteresis)
 *   would-do   = min(vol scale, dd scale), decided on day t's close, applied to day t+1 (no look-ahead)
 *   alerts     : any leg > 50% of book risk; any leg-pair 60d correlation > 0.60; vol20 > 1.5 x vol60 (regime jump)
 * SHADOW EVALUATION: managed return(t+1) = scale(t) x risky return(t+1) + (1 - scale(t)) x T-bill; compared with the unmanaged book.
 *   node backend/risk-manager.js            nightly: rebuild the model book, write data/risk-manager.json, append today's forward row
 *   node backend/risk-manager.js --preview  the history preview only (weightless, disclosed as a preview)
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f), OUT = D("risk-manager.json"), HIST = D("risk-manager-forward.jsonl");
const FORWARD_START = "2026-09-28";
const W = { QQQ: 0.15, SPY: 0.15, GLD: 0.10, EFA: 0.10, DBMF: 0.15, BTC: 0.075, ETH: 0.075 }, ZN_LEV = 4.2, ZN_BETA = 0.79;
const RULE = { volTarget: 0.15, volMin: 0.5, volMax: 1.25, dd1: -0.08, dd1s: 0.75, dd2: -0.12, dd2s: 0.5, ddReset: -0.04, legRiskMax: 0.5, corrMax: 0.6, volJump: 1.5 };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const cov = (a, b) => { const ma = mean(a), mb = mean(b); let c = 0; for (let i = 0; i < a.length; i++) c += (a[i] - ma) * (b[i] - mb); return c / Math.max(1, a.length - 1); };
const corr = (a, b) => cov(a, b) / (sd(a) * sd(b) || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tbillDaily() { const f = D("training/fred/DTB3.csv"), M = {}; if (fs.existsSync(f)) for (const l of fs.readFileSync(f, "utf8").trim().split(/\r?\n/).slice(1)) { const [d, v] = l.split(","); if (v && v !== ".") M[d.slice(0, 7)] = +v / 100 / 252; } return (d) => M[d.slice(0, 7)] ?? M[Object.keys(M).sort().pop()] ?? 0.04 / 252; }
async function coinbase(coin, fromIso) { const m = new Map(), now = Date.now(), from = fromIso.slice(0, 10), bad = (why) => new Error(`coinbase ${coin}: ${why} — the crypto leg is UNKNOWN (a partial or stale series is never used)`);
  // 2026-10-12 (profit fixes B): chunks aligned to 00:00 UTC. The old loop cut its chunks at now-minus-299-days and started the next one a day earlier, so the candle at every
  // boundary was never asked for (10 holes since 2018). The in-progress candle of today is kept, as before. A failed, malformed, holed or stale answer throws: the run ends
  // UNKNOWN instead of building the book on whatever did arrive.
  // A request the exchange answers with 429 or 5xx, or does not answer inside its 20 seconds, is asked again after 2 s and then 5 s: at most 3 times a request and at most 3
  // repeats a coin, so a run of bad answers still ends well inside the close chain's 6 minutes. One rate-limit among the night's 22 requests no longer costs the night's row;
  // any other fault, and a fault that stays, ends the run UNKNOWN.
  let repeats = 0; const ask = async (url) => { for (let n = 1; ; n++) { let why;
      try { const r = await fetch(url, { headers: { "User-Agent": "TRAIDS risk-manager" }, signal: AbortSignal.timeout(20000) }); if (r.ok) return await r.json(); why = `HTTP ${r.status}`; if (r.status !== 429 && r.status < 500) throw bad(why); }
      catch (e) { if (!(e && e.name === "TimeoutError")) throw e; why = "no answer inside the 20-second timeout"; }
      if (n >= 3 || repeats >= 3) throw bad(`${why} (asked ${n} time${n > 1 ? "s" : ""})`); repeats++; await sleep(n === 1 ? 2000 : 5000); } };
  for (let s = Date.parse(from + "T00:00:00Z"); s < now;) { const e = Math.min(now, s + 290 * 864e5);
    const a = await ask(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`); if (!Array.isArray(a)) throw bad("the answer is not a candle list");
    for (const c of a) { const t = Array.isArray(c) ? +c[0] : NaN, px = Array.isArray(c) ? +c[4] : NaN; if (!Number.isFinite(t) || !(px > 0)) throw bad("a candle without a usable time or close"); m.set(new Date(t * 1000).toISOString().slice(0, 10), px); }
    s = e; if (s < now) await sleep(350); }
  const lastDone = new Date(now - 864e5).toISOString().slice(0, 10), missing = [];   // every UTC day from the first one asked for through the last COMPLETED one must be there
  for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(lastDone + "T00:00:00Z"); t += 864e5) { const k = new Date(t).toISOString().slice(0, 10); if (!m.has(k)) missing.push(k); }
  if (missing.length) throw bad(`${missing.length} daily candle(s) missing between ${from} and ${lastDone}: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ", ..." : ""}`);
  return m; }
/** The sessions still to come in the last bar's calendar month, from Alpaca's calendar (GET /v2/calendar — what r219-zn-month-end.js monthSessions reads for the same window).
 *  A month-end window can only be placed on the whole month. A calendar that cannot be read, or that does not list the last bar's own day, throws: the run ends UNKNOWN and
 *  never falls back to "the latest 5 sessions so far". (2026-10-12, profit fixes B) */
async function sessionsToCome(lastDay) { const [y, mo] = lastDay.split("-").map(Number), monthEnd = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10), bad = (why) => new Error(`calendar ${lastDay}..${monthEnd}: ${why} — the month-end window cannot be placed (UNKNOWN)`);
  const r = await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${lastDay}&end=${monthEnd}`, { headers: { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw bad(`HTTP ${r.status}`); const a = await r.json(); if (!Array.isArray(a)) throw bad("the answer is not a list");
  const ds = a.map((x) => (x && typeof x.date === "string" ? x.date : "")); if (ds.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d) || d < lastDay || d > monthEnd)) throw bad("a row without a date inside the range");
  if (!ds.includes(lastDay)) throw bad(`it does not list ${lastDay}, the last bar's day, as a session`);
  // A well-formed but CUT answer would put the window on the wrong days and say nothing. The last session listed must be within 4 calendar days of the month's last day:
  // in the bar history since 2018-06 no month's last session is more than 3 days before it (a weekend after a Friday holiday, a Monday holiday after a weekend).
  const lastListed = ds.reduce((x, d) => (d > x ? d : x)); if ((Date.parse(monthEnd) - Date.parse(lastListed)) / 864e5 > 4) throw bad(`the list ends ${lastListed}, more than 4 days before the month's last day: a cut answer`);
  return [...new Set(ds)].filter((d) => d > lastDay).sort(); }
async function buildBook(fromIso) {
  const today = new Date().toISOString().slice(0, 10);
  const r = await fetchBars(["QQQ", "SPY", "GLD", "EFA", "DBMF", "IEF"], { start: "2018-06-01", end: new Date(Date.now() - 20 * 60e3).toISOString(), feed: "sip", adjustment: "all", quiet: true, requireAll: false });
  if ((r.truncatedStart || []).filter((x) => x.symbol !== "DBMF").length) throw new Error("history truncated — refusing");
  const tb = tbillDaily(), btc = await coinbase("BTC", "2018-06-01"), eth = await coinbase("ETH", "2018-06-01");
  const days = r.bars.SPY.map((b) => b.t.slice(0, 10)).filter((d) => d >= fromIso);
  const close = {}; for (const s of Object.keys(r.bars)) { close[s] = new Map(r.bars[s].map((b) => [b.t.slice(0, 10), b.c])); }
  const allDays = r.bars.SPY.map((b) => b.t.slice(0, 10));
  // 2026-10-12 (profit fixes B): the row this run writes is the last bar's day, and its crypto leg needs that day's candle of BOTH coins. coinbase() checks every day through
  // yesterday UTC; at the nightly run the last bar's day is today (its candle still in progress), so it is asked for here. A feed that stopped inside the last day would
  // otherwise leave that row with no crypto leg, or half of one, and nothing would say so: the run ends UNKNOWN instead.
  { const lastDay = allDays[allDays.length - 1], lack = [["BTC", btc], ["ETH", eth]].filter(([, m]) => !m.has(lastDay)).map(([c]) => c);
    if (lack.length) throw new Error(`coinbase ${lack.join(" and ")}: no candle for ${lastDay}, the last bar's day — the crypto leg of that row is UNKNOWN (a feed that stopped is never booked as a zero return)`); }
  // 10-month signal per ETF, decided at each month-end close, applied through the next month
  const sig = {}; for (const s of ["QQQ", "SPY", "GLD", "EFA"]) { const me = {}; for (const b of r.bars[s]) me[b.t.slice(0, 7)] = b.c; const ms = Object.keys(me).sort(); sig[s] = {}; for (let i = 10; i < ms.length; i++) { const avg = mean(ms.slice(i - 9, i + 1).map((m) => me[m])); sig[s][ms[i]] = me[ms[i]] > avg; } }
  const prevMonth = (d) => { const [y, m] = d.slice(0, 7).split("-").map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };
  // crypto 50-day state per coin (calendar days on Coinbase; applied to the trading-day grid by compounding the calendar days in between)
  const cryptoDaily = (m) => { const ds = [...m.keys()].sort(), out = new Map(); let pos = 0; for (let i = 50; i < ds.length; i++) { const px = m.get(ds[i]), ret = px / m.get(ds[i - 1]) - 1; let v = pos ? ret : tb(ds[i]) * 252 / 365; const on = px > mean(ds.slice(i - 49, i + 1).map((d) => m.get(d))) ? 1 : 0; if (on !== pos) v -= 0.0025; out.set(ds[i], v); pos = on; } return out; };
  const cb = cryptoDaily(btc), ce = cryptoDaily(eth);
  const compoundCrypto = (m, d0, d1) => { let g = 1; for (let t = Date.parse(d0) + 864e5; t <= Date.parse(d1); t += 864e5) { const k = new Date(t).toISOString().slice(0, 10); if (m.has(k)) g *= 1 + m.get(k); } return g - 1; };
  // month-end windows: last 5 sessions of each CALENDAR month. For the month in progress the sessions still to come are asked of the calendar (sessionsToCome).
  // Until 2026-10-12 the window was "the latest 5 sessions so far", so on every night of an unfinished month the run put the Treasury proxy on that day's row.
  const byMonth = {}; allDays.concat(await sessionsToCome(allDays[allDays.length - 1])).forEach((d) => (byMonth[d.slice(0, 7)] = byMonth[d.slice(0, 7)] || []).push(d)); const inWin = new Set(), winEdge = new Set();
  for (const ds of Object.values(byMonth)) { const w = ds.slice(-5); w.forEach((d) => inWin.add(d)); winEdge.add(w[0]); winEdge.add(w[w.length - 1]); }
  const rows = [];
  for (const d of days) {
    const i = allDays.indexOf(d); if (i < 1) continue; const p = allDays[i - 1], leg = {}, rf = tb(d);
    const rr = (s) => (close[s].has(d) && close[s].has(p) ? close[s].get(d) / close[s].get(p) - 1 : null);
    let used = 0;
    for (const s of ["QQQ", "SPY", "GLD", "EFA"]) { const on = sig[s][prevMonth(d)]; if (on && rr(s) != null) { leg[s] = W[s] * rr(s); used += W[s]; } else leg[s] = 0; }
    if (rr("DBMF") != null) { leg.DBMF = W.DBMF * rr("DBMF"); used += W.DBMF; } else leg.DBMF = 0;
    leg.CRYPTO = W.BTC * compoundCrypto(cb, p, d) + W.ETH * compoundCrypto(ce, p, d); used += W.BTC + W.ETH;   // crypto legs carry their own cash yield when out
    leg.TSY = inWin.has(d) && rr("IEF") != null ? ZN_LEV * ZN_BETA * rr("IEF") - (winEdge.has(d) ? 0.0004 * ZN_LEV / 2 : 0) : 0;
    leg.CASH = (1 - used) * rf;
    const risky = leg.QQQ + leg.SPY + leg.GLD + leg.EFA + leg.DBMF + leg.CRYPTO + leg.TSY;
    rows.push({ d, rf, legs: { EQUITY: leg.QQQ + leg.SPY + leg.EFA, GOLD: leg.GLD, DBMF: leg.DBMF, CRYPTO: leg.CRYPTO, TSY: leg.TSY }, risky, book: risky + leg.CASH, investedW: used });
  }
  return rows;
}
function manage(rows) {
  let nav = 1, peak = 1, navM = 1, peakM = 1, ddState = 1, scale = 1; const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    // yesterday's decision on today's return: risky legs scaled; the cash leg unchanged; capital freed by scaling down earns the T-bill
    const managed = scale * r.risky + (r.book - r.risky) + (1 - scale) * r.investedW * r.rf;
    nav *= 1 + r.book; peak = Math.max(peak, nav); navM *= 1 + managed; peakM = Math.max(peakM, navM);
    const win = rows.slice(Math.max(0, i - 59), i + 1).map((x) => x.book), win20 = win.slice(-20);
    const vol60 = sd(win) * Math.sqrt(252), vol20 = sd(win20) * Math.sqrt(252), dd = nav / peak - 1;
    if (dd <= RULE.dd2) ddState = RULE.dd2s; else if (dd <= RULE.dd1) ddState = Math.min(ddState, RULE.dd1s); else if (dd > RULE.ddReset) ddState = 1;
    const volScale = win.length >= 40 ? Math.min(RULE.volMax, Math.max(RULE.volMin, RULE.volTarget / (vol60 || RULE.volTarget))) : 1;
    const decided = Math.min(volScale, ddState);
    out.push({ d: r.d, nav, navManaged: navM, dd, ddManaged: navM / peakM - 1, vol20, vol60, volScale, ddScale: ddState, scaleApplied: scale, scaleNext: decided, book: r.book, managed });
    scale = decided;
  }
  return out;
}
function riskShares(rows, n = 60) {
  const w = rows.slice(-n), book = w.map((x) => x.book), vb = cov(book, book) || 1e-12, legs = Object.keys(w[0].legs), share = {}, cm = {};
  for (const k of legs) share[k] = +(cov(w.map((x) => x.legs[k]), book) / vb).toFixed(3);
  for (let a = 0; a < legs.length; a++) for (let b = a + 1; b < legs.length; b++) { const A = w.map((x) => x.legs[legs[a]]), B = w.map((x) => x.legs[legs[b]]); if (sd(A) > 0 && sd(B) > 0) cm[`${legs[a]}~${legs[b]}`] = +corr(A, B).toFixed(2); }
  return { share, corr: cm };
}
function summary(m, lo, hi) { const x = m.filter((r) => r.d >= lo && r.d <= hi); if (x.length < 20) return null; const yrs = x.length / 252;
  const f = (k, ddk) => { const rets = x.map((r) => r[k]); const g = rets.reduce((p, v) => p * (1 + v), 1); let pk = 1, v = 1, dd = 0; for (const q of rets) { v *= 1 + q; pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); } return { cagrPct: +(100 * (g ** (1 / yrs) - 1)).toFixed(1), volPct: +(100 * sd(rets) * Math.sqrt(252)).toFixed(1), sharpe: +((mean(rets) / sd(rets)) * Math.sqrt(252)).toFixed(2), maxDDPct: +(100 * dd).toFixed(1) }; };
  return { days: x.length, unmanaged: f("book"), managed: f("managed"), avgScale: +mean(x.map((r) => r.scaleApplied)).toFixed(2), daysScaledDown: x.filter((r) => r.scaleApplied < 0.999).length }; }
/** Plan E's STATED model return, READ from the model's own output (backend/profit-program/planE-baseline.js writes data/profit-program/planE-baseline.json: the monthly family
 *  on the real ten-year-note windows) — never typed here. The book this file builds proxies the note by IEF's total return with no financing charge, so its own history runs
 *  higher; that level is the shadow manager's yardstick, not Plan E's stated return. A file that cannot be read is UNKNOWN, never a remembered number. (2026-10-12, profit fixes B) */
function planEStated() { const src = "data/profit-program/planE-baseline.json";
  try { const j = JSON.parse(fs.readFileSync(D("profit-program/planE-baseline.json"), "utf8")), e = (j.py || {}).E || {}, a = e.annualReturnPct;
    if (!(typeof a === "number" && Number.isFinite(a) && a > -100 && a < 1000 && e.months >= 12)) throw new Error("py.E.annualReturnPct / months missing or not a number");
    return { status: "OK", annualReturnPct: a, usdPerYearPer100k: Math.round(1000 * a), usdPerTradingDayPer100k: +((1000 * a) / 252).toFixed(2), months: e.months, from: e.from, to: e.to, maxDDmonthEndPct: e.maxDDmonthEndPct ?? null, source: `${src} py.E`, inputsFetchedAt: j.inputsFetchedAt || null, note: "model arithmetic on history, not a forecast and not advice" }; }
  catch (e) { return { status: "UNKNOWN", annualReturnPct: null, why: `${src}: ${String(e.message).replace(/\s+/g, " ").slice(0, 140)}` }; } }
(async () => {
  const rows = await buildBook("2019-06-03"), m = manage(rows), last = m[m.length - 1], lastRow = rows[rows.length - 1], rs = riskShares(rows);
  const alerts = [];
  for (const [k, v] of Object.entries(rs.share)) if (v > RULE.legRiskMax) alerts.push(`${k} carries ${Math.round(100 * v)}% of book risk (> ${100 * RULE.legRiskMax}%)`);
  for (const [k, v] of Object.entries(rs.corr)) if (v > RULE.corrMax) alerts.push(`${k} correlation ${v} over 60 days (> ${RULE.corrMax}) — diversification weakening`);
  if (last.vol20 > RULE.volJump * last.vol60) alerts.push(`20-day vol ${(100 * last.vol20).toFixed(1)}% > 1.5x 60-day ${(100 * last.vol60).toFixed(1)}% — regime jump`);
  const snapshot = { status: "OK", asOf: last.d, planE: planEStated(), mode: "SHADOW — records what it would do; changes nothing", rules: RULE, model: "Plan E on $100k from market prices (ZN leg proxied by 3.3x IEF on month-end windows)",
    today: { drawdownPct: +(100 * last.dd).toFixed(2), vol20Pct: +(100 * last.vol20).toFixed(1), vol60Pct: +(100 * last.vol60).toFixed(1), volScale: +last.volScale.toFixed(2), ddScale: last.ddScale, wouldDo: +last.scaleNext.toFixed(2), wouldDoText: last.scaleNext >= 0.999 ? "full size" : `cut every risky leg to ${Math.round(100 * last.scaleNext)}% (rest to T-bills)` },
    riskShare60d: rs.share, legCorr60d: rs.corr, alerts,
    preview: { basis: "this file's IEF-proxy book (ZN leg = ZN_LEV x ZN_BETA x IEF total return, no financing charge): its level is NOT Plan E's stated model return — that is planE.annualReturnPct, read from the model's own output", note: "WEIGHTLESS preview on history — the rules were fixed before this was computed; the registered forward read (R270) is the evidence", "2019-06..now": summary(m, "2019-06-01", "9999"), "2022": summary(m, "2022-01-01", "2022-12-31") } };
  writeJsonAtomic(OUT, { ...snapshot, generatedAt: new Date().toISOString() });
  if (!process.argv.includes("--preview") && last.d >= FORWARD_START) { const seen = fs.existsSync(HIST) ? fs.readFileSync(HIST, "utf8") : ""; if (!seen.includes(`"d":"${last.d}"`)) fs.appendFileSync(HIST, JSON.stringify({ d: last.d, book: lastRow.book, scaleApplied: last.scaleApplied, managed: last.managed, dd: last.dd, vol60: last.vol60, wouldDo: last.scaleNext, alerts }) + "\n"); }
  console.log(`RISK MANAGER (shadow) ${last.d}: drawdown ${snapshot.today.drawdownPct}% · vol 20d ${snapshot.today.vol20Pct}% / 60d ${snapshot.today.vol60Pct}% · would-do: ${snapshot.today.wouldDoText}`);
  console.log(`  risk share 60d: ${Object.entries(rs.share).map(([k, v]) => `${k} ${Math.round(100 * v)}%`).join(" · ")}`);
  console.log(`  alerts: ${alerts.length ? alerts.join(" | ") : "none"}`);
  { const st = snapshot.planE, pv = snapshot.preview["2019-06..now"];   // 2026-10-12 (profit fixes B): the stated return comes from the model's own output; the proxy book's level is no longer printed as if it were Plan E's
    console.log(st.status === "OK" ? `  Plan E stated model return: ${st.annualReturnPct}% a year = $${st.usdPerYearPer100k.toLocaleString("en-US")} a year, $${st.usdPerTradingDayPer100k.toFixed(2)} a trading day on $100,000 (${st.from}..${st.to}, ${st.months} months; read from ${st.source}; ${st.note})` : `  Plan E stated model return: UNKNOWN (${st.why})`);
    console.log(`  preview (weightless; on this file's IEF-proxy book, whose level is not the stated return): ${pv ? `managed minus unmanaged ${(pv.managed.cagrPct - pv.unmanaged.cagrPct).toFixed(1)} pt a year, max drawdown ${pv.managed.maxDDPct}% against ${pv.unmanaged.maxDDPct}%, Sharpe ${pv.managed.sharpe} against ${pv.unmanaged.sharpe}, scaled down on ${pv.daysScaledDown} of ${pv.days} days` : "fewer than 20 days"}`); }
  console.log(`  preview 2022: ${JSON.stringify(snapshot.preview["2022"])}`);
})().catch((e) => { const why = String((e && e.message) || e).replace(/\s+/g, " ").slice(0, 300);
  // 2026-10-12 (profit fixes B): a run that could not finish is UNKNOWN and the stored snapshot says so. The last good numbers stay, marked with the day they are from;
  // nothing is passed off as tonight's, and no forward row is written.
  try { let prev = {}; try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")) || {}; } catch {} writeJsonAtomic(OUT, { ...prev, status: "UNKNOWN", unknown: { at: new Date().toISOString(), why, lastGoodAsOf: prev.status === "UNKNOWN" ? (prev.unknown || {}).lastGoodAsOf || null : prev.asOf || null } }); }
  catch (w) { console.error("risk-manager: the snapshot could not be marked UNKNOWN:", w.message); }
  // The close chain keeps the LAST 400 characters of a failed step's stderr as that step's record. So the stack goes first and the one-line reason LAST: the reason is at
  // most 300 characters and nothing is written to stderr after it, so the chain's record of the night names the cause (HTTP 429, a missing candle, ...), not stack frames.
  console.log(`RISK MANAGER UNKNOWN (shadow) - nothing computed, no forward row written: ${why}`); console.error("risk-manager FAILED:", e && e.stack); console.error(`RISK MANAGER UNKNOWN (shadow): ${why}`); process.exit(1); });
