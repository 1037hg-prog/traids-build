#!/usr/bin/env node
// 2026-10-01 audit (cost#2): read-only harness. Loads the LIVE lib/cost-size.js and the PREPARED lib/cost-size.pending-0930.js side by
// side (separate module instances, nothing written) and prints the trailing reference each one would stamp right now, plus the pool
// composition, and a population cross-check computed independently here (join r56-predictions ids to board + trade log).
// Usage: node docs/audit-fixes/2026-09-30/server/harness-cost-ref.cjs
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..", "..", "..", ".."), B = path.join(ROOT, "backend"), D = (f) => path.join(B, "data", f);
const live = require(path.join(B, "lib", "cost-size.js")), pend = require(path.join(B, "lib", "cost-size.pending-0930.js"));
// the live module has no referenceInfo(): read its reference through costSizing() on a probe ticket whose numerator is known
const probe = { cls: "Equity", sym: "AAPL", entry: 200, stop: 196, stopDist: 4, obs: { atr14: 4, volRatio: 1 } };
const lv = live.costSizing(probe), pv = pend.costSizing(probe), info = pend.referenceInfo();
console.log(`LIVE  (all Equity rows):     ref ${lv.ref}  sessions ${JSON.stringify(lv.refSessions)}  probe mult ${lv.mult}`);
console.log(`FIXED (equity signals only): ref ${pv.ref}  sessions ${JSON.stringify(pv.refSessions)}  probe mult ${pv.mult}  pool ${JSON.stringify(info.refPool)}`);
// independent cross-check of the population (same join, written separately)
const rows = fs.readFileSync(D("r56-predictions.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && Number.isFinite(r.predictedCostR) && r.predictedCostR > 0);
const role = new Map(); const mark = (t) => { if (!t || !t.id) return; const r = t.cls === "Equity" && !t.ctrl && !t.vetoShadow && !t.sleeve ? "signal" : "other"; if (role.get(t.id) !== "other") role.set(t.id, r); };
JSON.parse(fs.readFileSync(D("board_positions.json"), "utf8")).forEach(mark); JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8")).forEach(mark);
const day = (r) => String(r.at).slice(0, 10), med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const allS = [...new Set(rows.map(day))].sort().slice(-5), poolAll = rows.filter((r) => allS.includes(day(r)));
const sigRows = rows.filter((r) => role.get(r.id) === "signal"), sigS = [...new Set(sigRows.map(day))].sort().slice(-5), poolSig = sigRows.filter((r) => sigS.includes(day(r)));
const comp = { signal: 0, other: 0, unknown: 0 }; for (const r of poolAll) comp[role.get(r.id) || "unknown"]++;
console.log(`cross-check: all-row pool ${poolAll.length} rows (${JSON.stringify(comp)}) median ${med(poolAll.map((r) => r.predictedCostR))} | signals-only pool ${poolSig.length} rows median ${med(poolSig.map((r) => r.predictedCostR))}`);
const ok = lv.ref === +med(poolAll.map((r) => r.predictedCostR)).toFixed(4) && pv.ref === +med(poolSig.map((r) => r.predictedCostR)).toFixed(4) && info.refPool && info.refPool.signals === poolSig.length;
console.log(ok ? "PASS — live ref = all-row median; prepared ref = signals-only median; pool sizes agree" : "FAIL — reference does not match the independent recomputation");
process.exit(ok ? 0 : 1);
