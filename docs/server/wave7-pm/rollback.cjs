#!/usr/bin/env node
/**
 * ROLLBACK — stop W7, the prediction-market book recorder for R352. 2026-10-11 (docs/server/wave7-pm). Each part refuses rather than
 * guess; --dry prints the plan and changes nothing. Run BY JOSH from the repo root on the PC.
 *
 *   node docs/server/wave7-pm/rollback.cjs --server [--dry]    ONE command that stops the recorder and keeps it stopped:
 *        1  the map: "w7-pm": "home", pushed to the VPS first (root:root 0444, read back), then written at home. There is no home
 *           version of this unit, so "home" means "nobody runs it": from then on a start of any of the 5 units — by hand, by a timer
 *           or at a reboot — is skipped by its ownership gate, quietly. The recorder that is RUNNING reads the same map once a
 *           minute and, within a minute of this push, closes its files and ends by itself (exit 0): so a stop that then never
 *           arrives (the ssh call lost, sudo refusing systemctl) does not leave it recording with its health check, its nightly
 *           compress and the pull all skipping themselves on that map.
 *           HOME'S MAP IS THE MASTER. The two maps need not be byte-equal for this: while they agree on every OTHER unit's owner,
 *           home's map (with "w7-pm": "home") replaces the VPS's — also when the two differ in bookkeeping (another wave's move
 *           written at home and never pushed), and when only one of them names w7-pm (a units step that died between its two map
 *           writes). Only a difference in ANOTHER unit's owner is refused: pushing either map would move that unit, and the
 *           refusal names the command that settles it.
 *        2  the health timer and the nightly timer disabled and stopped (the health timer first: a check that found the recorder
 *           stopped would page), then the recorder disabled and stopped. It gets SIGTERM, closes every part with a close row and
 *           writes the gap up to the stop.
 *        3  read back: every one of the 5 units disabled and inactive, or the command fails and says which is not. (The stop
 *           script prints STOPPED whatever happened — each of its commands ends "|| true" — so this read-back is the only check
 *           of the stop there is. When it fails, run the command again: both maps already say home, so it only stops and reads back.)
 *        THE DATA STAYS: nothing under data/pm-book on the VPS is removed — no day, no archive, no summary, not the live marker. The
 *        unit files, the code and home's pull manifest stay too (the pull then says "home-owned — not pulled").
 *        To record again: node docs/server/wave7-pm/deploy.cjs --step units  (it sets the map back, starts the recorder; the FIRST
 *        liveAt stands, and the stretch in between is on record as a gap).
 *   node docs/server/wave7-pm/rollback.cjs --units [--dry]     after --server: the 5 unit files removed from /etc/systemd/system.
 *        REFUSED while either map gives w7-pm to the server, or while any of the 5 is enabled or active. No other unit is ever named.
 *   node docs/server/wave7-pm/rollback.cjs --selftest          a fake VPS; no ssh
 * This command and deploy.cjs's units step are the ONLY writers of this unit's map entry: the shared mover (deploy/server/own.cjs
 * w7-pm home | server) refuses the unit, because its manifest gives it a fixed owner — there is no home version to move it to.
 * A VPS that cannot be reached: nothing is changed anywhere (the recorder keeps running there); the command says so and exits 1.
 * It never touches the test registry, a recorded day, another unit, a key or a switch file.
 * IF R352's EVIDENCE HAS STARTED: a UTC day in which the recorder is down for more than rule[11] allows is dropped whole, and the 30-day
 * span is not extended (rule[12]). Stopping it is the operator's decision; this script only makes it one command.
 */
"use strict";
const fs = require("fs"), path = require("path");
const HERE = __dirname;
const L = require(path.join(HERE, "w7-lib.cjs")), DEP = require(path.join(HERE, "deploy.cjs"));
const { PS, OWN, UN, RD, SYSD, UNIT, SERVICE, REMOTE, must } = L;
const BY = "docs/server/wave7-pm/rollback.cjs (--server)";

function parseArgs(argv) {
  const out = { mode: null, dry: false };
  for (const x of argv) {
    if (x === "--dry") out.dry = true;
    else if (["--server", "--units", "--selftest"].includes(x)) { if (out.mode) throw new Error(`give one of --server / --units / --selftest (got ${argv.join(" ")}) — nothing was done`); out.mode = x.slice(2); }
    else throw new Error(`unknown argument ${JSON.stringify(x)} — nothing was done. rollback.cjs takes: --server [--dry] · --units [--dry] · --selftest`);
  }
  if (!out.mode) throw new Error("give --server, --units or --selftest — nothing was done");
  if (out.dry && out.mode === "selftest") throw new Error("--dry goes with --server or --units");
  return out;
}
/** null when two maps differ ONLY in w7-pm's owner (and the bookkeeping fields); else which unit differs */
function otherUnitsDiffer(a, b) {
  const names = new Set([...Object.keys(a.units || {}), ...Object.keys(b.units || {})]); names.delete(UNIT);
  for (const u of names) if ((a.units || {})[u] !== (b.units || {})[u]) return u;
  return null;
}

function make(deps = {}) {
  const d = { ssh: null, log: (s) => console.log(s), mapFile: path.join(PS.HOME_DATA, "host-ownership.json"), now: () => Date.now(), ...deps };
  const ssh = (script, o) => { if (!d.ssh) d.ssh = PS.sshReal(L.HOST); return d.ssh(script, o); };
  const unitState = () => { const m = L.parseUnitState(must(ssh(REMOTE.unitState(UN.ALL_UNITS)), "reading the units' state")); for (const u of UN.ALL_UNITS) if (!m[u]) throw new Error(`reading the units' state: no answer for ${u}`); return m; };
  /** both maps, read fail-closed: an unreachable VPS or an unreadable map throws (nothing was changed) */
  function maps() {
    const mr = PS.readMap(d.mapFile); if (!mr.ok) throw new Error(`home's map: ${mr.why} — REFUSED (nothing changed)`);
    let txt; try { txt = must(ssh(REMOTE.cat(RD + "/host-ownership.json")), "reading the VPS map"); } catch (e) { throw new Error(`${e.message} — the VPS cannot be read, so NOTHING was changed on either machine: if the recorder was running there, it still is`); }
    let vm; try { vm = JSON.parse(txt); } catch { throw new Error("the VPS map does not parse — REFUSED (nothing changed)"); }
    if (!vm || vm.schema !== "host-ownership-v1" || !vm.units) throw new Error("the VPS map is not a host-ownership-v1 map — REFUSED (nothing changed)");
    return { mr, vm, vmBuf: Buffer.from(txt), vmSha: PS.sha(Buffer.from(txt)), equal: PS.sha(Buffer.from(txt)) === mr.sha };
  }

  function server({ dry = false } = {}) {
    d.log(`== --server${dry ? " --dry (the plan; nothing is changed)" : ""}: stop the recorder — the map first, then the units; the data stays`);
    const { mr, vm, vmBuf, vmSha, equal } = maps(), home = mr.map.units[UNIT], vps = vm.units[UNIT];
    if (home == null && vps == null) { d.log(`   ${UNIT} is in neither map: it was never deployed — nothing to do`); return { changed: false, stopped: false }; }
    const other = otherUnitsDiffer(mr.map, vm);
    if (other) throw new Error(`the two maps differ in ${other} (home ${JSON.stringify(mr.map.units[other])}, VPS ${JSON.stringify(vm.units[other])}) — that is not this unit's to settle, and pushing either map over the other would move ${other}. ${L.mapDifference(mr.map, vm).how}. Then run this again. To stop the recorder before that is settled (it stays stopped across a reboot; the maps are not touched): ssh traids sudo systemctl disable --now ${[...L.TIMERS].reverse().join(" ")} ${SERVICE} — REFUSED (nothing changed)`);
    // The two maps agree on every OTHER unit's owner. HOME'S MAP IS THE MASTER (as in every move deploy/server makes), so whatever
    // the two say about this unit, and whatever bookkeeping (history, updatedAt) one holds that the other does not, the stop is:
    //   none    both already say home: only the units are looked at again
    //   adopt   the VPS holds exactly home's map plus this command's own step (an earlier run died between its two writes)
    //   push    every other state — both say server with different bookkeeping (another wave's move written at home and not
    //           pushed), or only one of them names the unit (the units step died between its two writes): home's map with
    //           "w7-pm": "home" goes to the VPS and is then written at home
    const half = L.halfDone(mr.map, vmBuf, "home");
    const plan = home === "home" && vps === "home" ? "none" : half ? "adopt" : "push";
    const us0 = unitState(), on = UN.ALL_UNITS.filter((u) => us0[u].enabled === "enabled" || us0[u].active === "active");
    d.log(`   now: map ${UNIT} = ${home === undefined ? "not named" : home} at home, ${vps === undefined ? "not named" : vps} on the VPS${equal ? "" : " (the two maps are not byte-equal; they agree on every other unit's owner)"}; units enabled or active: ${on.length ? on.join(", ") : "none"}`);
    if (dry) {
      d.log(plan === "push" ? `   would 1: push "${UNIT}": "home" to the VPS (read back), then write it at home${equal ? "" : " — home's map is the master: it replaces the VPS's, bookkeeping and all"}` : plan === "adopt" ? "   would 1: write the VPS's map at home (the VPS already says home; home's map was left behind by an earlier run)" : "   would 1: leave the maps (both already say home)");
      d.log(`   would 2: disable and stop ${[...L.TIMERS].reverse().join(", ")}, then ${SERVICE} (SIGTERM: it closes its files and writes the gap)`);
      d.log("   would 3: read back that all 5 units are disabled and inactive. Nothing under data/pm-book is removed.");
      return { changed: false, stopped: false, plan };
    }
    if (plan === "push") {
      const next = L.withUnit(mr.map, "home", BY, new Date(d.now()).toISOString());
      if (OWN.pushMap(ssh, RD, OWN.mapBytes(next), vmSha) !== "pushed") throw new Error("pushing the map to the VPS did not land — NOTHING was changed: the recorder is still running there");
      if (next !== mr.map) OWN.writeMap(d.mapFile, next);
      d.log(`   1 map: "${UNIT}": "home" — pushed to the VPS first (read back), then written at home. Every start of the units is now skipped by the ownership gate${equal ? "" : ". (The two maps were not byte-equal: home's, the master, replaced the VPS's)"}`);
    } else if (plan === "adopt") { OWN.writeMap(d.mapFile, half); d.log("   1 map: the VPS already said home; home's map now holds the VPS's bytes"); }
    else d.log("   1 map: both already say home — unchanged");
    if (!/STOPPED/.test(must(ssh(REMOTE.stop(), { timeout: 180000 }), "stopping the units"))) throw new Error("the stop command did not finish — read the units' state: node docs/server/wave7-pm/deploy.cjs --status");
    const us = unitState(), still = UN.ALL_UNITS.filter((u) => us[u].enabled === "enabled" || us[u].active === "active" || us[u].active === "activating");
    if (still.length) throw new Error(`still enabled or active after the stop: ${still.map((u) => `${u} ${us[u].enabled}/${us[u].active}`).join(", ")} — the map already says home (no new start), but look now: ssh traids systemctl status ${still[0]}`);
    d.log(`   2 units: ${on.length ? on.join(", ") + " disabled and stopped" : "none was enabled or active"}; 3 read back: all ${UN.ALL_UNITS.length} disabled and inactive`);
    d.log("   The data stays on the VPS (data/pm-book: every day, archive, summary and the live marker). To record again: node docs/server/wave7-pm/deploy.cjs --step units");
    return { changed: plan !== "none", stopped: true, plan, was: on };
  }

  function units({ dry = false } = {}) {
    d.log(`== --units${dry ? " --dry (the plan; nothing is changed)" : ""}: remove the 5 unit files from ${SYSD}`);
    const { mr, vm } = maps();
    if (mr.map.units[UNIT] === "server" || vm.units[UNIT] === "server") throw new Error(`a map still gives ${UNIT} to the server (home ${JSON.stringify(mr.map.units[UNIT])}, VPS ${JSON.stringify(vm.units[UNIT])}) — REFUSED: run --server first`);
    const us = unitState(), busy = UN.ALL_UNITS.filter((u) => us[u].enabled === "enabled" || us[u].active === "active");
    if (busy.length) throw new Error(`${busy.join(", ")} still enabled or active — REFUSED: run --server first`);
    const have = L.shasOf(ssh, SYSD, UN.ALL_UNITS), present = UN.ALL_UNITS.filter((u) => have.get(u));
    if (dry) { d.log(`   would remove: ${present.length ? present.join(", ") : "nothing (none is installed)"}; then daemon-reload. No other unit, no code, no data.`); return { removed: [] }; }
    if (!present.length) { d.log("   none of the 5 unit files is installed — nothing to do"); return { removed: [] }; }
    if (!/REMOVED/.test(must(ssh(REMOTE.removeUnits(UN.ALL_UNITS)), "removing the unit files"))) throw new Error("the unit files were not removed");
    const after = L.shasOf(ssh, SYSD, UN.ALL_UNITS), left = UN.ALL_UNITS.filter((u) => after.get(u));
    if (left.length) throw new Error(`still there after the removal: ${left.join(", ")}`);
    d.log(`   removed ${present.join(", ")}; daemon-reload done. The code (${L.CODE.map((c) => c.rel).join(", ")}) and data/pm-book stay on the VPS`);
    return { removed: present };
  }
  return { d, server, units, maps };
}

// cases = the selftest's body, given the list every sandbox it makes goes into; the sandboxes' temp folders are taken down in a FINALLY, so a check that throws leaves none behind
function selftest(cases = selftestCases) {
  const boxes = [];
  try { return cases(boxes); } finally { DEP.closeAll(boxes); }
}
function selftestCases(boxes) {
  let pass = 0, fail = 0;
  const ok = (n, c, det) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (det !== undefined ? " — " + String(typeof det === "string" ? det : JSON.stringify(det)).slice(0, 700) : "")); } };
  const err = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const P = (s) => { try { return parseArgs(s.split(" ").filter(Boolean)); } catch (e) { return { err: e.message }; } };
  /** a fake VPS on which the whole deploy has run (the recorder live), plus a few recorded files and another wave's unit */
  const live = () => {
    const b = DEP.sandbox(); boxes.push(b); b.D.stepCopy(); b.D.stepUnits();
    b.V.put(L.PM + "/pm5/2026-10-13/ws.0001.jsonl.gz", Buffer.from("archive bytes")); b.V.put(L.PM + "/pm5/2026-10-13/ARCHIVES.json", "{}"); b.V.put(L.PM + "/summary/2026-10-13.json", '{"final":true}'); b.V.put(L.PM + "/k15/2026-10-14/book.0001.jsonl", "plain rows\n");
    b.V.put(SYSD + "/traids-r309.service", "[Unit]\nDescription=another wave's unit\n"); b.V.S.units.set("traids-r309.service", { enabled: true, active: "active", result: "success" });
    b.R = make({ ssh: b.V.ssh, log: (s) => b.lines.push(s), mapFile: b.mapFile, now: () => b.V.S.clock });
    b.data = () => [...b.V.S.files.entries()].filter(([k]) => k.startsWith(L.PM + "/") && !/status\.json$/.test(k)).map(([k, v]) => k + ":" + PS.sha(v)).sort().join("\n");
    return b;
  };
  ok("args: one of --server / --units / --selftest; --dry only with the first two; an unknown flag is refused before anything runs", /give --server/.test(P("").err || "") && /give one of/.test(P("--server --units").err || "") && /unknown argument/.test(P("--server --force").err || "") && /unknown argument/.test(P("--home").err || "") && /--dry goes with/.test(P("--selftest --dry").err || "") && P("--server --dry").dry === true && P("--units").mode === "units");

  { const b = live(), snap = b.V.snapshot(), mapBytes = fs.readFileSync(b.mapFile), l0 = b.lines.length, r = b.R.server({ dry: true }), text = b.lines.slice(l0).join("\n");
    ok("--server --dry prints the plan (map first, then the health timer, the nightly timer, the recorder; data kept) and changes NOTHING: the VPS and home's map are byte-identical afterwards, the recorder still active", r.plan === "push" && r.changed === false && b.V.snapshot() === snap && fs.readFileSync(b.mapFile).equals(mapBytes) && b.V.unit(SERVICE).active === "active" && /would 1: push "w7-pm": "home" to the VPS \(read back\), then write it at home/.test(text) && /would 2: disable and stop traids-pm-health\.timer, traids-pm-nightly\.timer, then traids-pm-book\.service/.test(text) && /Nothing under data\/pm-book is removed/.test(text), text);
    const data0 = b.data(), seen = [], real = b.V.ssh; b.R.d.ssh = (s, o) => { const m = /^# w7:([a-z-]+)/.exec(s); if (m && m[1] !== "cat" && m[1] !== "unit-state") seen.push(m[1]); else if (/\.host-ownership\.json\.push-/.test(s)) seen.push("map-push"); return real(s, o); };
    const r2 = b.R.server(), m = b.map(), st = JSON.parse(b.V.get(L.PM + "/status.json").toString());
    ok("--server: the MAP FIRST (\"w7-pm\": \"home\" pushed to the VPS, read back, then written at home — both byte-equal, no other unit touched, one history line naming this script), THEN the stop", r2.plan === "push" && seen.join() === "map-push,stop" && m.units[UNIT] === "home" && m.units.r309 === "server" && m.units["w2a-fills"] === "home" && b.V.get(RD + "/host-ownership.json").equals(fs.readFileSync(b.mapFile)) && m.history[m.history.length - 1].by === BY && m.history[m.history.length - 1].to === "home" && m.history.length === 2, { seen, units: m.units });
    ok("--server: all 5 units disabled and inactive (the recorder got its stop: its status says stopped); the other wave's unit is untouched", UN.ALL_UNITS.every((u) => b.V.unit(u).enabled === false && b.V.unit(u).active === "inactive") && st.stopped === "SIGTERM" && b.V.unit("traids-r309.service").active === "active" && b.V.unit("traids-r309.service").enabled === true && r2.was.includes(SERVICE) && r2.was.length === 3, r2);
    ok("--server removes NO data and no file: every recorded day, archive, summary and the live marker on the VPS is byte-identical; the 5 unit files, the code and home's manifest are still there", b.data() === data0 && data0.split("\n").length === 5 && UN.ALL_UNITS.every((u) => b.V.get(SYSD + "/" + u)) && L.CODE.every((c) => b.V.get(L.RB + "/" + c.rel)) && fs.existsSync(path.join(b.tmp, "manifests", L.WAVE + ".json")), b.data());
    const s = L.parseStart(b.V.ssh(REMOTE.start()).out);
    ok("after the rollback a start of the recorder (by hand, a timer, a reboot) is SKIPPED by its real ownership gate — Result=exec-condition, inactive, no page", s.active === "inactive" && s.result === "exec-condition" && b.V.S.pages.length === 0 && b.V.unit(SERVICE).starts === 1, s);
    const pull = PS.pullWave(L.WAVE, { homeDir: b.tmp, manifestDir: path.join(b.tmp, "manifests"), ssh: () => { throw new Error("no ssh for a home-owned unit"); }, mapFile: b.mapFile, haltFile: b.mapFile, writeStatusFile: false });
    ok("after the rollback the standing pull says 'home-owned — not pulled' for the unit and makes no ssh call", pull.exit === 0 && /home-owned — not pulled/.test(pull.lines.join("\n")), pull.lines);
    const pushes = b.V.S.calls.filter((x) => /push-/.test(x)).length, r3 = b.R.server();
    ok("--server again: idempotent — no second map push, the units read back disabled and inactive, nothing else changes", r3.plan === "none" && r3.changed === false && b.V.S.calls.filter((x) => /push-/.test(x)).length === pushes && b.data() === data0);
    // --units
    const d1 = b.R.units({ dry: true }), stillThere = UN.ALL_UNITS.every((u) => b.V.get(SYSD + "/" + u)), d2 = b.R.units();
    ok("--units (after --server): --dry removes nothing; the real run removes exactly the 5 unit files of this package — the other wave's unit file, the code and the data stay", d1.removed.length === 0 && stillThere && d2.removed.length === 5 && UN.ALL_UNITS.every((u) => !b.V.get(SYSD + "/" + u)) && !!b.V.get(SYSD + "/traids-r309.service") && !!b.V.get(SYSD + "/traids-alert@.service") && b.data() === data0 && L.CODE.every((c) => b.V.get(L.RB + "/" + c.rel)), d2);
    ok("--units again: nothing installed, nothing to do", b.R.units().removed.length === 0);
    // deploy again after a full rollback
    b.D.d.ssh = b.V.ssh; const liveBefore = JSON.parse(b.V.get(L.PM + "/live.json").toString()).liveAt, ru = b.D.stepUnits();
    ok("recording again after a rollback is the deploy's units step: the map goes back to \"server\" on both, the units are installed again, the recorder runs — and the FIRST liveAt stands (the marker is kept)", ru.how === "kept" && ru.liveAt === liveBefore && b.map().units[UNIT] === "server" && b.V.get(RD + "/host-ownership.json").equals(fs.readFileSync(b.mapFile)) && b.V.unit(SERVICE).active === "active" && JSON.parse(b.V.get(L.PM + "/status.json").toString()).stopped === undefined && ru.installed === 5 && ru.health === "PASS" && b.data() === data0, ru); }

  { const b = live(), e1 = err(() => b.R.units());
    ok("--units while the recorder is live -> REFUSED ('run --server first'): nothing removed", /still gives w7-pm to the server .* — REFUSED: run --server first/.test(e1 || "") && UN.ALL_UNITS.every((u) => b.V.get(SYSD + "/" + u)) && b.V.unit(SERVICE).active === "active", e1);
    b.V.S.down = true; const mapBytes = fs.readFileSync(b.mapFile), e2 = err(() => b.R.server()); b.V.S.down = false;
    ok("--server with the VPS unreachable -> exit path 'NOTHING was changed': home's map is untouched (it would otherwise say home while the recorder still runs), and the message says the recorder still runs", /the VPS cannot be read, so NOTHING was changed on either machine: if the recorder was running there, it still is/.test(e2 || "") && fs.readFileSync(b.mapFile).equals(mapBytes) && b.V.unit(SERVICE).active === "active", e2);
    b.V.S.sudo = false; const e3 = err(() => b.R.server()); b.V.S.sudo = true;
    ok("--server when the map push does not land on the VPS -> NOTHING changed: home's map untouched, the units not stopped", /did not land — NOTHING was changed/.test(e3 || "") && fs.readFileSync(b.mapFile).equals(mapBytes) && b.V.unit(SERVICE).active === "active" && b.V.S.calls.filter((x) => /^# w7:stop/.test(x)).length === 0, e3);
    // half done: the VPS map was pushed, home's was not written (the PC died in between)
    const next = L.withUnit(JSON.parse(mapBytes.toString()), "home", BY, "2026-10-13T01:00:00.000Z"); b.V.put(RD + "/host-ownership.json", OWN.mapBytes(next), "0444");
    const pushes = b.V.S.calls.filter((x) => /push-/.test(x)).length, r4 = b.R.server();
    ok("a rollback that was cut short (the VPS already says home, home's map does not): the next --server finishes it — home takes the VPS's exact bytes, no second push, the units are stopped", r4.plan === "adopt" && fs.readFileSync(b.mapFile).equals(b.V.get(RD + "/host-ownership.json")) && b.map().units[UNIT] === "home" && b.V.S.calls.filter((x) => /push-/.test(x)).length === pushes && UN.ALL_UNITS.every((u) => b.V.unit(u).active === "inactive"), r4); }

  { const b = live(), vm = JSON.parse(b.V.get(RD + "/host-ownership.json").toString()); vm.units["w1-whales"] = "home"; b.V.put(RD + "/host-ownership.json", OWN.mapBytes(vm), "0444");
    const mapBytes = fs.readFileSync(b.mapFile), e = err(() => b.R.server());
    ok("the two maps differ in ANOTHER unit -> REFUSED, nothing changed: that is own.cjs's to settle, never this script's", /the two maps differ in w1-whales .* — REFUSED \(nothing changed\)/.test(e || "") && fs.readFileSync(b.mapFile).equals(mapBytes) && b.V.unit(SERVICE).active === "active", e);
    const eOther = e || "";
    ok("…and that refusal names what settles it: the mover's own command for the wave of the last move in home's map (home's map is the master), both maps side by side, and how to stop the recorder meanwhile without touching either map", /node deploy\/server\/own\.cjs <wave> home \(while home owns that wave's units\), or node deploy\/server\/own\.cjs <wave> server/.test(eOther) && /node deploy\/server\/own\.cjs --status <wave>/.test(eOther) && /Then run this again/.test(eOther) && /sudo systemctl disable --now traids-pm-health\.timer traids-pm-nightly\.timer traids-pm-book\.service/.test(eOther), eOther);
    // THE TWO MAP STATES THE STOP USED TO REFUSE IN (the review of 2026-10-12): home's map is the master, so both are settled by this one command
    { const a = live(), hm = a.map();   // (a) both maps give w7-pm to the server and agree on every owner; home's holds two more history lines
      hm.history.push({ at: "2026-10-13T20:00:00.000Z", wave: "w2a", to: "server", units: ["w2a-fills"], by: "deploy/server/own.cjs" }, { at: "2026-10-13T20:00:07.000Z", wave: "w2a", to: "home", units: ["w2a-fills"], by: "deploy/server/own.cjs", aborted: "seed: its lock on the VPS is held" }); hm.updatedAt = "2026-10-13T20:00:07.000Z"; OWN.writeMap(a.mapFile, hm);
      a.V.S.sudo = false; const twoMaps = () => PS.sha(fs.readFileSync(a.mapFile)) + " " + PS.sha(a.V.get(RD + "/host-ownership.json")), maps0 = twoMaps(), eNo = err(() => a.R.server()); a.V.S.sudo = true;
      ok("in that state a map push that does not land on the VPS changes NOTHING: both maps as they were (still different from each other), no stop sent, the recorder still running — and the message says so", /pushing the map to the VPS did not land — NOTHING was changed: the recorder is still running there/.test(eNo || "") && twoMaps() === maps0 && a.V.S.calls.filter((x) => /^# w7:stop/.test(x)).length === 0 && a.V.unit(SERVICE).active === "active", eNo);
      const vpsBefore = JSON.parse(a.V.get(RD + "/host-ownership.json").toString()), seen = [], real = a.V.ssh; a.R.d.ssh = (s, o) => { const m = /^# w7:([a-z-]+)/.exec(s); if (m && m[1] !== "cat" && m[1] !== "unit-state") seen.push(m[1]); else if (/\.host-ownership\.json\.push-/.test(s)) seen.push("map-push"); return real(s, o); };
      const l0 = a.lines.length, dry = a.R.server({ dry: true }), dryText = a.lines.slice(l0).join("\n"), r = a.R.server(), m = a.map();
      ok("STATE (a) — both maps give w7-pm to the server and agree on every owner, but home's map holds two history lines the VPS's does not (another wave's cutover that aborted: written twice at home, never pushed): --server is NOT refused. Home's map, the master, goes to the VPS with \"w7-pm\": \"home\" and is then written at home — both byte-equal afterwards, the other wave's two lines kept, no owner of another unit changed — and the recorder is stopped", vpsBefore.units[UNIT] === "server" && vpsBefore.history.length === 1 && dry.plan === "push" && dry.changed === false && /home's map is the master: it replaces the VPS's/.test(dryText) && r.plan === "push" && r.stopped === true && seen.join() === "map-push,stop" && m.units[UNIT] === "home" && m.units["w2a-fills"] === "home" && m.units.r309 === "server" && m.history.length === 4 && m.history[1].wave === "w2a" && m.history[2].aborted === "seed: its lock on the VPS is held" && m.history[3].by === BY && m.history[3].to === "home" && a.V.get(RD + "/host-ownership.json").equals(fs.readFileSync(a.mapFile)) && UN.ALL_UNITS.every((u) => a.V.unit(u).enabled === false && a.V.unit(u).active === "inactive") && JSON.parse(a.V.get(L.PM + "/status.json").toString()).stopped === "SIGTERM", { dry, r, seen, units: m.units, history: m.history.map((x) => x.wave + ">" + x.to) }); }
    { const c = DEP.sandbox(); boxes.push(c); c.D.stepCopy();   // (b) the units step pushed the map to the VPS and died before home's map was written
      const homeBytes = fs.readFileSync(c.mapFile), pushed = L.withUnit(c.map(), "server", DEP.BY, "2026-10-12T18:30:00.000Z"); c.V.put(RD + "/host-ownership.json", OWN.mapBytes(pushed), "0444");
      const Rb = make({ ssh: c.V.ssh, log: (s) => c.lines.push(s), mapFile: c.mapFile, now: () => c.V.S.clock }), rb = Rb.server(), m = c.map();
      ok("STATE (b) — the VPS map names \"w7-pm\": \"server\" and home's map does not name the unit at all (the units step pushed the map and died before home's was written): --server is NOT refused. Home's map goes to the VPS with \"w7-pm\": \"home\" and is written at home — both byte-equal, both say home, one history line by this script — and the stop is sent (no unit was installed: all 5 read back disabled and inactive)", !("w7-pm" in JSON.parse(homeBytes.toString()).units) && rb.plan === "push" && rb.stopped === true && rb.was.length === 0 && m.units[UNIT] === "home" && m.history.length === 1 && m.history[0].by === BY && c.V.get(RD + "/host-ownership.json").equals(fs.readFileSync(c.mapFile)) && c.V.S.calls.filter((x) => /^# w7:stop/.test(x)).length === 1 && c.V.S.calls.filter((x) => /\.host-ownership\.json\.push-/.test(x)).length === 1, { rb, units: m.units, history: m.history });
      // …and the mirror of it: home says home (a rollback), the VPS says server with ANOTHER history (not this command's own half): home's map is pushed as it is
      const d2 = live(); d2.R.server(); const vm = JSON.parse(d2.V.get(RD + "/host-ownership.json").toString()); vm.units[UNIT] = "server"; vm.history.push({ at: "2026-10-14T01:00:00.000Z", wave: "w7-pm", to: "server", units: [UNIT], by: "someone, by hand" }); d2.V.put(RD + "/host-ownership.json", OWN.mapBytes(vm), "0444");
      const hb = fs.readFileSync(d2.mapFile), r2 = d2.R.server();
      ok("home's map says \"home\" and the VPS's says \"server\" again (a map that was changed there, not by this package): --server pushes home's map as it is — the VPS holds home's exact bytes again, home's file is untouched — and reads the units back stopped", r2.plan === "push" && d2.V.get(RD + "/host-ownership.json").equals(hb) && fs.readFileSync(d2.mapFile).equals(hb) && d2.map().units[UNIT] === "home" && UN.ALL_UNITS.every((u) => d2.V.unit(u).active === "inactive"), r2); }
    const never = DEP.sandbox(); boxes.push(never); const R0 = make({ ssh: never.V.ssh, log: (s) => never.lines.push(s), mapFile: never.mapFile }), r0 = R0.server();
    ok("--server where the unit was never deployed (in neither map): nothing to do, nothing changed, no stop sent", r0.changed === false && r0.stopped === false && /never deployed — nothing to do/.test(never.text()) && never.V.S.calls.filter((x) => /^# w7:stop|push-/.test(x)).length === 0);
    const src = fs.readFileSync(__filename, "utf8").split("\nfunction selftest")[0];
    ok("the rollback's code names no registry or ledger file, removes nothing under data/, and sends no rm of its own (the only one is w7-lib's removal of the 5 unit files)", !/test-registry|read-seals|change-registry|agent-ledger/.test(src) && !/\brm -|unlink|rmSync|rmdir/.test(src) && /REMOTE\.removeUnits\(UN\.ALL_UNITS\)/.test(src)); }

  // THE STOP IS BELIEVED ONLY ON ITS READ-BACK (the review of 2026-10-12). Every command of the stop script ends "|| true" and the
  // script prints STOPPED whatever happened, so the units' state read afterwards is the only thing that catches a stop that did not
  // stop. The fake VPS acts on the unit names the script holds, and does nothing when sudo refuses systemctl.
  { const b = live(); b.V.S.systemctlRefused = true;   // sudo lets the map push through (chown, chmod) and refuses systemctl
    let stopOut = null; const real = b.V.ssh; b.R.d.ssh = (s, o) => { const r = real(s, o); if (/^# w7:stop/.test(s)) stopOut = r.out; return r; };
    const e = err(() => b.R.server()) || "", m = b.map(), stBefore = JSON.parse(b.V.get(L.PM + "/status.json").toString());
    ok("THE STOP IS SENT AND NOTHING STOPS (sudo on the VPS refuses systemctl; the script prints STOPPED all the same): --server FAILS at its read-back and names what is still up — traids-pm-book.service enabled/active, and both timers — says the map already says home (no new start) and where to look. Both maps do say home, byte-equal; it never says 'all 5 disabled and inactive'",
      stopOut === "STOPPED\n" && /^still enabled or active after the stop: traids-pm-book\.service enabled\/active, traids-pm-nightly\.timer enabled\/active, traids-pm-health\.timer enabled\/active — the map already says home \(no new start\), but look now: ssh traids systemctl status traids-pm-book\.service$/.test(e)
      && m.units[UNIT] === "home" && b.V.get(RD + "/host-ownership.json").equals(fs.readFileSync(b.mapFile)) && b.V.unit(SERVICE).active === "active" && stBefore.stopped === undefined && !b.lines.some((l) => /read back: all 5 disabled and inactive/.test(l)), e);
    b.V.S.clock += 61000; const us1 = L.parseUnitState(b.V.ssh(REMOTE.unitState(UN.ALL_UNITS)).out), st1 = JSON.parse(b.V.get(L.PM + "/status.json").toString()), eAgain = err(() => b.R.server()) || "";
    ok("…and the recorder does not record on unwatched in that state: it re-reads the map itself, and a minute after the map push it has stopped BY ITSELF — inactive (a clean exit: not failed, no restart, no page), its status marked 'not server-owned', still enabled — although no systemctl command ever reached it. --server run again while sudo still refuses fails again, and counts the recorder as not stopped while it is still ENABLED ('enabled/inactive')", us1[SERVICE].active === "inactive" && us1[SERVICE].enabled === "enabled" && /^not server-owned \(w7-pm is home-owned — skipped/.test(st1.stopped || "") && b.V.unit(SERVICE).result === "success" && b.V.S.pages.length === 0 && b.V.unit(SERVICE).starts === 1
      && /^still enabled or active after the stop: traids-pm-book\.service enabled\/inactive, traids-pm-nightly\.timer enabled\/active, traids-pm-health\.timer enabled\/active — /.test(eAgain), { us: us1[SERVICE], stopped: st1.stopped, eAgain });
    b.V.S.systemctlRefused = false; const r2 = b.R.server();
    ok("--server again once sudo lets systemctl through: the maps are left as they are (both say home), the stop does stop, and the read-back is clean — all 5 disabled and inactive", r2.plan === "none" && r2.stopped === true && UN.ALL_UNITS.every((u) => b.V.unit(u).enabled === false && b.V.unit(u).active === "inactive") && b.lines.some((l) => /3 read back: all 5 disabled and inactive/.test(l)), r2); }
  { const b = live(); b.V.S.stuck.add(SERVICE);   // systemd answers the stop with exit 0 and the recorder's process is still there
    const e = err(() => b.R.server()) || "";
    ok("THE STOP IS SENT AND THE RECORDER IS STILL ACTIVE (both timers stopped, the recorder disabled, its process still up): --server FAILS and names exactly it — 'traids-pm-book.service disabled/active' and no other unit",
      /^still enabled or active after the stop: traids-pm-book\.service disabled\/active — the map already says home/.test(e) && b.V.unit(SERVICE).active === "active" && b.V.unit(SERVICE).enabled === false && L.TIMERS.every((t) => b.V.unit(t).active === "inactive" && b.V.unit(t).enabled === false) && b.map().units[UNIT] === "home" && !b.lines.some((l) => /read back: all 5 disabled and inactive/.test(l)), e); }

  // THE SHARED MOVER REFUSES THIS UNIT (the review of 2026-10-12: its `w7-pm home` went through, and the recorder recorded on unwatched)
  { const b = live(), snap = b.V.snapshot(), mapBytes = fs.readFileSync(b.mapFile), calls = b.V.S.calls.length, mdir = path.join(b.tmp, "manifests");
    const deps = (o = {}) => ({ homeDir: b.tmp, manifestDir: mdir, ssh: b.V.ssh, log: (s) => b.lines.push(s), procs: [], now: () => b.V.S.clock, ...o });
    const eHome = err(() => OWN.rollbackHome(L.WAVE, deps())), eSrv = err(() => OWN.cutover(L.WAVE, deps())), eDown = err(() => OWN.rollbackHome(L.WAVE, deps({ serverDown: true, acceptLost: true, acceptGaps: true }))), eDry = err(() => OWN.rollbackHome(L.WAVE, deps({ dry: true })));
    ok("THE SHARED MOVER REFUSES THIS UNIT — to home, to the server, on its emergency path and in its dry run: deploy/server/own.cjs's own functions, given the installed manifest (fixedOwner \"server\"), answer 'w7-pm has a fixed owner — own.cjs never moves it' before they read a map or call the VPS. Nothing changes anywhere: both maps still give w7-pm to the server and the recorder keeps recording, with its health check, its nightly compress and the pull. (Before: `own.cjs w7-pm home` went through, both maps said home, the recorder recorded on, and that same map made the three of them skip.)",
      [eHome, eSrv, eDown, eDry].every((x) => /^wave w7-pm: w7-pm has a fixed owner — own\.cjs never moves it$/.test(x || "")) && b.V.S.calls.length === calls && b.V.snapshot() === snap && fs.readFileSync(b.mapFile).equals(mapBytes) && b.map().units[UNIT] === "server" && b.V.unit(SERVICE).active === "active" && PS.loadManifest(L.WAVE, mdir).units[UNIT].fixedOwner === "server", [eHome, eSrv, eDown, eDry]);
    // the pull with that manifest: the map's entry still decides; only a map that does not name the unit falls to the fixed owner
    const c = DEP.sandbox(); boxes.push(c); c.D.stepCopy(); c.D.installManifest();
    const pull = PS.pullWave(L.WAVE, { homeDir: c.tmp, manifestDir: path.join(c.tmp, "manifests"), ssh: c.V.ssh, mapFile: c.mapFile, haltFile: c.mapFile, writeStatusFile: false });
    ok("the standing pull with a fixed owner: where home's map does not name the unit at all (a units step cut short after it installed the manifest) the pull looks on the server, finds none of the unit's files, writes nothing and exits 0; where the map names it, the map decides as before (\"home\" -> 'home-owned — not pulled', shown above; \"server\" -> pulled)", !("w7-pm" in c.map().units) && pull.exit === 0 && pull.units[UNIT].owner === "server" && /^w7-pm: no change \(0 server file\(s\)\)/.test(pull.lines[0] || "") && !fs.existsSync(path.join(c.tmp, "pm-book")), pull); }

  { const made = []; let threw = null;   // no temp folder is left behind, also when a check throws (the review of 2026-10-12)
    try { selftest((bs) => { for (let i = 0; i < 2; i++) { const s = DEP.sandbox(); bs.push(s); made.push(s.tmp); } throw new Error("a check threw"); }); } catch (e) { threw = e.message; }
    ok("a selftest whose body THROWS leaves no temp folder behind: the two sandboxes it had made are gone (the cleanup is in a finally), and the error still reaches the caller", threw === "a check threw" && made.length === 2 && made.every((dir) => !fs.existsSync(dir)), { threw, left: made.filter((dir) => fs.existsSync(dir)) }); }

  console.log(`rollback selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;   // (the sandboxes are taken down by selftest()'s finally, whether this line is reached or not)
}

if (require.main === module) {
  let A; try { A = parseArgs(process.argv.slice(2)); } catch (e) { console.error("rollback: " + e.message); process.exitCode = 2; }
  if (A) try {
    if (A.mode === "selftest") process.exitCode = selftest() ? 0 : 1;
    else { const R = make(); if (A.mode === "server") R.server({ dry: A.dry }); else R.units({ dry: A.dry }); process.exitCode = 0; }
  } catch (e) { console.error("rollback: REFUSED or FAILED — " + e.message); process.exitCode = 1; }
}
module.exports = { make, parseArgs, otherUnitsDiffer, BY };
