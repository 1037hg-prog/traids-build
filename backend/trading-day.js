#!/usr/bin/env node
/**
 * trading-day.js — is today (ET) a US equity trading day? exit 0 = yes, exit 2 = no (weekend or market holiday).
 * Used as the first line of the trading-day batch wrappers so a holiday fire does nothing instead of producing empty runs.
 *   node backend/trading-day.js            → prints {"tradingDay":true|false,"etDate":..,"why":..}
 *   node backend/trading-day.js 2026-09-07 → check a specific ET date (for tests)
 * Holidays come from lib/run-window.js MARKET_HOLIDAYS (through 2027). Preflight and Servers do NOT use this — they run every day.
 */
const { marketHoliday } = require("./lib/run-window.js");
const arg = process.argv[2];
const et = arg || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const dow = new Date(et + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" });
const hol = marketHoliday(et);
const out = { tradingDay: !["Sat", "Sun"].includes(dow) && !hol, etDate: et, dow, why: hol ? `market holiday (${hol})` : ["Sat", "Sun"].includes(dow) ? "weekend" : "trading day" };
console.log(JSON.stringify(out));
process.exit(out.tradingDay ? 0 : 2);
