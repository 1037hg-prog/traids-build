#!/usr/bin/env node
/** UUP month-end dollar reversal by EXECUTION TIME (2026-09-24, exploratory; seals nothing). The futures study showed the R216 effect
 *  at noon-dated Fed rates does not survive close-to-close. Here the same rule is priced on UUP (Alpaca SIP 30-minute bars, 2016-2026)
 *  at different times of day: entry on session L-4, exit on the last session, signal = month-to-date at the entry time.
 *  node backend/uup-noon-check.js */
const path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); }, tOf = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
const et = (iso) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso)).map((x) => [x.type, x.value])); return { d: `${p.year}-${p.month}-${p.day}`, hm: `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}` }; };
(async () => {
  const { bars } = await fetchBars(["UUP"], { start: "2015-12-01", end: "2026-08-31T23:59:00Z", timeframe: "30Min", feed: "sip", adjustment: "all", quiet: true, minBars: 1 });
  const day = new Map();   // date -> { "HH:MM": open, close: last RTH close }
  for (const b of bars.UUP) { const { d, hm } = et(b.t); if (hm < "09:30" || hm >= "16:00") continue; const o = day.get(d) || day.set(d, {}).get(d); o[hm] = b.o; o.close = b.c; }
  const dates = [...day.keys()].sort(), M = {}; dates.forEach((d) => (M[d.slice(0, 7)] = M[d.slice(0, 7)] || []).push(d)); const ms = Object.keys(M).sort();
  const px = (d, at) => (at === "close" ? day.get(d).close : day.get(d)[at]);
  function rule(entryAt, exitAt, cost = 0.0004) { const out = [];
    for (let k = 1; k < ms.length; k++) { const m = ms[k]; if (m < "2016-01") continue; const s = M[m], prev = M[ms[k - 1]]; if (s.length < 15) continue;
      const e = s[s.length - 4], x = s[s.length - 1], p0 = px(prev[prev.length - 1], entryAt), pe = px(e, entryAt), px1 = px(x, exitAt); if (!(p0 > 0 && pe > 0 && px1 > 0)) continue;
      const mtd = pe / p0 - 1; if (mtd === 0) continue; out.push({ m, v: (mtd > 0 ? -1 : 1) * (px1 / pe - 1) - cost }); }
    return out; }
  const res = {};
  for (const [name, a, b] of [["close -> close (R218 as wired)", "close", "close"], ["12:00 -> 12:00", "12:00", "12:00"], ["12:00 -> 11:00 (before the fix)", "12:00", "11:00"], ["10:00 -> 12:00", "10:00", "12:00"], ["12:00 -> close", "12:00", "close"], ["close -> 12:00", "close", "12:00"]]) {
    const r = rule(a, b); if (r.length < 60) { res[name] = { months: r.length }; continue; }
    res[name] = { months: r.length, meanBps: +(1e4 * mean(r.map((x) => x.v))).toFixed(1), t: +tOf(r.map((x) => x.v)).toFixed(2), t2016_20: +tOf(r.filter((x) => x.m < "2021").map((x) => x.v)).toFixed(2), t2021_26: +tOf(r.filter((x) => x.m >= "2021").map((x) => x.v)).toFixed(2), per50kYear: Math.round(50000 * 12 * mean(r.map((x) => x.v))) };
  }
  writeJsonAtomic(path.join(__dirname, "data", "uup-noon-check.json"), { ranAt: new Date().toISOString(), exploratory: true, res });
  console.log(JSON.stringify(res, null, 1));
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
