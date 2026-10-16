#!/usr/bin/env node
/**
 * 2026-09-22 (operator: "go on the jup fix"). JUP, ARB and TON are removed from BOARD_CRYPTO: Yahoo's <SYM>-USD for each is a DIFFERENT,
 * illiquid token with the same ticker — JUP-USD "Jupiter" $0.00043 vs Jupiter (Solana) $0.29; ARB-USD "ARbit" $0.00063 vs Arbitrum $0.217;
 * TON-USD "TON Token" $0.0055 vs Toncoin $1.44 (Coinbase and CoinGecko, data/crypto-symbol-scan-2026-09-22.json). JUP was logged as D49 on
 * 2026-08-26 but never removed. The other 63 symbols match a second source or return no Yahoo data (filtered harmlessly).
 */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const f = path.join(__dirname, "..", "src", "App.jsx"); let s = fs.readFileSync(f, "utf8");
if (s.includes("WRONG-COIN REMOVAL 2026-09-22")) { console.log("already patched"); } else {
  const m = s.match(/const BOARD_CRYPTO = \[[\s\S]*?\];/); if (!m) { console.error("BOARD_CRYPTO not found"); process.exit(2); }
  let block = m[0]; const before = block;
  for (const sym of ["JUP", "ARB", "TON"]) { const re = new RegExp(`"${sym}",`); if (!re.test(block)) { console.error("not in list:", sym); process.exit(2); } block = block.replace(re, ""); }
  block = block.replace("const BOARD_CRYPTO = [", "// WRONG-COIN REMOVAL 2026-09-22 (operator): JUP, ARB, TON dropped — Yahoo's ticker for each is a different, illiquid token\n// (see backend/patch-crypto-wrong-coins.js and data/crypto-symbol-scan-2026-09-22.json). Re-add only via a source that prices the real coin.\nconst BOARD_CRYPTO = [");
  fs.copyFileSync(f, f + ".pre-wrong-coins-2026-09-22.bak"); s = s.replace(before, block); fs.writeFileSync(f + ".tmp", s); fs.renameSync(f + ".tmp", f); console.log("App.jsx patched");
}
const D = (x) => path.join(__dirname, "data", x), cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
if (!cr.some((c) => /wrong-coin/i.test(c.area || ""))) { cr.push({ date: "2026-09-22", area: "crypto universe / wrong-coin removal (JUP, ARB, TON)", category: "defect fix", breaksComparability: true, change: "src/App.jsx BOARD_CRYPTO: JUP, ARB, TON removed. Client rebuilt; no server restart.", why: "Yahoo's JUP-USD, ARB-USD and TON-USD price different, illiquid same-ticker tokens (JUP $0.00043 vs $0.29 real; ARB $0.00063 vs $0.217; TON $0.0055 vs $1.44). JUP was logged as D49 on 2026-08-26 and never removed; it opened two tickets on 2026-09-22.", doesNotEstablish: "Anything about past JUP/ARB rows: history is NOT retired by this change; that is the operator's separate decision (retiring JUP history flatters the signal book).", operator: "Josh: 'go on the jup fix' 2026-09-22" }); writeJsonAtomic(D("change-registry.json"), cr); console.log("change registry recorded"); }
