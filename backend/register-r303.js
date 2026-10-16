#!/usr/bin/env node
/** Registers R303 — fade YouTube stock-pick calls (operator 2026-10-01: "how do we use it to make money" -> "yes install it and register
 *  the test"). Written BEFORE any YouTube data is pulled: no channel list, no title, no return has been seen. yt-dlp 2026.08.19 (official
 *  Windows build, SHA-256 verified) at %USERPROFILE%\.local\bin\yt-dlp.exe; no cookies, no login, ever. Bar = nullBar({variants: own
 *  cells, n}).p95 (house convention since 2026-09-29). Refuses if the id exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { nullBar } = require("./lib/null-bar.js");
const D = (f) => path.join(__dirname, "data", f);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
const ID = "R303", TODAY = "2026-10-01", CELLS = 2, N = 190;
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === ID)) { console.error(`${ID} exists — refusing`); process.exit(2); }
const b = +nullBar({ variants: CELLS, n: N, trials: 20000 }).p95.toFixed(3);
const entry = {
  id: ID, registered: TODAY, name: "Fade YouTube stock-pick calls: bet against the direction of single-stock calls in the titles of the most-subscribed stock-pick channels",
  status: `REGISTERED ${TODAY} — historical, read once; builder assigned`, script: "backend/r303-youtube-fade.js",
  parent: "Operator 2026-10-01 (Agent Reach discussion): 'how do we use it to make money' -> 'yes install it and register the test'. Motivation: academic work on finfluencers (StockTwits) reporting that most are worse than random and that a contrarian strategy earned positive abnormal returns; never tested here.",
  multiplicityFamily: "YT-FADE — R303 alone; 2 cells (hold 5 / hold 20 sessions). FOLLOW is the mirror of FADE, not a separate cell.",
  evidenceStart: "historical: call entries 2023-01-03..2026-08-31 (one read)",
  rule: [
    "TOOL: yt-dlp only (official build), anonymous. NO cookies, NO login, NO proxy; if YouTube answers with a sign-in / 'confirm you're not a bot' wall the run STOPS and the test is CANNOT MEASURE (never bypassed).",
    "CHANNELS (frozen by rule, chosen before any outcome is seen): run yt-dlp search 'ytsearch100:' for each of these queries — 'stocks to buy now', 'best stocks to buy', 'stock picks this week', 'stocks I'm buying', 'growth stocks to buy', 'stock to buy before it explodes'. Collect the uploading channels; keep channels that appear in >= 2 of the 6 result lists; drop news/media outlets (CNBC, Bloomberg, Yahoo Finance, Fox Business, WSJ, Reuters, MarketWatch, Benzinga, Barron's, Investor's Business Daily, Morningstar, The Motley Fool's corporate channel is KEPT as it publishes picks) and channels with < 100 videos; rank by subscriber count (yt-dlp channel_follower_count); take the top 20. The list is written to data/training/r303/channels.json BEFORE any title is parsed.",
    "VIDEOS: every upload of those channels (long-form and Shorts) whose upload timestamp falls in 2023-01-01..2026-08-28. Titles via --flat-playlist; the precise timestamp (yt-dlp 'timestamp', else 'release_timestamp', else upload_date at 00:00 ET + 1 day) fetched per candidate video.",
    "CALLS (from the TITLE only, mechanical, frozen before returns): tickers = $TICKER tokens, or uppercase 2-5 letter tokens that are US common-stock symbols (Alpaca assets, active + inactive; ETFs/ETNs/funds/trusts excluded) and not on a common-word stoplist (A, I, IT, ON, NOW, ALL, ARE, BIG, CAN, FOR, NEW, ONE, SO, AI, DD, CEO, USA, GDP, CPI, FED, IPO, ETF, ATH, EPS, YOLO, etc.), or a company-name match (first distinctive word of the Alpaca asset name, >= 4 letters, not a dictionary word). Direction: SHORT-call if the title has a negative keyword (sell, selling, sold, short, bearish, crash, avoid, warning, dump, overvalued, bubble, collapse, 'don't buy', 'stay away', 'get out'); else LONG-call if it has a positive keyword (buy, buying, bought, bullish, 'to buy', load, loading, accumulate, undervalued, explode, skyrocket, soar, moon, '10x', '100x', millionaire, rally, breakout, 'next nvidia', 'huge upside', 'all in', 'best stock'); else no call. A title naming several tickers makes one call per ticker. Index/ETF-only titles make no call.",
    "PRECISION GATE (before any return is computed): the builder hand-labels a random sample of 200 extracted calls (ticker AND direction). Precision < 80% = CANNOT MEASURE. The extractor is frozen after this check; no change after returns are seen.",
    "TRADE: entry = the first regular-session OPEN strictly after the upload timestamp; exit = the CLOSE of entry session + 4 (cell H5) or + 19 (cell H20). FADE return = -direction x (stock return - SPY return over the same open->close span). Prices: Alpaca SIP daily, adjustment=all; delisted names kept (inactive assets). Calls on a name already called by the same channel in the previous 5 sessions are dropped (duplicate).",
    "COST: 0.20% round trip on every call, plus short borrow at 3%/yr pro rata on the short leg (FADE of a long call is short the stock).",
  ].join(" "),
  statistic: "Weekly calendar-time fade return: for each ENTRY week, mean over channels with calls that week of (mean net FADE return of that channel's calls entered that week). One-sample t over weeks 2023-01..2026-08; Newey-West lag 1 for H5, lag 4 for H20 (overlapping holds). Cell = H5 or H20; the headline is the better cell (bar is best-of-2).",
  unit: "weeks", nExpected: N,
  controls: {
    placebo: "PLACEBO: each call replaced by a random US common stock from the same 60-session dollar-volume decile, same entry timestamp and direction; 500 draws of the whole call set; the observed weekly-mean fade must exceed the placebo p95.",
    halves: "First and second half of the weeks with calls, reported; both must share the sign.",
    mirror: "FOLLOW (= -FADE before costs, charged its own costs) reported beside, not a cell.",
    concentration: "share of calls and of the fade P&L in the 10 most-called tickers, and per-channel fade means, reported (no selection on them).",
  },
  bar: { fixedInAdvance: true, unit: "weeks", tRequired: b, variants: CELLS, source: `nullBar({variants:${CELLS}, n:${N}, trials:20000}).p95 = ${b}` },
  interimKill: "none (single historical read)",
  decisionRule: {
    pass: "PASS only if the better cell's net t >= bar AND the placebo is beaten AND both halves are positive. A PASS proposes a FORWARD paper test on the same 20 channels' new uploads (operator's call); nothing is adopted or funded.",
    fail: "DID NOT PASS: recorded with the numbers; the card closes unless materially new evidence appears.",
    cannotMeasure: "CANNOT MEASURE if: a YouTube sign-in/bot wall blocks the pull (never bypassed); < 1,000 calls in the window; < 100 weeks with calls; or extraction precision < 80% on the 200-call hand check.",
  },
  knownWeaknesses: [
    "Deleted videos: channels remove embarrassing calls, so the surviving record flatters the callers. This biases AGAINST the fade (a PASS is conservative) and FOR the follow mirror.",
    "Channel survivorship: today's most-subscribed channels are survivors; same direction as above.",
    "Title edits: YouTubers retitle videos after the fact ('I told you...'); we only see current titles. Edits after a correct call bias against the fade; edits that add a ticker after a move could add look-ahead in either direction. Disclosed, not measurable.",
    "Title-only calls miss calls made only inside the video; transcripts are not used (cost and noise).",
    "Short borrow on hyped small caps can cost far more than 3%/yr and some names are not shortable: this flatters the fade. The builder reports the fade restricted to the top-1,000 names by dollar volume beside the headline.",
    "Heavy concentration in a few names (NVDA, TSLA, PLTR...) is likely: weekly clustering handles time, not cross-name concentration; the concentration control is reported.",
    "The six search queries and the top-20 cut are choices; they are fixed here before any data, and no other list will be tried.",
  ],
  readCondition: "read once, after --selftest passes its known answers and the precision gate passes; the builder writes channels.json, then calls.json, then the precision check, then returns, in that order.",
  writerExists: false, writerNote: "runner written by a builder agent on 2026-10-01; CANNOT MEASURE is a legitimate outcome, never a silent substitution",
  dataNote: "data/training/r303/ (channels.json, videos-<channel>.json, calls.json, precision-check.json); output data/r303-youtube-fade.json. Inputs are known at the entry timestamp (title at upload; entry strictly after) except title edits (disclosed). Not a board model/filter: the feature manifest does not apply.",
  ip: "ours (public videos; channel names stay internal)",
};
reg.preregistered.push(entry);
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: TODAY, area: "registry — R303 YouTube fade", category: "registration", breaksComparability: false, change: `Registered R303 before any YouTube data: fade title calls of the top-20 stock-pick channels, cells H5/H20, weekly calendar-time t, bar ${b} (best-of-2, n ${N} weeks), placebo + halves gate.`, why: "Operator 2026-10-01: 'yes install it and register the test'.", doesNotEstablish: "Any result.", operator: "Josh 2026-10-01" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "register", tests: [ID], family: "YT-FADE" }) + "\n");
console.log(`${ID} registered · bar ${b} (weeks, best-of-${CELLS}) · ${reg.preregistered.length} preregistered`);
