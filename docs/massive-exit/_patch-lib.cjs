"use strict";
/**
 * Shared patch engine for the Massive-exit pending files (2026-10-02).
 *
 * A patch script declares exact-string edits against a LIVE file. By default it writes <file>.pending-massive<ext> beside the live
 * file and syntax-checks it; with --apply it writes over the live file instead — refused inside the operator's no-touch window
 * (weekdays 06:45-14:15 America/Denver, read from node's clock), refused inside the close-chain window (weekdays 14:15-15:30 MT, no
 * override), and refused when the live file already carries the marker.
 *
 *   edit forms:  [find, replace]                exact string, must occur exactly once
 *                ["@fn", header, replace]       replace the whole function starting at `header` (brace-matched)
 * Line endings: edits are written with \n; a CRLF file is normalised for matching and restored on write.
 */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const MARK = "2026-10-02 Massive exit";
const REPO = path.join(__dirname, "..", "..");

function denverNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { wd: p.weekday, hm: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` };
}
function swapFunction(src, header, text) {
  const i = src.indexOf(header);
  if (i < 0 || src.indexOf(header, i + 1) >= 0) throw new Error(`function header ${i < 0 ? "missing" : "ambiguous"}: ${header}`);
  let depth = 0;
  for (let k = src.indexOf("{", i + header.length - 1); k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) { let end = k + 1; if (src[end] === "\n") end++; return src.slice(0, i) + text + src.slice(end); }
  }
  throw new Error(`unbalanced braces after ${header}`);
}

function run({ live, edits, note }) {
  const argv = process.argv.slice(2), APPLY = argv.includes("--apply"), CHECK = argv.includes("--check");
  const liveAbs = path.join(REPO, live);
  const ext = path.extname(liveAbs), pendingAbs = liveAbs.slice(0, -ext.length) + ".pending-massive" + ext;
  const raw = fs.readFileSync(liveAbs, "utf8");
  if (raw.includes(MARK)) { console.error(`${live} already carries "${MARK}" — nothing to do`); process.exit(APPLY ? 1 : 0); }
  const crlf = raw.includes("\r\n");
  let s = crlf ? raw.replace(/\r\n/g, "\n") : raw;
  for (const e of edits) {
    if (e[0] === "@fn") { s = swapFunction(s, e[1], e[2]); continue; }
    const [find, repl] = e, n = s.split(find).length - 1;
    if (n !== 1) { console.error(`REFUSED: anchor found ${n}x in ${live} (the live file changed?):\n  ${find.slice(0, 160)}`); process.exit(1); }
    s = s.replace(find, () => repl);
  }
  if (!s.includes(MARK)) { console.error("REFUSED: the patched text does not carry the marker — patch definition error"); process.exit(1); }
  if (crlf) s = s.replace(/\n/g, "\r\n");
  if (CHECK) { console.log(`OK ${live}: ${edits.length} edit(s) match`); return; }
  let out = pendingAbs;
  if (APPLY) {
    const t = denverNow();
    // Two refusal windows on weekdays (America/Denver, node's clock): the operator's 06:45-14:15 no-touch window AND the close chain's
    // 14:15-15:30 window (repair 2026-10-02: the chain runs ~14:15-15:30 MT and loads these live files; patching one mid-chain mixes
    // two versions in one night). --force-window overrides the no-touch window only, never the chain window.
    const weekday = !["Sat", "Sun"].includes(t.wd);
    if (weekday && t.hm >= "14:15" && t.hm < "15:30") { console.error(`REFUSED: ${t.wd} ${t.hm} MT is inside the close-chain window (14:15-15:30 MT) — the chain may be loading ${live}`); process.exit(2); }
    if (weekday && t.hm >= "06:45" && t.hm < "14:15" && !argv.includes("--force-window")) { console.error(`REFUSED: ${t.wd} ${t.hm} MT is inside the 06:45-14:15 no-touch window`); process.exit(2); }
    const bak = path.join(__dirname, "backup", path.basename(liveAbs) + ".pre-massive-exit");
    fs.mkdirSync(path.dirname(bak), { recursive: true }); fs.writeFileSync(bak, raw);
    out = liveAbs;
  }
  const tmp = out.slice(0, -ext.length) + ".tmp-" + process.pid + ext;   // keep the extension: node -c refuses unknown ones
  fs.writeFileSync(tmp, s);
  const chk = ext === ".jsx" ? { status: 0 } : spawnSync(process.execPath, ["-c", tmp], { encoding: "utf8" });   // JSX: the deploy build is the check
  if (chk.status !== 0) { fs.unlinkSync(tmp); console.error(`REFUSED: node -c failed on the patched ${live}:\n${chk.stderr}`); process.exit(1); }
  fs.renameSync(tmp, out);
  console.log(`${APPLY ? "APPLIED over" : "wrote"} ${path.relative(REPO, out)} (${edits.length} edit(s)${APPLY ? `; original saved to docs/massive-exit/backup/` : ""})${note ? "\n" + note : ""}`);
}
module.exports = { run, MARK };
