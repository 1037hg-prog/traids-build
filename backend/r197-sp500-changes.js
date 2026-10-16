#!/usr/bin/env node
/**
 * R197 — S&P 500 INDEX CHANGES: POST-EFFECTIVE REVERSAL. Registered 2026-09-24 (family FLOWS-4, best-of-4 bar) BEFORE this file
 * existed; rule, statistic, bar, controls and decision rule are frozen in data/test-registry.json (preregistered[id=R197]) and the
 * bar is read from there at run time.
 *
 *   node backend/r197-sp500-changes.js --coverage   parse + fetch/cache prices + resolve event dates; prints coverage only (no returns)
 *   node backend/r197-sp500-changes.js              the ONE read -> data/r197-sp500-changes.json; seals if the validity gates pass
 *   node backend/r197-sp500-changes.js --selftest   synthetic data only; writes nothing
 *
 * IMPLEMENTATION NOTES (every choice fixed before any R197 return was computed; none chosen on results)
 *  N1 Source. The registry names the "Selected changes to the list of S&P 500 components" table. On the cached revision of
 *     "List of S&P 500 companies" (revid 1375923233, 2026-09-20) that table no longer exists: Wikipedia moved it to "Historical
 *     components of the S&P 500", table id="changes" (cached from the R181 work under data/training/scout-0924/wikipedia/,
 *     revid 1376064088, 2026-09-21T20:49:21Z). That table is used, unaltered. Cross-check (reported, not gating): for adds still
 *     in the index, the constituents table's "Date added" on the list page is compared with the change-table date.
 *  N2 Parsing. <ref> tags stripped; a row is split on '||' into date | add ticker | add security | removed ticker | removed security
 *     | reason. Tickers: wiki templates/links stripped, must match /^[A-Z][A-Z0-9.]*$/. One position per (ticker, direction) per date.
 *     A ticker that is both added and removed on the same date (share-class / ticker reshuffle) is excluded (listed).
 *  N3 Event date E. The editors' note on the list page says most change dates are the date the new company FIRST appears (the
 *     change is effective before the open), but some list the last day the old company was in (the prior business day). The
 *     registry defines E as the day index funds trade at the close. With D = the table date: candidates are E1 = the last SPY
 *     session strictly before D and E0 = D (only if D is a session). E = the candidate with the larger median, over the date's
 *     names, of volume(day) / median volume over sessions [E1-25, E1-6] (the index-fund closing trade is a volume spike that is
 *     public in advance through S&P's announcement, so this recovers a known date; it uses no returns). Ties / no volume data:
 *     E1, the S&P convention (ties decided by a seeded key, never row order). Reported variant: E = E1 always.
 *     Evidence window: E in 2016-01-01..2026-08-31.
 *  N4 Prices. Alpaca SIP daily, adjustment=all, via lib/alpaca-bars.js fetchBars, one request per table date with
 *     asof = D - 1 calendar day, so a ticker resolves to the company that held it then (a reused ticker — e.g. DOC, Physicians
 *     Realty before 2024, Healthpeak after — otherwise returns today's holder's history; the optional asof pass-through was added
 *     to fetchBars for this). SPY fetched once. Cached in data/training/flows4/r197/ (per-date files) and flows4/spy-daily.json.
 *  N5 Position. At the close of E: SHORT each add, LONG each delete, hold h = 10 SPY sessions. Exit = the name's close on session
 *     E+h, or, if it has no bar there (delisted / merged / halted), its last close strictly after E and before E+h; SPY is measured
 *     over exactly the same dates. Directional excess = dir x (P_exit/P_E - SPY_exit/SPY_E) - 0.0020 (10 bps per side, on the
 *     stock leg; the SPY benchmark is a measuring stick, not a costed hedge). Excluded (listed, with the table's reason): no bar ON E
 *     (no independent close — e.g. spin-offs not yet regular-way, targets merged before E) or no bar after E (merged away at E).
 *  N6 Statistic. Per event date, mean over that date's included positions; t over event dates in date order, Newey-West lag 1
 *     (Bartlett 1/2, autocovariances divisor n) — registered lag 1 is used at every horizon (5/10/20). Reported, not gated: adds
 *     only, deletes only, h = 5 and h = 20 (20 only where E+20 exists), gross (no cost), E = E1 convention, and the pre-effective
 *     run-up E-5 -> E (stock minus SPY, no direction flip, no cost; "announcement ~5 days before E" taken as 5 sessions).
 *  N7 Placebo (VERDICT input). 200 draws (seed 197001). Each event date moves to a uniformly random SPY session in the same
 *     calendar month as E that is not any event date E; the same positions are re-measured from that close with the identical
 *     exit/cost rule (names with no bar on the shifted day or none after it drop from that draw). Draw statistic = the mean over
 *     event dates, compared with the true mean over event dates; beaten = true mean STRICTLY > nearest-rank 95th percentile.
 *  N8 Peek (VALIDITY gate, house convention R183/R193): each position's direction replaced by the sign of its own realised gross
 *     10-day excess, same cost; the NW t must be >= the bar (the harness can see a known edge). Fails -> NOT sealed.
 *  N9 Seal gates: peek clears; 200 finite placebo draws; >= 100 event dates; positions for which Alpaca returned NO bars at all
 *     <= 5% of parsed in-window positions (a data-feed failure). PASS = primary NW t >= bar AND placebo beaten. A DID NOT PASS is
 *     the decision rule's 'fail'. REVISION (made after the --coverage pass, BEFORE any return was computed): the first version
 *     gated on '>= 85% of parsed positions priced'. Coverage came back 326/437 (74.6%), and the listing of the 111 unpriced
 *     positions showed them to be the registry's own exclusion class — deletes acquired/merged at or before E, spin-off adds
 *     with no regular-way close on E, and ticker renames (WLTW->WTW, CDAY->DAY, Q->IQV, DWDP/DD, BHI->BKR; plus FBHS, renamed
 *     FBIN four days before its market-cap deletion, the one genuine loss). Counting registered exclusions as feed failures was
 *     a gate defect, so the gate now measures feed failure only ('no SIP bars returned', 6/437). The priced share is reported.
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const ID = "R197", OUT = D("r197-sp500-changes.json");
const WIKI = D("training/scout-0924/wikipedia"), CACHE = D("training/flows4/r197"), SPYF = D("training/flows4/spy-daily.json");
const WIN0 = "2016-01-01", WIN1 = "2026-08-31", H = 10, COST_RT = 0.002, DRAWS = 200, SEED = 197001;
const COVERAGE = process.argv.includes("--coverage"), SELFTEST = process.argv.includes("--selftest");

// ---------- stats ----------------------------------------------------------------------------------------------------------
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function nwT(a) { const n = a.length; if (n < 3) return null; const m = mean(a); let g0 = 0, g1 = 0; for (let i = 0; i < n; i++) { const e = a[i] - m; g0 += e * e; if (i) g1 += e * (a[i - 1] - m); } g0 /= n; g1 /= n; return m / Math.sqrt((g0 + g1) / n); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pctNearest = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]; };
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(4)), bp = (x) => (x == null ? null : +(x * 1e4).toFixed(1));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

// ---------- N1/N2: parse the change table -------------------------------------------------------------------------------------
function isoOf(txt) { const t = Date.parse(txt.trim() + " UTC"); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; }
const cleanTick = (s) => (s || "").replace(/\{\{[^|}]*\|([^}|]+)[^}]*\}\}/g, "$1").replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, "$1").replace(/<[^>]*>/g, "").trim().toUpperCase();
const cleanTxt = (s) => (s || "").replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, "$1").replace(/\{\{[^}]*\}\}/g, "").replace(/\s+/g, " ").trim();
function parseChanges() {
  const page = JSON.parse(fs.readFileSync(path.join(WIKI, "historical-components-of-sp500.json"), "utf8"));
  const c = page.content, a = c.indexOf('id="changes"'), e = c.indexOf("\n|}", a);
  if (a < 0 || e < 0) throw new Error("changes table not found in cached page");
  const rows = [], bad = [];
  for (const raw of c.slice(a, e).split(/\n\|-/).slice(1)) {
    if (/^\s*!/.test(raw)) continue;                                            // header rows
    const body = raw.replace(/<ref[^>]*\/>/g, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "").replace(/^\s*\|\|?/, "");
    const cells = body.split(/\n\|\||\|\||\n\|/).map((x) => x.trim());
    const date = isoOf(cells[0] || "");
    if (!date) { bad.push(raw.slice(0, 120)); continue; }
    rows.push({ date, add: cleanTick(cells[1]), addName: cleanTxt(cells[2]), rem: cleanTick(cells[3]), remName: cleanTxt(cells[4]), reason: cleanTxt(cells[5]) });
  }
  return { rows, bad, revid: page.revid, timestamp: page.timestamp, title: "Historical components of the S&P 500 (table id=changes)" };
}
function constituentsDateAdded() {
  const p = JSON.parse(fs.readFileSync(path.join(WIKI, "list-of-sp500-companies.json"), "utf8")), c = p.content;
  const a = c.indexOf('id="constituents"'), e = c.indexOf("\n|}", a), m = new Map();
  for (const raw of c.slice(a, e).split(/\n\|-/).slice(1)) {
    const cells = raw.replace(/^\s*\|\|?/, "").split(/\n\|\||\|\||\n\|/).map((x) => x.trim()); if (cells.length < 6) continue;
    const t = cleanTick(cells[0]); const d = (cells[5] || "").match(/\d{4}-\d{2}-\d{2}/); if (t && d) m.set(t, d[0]);
  }
  return { map: m, revid: p.revid, timestamp: p.timestamp };
}
const TICK = /^[A-Z][A-Z0-9.]*$/;
function positionsByDate(rows) {
  const byD = new Map(), excluded = [];
  for (const r of rows) {
    if (r.date < "2015-12-20" || r.date > "2026-09-10") continue;              // E window check happens after E is resolved
    const L = byD.get(r.date) || byD.set(r.date, []).get(r.date);
    if (r.add) { if (TICK.test(r.add)) L.push({ sym: r.add, dir: -1, side: "add", name: r.addName, reason: r.reason }); else excluded.push({ D: r.date, sym: r.add, side: "add", why: "unparseable ticker", reason: r.reason }); }
    if (r.rem) { if (TICK.test(r.rem)) L.push({ sym: r.rem, dir: +1, side: "delete", name: r.remName, reason: r.reason }); else excluded.push({ D: r.date, sym: r.rem, side: "delete", why: "unparseable ticker", reason: r.reason }); }
  }
  for (const [d, L] of byD) {
    const seen = new Map(); for (const p of L) seen.set(p.sym + p.dir, p);
    const uniq = [...seen.values()], both = new Set(uniq.filter((p) => p.dir < 0 && uniq.some((q) => q.dir > 0 && q.sym === p.sym)).map((p) => p.sym));
    for (const s of both) excluded.push({ D: d, sym: s, side: "both", why: "added and removed on the same date (share-class/ticker reshuffle)" });
    byD.set(d, uniq.filter((p) => !both.has(p.sym)));
  }
  return { byD, excluded };
}

// ---------- N4: prices ---------------------------------------------------------------------------------------------------------
const addDays = (iso, k) => new Date(Date.parse(iso + "T00:00:00Z") + k * 864e5).toISOString().slice(0, 10);
const monthStart = (iso) => iso.slice(0, 7) + "-01";
const monthEnd = (iso) => { const d = new Date(Date.parse(monthStart(iso) + "T00:00:00Z")); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
async function loadSpy() {
  if (fs.existsSync(SPYF)) return JSON.parse(fs.readFileSync(SPYF, "utf8"));
  const { fetchBars } = require("./lib/alpaca-bars.js");
  const { bars } = await fetchBars(["SPY"], { start: "2015-09-01", end: "2026-09-23T23:59:59Z", feed: "sip", adjustment: "all", requireAll: true, quiet: true });
  const body = { fetchedAt: new Date().toISOString(), spec: "Alpaca SIP 1Day adjustment=all", rows: bars.SPY.map((b) => [String(b.t).slice(0, 10), b.c, b.v]) };
  fs.mkdirSync(path.dirname(SPYF), { recursive: true }); writeJsonAtomic(SPYF, body, { pretty: 0 }); return body;
}
async function loadDate(Dt, syms) {
  const f = path.join(CACHE, Dt + ".json");
  if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (syms.every((s) => s in j.bars)) return j; }
  const { fetchBars } = require("./lib/alpaca-bars.js");
  const start = addDays(monthStart(addDays(Dt, -7)), -60), endC = [addDays(monthEnd(Dt), 30), addDays(Dt, 45)].sort()[1];
  const end = endC > "2026-09-23" ? "2026-09-23" : endC;
  const r = await fetchBars(syms, { start, end: end + "T23:59:59Z", feed: "sip", adjustment: "all", requireAll: false, quiet: true, asof: addDays(Dt, -1) });
  const bars = {}; for (const s of syms) bars[s] = (r.bars[s] || []).map((b) => [String(b.t).slice(0, 10), b.c, b.v]);
  const body = { D: Dt, asof: addDays(Dt, -1), start, end, fetchedAt: new Date().toISOString(), spec: "Alpaca SIP 1Day adjustment=all asof=D-1", bars };
  fs.mkdirSync(CACHE, { recursive: true }); writeJsonAtomic(f, body, { pretty: 0 }); return body;
}

// ---------- N3/N5: event construction (pure; shared with selftest) ----------------------------------------------------------
/** spy: [[d,c,v]]; dates: [{D, pos:[{sym,dir,...}], bars:{sym:[[d,c,v]]}}] -> events [{E, E1, how, pos:[{..., px: Map(idx->close)}]}] */
function buildEvents(spy, dates, rngKey) {
  const cal = spy.map((r) => r[0]), idx = new Map(cal.map((d, i) => [d, i]));
  const firstAtOrAfter = (d) => { let lo = 0, hi = cal.length; while (lo < hi) { const m = (lo + hi) >> 1; if (cal[m] < d) lo = m + 1; else hi = m; } return lo; };
  const events = [], resolution = { byVolumeE1: 0, byVolumeE0: 0, defaultE1: 0, onlyE1: 0 }, excluded = [];
  for (const g of dates) {
    const iD = firstAtOrAfter(g.D), e1 = iD - 1, e0 = cal[iD] === g.D ? iD : null;
    if (e1 < 30) continue;
    const pos = g.pos.map((p) => { const m = new Map(); for (const [d, c, v] of g.bars[p.sym] || []) { const i = idx.get(d); if (i != null && c > 0) m.set(i, { c, v }); } return { ...p, px: m }; });
    let E = e1, how = "onlyE1";
    if (e0 != null) {
      const score = (i) => { const r = []; for (const p of pos) { const base = []; for (let k = e1 - 25; k <= e1 - 6; k++) { const b = p.px.get(k); if (b && b.v > 0) base.push(b.v); } const b = p.px.get(i); if (base.length >= 10 && b && b.v > 0) r.push(b.v / median(base)); } return r.length ? median(r) : null; };
      const s1 = score(e1), s0 = score(e0);
      if (s1 == null || s0 == null) { how = "defaultE1"; }
      else if (s0 > s1) { E = e0; how = "byVolumeE0"; }
      else if (s1 > s0) { how = "byVolumeE1"; }
      else { E = rngKey() < 0.5 ? e0 : e1; how = "tieSeeded"; }
      if (how === "defaultE1") E = e1;
    }
    resolution[how] = (resolution[how] || 0) + 1;
    events.push({ D: g.D, E, E1: e1, how, date: cal[E], pos });
  }
  return { events, resolution, cal };
}
/** one position's directional net excess from close at session s over h sessions; null if not measurable */
function posRet(p, spyC, s, h, { dir = p.dir, cost = COST_RT, gross = false } = {}) {
  const b0 = p.px.get(s); if (!b0) return null;
  let x = null; for (let k = s + h; k > s; k--) { if (p.px.has(k)) { x = k; break; } }
  if (x == null || x >= spyC.length) return null;
  const ex = p.px.get(x).c / b0.c - spyC[x] / spyC[s];
  return gross ? ex : dir * ex - cost;
}
function eventMeans(events, spyC, { h = H, shift = null, filt = () => true, dirFn = null, cost = COST_RT, useE1 = false, maxIdx = Infinity } = {}) {
  const out = [];
  for (const ev of events) {
    const s = shift ? shift.get(ev) : (useE1 ? ev.E1 : ev.E); if (s == null || s + h > maxIdx) continue;
    const v = []; for (const p of ev.pos) { if (!filt(p)) continue; const r = posRet(p, spyC, s, h, { dir: dirFn ? dirFn(p, s, h) : p.dir, cost }); if (r != null) v.push(r); }
    if (v.length) out.push({ date: ev.date, n: v.length, v: mean(v) });
  }
  return out;
}
const summ = (rows) => { const a = rows.map((r) => r.v); return { eventDates: a.length, positions: rows.reduce((s, r) => s + r.n, 0), meanBp: bp(a.length ? mean(a) : null), mean: a.length ? mean(a) : null, tNW: r4(nwT(a)), hit: r4(a.length ? a.filter((x) => x > 0).length / a.length : null) }; };

function computeRead(events, spyC, cal, bar, lastIdx) {
  const maxIdx = lastIdx;
  const primaryRows = eventMeans(events, spyC, { maxIdx }), primary = summ(primaryRows);
  const variants = {
    addsOnly: summ(eventMeans(events, spyC, { filt: (p) => p.dir < 0, maxIdx })),
    deletesOnly: summ(eventMeans(events, spyC, { filt: (p) => p.dir > 0, maxIdx })),
    h5: summ(eventMeans(events, spyC, { h: 5, maxIdx })),
    h20: summ(eventMeans(events, spyC, { h: 20, maxIdx })),
    gross: summ(eventMeans(events, spyC, { cost: 0, maxIdx })),
    eConventionE1: summ(eventMeans(events, spyC, { useE1: true, maxIdx })),
  };
  // pre-effective run-up E-5 -> E: stock minus SPY, no flip, no cost
  const runup = (sideDir) => { const rows = []; for (const ev of events) { const s = ev.E - 5; const v = []; for (const p of ev.pos) { if (p.dir !== sideDir) continue; const b0 = p.px.get(s), b1 = p.px.get(ev.E); if (b0 && b1) v.push(b1.c / b0.c - spyC[ev.E] / spyC[s]); } if (v.length) rows.push({ date: ev.date, n: v.length, v: mean(v) }); } return summ(rows); };
  variants.preRunupAdds = runup(-1); variants.preRunupDeletes = runup(+1);
  // peek (N8)
  const peek = summ(eventMeans(events, spyC, { maxIdx, dirFn: (p, s, h) => { const g = posRet(p, spyC, s, h, { gross: true }); return g > 0 ? 1 : g < 0 ? -1 : 0; } }));
  // placebo (N7)
  const evSet = new Set(events.map((e) => e.E)), rng = mulberry(SEED), draws = [];
  const pool = new Map(); for (const ev of events) { const m = cal[ev.E].slice(0, 7); if (!pool.has(m)) pool.set(m, cal.map((d, i) => [d, i]).filter(([d, i]) => d.slice(0, 7) === m && !evSet.has(i) && i + H <= maxIdx).map(([, i]) => i)); }
  for (let k = 0; k < DRAWS; k++) {
    const sh = new Map(); for (const ev of events) { const P = pool.get(cal[ev.E].slice(0, 7)); sh.set(ev, P.length ? P[Math.floor(rng() * P.length)] : null); }
    const rows = eventMeans(events, spyC, { shift: sh, maxIdx }); draws.push(rows.length ? mean(rows.map((r) => r.v)) : NaN);
  }
  const finite = draws.filter(Number.isFinite), p95 = pctNearest(finite, 0.95);
  const placebo = { draws: DRAWS, finite: finite.length, seed: SEED, p95, p95Bp: bp(p95), meanBp: bp(mean(finite)), trueMeanBp: primary.meanBp, beaten: primary.mean != null && primary.mean > p95 };
  const peekClears = peek.tNW != null && peek.tNW >= bar;
  const pass = primary.tNW != null && primary.tNW >= bar && placebo.beaten;
  const byYear = {}; for (const y of [...new Set(primaryRows.map((r) => r.date.slice(0, 4)))]) byYear[y] = summ(primaryRows.filter((r) => r.date.startsWith(y)));
  return { bar, primary, variants, peek: { ...peek, clearsBar: peekClears }, placebo, pass, byYear, primaryRows: primaryRows.map((r) => ({ date: r.date, n: r.n, bp: bp(r.v) })) };
}

// ---------- self-test -------------------------------------------------------------------------------------------------------
function selftest() {
  const g = mulberry(5); const norm = () => Math.sqrt(-2 * Math.log(g() + 1e-12)) * Math.cos(2 * Math.PI * g());
  const spy = []; let px = 100; const d0 = Date.parse("2016-01-04");
  for (let i = 0; spy.length < 2700; i++) { const d = new Date(d0 + i * 864e5); if (d.getUTCDay() % 6 === 0) continue; px *= 1 + 0.0004 + 0.01 * norm(); spy.push([d.toISOString().slice(0, 10), px, 1e6]); }
  for (const eff of [0, 0.004]) {
    const dates = [];
    for (let k = 0; k < 250; k++) {
      const iD = 60 + Math.floor(g() * 2550), Dt = spy[iD][0], pos = [], bars = {};
      for (const [sym, dir] of [["A" + k, -1], ["B" + k, +1]]) {
        pos.push({ sym, dir }); let c = 50; const rows = [];
        for (let i = iD - 60; i < Math.min(spy.length, iD + 60); i++) { const r = spy[i][1] / spy[i - 1][1] - 1; c *= (1 + r + 0.015 * norm()) * (1 + (i >= iD && i < iD + 10 ? dir * eff : 0)); rows.push([spy[i][0], c, i === iD - 1 ? 9e6 : 1e6]); }
        bars[sym] = rows;
      }
      dates.push({ D: Dt, pos, bars });
    }
    const { events, resolution, cal } = buildEvents(spy, dates, mulberry(1));
    const R = computeRead(events, spy.map((r) => r[1]), cal, 2.228, spy.length - 1);
    console.log(`selftest injected ${eff * 1e4} bp/day directional: mean ${R.primary.meanBp} bp, NW t ${R.primary.tNW}, placebo p95 ${R.placebo.p95Bp} beaten=${R.placebo.beaten}, peek t ${R.peek.tNW}, pass=${R.pass}, E resolution ${JSON.stringify(resolution)}`);
  }
  console.log("selftest wrote nothing.");
}

// ---------- main ------------------------------------------------------------------------------------------------------------
(async () => {
  if (SELFTEST) return selftest();
  { const s = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (s.tests[ID] && !COVERAGE) { console.error(`${ID} already sealed — refusing`); process.exit(2); } }
  const ENTRY0 = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((t) => t.id === ID);
  if (!ENTRY0) { console.error(`${ID} not registered`); process.exit(2); }
  const BAR = ENTRY0.bar.tRequired;
  const P = parseChanges(), CD = constituentsDateAdded();
  const { byD, excluded: parseExcl } = positionsByDate(P.rows);
  const spyB = await loadSpy(), spy = spyB.rows, spyC = spy.map((r) => r[1]);
  const lastIdx = spy.length - 1;
  const dates = [];
  let n = 0; for (const [Dt, pos] of [...byD.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!pos.length) continue;
    const j = await loadDate(Dt, [...new Set(pos.map((p) => p.sym))]); dates.push({ D: Dt, pos, bars: j.bars });
    if (++n % 25 === 0) process.stdout.write(`  priced ${n} table dates\r`);
  }
  const { events: all, resolution, cal } = buildEvents(spy, dates, mulberry(SEED + 7));
  const events0 = all.filter((e) => e.date >= WIN0 && e.date <= WIN1);
  // N5 exclusions: need a bar ON E and at least one after E (within H sessions)
  const excluded = [...parseExcl.filter((x) => { const e = all.find((q) => q.D === x.D); return e && e.date >= WIN0 && e.date <= WIN1; })];
  let parsedPos = 0, pricedPos = 0;
  const events = [];
  for (const ev of events0) {
    const keep = [];
    for (const p of ev.pos) {
      parsedPos++;
      let why = null;
      if (!p.px.has(ev.E)) why = p.px.size ? "no bar on E (no independent close)" : "no SIP bars returned";
      else { let after = false; for (let k = ev.E + 1; k <= ev.E + H; k++) if (p.px.has(k)) { after = true; break; } if (!after) why = "no bar after E (merged/delisted at E)"; }
      if (why) excluded.push({ D: ev.D, E: ev.date, sym: p.sym, side: p.side, why, reason: p.reason }); else { keep.push(p); pricedPos++; }
    }
    if (keep.length) events.push({ ...ev, pos: keep });
  }
  // cross-check (N1): adds vs constituents 'Date added'
  let xAdds = 0, xSame = 0, xNear = 0; const xDiff = [];
  for (const ev of events0) for (const p of ev.pos) if (p.dir < 0 && CD.map.has(p.sym)) { xAdds++; const da = CD.map.get(p.sym); if (da === ev.D) xSame++; else if (Math.abs(Date.parse(da) - Date.parse(ev.D)) <= 4 * 864e5) xNear++; else xDiff.push({ sym: p.sym, table: ev.D, dateAdded: da }); }
  const cov = { tableRows: P.rows.length, unparsedRows: P.bad.length, tableDatesInWindow: events0.length, eventDates: events.length, parsedPositions: parsedPos, pricedPositions: pricedPos, pricedShare: r4(pricedPos / parsedPos),
    adds: events.reduce((s, e) => s + e.pos.filter((p) => p.dir < 0).length, 0), deletes: events.reduce((s, e) => s + e.pos.filter((p) => p.dir > 0).length, 0),
    eResolution: Object.fromEntries(Object.entries(events0.reduce((m, e) => ((m[e.how] = (m[e.how] || 0) + 1), m), {}))),
    crossCheck: { addsStillInIndex: xAdds, sameDate: xSame, within4Days: xNear, differ: xDiff.length, differList: xDiff.slice(0, 40) },
    exclusionsByWhy: excluded.reduce((m, x) => ((m[x.why] = (m[x.why] || 0) + 1), m), {}) };
  console.log(`R197 coverage: ${JSON.stringify({ ...cov, crossCheck: { ...cov.crossCheck, differList: undefined } })}`);
  if (COVERAGE) return;

  const R = computeRead(events, spyC, cal, BAR, lastIdx);
  const f = (x) => (x == null ? "n/a" : x);
  const verdict = `${R.pass ? "PASS" : "DID NOT PASS"} — short adds / long deletes from the effective-date close, 10-day net excess vs SPY ${f(R.primary.meanBp)} bp per event date, NW t ${f(R.primary.tNW)} vs bar ${BAR} over ${R.primary.eventDates} event dates (${R.primary.positions} positions); placebo p95 ${f(R.placebo.p95Bp)} bp (${R.placebo.beaten ? "beaten" : "not beaten"}); adds t ${f(R.variants.addsOnly.tNW)}, deletes t ${f(R.variants.deletesOnly.tNW)}; peek t ${f(R.peek.tNW)}`;
  const gates = { peekClears: R.peek.clearsBar, placeboComputed: R.placebo.finite === DRAWS, noBarsShareOk: excluded.filter((x) => x.why === "no SIP bars returned").length <= 0.05 * parsedPos, eventDatesOk: events.length >= 100 };
  const sealable = Object.values(gates).every(Boolean);
  const out = { id: ID, spec: "r197-sp500-changes-v1", readOn: new Date().toISOString(), rule: ENTRY0.rule, statistic: ENTRY0.statistic, controls: ENTRY0.controls, bar: ENTRY0.bar,
    source: { changes: `Wikipedia '${P.title}' revid ${P.revid} (${P.timestamp})`, crossCheck: `Wikipedia 'List of S&P 500 companies' revid ${CD.revid} (${CD.timestamp}) constituents 'Date added'`, prices: "Alpaca SIP 1Day adjustment=all, asof=D-1 per table date; SPY fetched " + spyB.fetchedAt },
    coverage: cov, excluded, ...R, gates, sealable, verdict };
  writeJsonAtomic(OUT, out);
  console.log(verdict);
  console.log(`  variants: ${Object.entries(R.variants).map(([k, v]) => `${k} ${v.meanBp}bp t${v.tNW} (${v.eventDates})`).join(" · ")}`);
  console.log(`  gates: ${JSON.stringify(gates)}`);
  if (!sealable) { console.error("validity gate failed — written, NOT sealed"); process.exit(3); }
  // seal: re-read shared files immediately before writing (other reads run concurrently)
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests[ID]) { console.error(`${ID} sealed meanwhile — refusing`); process.exit(2); }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  seals.tests[ID] = { sealedOn: today, unit: "event dates", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((t) => t.id === ID);
  E.status = `READ ${today} — ${verdict}`; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict }) + "\n");
  console.log(`${ID} sealed.`);
})().catch((e) => { console.error("r197 FAILED:", e.stack || e.message); process.exit(1); });
