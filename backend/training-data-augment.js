#!/usr/bin/env node
/**
 * TRAINING DATA AUGMENT — put the board's ALTERNATIVE data into the historical training set.
 * 2026-08-28. Writes data/training/dataset-augmented.jsonl + data/training-augment-coverage.json.
 *
 * WHY.
 *
 * Test #39 trained a histogram GBDT on 150,316 episodes over 2021-2026 and returned NO-SKILL.
 * It was trained on NINETEEN features, every one a price/volume/macro technical — RSI, ADX,
 * momentum, ATR, distance from the 52-week high — on 977 liquid large caps. That verdict is
 * correct AND it is a verdict about technical analysis, not about what this system knows.
 *
 * feature-parity-audit.js (2026-08-28) measured the gap: the board stamps 81 distinct observers
 * and 68 of them have never been in that training file. Insider flow, options skew, short
 * interest, dark-pool share, news, earnings surprise and measured spread have never once been
 * shown to a five-year learner.
 *
 * This file starts closing that gap, insider flow first, because it has the strongest prior in
 * the literature and a genuine point-in-time timestamp.
 *
 * ═══ POINT-IN-TIME, WHICH IS THE ENTIRE DIFFICULTY ═══
 *
 * A Form 4 reports a TRANSACTION DATE and is filed up to two business days later. Joining on the
 * transaction date would hand the model information days before the market had it, and insider
 * studies die on exactly this. So:
 *
 *   The join key is filingDate, never the transaction date, and the comparison is STRICT (<).
 *   A filing dated the same session as the signal is EXCLUDED, because intraday filing time is
 *   unknown and "same day" is not the same as "before the entry".
 *
 * Only entries carrying BOTH sym and filingDate are usable — 9,405 of 33,764 in the cache. The
 * rest are counted and discarded rather than joined on an assumed lag.
 *
 * ═══ WHAT COUNTS AS CONVICTION ═══
 *
 * Transaction codes are not interchangeable. Only OPEN-MARKET trades carry a decision:
 *   P  open-market purchase   -> conviction, and the rare one (2,035 of 80,553 rows)
 *   S  open-market sale       -> weak signal; insiders sell for a hundred non-informative reasons
 * Everything else is compensation mechanics and is EXCLUDED, not netted:
 *   A award/grant · M option exercise · F tax withholding · G gift · C conversion · D disposition
 * Netting a grant against a purchase is how an insider dataset becomes noise.
 *
 * ═══ ABSENT IS NOT ZERO ═══
 *
 * A symbol-session with no insider filings in the window gets `null`, not 0. Zero means "insiders
 * did nothing", null means "we have no data here" — the cache covers 2026 almost entirely, so
 * writing 0 for 2021 would teach the model that nobody traded their own stock for five years.
 * Coverage is reported per year and the honest answer for most years is: none.
 *
 * Usage:  node backend/training-data-augment.js [--limit N] [--out <file>]
 * Output: data/training/dataset-augmented.jsonl  ·  data/training-augment-coverage.json
 */
const fs = require("fs"), path = require("path"), readline = require("readline");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const LIMIT = Number(arg("limit", 0)) || 0;
const IN = D(path.join("training", "dataset.jsonl"));
const OUT = arg("out", D(path.join("training", "dataset-augmented.jsonl")));

const WINDOW_DAYS = 90;
const CONVICTION = new Set(["P", "S"]);          // open-market only; see header
const dayMs = 864e5;
const dnum = (s) => Date.parse(s + "T00:00:00Z");

// ---------------------------------------------------------------------------------------------
// 1. Index the Form 4 cache by symbol, keyed on FILING date.
// ---------------------------------------------------------------------------------------------
console.log("indexing Form 4 cache...");
const cache = JSON.parse(fs.readFileSync(D("edgar-form4-cache.json"), "utf8"));
const bySym = new Map();
let usable = 0, noSym = 0, noFilingDate = 0, convictionRows = 0, excludedRows = 0;

for (const acc of Object.keys(cache)) {
  const e = cache[acc];
  if (!e || !Array.isArray(e.rows)) continue;
  if (!e.sym) { noSym++; continue; }
  if (!e.filingDate) { noFilingDate++; continue; }
  usable++;

  // Aggregate this filing into one event. One filing = one insider's decision, however many
  // broker fills it was split across; counting fills would let one large order look like a crowd.
  let buyUsd = 0, sellUsd = 0, buyShares = 0, sellShares = 0, anyBuy = false;
  for (const r of e.rows) {
    if (!r || !CONVICTION.has(r.code)) { excludedRows++; continue; }
    convictionRows++;
    const sh = Number(r.shares) || 0, px = Number(r.price) || 0;
    if (r.code === "P") { buyUsd += sh * px; buyShares += sh; anyBuy = true; }
    else { sellUsd += sh * px; sellShares += sh; }
  }
  if (!buyShares && !sellShares) continue;      // filing carried no open-market trade

  if (!bySym.has(e.sym)) bySym.set(e.sym, []);
  bySym.get(e.sym).push({
    t: dnum(e.filingDate), filingDate: e.filingDate,
    buyUsd, sellUsd, anyBuy,
    owner: e.owner || "?", officer: !!e.isOfficer, director: !!e.isDirector,
  });
}
for (const arr of bySym.values()) arr.sort((a, b) => a.t - b.t);
console.log(`  ${usable} usable filings over ${bySym.size} symbols · skipped ${noSym} without a symbol, ${noFilingDate} without a filing date`);
console.log(`  ${convictionRows} open-market rows kept (P/S) · ${excludedRows} compensation rows excluded (A/M/F/G/C/...)`);

const filingDates = [...bySym.values()].flat().map((x) => x.filingDate).sort();
const cacheFrom = filingDates[0], cacheTo = filingDates[filingDates.length - 1];
console.log(`  filing dates span ${cacheFrom} .. ${cacheTo}`);

/**
 * Insider features for one (symbol, as-of session), using only filings STRICTLY BEFORE it.
 * Returns null when the symbol has no filings at all in the cache — absent, not zero.
 */
function insiderAsOf(sym, dayStr) {
  const arr = bySym.get(sym);
  if (!arr || !arr.length) return null;
  const asOf = dnum(dayStr), from = asOf - WINDOW_DAYS * dayMs;
  // Outside the cache's own span we know nothing about this session; do not report a confident 0.
  if (asOf <= dnum(cacheFrom) || from > dnum(cacheTo)) return null;

  let buyUsd = 0, sellUsd = 0, filings = 0, officerBuys = 0;
  const buyers = new Set();
  for (const f of arr) {
    if (f.t >= asOf) break;                      // STRICT: same-day filings are not knowable
    if (f.t < from) continue;
    filings++; buyUsd += f.buyUsd; sellUsd += f.sellUsd;
    if (f.anyBuy) { buyers.add(f.owner); if (f.officer) officerBuys++; }
  }
  if (!filings) return { insBuyUsd90: 0, insSellUsd90: 0, insNetUsd90: 0, insBuyers90: 0, insOfficerBuys90: 0, insFilings90: 0, insNetRatio90: 0 };
  const denom = buyUsd + sellUsd;
  return {
    insBuyUsd90: Math.round(buyUsd), insSellUsd90: Math.round(sellUsd),
    insNetUsd90: Math.round(buyUsd - sellUsd),
    insBuyers90: buyers.size, insOfficerBuys90: officerBuys, insFilings90: filings,
    insNetRatio90: denom ? +((buyUsd - sellUsd) / denom).toFixed(4) : 0,
  };
}

// ---------------------------------------------------------------------------------------------
// 2. Stream the dataset and join. 732 MB — readFileSync throws ERR_STRING_TOO_LONG.
// ---------------------------------------------------------------------------------------------
const NEW_FEATS = ["insBuyUsd90", "insSellUsd90", "insNetUsd90", "insBuyers90", "insOfficerBuys90", "insFilings90", "insNetRatio90"];
const byYear = new Map();
let rows = 0, joined = 0, symMiss = 0, outOfSpan = 0;

const out = fs.createWriteStream(OUT);
const rl = readline.createInterface({ input: fs.createReadStream(IN), crlfDelay: Infinity });

console.log("streaming dataset...");
rl.on("line", (line) => {
  if (!line) return;
  if (LIMIT && rows >= LIMIT) return;
  let r; try { r = JSON.parse(line); } catch { return; }
  rows++;
  const yr = (r.date || "").slice(0, 4);
  if (!byYear.has(yr)) byYear.set(yr, { rows: 0, joined: 0, withBuy: 0 });
  const y = byYear.get(yr); y.rows++;

  const ins = (r.sym && r.date) ? insiderAsOf(r.sym, r.date) : null;
  if (ins) { joined++; y.joined++; if (ins.insBuyUsd90 > 0) y.withBuy++; }
  else if (!bySym.has(r.sym)) symMiss++; else outOfSpan++;

  // null, never 0, when unknown — see header
  for (const k of NEW_FEATS) r.f[k] = ins ? ins[k] : null;
  out.write(JSON.stringify(r) + "\n");
  if (rows % 100000 === 0) console.log(`  ${rows.toLocaleString()} rows · ${joined.toLocaleString()} joined`);
});

rl.on("close", () => {
  out.end();
  const years = [...byYear.entries()].sort().map(([year, v]) => ({
    year, rows: v.rows, joined: v.joined,
    joinedPct: +(100 * v.joined / v.rows).toFixed(1),
    rowsWithInsiderBuying: v.withBuy,
  }));

  const report = {
    spec: "training-data-augment-v1", builtAt: new Date().toISOString(),
    source: { dataset: "data/training/dataset.jsonl", insider: "data/edgar-form4-cache.json" },
    pointInTime: "Joined on Form 4 filingDate with a STRICT less-than against the signal session. Transaction dates are never used — a Form 4 is filed up to two business days after the trade, and joining on the transaction date is the look-ahead that kills insider studies.",
    convictionCodes: "P (open-market purchase) and S (open-market sale) only. A/M/F/G/C/D and the rest are compensation mechanics and are excluded rather than netted.",
    absentIsNull: "A session outside the cache's filing span, or a symbol with no filings at all, gets null - NOT 0. Zero means insiders did nothing; null means we do not know. The cache is almost entirely 2026, so writing 0 for 2021 would teach the model that nobody traded their own stock for five years.",
    cacheSpan: { from: cacheFrom, to: cacheTo, usableFilings: usable, symbols: bySym.size,
      skippedNoSymbol: noSym, skippedNoFilingDate: noFilingDate,
      openMarketRowsKept: convictionRows, compensationRowsExcluded: excludedRows },
    featuresAdded: NEW_FEATS,
    totals: { rows, joined, joinedPct: +(100 * joined / rows).toFixed(1), symbolNotInCache: symMiss, outsideCacheSpan: outOfSpan },
    byYear: years,
    honestRead: "Insider coverage is a 2026 phenomenon in this cache. Any model trained on these features is a 2026 model on the joined subset, not a five-year model. That subset is still the first time this shop has shown a learner anything other than price and volume.",
    out: OUT,
  };
  writeJsonAtomic(D("training-augment-coverage.json"), report);

  console.log("\nCOVERAGE BY YEAR");
  console.log("  year     rows    joined   joined%   rows with insider BUYING");
  for (const y of years) console.log(`  ${y.year}${String(y.rows).padStart(9)}${String(y.joined).padStart(10)}${String(y.joinedPct).padStart(9)}%${String(y.rowsWithInsiderBuying).padStart(23)}`);
  console.log(`\n  total ${rows.toLocaleString()} rows · ${joined.toLocaleString()} joined (${report.totals.joinedPct}%)`);
  console.log(`  ${symMiss.toLocaleString()} rows whose symbol is not in the cache · ${outOfSpan.toLocaleString()} outside the cache's filing span`);
  console.log(`\nwritten: ${OUT}`);
  console.log("written: data/training-augment-coverage.json");
});
