"use strict";
// Loads a backend .js file as CommonJS whatever the nearest package.json says. The cloud copy's root package.json is
// "type": "module" and has no backend/package.json, so a plain require() of a backend .js fails there; at home both work.
// Nested relative requires inside the loaded file resolve through the same helper.
const fs = require("fs"), path = require("path"), Module = require("module");
const cache = new Map();
function loadCjs(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const m = new Module(file, null); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file)); cache.set(file, m);
  const real = Module.createRequire(file);
  m.require = (id) => (/^\.{1,2}\//.test(id) || path.isAbsolute(id) ? (/\.(js|cjs)$/.test(id) ? loadCjs(path.resolve(path.dirname(file), id)) : real(id)) : real(id));
  const req = (id) => m.require(id); req.resolve = real.resolve; req.main = undefined;
  const src = fs.readFileSync(file, "utf8").replace(/^#!.*/, "");
  const fn = new Function("exports", "require", "module", "__filename", "__dirname", src);
  try { fn.call(m.exports, m.exports, req, m, file, path.dirname(file)); } catch (e) { cache.delete(file); throw e; }
  m.loaded = true; return m.exports;
}
module.exports = { loadCjs };
