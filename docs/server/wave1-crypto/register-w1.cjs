#!/usr/bin/env node
/**
 * REGISTER W1 — the governance rows the plan names for the W1 cutover (plan v2 §W1 prerequisites), run BY JOSH right after
 * `node deploy/server/own.cjs w1 server` succeeds. 2026-10-07 (docs/server/wave1-crypto). Home only, node + atomic-write.
 *
 * Writes three change-registry rows and one agent-ledger row; changes no registry entry (R323's registered statistic already says
 * "weekdays only while the recorder runs in the home close chain, every day once it runs on the droplet", and its runner switches
 * the calendar itself at the first complete Saturday+Sunday pair of snapshots — schedule(): dailyFrom):
 *   1  R323 / whales: the recorder and R323 --score run on the VPS daily at 21:30 UTC; R323's calendar turns 7-day at the first complete
 *      Sat+Sun pair (expected 2026-10-10/11); the snapshot time moves from ~20:36 UTC (the chain's slot) to ~21:31 UTC.
 *   2  funding (#55): the collector runs 7 days a week on the VPS; the store's content is unchanged in kind (OKX periods by timestamp).
 *   3  social: the recorder runs 7 days a week on the VPS -> Saturday/Sunday files from 2026-10-10. R179 was amended 2026-10-08
 *      (operator "R179 A", key weekday-files-2026-10-08) to read WEEKDAY files only, so weekend files change no R179 statistic and
 *      Monday's S2 still compares with Friday's list. Still OPEN (Josh's call, dated note holiday-files-note-2026-10-08): the VPS also
 *      records on weekday NYSE full closures (first 2026-11-26), which the home chain never did; R179 reads those as weekday files.
 * REFUSES: if any of the three rows already exists (by area) — nothing is written twice; unless home's host-ownership.json says every W1
 * unit is server-owned (the rows describe a cutover that has happened) — --dry shows the rows regardless.
 *
 *   node docs/server/wave1-crypto/register-w1.cjs --dry      print the rows, write nothing
 *   node docs/server/wave1-crypto/register-w1.cjs            write them (once)
 *   node docs/server/wave1-crypto/register-w1.cjs --rollback [--dry]   AFTER `own.cjs w1 home`: one change-registry row + one agent-ledger
 *        row for that rollback (once per rollback, keyed by its time in the map's history). It records what the rollback does to R323:
 *        once its calendar is 7-day (cadence.dailyFrom set) it stays so, and the weekday-only home chain leaves two PERMANENT gap rows
 *        per weekend (Friday's interval exits flat at Saturday's nominal entry, Monday re-enters) — a departure from R323's registered
 *        "weekdays only while the recorder runs in the home close chain"; and, after --no-pull / --server-down, that the days the VPS
 *        recorded but home never received are permanent gap rows. Whether R323 is amended is OPEN (the operator's decision).
 *   node docs/server/wave1-crypto/register-w1.cjs --selftest temp copies only
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", "..");
const D = (f) => path.join(REPO, "backend", "data", f);
const UNITS = ["w1-whales", "w1-funding", "w1-social"];
const AREAS = {
  r323: "server — W1 whales recorder + R323 score on the VPS (R323 calendar turns 7-day)",
  funding: "server — W1 funding carry collector #55 on the VPS (weekend runs)",
  social: "server — W1 social mentions recorder on the VPS (weekend files; R179 note)",
  rollback: "server — W1 rolled back to the home close chain (R323 weekend gap rows)",
};
const mtDay = (ms = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date(ms));

function rows(day, cutAt) {
  const common = { breaksComparability: false, operator: "Josh (cutover: deploy/server/own.cjs w1 server); assistant (package docs/server/wave1-crypto)" };
  return [
    { date: day, area: AREAS.r323, category: "ops", ...common,
      change: `From the W1 cutover (${cutAt}), hyperliquid-whales-record.js and r323-hl-copy-leaders.js --score run on the VPS as one oneshot (traids-w1-whales: the recorder, then R323), daily at 21:30 UTC including weekends; the close-chain steps "hyperliquid whales record" and "r323 hl copy leaders (score)" are skipped at home ("skipped (server-owned)") and the files reach home through "pull server files" (validated: dated snapshots never rewritten once complete, the R323 ledger append-only). R323's snapshot calendar turns 7-day at the first complete Saturday+Sunday pair of snapshots (expected 2026-10-10/11), exactly as its registered statistic states ("every day once it runs on the droplet") and as its runner implements (schedule(): dailyFrom). The snapshot time moves from about 20:36 UTC (the chain's slot) to about 21:31 UTC, so the entry instant E = ceil(recordedAt + 60 min) moves from 22:00 to 23:00 UTC; the interval that spans the switch is about 25 h. R323 --read stays at home.`,
      why: "Server migration plan v2 §W1: weekends were never recorded and cannot be back-filled; the recorder needs no secret.",
      doesNotEstablish: "Any R323 result. No rule, statistic, bar or luck gate changes; the 7-day calendar is the registered behaviour." },
    { date: day, area: AREAS.funding, category: "ops", ...common,
      change: `From the W1 cutover (${cutAt}), funding-carry-v2.js (the #55 collector) runs on the VPS daily at 16:30 New York time including weekends (traids-w1-funding); the chain step "funding carry collector (#55)" is skipped at home and data/funding-carry-store.json is pulled home (validated: every stored period present and unchanged — the store only grows), where full-audit.js reads it. risk-policy.json is pushed to the VPS read-only on every pull. The store keys OKX funding periods by timestamp, so weekend runs add no new kind of row: weekend periods were already captured by the Monday run (OKX serves ~91 days); the collector now simply runs 7 days a week.`,
      why: "Server migration plan v2 §W1 (a data clock: every day the collector misses past OKX's 91-day window is lost).",
      doesNotEstablish: "Any #55 result; the store's content and the adjudication are unchanged." },
    { date: day, area: AREAS.social, category: "ops", ...common,
      change: `From the W1 cutover (${cutAt}), social-mentions-record.js runs on the VPS daily at 16:35 New York time including weekends (traids-w1-social); the chain step "social mentions record" is skipped at home and data/social-mentions/<ET day>.json is pulled home (complete files never rewritten). New: Saturday and Sunday files exist from 2026-10-10. R179 (r179-chatter-grade.js) reads WEEKDAY files only since its dated amendment of 2026-10-08 (operator "R179 A", key weekday-files-2026-10-08): a Saturday or Sunday file is ignored by every R179 statistic and Monday's S2 "absent from the previous recorded day's list" still compares with Friday's list, so the weekend files change no R179 number. Not covered by that amendment: the VPS also records on weekday NYSE full closures (first 2026-11-26), which the home chain never did (lib/run-window.js HOLIDAY-CLOSED at its slot); R179 reads such a file as a weekday file (the next session's S2 would compare with the holiday's list, the holiday becomes an S3 crypto signal day and a snapshot day), reports it nightly (weekdayHolidayFiles) and refuses --read until the operator decides (dated note holiday-files-note-2026-10-08). Also: the server records at 16:35 ET, after home's chain-start pull, so R179 at home sees each weekday's file one evening later (it rebuilds every signal from the files nightly, so the record converges).`,
      why: "Server migration plan v2 §W1: weekend chatter was never recorded and cannot be back-filled.",
      doesNotEstablish: "Any R179 result. Weekend files: decided 2026-10-08 (operator \"R179 A\": weekday files only). OPEN, the operator's decision before 2026-11-26: R179's weekday market-holiday files — ignore them by a second dated amendment, or read them as a disclosed population change." },
  ];
}
function apply({ changeFile, ledgerFile, mapFile, dry = false, now = Date.now() } = {}) {
  const chg = JSON.parse(fs.readFileSync(changeFile, "utf8"));
  if (!Array.isArray(chg)) throw new Error("change-registry.json is not an array");
  const have = [AREAS.r323, AREAS.funding, AREAS.social].filter((a) => chg.some((c) => c && c.area === a));
  if (have.length) throw new Error(`already written — nothing done: ${have.join(" | ")}`);
  let map = null; try { map = JSON.parse(fs.readFileSync(mapFile, "utf8")); } catch { map = null; }
  const cut = map && map.units && UNITS.every((u) => map.units[u] === "server");
  const hist = map && Array.isArray(map.history) ? map.history.filter((h) => h && h.wave === "w1" && h.to === "server" && !h.aborted) : [];
  const cutAt = hist.length ? hist[hist.length - 1].at : "(not yet cut over)";
  const R = rows(mtDay(now), cutAt);
  if (dry) return ["DRY — would append to change-registry.json:", ...R.map((r) => `  + ${r.area}`), "and one GOVERNANCE row to agent-ledger.jsonl.", cut ? "Home's map: every W1 unit server-owned — the write would proceed." : "Home's map: W1 is NOT server-owned yet — the write would be REFUSED (run own.cjs w1 server first)."];
  if (!cut) throw new Error("home's host-ownership.json does not say every W1 unit is server-owned — run `node deploy/server/own.cjs w1 server` first (these rows record a cutover that has happened)");
  const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
  writeJsonAtomic(changeFile, [...chg, ...R]);
  fs.appendFileSync(ledgerFile, JSON.stringify({ at: new Date(now).toISOString(), agent: "assistant", kind: "GOVERNANCE", target: "server migration W1 (hyperliquid whales + R323 score, funding #55, social mentions)", what: `W1 cut over to the VPS at ${cutAt} (own.cjs w1 server, run by the operator). Change-registry rows: R323's calendar turns 7-day at the first complete Sat+Sun pair as registered; funding and social gain weekend runs/files. R179 reads weekday social files only (amendment 2026-10-08, operator "R179 A"); its weekday market-holiday files (first 2026-11-26) are OPEN (operator's decision). Rollback: node deploy/server/own.cjs w1 home.` }) + "\n");
  return [`written: change-registry.json (+3 rows: ${R.map((r) => r.area).join(" | ")}), agent-ledger.jsonl (+1 GOVERNANCE row)`];
}

/** the rollback row: refused unless home's map shows a W1 cutover followed by a rollback and every W1 unit home-owned now */
function applyRollback({ changeFile, ledgerFile, mapFile, stateFile, dry = false, now = Date.now() } = {}) {
  const chg = JSON.parse(fs.readFileSync(changeFile, "utf8"));
  if (!Array.isArray(chg)) throw new Error("change-registry.json is not an array");
  let map = null; try { map = JSON.parse(fs.readFileSync(mapFile, "utf8")); } catch { map = null; }
  const hist = map && Array.isArray(map.history) ? map.history.filter((h) => h && h.wave === "w1" && !h.aborted) : [];
  const lastHome = [...hist].reverse().find((h) => h.to === "home"), cutBefore = lastHome && hist.some((h) => h.to === "server" && h.at < lastHome.at);
  const home = map && map.units && UNITS.every((u) => map.units[u] === "home");
  if (!home || !lastHome || !cutBefore) { const why = "home's host-ownership.json shows no W1 rollback (every W1 unit home-owned after a cutover) — run `node deploy/server/own.cjs w1 home` first"; if (dry) return ["DRY — would be REFUSED: " + why]; throw new Error(why); }
  if (chg.some((c) => c && c.area === AREAS.rollback && c.rollbackAt === lastHome.at)) throw new Error(`already written for the rollback of ${lastHome.at} — nothing done`);
  let st = null; try { st = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { st = null; }
  const daily = st && st.cadence && st.cadence.dailyFrom ? st.cadence.dailyFrom : null;
  const how = lastHome.serverDown ? "--server-down (the VPS was not reached: the days it recorded since home's last pull never reached home)" : lastHome.noPull ? "--no-pull (the VPS's files since home's last pull were not brought home)" : "the one-command rollback (the VPS stopped first, a final pull brought its files home)";
  const row = { date: mtDay(now), area: AREAS.rollback, category: "ops", breaksComparability: false, rollbackAt: lastHome.at, operator: "Josh (rollback: deploy/server/own.cjs w1 home); assistant (package docs/server/wave1-crypto)",
    change: `At ${lastHome.at} W1 was rolled back to the home close chain by ${how}. The recorders now run in the weekday-only chain again. R323: ${daily ? `its snapshot calendar turned 7-day at ${daily} and STAYS 7-day (schedule(): dailyFrom is recomputed from the snapshot files, which stay at home), so from this rollback every Saturday and Sunday is an expected day with no snapshot: two PERMANENT gap rows per weekend, Friday's interval exits flat at Saturday's nominal entry (an extra exit cost) and Monday re-enters from flat — until the recorder runs 7 days again. This departs from R323's registered statistic ("weekdays only while the recorder runs in the home close chain").` : "its calendar was still weekdays-only (no complete Sat+Sun pair yet): no weekend gap rows follow from this rollback."}${lastHome.serverDown || lastHome.noPull ? " Every whales / social day the VPS recorded but home never received is a permanent \"no snapshot\" gap row in R323 and a missing R179 day, although the VPS holds the file." : ""} Funding (#55) and social lose their weekend runs again.`,
    why: "Operator rollback of server migration W1 (own.cjs w1 home).",
    doesNotEstablish: `Any R323 / #55 / R179 result. OPEN, the operator's decision: ${daily ? "amend R323 (e.g. weekday calendar while the recorder runs at home again) before its read, or leave the weekend gap rows as they fall" : "none for R323's calendar"}.` };
  if (dry) return ["DRY — would append to change-registry.json:", `  + ${row.area} (rollback ${row.rollbackAt}; R323 dailyFrom ${daily || "not set"})`, "and one GOVERNANCE row to agent-ledger.jsonl."];
  const { writeJsonAtomic } = require(path.join(REPO, "backend", "lib", "atomic-write.js"));
  writeJsonAtomic(changeFile, [...chg, row]);
  fs.appendFileSync(ledgerFile, JSON.stringify({ at: new Date(now).toISOString(), agent: "assistant", kind: "GOVERNANCE", target: "server migration W1 rollback", what: `W1 rolled back to home at ${lastHome.at} (${lastHome.serverDown ? "--server-down" : lastHome.noPull ? "--no-pull" : "with the final pull"}). R323 ${daily ? `stays 7-day (dailyFrom ${daily}): two permanent gap rows per weekend while the recorder runs at home; amending R323 is OPEN (operator)` : "was still weekdays-only: no weekend gap rows"}.` }) + "\n");
  return [`written: change-registry.json (+1 row: ${row.area}, rollback ${row.rollbackAt}), agent-ledger.jsonl (+1 GOVERNANCE row)`];
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "register-w1-"));
  try {
    const f = { changeFile: path.join(tmp, "change-registry.json"), ledgerFile: path.join(tmp, "agent-ledger.jsonl"), mapFile: path.join(tmp, "host-ownership.json") };
    fs.copyFileSync(D("change-registry.json"), f.changeFile); fs.writeFileSync(f.ledgerFile, "");
    const n0 = JSON.parse(fs.readFileSync(f.changeFile, "utf8")).length;
    const map = (h) => fs.writeFileSync(f.mapFile, JSON.stringify({ schema: "host-ownership-v1", units: { r309: "server", "w1-whales": h, "w1-funding": h, "w1-social": h }, history: h === "server" ? [{ at: "2026-10-09T21:40:12Z", wave: "w1", to: "server", units: UNITS }] : [] }));
    map("home");
    const dry = apply({ ...f, dry: true }).join("\n");
    ok("--dry: lists the three rows, says it would be REFUSED before the cutover, writes nothing", /REFUSED/.test(dry) && JSON.parse(fs.readFileSync(f.changeFile, "utf8")).length === n0 && fs.readFileSync(f.ledgerFile, "utf8") === "");
    let e1 = null; try { apply(f); } catch (e) { e1 = e.message; }
    ok("before the cutover (W1 home-owned) -> refused, nothing written", /run `node deploy\/server\/own\.cjs w1 server` first/.test(e1 || "") && JSON.parse(fs.readFileSync(f.changeFile, "utf8")).length === n0);
    map("server");
    apply({ ...f, now: Date.parse("2026-10-09T21:45:00Z") });
    const chg = JSON.parse(fs.readFileSync(f.changeFile, "utf8")), added = chg.slice(n0);
    ok("after the cutover: +3 change-registry rows (appended, everything before unchanged), +1 agent-ledger GOVERNANCE row", added.length === 3 && JSON.stringify(chg.slice(0, n0)) === JSON.stringify(JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"))) && fs.readFileSync(f.ledgerFile, "utf8").trim().split("\n").length === 1 && JSON.parse(fs.readFileSync(f.ledgerFile, "utf8")).kind === "GOVERNANCE");
    ok("rows: dated (MT), the cutover time from the map's history, the R323 7-day switch as registered, weekend rows for funding and social, R179's weekday-files amendment (decided) and its holiday files OPEN", added.every((r) => r.date === "2026-10-09" && /2026-10-09T21:40:12Z/.test(r.change)) && /turns 7-day at the first complete Saturday\+Sunday pair/.test(added[0].change) && /7 days a week/.test(added[1].change) && /Saturday and Sunday files/.test(added[2].change)
      && /reads WEEKDAY files only since its dated amendment of 2026-10-08 \(operator "R179 A", key weekday-files-2026-10-08\)/.test(added[2].change) && !/reads every file/.test(added[2].change) && /first 2026-11-26/.test(added[2].change) && /holiday-files-note-2026-10-08/.test(added[2].change)
      && /Weekend files: decided 2026-10-08/.test(added[2].doesNotEstablish) && /OPEN, the operator's decision before 2026-11-26: R179's weekday market-holiday files/.test(added[2].doesNotEstablish)
      && /R179 reads weekday social files only \(amendment 2026-10-08/.test(fs.readFileSync(f.ledgerFile, "utf8")) && !/R179's use of weekend social files is OPEN/.test(fs.readFileSync(f.ledgerFile, "utf8")) && added.every((r) => r.breaksComparability === false));
    let e2 = null; try { apply(f); } catch (e) { e2 = e.message; }
    ok("a second run -> refused (already written), nothing added", /already written/.test(e2 || "") && JSON.parse(fs.readFileSync(f.changeFile, "utf8")).length === n0 + 3);
    ok("the test registry is never opened by this script", !/test-registry/.test(fs.readFileSync(__filename, "utf8").split("function selftest")[0].replace(/^ \*.*$/gm, "")));
    // --rollback
    const R = { ...f, stateFile: path.join(tmp, "r323-state.json") };
    let e3 = null; try { applyRollback(R); } catch (e) { e3 = e.message; }
    ok("--rollback while W1 is server-owned (no rollback yet) -> refused, nothing written", /shows no W1 rollback/.test(e3 || "") && JSON.parse(fs.readFileSync(f.changeFile, "utf8")).length === n0 + 3);
    fs.writeFileSync(f.mapFile, JSON.stringify({ schema: "host-ownership-v1", units: { r309: "server", "w1-whales": "home", "w1-funding": "home", "w1-social": "home" }, history: [{ at: "2026-10-09T21:40:12Z", wave: "w1", to: "server", units: UNITS }, { at: "2026-10-14T15:10:00Z", wave: "w1", to: "home", units: UNITS, serverDown: true }] }));
    fs.writeFileSync(R.stateFile, JSON.stringify({ cadence: { dailyFrom: "2026-10-10" } }));
    const dr = applyRollback({ ...R, dry: true }).join("\n");
    ok("--rollback --dry: names the row and dailyFrom, writes nothing", /DRY[^]*rolled back[^]*dailyFrom 2026-10-10/.test(dr) && JSON.parse(fs.readFileSync(f.changeFile, "utf8")).length === n0 + 3);
    applyRollback({ ...R, now: Date.parse("2026-10-14T15:20:00Z") });
    const rr = JSON.parse(fs.readFileSync(f.changeFile, "utf8")).slice(-1)[0];
    ok("--rollback: +1 row keyed by the rollback time — the weekend gap rows, the --server-down lost days, R323's registered statistic, OPEN for the operator; +1 GOVERNANCE row", rr.area === AREAS.rollback && rr.rollbackAt === "2026-10-14T15:10:00Z" && /two PERMANENT gap rows per weekend/.test(rr.change) && /never reached home/.test(rr.change) && /permanent "no snapshot" gap row/.test(rr.change) && /departs from R323's registered statistic/.test(rr.change) && /OPEN, the operator's decision: amend R323/.test(rr.doesNotEstablish) && fs.readFileSync(f.ledgerFile, "utf8").trim().split("\n").length === 2);
    let e4 = null; try { applyRollback(R); } catch (e) { e4 = e.message; }
    ok("--rollback again for the same rollback -> refused (already written)", /already written for the rollback of 2026-10-14T15:10:00Z/.test(e4 || ""));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`register-w1 selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  try {
    if (a.some((x) => !["--dry", "--selftest", "--rollback"].includes(x)) || (a.includes("--selftest") && a.length > 1)) throw new Error("usage: register-w1.cjs [--dry] · --rollback [--dry] · --selftest");
    if (a.includes("--selftest")) process.exitCode = selftest() ? 0 : 1;
    else if (a.includes("--rollback")) { for (const l of applyRollback({ changeFile: D("change-registry.json"), ledgerFile: D("agent-ledger.jsonl"), mapFile: D("host-ownership.json"), stateFile: D("r323-state.json"), dry: a.includes("--dry") })) console.log(l); process.exitCode = 0; }
    else { for (const l of apply({ changeFile: D("change-registry.json"), ledgerFile: D("agent-ledger.jsonl"), mapFile: D("host-ownership.json"), dry: a.includes("--dry") })) console.log(l); process.exitCode = 0; }
  } catch (e) { console.error("register-w1: " + e.message); process.exitCode = 1; }
}
module.exports = { rows, apply, applyRollback, AREAS };
