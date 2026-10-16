// R295 v2 (operator 2026-09-30: "yes add 1 and 2 after close"): (1) Alpaca trade_updates websocket -> a fill is synced the moment it
// happens (3-second polling stays as the fallback); (2) entries go in as OTO orders with the stop attached, so a full fill is protected
// by the broker with no delay. Partial fills: whatever the broker does with the held leg, syncOne() guarantees exactly one active stop
// for exactly the filled quantity (the leg when it is live at the right size, else a standalone stop). Anchors must match exactly.
const fs = require("fs"); const F = process.argv[2]; let s = fs.readFileSync(F, "utf8"); const orig = s;
const rep = (a, b, n = 1) => { const c = s.split(a).length - 1; if (c !== n) throw new Error(`expected ${n}x, found ${c}x: ${a.slice(0, 90)}`); s = s.split(a).join(b); };

rep(` * MODES   --prepare [YYYY-MM-DD]`, ` * v2 (2026-09-30, operator: "yes add 1 and 2 after close"; pre-evidence — evidence starts 2026-10-01):
 *   (1) the Alpaca trade_updates websocket syncs a fill the moment it happens (3-second polling kept as the fallback);
 *   (2) entries are OTO orders with a stop leg at the LIMIT price -/+ 0.10 x ATR14, so a full fill is protected by the broker at once
 *       (the leg's reference is the limit, at most 0.1% from the fill, disclosed in the registry). Partial fills: syncOne() keeps exactly
 *       one live stop for exactly the filled quantity (the leg when it is live at that size, else a standalone stop at fill -/+ 0.10 x ATR14).
 *   --stream-test connects, authenticates and listens for 10 s (no orders).
 * MODES   --prepare [YYYY-MM-DD]`);
rep(`const MODES = ["--prepare", "--session", "--close-arm", "--after-close", "--status", "--read", "--selftest"];`, `const MODES = ["--prepare", "--session", "--close-arm", "--after-close", "--status", "--read", "--selftest", "--stream-test"];`);

// stream helper + order-by-id, after byCid
rep(`async function submit(o) {`, `const byId = async (id) => { try { return await api(\`/v2/orders/\${id}?nested=true\`); } catch (e) { if (e.status === 404) return null; throw e; } };
/** v2 (1): Alpaca trade_updates stream (paper). onEvent(order, event) for every update; reconnects until stop(). */
function tradeStream(onEvent) {
  let ws = null, closed = false, authed = false; const dec = new TextDecoder();
  const open = () => {
    if (closed) return;
    ws = new WebSocket("wss://paper-api.alpaca.markets/stream");
    ws.binaryType = "arraybuffer";
    ws.onopen = () => ws.send(JSON.stringify({ action: "auth", key: H["APCA-API-KEY-ID"], secret: H["APCA-API-SECRET-KEY"] }));
    ws.onmessage = (m) => {
      let j; try { j = JSON.parse(typeof m.data === "string" ? m.data : dec.decode(m.data)); } catch { return; }
      if (j.stream === "authorization") { authed = j.data && j.data.status === "authorized"; log(\`stream \${authed ? "authorized" : "NOT authorized"}\`); if (authed) ws.send(JSON.stringify({ action: "listen", data: { streams: ["trade_updates"] } })); return; }
      if (j.stream === "listening") { log("stream listening: " + JSON.stringify(j.data && j.data.streams)); return; }
      if (j.stream === "trade_updates" && j.data && j.data.order) { try { onEvent(j.data.order, j.data.event); } catch (e) { log("stream handler: " + e.message); } }
    };
    ws.onerror = () => {};
    ws.onclose = () => { authed = false; if (!closed) setTimeout(open, 3000); };
  };
  open();
  return { stop: () => { closed = true; try { ws && ws.close(); } catch {} }, isAuthed: () => authed };
}
async function submit(o) {`);

// OTO entry
rep(`    try { const o = await submit({ symbol: p.sym, qty: String(p.qty), side: p.dir > 0 ? "buy" : "sell", type: "limit", limit_price: p.limit.toFixed(2), time_in_force: "day", client_order_id: p.cid }); p.entryId = o.id; p.entryStatus = o.status; }`,
    `    p.legStopPx = +(p.limit - p.dir * p.stopDist).toFixed(2);                              // v2 (2): broker-held stop, referenced to the limit
    try { const o = await submit({ symbol: p.sym, qty: String(p.qty), side: p.dir > 0 ? "buy" : "sell", type: "limit", limit_price: p.limit.toFixed(2), time_in_force: "day", client_order_id: p.cid, order_class: "oto", stop_loss: { stop_price: p.legStopPx.toFixed(2) } }); p.entryId = o.id; p.entryStatus = o.status; }`);

// replace syncStops with syncOne (exactly one live stop for exactly the filled quantity) + stream
rep(`  const syncStops = async () => {
    for (const p of picks.filter((x) => x.entryId && x.entryId !== "dry")) {
      const o = await byCid(p.cid); if (!o) continue; const filled = Math.round(Number(o.filled_qty) || 0); p.filled = filled; p.avgFill = Number(o.filled_avg_price) || null; p.entryStatus = o.status;
      if (filled > (p.stopQty || 0) && p.avgFill) {
        if (p.stopCid) await cancel(await byCid(p.stopCid));
        p.stopN = (p.stopN || 0) + 1; p.stopCid = cidOf(date, p.sym, \`STOP\${p.stopN}\`); p.stopPx = +(p.avgFill - p.dir * p.stopDist).toFixed(2);
        try { await submit({ symbol: p.sym, qty: String(filled), side: p.dir > 0 ? "sell" : "buy", type: "stop", stop_price: p.stopPx.toFixed(2), time_in_force: "day", client_order_id: p.stopCid }); p.stopQty = filled; }
        catch (e) { S.notes.push(\`\${p.sym} stop failed: \${e.message.slice(0, 100)}\`); }
      }
    }
    save();
  };
  while (Date.now() < etMs(date, "09:40:00")) { await syncStops(); await sleep(3000); }`,
`  const LIVE_LEG = ["new", "accepted", "pending_new", "partially_filled", "pending_replace", "replaced"];
  const busy = new Set();
  const syncOne = async (p) => {                                                        // v2: exactly one live stop for exactly the filled qty
    if (busy.has(p.sym)) return; busy.add(p.sym);
    try {
      const o = await byId(p.entryId); if (!o) return;
      const filled = Math.round(Number(o.filled_qty) || 0); p.filled = filled; p.avgFill = Number(o.filled_avg_price) || null; p.entryStatus = o.status;
      const leg = (o.legs || [])[0] || null; if (leg) { p.legId = leg.id; p.legStatus = leg.status; }
      (p.stopIds ||= []); if (leg && !p.stopIds.includes(leg.id)) p.stopIds.push(leg.id);
      if (!(filled > 0)) return;
      const legGood = leg && LIVE_LEG.includes(leg.status) && Math.round(Number(leg.qty)) === filled;
      if (legGood) {                                                                    // the broker's leg covers it: retire any standalone stop
        if (p.soloId) { await cancel(await byId(p.soloId)); p.soloId = null; p.soloQty = 0; }
        p.stopQty = filled; p.stopPx = Number(leg.stop_price) || p.legStopPx; return;
      }
      if (leg && LIVE_LEG.includes(leg.status)) await cancel(leg);                      // live at the wrong size: remove it
      if (p.soloId && p.soloQty === filled) { p.stopQty = filled; return; }
      if (p.soloId) await cancel(await byId(p.soloId));
      p.stopN = (p.stopN || 0) + 1; p.stopCid = cidOf(date, p.sym, \`STOP\${p.stopN}\`); p.stopPx = +(p.avgFill - p.dir * p.stopDist).toFixed(2);
      try { const so = await submit({ symbol: p.sym, qty: String(filled), side: p.dir > 0 ? "sell" : "buy", type: "stop", stop_price: p.stopPx.toFixed(2), time_in_force: "day", client_order_id: p.stopCid }); p.soloId = so.id; p.soloQty = filled; p.stopQty = filled; p.stopIds.push(so.id); }
      catch (e) { S.notes.push(\`\${p.sym} stop failed: \${e.message.slice(0, 100)}\`); }
    } finally { busy.delete(p.sym); }
  };
  const syncStops = async () => { for (const p of picks.filter((x) => x.entryId && x.entryId !== "dry")) await syncOne(p); save(); };
  const byEntry = new Map(picks.filter((x) => x.entryId).map((p) => [p.entryId, p]));
  const stream = LIVE ? tradeStream((order, ev) => {                                     // v2 (1): act on the fill the moment it happens
    const p = byEntry.get(order.id) || picks.find((x) => x.legId && x.legId === order.id) || picks.find((x) => x.soloId && x.soloId === order.id);
    if (!p) return; (S.streamEvents ||= []).push({ at: new Date().toISOString(), sym: p.sym, ev, status: order.status, filled: order.filled_qty });
    if (/fill/.test(ev) && byEntry.get(order.id)) syncOne(p).then(save).catch((e) => S.notes.push("stream sync: " + e.message.slice(0, 80)));
  }) : null;
  while (Date.now() < etMs(date, "09:40:00")) { await syncStops(); await sleep(3000); }`);
rep(`  await sleepUntil(date, "15:44:00"); await closeOut(date, S, picks); save(); log("session done");`,
    `  S.streamAuthed = stream ? stream.isAuthed() : null; save();
  await sleepUntil(date, "15:44:00"); await closeOut(date, S, picks); if (stream) stream.stop(); save(); log("session done");`);

// close-out: count every stop order's fills, cancel whichever is live
rep(`    let stopFilled = 0; if (p.stopCid) { const so = await byCid(p.stopCid); stopFilled = Math.round(Number(so && so.filled_qty) || 0); if (so && so.status !== "filled") await cancel(so); }`,
    `    let stopFilled = 0;
    for (const id of p.stopIds || []) { const so = await byId(id); if (!so) continue; stopFilled += Math.round(Number(so.filled_qty) || 0); if (!["filled", "canceled", "expired", "rejected"].includes(so.status)) await cancel(so); }
    if (!(p.stopIds || []).length && p.stopCid) { const so = await byCid(p.stopCid); stopFilled = Math.round(Number(so && so.filled_qty) || 0); if (so && so.status !== "filled") await cancel(so); }   // v1 sessions`);

// accounting: exits from every stop order id + MOC
rep(`    for (const cid of [p.stopCid, p.mocCid].filter(Boolean)) { const o = await byCid(cid); const fq = Math.round(Number(o && o.filled_qty) || 0); if (fq > 0) { exitVal += fq * Number(o.filled_avg_price); exitQ += fq; } }`,
    `    const exitOrders = [...(p.stopIds || []).map((id) => byId(id)), ...(!(p.stopIds || []).length && p.stopCid ? [byCid(p.stopCid)] : []), ...(p.mocCid ? [byCid(p.mocCid)] : [])];
    for (const o of await Promise.all(exitOrders)) { const fq = Math.round(Number(o && o.filled_qty) || 0); if (fq > 0) { exitVal += fq * Number(o.filled_avg_price); exitQ += fq; } }`);

// --stream-test mode
rep(`  if (mode === "--session") return session();`, `  if (mode === "--session") return session();
  if (mode === "--stream-test") { const st = tradeStream((o, ev) => log("event", ev, o.symbol, o.status)); await sleep(10000); st.stop(); return log(\`stream-test: authorized=\${st.isAuthed() ? "yes (closing)" : "see above"}\`); }`);

if (s === orig) throw new Error("no change"); fs.writeFileSync(F, s); console.log("patched", F, "(+" + (s.length - orig.length) + " chars)");
