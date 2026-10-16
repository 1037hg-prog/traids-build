#!/usr/bin/env node
/**
 * R296 — Cumulative-delta divergence at a new session extreme (SPY, QQQ). Registered 2026-09-30 (the registry wins:
 * backend/data/test-registry.json, id R296; rule, statistic, unit, bar, control, placebo, halves and window fallback are FROZEN).
 *
 *   node backend/r296-delta-divergence.js --probe      fetch+cache ONE full SPY day, time it, write the window plan (full vs fallback)
 *   node backend/r296-delta-divergence.js --fetch      fill the per-day cache for the planned window (resumable, throttled)
 *   node backend/r296-delta-divergence.js --selftest   known answers (tick rule, CD/bars, no-signal day, hand-computed trade)
 *   node backend/r296-delta-divergence.js --read       the ONE registered read (refuses if sealed or output exists)
 *
 * RULE (registry text): Alpaca SIP trades 09:30:00-15:59:59 ET. Tick rule (up vs last DIFFERENT price = buy +size, down = sell -size,
 * equal = previous sign, first trade unsigned). CD = running sum of signed size from 09:30. 5-minute OHLC from the same trades.
 * Bearish divergence: at the close of a 5m bar ENDING 10:00..15:00 whose HIGH exceeds every earlier high of the session, if CD at this
 * bar's close < CD at the close of the bar that set the previous session high -> SHORT at the NEXT bar's open. Mirror: new LOW with CD
 * ABOVE CD at the previous-low bar -> LONG. First signal per side per session only. Exit: close of the 6th bar after entry (30 min)
 * or 15:55 ET, whichever is first. No stop, no target. Cost $0.01/share/side on entry and exit.
 * Statistic: per-session net return of that session's divergence trades (sessions with >= 1 signal), one-sample t over SESSIONS, per symbol.
 *
 * FIXED BEFORE THE READ (builder interpretations of registry wording, none changes the rule):
 *  B1 TRADE CONDITIONS (Alpaca /v2/stocks/meta/conditions/trade, tapes A/B/C, fetched 2026-09-30). EXCLUDED: any trade whose condition
 *     list contains  Z (Sold, out of sequence), U (extended-hours sold, out of sequence), L (sold last / late reporting),
 *     T (extended-hours trade / Form T), 4 (derivatively priced), B (average price, tapes A/B; bunched on tape C),
 *     W (average price, tape C). Everything else (regular, odd lot, intermarket sweep, opening/closing/reopening prints, etc.) is kept.
 *  B2 "previous session high" = the most recent bar (incl. the 09:30 bar) that set a new session high, whether or not it fired a signal.
 *     A new high requires a strict exceedance of the running max high of all earlier bars.
 *  B3 Entry = first retained trade price of bar k+1 (the next bar). Exit = close of bar k+6 (bars k+1..k+6 = 30 minutes). Latest signal
 *     bar ends 15:00 so the exit is 15:30 and the 15:55 cap never binds.
 *  B4 Net return per trade = (dir*(exit-entry) - 0.02)/entry. Session return = MEAN of that session's trade returns (1 or 2 trades).
 *  B5 Half-day sessions (>=5 empty 5-minute bars before 15:30 ET; amended pre-read, caught in the cache audit: stray post-close SPY prints defeated a last-trade test) are skipped entirely and counted.
 *  B6 Control = same rule without the delta condition: first new session high after 10:00 -> short, first new low -> long.
 *  B7 Placebo = delta labels permuted WITHIN each session x side group of new-extreme events (keeps direction and the set of signal
 *     sessions), 1000 draws, seeded; observed mean must exceed the draw p95.
 *  B8 Halves = sessions with signals split at the median session date of the whole window. PASS needs both halves' means the same sign.
 *  B9 Cache stores the per-day signed 5-minute bars (o,h,l,c,cd,n) built while streaming the trades (lossless for this rule; raw trades
 *     at ~1M/day/symbol would be >10 GB). Window decision (full vs the registered 250-session fallback) is written by --probe.
 *  B10 THROTTLE 500 ms between requests (120/min) across the process; 429/5xx/network errors retry with back-off, never crash.
 */
"use strict";
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), CACHE = D("training/r296"), OUT = D("r296-delta-divergence.json"), PLAN = path.join(CACHE, "plan.json");
const SYMS = ["SPY", "QQQ"], FIRST = "2024-10-01", LAST = "2026-09-29", FALLBACK_N = 250, MAX_FETCH_H = 3;
const EXCL = new Set(["Z", "U", "L", "T", "4", "B", "W"]);
const COST_SHARE = 0.01, BAR_SEC = 300, NBARS = 78, K_MIN = 5, K_MAX = 65, HOLD = 6, DRAWS = 1000, REQ_MS = 500;
const mode = ["--probe", "--fetch", "--selftest", "--read"].find((m) => process.argv.includes(m)) || "--selftest";
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- pure logic (selftested) ----------
const keep = (conds) => !(conds || []).some((c) => EXCL.has(c));

/** Streaming builder: feed trades in time order; produces 5m bars with CD at close. */
function makeDay(openSec) {
  const bars = []; let last = null, sign = 0, cd = 0, kept = 0;
  return {
    add(tSec, p, s) {
      const k = Math.floor((tSec - openSec) / BAR_SEC); if (k < 0 || k >= NBARS) return;
      if (last == null) sign = 0; else if (p > last) sign = 1; else if (p < last) sign = -1;   // equal keeps previous sign (0 until one exists)
      last = p;
      cd += sign * s; kept++;
      const b = bars[k] || (bars[k] = { o: p, h: p, l: p, c: p, cd, n: 0 });
      if (p > b.h) b.h = p; if (p < b.l) b.l = p; b.c = p; b.cd = cd; b.n++;
    },
    finish() { return { kept, bars: Array.from({ length: NBARS }, (_, i) => bars[i] || null) }; },
  };
}

/** New-extreme events of one session. bars: array of 78 {o,h,l,c,cd,n}|null. Returns [{side:'H'|'L', k, div, gross, net, entry, exit}] */
function events(bars) {
  const out = []; let hi = -Infinity, lo = Infinity, hiBar = -1, loBar = -1;
  for (let k = 0; k < NBARS; k++) {
    const b = bars[k]; if (!b) continue;
    const newH = k > 0 && b.h > hi, newL = k > 0 && b.l < lo;
    const inWin = k >= K_MIN && k <= K_MAX, e = bars[k + 1], x = bars[k + HOLD];
    if (inWin && e && x) {
      if (newH && hiBar >= 0) out.push(mk("H", k, b.cd < bars[hiBar].cd, e.o, x.c));
      if (newL && loBar >= 0) out.push(mk("L", k, b.cd > bars[loBar].cd, e.o, x.c));
    }
    if (k === 0 || newH) { hi = Math.max(hi, b.h); hiBar = k; }
    if (k === 0 || newL) { lo = Math.min(lo, b.l); loBar = k; }
  }
  return out;
  function mk(side, k, div, entry, exit) {
    const dir = side === "H" ? -1 : 1, g = (dir * (exit - entry)) / entry, c = (2 * COST_SHARE) / entry;
    return { side, k, div, gross: g, net: g - c, entry, exit };
  }
}
/** Session return of an arm: mean over the first qualifying event of each side. null if none. */
function sessRet(evs, filt, field) {
  const pick = []; for (const s of ["H", "L"]) { const e = evs.find((x) => x.side === s && filt(x)); if (e) pick.push(e[field]); }
  return pick.length ? mean(pick) : null;
}

// ---------- fetch ----------
let nextAt = 0, reqCount = 0;
async function getJson(url) {
  const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
  if (!H["APCA-API-KEY-ID"] || !H["APCA-API-SECRET-KEY"]) throw new Error("ALPACA keys missing from backend/.env");
  for (let a = 0; a < 40; a++) {
    const w = nextAt - Date.now(); if (w > 0) await nap(w); nextAt = Math.max(Date.now(), nextAt) + REQ_MS; reqCount++;
    try {
      const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(90000) });
      if (r.ok) return await r.json();
      if (r.status !== 429 && r.status < 500) throw Object.assign(new Error(`HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`), { fatal: true });
      const ra = Number(r.headers.get("retry-after")), back = ra > 0 ? ra * 1000 : Math.min(120000, 2000 * 2 ** Math.min(a, 6));
      log(`retry ${r.status} wait ${back}ms`); await nap(back);
    } catch (e) { if (e.fatal) throw e; const back = Math.min(120000, 2000 * 2 ** Math.min(a, 6)); log(`retry ${e.message} wait ${back}ms`); await nap(back); }
  }
  throw new Error("too many retries: " + url.replace(/page_token=[^&]+/, "page_token=.."));
}
function etOffset(date) {   // "-04:00" / "-05:00" for that date at noon ET
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" }).formatToParts(new Date(date + "T17:00:00Z")).find((x) => x.type === "timeZoneName").value;
  const h = Number(p.replace("GMT", "")); return (h < 0 ? "-" : "+") + String(Math.abs(h)).padStart(2, "0") + ":00";
}
const dayFile = (sym, date) => path.join(CACHE, sym, date + ".json");
async function fetchDay(sym, date) {
  const f = dayFile(sym, date); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const off = etOffset(date), start = `${date}T09:30:00${off}`, end = `${date}T16:00:00${off}`, openSec = Date.parse(start) / 1000, closeSec = openSec + 23400;
  const day = makeDay(openSec), excl = {}; let tok = null, pages = 0, raw = 0;
  do {
    const u = `https://data.alpaca.markets/v2/stocks/${sym}/trades?feed=sip&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=10000` + (tok ? `&page_token=${encodeURIComponent(tok)}` : "");
    const j = await getJson(u); pages++;
    for (const x of j.trades || []) {
      raw++;
      if (!keep(x.c)) { for (const c of x.c) if (EXCL.has(c)) excl[c] = (excl[c] || 0) + 1; continue; }
      const ts = Date.parse(x.t.slice(0, 19) + "Z") / 1000; if (ts < openSec || ts >= closeSec) continue;
      day.add(ts, x.p, x.s);
    }
    tok = j.next_page_token || null;
  } while (tok);
  const fin = day.finish(), rec = { sym, date, raw, kept: fin.kept, pages, excluded: excl, bars: fin.bars.map((b) => b && [b.o, b.h, b.l, b.c, b.cd, b.n]) };
  fs.mkdirSync(path.dirname(f), { recursive: true }); writeJsonAtomic(f, rec, { pretty: 0 }); return rec;
}
const unpack = (rec) => rec.bars.map((b) => b && { o: b[0], h: b[1], l: b[2], c: b[3], cd: b[4], n: b[5] });

async function sessions() {
  const cf = path.join(CACHE, "sessions.json"); if (fs.existsSync(cf)) return JSON.parse(fs.readFileSync(cf, "utf8"));
  const { fetchBars } = require("./lib/alpaca-bars.js");
  const r = await fetchBars(["SPY"], { start: FIRST, end: LAST, timeframe: "1Day", feed: "sip", adjustment: "raw", quiet: true });
  const d = r.bars.SPY.map((b) => b.t.slice(0, 10)).filter((x) => x >= FIRST && x <= LAST).sort();
  fs.mkdirSync(CACHE, { recursive: true }); writeJsonAtomic(cf, d); return d;
}
const plan = () => (fs.existsSync(PLAN) ? JSON.parse(fs.readFileSync(PLAN, "utf8")) : null);
const windowDates = (all, p) => (p.window === "fallback" ? all.slice(-FALLBACK_N) : all);

// ---------- modes ----------
function selftest() {
  let ok = true; const chk = (name, cond, extra = "") => { console.log(`${cond ? "OK  " : "FAIL"} ${name} ${extra}`); if (!cond) ok = false; };
  // 1 tick rule on a hand-made tape. 100,100,101,101,100,100,99 sizes 10,5,7,3,4,2,6 -> CD 0,0,7,10,6,4,-2 ; first two unsigned
  const tape = [[100, 10], [100, 5], [101, 7], [101, 3], [100, 4], [100, 2], [99, 6]], cds = [];
  const d1 = makeDay(0); for (let i = 0; i < tape.length; i++) { d1.add(i, tape[i][0], tape[i][1]); cds.push(d1.finish().bars[0].cd); }
  chk("tick-rule CD path", JSON.stringify(cds) === JSON.stringify([0, 0, 7, 10, 6, 4, -2]), JSON.stringify(cds));
  // 1b condition filter
  chk("condition filter", keep([" ", "F", "I"]) && keep(["@"]) && keep([]) && !keep([" ", "Z"]) && !keep(["4"]) && !keep(["T"]) && !keep(["B"]) && !keep(["W"]) && !keep(["U"]) && !keep(["L"]) && keep(["O", "6"]));
  // 2 bar construction: two bars, hand OHLC/CD
  const d2 = makeDay(1000); [[1000, 50, 5], [1100, 51, 2], [1200, 49, 4], [1299, 50, 1], [1300, 52, 3], [1500, 51, 8]].forEach((t) => d2.add(...t));
  const f2 = d2.finish().bars;   // bar0: 50(0),51(+2),49(-4),50(+1) => o50 h51 l49 c50 cd -1 ; bar1: 52(+3),51(-8) => o52 h52 l51 c51 cd -6
  chk("bar0 OHLC/CD", f2[0].o === 50 && f2[0].h === 51 && f2[0].l === 49 && f2[0].c === 50 && f2[0].cd === -1 && f2[0].n === 4, JSON.stringify(f2[0]));
  chk("bar1 OHLC/CD", f2[1].o === 52 && f2[1].h === 52 && f2[1].l === 51 && f2[1].c === 51 && f2[1].cd === -6 && f2[1].n === 2, JSON.stringify(f2[1]));
  // 3 no-signal day: totally flat => zero events, zero trades in both arms
  const flat = () => Array.from({ length: NBARS }, () => ({ o: 100, h: 100, l: 100, c: 100, cd: 0, n: 1 }));
  const ef = events(flat()); chk("flat day: zero events/trades", ef.length === 0 && sessRet(ef, () => true, "net") === null && sessRet(ef, (x) => x.div, "net") === null);
  // 3b confirmed-trend day: every bar a new high WITH rising CD => zero divergence trades; control has exactly one short
  const up = Array.from({ length: NBARS }, (_, k) => ({ o: 100 + k, h: 100 + k, l: 100 + k, c: 100 + k, cd: 10 * k, n: 1 }));
  const eu = events(up); chk("confirmed trend: zero divergence trades, control 1 short", sessRet(eu, (x) => x.div, "net") === null && eu.filter((x) => x.side === "H").length > 1 && sessRet(eu, () => true, "net") !== null);
  // 4 hand-made divergence: bar0 h101 cd50; bar6 h102 cd20 -> short at bar7 open 101.5, exit bar12 close 100.5
  const dv = flat(); dv[0] = { o: 100, h: 101, l: 100, c: 100, cd: 50, n: 1 }; dv[6] = { o: 100, h: 102, l: 100, c: 100, cd: 20, n: 1 };
  for (let k = 7; k < NBARS; k++) dv[k] = { o: 101.5, h: 101.5, l: 101.5, c: 101.5, cd: 20, n: 1 }; dv[12] = { o: 101.5, h: 101.5, l: 100.5, c: 100.5, cd: 20, n: 1 };
  const ed = events(dv), want = (1.0 - 0.02) / 101.5, wantG = 1.0 / 101.5;
  chk("divergence day: exactly one short trade", ed.length === 1 && ed[0].side === "H" && ed[0].div && ed[0].k === 6, JSON.stringify(ed.map((x) => [x.side, x.k, x.div])));
  chk("divergence trade net/gross by hand", Math.abs(sessRet(ed, (x) => x.div, "net") - want) < 1e-12 && Math.abs(sessRet(ed, (x) => x.div, "gross") - wantG) < 1e-12, `net ${sessRet(ed, (x) => x.div, "net")} want ${want}`);
  // 4b same day with CD CONFIRMING (cd at bar6 above bar0) => not a divergence, control still trades
  const cf = dv.map((b) => b && { ...b }); cf[6].cd = 80; const ec = events(cf);
  chk("confirming CD: no divergence, control trades", sessRet(ec, (x) => x.div, "net") === null && Math.abs(sessRet(ec, () => true, "net") - want) < 1e-12);
  // 5 bullish mirror: long when new low with CD above previous-low-bar CD
  const bl = flat(); bl[0] = { o: 100, h: 100, l: 99, c: 100, cd: -50, n: 1 }; bl[6] = { o: 100, h: 100, l: 98, c: 100, cd: -20, n: 1 };
  for (let k = 7; k < NBARS; k++) bl[k] = { o: 99.5, h: 99.5, l: 99.5, c: 99.5, cd: -20, n: 1 }; bl[12] = { o: 99.5, h: 100, l: 99.5, c: 100, cd: -20, n: 1 };
  const eb = events(bl); chk("bullish mirror: one long", eb.length === 1 && eb[0].side === "L" && eb[0].div && Math.abs(eb[0].net - (0.5 - 0.02) / 99.5) < 1e-12, JSON.stringify(eb.map((x) => [x.side, x.k, x.div, x.net])));
  console.log(ok ? "SELFTEST PASSED" : "SELFTEST FAILED"); process.exit(ok ? 0 : 1);
}

async function probe() {
  const all = await sessions(); log(`sessions ${all.length} ${all[0]}..${all.at(-1)}`);
  const f = dayFile("SPY", all.at(-1)); if (fs.existsSync(f)) fs.unlinkSync(f);
  const t0 = Date.now(), r = await fetchDay("SPY", all.at(-1)), sec = (Date.now() - t0) / 1000;
  const perDayReq = r.pages, estH = (all.length * 2 * perDayReq * REQ_MS) / 3.6e6, estHObs = (all.length * 2 * sec) / 3600;
  const est = Math.max(estH, estHObs), window = est > MAX_FETCH_H ? "fallback" : "full";
  const fbH = (FALLBACK_N * 2 * Math.max(perDayReq * REQ_MS / 1000, sec)) / 3600;
  const p = { decidedAt: new Date().toISOString(), probeDate: r.date, rawTrades: r.raw, keptTrades: r.kept, pagesPerDay: perDayReq, secPerDay: +sec.toFixed(1), sessions: all.length, estFullHours: +est.toFixed(1), estFallbackHours: +fbH.toFixed(1), maxHours: MAX_FETCH_H, window, fallbackSessions: FALLBACK_N };
  writeJsonAtomic(PLAN, p); console.log(JSON.stringify(p, null, 1));
}
async function fetchAll() {
  const p = plan(); if (!p) throw new Error("run --probe first"); const dates = windowDates(await sessions(), p).slice().reverse(), t0 = Date.now();   // newest first
  let done = 0; const total = dates.length * SYMS.length;
  for (const d of dates) for (const s of SYMS) { const had = fs.existsSync(dayFile(s, d)); await fetchDay(s, d); done++; if (!had && done % 10 === 0) log(`${done}/${total} ${s} ${d} reqs ${reqCount} elapsed ${((Date.now() - t0) / 60000).toFixed(1)}m`); }
  log(`fetch complete ${done}/${total} reqs ${reqCount}`);
}

function evalSymbol(sym, dates, barReq) {
  const sess = [];
  let halfDays = 0, missing = 0;
  for (const d of dates) {
    const f = dayFile(sym, d); if (!fs.existsSync(f)) { missing++; continue; }
    const rec = JSON.parse(fs.readFileSync(f, "utf8")), bars = unpack(rec);
    const gaps = bars.slice(0, 72).filter((b) => !b).length;
    if (gaps >= 5) { halfDays++; continue; }   // B5: half-day (>=5 empty 5m bars before 15:30 ET; stray post-close SPY prints on 11-28/12-24 made a last-trade test unreliable)
    sess.push({ date: d, evs: events(bars) });
  }
  if (missing) throw new Error(`${sym}: ${missing} cached days missing`);
  const get = (filt, field) => sess.map((s) => ({ date: s.date, r: sessRet(s.evs, filt, field) })).filter((x) => x.r !== null);
  const dN = get((x) => x.div, "net"), dG = get((x) => x.div, "gross"), cN = get(() => true, "net");
  const netA = dN.map((x) => x.r), grossA = dG.map((x) => x.r), ctrlA = cN.map((x) => x.r);
  // placebo: permute div labels within session x side
  let seed = 296296; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648), draws = [];
  const groups = []; for (const s of sess) for (const side of ["H", "L"]) { const g = s.evs.filter((e) => e.side === side); if (g.length) groups.push({ s, g, labels: g.map((e) => e.div) }); }
  for (let k = 0; k < DRAWS; k++) {
    const perSess = new Map();
    for (const { s, g, labels } of groups) {
      const l = labels.slice(); for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; }
      const idx = l.indexOf(true); if (idx >= 0) { if (!perSess.has(s.date)) perSess.set(s.date, []); perSess.get(s.date).push(g[idx].net); }
    }
    const rets = [...perSess.values()].map(mean); if (rets.length) draws.push(mean(rets));
  }
  draws.sort((a, b) => a - b); const p95 = draws[Math.floor(0.95 * draws.length)];
  const mid = sess[Math.floor(sess.length / 2)].date, h1 = dN.filter((x) => x.date < mid).map((x) => x.r), h2 = dN.filter((x) => x.date >= mid).map((x) => x.r);
  const years = sess.length / 252, cum = []; let c = 0, pk = 0, dd = 0; for (const x of netA) { c += 10000 * x; cum.push(c); pk = Math.max(pk, c); dd = Math.min(dd, c - pk); }
  const tNet = tOf(netA), mNet = mean(netA), mCtrl = mean(ctrlA);
  const halvesSame = h1.length > 0 && h2.length > 0 && Math.sign(mean(h1)) === Math.sign(mean(h2)) && mean(h1) !== 0;
  const beatsCtrl = mNet > mCtrl, beatsPlacebo = mNet > p95, clears = tNet >= barReq;
  return {
    symbol: sym, n: netA.length, sessionsInWindow: sess.length, halfDaysSkipped: halfDays, tradesDiv: sess.reduce((s, x) => s + x.evs.filter((e) => e.div).length, 0),
    statistic: "one-sample t of per-session net return (sessions with >=1 divergence trade)", tNet: +tNet.toFixed(3), tGross: +tOf(grossA).toFixed(3),
    meanNet: mNet, meanGross: mean(grossA), winRate: netA.filter((x) => x > 0).length / netA.length,
    placebo: { draws: draws.length, p95, observed: mNet, beats: beatsPlacebo }, control: { meanNet: mCtrl, t: +tOf(ctrlA).toFixed(3), n: ctrlA.length, divergenceExceedsControl: beatsCtrl },
    halves: { splitDate: mid, first: { meanNet: mean(h1), n: h1.length }, second: { meanNet: mean(h2), n: h2.length }, sameSign: halvesSame },
    dollarsAt10k: Math.round((10000 * mNet * netA.length) / years), maxDD: Math.round(dd), maxDDNote: "dollars, peak-to-trough of cumulative per-session net P&L at $10k notional per trade",
    checks: { clearsBar: clears, beatsControl: beatsCtrl, beatsPlacebo, halvesSameSign: halvesSame }, verdict: clears && beatsCtrl && beatsPlacebo && halvesSame ? "PASS" : "DID NOT PASS",
  };
}

function read() {
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), arr = Array.isArray(reg) ? reg : reg.preregistered, e = arr.find((x) => x.id === "R296");
  if (!e || !(e.bar && e.bar.tRequired > 0)) throw new Error("R296 bar missing from registry");
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests || {}).R296) throw new Error("R296 already sealed — read-once");
  if (fs.existsSync(OUT)) throw new Error("R296 output exists — read-once");
  const p = plan(); if (!p) throw new Error("no plan.json");
  const all = JSON.parse(fs.readFileSync(path.join(CACHE, "sessions.json"), "utf8")), dates = windowDates(all, p), bar = e.bar.tRequired;
  const per = SYMS.map((s) => evalSymbol(s, dates, bar)), best = per.slice().sort((a, b) => b.tNet - a.tNet)[0], pass = per.some((x) => x.verdict === "PASS");
  const out = {
    id: "R296", key: "delta-divergence", name: e.name, rule: e.rule, window: { used: p.window, from: dates[0], to: dates.at(-1), sessions: dates.length, plan: p, registeredFallback: "most recent 250 sessions ending 2026-09-29 if a full fetch would exceed 3 hours" },
    unit: "sessions", bar, variants: 2, n: best.n, statistic: best.statistic + " (headline = best-tNet symbol " + best.symbol + "; bar is best-of-2)", tNet: best.tNet, tGross: best.tGross, meanNet: best.meanNet, meanGross: best.meanGross, winRate: best.winRate,
    placebo: best.placebo, control: best.control, halves: { first: best.halves.first, second: best.halves.second }, dollarsAt10k: best.dollarsAt10k, maxDD: best.maxDD,
    perSymbol: per, costModel: "$0.01/share/side on entry and exit (0.02/entry price per trade); gross reported beside net; only net counts",
    dataSources: ["Alpaca SIP historical trades /v2/stocks/{sym}/trades (feed=sip), condition codes excluded: " + [...EXCL].join(","), "Alpaca SIP daily bars for the session calendar"],
    knownWeaknesses: e.knownWeaknesses.concat(["Half-day sessions skipped; session return = mean of up to 2 trades; cache holds 5m signed bars, not raw trades (builder interpretations B1-B10 in script header)."]),
    verdictScript: pass ? "PASS" : "DID NOT PASS", readAt: new Date().toISOString(),
  };
  writeJsonAtomic(OUT, out);
  for (const x of per) console.log(`${x.symbol}: n ${x.n} tNet ${x.tNet} (bar ${bar}) tGross ${x.tGross} mean/sess ${(100 * x.meanNet).toFixed(4)}% | ctrl ${(100 * x.control.meanNet).toFixed(4)}% t ${x.control.t} n ${x.control.n} | placebo p95 ${(100 * x.placebo.p95).toFixed(4)}% beats ${x.placebo.beats} | halves ${(100 * x.halves.first.meanNet).toFixed(4)}% / ${(100 * x.halves.second.meanNet).toFixed(4)}% | $/yr@10k ${x.dollarsAt10k} maxDD ${x.maxDD} -> ${x.verdict}`);
  console.log("R296 verdictScript:", out.verdictScript, "window", p.window, OUT);
}

(async () => {
  if (mode === "--selftest") return selftest();
  if (mode === "--probe") return probe();
  if (mode === "--fetch") return fetchAll();
  return read();
})().catch((e) => { console.error("R296 FAILED:", e.message); process.exit(1); });
