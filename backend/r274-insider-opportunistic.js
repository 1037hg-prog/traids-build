#!/usr/bin/env node
/**
 * R274 — OPPORTUNISTIC insider purchases (Cohen, Malloy & Pomorski 2012). Registered 2026-09-27 in backend/register-r274.js (the registry wins).
 *   --signals   OUTCOME-FREE: parse data/sec-insider bulk Form 4 files, classify insiders routine/opportunistic per year, write monthly lists
 *   --read      the one registered read: next-month equal-weight portfolio vs IWM, month-shuffle control, seal
 * Parsing follows r137-insider-signals.js (original Form 4, officer/director owners, non-derivative common stock).
 */
"use strict";
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), DIR = D("sec-insider"), SIG = D("r274-signals.json"), OUT = D("r274-insider-opportunistic.json");
const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const iso = (d) => { const m = /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec(String(d || "").trim()); return m ? `${m[3]}-${MON[m[2]]}-${m[1]}` : null; };
const tsv = (zip, name) => { const txt = execFileSync("unzip", ["-p", path.join(DIR, zip), name], { maxBuffer: 1 << 30 }).toString("utf8"), lines = txt.split(/\r?\n/), h = lines[0].split("\t"); return { h: Object.fromEntries(h.map((k, i) => [k, i])), rows: lines.slice(1).filter(Boolean).map((l) => l.split("\t")) }; };
const FIRST = "2022-01", LAST = "2025-11", MIN_USD = 10000, COST = 0.002, BAR = 2.016, DRAWS = 1000;
const mode = ["--signals", "--read"].find((m) => process.argv.includes(m)) || "--signals";
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tOf = (a) => (a.length > 2 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
const nextMonth = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };

function buildSignals() {
  const trades = new Map();   // ownerCik -> Set("YYYY-MM") of P/S transaction months (classification)
  const filings = [];         // { owner, sym, filedYm, year, buyUsd, sellUsd }
  for (const zip of fs.readdirSync(DIR).filter((f) => /_form345\.zip$/.test(f)).sort()) {
    const S = tsv(zip, "SUBMISSION.tsv"), T = tsv(zip, "NONDERIV_TRANS.tsv"), O = tsv(zip, "REPORTINGOWNER.tsv");
    const sub = new Map(); for (const r of S.rows) if (r[S.h.DOCUMENT_TYPE] === "4") sub.set(r[S.h.ACCESSION_NUMBER], { filed: iso(r[S.h.FILING_DATE]), sym: String(r[S.h.ISSUERTRADINGSYMBOL] || "").toUpperCase().trim() });
    const own = new Map(); for (const r of O.rows) { if (/officer|director/i.test(r[O.h.RPTOWNER_RELATIONSHIP] || "")) (own.get(r[O.h.ACCESSION_NUMBER]) || own.set(r[O.h.ACCESSION_NUMBER], []).get(r[O.h.ACCESSION_NUMBER])).push(r[O.h.RPTOWNERCIK]); }
    const agg = new Map();
    for (const r of T.rows) {
      const code = r[T.h.TRANS_CODE], ad = r[T.h.TRANS_ACQUIRED_DISP_CD], acc = r[T.h.ACCESSION_NUMBER];
      if (!((code === "P" && ad === "A") || (code === "S" && ad === "D"))) continue; if (!sub.has(acc) || !own.has(acc)) continue;
      if (!/common|ordinary|class [ab]\b/i.test(r[T.h.SECURITY_TITLE] || "")) continue;
      const sh = +r[T.h.TRANS_SHARES], px = +r[T.h.TRANS_PRICEPERSHARE]; if (!(sh > 0) || !(px > 0)) continue;
      const td = iso(r[T.h.TRANS_DATE]); const a = agg.get(acc) || agg.set(acc, { buy: 0, sell: 0, months: new Set() }).get(acc);
      if (code === "P") a.buy += sh * px; else a.sell += sh * px; if (td) a.months.add(td.slice(0, 7));
    }
    for (const [acc, a] of agg) { const s = sub.get(acc); if (!s.filed) continue;
      for (const owner of new Set(own.get(acc))) { const set = trades.get(owner) || trades.set(owner, new Set()).get(owner); for (const m of a.months) set.add(m);
        if (/^[A-Z][A-Z.\-]{0,5}$/.test(s.sym)) filings.push({ owner, sym: s.sym, filedYm: s.filed.slice(0, 7), year: +s.filed.slice(0, 4), buyUsd: a.buy, sellUsd: a.sell }); } }
    console.log(zip, "owners", trades.size, "filings", filings.length);
  }
  const classify = (owner, Y) => { const ms = trades.get(owner); if (!ms) return "none"; const yrs = [Y - 3, Y - 2, Y - 1];
    if (!yrs.every((y) => [...ms].some((m) => m.startsWith(y + "-")))) return "unclassifiable";
    for (let mo = 1; mo <= 12; mo++) { const mm = String(mo).padStart(2, "0"); if (yrs.every((y) => ms.has(`${y}-${mm}`))) return "routine"; } return "opportunistic"; };
  const lists = { opportunisticBuys: {}, routineBuys: {}, allBuys: {}, opportunisticSells: {} }; const counts = { opportunistic: 0, routine: 0, unclassifiable: 0 };
  const add = (k, ym, sym) => { (lists[k][ym] = lists[k][ym] || new Set()).add(sym); };
  for (const f of filings) { if (f.filedYm < FIRST || f.filedYm > LAST) continue; const c = classify(f.owner, f.year);
    if (f.buyUsd >= MIN_USD) { add("allBuys", f.filedYm, f.sym); if (c === "opportunistic") add("opportunisticBuys", f.filedYm, f.sym); if (c === "routine") add("routineBuys", f.filedYm, f.sym); if (c in counts) counts[c]++; }
    if (f.sellUsd >= MIN_USD && c === "opportunistic") add("opportunisticSells", f.filedYm, f.sym); }
  const ser = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).sort().map(([m, s]) => [m, [...s].sort()]))]));
  const summary = Object.fromEntries(Object.entries(ser).map(([k, v]) => [k, { months: Object.keys(v).length, names: Object.values(v).reduce((a, s) => a + s.length, 0) }]));
  writeJsonAtomic(SIG, { spec: "r274-signals-v1", builtAt: new Date().toISOString(), outcomeFree: true, window: [FIRST, LAST], buyFilingsByClass: counts, summary, lists: ser });
  console.log("buy filings by insider class:", JSON.stringify(counts)); console.log(JSON.stringify(summary));
}

async function read() {
  const { fetchBars } = require("./lib/alpaca-bars.js");
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests && seals.tests.R274) throw new Error("R274 already sealed — read-once");
  const S = JSON.parse(fs.readFileSync(SIG, "utf8")); const L = S.lists;
  const syms = [...new Set(Object.values(L).flatMap((v) => Object.values(v).flat()))];
  console.log(`fetching ${syms.length} tickers + SPY/IWM …`);
  const r = await fetchBars(["SPY", "IWM", ...syms], { start: "2022-01-01", end: "2025-12-31T23:00:00Z", feed: "sip", adjustment: "all", quiet: true, requireAll: false, chunkSize: 40 });
  const cal = r.bars.SPY.map((b) => b.t.slice(0, 10)); const px = {}; for (const [s, bs] of Object.entries(r.bars)) px[s] = new Map(bs.map((b) => [b.t.slice(0, 10), b]));
  const win = {}; for (const d of cal) { const ym = d.slice(0, 7); (win[ym] = win[ym] || []).push(d); }
  const mret = (s, ym) => { const w = win[ym]; if (!w) return null; const a = px[s] && px[s].get(w[0]), z = px[s] && px[s].get(w[w.length - 1]); return a && z ? z.c / a.o - 1 : null; };
  const book = (lists, penalise = false) => { const rows = [];
    for (const [ym, names] of Object.entries(lists)) { const hm = nextMonth(ym); if (!win[hm]) continue; const rs = []; let missing = 0;
      for (const s of names) { const x = mret(s, hm); if (x == null) { missing++; if (penalise) rs.push(-0.30); } else rs.push(x - COST); }
      if (!rs.length) continue; const iwm = mret("IWM", hm), spy = mret("SPY", hm); rows.push({ ym, hold: hm, n: rs.length, missing, port: mean(rs), exIwm: mean(rs) - iwm, exSpy: mean(rs) - spy }); }
    return rows; };
  const summ = (rows) => rows.length ? { months: rows.length, monthsWith5: rows.filter((x) => x.n >= 5).length, names: rows.reduce((a, x) => a + x.n, 0), missingNames: rows.reduce((a, x) => a + x.missing, 0),
    rawMonthlyPct: +(100 * mean(rows.map((x) => x.port))).toFixed(3), exIwmMonthlyPct: +(100 * mean(rows.map((x) => x.exIwm))).toFixed(3), tIwm: +(tOf(rows.map((x) => x.exIwm)) ?? 0).toFixed(3),
    exSpyMonthlyPct: +(100 * mean(rows.map((x) => x.exSpy))).toFixed(3), tSpy: +(tOf(rows.map((x) => x.exSpy)) ?? 0).toFixed(3) } : null;
  const primRows = book(L.opportunisticBuys), prim = summ(primRows);
  // month-shuffle control: same ticker entries, random months, same per-month counts
  const entries = Object.entries(L.opportunisticBuys).flatMap(([ym, ns]) => ns.map((s) => s)); const slots = Object.entries(L.opportunisticBuys).map(([ym, ns]) => [ym, ns.length]);
  let seed = 274274; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648); const draws = [];
  for (let k = 0; k < DRAWS; k++) { const e = entries.slice(); for (let i = e.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [e[i], e[j]] = [e[j], e[i]]; }
    let p = 0; const lists = {}; for (const [ym, n] of slots) { lists[ym] = e.slice(p, p + n); p += n; } const rows = book(lists); if (rows.length) draws.push(mean(rows.map((x) => x.exIwm))); }
  draws.sort((a, b) => a - b); const p95 = draws[Math.floor(0.95 * draws.length)], med = draws[draws.length >> 1];
  const underpowered = prim.monthsWith5 < 36;
  const pass = !underpowered && prim.tIwm >= BAR && prim.exIwmMonthlyPct / 100 > p95;
  const verdict = `${underpowered ? "INCONCLUSIVE (underpowered: " + prim.monthsWith5 + " months with >=5 names, needs 36)" : pass ? "PASSED" : "DID NOT PASS"} — opportunistic buys ${prim.months} months, ${prim.names} names: raw ${prim.rawMonthlyPct}%/mo, vs IWM ${prim.exIwmMonthlyPct}%/mo t ${prim.tIwm} (bar ${BAR}); shuffle p95 ${(100 * p95).toFixed(3)}%/mo, median ${(100 * med).toFixed(3)}%`;
  const out = { test: "R274", readAt: new Date().toISOString(), verdict, bar: BAR, primary: prim, shuffle: { p95MonthlyPct: +(100 * p95).toFixed(3), medianMonthlyPct: +(100 * med).toFixed(3) },
    secondary: { routineBuys: summ(book(L.routineBuys)), allBuys: summ(book(L.allBuys)), opportunisticSells: summ(book(L.opportunisticSells)), penalisedOpportunistic: summ(book(L.opportunisticBuys, true)) }, months: primRows };
  writeJsonAtomic(OUT, out);
  seals.tests = seals.tests || {}; seals.tests.R274 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "months, one-sample t on equal-weight excess over IWM; best-of-2 bar (INSIDER-1)", verdict, output: "data/r274-insider-opportunistic.json" };
  writeJsonAtomic(D("read-seals.json"), seals);
  fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", tests: ["R274"], detail: verdict }) + "\n");
  console.log(verdict); console.log(JSON.stringify(out.secondary, null, 1));
}

(async () => { if (mode === "--signals") buildSignals(); else await read(); })().catch((e) => { console.error("R274 FAILED:", e.message); process.exit(1); });
