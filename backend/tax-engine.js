#!/usr/bin/env node
/**
 * TRAIDS — CORE TAX ENGINE (2026-07-24). The live version of the measured tax alpha.
 *
 * WHY THIS EXISTS: `direct-index-tlh.js` MEASURED the effect on 6 years of real prices —
 * 0.70%/yr with no contributions, 1.03%/yr with $100k/yr, and crisis years are the bonanza
 * (4.85% of capital harvested in 2020, 4.62% in 2022). That was a backtest. This turns it
 * into a weekly action list against YOUR actual lots. No prediction, no market cooperation
 * required — the only alpha in this whole project that doesn't need an edge to exist.
 *
 * WHAT IT DOES
 *   1. Reads lot-level holdings (backend/data/holdings.json — template written on first run).
 *   2. Prices every position live (Alpaca via :3001, Yahoo fallback via :3002).
 *   3. Flags harvestable lots: loss ≥ THRESH_PCT and ≥ MIN_LOSS_USD, LONG-TERM vs SHORT-TERM
 *      separated (short-term losses are worth more — they offset short-term gains taxed at
 *      ordinary rates).
 *   4. WASH-SALE GUARD, both directions: never harvest a symbol bought within the last 30
 *      days, and never re-buy a harvested symbol for 31 days. Reads the append-only event
 *      log (backend/data/tax-events.json) so the rule survives restarts and weeks.
 *   5. Names a SUBSTITUTE to hold the exposure during the 31-day window, from the same
 *      same-industry pair map the backtest used (never a "substantially identical" security).
 *   6. Values the harvest at your marginal rates and tracks YTD realized, carryforward, and
 *      the $3,000 ordinary-income offset.
 *   7. Emits a printable action sheet: TRAIDS_Tax_Actions.html.
 *
 * DISCIPLINE: this is a worksheet, not an order router. It places nothing. It is also NOT
 * tax advice — it computes the mechanical consequences of rules you can verify, and you (as
 * your own RIA) decide. Losses are DEFERRAL, not free money: value comes from time-value,
 * bracket arbitrage, the $3k offset, and step-up at death — and it decays as basis resets.
 *
 * Usage:  node backend/tax-engine.js            (weekly)
 *         node backend/tax-engine.js --record   (also log the harvests as executed)
 */
const fs = require("fs"), path = require("path");
const HOLD_PATH = path.join(__dirname, "data", "holdings.json");
const EVENT_PATH = path.join(__dirname, "data", "tax-events.json");
const OUT_HTML = path.join(__dirname, "..", "TRAIDS_Tax_Actions.html");

// ── knobs (edit these to your situation) ──────────────────────────────────────
const THRESH_PCT = 0.05;        // harvest at −5% or worse
const MIN_LOSS_USD = 250;       // ignore trivial harvests (fees/tracking error not worth it)
const RATE_SHORT = 0.37 + 0.05; // ordinary + state (short-term losses offset these)
const RATE_LONG = 0.20 + 0.05;  // LTCG + state
const SWAP_COST_BPS = 2;        // round-trip cost of the harvest+substitute swap

const PAIRS = [
  ["KO","PEP"],["HD","LOW"],["V","MA"],["XOM","CVX"],["JPM","BAC"],["GS","MS"],["WFC","C"],
  ["UPS","FDX"],["UNP","CSX"],["LMT","NOC"],["RTX","GD"],["CAT","DE"],["HON","EMR"],["MMM","ITW"],
  ["PG","CL"],["WMT","COST"],["TGT","DG"],["MCD","YUM"],["SBUX","CMG"],["NKE","LULU"],
  ["LLY","MRK"],["PFE","BMY"],["ABBV","AMGN"],["JNJ","ABT"],["UNH","ELV"],["CI","CVS"],
  ["TMO","DHR"],["ISRG","SYK"],["MDT","BSX"],["GILD","VRTX"],["REGN","BIIB"],
  ["AAPL","MSFT"],["GOOGL","META"],["AMZN","SHOP"],["NVDA","AMD"],["AVGO","QCOM"],
  ["TXN","ADI"],["AMAT","LRCX"],["KLAC","ASML"],["INTC","MU"],["CRM","NOW"],["ADBE","INTU"],
  ["ORCL","SAP"],["IBM","ACN"],["CSCO","ANET"],["PANW","FTNT"],["CRWD","ZS"],
  ["NFLX","DIS"],["CMCSA","CHTR"],["T","VZ"],["NEE","DUK"],["SO","D"],["AEP","EXC"],["XEL","WEC"],
  ["AMT","CCI"],["PLD","EQIX"],["SPG","O"],["PSA","EXR"],["LIN","APD"],["SHW","PPG"],
  ["ECL","IFF"],["NUE","STLD"],["FCX","NEM"],["COP","EOG"],["SLB","HAL"],["PSX","VLO"],
  ["KMI","WMB"],["BLK","SCHW"],["AXP","COF"],["SPGI","MCO"],["ICE","CME"],
];
const substituteFor = (sym) => { for (const [a, b] of PAIRS) { if (a === sym) return b; if (b === sym) return a; } return null; };

const TEMPLATE = {
  _README: "Lot-level taxable holdings. Export from your custodian and paste here. One entry PER LOT (that is what makes specific-lot harvesting possible). acct: 'taxable' | 'ira' | 'roth'. Only 'taxable' lots are harvestable.",
  asOf: new Date().toISOString().slice(0, 10),
  ytdRealizedShort: 0, ytdRealizedLong: 0, priorCarryforward: 0,
  lots: [
    { sym: "EXAMPLE", shares: 100, costBasis: 15000, acquired: "2025-03-14", acct: "taxable" },
  ],
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const money = (v) => (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 });

async function priceAll(syms) {
  const out = {};
  for (let i = 0; i < syms.length; i += 90) {
    const chunk = syms.slice(i, i + 90);
    try {
      const r = await fetch(`http://localhost:3001/api/equities/snapshot?symbols=${encodeURIComponent(chunk.join(","))}`);
      if (r.ok) { const j = await r.json(); for (const s in j) if (j[s]?.price > 0) out[s] = j[s].price; }
    } catch {}
  }
  for (const s of syms.filter(s => !out[s])) {           // Yahoo fallback (ETFs, odd tickers)
    try {
      const r = await fetch(`http://localhost:3002/api/yahoo/${encodeURIComponent(s)}/history?days=5&interval=1d`);
      if (r.ok) { const b = (await r.json()).bars || []; const last = b.filter(x => x.close != null).pop(); if (last) out[s] = last.close; }
    } catch {}
  }
  return out;
}

(async () => {
  console.log(`\n  TRAIDS — CORE TAX ENGINE · ${todayISO()} · worksheet only, places nothing\n`);
  if (!fs.existsSync(HOLD_PATH)) {
    fs.mkdirSync(path.dirname(HOLD_PATH), { recursive: true });
    fs.writeFileSync(HOLD_PATH, JSON.stringify(TEMPLATE, null, 2));
    console.log(`  Wrote a template to backend/data/holdings.json.`);
    console.log(`  Export lot-level positions from your custodian (symbol, shares, cost basis, acquisition`);
    console.log(`  date, account), paste them in, and re-run. ONE ENTRY PER LOT — specific-lot selection is`);
    console.log(`  where most of the tax alpha lives.\n`);
    return;
  }
  const H = JSON.parse(fs.readFileSync(HOLD_PATH, "utf8"));
  const events = fs.existsSync(EVENT_PATH) ? JSON.parse(fs.readFileSync(EVENT_PATH, "utf8")) : [];
  const lots = (H.lots || []).filter(l => l && l.sym && l.sym !== "EXAMPLE" && (l.acct || "taxable") === "taxable" && l.shares > 0);
  if (!lots.length) { console.log("  No taxable lots found in holdings.json (template still in place?).\n"); return; }

  const px = await priceAll([...new Set(lots.map(l => l.sym))]);
  const missing = [...new Set(lots.map(l => l.sym))].filter(s => !px[s]);
  if (missing.length) console.log(`  ⚠ no price for: ${missing.join(", ")} — those lots are skipped, not guessed.\n`);

  // WASH-SALE STATE from the append-only event log
  const lastBuy = {}, lastHarvest = {};
  for (const e of events) {
    if (e.type === "buy" && (!lastBuy[e.sym] || e.date > lastBuy[e.sym])) lastBuy[e.sym] = e.date;
    if (e.type === "harvest" && (!lastHarvest[e.sym] || e.date > lastHarvest[e.sym])) lastHarvest[e.sym] = e.date;
  }
  const today = todayISO();

  const rows = [];
  for (const l of lots) {
    const p = px[l.sym]; if (!p) continue;
    const mkt = p * l.shares, gain = mkt - l.costBasis, pct = gain / l.costBasis;
    const held = daysBetween(l.acquired, today);
    const term = held > 365 ? "LONG" : "SHORT";
    // The acquisition itself counts as a purchase for the 30-day look-back, so the newest of
    // {this lot's acquisition, any logged buy of the symbol} is what opens the window.
    const daysSinceBuy = Math.min(...[l.acquired, lastBuy[l.sym]].filter(Boolean).map(d => daysBetween(d, today)));
    const blockedByBuy = daysSinceBuy <= 30;
    const harvestable = gain < 0 && Math.abs(gain) >= MIN_LOSS_USD && pct <= -THRESH_PCT && !blockedByBuy;
    rows.push({ ...l, price: p, mkt, gain, pct, held, term, daysSinceBuy, blockedByBuy, harvestable,
      sub: substituteFor(l.sym), swapCost: mkt * SWAP_COST_BPS / 10000,
      taxValue: gain < 0 ? Math.abs(gain) * (term === "SHORT" ? RATE_SHORT : RATE_LONG) : 0 });
  }

  const harvest = rows.filter(r => r.harvestable).sort((a, b) => b.taxValue - a.taxValue);
  const blocked = rows.filter(r => r.gain < 0 && r.blockedByBuy);
  const repurchaseBlocked = Object.entries(lastHarvest).filter(([, d]) => daysBetween(d, today) <= 31)
    .map(([sym, d]) => ({ sym, until: new Date(new Date(d).getTime() + 31 * 86400000).toISOString().slice(0, 10) }));

  const totalLoss = harvest.reduce((s, r) => s + Math.abs(r.gain), 0);
  const shortLoss = harvest.filter(r => r.term === "SHORT").reduce((s, r) => s + Math.abs(r.gain), 0);
  const longLoss = totalLoss - shortLoss;
  const grossValue = harvest.reduce((s, r) => s + r.taxValue, 0);
  const swapCost = harvest.reduce((s, r) => s + r.swapCost, 0);
  const netValue = grossValue - swapCost;
  const portMkt = rows.reduce((s, r) => s + r.mkt, 0);

  console.log(`  taxable lots priced: ${rows.length} · market value ${money(portMkt)}`);
  console.log(`  HARVEST CANDIDATES: ${harvest.length} lot(s) · losses ${money(totalLoss)} (short ${money(shortLoss)} / long ${money(longLoss)})`);
  console.log(`  estimated tax value ${money(grossValue)} − swap cost ${money(swapCost)} = NET ${money(netValue)}${portMkt ? ` (${(netValue / portMkt * 100).toFixed(2)}% of the book)` : ""}`);
  if (blocked.length) console.log(`  wash-sale BLOCKED (bought within 30d): ${blocked.map(b => b.sym).join(", ")}`);
  if (repurchaseBlocked.length) console.log(`  do NOT re-buy until: ${repurchaseBlocked.map(r => r.sym + " (" + r.until + ")").join(", ")}`);
  console.log("");
  if (harvest.length) {
    console.log("  sell lot                          loss      term   tax value   buy substitute");
    console.log("  " + "-".repeat(88));
    for (const r of harvest.slice(0, 25))
      console.log(`  ${(r.sym + " " + r.shares + "sh @" + r.acquired).padEnd(32)}${money(r.gain).padStart(9)}${("  " + r.term).padEnd(9)}${money(r.taxValue).padStart(10)}   ${r.sub ? r.sub : "⚠ no pair mapped — pick your own non-identical proxy"}`);
  }

  // realized / carryforward accounting
  const ytdShort = (H.ytdRealizedShort || 0) - shortLoss, ytdLong = (H.ytdRealizedLong || 0) - longLoss;
  const netRealized = ytdShort + ytdLong + (H.priorCarryforward || 0);
  console.log(`\n  AFTER these harvests: YTD realized short ${money(ytdShort)} · long ${money(ytdLong)} · with carryforward ${money(netRealized)}`);
  if (netRealized < 0) console.log(`  → ${money(Math.min(3000, Math.abs(netRealized)))} offsets ordinary income this year; ${money(Math.max(0, Math.abs(netRealized) - 3000))} carries forward indefinitely.`);
  else console.log(`  → net realized is POSITIVE: harvesting now offsets real gains rather than banking a carryforward — the higher-value case.`);

  // ── action sheet ──
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>TRAIDS — Tax Actions ${today}</title><style>
body{font-family:Georgia,serif;max-width:900px;margin:0 auto;padding:36px 24px;color:#1a1d23}
h1{font-size:22px;margin:0 0 4px}.sub{color:#5a6270;font-size:13px;margin-bottom:18px}
h2{font-size:16px;margin:26px 0 8px;border-bottom:2px solid #1a1d23;padding-bottom:3px}
table{border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px;margin:10px 0}
th{background:#f0f2f5;text-align:left;padding:6px 8px;border-bottom:2px solid #c9ced6;font-size:11px;text-transform:uppercase}
td{padding:5px 8px;border-bottom:1px solid #e3e6eb}.num{text-align:right;font-variant-numeric:tabular-nums}
.chip{display:inline-block;border:1px solid #c9ced6;border-radius:6px;padding:8px 14px;margin:4px 8px 4px 0;font-family:Arial,sans-serif}
.chip b{display:block;font-size:18px}.chip span{font-size:10px;color:#5a6270;text-transform:uppercase}
.warn{background:#fff8e1;border-left:4px solid #a06000;padding:10px 14px;margin:12px 0;font-size:13px}
.note{color:#5a6270;font-size:12px;margin-top:22px;border-top:1px solid #c9ced6;padding-top:10px}
</style></head><body>
<h1>Tax Action Sheet — ${today}</h1>
<div class="sub">Generated by <code>node backend/tax-engine.js</code> · worksheet only: this document places no orders and is not tax advice.</div>
<div>
<span class="chip"><b>${harvest.length}</b><span>lots to harvest</span></span>
<span class="chip"><b>${money(totalLoss)}</b><span>losses available</span></span>
<span class="chip"><b>${money(netValue)}</b><span>net tax value</span></span>
<span class="chip"><b>${portMkt ? (netValue / portMkt * 100).toFixed(2) + "%" : "—"}</b><span>of book, this pass</span></span>
</div>
${repurchaseBlocked.length ? `<div class="warn"><b>Do not repurchase</b> (31-day wash-sale window open): ${repurchaseBlocked.map(r => esc(r.sym) + " until " + r.until).join(" · ")}</div>` : ""}
${blocked.length ? `<div class="warn"><b>Cannot harvest yet</b> — purchased within the last 30 days: ${blocked.map(b => esc(b.sym) + " (" + b.daysSinceBuy + "d)").join(" · ")}</div>` : ""}
<h2>Harvest — sell these specific lots</h2>
${harvest.length ? `<table><tr><th>Symbol</th><th class="num">Shares</th><th>Acquired</th><th class="num">Loss</th><th>Term</th><th class="num">Tax value</th><th>Buy substitute</th></tr>
${harvest.map(r => `<tr><td><b>${esc(r.sym)}</b></td><td class="num">${r.shares}</td><td>${esc(r.acquired)}</td><td class="num">${money(r.gain)}</td><td>${r.term}</td><td class="num">${money(r.taxValue)}</td><td>${r.sub ? esc(r.sub) : "<i>pick a non-identical proxy</i>"}</td></tr>`).join("")}</table>
<p style="font-size:13px">Short-term losses are listed first by value because they offset income taxed at ordinary rates (${(RATE_SHORT * 100).toFixed(0)}% assumed) rather than LTCG (${(RATE_LONG * 100).toFixed(0)}%).</p>` : "<p>No lot clears the −" + (THRESH_PCT * 100) + "% / " + money(MIN_LOSS_USD) + " bar today. That is the normal state in an up market — the bonanza years are the drawdowns (2020: 4.85% of capital harvested; 2022: 4.62%).</p>"}
<h2>Realized position after these harvests</h2>
<table><tr><th>Bucket</th><th class="num">Amount</th></tr>
<tr><td>YTD realized — short-term</td><td class="num">${money(ytdShort)}</td></tr>
<tr><td>YTD realized — long-term</td><td class="num">${money(ytdLong)}</td></tr>
<tr><td>Prior carryforward</td><td class="num">${money(H.priorCarryforward || 0)}</td></tr>
<tr><td><b>Net</b></td><td class="num"><b>${money(netRealized)}</b></td></tr></table>
<p style="font-size:13px">${netRealized < 0 ? `${money(Math.min(3000, Math.abs(netRealized)))} offsets ordinary income this year; ${money(Math.max(0, Math.abs(netRealized) - 3000))} carries forward indefinitely.` : `Net realized is positive — harvesting now offsets actual gains, which is worth more than banking a carryforward.`}</p>
<h2>Asset location — the other certain lever</h2>
<table><tr><th>Hold here</th><th>Put these</th><th>Why</th></tr>
<tr><td><b>Taxable</b></td><td>direct-indexed equities, munis</td><td>harvesting only works in taxable; munis are already tax-free</td></tr>
<tr><td><b>Tax-deferred (IRA/401k)</b></td><td>bond-ladder interest, REITs, any managed-futures/trend sleeve</td><td>ordinary-income and 1256 distributions are the most tax-hostile; rebalance here for free</td></tr>
<tr><td><b>Roth</b></td><td>the highest-expected-growth tax-inefficient asset</td><td>growth is never taxed — put the biggest compounder here</td></tr></table>
<div class="note">Losses are DEFERRAL, not free money: the value is time-value of the deferred tax, bracket arbitrage, the $3,000 ordinary offset, and step-up at death — and it decays as basis resets, which is why fresh cash keeps the engine alive (measured: 0.70%/yr without contributions, 1.03%/yr with $100k/yr). Wash-sale rule applies across ALL your accounts including a spouse's and IRAs — this engine only sees the lots you give it. Verify every action before executing.</div>
</body></html>`;
  fs.writeFileSync(OUT_HTML, html);
  console.log(`\n  wrote TRAIDS_Tax_Actions.html (printable action sheet)`);

  if (process.argv.includes("--record") && harvest.length) {
    const add = harvest.map(r => ({ type: "harvest", sym: r.sym, shares: r.shares, date: today, loss: +r.gain.toFixed(2) }))
      .concat(harvest.filter(r => r.sub).map(r => ({ type: "buy", sym: r.sub, date: today, note: "substitute for " + r.sym })));
    fs.writeFileSync(EVENT_PATH, JSON.stringify([...events, ...add], null, 1));
    console.log(`  recorded ${add.length} event(s) to tax-events.json — the wash-sale clock now runs on them.`);
  } else if (harvest.length) {
    console.log(`  (run again with --record once executed, so the 31-day repurchase clock starts)`);
  }
  console.log("");
})().catch(e => { console.error("\n  tax-engine error:", e.message, "\n"); process.exit(1); });
