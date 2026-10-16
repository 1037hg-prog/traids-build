#!/usr/bin/env node
/**
 * R183 — LATE EARNINGS DATES (Johnson & So 2018). Registered 2026-09-24 (family SCOUT-0924) before this file existed; the rule,
 * statistic, bar, controls and decision rule are read from data/test-registry.json.
 *
 *   node backend/r183-late-earnings.js              freeze the fetch universe (once), fetch up to --max=N missing AV EARNINGS
 *                                                   histories (default 25), then READ + SEAL only if coverage is complete
 *   node backend/r183-late-earnings.js --status     coverage only (no AV calls, no outcome)
 *   node backend/r183-late-earnings.js --selftest   (a) statistic path on SYNTHETIC returns, (b) date/lateness parser on the
 *                                                   already-cached R147 EARNINGS files — counts only, no returns; writes nothing
 *
 * EARNINGS sources: data/r147-earnings/<SYM>.json (fetched 2026-09-23 for R147 — same AV function) is reused as-is; everything
 * else is fetched into data/training/scout-0924/EARNINGS/ via lib/av-scout-cache.js. The read refuses unless EVERY frozen name
 * has an EARNINGS reply (an empty reply counts as "no AV EARNINGS history" -> not in the universe).
 *
 * IMPLEMENTATION NOTES (fixed before any R183 outcome was computed; none chosen from results):
 *  N1 Fetch universe (frozen to data/r183-universe.json): every symbol of the v2 panel (data/anomaly-cache-v2, Alpaca SIP daily,
 *     adjustment=all, active + delisted since 2016) whose AV LISTING_STATUS assetType is Stock and whose 20-day median dollar
 *     volume (close x volume, >= 15 valid of the last 20 sessions, as in r175) is >= $25M on at least one session with a date in
 *     2019-01-01..2026-08-31. ETFs are excluded up front because they have no EARNINGS history by definition. The per-event
 *     liquidity test is applied again at the flag-day close (the rule's point-in-time universe).
 *  N2 Quarter matching: rows need a valid fiscalDateEnding and reportedDate; duplicate fiscalDateEnding rows keep AV's first.
 *     "The same fiscal quarter one year earlier" = the row whose fiscalDateEnding is within +/-15 calendar days of
 *     (fiscalDateEnding - 1 year), nearest first (ties: seeded random key). No match -> the quarter is not evaluated.
 *  N3 Expected date E = that prior row's reportedDate + 364 days (52 weeks, same weekday) — AMENDED 2026-09-24 from +1 calendar year.
 *  N4 Flag day = E + 2 trading days = the trading day two sessions after the last trading day <= E (E on a weekend: Mon is +1,
 *     Tue is +2). "Late" iff reportedDate > flag day, or reportedDate == flag day with reportTime 'post-market' (reported after
 *     the close, so not "by then"). Signal month = the flag day's calendar month; flag days 2019-01-01..2026-08-31.
 *  N5 On-time placebo = |reportedDate - E| <= 2 CALENDAR days, run through the identical pipeline (flag day, liquidity at the
 *     flag-day close, next-open entry, 21 sessions, cost). "Must not show the same underperformance" is read as: the placebo's
 *     NW t (same sign convention) is BELOW the registered bar.
 *  N6 Position: short at the open of flag+1, covered at the close of flag+21 (21 sessions). SPY (Alpaca SIP daily adjustment=all)
 *     over the same open(flag+1)->close(flag+21). A name whose closes stop inside the window (delisting) is covered at its last
 *     valid close and holds cash thereafter; SPY runs the full window. Events whose window ends after the panel's last date, or
 *     with no valid entry open, are dropped (counted).
 *  N7 Sign: the registry statistic is "(late-name return - SPY), net". Oriented as the SHORT's net P&L so that the hypothesised
 *     underperformance is positive: per event x = (SPY - name) - 0.0040 (20 bps per side on the name leg, 2 sides; no cost on
 *     the SPY benchmark). The raw mean (name - SPY) is also reported. PASS needs NW t(x) >= bar.
 *  N8 Per signal month: equal-weight mean of x over that month's late events; months with no late event are absent. t = mean /
 *     Newey-West(lag 1, Bartlett) standard error over those months.
 *  N9 Peek control: per month, rank ALL evaluated events of that month (late, on-time and other, same pipeline) by realised
 *     21-session name return (raw, ascending; ties: seeded random key), take the worst k where k = that month's late count, and
 *     compute the same statistic. It must clear the bar; if it does not, the pipeline is broken and the read is NOT sealed.
 *  N10 Seal discipline (house precedent, R175): the peek is a pipeline sanity control and gates SEALING; the on-time placebo
 *     gates the VERDICT (PASS needs t >= bar AND placebo t < bar AND peek >= bar).
 *  N11 Ticker reuse: AV EARNINGS is keyed by today's ticker; a panel symbol reused by a different company can carry the wrong
 *     history. Events need a valid panel close at the flag day; no further matching is attempted (disclosed weakness).
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const av = require("./lib/av-scout-cache.js");
const D = (f) => path.join(__dirname, "data", f), PANEL = D("anomaly-cache-v2"), R147DIR = D("r147-earnings");
const ID = "R183", UNI = D("r183-universe.json"), OUT = D("r183-late-earnings.json");
const WIN0 = "2019-01-01", WIN1 = "2026-08-31", COST_SIDE = 0.002, HOLD = 21, SEED = 18301;
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const MAX = +arg("max", 25);

// ---------- stats ----------------------------------------------------------------------------------------------------------
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function nwT(a, L = 1) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * g / n; } return v > 0 ? m / Math.sqrt(v / n) : null; }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const dayMs = 864e5, dNum = (s) => Date.parse(s + "T00:00:00Z"), isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
// Amendment 2026-09-24 (pre-evidence, operator): E = prior reportedDate + 364 days (52 weeks, same weekday), as Johnson & So.
const addYear = (s) => new Date(dNum(s) + 364 * 86400000).toISOString().slice(0, 10);

// ---------- panel ------------------------------------------------------------------------------------------------------------
let P = null;
function panel() {
  if (P) return P;
  const meta = JSON.parse(fs.readFileSync(path.join(PANEL, "meta.json"), "utf8")), T = meta.dates.length, N = meta.symbols.length;
  const rd = (f) => { const b = fs.readFileSync(path.join(PANEL, f)); return new Float32Array(b.buffer, b.byteOffset, N * T); };
  P = { meta, T, N, DATES: meta.dates, SYMS: meta.symbols, C: rd("close.f32"), O: rd("open.f32"), V: rd("vol.f32") };
  P.c = (s, t) => P.C[s * T + t]; P.o = (s, t) => P.O[s * T + t];
  P.liquid = (s, t) => { const dv = []; for (let k = t - 19; k <= t; k++) { if (k < 0) continue; const x = P.c(s, k) * P.V[s * T + k]; if (Number.isFinite(x)) dv.push(x); } if (dv.length < 15) return false; dv.sort((a, b) => a - b); return dv[dv.length >> 1] >= 25e6; };
  return P;
}

// ---------- universe (N1) ------------------------------------------------------------------------------------------------------
function freeze() {
  const p = panel(); const stock = new Set();
  for (const f of ["av-listing-status-active-2026-09-23.csv", "av-listing-status-delisted-2026-09-23.csv"])
    for (const r of fs.readFileSync(D(f), "utf8").trim().split(/\r?\n/).slice(1)) { const c = r.split(","); if (c[c.length - 4] === "Stock") stock.add(c[0]); }
  const t0 = p.DATES.findIndex((d) => d >= WIN0); let t1 = p.DATES.findIndex((d) => d > WIN1) - 1; if (t1 < 0) t1 = p.T - 1;
  const rows = [];
  for (let s = 0; s < p.N; s++) { if (!stock.has(p.SYMS[s])) continue; let k = 0; for (let t = t0; t <= t1; t++) if (p.c(s, t) > 0 && p.liquid(s, t)) k++; if (k) rows.push({ sym: p.SYMS[s], eligibleSessions: k }); }
  const rng = mulberry(SEED); rows.forEach((r) => { r.key = rng(); });
  rows.sort((a, b) => (b.eligibleSessions - a.eligibleSessions) || (a.key - b.key));
  const names = rows.map((r) => r.sym);
  const body = { spec: "r183-universe-v1", frozenAt: new Date().toISOString(), test: ID, rule: "N1 in r183-late-earnings.js", panel: { spec: p.meta.spec, builtAt: p.meta.builtAt, lastDate: p.DATES[p.T - 1] },
    order: "eligible sessions desc, seeded random tie-break (fetch order only; the read needs every name)", counts: { names: names.length, reusedFromR147: names.filter((s) => fs.existsSync(path.join(R147DIR, s + ".json"))).length }, names,
    eligibleSessions: Object.fromEntries(rows.map((r) => [r.sym, r.eligibleSessions])) };
  body.sha256 = crypto.createHash("sha256").update(names.join(",")).digest("hex");
  writeJsonAtomic(UNI, body); console.log(`R183 universe frozen: ${names.length} stock names · ${body.counts.reusedFromR147} already held from R147 · sha ${body.sha256.slice(0, 12)}`);
  return body;
}

// ---------- EARNINGS source + coverage ------------------------------------------------------------------------------------------
function earnings(sym) {
  const f = path.join(R147DIR, sym + ".json");
  if (fs.existsSync(f)) return { src: "r147", rows: JSON.parse(fs.readFileSync(f, "utf8")).quarterlyEarnings || [] };
  const c = av.read("EARNINGS", sym); if (!c) return null;
  return { src: "scout", rows: (c.response && c.response.quarterlyEarnings) || [] };
}
function coverage(uni) { const todo = uni.names.filter((s) => !earnings(s)); return { names: uni.names.length, held: uni.names.length - todo.length, todo, complete: !todo.length }; }
async function fetchSome(uni) {
  let used = 0;
  try { for (const s of coverage(uni).todo) { if (used >= MAX) break; const r = await av.get("EARNINGS", s, {}, { caller: ID }); if (!r.cached) used++; } }
  catch (e) { console.log(`  ${e instanceof av.QuotaStop ? e.message : "fetch error: " + e.message} (after ${used} call(s) this run)`); }
  return used;
}
const status = (uni) => { const c = coverage(uni); console.log(`R183 coverage — EARNINGS ${c.held}/${c.names} names held · ${c.complete ? "COMPLETE — readable" : `${c.todo.length} AV call(s) left (~${Math.ceil(c.todo.length / 25)} day(s) at 25/day)`} · AV calls logged by R183: ${av.callsUsed((r) => r.caller === ID)}`); return c; };

// ---------- quarter events (N2-N4) -------------------------------------------------------------------------------------------------
/** returns [{F, R, time, E, flagIdx, late, onTime}] for one name; tradingDates = sorted trading days */
function quarterEvents(rows, tradingDates, rng) {
  const seen = new Set(), q = [];
  for (const r of rows) { if (!isDate(r.fiscalDateEnding) || !isDate(r.reportedDate) || seen.has(r.fiscalDateEnding)) continue; seen.add(r.fiscalDateEnding); q.push({ F: r.fiscalDateEnding, R: r.reportedDate, time: r.reportTime || null, key: rng() }); }
  const lastLE = (d) => { let lo = 0, hi = tradingDates.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (tradingDates[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
  const out = [];
  for (const x of q) {
    const target = dNum(x.F) - 365.25 * dayMs;
    const cands = q.filter((y) => y !== x && Math.abs(dNum(y.F) - target) <= 15.5 * dayMs).sort((a, b) => (Math.abs(dNum(a.F) - target) - Math.abs(dNum(b.F) - target)) || (a.key - b.key));
    if (!cands.length) continue;
    const E = addYear(cands[0].R), i0 = lastLE(E); if (i0 < 0) continue; const flagIdx = i0 + 2; if (flagIdx >= tradingDates.length) continue;
    const flag = tradingDates[flagIdx];
    const late = x.R > flag || (x.R === flag && x.time === "post-market");
    const onTime = Math.abs(dNum(x.R) - dNum(E)) <= 2 * dayMs;
    out.push({ F: x.F, R: x.R, time: x.time, E, flag, flagIdx, late, onTime });
  }
  return out;
}

// ---------- statistic core (pure; shared with --selftest) ---------------------------------------------------------------------
/** ev: [{month, late, onTime, rN, rS}] — every evaluated event (liquid at flag, complete window) */
function computeRead(ev, bar) {
  const x = (e) => (e.rS - e.rN) - 2 * COST_SIDE;
  const monthly = (sel) => { const m = new Map(); for (const e of ev) if (sel(e)) (m.get(e.month) || m.set(e.month, []).get(e.month)).push(e); return [...m.keys()].sort().map((k) => ({ month: k, n: m.get(k).length, v: mean(m.get(k).map(x)), raw: mean(m.get(k).map((e) => e.rN - e.rS)) })); };
  const summ = (ms) => ({ months: ms.length, events: ms.reduce((s, r) => s + r.n, 0), meanNetShortPerMonth: ms.length ? mean(ms.map((r) => r.v)) : null, meanRawNameMinusSpy: ms.length ? mean(ms.map((r) => r.raw)) : null, nwT: nwT(ms.map((r) => r.v), 1) });
  const lateM = monthly((e) => e.late), primary = summ(lateM);
  const placeboM = monthly((e) => e.onTime), placebo = summ(placeboM);
  // peek (N9)
  const rng = mulberry(SEED + 1), byM = new Map(); for (const e of ev) (byM.get(e.month) || byM.set(e.month, []).get(e.month)).push({ e, key: rng() });
  const peekRows = [];
  for (const r of lateM) { const pool = [...byM.get(r.month)].sort((a, b) => (a.e.rN - b.e.rN) || (a.key - b.key)).slice(0, r.n); peekRows.push({ month: r.month, n: pool.length, v: mean(pool.map((z) => x(z.e))), raw: mean(pool.map((z) => z.e.rN - z.e.rS)) }); }
  const peek = summ(peekRows);
  const placeboMet = placebo.nwT == null || placebo.nwT < bar, peekMet = peek.nwT != null && peek.nwT >= bar;
  const pass = primary.nwT != null && primary.nwT >= bar && placeboMet && peekMet;
  return { bar, primary, placebo: { ...placebo, met: placeboMet, criterion: "on-time NW t < bar (N5)" }, peek: { ...peek, met: peekMet, criterion: "worst-k by realised 21d return must clear the bar (N9)" }, pass, monthly: lateM };
}

// ---------- the read ---------------------------------------------------------------------------------------------------------
async function read(uni) {
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests[ID]) { console.error(`${ID} already sealed — refusing`); process.exit(2); }
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), ENTRY = reg.preregistered.find((t) => t.id === ID); if (!ENTRY) { console.error(`${ID} not registered`); process.exit(2); }
  const BAR = ENTRY.bar.tRequired, p = panel();
  const { fetchBars } = require("./lib/alpaca-bars.js");
  const { bars } = await fetchBars(["SPY"], { start: "2018-12-01", end: p.DATES[p.T - 1] + "T23:59:59Z", timeframe: "1Day", feed: "sip", adjustment: "all", requireAll: true, quiet: true });
  const spy = new Map(bars.SPY.map((b) => [String(b.t).slice(0, 10), b]));
  const symIdx = new Map(p.SYMS.map((s, i) => [s, i])), rng = mulberry(SEED + 2);
  const ev = [], drop = { noPrior: 0, outsideWindow: 0, noFlagClose: 0, illiquid: 0, noEntryOpen: 0, windowPastPanel: 0, noSpy: 0 }; let quarters = 0, namesWithHistory = 0;
  for (const sym of uni.names) {
    const E = earnings(sym); if (!E || !E.rows.length) continue; namesWithHistory++; const s = symIdx.get(sym);
    const qs = quarterEvents(E.rows, p.DATES, rng); quarters += E.rows.length; drop.noPrior += Math.max(0, E.rows.length - qs.length);
    for (const q of qs) {
      if (q.flag < WIN0 || q.flag > WIN1) { drop.outsideWindow++; continue; }
      const t = q.flagIdx; if (!(p.c(s, t) > 0)) { drop.noFlagClose++; continue; }
      if (!p.liquid(s, t)) { drop.illiquid++; continue; }
      if (t + HOLD > p.T - 1) { drop.windowPastPanel++; continue; }
      const eo = p.o(s, t + 1); if (!(eo > 0)) { drop.noEntryOpen++; continue; }
      let xc = null; for (let k = t + HOLD; k >= t + 1; k--) if (p.c(s, k) > 0) { xc = p.c(s, k); break; } if (xc == null) { drop.noEntryOpen++; continue; }
      const so = spy.get(p.DATES[t + 1]), sc = spy.get(p.DATES[t + HOLD]); if (!so || !sc) { drop.noSpy++; continue; }
      ev.push({ sym, month: q.flag.slice(0, 7), flag: q.flag, E: q.E, R: q.R, late: q.late, onTime: q.onTime, rN: xc / eo - 1, rS: sc.c / so.o - 1 });
    }
  }
  const R = computeRead(ev, BAR);
  const f3 = (v) => (v == null ? "n/a" : v.toFixed(3));
  const verdict = (R.pass ? "PASS — " : "DID NOT PASS — ") + `late-name short net ${(R.primary.meanNetShortPerMonth * 1e4).toFixed(1)} bp/event-month, NW t ${f3(R.primary.nwT)} vs bar ${BAR} over ${R.primary.months} months (${R.primary.events} late events); on-time placebo t ${f3(R.placebo.nwT)} (${R.placebo.met ? "met" : "NOT met"}); peek t ${f3(R.peek.nwT)}`;
  const out = { id: ID, readOn: new Date().toISOString(), rule: ENTRY.rule, statistic: ENTRY.statistic, bar: ENTRY.bar, controls: ENTRY.controls,
    universe: { sha256: uni.sha256, fetchNames: uni.names.length, namesWithEarningsHistory: namesWithHistory },
    data: { panel: p.meta.spec + " built " + p.meta.builtAt, spy: "Alpaca SIP daily adjustment=all", quarterRows: quarters, events: ev.length, late: ev.filter((e) => e.late).length, onTime: ev.filter((e) => e.onTime).length, dropped: drop },
    ...R, verdict, avCallsLogged: av.callsUsed((r) => r.caller === ID) };
  writeJsonAtomic(OUT, out);
  console.log(verdict);
  if (!R.peek.met) { console.error("peek control failed — pipeline cannot see a known effect; NOT sealed (fix the pipeline, not the rule)"); process.exit(3); }
  seals.tests[ID] = { sealedOn: new Date().toISOString().slice(0, 10), unit: "signal months (NW lag 1)", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
  ENTRY.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: ID, verdict }) + "\n");
  console.log(`${ID} sealed.`);
}

// ---------- self-test --------------------------------------------------------------------------------------------------------
function selftest() {
  const g = mulberry(9), norm = () => Math.sqrt(-2 * Math.log(g() + 1e-12)) * Math.cos(2 * Math.PI * g());
  for (const eff of [0, -0.02]) {
    const ev = [];
    for (let m = 0; m < 92; m++) { const month = `${2019 + Math.floor(m / 12)}-${String(1 + (m % 12)).padStart(2, "0")}`; for (let i = 0; i < 300; i++) { const u = g(), late = u < 0.05, onTime = !late && u < 0.6, rS = 0.01 + 0.04 * norm(); ev.push({ month, late, onTime, rS, rN: rS + 0.10 * norm() + (late ? eff : 0) }); } }
    const R = computeRead(ev, 2.375);
    console.log(`selftest injected ${eff * 1e4} bp: late t ${R.primary.nwT.toFixed(2)} (${R.primary.events} ev/${R.primary.months} mo), placebo t ${R.placebo.nwT.toFixed(2)} met=${R.placebo.met}, peek t ${R.peek.nwT.toFixed(1)} met=${R.peek.met}, pass=${R.pass}`);
  }
  // parser check on the R147 cache: counts only, no prices touched
  const p = panel(), rng = mulberry(1); let names = 0, rows = 0, matched = 0, late = 0, onTime = 0, inWin = 0;
  for (const f of fs.readdirSync(R147DIR).filter((x) => x.endsWith(".json"))) { const r = JSON.parse(fs.readFileSync(path.join(R147DIR, f), "utf8")).quarterlyEarnings || []; if (!r.length) continue; names++; rows += r.length; const q = quarterEvents(r, p.DATES, rng); matched += q.length; for (const e of q) if (e.flag >= WIN0 && e.flag <= WIN1) { inWin++; if (e.late) late++; if (e.onTime) onTime++; } }
  console.log(`parser on R147 cache: ${names} names, ${rows} quarter rows, ${matched} with a prior-year match; in window ${inWin}: late ${late} (${(100 * late / inWin).toFixed(1)}%), on-time ${onTime} (${(100 * onTime / inWin).toFixed(1)}%) — lateness counts only, no returns`);
  console.log("selftest wrote nothing.");
}

(async () => {
  if (process.argv.includes("--selftest")) return selftest();
  const uni = fs.existsSync(UNI) ? JSON.parse(fs.readFileSync(UNI, "utf8")) : freeze();
  if (process.argv.includes("--status")) return void status(uni);
  if (!coverage(uni).complete) { if (!av.hasKey()) { console.error("no AV key"); process.exit(1); } await fetchSome(uni); }
  const c = status(uni);
  if (!c.complete) { console.log("R183: coverage incomplete — NOT read, NOT sealed. Re-run tomorrow to resume."); return; }
  await read(uni);
})().catch((e) => { console.error("r183 FAILED:", e.message); process.exit(1); });
