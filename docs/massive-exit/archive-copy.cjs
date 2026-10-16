#!/usr/bin/env node
"use strict";
/**
 * MASSIVE EXIT — off-repo copy of the Massive-sourced futures store (2026-10-02).
 *
 * backend/data/training/ is gitignored and automation/backup.cjs excludes every directory named "training" from BOTH tiers, so the
 * local futures store (lib/futures-bars.js) had no second copy. Its Massive-sourced 1m bars (2024-09-27..2026-10-02) cannot be
 * re-downloaded once the subscription ends. This writes ONE gzip per root (JSONL, one bar per line, ascending) plus the contract map,
 * the own-contract files and the manifest, with sha256 + row counts, into the established backup folder:
 *   %USERPROFILE%\Documents\TRAIDS-backups\futures-1m-massive-archive-<date>\
 * (backup.cjs's rotation only matches traids-YYYY-MM-DD.zip / traids-FULL-YYYY-MM-DD.zip, so this folder is never rotated away.)
 * Then it re-reads every gzip and checks the row count and the first/last bar against the store. Read-only on the repo.
 *
 *   node "docs/massive-exit/archive-copy.cjs" [--dest <dir>]
 */
const fs = require("fs"), path = require("path"), zlib = require("zlib"), crypto = require("crypto");
const FB = require("../../backend/lib/futures-bars.js");
const i = process.argv.indexOf("--dest");
const DEST = i >= 0 ? process.argv[i + 1] : path.join(process.env.USERPROFILE || "C:\\Users\\joshc", "Documents", "TRAIDS-backups", `futures-1m-massive-archive-${new Date().toISOString().slice(0, 10)}`);
fs.mkdirSync(DEST, { recursive: true });
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const index = { spec: "futures-1m-archive-copy-v1", madeAt: new Date().toISOString(), from: FB.STORE_DIR, files: {} };
for (const root of FB.storeRoots()) {
  const lines = [];
  for (const ym of FB.listMonths(root)) for (const b of FB.readMonth(root, ym).bars) lines.push(JSON.stringify(b));
  const gz = zlib.gzipSync(Buffer.from(lines.join("\n") + "\n"), { level: 9 });
  const f = `${root}-1m.jsonl.gz`; fs.writeFileSync(path.join(DEST, f), gz);
  const back = zlib.gunzipSync(fs.readFileSync(path.join(DEST, f))).toString("utf8").trim().split("\n");
  const ok = back.length === lines.length && back[0] === lines[0] && back[back.length - 1] === lines[lines.length - 1];
  index.files[f] = { rows: lines.length, first: JSON.parse(lines[0]).date, last: JSON.parse(lines[lines.length - 1]).date + " " + JSON.parse(lines[lines.length - 1]).time, bytes: gz.length, sha256: sha(gz), verified: ok };
  console.log(`${f}: ${lines.length} rows, ${(gz.length / 1e6).toFixed(1)} MB, verified ${ok}`);
  if (!ok) process.exitCode = 1;
  const cf = path.join(FB.STORE_DIR, root, "contracts.json");
  if (fs.existsSync(cf)) { const buf = fs.readFileSync(cf); fs.writeFileSync(path.join(DEST, `${root}-contracts.json`), buf); index.files[`${root}-contracts.json`] = { bytes: buf.length, sha256: sha(buf) }; }
}
const own = path.join(FB.STORE_DIR, "contracts");
if (fs.existsSync(own)) for (const f of fs.readdirSync(own)) { const buf = zlib.gzipSync(fs.readFileSync(path.join(own, f)), { level: 9 }); fs.writeFileSync(path.join(DEST, `own-${f}.gz`), buf); index.files[`own-${f}.gz`] = { bytes: buf.length, sha256: sha(buf) }; }
fs.copyFileSync(path.join(FB.STORE_DIR, "manifest.json"), path.join(DEST, "manifest.json"));
fs.writeFileSync(path.join(DEST, "INDEX.json"), JSON.stringify(index, null, 1));
console.log(`copied to ${DEST}`);
