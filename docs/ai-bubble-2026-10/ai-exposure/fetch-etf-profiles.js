// READ-ONLY public data. Alpha Vantage ETF_PROFILE (holdings + sector weights) for the funds we need to look through.
// Key from backend/.env, never printed. Caches to etf-profiles/<SYM>.json; skips symbols already cached.
const fs = require("fs"), path = require("path");
const ROOT = "C:/Users/joshc/Downloads/traids (2)/traids-bundle";
const env = {};
for (const l of fs.readFileSync(path.join(ROOT, "backend/.env"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const syms = process.argv.slice(2);
const dir = path.join(__dirname, "etf-profiles"); fs.mkdirSync(dir, { recursive: true });
(async () => {
  for (const s of syms) {
    const f = path.join(dir, s + ".json");
    if (fs.existsSync(f)) { console.log(s, "cached"); continue; }
    const r = await fetch(`https://www.alphavantage.co/query?function=ETF_PROFILE&symbol=${s}&apikey=${env.ALPHAVANTAGE_KEY}`);
    const j = await r.json();
    if (!j.holdings) { console.log(s, "NO HOLDINGS:", JSON.stringify(j).slice(0, 200)); continue; }
    fs.writeFileSync(f, JSON.stringify(j));
    console.log(s, "holdings", j.holdings.length, "net_assets", j.net_assets, "sectors", (j.sectors || []).length);
    await new Promise(r => setTimeout(r, 1200));
  }
})();
