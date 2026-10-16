// Classification rules — one definition, used by every script in this folder.
// AI_HW   = AI hardware / semiconductors: chip designers, foundries, memory/storage, semicap equipment, EDA,
//           AI servers, AI networking/optics.
// AI_MEGA = AI-adjacent mega-cap tech: the hyperscalers + Apple/Tesla (Magnificent-7 ex-NVDA) + ORCL + PLTR,
//           and the two EM mega-caps Tencent / Alibaba.
// AI_PWR  = AI-capex power / data-centre infrastructure (reported inside "other" as a memo line).
// CRYPTO  = spot crypto, spot crypto ETFs, crypto-treasury companies, miners, exchanges.
// INDEX   = broad / sector index funds (looked through with Alpha Vantage ETF_PROFILE holdings).
const AI_HW = new Set(("NVDA AVGO AMD MU INTC TSM ASML AMAT LRCX KLAC MRVL ARM QCOM TXN ADI MCHP NXPI ON STM MPWR TER ENTG " +
  "SNPS CDNS SMCI DELL HPE ANET CSCO CRDO ALAB COHR LITE CIEN FN WDC STX SNDK GFS SWKS QRVO RMBS AEIS ONTO NVMI CAMT " +
  "AMKR FORM ACLS MKSI UCTT ICHR LSCC SITM POWI SLAB SYNA MTSI SMTC WOLF ALGM AAOI CLS APH VRT SOXL SOXX SMH").split(/\s+/));
const AI_MEGA = new Set("MSFT GOOGL GOOG AMZN META AAPL TSLA ORCL PLTR".split(" "));
const AI_PWR = new Set("GEV VST CEG TLN BE PWR ETN OKLO SMR NRG EQIX DLR".split(" "));
const CRYPTO = new Set("IBIT ETHA FBTC GBTC MSTR BMNR COIN MARA RIOT CLSK HUT IREN CIFR WULF CORZ BITO".split(" "));
const INDEX = new Set("QQQ SPY VOO IVV XLK VGT EFA IWM EWJ EWG EEM VTI VXUS VTV VYM VO VWO VEA".split(" "));
const HW_DESC = /SEMICONDUCTOR|TAIWAN SEMI|SAMSUNG ELECTRONICS|SK HYNIX|SK SQUARE|MEDIATEK|TOKYO ELECTRON|ADVANTEST|ASML|ASM INTERNATIONAL|INFINEON|DISCO CORP|LASERTEC|ASE TECHNOLOGY|UNITED MICROELECTRONICS|HON HAI|DELTA ELECTRONICS|SAMSUNG ELECTRO-MECHANICS|RENESAS|STMICRO|BE SEMICONDUCTOR|SCREEN HOLDINGS|KOKUSAI|SOCIONEXT|QUANTA COMPUTER|WIWYNN|ACCTON|ELITE MATERIAL|ALCHIP|GLOBAL UNICHIP|NANYA|WINBOND|NOVATEK|REALTEK|ASPEED|KIOXIA/i;
const MEGA_DESC = /TENCENT|ALIBABA/i;

function base(sym) { // strip option / crypto suffixes; OCC option -> underlying
  if (/^[A-Z]{1,5}\d{6}[CP]\d{8}$/.test(sym)) return sym.replace(/\d{6}[CP]\d{8}$/, "");
  return sym;
}
// assetClass: Alpaca asset_class ("crypto"/"us_equity"/"us_option") or board cls ("Crypto"/"FX"/"Futures"/...)
function classify(sym, assetClass) {
  const s = base(sym), ac = String(assetClass || "").toLowerCase();
  if (ac === "crypto") return "CRYPTO";
  if (ac === "fx" || ac === "futures") return "OTHER";
  if (CRYPTO.has(s)) return "CRYPTO";
  if (INDEX.has(s)) return "INDEX";
  if (AI_HW.has(s)) return "AI_HW";
  if (AI_MEGA.has(s)) return "AI_MEGA";
  return "OTHER";
}
// Look-through of one fund's holdings list (Alpha Vantage ETF_PROFILE) -> {hw, mega}
// unnamedTop: optional {weight, as} to label an unnamed holding (documented assumption)
function lookThrough(profile, unnamedTop) {
  let hw = 0, mega = 0, covered = 0;
  for (const h of profile.holdings) {
    const w = +h.weight || 0; covered += w;
    const sym = (h.symbol || "").split(":")[0], d = h.description || "";
    if (unnamedTop && sym === "n/a" && d === "n/a" && Math.abs(w - unnamedTop.weight) < 1e-6) { if (unnamedTop.as === "AI_HW") hw += w; continue; }
    if (AI_HW.has(sym) || HW_DESC.test(d)) hw += w;
    else if (AI_MEGA.has(sym) || MEGA_DESC.test(d)) mega += w;
  }
  return { hw, mega, covered };
}
module.exports = { AI_HW, AI_MEGA, AI_PWR, CRYPTO, INDEX, classify, base, lookThrough };
