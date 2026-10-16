/**
 * R7 SEAT — the Alerts scanner becomes a weighted-board CONTRIBUTOR. 2026-09-03.
 *
 * R7 (registered 2026-07-30) said: if the scanner's directional calls clear their bar, the scanner
 * "earns a weighted-board seat at the weight its paired-t supports, which may be negative." The
 * primary endpoint cleared on 2026-09-03 (cohort A, +3d, market-relative, day-clustered t 2.45 vs
 * 2.0 at 21 days / 225 calls — see data/r7-read.json and docs/TRAIDS_R7_Decision_Memo_2026-09-03.html).
 *
 * WHAT A SEAT IS HERE. Not a trade, not a weight anyone assigns. The weighted board (weighted-board.js)
 * earns every contributor's weight walk-forward from its own paired within-session gap on CLOSED
 * tickets; a contributor with no record has weight ZERO and is recorded, displayed and ignored until
 * t >= T_MIN. So the seat is exactly this: from 2026-09-04 every new equity board ticket carries the
 * scanner's same-morning call for its symbol as an observer stamp, and the board decides — over
 * sessions, at its own bar — whether that stamp is worth anything. Nothing here changes any gate,
 * size or refusal today. When W1 replays an EARNED weight it will replay this one like any other.
 *
 * THE STAMP. obs.scannerAlign = ticket direction x scanner vote (positive = the scanner agrees with
 * the ticket; negative = it disagrees; magnitude = vote strength). That is the one number the board
 * can split at its median. Raw vote, the panel's "Model Agreement" ratio, the signal word and the
 * snapshot time are stamped beside it for provenance. Symbols outside the scanner's 100-name
 * universe get no stamp (absence, never a substitute); options/futures/crypto tickets are skipped.
 *
 * VINTAGE. The source is data/r7-scanner-shadow.json days[<today ET>].rows — the FIRST RTH scan of
 * the day, frozen by traids-alerts.js before any ticket of the day is posted (open run is 09:35 ET;
 * the scan runs from 09:30). A ticket posted before today's snapshot exists gets no stamp rather than
 * yesterday's — the check is on the ET day key, so a stale file can never be read as today's call.
 */
const fs = require("fs"), path = require("path");
const F = path.join(__dirname, "..", "data", "r7-scanner-shadow.json");
const SKIP_CLS = new Set(["Options", "Futures", "Crypto", "FX", "Forex"]);
let cache = { mtime: 0, day: null, rows: null, recordedAt: null };
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

function load() {
  const day = todayET();
  try {
    const st = fs.statSync(F);
    if (st.mtimeMs !== cache.mtime || cache.day !== day) {
      const j = JSON.parse(fs.readFileSync(F, "utf8"));
      const d = j.days && j.days[day];
      cache = { mtime: st.mtimeMs, day, rows: d ? new Map((d.rows || []).map((r) => [String(r.sym).toUpperCase(), r])) : null, recordedAt: d ? d.recordedAt : null };
    }
  } catch (e) { cache = { mtime: 0, day, rows: null, recordedAt: null, err: String(e.message).slice(0, 80) }; }
  return cache;
}

/** Stamp one incoming ticket in place. Returns the ticket. Never throws. */
function stamp(p) {
  try {
    if (!p || !p.sym || !Number.isFinite(p.dir) || SKIP_CLS.has(p.cls)) return p;
    const c = load();
    if (!c.rows) return p;
    const r = c.rows.get(String(p.sym).toUpperCase());
    if (!r || !Number.isFinite(r.vote)) return p;
    p.obs = { ...(p.obs || {}),
      scannerAlign: +(Math.sign(p.dir) * r.vote).toFixed(4),
      scannerVote: +r.vote,
      scannerAgree: Number.isFinite(r.confidence) ? +r.confidence : null,   // the panel's ratio — renamed "Model Agreement" in the UI (R7 calibration DID NOT PASS)
      scannerSignal: r.signal || null,
      scannerSnapAt: c.recordedAt,
      scannerSeatFrom: "2026-09-04" };
  } catch { /* fail open: no stamp, nothing else touched */ }
  return p;
}

module.exports = { stamp, load };
