#!/usr/bin/env node
/**
 * R282 — TAX-LOSS REVERSAL, FORWARD (December baskets from year-end 2026). Registered 2026-09-28 in backend/register-r281-r282.js (the
 * registry wins). R279's sealed historical read (10 year-ends) leaned positive but under-powered: deep losers +1.28%/window vs IWM,
 * t 1.46 vs 2.307. This writer runs R279's V2 rule verbatim on year-ends R279 never saw. SIP-PRICED SHADOW (close prints), no orders.
 *
 *   node backend/r282-tax-loss-forward.js --after-close   close chain: FORM + SEAL the year's basket once the Dec-15 close exists (before
 *                                                          the last December session); SETTLE after the 5th January session; status
 *   node backend/r282-tax-loss-forward.js --status | --read
 *
 * Rule (R279 N1-N5): universe pitTopN(Y, 1000) ranked before year Y (refuses unless refDate is in Dec Y-1), close >= $5 at formation;
 * YTD = close(last session <= Dec 15) / close(last session of Y-1) - 1; V1 = bottom decile by YTD; V2 = V1 names at <= 0.60 x max close of
 * the prior 252 sessions (formation day included). Buy close of the last December session, sell close of the 5th January session;
 * equal weight; 20 bps round trip; missing exit -> last valid close in (entry, exit]. Benchmark IWM, same window.
 * Exit 1 = STARVING (formation missed or universe not point-in-time).
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), STATE = D("r282-tax-loss-forward.json"), LEDGER = D("r282-tax-loss-forward.jsonl");
const FIRST_YEAR = 2026, COST = 0.002, READ_YEARS = 5;
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
const mode = ["--after-close", "--status", "--read"].find((m) => process.argv.includes(m)) || "--status";
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
const etDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const load = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { spec: "r282-state-v1", years: {} });
const save = (s) => { s.asOf = new Date().toISOString(); writeJsonAtomic(STATE, s); };
const ledger = (o) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
async function calendar(start, end) { const r = await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${start}&end=${end}`, { headers: H, signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error("calendar HTTP " + r.status); return (await r.json()).map((c) => c.date); }

async function dates(Y) {
  const dec = await calendar(`${Y}-12-01`, `${Y}-12-31`), jan = await calendar(`${Y + 1}-01-01`, `${Y + 1}-01-20`), prev = await calendar(`${Y - 1}-12-15`, `${Y - 1}-12-31`);
  return { base: prev.at(-1), formation: dec.filter((d) => d <= `${Y}-12-15`).at(-1), entry: dec.at(-1), exit: jan[4] };
}

async function form(s, Y, dt) {
  const { pitTopN } = require("./lib/tv-pit-panel.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
  const U = pitTopN(Y, 1000); if (!(U.refDate && U.refDate.startsWith(`${Y - 1}-12`))) { ledger({ kind: "starved", Y, why: `panel cannot rank ${Y} point-in-time (refDate ${U.refDate})` }); return false; }
  const start = new Date(Date.parse(dt.formation) - 400 * 864e5).toISOString().slice(0, 10);
  const r = await fetchBars(U.names, { start, end: dt.formation + "T23:00:00Z", feed: "sip", adjustment: "all", quiet: true, requireAll: false, chunkSize: 40 });
  const rows = [];
  for (const sym of U.names) { const bs = r.bars[sym] || []; const at = (d) => { const b = bs.filter((x) => x.t.slice(0, 10) <= d).at(-1); return b && b.t.slice(0, 10) === d ? b.c : null; };
    const cf = at(dt.formation), cb = at(dt.base); if (!(cf >= 5) || !(cb > 0)) continue;
    const upto = bs.filter((x) => x.t.slice(0, 10) <= dt.formation).slice(-252), mx = Math.max(...upto.map((x) => x.c));
    rows.push({ sym, ytd: cf / cb - 1, offHigh: cf / mx }); }
  if (rows.length < 500) { ledger({ kind: "starved", Y, why: `only ${rows.length} priced names at ${dt.formation}` }); return false; }
  rows.sort((a, b) => a.ytd - b.ytd); const k = Math.floor(rows.length / 10), v1 = rows.slice(0, k), v2 = v1.filter((x) => x.offHigh <= 0.6);
  const body = { Y, ...dt, formedAt: new Date().toISOString(), refDate: U.refDate, universe: rows.length, v1: v1.map((x) => x.sym), v2: v2.map((x) => x.sym), top: rows.slice(-k).map((x) => x.sym) };
  const sha = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"); s.years[Y] = { ...body, sha256: sha, sealed: true };
  ledger({ kind: "formed", Y, formation: dt.formation, entry: dt.entry, exit: dt.exit, n1: v1.length, n2: v2.length, sha256: sha });
  console.log(`r282: formed ${Y} — universe ${rows.length}, V1 ${v1.length}, V2 ${v2.length}; sha ${sha.slice(0, 12)}`); return true;
}

async function settle(s, Y) {
  const M = s.years[Y], { fetchBars } = require("./lib/alpaca-bars.js"); const names = [...new Set([...M.v1, ...M.top])];
  const r = await fetchBars(["IWM", ...names], { start: M.entry, end: M.exit + "T23:00:00Z", feed: "sip", adjustment: "all", quiet: true, requireAll: false, chunkSize: 40 });
  const ret = (sym) => { const bs = r.bars[sym] || []; const e = bs.find((b) => b.t.slice(0, 10) === M.entry); if (!e) return null; const x = bs.filter((b) => b.t.slice(0, 10) > M.entry && b.t.slice(0, 10) <= M.exit).at(-1); return x ? x.c / e.c - 1 : 0; };
  const iwm = ret("IWM"); if (iwm == null) throw new Error("no IWM entry bar");
  const ew = (xs) => { const a = xs.map(ret).filter((x) => x != null); return a.length ? mean(a) - COST : null; };
  M.settled = { at: new Date().toISOString(), iwm, v1Ex: ew(M.v1) - iwm, v2Ex: M.v2.length ? ew(M.v2) - iwm : null, topEx: ew(M.top) - iwm };
  ledger({ kind: "settled", Y, ...M.settled }); console.log(`r282: settled ${Y} — V2 vs IWM ${M.settled.v2Ex == null ? "—" : (100 * M.settled.v2Ex).toFixed(2) + "%"}`);
}

const series = (s, k = "v2Ex") => Object.values(s.years).filter((y) => y.settled && y.settled[k] != null).sort((a, b) => a.Y - b.Y).map((y) => y.settled[k]);
function status(s) { const x = series(s); console.log(`r282 status: years formed ${Object.keys(s.years).join(", ") || "none"}; settled ${x.length}/${READ_YEARS}; V2 vs IWM ${x.length ? (100 * mean(x)).toFixed(2) + "%/window" : "—"}`); }

(async () => {
  const s = load();
  if (mode === "--status") return status(s);
  if (mode === "--read") {
    const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests.R282) throw new Error("R282 already sealed — read-once");
    const bar = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")).preregistered.find((t) => t.id === "R282").bar.tRequired;
    const x = series(s); if (x.length < READ_YEARS) throw new Error(`only ${x.length} settled year-ends; read needs ${READ_YEARS}`);
    const t = tOf(x.slice(0, READ_YEARS)), verdict = `${t >= bar ? "PASSED" : "DID NOT PASS"} — V2 deep losers vs IWM ${(100 * mean(x.slice(0, READ_YEARS))).toFixed(3)}%/window t ${t.toFixed(3)} vs bar ${bar} over ${READ_YEARS} forward year-ends`;
    seals.tests = seals.tests || {}; seals.tests.R282 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "forward year-ends, one-sample t", verdict, output: "data/r282-tax-loss-forward.json" };
    writeJsonAtomic(D("read-seals.json"), seals); console.log(verdict); return;
  }
  const today = etDate(), Y = +today.slice(0, 4); let starving = false;
  for (const y of [Y - 1, Y]) {
    if (y < FIRST_YEAR) continue; const dt = await dates(y);
    if (!s.years[y] && today > dt.formation && today <= dt.entry) {
      if (today === dt.entry) { s.years[y] = { Y: y, missed: true, why: "formation not sealed before the entry session" }; ledger({ kind: "missed", Y: y }); starving = true; save(s); }
      else { try { if (!(await form(s, y, dt))) starving = true; } catch (e) { console.log(`r282: formation ${y} not yet possible (${e.message}); retry tomorrow`); } save(s); }
    }
    if (!s.years[y] && today > dt.entry) { s.years[y] = { Y: y, missed: true, why: "no formation before entry" }; ledger({ kind: "missed", Y: y }); starving = true; save(s); }
    const M = s.years[y]; if (M && M.sealed && !M.settled && dt.exit && today > dt.exit) { await settle(s, y); save(s); }
  }
  status(s);
  if (starving) { console.error("r282: STARVING — see ledger"); process.exit(1); }
})().catch((e) => { console.error("R282 FAILED:", e.message); process.exit(1); });
