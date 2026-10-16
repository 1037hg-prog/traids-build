#!/usr/bin/env node
/**
 * TRAIDS — Congressional-Trade Kill-Test
 *
 * congress-trade-test.js showed big positive alpha vs SPY (6mo +12%, t 12). This tries to KILL it
 * with the three blades that usually do:
 *   1) GROWTH-MATCHED BENCHMARK — re-measure alpha vs QQQ (growth), not just SPY. Senators buy
 *      concentrated growth/tech; in 2019-2021 that beat SPY by default. If alpha vanishes vs QQQ,
 *      it was a factor tilt, not skill.
 *   2) DE-OVERLAP — the t=12 came from 1,000+ overlapping 6-12mo holds. Chunk entries into
 *      NON-overlapping cohorts and count how many INDEPENDENT periods actually exist.
 *   3) DROP THE MOONSHOTS — mean ≫ median said a few rockets carry it. Re-compute mean alpha after
 *      removing the top 5% winners, and show what share of total alpha the top 10 trades produced.
 *
 * Same free Senate data (2014-19) + Alpaca prices (~2018-19 usable). Prices cached to disk.
 *
 * Usage:  node backend/congress-killtest.js
 */
const fs = require("fs"), path = require("path");
function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
loadEnv();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
if (!KEY || !SEC) { console.error("\n  Missing ALPACA keys.\n"); process.exit(1); }
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };
const LAG = parseInt(process.env.LAG || "40"), COST_BPS = 5, FROM = "2018-06-01";
const SRC = "https://raw.githubusercontent.com/timothycarambat/senate-stock-watcher-data/master/aggregate/all_transactions.json";
const CACHE = path.join(__dirname, "data", "congress-prices.json");
const HOLDS = [["1mo", 21], ["3mo", 63], ["6mo", 126], ["12mo", 252]];

async function fetchBars(sym) { const start = "2018-01-01"; for (let a = 0; a < 4; a++) { const out = []; let tok = null, ok = true; do { const pr = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED }); if (tok) pr.set("page_token", tok); const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${pr}`, { headers }); if (r.status === 429) { await new Promise(z => setTimeout(z, 1500)); ok = false; break; } if (!r.ok) return out; const j = await r.json(); for (const b of (j.bars?.[sym] || [])) out.push({ d: (b.t || "").slice(0, 10), c: b.c }); tok = j.next_page_token || null; } while (tok); if (ok) return out; } return []; }
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const std = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mdy2iso = s => { const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };
const addDays = (iso, n) => new Date(new Date(iso + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);

(async () => {
  console.log(`\n  TRAIDS — Congressional-Trade KILL-TEST  ·  lag ${LAG}d · vs SPY & QQQ · de-overlapped · moonshot-stripped\n`);
  const all = await (await fetch(SRC)).json();
  const buys = all.filter(t => t.type === "Purchase" && t.asset_type === "Stock" && /^[A-Z]{1,5}$/.test(t.ticker || "") && mdy2iso(t.transaction_date) && mdy2iso(t.transaction_date) >= FROM).map(t => ({ ticker: t.ticker, txn: mdy2iso(t.transaction_date) }));
  const tickers = [...new Set([...buys.map(b => b.ticker), "SPY", "QQQ"])];

  let px = {};
  if (fs.existsSync(CACHE)) { px = JSON.parse(fs.readFileSync(CACHE, "utf8")); console.log(`  loaded ${Object.keys(px).length} cached price series`); }
  const need = tickers.filter(t => !px[t]);
  if (need.length) {
    console.log(`  fetching ${need.length} new tickers`); let i = 0;
    const store = (tk, bars) => { if (bars.length > 60) { const map = {}, dates = []; for (const b of bars) { map[b.d] = b.c; dates.push(b.d); } px[tk] = { map, dates }; } else px[tk] = null; };
    store("SPY", await fetchBars("SPY")); store("QQQ", await fetchBars("QQQ"));
    const worker = async () => { while (i < need.length) { const tk = need[i++]; if (px[tk] === undefined) store(tk, await fetchBars(tk)); if (i % 50 === 0) process.stdout.write("."); } };
    await Promise.all(Array.from({ length: 5 }, worker));
    fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(px));
    console.log(`\n  cached.`);
  }
  const okPx = t => px[t] && px[t].dates;
  if (!okPx("SPY") || !okPx("QQQ")) { console.error("  Missing SPY/QQQ.\n"); process.exit(1); }

  const onAfter = (tk, iso) => { const p = px[tk]; if (!p) return null; let lo = 0, hi = p.dates.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (p.dates[m] >= iso) { ans = m; hi = m - 1; } else lo = m + 1; } return ans < 0 ? null : { c: p.map[p.dates[ans]], i: ans, d: p.dates[ans] }; };
  const fwd = (tk, iso, H) => { const e = onAfter(tk, iso); if (!e || !okPx(tk)) return null; const p = px[tk]; if (e.i + H >= p.dates.length) return null; return { ret: p.map[p.dates[e.i + H]] / e.c - 1, entryD: e.d }; };

  // build per-trade records: entry date, alpha vs SPY, alpha vs QQQ, for each horizon
  const recs = {}; for (const [lbl] of HOLDS) recs[lbl] = [];
  for (const b of buys) {
    const entryISO = addDays(b.txn, LAG);
    for (const [lbl, H] of HOLDS) {
      const tr = fwd(b.ticker, entryISO, H); if (!tr) continue;
      const sp = fwd("SPY", tr.entryD, H), qq = fwd("QQQ", tr.entryD, H); if (!sp || !qq) continue;
      const net = tr.ret - COST_BPS * 2 / 10000;
      recs[lbl].push({ d: tr.entryD, aSPY: (net - sp.ret) * 100, aQQQ: (net - qq.ret) * 100 });
    }
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log("\n  BLADE 1 — alpha vs SPY (rigged) vs QQQ (growth-matched):");
  console.log("    " + pad("hold", 7) + pad("n", 7) + pad("α vs SPY", 11) + pad("α vs QQQ", 11) + pad("med αQQQ", 11) + "← if QQQ-alpha ~0, it was just growth beta");
  for (const [lbl] of HOLDS) { const r = recs[lbl]; if (r.length < 5) continue; console.log("    " + pad(lbl, 7) + pad(r.length, 7) + pad((mean(r.map(x => x.aSPY)) >= 0 ? "+" : "") + mean(r.map(x => x.aSPY)).toFixed(2) + "%", 11) + pad((mean(r.map(x => x.aQQQ)) >= 0 ? "+" : "") + mean(r.map(x => x.aQQQ)).toFixed(2) + "%", 11) + (median(r.map(x => x.aQQQ)) >= 0 ? "+" : "") + median(r.map(x => x.aQQQ)).toFixed(2) + "%"); }

  console.log("\n  BLADE 2 — DE-OVERLAP: how many INDEPENDENT periods actually exist?");
  console.log("    " + pad("hold", 7) + pad("indep cohorts", 16) + pad("mean αQQQ/cohort", 18) + "honest t");
  for (const [lbl, H] of HOLDS) {
    const r = recs[lbl]; if (!r.length) continue;
    const t0 = new Date(r[0].d).getTime();
    const blocks = {}; for (const x of r) { const k = Math.floor((new Date(x.d).getTime() - t0) / (H * 86400000)); (blocks[k] ||= []).push(x.aQQQ); }
    const cohorts = Object.values(blocks).map(b => mean(b)); const n = cohorts.length;
    const t = n >= 2 && std(cohorts) > 0 ? mean(cohorts) / (std(cohorts) / Math.sqrt(n)) : 0;
    console.log("    " + pad(lbl, 7) + pad(n + (n < 5 ? " (too few!)" : ""), 16) + pad((mean(cohorts) >= 0 ? "+" : "") + mean(cohorts).toFixed(2) + "%", 18) + (n < 3 ? "n/a" : (t >= 0 ? "+" : "") + t.toFixed(2)));
  }

  console.log("\n  BLADE 3 — DROP THE MOONSHOTS (vs QQQ):");
  console.log("    " + pad("hold", 7) + pad("mean αQQQ", 12) + pad("ex-top-5%", 12) + pad("top-10 share", 14) + "win% vs QQQ");
  for (const [lbl] of HOLDS) {
    const r = recs[lbl]; if (r.length < 20) continue;
    const sorted = [...r].map(x => x.aQQQ).sort((a, b) => b - a);
    const cut = Math.floor(sorted.length * 0.05);
    const trimmed = sorted.slice(cut);                          // drop top 5% winners
    const totalA = r.reduce((s, x) => s + x.aQQQ, 0);
    const top10 = sorted.slice(0, 10).reduce((s, v) => s + v, 0);
    const win = r.filter(x => x.aQQQ > 0).length / r.length * 100;
    console.log("    " + pad(lbl, 7) + pad((mean(sorted) >= 0 ? "+" : "") + mean(sorted).toFixed(2) + "%", 12) + pad((mean(trimmed) >= 0 ? "+" : "") + mean(trimmed).toFixed(2) + "%", 12) + pad(totalA ? (top10 / totalA * 100).toFixed(0) + "%" : "—", 14) + win.toFixed(0) + "%");
  }

  console.log(`\n  VERDICT: if (1) QQQ-alpha ≪ SPY-alpha, (2) independent cohorts are ~2-3, and (3) dropping the top`);
  console.log(`  5% collapses the mean — then the "edge" was growth-beta + a few moonshots + overlap-inflated t,`);
  console.log(`  not a real, followable information edge. Needs fresh 2020-26 data (incl. the 2022 growth crash)`);
  console.log(`  to test forward — this free dataset stops at 2019. NANC ETF (the live version) ~matches the market.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
