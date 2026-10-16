#!/usr/bin/env node
/**
 * FOREXFACTORY RED-FOLDER RECORDER (2026-09-28, operator: "yes build it"). Once a day, fetches the week's economic calendar from
 * ForexFactory's official public export (nfs.faireconomy.media/ff_calendar_thisweek.json — the feed its owner publishes for programs;
 * the forexfactory.com site itself is NOT scraped). The feed only ever covers the current week and has no archive, so this dated record
 * is the only history we will have.
 *   data/ff-calendar/<week-monday>.json   the latest snapshot of that week (every event, all impacts)
 *   data/ff-calendar/red-folders.json     cumulative, deduped: every HIGH-impact ("red folder") event, all currencies, with ET time
 * A failed fetch exits 1 and writes nothing (never a stale or placeholder week).
 *   node backend/ff-calendar-record.js
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const DIR = path.join(__dirname, "data", "ff-calendar"), RED = path.join(DIR, "red-folders.json");
const URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const et = (iso) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso)).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, time: `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}` }; };

(async () => {
  const r = await fetch(URL, { headers: { "User-Agent": "TRAIDS/1.0 (daily calendar record)" }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`feed HTTP ${r.status}`);
  const raw = await r.json(); if (!Array.isArray(raw) || !raw.length) throw new Error("feed returned no events");
  const events = raw.map((e) => { const t = et(e.date); return { ts: new Date(e.date).toISOString(), dateEt: t.date, timeEt: t.time, country: e.country, title: e.title, impact: e.impact, forecast: e.forecast || null, previous: e.previous || null }; })
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));
  // the feed's week can start on Sunday evening: label it by the Monday of the week that holds the MIDDLE event (ET dates)
  const mid = new Date(events[Math.floor(events.length / 2)].dateEt + "T12:00:00Z"); const monday = new Date(mid); monday.setUTCDate(mid.getUTCDate() - ((mid.getUTCDay() + 6) % 7));
  const week = monday.toISOString().slice(0, 10);
  fs.mkdirSync(DIR, { recursive: true });
  writeJsonAtomic(path.join(DIR, `${week}.json`), { source: URL, fetchedAt: new Date().toISOString(), week, count: events.length, events });
  const red = fs.existsSync(RED) ? JSON.parse(fs.readFileSync(RED, "utf8")) : { spec: "ff red folders v1 — HIGH impact, all currencies, cumulative (forward only)", coveredFrom: week, events: [] };
  if (!red.coveredFrom) red.coveredFrom = week;
  const seen = new Set(red.events.map((e) => `${e.ts}|${e.country}|${e.title}`)); let added = 0;
  for (const e of events.filter((x) => x.impact === "High")) { const k = `${e.ts}|${e.country}|${e.title}`; if (!seen.has(k)) { red.events.push(e); seen.add(k); added++; } }
  red.events.sort((a, b) => (a.ts < b.ts ? -1 : 1)); red.updatedAt = new Date().toISOString(); writeJsonAtomic(RED, red);
  const usd = events.filter((e) => e.impact === "High" && e.country === "USD");
  console.log(`ff-calendar week ${week}: ${events.length} events, ${events.filter((e) => e.impact === "High").length} red folders (${usd.length} USD) · ${added} new in the cumulative record`);
  for (const e of usd) console.log(`  ${e.dateEt} ${e.timeEt} ET  ${e.title}`);
})().catch((e) => { console.error("ff-calendar FAILED:", e.message); process.exit(1); });
