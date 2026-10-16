#!/usr/bin/env node
"use strict";
/**
 * WORST-DAY SEALED LEDGER — THE KNOWN ANSWERS. Every check below is a fact that was worked out by hand or recomputed by a second,
 * straight-loop code path, never by calling the thing under test twice. It reads no live file, makes no network call, sends no order
 * and writes only inside a throw-away directory under the OS temp dir, removed at the end.
 *
 *   node backend/worst-day/sealed-selftest.js                 every suite
 *   node backend/worst-day/sealed-selftest.js sealed-ledger   one or more suites by name
 * The last line is ALL n CHECKS PASSED, or FAILED — k of n checks. Exit 0 only on the first.
 *
 * THE BARS ARE SYNTHETIC AND MADE HERE: 340 consecutive weekdays from a seeded generator, calm for most of the run and then a
 * forty-session drawdown with four times the volatility, so both storm states appear. No market data of any kind is read.
 * The test configuration uses a 60-session threshold window so 340 bars are enough; the production defaults (1,260 / 200) are
 * themselves a checked known answer.
 */
const fs = require("fs"), os = require("os"), path = require("path");
const SL = require("./sealed-ledger.js");
const SC = require("./sealed-check.js");
const NM = require("./nightly-model.js");
const SG = require("./sealed-grade.js");
const NF = require("./nightly-forecast.js");

const CFG = { win: 60, tail: 0.05, minHistory: 200, lambda: 10, topDecile: 0.10, volQ: 0.80, minTrain: 30 };

// ── the synthetic bars ───────────────────────────────────────────────────────────────────────────
const FX = require("./sealed-fixtures.js");
const { mulberry32, weekdaysFrom, syntheticBars } = FX;

// ── the harness ──────────────────────────────────────────────────────────────────────────────────────────────────────
function makeRunner() {
  const results = [];
  const ok = (name, cond, why = "") => { results.push({ name, ok: !!cond, why }); };
  const eq = (name, got, want, note = "") => ok(name, Object.is(got, want), `got ${fmt(got)}, expected ${fmt(want)}${note ? " — " + note : ""}`);
  const near = (name, got, want, tol, note = "") => ok(name, Number.isFinite(got) && Math.abs(got - want) <= tol, `got ${fmt(got)}, expected ${fmt(want)} +/- ${tol}${note ? " — " + note : ""}`);
  const throws = (name, fn, re) => { let m = null; try { fn(); } catch (e) { m = e.message; } ok(name, m !== null && re.test(m), m === null ? "it did not refuse" : `it refused with ${JSON.stringify(m)}, which does not match ${re}`); };
  /** one block of related checks. A throw inside it is ONE failing case named for the block, and every later block still runs:
   *  without this, one unexpected throw silently takes every check after it out of the count. */
  const group = (label, fn) => { try { fn(); } catch (e) { results.push({ name: label, ok: false, why: `the block threw: ${(e && e.stack ? e.stack : String(e)).split("\n").slice(0, 2).join(" / ")}` }); } };
  return { results, ok, eq, near, throws, group };
}
const fmt = (v) => (typeof v === "string" ? JSON.stringify(v.length > 160 ? v.slice(0, 160) + "…" : v) : typeof v === "number" ? String(v) : JSON.stringify(v));

/** a row body with every required field, for the ledger's own tests */
function sampleBody(forDate, asOfDate, over = {}) {
  return { forDate, asOfDate, p: 0.0625, score: 0.0625, storm: "calm", stormThr: 0.1, flagModel: 0, flagRule: 0, thr: -0.0213, asOfAdj: 123.456,
    model: { id: "test-model", features: ["a", "b"], win: 60, tail: 0.05, lambda: 10, minHistory: 200, nTrain: 139, nBars: 340 }, ...over };
}
/** write a ledger of fully-formed rows straight to disk, chained by hand — for the checker's negative cases */
function writeLedger(file, bodies, { nowOf = (b) => SL.sealDeadlineMs(b.forDate) - 12 * 3600000, tip = true } = {}) {
  let prev = SL.GENESIS; const lines = []; let last = null;
  bodies.forEach((b, i) => {
    const row = { ...b, spec: SL.SPEC, seq: i + 1, prevHash: prev, createdAt: new Date(nowOf(b, i)).toISOString() };
    row.hash = SL.hashBody(row); prev = row.hash; last = row;
    lines.push(SL.canonicalJson(row));
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.length ? lines.join("\n") + "\n" : "");
  const tf = SL.tipPathFor(file);
  if (tip && last) fs.writeFileSync(tf, JSON.stringify({ spec: SL.SPEC, seq: last.seq, hash: last.hash, forDate: last.forDate, at: last.createdAt }, null, 1));
  else if (!tip) { try { fs.unlinkSync(tf); } catch { /* not there */ } }
  return lines;
}
/** re-chain a list of rows so only the named break remains: used to prove one check catches what another does not */
function rechain(rows) { let prev = SL.GENESIS; return rows.map((r, i) => { const x = { ...r, seq: i + 1, prevHash: prev }; delete x.hash; x.hash = SL.hashBody(x); prev = x.hash; return x; }); }

// ── suite: sealed-ledger ─────────────────────────────────────────────────────────────────────────────────────────────
function suiteSealedLedger(T, TMP) {
  const { ok, eq, throws } = T;
  // the ET wall clock. 2026 daylight saving: it starts Sunday 8 March and ends Sunday 1 November.
  eq("the seal is 14:30 UTC in winter (2026-01-05 09:30 ET)", SL.sealDeadlineMs("2026-01-05"), Date.UTC(2026, 0, 5, 14, 30));
  eq("the seal is 13:30 UTC in summer (2026-07-01 09:30 ET)", SL.sealDeadlineMs("2026-07-01"), Date.UTC(2026, 6, 1, 13, 30));
  eq("the seal moves with the spring step: 2026-03-06 is still 14:30 UTC", SL.sealDeadlineMs("2026-03-06"), Date.UTC(2026, 2, 6, 14, 30));
  eq("the seal moves with the spring step: 2026-03-09 is 13:30 UTC", SL.sealDeadlineMs("2026-03-09"), Date.UTC(2026, 2, 9, 13, 30));
  eq("the seal moves with the autumn step: 2026-10-30 is 13:30 UTC", SL.sealDeadlineMs("2026-10-30"), Date.UTC(2026, 9, 30, 13, 30));
  eq("the seal moves with the autumn step: 2026-11-02 is 14:30 UTC", SL.sealDeadlineMs("2026-11-02"), Date.UTC(2026, 10, 2, 14, 30));
  eq("the ET calendar day of 2026-07-01 03:00 UTC is still 30 June", SL.etDay(Date.UTC(2026, 6, 1, 3, 0)), "2026-06-30");
  eq("09:30 and 09:29 ET of the same day are 60 seconds apart", SL.sealDeadlineMs("2026-07-01") - SL.etWallMs("2026-07-01", 9, 29), 60000);

  // the canonical bytes and the hash
  eq("canonicalJson sorts every object's keys and uses no spaces", SL.canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  throws("canonicalJson refuses a number that would not survive a round trip", () => SL.canonicalJson({ a: NaN }), /not a finite number/);
  eq("sha256 of the empty string is the published value", SL.sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  {
    const body = { ...sampleBody("2026-07-01", "2026-06-30"), spec: SL.SPEC, seq: 1, prevHash: SL.GENESIS, createdAt: "2026-06-30T22:00:00.000Z" };
    const canon = SL.canonicalJson(Object.fromEntries(SL.BODY_KEYS.map((k) => [k, body[k]])));
    eq("the body that is hashed is the row without `hash`, canonically written", SL.hashBody(body), SL.sha256(canon));
    eq("the hash of the pinned body", SL.hashBody(body), "e57056814ad4953c66681ba05d78437fc7030017e9be2988ad1b0061f219d3c7");
    const moved = { ...body, p: body.p + 1e-9 };
    ok("one changed digit of one field changes the hash", SL.hashBody(moved) !== SL.hashBody(body), "the hash did not move");
    ok("prevHash is inside the hash, so a relinked row hashes differently", SL.hashBody({ ...body, prevHash: "a".repeat(64) }) !== SL.hashBody(body), "prevHash is outside the hash");
  }
  // the row's shape
  {
    const good = { ...sampleBody("2026-07-01", "2026-06-30"), spec: SL.SPEC, seq: 1, prevHash: SL.GENESIS, createdAt: "2026-06-30T22:00:00.000Z" };
    good.hash = SL.hashBody(good);
    eq("a well-formed row has no shape problem", SL.rowProblems(good).length, 0, JSON.stringify(SL.rowProblems(good)));
    ok("a key that is not part of a row is refused (nothing may sit outside the hash)", SL.rowProblems({ ...good, note: "hello" }).some((p) => /note is not part of a row/.test(p)), JSON.stringify(SL.rowProblems({ ...good, note: "hello" })));
    ok("a storm state the two flags do not agree with is refused", SL.rowProblems({ ...good, storm: "storm" }).some((p) => /the two flags/.test(p)));
    ok("p outside [0, 1] is refused", SL.rowProblems({ ...good, p: 1.5 }).some((p) => /^p is 1.5, outside/.test(p)));
    ok("an asOfDate that is not before forDate is refused", SL.rowProblems({ ...good, asOfDate: "2026-07-02" }).some((p) => /is not before forDate/.test(p)));
    ok("a createdAt without milliseconds is refused", SL.rowProblems({ ...good, createdAt: "2026-06-30T22:00:00Z" }).some((p) => /not an ISO instant/.test(p)));
    eq("the storm state of the two flags: both", SL.stormStateOf(1, 1), "storm");
    eq("the storm state of the two flags: one", SL.stormStateOf(0, 1), "watch");
    eq("the storm state of the two flags: neither", SL.stormStateOf(0, 0), "calm");
  }
  // appending
  T.group("appending two rows in order", () => {
    const f = path.join(TMP, "append", "led.jsonl");
    const t1 = SL.sealDeadlineMs("2026-07-01") - 12 * 3600000;
    const r1 = SL.appendRow(f, sampleBody("2026-07-01", "2026-06-30"), { now: t1, check: SC.check });
    eq("the first row takes seq 1", r1.seq, 1);
    eq("the first row's prevHash is GENESIS", r1.row.prevHash, SL.GENESIS);
    eq("the line on disk is the canonical row and nothing else", fs.readFileSync(f, "utf8"), SL.canonicalJson(r1.row) + "\n");
    const tip1 = SL.readTip(SL.tipPathFor(f));
    eq("the tip file names the row just written", tip1 && tip1.hash, r1.row.hash);
    const t2 = SL.sealDeadlineMs("2026-07-02") - 12 * 3600000;
    const r2 = SL.appendRow(f, sampleBody("2026-07-02", "2026-07-01"), { now: t2, check: SC.check });
    eq("the second row takes seq 2", r2.seq, 2);
    eq("the second row carries the first row's hash", r2.row.prevHash, r1.row.hash);
    eq("the ledger now holds two lines", SL.readLedger(f).rows.length, 2);
    eq("the tip file moved to the second row", (SL.readTip(SL.tipPathFor(f)) || {}).seq, 2);
    throws("a forDate that is not after the last row is refused", () => SL.appendRow(f, sampleBody("2026-07-02", "2026-07-01"), { now: t2 + 1, check: SC.check }), /only ever moves forward/);
    throws("a caller that fills in seq itself is refused", () => SL.appendRow(f, { ...sampleBody("2026-07-03", "2026-07-02"), seq: 9 }, { now: t2 + 1, check: SC.check }), /seq is filled in by appendRow/);
    throws("a weekend forDate is refused", () => SL.appendRow(f, sampleBody("2026-07-04", "2026-07-03"), { now: t2 + 1, check: SC.check }), /is a weekend, not a session/);
  });
  {
    const f = path.join(TMP, "deadline", "led.jsonl"), dl = SL.sealDeadlineMs("2026-07-01");
    const r = SL.appendRow(f, sampleBody("2026-07-01", "2026-06-30"), { now: dl - 1, check: SC.check });
    eq("one millisecond before 09:30 ET the row still goes in", r.seq, 1);
    const g = path.join(TMP, "deadline2", "led.jsonl");
    throws("AT 09:30 ET exactly the seal is closed", () => SL.appendRow(g, sampleBody("2026-07-01", "2026-06-30"), { now: dl, check: SC.check }), /THE SEAL IS CLOSED/);
    throws("one minute after 09:30 ET the seal is closed", () => SL.appendRow(g, sampleBody("2026-07-01", "2026-06-30"), { now: dl + 60000, check: SC.check }), /THE SEAL IS CLOSED/);
    ok("a refused append leaves no file behind", !fs.existsSync(g), `${g} was written anyway`);
  }
  {
    const f = path.join(TMP, "broken", "led.jsonl");
    writeLedger(f, [sampleBody("2026-07-01", "2026-06-30"), sampleBody("2026-07-02", "2026-07-01")]);
    const text = fs.readFileSync(f, "utf8").split("\n");
    text[0] = text[0].replace('"p":0.0625', '"p":0.9');                                 // one edited byte in the first row
    fs.writeFileSync(f, text.join("\n"));
    throws("nothing is appended to a ledger that does not pass its own checker", () => SL.appendRow(f, sampleBody("2026-07-03", "2026-07-02"), { now: SL.sealDeadlineMs("2026-07-03") - 3600000, check: SC.check }), /does not pass its own check/);
    eq("the refused append added no line", SL.readLedger(f).rows.length, 2);
  }
}

// ── suite: sealed-check ──────────────────────────────────────────────────────────────────────────────────────────────
function suiteSealedCheck(T, TMP) {
  const { ok, eq } = T;
  const dates = [["2026-06-29", "2026-06-26"], ["2026-06-30", "2026-06-29"], ["2026-07-01", "2026-06-30"]];
  const bodies = dates.map(([f, a]) => sampleBody(f, a));
  const dir = (n) => { const d = path.join(TMP, "check", n); fs.mkdirSync(d, { recursive: true }); return path.join(d, "led.jsonl"); };
  const failed = (v) => v.failed.map((c) => c.id);

  { const f = dir("good"); writeLedger(f, bodies); const v = SC.checkFile(f, { now: Date.parse("2026-07-01T12:00:00Z") });
    ok("a sealed ledger passes every check", v.ok, `refused: ${failed(v).join(", ")} — ${v.failed.map((c) => c.detail).join(" | ")}`);
    eq("every check ran", v.checks.filter((c) => c.ran).length, SC.CHECK_IDS.length); }

  { const f = dir("late"); writeLedger(f, bodies, { nowOf: (b, i) => SL.sealDeadlineMs(b.forDate) + (i === 1 ? 60000 : -12 * 3600000) });
    const v = SC.checkFile(f, { now: Date.parse("2026-07-01T12:00:00Z") });
    ok("A ROW WRITTEN AFTER 09:30 ET OF THE DAY IT FORECASTS REFUSES THE WHOLE LEDGER", !v.ok && failed(v).includes("seal"), `failed checks: ${failed(v).join(", ")}`);
    ok("the seal refusal names the row and how late it was", /row 2: WRITTEN AFTER THE OPEN.*1 minute\(s\) late/.test(v.checks.find((c) => c.id === "seal").detail), v.checks.find((c) => c.id === "seal").detail); }

  { const f = dir("edited"); writeLedger(f, bodies); const t = fs.readFileSync(f, "utf8").split("\n"); t[0] = t[0].replace('"p":0.0625', '"p":0.9000'); fs.writeFileSync(f, t.join("\n"));
    const v = SC.checkFile(f, { now: Date.parse("2026-07-01T12:00:00Z") });
    ok("one edited byte in an old row refuses (hash)", !v.ok && failed(v).includes("hash"), `failed checks: ${failed(v).join(", ")}`); }

  { const f = dir("rehashed"); const rows = writeLedger(f, bodies).map((l) => JSON.parse(l));
    rows[0].p = 0.9; delete rows[0].hash; rows[0].hash = SL.hashBody(rows[0]);                 // edited AND re-hashed: `hash` is happy again
    fs.writeFileSync(f, rows.map((r) => SL.canonicalJson(r)).join("\n") + "\n");
    const v = SC.checkFile(f, { now: Date.parse("2026-07-01T12:00:00Z") });
    ok("an edited row whose own hash was redone still refuses (chain)", !v.ok && failed(v).includes("chain"), `failed checks: ${failed(v).join(", ")}`);
    ok("the hash check is happy with the re-hashed row, so chain is what caught it", v.checks.find((c) => c.id === "hash").ok, "hash also failed, so this case does not prove chain"); }

  { const f = dir("truncated"); writeLedger(f, bodies); const t = fs.readFileSync(f, "utf8").split("\n").filter(Boolean); fs.writeFileSync(f, t.slice(0, 2).join("\n") + "\n");
    const v = SC.checkFile(f, { now: Date.parse("2026-07-01T12:00:00Z") });
    ok("a ledger cut short no longer matches its tip", !v.ok && failed(v).includes("tip"), `failed checks: ${failed(v).join(", ")}`);
    ok("the tip refusal says rows are missing from the end", /ROWS ARE MISSING FROM THE END/.test(v.checks.find((c) => c.id === "tip").detail), v.checks.find((c) => c.id === "tip").detail);
    ok("every other check still passes on the truncated ledger, so tip is what caught it", failed(v).length === 1, `failed checks: ${failed(v).join(", ")}`); }

  { const f = dir("notip"); writeLedger(f, bodies, { tip: false });
    const v = SC.checkFile(f, { now: Date.parse("2026-07-01T12:00:00Z") });
    ok("a ledger with no tip file at all is refused", !v.ok && failed(v).includes("tip"), `failed checks: ${failed(v).join(", ")}`); }

  { const f = dir("reordered"); const rows = writeLedger(f, bodies).map((l) => JSON.parse(l));
    fs.writeFileSync(f, [rows[1], rows[0], rows[2]].map((r) => SL.canonicalJson(r)).join("\n") + "\n");
    const v = SC.checkFile(f, { now: Date.parse("2026-07-01T12:00:00Z") });
    ok("two rows swapped are refused by seq, chain and forDateOrder together", !v.ok && ["seq", "chain", "forDateOrder"].every((id) => failed(v).includes(id)), `failed checks: ${failed(v).join(", ")}`); }

  { const f = dir("weekend"); writeLedger(f, rechainBodies([sampleBody("2026-07-04", "2026-07-03")]));
    const v = SC.checkFile(f, { now: Date.parse("2026-07-05T12:00:00Z") });
    ok("a forDate on a Saturday is refused (sessionDay)", !v.ok && failed(v).includes("sessionDay"), `failed checks: ${failed(v).join(", ")}`); }

  { const f = dir("holiday"); writeLedger(f, [sampleBody("2026-11-26", "2026-11-25")]);
    const v = SC.checkFile(f, { now: Date.parse("2026-11-27T12:00:00Z"), holidays: { "2026-11-26": "Thanksgiving Day" } });
    ok("a forDate on a market holiday is refused (sessionDay)", !v.ok && failed(v).includes("sessionDay"), `failed checks: ${failed(v).join(", ")}`);
    ok("Thanksgiving is in the repo's own holiday list, so the live checker refuses it too", SC.HOLIDAYS["2026-11-26"] === "Thanksgiving Day", `the list says ${JSON.stringify(SC.HOLIDAYS["2026-11-26"])}`); }

  { const f = dir("future"); writeLedger(f, bodies);
    const v = SC.checkFile(f, { now: Date.parse("2026-06-01T12:00:00Z") });
    ok("a row dated after the moment of the check is refused (notFuture)", !v.ok && failed(v).includes("notFuture"), `failed checks: ${failed(v).join(", ")}`); }

  { const f = dir("garbage"); writeLedger(f, bodies); fs.appendFileSync(f, "not json\n");
    const v = SC.checkFile(f, { now: Date.parse("2026-07-01T12:00:00Z") });
    ok("a line that is not JSON refuses (parse)", !v.ok && failed(v).includes("parse"), `failed checks: ${failed(v).join(", ")}`);
    ok("no later check claims to have run once the file does not read as rows", v.checks.filter((c) => c.id !== "parse").every((c) => !c.ran), v.checks.filter((c) => c.ran).map((c) => c.id).join(", ")); }

  { const f = dir("empty");
    const v = SC.checkFile(f, { now: Date.parse("2026-07-01T12:00:00Z") });
    ok("a ledger that does not exist yet passes (there is nothing to disbelieve)", v.ok, `refused: ${failed(v).join(", ")}`);
    eq("an empty ledger reports no rows", v.rows, 0); }

  { const f = dir("edge"); writeLedger(f, [sampleBody("2026-07-01", "2026-06-30")], { nowOf: (b) => SL.sealDeadlineMs(b.forDate) - 1 });
    const v = SC.checkFile(f, { now: Date.parse("2026-07-01T14:00:00Z") });
    ok("a row written one millisecond before the open is sealed", v.ok, `refused: ${failed(v).join(", ")} — ${v.failed.map((c) => c.detail).join(" | ")}`); }

  { const f = dir("atopen"); writeLedger(f, [sampleBody("2026-07-01", "2026-06-30")], { nowOf: (b) => SL.sealDeadlineMs(b.forDate) });
    const v = SC.checkFile(f, { now: Date.parse("2026-07-01T14:00:00Z") });
    ok("a row written AT the open exactly is not sealed", !v.ok && failed(v).includes("seal"), `failed checks: ${failed(v).join(", ")}`); }
}
const rechainBodies = (b) => b;

// ── suite: nightly-model ─────────────────────────────────────────────────────────────────────────────────────────────
function suiteNightlyModel(T, TMP) {
  const { ok, eq, near, throws } = T;
  eq("the production window is run.js's 1,260 sessions", NM.WIN, 1260);
  eq("the production tail is 5%", NM.TAIL, 0.05);
  eq("the production history floor is 200 sessions (dist200 needs them)", NM.MIN_HISTORY, 200);
  eq("the ridge is run.js's lambda 10", NM.LAMBDA, 10);
  eq("the causal flag is the top decile", NM.TOP_DECILE, 0.10);
  eq("rule of thumb (a) reads the 80th vol percentile", NM.RULE_VOL_Q, 0.80);
  eq("the model states seven price-only inputs", NM.FEATURES.join(","), "lnRv5,lnRv20,lnRv60,ret1,ret5,dist50,dist200");

  const bars = syntheticBars();
  eq("the synthetic bars are 340 sessions", bars.length, 340);
  eq("the synthetic bars start on the pinned date", bars[0].d, "2025-02-24");
  eq("the synthetic bars end on the pinned date", bars[339].d, "2026-06-12");
  near("the first synthetic close is the pinned value", bars[0].c, 99.382888, 5e-7);
  near("the last synthetic close is the pinned value", bars[339].c, 103.147741, 5e-7);
  ok("every synthetic date is a weekday, strictly increasing", bars.every((b, i) => (i === 0 || b.d > bars[i - 1].d) && ![0, 6].includes(new Date(b.d + "T12:00:00Z").getUTCDay())), "a date is a weekend or out of order");

  // the bars are read the same way whichever shape the file holds
  { const f1 = path.join(TMP, "bars-list.json"), f2 = path.join(TMP, "bars-yahoo.json");
    fs.writeFileSync(f1, JSON.stringify(bars));
    fs.writeFileSync(f2, JSON.stringify({ rows: bars.map((b) => ({ date: b.d, close: b.c, adjClose: b.a, volume: 1 })) }));
    eq("a plain list and a Yahoo cache read to the same bars", JSON.stringify(NM.readBars(f1)), JSON.stringify(NM.readBars(f2)));
    const f3 = path.join(TMP, "bars-dirty.json");
    fs.writeFileSync(f3, JSON.stringify([{ d: "2026-07-04", c: 1, a: 1 }, ...bars.slice(0, 3), bars[2], { d: "2026-01-02", c: -1, a: 1 }]));
    eq("a weekend row, a repeat and a non-positive price are dropped", NM.readBars(f3).map((b) => b.d).join(","), "2025-02-24,2025-02-25,2025-02-26"); }

  // the threshold, recomputed by a straight loop (verify.js's way: the ceil(p*n)-th smallest of the window)
  { const S = NM.series(bars), i = 339, win = CFG.win;
    const w = []; for (let k = i - win + 1; k <= i; k++) w.push(S.adj[k] / S.adj[k - 1] - 1);
    w.sort((a, b) => a - b);
    const independent = w[Math.ceil(0.05 * win) - 1];
    eq("the 5% threshold is the 3rd smallest of the 60 returns ending at the decision close", NM.thresholdAt(S, i, { win: CFG.win, tail: CFG.tail }), independent);
    eq("the nearest-rank index is ceil(0.05 x 60) = 3", Math.ceil(0.05 * win), 3); }

  // rule of thumb (a), recomputed by a straight loop
  { const S = NM.series(bars), i = 339, win = CFG.win;
    let s = 0; for (let k = i - 199; k <= i; k++) s += S.close[k]; const sma200 = s / 200;
    const rw = []; for (let k = i - win + 1; k <= i; k++) if (Number.isFinite(S.rv20[k])) rw.push(S.rv20[k]);
    rw.sort((a, b) => a - b); const q80 = rw[Math.ceil(0.8 * rw.length) - 1];
    const independent = S.close[i] < sma200 && S.rv20[i] >= q80 ? 1 : 0;
    eq("rule of thumb (a) matches a straight-loop recomputation", NM.ruleFlagAt(S, i, { win: CFG.win, volQ: CFG.volQ }), independent);
    eq("the drawdown fixture does trip rule (a)", independent, 1); }

  // the forecast itself
  const fc = NM.forecastAsOf(bars, { ...CFG, asOf: "2026-06-12" });
  eq("the forecast is decided at the last bar", fc.asOfDate, "2026-06-12");
  ok("the probability is a probability", fc.p >= 0 && fc.p <= 1, `p = ${fc.p}`);
  near("the probability is the pinned value", fc.p, 0.176813804, 1e-9);
  near("the causal top-decile threshold is the pinned value", fc.stormThr, 0.158588408, 1e-9);
  eq("the fit saw every labelled session known at the decision close", fc.model.nTrain, 139);
  eq("the fit one bar back sees one row fewer, never the label of the session it forecasts", NM.forecastAsOf(bars, { ...CFG, asOf: "2026-06-11" }).model.nTrain, 138);
  eq("the model names itself in the row", fc.model.id, "worst-day-nightly-price-v1");
  eq("the drawdown fixture reads as a storm", fc.storm, "storm");
  eq("both flags are up on the drawdown fixture", `${fc.flagModel}${fc.flagRule}`, "11");
  near("the stated threshold is the one the straight loop found", fc.thr, NM.thresholdAt(NM.series(bars), 339, { win: CFG.win, tail: CFG.tail }), 0);
  eq("the stated decision close is the bar's adjusted close", fc.asOfAdj, bars[339].a);

  // the causal flag really is the training top decile
  { const S = NM.series(bars), X = [], train = [];
    for (let i = 0; i <= 339; i++) X.push(NM.featureRow(S, i, { minHistory: CFG.minHistory }));
    for (let i = 200; i <= 338; i++) train.push(i);
    eq("the training rows are the 139 sessions whose label is known at the decision close", train.length, fc.model.nTrain);
    ok("about a tenth of the training probabilities are at or above the flag's threshold", (() => { const L = require("./lib.js"); const y = new Float64Array(340);
      for (const i of train) y[i] = S.r[i + 1] <= NM.thresholdAt(S, i, { win: CFG.win, tail: CFG.tail }) ? 1 : 0;
      const m = L.logitFit(X, y, train, { lambda: CFG.lambda }); const ps = train.map((i) => L.logitPredict(m, X[i]));
      const share = ps.filter((p) => p >= L.qHigh(ps, 0.10)).length / ps.length; return share >= 0.08 && share <= 0.13; })(), "the share above the threshold is not near a tenth"); }

  // nothing after the decision bar is read
  { const proof = NM.lookAheadProof(bars, { ...CFG, asOf: "2026-06-11" });
    ok("SCRAMBLING EVERY BAR AFTER THE DECISION CLOSE CHANGES NOTHING IN THE FORECAST", proof.same, proof.differs.join("; "));
    eq("the proof ran the scramble both ways round", proof.runs.length, 2);
    ok("the proof really did change the bars after the decision close", proof.a.asOfDate === "2026-06-11", "the proof did not run at the date asked for"); }

  // the calm twin
  { const calm = syntheticBars({ calmOnly: true });
    const c = NM.forecastAsOf(calm, { ...CFG, asOf: calm[339].d });
    eq("a calm fixture with no drawdown reads as calm", c.storm, "calm");
    eq("rule of thumb (a) is down on the calm fixture", c.flagRule, 0); }

  // refusals
  throws("a decision bar with too little history behind it is refused", () => NM.forecastAsOf(bars.slice(0, 150), { ...CFG, asOf: bars[149].d }), /needs at least 200 bars before it/);
  throws("a date that is not a bar is refused", () => NM.forecastAsOf(bars, { ...CFG, asOf: "2026-06-13" }), /is not one of the 340 bars/);
  throws("too few labelled sessions is refused rather than answered", () => NM.forecastAsOf(bars.slice(0, 225), { ...CFG, asOf: bars[224].d, minTrain: 30 }), /only 24 labelled session\(s\)/);

  // the calendar
  eq("the next session after a Friday is the Monday", NM.nextSessionAfter("2026-07-03", {}), "2026-07-06");
  eq("the next session steps over a market holiday", NM.nextSessionAfter("2026-11-25", { "2026-11-26": "Thanksgiving Day" }), "2026-11-27");
  eq("the next session steps over a holiday that falls on a Monday", NM.nextSessionAfter("2026-09-04", { "2026-09-07": "Labor Day" }), "2026-09-08");
}

// ── suite: nightly-forecast ──────────────────────────────────────────────────────────────────────────────────────────
function suiteNightlyForecast(T, TMP) {
  const { ok, eq } = T;
  const bars = syntheticBars(), barsFile = path.join(TMP, "nf", "bars.json");
  fs.mkdirSync(path.dirname(barsFile), { recursive: true });
  fs.writeFileSync(barsFile, JSON.stringify(bars));
  const forDate = NM.nextSessionAfter(bars[339].d, SC.HOLIDAYS);                    // 2026-06-12 is a Friday -> 2026-06-15
  eq("tomorrow after the last synthetic bar is the Monday", forDate, "2026-06-15");
  const evening = SL.sealDeadlineMs(forDate) - 12 * 3600000;                        // 21:30 ET of the Friday
  const quiet = () => {};

  { const led = path.join(TMP, "nf", "plan.jsonl");
    const r = NF.run({ barsFile, ledgerFile: led, write: false, now: evening, opts: CFG, log: quiet });
    eq("--plan says the write would go through", r.result, "plan");
    ok("--plan writes nothing", !fs.existsSync(led), "a ledger file appeared");
    eq("--plan names tomorrow", r.plan.forDate, forDate); }

  { const led = path.join(TMP, "nf", "write.jsonl");
    const r = NF.run({ barsFile, ledgerFile: led, write: true, now: evening, opts: CFG, log: quiet });
    eq("--write appends the row", r.result, "written");
    eq("the row names tomorrow", r.row.forDate, forDate);
    eq("the row was decided at the last bar", r.row.asOfDate, "2026-06-12");
    const fc = NM.forecastAsOf(bars, { ...CFG, asOf: "2026-06-12" });
    eq("the row's probability is the model's, to twelve places", r.row.p, +fc.p.toFixed(12));
    eq("the row's storm state is the model's", r.row.storm, fc.storm);
    const v = SC.checkFile(led, { now: evening });
    ok("the ledger the job wrote passes every check", v.ok, v.failed.map((c) => `${c.id}: ${c.detail}`).join(" | "));
    const again = NF.run({ barsFile, ledgerFile: led, write: true, now: evening + 1000, opts: CFG, log: quiet });
    eq("a second run for the same session does nothing", again.result, "already");
    eq("the ledger still holds one row", SL.readLedger(led).rows.length, 1); }

  { const led = path.join(TMP, "nf", "late.jsonl");
    const r = NF.run({ barsFile, ledgerFile: led, write: true, now: SL.sealDeadlineMs(forDate), opts: CFG, log: quiet });
    eq("a run at 09:30 ET of the session it would forecast is REFUSED", r.result, "refused");
    ok("the refusal says the seal is closed", r.plan.refusals.some((w) => /THE SEAL IS CLOSED/.test(w)), r.plan.refusals.join(" | "));
    ok("a refused run writes no ledger at all", !fs.existsSync(led), "a ledger file appeared"); }

  { const led = path.join(TMP, "nf", "stale.jsonl");
    const r = NF.run({ barsFile, ledgerFile: led, write: true, now: Date.parse("2026-08-03T01:00:00Z"), opts: CFG, log: quiet });
    eq("stale bars are refused rather than forecast into the past", r.result, "refused");
    ok("the refusal says the bars are stale", r.plan.refusals.some((w) => /already behind the ET clock/.test(w)), r.plan.refusals.join(" | ")); }

  { const led = path.join(TMP, "nf", "broken.jsonl");
    writeLedger(led, [sampleBody("2026-06-10", "2026-06-09")]);
    const t = fs.readFileSync(led, "utf8").replace('"p":0.0625', '"p":0.9000'); fs.writeFileSync(led, t);
    const r = NF.run({ barsFile, ledgerFile: led, write: true, now: evening, opts: CFG, log: quiet });
    eq("nothing is appended to a ledger that does not pass", r.result, "refused");
    eq("the broken ledger is left exactly as it was", SL.readLedger(led).rows.length, 1); }

  { const r = NF.run({ barsFile: path.join(TMP, "nf", "missing.json"), ledgerFile: path.join(TMP, "nf", "x.jsonl"), write: true, now: evening, opts: CFG, log: quiet });
    eq("a bar file that is not there stops the run before anything is written", r.code, 2); }
}

// ── suite: sealed-grade ──────────────────────────────────────────────────────────────────────────────────────────────
function buildGradedLedger(TMP, bars, { from = 300, to = 340 } = {}) {
  const led = path.join(TMP, "grade", "led.jsonl");
  fs.mkdirSync(path.dirname(led), { recursive: true });
  try { fs.unlinkSync(led); } catch { /* not there */ }
  for (let i = from; i < to; i++) {
    const asOf = bars[i - 1].d, forDate = bars[i].d;
    const fc = NM.forecastAsOf(bars.slice(0, i), { ...CFG, asOf });
    const body = { forDate, asOfDate: fc.asOfDate, p: +fc.p.toFixed(12), score: +fc.score.toFixed(12), storm: fc.storm, stormThr: +fc.stormThr.toFixed(12),
      flagModel: fc.flagModel, flagRule: fc.flagRule, thr: +fc.thr.toFixed(12), asOfAdj: +fc.asOfAdj.toFixed(10), model: fc.model };
    SL.appendRow(led, body, { now: SL.sealDeadlineMs(forDate) - 12 * 3600000, check: SC.check });
  }
  // one more row for the session AFTER the last bar: it can never have matured, which is what a live ledger always looks like
  { const asOf = bars[to - 1].d, forDate = NM.nextSessionAfter(asOf, SC.HOLIDAYS);
    const fc = NM.forecastAsOf(bars.slice(0, to), { ...CFG, asOf });
    SL.appendRow(led, { forDate, asOfDate: fc.asOfDate, p: +fc.p.toFixed(12), score: +fc.score.toFixed(12), storm: fc.storm, stormThr: +fc.stormThr.toFixed(12),
      flagModel: fc.flagModel, flagRule: fc.flagRule, thr: +fc.thr.toFixed(12), asOfAdj: +fc.asOfAdj.toFixed(10), model: fc.model },
      { now: SL.sealDeadlineMs(forDate) - 12 * 3600000, check: SC.check }); }
  return led;
}
function suiteSealedGrade(T, TMP) {
  const { ok, eq, near } = T;
  eq("the no-skill forecast is 0.05, the rate the target is defined at", SG.P0, 0.05);
  eq("the calibration bins are the six fixed in advance", JSON.stringify(SG.BINS), "[[0,0.02],[0.02,0.05],[0.05,0.1],[0.1,0.2],[0.2,0.4],[0.4,1]]");
  eq("a probability on a bin's lower edge falls in that bin", SG.binOf(0.05), 2);
  eq("a probability just under a bin's upper edge stays below it", SG.binOf(0.0499999), 1);
  eq("0 falls in the first bin", SG.binOf(0), 0);
  eq("1 falls in the last bin", SG.binOf(1), 5);

  const bars = syntheticBars(), barsFile = path.join(TMP, "grade", "bars.json");
  fs.mkdirSync(path.dirname(barsFile), { recursive: true });
  fs.writeFileSync(barsFile, JSON.stringify(bars));
  const led = buildGradedLedger(TMP, bars);
  const now = Date.parse("2026-06-15T12:00:00Z"), quiet = () => {};
  eq("the synthetic ledger holds forty-one rows", SL.readLedger(led).rows.length, 41);

  const g = SG.run({ ledgerFile: led, barsFile, outFile: path.join(TMP, "grade", "out.json"), dry: true, now, log: quiet });
  eq("the grader ran", g.result, "dry");
  const o = g.out;
  eq("forty rows have matured", o.maturity.matured, 40);
  eq("the row for the session after the last bar is still pending", o.maturity.pending, 1);
  eq("nothing is disputed", o.maturity.disputed, 0);

  // y, Brier and the always-5% Brier, recomputed by a straight loop over the same rows
  { const rows = SL.readLedger(led).rows, byDate = new Map(bars.map((b, i) => [b.d, i]));
    let n = 0, w = 0, b = 0, b0 = 0;
    for (const r of rows) {
      const i = byDate.get(r.forDate); if (i === undefined || i === 0) continue;
      const ret = bars[i].a / bars[i - 1].a - 1, y = ret <= r.thr ? 1 : 0;
      n++; w += y; b += (r.p - y) ** 2; b0 += (0.05 - y) ** 2;
    }
    eq("the straight loop matures the same rows", n, o.score.n);
    eq("the straight loop counts the same worst days", w, o.score.worst);
    near("the Brier score is the arithmetic", o.score.brier, b / n, 1e-6);
    near("the always-5% Brier score is the arithmetic", o.score.brierAlways5pct, b0 / n, 1e-6);
    near("the skill is 1 - Brier / Brier(always-5%)", o.score.skillVsAlways5pct, 1 - (b / n) / (b0 / n), 1e-6); }

  // the calibration table
  { const cal = o.score.calibration;
    eq("the calibration table's rows add up to the matured count", cal.reduce((a, c) => a + c.n, 0), o.score.n);
    eq("the calibration table's worst days add up to the worst-day count", cal.reduce((a, c) => a + c.worst, 0), o.score.worst);
    ok("an empty bin states nothing rather than zero", cal.every((c) => (c.n === 0) === (c.rate === null)), JSON.stringify(cal));
    ok("every non-empty bin's realised rate is its own worst days over its own rows", cal.every((c) => c.n === 0 || Math.abs(c.rate - c.worst / c.n) < 5e-7), JSON.stringify(cal));
    ok("every non-empty bin's mean probability is inside the bin", cal.every((c) => c.n === 0 || (c.meanP >= c.from && c.meanP <= c.to)), JSON.stringify(cal)); }

  // Murphy's decomposition
  { const D = o.score.decomposition;
    near("Brier = reliability - resolution + uncertainty + the within-bin remainder", D.reliability - D.resolution + D.uncertainty + D.withinBinRemainder, o.score.brier, 2e-6);
    near("uncertainty is the base rate's own variance", D.uncertainty, o.score.baseRate * (1 - o.score.baseRate), 1e-6); }

  // the storm table
  { const st = o.score.storm;
    eq("the storm table's rows add up to the matured count", st.reduce((a, s) => a + s.n, 0), o.score.n);
    eq("the storm table names the three states in order", st.map((s) => s.storm).join(","), "calm,watch,storm");
    ok("every state's realised rate is its own worst days over its own rows", st.every((s) => s.n === 0 || Math.abs(s.rate - s.worst / s.n) < 5e-7), JSON.stringify(st)); }

  eq("forty matured rows is below the bar set in advance, and the grader says so", o.enoughToRead, false);
  ok("the reading says how thin it is", /TOO THIN TO READ/.test(o.reading), o.reading);
  eq("the bar set in advance is 252 matured rows and 20 worst days", `${SG.MIN_MATURED}/${SG.MIN_WORST}`, "252/20");

  // hand-built extremes
  { const mk = (p, y) => ({ row: { p, storm: "calm", seq: 1 }, y });
    const perfect = [mk(1, 1), mk(0, 0), mk(1, 1), mk(0, 0)];
    eq("a forecaster that is always right scores 0", SG.score(perfect).brier, 0);
    const backwards = [mk(0, 1), mk(1, 0), mk(0, 1), mk(1, 0)];
    eq("a forecaster that is always wrong scores 1", SG.score(backwards).brier, 1);
    const flat = [mk(0.5, 1), mk(0.5, 0)];
    eq("a forecaster that always says a half scores a quarter", SG.score(flat).brier, 0.25);
    eq("nothing matured means no score at all", SG.score([]).n, 0); }

  // the grader refuses a ledger the checker refuses
  { const bad = path.join(TMP, "grade", "bad.jsonl");
    fs.copyFileSync(led, bad); fs.copyFileSync(SL.tipPathFor(led), SL.tipPathFor(bad));
    const t = fs.readFileSync(bad, "utf8").split("\n"); t[0] = t[0].replace(/"p":[0-9.]+/, '"p":0.5'); fs.writeFileSync(bad, t.join("\n"));
    const r = SG.run({ ledgerFile: bad, barsFile, outFile: path.join(TMP, "grade", "bad-out.json"), dry: true, now, log: quiet });
    eq("A LEDGER THE CHECKER REFUSES IS NOT GRADED", r.result, "refused");
    eq("the refused run exits 3", r.code, 3);
    ok("the refused run produced no score", !r.out, "a score was produced anyway"); }

  // a row the bars disagree with is disputed, never graded
  { const rows = SL.readLedger(led).rows.map((r) => ({ ...r }));
    rows[0].asOfAdj = rows[0].asOfAdj + 1;
    const M = SG.mature(rows, bars);
    eq("a row whose stated decision close no longer matches the bars is disputed", M.disputed.length, 1);
    ok("the dispute says both numbers", /the bars say/.test(M.disputed[0].why), M.disputed[0].why);
    eq("the disputed row is not graded", M.matured.length, 39); }

  // the written file
  { const out = path.join(TMP, "grade", "written.json");
    const r = SG.run({ ledgerFile: led, barsFile, outFile: out, dry: false, now, log: quiet });
    eq("the grader writes its JSON", r.result, "graded");
    const j = JSON.parse(fs.readFileSync(out, "utf8"));
    eq("the written file carries the spec", j.spec, "worst-day-sealed-grade-v1");
    eq("the written file carries the same matured count", j.maturity.matured, 40);
    eq("the written file records that the seal check passed", j.sealCheck.passed, true); }
}

// ── the runner ───────────────────────────────────────────────────────────────────────────────────────────────────────
const SUITES = { "sealed-ledger": suiteSealedLedger, "sealed-check": suiteSealedCheck, "nightly-model": suiteNightlyModel, "nightly-forecast": suiteNightlyForecast, "sealed-grade": suiteSealedGrade };

function run(names = Object.keys(SUITES), { log = (s) => console.log(s) } = {}) {
  const want = names.length ? names : Object.keys(SUITES);
  const unknown = want.filter((n) => !SUITES[n]);
  if (unknown.length) { log(`no such suite: ${unknown.join(", ")} (have: ${Object.keys(SUITES).join(", ")})`); return 2; }
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wd-sealed-"));
  const T = makeRunner();
  try {
    for (const n of want) {
      const before = T.results.length, sub = path.join(TMP, n);
      fs.mkdirSync(sub, { recursive: true });
      try { SUITES[n](T, sub); } catch (e) { T.results.push({ name: `${n}: the suite itself threw`, ok: false, why: (e && e.stack ? e.stack : String(e)).split("\n").slice(0, 4).join(" / ") }); }
      log(`  -- ${n} (${T.results.length - before} checks)`);
      for (const r of T.results.slice(before)) log(r.ok ? `  ok   ${r.name}` : `  FAIL ${r.name} — ${r.why}`);
    }
  } finally { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* the OS will */ } }
  const bad = T.results.filter((r) => !r.ok);
  log(bad.length ? `FAILED — ${bad.length} of ${T.results.length} checks` : `ALL ${T.results.length} CHECKS PASSED`);
  return bad.length ? 1 : 0;
}

module.exports = { run, SUITES, syntheticBars, weekdaysFrom, mulberry32, CFG, writeLedger, sampleBody, buildGradedLedger };

if (require.main === module) process.exitCode = run(process.argv.slice(2).filter((a) => !a.startsWith("--")));
