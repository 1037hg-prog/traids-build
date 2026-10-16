#!/usr/bin/env node
/**
 * R280 — Oil-shock timing (Driesprong, Jacobsen & Maat 2008), out of sample 2004-01..2026-08. Registered 2026-09-28 in
 * backend/register-r276-r280.js (the registry wins).
 *   Holding month m+1 = T-bills if WTI's month-m change > +10%, else SPY. 5 bps per side on each switch.
 *   Statistic: monthly active return (strategy - SPY), one-sample t; bar 1.648 (single rule). Control: 1,000 circular shifts of
 *   the in/out sequence (PASS needs mean active > shift p95).
 *
 *   node backend/r280-oil-timing.js --selftest   known answer: a never-out rule must give active = 0 exactly
 *   node backend/r280-oil-timing.js --read       the one registered read (refuses if sealed)
 *
 * NOTES (fixed before any outcome): N1 SPY monthly dividend-adjusted close from the local Yahoo feed (:3002, 1mo)
 * — amended 2026-09-28 pre-evidence from AV, whose daily limit was spent. N2 WTI = FRED DCOILWTICO (cached in data/training/fred). N3 cash = FRED DTB3 mean of the holding
 * month /1200. N4 month keys YYYY-MM; the oil signal for holding month m+1 uses only month-m data.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), FRED = D("training/fred"), OUT = D("r280-oil-timing.json");
const BAR = 1.648, FIRST = "2004-01", LAST = "2026-08", THRESH = 0.10, COST_SIDE = 0.0005, DRAWS = 1000;
const mode = ["--selftest", "--read"].find((m) => process.argv.includes(m)) || "--selftest";
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
const prevYm = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };

async function fred(id) {
  fs.mkdirSync(FRED, { recursive: true }); const f = path.join(FRED, id + ".csv");
  if (!fs.existsSync(f)) { const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(`${id} HTTP ${r.status}`); fs.writeFileSync(f, await r.text()); }
  return fs.readFileSync(f, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(",")).filter(([, v]) => v && v !== ".").map(([d, v]) => [d, +v]);
}

async function load() {
  const wti = await fred("DCOILWTICO"), tb = await fred("DTB3");
  const oilEnd = {}; for (const [d, v] of wti) oilEnd[d.slice(0, 7)] = v;                       // last valid obs of each month
  const tbm = {}; for (const [d, v] of tb) (tbm[d.slice(0, 7)] = tbm[d.slice(0, 7)] || []).push(v);
  const rf = Object.fromEntries(Object.entries(tbm).map(([k, a]) => [k, mean(a) / 1200]));
  // amended 2026-09-28 pre-evidence: Yahoo 1mo adjClose via :3002 (AV daily limit)
  const j = await (await fetch("http://localhost:3002/api/yahoo/SPY/history?days=8500&interval=1mo", { signal: AbortSignal.timeout(60000) })).json();
  const spyEnd = {}; for (const b of j.bars || []) if (b.adjClose > 0) spyEnd[b.date.slice(0, 7)] = b.adjClose;
  delete spyEnd[new Date().toISOString().slice(0, 7)];   // the current (unfinished) month is never used
  const rows = []; let ym = FIRST;
  while (ym <= LAST) {
    const p = prevYm(ym), pp = prevYm(p);
    if (spyEnd[ym] && spyEnd[p] && oilEnd[p] && oilEnd[pp] && rf[ym] != null) rows.push({ ym, spy: spyEnd[ym] / spyEnd[p] - 1, rf: rf[ym], oilChg: oilEnd[p] / oilEnd[pp] - 1 });
    const [y, m] = ym.split("-").map(Number); ym = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  }
  return rows;
}

function grade(rows, outs) {
  const strat = [], act = []; let prev = false;
  for (let i = 0; i < rows.length; i++) { const out = outs[i]; let x = out ? rows[i].rf : rows[i].spy; if (out !== prev) x -= 2 * COST_SIDE; prev = out; strat.push(x); act.push(x - rows[i].spy); }
  return { strat, act };
}
const stats = (r) => { let v = 1, pk = 1, dd = 0; for (const x of r) { v *= 1 + x; pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); } return { cagrPct: +(100 * (v ** (12 / r.length) - 1)).toFixed(2), maxDDPct: +(100 * dd).toFixed(1), sharpe: +((mean(r) / sd(r)) * Math.sqrt(12)).toFixed(2) }; };

(async () => {
  const rows = await load();
  if (mode === "--selftest") {
    const g = grade(rows, rows.map(() => false)); const maxAbs = Math.max(...g.act.map(Math.abs));
    console.log(`selftest: ${rows.length} months ${rows[0].ym}..${rows.at(-1).ym}; never-out max |active| = ${maxAbs} (${maxAbs < 1e-12 ? "OK" : "FAIL"})`);
    process.exit(maxAbs < 1e-12 ? 0 : 1);
  }
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests.R280) throw new Error("R280 already sealed — read-once");
  const outs = rows.map((r) => r.oilChg > THRESH), g = grade(rows, outs), m = mean(g.act), t = tOf(g.act);
  let seed = 280280; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648); const n = rows.length, sh = [];
  for (let k = 0; k < DRAWS; k++) { const off = 1 + Math.floor(rnd() * (n - 1)); sh.push(mean(grade(rows, outs.map((_, i) => outs[(i + off) % n])).act)); }
  sh.sort((a, b) => a - b); const p95 = sh[Math.floor(0.95 * DRAWS)];
  // predictive regression (secondary): next-month SPY excess on oil change
  const x = rows.map((r) => r.oilChg), y = rows.map((r) => r.spy - r.rf), mx = mean(x), my = mean(y);
  const b = x.reduce((s, xi, i) => s + (xi - mx) * (y[i] - my), 0) / x.reduce((s, xi) => s + (xi - mx) ** 2, 0);
  const res = y.map((yi, i) => yi - my - b * (x[i] - mx)), se = Math.sqrt(res.reduce((s, e) => s + e * e, 0) / (n - 2) / x.reduce((s, xi) => s + (xi - mx) ** 2, 0));
  const outMonths = rows.filter((_, i) => outs[i]);
  const pass = t >= BAR && m > p95;
  const verdict = `${pass ? "PASSED" : "DID NOT PASS"} — oil>+10% => T-bills: active ${(100 * m).toFixed(3)}%/mo t ${t.toFixed(3)} vs bar ${BAR} over ${n} months (${outMonths.length} out); shift p95 ${(100 * p95).toFixed(3)}%/mo; regression slope ${b.toFixed(3)} t ${(b / se).toFixed(2)}`;
  const out = { test: "R280", readAt: new Date().toISOString(), verdict, bar: BAR, months: n, outMonths: outMonths.length,
    activeMonthlyPct: +(100 * m).toFixed(3), t: +t.toFixed(3), shiftP95MonthlyPct: +(100 * p95).toFixed(3),
    spyAfterOutMonthsMeanPct: +(100 * mean(outMonths.map((r) => r.spy))).toFixed(3), spyAllMonthsMeanPct: +(100 * mean(rows.map((r) => r.spy))).toFixed(3),
    regression: { slope: +b.toFixed(4), t: +(b / se).toFixed(3), note: "next-month SPY excess on month oil change; paper predicts negative" },
    strategy: stats(g.strat), spyBuyHold: stats(rows.map((r) => r.spy)), outList: outMonths.map((r) => ({ ym: r.ym, oilChgPct: +(100 * r.oilChg).toFixed(1), spyPct: +(100 * r.spy).toFixed(2) })) };
  writeJsonAtomic(OUT, out);
  seals.tests = seals.tests || {}; seals.tests.R280 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "months, one-sample t on active return vs SPY; single-rule bar", verdict, output: "data/r280-oil-timing.json" };
  writeJsonAtomic(D("read-seals.json"), seals);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", tests: ["R280"], detail: verdict }) + "\n");
  console.log(verdict); console.log(JSON.stringify({ strategy: out.strategy, spy: out.spyBuyHold, spyAfterOut: out.spyAfterOutMonthsMeanPct, spyAll: out.spyAllMonthsMeanPct }));
})().catch((e) => { console.error("R280 FAILED:", e.message); process.exit(1); });
