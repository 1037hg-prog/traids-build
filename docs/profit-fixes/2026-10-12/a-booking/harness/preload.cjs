"use strict";
/**
 * SELFTEST PRELOAD (profit fixes A; loaded with node -r into a child that runs a SANDBOX copy of a backend script, never a live one).
 *   PFA_FAKE_NOW   ISO instant: `new Date()` and Date.now() return it (every other use of Date is untouched)
 *   PFA_SANDBOX    the sandbox root: a POST to /api/board-positions is written to <root>/posted-<n>.json
 *   PFA_FIXTURE    a JSON file: { spots, noSnapshot: [syms], snapshots: {SYM: a whole snapshot}, quotes: {SYM:{last,bid,ask}},
 *                  dailyBars: {SYM:[bars]}, board: [...], zeroDte: [syms] }
 * NETWORK: every fetch is answered here or refused. Nothing leaves the process: no Schwab, no Alpaca, no :3001, no order endpoint.
 * The Alpaca stock-snapshots answer has its REAL shape — a bare map keyed by symbol, no "snapshots" wrapper — because that shape is
 * what fix 4.7 is about.
 */
const fs = require("fs"), path = require("path");
const FIXED = Date.parse(process.env.PFA_FAKE_NOW || "");
if (!Number.isFinite(FIXED)) throw new Error("preload: PFA_FAKE_NOW missing");
const SB = process.env.PFA_SANDBOX;
if (!SB || !fs.existsSync(SB)) throw new Error("preload: PFA_SANDBOX missing");
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
  static now() { return FIXED; }
}
global.Date = FakeDate;

const M = require(path.join(__dirname, "model.cjs")), FX = M.FX;
const reply = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => obj, text: async () => JSON.stringify(obj) });
const qs = (u, k) => { const m = new RegExp("[?&]" + k + "=([^&]*)").exec(u); return m ? decodeURIComponent(m[1]) : ""; };
let posts = 0;
global.fetch = async (url, opts = {}) => {
  const u = String(url), method = String(opts.method || "GET").toUpperCase();
  const local = /^http:\/\/pfa-stub\.invalid(\/.*)$/.exec(u);
  if (local) {
    const p = local[1];
    if (/^\/api\/chart\/quote\?/.test(p) && method === "GET") { const q = (FX.quotes || {})[qs(p, "symbol")]; return reply(q || { error: "no quote" }); }
    if (/^\/api\/chart\/bars\?/.test(p) && method === "GET") return reply({ bars: (FX.dailyBars || {})[qs(p, "symbol")] || [] });
    if (/^\/api\/finnhub\/earnings/.test(p)) return reply({ data: {} });
    if (/^\/api\/board-positions$/.test(p) && method === "GET") return FX.boardDown ? reply({ error: "down" }, 503) : reply({ positions: FX.board || [] });
    if (/^\/api\/board-positions$/.test(p) && method === "POST") { posts++; fs.writeFileSync(path.join(SB, `posted-${posts}.json`), String(opts.body || "")); return reply({ ok: true, saved: (JSON.parse(String(opts.body || "{}")).positions || []).length }); }
    throw new Error(`selftest sandbox: local endpoint not stubbed (${method} ${p.slice(0, 80)})`);
  }
  if (/^https:\/\/data\.alpaca\.markets\/v2\/stocks\/snapshots\?/.test(u) && method === "GET") {
    const out = {};   // the REAL shape: a bare map
    // FX.snapshots names a symbol's whole snapshot (latestTrade / minuteBar / dailyBar, as Alpaca shapes them), so each source the
    // recording-only read falls back to has a known answer; a symbol it does not name gets a last trade at the model's price
    const shaped = FX.snapshots || {};
    for (const s of qs(u, "symbols").split(",").filter(Boolean)) {
      if ((FX.noSnapshot || []).includes(s)) continue;
      out[s] = Object.prototype.hasOwnProperty.call(shaped, s) ? shaped[s] : { latestTrade: { p: M.price(s), t: new RealDate(FIXED - 1000).toISOString() } };
    }
    return reply(out);
  }
  if (/^https:\/\/api\.schwabapi\.com\/v1\/oauth\/token$/.test(u) && method === "POST") return reply({ access_token: "selftest-stub-token" });
  if (/^https:\/\/api\.schwabapi\.com\/marketdata\/v1\/chains\?/.test(u) && method === "GET") {
    const sym = qs(u, "symbol"), day = qs(u, "fromDate");
    if (!(FX.zeroDte || []).includes(sym)) return reply({ putExpDateMap: {}, callExpDateMap: {} });
    const maps = { P: {}, C: {} };
    for (const l of M.legs(sym, day)) (maps[l.right][String(l.strike.toFixed(1))] ||= []).push({ symbol: l.occ.replace(/^([A-Z.]+)/, (r) => r.padEnd(6)), bid: l.bid, ask: l.ask, delta: l.delta, volatility: 30, strikePrice: l.strike });
    return reply({ putExpDateMap: { [`${day}:0`]: maps.P }, callExpDateMap: { [`${day}:0`]: maps.C } });
  }
  throw new Error(`selftest sandbox: network refused (${method} ${u.slice(0, 80)})`);
};
