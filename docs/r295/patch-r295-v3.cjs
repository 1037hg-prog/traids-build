// R295 v3 fixes on top of v2 (2026-09-30, lessons from the shakeout: the v1 session died at 09:35:34 ET on an Alpaca 429 from polling
// 19 orders every 3 s; standalone stops sent while the entry was still working were rejected as wash trades; 10%-ATR stops were often
// already through the market when placed). All pre-evidence (evidence starts 2026-10-01). Anchors must match exactly.
//   A. api(): retry 429 / 5xx with back-off (never crash on a rate limit).
//   B. one "list today's orders" call per 3-second cycle instead of one call per order (~20 calls/min, not ~380).
//   C. no standalone stop while the entry is still working (the OTO leg covers a full fill; the remainder is cancelled at 09:40).
//   D. a stop the broker refuses because the price is already through it -> immediate market exit (what the rule's stop would have done).
//   E. per-cycle and per-pick errors are logged and survived; the session process no longer dies on one bad response.
const fs = require("fs"); const F = process.argv[2]; let s = fs.readFileSync(F, "utf8"); const orig = s;
const rep = (a, b, n = 1) => { const c = s.split(a).length - 1; if (c !== n) throw new Error(`expected ${n}x, found ${c}x: ${a.slice(0, 90)}`); s = s.split(a).join(b); };

rep(`async function api(p, init = {}) {
  if (!/paper-api/.test(BASE)) throw new Error("not the paper endpoint");
  if (!H["APCA-API-KEY-ID"]) throw new Error("no ALPACA_TV keys — refusing (no fallback to the shared account)");
  const r = await fetch(BASE + p, { ...init, headers: H, signal: AbortSignal.timeout(20000) });
  const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
  if (!r.ok) { const e = new Error(\`alpaca \${r.status} \${p}: \${(j && j.message) || txt.slice(0, 120)}\`); e.status = r.status; throw e; }
  return j;`,
`async function api(p, init = {}) {
  if (!/paper-api/.test(BASE)) throw new Error("not the paper endpoint");
  if (!H["APCA-API-KEY-ID"]) throw new Error("no ALPACA_TV keys — refusing (no fallback to the shared account)");
  for (let a = 0; ; a++) {                                                                       // v3 A: survive rate limits and 5xx
    let r, txt; try { r = await fetch(BASE + p, { ...init, headers: H, signal: AbortSignal.timeout(20000) }); txt = await r.text(); }
    catch (e) { if (a < 5) { await sleep(2000 * (a + 1)); continue; } throw e; }
    let j = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
    if ((r.status === 429 || r.status >= 500) && a < 6) { await sleep(2000 * (a + 1)); continue; }
    if (!r.ok) { const e = new Error(\`alpaca \${r.status} \${p}: \${(j && j.message) || txt.slice(0, 120)}\`); e.status = r.status; throw e; }
    return j;
  }`);

rep(`  const syncOne = async (p) => {                                                        // v2: exactly one live stop for exactly the filled qty
    if (busy.has(p.sym)) return; busy.add(p.sym);
    try {
      const o = await byId(p.entryId); if (!o) return;`,
`  const syncOne = async (p, known = null) => {                                          // v2: exactly one live stop for exactly the filled qty
    if (busy.has(p.sym)) return; busy.add(p.sym);
    try {
      const o = known || await byId(p.entryId); if (!o) return;                              // v3 B: the cycle passes the listed order`);

rep(`      if (p.soloId && p.soloQty === filled) { p.stopQty = filled; return; }`,
`      if (p.soloId && p.soloQty === filled) { p.stopQty = filled; return; }
      if (["new", "accepted", "pending_new", "partially_filled"].includes(o.status)) return;   // v3 C: entry still working -> a standalone stop is a wash trade; wait`);

rep(`      try { const so = await submit({ symbol: p.sym, qty: String(filled), side: p.dir > 0 ? "sell" : "buy", type: "stop", stop_price: p.stopPx.toFixed(2), time_in_force: "day", client_order_id: p.stopCid }); p.soloId = so.id; p.soloQty = filled; p.stopQty = filled; p.stopIds.push(so.id); }
      catch (e) { S.notes.push(\`\${p.sym} stop failed: \${e.message.slice(0, 100)}\`); }`,
`      try { const so = await submit({ symbol: p.sym, qty: String(filled), side: p.dir > 0 ? "sell" : "buy", type: "stop", stop_price: p.stopPx.toFixed(2), time_in_force: "day", client_order_id: p.stopCid }); p.soloId = so.id; p.soloQty = filled; p.stopQty = filled; p.stopIds.push(so.id); }
      catch (e) {
        if (e.status === 422 && /current price/.test(e.message)) {                           // v3 D: already through the stop -> exit now
          const xc = cidOf(date, p.sym, "XSTOP");
          try { const xo = await submit({ symbol: p.sym, qty: String(filled), side: p.dir > 0 ? "sell" : "buy", type: "market", time_in_force: "day", client_order_id: xc }); p.stopIds.push(xo.id); p.soloId = xo.id; p.soloQty = filled; p.stopQty = filled; p.exitThrough = true; S.notes.push(\`\${p.sym} through its stop \${p.stopPx} when filled -> market exit\`); }
          catch (e2) { S.notes.push(\`\${p.sym} market exit failed: \${e2.message.slice(0, 100)}\`); }
        } else S.notes.push(\`\${p.sym} stop failed: \${e.message.slice(0, 100)}\`);
      }`);

rep(`  const syncStops = async () => { for (const p of picks.filter((x) => x.entryId && x.entryId !== "dry")) await syncOne(p); save(); };`,
`  const syncStops = async () => {                                                        // v3 B+E: ONE list call per cycle; errors survive
    try {
      const list = (await api(\`/v2/orders?status=all&nested=true&limit=500&after=\${new Date(etMs(date, "09:00:00")).toISOString()}\`)) || [];
      const m = new Map(list.map((o) => [o.id, o]));
      for (const p of picks.filter((x) => x.entryId && x.entryId !== "dry")) { try { await syncOne(p, m.get(p.entryId) || null); } catch (e) { S.notes.push(\`\${p.sym} sync: \${e.message.slice(0, 80)}\`); } }
    } catch (e) { S.notes.push("sync cycle: " + e.message.slice(0, 100)); }
    save();
  };`);

// the 09:40 cancel loop and the close-out must not die on one error either
rep(`  for (const p of picks.filter((x) => x.entryId && x.entryId !== "dry")) { const o = await byCid(p.cid); if (o && !["filled", "canceled", "expired"].includes(o.status)) await cancel(o); }`,
    `  for (const p of picks.filter((x) => x.entryId && x.entryId !== "dry")) { try { const o = await byCid(p.cid); if (o && !["filled", "canceled", "expired"].includes(o.status)) await cancel(o); } catch (e) { S.notes.push(\`\${p.sym} cancel: \${e.message.slice(0, 80)}\`); } }`);
rep(`  for (const p of picks.filter((x) => (x.filled || 0) > 0)) {
    if (p.mocCid) continue;`, `  for (const p of picks.filter((x) => (x.filled || 0) > 0)) { try {                    // v3 E: one bad pick never stops the close-out
    if (p.mocCid) continue;`);
rep(`    catch (e) { S.notes.push(\`\${p.sym} MOC failed: \${e.message.slice(0, 100)}\`); }
  }
  S.closedOutAt = new Date().toISOString();`, `    catch (e) { S.notes.push(\`\${p.sym} MOC failed: \${e.message.slice(0, 100)}\`); }
  } catch (e) { S.notes.push(\`\${p.sym} close-out: \${e.message.slice(0, 80)}\`); } }
  S.closedOutAt = new Date().toISOString();`);

if (s === orig) throw new Error("no change"); fs.writeFileSync(F, s); console.log("patched", F, "(+" + (s.length - orig.length) + " chars)");
