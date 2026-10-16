#!/usr/bin/env node
/**
 * PROFIT PROGRAM / concentration (read-only printer). Shares of ABSOLUTE movement (sum of |R| and sum of |$|), never of net: dividing by a near-zero net
 * gives nonsense like -666%. Board population = the dashboard table (lib/reconcile.js cleanEraLedger() signals, controls out, out-of-hours entries out),
 * closed since --since (MT close day), by strategy, class, direction, symbol, open session and 1R size bucket. Also the Herfindahl-based effective number of
 * independent-weight buckets (1 / sum of squared shares) for each cut, so "148 tickets" can be read against "N buckets that carry the movement".
 * The pooling audit (backend/data/pooling-audit.json) is read FIRST and its flags are printed with every cut they apply to.
 *   node backend/profit-program/pp-concentration.js [--since 2026-08-25] [--no-write]
 */
"use strict";
const fs = require("fs"), path = require("path");
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SINCE = arg("--since", "2026-08-25");
const rc = require("../lib/reconcile.js"), S = require("../lib/session.js");
const { riskOf } = require("./_common.js");
const { writeJsonAtomic } = require("../lib/atomic-write.js");
const DATA = path.join(__dirname, "..", "data");
const PA = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, "pooling-audit.json"), "utf8")); } catch { return null; } })();
const L = require("./pp-reconcile.js").loadLedger();
const mtDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
const hm = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
const outside = (t) => { const o = t.openedAt || t.addedAt; if (!o) return false; const x = hm(o); return x < "09:25" || x >= "16:00"; };
const T = L.signals.filter((t) => !t.ctrl && Number.isFinite(t.pnl) && Number.isFinite(t.rMult) && mtDay(t.closedAt) >= SINCE && !outside(t));
const sum = (a) => a.reduce((s, v) => s + v, 0);
const absR = sum(T.map((t) => Math.abs(t.rMult))), absUsd = sum(T.map((t) => Math.abs(t.pnl))), netR = sum(T.map((t) => t.rMult)), netUsd = sum(T.map((t) => t.pnl));
function cut(label, keyf, top = 6) {
  const m = {}; for (const t of T) { const k = keyf(t); (m[k] ||= { n: 0, absR: 0, absUsd: 0, netR: 0, netUsd: 0 }); const o = m[k]; o.n++; o.absR += Math.abs(t.rMult); o.absUsd += Math.abs(t.pnl); o.netR += t.rMult; o.netUsd += t.pnl; }
  const rows = Object.entries(m).map(([k, o]) => ({ key: k, n: o.n, shareAbsR: o.absR / absR, shareAbsUsd: o.absUsd / absUsd, netUsd: Math.round(o.netUsd) })).sort((a, b) => b.shareAbsUsd - a.shareAbsUsd);
  const hhi = sum(rows.map((r) => r.shareAbsUsd ** 2));
  return { cut: label, buckets: rows.length, effectiveBuckets: +(1 / hhi).toFixed(1), top: rows.slice(0, top).map((r) => ({ ...r, shareAbsR: +(100 * r.shareAbsR).toFixed(1), shareAbsUsd: +(100 * r.shareAbsUsd).toFixed(1) })) };
}
const cuts = [cut("strategy", (t) => t.strategy), cut("class", (t) => t.cls), cut("direction", (t) => (t.dir > 0 ? "long" : "short")), cut("class x direction", (t) => t.cls + " " + (t.dir > 0 ? "long" : "short")), cut("symbol", (t) => t.sym, 10), cut("open session", (t) => S.openSession(t), 6), cut("close day (MT)", (t) => mtDay(t.closedAt), 6),
  cut("option expiry day (R21/R25)", (t) => (t.cls === "Options" && t.obs && t.obs.optExpiry ? t.obs.optExpiry : "n/a"), 6), cut("exit reason", (t) => t.reason || "?")];
// the 10 largest absolute-$ tickets
const big = [...T].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, 10).map((t) => ({ sym: t.sym, strategy: t.strategy, usd: Math.round(t.pnl), r: +t.rMult.toFixed(2), reason: t.reason, session: S.openSession(t) }));
const top20pct = (() => { const a = T.map((t) => Math.abs(t.pnl)).sort((x, y) => y - x); const k = Math.ceil(a.length * 0.05); return { tickets: k, ofTickets: a.length, shareAbsUsd: +(100 * sum(a.slice(0, k)) / absUsd).toFixed(1) }; })();
const out = { spec: "pp-concentration-v1", asOf: new Date().toISOString(), since: SINCE, tickets: T.length, absR: +absR.toFixed(1), absUsd: Math.round(absUsd), netR: +netR.toFixed(1), netUsd: Math.round(netUsd), note: "shares are of ABSOLUTE R and ABSOLUTE $; net shown only for scale", cuts, top5pctTickets: top20pct, largestTickets: big,
  poolingAudit: PA ? { asOf: PA.asOf, flagged: PA.flagged, aggregatesChecked: PA.aggregatesChecked, flags: PA.flags.map((f) => ({ aggregate: f.aggregate, kinds: f.findings.map((x) => x.kind), detail: f.findings.map((x) => x.detail) })) } : null };
if (!argv.includes("--no-write")) writeJsonAtomic(path.join(DATA, "profit-program", `pp-concentration-${SINCE}.json`), out);
console.log(`PP CONCENTRATION  board table closed ${SINCE}..now: ${T.length} tickets, sum|R| ${absR.toFixed(1)}, sum|$| $${Math.round(absUsd).toLocaleString()} (net ${netR.toFixed(1)}R, $${Math.round(netUsd).toLocaleString()} - shown for scale only)`);
if (PA) { console.log(`POOLING AUDIT ${PA.asOf}: ${PA.flagged} of ${PA.aggregatesChecked} aggregates flagged. Flags relevant to the cuts below:`); for (const f of PA.flags) console.log(`  ${f.aggregate.padEnd(24)} ${f.findings.map((x) => x.kind + " (" + x.detail + ")").join(" | ").slice(0, 190)}`); }
for (const c of cuts) { console.log(`\nby ${c.cut}: ${c.buckets} buckets, effective buckets ${c.effectiveBuckets}`); for (const r of c.top) console.log(`  ${String(r.key).padEnd(28)} n ${String(r.n).padStart(4)}  |R| share ${String(r.shareAbsR).padStart(5)}%  |$| share ${String(r.shareAbsUsd).padStart(5)}%  net $${r.netUsd.toLocaleString()}`); }
console.log(`\ntop ${top20pct.tickets} of ${top20pct.ofTickets} tickets (5%) carry ${top20pct.shareAbsUsd}% of absolute $`);
for (const b of big) console.log(`  ${b.session} ${b.strategy.padEnd(14)} ${b.sym.padEnd(9)} ${b.usd < 0 ? "-$" : "+$"}${Math.abs(b.usd)}  ${b.r}R  ${b.reason}`);
