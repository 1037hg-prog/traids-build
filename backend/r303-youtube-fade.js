#!/usr/bin/env node
/**
 * R303 — Fade YouTube stock-pick calls (registered 2026-10-01, family YT-FADE). The registry wins; this file implements it.
 *
 *   CHANNELS  yt-dlp 'ytsearch100:' for the six registered queries; keep channels in >= 2 of the 6 result lists; drop news/media
 *             outlets and channels with < 100 uploads; rank by channel_follower_count; top 20 -> data/training/r303/channels.json,
 *             written BEFORE any title is parsed.
 *   VIDEOS    every upload (long-form, Shorts, live replays: the channel's UU uploads playlist) uploaded 2023-01-01..2026-08-28 ET.
 *             Titles via --flat-playlist; the precise timestamp (yt-dlp timestamp, else release_timestamp, else upload_date 00:00 ET
 *             + 1 day) fetched per candidate video.
 *   CALLS     title only, mechanical: tickers ($TICKER, uppercase 2-5 letter common-stock symbols off the common-word stoplist, or a
 *             company-name match), direction by the registered keyword lists (negative wins). One call per ticker per title.
 *   PRECISION 200 calls drawn uniformly (seeded) and hand-labelled (ticker AND direction) by the builder; < 80% = CANNOT MEASURE.
 *             The extractor is frozen after the check: its source hash is recorded and --read refuses on a mismatch.
 *   TRADE     entry = first regular-session OPEN strictly after the upload timestamp; exit = CLOSE of entry session +4 (H5) / +19
 *             (H20). FADE = -dir x (stock - SPY) over the same open->close span. Alpaca SIP daily, adjustment=all, delisted kept.
 *             Same channel + same name inside the previous 5 sessions = duplicate, dropped.
 *   COST      0.20% round trip + 3%/yr borrow pro rata on the short leg.
 *   STAT      weekly calendar time: per entry week, mean over channels of the channel's mean net fade that week; one-sample
 *             Newey-West t over weeks (lag 1 H5, lag 4 H20); headline = better cell; bar = registry bar.tRequired (best-of-2).
 *   CONTROLS  placebo (random common stock from the same 60-session dollar-volume decile, same entry/direction, 500 draws; observed
 *             must beat p95), halves (both positive), FOLLOW mirror, concentration, per-channel, top-1000-by-$volume borrow check.
 *
 *   ORDER (registered; each step refuses to run before its predecessor's file exists):
 *     node backend/r303-youtube-fade.js --channels    1) search + channel selection -> channels.json
 *     node backend/r303-youtube-fade.js --assets      (inputs) Alpaca us_equity assets (all statuses) + dictionary check of words
 *     node backend/r303-youtube-fade.js --videos      2) uploads listing + precise timestamps per candidate (cached per channel)
 *     node backend/r303-youtube-fade.js --calls       3) calls.json from titles only (no prices touched)
 *     node backend/r303-youtube-fade.js --precision   4) draws the 200-call sample (first run) / scores the builder's labels and
 *                                                        writes precision-check.json with every label + the extractor hash
 *     node backend/r303-youtube-fade.js --selftest    known answers (must pass; --read runs it again)
 *     node backend/r303-youtube-fade.js --read        5) prices + returns ONCE -> data/r303-youtube-fade.json
 *   Diagnostics that never touch prices: --inspect (title-only token/key frequencies, used to finish the stoplist before the draw).
 *   --fetch fills the Alpaca price cache only (resumable; computes and prints no return); --read fills anything still missing.
 *
 * ANONYMOUS ONLY. yt-dlp is called with --ignore-config and never with cookies, a login, a proxy or any bot-check workaround (the
 * wrapper refuses those arguments). A "confirm you're not a bot" / sign-in wall writes training/r303/botwall.json, stops every pull,
 * and --read then writes CANNOT MEASURE.
 *
 * DEFINITIONAL CHOICES (fixed here before any price or return was fetched):
 *  D1 "news/media outlet": the registry's named list (and its own sub-channels, e.g. CNBC Television) plus other channels operated by
 *     a news organisation or financial-news publisher (TV network, newspaper/magazine, wire, financial news site). The Motley Fool is
 *     kept by the registry; pick publishers of the same kind (MarketBeat-type stock-pick publishers) are kept by the same reasoning.
 *     Every drop is written with its reason into channels.json.
 *  D2 uploads = the channel's UU uploads playlist (all public uploads: long-form, Shorts, live replays); "< 100 videos" = its
 *     playlist_count < 100.
 *  D3 "candidate video" (the one whose precise timestamp is fetched) = an upload whose title yields >= 1 call under the extractor
 *     and whose position in the newest-first uploads list is before the window-start boundary (+50 positions of slack), the boundary
 *     found by binary search on precise timestamps. The window itself is applied on the precise timestamp (ET calendar date).
 *     A video whose metadata cannot be read (private / members-only / removed) has no timestamp and makes no call (counted).
 *  D4 common stock = Alpaca us_equity asset (active or inactive) on NYSE/NASDAQ/AMEX/ARCA/BATS, symbol /^[A-Z]{1,5}$/, a non-empty
 *     name that is not a fund/ETF/ETN/trust/note/warrant/right/unit/preferred, and not typed ETF in the cached Alpha Vantage listing.
 *     ADRs are kept. Inactive assets Alpaca has moved to OTC are not listed common stock and are out (bankrupt names renamed to a
 *     ...Q symbol cannot be matched from the old ticker in any case - disclosed).
 *  D5 "dictionary word" = the lowercase form is accepted by the Microsoft Word en-US spell checker (CheckSpelling, empty custom
 *     dictionary), plus a short supplement of modern common words (crypto, bitcoin, ...) that Word lacks. Tickers whose lowercase
 *     form is a dictionary word are on the common-word stoplist (the registry's "etc."; e.g. NOW, ALL, CAN are of this kind), as are
 *     finance/news acronyms; both lists are frozen with the extractor. $TICKER cashtags bypass the stoplist.
 *  D6 company-name key = the first word of the asset name with >= 4 letters (letters only) that is not a dictionary word; a key
 *     shared by several common stocks resolves to the single active one, else it is dropped. Matched case-insensitively as a word.
 *  D7 keywords match as whole words/phrases, case-insensitive, after normalising curly quotes; exactly the registered forms (no
 *     stemming), with "don't buy" also matching "dont buy" / "do not buy".
 *  D8 duplicate = an earlier call (kept or not) by the same channel on the same ticker whose entry session is 0..5 sessions before.
 *  D9 exit when the name has no bar at the exit session (halt / delisting) = its last close on or before the exit session.
 *  D10 borrow: 3%/yr x calendar nights held (entry date -> exit date) on the short leg of every pair (each pair has one short leg);
 *      the stock-leg-only reading is reported as a sensitivity. FOLLOW is charged the same (its own) costs.
 *  D11 placebo decile: 60-session average dollar volume (close x volume, sessions e-60..e-1, >= 20 bars) among common stocks with
 *      a bar at the entry session; a called name with fewer prior bars is placed by its available average (none -> any decile).
 *  D12 week = Monday-start calendar week of the ENTRY date; halves = first / second half of the weeks with calls (ceil split).
 *  D13 "< 1,000 calls" and "< 100 weeks" are counted on the analysed set (in window, priced at entry, after duplicates).
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { spawn } = require("child_process");
const { writeJsonAtomic } = require("./lib/atomic-write.js");

const ID = "R303";
const D = (f) => path.join(__dirname, "data", f);
const CACHE = D("training/r303"), OUT = D("r303-youtube-fade.json");
const F = {
  channels: path.join(CACHE, "channels.json"), assets: path.join(CACHE, "assets.json"), dict: path.join(CACHE, "dictionary-words.json"),
  calls: path.join(CACHE, "calls.json"), sample: path.join(CACHE, "precision-sample.json"), labels: path.join(CACHE, "precision-labels.json"),
  precision: path.join(CACHE, "precision-check.json"), botwall: path.join(CACHE, "botwall.json"), barsDir: path.join(CACHE, "bars"),
};
const YTDLP = path.join(process.env.USERPROFILE || "C:\\Users\\joshc", ".local", "bin", "yt-dlp.exe");
const QUERIES = ["stocks to buy now", "best stocks to buy", "stock picks this week", "stocks I'm buying", "growth stocks to buy", "stock to buy before it explodes"];
const N_SEARCH = 100, MIN_LISTS = 2, TOP_N = 20, MIN_UPLOADS = 100;
const UPLOAD_FIRST = "2023-01-01", UPLOAD_LAST = "2026-08-28", ENTRY_FIRST = "2023-01-03", ENTRY_LAST = "2026-08-31";
const CELLS = { H5: 4, H20: 19 }, NW_LAG = { H5: 1, H20: 4 };
const COST_RT = 0.0020, BORROW = 0.03, DUP_SESSIONS = 5;
const PLACEBO_DRAWS = 500, ADV_N = 60, ADV_MIN_BARS = 20, SEED = 303303;
const PRECISION_N = 200, PRECISION_MIN = 0.80, PRECISION_SEED = 20261001, MIN_CALLS = 1000, MIN_WEEKS = 100, TOP_ADV = 1000;
const BOUNDARY_SLACK = 50, TS_BATCH = 20, TS_CONCURRENCY = 3;
const BARS_START = "2022-08-01T00:00:00Z", BARS_END = "2026-09-30T20:00:00Z";   // explicit 16:00 ET end; no current-day request
const EXCHANGES = new Set(["NYSE", "NASDAQ", "AMEX", "ARCA", "BATS", "NYSEARCA"]);

const mode = ["--channels", "--assets", "--videos", "--calls", "--precision", "--selftest", "--read", "--inspect", "--fetch"].find((m) => process.argv.includes(m)) || "--selftest";
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
const dayNum = (s) => Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5);
const numDay = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const addDays = (s, n) => numDay(dayNum(s) + n);
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ───────────────────────────── ET time + entry rule ─────────────────────────────
const ET_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function etParts(sec) {
  const p = Object.fromEntries(ET_FMT.formatToParts(new Date(sec * 1000)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, sod: (+p.hour) * 3600 + (+p.minute) * 60 + (+p.second) };
}
function etMidnightSec(date) {
  const base = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 1000;
  for (const off of [4, 5]) { const s = base + off * 3600, p = etParts(s); if (p.date === date && p.sod === 0) return s; }
  throw new Error("ET midnight not resolvable for " + date);
}
/** precise upload time: timestamp, else release_timestamp, else upload_date at 00:00 ET + 1 day (registered fallback order) */
function resolveTs(m) {
  if (m && Number.isFinite(m.timestamp)) return { ts: m.timestamp, src: "timestamp" };
  if (m && Number.isFinite(m.release_timestamp)) return { ts: m.release_timestamp, src: "release_timestamp" };
  if (m && /^\d{8}$/.test(m.upload_date || "")) { const d = `${m.upload_date.slice(0, 4)}-${m.upload_date.slice(4, 6)}-${m.upload_date.slice(6, 8)}`; return { ts: etMidnightSec(addDays(d, 1)), src: "upload_date+1d" }; }
  return null;
}
const OPEN_SOD = 9 * 3600 + 30 * 60;
/** index of the first regular-session OPEN strictly after `sec` (sessions = sorted YYYY-MM-DD), or -1 if beyond the calendar */
function entryIdx(sec, sessions) {
  const { date, sod } = etParts(sec);
  let i = lowerBound(sessions, date);
  if (i < sessions.length && sessions[i] === date && sod >= OPEN_SOD) i++;
  return i < sessions.length ? i : -1;
}
const mondayOf = (date) => { const n = dayNum(date); return numDay(n - ((n + 3) % 7)); };

// ───────────────────────────── statistics ─────────────────────────────
/** Newey-West t of the mean (Bartlett weights, lag L, autocovariances /n) */
function nwT(a, L) {
  const n = a.length; if (n < 3) return null;
  const m = mean(a), d = a.map((x) => x - m);
  let v = d.reduce((s, x) => s + x * x, 0) / n;
  for (let k = 1; k <= L; k++) { let c = 0; for (let i = k; i < n; i++) c += d[i] * d[i - k]; v += 2 * (1 - k / (L + 1)) * c / n; }
  return v > 0 ? m / Math.sqrt(v / n) : null;
}
/** weekly calendar-time series: per week, mean over channels of that channel's mean value */
function weeklySeries(rows, valOf) {
  const byW = new Map();
  for (const r of rows) { let w = byW.get(r.week); if (!w) byW.set(r.week, (w = new Map())); let c = w.get(r.channelId); if (!c) w.set(r.channelId, (c = [])); c.push(valOf(r)); }
  return [...byW.keys()].sort().map((wk) => { const ch = [...byW.get(wk).values()]; return { week: wk, v: mean(ch.map(mean)), channels: ch.length, calls: ch.reduce((s, a) => s + a.length, 0) }; });
}
function cellStat(rows, valOf, lag) {
  const ws = weeklySeries(rows, valOf), v = ws.map((w) => w.v);
  return { tNet: v.length > 2 ? nwT(v, lag) : null, meanNet: v.length ? mean(v) : null, n: v.length, nwLag: lag, series: ws };
}

// ───────────────────────────── trade arithmetic (pure) ─────────────────────────────
/** one call's pair trade: dir +1 LONG-call / -1 SHORT-call; FADE = -dir x (stock - SPY) over open(entry) -> close(exit) */
function fadeTrade(dir, sOpen, sClose, mOpen, mClose, nights) {
  const rs = sClose / sOpen - 1, rm = mClose / mOpen - 1, gross = -dir * (rs - rm);
  const borrow = BORROW * nights / 365, cost = COST_RT + borrow;
  const costStockLegOnlyFade = COST_RT + (dir > 0 ? borrow : 0), costStockLegOnlyFollow = COST_RT + (dir < 0 ? borrow : 0);
  return { rs, rm, gross, cost, net: gross - cost, followNet: -gross - cost, netStockLegBorrowOnly: gross - costStockLegOnlyFade, followNetStockLegBorrowOnly: -gross - costStockLegOnlyFollow };
}
/** D8: drop a call when the same channel called the same ticker with an entry 0..5 sessions earlier (kept or not) */
function dedupe(calls) {
  const sorted = [...calls].sort((a, b) => a.e - b.e || a.ts - b.ts || String(a.videoId).localeCompare(String(b.videoId)));
  const last = new Map(), kept = [], dropped = [];
  for (const c of sorted) {
    const k = c.channelId + "|" + c.ticker, prev = last.get(k);
    if (prev != null && c.e - prev <= DUP_SESSIONS) dropped.push(c); else kept.push(c);
    last.set(k, c.e);
  }
  return { kept, dropped };
}

/* <<EXTRACTOR-BEGIN>> */
// The call extractor. Frozen after the precision check: --precision records sha256 of the text between the two markers and
// --read refuses to run if it changed. Everything that decides WHICH call a title makes lives here.
const STOP_SEED = ["A", "I", "IT", "ON", "NOW", "ALL", "ARE", "BIG", "CAN", "FOR", "NEW", "ONE", "SO", "AI", "DD", "CEO", "USA", "GDP", "CPI", "FED", "IPO", "ETF", "ATH", "EPS", "YOLO"];
// Finished 2026-10-01 from a title-only inspection of the 20 channels' uploads (token / name-key hit lists; no price, no return,
// no timestamp read), BEFORE the precision draw. Categories, applied as categories: finance / macro / agency / index / crypto /
// place / time-zone / media acronyms (tokens), and generic proper nouns (days, months, places and demonyms, personal names,
// crypto coins, index / exchange names) among the name keys.
const STOP_ACRONYMS = ["US", "UK", "EU", "UAE", "NYC", "LA", "SF", "DC", "DOW", "SPX", "NDX", "NYSE", "IRS", "SEC", "FBI", "CIA", "NSA", "TSA", "DOJ", "FTC", "FDA", "EPA", "DOE", "DOGE", "NASA", "NATO", "OPEC", "IMF", "ECB", "BOJ", "PBOC", "CCP", "GOP", "MAGA", "POTUS",
  "CFO", "COO", "CTO", "SPAC", "OTC", "ADR", "REIT", "BDC", "MLP", "LLC", "ROI", "ROE", "ROIC", "PE", "PEG", "FCF", "DCF", "TAM", "CAGR", "YTD", "YOY", "QOQ", "EBIT", "EBITDA", "PPI", "PCE", "FOMC", "NFP", "PMI", "ISM", "JOLTS", "IRA", "HSA", "FSA", "TFSA", "RRSP", "ROTH", "HYSA", "APR", "APY", "CD", "TIPS",
  "AM", "PM", "ET", "PT", "EST", "PST", "EOD", "EOW", "TV", "CNBC", "WSJ", "ESPN", "NFL", "NBA", "MLB", "NHL", "UFC", "CES", "GTC", "WWDC", "GTA", "GT", "PS", "AR", "VR", "XR", "ML", "AGI", "ASI", "LLM", "GPU", "CPU", "TPU", "API", "IOT", "SAAS", "EV", "EVS", "BEV", "LNG", "DTE", "ODTE", "LEAPS", "IV", "OI", "VIX", "ES", "NQ", "RTY", "YM",
  "BTC", "ETH", "SOL", "XRP", "ADA", "SHIB", "BNB", "NFT", "NFTS", "DCA", "FOMO", "FUD", "HODL", "WSB", "LFG", "OMG", "WTF", "LOL", "IMO", "NFA", "TLDR", "RSI", "MACD", "EMA", "SMA", "VWAP", "ATR", "ESG", "DEI", "CFA", "CPA", "MBA", "PHD", "II", "III", "IV", "JR", "SR", "HR", "PR", "QA", "SEO", "ATM", "PPP", "SBA", "USD", "CAD", "EUR", "GBP", "JPY", "CNY"];
const DICT_SUPPLEMENT = [];   // none needed: no modern common word (bitcoin, crypto, ...) surfaced as a key or token in the inspection
const NAMEKEY_STOP = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
  "nasdaq", "russell", "korea", "vegas", "british", "european", "ireland", "chesapeake", "alaska", "taiwan", "dutch", "america", "american", "china", "chinese", "japan", "japanese", "india", "indian", "israel", "canada", "mexico", "brazil", "europe", "texas", "florida", "california",
  "robert", "ryan", "taylor", "greene", "ives", "saul", "armstrong", "oscar", "solana", "bitcoin", "ethereum", "dogecoin"];
const NEG_KW = ["sell", "selling", "sold", "short", "bearish", "crash", "avoid", "warning", "dump", "overvalued", "bubble", "collapse", "don't buy", "dont buy", "do not buy", "stay away", "get out"];
const POS_KW = ["buy", "buying", "bought", "bullish", "to buy", "load", "loading", "accumulate", "undervalued", "explode", "skyrocket", "soar", "moon", "10x", "100x", "millionaire", "rally", "breakout", "next nvidia", "huge upside", "all in", "best stock"];
const FUND_NAME = /\b(etfs?|etns?|funds?|ishares|spdr|proshares|direxion|invesco|vanguard|wisdomtree|vaneck|graniteshares|yieldmax|roundhill|defiance|tradr|index|indexed|notes?|warrants?|rights?|units?|preferred|pfd|debentures?|depositary shares representing|ultrapro|ultrashort|leveraged|inverse)\b/i;
const TRUST_NAME = /\btrust\b/i, TRUST_CORP = /\b(corp|corporation|bancorp|bank|bancshares|inc|company|financial)\b/i;
const kwRe = (list) => new RegExp("(?<![a-z0-9])(?:" + list.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")).join("|") + ")(?![a-z0-9])", "i");
const NEG_RE = kwRe(NEG_KW), POS_RE = kwRe(POS_KW);
const normTitle = (t) => String(t || "").replace(/[\u2018\u2019\u201B\u0060\u00B4\u2032]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, " ").trim();
/** D4: is an Alpaca asset a US common stock for R303 */
function isCommon(a, avEtf) {
  if (!a || a.class !== "us_equity" || !EXCHANGES.has(a.exchange) || !/^[A-Z]{1,5}$/.test(a.symbol || "")) return false;
  const nm = String(a.name || "").trim();
  if (!nm) return false;                                  // an unnamed (inactive) asset cannot be verified as common stock
  if (FUND_NAME.test(nm)) return false;
  if (TRUST_NAME.test(nm) && !TRUST_CORP.test(nm)) return false;
  if (avEtf && avEtf.has(a.symbol)) return false;
  return true;
}
/** build the frozen lookup: symbols, the common-word stoplist, and the company-name keys */
function buildUniverse(assets, dictWords, avEtf) {
  const dict = new Set([...dictWords, ...DICT_SUPPLEMENT].map((w) => w.toLowerCase()));
  const common = assets.filter((a) => isCommon(a, avEtf)).sort((x, y) => x.symbol.localeCompare(y.symbol));
  const symbols = new Map(common.map((a) => [a.symbol, a]));
  const stop = new Set([...STOP_SEED, ...STOP_ACRONYMS]);
  for (const s of symbols.keys()) if (dict.has(s.toLowerCase())) stop.add(s);
  const byKey = new Map(), nkStop = new Set(NAMEKEY_STOP.map((w) => w.toLowerCase()));
  for (const a of common) {
    const words = String(a.name || "").split(/[^A-Za-z0-9]+/).filter(Boolean);
    const key = words.find((w) => /^[A-Za-z]{4,}$/.test(w) && !dict.has(w.toLowerCase()));
    if (!key || nkStop.has(key.toLowerCase())) continue;
    const k = key.toLowerCase(); (byKey.get(k) || byKey.set(k, []).get(k)).push(a);
  }
  const nameKeys = new Map(), ambiguous = [];
  for (const [k, list] of byKey) {
    const syms = [...new Set(list.map((a) => a.symbol))];
    if (syms.length === 1) { nameKeys.set(k, syms[0]); continue; }
    const act = [...new Set(list.filter((a) => a.status === "active").map((a) => a.symbol))];
    if (act.length === 1) nameKeys.set(k, act[0]); else ambiguous.push(k);
  }
  return { symbols, stop, nameKeys, ambiguous, dictSize: dict.size };
}
/** title -> [{ticker, dir, via}]; dir +1 = LONG-call, -1 = SHORT-call */
function extractCalls(title, U) {
  const t = normTitle(title);
  const dir = NEG_RE.test(t) ? -1 : POS_RE.test(t) ? 1 : 0;
  if (!dir) return [];
  const out = new Map();
  for (const m of t.matchAll(/\$([A-Za-z]{1,5})(?![A-Za-z0-9])/g)) { const s = m[1].toUpperCase(); if (U.symbols.has(s) && !out.has(s)) out.set(s, "cashtag"); }
  for (const m of t.matchAll(/(?<![A-Za-z0-9$])([A-Z]{2,5})(?![A-Za-z0-9])/g)) { const s = m[1]; if (U.symbols.has(s) && !U.stop.has(s) && !out.has(s)) out.set(s, "token"); }
  for (const m of t.matchAll(/[A-Za-z]+/g)) { const s = U.nameKeys.get(m[0].toLowerCase()); if (s && !out.has(s)) out.set(s, "name:" + m[0].toLowerCase()); }
  return [...out].map(([ticker, via]) => ({ ticker, dir, via }));
}
/* <<EXTRACTOR-END>> */
function extractorSource() { const src = fs.readFileSync(__filename, "utf8"), a = src.indexOf("/* <<EXTRACTOR-BEGIN>> */"), b = src.indexOf("/* <<EXTRACTOR-END>> */"); if (a < 0 || b < a) throw new Error("extractor markers missing"); return src.slice(a, b); }
const extractorHash = () => sha256(extractorSource().replace(/\r\n/g, "\n"));

// ───────────────────────────── yt-dlp (anonymous only) ─────────────────────────────
const FORBIDDEN_ARG = /^--(cookies|cookies-from-browser|username|password|netrc|netrc-location|netrc-cmd|proxy|geo-verification-proxy|ap-mso|ap-username|ap-password|video-password|client-certificate|client-certificate-key|xff|geo-bypass)/i;
const BOT_RE = /not a bot|confirm you.?re not a robot|Sign in to confirm you.?re not/i, RATE_RE = /HTTP Error 429|Too Many Requests/i;
class BotWall extends Error {}
class RateLimited extends Error {}
function ytdlp(args, { timeoutMs = 3 * 3600e3 } = {}) {
  for (const a of args) if (FORBIDDEN_ARG.test(String(a))) throw new Error(`refused argument ${a}: R303 pulls anonymously only`);
  if (fs.existsSync(F.botwall)) return Promise.reject(new BotWall("a bot wall was recorded earlier (botwall.json) - pulling stays stopped"));
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, ["--ignore-config", "--no-progress", ...args], { windowsHide: true });
    let out = "", err = "";
    p.stdout.setEncoding("utf8"); p.stderr.setEncoding("utf8");
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    const to = setTimeout(() => p.kill(), timeoutMs);
    p.on("error", (e) => { clearTimeout(to); reject(e); });
    p.on("close", (code) => {
      clearTimeout(to);
      if (BOT_RE.test(err)) {
        try { writeJsonAtomic(F.botwall, { at: new Date().toISOString(), target: String(args[args.length - 1]).slice(0, 200), stderr: err.split(/\r?\n/).filter((l) => BOT_RE.test(l)).slice(0, 5) }); } catch {}
        return reject(new BotWall("YouTube bot / sign-in wall: " + (err.split(/\r?\n/).find((l) => BOT_RE.test(l)) || "").slice(0, 200)));
      }
      if (RATE_RE.test(err)) return reject(new RateLimited("HTTP 429 from YouTube: " + err.slice(0, 200)));
      resolve({ code, out, err });
    });
  });
}
const uuOf = (channelId) => "UU" + channelId.slice(2);

// ───────────────────────────── step 1: channels ─────────────────────────────
const MEDIA_NAMED = [/\bcnbc\b/i, /\bbloomberg\b/i, /\byahoo\s*finance\b/i, /\bfox\s*business\b/i, /\bwsj\b/i, /wall street journal/i, /\breuters\b/i, /\bmarketwatch\b/i, /\bbenzinga\b/i, /\bbarron'?s\b/i, /investor'?s business daily/i, /\bmorningstar\b/i];
// D1 equivalents: news organisations / financial-news publishers (decided on channel NAMES, before any title is parsed)
const MEDIA_OTHER = [/^thestreet$/i, /\bforbes\b/i, /business insider/i, /\bcnn\b/i, /financial times/i, /\bschwab network\b/i, /\bfortune\b/i, /\bkiplinger\b/i, /\binvestopedia\b/i, /\bthe economist\b/i, /\bnbc news\b/i, /\babc news\b/i, /\bcbs news\b/i, /\bsky news\b/i, /\bbbc\b/i, /\bfox news\b/i, /\bnewsmax\b/i, /\btastylive\b/i, /\bndtv\b/i, /\bsumantv\b/i, /\bzee business\b/i, /\bet now\b/i, /\bmoneycontrol\b/i];   // brokers, exchanges and pick publishers (Zacks, Seeking Alpha) are not news outlets: not dropped
function mediaReason(name) {
  if (/motley fool/i.test(name)) return null;     // registry: kept, it publishes picks
  if (MEDIA_NAMED.some((r) => r.test(name))) return "news/media outlet (registry list)";
  if (MEDIA_OTHER.some((r) => r.test(name))) return "news/media outlet (D1 equivalent)";
  return null;
}
async function doChannels() {
  fs.mkdirSync(CACHE, { recursive: true });
  if (fs.existsSync(F.channels)) { console.log("channels.json exists - frozen; not re-selecting"); return; }
  const lists = [];
  for (let i = 0; i < QUERIES.length; i++) {
    const f = path.join(CACHE, `search-${i + 1}.json`);
    if (!fs.existsSync(f)) {
      const r = await ytdlp(["--flat-playlist", "-J", "--sleep-requests", "1", `ytsearch${N_SEARCH}:${QUERIES[i]}`]);
      if (r.code !== 0 && !r.out) throw new Error(`search "${QUERIES[i]}" failed: ${r.err.slice(0, 300)}`);
      const j = JSON.parse(r.out);
      const entries = (j.entries || []).map((e) => ({ id: e.id, channel: e.channel || e.uploader || null, channel_id: e.channel_id || null, uploader_id: e.uploader_id || null }));
      writeJsonAtomic(f, { query: QUERIES[i], fetchedAt: new Date().toISOString(), n: entries.length, entries });
      console.log(`[r303] search ${i + 1}/6 "${QUERIES[i]}": ${entries.length} results`);
    }
    lists.push(readJson(f));
  }
  const tally = new Map();
  lists.forEach((l, li) => { for (const e of l.entries) { if (!e.channel_id) continue; let t = tally.get(e.channel_id); if (!t) tally.set(e.channel_id, (t = { channel_id: e.channel_id, name: e.channel, handle: e.uploader_id, lists: new Set() })); t.lists.add(li + 1); } });
  const cands = [...tally.values()].filter((t) => t.lists.size >= MIN_LISTS).map((t) => ({ channel_id: t.channel_id, name: t.name, handle: t.handle, lists: [...t.lists].sort() }));
  console.log(`[r303] ${tally.size} distinct channels; ${cands.length} appear in >= ${MIN_LISTS} lists`);
  for (const c of cands) {
    c.mediaDrop = mediaReason(`${c.name || ""}`) || mediaReason(`${c.handle || ""}`.replace(/^@/, ""));
    const mf = path.join(CACHE, `meta-${c.channel_id}.json`);
    if (!c.mediaDrop) {
      if (!fs.existsSync(mf)) {
        let fol = null, cname = c.name;
        for (const tab of ["videos", "shorts", "streams", ""]) {
          const r = await ytdlp(["--flat-playlist", "-J", "--playlist-items", "1", `https://www.youtube.com/channel/${c.channel_id}${tab ? "/" + tab : ""}`]);
          if (r.out) { try { const j = JSON.parse(r.out); if (Number.isFinite(j.channel_follower_count)) { fol = j.channel_follower_count; cname = j.channel || cname; break; } } catch {} }
        }
        const u = await ytdlp(["--flat-playlist", "-J", "--playlist-items", "1", `https://www.youtube.com/playlist?list=${uuOf(c.channel_id)}`]);
        let uploads = null; if (u.out) { try { uploads = JSON.parse(u.out).playlist_count; } catch {} }
        writeJsonAtomic(mf, { channel_id: c.channel_id, name: cname, followers: fol, uploads, fetchedAt: new Date().toISOString() });
        await nap(800);
      }
      const m = readJson(mf); c.followers = m.followers; c.uploads = m.uploads; c.name = m.name || c.name;
    }
  }
  const eligible = cands.filter((c) => !c.mediaDrop).map((c) => ({ ...c, smallDrop: !(c.uploads >= MIN_UPLOADS) ? `uploads ${c.uploads} < ${MIN_UPLOADS}` : null }));
  const ranked = eligible.filter((c) => !c.smallDrop && Number.isFinite(c.followers)).sort((a, b) => b.followers - a.followers || a.channel_id.localeCompare(b.channel_id));
  const top = ranked.slice(0, TOP_N).map((c, i) => ({ rank: i + 1, channel_id: c.channel_id, name: c.name, handle: c.handle, followers: c.followers, uploads: c.uploads, lists: c.lists }));
  writeJsonAtomic(F.channels, {
    id: ID, writtenAt: new Date().toISOString(), note: "written BEFORE any title is parsed (registry order); channel names stay internal",
    queries: QUERIES.map((q, i) => ({ query: q, results: lists[i].n })), distinctChannels: tally.size, inTwoOrMoreLists: cands.length,
    candidates: cands.map((c) => ({ channel_id: c.channel_id, name: c.name, handle: c.handle, lists: c.lists, followers: c.followers ?? null, uploads: c.uploads ?? null, drop: c.mediaDrop || (eligible.find((e) => e.channel_id === c.channel_id) || {}).smallDrop || (!Number.isFinite(c.followers) && !c.mediaDrop ? "follower count unavailable" : null) })),
    channels: top,
  });
  console.log(`[r303] channels.json written: top ${top.length} of ${ranked.length} eligible`);
  for (const c of top) console.log(`  ${String(c.rank).padStart(2)} ${String(c.followers).padStart(9)} subs  ${String(c.uploads).padStart(6)} uploads  lists ${c.lists.join(",")}  ${c.name}`);
}

// ───────────────────────────── inputs: assets + dictionary ─────────────────────────────
function loadAvEtf() {
  const set = new Set(), stock = new Set();
  for (const f of ["av-listing-status-active-2026-09-23.csv", "av-listing-status-delisted-2026-09-23.csv"]) {
    if (!fs.existsSync(D(f))) continue;
    const lines = fs.readFileSync(D(f), "utf8").split(/\r?\n/).slice(1);
    for (const l of lines) { const sym = l.split(",")[0]; if (!sym) continue; if (/,ETF,/.test(l)) set.add(sym); else if (/,Stock,/.test(l)) stock.add(sym); }
  }
  for (const s of stock) set.delete(s);    // a symbol AV also lists as Stock (reuse) is not excluded on the AV flag alone
  return set;
}
async function doAssets() {
  if (!fs.existsSync(F.channels)) throw new Error("order: run --channels first");
  require("dotenv").config({ path: path.join(__dirname, ".env") });
  const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY, Accept: "application/json" };
  if (!H["APCA-API-KEY-ID"]) throw new Error("ALPACA keys missing in backend/.env");
  if (!fs.existsSync(F.assets)) {
    let list = null;
    for (const url of ["https://paper-api.alpaca.markets/v2/assets?status=all&asset_class=us_equity", "https://paper-api.alpaca.markets/v2/assets?asset_class=us_equity"]) {
      const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(120000) });
      if (r.ok) { list = await r.json(); if (Array.isArray(list) && list.some((a) => a.status === "inactive")) break; }
    }
    if (!Array.isArray(list) || !list.length) throw new Error("Alpaca assets fetch failed");
    const slim = list.map((a) => ({ symbol: a.symbol, name: a.name, exchange: a.exchange, status: a.status, class: a.class, tradable: a.tradable }));
    writeJsonAtomic(F.assets, { fetchedAt: new Date().toISOString(), source: "Alpaca /v2/assets us_equity, all statuses", n: slim.length, active: slim.filter((a) => a.status === "active").length, inactive: slim.filter((a) => a.status === "inactive").length, assets: slim });
  }
  const A = readJson(F.assets), avEtf = loadAvEtf();
  const common = A.assets.filter((a) => isCommon(a, avEtf));
  console.log(`[r303] assets ${A.n} (active ${A.active}, inactive ${A.inactive}); common stocks by D4: ${common.length}`);
  // dictionary check (D5): lowercase forms of every 2-5 letter symbol and every >= 4-letter alphabetic name word
  const words = new Set();
  for (const a of common) { if (a.symbol.length >= 2) words.add(a.symbol.toLowerCase()); for (const w of String(a.name || "").split(/[^A-Za-z0-9]+/)) if (/^[A-Za-z]{4,}$/.test(w)) words.add(w.toLowerCase()); }
  let prior = fs.existsSync(F.dict) ? readJson(F.dict) : { checked: [], accepted: [] };
  const todo = [...words].filter((w) => !prior.checked.includes(w)).sort();
  if (todo.length) {
    const inF = path.join(CACHE, "dict-input.txt"), outF = path.join(CACHE, "dict-output.txt");
    fs.writeFileSync(inF, todo.join("\n"), "utf8");
    const ps = `$ErrorActionPreference='Stop'; $w = New-Object -ComObject Word.Application; $w.Visible=$false; try { $ok = New-Object System.Collections.Generic.List[string]; foreach($x in [IO.File]::ReadAllLines('${inF.replace(/'/g, "''")}')) { if ($x -and $w.CheckSpelling($x)) { $ok.Add($x) } }; [IO.File]::WriteAllLines('${outF.replace(/'/g, "''")}', $ok) } finally { $w.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($w) }`;
    console.log(`[r303] dictionary check of ${todo.length} words via Word CheckSpelling ...`);
    await new Promise((res, rej) => { const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true }); let e = ""; p.stderr.on("data", (d) => (e += d)); p.on("close", (c) => (c === 0 ? res() : rej(new Error("Word dictionary check failed: " + e.slice(0, 300))))); });
    const acc = fs.readFileSync(outF, "utf8").split(/\r?\n/).filter(Boolean);
    prior = { source: "Microsoft Word en-US CheckSpelling on the lowercase form (custom dictionary empty)", checkedAt: new Date().toISOString(), checked: [...prior.checked, ...todo].sort(), accepted: [...new Set([...prior.accepted, ...acc])].sort() };
    writeJsonAtomic(F.dict, prior);
  }
  console.log(`[r303] dictionary: ${prior.checked.length} words checked, ${prior.accepted.length} accepted as dictionary words`);
}
function loadUniverse() {
  if (!fs.existsSync(F.assets) || !fs.existsSync(F.dict)) throw new Error("order: run --assets first");
  const A = readJson(F.assets), dict = readJson(F.dict);
  return buildUniverse(A.assets, dict.accepted, loadAvEtf());
}
const dataHash = () => sha256(fs.readFileSync(F.assets, "utf8") + "\n" + fs.readFileSync(F.dict, "utf8"));

// ───────────────────────────── step 2: videos ─────────────────────────────
const videosFile = (cid) => path.join(CACHE, `videos-${cid}.json`);
async function listUploads(c) {
  const f = videosFile(c.channel_id);
  if (fs.existsSync(f)) { const v = readJson(f); if (v.listing && v.listing.length) return v; }
  const r = await ytdlp(["--flat-playlist", "-J", "--sleep-requests", "0.5", "--extractor-args", "youtubetab:approximate_date", `https://www.youtube.com/playlist?list=${uuOf(c.channel_id)}`]);
  if (!r.out) throw new Error(`uploads listing failed for ${c.name}: ${r.err.slice(0, 300)}`);
  const j = JSON.parse(r.out);
  const listing = (j.entries || []).map((e, i) => ({ i, id: e.id, title: e.title, approxTs: Number.isFinite(e.timestamp) ? e.timestamp : null, duration: e.duration ?? null }));
  const v = { channel_id: c.channel_id, name: c.name, listedAt: new Date().toISOString(), playlist_count: j.playlist_count ?? null, listed: listing.length, listing, meta: {} };
  writeJsonAtomic(f, v);
  console.log(`[r303] listed ${c.name}: ${listing.length} uploads (playlist_count ${j.playlist_count})`);
  return v;
}
/** fetch precise metadata for ids (one yt-dlp process per batch); returns {id: meta}. Errors are recorded per id. */
async function fetchMeta(ids) {
  const fmt = "%(id)s\t%(timestamp)s\t%(release_timestamp)s\t%(upload_date)s\t%(live_status)s\t%(availability)s";
  const r = await ytdlp(["-i", "--simulate", "--ignore-no-formats-error", "--sleep-requests", "1", "--extractor-args", "youtube:player_client=web;player_skip=configs,js;skip=dash,hls,translated_subs", "--print", fmt, ...ids.map((id) => `https://www.youtube.com/watch?v=${id}`)], { timeoutMs: 30 * 60e3 });
  const out = {}, num = (x) => (x && x !== "NA" && /^\d+(\.\d+)?$/.test(x) ? Math.round(+x) : null);
  for (const line of r.out.split(/\r?\n/)) { const p = line.split("\t"); if (p.length < 6 || !ids.includes(p[0])) continue; out[p[0]] = { timestamp: num(p[1]), release_timestamp: num(p[2]), upload_date: p[3] !== "NA" ? p[3] : null, live_status: p[4] !== "NA" ? p[4] : null, availability: p[5] !== "NA" ? p[5] : null }; }
  for (const line of r.err.split(/\r?\n/)) { const m = /^ERROR: \[youtube\] ([A-Za-z0-9_-]{11}): (.*)$/.exec(line); if (m && ids.includes(m[1]) && !out[m[1]]) out[m[1]] = { error: m[2].slice(0, 160) }; }
  for (const id of ids) if (!out[id]) out[id] = { error: "no output" , transient: true };
  return out;
}
async function metaFor(v, ids) {
  const need = ids.filter((id) => !v.meta[id] || v.meta[id].transient);
  for (let k = 0; k < need.length; k += TS_BATCH * TS_CONCURRENCY) {
    const group = need.slice(k, k + TS_BATCH * TS_CONCURRENCY), batches = [];
    for (let b = 0; b < group.length; b += TS_BATCH) batches.push(group.slice(b, b + TS_BATCH));
    const res = await Promise.all(batches.map((b) => fetchMeta(b)));
    for (const r of res) Object.assign(v.meta, r);
    writeJsonAtomic(videosFile(v.channel_id), v);
    process.stdout.write(`  [r303] ${v.name}: timestamps ${Math.min(k + group.length, need.length)}/${need.length}\r`);
  }
  if (need.length) process.stdout.write("\n");
}
const etDateOfMeta = (m) => { const r = resolveTs(m); return r ? etParts(r.ts).date : null; };
async function windowBoundary(v) {
  // first listing index whose precise upload ET date is before UPLOAD_FIRST (newest-first list); binary search on precise timestamps
  const L = v.listing; let lo = 0, hi = L.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1; let probe = null;
    for (let j = mid; j < Math.min(hi, mid + 6) && probe == null; j++) { await metaFor(v, [L[j].id]); const d = etDateOfMeta(v.meta[L[j].id]); if (d) probe = { j, d }; }
    if (!probe) { hi = mid; continue; }
    if (probe.d < UPLOAD_FIRST) hi = probe.j; else lo = probe.j + 1;
  }
  return lo;
}
async function doVideos() {
  if (!fs.existsSync(F.channels)) throw new Error("order: run --channels first");
  const C = readJson(F.channels).channels, U = loadUniverse();
  const listOnly = process.argv.includes("--list-only");
  for (const c of C) await listUploads(c);
  if (listOnly) { console.log("[r303] listings done (--list-only)"); return; }
  let totalCand = 0;
  for (const c of C) {
    const v = readJson(videosFile(c.channel_id));
    v.boundary = v.boundary ?? (await windowBoundary(v)); writeJsonAtomic(videosFile(c.channel_id), v);
    const cand = v.listing.filter((e) => e.i < v.boundary + BOUNDARY_SLACK && extractCalls(e.title, U).length).map((e) => e.id);
    totalCand += cand.length;
    console.log(`[r303] ${c.name}: boundary index ${v.boundary}/${v.listing.length}; ${cand.length} candidate videos`);
    await metaFor(v, cand);
    v.candidates = cand.length; v.extractorHashAtFetch = extractorHash(); writeJsonAtomic(videosFile(c.channel_id), v);
  }
  console.log(`[r303] videos done: ${totalCand} candidate videos across ${C.length} channels`);
}

// ───────────────────────────── step 3: calls ─────────────────────────────
function buildCalls(U) {
  const C = readJson(F.channels).channels, calls = [], counts = { listed: 0, titlesWithCall: 0, noTimestamp: 0, outOfWindow: 0, inWindowVideosWithCall: 0, beyondBoundarySlack: 0 };
  for (const c of C) {
    const v = readJson(videosFile(c.channel_id));
    if (v.boundary == null) throw new Error(`videos step incomplete for ${c.name}`);
    for (const e of v.listing) {
      counts.listed++;
      const cs = extractCalls(e.title, U); if (!cs.length) continue;
      counts.titlesWithCall++;
      if (e.i >= v.boundary + BOUNDARY_SLACK) { counts.beyondBoundarySlack++; continue; }
      const m = v.meta[e.id], r = resolveTs(m);
      if (!r) { counts.noTimestamp++; continue; }
      const d = etParts(r.ts).date;
      if (d < UPLOAD_FIRST || d > UPLOAD_LAST) { counts.outOfWindow++; continue; }
      counts.inWindowVideosWithCall++;
      for (const x of cs) calls.push({ channelId: c.channel_id, channel: c.name, videoId: e.id, title: e.title, ts: r.ts, tsSource: r.src, uploadET: d, ticker: x.ticker, dir: x.dir, via: x.via });
    }
  }
  calls.sort((a, b) => a.ts - b.ts || a.videoId.localeCompare(b.videoId) || a.ticker.localeCompare(b.ticker));
  calls.forEach((c, i) => (c.i = i));
  return { calls, counts };
}
function doCalls() {
  if (!fs.existsSync(F.channels)) throw new Error("order: run --channels first");
  if (fs.existsSync(F.precision)) throw new Error("precision-check.json exists - the extractor and calls.json are frozen");
  const U = loadUniverse(), { calls, counts } = buildCalls(U);
  const noTs = readJson(F.channels).channels.reduce((s, c) => { const v = readJson(videosFile(c.channel_id)); return s + Object.values(v.meta).filter((m) => m.error).length; }, 0);
  writeJsonAtomic(F.calls, { id: ID, writtenAt: new Date().toISOString(), extractorHash: extractorHash(), dataHash: dataHash(), note: "titles only; no price has been read", counts: { ...counts, metadataErrors: noTs, calls: calls.length, long: calls.filter((c) => c.dir > 0).length, short: calls.filter((c) => c.dir < 0).length, viaCashtag: calls.filter((c) => c.via === "cashtag").length, viaToken: calls.filter((c) => c.via === "token").length, viaName: calls.filter((c) => c.via.startsWith("name:")).length }, calls });
  console.log(`[r303] calls.json: ${calls.length} calls ${JSON.stringify(counts)}`);
}

// ───────────────────────────── step 4: precision gate ─────────────────────────────
function doPrecision() {
  if (!fs.existsSync(F.calls)) throw new Error("order: run --calls first");
  if (fs.existsSync(F.precision)) { console.log("precision-check.json exists - frozen"); return; }
  const CJ = readJson(F.calls);
  if (CJ.extractorHash !== extractorHash()) throw new Error("extractor changed since calls.json was written - re-run --calls before the draw");
  if (!fs.existsSync(F.sample)) {
    const r = rng(PRECISION_SEED), idx = CJ.calls.map((c) => c.i);
    for (let k = idx.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [idx[k], idx[j]] = [idx[j], idx[k]]; }
    const A = new Map(readJson(F.assets).assets.map((a) => [a.symbol, a.name]));
    const pick = idx.slice(0, PRECISION_N).sort((a, b) => a - b).map((i) => { const c = CJ.calls[i]; return { i, title: c.title, ticker: c.ticker, assetName: A.get(c.ticker) || null, dir: c.dir > 0 ? "LONG" : "SHORT", via: c.via }; });
    writeJsonAtomic(F.sample, { drawnAt: new Date().toISOString(), seed: PRECISION_SEED, from: CJ.calls.length, n: pick.length, extractorHash: CJ.extractorHash, sample: pick });
    console.log(`[r303] drew ${pick.length} calls -> ${F.sample}. Hand-label each (tickerOk, dirOk) into ${F.labels} and run --precision again.`);
    return;
  }
  const S = readJson(F.sample), L = readJson(F.labels), byI = new Map(L.labels.map((l) => [l.i, l]));
  const missing = S.sample.filter((s) => !byI.has(s.i) || typeof byI.get(s.i).tickerOk !== "boolean" || typeof byI.get(s.i).dirOk !== "boolean");
  if (missing.length) throw new Error(`${missing.length} sample calls are unlabelled`);
  const labels = S.sample.map((s) => ({ ...s, tickerOk: byI.get(s.i).tickerOk, dirOk: byI.get(s.i).dirOk, correct: byI.get(s.i).tickerOk && byI.get(s.i).dirOk, note: byI.get(s.i).note || "" }));
  const precision = labels.filter((l) => l.correct).length / labels.length;
  const out = { id: ID, writtenAt: new Date().toISOString(), labeller: "builder agent (hand-labelled from the title text)", rubric: L.rubric || null, seed: S.seed, drawnFrom: S.from, n: labels.length,
    precision, tickerPrecision: labels.filter((l) => l.tickerOk).length / labels.length, directionPrecisionGivenTicker: labels.filter((l) => l.tickerOk && l.dirOk).length / Math.max(1, labels.filter((l) => l.tickerOk).length),
    threshold: PRECISION_MIN, pass: precision >= PRECISION_MIN, extractorHash: extractorHash(), dataHash: dataHash(), callsSha256: sha256(fs.readFileSync(F.calls, "utf8")), labels };
  writeJsonAtomic(F.precision, out);
  console.log(`[r303] precision ${(100 * precision).toFixed(1)}% (ticker ${(100 * out.tickerPrecision).toFixed(1)}%) -> ${out.pass ? "PASS gate" : "FAILS gate (< 80%): CANNOT MEASURE"}; extractor frozen at ${out.extractorHash.slice(0, 16)}`);
}

// ───────────────────────────── title-only inspection (no prices) ─────────────────────────────
function doInspect() {
  const U = loadUniverse(), C = readJson(F.channels).channels, freq = new Map(), A = new Map(readJson(F.assets).assets.map((a) => [a.symbol, a.name]));
  let titles = 0, withCall = 0;
  for (const c of C) {
    if (!fs.existsSync(videosFile(c.channel_id))) continue;
    for (const e of readJson(videosFile(c.channel_id)).listing) {
      titles++; const cs = extractCalls(e.title, U); if (cs.length) withCall++;
      for (const x of cs) { const k = x.via === "token" || x.via === "cashtag" ? `${x.via}:${x.ticker}` : `${x.via}->${x.ticker}`; const f = freq.get(k) || { k, n: 0, name: A.get(x.ticker), ex: [] }; f.n++; if (f.ex.length < 3) f.ex.push(e.title); freq.set(k, f); }
    }
  }
  const top = [...freq.values()].sort((a, b) => b.n - a.n).slice(0, Number(process.argv[process.argv.indexOf("--inspect") + 1]) || 300);
  console.log(`titles ${titles}, with a call ${withCall}; universe ${U.symbols.size} symbols, stoplist ${U.stop.size}, name keys ${U.nameKeys.size} (ambiguous ${U.ambiguous.length})`);
  for (const f of top) console.log(`${String(f.n).padStart(5)}  ${f.k.padEnd(28)} ${String(f.name || "").slice(0, 40).padEnd(40)} | ${f.ex[0].slice(0, 90)}`);
}

// ───────────────────────────── step 5: prices + read ─────────────────────────────
async function fetchUniverseBars(symbols) {
  const { fetchBars } = require("./lib/alpaca-bars.js");
  fs.mkdirSync(F.barsDir, { recursive: true });
  const spyF = path.join(F.barsDir, "SPY.json");
  if (!fs.existsSync(spyF)) {
    const b = await fetchBars(["SPY"], { start: BARS_START, end: BARS_END, feed: "sip", adjustment: "all", requireAll: true, quiet: true });
    if (!b.bars.SPY || b.bars.SPY.length < 900) throw new Error("SPY benchmark short/missing - cannot run");
    writeJsonAtomic(spyF, { fetchedAt: new Date().toISOString(), bars: b.bars.SPY.map((x) => [String(x.t).slice(0, 10), x.o, x.c, x.v]) });
  }
  const syms = [...symbols].sort(), CH = 100, files = [];
  for (let k = 0; k < syms.length; k += CH) {
    const chunk = syms.slice(k, k + CH), f = path.join(F.barsDir, `chunk-${String(k / CH).padStart(4, "0")}.json`), key = sha256(chunk.join(","));
    files.push(f);
    if (fs.existsSync(f)) { try { if (readJson(f).key === key) continue; } catch {} }
    let bars = null, last = null;
    for (let a = 0; a < 5 && !bars; a++) { try { bars = (await fetchBars(chunk, { start: BARS_START, end: BARS_END, feed: "sip", adjustment: "all", requireAll: false, chunkSize: CH, quiet: true })).bars; } catch (e) { last = e; process.stderr.write(`  [r303] bars chunk ${k / CH} attempt ${a + 1} failed: ${e.message.slice(0, 120)}\n`); await nap(15000 * (a + 1)); } }
    if (!bars) throw last;
    writeJsonAtomic(f, { key, symbols: chunk, fetchedAt: new Date().toISOString(), bars: Object.fromEntries(Object.entries(bars).map(([s, a]) => [s, a.map((x) => [String(x.t).slice(0, 10), x.o, x.c, x.v])])) }, { pretty: 0 });
    if ((k / CH) % 10 === 0) console.log(`  [r303] bars chunk ${k / CH + 1}/${Math.ceil(syms.length / CH)}`);
  }
  return { spyF, files };
}
/** price panel aligned to SPY sessions: per symbol Float64Array open, ffClose (last close at or before), hasBar, prefix dv sums */
function buildPanel(spyRows, files) {
  const sessions = spyRows.map((r) => r[0]), idx = new Map(sessions.map((d, i) => [d, i])), N = sessions.length, P = new Map();
  for (const f of files) {
    const j = readJson(f);
    for (const [s, rows] of Object.entries(j.bars)) {
      if (!rows.length) continue;
      const open = new Float64Array(N).fill(NaN), close = new Float64Array(N).fill(NaN), dvPre = new Float64Array(N + 1), nPre = new Uint16Array(N + 1);
      for (const r of rows) { const i = idx.get(r[0]); if (i == null) continue; open[i] = r[1]; close[i] = r[2]; }
      const ff = new Float64Array(N).fill(NaN); let lastC = NaN;
      for (let i = 0; i < N; i++) { if (Number.isFinite(close[i])) lastC = close[i]; ff[i] = lastC; }
      const dvAt = new Float64Array(N); for (const r of rows) { const i = idx.get(r[0]); if (i != null) dvAt[i] = r[2] * r[3]; }
      for (let i = 0; i < N; i++) { dvPre[i + 1] = dvPre[i] + dvAt[i]; nPre[i + 1] = nPre[i] + (Number.isFinite(close[i]) ? 1 : 0); }
      P.set(s, { open, ff, dvPre, nPre });
    }
  }
  return { sessions, P };
}
const advAt = (p, e) => { const a = Math.max(0, e - ADV_N), n = p.nPre[e] - p.nPre[a]; return { adv: n ? (p.dvPre[e] - p.dvPre[a]) / n : null, n }; };
/** per entry session: eligible universe sorted by ADV with decile buckets and rank lookup (D11) */
function sessionUniverse(panel, e, cache) {
  if (cache.has(e)) return cache.get(e);
  const el = [];
  for (const [s, p] of panel.P) { if (!Number.isFinite(p.open[e])) continue; const { adv, n } = advAt(p, e); if (n >= ADV_MIN_BARS && adv > 0) el.push({ s, adv }); }
  el.sort((a, b) => a.adv - b.adv);
  const advs = el.map((x) => x.adv), buckets = Array.from({ length: 10 }, () => []);
  el.forEach((x, i) => buckets[Math.min(9, Math.floor((10 * i) / el.length))].push(x.s));
  const u = { n: el.length, advs, buckets, all: el.map((x) => x.s) };
  cache.set(e, u); return u;
}
function decileOf(u, adv) { if (!(adv > 0) || !u.n) return null; const r = lowerBound(u.advs, adv); return Math.min(9, Math.floor((10 * Math.min(r, u.n - 1)) / u.n)); }
function priceCall(p, spy, e, x, dir, sessions) {
  if (!p || !Number.isFinite(p.open[e])) return null;
  const sc = p.ff[x]; if (!Number.isFinite(sc)) return null;
  const nights = dayNum(sessions[x]) - dayNum(sessions[e]);
  return fadeTrade(dir, p.open[e], sc, spy.open[e], spy.close[x], nights);
}
function cannotMeasure(reason, extra) {
  const o = { id: ID, readAt: new Date().toISOString(), verdictScript: `CANNOT MEASURE — ${reason}`, tNet: null, meanNet: null, n: 0, unit: "weeks", cell: null, cells: null, placebo: null, halves: null, follow: null, top1000Only: null, concentration: null, perChannel: [], ...extra, notes: `CANNOT MEASURE: ${reason}. ${extra && extra.notes ? extra.notes : ""}`.trim() };
  writeJsonAtomic(OUT, o); console.log(`R303 ${o.verdictScript}`); return o;
}
async function doRead() {
  if (!selftest()) throw new Error("selftest failed - read refused");
  const seals = readJson(D("read-seals.json"));
  if ((seals.tests && seals.tests[ID]) || fs.existsSync(OUT)) throw new Error("R303 already read/sealed - read-once");
  const reg = (readJson(D("test-registry.json")).preregistered || []).find((t) => t.id === ID);
  if (!reg || !(reg.bar && reg.bar.tRequired > 0)) throw new Error("R303 registry entry / bar.tRequired missing");
  const BAR = reg.bar.tRequired, chJson = readJson(F.channels);
  const base = { bar: BAR, channels: chJson.channels.length, extractorHash: extractorHash(), botWall: fs.existsSync(F.botwall) };
  if (base.botWall) return cannotMeasure("a YouTube sign-in / bot wall blocked the pull (never bypassed)", { ...base, calls: 0, precision: null });
  if (!fs.existsSync(F.precision)) throw new Error("order: the precision check must be written before any return is computed");
  const PC = readJson(F.precision);
  if (PC.extractorHash !== extractorHash()) throw new Error("extractor source changed after the precision check - read refused");
  const CJ = readJson(F.calls);
  if (sha256(fs.readFileSync(F.calls, "utf8")) !== PC.callsSha256) throw new Error("calls.json changed after the precision check - read refused");
  base.precision = PC.precision;
  if (!PC.pass) return cannotMeasure(`extraction precision ${(100 * PC.precision).toFixed(1)}% < 80% on the 200-call hand check`, { ...base, calls: CJ.calls.length });

  // prices: SPY first and asserted, then every D4 common stock (the placebo universe), SIP daily adjustment=all
  const U = loadUniverse();
  const { spyF, files } = await fetchUniverseBars(U.symbols.keys());
  const spyRows = readJson(spyF).bars, panel = buildPanel(spyRows, files), sessions = panel.sessions;
  const spy = { open: Float64Array.from(spyRows.map((r) => r[1])), close: Float64Array.from(spyRows.map((r) => r[2])) };
  if (sessions[0] > "2022-10-03" || sessions[sessions.length - 1] < "2026-09-28") throw new Error(`SPY calendar ${sessions[0]}..${sessions.at(-1)} does not cover the window`);

  // entries, window, pricing, duplicates
  const ex = { entryOutsideWindow: 0, exitBeyondData: 0, noBarAtEntry: 0, noPricesForSymbol: 0 };
  let rows = [];
  for (const c of CJ.calls) {
    const e = entryIdx(c.ts, sessions);
    if (e < 0 || sessions[e] < ENTRY_FIRST || sessions[e] > ENTRY_LAST) { ex.entryOutsideWindow++; continue; }
    if (e + CELLS.H20 >= sessions.length) { ex.exitBeyondData++; continue; }
    rows.push({ ...c, e, entry: sessions[e], week: mondayOf(sessions[e]) });
  }
  const dd = dedupe(rows); rows = dd.kept;
  const priced = [];
  for (const r of rows) {
    const p = panel.P.get(r.ticker);
    if (!p) { ex.noPricesForSymbol++; continue; }
    const t5 = priceCall(p, spy, r.e, r.e + CELLS.H5, r.dir, sessions), t20 = priceCall(p, spy, r.e, r.e + CELLS.H20, r.dir, sessions);
    if (!t5 || !t20) { ex.noBarAtEntry++; continue; }
    priced.push({ ...r, H5: t5, H20: t20 });
  }
  // ADV deciles / ranks for the placebo and the top-1000 check
  const uCache = new Map();
  for (const r of priced) {
    const u = sessionUniverse(panel, r.e, uCache), { adv } = advAt(panel.P.get(r.ticker), r.e);
    r.adv = adv; r.decile = decileOf(u, adv); r.advRank = adv > 0 ? u.n - lowerBound(u.advs, adv) : null;   // 1 = largest
  }
  const nCalls = priced.length, weeksWithCalls = new Set(priced.map((r) => r.week)).size;
  base.calls = nCalls;
  const counts = { callsInFile: CJ.calls.length, ...ex, duplicatesDropped: dd.dropped.length, analysed: nCalls, weeksWithCalls, long: priced.filter((r) => r.dir > 0).length, short: priced.filter((r) => r.dir < 0).length };
  if (nCalls < MIN_CALLS) return cannotMeasure(`${nCalls} calls in the window (< ${MIN_CALLS})`, { ...base, counts });
  if (weeksWithCalls < MIN_WEEKS) return cannotMeasure(`${weeksWithCalls} weeks with calls (< ${MIN_WEEKS})`, { ...base, counts });

  // cells
  const cells = {}, cellsFull = {};
  for (const [cell, k] of Object.entries(CELLS)) {
    const s = cellStat(priced, (r) => r[cell].net, NW_LAG[cell]), g = cellStat(priced, (r) => r[cell].gross, NW_LAG[cell]);
    const fol = cellStat(priced, (r) => r[cell].followNet, NW_LAG[cell]), sl = cellStat(priced, (r) => r[cell].netStockLegBorrowOnly, NW_LAG[cell]);
    const nets = priced.map((r) => r[cell].net);
    cells[cell] = { tNet: s.tNet, meanNet: s.meanNet, n: s.n, nwLag: NW_LAG[cell] };
    cellsFull[cell] = { ...cells[cell], holdSessions: k + 1, tGross: g.tNet, meanGross: g.meanNet, perCallMeanNet: mean(nets), perCallMedianNet: [...nets].sort((a, b) => a - b)[Math.floor(nets.length / 2)], winRate: nets.filter((x) => x > 0).length / nets.length,
      follow: { meanNet: fol.meanNet, tNet: fol.tNet, winRate: priced.filter((r) => r[cell].followNet > 0).length / nCalls }, stockLegBorrowOnly: { meanNet: sl.meanNet, tNet: sl.tNet }, series: s.series };
  }
  const cell = (cells.H20.tNet ?? -Infinity) > (cells.H5.tNet ?? -Infinity) ? "H20" : "H5", best = cellsFull[cell];
  // halves (D12)
  const ser = best.series, half = Math.ceil(ser.length / 2), hs = (a) => ({ meanNet: a.length ? mean(a.map((w) => w.v)) : null, tNet: nwT(a.map((w) => w.v), NW_LAG[cell]), weeks: a.length, from: a[0] && a[0].week, to: a.length ? a[a.length - 1].week : null });
  const halves = { first: hs(ser.slice(0, half)), second: hs(ser.slice(half)) };
  // placebo: each call -> random common stock from the same ADV decile at the same entry session, same direction; 500 draws
  const R = rng(SEED), pbMeans = { H5: [], H20: [] };
  const pool = priced.map((r) => { const u = sessionUniverse(panel, r.e, uCache); return r.decile != null && u.buckets[r.decile].length ? u.buckets[r.decile] : u.all; });
  for (let d = 0; d < PLACEBO_DRAWS; d++) {
    const pr = [];
    for (let i = 0; i < priced.length; i++) {
      const r = priced[i], pl = pool[i]; let t5 = null, t20 = null;
      for (let tries = 0; tries < 20 && !(t5 && t20); tries++) { const s = pl[Math.floor(R() * pl.length)], p = panel.P.get(s); t5 = priceCall(p, spy, r.e, r.e + CELLS.H5, r.dir, sessions); t20 = priceCall(p, spy, r.e, r.e + CELLS.H20, r.dir, sessions); }
      if (t5 && t20) pr.push({ week: r.week, channelId: r.channelId, H5: t5.net, H20: t20.net });
    }
    for (const c of Object.keys(CELLS)) pbMeans[c].push(mean(weeklySeries(pr, (x) => x[c]).map((w) => w.v)));
  }
  const q95 = (a) => [...a].sort((x, y) => x - y)[Math.floor(0.95 * a.length)];
  const placeboCells = Object.fromEntries(Object.keys(CELLS).map((c) => [c, { p95: q95(pbMeans[c]), observed: cells[c].meanNet, beats: cells[c].meanNet > q95(pbMeans[c]), draws: PLACEBO_DRAWS, placeboMean: mean(pbMeans[c]), fracDrawsAtOrAboveObserved: pbMeans[c].filter((x) => x >= cells[c].meanNet).length / PLACEBO_DRAWS }]));
  const placebo = { ...placeboCells[cell], cell, byCell: placeboCells };
  // top-1000 by dollar volume (borrow-weakness check)
  const topRows = priced.filter((r) => r.advRank != null && r.advRank <= TOP_ADV);
  const t1 = cellStat(topRows, (r) => r[cell].net, NW_LAG[cell]);
  const top1000Only = { tNet: t1.tNet, meanNet: t1.meanNet, weeks: t1.n, calls: topRows.length, cell, otherCell: (() => { const oc = cell === "H5" ? "H20" : "H5", s = cellStat(topRows, (r) => r[oc].net, NW_LAG[oc]); return { cell: oc, tNet: s.tNet, meanNet: s.meanNet }; })() };
  // concentration
  const byT = new Map(); for (const r of priced) byT.set(r.ticker, (byT.get(r.ticker) || 0) + 1);
  const top10 = [...byT].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10), top10Set = new Set(top10.map((x) => x[0]));
  const pnl = (rs, c) => rs.reduce((s, r) => s + r[c].net, 0);
  const rest = priced.filter((r) => !top10Set.has(r.ticker));
  const concentration = { top10: top10.map(([t, n]) => ({ ticker: t, calls: n, meanNetH5: mean(priced.filter((r) => r.ticker === t).map((r) => r.H5.net)), meanNetH20: mean(priced.filter((r) => r.ticker === t).map((r) => r.H20.net)) })),
    shareOfCalls: priced.filter((r) => top10Set.has(r.ticker)).length / nCalls, shareOfFadePnl: { H5: pnl(priced.filter((r) => top10Set.has(r.ticker)), "H5") / pnl(priced, "H5"), H20: pnl(priced.filter((r) => top10Set.has(r.ticker)), "H20") / pnl(priced, "H20") },
    sumNet: { H5: pnl(priced, "H5"), H20: pnl(priced, "H20") }, sumNetTop10: { H5: pnl(priced.filter((r) => top10Set.has(r.ticker)), "H5"), H20: pnl(priced.filter((r) => top10Set.has(r.ticker)), "H20") },
    excludingTop10: { calls: rest.length, [cell]: (() => { const s = cellStat(rest, (r) => r[cell].net, NW_LAG[cell]); return { tNet: s.tNet, meanNet: s.meanNet }; })() }, distinctTickers: byT.size, note: "reported, no selection on it" };
  const perChannel = chJson.channels.map((c) => { const rs = priced.filter((r) => r.channelId === c.channel_id); return { rank: c.rank, channelId: c.channel_id, name: c.name, followers: c.followers, calls: rs.length, long: rs.filter((r) => r.dir > 0).length, short: rs.filter((r) => r.dir < 0).length, meanNetH5: rs.length ? mean(rs.map((r) => r.H5.net)) : null, meanNetH20: rs.length ? mean(rs.map((r) => r.H20.net)) : null, winRateH5: rs.length ? rs.filter((r) => r.H5.net > 0).length / rs.length : null, winRateH20: rs.length ? rs.filter((r) => r.H20.net > 0).length / rs.length : null }; });
  const byYear = {}; for (const r of priced) { const y = r.entry.slice(0, 4); (byYear[y] = byYear[y] || { calls: 0, H5: [], H20: [] }).calls++; byYear[y].H5.push(r.H5.net); byYear[y].H20.push(r.H20.net); }
  const byDir = Object.fromEntries([["longCalls", 1], ["shortCalls", -1]].map(([k, dd2]) => { const rs = priced.filter((r) => r.dir === dd2); return [k, { calls: rs.length, meanNetH5: rs.length ? mean(rs.map((r) => r.H5.net)) : null, meanNetH20: rs.length ? mean(rs.map((r) => r.H20.net)) : null, tNetBest: rs.length > 3 ? cellStat(rs, (r) => r[cell].net, NW_LAG[cell]).tNet : null }]; }));

  const pass = best.tNet != null && best.tNet >= BAR && placebo.beats && halves.first.meanNet > 0 && halves.second.meanNet > 0;
  const verdictScript = pass ? "PASS" : "DID NOT PASS";
  const f = (x) => (x == null ? "n/a" : (100 * x).toFixed(3) + "%"), r3 = (x) => (x == null ? null : +x.toFixed(3));
  const notes = `${verdictScript}: better cell ${cell} net t ${r3(best.tNet)} vs bar ${BAR} (NW lag ${NW_LAG[cell]}), mean weekly net fade ${f(best.meanNet)} over ${best.n} weeks; ${nCalls} calls from ${perChannel.filter((c) => c.calls).length} channels; win rate (net fade > 0) ${f(best.winRate)} beside per-call mean ${f(best.perCallMeanNet)}. ` +
    `Placebo p95 ${f(placebo.p95)} vs observed ${f(placebo.observed)} -> beaten ${placebo.beats}. Halves ${f(halves.first.meanNet)} / ${f(halves.second.meanNet)}. FOLLOW mirror ${f(best.follow.meanNet)} (t ${r3(best.follow.tNet)}). ` +
    `Other cell ${cell === "H5" ? "H20" : "H5"} t ${r3(cells[cell === "H5" ? "H20" : "H5"].tNet)}. Top-1000-by-$volume only: t ${r3(top1000Only.tNet)} mean ${f(top1000Only.meanNet)}. Precision ${f(PC.precision)} on the 200-call hand check. ` +
    `Known weaknesses (registry): deleted videos and channel survivorship bias AGAINST the fade; title edits undisclosable; borrow at 3%/yr flatters the fade on hyped small caps.`;
  const out = {
    id: ID, name: reg.name, readAt: new Date().toISOString(), unit: "weeks", statistic: reg.statistic, bar: BAR,
    tNet: best.tNet, meanNet: best.meanNet, n: best.n, cell, cells, winRate: best.winRate, winRateByCell: { H5: cellsFull.H5.winRate, H20: cellsFull.H20.winRate },
    placebo, halves, follow: { meanNet: best.follow.meanNet, tNet: best.follow.tNet, winRate: best.follow.winRate, cell, byCell: { H5: cellsFull.H5.follow, H20: cellsFull.H20.follow } },
    top1000Only, concentration, perChannel, calls: nCalls, channels: chJson.channels.length, precision: PC.precision, extractorHash: extractorHash(), dataHash: PC.dataHash, botWall: false, verdictScript,
    detail: { cells: Object.fromEntries(Object.entries(cellsFull).map(([k, v]) => [k, { ...v, series: undefined }])), counts, byYear: Object.fromEntries(Object.entries(byYear).map(([y, v]) => [y, { calls: v.calls, meanNetH5: mean(v.H5), meanNetH20: mean(v.H20) }])), byDirection: byDir,
      weekly: Object.fromEntries(Object.keys(CELLS).map((c) => [c, cellsFull[c].series.map((w) => [w.week, +w.v.toFixed(6), w.channels, w.calls])])), sensitivityBorrowStockLegOnly: { H5: cellsFull.H5.stockLegBorrowOnly, H20: cellsFull.H20.stockLegBorrowOnly },
      costModel: "0.20% round trip on every call + 3%/yr x calendar nights on the short leg of the pair (D10); FOLLOW charged the same", prices: "Alpaca SIP daily, adjustment=all; SPY benchmark; exit = last close on/before the exit session (D9)",
      window: { uploads: `${UPLOAD_FIRST}..${UPLOAD_LAST} ET`, entries: `${priced.reduce((m, r) => (r.entry < m ? r.entry : m), "9999")}..${priced.reduce((m, r) => (r.entry > m ? r.entry : m), "0000")}` } },
    knownWeaknesses: reg.knownWeaknesses, notes,
  };
  writeJsonAtomic(OUT, out);
  console.log(`R303 ${verdictScript}: ${cell} tNet ${r3(best.tNet)} (bar ${BAR}) meanNet ${f(best.meanNet)} weeks ${best.n}; H5 t ${r3(cells.H5.tNet)} ${f(cells.H5.meanNet)} | H20 t ${r3(cells.H20.tNet)} ${f(cells.H20.meanNet)}`);
  console.log(`  calls ${nCalls}; win ${f(best.winRate)}; placebo p95 ${f(placebo.p95)} observed ${f(placebo.observed)} beats ${placebo.beats}; halves ${f(halves.first.meanNet)} / ${f(halves.second.meanNet)}; follow ${f(best.follow.meanNet)} t ${r3(best.follow.tNet)}; top1000 t ${r3(top1000Only.tNet)}`);
  console.log(`  output ${OUT}`);
  return out;
}

// ───────────────────────────── selftest ─────────────────────────────
function selftest() {
  const res = [], ok = (name, cond, detail) => res.push({ name, ok: !!cond, detail }), approx = (a, b, tol = 1e-9) => a != null && b != null && Math.abs(a - b) <= tol;
  // E: extraction on a synthetic universe
  const assets = [["NVDA", "NVIDIA Corporation Common Stock"], ["TSLA", "Tesla, Inc. Common Stock"], ["PLTR", "Palantir Technologies Inc. Class A Common Stock"], ["NOW", "ServiceNow, Inc. Common Stock"], ["AI", "C3.ai, Inc. Class A Common Stock"],
    ["SOFI", "SoFi Technologies, Inc. Common Stock"], ["AMD", "Advanced Micro Devices, Inc. Common Stock"], ["META", "Meta Platforms, Inc. Class A Common Stock"], ["DIS", "The Walt Disney Company Common Stock"], ["ACMA", "Acmeco Holdings Inc"], ["ACMB", "Acmeco Industries Inc"],
    ["GME", "GameStop Corporation Common Stock"], ["SPY", "SPDR S&P 500 ETF Trust"], ["QQQ", "Invesco QQQ Trust, Series 1"], ["ALL", "Allstate Corporation (The) Common Stock"], ["ARMX", "Armchair Corp"]].map(([symbol, name]) => ({ symbol, name, exchange: "NASDAQ", status: "active", class: "us_equity" }));
  assets.push({ symbol: "OLDX", name: "Oldtimer Inc", exchange: "NYSE", status: "inactive", class: "us_equity" }, { symbol: "OLDY", name: "Oldtimer Holdings", exchange: "NYSE", status: "active", class: "us_equity" });
  const dict = ["tesla", "meta", "walt", "now", "all", "advanced", "micro", "devices", "common", "stock", "class", "corporation", "company", "holdings", "industries", "technologies", "platforms", "armchair"];
  const U = buildUniverse(assets, dict, new Set());
  const X = (t) => extractCalls(t, U).map((c) => `${c.ticker}:${c.dir > 0 ? "L" : "S"}`).sort().join(",");
  const cases = [
    ["Why I'm Buying NVDA Stock", "NVDA:L"], ["Don't Buy TSLA Stock!", "TSLA:S"], ["Don\u2019t Buy NVDA Yet", "NVDA:S"], ["do not buy PLTR", "PLTR:S"],
    ["Stocks To Buy NOW: AI Stocks", ""], ["$AI Stock To Buy", "AI:L"], ["Palantir Stock Will Explode", "PLTR:L"], ["Tesla Stock Crash Coming", ""],
    ["SELL SOFI and AMD now", "AMD:S,SOFI:S"], ["NVDA earnings preview", ""], ["Is META a buy?", ""], ["$META to buy", "META:L"], ["Disney stock: stay away", "DIS:S"],
    ["Acmeco stock to buy", ""], ["Short squeeze coming for GME", "GME:S"], ["NVDA vs NVDA: buy", "NVDA:L"], ["NVDA's 10X moment", "NVDA:L"], ["nvda to buy", ""],
    ["SPY and QQQ: buy the dip", ""], ["ALL IN on SOFI", "SOFI:L"], ["Buying PLTR, selling NVDA", "NVDA:S,PLTR:S"], ["Oldtimer to the moon", "OLDY:L"], ["Explodes higher: NVDA", ""], ["Best stocks: NVDA", ""], ["Best stock to own: NVDA", "NVDA:L"],
  ];
  for (const [t, want] of cases) { const got = X(t); ok(`E extract "${t}" -> [${want}]`, got === want, got); }
  ok("E universe: ETF/fund names excluded (SPY, QQQ not symbols)", !U.symbols.has("SPY") && !U.symbols.has("QQQ"));
  ok("E stoplist: registry seed + dictionary-word tickers (NOW, ALL, AI, META) stoplisted; NVDA not", U.stop.has("NOW") && U.stop.has("ALL") && U.stop.has("AI") && U.stop.has("META") && !U.stop.has("NVDA"));
  ok("E name keys: 'acmeco' ambiguous (2 active) dropped; 'oldtimer' resolves to the single active asset; 'tesla' (dictionary) not a key; 'disney' via first distinctive word", !U.nameKeys.has("acmeco") && U.nameKeys.get("oldtimer") === "OLDY" && !U.nameKeys.has("tesla") && U.nameKeys.get("disney") === "DIS");
  // T: entry-after-timestamp rule. Sessions: Mar 2024 weekdays except Good Friday 03-29.
  const sess = []; for (let d = "2024-03-01"; d <= "2024-04-05"; d = addDays(d, 1)) { const w = new Date(d + "T00:00:00Z").getUTCDay(); if (w && w < 6 && d !== "2024-03-29") sess.push(d); }
  const at = (iso) => Date.parse(iso) / 1000, E = (sec) => sess[entryIdx(sec, sess)];
  ok("T pre-market Tue 08:00 EST -> same-day open", E(at("2024-03-05T13:00:00Z")) === "2024-03-05");
  ok("T 09:29:59 ET -> same day; exactly 09:30:00 -> next session (strictly after)", E(at("2024-03-05T14:29:59Z")) === "2024-03-05" && E(at("2024-03-05T14:30:00Z")) === "2024-03-06");
  ok("T after the close Tue 16:30 ET -> Wed open", E(at("2024-03-05T21:30:00Z")) === "2024-03-06");
  ok("T Saturday upload -> Monday open", E(at("2024-03-09T17:00:00Z")) === "2024-03-11");
  ok("T Sunday 23:00 ET upload -> Monday open", E(at("2024-03-11T03:00:00Z")) === "2024-03-11");
  ok("T DST: Mon 2024-03-11 13:45Z = 09:45 EDT -> Tue (EST would wrongly say same day)", E(at("2024-03-11T13:45:00Z")) === "2024-03-12" && E(at("2024-03-11T13:20:00Z")) === "2024-03-11");
  ok("T Thu evening before Good Friday -> Mon 04-01", E(at("2024-03-28T22:00:00Z")) === "2024-04-01");
  const fb1 = resolveTs({ timestamp: null, release_timestamp: null, upload_date: "20240308" }), fb2 = resolveTs({ upload_date: "20240305" }), fb3 = resolveTs({ timestamp: null, release_timestamp: 1709733600, upload_date: "20240306" });
  ok("T fallback upload_date Fri 2024-03-08 -> Sat 00:00 ET -> Mon open", fb1.src === "upload_date+1d" && etParts(fb1.ts).date === "2024-03-09" && etParts(fb1.ts).sod === 0 && E(fb1.ts) === "2024-03-11");
  ok("T fallback upload_date Tue -> Wed 00:00 ET -> Wed open", E(fb2.ts) === "2024-03-06");
  ok("T release_timestamp used before upload_date", fb3.src === "release_timestamp" && fb3.ts === 1709733600);
  ok("T week = Monday of the entry date", mondayOf("2024-03-06") === "2024-03-04" && mondayOf("2024-03-04") === "2024-03-04" && mondayOf("2024-03-10") === "2024-03-04");
  // R: synthetic fade return. LONG call, stock open 100 -> close 110, SPY open 400 -> close 404, 4 nights.
  const fr = fadeTrade(1, 100, 110, 400, 404, 4), hc = 0.0020 + 0.03 * 4 / 365;
  ok("R fade of a LONG call: gross -(0.10-0.01) = -0.09; net = -0.09 - (0.002 + 0.03*4/365)", approx(fr.gross, -0.09, 1e-12) && approx(fr.net, -0.09 - hc, 1e-12), `${fr.gross} ${fr.net}`);
  ok("R FOLLOW mirror = -gross, own cost: +0.09 - cost", approx(fr.followNet, 0.09 - hc, 1e-12));
  const fr2 = fadeTrade(-1, 50, 45, 400, 404, 28);
  ok("R fade of a SHORT call: stock -10%, SPY +1% -> gross -0.11; stock-leg-only borrow charges the fade none", approx(fr2.gross, -0.11, 1e-12) && approx(fr2.net, -0.11 - (0.002 + 0.03 * 28 / 365), 1e-12) && approx(fr2.netStockLegBorrowOnly, -0.11 - 0.002, 1e-12));
  // exit when the exit bar is missing -> last close on/before (D9) via the panel builder
  const pr = buildPanel([["2024-03-04", 400, 400, 1], ["2024-03-05", 400, 400, 1], ["2024-03-06", 400, 404, 1]], []);
  const p0 = { open: Float64Array.from([100, NaN, NaN]), ff: Float64Array.from([101, 105, 105]) };
  const pc = priceCall(p0, { open: Float64Array.from([400, 400, 400]), close: Float64Array.from([400, 400, 404]) }, 0, 2, 1, pr.sessions);
  ok("R missing exit bar -> last close on/before the exit session (105), SPY to its exit close", pc && approx(pc.rs, 0.05, 1e-12) && approx(pc.rm, 0.01, 1e-12), pc && `${pc.rs} ${pc.rm}`);
  // W: weekly clustering. Week1: channel A nets .01,.03 (mean .02), channel B -.01 -> (0.02-0.01)/2 = .005; Week2: A .04.
  const ws = weeklySeries([{ week: "W1", channelId: "A", v: 0.01 }, { week: "W1", channelId: "A", v: 0.03 }, { week: "W1", channelId: "B", v: -0.01 }, { week: "W2", channelId: "A", v: 0.04 }], (r) => r.v);
  ok("W weekly = mean over channels of channel means: [0.005, 0.04]", ws.length === 2 && approx(ws[0].v, 0.005, 1e-12) && approx(ws[1].v, 0.04, 1e-12) && ws[0].channels === 2 && ws[0].calls === 3);
  // N: Newey-West known answers on [1,2,3,4,5]: lag 0 -> 3/sqrt(2/5) = 4.7434; lag 1 -> gamma1 = 0.8, v = 2 + 0.8 = 2.8 -> 3/sqrt(0.56) = 4.0089
  ok("N Newey-West lag 0 on [1..5] = 4.7434", approx(nwT([1, 2, 3, 4, 5], 0), 3 / Math.sqrt(0.4), 1e-9), nwT([1, 2, 3, 4, 5], 0));
  ok("N Newey-West lag 1 on [1..5] = 4.0089", approx(nwT([1, 2, 3, 4, 5], 1), 3 / Math.sqrt(2.8 / 5), 1e-9), nwT([1, 2, 3, 4, 5], 1));
  ok("N Newey-West lag 4 on alternating series inflates t vs lag 0", nwT([1, 3, 1, 3, 1, 3, 1, 3, 2, 2], 4) > nwT([1, 3, 1, 3, 1, 3, 1, 3, 2, 2], 0));
  // P: duplicates (D8): channel A NVDA at sessions 0,3,6,12 -> keep 0 and 12; channel B NVDA at 3 kept; A TSLA at 3 kept
  const dd = dedupe([{ channelId: "A", ticker: "NVDA", e: 0, ts: 1, videoId: "a" }, { channelId: "A", ticker: "NVDA", e: 3, ts: 2, videoId: "b" }, { channelId: "A", ticker: "NVDA", e: 6, ts: 3, videoId: "c" }, { channelId: "A", ticker: "NVDA", e: 12, ts: 4, videoId: "d" }, { channelId: "B", ticker: "NVDA", e: 3, ts: 2, videoId: "e" }, { channelId: "A", ticker: "TSLA", e: 3, ts: 2, videoId: "f" }, { channelId: "A", ticker: "NVDA", e: 12, ts: 5, videoId: "g" }]);
  ok("P duplicates: same channel+name within 5 sessions dropped (chain), other channel/name kept, same-session repeat dropped", dd.kept.map((c) => c.videoId).sort().join("") === "adef" && dd.dropped.length === 3, dd.kept.map((c) => c.videoId).join(""));
  // Q: ADV deciles. 20 names with ADV 1..20 -> deciles of 2; a called ADV of 7.5 sits in decile 3 (ranks 6,7 -> names 7,8)
  const u = { n: 20, advs: Array.from({ length: 20 }, (_, i) => i + 1) };
  ok("Q decile of ADV 7.5 among 1..20 = 3; ADV 20 = 9; ADV 1 = 0", decileOf(u, 7.5) === 3 && decileOf(u, 20) === 9 && decileOf(u, 1) === 0, `${decileOf(u, 7.5)} ${decileOf(u, 20)} ${decileOf(u, 1)}`);
  // hash marker sanity
  ok("H extractor hash is stable and covers the stoplists/keywords", /STOP_SEED/.test(extractorSource()) && /POS_KW/.test(extractorSource()) && extractorHash().length === 64);
  const bad = res.filter((x) => !x.ok);
  for (const x of res) console.log(`  ${x.ok ? "ok  " : "FAIL"} ${x.name}${x.detail !== undefined && x.detail !== "" && !x.ok ? "  [" + x.detail + "]" : ""}`);
  console.log(`selftest: ${res.length - bad.length}/${res.length} known answers ${bad.length ? "FAILED" : "pass"}`);
  return !bad.length;
}

async function main() {
  if (mode === "--selftest") process.exit(selftest() ? 0 : 1);
  if (mode === "--channels") return doChannels();
  if (mode === "--assets") return doAssets();
  if (mode === "--videos") return doVideos();
  if (mode === "--calls") return doCalls();
  if (mode === "--precision") return doPrecision();
  if (mode === "--inspect") return doInspect();
  if (mode === "--fetch") {   // price cache fill only (resumable); computes and prints NO return
    const U = loadUniverse(); await fetchUniverseBars(U.symbols.keys());
    console.log(`[r303] bars cached for the ${U.symbols.size}-name common-stock universe + SPY (no return computed)`); return;
  }
  if (mode === "--read") return doRead();
}
main().catch((e) => {
  if (e instanceof BotWall) { console.error("R303 STOPPED - bot wall:", e.message); process.exit(4); }
  if (e instanceof RateLimited) { console.error("R303 paused - rate limited; resume later from cache:", e.message); process.exit(3); }
  console.error("R303 FAILED:", e.stack || e.message); process.exit(1);
});
