#!/usr/bin/env node
/**
 * R62 — GAP EXPOSURE TWIN. Writes data/r62-gap-exposure-twin.json.
 *
 * THE QUESTION. Every ticket held through a session close carries risk the stop cannot bound:
 * a stop is a promise the market keeps only while it is open. This pairs each overnight-held
 * ticket against a twin that FLAT-CLOSED at the close of the session it was opened in, and
 * grades the pair. If the twin wins on the registered statistic, the book should not hold
 * overnight; if it does not, overnight exposure pays for itself and the rule dies.
 *
 * MOTIVATING RETROSPECTIVE, disclosed and WEIGHTLESS (2026-08-28, clean-era ledger):
 *   18 gap-resolved tickets. 18 losses, 0 gains, -$16,078 net, against a whole-book P&L of
 *   +$2,648. 15 of the 18 were held overnight (-$13,196); three (COHU x2, IEX) were same-session
 *   jumps a close-flat would NOT have prevented, and are excluded from the rule's scope.
 *   Both tails were checked: every win above 1R came from `target` or `close`, NOT ONE from a
 *   favourable gap, so this is not a symmetric tail being clipped.
 *   THE CLUSTERING IS THE CATCH: those 15 tickets sit in roughly FIVE overnight episodes
 *   (2026-08-19/20 carries six, 2026-08-21/24 carries four). Effective N is episodes, not
 *   tickets, and the bar below is set on episodes for exactly that reason.
 *
 * SCOPE v1: Equity and Crypto, where Alpaca daily bars give a clean session close. Futures, FX
 * and Options tickets are COUNTED AS NOT COVERED and excluded — never silently dropped. That
 * costs coverage honestly rather than inventing a close price for instruments this feed does
 * not serve.
 */
const fs = require("fs"), path = require("path");
const rc = require("./lib/reconcile.js");
const { fetchBars } = require("./lib/alpaca-bars.js");
const { fetchCryptoBars } = require("./lib/crypto-bars.js");

const OUT = path.join(__dirname, "data", "r62-gap-exposure-twin.json");
const EVIDENCE_START = "2026-08-31";
const COVERED = new Set(["Equity", "Crypto"]);
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/** Day-clustered t on a per-episode basis. The episode is the OVERNIGHT, not the ticket. */
function episodeT(rows) {
  const by = {};
  for (const r of rows) (by[r.episode] ||= []).push(r.d);
  const m = Object.values(by).map(mean), k = m.length;
  if (k < 2) return { t: null, episodes: k };
  const g = mean(m), sd = Math.sqrt(m.reduce((s, x) => s + (x - g) ** 2, 0) / (k - 1));
  return { t: sd > 0 ? +(g / (sd / Math.sqrt(k))).toFixed(3) : null, episodes: k, meanD: +g.toFixed(4) };
}

(async () => {
  const L = rc.cleanEraLedger();
  rc.assertReconciled("clean-era pooled edge", rc.recomputeEdge(L), L.pooledEdgeR);

  const held = L.signals.filter((t) =>
    t && Number.isFinite(t.rMult) && Number.isFinite(t.entry) && t.openedAt && t.closedAt &&
    etDay(t.openedAt) !== etDay(t.closedAt) && Number.isFinite(t.stopDist) && t.stopDist > 0);

  const covered = held.filter((t) => COVERED.has(t.cls));
  const notCovered = held.filter((t) => !COVERED.has(t.cls));

  // one daily-bar pull for every symbol involved, over the whole span
  const eqSyms = [...new Set(covered.filter(t => t.cls === "Equity").map(t => t.sym).filter(Boolean))];
  const cxSyms = [...new Set(covered.filter(t => t.cls === "Crypto").map(t => t.sym).filter(Boolean))];
  let bars = {};
  const days = covered.map((t) => etDay(t.openedAt)).sort();
  const start = days[0], endD = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  // Two feeds, because they are two endpoints. Mixing a "BTC/USD" into the stocks bars call
  // returns a 400 and would have silently cost the whole crypto arm.
  if (eqSyms.length) {
    try { const r = await fetchBars(eqSyms, { start, end: endD, timeframe: "1Day", requireAll: false, quiet: true }); Object.assign(bars, r.bars || {}); }
    catch (e) { console.error("  equity bar fetch failed: " + e.message + " — refusing to grade on partial data"); process.exit(1); }
  }
  if (cxSyms.length) {
    try { Object.assign(bars, await fetchCryptoBars(cxSyms, "1Day", start, endD)); }
    catch (e) { console.error("  crypto bar fetch failed: " + e.message + " — refusing to grade on partial data"); process.exit(1); }
  }

  const pairs = [], noClose = [];
  for (const t of covered) {
    const d = etDay(t.openedAt);
    const row = (bars[t.sym] || []).find((b) => etDay(Date.parse(b.t)) === d);
    if (!row || !Number.isFinite(row.c)) { noClose.push({ sym: t.sym, date: d }); continue; }   // fail closed
    const dir = t.dir || 1;
    const twinR = ((row.c - t.entry) * dir) / t.stopDist;      // flat at the entry session's close
    const rActual = t.rMult;
    pairs.push({
      id: t.id, sym: t.sym, cls: t.cls, entryDay: d, exitDay: etDay(t.closedAt),
      episode: d,                                              // the OVERNIGHT is the unit
      entry: t.entry, sessionClose: row.c, actualExit: t.exit ?? null, reason: t.reason || null,
      rActual: +rActual.toFixed(4), rFlatAtClose: +twinR.toFixed(4), d: +(twinR - rActual).toFixed(4),
      preview: d < EVIDENCE_START,
    });
  }

  const evidence = pairs.filter((p) => !p.preview);
  const preview = pairs.filter((p) => p.preview);
  const stat = (rows) => {
    if (!rows.length) return null;
    const e = episodeT(rows);
    return { n: rows.length, ...e,
      meanActualR: +mean(rows.map(r => r.rActual)).toFixed(4),
      meanFlatR: +mean(rows.map(r => r.rFlatAtClose)).toFixed(4),
      twinBetterPct: +(100 * rows.filter(r => r.d > 0).length / rows.length).toFixed(1) };
  };

  /**
   * 2026-09-10 (test-triage COUNT NOT EXPOSED fix). test-registry.json's bar object for R62 names
   * ONLY minEpisodes:20 (no minSessions) — test-triage.js's field-priority resolver
   * (backend/test-triage.js:133) matches "minEpisodes", so 20 OVERNIGHT EPISODES is the count the
   * triage tool compares against, exactly the unit this writer's own bar string already names.
   * dailyClock.sessions = evidence episodes since evidenceStart (out.evidence.episodes below,
   * PREVIEW rows excluded — they are disclosed as weightless and must not count toward the bar).
   * estimate is out.evidence.meanD, the registered statistic. bySession is one row per overnight
   * episode, that episode's mean D across its paired tickets.
   */
  const evByEpisode = {};
  for (const p of evidence) (evByEpisode[p.episode] ||= []).push(p.d);
  const dailyClock = {
    sessions: evidence.length ? episodeT(evidence).episodes : 0,
    estimate: evidence.length ? episodeT(evidence).meanD : null,
    unit: "overnight episodes since evidenceStart (PREVIEW rows excluded)",
  };
  const bySession = Object.keys(evByEpisode).sort().map((ep) => ({ session: ep, mean: +mean(evByEpisode[ep]).toFixed(4) }));

  /**
   * 2026-10-01 audit (stats lens, stats#1 / registry#5). This runner wrote only a CONSTANT status sentence ("ACCRUING — …") and no
   * verdict, and read-seal-sweep.js sealed whatever `status` said — so on 2026-09-29, the first night at 20 episodes, R62's one-time
   * read was sealed as "ACCRUING". `verdict` is now the registered decision rule applied to the evidence (test-registry.json R62):
   *   >= 20 episodes: t >= 1.732 -> PASS (an enforcement gate may be SPECIFIED, never wired here); t < 1.732 -> DID NOT PASS.
   *   10..19 episodes: the registered kill-only look — mean D negative with t <= -1.0 -> KILLED at interim; otherwise ACCRUING.
   * The sweep seals this field once; later nights move to postSealVerdict. Restores the registered spec; changes no bar, rule or population.
   */
  const ev = stat(evidence);
  const verdict = !ev || !(ev.episodes >= 10) ? `ACCRUING — ${ev ? ev.episodes : 0}/20 overnight episodes`
    : ev.episodes >= 20 ? (ev.t != null && ev.t >= 1.732
      ? `PASS — flat-at-close beats holding: mean D ${ev.meanD}R per overnight episode, t ${ev.t} >= 1.732 at ${ev.episodes} episodes (${ev.n} tickets). A registered enforcement gate may be SPECIFIED; wiring is a separate operator decision`
      : `DID NOT PASS — mean D ${ev.meanD}R per overnight episode, t ${ev.t ?? "n/a"} vs bar 1.732 at ${ev.episodes} episodes (${ev.n} tickets). Overnight exposure is not shown to be costly on this population; no gap rule is built`)
    : (ev.meanD < 0 && ev.t != null && ev.t <= -1.0 ? `KILLED at interim — mean D ${ev.meanD}R, t ${ev.t} <= -1.0 at ${ev.episodes} episodes (registered kill-only look)` : `ACCRUING — ${ev.episodes}/20 overnight episodes · interim look: not dead (t ${ev.t ?? "n/a"})`);

  const out = {
    spec: "R62-gap-exposure-twin-v1", registered: "2026-08-28", evidenceStart: EVIDENCE_START,
    bar: "day-clustered t >= 1.732 over 20 OVERNIGHT EPISODES (single-variant p95, lib/null-bar.js at n=20, computed 2026-08-28 before evidence). The unit is the overnight, never the ticket — the motivating 15 tickets were only ~5 episodes.",
    dailyClock, bySession,
    scope: "Equity and Crypto only in v1; Futures, FX and Options counted as not covered",
    notCovered: { n: notCovered.length, byClass: notCovered.reduce((a, t) => (a[t.cls] = (a[t.cls] || 0) + 1, a), {}) },
    droppedNoSessionClose: noClose.length,
    evidence: stat(evidence), preview: stat(preview),
    verdict, asOf: new Date().toISOString(),
    pairs, status: "FORWARD TEST — evidence from " + EVIDENCE_START + "; earlier rows are PREVIEW, disclosed and weightless. Refuses nothing live. The registered read is `verdict`, sealed once by read-seal-sweep.js.",   // 2026-10-01 audit: was "ACCRUING — …", the string the 09-29 seal froze
  };
  if (process.argv.includes("--dry")) console.log("[DRY — r62-gap-exposure-twin.json NOT written]");   // 2026-10-01 audit: a no-write mode to verify the verdict branch
  else require("./lib/atomic-write").writeJsonAtomic(OUT, out, { pretty: 2 });   // 2026-09-04: in-place write hit UNKNOWN file locks; rename over the target instead

  const f = (x) => x == null ? " n/a" : (x >= 0 ? "+" : "") + Number(x).toFixed(4);
  console.log(`R62 GAP EXPOSURE TWIN — ${pairs.length} overnight-held pairs (${evidence.length} evidence · ${preview.length} preview)`);
  console.log(`  not covered in v1: ${notCovered.length} (${Object.entries(out.notCovered.byClass).map(([k, v]) => k + " " + v).join(", ") || "none"}) · dropped for no session close: ${noClose.length}`);
  for (const [label, s] of [["PREVIEW (weightless)", out.preview], ["EVIDENCE", out.evidence]]) {
    if (!s) { console.log(`  ${label}: none yet`); continue; }
    console.log(`  ${label}: held ${f(s.meanActualR)}R vs flat-at-close ${f(s.meanFlatR)}R · mean D ${f(s.meanD)} over ${s.episodes} episode(s) · t ${s.t == null ? "n/a" : s.t} · twin better on ${s.twinBetterPct}%`);
  }
  console.log("  bar: " + out.bar);
  console.log("  verdict (registered decision rule): " + verdict);
  if (!process.argv.includes("--dry")) console.log("written: data/r62-gap-exposure-twin.json");
})();
