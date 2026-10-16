#!/usr/bin/env node
"use strict";
/**
 * R231 SELL REPAIR (2026-10-12) — THE EVIDENCE, read-only: every number NOTES.md gives, worked from the recorded files.
 *   node docs/r231-sell-repair/2026-10-12/evidence.cjs              from the FROZEN copies of 2026-10-12 (harness/recorded/): the numbers
 *                                                                    in NOTES.md, the same every time it is run
 *   node docs/r231-sell-repair/2026-10-12/evidence.cjs --live       the same reading of the live files in backend/data (they move every
 *                                                                    evening; the trade-updates and mirror rows are filtered the same way)
 *   ... --json                                                       the numbers as one JSON object (the selftest compares NOTES.md with it)
 * It asks the broker NOTHING and writes nothing. Two kinds of number, never mixed:
 *   RECORDED  read off a file: R231's ledger and state, R191's state, the board mirror's rows, the recorded fills of the main paper account
 *   MODEL     "if every buy on this account was charged as the two balances the broker itself stated show" — 0.25% of the filled quantity,
 *             taken in the coin, rounded UP at 9 decimals. The two stated balances (BCH, DOGE) fit it to the last digit; no other fee was read.
 */
const fs = require("fs"), path = require("path");
const L = require("./lib.cjs");
const { UNIVERSE, nano, s9 } = L;
const modelFee = (qty) => Math.ceil(nano(qty) * 0.0025 - 1e-6);
const jl = (t) => String(t).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const usd = (x) => (x < 0 ? "-$" : "$") + Math.abs(x).toFixed(2);

function load(live) {
  const D = live ? path.join(L.REPO, "backend", "data") : path.join(L.PKG, "harness", "recorded"), rd = (f) => fs.readFileSync(path.join(D, f), "utf8");
  const SYM = new RegExp(`^(${UNIVERSE.join("|")})/?USD$`);
  return { from: live ? "backend/data (live)" : "harness/recorded (frozen 2026-10-12)", state: JSON.parse(rd("r231-crypto-vote-sized.json")), ledger: jl(rd("r231-crypto-vote-sized.jsonl")), r191: JSON.parse(rd("r191-crypto-trend.json")), r191Ledger: jl(rd("r191-crypto-trend.jsonl")),
    mirror: jl(rd("alpaca-mirror.jsonl")).filter((r) => r && r.cls === "Crypto"), mirrorExits: jl(rd("alpaca-mirror-exits.jsonl")).filter((r) => r && r.cls === "Crypto"),
    trades: jl(rd(live ? "alpaca-trade-updates.jsonl" : "trade-updates-main-crypto.jsonl")).filter((r) => r && r.account === "main" && SYM.test(String(r.symbol || ""))), dir: D };
}

function evidence(X) {
  const S = X.state, coinOfCid = (cid) => (/^r\d+-([A-Z0-9]+)-/.exec(String(cid)) || [])[1], last = {};
  for (const m of S.marks) if (m.close != null && (!last[m.coin] || m.d > last[m.coin].d)) last[m.coin] = m;
  // 1 the defect, as the ledger holds it
  const sent = X.ledger.filter((r) => r.kind === "sent"), sells = sent.filter((r) => r.side === "sell"), filledSells = X.ledger.filter((r) => (r.kind === "filled" || r.kind === "partial-filled") && r.side === "sell");
  const said = L.recordedBalances(X.ledger).map((b) => { const req = (/requested: ([0-9.]+)/.exec(String((X.ledger.find((r) => r.cid === b.cid) || {}).error)) || [])[1], cnt = nano(req), av = nano(b.available);
    return { coin: b.coin, on: b.ts, cid: b.cid, requested: req, available: b.available, short: s9(cnt - av), shortPct: +((100 * (cnt - av)) / cnt).toFixed(4), modelFee: s9(modelFee(req)), modelFits: cnt - modelFee(req) === av }; });
  // 2 the counts on file, and what the model takes off them
  const rows = UNIVERSE.map((c) => { const st = S.coins[c], buys = S.orders.filter((o) => o.side === "buy" && coinOfCid(o.cid) === c), fee = buys.reduce((a, o) => a + modelFee(o.qty), 0), px = last[c] ? last[c].close : null;
    return { coin: c, count: st.qty, buys: buys.length, sells: S.orders.filter((o) => o.side === "sell" && coinOfCid(o.cid) === c).length, modelFee: s9(fee), modelNet: s9(nano(st.qty) - fee), close: px, markDay: last[c] && last[c].d, usdCount: +(st.qty * px).toFixed(2), usdFee: +((fee / 1e9) * px).toFixed(2), eligible: last[c] ? last[c].eligible : null, pending: !!st.pending }; });
  // 3 the other sleeves on the same account, coin by coin: what each bought and sold in full, and the fee its full sells took out of the shared balance
  const others = {};
  const add = (c, k, v) => { others[c] = others[c] || { r191Bought: 0, r191Sold: 0, r191Held: 0, mirrorBought: 0, mirrorSold: 0, mirrorOpen: 0, taken: 0 }; others[c][k] += v; };
  for (const o of X.r191.orders || []) { const c = coinOfCid(o.cid); if (o.side === "buy") { add(c, "r191Bought", nano(o.qty)); } else add(c, "r191Sold", nano(o.qty)); }
  for (const [c, v] of Object.entries(X.r191.coins || {})) add(c, "r191Held", nano(v.qty));
  const fin = new Set(X.mirrorExits.filter((x) => x.final).map((x) => x.ticketId));
  for (const r of X.mirror.filter((r) => r.orderId && r.live)) { const c = L.coinOf(r.sym), n = Math.floor(Number(r.qty) * 1e9 + 1e-6); add(c, "mirrorBought", n); if (fin.has(r.ticketId)) add(c, "mirrorSold", n); else add(c, "mirrorOpen", n); }
  for (const c of Object.keys(others)) { const o = others[c];
    // a sleeve that sold a coin in full sold its FILLED quantity; the account had received that less the fee; the difference came out of the shared balance
    o.takenR191 = o.r191Sold ? [...(X.r191.orders || [])].filter((x) => x.side === "buy" && coinOfCid(x.cid) === c).reduce((a, x) => a + modelFee(x.qty), 0) : 0;
    o.takenMirror = X.mirror.filter((r) => r.orderId && r.live && L.coinOf(r.sym) === c && fin.has(r.ticketId)).reduce((a, r) => a + modelFee(Math.floor(Number(r.qty) * 1e9 + 1e-6) / 1e9), 0);
    o.taken = o.takenR191 + o.takenMirror;
    // what the others still COUNT is filled quantity too; what the account holds FOR them is that less their fee: the cap leaves their whole count alone
    o.reserveGap = (o.r191Held ? [...(X.r191.orders || [])].filter((x) => x.side === "buy" && coinOfCid(x.cid) === c).reduce((a, x) => a + modelFee(x.qty), 0) : 0); }
  const shared = rows.filter((r) => others[r.coin]).map((r) => { const o = others[r.coin], net = nano(r.modelNet), room = net - o.taken - o.reserveGap;
    return { coin: r.coin, count: r.count, modelNet: r.modelNet, takenByOthers: s9(o.taken), leftForOthersCount: s9(o.reserveGap), room: s9(room), shortOfCount: s9(nano(r.count) - room), shortOfCountPct: +((100 * (nano(r.count) - room)) / nano(r.count)).toFixed(2), shortOfNet: s9(net - room), shortOfNetPct: +((100 * (net - room)) / net).toFixed(2), usdShortOfNet: +(((net - room) / 1e9) * r.close).toFixed(2), usdTakenByR191: +((o.takenR191 / 1e9) * r.close).toFixed(2), usdTakenByMirror: +((o.takenMirror / 1e9) * r.close).toFixed(2), usdLeftForOthersCount: +((o.reserveGap / 1e9) * r.close).toFixed(2),
      r191: { bought: s9(o.r191Bought), sold: s9(o.r191Sold), held: s9(o.r191Held) }, mirror: { bought: s9(o.mirrorBought), sold: s9(o.mirrorSold), open: s9(o.mirrorOpen) } }; });
  // 3b DUST. What a close may write off is one twentieth of the DUST BASE: the larger of the count at the close and what this book has bought of
  // the coin since it was last flat (the reading of the runner's own dustBase, staged/helpers.txt: a sell row with `writtenOff`, or the rows'
  // running count at zero, is a flat; the selftest compares the two coin by coin). What is missing is a fixed quantity, so on the count ALONE
  // it would stop being dust once the rule had trimmed the coin below 20 times it.
  const boughtSinceFlat = (c) => { let run = 0, b = 0; for (const o of S.orders) { if (!/^r231-/.test(String(o.cid)) || coinOfCid(o.cid) !== c) continue; const q = nano(o.qty); if (!(q > 0)) continue; if (o.side === "buy") { run += typeof o.net === "number" ? nano(o.net) : q; b += q; } else { run = typeof o.writtenOff === "number" ? 0 : Math.max(0, run - q); if (run === 0) b = 0; } } return b; };
  const pct = (a, b) => (b > 0 ? +((100 * a) / b).toFixed(2) : null);
  const dust = rows.map((r) => { const cnt = nano(r.count), bought = boughtSinceFlat(r.coin), base = Math.max(cnt, bought), sh = shared.find((x) => x.coin === r.coin), short = sh ? nano(sh.shortOfCount) : nano(r.modelFee);
    return { coin: r.coin, count: r.count, bought: s9(bought), base: s9(base), room: s9(Math.floor(base / 20)), usdRoom: +((base / 20 / 1e9) * r.close).toFixed(2), short: s9(short), usdShort: +((short / 1e9) * r.close).toFixed(2), shortOfBoughtPct: pct(short, bought), shortOfCountPct: pct(short, cnt), isDust: short * 20 <= base, onTheCountAloneNotDustBelow: s9(short * 20), usdOnTheCountAloneNotDustBelow: +(((short * 20) / 1e9) * r.close).toFixed(2), sharedCoin: !!sh }; });
  // 4 R191, read the same way
  const r191 = { coins: X.r191.coins, orders: (X.r191.orders || []).map((o) => ({ cid: o.cid, side: o.side, qty: o.qty, px: o.px, at: o.at, modelFee: o.side === "buy" ? s9(modelFee(o.qty)) : null, modelReceived: o.side === "buy" ? s9(nano(o.qty) - modelFee(o.qty)) : null })),
    rejected: X.r191Ledger.filter((r) => r.kind === "order-rejected").length, fullSells: (X.r191.orders || []).filter((o) => o.side === "sell").map((o) => { const buy = (X.r191.orders || []).find((b) => b.side === "buy" && coinOfCid(b.cid) === coinOfCid(o.cid)); return { cid: o.cid, asked: o.qty, itsOwnBuy: buy && buy.qty, askedItsFilledQty: !!buy && nano(buy.qty) === nano(o.qty), modelReceived: buy ? s9(nano(buy.qty) - modelFee(buy.qty)) : null, cameFromTheSharedBalance: buy ? s9(modelFee(buy.qty)) : null, usd: buy ? +((modelFee(buy.qty) / 1e9) * o.px).toFixed(2) : null }; }) };
  // 5 the recorded fills of the main account in these coins, by who sent them
  const finalOrder = new Map(); for (const r of X.trades) finalOrder.set(r.order_id, r);
  const cls = (id) => (/^r231-/.test(id) ? "R231" : /^r191-/.test(id) ? "R191" : /^mx-/.test(id) ? "the mirror's exits (and the operator's sells of 10-01)" : /^[0-9a-f]{8}-/.test(id) ? "the mirror's entries" : "other");
  const fills = {}; for (const r of finalOrder.values()) { const f = Number(r.filled_qty) || 0; if (!f) continue; const k = `${cls(String(r.client_order_id))} | ${r.side}`; fills[k] = (fills[k] || 0) + 1; }
  // 6 what a mark row holds
  const markKeys = [...new Set(S.marks.flatMap((m) => Object.keys(m)))].sort();
  const totals = { coinsHeld: rows.filter((r) => r.count > 0).length, usdCount: +rows.reduce((a, r) => a + r.usdCount, 0).toFixed(2), usdFee: +rows.reduce((a, r) => a + r.usdFee, 0).toFixed(2), notionalOnFile: +Object.values(S.coins).reduce((a, v) => a + (Number(v.notional) || 0), 0).toFixed(2), buys: S.orders.filter((o) => o.side === "buy").length, sellsFilled: S.orders.filter((o) => o.side === "sell").length,
    voteOffHeld: rows.filter((r) => r.count > 0 && r.eligible === false).map((r) => r.coin), markDay: rows[0].markDay, marks: S.marks.length, markDays: new Set(S.marks.map((m) => m.d)).size, usdShortOfNet: +shared.reduce((a, r) => a + r.usdShortOfNet, 0).toFixed(2), usdTakenByR191: +shared.reduce((a, r) => a + r.usdTakenByR191, 0).toFixed(2), usdTakenByMirror: +shared.reduce((a, r) => a + r.usdTakenByMirror, 0).toFixed(2), usdLeftForOthersCount: +shared.reduce((a, r) => a + r.usdLeftForOthersCount, 0).toFixed(2), mirrorTickets: X.mirror.filter((r) => r.orderId && r.live).length };
  return { from: X.from, stateAsOf: S.asOf, ledgerRows: X.ledger.length, kinds: X.ledger.reduce((a, r) => { a[r.kind] = (a[r.kind] || 0) + 1; return a; }, {}), sellsSent: sells.map((r) => ({ cid: r.cid, coin: r.coin, qty: r.qty, full: r.targetNotional === 0 })), sellsFilled: filledSells.map((r) => ({ cid: r.cid, qty: r.qty })), said, rows, totals, shared, dust, r191, fills, markKeys };
}

function print(V) {
  const P = console.log;
  P(`R231 sell repair — the evidence, read from ${V.from}. State as of ${V.stateAsOf}; ledger ${V.ledgerRows} rows (${Object.entries(V.kinds).map(([k, n]) => `${n} ${k}`).join(", ")}).`);
  P("\n1  THE DEFECT, AS THE LEDGER HOLDS IT  (RECORDED)");
  P(`   sells the runner sent and the broker took: ${V.sellsSent.length} — ${V.sellsSent.map((s) => `${s.coin} ${s.qty} (${s.full ? "the whole count" : "part of the count"})`).join("; ") || "none"}; filled: ${V.sellsFilled.length}`);
  for (const b of V.said) P(`   REFUSED ${b.on.slice(0, 10)} ${b.coin}: asked ${b.requested} (the count), the broker said the account held ${b.available} — ${b.short} ${b.coin} less, ${b.shortPct}% of the count. MODEL fee ${b.modelFee} -> ${b.modelFits ? "the count less it IS the broker's figure, to the last digit" : "DOES NOT give the broker's figure"}`);
  P("\n2  THE THIRTEEN COUNTS ON FILE (RECORDED) AND THE FEE OF THEIR OWN BUYS (MODEL)   $ at the last recorded close, " + V.totals.markDay);
  P("   coin   count on file      buys  model fee        count less fee     close       $ count    $ fee  vote");
  for (const r of V.rows) P(`   ${r.coin.padEnd(5)} ${String(r.count).padStart(17)} ${String(r.buys).padStart(5)}  ${r.modelFee.padStart(14)}  ${r.modelNet.padStart(17)} ${String(r.close).padStart(9)} ${usd(r.usdCount).padStart(10)} ${usd(r.usdFee).padStart(7)}  ${r.eligible ? "on" : "OFF"}${r.pending ? "  (order pending)" : ""}`);
  P(`   ${V.totals.coinsHeld} coins held; ${usd(V.totals.usdCount)} at the last close (the state file's own 'notional' fields, priced at each coin's last fill, add to ${usd(V.totals.notionalOnFile)}); model fee of the ${V.totals.buys} buys ${usd(V.totals.usdFee)}; held with the vote off: ${V.totals.voteOffHeld.join(", ") || "none"}`);
  P("\n3  THE SAME PAPER ACCOUNT, THE OTHER SLEEVES  (their files RECORDED; the fee of each full sell MODEL)");
  P("   A sleeve that sells a coin in full sells its FILLED quantity; the account had received that less the fee; the difference comes out of the shared balance.");
  P("   coin   R231 count less fee   taken by others' full sells   left for what others still count   R231 can sell     short of its net count");
  for (const r of V.shared) P(`   ${r.coin.padEnd(5)} ${r.modelNet.padStart(19)} ${r.takenByOthers.padStart(22)} ${r.leftForOthersCount.padStart(34)} ${r.room.padStart(18)}   ${r.shortOfNet} = ${usd(r.usdShortOfNet)} (${r.shortOfNetPct}%)   [R191 bought ${r.r191.bought} sold ${r.r191.sold} holds ${r.r191.held}; mirror bought ${r.mirror.bought} sold ${r.mirror.sold} open ${r.mirror.open}]`);
  P(`   of that: the mirror's full sells (${V.totals.mirrorTickets} crypto tickets) took ${usd(V.totals.usdTakenByMirror)}, R191's full sell took ${usd(V.totals.usdTakenByR191)}, and ${usd(V.totals.usdLeftForOthersCount)} is left in the account for what R191 still counts (its count is its filled quantity too).`);
  P(`   together ${usd(V.totals.usdShortOfNet)} of R231's net counts is, on this model, not in the account for it. The largest share of a count: ${Math.max(...V.shared.map((r) => r.shortOfCountPct))}% (against the gross count on file), ${Math.max(...V.shared.map((r) => r.shortOfNetPct))}% (against the net count).`);
  P(`   recorded fills of the main account in R231's coins since 2026-09-30, orders by sender and side: ${Object.entries(V.fills).map(([k, n]) => `${k}: ${n}`).join("; ")}`);
  P("\n3b DUST: WHAT A CLOSE MAY WRITE OFF  (the counts and buys RECORDED; what is missing MODEL)");
  P("   One twentieth of the DUST BASE: the larger of the count at the close and what this book has bought of the coin since it was last flat.");
  P("   What is missing is a fixed quantity. It does not shrink when the rule trims the coin, so the base must not either.");
  P("   coin   bought on file     1/20 of it       in $   missing (model)      in $   of bought   of the count   on the count ALONE it stops being dust below");
  for (const d of V.dust) P(`   ${d.coin.padEnd(5)} ${d.bought.padStart(16)} ${d.room.padStart(15)} ${usd(d.usdRoom).padStart(9)} ${d.short.padStart(16)} ${usd(d.usdShort).padStart(8)} ${(d.shortOfBoughtPct + "%").padStart(8)} ${(d.shortOfCountPct + "%").padStart(10)}       ${d.onTheCountAloneNotDustBelow} ${d.coin} = ${usd(d.usdOnTheCountAloneNotDustBelow)}${d.sharedCoin ? "   (a coin other sleeves traded)" : ""}`);
  { const sh = V.dust.filter((d) => d.sharedCoin), worst = V.dust.reduce((a, d) => (d.shortOfBoughtPct > a.shortOfBoughtPct ? d : a));
    P(`   every coin is inside the dust base today (${V.dust.every((d) => d.isDust) ? "yes" : "NO"}); the largest share of what was bought: ${worst.shortOfBoughtPct}% (${worst.coin}). A close is asked from $200 up, so on the count alone ${sh.filter((d) => d.usdOnTheCountAloneNotDustBelow > 200).map((d) => `${d.coin} below ${usd(d.usdOnTheCountAloneNotDustBelow)}`).join(", ") || "no coin"} could have been trimmed to where its close left a count that is never written off.`); }
  P("\n4  R191 (backend/r191-crypto-trend-forward.js), READ THE SAME WAY — report only, nothing staged");
  P(`   its counts: ${Object.entries(V.r191.coins).map(([c, v]) => `${c} ${v.qty}${v.held ? " (held)" : ""}`).join(", ")}; order-rejected rows in its ledger: ${V.r191.rejected}`);
  for (const o of V.r191.orders) P(`   ${o.cid}  ${o.side} ${o.qty} @ ${o.px}${o.side === "buy" ? `   MODEL: fee ${o.modelFee}, the account received ${o.modelReceived}` : ""}`);
  for (const s of V.r191.fullSells) P(`   FULL SELL ${s.cid}: asked ${s.asked}${s.askedItsFilledQty ? " — its own FILLED buy quantity, the same defect" : ""}; MODEL: the account had received ${s.modelReceived} for that buy, so ${s.cameFromTheSharedBalance} (${usd(s.usd)}) came out of the shared balance. It filled because the account held R231's coins of the same name.`);
  P("\n5  WHAT A MARK ROW HOLDS  (RECORDED)");
  P(`   ${V.totals.marks} mark rows over ${V.totals.markDays} days; the fields of a row: ${V.markKeys.join(", ")}. No quantity, no dollars: the runner's reader (--read) computes from close, eligible, w and k alone. (The registered statistic's own sentence says "computed on realised forward fills"; whether the two differ is the registrar's to rule on.)`);
}

if (require.main === module) {
  const a = process.argv.slice(2), bad = a.filter((x) => !["--live", "--json", "--recorded"].includes(x));
  if (bad.length) { console.log("usage: node docs/r231-sell-repair/2026-10-12/evidence.cjs [--live] [--json]   (read-only)"); process.exit(2); }
  const V = evidence(load(a.includes("--live")));
  if (a.includes("--json")) console.log(JSON.stringify(V)); else print(V);
}
module.exports = { load, evidence, print, modelFee };
