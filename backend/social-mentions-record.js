#!/usr/bin/env node
/**
 * SOCIAL MENTIONS RECORDER — daily snapshot of retail chatter, so "retail hype" can be tested FORWARD. 2026-09-24, operator: "all three"
 * (reels intake, Reddit/YouTube in the scout, and recording mention counts). No historical source is free; the record starts today.
 *
 * Sources (public, no key; read-only, one polite pass a day):
 *   ApeWisdom  — Reddit/4chan mention counts, all-stocks and all-crypto filters (mentions, upvotes, rank, 24h-ago rank/mentions)
 *   Stocktwits — trending symbols (with watchlist counts and trending score)
 * Output: data/social-mentions/<YYYY-MM-DD>.json (ET date of the run) — one file per day, never rewritten once complete.
 *   node backend/social-mentions-record.js
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const DIR = path.join(__dirname, "data", "social-mentions"); if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
const etDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { "User-Agent": "Mozilla/5.0 (TRAIDS research recorder; daily)" };
async function getJson(url) { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }

(async () => {
  const day = etDay(), f = path.join(DIR, `${day}.json`);
  if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j.complete) { console.log(`social mentions ${day} already recorded`); return; } }
  const out = { spec: "social-mentions-v1", day, recordedAt: new Date().toISOString(), sources: {}, errors: [] };
  for (const filter of ["all-stocks", "all-crypto"]) {
    const rows = [];
    try {
      const first = await getJson(`https://apewisdom.io/api/v1.0/filter/${filter}/page/1`); rows.push(...first.results);
      for (let p = 2; p <= Math.min(first.pages || 1, 12); p++) { await sleep(800); rows.push(...(await getJson(`https://apewisdom.io/api/v1.0/filter/${filter}/page/${p}`)).results); }
      out.sources[`apewisdom:${filter}`] = rows.map((r) => ({ t: r.ticker, rank: +r.rank, m: +r.mentions, up: +r.upvotes, rank24: r.rank_24h_ago == null ? null : +r.rank_24h_ago, m24: r.mentions_24h_ago == null ? null : +r.mentions_24h_ago }));
    } catch (e) { out.errors.push(`apewisdom ${filter}: ${e.message}`); }
  }
  try {
    const j = await getJson("https://api.stocktwits.com/api/2/trending/symbols.json");
    out.sources["stocktwits:trending"] = (j.symbols || []).map((s, i) => ({ t: s.symbol, rank: i + 1, watch: s.watchlist_count ?? null, score: s.trending_score ?? null, exch: s.exchange || null }));
  } catch (e) { out.errors.push(`stocktwits: ${e.message}`); }
  out.complete = out.errors.length === 0;
  writeJsonAtomic(f, out);
  console.log(`social mentions ${day}: ` + Object.entries(out.sources).map(([k, v]) => `${k} ${v.length}`).join(" · ") + (out.errors.length ? ` · ERRORS ${out.errors.join("; ")}` : ""));
  if (out.errors.length) process.exit(1);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
