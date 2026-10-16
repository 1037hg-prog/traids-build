#!/usr/bin/env node
/**
 * #76 — FEAR & GREED CONTRARIAN CLAIM, graded on our own gauge. Registered 2026-08-23.
 *
 * The claim (everywhere, never with a ledger): extreme fear is a buy, extreme greed is a sell. Our
 * sentiment gauge (sentiment-gauge.js) has recorded its seven-component composite nightly since
 * 2026-08-12 — the data has been accruing for a test nobody registered. This is that test.
 *
 * RULE: each nightly reading (composite 0–100, recorded after the close) is an entry at that day's
 * close. Buckets by the gauge's own bands: FEAR <= 25 · GREED >= 75 · NEUTRAL otherwise. Graded at
 * +5 and +20 sessions, SPY close-to-close (SIP). Readings are daily and autocorrelated, so the unit is
 * the EPISODE: consecutive readings in the same extreme band count once, using the first reading.
 * STATISTIC: mean +20d SPY return, FEAR episodes minus NEUTRAL readings (and GREED minus NEUTRAL,
 * sign reversed), Welch t over episodes.
 * BAR (fixed now): >= 10 episodes in a band; contrarian direction with t >= 2.0 → the claim holds on
 * our gauge (study proposal, never a sleeve). Otherwise DID NOT PASS. No historical read: the gauge
 * has no history before 2026-08-12 and backfilling it would be a different instrument.
 *
 * Usage: node backend/fear-greed-cohort.js      (nightly, after sentiment gauge)
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const { fetchBarsSip } = require("./lib/sip-fetch.js");
const D = (f) => path.join(__dirname, "data", f);
const OUT = D("fear-greed-cohort.json");
const BAR = { minEpisodes: 10, tRequired: 2.0, fear: 25, greed: 75, horizons: [5, 20] };
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : null; };
const welch = (a, b) => { if (a.length < 3 || b.length < 3) return null; const va = sd(a) ** 2 / a.length, vb = sd(b) ** 2 / b.length; return va + vb > 0 ? +((mean(a) - mean(b)) / Math.sqrt(va + vb)).toFixed(3) : null; };
const etDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const etHM = () => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

(async () => {
  const g = JSON.parse(fs.readFileSync(D("sentiment-gauge.json"), "utf8"));
  const readings = (g.history || []).filter((r) => Number.isFinite(r.composite) && r.date).sort((a, b) => a.date.localeCompare(b.date));
  if (!readings.length) { console.log("#76 — no gauge readings yet."); return; }
  const today = etDay(), hm = etHM();
  // see lib/sip-fetch.js — same-day SIP is not served on this plan; the end date walks back until accepted
  const { bars, effectiveEnd, walkedBack } = await fetchBarsSip(["SPY"], { start: readings[0].date, end: today, timeframe: "1Day", quiet: true, requireAll: false });
  if (walkedBack) console.log(`  SIP would not serve through ${today}; graded through ${effectiveEnd} instead`);
  const spy = (bars.SPY || []).filter((b) => String(b.t).slice(0, 10) < today || hm >= "16:10");
  const idx = Object.fromEntries(spy.map((b, i) => [String(b.t).slice(0, 10), i]));
  const band = (c) => c <= BAR.fear ? "FEAR" : c >= BAR.greed ? "GREED" : "NEUTRAL";
  const rows = readings.map((r) => { const i = idx[r.date]; const row = { date: r.date, composite: r.composite, band: band(r.composite), entry: i != null ? spy[i].c : null }; for (const h of BAR.horizons) row["ret" + h] = i != null && spy[i + h] ? +((spy[i + h].c / spy[i].c - 1) * 100).toFixed(3) : null; return row; });
  // episodes: consecutive readings in the same extreme band count once (first reading)
  const episodes = []; let prev = null;
  for (const r of rows) { if (r.band !== "NEUTRAL" && r.band === prev) continue; if (r.band !== "NEUTRAL") episodes.push(r); prev = r.band; }
  const neutral = rows.filter((r) => r.band === "NEUTRAL");
  const stats = {};
  for (const b of ["FEAR", "GREED"]) {
    const ep = episodes.filter((r) => r.band === b);
    stats[b] = { episodes: ep.length, readings: rows.filter((r) => r.band === b).length };
    for (const h of BAR.horizons) { const a = ep.map((r) => r["ret" + h]).filter(Number.isFinite), n = neutral.map((r) => r["ret" + h]).filter(Number.isFinite); stats[b]["h" + h] = { graded: a.length, meanPct: a.length ? +mean(a).toFixed(3) : null, neutralMeanPct: n.length ? +mean(n).toFixed(3) : null, excessPct: a.length && n.length ? +(mean(a) - mean(n)).toFixed(3) : null, t: welch(a, n) }; }
  }
  const verdictFor = (b) => { const s = stats[b], x = s.h20; if (s.episodes < BAR.minEpisodes || x.t == null) return `${b}: ACCRUING — ${s.episodes}/${BAR.minEpisodes} episodes (${s.readings} readings)`; const contrarianOk = b === "FEAR" ? (x.excessPct > 0 && x.t >= BAR.tRequired) : (x.excessPct < 0 && x.t <= -BAR.tRequired); return `${b}: ${contrarianOk ? "CLAIM HOLDS on our gauge" : "DID NOT PASS"} (+20d excess ${x.excessPct}%, t ${x.t})`; };
  const out = { spec: "#76 fear-greed-cohort v1", registered: "2026-08-23", gaugeSince: readings[0].date, bar: BAR, readings: rows.length, byBand: { FEAR: rows.filter((r) => r.band === "FEAR").length, NEUTRAL: neutral.length, GREED: rows.filter((r) => r.band === "GREED").length }, stats, verdict: ["FEAR", "GREED"].map(verdictFor).join(" · "), rows, asOf: new Date().toISOString() };
  writeJsonAtomic(OUT, out);
  console.log(`#76 FEAR & GREED — ${rows.length} readings since ${readings[0].date} · FEAR ${out.byBand.FEAR} / NEUTRAL ${out.byBand.NEUTRAL} / GREED ${out.byBand.GREED} · latest ${rows[rows.length - 1].date} composite ${rows[rows.length - 1].composite} (${rows[rows.length - 1].band})`);
  for (const b of ["FEAR", "GREED"]) console.log(`  ${b.padEnd(6)} episodes ${stats[b].episodes} · +5d ${stats[b].h5.meanPct ?? "…"}% vs neutral ${stats[b].h5.neutralMeanPct ?? "…"}% · +20d ${stats[b].h20.meanPct ?? "…"}% vs ${stats[b].h20.neutralMeanPct ?? "…"}% (t ${stats[b].h20.t ?? "…"})`);
  console.log(`  ${out.verdict}\nwritten: fear-greed-cohort.json`);
})().catch((e) => { console.error("#76 failed:", e.message); process.exit(1); });
