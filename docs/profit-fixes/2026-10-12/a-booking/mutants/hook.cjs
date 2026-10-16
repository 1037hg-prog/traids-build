"use strict";
/**
 * PROFIT FIXES A — THE MUTATION HOOK. 2026-10-12 (docs/profit-fixes/2026-10-12/a-booking/mutants).
 * Loaded with `node -r` in front of selftest.cjs by mutants/run.cjs, and by nothing else.
 *
 * It changes ONE piece of text of ONE file of this package AS THE SELFTEST'S OWN PROCESS READS IT. Nothing on disk is changed: no
 * file of the package, no live file, no copy. The selftest builds every patched script it runs from the staged edits it has read, so
 * a change to a staged edit reaches the sandboxed runs; a change to one of the package's own modules reaches the functions the
 * selftest calls. Child processes do not inherit the hook (it is passed with -r, not through the environment).
 *
 *   PFA_MUTANT        JSON: { id, file (relative to the package), find, replace }
 *   PFA_MUTANT_MARK   a file this hook writes at exit: how many times the change was made (0 = the file was never read: not a result)
 *
 * mutants/run.cjs has already checked that `find` occurs exactly once in the file on disk and not at all once replaced; so a text
 * that no longer holds `find` has already been changed by this hook (the module loader and fs can both hand the same file over).
 */
const fs = require("fs"), path = require("path"), Module = require("module");
const SPEC = JSON.parse(process.env.PFA_MUTANT || "null");
if (!SPEC || !SPEC.file || typeof SPEC.find !== "string" || typeof SPEC.replace !== "string") throw new Error("mutation hook: PFA_MUTANT is missing or incomplete");
const TARGET = path.join(path.resolve(__dirname, ".."), ...SPEC.file.split("/")).toLowerCase();
const isTarget = (f) => typeof f === "string" && path.resolve(f).toLowerCase() === TARGET;
let made = 0;
function mutate(text) {
  const n = text.split(SPEC.find).length - 1;
  if (n === 0) return text;   // already changed (see above)
  if (n !== 1) throw new Error(`mutation hook: the text of mutant ${SPEC.id} occurs ${n}x in ${SPEC.file} as read (it must occur exactly once)`);
  made++;
  return text.replace(SPEC.find, () => SPEC.replace);
}
const realRead = fs.readFileSync;
fs.readFileSync = function (f, ...rest) {
  const out = realRead.call(this, f, ...rest);
  if (!isTarget(f)) return out;
  return typeof out === "string" ? mutate(out) : Buffer.from(mutate(out.toString("utf8")), "utf8");
};
const realCompile = Module.prototype._compile;
Module.prototype._compile = function (content, filename) { return realCompile.call(this, isTarget(filename) ? mutate(String(content)) : content, filename); };
process.on("exit", () => { try { if (process.env.PFA_MUTANT_MARK) fs.writeFileSync(process.env.PFA_MUTANT_MARK, String(made)); } catch {} });
