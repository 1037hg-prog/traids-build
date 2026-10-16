#!/usr/bin/env node
/**
 * R181 — DIVIDEND-PAYMENT-DAY MARKET EFFECT (Hartzmark & Solomon). Registered 2026-09-24 (family SCOUT-0924) before this file
 * existed; the rule, statistic, bar, controls and decision rule are read from data/test-registry.json and never restated here.
 *
 *   node backend/r181-dividend-days.js              freeze the universe (once), fetch up to --max=N missing AV responses
 *                                                   (default 25), then READ + SEAL only if coverage is complete
 *   node backend/r181-dividend-days.js --status     coverage only (no AV calls, no prices, no outcome)
 *   node backend/r181-dividend-days.js --selftest   exercises the read path on SYNTHETIC data only; writes nothing
 *
 * The read never runs on a partial sample: every universe name must have a cached OVERVIEW reply, and a cached DIVIDENDS reply
 * whenever its OVERVIEW carries SharesOutstanding. AV cache: data/training/scout-0924/{OVERVIEW,DIVIDENDS}/ (lib/av-scout-cache.js).
 *
 * IMPLEMENTATION NOTES (fixed before any R181 outcome was computed; none chosen from results):
 *  N1 Universe source. The repo has no true S&P 500 list (src/App.jsx "SP500" is a 605-name board roster with ADRs and ETFs), so
 *     "current constituents" = the constituents table of Wikipedia "List of S&P 500 companies" (revision cached with its revid
 *     under data/training/scout-0924/wikipedia/). "Names delisted since 2019" = tickers REMOVED in Wikipedia "Historical components
 *     of the S&P 500" (changes table, effective date >= 2019-01-01) that appear in the cached AV LISTING_STATUS delisted file
 *     (data/av-listing-status-delisted-2026-09-23.csv) as a Stock with delistingDate >= 2019-01-01 and >= (removal date - 31 days),
 *     and that are NOT in the AV active listing (a reused ticker would make AV return a different company). Removed names that are
 *     still listed are not in the universe: the rule names only delisted ones. Tickers map to AV form by '.' -> '-' (BRK.B -> BRK-B).
 *  N2 "Where Alpha Vantage returns them": a name enters the sum only if OVERVIEW returns a positive SharesOutstanding AND DIVIDENDS
 *     returns rows. OVERVIEW is asked first; DIVIDENDS is not asked for a name without shares (it could not enter the sum) — saves quota.
 *  N3 Amounts are used exactly as AV DIVIDENDS returns them, times today's SharesOutstanding (the rule's disclosed approximation).
 *     If AV amounts are NOT split-adjusted, pre-split payments are mis-scaled; the read reports a split-consistency diagnostic
 *     (AAPL's May-2020 payment: ~0.82 = unadjusted, ~0.205 = split-adjusted) but does not alter the rule.
 *  N4 Payment dates are bucketed on the trading day they name. A payment dated on a non-trading day belongs to no trading day and is
 *     dropped (count and dollar share reported). Rows with no payment date are dropped (counted).
 *  N5 "Top 20% of trading days in its calendar year": trading days = SPY SIP daily bars. Each year's trading days (days with no
 *     payment count as 0) are ranked by aggregate paid, descending, ties broken by a seeded random key (never row order);
 *     heavy = the first floor(0.2 x days-in-year). 2026 is ranked over its trading days through 2026-08-31 (the evidence end);
 *     2018 is ranked over the whole of 2018 so the placebo's shifted flags exist at the window start.
 *  N6 The year threshold uses the full year's payment dates (the rule's own definition); payment dates are declared weeks ahead, but
 *     the year-level cut-off is not strictly knowable in January. Disclosed, not altered.
 *  N7 Return = SPY close-to-close with adjustment=all (total return), days 2019-01-02..2026-08-31 (first return uses 2018-12-31).
 *     Statistic = Welch t of mean(heavy) - mean(other) over those days.
 *  N8 Placebo: 200 draws (seed 18101); each draw shifts the whole heavy-flag series by k trading days, k uniform on
 *     {-10..-1, +1..+10}; flag'(d) = flag(d - k); days whose shifted flag falls outside the ranked range are dropped from that draw.
 *     The true Welch t must be STRICTLY greater than the 95th percentile (nearest-rank) of the 200 shifted t's.
 *  N9 Q4 control = report-only per the registry ("Q4 subset reported"): Welch t on Oct-Dec days. It is reported, not gated.
 *  N10 Seal discipline (house precedent, R175): coverage/sanity failures refuse to seal; the placebo decides the VERDICT (PASS needs
 *     t >= bar AND placebo beaten); a DID NOT PASS is sealed as the decision rule's 'cannot tell', not 'false'.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const av = require("./lib/av-scout-cache.js");
const D = (f) => path.join(__dirname, "data", f);
const ID = "R181", UNI = D("r181-universe.json"), OUT = D("r181-dividend-days.json"), WIKI = path.join(av.ROOT, "wikipedia");
const WIN0 = "2019-01-01", WIN1 = "2026-08-31", SEED = 18101, DRAWS = 200;
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const MAX = +arg("max", 25);

// ---------- stats ----------------------------------------------------------------------------------------------------------
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const vr = (a) => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); };
function welch(a, b) { if (a.length < 2 || b.length < 2) return { diff: null, t: null, nA: a.length, nB: b.length }; const d = mean(a) - mean(b); return { diff: d, t: d / Math.sqrt(vr(a) / a.length + vr(b) / b.length), nA: a.length, nB: b.length, meanA: mean(a), meanB: mean(b) }; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pctNearest = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]; };

// ---------- universe (N1) ----------------------------------------------------------------------------------------------------
async function wiki(title, file) {
  const f = path.join(WIKI, file); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const u = "https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content|ids|timestamp&rvslots=main&format=json&formatversion=2&titles=" + encodeURIComponent(title);
  const j = await (await fetch(u, { headers: { "User-Agent": "TRAIDS-research/1.0 (paper-only study)" }, signal: AbortSignal.timeout(60000) })).json();
  const rev = j.query.pages[0].revisions[0]; const body = { source: u, fetchedAt: new Date().toISOString(), revid: rev.revid, timestamp: rev.timestamp, content: rev.slots.main.content };
  fs.mkdirSync(WIKI, { recursive: true }); writeJsonAtomic(f, body, { pretty: 0 }); return body;
}
const csv = (f) => { const [h, ...rows] = fs.readFileSync(D(f), "utf8").trim().split(/\r?\n/); const k = h.split(","); return rows.map((r) => { const c = r.split(","); return Object.fromEntries(k.map((x, i) => [x, c[i]])); }); };
const avSym = (s) => s.trim().toUpperCase().replace(/\./g, "-");
async function freeze() {
  const cur = await wiki("List of S&P 500 companies", "list-of-sp500-companies.json");
  const hist = await wiki("Historical components of the S&P 500", "historical-components-of-sp500.json");
  const a = cur.content.indexOf('id="constituents"'), e = cur.content.indexOf("\n|}", a);
  const current = [...cur.content.slice(a, e).matchAll(/\{\{(?:NyseSymbol|NasdaqSymbol|CboeSymbol|BZX link|nyse|nasdaq)\|([^}|]+)/gi)].map((m) => avSym(m[1]));
  if (current.length < 495 || current.length > 510) throw new Error(`constituents parse gave ${current.length} names — refusing to freeze`);
  const h0 = hist.content.indexOf('id="changes"'), h1 = hist.content.indexOf("\n|}", h0);
  const removed = [];
  for (const row of hist.content.slice(h0, h1).split(/\n\|-/).slice(1)) {
    const cells = row.split(/\n\|\|?/).map((c) => c.trim()).filter((c, i) => i > 0 || c);
    const dt = Date.parse(cells[0]); if (!Number.isFinite(dt)) continue;
    const date = new Date(dt - new Date(dt).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const tick = (cells[3] || "").replace(/\{\{[^|}]*\|([^}]+)\}\}/, "$1").replace(/\[\[|\]\]/g, "").trim();
    if (date >= WIN0 && /^[A-Z][A-Z0-9.\-]*$/.test(tick)) removed.push({ date, sym: avSym(tick) });
  }
  const act = new Set(csv("av-listing-status-active-2026-09-23.csv").map((r) => r.symbol));
  const del = csv("av-listing-status-delisted-2026-09-23.csv").filter((r) => r.assetType === "Stock");
  const curSet = new Set(current), delisted = [], seen = new Set();
  for (const r of removed) {
    if (curSet.has(r.sym) || act.has(r.sym) || seen.has(r.sym)) continue;
    const lo = new Date(Date.parse(r.date) - 31 * 864e5).toISOString().slice(0, 10);
    const hit = del.find((x) => x.symbol === r.sym && x.delistingDate >= WIN0 && x.delistingDate >= lo);
    if (hit) { delisted.push({ sym: r.sym, removed: r.date, delistingDate: hit.delistingDate, name: hit.name }); seen.add(r.sym); }
  }
  const names = [...new Set([...current, ...delisted.map((x) => x.sym)])];
  const body = { spec: "r181-universe-v1", frozenAt: new Date().toISOString(), test: ID,
    sources: { current: `Wikipedia 'List of S&P 500 companies' revid ${cur.revid} (${cur.timestamp})`, removals: `Wikipedia 'Historical components of the S&P 500' revid ${hist.revid} (${hist.timestamp})`, delisted: "AV LISTING_STATUS delisted, cached 2026-09-23" },
    rule: "N1 in r181-dividend-days.js", counts: { current: current.length, removalsSince2019: removed.length, delistedAdded: delisted.length, total: names.length },
    current, delisted, names };
  body.sha256 = crypto.createHash("sha256").update(names.join(",")).digest("hex");
  writeJsonAtomic(UNI, body); console.log(`R181 universe frozen: ${current.length} current + ${delisted.length} delisted = ${names.length} · sha ${body.sha256.slice(0, 12)}`);
  return body;
}

// ---------- coverage + fetch ---------------------------------------------------------------------------------------------------
const sharesOf = (sym) => { const o = av.read("OVERVIEW", sym); const x = o && o.response && +o.response.SharesOutstanding; return x > 0 ? x : null; };
function coverage(uni) {
  let ov = 0, dv = 0, needDiv = 0; const todo = [];
  for (const s of uni.names) {
    if (!av.has("OVERVIEW", s)) { todo.push(["OVERVIEW", s]); continue; } ov++;
    if (sharesOf(s)) { needDiv++; if (av.has("DIVIDENDS", s)) dv++; else todo.push(["DIVIDENDS", s]); }
  }
  // worst case remaining calls: every missing OVERVIEW may also need a DIVIDENDS call
  const worst = todo.length + todo.filter(([f]) => f === "OVERVIEW").length;
  return { names: uni.names.length, overview: ov, needDividends: needDiv, dividends: dv, todo, complete: !todo.length, remainingCallsUpTo: worst };
}
async function fetchSome(uni) {
  let used = 0; const t0 = coverage(uni);
  try {
    for (const [fn, s] of t0.todo) {
      if (used >= MAX) break;
      const r = await av.get(fn, s, {}, { caller: ID }); if (!r.cached) used++;
      if (fn === "OVERVIEW" && sharesOf(s) && !av.has("DIVIDENDS", s) && used < MAX) { const r2 = await av.get("DIVIDENDS", s, {}, { caller: ID }); if (!r2.cached) used++; }
    }
  } catch (e) { if (e instanceof av.QuotaStop) console.log(`  ${e.message} (after ${used} call(s) this run)`); else console.log(`  fetch error: ${e.message} (after ${used} call(s))`); }
  return used;
}
const status = (uni) => { const c = coverage(uni); console.log(`R181 coverage — OVERVIEW ${c.overview}/${c.names} · DIVIDENDS ${c.dividends}/${c.needDividends} needed so far · ${c.complete ? "COMPLETE — readable" : `up to ${c.remainingCallsUpTo} AV call(s) left`} · AV calls logged by R181: ${av.callsUsed((r) => r.caller === ID || r.caller === "r181-probe")}`); return c; };

// ---------- the read (pure core, shared with --selftest) ----------------------------------------------------------------------
/** days: [{d, ret, paid}] over the ranked range (2018-01-02..2026-08-31, ret may be null outside the window). */
function rankHeavy(days) {   // N5
  const rng = mulberry(SEED), key = days.map(() => rng());
  const byYear = new Map(); days.forEach((x, i) => { const y = x.d.slice(0, 4); (byYear.get(y) || byYear.set(y, []).get(y)).push(i); });
  const heavy = new Array(days.length).fill(false), cut = {};
  for (const [y, idx] of byYear) {
    const s = [...idx].sort((i, j) => (days[j].paid - days[i].paid) || (key[i] - key[j])); const k = Math.floor(0.2 * idx.length);
    s.slice(0, k).forEach((i) => { heavy[i] = true; }); cut[y] = { days: idx.length, heavy: k, thresholdPaid: k ? days[s[k - 1]].paid : null };
  }
  return { heavy, cut };
}
function computeRead(days, bar) {
  const { heavy, cut } = rankHeavy(days);
  const inWin = (i) => days[i].d >= WIN0 && days[i].d <= WIN1 && Number.isFinite(days[i].ret);
  const split = (flag, filt = () => true) => { const a = [], b = []; for (let i = 0; i < days.length; i++) { if (!inWin(i) || !filt(i)) continue; const f = flag(i); if (f == null) continue; (f ? a : b).push(days[i].ret); } return welch(a, b); };
  const primary = split((i) => heavy[i]);
  const q4 = split((i) => heavy[i], (i) => +days[i].d.slice(5, 7) >= 10);
  const prng = mulberry(SEED + 1), shifts = [], draws = [];
  for (let n = 0; n < DRAWS; n++) {
    let k = 1 + Math.floor(prng() * 10); if (prng() < 0.5) k = -k; shifts.push(k);
    draws.push(split((i) => (i - k >= 0 && i - k < days.length ? heavy[i - k] : null)).t);
  }
  const p95 = pctNearest(draws, 0.95), placeboMet = primary.t != null && primary.t > p95;
  const pass = primary.t != null && primary.t >= bar && placeboMet;
  return { primary: { ...primary, diffBpPerDay: primary.diff * 1e4 }, bar, yearCuts: cut,
    placebo: { draws: DRAWS, seed: SEED + 1, shiftsUsed: [...new Set(shifts)].sort((a, b) => a - b), p95, mean: mean(draws), trueBeatsP95: placeboMet },
    q4: { ...q4, diffBpPerDay: q4.diff == null ? null : q4.diff * 1e4, note: "report-only (registry: 'Q4 subset reported'); paper expects ~0" },
    pass };
}

async function read(uni) {
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); }
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), ENTRY = reg.preregistered.find((t) => t.id === ID); if (!ENTRY) { console.error(`${ID} not registered`); process.exit(2); }
  const BAR = ENTRY.bar.tRequired;
  const { fetchBars } = require("./lib/alpaca-bars.js");
  const { bars } = await fetchBars(["SPY"], { start: "2017-12-01", end: "2026-09-30T23:59:59Z", timeframe: "1Day", feed: "sip", adjustment: "all", requireAll: true, quiet: true });
  const spy = bars.SPY.map((b) => ({ d: String(b.t).slice(0, 10), c: b.c })).filter((b) => b.d <= WIN1);
  const idx = new Map(spy.map((b, i) => [b.d, i]));
  const paid = new Map(), drop = { noPayDate: 0, nonTradingDay: 0, nonTradingDollars: 0, badAmount: 0 }; let totalDollars = 0; const used = [];
  for (const s of uni.names) {
    const sh = sharesOf(s); if (!sh) continue; const dv = av.read("DIVIDENDS", s); const rows = (dv && dv.response && dv.response.data) || []; if (!rows.length) continue; used.push(s);
    for (const r of rows) {
      const pd = r.payment_date, amt = +r.amount; if (!(amt > 0)) { drop.badAmount++; continue; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(pd || "")) { drop.noPayDate++; continue; }
      if (pd < "2018-01-01" || pd > WIN1) continue;
      const cash = amt * sh; totalDollars += cash;
      if (!idx.has(pd)) { drop.nonTradingDay++; drop.nonTradingDollars += cash; continue; }
      paid.set(pd, (paid.get(pd) || 0) + cash);
    }
  }
  const first = spy.findIndex((b) => b.d >= "2018-01-01");
  const days = spy.slice(first).map((b, j) => { const i = first + j; return { d: b.d, ret: i > 0 ? b.c / spy[i - 1].c - 1 : null, paid: paid.get(b.d) || 0 }; });
  const aapl = ((av.read("DIVIDENDS", "AAPL") || {}).response || {}).data || [];
  const splitDiag = aapl.filter((r) => (r.payment_date || "").startsWith("2020-05")).map((r) => ({ payment_date: r.payment_date, amount: r.amount }));
  const R = computeRead(days, BAR);
  const nWin = days.filter((x) => x.d >= WIN0 && Number.isFinite(x.ret)).length;
  const verdict = R.pass
    ? `PASS — heavy-payment days ${R.primary.diffBpPerDay.toFixed(2)} bp/day over other days, Welch t ${R.primary.t.toFixed(3)} vs bar ${BAR} over ${nWin} days; placebo p95 ${R.placebo.p95.toFixed(3)}; Q4 t ${R.q4.t == null ? "n/a" : R.q4.t.toFixed(3)}`
    : `DID NOT PASS — cannot tell (not 'false'): heavy-minus-other ${R.primary.diffBpPerDay.toFixed(2)} bp/day, Welch t ${R.primary.t.toFixed(3)} vs bar ${BAR} over ${nWin} days; placebo p95 ${R.placebo.p95.toFixed(3)} (${R.placebo.trueBeatsP95 ? "beaten" : "not beaten"}); Q4 t ${R.q4.t == null ? "n/a" : R.q4.t.toFixed(3)}`;
  const out = { id: ID, readOn: new Date().toISOString(), rule: ENTRY.rule, statistic: ENTRY.statistic, bar: ENTRY.bar, controls: ENTRY.controls,
    universe: { sha256: uni.sha256, names: uni.names.length, withSharesAndDividends: used.length, excludedNoAvData: uni.names.length - used.length, counts: uni.counts },
    data: { spy: "Alpaca SIP daily adjustment=all", days: days.length, windowDays: nWin, payments: { totalDollars, dropped: drop, nonTradingDollarShare: totalDollars ? drop.nonTradingDollars / totalDollars : null }, splitDiagnosticAAPLMay2020: splitDiag },
    ...R, verdict, avCallsLogged: av.callsUsed((r) => r.caller === ID || r.caller === "r181-probe") };
  writeJsonAtomic(OUT, out);
  console.log(verdict);
  // N10: sanity gates for sealing — coverage is asserted before read(); here, the sample must be the registered size.
  if (nWin < 1800 || !used.length) { console.error("sanity failed (window days or no dividend data) — NOT sealed"); process.exit(3); }
  seals.tests[ID] = { sealedOn: new Date().toISOString().slice(0, 10), unit: "trading days", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  ENTRY.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict }) + "\n");
  console.log(`${ID} sealed.`);
}

// ---------- self-test: synthetic only -----------------------------------------------------------------------------------------
function selftest() {
  const g = mulberry(7); const norm = () => Math.sqrt(-2 * Math.log(g() + 1e-12)) * Math.cos(2 * Math.PI * g());
  const days = []; const d0 = Date.parse("2018-01-02");
  for (let i = 0, n = 0; n < 2180; i++) { const d = new Date(d0 + i * 864e5); if (d.getUTCDay() % 6 === 0) continue; n++; days.push({ d: d.toISOString().slice(0, 10), paid: g() < 0.6 ? Math.exp(3 * norm()) : 0 }); }
  const { heavy } = rankHeavy(days);
  for (const eff of [0, 0.002]) {
    const R = computeRead(days.map((x, i) => ({ ...x, ret: 0.0003 + 0.01 * norm() + (heavy[i] ? eff : 0) })), 2.308);
    console.log(`selftest injected ${eff * 1e4} bp/day: diff ${R.primary.diffBpPerDay.toFixed(1)} bp, t ${R.primary.t.toFixed(2)}, placebo p95 ${R.placebo.p95.toFixed(2)} beaten=${R.placebo.trueBeatsP95}, pass=${R.pass}, Q4 t ${R.q4.t.toFixed(2)}, heavy days ${R.primary.nA}/${R.primary.nA + R.primary.nB}`);
  }
  console.log("selftest wrote nothing.");
}

(async () => {
  if (process.argv.includes("--selftest")) return selftest();
  const uni = fs.existsSync(UNI) ? JSON.parse(fs.readFileSync(UNI, "utf8")) : await freeze();
  if (process.argv.includes("--status")) return void status(uni);
  if (!coverage(uni).complete) { if (!av.hasKey()) { console.error("no AV key"); process.exit(1); } await fetchSome(uni); }
  const c = status(uni);
  if (!c.complete) { console.log("R181: coverage incomplete — NOT read, NOT sealed. Re-run tomorrow to resume."); return; }
  await read(uni);
})().catch((e) => { console.error("r181 FAILED:", e.message); process.exit(1); });
