"use strict";
/**
 * AW — the repository's own writeJsonAtomic (backend/lib/atomic-write.js), for this package's scripts. In the cloud clean copy backend/ has no
 * package.json, so the root "type": "module" makes require() of that .js file fail; then the SAME bytes are loaded from a temp copy marked
 * commonjs (the sha256 of the file used is returned). At home the direct require works and is used.
 */
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
function loadAtomicWrite(repo) {
  const f = path.join(repo, "backend", "lib", "atomic-write.js"), sha = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  try { return { writeJsonAtomic: require(f).writeJsonAtomic, from: f, sha }; }
  catch (e) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "aw-")); fs.copyFileSync(f, path.join(d, "atomic-write.js")); fs.writeFileSync(path.join(d, "package.json"), '{"type":"commonjs"}');
    return { writeJsonAtomic: require(path.join(d, "atomic-write.js")).writeJsonAtomic, from: `${f} (via a commonjs temp copy: ${e.code || "require failed"})`, sha };
  }
}
module.exports = { loadAtomicWrite };
