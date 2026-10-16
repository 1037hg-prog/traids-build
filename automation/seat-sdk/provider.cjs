"use strict";
/**
 * SEAT-SDK TRIAL — THE SWITCH. backend/data/seat-provider.json says which launcher runs each nightly seat:
 *
 *   "cli"   the command-line path of automation/seat-wave.cjs, as it has always been — THE DEFAULT, and what every seat takes when the
 *           file is absent or cannot be read (a file that does not validate is "cannot be read": a typo never moves a seat to the
 *           path that spends API credit)
 *   "sdk"   the Agent SDK on the home API key (automation/seat-sdk/run-seat.cjs), for every seat or only for the seats listed
 *
 * The file is written by ONE command, automation/seat-sdk/set-provider.cjs (through backend/lib/atomic-write.js). This module only
 * reads. The seat wave asks it once per seat, so a change of the file between two seats takes effect at the next seat.
 *
 *   { "schema": "seat-provider-v1", "provider": "cli" | "sdk",
 *     "seats": ["risk-governor"],                         optional, "sdk" only: these seats take the SDK, the others stay on "cli"
 *     "limits": { "nightCapUsd": 12, "trialCapUsd": 180, "trialEnd": "2026-11-14" },   optional (these are the defaults): the trial cap never
 *                                                         above the $200 grant, the night cap never above the trial cap, the end never after 2026-11-14
 *     "setAt": "...", "setBy": "...", "note": "..." }     written by the command; not read for routing
 *
 * A module: nothing happens on load.
 */
const fs = require("fs"), path = require("path");
const S = require("./seats.cjs");
const SCHEMA = "seat-provider-v1", REL = "backend/data/seat-provider.json";
const KEYS = ["schema", "provider", "seats", "limits", "setAt", "setBy", "note"], LIMIT_KEYS = ["nightCapUsd", "trialCapUsd", "trialEnd"];
const fileOf = (root) => path.join(root, ...REL.split("/"));
const isDay = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d + "T00:00:00Z")) && new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;
const isUsd = (x) => typeof x === "number" && Number.isFinite(x) && x > 0;

/** every problem of a provider document ([] = valid). Strict on purpose: an unknown key ("seat" for "seats") is a problem, never ignored. */
function validate(doc) {
  const bad = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return ["not a JSON object"];
  if (doc.schema !== SCHEMA) bad.push(`schema is ${JSON.stringify(doc.schema)}, not "${SCHEMA}"`);
  for (const k of Object.keys(doc)) if (!KEYS.includes(k)) bad.push(`unknown key ${JSON.stringify(k)}`);
  if (doc.provider !== "cli" && doc.provider !== "sdk") bad.push(`provider is ${JSON.stringify(doc.provider)}, not "cli" or "sdk"`);
  if (doc.seats !== undefined) {
    if (doc.provider !== "sdk") bad.push('a seats list belongs to provider "sdk" only');
    if (!Array.isArray(doc.seats) || !doc.seats.length) bad.push("seats must be a non-empty list (leave it out for every seat)");
    else {
      for (const s of doc.seats) if (!S.SEAT_NAMES.includes(s)) bad.push(`seats names ${JSON.stringify(s)}, which is not one of ${S.SEAT_NAMES.join(", ")}`);
      if (new Set(doc.seats).size !== doc.seats.length) bad.push("seats names a seat twice");
    }
  }
  if (doc.limits !== undefined) {
    const L = doc.limits;
    if (!L || typeof L !== "object" || Array.isArray(L)) bad.push("limits must be an object");
    else {
      for (const k of Object.keys(L)) if (!LIMIT_KEYS.includes(k)) bad.push(`unknown limit ${JSON.stringify(k)}`);
      const m = { ...S.DEFAULT_LIMITS, ...L };
      if (!isUsd(m.nightCapUsd)) bad.push("limits.nightCapUsd must be a number of dollars above 0");
      if (!isUsd(m.trialCapUsd)) bad.push("limits.trialCapUsd must be a number of dollars above 0");
      if (isUsd(m.trialCapUsd) && m.trialCapUsd > S.GRANT_USD) bad.push(`limits.trialCapUsd is above the $${S.GRANT_USD} grant`);
      if (isUsd(m.nightCapUsd) && isUsd(m.trialCapUsd) && m.nightCapUsd > m.trialCapUsd) bad.push("limits.nightCapUsd is above limits.trialCapUsd");
      if (!isDay(m.trialEnd)) bad.push("limits.trialEnd must be a date YYYY-MM-DD");
      else if (m.trialEnd > S.TRIAL_END) bad.push(`limits.trialEnd is after ${S.TRIAL_END}, the day the grant expires`);
    }
  }
  return bad;
}

/** -> { state: "absent" } | { state: "unreadable", why } | { state: "ok", provider, seats: [names] | null, limits, doc } */
function read(root) {
  let text;
  try { text = fs.readFileSync(fileOf(root), "utf8"); }
  catch (e) { return e && e.code === "ENOENT" ? { state: "absent" } : { state: "unreadable", why: `the file cannot be read (${(e && e.code) || "error"})` }; }
  let doc; try { doc = JSON.parse(text); } catch { return { state: "unreadable", why: "the file is not JSON" }; }
  const bad = validate(doc);
  if (bad.length) return { state: "unreadable", why: bad.slice(0, 3).join("; ") };
  return { state: "ok", provider: doc.provider, seats: doc.seats ? [...doc.seats] : null, limits: { ...S.DEFAULT_LIMITS, ...(doc.limits || {}) }, doc };
}
/** which launcher a seat takes under a read() result: "sdk" only when a VALID file says so for that seat; everything else is "cli" */
function route(P, seat) {
  if (!P || P.state !== "ok" || P.provider !== "sdk") return "cli";
  if (!S.SEAT_NAMES.includes(seat)) return "cli";
  return P.seats === null || P.seats.includes(seat) ? "sdk" : "cli";
}
/** the limits in force under a read() result (the defaults unless a valid file tightens them) */
const limitsOf = (P) => (P && P.state === "ok" ? { ...P.limits } : { ...S.DEFAULT_LIMITS });

module.exports = { SCHEMA, REL, KEYS, LIMIT_KEYS, fileOf, validate, read, route, limitsOf, isDay, isUsd };
