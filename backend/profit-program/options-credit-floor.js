#!/usr/bin/env node
"use strict";
/**
 * CREDIT FLOOR — does a fixed $1.30 fee make the small-credit wings the unprofitable ones? (read-only, EXPLORATORY: this is the one
 * slice that had the same sign in the live sample and the 501-session archive, so it is looked at once more here, with its mechanism.)
 * Net $ per contract-wing by credit/width bucket, live (245 wings) and archive (R116, 3,868 wings), with the session-clustered t of each
 * bucket against the rest, then the dollars a floor at each cut would have changed: wings below the cut skipped. Cuts are the quartile edges
 * of the archive's own credit/width (a family of 3). Also prints the same bucket levels at ZERO fee. NOTE: a constant fee shifts every bucket by the same dollars, so the vs-rest
 * difference and its t are identical with and without the fee by construction; the zero-fee columns only show the levels (a first draft of
 * this header claimed they tested the fee mechanism; they cannot).
 *   node backend/profit-program/options-credit-floor.js
 * Writes backend/data/profit-program/options-credit-floor.json
 */
const fs = require("fs"), path = require("path");
const C = require("./_opt-common.js");
const { $, f } = C;
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const L = C.ledger();
const live = L.signals.filter(C.isR25).map((t) => ({ day: C.etDay(t.openedAt), cw: t.entry / t.obs.width, y: t.pnl / (t.contracts || 1), n: t.contracts || 1 }));
const A = JSON.parse(fs.readFileSync(path.join(C.DATA, "r116-zero-dte-replay-wings.json"), "utf8")).filter((w) => w.width > 0 && Number.isFinite(w.settle)).map((w) => ({ day: w.day, cw: w.creditCross / w.width, y: w.pnl, n: 1 }));
const q = (vals, p) => { const s = [...vals].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const edges = [q(A.map((r) => r.cw), 0.25), q(A.map((r) => r.cw), 0.5), q(A.map((r) => r.cw), 0.75)];
const bucket = (r) => (r.cw < edges[0] ? 0 : r.cw < edges[1] ? 1 : r.cw < edges[2] ? 2 : 3);
const labels = [`<${edges[0].toFixed(3)}`, `${edges[0].toFixed(3)}-${edges[1].toFixed(3)}`, `${edges[1].toFixed(3)}-${edges[2].toFixed(3)}`, `>=${edges[2].toFixed(3)}`];
const out = { note: "exploratory; cuts are archive quartiles", edges, samples: {} };
for (const [name, R] of [["LIVE R25 (245 wings, 35 sessions)", live], ["ARCHIVE R116 (3,868 wings, 501 sessions)", A]]) {
  console.log(`\n== ${name}: net $ per contract-wing by credit/width (cross credit over width)`);
  console.log(`${"bucket".padEnd(14)} ${"n".padStart(5)} ${"$/wing".padStart(7)} ${"vs rest".padStart(8)} ${"t".padStart(6)} | ${"at zero fee $/wing".padStart(19)} ${"vs rest".padStart(8)} ${"t".padStart(6)}`);
  const rows = [];
  for (let b = 0; b < 4; b++) {
    const B_ = R.filter((r) => bucket(r) === b), pred = (r) => bucket(r) === b;
    const d = C.clusterDiff(R, pred, (r) => r.y, (r) => r.day), d0 = C.clusterDiff(R, pred, (r) => r.y + 1.3, (r) => r.day);
    rows.push({ bucket: labels[b], n: B_.length, mean: C.mean(B_.map((r) => r.y)), vsRest: d.diff, t: d.t, meanZeroFee: C.mean(B_.map((r) => r.y + 1.3)), vsRestZeroFee: d0.diff, tZeroFee: d0.t });
    console.log(`${labels[b].padEnd(14)} ${String(B_.length).padStart(5)} ${$(rows[b].mean).padStart(7)} ${$(d.diff).padStart(8)} ${f(d.t).padStart(6)} | ${$(rows[b].meanZeroFee).padStart(19)} ${$(d0.diff).padStart(8)} ${f(d0.t).padStart(6)}`);
  }
  // dollars a floor would change, at one contract and scaled to 4 contracts x per-session x 21
  const sessions = new Set(R.map((r) => r.day)).size;
  console.log(`   floor at the cut (skip wings below): net change per session at 4 contracts, per 21 sessions`);
  const floors = [];
  for (let c = 0; c < 3; c++) {
    const skipped = R.filter((r) => r.cw < edges[c]), per = -C.sum(skipped.map((r) => r.y)) / sessions * 4;
    floors.push({ floor: edges[c], skippedWings: skipped.length, skippedShare: skipped.length / R.length, gainPerSession4ct: per, gainPerMonth4ct: per * 21 });
    console.log(`   floor ${edges[c].toFixed(3)}: skips ${skipped.length} wings (${f(100 * skipped.length / R.length, 0)}%), their net ${$(C.sum(skipped.map((r) => r.y)))} per contract over the sample -> ${$(per)}/session, ${$(per * 21)}/month at 4 contracts if the skipped wings earn what they earned`);
  }
  out.samples[name] = { buckets: rows, floors };
}
console.log("\nwrote " + C.writeOut("options-credit-floor.json", out));
