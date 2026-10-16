#!/usr/bin/env node
// Outcome-free availability probe (2026-09-18): does the futures vendor serve European / Japanese index futures or palladium?
// Daily-session volume rows only. No engine, no rule, no result.
require("./futures-testbed.js");   // loads backend/.env into process.env (values never printed)
const KEY = process.env.MASSIVE_API_KEY, BASE = (process.env.MASSIVE_API_BASE_URL || "https://api.massive.com").replace(/\/$/, "");
const ROOTS = { FESX: "Euro Stoxx 50 (Eurex)", FDAX: "DAX (Eurex)", FDXM: "Mini-DAX (Eurex)", FSXE: "Micro Euro Stoxx (Eurex)", NKD: "Nikkei 225 USD (CME)", NIY: "Nikkei 225 yen (CME)", PA: "Palladium (NYMEX)", Z: "FTSE 100 (ICE)", NQ: "control — must resolve" };
(async () => {
  for (const [root, name] of Object.entries(ROOTS)) {
    const hits = [];
    for (const t of [`${root}U6`, `${root}Z6`, `${root}U26`, `${root}Z26`]) {
      try { const r = await fetch(`${BASE}/futures/v1/aggs/${t}?resolution=1session&window_start.gte=2026-07-01&limit=200`, { headers: { Authorization: `Bearer ${KEY}` } });
        const n = r.ok ? ((await r.json()).results || []).length : 0; if (n) hits.push(`${t}:${n} sessions`); else if (!r.ok) hits.push(`${t}:HTTP ${r.status}`); } catch (e) { hits.push(`${t}:ERR`); }
    }
    console.log(root.padEnd(5), name.padEnd(28), hits.filter((h) => /sessions/.test(h)).join("  ") || "nothing served   (" + hits.join(" ") + ")");
  }
})();
