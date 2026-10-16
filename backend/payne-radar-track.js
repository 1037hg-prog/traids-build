#!/usr/bin/env node
/**
 * PAYNE RADAR — weightless forward record (2026-09-23, operator: "yes run both").
 *
 * Source: Payne's Education webinar of Tuesday 2026-09-15 (dated by its own NVDA close, $212.17 = the 2026-09-15 official close; watched as a replay in screen recording 2026-09-23 130415), slide "Stocks on Charles' Radar":
 * NVDA, META, AMZN, AAPL, HOOD, BIIB. No entry rule, no exit rule, no sizing was given, so this is NOT a registered test and has no bar.
 * It is a record: equal-weight buy at the 2026-09-15 official close, held, compared nightly with SPY bought at the same close.
 * Nothing is traded. The anchor closes are frozen on first run (data/payne-radar.json) and never rewritten.
 *
 *   node backend/payne-radar-track.js            freeze (first run) + append tonight's mark (close chain)
 *   node backend/payne-radar-track.js --status   print the record, write nothing
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const OUT = path.join(__dirname, "data", "payne-radar.json");
const NAMES = ["NVDA", "META", "AMZN", "AAPL", "HOOD", "BIIB"], BENCH = "SPY", ANCHOR = "2026-09-15";
const STATUS = process.argv.includes("--status");

(async () => {
  let rec = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;
  if (STATUS) { if (!rec) { console.log("PAYNE RADAR — not frozen yet"); return; } const m = rec.marks[rec.marks.length - 1]; console.log(m ? `PAYNE RADAR ${m.date}: basket ${m.basketPct}% vs SPY ${m.spyPct}% (${m.excessPct >= 0 ? "+" : ""}${m.excessPct} pts)` : "PAYNE RADAR — frozen, no marks yet"); return; }
  const { bars } = await fetchBars([...NAMES, BENCH], { start: ANCHOR, end: new Date(Date.now() - 20 * 60e3).toISOString(), feed: "sip", requireAll: true, quiet: true });
  const day = (b) => b.t.slice(0, 10);
  if (!rec) {
    const anchor = {}; for (const s of [...NAMES, BENCH]) { const b = bars[s].find((x) => day(x) === ANCHOR); if (!b) throw new Error(`no ${ANCHOR} bar for ${s} — refusing to freeze`); anchor[s] = b.c; }
    rec = { spec: "payne-radar-v1", weight: "NONE — record only, no bar, not a registered test", source: "Payne's Education webinar 2026-09-15 (dated by NVDA close 212.17), slide 'Stocks on Charles' Radar' (recording 2026-09-23 130415)", frozenAt: new Date().toISOString(), anchorDate: ANCHOR, names: NAMES, bench: BENCH, anchorClose: anchor, marks: [] };
    console.log(`PAYNE RADAR frozen at the ${ANCHOR} close: ${Object.entries(anchor).map(([k, v]) => k + " " + v).join(" · ")}`);
  }
  // latest COMPLETED session common to every name (never a forming bar: only dates before today ET, or today once the chain runs after the close)
  const dates = bars[BENCH].map(day).filter((d) => d > ANCHOR && NAMES.every((s) => bars[s].some((x) => day(x) === d)));
  let added = 0;
  for (const d of dates) { if (rec.marks.some((m) => m.date === d)) continue;
    const px = (s) => bars[s].find((x) => day(x) === d).c, per = Object.fromEntries(NAMES.map((s) => [s, +(100 * (px(s) / rec.anchorClose[s] - 1)).toFixed(2)]));
    const basket = +(Object.values(per).reduce((a, b) => a + b, 0) / NAMES.length).toFixed(2), spy = +(100 * (px(BENCH) / rec.anchorClose[BENCH] - 1)).toFixed(2);
    rec.marks.push({ date: d, basketPct: basket, spyPct: spy, excessPct: +(basket - spy).toFixed(2), perName: per, markedAt: new Date().toISOString() }); added++; }
  rec.asOf = new Date().toISOString(); writeJsonAtomic(OUT, rec);
  const m = rec.marks[rec.marks.length - 1];
  console.log(m ? `PAYNE RADAR ${m.date} (${rec.marks.length} session(s) since ${ANCHOR}): basket ${m.basketPct}% vs SPY ${m.spyPct}% → ${m.excessPct >= 0 ? "+" : ""}${m.excessPct} pts · ${Object.entries(m.perName).map(([k, v]) => k + " " + v + "%").join(" · ")}${added ? "" : " (no new session)"}` : "PAYNE RADAR — frozen; first mark after the next completed session");
})().catch((e) => { console.error("PAYNE RADAR FAILED:", e.message); process.exit(1); });
