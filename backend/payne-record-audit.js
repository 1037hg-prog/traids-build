#!/usr/bin/env node
/**
 * PAYNE MODEL-PORTFOLIO AUDIT — the full published Hotline record, 2020-01 .. 2026-08. 2026-09-24, operator sent the page
 * (payneseducation.com/pages/model-portfolio-results) and its PDF after "what his algo".
 *
 * INPUT: the transcription of every closed-trade table (scratchpad rows-A..D.json, merged into data/payne-model-portfolio.json by
 * --merge) and the open-positions tables (open-positions.json). Every number is his printed number; nothing is inferred.
 *
 * CHECKS, all against Alpaca SIP daily bars (raw AND split-adjusted, delisted names included):
 *   1. PRICE REALITY   each printed entry/exit price must lie inside that day's traded range (±1% slack, either raw or split-adjusted
 *                      basis). Out-of-range prices are listed, not corrected.
 *   2. SAME-WINDOW SPY every closed trade's % beside SPY's % from the entry close to the exit close — did the pick beat simply holding
 *                      the index for the same days?
 *   3. PORTFOLIO       an equal-weight book of every position while it was open (closed trades between their printed dates; open ones
 *                      marked to the last close): daily return series vs SPY — CAGR, max drawdown, beta, and the alpha left after beta.
 *   Statistic for "beats the market": mean per-trade excess over SPY, t clustered by ENTRY MONTH (trades opened together share a market).
 *
 *   node backend/payne-record-audit.js --merge     merge rows-*.json into data/payne-model-portfolio.json
 *   node backend/payne-record-audit.js             run the audit -> data/payne-record-audit.json
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const SP = process.env.PAYNE_SCRATCH || "C:/Users/joshc/AppData/Local/Temp/claude/C--Users-joshc-Downloads-traids--2--traids-bundle/7f0996e1-32f0-428a-b708-56912c033489/scratchpad/payne-pdf";
const CACHE = D("payne-audit-cache"); if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });
const H = () => ({ "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

if (process.argv.includes("--merge")) {
  const rows = [], files = [], notes = [];
  for (const k of ["A", "B", "C", "D"]) { const f = path.join(SP, `rows-${k}.json`); if (!fs.existsSync(f)) { console.error(`missing ${f}`); process.exit(2); } const j = JSON.parse(fs.readFileSync(f, "utf8")); rows.push(...j.rows.filter((r) => !r.duplicateOf)); /* p08_3 repeats the March 2025 table (p08_1 adds GEV); keep one copy */ files.push(...(j.files || [])); notes.push(...(j.notes || [])); }
  const open = JSON.parse(fs.readFileSync(path.join(SP, "open-positions.json"), "utf8"));
  writeJsonAtomic(D("payne-model-portfolio.json"), { source: "payneseducation.com/pages/model-portfolio-results (closed, as of 2026-08-31) + /model-portfolio-open-positions; PDF 'Charles Payne Model Portfolio Results.pdf' supplied by the operator 2026-09-24; transcribed image by image with a printed-P/L consistency check", transcribedOn: "2026-09-24", closed: rows, open: open.rows, images: files, notes });
  console.log(`merged ${rows.length} closed rows from ${files.length} images + ${open.rows.length} open`); process.exit(0);
}

async function bars(sym, adj) {
  const f = path.join(CACHE, `${sym.replace(/[^A-Z0-9.]/gi, "_")}-${adj}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  let out = [], token = null;
  for (let i = 0; i < 20; i++) {
    const p = new URLSearchParams({ symbols: sym, timeframe: "1Day", start: "2019-12-01", end: new Date(Date.now() - 20 * 60000).toISOString(), limit: "10000", adjustment: adj, feed: "sip" });
    if (token) p.set("page_token", token);
    const r = await fetch("https://data.alpaca.markets/v2/stocks/bars?" + p, { headers: H() });
    if (r.status === 429) { await sleep(3000); i--; continue; }
    if (!r.ok) throw new Error(`alpaca ${r.status} ${sym}`);
    const j = await r.json(); out.push(...((j.bars && j.bars[sym]) || [])); token = j.next_page_token; if (!token) break;
  }
  const rows = out.map((b) => ({ d: b.t.slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c }));
  fs.writeFileSync(f, JSON.stringify(rows)); await sleep(120); return rows;
}
const at = (rows, d) => rows.find((b) => b.d === d) || null;
const onOrAfter = (rows, d) => rows.find((b) => b.d >= d) || null;
const inRange = (b, px) => b && px >= b.l * 0.99 && px <= b.h * 1.01;

(async () => {
  const P = JSON.parse(fs.readFileSync(D("payne-model-portfolio.json"), "utf8"));
  const closed = P.closed.filter((r) => r.ticker && r.entryDate && r.exitDate && Number.isFinite(r.entryPrice) && Number.isFinite(r.exitPrice));
  const spy = await bars("SPY", "raw");
  const syms = [...new Set([...closed.map((r) => r.ticker), ...P.open.map((r) => r.markAs || r.ticker)])];
  const B = {};
  for (const s of syms) { try { B[s] = { raw: await bars(s, "raw"), split: await bars(s, "split") }; } catch (e) { B[s] = { err: e.message }; } }
  // 1 + 2: per trade
  const trades = closed.map((r) => {
    const b = B[r.ticker] || {}, eR = b.raw && at(b.raw, r.entryDate), xR = b.raw && at(b.raw, r.exitDate), eS = b.split && at(b.split, r.entryDate), xS = b.split && at(b.split, r.exitDate);
    const entryOk = inRange(eR, r.entryPrice) || inRange(eS, r.entryPrice), exitOk = inRange(xR, r.exitPrice) || inRange(xS, r.exitPrice);
    const s0 = onOrAfter(spy, r.entryDate), s1 = onOrAfter(spy, r.exitDate);
    const pl = (r.exitPrice / r.entryPrice - 1) * 100, spyPct = s0 && s1 ? (s1.c / s0.c - 1) * 100 : null;
    return { ...r, plCalc: r2(pl), spyPct: r2(spyPct), excess: spyPct == null ? null : r2(pl - spyPct), entryOk: b.err ? null : entryOk, exitOk: b.err ? null : exitOk, dataErr: b.err || (!eR && !eS ? "no bar on entry date" : null),
      entryRange: eR ? [eR.l, eR.h] : null, exitRange: xR ? [xR.l, xR.h] : null };
  });
  const scored = trades.filter((t) => t.excess != null);
  const byMonth = {}; for (const t of scored) (byMonth[t.entryDate.slice(0, 7)] = byMonth[t.entryDate.slice(0, 7)] || []).push(t.excess);
  const monthMeans = Object.values(byMonth).map(mean), tMonth = mean(monthMeans) / (sd(monthMeans) / Math.sqrt(monthMeans.length));
  const byYear = {}; for (const t of scored) (byYear[t.entryDate.slice(0, 4)] = byYear[t.entryDate.slice(0, 4)] || []).push(t);
  const years = Object.fromEntries(Object.entries(byYear).map(([y, a]) => [y, { trades: a.length, winPct: r2(100 * a.filter((t) => t.plCalc > 0).length / a.length), meanPl: r2(mean(a.map((t) => t.plCalc))), meanSpy: r2(mean(a.map((t) => t.spyPct))), meanExcess: r2(mean(a.map((t) => t.excess))), beatSpyPct: r2(100 * a.filter((t) => t.excess > 0).length / a.length) }]));
  // open positions marked at the last close
  const lastDay = spy[spy.length - 1].d;
  const openMarked = P.open.map((o) => { const s = o.markAs || o.ticker, b = B[s] || {}, last = b.split && b.split[b.split.length - 1], s0 = onOrAfter(spy, o.entryDate);
    const eR = b.raw && at(b.raw, o.entryDate), eS = b.split && at(b.split, o.entryDate);
    return { ...o, markDate: last ? last.d : null, mark: last ? last.c : null, plPct: last ? r2((last.c / o.entryPrice - 1) * 100) : null, spyPct: s0 ? r2((spy[spy.length - 1].c / s0.c - 1) * 100) : null, entryOk: o.markAs ? null : (inRange(eR, o.entryPrice) || inRange(eS, o.entryPrice)) }; });
  // 3: equal-weight daily book (split-adjusted closes; entry/exit legs at the printed prices scaled onto the split basis by the entry-day ratio)
  const days = spy.filter((b) => b.d >= "2020-01-02").map((b) => b.d);
  const pos = [...closed.map((r) => ({ s: r.ticker, e: r.entryDate, x: r.exitDate, pe: r.entryPrice, px: r.exitPrice })), ...P.open.map((o) => ({ s: o.markAs || o.ticker, e: o.entryDate, x: null, pe: o.entryPrice, px: null }))];
  const idx = {}; for (const s of Object.keys(B)) if (B[s].split) { idx[s] = new Map(B[s].split.map((b) => [b.d, b.c])); }
  const book = [], spyD = new Map(spy.map((b) => [b.d, b.c]));
  for (let i = 1; i < days.length; i++) {
    const d0 = days[i - 1], d1 = days[i], rets = [];
    for (const p of pos) {
      if (!(p.e <= d0) || (p.x && p.x < d1) || !idx[p.s]) continue;
      const c0 = idx[p.s].get(d0), c1 = idx[p.s].get(d1); if (!(c0 > 0) || !(c1 > 0)) continue;
      rets.push(c1 / c0 - 1);
    }
    book.push({ d: d1, n: rets.length, r: rets.length ? mean(rets) : 0, spy: spyD.get(d1) / spyD.get(d0) - 1 });
  }
  const curve = (key) => { let v = 1, peak = 1, dd = 0; for (const b of book) { v *= 1 + b[key]; peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); } return { final: v, maxDD: dd }; };
  const yrs = book.length / 252, pb = curve("r"), ps = curve("spy");
  const inv = book.filter((b) => b.n > 0), mx = mean(inv.map((b) => b.spy)), my = mean(inv.map((b) => b.r));
  const beta = inv.reduce((s, b) => s + (b.spy - mx) * (b.r - my), 0) / inv.reduce((s, b) => s + (b.spy - mx) ** 2, 0);
  const resid = inv.map((b) => b.r - beta * b.spy), alphaDaily = mean(resid), alphaT = alphaDaily / (sd(resid) / Math.sqrt(resid.length));
  const out = {
    spec: "payne-record-audit-v1", ranAt: new Date().toISOString(), lastBar: lastDay,
    record: { closedTrades: closed.length, openPositions: P.open.length, images: (P.images || []).length },
    priceReality: { checked: trades.filter((t) => t.entryOk != null).length, entryOutOfRange: trades.filter((t) => t.entryOk === false).length, exitOutOfRange: trades.filter((t) => t.exitOk === false).length, noData: trades.filter((t) => t.dataErr).length,
      examples: trades.filter((t) => t.entryOk === false || t.exitOk === false).slice(0, 40).map((t) => ({ ticker: t.ticker, entryDate: t.entryDate, entryPrice: t.entryPrice, entryRange: t.entryRange, exitDate: t.exitDate, exitPrice: t.exitPrice, exitRange: t.exitRange, footnote: t.footnote || null })) },
    printedConsistency: { printedInconsistent: closed.filter((r) => r.printedInconsistent).length },
    perTrade: { n: scored.length, winPct: r2(100 * scored.filter((t) => t.plCalc > 0).length / scored.length), meanPl: r2(mean(scored.map((t) => t.plCalc))), medianPl: r2(med(scored.map((t) => t.plCalc))), meanSpySameWindow: r2(mean(scored.map((t) => t.spyPct))),
      meanExcess: r2(mean(scored.map((t) => t.excess))), medianExcess: r2(med(scored.map((t) => t.excess))), beatSpyPct: r2(100 * scored.filter((t) => t.excess > 0).length / scored.length), entryMonths: monthMeans.length, tExcessByEntryMonth: r2(tMonth),
      meanHoldDays: r2(mean(closed.map((t) => t.holdDays).filter(Number.isFinite))), worst: scored.slice().sort((a, b) => a.plCalc - b.plCalc).slice(0, 5).map((t) => `${t.ticker} ${t.entryDate} ${t.plCalc}%`) },
    byYear: years,
    open: { n: openMarked.length, meanPl: r2(mean(openMarked.filter((o) => o.plPct != null).map((o) => o.plPct))), meanSpy: r2(mean(openMarked.filter((o) => o.spyPct != null).map((o) => o.spyPct))), rows: openMarked },
    portfolio: { from: book[0].d, to: book[book.length - 1].d, years: r2(yrs), pctDaysInvested: r2(100 * inv.length / book.length), avgOpenPositions: r2(mean(inv.map((b) => b.n))),
      book: { cagrPct: r2((pb.final ** (1 / yrs) - 1) * 100), maxDDPct: r2(pb.maxDD * 100), total: r2((pb.final - 1) * 100) }, spy: { cagrPct: r2((ps.final ** (1 / yrs) - 1) * 100), maxDDPct: r2(ps.maxDD * 100), total: r2((ps.final - 1) * 100) },
      beta: r2(beta), alphaAnnualPct: r2(alphaDaily * 252 * 100), alphaT: r2(alphaT),
      method: "equal weight across every position open that day, split-adjusted closes, close-to-close; flat (0%) on days with nothing open; no dividends on either side; no costs" },
    doesNotEstablish: "Fills a subscriber could get (the entry is his alert price), options results (excluded by the page), or anything before 2020. Transcription errors are possible; the price-reality check is what catches them.",
  };
  writeJsonAtomic(D("payne-record-audit.json"), out);
  console.log(JSON.stringify({ record: out.record, priceReality: { ...out.priceReality, examples: out.priceReality.examples.length }, perTrade: out.perTrade, byYear: out.byYear, open: { n: out.open.n, meanPl: out.open.meanPl, meanSpy: out.open.meanSpy }, portfolio: out.portfolio }, null, 1));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
