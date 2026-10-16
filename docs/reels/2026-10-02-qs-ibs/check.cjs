// Weightless reproduction of the Quantified Strategies "RSI & ADX + IBS" carousel (2026-10-02 screen recording), QQQ daily from
// Schwab, price only, 3 bps round trip. Rules as shown on slide 3 (RSI and ADX are named on slides 1, 2, 5 but no rule or threshold
// for them is ever given, so they cannot be tested as stated). Not a registered read.
const path = require("path"), fs = require("fs");
const BK = process.argv[2], SYM = process.argv[3] || "QQQ";
const CACHE = path.join(__dirname, `${SYM.toLowerCase()}-daily-schwab.json`);
async function load() {
  if (fs.existsSync(CACHE)) return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  require(path.join(BK, "node_modules", "dotenv")).config({ path: path.join(BK, ".env") });
  const schwab = require(path.join(BK, "lib", "schwab.js")), tok = await schwab.token();
  const u = `https://api.schwabapi.com/marketdata/v1/pricehistory?symbol=${SYM}&periodType=year&period=20&frequencyType=daily&frequency=1&startDate=${Date.parse("1999-03-10T00:00:00Z")}&endDate=${Date.parse("2026-10-02T23:59:59Z")}&needExtendedHoursData=false`;
  const r = await fetch(u, { headers: { Authorization: "Bearer " + tok }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error("pricehistory " + r.status);
  const bars = ((await r.json()).candles || []).map((x) => ({ d: new Date(x.datetime).toLocaleDateString("en-CA", { timeZone: "America/New_York" }), o: x.open, h: x.high, l: x.low, c: x.close }))
    .filter((x) => x.c > 0 && x.h >= x.l).sort((a, b) => (a.d < b.d ? -1 : 1));
  fs.writeFileSync(CACHE, JSON.stringify(bars)); return bars;
}
const COST = 0.0003, mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const tstat = (a) => { const m = mean(a), v = a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1); return m / Math.sqrt(v / a.length); };
(async () => {
  const B = await load(), ibs = B.map((b) => (b.h > b.l ? (b.c - b.l) / (b.h - b.l) : null));
  console.log(`${SYM} bars ${B.length}: ${B[0].d} .. ${B[B.length - 1].d} (price only)`);
  // A: buy at the close when IBS < 0.1; sell everything at the close when IBS > 0.9 (slide 3 rules 1+2)
  // B: same entry; sell 50% at the close when IBS > 0.5; the rest when IBS > 0.9 (slide 3 rules 1+3+4)
  const run = (partial) => { const tr = []; let pos = null; const inMkt = new Array(B.length).fill(false);
    for (let i = 1; i < B.length; i++) {
      if (pos) { inMkt[i] = true;
        if (partial && !pos.half && ibs[i] != null && ibs[i] > 0.5 && ibs[i] <= 0.9) { pos.half = { i, px: B[i].c }; continue; }
        if (ibs[i] != null && ibs[i] > 0.9) { const full = B[i].c / B[pos.i].c - 1; const r = pos.half ? 0.5 * (pos.half.px / B[pos.i].c - 1) + 0.5 * full : full;
          tr.push({ in: B[pos.i].d, out: B[i].d, days: i - pos.i, r: r - COST }); pos = null; }
        continue; }
      if (ibs[i] != null && ibs[i] < 0.1) pos = { i, half: null };
    } return { tr, inMkt }; };
  const yrsOf = (a, b) => (Date.parse(b) - Date.parse(a)) / 3.156e10;
  const rep = (label, tr, inMkt, y0, y1) => { const t = tr.filter((x) => x.in >= y0 && x.in < y1); if (!t.length) return;
    const rs = t.map((x) => x.r), eq = rs.reduce((e, r) => e * (1 + r), 1), i0 = B.findIndex((b) => b.d >= y0), i1 = (() => { const k = B.findIndex((b) => b.d >= y1); return k < 0 ? B.length - 1 : k; })();
    let pk = 1, dd = 0, e = 1; for (const r of rs) { e *= 1 + r; pk = Math.max(pk, e); dd = Math.min(dd, e / pk - 1); }
    const days = inMkt.slice(i0, i1).filter(Boolean).length / Math.max(1, i1 - i0), yrs = yrsOf(B[i0].d, B[i1].d);
    console.log(`  ${label} ${y0}..${y1}: ${t.length} trades (${(t.length / yrs).toFixed(0)}/yr) · win ${(100 * rs.filter((r) => r > 0).length / rs.length).toFixed(1)}% · mean ${(100 * mean(rs)).toFixed(3)}%/trade t ${tstat(rs).toFixed(2)} · total ${(100 * (eq - 1)).toFixed(1)}% (CAGR ${(100 * (eq ** (1 / yrs) - 1)).toFixed(2)}%) · maxDD ${(100 * dd).toFixed(1)}% · in market ${(100 * days).toFixed(0)}% · ${SYM} price ${(100 * (B[i1].c / B[i0].c - 1)).toFixed(0)}% (CAGR ${(100 * ((B[i1].c / B[i0].c) ** (1 / yrs) - 1)).toFixed(2)}%)`); };
  for (const [lab, p] of [["A simple ", false], ["B partial", true]]) { const { tr, inMkt } = run(p);
    rep(lab, tr, inMkt, "1999-03-10", "2027-01-01"); rep(lab, tr, inMkt, "2002-01-01", "2023-01-01"); rep(lab, tr, inMkt, "2014-01-01", "2026-01-01"); rep(lab, tr, inMkt, "2016-01-01", "2027-01-01"); rep(lab, tr, inMkt, "2021-01-01", "2027-01-01"); }
})().catch((e) => { console.error(e); process.exit(1); });
