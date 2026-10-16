#!/usr/bin/env node
"use strict";
/**
 * R191 SELL REPAIR (2026-10-14) — FREEZE the recorded files the known-answer cases and the NOTES numbers are worked from (after
 * docs/r231-sell-repair/2026-10-12/make-fixtures.cjs).
 *   node docs/r191-sell-repair/2026-10-14/harness/make-fixtures.cjs            copy into harness/recorded/ (this folder only)
 *   node docs/r191-sell-repair/2026-10-14/harness/make-fixtures.cjs --check    READ-ONLY: every frozen file still has the sha256 its manifest names
 *
 * WHY FROZEN. The live files move every evening. A selftest that read them would give a different answer tomorrow, so today's files are copied
 * ONCE, with the sha256 of each source, and every typed answer in selftest.cjs and every number in NOTES.md is worked from the copies.
 * Read-only on backend/data: it reads the files below and nothing else, and writes only under harness/recorded/.
 *   r191-crypto-trend.json / .jsonl        byte copies (R191's state and ledger)
 *   r231-crypto-vote-sized.json / .jsonl   byte copies (the other crypto sleeve on the same paper account; its restated order rows carry the
 *                                          broker's fee rows of its buys)
 *   alpaca-mirror.jsonl, alpaca-mirror-exits.jsonl   ONLY the rows with cls "Crypto", each line as it is in the source (the full files parse:
 *                                          checked here — a torn line anywhere would make the runner read the mirror as unreadable)
 *   crypto-momentum-cache/<COIN>.json      the completed daily closes before 2026-09-24, joined to the closes R191 itself recorded in its marks
 *                                          (2026-09-24 on) -> bars.json, the last 130 days of BTC and ETH
 *   cfee-rows.json                         NOT made here: the broker's fee rows as restate.cjs --dry --save-rows read them (2026-10-14 19:50 MT,
 *                                          GET /v2/account/activities/CFEE, paper); only named in the manifest with its sha256
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const H = __dirname, PKG = path.resolve(H, ".."), REPO = path.resolve(PKG, "..", "..", ".."), OUT = path.join(H, "recorded"), DATA = path.join(REPO, "backend", "data");
const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

if (process.argv.slice(2).join(" ") === "--check") {
  let bad = 0; const M = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf8"));
  for (const f of M.files) { const p = path.join(OUT, f.name), ok = fs.existsSync(p) && sha(fs.readFileSync(p)) === f.sha256; if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${f.name}`); }
  console.log(bad ? `${bad} frozen file(s) are not what the manifest names` : `all ${M.files.length} frozen files are what the manifest names (copied ${M.copiedAt})`);
  process.exit(bad ? 1 : 0);
}
if (process.argv.length > 2) { console.log("usage: node docs/r191-sell-repair/2026-10-14/harness/make-fixtures.cjs [--check]\nNothing was done."); process.exit(2); }

fs.mkdirSync(OUT, { recursive: true });
const files = [], note = (name, from, extra = {}) => { const b = fs.readFileSync(path.join(OUT, name)); files.push({ name, from, sha256: sha(b), bytes: b.length, ...extra }); };
for (const f of ["r191-crypto-trend.json", "r191-crypto-trend.jsonl", "r231-crypto-vote-sized.json", "r231-crypto-vote-sized.jsonl"]) {
  const b = fs.readFileSync(path.join(DATA, f)); fs.writeFileSync(path.join(OUT, f), b);
  note(f, `backend/data/${f}`, { sourceSha256: sha(b), copy: "bytes" });
}
for (const f of ["alpaca-mirror.jsonl", "alpaca-mirror-exits.jsonl"]) {
  const src = fs.readFileSync(path.join(DATA, f)), lines = src.toString("utf8").split("\n").filter((l) => l.trim());
  lines.forEach((l, i) => { try { JSON.parse(l); } catch { throw new Error(`backend/data/${f}: line ${i + 1} does not parse — not frozen`); } });
  const kept = lines.filter((l) => JSON.parse(l).cls === "Crypto");
  fs.writeFileSync(path.join(OUT, f), kept.join("\n") + (kept.length ? "\n" : ""));
  note(f, `backend/data/${f}`, { sourceSha256: sha(src), copy: "the Crypto rows, each line as it is", rows: kept.length, ofRows: lines.length });
}
{ const s = JSON.parse(fs.readFileSync(path.join(DATA, "r191-crypto-trend.json"), "utf8")), bars = {};
  for (const c of ["BTC", "ETH"]) {
    const rows = JSON.parse(fs.readFileSync(path.join(DATA, "crypto-momentum-cache", `${c}.json`), "utf8")).rows, all = new Map(rows.map((r) => [r.d, r.c])), m = new Map(rows.filter((r) => r.d < "2026-09-24").map((r) => [r.d, r.c]));
    for (const k of s.marks.filter((x) => x.coin === c && x.close != null)) { if (k.d < "2026-09-26" && all.has(k.d) && all.get(k.d) !== k.close) throw new Error(`${c} ${k.d}: the cache and R191's marks disagree`); m.set(k.d, k.close); }
    bars[c] = [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-130).map(([d, cl]) => ({ d, c: cl }));
    for (let i = 1; i < bars[c].length; i++) if (Date.parse(bars[c][i].d) - Date.parse(bars[c][i - 1].d) !== 864e5) throw new Error(`${c}: a day is missing before ${bars[c][i].d}`);
  }
  writeJsonAtomic(path.join(OUT, "bars.json"), bars, { pretty: 0 });
  note("bars.json", "backend/data/crypto-momentum-cache/<COIN>.json (days before 2026-09-24) + the closes in backend/data/r191-crypto-trend.json marks", { copy: "joined", days: 130, firstDay: bars.BTC[0].d, lastDay: bars.BTC[bars.BTC.length - 1].d });
}
if (fs.existsSync(path.join(OUT, "cfee-rows.json"))) { const j = JSON.parse(fs.readFileSync(path.join(OUT, "cfee-rows.json"), "utf8")); note("cfee-rows.json", `the broker: ${j.read} at ${j.readAt}`, { copy: "the broker's answer as read", rows: j.rows.length, rowsSha256: j.rowsSha256 }); }
writeJsonAtomic(path.join(OUT, "manifest.json"), { package: "r191-sell-repair-2026-10-14", copiedAt: new Date().toISOString(), copiedAtMT: new Date().toLocaleString("en-US", { timeZone: "America/Denver" }), note: "Frozen copies of recorded files. Written by harness/make-fixtures.cjs; do not edit by hand. Every typed answer in selftest.cjs and every number in NOTES.md is worked from these.", files });
for (const f of files) console.log(`  ${f.name.padEnd(30)} ${String(f.bytes).padStart(7)} bytes  ${f.sha256.slice(0, 12)}  <- ${f.from}`);
console.log(`frozen ${files.length} files -> ${path.relative(REPO, OUT).replace(/\\/g, "/")}`);
