// PAPER-AUCTION-FIX 2026-10-02 — patch for backend/r151-rsi2-forward.js (R151 -> R311). Operator approved 2026-10-02 ("yes").
// Measured 10-02 from the broker: Alpaca paper barely fills auction orders (R151 opg buys 0 full / 4 partial / 36 none of 40; cls buys
// 6 / 5 / 19 of 30) while DAY market orders fill 100%; and a partially filled auction order ends "expired" with filled_qty > 0, which the
// old reconcile logged as unfilled on exits (6 partial exits missed; e.g. C CRM sold 3 of 4, lot still 4). R151 is FROZEN execution-void
// and succeeded by R311 = the same rule and arms on day orders, evidence from the 2026-10-05 session, on this same runner/state/ledger.
// What the patch changes (every changed block is tagged "PAPER-AUCTION-FIX 2026-10-02"):
//   H1 header      documents the fix.
//   H2 constants   R311_START 2026-10-05; prefixFor(date) r151/r311 (ENTRY prefix); testOf(cid); lotTest(lot) (no field = R151);
//                  exitCidFor (-S, -S2, -S3; prefix = the LOT's test, so an inherited R151 lot exits under r151- even after 10-05 —
//                  review 2026-10-02: an r311- exit of an R151 lot would mix R151 exits into any by-prefix audit of R311 at the broker);
//                  TERMINAL statuses; needsOnce(s) = R151 lots exist and the one-time reconcile has not been applied.
//   H3 reconcile   applyOrder() (pure) decides from filled_qty / filled_avg_price: partial entry -> lot at filled_qty (+ partial-entry row);
//                  exit -> trade row for the filled part, remainder stays open and EXIT-OWED (exit-not-filled row when nothing filled);
//                  working orders untouched; rows carry the lot's test. orderBody() refuses any tif but "day"; sell() is the one exit
//                  path (lot's CURRENT qty, fresh client_order_id, owed until done).
//   H4 close-arm   refuses while needsOnce; owed A exits first; A entries/exits = DAY MARKET (was cls); entries carry today's prefix.
//                  Stops sending once ET is past close-5 min (review 2026-10-02): the window is checked once at the start and the bars /
//                  latest-trade fetches can retry for up to ~30 s each, and a DAY order submitted after 16:00 ET is queued by Alpaca for the
//                  NEXT open — an arm-A trade would silently become a next-open trade still labelled A (the old cls orders failed closed).
//   H5 after-close owed B/C exits queued whatever the signal; B entries/exits and C exits = day market (was opg); C entry day limit.
//   H6 pre-open    refuses while needsOnce; every queued order RE-MINTED at send (day, the entry prefix of today, sell = lot's current qty
//                  under its own test's prefix), so a queue built tonight by the pre-fix runner (opg, r151-) goes out as day orders —
//                  entries as R311, exits of R151 lots as r151-; owed B/C lots not in the queue sent. Stops sending at 09:30 ET (the same
//                  guard for the open: a day market order sent after the bell is an intraday fill, not an open fill, still labelled B).
//   H7 status      per test (R151 / R311), counts reconcile-correction add-trade rows, owed lots, partial entries, one-time flag.
//   H8 selftest    11 new in-memory known-answer checks (applyOrder, cids, prefixes, day-only bodies, the refusal gate).
// INPUT PINNED (review 2026-10-02): the live file must hash to LIVE_SHA256 — the exact-match regions alone did not notice an edit outside
// them, and copying a stored pending file would silently revert any live edit made after the review. At deploy, RE-RUN this patch
// (it re-checks the hash) and copy its fresh output; never copy an old pending file.
// Usage: node docs/paper-auction-fix/2026-10-02/patch-r151-rsi2-forward.cjs [<backend dir>] [<out file>]
//        default out: backend/r151-rsi2-forward.pending-auctionfix.js — never the live file.
const fs = require("fs"), path = require("path");
const BK = process.argv[2] || path.resolve(__dirname, "../../../backend");
const SRC = path.join(BK, "r151-rsi2-forward.js"), OUTF = process.argv[3] || path.join(BK, "r151-rsi2-forward.pending-auctionfix.js");
if (path.resolve(OUTF) === path.resolve(SRC) || !/\.pending-auctionfix\.js$/.test(OUTF)) throw new Error("refusing: the output must be a separate *.pending-auctionfix.js file, never the live runner");
let s = fs.readFileSync(SRC, "utf8");
const LIVE_SHA256 = "96c6fe41db2ec800d5976d5c6f543ff91c541c3bef5b31eaf5a41374da789d5e";   // backend/r151-rsi2-forward.js as reviewed 2026-10-02 (18,795 bytes, unchanged since 2026-09-23)
const gotSha = require("crypto").createHash("sha256").update(s).digest("hex");
if (gotSha !== LIVE_SHA256) throw new Error(`live runner changed since the 2026-10-02 review (sha256 ${gotSha.slice(0, 12)}… != ${LIVE_SHA256.slice(0, 12)}…) — re-review before patching`);
const rep =(a, b, tag) => { const n = s.split(a).length - 1; if (n !== 1) throw new Error(`${tag}: expected 1 match, found ${n}`); s = s.replace(a, () => b); };
rep(` *
 * GUARDS (fail closed): paper endpoint only · OFF switch data/r151-OFF · --live required to place anything · at most 60 orders a run ·
`,
` *
 * PAPER-AUCTION-FIX 2026-10-02 — R151 FROZEN (execution-void), succeeded by R311 on this same runner, state file and ledger.
 *   Measured 10-02 from the broker: Alpaca paper barely fills auction orders (R151 market-on-open buys 0 full / 4 partial / 36 none of
 *   40; market-on-close buys 6 / 5 / 19 of 30), while plain DAY market orders filled 100% on all three paper accounts. A partially filled
 *   auction order ends "expired" with filled_qty > 0, and the old reconcile read exits by status alone (C CRM sold 3 of 4, lot still 4).
 *   From here every order is a DAY order — no opg/cls order is ever sent:
 *     A  day MARKET entries/exits sent in the close-arm window (was cls)     B  day MARKET entries/exits queued pre-open (was opg)
 *     C  entry = DAY limit at the signal close (unchanged); exit = day MARKET queued pre-open (was opg)
 *   Reconcile reads filled_qty / filled_avg_price, never status alone: a terminal order with filled_qty > 0 is a (partial) fill. A partial
 *   entry opens the lot at filled_qty; an exit that does not complete leaves remaining = qty - filled_qty (the filled part is its own
 *   trade row) and the lot is EXIT-OWED — the remainder is re-sent at the arm's next order window whatever that day's signal says, under
 *   a fresh client_order_id (-S2, -S3 ...). Orders still working (new/accepted/pending_new/partially_filled ...) are re-checked next run.
 *   Every ENTRY sent from the 2026-10-05 session on carries the prefix "r311-". A lot belongs to the test its ENTRY order's prefix names
 *   (r311- = R311; r151- or no test field = R151) and every ledger row it produces carries that test; its EXIT orders carry the same
 *   test's prefix (an inherited R151 lot still exits as r151-...-S, -S2 after 10-05), so the broker's r311- orders are R311's alone.
 *   R151 lots are still managed to their rule exits with the day orders above. Order-sending modes refuse while R151 lots exist that
 *   docs/paper-auction-fix/2026-10-02/r151-reconcile-once.cjs --apply has not yet rebuilt from the broker's fills. The close-arm stops
 *   sending past close-5 min and the pre-open at 09:30 ET: a late day order would trade at the wrong moment under the arm's label.
 *
 * GUARDS (fail closed): paper endpoint only · OFF switch data/r151-OFF · --live required to place anything · at most 60 orders a run ·
`, "H1 header");
rep(`const mode = ["--close-arm", "--after-close", "--pre-open", "--status", "--read", "--selftest", "--preview"].find((m) => process.argv.includes(m)) || "--status";
`,
`const mode = ["--close-arm", "--after-close", "--pre-open", "--status", "--read", "--selftest", "--preview"].find((m) => process.argv.includes(m)) || "--status";
// PAPER-AUCTION-FIX 2026-10-02 — R311 succession, day orders only, reconcile by filled quantity ─────────────────────────────────────
const R311_START = "2026-10-05";                                                            // PAPER-AUCTION-FIX 2026-10-02: first R311 session
const prefixFor = (date) => (date >= R311_START ? "r311" : "r151");                         // PAPER-AUCTION-FIX 2026-10-02: prefix of an order SENT on \`date\`
const testOf = (cid) => (/^r311-/.test(cid || "") ? "R311" : "R151");                       // PAPER-AUCTION-FIX 2026-10-02: the entry order's prefix names the test
const lotTest = (l) => l.test || testOf(l.entryCid);                                        // PAPER-AUCTION-FIX 2026-10-02: no test field = R151
const exitCidFor = (l, date) => \`\${lotTest(l) === "R311" ? "r311" : "r151"}-\${l.arm}-\${l.sym}-\${ymd(date)}-S\${(l.exitSeq || 0) > 0 ? l.exitSeq + 1 : ""}\`;   // PAPER-AUCTION-FIX 2026-10-02: the LOT's test names the prefix (an R151 lot exits r151- after 10-05 too); -S, then -S2, -S3 ... (Alpaca refuses a reused client_order_id)
const TERMINAL = ["filled", "canceled", "expired", "rejected", "done_for_day", "not_found"];  // PAPER-AUCTION-FIX 2026-10-02: any other status is still working
const ONCE = "docs/paper-auction-fix/2026-10-02/r151-reconcile-once.cjs";                    // PAPER-AUCTION-FIX 2026-10-02
const needsOnce = (s) => s.lots.some((l) => lotTest(l) === "R151") && !(s.auctionFix && s.auctionFix.reconciledAt);   // PAPER-AUCTION-FIX 2026-10-02: R151 lots not yet rebuilt from fills
`, "H2 constants");
rep(`async function reconcile(s) {                                          // the broker's fills decide every lot
  for (const l of [...s.lots]) {
    const cid = l.status === "exiting" ? l.exitCid : l.status === "pending" ? l.entryCid : null; if (!cid) continue;
    let o; try { o = await api(\`/v2/orders:by_client_order_id?client_order_id=\${encodeURIComponent(cid)}\`); } catch (e) { if (e.status === 404) o = { status: "not_found" }; else continue; }
    const filled = Number(o.filled_qty) || 0, px = Number(o.filled_avg_price) || null, done = ["filled", "canceled", "expired", "rejected", "not_found", "done_for_day"].includes(o.status);
    if (l.status === "pending") {
      if (o.status === "filled" || (done && filled > 0)) { l.status = "open"; l.qty = filled; l.entryFill = px; l.entryOrderId = o.id; l.entryFilledAt = o.filled_at; }
      else if (done) { s.lots = s.lots.filter((x) => x !== l); ledger({ kind: "unfilled-entry", arm: l.arm, sym: l.sym, signalDate: l.signalDate, cid, brokerStatus: o.status, limit: l.limit ?? null }); }
    } else if (l.status === "exiting") {
      if (o.status === "filled") { s.lots = s.lots.filter((x) => x !== l); ledger({ kind: "trade", arm: l.arm, sym: l.sym, qty: l.qty, signalDate: l.signalDate, entryDate: (l.entryFilledAt || "").slice(0, 10), exitDate: (o.filled_at || "").slice(0, 10), entryFill: l.entryFill, exitFill: px, ret: +(px / l.entryFill - 1).toFixed(6), entryCid: l.entryCid, exitCid: cid }); }
      else if (done) { l.status = "open"; l.exitCid = null; ledger({ kind: "exit-not-filled", arm: l.arm, sym: l.sym, cid, brokerStatus: o.status }); }
    }
  }
}
async function submit(s, order, sent) {
  if (sent.n >= MAX_ORDERS) { console.log(\`  cap \${MAX_ORDERS} reached — \${order.cid} not sent\`); return false; }
  if (!LIVE) { console.log(\`  DRY \${order.cid} \${order.side} \${order.qty} \${order.tif}\${order.limit ? " @" + order.limit : ""}\`); return false; }
  const body = { symbol: order.sym, qty: String(order.qty), side: order.side, type: order.limit ? "limit" : "market", time_in_force: order.tif, client_order_id: order.cid, ...(order.limit ? { limit_price: String(order.limit) } : {}) };
  try { await api("/v2/orders", { method: "POST", body: JSON.stringify(body) }); sent.n++; console.log(\`  sent \${order.cid} \${order.side} \${order.qty} \${order.tif}\${order.limit ? " @" + order.limit : ""}\`); return true; }
  catch (e) { console.log(\`  REJECTED \${order.cid}: \${e.message}\`); ledger({ kind: "order-rejected", cid: order.cid, arm: order.arm, sym: order.sym, side: order.side, error: e.message.slice(0, 160) }); return false; }
`,
`// PAPER-AUCTION-FIX 2026-10-02: the broker's filled_qty / filled_avg_price decide every lot, never the status alone. PURE — it mutates the
// state in memory and RETURNS the ledger rows; reconcile() appends them. A terminal order (filled/expired/canceled/done_for_day/...) with
// filled_qty > 0 is a fill of that quantity; anything still working is left alone for the next run.
function applyOrder(s, l, o, cid) {
  if (!TERMINAL.includes(o.status)) return [];                                              // still working — re-checked next run
  const filled = Number(o.filled_qty) || 0, px = Number(o.filled_avg_price) || null, test = lotTest(l), at = o.filled_at || o.updated_at || null;
  if (filled > 0 && !px) return [];                                                         // a fill without a price: never guess — re-check next run
  if (l.status === "pending") {
    if (filled > 0) { const ordered = Number(o.qty) || l.qty;                               // full OR partial entry: the lot is what the broker filled
      Object.assign(l, { status: "open", qty: filled, entryFill: px, entryOrderId: o.id, entryFilledAt: at, test });
      return filled < ordered ? [{ kind: "partial-entry", test, arm: l.arm, sym: l.sym, cid, ordered, filled, brokerStatus: o.status }] : []; }
    s.lots = s.lots.filter((x) => x !== l);
    return [{ kind: "unfilled-entry", test, arm: l.arm, sym: l.sym, signalDate: l.signalDate, cid, brokerStatus: o.status, limit: l.limit ?? null }];
  }
  if (l.status !== "exiting") return [];
  const sold = Math.min(filled, l.qty), rows = [];
  if (filled > l.qty) rows.push({ kind: "oversold-exit", test, arm: l.arm, sym: l.sym, cid, lotQty: l.qty, filled });   // the account sold more than this lot held — loud
  if (sold > 0) rows.push({ kind: "trade", test, arm: l.arm, sym: l.sym, qty: sold, signalDate: l.signalDate, entryDate: (l.entryFilledAt || "").slice(0, 10), exitDate: (at || "").slice(0, 10), entryFill: l.entryFill, exitFill: px, ret: +(px / l.entryFill - 1).toFixed(6), entryCid: l.entryCid, exitCid: cid, ...(sold < l.qty ? { partialExit: true, remainingQty: l.qty - sold } : {}) });
  if (sold >= l.qty) { s.lots = s.lots.filter((x) => x !== l); return rows; }
  if (!sold) rows.push({ kind: "exit-not-filled", test, arm: l.arm, sym: l.sym, cid, brokerStatus: o.status, remainingQty: l.qty });
  Object.assign(l, { qty: l.qty - sold, status: "open", exitCid: null, exitOwed: true, test });   // the remainder is owed: re-sent at the arm's next window
  return rows;
}
async function reconcile(s) {                                          // the broker's fills decide every lot — PAPER-AUCTION-FIX 2026-10-02: by filled quantity
  for (const l of [...s.lots]) {
    const cid = l.status === "exiting" ? l.exitCid : l.status === "pending" ? l.entryCid : null; if (!cid) continue;
    let o; try { o = await api(\`/v2/orders:by_client_order_id?client_order_id=\${encodeURIComponent(cid)}\`); } catch (e) { if (e.status === 404) o = { status: "not_found" }; else continue; }
    for (const row of applyOrder(s, l, o, cid)) ledger(row);
  }
}
// PAPER-AUCTION-FIX 2026-10-02: the order body is built in one place and refuses anything but a DAY order (no opg/cls auction order again)
const orderBody = (order) => order.tif !== "day" ? null : { symbol: order.sym, qty: String(order.qty), side: order.side, type: order.limit ? "limit" : "market", time_in_force: "day", client_order_id: order.cid, ...(order.limit ? { limit_price: String(order.limit) } : {}) };
async function submit(s, order, sent) {
  const body = orderBody(order); if (!body) { console.log(\`  REFUSED \${order.cid}: time_in_force \${order.tif} — day orders only (PAPER-AUCTION-FIX 2026-10-02)\`); return false; }
  if (sent.n >= MAX_ORDERS) { console.log(\`  cap \${MAX_ORDERS} reached — \${order.cid} not sent\`); return false; }
  if (!LIVE) { console.log(\`  DRY \${order.cid} \${order.side} \${order.qty} \${body.type} day\${order.limit ? " @" + order.limit : ""}\`); return false; }
  try { await api("/v2/orders", { method: "POST", body: JSON.stringify(body) }); sent.n++; console.log(\`  sent \${order.cid} \${order.side} \${order.qty} \${body.type} day\${order.limit ? " @" + order.limit : ""}\`); return true; }
  catch (e) { console.log(\`  REJECTED \${order.cid}: \${e.message}\`); order.rejected = true; ledger({ kind: "order-rejected", test: order.test || testOf(order.cid), cid: order.cid, arm: order.arm, sym: order.sym, side: order.side, error: e.message.slice(0, 160) }); return false; }
}
// PAPER-AUCTION-FIX 2026-10-02: one exit path for every arm — a day market sell of the lot's CURRENT quantity under a fresh client_order_id.
// Sending marks the lot exiting AND owed; a broker refusal leaves it owed, so the next window re-sends it whatever the signal says.
async function sell(s, lot, date, sent) {
  const cid = exitCidFor(lot, date), o = { arm: lot.arm, sym: lot.sym, side: "sell", qty: lot.qty, tif: "day", cid, test: lotTest(lot) };
  if (await submit(s, o, sent)) { Object.assign(lot, { status: "exiting", exitCid: cid, exitSeq: (lot.exitSeq || 0) + 1, exitOwed: true }); return true; }
  if (o.rejected) lot.exitOwed = true; return false;
`, "H3 reconcile-submit-sell");
rep(`  await reconcile(s);
  const syms = universe(), hist = await dailyCloses(syms, new Date(Date.now() - 16 * 60e3).toISOString());
  const lt = {}; for (let i = 0; i < syms.length; i += 100) { const j = await fetch(\`\${DATA}/v2/stocks/trades/latest?symbols=\${syms.slice(i, i + 100).join(",")}&feed=iex\`, { headers: H }).then((r) => r.json()).catch(() => ({})); Object.assign(lt, j.trades || {}); }
  const sent = { n: 0 }, day = ymd(now.date);
  for (const sym of syms) {
    const h = (hist[sym] || []).filter((x) => x.d < now.date).map((x) => x.c), px = lt[sym] && lt[sym].p; if (!px || h.length < 209) continue;
    const st = rsi2State([...h, px]); if (!st) continue;
    const lot = s.lots.find((l) => l.arm === "A" && l.sym === sym);
    if (lot && lot.status === "open" && st.exit) { const cid = \`r151-A-\${sym}-\${day}-S\`; if (await submit(s, { arm: "A", sym, side: "sell", qty: lot.qty, tif: "cls", cid }, sent)) { lot.status = "exiting"; lot.exitCid = cid; } }
    else if (!lot && st.entry) { const q = qtyFor(px); if (!q) continue; const cid = \`r151-A-\${sym}-\${day}-B\`;
      if (await submit(s, { arm: "A", sym, side: "buy", qty: q, tif: "cls", cid }, sent)) s.lots.push({ arm: "A", sym, qty: q, status: "pending", entryCid: cid, signalDate: now.date, proxy: px, signal: st }); }
`,
`  if (needsOnce(s)) return console.log(\`r151 close-arm: REFUSING — R151 lots not yet rebuilt from broker fills; run node \${ONCE} --apply first (PAPER-AUCTION-FIX 2026-10-02)\`);
  await reconcile(s);
  const syms = universe(), hist = await dailyCloses(syms, new Date(Date.now() - 16 * 60e3).toISOString());
  const lt = {}; for (let i = 0; i < syms.length; i += 100) { const j = await fetch(\`\${DATA}/v2/stocks/trades/latest?symbols=\${syms.slice(i, i + 100).join(",")}&feed=iex\`, { headers: H }).then((r) => r.json()).catch(() => ({})); Object.assign(lt, j.trades || {}); }
  const sent = { n: 0 }, day = ymd(now.date), pfx = prefixFor(now.date);                  // PAPER-AUCTION-FIX 2026-10-02: today's entry prefix (r311- from 10-05)
  const late = () => etNow().mins > sess.closeMins - 5;   // PAPER-AUCTION-FIX 2026-10-02: a DAY order sent after the close queues for the NEXT open — that is arm B, not A
  for (const lot of s.lots.filter((l) => l.arm === "A" && l.status === "open" && l.exitOwed)) { if (late()) break; await sell(s, lot, now.date, sent); }   // PAPER-AUCTION-FIX 2026-10-02: owed exits first, signal or not
  for (const sym of syms) {
    if (late()) { console.log(\`r151 close-arm: past close-5 min (ET \${Math.floor(etNow().mins / 60)}:\${String(etNow().mins % 60).padStart(2, "0")}) — stopping; nothing more sent today\`); break; }   // PAPER-AUCTION-FIX 2026-10-02
    const h = (hist[sym] || []).filter((x) => x.d < now.date).map((x) => x.c), px = lt[sym] && lt[sym].p; if (!px || h.length < 209) continue;
    const st = rsi2State([...h, px]); if (!st) continue;
    const lot = s.lots.find((l) => l.arm === "A" && l.sym === sym);
    if (lot && lot.status === "open" && !lot.exitOwed && st.exit) await sell(s, lot, now.date, sent);   // PAPER-AUCTION-FIX 2026-10-02: day market (was cls)
    else if (!lot && st.entry) { const q = qtyFor(px); if (!q) continue; const cid = \`\${pfx}-A-\${sym}-\${day}-B\`;   // PAPER-AUCTION-FIX 2026-10-02: day market (was cls)
      if (await submit(s, { arm: "A", sym, side: "buy", qty: q, tif: "day", cid, test: testOf(cid) }, sent)) s.lots.push({ arm: "A", sym, qty: q, status: "pending", entryCid: cid, test: testOf(cid), signalDate: now.date, proxy: px, signal: st }); }
`, "H4 close-arm");
rep(`  for (const sym of syms) {
    const h = hist[sym] || []; if (!h.length || h[h.length - 1].d !== now.date) continue;      // today's official bar must be present
    const st = rsi2State(h.map((x) => x.c)); if (!st) continue;
    for (const arm of ["B", "C"]) {
      const lot = s.lots.find((l) => l.arm === arm && l.sym === sym);
      if (lot && lot.status === "open" && st.exit) orders.push({ arm, sym, side: "sell", qty: lot.qty, tif: "opg", cid: \`r151-\${arm}-\${sym}-\${ymd(next)}-S\` });
      else if (!lot && st.entry) { const q = qtyFor(st.c); if (!q) continue;
        orders.push({ arm, sym, side: "buy", qty: q, tif: arm === "B" ? "opg" : "day", ...(arm === "C" ? { limit: +st.c.toFixed(2) } : {}), cid: \`r151-\${arm}-\${sym}-\${ymd(next)}-B\`, signalDate: now.date, signal: st }); }
`,
`  const pfx = prefixFor(next);                                                               // PAPER-AUCTION-FIX 2026-10-02: tomorrow's orders carry tomorrow's prefix
  for (const lot of s.lots.filter((l) => l.arm !== "A" && l.status === "open" && l.exitOwed)) orders.push({ arm: lot.arm, sym: lot.sym, side: "sell", qty: lot.qty, tif: "day", cid: exitCidFor(lot, next), owed: true });   // PAPER-AUCTION-FIX 2026-10-02: owed B/C exits, signal or not
  for (const sym of syms) {
    const h = hist[sym] || []; if (!h.length || h[h.length - 1].d !== now.date) continue;      // today's official bar must be present
    const st = rsi2State(h.map((x) => x.c)); if (!st) continue;
    for (const arm of ["B", "C"]) {
      const lot = s.lots.find((l) => l.arm === arm && l.sym === sym);
      if (lot && lot.status === "open" && !lot.exitOwed && st.exit) orders.push({ arm, sym, side: "sell", qty: lot.qty, tif: "day", cid: exitCidFor(lot, next) });   // PAPER-AUCTION-FIX 2026-10-02: day market queued pre-open (was opg); pre-open re-mints the cid at send
      else if (!lot && st.entry) { const q = qtyFor(st.c); if (!q) continue;
        orders.push({ arm, sym, side: "buy", qty: q, tif: "day", ...(arm === "C" ? { limit: +st.c.toFixed(2) } : {}), cid: \`\${pfx}-\${arm}-\${sym}-\${ymd(next)}-B\`, signalDate: now.date, signal: st }); }   // PAPER-AUCTION-FIX 2026-10-02: B day market (was opg), C day limit (unchanged)
`, "H5 after-close");
rep(`  if (s.queue.date !== now.date) return console.log(\`r151 pre-open: queue is for \${s.queue.date || "nothing"} — nothing to send\`);
  await reconcile(s); const sent = { n: 0 };
  for (const o of s.queue.orders) {
    const lot = s.lots.find((l) => l.arm === o.arm && l.sym === o.sym);
    if (o.side === "sell") { if (!lot || lot.status !== "open") continue; if (await submit(s, o, sent)) { lot.status = "exiting"; lot.exitCid = o.cid; } }
    else { if (lot) continue; if (await submit(s, o, sent)) s.lots.push({ arm: o.arm, sym: o.sym, qty: o.qty, status: "pending", entryCid: o.cid, signalDate: o.signalDate, limit: o.limit ?? null, signal: o.signal }); }
  }
`,
`  if (needsOnce(s)) return console.log(\`r151 pre-open: REFUSING — R151 lots not yet rebuilt from broker fills; run node \${ONCE} --apply first (PAPER-AUCTION-FIX 2026-10-02)\`);
  if (s.queue.date !== now.date) return console.log(\`r151 pre-open: queue is for \${s.queue.date || "nothing"} — nothing to send\`);
  await reconcile(s); const sent = { n: 0 }, pfx = prefixFor(now.date), day = ymd(now.date), tried = new Set();
  const late = () => etNow().mins >= 9 * 60 + 30;   // PAPER-AUCTION-FIX 2026-10-02: after the bell a day market order is an intraday fill, not the open — stop
  // PAPER-AUCTION-FIX 2026-10-02: every queued order is RE-MINTED at send — day orders, today's entry prefix, exits under their lot's
  // test — so a queue built by the pre-fix runner (opg, r151-) goes out as day orders; a sell always takes the lot's CURRENT quantity.
  for (const o of s.queue.orders) {
    if (late()) { console.log("r151 pre-open: 09:30 ET reached — stopping; the rest is not sent today"); break; }   // PAPER-AUCTION-FIX 2026-10-02
    const lot = s.lots.find((l) => l.arm === o.arm && l.sym === o.sym);
    if (o.side === "sell") { if (!lot || lot.status !== "open" || tried.has(lot)) continue; tried.add(lot); await sell(s, lot, now.date, sent); }
    else { if (lot) continue; const cid = \`\${pfx}-\${o.arm}-\${o.sym}-\${day}-B\`, limit = o.arm === "C" && o.limit ? o.limit : null;
      if (await submit(s, { arm: o.arm, sym: o.sym, side: "buy", qty: o.qty, tif: "day", ...(limit ? { limit } : {}), cid, test: testOf(cid) }, sent)) s.lots.push({ arm: o.arm, sym: o.sym, qty: o.qty, status: "pending", entryCid: cid, test: testOf(cid), signalDate: o.signalDate, limit, signal: o.signal }); }
  }
  for (const lot of s.lots.filter((l) => l.arm !== "A" && l.status === "open" && l.exitOwed && !tried.has(l))) { if (late()) break; tried.add(lot); await sell(s, lot, now.date, sent); }   // PAPER-AUCTION-FIX 2026-10-02: owed B/C exits a pre-fix queue did not carry
`, "H6 pre-open");
rep(`function status() {
  const s = load(), rows = readLedger(), tr = rows.filter((r) => r.kind === "trade");
  const by = (arm) => { const t = tr.filter((r) => r.arm === arm); return { closed: t.length, meanRetPct: t.length ? +(100 * t.reduce((a, r) => a + r.ret, 0) / t.length).toFixed(3) : null, open: s.lots.filter((l) => l.arm === arm && l.status === "open").length, pending: s.lots.filter((l) => l.arm === arm && l.status !== "open").length }; };
  console.log(\`r151 status — A \${JSON.stringify(by("A"))} · B \${JSON.stringify(by("B"))} · C \${JSON.stringify(by("C"))} · unfilled C entries \${rows.filter((r) => r.kind === "unfilled-entry" && r.arm === "C").length} · rejects \${rows.filter((r) => r.kind === "order-rejected").length} · queue \${s.queue.orders.length} for \${s.queue.date}\`);
`,
`function status() {                                                   // PAPER-AUCTION-FIX 2026-10-02: per test; reconcile-correction add-trade rows count as trade parts
  const s = load(), rows = readLedger(), rowTest = (r) => r.test || testOf(r.entryCid || r.cid);
  const isPart = (r) => r.kind === "trade" || (r.kind === "reconcile-correction" && r.action === "add-trade");
  for (const test of ["R151", "R311"]) {
    const tr = rows.filter((r) => isPart(r) && rowTest(r) === test), lots = s.lots.filter((l) => lotTest(l) === test), mine = rows.filter((r) => rowTest(r) === test);
    const by = (arm) => { const t = tr.filter((r) => r.arm === arm); return { closedParts: t.length, meanRetPct: t.length ? +(100 * t.reduce((a, r) => a + r.ret, 0) / t.length).toFixed(3) : null, open: lots.filter((l) => l.arm === arm && l.status === "open").length, owed: lots.filter((l) => l.arm === arm && l.status === "open" && l.exitOwed).length, pending: lots.filter((l) => l.arm === arm && l.status !== "open").length }; };
    console.log(\`\${test} status — A \${JSON.stringify(by("A"))} · B \${JSON.stringify(by("B"))} · C \${JSON.stringify(by("C"))} · unfilled C entries \${mine.filter((r) => r.kind === "unfilled-entry" && r.arm === "C").length} · partial entries \${mine.filter((r) => r.kind === "partial-entry").length} · rejects \${mine.filter((r) => r.kind === "order-rejected").length}\`);
  }
  console.log(\`queue \${s.queue.orders.length} for \${s.queue.date} · one-time reconcile \${(s.auctionFix && s.auctionFix.reconciledAt) || "NOT RUN"}\`);
`, "H7 status");
rep(`    clientIdIsDeterministic: \`r151-A-SPY-\${ymd("2026-09-24")}-B\` === "r151-A-SPY-20260924-B", qtyNeverAboveFiveThousand: qtyFor(6000) === 0 && qtyFor(100) === 10 };
`,
`    clientIdIsDeterministic: \`r151-A-SPY-\${ymd("2026-09-24")}-B\` === "r151-A-SPY-20260924-B", qtyNeverAboveFiveThousand: qtyFor(6000) === 0 && qtyFor(100) === 10 };
  // PAPER-AUCTION-FIX 2026-10-02 known answers — in memory only (applyOrder is pure; nothing is written)
  const pe = { lots: [{ arm: "B", sym: "X", qty: 10, status: "pending", entryCid: "r311-B-X-20261005-B" }] }, peRows = applyOrder(pe, pe.lots[0], { status: "expired", qty: "10", filled_qty: "4", filled_avg_price: "50", filled_at: "2026-10-05T13:30:01Z", id: "o1" }, "r311-B-X-20261005-B");
  const xl = { arm: "C", sym: "Y", qty: 4, status: "exiting", entryCid: "r151-C-Y-20260929-B", entryFill: 100, entryFilledAt: "2026-09-29T13:31:00Z", exitCid: "r311-C-Y-20261005-S", exitSeq: 1 }, px = { lots: [xl] };
  const pxRows = applyOrder(px, xl, { status: "expired", qty: "4", filled_qty: "3", filled_avg_price: "110", filled_at: "2026-10-05T13:30:05Z" }, xl.exitCid);
  const xl2 = { ...xl, qty: 1, status: "exiting", exitCid: "r311-C-Y-20261006-S2", exitSeq: 2 }, fx = { lots: [xl2] }, fxRows = applyOrder(fx, xl2, { status: "filled", qty: "1", filled_qty: "1", filled_avg_price: "112", filled_at: "2026-10-06T13:30:02Z" }, xl2.exitCid);
  const zl = { arm: "A", sym: "Z", qty: 5, status: "exiting", entryCid: "r311-A-Z-20261005-B", entryFill: 20, entryFilledAt: "2026-10-05T19:41:00Z", exitCid: "r311-A-Z-20261006-S" }, zx = { lots: [zl] }, zxRows = applyOrder(zx, zl, { status: "expired", qty: "5", filled_qty: "0", filled_avg_price: null }, zl.exitCid);
  const wl = { arm: "A", sym: "W", qty: 3, status: "exiting", entryCid: "r311-A-W-20261005-B", entryFill: 20, exitCid: "r311-A-W-20261006-S" }, wx = { lots: [wl] }, wxRows = applyOrder(wx, wl, { status: "partially_filled", qty: "3", filled_qty: "2", filled_avg_price: "21" }, wl.exitCid);
  const ul = { arm: "C", sym: "U", qty: 7, status: "pending", entryCid: "r311-C-U-20261005-B", limit: 9.5 }, ux = { lots: [ul] }, uxRows = applyOrder(ux, ul, { status: "expired", qty: "7", filled_qty: "0" }, ul.entryCid);
  Object.assign(checks, {
    partialEntryOpensAtFilledQty: pe.lots[0].status === "open" && pe.lots[0].qty === 4 && pe.lots[0].entryFill === 50 && pe.lots[0].test === "R311" && peRows.length === 1 && peRows[0].kind === "partial-entry",
    partialExitRecordsFilledPartAndOwesRemainder: px.lots.length === 1 && xl.qty === 1 && xl.status === "open" && xl.exitOwed === true && xl.exitCid === null && pxRows.length === 1 && pxRows[0].kind === "trade" && pxRows[0].qty === 3 && pxRows[0].test === "R151" && pxRows[0].remainingQty === 1 && pxRows[0].ret === 0.1,
    remainderIsResentUnderANewClientOrderId: exitCidFor(xl, "2026-10-06") === "r151-C-Y-20261006-S2" && exitCidFor({ arm: "A", sym: "Q" }, "2026-10-02") === "r151-A-Q-20261002-S",
    exitPrefixFollowsTheLotsTest: exitCidFor({ arm: "B", sym: "Q", entryCid: "r151-B-Q-20260930-B" }, "2026-10-07") === "r151-B-Q-20261007-S" && exitCidFor({ arm: "B", sym: "Q", entryCid: "r311-B-Q-20261006-B", test: "R311", exitSeq: 2 }, "2026-10-08") === "r311-B-Q-20261008-S3",
    fullExitClosesTheLot: fx.lots.length === 0 && fxRows.length === 1 && fxRows[0].qty === 1 && fxRows[0].exitFill === 112 && !fxRows[0].partialExit,
    unfilledExitIsOwedNotForgotten: zx.lots.length === 1 && zl.status === "open" && zl.exitOwed === true && zl.qty === 5 && zxRows.length === 1 && zxRows[0].kind === "exit-not-filled",
    workingOrderIsLeftAlone: wxRows.length === 0 && wl.status === "exiting" && wl.qty === 3,
    unfilledEntryDropsTheLot: ux.lots.length === 0 && uxRows.length === 1 && uxRows[0].kind === "unfilled-entry" && uxRows[0].test === "R311",
    r311PrefixFromTheFifth: prefixFor("2026-10-02") === "r151" && prefixFor("2026-10-05") === "r311" && testOf("r311-A-X-20261005-B") === "R311" && lotTest({ entryCid: "r151-A-X-20260924-B" }) === "R151",
    dayOrdersOnly: orderBody({ sym: "X", qty: 1, side: "buy", tif: "opg", cid: "c" }) === null && orderBody({ sym: "X", qty: 1, side: "sell", tif: "cls", cid: "c" }) === null && orderBody({ sym: "X", qty: 2, side: "buy", tif: "day", cid: "c" }).type === "market" && orderBody({ sym: "X", qty: 2, side: "buy", tif: "day", limit: 9.5, cid: "c" }).type === "limit",
    sendingRefusedUntilR151LotsRebuilt: needsOnce({ lots: [{ entryCid: "r151-C-Y-20260929-B" }] }) && !needsOnce({ lots: [{ entryCid: "r151-C-Y-20260929-B" }], auctionFix: { reconciledAt: "x" } }) && !needsOnce({ lots: [{ entryCid: "r311-C-Y-20261005-B" }] }) });
`, "H8 selftest");
fs.writeFileSync(OUTF, s); console.log("written", OUTF, s.length, "bytes");
