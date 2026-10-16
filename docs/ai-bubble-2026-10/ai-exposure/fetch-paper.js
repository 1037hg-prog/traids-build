// READ-ONLY. GET /v2/account + /v2/positions on the three Alpaca PAPER accounts.
// Keys are read from backend/.env and never printed. Account numbers are never printed or saved.
// Output: paper-positions.json (labels main/book/tv, equity, cash, positions) in this folder.
const fs = require("fs"), path = require("path");
const ROOT = "C:/Users/joshc/Downloads/traids (2)/traids-bundle";
const env = {};
for (const l of fs.readFileSync(path.join(ROOT, "backend/.env"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const ACCTS = [
  { acct: "main", id: "ALPACA_KEY_ID", sec: "ALPACA_SECRET_KEY" },
  { acct: "book", id: "ALPACA_BOOK_KEY_ID", sec: "ALPACA_BOOK_SECRET_KEY" },
  { acct: "tv", id: "ALPACA_TV_KEY_ID", sec: "ALPACA_TV_SECRET_KEY" },
];
const BASE = "https://paper-api.alpaca.markets";
(async () => {
  const out = { fetchedAt: new Date().toISOString(), source: BASE + " GET /v2/account, /v2/positions (paper)", accounts: [] };
  for (const a of ACCTS) {
    const h = { "APCA-API-KEY-ID": env[a.id], "APCA-API-SECRET-KEY": env[a.sec] };
    if (!env[a.id]) { out.accounts.push({ acct: a.acct, error: "key missing" }); continue; }
    const acc = await (await fetch(BASE + "/v2/account", { headers: h })).json();
    const pos = await (await fetch(BASE + "/v2/positions", { headers: h })).json();
    out.accounts.push({
      acct: a.acct, status: acc.status,
      equity: +acc.equity, cash: +acc.cash, long_market_value: +acc.long_market_value, short_market_value: +acc.short_market_value,
      positions: (Array.isArray(pos) ? pos : []).map(p => ({ symbol: p.symbol, asset_class: p.asset_class, side: p.side, qty: +p.qty, market_value: +p.market_value, current_price: +p.current_price })),
    });
  }
  fs.writeFileSync(path.join(__dirname, "paper-positions.json"), JSON.stringify(out, null, 1));
  for (const a of out.accounts) console.log(a.acct, a.status, "equity", a.equity, "cash", a.cash, "LMV", a.long_market_value, "SMV", a.short_market_value, "npos", a.positions ? a.positions.length : a.error);
})();
