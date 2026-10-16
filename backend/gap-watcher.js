#!/usr/bin/env node
/**
 * R23 — EXTREME-GAP WATCHER. The sensor the system lacked on 2026-08-19.
 *
 * That morning MRNA gapped +85% on public pre-market news (melanoma vaccine readout) and ran a
 * further +18.8% open-to-close. Nothing here could even SEE it: no component looks at the tape
 * between the close chain and the 09:35 open run, and the open run selects by signal rules that
 * will never pick an 85% gapper. Operator, correctly: "this should have been caught this morning."
 *
 * WHAT THE DATA SAYS, measured before this was built (2y, 837 names, day-clustered):
 *   gap 10-20%:  n=469  open->close +0.04%, median NEGATIVE, worst -20.5%   — dead
 *   gap 20-40%:  n= 94  open->close -1.36%                                  — negative
 *   gap 40%+  :  n=  8  open->close +7.29%, t=1.98 vs an honest best-of-3 bar of 2.77 — FAILS,
 *                and the 40% threshold was chosen after seeing MRNA, which is in the sample.
 *
 * So this is a SENSOR plus a pre-registered FORWARD LEDGER, not a strategy. It records every
 * >=40% open gap in the universe from today on, at the official opening print, and grades
 * open->close in the nightly chain. At ~4 events/year the forward n accrues slowly and the file
 * says so — but every event is also an operator ALERT (written loudly to the log and the state
 * file), which is the part that answers "we should have caught it": from tomorrow, a morning like
 * MRNA's is on your screen minutes after the open instead of in an article at 11:32.
 *
 * PRE-REGISTERED, before the first forward event: threshold 40% (in-sample origin disclosed),
 * entry = official opening auction print, exit = same-day close, no sizing, no read before 20
 * forward events, and the 20-40% bucket is explicitly NOT tracked as tradeable (it measured
 * negative). Nothing here trades.
 *
 * Usage:  node backend/gap-watcher.js --scan     morning: detect + record (idempotent per day)
 *         node backend/gap-watcher.js            evening: grade today's events at the close
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const OUT = path.join(__dirname, "data", "gap-watcher.json");
const GAP_MIN = 40;                        // percent; pre-registered, in-sample origin disclosed above
const HDRS = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
const etDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const load = () => { try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {
  return { spec: "R23-v1", registered: "2026-08-19", status: "SENSOR + FORWARD LEDGER — LOGGED, NEVER TRADED",
    rule: `record every open gap >= ${GAP_MIN}% vs prior close, entry = official opening print, graded open->close; read gate 20 forward events`,
    insample: "2y history: 40%+ bucket n=8, +7.29% o->c, FAILS the best-of-3 null bar (2.77); 10-40% gaps measured flat-to-negative and are not tracked",
    events: [] }; } };

(async () => {
  const st = load(); const today = etDay(); const scan = process.argv.includes("--scan");
  const map = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "sector-map.json"), "utf8"));
  const uni = Object.keys(map);

  if (scan) {
    if (st.events.some(e => e.date === today)) { console.log(`R23 — ${today} already scanned (idempotent).`); return; }
    const found = []; let seen = 0;
    for (let i = 0; i < uni.length; i += 100) {
      const chunk = uni.slice(i, i + 100);
      try {
        const r = await fetch(`https://data.alpaca.markets/v2/stocks/snapshots?symbols=${chunk.join(",")}&feed=iex`, { headers: HDRS, signal: AbortSignal.timeout(30000) });
        if (!r.ok) continue;
        // multi-symbol snapshots return a BARE map, not {snapshots:{...}} — .snapshots||{} made
        // the whole scan an empty loop that printed "no gap" on the very day MRNA gapped 85%.
        const j2 = await r.json();
        const snaps = j2.snapshots || j2;
        for (const [sym, s] of Object.entries(snaps)) {
          seen++;
          const prev = s.prevDailyBar?.c, o = s.dailyBar?.o, t = s.dailyBar?.t;
          if (!(prev > 1) || !(o > 0) || String(t).slice(0, 10) !== today) continue;
          const gap = 100 * (o / prev - 1);
          if (gap >= GAP_MIN) found.push({ date: today, sym, prevClose: prev, open: o, gap: +gap.toFixed(1), recordedAt: new Date().toISOString(), close: null, oc: null });
        }
      } catch {}
    }
    // SILENT-ZERO GUARD: scanning 800+ names and evaluating none is a broken feed or a broken
    // parser, never a quiet morning — refuse to record a clean-looking empty result.
    if (seen < uni.length * 0.5) { console.error(`R23 SCAN REFUSED — only ${seen}/${uni.length} symbols evaluated; feed or parser problem, nothing recorded.`); process.exit(2); }
    st.events.push(...found);
    fs.writeFileSync(OUT, JSON.stringify(st, null, 1));
    if (found.length) {
      console.log(`\n  ██ R23 EXTREME GAP ALERT — ${today} ██`);
      for (const e of found) console.log(`     ${e.sym}  gapped +${e.gap}% at the open (${e.prevClose} -> ${e.open}) — recorded at the opening print`);
    } else console.log(`R23 — ${today}: no gap >= ${GAP_MIN}% in ${uni.length} names.`);
    return;
  }

  // evening: grade any ungraded events from the daily bar's close
  const open = st.events.filter(e => e.oc == null);
  if (!open.length) { console.log(`R23 — nothing to grade · ${st.events.length} event(s) on the forward ledger.`); return; }
  const syms = [...new Set(open.map(e => e.sym))];
  const r = await fetch("http://localhost:3001/api/equities/bars", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: syms, days: 10 }) });
  const data = r.ok ? (await r.json()).data || {} : {};
  for (const e of open) {
    const bar = (data[e.sym] || []).find(b => b.t === e.date);
    if (!bar || !(bar.c > 0)) continue;
    e.close = bar.c; e.oc = +(100 * (bar.c / e.open - 1)).toFixed(2);
  }
  fs.writeFileSync(OUT, JSON.stringify(st, null, 1));
  const g = st.events.filter(e => e.oc != null);
  console.log(`R23 — graded ${open.filter(e => e.oc != null).length} event(s) · forward ledger ${g.length}/20 toward the read gate`);
  for (const e of g.slice(-5)) console.log(`   ${e.date} ${e.sym.padEnd(6)} gap +${e.gap}%  open->close ${e.oc >= 0 ? "+" : ""}${e.oc}%`);
})();
