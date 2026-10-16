"use strict";
/**
 * CORR-SIZE — correlation-aware size multiplier. Pure, fail-open, never throws. 2026-09-24.
 *
 * Operator approval 2026-09-24 ("go on 1"). R53 REFUSES by a fixed factor-group label; this layer
 * only SHRINKS, by how much the new ticket piles onto exposure the open book already carries,
 * measured from the nightly low-rank correlation fit (backend/corr-factors-fit.js ->
 * data/corr-factors.json).
 *
 *   crowding = sum_j  rho(p,j) * dir_p * dir_j * (riskDollars_j / riskDollars_p)     over |rho| > 0.3
 *   mult     = clamp(1 / sqrt(1 + max(0, crowding)), 0.5, 1.0)
 *
 * Opposite-direction peers on positively correlated names (hedges) enter NEGATIVELY and offset
 * crowding; crowding is floored at 0 so a hedged book never ENLARGES a ticket.
 *
 * ONE DELIBERATE DEVIATION from the approved sketch ("only rho > 0.3 counts"): the noise filter is
 * on |rho|, not rho. A strongly NEGATIVE rho with opposite directions is the SAME bet (long EUR/USD
 * + short USD/CHF, rho -0.69; long QQQ + short SQQQ) and the signed filter would miss it. Pass
 * { signedOnly: true } to get the literal rule; the preview reports both.
 *
 * FAIL-OPEN (mult 1, with why): no factor file, unreadable file, stale fit (> 4 calendar days past
 * asOfSession), fit not strictly before the ticket's session (look-ahead), unknown name, missing or
 * non-positive riskDollars. A peer that is unknown or unsized is skipped and counted.
 *
 * p / openBook items: { sym, cls, dir (+1/-1), riskDollars, ... }. openBook = currently OPEN SIGNAL
 * tickets (callers filter ctrl / vetoShadow out; this function also skips them defensively).
 */
const fs = require("fs"), path = require("path");

const FILE = path.join(__dirname, "..", "data", "corr-factors.json");
const RHO_MIN = 0.3, FLOOR = 0.5, STALE_DAYS = 4;
let _cache = { mtimeMs: -1, doc: null };

function sessionOf(ms) { return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
function dayDiff(a, b) { return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400e3); }

function loadFactors(file = FILE) {
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs !== _cache.mtimeMs || _cache.file !== file) {
      _cache = { mtimeMs: st.mtimeMs, file, doc: JSON.parse(fs.readFileSync(file, "utf8")) };
    }
    return _cache.doc;
  } catch { return null; }
}

function rhoOf(A, B) {
  if (!A || !B || !Array.isArray(A.loadings) || !Array.isArray(B.loadings) || A.loadings.length !== B.loadings.length) return null;
  let s = 0; for (let i = 0; i < A.loadings.length; i++) s += A.loadings[i] * B.loadings[i];
  return Number.isFinite(s) ? Math.max(-1, Math.min(1, s)) : null;
}

const key = (sym) => String(sym || "").toUpperCase();

/**
 * corrSizeMult(p, openBook, opts?) -> { mult, crowding, topPeers:[{sym,rho,dir,contrib}], version, why, ... }
 * opts: factors (a preloaded corr-factors doc; else data/corr-factors.json), nowMs (default Date.now()),
 *       signedOnly (literal rho > 0.3 rule), rhoMin, floor.
 */
function corrSizeMult(p, openBook, opts = {}) {
  const open = (why, extra) => ({ mult: 1, crowding: 0, topPeers: [], version: null, why, ...(extra || {}) });
  try {
    const rhoMin = Number.isFinite(opts.rhoMin) ? opts.rhoMin : RHO_MIN;
    const floor = Number.isFinite(opts.floor) ? opts.floor : FLOOR;
    const doc = opts.factors || loadFactors(opts.file);
    if (!doc || !doc.names || !doc.asOfSession) return open("fail-open: no corr-factors fit");
    const version = `${doc.version || "corr-factors"}@${doc.asOfSession}`;
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const today = sessionOf(nowMs);
    if (doc.asOfSession >= today) return open(`fail-open: fit asOf ${doc.asOfSession} is not before session ${today} (look-ahead guard)`, { version });
    const age = dayDiff(doc.asOfSession, today);
    if (age > STALE_DAYS) return open(`fail-open: fit stale (${age}d > ${STALE_DAYS}d, asOf ${doc.asOfSession})`, { version });
    if (!p || !p.sym) return open("fail-open: no ticket", { version });
    const dirP = Math.sign(Number(p.dir)) || 0;
    if (!dirP) return open("fail-open: ticket has no direction", { version });
    const rdP = Number(p.riskDollars);
    if (!(rdP > 0)) return open("fail-open: ticket has no riskDollars", { version });
    const me = doc.names[key(p.sym)];
    if (!me) return open(`fail-open: ${p.sym} not in fit`, { version });

    let crowding = 0, counted = 0, skippedUnknown = 0, skippedUnsized = 0;
    const peers = [];
    for (const q of Array.isArray(openBook) ? openBook : []) {
      if (!q || q === p || (p.id && q.id === p.id) || q.ctrl || q.vetoShadow) continue;
      const dirQ = Math.sign(Number(q.dir)) || 0;
      if (!dirQ) continue;
      const rdQ = Number(q.riskDollars);
      if (!(rdQ > 0)) { skippedUnsized++; continue; }
      const them = doc.names[key(q.sym)];
      if (!them) { skippedUnknown++; continue; }
      const rho = key(q.sym) === key(p.sym) ? 1 : rhoOf(me, them);
      if (rho == null) { skippedUnknown++; continue; }
      if (opts.signedOnly ? !(rho > rhoMin) : !(Math.abs(rho) > rhoMin)) continue;
      const contrib = rho * dirP * dirQ * (rdQ / rdP);
      crowding += contrib; counted++;
      peers.push({ sym: q.sym, rho: +rho.toFixed(3), dir: dirQ, contrib: +contrib.toFixed(3) });
    }
    const raw = 1 / Math.sqrt(1 + Math.max(0, crowding));
    const mult = Math.max(floor, Math.min(1, raw));
    peers.sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib));
    const why = counted === 0
      ? `no open peer with |rho| > ${rhoMin}`
      : `crowding ${crowding.toFixed(2)} from ${counted} peer(s)${mult === floor && raw < floor ? ` (raw ${raw.toFixed(2)} floored at ${floor})` : ""}`;
    return {
      mult: +mult.toFixed(4), crowding: +crowding.toFixed(4),
      topPeers: peers.slice(0, 5).map(({ sym, rho, dir, contrib }) => ({ sym, rho, dir, contrib })),
      version, why, peersCounted: counted, skippedUnknown, skippedUnsized,
    };
  } catch (e) {
    return open(`fail-open: error ${e && e.message}`);
  }
}

module.exports = { corrSizeMult, loadFactors, rhoOf, RHO_MIN, FLOOR, STALE_DAYS };
