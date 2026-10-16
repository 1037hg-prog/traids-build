#!/usr/bin/env node
"use strict";
/**
 * FUTURES DAILY CACHE WRITER (2026-10-02, the daily half of the Massive exit) — Schwab continuous /ROOT daily bars for the board's
 * futures roots (+ the daily research roots) into data/futures-daily/<ROOT>.json, read by lib/futures-daily.js.
 *
 *   node backend/futures-daily-cache.js                 all roots (lib/futures-daily.js BOARD_ROOTS)
 *   node backend/futures-daily-cache.js --roots ES,NQ   some roots
 *   --dry-run   fetch and report, write nothing        --force   allow a run inside 08:30-16:05 ET (paced at one request / 6 s)
 *
 * SESSION GUARD: the live watcher(s) use most of Schwab's ~120 req/min during the session; 46 back-to-back requests would push them
 * into 429s and, after 60 s, into FEED FALLBACK on the wire. So this refuses to run 08:30-16:05 ET on a weekday unless --force, and
 * even then paces at one request every 6 s.
 *
 * A root Schwab does not serve is written to the manifest as absent (the board falls back to Yahoo for it, exactly as it did for
 * the ICE roots under Massive). A root that WAS cached and now fails keeps its old file and is reported FAIL; a dead token = UNKNOWN.
 * Exit 0 PASS / 1 FAIL / 3 UNKNOWN. Writes via writeJsonAtomic only.
 */
const fs = require("fs"), path = require("path");
const FD = require("./lib/futures-daily.js");
const { writeJsonAtomic } = require("./lib/atomic-write.js");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run"), FORCE = argv.includes("--force");
const ri = argv.indexOf("--roots");
const ROOTS = ri >= 0 ? argv[ri + 1].split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : FD.BOARD_ROOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const hm = `${p.hour === "24" ? "00" : p.hour}:${p.minute}`, inSession = !["Sat", "Sun"].includes(p.weekday) && hm >= "08:30" && hm < "16:05";
  if (inSession && !FORCE) { console.log(`futures-daily-cache: ${hm} ET is inside 08:30-16:05 — refusing (the live watcher shares Schwab's request budget). Use --force to run paced.`); process.exit(2); }
  const pace = inSession ? 6000 : 700;
  const manifestF = path.join(FD.DIR, "manifest.json");
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(manifestF, "utf8")).roots || {}; } catch {}
  const rows = {};
  let unknown = null;
  for (const [i, root] of ROOTS.entries()) {
    if (i) await sleep(pace);
    try {
      const { symbol, bars } = await FD.fetchDaily(root);
      if (bars.length < 20) {
        rows[root] = { status: prev[root] && prev[root].bars ? "FAIL" : "ABSENT", why: `Schwab returned ${bars.length} daily bars`, symbol };
      } else {
        rows[root] = { status: "PASS", symbol, bars: bars.length, first: bars[0].d, last: bars[bars.length - 1].d };
        if (!DRY) { fs.mkdirSync(FD.DIR, { recursive: true }); writeJsonAtomic(path.join(FD.DIR, `${root}.json`), { spec: "futures-daily-v1", root, symbol, source: "Schwab marketdata/v1/pricehistory daily, continuous /ROOT, needExtendedHoursData=false", fetchedAt: new Date().toISOString(), bars }, { pretty: 0 }); }
      }
    } catch (e) {
      const msg = String(e.message || e);
      if (/token|not configured|401/i.test(msg)) { unknown = msg; rows[root] = { status: "UNKNOWN", why: msg.slice(0, 160) }; break; }
      rows[root] = { status: prev[root] && prev[root].bars ? "FAIL" : "ABSENT", why: msg.slice(0, 160) };
    }
    const r = rows[root]; console.log(`  ${root.padEnd(4)} ${r.status}${r.bars ? ` ${r.bars} bars ${r.first}..${r.last} (${r.symbol})` : ` — ${r.why}`}`);
  }
  const vals = Object.values(rows);
  const status = unknown ? "UNKNOWN" : vals.some((r) => r.status === "FAIL") ? "FAIL" : "PASS";
  const doc = { spec: "futures-daily-manifest-v1", asOf: new Date().toISOString(), status, roots: { ...prev, ...rows }, absent: Object.entries({ ...prev, ...rows }).filter(([, r]) => r.status === "ABSENT").map(([k]) => k) };
  if (!DRY) writeJsonAtomic(manifestF, doc);
  console.log(`\n  FUTURES DAILY ${status} · ${vals.filter((r) => r.status === "PASS").length}/${vals.length} cached · absent: ${doc.absent.join(" ") || "none"}${DRY ? " (dry run)" : ""}`);
  if (status !== "PASS" && !DRY) { try { await require("./notify.js").notify(`TRAIDS — futures daily cache ${status}`, Object.entries(rows).filter(([, r]) => r.status === "FAIL" || r.status === "UNKNOWN").map(([k, r]) => `${k} ${r.status}: ${r.why}`).join("\n"), { priority: "high", tags: "warning", email: false }); } catch {} }
  process.exit(status === "PASS" ? 0 : status === "UNKNOWN" ? 3 : 1);
})().catch((e) => { console.error("futures-daily-cache:", e && e.stack || e); process.exit(3); });
