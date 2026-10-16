"use strict";
// Finds the repo root by walking up from this folder (to the folder holding AGENTS.md and backend/lib/null-bar.js).
const fs = require("fs"), path = require("path");
function root() {
  let d = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, "AGENTS.md")) && fs.existsSync(path.join(d, "backend", "lib", "null-bar.js"))) return d;
    const up = path.dirname(d); if (up === d) break; d = up;
  }
  throw new Error("cannot find the repo root above " + __dirname);
}
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
function tOf(a) { const n = a.length; let mu = 0; for (const x of a) mu += x; mu /= n; let v = 0; for (const x of a) v += (x - mu) ** 2; v /= (n - 1); return mu / Math.sqrt(v / n); }
module.exports = { ROOT: root(), mulberry, tOf };
