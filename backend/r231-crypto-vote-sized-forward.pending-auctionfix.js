#!/usr/bin/env node
/**
 * R231 — CRYPTO MULTI-LOOKBACK VOTE + VOL-TARGETED SIZING, FORWARD on the Alpaca PAPER account
 * (registered 2026-09-24; rule frozen in the registry — see r230-register.js). Same rule as R230's
 * historical holdout, which DID NOT PASS (alpha t 0.281 vs bar 1.639) and was BEATEN by R191's
 * simpler plain-50-day rule head-to-head in that holdout (Sharpe 0.75 vs 0.04). Deployed forward
 * anyway, same precedent as R191 itself (R190 DID NOT PASS, R191 still runs, disclosed as a
 * drawdown-only product with no alpha claim) — this one carries a STRONGER disclosed weakness
 * (it lost a direct comparison to R191, not just its own bar) and is not a funding candidate.
 *   node backend/r231-crypto-vote-sized-forward.js --run [--live]   decide + (live) send paper orders + reconcile + mark
 *   node backend/r231-crypto-vote-sized-forward.js --status | --read
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), STATE = D("r231-crypto-vote-sized.json"), LEDGER = D("r231-crypto-vote-sized.jsonl"), OFF = D("r231-OFF");
const BASE = "https://paper-api.alpaca.markets";
const UNIVERSE = ["BTC", "ETH", "LTC", "BCH", "LINK", "ADA", "SOL", "DOGE", "AVAX", "DOT", "UNI", "AAVE", "XTZ"];
const NS = [50, 100, 200], VOLLOOK = 20, VOLTARGET = 0.30, TOTAL_NOTIONAL = 20000, REBAL_THRESH = 200, START = "2026-09-25";
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, "content-type": "application/json" };
const LIVE = process.argv.includes("--live"), mode = ["--run", "--status", "--read"].find((m) => process.argv.includes(m)) || "--status";
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const api = async (p, init) => { if (!/paper-api/.test(BASE)) throw new Error("not the paper endpoint"); const r = await fetch(BASE + p, { headers: H, ...init }); const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(`${r.status} ${JSON.stringify(j).slice(0, 160)}`); e.status = r.status; throw e; } return j; };
const load = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { spec: "r231-state-v1", coins: Object.fromEntries(UNIVERSE.map((c) => [c, { qty: 0, notional: 0, pending: null }])), marks: [], orders: [] });
const save = (s) => { s.asOf = new Date().toISOString(); writeJsonAtomic(STATE, s); };
const ledger = (o) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
// PAPER-AUCTION-FIX 2026-10-02 (partial-fill audit, operator "yes"): terminal broker statuses; quantities kept at the broker's 9 decimals; a client
// id is never re-used (Alpaca refuses it — a same-day re-send gets -2, -3); a failed POST is read back by client id and the order adopted if it
// exists, else recorded and skipped (one refused order no longer aborts the run and loses the orders already sent).
const DONE = ["filled", "canceled", "expired", "rejected", "done_for_day"];
const q9 = (x) => +(+x).toFixed(9);
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

async function dailyCloses(coin) {   // completed UTC days only, ~280 back for SMA200 + 20d vol buffer
  const end = new Date(); end.setUTCHours(0, 0, 0, 0); const start = new Date(end.getTime() - 300 * 864e5);
  const r = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400&start=${start.toISOString()}&end=${end.toISOString()}`, { headers: { "User-Agent": "TRAIDS R231" } });
  const a = await r.json(); if (!Array.isArray(a)) throw new Error(`coinbase ${coin}`);
  return a.map((x) => ({ d: new Date(x[0] * 1000).toISOString().slice(0, 10), c: x[4] })).filter((x) => x.d < end.toISOString().slice(0, 10)).sort((p, q) => (p.d < q.d ? -1 : 1));
}
function voteOn(rows) {
  const i = rows.length - 1; if (i < NS[NS.length - 1]) return false;
  let votes = 0; for (const N of NS) { let s = 0; for (let k = i - N + 1; k <= i; k++) s += rows[k].c; if (rows[i].c > s / N) votes++; }
  return votes >= 2;
}
function vol20(rows) {
  const i = rows.length - 1; if (i < VOLLOOK) return null;
  const rets = []; for (let k = i - VOLLOOK + 1; k <= i; k++) rets.push(Math.log(rows[k].c / rows[k - 1].c));
  return std(rets) * Math.sqrt(365);
}
function portfolioVolAt(eligible, w, seriesByCoin) {   // as-if trailing-20d portfolio return series at today's weights w
  if (!eligible.length) return null;
  const dailyRets = [];
  for (let o = 1; o <= VOLLOOK; o++) {
    let r = 0, ok = true;
    for (const c of eligible) {
      const rows = seriesByCoin[c], i = rows.length - 1, iEnd = i - o + 1, iStart = i - o;
      if (iStart < 0) { ok = false; break; }
      r += w[c] * (rows[iEnd].c / rows[iStart].c - 1);
    }
    if (!ok) return null;
    dailyRets.push(r);
  }
  return std(dailyRets) * Math.sqrt(365);
}

async function run() {
  const today = new Date().toISOString().slice(0, 10); if (today < START) return console.log(`r231: before the evidence start (${START})`);
  const s = load();
  // reconcile pending orders
  for (const c of UNIVERSE) { const p = s.coins[c].pending; if (!p) continue; let o; try { o = await api(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(p.cid)}`); } catch (e) { if (e.status === 404) continue; throw e; }
    // PAPER-AUCTION-FIX 2026-10-02: from filled_qty / filled_avg_price, never from status alone — canceled / expired / done_for_day with
    // filled_qty > 0 is a PARTIAL fill and moves the held quantity by what filled; an order still working is re-checked next run
    if (!DONE.includes(o.status)) continue;
    const q = Number(o.filled_qty) || 0, px = Number(o.filled_avg_price) || null;
    if (q > 0) {
      s.coins[c].qty = p.side === "buy" ? q9(s.coins[c].qty + q) : Math.max(0, q9(s.coins[c].qty - q));
      s.coins[c].notional = s.coins[c].qty * px; // re-marked properly on next signal pass
      s.orders.push({ cid: p.cid, side: p.side, qty: q, px, at: o.filled_at }); ledger({ kind: o.status === "filled" ? "filled" : "partial-filled", coin: c, ...p, qty: q, px, ...(o.status === "filled" ? {} : { status: o.status }) }); }
    else ledger({ kind: "not-filled", coin: c, ...p, status: o.status });
    s.coins[c].pending = null; }

  // fetch all series once
  const seriesByCoin = {}; for (const c of UNIVERSE) { const rows = await dailyCloses(c); if (rows.length < NS[NS.length - 1] + VOLLOOK) { console.log(`  ${c}: only ${rows.length} completed closes, skipping`); continue; } seriesByCoin[c] = rows; }

  // signal + sizing
  const eligible = [], raw = {};
  for (const [c, rows] of Object.entries(seriesByCoin)) { if (voteOn(rows)) { const v = vol20(rows); if (v && v > 0) { eligible.push(c); raw[c] = 1 / v; } } }
  const sumRaw = eligible.reduce((sum, c) => sum + raw[c], 0);
  const w = {}; for (const c of eligible) w[c] = sumRaw ? raw[c] / sumRaw : 0;
  const portVol = portfolioVolAt(eligible, w, seriesByCoin);
  const k = portVol && portVol > 0 ? Math.min(1, VOLTARGET / portVol) : (eligible.length ? 1 : 0);

  console.log(`  signal: ${eligible.length ? eligible.map((c) => `${c}(w${(w[c] * 100).toFixed(0)}%)`).join(" ") : "none eligible"} · k=${k.toFixed(3)}`);

  for (const c of UNIVERSE) {
    const rows = seriesByCoin[c]; if (!rows) continue;
    const last = rows[rows.length - 1], st = s.coins[c];
    const targetNotional = eligible.includes(c) ? TOTAL_NOTIONAL * k * w[c] : 0;
    const currentNotional = st.qty * last.c;
    const delta = targetNotional - currentNotional;
    if (st.pending) { console.log(`  ${c} close ${last.d} ${last.c} target $${targetNotional.toFixed(0)} current $${currentNotional.toFixed(0)} · order pending`); continue; }
    if (Math.abs(delta) < REBAL_THRESH) { console.log(`  ${c} close ${last.d} ${last.c} target $${targetNotional.toFixed(0)} current $${currentNotional.toFixed(0)} · no change`); continue; }
    const side = delta > 0 ? "buy" : "sell";
    if (fs.existsSync(OFF)) { console.log(`  ${c} · OFF switch — no order`); continue; }
    const fc = await freshCid(s, `r231-${c}-${today.replace(/-/g, "")}-${side}`), cid = fc.cid;   // PAPER-AUCTION-FIX 2026-10-02: never a client id already used; an order already at the broker under a used id is adopted (no second POST)
    if (!cid) { console.log(`  ${c} · client-id lookup failed (${fc.error}) — no order this run`); process.exitCode = 1; continue; }   // PAPER-AUCTION-FIX 2026-10-02 (the coin is still marked below)
    if (side === "buy") {
      if (LIVE && !fc.adopt && !(await send({ symbol: `${c}/USD`, notional: String(Math.abs(delta).toFixed(2)), side: "buy", type: "market", time_in_force: "gtc", client_order_id: cid }))) console.log(`  ${c} · BUY REFUSED by the broker (ledger order-rejected)`);
      else { if (LIVE) { st.pending = { cid, side: "buy", signalClose: last.c }; ledger({ kind: "sent", coin: c, cid, side: "buy", notional: Math.abs(delta), targetNotional, k, w: w[c] || 0, ...(fc.adopt ? { adopted: true, brokerStatus: fc.adopt.status } : {}) }); save(s); }   // PAPER-AUCTION-FIX 2026-10-02: saved at once
        console.log(`  ${c} · ${LIVE ? (fc.adopt ? "ADOPTED" : "SENT") : fc.adopt ? "DRY (would adopt the order already at the broker)" : "DRY"} BUY $${Math.abs(delta).toFixed(0)} (target $${targetNotional.toFixed(0)})`); }
    } else {
      const sellQty = Math.min(q9(st.qty), q9(Math.abs(delta) / last.c));   // PAPER-AUCTION-FIX 2026-10-02: the broker's 9 decimals (float noise sent 13), never more than held
      if (sellQty <= 0) { console.log(`  ${c} · nothing to sell`); continue; }
      if (LIVE && !fc.adopt && !(await send({ symbol: `${c}/USD`, qty: sellQty.toFixed(9), side: "sell", type: "market", time_in_force: "gtc", client_order_id: cid }))) console.log(`  ${c} · SELL REFUSED by the broker (ledger order-rejected)`);
      else { if (LIVE) { st.pending = { cid, side: "sell", signalClose: last.c }; ledger({ kind: "sent", coin: c, cid, side: "sell", qty: sellQty, targetNotional, k, w: w[c] || 0, ...(fc.adopt ? { adopted: true, brokerStatus: fc.adopt.status } : {}) }); save(s); }   // PAPER-AUCTION-FIX 2026-10-02
        console.log(`  ${c} · ${LIVE ? (fc.adopt ? "ADOPTED" : "SENT") : fc.adopt ? "DRY (would adopt the order already at the broker)" : "DRY"} SELL ${sellQty.toFixed(6)} (target $${targetNotional.toFixed(0)})`); }
    }
    if (!s.marks.some((m) => m.coin === c && m.d === last.d)) s.marks.push({ coin: c, d: last.d, close: last.c, eligible: eligible.includes(c), w: w[c] || 0, k });
  }
  // mark coins with no order this pass too (needed for --read return series)
  for (const c of UNIVERSE) { const rows = seriesByCoin[c]; if (!rows) continue; const last = rows[rows.length - 1]; if (!s.marks.some((m) => m.coin === c && m.d === last.d)) s.marks.push({ coin: c, d: last.d, close: last.c, eligible: eligible.includes(c), w: w[c] || 0, k }); }

  if (LIVE) save(s); else console.log("  (dry run — state not saved)");
}
function status() {
  const s = load(), days = [...new Set(s.marks.map((m) => m.d))].sort();
  const held = UNIVERSE.filter((c) => s.coins[c].qty > 0);
  console.log(`R231 — ${days.length} marked days since ${days[0] || "—"} · held: ${held.length ? held.join(",") : "none"} · ${s.orders.length} fills`);
  return { s, days };
}
async function read() {
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")), T = seals.tests || seals; if (T.R231) return console.error("R231 already sealed — refusing");
  const { s, days } = status(); if (days.length < 365) return console.error(`R231 read condition not met (${days.length}/365 days)`);
  const by = {}; for (const m of s.marks) (by[m.coin] = by[m.coin] || []).push(m);
  const port = [], bench = [];
  for (let i = 1; i < days.length; i++) {
    let r = 0, benchR = [];
    for (const c of UNIVERSE) { const a = by[c]; if (!a) continue; const p = a.find((x) => x.d === days[i - 1]), q = a.find((x) => x.d === days[i]); if (!p || !q) continue;
      const ret = q.close / p.close - 1; benchR.push(ret); if (p.eligible) r += (p.k || 0) * (p.w || 0) * ret; }
    port.push(r); const btc = by.BTC && by.BTC.find((x) => x.d === days[i - 1]) && by.BTC.find((x) => x.d === days[i]); bench.push(btc ? by.BTC.find((x) => x.d === days[i]).close / by.BTC.find((x) => x.d === days[i - 1]).close - 1 : mean(benchR));
  }
  const mr = mean(port), mb = mean(bench); let cv = 0, vb = 0; for (let i = 0; i < port.length; i++) { cv += (port[i] - mr) * (bench[i] - mb); vb += (bench[i] - mb) ** 2; } const beta = vb ? cv / vb : 0, res = port.map((x, i) => x - beta * bench[i]);
  const nw = (a, L = 5) => { const n = a.length, m = mean(a), d = a.map((x) => x - m); let v = d.reduce((q, x) => q + x * x, 0) / n; for (let l = 1; l <= L; l++) { let g = 0; for (let i = l; i < n; i++) g += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * g / n; } return m / Math.sqrt(v / n); };
  const dd = (a) => { let e = 1, pk = 1, x = 0; for (const r of a) { e *= 1 + r; pk = Math.max(pk, e); x = Math.min(x, e / pk - 1); } return x; };
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((x) => x.id === "R231"), t = nw(res), cut = (dd(bench) - dd(port)) * 100;
  const verdict = t >= E.bar.tRequired && cut >= 15 ? `PASS — alpha t ${t.toFixed(3)}, drawdown cut ${cut.toFixed(1)} pts` : `DID NOT PASS — alpha t ${t.toFixed(3)} vs ${E.bar.tRequired}; drawdown cut ${cut.toFixed(1)} pts`;
  T.R231 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "days", verdict }; writeJsonAtomic(D("read-seals.json"), seals);
  E.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R231", verdict }) + "\n"); console.log(`R231 READ — ${verdict}`);
}
(async () => { if (mode === "--run") return run(); if (mode === "--read") return read(); status(); })().catch((e) => { console.error("r231 FAILED:", e.message); process.exit(1); });
