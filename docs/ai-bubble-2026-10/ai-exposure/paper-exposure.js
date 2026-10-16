// AI / semiconductor exposure of the TRAIDS PAPER books. Read-only: reads paper-positions.json (from fetch-paper.js),
// etf-profiles/*.json (from fetch-etf-profiles.js), backend/data/board_positions.json, backend/data/book-etf-state.json.
// No account numbers are read or printed.
const fs = require("fs"), path = require("path");
const C = require("./classify");
const ROOT = "C:/Users/joshc/Downloads/traids (2)/traids-bundle";
const P = require("./paper-positions.json");
const prof = s => JSON.parse(fs.readFileSync(path.join(__dirname, "etf-profiles", s + ".json"), "utf8"));
const pct = (x, d = 1) => (100 * x).toFixed(d) + "%";
const $ = x => (x < 0 ? "-$" : "$") + Math.abs(Math.round(x)).toLocaleString("en-US");

// ---- 1. fund look-through table -------------------------------------------------------------
const EEM_TSMC = { weight: 0.1552, as: "AI_HW" }; // ASSUMPTION: EEM's unnamed #1 holding (15.52%) is Taiwan Semiconductor
const LT = {};
for (const s of ["QQQ", "SPY", "XLK", "EFA", "IWM", "EEM"]) {
  const p = prof(s); LT[s] = C.lookThrough(p, s === "EEM" ? EEM_TSMC : null); LT[s].asOf = p.last_updated; LT[s].n = p.holdings.length;
}
LT.EWJ = { ...LT.EFA, proxy: "EFA" }; LT.EWG = { ...LT.EFA, proxy: "EFA" }; // AV returns no holdings for EWJ/EWG -> EFA proxy (ASSUMPTION)
console.log("\n## Fund look-through (Alpha Vantage ETF_PROFILE, holdings as of", LT.QQQ.asOf + ")");
console.log("fund | holdings n | weight covered | AI-HW/semis | AI mega-cap | AI total");
for (const [s, v] of Object.entries(LT)) console.log(`${s}${v.proxy ? " (proxy " + v.proxy + ")" : ""} | ${v.n} | ${pct(v.covered)} | ${pct(v.hw)} | ${pct(v.mega)} | ${pct(v.hw + v.mega)}`);

// ---- 2. Alpaca paper accounts ---------------------------------------------------------------
const planE = JSON.parse(fs.readFileSync(path.join(ROOT, "backend/data/book-etf-state.json"), "utf8"));
const planESyms = new Set(Object.keys(planE.holdings));
const B = ["AI_HW", "AI_MEGA", "INDEX", "CRYPTO", "OTHER"];
const summary = {};
console.log("\n## Alpaca paper accounts (GET /v2/account + /v2/positions, fetched " + P.fetchedAt + ")");
for (const a of P.accounts) {
  const agg = {}; for (const b of B) agg[b] = { long: 0, short: 0, names: [] };
  let ltHw = 0, ltMega = 0, pwr = 0;
  for (const p of a.positions) {
    const b = C.classify(p.symbol, p.asset_class), mv = p.market_value, u = C.base(p.symbol);
    agg[b][mv >= 0 ? "long" : "short"] += mv; agg[b].names.push(p.symbol.replace(/USD$/, "") + " " + $(mv));
    if (b === "INDEX") { const L = LT[u]; if (!L) throw new Error("no look-through for " + u); ltHw += mv * L.hw; ltMega += mv * L.mega; }
    if (C.AI_PWR.has(u)) pwr += mv;
  }
  const eq = a.equity;
  console.log(`\n### ${a.acct}: equity ${$(eq)} (cash ${$(a.cash)}, long MV ${$(a.long_market_value)}, short MV ${$(a.short_market_value)}), ${a.positions.length} positions`);
  console.log("bucket | long $ | short $ | net $ | net % of equity | names (largest first, up to 12)");
  for (const b of B) {
    const g = agg[b]; const net = g.long + g.short;
    const names = g.names.sort((x, y) => Math.abs(+y.split("$")[1].replace(/,/g, "")) - Math.abs(+x.split("$")[1].replace(/,/g, ""))).slice(0, 12).join(", ");
    console.log(`${b} | ${$(g.long)} | ${$(g.short)} | ${$(net)} | ${pct(net / eq)} | ${names}`);
  }
  const hwNet = agg.AI_HW.long + agg.AI_HW.short, megaNet = agg.AI_MEGA.long + agg.AI_MEGA.short;
  console.log(`look-through: AI-HW direct ${$(hwNet)} + via index ${$(ltHw)} = ${$(hwNet + ltHw)} (${pct((hwNet + ltHw) / eq)}); ` +
    `AI mega-cap direct ${$(megaNet)} + via index ${$(ltMega)} = ${$(megaNet + ltMega)} (${pct((megaNet + ltMega) / eq)}); ` +
    `combined ${$(hwNet + ltHw + megaNet + ltMega)} = ${pct((hwNet + ltHw + megaNet + ltMega) / eq)} of equity`);
  console.log(`memo: AI power/infra names (GEV/VST/CEG/TLN/BE/PWR/...) inside OTHER: ${$(pwr)} (${pct(pwr / eq)})`);
  if (a.acct === "book") {
    let pe = 0, r24 = 0; for (const p of a.positions) (planESyms.has(p.symbol) ? (pe += p.market_value) : (r24 += p.market_value));
    console.log(`book split: Plan E ETF sleeves (${[...planESyms].join("/")}) ${$(pe)} = ${pct(pe / eq)}; R24 13F mirror (18 names) ${$(r24)} = ${pct(r24 / eq)}; cash ${$(a.cash)}`);
    // per-sleeve AI look-through
    let peHw = 0, peMega = 0, rHw = 0, rMega = 0;
    for (const p of a.positions) {
      const b = C.classify(p.symbol, p.asset_class), mv = p.market_value;
      if (planESyms.has(p.symbol)) { if (LT[p.symbol]) { peHw += mv * LT[p.symbol].hw; peMega += mv * LT[p.symbol].mega; } }
      else { if (b === "AI_HW") rHw += mv; if (b === "AI_MEGA") rMega += mv; }
    }
    const peNav = pe + planE.cash;
    console.log(`Plan E sub-book NAV = sleeves ${$(pe)} + sub-book cash ${$(planE.cash)} = ${$(peNav)}: AI-HW via QQQ/SPY/EFA ${$(peHw)} (${pct(peHw / peNav)}), AI mega ${$(peMega)} (${pct(peMega / peNav)}), total ${pct((peHw + peMega) / peNav)}`);
    console.log(`R24 mirror ${$(r24)}: AI-HW ${$(rHw)} (${pct(rHw / r24)}), AI mega ${$(rMega)} (${pct(rMega / r24)}), total ${pct((rHw + rMega) / r24)}`);
    console.log(`Plan E trend-filter distance to OUT (book-etf-state.json signals as of ${planE.signalsAsOf}; month-end close vs 10-month avg):`);
    for (const [s, v] of Object.entries(planE.signals)) if (v.avg10) console.log(`  ${s}: close ${v.close} avg10 ${v.avg10} -> ${v.on ? "IN" : "OUT"}, ${v.on ? "a month-end close " + pct(v.avg10 / v.close - 1) + " below the 9-30 close flips it OUT" : "needs a month-end close " + pct(v.avg10 / v.close - 1) + " above the 9-30 close to flip IN"} (avg10 held fixed)`);
  }
  summary[a.acct] = { eq, hw: hwNet + ltHw, mega: megaNet + ltMega, crypto: agg.CRYPTO.long + agg.CRYPTO.short, pwr };
}
const tot = Object.values(summary).reduce((s, x) => ({ eq: s.eq + x.eq, hw: s.hw + x.hw, mega: s.mega + x.mega, crypto: s.crypto + x.crypto, pwr: s.pwr + x.pwr }), { eq: 0, hw: 0, mega: 0, crypto: 0, pwr: 0 });
console.log(`\nALL 3 PAPER ACCOUNTS: equity ${$(tot.eq)}; AI-HW look-through ${$(tot.hw)} (${pct(tot.hw / tot.eq)}); AI mega-cap ${$(tot.mega)} (${pct(tot.mega / tot.eq)}); ` +
  `AI total ${$(tot.hw + tot.mega)} (${pct((tot.hw + tot.mega) / tot.eq)}); crypto ${$(tot.crypto)} (${pct(tot.crypto / tot.eq)}); AI power memo ${$(tot.pwr)} (${pct(tot.pwr / tot.eq)})`);

// ---- 3. The board (paper ledger, not a broker account) --------------------------------------
const board = JSON.parse(fs.readFileSync(path.join(ROOT, "backend/data/board_positions.json"), "utf8"));
const BOOK = 100000; // backend/lib/risk-policy.js line 87: account: 100000 // paper book
const notional = t => t.notional || (t.units && t.entry ? t.units * t.entry : 0) || (t.shares && t.entry ? t.shares * t.entry : 0);
function boardAgg(list, label) {
  const eq = {}, opt = {}; for (const b of B) { eq[b] = { long: 0, short: 0, n: 0, names: [] }; opt[b] = { bull: 0, bear: 0, n: 0, names: [] }; }
  for (const t of list) {
    const b = C.classify(t.sym, t.cls);
    if (t.cls === "Options") { const o = opt[b]; o.n++; o[t.dir > 0 ? "bull" : "bear"] += t.riskDollars || 0; o.names.push(t.sym + (t.dir > 0 ? "+" : "-")); }
    else { const e = eq[b]; e.n++; const n = notional(t) * (t.dir > 0 ? 1 : -1); e[n >= 0 ? "long" : "short"] += n; e.names.push(t.sym + (t.dir > 0 ? "+" : "-")); }
  }
  console.log(`\n### board ${label}: ${list.length} open tickets (book $${BOOK.toLocaleString()} per lib/risk-policy.js)`);
  console.log("bucket | stock/crypto n | long notional | short notional | net % of $100k | option tickets n | bullish max-loss $ | bearish max-loss $ | names");
  for (const b of B) {
    const e = eq[b], o = opt[b]; const net = e.long + e.short;
    const nm = [...new Set([...e.names, ...o.names])].slice(0, 16).join(" ");
    console.log(`${b} | ${e.n} | ${$(e.long)} | ${$(e.short)} | ${pct(net / BOOK)} | ${o.n} | ${$(o.bull)} | ${$(o.bear)} | ${nm}`);
  }
}
const sig = board.filter(t => !t.ctrl && !t.vetoShadow), ctrl = board.filter(t => t.ctrl && !t.vetoShadow), shadow = board.filter(t => t.vetoShadow);
console.log(`\n## Board: ${board.length} open tickets = ${sig.length} signal + ${ctrl.length} live controls + ${shadow.length} veto shadows (shadows excluded below)`);
boardAgg(sig, "SIGNAL tickets");
boardAgg(ctrl, "CONTROL tickets (random-direction measurement controls)");
