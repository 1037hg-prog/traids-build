#!/usr/bin/env node
/**
 * OPTION-INCOME ETFs AS A NATURAL EXPERIMENT — 2026-08-03.
 * Operator raised SPYI / JEPI / JEPQ / QYLD / SPYT and asked about trading options off them.
 *
 * THE FRAMING THAT MAKES THIS CHEAP AND DECISIVE. Our registry says the variance risk premium
 * EXISTS (#24, PREMIUM) but that it is harvestable BY US is NOT-ESTABLISHED three separate
 * times (#41, #42, #43). Rather than build a fourth attempt, note what these ETFs are: the
 * productised, professionally-executed version of precisely that trade. They sell index calls
 * systematically, at institutional scale, with execution far better than a retail account will
 * ever get, and they have years of live track record.
 *
 * So: if THEY cannot beat simply holding the index net of their fees, a retail replication with
 * worse fills has no path. That is a free, well-powered natural experiment on the exact question
 * #41-#43 left open — and it costs one data pull instead of a build.
 *
 * TOTAL RETURN, not price return. These funds distribute heavily; comparing price charts would
 * be straightforwardly wrong. adjustment=all gives split- and dividend-adjusted series.
 * Each fund is compared to its own benchmark over ITS OWN common window, never a shared one.
 *
 * NOT ADVICE. This is a measurement of historical fund behaviour for research purposes.
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const D = (f) => path.join(__dirname, "data", f);
const AH = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
const nap = (ms) => new Promise(r => setTimeout(r, ms));

const FUNDS = [
  { sym: "QYLD", bench: "QQQ", note: "ATM Nasdaq covered calls — the most aggressive upside cap" },
  { sym: "JEPI", bench: "SPY", note: "defensive equity + ELN call overwrite" },
  { sym: "JEPQ", bench: "QQQ", note: "Nasdaq version of JEPI" },
  { sym: "SPYI", bench: "SPY", note: "NEOS, index options for 1256 tax treatment" },
  { sym: "SPYT", bench: "SPY", note: "high-frequency S&P call spreads" },
];

const bars = {};
async function fetchBars(list) {
  for (const s of list) {
    let token = null;
    do {
      const p = new URLSearchParams({ symbols: s, timeframe: "1Day", start: "2013-01-01", end: "2026-08-01", limit: "10000", feed: "iex", adjustment: "all" });
      if (token) p.set("page_token", token);
      try {
        const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${p}`, { headers: AH, signal: AbortSignal.timeout(60000) });
        if (!r.ok) break;
        const j = await r.json();
        for (const [k, v] of Object.entries(j.bars || {})) bars[k] = (bars[k] || []).concat(v);
        token = j.next_page_token || null;
      } catch { break; }
      await nap(300);
    } while (token);
  }
}

const ann = (r, yrs) => (Math.pow(1 + r, 1 / yrs) - 1) * 100;
function series(sym) { const b = bars[sym] || []; return new Map(b.map(x => [String(x.t).slice(0, 10), x.c])); }
function maxDD(vals) { let peak = -Infinity, dd = 0; for (const v of vals) { if (v > peak) peak = v; dd = Math.min(dd, v / peak - 1); } return dd * 100; }

(async () => {
  await fetchBars([...new Set([...FUNDS.map(f => f.sym), "SPY", "QQQ"])]);
  console.log(`OPTION-INCOME ETFs vs SIMPLY HOLDING THE INDEX — total return, each over its own live history\n`);
  console.log(`  fund  bench   from        yrs   fund CAGR   bench CAGR      GAP    fund maxDD  bench maxDD   fund vol  beta`);
  const out = [];
  for (const f of FUNDS) {
    const F = series(f.sym), B = series(f.bench);
    const days = [...F.keys()].filter(d => B.has(d)).sort();
    if (days.length < 250) { console.log(`  ${f.sym.padEnd(5)} — insufficient history (${days.length} days)`); continue; }
    const fv = days.map(d => F.get(d)), bv = days.map(d => B.get(d));
    const yrs = days.length / 252;
    const fr = fv[fv.length - 1] / fv[0] - 1, br = bv[bv.length - 1] / bv[0] - 1;
    const fA = ann(fr, yrs), bA = ann(br, yrs);
    // daily returns for vol + beta
    const fd = [], bd = [];
    for (let i = 1; i < days.length; i++) { fd.push(fv[i] / fv[i - 1] - 1); bd.push(bv[i] / bv[i - 1] - 1); }
    const mf = fd.reduce((s, x) => s + x, 0) / fd.length, mb = bd.reduce((s, x) => s + x, 0) / bd.length;
    const vol = Math.sqrt(fd.reduce((s, x) => s + (x - mf) ** 2, 0) / (fd.length - 1)) * Math.sqrt(252) * 100;
    const cov = fd.reduce((s, x, i) => s + (x - mf) * (bd[i] - mb), 0) / (fd.length - 1);
    const varb = bd.reduce((s, x) => s + (x - mb) ** 2, 0) / (bd.length - 1);
    const beta = cov / varb;
    console.log(`  ${f.sym.padEnd(5)} ${f.bench.padEnd(6)} ${days[0]}  ${yrs.toFixed(1).padStart(4)}   ${fA.toFixed(2).padStart(8)}%  ${bA.toFixed(2).padStart(9)}%  ${((fA - bA) >= 0 ? "+" : "") + (fA - bA).toFixed(2).padStart(7)}%   ${maxDD(fv).toFixed(1).padStart(8)}%  ${maxDD(bv).toFixed(1).padStart(9)}%   ${vol.toFixed(1).padStart(7)}%  ${beta.toFixed(2)}`);
    out.push({ sym: f.sym, bench: f.bench, from: days[0], yrs: +yrs.toFixed(2), fundCagr: +fA.toFixed(2), benchCagr: +bA.toFixed(2), gap: +(fA - bA).toFixed(2), fundMaxDD: +maxDD(fv).toFixed(1), benchMaxDD: +maxDD(bv).toFixed(1), vol: +vol.toFixed(1), beta: +beta.toFixed(2), note: f.note });
  }
  const beat = out.filter(o => o.gap > 0);
  console.log(`\n  ${beat.length} of ${out.length} beat simply holding the index on total return.`);
  console.log(`  Mean gap: ${(out.reduce((s, o) => s + o.gap, 0) / out.length).toFixed(2)}% per year.`);
  console.log(`\n  WHAT THIS SETTLES: registry #41/#42/#43 all asked whether the variance risk premium is`);
  console.log(`  HARVESTABLE by us and came back NOT-ESTABLISHED. These funds run that exact trade at`);
  console.log(`  institutional scale with execution we cannot match. Their record is the ceiling on a`);
  console.log(`  retail replication, not a floor.`);
  console.log(`\n  Drawdown note: covered calls cap upside but do NOT remove downside — check the maxDD`);
  console.log(`  columns. If a fund's drawdown matches the index while its CAGR trails, the option`);
  console.log(`  overlay sacrificed return without buying protection.`);
  console.log(`\n  NOT ADVICE — historical fund behaviour, measured for research.`);
  fs.writeFileSync(D("option-income-etfs.json"), JSON.stringify({ ranAt: new Date().toISOString(), funds: out }, null, 1));
  console.log(`\nwritten: option-income-etfs.json`);
})();
