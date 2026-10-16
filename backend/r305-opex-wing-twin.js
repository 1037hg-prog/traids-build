#!/usr/bin/env node
/**
 * R305 — R299's EXPIRATION-WEEKEND EFFECT IN OUR OWN SHORT-PREMIUM BOOK (registered 2026-10-01, operator: "yes" to "set up the R299
 * timing twin on the R21 wings").
 *
 * R299 (sealed PASS 2026-10-01): short option premium held from the Thursday close before the monthly expiration to the Monday close
 * after earned +27 bps more than the same structure one week earlier (covered-call rolling cheapens options around expiration). It was
 * measured on ATM next-month single-stock calls; this asks whether it shows in what we actually sell — R21's short 25-delta verticals
 * (calls and puts, SPY/QQQ/IWM + rotating names, weekly 5-12 DTE). NO NEW TRADES: it reads the 30-minute wing marks the book already
 * records (data/wing-marks.jsonl, cost-to-close at mid, live wings and R21 shadows).
 *
 * STATISTIC (unit = monthly expiration): window E = the last session before the monthly expiration (normally Thursday) close -> the first
 * session after it (normally Monday) close; window C = the same weekdays one week earlier. For each wing open at both ends of a window and
 * expiring after the window ends: dR = (mid at start - mid at end) / spread width (positive = the short wing gained). Per cell (CALL wings,
 * PUT wings): D_e = mean dR over E wings - mean dR over C wings, needing >= 5 wings in each window. One-sample t over expirations from
 * 2026-10; best-of-2 cells; read once at 12 expirations.
 * MODES  (default) write data/r305-opex-wing-twin.json [close chain]  ·  --read (once, seals)  ·  --selftest
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const ID = "R305", OUT = D("r305-opex-wing-twin.json"), EVIDENCE_FROM = "2026-10", READ_AT = 12, MIN_WINGS = 5;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
const etDate = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const etHM = (iso) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });
const strike = (occ) => Number(String(occ).slice(-8)) / 1000;
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
/** third Friday of each month (the standard monthly expiration date; a holiday Friday is handled by the session lookup) */
function thirdFridays(fromYM, toYM) {
  const out = []; let [y, m] = fromYM.split("-").map(Number); const [ty, tm] = toYM.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) { const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(), day = 1 + ((5 - first + 7) % 7) + 14; out.push(`${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
/** marks -> { wings: Map(id -> {right, expiry, width, shadow, byDate: Map(etDate -> last RTH mid)}), sessions: sorted ET dates with marks } */
function index(lines) {
  const wings = new Map(), sessions = new Set();
  for (const m of lines) {
    if (!m || !m.originId || !(m.mid >= 0) || !m.at) continue; const d = etDate(m.at), hm = etHM(m.at); if (hm < "09:30" || hm > "16:00") continue;
    sessions.add(d);
    let w = wings.get(m.originId); if (!w) { const width = Math.abs(strike(m.shortOcc) - strike(m.longOcc)); w = { id: m.originId, right: m.right, expiry: m.expiry, width, shadow: !!m.shadow, byDate: new Map() }; wings.set(m.originId, w); }
    const prev = w.byDate.get(d); if (!prev || prev.at < m.at) w.byDate.set(d, { at: m.at, mid: Number(m.mid) });
  }
  return { wings, sessions: [...sessions].sort() };
}
function windowDR(ix, d0, d1, right) {
  const out = [];
  for (const w of ix.wings.values()) { if (w.right !== right || !(w.width > 0) || !(w.expiry > d1)) continue; const a = w.byDate.get(d0), b = w.byDate.get(d1); if (!a || !b) continue; out.push({ id: w.id, shadow: w.shadow, dR: (a.mid - b.mid) / w.width }); }
  return out;
}
function compute(ix, todayET) {
  const exps = thirdFridays(EVIDENCE_FROM, todayET.slice(0, 7)), rows = [];
  for (const fri of exps) {
    const before = ix.sessions.filter((d) => d < fri && d >= addDays(fri, -4)), after = ix.sessions.filter((d) => d > fri && d <= addDays(fri, 5));
    const e0 = before[before.length - 1], e1 = after[0]; if (!e0 || !e1 || e1 >= todayET) { rows.push({ expiration: fri, status: e1 && e1 >= todayET ? "pending" : "no sessions with marks" }); continue; }
    const c0s = ix.sessions.filter((d) => d <= addDays(e0, -7) && d >= addDays(e0, -10)), c1s = ix.sessions.filter((d) => d >= addDays(e1, -7) && d < e0);
    const c0 = c0s[c0s.length - 1], c1 = c1s[0]; if (!c0 || !c1) { rows.push({ expiration: fri, e: [e0, e1], status: "control window has no marks" }); continue; }
    const row = { expiration: fri, e: [e0, e1], c: [c0, c1], cells: {} };
    for (const [cell, right] of [["CALL", "C"], ["PUT", "P"]]) {
      const E = windowDR(ix, e0, e1, right), C = windowDR(ix, c0, c1, right);
      row.cells[cell] = { nE: E.length, nC: C.length, meanE: E.length ? +mean(E.map((x) => x.dR)).toFixed(5) : null, meanC: C.length ? +mean(C.map((x) => x.dR)).toFixed(5) : null,
        D: E.length >= MIN_WINGS && C.length >= MIN_WINGS ? +(mean(E.map((x) => x.dR)) - mean(C.map((x) => x.dR))).toFixed(5) : null,
        liveOnlyD: (() => { const e = E.filter((x) => !x.shadow), c = C.filter((x) => !x.shadow); return e.length >= MIN_WINGS && c.length >= MIN_WINGS ? +(mean(e.map((x) => x.dR)) - mean(c.map((x) => x.dR))).toFixed(5) : null; })() };
    }
    row.status = "measured"; rows.push(row);
  }
  const cells = {};
  for (const cell of ["CALL", "PUT"]) { const x = rows.filter((r) => r.status === "measured" && r.cells[cell].D != null).map((r) => r.cells[cell].D), t = tOf(x);
    cells[cell] = { expirations: x.length, meanD: x.length ? +mean(x).toFixed(5) : null, tD: t == null ? null : +t.toFixed(3), positive: x.filter((v) => v > 0).length }; }
  return { rows, cells };
}
function load() { return fs.readFileSync(D("wing-marks.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }); }
function write() {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }), ix = index(load()), c = compute(ix, today);
  const n = Math.max(c.cells.CALL.expirations, c.cells.PUT.expirations), best = ["CALL", "PUT"].map((k) => [k, c.cells[k]]).filter(([, v]) => v.tD != null).sort((a, b) => b[1].tD - a[1].tD)[0];
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
  const out = { id: ID, asOf: new Date().toISOString(), evidenceFrom: EVIDENCE_FROM, readAt: READ_AT, marksFrom: ix.sessions[0] || null, marksTo: ix.sessions[ix.sessions.length - 1] || null, wingsMarked: ix.wings.size, ...c,
    nextExpiration: c.rows.find((r) => r.status === "pending")?.expiration || thirdFridays(today.slice(0, 7), "2099-12").find((f) => f > today) || null,
    status: n >= READ_AT ? "READY TO READ" : `ACCRUING — ${n}/${READ_AT} expirations`,
    dailyClock: { sessions: n, estimate: best ? best[1].meanD : null, unit: "expiration-weekend minus prior-weekend short-wing gain, fraction of spread width, per monthly expiration (better cell)" },
    read: prev.read || null };
  writeJsonAtomic(OUT, out);
  console.log(`[r305] ${out.status} · CALL ${JSON.stringify(c.cells.CALL)} · PUT ${JSON.stringify(c.cells.PUT)} · next ${out.nextExpiration} · ${ix.wings.size} wings marked ${out.marksFrom}..${out.marksTo}`);
}
function read() {
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((e) => e.id === ID), seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if ((seals.tests || {})[ID]) throw new Error("already sealed — read once"); const o = JSON.parse(fs.readFileSync(OUT, "utf8")); if (o.read) throw new Error("already read");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }), c = compute(index(load()), today), bar = t.bar.tRequired, res = {};
  for (const cell of ["CALL", "PUT"]) { const x = c.rows.filter((r) => r.status === "measured" && r.cells[cell].D != null).slice(0, READ_AT).map((r) => r.cells[cell].D); if (x.length < READ_AT) throw new Error(`${cell}: ${x.length} expirations < ${READ_AT} — refusing`); res[cell] = { meanD: +mean(x).toFixed(5), tD: +tOf(x).toFixed(3) }; }
  const verdict = Object.values(res).some((r) => r.tD >= bar && r.meanD > 0) ? "PASS" : "DID NOT PASS";
  writeJsonAtomic(OUT, { ...o, read: { verdict, bar, cells: res, readAt: new Date().toISOString() } });
  seals.tests = seals.tests || {}; seals.tests[ID] = { sealedOn: today, unit: "monthly expirations (first 12 from 2026-10), best-of-2 cells", verdict: `${verdict} — CALL t ${res.CALL.tD} (mean ${res.CALL.meanD}), PUT t ${res.PUT.tD} (mean ${res.PUT.meanD}) vs bar ${bar}`, output: "data/r305-opex-wing-twin.json" };
  writeJsonAtomic(D("read-seals.json"), seals); console.log(seals.tests[ID].verdict);
}
function selftest() {
  const ok = [];
  ok.push(["third Fridays: 2026-10-16, 2026-11-20, 2026-12-18, 2027-01-15", JSON.stringify(thirdFridays("2026-10", "2027-01")) === JSON.stringify(["2026-10-16", "2026-11-20", "2026-12-18", "2027-01-15"])]);
  ok.push(["OCC strike parse: SPY261016C00680000 = 680", strike("SPY261016C00680000") === 680]);
  const mk = (id, right, exp, d, hm, mid, shadow) => ({ at: new Date(`${d}T${hm}:00-04:00`).toISOString(), originId: id, right, expiry: exp, shortOcc: `X261030${right}00100000`, longOcc: `X261030${right}00101000`, mid, shadow });
  const L = [];
  for (let i = 0; i < 6; i++) { const id = "c" + i; L.push(mk(id, "C", "2026-10-30", "2026-10-15", "15:30", 0.5), mk(id, "C", "2026-10-30", "2026-10-15", "10:00", 0.9), mk(id, "C", "2026-10-30", "2026-10-19", "15:30", 0.3)); }   // E: 0.5 -> 0.3 on width 1 = +0.2
  for (let i = 0; i < 6; i++) { const id = "k" + i; L.push(mk(id, "C", "2026-10-23", "2026-10-08", "15:30", 0.5), mk(id, "C", "2026-10-23", "2026-10-12", "15:30", 0.45)); }   // C: +0.05
  L.push(mk("z", "C", "2026-10-16", "2026-10-15", "15:30", 0.5), mk("z", "C", "2026-10-16", "2026-10-19", "15:30", 0.0));   // expires inside the window: excluded
  const c = compute(index(L), "2026-10-25"), r = c.rows.find((x) => x.expiration === "2026-10-16");
  ok.push(["windows: E 10-15 -> 10-19, C 10-08 -> 10-12", r && r.e.join() === "2026-10-15,2026-10-19" && r.c.join() === "2026-10-08,2026-10-12"]);
  ok.push(["last RTH mark of the day is used; D = 0.20 - 0.05 = 0.15", r && r.cells.CALL.D === 0.15 && r.cells.CALL.nE === 6]);
  ok.push(["a wing expiring inside the window is excluded; < 5 wings = no D (PUT)", r && r.cells.CALL.nE === 6 && r.cells.PUT.D === null]);
  for (const [n, v] of ok) console.log(v ? "ok  " : "FAIL", n); if (ok.some(([, v]) => !v)) process.exit(1); console.log("selftest passed");
}
const mode = process.argv.includes("--selftest") ? "selftest" : process.argv.includes("--read") ? "read" : "write";
try { ({ selftest, read, write })[mode](); } catch (e) { console.error("[r305] FAILED:", e.message); process.exit(1); }
