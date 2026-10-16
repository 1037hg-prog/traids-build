#!/usr/bin/env node
/**
 * R325 — GOLD OVERNIGHT, FORWARD (registered 2026-10-05; operator: "go 1-3"). R214 (sealed PASS 2026-09-25: long GLD close -> next open,
 * 2 bps a night, monthly t 2.919 vs 2.288) gets the forward record it never had. Its 09-25 audit (data/r212-r214-audit.json) found the
 * overnight leg is mostly gold itself (alpha on GLD t 0.84, beta 0.53), so the PRIMARY here is the part that is not gold's direction:
 * the SPREAD night d = [open(d+1)/close(d) - 1 - 0.0002] - [close(d+1)/open(d+1) - 1] — the overnight leg net minus the next session's
 * intraday leg. QUOTE-PRICED from official daily bars (Alpaca SIP 1Day, adjustment "all" — R214's source and request form). No orders.
 * Weekends and holidays are one night (Friday close -> Monday open), exactly as R214 measured. A night is scored only once the next
 * session's bar is from an earlier ET date than the run (final), so each night lands on the second evening after it starts.
 *
 *   node backend/r325-gold-overnight-forward.js --selftest
 *   node backend/r325-gold-overnight-forward.js --score      nightly (close chain): appends every final night once; one interim look at 250
 *   node backend/r325-gold-overnight-forward.js --status
 *   node backend/r325-gold-overnight-forward.js --read       ONCE at >= 750 nights; refuses earlier, if sealed, or already read
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const LEDGER = D("r325-ledger.jsonl"), STATE = D("r325-state.json"), OUT = D("r325-gold-overnight-forward.json"), ID = "R325";
const EVIDENCE_FROM = "2026-10-05", COST = 0.0002, READ_N = 750, KILL_N = 250, KILL_T = -2.0, NW_LAG = 5;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function nwT(a, L = NW_LAG) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let l = 1; l <= L; l++) { let c = 0; for (let i = l; i < n; i++) c += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * c / n; } return v > 0 ? m / Math.sqrt(v / n) : null; }
// nights from a daily bar series: night d = close(d) -> open(d+1), its comparison leg = open(d+1) -> close(d+1); close date >= from
function nightsOf(bars, from = EVIDENCE_FROM) {
  const out = [];
  for (let i = 0; i + 1 < bars.length; i++) { const d = bars[i].d; if (d < from) continue; const c = bars[i].c, o = bars[i + 1].o, c1 = bars[i + 1].c;
    if (!(c > 0 && o > 0 && c1 > 0)) continue; const gross = o / c - 1, net = gross - COST, intraday = c1 / o - 1;
    out.push({ night: d, next: bars[i + 1].d, gross, net, intraday, spread: net - intraday }); }
  return out;
}
const etDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const finalBars = (rows, today) => rows.filter((b) => b.d < today);   // a session's bar counts only from a later ET date
const readLedger = () => (fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
async function fetchDaily(syms) {
  const { fetchBars } = require("./lib/alpaca-bars.js");
  const end = new Date(Date.now() - 20 * 60000).toISOString();   // outside the SIP 15-minute delay
  const { bars } = await fetchBars(syms, { start: "2026-09-20", end, feed: "sip", adjustment: "all", requireAll: true, quiet: true });
  const today = etDate(), out = {};
  for (const s of syms) out[s] = finalBars((bars[s] || []).map((b) => ({ d: String(b.t).slice(0, 10), o: b.o, c: b.c })), today);
  return out;
}
function summary(rows) {
  const sp = rows.map((r) => r.spread), on = rows.map((r) => r.gldNet);
  let e = null; try { const { bettingE } = require("./lib/evalue.js"); if (sp.length >= 20) { const r = bettingE(sp); e = { e: +r.e.toFixed(3), maxE: +r.maxE.toFixed(3), note: "reported only — anytime-valid lens, never gates" }; } } catch (_) { e = null; }
  return { n: rows.length, spreadMeanBps: sp.length ? +(mean(sp) * 1e4).toFixed(3) : null, spreadT: sp.length >= 3 ? +nwT(sp).toFixed(3) : null,
    overnightNetMeanBps: on.length ? +(mean(on) * 1e4).toFixed(3) : null, overnightT: on.length >= 3 ? +nwT(on).toFixed(3) : null,
    winRatePct: on.length ? +(100 * on.filter((x) => x > 0).length / on.length).toFixed(1) : null, eValue: e };
}
async function score() {
  const have = new Set(readLedger().map((r) => r.night));
  const B = await fetchDaily(["GLD", "SPY", "SLV"]);
  const by = (s) => new Map(nightsOf(B[s]).map((x) => [x.night, x]));
  const spy = by("SPY"), slv = by("SLV"); let added = 0;
  for (const n of nightsOf(B.GLD)) {
    if (have.has(n.night)) continue;
    const row = { kind: "night", night: n.night, next: n.next, spread: +n.spread.toFixed(6), gldGross: +n.gross.toFixed(6), gldNet: +n.net.toFixed(6), gldIntraday: +n.intraday.toFixed(6),
      spyOvernight: spy.has(n.night) ? +spy.get(n.night).gross.toFixed(6) : null, slvOvernight: slv.has(n.night) ? +slv.get(n.night).gross.toFixed(6) : null, scoredAt: new Date().toISOString() };
    fs.appendFileSync(LEDGER, JSON.stringify(row) + "\n"); added++;
  }
  const rows = readLedger(), n = rows.length, prev = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
  let kill = prev.interimKill || null;   // ONE look, at the first run with >= 250 nights; recorded once, never re-taken
  if (!kill && n >= KILL_N) { const t = nwT(rows.slice(0, KILL_N).map((r) => r.spread)); kill = { at: KILL_N, lookedOn: etDate(), spreadT: t == null ? null : +t.toFixed(3), triggered: t != null && t <= KILL_T }; }
  writeJsonAtomic(STATE, { id: ID, asOf: new Date().toISOString(), nights: n, firstNight: rows[0] ? rows[0].night : null, lastNight: rows[n - 1] ? rows[n - 1].night : null, readyToRead: n >= READ_N, interimKill: kill, running: summary(rows) });
  console.log(`R325 score: +${added} night(s); ${n} total${n >= READ_N ? " — READY TO READ" : ` (${READ_N - n} to the read)`}${kill && kill.triggered ? ` — INTERIM KILL spread t ${kill.spreadT}` : ""}`);
  if (kill && kill.triggered && !prev.interimKill) { try { await require("./notify.js").notify("R325 interim kill", `GLD overnight-minus-intraday spread NW t ${kill.spreadT} at ${KILL_N} nights (kill bar ${KILL_T}) — stop the record; operator decides`, { email: false }); } catch (e) { console.log("R325 alert failed: " + e.message); } }
  return 0;
}
function read() {
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if ((seals.tests || {})[ID]) { console.error(`${ID} already sealed — refusing`); return 2; }
  if (fs.existsSync(OUT) && JSON.parse(fs.readFileSync(OUT, "utf8")).read) { console.error(`${ID} already read — refusing`); return 2; }
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === ID); if (!t) { console.error(`${ID} not registered`); return 2; }
  const rows = readLedger().slice(0, READ_N); if (rows.length < READ_N) { console.error(`${ID} has ${rows.length} of ${READ_N} nights — refusing`); return 2; }
  const sp = rows.map((r) => r.spread), tSp = nwT(sp), m = mean(sp), bar = Number(t.bar.tRequired), half = Math.floor(READ_N / 2);
  const h1 = mean(sp.slice(0, half)), h2 = mean(sp.slice(half)), s = summary(rows);
  const gates = { nightsAtLeast750: rows.length >= READ_N, spreadMeanPositive: m > 0, spreadTAtLeastBar: tSp != null && tSp >= bar, bothHalvesPositive: h1 > 0 && h2 > 0, overnightNetPositive: s.overnightNetMeanBps > 0 };
  const pass = Object.values(gates).every(Boolean);
  const out = { id: ID, read: true, asOf: new Date().toISOString(), unit: "nights", n: rows.length, spreadT: tSp == null ? null : +tSp.toFixed(4), spreadMeanBps: +(m * 1e4).toFixed(3), bar, gates,
    halvesBps: { first: +(h1 * 1e4).toFixed(3), second: +(h2 * 1e4).toFixed(3) }, verdictScript: pass ? "PASS" : "DID NOT PASS",
    reported: { ...s, intradayMeanBps: +(mean(rows.map((r) => r.gldIntraday)) * 1e4).toFixed(3), spyOvernightMeanBps: +(mean(rows.map((r) => r.spyOvernight).filter((x) => x != null)) * 1e4).toFixed(3),
      slvOvernightMeanBps: +(mean(rows.map((r) => r.slvOvernight).filter((x) => x != null)) * 1e4).toFixed(3), firstNight: rows[0].night, lastNight: rows[READ_N - 1].night } };
  writeJsonAtomic(OUT, out);
  console.log(`R325 READ — ${out.verdictScript}: spread ${out.spreadMeanBps} bps/night, NW t ${out.spreadT} vs ${bar}; overnight net ${s.overnightNetMeanBps} bps (win ${s.winRatePct}%); halves ${out.halvesBps.first} / ${out.halvesBps.second} bps`);
  return 0;
}
function selftest() {
  const checks = {};
  const bars = [{ d: "2026-10-02", o: 100, c: 101 }, { d: "2026-10-05", o: 102, c: 103 }, { d: "2026-10-06", o: 102.5, c: 104 }, { d: "2026-10-07", o: 105, c: 104 }];
  const n = nightsOf(bars);
  checks.evidenceStartRespected = n.length === 2 && n[0].night === "2026-10-05";
  const g = 102.5 / 103 - 1, id = 104 / 102.5 - 1;
  checks.nightArithmetic = Math.abs(n[0].gross - g) < 1e-12 && Math.abs(n[0].net - (g - COST)) < 1e-12 && Math.abs(n[0].intraday - id) < 1e-12 && Math.abs(n[0].spread - (g - COST - id)) < 1e-12;
  checks.weekendIsOneNight = nightsOf([{ d: "2026-10-09", o: 1, c: 10 }, { d: "2026-10-12", o: 11, c: 12 }], "2026-10-09")[0].next === "2026-10-12";
  checks.lastBarHasNoNight = n[n.length - 1].night === "2026-10-06";
  checks.todaysBarNeverScored = finalBars(bars, "2026-10-07").length === 3 && nightsOf(finalBars(bars, "2026-10-07")).length === 1;
  checks.nwKnown = Math.abs(nwT([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0) - (5.5 / Math.sqrt(8.25 / 10))) < 1e-9;
  const ok = Object.values(checks).every(Boolean); console.log(`R325 selftest ${ok ? "PASS" : "FAIL"} ${JSON.stringify(checks)}`); return ok;
}
if (require.main === module) {
  const a = process.argv.slice(2);
  (async () => {
    if (!selftest()) process.exit(1);
    if (a.includes("--selftest")) return;
    if (a.includes("--read")) { process.exitCode = read(); return; }
    if (a.includes("--status")) { const s = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : null; console.log(s ? `R325: ${s.nights} night(s) ${s.firstNight}..${s.lastNight} ${JSON.stringify(s.running)}` : "R325: no state yet"); return; }
    if (a.includes("--score")) { process.exitCode = await score(); return; }
    console.log("usage: --selftest | --score | --status | --read");
  })().catch((e) => { console.error("R325 FAILED: " + e.message); process.exitCode = 4; });   // exitCode, never exit(): a hard exit with a fetch socket closing aborts node on Windows (libuv UV_HANDLE_CLOSING)
} else module.exports = { nightsOf, nwT, finalBars };
