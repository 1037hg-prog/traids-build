#!/usr/bin/env node
/**
 * TASTYTRADE vs SCHWAB QUOTE COMPARISON (2026-09-28, operator: "yes" to moving live data off Schwab's weekly re-auth).
 * Once a day in market hours (10:30-15:30 ET, first intraday fire), samples both feeds every 10 s for 3 minutes on the same
 * instruments — stocks/ETFs, the SPY at-the-money call and put of the nearest expiry, the NQ and ZN front futures — and records:
 *   mean absolute mid gap (bps), share of samples with identical mids, and a LAG check: the tastytrade series is compared with the
 *   Schwab series shifted by 0/1/2/3 samples (0-30 s); if tastytrade were delayed, a later shift would fit better than shift 0.
 * Read-only on both sides. Writes data/tasty-vs-schwab/<ET date>.json.
 *   node backend/tasty-schwab-compare.js          self-gated (market hours, once a day)
 *   node backend/tasty-schwab-compare.js --now     ignore the gate (a test run; writes <date>-TEST-outside-gate.json)
 */
"use strict";
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const SCH = require("./lib/schwab.js");
const DIR = path.join(__dirname, "data", "tasty-vs-schwab"), NOW = process.argv.includes("--now");
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/).filter((l) => /^TASTY_[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
const UA = "TRAIDS/1.0", B = "https://api.tastyworks.com", STOCKS = ["SPY", "QQQ", "IWM", "NVDA", "AAPL", "TSLA", "MSFT", "AMZN"];
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const et = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, mins: (+p.hour % 24) * 60 + +p.minute, wd: p.weekday }; };
const occFromTasty = (s) => { const m = /^\.([A-Z]+)(\d{6})([CP])(\d+(?:\.\d+)?)$/.exec(s); return m ? `${m[1]}${m[2]}${m[3]}${String(Math.round(+m[4] * 1000)).padStart(8, "0")}` : null; };

(async () => {
  const now = et(), file = path.join(DIR, NOW ? `${now.date}-TEST-outside-gate.json` : `${now.date}.json`);   // --now never writes the day file
  if (!NOW) {
    if (["Sat", "Sun"].includes(now.wd)) return console.log("tasty-vs-schwab: weekend");
    if (now.mins < 10 * 60 + 30 || now.mins > 15 * 60 + 30) return console.log("tasty-vs-schwab: outside 10:30-15:30 ET");
    if (fs.existsSync(file)) return console.log("tasty-vs-schwab: already ran today");
  }
  const tj = await (await fetch(B + "/oauth/token", { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: env.TASTY_REFRESH_TOKEN, client_secret: env.TASTY_CLIENT_SECRET, client_id: env.TASTY_CLIENT_ID }) })).json();
  if (!tj.access_token) throw new Error("tastytrade token exchange failed");
  const H = { "User-Agent": UA, Authorization: "Bearer " + tj.access_token };
  const chain = (await (await fetch(B + "/option-chains/SPY/nested", { headers: H })).json()).data.items[0];
  const exp = chain.expirations.sort((a, b) => (a["expiration-date"] < b["expiration-date"] ? -1 : 1))[0];
  const spot = (await SCH.quotesBySymbol(["SPY"])).SPY; const atm = exp.strikes.reduce((best, s) => (Math.abs(+s["strike-price"] - spot.mid) < Math.abs(+best["strike-price"] - spot.mid) ? s : best));
  const futs = {}; for (const root of ["NQ", "ZN"]) { const it = (await (await fetch(B + `/instruments/futures?product-code[]=${root}`, { headers: H })).json()).data.items.filter((f) => f.active).sort((a, b) => (a["expiration-date"] < b["expiration-date"] ? -1 : 1)); const f = it.find((x) => x["active-month"]) || it[0]; futs[root] = { tasty: f["streamer-symbol"], schwab: "/" + root + f.symbol.charAt(root.length + 1) + f["expiration-date"].slice(2, 4) }; /* tasty /NQZ6 -> Schwab /NQZ26 */ }
  // instrument map: key -> { tasty symbol, schwab kind + symbol }
  const inst = {};
  for (const s of STOCKS) inst[s] = { t: s, kind: "equity", s };
  for (const [side, fld] of [["C", "call-streamer-symbol"], ["P", "put-streamer-symbol"]]) { const ts = atm[fld]; inst[`SPY ${side} ${atm["strike-price"]}`] = { t: ts, kind: "option", s: occFromTasty(ts) }; }
  for (const [root, f] of Object.entries(futs)) inst["/" + root] = { t: f.tasty, kind: "future", s: f.schwab };
  const q = (await (await fetch(B + "/api-quote-tokens", { headers: H })).json()).data; const ws = new WebSocket(q["dxlink-url"]); const last = {}; const send = (o) => ws.send(JSON.stringify(o));
  ws.onopen = () => { send({ type: "SETUP", channel: 0, version: "0.1-TRAIDS", keepaliveTimeout: 60, acceptKeepaliveTimeout: 60 }); send({ type: "AUTH", channel: 0, token: q.token }); };
  ws.onmessage = (m) => { const d = JSON.parse(m.data);
    if (d.type === "AUTH_STATE" && d.state === "AUTHORIZED") send({ type: "CHANNEL_REQUEST", channel: 3, service: "FEED", parameters: { contract: "AUTO" } });
    else if (d.type === "CHANNEL_OPENED") { send({ type: "FEED_SETUP", channel: 3, acceptAggregationPeriod: 0.1, acceptDataFormat: "COMPACT", acceptEventFields: { Quote: ["eventType", "eventSymbol", "bidPrice", "askPrice"] } }); send({ type: "FEED_SUBSCRIPTION", channel: 3, reset: true, add: Object.values(inst).map((x) => ({ type: "Quote", symbol: x.t })) }); }
    else if (d.type === "FEED_DATA") { const a = d.data; for (let i = 0; i < a.length; i += 2) { const v = a[i + 1]; for (let j = 0; j < v.length; j += 4) last[v[j + 1]] = { b: v[j + 2], a: v[j + 3] }; } }
    else if (d.type === "KEEPALIVE") send({ type: "KEEPALIVE", channel: 0 }); };
  await nap(5000);
  const series = Object.fromEntries(Object.keys(inst).map((k) => [k, { tasty: [], schwab: [] }]));
  for (let n = 0; n < 18; n++) {   // 18 x 10 s = 3 minutes
    let eq = {}, op = {}, fu = {};
    try { eq = await SCH.quotesBySymbol(STOCKS); } catch {}
    try { op = await SCH.quotesByOcc(Object.values(inst).filter((x) => x.kind === "option").map((x) => x.s)); } catch {}
    try { fu = await SCH.quotesBySymbol(Object.values(inst).filter((x) => x.kind === "future").map((x) => x.s)); } catch {}
    for (const [k, x] of Object.entries(inst)) {
      const t = last[x.t], s = x.kind === "equity" ? eq[x.s] : x.kind === "option" ? op[x.s] : fu[x.s];
      series[k].tasty.push(t && t.b > 0 && t.a > 0 ? (t.b + t.a) / 2 : null); series[k].schwab.push(s && s.bid > 0 && s.ask > 0 ? (s.bid + s.ask) / 2 : null);
    }
    await nap(10000);
  }
  try { ws.close(); } catch {}
  const report = {};
  for (const [k, sr] of Object.entries(series)) {
    const fit = (shift) => { const e = []; for (let i = shift; i < sr.tasty.length; i++) { const a = sr.tasty[i], b = sr.schwab[i - shift]; if (a != null && b != null) e.push(Math.abs(a - b) / b * 1e4); } return e.length ? e.reduce((s, x) => s + x, 0) / e.length : null; };
    const pairs = sr.tasty.map((a, i) => [a, sr.schwab[i]]).filter(([a, b]) => a != null && b != null);
    const byShift = [0, 1, 2, 3].map((s) => fit(s)); const best = byShift.reduce((bi, v, i, arr) => (v != null && (arr[bi] == null || v < arr[bi]) ? i : bi), 0);
    report[k] = { samples: pairs.length, meanAbsGapBps: byShift[0] != null ? +byShift[0].toFixed(2) : null, identicalMidPct: pairs.length ? Math.round(100 * pairs.filter(([a, b]) => Math.abs(a - b) < 0.0051).length / pairs.length) : null,
      gapByShiftBps: byShift.map((v) => (v == null ? null : +v.toFixed(2))), bestShiftSeconds: best * 10, tastyMissing: sr.tasty.filter((x) => x == null).length, schwabMissing: sr.schwab.filter((x) => x == null).length };
  }
  const lagged = Object.entries(report).filter(([, r]) => r.bestShiftSeconds > 0 && r.gapByShiftBps[0] != null && r.gapByShiftBps[0] - r.gapByShiftBps[r.bestShiftSeconds / 10] > 0.5).map(([k]) => k);
  fs.mkdirSync(DIR, { recursive: true });
  writeJsonAtomic(file, { ranAt: new Date().toISOString(), etMinutes: now.mins, method: "18 samples x 10 s; mid = (bid+ask)/2; lag = Schwab series shifted 0-30 s", instruments: inst, report, verdict: lagged.length ? `tastytrade appears LAGGED on: ${lagged.join(", ")}` : "no lag detected: shift 0 fits best (or within 0.5 bps) on every instrument" });
  console.log(`tasty-vs-schwab ${now.date}: ${lagged.length ? "LAG on " + lagged.join(", ") : "no lag detected"}`);
  for (const [k, r] of Object.entries(report)) console.log(`  ${k.padEnd(16)} gap ${r.meanAbsGapBps} bps · identical ${r.identicalMidPct}% · best shift ${r.bestShiftSeconds}s · missing t/s ${r.tastyMissing}/${r.schwabMissing}`);
  process.exit(0);
})().catch((e) => { console.error("tasty-vs-schwab FAILED:", e.message); process.exit(1); });
