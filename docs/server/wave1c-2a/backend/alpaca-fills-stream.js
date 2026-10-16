#!/usr/bin/env node
/**
 * ALPACA FILLS STREAM — one broker-truth fill record for all of TRAIDS (2026-09-30, operator: "this isnt for r295 its for all of traids").
 *
 * Every TRAIDS runner that trades Alpaca paper learns about its fills by POLLING (by client id, every few seconds, or after the close).
 * This process instead subscribes to Alpaca's trade_updates websocket on EVERY paper account TRAIDS uses (main ALPACA_*, TV ALPACA_TV_*,
 * book ALPACA_BOOK_*) and appends each order event the moment it happens to data/alpaca-trade-updates.jsonl:
 *   { at, account, event, order_id, client_order_id, symbol, side, type, order_class, qty, filled_qty, filled_avg_price, status,
 *     price, position_qty, legs }
 * READ-ONLY: it places, cancels and changes nothing. Alpaca allows several trade_updates connections per account (tested 2026-09-30), so
 * it coexists with R295's own stream. Reconnects with back-off; one process per day (lock); exits at 18:30 ET.
 *
 *   node backend/alpaca-fills-stream.js            run (self-gated to weekdays 06:00-18:30 ET)
 *   node backend/alpaca-fills-stream.js --test     connect every account, confirm authorized + listening, exit after 8 s (writes nothing)
 *   node backend/alpaca-fills-stream.js --summary [YYYY-MM-DD]   counts by account / event for a day
 *   node backend/alpaca-fills-stream.js --tv-24x7  W2a (server migration 2026-10, docs/server/wave1c-2a; the VPS unit traids-fills only):
 *        ONE long-running process. The TV account (R309 trades crypto on weekends) is recorded around the clock; main and book only
 *        weekdays 06:00-18:30 ET, exactly as before (wantAccounts). Same file, same rows. Without the flag nothing changes.
 */
"use strict";
const fs = require("fs"), path = require("path");
try { require("dotenv").config({ path: path.join(__dirname, ".env") }); } catch {}   // optional since 2026-10 (W2a): on the VPS the keys come from the unit's EnvironmentFile
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const OUT = path.join(__dirname, "data", "alpaca-trade-updates.jsonl");
const LOCK = path.join(__dirname, "data", "alpaca-fills-stream.lock");
const URL = "wss://paper-api.alpaca.markets/stream";                                  // paper only, by construction
const ACCOUNTS = [["main", "ALPACA_KEY_ID", "ALPACA_SECRET_KEY"], ["tv", "ALPACA_TV_KEY_ID", "ALPACA_TV_SECRET_KEY"], ["book", "ALPACA_BOOK_KEY_ID", "ALPACA_BOOK_SECRET_KEY"]]
  .filter(([, k, s]) => process.env[k] && process.env[s]);
const TEST = process.argv.includes("--test"), SUMMARY = process.argv.includes("--summary");
const TV247 = process.argv.includes("--tv-24x7");   // W2a (2026-10): the VPS unit only
const log = (...a) => console.log(new Date().toISOString().slice(0, 19) + "Z [fills]", ...a);
const etNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date()).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === "24" ? "00" : p.hour}:${p.minute}`, wd: p.weekday }; };

function row(account, ev, o) {
  return { at: new Date().toISOString(), account, event: ev, order_id: o.id, client_order_id: o.client_order_id, symbol: o.symbol, side: o.side, type: o.type,
    order_class: o.order_class || null, qty: o.qty, filled_qty: o.filled_qty, filled_avg_price: o.filled_avg_price, status: o.status,
    legs: (o.legs || []).map((l) => ({ id: l.id, type: l.type, status: l.status, qty: l.qty, stop_price: l.stop_price, limit_price: l.limit_price })) };
}

function connect(account, key, secret, onRow, state) {
  const dec = new TextDecoder(); let tries = 0;
  const open = () => {
    if (state.closed) return;
    const ws = new WebSocket(URL); ws.binaryType = "arraybuffer"; state.ws[account] = ws;
    ws.onopen = () => ws.send(JSON.stringify({ action: "auth", key, secret }));
    ws.onmessage = (m) => {
      let j; try { j = JSON.parse(typeof m.data === "string" ? m.data : dec.decode(m.data)); } catch { return; }
      if (j.stream === "authorization") { const ok = j.data && j.data.status === "authorized"; state.auth[account] = ok; log(`${account}: ${ok ? "authorized" : "NOT authorized"}`); if (ok) { tries = 0; ws.send(JSON.stringify({ action: "listen", data: { streams: ["trade_updates"] } })); } return; }
      if (j.stream === "listening") { state.listen[account] = true; log(`${account}: listening`); return; }
      if (j.stream === "trade_updates" && j.data && j.data.order) onRow(row(account, j.data.event, j.data.order));
    };
    ws.onerror = () => {};
    ws.onclose = () => { state.listen[account] = false; if (state.closed) return; tries++; const wait = Math.min(60000, 2000 * tries); log(`${account}: disconnected — reconnecting in ${wait / 1000}s`); setTimeout(open, wait); };
  };
  open();
}

/**
 * W2a (2026-10): the accounts that record at `et` (an etNow() value). Every account inside the weekday 06:00-18:30 ET window, exactly as
 * the home process; with tv247 === true ALSO the TV account outside it. Never main or book outside the window, flag or not.
 */
function wantAccounts(et, names, tv247) {
  const inWindow = !["Sat", "Sun"].includes(et.wd) && et.hm >= "06:00" && et.hm < "18:30";
  return names.filter((a) => inWindow || (tv247 === true && a === "tv"));
}
/** --tv-24x7: ONE process for the VPS unit (systemd restarts it on failure). Each account is connected while wantAccounts() names it and
 *  closed when it stops naming it (checked every 30 s). Same row format, same file as the home process. */
async function run247() {
  if (!ACCOUNTS.some(([a]) => a === "tv")) throw new Error("--tv-24x7 needs the TV keys (ALPACA_TV_KEY_ID / ALPACA_TV_SECRET_KEY)");
  // No pid check here: systemd runs ONE instance of the unit. A stale lock naming a pid that is live again (reused after a reboot)
  // must never make the service exit 0 unseen (Restart=on-failure would not restart it, OnFailure would not page). The lock is a record.
  writeJsonAtomic(LOCK, { pid: process.pid, date: etNow().date, startedAt: new Date().toISOString(), accounts: ACCOUNTS.map(([a]) => a), mode: "tv-24x7" });
  const st = {}; let n = 0;
  const onRow = (r) => { try { fs.appendFileSync(OUT, JSON.stringify(r) + "\n"); n++; } catch (e) { log("write failed: " + e.message); } };
  const sync = () => {
    const want = wantAccounts(etNow(), ACCOUNTS.map(([a]) => a), true);
    for (const [a, k, s] of ACCOUNTS) {
      const on = !!(st[a] && !st[a].closed);
      if (want.includes(a) && !on) { st[a] = { closed: false, ws: {}, auth: {}, listen: {} }; connect(a, process.env[k], process.env[s], onRow, st[a]); log(`${a}: recording (tv-24x7)`); }
      else if (!want.includes(a) && on) { st[a].closed = true; try { st[a].ws[a].close(); } catch {} log(`${a}: outside weekdays 06:00-18:30 ET — closed (${n} events recorded so far)`); }
    }
  };
  sync(); setInterval(sync, 30000);
}

async function main() {
  if (SUMMARY) {
    const i = process.argv.indexOf("--summary"), d = /^\d{4}-\d{2}-\d{2}$/.test(process.argv[i + 1] || "") ? process.argv[i + 1] : etNow().date;
    const rows = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.at.slice(0, 10) === d || new Date(r.at).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === d) : [];
    const c = {}; for (const r of rows) { const k = `${r.account} ${r.event}`; c[k] = (c[k] || 0) + 1; }
    return console.log(JSON.stringify({ date: d, events: rows.length, byAccountEvent: c }, null, 1));
  }
  if (!ACCOUNTS.length) throw new Error("no Alpaca paper keys in backend/.env");
  const state = { closed: false, ws: {}, auth: {}, listen: {} };
  if (TEST) {
    for (const [a, k, s] of ACCOUNTS) connect(a, process.env[k], process.env[s], () => {}, state);
    await new Promise((r) => setTimeout(r, 8000)); state.closed = true; for (const ws of Object.values(state.ws)) try { ws.close(); } catch {}
    const bad = ACCOUNTS.filter(([a]) => !state.listen[a]).map(([a]) => a);
    log(`test: ${ACCOUNTS.length - bad.length}/${ACCOUNTS.length} accounts listening${bad.length ? " — NOT: " + bad.join(", ") : ""}`); process.exit(bad.length ? 1 : 0);
  }
  if (TV247) return run247();   // W2a (2026-10): the VPS unit; never the weekday gate below
  const t = etNow();
  if (["Sat", "Sun"].includes(t.wd)) return log("weekend — not starting");
  if (t.hm < "06:00" || t.hm >= "18:30") return log(`${t.hm} ET is outside 06:00-18:30 — not starting`);
  try { const l = JSON.parse(fs.readFileSync(LOCK, "utf8")); if (l.date === t.date && l.pid !== process.pid) { let alive = false; try { process.kill(l.pid, 0); alive = true; } catch {} if (alive) return log(`already running today (pid ${l.pid})`); } } catch {}
  writeJsonAtomic(LOCK, { pid: process.pid, date: t.date, startedAt: new Date().toISOString(), accounts: ACCOUNTS.map(([a]) => a) });
  let n = 0;
  for (const [a, k, s] of ACCOUNTS) connect(a, process.env[k], process.env[s], (r) => { try { fs.appendFileSync(OUT, JSON.stringify(r) + "\n"); n++; } catch (e) { log("write failed: " + e.message); } }, state);
  log(`recording ${ACCOUNTS.map(([a]) => a).join(", ")} -> ${path.relative(process.cwd(), OUT)}`);
  const tick = setInterval(() => { const e = etNow(); if (e.date !== t.date || e.hm >= "18:30") { state.closed = true; clearInterval(tick); for (const ws of Object.values(state.ws)) try { ws.close(); } catch {} log(`day over — ${n} events recorded`); setTimeout(() => process.exit(0), 1000); } }, 30000);
}
if (require.main === module) main().catch((e) => { log("ERROR " + e.message); process.exit(1); });   // guarded 2026-10 (W2a): the selftest loads wantAccounts
module.exports = { wantAccounts, row };
