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
const DONE = ["filled", "canceled", "expired", "rejected", "done_for_day"];
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
    if (q > 0) { if (p.side === "buy") { s.coins[c].qty = q; s.coins[c].held = true; s.coins[c].entry = px; } else { const left = +(s.coins[c].qty - q).toFixed(9); s.coins[c].qty = left > 0 ? left : 0; s.coins[c].held = left > 0; }
      s.orders.push({ cid: p.cid, side: p.side, qty: q, px, at: o.filled_at, signalClose: p.signalClose }); ledger({ kind: o.status === "filled" ? "filled" : "partial-filled", coin: c, ...p, qty: q, px, ...(o.status === "filled" ? {} : { status: o.status }) }); }
    else ledger({ kind: "not-filled", coin: c, ...p, status: o.status });
    s.coins[c].pending = null; }
  // signals and orders
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
      const fc = await freshCid(s, `r191-${c}-${today.replace(/-/g, "")}-sell`), cid = fc.cid;   // PAPER-AUCTION-FIX 2026-10-02
      if (!cid) { console.log(`  ${line} · client-id lookup failed (${fc.error}) — no order this run`); process.exitCode = 1; }   // PAPER-AUCTION-FIX 2026-10-02
      else if (LIVE && !fc.adopt && !(await send({ symbol: `${c}/USD`, qty: String(st.qty), side: "sell", type: "market", time_in_force: "gtc", client_order_id: cid }))) console.log(`  ${line} · SELL REFUSED by the broker (ledger order-rejected)`);
      else { if (LIVE) { st.pending = { cid, side: "sell", signalClose: last.c, signalDay: last.d }; ledger({ kind: "sent", coin: c, cid, side: "sell", qty: st.qty, signalClose: last.c, ...(fc.adopt ? { adopted: true, brokerStatus: fc.adopt.status } : {}) }); save(s); }   // PAPER-AUCTION-FIX 2026-10-02
        console.log(`  ${line} · ${LIVE ? (fc.adopt ? "ADOPTED" : "SENT") : fc.adopt ? "DRY (would adopt the order already at the broker)" : "DRY"} SELL ${st.qty}`); }
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
  if (LIVE || SANDBOX) save(s); else console.log("  (dry run — state not saved)");   // FORWARDREC 2026-10-05: a sandbox saves its copy
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
