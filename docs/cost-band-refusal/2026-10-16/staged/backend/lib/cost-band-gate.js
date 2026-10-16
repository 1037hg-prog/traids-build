"use strict";
/**
 * COST BAND REFUSAL — operator decision 2026-10-15, a COST CONTROL. NOT a registered test: it carries no test id and mints none.
 *
 * A new board STOCK ticket whose stamped round-trip spread (obs.spreadBps, the round-trip quoted spread in bps, cost-model.js:81)
 * is 30 to 100 bps INCLUSIVE is refused at the entry POST and kept as a veto SHADOW: the ticket's own shape, tracked and settled like
 * a signal, marked ctrl:true, vetoShadow:true and veto:"COSTBAND spread 30-100bps", so the refused tail can be measured later.
 *
 * It sits BESIDE R49, never in front of it. R49 (lib/enforcement-gates.js) refuses spreadBps > 100; the registered gates (R49, R53,
 * the STAMP gate) are asked FIRST and keep every ticket they refuse. This gate is asked only when they all pass, so a ticket over
 * 100 bps is still R49's refusal and an unstamped one is still the STAMP gate's. Its veto string matches none of /R49/, /R53/, /R28/
 * or the STAMP veto, so no registered reader counts its shadows as its own.
 *
 * Scope: cls "Equity", not a control twin (ctrl / ctrlRand), not already a veto shadow, not a sleeve ticket (p.sleeve), with a
 * finite obs.spreadBps. Everything else passes untouched (FX, crypto, futures, options, controls, sleeves, unstamped tickets).
 *
 * OFF switch: backend/data/cost-band-OFF. Absent means ON. Present (any content) means the gate passes everything. It is read at
 * every evaluation, so creating or deleting the file takes effect on the next ticket without a restart; the gate itself is loaded
 * at the board server's restart.
 *
 * Pure apart from one fs.existsSync on the OFF file: no network, no broker, no write. The caller writes the shadow row.
 */
const fs = require("fs"), path = require("path");

const BAND_LO_BPS = 30;                                     // inclusive
const BAND_HI_BPS = 100;                                    // inclusive; > 100 is R49's
const TEST = "COSTBAND";
const VETO = "COSTBAND spread 30-100bps";
const OFF_FILE = path.join(__dirname, "..", "data", "cost-band-OFF");

/** true when the gate is on: the OFF file is absent. `offFile` and `exists` are for fixtures. */
function isOn({ offFile = OFF_FILE, exists = fs.existsSync } = {}) {
  return !exists(offFile);
}

/** true when the ticket is one this gate looks at: a new, non-control, non-shadow, non-sleeve board stock ticket. */
function inScope(t) {
  return !!t && t.cls === "Equity" && !t.ctrl && !t.ctrlRand && !t.vetoShadow && !t.sleeve;
}

/** spreadBps inside [30, 100]: the band. Non-finite is outside (the STAMP gate owns a missing stamp). */
function inBand(bps) {
  return typeof bps === "number" && Number.isFinite(bps) && bps >= BAND_LO_BPS && bps <= BAND_HI_BPS;
}

/**
 * evaluate(ticket, opts) -> null (passes) or { test: "COSTBAND", veto, why }.
 * Call it only after the registered gates returned null for the same ticket.
 */
function evaluate(t, opts = {}) {
  if (!inScope(t)) return null;
  const bps = t.obs && t.obs.spreadBps;
  if (!inBand(bps)) return null;
  if (!isOn(opts)) return null;
  return { test: TEST, veto: VETO, why: `stamped round-trip spread ${+bps.toFixed(1)} bps is inside the cost band ${BAND_LO_BPS}-${BAND_HI_BPS} bps (operator cost control 2026-10-15; off switch backend/data/cost-band-OFF)` };
}

/**
 * toShadow(ticket, verdict, nowMs) -> the ticket's own shape, marked refused by the cost band. Does not mutate the input.
 * Same marks as the house veto shadow (ctrl, vetoShadow, veto, vetoWhy, vetoAt); costBand records the band it was refused in.
 */
function toShadow(t, verdict, nowMs = Date.now()) {
  if (!verdict || verdict.test !== TEST) throw new Error("cost-band toShadow: not a COSTBAND verdict");
  const obs = t.obs ? { ...t.obs } : {};
  return { ...t, obs, ctrl: true, vetoShadow: true, veto: verdict.veto, vetoWhy: verdict.why, vetoAt: new Date(nowMs).toISOString(),
           costBand: { loBps: BAND_LO_BPS, hiBps: BAND_HI_BPS, spreadBps: obs.spreadBps } };
}

module.exports = { BAND_LO_BPS, BAND_HI_BPS, TEST, VETO, OFF_FILE, isOn, inScope, inBand, evaluate, toShadow };
