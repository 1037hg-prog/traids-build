// R295 v4 — 2026-10-01 nightly-audit fixes (audit of 2026-09-30, defense series; every item confirmed 3/3 by refuters).
//   v4 A (vintage #1, high): the universe ratchet. candidateSymbols() took the NEWEST first5 file, and the after-close fidelity
//        check writes first5/<date>.json holding only that day's ELIGIBLE names, so each prepare inherited yesterday's eligible
//        set (2290 -> 1267 -> 1250); names could only leave. Now: a FIXED superset (union of R287's last 14 first5 fetches,
//        2026-09-09..09-28, frozen to data/training/r295/superset.json); fetchFirst5 tops up any cached day that does not cover
//        the requested list (merging, remembering names Alpaca returned nothing for), so baseline days cover the whole superset.
//        The fidelity row now also records the size of the universe it ranked in.
//   v4 B (settle #7): an over-exit (exit fills > entry fill) booked the extra shares' proceeds as P&L. Now only min(exitQ, q) is
//        booked at the average exit price; the excess is a separate flipped lot marked to the close and reported as overExitPnl,
//        NOT in netPnl/netRet; the row carries overExit and read() refuses while an evidence row has an unresolved over-exit.
//   v4 C (settle #7): closeOut re-reads each stop after its cancel until terminal before sizing the MOC (the race behind B).
//   v4 D (registry #3): read() is read-once: refuses when sealed or when OUT holds a verdict, grades the FIRST 60 evidence
//        sessions, and writes the seal. The registered interim kill (20 evidence sessions, net t <= -2.0 -> stop) runs in
//        --after-close once and sets the OFF switch if met.
//   v4 E: lots left open at the close (unexited or over-exited) are flattened by a queued day market order for the next open
//        (--after-close --live only), as was done by hand for KMX on 09-30. Operator alert through notify.js.
// Usage: node docs/r295/patch-r295-v4.cjs <backend dir> <out file>
const fs = require("fs"), path = require("path");
const BK = process.argv[2], OUTF = process.argv[3]; if (!BK || !OUTF) throw new Error("usage: <backend dir> <out file>");
let s = fs.readFileSync(path.join(BK, "r295-orb-forward.js"), "utf8");
const rep = (a, b, tag) => { const n = s.split(a).length - 1; if (n !== 1) throw new Error(`${tag}: expected 1 match, found ${n}`); s = s.replace(a, () => b); };

// header note
rep(` * --live sends orders (paper endpoint only); without it everything is printed and nothing is sent. OFF switch: data/r295-OFF.`,
` * v4 (2026-10-01, nightly audit of 09-30): fixed superset (no universe ratchet); over-exits booked apart from the session P&L; stops
 *   re-read after cancel before the MOC is sized; read-once seal on the first 60 evidence sessions; the registered 20-session interim
 *   kill; lots left open at the close are flattened at the next open (--after-close --live). See docs/r295/patch-r295-v4.cjs.
 * --live sends orders (paper endpoint only); without it everything is printed and nothing is sent. OFF switch: data/r295-OFF.`, "header");

// A — fixed superset + covering first5 cache
rep(`async function fetchFirst5(date, syms) {
  const f = path.join(CACHE, "first5", \`\${date}.json\`); if (first5Dir(date)) return JSON.parse(fs.readFileSync(first5Dir(date), "utf8"));
  const off = offset(date);
  const r = await fetchBars(syms, { start: \`\${date}T09:30:00\${off}\`, end: \`\${date}T09:34:59\${off}\`, timeframe: "5Min", feed: "sip", adjustment: "raw", requireAll: false, quiet: true });
  const rows = {}; for (const [s, bars] of Object.entries(r.bars || {})) { const b = bars[0]; if (b) rows[s] = [b.o, b.h, b.l, b.c, b.v]; }
  const out = { date, requested: syms.length, returned: Object.keys(rows).length, rows }; writeJsonAtomic(f, out); return out;
}`,
`async function fetchFirst5(date, syms) {   // v4 A: a cached day is topped up when it does not cover the requested list (merge, never shrink)
  const f = path.join(CACHE, "first5", \`\${date}.json\`), have = first5Dir(date) ? JSON.parse(fs.readFileSync(first5Dir(date), "utf8")) : { date, rows: {} };
  const rows = { ...(have.rows || {}) }, absent = new Set(have.absent || []), need = syms.filter((x) => !rows[x] && !absent.has(x));
  if (!need.length) return { ...have, rows };
  const off = offset(date);
  const r = await fetchBars(need, { start: \`\${date}T09:30:00\${off}\`, end: \`\${date}T09:34:59\${off}\`, timeframe: "5Min", feed: "sip", adjustment: "raw", requireAll: false, quiet: true });
  for (const [x, bars] of Object.entries(r.bars || {})) { const b = bars[0]; if (b) rows[x] = [b.o, b.h, b.l, b.c, b.v]; }
  for (const x of need) if (!rows[x]) absent.add(x);
  const out = { date, requested: Object.keys(rows).length + absent.size, returned: Object.keys(rows).length, absent: [...absent].sort(), toppedUp: [...(have.toppedUp || []), { at: new Date().toISOString(), asked: need.length }], rows };
  writeJsonAtomic(f, out); return out;
}`, "A fetchFirst5");
rep(`function candidateSymbols() {
  const dirs = [path.join(CACHE, "first5"), path.join(R287C, "first5")].filter((d) => fs.existsSync(d));
  const latest = dirs.flatMap((d) => fs.readdirSync(d).map((f) => path.join(d, f))).filter((f) => /\\d{4}-\\d{2}-\\d{2}\\.json$/.test(f)).sort((a, b) => path.basename(a).localeCompare(path.basename(b))).pop();
  if (!latest) throw new Error("no first5 cache to take the candidate list from");
  return Object.keys(JSON.parse(fs.readFileSync(latest, "utf8")).rows || {}).filter((s) => !/[.\\-/]/.test(s)).sort();
}`,
`const SUPERSET = path.join(CACHE, "superset.json");
function candidateSymbols() {   // v4 A: a FIXED superset (never the newest first5 file, which after 09-29 held only yesterday's eligible names)
  if (!fs.existsSync(SUPERSET)) {
    const dir = path.join(R287C, "first5"), files = fs.readdirSync(dir).filter((f) => /^\\d{4}-\\d{2}-\\d{2}\\.json$/.test(f) && f <= "2026-09-28.json").sort().slice(-LOOK), u = new Set();
    for (const f of files) for (const x of Object.keys(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).rows || {})) if (!/[.\\-/]/.test(x)) u.add(x);
    writeJsonAtomic(SUPERSET, { id: ID, frozenAt: new Date().toISOString(), source: \`union of R287's first5 fetch lists \${files[0]}..\${files[files.length - 1]} (R287's loose superset: ADV14>=500k and prior close>=3 on any of the next 14 sessions)\`,
      knownWeakness: "fixed: names that list or become liquid after 2026-09-28 never enter; a nightly loose-screen refresh is filed in the audit queue", symbols: [...u].sort() });
  }
  return JSON.parse(fs.readFileSync(SUPERSET, "utf8")).symbols;
}`, "A candidateSymbols");
rep(`selectionOverlapWithSip: overlap, unreconciledLots`, `selectionOverlapWithSip: overlap, fidelityUniverse: S.fidelityUniverse || null, unreconciledLots`, "A row");
rep(`const uni = JSON.parse(fs.readFileSync(path.join(CACHE, \`universe-\${date}.json\`), "utf8")); const f5`, `const uni = JSON.parse(fs.readFileSync(path.join(CACHE, \`universe-\${date}.json\`), "utf8")); S.fidelityUniverse = { candidates: uni.candidates, eligible: uni.eligible }; const f5`, "A fidelity");

// C — re-read each stop after the cancel before sizing the MOC
rep(`    for (const id of p.stopIds || []) { const so = await byId(id); if (!so) continue; stopFilled += Math.round(Number(so.filled_qty) || 0); if (!["filled", "canceled", "expired", "rejected"].includes(so.status)) await cancel(so); }
    if (!(p.stopIds || []).length && p.stopCid) { const so = await byCid(p.stopCid); stopFilled = Math.round(Number(so && so.filled_qty) || 0); if (so && so.status !== "filled") await cancel(so); }   // v1 sessions`,
`    const TERM = ["filled", "canceled", "expired", "rejected"];
    const settle = async (so) => { if (!so) return 0; if (!TERM.includes(so.status)) { await cancel(so); for (let i = 0; i < 6 && LIVE; i++) { await sleep(500); const r = await byId(so.id); if (r) so = r; if (TERM.includes(so.status)) break; } } return Math.round(Number(so.filled_qty) || 0); };   // v4 C: final filled_qty AFTER the cancel
    for (const id of p.stopIds || []) stopFilled += await settle(await byId(id));
    if (!(p.stopIds || []).length && p.stopCid) stopFilled = await settle(await byCid(p.stopCid));   // v1 sessions`, "C closeOut");

// B + E — over-exit booked apart; open lots flattened at the next open
rep(`    const remQ = Math.max(0, q - exitQ), markVal = remQ * markPx;
    p.realized = +((p.dir > 0 ? (exitVal + markVal) - q * ep : q * ep - (exitVal + markVal))).toFixed(2);
    if (remQ > 0) { p.markedQty = remQ; p.markPx = markPx; marked.push(\`\${p.sym}:\${remQ}@\${markPx}\`); }
    if (exitQ > q) marked.push(\`\${p.sym}:OVER-EXIT \${exitQ - q}\`);`,
`    const remQ = Math.max(0, q - exitQ), markVal = remQ * markPx, avgExit = exitQ ? exitVal / exitQ : 0, bookedQ = Math.min(exitQ, q);   // v4 B
    p.realized = +((p.dir > 0 ? (bookedQ * avgExit + markVal) - q * ep : q * ep - (bookedQ * avgExit + markVal))).toFixed(2);
    if (remQ > 0) { p.markedQty = remQ; p.markPx = markPx; marked.push(\`\${p.sym}:\${remQ}@\${markPx}\`); openLots.push({ sym: p.sym, qty: remQ, side: p.dir > 0 ? "sell" : "buy", why: "unexited" }); }
    if (exitQ > q) { const xq = exitQ - q; p.overExitQty = xq; p.overExitPnl = +(p.dir * (avgExit - markPx) * xq).toFixed(2); overExitPnl += p.overExitPnl; overExitQty += xq;
      marked.push(\`\${p.sym}:OVER-EXIT \${xq}\`); openLots.push({ sym: p.sym, qty: xq, side: p.dir > 0 ? "buy" : "sell", why: "over-exit (flipped lot)" }); }`, "B booking");
rep(`  let pnl = 0, fees = 0, slip = [], filledN = 0; const marked = [];`, `  let pnl = 0, fees = 0, slip = [], filledN = 0, overExitPnl = 0, overExitQty = 0; const marked = [], openLots = [];`, "B vars");
rep(`selectionOverlapWithSip: overlap, fidelityUniverse`, `overExit: overExitQty || 0, overExitPnl: +overExitPnl.toFixed(2), openLotsAtClose: openLots, selectionOverlapWithSip: overlap, fidelityUniverse`, "B row");
rep(`  log(\`after-close \${date}: filled`,
`  if (openLots.length) {   // v4 E: never leave an R295 lot on the broker overnight (09-30 KMX); queued day market orders fill at the next open
    const msg = \`R295 \${date}: \${openLots.length} lot(s) open after the close — \${openLots.map((l) => \`\${l.sym} \${l.side} \${l.qty} (\${l.why})\`).join(", ")}\`;
    if (process.argv.includes("--live")) for (const l of openLots) { try { const o = await submit({ symbol: l.sym, qty: String(l.qty), side: l.side, type: "market", time_in_force: "day", client_order_id: cidOf(date, l.sym, "FLATTEN") }); S.notes.push(\`\${l.sym} FLATTEN queued \${o.status}\`); } catch (e) { S.notes.push(\`\${l.sym} FLATTEN failed: \${e.message.slice(0, 80)}\`); } }
    else S.notes.push("open lots not flattened (no --live): " + msg);
    writeJsonAtomic(sp, S); try { await require("./notify.js").notify("R295 open lots after close", msg); } catch (e) { log("notify failed: " + e.message); }
  }
  interimKill();
  log(\`after-close \${date}: filled`, "E flatten");

// D — read-once seal on the first 60; interim kill
rep(`function read() {
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); const t = reg.preregistered.find((e) => e.id === ID); const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if (seals.tests[ID]) throw new Error("already sealed"); const { s, ev } = status(); if (ev.length < READ_AT) throw new Error(\`\${ev.length} evidence sessions < \${READ_AT} — refusing\`);
  const bar = t.bar.tRequired, verdict = s.tNet >= bar ? "PASS" : "DID NOT PASS"; writeJsonAtomic(OUT, { ...s, bar, verdict, readAt: new Date().toISOString() }); console.log(verdict, s.tNet, "vs", bar);
}`,
`function read() {   // v4 D: read once, on the FIRST 60 evidence sessions, and seal
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); const t = reg.preregistered.find((e) => e.id === ID); const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
  if ((seals.tests || {})[ID]) throw new Error("already sealed — read once"); if (fs.existsSync(OUT) && JSON.parse(fs.readFileSync(OUT, "utf8")).verdict) throw new Error("OUT already holds a verdict — read once");
  const { ev: all } = status(); if (all.length < READ_AT) throw new Error(\`\${all.length} evidence sessions < \${READ_AT} — refusing\`);
  const ev = all.slice(0, READ_AT), bad = ev.filter((r) => r.overExit && !r.overExitResolved); if (bad.length) throw new Error(\`over-exit unresolved on \${bad.map((r) => r.date).join(", ")} — resolve (set overExitResolved with a note) before the read\`);
  const x = ev.map((r) => r.netRet), tN = tOf(x), bar = t.bar.tRequired, verdict = tN != null && tN >= bar ? "PASS" : "DID NOT PASS";
  const res = { id: ID, sessions: ev.length, window: [ev[0].date, ev[ev.length - 1].date], meanNetRet: +mean(x).toFixed(6), tNet: tN == null ? null : +tN.toFixed(3), cumNetPnl: +ev.reduce((a, r) => a + r.netPnl, 0).toFixed(2), winSessions: ev.filter((r) => r.netRet > 0).length, bar, verdict, readAt: new Date().toISOString() };
  writeJsonAtomic(OUT, res);
  seals.tests = seals.tests || {}; seals.tests[ID] = { sealedOn: new Date().toISOString().slice(0, 10), unit: "evidence sessions (first 60), one-sample t of session net return", verdict: \`\${verdict} — net t \${res.tNet} vs bar \${bar} over \${ev.length} sessions \${res.window.join("..")}; mean \${(100 * res.meanNetRet).toFixed(3)}% of NAV/session; \${res.winSessions}/\${ev.length} sessions positive\`, output: "data/r295-orb-forward.json" };
  writeJsonAtomic(D("read-seals.json"), seals); console.log(verdict, res.tNet, "vs", bar);
}
function interimKill() {   // v4 D: registered interim kill — at 20 evidence sessions, net t <= -2.0 -> stop (kill-only; evaluated once)
  const f = D("r295-interim.json"); if (fs.existsSync(f)) return;
  const { ev } = status(); if (ev.length < 20) return; const x = ev.slice(0, 20).map((r) => r.netRet), tN = tOf(x), kill = tN != null && tN <= -2.0;
  writeJsonAtomic(f, { id: ID, at: new Date().toISOString(), sessions: 20, window: [ev[0].date, ev[19].date], tNet: tN == null ? null : +tN.toFixed(3), rule: "net t <= -2.0 at 20 evidence sessions -> stop", kill });
  if (kill) { fs.writeFileSync(OFF, \`R295 interim kill \${new Date().toISOString()}: net t \${tN.toFixed(3)} <= -2.0 at 20 evidence sessions\\n\`); log("INTERIM KILL — OFF switch set"); }
}`, "D read");
rep(`  ok.push(["client ids", cidOf("2026-10-01", "ABC", "L") === "r295-ABC-20261001-L"]);`,
`  ok.push(["client ids", cidOf("2026-10-01", "ABC", "L") === "r295-ABC-20261001-L"]);
  { const sup = candidateSymbols(); ok.push([\`v4 A superset is fixed and large (\${sup.length} names, not a first5 file)\`, sup.length >= 2000 && JSON.stringify(sup) === JSON.stringify(candidateSymbols())]); }`, "selftest");
fs.writeFileSync(OUTF, s); console.log("written", OUTF, s.length, "bytes");
