#!/usr/bin/env node
"use strict";
/**
 * FUTURES BAR STORE — SEED + LAST MASSIVE PULL (2026-10-02, operator: "can we get rid of massive").
 *
 * Builds backend/data/training/futures-1m/ (lib/futures-bars.js) from what Massive already gave us, then tops it up from Massive
 * ONE LAST TIME while the subscription is live. After this, only backend/futures-bars-append.js (Schwab) writes the store.
 *
 *   node backend/futures-bars-seed.js --seed-archive        r267 (NQ ES RTY YM, 2024-09-27..2026-09-25) + massive-1m (NQ ES to
 *                                                            2026-09-29 14:08 ET) -> store. Local files only, no network.
 *   node backend/futures-bars-seed.js --massive-contracts   Massive 1session volume pick per date (futures-testbed's own mapping)
 *                                                            -> <ROOT>/contracts.json for the whole archive span
 *   node backend/futures-bars-seed.js --topup-massive       futures-testbed.loadBars (the existing Massive 1m helper) from the
 *                                                            newest stored bar to the latest CLOSED minute -> store (append-only)
 *   node backend/futures-bars-seed.js --massive-own         each NQ/ES contract that was front in the last 120 days: its OWN 1m bars
 *                                                            from 14 days before it became front (lib/marks-levels needs pre-roll bars)
 *   node backend/futures-bars-seed.js --reconcile-massive   re-pull Massive's CURRENT 1m over its whole retention (~2 years) and
 *                                                            correct any stored Massive bar that disagrees (an archive copied
 *                                                            mid-session held not-yet-final minutes: 2026-09-29 10:33-10:34 NQ/ES).
 *                                                            Only inside the Massive-sourced span: Schwab-appended bars are never touched.
 *                                                            Run once more right before cancelling (Massive corrects minutes late).
 *   --roots NQ,ES,RTY,YM    (default)      --dry-run   compute and print, write nothing
 *
 * Every write goes through lib/futures-bars.js mergeIntoStore (session dates only, closed minutes only, never rewrites a bar) and
 * records provenance in the file it touched. The manifest is rewritten at the end of every mode.
 */
const fs = require("fs"), path = require("path");
const FB = require("./lib/futures-bars.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const ri = argv.indexOf("--roots");
const ROOTS = ri >= 0 ? argv[ri + 1].split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : ["NQ", "ES", "RTY", "YM"];
const TRAIN = path.join(__dirname, "data", "training");

(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const KEY = () => process.env.MASSIVE_API_KEY, BASE = () => (process.env.MASSIVE_API_BASE_URL || "https://api.massive.com").replace(/\/$/, "");
const MCODES = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"];
const needKey = () => { if (!KEY()) { console.error("MASSIVE_API_KEY is not set — this mode needs the live Massive subscription"); process.exit(3); } };

async function getJson(url) {
  for (let t = 0; t < 3; t++) {
    try { const r = await fetch(url, { headers: { Authorization: `Bearer ${KEY()}` }, signal: AbortSignal.timeout(60000) }); if (r.ok) return await r.json(); } catch {}
    await new Promise((res) => setTimeout(res, 1500));
  }
  return null;
}
async function aggsAll(ticker, resolution, gte, maxPages) {
  let url = `${BASE()}/futures/v1/aggs/${ticker}?resolution=${resolution}&window_start.gte=${gte}&limit=50000`; const out = [];
  for (let p = 0; p < maxPages && url; p++) { const j = await getJson(url); if (!j) throw new Error(`Massive ${ticker} ${resolution} page ${p} failed`); for (const b of j.results || []) out.push(b); url = j.next_url || null; }
  return out;
}
/** futures-testbed.loadBars' front-month pick, verbatim: max 1session volume per session date over Y-2..Y+1 x 12 months. */
async function massiveChosen(root, lookbackDays) {
  const from = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const Y = new Date().getFullYear(), tickers = [];
  for (const y of [Y - 2, Y - 1, Y, Y + 1]) for (const m of MCODES) tickers.push(`${root}${m}${y % 10}`);
  const byDate = {};
  for (let i = 0; i < tickers.length; i += 16) {
    const res = await Promise.all(tickers.slice(i, i + 16).map((t) => getJson(`${BASE()}/futures/v1/aggs/${t}?resolution=1session&window_start.gte=${from}&limit=50000`).then((j) => ({ t, rs: (j && j.results) || [] }))));
    for (const { t, rs } of res) for (const b of rs) {
      const d = b.session_end_date || FB.etFields(b.window_start / 1e6).date;
      if (!(b.volume > 0)) continue;
      if (!byDate[d] || b.volume > byDate[d].v) byDate[d] = { t, v: b.volume };
    }
  }
  const chosen = {}; for (const d of Object.keys(byDate).sort()) chosen[d] = byDate[d].t;
  return chosen;
}
const toBar = (b) => { const { date, time } = FB.etFields(b.window_start / 1e6); return { ns: b.window_start, date, time, o: b.open, h: b.high, l: b.low, c: b.close, v: Number(b.volume) || 0 }; };
const fmtRes = (r) => `added ${r.added}, identical dupes ${r.identical}, CONFLICTS ${r.conflicts}, non-session ${r.skippedNonSession}, already-stored ${r.skippedOld}, forming ${r.skippedForming}${r.added ? `, ${r.from} .. ${r.to}` : ""}`;

(async () => {
  const report = { mode: argv.filter((a) => a.startsWith("--")).join(" "), at: new Date().toISOString(), dryRun: DRY, roots: {} };

  if (argv.includes("--seed-archive")) {
    for (const root of ROOTS) {
      const rep = (report.roots[root] ||= {});
      const f1 = path.join(TRAIN, "r267", `${root}-1m.json`);
      if (fs.existsSync(f1)) {
        const j = JSON.parse(fs.readFileSync(f1, "utf8"));
        const r = FB.mergeIntoStore(root, j.bars, { source: "massive-archive:r267", file: "backend/data/training/r267/" + root + "-1m.json", fetchedAt: j.fetchedAt, origin: j.source }, { mode: "seed", dryRun: DRY });
        rep.r267 = r; console.log(`  ${root} r267: ${fmtRes(r)}`);
      } else console.log(`  ${root} r267: no file`);
      const dir = path.join(TRAIN, "massive-1m");
      const f2 = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.startsWith(`${root}-1m-`) && f.endsWith(".json")) : null;
      if (f2) {
        const readme = JSON.parse(fs.readFileSync(path.join(dir, "README.json"), "utf8"));
        const bars = JSON.parse(fs.readFileSync(path.join(dir, f2), "utf8"));
        const r = FB.mergeIntoStore(root, bars, { source: "massive-archive:massive-1m", file: "backend/data/training/massive-1m/" + f2, fetchedAt: readme.savedAt, origin: readme.source }, { mode: "seed", dryRun: DRY });
        rep.massive1m = r; console.log(`  ${root} massive-1m: ${fmtRes(r)}`);
        if (r.conflicts) console.log("    CONFLICT samples:", JSON.stringify(r.conflictSamples));
      }
    }
  }

  if (argv.includes("--massive-contracts")) {
    needKey();
    for (const root of ROOTS) {
      const chosen = await massiveChosen(root, 760);
      const n = FB.mergeContracts(root, chosen, { source: "massive-1session-volume-pick", method: "futures-testbed.loadBars mapping (max 1session volume per session_end_date)", lookbackDays: 760 }, { overwrite: true, dryRun: DRY });
      const dates = Object.keys(chosen);
      (report.roots[root] ||= {}).contracts = { dates: dates.length, written: n, first: dates[0], last: dates[dates.length - 1], tickers: [...new Set(Object.values(chosen))] };
      console.log(`  ${root} contracts: ${dates.length} session dates ${dates[0]}..${dates[dates.length - 1]}, ${n} written; tickers ${[...new Set(Object.values(chosen))].join(" ")}`);
    }
  }

  if (argv.includes("--topup-massive")) {
    needKey();
    const tb = require("./futures-testbed");                           // the existing Massive 1m helper: same mapping, same stitch, same rows
    for (const root of ROOTS) {
      const last = FB.lastBar(root);
      if (!last) { console.log(`  ${root}: store empty — run --seed-archive first`); continue; }
      const lookbackDays = Math.ceil((Date.now() - Date.parse(last.date + "T00:00:00Z")) / 864e5) + 3;
      const bars = await tb.loadBars({ root, resolution: "1minute", pages: 14, lookbackDays, quiet: true });
      const r = FB.mergeIntoStore(root, bars, { source: "massive-topup", via: "futures-testbed.loadBars 1minute pages 14", lookbackDays, fetchedAt: new Date().toISOString() }, { mode: "append", dryRun: DRY });
      (report.roots[root] ||= {}).topup = { fetched: bars.length, fetchedLast: bars.length ? `${bars[bars.length - 1].date} ${bars[bars.length - 1].time}` : null, ...r };
      console.log(`  ${root} topup: fetched ${bars.length} (newest ${bars.length ? bars[bars.length - 1].date + " " + bars[bars.length - 1].time : "-"}); ${fmtRes(r)}`);
    }
  }

  if (argv.includes("--reconcile-massive")) {
    needKey();
    const tb = require("./futures-testbed");
    for (const root of ROOTS) {
      const cutNs = FB.massiveCutoffNs(root);                          // never touch bars a Schwab append wrote
      const bars = (await tb.loadBars({ root, resolution: "1minute", pages: 14, lookbackDays: 760, quiet: true })).filter((b) => cutNs != null && b.ns <= cutNs);
      if (!bars.length) { console.log(`  ${root} reconcile: nothing from Massive inside the Massive-sourced span — skipped`); continue; }
      const lo = bars[0].ns, hi = Math.min(bars[bars.length - 1].ns, FB.lastBar(root).ns);
      const mset = new Set(bars.map((b) => b.ns));
      const storeOnly = FB.loadRange(root, bars[0].date, FB.lastBar(root).date).filter((b) => b.ns >= lo && b.ns <= hi && !mset.has(b.ns));
      const r = FB.mergeIntoStore(root, bars, { source: "massive-reconcile", via: "futures-testbed.loadBars 1minute pages 14 lookback 760", fetchedAt: new Date().toISOString() }, { mode: "reconcile", dryRun: DRY });
      (report.roots[root] ||= {}).reconcile = { massiveBars: bars.length, massiveFirst: `${bars[0].date} ${bars[0].time}`, identical: r.identical, replaced: r.replaced || 0, addedMissing: r.added - (r.replaced || 0), storeOnlyInMassiveSpan: storeOnly.length, storeOnlySample: storeOnly.slice(0, 5).map((b) => `${b.date} ${b.time}`), samples: r.conflictSamples, months: r.months };
      console.log(`  ${root} reconcile: Massive ${bars.length} bars from ${bars[0].date}; identical ${r.identical}, REPLACED ${r.replaced || 0}, added missing ${r.added - (r.replaced || 0)}, store-only minutes inside Massive's span ${storeOnly.length}${r.months.length ? " · months " + r.months.join(",") : ""}`);
      if (r.conflictSamples.length) console.log("    samples:", JSON.stringify(r.conflictSamples.slice(0, 3)));
    }
  }

  if (argv.includes("--massive-own")) {
    needKey();
    const ownDir = path.join(FB.STORE_DIR, "contracts");
    for (const root of ROOTS.filter((r) => r === "NQ" || r === "ES")) {
      const chosen = await massiveChosen(root, 120);
      const active = {}; for (const d of Object.keys(chosen).sort()) { const t = chosen[d]; (active[t] ||= [d, d])[1] = d; }
      for (const [t, [d0, d1]] of Object.entries(active)) {
        const gte = new Date(Date.parse(d0 + "T00:00:00Z") - 14 * 864e5).toISOString().slice(0, 10);
        const seen = new Set(), bars = [];
        const cut = (Math.floor(Date.now() / 60000) - 1) * 60000;
        for (const b of await aggsAll(t, "1minute", gte, 20)) { if (seen.has(b.window_start)) continue; seen.add(b.window_start); if (b.window_start / 1e6 >= cut) continue; bars.push(toBar(b)); }
        bars.sort((a, b) => a.ns - b.ns);
        const doc = { spec: "futures-1m-contract-own-v1", ticker: t, root, note: "the contract's OWN bars, every Massive 1m bar incl. Sunday-evening and holiday-dated ones (lib/marks-levels loadStitched semantics); NOT session-filtered",
          provenance: [{ source: "massive-own-contract", via: "Massive /futures/v1/aggs/<ticker> 1minute, next_url pages", frontFrom: d0, frontTo: d1, gte, rows: bars.length, from: bars.length ? `${bars[0].date} ${bars[0].time}` : null, to: bars.length ? `${bars[bars.length - 1].date} ${bars[bars.length - 1].time}` : null, fetchedAt: new Date().toISOString() }], bars };
        if (!DRY) { fs.mkdirSync(ownDir, { recursive: true }); writeJsonAtomic(path.join(ownDir, `${t}.json`), doc, { pretty: 0 }); }
        ((report.roots[root] ||= {}).own ||= {})[t] = doc.provenance[0];
        console.log(`  ${root} own ${t}: front ${d0}..${d1}, ${bars.length} bars from ${gte}${DRY ? " (dry)" : ""}`);
      }
    }
  }

  if (!DRY) { const m = FB.writeManifest({ lastSeed: report }); console.log("\n  manifest:", JSON.stringify(m.roots, null, 1)); }
  else console.log("\n  dry run — nothing written");
})().catch((e) => { console.error("futures-bars-seed:", e && e.stack || e); process.exit(1); });
