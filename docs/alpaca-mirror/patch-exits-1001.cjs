// 2026-10-01 (operator: "fix") — the Alpaca mirror follows the board OUT, not only in.
// Before: each mirrored entry kept its GTC bracket (or, for crypto, nothing) until a leg filled, while the board closes most tickets within
// hours (ratchet, time). On 10-01 all 65 mirrored tickets were closed on the board, the main paper account carried $221k of positions on
// $102k equity with $0 Reg-T buying power, and 11 of 13 new tickets were refused for buying power.
// After: every run first closes, at market, the OWN quantity of each mirrored ticket that the trade log shows closed (bracket legs cancelled
// first); never a whole symbol (the account is shared). The nightly reconcile reads those exit orders as the broker exit.
// Usage: node docs/alpaca-mirror/patch-exits-1001.cjs <backend dir> <out mirror> <out reconcile>
const fs = require("fs"), path = require("path");
const [BK, OUTM, OUTR] = process.argv.slice(2); if (!BK || !OUTM || !OUTR) throw new Error("usage: <backend dir> <out mirror> <out reconcile>");
let m = fs.readFileSync(path.join(BK, "alpaca-mirror.js"), "utf8"), r = fs.readFileSync(path.join(BK, "alpaca-reconcile.js"), "utf8");
const rep = (src, a, b, tag) => { const n = src.split(a).length - 1; if (n !== 1) throw new Error(`${tag}: expected 1 match, found ${n}`); return src.replace(a, () => b); };

m = rep(m, ` *   node backend/alpaca-mirror.js            dry run
 *   node backend/alpaca-mirror.js --live     place the orders`,
` * EXITS (2026-10-01, operator "fix"). Each run FIRST follows the board out: a mirrored ticket that the trade log shows CLOSED and that is
 * still open at the broker has its bracket legs cancelled and its OWN quantity closed at market (client id mx-<ticket>; once per ticket;
 * data/alpaca-mirror-exits.jsonl). Never a whole symbol — the main paper account is shared with other strategies. Fail-closed: a ticket in
 * neither the board nor the trade log is left for the operator; equity exits only while the market is open. Why: the board closes most
 * tickets within hours, the bracket legs did not, and by 10-01 the account held $221k of stale positions with no buying power left.
 *
 *   node backend/alpaca-mirror.js               dry run (exits + entries)
 *   node backend/alpaca-mirror.js --live        place the orders
 *   node backend/alpaca-mirror.js --exits-only  [--live]  only the exit pass`, "header");

m = rep(m, `const r2 = (x) => Math.round(x * 100) / 100;
`, `const r2 = (x) => Math.round(x * 100) / 100;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const EXITS = D("alpaca-mirror-exits.jsonl"), MAX_EXITS_PER_RUN = 100, TERM = ["filled", "canceled", "expired", "rejected", "replaced"];
// the main paper account is shared and busy (200 req/min across every runner): pace the exit pass and retry 429s (a 429 is never an accepted order)
const apiR = async (p, init) => { for (let i = 0; ; i++) { try { return await api(p, init); } catch (e) { if (!/^429/.test(e.message) || i >= 5) throw e; await sleep(1500 * 2 ** i); } } };
const legFilled = (o) => (o.legs || []).reduce((s, l) => s + (Number(l.filled_qty) || 0), 0);
async function exitPhase(clock, logRows) {   // 2026-10-01: the broker follows the board out (see the header)
  const prior = fs.existsSync(EXITS) ? fs.readFileSync(EXITS, "utf8").trim().split("\\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const done = new Set(prior.filter((x) => x.final).map((x) => x.ticketId));
  const board = JSON.parse(fs.readFileSync(D("board_positions.json"), "utf8")); if (!Array.isArray(board)) throw new Error("board_positions.json is not an array — exit pass refuses");
  const onBoard = new Set(board.filter(Boolean).map((p) => p.id));
  const tl = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8")), closed = new Map((Array.isArray(tl) ? tl : tl.trades || []).filter((t) => t && t.id).map((t) => [t.id, t]));
  const cands = logRows.filter((x) => x.orderId && x.live && !done.has(x.ticketId) && !onBoard.has(x.ticketId));
  console.log(\`alpaca-mirror exits — \${cands.length} mirrored ticket(s) no longer on the board\`);
  let n = 0; const avail = {};
  for (const x of cands) {
    if (n >= MAX_EXITS_PER_RUN) { console.log(\`  exit cap \${MAX_EXITS_PER_RUN} reached — the rest next run\`); break; }
    await sleep(300); const row = { ts: new Date().toISOString(), ticketId: x.ticketId, sym: x.sym, cls: x.cls, entryOrderId: x.orderId, live: LIVE };
    const say = (why) => console.log(\`  exit \${String(x.sym).padEnd(10)} \${why}\`);
    const rec = (why, final) => { row.action = why; row.final = !!final; say(why); if (LIVE) fs.appendFileSync(EXITS, JSON.stringify(row) + "\\n"); };
    const t = closed.get(x.ticketId); if (!t) { say("not on the board and not in the trade log — left for the operator"); continue; }
    row.boardExit = Number.isFinite(t.exit) ? t.exit : null; row.boardClosedAt = t.closedAt || null; row.boardReason = t.reason || null;
    let o; try { o = await apiR(\`/v2/orders/\${x.orderId}?nested=true\`); } catch (e) { say("entry order lookup failed: " + String(e.message).slice(0, 80)); continue; }
    const q = Number(o.filled_qty) || 0;
    if (!(q > 0)) { if (TERM.includes(o.status)) rec(\`entry never filled (\${o.status}) — nothing to close\`, true); else say(\`entry still \${o.status} — waiting\`); continue; }
    let rem = q - legFilled(o); row.entryFilledQty = q;
    if (rem <= 1e-9) { const l = (o.legs || []).find((y) => y.status === "filled"); row.legExit = l ? Number(l.filled_avg_price) : null; rec("already closed at the broker by its bracket leg", true); continue; }
    const crypto = x.cls === "Crypto";
    // ATTRIBUTION (fail-closed): only a ticket whose bracket legs are still LIVE at the broker provably still holds its quantity (the legs reserve it).
    // Legs that expired/cancelled unfilled (the pre-09-24 DAY brackets, flattened by hand on 09-24) and crypto mirrored before 10-01 (no legs; the
    // account's crypto is shared with R191/R231) are not attributable: recorded once and left alone.
    const liveLegs = (o.legs || []).filter((l) => !TERM.includes(l.status));
    if (!crypto && !liveLegs.length) { rec("bracket legs ended unfilled — the position was closed elsewhere (09-24 flatten) or is not attributable; left alone", true); continue; }
    if (crypto && String(x.ts) < "2026-10-01") { rec("crypto mirrored before 10-01 — not attributable on the shared account; left for the operator", true); continue; }
    if (!crypto && !clock.is_open) { say("board closed it — waits for the market open"); continue; }
    const cid = ("mx-" + x.ticketId).slice(0, 128);
    const ex = await apiR(\`/v2/orders:by_client_order_id?client_order_id=\${encodeURIComponent(cid)}\`).catch(() => null);
    if (ex && ex.id) { row.closeOrderId = ex.id; row.status = ex.status; if (ex.status === "filled") { row.qty = Number(ex.filled_qty); row.closeFill = Number(ex.filled_avg_price); rec("closed (exit order filled)", true); } else if (TERM.includes(ex.status)) rec(\`exit order ended \${ex.status} without a fill — left for the operator\`, true); else say(\`exit order working (\${ex.status})\`); continue; }
    const open = (o.legs || []).filter((l) => !TERM.includes(l.status));
    if (LIVE && open.length) {
      for (const l of open) await apiR(\`/v2/orders/\${l.id}\`, { method: "DELETE" }).catch((e) => { if (!/^(404|422)/.test(e.message)) throw e; });
      let settled = false; for (let i = 0; i < 12 && !settled; i++) { await sleep(500); const o2 = await apiR(\`/v2/orders/\${x.orderId}?nested=true\`); if ((o2.legs || []).every((l) => TERM.includes(l.status))) { settled = true; rem = q - legFilled(o2); } }
      if (!settled) { say("bracket legs did not cancel in 6 s — retry next run"); continue; }
      if (rem <= 1e-9) { rec("a leg filled while cancelling — closed by its bracket", true); continue; }
    }
    const side = x.side === "buy" ? "sell" : "buy"; let qty = crypto ? rem : Math.round(rem);
    if (crypto) { const ps = String(x.sym).replace("/", ""); if (avail[ps] == null) { const p = await apiR(\`/v2/positions/\${encodeURIComponent(ps)}\`).catch(() => null); avail[ps] = p ? Number(p.qty_available) || 0 : 0; }
      qty = Math.min(qty, avail[ps]); if (!(qty > 0)) { rec("no crypto quantity left at the broker to sell", true); continue; } avail[ps] -= qty; }
    row.qty = qty; row.side = side;
    if (!LIVE) { say(\`would \${side} \${qty} at market to close (board closed it \${t.closedAt ? new Date(t.closedAt).toISOString().slice(0, 16) + "Z" : ""}, \${t.reason || ""}); open legs \${open.length}\`); continue; }
    try { const c = await apiR("/v2/orders", { method: "POST", body: JSON.stringify({ symbol: x.sym, qty: String(qty), side, type: "market", time_in_force: crypto ? "gtc" : "day", client_order_id: cid }) });
      row.closeOrderId = c.id; row.status = c.status; n++; rec(\`close \${side} \${qty} sent (\${c.status}) — final once it fills\`, false); }
    catch (e) { row.error = String(e.message).slice(0, 200); rec("close order FAILED: " + row.error, false); }
  }
  console.log(\`alpaca-mirror exits done — \${n} close order(s) \${LIVE ? "placed" : "(dry run: none placed)"}\`);
}
`, "exitPhase");

m = rep(m, `  const clock = await api("/v2/clock").catch(() => ({ is_open: false }));
`, `  const clock = await api("/v2/clock").catch(() => ({ is_open: false }));
  try { await exitPhase(clock, logRows); } catch (e) { console.error("alpaca-mirror exit pass FAILED:", e.message); process.exitCode = 1; }   // exits first: they free the buying power the entries need
  if (process.argv.includes("--exits-only")) return;
`, "main");

r = rep(r, `  const byId = new Map(ledger.map((t) => [t.id, t]));
`, `  const byId = new Map(ledger.map((t) => [t.id, t]));
  // 2026-10-01: mirror exits (alpaca-mirror.js closes a ticket at market once the board has closed it) are the broker exit when no leg filled
  const EX = D("alpaca-mirror-exits.jsonl"), exitBy = new Map((fs.existsSync(EX) ? fs.readFileSync(EX, "utf8").trim().split("\\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((x) => x.closeOrderId).map((x) => [x.ticketId, x]));
`, "reconcile map");
r = rep(r, `    const exitLeg = legs.find((l) => l.status === "filled");
`, `    let exitLeg = legs.find((l) => l.status === "filled");
    if (!exitLeg && exitBy.has(r.ticketId)) { try { const c = await api(\`/v2/orders/\${exitBy.get(r.ticketId).closeOrderId}\`); if (Number(c.filled_avg_price) > 0) exitLeg = { filled_avg_price: c.filled_avg_price, order_type: "mirror-exit (board closed)" }; } catch {} }
`, "reconcile exit");
fs.writeFileSync(OUTM, m); fs.writeFileSync(OUTR, r); console.log("written", OUTM, OUTR);
