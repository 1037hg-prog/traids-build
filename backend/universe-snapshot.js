#!/usr/bin/env node
/**
 * POINT-IN-TIME UNIVERSE SNAPSHOTS (manifest D2, 2026-08-21).
 * Every night, write the roster AS IT STANDS — symbols, exchange, liquidity stats, sector ETF —
 * to data/universe-snapshots/<ET date>.json, append-only, never rewritten. Any future study over
 * the breadth era can then reconstruct membership as of its own date instead of inheriting
 * today's survivors; the universe build's survivorship caveat becomes a solved problem for
 * everything after 2026-08-24. `--asof YYYY-MM-DD` prints the roster as of a date (reader).
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const DIR = D("universe-snapshots");
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
fs.mkdirSync(DIR, { recursive: true });
const asofIdx = process.argv.indexOf("--asof");
if (asofIdx >= 0) {
  const want = process.argv[asofIdx + 1];
  const files = fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
  const pick = files.filter((d) => d <= want).pop();
  if (!pick) { console.log(`no snapshot on or before ${want} (earliest ${files[0] || "none"})`); process.exit(1); }
  const snap = JSON.parse(fs.readFileSync(path.join(DIR, pick + ".json"), "utf8"));
  console.log(JSON.stringify({ asOf: want, snapshotDate: pick, count: snap.names.length, names: snap.names.map((n) => n.sym) }));
  process.exit(0);
}
const out = path.join(DIR, `${today}.json`);
if (fs.existsSync(out)) { console.log(`UNIVERSE SNAPSHOT — ${today} already written (append-only; not rewritten).`); process.exit(0); }
const uni = JSON.parse(fs.readFileSync(D("universe-expanded.json"), "utf8"));
const sm = JSON.parse(fs.readFileSync(D("sector-map.json"), "utf8"));
const names = uni.names.map((n) => ({ sym: n.sym, exchange: n.exchange, medDollarVol: n.medDollarVol, lastPx: n.lastPx, etf: (sm[n.sym] && sm[n.sym].etf) || null, ind: (sm[n.sym] && sm[n.sym].ind) || null }));
writeJsonAtomic(out, { date: today, writtenAt: new Date().toISOString(), builtFrom: uni.builtAt, floor: uni.floor, count: names.length, rosterTop: 1200, names });
console.log(`UNIVERSE SNAPSHOT — ${today}: ${names.length} names (${names.filter((n) => n.etf).length} sector-mapped) written, append-only.`);
