#!/usr/bin/env node
/**
 * R28 — NO SHORTS AGAINST THE REGIME (all classes): THE NIGHTLY READ. Registered 2026-08-21.
 *
 * The rule lives in the app (ENFORCE_R28 in applyRegimeFilters). Every short it refuses becomes
 * a veto SHADOW: tracked, settled and graded exactly like a signal, tagged vetoShadow with the
 * R28 reason in `veto`. This file reads those shadows out of the ledger and answers the only
 * question the rule can be judged on: DID THE TRADES IT REFUSED LOSE MONEY?
 *
 *   CONFIRMED     shadows' mean R < 0, session-clustered t <= −2.0, >= 30 sessions, >= 60 shadows
 *   DID NOT PASS  at >= 30 sessions the shadows' t > 0 (the refused shorts would have paid) → retire
 *   INTERIM (16)  kill-only: t >= +2.0 retires the rule early; nothing else adjudicates before 30
 *
 * Evidence starts 2026-08-24. The clean-era shorts that motivated the rule (−0.070R on 352) are
 * the MOTIVATING SAMPLE: reported here, weight zero. Report-only; changes no rule by itself —
 * a DID-NOT-PASS is a decision memo for the operator, who flips ENFORCE_R28 off by hand.
 * Output: data/r28-shadows.json.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const EVIDENCE_START = "2026-08-24", BAR = { minSessions: 30, minShadows: 60, tRequired: -2.0, interimSessions: 16, interimKillT: 2.0 };
const et = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sessionT = (rows) => {
  const by = {}; for (const r of rows) (by[et(r.openedAt)] ||= []).push(r.rMult);
  const m = Object.values(by).map(mean), k = m.length;
  if (k < 2) return { t: null, sessions: k };
  const g = mean(m), sd = Math.sqrt(m.reduce((s, x) => s + (x - g) ** 2, 0) / (k - 1));
  return { t: sd > 0 ? +(g / (sd / Math.sqrt(k))).toFixed(3) : null, sessions: k };
};
const stat = (rows) => ({ n: rows.length, win: rows.length ? +(100 * rows.filter((r) => r.rMult > 0).length / rows.length).toFixed(1) : null, avgR: rows.length ? +mean(rows.map((r) => r.rMult)).toFixed(4) : null, pnl: +rows.reduce((s, r) => s + (r.pnl || 0), 0).toFixed(0), ...sessionT(rows) });

const log = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8"));
const settled = log.filter((r) => Number.isFinite(r.rMult) && r.closedAt);
const shadows = settled.filter((r) => r.vetoShadow && /R28/.test(r.veto || "") && et(r.openedAt) >= EVIDENCE_START);
const byCls = {}; for (const r of shadows) (byCls[r.cls] ||= []).push(r);
const motivating = settled.filter((r) => !r.ctrl && !r.ctrlRand && !r.vetoShadow && r.dir < 0 && r.cls !== "Equity" && r.cls !== "Options" && et(r.openedAt) >= "2026-07-20" && et(r.openedAt) < EVIDENCE_START);

const s = stat(shadows), S = s.sessions;
let verdict;
if (S < BAR.interimSessions) verdict = `ACCRUING — ${S}/${BAR.minSessions} sessions, ${s.n}/${BAR.minShadows} shadows`;
else if (S < BAR.minSessions) verdict = s.t != null && s.t >= BAR.interimKillT ? `KILLED AT INTERIM — refused shorts are WINNING (t ${s.t} >= ${BAR.interimKillT}); retire ENFORCE_R28` : `ACCRUING — interim look at ${S}: not dead (t ${s.t}); adjudicates nothing`;
else verdict = (s.avgR < 0 && s.t <= BAR.tRequired && s.n >= BAR.minShadows) ? `CONFIRMED — the refused shorts lost (avgR ${s.avgR}, t ${s.t}, n ${s.n}); rule stays` : s.t > 0 ? `DID NOT PASS — refused shorts would have paid (t ${s.t}); retire ENFORCE_R28` : `INCONCLUSIVE at ${S} sessions — t ${s.t}, n ${s.n}; keep accruing`;

writeJsonAtomic(D("r28-shadows.json"), {
  spec: "R28 no-shorts-against-regime-v1", registered: "2026-08-21", evidenceStart: EVIDENCE_START, bar: BAR,
  rule: "crypto shorts refused while BTC > its 50d MA; futures/FX shorts refused while the instrument > its own 50d MA; equities already gated by #7",
  asOf: new Date().toISOString(), sessions: S, shadows: s, byClass: Object.fromEntries(Object.entries(byCls).map(([k, v]) => [k, stat(v)])),
  motivatingSampleExcluded: { window: "2026-07-20 → 2026-08-24", what: "non-equity short SIGNALS as traded", ...stat(motivating), note: "hypothesis-generating data: reported, never counted" },
  verdict,
});
console.log(`R28 NO-SHORTS-AGAINST-REGIME — evidence from ${EVIDENCE_START} · ${verdict}`);
console.log(`  motivating sample (EXCLUDED): ${motivating.length} non-equity shorts as traded, win ${stat(motivating).win}% · avgR ${stat(motivating).avgR} · $${stat(motivating).pnl} · t ${stat(motivating).t} over ${stat(motivating).sessions} sessions`);
if (s.n) console.log(`  shadows: ${s.n} refused shorts over ${S} sessions · win ${s.win}% · avgR ${s.avgR} · $${s.pnl} (what they would have made) · t ${s.t} · ` + Object.entries(byCls).map(([k, v]) => `${k} ${v.length}`).join(", "));
console.log(`written: r28-shadows.json`);
