"use strict";
/**
 * PM FEEDS — the pure half of backend/pm-book-recorder.js (R352's recorder; docs/server/wave7-pm). 2026-10-11.
 *
 * What is here: the public endpoints, the plain request headers and the rule that classifies a venue's answer (ok / not found /
 * rate limit / BLOCKED), the parsers that turn each venue's public payloads into the recorder's row shapes, a JSONL reader that
 * tolerates a torn last line (plain or .gz), and COVERAGE exactly as R352 rule[11] (controls.coverageGate) states it.
 * What is NOT here, on purpose: nothing in this file (or in the recorder) scores anything. No order is modelled, no price is judged,
 * no result is derived from a market's resolution. Coverage counts receive times, rows and published records only.
 *
 * ROW SHAPES (one JSON object a line; the recorder puts "n" (its own counter, strictly rising inside a process) and "rx" (its own
 * receive time, UTC milliseconds) first, then "k" (the kind), then the window: "w" = unix seconds of a Polymarket window's start,
 * "t" = a Kalshi market ticker). Prices and sizes are kept as the venue sent them (strings stay strings).
 *   every stream   open  {sid, venue, stream, part, v}        first row of a part (sid = the recorder process that wrote it)
 *                  close {why: day-roll | size | stop, rows, bytes}   last row of a part that was closed cleanly
 *                  down  {feed, why, detail}                   the feed stopped delivering at about rx
 *                  gap   {feed, t1, t2, why, detail}           THE FEED WAS DOWN FROM t1 TO t2 (t1 = last good row, t2 = first good row
 *                                                              after it); nothing was recorded in between and nothing is filled in.
 *                                                              why clock-step: the host clock jumped by stepMs between t1 and t2.
 *                                                              On pm5/ws (one feed per window) a stretch in which the VENUE was stopped
 *                                                              — blocked, or the disk guard refusing — gets one more gap row that spans
 *                                                              it whole: last good Polymarket row -> first new one, why = the reason.
 *   pm5/ws         sub {tok:{U,D}}   bk {a,ts,h,tk,b:[[price,size]..],s:[[price,size]..],tb?,ta?}   pc {ts,c:[[a,price,size,side,bestBid,bestAsk]..]}
 *                  (tk = the tick size the venue states on the book event; it changes during a market's life. A book event whose bids or
 *                  asks list is missing or unreadable is NOT written as bk: it is a bad row, like any frame that cannot be read)
 *                  ba {a,ts,bb,ba,sp}   lt {a,ts,p,z,sd,fr,tx}   tk {a,ts,o,nw}   ev {t,raw}   hb {rtt}   bad {why,len,head}
 *                  (a = "U" | "D", the window's Up / Down token; ts = the venue's own millisecond stamp; tx = transaction hash)
 *   pm5/tape       tr {tx,a,sd,p,z,ts,o,oi}   tp {att,page,rows,next}       (the Data API tape; no wallet, name or profile field is kept)
 *   pm5/ref        win {slug,cid,tok,open,close,tick,min,fee,twap}   mk {at: pre | post, raw}   td {att,pages,rows,done,why?}   nores {}
 *   k15/book       ob {d,y:[[price,count]..],no:[[price,count]..],ny,nn,u}   (d = ms from request sent to answer received, so sent = rx - d;
 *                  y / no = the best levels kept, in the venue's order; ny / nn = levels in the venue's full book; u = "d" dollars | "c" cents)
 *   k15/tape       tr {id,ct,yp,np,c,ts,tb,to,bl}   tp {att,page,rows,next}
 *   k15/ref        mk {at: next | open | post, raw}   td {att,pages,rows,done,why?}   nores {}   se {raw}
 *                  (td = the end of a tape: the attempt it names holds `rows` prints in `pages` pages; att rises when a tape is fetched again
 *                  from its first page — after a restart, or because a page could not be written. A reader takes the attempt td names.)
 *   spot/ws        sub {raw}   m {id,p,z,sd,t,sq}   lm {..same}   tkr {id,p,z,bb,ba,t,sq}   h {id,sq,t}   bad {why,len,head}
 *   meta/clock     clock {ntp, wallMinusRxMs, venues}
 */
const fs = require("fs"), path = require("path"), zlib = require("zlib");

const UA = "traids-research/1.0 (public market data recorder; read-only)";
const ENDPOINTS = Object.freeze({
  pm5: Object.freeze({ gamma: "https://gamma-api.polymarket.com", data: "https://data-api.polymarket.com", ws: "wss://ws-subscriptions-clob.polymarket.com/ws/market" }),
  k15: Object.freeze({ rest: "https://external-api.kalshi.com/trade-api/v2" }),
  spot: Object.freeze({ ws: "wss://ws-feed.exchange.coinbase.com" }),
});

/** REGISTERED numbers (R352 rule[11], rule[2], rule[9], parameters.coverage). Not settings: a different value is a different test. */
const REG = Object.freeze({
  pm5: Object.freeze({ windowSec: 300, windowsPerUtcDay: 288, minCapturedWindows: 231, tpAfterOpenSec: 30 }),
  k15: Object.freeze({ windowSec: 900, windowsPerUtcDay: 96, minCapturedWindows: 77, minSecondsWithSnapshot: 0.9 }),
  bookGapSec: 5, spotGapSec: 10, spotLeadSec: 1860, tapeTwinShare: 0.95, capturedWindowsPerDayAtLeast: 0.8, resolutionWaitHours: 24,
  minBookLevelsKept: 25, pm5TapeDelayMinSec: 600, k15MaxRequestsPerSec: 2, k15BookEveryMs: 1000,
  pm5Fee: Object.freeze({ feesEnabled: true, rate: 0.07, exponent: 1, takerOnly: true }),
  pm5Twap: Object.freeze({ twapEnabled: true, twapLookbackSeconds: 60 }),
  k15FeeLabel: Object.freeze({ fee_type: "quadratic", fee_multiplier: 1 }),
});

// ── plain requests, and what a venue's answer means ──────────────────────────────────────────────────────────────────────────
const FORBIDDEN_HEADER = /^(authorization|proxy-authorization|cookie|cookie2|x-api-key|api-key|kalshi-access-[a-z-]+|poly[-_][a-z_-]+|cb-access-[a-z-]+|x-forwarded-for|forwarded|via|referer|origin)$/i;
const BROWSER_UA = /mozilla|applewebkit|chrome|safari|firefox|gecko|edg\/|opera|msie|trident/i;
/** the only headers the recorder ever sets on a REST read */
const plainHeaders = () => ({ "user-agent": UA, accept: "application/json" });
/** null when a set of request headers is plain; else what is wrong with it (used by the recorder before every send, and by the fake server) */
function headerProblem(headers) {
  const bad = [];
  for (const [k, v] of Object.entries(headers || {})) {
    if (FORBIDDEN_HEADER.test(k)) bad.push(`${k} is never sent`);
    if (/^user-agent$/i.test(k) && BROWSER_UA.test(String(v))) bad.push("a browser-style User-Agent is never sent");
  }
  return bad.length ? bad.join("; ") : null;
}
const CHALLENGE = /security checkpoint|just a moment|captcha|cf-chl|challenge-platform|attention required|verify (that )?you are (a )?human|are you a robot|access denied|unusual traffic|enable javascript and cookies|bot detection|request blocked|pardon our interruption|think you were a bot|incapsula incident|checking your browser|you have been blocked|errors\.edgesuite\.net/i;
/**
 * Response headers by which a venue's EDGE says "this answer is my mitigation, not the venue's own": Cloudflare (cf-mitigated),
 * Vercel (x-vercel-mitigated), AWS WAF (x-amzn-waf-action: its challenge comes with HTTP 202 and may carry no page at all, its
 * captcha with 405), DataDome (x-dd-b), Sucuri (x-sucuri-block). Each is set only on a mitigated answer, so ANY value of one is a
 * bot check whatever the status and the body say. ANSWER_HEADERS = what the recorder hands to classifyAnswer of an answer's headers.
 */
const WAF_HEADERS = Object.freeze(["cf-mitigated", "x-vercel-mitigated", "x-amzn-waf-action", "x-dd-b", "x-sucuri-block"]);
const ANSWER_HEADERS = Object.freeze(["content-type", ...WAF_HEADERS]);
const headOf = (body, n = 200) => String(body == null ? "" : body).replace(/\s+/g, " ").trim().slice(0, n);
/**
 * A venue's HTTP answer -> { cls, why, page? }.
 *   ok        2xx, not a challenge page
 *   notfound  404 (Polymarket's book and a market that does not exist yet answer this way; never a block)
 *   rate      429 that is a plain rate-limit answer (Kalshi: {"error":"too many requests"}) -> back off, then go on
 *   blocked   401 / 403 / 407 / 451, a 429 that carries a challenge page, any answer that is a bot-check / challenge page (by its
 *             words, or by a mitigation header of the venue's edge: WAF_HEADERS), or a redirect -> THE VENUE IS STOPPED. It is
 *             recorded, paged, and looked at again only on the slow schedule. Never routed around.
 *   error     anything else (5xx, an unreadable body): a failed read, recorded as a gap and retried at the feed's own pace.
 *             page: true marks the answers that are UNKNOWN rather than failed: an HTML page under HTTP 500 where JSON was expected
 *             and that is not a page known above (an interstitial, a sign-in page, a challenge this list has no words for). ONE is a
 *             failed read; the recorder stops the venue when they come in a row (Transport: PAGE_STOP_AFTER), state "unrecognised page".
 */
function classifyAnswer({ status, headers = {}, body = "" }) {
  const h = (k) => String(headers[k] == null ? "" : headers[k]).toLowerCase();
  const html = /text\/html/.test(h("content-type")) || /^\s*<(!doctype|html)/i.test(String(body).slice(0, 200));
  const waf = WAF_HEADERS.find((k) => h(k).trim() !== "") || null;
  const challenge = CHALLENGE.test(String(body).slice(0, 4000)) || !!waf;
  if (status === 401) return { cls: "blocked", why: "login demand (HTTP 401)" };
  if (status === 403) return { cls: "blocked", why: "refusal (HTTP 403)" };
  if (status === 407) return { cls: "blocked", why: "proxy login demand (HTTP 407)" };
  if (status === 451) return { cls: "blocked", why: "geographic refusal (HTTP 451)" };
  if (status >= 300 && status < 400) return { cls: "blocked", why: `redirect (HTTP ${status}) — not followed` };
  if (status === 429) return html || challenge ? { cls: "blocked", why: "bot check (HTTP 429 with a challenge page)" } : { cls: "rate", why: "rate limit (HTTP 429)" };
  if (waf) return { cls: "blocked", why: `bot check (the answer carries ${waf}: ${h(waf).trim().slice(0, 40)}, HTTP ${status})` };
  if (challenge && (html || status >= 400)) return { cls: "blocked", why: `bot check (challenge page, HTTP ${status})` };
  if (status === 404) return { cls: "notfound", why: "HTTP 404" };
  if (html && status < 500) return { cls: "error", page: true, why: `HTTP ${status} with an HTML body where JSON was expected` };
  if (status >= 200 && status < 300) return { cls: "ok", why: "" };
  return { cls: "error", why: `HTTP ${status}` };
}
classifyAnswer.headers = ANSWER_HEADERS; classifyAnswer.waf = WAF_HEADERS;   // for the recorder's transport (which headers of an answer it hands over)
/**
 * The plain-request form of a websocket address (wss://host/path -> https://host/path). The built-in websocket client shows a
 * handshake the venue answered with HTTP 403 or a challenge page only as close code 1006 with no reason, so when a venue's
 * handshakes keep failing the recorder sends ONE plain GET here and classifies the answer with classifyAnswer.
 */
const wsCheckUrl = (wsUrl) => String(wsUrl).replace(/^ws(s?):/i, "http$1:");

// ── small helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const arr = (v) => { if (Array.isArray(v)) return v; if (typeof v === "string") { try { const j = JSON.parse(v); return Array.isArray(j) ? j : null; } catch { return null; } } return null; };
const num = (v) => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStartMs = (date) => Date.parse(date + "T00:00:00.000Z");
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && Number.isFinite(dayStartMs(s)) && utcDay(dayStartMs(s)) === s;
/** keep the `n` best levels of one side in the venue's own order (side "bid": best = highest price; "ask": best = lowest) */
function bestLevels(levels, n, side) {
  if (!Array.isArray(levels)) return { kept: [], total: 0 };
  if (!(n > 0) || levels.length <= n) return { kept: levels, total: levels.length };
  const first = num(levels[0][0]), last = num(levels[levels.length - 1][0]);
  const bestLast = side === "bid" ? last >= first : last <= first;
  return { kept: bestLast ? levels.slice(levels.length - n) : levels.slice(0, n), total: levels.length };
}

// ── Polymarket, the 5-minute bitcoin Up/Down series ──────────────────────────────────────────────────────────────────────────
const PM5_EVENT_KINDS = { book: "bk", price_change: "pc", best_bid_ask: "ba", last_trade_price: "lt", tick_size_change: "tk" };
const SPOT_RECORD_KINDS = new Set(["m", "lm", "tkr", "h"]);   // what the spot feed delivers: trades, tickers and its once-a-second heartbeat
const PM5_FEED_KINDS = new Set(["bk", "pc", "ba", "lt", "tk"]);   // the kinds that are the book feed (rule[11]'s "silence" is their absence)
/**
 * The fee schedule and the settlement average that ONE record of the venue states (its event record as it was served, before the open
 * or after the close) -> { fee, twap }, a field the record does not state being null; null when the record holds no market.
 */
function pm5Terms(ev) {
  const ms = ev && Array.isArray(ev.markets) ? ev.markets.filter((x) => x && typeof x === "object") : [], m = ms.find((x) => x.slug === ev.slug) || ms[0];
  if (!m) return null;
  const fs_ = m.feeSchedule || ev.feeSchedule || null, cc = m.cryptoMarketConfig || ev.cryptoMarketConfig || null;
  return {
    fee: { feesEnabled: m.feesEnabled == null ? null : m.feesEnabled, feeType: m.feeType == null ? null : m.feeType, rate: fs_ ? fs_.rate : null, exponent: fs_ ? fs_.exponent : null, takerOnly: fs_ ? fs_.takerOnly : null, rebateRate: fs_ ? fs_.rebateRate : null },
    twap: { twapEnabled: cc ? cc.twapEnabled : null, twapLookbackSeconds: cc ? cc.twapLookbackSeconds : null },
  };
}
const pm5 = {
  windowSec: REG.pm5.windowSec,
  slugOf: (startSec) => `btc-updown-5m-${startSec}`,
  startOf: (ms) => Math.floor(ms / 300000) * 300,
  eventUrl: (base, startSec) => `${base}/events?slug=${pm5.slugOf(startSec)}`,
  tapeUrl: (base, cid, cursor) => `${base}/v2/trades?condition=${encodeURIComponent(cid)}&limit=1000${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
  subscribeMsg: (tok) => ({ assets_ids: [tok.U, tok.D], type: "market", custom_feature_enabled: true }),
  /** the Gamma answer for one window's slug -> { ok, why, win, raw }. raw = the venue's event record, whole. */
  parseEvent(json, startSec) {
    const ev = (Array.isArray(json) ? json : json && Array.isArray(json.data) ? json.data : json ? [json] : []).find((e) => e && e.slug === pm5.slugOf(startSec));
    if (!ev) return { ok: false, why: "no event with this window's slug in the answer" };
    const ms = Array.isArray(ev.markets) ? ev.markets.filter((x) => x && typeof x === "object") : [], m = ms.find((x) => x.slug === ev.slug) || ms[0];
    if (!m) return { ok: false, why: "the event has no market", raw: ev };
    const toks = arr(m.clobTokenIds), outs = arr(m.outcomes);
    if (!toks || !outs || toks.length !== 2 || outs.length !== 2) return { ok: false, why: "the market does not have two outcome tokens", raw: ev };
    const iU = outs.indexOf("Up"), iD = outs.indexOf("Down");
    if (iU < 0 || iD < 0) return { ok: false, why: `outcomes are ${JSON.stringify(outs)}, not Up / Down`, raw: ev };
    const open = Date.parse(m.eventStartTime || ev.startTime || ""), close = Date.parse(m.endDate || ev.endDate || "");
    const terms = pm5Terms(ev);
    const win = {
      slug: ev.slug, cid: m.conditionId || null, tok: { U: String(toks[iU]), D: String(toks[iD]) },
      open: Number.isFinite(open) ? open : null, close: Number.isFinite(close) ? close : null,
      tick: m.orderPriceMinTickSize == null ? null : m.orderPriceMinTickSize, min: m.orderMinSize == null ? null : m.orderMinSize,
      fee: terms.fee, twap: terms.twap,
    };
    if (!win.cid) return { ok: false, why: "the market has no conditionId", raw: ev };
    if (win.open !== startSec * 1000) return { ok: false, why: `the market's start (${m.eventStartTime || ev.startTime}) is not this window's start`, win, raw: ev };
    if (win.close !== win.open + pm5.windowSec * 1000) return { ok: false, why: `the market's end (${m.endDate || ev.endDate}) is not ${pm5.windowSec} s after its start`, win, raw: ev };
    return { ok: true, win, raw: ev };
  },
  /** has the venue published this window's resolution on its record? (closed, and the outcome prices are exactly one 1 and one 0) */
  resolutionRecorded(rawEvent) {
    const m = rawEvent && Array.isArray(rawEvent.markets) ? rawEvent.markets[0] : null; if (!m || m.closed !== true) return false;
    const p = arr(m.outcomePrices); if (!p || p.length !== 2) return false;
    const a = num(p[0]), b = num(p[1]);
    return (a === 1 && b === 0) || (a === 0 && b === 1);
  },
  feeIsRegistered: (fee) => !!fee && fee.feesEnabled === REG.pm5Fee.feesEnabled && fee.rate === REG.pm5Fee.rate && fee.exponent === REG.pm5Fee.exponent && fee.takerOnly === REG.pm5Fee.takerOnly,
  twapIsRegistered: (t) => !!t && t.twapEnabled === REG.pm5Twap.twapEnabled && t.twapLookbackSeconds === REG.pm5Twap.twapLookbackSeconds,
  /**
   * one websocket text frame -> { pong, rows, foreign, bad }. tok = { U, D } token ids of the window this connection serves.
   * Events for other tokens (the venue's new-market notices among them) are counted as foreign and not written.
   */
  parseWsFrame(text, tok, bookLevels = 0) {
    const out = { pong: false, rows: [], foreign: 0, bad: null };
    const s = String(text);
    if (s === "PONG") { out.pong = true; return out; }
    let j; try { j = JSON.parse(s); } catch { out.bad = { why: "not JSON", len: s.length, head: headOf(s, 80) }; return out; }
    // a frame that IS JSON but broken inside never throws and never becomes data: the part that cannot be read is reported in
    // out.bad (the recorder writes a bad row and a gap for it), and what the venue did not send is never filled in
    const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
    const bad = (why) => { out.bad = { why, len: s.length, head: headOf(s, 80) }; };
    const side = (id) => (id === tok.U ? "U" : id === tok.D ? "D" : null);
    /** one side of a full book: null when the venue sent no list for it, or a level that is not { price, size } (an EMPTY list is an empty side) */
    const lv = (list, sd) => { if (!Array.isArray(list)) return null; const all = []; for (const x of list) { if (!isObj(x) || x.price == null || x.size == null) return null; all.push([x.price, x.size]); } return bestLevels(all, bookLevels, sd); };
    for (const e of Array.isArray(j) ? j : [j]) {
      if (!isObj(e)) { bad("not an event object"); continue; }
      const type = e.event_type, ts = num(e.timestamp);
      if (type === "price_change") {
        const list = Array.isArray(e.price_changes) ? e.price_changes : Array.isArray(e.changes) ? e.changes.map((c) => (isObj(c) ? { ...c, asset_id: c.asset_id || e.asset_id } : c)) : null;
        if (!list) { bad("price_change without a change list"); continue; }
        const c = [];
        for (const x of list) {
          if (!isObj(x)) { bad("price_change item that is not an object"); continue; }
          const a = side(x.asset_id); if (!a) { out.foreign++; continue; }
          if (x.price == null || x.size == null) { bad("price_change item without a price or a size"); continue; }
          c.push([a, x.price, x.size, x.side === "BUY" ? "B" : x.side === "SELL" ? "S" : x.side, x.best_bid == null ? null : x.best_bid, x.best_ask == null ? null : x.best_ask]);
        }
        if (c.length) out.rows.push({ k: "pc", ts, c });
        continue;
      }
      const a = side(e.asset_id);
      if (!a) { out.foreign++; continue; }
      if (type === "book") {
        const b = lv(e.bids, "bid"), sl = lv(e.asks, "ask");
        if (!b || !sl) { bad("book event without a readable bids and asks list"); continue; }   // never written as a book with an empty side
        const row = { k: "bk", a, ts, h: e.hash == null ? null : e.hash, tk: e.tick_size == null ? null : e.tick_size, b: b.kept, s: sl.kept };
        if (b.total > b.kept.length) row.tb = b.total;
        if (sl.total > sl.kept.length) row.ta = sl.total;
        out.rows.push(row);
      } else if (type === "best_bid_ask") out.rows.push({ k: "ba", a, ts, bb: e.best_bid, ba: e.best_ask, sp: e.spread == null ? null : e.spread });
      else if (type === "last_trade_price") out.rows.push({ k: "lt", a, ts, p: e.price, z: e.size, sd: e.side === "BUY" ? "B" : e.side === "SELL" ? "S" : e.side, fr: e.fee_rate_bps == null ? null : e.fee_rate_bps, tx: e.transaction_hash || e.transactionHash || null });
      else if (type === "tick_size_change") out.rows.push({ k: "tk", a, ts, o: e.old_tick_size, nw: e.new_tick_size });
      else out.rows.push({ k: "ev", t: String(type), raw: e });
    }
    return out;
  },
  /** one Data API tape page -> { rows, next, n }. Only the fields the registered rule names are kept: no wallet, name or profile. */
  parseTapePage(json, tok) {
    // the live answer (2026-10-12): { data: [ { proxy_wallet, side, token_id, condition_id, size, price, timestamp, outcome, outcome_index,
    // transaction_hash, name, pseudonym, bio, profile_image, ... } ], pagination: { limit, offset, has_more, next_cursor } }
    const list = Array.isArray(json) ? json : json && Array.isArray(json.data) ? json.data : json && Array.isArray(json.trades) ? json.trades : null;
    if (!list) return { ok: false, why: "the tape answer holds no list of trades" };
    const pg = !Array.isArray(json) && json.pagination && typeof json.pagination === "object" ? json.pagination : null;
    const cur = Array.isArray(json) ? null : (pg ? pg.next_cursor : null) || json.next_cursor || json.nextCursor || json.cursor || null;
    const next = cur && cur !== "LTE=" ? String(cur) : null, more = pg && typeof pg.has_more === "boolean" ? pg.has_more : null;
    const pick = (t, a, b) => (t[a] == null ? (t[b] == null ? null : t[b]) : t[a]);
    const rows = list.map((t) => { const id = t.token_id || t.asset || t.asset_id || null; return { k: "tr", tx: t.transaction_hash || t.transactionHash || null, a: id === tok.U ? "U" : id === tok.D ? "D" : id, sd: t.side == null ? null : t.side, p: t.price, z: t.size, ts: num(t.timestamp), o: t.outcome == null ? null : t.outcome, oi: pick(t, "outcome_index", "outcomeIndex") }; });
    // end = the venue says there is no more (has_more false), or it gives no cursor and the page is not full. stuck = it says there is
    // more (or the page is full) but gives no cursor to ask with: the end of the tape cannot be shown.
    const end = more === false || (!next && more !== true && rows.length < 1000), stuck = !next && !end;
    return { ok: true, rows, n: rows.length, next: end ? null : next, end, stuck };
  },
};

// ── Kalshi, series KXBTC15M ──────────────────────────────────────────────────────────────────────────────────────────────────
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const k15 = {
  series: "KXBTC15M", windowSec: REG.k15.windowSec,
  windowAt: (ms) => { const open = Math.floor(ms / 900000) * 900000; return { open, close: open + 900000 }; },
  /** the market ticker for the window that CLOSES at closeMs: KXBTC15M-<YY><MON><DD><HHMM New York time of the close>-<MM> */
  tickerForClose(closeMs) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(closeMs)).map((x) => [x.type, x.value]));
    const hh = String(Number(p.hour) % 24).padStart(2, "0");
    return `${k15.series}-${p.year}${MON[Number(p.month) - 1]}${p.day}${hh}${p.minute}-${p.minute}`;
  },
  marketUrl: (base, ticker) => `${base}/markets/${encodeURIComponent(ticker)}`,
  openListUrl: (base) => `${base}/markets?series_ticker=${k15.series}&status=open&limit=5`,
  bookUrl: (base, ticker) => `${base}/markets/${encodeURIComponent(ticker)}/orderbook`,
  tradesUrl: (base, ticker, cursor) => `${base}/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=1000${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
  seriesUrl: (base) => `${base}/series/${k15.series}`,
  /** a market record (the venue's object, or the { market } answer around it) -> { ok, m, raw } */
  parseMarket(json) {
    const r = json && json.market && typeof json.market === "object" ? json.market : json;
    if (!r || typeof r.ticker !== "string") return { ok: false, why: "no market record in the answer" };
    const open = Date.parse(r.open_time || ""), close = Date.parse(r.close_time || "");
    return { ok: true, raw: r, m: { t: r.ticker, open: Number.isFinite(open) ? open : null, close: Number.isFinite(close) ? close : null, status: r.status == null ? null : r.status, strike: r.floor_strike == null ? null : r.floor_strike, result: r.result == null ? "" : String(r.result) } };
  },
  parseMarkets(json) { return (json && Array.isArray(json.markets) ? json.markets : []).map((r) => k15.parseMarket(r)).filter((x) => x.ok); },
  resolutionRecorded: (raw) => !!raw && (raw.result === "yes" || raw.result === "no"),
  feeLabelIsRegistered: (rawSeries) => !!rawSeries && rawSeries.fee_type === REG.k15FeeLabel.fee_type && rawSeries.fee_multiplier === REG.k15FeeLabel.fee_multiplier,
  /** an order-book answer -> the best `levels` a side, in the venue's order (both sides are BIDS: a No bid at Y is a Yes ask at $1-Y) */
  parseOrderbook(json, levels = REG.minBookLevelsKept) {
    const fp = json && json.orderbook_fp, lg = json && json.orderbook;
    const src = fp && (fp.yes_dollars || fp.no_dollars) ? { y: fp.yes_dollars, n: fp.no_dollars, u: "d" } : lg && (lg.yes_dollars || lg.no_dollars) ? { y: lg.yes_dollars, n: lg.no_dollars, u: "d" } : lg && ("yes" in lg || "no" in lg) ? { y: lg.yes, n: lg.no, u: "c" } : fp || lg ? { y: [], n: [], u: "d" } : null;
    if (!src) return { ok: false, why: "no orderbook in the answer" };
    const y = bestLevels(Array.isArray(src.y) ? src.y : [], levels, "bid"), n = bestLevels(Array.isArray(src.n) ? src.n : [], levels, "bid");
    return { ok: true, row: { k: "ob", y: y.kept, no: n.kept, ny: y.total, nn: n.total, u: src.u } };
  },
  parseTrades(json) {
    if (!json || !Array.isArray(json.trades)) return { ok: false, why: "the answer holds no list of trades" };
    const rows = json.trades.map((t) => ({ k: "tr", id: t.trade_id, ct: t.created_time, yp: t.yes_price_dollars == null ? (t.yes_price == null ? null : t.yes_price) : t.yes_price_dollars, np: t.no_price_dollars == null ? (t.no_price == null ? null : t.no_price) : t.no_price_dollars, c: t.count_fp == null ? (t.count == null ? null : t.count) : t.count_fp, ts: t.taker_side == null ? null : t.taker_side, tb: t.taker_book_side == null ? null : t.taker_book_side, to: t.taker_outcome_side == null ? null : t.taker_outcome_side, bl: t.is_block_trade == null ? null : t.is_block_trade }));
    return { ok: true, rows, n: rows.length, next: json.cursor ? String(json.cursor) : null };
  },
};

// ── Coinbase Exchange BTC-USD (spot) ─────────────────────────────────────────────────────────────────────────────────────────
const spot = {
  product: "BTC-USD",
  subscribeMsg: () => ({ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker", "matches", "heartbeat"] }),
  /** one websocket text frame -> { rows, bad, refused } */
  parseWsFrame(text) {
    const out = { rows: [], bad: null, refused: null };
    const s = String(text); let j; try { j = JSON.parse(s); } catch { out.bad = { why: "not JSON", len: s.length, head: headOf(s, 80) }; return out; }
    if (!j || typeof j !== "object") { out.bad = { why: "not a message object", len: s.length, head: headOf(s, 80) }; return out; }
    const t = j.type;
    if (t === "error") { out.refused = headOf((j.message || "") + " " + (j.reason || ""), 160); return out; }
    if (t === "subscriptions") { out.rows.push({ k: "sub", raw: j }); return out; }
    if (j.product_id && j.product_id !== spot.product) return out;
    if (t === "match" || t === "last_match") out.rows.push({ k: t === "match" ? "m" : "lm", id: j.trade_id, p: j.price, z: j.size, sd: j.side, t: j.time, sq: j.sequence == null ? null : j.sequence });
    else if (t === "ticker") out.rows.push({ k: "tkr", id: j.trade_id, p: j.price, z: j.last_size, bb: j.best_bid, ba: j.best_ask, t: j.time, sq: j.sequence == null ? null : j.sequence });
    else if (t === "heartbeat") out.rows.push({ k: "h", id: j.last_trade_id, sq: j.sequence == null ? null : j.sequence, t: j.time });
    else out.bad = { why: `unknown message type ${JSON.stringify(t)}`, len: s.length, head: headOf(s, 80) };
    return out;
  },
};

/// ── files: <root>/<venue>/<UTC date>/<stream>.<part>.jsonl[.gz] ──────────────────────────────────────────────────────────────
const STREAMS = Object.freeze({ pm5: ["ws", "tape", "ref"], k15: ["book", "tape", "ref"], spot: ["ws"], meta: ["clock"] });
const PART_RE = /^([a-z]+)\.(\d{4})\.jsonl(\.gz)?$/;
/** the parts of one stream of one day, in order: [{ file, part, gz }] (a part that exists both plain and .gz is listed once, plain) */
function partsOf(root, venue, date, stream) {
  const dir = path.join(root, venue, date); let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  const by = new Map();
  for (const n of names) { const m = PART_RE.exec(n); if (!m || m[1] !== stream) continue; const p = Number(m[2]), cur = by.get(p); if (!cur || (cur.gz && !m[3])) by.set(p, { file: path.join(dir, n), part: p, gz: !!m[3] }); }
  return [...by.values()].sort((a, b) => a.part - b.part);
}
/**
 * Read one part line by line. onLine(text) gets each COMPLETE line; returning false stops the read. A last line with no newline (a
 * crash tore it) is not passed on: it is counted in the result's `torn`. Returns { lines, torn, bytes, stopped }.
 */
function eachLine(file, onLine) {
  return new Promise((resolve, reject) => {
    const src = fs.createReadStream(file), st = /\.gz$/.test(file) ? src.pipe(zlib.createGunzip()) : src;
    let rest = "", lines = 0, bytes = 0, done = false;
    const fin = (stopped) => { if (done) return; done = true; if (stopped) { try { src.destroy(); } catch { /* closed */ } } resolve({ lines, torn: !stopped && rest.length ? 1 : 0, bytes, stopped }); };
    st.setEncoding("utf8");
    st.on("data", (chunk) => {
      if (done) return;
      bytes += Buffer.byteLength(chunk); const s = rest + chunk; let from = 0, i;
      while ((i = s.indexOf("\n", from)) >= 0) { if (i > from) { lines++; if (onLine(s.slice(from, i)) === false) { fin(true); return; } } from = i + 1; }
      rest = s.slice(from);
    });
    st.on("end", () => fin(false)); st.on("close", () => fin(false));
    st.on("error", (e) => (done ? null : reject(e))); src.on("error", (e) => (done ? null : reject(e)));
  });
}
/** every row of one part as objects; a line that does not parse is counted (corrupt), never thrown */
async function readRows(file) {
  const rows = []; let corrupt = 0;
  const r = await eachLine(file, (l) => { try { rows.push(JSON.parse(l)); } catch { corrupt++; } });
  return { rows, corrupt, torn: r.torn };
}
const HEAD_RE = /^\{"n":(\d+),"rx":(\d+),"k":"([a-z]+)"(?:,"w":(\d+)|,"t":"([^"]+)")?/;
/** the leading stamps of a row line without parsing it: { n, rx, k, w, t } | null */
function rowHead(line) { const m = HEAD_RE.exec(line); return m ? { n: Number(m[1]), rx: Number(m[2]), k: m[3], w: m[4] == null ? null : Number(m[4]), t: m[5] == null ? null : m[5] } : null; }
/** the receive time of a part's first row (its "open" row) | null */
async function firstRx(file) { let rx = null; try { await eachLine(file, (l) => { const h = rowHead(l); rx = h ? h.rx : null; return false; }); } catch { rx = null; } return rx; }
/**
 * Every row of one stream over some days, in file order: onRow(line, head). Rows received after toMs end the scan; a part that the
 * next part of its day shows to end before fromMs is not opened. -> { parts, lines, torn }
 */
async function scanStream(root, venue, stream, dates, onRow, { fromMs = -Infinity, toMs = Infinity } = {}) {
  const stats = { parts: 0, lines: 0, torn: 0 };
  for (const date of dates) {
    const parts = partsOf(root, venue, date, stream);
    for (let i = 0; i < parts.length; i++) {
      if (Number.isFinite(fromMs) && i + 1 < parts.length) { const nx = await firstRx(parts[i + 1].file); if (nx != null && nx <= fromMs) continue; }
      let past = false;
      const r = await eachLine(parts[i].file, (l) => { const h = rowHead(l); if (!h) return true; if (h.rx > toMs && h.k !== "gap") { past = true; return false; } onRow(l, h); return true; });
      stats.parts++; stats.lines += r.lines; stats.torn += r.torn;
      if (past) return stats;
    }
  }
  return stats;
}

// ── COVERAGE, as R352 rule[11] states it ─────────────────────────────────────────────────────────────────────────────────────
/**
 * The longest stretch with no record inside [A, B]: the largest difference between neighbours of A, t1, t2, ..., B (the t's inside
 * [A, B], in receive order). "No gap longer than G" holds when result() <= G. A stretch a host-clock step made unusable (blackouts:
 * [[from, to]]) counts as silence for its whole length inside [A, B], whatever was stamped in it.
 */
class Silence {
  constructor(A, B) { this.A = A; this.B = B; this.prev = A; this.max = 0; this.count = 0; }
  add(t) { if (t < this.A || t > this.B || t < this.prev) return; if (t - this.prev > this.max) this.max = t - this.prev; this.prev = t; this.count++; }
  result(blackouts = []) { let m = Math.max(this.max, this.B - this.prev); for (const [a, b] of blackouts) { const x = Math.min(b, this.B) - Math.max(a, this.A); if (x > m) m = x; } return m; }
}
const longestSilence = (times, A, B, blackouts = []) => { const s = new Silence(A, B); for (const t of times) s.add(t); return s.result(blackouts); };
/** receive times in rising order (a time that goes back, after a host-clock step, is left out) */
function rising(times) { const out = []; let prev = -Infinity; for (const t of times) { if (t < prev) continue; out.push(t); prev = t; } return out; }
/** the longest stretch without a record inside [A, B], for a long RISING list of times (binary search to A, then one pass to B) */
function silenceIn(sorted, A, B, blackouts = []) {
  let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < A) lo = mid + 1; else hi = mid; }
  const s = new Silence(A, B); for (let i = lo; i < sorted.length && sorted[i] <= B; i++) s.add(sorted[i]);
  return s.result(blackouts);
}
/**
 * WHICH READING of rule[11]'s "the spot record has no gap longer than 10 s" the gate in coverDay uses. The entry does not say whether a
 * gap is the feed delivering nothing ("feed-silent": no trade, ticker or heartbeat for more than 10 s) or no TRADE for that long
 * ("no-trade"). Both are computed for every window and stated for every day, and the gate reads the first. Which one is registered is
 * the registrar's to fix, by a dated note in R352's entry before the evidence starts: docs/server/wave7-pm/record-evidence-start.cjs
 * refuses while that note is absent, and while it names another reading than this constant (the gate is then changed first, by a build).
 */
const SPOT_GAP_READING = "feed-silent";
const waitOver = (close, nowMs) => nowMs >= close + REG.resolutionWaitHours * 3600000;
/**
 * "Its tape was paged to the end" is read from what is ON DISK, not from the end row alone: the td row names an attempt and how many
 * prints that attempt held, and the tape counts only when exactly that many tr rows of that attempt are in the tape stream. (A page the
 * recorder fetched but could not write — the disk guard, a write error — is a page that is not on record.)
 */
const TAPE_SHORT = "the tape's rows on disk are not the number its end row names";

/** one Polymarket window's verdict from its counts (pure). why = every part of rule[11] that does not hold. */
function pm5Verdict(x, nowMs) {
  const why = [];
  if (!x.win) why.push("no window record");
  if (!(x.fullBookBeforeTp > 0)) why.push("no full-book event before tP");
  if (!(x.bookSilenceMs <= REG.bookGapSec * 1000)) why.push("book feed silent for more than 5 s");
  if (!(x.spotSilenceMs <= REG.spotGapSec * 1000)) why.push("spot gap longer than 10 s");
  if (!x.tapeDone) why.push(x.tapeShort ? TAPE_SHORT : "tape not paged to the end");
  else if (x.tapeInWindow > 0 && !(x.tapeTwins >= REG.tapeTwinShare * x.tapeInWindow)) why.push("fewer than 95% of the tape's prints have a websocket twin");
  if (!x.resolved) why.push(waitOver(x.close, nowMs) ? "no published resolution 24 h after the close" : "resolution not published yet");
  // the window record (taken before the open) AND every record of its market that is on disk: x.feeOff / x.twapOff = how many of
  // those records, the ones read after the close among them, do not state the registered schedule / the registered average
  if (x.win && (!pm5.feeIsRegistered(x.win.fee) || x.feeOff > 0)) why.push("fee schedule is not the registered one");
  if (x.win && (!pm5.twapIsRegistered(x.win.twap) || x.twapOff > 0)) why.push("settlement average is not the registered one");
  return { captured: why.length === 0, pending: !!x.win && (!x.resolved || !x.tapeDone) && !waitOver(x.close, nowMs), why };
}
/** one Kalshi window's verdict from its counts (pure) */
function k15Verdict(x, nowMs) {
  const why = [], need = Math.ceil(REG.k15.minSecondsWithSnapshot * REG.k15.windowSec);
  if (!x.market) why.push("no market record");
  else if (x.market.close !== x.close) why.push("the market's close time is not this window's close");
  if (!(x.bookSilenceMs <= REG.bookGapSec * 1000)) why.push("two snapshots more than 5 s apart");
  if (!(x.secondsWithSnapshot >= need)) why.push("fewer than 90% of its seconds hold a snapshot");
  if (!(x.spotSilenceMs <= REG.spotGapSec * 1000)) why.push("spot gap longer than 10 s");
  if (!x.tapeDone) why.push(x.tapeShort ? TAPE_SHORT : "tape not paged to the end");
  if (!x.resolved) why.push(waitOver(x.close, nowMs) ? "no published resolution 24 h after the close" : "resolution not published yet");
  if (!x.feeLabelRegistered) why.push("fee label is not the registered one");
  return { captured: why.length === 0, pending: !!x.market && (!x.resolved || !x.tapeDone) && !waitOver(x.close, nowMs), why };
}
const addDays = (date, n) => utcDay(dayStartMs(date) + n * 86400000);
/** the span a host-clock step made unusable, from a gap row with why "clock-step" -> [from, to] | null */
function blackoutOf(line) { if (line.indexOf('"why":"clock-step"') < 0) return null; try { const r = JSON.parse(line); return r.k === "gap" && Number.isFinite(r.t1) && Number.isFinite(r.t2) ? [Math.min(r.t1, r.t2), Math.max(r.t1, r.t2)] : null; } catch { return null; } }
const inSpan = (list, t) => { for (const [a, b] of list) if (t > a && t <= b) return true; return false; };

/**
 * COVERAGE OF ONE UTC DAY (by window open time) for one venue, read from the recorder's files under `root`.
 * -> { venue, date, windows, captured, minCaptured, qualifies, pending, final, reasons: { why: count }, rows: [ per window ] }
 * A day QUALIFIES when at least 80% of its windows are captured (PM5 231 of 288, K15 77 of 96). `final` is false while a window's
 * tape or resolution may still arrive (inside 24 h of its close): the count can still rise.
 * READINGS taken where rule[11] leaves an edge open (each is the stricter or the literal one; NOTES.md lists them):
 *   "from its open to its close" = stretches INSIDE [open, close] (the same for spot, from open - 31 min); a gap is "longer than" the
 *   limit only when it exceeds it; PM5 "silence" = no full-book, price-change, best-bid-ask, last-trade or tick-size event for the
 *   window's tokens (a keep-alive answer is not an event); "a full-book event before tP" = at least one, for either token, received
 *   strictly before open + 30 s; a spot "gap" = a stretch in which the recorder received NOTHING from the spot feed (no trade, ticker or
 *   heartbeat; the heartbeat comes once a second, so a quiet market is not a gap and a dead feed is) — the entry uses "gap" for what
 *   the recorder missed ("Recorder gaps", "a day with gaps"); the other reading, a stretch with no TRADE, is counted beside it in
 *   out.spot (capturedIfTradeQuietCounted, qualifiesIfTradeQuietCounted) so that every day states BOTH. THE ENTRY DOES NOT SAY WHICH,
 *   and it matters: in the builder's two quiet-hour probes the longest stretch with no Coinbase trade was 7.1 s and 5.2 s inside one
 *   minute, so stretches over 10 s will occur. The reading is the registrar's to fix before the evidence starts (NOTES.md); nothing
 *   here needs re-recording whichever way it goes; "stamped inside the window" = open <= the tape's stamp <= close; K15 "its seconds" = the 900 whole seconds from the open, by a snapshot's receive time;
 *   "its tape was paged to the end" = the tape's end row (td) says done AND exactly the number of prints it names for its attempt are
 *   in the tape stream (a page that was fetched but could not be written is not a page on record: TAPE_SHORT);
 *   PM5 "its fee schedule is the registered one" and "its market record shows the registered settlement average" = the window record
 *   taken before the open states them AND SO DOES EVERY RECORD OF ITS MARKET ON DISK, the ones read after the close among them
 *   (rule[9]: "a window whose own market record shows a different fee schedule is dropped"): a record of the market that states
 *   another value, or does not state it, fails the window; an answer that holds no market at all is not a record of it. (Measured in
 *   both builder probes: the venue's record of a CLOSED market still carries feesEnabled, feeSchedule and cryptoMarketConfig, with
 *   the registered values.)
 */
async function coverDay({ root, venue, date, nowMs = Date.now() }) {
  if (venue !== "pm5" && venue !== "k15") throw new Error(`coverage: unknown venue ${venue}`);
  if (!isDate(date)) throw new Error(`coverage: bad UTC date ${date}`);
  const R = REG[venue], d0 = dayStartMs(date), W = R.windowSec * 1000, n = R.windowsPerUtcDay, d1 = d0 + 86400000;
  const wins = []; for (let i = 0; i < n; i++) wins.push({ open: d0 + i * W, close: d0 + (i + 1) * W });
  // spot: trades' receive times from 31 minutes before the day's first open to its last close
  const spotTimes = [], tradeTimes = [], spotBlack = [], lead = REG.spotLeadSec * 1000; let lastId = null, idBreaks = 0;
  await scanStream(root, "spot", "ws", [addDays(date, -1), date, addDays(date, 1)], (l, h) => {
    if (h.k === "gap") { const b = blackoutOf(l); if (b) spotBlack.push(b); return; }
    if (!SPOT_RECORD_KINDS.has(h.k) || h.rx < d0 - lead || h.rx > d1) return;
    spotTimes.push(h.rx);
    if (h.k === "m") { tradeTimes.push(h.rx); const m = /^[^,]*,[^,]*,"k":"m","id":(\d+)/.exec(l), id = m ? Number(m[1]) : null; if (id != null && lastId != null && id > lastId + 1) idBreaks++; if (id != null && (lastId == null || id > lastId)) lastId = id; }
  }, { fromMs: d0 - lead, toMs: d1 });
  // a stretch a host-clock step made unusable: the rows stamped inside it are left out here (after a step back each of those stamps
  // was given twice), so the stretch shows in the record as a silence at least as long as itself, from the last row before it to the
  // first row past it. (That is why no blackout is handed to silenceIn below: with those rows gone it could never add anything.)
  const spotSorted = rising(spotTimes.filter((t) => !inSpan(spotBlack, t))), tradeSorted = rising(tradeTimes.filter((t) => !inSpan(spotBlack, t)));
  const spotOf = (w) => silenceIn(spotSorted, w.open - lead, w.close), tradeOf = (w) => silenceIn(tradeSorted, w.open - lead, w.close);
  const refDates = [addDays(date, -2), addDays(date, -1), date, addDays(date, 1), addDays(date, 2)];
  const out = { venue, date, windows: n, captured: 0, minCaptured: R.minCapturedWindows, qualifies: false, pending: 0, final: true, reasons: {}, rows: [] };
  const black = [];
  if (venue === "pm5") {
    const by = new Map(wins.map((w) => [w.open / 1000, { ...w, w: w.open / 1000, win: null, resolved: false, feeOff: 0, twapOff: 0, tdAtt: null, tdRows: null, book: new Silence(w.open, w.close), fullU: 0, fullD: 0, events: 0, wsTx: new Set(), tape: new Map(), tapeN: new Map(), att: null }]));
    await scanStream(root, "pm5", "ref", refDates, (l, h) => {
      if (h.w == null) return; const x = by.get(h.w); if (!x || (h.k !== "win" && h.k !== "mk" && h.k !== "td")) return;
      let r; try { r = JSON.parse(l); } catch { return; }
      if (r.k === "win") x.win = r;
      else if (r.k === "mk") {
        if (pm5.resolutionRecorded(r.raw)) x.resolved = true;
        // EVERY record of the window's market on disk is held to rule[9] / rule[11], the ones read after the close too: one that
        // does not state the registered fee schedule (or the registered settlement average) fails the window. (An answer that
        // holds no market is not a record of its market: it states nothing, and is not counted either way.)
        const t = pm5Terms(r.raw); if (t && !pm5.feeIsRegistered(t.fee)) x.feeOff++; if (t && !pm5.twapIsRegistered(t.twap)) x.twapOff++;
      } else if (r.done === true) { x.tdAtt = r.att == null ? 1 : r.att; x.tdRows = Number.isInteger(r.rows) ? r.rows : null; }
    });
    await scanStream(root, "pm5", "tape", [date, addDays(date, 1), addDays(date, 2)], (l, h) => {
      if (h.w == null || (h.k !== "tr" && h.k !== "tp")) return; const x = by.get(h.w); if (!x) return;
      let r; try { r = JSON.parse(l); } catch { return; }
      // a tp row opens a page and names the attempt its prints belong to; page 1 starts the attempt afresh (an attempt a restart
      // began again under the same number replaces its earlier, unfinished pages: they are never counted twice)
      if (r.k === "tp") { x.att = r.att == null ? 1 : r.att; if (r.page === 1 || !x.tape.has(x.att)) { x.tape.set(x.att, []); x.tapeN.set(x.att, 0); } return; }
      x.tapeN.set(x.att, (x.tapeN.get(x.att) || 0) + 1);   // every print of the attempt that is on disk, whatever its stamp
      const ms = r.ts == null ? null : r.ts > 1e11 ? r.ts : r.ts * 1000;
      if (ms != null && ms >= x.open && ms <= x.close) { if (!x.tape.has(x.att)) x.tape.set(x.att, []); x.tape.get(x.att).push(r.tx); }
    });
    await scanStream(root, "pm5", "ws", [addDays(date, -1), date, addDays(date, 1)], (l, h) => {
      if (h.k === "gap") { const b = blackoutOf(l); if (b) black.push(b); return; }
      if (h.w == null || !PM5_FEED_KINDS.has(h.k)) return; const x = by.get(h.w); if (!x) return;
      if (h.k === "lt") { const m = /"tx":"([^"]+)"/.exec(l); if (m) x.wsTx.add(m[1]); }
      x.book.add(h.rx); x.events++;
      if (h.k === "bk" && h.rx < x.open + R.tpAfterOpenSec * 1000) { if (l.slice(0, 96).indexOf('"a":"U"') >= 0) x.fullU++; else x.fullD++; }
    }, { fromMs: d0 - 120000, toMs: d1 + 120000 });
    for (const x of by.values()) {
      // a twin = a tape print whose hash is among the hashes the websocket's last-trade events delivered. x.wsTx holds those hashes and
      // nothing else (a websocket print without one adds nothing to it), so a tape print with no hash is never a twin
      const prints = x.tdAtt != null ? x.tape.get(x.tdAtt) || [] : [], twins = prints.filter((tx) => x.wsTx.has(tx)).length;
      const onDisk = x.tdAtt != null ? x.tapeN.get(x.tdAtt) || 0 : 0, short = x.tdAtt != null && x.tdRows !== onDisk;
      const c = { win: x.win, close: x.close, fullBookBeforeTp: x.fullU + x.fullD, bookSilenceMs: x.book.result(black), spotSilenceMs: spotOf(x), tapeDone: x.tdAtt != null && !short, tapeShort: short, tapeInWindow: prints.length, tapeTwins: twins, resolved: x.resolved, feeOff: x.feeOff, twapOff: x.twapOff };
      const v = pm5Verdict(c, nowMs);
      out.rows.push({ w: x.w, captured: v.captured, pending: v.pending, why: v.why, events: x.events, fullBookBeforeTp: { U: x.fullU, D: x.fullD }, bookSilenceMs: c.bookSilenceMs, spotSilenceMs: c.spotSilenceMs, spotTradeSilenceMs: tradeOf(x), tapeDone: c.tapeDone, tapeRows: onDisk, tapeRowsNamed: x.tdRows, tapeInWindow: prints.length, tapeTwins: twins, wsPrints: x.wsTx.size, resolved: x.resolved });
    }
  } else {
    const byOpen = new Map(wins.map((w) => [w.open, { ...w, t: null, market: null, resolved: false, tapeDone: false, tapeShort: false, tapeRows: 0, tapeRowsNamed: null, book: new Silence(w.open, w.close), secs: new Map(), snaps: 0 }]));
    const byTicker = new Map(), series = [], done = new Map(), tapeN = new Map(), tapeAtt = new Map();
    await scanStream(root, "k15", "ref", refDates, (l, h) => {
      if (h.k !== "se" && h.k !== "mk" && h.k !== "td") return; let r; try { r = JSON.parse(l); } catch { return; }
      if (r.k === "se") { series.push([r.rx, r.raw]); return; }
      if (r.k === "td") { if (r.done === true && r.t) done.set(r.t, { att: r.att == null ? 1 : r.att, rows: Number.isInteger(r.rows) ? r.rows : null }); return; }
      const p = k15.parseMarket(r.raw); if (!p.ok) return; const x = byOpen.get(p.m.open); if (!x) return;
      x.t = p.m.t; x.market = p.m; byTicker.set(p.m.t, x); if (k15.resolutionRecorded(r.raw)) x.resolved = true;
    });
    // the prints ON DISK of each market's tape, by attempt: a tp row opens a page and names the attempt its tr rows belong to, and
    // page 1 starts the attempt afresh. (A tape is read until 24 h after its close at the latest, so the scan ends an hour after that.)
    await scanStream(root, "k15", "tape", [date, addDays(date, 1), addDays(date, 2)], (l, h) => {
      if (!h.t || !byTicker.has(h.t)) return;
      if (h.k === "tp") { const head = l.slice(0, 240), a = /"att":(\d+)/.exec(head), pg = /"page":(\d+)/.exec(head), att = a ? Number(a[1]) : 1; tapeAtt.set(h.t, att); if (pg && Number(pg[1]) === 1) tapeN.set(h.t + "#" + att, 0); return; }
      if (h.k === "tr") { const key = h.t + "#" + tapeAtt.get(h.t); tapeN.set(key, (tapeN.get(key) || 0) + 1); }
    }, { fromMs: d0, toMs: d1 + (REG.resolutionWaitHours + 1) * 3600000 });
    for (const [t, x] of byTicker) { const d = done.get(t); if (!d) continue; x.tapeRowsNamed = d.rows; x.tapeRows = tapeN.get(t + "#" + d.att) || 0; x.tapeShort = d.rows !== x.tapeRows; x.tapeDone = !x.tapeShort; }
    await scanStream(root, "k15", "book", [date, addDays(date, 1)], (l, h) => {
      if (h.k === "gap") { const b = blackoutOf(l); if (b) black.push(b); return; }
      if (h.k !== "ob" || !h.t) return; const x = byTicker.get(h.t); if (!x) return;
      x.book.add(h.rx);
      if (h.rx >= x.open && h.rx < x.close) { const s = Math.floor((h.rx - x.open) / 1000); if (!x.secs.has(s)) x.secs.set(s, h.rx); x.snaps++; }
    }, { fromMs: d0 - 60000, toMs: d1 + 60000 });
    const labelAt = (close) => { let hit = null; for (const [rx, raw] of series) { if (rx <= close) hit = raw; else if (!hit) hit = raw; } return hit; };
    for (const x of byOpen.values()) {
      let secs = 0; for (const rx of x.secs.values()) if (!inSpan(black, rx)) secs++;
      const c = { market: x.market, close: x.close, bookSilenceMs: x.book.result(black), secondsWithSnapshot: secs, spotSilenceMs: spotOf(x), tapeDone: x.tapeDone, tapeShort: x.tapeShort, resolved: x.resolved, feeLabelRegistered: k15.feeLabelIsRegistered(labelAt(x.close)) };
      const v = k15Verdict(c, nowMs);
      out.rows.push({ w: x.open / 1000, t: x.t, captured: v.captured, pending: v.pending, why: v.why, snapshots: x.snaps, secondsWithSnapshot: secs, bookSilenceMs: c.bookSilenceMs, spotSilenceMs: c.spotSilenceMs, spotTradeSilenceMs: tradeOf(x), tapeDone: x.tapeDone, tapeRows: x.tapeRows, tapeRowsNamed: x.tapeRowsNamed, resolved: x.resolved });
    }
  }
  for (const r of out.rows) { if (r.captured) out.captured++; if (r.pending) out.pending++; for (const y of r.why) out.reasons[y] = (out.reasons[y] || 0) + 1; }
  // reported beside the gate, never part of it: how the day would look if a quiet market (the feed alive, no trade for more than 10 s)
  // were read as a gap too, and how often a trade id was skipped between two recorded trades
  out.spot = { tradeQuietWindows: out.rows.filter((r) => r.spotSilenceMs <= REG.spotGapSec * 1000 && r.spotTradeSilenceMs > REG.spotGapSec * 1000).length, capturedIfTradeQuietCounted: out.rows.filter((r) => r.captured && r.spotTradeSilenceMs <= REG.spotGapSec * 1000).length, tradeIdBreaks: idBreaks };
  // BOTH readings of "the spot record has no gap longer than 10 s" are always stated, day by day (NOTES.md, "Needs your decision"):
  // `captured` / `qualifies` read a gap as the feed delivering nothing; the two fields below read a stretch with no TRADE as a gap too
  out.spot.qualifiesIfTradeQuietCounted = out.spot.capturedIfTradeQuietCounted >= R.minCapturedWindows;
  out.spot.gateReads = "a spot gap = nothing received from the spot feed (no trade, ticker or heartbeat) for more than 10 s; capturedIfTradeQuietCounted / qualifiesIfTradeQuietCounted = the same day if a stretch with no TRADE for more than 10 s is a gap too";
  out.qualifies = out.captured >= R.minCapturedWindows;
  out.final = out.pending === 0 && nowMs >= d1;
  return out;
}

module.exports = { UA, ENDPOINTS, REG, STREAMS, plainHeaders, headerProblem, classifyAnswer, wsCheckUrl, headOf, bestLevels, pm5, k15, spot, PM5_FEED_KINDS, PM5_EVENT_KINDS, SPOT_RECORD_KINDS,
  partsOf, eachLine, readRows, rowHead, firstRx, scanStream, utcDay, dayStartMs, isDate, addDays,
  Silence, longestSilence, rising, silenceIn, pm5Verdict, k15Verdict, coverDay, TAPE_SHORT, SPOT_GAP_READING };
