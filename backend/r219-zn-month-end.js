#!/usr/bin/env node
/**
 * R219 — MONTH-END TREASURIES ON ZN FUTURES, ~5x, QUOTE-PRICED PAPER (registered 2026-09-24; rule frozen in data/test-registry.json).
 * RECORD TYPE: quote-priced-paper, venue none. No order exists anywhere: BUY at Schwab's live ask, SELL at the live bid. Fees are assumed.
 * Windows = R186's: entry on the 6th-to-last NYSE session, exit on the last. 2 contracts on a $50,000 book. OFF switch data/r219-OFF.
 *
 *   node backend/r219-zn-month-end.js --close-arm      15:35-15:48 ET (automation/intraday.bat 13:40 MT fire); once a day
 *   node backend/r219-zn-month-end.js --after-close    close chain: retries a missed exit (marked late), scores windows, prints status
 *   node backend/r219-zn-month-end.js --selftest       one quote on this month's contract; writes nothing
 *   node backend/r219-zn-month-end.js --status | --read
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const S = require("./lib/schwab.js");
const D = (f) => path.join(__dirname, "data", f), STATE = D("r219-zn-month-end.json"), LEDGER = D("r219-zn-month-end.jsonl"), OFF = D("r219-OFF");
const QTY = 2, MULT = 1000, BOOK = 50000, FEE_SIDE = 2.5, MAX_AGE_MS = 10000, FIRST_MONTH = "2026-10", READ_N = 12;
const RECORD = { recordType: "quote-priced-paper", venue: "none — Schwab ZN quote at read time, NOT a broker fill" };
const AH = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
const mode = ["--close-arm", "--after-close", "--selftest", "--status", "--read"].find((m) => process.argv.includes(m)) || "--status";
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, tOf = (a) => (a.length >= 3 ? mean(a) / (Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)) / Math.sqrt(a.length)) : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const etNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, mins: (+p.hour % 24) * 60 + +p.minute }; };
const load = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { spec: "r219-state-v1", windows: {}, lastRun: {} });
const save = (s) => { s.asOf = new Date().toISOString(); writeJsonAtomic(STATE, s); };
const ledger = (o) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...RECORD, ...o }) + "\n");
async function monthSessions(ym) { const [y, m] = ym.split("-").map(Number), end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); const r = await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${ym}-01&end=${end}`, { headers: AH }); if (!r.ok) throw new Error(`calendar ${r.status}`); return r.json(); }
// first quarterly contract whose delivery month is >= window month + 2 (never touches first notice day inside the window)
function contractFor(ym) { const [y, m] = ym.split("-").map(Number); let yy = y, mm = m + 2; if (mm > 12) { mm -= 12; yy++; } while (![3, 6, 9, 12].includes(mm)) { mm++; if (mm > 12) { mm = 1; yy++; } } return `/ZN${{ 3: "H", 6: "M", 9: "U", 12: "Z" }[mm]}${String(yy).slice(2)}`; }
async function quote(sym) { let last = "no attempt";
  for (let i = 0; i < 3; i++) { try { const tok = await S.token(); const r = await fetch(`https://api.schwabapi.com/marketdata/v1/quotes?symbols=${encodeURIComponent(sym)}&fields=quote`, { headers: { Authorization: "Bearer " + tok, Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(`schwab quotes ${r.status}`); const j = await r.json(), k = Object.keys(j)[0], q = j[k] && j[k].quote; const bid = q && +q.bidPrice, ask = q && +q.askPrice, age = q && Date.now() - +q.quoteTime;
      if (!(bid > 0) || !(ask > 0) || ask < bid) throw new Error(`one-sided or crossed (bid ${bid}, ask ${ask})`); if (!(age <= MAX_AGE_MS)) throw new Error(`stale quote (${Math.round(age)} ms)`);
      return { contract: k, bid, ask, spreadTicks: Math.round((ask - bid) * 64), quoteTime: new Date(+q.quoteTime).toISOString() }; } catch (e) { last = e.message; await sleep(1000); } }
  return { error: last }; }
async function exitLeg(w, late) { const q = await quote(w.contract); if (q.error) { ledger({ kind: "exit-no-quote", ym: w.ym, late, why: q.error }); console.log(`r219 exit: no valid quote (${q.error})`); return false; }
  w.exit = { px: q.bid, ...q, late, at: new Date().toISOString() }; const gross = (w.exit.px - w.entry.px) * MULT * QTY, fees = FEE_SIDE * QTY * 2;
  w.score = { gross: +gross.toFixed(2), fees, net: +(gross - fees).toFixed(2), ret: +((gross - fees) / BOOK).toFixed(6), leverage: +((w.entry.px * MULT * QTY) / BOOK).toFixed(2), spreadTicksPaid: w.entry.spreadTicks + q.spreadTicks, late };
  ledger({ kind: "exit", ym: w.ym, contract: w.contract, px: q.bid, ...w.score }); console.log(`r219 SELL ${QTY} ${w.contract} at bid ${q.bid}${late ? " (LATE)" : ""} · net $${w.score.net}`); return true; }
async function closeArm() {
  const now = etNow(), ym = now.date.slice(0, 7); if (ym < FIRST_MONTH) return console.log(`r219 close-arm: before the first window (${FIRST_MONTH})`);
  const cal = await monthSessions(ym), today = cal.find((c) => c.date === now.date); if (!today) return console.log("r219 close-arm: not a trading day");
  const [h, m] = today.close.split(":").map(Number), cm = h * 60 + m; if (now.mins < cm - 25 || now.mins > cm - 12) return console.log(`r219 close-arm: outside window (ET ${Math.floor(now.mins / 60)}:${String(now.mins % 60).padStart(2, "0")})`);
  const s = load(); if (s.lastRun.closeArm === now.date) return console.log("r219 close-arm: already ran today");
  const days = cal.map((c) => c.date), entryDay = days[days.length - 6], exitDay = days[days.length - 1];
  const w = (s.windows[ym] = s.windows[ym] || { ym, entryDay, exitDay, contract: contractFor(ym) });
  if (now.date === entryDay && !w.entry) {
    if (fs.existsSync(OFF)) { ledger({ kind: "skipped", ym, why: "OFF switch" }); console.log("r219: OFF switch present — no entry"); }
    else { const q = await quote(w.contract); if (q.error) { ledger({ kind: "entry-no-quote", ym, why: q.error }); w.noEntry = q.error; console.log(`r219 entry: no valid quote (${q.error}) — nothing opened`); }
      else { w.entry = { px: q.ask, ...q, at: new Date().toISOString() }; ledger({ kind: "entry", ym, contract: w.contract, px: q.ask, qty: QTY, spreadTicks: q.spreadTicks }); console.log(`r219 BUY ${QTY} ${w.contract} at ask ${q.ask} (~${((q.ask * MULT * QTY) / BOOK).toFixed(1)}x)`); } }
  } else if (now.date === exitDay && w.entry && !w.exit) await exitLeg(w, false);
  else console.log(`r219 close-arm: nothing due today (entry ${entryDay}, exit ${exitDay}, contract ${w.contract})`);
  s.lastRun.closeArm = now.date; save(s);
}
async function afterClose() { const s = load(), now = etNow();
  for (const w of Object.values(s.windows)) if (w.entry && !w.exit && now.date >= w.exitDay) await exitLeg(w, true);
  save(s); status(s); }
function status(s = load()) { const done = Object.values(s.windows).filter((w) => w.score), r = done.map((w) => w.score.ret), t = tOf(r);
  console.log(`R219 — ${done.length}/${READ_N} windows${done.length ? ` · net $${done.reduce((a, w) => a + w.score.net, 0).toFixed(0)} · mean ${(100 * mean(r)).toFixed(2)}% of $50k per window${t != null ? ` t ${t.toFixed(2)}` : ""}` : ""}${Object.values(s.windows).some((w) => w.entry && !w.exit) ? " · OPEN position" : ""}`); return { done, r, t }; }
async function read() { const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests || seals).R219) return console.error("R219 already sealed — refusing");
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), E = reg.preregistered.find((x) => x.id === "R219"), { done, t } = status(); if (done.length < READ_N) return console.error(`R219 read condition not met (${done.length}/${READ_N})`);
  const verdict = t >= E.bar.tRequired ? `PASS — t ${t.toFixed(3)} >= ${E.bar.tRequired} over ${done.length} windows` : `DID NOT PASS — t ${t.toFixed(3)} vs ${E.bar.tRequired}`;
  (seals.tests || seals).R219 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "monthly windows", verdict }; writeJsonAtomic(D("read-seals.json"), seals);
  E.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R219", verdict }) + "\n"); console.log(`R219 READ — ${verdict}`); }
async function selftest() { for (const ym of ["2026-10", "2026-11", "2027-02"]) console.log(`window ${ym} -> contract ${contractFor(ym)}`); const c = contractFor(etNow().date.slice(0, 7) < FIRST_MONTH ? FIRST_MONTH : etNow().date.slice(0, 7)); const q = await quote(c);
  console.log(q.error ? `quote ${c}: ${q.error} (fail-closed; outside hours this is expected)` : `quote ${c}: bid ${q.bid} ask ${q.ask} spread ${q.spreadTicks}/64 · 2 contracts = $${Math.round(q.ask * MULT * QTY)} notional = ${((q.ask * MULT * QTY) / BOOK).toFixed(2)}x on $50k`); }
(async () => { if (mode === "--close-arm") return closeArm(); if (mode === "--after-close") return afterClose(); if (mode === "--selftest") return selftest(); if (mode === "--read") return read(); status(); })().catch((e) => { console.error("r219 FAILED:", e.message); process.exit(1); });
