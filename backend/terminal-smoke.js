#!/usr/bin/env node
/**
 * terminal-smoke.js — does every Terminal endpoint on :3001 answer with the shape the screen expects?
 * Read-only: GETs plus ONE dry run of the board POST (fenced server-side: no row, no counter, no audit line).
 * Prints OK / WARN / FAIL per endpoint, writes data/terminal-smoke.json, exits 1 on any FAIL.
 * Run by hand (node backend/terminal-smoke.js) or read by daily-health.js. Not an accruing runner: nothing here is a test.
 */
const path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const BASE = process.env.TERMINAL_BASE || "http://localhost:3001";
const rows = [];
const say = (level, name, detail) => { rows.push({ level, name, detail }); console.log(`  ${level.padEnd(4)} ${name.padEnd(28)} ${detail || ""}`); };
async function get(p, ms = 20000) { const r = await fetch(BASE + p, { signal: AbortSignal.timeout(ms) }); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { status: r.status, j, text }; }
async function check(name, p, test) {
  try { const r = await get(p); const v = test(r); if (v === true) say("OK", name, `${r.status}`); else if (typeof v === "string" && v.startsWith("WARN")) say("WARN", name, v.slice(5).trim()); else say("FAIL", name, `${r.status} ${v || (r.j && r.j.error) || r.text.slice(0, 80)}`); }
  catch (e) { say("FAIL", name, e.message); }
}
(async () => {
  console.log(`terminal smoke — ${BASE} — ${new Date().toISOString()}`);
  const bars = (r) => r.status === 200 && r.j && Array.isArray(r.j.bars) && r.j.bars.length > 50 && Number.isFinite(r.j.bars[r.j.bars.length - 1].c) ? true : "no bars";
  await check("bars SPY 5m", "/api/chart/bars?symbol=SPY&cls=Equity&tf=5m&limit=600", bars);
  await check("bars /NQ 1m", "/api/chart/bars?symbol=%2FNQ&cls=Futures&tf=1m&limit=600", bars);
  await check("bars BTC-USD 5m", "/api/chart/bars?symbol=BTC-USD&cls=Crypto&tf=5m&limit=600", bars);
  await check("quote SPY", "/api/chart/quote?symbol=SPY&cls=Equity", (r) => r.status === 200 && Number.isFinite(r.j && r.j.last) ? true : "no last");
  await check("quotes batch", "/api/chart/quotes?symbols=SPY,QQQ,%2FNQ,BTC-USD", (r) => { if (r.status !== 200 || !r.j || !r.j.quotes) return "no quotes"; const bad = Object.entries(r.j.quotes).filter(([, q]) => !Number.isFinite(q.last)); return bad.length ? `WARN ${bad.map(([k, q]) => k + ": " + (q.error || "no last")).join("; ")}` : true; });
  await check("analysis SPY", "/api/chart/analysis?symbol=SPY&cls=Equity", (r) => r.status === 200 && r.j && r.j.technicals && r.j.gates ? true : "no technicals/gates");
  await check("history SPY", "/api/chart/history?symbol=SPY", (r) => r.status === 200 && r.j && Array.isArray(r.j.rows || r.j.history || r.j.items || []) ? true : "bad shape");
  await check("marks /NQ", "/api/chart/marks?symbol=%2FNQ&tf=1m", (r) => r.status === 200 && r.j && Array.isArray(r.j.patterns) && Array.isArray(r.j.trades) ? true : "no patterns/trades");
  await check("rvol SPY", "/api/chart/rvol?symbol=SPY&cls=Equity", (r) => r.status === 200 && r.j && ("rvol" in r.j) ? (r.j.rvol == null ? `WARN ${r.j.why || "null"}` : true) : "bad shape");
  await check("events NVDA", "/api/chart/events?symbol=NVDA&cls=Equity", (r) => r.status === 200 && r.j && Array.isArray(r.j.events) && r.j.events.length ? true : "no events");
  await check("costpreview NVDA", "/api/chart/costpreview?symbol=NVDA&cls=Equity&entry=170&stop=168&spreadBps=3", (r) => r.status === 200 && r.j && r.j.sizing && r.j.r53 ? true : "bad shape");
  await check("chain SPY", "/api/chart/chain?symbol=SPY", (r) => r.status === 200 && r.j ? true : r.status === 503 ? "WARN chain unavailable (outside RTH this is expected)" : "bad");
  await check("trades relay status", "/api/chart/trades/status", (r) => r.status === 200 && r.j && "feed" in r.j ? (r.j.keys ? true : "WARN no Alpaca keys") : "bad shape");
  await check("schwab stream status", "/api/chart/stream/status", (r) => r.status === 200 && r.j ? (r.j.lastErr && /401/.test(r.j.lastErr) ? "WARN streamer refused: the Schwab app lacks the Accounts & Trading product (operator: developer portal, then schwab-auth.bat)" : true) : "bad shape");
  // the gate light's dry run — fenced on the server; assert the fence by reading the breaker counter before and after
  try {
    const fs = require("fs"); const BP = path.join(__dirname, "data", "circuit-breaker.json");
    const before = JSON.parse(fs.readFileSync(BP, "utf8"));
    const body = { positions: [{ id: "smoke-" + Date.now(), cls: "Equity", sym: "SPY", name: "SPY", dir: 1, addedAt: Date.now(), strategy: "Terminal", manual: true, entry: 500, signalEntry: 500, stop: 495, target: 510, stopDist: 5, units: 50, dollarPerPoint: 1, riskDollars: 250, riskDollarsApplied: 250, riskPctApplied: 0.25, obs: { terminal: true, gateProbe: true, spreadBps: 2 }, ctrl: false, vetoShadow: false }] };
    const r = await fetch(BASE + "/api/board-positions?dryRun=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const j = await r.json(); const after = JSON.parse(fs.readFileSync(BP, "utf8"));
    if (r.status !== 200 || !j.dryRun || !Array.isArray(j.gateVetoes)) say("FAIL", "board dry run", `${r.status} ${JSON.stringify(j).slice(0, 100)}`);
    else if ((after.refusedToday || 0) !== (before.refusedToday || 0) || (after.wouldRefuseToday || 0) !== (before.wouldRefuseToday || 0)) say("FAIL", "board dry run", "the dry run moved a breaker counter — the fence is broken");
    else say("OK", "board dry run", `fenced · ${j.refused.length} refused · ${j.gateVetoes.length} vetoes · breaker ${j.breaker && j.breaker.halted ? "halted" : "clear"} (${j.breaker && j.breaker.mode})`);
  } catch (e) { say("FAIL", "board dry run", e.message); }
  const fails = rows.filter((x) => x.level === "FAIL").length, warns = rows.filter((x) => x.level === "WARN").length;
  writeJsonAtomic(path.join(__dirname, "data", "terminal-smoke.json"), { ranAt: new Date().toISOString(), base: BASE, fails, warns, rows });
  console.log(`\n${fails ? "FAIL" : "OK"} — ${rows.length} checks, ${fails} fail, ${warns} warn`);
  process.exit(fails ? 1 : 0);
})();
