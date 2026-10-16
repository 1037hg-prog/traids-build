#!/usr/bin/env node
/**
 * R281 — EARNINGS SEASONALITY (earnrank), FORWARD. Registered 2026-09-28 in backend/register-r281-r282.js (the registry wins).
 * R278's sealed historical read was the 09-28 scout's near-miss (3-year top-minus-bottom +0.86%/mo, t 2.05 vs 2.253; wrong-quarter
 * placebo t 0.06). This writer runs the identical rule (lib/earnrank.js, lifted verbatim from r278-earnrank.js) on months R278 never saw.
 *
 * SIP-PRICED SHADOW, not broker orders: each name is priced open(first session) -> close(last session) from Alpaca SIP daily bars — the
 * same pricing the historical read used — so the forward record is comparable and cannot collide with other paper sleeves' positions.
 *
 *   node backend/r281-earnrank-forward.js --selftest      known answer: the lib reproduces R278's sealed signal rows from R278's own cache
 *   node backend/r281-earnrank-forward.js --after-close   close chain: FORM + SEAL next month's quintiles on the last session of a month;
 *                                                          SETTLE every formed month whose last session has passed; print status
 *   node backend/r281-earnrank-forward.js --status        status + e-value lens, no network writes
 *   node backend/r281-earnrank-forward.js --read          the one registered fixed read (36 settled months; read-once)
 *
 * Exit 1 = STARVING (a formation was missed, or the universe cannot be built point-in-time) — loud on purpose (fail-open invariant).
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { firmQuarters, signalsForMonth } = require("./lib/earnrank.js");
const D = (f) => path.join(__dirname, "data", f), STATE = D("r281-earnrank-forward.json"), LEDGER = D("r281-earnrank-forward.jsonl"), CACHE = D("training/r281");
const FIRST_MONTH = "2026-10", COST = 0.002, MIN_FIRMS = 25, READ_MONTHS = 36, TTL_DAYS = 20, MDE = 0.0025;
const BAR = 1.69;   // replaced from the registry at runtime (registry wins)
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
const DRY = process.argv.includes("--dry-form");
const mode = ["--selftest", "--after-close", "--status", "--read", "--dry-form"].find((m) => process.argv.includes(m)) || "--status";
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
const etDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const load = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { spec: "r281-state-v1", months: {} });
const save = (s) => { s.asOf = new Date().toISOString(); writeJsonAtomic(STATE, s); };
const ledger = (o) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
const nextYm = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };
async function calendar(start, end) { const r = await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${start}&end=${end}`, { headers: H, signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error("calendar HTTP " + r.status); return (await r.json()).map((c) => c.date); }
const monthSessions = async (ym) => { const [y, m] = ym.split("-").map(Number); return calendar(`${ym}-01`, new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)); };
const seedOf = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 281);

async function selftest() {
  const S = JSON.parse(fs.readFileSync(D("r278-signals.json"), "utf8")), cik = JSON.parse(fs.readFileSync(D("edgar-cik-map.json"), "utf8"));
  const syms = [...new Set(S.signals.map((x) => x.sym))].slice(0, 40); let rows = 0, mism = 0;
  for (const sym of syms) {
    const c10 = String(cik[sym] || cik[sym.replace(".", "-")]).padStart(10, "0"), F = await firmQuarters(c10, D("training/r278"), null); if (!F) { mism++; continue; }
    for (const want of S.signals.filter((x) => x.sym === sym)) { rows++;
      const got = signalsForMonth(F.Qs, want.ym, want.formation).find((g) => g.q4End === want.q4End);
      if (!got || got.y3 !== want.y3 || got.y5 !== want.y5 || got.y3Placebo !== want.y3Placebo) mism++; }
  }
  console.log(`selftest: ${syms.length} firms, ${rows} sealed R278 rows re-derived by lib/earnrank.js, ${mism} mismatches (${mism === 0 ? "OK" : "FAIL"})`);
  process.exit(mism === 0 ? 0 : 1);
}

async function form(s, ym, formation) {
  const { pitTopN } = require("./lib/tv-pit-panel.js");
  const Y = +ym.slice(0, 4), U = pitTopN(Y, 500);
  if (!(U.refDate && U.refDate.startsWith(`${Y - 1}-12`))) { ledger({ kind: "starved", ym, why: `panel cannot rank ${Y} point-in-time (refDate ${U.refDate}); refresh anomaly-cache-v2 through ${Y - 1}-12-31` }); return false; }
  const cik = JSON.parse(fs.readFileSync(D("edgar-cik-map.json"), "utf8")); const rows = [], counts = { universe: U.names.length, noCik: 0, noConcept: 0, errors: 0 };
  for (const sym of U.names) {
    const c = cik[sym] || cik[sym.replace(".", "-")]; if (!c) { counts.noCik++; continue; }
    try { const F = await firmQuarters(String(c).padStart(10, "0"), CACHE, TTL_DAYS); if (!F) { counts.noConcept++; continue; }
      for (const r of signalsForMonth(F.Qs, ym, formation)) if (r.y3 != null) rows.push({ sym, ...r }); } catch { counts.errors++; }
  }
  let seed = seedOf(ym); const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const quint = (key) => { const xs = rows.filter((r) => r[key] != null).map((r) => ({ sym: r.sym, v: r[key], tb: rnd() })).sort((a, b) => a.v - b.v || a.tb - b.tb), n = xs.length;
    return { n, top: xs.filter((_, i) => Math.floor((i * 5) / n) === 4).map((x) => x.sym), bottom: xs.filter((_, i) => Math.floor((i * 5) / n) === 0).map((x) => x.sym) }; };
  const lists = { y3: quint("y3"), y5: quint("y5") };
  const body = { ym, formation, formedAt: new Date().toISOString(), refDate: U.refDate, counts, lists, signals: rows };
  const sha = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
  if (DRY) { console.log(`r281 DRY formation ${ym}: ${JSON.stringify(counts)}, y3 n ${lists.y3.n} top ${lists.y3.top.length} bottom ${lists.y3.bottom.length}; y5 n ${lists.y5.n} — nothing sealed`); return true; }
  s.months[ym] = { ...body, sha256: sha, sealed: true };
  ledger({ kind: "formed", ym, formation, sha256: sha, y3: { n: lists.y3.n, top: lists.y3.top.length, bottom: lists.y3.bottom.length }, counts });
  console.log(`r281: formed ${ym} — ${lists.y3.n} signalled firms (y3), top ${lists.y3.top.length} / bottom ${lists.y3.bottom.length}; sha ${sha.slice(0, 12)}`);
  return true;
}

async function settle(s, ym) {
  const M = s.months[ym], ses = await monthSessions(ym), first = ses[0], lastS = ses.at(-1);
  const { fetchBars } = require("./lib/alpaca-bars.js");
  const names = [...new Set([...M.lists.y3.top, ...M.lists.y3.bottom, ...M.lists.y5.top, ...M.lists.y5.bottom])];
  const r = await fetchBars(["SPY", ...names], { start: first, end: lastS + "T23:00:00Z", feed: "sip", adjustment: "all", quiet: true, requireAll: false, chunkSize: 40 });
  const ret = (sym) => { const bs = (r.bars[sym] || []).filter((b) => b.t.slice(0, 10) >= first && b.t.slice(0, 10) <= lastS); if (!bs.length || bs[0].t.slice(0, 10) !== first || !(bs[0].o > 0)) return null; return bs.at(-1).c / bs[0].o - 1; };
  const spy = ret("SPY"); if (spy == null) throw new Error(`no SPY bars for ${ym}`);
  const leg = (xs) => { const rs = xs.map(ret).filter((x) => x != null); return { n: rs.length, excluded: xs.length - rs.length, net: rs.length ? mean(rs) - COST : null }; };
  const res = {};
  for (const k of ["y3", "y5"]) { const L = M.lists[k]; if (L.n < MIN_FIRMS) { res[k] = { thin: true, n: L.n }; continue; }
    const top = leg(L.top), bot = leg(L.bottom); res[k] = { n: L.n, top, bottom: bot, topMinusBottom: top.net - bot.net, topMinusSpy: top.net - spy }; }
  M.settled = { at: new Date().toISOString(), first, last: lastS, spy, ...res };
  ledger({ kind: "settled", ym, y3TB: res.y3 && res.y3.topMinusBottom, y3TS: res.y3 && res.y3.topMinusSpy, y5TB: res.y5 && res.y5.topMinusBottom, spy });
  console.log(`r281: settled ${ym} — y3 top-bottom ${res.y3 && res.y3.topMinusBottom != null ? (100 * res.y3.topMinusBottom).toFixed(2) + "%" : "thin"}`);
}

function series(s, key = "y3", f = "topMinusBottom") { return Object.values(s.months).filter((m) => m.settled && m.settled[key] && m.settled[key][f] != null).sort((a, b) => (a.ym < b.ym ? -1 : 1)).map((m) => m.settled[key][f]); }
function status(s) {
  const { sequentialVerdict } = require("./lib/evalue.js");
  const x = series(s), sv = sequentialVerdict(x, { mde: MDE, minN: 6 });
  const formed = Object.keys(s.months).sort(), settled = formed.filter((k) => s.months[k].settled);
  console.log(`r281 status: formed ${formed.length} (${formed.join(", ") || "none"}), settled ${settled.length}/${READ_MONTHS}; y3 top-bottom ${x.length ? (100 * mean(x)).toFixed(3) + "%/mo t " + tOf(x).toFixed(2) : "—"}; e-value ${sv.verdict}: ${sv.why}`);
  return sv;
}

(async () => {
  if (mode === "--selftest") return selftest();
  const s = load();
  if (mode === "--status") { status(s); return; }
  if (mode === "--dry-form") { const ym = FIRST_MONTH, ses = await monthSessions(ym); await form({ months: {} }, ym, ses[0]); return; }
  if (mode === "--read") {
    const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests.R281) throw new Error("R281 already sealed — read-once");
    const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), bar = reg.preregistered.find((t) => t.id === "R281").bar.tRequired;
    const x = series(s); if (x.length < READ_MONTHS) throw new Error(`only ${x.length} settled months; read needs ${READ_MONTHS}`);
    const xs = x.slice(0, READ_MONTHS), t = tOf(xs), pass = t >= bar;
    const verdict = `${pass ? "PASSED" : "DID NOT PASS"} — y3 top-bottom ${(100 * mean(xs)).toFixed(3)}%/mo t ${t.toFixed(3)} vs bar ${bar} over ${READ_MONTHS} forward months; top-SPY ${(100 * mean(series(s, "y3", "topMinusSpy").slice(0, READ_MONTHS))).toFixed(3)}%/mo`;
    seals.tests = seals.tests || {}; seals.tests.R281 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "forward months, one-sample t", verdict, output: "data/r281-earnrank-forward.json" };
    writeJsonAtomic(D("read-seals.json"), seals); console.log(verdict); return;
  }
  // --after-close
  const today = etDate(); let starving = false;
  const ahead = await calendar(today, new Date(Date.parse(today) + 12 * 864e5).toISOString().slice(0, 10));
  if (ahead[0] === today && ahead[1] && ahead[1].slice(0, 7) !== today.slice(0, 7)) {
    const ym = ahead[1].slice(0, 7);
    if (ym >= FIRST_MONTH && !s.months[ym]) { if (!(await form(s, ym, ahead[1]))) starving = true; save(s); }
  }
  // a month whose first session has passed without a formation is a MISSED delivery, never backfilled
  for (let ym = FIRST_MONTH; ym <= today.slice(0, 7); ym = nextYm(ym)) {
    if (s.months[ym]) continue; const ses = await monthSessions(ym); if (ses[0] && ses[0] <= today) { s.months[ym] = { ym, missed: true, why: "not formed before the month's first session" }; ledger({ kind: "missed", ym }); starving = true; save(s); }
  }
  for (const [ym, M] of Object.entries(s.months)) { if (!M.sealed || M.settled) continue; const ses = await monthSessions(ym); if (ses.at(-1) < today) { await settle(s, ym); save(s); } }
  status(s);
  if (starving) { console.error("r281: STARVING — see ledger"); process.exit(1); }
})().catch((e) => { console.error("R281 FAILED:", e.message); process.exit(1); });
