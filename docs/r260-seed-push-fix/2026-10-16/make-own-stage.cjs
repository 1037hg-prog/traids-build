#!/usr/bin/env node
/**
 * MAKE-OWN-STAGE — run AT HOME. own.cjs (deploy/server/own.cjs and its twin docs/server/wave1-crypto/own.cjs) is NOT in the cloud clean copy,
 * so this package cannot carry a base/ or staged/ copy of it, and does not reconstruct it. This tool builds that part of the package from home's
 * own bytes, changing ONLY the lines the operator names:
 *   on each named line   PS.pushRemote(  ->  PS.pushChunked(        (the seed push: chunked under the cut, each chunk read back by sha256)
 *                        PS.remoteShas(  ->  PS.remoteShasChunked(  (a sha read over a list that can grow)
 *   node docs/r260-seed-push-fix/2026-10-16/make-own-stage.cjs --plan [--repo <dir>]
 *        lists every line of own.cjs that calls PS.pushRemote( or PS.remoteShas(, with its number and its neighbours; changes nothing
 *   node docs/r260-seed-push-fix/2026-10-16/make-own-stage.cjs --write --lines 412,431 [--repo <dir>]
 *        writes base/<twin> (home's bytes) and staged/<twin> (those lines changed) for BOTH twins; deploy.cjs then applies them with pull-server
 * REFUSED: the twins differ (W1's home patch judges them byte for byte) · a named line calls neither · the staged pull-server lacks pushChunked
 * · base/ already holds a DIFFERENT copy of own.cjs (home's own.cjs changed since the stage was made: remove base/ and staged/ own.cjs first).
 */
"use strict";
const fs = require("fs"), path = require("path");
const PKG = __dirname, TWINS = ["deploy/server/own.cjs", "docs/server/wave1-crypto/own.cjs"];
const CALL = /\bPS\.(pushRemote|remoteShas)\(/g, SWAP = { pushRemote: "pushChunked", remoteShas: "remoteShasChunked" };
const findRepo = (from) => { for (let d = from; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, "AGENTS.md")) && fs.existsSync(path.join(d, "backend"))) return d; if (path.dirname(d) === d) return null; } };

function load(repo) {
  const bufs = TWINS.map((t) => { try { return fs.readFileSync(path.join(repo, t)); } catch { return null; } });
  if (bufs.some((b) => !b)) throw new Error(`own.cjs is missing at home: ${TWINS.filter((t, i) => !bufs[i]).join(", ")}`);
  if (!bufs[0].equals(bufs[1])) throw new Error(`${TWINS[0]} and ${TWINS[1]} differ — the twins must be byte-equal before a stage is made`);
  return bufs[0];
}
/** every line calling PS.pushRemote( / PS.remoteShas( -> [{ n (1-based), text, calls: [name] }] */
function callsOf(text) {
  return text.split("\n").map((l, i) => ({ n: i + 1, text: l, calls: [...l.matchAll(CALL)].map((m) => m[1]) })).filter((x) => x.calls.length);
}
/** text with exactly the named lines changed -> { text, changed: [{ n, from, to }] }; throws on a line that calls neither */
function swapLines(text, lines) {
  const L = text.split("\n"), changed = [];
  for (const n of lines) {
    const i = n - 1; if (!(i >= 0 && i < L.length)) throw new Error(`line ${n} is outside own.cjs (${L.length} lines)`);
    if (!CALL.test(L[i])) throw new Error(`line ${n} calls neither PS.pushRemote( nor PS.remoteShas(: ${JSON.stringify(L[i].trim().slice(0, 120))}`);
    CALL.lastIndex = 0;
    const to = L[i].replace(CALL, (m, k) => `PS.${SWAP[k]}(`); CALL.lastIndex = 0;
    changed.push({ n, from: L[i], to }); L[i] = to;
  }
  return { text: L.join("\n"), changed };
}
function main(argv, log = console.log) {
  const a = argv.slice(), ri = a.indexOf("--repo"), repo = ri >= 0 ? path.resolve(a[ri + 1]) : findRepo(PKG);
  if (ri >= 0) a.splice(ri, 2);
  const li = a.indexOf("--lines"), lines = li >= 0 ? String(a[li + 1] || "").split(",").filter(Boolean).map(Number) : [];
  if (li >= 0) a.splice(li, 2);
  if (!repo || a.length !== 1 || !["--plan", "--write"].includes(a[0]) || (a[0] === "--write" && (!lines.length || !lines.every((n) => Number.isInteger(n) && n > 0)))) { log("usage: make-own-stage.cjs --plan | --write --lines <n>[,<n>] [--repo <dir>]"); return 2; }
  let buf; try { buf = load(repo); } catch (e) { log("REFUSED: " + e.message); return 1; }
  const text = buf.toString("utf8"), found = callsOf(text);
  if (a[0] === "--plan") {
    if (!found.length) { log("own.cjs calls neither PS.pushRemote( nor PS.remoteShas( — nothing to stage (it must push its seeds another way: read it)"); return 1; }
    const L = text.split("\n");
    for (const f of found) { log(`line ${f.n}: ${f.calls.join(", ")}`); for (let k = Math.max(0, f.n - 3); k < Math.min(L.length, f.n + 2); k++) log(`  ${String(k + 1).padStart(5)}${k + 1 === f.n ? " >" : "  "} ${L[k].slice(0, 200)}`); }
    log(`PLAN: name the SEED push line(s) (and any sha read over the seed list) with --write --lines; nothing written`); return 0;
  }
  const ps = fs.readFileSync(path.join(PKG, "staged", "docs", "server", "wave1-crypto", "pull-server.cjs"), "utf8");
  if (!/function pushChunked\(/.test(ps) || !/function remoteShasChunked\(/.test(ps)) { log("REFUSED: the staged pull-server has no pushChunked / remoteShasChunked"); return 1; }
  let out; try { out = swapLines(text, lines); } catch (e) { log("REFUSED: " + e.message); return 1; }
  for (const t of TWINS) { const b = path.join(PKG, "base", t); if (fs.existsSync(b) && !fs.readFileSync(b).equals(buf)) { log(`REFUSED: base/${t} holds a different own.cjs — home's own.cjs changed since the stage was made; remove base/ and staged/ own.cjs, then run again`); return 1; } }
  for (const t of TWINS) {
    for (const [dir, data] of [["base", buf], ["staged", Buffer.from(out.text, "utf8")]]) { const f = path.join(PKG, dir, t); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); }
  }
  for (const c of out.changed) log(`line ${c.n}:\n  - ${c.from.trim().slice(0, 200)}\n  + ${c.to.trim().slice(0, 200)}`);
  log(`WRITTEN: base/ and staged/ for ${TWINS.join(" and ")} (${out.changed.length} line(s) changed). Next: node deploy.cjs --plan`); return 0;
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { TWINS, callsOf, swapLines, main };
