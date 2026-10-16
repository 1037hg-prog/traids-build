#!/usr/bin/env node
/**
 * R147 EARNINGS FETCH (2026-09-23). Pulls Alpha Vantage's full quarterly EARNINGS history (estimate, actual, report date,
 * pre/post-market) for each name in the frozen R147 universe, one call per name, into data/r147-earnings/<SYM>.json.
 * The free key allows 25 calls a day, so this runs nightly from the close chain and stops at MAX_PER_RUN or the first
 * rate-limit reply. It never refetches a name it already holds. It reads no prices and computes no outcome.
 *
 *   node backend/r147-fetch.js --freeze     write data/r147-universe.json once (refuses if it exists)
 *   node backend/r147-fetch.js              fetch up to MAX_PER_RUN missing names
 *   node backend/r147-fetch.js --status     coverage only
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto"); require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f), DIR = D("r147-earnings"), UNI = D("r147-universe.json");
const MAX_PER_RUN = 22, N = 100;
const KEY = process.env.ALPHAVANTAGE_KEY || process.env.ALPHA_VANTAGE_KEY;
// Exchange-traded products in the liquidity roster, plus second share classes (GOOG duplicates GOOGL's earnings). They have no earnings; excluding them by name keeps the 100 real companies.
const FUNDS = new Set(("SPY QQQ LQD IWM SMH SOXX HYG SOXL XLE XLF TLT GDX DRAM BITO GLD KRE TQQQ IGV XLP EFA EWY EEM IBIT XLI XLK RSP VCIT XBI XLU SQQQ " +
  "XLB EWZ TSLL IEFA XLY NVD VOO XLV XLC XLRE IVV VTI VEA VWO AGG BND SLV USO UNG TSLQ NVDL NVDX MSTU MSTX CONL SOXS UVXY VXX SVXY SPXL SPXS TNA TZA " +
  "SCHD JEPI JEPQ GOOG BRK.A DIA MDY IJH IJR VUG VTV VIG GDXJ ARKK KWEB FXI MCHI INDA EWJ EWT EWG EWU EWC EWA IEMG BIL SHY IEF GOVT SGOV TIP EMB JNK BKLN").split(" "));

if (process.argv.includes("--freeze")) {
  if (fs.existsSync(UNI)) { console.error("r147-universe.json exists — refusing to refreeze"); process.exit(2); }
  const u = JSON.parse(fs.readFileSync(D("universe-expanded.json"), "utf8"));
  const names = u.names.filter((n) => !FUNDS.has(n.sym)).slice(0, N).map((n) => n.sym);
  const body = { spec: "r147-universe-v1", frozenAt: new Date().toISOString(), source: "data/universe-expanded.json (built " + u.builtAt + "), ordered by median dollar volume",
    rule: `first ${N} names after removing exchange-traded funds listed in r147-fetch.js`, survivorship: "current membership — names that shrank or delisted since 2016 are absent; R147's primary statistic compares qualifiers with the OTHER reporters of this same list, which carries the same bias on both arms",
    names };
  body.sha256 = crypto.createHash("sha256").update(names.join(",")).digest("hex");
  writeJsonAtomic(UNI, body); console.log(`frozen ${names.length} names · sha ${body.sha256.slice(0, 12)}`); process.exit(0);
}

const uni = JSON.parse(fs.readFileSync(UNI, "utf8"));
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
const have = (s) => fs.existsSync(path.join(DIR, s + ".json"));
const missing = uni.names.filter((s) => !have(s));
const status = () => { const m = uni.names.filter((s) => !have(s)); console.log(`r147-fetch — ${uni.names.length - m.length}/${uni.names.length} names held${m.length ? `; ${m.length} to go (~${Math.ceil(m.length / MAX_PER_RUN)} night(s))` : " — COMPLETE, R147 can be read"}`); };
if (process.argv.includes("--status") || !missing.length) { status(); process.exit(0); }
if (!KEY) { console.error("r147-fetch: no Alpha Vantage key"); process.exit(1); }

(async () => {
  let got = 0;
  for (const sym of missing.slice(0, MAX_PER_RUN)) {
    const r = await fetch(`https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(sym)}&apikey=${KEY}`, { signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    // AV's limit message quotes the API key back; log only that the limit was hit, never the message text.
    if (j.Note || j.Information) { console.log(`  daily Alpha Vantage limit reached after ${got} name(s) this run — the rest continue next night`); break; }
    if (!r.ok) { console.log(`  ${sym}: HTTP ${r.status} — retry next run`); continue; }
    const q = j.quarterlyEarnings || [];
    // An empty reply is recorded (so the name is not re-asked forever) and counted as "no earnings history" at read time.
    writeJsonAtomic(path.join(DIR, sym + ".json"), { sym, fetchedAt: new Date().toISOString(), source: "alphavantage EARNINGS", rows: q.length, quarterlyEarnings: q });
    got++; await new Promise((res) => setTimeout(res, 1500));
  }
  status();
})().catch((e) => { console.error("r147-fetch FAILED:", e.message); process.exit(1); });
