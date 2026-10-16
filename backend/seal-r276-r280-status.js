#!/usr/bin/env node
/** Writes each sealed R276–R280 verdict into its registry status (from data/read-seals.json — the seal is the source). Idempotent;
 *  skips any test not yet sealed. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")).tests || {};
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")); const done = [];
for (const id of ["R276", "R277", "R278", "R279", "R280"]) {
  const s = seals[id], t = reg.preregistered.find((x) => x.id === id); if (!s || !t) continue;
  const status = `SEALED ${s.sealedOn} — ${s.verdict}`; if (t.status === status) continue; t.status = status; done.push(id);
}
if (done.length) { reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
  const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
  cr.push({ date: new Date().toISOString().slice(0, 10), area: `${done.join(", ")} — sealed reads recorded`, category: "read", breaksComparability: false, change: done.map((id) => `${id}: ${seals[id].verdict.split(" — ")[0]}`).join("; "), why: "Operator: test them all (2026-09-28 scout).", doesNotEstablish: "No sleeve, sizing or live change.", operator: "Josh 2026-09-28" });
  writeJsonAtomic(D("change-registry.json"), cr); }
console.log("status written:", done.join(", ") || "none");
