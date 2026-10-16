#!/usr/bin/env node
/**
 * PAYNE PICKS — forward record (R159, 2026-09-23, operator: "measure paynes picks forward").
 *
 * Every Payne's Education pick is logged the moment it reaches us, and mirrored on the Alpaca PAPER account at the first price we could
 * actually get — NOT the stated entry price in their alert or their later tables (that price is recorded beside ours). Exits follow
 * their exit alerts the same way. Each pick is compared with SPY (primary) and SMH (the sector they favour) over the same days.
 * The paper orders double as the "six paper trades with statements" their refund rule asks for (Alpaca order history is the statement).
 *
 *   node backend/payne-picks.js --add --sym NVDA --action buy  --stated 212.17 --raw "<alert text as received>" [--alert-time ISO] [--live]
 *   node backend/payne-picks.js --add --sym NVDA --action sell --stated 230.00 --raw "<exit alert>"            [--alert-time ISO] [--live]
 *   node backend/payne-picks.js --reconcile   (pull broker fills, mark open picks, benchmark closed ones; an owed exit is only listed, exit 1)
 *   node backend/payne-picks.js --reconcile --live   (PAPER-AUCTION-FIX 2026-10-02 — the close-chain step: also re-sends an exit the broker did not fully fill, new client id)
 *   node backend/payne-picks.js --status      (the table, in their format, with our fills beside their prices)
 *   node backend/payne-picks.js --read        (R159's read: refuses before 30 closed picks)
 * Without --live an --add is logged and the order is printed, not sent. Paper endpoint only; OFF switch data/payne-picks-OFF.
 * receivedAt is the machine clock when the pick is logged; --alert-time records the alert's own timestamp for comparison only.
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f), STATE = D("payne-picks-state.json"), LEDGER = D("payne-picks-ledger.jsonl"), OFF = D("payne-picks-OFF");
const BASE = "https://paper-api.alpaca.markets", NOTIONAL = 1000, MIN_CLOSED = 30;
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, "content-type": "application/json" };
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; }, has = (k) => process.argv.includes(k), LIVE = has("--live");
const api = async (p, init) => { if (!/paper-api/.test(BASE)) throw new Error("not the paper endpoint"); const r = await fetch(BASE + p, { headers: H, ...init }); const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(`${r.status} ${JSON.stringify(j).slice(0, 160)}`); e.status = r.status; throw e; } return j; };
const load = () => fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { spec: "payne-picks-v1", picks: [] };
const ledger = (o) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
const lastPrice = async (sym) => { const r = await fetch(`https://data.alpaca.markets/v2/stocks/${sym}/trades/latest?feed=iex`, { headers: H }); const j = await r.json(); return j.trade ? j.trade.p : null; };
// PAPER-AUCTION-FIX 2026-10-02 (partial-fill audit, operator "yes"): broker statuses that end an order; shares sold so far from recorded exit fills;
// a failed POST is read back by client id and adopted; an owed exit remainder is re-sent under a new client id.
const DONE = ["filled", "canceled", "expired", "rejected", "done_for_day"];
const soldQty = (p) => (p.exitFills || []).reduce((a, f) => a + f.qty, 0);
const adopt = async (cid) => { try { const o = await api(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(cid)}`); return o && o.id ? o : null; } catch { return null; } };
async function resendExit(p) {
  const rem = p.qty - soldQty(p), tries = p.exitCids || (p.exitCid ? [p.exitCid] : []), cid = p.entryCid.replace(/-B$/, tries.length ? `-S${tries.length + 1}` : "-S"), side = p.dir > 0 ? "sell" : "buy";
  if (!(rem > 0)) return false;
  if (!LIVE || fs.existsSync(OFF)) { console.log(`${LIVE ? "OFF switch — not sent" : "exit owed (run with --live to re-send)"}: ${p.id} ${side} ${rem} ${p.sym} as ${cid}`); if (!LIVE) process.exitCode = 1; return false; }   // PAPER-AUCTION-FIX 2026-10-02 (review): an owed exit left unsent is a stale position — exit 1, so a close-chain step without --live is loud, not silent
  const body = { symbol: p.sym, qty: String(rem), side, type: "market", time_in_force: "day", client_order_id: cid };
  let o = null; try { o = await api("/v2/orders", { method: "POST", body: JSON.stringify(body) }); } catch (e) { o = await adopt(cid); if (!o) { console.error(`REJECTED ${cid}: ${e.message}`); ledger({ kind: "order-rejected", cid, sym: p.sym, error: e.message.slice(0, 160) }); process.exitCode = 1; return false; } }   // PAPER-AUCTION-FIX 2026-10-02 (review): refused -> still owed, retried next run under the same never-created id; exit 1
  Object.assign(p, { exitCid: cid, exitCids: [...tries, cid], status: "exiting" }); delete p.exitDue;
  ledger({ kind: "exit-resent", id: p.id, cid, qty: rem, orderId: o.id }); console.log(`sent ${cid} ${side} ${rem} ${p.sym} (exit remainder; paper, market, day) — order ${o.id}`); return true;
}

async function add() {
  const sym = (arg("--sym") || "").toUpperCase(), action = (arg("--action") || "").toLowerCase(), stated = arg("--stated") ? +arg("--stated") : null, raw = arg("--raw") || "";
  if (!/^[A-Z.]{1,6}$/.test(sym) || !["buy", "sell", "short", "cover"].includes(action)) { console.error("usage: --add --sym SYM --action buy|sell|short|cover [--stated PRICE] --raw \"alert text\""); process.exit(2); }
  if (fs.existsSync(OFF)) { console.error("payne-picks OFF switch is set — nothing logged"); process.exit(2); }
  const s = load(), receivedAt = new Date().toISOString(), opening = action === "buy" || action === "short";
  let pick;
  if (opening) {
    if (s.picks.some((p) => p.sym === sym && p.status !== "closed")) { console.error(`${sym} already open in the record — log its exit first`); process.exit(2); }
    const px = await lastPrice(sym), qty = px ? Math.max(1, Math.floor(NOTIONAL / px)) : 1, n = s.picks.filter((p) => p.sym === sym).length + 1;
    pick = { id: `${sym}-${receivedAt.slice(0, 10)}-${n}`, sym, dir: action === "buy" ? 1 : -1, statedEntry: stated, alertTime: arg("--alert-time"), receivedAt, rawEntry: raw, qty, refPriceAtLog: px, entryCid: `payne-${sym}-${receivedAt.slice(0, 10).replace(/-/g, "")}-${n}-B`, status: "pending" };
    s.picks.push(pick);
  } else {
    pick = s.picks.find((p) => p.sym === sym && p.status === "open") || s.picks.find((p) => p.sym === sym && p.status === "pending");
    if (!pick) { console.error(`no open ${sym} pick to close`); process.exit(2); }
    // PAPER-AUCTION-FIX 2026-10-02: a "pending" pick's entry may have filled since the last reconcile — ask the broker (filled_qty), not the state file
    if (LIVE && pick.status === "pending") { try { const eo = await api(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(pick.entryCid)}`), q = Number(eo.filled_qty) || 0; if (q > 0 && DONE.includes(eo.status)) Object.assign(pick, { entryFill: +eo.filled_avg_price, entryFilledAt: eo.filled_at, qty: q, status: "open" }); } catch {} }
    const tries = pick.exitCids || (pick.exitCid ? [pick.exitCid] : []), exitCid = pick.entryCid.replace(/-B$/, tries.length ? `-S${tries.length + 1}` : "-S");   // PAPER-AUCTION-FIX 2026-10-02: a NEW client id per exit attempt (Alpaca refuses a reused one)
    Object.assign(pick, { statedExit: stated, exitAlertTime: arg("--alert-time"), exitReceivedAt: receivedAt, rawExit: raw, exitCid, exitCids: [...tries, exitCid], status: pick.status === "open" ? "exiting" : "cancel-before-fill" }); delete pick.exitDue;
  }
  const side = opening ? (pick.dir > 0 ? "buy" : "sell") : (pick.dir > 0 ? "sell" : "buy"), cid = opening ? pick.entryCid : pick.exitCid;
  const qty = opening ? pick.qty : pick.qty - soldQty(pick);   // PAPER-AUCTION-FIX 2026-10-02: an exit sells what is still held (entry filled_qty minus exit fills so far)
  const body = { symbol: sym, qty: String(qty), side, type: "market", time_in_force: "day", client_order_id: cid };
  if (LIVE && pick.status !== "cancel-before-fill") { try { const o = await api("/v2/orders", { method: "POST", body: JSON.stringify(body) }); console.log(`sent ${cid} ${side} ${qty} ${sym} (paper, market, day; queues for the next open if the market is closed) — order ${o.id}`); }
    catch (e) { const ex = await adopt(cid); if (ex) console.log(`ADOPTED ${cid} (already at the broker, ${ex.status})`); else { console.error(`REJECTED ${cid}: ${e.message}`); ledger({ kind: "order-rejected", cid, sym, error: e.message.slice(0, 160) }); } } }
  else console.log(`${LIVE ? "not sent (entry never filled)" : "DRY"}: ${cid} ${side} ${qty} ${sym}`);
  ledger({ kind: opening ? "pick-logged" : "exit-logged", id: pick.id, sym, action, stated, receivedAt, alertTime: arg("--alert-time"), raw: raw.slice(0, 2000), live: LIVE });
  writeJsonAtomic(STATE, s); console.log(`logged ${action.toUpperCase()} ${sym}${stated ? " (their price " + stated + ")" : ""} at ${receivedAt}`);
}

async function reconcile() {
  const s = load(); let changed = 0;
  for (const p of s.picks) {
    for (const leg of ["entry", "exit"]) {
      const cid = leg === "entry" ? p.entryCid : p.exitCid, need = leg === "entry" ? p.status === "pending" || p.status === "cancel-before-fill" || (p.status === "exiting" && !p.entryFill) : p.status === "exiting";   // PAPER-AUCTION-FIX 2026-10-02: a cancel-before-fill entry is read too (nothing cancels it at the broker)
      if (!cid || !need) continue;
      let o; try { o = await api(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(cid)}`); } catch (e) { if (e.status === 404) continue; throw e; }
      // PAPER-AUCTION-FIX 2026-10-02: fills come from filled_qty / filled_avg_price, never from status alone — an order that ends expired / canceled /
      // done_for_day with filled_qty > 0 is a PARTIAL fill. An order still working (new/accepted/partially_filled) is left alone and re-checked next run.
      if (!DONE.includes(o.status)) continue;
      const q = Number(o.filled_qty) || 0, px = Number(o.filled_avg_price) || null;
      if (leg === "entry") {
        if (q > 0) { p.entryFill = px; p.entryFilledAt = o.filled_at; p.qty = q; if (o.status !== "filled") ledger({ kind: "entry-partial", id: p.id, cid, brokerStatus: o.status, filledQty: q });
          if (p.status === "pending") p.status = "open";
          else if (p.status === "cancel-before-fill") { p.status = "open"; p.exitDue = true; ledger({ kind: "entry-filled-after-exit-alert", id: p.id, cid, filledQty: q, px }); } }
        else { ledger({ kind: "entry-not-filled", id: p.id, cid, brokerStatus: o.status }); p.status = "unfilled"; }
      } else {
        p.exitFills = p.exitFills || []; if (q > 0 && !p.exitFills.some((f) => f.cid === cid)) p.exitFills.push({ cid, qty: q, px, at: o.filled_at });
        const sold = soldQty(p);
        if (sold >= p.qty) { p.exitFill = p.exitFills.length === 1 ? p.exitFills[0].px : p.exitFills.reduce((a, f) => a + f.qty * f.px, 0) / sold; p.exitFilledAt = p.exitFills.map((f) => f.at).filter(Boolean).sort().pop(); p.status = "closed"; delete p.exitDue; }
        else { p.status = "open"; p.exitDue = true; ledger({ kind: q > 0 ? "exit-partial" : "exit-not-filled", id: p.id, cid, brokerStatus: o.status, filledQty: q, remaining: p.qty - sold }); }
      }
      changed++;
    }
  }
  // PAPER-AUCTION-FIX 2026-10-02: an exit the broker did not (fully) fill is still owed. With --live the remainder is re-sent now (DAY market, queued
  // for the next open when the market is closed) under a NEW client id (-S2, -S3 ...); without --live it is listed and waits.
  for (const p of s.picks.filter((x) => x.status === "open" && x.exitDue)) if (await resendExit(p)) changed++;
  const closed = s.picks.filter((p) => p.status === "closed" && p.bench == null);
  if (closed.length) {
    const { bars } = await fetchBars(["SPY", "SMH"], { start: closed.map((p) => p.entryFilledAt.slice(0, 10)).sort()[0], end: new Date(Date.now() - 20 * 60e3).toISOString(), feed: "sip", requireAll: true, quiet: true });
    const at = (sym, iso) => { const d = iso.slice(0, 10), b = bars[sym].filter((x) => x.t.slice(0, 10) <= d); return b.length ? b[b.length - 1].c : null; };
    for (const p of closed) { const r = p.dir * (p.exitFill / p.entryFill - 1), bench = (sym) => at(sym, p.exitFilledAt) / at(sym, p.entryFilledAt) - 1;
      p.ret = +r.toFixed(5); p.bench = { SPY: +bench("SPY").toFixed(5), SMH: +bench("SMH").toFixed(5) }; p.excessSPY = +(r - p.dir * p.bench.SPY).toFixed(5); p.excessSMH = +(r - p.dir * p.bench.SMH).toFixed(5);
      p.statedRet = p.statedEntry && p.statedExit ? +(p.dir * (p.statedExit / p.statedEntry - 1)).toFixed(5) : null;
      ledger({ kind: "pick-closed", id: p.id, sym: p.sym, ret: p.ret, statedRet: p.statedRet, bench: p.bench, excessSPY: p.excessSPY, excessSMH: p.excessSMH }); changed++; }
  }
  if (changed) { s.asOf = new Date().toISOString(); writeJsonAtomic(STATE, s); }
  const c = s.picks.filter((p) => p.status === "closed"); console.log(`payne-picks: ${s.picks.length} logged, ${s.picks.filter((p) => p.status === "open").length} open, ${c.length} closed${c.length ? ` · mean ${(100 * c.reduce((a, p) => a + p.ret, 0) / c.length).toFixed(2)}% vs SPY ${(100 * c.reduce((a, p) => a + p.bench.SPY, 0) / c.length).toFixed(2)}%` : ""} · read at ${MIN_CLOSED} closed`);
}

function status() {
  const s = load(); if (!s.picks.length) { console.log("payne-picks: no picks logged yet — the record starts with the first alert"); return; }
  for (const p of s.picks) console.log(`${p.sym.padEnd(6)} ${p.dir > 0 ? "LONG " : "SHORT"} ${p.status.padEnd(8)} their ${p.statedEntry ?? "-"} -> ${p.statedExit ?? "-"}${p.statedRet != null ? " (" + (100 * p.statedRet).toFixed(1) + "%)" : ""} | ours ${p.entryFill ?? "-"} -> ${p.exitFill ?? "-"}${p.ret != null ? " (" + (100 * p.ret).toFixed(1) + "%) SPY " + (100 * p.bench.SPY).toFixed(1) + "% SMH " + (100 * p.bench.SMH).toFixed(1) + "%" : ""} · logged ${p.receivedAt.slice(0, 16)}`);
}

async function read() {   // amended 2026-09-23 (pre-evidence): OPEN picks are marked at the latest close and counted — a picker who holds losers must not have them hidden
  { const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R159 || (fs.existsSync(D("r159-read.json")) && JSON.parse(fs.readFileSync(D("r159-read.json"), "utf8")).read)) { console.error("R159 already read — one read only (weekly audit 2026-09-23)"); process.exit(2); } }
  const s = load(), c = s.picks.filter((p) => p.status === "closed"); if (c.length < MIN_CLOSED) { console.log(`R159 not readable: ${c.length}/${MIN_CLOSED} closed picks`); return; }
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R159");
  const open = s.picks.filter((p) => (p.status === "open" || p.status === "exiting") && p.entryFill > 0), end = new Date(Date.now() - 20 * 60e3).toISOString();
  let marked = [];
  if (open.length) { const { bars } = await fetchBars([...new Set([...open.map((p) => p.sym), "SPY"])], { start: open.map((p) => p.entryFilledAt.slice(0, 10)).sort()[0], end, feed: "sip", requireAll: true, quiet: true });
    const lastC = (sym) => bars[sym][bars[sym].length - 1].c, at = (sym, iso) => { const b = bars[sym].filter((x) => x.t.slice(0, 10) <= iso.slice(0, 10)); return b[b.length - 1].c; };
    marked = open.map((p) => { const r = p.dir * (lastC(p.sym) / p.entryFill - 1), spy = lastC("SPY") / at("SPY", p.entryFilledAt) - 1; return { ...p, markedAtEnd: true, ret: r, excessSPY: r - p.dir * spy }; }); }
  const all = [...c, ...marked], x = all.map((p) => p.excessSPY), m = x.reduce((a, b) => a + b, 0) / x.length, sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1)), tt = m / (sd / Math.sqrt(x.length));
  const verdict = m > 0 && tt >= t.bar.tRequired ? "PASS" : "DID NOT PASS";   // unrounded
  writeJsonAtomic(D("r159-read.json"), { spec: "r159-read-v2 (open picks marked)", read: true, asOf: new Date().toISOString(), closed: c.length, markedOpen: marked.length, meanExcessSPYPct: +(100 * m).toFixed(3), t: +tt.toFixed(3), bar: t.bar.tRequired, meanRetPct: +(100 * all.reduce((a, p) => a + p.ret, 0) / all.length).toFixed(3), meanStatedRetPct: +(100 * c.filter((p) => p.statedRet != null).reduce((a, p) => a + p.statedRet, 0) / Math.max(1, c.filter((p) => p.statedRet != null).length)).toFixed(3), verdict });
  console.log(`R159 READ — ${verdict}: ${c.length} closed + ${marked.length} open (marked) picks · mean excess vs SPY ${(100 * m).toFixed(2)}% · t ${tt.toFixed(2)} vs bar ${t.bar.tRequired}`);
}

(async () => {
  if (has("--add")) return add(); if (has("--reconcile")) return reconcile(); if (has("--read")) return read(); return status();
})().catch((e) => { console.error("payne-picks FAILED:", e.message); process.exit(1); });
