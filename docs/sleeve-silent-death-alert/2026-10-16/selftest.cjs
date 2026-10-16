#!/usr/bin/env node
/**
 * SLEEVE SILENT-DEATH ALERT — SELFTEST. A fake clock, fake ledgers and state files in a temp folder, a fake notify: no network, nothing
 * is sent, no live data file is read or written.
 *   node docs/sleeve-silent-death-alert/2026-10-16/selftest.cjs
 * Ends with "SELFTEST PASSED (n checks)" or exits 1 naming each failure.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");
const { loadCjs } = require("./loadcjs.cjs");
const P = require("./pkg.cjs");
const STAGED = path.join(PKG, "staged", "backend", "sleeve-silence-alert.js");

let n = 0; const fails = [];
const ok = (name, cond, detail) => { n++; if (!cond) fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };
const temps = [];
const ET = (iso) => Date.parse(iso + "-04:00");          // an ET wall-clock time while New York is on EDT (to 2026-11-01)
const EST = (iso) => Date.parse(iso + "-05:00");         // after 2026-11-01

/** a temp repo root holding the staged alert at its live path, the real run-window.js and an atomic-write spy */
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sleeve-silence-st-")); temps.push(root);
  const B = path.join(root, "backend"); fs.mkdirSync(path.join(B, "lib"), { recursive: true }); fs.mkdirSync(path.join(B, "data"), { recursive: true });
  fs.copyFileSync(STAGED, path.join(B, "sleeve-silence-alert.js"));
  fs.copyFileSync(path.join(REPO, "backend", "lib", "run-window.js"), path.join(B, "lib", "run-window.js"));
  fs.copyFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"), path.join(B, "lib", "atomic-write-real.js"));
  fs.writeFileSync(path.join(B, "lib", "atomic-write.js"), 'const R = require("./atomic-write-real.js"); module.exports = { ...R, writeJsonAtomic: (f, o, x) => { (globalThis.__SS_ATOMIC ||= []).push(f); return R.writeJsonAtomic(f, o, x); } };\n');
  const A = loadCjs(path.join(B, "sleeve-silence-alert.js"));
  const W = loadCjs(path.join(B, "lib", "atomic-write-real.js"));
  const put = (f, obj) => W.writeJsonAtomic(path.join(B, "data", f), obj);
  const touch = (f) => fs.writeFileSync(path.join(B, "data", f), "");
  const ledger = (f, rows) => fs.writeFileSync(path.join(B, "data", f), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const read = (f) => JSON.parse(fs.readFileSync(path.join(B, "data", f), "utf8"));
  const has = (f) => fs.existsSync(path.join(B, "data", f));
  return { root, B, A, put, touch, ledger, read, has, data: path.join(B, "data") };
}
const sessionsBetween = (A, a, b) => { const out = []; for (let d = a; d <= b; d = new Date(Date.parse(d + "T12:00:00Z") + 864e5).toISOString().slice(0, 10)) if (A.isSession(d, {})) out.push(d); return out; };
const days = (list, extra = {}) => Object.fromEntries(list.map((d) => [d, { date: d, decision: true, ...extra }]));
const fakeNotify = (answer = true) => { const sent = []; const fn = async (t, b, o) => { sent.push({ t, b, o }); if (answer instanceof Error) throw answer; return answer; }; fn.sent = sent; return fn; };
const quiet = () => {};

(async () => {
  // ---- 1. the calendar ---------------------------------------------------------------------------------------------------------
  {
    const { A } = makeRoot(), H = loadCjs(path.join(REPO, "backend", "lib", "run-window.js")).MARKET_HOLIDAYS;
    const d1 = A.dueSessions(ET("2026-10-16T16:00:00"), "16:30", H), d2 = A.dueSessions(ET("2026-10-16T16:30:00"), "16:30", H);
    ok("before dueEt the day's session is not due", d1[d1.length - 1] === "2026-10-15");
    ok("at dueEt it is due", d2[d2.length - 1] === "2026-10-16");
    ok("ten sessions, weekends skipped, oldest first", d2.length === 10 && d2[0] === "2026-10-05" && !d2.includes("2026-10-10") && !d2.includes("2026-10-11"));
    ok("Saturday: Friday is the last due session", A.dueSessions(ET("2026-10-17T12:00:00"), "16:30", H).pop() === "2026-10-16");
    const tg = A.dueSessions(EST("2026-11-27T17:00:00"), "16:30", H);
    ok("Thanksgiving (MARKET_HOLIDAYS) is not a session; the early-close Friday is", !tg.includes("2026-11-26") && tg.includes("2026-11-27") && tg.includes("2026-11-25"));
    ok("the pre-open step at 09:00 is not due for today", A.dueSessions(ET("2026-10-16T09:00:00"), "10:00", H).pop() === "2026-10-15");
  }

  // ---- 2. the R346 incident, replayed --------------------------------------------------------------------------------------
  {
    const { A, root, data, has } = makeRoot(), nf = fakeNotify(true);
    const r346 = A.SLEEVES.filter((s) => s.id === "R346");
    const res = await A.run({ root, nowMs: ET("2026-10-14T17:00:00"), notify: nf, log: quiet, sleeves: r346 });
    const missed = res.results[0].missed.map((m) => m.session);
    ok("R346 with no state file at all: the five sessions 10-08..10-14 are missed", JSON.stringify(missed) === JSON.stringify(["2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14"]), JSON.stringify(missed));
    ok("…one alert, through notify, high priority", nf.sent.length === 1 && nf.sent[0].o.priority === "high" && /R346 \(5 sessions\)/.test(nf.sent[0].t), nf.sent[0] && nf.sent[0].t);
    ok("…the body names the sessions and the cause", /2026-10-08, 2026-10-09, 2026-10-12, 2026-10-13, 2026-10-14/.test(nf.sent[0].b) && /r346-state\.json does not exist/.test(nf.sent[0].b) && /inferred/.test(nf.sent[0].b));
    ok("…exit 3 (delivered) and the dedupe state written", res.exit === 3 && has("sleeve-silence-alert.json"));
    const again = await A.run({ root, nowMs: ET("2026-10-14T18:00:00"), notify: nf, log: quiet, sleeves: r346 });
    ok("a second run the same evening sends nothing more (exit 3)", again.exit === 3 && nf.sent.length === 1);
    const next = await A.run({ root, nowMs: ET("2026-10-15T17:00:00"), notify: nf, log: quiet, sleeves: r346 });
    ok("the next session missed: one new alert for that session only", next.exit === 3 && nf.sent.length === 2 && /R346 \(1 session\)/.test(nf.sent[1].t) && /2026-10-15/.test(nf.sent[1].b) && !/2026-10-08/.test(nf.sent[1].b));
  }

  // ---- 3. the days shape (R316 / R346) ----------------------------------------------------------------------------------------
  {
    const { A, root, put, ledger } = makeRoot(), r316 = A.SLEEVES.filter((s) => s.id === "R316"), now = ET("2026-10-16T17:00:00");
    const all = sessionsBetween(A, "2026-10-05", "2026-10-16");
    put("r316-state.json", { spec: "r316-state-v1", firstLiveDecision: "2026-10-05", days: days(all), lastRun: {} });
    let r = (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: r316 })).results[0];
    ok("every due session decided: ok", r.status === "ok" && r.missed.length === 0);
    put("r316-state.json", { firstLiveDecision: "2026-10-05", days: { ...days(all), "2026-10-14": { date: "2026-10-14", decision: false, attempts: [{ ok: false, error: "quotes" }] } } });
    r = (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: r316 })).results[0];
    ok("a failed attempt (decision:false) is a missed session", r.status === "missed" && r.missed.length === 1 && r.missed[0].session === "2026-10-14");
    ledger("r316-ledger.jsonl", [{ ts: "x", test: "R316", kind: "decision", date: "2026-10-14", quoteError: null }]);
    r = (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: r316 })).results[0];
    ok("a ledger decision row counts for the day", r.status === "ok");
    ledger("r316-ledger.jsonl", [{ kind: "decision", date: "2026-10-14", quoteError: "no quotes" }, { kind: "gap", date: "2026-10-14" }, "not json"]);
    r = (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: r316 })).results[0];
    ok("a ledger row with quoteError, a gap row or a torn line does not", r.status === "missed" && r.missed[0].session === "2026-10-14");
    put("r316-state.json", { firstLiveDecision: "2026-10-13", days: days(["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]) });
    r = (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: r316 })).results[0];
    ok("sessions before firstLiveDecision are not expected", r.status === "ok");
    put("r316-state.json", { firstLiveDecision: "2026-10-13T19:55:00.000Z", days: days(["2026-10-13", "2026-10-14"]) });
    r = (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: r316 })).results[0];
    ok("an ISO firstLiveDecision works; the two silent sessions after it are missed", JSON.stringify(r.missed.map((m) => m.session)) === '["2026-10-15","2026-10-16"]', JSON.stringify(r.missed));
    put("r316-state.json", { days: {} });
    fs.unlinkSync(path.join(root, "backend", "data", "r316-ledger.jsonl"));
    r = (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: r316 })).results[0];
    ok("no record and no expectFrom: the latest due session is owed (a sleeve that never started is an alert)", r.status === "missed" && r.missed.length === 1 && r.missed[0].session === "2026-10-16");
    r = (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: [{ ...r316[0], expectFrom: "2026-10-20" }] })).results[0];
    ok("no record and expectFrom still in the future: not-started, no alert", r.status === "not-started" && r.missed.length === 0);
    r = (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: [{ ...r316[0], expectFrom: "2026-10-16" }] })).results[0];
    ok("expectFrom today: today's due session is owed", r.status === "missed" && r.missed.map((m) => m.session).join() === "2026-10-16");
    fs.writeFileSync(path.join(root, "backend", "data", "r316-state.json"), "{ torn");
    r = (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: r316 })).results[0];
    ok("a state file that exists but cannot be read is an alert", r.status === "missed" && /unreadable/.test(r.note));
  }

  // ---- 4. the lastRun shape (R151, R186, R218, R219) ---------------------------------------------------------------------
  {
    const { A, root, put } = makeRoot(), pick = (id) => A.SLEEVES.filter((s) => s.id === id);
    put("r186-month-end.json", { spec: "r186-state-v1", windows: {}, lastRun: { closeArm: "2026-10-14" } });
    let r = (await A.run({ root, nowMs: ET("2026-10-16T17:00:00"), dry: true, log: quiet, sleeves: pick("R186") })).results[0];
    ok("lastRun 10-14, now Fri 17:00: 10-15 and 10-16 are missed", JSON.stringify(r.missed.map((m) => m.session)) === '["2026-10-15","2026-10-16"]' && r.missed[0].step === "closeArm" && /last closeArm on 2026-10-14/.test(r.note));
    r = (await A.run({ root, nowMs: ET("2026-10-15T16:00:00"), dry: true, log: quiet, sleeves: pick("R186") })).results[0];
    ok("…at Thu 16:00 (before dueEt) nothing is missed yet", r.status === "ok");
    put("r151-state.json", { spec: "r151-state-v1", lots: [], queue: {}, lastRun: { closeArm: "2026-10-16", afterClose: "2026-10-15", preOpen: "2026-10-16" } });
    r = (await A.run({ root, nowMs: ET("2026-10-16T18:00:00"), dry: true, log: quiet, sleeves: pick("R151") })).results[0];
    ok("R151: each step on its own — only afterClose of 10-16 is missed", r.missed.length === 1 && r.missed[0].step === "afterClose" && r.missed[0].session === "2026-10-16");
    put("r219-zn-month-end.json", { windows: {}, lastRun: {} });
    r = (await A.run({ root, nowMs: ET("2026-10-16T18:00:00"), dry: true, log: quiet, sleeves: pick("R219") })).results[0];
    ok("a lastRun that was never written: the latest due session is owed", r.status === "missed" && r.missed.length === 1 && r.missed[0].session === "2026-10-16" && /last closeArm on never/.test(r.note));
    put("r219-zn-month-end.json", { lastRun: { closeArm: "2099-01-01" } });
    r = (await A.run({ root, nowMs: ET("2026-10-16T18:00:00"), dry: true, log: quiet, sleeves: pick("R219") })).results[0];
    ok("a lastRun date in the future is ignored (not 'ok forever')", r.status === "missed");
    put("r151-state.json", { lastRun: { closeArm: "2026-10-15", afterClose: "2026-10-15", preOpen: "2026-10-16" } });
    const nfS = fakeNotify(true), rS = await A.run({ root, nowMs: ET("2026-10-16T18:00:00"), notify: nfS, log: quiet, sleeves: pick("R151") });
    ok("two steps missed on one session are two alerts, deduped separately", rS.exit === 3 && /2026-10-16\/closeArm/.test(nfS.sent[0].b) && /2026-10-16\/afterClose/.test(nfS.sent[0].b));
    put("r151-state.json", { lastRun: { closeArm: "2026-10-16", afterClose: "2026-10-15", preOpen: "2026-10-16" } });
    const rS2 = await A.run({ root, nowMs: ET("2026-10-16T18:30:00"), notify: nfS, log: quiet, sleeves: pick("R151") });
    ok("…after closeArm/10-16 was alerted, afterClose/10-16 alone sends nothing new (already alerted under its own key)", rS2.exit === 3 && nfS.sent.length === 1);
  }

  // ---- 5. the marks shape (R191, R231) --------------------------------------------------------------------------------------
  {
    const { A, root, put } = makeRoot(), pick = (id) => A.SLEEVES.filter((s) => s.id === id), now = ET("2026-10-16T21:30:00");
    put("r191-crypto-trend.json", { coins: {}, marks: [{ coin: "BTC", d: "2026-10-15", close: 1 }, { coin: "ETH", d: "2026-10-15", close: 1 }] });
    let r = (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: pick("R191") })).results[0];
    ok("a mark for UTC day 10-15 is the run of session 10-16: ok", r.status === "ok");
    put("r191-crypto-trend.json", { coins: {}, marks: [{ coin: "BTC", d: "2026-10-13", close: 1 }] });
    r = (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: pick("R191") })).results[0];
    ok("last mark 10-13 (run 10-14): 10-15 and 10-16 are missed", JSON.stringify(r.missed.map((m) => m.session)) === '["2026-10-15","2026-10-16"]', JSON.stringify(r.missed));
    put("r231-crypto-vote-sized.json", { marks: [{ coin: "BTC", d: "2026-10-12", close: 1, catchUp: true, markedOn: "2026-10-16" }, { coin: "BTC", d: "2026-10-11", close: 1 }] });
    r = (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: pick("R231") })).results[0];
    ok("a catch-up row stamped markedOn 10-16 is a run on 10-16", r.status === "ok");
    put("r231-crypto-vote-sized.json", { marks: [{ coin: "BTC", d: "2026-10-15", close: 1, catchUp: true, markedOn: "2026-10-14" }] });
    r = (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: pick("R231") })).results[0];
    ok("a catch-up row counts by markedOn, not by its d", r.status === "missed" && r.missed.map((m) => m.session).join() === "2026-10-15,2026-10-16");
  }

  // ---- 6. pauses -----------------------------------------------------------------------------------------------------------
  {
    const { A, root, touch, put, data } = makeRoot(), pick = (id) => A.SLEEVES.filter((s) => s.id === id), now = ET("2026-10-16T17:00:00");
    const r346 = async () => (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: pick("R346") })).results[0];
    touch("TRAIDS_STOP"); ok("TRAIDS_STOP: paused, no alert", (await r346()).status === "paused"); fs.unlinkSync(path.join(data, "TRAIDS_STOP"));
    put("r346-HALT.json", { kind: "guard-violation", date: "2026-10-15", why: "a send outside the window" });
    ok("HALT guard-violation: paused", (await r346()).status === "paused");
    put("r346-HALT.json", { kind: "interim-kill", date: "2026-10-15" });
    ok("HALT interim-kill: still expected to decide", (await r346()).status === "missed");
    fs.unlinkSync(path.join(data, "r346-HALT.json"));
    touch("r346-OFF"); const off = await r346();
    ok("r346-OFF (entries only): still expected, and the note says the switch is set", off.status === "missed" && /r346-OFF is set/.test(off.note));
    put("r151-state.json", { lastRun: { closeArm: "2026-10-01", afterClose: "2026-10-01", preOpen: "2026-10-01" } });
    touch("r151-OFF"); ok("r151-OFF (stops the runner): paused", (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: pick("R151") })).results[0].status === "paused");
    fs.unlinkSync(path.join(data, "r151-OFF")); ok("…switch removed: missed again", (await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: pick("R151") })).results[0].status === "missed");
    touch("sleeve-silence-OFF"); const nf = fakeNotify();
    const o = await A.run({ root, nowMs: now, notify: nf, log: quiet });
    ok("the alert's own OFF switch: exit 0, nothing checked or sent", o.exit === 0 && o.results.length === 0 && nf.sent.length === 0);
  }

  // ---- 7. delivery: dry, failure, throw, retry, prune, atomic -----------------------------------------------------------
  {
    const { A, root, has, read, put } = makeRoot(), pick = A.SLEEVES.filter((s) => s.id === "R346"), now = ET("2026-10-14T17:00:00");
    const nf0 = fakeNotify(true), d = await A.run({ root, nowMs: now, dry: true, notify: nf0, log: quiet, sleeves: pick });
    ok("--dry: exit 3, nothing sent, nothing written", d.exit === 3 && nf0.sent.length === 0 && !has("sleeve-silence-alert.json"));
    const nf1 = fakeNotify(false), f = await A.run({ root, nowMs: now, notify: nf1, log: quiet, sleeves: pick });
    ok("notify returns false: exit 4 (nobody told), no session recorded as alerted", f.exit === 4 && nf1.sent.length === 1 && Object.keys(read("sleeve-silence-alert.json").alerts).length === 0 && read("sleeve-silence-alert.json").lastRun.delivered === false);
    const nf2 = fakeNotify(new Error("telegram down")), t = await A.run({ root, nowMs: now, notify: nf2, log: quiet, sleeves: pick });
    ok("notify throws: exit 4, nothing recorded", t.exit === 4 && Object.keys(read("sleeve-silence-alert.json").alerts).length === 0);
    const nf3 = fakeNotify(true); globalThis.__SS_ATOMIC = [];
    const ok3 = await A.run({ root, nowMs: now, notify: nf3, log: quiet, sleeves: pick });
    ok("the next run retries and delivers: exit 3, five sessions recorded", ok3.exit === 3 && nf3.sent.length === 1 && Object.keys(read("sleeve-silence-alert.json").alerts.R346).length === 5);
    ok("the state was written through atomic-write", globalThis.__SS_ATOMIC.length === 1 && /sleeve-silence-alert\.json$/.test(globalThis.__SS_ATOMIC[0]));
    put("sleeve-silence-alert.json", { spec: "sleeve-silence-alert-v1", alerts: { R346: { "2026-08-01": "x" }, R999: { "2026-08-02": "x" } }, lastRun: null });
    await A.run({ root, nowMs: now, notify: fakeNotify(true), log: quiet, sleeves: pick });
    const pr = read("sleeve-silence-alert.json").alerts;
    ok("entries older than 30 days are pruned on delivery", !pr.R999 && !pr.R346["2026-08-01"] && pr.R346["2026-10-14"]);
  }
  {
    const { A, root, put } = makeRoot(), now = ET("2026-10-16T21:30:00"), all = sessionsBetween(A, "2026-10-05", "2026-10-16");
    // every sleeve healthy: exit 0, nothing sent
    put("r346-state.json", { firstLiveDecision: "2026-10-08", days: days(all) }); put("r316-state.json", { firstLiveDecision: "2026-10-05", days: days(all) });
    put("r151-state.json", { lastRun: { closeArm: "2026-10-16", afterClose: "2026-10-16", preOpen: "2026-10-16" } });
    for (const f of ["r186-month-end.json", "r218-dollar-reversal.json", "r219-zn-month-end.json"]) put(f, { lastRun: { closeArm: "2026-10-16" } });
    for (const f of ["r191-crypto-trend.json", "r231-crypto-vote-sized.json"]) put(f, { marks: [{ coin: "BTC", d: "2026-10-15", close: 1 }] });
    const nf = fakeNotify(true), all8 = await A.run({ root, nowMs: now, notify: nf, log: quiet });
    ok("all eight sleeves healthy: exit 0, no alert", all8.exit === 0 && nf.sent.length === 0 && all8.results.length === 8 && all8.results.every((r) => r.status === "ok"), JSON.stringify(all8.results.filter((r) => r.status !== "ok")));
    put("r218-dollar-reversal.json", { lastRun: { closeArm: "2026-10-15" } }); put("r191-crypto-trend.json", { marks: [{ coin: "BTC", d: "2026-10-14", close: 1 }] });
    const two = await A.run({ root, nowMs: now, notify: nf, log: quiet });
    ok("two sleeves silent: ONE alert naming both", two.exit === 3 && nf.sent.length === 1 && /R218 \(1 session\)/.test(nf.sent[0].t) && /R191 \(1 session\)/.test(nf.sent[0].t));
  }

  // ---- 7b. silence paths: a bad file never silences the run; edge shapes -----------------------------------------------------
  {
    const { A, root, put, data } = makeRoot(), pick = (...ids) => A.SLEEVES.filter((s) => ids.includes(s.id)), now = ET("2026-10-16T17:00:00");
    put("r186-month-end.json", { lastRun: { closeArm: "2026-10-14" } });
    put("r316-state.json", null);
    let res = await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: pick("R316", "R186") });
    ok("a state file holding null is an alert (unreadable), and the other sleeve is still checked", res.results[0].status === "missed" && /not a JSON object/.test(res.results[0].note) && res.results[1].status === "missed");
    put("r316-state.json", { firstLiveDecision: "2026-10-05", days: { "2026-10-15": null, "2026-10-16": "x" } });
    res = await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: pick("R316", "R186") });
    ok("null / non-object day entries do not crash; they are not decisions", res.results[0].status === "missed" && res.results[0].missed.some((m) => m.session === "2026-10-16") && res.results[1].status === "missed");
    fs.mkdirSync(path.join(data, "r316-ledger.jsonl"));
    const nf = fakeNotify(true); res = await A.run({ root, nowMs: now, notify: nf, log: quiet, sleeves: pick("R316", "R186") });
    ok("a check that throws (ledger is a directory) is an alert for that sleeve, and the other sleeve is still alerted", res.exit === 3 && res.results[0].missed[0].step === "check-error" && /check itself failed/.test(nf.sent[0].b) && /R186/.test(nf.sent[0].t));
    for (const f of ["r191-crypto-trend.json"]) put(f, []);
    res = await A.run({ root, nowMs: now, dry: true, log: quiet, sleeves: pick("R191") });
    ok("a state that is an array is an alert, not not-started", res.results[0].status === "missed" && /an array/.test(res.results[0].note));
  }
  {
    const { A, root, put, read } = makeRoot(), r346 = A.SLEEVES.filter((s) => s.id === "R346"), now = ET("2026-10-14T17:00:00");
    put("sleeve-silence-alert.json", null);
    const nf = fakeNotify(true), r1 = await A.run({ root, nowMs: now, notify: nf, log: quiet, sleeves: r346 });
    ok("an alert-state file holding null does not stop the alert", r1.exit === 3 && nf.sent.length === 1 && Object.keys(read("sleeve-silence-alert.json").alerts.R346).length === 5);
    put("sleeve-silence-alert.json", { spec: "x", alerts: "corrupt", lastRun: null });
    const r2 = await A.run({ root, nowMs: now, notify: nf, log: quiet, sleeves: r346 });
    ok("an alerts field that is not an object: alert sent, state repaired", r2.exit === 3 && nf.sent.length === 2 && typeof read("sleeve-silence-alert.json").alerts.R346 === "object");
    put("sleeve-silence-alert.json", { spec: "x", alerts: { R346: "corrupt" }, lastRun: null });
    const r3 = await A.run({ root, nowMs: now, notify: nf, log: quiet, sleeves: r346 });
    ok("a per-sleeve entry that is not an object: alert sent, state repaired", r3.exit === 3 && nf.sent.length === 3 && Object.keys(read("sleeve-silence-alert.json").alerts.R346).length === 5);
    ok("notify is called with email:false, priority high, tags warning", JSON.stringify(nf.sent[0].o) === JSON.stringify({ priority: "high", tags: "warning", email: false }));
  }
  {
    const { A, root, put, has } = makeRoot(), all = sessionsBetween(A, "2026-10-05", "2026-10-16");
    put("r316-state.json", { firstLiveDecision: "2026-10-05", days: days(all) });
    const nf = fakeNotify(true), d = await A.run({ root, nowMs: ET("2026-10-16T17:00:00"), dry: true, notify: nf, log: quiet, sleeves: A.SLEEVES.filter((s) => s.id === "R316") });
    ok("--dry on a healthy run: exit 0, nothing written", d.exit === 0 && !has("sleeve-silence-alert.json") && nf.sent.length === 0);
    put("r316-state.json", { firstLiveDecision: "2026-10-12", days: days(["2026-10-14", "2026-10-15", "2026-10-16"]) });
    const r = (await A.run({ root, nowMs: ET("2026-10-16T17:00:00"), dry: true, log: quiet, sleeves: A.SLEEVES.filter((s) => s.id === "R316") })).results[0];
    ok("firstLiveDecision earlier than the first day record: the sessions between are missed", r.missed.map((m) => m.session).join() === "2026-10-12,2026-10-13", JSON.stringify(r.missed));
    put("r316-state.json", { firstLiveDecision: "2099-01-01", days: {} });
    const r2 = (await A.run({ root, nowMs: ET("2026-10-16T17:00:00"), dry: true, log: quiet, sleeves: A.SLEEVES.filter((s) => s.id === "R316") })).results[0];
    ok("a firstLiveDecision in the future is ignored (the sleeve is owed its latest session)", r2.status === "missed");
  }
  {
    const { A, root, put } = makeRoot(), r191 = A.SLEEVES.filter((s) => s.id === "R191");
    // a late Thursday run (after 00:00 UTC) marks d = Thursday; asOf says the run was Thursday ET, so Friday is still owed
    put("r191-crypto-trend.json", { asOf: "2026-10-16T00:30:00.000Z", marks: [{ coin: "BTC", d: "2026-10-15", close: 1 }] });
    const r = (await A.run({ root, nowMs: ET("2026-10-16T21:30:00"), dry: true, log: quiet, sleeves: r191 })).results[0];
    ok("marks: the run date is asOf's ET date — a late Thursday run does not cover Friday", r.status === "missed" && r.missed.map((m) => m.session).join() === "2026-10-16", JSON.stringify(r));
    put("r191-crypto-trend.json", { asOf: "2026-10-16T22:40:00.000Z", marks: [{ coin: "BTC", d: "2026-10-15", close: 1 }] });
    put("r191-crypto-trend.json", { asOf: "2026-10-16T22:40:00.000Z", marks: [{ coin: "BTC", d: "2026-10-15", close: 1 }] });
    ok("marks: a Friday-evening save with Friday's mark covers Friday", (await A.run({ root, nowMs: ET("2026-10-16T21:30:00"), dry: true, log: quiet, sleeves: r191 })).results[0].status === "ok");
    put("r191-crypto-trend.json", { asOf: "2026-10-16T21:00:00.000Z", marks: [{ coin: "BTC", d: "2026-10-12", close: 1 }] });
    ok("marks: a Friday save with no new mark (a run that crashed after a mid-run save) is not a run", (await A.run({ root, nowMs: ET("2026-10-16T21:30:00"), dry: true, log: quiet, sleeves: r191 })).results[0].missed.map((m) => m.session).join() === "2026-10-14,2026-10-15,2026-10-16");
    put("r191-crypto-trend.json", { asOf: "2026-10-16T21:00:00.000Z", coins: {} });
    ok("marks: a save with no marks at all is not a run", (await A.run({ root, nowMs: ET("2026-10-16T21:30:00"), dry: true, log: quiet, sleeves: r191 })).results[0].status === "missed");
    put("r191-crypto-trend.json", { marks: [{ coin: "BTC", d: "2026-10-12", close: 1, catchUp: true, markedOn: "2099-01-01" }] });
    ok("marks without asOf: a future markedOn is ignored", (await A.run({ root, nowMs: ET("2026-10-16T21:30:00"), dry: true, log: quiet, sleeves: r191 })).results[0].status === "missed");
  }

  // ---- 7c. the command line, with fakes: a run that dies still tells someone, or exits 4 --------------------------------------
  {
    const { A } = makeRoot(), boom = async () => { throw new Error("run-window.js missing"); }, errs = [];
    const nfOk = fakeNotify(true), c1 = await A.main([], { runImpl: boom, notify: nfOk, log: quiet, logErr: (x) => errs.push(x) });
    ok("main: the run dies, the FAILED alert is delivered -> exit 3", c1 === 3 && nfOk.sent.length === 1 && /check FAILED/.test(nfOk.sent[0].t) && /run-window\.js missing/.test(nfOk.sent[0].b) && nfOk.sent[0].o.priority === "high");
    ok("main: the run dies, notify returns false -> exit 4", (await A.main([], { runImpl: boom, notify: fakeNotify(false), log: quiet, logErr: quiet })) === 4);
    ok("main: the run dies, notify throws -> exit 4", (await A.main([], { runImpl: boom, notify: fakeNotify(new Error("down")), log: quiet, logErr: quiet })) === 4);
    const nfDry = fakeNotify(true);
    ok("main --dry: the run dies -> exit 4 and nothing is sent", (await A.main(["--dry"], { runImpl: boom, notify: nfDry, log: quiet, logErr: quiet })) === 4 && nfDry.sent.length === 0);
    ok("main: a bad argument -> exit 2", (await A.main(["--send"], { runImpl: boom, log: quiet, logErr: quiet })) === 2);
    let seen = null; const c5 = await A.main(["--dry", "--now", "2026-10-14T21:00:00Z"], { runImpl: async (o) => { seen = o; return { exit: 0 }; }, log: quiet, logErr: quiet });
    ok("main: passes --dry and --now to run and returns its exit", c5 === 0 && seen.dry === true && seen.nowMs === Date.parse("2026-10-14T21:00:00Z"));
  }

  // ---- 8. the CLI and the package ----------------------------------------------------------------------------------------
  {
    const { A } = makeRoot();
    ok("parseArgs: --dry --now", (() => { const o = A.parseArgs(["--dry", "--now", "2026-10-14T21:00:00Z"]); return o.dry === true && o.nowMs === Date.parse("2026-10-14T21:00:00Z"); })());
    ok("parseArgs: a bad --now or an unknown flag is an error", !!A.parseArgs(["--now", "soon"]).error && !!A.parseArgs(["--send"]).error);
    const src = fs.readFileSync(STAGED, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    ok("the only alert path is backend/notify.js", (src.match(/require\(["']\.\/notify\.js["']\)/g) || []).length >= 1 && (src.match(/require\(["'][^"']+["']\)/g) || []).every((x) => /["'](fs|path|\.\/notify\.js|\.\/lib\/run-window\.js|\.\/lib\/atomic-write\.js)["']/.test(x)) && !/nodemailer|telegram|https?:\/\//i.test(src));
    ok("no network, no broker, no child process", !/require\(["'](https?|net|tls|dns|child_process)["']\)|fetch\(|alpaca|broker/i.test(src));
    ok("no JSON written except through atomic-write", !/writeFileSync|appendFileSync/.test(src));
  }
  {
    const SAT = Date.parse("2026-10-17T19:00:00Z"), WED10 = Date.parse("2026-10-14T16:00:00Z"), rel = "backend/sleeve-silence-alert.js";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sleeve-silence-pk-")); temps.push(root);
    fs.mkdirSync(path.join(root, "backend", "lib"), { recursive: true }); fs.copyFileSync(path.join(REPO, "backend", "lib", "run-window.js"), path.join(root, "backend", "lib", "run-window.js"));
    const live = path.join(root, rel);
    ok("deploy: plan reads base (absent)", P.run({ mode: "plan", root, nowMs: SAT, log: quiet }) === 0 && P.stateOf(rel, root).state === "base");
    ok("deploy: apply inside the fence refused", P.run({ mode: "apply", root, nowMs: WED10, log: quiet }) === 2 && !fs.existsSync(live));
    ok("deploy: apply writes staged byte for byte", P.run({ mode: "apply", root, nowMs: SAT, log: quiet }) === 0 && fs.readFileSync(live).equals(fs.readFileSync(STAGED)));
    fs.appendFileSync(live, "\n// drift\n"); ok("deploy: drift refuses apply and rollback", P.run({ mode: "apply", root, nowMs: SAT, log: quiet }) === 2 && P.run({ mode: "rollback", root, nowMs: SAT, log: quiet }) === 2);
    fs.writeFileSync(live, fs.readFileSync(STAGED)); ok("rollback removes the new file", P.run({ mode: "rollback", root, nowMs: SAT, log: quiet }) === 0 && !fs.existsSync(live));
  }
  ok("the live alert script is base or applied, never drifted", ["base", "applied"].includes(P.stateOf("backend/sleeve-silence-alert.js", REPO).state));

  for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  if (fails.length) { console.log(`\nSELFTEST FAILED: ${fails.length} of ${n}\n  ` + fails.join("\n  ")); process.exit(1); }
  console.log(`\nSELFTEST PASSED (${n} checks)`);
})().catch((e) => { for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } console.log("SELFTEST CRASHED: " + (e && e.stack)); process.exit(1); });
