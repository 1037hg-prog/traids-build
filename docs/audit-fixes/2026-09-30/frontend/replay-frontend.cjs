#!/usr/bin/env node
/**
 * READ-ONLY replay of the 2026-10-01 frontend fixes (audit 2026-09-30, keys frontend#1, #2, #4).
 * It lifts the pure functions out of an App.jsx (default: src/App.jsx, i.e. the NEW code) and the
 * pre-fix backup, runs both on the real data files, and prints old vs new side by side.
 * Writes nothing. Sends no order. The optional --quotes flag issues two read-only GETs to the local
 * :3001 server (/api/equities/snapshot and /api/option-quotes) to mark the open book with real quotes.
 *
 *   node docs/audit-fixes/2026-09-30/frontend/replay-frontend.cjs [--app <App.jsx>] [--orig <App.jsx.orig>] [--quotes]
 *
 * Exit: 0 = every check PASS · 1 = a check FAILED · 2 = UNKNOWN (could not run a check; as loud as FAIL).
 */
"use strict";
const fs = require("fs"), path = require("path");
const REPO = path.resolve(__dirname, "..", "..", "..", "..");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const APP = path.resolve(arg("--app", path.join(REPO, "src", "App.jsx")));
const ORIG = path.resolve(arg("--orig", path.join(REPO, "docs", "audit-fixes", "2026-09-30", "backups", "src__App.jsx.orig")));
const QUOTES = process.argv.includes("--quotes");
const results = [];
const verdict = (name, st, detail) => { results.push({ name, st }); console.log(`[${st}] ${name}${detail ? " — " + detail : ""}`); };

/** Lift `function NAME(...) {...}` or a one-line `const NAME = ...;` out of source text by brace matching. */
function lift(src, name) {
  let i = src.indexOf(`function ${name}(`);
  if (i < 0) { const m = src.match(new RegExp(`^const ${name}\\s*=.*$`, "m")); if (!m) throw new Error(`${name} not found`);
    // const arrow spanning lines: take until the matching close of its first "{" or the line end
    const start = m.index; const lineEnd = src.indexOf("\n", start); const line = src.slice(start, lineEnd);
    if (!/=>\s*\{\s*$/.test(line)) return line;
    i = start;
  }
  const open = src.indexOf("{", src.indexOf(")", i)); let depth = 0, j = open, q = null;
  for (; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === "\\") { j++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "/" && src[j + 1] === "/") { j = src.indexOf("\n", j); continue; }
    if (c === "{") depth++; else if (c === "}") { depth--; if (depth === 0) break; }
  }
  let end = j + 1; if (src[end] === ";") end++;
  return src.slice(i, end);
}
function load(file, names) {
  const src = fs.readFileSync(file, "utf8");
  const body = names.map(n => { try { return lift(src, n); } catch { return `/* ${n} absent */`; } }).join("\n");
  const exp = names.map(n => `${n}: typeof ${n} === "undefined" ? undefined : ${n}`).join(", ");
  return new Function(`${body}\nreturn { ${exp} };`)();
}
const fmtR = v => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(4)}R`;
const usd = v => v == null ? "—" : `${v < 0 ? "-" : "+"}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

(async () => {
  let NEW, OLD;
  try {
    NEW = load(APP, ["CLEAN_EPOCH", "cleanEraLedger", "boardHeroLedger", "sanitizeLog", "sessionDayET", "ANALYTICS_OPT_COMMISSION", "markOpenBookRow", "monteCarlo"]);
    OLD = load(ORIG, ["CLEAN_EPOCH", "cleanEraLedger", "sanitizeLog", "monteCarlo"]);
  } catch (e) { verdict("load functions", "UNKNOWN", e.message); process.exit(2); }

  // ── frontend#1 — the DailyBoard hero record ─────────────────────────────────────────────
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "trade_log.json"), "utf8"));
    const stats = (L) => { const s = L.signals; const w = s.filter(t => t.pnl > 0).length; return { n: L.n, exp: L.exp, win: s.length ? w / s.length * 100 : null, net: s.reduce((a, t) => a + t.pnl, 0), first: L.first != null ? NEW.sessionDayET(L.first) : null, edge: L.edge, ctrlN: L.ctrlN, stopR: L.stopR, worst: L.worstStop, gap: L.gapRate }; };
    const capped = NEW.sanitizeLog([...raw].sort((a, b) => b.closedAt - a.closedAt).slice(0, 3000));
    const tab = stats(NEW.boardHeroLedger(capped));      // what the hero showed before (capped copy)
    const full = stats(NEW.boardHeroLedger(NEW.sanitizeLog(raw)));   // what it shows now (uncapped server ledger)
    let canon = null; try { const C = require(path.join(REPO, "backend", "lib", "reconcile.js")).cleanEraLedger(); const m = a => a.reduce((s, t) => s + t.rMult, 0) / a.length; canon = { n: C.signals.length, exp: m(C.signals), ctrlN: C.controls.length, edge: m(C.signals) - m(C.controls) }; } catch (e) { console.log("  reconcile.js unavailable:", e.message); }
    console.log(`\nfrontend#1 hero — ledger rows on disk ${raw.length}`);
    for (const [k, s] of [["BEFORE (newest 3,000 browser rows)", tab], ["AFTER  (uncapped server ledger)", full]])
      console.log(`  ${k}: n ${s.n} · exp ${fmtR(s.exp)} · win ${s.win?.toFixed(1)}% · net ${usd(s.net)} · since ${s.first} · edge ${fmtR(s.edge)} vs ${s.ctrlN} ctrl · stop ${s.stopR?.toFixed(3)}R worst ${s.worst?.toFixed(2)}R gapped ${(s.gap * 100).toFixed(1)}%`);
    if (canon) console.log(`  reconcile.js canonical:      n ${canon.n} · exp ${fmtR(canon.exp)} · edge ${fmtR(canon.edge)} vs ${canon.ctrlN} ctrl`);
    if (!canon) verdict("frontend#1 hero == reconcile.js", "UNKNOWN", "reconcile.js did not load");
    else verdict("frontend#1 hero == reconcile.js", (full.n === canon.n && full.ctrlN === canon.ctrlN && Math.abs(full.exp - canon.exp) < 1e-9 && Math.abs(full.edge - canon.edge) < 1e-9) ? "PASS" : "FAIL",
      `hero n ${full.n}/${full.ctrlN} exp ${fmtR(full.exp)} vs canon n ${canon.n}/${canon.ctrlN} exp ${fmtR(canon.exp)}`);
  } catch (e) { verdict("frontend#1 hero replay", "UNKNOWN", e.message); }

  // ── frontend#2 — Portfolio Analytics open book ──────────────────────────────────────────
  try {
    const book = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "board_positions.json"), "utf8"));
    let tombs = []; try { tombs = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "board_tombstones.json"), "utf8")); } catch { }
    const tset = new Set(tombs.map(t => t.id ?? t));
    const all = book.filter(p => p && p.id && !tset.has(p.id));
    const sig = all.filter(p => !p.ctrl && !p.vetoShadow);
    console.log(`\nfrontend#2 open book — ${all.length} rows · ${sig.length} signal · ${all.length - sig.length} ctrl/shadow excluded`);
    let marks = {}, optQ = {};
    if (QUOTES) {
      const get = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(`${u.split("?")[0]} HTTP ${r.status}`); return r.json(); };
      const eq = [...new Set(all.filter(p => p.cls !== "Crypto").map(p => p.priceSym || p.sym).filter(Boolean))];
      for (let i = 0; i < eq.length; i += 50) { const j = await get(`http://localhost:3001/api/equities/snapshot?symbols=${encodeURIComponent(eq.slice(i, i + 50).join(","))}`); Object.assign(marks, j.data || j || {}); }
      const occs = [...new Set(sig.filter(p => p.cls === "Options").flatMap(p => [p.occAtm, p.occK2]).filter(Boolean))];
      for (let i = 0; i < occs.length; i += 40) { const j = await get(`http://localhost:3001/api/option-quotes?symbols=${encodeURIComponent(occs.slice(i, i + 40).join(","))}`); Object.assign(optQ, j.data || {}); }
      console.log(`  read-only quotes: ${Object.keys(marks).length} underlyings/FX/futures · ${Object.keys(optQ).length} of ${occs.length} OCC legs`);
    } else console.log("  (no --quotes: every row is unmarked by construction; the OLD panel would have shown each at its own entry = $0.00)");
    // OLD panel arithmetic, verbatim from the pre-fix posWP
    const oldRow = p => { const entry = Number(p.entry ?? p.debit ?? 0); const cur = Number((p.cls === "Crypto" ? undefined : marks[p.priceSym || p.sym]?.price) ?? entry); const dpp = Number(p.dollarPerPoint ?? 1);
      return { pnl: (cur - entry) * dpp * (p.dir < 0 ? -1 : 1), pct: entry ? ((cur - entry) / entry) * 100 * (p.dir < 0 ? -1 : 1) : 0, cls: p.cls }; };
    const olds = all.map(oldRow), news = sig.map(p => NEW.markOpenBookRow(p, { marks, cryptoPx: {}, optQ }));
    const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
    const oldOpt = olds.filter(r => r.cls === "Options");
    console.log(`  BEFORE: Open P&L ${usd(olds.reduce((s, r) => s + r.pnl, 0))} over ${olds.length} rows (controls in) · options median |%| ${med(oldOpt.map(r => Math.abs(r.pct)))?.toFixed(0)}%`);
    const mk = news.filter(r => r.marked);
    const byCls = {}; for (const r of news) { const b = byCls[r.cls] ||= { n: 0, marked: 0, pnl: 0 }; b.n++; if (r.marked) { b.marked++; b.pnl += r.pnl; } }
    console.log(`  AFTER:  Open P&L ${mk.length ? usd(mk.reduce((s, r) => s + r.pnl, 0)) : "—"} over ${mk.length} marked of ${news.length} signal rows (${news.length - mk.length} blank) · options median |%| ${med(mk.filter(r => r.cls === "Options").map(r => Math.abs(r.pnlPct)))?.toFixed(1) ?? "—"}%`);
    for (const [c, b] of Object.entries(byCls)) console.log(`          ${c.padEnd(8)} ${b.marked}/${b.n} marked · ${usd(b.pnl)}`);
    const why = {}; for (const r of news.filter(r => !r.marked)) why[r.unmarkedWhy] = (why[r.unmarkedWhy] || 0) + 1;
    if (Object.keys(why).length) console.log("          unmarked because:", JSON.stringify(why));
    const zeroFill = news.filter(r => !r.marked && (r.pnl != null || r.currentPrice != null)).length;
    verdict("frontend#2 unmarked rows are blank (no $0 fill)", zeroFill === 0 ? "PASS" : "FAIL", `${zeroFill} unmarked rows carry a number`);
    verdict("frontend#2 controls/shadows excluded", news.length === sig.length && sig.every(p => !p.ctrl && !p.vetoShadow) ? "PASS" : "FAIL", `${all.length - sig.length} excluded`);
    const absurd = mk.filter(r => r.cls === "Options" && Math.abs(r.pnlPct) > 400).length;   // a spread cannot lose more than ~its max loss
    verdict("frontend#2 options |P&L| within max loss", QUOTES ? (absurd === 0 ? "PASS" : "FAIL") : "UNKNOWN", QUOTES ? `${absurd} option rows past 400% of max loss` : "run with --quotes to mark");
    const ko = sig.find(p => p.cls === "Equity" && p.shares != null && p.dollarPerPoint == null);
    if (ko) { const r = NEW.markOpenBookRow(ko, { marks: { [ko.sym]: { price: ko.entry * 1.01 } } }); verdict("frontend#2 shares-sized equity is per position", Math.abs(r.pnl - ko.entry * 0.01 * ko.shares * (ko.dir < 0 ? -1 : 1)) < 1e-6 && r.qty === ko.shares ? "PASS" : "FAIL", `${ko.sym} qty ${r.qty} · +1% → ${usd(r.pnl)}`); }
  } catch (e) { verdict("frontend#2 open-book replay", "UNKNOWN", e.message); }

  // ── frontend#4 — Backtester Monte Carlo P(profit) ───────────────────────────────────────
  try {
    let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const base = Array.from({ length: 60 }, () => ({ pnl: (rnd() - 0.5) * 2 * 690 }));
    const shift = (tot) => { const s = base.reduce((a, t) => a + t.pnl, 0); return base.map(t => ({ pnl: t.pnl + (tot - s) / base.length })); };
    console.log("\nfrontend#4 Monte Carlo — 60 synthetic trades, 2,000 sims each");
    let ok = true;
    for (const tot of [5159, 500, 50, -800]) {
      const tr = shift(tot); const o = OLD.monteCarlo(tr, 100000, 2000), n = NEW.monteCarlo(tr, 100000, 2000);
      console.log(`  total ${usd(tot).padStart(7)}: BEFORE P(profit) ${o.probProfit}% (p5..p95 band $${(o.p95 - o.p5).toFixed(0)}) · AFTER ${n.probProfit}% (band $${(n.p95 - n.p5).toFixed(0)}, ${n.method}, block ${n.blockLen})`);
      if (Math.abs(tot) <= 500 && (+n.probProfit === 0 || +n.probProfit === 100)) ok = false;
    }
    verdict("frontend#4 P(profit) no longer degenerate near zero", ok ? "PASS" : "FAIL");
  } catch (e) { verdict("frontend#4 Monte Carlo replay", "UNKNOWN", e.message); }

  const worst = results.some(r => r.st === "FAIL") ? 1 : results.some(r => r.st === "UNKNOWN") ? 2 : 0;
  console.log(`\nverdict: ${worst === 0 ? "PASS" : worst === 1 ? "FAIL" : "UNKNOWN"} (${results.filter(r => r.st === "PASS").length} pass · ${results.filter(r => r.st === "FAIL").length} fail · ${results.filter(r => r.st === "UNKNOWN").length} unknown)`);
  process.exit(worst);
})().catch(e => { console.error("[UNKNOWN] replay crashed:", e.message); process.exit(2); });
