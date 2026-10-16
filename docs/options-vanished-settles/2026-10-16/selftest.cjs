#!/usr/bin/env node
"use strict";
/**
 * OPTIONS-VANISHED-SETTLES (2026-10-16) — SELFTEST. Known answers for everything this package builds. It writes nothing inside the
 * repository (scratch trees and scratch repos in the OS temp folder only), reads no key, and makes NO network call of any kind: every
 * run of the settle is a child process with harness/no-network.cjs preloaded, which makes fetch / http / https / net / dns throw and
 * records the attempt, so each check can assert the attempt count is ZERO rather than assume it.
 * Last line: "ALL <n> CHECKS PASSED", or the failures and exit 1.
 *
 *   node docs/options-vanished-settles/2026-10-16/selftest.cjs
 *
 *   A  the package: base and staged copies are the bytes deploy.cjs names; both parse; the staged file loads as a module and runs
 *      nothing; the lines fixes 4.2 and 4.7 put in it are still there byte for byte; it asks no broker anywhere
 *   B  the rules, as pure functions on known answers: the intrinsic (and that it agrees with the wings' own expression on a grid), the
 *      leg check, the snapshot reader, the vanished test, the stored-close order, the settle row, and the mirror-order marks
 *   C  whole runs on the fixtures, as processes in scratch trees: no regression against the base file, the defect and its fix, UNKNOWN
 *      flagged and never guessed, every way the snapshot can fail to prove the legs are gone, idempotence, the flag lifted, the mirror
 *      marks, an empty board, and zero network attempts in every one of them
 *   D  deploy and rollback on scratch repos: base -> staged -> base byte-exact, drift refused, every fence, a red gate
 *   E  record.cjs: --dry on the real data writes nothing; on scratch data the write, a second run, the window, another's lock, not applied
 *   F  mutation-proof: each mutant of the staged file is caught by the check of B or C written for it
 */
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", "..");
const D = require("./deploy.cjs"), RB = require("./rollback.cjs"), REC = require("./record.cjs");
const T = require("./harness/tree.cjs"), FX = require("./harness/fixtures.cjs");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const STAGED = fs.readFileSync(path.join(PKG, "staged", "backend", "options-settle.js"), "utf8");
const BASE = fs.readFileSync(path.join(PKG, "base", "backend", "options-settle.js"), "utf8");
let pass = 0, failN = 0; const failed = [];
function ok(name, cond, detail) { if (cond) { pass++; console.log(`  ok   ${name}`); } else { failN++; failed.push(String(name).split(" ")[0]); console.log(`  FAIL ${name}${detail === undefined ? "" : " — " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 700)}`); } }
const section = (s) => console.log(`\n${s}`);
/** an exact text replacement that must match exactly once (a mutant) */
function mutate(text, from, to) { const n = text.split(from).length - 1; if (n !== 1) throw new Error(`mutation anchor found ${n} times, not once: ${from.slice(0, 90)}`); return text.replace(from, () => to); }
const J = (x) => JSON.stringify(x);
/** the three files a settle run writes, normalized so two runs can be compared byte for byte */
const written = (d) => T.normalize({ trade_log: d["trade_log.json"], board: d["board_positions.json"], tombs: d["board_tombstones.json"] });
/** the bar calls a run made, with the real-time `end` stamp of fix 4.7's recording call taken out so two runs can be compared */
const callsOf = (r) => JSON.stringify(r.barCalls).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<ts>");

(async () => {
  // ── A. the package ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("A. the package");
  const F0 = D.FILES[0];
  ok("A1 base/backend/options-settle.js is the bytes the package was built against (deploy.cjs FILES baseSha)", sha(Buffer.from(BASE)) === F0.baseSha, sha(Buffer.from(BASE)));
  ok("A2 staged/backend/options-settle.js is the reviewed bytes (deploy.cjs FILES stagedSha)", sha(Buffer.from(STAGED)) === F0.stagedSha, sha(Buffer.from(STAGED)));
  for (const [n, rel] of [["A3 staged", "staged"], ["A4 base", "base"]]) {
    const c = cp.spawnSync(process.execPath, ["--check", path.join(PKG, rel, "backend", "options-settle.js")], { encoding: "utf8", windowsHide: true });
    ok(`${n}/backend/options-settle.js passes node --check`, c.status === 0, c.stderr);
  }
  { // the lines the 2026-10-12 a-booking package (fixes 4.2 and 4.7) put in this file, and the fail-closed lines of the original
    const NEEDLES = [
      "const voidedRestore = (t, p) => !!(t && p && t.id === p.id && t.retired && t.voidForEvidence === true && p.obs && p.obs.restoredAfter === t.retired);",
      "const isDebitVertical = (p) => {",
      "const settledBefore = (p) => (rowsById.get(p.id) || []).some((t) => !voidedRestore(t, p));",
      "const wingsTodo = todo.filter((p) => p.optCredit), debitTodo = todo.filter((p) => !p.optCredit);",
      "settleUnderOfficial: off.c, settleOfficialSrc: \"alpaca sip raw 1Day close\", settleOfficialAsOf: offEnd.toISOString(), pnlOfficial: offPnl,",
      "if (!settled.length) { console.error(`OPTIONS SETTLE — ${todo.length} wing(s) expired, NONE settleable: ${stuck.concat(stuckDebit).join(\"; \")}`); process.exit(2); }",
      "const COMMISSION_PER_LEG = 0.65, LEGS_AT_ENTRY = 2;",
    ];
    const kept = NEEDLES.filter((n) => STAGED.includes(n)), inBase = NEEDLES.filter((n) => BASE.includes(n));
    ok("A5 every line fixes 4.2 / 4.7 and the original fail-closed rules depend on is still in the staged file, byte for byte", kept.length === NEEDLES.length && inBase.length === NEEDLES.length, { kept: kept.length, of: NEEDLES.length, missing: NEEDLES.filter((n) => !STAGED.includes(n)).map((n) => n.slice(0, 60)) });
  }
  ok("A6 the staged file asks no broker and places no order: no /v2/ path, no order verb, no Alpaca key read, and the only fetch is the bars library's",
    !/\/v2\//.test(STAGED) && !/ALPACA_(KEY|SECRET)/.test(STAGED) && !/\bfetch\(/.test(STAGED) && !/paper-api|api\.alpaca/.test(STAGED), { v2: /\/v2\//.test(STAGED), fetch: /\bfetch\(/.test(STAGED) });
  const tmpM = T.makeTree({ scriptText: STAGED, data: {}, bars: FX.BARS });
  let M = null; try { M = require(path.join(tmpM.bk, "options-settle.js")); } catch (e) { ok("A7 the staged file loads as a module", false, e.message); }
  if (!M) { console.log("\ncannot go on without the module"); process.exit(1); }
  ok("A7 the staged file loads as a module without running the sweep (require.main guard): the exported rules are there and backend/data got nothing",
    typeof M.vanishedRow === "function" && typeof M.vanishedCheck === "function" && typeof M.verticalIntrinsic === "function" && M.VANISHED_TAG === "vanished-legs-2026-10-16" && M.VANISHED_REASON === "expiry-vanished" && fs.readdirSync(tmpM.dd).length === 0,
    { keys: Object.keys(M).length, data: fs.readdirSync(tmpM.dd) });

  // ── B. the rules, pure ─────────────────────────────────────────────────────────────────────────────────────────────────────
  section("B. the rules as pure functions, on known answers");
  { const V = M.verticalIntrinsic;
    const cases = [
      // [call, anchorK, otherK, S, want]
      [false, 220, 215, 222, 0],      // put credit spread, underlying above the short strike: worthless
      [false, 220, 215, 220, 0],      // exactly at the strike
      [false, 220, 215, 218, 2],      // breached by 2 of a 5-wide
      [false, 220, 215, 215, 5],      // at the long strike: the full width
      [false, 220, 215, 100, 5],      // far through: still the width, never more
      [true, 500, 510, 490, 0],       // call spread, underlying below: worthless
      [true, 500, 510, 506, 6],       // 6 of a 10-wide
      [true, 500, 510, 510, 10],      // at the far strike: the width
      [true, 500, 510, 9999, 10],     // far through: the width
      [true, 500, 510, 500, 0],       // at the near strike
      [false, 50, 45, 47.5, 2.5],     // fractional
      [true, 0.5, 1.5, 1, 0.5],       // small strikes
    ];
    const bad = cases.filter(([c, a, b, S, want]) => Math.abs(V(c, a, b, S) - want) > 1e-9);
    ok("B1 verticalIntrinsic: 12 known answers (worthless, at the strike, part-breached, at the far strike, far through, fractional)", bad.length === 0, bad);
    // and it must agree with the expression the wings have always settled at — the one still in the BASE file, reimplemented here
    const wings = (call, atm, k2, S) => (call ? Math.min(Math.max(S - atm, 0), Math.abs(k2 - atm)) : Math.min(Math.max(atm - S, 0), Math.abs(k2 - atm)));
    let grid = 0, off = 0;
    for (const call of [true, false]) for (let atm = 90; atm <= 110; atm += 2.5) for (const w of [1, 2.5, 5, 10]) { const k2 = call ? atm + w : atm - w; for (let S = 80; S <= 120; S += 1.25) { grid++; if (Math.abs(V(call, atm, k2, S) - wings(call, atm, k2, S)) > 1e-12) off++; } }
    ok(`B2 verticalIntrinsic equals the wings' own expression on a ${grid}-point grid, and that expression is still in the base and staged files`,
      off === 0 && grid > 1000 && BASE.includes("? Math.min(Math.max(S - p.optAtm, 0), width)") && STAGED.includes("? Math.min(Math.max(S - p.optAtm, 0), width)"), { grid, off });
  }
  { const L = M.vanLegs, P = FX.POS;
    const good = L(P.V1), sameK = L({ occAtm: FX.occ("MSFT", "260918", "C", 500), occK2: FX.occ("MSFT", "260918", "C", 500) });
    const twoExp = L({ occAtm: FX.occ("MSFT", "260918", "C", 500), occK2: FX.occ("MSFT", "260925", "C", 510) });
    const twoSide = L({ occAtm: FX.occ("MSFT", "260918", "C", 500), occK2: FX.occ("MSFT", "260918", "P", 510) });
    const wrongSide = L({ occAtm: FX.occ("MSFT", "260918", "C", 510), occK2: FX.occ("MSFT", "260918", "C", 500) });
    ok("B3 vanLegs: a real vertical verifies (strikes, side, expiry, normalized symbols); junk, two expiries, two sides, one strike twice, and an optAtm leg on the wrong side each give a reason and no legs",
      !!good.legs && good.legs.a.k === 500 && good.legs.b.k === 510 && good.legs.a.call === true && good.legs.a.occ === P.V1.occAtm
      && !L({}).legs && /do not both parse/.test(L({}).why) && !twoExp.legs && /different expiries/.test(twoExp.why) && !twoSide.legs && /same side/.test(twoSide.why)
      && !sameK.legs && /same strike/.test(sameK.why) && !wrongSide.legs && /money side/.test(wrongSide.why),
      { good: good.why, twoExp: twoExp.why, twoSide: twoSide.why, sameK: sameK.why, wrongSide: wrongSide.why });
  }
  { const S = M.snapshotLegs, a = S(["aapl260918p00220000", " AAPL260918P00215000 "]), b = S({ positions: [{ symbol: "X1" }, { occ: "X2" }, { sym: "X3" }] }), c = S({ legs: ["Y1"] });
    ok("B4 snapshotLegs: a plain list, { positions: [...] } (symbol / occ / sym) and { legs: [...] } all read; case and spaces are normalized; anything else is null",
      a.has("AAPL260918P00220000") && a.has("AAPL260918P00215000") && a.size === 2 && b.size === 3 && b.has("X2") && c.has("Y1") && S(null) === null && S({}) === null && S(7) === null && S({ positions: "x" }) === null, { a: [...a], b: [...b] });
  }
  { const legs = M.vanLegs(FX.POS.V1).legs, exp = FX.EXP, C = (snap) => M.vanishedCheck(legs, exp, snap);
    const after = { asOf: "2026-09-21T13:05:00Z", positions: [] }, same = { asOf: "2026-09-18T23:00:00Z", positions: [] }, before = { asOf: "2026-09-17T13:00:00Z", positions: [] };
    const stillOne = { asOf: "2026-09-21T13:05:00Z", positions: [{ symbol: FX.POS.V1.occK2 }] };
    ok("B5 vanishedCheck is fail-closed: only a snapshot dated AFTER the expiry that names NEITHER leg says they are gone — absent, unreadable, no asOf, the expiry date itself, a date before it, or one leg still reported all answer 'cannot tell'",
      C(after).ok && C(after).asOfDate === "2026-09-21" && !C(null).ok && /no readable broker snapshot/.test(C(null).why)
      && !C({ positions: [] }).ok && /no readable asOf/.test(C({ positions: [] }).why) && !C(same).ok && /not of a date after the expiry/.test(C(same).why)
      && !C(before).ok && !C(stillOne).ok && /still reports/.test(C(stillOne).why) && !C([]).ok,
      { after: C(after), same: C(same).why, stillOne: C(stillOne).why });
  }
  { const p = { sym: "MSFT" }, closes = { MSFT: { "2026-09-18": 506 } };
    const own = M.storedCloseFor({ sym: "MSFT", optExpiryClose: 501 }, "2026-09-18", closes, () => 777);
    const obs = M.storedCloseFor({ sym: "MSFT", obs: { optExpiryClose: 502 } }, "2026-09-18", closes, () => 777);
    const file = M.storedCloseFor(p, "2026-09-18", closes, () => 777), run = M.storedCloseFor(p, "2026-09-18", null, () => 777);
    const none = M.storedCloseFor(p, "2026-09-18", { MSFT: { "2026-09-17": 500 } }, () => null);
    ok("B6 storedCloseFor takes the position's own recorded close first, then underlying-closes.json, then the bar this run read, and NOTHING when none of them has that date (never another day's close)",
      own.c === 501 && /on the position itself/.test(own.src) && obs.c === 502 && file.c === 506 && /underlying-closes/.test(file.src) && run.c === 777 && /bar this run read/.test(run.src) && none.c === null && none.src === null, { own, obs, file, run, none });
  }
  { const legs = (p) => M.vanLegs(p).legs, mk = (p, S) => M.vanishedRow(p, { legs: legs(p), exp: FX.EXP, S, src: "test", snapAsOf: "2026-09-21T13:05:00Z" });
    const w = FX.POS.W1, v = FX.POS.V1;
    const creditClean = mk(w, 222), creditPart = mk(w, 218), creditMax = mk(w, 100), debitIn = mk(v, 506), debitOut = mk(v, 400);
    const noBasis = M.vanishedRow({ ...v, optEntryNet: undefined, debit: undefined }, { legs: legs(v), exp: FX.EXP, S: 506, src: "t", snapAsOf: "" });
    const zeroBasis = M.vanishedRow({ ...v, optEntryNet: 0 }, { legs: legs(v), exp: FX.EXP, S: 506, src: "t", snapAsOf: "" });
    ok("B7 vanishedRow: a credit put wing (2 contracts, credit 1.20) keeps $237.40 clean, $-162.60 at a 2-wide breach and $-762.60 through the width; a debit call spread (debit 3.00) makes $298.70 at 506 and loses $-301.30 at 400; no entry price and an entry of 0 are refused, never guessed",
      creditClean.row.pnl === 237.4 && creditPart.row.pnl === -162.6 && creditMax.row.pnl === -762.6 && debitIn.row.pnl === 298.7 && debitOut.row.pnl === -301.3
      && !noBasis.row && /no entry price is recorded/.test(noBasis.why) && !zeroBasis.row && /not a debit paid/.test(zeroBasis.why),
      { creditClean: creditClean.row && creditClean.row.pnl, creditPart: creditPart.row && creditPart.row.pnl, creditMax: creditMax.row && creditMax.row.pnl, debitIn: debitIn.row && debitIn.row.pnl, debitOut: debitOut.row && debitOut.row.pnl, noBasis: noBasis.why, zeroBasis: zeroBasis.why });
    const r = debitIn.row;
    ok("B8 the row carries its own tag and its provenance, and NEVER a default strategy: reason expiry-vanished, obs.settleKind vanished-legs, settleTag, settleCloseSource, brokerSnapshotAsOf, brokerLegs, the short and long strikes the right way round, and closedAt at the expiry's 20:00Z",
      r.reason === "expiry-vanished" && r.obs.settleKind === "vanished-legs" && r.obs.settleTag === "vanished-legs-2026-10-16" && r.obs.settleCloseSource === "test"
      && r.obs.brokerSnapshotAsOf === "2026-09-21T13:05:00Z" && J(r.obs.brokerLegs) === J([v.occAtm, v.occK2]) && r.obs.shortK === 510 && r.obs.longK === 500 && r.obs.width === 10
      && r.closedAt === Date.parse(FX.EXP + "T20:00:00Z") && r.strategy === "board-ticket" && M.vanishedRow({ ...v, strategy: undefined }, { legs: legs(v), exp: FX.EXP, S: 506, src: "t", snapAsOf: "" }).row.strategy === null
      && Math.abs(r.rMult - 298.7 / 300) < 1e-9, { r });
    ok("B9 a credit wing's row puts the short strike where the credit rule puts it (short 220 / long 215) and keeps the entry as the credit received", creditClean.row.obs.shortK === 220 && creditClean.row.obs.longK === 215 && creditClean.row.entry === 1.2 && creditClean.row.exit === 0, creditClean.row.obs);
  }
  { const rows = FX.MIRROR_LINES.slice(0, 4).map((l) => JSON.parse(l)), isPast = (d) => d < "2026-10-16";
    const hits = M.expiredMirrorRows(rows, isPast);
    ok("B10 rowExpiry reads the expiry from occAtm/occK2, from a legs[] list and from an optExpiry field, and gives null when two legs disagree or nothing names one",
      M.rowExpiry(rows[0]) === FX.EXP && M.rowExpiry(rows[1]) === FX.EXP && M.rowExpiry(rows[2]) === "2099-01-15" && M.rowExpiry({ sym: "AAPL" }) === null
      && M.rowExpiry({ legs: [FX.occ("A", "260918", "C", 1), FX.occ("A", "260925", "C", 2)] }) === null, [M.rowExpiry(rows[0]), M.rowExpiry(rows[1]), M.rowExpiry(rows[2])]);
    ok("B11 expiredMirrorRows takes ONLY rows still shown as \"sent\" whose expiry has passed: the 2099 one and the filled one are left alone",
      hits.length === 2 && hits.every((h) => h.was === "sent" && h.status === "expired" && h.optExpiry === FX.EXP) && J(hits.map((h) => h.ticketId).sort()) === J(["v1-msft", "v2-nvda"]), hits);
    const first = M.markExpiredMirror(null, rows, 1, isPast, "2026-10-16T22:00:00Z");
    const second = M.markExpiredMirror(first.doc, rows, 1, isPast, "2026-11-01T22:00:00Z");
    const third = M.markExpiredMirror(second.doc, rows.concat([{ ts: "x", ticketId: "z", sym: "Z", status: "sent", optExpiry: "2026-09-18", orderId: "o-z" }]), 0, isPast, "2026-11-02T22:00:00Z");
    ok("B12 markExpiredMirror is idempotent: the second run adds nothing and every mark keeps the date it was first made; a new row is added with its own date; the unparsable-line count is carried",
      first.added === 2 && second.added === 0 && second.marked.every((m) => m.markedAt === "2026-10-16T22:00:00Z") && third.added === 1
      && third.marked.filter((m) => m.markedAt === "2026-10-16T22:00:00Z").length === 2 && third.doc.unparsableLogLines === 0 && first.doc.unparsableLogLines === 1 && first.doc.spec === "options-mirror-expired-v1",
      { first: first.added, second: second.added, third: third.added });
  }
  tmpM.done();

  // ── C. whole runs on the fixtures ──────────────────────────────────────────────────────────────────────────────────────────
  section("C. whole runs in scratch trees (child processes, no network, fixtures only)");
  /** run one script text on one data set -> the run */
  function run1(text, data, { bars = FX.BARS } = {}) { const t = T.makeTree({ scriptText: text, data, bars }); try { return { ...T.runTree(t), tree: null }; } finally { t.done(); } }
  const netOf = [];
  const note = (r) => { netOf.push(r.netAttempts.length); return r; };

  { const data = () => FX.data(["W1"], { snapshot: null, closes: null, mirror: false });
    const b = note(run1(BASE, data())), s = note(run1(STAGED, data()));
    ok("C1 NO REGRESSION — a plain wings night (one credit put wing, no snapshot, no stored closes, no mirror log): the staged file writes the ledger, the board and the tombstones byte for byte as the base file does, exits the same, and asks the same bar calls",
      J(written(s.data)) === J(written(b.data)) && s.status === b.status && s.status === 0 && callsOf(s) === callsOf(b) && s.data["trade_log.json"].length === 1 && s.data["trade_log.json"][0].pnl === 237.4,
      { base: b.status, staged: s.status, bRows: b.data["trade_log.json"], sRows: s.data["trade_log.json"] });
  }
  let C2 = null;
  { const data = () => FX.data(["W1", "V1"], { mirror: false });
    const b = note(run1(BASE, data())), s = note(run1(STAGED, data()));
    const bBoard = b.data["board_positions.json"], sBoard = s.data["board_positions.json"], row = s.data["trade_log.json"].find((t) => t.id === "v1-msft");
    C2 = s;
    ok("C2 THE DEFECT, AND THE FIX — the base file leaves the expired MSFT spread open on the board for good (one ledger row, the wing); the staged file settles it at the expiry intrinsic from the stored close: $298.70, reason expiry-vanished, tag vanished-legs-2026-10-16, off the board and tombstoned",
      bBoard.length === 1 && bBoard[0].id === "v1-msft" && b.data["trade_log.json"].length === 1
      && sBoard.length === 0 && s.data["trade_log.json"].length === 2 && !!row && row.pnl === 298.7 && row.exit === 6 && row.entry === 3
      && row.reason === "expiry-vanished" && row.obs.settleTag === "vanished-legs-2026-10-16" && row.obs.settleCloseSource === "backend/data/underlying-closes.json"
      && row.obs.settleUnder === 506 && s.data["board_tombstones.json"].some((t) => t.id === "v1-msft") && s.status === 0,
      { bBoard: bBoard.map((p) => p.id), sBoard: sBoard.map((p) => p.id), row, out: s.out.slice(-700) });
    ok("C3 the wing in the same run is untouched by the new rule: its row is the base file's row for it, byte for byte (the vanished rows are added beside, never instead)",
      J(T.normalize(b.data["trade_log.json"][0])) === J(T.normalize(s.data["trade_log.json"].find((t) => t.id === "w1-aapl"))), { base: b.data["trade_log.json"][0], staged: s.data["trade_log.json"].find((t) => t.id === "w1-aapl") });
  }
  { const s = note(run1(STAGED, FX.data(["V2"], { mirror: false })));
    const p = s.data["board_positions.json"][0];
    ok("C4 UNKNOWN, NEVER GUESSED — the broker no longer reports NVDA's legs but no stored close of NVDA on the expiry date exists: nothing is written to the ledger, the position stays on the board flagged (vanishedUnknown with the tag, the expiry, the reason and the date it was first raised), and the run exits 2",
      s.data["trade_log.json"].length === 0 && s.data["board_positions.json"].length === 1 && !!p.vanishedUnknown && p.vanishedUnknown.tag === "vanished-legs-2026-10-16"
      && p.vanishedUnknown.optExpiry === FX.EXP && /no stored close of NVDA/.test(p.vanishedUnknown.why) && typeof p.vanishedUnknown.since === "string"
      && s.status === 2 && /VANISHED, NOT PRICED/.test(s.out) && !/NaN|undefined/.test(String(p.vanishedUnknown.why)),
      { board: s.data["board_positions.json"], log: s.data["trade_log.json"], status: s.status, out: s.out.slice(-700) });
  }
  { const left = [
      ["C5 the snapshot STILL reports both legs", FX.data(["S1"], { mirror: false })],
      ["C6 there is no snapshot at all", FX.data(["S1"], { snapshot: null, mirror: false })],
      ["C7 the snapshot carries no asOf", FX.data(["S1"], { snapshot: { positions: [] }, mirror: false })],
      ["C8 the snapshot is of the expiry date itself, not after it", FX.data(["S1"], { snapshot: { asOf: "2026-09-18T23:30:00Z", positions: [] }, mirror: false })],
    ];
    for (const [name, data] of left) {
      const b = note(run1(BASE, data)), s = note(run1(STAGED, data));
      ok(`${name}: nothing is settled and nothing is flagged — the staged file writes exactly what the base file writes and exits the same (0)`,
        J(written(s.data)) === J(written(b.data)) && s.status === b.status && s.status === 0 && s.data["trade_log.json"].length === 0
        && s.data["board_positions.json"].length === 1 && !s.data["board_positions.json"][0].vanishedUnknown,
        { bs: b.status, ss: s.status, board: s.data["board_positions.json"], out: s.out.slice(-400) });
    }
  }
  { const data = FX.data(["X1"], { mirror: false }), b = note(run1(BASE, data)), s = note(run1(STAGED, data));
    ok("C9 an expired option with no OCC legs at all is OUTSIDE this rule, not an unknown inside it: it is left exactly as the base file leaves it (on the board, unflagged, exit 0) — nothing is claimed about a broker that was never asked",
      J(written(s.data)) === J(written(b.data)) && s.status === 0 && b.status === 0 && !s.data["board_positions.json"][0].vanishedUnknown, { bs: b.status, ss: s.status, out: s.out.slice(-400) });
  }
  { const t = T.makeTree({ scriptText: STAGED, data: FX.data(["V1"], { mirror: false }), bars: FX.BARS });
    try {
      const r1 = note(T.runTree(t)), r2 = note(T.runTree(t)), r3 = note(T.runTree(t));
      ok("C10 IDEMPOTENT — the same tree run three times: one ledger row for the spread, one tombstone, nothing added on the later runs, and they exit 0 saying there is nothing past expiry",
        r1.data["trade_log.json"].length === 1 && J(r3.data["trade_log.json"]) === J(r1.data["trade_log.json"]) && r3.data["board_tombstones.json"].length === 1
        && r2.status === 0 && r3.status === 0 && /no wings past expiry/.test(r3.out), { r1: r1.data["trade_log.json"].length, r3: r3.data["trade_log.json"].length, out: r3.out.slice(-300) });
    } finally { t.done(); }
  }
  { // the same spread, but already in the ledger while still on the board: the old idempotence rule must still hold it back
    const prior = [{ id: "v1-msft", sym: "MSFT", cls: "Options", pnl: 1, rMult: 0.1, closedAt: Date.parse("2026-09-18T20:00:00Z"), reason: "expiry" }];
    const s = note(run1(STAGED, FX.data(["V1"], { mirror: false, tradeLog: prior })));
    ok("C11 a spread the ledger ALREADY holds is never settled twice, even by the new rule: the ledger is untouched, the board is untouched, exit 0, and the run says it is an idempotent no-op",
      J(s.data["trade_log.json"]) === J(prior) && s.data["board_positions.json"].length === 1 && s.status === 0 && /Idempotent no-op/.test(s.out), { log: s.data["trade_log.json"], out: s.out.slice(-300) });
  }
  { // the flag is lifted once the position is no longer unknown
    const t = T.makeTree({ scriptText: STAGED, data: FX.data(["V2"], { mirror: false }), bars: FX.BARS });
    try {
      const r1 = note(T.runTree(t));
      const stillThere = { spec: "alpaca-options-positions-v1", asOf: "2026-09-22T13:00:00Z", positions: [{ symbol: FX.POS.V2.occAtm }, { symbol: FX.POS.V2.occK2 }] };
      fs.writeFileSync(path.join(t.dd, "alpaca-options-positions.json"), JSON.stringify(stillThere, null, 1));
      const r2 = note(T.runTree(t));
      ok("C12 a flag is LIFTED when the run no longer finds the position unknown (here the next snapshot reports its legs again): the board keeps the position and loses vanishedUnknown, and the run exits 0",
        !!r1.data["board_positions.json"][0].vanishedUnknown && r1.status === 2 && !r2.data["board_positions.json"][0].vanishedUnknown && r2.status === 0 && r2.data["trade_log.json"].length === 0,
        { r1: r1.data["board_positions.json"][0].vanishedUnknown, r2: r2.data["board_positions.json"][0], s2: r2.status });
      // and once the close is stored it settles by itself
      fs.writeFileSync(path.join(t.dd, "alpaca-options-positions.json"), JSON.stringify(FX.SNAPSHOT, null, 1));
      fs.writeFileSync(path.join(t.dd, "underlying-closes.json"), JSON.stringify({ ...FX.CLOSES, NVDA: { [FX.EXP]: 905 } }, null, 1));
      const r3 = note(T.runTree(t));
      const row = r3.data["trade_log.json"][0];
      ok("C13 ... and once the missing close is stored, the same position settles by itself on the next run: NVDA 900/910 at 905 is worth 5, (5 - 4) x 100 - 1.30 = $98.70, off the board, no flag left anywhere",
        r3.data["trade_log.json"].length === 1 && row.pnl === 98.7 && row.obs.settleUnder === 905 && row.reason === "expiry-vanished" && r3.data["board_positions.json"].length === 0 && r3.status === 0, { row, status: r3.status });
    } finally { t.done(); }
  }
  { const s = note(run1(STAGED, FX.data(["V3"], { mirror: false }))), row = s.data["trade_log.json"][0];
    ok("C2b THE WIDTH CAP BINDS — AMD 100/105 with the underlying at 200 is worth the WIDTH, 5, not the 100 the raw breach would be: (5 - 2) x 100 - 1.30 = $298.70",
      s.data["trade_log.json"].length === 1 && row.exit === 5 && row.pnl === 298.7 && row.obs.width === 5, { row });
  }
  { const s = note(run1(STAGED, FX.data(["V1", "V2"], { mirror: false })));
    const flagged = s.data["board_positions.json"].find((p) => p.id === "v2-nvda");
    ok("C4b one vanished spread settles while another cannot be priced: the ledger gains ONLY the priced one, the other stays on the board flagged, and the run still exits 2 (a settle elsewhere never hides an unknown)",
      s.data["trade_log.json"].length === 1 && s.data["trade_log.json"][0].id === "v1-msft" && !!flagged && !!flagged.vanishedUnknown && s.status === 2 && /could NOT be priced/.test(s.out),
      { log: s.data["trade_log.json"].map((t) => t.id), board: s.data["board_positions.json"].map((p) => p.id), status: s.status });
  }
  { const s = note(run1(STAGED, FX.data(["V1", "S1"], { mirror: false })));
    const left = s.data["board_positions.json"];
    ok("C5b THE SNAPSHOT IS THE TRIGGER, PER POSITION — in a run the pass does take, the spread whose legs the snapshot STILL reports is not settled and not flagged, while the vanished one beside it is",
      s.data["trade_log.json"].length === 1 && s.data["trade_log.json"][0].id === "v1-msft" && left.length === 1 && left[0].id === "s1-tsla" && !left[0].vanishedUnknown && s.status === 0,
      { log: s.data["trade_log.json"].map((t) => t.id), board: left, status: s.status });
  }
  { const s = note(run1(STAGED, FX.data(["V1", "X1"], { mirror: false })));
    const left = s.data["board_positions.json"];
    ok("C9b ... and in a run the pass does take, the expired option with no OCC legs is still left alone and unflagged (it is outside the rule, not an unknown inside it)",
      s.data["trade_log.json"].length === 1 && left.length === 1 && left[0].id === "x1-amzn" && !left[0].vanishedUnknown && s.status === 0, { board: left, status: s.status });
  }
  { const prior = [{ id: "v1-msft", sym: "MSFT", cls: "Options", pnl: 1, rMult: 0.1, closedAt: 1, reason: "expiry" }];
    const s = note(run1(STAGED, FX.data(["V1", "V2"], { mirror: false, tradeLog: prior })));
    ok("C11b ... and in a run the pass does take (V2 drives it), a spread the ledger already holds is still never settled twice: the ledger keeps only the row it had and V1 stays on the board",
      J(s.data["trade_log.json"]) === J(prior) && s.data["board_positions.json"].some((p) => p.id === "v1-msft") && s.status === 2,
      { log: s.data["trade_log.json"], board: s.data["board_positions.json"].map((p) => p.id) });
  }
  { const t = T.makeTree({ scriptText: STAGED, data: FX.data(["W1"], { snapshot: null, closes: null }), bars: FX.BARS });
    try {
      const r1 = note(T.runTree(t)), m1 = r1.data["options-mirror-expired.json"];
      const r2 = note(T.runTree(t)), m2 = r2.data["options-mirror-expired.json"];
      const mirrorNow = fs.readFileSync(path.join(t.dd, "alpaca-options-mirror.jsonl"), "utf8");
      ok("C14 THE MIRROR'S OWN ORDERS — the two option orders still shown as \"sent\" past their expiry are marked expired (one naming its legs as occAtm/occK2, one as a legs[] list); the 2099 \"sent\" row and the filled row are not; the unparsable line is counted, not dropped in silence; the mirror's log is not rewritten",
        !!m1 && m1.marked.length === 2 && m1.unparsableLogLines === 1 && J(m1.marked.map((x) => x.ticketId).sort()) === J(["v1-msft", "v2-nvda"])
        && m1.marked.every((x) => x.was === "sent" && x.status === "expired" && x.optExpiry === FX.EXP && x.legs.length === 2)
        && mirrorNow === FX.MIRROR_LINES.join("\n") + "\n" && /2 newly marked expired/.test(r1.out),
        { m1, out: r1.out.slice(0, 600) });
      ok("C15 ... and the record is idempotent: the second run marks nothing new and every mark keeps the date it was first made",
        !!m2 && m2.marked.length === 2 && J(m2.marked.map((x) => x.markedAt)) === J(m1.marked.map((x) => x.markedAt)) && /0 newly marked expired/.test(r2.out), { m2, out: r2.out.slice(0, 400) });
    } finally { t.done(); }
  }
  { const s = note(run1(STAGED, { "board_positions.json": [], "trade_log.json": [], "board_tombstones.json": [] }));
    ok("C16 an empty board: the run says there is nothing past expiry, exits 0, asks for no bar and writes no ledger row — and it still says the mirror log is absent rather than assuming anything about it",
      s.status === 0 && /no wings past expiry/.test(s.out) && /options mirror log absent/.test(s.out) && s.barCalls.length === 0 && J(s.data["trade_log.json"]) === J([]), { out: s.out, calls: s.barCalls });
  }
  { const s = note(run1(STAGED, FX.data(["V1"], { mirror: false })));
    ok("C17 a vanished-only night asks for NO BAR at all: with no wing and no verified debit vertical due, the settle makes no call to the bars library (the price came from the stored close)", s.barCalls.length === 0 && s.data["trade_log.json"].length === 1, { calls: s.barCalls });
  }
  ok(`C19 NO NETWORK — across all ${netOf.length} runs above, every fetch / http / https / net / dns attempt was refused and recorded, and the count of attempts is ZERO`, netOf.length >= 18 && netOf.every((n) => n === 0), { runs: netOf.length, attempts: netOf });

  // ── D. deploy and rollback on scratch repos ────────────────────────────────────────────────────────────────────────────────
  section("D. deploy and rollback on scratch repos");
  const at = (iso) => () => Date.parse(iso);
  const SAT = "2026-10-17T16:00:00Z" /* Sat 10:00 MT */, THU10 = "2026-10-15T16:00:00Z" /* Thu 10:00 MT */, THU1630 = "2026-10-15T22:30:00Z" /* Thu 16:30 MT */;
  const finishedToday = { started: "2026-10-15T20:15:00Z", finished: "2026-10-15T21:30:00Z" }, yesterday = { started: "2026-10-14T20:15:52Z", finished: "2026-10-14T21:33:27Z" };
  function scratchRepo(bytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ovs-repo-"));
    fs.mkdirSync(path.join(dir, "backend", "data"), { recursive: true }); fs.mkdirSync(path.join(dir, "backend", "lib"), { recursive: true });
    fs.writeFileSync(path.join(dir, "backend", "options-settle.js"), bytes);
    fs.copyFileSync(path.join(REPO, "backend", "lib", "atomic-write.js"), path.join(dir, "backend", "lib", "atomic-write.js"));
    return dir;
  }
  const liveOf = (dir) => fs.readFileSync(path.join(dir, "backend", "options-settle.js"));
  const okGate = { what: "fake gate", n: 0, run() { this.n++; return { ok: true, line: "ALL 1 CHECKS PASSED" }; } }, redGate = { what: "fake red gate", run: () => ({ ok: false, why: "1 OF 2 CHECKS FAILED" }) };
  const deps = (dir, more = {}) => ({ repo: dir, pkg: PKG, now: at(SAT), listProcs: () => [], chainStatus: () => yesterday, holidays: D.HOLIDAYS, log: () => {}, ...more });
  { const dir = scratchRepo(Buffer.from(BASE));
    try {
      ok("D1 a scratch repo holding the base bytes plans as 'base'", D.plan({ repo: dir }).files[0].state === "base", D.plan({ repo: dir }).files[0]);
      const a = D.make(deps(dir)).writeUnit({ to: "staged", gate: okGate });
      ok("D2 --apply (fences clear, gate green): the staged bytes written, read back by sha256 and node --check'd, the gate run once", a.result === "done" && a.written.length === 1 && sha(liveOf(dir)) === F0.stagedSha && okGate.n === 1, a);
      const a2 = D.make(deps(dir)).writeUnit({ to: "staged", gate: okGate });
      ok("D3 --apply again: nothing to write (applied), and the gate is not run again", a2.result === "done" && a2.written.length === 0 && okGate.n === 1, a2);
      const rb = RB.rollback(deps(dir));
      ok("D4 rollback: the base bytes back, BYTE-EXACT (Buffer equal to base/backend/options-settle.js)", rb.result === "done" && rb.written.length === 1 && liveOf(dir).equals(fs.readFileSync(path.join(PKG, "base", "backend", "options-settle.js"))), rb);
      const red = D.make(deps(dir)).writeUnit({ to: "staged", gate: redGate });
      ok("D5 a red selftest gate refuses the apply and nothing is written", red.result === "refused" && sha(liveOf(dir)) === F0.baseSha, red.why);
      fs.writeFileSync(path.join(dir, "backend", "options-settle.js"), BASE + "// someone's edit\n");
      const before = liveOf(dir), dr = D.make(deps(dir)).writeUnit({ to: "staged", gate: okGate }), dr2 = RB.rollback(deps(dir));
      ok("D6 DRIFT (the file is neither the base nor the staged bytes): the apply AND the rollback refuse by name and the file is left exactly as it is", dr.result === "refused" && /DRIFT/.test(dr.why.join(" ")) && dr2.result === "refused" && liveOf(dir).equals(before), { dr: dr.why, dr2: dr2.why });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  { const H = D.HOLIDAYS;
    ok("D7 the clock fence: Thu 10:00 MT refused; 05:29 MT, 16:00 MT, a Saturday and Thanksgiving are clear",
      !!D.clockFence(Date.parse(THU10), H) && !D.clockFence(Date.parse("2026-10-15T11:29:00Z"), H) && !D.clockFence(Date.parse("2026-10-15T22:00:00Z"), H) && !D.clockFence(Date.parse(SAT), H) && !D.clockFence(Date.parse("2026-11-26T17:00:00Z"), H));
    ok("D8 the chain fence: Thu 16:30 MT with yesterday's chain-status (due) or today's with no finished stamp (running) refuses; today's finished run, a Saturday and 10:00 ET are clear; no status file at all refuses",
      !!D.chainFence(Date.parse(THU1630), yesterday, H) && !!D.chainFence(Date.parse(THU1630), { started: finishedToday.started }, H) && !D.chainFence(Date.parse(THU1630), finishedToday, H)
      && !D.chainFence(Date.parse(SAT), yesterday, H) && !D.chainFence(Date.parse("2026-10-15T14:00:00Z"), yesterday, H) && !!D.chainFence(Date.parse(THU1630), null, H));
    const W = (s) => s.replace(/\//g, "\\");
    const chainAbs = [{ pid: 11, cmd: `"node.exe" "${W(path.join(REPO, "automation", "close-chain.cjs"))}"` }], chainRel = [{ pid: 12, cmd: "node  automation\\close-chain.cjs" }];
    const settleAbs = [{ pid: 13, cmd: `"node.exe" "${W(path.join(REPO, "backend", "options-settle.js"))}"` }];
    const harmless = [{ pid: 14, cmd: `node "${W(path.join(os.tmpdir(), "ovs-tree-abc", "backend", "options-settle.js"))}"` }, { pid: 15, cmd: "node docs/options-vanished-settles/2026-10-16/deploy.cjs --apply" }, { pid: 16, cmd: "node backend/traids-server-v2.js" }];
    ok("D9 the process fence: the close chain (absolute or `node automation\\close-chain.cjs`) and backend/options-settle.js refuse; a scratch tree's copy, this package's own scripts and other node processes do not; a list that cannot be read refuses (fail-closed)",
      D.procFence(() => chainAbs, REPO).length === 1 && D.procFence(() => chainRel, REPO).length === 1 && /options-settle\.js is running/.test(D.procFence(() => settleAbs, REPO).join(" "))
      && D.procFence(() => harmless, REPO).length === 0 && /could not be read/.test(D.procFence(() => { throw new Error("access denied"); }, REPO).join(" ")));
    const dir = scratchRepo(Buffer.from(BASE));
    try {
      const here = [{ pid: 17, cmd: `"node.exe" "${W(path.join(dir, "backend", "options-settle.js"))}"` }];
      const cases = [["a trading-day clock", { now: at(THU10) }], ["the chain due", { now: at(THU1630) }], ["the chain running", { listProcs: () => chainRel }], ["the settle running", { listProcs: () => here }], ["no process list", { listProcs: () => { throw new Error("denied"); } }]];
      const res = cases.map(([n, m]) => [n, D.make(deps(dir, m)).writeUnit({ to: "staged", gate: okGate }).result]);
      ok("D10 the apply is refused under each of the five fences and writes nothing", res.every(([, r]) => r === "refused") && sha(liveOf(dir)) === F0.baseSha, res);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    let procs = null, why = null; try { procs = D.listNodeProcs(); } catch (e) { why = e.message; }
    ok("D11 the real process list can be read here (read-only) and holds this selftest's own node process", Array.isArray(procs) && procs.some((p) => p.pid === process.pid), why || (procs || []).length);
  }

  // ── E. record.cjs ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("E. record.cjs");
  { const dd = path.join(REPO, "backend", "data"), shaF = (f) => { try { return sha(fs.readFileSync(path.join(dd, f))); } catch { return null; } };
    const b0 = [shaF("change-registry.json"), shaF("agent-ledger.jsonl")], lock0 = fs.existsSync(path.join(dd, "registry-write.lock"));
    const r = REC.run({ dry: true, log: () => {} }), b1 = [shaF("change-registry.json"), shaF("agent-ledger.jsonl")], lock1 = fs.existsSync(path.join(dd, "registry-write.lock"));
    const readable = r.code === 0, cannotRead = r.code === 2 && /cannot be read/.test(r.lines.join(" "));   // this clean copy carries no change-registry.json; at home it does
    ok("E1 --dry against the REAL data folder: nothing written (both files' sha256 unchanged, absent stays absent), no lock taken, and it either prints the two records (exit 0) or refuses because the registry files are not in this copy", (readable || cannotRead) && r.result !== "written" && b0.join() === b1.join() && (lock0 || !lock1), { result: r.result, code: r.code, last: r.lines.slice(-1) });
  }
  function scratchData() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ovs-data-")); fs.writeFileSync(path.join(dir, "change-registry.json"), JSON.stringify([{ id: "earlier-row" }], null, 1)); fs.writeFileSync(path.join(dir, "agent-ledger.jsonl"), JSON.stringify({ at: "x", kind: "NOTE" }) + "\n"); return dir; }
  { const repoA = scratchRepo(Buffer.from(STAGED)), repoB = scratchRepo(Buffer.from(BASE)), dd = scratchData(), q = { log: () => {}, holidays: D.HOLIDAYS, pkg: PKG, lockWaitMs: 0, sleep: () => {} };
    try {
      const w = REC.run({ ...q, dataDir: dd, repo: repoA, now: at(SAT) });
      const cr = JSON.parse(fs.readFileSync(path.join(dd, "change-registry.json"), "utf8")), led = fs.readFileSync(path.join(dd, "agent-ledger.jsonl"), "utf8").trim().split("\n");
      ok("E2 the write (home applied, a Saturday): ONE change-registry row (options-vanished-settles-2026-10-16, breaksComparability TRUE because a new rule settles rows nothing settled before, with the code before/after) and ONE GOVERNANCE line; the lock removed",
        w.code === 0 && w.result === "written" && cr.length === 2 && cr[1].id === REC.CR_ID && cr[1].breaksComparability === true
        && cr[1].files["backend/options-settle.js"].before === F0.baseSha && cr[1].files["backend/options-settle.js"].after === F0.stagedSha
        && led.length === 2 && JSON.parse(led[1]).kind === "GOVERNANCE" && JSON.parse(led[1]).changeRegistry === REC.CR_ID && !fs.existsSync(path.join(dd, "registry-write.lock")), { w: w.result, cr: cr.length, led: led.length });
      const again = REC.run({ ...q, dataDir: dd, repo: repoA, now: at(SAT) });
      ok("E3 a second run: ALREADY RECORDED, exit 0, nothing more written", again.code === 0 && again.result === "already" && JSON.parse(fs.readFileSync(path.join(dd, "change-registry.json"), "utf8")).length === 2);
      const dd2 = scratchData(), s0 = sha(fs.readFileSync(path.join(dd2, "change-registry.json")));
      const win = REC.run({ ...q, dataDir: dd2, repo: repoA, now: at("2026-10-15T20:00:00Z") /* Thu 14:00 MT */ }), notApplied = REC.run({ ...q, dataDir: dd2, repo: repoB, now: at(SAT) });
      ok("E4 refused inside 13:50-15:50 MT on a trading day, and refused while home's file is not the staged one; nothing written either time",
        win.code === 2 && notApplied.code === 2 && /no-write window/.test(win.lines.join(" ")) && /not the staged one/.test(notApplied.lines.join(" ")) && sha(fs.readFileSync(path.join(dd2, "change-registry.json"))) === s0);
      const lockF = path.join(dd2, "registry-write.lock"); fs.writeFileSync(lockF, JSON.stringify({ token: "another-writer" }) + "\n");
      const held = REC.run({ ...q, dataDir: dd2, repo: repoA, now: at(SAT) });
      ok("E5 another writer's lock: refused, nothing written, and that lock is left in place untouched", held.code === 2 && /held by another writer/.test(held.lines.join(" ")) && fs.readFileSync(lockF, "utf8").includes("another-writer") && sha(fs.readFileSync(path.join(dd2, "change-registry.json"))) === s0, held.lines.slice(-1));
      fs.rmSync(dd2, { recursive: true, force: true });
    } finally { for (const d of [repoA, repoB, dd]) fs.rmSync(d, { recursive: true, force: true }); }
  }

  // ── F. mutation-proof ──────────────────────────────────────────────────────────────────────────────────────────────────────
  section("F. mutation-proof: each mutant of the staged file must be caught by the check written for it");
  const ids = (list) => list.filter((x) => !x[1]).map((x) => String(x[0]).split(" ")[0]);
  /** the C checks that a mutant must be run through, as [name, bool, detail] */
  function viaRuns(text) {
    const out = [];
    { const d = () => FX.data(["W1"], { snapshot: null, closes: null, mirror: false }), b = run1(BASE, d()), s = run1(text, d());
      out.push(["C1", J(written(s.data)) === J(written(b.data)) && s.status === b.status]); }
    { const s = run1(text, FX.data(["W1", "V1"], { mirror: false })), row = s.data["trade_log.json"].find((t) => t.id === "v1-msft");
      out.push(["C2", !!row && row.pnl === 298.7 && row.exit === 6 && row.reason === "expiry-vanished" && row.obs.settleTag === "vanished-legs-2026-10-16" && row.obs.settleUnder === 506 && s.data["board_positions.json"].length === 0]); }
    { const s = run1(text, FX.data(["V2"], { mirror: false })), p = s.data["board_positions.json"][0];
      out.push(["C4", s.data["trade_log.json"].length === 0 && !!p && !!p.vanishedUnknown && s.status === 2]); }
    { const d = FX.data(["S1"], { mirror: false }), b = run1(BASE, d), s = run1(text, d);
      out.push(["C5", J(written(s.data)) === J(written(b.data)) && s.status === 0]); }
    { const d = FX.data(["S1"], { snapshot: { asOf: "2026-09-18T23:30:00Z", positions: [] }, mirror: false }), b = run1(BASE, d), s = run1(text, d);
      out.push(["C8", J(written(s.data)) === J(written(b.data)) && s.status === 0]); }
    { const prior = [{ id: "v1-msft", sym: "MSFT", cls: "Options", pnl: 1, rMult: 0.1, closedAt: 1, reason: "expiry" }], s = run1(text, FX.data(["V1"], { mirror: false, tradeLog: prior }));
      out.push(["C11", J(s.data["trade_log.json"]) === J(prior) && s.data["board_positions.json"].length === 1]); }
    { const s = run1(text, FX.data(["W1"], { snapshot: null, closes: null })), m = s.data["options-mirror-expired.json"];
      out.push(["C14", !!m && m.marked.length === 2 && m.unparsableLogLines === 1 && J(m.marked.map((x) => x.ticketId).sort()) === J(["v1-msft", "v2-nvda"])]); }
    { const s = run1(text, FX.data(["V3"], { mirror: false })), row = s.data["trade_log.json"][0];
      out.push(["C2b", !!row && row.exit === 5 && row.pnl === 298.7]); }
    { const s = run1(text, FX.data(["V1", "V2"], { mirror: false }));
      out.push(["C4b", s.data["trade_log.json"].length === 1 && s.data["trade_log.json"][0].id === "v1-msft" && s.status === 2]); }
    { const s = run1(text, FX.data(["V1", "S1"], { mirror: false })), left = s.data["board_positions.json"];
      out.push(["C5b", s.data["trade_log.json"].length === 1 && s.data["trade_log.json"][0].id === "v1-msft" && left.length === 1 && left[0].id === "s1-tsla" && !left[0].vanishedUnknown && s.status === 0]); }
    { const s = run1(text, FX.data(["V1", "X1"], { mirror: false })), left = s.data["board_positions.json"];
      out.push(["C9b", s.data["trade_log.json"].length === 1 && left.length === 1 && left[0].id === "x1-amzn" && !left[0].vanishedUnknown && s.status === 0]); }
    { const prior = [{ id: "v1-msft", sym: "MSFT", cls: "Options", pnl: 1, rMult: 0.1, closedAt: 1, reason: "expiry" }];
      const s = run1(text, FX.data(["V1", "V2"], { mirror: false, tradeLog: prior }));
      out.push(["C11b", J(s.data["trade_log.json"]) === J(prior) && s.data["board_positions.json"].some((p) => p.id === "v1-msft")]); }
    return out;
  }
  const MUT = [
    ["F1 settle a vanished spread without asking the snapshot at all (the broker's silence no longer required)", ["    if (!V.ok) { vanLeft.push(`${p.sym} ${p.optExpiry} (${V.why})`); continue; }", "    if (false) { vanLeft.push(`${p.sym} ${p.optExpiry} (${V.why})`); continue; }"], "C5b"],
    ["F2 accept a snapshot that is not dated after the expiry", ["  if (!(d > expiry)) return { ok: false, why:", "  if (false) return { ok: false, why:"], "C8"],
    ["F3 guess the price when no stored close exists (fall back to the entry)", ["    if (C.c == null) { vanUnknown.push({ p, why: `${seen}, but no stored close of ${p.sym} on ${p.optExpiry} exists — the settle price is not guessed` }); continue; }", "    if (C.c == null) { C.c = p.optAtm; C.src = \"guessed\"; }"], "C4"],
    ["F4 drop the UNKNOWN flag (the board is left with no mark)", ["      if (u) { const since = b.vanishedUnknown && b.vanishedUnknown.since ? b.vanishedUnknown.since : nowIso;", "      if (false) { const since = b.vanishedUnknown && b.vanishedUnknown.since ? b.vanishedUnknown.since : nowIso;"], "C4"],
    ["F5 exit 0 on a night with a spread that could not be priced", ["if (vanUnknown.length) { console.error(`OPTIONS SETTLE — ${vanUnknown.length} expired spread(s) the broker no longer reports could NOT be priced", "if (false) { console.error(`OPTIONS SETTLE — ${vanUnknown.length} expired spread(s) the broker no longer reports could NOT be priced"], "C4b"],
    ["F6 settle a spread that is already in the ledger (the idempotence rule dropped)", ["    if (settledBefore(p) || settled.some((s) => s.id === p.id)) continue;", "    if (settled.some((s) => s.id === p.id)) continue;"], "C11b"],
    ["F7 price the intrinsic without the width cap", ["const verticalIntrinsic = (call, anchorK, otherK, S) => Math.min(Math.max(call ? S - anchorK : anchorK - S, 0), Math.abs(otherK - anchorK));", "const verticalIntrinsic = (call, anchorK, otherK, S) => Math.max(call ? S - anchorK : anchorK - S, 0);"], "C2b"],
    ["F8 charge the exit commissions the expiry does not cost", ["  const commissions = COMMISSION_PER_LEG * LEGS_AT_ENTRY * contracts;   // two legs in; the expiry itself is commission-free, exactly as the wings", "  const commissions = COMMISSION_PER_LEG * 4 * contracts;   // two legs in; the expiry itself is commission-free, exactly as the wings"], "C2"],
    ["F9 mark every mirror row expired, not only the ones still \"sent\"", ["    if (!r || typeof r !== \"object\" || String(r.status) !== \"sent\") continue;", "    if (!r || typeof r !== \"object\") continue;"], "C14"],
    ["F10 mark a \"sent\" row whose expiry has not passed", ["    const exp = rowExpiry(r); if (!exp || !isPast(exp)) continue;", "    const exp = rowExpiry(r); if (!exp) continue;"], "C14"],
    ["F11 let the new pass touch a wings-only night (the vanished rule applied to every expired row)", ["    if (!L.legs) { vanLeft.push(`${p.sym} ${p.optExpiry} (${L.why})`); continue; }", "    if (!L.legs) { vanUnknown.push({ p, why: L.why }); continue; }"], "C9b"],
  ];
  for (const [name, [from, to], want] of MUT) {
    let got = null, why = "";
    try {
      const text = mutate(STAGED, from, to);
      got = ids(viaRuns(text));
    } catch (e) { why = e.message; }
    ok(`${name}: caught by ${want}${got ? ` (failing: ${got.join(", ") || "none"})` : ""}`, !!got && got.includes(want), why || `the checks that failed: ${got ? got.join(", ") || "none" : "-"}`);
  }

  console.log(failN ? `\n${failN} OF ${pass + failN} CHECKS FAILED: ${failed.join(" | ")}` : `\nALL ${pass} CHECKS PASSED`);
  process.exitCode = failN ? 1 : 0;
})().catch((e) => { console.log(`  FAIL the selftest crashed — ${e && e.stack ? e.stack : e}`); console.log(`\n${failN + 1} OF ${pass + failN + 1} CHECKS FAILED (crash)`); process.exitCode = 1; });
