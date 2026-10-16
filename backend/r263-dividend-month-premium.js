#!/usr/bin/env node
/**
 * R263 — DIVIDEND MONTH PREMIUM (Hartzmark & Solomon 2013): among REGULAR dividend payers, does a
 * stock earn a higher return in a calendar month it is PREDICTED to pay a dividend (based on its
 * own cadence over the prior two full years) than in a month it is not — a monthly, dollar-neutral,
 * cross-sectional spread WITHIN the regular-payer population, so both legs share the "is a dividend
 * stock" characteristic and only the MONTH-PHASE differs. edge-hunter agent, 2026-09-25, operator:
 * "keep mining."
 *
 * COUNTERPARTY (structural-register.json admission rule).
 *   WHO: income-mandated investors (retirees, dividend-income funds, dividend-clientele retail)
 *   who specifically want the cash-flow event itself and concentrate buying/holding into a stock's
 *   own known payment month, versus tax-indifferent or total-return-indifferent sellers/short-term
 *   holders on the other side who realize an economically identical total return regardless of
 *   which month it lands in and are willing to sell into that demand without repricing for it.
 *   WHY THEY ACCEPT A WORSE PRICE: Hartzmark & Solomon's own explanation is mental accounting —
 *   many investors treat "dividend income" as a different mental category from "capital gains" and
 *   prefer receiving cash on a predictable schedule, which concentrates demand (and price pressure)
 *   into the payment month itself rather than spreading it evenly across the year the way a
 *   frictionless total-return investor would.
 *   WHAT WOULD STOP IT: published in 2013, and the rule needs no special data — any long-only or
 *   long/short desk can trivially rotate into predicted-payer names each month. If that has
 *   happened, a full-modern-sample read should show the spread decayed toward zero.
 *
 * RULE (frozen, single variant — nothing searched):
 *   Universe: the 80 names cached in data/r147-earnings (pre-existing, built for R147, not chosen
 *     for this hypothesis) + SPY as the market benchmark. Yahoo Finance chart() with events='div',
 *     2000-01-01..yesterday, both price (adjClose, total-return) and dividend ex-dates in one call.
 *   Monthly return: monthEndClose(sym, month M) / monthEndClose(sym, month M-1) - 1, using the
 *     close on the LAST available trading day of each calendar month (adjClose, dividend/split
 *     adjusted). excessRet(sym, M) = stockRet - SPYret over the identical month.
 *   CADENCE CLASSIFICATION (point-in-time, refreshed once per calendar year Y, using ONLY
 *     dividend ex-dates from years Y-2 and Y-1 — never year Y or later): monthsY2 = the set of
 *     calendar months (1-12) with >=1 ex-dividend in year Y-2; monthsY1 = same for year Y-1. If
 *     monthsY2 and monthsY1 are IDENTICAL and non-empty, the stock is a REGULAR PAYER for the
 *     whole of year Y with cadenceMonths = that set. Otherwise the stock does not qualify for any
 *     month of year Y (excluded from both legs).
 *   Monthly cross-section (only among year-Y regular payers): PREDICTED if the evaluation month's
 *     calendar month number is in cadenceMonths; NON-PREDICTED otherwise (same regular-payer
 *     population, opposite month-phase — this is the control leg, not "any non-payer").
 *   Spread(M) = mean(excessRet | predicted, M) - mean(excessRet | non-predicted, M), for months
 *     where both groups are non-empty. COST: 20bps/month flat (10bps round trip on each of the two
 *     monthly-rebalanced legs) subtracted from Spread(M).
 *
 * STATISTIC. Clustering unit = CALENDAR MONTH (YYYY-MM) — every stock's month enters the SAME
 *   monthly cluster, so N = number of distinct months with a usable cross-section, not
 *   stock-months. t across months on the cost-adjusted Spread(M) series. Single pre-specified
 *   variant (no search over the trailing-years window, the cadence-match rule, or the cost).
 *
 *   node backend/r263-dividend-month-premium.js --dry       Fetches dividend dates + price only to
 *                                                            COUNT regular-payer-years and usable
 *                                                            cross-section months — no spread or
 *                                                            return statistic computed.
 *   node backend/r263-dividend-month-premium.js --collect   Computes and writes the monthly
 *                                                            per-stock rows (return, group label).
 *   node backend/r263-dividend-month-premium.js --read      The one registered read (refuses unless
 *                                                            R263 is registered).
 */
"use strict";
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic, writeTextAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const EARN = D("r147-earnings"), CACHE = D("r263-price-div-cache"), OBS = D("r263-obs.jsonl"), OUT = D("r263-dividend-month-premium.json"), DRYOUT = D("r263-dry-count.json");
const args = process.argv.slice(2);

const FETCH_FROM = "2000-01-01";
const EVAL_START_YEAR = 2002; // first year with 2 full trailing years of dividend data available
const COST = 0.0020; // 20bps/month flat: 10bps round trip on each of two monthly-rebalanced legs

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length >= 3 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

function endYesterdayET() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(Date.now() - 864e5)); }

async function fetchOne(yf, sym) {
  const f = path.join(CACHE, sym + ".json");
  if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch {} }
  let r = null;
  for (let attempt = 0; attempt < 3 && !r; attempt++) {
    try { r = await yf.chart(sym, { period1: FETCH_FROM, period2: endYesterdayET(), interval: "1d", events: "div" }); }
    catch (e) { r = null; await nap(800 * (attempt + 1)); }
  }
  if (!r) return null;
  const quotes = (r.quotes || []).filter((q) => q && (q.adjclose != null || q.close != null))
    .map((q) => ({ d: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), c: (q.adjclose ?? q.close) }));
  const divs = ((r.events && r.events.dividends) || []).map((e) => ({ d: (e.date instanceof Date ? e.date : new Date(e.date)).toISOString().slice(0, 10), amount: e.amount }));
  const out = { sym, quotes, divs };
  fs.mkdirSync(CACHE, { recursive: true });
  writeJsonAtomic(f, out);
  return out;
}

/** Last-trading-day-of-month close map: "YYYY-MM" -> close. */
function monthEndCloses(quotes) {
  const m = new Map();
  for (const q of quotes) m.set(q.d.slice(0, 7), q.c); // later dates overwrite earlier within a sorted-ascending series
  return m;
}
/** Calendar months (1-12) with >=1 dividend ex-date in a given year. */
function divMonthsInYear(divs, year) {
  const s = new Set();
  for (const dv of divs) if (dv.d.slice(0, 4) === String(year)) s.add(+dv.d.slice(5, 7));
  return s;
}
function sameSet(a, b) { if (a.size !== b.size || a.size === 0) return false; for (const x of a) if (!b.has(x)) return false; return true; }
function prevMonthKey(k) { const [y, m] = k.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; }

async function loadAll(quiet) {
  const files = fs.readdirSync(EARN).filter((f) => f.endsWith(".json"));
  const syms = files.map((f) => f.replace(/\.json$/, ""));
  const Y = require("yahoo-finance2").default ?? require("yahoo-finance2");
  const yf = (typeof Y === "function") ? new Y() : Y;
  try { if (typeof Y.suppressNotices === "function") Y.suppressNotices(["yahooSurvey", "ripHistorical"]); } catch {}
  try { if (typeof yf.suppressNotices === "function") yf.suppressNotices(["yahooSurvey", "ripHistorical"]); } catch {}
  const all = {};
  const list = [...syms, "SPY"];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const d = await fetchOne(yf, s);
    if (d) all[s] = d; else if (!quiet) console.warn(`  [yahoo] ${s} failed`);
    if (!quiet && (i + 1) % 10 === 0) console.log(`  ${i + 1}/${list.length} fetched (cache-or-network)...`);
    await nap(150);
  }
  return all;
}

(async () => {
  if (args.includes("--dry")) {
    console.log("R263 --dry: fetching dividend dates + price (cached after first run) to count eligibility only...");
    const all = await loadAll(false);
    const spy = all.SPY;
    if (!spy) throw new Error("SPY fetch failed — cannot proceed even for a dry count");
    const syms = Object.keys(all).filter((s) => s !== "SPY");
    const years = []; for (let y = EVAL_START_YEAR; y <= new Date().getUTCFullYear(); y++) years.push(y);
    let regularPayerYears = 0;
    const byMonth = new Map(); // "YYYY-MM" -> { predicted:Set, nonPredicted:Set }
    for (const sym of syms) {
      const divs = all[sym].divs;
      for (const y of years) {
        const m2 = divMonthsInYear(divs, y - 2), m1 = divMonthsInYear(divs, y - 1);
        if (!sameSet(m2, m1)) continue;
        regularPayerYears++;
        for (let mo = 1; mo <= 12; mo++) {
          const k = `${y}-${String(mo).padStart(2, "0")}`;
          if (k > endYesterdayET().slice(0, 7)) continue;
          const e = byMonth.get(k) || { predicted: new Set(), nonPredicted: new Set() };
          (m1.has(mo) ? e.predicted : e.nonPredicted).add(sym);
          byMonth.set(k, e);
        }
      }
    }
    const usableMonths = [...byMonth.values()].filter((e) => e.predicted.size > 0 && e.nonPredicted.size > 0).length;
    console.log(`R263 --dry: ${syms.length} names + SPY loaded. ${regularPayerYears} (name, year) regular-payer classifications, ${EVAL_START_YEAR}..${new Date().getUTCFullYear()}.`);
    console.log(`  usable cross-section months (both predicted and non-predicted non-empty): ${usableMonths} of ${byMonth.size} candidate months.`);
    console.log("  no return or spread computed yet; this is a feasibility/N count only.");
    writeJsonAtomic(DRYOUT, { spec: "r263-dry-v1", asOf: new Date().toISOString(), names: syms.length, regularPayerYearClassifications: regularPayerYears, candidateMonths: byMonth.size, usableMonths });
    return;
  }

  if (args.includes("--collect")) {
    console.log("R263 --collect: loading price+dividend data (cached after first run)...");
    const all = await loadAll(false);
    const spy = all.SPY;
    if (!spy) throw new Error("SPY fetch failed");
    const spyME = monthEndCloses(spy.quotes);
    const syms = Object.keys(all).filter((s) => s !== "SPY");
    const years = []; for (let y = EVAL_START_YEAR; y <= new Date().getUTCFullYear(); y++) years.push(y);
    const rows = [];
    for (const sym of syms) {
      const divs = all[sym].divs, me = monthEndCloses(all[sym].quotes);
      for (const y of years) {
        const m2 = divMonthsInYear(divs, y - 2), m1 = divMonthsInYear(divs, y - 1);
        if (!sameSet(m2, m1)) continue;
        for (let mo = 1; mo <= 12; mo++) {
          const k = `${y}-${String(mo).padStart(2, "0")}`;
          if (k > endYesterdayET().slice(0, 7)) continue;
          const pk = prevMonthKey(k);
          const c1 = me.get(k), c0 = me.get(pk), s1 = spyME.get(k), s0 = spyME.get(pk);
          if (!(c1 > 0) || !(c0 > 0) || !(s1 > 0) || !(s0 > 0)) continue; // dropped and implicitly counted (not written)
          const stockRet = c1 / c0 - 1, spyRet = s1 / s0 - 1;
          rows.push({ sym, month: k, group: m1.has(mo) ? "predicted" : "nonPredicted", excessRet: +(stockRet - spyRet).toFixed(6) });
        }
      }
    }
    writeTextAtomic(OBS, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`R263 --collect done: ${rows.length} stock-month rows written to ${OBS}`);
    return;
  }

  // ---- --read ----
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
  const R = [...(reg.tests || []), ...(reg.preregistered || [])].find((t) => t.id === "R263");
  if (!R) { console.error("R263 is not registered — refusing."); process.exit(2); }
  if (!fs.existsSync(OBS)) { console.error("no observations — run --collect first"); process.exit(2); }
  const rows = fs.readFileSync(OBS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  const byMonth = new Map();
  for (const r of rows) { const e = byMonth.get(r.month) || { predicted: [], nonPredicted: [] }; e[r.group].push(r.excessRet); byMonth.set(r.month, e); }
  const months = [...byMonth.keys()].sort();
  const perMonth = [];
  for (const k of months) {
    const e = byMonth.get(k);
    if (!e.predicted.length || !e.nonPredicted.length) continue;
    perMonth.push({ month: k, predictedMean: mean(e.predicted), nonPredictedMean: mean(e.nonPredicted), nPred: e.predicted.length, nNon: e.nonPredicted.length, spreadRaw: mean(e.predicted) - mean(e.nonPredicted) });
  }
  const spreadNet = perMonth.map((m) => m.spreadRaw - COST);
  const h = Math.floor(spreadNet.length / 2);
  const halves = spreadNet.length ? { first: +mean(spreadNet.slice(0, h)).toFixed(5), second: +mean(spreadNet.slice(h)).toFixed(5) } : null;

  const out = {
    spec: "r263-dividend-month-premium-v1", test: "R263", asOf: new Date().toISOString(), from: `${EVAL_START_YEAR}-01`, to: endYesterdayET().slice(0, 7),
    monthsWithCrossSection: perMonth.length, totalStockMonths: rows.length,
    rawSpread: { meanPerMonth: perMonth.length ? +mean(perMonth.map((m) => m.spreadRaw)).toFixed(5) : null, t: tOf(perMonth.map((m) => m.spreadRaw)) },
    netSpread: { meanPerMonth: spreadNet.length ? +mean(spreadNet).toFixed(5) : null, t: tOf(spreadNet) == null ? null : +tOf(spreadNet).toFixed(3), halves },
  };

  if (args.includes("--read")) {
    const BAR = R.bar.tRequired, MIN = R.bar.minMonths;
    const n = out.netSpread, signAgree = halves && Math.sign(halves.first) === Math.sign(halves.second);
    const pass = perMonth.length >= MIN && n.t != null && n.t >= BAR && n.meanPerMonth > 0 && signAgree;
    out.read = true;
    out.verdict = pass
      ? `PASS — mean spread ${(n.meanPerMonth * 100).toFixed(3)}%/month net of 20bps (t ${n.t}), ${perMonth.length} months, halves same sign (${JSON.stringify(halves)})`
      : `DID NOT PASS — mean spread ${(n.meanPerMonth * 100).toFixed(3)}%/month net of 20bps (t ${n.t}) vs bar ${BAR}; ${perMonth.length} months; halves ${signAgree ? "agree" : "DISAGREE"} (${JSON.stringify(halves)})`;
  }

  writeJsonAtomic(OUT, out);
  console.log(`R263 ${args.includes("--read") ? "READ" : "preview"} — ${perMonth.length} usable cross-section months, ${rows.length} stock-month rows`);
  console.log(`  raw spread: mean ${(out.rawSpread.meanPerMonth * 100).toFixed(3)}%/month, t ${out.rawSpread.t == null ? null : out.rawSpread.t.toFixed(3)}`);
  console.log(`  net spread (20bps): mean ${(out.netSpread.meanPerMonth * 100).toFixed(3)}%/month, t ${out.netSpread.t}, halves ${JSON.stringify(out.netSpread.halves)}`);
  if (out.verdict) console.log("VERDICT:", out.verdict);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
