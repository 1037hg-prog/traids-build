#!/usr/bin/env node
/**
 * HYPERLIQUID WHALES RECORDER — daily snapshot of the biggest on-chain perp traders, so "follow / fade the top crypto traders" can be tested
 * FORWARD without the leaderboard's survivorship (today's leaderboard is chosen by past winners; only a dated daily record lets us rank
 * traders on what was knowable THEN and grade what they did AFTER). 2026-09-24, operator: "what about the biggest crypto traders".
 *
 * Public, keyless, read-only:
 *   stats-data.hyperliquid.xyz/Mainnet/leaderboard   every account's value and pnl/roi/volume by day/week/month/allTime (~40 MB)
 *   api.hyperliquid.xyz/info {type:"clearinghouseState"}  open positions of one address
 * Keeps: the top TOP_N accounts by each of allTime pnl, month pnl and account value (union), and the open positions of the top POS_N of
 * those by account value. Output: data/hyperliquid-whales/<YYYY-MM-DD>.json (UTC date), never rewritten once complete.
 *   node backend/hyperliquid-whales-record.js
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const DIR = path.join(__dirname, "data", "hyperliquid-whales"); if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
const TOP_N = 300, POS_N = 100, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => (x == null ? null : +x);

(async () => {
  const day = new Date().toISOString().slice(0, 10), f = path.join(DIR, `${day}.json`);
  if (fs.existsSync(f) && JSON.parse(fs.readFileSync(f, "utf8")).complete) { console.log(`hyperliquid whales ${day} already recorded`); return; }
  const r = await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard", { signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(`leaderboard ${r.status}`);
  const rows = (await r.json()).leaderboardRows || [];
  const flat = rows.map((x) => { const w = Object.fromEntries((x.windowPerformances || []).map(([k, v]) => [k, v])); return { a: x.ethAddress, name: x.displayName || null, av: num(x.accountValue),
    d: { pnl: num(w.day?.pnl), roi: num(w.day?.roi), vlm: num(w.day?.vlm) }, w: { pnl: num(w.week?.pnl), roi: num(w.week?.roi), vlm: num(w.week?.vlm) },
    m: { pnl: num(w.month?.pnl), roi: num(w.month?.roi), vlm: num(w.month?.vlm) }, all: { pnl: num(w.allTime?.pnl), roi: num(w.allTime?.roi), vlm: num(w.allTime?.vlm) } }; });
  const top = (key) => [...flat].sort((a, b) => (key(b) ?? -Infinity) - (key(a) ?? -Infinity)).slice(0, TOP_N).map((x) => x.a);
  const keep = new Set([...top((x) => x.all.pnl), ...top((x) => x.m.pnl), ...top((x) => x.av)]);
  const kept = flat.filter((x) => keep.has(x.a));
  const byValue = [...kept].sort((a, b) => b.av - a.av).slice(0, POS_N);
  const positions = {}, errors = [];
  for (const x of byValue) {
    try {
      const pr = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "clearinghouseState", user: x.a }), signal: AbortSignal.timeout(20000) });
      if (!pr.ok) throw new Error(String(pr.status));
      const s = await pr.json();
      positions[x.a] = (s.assetPositions || []).map((p) => ({ coin: p.position.coin, szi: num(p.position.szi), entry: num(p.position.entryPx), value: num(p.position.positionValue), upnl: num(p.position.unrealizedPnl), lev: p.position.leverage?.value ?? null }));
    } catch (e) { errors.push(`${x.a}: ${e.message}`); }
    await sleep(250);
  }
  const out = { spec: "hyperliquid-whales-v1", day, recordedAt: new Date().toISOString(), accountsOnBoard: flat.length, kept: kept.length, positionsFor: Object.keys(positions).length, accounts: kept, positions, errors, complete: errors.length <= 5 };
  writeJsonAtomic(f, out);
  console.log(`hyperliquid whales ${day}: ${flat.length} accounts on the board, kept ${kept.length}, positions for ${Object.keys(positions).length}${errors.length ? `, ${errors.length} errors` : ""}`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
