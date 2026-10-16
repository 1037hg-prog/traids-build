"use strict";
/**
 * TRIAGE (plain code) — the kills that need no model, before the one cheap judge call. 2026-10-09 (docs/server/wave6-agents; stage 2).
 * Design §2: triage NEVER computes a return (that would be evidence before registration). It kills, with a reason:
 *   repeat        the card names something already registered (R or F), or already carded by an earlier scout run — exact (normalised)
 *                 or near (token Jaccard >= 0.8). A card is never a repeat of its own scout file.
 *   in-house      the card cites an in-house-only id from the avoid-list (ipIds): those lines stay home.
 *   home-only     the data is not on the research server. The server's one lane is DAILY bars: eq-daily (US single stocks, point-in-
 *                 time, no ETFs, no index membership) and fut-daily (continuous futures roots). Intraday, options, crypto, ETF, news,
 *                 social, fundamentals, flows, auctions, 13F/insider, COT, a login or the :3002 proxy -> killed AS A HOME CANDIDATE
 *                 (listed in the digest; home can test it).
 *   unit          the test design's unit is not daily-or-slower (days | weeks | months | sessions).
 *   malformed     a card without the 09-29 schema fields.
 * Survivors go to the judge (one call per scout file), then the registrar.
 */
const norm = (s) => String(s || "").toLowerCase().replace(/_/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (s) => new Set(norm(s).split(" ").filter((w) => w.length >= 3));
function jaccard(a, b) { const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return n / (A.size + B.size - n); }
const HOME_ONLY = [
  [/\bintra-?day\b|\b1-?min(?:ute)?\b|\bminute bars?\b|\btick data\b|\border ?book\b|\blevel ?2\b|\bopening range\b|\bfirst \d+ minutes\b|\bvwap\b/i, "intraday bars"],
  [/\boptions? (?:chain|data|prices?|quotes?|volume|expir\w*|market)\b|\boption chain|\bimplied vol|\bvix\b|\bvolatility skew|\boptions? skew|\bdealer gamma\b|\bgamma exposure\b|\b0dte\b|\bstraddle|\bstrangle|\bput options?\b|\bcall options?\b|\bputs and calls\b|\bOPEX\b/i, "options data"],
  [/\bcrypto|\bbitcoin|\bbtc\b|\beth(?:ereum)?\b|\bfunding rate|\bperp(?:etual)?s?\b|\bstablecoin|\bhyperliquid\b|\bbinance\b|\bcoinbase\b/i, "crypto data"],
  [/\bETFs?\b|\bexchange[- ]traded fund|\bSPY\b|\bQQQ\b|\bsector fund/i, "ETF bars (eq-daily holds single stocks only)"],
  [/\bS&P ?500\b|\bindex (?:re)?constitution|\bindex addition|\bRussell\b|\bindex membership/i, "index membership"],
  [/\bnews\b|\bsentiment\b|\bsocial\b|\breddit\b|\btwitter\b|\bstocktwits\b|\bgoogle trends\b|\btranscript/i, "news / social data"],
  [/\bearnings\b|\bEPS\b|\bfundamental|\bbalance sheet|\bbook[- ]to[- ]market|\banalyst|\bguidance\b|\b10-?[KQ]\b|\bfiling/i, "fundamentals / earnings data"],
  [/\b13F\b|\binsider\b|\bForm 4\b|\bCOT\b|\bcommitment of traders|\bshort interest|\bfund flows?\b|\bETF flows?\b|\bmargin debt/i, "holdings / flows data"],
  [/\bauction\b|\bclosing cross\b|\bimbalance\b|\bmarket-on-close|\bMOC\b/i, "auction data"],
  [/\bterm structure\b|\bcalendar spread\b|\broll yield\b|\bfutures basis\b|\bbasis trade\b|\bcontango\b|\bbackwardation\b/i, "futures term structure (fut-daily is continuous only)"],
  [/\blogin\b|\bpaywall|\bsubscription\b|:3002\b|\byahoo proxy|\bSSRN\b/i, "a login / home-only source"],
];
const CARD_KEYS = ["key", "name", "rule", "sources", "effect", "mechanism", "testDesign", "prior"];
/** Pure: the file-safe item key of a card */
const itemKey = (date, lane, card) => `${date}-${lane}-${String((card && card.key) || "CARD").replace(/[^A-Za-z0-9_]/g, "").slice(0, 48) || "CARD"}`;
/**
 * Pure: why this card is killed by code, or null. ctx: { avoid (avoid-list-v1), fTests (F registry entries), ownFile (the scout file
 * name, e.g. 2026-10-12-equities.json) }
 */
function codeKill(card, { avoid = null, fTests = [], ownFile = "" } = {}) {
  if (!card || typeof card !== "object") return { kind: "malformed", why: "not an object" };
  const miss = CARD_KEYS.filter((k) => card[k] == null || card[k] === ""); if (miss.length) return { kind: "malformed", why: `lacks ${miss.join(", ")}` };
  const text = JSON.stringify(card), ipIds = (avoid && avoid.ipIds) || [];
  const ipHit = ipIds.find((id) => new RegExp(`\\b${/^\d+$/.test(id) ? "R?" : ""}${String(id).replace(/[^A-Za-z0-9]/g, "")}\\b`).test(text));
  if (ipHit) return { kind: "in-house", why: `cites ${ipHit}, an in-house-only line (dropped; never itemised)` };
  const name = card.name, key = String(card.key).replace(/_/g, " ");
  const prior = [
    ...((avoid && avoid.tests) || []).filter((t) => t && !t.ip && t.name).map((t) => ({ label: `${t.id} ${t.name}`, text: t.name })),
    ...((avoid && avoid.scoutTitles) || []).filter((t) => t && t.title && t.from !== `server:out/scout/${ownFile}`).map((t) => ({ label: `scout title "${t.title.slice(0, 60)}" (${t.from})`, text: t.title })),
    ...fTests.filter((t) => t && t.name).map((t) => ({ label: `${t.id} ${t.name}`, text: t.name })),
  ];
  for (const p of prior) { const n = norm(p.text); if (n && (n === norm(name) || n === norm(key))) return { kind: "repeat", why: `repeat of ${p.label}` }; }
  for (const p of prior) { const j = Math.max(jaccard(p.text, name), jaccard(p.text, key)); if (j >= 0.8) return { kind: "repeat", why: `near-repeat (token overlap ${j.toFixed(2)}) of ${p.label}` }; }
  const dataText = [card.rule, card.dataSource, card.dataGap, card.name, card.mechanism].map((x) => (typeof x === "string" ? x : JSON.stringify(x || ""))).join(" ");
  if (card.dataWeHave === false) return { kind: "home-only", why: "the card says we lack the data (dataWeHave false)", homeCandidate: true };
  for (const [re, what] of HOME_ONLY) if (re.test(dataText)) return { kind: "home-only", why: `needs ${what} — not on the research server`, homeCandidate: true };
  const unit = String((card.testDesign && card.testDesign.unit) || "").toLowerCase();
  if (!["days", "weeks", "months", "sessions"].includes(unit)) return { kind: "unit", why: `test unit ${JSON.stringify(unit)} is not daily-or-slower` };
  return null;
}
module.exports = { codeKill, itemKey, jaccard, norm, HOME_ONLY, CARD_KEYS };
