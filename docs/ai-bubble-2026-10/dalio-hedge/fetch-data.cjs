#!/usr/bin/env node
"use strict";
/**
 * fetch-data.cjs — pulls every series the Dalio hedge-regime study uses and caches it to ./data.json.
 * Sources (all public / read-only):
 *   Yahoo via the local TRAIDS proxy :3002 (yahoo-finance2; dividend-adjusted adjClose; refuses degraded/raw bars)
 *   Alpha Vantage GOLD_SILVER_HISTORY monthly (key read from backend/.env, never printed) — only 2011+, so unused for 2000-02
 *   FRED DTB3, DEXJPUS, DEXUSEU (local copies in backend/data/training/fred/)
 * Run: node fetch-data.cjs
 */
const fs = require("fs"), path = require("path");
const REPO = "C:/Users/joshc/Downloads/traids (2)/traids-bundle";
require(path.join(REPO, "backend/node_modules/dotenv")).config({ path: path.join(REPO, "backend/.env") });
const SYMS = ["QQQ","SPY","^SP500TR","^NDX","TLT","IEF","SHY","VGSH","TIP","VIPSX","GLD","GC=F","UUP","DX-Y.NYB","BIL","SGOV","DBMF","AQMIX","RYMFX","VUSTX","VFITX","VFISX","^VIX","^TNX","^IRX","^PUT","^SPGSCI","ZN=F","^GDAXI"];
const NL = /\r?\n/;
function fredCsv(id) {
  const rows = [];
  for (const l of fs.readFileSync(path.join(REPO, "backend/data/training/fred", id + ".csv"), "utf8").trim().split(NL).slice(1)) {
    const [d, v] = l.split(","); if (v && v !== ".") rows.push([d, +v]);
  }
  console.log(`FRED ${id} ${rows.length} rows ${rows[0][0]} .. ${rows.at(-1)[0]}`);
  return rows;
}
(async () => {
  const out = { fetchedAt: new Date().toISOString(), yahoo: {}, avGold: null, dtb3: [], fred: {} };
  for (const s of SYMS) {
    const r = await fetch(`http://localhost:3002/api/yahoo/${encodeURIComponent(s)}/history?days=14000&interval=1d`, { signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error(`${s} HTTP ${r.status}`);
    const j = await r.json(); if (j.degraded) throw new Error(`${s} degraded — refusing`);
    const bars = (j.bars || []).filter((b) => b.adjClose > 0 || b.close > 0);
    const raw = bars.filter((b) => b.adjSource !== "dividend-adjusted").length; if (raw) throw new Error(`${s}: ${raw} raw bars — refusing`);
    const m = new Map(); for (const b of bars) m.set(b.date, [b.open, b.high, b.low, b.close, b.adjClose]);
    out.yahoo[s] = [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, v]) => [d, ...v]);
    console.log(`yahoo ${s.padEnd(9)} ${out.yahoo[s].length} bars ${out.yahoo[s][0][0]} .. ${out.yahoo[s].at(-1)[0]}`);
  }
  try {
    const k = process.env.ALPHAVANTAGE_KEY; if (!k) throw new Error("no ALPHAVANTAGE_KEY");
    const r = await fetch(`https://www.alphavantage.co/query?function=GOLD_SILVER_HISTORY&symbol=GOLD&interval=monthly&apikey=${k}`, { signal: AbortSignal.timeout(60000) });
    const j = await r.json(); const rows = (j.data || []).map((x) => [x.date, +x.price]).filter((x) => x[1] > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (!rows.length) throw new Error("AV gold: no rows");
    out.avGold = rows; console.log(`AV gold monthly ${rows.length} rows ${rows[0][0]} .. ${rows.at(-1)[0]}`);
  } catch (e) { console.log("AV gold unavailable:", e.message); }
  out.dtb3 = fredCsv("DTB3"); out.fred.DEXJPUS = fredCsv("DEXJPUS"); out.fred.DEXUSEU = fredCsv("DEXUSEU");
  fs.writeFileSync(path.join(__dirname, "data.json"), JSON.stringify(out));
  console.log("wrote data.json");
})().catch((e) => { console.error("FAILED", e.message); process.exit(1); });
