/**
 * TRACK-RECORD VERIFICATION — pure functions (2026-09-22). No network, no disk: every function takes data and returns data, so it can be
 * tested against frozen fixtures (backend/test/verify.test.js) and served by backend/verify-api.js. Data loading lives in lib/verify-data.js.
 *
 *   parseTrackRecord(text)                   CSV -> { format, trades, warnings }   (Collective2 trading-record export, or a generic CSV)
 *   makeLookup(rows)                         [[epochMs,o,h,l,c], ...] -> (epochMs, windowMin) => { lo, hi, bars } | null
 *   fillCheck(trades, lookupFor)             is each recorded entry / exit inside the real price range of its minute (+/- window)?
 *   realVsHypothetical(trades)               share of legs backed by real broker fills — only when the input carries fills
 *   reprice(trades, costModel)               gross vs net of OUR cost, per trade and in total
 *   registrationRequest(summary, params)     a PENDING forward-tracking request; nothing is registered without the operator
 *
 * What a clean result does NOT establish is written into every output (DOES_NOT_ESTABLISH): executable prices are not an edge.
 */
const DOES_NOT_ESTABLISH = "A clean fill check says the recorded prices could have been traded. It says nothing about whether the strategy will make money, and nothing about trades the record leaves out.";

// ---- CSV -------------------------------------------------------------------------------------------------------------------------------
function parseLine(l) { const o = []; let c = "", q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (ch === '"') { if (q && l[i + 1] === '"') { c += '"'; i++; } else q = !q; continue; } if (ch === "," && !q) { o.push(c); c = ""; continue; } c += ch; } o.push(c); return o.map((s) => s.trim()); }
function parseCsv(text) { const L = String(text || "").replace(/^﻿/, "").trim().split(/\r?\n/).filter((l) => l.trim()); if (!L.length) return { headers: [], rows: [] }; const headers = parseLine(L[0]); return { headers, rows: L.slice(1).map((l) => { const v = parseLine(l); return Object.fromEntries(headers.map((h, i) => [h, v[i] ?? ""])); }) }; }

// ET wall-clock "YYYY-MM-DD HH:MM[:SS]" -> epoch ms (DST-aware, no library)
function etToMs(s) {
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/); if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map((x) => Number(x || 0)), guess = Date.UTC(y, mo - 1, d, h + 5, mi, se);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second), want = Date.UTC(y, mo - 1, d, h, mi, se);
  return guess + (want - shown);
}

// futures roots we can check, their data root and $ per point
const FUT = { NQ: { data: "NQ", ppt: 20 }, MNQ: { data: "NQ", ppt: 2 }, ES: { data: "ES", ppt: 50 }, MES: { data: "ES", ppt: 5 }, RTY: { data: "RTY", ppt: 50 }, M2K: { data: "RTY", ppt: 5 }, YM: { data: "YM", ppt: 5 }, MYM: { data: "YM", ppt: 0.5 }, GC: { data: "GC", ppt: 100 }, MGC: { data: "GC", ppt: 10 }, CL: { data: "CL", ppt: 1000 }, MCL: { data: "CL", ppt: 100 } };
function classify(sym) {
  const raw = String(sym || "").toUpperCase().trim(), at = raw.startsWith("@"), s = raw.replace(/^@/, "");
  const fm = s.match(/^([A-Z0-9]{1,4}?)([FGHJKMNQUVXZ])(\d{1,2})$/); if (fm && FUT[fm[1]]) return { assetClass: "future", root: fm[1], dataRoot: FUT[fm[1]].data, pointValue: FUT[fm[1]].ppt, contract: fm[2] + fm[3] };
  // a bare root is a future ONLY with the "@" prefix: "CL" alone is Colgate stock, not crude oil
  if (at && FUT[s]) return { assetClass: "future", root: s, dataRoot: FUT[s].data, pointValue: FUT[s].ppt, contract: null };
  if (/^[A-Z]{1,5}(\.[A-Z])?$/.test(s)) return { assetClass: "stock", root: s, dataRoot: s, pointValue: 1 };
  return { assetClass: "unsupported", root: s };
}
const pick = (row, names) => { for (const n of names) for (const k of Object.keys(row)) if (k.toLowerCase().replace(/[^a-z]/g, "") === n) return row[k]; return undefined; };

function parseTrackRecord(text) {
  const { headers, rows } = parseCsv(text), warnings = []; if (!rows.length) return { format: "empty", trades: [], warnings: ["no rows"] };
  const isC2 = headers.includes("Open Time ET") && headers.includes("Avg Price Open") && headers.includes("Avg Price Closed");
  const trades = [];
  rows.forEach((r, i) => {
    const sym = isC2 ? r.Symbol : pick(r, ["symbol", "ticker"]), sideRaw = String(isC2 ? r.Side : pick(r, ["side", "direction"]) || "").toUpperCase();
    const side = /^(LONG|BUY|BTO|L)$/.test(sideRaw) ? 1 : /^(SHORT|SELL|STO|SS|S)$/.test(sideRaw) ? -1 : 0;
    const openT = isC2 ? r["Open Time ET"] : pick(r, ["opentime", "entrytime", "opentimeet", "entrytimeet"]), closeT = isC2 ? r["Closed Time ET"] : pick(r, ["closetime", "exittime", "closedtimeet", "exittimeet"]);
    const openPx = Number(isC2 ? r["Avg Price Open"] : pick(r, ["openprice", "entryprice", "entry"])), closePx = Number(isC2 ? r["Avg Price Closed"] : pick(r, ["closeprice", "exitprice", "exit"]));
    const qty = Number(isC2 ? r["Qty Open"] : pick(r, ["qty", "quantity", "contracts", "shares"]) || 1);
    const t = { row: i + 2, id: (isC2 ? r["Trade ID"] : pick(r, ["id", "tradeid"])) || String(i + 1), symbol: sym, ...classify(sym), side, qty, openMs: etToMs(openT), closeMs: etToMs(closeT), openPx, closePx, reportedPl: Number(isC2 ? r["Trade P/L"] : pick(r, ["pl", "pnl", "profit"])) };
    const bad = [!side && "side", !(t.openMs > 0) && "open time", !(t.closeMs > 0) && "close time", !(openPx > 0) && "open price", !(closePx > 0) && "close price"].filter(Boolean);
    if (bad.length) { warnings.push(`row ${t.row}: unreadable ${bad.join(", ")} — skipped`); return; }
    if (t.assetClass === "unsupported") warnings.push(`row ${t.row}: ${sym} is not a supported instrument — kept, but not fill-checked`);
    trades.push(t);
  });
  if (!isC2 && !headers.length) warnings.push("no header row");
  return { format: isC2 ? "collective2-trading-record" : "generic-csv", headers, trades, warnings };
}

// ---- prices -----------------------------------------------------------------------------------------------------------------------------
function makeLookup(rows) {
  const byMin = new Map(); for (const r of rows || []) byMin.set(Math.floor(r[0] / 60000), r);
  return (epochMs, windowMin = 1) => { const m = Math.floor(epochMs / 60000), w = []; for (let k = m - windowMin; k <= m + windowMin; k++) { const b = byMin.get(k); if (b) w.push(b); }
    if (!byMin.get(m)) return null;   // the minute itself must exist, or the window is guessing
    return { lo: Math.min(...w.map((b) => b[3])), hi: Math.max(...w.map((b) => b[2])), bars: w.length }; };
}

function fillCheck(trades, lookupFor, { windowMin = 1, tolFrac = 0.0005, rollFrac = 0.004 } = {}) {
  const legs = [], per = [];
  for (const t of trades) {
    if (t.assetClass === "unsupported") { per.push({ id: t.id, symbol: t.symbol, status: "unsupported" }); continue; }
    const look = lookupFor(t), out = { id: t.id, symbol: t.symbol, side: t.side };
    for (const [leg, ms, px] of [["entry", t.openMs, t.openPx], ["exit", t.closeMs, t.closePx]]) {
      const w = look ? look(ms, windowMin) : null; if (!w) { out[leg] = { status: "no-bar" }; legs.push({ leg, status: "no-bar" }); continue; }
      const tol = t.assetClass === "future" ? 0.25 : Math.max(px * tolFrac, 0.01);   // futures: one tick; a % tolerance is 15 pts on NQ and would hide misses
      if (px >= w.lo - tol && px <= w.hi + tol) { out[leg] = { status: "inside", lo: w.lo, hi: w.hi }; legs.push({ leg, status: "inside" }); continue; }
      const off = px < w.lo ? px - w.lo : px - w.hi;
      // an entry worse than any real print hurts the strategy (long entry too high, short entry too low); an exit likewise
      const against = (leg === "entry") === (t.side > 0) ? off > 0 : off < 0;
      const status = t.assetClass === "future" && Math.abs(off) > px * rollFrac ? "contract-mismatch" : "outside";
      out[leg] = { status, lo: w.lo, hi: w.hi, off: +off.toFixed(4), offPct: +(100 * off / px).toFixed(3), againstStrategy: against }; legs.push({ leg, status, against });
    }
    per.push(out);
  }
  const c = (s) => legs.filter((l) => l.status === s).length, outside = legs.filter((l) => l.status === "outside");
  const checked = legs.filter((l) => l.status !== "no-bar").length;
  return { legs: legs.length, checked, inside: c("inside"), outside: outside.length, outsideAgainstStrategy: outside.filter((l) => l.against).length, outsideFavoringStrategy: outside.filter((l) => !l.against).length,
    contractMismatch: c("contract-mismatch"), noBar: c("no-bar"), insidePct: checked ? +(100 * c("inside") / checked).toFixed(1) : null,
    reading: !checked ? "NOT CHECKED — no price data covers these trades" : outside.length > 0 && outside.filter((l) => !l.against).length > outside.filter((l) => l.against).length ? "CAUTION — most misses FAVOUR the strategy, which is the signature of prices that could not have been had" : c("inside") / checked >= 0.9 ? "CONSISTENT — recorded prices sit inside the real market" : "MIXED — too many prices outside the real range to call it clean",
    perTrade: per };
}

// ---- real fills vs hypothetical -------------------------------------------------------------------------------------------------------------
function realVsHypothetical(trades) {
  const withLegs = trades.filter((t) => Array.isArray(t.legs));
  if (!withLegs.length) return { determinable: false, why: "The record carries no per-fill data. A Collective2 CSV lists the strategy's average prices only; the follower fills that show whether a price was really executed appear on the strategy's web page, not in the export." };
  let legs = 0, withFills = 0, matching = 0;
  for (const t of withLegs) for (const l of t.legs) { legs++; const f = (l.fills || []).filter((x) => Number.isFinite(x.price) && x.quant > 0); if (!f.length) continue; withFills++;
    const q = f.reduce((s, x) => s + x.quant, 0), vw = f.reduce((s, x) => s + x.price * x.quant, 0) / q; if (Math.abs(vw - l.price) <= Math.max(0.011, Math.abs(l.price) * 1e-4)) matching++; }
  return { determinable: true, legs, legsWithRealFills: withFills, legsPricedAtRealFillAverage: matching, realSharePct: legs ? +(100 * matching / legs).toFixed(1) : null };
}

// ---- cost re-pricing ------------------------------------------------------------------------------------------------------------------------
const DEFAULT_COST = { futurePtsRoundTrip: 0.75, stockPctRoundTrip: 0.10 };
function reprice(trades, cost = DEFAULT_COST) {
  const per = trades.filter((t) => t.assetClass !== "unsupported").map((t) => {
    const grossPts = (t.closePx - t.openPx) * t.side;
    if (t.assetClass === "future") { const net = grossPts - cost.futurePtsRoundTrip; return { id: t.id, symbol: t.symbol, grossPts: +grossPts.toFixed(4), netPts: +net.toFixed(4), netDollarsPerContract: +(net * t.pointValue).toFixed(2) }; }
    const grossPct = 100 * grossPts / t.openPx, netPct = grossPct - cost.stockPctRoundTrip; return { id: t.id, symbol: t.symbol, grossPct: +grossPct.toFixed(4), netPct: +netPct.toFixed(4) };
  });
  const fut = per.filter((p) => p.netPts != null), stk = per.filter((p) => p.netPct != null), mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  return { costModel: cost, trades: per.length,
    futures: fut.length ? { trades: fut.length, grossPtsPerTrade: +mean(fut.map((p) => p.grossPts)).toFixed(3), netPtsPerTrade: +mean(fut.map((p) => p.netPts)).toFixed(3), netDollarsOneContractEach: +fut.reduce((s, p) => s + p.netDollarsPerContract, 0).toFixed(2), winPctNet: +(100 * fut.filter((p) => p.netPts > 0).length / fut.length).toFixed(1) } : null,
    stocks: stk.length ? { trades: stk.length, grossPctPerTrade: +mean(stk.map((p) => p.grossPct)).toFixed(4), netPctPerTrade: +mean(stk.map((p) => p.netPct)).toFixed(4), winPctNet: +(100 * stk.filter((p) => p.netPct > 0).length / stk.length).toFixed(1) } : null,
    perTrade: per, note: "One contract / equal weight per trade. Our cost, not the record's own; size and compounding are ignored." };
}

// ---- forward tracking -------------------------------------------------------------------------------------------------------------------------
function registrationRequest(summary, params = {}) {
  return { status: "PENDING_OPERATOR_APPROVAL", requestedAt: new Date().toISOString(), name: String(params.name || "").slice(0, 200), requester: params.requester || null, notes: String(params.notes || "").slice(0, 2000),
    basedOn: { format: summary.format, trades: summary.trades, fillReading: summary.fillCheck && summary.fillCheck.reading },
    rule: "Nothing is registered by this request. The operator writes the frozen rule, bar and evidence start, and only trades opened AFTER that start count." };
}

function verifyRecord(text, lookupFor, opts = {}) {
  const parsed = parseTrackRecord(text);
  return { spec: "verify-v1", format: parsed.format, trades: parsed.trades.length, warnings: parsed.warnings,
    fillCheck: fillCheck(parsed.trades, lookupFor, opts), realVsHypothetical: realVsHypothetical(parsed.trades), reprice: reprice(parsed.trades, opts.cost || DEFAULT_COST), doesNotEstablish: DOES_NOT_ESTABLISH };
}

module.exports = { parseCsv, etToMs, classify, parseTrackRecord, makeLookup, fillCheck, realVsHypothetical, reprice, registrationRequest, verifyRecord, DEFAULT_COST, DOES_NOT_ESTABLISH };
