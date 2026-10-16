// Weightless reproduction of the Quantified Strategies reel (slides 2-4), SPY daily from Schwab. Not a registered read.
const path = require("path"), fs = require("fs");
const BK = process.argv[2];
const CACHE = path.join(__dirname, "spy-daily-schwab.json");
async function load() {
  if (fs.existsSync(CACHE)) return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  require(path.join(BK, "node_modules", "dotenv")).config({ path: path.join(BK, ".env") });
  const schwab = require(path.join(BK, "lib", "schwab.js")), tok = await schwab.token();
  const u = `https://api.schwabapi.com/marketdata/v1/pricehistory?symbol=SPY&periodType=year&period=20&frequencyType=daily&frequency=1&startDate=${Date.parse("1993-01-01T00:00:00Z")}&endDate=${Date.parse("2026-10-02T23:59:59Z")}&needExtendedHoursData=false`;
  const r = await fetch(u, { headers: { Authorization: "Bearer " + tok }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error("pricehistory " + r.status);
  const bars = ((await r.json()).candles || []).map((x) => ({ d: new Date(x.datetime).toLocaleDateString("en-CA", { timeZone: "America/New_York" }), o: x.open, h: x.high, l: x.low, c: x.close }))
    .filter((x) => x.c > 0).sort((a, b) => (a.d < b.d ? -1 : 1));
  fs.writeFileSync(CACHE, JSON.stringify(bars));
  return bars;
}
function rsiWilder(c, n) {
  const out = new Array(c.length).fill(NaN); let ag = 0, al = 0;
  for (let i = 1; i < c.length; i++) {
    const ch = c[i] - c[i - 1], g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= n) { ag += g / n; al += l / n; if (i === n) out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); continue; }
    ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
const sma = (c, n) => c.map((_, i) => (i + 1 < n ? NaN : c.slice(i + 1 - n, i + 1).reduce((a, b) => a + b, 0) / n));
const tstat = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length, v = a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1); return m / Math.sqrt(v / a.length); };
(async () => {
  const B = await load(), C = B.map((b) => b.c), R = rsiWilder(C, 5), S200 = sma(C, 200), S50 = sma(C, 50);
  console.log(`SPY bars ${B.length}: ${B[0].d} .. ${B[B.length - 1].d} (price only, no dividends)`);
  const COST = 0.0003; // 3 bps round trip at the close auction, SPY
  // ---- Strategy A: slides 2-3 -------------------------------------------------------------------------------------
  const trades = []; let pos = null; const inMkt = new Array(B.length).fill(false);
  for (let i = 203; i < B.length; i++) {
    if (pos) {
      inMkt[i] = true;
      if (R[i] > 50 && R[i - 1] <= 50) { trades.push({ in: B[pos.i].d, out: B[i].d, days: i - pos.i, r: C[i] / C[pos.i] - 1 - COST }); pos = null; }
      continue;
    }
    const sig = R[i] < 30 && R[i] < R[i - 1] && R[i - 1] < R[i - 2] && R[i - 2] < R[i - 3] && R[i - 3] < 60 && C[i] > S200[i];
    if (sig) pos = { i };
  }
  const open = pos ? { in: B[pos.i].d, markR: C[C.length - 1] / C[pos.i] - 1 } : null;
  const eq = (tr) => tr.reduce((e, t) => e * (1 + t.r), 1);
  const yrs = (B.length - 203) / 252;
  const bh = C[C.length - 1] / C[203];
  const report = (label, tr, y0, y1) => {
    const t = tr.filter((x) => x.in >= y0 && x.in < y1); if (!t.length) return console.log(`  ${label}: no trades`);
    const w = t.filter((x) => x.r > 0).length, rs = t.map((x) => x.r), m = rs.reduce((a, b) => a + b, 0) / rs.length;
    const days = t.reduce((a, x) => a + x.days, 0);
    const i0 = B.findIndex((b) => b.d >= y0), i1 = (B.findIndex((b) => b.d >= y1) + B.length) % B.length || B.length - 1;
    const bhR = C[i1] / C[Math.max(i0, 203)] - 1;
    console.log(`  ${label}: ${t.length} trades · win ${(100 * w / t.length).toFixed(1)}% · mean ${(100 * m).toFixed(3)}%/trade (t ${tstat(rs).toFixed(2)}) · avg hold ${(days / t.length).toFixed(1)} d · compounded ${(100 * (eq(t) - 1)).toFixed(1)}% · SPY price same span ${(100 * bhR).toFixed(1)}%`);
  };
  console.log(`\nA — RSI(5) slides 2-3 (exit RSI5 crosses above 50), 3 bps round trip:`);
  report("all      ", trades, "1993", "2027"); report("1994-2007", trades, "1993", "2008"); report("2008-2015", trades, "2008", "2016"); report("2016-2026", trades, "2016", "2027");
  const tim = inMkt.filter(Boolean).length / (B.length - 203);
  let pk = 1, dd = 0, e = 1; for (const t of trades) { e *= 1 + t.r; pk = Math.max(pk, e); dd = Math.min(dd, e / pk - 1); }
  console.log(`  time in market ${(100 * tim).toFixed(1)}% · strategy CAGR ${(100 * (eq(trades) ** (1 / yrs) - 1)).toFixed(2)}% vs SPY price CAGR ${(100 * (bh ** (1 / yrs) - 1)).toFixed(2)}% · trade-to-trade max DD ${(100 * dd).toFixed(1)}% · open now: ${open ? JSON.stringify(open) : "none"}`);
  // per-exposed-day comparison: strategy daily return while in market vs SPY's average day while above SMA200
  const dayR = []; for (let i = 204; i < B.length; i++) if (inMkt[i]) dayR.push(C[i] / C[i - 1] - 1);
  const above = []; for (let i = 204; i < B.length; i++) if (C[i - 1] > S200[i - 1]) above.push(C[i] / C[i - 1] - 1);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`  per day in the market ${(100 * mean(dayR)).toFixed(3)}% (n ${dayR.length}) vs SPY's average day above its 200-day ${(100 * mean(above)).toFixed(3)}% (n ${above.length})`);
  const last = trades.slice(-8).map((t) => `${t.in}->${t.out} ${(100 * t.r).toFixed(2)}%`); console.log("  last 8:", last.join(" | "));
  // ---- Slide 4: deep pullback — count the setups (rules too vague to trade; see chat) ------------------------------
  let ep = 0, inEp = false; const eps = [];
  for (let i = 252; i < B.length; i++) {
    const hi = Math.max(...C.slice(i - 251, i + 1)), cond = S50[i] > S200[i] && C[i] <= hi * 0.86;
    if (cond && !inEp) { ep++; eps.push(B[i].d); } inEp = cond;
  }
  console.log(`\nSlide 4 setup (SMA50 > SMA200 AND close >= 14% below its 52-week high close): ${ep} separate episodes since ${B[252].d}: ${eps.join(", ")}`);
  console.log(`Their own chart: $100,000 -> $217,333 over ~1993-2025 = ${(100 * ((217333 / 100000) ** (1 / 32) - 1)).toFixed(2)}%/yr; SPY price alone over the same span ${(100 * ((C[B.findIndex((b) => b.d >= "2025-01-01")] / C[0]) ** (1 / 32) - 1)).toFixed(2)}%/yr`);
})().catch((e) => { console.error(e); process.exit(1); });
