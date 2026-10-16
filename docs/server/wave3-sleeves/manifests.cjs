#!/usr/bin/env node
/**
 * MANIFESTS — one pull manifest per W3 unit (= one own.cjs wave per unit: PER-UNIT cutover), in the format the standing
 * deploy/server/pull-server.cjs reads (pull-manifest-v1; entry kinds in docs/server/wave1-crypto/manifests.cjs). Generated from cell.cjs
 * because JSON is only written by node through backend/lib/atomic-write.js. The home step installs them as deploy/server/manifests/.
 * 2026-10-09 (docs/server/wave3-sleeves).
 *
 *   node docs/server/wave3-sleeves/manifests.cjs --write     (re)write manifests/w3-*.json
 *   node docs/server/wave3-sleeves/manifests.cjs --check     exit 0 when every file equals what this file generates AND every manifest on
 *                                                            disk passes semanticIssues() (the inputs read-only and never pulled back, the
 *                                                            VPS-only records never seeded: literal known answers, not the generator)
 *
 * Per unit:
 *   lock      w3-<x>.flock — every VPS entry of the unit (w3-run.cjs, and the close-arm runner's step) runs under it, so a pull or a
 *             seed never reads the unit mid-run. R295's day-long session holds no lock (its files are written atomically or validated).
 *   steps     the unit's close-chain lines (own.cjs requires each to carry ownedBy: "<unit>" before a cutover).
 *   code      the unit's script (+ its lib/ closure in the VPS view: the staged copies, W2b's lib/schwab-md.js for a schwab unit, + own-check.cjs)
 *             for own.cjs's code parity (a schwab unit cannot cut over before W2b's home step put lib/schwab-md.js at home). Top-level helpers the script loads
 *             (r151-read.js, notify.js, r313 / r328 / r152 ...) are NOT listed: own.cjs would then demand every chain line running them be
 *             tagged, and the reads (r151 read, r311 read) must keep running at home. deploy.cjs checks those files' parity itself.
 *   entries   its own data files (pulled while server-owned; seeded at the cutover) · its w3-run stamps (VPS-only: pulled, never seeded) ·
 *             for close-arm units the VPS runner's status + block record (VPS-only) · json INPUTS (pushed read-only by every pull) ·
 *             CACHES (seed-only static files). jsonl inputs (proposals.jsonl) and the inputs-ready marker go through w3-sync.cjs instead
 *             (pull-server inputs must be json). Switches (*-OFF, *-HALT.json) are never entries and are never synced. Since 2026-10-12
 *             (docs/pause-aware/2026-10-12) deploy.cjs --cutover, and deploy/server/own.cjs itself at the move, REFUSE while a switch the
 *             unit declares (cell.cjs `switches`) is set at home and is not in the server's REAL data dir (a *.json halt must be the same
 *             bytes; the shadow tree never counts; a server that cannot be asked refuses). With the switch on both sides the unit moves
 *             and arrives paused. Before 2026-10-12 nothing checked this. After a cutover a switch is set, and removed, ON THE VPS.
 */
"use strict";
const fs = require("fs"), path = require("path");
const C = require("./cell.cjs");

const DATA = C.TREE.real + "/backend/data", BACKEND = C.TREE.real + "/backend", SHADOW_B = C.TREE.shadow + "/backend";
const RUNNER_STATUS = "close-arm-status-vps.json", RUNNER_BLOCKS = "close-arm-blocks-vps.jsonl";
/** the primary service of a unit: the one own.cjs checks (installed, timer enabled + active) */
const PRIMARY = { "w3-r316": "r316a", "w3-r346": "r346a", "w3-r295": "r295s", "w3-r283": "preopen", "w3-r236": "preopen", "w3-r151": "preopen", "w3-r160": "preopen",
  "w3-r186": "closearm-a", "w3-r218": "closearm-a", "w3-r219": "closearm-a", "w3-r260": "closearm-a", "w3-r191": "after", "w3-r231": "after" };
const svcFile = (s, shadow = false, kind = "service") => `traids-w3${shadow ? "s" : ""}-${s}.${kind}`;

/** the unit's code AS THE VPS RUNS IT: this package's staged copies over home's backend, then W2b's lib/schwab-md.js (cell.cjs viewReader) — so the
 *  list is the same before and after the home step; own.cjs's code parity then compares home's files (the staged copies once applied) */
function codeOf(u) {
  const read = C.textReader(C.viewReader(path.resolve(__dirname, "..", "..", ".."), __dirname));
  const c = C.closure(C.UNITS[u].script, read);
  if (c.missing.length) throw new Error(`${u}: code not found in the VPS view: ${c.missing.join(", ")}`);
  return [C.UNITS[u].script, ...c.files.filter((f) => f.startsWith("lib/")), "own-check.cjs"];
}
function manifestOf(u) {
  const d = C.UNITS[u], steps = Object.values(d.entries).flatMap((e) => (e.chain ? [e.chain, ...(e.chainThen || [])] : []));
  const p = PRIMARY[u], hasShadow = !C.SERVICES[p].noShadow;
  const entries = [
    ...d.files.map((f) => ({ ...f })),
    ...C.stampsOf(u).map((s) => ({ path: s, kind: "json", seed: false })),
    ...(d.entries["close-arm"] && d.entries["close-arm"].runnerKey ? [{ path: RUNNER_STATUS, kind: "json", seed: false }, { path: RUNNER_BLOCKS, kind: "jsonl-prefix", seed: false }] : []),
    ...(d.inputs || []).map((f) => ({ path: f, kind: "json", input: true, pull: false, mode: "0444" })),
    ...(d.caches || []).map((c) => ({ ...c, cache: true, pull: false })),
  ];
  return {
    schema: "pull-manifest-v1", wave: C.waveOf(u), title: `W3 ${d.tests.join("/")} (${d.script}, ${d.group === "schwab" ? "Schwab market-data + Alpaca" : "Alpaca"}; per-unit cutover)`,
    remoteData: DATA, remoteBackend: BACKEND, shadow: { backend: SHADOW_B, data: SHADOW_B + "/data" },
    units: { [u]: {
      lock: C.lockOf(u), steps, group: d.group, tests: d.tests,
      systemd: { service: svcFile(p), timer: svcFile(p, false, "timer"), ...(hasShadow ? { shadowService: svcFile(p, true), shadowTimer: svcFile(p, true, "timer") } : {}) },
      services: C.servicesOf(u).map((s) => svcFile(s)), cadenceHours: 24, code: codeOf(u), entries,
    } },
  };
}
const ALL = Object.fromEntries(C.UNIT_IDS.map((u) => [C.waveOf(u), manifestOf(u)]));
/** the comma list pull-server takes for every W3 wave */
const WAVES = Object.keys(ALL).join(",");

/**
 * SEMANTIC CHECK of the manifest files, independent of manifestOf() above (a generator edited and then consistently regenerated passes a
 * files == generator check). The known answers are the three literal tables below, never read from cell.cjs or from the generator:
 *   inputs    the json files home PUSHES for a unit: each exactly one entry { kind: "json", input: true, pull: false, mode: "0444" } —
 *             read-only on the VPS (nothing there may rewrite home's input) and never pulled back over home's own copy
 *   VPS-only  the unit's w3-run stamps and, for a close-arm unit, the VPS runner's status + block record: each exactly one PULLED entry
 *             with seed: false — only the VPS writes them, so a cutover must never copy home's absent or stale copy over them (an entry
 *             without the field is seeded: pull-server's default is seed: true)
 * and no other entry is marked input, carries a mode, or names a w3-stamp-* / close-arm-*-vps file.
 * files: { wave: parsed manifest | null } -> [{ name, why }] (empty = every manifest right)
 */
const KNOWN_INPUTS = { "w3-r236": ["r236-universe-frozen.json", "r236-best-search.json"], "w3-r151": ["r147-universe.json"], "w3-r260": ["r259-universe.json"] };
const KNOWN_STAMPS = { "w3-r316": ["r316a", "r316b", "after"], "w3-r346": ["r346a", "r346b", "after"], "w3-r295": ["r295s", "r295c-a", "r295c-b", "after"],
  "w3-r283": ["preopen", "after"], "w3-r236": ["preopen", "after"], "w3-r151": ["preopen", "after"], "w3-r160": ["preopen", "after"],
  "w3-r186": ["after"], "w3-r218": ["after"], "w3-r219": ["after"], "w3-r260": ["after"], "w3-r191": ["after"], "w3-r231": ["after"] };
const KNOWN_RUNNER_UNITS = ["w3-r283", "w3-r151", "w3-r160", "w3-r186", "w3-r218", "w3-r219", "w3-r260"];
const KNOWN_RUNNER_FILES = ["close-arm-status-vps.json", "close-arm-blocks-vps.jsonl"];
const isInputRight = (e) => e.kind === "json" && e.input === true && e.pull === false && e.mode === "0444";
const isVpsOnlyRight = (e) => e.seed === false && !e.input && !e.cache && e.pull !== false;
/** the known input names and VPS-only file names of one wave (from the literal tables) */
const knownOf = (wave) => ({ inputs: KNOWN_INPUTS[wave] || [], vpsOnly: [...(KNOWN_STAMPS[wave] || []).map((s) => `w3-stamp-${wave.replace(/^w3-/, "")}-${s}.json`), ...(KNOWN_RUNNER_UNITS.includes(wave) ? KNOWN_RUNNER_FILES : [])] });
function semanticIssues(files) {
  const out = [], bad = (name, why) => out.push({ name, why });
  for (const w of Object.keys(KNOWN_STAMPS)) if (!(w in files)) bad(w, "no manifest file for this wave");
  for (const [wave, m] of Object.entries(files)) {
    if (!KNOWN_STAMPS[wave]) { bad(wave, "not a known W3 wave"); continue; }
    const def = m && m.units && m.units[wave], E = def && Array.isArray(def.entries) ? def.entries : null;
    if (!E) { bad(wave, `no entries for unit ${wave}`); continue; }
    const K = knownOf(wave), show = (h) => JSON.stringify(h).slice(0, 200);
    for (const p of K.inputs) { const h = E.filter((e) => e.path === p); if (h.length !== 1 || !isInputRight(h[0])) bad(wave, `input ${p}: wants exactly one entry { kind: "json", input: true, pull: false, mode: "0444" } (read-only on the VPS, never pulled back): ${show(h)}`); }
    for (const p of K.vpsOnly) { const h = E.filter((e) => e.path === p); if (h.length !== 1 || !isVpsOnlyRight(h[0])) bad(wave, `VPS-only ${p}: wants exactly one pulled entry with seed: false (only the VPS writes it; never seeded from home): ${show(h)}`); }
    for (const e of E) {
      if ((e.input || e.mode != null) && !K.inputs.includes(e.path)) bad(wave, `${e.path} is marked input or carries a mode, but is not a known input of ${wave}`);
      if (/^w3-stamp-|^close-arm-.*-vps\./.test(String(e.path)) && !K.vpsOnly.includes(e.path)) bad(wave, `${e.path} is a VPS-only record ${wave} is not known to write`);
    }
  }
  return out;
}

if (require.main === module) {
  const a = process.argv.slice(2), dir = path.join(__dirname, "manifests");
  if (a.length === 1 && a[0] === "--write") {
    const { writeJsonAtomic } = require(path.join(__dirname, "..", "..", "..", "backend", "lib", "atomic-write.js"));
    fs.mkdirSync(dir, { recursive: true });
    for (const [k, v] of Object.entries(ALL)) { writeJsonAtomic(path.join(dir, k + ".json"), v); console.log("written manifests/" + k + ".json"); }
    process.exitCode = 0;
  } else if (a.length === 1 && a[0] === "--check") {
    let bad = 0;
    for (const [k, v] of Object.entries(ALL)) { let cur = null; try { cur = JSON.parse(fs.readFileSync(path.join(dir, k + ".json"), "utf8")); } catch { cur = null; } const same = cur && JSON.stringify(cur) === JSON.stringify(v); console.log(`${same ? "ok  " : "DIFF"} manifests/${k}.json`); if (!same) bad++; }
    const extra = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !(f.slice(0, -5) in ALL)) : [];
    for (const f of extra) { console.log(`DIFF manifests/${f} (not generated)`); bad++; }
    // semantic: the manifests ON DISK (the home step installs them as deploy/server/manifests/), judged without the generator
    const disk = Object.fromEntries((fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.endsWith(".json")).sort().map((f) => { let j = null; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { j = null; } return [f.slice(0, -5), j]; }));
    const iss = semanticIssues(disk);
    for (const k of [...new Set([...Object.keys(disk), ...iss.map((x) => x.name)])].sort()) {
      const i = iss.filter((x) => x.name === k);
      if (i.length) { bad++; for (const x of i) console.log(`DIFF semantic manifests/${k}.json: ${x.why}`); }
      else { const K = knownOf(k); console.log(`ok   semantic manifests/${k}.json: ${K.inputs.length} input(s) read-only on the VPS (json, pull:false, mode 0444) · ${K.vpsOnly.length} VPS-only record(s) seed:false`); }
    }
    // KNOWN ANSWER (the totals, literal): 13 manifests; 4 inputs; 24 w3-run stamps + 14 VPS runner records (7 close-arm units x 2)
    { const waves = Object.keys(disk), E = (w) => (disk[w] && disk[w].units && disk[w].units[w] && Array.isArray(disk[w].units[w].entries) ? disk[w].units[w].entries : []), count = (fn) => waves.reduce((n, w) => n + E(w).filter(fn).length, 0);
      const nIn = count(isInputRight), nSt = count((e) => /^w3-stamp-/.test(String(e.path)) && isVpsOnlyRight(e)), nRu = count((e) => /^close-arm-.*-vps\./.test(String(e.path)) && isVpsOnlyRight(e));
      if (waves.length === 13 && nIn === 4 && nSt === 24 && nRu === 14) console.log(`ok   semantic: ${waves.length} manifests hold ${nIn} inputs, each read-only on the VPS (mode 0444) and never pulled back, and ${nSt} w3-run stamps + ${nRu} VPS runner records, each seed:false (never seeded from home)`);
      else { bad++; console.log(`DIFF semantic: ${waves.length} manifests, ${nIn} right inputs, ${nSt} right stamps, ${nRu} right runner records (want 13 / 4 / 24 / 14)`); } }
    // ... and the check flags each way such an entry could go wrong: ONE entry of ONE manifest edited at a time, each edit starting from a
    // RIGHT manifest whatever the generator made
    { const clone = (x) => JSON.parse(JSON.stringify(x));
      const right = Object.fromEntries(Object.entries(ALL).map(([w, m]) => { const c = clone(m), K = knownOf(w); for (const e of c.units[w].entries) { if (K.inputs.includes(e.path)) Object.assign(e, { kind: "json", input: true, pull: false, mode: "0444" }); if (K.vpsOnly.includes(e.path)) { e.seed = false; delete e.input; delete e.cache; delete e.pull; } } return [w, c]; }));
      const muts = [["an input pushed writable (mode 0644)", "inputs", (e) => { e.mode = "0644"; }], ["an input without a mode", "inputs", (e) => { delete e.mode; }], ["an input pulled back (pull: true)", "inputs", (e) => { e.pull = true; }],
        ["an input not marked input", "inputs", (e) => { delete e.input; }], ["an input of kind jsonl-prefix", "inputs", (e) => { e.kind = "jsonl-prefix"; }],
        ["a stamp or VPS runner record seeded (seed: true)", "vpsOnly", (e) => { e.seed = true; }], ["its seed field gone (pull-server then seeds it)", "vpsOnly", (e) => { delete e.seed; }], ["it never pulled home (pull: false)", "vpsOnly", (e) => { e.pull = false; }]];
      const missed = []; let nCases = 0;
      for (const [name, kind, fn] of muts) for (const w of Object.keys(right)) for (const p of knownOf(w)[kind]) {
        nCases++; const c = clone(right[w]), e = c.units[w].entries.find((x) => x.path === p); if (!e) { missed.push(`${name}: ${w} has no ${p}`); continue; } fn(e);
        if (!semanticIssues({ ...right, [w]: c }).some((x) => x.name === w && x.why.includes(p))) missed.push(`${name}: ${w} ${p}`);
      }
      if (!missed.length && semanticIssues(right).length === 0 && nCases === 5 * 4 + 3 * 38) console.log(`ok   semantic: each of ${nCases} single-entry edits is flagged (${muts.map(([n]) => n).join(" / ")})`);
      else { bad++; console.log(`DIFF semantic: an edited entry was NOT flagged (${missed.slice(0, 6).join("; ") || `${nCases} cases, want ${5 * 4 + 3 * 38}`})`); } }
    process.exitCode = bad ? 1 : 0;
  } else { console.log("usage: node manifests.cjs --write | --check"); process.exitCode = 2; }
}
module.exports = { ALL, WAVES, PRIMARY, svcFile, manifestOf, semanticIssues, knownOf, KNOWN_INPUTS, KNOWN_STAMPS, KNOWN_RUNNER_UNITS, KNOWN_RUNNER_FILES, RUNNER_STATUS, RUNNER_BLOCKS, DATA, BACKEND, SHADOW_B };
