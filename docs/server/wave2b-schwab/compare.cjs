#!/usr/bin/env node
/**
 * COMPARE — the 1-session dry period of W2b: the SHADOW's records (VPS, /home/traids/w2b-shadow/backend/data, written by
 * traids-gex-shadow / traids-flow-shadow with the market-data app's token while home owns the units) against home's records of the same
 * ET day. Read-only on both hosts (one ssh tar of the day's 7 shadow files). 2026-10-09 (docs/server/wave2b-schwab). Run it before
 * --cutover (NOTES.md).
 *
 *   node docs/server/wave2b-schwab/compare.cjs [YYYY-MM-DD]   default: the last trading day whose close slot (15:55 ET) has passed
 *   node docs/server/wave2b-schwab/compare.cjs --selftest
 *
 * GEX, per slot (open, close) and symbol (SPX, SPY, QQQ): the shadow must hold the file home holds, taken inside the slot (open
 *   09:40-10:15, close 15:30-15:55 ET). Open interest is the prior session's settled value — the same number on both hosts the same day —
 *   so on the contracts both hold, >= 99% must carry the SAME open interest; the contract sets must overlap >= 90% (Jaccard; the strike
 *   window follows spot, so edges differ by a few contracts); spot within 1%. Gamma / IV / bid / ask differ by the minute and are not judged.
 * OPTIONS FLOW (R272's record): the shadow's file complete; the SAME names attempted as home's (names + errors: the population, from
 *   data/r147-earnings); its snapshot inside 15:30-15:55 ET (etMinutes); on the names both recorded, >= 99% of the common contracts with
 *   the same open interest, the traded-contract sets overlapping >= 80%, and the total traded contracts within 15% of home's (volume is
 *   the day's total "to that moment": a minute or two apart, close but not equal).
 * Exit 0 SAME · 1 DIFFER (each named) · 2 NOT YET comparable (the shadow or home holds nothing for the day), or a file unreadable.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", "..");
const PS = require(path.join(REPO, "deploy", "server", "pull-server.cjs")), WM = require(path.join(HERE, "deploy-server", "w2b-manifest.cjs"));
const SBD = "/home/traids/w2b-shadow/backend/data";
const SLOTS = { open: [9 * 60 + 40, 10 * 60 + 15], close: [15 * 60 + 30, 15 * 60 + 55] }, SYMS = ["SPX", "SPY", "QQQ"];
const TH = { gexJaccard: 0.9, oiEqual: 0.99, spotPct: 0.01, flowJaccard: 0.8, flowTotalPct: 0.15 };
const etMinOf = (iso) => { const t = Date.parse(iso); if (!Number.isFinite(t)) return null; const p = WM.etParts(t); return p.mins; };
const pct = (x) => (x * 100).toFixed(1) + "%";
const hm = (m) => (m == null ? "?" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
/** contracts keyed by occ -> { oi } from rows; oiCol: gex rows [occ, exp, right, strike, oi, ...], flow rows [occ, exp, right, strike, vol, oi, ...] */
const keyed = (rows, oiCol) => new Map((rows || []).filter((r) => Array.isArray(r) && r[0]).map((r) => [r[0], { oi: r[oiCol] }]));
function overlap(a, b) {
  const common = [...a.keys()].filter((k) => b.has(k)), union = new Set([...a.keys(), ...b.keys()]).size;
  const same = common.filter((k) => a.get(k).oi === b.get(k).oi).length;
  return { common: common.length, union, jaccard: union ? common.length / union : 1, oiEqual: common.length ? same / common.length : 1 };
}
/** pure: home's and the shadow's gex record of one slot / symbol -> { diffs, info } */
function compareGex(home, shadow, slot, sym) {
  const diffs = [], info = [], tag = `gex ${slot} ${sym}`;
  if (!home && !shadow) return { diffs, info: [`${tag}: neither host recorded it`] };
  if (!shadow) return { diffs: [`${tag}: home recorded it, the SHADOW did not (a missed slot on the VPS)`], info };
  if (!home) return { diffs, info: [`${tag}: the shadow recorded it, home did not (home missed the slot)`] };
  const m = etMinOf(shadow.at), [lo, hi] = SLOTS[slot];
  if (!(m >= lo && m < hi)) diffs.push(`${tag}: the shadow's record was taken at ${hm(m)} ET, outside the ${slot} slot ${hm(lo)}-${hm(hi)} ET`);
  if (shadow.slot !== slot || (shadow.date && home.date && shadow.date !== home.date)) diffs.push(`${tag}: the shadow's record says slot ${shadow.slot} / date ${shadow.date}`);
  const o = overlap(keyed(home.rows, 4), keyed(shadow.rows, 4));
  if (o.jaccard < TH.gexJaccard) diffs.push(`${tag}: the contract sets overlap ${pct(o.jaccard)} (< ${pct(TH.gexJaccard)}): home ${(home.rows || []).length}, shadow ${(shadow.rows || []).length}`);
  if (o.oiEqual < TH.oiEqual) diffs.push(`${tag}: open interest equal on only ${pct(o.oiEqual)} of the ${o.common} common contracts (< ${pct(TH.oiEqual)}) — the prior session's OI is the same number on both hosts`);
  if (home.spot && shadow.spot && Math.abs(shadow.spot / home.spot - 1) > TH.spotPct) diffs.push(`${tag}: spot ${shadow.spot} vs home ${home.spot} (> 1% apart)`);
  info.push(`${tag}: home ${(home.rows || []).length} contracts at ${hm(etMinOf(home.at))} ET · shadow ${(shadow.rows || []).length} at ${hm(m)} ET · overlap ${pct(o.jaccard)} · OI equal ${pct(o.oiEqual)} of ${o.common} · total GEX ${home.totalGexM}M vs ${shadow.totalGexM}M (minutes apart: not judged)`);
  return { diffs, info };
}
const attempted = (d) => [...new Set([...Object.keys((d && d.names) || {}), ...Object.keys((d && d.errors) || {})])].sort();
/** pure: home's and the shadow's options-flow record of the day -> { diffs, info } */
function compareFlow(home, shadow) {
  const diffs = [], info = [];
  if (!home && !shadow) return { diffs, info: ["options-flow: neither host recorded the day"] };
  if (!shadow) return { diffs: ["options-flow: home recorded the day, the SHADOW did not (a missed slot on the VPS)"], info };
  if (!home) return { diffs, info: ["options-flow: the shadow recorded the day, home did not"] };
  if (shadow.complete !== true) diffs.push(`options-flow: the shadow's record is INCOMPLETE (coverage ${shadow.coverage}; errors: ${Object.keys(shadow.errors || {}).slice(0, 6).join(" ")})`);
  if (home.complete !== true) info.push(`options-flow: home's own record is incomplete (coverage ${home.coverage})`);
  const hn = attempted(home), sn = attempted(shadow);
  if (JSON.stringify(hn) !== JSON.stringify(sn)) { const a = hn.filter((n) => !sn.includes(n)), b = sn.filter((n) => !hn.includes(n)); diffs.push(`options-flow: another POPULATION — ${a.length} name(s) home attempted that the shadow did not (${a.slice(0, 6).join(" ")}), ${b.length} the other way (${b.slice(0, 6).join(" ")}) — data/r147-earnings differs between the hosts`); }
  if (!(shadow.etMinutes >= SLOTS.close[0] && shadow.etMinutes <= 15 * 60 + 55)) diffs.push(`options-flow: the shadow's snapshot at ${hm(shadow.etMinutes)} ET is outside R272's 15:30-15:55 ET`);
  let common = 0, union = 0, same = 0, ht = 0, st = 0;
  for (const n of Object.keys(home.names || {}).filter((x) => shadow.names && shadow.names[x])) {
    const a = keyed(home.names[n].rows, 5), b = keyed(shadow.names[n].rows, 5), o = overlap(a, b);
    common += o.common; union += o.union; same += Math.round(o.oiEqual * o.common); ht += a.size; st += b.size;
  }
  const jac = union ? common / union : 1, oiEq = common ? same / common : 1, ratio = ht ? st / ht : 1;
  if (oiEq < TH.oiEqual) diffs.push(`options-flow: open interest equal on only ${pct(oiEq)} of ${common} common traded contracts (< ${pct(TH.oiEqual)})`);
  if (jac < TH.flowJaccard) diffs.push(`options-flow: the traded-contract sets overlap ${pct(jac)} (< ${pct(TH.flowJaccard)})`);
  if (Math.abs(ratio - 1) > TH.flowTotalPct) diffs.push(`options-flow: the shadow recorded ${st} traded contracts, home ${ht} (${pct(ratio)} — more than 15% apart)`);
  info.push(`options-flow: home ${hn.length} names / ${ht} traded contracts at ${hm(home.etMinutes)} ET · shadow ${sn.length} names / ${st} at ${hm(shadow.etMinutes)} ET · overlap ${pct(jac)} · OI equal ${pct(oiEq)} of ${common} · coverage home ${home.coverage} / shadow ${shadow.coverage}`);
  return { diffs, info };
}
function judgeDay(home, shadow) {   // home / shadow: Map rel -> parsed doc (absent = not there)
  const diffs = [], info = [], day = home.get("day");
  for (const slot of Object.keys(SLOTS)) for (const sym of SYMS) { const rel = `gex/${day}-${slot}-${sym}.json`; const r = compareGex(home.get(rel), shadow.get(rel), slot, sym); diffs.push(...r.diffs); info.push(...r.info); }
  const f = compareFlow(home.get(`options-flow/${day}.json`), shadow.get(`options-flow/${day}.json`)); diffs.push(...f.diffs); info.push(...f.info);
  const shadowAny = [...shadow.keys()].filter((k) => k !== "day").length, homeAny = [...home.keys()].filter((k) => k !== "day").length;
  if (!shadowAny || !homeAny) return { verdict: "NOT YET", code: 2, lines: [`${day}: ${!shadowAny ? "the shadow holds nothing for the day" : "home holds nothing for the day"} — not comparable yet`] };
  return diffs.length ? { verdict: "DIFFER", code: 1, lines: [...info, ...diffs.map((d) => "DIFFER " + d)] } : { verdict: "SAME", code: 0, lines: info };
}
const dayFiles = (d) => [...Object.keys(SLOTS).flatMap((s) => SYMS.map((y) => `gex/${d}-${s}-${y}.json`)), `options-flow/${d}.json`];
function defaultDay(nowMs) { for (let i = 0; i < 12; i++) { const p = WM.etParts(nowMs - i * 864e5); if (WM.tradingDay(p.day) && (i > 0 || p.mins >= 15 * 60 + 56)) return p.day; } return null; }
function readHome(homeData, d) { const m = new Map([["day", d]]); for (const rel of dayFiles(d)) { try { m.set(rel, JSON.parse(fs.readFileSync(path.join(homeData, ...rel.split("/")), "utf8"))); } catch { /* absent */ } } return m; }
function readShadow(ssh, d) {
  const f = PS.fetchRemote(ssh, SBD, dayFiles(d).map((p) => ({ path: p, kind: "json", dir: false })), { lock: null });
  if (f.busy) throw new Error("the shadow tree is busy");
  const m = new Map([["day", d]]);
  for (const [rel, buf] of f.files) { try { m.set(rel, JSON.parse(buf.toString("utf8"))); } catch { throw new Error(`the shadow's ${rel} does not parse`); } }
  return m;
}
function main(argv, { ssh = null, homeData = path.join(REPO, "backend", "data"), nowMs = Date.now(), log = console.log } = {}) {
  if (argv.length > 1 || (argv[0] && !/^\d{4}-\d{2}-\d{2}$/.test(argv[0]))) { log("usage: node compare.cjs [YYYY-MM-DD] | --selftest"); return 2; }
  const day = argv[0] || defaultDay(nowMs); if (!day) { log("NOT YET — no trading day found"); return 2; }
  let sh; try { sh = readShadow(ssh || PS.sshReal("traids"), day); } catch (e) { log(`NOT YET — the shadow's files for ${day} could not be read (${e.message.slice(0, 200)})`); return 2; }
  const r = judgeDay(readHome(homeData, day), sh);
  log(`${r.verdict} — W2b shadow vs home, ${day}`); for (const l of r.lines) log("  " + l);
  return r.code;
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + String(d).slice(0, 500) : "")); } };
  const D = "2026-10-14", at = (h, m) => new Date(Date.parse(`${D}T00:00:00Z`) + ((h + 4) * 60 + m) * 60000).toISOString();   // EDT
  const gRows = (n, o = {}) => Array.from({ length: n }, (_, i) => [`SPY261016C${String(400 + i).padStart(8, "0")}`, "2026-10-16", "C", 400 + i, (o.oi || ((k) => 100 + k))(i), 0.01, 0.5, 20, 10, 1, 1.1]);
  const g = (slot, rows, o = {}) => ({ date: D, slot, sym: "SPY", at: o.at || (slot === "open" ? at(9, 41) : at(15, 42)), spot: o.spot || 500, totalGexM: 10, rows });
  const fRows = (n, o = {}) => Array.from({ length: n }, (_, i) => [`AAPL261016C${String(200 + i).padStart(8, "0")}`, "2026-10-16", "C", 200 + i, (o.vol || (() => 600))(i), (o.oi || ((k) => 50 + k))(i), 1, 1.1, 1.05, 0.5, 30]);
  const fl = (names, o = {}) => ({ date: D, recordedAt: at(15, 40), etMinutes: o.et || 940, complete: o.complete !== false, coverage: o.complete === false ? 0.5 : 1, names: Object.fromEntries(names.map((n) => [n, { rows: (o.rows || fRows)(100) }])), errors: o.errors || {} });
  const day = (o = {}) => { const m = new Map([["day", D]]); for (const s of ["open", "close"]) for (const y of SYMS) m.set(`gex/${D}-${s}-${y}.json`, { ...g(s, gRows(200)), sym: y, ...(o.gex || {}) }); m.set(`options-flow/${D}.json`, o.flow || fl(["AAPL", "MSFT"])); return m; };
  { const r = judgeDay(day(), day()); ok("the same day on both hosts -> SAME (exit 0), every slot and the flow record actually compared (7 info lines, none 'neither')", r.code === 0 && r.lines.length === 7 && r.lines.every((l) => /home \d+ (contracts|names)/.test(l)), r.lines.join(" | ")); }
  { const s = day(); s.delete(`gex/${D}-close-QQQ.json`); const r = judgeDay(day(), s); ok("the shadow MISSED the close QQQ slot -> DIFFER naming it", r.code === 1 && r.lines.some((l) => /DIFFER gex close QQQ: home recorded it, the SHADOW did not/.test(l)), r.lines.join(" | ")); }
  { const s = day({ gex: { at: at(15, 58) } }); const r = judgeDay(day(), s); ok("a shadow gex record taken at 15:58 ET (outside the slot) -> DIFFER", r.code === 1 && r.lines.some((l) => /outside the close slot 15:30-15:55/.test(l)), r.lines.join(" | ")); }
  { const s = day({ gex: { rows: gRows(200, { oi: (k) => (k % 10 === 0 ? 1 : 100 + k) }) } }); const r = judgeDay(day(), s); ok("open interest different on 10% of the contracts (the prior session's settled OI must be identical) -> DIFFER", r.code === 1 && r.lines.some((l) => /open interest equal on only 90\.0%/.test(l)), r.lines.join(" | ")); }
  { const s = day({ gex: { rows: gRows(200).slice(10).concat(gRows(210).slice(200)) } }); const r = judgeDay(day(), s); ok("the strike window shifted by 10 of 200 contracts (overlap 90.5%) and OI equal -> SAME", r.code === 0, r.lines.join(" | ")); }
  { const s = day({ gex: { rows: gRows(120) } }); const r = judgeDay(day(), s); ok("the shadow's chain holds 120 of home's 200 contracts (overlap 60%) -> DIFFER", r.code === 1 && r.lines.some((l) => /overlap 60\.0%/.test(l))); }
  { const s = day({ gex: { spot: 510 } }); ok("spot 2% apart -> DIFFER", judgeDay(day(), s).code === 1); }
  { const r = judgeDay(day(), day({ flow: fl(["AAPL", "MSFT"], { complete: false }) })); ok("the shadow's flow record INCOMPLETE -> DIFFER", r.code === 1 && r.lines.some((l) => /INCOMPLETE/.test(l))); }
  { const r = judgeDay(day(), day({ flow: fl(["AAPL", "TSLA"]) })); ok("the shadow attempted another population (TSLA for MSFT) -> DIFFER naming both", r.code === 1 && r.lines.some((l) => /another POPULATION — 1 name\(s\) home attempted that the shadow did not \(MSFT\), 1 the other way \(TSLA\)/.test(l)), r.lines.join(" | ")); }
  { const r = judgeDay(day(), day({ flow: fl(["AAPL"], { errors: { MSFT: "chain 500" } }) })); ok("a name the shadow attempted but failed (an error) is still the same population; its record complete -> SAME", r.code === 0, r.lines.join(" | ")); }
  { const r = judgeDay(day(), day({ flow: fl(["AAPL", "MSFT"], { et: 931 }) })); ok("the shadow's snapshot at 15:31 ET (inside R272's window) -> SAME; at 15:57 -> DIFFER", r.code === 0 && judgeDay(day(), day({ flow: fl(["AAPL", "MSFT"], { et: 957 }) })).code === 1); }
  { const r = judgeDay(day(), day({ flow: fl(["AAPL", "MSFT"], { rows: (n) => fRows(n).slice(0, 70) }) })); ok("the shadow traded-contract set 70% of home's -> DIFFER (overlap < 80%, total 30% short)", r.code === 1 && r.lines.some((l) => /overlap 70\.0%/.test(l)) && r.lines.some((l) => /more than 15% apart/.test(l)), r.lines.join(" | ")); }
  { const r = judgeDay(day(), day({ flow: fl(["AAPL", "MSFT"], { rows: (n) => fRows(n, { oi: () => 7 }) }) })); ok("the shadow's flow open interest differs everywhere -> DIFFER", r.code === 1 && r.lines.some((l) => /open interest equal on only 0\.0%/.test(l))); }
  { const r = judgeDay(day(), new Map([["day", D]])); ok("the shadow holds nothing for the day -> NOT YET (exit 2)", r.code === 2 && /the shadow holds nothing/.test(r.lines[0])); }
  ok("default day: Wed 18:00 ET -> that Wednesday; Wed 15:00 ET -> Tuesday; Sat -> Friday; the day after Thanksgiving 10:00 ET -> Wed 11-25", defaultDay(Date.parse("2026-10-14T22:00:00Z")) === "2026-10-14" && defaultDay(Date.parse("2026-10-14T19:00:00Z")) === "2026-10-13" && defaultDay(Date.parse("2026-10-17T16:00:00Z")) === "2026-10-16" && defaultDay(Date.parse("2026-11-27T15:00:00Z")) === "2026-11-25");
  // the REAL record shapes (read-only): home's last fully recorded day against itself, then with one gex OI column moved
  { const HD = path.join(REPO, "backend", "data"); let realDay = null;
    try { realDay = fs.readdirSync(path.join(HD, "options-flow")).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse().find((d) => dayFiles(d).every((rel) => fs.existsSync(path.join(HD, ...rel.split("/"))))) || null; } catch { realDay = null; }
    if (!realDay) ok("real records: skipped — no fully recorded day in backend/data (gex x6 + options-flow)", true);
    else {
      const a = readHome(HD, realDay), b = readHome(HD, realDay), r = judgeDay(a, b);
      ok(`real records of ${realDay} vs themselves -> SAME, all 7 compared (gex OI in column 4, flow OI in column 5 of the real rows)`, r.code === 0 && r.lines.length === 7 && r.lines.filter((l) => /OI equal 100\.0% of [1-9]\d*/.test(l)).length === 7, r.lines.join(" | "));
      const k = `gex/${realDay}-close-SPY.json`, c = JSON.parse(JSON.stringify(b.get(k))); c.rows = c.rows.map((row) => { const x = [...row]; x[4] = (Number(x[4]) || 0) + 1; return x; }); b.set(k, c);
      const r2 = judgeDay(a, b);
      ok(`real records of ${realDay} with the close SPY open interest shifted by one contract -> DIFFER (OI equal 0.0%)`, r2.code === 1 && r2.lines.some((l) => /DIFFER gex close SPY: open interest equal on only 0\.0%/.test(l)), r2.lines.filter((l) => /DIFFER/.test(l)).join(" | "));
    } }
  // main() through a fake ssh that serves the shadow's tar, and home files in a temp dir
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w2b-compare-"));
  try {
    const H = path.join(tmp, "data"), files = day();
    for (const [rel, doc] of files) { if (rel === "day") continue; const f = path.join(H, ...rel.split("/")); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(doc)); }
    const tar = PS.tarOf([...files].filter(([k]) => k !== "day").map(([name, doc]) => ({ name, data: JSON.stringify(doc) }))), calls = [];
    const ssh = (script, o = {}) => { calls.push(script); return /tar --format=ustar/.test(script) && script.includes(`cd '${SBD}'`) ? { ok: true, status: 0, out: tar, err: "" } : { ok: false, status: 127, out: "", err: "x" }; };
    const lines = [], code = main([D], { ssh, homeData: H, log: (s) => lines.push(s) });
    ok("main: one read-only ssh tar of the SHADOW tree's 7 files (no lock, no write) -> SAME, exit 0", code === 0 && calls.length === 1 && !/flock|rm |mv |chmod|>/.test(calls[0].replace(/2>\/dev\/null/g, "")) && /^SAME/.test(lines[0]), lines.join(" | "));
    const lines2 = [], c2 = main([D], { ssh: () => ({ ok: false, status: 255, out: Buffer.alloc(0), err: "down" }), homeData: H, log: (s) => lines2.push(s) });
    ok("main: the VPS unreachable -> NOT YET (exit 2), never SAME", c2 === 2 && /could not be read/.test(lines2[0]));
    ok("main: a bad date argument -> usage, exit 2", main(["10-14"], { ssh, homeData: H, log: () => {} }) === 2);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`compare selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.length === 1 && a[0] === "--selftest") process.exitCode = selftest() ? 0 : 1;
  else process.exitCode = main(a);
}
module.exports = { compareGex, compareFlow, judgeDay, defaultDay, main, TH };
