#!/usr/bin/env node
/** Seals R144's one read (2026-09-22). */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const r = JSON.parse(fs.readFileSync(D("r144-leadlag.json"), "utf8")); if (!r.read) { console.error("not a read"); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R144) { console.error("already sealed"); process.exit(2); }
const best = Object.entries(r.variants).sort((a, b) => (b[1].t ?? -99) - (a[1].t ?? -99))[0];
const gross = Object.entries(r.variants).map(([k, v]) => `${k} ${v.grossPerSignal}`).join(", ");
const verdict = `${r.verdict} — all six variants negative. Best of six ${best[0]}: ${best[1].meanNetPtsPerSession} net ES pts per session, t ${best[1].t} against a bar of 2.419. BEFORE cost the gross per signal is essentially zero (${gross}), so the Dow's move is already in the S&P by the time a 1-minute bar closes: there is nothing to converge, and the cost is the whole loss. 272 sessions, 2025-08-19..2026-09-22, 9,000+ signals. Controls: scrambled prices gave the same near-zero gross (no manufactured edge), and the look-ahead control lit up at t 18-25 (the measurement can see convergence when it exists).`;
seals.tests.R144 = { sealedOn: "2026-09-22", sessions: r.coverage.sessions, unit: "sessions", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R144"); t.status = "READ 2026-09-22 — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R144", verdict: r.verdict, bestT: best[1].t }) + "\n");
console.log("sealed");
