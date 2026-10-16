#!/usr/bin/env node
/**
 * TRAIDS — 13F BEST-IDEAS FORWARD TEST (test #38 forward leg; R24)
 *
 * WHY A FORWARD TEST: the backtest (backend/best-ideas-13f.js) is flattered by survivorship — unmapped/delisted names are
 * disproportionately the blowups. A forward record is immune by construction: nothing can delist out of a ledger kept live.
 * The trade-off is POWER — at ~4 cohorts/year and sigma(excess) ~6%/qtr, a t >= 2 verdict on +2%/qtr takes YEARS.
 *
 * DESIGN (pre-registered 2026-07-23; formation rule FIXED 2026-10-02, operator: "fix this"):
 *   • The 8 managers and their filer CIKs come from ONE shared config, backend/lib/r24-managers.js (also used by the history).
 *   • Each manager contributes the top-3 positions by value (non-option rows, CUSIPs merged) of its ORIGINAL 13F-HR FOR THAT
 *     PERIOD, and only if EDGAR accepted it by 16:00 ET on the formation day. No stale filing ever fills in: a manager with no
 *     current-period original contributes nothing that quarter. (Before 2026-10-02 this script took each manager's most recent
 *     filing whatever its period; 8 of the 16 names in the 2026-06-30 cohort came from older filings.)
 *   • FORMATION = the CLOSE of the first NYSE trading day AFTER the filing-window close (day 45 after quarter end, rolled to the
 *     next federal business day). Entries are that day's official SIP daily close (raw), so the record does not depend on which
 *     Friday this weekly step happens to run. The open cohort closes at the SAME close (held to the next formation). A formation
 *     day is used only once it is a past session (never a forming bar). Before 2026-10-02 the script formed ON the deadline day at
 *     live quotes and missed Third Point's on-time Q2-2026 filing (accepted 17:18 ET, after the run).
 *   • Equal-weight union of the tickers, in manager order; CUSIPs with no ticker are LOGGED per cohort (skippedUnmapped), names
 *     with no formation-day close are skipped and listed (skipped). Neither is ever dropped silently.
 *   • Benchmark: SPY, same closes. Costs: 10 bps x turnover at each rebalance. Between formations a run marks the open cohort at
 *     the server snapshot (timestamps printed). Bar (registered): corrected t >= 2.58, min 8 quarters, review 2027-01-15.
 *
 * State: backend/data/best-ideas-forward.json (writeJsonAtomic; written only when a cohort forms or closes).
 * Usage: node backend/best-ideas-forward.js [--dry] [--state <file>]
 *   --dry      compute and print, write nothing (no state, no cusip-map.json)
 *   --state    read/write another state file (testing)
 * Exit 1 = a formation was due but could not be completed (EDGAR, prices or keys) — nothing written, retried next run.
 */
"use strict";
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const R = require("./lib/r24-managers.js");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const STATE_PATH = argv.includes("--state") ? path.resolve(argv[argv.indexOf("--state") + 1]) : path.join(__dirname, "data", "best-ideas-forward.json");
const CUSIP_CACHE = path.join(__dirname, "data", "cusip-map.json");
const SERVER = process.env.TRAIDS_API || "http://localhost:3001";
const RULE = "r24-fix-2026-10-02";
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// ── Alpaca (read-only market data + calendar; main paper keys, never an order endpoint) ─────────────────────────
function alpacaHeaders() {
  const id = process.env.ALPACA_KEY_ID, secret = process.env.ALPACA_SECRET_KEY;
  if (!id || !secret) throw new Error("ALPACA_KEY_ID / ALPACA_SECRET_KEY missing — formation closes cannot be read (fail closed)");
  return { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": secret };
}
async function alpaca(url) {
  for (let a = 0; a < 4; a++) {
    const r = await fetch(url, { headers: alpacaHeaders(), signal: AbortSignal.timeout(30000) }).catch(() => null);
    if (r && r.ok) return r.json();
    if (r && r.status !== 429 && r.status < 500) throw new Error(`alpaca ${r.status} ${url.replace(/\?.*/, "")}`);
    await R.sleep(1500 * (a + 1));
  }
  throw new Error(`alpaca unreachable ${url.replace(/\?.*/, "")}`);
}
/** NYSE sessions (Alpaca calendar), sorted ISO dates */
async function sessions(start, end) {
  const j = await alpaca(`https://paper-api.alpaca.markets/v2/calendar?start=${start}&end=${end}`);
  return j.map((d) => d.date).sort();
}
/** official SIP daily closes (raw) on ONE past date, for symbols */
async function closesOn(date, symbols) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 50) {
    let token = null;
    do {
      const q = new URLSearchParams({ symbols: symbols.slice(i, i + 50).join(","), timeframe: "1Day", start: date, end: R.addDays(date, 1), adjustment: "raw", feed: "sip", limit: "10000" });
      if (token) q.set("page_token", token);
      const j = await alpaca(`https://data.alpaca.markets/v2/stocks/bars?${q}`);
      for (const s in j.bars || {}) for (const b of j.bars[s]) if (String(b.t).slice(0, 10) === date && b.c > 0) out[s] = b.c;
      token = j.next_page_token || null;
    } while (token);
  }
  return out;
}
/** live marks between formations: server snapshot, timestamp kept */
async function snapshot(syms) {
  const out = {};
  for (let i = 0; i < syms.length; i += 90) {
    try {
      const r = await fetch(`${SERVER}/api/equities/snapshot?symbols=${encodeURIComponent(syms.slice(i, i + 90).join(","))}`, { signal: AbortSignal.timeout(60000) });
      if (r.ok) { const j = await r.json(); for (const s in j) if (j[s]?.price > 0) out[s] = { px: j[s].price, ts: j[s].ts ? new Date(j[s].ts).toISOString() : null }; }
    } catch {}
  }
  return out;
}

// ── formation (exported: docs/r24-fix/build-corrected.cjs stages the corrected 2026-06-30 cohort with this exact code) ──
const filingsMemo = {};
const getFilings = async (cik) => (filingsMemo[cik] ||= await R.filings13F(cik));
const getHoldings = (cik, acc) => R.holdingsOf(cik, acc);

/** one cohort under the fixed rule. Returns { cohort, cusipAdds } — cusipAdds are new OpenFIGI cache rows the caller may persist. */
async function formCohort(period, formation, { log = console.log } = {}) {
  const m = await R.cohortMembers(period, formation, { getFilings, getHoldings });
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(CUSIP_CACHE, "utf8")); } catch {}
  const cusipAdds = await R.openFigi([...m.cusips.keys()], cache);
  const cmap = { ...cache, ...cusipAdds };
  const byTk = new Map(), skippedUnmapped = [];
  for (const [cusip, v] of m.cusips) {
    const t = R.tickerOf(cusip, cmap);
    if (!t.ticker) { skippedUnmapped.push({ cusip, issuer: v.issuer, managers: v.managers, why: t.source }); continue; }
    const e = byTk.get(t.ticker) || { tk: t.ticker, cusips: [], managers: [], tickerSource: t.source };
    e.cusips.push(cusip); for (const x of v.managers) if (!e.managers.includes(x)) e.managers.push(x);
    byTk.set(t.ticker, e);
  }
  const tks = [...byTk.keys()];
  const px = await closesOn(formation, [...tks, "SPY"]);
  if (!(px.SPY > 0)) throw new Error(`no SPY close for ${formation} — cannot form (fail closed)`);
  const legs = tks.filter((t) => px[t] > 0).map((t) => ({ tk: t, entry: px[t], cusips: byTk.get(t).cusips, managers: byTk.get(t).managers, ...(byTk.get(t).tickerSource === "override" ? { tickerSource: "CUSIP_OVERRIDES (lib/r24-managers.js)" } : {}) }));
  const skipped = tks.filter((t) => !(px[t] > 0));
  const cohort = {
    period, formed: formation, rule: RULE, windowClose: m.windowClose, filingCutoffUTC: m.cutoffUTC,
    priceBasis: `Alpaca SIP daily close (raw) on ${formation}`,
    legs, spyEntry: px.SPY, skipped, skippedUnmapped,
    members: m.managers.map((r) => ({ manager: r.manager, cik: r.cik, entity: r.entity, accession: r.accession, filed: r.filed, acceptedUTC: r.acceptedUTC,
      top3: r.top3.map((e) => ({ cusip: e.cusip, issuer: e.issuer, weight: e.weight, ticker: R.tickerOf(e.cusip, cmap).ticker })), contributes: r.contributes,
      ...(r.why ? { why: r.why } : {}), ...(r.late ? { late: r.late } : {}), ...(r.duplicateOriginals ? { duplicateOriginals: r.duplicateOriginals } : {}) })),
  };
  log(`  ★ cohort ${period} · formed at the ${formation} close (window closed ${m.windowClose}; filings accepted by ${m.cutoffUTC}) · ${legs.length} names`);
  for (const r of cohort.members) log(`    ${r.manager.padEnd(36)} ${r.contributes ? `${r.entity} ${r.accession} → ${r.top3.map((e) => `${e.ticker || "UNMAPPED " + e.issuer} ${(100 * e.weight).toFixed(1)}%`).join(", ")}` : `contributes nothing: ${r.why}`}`);
  log(`    names: ${legs.map((l) => l.tk).join(" · ")}`);
  if (skipped.length) log(`    skipped (no ${formation} close): ${skipped.join(", ")}`);
  if (skippedUnmapped.length) log(`    skippedUnmapped: ${skippedUnmapped.map((u) => `${u.issuer} ${u.cusip} (${u.managers.join("/")})`).join("; ")}`);
  return { cohort, cusipAdds };
}

/** close an open cohort at the formation close of its successor (held to the next formation) */
async function closeCohort(open, date, nextLegs) {
  const px = await closesOn(date, [...open.legs.map((l) => l.tk), "SPY"]);
  if (!(px.SPY > 0)) throw new Error(`no SPY close for ${date} — cannot close cohort ${open.period} (fail closed)`);
  open.closed = { date, basis: `Alpaca SIP daily close (raw) on ${date}`, spyExit: px.SPY, legs: open.legs.map((l) => ({ tk: l.tk, entry: l.entry, exit: px[l.tk] ?? null })) };
  const done = open.closed.legs.filter((l) => l.exit != null);
  const turnover = 1 - open.legs.filter((l) => nextLegs.some((n) => n.tk === l.tk)).length / Math.max(1, nextLegs.length);
  open.result = { port: mean(done.map((l) => l.exit / l.entry - 1)) - 0.001 * turnover, spy: open.spyEntry ? px.SPY / open.spyEntry - 1 : null, turnover, unpricedAtClose: open.closed.legs.filter((l) => l.exit == null).map((l) => l.tk) };
  return open.result;
}

async function main() {
  console.log(`\n  TRAIDS — 13F BEST-IDEAS FORWARD TEST · test #38 forward leg (R24) · rule ${RULE}${DRY ? " · DRY (nothing written)" : ""}\n`);
  let state = { ciks: {}, cohorts: [] };
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch (e) { if (fs.existsSync(STATE_PATH)) throw new Error(`state file unreadable (${e.message}) — refusing`); }
  const live = () => state.cohorts.filter((c) => !c.closed && !c.superseded);
  if (live().length > 1) throw new Error(`${live().length} open cohorts in the state file — refusing (exactly one may be open)`);
  const today = todayET();
  const cal = await sessions("2025-06-01", R.addDays(today, 200));
  const past = cal.filter((d) => d < today);                                  // completed sessions only (never a forming bar)
  const periods = R.quarterEnds("2025-12-31", today);
  const formable = periods.filter((p) => { const F = R.formationDate(p, cal); return F && past.includes(F); });
  const latest = formable[formable.length - 1];
  const nextP = periods.concat(R.quarterEnds(R.addDays(today, 1), R.addDays(today, 120))).find((p) => !formable.includes(p) && p > (latest || ""));
  if (nextP) console.log(`  next formation: period ${nextP} · window closes ${R.windowClose(nextP)} · formed at the ${R.formationDate(nextP, cal) || "?"} close`);

  let open = live()[0] || null, changed = false, cusipAdds = {};
  // forward-only: an empty record starts at the latest formable period (no backfill); an open cohort rolls through every period since
  const due = open ? formable.filter((p) => p > open.period) : formable.slice(-1);
  for (const p of due) {
    const F = R.formationDate(p, cal);
    const { cohort, cusipAdds: add } = await formCohort(p, F);
    if (cohort.legs.length < 5) throw new Error(`cohort ${p} has ${cohort.legs.length} priced names (< 5) — not formed (fail closed)`);
    Object.assign(cusipAdds, add);
    if (open) {
      const res = await closeCohort(open, F, cohort.legs);
      console.log(`  closed cohort ${open.period} at the ${F} close: portfolio ${(100 * res.port).toFixed(2)}% vs SPY ${res.spy != null ? (100 * res.spy).toFixed(2) : "—"}% (turnover ${(100 * res.turnover).toFixed(0)}%)${res.unpricedAtClose.length ? ` · no close for ${res.unpricedAtClose.join(",")}` : ""}`);
    }
    state.cohorts.push(cohort); open = cohort; changed = true;
  }

  if (!changed && open) {
    const q = await snapshot([...open.legs.map((l) => l.tk), "SPY"]);
    const marks = open.legs.map((l) => ({ tk: l.tk, ret: q[l.tk] ? q[l.tk].px / l.entry - 1 : null, ts: q[l.tk]?.ts })).filter((x) => x.ret != null);
    const port = mean(marks.map((x) => x.ret)), spy = q.SPY && open.spyEntry ? q.SPY.px / open.spyEntry - 1 : null;
    const ts = marks.map((m) => m.ts).filter(Boolean).sort();
    console.log(`  open cohort ${open.period} (formed ${open.formed}${open.rule ? "" : ", PRE-FIX rule"}) · ${marks.length}/${open.legs.length} marked · quotes ${ts[0] || "?"} .. ${ts[ts.length - 1] || "?"} · SPY ${q.SPY ? `${q.SPY.px} @ ${q.SPY.ts}` : "no quote"}`);
    console.log(`  since formation: portfolio ${(port * 100).toFixed(2)}% · SPY ${spy != null ? (spy * 100).toFixed(2) : "—"}% · excess ${spy != null ? ((port - spy) * 100).toFixed(2) : "—"}%`);
    marks.sort((a, b) => b.ret - a.ret);
    console.log(`  best: ${marks.slice(0, 3).map((x) => `${x.tk} ${(x.ret * 100).toFixed(1)}%`).join(" · ")} · worst: ${marks.slice(-3).map((x) => `${x.tk} ${(x.ret * 100).toFixed(1)}%`).join(" · ")}`);
    if (open.skippedUnmapped && open.skippedUnmapped.length) console.log(`  skippedUnmapped at formation: ${open.skippedUnmapped.map((u) => u.issuer).join("; ")}`);
  } else if (!open) console.log("  no cohort yet and none formable — nothing to mark");

  const counted = state.cohorts.filter((c) => c.result && !c.superseded && c.countsTowardRead !== false);
  if (counted.length) {
    const ex = counted.map((c) => c.result.port - (c.result.spy ?? 0));
    console.log(`\n  FORWARD RECORD (counted toward the read): ${counted.length} closed cohort(s) · mean excess ${(mean(ex) * 100).toFixed(2)}%/qtr · cum port ${((counted.reduce((s, c) => s * (1 + c.result.port), 1) - 1) * 100).toFixed(1)}% vs SPY ${((counted.reduce((s, c) => s * (1 + (c.result.spy ?? 0)), 1) - 1) * 100).toFixed(1)}%`);
  } else console.log(`\n  FORWARD RECORD (counted toward the read): 0 closed cohorts`);
  const notCounted = state.cohorts.filter((c) => c.superseded || c.countsTowardRead === false);
  if (notCounted.length) console.log(`  kept but not counted: ${notCounted.map((c) => `${c.period} formed ${c.formed} (${c.superseded ? "superseded" : "excluded"})`).join("; ")}`);
  console.log(`  Bar: corrected t >= 2.58, min 8 quarters, review 2027-01-15. Nothing here trades.\n`);

  if (DRY) { if (changed) console.log("  DRY — the state above was NOT written"); return; }
  if (Object.keys(cusipAdds).length) { let cache = {}; try { cache = JSON.parse(fs.readFileSync(CUSIP_CACHE, "utf8")); } catch {} writeJsonAtomic(CUSIP_CACHE, { ...cache, ...cusipAdds }, { pretty: 0 }); }
  if (changed) { state.managerConfig = { source: "backend/lib/r24-managers.js", rule: RULE, managers: R.MANAGERS }; writeJsonAtomic(STATE_PATH, state); console.log(`  state written: ${STATE_PATH}`); }
}

module.exports = { formCohort, closeCohort, sessions, closesOn, RULE };
if (require.main === module) main().catch((e) => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
