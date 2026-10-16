#!/usr/bin/env node
/**
 * SEAL A CLAIM — the one command a seat runs before it is allowed to stop. 2026-09-01.
 *
 * lib/seat-seal.js has existed since 2026-08-29 and, as of today, data/seat-claims.jsonl did not
 * exist: zero rows, ever. Seven seats acted on 2026-08-31 and none sealed, and seat-seal-accrual
 * failed the chain for exactly that. The mechanism was a library with no door. This is the door:
 * a CLI a headless seat can call from Bash without writing its own node snippet (which, on this
 * board, is how JSON gets mangled).
 *
 * The rules are the library's, not this file's: NAMED, SIZED, DATED, FALSIFIABLE, window still
 * open, no hedge words. A refused claim exits 2 and prints why, so the seat can restate it.
 *
 * Usage:
 *   node backend/seal-claim.js --seat risk-governor --kind halt --subject "book may open tickets 2026-09-02" \
 *        --direction allow --falsifier "session P&L on 2026-09-02 is below -$1,500" \
 *        --closes 2026-09-02T20:05:00Z [--magnitude 0.25] [--note "..."] [--links R53,PM1]
 *
 *   --closes accepts an ISO timestamp OR "sessions:N" (N trading sessions ahead, closing 16:05 ET).
 */
const path = require("path");
const SEAL = require("./lib/seat-seal.js");

const arg = (k, d = null) => { const i = process.argv.indexOf("--" + k); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };

function etCloseAfterSessions(n) {
  // walk forward N weekdays from today (ET), return 16:05 ET as ISO. Holidays are not modelled:
  // a window that closes a day late is still open at grading time, which errs safe.
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  let d = new Date(et), left = n;
  while (left > 0) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) left--; }
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  // 16:05 ET expressed as an instant: build in ET then read the offset via Intl
  const probe = new Date(`${y}-${m}-${dd}T16:05:00Z`);
  const offMin = (new Date(probe.toLocaleString("en-US", { timeZone: "America/New_York" })) - new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }))) / 60000;
  return new Date(probe.getTime() - offMin * 60000).toISOString();
}

const closesRaw = arg("closes");
let closesAt = closesRaw;
if (closesRaw && /^sessions:\d+$/.test(closesRaw)) closesAt = etCloseAfterSessions(+closesRaw.split(":")[1]);

const magnitude = arg("magnitude") != null ? Number(arg("magnitude")) : undefined;
const links = arg("links") ? arg("links").split(",").map((s) => s.trim()).filter(Boolean) : undefined;

const claim = {
  seat: arg("seat"), kind: arg("kind"), subject: arg("subject"), falsifier: arg("falsifier"),
  direction: arg("direction") || undefined, magnitude: Number.isFinite(magnitude) ? magnitude : undefined,
  window: { opensAt: arg("opens") || undefined, closesAt },
  note: arg("note") || undefined, links,
};

const r = SEAL.seal(claim);
if (!r.ok) { console.error("REFUSED — " + r.refused); process.exit(2); }
console.log(`sealed #${r.row.seq} · ${r.row.seat} · ${r.row.kind} · closes ${r.row.window.closesAt} · ${path.relative(process.cwd(), SEAL.LEDGER)}`);
