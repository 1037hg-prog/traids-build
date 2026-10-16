"use strict";
/**
 * WORST-DAY SEALED FORECAST LEDGER — THE MUTATION HOOK. Loaded with `node -r` in front of selftest.cjs by mutants/run.cjs, and by
 * nothing else.
 *
 * It changes ONE piece of text of ONE file of this package AS THE SELFTEST'S OWN PROCESS READS IT. Nothing on disk is changed: no
 * staged file, no live file, no copy. selftest.cjs builds its sandbox by reading each staged file with fs.readFileSync and writing
 * it into a throw-away tree, so a change made here lands in the sandbox the staged code is then run from.
 *
 *   WDS_MUTANT       JSON: { id, file (relative to the package), find, replace }
 *   WDS_MUTANT_MARK  a file this hook writes at exit: how many times the change was made (0 = the file was never read: not a result)
 *
 * mutants/run.cjs has already checked that `find` occurs exactly once in the file on disk and not at all once replaced, so a text
 * that no longer holds `find` has already been changed by this hook (a file can be read more than once in a run).
 */
const fs = require("fs"), path = require("path"), Module = require("module");
const SPEC = JSON.parse(process.env.WDS_MUTANT || "null");
if (!SPEC || !SPEC.file || typeof SPEC.find !== "string" || typeof SPEC.replace !== "string") throw new Error("mutation hook: WDS_MUTANT is missing or incomplete");
const TARGET = path.join(path.resolve(__dirname, ".."), ...SPEC.file.split("/")).toLowerCase();
const isTarget = (f) => typeof f === "string" && path.resolve(f).toLowerCase() === TARGET;
let made = 0;
function mutate(text) {
  const n = text.split(SPEC.find).length - 1;
  if (n === 0) return text;                       // already changed by this hook (see above)
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
process.on("exit", () => { try { if (process.env.WDS_MUTANT_MARK) fs.writeFileSync(process.env.WDS_MUTANT_MARK, String(made)); } catch { /* the mark is not the work */ } });
