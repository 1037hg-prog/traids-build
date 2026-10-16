"use strict";
/**
 * OVERLAY PRELOAD (pause-switches package, 2026-10-12) — serves PATCHED text in place of named real files, to this process and (through
 * NODE_OPTIONS, which child node processes inherit) to every node process it starts. NOTHING IS WRITTEN to the repo: the real files stay as
 * they are. Used only by this package's selftest and verify-live, to run other packages' existing selftests on the staged text.
 *
 *   PAUSE_SWITCHES_OVERLAY = a JSON file { "<absolute path, lower-cased>": "<file holding the text to serve instead>" }
 *
 * What is served: require() of a mapped .js / .cjs file compiles the patched text under the REAL file name (so __dirname, relative requires
 * and require.main behave as for the real file); fs.readFileSync / fs.promises.readFile of a mapped path return the patched bytes; and
 * fs.copyFileSync / fs.promises.copyFile FROM a mapped path write the patched bytes (a selftest that copies a file into a temp tree gets
 * the same text a reader gets). Not served: `node --check <file>` (it reads the file itself) and anything that is not node.
 * Without the variable, or with a map that cannot be read, this file does nothing at all.
 */
const fs = require("fs"), path = require("path"), Module = require("module");
let MAP = null;
try { if (process.env.PAUSE_SWITCHES_OVERLAY) MAP = JSON.parse(fs.readFileSync(process.env.PAUSE_SWITCHES_OVERLAY, "utf8")); } catch { MAP = null; }
if (MAP && Object.keys(MAP).length) {
  const realRead = fs.readFileSync, realCopy = fs.copyFileSync, realWrite = fs.writeFileSync;
  const key = (p) => { try { return typeof p === "string" || Buffer.isBuffer(p) ? path.resolve(String(p)).toLowerCase() : p instanceof URL ? path.resolve(require("url").fileURLToPath(p)).toLowerCase() : null; } catch { return null; } };
  const hit = (p) => { const k = key(p); return k && Object.prototype.hasOwnProperty.call(MAP, k) ? MAP[k] : null; };
  const enc = (o) => (typeof o === "string" ? o : o && typeof o === "object" ? o.encoding || null : null);
  fs.readFileSync = function (p, o) { const to = hit(p); if (!to) return realRead.apply(fs, arguments); const b = realRead.call(fs, to); const e = enc(o); return e ? b.toString(e) : b; };
  const realReadP = fs.promises.readFile.bind(fs.promises);
  fs.promises.readFile = async (p, o) => { const to = hit(p); if (!to) return realReadP(p, o); const b = realRead.call(fs, to); const e = enc(o); return e ? b.toString(e) : b; };
  fs.copyFileSync = function (src, dest) { const to = hit(src); if (!to) return realCopy.apply(fs, arguments); realWrite.call(fs, dest, realRead.call(fs, to)); };
  const realCopyP = fs.promises.copyFile.bind(fs.promises);
  fs.promises.copyFile = async (src, dest, mode) => { const to = hit(src); if (!to) return realCopyP(src, dest, mode); realWrite.call(fs, dest, realRead.call(fs, to)); };
  for (const ext of [".js", ".cjs"]) {
    const orig = Module._extensions[ext] || Module._extensions[".js"];
    Module._extensions[ext] = function (module, filename) {
      const to = hit(filename); if (!to) return orig(module, filename);
      let text = realRead.call(fs, to, "utf8"); if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      module._compile(text, filename);
    };
  }
  globalThis.__PAUSE_SWITCHES_OVERLAY = Object.keys(MAP).length;
}
