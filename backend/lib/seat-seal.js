/**
 * SEAT SEAL — one append-only ledger of dated, falsifiable claims, for every seat. 2026-08-29.
 * Writes data/seat-claims.jsonl · never rewrites, never deletes.
 *
 * WHY ONE MECHANISM AND NOT ELEVEN FILES.
 *
 * lib/seat-claims.js found eleven seats whose claims are falsifiable but whose record does not
 * exist. Reading the eleven gaps together, they are the SAME gap wearing different clothes:
 *
 *   risk-governor          a wouldHalt flag, sealed before the close
 *   head-trader            a WOULD-DO, sealed before the open
 *   portfolio-constructor  a weight vector, sealed per session
 *   capacity-fill-sim      a predicted band, sealed before the size is traded
 *   marks-analyst          a named configuration, dated before the forward window
 *   strategy-skeptic       a pass, linked to the test id it cleared
 *   edge-hunter            a hunt, linked to the registered test id
 *   the three auditors     a defect, attributed to who found it
 *
 * Every one is: SAY THE THING, BEFORE THE ANSWER IS KNOWABLE, IN A FORM THAT CAN BE CHECKED.
 * That is one primitive. Eleven bespoke writers would drift eleven ways and each would have to
 * re-learn the sealing rules; one ledger means a claim is either in it or it does not exist.
 *
 * ═══ WHAT MAKES A CLAIM GRADEABLE, ENFORCED HERE RATHER THAN HOPED FOR ═══
 *
 * Borrowed verbatim from HT1's anti-gaming rule, because it is the right rule and it is already
 * registered: a claim is gradeable only if it is
 *
 *   NAMED    it identifies its subject — an instrument, a test id, a session, a defect location.
 *   SIZED    it commits to a magnitude or an explicit direction. "Consider", "monitor", "watch",
 *            "keep an eye on" are hedges, not claims, and are REFUSED at write time rather than
 *            silently scored zero later.
 *   DATED    it carries the window in which it can be checked, and that window must still be OPEN
 *            when the claim is written. A claim sealed after its own outcome is knowable is not a
 *            prediction; it is a description, and it is refused.
 *   FALSIFIABLE  it states what observation would prove it wrong. A claim that nothing could
 *            refute scores nothing, and pretending otherwise is how a seat accumulates a record
 *            it did not earn.
 *
 * ═══ INTEGRITY ═══
 *
 * Each row carries a SHA-256 over the claim's own content plus the previous row's hash — a chain.
 * A claim edited after sealing breaks every hash after it, so silent revision is detectable rather
 * than merely discouraged. `verify()` walks the chain and reports the first break.
 *
 * Append-only. No update path exists in this module by design: a seat that was wrong stays wrong
 * in the record, which is the entire value of the record.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const D = (f) => path.join(__dirname, "..", "data", f);
const LEDGER = D("seat-claims.jsonl");

const HEDGES = /\b(consider|considering|monitor|monitoring|watch|watching|keep an eye|may |might |could |possibly|perhaps|explore|look into|tbd)\b/i;

const etParts = () => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date());
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return { day: `${g("year")}-${g("month")}-${g("day")}`, hh: +g("hour"), mm: +g("minute"), dow: g("weekday") };
};

function readAll() {
  try { return fs.readFileSync(LEDGER, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}

const hashOf = (row, prev) =>
  crypto.createHash("sha256").update(JSON.stringify({
    seat: row.seat, kind: row.kind, subject: row.subject, magnitude: row.magnitude,
    direction: row.direction, falsifier: row.falsifier, window: row.window, sealedAt: row.sealedAt,
  }) + "|" + (prev || "")).digest("hex");

/**
 * Seal one claim. Returns { ok, row } or { ok:false, refused } — it REFUSES rather than throws,
 * so a seat that writes a bad claim gets told why and the run continues.
 *
 * required: seat, kind, subject, falsifier, window {opensAt, closesAt}
 * plus at least one of: magnitude (number) or direction ("long"|"short"|"refuse"|"allow"|...)
 */
function seal(claim) {
  const now = etParts(), nowMs = Date.now();
  const missing = ["seat", "kind", "subject", "falsifier"].filter((k) => !claim || !claim[k]);
  if (missing.length) return { ok: false, refused: "NOT NAMED — missing " + missing.join(", ") };

  const sized = Number.isFinite(claim.magnitude) || (typeof claim.direction === "string" && claim.direction.length);
  if (!sized) return { ok: false, refused: "NOT SIZED — a claim must commit to a magnitude or an explicit direction" };

  const text = [claim.subject, claim.falsifier, claim.note].filter(Boolean).join(" ");
  if (HEDGES.test(text)) return { ok: false, refused: "HEDGED — 'consider / monitor / watch / may / might' is not a claim. Say what will happen or say nothing." };

  const w = claim.window || {};
  if (!w.closesAt) return { ok: false, refused: "NOT DATED — a claim must carry the window in which it can be checked" };
  const closes = typeof w.closesAt === "number" ? w.closesAt : Date.parse(w.closesAt);
  if (!Number.isFinite(closes)) return { ok: false, refused: "NOT DATED — window.closesAt is unparseable" };
  if (closes <= nowMs) return { ok: false, refused: "WINDOW ALREADY CLOSED — a claim sealed after its outcome is knowable is a description, not a prediction" };

  const all = readAll();
  const prev = all.length ? all[all.length - 1].hash : "";
  const row = {
    seq: all.length + 1, seat: claim.seat, kind: claim.kind,
    subject: claim.subject, magnitude: Number.isFinite(claim.magnitude) ? claim.magnitude : null,
    direction: claim.direction || null, falsifier: claim.falsifier,
    window: { opensAt: w.opensAt || new Date(nowMs).toISOString(), closesAt: new Date(closes).toISOString() },
    session: now.day, sealedAt: new Date(nowMs).toISOString(),
    note: claim.note || null, links: claim.links || null,
    graded: false, outcome: null,
  };
  row.prevHash = prev;
  row.hash = hashOf(row, prev);
  fs.appendFileSync(LEDGER, JSON.stringify(row) + "\n");
  return { ok: true, row };
}

/** Walk the hash chain. Returns the first break, or null when the ledger is intact. */
function verify() {
  const all = readAll();
  let prev = "";
  for (const r of all) {
    if (r.prevHash !== prev) return { broken: true, at: r.seq, why: "prevHash does not match the previous row's hash" };
    if (r.hash !== hashOf(r, prev)) return { broken: true, at: r.seq, why: "row content does not match its own hash — edited after sealing" };
    prev = r.hash;
  }
  return null;
}

/** Claims whose window has closed and which have not been graded — the queue a grader must clear. */
function due(nowMs = Date.now()) {
  return readAll().filter((r) => !r.graded && Date.parse(r.window.closesAt) <= nowMs);
}

/** Per-seat tally: sealed, due, graded, correct. Never invents a grade for an ungraded claim. */
function tally() {
  const by = {};
  for (const r of readAll()) {
    const s = (by[r.seat] = by[r.seat] || { seat: r.seat, sealed: 0, graded: 0, correct: 0, open: 0, due: 0 });
    s.sealed++;
    if (r.graded) { s.graded++; if (r.outcome === "correct") s.correct++; }
    else if (Date.parse(r.window.closesAt) <= Date.now()) s.due++;
    else s.open++;
  }
  return Object.values(by).sort((a, b) => b.sealed - a.sealed);
}

module.exports = { seal, verify, due, tally, readAll, LEDGER, HEDGES };
