#!/usr/bin/env node
"use strict";
/**
 * R231 SELL REPAIR (2026-10-12) — FREEZE the recorded files the known-answer cases and the NOTES numbers are worked from.
 *   node docs/r231-sell-repair/2026-10-12/make-fixtures.cjs            copy into harness/recorded/ (this folder only)
 *   node docs/r231-sell-repair/2026-10-12/make-fixtures.cjs --check    READ-ONLY: every frozen file still has the sha256 its manifest names
 *
 * WHY FROZEN. The live files move every evening (the runner books fills, marks a day, the mirror adds rows). A selftest that read them
 * would give a different answer tomorrow. So today's files are copied ONCE, with the sha256 of each source, and every typed answer in
 * selftest.cjs and every number in NOTES.md is worked from the copies (evidence.cjs --recorded). Run without --check this overwrites the
 * copies with whatever the live files hold THEN: the typed answers were worked on the copy of 2026-10-12 (manifest.json), so do not re-run
 * it unless the answers are to be re-typed.
 *
 * Read-only on backend/data: it reads the seven named files below and nothing else, and writes only under harness/recorded/.
 *   r231-crypto-vote-sized.json / .jsonl   byte copies (the sleeve's state and ledger)
 *   r191-crypto-trend.json / .jsonl        byte copies (the other crypto sleeve on the same paper account)
 *   alpaca-mirror.jsonl, alpaca-mirror-exits.jsonl   ONLY the rows with cls "Crypto", each line as it is in the source
 *   alpaca-trade-updates.jsonl             ONLY the rows of account "main" in a symbol of R231's universe, each line as it is
 *   crypto-momentum-cache/<COIN>.json      the completed daily closes before 2026-09-24, joined to the closes the runner itself recorded in
 *                                          its marks (2026-09-24 on) -> bars.json, the last 300 days per coin
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", ".."), OUT = path.join(PKG, "harness", "recorded"), DATA = path.join(REPO, "backend", "data");
const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const UNIVERSE = ["BTC", "ETH", "LTC", "BCH", "LINK", "ADA", "SOL", "DOGE", "AVAX", "DOT", "UNI", "AAVE", "XTZ"];
const SYM = new RegExp(`^(${UNIVERSE.join("|")})/?USD$`);

if (process.argv.slice(2).join(" ") === "--check") {
  let bad = 0; const M = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf8"));
  for (const f of M.files) { const p = path.join(OUT, f.name), ok = fs.existsSync(p) && sha(fs.readFileSync(p)) === f.sha256; if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${f.name}`); }
  console.log(bad ? `${bad} frozen file(s) are not what the manifest names` : `all ${M.files.length} frozen files are what the manifest names (copied ${M.copiedAt})`);
  process.exit(bad ? 1 : 0);
}
if (process.argv.length > 2) { console.log("usage: node docs/r231-sell-repair/2026-10-12/make-fixtures.cjs [--check]\nNothing was done."); process.exit(2); }

fs.mkdirSync(OUT, { recursive: true });
const files = [], note = (name, from, extra = {}) => { const b = fs.readFileSync(path.join(OUT, name)); files.push({ name, from, sha256: sha(b), bytes: b.length, ...extra }); };
for (const f of ["r231-crypto-vote-sized.json", "r231-crypto-vote-sized.jsonl", "r191-crypto-trend.json", "r191-crypto-trend.jsonl"]) {
  const src = path.join(DATA, f), b = fs.readFileSync(src); fs.writeFileSync(path.join(OUT, f), b);
  note(f, `backend/data/${f}`, { sourceSha256: sha(b), copy: "bytes" });
}
const keep = (f, out, test) => {
  const src = fs.readFileSync(path.join(DATA, f)), lines = src.toString("utf8").split("\n").filter((l) => l.trim()), kept = lines.filter((l) => { try { return test(JSON.parse(l)); } catch { return false; } });
  fs.writeFileSync(path.join(OUT, out), kept.join("\n") + (kept.length ? "\n" : ""));
  note(out, `backend/data/${f}`, { sourceSha256: sha(src), copy: "rows kept as they are", rows: kept.length, ofRows: lines.length });
};
keep("alpaca-mirror.jsonl", "alpaca-mirror.jsonl", (r) => r && r.cls === "Crypto");
keep("alpaca-mirror-exits.jsonl", "alpaca-mirror-exits.jsonl", (r) => r && r.cls === "Crypto");
keep("alpaca-trade-updates.jsonl", "trade-updates-main-crypto.jsonl", (r) => r && r.account === "main" && SYM.test(String(r.symbol || "")));
{ // bars: recorded closes only — the cache (fetched 2026-09-25) before 2026-09-24, then the closes in the runner's own marks
  const s = JSON.parse(fs.readFileSync(path.join(DATA, "r231-crypto-vote-sized.json"), "utf8")), bars = {}, differ = [];
  for (const c of UNIVERSE) {
    const rows = JSON.parse(fs.readFileSync(path.join(DATA, "crypto-momentum-cache", `${c}.json`), "utf8")).rows, all = new Map(rows.map((r) => [r.d, r.c])), m = new Map(rows.filter((r) => r.d < "2026-09-24").map((r) => [r.d, r.c]));
    for (const k of s.marks.filter((x) => x.coin === c && x.close != null)) { if (k.d < "2026-09-26" && all.has(k.d) && all.get(k.d) !== k.close) differ.push(`${c} ${k.d}`); m.set(k.d, k.close); }
    bars[c] = [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-300).map(([d, cl]) => ({ d, c: cl }));
    for (let i = 1; i < bars[c].length; i++) if (Date.parse(bars[c][i].d) - Date.parse(bars[c][i - 1].d) !== 864e5) throw new Error(`${c}: a day is missing before ${bars[c][i].d}`);
  }
  if (differ.length) throw new Error(`the cache and the runner's marks disagree on ${differ.join(", ")}`);
  writeJsonAtomic(path.join(OUT, "bars.json"), bars, { pretty: 0 });
  note("bars.json", "backend/data/crypto-momentum-cache/<COIN>.json (days before 2026-09-24) + the closes in backend/data/r231-crypto-vote-sized.json marks", { copy: "joined", days: 300, firstDay: bars.BTC[0].d, lastDay: bars.BTC[bars.BTC.length - 1].d, note: "the cache and the marks agree on 2026-09-24 and 2026-09-25 for every coin (checked here)" });
}
writeJsonAtomic(path.join(OUT, "manifest.json"), { package: "r231-sell-repair-2026-10-12", copiedAt: new Date().toISOString(), copiedAtMT: new Date().toLocaleString("en-US", { timeZone: "America/Denver" }), note: "Frozen copies of recorded files. Written by make-fixtures.cjs; do not edit by hand. Every typed answer in selftest.cjs and every number in NOTES.md is worked from these.", files });
for (const f of files) console.log(`  ${f.name.padEnd(34)} ${String(f.bytes).padStart(7)} bytes  ${f.sha256.slice(0, 12)}  <- ${f.from}`);
console.log(`frozen ${files.length} files -> ${path.relative(REPO, OUT).replace(/\\/g, "/")}`);
