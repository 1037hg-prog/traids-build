"use strict";
/**
 * PROFIT FIXES B — preload for mutants.cjs ONLY (node -r harness/mutate-lib.cjs selftest.cjs). In that one process the package's lib.cjs is
 * compiled with ONE fragment of its text replaced (PFB_LIB_MUTANT names a JSON file { from, to }); the file on disk is not touched, and the
 * selftest's child processes load the real lib.cjs. It asks one question: does the selftest notice a broken apply / rollback engine?
 * Never loaded by a live runner, nor by deploy.cjs, rollback.cjs or verify-live.cjs.
 */
const fs = require("fs"), path = require("path"), Module = require("module");
const spec = JSON.parse(fs.readFileSync(process.env.PFB_LIB_MUTANT, "utf8")), target = path.join(__dirname, "..", "lib.cjs"), compile = Module.prototype._compile;
Module.prototype._compile = function (content, filename) {
  if (path.resolve(filename) === target) { const n = content.split(spec.from).length - 1; if (n !== 1) throw new Error(`lib mutant: its fragment is in lib.cjs ${n} times (need 1)`); content = content.replace(spec.from, () => spec.to); }
  return compile.call(this, content, filename);
};
