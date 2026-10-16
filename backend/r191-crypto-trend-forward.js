#!/usr/bin/env node
/**
 * R191 — 50-DAY CRYPTO TREND RULE, FORWARD on the Alpaca PAPER account (registered 2026-09-24; rule frozen in the registry).
 * BTC and ETH: in when the last completed UTC daily close (Coinbase) is above the 50-day average of completed closes; $10,000 notional each.
 *   node backend/r191-crypto-trend-forward.js --run [--live]   decide + (live) send paper orders + reconcile + mark (close chain, weekdays)
 *   node backend/r191-crypto-trend-forward.js --status | --read
 * FORWARDREC 2026-10-05 (health sweep FT-8): every completed UTC day since the first mark gets exactly one mark row (lib/forward-catchup.js) —
 *   the weekday chain had marked 5 of 7 days. R191_STATE_DIR=<dir> runs against a COPY of the state in <dir> for proofs: no broker call is made,
 *   --live and --read are refused, a --run saves the copy; R191_BARS_FILE (sandbox only) replaces Coinbase with a fixture {BTC:[{d,c}],ETH:[...]}.
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { catchUpRows, pricedMarks } = require("./lib/forward-catchup.js");   // FORWARDREC 2026-10-05
const SANDBOX = process.env.R191_STATE_DIR ? path.resolve(process.env.R191_STATE_DIR) : null;   // FORWARDREC 2026-10-05: a state COPY, never the live files
const D = (f) => path.join(__dirname, "data", f), SD = (f) => (SANDBOX ? path.join(SANDBOX, f) : D(f)), STATE = SD("r191-crypto-trend.json"), LEDGER = SD("r191-crypto-trend.jsonl"), OFF = SD("r191-OFF");
const BASE = "https://paper-api.alpaca.markets", COINS = ["BTC", "ETH"], N = 50, NOTIONAL = 10000, START = "2026-09-25";
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, "content-type": "application/json" };
const LIVE = process.argv.includes("--live"), mode = ["--run", "--status", "--read"].find((m) => process.argv.includes(m)) || "--status";
if (SANDBOX && (LIVE || mode === "--read")) { console.error(`r191: R191_STATE_DIR is a sandbox (${SANDBOX}) — --live and --read are refused`); process.exit(2); }   // FORWARDREC 2026-10-05
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const api = async (p, init) => { if (SANDBOX) throw new Error("sandbox: no broker call"); if (!/paper-api/.test(BASE)) throw new Error("not the paper endpoint"); const r = await fetch(BASE + p, { headers: H, ...init }); const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(`${r.status} ${JSON.stringify(j).slice(0, 160)}`); e.status = r.status; throw e; } return j; };
const load = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { spec: "r191-state-v1", coins: Object.fromEntries(COINS.map((c) => [c, { qty: 0, held: false, pending: null }])), marks: [], orders: [] });
const save = (s) => { s.asOf = new Date().toISOString(); writeJsonAtomic(STATE, s); };
const ledger = (o) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
// PAPER-AUCTION-FIX 2026-10-02 (partial-fill audit, operator "yes"): terminal broker statuses; a client id is never re-used (Alpaca refuses it —
// a same-day re-send gets -2, -3); a failed POST is read back by client id and the order adopted if it exists, else recorded and skipped
// (one refused order no longer aborts the run and loses the orders already sent).
const DONE = ["filled", "canceled", "expired", "rejected", "done_for_day"];   // (as it was) — the helpers of R191-SELL-REPAIR 2026-10-14 follow
// ══ R191-SELL-REPAIR 2026-10-14 (operator 2026-10-13 08:39 MT: "repair R191"; work order 4.39; docs/r191-sell-repair/2026-10-14) ══════════════════
// THE SAME THREE CHANGES AS R231-SELL-REPAIR 2026-10-12 (docs/r231-sell-repair/2026-10-12): its helpers, read for this book. An EXECUTION REPAIR
// after evidence: no rule, size, universe, statistic, bar or read condition changes.
// WHAT WAS WRONG. The broker takes the fee of a crypto BUY in the coin (its CFEE rows), so the account receives less than the order's
// filled_qty. This file counted filled_qty and asked a FULL sell of that count. Its one full sell, ETH on 2026-10-09, asked 3.639529815 and
// filled only because the same paper account also held R231's ETH (0.009098825 ETH of it was R231's). It still counts 0.116651415 BTC, whose
// full sell asks 0.000291629 BTC more than the account received for it. The paper account also holds R231's coins and the board mirror's.
// WHAT CHANGES:
//   (1) A reconciled BUY counts what the account received: filled_qty less the fee the broker reports for that order — the rows of
//       GET /v2/account/activities/CFEE for the coin (field `qty`, negative, in the coin), created from 5 s before to 120 s after the order's
//       filled_at; when the coin's rows carry a date and no time, the rows dated the fill's day, taken only when no other buy of the coin is
//       on the account's files that day. Where the fee cannot be read (no row; rows too large to be this order's alone; another sleeve's buy of
//       the coin in the same two minutes or, by date, that day; the call fails) the run says UNKNOWN, counts filled_qty as before and relies
//       on (2). No fee rate is assumed, ever.
//   (2) A SELL never asks for more than the account has FOR THIS BOOK: the account's position in the coin (GET /v2/positions, read ONCE a run,
//       before any order is decided; qty_available) less what the other sleeves count for it in their own files (otherSleeves: R231's state,
//       the board mirror's two files). Positions unreadable (after three tries when the broker is busy): no sell this run. Another sleeve's
//       file unreadable (a count in it that is not a quantity among the ways), an order of its own not yet booked on that coin that the
//       broker does NOT show ended (asked by its own client id before the positions are read: settleOthers — one it shows ended is settled
//       for this run by what it filled), or part of the position held for an open order that is not this book's: no sell of that coin this
//       run. Each is said on its line; any sell due and not sent ends the run exit 1 with the reason LAST
//       on stderr. An order of this book ALREADY AT THE BROKER under today's id is adopted as before, never refused and never re-sized
//       (adoptedSell), and before the guard answers from what the account shows the broker is asked once for today's id (sellAsk).
//   (3) Every sell of this rule is the whole count (a CLOSE). One that had to be cut to what the account has leaves the coin FLAT once it
//       fills in full, when what is left of the count is DUST (one twentieth, below); the quantity written off is on the ledger row. More
//       than dust is not written off: it stays counted, is noted on the coin (closeShort), and EVERY run ends exit 1 with it last on stderr
//       until a person puts the count right.
// UNCHANGED: with nothing cut — the account has at least the count for this book — every order, printed line, state byte and ledger row is as
// before; what a run does more is reads: one of the account's positions, and one by client id of each order of another sleeve's that its
// file shows not booked yet (settleOthers). data/r191-OFF still withholds buys. A sandbox
// (R191_STATE_DIR) still never asks the broker: it reads the account from R191_POSITIONS_FILE (a fixture: [{ symbol, qty, qty_available }])
// and the other sleeves' files from the sandbox folder; with no fixture there is no account to read and the sell is the count, as before.
const NANO = 1e9, nano = (x) => Math.round(Number(x) * NANO), s9 = (n) => (n / NANO).toFixed(9), qn = (n) => +s9(n);   // whole 1e-9 units: sums and differences are exact
// DUST — the ONE definition (R231-SELL-REPAIR's). After a CLOSE that asked for all the account had for this book has filled in full, what is still
// counted is dust when it is at most one twentieth (5%) of the DUST BASE (dustBase): the larger of the count the close was sized on and what
// this book has BOUGHT of the coin since the coin was last flat. That covers the buy fee itself (0.25% of what was bought) and the fees the other
// sleeves' full sells took out of the shared balance. Anything larger is not explained by fees and is never written off.
const DUST_ONE_IN = 20;
const isDust = (leftNano, sizedNano) => Number.isFinite(leftNano) && leftNano >= 0 && sizedNano > 0 && leftNano * DUST_ONE_IN <= sizedNano;
const myCid = (c) => new RegExp(`^r191-${c}-\\d{8}-(?:buy|sell)(?:-\\d+)?$`);   // a client id of this book for the coin
/**
 * THE DUST BASE of a coin, in nano: the larger of `countedNano` (the count a close is sized on) and what this book has bought of the coin since the
 * coin was last FLAT, from `orders` — the state's order rows, this book's booked fills, oldest first. The coin was flat where a sell row carries
 * `writtenOff`, or where the rows' own running count came to zero (a buy counts its `net` where its row has one, as the count itself does). Only
 * the buys since then are in the count; an earlier holding, however large, never makes a later one's dust larger. No rows: the base is the count.
 */
function dustBase(c, countedNano, orders) {
  let run = 0, bought = 0; const re = myCid(c);
  for (const o of Array.isArray(orders) ? orders : []) {
    if (!o || !re.test(String(o.cid))) continue;
    const q = nano(o.qty); if (!(q > 0)) continue;
    if (o.side === "buy") { run += typeof o.net === "number" ? nano(o.net) : q; bought += q; }
    else { run = typeof o.writtenOff === "number" ? 0 : Math.max(0, run - q); if (run === 0) bought = 0; }
  }
  return Math.max(countedNano, bought);
}
const dustOf = (c, baseNano, countedNano) => (baseNano > countedNano ? `1/${DUST_ONE_IN} of the ${s9(baseNano)} ${c} bought since it was last flat` : `1/${DUST_ONE_IN} of the count`);
const FEE_BEFORE_MS = 5000, FEE_AFTER_MS = 120000;   // a fee row belongs to a fill when it was created from 5 s before to 120 s after it (as backend/r309-surge-hold48.js N6)
const FEE_SHARE_MAX = 0.006;                          // fee rows above 0.6% of the fill are not this order's alone: UNKNOWN (never a rate that is applied)
const RUN = { hold: null, holdFail: false, holdErr: null, others: null, asked: null, faults: [] };   // one run: the account as read (holdFail: the read failed — a FLAG, never judged by whether the error had words), the other sleeves' counts, what the broker said of their orders not booked yet (settleOthers), every sell due and not sent
const coinOf = (sym) => { const m = /^([A-Z0-9]+)\/?USD$/.exec(String(sym || "")); return m ? m[1] : null; };
/** a count in another sleeve's file is a quantity only when it IS one: a number, or a string of digits. null (how JSON writes NaN), "", false, [] are NOT — never read as 0 */
const isQty = (x) => (typeof x === "number" && Number.isFinite(x)) || (typeof x === "string" && /^\d+(\.\d+)?$/.test(x.trim()));
/**
 * THE OTHER SLEEVES that can hold BTC or ETH on the same paper account (every backend runner that posts orders with these keys, as read by
 * R231-SELL-REPAIR 2026-10-12), each from its OWN file in the same data folder:
 *   R231                        r231-crypto-vote-sized.json: coins.<COIN>.qty is its count (13 coins, BTC and ETH among them; a count that is not
 *                               a quantity — null, "", false — makes the whole file unreadable, never 0); coins.<COIN>.pending is an order of its
 *                               own that it has not booked yet — its count of that coin is not settled, unless the broker shows that order ENDED
 *                               (settleOthers): then its count is settled for this run by what the order filled
 *   the board's Alpaca mirror   alpaca-mirror.jsonl: every crypto ticket it bought (cls "Crypto", orderId, live), less the tickets that have a
 *                               FINAL row in alpaca-mirror-exits.jsonl; a ticket with a close order that is not final yet is not settled, unless the
 *                               broker shows every close order of the ticket ENDED (settleOthers): then it counts what those orders left of it
 * -> { n: { COIN: nano counted by others }, why: { COIN: [words] }, unsettled: { COIN: [words] }, unread: { COIN: [words] }, notes: [lines],
 *      buys: [{ coin, ms, by }] (their buys of a coin, with the time when it is known: a fee row near one of them is not told apart) }
 */
function otherSleeves() {
  const o = { n: {}, why: {}, unsettled: {}, unread: {}, notes: [], buys: [] }, push = (m, k, v) => { (m[k] = m[k] || []).push(v); };
  const count = (c, id, n, more = "") => { o.n[c] = (o.n[c] || 0) + n; push(o.why, c, `${id} ${s9(n)}${more}`); };
  const rows = (f) => fs.readFileSync(SD(f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const asked = (key) => (RUN.asked && RUN.asked.get(key)) || null;   // what the broker said of another sleeve's order not booked yet (settleOthers); null: not asked
  try {
    const j = JSON.parse(fs.readFileSync(SD("r231-crypto-vote-sized.json"), "utf8")); if (!j || !j.coins || typeof j.coins !== "object") throw new Error("it has no coins table");
    const got = [];
    for (const [c, v] of Object.entries(j.coins)) { const n = v && typeof v === "object" && isQty(v.qty) ? nano(v.qty) : NaN; if (!Number.isFinite(n) || n < 0) throw new Error(`its count of ${c} is not a quantity`); got.push([c, n, v.pending]); }
    for (const [c, n, pend] of got) {
      const a = pend ? asked(`R231 ${pend.cid}`) : null, ended = !!(a && a.ended), k = !ended ? n : a.side === "sell" ? Math.max(0, n - a.filled) : n + a.filled;   // ENDED at the broker: a sell comes off, a buy is added at its GROSS filled quantity (the safe side)
      if (k > 0) count(c, "R231", k, ended ? `: its file's ${s9(n)} ${a.side === "sell" ? "less" : "and"} the ${s9(a.filled)} its ${a.side} ${a.ids.join(", ")} filled at the broker, not yet booked in its file` : "");
      if (pend && !ended) push(o.unsettled, c, `${a ? `${a.why} — ` : ""}R231 has an order of its own on ${c} that it has not booked yet (data/r231-crypto-vote-sized.json)`);
      if (pend && pend.side === "buy") o.buys.push({ coin: c, ms: null, by: "R231" });
    }
    for (const x of Array.isArray(j.orders) ? j.orders : []) { const m = /^r231-([A-Z0-9]+)-/.exec(String((x && x.cid) || "")); if (m && x.side === "buy") o.buys.push({ coin: m[1], ms: Date.parse(x.at), by: "R231" }); }
  } catch (e) { const why = `data/r231-crypto-vote-sized.json cannot be read (${String(e.message).slice(0, 80)})`; for (const c of COINS) push(o.unread, c, why); o.notes.push(`${why}: no sell of ${COINS.join(", ")} until it can`); }
  try {
    const fin = new Set(), working = new Set(), open = [];
    for (const x of rows("alpaca-mirror-exits.jsonl")) if (x && x.ticketId) (x.final ? fin : working).add(x.ticketId);
    for (const r of rows("alpaca-mirror.jsonl")) {
      if (!r || r.cls !== "Crypto" || !r.orderId || !r.live) continue;
      const c = coinOf(r.sym), n = Math.ceil(Number(r.qty) * NANO - 1e-6);
      if (c && r.side === "buy") o.buys.push({ coin: c, ms: Date.parse(r.ts), by: "the board's mirror" });
      if (fin.has(r.ticketId)) continue;
      if (!c || !Number.isFinite(n) || n <= 0) throw new Error(`ticket ${String(r.ticketId).slice(0, 40)} has no readable coin or quantity`);
      open.push([c, n, working.has(r.ticketId), r.ticketId]);
    }
    for (const [c, n, closing, t] of open) {
      const a = closing ? asked(`mirror ${t}`) : null, ended = !!(a && a.ended), k = ended ? Math.max(0, n - a.filled) : n;   // every close order of the ticket ENDED at the broker: what they filled comes off
      if (k > 0) count(c, "the board's mirror", k, ended ? `: its ticket's ${s9(n)} less the ${s9(a.filled)} its close order${a.ids.length === 1 ? "" : "s"} ${a.ids.join(", ")} filled at the broker, not yet final in its file` : "");
      if (closing && !ended) push(o.unsettled, c, `${a ? `${a.why} — ` : ""}the board's mirror has a close order of its own on ${c} that is not final yet (data/alpaca-mirror-exits.jsonl)`);
    }
  } catch (e) { const why = `the board mirror's files (data/alpaca-mirror.jsonl, data/alpaca-mirror-exits.jsonl) cannot be read (${String(e.message).slice(0, 80)})`; for (const c of COINS) push(o.unread, c, why); o.notes.push(`${why}: no sell of any coin until they can`); }
  return o;
}
/**
 * ANOTHER SLEEVE'S ORDER NOT BOOKED YET, ASKED OF THE BROKER (R191-SELL-REPAIR 2026-10-14, review 1). R231 books its fills at the start of ITS
 * run, right after this one in the close chain, and the board's mirror makes a close final at its next fire: on the evening after either sent
 * an order of BTC or ETH, its own file still shows that order as not booked when this book decides. Refused on sight, that would have held back
 * this book's one real sell (ETH, 2026-10-09: R231's ETH sell of 10-08 was booked 0.27 s after this book's sell went) for two sessions. So each
 * such order is asked of the broker by ITS OWN client id (a read: GET /v2/orders:by_client_order_id, through apiGet; R231's: its pending order's
 * id; the mirror's: its close orders as it names them, mx-<ticket>, then -S2, -S3, until the broker has no more), and asked BEFORE the account's
 * positions are read, so an order the broker shows ended is already in the positions read after it. -> RUN.asked: Map "R231 <id>" | "mirror
 * <ticket>" -> { ended: true, filled: nano, side, ids } or { why }. ENDED (every order asked is filled / canceled / expired / rejected /
 * done_for_day): otherSleeves settles that sleeve's count for this run. STILL WORKING, NOT FOUND, a side that is not its file's, a filled
 * quantity that is not a quantity, or a lookup that fails: not settled — no sell of that coin this run, said, exit 1, as before. A sandbox never
 * asks the broker: there every such order stays not settled. Never throws: what it could not ask stays not settled.
 */
async function settleOthers() {
  const asked = new Map(), want = [], rowsOf = (f) => fs.readFileSync(SD(f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  try { const j = JSON.parse(fs.readFileSync(SD("r231-crypto-vote-sized.json"), "utf8")); for (const c of COINS) { const p = j && j.coins && j.coins[c] && j.coins[c].pending; if (p && p.cid) want.push([`R231 ${p.cid}`, [String(p.cid)], p.side]); } } catch { /* unreadable: otherSleeves says so */ }
  try {
    const fin = new Set(), working = new Set();
    for (const x of rowsOf("alpaca-mirror-exits.jsonl")) if (x && x.ticketId) (x.final ? fin : working).add(x.ticketId);
    for (const r of rowsOf("alpaca-mirror.jsonl")) if (r && r.cls === "Crypto" && r.orderId && r.live && r.side === "buy" && COINS.includes(coinOf(r.sym)) && working.has(r.ticketId) && !fin.has(r.ticketId)) want.push([`mirror ${r.ticketId}`, [1, 2, 3].map((k) => (k > 1 ? `${("mx-" + r.ticketId).slice(0, 124)}-S${k}` : ("mx-" + r.ticketId).slice(0, 128))), "sell"]);
  } catch { /* unreadable: otherSleeves says so */ }
  for (const [key, ids, side] of want) {
    if (asked.has(key)) continue;
    const got = []; let why = side === "buy" || side === "sell" ? null : `its file does not say whether ${ids[0]} is a buy or a sell`;
    for (let i = 0; i < ids.length && !why; i++) {
      let ex; try { ex = await apiGet(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(ids[i])}`); }
      catch (e) { if (e && e.status === 404 && i > 0) break; why = e && e.status === 404 ? `the broker has no order ${ids[i]}` : `${ids[i]} could not be looked up at the broker (${String((e && e.message) || "").slice(0, 80) || "unknown error"})`; break; }
      if (!ex || !ex.id) { why = `the broker's answer for ${ids[i]} is not an order`; break; }
      got.push(ex);
    }
    if (!why) { const w = got.find((x) => !DONE.includes(x.status)); if (w) why = `${w.client_order_id || ids[0]} is still working at the broker (${w.status})`; }
    if (!why) { const b = got.find((x) => x.side && x.side !== side); if (b) why = `the broker's ${b.client_order_id || ids[0]} is a ${b.side}, not the ${side} its file says`; }
    const filled = got.reduce((a, x) => a + (isQty(x.filled_qty) ? nano(x.filled_qty) : NaN), 0);   // a filled_qty that is missing or null is NOT 0: not settled
    if (!why && !(Number.isFinite(filled) && filled >= 0)) why = `what ${ids[0]} filled at the broker is not a quantity`;
    asked.set(key, why ? { why } : { ended: true, filled, side, ids: got.map((x) => x.client_order_id || "?") });
  }
  RUN.asked = asked;
}
// One reading of those files is kept — but the run CLEARS it where it reads the account's positions (before the order loop), so what a sell is
// judged on was read AFTER the positions, never before. A buy booked at the start of a run reads the files earlier, for its fee only (booked).
const others = () => RUN.others || (RUN.others = otherSleeves());
/** one READ of the broker (never an order), asked up to three times when it answers "busy" (429) or with a server error, or does not answer */
async function apiGet(p) {
  for (let i = 0; ; i++) {
    try { return await api(p); }
    catch (e) { if (i >= 2 || !(e.status == null || e.status === 429 || e.status >= 500)) throw e; await new Promise((r) => setTimeout(r, 1000 * (i + 1))); }
  }
}
/** the account's positions in this book's coins, once -> { COIN: { qty, avail } } in nano (a coin not listed is 0); null = a sandbox with no fixture */
async function accountHolds() {
  let a;
  if (SANDBOX) { if (!process.env.R191_POSITIONS_FILE) return null; a = JSON.parse(fs.readFileSync(process.env.R191_POSITIONS_FILE, "utf8")); }
  else a = await apiGet("/v2/positions");
  if (!Array.isArray(a)) throw new Error("the positions answer is not a list");
  const h = Object.fromEntries(COINS.map((c) => [c, { qty: 0, avail: 0 }]));
  for (const p of a) {
    const c = coinOf(p && p.symbol); if (!c || !h[c] || (p.asset_class && p.asset_class !== "crypto")) continue;
    const q = nano(p.qty), av = p.qty_available == null ? q : nano(p.qty_available);
    if (!Number.isFinite(q) || !Number.isFinite(av) || q < 0 || av < 0) throw new Error(`the position in ${c} has no readable quantity`);
    h[c] = { qty: q, avail: Math.min(q, av) };
  }
  return h;
}
let FEE_ROWS = null, FEE_FROM = Infinity;
/** the account's CFEE rows, newest first, back to the day before `sinceMs` (the paging of backend/r309-surge-hold48.js); read at most once a run */
async function cfeeRows(sinceMs) {
  if (FEE_ROWS && sinceMs >= FEE_FROM) return FEE_ROWS;
  const out = [], stop = new Date(sinceMs - 864e5).toISOString().slice(0, 10); let token = null, done = false;
  for (let i = 0; i < 20 && !done; i++) {
    const page = await apiGet(`/v2/account/activities/CFEE?direction=desc&page_size=100${token ? "&page_token=" + encodeURIComponent(token) : ""}`);
    if (!Array.isArray(page)) throw new Error("the CFEE answer is not a list");
    out.push(...page); const last = page[page.length - 1];
    if (page.length < 100 || String((last && (last.date || last.created_at)) || "").slice(0, 10) < stop) done = true; else token = last.id;
  }
  if (!done) throw new Error("more than 20 pages of CFEE rows");
  FEE_ROWS = out; FEE_FROM = sinceMs; return out;
}
const dayUTC = (ms) => new Date(ms).toISOString().slice(0, 10), NY_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const dayNY = (ms) => { const p = {}; for (const x of NY_DAY.formatToParts(ms)) p[x.type] = x.value; return `${p.year}-${p.month}-${p.day}`; };
/**
 * (1), pure: the fee of ONE filled buy from the fee rows -> { fee: nano, rows, used: [the rows] } (and `byDate` when read by date) or { fee: null, why }.
 * R231-SELL-REPAIR's function, word for word in what it decides (docs/r191-sell-repair/2026-10-14/selftest.cjs runs both on the same rows).
 * BY TIME, when a fee row of the coin carries `created_at`: the rows created from 5 s before to 120 s after the fill.
 * BY DATE, only when NO fee row of the coin carries a time: the rows dated the fill's day, and only when they can be nobody else's —
 *   · the fill's day is the same date in UTC and in New York;
 *   · no other buy of the coin is on the account's files that day, by either clock: not this book's (`ownBuys`: [{ ms }], its OTHER buys of the
 *     coin) and not another sleeve's (`otherBuys`), and none of unknown time;
 *   · the rows come to no more than 0.6% of the fill.
 * Anything else is UNKNOWN. The time reading does not use `ownBuys`: this book has one order a coin at a time.
 */
function feeOfBuy(rows, coin, fillMs, filledNano, otherBuys, ownBuys) {
  if (!Number.isFinite(fillMs)) return { fee: null, why: "the order has no fill time" };
  if (!(filledNano > 0)) return { fee: null, why: "the order has no filled quantity" };
  const near = (otherBuys || []).find((b) => b.coin === coin && (!Number.isFinite(b.ms) || Math.abs(b.ms - fillMs) <= FEE_BEFORE_MS + FEE_AFTER_MS));
  if (near) return { fee: null, why: `${near.by} bought ${coin} in the same two minutes: the fee rows cannot be told apart` };
  const mine = (rows || []).filter((r) => r && coinOf(r.symbol) === coin && Number(r.qty) < 0);
  let m, day = null;
  if (mine.length && !mine.some((r) => Number.isFinite(Date.parse(r.created_at)))) {
    day = dayUTC(fillMs); const onDay = (ms) => dayUTC(ms) === day || dayNY(ms) === day;
    if (dayNY(fillMs) !== day) return { fee: null, why: `the broker's ${coin} fee rows carry a date and no time, and this fill's day is ${day} in UTC but ${dayNY(fillMs)} in New York: its rows cannot be told by date` };
    const also = (otherBuys || []).find((b) => b.coin === coin && onDay(b.ms));
    if (also) return { fee: null, why: `the broker's ${coin} fee rows carry a date and no time, and ${also.by} bought ${coin} on the same day (${day}): the fee rows cannot be told apart` };
    if ((ownBuys || []).some((b) => !Number.isFinite(b.ms) || onDay(b.ms))) return { fee: null, why: `the broker's ${coin} fee rows carry a date and no time, and this book has another buy of ${coin} on the same day (${day}), or one of unknown time: the fee rows cannot be told apart` };
    m = mine.filter((r) => String(r.date).slice(0, 10) === day);
    if (!m.length) return { fee: null, why: `the broker lists no fee row (CFEE) for ${coin} dated ${day} (${mine.length} ${coin} fee row${mine.length === 1 ? "" : "s"} read, with a date and no time)` };
  } else {
    m = mine.filter((r) => { const t = Date.parse(r.created_at); return t >= fillMs - FEE_BEFORE_MS && t <= fillMs + FEE_AFTER_MS; });
    if (!m.length) return { fee: null, why: `the broker lists no fee row (CFEE) for ${coin} from 5 s before to 120 s after its fill (${mine.length} ${coin} fee row${mine.length === 1 ? "" : "s"} read)` };
  }
  const fee = m.reduce((a, r) => a - nano(r.qty), 0);
  if (!(fee > 0) || fee > filledNano * FEE_SHARE_MAX) return { fee: null, why: `the fee rows ${day ? `dated ${day}` : "in its window"} come to ${(100 * fee / filledNano).toFixed(3)}% of the fill (over 0.6%: not this order's alone)` };
  return day ? { fee, rows: m.length, used: m, byDate: day } : { fee, rows: m.length, used: m };
}
/**
 * (1) and (3): what a reconciled fill does to the count. `before` = the count before the fill; `asBefore` = the count as this file always computed
 * it (a buy sets filled_qty, a sell takes it off); `orders` = the state's order rows before this fill (this book's other buys of the coin, for a
 * fee read by date; the dust base of a close). -> { qty, order: fields added to the state's order row, row: fields added to the ledger row,
 * closeShort: the note for the coin when a close filled and more than dust is still counted }. A sell that was not a cut close returns
 * `asBefore` and adds nothing: byte for byte as before. A buy whose fee is read counts `asBefore` less that fee: what the account received.
 */
async function booked(c, p, o, q, px, before, asBefore, orders) {
  if (p.side === "buy") {
    const t = Date.parse(o.filled_at), own = (Array.isArray(orders) ? orders : []).filter((x) => x && x.side === "buy" && myCid(c).test(String(x.cid))).map((x) => ({ ms: Date.parse(x.at) })); let f;
    // an other sleeve's file that cannot be read cannot say whether that sleeve bought the coin in the same minutes: its fee rows could be taken for this order's — UNKNOWN (R191-SELL-REPAIR, stricter than the R231 helpers it copies)
    try { const O = others(); f = !Number.isFinite(t) ? feeOfBuy([], c, t, nano(q), [], []) : O.unread[c] ? { fee: null, why: `${O.unread[c][0]} — whether another sleeve bought ${c} in the same minutes is not known: the fee rows cannot be told apart` } : feeOfBuy(await cfeeRows(t), c, t, nano(q), O.buys, own); } catch (e) { f = { fee: null, why: `the broker's fee rows could not be read (${String(e.message).slice(0, 100)})` }; }
    if (f.fee == null) { console.log(`  ${c} · fee UNKNOWN (${f.why}) — the ${q} ${c} filled is counted as it is; a sell of ${c} stays capped by what the account holds`); return { qty: asBefore, order: { fee: null }, row: { fee: null, feeUnknown: f.why } }; }
    const net = nano(q) - f.fee;
    console.log(`  ${c} · buy counted NET of its fee: filled ${q}, fee ${s9(f.fee)} ${c} (${f.rows} CFEE row${f.rows === 1 ? "" : "s"}${f.byDate ? ` dated ${f.byDate}: the rows carry a date and no time` : ""}), received ${s9(net)}`);
    return { qty: qn(nano(asBefore) - f.fee), order: { fee: qn(f.fee), net: qn(net) }, row: { fee: qn(f.fee), net: qn(net), feeRows: f.rows, ...(f.byDate ? { feeByDate: f.byDate } : {}) } };
  }
  if (!p.close) return { qty: asBefore, order: {}, row: {} };
  const left = Math.max(0, nano(before) - nano(q)), full = o.status === "filled" && nano(q) >= nano(p.close.asked), usd = +((left / NANO) * (px || 0)).toFixed(2);
  // what the remainder is measured against (dustBase), and what the OTHER SLEEVES counted of the account's coin when the close was sized: part of
  // what is written off can still be in the account, left there for another sleeve's own count — so it is "not available to this book", never "not in the account"
  const cnt = nano(p.close.counted), base = dustBase(c, cnt, orders), oth = nano(p.close.others) > 0 ? { others: p.close.others } : {}, more = base > cnt ? { dustBase: qn(base) } : {};
  if (full && isDust(left, base)) {
    console.log(`  ${c} · CLOSED: ${s9(nano(q))} went, all the account had for this book; the ${s9(left)} ${c} ($${usd.toFixed(2)}) still counted is not available to this book${oth.others ? ` (other sleeves counted ${s9(nano(oth.others))} ${c} of the account's when the sell was sent)` : ""} and is written off — ${c} is flat`);
    return { qty: 0, order: { writtenOff: qn(left) }, row: { flat: true, writtenOff: qn(left), writtenOffUsd: usd, ...oth, ...more } };
  }
  if (full) {
    console.log(`  ${c} · CLOSE filled but NOT flat: ${s9(left)} ${c} ($${usd.toFixed(2)}) is still counted and the account had no more for this book — more than dust (${dustOf(c, base, cnt)}), so it stays counted`);
    RUN.faults.push(`${c}: its close filled and ${s9(left)} is still counted — more than dust`); process.exitCode = 1;
    return { qty: asBefore, order: {}, row: { closeShort: qn(left), closeShortUsd: usd, ...oth, ...more }, closeShort: { qty: qn(left), cid: p.cid, at: new Date().toISOString() } };
  }
  return { qty: asBefore, order: {}, row: {} };   // the close filled in part: what is left is asked again by a later run
}
/**
 * (2): what a sell may ask for. `counted` = this book's count, `ruleQty` = what the rule asks (this rule: always the whole count), `px` = the last
 * close, `orders` = the state's order rows (the dust base of a close). -> { qty, pend, row, words } to go on, or { no: why } when no order may
 * be asked this run. With the account holding at least `ruleQty` for this book it returns `ruleQty` and adds nothing.
 * NO ACCOUNT IN HAND IS A REFUSAL, with one exception: a sandbox that was given no account fixture (it can send nothing, and there is no
 * account to read) passes the rule's quantity, as before. A failed read is the FLAG RUN.holdFail, whatever words the error carried or did not.
 */
function sellGuard(c, counted, ruleQty, px, orders) {
  const pass = { qty: ruleQty, pend: {}, row: {}, words: "" };
  if (RUN.holdFail) return { no: `the account's positions could not be read (${RUN.holdErr || "unknown error"})` };
  if (!RUN.hold) return SANDBOX && !process.env.R191_POSITIONS_FILE ? pass : { no: "the account's positions were not read this run" };
  const O = others(), h = RUN.hold[c], oth = O.n[c] == null ? 0 : O.n[c];   // no other sleeve counts the coin: 0. A count that is THERE and is not a number is never read as 0 (below)
  if (O.unread[c]) return { no: `${O.unread[c][0]} — what another sleeve counts of ${c} is not known` };
  if (O.unsettled[c]) return { no: `${O.unsettled[c][0]} — its count of ${c} is not settled` };
  if (!Number.isFinite(oth) || oth < 0) return { no: `what the other sleeves count of ${c} is not a quantity (${String(oth)}) — it is not known` };
  // `account: true` marks the two answers that come from what the ACCOUNT shows: an order of this book already at the broker shows as exactly that (sellAsk)
  if (h.avail < h.qty) return { account: true, no: `${s9(h.qty - h.avail)} of the account's ${s9(h.qty)} ${c} is held for an open order that is not this book's` };
  const room = Math.max(0, h.avail - oth), rule = nano(ruleQty), cnt = nano(counted);
  if (room >= rule) return pass;
  const acct = `the account holds ${s9(h.avail)}${oth ? `, of which other sleeves count ${s9(oth)} (${O.why[c].join(", ")})` : ""}`;
  if (room <= 0) return { account: true, no: `the account has no ${c} for this book: ${acct}; this book counts ${s9(cnt)}` };
  const close = rule >= cnt, left = cnt - room, usd = ((left / NANO) * px).toFixed(2), cap = { rule: ruleQty, counted: qn(cnt), asked: qn(room), account: qn(h.avail), others: qn(oth), close };
  if (!close) return { qty: qn(room), pend: {}, row: { capped: cap }, words: ` · cut from the rule's ${s9(rule)} to the ${s9(room)} the account has for this book (${acct})` };
  const base = dustBase(c, cnt, orders), dust = isDust(left, base);
  if (base > cnt) cap.dustBase = qn(base);
  if (!dust) { RUN.faults.push(`${c}: its close is ${s9(left)} short of the count — more than dust`); process.exitCode = 1; }
  // the pending order notes the close it was cut from, and what the other sleeves counted of the account's coin (only when they count any): the fill's own records say it
  return { qty: qn(room), pend: { close: { counted: qn(cnt), asked: qn(room), ...(oth > 0 ? { others: qn(oth) } : {}) } }, row: { capped: cap },
    words: ` · CLOSE cut to the ${s9(room)} the account has for this book, of ${s9(cnt)} counted (${acct}); the other ${s9(left)} ($${usd}) ${dust ? "is written off when this fills in full" : `is MORE THAN DUST (${dustOf(c, base, cnt)}) and stays counted`}` };
}
/**
 * An order of this book ALREADY AT THE BROKER under today's id (`ex`), adopted: nothing is POSTed and it is never re-sized, so what was asked is ITS
 * OWN quantity, not the rule's. Asking the rule's quantity or more, or with no readable quantity: the records are the ones this file always wrote
 * for an adopted order — nothing is added. Asking LESS (an earlier run today cut it to what the account had for this book): the ledger row and the
 * printed line carry the order's own quantity, and the pending order notes the close exactly as sellGuard notes a close it cut itself, so that its
 * fill leaves the coin FLAT (3).
 */
function adoptedSell(c, counted, ruleQty, px, ex, orders) {
  const asked = nano(ex && ex.qty), rule = nano(ruleQty), cnt = nano(counted);
  if (!(asked > 0) || asked >= rule) return { qty: ruleQty, pend: {}, row: {}, words: "" };
  const close = rule >= cnt, left = cnt - asked, usd = ((left / NANO) * px).toFixed(2), cap = { rule: ruleQty, counted: qn(cnt), asked: qn(asked), adopted: true, close };
  if (!close) return { qty: qn(asked), pend: {}, row: { capped: cap }, words: ` · the order already at the broker asks ${s9(asked)}, less than the rule's ${s9(rule)}` };
  const base = dustBase(c, cnt, orders), dust = isDust(left, base);
  if (base > cnt) cap.dustBase = qn(base);
  if (!dust) { RUN.faults.push(`${c}: its close, already at the broker, is ${s9(left)} short of the count — more than dust`); process.exitCode = 1; }
  return { qty: qn(asked), pend: { close: { counted: qn(cnt), asked: qn(asked) } }, row: { capped: cap },
    words: ` · CLOSE: the order already at the broker asks ${s9(asked)} of the ${s9(cnt)} counted; the other ${s9(left)} ($${usd}) ${dust ? "is written off when it fills in full" : `is MORE THAN DUST (${dustOf(c, base, cnt)}) and stays counted`}` };
}
/**
 * (2) for ONE sell, start to finish -> what sellGuard returns. An order of this book ALREADY AT THE BROKER under today's id: freshCid found it
 * (fc.adopt) -> adopted whatever the account or another sleeve's file says now (adoptedSell). freshCid did not look (no ledger row names
 * today's id) and the guard is about to answer from what the ACCOUNT shows — no coin for this book, or part of the position held for an open
 * order: the broker is asked ONCE for today's id first, and an order found there (working, or ended with a fill) is adopted (fc.adopt is set,
 * so no POST follows). Not found, a lookup that fails, or an order that ended with no fill: the guard's answer stands. A sandbox never asks.
 */
async function sellAsk(c, counted, ruleQty, px, fc, cid, orders) {
  if (fc.adopt) return adoptedSell(c, counted, ruleQty, px, fc.adopt, orders);
  const G = sellGuard(c, counted, ruleQty, px, orders);
  if (!G.account) return G;
  let ex; try { ex = await api(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(cid)}`); } catch { return G; }
  if (!ex || !ex.id || (DONE.includes(ex.status) && !(Number(ex.filled_qty) > 0))) return G;
  fc.adopt = ex; return adoptedSell(c, counted, ruleQty, px, ex, orders);
}
/**
 * The end of a run: every sell that was due and did not go, and a close that did not end flat — LAST on stderr, exit 1. A CLOSE THAT FILLED AND
 * LEFT MORE THAN DUST COUNTED NEVER GOES QUIET: the fill's run notes it on the coin (`closeShort`), and every later run ends exit 1 with the coin
 * named for as long as the note is there and the coin is counted. It goes when the count comes to 0, or when a person has looked at the account
 * and put the count right (docs/r191-sell-repair/2026-10-14/NOTES.md). `s` = the state as this run leaves it.
 * ANOTHER SLEEVE'S FILE THAT CANNOT BE READ IS LOUD ON EVERY RUN THE ACCOUNT WAS READ, also when no sell was due (review 2026-10-15): exit 1, the
 * reason last on stderr — as a failed positions read is, so a broken file shows before the evening a sell depends on it.
 */
function finishRun(s) {
  for (const [c, st] of Object.entries((s && s.coins) || {})) {
    const n = st && st.closeShort;
    if (n && st.qty > 0 && !RUN.faults.some((f) => f.startsWith(`${c}: its close filled and `))) RUN.faults.push(`${c}: its close (${n.cid}, booked ${String(n.at).slice(0, 10)}) filled and left ${s9(nano(n.qty))} ${c} counted that the account did not have for this book — more than dust; ${s9(nano(st.qty))} is counted now. NOT CLEARED: a person has to look at the account and put the count right`);
  }
  const unread = RUN.hold ? others().notes : [];   // the reading of the other sleeves' files made AFTER the positions (a sandbox with no account fixture reads none: as before)
  if (!RUN.holdFail && !RUN.faults.length && !unread.length) return;
  process.exitCode = 1;
  console.error(`r191: ${RUN.holdFail ? `the account's positions could not be read (${RUN.holdErr || "unknown error"}) — NO SELL THIS RUN` : RUN.faults.length ? "a sell the rule called for did NOT go, or a close did not end flat" : "another sleeve's file cannot be read (no sell was due this run)"}${RUN.faults.length ? ` — ${RUN.faults.join(" | ")}` : unread.length ? ` — ${unread.join(" | ")}` : ""}`);
}
// ══ end of the R191-SELL-REPAIR helpers ══════════════════════════════════════════════════════════════════════════════════════════════════════
// A client id the ledger has seen but no fill was booked for is ASKED OF THE BROKER before a new one is chosen (review 2026-10-02): a POST that timed
// out may have created the order while its read-back also failed — that order is ADOPTED, never doubled under -2. A lookup error (not 404) sends nothing.
async function freshCid(s, base) {
  const used = new Set((s.orders || []).map((o) => o.cid)), mine = new Set(used); try { for (const l of fs.readFileSync(LEDGER, "utf8").split("\n")) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r.cid) used.add(r.cid); } catch {} } } catch {}
  for (let n = 1; ; n++) { const cid = n === 1 ? base : `${base}-${n}`; if (!used.has(cid)) return { cid }; if (mine.has(cid)) continue;   // mine = a fill already booked under that id
    let ex; try { ex = await api(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(cid)}`); } catch (e) { if (e.status === 404) continue; return { cid: null, error: String(e.message).slice(0, 120) }; }
    if (ex && ex.id && (!DONE.includes(ex.status) || Number(ex.filled_qty) > 0)) return { cid, adopt: ex };   // working, or ended with a fill: it IS today's order
  }
}
async function send(body) {
  try { return await api("/v2/orders", { method: "POST", body: JSON.stringify(body) }); }
  catch (e) { try { const ex = await api(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(body.client_order_id)}`); if (ex && ex.id) return ex; } catch {} ledger({ kind: "order-rejected", cid: body.client_order_id, side: body.side, error: String(e.message).slice(0, 160) }); process.exitCode = 1; return null; }
}
async function dailyCloses(coin) {   // completed UTC days only
  const end = new Date(); end.setUTCHours(0, 0, 0, 0); const start = new Date(end.getTime() - 120 * 864e5);
  if (SANDBOX && process.env.R191_BARS_FILE) return (JSON.parse(fs.readFileSync(process.env.R191_BARS_FILE, "utf8"))[coin] || []).filter((x) => x.d < end.toISOString().slice(0, 10)).sort((p, q) => (p.d < q.d ? -1 : 1));   // FORWARDREC 2026-10-05: sandbox fixture
  const r = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400&start=${start.toISOString()}&end=${end.toISOString()}`, { headers: { "User-Agent": "TRAIDS R191" } });
  const a = await r.json(); if (!Array.isArray(a)) throw new Error(`coinbase ${coin}`);
  return a.map((x) => ({ d: new Date(x[0] * 1000).toISOString().slice(0, 10), c: x[4] })).filter((x) => x.d < end.toISOString().slice(0, 10)).sort((p, q) => (p.d < q.d ? -1 : 1));
}
async function run() {
  const today = new Date().toISOString().slice(0, 10); if (today < START) return console.log(`r191: before the evidence start (${START})`);
  const s = load();
  // reconcile pending orders — PAPER-AUCTION-FIX 2026-10-02: from filled_qty / filled_avg_price, never from status alone: an order that ends
  // canceled / expired / done_for_day with filled_qty > 0 is a PARTIAL fill (a buy holds what filled; a sell leaves the rest held, sold next OUT run)
  for (const c of COINS) { const p = SANDBOX ? null : s.coins[c].pending; if (!p) continue; let o; try { o = await api(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(p.cid)}`); } catch (e) { if (e.status === 404) continue; throw e; }   // FORWARDREC 2026-10-05: a sandbox never asks the broker
    if (!DONE.includes(o.status)) continue;   // PAPER-AUCTION-FIX 2026-10-02: still working (new/accepted/partially_filled) — re-checked next run
    const q = Number(o.filled_qty) || 0, px = Number(o.filled_avg_price) || null;
    if (q > 0) { const before191 = s.coins[c].qty;   // R191-SELL-REPAIR 2026-10-14: the count before this fill
      if (p.side === "buy") { s.coins[c].qty = q; s.coins[c].held = true; s.coins[c].entry = px; } else { const left = +(s.coins[c].qty - q).toFixed(9); s.coins[c].qty = left > 0 ? left : 0; s.coins[c].held = left > 0; }   // (as it was: a buy counts filled_qty, a sell takes it off — corrected on the next line)
      const B191 = await booked(c, p, o, q, px, before191, s.coins[c].qty, s.orders); if (B191.qty !== s.coins[c].qty) { s.coins[c].qty = B191.qty; s.coins[c].held = B191.qty > 0; }   // R191-SELL-REPAIR 2026-10-14: (1) a buy counts what the account RECEIVED — filled_qty less the fee the broker reports for it (UNKNOWN: filled_qty is kept) · (3) a cut close that filled in full leaves the coin flat when the rest is dust
      if (B191.qty === 0) delete s.coins[c].closeShort; else if (B191.closeShort) s.coins[c].closeShort = B191.closeShort;   // R191-SELL-REPAIR 2026-10-14: a close that filled and left MORE THAN DUST counted is noted on the coin — every later run says it and ends exit 1 (finishRun) until the count is put right; a coin that comes to 0 carries no such note
      s.orders.push({ cid: p.cid, side: p.side, qty: q, px, at: o.filled_at, signalClose: p.signalClose, ...B191.order }); ledger({ kind: o.status === "filled" ? "filled" : "partial-filled", coin: c, ...p, qty: q, px, ...(o.status === "filled" ? {} : { status: o.status }), ...B191.row }); }   // R191-SELL-REPAIR 2026-10-14: the fee read (or that it is unknown), or what a cut close wrote off, on both records; otherwise nothing is added
    else ledger({ kind: "not-filled", coin: c, ...p, status: o.status });
    s.coins[c].pending = null; }
  // signals and orders   (as it was) — R191-SELL-REPAIR 2026-10-14 (2): first the account's positions, read ONCE before any order is decided; a sell asks for no more than they hold for this book (sellGuard)
  if (!SANDBOX) { try { await settleOthers(); } catch { RUN.asked = null; } }   // R191-SELL-REPAIR 2026-10-14 (review 1): another sleeve's order not booked in its own file yet is asked of the broker by its own client id BEFORE the positions are read; one that has ended is settled for this run (otherSleeves). A sandbox never asks
  try { RUN.hold = await accountHolds(); } catch (e) { RUN.holdFail = true; RUN.holdErr = String((e && e.message) || "").slice(0, 160) || "unknown error"; console.log(`  ACCOUNT · positions could not be read (${RUN.holdErr}) — NO SELL THIS RUN`); }
  RUN.others = null;   // R191-SELL-REPAIR 2026-10-14: the other sleeves' files are read AFTER the positions, never before. A buy booked above read them for its fee (booked); that reading is dropped here and the files are read again on the next line
  if (RUN.hold) for (const n of others().notes) console.log(`  ACCOUNT · ${n}`);
  for (const c of COINS) {
    const bars = await dailyCloses(c); if (bars.length < N) throw new Error(`${c}: only ${bars.length} completed closes`);
    const last = bars[bars.length - 1], sma = mean(bars.slice(-N).map((b) => b.c)), want = last.c > sma, st = s.coins[c];
    const line = `${c} close ${last.d} ${last.c} vs SMA${N} ${sma.toFixed(2)} -> ${want ? "IN" : "OUT"} (held ${st.held})`;
    if (st.pending) { console.log(`  ${line} · order pending`); continue; }
    if (want && !st.held) {
      if (fs.existsSync(OFF)) { console.log(`  ${line} · OFF switch — no buy`); continue; }
      const fc = await freshCid(s, `r191-${c}-${today.replace(/-/g, "")}-buy`), cid = fc.cid;   // PAPER-AUCTION-FIX 2026-10-02: never a client id already used; an order already at the broker under a used id is adopted (no second POST)
      if (!cid) { console.log(`  ${line} · client-id lookup failed (${fc.error}) — no order this run`); process.exitCode = 1; }   // PAPER-AUCTION-FIX 2026-10-02 (no continue: the day's mark below is still written)
      else if (LIVE && !fc.adopt && !(await send({ symbol: `${c}/USD`, notional: String(NOTIONAL), side: "buy", type: "market", time_in_force: "gtc", client_order_id: cid }))) console.log(`  ${line} · BUY REFUSED by the broker (ledger order-rejected)`);
      else { if (LIVE) { st.pending = { cid, side: "buy", signalClose: last.c, signalDay: last.d }; ledger({ kind: "sent", coin: c, cid, side: "buy", notional: NOTIONAL, signalClose: last.c, ...(fc.adopt ? { adopted: true, brokerStatus: fc.adopt.status } : {}) }); save(s); }   // PAPER-AUCTION-FIX 2026-10-02: saved at once — a later failure cannot lose a sent order
        console.log(`  ${line} · ${LIVE ? (fc.adopt ? "ADOPTED" : "SENT") : fc.adopt ? "DRY (would adopt the order already at the broker)" : "DRY"} BUY $${NOTIONAL}`); }
    } else if (!want && st.held && st.qty > 0) {
      const fc = await freshCid(s, `r191-${c}-${today.replace(/-/g, "")}-sell`), cid = fc.cid;   // PAPER-AUCTION-FIX 2026-10-02 · R191-SELL-REPAIR 2026-10-14 (2): what the sell may ask is decided on the next line
      const G = cid ? await sellAsk(c, st.qty, st.qty, last.c, fc, cid, s.orders) : null;   // R191-SELL-REPAIR 2026-10-14 (2): this rule sells the whole count; never more than the account has for THIS book — its position less what the other sleeves count in their own files. An order already at the broker under today's id is adopted, never re-sized: what it asked is its own quantity (sellAsk)
      if (!cid) { console.log(`  ${line} · client-id lookup failed (${fc.error}) — no order this run`); process.exitCode = 1; }   // PAPER-AUCTION-FIX 2026-10-02
      else if (G.no) { console.log(`  ${line} · NO SELL this run (the rule asks ${st.qty}) — ${G.no}`); if (LIVE || SANDBOX) ledger({ kind: "sell-not-sent", coin: c, side: "sell", ruleQty: st.qty, reason: G.no }); RUN.faults.push(RUN.holdFail ? `${c}: due, not asked` : `${c}: ${G.no}`); process.exitCode = 1; }   // R191-SELL-REPAIR 2026-10-14 (2): a sell that may not be asked is said, written down without a client id, and ends the run exit 1
      else if (LIVE && !fc.adopt && !(await send({ symbol: `${c}/USD`, qty: G.qty === st.qty ? String(st.qty) : s9(nano(G.qty)), side: "sell", type: "market", time_in_force: "gtc", client_order_id: cid }))) { console.log(`  ${line} · SELL REFUSED by the broker (ledger order-rejected)`); RUN.faults.push(`${c}: its sell of ${G.qty} was refused by the broker (ledger order-rejected)`); }   // R191-SELL-REPAIR 2026-10-14: a cut sell asks for what the account has for this book (9 decimals); an uncut one is the line as it was
      else { if (LIVE) { st.pending = { cid, side: "sell", signalClose: last.c, signalDay: last.d, ...G.pend }; ledger({ kind: "sent", coin: c, cid, side: "sell", qty: G.qty, signalClose: last.c, ...(fc.adopt ? { adopted: true, brokerStatus: fc.adopt.status } : {}), ...G.row }); save(s); }   // PAPER-AUCTION-FIX 2026-10-02 · R191-SELL-REPAIR 2026-10-14: a cut sell says so on its ledger row and its pending order; an uncut sell adds nothing
        console.log(`  ${line} · ${LIVE ? (fc.adopt ? "ADOPTED" : "SENT") : fc.adopt ? "DRY (would adopt the order already at the broker)" : "DRY"} SELL ${G.qty}${G.words}`); }   // R191-SELL-REPAIR 2026-10-14: a cut sell says what it was cut to, and why
    } else console.log(`  ${line} · no change`);
    // daily marks — FORWARDREC 2026-10-05 (FT-8): every completed UTC day since the coin's first mark gets exactly one row, not only the last one.
    // A missed day is marked at its own Coinbase daily close with the book this test held through it: no order is sent between runs, so that is
    // the book after this run's reconcile (days since the last mark), or the book the NEXT existing mark recorded (an older hole). A day with no
    // completed candle is a gap row (exit 1), never a quiet day; today's incomplete UTC day is never marked.
    const nextMark = (d) => pricedMarks(s.marks).filter((m) => m.coin === c && m.d > d).sort((p, q) => (p.d < q.d ? -1 : 1))[0];
    const add = catchUpRows({ marks: s.marks, coin: c, bars, today, markedOn: today, fieldsFor: (d, { isLast }) => {
      if (isLast) return { held: st.held, qty: st.qty };
      const nx = nextMark(d); return nx ? { held: nx.held, qty: nx.qty, stateFrom: nx.d } : { held: st.held, qty: st.qty, stateFrom: `run ${today}` }; } });
    s.marks.push(...add);
    if (add.length > 1 || add.some((r) => r.gap)) console.log(`  ${c} marks +${add.length}: ${add.map((r) => r.d + (r.gap ? " GAP" : r.catchUp ? " (catch-up)" : "")).join(", ")}`);
    if (add.some((r) => r.gap)) { console.log(`  ${c} GAP — a day with no completed Coinbase candle is recorded as a gap, not a mark`); process.exitCode = 1; }
  }
  if (LIVE || SANDBOX) save(s); else console.log("  (dry run — state not saved)");   // FORWARDREC 2026-10-05: a sandbox saves its copy · (as it was)
  finishRun(s);   // R191-SELL-REPAIR 2026-10-14: every sell that was due and did not go, and a close that did not end flat (the evening it filled and every evening after, from the note on the coin) — LAST on stderr, exit 1
}
function status() {
  const s = load(), gaps = s.marks.length - pricedMarks(s.marks).length; s.marks = pricedMarks(s.marks);   // FORWARDREC 2026-10-05: gap rows carry no close and never count as marked days
  const days = [...new Set(s.marks.map((m) => m.d))].sort();
  console.log(`R191 — ${days.length} marked days since ${days[0] || "—"}${gaps ? ` (+${gaps} gap row${gaps === 1 ? "" : "s"})` : ""} · ${COINS.map((c) => `${c} ${s.coins[c].held ? "IN " + s.coins[c].qty : "OUT"}`).join(" · ")} · ${s.orders.length} fills`);
  return { s, days };
}
async function read() {
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")), T = seals.tests || seals; if (T.R191) return console.error("R191 already sealed — refusing");
  const { s, days } = status(); if (days.length < 365) return console.error(`R191 read condition not met (${days.length}/365 days)`);
  // strategy vs buy-and-hold from the daily marks: a coin's strategy return on day d = held on d-1 ? close(d)/close(d-1)-1 : 0 (fills' slippage reported separately)
  const by = {}; for (const m of s.marks) (by[m.coin] = by[m.coin] || []).push(m); const port = [], bench = [];
  for (let i = 1; i < days.length; i++) { const r = [], b = []; for (const c of COINS) { const a = by[c], p = a.find((x) => x.d === days[i - 1]), q = a.find((x) => x.d === days[i]); if (!p || !q) continue; const ret = q.close / p.close - 1; r.push(p.held ? ret : 0); b.push(ret); } if (r.length) { port.push(mean(r)); bench.push(mean(b)); } }
  const mr = mean(port), mb = mean(bench); let cv = 0, vb = 0; for (let i = 0; i < port.length; i++) { cv += (port[i] - mr) * (bench[i] - mb); vb += (bench[i] - mb) ** 2; } const beta = cv / vb, res = port.map((x, i) => x - beta * bench[i]);
  const nw = (a, L = 5) => { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((q, x) => q + x * x, 0) / n; for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * g / n; } return m / Math.sqrt(v / n); };
  const dd = (a) => { let e = 1, pk = 1, x = 0; for (const r of a) { e *= 1 + r; pk = Math.max(pk, e); x = Math.min(x, e / pk - 1); } return x; };
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((x) => x.id === "R191"), t = nw(res), cut = (dd(port) - dd(bench)) * 100;
  const verdict = t >= E.bar.tRequired && cut >= 15 ? `PASS — alpha t ${t.toFixed(3)}, drawdown cut ${cut.toFixed(1)} pts` : `DID NOT PASS — alpha t ${t.toFixed(3)} vs ${E.bar.tRequired}; drawdown cut ${cut.toFixed(1)} pts`;
  T.R191 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "days", verdict }; writeJsonAtomic(D("read-seals.json"), seals);
  E.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R191", verdict }) + "\n"); console.log(`R191 READ — ${verdict}`);
}
(async () => { if (mode === "--run") return run(); if (mode === "--read") return read(); status(); })().catch((e) => { console.error("r191 FAILED:", e.message); process.exit(1); });
