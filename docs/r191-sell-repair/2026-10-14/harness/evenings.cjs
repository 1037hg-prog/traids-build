"use strict";
/**
 * THE REAL EVENINGS (r191-sell-repair package; review of 2026-10-15, findings 1 to 3) — a close-chain evening rebuilt AS IT STOOD WHEN R191'S
 * RUNNER RAN, from the frozen recorded files only (harness/recorded/, made by make-fixtures.cjs from the real files, read-only). Pure: it reads
 * nothing itself; `REC` is fixtures.cjs recorded().
 *
 *   T        the moment R191's run started that evening: 2 s before the first record of that UTC day made by R191 (its ledger rows, the broker's
 *            fill of an order it sent) or by R231 (its ledger rows and fills: R231 runs right after R191 in the close chain); 20:30:00Z when
 *            neither left any record that day
 *   R191     its state file then: its own ledger rows before T replayed the way its runner books them — a 'sent' row is the pending order; a
 *            'filled' row moves the count, held and entry as the runner does and adds the order row exactly as the state file holds it — and the
 *            mark rows written before that evening (a mark is written on its markedOn day, else on the day after its own day)
 *   R231     its state file then: every coin's count from R231's OWN order rows booked before T (its ledger's 'filled' row is the booking), each buy
 *            at its `net` (what the account received for it: R231 counts net since its restate of 2026-10-13; counted the same way on every
 *            evening, so the account below holds exactly what it counts), each sell at its qty; an order its ledger shows sent before T and not yet
 *            booked is its PENDING order — the order the review's findings 1 and 2 are about
 *   mirror   the rows of the board mirror's two files written before T
 *   orders   the orders the broker held for every pending order of R191 and R231: FILLED as their own state files record the fill (filled_qty,
 *            filled_avg_price, filled_at) when it filled before T, else still working (accepted, nothing filled)
 *   account  a MODEL of the paper account at T: what each sleeve's own records say it received by then — R191: each buy less the fee the broker's
 *            own rows charged it (`fees`, check 6 reads them), each sell off; R231: each buy's net, each sell off; the mirror: its open tickets —
 *            so the account holds for R191 exactly what R191 received, and for every other sleeve exactly what that sleeve counts
 *   wrote    what R191 REALLY wrote that evening: its ledger rows from T on that day, and the mark rows written that day — a replay of today's
 *            runner on these inputs must write the same (the selftest checks it), which is what makes the rebuild a replay
 */
const NANO = 1e9, nano = (x) => Math.round(Number(x) * NANO), s9 = (n) => (n / NANO).toFixed(9), qn = (n) => +s9(n);
const DAY = 864e5, addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const jsonl = (t) => String(t || "").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const COINS = ["BTC", "ETH"], coinOf = (sym) => { const m = /^([A-Z0-9]+)\/?USD$/.exec(String(sym || "")); return m ? m[1] : null; };
const cidCoin = (re, cid) => { const m = re.exec(String(cid || "")); return m ? m[1] : null; };
const R191_RE = /^r191-([A-Z0-9]+)-/, R231_RE = /^r231-([A-Z0-9]+)-/;

/** the moment R191's run started on UTC day `d` (an ISO instant). Only records from 18:00Z on count: the close chain runs from 14:15 MT (20:15Z);
 *  a record earlier that UTC day belongs to the night before (R231's restate of 2026-10-12 MT was written at 2026-10-13T03:35Z) */
function runTime(REC, d) {
  const s191 = JSON.parse(REC.r191Raw), s231 = JSON.parse(REC.r231Raw);
  const t = [...jsonl(REC.r191LedgerRaw).map((r) => r.ts), ...s191.orders.map((o) => o.at), ...jsonl(REC.r231LedgerRaw).map((r) => r.ts), ...s231.orders.map((o) => o.at)]
    .filter((x) => typeof x === "string" && x.slice(0, 10) === d && x.slice(11, 13) >= "18").map((x) => Date.parse(x)).filter(Number.isFinite);
  return t.length ? new Date(Math.min(...t) - 2000).toISOString() : `${d}T20:30:00.000Z`;
}
/** R191's state file at instant T (ms), rebuilt from its own ledger and the order and mark rows of the frozen state */
function r191At(REC, T, day) {
  const S = JSON.parse(REC.r191Raw), rows = jsonl(REC.r191LedgerRaw), coins = Object.fromEntries(COINS.map((c) => [c, { qty: 0, held: false, pending: null }])), orders = [];
  for (const r of rows) {
    if (!(Date.parse(r.ts) < T)) continue;
    if (r.kind === "sent") { const f = rows.find((x) => x.kind === "filled" && x.cid === r.cid); coins[r.coin].pending = { cid: r.cid, side: r.side, signalClose: r.signalClose, signalDay: f ? f.signalDay : addDays(r.ts.slice(0, 10), -1) }; continue; }
    if (r.kind !== "filled") throw new Error(`R191's ledger row ${r.kind} is not one this rebuild knows`);
    const st = coins[r.coin], o = S.orders.find((x) => x.cid === r.cid); if (!o) throw new Error(`R191's state has no order row for ${r.cid}`);
    if (r.side === "buy") { st.qty = r.qty; st.held = true; st.entry = r.px; } else { const left = +(st.qty - r.qty).toFixed(9); st.qty = left > 0 ? left : 0; st.held = left > 0; }
    st.pending = null; orders.push({ ...o });
  }
  const writtenOn = (m) => m.markedOn || addDays(m.d, 1);
  return { spec: "r191-state-v1", coins, marks: S.marks.filter((m) => writtenOn(m) < day).map((m) => ({ ...m })), orders };
}
/** R231's state file at instant T (ms): counts from its own order rows booked before T (buys at net), its pending orders */
function r231At(REC, T) {
  const S = JSON.parse(REC.r231Raw), rows = jsonl(REC.r231LedgerRaw), booked = new Map(rows.filter((r) => r.kind === "filled").map((r) => [r.cid, r]));
  const n = Object.fromEntries(Object.keys(S.coins).map((c) => [c, 0])), pending = {}, orders = [];
  for (const o of S.orders) {
    const b = booked.get(o.cid); if (!b) throw new Error(`R231's ledger has no 'filled' row for ${o.cid}`);
    if (!(Date.parse(b.ts) < T)) continue;
    const c = cidCoin(R231_RE, o.cid); if (!(c in n)) throw new Error(`R231's order ${o.cid} is not of a coin of its file`);
    if (o.side === "buy") { if (typeof o.net !== "number") throw new Error(`R231's buy ${o.cid} carries no net`); n[c] += nano(o.net); } else n[c] -= nano(o.qty);
    orders.push({ ...o });
  }
  for (const r of rows) if (r.kind === "sent" && Date.parse(r.ts) < T) { const b = booked.get(r.cid); if (!b || !(Date.parse(b.ts) < T)) pending[r.coin] = { cid: r.cid, side: r.side, signalClose: b ? b.signalClose : null }; }
  for (const [c, q] of Object.entries(n)) if (q < 0) throw new Error(`R231's ${c} comes to less than nothing at ${new Date(T).toISOString()}`);
  return { spec: "r231-state-v1", coins: Object.fromEntries(Object.keys(S.coins).map((c) => [c, { qty: qn(n[c]), notional: 0, pending: pending[c] || null }])), marks: [], orders };
}
/** the board mirror's two files at instant T (ms): their rows written before it, each line as it is */
function mirrorAt(REC, T) {
  const keep = (raw) => { const k = String(raw).split("\n").filter((l) => l.trim() && Date.parse(JSON.parse(l).ts) < T); return k.join("\n") + (k.length ? "\n" : ""); };
  return { entries: keep(REC.mirrorRaw), exits: keep(REC.mirrorExitsRaw) };
}
/** what the broker held for each order pending at T: filled as the sleeve's own state records it when it filled before T, else still working */
function brokerOrder(o, coin, T) {
  const base = { id: "held-" + o.cid, client_order_id: o.cid, symbol: `${coin}/USD`, side: o.side, type: "market", time_in_force: "gtc", qty: o.side === "sell" ? String(o.qty) : null, notional: null };
  return Date.parse(o.at) < T ? { ...base, status: "filled", filled_qty: s9(nano(o.qty)), filled_avg_price: String(o.px), filled_at: o.at } : { ...base, status: "accepted", filled_qty: "0", filled_avg_price: null, filled_at: null };
}
/**
 * One evening -> { day, T, now, r191, r191LedgerRaw, r231, mirror, orders, account, pendingR231, wrote: { rows, marks } }.
 * `fees` = { "<R191 buy cid>": "fee in the coin" } — the broker's own rows' answer for each of R191's buys (an R191 buy with no fee here throws).
 */
function evening(REC, day, fees) {
  const now = runTime(REC, day), T = Date.parse(now), S191 = JSON.parse(REC.r191Raw), S231 = JSON.parse(REC.r231Raw);
  const r191 = r191At(REC, T, day), r231 = r231At(REC, T), mirror = mirrorAt(REC, T);
  const r191LedgerRaw = REC.r191LedgerRaw.split("\n").filter((l) => l.trim() && Date.parse(JSON.parse(l).ts) < T).map((l) => l + "\n").join("");
  // the broker's orders: every order pending in either sleeve's file at T
  const orders = [];
  for (const c of COINS) { const p = r191.coins[c].pending; if (p) { const o = S191.orders.find((x) => x.cid === p.cid); if (o) orders.push(brokerOrder(o, c, T)); } }
  const pendingR231 = Object.entries(r231.coins).filter(([, v]) => v.pending).map(([c, v]) => ({ coin: c, ...v.pending }));
  for (const p of pendingR231) { const o = S231.orders.find((x) => x.cid === p.cid); if (o) orders.push(brokerOrder(o, p.coin, T)); }
  // the account model at T
  const acct = Object.fromEntries(COINS.map((c) => [c, 0]));
  for (const o of S191.orders) { const c = cidCoin(R191_RE, o.cid); if (!(c in acct) || !(Date.parse(o.at) < T)) continue; if (o.side === "buy") { if (fees[o.cid] == null) throw new Error(`no broker fee given for ${o.cid}`); acct[c] += nano(o.qty) - nano(fees[o.cid]); } else acct[c] -= nano(o.qty); }
  for (const o of S231.orders) { const c = cidCoin(R231_RE, o.cid); if (!(c in acct) || !(Date.parse(o.at) < T)) continue; acct[c] += o.side === "buy" ? nano(o.net) : -nano(o.qty); }
  { const fin = new Set(), rowsX = jsonl(mirror.exits); for (const x of rowsX) if (x.final) fin.add(x.ticketId);
    for (const r of jsonl(mirror.entries)) { const c = coinOf(r.sym); if (r.cls === "Crypto" && r.orderId && r.live && r.side === "buy" && c in acct && !fin.has(r.ticketId)) acct[c] += Math.ceil(Number(r.qty) * NANO - 1e-6); } }
  for (const [c, q] of Object.entries(acct)) if (q < 0) throw new Error(`the account model holds less than nothing of ${c} at ${now}`);
  const account = Object.fromEntries(Object.entries(acct).map(([c, q]) => [c, s9(q)]));
  // what R191 really wrote that evening
  const rows = jsonl(REC.r191LedgerRaw).filter((r) => r.ts.slice(0, 10) === day && Date.parse(r.ts) >= T), marks = S191.marks.filter((m) => (m.markedOn || addDays(m.d, 1)) === day);
  return { day, T, now, r191, r191LedgerRaw, r231, mirror, orders, account, pendingR231, wrote: { rows, marks } };
}
module.exports = { runTime, r191At, r231At, mirrorAt, brokerOrder, evening, addDays, nano, s9, qn };
