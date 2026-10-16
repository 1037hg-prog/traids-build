#!/usr/bin/env node
/**
 * REGISTER — the governance row of W2b, run BY JOSH right after the cutover. Home only, node + backend/lib/atomic-write.js; it appends one
 * change-registry row and one agent-ledger GOVERNANCE row, and changes no registry entry, rule, bar or population of any registered test
 * (R272's rule is "one snapshot between 15:30 and 15:55 ET" of the data/r147-earnings names: same window, same names, same script).
 * 2026-10-09 (docs/server/wave2b-schwab). Every number in the row is computed from the files when it is written.
 *
 *   node docs/server/wave2b-schwab/register.cjs [--dry]               after `deploy.cjs --cutover w2b`: the host move
 *   node docs/server/wave2b-schwab/register.cjs --rollback [--dry]    after `rollback.cjs --wave w2b`: one row per rollback
 *   node docs/server/wave2b-schwab/register.cjs --selftest            temp copies only
 * REFUSES: before the cutover (home's map must give w2b-gex and w2b-flow to the server, with a w2b cutover in its history); a row already
 * written.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", "..");
const D = (f) => path.join(REPO, "backend", "data", f);
const UNITS = ["w2b-gex", "w2b-flow"];
const AREAS = { host: "server — W2b Schwab recorders (GEX + R272 options flow) on the VPS with the operator's one Schwab app (market data only, checked live)", rollback: "server — W2b Schwab recorders rolled back to home" };
const mtDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date(ms));
const etHm = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
const jsonl = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const median = (a) => { if (!a.length) return null; const s = [...a].sort(); return s[Math.floor(s.length / 2)]; };
function registryMentions(registryFile, name) { let t = ""; try { t = fs.readFileSync(registryFile, "utf8"); } catch { return null; } let n = 0; for (let i = t.indexOf(name); i >= 0; i = t.indexOf(name, i + 1)) n++; return n; }
/** home's record times before `beforeMs`: gex per slot (median ET hh:mm over the last 10 recorded days), options-flow etMinutes per day */
function homeTimes(gexSummaryFile, flowDir, beforeMs) {
  const rows = jsonl(gexSummaryFile).filter((r) => !r.missed && r.at && Date.parse(r.at) < beforeMs);
  const days = [...new Set(rows.map((r) => r.date))].sort().slice(-10), out = { days: days.length, from: days[0] || null, to: days[days.length - 1] || null, gex: {}, flow: [] };
  for (const slot of ["open", "close"]) out.gex[slot] = median(rows.filter((r) => r.slot === slot && days.includes(r.date)).map((r) => etHm(Date.parse(r.at))));
  let files = []; try { files = fs.readdirSync(flowDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { files = []; }
  for (const f of files) { let j = null; try { j = JSON.parse(fs.readFileSync(path.join(flowDir, f), "utf8")); } catch { j = null; } if (j && Date.parse(j.recordedAt) < beforeMs) out.flow.push({ day: f.slice(0, 10), et: j.etMinutes, complete: j.complete === true, names: Object.keys(j.names || {}).length + Object.keys(j.errors || {}).length }); }
  out.flow = out.flow.slice(-10);
  return out;
}
function cutInfo(mapFile) {
  let map = null; try { map = JSON.parse(fs.readFileSync(mapFile, "utf8")); } catch { map = null; }
  const hist = map && Array.isArray(map.history) ? map.history.filter((h) => h && h.wave === "w2b" && !h.aborted) : [];
  return { map, owners: UNITS.map((u) => (map && map.units ? map.units[u] : undefined)), lastServer: [...hist].reverse().find((h) => h.to === "server"), lastHome: [...hist].reverse().find((h) => h.to === "home") };
}
const hmOf = (m) => (m == null ? "?" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
function rowFor(f, now) {
  const ci = cutInfo(f.mapFile), day = mtDay(now), cutAt = ci.lastServer ? ci.lastServer.at : "(not yet cut over)", cutMs = ci.lastServer ? Date.parse(ci.lastServer.at) : now;
  const t = homeTimes(f.gexSummary, f.flowDir, cutMs), ets = [...new Set(t.flow.map((x) => x.et))], names = [...new Set(t.flow.map((x) => x.names))];
  let n147 = null; try { n147 = fs.readdirSync(f.earningsDir).filter((x) => x.endsWith(".json")).length; } catch { n147 = null; }
  const regFlow = registryMentions(f.registryFile, "options-flow-record"), regGex = registryMentions(f.registryFile, "gex-record");
  return { id: `server-w2b-schwab-recorders-host-${day}`, date: day, recordedAt: now, area: AREAS.host, category: "ops", breaksComparability: false,
    operator: "Josh (cutover: docs/server/wave2b-schwab/deploy.cjs --cutover w2b -> deploy/server/own.cjs w2b server; G4: his decision of 2026-10-11 to use the existing Schwab app on the VPS, and the sign-in); assistant (package docs/server/wave2b-schwab)",
    change: `From the W2b cutover (${cutAt}) backend/gex-record.js and backend/options-flow-record.js run on the VPS (traids-gex Mon-Fri 09:41 and 15:42 ET, traids-flow Mon-Fri 15:40 ET, America/New_York timers, gated by the ownership map) with --schwab-md: the token of the operator's ONE Schwab app — the app home uses (Schwab allows one app per API product), which Schwab limits to market data. lib/schwab-md.js hands the token out only while Schwab's accounts side REFUSES it (401 / 403, the status code only, asked at each token refresh and at most every 15 minutes); if that side ever answers 2xx every Schwab call on the VPS refuses and the unit pages; with no answer a refusal under 24 h old on record is required. Home's env names are refused in a VPS unit's environment; dotenv not loaded, market holidays skipped as home's intraday.bat does. HOME'S RECORD TIMES before the cutover (measured from data/gex/summary.jsonl over the last ${t.days} recorded days, ${t.from} to ${t.to}): gex open ${t.gex.open || "?"} ET, close ${t.gex.close || "?"} ET (median); options-flow snapshots at ${ets.map(hmOf).join(" / ") || "?"} ET on the last ${t.flow.length} recorded days (${t.flow.filter((x) => x.complete).length} complete), ${names.join(" / ") || "?"} names attempted. The VPS keeps those times (gex 09:41 / 15:42, flow 15:40 ET). The options-flow universe is data/r147-earnings as home holds it (${n147 == null ? "?" : n147} files when this row was written), pushed read-only, in chunks, at the cutover and by the chain's "w2b pull window (W2b)" step. The chain pulls the dated records home ("pull server files (w2b)", a generated manifest of the files home lacks) BEFORE "r272 options whale forward", then "w2b records at home (W2b)" FAILs if today's six gex records or the flow record are missing or record another population. Home's intraday.bat lines are gated (deploy\\server\\home-gate.cjs w2b-gex / w2b-flow) and the close-arm runner's 15:44 ET recorder backups consult the same map ("server-owned": no run, no alert) — one change.`,
    why: "Server migration plan v2 §W2b: prove the Schwab token on the server before anything that trades depends on it; the home PC's 15:40 ET fire was lost when the host slept (2026-09-30).",
    doesNotEstablish: `Any R272 or GEX result. NO registered rule, bar or population changes: the same scripts (plus the token source and the holiday skip, both behind --schwab-md), the same 15:30-15:55 ET window and slots, the same names. test-registry.json names options-flow-record in ${regFlow == null ? "? (unreadable)" : regFlow} place(s) and gex-record in ${regGex == null ? "? (unreadable)" : regGex} when this row was written. Volume "to the moment" depends on the snapshot minute: the VPS fires at home's minute, so the record is comparable; a reader can check each file's etMinutes / at.`,
    files: ["backend/gex-record.js", "backend/options-flow-record.js", "backend/lib/schwab-md.js", "automation/intraday.bat", "automation/close-arm-runner.cjs", "automation/close-chain.cjs", "deploy/server/w2b-manifest.cjs", "docs/server/wave2b-schwab/systemd/traids-gex.timer", "docs/server/wave2b-schwab/systemd/traids-flow.timer"] };
}
const FILES = () => ({ changeFile: D("change-registry.json"), ledgerFile: D("agent-ledger.jsonl"), mapFile: D("host-ownership.json"), gexSummary: D("gex/summary.jsonl"), flowDir: D("options-flow"), earningsDir: D("r147-earnings"), registryFile: D("test-registry.json") });
function apply(f = FILES(), { dry = false, now = Date.now() } = {}) {
  const chg = JSON.parse(fs.readFileSync(f.changeFile, "utf8")); if (!Array.isArray(chg)) throw new Error("change-registry.json is not an array");
  const R = rowFor(f, now);
  if (chg.some((c) => c && c.area === R.area)) throw new Error(`already written — nothing done: ${R.area}`);
  const ci = cutInfo(f.mapFile), cut = ci.owners.every((o) => o === "server") && !!ci.lastServer;
  if (dry) return ["DRY — would append to change-registry.json:", `  + ${R.area}\n      ${R.change}\n      doesNotEstablish: ${R.doesNotEstablish}`, "and one GOVERNANCE row to agent-ledger.jsonl.", cut ? "Home's map: w2b-gex / w2b-flow server-owned — the write would proceed." : "Home's map: W2b is NOT server-owned — the write would be REFUSED (deploy.cjs --cutover w2b first)."];
  if (!cut) throw new Error("home's host-ownership.json does not give w2b-gex and w2b-flow to the server after a w2b cutover — run node docs/server/wave2b-schwab/deploy.cjs --cutover w2b first (this row records a cutover that has happened)");
  const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
  writeJsonAtomic(f.changeFile, [...chg, R]);
  fs.appendFileSync(f.ledgerFile, JSON.stringify({ at: new Date(now).toISOString(), agent: "assistant", kind: "GOVERNANCE", target: "server migration w2b (w2b-gex, w2b-flow)", what: `w2b cut over to the VPS at ${ci.lastServer.at} (the operator's one Schwab app, market data only: the VPS checks it live). Change-registry row: ${R.id} (no registered rule, bar or population changes). Rollback: node docs/server/wave2b-schwab/rollback.cjs --wave w2b.` }) + "\n");
  return [`written: change-registry.json (+1 row: ${R.id}), agent-ledger.jsonl (+1 GOVERNANCE row)`];
}
function applyRollback(f = FILES(), { dry = false, now = Date.now() } = {}) {
  const chg = JSON.parse(fs.readFileSync(f.changeFile, "utf8")); if (!Array.isArray(chg)) throw new Error("change-registry.json is not an array");
  const ci = cutInfo(f.mapFile), okRb = ci.owners.every((o) => o === "home") && ci.lastHome && ci.lastServer && ci.lastServer.at < ci.lastHome.at;
  if (!okRb) { const why = "home's host-ownership.json shows no w2b rollback (w2b-gex / w2b-flow home-owned after a cutover) — run node docs/server/wave2b-schwab/rollback.cjs --wave w2b first"; if (dry) return ["DRY — would be REFUSED: " + why]; throw new Error(why); }
  if (chg.some((c) => c && c.area === AREAS.rollback && c.rollbackAt === ci.lastHome.at)) throw new Error(`already written for the rollback of ${ci.lastHome.at} — nothing done`);
  const how = ci.lastHome.serverDown ? "--server-down (the VPS was not reached: records it took since home's last pull never reached home)" : ci.lastHome.noPull ? "--no-pull (the VPS's records since home's last pull were not brought home)" : "the one-command rollback (the VPS stopped first, a final pull brought its records home)";
  const row = { id: `server-w2b-schwab-recorders-rollback-${mtDay(now)}`, date: mtDay(now), recordedAt: now, area: AREAS.rollback, category: "ops", breaksComparability: false, rollbackAt: ci.lastHome.at,
    operator: "Josh (rollback: docs/server/wave2b-schwab/rollback.cjs --wave w2b); assistant (package docs/server/wave2b-schwab)",
    change: `At ${ci.lastHome.at} W2b was rolled back to home by ${how}. gex-record.js and options-flow-record.js run again from intraday.bat (the 07:40 and 13:40 MT fires) with home's own Schwab app, and the close-arm runner's 15:44 ET backups act again.`,
    why: "Operator rollback of server migration W2b.", doesNotEstablish: "Any result." };
  if (dry) return ["DRY — would append to change-registry.json:", `  + ${row.area} (rollback ${row.rollbackAt})`, "and one GOVERNANCE row to agent-ledger.jsonl."];
  const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
  writeJsonAtomic(f.changeFile, [...chg, row]);
  fs.appendFileSync(f.ledgerFile, JSON.stringify({ at: new Date(now).toISOString(), agent: "assistant", kind: "GOVERNANCE", target: "server migration w2b rollback", what: `w2b rolled back to home at ${ci.lastHome.at} (${ci.lastHome.serverDown ? "--server-down" : ci.lastHome.noPull ? "--no-pull" : "with the final pull"}).` }) + "\n");
  return [`written: change-registry.json (+1 row: ${row.id}), agent-ledger.jsonl (+1 GOVERNANCE row)`];
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + String(d).slice(0, 400) : "")); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w2b-register-"));
  try {
    const f = { changeFile: path.join(tmp, "change-registry.json"), ledgerFile: path.join(tmp, "agent-ledger.jsonl"), mapFile: path.join(tmp, "host-ownership.json"), gexSummary: path.join(tmp, "gex", "summary.jsonl"), flowDir: path.join(tmp, "options-flow"), earningsDir: path.join(tmp, "r147-earnings"), registryFile: path.join(tmp, "test-registry.json") };
    fs.copyFileSync(D("change-registry.json"), f.changeFile); fs.writeFileSync(f.ledgerFile, "");
    const n0 = JSON.parse(fs.readFileSync(f.changeFile, "utf8")).length;
    for (const d of [f.flowDir, f.earningsDir, path.dirname(f.gexSummary)]) fs.mkdirSync(d, { recursive: true });
    for (const s of ["AAPL", "MSFT", "NVDA"]) fs.writeFileSync(path.join(f.earningsDir, s + ".json"), "{}");
    fs.writeFileSync(f.registryFile, JSON.stringify({ tests: [{ id: "R272", status: "recorder backend/options-flow-record.js (intraday 15:30-15:55 ET)" }] }));
    const sum = [];
    for (const d of ["2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"]) {   // EDT = UTC-4: open 13:40:1x Z = 09:40 ET, close 19:42:2x Z = 15:42 ET
      for (const [slot, z] of [["open", "13:40:15"], ["close", "19:42:25"]]) for (const sym of ["$SPX", "SPY", "QQQ"]) sum.push({ at: `${d}T${z}.000Z`, date: d, slot, sym });
      fs.writeFileSync(path.join(f.flowDir, d + ".json"), JSON.stringify({ date: d, recordedAt: `${d}T19:40:05Z`, etMinutes: 940, complete: true, names: { AAPL: {}, MSFT: {} }, errors: { NVDA: "x" } }));
    }
    sum.push({ at: "2026-10-13T19:44:00Z", date: "2026-10-13", slot: "close", sym: "QQQ", missed: "chain 500" });
    fs.writeFileSync(f.gexSummary, sum.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const map = (o, hist) => fs.writeFileSync(f.mapFile, JSON.stringify({ schema: "host-ownership-v1", units: { r309: "server", "w2b-gex": o, "w2b-flow": o }, history: hist }));
    const CUT = { at: "2026-10-14T22:10:00Z", wave: "w2b", to: "server", units: UNITS };
    map("home", []);
    const dry = apply(f, { dry: true, now: Date.parse("2026-10-14T22:15:00Z") }).join("\n");
    ok("--dry before the cutover: shows the row, says REFUSED, writes nothing", /REFUSED/.test(dry) && JSON.parse(fs.readFileSync(f.changeFile, "utf8")).length === n0 && fs.readFileSync(f.ledgerFile, "utf8") === "");
    let e = null; try { apply(f, { now: Date.parse("2026-10-14T22:15:00Z") }); } catch (x) { e = x.message; }
    ok("before the cutover -> REFUSED, nothing written", /--cutover w2b first/.test(e || "") && JSON.parse(fs.readFileSync(f.changeFile, "utf8")).length === n0);
    map("server", [CUT]); apply(f, { now: Date.parse("2026-10-14T22:15:00Z") });
    const chg = JSON.parse(fs.readFileSync(f.changeFile, "utf8")), row = chg[chg.length - 1];
    ok("after the cutover: +1 row appended (everything before unchanged), +1 GOVERNANCE row", chg.length === n0 + 1 && JSON.stringify(chg.slice(0, n0)) === JSON.stringify(JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"))) && JSON.parse(fs.readFileSync(f.ledgerFile, "utf8").trim()).kind === "GOVERNANCE");
    ok("the row states the Schwab arrangement as it is (2026-10-11): ONE app, the app home uses, handed out on the VPS only while Schwab's accounts side refuses the token; it does not claim a second, market-data-only app or a refusal of home's key (the void rule)", /the operator's ONE Schwab app — the app home uses/.test(row.change) && /only while Schwab's accounts side REFUSES it \(401 \/ 403, the status code only/.test(row.change) && /if that side ever answers 2xx every Schwab call on the VPS refuses/.test(row.change) && !/trading app|MARKET-DATA-ONLY Schwab app/.test(JSON.stringify(row)) && /in chunks, at the cutover and by the chain's "w2b pull window \(W2b\)" step/.test(row.change), row.change);
    ok("the row is computed from the files: home's gex open 09:40 / close 15:42 ET (median, missed rows ignored), flow at 15:40 ET on 4 complete days, 3 names attempted, 3 r147-earnings files; breaksComparability false; R272 named in 1 place", row.area === AREAS.host && row.breaksComparability === false && /gex open 09:40 ET, close 15:42 ET/.test(row.change) && /options-flow snapshots at 15:40 ET on the last 4 recorded days \(4 complete\), 3 names attempted/.test(row.change) && /\(3 files when this row was written\)/.test(row.change) && /2026-10-14T22:10:00Z/.test(row.change) && /options-flow-record in 1 place\(s\)/.test(row.doesNotEstablish) && /NO registered rule, bar or population changes/.test(row.doesNotEstablish), row.change);
    e = null; try { apply(f); } catch (x) { e = x.message; }
    ok("a second run -> REFUSED (already written)", /already written/.test(e || "") && JSON.parse(fs.readFileSync(f.changeFile, "utf8")).length === n0 + 1);
    e = null; try { applyRollback(f); } catch (x) { e = x.message; }
    ok("--rollback while server-owned -> REFUSED", /shows no w2b rollback/.test(e || ""));
    map("home", [CUT, { at: "2026-10-15T23:00:00Z", wave: "w2b", to: "home", units: UNITS }]);
    applyRollback(f, { now: Date.parse("2026-10-15T23:05:00Z") });
    const rb = JSON.parse(fs.readFileSync(f.changeFile, "utf8")).slice(-1)[0];
    ok("--rollback: one row keyed by the rollback time; again -> REFUSED", rb.area === AREAS.rollback && rb.rollbackAt === "2026-10-15T23:00:00Z" && /intraday\.bat/.test(rb.change) && /already written for the rollback/.test((() => { try { applyRollback(f); return ""; } catch (x) { return x.message; } })()));
    const code = fs.readFileSync(__filename, "utf8").split("function selftest")[0];
    ok("the test registry is only READ (a count of mentions), never written: the only writes are the change registry and the ledger", !/(writeJsonAtomic|writeFileSync|appendFileSync|renameSync|unlinkSync)\(\s*f\.registryFile/.test(code) && (code.match(/writeJsonAtomic\(f\.changeFile/g) || []).length === 2 && (code.match(/appendFileSync\(f\.ledgerFile/g) || []).length === 2 && !/read-seals|test-registry\.json"\)\s*,/.test(code.replace(/registryFile: D\("test-registry\.json"\)/, "")));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`register selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2), dry = a.includes("--dry"), rest = a.filter((x) => x !== "--dry");
  try {
    if (rest.length === 1 && rest[0] === "--selftest" && !dry) process.exitCode = selftest() ? 0 : 1;
    else if (rest.length === 0) { for (const l of apply(FILES(), { dry })) console.log(l); process.exitCode = 0; }
    else if (rest.length === 1 && rest[0] === "--rollback") { for (const l of applyRollback(FILES(), { dry })) console.log(l); process.exitCode = 0; }
    else { console.error("usage: register.cjs [--dry] · --rollback [--dry] · --selftest"); process.exitCode = 2; }
  } catch (e) { console.error("register: " + e.message); process.exitCode = 1; }
}
module.exports = { apply, applyRollback, rowFor, homeTimes, registryMentions, AREAS };
