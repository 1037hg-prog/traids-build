"use strict";
/**
 * OP11 selftest preload (node -r). Runs inside a SANDBOX copy of backend/ only (selftest.cjs builds it under the OS temp dir).
 *   OP11_FAKE_NOW   ISO instant: `new Date()` / Date.now() return it (every other Date use is untouched)
 *   OP11_SANDBOX    sandbox root: POST bodies to /api/board-positions are written to <root>/posted-<n>.json
 * Network: EVERY fetch is answered here or refused. Nothing leaves the process — no Schwab, no Alpaca, no :3001, no order endpoint.
 */
const fs = require("fs"), path = require("path");
const FIXED = Date.parse(process.env.OP11_FAKE_NOW || "");
if (!Number.isFinite(FIXED)) throw new Error("preload: OP11_FAKE_NOW missing");
const SB = process.env.OP11_SANDBOX;
if (!SB || !fs.existsSync(SB)) throw new Error("preload: OP11_SANDBOX missing");
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
  static now() { return FIXED; }
}
global.Date = FakeDate;

const spotOf = require(path.join(__dirname, "fixture-model.cjs")).spot;
const reply = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) });
let posts = 0;
global.fetch = async (url, opts = {}) => {
  const u = String(url), method = String(opts.method || "GET").toUpperCase();
  if (/^http:\/\/op11-stub\.invalid\/api\/finnhub\/earnings/.test(u)) return reply({ data: {} });
  if (/^http:\/\/op11-stub\.invalid\/api\/board-positions$/.test(u) && method === "GET") {
    let positions = []; try { positions = JSON.parse(fs.readFileSync(path.join(SB, "board-get.json"), "utf8")); } catch {}
    return reply({ positions });
  }
  if (/^http:\/\/op11-stub\.invalid\/api\/board-positions$/.test(u) && method === "POST") {
    posts++; fs.writeFileSync(path.join(SB, `posted-${posts}.json`), String(opts.body || ""));
    return reply({ ok: true, saved: (JSON.parse(String(opts.body || "{}")).positions || []).length });
  }
  if (/^https:\/\/data\.alpaca\.markets\/v2\/stocks\/snapshots\?/.test(u) && method === "GET") {
    const syms = decodeURIComponent((/symbols=([^&]+)/.exec(u) || [])[1] || "").split(",").filter(Boolean);
    return reply({ snapshots: Object.fromEntries(syms.map((s) => [s, { latestTrade: { p: spotOf(s) } }])) });
  }
  throw new Error(`selftest sandbox: network refused (${method} ${u.slice(0, 80)})`);
};
