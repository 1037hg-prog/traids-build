#!/usr/bin/env node
/**
 * OPS HEALTH FIX 2026-10-05 — builds staged/backend/traids-server-v2.js from the LIVE backend/traids-server-v2.js by exact hunks.
 * Writes ONLY the staged copy. Refuses unless the live file still has the sha recorded in base-shas.json (or --rebase is given, in which
 * case every hunk must still match exactly once and the new base sha is printed for the manifest). The live file is CRLF: every hunk
 * is converted to CRLF before matching and writing, and the result is checked to contain no bare LF.
 *   node docs/health-fixes/2026-10-05/ops/patch-server.cjs [--rebase]
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..", "..");
const LIVE = path.join(REPO, "backend", "traids-server-v2.js"), OUT = path.join(PKG, "staged", "backend", "traids-server-v2.js");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const base = JSON.parse(fs.readFileSync(path.join(PKG, "base-shas.json"), "utf8")).base["backend/traids-server-v2.js"];
const buf = fs.readFileSync(LIVE);
if (sha(buf) !== base && !process.argv.includes("--rebase")) { console.error(`live traids-server-v2.js changed since staging (sha ${sha(buf).slice(0, 12)} != base ${base.slice(0, 12)}) — re-run with --rebase after reading the change`); process.exit(2); }
let src = buf.toString("utf8");
if (/(^|[^\r])\n/.test(src)) { console.error("live file is not pure CRLF — refusing"); process.exit(2); }
const crlf = (s) => s.replace(/\r?\n/g, "\r\n");
const HUNKS = [];
const hunk = (name, oldS, newS) => HUNKS.push({ name, oldS: crlf(oldS), newS: crlf(newS) });

// ── H1: /api/circuit-breaker reports the breaker's own (signals) view; the gross view stays beside it ──
hunk("H1 circuit-breaker endpoint",
`const portfolioRisk = () => RP.aggregate(readJsonFile(BOARD_POS_PATH, []), readJsonFile(path.join(__dirname, "data", "trade_log.json"), []));
app.get("/api/risk-policy", rateLimit(120, 60000), wrap(async (req, res) => { res.json(RP.RISK_POLICY); }));
app.get("/api/portfolio-risk", rateLimit(120, 60000), wrap(async (req, res) => { res.json(portfolioRisk()); }));
app.get("/api/circuit-breaker", rateLimit(120, 60000), wrap(async (req, res) => {
  const st = readJsonFile(BREAKER_PATH, { date: null, halted: false, refusedToday: 0, events: [] });
  res.json({ ...st, live: portfolioRisk().breaker });
}));
`,
`const portfolioRisk = () => RP.aggregate(readJsonFile(BOARD_POS_PATH, []), readJsonFile(path.join(__dirname, "data", "trade_log.json"), []));
/* 2026-10-05 (ops health fix): one row per NEW board ticket the circuit breaker would refuse (observe) or refused (enforce), append-only —
 * the per-ticket record the breaker's enforcement test reads (the drafted successor of R304). */
const BREAKER_HITS_PATH = path.join(__dirname, "data", "circuit-breaker-hits.jsonl");
app.get("/api/risk-policy", rateLimit(120, 60000), wrap(async (req, res) => { res.json(RP.RISK_POLICY); }));
app.get("/api/portfolio-risk", rateLimit(120, 60000), wrap(async (req, res) => { res.json(portfolioRisk()); }));   // the GROSS board view (signals + real controls) — unchanged
app.get("/api/circuit-breaker", rateLimit(120, 60000), wrap(async (req, res) => {
  const st = readJsonFile(BREAKER_PATH, { date: null, halted: false, refusedToday: 0, events: [] });
  // 2026-10-05 (ops health fix): \`live\` is what the breaker itself evaluates (board SIGNAL tickets, RISK_POLICY.breakerBasis); the gross
  // board view it used to show (controls included) stays available as liveGrossBook.
  const book = readJsonFile(BOARD_POS_PATH, []), log = readJsonFile(path.join(__dirname, "data", "trade_log.json"), []);
  res.json({ ...st, live: RP.aggregate(book, log, Date.now(), { basis: "signals" }).breaker, liveGrossBook: RP.aggregate(book, log).breaker });
}));
`);

// ── H2: the breaker evaluates the SIGNALS book + this POST's batch; daily reset of wouldRefuseToday; isNewBoard moved up ──
hunk("H2 breaker evaluation",
`  const prevBook = readJsonFile(BOARD_POS_PATH, []);
  const prevIds = new Set(prevBook.map(p => p && p.id));
  const risk = RP.aggregate(prevBook, readJsonFile(path.join(__dirname, "data", "trade_log.json"), []));
  const bst = readJsonFile(BREAKER_PATH, { date: null, halted: false, since: null, reason: null, refusedToday: 0, events: [] });
  if (bst.date !== risk.date) { bst.date = risk.date; bst.halted = false; bst.since = null; bst.reason = null; bst.refusedToday = 0; }
  const ENFORCE_BREAKER = RP.RISK_POLICY.breakerMode === "enforce";
  if (!bst.halted && risk.breaker.halted) {
    // observe mode (paper): the halt is RECORDED, not applied — would-have-refused tickets are counted below
    bst.halted = true; bst.since = new Date().toISOString(); bst.reason = risk.breaker.reason; bst.mode = RP.RISK_POLICY.breakerMode; bst.wouldRefuseToday = bst.wouldRefuseToday || 0;
    bst.events = (bst.events || []).concat([{ at: bst.since, type: ENFORCE_BREAKER ? "HALT" : "WOULD-HALT", mode: RP.RISK_POLICY.breakerMode, reason: bst.reason, realized: risk.realizedToday, worstCaseOpen: risk.worstCaseOpenCurrentEpoch }]).slice(-200);
    auditLine(\`CIRCUIT-BREAKER \${ENFORCE_BREAKER ? "HALT" : "WOULD-HALT (observe mode, paper — nothing refused)"} — \${bst.reason}\`);
  }
  const refused = [];
  // 2026-09-24 weekly-audit fix (A0923-001, operator-approved): a tombstoned (already settled) ticket re-posted by a stale tab is NEVER
  // "new" — it must not be gated, vetoed or written to the veto ledger (on 09-23 six settled 09-22 signals were relabelled as controls).
  const isNewBoard = (p) => p && p.id && !prevIds.has(p.id) && !tset.has(p.id) && !RP.isSleeve(p);
`,
`  const prevBook = readJsonFile(BOARD_POS_PATH, []);
  const prevIds = new Set(prevBook.map(p => p && p.id));
  // 2026-09-24 weekly-audit fix (A0923-001, operator-approved): a tombstoned (already settled) ticket re-posted by a stale tab is NEVER
  // "new" — it must not be gated, vetoed or written to the veto ledger (on 09-23 six settled 09-22 signals were relabelled as controls).
  // (Defined before the breaker since 2026-10-05: the breaker now evaluates this POST's new tickets.)
  const isNewBoard = (p) => p && p.id && !prevIds.has(p.id) && !tset.has(p.id) && !RP.isSleeve(p);
  /**
   * CIRCUIT BREAKER BASIS (2026-10-05 ops health fix; live from the :3001 restart that loads it). Two defects:
   *  (1) the open exposure and realized P&L counted coin-flip CONTROL tickets, which the broker never holds (alpaca-mirror sends only
   *      !ctrl) and which were 60-76% of the exposure behind every would-halt 09-14..10-05 — contradicting "Controls and existing
   *      shadows open no exposure" below. The breaker now counts board SIGNAL tickets only (RP.breakerEvaluate, RISK_POLICY.breakerBasis).
   *  (2) the book was evaluated BEFORE this POST, so the batch that crossed the ceiling was accepted whole (enforce mode would have been
   *      inert for it). It is now evaluated as the open book PLUS this POST's new tickets in posting order; the breaching ticket and
   *      every new ticket after it are the breaker's hits — refused in enforce mode, logged by id in observe mode (audit.log and
   *      data/circuit-breaker-hits.jsonl). A halt stays sticky for the ET session, as before.
   * breakerMode, thresholds and every other gate are unchanged. aggregate()'s default (gross) view still feeds /api/portfolio-risk.
   */
  const BE = RP.breakerEvaluate(prevBook, readJsonFile(path.join(__dirname, "data", "trade_log.json"), []), incoming.filter(isNewBoard));
  const risk = BE.risk;
  const bst = readJsonFile(BREAKER_PATH, { date: null, halted: false, since: null, reason: null, refusedToday: 0, events: [] });
  if (bst.date !== risk.date) {
    // ET date change: the day's counters reset (wouldRefuseToday never did — it read 1739 cumulative on 2026-10-05); the closing day is kept in bst.days
    if (bst.date) bst.days = (bst.days || []).concat([{ date: bst.date, halted: !!bst.halted, since: bst.since || null, reason: bst.reason || null, mode: bst.mode || null, basis: bst.basis || null, refused: bst.refusedToday || 0, wouldRefuse: bst.wouldRefuseToday || 0 }]).slice(-60);
    bst.date = risk.date; bst.halted = false; bst.since = null; bst.reason = null; bst.refusedToday = 0; bst.wouldRefuseToday = 0;
  }
  const ENFORCE_BREAKER = RP.RISK_POLICY.breakerMode === "enforce";
  const haltedEarlier = !!bst.halted;   // a halt is sticky for the ET session: every new board ticket after it is a hit
  if (!bst.halted && BE.halted) {
    // observe mode (paper): the halt is RECORDED, not applied — the tickets it would refuse are logged below
    bst.halted = true; bst.since = new Date().toISOString(); bst.reason = BE.reason; bst.mode = RP.RISK_POLICY.breakerMode; bst.basis = BE.basis; bst.wouldRefuseToday = bst.wouldRefuseToday || 0;
    bst.events = (bst.events || []).concat([{ at: bst.since, type: ENFORCE_BREAKER ? "HALT" : "WOULD-HALT", mode: RP.RISK_POLICY.breakerMode, basis: BE.basis, policyVersion: RP.RISK_POLICY.version, reason: bst.reason, realized: risk.realizedToday, worstCaseOpen: BE.breach ? BE.breach.after : risk.worstCaseOpenCurrentEpoch, ...(BE.breach ? { batchBreach: BE.breach } : {}) }]).slice(-200);
    if (!dryRun) auditLine(\`CIRCUIT-BREAKER \${ENFORCE_BREAKER ? "HALT" : "WOULD-HALT (observe mode, paper — nothing refused)"} — \${bst.reason}\`);
  }
  const breakerHits = haltedEarlier
    ? incoming.filter(isNewBoard).map(p => ({ id: p.id, sym: p.sym || null, cls: p.cls || null, strategy: p.strategy || null, ctrl: !!p.ctrl, vetoShadow: !!p.vetoShadow, why: \`halted since \${bst.since}\` }))
    : BE.wouldRefuse;
  const breakerHitIds = new Set(breakerHits.map(h => h.id));
  const refused = [];
`);

// ── H3: the per-ticket breaker check reads the evaluation (counting moves after the filter) ──
hunk("H3 per-ticket breaker check",
`    if (bst.halted) {
      if (ENFORCE_BREAKER) { refused.push({ id: p.id, sym: p.sym, why: "circuit breaker: " + bst.reason }); return false; }
      if (!dryRun) bst.wouldRefuseToday = (bst.wouldRefuseToday || 0) + 1;   // observe: count it, keep it (a dry run moves no counter)
    }
`,
`    // breaker hit (2026-10-05: computed above on the signals book + this batch): enforce refuses it; observe keeps it and logs it below
    if (breakerHitIds.has(p.id) && ENFORCE_BREAKER) { refused.push({ id: p.id, sym: p.sym, why: "circuit breaker: " + bst.reason }); return false; }
`);

// ── H4: observe-mode hits are counted, named in the audit log and appended to circuit-breaker-hits.jsonl; atomic breaker write ──
hunk("H4 hit logging + atomic breaker write",
`  if (refused.length && !dryRun) { bst.refusedToday += refused.length; auditLine(\`BOARD REFUSED \${refused.length} new ticket(s): \${refused.slice(0, 6).map(r => \`\${r.sym} (\${r.why})\`).join("; ")}\${refused.length > 6 ? " …" : ""}\`); }
  if (dryRun) return res.json({ dryRun: true, wouldSave: gated.length, refused, gateVetoes, breaker: { mode: RP.RISK_POLICY.breakerMode, halted: bst.halted, enforced: ENFORCE_BREAKER && bst.halted, reason: bst.reason, wouldRefuseToday: bst.wouldRefuseToday || 0 }, risk });
  try { fs.writeFileSync(BREAKER_PATH, JSON.stringify(bst)); } catch { }
`,
`  if (refused.length && !dryRun) { bst.refusedToday += refused.length; auditLine(\`BOARD REFUSED \${refused.length} new ticket(s): \${refused.slice(0, 6).map(r => \`\${r.sym} (\${r.why})\`).join("; ")}\${refused.length > 6 ? " …" : ""}\`); }
  if (breakerHits.length && !dryRun) {
    // 2026-10-05 (ops health fix): name the tickets the breaker would refuse (observe) / refused (enforce) — counted per ticket, once
    if (!ENFORCE_BREAKER) {
      bst.wouldRefuseToday = (bst.wouldRefuseToday || 0) + breakerHits.length;
      auditLine(\`CIRCUIT-BREAKER observe (paper — nothing refused): \${breakerHits.length} new ticket(s) WOULD be refused if enforced: \${breakerHits.slice(0, 12).map(h => \`\${h.sym}\${h.ctrl ? " (ctrl)" : ""}\`).join(", ")}\${breakerHits.length > 12 ? " …" : ""} — \${bst.reason}\`);
    }
    try {
      const at = new Date().toISOString();
      fs.appendFileSync(BREAKER_HITS_PATH, breakerHits.map(h => JSON.stringify({ date: risk.date, at, mode: RP.RISK_POLICY.breakerMode, enforced: ENFORCE_BREAKER, basis: BE.basis, policyVersion: RP.RISK_POLICY.version, ...h })).join("\\n") + "\\n");
    } catch (e) { console.warn("[breaker] hits log append failed:", e.message); }
  }
  if (dryRun) return res.json({ dryRun: true, wouldSave: gated.length, refused, gateVetoes, breaker: { mode: RP.RISK_POLICY.breakerMode, halted: bst.halted, enforced: ENFORCE_BREAKER && bst.halted, reason: bst.reason, wouldRefuseToday: bst.wouldRefuseToday || 0, hitsThisPost: breakerHits.length, basis: BE.basis }, risk });
  try { __atomicText(BREAKER_PATH, JSON.stringify(bst)); } catch (e) { console.warn("[breaker] circuit-breaker.json write failed:", e.message); }   // atomic since 2026-10-05
`);

// ── H5: the POST response carries the per-post hit count (append-only key) ──
hunk("H5 response",
`  res.json({ saved: out.length, tombstones: tombs.length, refused, gateVetoes, breaker: { mode: RP.RISK_POLICY.breakerMode, halted: ENFORCE_BREAKER && bst.halted, observedHalt: bst.halted, reason: bst.reason, refusedToday: bst.refusedToday, wouldRefuseToday: bst.wouldRefuseToday || 0 } });
`,
`  res.json({ saved: out.length, tombstones: tombs.length, refused, gateVetoes, breaker: { mode: RP.RISK_POLICY.breakerMode, halted: ENFORCE_BREAKER && bst.halted, observedHalt: bst.halted, reason: bst.reason, refusedToday: bst.refusedToday, wouldRefuseToday: bst.wouldRefuseToday || 0, hitsThisPost: breakerHits.length, basis: BE.basis } });
`);

for (const h of HUNKS) {
  const n = src.split(h.oldS).length - 1;
  if (n !== 1) { console.error(`${h.name}: old text found ${n} times (need exactly 1) — refusing`); process.exit(3); }
  src = src.replace(h.oldS, () => h.newS);
}
if (/(^|[^\r])\n/.test(src)) { console.error("result has a bare LF — refusing"); process.exit(3); }
fs.writeFileSync(OUT, src);
console.log(`staged ${path.relative(REPO, OUT)} · ${HUNKS.length} hunks · base ${sha(buf).slice(0, 12)} -> staged ${sha(Buffer.from(src)).slice(0, 12)} · CRLF`);
if (sha(buf) !== base) {   // --rebase: the staged copy now sits on the new live file — record that base (atomic), then the manifest + selftest must be redone
  const bs = JSON.parse(fs.readFileSync(path.join(PKG, "base-shas.json"), "utf8")); bs.base["backend/traids-server-v2.js"] = sha(buf); bs.rebased = { ...(bs.rebased || {}), "backend/traids-server-v2.js": new Date().toISOString() };
  require(path.join(REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic(path.join(PKG, "base-shas.json"), bs);
  console.log("REBASED: base-shas.json updated for backend/traids-server-v2.js — now run make-manifest.cjs and selftest.cjs --part breaker");
}
