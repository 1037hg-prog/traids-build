#!/usr/bin/env node
/**
 * EARNINGS CALENDAR RECORDER — daily snapshot of Alpha Vantage's forward earnings calendar (3-month horizon), so earnings-DATE REVISIONS
 * can be tested forward (Johnson & So 2018: firms that push their date later deliver worse news). AV serves only the current calendar;
 * revisions exist only if we keep every day's copy. 2026-09-24, operator: "yes both" (scout 09-24 item #4; historical leg is R183).
 * Output: data/earnings-calendar/<ET day>.json {rows:[{s, name, reportDate, fiscalDateEnding, estimate, currency}]}; never rewritten once complete.
 *   node backend/earnings-calendar-record.js
 */
const fs = require("fs"), path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const KEY = process.env.ALPHAVANTAGE_KEY || process.env.ALPHA_VANTAGE_KEY;
const DIR = path.join(__dirname, "data", "earnings-calendar"); if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
(async () => {
  const f = path.join(DIR, `${day}.json`);
  if (fs.existsSync(f) && JSON.parse(fs.readFileSync(f, "utf8")).complete) { console.log(`earnings calendar ${day} already recorded`); return; }
  if (!KEY) throw new Error("Alpha Vantage key not set in backend/.env");
  const r = await fetch(`https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=3month&apikey=${KEY}`, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`AV ${r.status}`);
  const text = await r.text();
  if (!/^symbol,/i.test(text.trim())) throw new Error(`AV did not return the calendar CSV: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
  const [head, ...lines] = text.trim().split(/\r?\n/), cols = head.split(",");
  const at = (c) => cols.indexOf(c);
  const rows = lines.map((l) => l.split(",")).filter((c) => c.length >= cols.length - 1).map((c) => ({ s: c[at("symbol")], name: c[at("name")], reportDate: c[at("reportDate")], fiscalDateEnding: c[at("fiscalDateEnding")], estimate: c[at("estimate")] === "" ? null : +c[at("estimate")], currency: c[at("currency")] || null }));
  if (rows.length < 100) throw new Error(`AV returned ${rows.length} rows (a rate-limit or plan notice arrives as a one-row CSV) — nothing written, retry next run`);
  writeJsonAtomic(f, { spec: "earnings-calendar-v1", day, recordedAt: new Date().toISOString(), horizon: "3month", rows, complete: rows.length > 100 });
  console.log(`earnings calendar ${day}: ${rows.length} scheduled reports`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
