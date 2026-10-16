#!/usr/bin/env node
/**
 * W5 PROBE — the VPS-side prerequisites of the board cell, measured ON the VPS. 2026-10-09 (server migration W5,
 * docs/server/wave5-board). Copied to /home/traids/traids/backend/w5-probe.cjs by deploy.cjs (step copy) and run there by
 * deploy.cjs --step probes over ssh. Read-only: GETs to public pages, a stat of a few files, /proc/meminfo; no key is read or sent.
 *
 *   node w5-probe.cjs --json      one line "W5PROBE {...}": the five node-fetch probes the plan names (FRED, ALFRED, CNN, ir.nasdaq,
 *                                 globenewswire: curl failed on them from both hosts on 10-06 while node fetch worked at home — plan v2
 *                                 §1 "Inconclusive"), the Linux Chromium Playwright will launch, /usr/bin/time (the memory peaks),
 *                                 MemTotal / SwapTotal
 *   node w5-probe.cjs --selftest  the judge on fixed answers (no network)
 * Each probe uses the request the scripts themselves make (the same URL shape and User-Agent) so a pass means those scripts can reach it.
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process");
const UA_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const PROBES = [
  { name: "FRED", url: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3", headers: { "User-Agent": "Mozilla/5.0" }, users: "bust-ladder, r217, r235, r291, r312, r330, r343" },
  { name: "ALFRED", url: "https://alfred.stlouisfed.org/graph/alfredgraph.csv?id=WALCL&vintage_date=2026-10-01&cosd=2026-08-01", headers: { "User-Agent": "Mozilla/5.0" }, users: "r330 (as-of vintages)" },
  { name: "CNN", url: "https://production.dataviz.cnn.io/index/fearandgreed/graphdata", headers: { "User-Agent": UA_BROWSER, Accept: "application/json" }, users: "sentiment-gauge (the Fear & Greed components)" },
  { name: "ir.nasdaq", url: "https://ir.nasdaq.com/news-releases", headers: { "User-Agent": "TRAIDS research script (R317 builder; public index announcements)", Accept: "text/html,application/xhtml+xml,application/xml,*/*" }, users: "r317-ndx-recon" },
  { name: "globenewswire", url: "https://www.globenewswire.com/", headers: { "User-Agent": "TRAIDS research script (R317 builder; public index announcements)", Accept: "text/html,application/xhtml+xml,application/xml,*/*" }, users: "r317-ndx-recon" },
];
const ROOT = path.resolve(__dirname, "..");

async function probe(p, timeoutMs = 20000) {
  const t0 = Date.now();
  try {
    const r = await fetch(p.url, { headers: p.headers, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    const buf = Buffer.from(await r.arrayBuffer());
    return { name: p.name, status: r.status, bytes: buf.length, ms: Date.now() - t0, why: null };
  } catch (e) { return { name: p.name, status: null, bytes: 0, ms: Date.now() - t0, why: String(e && (e.cause && e.cause.code || e.message)).slice(0, 120) }; }
}
/** pure: one probe result -> ok? (a 2xx/3xx with a body) */
const probeOk = (r) => !!r && Number.isInteger(r.status) && r.status >= 200 && r.status < 400 && r.bytes > 0;
// the Chromium Playwright launches: PLAYWRIGHT_BROWSERS_PATH / chromium-<rev> / chrome-linux / chrome (or the headless shell)
function findChromium(base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(ROOT, ".playwright")) {
  let dirs = []; try { dirs = fs.readdirSync(base).filter((d) => /^chromium/.test(d)).sort(); } catch { return null; }
  for (const d of dirs.reverse()) for (const sub of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-linux/headless_shell", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
    const f = path.join(base, d, ...sub.split("/")); if (fs.existsSync(f)) return f;
  }
  return null;
}
/** pure: /proc/meminfo text -> { memTotalKiB, swapTotalKiB } (null when absent) */
function meminfo(text) {
  const g = (k) => { const m = new RegExp(`^${k}:\\s+(\\d+)\\s+kB$`, "m").exec(String(text || "")); return m ? Number(m[1]) : null; };
  return { memTotalKiB: g("MemTotal"), swapTotalKiB: g("SwapTotal") };
}
async function collect() {
  const probes = []; for (const p of PROBES) { const r = await probe(p); probes.push({ ...r, ok: probeOk(r), users: p.users }); }
  const chrome = findChromium(); let chromeVersion = null;
  if (chrome) { const r = cp.spawnSync(chrome, ["--version"], { encoding: "utf8", timeout: 30000 }); chromeVersion = r.status === 0 ? String(r.stdout).trim().slice(0, 80) : null; }
  let mi = { memTotalKiB: null, swapTotalKiB: null }; try { mi = meminfo(fs.readFileSync("/proc/meminfo", "utf8")); } catch {}
  return { schema: "w5-probe-v1", at: new Date().toISOString(), node: process.version, probes, chromium: { path: chrome, version: chromeVersion, ok: !!chromeVersion }, timeBin: fs.existsSync("/usr/bin/time"), ...mi };
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };
  ok("probeOk: 200 with a body ok; 301 ok; 200 empty, 403, 418, 451, a network error -> not ok", probeOk({ status: 200, bytes: 10 }) && probeOk({ status: 301, bytes: 1 }) && !probeOk({ status: 200, bytes: 0 }) && ![403, 418, 451].some((s) => probeOk({ status: s, bytes: 5 })) && !probeOk({ status: null, bytes: 0, why: "ENOTFOUND" }));
  ok("the five probes the plan names, each with the scripts' own URL shape", PROBES.map((p) => p.name).join() === "FRED,ALFRED,CNN,ir.nasdaq,globenewswire" && /fredgraph\.csv/.test(PROBES[0].url) && /alfredgraph\.csv/.test(PROBES[1].url) && /dataviz\.cnn\.io\/index\/fearandgreed\/graphdata$/.test(PROBES[2].url));
  const M = "MemTotal:       11982660 kB\nMemFree:          912345 kB\nSwapTotal:       2097148 kB\n";
  ok("meminfo: MemTotal / SwapTotal in KiB; a missing line -> null", JSON.stringify(meminfo(M)) === '{"memTotalKiB":11982660,"swapTotalKiB":2097148}' && meminfo("MemTotal: 5 kB").swapTotalKiB === null && meminfo(null).memTotalKiB === null);
  const os = require("os"), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w5-probe-"));
  try { fs.mkdirSync(path.join(tmp, "chromium-1200", "chrome-linux"), { recursive: true }); fs.writeFileSync(path.join(tmp, "chromium-1200", "chrome-linux", "chrome"), "");
    ok("findChromium: <base>/chromium-<rev>/chrome-linux/chrome; none -> null", findChromium(tmp) === path.join(tmp, "chromium-1200", "chrome-linux", "chrome") && findChromium(path.join(tmp, "nope")) === null);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`w5-probe selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.length === 1 && a[0] === "--selftest") process.exitCode = selftest() ? 0 : 1;
  else if (a.length === 1 && a[0] === "--json") collect().then((r) => { console.log("W5PROBE " + JSON.stringify(r)); process.exitCode = 0; }).catch((e) => { console.error("w5-probe: " + e.message); process.exitCode = 1; });
  else { console.log("usage: node w5-probe.cjs --json | --selftest"); process.exitCode = 2; }
}
module.exports = { PROBES, probeOk, meminfo, findChromium };
