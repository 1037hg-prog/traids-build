"use strict";
/**
 * r25-twins selftest PRELOAD (node -r), for a SANDBOX copy of the 0DTE sleeve only (selftest.cjs builds it under the OS temp dir).
 *   R25TW_FAKE_NOW   ISO instant: `new Date()` / Date.now() return it (every other Date use is untouched)
 *   R25TW_SANDBOX    sandbox root: GET /api/board-positions answers <root>/board-get.json; POST bodies land in <root>/posted-<n>.json
 * Network: EVERY fetch is answered here or refused — the Schwab token and chain endpoints from the fixture market, Alpaca stock snapshots
 * from the fixture spots, the board from the sandbox files. Nothing leaves the process: no Schwab, no Alpaca, no :3001, no order endpoint.
 */
const fs = require("fs"), path = require("path");
const FIXED = Date.parse(process.env.R25TW_FAKE_NOW || "");
if (!Number.isFinite(FIXED)) throw new Error("preload: R25TW_FAKE_NOW missing");
const SB = process.env.R25TW_SANDBOX;
if (!SB || !fs.existsSync(SB)) throw new Error("preload: R25TW_SANDBOX missing");
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
  static now() { return FIXED; }
}
global.Date = FakeDate;
const M = require(path.join(__dirname, "fixture-chain.cjs"));
const reply = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) });
let posts = 0;
const log = (s) => fs.appendFileSync(path.join(SB, "fetch-log.txt"), s + "\n");
global.fetch = async (url, opts = {}) => {
  const u = String(url), method = String(opts.method || "GET").toUpperCase();
  log(`${method} ${u.replace(/\?.*$/, "")}`);
  if (u === "https://api.schwabapi.com/v1/oauth/token" && method === "POST") return reply({ access_token: "stub-token" });
  if (u.startsWith("https://api.schwabapi.com/marketdata/v1/chains?") && method === "GET") {
    const q = new URL(u).searchParams; return reply(M.chainJson(q.get("symbol"), q.get("fromDate")));
  }
  if (u.startsWith("https://data.alpaca.markets/v2/stocks/snapshots?") && method === "GET") {
    const syms = (new URL(u).searchParams.get("symbols") || "").split(",").filter(Boolean);
    return reply({ snapshots: Object.fromEntries(syms.map((s) => [s, { latestTrade: { p: M.SPOT[s] } }])) });
  }
  if (/^http:\/\/r25tw-stub\.invalid\/api\/board-positions$/.test(u) && method === "GET") {
    let positions = []; try { positions = JSON.parse(fs.readFileSync(path.join(SB, "board-get.json"), "utf8")); } catch {}
    return reply({ positions });
  }
  if (/^http:\/\/r25tw-stub\.invalid\/api\/board-positions$/.test(u) && method === "POST") {
    posts++; fs.writeFileSync(path.join(SB, `posted-${posts}.json`), String(opts.body || ""));
    return reply({ ok: true });
  }
  throw new Error(`selftest sandbox: network refused (${method} ${u.slice(0, 80)})`);
};
