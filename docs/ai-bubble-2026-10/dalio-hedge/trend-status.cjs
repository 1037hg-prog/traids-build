#!/usr/bin/env node
"use strict";
/** trend-status.cjs — the textbook 10-month rule as Plan E codes it (month-end adj close vs mean of the last 10 month-end adj
 *  closes, incl. the current one), evaluated at the last completed month-end 2026-09-30. Input ./data.json + EFA live from :3002. */
const D = require("./data.json"); const ME = "2026-09-30";
(async () => {
  const r = await fetch("http://localhost:3002/api/yahoo/EFA/history?days=800&interval=1d"); const j = await r.json();
  D.yahoo.EFA = j.bars.map((b) => [b.date, b.open, b.high, b.low, b.close, b.adjClose]);
  for (const s of ["QQQ", "SPY", "EFA", "GLD", "TLT", "IEF", "TIP", "DBMF", "UUP"]) {
    const m = new Map(); for (const x of D.yahoo[s]) if (x[0] <= ME) m.set(x[0].slice(0, 7), x[5]);
    const v = [...m.values()].slice(-10), last = v[v.length - 1], sma = v.reduce((a, b) => a + b, 0) / v.length;
    console.log(`${s.padEnd(5)} ${ME} adj ${last.toFixed(2).padStart(8)}  10-mo SMA ${sma.toFixed(2).padStart(8)}  ${(100 * (last / sma - 1)).toFixed(1).padStart(6)}%  ${last > sma ? "IN" : "OUT"}`);
  }
})();
