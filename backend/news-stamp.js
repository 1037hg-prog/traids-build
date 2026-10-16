#!/usr/bin/env node
/**
 * NEWS STAMP — attach a news and event observation to every live ticket, at entry.
 *
 * THE OPERATOR, 2026-08-26: "all trades should cross reference news in some way shape or form",
 * and "news has to be a weighted factor". This is the part that has to exist first. A weight
 * cannot be fitted, tested, or argued about until the observation is on the ticket.
 *
 * WHAT PROMPTED IT. Asked whether earnings proximity predicts SPREAD — a legitimate cost question,
 * and cost is the largest number on this board — the test returned **n=6**. Not a null: unanswerable.
 * Six stamped spreads in the whole clean era joined to a known earnings date, and all six were more
 * than 45 days out. Every news question the board might ask is currently unanswerable for the same
 * reason. Stamping is the fix, and 20 sessions of stamps makes all of them answerable at once.
 *
 * WHAT IT IS NOT. Not a signal and not a weight. It RECORDS. The weight gets FITTED later, from
 * stamped outcomes, the same way R56's cost model was fitted from real spread stamps rather than
 * assumed. Guessing a weight now and calling it evidence-led is the failure this shop exists to avoid.
 *
 * WHAT THE BOARD ALREADY KNOWS, so the fitted weight is not read naively:
 *   R13 measured pre-market news into intraday drift on 21,254 events across 290 days. Gross
 *   -0.508pp (t -4.202), NET -0.708pp (t -5.856). News gaps drift significantly AGAINST the
 *   registered direction. That is a real, large-sample effect with the sign opposite to the naive
 *   reading — and it CANNOT be traded on R13's own evidence, because flipping a registered sign
 *   after seeing the data is exactly the post-hoc move the registry forbids. It needs a fresh
 *   registration and forward evidence. Any weight fitted from these stamps inherits that caution.
 *
 * FORWARD-ONLY, NEVER BACKFILLED. Historical tickets are not stamped. The news cycle refreshes
 * through the day, so stamping an old ticket would attach articles published AFTER its entry —
 * textbook look-ahead, and the exact defect that cost R12 its verdict (1,006 of 1,855 events priced
 * at the first available bar). Every stamp records `newsAsOf` (when the cycle was generated) and
 * `stampLagMin` (cycle age at stamp time) so vintage is auditable rather than assumed.
 *
 * Output: writes obs.news* onto board_positions.json tickets; summary to data/news-stamp.json
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return d; } };

// Source is now data/news-fetch.json (Finnhub, one call per held symbol) rather than
// market-news-cycle.json (topic-driven, covered 30 of 170 held names). See news-fetch.js header.
const fetched = readJson("news-fetch.json");
const roster = readJson("r43-earnings-roster.json", {});
const macro = readJson("macro-calendar.json", {});
if (!fetched || !fetched.symbols_) { console.error("no news-fetch.json — run backend/news-fetch.js first"); process.exit(1); }

const newsAsOf = fetched.asOf;
const cycleAgeMin = Math.round((Date.now() - new Date(newsAsOf).getTime()) / 60000);
const STALE_MIN = Number(process.env.NEWS_STALE_MIN || 240);

const byS = fetched.symbols_;
const sectors = fetched.sectors || {};

// nearest FUTURE earnings date per symbol
const earn = {};
for (const [k, v] of Object.entries(roster.prints || {})) {
  const s = k.split("|")[0], d = v && v.reportDate;
  if (typeof d === "string" && (!earn[s] || d < earn[s])) earn[s] = d;
}
const et = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const TODAY = et(Date.now());
const macroNext = (() => {
  const all = [];
  for (const kind of ["CPI", "NFP", "FOMC", "PCE"])
    for (const d of (Array.isArray(macro[kind]) ? macro[kind] : []))
      if (typeof d === "string" && d >= TODAY) all.push({ kind, date: d });
  all.sort((a, b) => a.date.localeCompare(b.date));
  return all[0] || null;
})();
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);

const BOARD = D("board_positions.json");
const raw = readJson("board_positions.json", []);
const rows = Array.isArray(raw) ? raw : (raw.positions || raw.rows || []);

const SOURCE = fetched.spec || "unknown";
let stamped = 0, already = 0, noNews = 0, restamped = 0;
for (const t of rows) {
  if (!t || !t.sym || t.closedAt) continue;
  // Append-only per ticket — but SOURCE-AWARE. A ticket stamped from a superseded source is
  // re-stamped once, because the old stamp is not evidence: the first pass ran off a topic feed
  // that covered 30 of 170 held names and recorded the other 83.5% as "no news" when nothing had
  // asked. Re-stamping from a source that DID ask is a correction, not a rewrite of history —
  // and it is bounded, because `newsSource` then matches and the ticket is never touched again.
  if (t.obs && t.obs.newsAsOf && t.obs.newsSource === SOURCE) { already++; continue; }
  if (t.obs && t.obs.newsAsOf && t.obs.newsSource !== SOURCE) restamped++;
  const n = byS[t.sym];
  t.obs = t.obs || {};
  t.obs.newsAsOf = newsAsOf;
  t.obs.newsSource = SOURCE;
  t.obs.stampLagMin = cycleAgeMin;
  // THREE STATES, never two. `newsQueried:false` means the call failed and we do not know.
  // `newsQueried:true, newsN:0` means we asked and there was nothing — that is EVIDENCE of quiet,
  // and it is the state the operator was right to insist on: if there is no news, there is no news.
  // Collapsing those two into one boolean is how a starved observer hides.
  t.obs.newsQueried = !!(n && n.queried);
  if (n && n.queried) {
    t.obs.newsN = n.n ?? 0;
    t.obs.newsAvg = Number.isFinite(n.avg) ? n.avg : null;
    t.obs.newsPos = n.pos ?? 0;
    t.obs.newsNeg = n.neg ?? 0;
    t.obs.newsSources = n.sources ?? null;
    t.obs.newsNewestAt = n.newestAt || null;      // exact publication time — lets a later reader
    t.obs.newsOldestAt = n.oldestAt || null;      // assert an article PREDATES this entry
    // sector news, from the symbol's own sector ETF
    const sec = n.etf ? sectors[n.etf] : null;
    t.obs.sectorEtf = n.etf || null;
    t.obs.sectorInd = n.ind || null;
    if (sec && sec.queried) {
      t.obs.sectorNewsN = sec.n ?? 0;
      t.obs.sectorNewsAvg = Number.isFinite(sec.avg) ? sec.avg : null;
      t.obs.sectorNewsNeg = sec.neg ?? 0;
    }
  } else noNews++;
  const e = earn[t.sym];
  t.obs.daysToEarnings = typeof e === "string" ? daysBetween(TODAY, e) : null;
  t.obs.macroNextKind = macroNext ? macroNext.kind : null;
  t.obs.macroDaysOut = macroNext ? daysBetween(TODAY, macroNext.date) : null;
  stamped++;
}

if (stamped) writeJsonAtomic(BOARD, Array.isArray(raw) ? rows : raw);

/**
 * DURABLE BY-ID STAMP STORE (added 2026-08-28).
 *
 * The stamp above lands on board_positions.json, server-side. But a settle driven from a
 * long-lived browser tab writes its trade-log row from the TAB'S OWN copy of the ticket, which
 * never saw the server's stamp — so the observation is silently lost at exactly the moment the
 * ticket becomes evidence. PYPL is the case that proved it: 324 of 324 tickets settled since
 * 2026-08-27 carry obs.newsQueried and PYPL does not, because it settled from a stale tab. It is
 * also the single ticket that most needed the stamp — a -13.57% overnight gap, -$1,038, and no
 * record of whether news was knowable at entry. That gap is what made the defined-risk question
 * undecidable on history.
 *
 * This is the same defect class as the veto-shadow laundering fixed the same morning, and it
 * takes the same shape of fix: write the observation somewhere durable, keyed by ticket id, and
 * re-attach it server-side when the ledger row arrives. See POST /api/tradelog.
 */
try {
  const BYID = D("news-stamp-by-id.json");
  let store = {};
  try { store = JSON.parse(fs.readFileSync(BYID, "utf8")) || {}; } catch { }
  let added = 0;
  for (const t of rows) {
    if (!t || !t.id || !t.obs || t.obs.newsSource !== SOURCE) continue;
    const o = t.obs, keep = {};
    for (const k of ["newsAsOf", "newsSource", "stampLagMin", "newsQueried", "newsN", "newsAvg",
      "newsPos", "newsNeg", "newsSources", "newsNewestAt", "newsOldestAt", "sectorEtf", "sectorInd",
      "sectorNewsN", "sectorNewsAvg", "sectorNewsNeg", "daysToEarnings", "macroNextKind", "macroDaysOut"])
      if (o[k] !== undefined) keep[k] = o[k];
    if (!store[t.id]) added++;
    store[t.id] = keep;                       // latest stamp for the id wins; same source is idempotent
  }
  // bounded: keep the most recent 20,000 ids, which is far more than the ledger cap
  const ids = Object.keys(store);
  if (ids.length > 20000) for (const k of ids.slice(0, ids.length - 20000)) delete store[k];
  writeJsonAtomic(BYID, store);
  if (added) console.log(`  durable by-id store: +${added} new (${Object.keys(store).length} total) — survives a stale-tab settle`);
} catch (e) { console.warn("  by-id stamp store failed: " + e.message); }

const covered = rows.filter((t) => t && !t.closedAt && t.obs && t.obs.newsAsOf);
const queriedOk = covered.filter((t) => t.obs.newsQueried);
const withNews = queriedOk.filter((t) => (t.obs.newsN || 0) > 0);
const genuinelyQuiet = queriedOk.filter((t) => (t.obs.newsN || 0) === 0);
const withEarn = covered.filter((t) => Number.isFinite(t.obs.daysToEarnings));
const out = {
  spec: "news-stamp-v1", asOf: new Date().toISOString(), newsAsOf, cycleAgeMin,
  cycleStale: cycleAgeMin > STALE_MIN,
  openTickets: rows.filter((t) => t && !t.closedAt).length,
  stampedThisRun: stamped, alreadyStamped: already, restampedFromSupersededSource: restamped, stampedWithoutCoverage: noNews,
  source: SOURCE,
  totalStamped: covered.length,
  coverage: { queried: queriedOk.length, withNews: withNews.length, genuinelyQuiet: genuinelyQuiet.length,
    callFailed: covered.length - queriedOk.length, withEarningsDate: withEarn.length,
    pctQueried: covered.length ? +(100 * queriedOk.length / covered.length).toFixed(1) : null },
  fields: ["newsQueried", "newsN", "newsAvg", "newsPos", "newsNeg", "newsSources", "newsNewestAt", "newsOldestAt", "sectorEtf", "sectorInd", "sectorNewsN", "sectorNewsAvg", "sectorNewsNeg", "daysToEarnings", "macroNextKind", "macroDaysOut", "newsAsOf", "stampLagMin"],
  scope: "RECORDS ONLY. No weight is applied and no trade is altered. A weight must be fitted from stamped outcomes and registered with a bar before it can touch a ticket — and R13 (21,254 events, net -0.708pp at t -5.856) says the naive sign is wrong, so a fitted weight must be read against that.",
};
writeJsonAtomic(D("news-stamp.json"), out);

console.log(`NEWS STAMP — cycle generated ${newsAsOf} (${cycleAgeMin} min old)${out.cycleStale ? "  *** STALE" : ""}`);
console.log(`  open tickets ${out.openTickets} · stamped this run ${stamped} · already stamped ${already}`);
console.log(`  queried ${queriedOk.length}/${covered.length} (${out.coverage.pctQueried}%) · with news ${withNews.length} · genuinely quiet ${genuinelyQuiet.length} · earnings date on ${withEarn.length}`);
if (noNews) console.log(`  ${noNews} ticket(s) whose news call FAILED — newsQueried:false, which is NOT the same as quiet`);
if (macroNext) console.log(`  next macro: ${macroNext.kind} ${macroNext.date} (T+${daysBetween(TODAY, macroNext.date)})`);
console.log("  RECORDS ONLY — no weight applied, no trade altered.");
console.log("written: data/news-stamp.json");
