#!/usr/bin/env node
/**
 * OPTIONS FLOW RECORDER (R272 writer, 2026-09-27). Once a day between 15:30 and 15:55 ET (the 13:40 MT intraday fire), snapshots the
 * Schwab option chain of every R147 name (80) for expiries within 45 days, and keeps every contract that has traded today:
 * volume so far, open interest (the prior session's settled OI), bid/ask/last, delta, IV. Schwab keeps no historical chains, so a
 * missed fire loses the day for good — the file says so rather than being back-filled (three record types).
 *
 *   node backend/options-flow-record.js            self-gated: trading day, 15:30-15:55 ET, once (skips if today's file is complete)
 *   node backend/options-flow-record.js --test     ignore the clock, 3 names, write to the scratch path given after --out (never data/)
 *   node backend/options-flow-record.js --schwab-md   W2b (server migration 2026-10, docs/server/wave2b-schwab; the VPS units
 *        traids-flow / traids-flow-shadow only): the token of the operator's MARKET-DATA-ONLY Schwab app (lib/schwab-md.js) instead of
 *        lib/schwab.js + backend/.env (dotenv is not loaded), and a market holiday records nothing (as intraday.bat at home). The names
 *        are data/r147-earnings as home pushed it (read-only). Same gate, rows and file. Without the flag nothing changes.
 */
"use strict";
const fs = require("fs"), path = require("path");
const MD = process.argv.includes("--schwab-md");   // W2b (2026-10): the VPS units only — see the header
if (!MD) require("dotenv").config({ path: path.join(__dirname, ".env") });
const { token } = require(MD ? "./lib/schwab-md.js" : "./lib/schwab.js");   // W2b: the market-data app on the VPS; home unchanged
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const DIR = path.join(__dirname, "data", "options-flow"), EARN = path.join(__dirname, "data", "r147-earnings");
const args = process.argv.slice(2), TEST = args.includes("--test");
const DTE_MAX = 45, STRIKES = 120;
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const et = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, mins: (+p.hour % 24) * 60 + +p.minute, wd: p.weekday }; };
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);

async function chainRaw(sym, from, to, tok) {
  const u = `https://api.schwabapi.com/marketdata/v1/chains?symbol=${encodeURIComponent(sym)}&contractType=ALL&strikeCount=${STRIKES}&fromDate=${from}&toDate=${to}`;
  for (let a = 0; a < 3; a++) {
    const r = await fetch(u, { headers: { Authorization: "Bearer " + tok }, signal: AbortSignal.timeout(30000) });
    if (r.status === 429) { await nap(4000 * (a + 1)); continue; }
    if (!r.ok) throw new Error(`${sym} chain ${r.status}`);
    const j = await r.json(), rows = [];
    for (const [kind, right] of [["callExpDateMap", "C"], ["putExpDateMap", "P"]]) for (const strikes of Object.values(j[kind] || {})) for (const arr of Object.values(strikes)) for (const c of arr) {
      const vol = Number(c.totalVolume) || 0; if (vol <= 0) continue;
      rows.push([String(c.symbol || "").replace(/\s+/g, ""), String(c.expirationDate || "").slice(0, 10), right, +c.strikePrice, vol, Number(c.openInterest) || 0, +c.bid || 0, +c.ask || 0, +c.last || 0, Number.isFinite(+c.delta) ? +c.delta : null, Number(c.volatility) || null]);
    }
    return { spot: Number(j.underlyingPrice) || null, status: j.status, rows };
  }
  throw new Error(`${sym} chain 429 x3`);
}

(async () => {
  const now = et();
  if (!TEST) {
    if (["Sat", "Sun"].includes(now.wd)) return console.log("options-flow: weekend");
    if (MD) { const hol = require("./lib/run-window.js").marketHoliday(now.date); if (hol) return console.log(`options-flow: ${now.date} is a market holiday (${hol})`); }   // W2b: as intraday.bat at home
    if (now.mins < 15 * 60 + 30 || now.mins > 15 * 60 + 55) return console.log(`options-flow: outside 15:30-15:55 ET (${Math.floor(now.mins / 60)}:${String(now.mins % 60).padStart(2, "0")})`);
    const f = path.join(DIR, now.date + ".json"); if (fs.existsSync(f) && JSON.parse(fs.readFileSync(f, "utf8")).complete) return console.log("options-flow: today already complete");
  }
  let names = fs.readdirSync(EARN).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  if (TEST) names = names.slice(0, 3);
  const tok = await token(), out = { spec: "R272 writer · rows [occ, exp, right, strike, volume, openInterest, bid, ask, last, delta, iv%]", date: now.date, recordedAt: new Date().toISOString(), etMinutes: now.mins, names: {}, errors: {} };
  for (const s of names) { try { out.names[s] = await chainRaw(s, now.date, addDays(now.date, DTE_MAX), tok); } catch (e) { out.errors[s] = e.message; } await nap(550); }
  const got = Object.keys(out.names).length; out.coverage = +(got / names.length).toFixed(3); out.complete = out.coverage >= 0.9; out.finishedAt = new Date().toISOString();
  const file = TEST ? args[args.indexOf("--out") + 1] : path.join(DIR, now.date + ".json");
  if (!file) throw new Error("--test needs --out <scratch path>");
  fs.mkdirSync(path.dirname(file), { recursive: true }); writeJsonAtomic(file, out);
  console.log(`options-flow ${now.date}: ${got}/${names.length} names, ${Object.values(out.names).reduce((a, n) => a + n.rows.length, 0)} traded contracts, complete=${out.complete}${Object.keys(out.errors).length ? " · errors: " + Object.keys(out.errors).join(" ") : ""}`);
  if (!out.complete && !TEST) process.exitCode = 1;
})().catch((e) => { console.error("options-flow FAILED:", e.message); process.exit(1); });
