#!/usr/bin/env node
"use strict";
/**
 * PLAN E PAPER RECORD — Plan E's paper trade log + daily NAV from 2026-09-29 (the BOOK ETF book's paper start). Built 2026-10-09 on the
 * operator's word: "i need to get trading results from plan e on paper for at least one month prior to funding" and "when they would trade,
 * gains, losses, exit, etc". NOT wired into the close chain or the evening email (the main loop does that).
 *
 * READ-ONLY. GETs only: Alpaca /v2/calendar + SIP daily bars (main keys), the Alpaca BOOK paper account's orders / positions / activities
 * (BOOK keys, paper endpoint asserted), Coinbase public daily candles. No order, no notification. Writes ONLY data/planE-paper-scoreboard.json
 * and data/planE-paper-scoreboard-history.jsonl (lib/atomic-write.js), and only in --print.
 *
 * ANCHOR (the choice, stated): $100,000 = the BOOK's own "Plan E on a $100k book" (book-etf-rebalancer.js), of which the BOOK's BOOK_CAPITAL
 *   $73,000 is the ETF 73%. So the BOOK's REAL paper dollars count 1:1 (nothing in the ETF leg is scaled) and the other legs take their Plan E
 *   share of the same $100k: crypto W.BTC + W.ETH = 15% ($15,000); the remaining 12% ($12,000) is the ZN margin reserve.
 * LEGS
 *   ETF     the BOOK sub-book on its own Alpaca paper account. Only the rebalancer's own orders count: client_order_id "book-<YYYYMMDD>-<SYM>-<side>"
 *           (anything else in the account is listed and excluded). Fills = the broker's filled_qty / filled_avg_price / filled_at, cross-checked
 *           against data/book-etf-ledger.jsonl; if the broker cannot be read, the ledger's recorded broker fill prices (fill time not recorded).
 *           Leg value = $73,000 - buys + sells (+ broker-credited dividends / fees, if any) + holdings x SIP RAW close. Reasons come from the
 *           BOOK's own run records (initial allocation / month-end rebalance / 10-month signal flip / SGOV park / band trigger).
 *           Every record session needs a BOOK run (runs[D] or a ledger daily / month-end row; today's is due at close + 15 min): a session
 *           without one is UNKNOWN (Plan E's band / rebalance check was not made).
 *           The account is SHARED (other strategies' orders sit in it), so a broker FEE counts for Plan E only in proportion to Plan E's
 *           notional filled that ET day (REG/TAF: sells only; a fee naming a symbol: that symbol) and is spread over those Plan E fills by
 *           notional (the trade log's fees); a fee on a day with no fill is excluded and listed. A dividend on a symbol another order also
 *           holds is split by the broker's share count (none given -> UNKNOWN), with Plan E's ENTITLED shares = its fills before the ex (or
 *           record) date when the activity carries one; without one (Alpaca's DIV normally carries only the pay date) Plan E's holding must be
 *           unchanged from the prior month-end to the pay date, else the split is UNKNOWN (never split on the pay-date holding).
 *   ZN      R219's QUOTE-PRICED paper record (r219-zn-month-end.js: ask at the 6th-to-last session's close-arm, bid at the last session's;
 *           $2.50/contract/side ASSUMED by R219) scaled to Plan E: contract-equivalents = ZN_LEV (risk-manager.js) x Plan E NAV at the prior
 *           close / (ask x 1000). Leverage multiple k = 1 (data/plan-e-leverage.json is an exploratory table; no multiple is adopted). An open
 *           window is marked at the Schwab daily close in data/futures-daily/ZN.json when that store holds the window's contract; else UNKNOWN.
 *           A window that opened before the paper start is not Plan E's paper trade (noted); a window whose entry session is inside the record
 *           but which R219 never recorded (no entry, no no-quote, no skip) is UNKNOWN; an exit not recorded on its exit day is noted (R219's
 *           after-close LATE retry) and the window stays marked; once a later session is on record the ZN leg is UNKNOWN (stale) from it.
 *   CRYPTO  R191's record is NOT Plan E's sleeve (R191 = $10,000 per coin on the shared paper account since 2026-09-25), so the sleeve is
 *           DERIVED: R191's 50-day rule (its N and decision line, loaded by planE-tasty.js loadPlanE) on Coinbase completed UTC daily closes,
 *           Plan E's weights W.BTC / W.ETH of the anchor opened at the paper start, one cash slot per coin, every switch at that UTC close with
 *           the model's 25 bps per switch charged as the ASSUMED fee; parked coin cash earns 0 (as on the broker). Session D is marked at the UTC
 *           close of D-1 (the close R191's evening run decides on), so every row is final at the evening run. The sleeve runs on through the
 *           freshest completed close: a switch after the record's last mark is listed under UPCOMING as done (enters the record next session),
 *           and each coin's next decision shows its exact flip level (next close x flips iff x > mean of the last N-1 closes).
 *           SIZING — a stated DEVIATION: one cash slot per coin, so a re-entry buys with that coin's slot cash (its own past round trips) and
 *           the sleeve never band-rebalances. Plan E's executor (planE-tasty.js buildPlan) would instead target W[coin] x Plan E NAV with the
 *           BOOK band, and the model (risk-manager.js) is constant-weight W. The planE-tasty-sized variant (each re-entry's W x the latest
 *           Plan E NAV before that UTC close, and each held coin's drift vs W x NAV against the band) is in res.cryptoSizing and the notes,
 *           as part of the tracking difference.
 *   CASH    the $12,000 reserve, marked as SGOV (the BOOK's own parking instrument) on SIP adjusted closes; ZN P&L settles into it.
 * MODEL (expected return for the same day): risk-manager.js buildBook's rules — W, ZN_LEV, ZN_BETA, 10-month signal from the prior month-end,
 *   50-day crypto with 25 bps per switch, ZN proxied as ZN_LEV x ZN_BETA x (IEF - T-bill) on the last 5 sessions of the month (4 bps x ZN_LEV round trip; FINANCED since 2026-10-12),
 *   uninvested weight at the 3-month T-bill (FRED DTB3) — recomputed here on the FULL month calendar (risk-manager-forward.jsonl is not used:
 *   its rows from before the 2026-10-12 window fix used the current month's latest 5 sessions). Crypto on the same UTC-close alignment as the paper sleeve.
 *   Tracking (pp) = paper day % - model day %.
 * MODES
 *   --trades         trade log (FIFO per leg + symbol; open trades at the last mark) + upcoming trades; writes nothing
 *   --print          daily table + summary; writes the two files
 *   --line           ONE line for the evening email
 *   --month YYYY-MM  that month's $ table per leg
 *   --selftest       temp dir + fake inputs, known answers; no network, never touches data/
 * EXIT 0 ok · 1 crash / selftest failure · 2 usage · 3 UNKNOWN (an input or a leg could not be measured — printed first, as loud as a failure)
 */
const fs = require("fs"), path = require("path"), os = require("os");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic, writeTextAtomic } = require("./lib/atomic-write.js");

const BACKEND = __dirname;
const START = "2026-09-29";
const SPEC = "planE-paper-scoreboard-v1";
const CRYPTO_SWITCH_COST = 0.0025;   // risk-manager.js cryptoDaily: 25 bps per switch
const LEVERAGE_K = 1;                // data/plan-e-leverage.json: exploratory, no multiple adopted
const PAPER_BASE = "https://paper-api.alpaca.markets";
const BOOK_CID = /^book-(\d{4})(\d{2})(\d{2})-([A-Z]+)-(buy|sell)$/;
const DONE_STATUSES = ["filled", "canceled", "expired", "rejected", "done_for_day"];
const LEGS = ["etf", "crypto", "zn", "cash"];
const LEG_LABEL = { etf: "ETF", crypto: "CRYPTO", zn: "ZN", cash: "CASH" };
const SRC = { broker: "F", ledger: "L", quote: "Q", derived: "D", close: "C", zn: "Z" };
const BOOK_RUN_DUE_MIN = 15;         // the BOOK's daily run is due ~16:15 ET (book-etf-rebalancer.js: "this runs ~16:15 ET") = close + 15 min

// ================================================================ helpers ================================================================
const fin = (x) => typeof x === "number" && Number.isFinite(x);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => sum(a) / a.length;
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
const addMonths = (d, n) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + n, dd)).toISOString().slice(0, 10); };
const ymOf = (d) => d.slice(0, 7);
const prevYm = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };
const nextYm = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); };
const hm = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
const etParts = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, mins: (+p.hour % 24) * 60 + +p.minute, hhmm: `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}` }; };
const rnd = (x, dp = 2) => (fin(x) ? Math.round(x * 10 ** dp) / 10 ** dp : null);
const group = (a, k) => { const o = {}; for (const x of a) (o[k(x)] = o[k(x)] || []).push(x); return o; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (x, { sign = false, dp = 2 } = {}) => (!fin(x) ? "UNKNOWN" : `${x < 0 && Math.abs(x) >= 0.5 / 10 ** dp ? "-" : sign ? "+" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`);
const pct = (x, { dp = 2, sign = true } = {}) => (!fin(x) ? "UNKNOWN" : `${x < 0 && Math.abs(x) >= 0.5 / 10 ** dp ? "-" : sign ? "+" : ""}${Math.abs(x).toFixed(dp)}%`);
const pp = (x) => (!fin(x) ? "UNKNOWN" : `${x < 0 && Math.abs(x) >= 0.005 ? "-" : "+"}${Math.abs(x).toFixed(2)} pp`);
const num = (x, dp) => (!fin(x) ? "UNKNOWN" : x.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const pad = (s, n) => String(s).padEnd(n), padL = (s, n) => String(s).padStart(n);
const qtyStr = (leg, q) => (leg === "etf" ? num(q, 0) : leg === "zn" ? `${num(q, 3)} ct-eq` : num(q, 6));

function files(dataDir) {
  const D = (f) => path.join(dataDir, f);
  return { dataDir, out: D("planE-paper-scoreboard.json"), hist: D("planE-paper-scoreboard-history.jsonl"),
    bookState: D("book-etf-state.json"), bookLedger: D("book-etf-ledger.jsonl"), bookOff: D("book-etf-OFF"),
    r219State: D("r219-zn-month-end.json"), r219Ledger: D("r219-zn-month-end.jsonl"), r219Off: D("r219-OFF"),
    r191State: D("r191-crypto-trend.json"), znDaily: path.join(dataDir, "futures-daily", "ZN.json"),
    leverage: D("plan-e-leverage.json"), dtb3: path.join(dataDir, "training", "fred", "DTB3.csv") };
}

// ================================================================ inputs ================================================================
/** constants planE-tasty.js loadPlanE does not export, extracted from the same sources (fails loudly if they move) */
function extractExtra(dir) {
  const R = fs.readFileSync(path.join(dir, "risk-manager.js"), "utf8"), Z = fs.readFileSync(path.join(dir, "r219-zn-month-end.js"), "utf8");
  const b = /ZN_LEV = ([\d.]+), ZN_BETA = ([\d.]+);/.exec(R); if (!b) throw new Error("risk-manager.js ZN_LEV / ZN_BETA not found — Plan E source moved");
  const z = /^const QTY = (\d+), MULT = (\d+), BOOK = (\d+), FEE_SIDE = ([\d.]+),/m.exec(Z); if (!z) throw new Error("r219-zn-month-end.js QTY / MULT / BOOK / FEE_SIDE not found — R219 source moved");
  return { ZN_BETA: +b[2], R219: { QTY: +z[1], MULT: +z[2], BOOK: +z[3], FEE_SIDE: +z[4] } };
}

/** the local files; a required file that is absent or unparsable is UNKNOWN, never read as empty */
function readLocal(F) {
  const unknown = [], notes = [];
  const json = (f, what, required) => {
    if (!fs.existsSync(f)) { (required ? unknown : notes).push(`${what}: ${path.basename(f)} absent`); return null; }
    try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { unknown.push(`${what}: ${path.basename(f)} unparsable (${String(e.message).slice(0, 80)})`); return null; }
  };
  const jsonl = (f, what, required) => {
    if (!fs.existsSync(f)) { if (required) unknown.push(`${what}: ${path.basename(f)} absent`); return []; }
    const rows = []; fs.readFileSync(f, "utf8").split(/\r?\n/).forEach((l, i) => { if (!l.trim()) return; try { rows.push(JSON.parse(l)); } catch { unknown.push(`${what}: line ${i + 1} of ${path.basename(f)} unparsable`); } });
    return rows;
  };
  let dtb3 = null;
  if (fs.existsSync(F.dtb3)) { const byMonth = {}; let last = null; for (const l of fs.readFileSync(F.dtb3, "utf8").trim().split(/\r?\n/).slice(1)) { const [d, v] = l.split(","); if (d && v && v.trim() !== "." && fin(+v)) { byMonth[d.slice(0, 7)] = +v; last = d; } } dtb3 = { byMonth, last }; }
  else notes.push("model T-bill: DTB3.csv absent — the model uses risk-manager.js's 4% fallback");
  return {
    book: { state: json(F.bookState, "BOOK state", true), ledger: jsonl(F.bookLedger, "BOOK ledger", true), off: fs.existsSync(F.bookOff) },
    r219: { state: json(F.r219State, "R219 state", true), ledger: jsonl(F.r219Ledger, "R219 ledger", false), off: fs.existsSync(F.r219Off) },
    r191: json(F.r191State, "R191 state (cross-check only)", false),
    znDaily: json(F.znDaily, "ZN daily store", false),
    leverage: json(F.leverage, "Plan E leverage table", false),
    dtb3, unknown, notes,
  };
}

async function coinbaseDaily(coin, fromDay, nowMs) {   // completed UTC days only
  const todayUtc = new Date(nowMs).toISOString().slice(0, 10), out = new Map(), stop = Date.parse(todayUtc + "T00:00:00Z");
  for (let s = Date.parse(fromDay + "T00:00:00Z"); s < stop;) {
    const e = Math.min(stop, s + 290 * 864e5);
    const r = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`, { headers: { "User-Agent": "TRAIDS planE-paper-scoreboard" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`coinbase ${coin} HTTP ${r.status}`);
    const a = await r.json(); if (!Array.isArray(a)) throw new Error(`coinbase ${coin}: response is not a candle list`);
    for (const x of a) { const d = new Date(x[0] * 1000).toISOString().slice(0, 10); if (d < todayUtc && fin(+x[4])) out.set(d, +x[4]); }
    s = e; if (s < stop) await sleep(350);
  }
  return [...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, c]) => ({ d, c }));
}

/** the BOOK's own paper account — GETs only; the keys are never printed */
async function bookBroker() {
  const id = process.env.ALPACA_BOOK_KEY_ID, sec = process.env.ALPACA_BOOK_SECRET_KEY;
  if (!id || !sec) return { ok: false, error: "ALPACA_BOOK_KEY_ID / ALPACA_BOOK_SECRET_KEY not set" };
  if (!/^https:\/\/paper-api\.alpaca\.markets$/.test(PAPER_BASE)) return { ok: false, error: "not the paper endpoint — refusing" };
  const H = { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": sec, Accept: "application/json" };
  const get = async (p) => { const r = await fetch(PAPER_BASE + p, { method: "GET", headers: H, signal: AbortSignal.timeout(15000) }); const j = await r.json().catch(() => null); if (!r.ok) throw new Error(`GET ${p.split("?")[0]} HTTP ${r.status}`); return j; };
  try {
    const seen = new Map(); let after = `${addDays(START, -1)}T00:00:00Z`;
    for (let i = 0; i < 40; i++) {
      const page = await get(`/v2/orders?status=all&direction=asc&limit=500&nested=false&after=${encodeURIComponent(after)}`);
      if (!Array.isArray(page)) throw new Error("orders: not a list");
      for (const o of page) seen.set(o.id, o);
      if (page.length < 500) break; after = page[page.length - 1].submitted_at;
    }
    const positions = await get("/v2/positions"); if (!Array.isArray(positions)) throw new Error("positions: not a list");
    let activities = [], activitiesError = null;
    try { let token = null; for (let i = 0; i < 40; i++) { const page = await get(`/v2/account/activities?activity_types=DIV,FEE&after=${addDays(START, -1)}&direction=asc&page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ""}`); if (!Array.isArray(page)) throw new Error("activities: not a list"); activities.push(...page); if (page.length < 100) break; token = page[page.length - 1].id; } }
    catch (e) { activities = null; activitiesError = e.message; }
    return { ok: true, orders: [...seen.values()], positions, activities, activitiesError };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** everything over the network; each source that fails is UNKNOWN (never an empty series) */
async function fetchRemote(PE, nowMs, et) {
  const unknown = [], notes = [];
  let sessions = null;
  try { sessions = []; for (let ym = ymOf(START); ym <= nextYm(ymOf(et.date)); ym = nextYm(ym)) { const c = await PE.monthSessions(ym); if (!Array.isArray(c)) throw new Error(`calendar ${ym}: not a list`); sessions.push(...c.map((x) => ({ date: x.date, open: x.open, close: x.close }))); } }
  catch (e) { sessions = null; unknown.push(`NYSE calendar (Alpaca /v2/calendar via R219's monthSessions): ${e.message}`); }
  const { fetchBars } = require("./lib/alpaca-bars.js"), endIso = new Date(nowMs - 20 * 60e3).toISOString();   // SIP refuses windows ending within ~15 min of now (the BOOK's rule)
  const toArr = (r) => { const o = {}; for (const [s, bars] of Object.entries(r.bars || {})) o[s] = bars.map((b) => ({ d: String(b.t).slice(0, 10), c: +b.c })); return o; };
  let raw = null, adj = null;
  try { raw = toArr(await fetchBars(Object.keys(PE.SLEEVES), { start: addDays(START, -10), end: endIso, feed: "sip", adjustment: "raw", quiet: true, requireAll: false })); }
  catch (e) { unknown.push(`ETF raw closes (Alpaca SIP): ${e.message}`); }
  const adjSyms = [...new Set([...modelSyms(PE).trend, ...modelSyms(PE).hold, ...Object.keys(PE.SLEEVES).filter((k) => PE.SLEEVES[k].rule === "trend10m"), "IEF", "SGOV", "SPY"])];
  try { const r = await fetchBars(adjSyms, { start: addDays(START, -480), end: endIso, feed: "sip", adjustment: "all", quiet: true, requireAll: false }); if ((r.truncatedStart || []).length) notes.push(`adjusted history starts late for ${r.truncatedStart.map((x) => x.symbol).join(", ")}`); adj = toArr(r); }
  catch (e) { unknown.push(`adjusted closes (Alpaca SIP: model, SPY, SGOV reserve): ${e.message}`); }
  const crypto = {};
  for (const c of PE.COINS) { try { crypto[c] = await coinbaseDaily(c, addDays(START, -(PE.N + 40)), nowMs); } catch (e) { crypto[c] = null; unknown.push(`${c} daily closes (Coinbase): ${e.message}`); } }
  const broker = await bookBroker();
  return { sessions, raw, adj, crypto, broker, unknown, notes };
}

async function gather(F, nowMs = Date.now()) {
  const et = etParts(nowMs), PT = require("./planE-tasty.js");
  const PE0 = PT.loadPlanE(BACKEND), extra = extractExtra(BACKEND);
  const PE = { ...PE0, ZN_BETA: extra.ZN_BETA, LIMITS: PT.LIMITS };
  const local = readLocal(F), remote = await fetchRemote(PE, nowMs, et);
  return { start: START, anchor: PE.PLAN_E_BOOK_USD, et, nowIso: new Date(nowMs).toISOString(), PE, R219c: extra.R219, ...local, ...remote,
    unknown: [...local.unknown, ...remote.unknown], notes: [...local.notes, ...remote.notes], sources: PE0.sha };
}

// ================================================================ compute (pure) ================================================================
function modelSyms(PE) {
  return { trend: Object.keys(PE.SLEEVES).filter((k) => PE.SLEEVES[k].rule === "trend10m" && PE.W[k] > 0), hold: Object.keys(PE.SLEEVES).filter((k) => PE.SLEEVES[k].rule === "hold" && PE.W[k] > 0) };
}

/** the derived crypto sleeve: R191's rule, Plan E's weights, one cash slot per coin; series keyed by UTC day */
function cryptoSim({ PE, anchor, start, closes, endDay, cost = CRYPTO_SWITCH_COST }) {
  const m0 = addDays(start, -1), series = {}, fills = [], state = {};
  for (const coin of PE.COINS) {
    const ser = new Map(); series[coin] = ser;
    const arr = Array.isArray(closes[coin]) ? closes[coin].filter((x) => x && x.d && fin(+x.c)).map((x) => ({ d: x.d, c: +x.c })).sort((a, b) => (a.d < b.d ? -1 : 1)) : null;
    if (!arr) continue;
    const idx = new Map(arr.map((x, i) => [x.d, i]));
    let started = false, held = false, qty = 0, cash = PE.W[coin] * anchor;
    for (let d = m0; d <= endDay; d = addDays(d, 1)) {
      const i = idx.get(d);
      if (i == null || i < PE.N - 1 || (!started && d !== m0)) { ser.set(d, null); continue; }   // no completed close (or too few for the mean): UNKNOWN that day
      const dec = PE.decide(arr.slice(0, i + 1)), c = dec.last.c, sma = dec.sma, on = !!dec.want;   // R191's own decision line (loadPlanE), never re-implemented: a close equal to the mean is OUT
      const why = `close ${num(c, 2)} ${on ? ">" : "<="} ${PE.N}-day mean ${num(sma, 2)}`;
      const at = `${addDays(d, 1)}T00:00:00Z`, src = "derived: Coinbase UTC daily close (not a fill)";
      const buy = (reason, reentry) => { const slotUsd = cash, fee = cost * cash; qty = (cash - fee) / c; fills.push({ leg: "crypto", sym: coin, side: "buy", qty, px: c, mult: 1, date: d, time: "UTC close", at, reason, source: src, tag: SRC.derived, fee, feeNote: "assumed 25 bps (model switch cost)", slotUsd, reentry: !!reentry }); cash = 0; held = true; };
      const sell = (reason) => { const proceeds = qty * c, fee = cost * proceeds; fills.push({ leg: "crypto", sym: coin, side: "sell", qty, px: c, mult: 1, date: d, time: "UTC close", at, reason, source: src, tag: SRC.derived, fee, feeNote: "assumed 25 bps (model switch cost)" }); cash = proceeds - fee; qty = 0; held = false; };
      if (!started) { started = true; if (on) buy(`initial allocation at the paper start — 50-day rule IN (${why})`); }
      else if (held && !on) sell(`signal flip OUT — ${why}`);
      else if (!held && on) buy(`signal flip IN — ${why}`, true);   // re-entry: the slot's cash (the stated sizing deviation; see the header)
      ser.set(d, { close: c, sma, on, held, qty, cash, value: held ? qty * c : cash });
    }
    state[coin] = { held, qty, cash, started };
  }
  return { series, fills, state };
}

/** R219's windows from the paper start on; a window that opened BEFORE the start is not Plan E's paper trade (listed in `pre`) */
function znWindowsOf(inp, start) {
  const st = inp.r219 && inp.r219.state, windows = [], bad = [], pre = [];
  if (!st || !st.windows) return { windows, bad, pre };
  for (const w of Object.values(st.windows).sort((a, b) => (a.ym < b.ym ? -1 : 1))) {
    if (!w || !w.ym || w.ym < ymOf(start)) continue;
    const leg = (x, kind) => { if (!x) return null; const px = +x.px, t = Date.parse(x.at); if (!fin(px) || !fin(t)) { bad.push(`R219 ${w.ym} ${kind} has no usable price/time`); return null; } const e = etParts(t); return { px, at: x.at, date: e.date, time: e.hhmm, bid: x.bid, ask: x.ask, spreadTicks: x.spreadTicks, late: !!x.late }; };
    const entry = leg(w.entry, "entry"), opened = w.entryDay || (entry && entry.date) || null;
    if (opened && opened < start) { pre.push({ ym: w.ym, entryDay: opened, exitDay: w.exitDay || null }); continue; }
    windows.push({ ym: w.ym, contract: w.contract, entryDay: w.entryDay, exitDay: w.exitDay, noEntry: w.noEntry || null, entry, exit: leg(w.exit, "exit"), qtyEq: null });
  }
  return { windows, bad, pre };
}

/** the BOOK's fills (broker first, ledger as the fallback) with each fill's reason from the BOOK's own run records */
function etfFills(inp, c) {
  const { PE } = inp, st = (inp.book && inp.book.state) || {}, ledger = (inp.book && inp.book.ledger) || [], broker = inp.broker;
  const out = { fills: [], unknownFrom: null, unknownWhy: null, divs: [], fees: [], queued: [], source: null };
  const ci = (cid) => { const m = BOOK_CID.exec(cid || ""); return m ? { orderDate: `${m[1]}-${m[2]}-${m[3]}`, sym: m[4], side: m[5] } : null; };
  const runRows = ledger.filter((r) => (r.kind === "daily" || r.kind === "month-end") && r.date).sort((a, b) => (a.date < b.date ? -1 : 1));
  const band = `held outside max(${Math.round(100 * PE.BAND_FRAC)}% of target, $${PE.BAND_MIN_USD})`;
  const reasonFor = (orderDate, sym) => {
    const run = (st.runs || {})[orderDate], row = runRows.find((r) => r.date === orderDate);
    if (!run && !row) return "BOOK order (no run record for that date)";
    const monthEnd = run ? !!run.monthEnd : row.kind === "month-end", full = run ? !!run.full : monthEnd;
    if (full && !monthEnd) return "initial allocation (BOOK start: every sleeve to target)";
    if (monthEnd) {
      const prev = runRows.filter((r) => r.date < orderDate).pop(), sigOf = (r, s) => { const l = r && (r.lines || []).find((x) => x.sym === s); return l ? l.signal : null; };
      const flips = Object.keys(PE.SLEEVES).filter((s) => PE.SLEEVES[s].rule === "trend10m" && sigOf(prev, s) && sigOf(row, s) && sigOf(prev, s) !== sigOf(row, s));
      if (flips.includes(sym)) return `signal flip ${sigOf(prev, sym)} -> ${sigOf(row, sym)} (10-month rule at the month-end close)`;
      if (PE.SLEEVES[sym] && PE.SLEEVES[sym].rule === "park" && flips.length) return `SGOV park/unpark after ${flips.join(", ")} flipped (10-month rule)`;
      return "monthly rebalance (month-end: every sleeve to target)";
    }
    return `band trigger (${band})`;
  };
  const ledgerFills = ledger.filter((r) => /^fill-/.test(r.kind || "") && +r.filledQty > 0 && ci(r.cid) && ci(r.cid).orderDate >= c.start)
    .map((r) => { const k = ci(r.cid); return { cid: r.cid, sym: r.sym || k.sym, side: r.side || k.side, qty: +r.filledQty, px: +r.px, orderDate: k.orderDate, fillDate: c.nextSession(k.orderDate), at: null, time: null, source: "BOOK ledger (broker fill price recorded at reconcile; fill time not recorded)", tag: SRC.ledger, fee: 0 }; });
  if (broker && broker.ok) {
    const all = broker.orders || [], mine = all.filter((o) => { const k = ci(o.client_order_id); return k && k.orderDate >= c.start; }), foreign = all.filter((o) => !ci(o.client_order_id));
    if (foreign.length) { const byPre = group(foreign, (o) => String(o.client_order_id || "(no id)").split("-")[0]); c.notes.push(`BOOK account: ${foreign.length} order(s) without a book- client id excluded (not Plan E's sleeve orders): ${Object.entries(byPre).map(([p, a]) => { const syms = [...new Set(a.map((o) => o.symbol))]; return `${p}-* x${a.length} (${syms.slice(0, 6).join(", ")}${syms.length > 6 ? ", ..." : ""})`; }).join("; ")}`); }
    const bf = mine.filter((o) => +o.filled_qty > 0).map((o) => { const k = ci(o.client_order_id), t = Date.parse(o.filled_at), e = fin(t) ? etParts(t) : null; return { cid: o.client_order_id, sym: o.symbol, side: o.side, qty: +o.filled_qty, px: +o.filled_avg_price, orderDate: k.orderDate, fillDate: e ? e.date : c.nextSession(k.orderDate), at: o.filled_at || null, time: e ? e.hhmm : null, status: o.status, source: "broker fill (Alpaca BOOK paper account)", tag: SRC.broker, fee: 0 }; });
    // the other orders' fills (ET date) — the account is shared, so a fee or dividend is Plan E's only in proportion to Plan E's part of it
    const ff = foreign.filter((o) => +o.filled_qty > 0).map((o) => { const t = Date.parse(o.filled_at); return { sym: o.symbol, side: o.side, qty: +o.filled_qty, px: +o.filled_avg_price, date: fin(t) ? etParts(t).date : null }; });
    for (const lf of ledgerFills) {
      const b = bf.find((x) => x.cid === lf.cid);
      if (!b) { c.anomalies.push(`BOOK ledger fill ${lf.cid} (${lf.qty} @ ${lf.px}) is not among the broker's orders — the ETF record cannot be reconciled`); continue; }
      if (Math.abs(b.qty - lf.qty) > 1e-9 || Math.abs(b.px - lf.px) > 1e-6) c.notes.push(`${lf.cid}: BOOK ledger ${lf.qty} @ ${lf.px} vs broker ${b.qty} @ ${b.px} — the broker's is used`);
    }
    const unrec = bf.filter((b) => !ledgerFills.some((l) => l.cid === b.cid));
    if (unrec.length) c.notes.push(`${unrec.length} broker fill(s) not yet reconciled into the BOOK ledger (counted from the broker): ${unrec.map((x) => x.cid).join(", ")}`);
    out.fills = bf; out.source = "broker";
    out.queued = mine.filter((o) => !DONE_STATUSES.includes(o.status)).map((o) => ({ cid: o.client_order_id, sym: o.symbol, side: o.side, qty: +o.qty, filledQty: +o.filled_qty || 0, status: o.status, orderDate: ci(o.client_order_id).orderDate }));
    if (Array.isArray(broker.activities)) {
      // FEE: Plan E's share = Plan E's notional / all notional filled in the account that ET day (REG/TAF are charged on sells: sells only;
      //   a fee naming a symbol: that symbol only); Plan E's share is spread over those Plan E fills by notional (the trade log's fees).
      // DIV: a Plan E symbol no other order holds is Plan E's; one another order also holds is split by the broker's share count.
      const notional = (f) => f.qty * f.px, onDay = (arr, dk, d, sym, sellOnly) => arr.filter((f) => f[dk] === d && (!sym || f.sym === sym) && (!sellOnly || f.side === "sell"));
      let otherFees = 0; const unattributed = [];
      for (const a of broker.activities) {
        const d = String(a.date || a.transaction_time || "").slice(0, 10), amt = +a.net_amount;
        if (!d || d < c.start || !fin(amt)) continue;
        if (a.activity_type === "DIV") {
          if (!PE.SLEEVES[a.symbol]) continue;   // another strategy's dividend
          if (!ff.some((f) => f.sym === a.symbol && (!f.date || f.date <= d))) { out.divs.push({ date: d, sym: a.symbol, amount: amt }); continue; }
          const q = +a.qty;
          if (!(fin(q) && q > 0)) { c.anomalies.push(`${a.symbol} dividend ${usd(amt)} on ${d} cannot be split between Plan E and the other orders holding ${a.symbol} (the broker gave no share count)`); continue; }
          // entitlement is set at the ex/record date, not the pay date d: Plan E's entitled shares = its fills BEFORE the ex date (or the record
          // date — the same day under T+1), so shares bought on the ex-date earn nothing. Alpaca's DIV activity normally carries only the pay
          // date: then Plan E's holding must be unchanged from the prior month-end to d (the BOOK's month-end rebalance fills on the month's
          // first session — usually a monthly payer's ex-date), else the split is UNKNOWN (never split on the pay-date holding).
          const qtyAt = (pred) => sum(bf.filter((f) => f.sym === a.symbol && f.fillDate && pred(f.fillDate)).map((f) => (f.side === "buy" ? 1 : -1) * f.qty));
          const exd = String(a.ex_date || a.record_date || "").slice(0, 10);
          let held, basis;
          if (/^\d{4}-\d{2}-\d{2}$/.test(exd)) { held = qtyAt((x) => x < exd); basis = `held before the ${a.ex_date ? "ex" : "record"} date ${exd}`; }
          else {
            const pme = addDays(`${ymOf(d)}-01`, -1), h0 = qtyAt((x) => x <= pme); held = qtyAt((x) => x <= d);
            if (Math.abs(held - h0) > 1e-9) { c.anomalies.push(`${a.symbol} dividend ${usd(amt)} on ${d} cannot be split between Plan E and the other orders holding ${a.symbol}: the broker gave no ex/record date and Plan E's ${a.symbol} holding changed between the ${pme} month-end and ${d} (${h0} -> ${held} sh)`); continue; }
            basis = `unchanged since the ${pme} month-end; no ex/record date from the broker`;
          }
          const share = Math.min(1, Math.max(0, held) / q); out.divs.push({ date: d, sym: a.symbol, amount: amt * share, share });
          c.notes.push(`${a.symbol} dividend ${d}: ${usd(amt)} on ${q} sh, other orders also hold ${a.symbol} — Plan E's ${held} sh = ${usd(amt * share)} (${basis})`);
        } else if (a.activity_type === "FEE") {
          if (a.symbol && !PE.SLEEVES[a.symbol]) { otherFees += amt; continue; }
          const sellOnly = /^(REG|TAF)\b/i.test(String(a.description || "")), pe = onDay(bf, "fillDate", d, a.symbol, sellOnly), fo = onDay(ff, "date", d, a.symbol, sellOnly);
          const pb = sum(pe.map(notional)), fb = sum(fo.map(notional));
          if (!(pb + fb > 0)) { unattributed.push(`${usd(amt)} on ${d} (${String(a.description || "fee").slice(0, 60)})`); continue; }
          const mineAmt = (amt * pb) / (pb + fb);
          if (pb > 0) { out.fees.push({ date: d, sym: a.symbol || null, amount: mineAmt, share: pb / (pb + fb), what: a.description || "fee" }); for (const f of pe) f.fee += (-mineAmt * notional(f)) / pb; }
          otherFees += amt - mineAmt;
        }
      }
      c.notes.push(`broker activities since ${c.start}: Plan E fees ${usd(sum(out.fees.map((x) => x.amount)))} (${out.fees.length} fee(s) by fill date and notional — REG/TAF on sells, others on all fills)${Math.abs(otherFees) >= 0.005 ? `, other orders' fees ${usd(otherFees)} excluded` : ""}${unattributed.length ? `, ${unattributed.length} fee(s) with no fill that day excluded: ${unattributed.join("; ")}` : ""}; ${out.divs.length ? `${out.divs.length} Plan E dividend(s) ${usd(sum(out.divs.map((x) => x.amount)))}` : "no dividends credited (the model's adjusted closes include them — they show in the tracking difference)"} — in the ETF leg (the BOOK's own cash does not carry them)`);
    } else c.notes.push(`broker dividends/fees not read (${broker.activitiesError || "no data"}) — none counted`);
    // positions: the broker must hold exactly Plan E's fills plus whatever the excluded orders did
    const bookQty = {}, foreignQty = {}, posQty = {}, outside = [];
    for (const f of bf) bookQty[f.sym] = (bookQty[f.sym] || 0) + (f.side === "buy" ? 1 : -1) * f.qty;
    for (const o of foreign) if (+o.filled_qty > 0) foreignQty[o.symbol] = (foreignQty[o.symbol] || 0) + (o.side === "buy" ? 1 : -1) * +o.filled_qty;
    for (const p of broker.positions || []) posQty[p.symbol] = +p.qty;
    for (const s of new Set([...Object.keys(bookQty), ...Object.keys(posQty)])) {
      const want = (bookQty[s] || 0) + (foreignQty[s] || 0), have = posQty[s] || 0;
      if (Math.abs(want - have) > 1e-6) { if (PE.SLEEVES[s]) c.anomalies.push(`broker holds ${have} ${s}; Plan E's fills give ${bookQty[s] || 0}${foreignQty[s] ? ` (+${foreignQty[s]} from excluded orders)` : ""} — the ETF record cannot be reconciled`); else outside.push(`${s} ${+have.toFixed(4)}`); }
      else if (foreignQty[s] && PE.SLEEVES[s]) c.notes.push(`BOOK account: ${foreignQty[s]} ${s} from excluded orders sits beside Plan E's ${bookQty[s] || 0} — excluded`);
      else if (!PE.SLEEVES[s] && have) outside.push(`${s} ${+have.toFixed(4)}`);
    }
    if (outside.length) c.notes.push(`BOOK account holds ${outside.length} position(s) that are not Plan E symbols — excluded: ${outside.join(", ")}`);
  } else {
    c.notes.push(`BOOK broker account not read (${broker ? broker.error : "skipped"}) — fills from the BOOK ledger (the broker fill prices it recorded; fill time = that session's open, not recorded)`);
    out.fills = ledgerFills; out.source = "ledger";
    for (const p of st.pending || []) {
      const k = ci(p.cid); if (!k) continue; const due = c.nextSession(k.orderDate);
      out.queued.push({ cid: p.cid, sym: p.sym, side: p.side, qty: p.qty, filledQty: null, status: "pending in BOOK state (broker not read)", orderDate: k.orderDate });
      if (due && due <= c.lastDay && (!out.unknownFrom || due < out.unknownFrom)) { out.unknownFrom = due; out.unknownWhy = `ETF: order ${p.cid} was due to fill ${due}, is not reconciled, and the broker cannot be read`; }
    }
  }
  // the BOOK's own books vs its ledger (a consistency note, not a source)
  if (st && fin(st.cash)) { let cash = PE.BOOK_CAPITAL; const h = {}; for (const f of ledgerFills) { const sg = f.side === "buy" ? 1 : -1; cash -= sg * f.qty * f.px; h[f.sym] = (h[f.sym] || 0) + sg * f.qty; } const hd = Object.keys({ ...h, ...(st.holdings || {}) }).filter((s) => Math.abs((h[s] || 0) - ((st.holdings || {})[s] || 0)) > 1e-9); if (Math.abs(cash - st.cash) > 0.01 || hd.length) c.notes.push(`BOOK state differs from its own ledger fills: cash ${usd(st.cash)} vs ${usd(cash)}${hd.length ? `, holdings ${hd.join(", ")}` : ""}`); }
  const feeNote = out.source === "ledger" ? "not read (broker unreadable)" : broker && Array.isArray(broker.activities) ? "broker FEE activities, allocated by notional" : "broker fees not read";
  for (const f of out.fills) { f.leg = "etf"; f.mult = 1; f.fee = f.fee || 0; f.feeNote = feeNote; f.reason = reasonFor(f.orderDate, f.sym); f.date = f.fillDate; }
  out.fills.sort((a, b) => { const ka = `${a.fillDate} ${a.at || ""} ${a.side === "sell" ? 0 : 1}`, kb = `${b.fillDate} ${b.at || ""} ${b.side === "sell" ? 0 : 1}`; return ka < kb ? -1 : ka > kb ? 1 : 0; });
  return out;
}

/** FIFO per leg + symbol; returns closed pairs, open lots and shorts (Plan E is long-only, so a short is an anomaly) */
function fifo(fills) {
  const lots = {}, closed = [], anomalies = [];
  for (const f of fills) {
    const k = `${f.leg}|${f.sym}`; lots[k] = lots[k] || [];
    if (f.side === "buy") { lots[k].push({ ...f, rem: f.qty }); continue; }
    let left = f.qty;
    while (left > 1e-12 && lots[k].length) {
      const lot = lots[k][0], q = Math.min(lot.rem, left);
      closed.push({ lot, exit: f, qty: q, entryFee: (lot.fee || 0) * (q / lot.qty), exitFee: (f.fee || 0) * (q / f.qty) });
      lot.rem -= q; left -= q; if (lot.rem <= Math.max(1e-12, lot.qty * 1e-12)) lots[k].shift();
    }
    if (left > Math.max(1e-9, f.qty * 1e-9)) anomalies.push(`${LEG_LABEL[f.leg]} ${f.sym}: sell of ${left} on ${f.date} with no open lot (a short — Plan E is long-only)`);
  }
  const open = []; for (const arr of Object.values(lots)) for (const lot of arr) open.push({ lot, qty: lot.rem, entryFee: (lot.fee || 0) * (lot.rem / lot.qty) });
  return { closed, open, anomalies };
}

function compute(inp) {
  const { PE, start, anchor } = inp;
  const unknown = [...(inp.unknown || [])], notes = [...(inp.notes || [])], anomalies = [];
  const res = { spec: SPEC, generatedAt: inp.nowIso, start, anchor, anchorChoice: `$${anchor.toLocaleString("en-US")} = the BOOK's own "Plan E on a $100k book"; the BOOK's $${PE.BOOK_CAPITAL.toLocaleString("en-US")} ETF capital counts 1:1 (unscaled)`, et: inp.et, status: null, asOf: null, unknown, notes, legs: null, trades: [], daily: [], upcoming: [], signalPreview: [], cryptoLine: [], cryptoSizing: null, bandStatus: null, summary: null, months: {}, sources: inp.sources || null };
  const finish = () => { res.status = unknown.length ? "UNKNOWN" : "OK"; return res; };
  if (!inp.sessions || !inp.sessions.length) { unknown.push("no trading calendar — nothing can be dated"); return finish(); }
  const sess = [...new Map(inp.sessions.filter((s) => s && s.date).map((s) => [s.date, s])).values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const sessDates = sess.map((s) => s.date), sessBy = new Map(sess.map((s) => [s.date, s]));
  const nextSession = (d) => sessDates.find((x) => x > d) || null;
  const mapOf = (o) => { const m = {}; for (const [s, arr] of Object.entries(o || {})) m[s] = new Map((arr || []).map((b) => [b.d, +b.c])); return m; };
  const rawM = mapOf(inp.raw), adjM = mapOf(inp.adj);
  const raw = (s, d) => (rawM[s] ? rawM[s].get(d) : undefined), adj = (s, d) => (adjM[s] ? adjM[s].get(d) : undefined);

  // ---- the record's sessions: completed ones (the BOOK's rule: final closes 5 min after the close) whose closes are in the data
  const et = inp.et, tS = sessBy.get(et.date), doneToday = !!tS && et.mins >= hm(tS.close) + 5;
  const recordDays = sessDates.filter((d) => d >= start && (d < et.date || (d === et.date && doneToday)));
  if (recordDays.length && recordDays[recordDays.length - 1] === et.date && inp.raw && !Object.values(rawM).some((m) => m.has(et.date))) { recordDays.pop(); notes.push(`today's closes (${et.date}) are not in the SIP data yet — the record ends at the session before`); }
  if (!recordDays.length) { unknown.push(`no completed session since the paper start ${start}`); return finish(); }
  const lastDay = recordDays[recordDays.length - 1]; res.asOf = lastDay;
  const alloc = { etf: PE.BOOK_CAPITAL, crypto: sum(PE.COINS.map((c) => PE.W[c] * anchor)), zn: 0 }; alloc.cash = anchor - alloc.etf - alloc.crypto;
  if (!(alloc.cash >= -1e-6)) throw new Error(`Plan E allocation exceeds the anchor (ETF ${alloc.etf} + crypto ${alloc.crypto} > ${anchor})`);
  const MULT = inp.R219c.MULT, FEE_SIDE = inp.R219c.FEE_SIDE;
  res.legs = { anchor, allocation: { etf: alloc.etf, crypto: alloc.crypto, cash: alloc.cash }, cryptoWeights: Object.fromEntries(PE.COINS.map((c) => [c, PE.W[c]])), znLev: PE.ZN_LEV, leverageK: LEVERAGE_K, znBeta: PE.ZN_BETA, cryptoN: PE.N, cryptoSwitchCost: CRYPTO_SWITCH_COST, r219: inp.R219c };
  if (inp.leverage) notes.push(`leverage multiple k = ${LEVERAGE_K}: plan-e-leverage.json is ${inp.leverage.exploratory ? "exploratory" : "a table"} (${(inp.leverage.rows || []).map((r) => r.k).join("/")}) with no multiple adopted — ZN = ${PE.ZN_LEV}x NAV as risk-manager.js`);
  if (inp.book && inp.book.off) notes.push("BOOK OFF switch present (data/book-etf-OFF): the rebalancer reports signals and sends no orders");
  if (inp.r219 && inp.r219.off) notes.push("R219 OFF switch present (data/r219-OFF): the next ZN window would be skipped");

  // ---- the three legs' trades
  const c = { start, lastDay, nextSession, notes, anomalies };
  const etf = etfFills(inp, c);
  // ETF staleness: the BOOK must have run after every record session's close (book-etf-state.json runs[D], or a daily / month-end row dated D
  // in book-etf-ledger.jsonl). A session with neither = Plan E's band / month-end check was not made, so the paper ETF leg stopped following
  // Plan E's rule: UNKNOWN, naming the session. Broker fills still value the leg (they are what the account did); with the broker unreadable
  // the ledger cannot vouch for that session's fills, so the ETF leg is UNKNOWN from it. Today's run is not due before close + BOOK_RUN_DUE_MIN.
  {
    const runs = (((inp.book && inp.book.state) || {}).runs) || {}, ranOn = new Set(((inp.book && inp.book.ledger) || []).filter((r) => (r.kind === "daily" || r.kind === "month-end") && r.date).map((r) => r.date));
    const missed = [];
    for (const D of recordDays) {
      if (runs[D] || ranOn.has(D)) continue;
      const due = hm(sessBy.get(D).close) + BOOK_RUN_DUE_MIN;
      if (D === et.date && et.mins < due) { notes.push(`BOOK run for today (${D}) is not due yet (~${hhmm(due)} ET) — not counted as missed`); continue; }
      missed.push(D);
    }
    if (missed.length) {
      unknown.push(`ETF: the BOOK did not run on ${missed.join(", ")} — Plan E's band/rebalance check was not made (no runs[] entry in book-etf-state.json, no daily/month-end row in book-etf-ledger.jsonl); the paper ETF leg does not follow Plan E's rule after that close`);
      if (etf.source === "ledger" && (!etf.unknownFrom || missed[0] < etf.unknownFrom)) { etf.unknownFrom = missed[0]; etf.unknownWhy = `ETF: the BOOK did not run on ${missed[0]} — that session's fills are not reconciled into the ledger and the broker cannot be read`; }
    }
  }
  // crypto: the record marks session D at the UTC close of D-1 (recEnd = the last record mark); the sleeve runs on through the freshest
  // completed close so a switch decided after the record (a weekend flip, or a flip and back) is listed as done, never missed
  const recEnd = addDays(lastDay, -1);
  const cLast = PE.COINS.map((k) => (inp.crypto && Array.isArray(inp.crypto[k]) ? inp.crypto[k].reduce((m, x) => (x && typeof x.d === "string" && x.d > m ? x.d : m), "") : "")).filter(Boolean).sort().pop();
  const cs = cryptoSim({ PE, anchor, start, closes: inp.crypto || {}, endDay: cLast && cLast > recEnd ? cLast : recEnd });
  const zw = znWindowsOf(inp, start); for (const b of zw.bad) anomalies.push(b);
  // ZN coverage: every month-end window whose entry session is inside the record must be in R219's record (entered, no-quote or skipped)
  const r219Skipped = new Set(((inp.r219 && inp.r219.ledger) || []).filter((r) => r.kind === "skipped" && r.ym).map((r) => r.ym));
  for (let ym = ymOf(start); ym <= ymOf(lastDay); ym = nextYm(ym)) {
    const ds = sessDates.filter((d) => ymOf(d) === ym); if (ds.length < 6) continue;
    const have = zw.windows.find((w) => w.ym === ym), pre = zw.pre.find((w) => w.ym === ym), wd = have && have.entryDay ? { entryDay: have.entryDay, exitDay: have.exitDay } : pre || PE.windowDays(ds);
    if (wd.entryDay < start) { notes.push(`ZN ${ym} window (entry ${wd.entryDay}, exit ${wd.exitDay}) opened before the paper start ${start}${pre ? " (R219 holds it)" : ""} — not in Plan E's paper record`); continue; }
    if (wd.entryDay > lastDay || (have && (have.entry || have.noEntry)) || r219Skipped.has(ym)) continue;
    unknown.push(`ZN: R219 has no record of the ${ym} window (entry session ${wd.entryDay} is inside the record) — Plan E's ZN trade for it cannot be priced`);
  }
  // an unrecorded ZN exit: Plan E is flat after the month's last session. R219's exit-day after-close retry (LATE) is the only grace, so on the
  // exit day itself the window stays OPEN (noted); once a later session is on record the ZN leg is stale -> UNKNOWN from that session
  for (const w of zw.windows) {
    if (!w.entry || w.exit || !w.exitDay || w.exitDay > lastDay) continue;
    if (w.exitDay === lastDay) notes.push(`ZN ${w.ym}: R219's exit was due ${w.exitDay} and is not recorded yet (R219 retries at that day's after-close run, marked LATE) — the window stays OPEN, marked at the ZN daily close`);
    else { w.staleFrom = nextSession(w.exitDay); unknown.push(`ZN ${w.ym}: R219 exit due ${w.exitDay} not recorded — ZN leg stale from ${w.staleFrom} (Plan E is flat after the month's last session; only R219's exit-day after-close retry, LATE, is allowed)`); }
  }
  const znMark = (contract, d) => { const z = inp.znDaily; if (!z || z.symbol !== contract) return null; const b = (z.bars || []).find((x) => x.d === d); return b && fin(+b.c) ? +b.c : null; };
  const znMarkWhy = (contract, d) => (!inp.znDaily ? "ZN daily store absent" : inp.znDaily.symbol !== contract ? `ZN daily store holds ${inp.znDaily.symbol}, the window trades ${contract}` : `no ${contract} daily close for ${d}`);

  // ---- the model (risk-manager.js buildBook's rules on the full month calendar)
  const lim = (m) => new Map([...m.entries()].filter(([d]) => d <= lastDay).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const me = {}; for (const [s, m] of Object.entries(adjM)) { const o = {}; for (const [d, v] of lim(m)) o[ymOf(d)] = v; me[s] = o; }
  const sig10 = (s, ym) => { const ms = Object.keys(me[s] || {}).sort(), i = ms.indexOf(ym); if (i < 10) return null; const avg = mean(ms.slice(i - 9, i + 1).map((k) => me[s][k])); return { on: me[s][ym] > avg, close: me[s][ym], avg }; };
  const M = (inp.dtb3 && inp.dtb3.byMonth) || {}, mk = Object.keys(M).sort();
  const rfAnnual = (d) => { const v = M[ymOf(d)] ?? (mk.length ? M[mk[mk.length - 1]] : null); return v == null ? 4.0 : v; };
  if (inp.dtb3 && !M[ymOf(lastDay)]) notes.push(`model T-bill: DTB3 ends ${inp.dtb3.last}; its last month (${mk[mk.length - 1]}) is carried, as risk-manager.js does`);
  // 2026-10-12 (profit fixes B): the stored record and the printed tables say on which basis the model line stands. Every model day is recomputed at each run and the history
  // rows carry no revision mark for it, so without this line a reader could not tell a "vs model" figure from before the fix from one after it.
  notes.push("model basis: the ZN proxy is financed at the T-bill (profit fixes B, 2026-10-12) and every model day of this record is restated on that basis — a 'vs model' figure printed before that fix was applied is on the unfinanced basis and is not comparable with this one");
  res.modelBasis = "zn-proxy-financed-at-tbill";   // the same fact as a field of the stored record, for a program that reads it: a record written before the fix has no such field (its model line is on the unfinanced proxy)
  const ms = modelSyms(PE);
  function modelReturn(D, p) {
    const miss = []; let r = 0, used = 0;
    const rr = (s) => { const a = adj(s, D), b = adj(s, p); return fin(a) && fin(b) ? a / b - 1 : null; };
    for (const s of ms.trend) { const sg = sig10(s, prevYm(ymOf(D))); if (!sg) { miss.push(`${s} 10-month signal (${prevYm(ymOf(D))})`); continue; } if (!sg.on) continue; const x = rr(s); if (x == null) { miss.push(`${s} adjusted close`); continue; } r += PE.W[s] * x; used += PE.W[s]; }
    for (const s of ms.hold) { const x = rr(s); if (x == null) { miss.push(`${s} adjusted close`); continue; } r += PE.W[s] * x; used += PE.W[s]; }
    for (const coin of PE.COINS) {
      let g = 1, ok = true;
      for (let u = p; u <= addDays(D, -1); u = addDays(u, 1)) {   // UTC days (m(p), m(D)] with m(x) = x - 1
        const s1 = cs.series[coin].get(u), s0 = cs.series[coin].get(addDays(u, -1));
        if (!s1 || !s0) { ok = false; break; }
        let x = s0.on ? s1.close / s0.close - 1 : (rfAnnual(u) / 100 / 252) * 252 / 365; if (s1.on !== s0.on) x -= CRYPTO_SWITCH_COST; g *= 1 + x;
      }
      if (!ok) { miss.push(`${coin} closes`); continue; }
      r += PE.W[coin] * (g - 1); used += PE.W[coin];
    }
    const w5 = sessDates.filter((x) => ymOf(x) === ymOf(D)).slice(-5), zn = w5.includes(D);
    if (zn) { const x = rr("IEF"); if (x == null) miss.push("IEF adjusted close"); else r += PE.ZN_LEV * PE.ZN_BETA * (x - rfAnnual(D) / 100 / 252) - (D === w5[0] || D === w5[w5.length - 1] ? (0.0004 * PE.ZN_LEV) / 2 : 0); }   // 2026-10-12 (profit fixes B): the proxy is FINANCED. A note future's price return carries no coupon carry and IEF's total return does, so the T-bill is charged on the proxied notional each window day; unfinanced, the model line ran about 3 points a year above Plan E's stated return and showed a paper shortfall that was not there
    r += (1 - used) * (rfAnnual(D) / 100 / 252);
    return miss.length ? { ret: null, miss, zn } : { ret: r, miss, zn };
  }
  // the paper holds ZN on session D when a window entered before D's close-arm and had not exited before D (entry < D <= exit)
  const paperZnOn = (D) => zw.windows.some((w) => w.entry && w.entry.date < D && (!w.exit || w.exit.date >= D));
  const modelZnOnly = [];

  // ---- the daily record
  const fillsUsed = etf.fills.filter((f) => f.fillDate && f.fillDate <= lastDay);
  const cashFlows = [...etf.divs.map((x) => ({ ...x, kind: "dividend" })), ...etf.fees.map((x) => ({ ...x, kind: "fee" }))].filter((x) => x.date <= lastDay).sort((a, b) => (a.date < b.date ? -1 : 1));
  const bookNav = new Map((((inp.book && inp.book.state) || {}).navHistory || []).map((x) => [x.date, x.nav]));
  let fi = 0, ci2 = 0, cash = PE.BOOK_CAPITAL, cashBook = PE.BOOK_CAPITAL, prev = null, peak = anchor, maxDd = 0, modelG = 1, modelOk = true, lastNav = anchor, navHistDiff = null;
  const hold = {}, rows = [];
  for (const D of recordDays) {
    const why = [];
    while (fi < fillsUsed.length && fillsUsed[fi].fillDate <= D) { const f = fillsUsed[fi++], sg = f.side === "buy" ? 1 : -1; hold[f.sym] = (hold[f.sym] || 0) + sg * f.qty; cash -= sg * f.qty * f.px; cashBook -= sg * f.qty * f.px; }
    while (ci2 < cashFlows.length && cashFlows[ci2].date <= D) cash += cashFlows[ci2++].amount;
    let etfV = cash, etfInv = 0;
    for (const [s, q] of Object.entries(hold)) { if (Math.abs(q) < 1e-9) continue; const px = raw(s, D); if (!fin(px)) { etfV = null; why.push(`ETF: no ${s} close for ${D}`); break; } etfV += q * px; etfInv += q * px; }
    if (etf.unknownFrom && D >= etf.unknownFrom) { etfV = null; why.push(etf.unknownWhy); }
    if (fin(etfV) && bookNav.has(D)) navHistDiff = Math.max(navHistDiff || 0, Math.abs(etfV - (cash - cashBook) - bookNav.get(D)));
    // crypto at the UTC close of D-1
    const md = addDays(D, -1); let cr = 0, crInv = 0;
    for (const coin of PE.COINS) { const v = cs.series[coin] && cs.series[coin].get(md); if (!v) { cr = null; why.push(`CRYPTO: no completed ${coin} Coinbase close for ${md}${inp.crypto && inp.crypto[coin] ? "" : " (series not read)"}`); break; } cr += v.value; if (v.held) crInv += v.value; }
    // reserve, as SGOV
    const sg0 = adj("SGOV", start), sgD = adj("SGOV", D), cashV = fin(sg0) && fin(sgD) ? (alloc.cash * sgD) / sg0 : null;
    if (cashV == null) why.push(`CASH: no SGOV adjusted close for ${fin(sg0) ? D : start}`);
    // ZN: realized windows + open windows at the day's ZN close
    let zn = 0, znNot = 0;
    for (const w of zw.windows) {
      if (!w.entry || w.entry.date > D) continue;
      if (w.qtyEq == null) { const basis = prev && fin(prev.nav) ? prev.nav : lastNav; w.navBasis = basis; w.navBasisFrom = prev ? (fin(prev.nav) ? prev.date : `last known NAV (${prev.date} UNKNOWN)`) : "anchor"; w.qtyEq = (PE.ZN_LEV * LEVERAGE_K * basis) / (w.entry.px * MULT); w.entryFee = FEE_SIDE * w.qtyEq; if (w.exit) { w.exitFee = FEE_SIDE * w.qtyEq; w.realized = (w.exit.px - w.entry.px) * MULT * w.qtyEq - w.entryFee - w.exitFee; } }
      if (w.exit && w.exit.date <= D) { zn += w.realized; continue; }
      if (w.staleFrom && D >= w.staleFrom) { zn = null; why.push(`ZN: R219 exit due ${w.exitDay} not recorded — ZN leg stale (window ${w.ym})`); break; }
      const m = znMark(w.contract, D); if (!fin(m)) { zn = null; why.push(`ZN: ${znMarkWhy(w.contract, D)} (open window ${w.ym})`); break; }
      zn += (m - w.entry.px) * MULT * w.qtyEq - w.entryFee; znNot += m * MULT * w.qtyEq;
    }
    const value = { etf: etfV, crypto: cr, zn, cash: cashV }, nav = LEGS.every((l) => fin(value[l])) ? sum(LEGS.map((l) => value[l])) : null;
    const prevNav = prev ? prev.nav : anchor, contrib = {}, contribPct = {};
    for (const l of LEGS) { const a = prev ? prev.value[l] : alloc[l]; contrib[l] = fin(value[l]) && fin(a) ? value[l] - a : null; contribPct[l] = fin(contrib[l]) && fin(prevNav) ? (100 * contrib[l]) / prevNav : null; }
    const dayUsd = fin(nav) && fin(prevNav) ? nav - prevNav : null, dayPct = fin(dayUsd) ? (100 * dayUsd) / prevNav : null;
    let modelPct = null, modelMiss = [];
    if (prev) { const mr = modelReturn(D, prev.date); modelMiss = mr.miss; if (mr.zn && !paperZnOn(D)) modelZnOnly.push(D); if (fin(mr.ret)) { modelPct = 100 * mr.ret; if (modelOk) modelG *= 1 + mr.ret; } else { modelOk = false; why.push(`MODEL: missing ${mr.miss.join(", ")}`); } }
    const spy0 = adj("SPY", start), spyD = adj("SPY", D), spyCumPct = fin(spy0) && fin(spyD) ? 100 * (spyD / spy0 - 1) : null;
    if (spyCumPct == null) why.push(`SPY: no adjusted close for ${fin(spy0) ? D : start}`);
    let ddPct = null; if (fin(nav)) { peak = Math.max(peak, nav); ddPct = 100 * (nav / peak - 1); maxDd = Math.min(maxDd, ddPct); lastNav = nav; }
    const row = { date: D, nav, dayUsd, dayPct, value, contrib, contribPct, invested: { etf: fin(etfV) ? etfInv : null, crypto: fin(cr) ? crInv : null, zn: fin(zn) ? znNot : null, cash: cashV },
      modelPct, trackingPp: fin(dayPct) && fin(modelPct) ? dayPct - modelPct : null, cumPct: fin(nav) ? 100 * (nav / anchor - 1) : null, modelCumPct: prev ? (modelOk ? 100 * (modelG - 1) : null) : 0,
      spyCumPct, ddPct, start: !prev, unknown: why };
    rows.push(row); prev = row;
  }
  res.daily = rows;
  const unkRows = rows.filter((r) => r.unknown.length);
  if (unkRows.length) unknown.push(`${unkRows.length} session(s) with an UNKNOWN leg — ${unkRows.slice(-3).map((r) => `${r.date}: ${r.unknown.join("; ")}`).join(" | ")}`);
  if (navHistDiff != null) notes.push(`ETF leg vs the BOOK's own navHistory (fills only, no dividends): largest daily difference ${usd(navHistDiff)}`);
  if (modelZnOnly.length) notes.push(`the model is in its ZN month-end window on ${modelZnOnly.join(", ")} where the paper record holds no ZN position — part of the tracking difference`);
  // ---- crypto sizing: the derived sleeve's slot rule is a stated DEVIATION from Plan E's executor (planE-tasty.js buildPlan: W[coin] x Plan E
  // NAV with the BOOK band) and from the model (constant weight W) — the planE-tasty-sized variant, as part of the tracking difference
  {
    const navAsOf = (u) => { let o = null; for (const r of rows) { if (r.date > u) break; if (fin(r.nav)) o = r; } return o; };   // the latest NAV before that UTC close (a session's close precedes its UTC close)
    const bandTxt = `max(${Math.round(100 * PE.BAND_FRAC)}% of target or held, $${PE.BAND_MIN_USD})`, lr = rows[rows.length - 1];
    const reentries = cs.fills.filter((f) => f.side === "buy" && f.reentry).map((f) => { const nr = navAsOf(f.date), nav = nr ? nr.nav : anchor, targetUsd = PE.W[f.sym] * nav; return { coin: f.sym, date: f.date, slotUsd: f.slotUsd, navDate: nr ? nr.date : "anchor", nav, targetUsd, diffPct: 100 * (f.slotUsd / targetUsd - 1), inRecord: f.date <= recEnd }; });
    const held = PE.COINS.map((coin) => {
      const v = cs.series[coin] && cs.series[coin].get(recEnd);
      if (!v) return { coin, asOf: recEnd, unknown: `no completed ${coin} close for ${recEnd}` };
      if (!v.held) return { coin, asOf: recEnd, held: false };
      if (!fin(lr.nav)) return { coin, asOf: recEnd, unknown: `Plan E NAV ${lr.date} UNKNOWN` };
      const targetUsd = PE.W[coin] * lr.nav, driftUsd = v.value - targetUsd, bandUsd = Math.max(PE.BAND_FRAC * Math.max(targetUsd, v.value), PE.BAND_MIN_USD);
      return { coin, asOf: recEnd, held: true, heldUsd: v.value, targetUsd, navDate: lr.date, driftUsd, bandUsd, wouldTrade: Math.abs(driftUsd) > bandUsd ? (driftUsd > 0 ? "SELL" : "BUY") : null };
    });
    res.cryptoSizing = { rule: "slot (one cash slot per coin; re-entry = the slot's cash; no band rebalance)", deviation: `Plan E's executor (planE-tasty.js buildPlan) targets W[coin] x Plan E NAV with the BOOK band ${bandTxt}; the model (risk-manager.js) is constant-weight W`, reentries, held };
    const reTxt = reentries.length ? reentries.map((x) => `${x.coin} re-entry ${x.date} UTC close bought ${usd(x.slotUsd)} (slot) vs ${pct(100 * PE.W[x.coin], { sign: false })} x NAV ${usd(x.nav)} (${x.navDate === "anchor" ? "the anchor" : `${x.navDate} close`}) = ${usd(x.targetUsd)} (${pct(x.diffPct)})${x.inRecord ? "" : " — after the record"}`).join("; ") : "no re-entry yet (the initial allocation is W x the anchor, as planE-tasty would size it)";
    const heldTxt = held.map((h) => (h.unknown ? `${h.coin} UNKNOWN (${h.unknown})` : !h.held ? `${h.coin} OUT (both hold none)` : `${h.coin} ${usd(h.heldUsd)} vs ${usd(h.targetUsd)} (drift ${usd(h.driftUsd, { sign: true })}, band ${usd(h.bandUsd)}) — ${h.wouldTrade ? `planE-tasty would ${h.wouldTrade} ~${usd(Math.abs(h.driftUsd))}` : "inside the band"}`)).join("; ");
    notes.push(`CRYPTO sizing — a stated DEVIATION (part of the tracking difference): the derived sleeve keeps one cash slot per coin, so a re-entry buys with that coin's slot cash (its own past round trips) and the sleeve never band-rebalances; ${res.cryptoSizing.deviation}. planE-tasty-sized variant: ${reTxt}; held at the ${recEnd} UTC close vs W x NAV ${usd(lr.nav)} (${lr.date}): ${heldTxt}`);
  }

  // ---- the trade log
  const navBefore = (d) => { let n = anchor; for (const r of rows) { if (r.date >= d) break; if (fin(r.nav)) n = r.nav; } return n; };
  const fills = [...fillsUsed];
  for (const f of cs.fills) if (f.date <= recEnd) fills.push(f);   // later switches are listed under UPCOMING as done
  for (const w of zw.windows) {
    if (!w.entry || w.qtyEq == null) continue;
    fills.push({ leg: "zn", sym: w.contract, side: "buy", qty: w.qtyEq, px: w.entry.px, mult: MULT, date: w.entry.date, time: w.entry.time, at: w.entry.at, staleFrom: w.staleFrom || null, exitDue: w.exitDay || null, reason: `month-end window entry (6th-to-last session; ${PE.ZN_LEV}x Plan E NAV ${usd(w.navBasis)} at the ${w.navBasisFrom} close; R219 ${inp.R219c.QTY} contracts on $${inp.R219c.BOOK.toLocaleString("en-US")})`, source: "quote-priced: R219 Schwab ask (not a fill)", tag: SRC.quote, fee: w.entryFee, feeNote: `assumed $${FEE_SIDE}/contract/side (R219)` });
    if (w.exit && w.exit.date <= lastDay) fills.push({ leg: "zn", sym: w.contract, side: "sell", qty: w.qtyEq, px: w.exit.px, mult: MULT, date: w.exit.date, time: w.exit.time, at: w.exit.at, reason: `exit window (last session${w.exit.late ? ", LATE — retried after the close" : ""})`, source: "quote-priced: R219 Schwab bid (not a fill)", tag: SRC.quote, fee: w.exitFee, feeNote: `assumed $${FEE_SIDE}/contract/side (R219)` });
  }
  const tkey = (f) => `${f.date} ${f.leg === "crypto" ? "24:00" : f.time || "09:30"} ${f.side === "sell" ? 0 : 1}`;
  fills.sort((a, b) => (tkey(a) < tkey(b) ? -1 : tkey(a) > tkey(b) ? 1 : 0));
  const fp = fifo(fills); for (const a of fp.anomalies) anomalies.push(a);
  const markOf = (lot) => {
    if (lot.leg === "etf") { const px = raw(lot.sym, lastDay); return { date: lastDay, px, source: "SIP raw close", tag: SRC.close, why: fin(px) ? null : `no ${lot.sym} close for ${lastDay}` }; }
    if (lot.leg === "crypto") { const d = addDays(lastDay, -1), v = cs.series[lot.sym] && cs.series[lot.sym].get(d); return { date: d, px: v ? v.close : null, source: "Coinbase UTC daily close", tag: SRC.derived, why: v ? null : `no ${lot.sym} close for ${d}` }; }
    if (lot.staleFrom) return { date: lastDay, px: null, source: "Schwab ZN daily close (data/futures-daily)", tag: SRC.zn, why: `R219 exit due ${lot.exitDue} not recorded — ZN leg stale from ${lot.staleFrom}` };
    const px = znMark(lot.sym, lastDay); return { date: lastDay, px, source: "Schwab ZN daily close (data/futures-daily)", tag: SRC.zn, why: fin(px) ? null : znMarkWhy(lot.sym, lastDay) };
  };
  const tradeRow = (lot, q, entryFee, exit, exitFee, mark) => {
    const exitPx = exit ? exit.px : mark.px, cost = lot.px * q * lot.mult, fees = entryFee + (exit ? exitFee : 0);
    const gain = fin(exitPx) ? (exitPx - lot.px) * q * lot.mult - fees : null, nb = navBefore(lot.date);
    return { leg: lot.leg, sym: lot.sym, side: "long", qty: q, mult: lot.mult,
      entry: { date: lot.date, time: lot.time || null, at: lot.at || null, px: lot.px, reason: lot.reason, source: lot.source, tag: lot.tag, cid: lot.cid || null },
      exit: exit ? { date: exit.date, time: exit.time || null, at: exit.at || null, px: exit.px, reason: exit.reason, source: exit.source, tag: exit.tag, cid: exit.cid || null } : null,
      mark: exit ? null : { date: mark.date, px: mark.px, source: mark.source, tag: mark.tag },
      status: exit ? "CLOSED" : fin(exitPx) ? "OPEN" : "OPEN-UNKNOWN", costUsd: cost, gainUsd: gain, gainPct: fin(gain) ? (100 * gain) / cost : null, navPct: fin(gain) ? (100 * gain) / nb : null,
      holdDays: dayDiff(lot.date, exit ? exit.date : mark.date), feesUsd: fees, feeNote: lot.feeNote + (exit ? "" : "; exit fee not yet paid") };
  };
  const trades = [...fp.closed.map((x) => tradeRow(x.lot, x.qty, x.entryFee, x.exit, x.exitFee, null)), ...fp.open.map((x) => { const m = markOf(x.lot); if (m.why) anomalies.push(`open ${LEG_LABEL[x.lot.leg]} ${x.lot.sym} cannot be marked: ${m.why}`); return tradeRow(x.lot, x.qty, x.entryFee, null, 0, m); })];
  trades.sort((a, b) => { const ka = `${a.entry.date} ${a.entry.time || ""} ${a.leg} ${a.sym}`, kb = `${b.entry.date} ${b.entry.time || ""} ${b.leg} ${b.sym}`; return ka < kb ? -1 : ka > kb ? 1 : 0; });
  res.trades = trades;
  res.skippedWindows = zw.windows.filter((w) => w.noEntry && !w.entry).map((w) => ({ ym: w.ym, contract: w.contract, entryDay: w.entryDay, why: `no valid quote at entry (${w.noEntry}) — nothing opened` }));
  for (const r of (inp.r219 && inp.r219.ledger) || []) if (r.kind === "skipped" && r.ym >= ymOf(start)) res.skippedWindows.push({ ym: r.ym, why: r.why || "skipped" });

  // ---- upcoming: when Plan E trades next
  const up = [], st = (inp.book && inp.book.state) || {};
  for (const q of etf.queued) up.push({ when: nextSession(q.orderDate) || q.orderDate, leg: "ETF", what: `${q.side.toUpperCase()} ${q.qty} ${q.sym}`, detail: `queued (${q.status}) — ${q.cid}`, scheduled: true });
  for (const f of etf.fills.filter((x) => x.fillDate > lastDay)) up.push({ when: f.fillDate, leg: "ETF", what: `${f.side.toUpperCase()} ${f.qty} ${f.sym} FILLED @ ${num(f.px, 4)}`, detail: "filled after the last completed close — enters the record at that session's close", scheduled: false, done: true });
  for (const w of zw.windows.filter((x) => x.entry && x.entry.date > lastDay)) up.push({ when: w.entry.date, leg: "ZN", what: `BUY ${w.contract} @ ${num(w.entry.px, 6)} (R219 ask) — ENTERED`, detail: "enters the record at that session's close", scheduled: false, done: true });
  const ymNow = ymOf(et.date), monthLast = (ym) => sessDates.filter((d) => ymOf(d) === ym).pop() || null;
  let meDay = monthLast(ymNow); if (!meDay || meDay < et.date || (st.runs || {})[meDay]) meDay = monthLast(nextYm(ymNow));
  if (meDay) up.push({ when: meDay, leg: "ETF", what: "monthly rebalance: 10-month signals recomputed, every sleeve to target", detail: `BOOK run after the close (~16:15 ET); market orders fill at the ${nextSession(meDay) || "next"} open`, scheduled: true });
  for (const s of Object.keys(PE.SLEEVES).filter((k) => PE.SLEEVES[k].rule === "trend10m")) {
    const ser = adjM[s] ? lim(adjM[s]) : null, cur = (st.signals || {})[s];
    if (!ser || !ser.size) { res.signalPreview.push({ sym: s, unknown: "no adjusted closes" }); continue; }
    const o = { ...(me[s] || {}) }, ymL = ymOf(lastDay), ks = Object.keys(o).sort(); if (!ks.includes(ymL) || ks.length < 10) { res.signalPreview.push({ sym: s, unknown: "fewer than 10 month-ends" }); continue; }
    const last10 = ks.slice(ks.indexOf(ymL) - 9, ks.indexOf(ymL) + 1).map((k) => o[k]), avg = mean(last10), close = o[ymL], on = close > avg;
    res.signalPreview.push({ sym: s, asOf: lastDay, close, avg10: avg, distancePct: 100 * (close / avg - 1), ifMonthEndedNow: on ? "IN" : "OUT", bookSignal: cur ? (cur.on ? "IN" : "OUT") : null, wouldFlip: !!cur && !!cur.on !== on });
  }
  // the BOOK's own band check (its plan(), loaded verbatim) at the last close
  try {
    const px = {}; for (const s of Object.keys(PE.SLEEVES)) px[s] = raw(s, lastDay);
    const missingPx = Object.keys(px).filter((s) => !fin(px[s])), missingSig = Object.keys(PE.SLEEVES).filter((s) => !(st.signals || {})[s]);
    if (missingPx.length || missingSig.length) res.bandStatus = { unknown: `band check not run: ${missingPx.length ? `no close for ${missingPx.join(", ")}` : ""}${missingSig.length ? ` no BOOK signal for ${missingSig.join(", ")}` : ""}`.trim() };
    else {
      const h = {}; for (const f of fillsUsed) h[f.sym] = (h[f.sym] || 0) + (f.side === "buy" ? 1 : -1) * f.qty;
      const p = PE.plan({ cash: cashBook, holdings: h }, px, st.signals, false);
      res.bandStatus = { asOf: lastDay, bookNav: p.nav, orders: p.orders.map((o) => `${o.side.toUpperCase()} ${o.qty} ${o.sym}`), lines: p.lines.map((l) => { const bandUsd = Math.max(PE.BAND_FRAC * Math.max(l.targetUsd, l.heldUsd), PE.BAND_MIN_USD); return { ...l, driftUsd: l.heldUsd - l.targetUsd, bandUsd: Math.round(bandUsd) }; }) };
      if (p.orders.length) up.push({ when: `${nextSession(lastDay) || "next"} run`, leg: "ETF", what: `band trigger at the last close: ${res.bandStatus.orders.join(", ")}`, detail: "the BOOK's plan() at the last close — trades only if the drift is still outside the band at its next run", scheduled: false, conditional: true });
    }
  } catch (e) { res.bandStatus = { unknown: `band check failed: ${e.message}` }; }
  // ZN: the open window's exit, or the next window
  const closeArm = (d) => { const s = sessBy.get(d); return s ? `${hhmm(hm(s.close) - 25)}-${hhmm(hm(s.close) - 12)} ET` : "close-arm minutes"; };
  const openW = zw.windows.find((w) => w.entry && !w.exit && w.entry.date <= lastDay);
  if (openW) up.push({ when: openW.exitDay, leg: "ZN", what: `SELL ${num(openW.qtyEq, 3)} ${openW.contract} contract-eq (exit window: last session)`, detail: `R219 close-arm ${closeArm(openW.exitDay)} at the bid`, scheduled: true });
  else {
    for (let ym = ymNow, i = 0; i < 3; ym = nextYm(ym), i++) {
      const ds = sessDates.filter((d) => ymOf(d) === ym); if (ds.length < 6) continue;
      const wd = PE.windowDays(ds), have = zw.windows.find((w) => w.ym === ym);
      if ((have && (have.entry || have.noEntry)) || r219Skipped.has(ym)) continue;
      if (wd.entryDay < et.date || (wd.entryDay === et.date && sessBy.get(wd.entryDay) && et.mins > hm(sessBy.get(wd.entryDay).close) - 12)) continue;
      const contract = (have && have.contract) || PE.contractFor(ym), z = inp.znDaily, zLast = z && (z.bars || []).length ? z.bars[z.bars.length - 1] : null, navNow = fin(rows[rows.length - 1].nav) ? rows[rows.length - 1].nav : lastNav;
      const eq = zLast && fin(+zLast.c) ? (PE.ZN_LEV * LEVERAGE_K * navNow) / (+zLast.c * MULT) : null, notional = eq != null ? eq * +zLast.c * MULT : null;
      const tasty = eq != null && PE.LIMITS ? Math.min(Math.round(eq), Math.floor((PE.LIMITS.znLevCap * navNow) / (+zLast.c * MULT)), PE.LIMITS.znMaxContracts) : null;
      up.push({ when: wd.entryDay, leg: "ZN", what: `BUY ~${eq != null ? num(eq, 2) : "?"} ${contract} contract-eq (month-end window entry: 6th-to-last session)`, detail: `R219 close-arm ${closeArm(wd.entryDay)} at the ask; ~${PE.ZN_LEV}x NAV ≈ ${usd(notional, { dp: 0 })} notional at ${zLast ? `${num(+zLast.c, 4)} (${z.symbol} ${zLast.d})` : "an unknown price"}${tasty != null ? `; tastytrade would trade ${tasty} whole contract(s)` : ""}${inp.r219 && inp.r219.off ? " — R219 OFF switch present: would be SKIPPED" : ""}`, scheduled: true });
      up.push({ when: wd.exitDay, leg: "ZN", what: `SELL the ${contract} window (exit window: last session)`, detail: `R219 close-arm ${closeArm(wd.exitDay)} at the bid`, scheduled: true });
      break;
    }
  }
  // crypto: switches decided after the record's last mark (done, not yet in the record), then the next decision and its exact flip level
  for (const f of cs.fills.filter((x) => x.date > recEnd)) up.push({ when: `${f.date} UTC close`, leg: "CRYPTO", what: `${f.side.toUpperCase()} ${num(f.qty, 6)} ${f.sym} @ ${num(f.px, 2)} — DONE (derived)`, detail: `${f.reason}; after the record's last crypto mark (${recEnd} UTC close) — enters the record at the next session`, scheduled: false, done: true });
  for (const coin of PE.COINS) {
    const arr = inp.crypto && Array.isArray(inp.crypto[coin]) ? inp.crypto[coin].filter((x) => x && x.d && fin(+x.c)).map((x) => ({ d: x.d, c: +x.c })).sort((a, b) => (a.d < b.d ? -1 : 1)) : null;
    if (!arr || arr.length < PE.N) { res.cryptoLine.push({ coin, unknown: "no Coinbase closes" }); continue; }
    const last = arr[arr.length - 1], sma = mean(arr.slice(-PE.N).map((x) => x.c)), on = last.c > sma;
    const st0 = cs.state[coin], held = st0 && st0.started ? st0.held : null, pos = held == null ? on : held;
    // R191's rule on the NEXT close x: x > mean(last N-1 closes + x)  <=>  x > mean(last N-1 closes) — the exact flip level
    const flipLevel = PE.N > 1 ? mean(arr.slice(-(PE.N - 1)).map((x) => x.c)) : null, nextDay = addDays(last.d, 1);
    const r191 = inp.r191 && inp.r191.coins && inp.r191.coins[coin];
    res.cryptoLine.push({ coin, day: last.d, close: last.c, sma, distancePct: 100 * (last.c / sma - 1), signal: on ? "IN" : "OUT", sleeveHeld: held, r191Held: r191 ? !!r191.held : null, flipLevel, flipDistancePct: fin(flipLevel) ? 100 * (last.c / flipLevel - 1) : null, nextDecision: nextDay });
    if (fin(flipLevel)) up.push({ when: `${nextDay} UTC close`, leg: "CRYPTO", what: pos ? `SELL ${coin} if it closes at or below ${num(flipLevel, 2)}` : `BUY ${coin} if it closes above ${num(flipLevel, 2)}`, detail: `${PE.N}-day rule: last close ${num(last.c, 2)} (${last.d}) is ${pct(100 * (last.c / flipLevel - 1))} from that level (the mean of the last ${PE.N - 1} closes); ${PE.N}-day line ${num(sma, 2)}, distance ${pct(100 * (last.c / sma - 1))}`, scheduled: false, conditional: true });
    if (r191 && held != null && !!r191.held !== held) notes.push(`${coin}: the derived Plan E sleeve is ${held ? "IN" : "OUT"} while R191's own book is ${r191.held ? "IN" : "OUT"} (R191 decides at its run; the sleeve at the UTC close)`);
  }
  up.sort((a, b) => (String(a.when) < String(b.when) ? -1 : String(a.when) > String(b.when) ? 1 : 0));
  res.upcoming = up;

  // ---- summary
  const last = rows[rows.length - 1], markDay = sessDates.find((d) => d >= addMonths(start, 1)) || addMonths(start, 1);
  const sched = up.filter((u) => u.scheduled && !u.done && /^\d{4}-\d{2}-\d{2}$/.test(String(u.when)) && u.when >= et.date);
  const nextWhen = sched.length ? sched[0].when : null;
  const openTrades = trades.filter((t) => t.status !== "CLOSED"), openPos = {}; for (const t of openTrades) openPos[t.leg] = new Set([...(openPos[t.leg] || []), t.sym]);
  const closedT = trades.filter((t) => t.status === "CLOSED");
  res.summary = { start, asOf: lastDay, oneMonthMark: markDay, sessionsOnRecord: rows.length - 1, sessionsToMark: sessDates.filter((d) => d > start && d <= markDay).length,
    nav: last.nav, cumPct: last.cumPct, cumUsd: fin(last.nav) ? last.nav - anchor : null, modelCumPct: last.modelCumPct, vsModelPp: fin(last.cumPct) && fin(last.modelCumPct) ? last.cumPct - last.modelCumPct : null,
    spyCumPct: last.spyCumPct, vsSpyPp: fin(last.cumPct) && fin(last.spyCumPct) ? last.cumPct - last.spyCumPct : null, maxDdPct: maxDd, ddPct: last.ddPct,
    openPositions: Object.fromEntries(LEGS.filter((l) => openPos[l]).map((l) => [l, [...openPos[l]]])), openPositionCount: sum(Object.values(openPos).map((s) => s.size)), openLots: openTrades.length,
    unrealizedUsd: openTrades.every((t) => fin(t.gainUsd)) ? sum(openTrades.map((t) => t.gainUsd)) : null, closedTrades: closedT.length, realizedUsd: sum(closedT.map((t) => t.gainUsd)), wins: closedT.filter((t) => t.gainUsd > 0).length, losses: closedT.filter((t) => !(t.gainUsd > 0)).length,
    nextScheduled: nextWhen ? sched.filter((u) => u.when === nextWhen).map((u) => ({ when: u.when, leg: u.leg, what: u.what, detail: u.detail })) : [] };
  for (const ym of [...new Set(rows.map((r) => ymOf(r.date)))]) res.months[ym] = monthReport(res, ym);
  for (const a of anomalies) unknown.push(a);
  return finish();
}

function monthReport(res, ym) {
  const rows = res.daily.filter((r) => ymOf(r.date) === ym); if (!rows.length) return null;
  const i0 = res.daily.indexOf(rows[0]), before = i0 > 0 ? res.daily[i0 - 1] : null, baseNav = before ? before.nav : res.anchor, end = rows[rows.length - 1];
  const legs = {};
  for (const l of [...LEGS, "total"]) {
    const c = rows.map((r) => (l === "total" ? r.dayUsd : r.contrib[l])), known = c.filter(fin), inv = rows.map((r) => (l === "total" ? r.nav : r.invested[l])).filter(fin);
    let cum = 0, pk = 0, dd = 0; for (const x of known) { cum += x; pk = Math.max(pk, cum); dd = Math.min(dd, cum - pk); }
    const up = known.filter((x) => x > 0.005), dn = known.filter((x) => x < -0.005), byDay = rows.filter((r, i) => fin(c[i])).map((r) => ({ date: r.date, usd: l === "total" ? r.dayUsd : r.contrib[l] }));
    const moved = up.length + dn.length > 0;   // a leg that never moved has no best or worst day
    const best = moved ? byDay.reduce((a, b) => (b.usd > a.usd ? b : a)) : null, worst = moved ? byDay.reduce((a, b) => (b.usd < a.usd ? b : a)) : null;
    const closed = res.trades.filter((t) => t.status === "CLOSED" && ymOf(t.exit.date) === ym && (l === "total" || t.leg === l)), wins = closed.filter((t) => t.gainUsd > 0), losses = closed.filter((t) => !(t.gainUsd > 0));
    legs[l] = { pnlUsd: known.length === c.length ? sum(known) : null, deployedAvgUsd: inv.length ? mean(inv) : null, deployedPeakUsd: inv.length ? Math.max(...inv) : null, gainsUsd: sum(up), lossesUsd: sum(dn), upDays: up.length, downDays: dn.length,
      avgUpDayUsd: up.length ? mean(up) : null, avgDownDayUsd: dn.length ? mean(dn) : null, bestDay: best, worstDay: worst, worstDrawdownUsd: dd, unknownDays: c.length - known.length,
      tradesClosed: closed.length, wins: wins.length, losses: losses.length, avgWinUsd: wins.length ? mean(wins.map((t) => t.gainUsd)) : null, avgLossUsd: losses.length ? mean(losses.map((t) => t.gainUsd)) : null, realizedUsd: sum(closed.map((t) => t.gainUsd)) };
  }
  let g = 1, ok = true; for (const r of rows) { if (r.start) continue; if (fin(r.modelPct)) g *= 1 + r.modelPct / 100; else ok = false; }
  let pk = fin(baseNav) ? baseNav : null, dd = 0; for (const r of rows) if (fin(r.nav) && pk != null) { pk = Math.max(pk, r.nav); dd = Math.min(dd, 100 * (r.nav / pk - 1)); }
  const spyB = before ? before.spyCumPct : 0;
  return { ym, sessions: rows.length, from: rows[0].date, to: end.date, startNav: baseNav, endNav: end.nav, pnlUsd: fin(end.nav) && fin(baseNav) ? end.nav - baseNav : null, retPct: fin(end.nav) && fin(baseNav) ? 100 * (end.nav / baseNav - 1) : null,
    modelPct: ok ? 100 * (g - 1) : null, spyPct: fin(end.spyCumPct) && fin(spyB) ? 100 * ((1 + end.spyCumPct / 100) / (1 + spyB / 100) - 1) : null, maxDdPct: pk != null ? dd : null, unknownDays: rows.filter((r) => r.unknown.length).length, legs };
}

// ================================================================ rendering ================================================================
function headerLines(res, title) {
  const L = [`PLAN E PAPER — ${title} · since ${res.start} · record through the ${res.asOf || "?"} close · anchor ${usd(res.anchor, { dp: 0 })} · status ${res.status}`];
  if (res.status !== "OK") for (const u of res.unknown) L.push(`  UNKNOWN: ${u}`);
  return L;
}
function renderTrades(res) {
  const L = headerLines(res, "TRADE LOG + UPCOMING");
  L.push(`  anchor: ${res.anchorChoice || "—"}`, "");
  L.push(`${pad("#", 3)} ${pad("STATUS", 12)} ${pad("LEG", 6)} ${pad("SYMBOL", 7)} ${pad("SIDE", 5)} ${padL("QTY", 16)}  ${pad("ENTRY (date time ET · price)", 34)} ${pad("EXIT / MARK", 36)} ${padL("$ P&L", 12)} ${padL("% P&L", 8)} ${padL("% NAV", 7)} ${padL("DAYS", 4)} ${padL("FEES", 8)}`);
  res.trades.forEach((t, i) => {
    const ent = `${t.entry.date} ${t.entry.time || "--:--"} ${num(t.entry.px, t.leg === "etf" ? 4 : t.leg === "zn" ? 6 : 2)} [${t.entry.tag}]`;
    const ex = t.exit ? `${t.exit.date} ${t.exit.time || "--:--"} ${num(t.exit.px, t.leg === "etf" ? 4 : t.leg === "zn" ? 6 : 2)} [${t.exit.tag}]` : `mark ${t.mark.date} ${fin(t.mark.px) ? num(t.mark.px, t.leg === "zn" ? 6 : 2) : "UNKNOWN"} [${t.mark.tag}]`;
    L.push(`${pad(i + 1, 3)} ${pad(t.status, 12)} ${pad(LEG_LABEL[t.leg], 6)} ${pad(t.sym, 7)} ${pad(String(t.side).toUpperCase(), 5)} ${padL(qtyStr(t.leg, t.qty), 16)}  ${pad(ent, 34)} ${pad(ex, 36)} ${padL(usd(t.gainUsd, { sign: true }), 12)} ${padL(pct(t.gainPct), 8)} ${padL(pct(t.navPct, { dp: 3 }), 7)} ${padL(t.holdDays, 4)} ${padL(usd(t.feesUsd), 8)}`);
    L.push(`      why: ${t.entry.reason}${t.exit ? `  ->  ${t.exit.reason}` : ""}`);
  });
  if (!res.trades.length) L.push("  (no trades on record yet)");
  const s = res.summary;
  if (s) L.push("", `CLOSED ${s.closedTrades} (${s.wins} win / ${s.losses} loss) realized ${usd(s.realizedUsd, { sign: true })} · OPEN ${s.openLots} lot(s) in ${s.openPositionCount} position(s) unrealized ${usd(s.unrealizedUsd, { sign: true })} · fees: ETF = the broker's FEE activities (Plan E's share, allocated by notional); ZN and crypto assumed (see each row)`);
  for (const w of res.skippedWindows || []) L.push(`  ZN window ${w.ym} SKIPPED: ${w.why}`);
  L.push("", "UPCOMING — when Plan E trades next");
  L.push(`${pad("WHEN", 21)} ${pad("LEG", 7)} ${pad("WHAT", 70)} DETAIL`);
  for (const u of res.upcoming) L.push(`${pad(u.when, 21)} ${pad(u.leg, 7)} ${pad(u.what + (u.conditional ? " (conditional)" : ""), 70)} ${u.detail}`);
  if (res.signalPreview.length) { L.push("", "ETF 10-month signals — if the month ended at the last close (decided only at the month-end close):"); for (const p of res.signalPreview) L.push(p.unknown ? `  ${pad(p.sym, 5)} UNKNOWN (${p.unknown})` : `  ${pad(p.sym, 5)} ${pad(p.ifMonthEndedNow, 3)} close ${num(p.close, 2)} vs 10-month avg ${num(p.avg10, 2)} (${pct(p.distancePct)}) · BOOK holds it ${p.bookSignal || "?"}${p.wouldFlip ? "  <- WOULD FLIP at month-end" : ""}`); }
  if (res.bandStatus) { L.push("", `ETF band check (the BOOK's plan() at the ${res.bandStatus.asOf || "last"} close):`); if (res.bandStatus.unknown) L.push(`  UNKNOWN — ${res.bandStatus.unknown}`); else { for (const l of res.bandStatus.lines) L.push(`  ${pad(l.sym, 5)} ${pad(l.signal, 4)} target ${padL(usd(l.targetUsd, { dp: 0 }), 9)} held ${padL(usd(l.heldUsd, { dp: 0 }), 9)} drift ${padL(usd(l.driftUsd, { sign: true, dp: 0 }), 8)} of a ${usd(l.bandUsd, { dp: 0 })} band${l.qty ? `  -> ${l.qty > 0 ? "+" : ""}${l.qty} sh` : ""}`); L.push(`  ${res.bandStatus.orders.length ? "would trade: " + res.bandStatus.orders.join(", ") : "no band trades (every sleeve inside its band)"}`); } }
  if (res.cryptoLine.length) { L.push("", `Crypto ${res.legs ? res.legs.cryptoN : ""}-day line (freshest completed Coinbase UTC close):`); for (const x of res.cryptoLine) L.push(x.unknown ? `  ${pad(x.coin, 4)} UNKNOWN (${x.unknown})` : `  ${pad(x.coin, 4)} ${x.day} close ${num(x.close, 2)} vs ${num(x.sma, 2)} (${pct(x.distancePct)}) -> ${x.signal} · Plan E sleeve ${x.sleeveHeld == null ? "?" : x.sleeveHeld ? "IN" : "OUT"} · R191 ${x.r191Held == null ? "?" : x.r191Held ? "IN" : "OUT"} · ${x.nextDecision} UTC close ${x.signal === "IN" ? "flips OUT at or below" : "flips IN above"} ${num(x.flipLevel, 2)} (${pct(x.flipDistancePct)} away)`); }
  L.push("", "sources: [F] broker fill (Alpaca BOOK paper) · [L] BOOK ledger fill price (time not recorded) · [Q] quote-priced (R219 Schwab ask in / bid out, not a fill) · [D] derived at the Coinbase UTC daily close (not a fill) · [C] SIP raw close · [Z] Schwab ZN daily close");
  L.push("% P&L = $ P&L / entry cost (ZN: of notional) · % NAV = $ P&L / Plan E NAV before entry · DAYS = calendar days · open trades: exit fee not yet paid");
  if (res.notes.length) { L.push("", "notes:"); for (const n of res.notes) L.push(`  - ${n}`); }
  return L.join("\n");
}
function renderDaily(res) {
  const L = headerLines(res, "DAILY NAV");
  L.push(`  anchor: ${res.anchorChoice || "—"} · legs: ETF = BOOK (Alpaca paper fills) · CRYPTO = derived 50-day sleeve · ZN = R219 quote-priced x ${res.legs ? res.legs.znLev : "?"}x · CASH = $${res.legs ? res.legs.allocation.cash.toLocaleString("en-US") : "?"} reserve as SGOV`, "");
  const lc = (r, l) => (fin(r.contrib[l]) ? `${usd(r.contrib[l], { sign: true })} ${pct(r.contribPct[l])}` : "UNKNOWN");
  L.push(`${pad("DATE", 10)} ${padL("NAV", 13)} ${padL("DAY $", 11)} ${padL("DAY %", 7)} ${padL("ETF $ / %", 19)} ${padL("CRYPTO $ / %", 19)} ${padL("ZN $ / %", 19)} ${padL("CASH $ / %", 17)} ${padL("MODEL %", 8)} ${padL("TRACK", 9)} ${padL("CUM %", 7)} ${padL("MODEL CUM", 9)} ${padL("SPY CUM", 8)} ${padL("DD %", 7)}`);
  for (const r of res.daily) L.push(`${pad(r.date, 10)} ${padL(usd(r.nav), 13)} ${padL(usd(r.dayUsd, { sign: true }), 11)} ${padL(pct(r.dayPct), 7)} ${padL(lc(r, "etf"), 19)} ${padL(lc(r, "crypto"), 19)} ${padL(lc(r, "zn"), 19)} ${padL(lc(r, "cash"), 17)} ${padL(r.start ? "start" : pct(r.modelPct), 8)} ${padL(r.start ? "—" : pp(r.trackingPp), 9)} ${padL(pct(r.cumPct), 7)} ${padL(pct(r.modelCumPct), 9)} ${padL(pct(r.spyCumPct), 8)} ${padL(pct(r.ddPct), 7)}${r.unknown.length ? "  UNKNOWN: " + r.unknown.join("; ") : ""}`);
  const s = res.summary;
  if (s) L.push("", `${s.sessionsOnRecord}/${s.sessionsToMark} sessions toward the one-month mark (${s.oneMonthMark}) · NAV ${usd(s.nav)} (${usd(s.cumUsd, { sign: true })}, ${pct(s.cumPct)}) · model ${pct(s.modelCumPct)} (paper vs model ${pp(s.vsModelPp)}) · SPY ${pct(s.spyCumPct)} (vs SPY ${pp(s.vsSpyPp)}) · max drawdown ${pct(s.maxDdPct)}`,
    `day 0 (${res.start}) = start: the BOOK placed its first orders after that close; the crypto sleeve opened at the UTC close before it (25 bps assumed); the model starts at that close`);
  if (res.notes.length) { L.push("", "notes:"); for (const n of res.notes) L.push(`  - ${n}`); }
  return L.join("\n");
}
function renderMonth(res, ym) {
  const m = res.months[ym], L = headerLines(res, `MONTH ${ym}`);
  if (!m) { L.push(`  no sessions on record in ${ym}`); return L.join("\n"); }
  L.push(`  ${m.sessions} session(s) ${m.from}..${m.to} · NAV ${usd(m.startNav)} -> ${usd(m.endNav)} = ${usd(m.pnlUsd, { sign: true })} (${pct(m.retPct)}) · model ${pct(m.modelPct)} · SPY ${pct(m.spyPct)} · max drawdown ${pct(m.maxDdPct)}${m.unknownDays ? ` · ${m.unknownDays} UNKNOWN day(s)` : ""}`, "");
  L.push(`${pad("LEG", 7)} ${padL("DEPLOYED avg", 13)} ${padL("peak", 11)} ${padL("P&L $", 11)} ${padL("GAINS $", 10)} ${padL("LOSSES $", 10)} ${padL("UP/DN days", 10)} ${padL("avg up", 9)} ${padL("avg dn", 9)} ${pad("  BEST DAY", 21)} ${pad("WORST DAY", 21)} ${padL("WORST DD $", 10)} ${padL("TRADES W/L", 10)} ${padL("avg win", 10)} ${padL("avg loss", 10)}`);
  for (const l of [...LEGS, "total"]) { const x = m.legs[l]; L.push(`${pad(l === "total" ? "TOTAL" : LEG_LABEL[l], 7)} ${padL(usd(x.deployedAvgUsd, { dp: 0 }), 13)} ${padL(usd(x.deployedPeakUsd, { dp: 0 }), 11)} ${padL(usd(x.pnlUsd, { sign: true }), 11)} ${padL(usd(x.gainsUsd), 10)} ${padL(usd(x.lossesUsd), 10)} ${padL(`${x.upDays}/${x.downDays}`, 10)} ${padL(x.avgUpDayUsd == null ? "—" : usd(x.avgUpDayUsd), 9)} ${padL(x.avgDownDayUsd == null ? "—" : usd(x.avgDownDayUsd), 9)} ${pad(x.bestDay ? `  ${x.bestDay.date} ${usd(x.bestDay.usd, { sign: true })}` : "  —", 21)} ${pad(x.worstDay ? `${x.worstDay.date} ${usd(x.worstDay.usd, { sign: true })}` : "—", 21)} ${padL(usd(x.worstDrawdownUsd), 10)} ${padL(`${x.tradesClosed} ${x.wins}/${x.losses}`, 10)} ${padL(x.avgWinUsd == null ? "—" : usd(x.avgWinUsd, { sign: true }), 10)} ${padL(x.avgLossUsd == null ? "—" : usd(x.avgLossUsd, { sign: true }), 10)}`); }
  L.push("", "DEPLOYED = average / peak invested $ on the month's sessions (ETF: positions excl. the BOOK's cash; CRYPTO: coins held; ZN: notional while a window is open; CASH: the reserve; TOTAL: NAV)",
    "GAINS / LOSSES / UP-DN / BEST / WORST = daily mark-to-market contributions · WORST DD $ = deepest peak-to-trough of the month's cumulative contribution · TRADES = trades CLOSED this month (FIFO), wins/losses by $ P&L (a win is > $0; a flat $0 trade counts as a loss, so wins + losses = trades)");
  return L.join("\n");
}
function renderLine(res) {
  const s = res.summary;
  if (!s) return `Plan E paper: UNKNOWN — ${res.unknown.join("; ") || "no record"}`;
  const nx = s.nextScheduled.length ? `${s.nextScheduled[0].when} ${s.nextScheduled.map((u) => `${u.leg} ${u.what}`).join(" + ")}` : "none scheduled";
  const op = Object.entries(s.openPositions).map(([l, a]) => `${LEG_LABEL[l]} ${a.length}`).join(", ");
  return `Plan E paper${res.status !== "OK" ? " [UNKNOWN: " + res.unknown.length + " issue(s)]" : ""}: ${s.sessionsOnRecord}/${s.sessionsToMark} sessions toward the one-month mark (${s.oneMonthMark}) since ${s.start} · NAV ${usd(s.nav)} cum ${pct(s.cumPct)} (${usd(s.cumUsd, { sign: true })}) · vs model ${pp(s.vsModelPp)} · vs SPY ${pp(s.vsSpyPp)} · open trades ${s.openPositionCount}${op ? ` (${op})` : ""} · next scheduled trade: ${nx}`;
}

// ================================================================ outputs ================================================================
function writeOutputs(F, res, nowIso) {
  let prev = new Map(), bad = 0;
  if (fs.existsSync(F.hist)) for (const l of fs.readFileSync(F.hist, "utf8").split(/\r?\n/)) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r && r.date) prev.set(r.date, r); else bad++; } catch { bad++; } }
  let histWritten = false;
  if (bad) { res.unknown.push(`history file has ${bad} unparsable line(s) — not rewritten`); res.status = "UNKNOWN"; }
  else {
    const out = new Map(prev);
    for (const r of res.daily) {
      const p = prev.get(r.date), row = { date: r.date, status: r.unknown.length ? "UNKNOWN" : "OK", nav: rnd(r.nav), dayUsd: rnd(r.dayUsd), dayPct: rnd(r.dayPct, 4),
        legs: Object.fromEntries(LEGS.map((l) => [l, { value: rnd(r.value[l]), contribUsd: rnd(r.contrib[l]), contribPct: rnd(r.contribPct[l], 4) }])),
        modelPct: rnd(r.modelPct, 4), trackingPp: rnd(r.trackingPp, 4), cumPct: rnd(r.cumPct, 4), modelCumPct: rnd(r.modelCumPct, 4), spyCumPct: rnd(r.spyCumPct, 4), ddPct: rnd(r.ddPct, 4),
        unknown: r.unknown, firstWrittenAt: p ? p.firstWrittenAt || p.writtenAt || nowIso : nowIso, writtenAt: nowIso };
      const revs = p && Array.isArray(p.revisions) ? [...p.revisions] : [];
      if (p && (p.nav !== row.nav || p.status !== row.status)) revs.push({ on: nowIso, prevNav: p.nav, prevStatus: p.status });
      if (revs.length) row.revisions = revs.slice(-10);
      out.set(r.date, row);
    }
    writeTextAtomic(F.hist, [...out.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((r) => JSON.stringify(r)).join("\n") + "\n");
    histWritten = true;
  }
  writeJsonAtomic(F.out, { ...res, writtenAt: nowIso });
  return { histWritten };
}

// ================================================================ CLI ================================================================
async function main(argv) {
  const mode = ["--trades", "--print", "--line", "--month", "--selftest"].find((m) => argv.includes(m));
  if (!mode) { console.error("usage: node backend/planE-paper-scoreboard.js --trades | --print | --line | --month YYYY-MM | --selftest"); return 2; }
  if (mode === "--selftest") return selftest();
  let ym = null;
  if (mode === "--month") { ym = argv[argv.indexOf("--month") + 1]; if (!/^\d{4}-\d{2}$/.test(ym || "")) { console.error("usage: --month YYYY-MM"); return 2; } }
  const F = files(path.join(BACKEND, "data"));
  let inp;
  try { inp = await gather(F); }
  catch (e) { console.log(`PLAN E PAPER — UNKNOWN: inputs could not be assembled (${e.message})`); return 3; }   // ERROR -> UNKNOWN, printed
  const res = compute(inp);
  if (mode === "--trades") console.log(renderTrades(res));
  else if (mode === "--print") { const w = writeOutputs(F, res, inp.nowIso); console.log(renderDaily(res)); console.log(`\nwrote ${path.relative(path.join(BACKEND, ".."), F.out)}${w.histWritten ? ` + ${path.relative(path.join(BACKEND, ".."), F.hist)} (${res.daily.length} session row(s))` : " (history NOT rewritten — see UNKNOWN)"}`); }
  else if (mode === "--line") console.log(renderLine(res));
  else console.log(renderMonth(res, ym));
  if (mode === "--month" && (!res.months[ym] || res.months[ym].unknownDays)) return 3;
  return res.status === "OK" ? 0 : 3;
}

// ================================================================ selftest ================================================================
async function selftest() {
  let pass = 0, fail = 0;
  const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}`); } };
  const near = (a, b, what, tol = 1e-6) => ok(fin(a) && fin(b) && Math.abs(a - b) <= tol, `${what}: got ${a}, want ${b}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "planE-scoreboard-selftest-"));
  try {
    const weekdays = (a, b) => { const o = []; for (let d = a; d <= b; d = addDays(d, 1)) { const w = new Date(d + "T00:00:00Z").getUTCDay(); if (w > 0 && w < 6) o.push(d); } return o; };
    const planCalls = [];
    const PE = { BOOK_CAPITAL: 73000, PLAN_E_BOOK_USD: 100000, SLEEVES: { QQQ: { w: 0.5, rule: "trend10m" }, DBMF: { w: 0.5, rule: "hold" }, SGOV: { w: 0, rule: "park" } }, BAND_FRAC: 0.1, BAND_MIN_USD: 500,
      W: { QQQ: 0.4, DBMF: 0.3, BTC: 0.075, ETH: 0.075 }, ZN_LEV: 4.2, ZN_BETA: 0.79, COINS: ["BTC", "ETH"], N: 3, LIMITS: { znLevCap: 5, znMaxContracts: 4 },
      windowDays: (ds) => ({ entryDay: ds[ds.length - 6], exitDay: ds[ds.length - 1] }), contractFor: () => "/ZNZ26",
      decide: (bars) => { const last = bars[bars.length - 1], sma = mean(bars.slice(-PE.N).map((b) => b.c)); return { last, sma, want: last.c > sma }; },   // R191's decision line (section 8 pins the real one's tie)
      plan: (s, px, sig, full) => { planCalls.push({ s: JSON.parse(JSON.stringify(s)), px, full }); return { nav: 1, orders: [], lines: [{ sym: "QQQ", signal: "IN", targetUsd: 100, heldUsd: 100, qty: 0 }] }; } };
    const monthEnds = {}; for (let ym = "2025-08"; ym <= "2026-08"; ym = nextYm(ym)) monthEnds[`${ym}-28`] = 100;
    const ser = (o) => Object.entries(o).map(([d, c]) => ({ d, c }));
    const base = () => ({
      start: START, anchor: 100000, et: { date: "2026-10-05", mins: 17 * 60 }, nowIso: "2026-10-05T21:00:00.000Z", PE, R219c: { QTY: 2, MULT: 1000, BOOK: 50000, FEE_SIDE: 2.5 },
      sessions: weekdays("2026-09-01", "2026-11-30").map((d) => ({ date: d, open: "09:30", close: "16:00" })),
      raw: { QQQ: ser({ "2026-09-29": 99, "2026-09-30": 101, "2026-10-01": 104, "2026-10-02": 112, "2026-10-05": 121 }), DBMF: ser({ "2026-09-29": 30, "2026-09-30": 30.5, "2026-10-01": 30.2, "2026-10-02": 30.4, "2026-10-05": 31 }), SGOV: ser({ "2026-09-29": 100, "2026-09-30": 100, "2026-10-01": 100, "2026-10-02": 100, "2026-10-05": 100 }) },
      adj: { QQQ: ser({ ...monthEnds, "2026-09-29": 108, "2026-09-30": 110, "2026-10-01": 111.1, "2026-10-02": 112, "2026-10-05": 113 }), DBMF: ser({ "2026-09-29": 30, "2026-09-30": 30.5, "2026-10-01": 30.2, "2026-10-02": 30.4, "2026-10-05": 31 }),
        IEF: ser({ "2026-09-29": 95, "2026-09-30": 95.95, "2026-10-01": 96, "2026-10-02": 96, "2026-10-05": 96.5 }), SGOV: ser({ "2026-09-29": 100, "2026-09-30": 100.01, "2026-10-01": 100.02, "2026-10-02": 100.03, "2026-10-05": 100.05 }),
        SPY: ser({ "2026-09-29": 500, "2026-09-30": 501, "2026-10-01": 502, "2026-10-02": 505, "2026-10-05": 510 }) },
      crypto: { BTC: ser({ "2026-09-26": 100, "2026-09-27": 101, "2026-09-28": 102, "2026-09-29": 104, "2026-09-30": 99, "2026-10-01": 98, "2026-10-02": 103, "2026-10-03": 105, "2026-10-04": 106 }),
        ETH: ser({ "2026-09-26": 10, "2026-09-27": 10.5, "2026-09-28": 11, "2026-09-29": 11.5, "2026-09-30": 12, "2026-10-01": 12.5, "2026-10-02": 13, "2026-10-03": 13.5, "2026-10-04": 14 }) },
      broker: { ok: true, positions: [{ symbol: "QQQ", qty: "30" }, { symbol: "DBMF", qty: "1000" }, { symbol: "AAPL", qty: "1" }], activities: [{ activity_type: "DIV", symbol: "DBMF", net_amount: "5", date: "2026-10-02" }],
        orders: [
          { id: "1", client_order_id: "book-20260929-QQQ-buy", symbol: "QQQ", side: "buy", qty: "100", filled_qty: "100", filled_avg_price: "100", filled_at: "2026-09-30T13:30:05Z", status: "filled" },
          { id: "2", client_order_id: "book-20260929-DBMF-buy", symbol: "DBMF", side: "buy", qty: "1000", filled_qty: "1000", filled_avg_price: "30", filled_at: "2026-09-30T13:30:06Z", status: "filled" },
          { id: "3", client_order_id: "book-20261001-QQQ-buy", symbol: "QQQ", side: "buy", qty: "50", filled_qty: "50", filled_avg_price: "110", filled_at: "2026-10-02T13:30:05Z", status: "filled" },
          { id: "4", client_order_id: "book-20261002-QQQ-sell", symbol: "QQQ", side: "sell", qty: "120", filled_qty: "120", filled_avg_price: "120", filled_at: "2026-10-05T13:30:05Z", status: "filled" },
          { id: "5", client_order_id: "manual-xyz", symbol: "AAPL", side: "buy", qty: "1", filled_qty: "1", filled_avg_price: "200", filled_at: "2026-10-01T14:00:00Z", status: "filled" }] },
      book: { off: false, state: { cash: 0, holdings: {}, pending: [], navHistory: [], signals: { QQQ: { on: true }, DBMF: { on: true, hold: true }, SGOV: { on: true, park: true } },
          runs: { "2026-09-29": { full: true, monthEnd: false }, "2026-09-30": { full: true, monthEnd: true }, "2026-10-01": { full: false, monthEnd: false }, "2026-10-02": { full: false, monthEnd: false }, "2026-10-05": { full: false, monthEnd: false } } },
        ledger: [{ kind: "daily", date: "2026-09-29", lines: [{ sym: "QQQ", signal: "IN" }] }, { kind: "month-end", date: "2026-09-30", lines: [{ sym: "QQQ", signal: "IN" }] }, { kind: "daily", date: "2026-10-01", lines: [] }, { kind: "daily", date: "2026-10-02", lines: [] }, { kind: "daily", date: "2026-10-05", lines: [] },
          { kind: "fill-filled", cid: "book-20260929-QQQ-buy", sym: "QQQ", side: "buy", filledQty: 100, px: 100 }, { kind: "fill-filled", cid: "book-20260929-DBMF-buy", sym: "DBMF", side: "buy", filledQty: 1000, px: 30 },
          { kind: "fill-filled", cid: "book-20261001-QQQ-buy", sym: "QQQ", side: "buy", filledQty: 50, px: 110 }] },
      r219: { off: false, ledger: [], state: { windows: { "2026-10": { ym: "2026-10", entryDay: "2026-10-01", exitDay: "2026-10-30", contract: "/ZNZ26", entry: { px: 112.0, at: "2026-10-01T19:40:00Z", bid: 111.984375, ask: 112, spreadTicks: 1 } } } } },
      znDaily: { symbol: "/ZNZ26", bars: [{ d: "2026-10-01", c: 112.25 }, { d: "2026-10-02", c: 112.5 }, { d: "2026-10-05", c: 112.75 }] },
      r191: { coins: { BTC: { held: true }, ETH: { held: true } } }, leverage: { exploratory: true, rows: [{ k: 1 }] }, dtb3: { byMonth: { "2026-09": 4.0, "2026-10": 4.0 }, last: "2026-10-30" }, unknown: [], notes: [], sources: null,
    });
    const clone = (o) => { const c = JSON.parse(JSON.stringify(o)); c.PE = o.PE; return c; };

    // ---------- 1. main scenario: known answers
    let inp = base(), r = compute(clone(inp));
    ok(r.status === "OK", `main scenario status OK (unknown: ${r.unknown.join(" | ")})`);
    ok(r.asOf === "2026-10-05" && r.daily.length === 5, "record = 5 sessions 09-29..10-05");
    const etfV = [73000, 73600, 73600, 74705, 76535]; r.daily.forEach((d, i) => near(d.value.etf, etfV[i], `ETF leg ${d.date}`));
    const q1 = 7481.25 / 102, btcCash = q1 * 99 * (1 - 0.0025), q2 = (btcCash * (1 - 0.0025)) / 103, qe = 7481.25 / 11;
    const crV = [q1 * 102 + qe * 11, q1 * 104 + qe * 11.5, btcCash + qe * 12, btcCash + qe * 12.5, q2 * 106 + qe * 14]; r.daily.forEach((d, i) => near(d.value.crypto, crV[i], `CRYPTO leg ${d.date}`));
    const cashV = [12000, 12001.2, 12002.4, 12003.6, 12006]; r.daily.forEach((d, i) => near(d.value.cash, cashV[i], `CASH reserve (SGOV) ${d.date}`));
    const nav0930 = 73600 + crV[1] + 12001.2, qz = (4.2 * nav0930) / 112000, znV = [0, 0, 250 * qz - 2.5 * qz, 500 * qz - 2.5 * qz, 750 * qz - 2.5 * qz];
    r.daily.forEach((d, i) => near(d.value.zn, znV[i], `ZN leg ${d.date}`));
    r.daily.forEach((d, i) => near(d.nav, etfV[i] + crV[i] + cashV[i] + znV[i], `NAV ${d.date}`));
    near(r.daily[0].dayUsd, -37.5, "day-0 cost = crypto entry fees 2 x 0.25% x $7,500");
    near(r.daily[4].cumPct, 100 * ((etfV[4] + crV[4] + cashV[4] + znV[4]) / 100000 - 1), "cumulative % vs the $100k anchor");
    near(r.daily[4].spyCumPct, 2, "SPY cumulative % 500 -> 510");
    { let pk = 100000, dd = 0; for (let i = 0; i < 5; i++) { const n = etfV[i] + crV[i] + cashV[i] + znV[i]; pk = Math.max(pk, n); dd = Math.min(dd, 100 * (n / pk - 1)); } near(r.summary.maxDdPct, dd, "max drawdown from the anchor peak"); }
    near(r.daily[2].contrib.etf, 0, "ETF contribution 10-01 = 0"); near(r.daily[3].contrib.etf, 1105, "ETF contribution 10-02 (+dividend $5)");
    near(r.daily[1].modelPct, 100 * (0.3 * (30.5 / 30 - 1) + 0.075 * (104 / 102 - 1) + 0.075 * (11.5 / 11 - 1) + 4.2 * 0.79 * (95.95 / 95 - 1 - 0.04 / 252) - 0.0004 * 4.2 / 2 + (1 - 0.45) * (0.04 / 252)), "model 09-30: QQQ OUT (Aug signal), DBMF, crypto, ZN window last day (the proxy financed at the T-bill), cash at T-bill");
    near(r.daily[2].modelPct, 100 * (0.4 * (111.1 / 110 - 1) + 0.3 * (30.2 / 30.5 - 1) + 0.075 * (99 / 104 - 1 - 0.0025) + 0.075 * (12 / 11.5 - 1) + (1 - 0.85) * (0.04 / 252)), "model 10-01: QQQ IN (Sep signal), BTC flip cost, no ZN window");
    near(r.daily[2].trackingPp, r.daily[2].dayPct - r.daily[2].modelPct, "tracking = paper day % - model day %");
    ok(r.daily[0].start && r.daily[0].modelPct == null && r.daily[0].modelCumPct === 0, "day 0 is the start: no model return");
    // FIFO
    const qqq = r.trades.filter((t) => t.leg === "etf" && t.sym === "QQQ");
    ok(qqq.length === 3, `QQQ: 2 closed lots + 1 open lot (got ${qqq.length})`);
    const c1 = qqq.find((t) => t.status === "CLOSED" && t.entry.px === 100), c2 = qqq.find((t) => t.status === "CLOSED" && t.entry.px === 110), o1 = qqq.find((t) => t.status === "OPEN");
    ok(c1 && c1.qty === 100 && c2 && c2.qty === 20 && o1 && Math.abs(o1.qty - 30) < 1e-9, "FIFO: sell 120 closes the 100 @100 lot then 20 of the 50 @110 lot; 30 stay open");
    if (c1) { near(c1.gainUsd, 2000, "FIFO lot 1 $ gain"); near(c1.gainPct, 20, "FIFO lot 1 % gain"); ok(c1.holdDays === 5 && c1.entry.date === "2026-09-30" && c1.exit.date === "2026-10-05" && c1.entry.time === "09:30", "lot 1 dates/time/holding days"); ok(/^initial allocation/.test(c1.entry.reason) && /^band trigger/.test(c1.exit.reason), "lot 1 reasons from the BOOK's runs"); }
    if (c2) near(c2.gainUsd, 200, "FIFO lot 2 $ gain");
    if (o1) { near(o1.gainUsd, 330, "open lot marked at the last close 121"); ok(o1.mark.date === "2026-10-05" && o1.mark.px === 121 && o1.holdDays === 3, "open lot mark date/px/holding days"); }
    const dbmf = r.trades.find((t) => t.sym === "DBMF"); ok(dbmf && dbmf.status === "OPEN", "DBMF open"); if (dbmf) near(dbmf.gainUsd, 1000, "DBMF open $ gain");
    const btc = r.trades.filter((t) => t.sym === "BTC"), bc = btc.find((t) => t.status === "CLOSED"), bo = btc.find((t) => t.status === "OPEN");
    ok(btc.length === 2 && bc && bo, "BTC: one closed round trip + one open re-entry");
    if (bc) { near(bc.gainUsd, btcCash - 7500, "BTC closed $ gain = slot cash after the round trip - $7,500"); ok(bc.entry.date === "2026-09-28" && bc.exit.date === "2026-09-30" && /^signal flip OUT/.test(bc.exit.reason), "BTC entry at the 09-28 UTC close, exit on the 09-30 flip"); near(bc.feesUsd, 18.75 + q1 * 99 * 0.0025, "BTC fees both sides"); }
    if (bo) { near(bo.entry.px, 103, "BTC re-entry at the 10-02 close"); near(bo.gainUsd, (106 - 103) * q2 - 0.0025 * btcCash, "BTC open marked at the 10-04 UTC close"); ok(bo.mark.date === "2026-10-04", "crypto mark = UTC close of the last session - 1"); }
    const zt = r.trades.find((t) => t.leg === "zn"); ok(zt && zt.status === "OPEN", "ZN window open");
    if (zt) { near(zt.qty, qz, "ZN contract-equivalents = 4.2 x NAV(09-30) / (112 x 1000)"); near(zt.gainUsd, 750 * qz - 2.5 * qz, "ZN open marked at the 10-05 ZN close 112.75 net of the entry fee"); ok(zt.entry.tag === SRC.quote && zt.mark.px === 112.75, "ZN entry quote-priced, mark from the daily store"); }
    ok(r.notes.some((n) => /without a book- client id excluded.*manual-\* x1 \(AAPL\)/.test(n)) && r.notes.some((n) => /1 position\(s\) that are not Plan E symbols — excluded: AAPL 1$/.test(n)), "a non-book order and its position are excluded (noted)");
    ok(r.notes.some((n) => /not yet reconciled.*book-20261002-QQQ-sell/.test(n)), "a broker fill missing from the BOOK ledger is counted and noted");
    ok(planCalls.length === 1 && Math.abs(planCalls[0].s.cash - 41900) < 1e-9 && planCalls[0].s.holdings.QQQ === 30 && planCalls[0].s.holdings.DBMF === 1000 && planCalls[0].full === false, "band check: the BOOK's plan() gets the reconstructed cash $41,900 (no dividend) and holdings, band-only");
    ok(r.upcoming.some((u) => u.leg === "ZN" && u.when === "2026-10-30" && /^SELL/.test(u.what)) && r.upcoming.some((u) => u.leg === "ETF" && u.when === "2026-10-30" && /monthly rebalance/.test(u.what)), "upcoming: ZN exit + ETF month-end 10-30");
    ok(r.summary.nextScheduled.length === 2 && r.summary.nextScheduled[0].when === "2026-10-30", "next scheduled = 2026-10-30 (two legs)");
    ok(r.summary.sessionsOnRecord === 4 && r.summary.sessionsToMark === 22 && r.summary.oneMonthMark === "2026-10-29", `one-month mark: 4/22 sessions to 10-29 (got ${r.summary.sessionsOnRecord}/${r.summary.sessionsToMark} ${r.summary.oneMonthMark})`);
    const line = renderLine(r); ok(/^Plan E paper: 4\/22 sessions toward the one-month mark \(2026-10-29\)/.test(line) && /next scheduled trade: 2026-10-30/.test(line) && !/\n/.test(line), `--line is one line with the counts and next trade: ${line}`);
    const mo = r.months["2026-10"], ms = r.months["2026-09"];
    ok(mo && mo.legs.etf.tradesClosed === 2 && mo.legs.etf.wins === 2 && mo.legs.etf.losses === 0, "October: 2 ETF trades closed, 2 wins"); if (mo) { near(mo.legs.etf.avgWinUsd, 1100, "October ETF average win"); near(mo.legs.etf.pnlUsd, 76535 - 73600, "October ETF P&L = sum of daily contributions"); near(mo.pnlUsd, r.daily[4].nav - r.daily[1].nav, "October total P&L = NAV change"); }
    ok(ms && ms.legs.crypto.tradesClosed === 1 && ms.legs.crypto.losses === 1, "September: the BTC round trip is a closed loss"); if (ms) near(ms.startNav, 100000, "September starts at the anchor");
    for (const [name, txt] of [["trades", renderTrades(r)], ["daily", renderDaily(r)], ["month", renderMonth(r, "2026-10")]]) ok(typeof txt === "string" && txt.length > 200 && !/NaN|undefined/.test(txt), `${name} render has no NaN/undefined`);

    // ---------- 1b. independent known answers: the model days, the daily % columns, the trade % columns, the summary, the month $ table
    const navK = etfV.map((v, i) => v + crV[i] + cashV[i] + znV[i]), rfD = 0.04 / 252, rfC = 0.04 / 365;   // DTB3 4.0; crypto OUT earns the T-bill x 252/365 per UTC day
    const mK = [null,
      0.3 * (30.5 / 30 - 1) + 0.075 * (104 / 102 - 1) + 0.075 * (11.5 / 11 - 1) + 4.2 * 0.79 * (95.95 / 95 - 1 - rfD) - 0.0004 * 4.2 / 2 + (1 - 0.45) * rfD,   // 09-30 (a ZN window day: the proxy financed at the T-bill)
      0.4 * (111.1 / 110 - 1) + 0.3 * (30.2 / 30.5 - 1) + 0.075 * (99 / 104 - 1 - 0.0025) + 0.075 * (12 / 11.5 - 1) + (1 - 0.85) * rfD,                     // 10-01
      0.4 * (112 / 111.1 - 1) + 0.3 * (30.4 / 30.2 - 1) + 0.075 * rfC + 0.075 * (12.5 / 12 - 1) + (1 - 0.85) * rfD,                                       // 10-02: BTC OUT all of the 10-01 UTC day
      0.4 * (113 / 112 - 1) + 0.3 * (31 / 30.4 - 1) + 0.075 * ((1 + rfC - 0.0025) * (105 / 103) * (106 / 105) - 1) + 0.075 * (14 / 12.5 - 1) + (1 - 0.85) * rfD];   // 10-05: BTC re-entry on the 10-02 UTC close
    const mCum = 100 * (mK.slice(1).reduce((g, x) => g * (1 + x), 1) - 1), cumK = 100 * (navK[4] / 100000 - 1);
    near(r.daily[3].modelPct, 100 * mK[3], "model 10-02: BTC OUT the whole 10-01 UTC day earns W x T-bill/252 x 252/365 (not 0)");
    near(r.daily[4].modelPct, 100 * mK[4], "model 10-05: BTC re-entry (T-bill day less the 25 bps switch), then BTC and ETH closes");
    near(r.daily[4].modelCumPct, mCum, "model cumulative 10-05 = 100 x (prod(1 + model day) - 1) over 09-30..10-05 (compounded, not summed)");
    near(r.summary.modelCumPct, mCum, "summary model cumulative"); near(r.summary.vsModelPp, cumK - mCum, "summary vs model = paper cumulative - model cumulative");
    near(r.daily[2].dayPct, (100 * (navK[2] - navK[1])) / navK[1], "day % 10-01 = $ change / the PRIOR session's NAV");
    near(r.daily[2].trackingPp, (100 * (navK[2] - navK[1])) / navK[1] - 100 * mK[2], "tracking 10-01 = known paper day % - known model day %");
    near(r.daily[3].contribPct.etf, (100 * 1105) / navK[2], "ETF % contribution 10-02 = $1,105 / the 10-01 NAV");
    near(r.daily[1].contribPct.crypto, (100 * (crV[1] - crV[0])) / navK[0], "CRYPTO % contribution 09-30 = its $ / the 09-29 NAV");
    if (bc) near(bc.gainPct, (100 * (btcCash - 7500)) / (q1 * 102), "BTC round trip % P&L = $ P&L (net of both fees) / entry cost (fees not in the denominator)");
    if (o1) near(o1.navPct, (100 * 330) / navK[2], "open QQQ lot % NAV = $330 / Plan E NAV before its 10-02 entry (the 10-01 NAV)");
    near(r.summary.vsSpyPp, cumK - 2, "summary vs SPY = paper cumulative - SPY +2%");
    near(r.summary.realizedUsd, 2000 + 200 + (btcCash - 7500), "realized = the two closed QQQ lots + the BTC round trip (net of its fees)");
    near(r.summary.unrealizedUsd, 330 + 1000 + ((106 - 103) * q2 - 0.0025 * btcCash) + (3 * qe - 18.75) + (750 * qz - 2.5 * qz), "unrealized = open QQQ + DBMF + BTC + ETH + ZN, each net of its entry fee");
    ok(r.summary.wins === 2 && r.summary.losses === 1 && r.summary.closedTrades === 3, "summary: 3 closed (2 QQQ wins, the BTC loss)");
    { const ln = renderLine(r); ok(ln.includes(`vs model ${pp(cumK - mCum)}`) && ln.includes(`vs SPY ${pp(cumK - 2)}`) && ln.includes(`cum ${pct(cumK)}`), `--line carries the known cumulative, vs-model and vs-SPY figures: ${ln}`); }
    if (mo) {
      ok(mo.legs.total.worstDrawdownUsd === 0, "October total: three up days -> no drawdown");
      near(mo.legs.etf.deployedAvgUsd, (40600 + 47200 + 34630) / 3, "October ETF deployed avg = mean of the held positions' value (10-01 $40,600, 10-02 $47,200, 10-05 $34,630)");
      near(mo.legs.etf.deployedPeakUsd, 47200, "October ETF deployed peak");
      near(mo.modelPct, 100 * ((1 + mK[2]) * (1 + mK[3]) * (1 + mK[4]) - 1), "October model % compounds 10-01..10-05");
      near(mo.spyPct, 100 * (510 / 501 - 1), "October SPY % from the September close (501 -> 510)");
      near(mo.retPct, 100 * (navK[4] / navK[1] - 1), "October return % = NAV 10-05 / NAV 09-30 - 1 (the month's start NAV, not the anchor)");
      near(mo.startNav, navK[1], "October starts at the 09-30 NAV");
    }
    if (ms) near(ms.legs.crypto.avgLossUsd, btcCash - 7500, "September crypto average loss = the BTC round trip");
    // crypto sizing: the slot rule is a stated deviation; the planE-tasty-sized variant (W x NAV, the BOOK band) is reported beside it
    { const cz = r.cryptoSizing, rb = cz && cz.reentries.find((x) => x.coin === "BTC"), hb = cz && cz.held.find((x) => x.coin === "BTC"), he = cz && cz.held.find((x) => x.coin === "ETH"), tgt = 0.075 * navK[4];
      ok(cz && cz.reentries.length === 1 && rb && rb.date === "2026-10-02" && rb.navDate === "2026-10-02" && rb.inRecord === true, "one crypto re-entry in the record: BTC at the 10-02 UTC close, sized against the 10-02 session NAV (that close precedes the UTC close)");
      if (rb) { near(rb.slotUsd, btcCash, "BTC re-entry spent the slot's cash (its own round trip's proceeds)"); near(rb.nav, navK[3], "planE-tasty basis = Plan E NAV 10-02"); near(rb.targetUsd, 0.075 * navK[3], "planE-tasty would buy W 7.5% x NAV(10-02)"); near(rb.diffPct, 100 * (btcCash / (0.075 * navK[3]) - 1), "slot vs W x NAV % (about -7.4%)"); }
      ok(hb && hb.held && hb.asOf === "2026-10-04" && he && he.held, "both coins held at the record's last crypto mark (10-04 UTC close)");
      if (hb) { near(hb.heldUsd, q2 * 106, "BTC held $ at 106"); near(hb.targetUsd, tgt, "BTC target = W x NAV(10-05)"); near(hb.driftUsd, q2 * 106 - tgt, "BTC drift = held - target"); near(hb.bandUsd, 0.1 * tgt, "BTC band = 10% of the larger (the target)"); ok(hb.wouldTrade === null, "BTC drift -$689 inside its $812 band -> planE-tasty would not trade"); }
      if (he) { near(he.heldUsd, qe * 14, "ETH held $ at 14"); near(he.driftUsd, qe * 14 - tgt, "ETH drift = held - target"); near(he.bandUsd, 0.1 * qe * 14, "ETH band = 10% of the larger (the held $)"); ok(he.wouldTrade === "SELL", "ETH drift +$1,397 outside its $952 band -> planE-tasty would SELL"); }
      ok(r.notes.some((n) => /^CRYPTO sizing — a stated DEVIATION \(part of the tracking difference\)/.test(n) && n.includes(`BTC re-entry 2026-10-02 UTC close bought ${usd(btcCash)} (slot) vs 7.50% x NAV ${usd(navK[3])} (2026-10-02 close) = ${usd(0.075 * navK[3])} (${pct(100 * (btcCash / (0.075 * navK[3]) - 1))})`) && /BTC \$[\d,.]+ vs \$[\d,.]+ \(drift -\$689\.40, band \$812\.48\) — inside the band/.test(n) && /ETH \$[\d,.]+ vs \$[\d,.]+ \(drift \+\$1,396\.80, band \$952\.16\) — planE-tasty would SELL ~\$1,396\.80/.test(n)), "the deviation and the planE-tasty-sized variant are stated in the notes"); }

    // ---------- 1c. October down day: the month's WORST DD $ is peak-to-trough, not the cumulative trough (DBMF marked at 25 on 10-05)
    inp = base(); inp.raw.DBMF = inp.raw.DBMF.map((x) => (x.d === "2026-10-05" ? { d: x.d, c: 25 } : x)); r = compute(clone(inp));
    { const nav5 = navK[4] - 6000, path = [navK[2] - navK[1], navK[3] - navK[2], nav5 - navK[3]]; let cum = 0, pk = 0, dd = 0; for (const x of path) { cum += x; pk = Math.max(pk, cum); dd = Math.min(dd, cum - pk); }
      ok(r.status === "OK" && dd < -1, `down-day scenario OK with a real drawdown (${dd})`);
      near(r.months["2026-10"].legs.total.worstDrawdownUsd, dd, "October total worst DD $ = peak-to-trough of the day $ path (up, up, down)");
      near(r.months["2026-10"].legs.etf.worstDrawdownUsd, -4170, "October ETF 0, +1,105, -4,170 -> worst DD -$4,170 (the cumulative trough would be -$3,065)"); }

    // ---------- 1d. the 10-month signal: the window is the 10 month-ends ENDING AT the signal month (risk-manager.js ms[i-9..i], i >= 10)
    inp = base(); inp.adj.QQQ = inp.adj.QQQ.map((x) => (x.d === "2025-11-28" ? { d: x.d, c: 300 } : x)); r = compute(clone(inp));
    near(r.daily[2].modelPct, 100 * mK[2], "Sep signal: 110 vs avg(Dec-25..Sep-26) 101 -> IN (the 10 month-ends before it, with Nov-25 at 300, average 120 -> would be OUT)");
    near(r.daily[1].modelPct, 100 * mK[1], "Aug signal: 100 vs avg(Nov-25..Aug-26) 120 -> OUT");
    inp = base(); inp.adj.QQQ = inp.adj.QQQ.filter((x) => x.d >= "2025-12-01"); r = compute(clone(inp));
    ok(r.status === "UNKNOWN" && r.daily[2].modelPct == null && r.daily[2].unknown.some((u) => /MODEL: missing QQQ 10-month signal \(2026-09\)/.test(u)) && r.daily[4].modelCumPct == null, "QQQ with exactly 10 month-ends through the signal month -> the model is UNKNOWN (risk-manager.js needs 11)");
    inp = base(); inp.adj.QQQ = inp.adj.QQQ.filter((x) => x.d >= "2025-11-01"); r = compute(clone(inp));
    ok(r.daily[1].modelPct == null && r.daily[1].unknown.some((u) => /QQQ 10-month signal \(2026-08\)/.test(u)), "11 month-ends from Nov-25: the Aug signal (10 month-ends) is UNKNOWN");
    near(r.daily[2].modelPct, 100 * mK[2], "11 month-ends through Sep: the Sep signal is measured (IN)");

    // ---------- 1e. the model's ZN window = the month's last 5 sessions; edge cost on the first and last of them (October cut to 6 sessions)
    inp = base(); inp.sessions = inp.sessions.filter((s) => !(s.date >= "2026-10-09" && s.date <= "2026-10-31")); r = compute(clone(inp));
    near(r.daily[2].modelPct, 100 * mK[2], "10-01 = 6th-to-last session of the cut October: no IEF x ZN_LEV x ZN_BETA term, no edge cost");
    near(r.daily[3].modelPct, 100 * (mK[3] + 4.2 * 0.79 * (96 / 96 - 1 - rfD) - (0.0004 * 4.2) / 2), "10-02 = first of the last 5: ZN term (IEF flat, less the T-bill financing) and the 2 bps x ZN_LEV edge cost");
    near(r.daily[4].modelPct, 100 * (mK[4] + 4.2 * 0.79 * (96.5 / 96 - 1 - rfD)), "10-05 = inside the last 5: ZN term less the T-bill financing, no edge cost");

    // ---------- 1f. no DTB3 -> risk-manager.js's 4% fallback on the uninvested weight and on a coin that is OUT
    inp = base(); inp.dtb3 = null; r = compute(clone(inp));
    near(r.daily[2].modelPct, 100 * mK[2], "no DTB3: the uninvested 15% earns 0.04/252"); near(r.daily[3].modelPct, 100 * mK[3], "no DTB3: BTC OUT earns 0.04/365 per UTC day");

    // ---------- 1g. a model gap latches the model cumulative UNKNOWN from the gap on (DBMF adjusted close missing 10-01)
    inp = base(); inp.adj.DBMF = inp.adj.DBMF.filter((x) => x.d !== "2026-10-01"); r = compute(clone(inp));
    ok(r.status === "UNKNOWN" && r.daily[2].modelPct == null && r.daily[3].modelPct == null && fin(r.daily[1].modelCumPct) && [2, 3, 4].every((i) => r.daily[i].modelCumPct == null) && r.summary.vsModelPp == null, "a missing model day -> model cumulative UNKNOWN from it on (never compounded over)");
    near(r.daily[4].modelPct, 100 * mK[4], "the 10-05 model day itself is measurable again");

    // ---------- 1h. a flat $0 closed trade counts as a LOSS (not a win, not neither): wins + losses = closed trades
    inp = base(); inp.broker.orders.find((o) => o.id === "4").filled_avg_price = "110"; r = compute(clone(inp));
    { const z0 = r.trades.find((t) => t.sym === "QQQ" && t.status === "CLOSED" && t.entry.px === 110);
      ok(r.status === "OK" && z0 && z0.gainUsd === 0 && r.summary.closedTrades === 3 && r.summary.wins === 1 && r.summary.losses === 2, "20 QQQ bought and sold at 110 (no fees) = $0 -> a loss in the summary (1 win / 2 losses of 3)");
      ok(r.months["2026-10"].legs.etf.wins === 1 && r.months["2026-10"].legs.etf.losses === 1 && r.months["2026-10"].legs.etf.avgLossUsd === 0, "October ETF: the $0 trade is the loss (avg loss $0)");
      near(r.summary.realizedUsd, 1000 + 0 + (btcCash - 7500), "realized with the flat trade"); }

    // ---------- 1i. ETF reasons from a month-end run: QQQ flips IN -> OUT at the 09-30 close, SGOV parks it, DBMF trims to target
    inp = base(); inp.book.ledger[1].lines = [{ sym: "QQQ", signal: "OUT" }];
    inp.broker.orders.push({ id: "m1", client_order_id: "book-20260930-QQQ-sell", symbol: "QQQ", side: "sell", qty: "20", filled_qty: "20", filled_avg_price: "102", filled_at: "2026-10-01T13:30:05Z", status: "filled" },
      { id: "m2", client_order_id: "book-20260930-DBMF-sell", symbol: "DBMF", side: "sell", qty: "100", filled_qty: "100", filled_avg_price: "30.3", filled_at: "2026-10-01T13:30:06Z", status: "filled" },
      { id: "m3", client_order_id: "book-20260930-SGOV-buy", symbol: "SGOV", side: "buy", qty: "10", filled_qty: "10", filled_avg_price: "100", filled_at: "2026-10-01T13:30:07Z", status: "filled" });
    inp.broker.positions = [{ symbol: "QQQ", qty: "10" }, { symbol: "DBMF", qty: "900" }, { symbol: "SGOV", qty: "10" }, { symbol: "AAPL", qty: "1" }]; r = compute(clone(inp));
    { const qf = r.trades.find((t) => t.sym === "QQQ" && t.exit && t.exit.cid === "book-20260930-QQQ-sell"), sg = r.trades.find((t) => t.sym === "SGOV"), dt = r.trades.find((t) => t.sym === "DBMF" && t.exit && t.exit.cid === "book-20260930-DBMF-sell");
      ok(r.status === "OK" && qf && qf.qty === 20 && qf.exit.reason === "signal flip IN -> OUT (10-month rule at the month-end close)", `month-end QQQ sell: reason 'signal flip IN -> OUT' (got ${qf && qf.exit.reason})`);
      ok(sg && sg.status === "OPEN" && sg.entry.reason === "SGOV park/unpark after QQQ flipped (10-month rule)", `month-end SGOV buy: reason 'SGOV park/unpark after QQQ flipped' (got ${sg && sg.entry.reason})`);
      ok(dt && dt.qty === 100 && dt.exit.reason === "monthly rebalance (month-end: every sleeve to target)", `month-end DBMF trim: reason 'monthly rebalance' (got ${dt && dt.exit.reason})`); }

    // ---------- 1j. the ETF leg needs a BOOK run after every record session's close
    inp = base(); delete inp.book.state.runs["2026-10-02"]; inp.book.ledger = inp.book.ledger.filter((x) => !(x.kind === "daily" && x.date === "2026-10-02")); r = compute(clone(inp));
    ok(r.status === "UNKNOWN" && r.unknown.length === 1 && /^ETF: the BOOK did not run on 2026-10-02 — Plan E's band\/rebalance check was not made/.test(r.unknown[0]), `BOOK run missing for 10-02 -> UNKNOWN naming 10-02 (got ${r.unknown.join(" | ")})`);
    near(r.daily[4].value.etf, 76535, "broker mode: the broker's fills still value the ETF leg");
    inp = base(); delete inp.book.state.runs["2026-10-02"]; r = compute(clone(inp)); ok(r.status === "OK", "a ledger daily row alone counts as the BOOK's run");
    inp = base(); inp.book.ledger = inp.book.ledger.filter((x) => !(x.kind === "daily" && x.date === "2026-10-02")); r = compute(clone(inp)); ok(r.status === "OK", "a runs[] entry alone counts as the BOOK's run");
    inp = base(); delete inp.book.state.runs["2026-10-05"]; inp.book.ledger = inp.book.ledger.filter((x) => !(x.kind === "daily" && x.date === "2026-10-05")); inp.et = { date: "2026-10-05", mins: 16 * 60 + 10 }; r = compute(clone(inp));
    ok(r.status === "OK" && r.asOf === "2026-10-05" && r.notes.some((n) => /BOOK run for today \(2026-10-05\) is not due yet \(~16:15 ET\)/.test(n)), "today's BOOK run is not due before close + 15 min (noted, not UNKNOWN)");
    inp.et = { date: "2026-10-05", mins: 16 * 60 + 15 }; r = compute(clone(inp)); ok(r.status === "UNKNOWN" && r.unknown.some((u) => /^ETF: the BOOK did not run on 2026-10-05/.test(u)), "today's BOOK run missing at 16:15 ET -> UNKNOWN");
    inp = base(); inp.broker = { ok: false, error: "HTTP 401" }; inp.book.ledger.push({ kind: "fill-filled", cid: "book-20261002-QQQ-sell", sym: "QQQ", side: "sell", filledQty: 120, px: 120 }); delete inp.book.state.runs["2026-10-02"]; inp.book.ledger = inp.book.ledger.filter((x) => !(x.kind === "daily" && x.date === "2026-10-02")); r = compute(clone(inp));
    ok(r.status === "UNKNOWN" && fin(r.daily[2].value.etf) && r.daily[3].value.etf == null && r.daily[4].value.etf == null && r.daily[3].unknown.some((u) => /BOOK did not run on 2026-10-02/.test(u)), "ledger mode: a missed BOOK run makes the ETF leg UNKNOWN from that session");

    // ---------- 1k. R191's rule at a tie: a close EQUAL to its N-day mean is OUT (BTC 10-04 close 104 = mean(103, 105, 104))
    inp = base(); inp.crypto.BTC = inp.crypto.BTC.map((x) => (x.d === "2026-10-04" ? { d: x.d, c: 104 } : x)); r = compute(clone(inp));
    { const tb = r.trades.find((t) => t.sym === "BTC" && t.entry.date === "2026-10-02");
      ok(r.status === "OK" && tb && tb.status === "CLOSED" && tb.exit.date === "2026-10-04" && tb.exit.px === 104 && /^signal flip OUT — close 104\.00 <= 3-day mean 104\.00/.test(tb.exit.reason) && !r.trades.some((t) => t.sym === "BTC" && t.status !== "CLOSED"), `a close equal to the mean -> SELL (got ${tb && tb.status} ${tb && tb.exit && tb.exit.reason})`);
      near(r.daily[4].value.crypto, q2 * 104 * (1 - 0.0025) + qe * 14, "the BTC slot is cash after the tie sale at 104 (25 bps)"); }

    // ---------- 1l. ZN coverage at the boundary: a window whose entry session IS the last record session must be in R219's record
    inp = base(); inp.r219.state.windows["2026-10"].entryDay = "2026-10-05"; delete inp.r219.state.windows["2026-10"].entry; r = compute(clone(inp));
    ok(r.status === "UNKNOWN" && r.unknown.some((u) => /R219 has no record of the 2026-10 window \(entry session 2026-10-05 is inside the record\)/.test(u)), "entry session = the last record session (close-arm 15:35-15:48, record after 16:05) with no R219 entry -> UNKNOWN");

    // ---------- 2. UNKNOWN on a missing leg (crypto close absent)
    inp = base(); inp.crypto.BTC = inp.crypto.BTC.filter((x) => x.d !== "2026-10-04"); r = compute(clone(inp));
    ok(r.status === "UNKNOWN" && r.daily[4].nav == null && r.daily[4].value.crypto == null && fin(r.daily[3].nav), "missing BTC close -> that session's crypto leg and NAV are UNKNOWN, earlier sessions stand");
    ok(r.trades.some((t) => t.sym === "BTC" && t.status === "OPEN-UNKNOWN" && t.gainUsd == null), "the open BTC trade cannot be marked -> OPEN-UNKNOWN");
    ok(r.daily[4].modelPct == null && r.daily[4].modelCumPct == null && fin(r.daily[3].modelCumPct) && r.summary.vsModelPp == null, "missing BTC close -> the model day and the model cumulative are UNKNOWN from the gap on");
    ok(/UNKNOWN/.test(renderLine(r)), "--line says UNKNOWN");
    inp = base(); inp.crypto.ETH = null; inp.unknown.push("ETH daily closes (Coinbase): HTTP 503"); r = compute(clone(inp)); ok(r.status === "UNKNOWN" && r.daily.every((d) => d.nav == null), "a crypto series that could not be read -> every NAV UNKNOWN (never an empty sleeve)");
    // a held ETF with no close that session -> the ETF leg (and NAV) UNKNOWN that session only, never valued at 0
    inp = base(); inp.raw.DBMF = inp.raw.DBMF.filter((x) => x.d !== "2026-10-02"); r = compute(clone(inp));
    ok(r.status === "UNKNOWN" && r.daily[3].value.etf == null && r.daily[3].nav == null && r.daily[3].unknown.some((u) => /ETF: no DBMF close for 2026-10-02/.test(u)) && fin(r.daily[2].value.etf) && fin(r.daily[4].value.etf), "a held ETF missing its 10-02 close -> 10-02 ETF leg UNKNOWN; 10-01 and 10-05 stand");
    near(r.daily[4].value.etf, 76535, "ETF 10-05 is unaffected by the 10-02 gap");
    // ZN open window with no mark
    inp = base(); inp.znDaily.bars = inp.znDaily.bars.filter((b) => b.d !== "2026-10-05"); r = compute(clone(inp)); ok(r.status === "UNKNOWN" && r.daily[4].value.zn == null && fin(r.daily[3].value.zn), "open ZN window without a 10-05 close -> ZN UNKNOWN that day");
    inp = base(); inp.znDaily.symbol = "/ZNH27"; r = compute(clone(inp)); ok(r.status === "UNKNOWN" && r.daily[2].value.zn == null, "ZN store on another contract -> UNKNOWN (no cross-contract mark)");
    // reserve and SPY must be measurable
    inp = base(); delete inp.adj.SGOV; r = compute(clone(inp)); ok(r.status === "UNKNOWN" && r.daily.every((d) => d.value.cash == null), "no SGOV -> CASH leg UNKNOWN");
    inp = base(); inp.sessions = null; r = compute(clone(inp)); ok(r.status === "UNKNOWN" && !r.daily.length, "no calendar -> UNKNOWN");

    // ---------- 3. ZN closed window
    inp = base(); inp.r219.state.windows["2026-10"].exit = { px: 112.5, at: "2026-10-05T19:40:00Z" }; r = compute(clone(inp));
    const zc = r.trades.find((t) => t.leg === "zn"); ok(r.status === "OK" && zc && zc.status === "CLOSED", "ZN window closed");
    if (zc) { near(zc.gainUsd, 500 * qz - 5 * qz, "ZN closed $ = (112.5 - 112) x 1000 x q - $2.50 x 2 x q"); near(r.daily[4].value.zn, 495 * qz, "ZN realized lands in the 10-05 NAV"); ok(zc.holdDays === 4, "ZN holding days 10-01 -> 10-05"); }

    // ---------- 4. broker unreadable: ledger fallback, a pending order makes the ETF leg UNKNOWN from its due session
    inp = base(); inp.broker = { ok: false, error: "HTTP 401" }; inp.book.state.pending = [{ cid: "book-20261002-QQQ-sell", sym: "QQQ", side: "sell", qty: 120 }]; r = compute(clone(inp));
    ok(r.status === "UNKNOWN" && fin(r.daily[3].value.etf) && r.daily[4].value.etf == null, "ledger mode: the unreconciled 10-02 order makes 10-05 ETF UNKNOWN; 10-02 stands");
    near(r.daily[3].value.etf, 74700, "ledger mode 10-02 ETF (no broker dividends)");
    ok(r.trades.filter((t) => t.sym === "QQQ").every((t) => t.entry.tag === SRC.ledger && t.entry.time == null && t.status !== "CLOSED"), "ledger fills: tagged [L], no fill time, nothing closed");
    inp = base(); inp.broker = { ok: false, error: "HTTP 401" }; inp.book.state.pending = []; inp.book.ledger.push({ kind: "fill-filled", cid: "book-20261002-QQQ-sell", sym: "QQQ", side: "sell", filledQty: 120, px: 120 }); r = compute(clone(inp));
    ok(r.status === "OK" && Math.abs(r.daily[4].value.etf - 76530) < 1e-6 && r.trades.find((t) => t.sym === "QQQ" && t.entry.px === 100).exit.date === "2026-10-05", "ledger mode, all reconciled: fill date = next session after the order date, values match");
    // anomalies
    inp = base(); inp.broker.orders = inp.broker.orders.filter((o) => o.id !== "3"); inp.broker.positions[0].qty = "-20"; r = compute(clone(inp));
    ok(r.status === "UNKNOWN" && r.unknown.some((u) => /book-20261001-QQQ-buy.*not among the broker's orders/.test(u)), "a BOOK ledger fill the broker does not have -> UNKNOWN");
    ok(r.unknown.some((u) => /short/.test(u)), "a sell larger than the open lots (short) -> UNKNOWN");
    inp = base(); inp.broker.positions[0].qty = "31"; r = compute(clone(inp)); ok(r.status === "UNKNOWN" && r.unknown.some((u) => /broker holds 31 QQQ/.test(u)), "broker position differs from Plan E's fills -> UNKNOWN");

    // ---------- 5. before today's close: the record ends at the prior session; today's fill is upcoming, not in the record
    inp = base(); inp.et = { date: "2026-10-05", mins: 12 * 60 }; r = compute(clone(inp));
    ok(r.asOf === "2026-10-02" && r.daily.length === 4, "midday: record through the 10-02 close");
    ok(r.trades.filter((t) => t.sym === "QQQ").every((t) => t.status === "OPEN") && r.upcoming.some((u) => u.done && /SELL 120 QQQ FILLED/.test(u.what)), "a fill after the last close is upcoming/done, not in FIFO yet");
    inp = base(); inp.raw.QQQ = inp.raw.QQQ.filter((x) => x.d !== "2026-10-05"); inp.raw.DBMF = inp.raw.DBMF.filter((x) => x.d !== "2026-10-05"); inp.raw.SGOV = inp.raw.SGOV.filter((x) => x.d !== "2026-10-05"); r = compute(clone(inp));
    ok(r.asOf === "2026-10-02" && r.notes.some((n) => /not in the SIP data yet/.test(n)), "today's closes not in the data yet -> record ends the session before (noted, not guessed)");
    // the record waits 5 minutes after the close for final closes (the BOOK's rule): 16:03 ET ends at the prior session, 16:05 ET includes today
    inp = base(); inp.et = { date: "2026-10-05", mins: 16 * 60 + 3 }; r = compute(clone(inp));
    ok(r.asOf === "2026-10-02" && r.daily.length === 4, `16:03 ET (3 min after the close): record through the 10-02 close (got ${r.asOf})`);
    inp.et = { date: "2026-10-05", mins: 16 * 60 + 5 }; r = compute(clone(inp));
    ok(r.asOf === "2026-10-05" && r.daily.length === 5 && r.status === "OK", `16:05 ET (close + 5 min): today's session is on record (got ${r.asOf} ${r.status})`);
    // ZN next window when none is open
    inp = base(); inp.r219.state.windows = {}; inp.znDaily.bars = [{ d: "2026-10-05", c: 112.75 }]; r = compute(clone(inp));
    const zu = r.upcoming.find((u) => u.leg === "ZN" && /^BUY/.test(u.what)); ok(zu && zu.when === "2026-10-23" && r.upcoming.some((u) => u.leg === "ZN" && u.when === "2026-10-30"), "no ZN window yet -> next entry 10-23 (6th-to-last session) and exit 10-30");
    if (zu) ok(/15:35-15:48 ET/.test(zu.detail) && /tastytrade would trade 4 whole contract/.test(zu.detail), `ZN upcoming detail has the close-arm minutes and the tastytrade count: ${zu.detail}`);
    ok(r.summary.nextScheduled[0].when === "2026-10-23", "next scheduled = the ZN entry 10-23");

    // ---------- 5b. shared account: only Plan E's part of a broker FEE / DIV counts, and each fee lands on the Plan E fills that caused it
    inp = base();
    inp.broker.orders.push({ id: "6", client_order_id: "r24-MSFT-2026-10-02-B", symbol: "MSFT", side: "buy", qty: "2", filled_qty: "2", filled_avg_price: "2750", filled_at: "2026-10-02T14:00:00Z", status: "filled" },
      { id: "7", client_order_id: "r24-MSFT-2026-10-05-S", symbol: "MSFT", side: "sell", qty: "1", filled_qty: "1", filled_avg_price: "3600", filled_at: "2026-10-05T14:00:00Z", status: "filled" },
      { id: "9", client_order_id: "r24-KO-2026-10-05-B", symbol: "KO", side: "buy", qty: "10", filled_qty: "10", filled_avg_price: "60", filled_at: "2026-10-05T15:00:00Z", status: "filled" });
    inp.broker.positions.push({ symbol: "MSFT", qty: "1" }, { symbol: "KO", qty: "10" });
    inp.broker.activities.push(
      { activity_type: "FEE", date: "2026-09-29", net_amount: "-0.03", description: "CAT fee for proceed of 0 trades on 2026-09-29" },   // no fill that day -> excluded, listed
      { activity_type: "FEE", date: "2026-09-30", net_amount: "-0.06", description: "CAT fee for proceed of 2 trades on 2026-09-30" },   // Plan E only -> all Plan E (QQQ 1/4, DBMF 3/4)
      { activity_type: "FEE", date: "2026-10-01", net_amount: "-0.04", description: "CAT fee for proceed of 1 trades on 2026-10-01" },   // only the AAPL order filled -> none
      { activity_type: "FEE", date: "2026-10-02", net_amount: "-0.02", description: "CAT fee for proceed of 2 trades on 2026-10-02" },   // QQQ $5,500 vs MSFT $5,500 -> half
      { activity_type: "FEE", date: "2026-10-02", net_amount: "-0.01", symbol: "ADRX", description: "ADR fee ADRX" },                   // a symbol nobody filled, not Plan E's -> other
      { activity_type: "FEE", date: "2026-10-05", net_amount: "-0.10", description: "REG fee for proceed of $18,000 on 2026-10-05" },    // SELLS only: QQQ $14,400 vs MSFT $3,600 -> 80% (the KO buy does not count)
      { activity_type: "FEE", date: "2026-10-05", net_amount: "-0.02", symbol: "QQQ", description: "TAF fee QQQ" },                    // names QQQ: Plan E's QQQ sell only -> 100%
      { activity_type: "FEE", date: "2026-10-05", net_amount: "-0.05", symbol: "MSFT", description: "TAF fee MSFT" });                  // another symbol -> none
    r = compute(clone(inp));
    ok(r.status === "OK", `fee scenario status OK (unknown: ${r.unknown.join(" | ")})`);
    [73000, 73599.94, 73599.94, 74704.93, 76534.83].forEach((v, i) => near(r.daily[i].value.etf, v, `ETF leg with Plan E's fees only ${r.daily[i].date}`));
    ok(r.notes.some((n) => /Plan E fees -\$0\.17 \(4 fee\(s\)/.test(n) && /other orders' fees -\$0\.13 excluded/.test(n) && /1 fee\(s\) with no fill that day excluded: -\$0\.03 on 2026-09-29/.test(n)), "fee note: Plan E -$0.17, other orders -$0.13, one unattributable -$0.03");
    {
      const q = r.trades.filter((t) => t.sym === "QQQ"), f1 = q.find((t) => t.status === "CLOSED" && t.entry.px === 100), f2 = q.find((t) => t.status === "CLOSED" && t.entry.px === 110), fo = q.find((t) => t.status === "OPEN"), fd = r.trades.find((t) => t.sym === "DBMF");
      ok(f1 && f2 && fo && fd, "fee scenario: the same FIFO lots");
      if (f1) { near(f1.feesUsd, 0.015 + (0.1 * 100) / 120, "lot 1 fees = its share of the 09-30 fee + 100/120 of the 10-05 REG + TAF fees ($0.10 on the QQQ sell)"); near(f1.gainUsd, 2000 - 0.015 - (0.1 * 100) / 120, "lot 1 $ gain net of fees"); }
      if (f2) near(f2.gainUsd, 200 - (0.01 * 20) / 50 - (0.1 * 20) / 120, "lot 2 $ gain net of fees");
      if (fo) near(fo.gainUsd, 330 - (0.01 * 30) / 50, "open lot net of its entry fee");
      if (fd) near(fd.gainUsd, 1000 - 0.045, "DBMF open net of 3/4 of the 09-30 fee");
      ok(f1 && /^broker FEE activities, allocated by notional/.test(f1.feeNote), "ETF fee note says allocated by notional");
    }
    { // a TAF fee naming NO symbol is charged on SELLS only: 10-05 Plan E's QQQ sell $14,400 vs the MSFT sell $3,600 -> 80%; the $600 KO buy does not count
      const it = clone(inp); it.broker.activities.push({ activity_type: "FEE", date: "2026-10-05", net_amount: "-1.00", description: "TAF fee for proceed of 2 trades on 2026-10-05" }); const rt = compute(clone(it));
      const share = 14400 / (14400 + 3600);
      ok(rt.status === "OK" && rt.notes.some((n) => /Plan E fees -\$0\.97 \(5 fee\(s\)/.test(n) && /other orders' fees -\$0\.33 excluded/.test(n)), "symbol-less TAF: Plan E's $0.80 (80%) joins its fees, the other $0.20 is excluded");
      near(rt.daily[4].value.etf, 76534.83 - 1.0 * share, "ETF 10-05 carries 14,400/(14,400+3,600) of the symbol-less TAF fee (sells only; the KO buy excluded)");
      near(rt.daily[3].value.etf, 74704.93, "the 10-05 TAF fee does not touch 10-02");
      const t1 = rt.trades.find((t) => t.sym === "QQQ" && t.status === "CLOSED" && t.entry.px === 100);
      ok(!!t1, "TAF scenario: QQQ lot 1 closed"); if (t1) near(t1.feesUsd, 0.015 + ((0.1 + 1.0 * share) * 100) / 120, "lot 1 carries 100/120 of Plan E's TAF share (the QQQ sell is the only Plan E sell that day)");
    }
    inp = base(); inp.broker.orders.push({ id: "8", client_order_id: "manual-qqq", symbol: "QQQ", side: "buy", qty: "10", filled_qty: "10", filled_avg_price: "100", filled_at: "2026-09-30T15:00:00Z", status: "filled" });
    inp.broker.positions[0].qty = "40"; inp.broker.activities.push({ activity_type: "DIV", symbol: "QQQ", net_amount: "11", qty: "110", date: "2026-10-01" }); r = compute(clone(inp));
    ok(r.status === "OK" && r.notes.some((n) => /QQQ dividend 2026-10-01: \$11\.00 on 110 sh.*Plan E's 100 sh = \$10\.00/.test(n)) && r.notes.some((n) => /10 QQQ from excluded orders sits beside Plan E's 30/.test(n)), "a dividend on a symbol another order also holds is split by shares (noted)");
    near(r.daily[2].value.etf, 73610, "ETF 10-01 = 73,600 + Plan E's $10 of the $11 QQQ dividend"); near(r.daily[4].value.etf, 76545, "ETF 10-05 keeps it");
    delete inp.broker.activities[inp.broker.activities.length - 1].qty; r = compute(clone(inp));
    ok(r.status === "UNKNOWN" && r.unknown.some((u) => /QQQ dividend \$11\.00 on 2026-10-01 cannot be split/.test(u)), "a shared-symbol dividend with no share count -> UNKNOWN");
    // entitlement is set at the ex/record date, not the pay date: Plan E's 50 QQQ bought ON the 10-02 ex-date earn nothing (paid 10-05, when Plan E holds 30)
    const divInp = (div) => { const x = base(); x.broker.orders.push({ id: "8", client_order_id: "manual-qqq", symbol: "QQQ", side: "buy", qty: "10", filled_qty: "10", filled_avg_price: "100", filled_at: "2026-09-30T15:00:00Z", status: "filled" });
      x.broker.positions[0].qty = "40"; x.broker.activities.push({ activity_type: "DIV", symbol: "QQQ", net_amount: "11", qty: "110", ...div }); return x; };
    r = compute(clone(divInp({ date: "2026-10-05", ex_date: "2026-10-02" })));
    ok(r.status === "OK" && r.notes.some((n) => /QQQ dividend 2026-10-05: \$11\.00 on 110 sh.*Plan E's 100 sh = \$10\.00 \(held before the ex date 2026-10-02\)/.test(n)), `ex-date 10-02: Plan E is entitled on its 100 sh held before it, not the 150 held on it nor the 30 held at payment (got ${r.unknown.join(" | ")})`);
    near(r.daily[4].value.etf, 76545, "ETF 10-05 = 76,535 + Plan E's $10 on the pay date"); near(r.daily[3].value.etf, 74705, "nothing before the pay date");
    r = compute(clone(divInp({ date: "2026-10-05", record_date: "2026-10-02" })));
    ok(r.status === "OK" && r.notes.some((n) => /Plan E's 100 sh = \$10\.00 \(held before the record date 2026-10-02\)/.test(n)), "a record date (T+1: the ex-date) is used the same way");
    r = compute(clone(divInp({ date: "2026-10-05" })));
    ok(r.status === "UNKNOWN" && r.unknown.some((u) => /^QQQ dividend \$11\.00 on 2026-10-05 cannot be split .*no ex\/record date and Plan E's QQQ holding changed between the 2026-09-30 month-end and 2026-10-05 \(100 -> 30 sh\)$/.test(u)) && !r.notes.some((n) => /QQQ dividend 2026-10-05/.test(n)), "no ex/record date and Plan E's holding changed since the prior month-end -> UNKNOWN (never split on the pay-date holding)");
    near(r.daily[4].value.etf, 76535, "an unsplittable dividend is not credited");

    // ---------- 5c. trade log shows the side; crypto switches after the record are listed as done (a weekend flip-and-back is not missed)
    r = compute(clone(base()));
    { const tl = renderTrades(r).split("\n"), hdr = tl.find((l) => /^#\s+STATUS/.test(l)), rows = tl.filter((l) => /^\d+\s+(CLOSED|OPEN)/.test(l)); ok(hdr && /\bSIDE\b/.test(hdr) && rows.length === r.trades.length && rows.every((l) => /^\d+\s+\S+\s+\S+\s+\S+\s+LONG\s/.test(l)), "trade log has a SIDE column (LONG) on every trade row"); }
    { const bl = r.cryptoLine.find((x) => x.coin === "BTC"), el = r.cryptoLine.find((x) => x.coin === "ETH");
      near(bl && bl.flipLevel, 105.5, "BTC flip level = mean of the last N-1 closes (105, 106)"); near(el && el.flipLevel, 13.75, "ETH flip level = mean(13.5, 14)");
      ok([105.51, 105.5, 105.49].map((x) => x > mean([105, 106, x])).join() === "true,false,false", "flip level: the next close flips IN iff it is above the level (R191's rule recomputed)");
      ok(r.upcoming.some((u) => u.leg === "CRYPTO" && u.conditional && u.when === "2026-10-05 UTC close" && /^SELL BTC if it closes at or below 105\.50$/.test(u.what)), "upcoming: BTC next decision with its flip level");
      ok(bl && bl.sleeveHeld === true && bl.nextDecision === "2026-10-05", "crypto line: sleeve IN, next decision 10-05"); }
    inp = base(); inp.et = { date: "2026-10-05", mins: 12 * 60 };
    inp.crypto.ETH = ser({ "2026-09-26": 10, "2026-09-27": 10.5, "2026-09-28": 11, "2026-09-29": 11.5, "2026-09-30": 12, "2026-10-01": 12.5, "2026-10-02": 13, "2026-10-03": 11, "2026-10-04": 14 }); r = compute(clone(inp));
    ok(r.asOf === "2026-10-02" && r.trades.filter((t) => t.sym === "BTC").length === 1 && r.trades.find((t) => t.sym === "BTC").status === "CLOSED", "midday: the 10-02 BTC re-entry is after the record's last crypto mark (10-01) — not in the trade log");
    ok(r.upcoming.some((u) => u.done && u.leg === "CRYPTO" && u.when === "2026-10-02 UTC close" && /^BUY .* BTC @ 103\.00/.test(u.what)), "the BTC re-entry is listed as done after the record");
    ok(r.upcoming.some((u) => u.done && u.when === "2026-10-03 UTC close" && /^SELL .* ETH @ 11\.00/.test(u.what)) && r.upcoming.some((u) => u.done && u.when === "2026-10-04 UTC close" && /^BUY .* ETH @ 14\.00/.test(u.what)), "a flip OUT and back IN after the record are both listed (not netted away)");
    ok(r.trades.some((t) => t.sym === "ETH" && t.status === "OPEN" && t.mark.date === "2026-10-01" && t.mark.px === 12.5), "ETH open in the record, marked at the record's last crypto close");

    // ---------- 5d. ZN coverage: a window from before the start is not Plan E's; a window R219 never recorded is UNKNOWN; an overdue exit is noted
    r = compute(clone(base()));
    ok(r.notes.some((n) => /^ZN 2026-09 window \(entry 2026-09-23, exit 2026-09-30\) opened before the paper start 2026-09-29 — not in Plan E's paper record$/.test(n)), "the September window straddling the start is noted");
    ok(r.notes.some((n) => /model is in its ZN month-end window on 2026-09-30 where the paper record holds no ZN position/.test(n)), "model-only ZN days are named");
    inp = base(); inp.r219.state.windows["2026-09"] = { ym: "2026-09", entryDay: "2026-09-23", exitDay: "2026-09-30", contract: "/ZNZ26", entry: { px: 111, at: "2026-09-23T19:40:00Z" }, exit: { px: 111.5, at: "2026-09-30T19:40:00Z" } }; r = compute(clone(inp));
    ok(r.status === "OK" && r.trades.filter((t) => t.leg === "zn").length === 1 && r.notes.some((n) => /ZN 2026-09 window .* opened before the paper start 2026-09-29 \(R219 holds it\)/.test(n)), "an R219 window entered before the start is excluded (noted), not counted from day 0");
    r.daily.forEach((d, i) => near(d.value.zn, znV[i], `ZN leg unchanged by the pre-start window ${d.date}`));
    inp = base(); delete inp.r219.state.windows["2026-10"].entry; r = compute(clone(inp));
    ok(r.status === "UNKNOWN" && r.unknown.some((u) => /R219 has no record of the 2026-10 window \(entry session 2026-10-01 is inside the record\)/.test(u)), "a window inside the record that R219 never recorded -> UNKNOWN");
    inp.r219.ledger.push({ kind: "skipped", ym: "2026-10", why: "OFF switch" }); r = compute(clone(inp));
    ok(r.status === "OK" && r.skippedWindows.some((w) => w.ym === "2026-10" && /OFF switch/.test(w.why)) && !r.upcoming.some((u) => u.leg === "ZN" && /2026-10-23/.test(u.when)), "an R219 skip (OFF switch) is a record: listed as SKIPPED, no UNKNOWN, no October entry proposed");
    inp = base(); inp.r219.state.windows["2026-10"].exitDay = "2026-10-02"; r = compute(clone(inp));
    ok(r.status === "UNKNOWN" && r.unknown.some((u) => /^ZN 2026-10: R219 exit due 2026-10-02 not recorded — ZN leg stale from 2026-10-05/.test(u)) && r.daily[4].value.zn == null && r.daily[4].unknown.some((u) => /ZN: R219 exit due 2026-10-02 not recorded — ZN leg stale/.test(u)) && fin(r.daily[3].value.zn) && r.trades.some((t) => t.leg === "zn" && t.status === "OPEN-UNKNOWN" && t.gainUsd == null), "an R219 exit not recorded past its exit day (a later session on record) -> ZN UNKNOWN from the next session (Plan E is flat after the month's last session); the exit day itself stands");
    inp = base(); inp.r219.state.windows["2026-10"].exitDay = "2026-10-05"; r = compute(clone(inp));
    ok(r.status === "OK" && r.notes.some((n) => /ZN 2026-10: R219's exit was due 2026-10-05 and is not recorded yet/.test(n)) && r.trades.some((t) => t.leg === "zn" && t.status === "OPEN" && t.mark.px === 112.75) && fin(r.daily[4].value.zn), "an exit due on the record's last session (R219's exit-day after-close LATE retry still to come) is noted; the window stays open and marked");

    // ---------- 5e. month report: a leg that never moved has no best/worst day
    r = compute(clone(base()));
    ok(r.months["2026-09"].legs.zn.bestDay === null && r.months["2026-09"].legs.zn.worstDay === null, "flat ZN September: no best/worst day");
    { const z = r.months["2026-10"].legs.zn; ok(z.bestDay && z.worstDay && z.worstDay.date === "2026-10-01", "October ZN: worst day 10-01 (entry fee)"); if (z.bestDay) near(z.bestDay.usd, 250 * qz, "October ZN best day = +0.25 pt x 1000 x q"); if (z.worstDay) near(z.worstDay.usd, 247.5 * qz, "October ZN worst day = +0.25 pt less the $2.50 entry fee per contract-eq"); }

    // ---------- 6. local files: required inputs absent / unparsable are UNKNOWN
    const F = files(tmp); fs.mkdirSync(path.join(tmp, "futures-daily"), { recursive: true });
    fs.writeFileSync(F.bookState, JSON.stringify({ cash: 1, holdings: {} })); fs.writeFileSync(F.bookLedger, '{"kind":"daily","date":"2026-09-29"}\nnot json\n');
    let loc = readLocal(F);
    ok(loc.unknown.some((u) => /line 2 of book-etf-ledger.jsonl unparsable/.test(u)) && loc.unknown.some((u) => /R219 state: r219-zn-month-end.json absent/.test(u)) && loc.book.ledger.length === 1, "readLocal: a bad ledger line and an absent R219 state are UNKNOWN");
    fs.writeFileSync(F.r219State, "{"); loc = readLocal(F); ok(loc.unknown.some((u) => /R219 state.*unparsable/.test(u)), "readLocal: unparsable R219 state is UNKNOWN");

    // ---------- 7. outputs: both files written into the temp dir; a re-run keeps firstWrittenAt and records a revision
    r = compute(clone(base()));
    let w = writeOutputs(F, r, "2026-10-05T21:00:00.000Z"); const h1 = fs.readFileSync(F.hist, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(w.histWritten && h1.length === 5 && h1[4].date === "2026-10-05" && Math.abs(h1[4].nav - rnd(r.daily[4].nav)) < 1e-9 && JSON.parse(fs.readFileSync(F.out, "utf8")).spec === SPEC, "--print writes the JSON and one history row per session");
    const inp2 = base(); inp2.adj.SGOV = ser({ "2026-09-29": 100, "2026-09-30": 100.01, "2026-10-01": 100.02, "2026-10-02": 100.03, "2026-10-05": 100.1 }); const r2 = compute(clone(inp2));
    w = writeOutputs(F, r2, "2026-10-06T21:00:00.000Z"); const h2 = fs.readFileSync(F.hist, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(h2.length === 5 && h2[4].firstWrittenAt === "2026-10-05T21:00:00.000Z" && h2[4].writtenAt === "2026-10-06T21:00:00.000Z" && h2[4].revisions && h2[4].revisions[0].prevNav === h1[4].nav && !h2[3].revisions, "a changed session value is kept as a revision; unchanged rows carry none");
    fs.appendFileSync(F.hist, "garbage\n"); const r3 = compute(clone(base())); w = writeOutputs(F, r3, "2026-10-07T21:00:00.000Z");
    ok(!w.histWritten && r3.status === "UNKNOWN" && /garbage/.test(fs.readFileSync(F.hist, "utf8")), "an unparsable history line -> history not rewritten, UNKNOWN");
    ok(!fs.readdirSync(tmp).some((f) => /\.tmp-/.test(f)), "no temp files left behind");

    // ---------- 8. Plan E extraction (offline): the real sources still describe one Plan E
    const PT = require("./planE-tasty.js"), real = PT.loadPlanE(BACKEND, { fetchBars: async () => { throw new Error("offline"); }, monthSessions: async () => [], dailyCloses: async () => [] }), ex = extractExtra(BACKEND);
    ok(Math.abs(real.etfShare + real.cryptoShare + real.znReserve - 1) < 1e-9 && real.PLAN_E_BOOK_USD > 0 && real.BOOK_CAPITAL / real.PLAN_E_BOOK_USD === real.etfShare, "loadPlanE: ETF + crypto + reserve = the whole book; BOOK capital / anchor = ETF share");
    ok(fin(real.ZN_LEV) && real.ZN_LEV > 0 && fin(ex.ZN_BETA) && ex.ZN_BETA > 0 && ex.R219.MULT === 1000 && fin(ex.R219.FEE_SIDE) && typeof real.plan === "function" && real.COINS.every((c) => real.W[c] > 0), "extraction: ZN_LEV, ZN_BETA, R219 MULT/FEE_SIDE, the BOOK's plan(), crypto weights");
    ok(real.decide(Array.from({ length: real.N }, (_, i) => ({ d: `d${i}`, c: 100 }))).want === false && real.decide(Array.from({ length: real.N }, (_, i) => ({ d: `d${i}`, c: i === real.N - 1 ? 100.01 : 100 }))).want === true, "R191's real decision line: a close equal to its N-day mean is OUT, one above it IN");
  } catch (e) { fail++; console.log(`  FAIL selftest threw: ${e.stack}`); }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  console.log(`planE-paper-scoreboard selftest: ${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

module.exports = { compute, cryptoSim, fifo, monthReport, renderLine, renderTrades, renderDaily, renderMonth, readLocal, writeOutputs, files, START };
if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(`planE-paper-scoreboard FAILED: ${e.stack}`); process.exitCode = 1; });
