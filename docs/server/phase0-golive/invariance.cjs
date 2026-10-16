#!/usr/bin/env node
/**
 * R309 INVARIANCE — old (backend/r309-surge-hold48.js, r309-v1, deployed today in DRY) vs new (staged
 * docs/server/phase0-golive/backend/r309-surge-hold48.js, r309-v2). 2026-10-06. Proves the 2026-10-06 implementation
 * fixes (N12-N19) leave the registered rule, statistic, twin, signal and bar untouched.
 *
 *   1. SELFTEST KNOWN ANSWERS — runs both --selftest; every case of the old one must pass in the new one under the same
 *      name (one rename, listed in RENAMED, because the case's own words named the main account).
 *   2. REAL HOURS — Coinbase public hourly candles (no key, GET only), BTC-USD and ETH-USD, the last --hours closed hours
 *      (default 1200, ~50 days). For EVERY hour L: old and new seriesFromCandles + evaluateLast are deep-equal, and drawTwin
 *      forced at that hour (key r309-<COIN>-<YYYYMMDDHH>) is deep-equal. Hours that are real surges (state 2) are counted.
 *   3. PURE FUNCTIONS — decideEntry, exitPlan, matchFees, netOf, decide, cidOf/lotId on a grid of inputs; summarize on a
 *      ledger with no 'missed'-status lot is deep-equal (asOf-free fields).
 *   4. DRY CYCLE (--cycle-too) — both runners `--cycle --dry` in the same hour; the BTC: / ETH: evaluation lines must be
 *      byte-identical after the timestamp prefix. The old runner reads backend/.env (main keys: GET /v2/account only); the new
 *      one is given ONLY ALPACA_TV_KEY_ID / ALPACA_TV_SECRET_KEY from backend/.env through its environment (values never
 *      printed) so its TV account check runs too. Both send nothing and write nothing (N11).
 *
 *   node docs/server/phase0-golive/invariance.cjs [--hours 1200] [--cycle-too]
 * Exit 0 = invariant, 1 = a difference (printed). Never places an order; never writes a file.
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), assert = require("assert");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", ".."), OLD = path.join(REPO, "backend", "r309-surge-hold48.js"), NEW = path.join(HERE, "backend", "r309-surge-hold48.js");
const ARGV = process.argv.slice(2), opt = (k, d) => { const i = ARGV.indexOf("--" + k); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };
const HOURS = Math.max(24, Math.min(5000, Number(opt("hours", "1200")) || 1200)), HOUR = 3600000, GRID_H = 300;
const RENAMED = { "broker refuses a non-paper endpoint and missing main-account keys": "broker refuses a non-paper endpoint and missing TV-account keys" };
let bad = 0; const say = (ok, msg) => { console.log(`  ${ok ? "ok  " : "DIFF"} ${msg}`); if (!ok) bad++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/ALPACA|TELEGRAM|SMTP|SCHWAB|TASTY|ANTHROPIC|NTFY|TOKEN|SECRET|PASS|_KEY/i.test(k)));   // before any .env is loaded

function selftestCases(file) {
  const r = cp.spawnSync(process.execPath, [file, "--selftest"], { cwd: path.dirname(file), encoding: "utf8", timeout: 300000, windowsHide: true, env: { ...process.env, ALPACA_KEY_ID: "", ALPACA_SECRET_KEY: "", ALPACA_TV_KEY_ID: "", ALPACA_TV_SECRET_KEY: "" } });
  const cases = new Map();
  for (const ln of String(r.stdout || "").split(/\r?\n/)) { const m = /^\s+(ok  |FAIL) (.+?)(?: \(.*\)| \{.*\})?$/.exec(ln); if (m) cases.set(m[2].trim(), m[1].trim() === "ok"); }
  return { status: r.status, passed: /SELFTEST PASSED/.test(r.stdout || ""), cases };
}

async function candles(coin, startMs, endMs) {   // Coinbase public, <= 300 per request
  const out = new Map();
  for (let s = startMs; s <= endMs; s += 300 * HOUR) {
    const e = Math.min(endMs, s + 299 * HOUR), url = `https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=3600&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`;
    let j = null;
    for (let a = 0; a < 5 && !Array.isArray(j); a++) { try { const r = await fetch(url, { headers: { "User-Agent": "traids-r309-invariance", Accept: "application/json" }, signal: AbortSignal.timeout(20000) }); j = r.ok ? await r.json() : null; } catch { j = null; } if (!Array.isArray(j)) await sleep(1500 * (a + 1)); }
    if (!Array.isArray(j)) throw new Error(`coinbase ${coin} ${new Date(s).toISOString()}: no data`);
    for (const row of j) out.set(Number(row[0]) * 1000, row);
    await sleep(350);
  }
  return [...out.values()].sort((a, b) => b[0] - a[0]);   // newest first, as Coinbase returns
}

(async () => {
  console.log(`R309 invariance — old ${path.relative(REPO, OLD)} vs new ${path.relative(REPO, NEW)}`);
  // 1. selftest known answers
  const o = selftestCases(OLD), n = selftestCases(NEW);
  say(o.passed && o.status === 0, `old --selftest: ${[...o.cases.values()].filter(Boolean).length}/${o.cases.size} ok, exit ${o.status}`);
  say(n.passed && n.status === 0, `new --selftest: ${[...n.cases.values()].filter(Boolean).length}/${n.cases.size} ok, exit ${n.status}`);
  const missing = [...o.cases.keys()].filter((k) => n.cases.get(RENAMED[k] || k) !== true);
  say(missing.length === 0, `every old case passes in the new selftest under the same name (${o.cases.size} cases; renamed ${Object.keys(RENAMED).length})${missing.length ? ": MISSING " + missing.join(" | ") : ""}`);
  console.log(`       new cases added: ${n.cases.size - o.cases.size}`);

  // 2. real hours
  const A = require(OLD), Bn = require(NEW);
  const nowMs = Date.now(), Llast = Math.floor(nowMs / HOUR) * HOUR - HOUR, L0 = Llast - (HOURS - 1) * HOUR, from = L0 - (GRID_H - 1) * HOUR;
  for (const coin of ["BTC", "ETH"]) {
    const rows = await candles(coin, from, Llast);
    let n2 = 0, surges = 0, signals = 0, twins = 0, diff = null;
    for (let L = L0; L <= Llast; L += HOUR) {
      const sub = rows.filter((r) => Number(r[0]) * 1000 <= L + HOUR);   // include the "forming" hour after L, as a live fetch would
      const Go = A.seriesFromCandles(sub, L, coin), Gn = Bn.seriesFromCandles(sub, L, coin);
      const eo = A.evaluateLast(Go.S), en = Bn.evaluateLast(Gn.S);
      try { assert.deepStrictEqual(Gn, Go); assert.deepStrictEqual(en, eo); } catch (e) { diff = diff || `${coin} ${new Date(L).toISOString()}: evaluateLast differs — ${e.message.slice(0, 200)}`; }
      const key = `r309-${coin}-${new Date(L).toISOString().slice(0, 13).replace(/[-T]/g, "")}`, to = A.drawTwin(Go.S, eo.t, key), tn = Bn.drawTwin(Gn.S, en.t, key);
      try { assert.deepStrictEqual(tn, to); } catch (e) { diff = diff || `${coin} ${new Date(L).toISOString()}: drawTwin differs — ${e.message.slice(0, 200)}`; }
      n2++; if (eo.state === 2) surges++; if (eo.signal) signals++; if (to.hour) twins++;
    }
    say(!diff, `${coin}: ${n2} real closed hours ${new Date(L0).toISOString().slice(0, 13)}Z..${new Date(Llast).toISOString().slice(0, 13)}Z — evaluateLast + forced drawTwin identical (${surges} surge hours, ${signals} signals, ${twins} twins drawn)${diff ? " — " + diff : ""}`);
  }

  // 3. pure functions on a grid
  {
    let k = 0, d3 = null; const closeAt = Date.UTC(2026, 9, 3, 14);
    const tryEq = (name, f) => { k++; try { assert.deepStrictEqual(f(Bn), f(A)); } catch (e) { d3 = d3 || `${name}: ${e.message.slice(0, 160)}`; } };
    for (const dt of [-60000, 0, 599000, 600000, 601000, 3600000]) for (const live of [true, false]) for (const off of [true, false]) for (const halt of [true, false]) for (const bp of [null, 1999, 2000, 50000]) for (const brokerOk of [true, false]) for (const accountOk of [true, false])
      tryEq("decideEntry", (M) => M.decideEntry({ nowMs: closeAt + dt, closeAt, live, off, halt, brokerOk, accountOk, buyingPower: bp }));
    const f = Date.UTC(2026, 9, 1, 14, 2, 7);
    for (const dt of [0, 47 * HOUR, 47.75 * HOUR, 47.9 * HOUR, 48 * HOUR - 1, 48 * HOUR, 49 * HOUR]) tryEq("exitPlan", (M) => M.exitPlan({ entry: { filledAt: new Date(f).toISOString() } }, f + dt));
    tryEq("exitPlan unknown", (M) => M.exitPlan({ entry: {} }, f));
    const fees = [{ created_at: "2026-10-01T14:02:09.5Z", symbol: "BTCUSD", qty: "-0.000049875", price: "100250", net_amount: "0" }, { created_at: "2026-10-01T14:02:09.5Z", symbol: "ETHUSD", qty: "-0.001", price: "2600", net_amount: "0" }];
    for (const rows of [[], fees, [{ ...fees[0], qty: "-0.0003" }]]) tryEq("matchFees", (M) => M.matchFees(rows, "BTC", f, 19950000));
    for (const [e, x] of [[100, 103], [100, 98], [85000, 86000.5]]) tryEq("netOf", (M) => M.netOf(e, x));
    for (const t of [null, 1.686, 1.687, 3]) for (const pm of [null, 0, 0.001]) tryEq("decide", (M) => M.decide({ tNet: t, bar: 1.687, pairedMean: pm }));
    tryEq("cidOf/lotId", (M) => [M.cidOf("BTC", Date.UTC(2026, 9, 1, 13), "B"), M.lotId("ETH", Date.UTC(2026, 9, 1, 13))]);
    const mk = (coin, day, e, x, tw, status = "closed") => ({ kind: "lot", id: `r309-${coin}-${day.replace(/-/g, "")}12`, coin, day, signalHour: `${day}T12:00:00Z`, status, entry: { avgPx: e, filledAt: `${day}T13:02:07Z`, filledQty: "0.02", slipBps: 2 }, exit: { legs: [] }, gross: x / e - 1, net: (x / e - 1) - 0.005, holdHours: 48, twin: { hour: `${day}T00:00:00Z`, net: tw }, shadow: { net: null }, fees: {}, notes: [] });
    const led = [mk("BTC", "2026-10-05", 100, 103, 0.001), mk("ETH", "2026-10-05", 100, 98, -0.004), mk("BTC", "2026-10-08", 100, 101.5, 0), mk("ETH", "2026-10-09", 100, 104, null, "open"), mk("BTC", "2026-10-03", 100, 90, -0.01), { kind: "missed", id: "r309-ETH-2026100700", coin: "ETH", day: "2026-10-07", signalHour: "2026-10-07T00:00:00Z", reason: "late" }];
    const strip = (s) => { const { resolutions, ...rest } = s; return { ...rest, gaps: { ...s.gaps, accountFailedCycles: undefined } }; };   // v2 reports two counters v1 has not: gaps.accountFailedCycles (N18), resolutions (N19)
    for (const ev of [null, "2026-10-04", "2026-10-06"]) tryEq("summarize (evidence, shakeout, twin, dailyClock)", (M) => strip(M.summarize(led, [], { evidenceStart: ev }, Date.UTC(2026, 9, 10))));
    say(!d3, `pure functions: ${k} input cases identical (decideEntry, exitPlan, matchFees, netOf, decide, client ids, summarize)${d3 ? " — " + d3 : ""}`);
  }

  // 4. dry cycles, same hour
  if (ARGV.includes("--cycle-too")) {
    const env = { ...BASE_ENV, ALPACA_TV_KEY_ID: "", ALPACA_TV_SECRET_KEY: "" };   // the new runner gets the TV pair and no other secret
    try { for (const ln of fs.readFileSync(path.join(REPO, "backend", ".env"), "utf8").split(/\r?\n/)) { const m = /^\s*(ALPACA_TV_KEY_ID|ALPACA_TV_SECRET_KEY)\s*=\s*(.*)$/.exec(ln); if (m) env[m[1]] = m[2].trim(); } } catch {}
    const run = (file, e) => new Promise((res) => { const p = cp.spawn(process.execPath, [file, "--cycle", "--dry"], { cwd: path.dirname(file), env: e, windowsHide: true }); let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.on("close", (code) => res({ code, out })); });
    const [ro, rn] = await Promise.all([run(OLD, { ...BASE_ENV }), run(NEW, env)]);
    const body = (s) => s.split(/\r?\n/).map((l) => l.replace(/^\S+Z \[r309\] /, ""));
    const hourOf = (s) => (/evaluated hour (\S+)/.exec(s) || [])[1];
    const lines = (s, re) => body(s).filter((l) => re.test(l));
    const coinsO = lines(ro.out, /^(BTC|ETH): /), coinsN = lines(rn.out, /^(BTC|ETH): /);
    const dryO = lines(ro.out, /DRY — would MARKET BUY/), dryN = lines(rn.out, /DRY — would MARKET BUY/);
    say(hourOf(ro.out) && hourOf(ro.out) === hourOf(rn.out), `dry cycles evaluated the same hour: ${hourOf(ro.out)} / ${hourOf(rn.out)}`);
    say(coinsO.length === 2 && JSON.stringify(coinsO) === JSON.stringify(coinsN), `dry cycle BTC/ETH signal lines byte-identical (old exit ${ro.code}, new exit ${rn.code})`);
    for (const l of coinsN) console.log("       " + l.slice(0, 200));
    say(JSON.stringify(dryO.map((l) => l.replace(/HALT.*$/, ""))) === JSON.stringify(dryN.map((l) => l.replace(/HALT.*$/, ""))) || dryO.length === 0, `dry-cycle twin lines: old ${dryO.length}, new ${dryN.length} (a signal hour prints the twin; home's r309-HALT makes the old one print MISSED instead)`);
    const acctN = lines(rn.out, /^account: /), noteN = lines(rn.out, /^note: |^error: /);
    console.log(`       new runner on the TV keys: ${acctN[0] || "(no account line)"}${noteN.length ? " · " + noteN.join(" · ").slice(0, 200) : ""}`);
    console.log(`       new runner verdict line: ${lines(rn.out, /^(clean|NOT CLEAN)/)[0] || "-"}`);
  }
  console.log(bad ? `INVARIANCE: ${bad} difference(s)` : "INVARIANCE: identical");
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.error("invariance crashed:", e && e.stack || e); process.exitCode = 1; });
