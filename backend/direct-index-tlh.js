#!/usr/bin/env node
/**
 * TRAIDS — DIRECT-INDEXING TAX-LOSS-HARVEST BACKTEST
 *
 * THE QUESTION: direct indexing's value is not return — it's TAX LOSSES. So the only
 * question that matters is: how many losses can you actually harvest per year, how fast
 * does it decay as your basis rises, and is that worth more than the 10-40bp a provider
 * charges to do it for you?
 *
 * This measures it on real data, with real rules:
 *   • Universe = ~60 SAME-INDUSTRY PAIRS (KO/PEP, HD/LOW, V/MA, XOM/CVX…). Each "slot"
 *     holds ONE of its pair. This is exactly how a real TLH engine swaps a loser without
 *     triggering a wash sale: sell the loser, buy its economic twin, keep the exposure.
 *   • LOT-LEVEL accounting: every purchase (initial + each contribution) is its own lot
 *     with its own basis. Harvesting is per-lot, not per-position — that's where the real
 *     opportunity lives (an old green lot and a new red lot in the same name).
 *   • WASH-SALE BLOCK: after selling a security at a loss, it cannot be repurchased for
 *     31 days. Enforced per security, both directions.
 *   • HARVEST RULE: sell a lot when it is down more than THRESH% AND the loss exceeds a
 *     minimum dollar amount (so we don't churn for pennies). Trading cost charged per swap.
 *   • CONTRIBUTIONS: optional monthly cash in — new lots create fresh harvest opportunities,
 *     which is the main reason mature direct-index accounts keep producing losses.
 *
 * OUTPUTS: harvested losses per year as % of capital; the DECAY curve (year 1 vs year 5);
 * path dependence (a bear year is a harvesting bonanza); pretax return vs SPY (harvesting
 * should barely move it — if it does, something's wrong); and the tax alpha at your rate,
 * compared head-to-head against provider fees.
 *
 * Usage: node backend/direct-index-tlh.js
 *   env: YEARS=6 CAPITAL=1000000 CONTRIB_MO=0 TAX_RATE=30 THRESH=5 MIN_LOSS=250 COST_BPS=2
 */
const fs = require("fs"), path = require("path");
(function loadEnv() { try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY, FEED = process.env.ALPACA_FEED || "iex";
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, Accept: "application/json" };

const YEARS      = parseFloat(process.env.YEARS || "6");
const CAPITAL    = parseFloat(process.env.CAPITAL || "1000000");
const CONTRIB_MO = parseFloat(process.env.CONTRIB_MO || "0");      // monthly contribution ($)
const TAX_RATE   = parseFloat(process.env.TAX_RATE || "30") / 100; // rate the harvested losses offset at
const THRESH     = parseFloat(process.env.THRESH || "5") / 100;    // harvest when a lot is down > this
const MIN_LOSS   = parseFloat(process.env.MIN_LOSS || "250");      // and the loss exceeds this ($)
const COST_BPS   = parseFloat(process.env.COST_BPS || "2");        // round-trip cost per swap (bps of notional)
const WASH_DAYS  = 31;

// ~60 same-industry pairs — the substitution set. Sell one, buy its twin, keep the exposure.
const PAIRS = [
  ["KO","PEP"],["HD","LOW"],["V","MA"],["XOM","CVX"],["JPM","BAC"],["GS","MS"],["WFC","C"],
  ["UPS","FDX"],["UNP","CSX"],["LMT","NOC"],["RTX","GD"],["CAT","DE"],["HON","EMR"],["MMM","ITW"],
  ["PG","CL"],["WMT","COST"],["TGT","DG"],["MCD","YUM"],["SBUX","CMG"],["NKE","LULU"],
  ["LLY","MRK"],["PFE","BMY"],["ABBV","AMGN"],["JNJ","ABT"],["UNH","ELV"],["CI","CVS"],
  ["TMO","DHR"],["ISRG","SYK"],["MDT","BSX"],["GILD","VRTX"],["REGN","BIIB"],
  ["AAPL","MSFT"],["GOOGL","META"],["AMZN","SHOP"],["NVDA","AMD"],["AVGO","QCOM"],
  ["TXN","ADI"],["AMAT","LRCX"],["KLAC","ASML"],["INTC","MU"],["CRM","NOW"],["ADBE","INTU"],
  ["ORCL","SAP"],["IBM","ACN"],["CSCO","ANET"],["PANW","FTNT"],["CRWD","ZS"],
  ["NFLX","DIS"],["CMCSA","CHTR"],["T","VZ"],["TMUS","LUMN"],
  ["NEE","DUK"],["SO","D"],["AEP","EXC"],["XEL","WEC"],
  ["AMT","CCI"],["PLD","EQIX"],["SPG","O"],["PSA","EXR"],
  ["LIN","APD"],["SHW","PPG"],["ECL","IFF"],["NUE","STLD"],["FCX","NEM"],
  ["COP","EOG"],["SLB","HAL"],["PSX","VLO"],["KMI","WMB"],
  ["BLK","SCHW"],["AXP","COF"],["SPGI","MCO"],["ICE","CME"],
  ["BKNG","EXPE"],["MAR","HLT"],["ORLY","AZO"],["TJX","ROST"],
];

async function bars(sym, start) {
  const out = []; let tok = null;
  do {
    const p = new URLSearchParams({ symbols: sym, timeframe: "1Day", start, limit: "10000", adjustment: "all", feed: FEED });
    if (tok) p.set("page_token", tok);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${p}`, { headers });
    if (!r.ok) break;
    const j = await r.json();
    for (const b of (j.bars?.[sym] || [])) out.push({ t: (b.t || "").slice(0, 10), c: b.c });
    tok = j.next_page_token || null;
  } while (tok);
  return out;
}

(async () => {
  const startISO = new Date(Date.now() - YEARS * 365.25 * 86400000).toISOString().slice(0, 10);
  console.log(`\n  TRAIDS — DIRECT-INDEXING TLH BACKTEST`);
  console.log(`  $${(CAPITAL / 1000).toFixed(0)}k · ${YEARS}y from ${startISO} · ${PAIRS.length} industry pairs · harvest at −${(THRESH * 100).toFixed(0)}% / >$${MIN_LOSS}`);
  console.log(`  contributions $${CONTRIB_MO.toLocaleString()}/mo · wash-sale block ${WASH_DAYS}d · swap cost ${COST_BPS}bps · tax rate ${(TAX_RATE * 100).toFixed(0)}%\n`);

  const syms = [...new Set(PAIRS.flat())];
  process.stdout.write("  fetching");
  const px = {};
  for (const s of syms) { const d = await bars(s, startISO); process.stdout.write("."); if (d.length > 100) px[s] = Object.fromEntries(d.map(b => [b.t, b.c])); }
  const spyB = await bars("SPY", startISO);
  const spy = Object.fromEntries(spyB.map(b => [b.t, b.c]));
  const dates = spyB.map(b => b.t);
  // keep only pairs where BOTH legs have full data
  const pairs = PAIRS.filter(([a, b]) => px[a] && px[b] && px[a][dates[0]] && px[b][dates[0]]);
  console.log(` ${syms.length} names · ${pairs.length} usable pairs\n`);

  // ── state ──
  const slots = pairs.map(([a, b]) => ({ pair: [a, b], held: a, lots: [] }));   // lots: {sym, shares, basis, day}
  const blocked = {};                     // sym -> date it can be repurchased
  let cash = 0, realizedLoss = 0, swaps = 0, costPaid = 0;
  const perSlot = CAPITAL / slots.length;
  for (const s of slots) {
    const p = px[s.held][dates[0]];
    s.lots.push({ sym: s.held, shares: perSlot / p, basis: p, day: dates[0] });
  }
  const yearly = {};   // year -> { harvested, contributed }
  const dayIdx = (d) => Math.floor(new Date(d).getTime() / 86400000);
  let lastContribMonth = dates[0].slice(0, 7);

  for (let di = 1; di < dates.length; di++) {
    const t = dates[di];
    const y = t.slice(0, 4);
    yearly[y] = yearly[y] || { harvested: 0, contributed: 0, swaps: 0 };

    // monthly contribution → new lots (fresh basis = fresh harvest opportunities)
    if (CONTRIB_MO > 0 && t.slice(0, 7) !== lastContribMonth) {
      lastContribMonth = t.slice(0, 7);
      const per = CONTRIB_MO / slots.length;
      for (const s of slots) {
        const p = px[s.held][t]; if (!p) continue;
        s.lots.push({ sym: s.held, shares: per / p, basis: p, day: t });
      }
      yearly[y].contributed += CONTRIB_MO;
    }

    // harvest scan (weekly, to model a realistic cadence rather than daily churn)
    if (di % 5 !== 0) continue;
    for (const s of slots) {
      const cur = s.held, twin = s.pair[0] === cur ? s.pair[1] : s.pair[0];
      const pc = px[cur]?.[t], pt = px[twin]?.[t];
      if (!pc || !pt) continue;
      if ((blocked[twin] || 0) > dayIdx(t)) continue;          // can't buy the twin yet (wash-sale block)

      // Which lots of the held name are harvestable? Threshold applies PER LOT (that's the
      // whole point of lot-level accounting — a new red lot is harvestable even if an old
      // lot is green), but MIN_LOSS is checked on the AGGREGATE, as a real engine does.
      // (Bug caught 2026-07-14: per-lot MIN_LOSS silently skipped every small contribution
      // lot, hiding the main reason mature accounts keep harvesting.)
      const losers = s.lots.filter(l => l.sym === cur && (pc / l.basis - 1) < -THRESH);
      if (!losers.length) continue;

      let sharesSold = 0, loss = 0;
      for (const l of losers) { loss += (l.basis - pc) * l.shares; sharesSold += l.shares; }
      if (loss < MIN_LOSS) continue;                          // not worth the swap
      const notional = sharesSold * pc;
      const cost = notional * COST_BPS / 10000;
      realizedLoss += loss; costPaid += cost; swaps++;
      yearly[y].harvested += loss; yearly[y].swaps++;

      // sell those lots, block the security, buy the twin with the proceeds (minus cost)
      s.lots = s.lots.filter(l => !losers.includes(l));
      blocked[cur] = dayIdx(t) + WASH_DAYS;
      const buyShares = (notional - cost) / pt;
      s.lots.push({ sym: twin, shares: buyShares, basis: pt, day: t });
      s.held = twin;
      // NOTE: any remaining (green) lots of the old name stay held — that's correct: you only
      // sell the losing lots. In practice you'd hold both names briefly; modeled as the slot
      // now holding the twin for future harvests, with old green lots retained.
    }
  }

  // ── final valuation ──
  const last = dates[dates.length - 1];
  let mv = 0, unrealizedBasis = 0;
  for (const s of slots) for (const l of s.lots) { const p = px[l.sym]?.[last]; if (p) { mv += l.shares * p; unrealizedBasis += l.shares * l.basis; } }
  const contributed = Object.values(yearly).reduce((a, v) => a + v.contributed, 0);
  const invested = CAPITAL + contributed;
  const spyShares = CAPITAL / spy[dates[0]];
  let spyMv = spyShares * spy[last];
  if (CONTRIB_MO > 0) { let sh = 0; let lm = dates[0].slice(0, 7); for (const t of dates) { if (t.slice(0, 7) !== lm) { lm = t.slice(0, 7); sh += CONTRIB_MO / spy[t]; } } spyMv += sh * spy[last]; }

  const yrs = (dayIdx(last) - dayIdx(dates[0])) / 365.25;
  const pad = (s, n) => String(s).padEnd(n);
  console.log("  ── PRETAX (harvesting should barely move this — the value is in the losses, not the return) ──");
  console.log(`    direct-index basket:  $${Math.round(mv).toLocaleString()}   (invested $${Math.round(invested).toLocaleString()})`);
  console.log(`    SPY, same cashflows:  $${Math.round(spyMv).toLocaleString()}`);
  console.log(`    tracking difference:  ${((mv / spyMv - 1) * 100).toFixed(2)}%   ← this is your TRACKING ERROR, the real DIY risk\n`);

  console.log("  ── HARVESTED LOSSES (the entire point) ──");
  console.log("    " + pad("year", 8) + pad("harvested $", 15) + pad("% of capital", 15) + pad("swaps", 8) + "tax value @ " + (TAX_RATE * 100).toFixed(0) + "%");
  const years = Object.keys(yearly).sort();
  for (const y of years) {
    const h = yearly[y].harvested;
    if (!h && !yearly[y].swaps) continue;
    console.log("    " + pad(y, 8) + pad("$" + Math.round(h).toLocaleString(), 15) + pad((h / CAPITAL * 100).toFixed(2) + "%", 15) + pad(yearly[y].swaps, 8) + "$" + Math.round(h * TAX_RATE).toLocaleString());
  }
  const taxValue = realizedLoss * TAX_RATE;
  console.log(`    ${pad("TOTAL", 8)}${pad("$" + Math.round(realizedLoss).toLocaleString(), 15)}${pad((realizedLoss / CAPITAL * 100).toFixed(2) + "%", 15)}${pad(swaps, 8)}$${Math.round(taxValue).toLocaleString()}\n`);

  const alphaPerYr = (taxValue / CAPITAL / yrs) * 100;
  console.log("  ── THE VERDICT: DIY vs PAYING SOMEONE ──");
  console.log(`    tax alpha:            ${alphaPerYr.toFixed(2)}% / yr   (harvested losses × ${(TAX_RATE * 100).toFixed(0)}% ÷ capital ÷ ${yrs.toFixed(1)}y)`);
  console.log(`    trading cost paid:    $${Math.round(costPaid).toLocaleString()}  (${(costPaid / CAPITAL / yrs * 100).toFixed(3)}%/yr)`);
  console.log(`    NET tax alpha:        ${(alphaPerYr - costPaid / CAPITAL / yrs * 100).toFixed(2)}% / yr\n`);
  console.log("    provider fees for comparison:");
  for (const [n, f] of [["Frec", 0.10], ["Wealthfront", 0.25], ["Schwab", 0.40]])
    console.log(`      ${pad(n, 14)}${f.toFixed(2)}%/yr → DIY saves ${f.toFixed(2)}%, but you inherit wash-sale + tracking risk`);
  console.log(`\n    HONEST READ: the tax alpha above is only worth face value if you HAVE GAINS to offset.`);
  console.log(`    Without them it's a $3k/yr deduction plus a carryforward. And note the DECAY in the`);
  console.log(`    yearly table — as basis falls below price, the harvest dries up. Bear years are the`);
  console.log(`    bonanza; that's when this earns its keep. Tracking error is the risk that eats it.\n`);
})().catch(e => { console.error("\n  error:", e.message, "\n"); process.exit(1); });
