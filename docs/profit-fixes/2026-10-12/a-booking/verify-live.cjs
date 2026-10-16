#!/usr/bin/env node
/**
 * PROFIT FIXES A (booking correctness) — VERIFY LIVE. 2026-10-12 (docs/profit-fixes/2026-10-12/a-booking). READ-ONLY, for after the apply.
 *
 *   node docs/profit-fixes/2026-10-12/a-booking/verify-live.cjs                 reads files only; no network, no write
 *   node docs/profit-fixes/2026-10-12/a-booking/verify-live.cjs --probe-gate    also asks the running board server (:3001) what its gate
 *                                                                                does with an equity ticket that has no spread stamp:
 *                                                                                ONE dry run of the board POST (the server writes no row,
 *                                                                                no counter and no audit line for a dry run — the same
 *                                                                                call backend/terminal-smoke.js makes)
 *
 * Every line ends PASS, FAIL or UNKNOWN. UNKNOWN is never dressed as a pass: it means the thing has not happened yet (no entry run, no
 * settle, no restart since the apply) or could not be read, and the line says which and when it can be known. A check that throws is
 * UNKNOWN with its error. Exit 1 when any line is FAIL, else 0; the last line counts all three.
 *
 * WHAT IT READS
 *   the seven files           applied / not applied / drift, node --check, and whether each is still the bytes the apply wrote
 *   4.1  proposals-sleeve.json   the kill on the record; no ticket of a killed list in any session booked after the apply. "Killed" is
 *        the record the fixed runner keeps (the one look at a list's first bar.interimSessions sessions). The sleeve's own verdict line
 *        also prints KILLED when a list crosses the line at a later count; that list is NOT stopped by this package, and is named
 *   4.2  the board, the ledger, the tombstones, the change registry: the twelve off the board, one row each at its pinned figure, one
 *        registry row with breaksComparability true; and the two debit spreads that expire 2026-10-16, once that night has passed
 *   4.3  the gate library on disk (and that the two registered gates are asked before the stamp); the entry run's own "SPREAD STAMP
 *        GATE" lines since the apply; any live equity ticket opened since the apply with no usable stamp; with --probe-gate, the
 *        running server's answer; the fix's own change-registry row (written after the restart by record-stamp-gate-row.cjs)
 *   4.7  spot at entry on wings entered since the apply (and wing.spot still null: the width gate was not switched on); the official
 *        close on wings settled since the apply; exit fields on early closes since the apply
 */
"use strict";
const fs = require("fs"), path = require("path");
const L = require("./lib.cjs"), T = require("./twelve.cjs"), S = require("./settle-expired-twelve.cjs"), R43 = require("./record-stamp-gate-row.cjs");
const readJ = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

/** verify({ probe }) -> { exit, rows: [{ verdict, name, detail }] }. The command line passes only `probe`; the selftest passes a temp root, state folder and clock. */
async function verify({ root = L.REPO, stateDir = L.PKG, nowMs = undefined, probe = false, log = console.log } = {}) {
  const D = (f) => path.join(root, "backend", "data", f), clock = () => (nowMs === undefined ? Date.now() : nowMs);
  const rows = [];
  const line = (verdict, name, detail) => { rows.push({ verdict, name, detail: detail || "" }); log(`  ${verdict.padEnd(7)} ${name}${detail ? ` — ${detail}` : ""}`); };
  const guard = async (name, fn) => { try { await fn(); } catch (e) { line("UNKNOWN", name, `could not be checked (${String(e.message).slice(0, 160)})`); } };
  const state = L.readState(stateDir) || { files: {} };
  const appliedAt = (rel) => { const r = (state.files || {})[rel]; if (r && r.appliedAt) return Date.parse(r.appliedAt); try { return fs.statSync(L.abs(root, rel)).mtimeMs; } catch { return NaN; } };
  const isApplied = {};
  log(`${L.PKG_NAME} — VERIFY LIVE (read-only) — ${L.mtNow(clock()).hms} MT ${L.mtNow(clock()).dow} ${L.mtNow(clock()).date}`);

  log("\nthe seven files");
  for (const e of L.ENTRIES) await guard(e.rel, async () => {
    const s = L.stateOf(e, root), rec = (state.files || {})[e.rel];
    isApplied[e.rel] = s.state === "applied";
    if (s.state === "drift") return line("FAIL", e.rel, `DRIFT — ${s.why}`);
    if (s.state === "base") return line("UNKNOWN", e.rel, `not applied (fix ${e.fixes.join("+")}); the checks of that fix below say so too`);
    const bad = L.nodeCheckFile(L.abs(root, e.rel)); if (bad) return line("FAIL", e.rel, `applied but node --check fails: ${bad}`);
    line("PASS", e.rel, `applied${rec ? (s.sha === rec.postSha ? `, exactly as the apply wrote it on ${rec.appliedAt}` : `; edited elsewhere since the apply of ${rec.appliedAt} (our lines are intact)`) : " (no apply record in this folder)"}${e.restart ? ` · takes effect after a restart of ${e.restart.split(" — ")[0]}` : ""}`);
  });

  log("\nfix 4.1 — the killed list is not booked");
  await guard("the proposals sleeve", async () => {
    const rel = "backend/proposals-sleeve.js"; if (!isApplied[rel]) return line("UNKNOWN", "the kill on the record", "backend/proposals-sleeve.js is not applied");
    const st = readJ(D("proposals-sleeve.json")), at = appliedAt(rel), k = st.killedCategories || {}, killedNow = Object.entries(st.verdictByCategory || {}).filter(([, v]) => /^KILLED/.test(String(v))).map(([c]) => c);
    const ranSince = Date.parse(st.asOf || "") > at, onRecord = (c) => Object.prototype.hasOwnProperty.call(k, c);
    // a list the verdict line calls KILLED that is NOT on the record crossed the line after its first look: by design it is still booked
    const later = killedNow.filter((c) => !onRecord(c));
    if (Object.keys(k).length) line("PASS", "the kill on the record", Object.entries(k).map(([c, v]) => `'${c}' killed at the session of ${v.killedAt} (t ${v.t} on ${v.sessions} sessions)`).join("; ") + (later.length ? `; NOT stopped, by design: ${later.map((c) => `'${c}'`).join(", ")} — the sleeve's verdict line reads KILLED there now (${later.map((c) => String(st.verdictByCategory[c]).split(" — ")[1] || "?").join("; ")}), a crossing after the first look, which this package does not act on (NOTES.md, 4.1)` : ""));
    else if (killedNow.length && ranSince) line("FAIL", "the kill on the record", `the sleeve settled at ${st.asOf}, after the apply, and reads ${killedNow.join(", ")} as KILLED, but wrote no killedCategories — a kill at a list's first look must be on the record (a list whose verdict line turned KILLED only at a later session count is not stopped by this package and needs none: NOTES.md, 4.1)`);
    else line("UNKNOWN", "the kill on the record", `no booking or settle has run since the apply (store as of ${st.asOf || "?"}); the next one writes it — the 07:40 MT booking or the close chain`);
    const post = Object.values(st.sessions || {}).filter((s) => s && (s.tickets || []).some((t) => Date.parse(t.bookedAt || "") > at));
    const killed = new Set(Object.keys(k).length ? Object.keys(k) : killedNow), leak = post.flatMap((s) => (s.tickets || []).filter((t) => Date.parse(t.bookedAt || "") > at && (t.categories || []).some((c) => killed.has(c))).map((t) => `${s.date} ${t.sym}`));
    if (!post.length) line("UNKNOWN", "no ticket of a killed list since the apply", "no session has been booked since the apply; the next booking is 07:40 MT on the next trading day");
    else if (leak.length) line("FAIL", "no ticket of a killed list since the apply", `${leak.length} ticket(s) of a killed list were booked after the apply: ${leak.slice(0, 8).join(", ")}`);
    else line("PASS", "no ticket of a killed list since the apply", `${post.length} session(s) booked since, ${post.reduce((a, s) => a + (s.tickets || []).length, 0)} ticket(s), none of a killed list; ${post.reduce((a, s) => a + (s.killedNotBooked || []).length, 0)} proposal(s) of a killed list left unbooked`);
  });

  log("\nfix 4.2 — the twelve expired spreads");
  await guard("the one-time settle", async () => {
    const pl = S.plan({ root, closes: S.pinnedCloses(clock()), nowMs: clock() }), states = pl.items.map((x) => x.state), uniq = [...new Set(states)];
    if (uniq.length === 1 && uniq[0] === "open") return line("UNKNOWN", "the twelve are settled", `the one-time settle has not run: all twelve are still open on the board (max loss $${T.TOTALS.riskDollars.toLocaleString("en-US")}; it would book ${pl.booked})`);
    if (!states.every((s) => s === "done")) return line("FAIL", "the twelve are settled", `not all twelve are settled and off the board: ${pl.items.map((x) => `${x.s.sym} ${x.state}`).join(", ")}`);
    const tlog = readJ(D("trade_log.json")), ours = T.SPREADS.map((s) => ({ s, r: tlog.filter((t) => t && t.id === s.id && S.isOurs(t)) })), wrong = ours.filter((x) => x.r.length !== 1 || x.r[0].pnl !== x.s.pnl);
    const total = Math.round(ours.reduce((a, x) => a + (x.r[0] ? x.r[0].pnl : 0), 0) * 100) / 100;
    if (wrong.length) line("FAIL", "the twelve are settled", `${wrong.length} spread(s) are not in the ledger exactly once at the pinned figure: ${wrong.map((x) => `${x.s.sym} (${x.r.map((r) => r.pnl).join(",") || "no row"}, pinned ${x.s.pnl})`).join("; ")}`);
    else line("PASS", "the twelve are settled", `each is in the ledger once at its pinned figure, off the board and tombstoned; booked ${total} (pinned ${T.TOTALS.pnl})`);
    const cr = readJ(D("change-registry.json")).filter((x) => x && x.id === T.CR_ID);
    if (cr.length === 1 && cr[0].breaksComparability === true && cr[0].result && cr[0].result.before && cr[0].result.after) line("PASS", "the change-registry row", `${T.CR_ID}: breaksComparability true; signal ledger ${cr[0].result.before.signalsUsd} -> ${cr[0].result.after.signalsUsd}; open option spreads on the board ${cr[0].result.before.openNonControlOptionsOnBoard} -> ${cr[0].result.after.openNonControlOptionsOnBoard}`);
    else line("FAIL", "the change-registry row", `${cr.length} row(s) with id ${T.CR_ID}${cr.length === 1 ? " — but not marked breaksComparability true with before/after totals" : ""}`);
    const G = require(path.join(root, "backend", "lib", "reconcile.js")).cleanEraLedger(), inCanon = T.IDS.filter((id) => G.signals.some((t) => t.id === id && S.isOurs(t))).length;
    line(inCanon === 12 ? "PASS" : "FAIL", "the canonical ledger counts them", `${inCanon} of 12 are signal rows of lib/reconcile.js cleanEraLedger(); ${G.retiredExcluded} retired row(s) excluded as before`);
  });
  await guard("the nightly settle on the next debit spreads", async () => {
    if (!isApplied["backend/options-settle.js"]) return line("UNKNOWN", "the cause is fixed for the next ones", "backend/options-settle.js is not applied; two more debit spreads (MANH, AMD) expire 2026-10-16 and would stay on the board as these did");
    const FX = readJ(path.join(L.PKG, "fixtures", "twelve.json")).notYetExpired, board = readJ(D("board_positions.json")), tlog = readJ(D("trade_log.json")), now = L.etNow(clock());
    for (const p of FX) {
      const exp = /(\d{2})(\d{2})(\d{2})[CP]\d{8}$/.exec(p.occAtm), day = exp ? `20${exp[1]}-${exp[2]}-${exp[3]}` : null, open = board.some((q) => q && q.id === p.id), row = tlog.find((t) => t && t.id === p.id && t.reason === "expiry");
      if (!day) line("UNKNOWN", `${p.sym} debit spread`, "its expiry could not be read");
      else if (now.date < day || (now.date === day && now.mins < 18 * 60 + 30)) line("UNKNOWN", `${p.sym} debit spread (expires ${day})`, `not yet expired and settled; it can be known after the close chain of ${day} (about 18:30 ET)${open ? "" : " — it is already off the board"}`);
      else if (row && !open) line("PASS", `${p.sym} debit spread (expired ${day})`, `settled by the nightly settle at ${row.pnl} (worth ${row.exit}, paid ${row.entry}), off the board`);
      else if (!open && !row) line("UNKNOWN", `${p.sym} debit spread (expired ${day})`, "off the board with no expiry row: it was closed some other way before expiry");
      else line("FAIL", `${p.sym} debit spread (expired ${day})`, "past its expiry night and still on the board — the nightly settle did not settle it");
    }
  });

  log("\nfix 4.3 — no usable spread stamp is a refusal");
  await guard("the stamp gate", async () => {
    const rel = "backend/lib/enforcement-gates.js"; if (!isApplied[rel]) return line("UNKNOWN", "the gate on disk", "backend/lib/enforcement-gates.js is not applied");
    const G = require(L.abs(root, rel)), now = clock(), tk = (obs) => ({ id: "v", cls: "Equity", sym: "SPY", dir: 1, addedAt: now, entryAsOf: now, obs });
    const a = G.evaluateGates(tk({}), [], now), b = G.evaluateGates(tk({ spreadBps: 99 }), [], now), c = G.evaluateGates(tk({ spreadBps: 101 }), [], now);
    // the order on disk: the registered gates are asked first — a stale stamp over 100 bps is still R49's refusal, an unstamped ticket in a held group still R53's
    const d = G.evaluateGates({ ...tk({ spreadBps: 150 }), entryAsOf: now - 60 * 60e3, addedAt: now - 60 * 60e3 }, [], now);
    const held = ["XLK", "SPY", "AAPL", "MSFT", "XLF", "QQQ"].find((s) => G.groupTokens({ cls: "Equity", sym: s, dir: 1 }).length);   // a symbol the sector map gives a factor group
    const e = held ? G.evaluateGates({ ...tk({}), sym: held }, [{ id: "h", cls: "Equity", sym: held, dir: 1, addedAt: now - 3600e3, ctrl: false, vetoShadow: false }], now) : undefined;
    line(a && a.test === "STAMP" && b === null && c && c.test === "R49" && d && d.test === "R49" && (!held || (e && e.test === "R53")) ? "PASS" : "FAIL", "the gate on disk", `no stamp -> ${a ? a.veto : "passes"}; 99 bps -> ${b ? b.veto : "passes"}; 101 bps -> ${c ? c.veto : "passes"}; a stale stamp at 150 bps -> ${d ? d.veto : "passes"}; ${held ? `no stamp in a group a live ticket holds (${held}) -> ${e ? e.veto : "passes"}` : "the R53 order was not checked (no symbol tried has a factor group in the sector map)"}`);
    const at = appliedAt(rel), board = readJ(D("board_positions.json"));
    const fresh = board.filter((p) => p && p.cls === "Equity" && !p.sleeve && Number(p.addedAt) > at), refused = fresh.filter((p) => p.vetoShadow && p.veto === G.STAMP_VETO), live = fresh.filter((p) => !p.ctrl && !p.vetoShadow && !G.spreadStamp({ ...p, entryAsOf: now, addedAt: now }, now).ok);
    if (live.length) line("FAIL", "the running server enforces it", `${live.length} equity ticket(s) opened since the apply are LIVE with no usable spread stamp (${live.slice(0, 8).map((p) => p.sym).join(", ")}): :3001 has not loaded the fix — restart owed, outside 06:45-14:15 MT`);
    else if (refused.length) line("PASS", "the running server enforces it", `${refused.length} equity ticket(s) on the board since the apply carry the veto "${G.STAMP_VETO}"; none is live without a stamp`);
    else line("UNKNOWN", "the running server enforces it", `${fresh.length} equity ticket(s) opened since the apply, none without a stamp, so the board cannot show it either way${probe ? "" : "; --probe-gate asks the server directly"}`);
    let text = ""; try { const f = path.join(root, "automation", "daily-run.log"), sz = fs.statSync(f).size, fd = fs.openSync(f, "r"), n = Math.min(sz, 400000), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, sz - n); fs.closeSync(fd); text = buf.toString("utf8"); } catch {}
    const said = text.split(/\r?\n/).filter((l) => /SPREAD STAMP GATE:|went through LIVE with NO usable spread stamp/.test(l)).filter((l) => Date.parse(l.slice(0, 19).replace(" ", "T") + "Z") > at);
    if (!said.length) line("UNKNOWN", "the entry run says so", "no entry run has printed a SPREAD STAMP GATE line since the apply (the next open run is 07:35 MT on a trading day)");
    else if (said.some((l) => /went through LIVE/.test(l))) line("FAIL", "the entry run says so", `the entry run warned: ${said.filter((l) => /went through LIVE/.test(l)).pop().slice(20, 220).trim()}`);
    else line(/UNKNOWN/.test(said[said.length - 1]) ? "UNKNOWN" : "PASS", "the entry run says so", said[said.length - 1].slice(20, 220).trim());
    if (probe) {
      const RP = require(path.join(root, "backend", "lib", "risk-policy.js"));
      const body = { positions: [{ id: "verify-nostamp-" + now, cls: "Equity", sym: "SPY", name: "SPY", dir: 1, addedAt: now, entryAsOf: now, strategy: "Terminal", manual: true, entry: 500, signalEntry: 500, stop: 495, target: 510, stopDist: 5, units: 50, dollarPerPoint: 1, riskDollars: 250, riskDollarsApplied: 250, riskPctApplied: RP.policyStakePct("Equity"), obs: { terminal: true, gateProbe: true }, ctrl: false, vetoShadow: false }] };
      try {
        const r = await fetch("http://localhost:3001/api/board-positions?dryRun=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }), j = await r.json();
        if (r.status !== 200 || !j.dryRun || !Array.isArray(j.gateVetoes)) line("UNKNOWN", "the running server, asked (dry run)", `the dry run did not answer as expected (${r.status})`);
        else if (j.gateVetoes.some((v) => v.test === "STAMP")) line("PASS", "the running server, asked (dry run)", `a ticket with no stamp -> ${j.gateVetoes.find((v) => v.test === "STAMP").why.slice(0, 90)}; nothing was written`);
        else line("FAIL", "the running server, asked (dry run)", `a ticket with no stamp was NOT refused for its stamp (${j.gateVetoes.map((v) => v.test).join(", ") || "no veto"}${(j.refused || []).length ? "; refused: " + j.refused[0].why : ""}) — :3001 has not loaded the fix; restart owed, outside 06:45-14:15 MT`);
      } catch (e) { line("UNKNOWN", "the running server, asked (dry run)", `:3001 did not answer (${String(e.message).slice(0, 80)})`); }
    }
  });

  await guard("the change-registry row of fix 4.3", async () => {
    const name = "the 4.3 change-registry row";
    if (!isApplied["backend/lib/enforcement-gates.js"]) return line("UNKNOWN", name, "backend/lib/enforcement-gates.js is not applied; there is no change to record");
    const cr = readJ(D("change-registry.json")).filter((x) => x && x.id === R43.CR_ID);
    if (!cr.length) return line("UNKNOWN", name, `not written yet. It is dated at the board server's restart, so it is written after that restart: node ${R43.MARKER} --restarted YYYY-MM-DD (dry), then with its apply flag`);
    if (cr.length === 1 && cr[0].breaksComparability === true && R43.isDate(cr[0].date) && cr[0].affectedFrom === cr[0].date) line("PASS", name, `${R43.CR_ID}: breaksComparability true from ${cr[0].date} (the restart that loaded the fixed gate)`);
    else line("FAIL", name, `${cr.length} row(s) with id ${R43.CR_ID}${cr.length === 1 ? " — but not marked breaksComparability true from a calendar date" : ""}`);
  });

  log("\nfix 4.7 — the option records");
  for (const [rel, store, name] of [["backend/options-sleeve.js", "options-sleeve.json", "R21 sleeve"], ["backend/zero-dte-sleeve.js", "zero-dte-sleeve.json", "R25 sleeve"]]) await guard(`${name}: spot at entry`, async () => {
    if (!isApplied[rel]) return line("UNKNOWN", `${name}: spot at entry`, `${rel} is not applied`);
    const st = readJ(D(store)), at = appliedAt(rel), since = (st.entries || []).filter((e) => Date.parse(e.recordedAt || "") > at), wings = since.flatMap((e) => e.wings || []);
    if (!wings.length) return line("UNKNOWN", `${name}: spot at entry`, "no wing has been entered since the apply; the sleeve's next run is the next trading morning");
    const haveKey = wings.filter((w) => "spotAtEntry" in w).length, nonNull = wings.filter((w) => Number.isFinite(w.spotAtEntry)).length, gateInput = wings.filter((w) => w.spot != null).length;
    if (gateInput) line("FAIL", `${name}: the width gate's own input`, `${gateInput} wing(s) entered since the apply carry wing.spot — the width gate's input is no longer empty, which this fix must not change`);
    line(haveKey === wings.length && nonNull > 0 ? "PASS" : "FAIL", `${name}: spot at entry`, `${wings.length} wing(s) entered since the apply in ${since.length} run(s): ${haveKey} carry spotAtEntry, ${nonNull} with a price (${wings.length - nonNull} null: no snapshot for that symbol)`);
  });
  await guard("the settle: official close beside", async () => {
    const rel = "backend/options-settle.js"; if (!isApplied[rel]) return line("UNKNOWN", "the official close beside", `${rel} is not applied`);
    const at = appliedAt(rel), tlog = readJ(D("trade_log.json")), since = tlog.filter((t) => t && t.cls === "Options" && t.reason === "expiry" && !S.isOurs(t) && t.closedAt >= Date.parse(L.etNow(at).date + "T20:00:00Z") && t.obs);
    if (!since.length) return line("UNKNOWN", "the official close beside", "no wing has settled at an expiry on or after the day of the apply; the next close chain settles the day's wings");
    const withKey = since.filter((t) => "settleUnderOfficial" in t.obs), priced = withKey.filter((t) => Number.isFinite(t.obs.settleUnderOfficial)), reg = since.filter((t) => Number.isFinite(t.obs.settleUnder) && Number.isFinite(t.pnl) && Number.isFinite(t.rMult));
    const notes = [...new Set(withKey.filter((t) => t.obs.settleOfficialNote).map((t) => t.obs.settleOfficialNote.slice(0, 70)))];
    if (reg.length !== since.length) line("FAIL", "the registered settle fields", `${since.length - reg.length} of ${since.length} wing(s) settled since the apply lack settleUnder, pnl or rMult`);
    if (withKey.length !== since.length) line("UNKNOWN", "the official close beside", `${since.length - withKey.length} of ${since.length} expiry rows dated since the day of the apply have no official-close field: they were settled by a run that started before the apply (${withKey.length} have it)`);
    else line(priced.length ? "PASS" : "UNKNOWN", "the official close beside", `${since.length} wing(s) settled since the apply: all carry settleUnderOfficial, ${priced.length} with a price${notes.length ? `; the rest say: ${notes.join(" | ")}` : ""}`);
    if (priced.length) { const moved = priced.filter((t) => Math.abs(t.obs.pnlOfficial - t.pnl) > 0.5); line("PASS", "what the official close would change", `${moved.length} of ${priced.length} wing(s) would book a different amount at the official close; sum of the differences ${(Math.round(priced.reduce((a, t) => a + (t.obs.pnlOfficial - t.pnl), 0) * 100) / 100).toFixed(2)} (recorded only; nothing booked moves)`); }
  });
  await guard("the wing cap: exit mid and cross", async () => {
    const rel = "backend/wing-loss-cap.js"; if (!isApplied[rel]) return line("UNKNOWN", "exit mid and cross on early closes", `${rel} is not applied`);
    const at = appliedAt(rel), caps = readJ(D("trade_log.json")).filter((t) => t && t.reason === "wing-cap" && t.closedAt > at && t.obs);
    if (!caps.length) return line("UNKNOWN", "exit mid and cross on early closes", "no wing has been closed early since the apply (the loss cap is switched off: wingLossCap 0), so nothing carries the fields yet");
    const ok = caps.filter((t) => "exitMid" in t.obs && Number.isFinite(t.obs.exitCross));
    line(ok.length === caps.length ? "PASS" : "FAIL", "exit mid and cross on early closes", `${ok.length} of ${caps.length} early close(s) since the apply carry exitMid and exitCross`);
  });

  const n = (v) => rows.filter((x) => x.verdict === v).length;
  log(`\n${n("FAIL") ? "VERIFY FAILED" : "VERIFY: no failure"} — ${n("PASS")} PASS, ${n("UNKNOWN")} UNKNOWN (not yet knowable or not applied; each line says when), ${n("FAIL")} FAIL`);
  return { exit: n("FAIL") ? 1 : 0, rows };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.some((a) => a !== "--probe-gate")) { console.error("usage: verify-live.cjs [--probe-gate]"); process.exit(2); }
  verify({ probe: argv.includes("--probe-gate") }).then((r) => process.exit(r.exit)).catch((e) => { console.error(`verify-live crashed: ${e.stack || e.message}`); process.exit(1); });
}
module.exports = { verify };
