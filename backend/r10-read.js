#!/usr/bin/env node
/**
 * R10 — CRYPTO COHORT KILL-TEST: THE READ. Registered 2026-07-31; first formal read 2026-08-21.
 *
 * THE RULE (verbatim from the registry): adjudicate at >= 15 clean-epoch sessions AND >= 150
 * crypto signal settles; if the day-clustered mean R of crypto signal trades is negative with
 * t <= -1.5, crypto is DEMOTED from the signal board (tickets still generate and settle as a
 * tagged shadow class; they stop counting toward the book).
 *
 * WHY THIS FILE EXISTS. The audit flagged R10 as "sample condition met, statistic never
 * computed" — a registered test left unread is a silent pass for whatever it was guarding.
 * This computes the statistic nightly, records each read, and never demotes anything by
 * itself: a KILL verdict is a decision memo for the operator (the demotion is a board-policy
 * change, made by hand, registered when made). The kill-test stays ARMED: the sample condition,
 * once met, remains met, so every nightly read is an adjudication under the same trigger.
 *
 * Population: clean epoch (>= 2026-07-20), cls Crypto, settled rMult, signal arm only (no
 * controls, no coin-flip twins, no veto shadows). Unit of inference: the session (openedAt day).
 * Output: data/r10-read.json (append-only reads[]).
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const CLEAN = new Date("2026-07-20T00:00:00-04:00").getTime();
const BAR = { minSessions: 15, minSettles: 150, killT: -1.5 };
const day = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

const log = JSON.parse(fs.readFileSync(D("trade_log.json"), "utf8"));
const c = log.filter((r) => r.openedAt >= CLEAN && r.cls === "Crypto" && Number.isFinite(r.rMult) && !r.ctrl && !r.ctrlRand && !r.vetoShadow);
const by = {}; for (const r of c) (by[day(r.openedAt)] ||= []).push(r.rMult);
const m = Object.values(by).map(mean), k = m.length;
const g = k ? mean(m) : null, sd = k > 1 ? Math.sqrt(m.reduce((s, x) => s + (x - g) ** 2, 0) / (k - 1)) : null;
const t = sd > 0 ? g / (sd / Math.sqrt(k)) : null;
const split = (rows) => ({ n: rows.length, avgR: rows.length ? +mean(rows.map((r) => r.rMult)).toFixed(4) : null, win: rows.length ? +(100 * rows.filter((r) => r.rMult > 0).length / rows.length).toFixed(1) : null });
const read = {
  at: new Date().toISOString(), asOfSession: c.length ? day(Math.max(...c.map((r) => r.closedAt || r.openedAt))) : null,
  n: c.length, sessions: k, win: split(c).win, avgR: split(c).avgR, dayMeanR: g != null ? +g.toFixed(4) : null, t: t != null ? +t.toFixed(3) : null,
  pnl: Math.round(c.reduce((s, r) => s + (r.pnl || 0), 0)),
  longs: split(c.filter((r) => r.dir > 0)), shorts: split(c.filter((r) => r.dir < 0)),
  sampleMet: k >= BAR.minSessions && c.length >= BAR.minSettles,
};
read.verdict = !read.sampleMet ? `NOT YET — ${k}/${BAR.minSessions} sessions, ${c.length}/${BAR.minSettles} settles`
  : (read.dayMeanR < 0 && read.t <= BAR.killT) ? `KILL — day-clustered mean R ${read.dayMeanR}, t ${read.t} <= ${BAR.killT}: DEMOTE crypto (operator action, by hand)`
  : `SURVIVES — day-clustered mean R ${read.dayMeanR}, t ${read.t} vs kill bar ${BAR.killT}: not demoted; kill-test stays armed nightly`;

const st = (() => { try { return JSON.parse(fs.readFileSync(D("r10-read.json"), "utf8")); } catch { return { spec: "R10 crypto kill-test", registered: "2026-07-31", firstRead: "2026-08-21", bar: BAR, reads: [] }; } })();
st.latest = read; st.reads.push({ at: read.at, n: read.n, sessions: read.sessions, dayMeanR: read.dayMeanR, t: read.t, verdict: read.verdict.split(" — ")[0] });
if (st.reads.length > 400) st.reads = st.reads.slice(-400);
writeJsonAtomic(D("r10-read.json"), st);

console.log(`R10 CRYPTO KILL-TEST — read ${read.at.slice(0, 10)} · ${read.verdict}`);
console.log(`  ${read.n} crypto signal settles / ${read.sessions} sessions · win ${read.win}% · avgR ${read.avgR} · $${read.pnl}`);
console.log(`  longs ${read.longs.n} avgR ${read.longs.avgR} · shorts ${read.shorts.n} avgR ${read.shorts.avgR} — the direction split is the finding; R28 gates crypto shorts from 2026-08-24`);
console.log(`written: r10-read.json`);
