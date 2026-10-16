#!/usr/bin/env node
/**
 * SELFTEST — proven-book-composer, OFFLINE: fixtures only (the sizes below are FIXTURE values, plainly not R353's). 2026-10-16.
 *   node docs/proven-book-composer/2026-10-16/selftest.cjs
 * The last line says "ALL ... PASSED" only when every case passed.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const H = __dirname, REPO = path.resolve(H, "..", "..", ".."), SRC = path.join(H, "staged", "backend", "proven-book", "book-composer.cjs");
const K = require(SRC);
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail ? " — " + String(detail).slice(0, 500) : "")); } };
const quiet = (s) => String(s).replace(/ALL/g, "all");
const section = (title, fn) => { console.log(title); try { fn(); } catch (e) { ok(`${title}: the section ran to its end`, false, `threw: ${String(e.stack || e).split("\n").slice(0, 3).join(" ")}`); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "composer-selftest-"));

// FIXTURE config and book (not R353's values)
const CFG = (o = {}) => ({ schema: "proven-book-composer-v1", capitalUsd: 100000, exposureCap: 1, reserveUsd: 0, entryPriority: ["R313", "R328"],
  sleeves: { R313: { slotUsd: 5000 }, R328: { slotUsd: 5000 }, R180: { sym: "IEF", targetUsd: 50000 } }, ...o });
const PX = { IEF: 100, SPY: 500, IWM: 200, XLK: 250, XLF: 50, XLE: 80, EWJ: 70, EWG: 30, EFA: 80, EEM: 40, DIA: 400, MDY: 550, XLV: 140, XLY: 190, XLP: 80, XLI: 130, XLU: 70, XLB: 90, EWU: 35, EWC: 40, EWA: 25, BIL: 91.5 };
const NIGHT = (o = {}) => ({ schema: "proven-book-nightly-v1", asOf: "2026-10-15", cash: 100000, positions: [], prices: PX, intents: { R313: { exits: [], entries: [] }, R328: { exits: [], entries: [] }, R180: { want: false } }, ...o });
const buys = (p, s) => p.orders.filter((o) => o.side === "buy" && (!s || o.sleeve === s));
const sells = (p, s) => p.orders.filter((o) => o.side === "sell" && (!s || o.sleeve === s));

section("R180's window (registered rule N3: entry at the close of session -6, exit at the close of session -1)", () => {
  const oct = []; for (let d = 1; d <= 31; d++) { const t = `2026-10-${String(d).padStart(2, "0")}`, g = new Date(t + "T12:00:00Z").getUTCDay(); if (g && g !== 6) oct.push(t); }
  const want = oct.map((d) => K.r180Want(d, oct)), n = oct.length;
  ok(`October 2026 (${n} sessions): held after the closes of sessions -6..-2 only (${oct[n - 6]} .. ${oct[n - 2]}); flat after the last session's close and before -6`, want.filter(Boolean).length === 5 && want[n - 6] && want[n - 2] && !want[n - 1] && !want[n - 7] && !want[0], JSON.stringify(oct.filter((_, i) => want[i])));
  let e = null; try { K.r180Want("2026-10-17", oct); } catch (x) { e = x.message; } ok("a date that is not a session of the month: REFUSED", /not a session/.test(e || ""));
  const p = K.compose(NIGHT({ asOf: oct[n - 6], intents: { R313: { exits: [], entries: [] }, R328: { exits: [], entries: [] }, R180: { monthSessions: oct } } }), CFG());
  ok("compose with monthSessions on session -6: buys IEF to the target (500 shares at 100)", buys(p, "R180").length === 1 && buys(p, "R180")[0].qty === 500 && p.r180.want === true);
});

section("known answers", () => {
  const p = K.compose(NIGHT({ intents: { R313: { exits: [], entries: [] }, R328: { exits: [], entries: [] }, R180: { want: true } } }), CFG());
  ok("empty book, R180 wanted: 500 IEF ($50,000); the other $50,000 is OFFERED to the stacker", buys(p).length === 1 && buys(p)[0].qty === 500 && p.after.grossUsd === 50000 && p.offer.usd === 50000 && p.offer.toLayer === "stacker", JSON.stringify(p.offer));
  const q = K.compose(NIGHT({ intents: { R313: { exits: [], entries: [{ sym: "XLF", rank: 2 }, { sym: "SPY", rank: 1 }] }, R328: { exits: [], entries: [{ sym: "EWG" }] }, R180: { want: true } } }), CFG());
  ok("dip entries at FULL size in priority order (R313 by rank, then R328): SPY 10 sh ($5,000), XLF 100 sh, EWG 166 sh ($4,980: whole shares); R180 to target; offer = the rest", JSON.stringify(buys(q).map((o) => [o.sleeve, o.sym, o.qty])) === JSON.stringify([["R313", "SPY", 10], ["R313", "XLF", 100], ["R328", "EWG", 166], ["R180", "IEF", 500]]) && q.offer.usd === 100000 - 5000 - 5000 - 4980 - 50000, JSON.stringify(q.orders.map((o) => [o.sleeve, o.sym, o.qty])) + " offer " + q.offer.usd);
  const r = K.compose(NIGHT({ cash: 75000, positions: [{ sleeve: "R313", sym: "XLF", qty: 100 }, { sleeve: "R180", sym: "IEF", qty: 200 }], intents: { R313: { exits: ["XLF"], entries: [] }, R328: { exits: ["SPY"], entries: [] }, R180: { want: false } } }), CFG());
  ok("exits: R313's XLF is sold (its rule's exit); R328's 'SPY' is not held by R328 — ignored with a note; R180's window closed: IEF sold", JSON.stringify(sells(r).map((o) => [o.sleeve, o.sym, o.qty])) === JSON.stringify([["R313", "XLF", 100], ["R180", "IEF", 200]]) && r.notes.some((n) => /R328 exit SPY: not held/.test(n)));
  ok("with countExitProceeds false (default) tonight's $25,000 of sale proceeds are NOT offered (unsettled): offer = cash $75,000", r.offer.usd === 75000 && r.after.unsettledProceedsUsd === 25000, JSON.stringify(r.after));
  const r2 = K.compose(NIGHT({ cash: 75000, positions: [{ sleeve: "R313", sym: "XLF", qty: 100 }, { sleeve: "R180", sym: "IEF", qty: 200 }], intents: { R313: { exits: ["XLF"], entries: [] }, R328: { exits: [], entries: [] }, R180: { want: false } } }), CFG({ countExitProceeds: true }));
  ok("with countExitProceeds true the proceeds count: offer $100,000", r2.offer.usd === 100000);
  const sk = K.compose(NIGHT({ prices: { ...PX, BRK: 700000 }, intents: { R313: { exits: [], entries: [{ sym: "BRK" }, { sym: "NOPX" }, { sym: "SPY" }] }, R328: { exits: [], entries: [] }, R180: { want: false } } }), CFG());
  ok("one share dearer than the slot, or no price: SKIPPED with the reason; the next entry still goes", sk.skipped.map((x) => x.sym).join() === "BRK,NOPX" && buys(sk).map((o) => o.sym).join() === "SPY");
  const dup = K.compose(NIGHT({ positions: [{ sleeve: "R313", sym: "SPY", qty: 10 }], cash: 95000, intents: { R313: { exits: [], entries: [{ sym: "SPY" }] }, R328: { exits: [], entries: [{ sym: "SPY" }] }, R180: { want: false } } }), CFG());
  ok("one position per name per sleeve: R313's SPY entry while R313 holds SPY is skipped; R328 may hold its own SPY", dup.skipped.some((x) => x.sleeve === "R313" && x.sym === "SPY") && buys(dup, "R328").length === 1);
});

const twelve = ["SPY", "IWM", "XLK", "XLF", "XLE", "EWJ", "EWG", "EFA", "EEM", "DIA", "MDY", "XLV"];
section("the cap, no margin, dips at full size, R180 and the Stacker yield", () => {
  // IEF held at $50,000, cash $50,000, twelve $5,000 dip entries = $60,000
  const base = { cash: 50000, positions: [{ sleeve: "R180", sym: "IEF", qty: 500 }], intents: { R313: { exits: [], entries: twelve.map((sym, i) => ({ sym, rank: i })) }, R328: { exits: [], entries: [] }, R180: { want: true } } };
  const a = K.compose(NIGHT(base), CFG());
  ok("cash account (countExitProceeds false): only $50,000 of cash -> the first 10 entries at full size, the last 2 SKIPPED (never shrunk); IEF untouched (selling it cannot pay tonight)", buys(a, "R313").length === 10 && a.skipped.length === 2 && a.skipped.every((x) => /never shrunk/.test(x.why)) && !sells(a).length && a.after.cashUsd >= 0 && a.after.grossUsd <= a.capUsd, JSON.stringify([buys(a).length, a.skipped, a.after]));
  const b = K.compose(NIGHT(base), CFG({ countExitProceeds: true }));
  ok("proceeds count (countExitProceeds true): R180 YIELDS — IEF trimmed by whole shares to fund all 12 at full size; gross <= cap", buys(b, "R313").length === 12 && sells(b, "R180").length >= 1 && sells(b, "R180").every((o) => /yields to a dip-buy/.test(o.why)) && b.after.grossUsd <= b.capUsd + 1e-6 && b.after.cashUsd >= -1e-6, JSON.stringify([sells(b), b.after]));
  ok("... and R180 then holds what is left in whole shares: $100,000 - the dips' $59,520 -> 404 IEF ($40,400), noted below target", b.after.bySleeve.R313 === 59520 && b.after.bySleeve.R180 === 40400 && b.notes.some((n) => /R180 below its target/.test(n)), JSON.stringify(b.after.bySleeve));
  const c = K.compose(NIGHT({ ...base, positions: [{ sleeve: "R180", sym: "IEF", qty: 300 }, { sleeve: "stacker", sym: "BIL", qty: 200 }] }), CFG({ countExitProceeds: true }));
  ok("the STACKER yields before R180: BIL ($18,300) is sold first, then IEF only for what is still short", sells(c)[0].sleeve === "stacker" && buys(c, "R313").length === 12 && c.after.grossUsd <= c.capUsd + 1e-6, JSON.stringify(sells(c).map((o) => [o.sleeve, o.sym, o.qty])));
  const d = K.compose(NIGHT(base), CFG({ countExitProceeds: true, r180YieldsToDips: false }));
  ok("r180YieldsToDips false: IEF is never sold for a dip; the entries that do not fit are skipped", !sells(d).length && buys(d, "R313").length === 10 && d.skipped.length === 2);
  const e = K.compose(NIGHT({ cash: 100000, intents: { R313: { exits: [], entries: twelve.map((sym) => ({ sym })) }, R328: { exits: [], entries: [] }, R180: { want: true } } }), CFG({ exposureCap: 0.5 }));
  ok("exposureCap 0.5 on $100,000: gross after <= $50,000 — 10 dips at full size ($49,620), 2 skipped, R180 only the scrap left (3 shares), offer the $80 under the cap", e.after.grossUsd <= 50000 && buys(e, "R313").length === 10 && e.skipped.length === 2 && e.after.bySleeve.R180 === 300 && e.offer.usd === 80, JSON.stringify(e.after.bySleeve) + " " + e.offer.usd);
  const oc = K.compose(NIGHT({ cash: 10000, positions: [{ sleeve: "R313", sym: "SPY", qty: 100 }, { sleeve: "R180", sym: "IEF", qty: 200 }, { sleeve: "stacker", sym: "BIL", qty: 100 }], intents: { R313: { exits: [], entries: [{ sym: "XLF" }] }, R328: { exits: [], entries: [] }, R180: { want: true } } }), CFG({ exposureCap: 0.8 }));
  ok("OVER THE CAP before any buy (held SPY $50,000 + IEF $20,000 + BIL $9,150 on equity $89,150, cap $71,320): the Stacker is cut first, then R180, back to the cap; held SPY is never cut; then the XLF dip still goes at full size with R180 yielding, gross <= cap", sells(oc)[0].sleeve === "stacker" && /over the exposure cap/.test(sells(oc)[0].why) && sells(oc).every((o) => o.sleeve !== "R313") && oc.after.grossUsd <= oc.capUsd + 1e-6 && buys(oc, "R313").length === 1 && buys(oc, "R313")[0].qty === 100 && oc.after.cashUsd >= 0, JSON.stringify(oc.orders.map((o) => [o.sleeve, o.sym, o.side, o.qty])) + " " + JSON.stringify(oc.after));
  const od = K.compose(NIGHT({ cash: 0, positions: [{ sleeve: "R313", sym: "SPY", qty: 100 }], prices: { ...PX, SPY: 500 }, intents: { R313: { exits: [], entries: [{ sym: "XLF" }] }, R328: { exits: [], entries: [] }, R180: { want: true } } }), CFG({ exposureCap: 0.5 }));
  ok("held dips ALONE over the cap: nothing is sold for it, nothing bought, and it is noted", !od.orders.length && od.notes.some((n) => /held dip positions alone/.test(n)));
  const f = K.compose(NIGHT({ cash: 30000, positions: [{ sleeve: "R313", sym: "XLF", qty: 1000 }], prices: { ...PX, XLF: 30 }, intents: { R313: { exits: [], entries: [] }, R328: { exits: [], entries: [] }, R180: { want: true } } }), CFG());
  ok("after a loss (equity $60,000 < capital): the cap follows EQUITY; R180 is sized to what is left, never margin", f.equity === 60000 && f.capUsd === 60000 && f.after.grossUsd <= 60000 && f.after.cashUsd >= 0 && buys(f, "R180")[0].qty === 300, JSON.stringify(f.after));
  const g = K.compose(NIGHT({ cash: 100000, positions: [{ sleeve: "R180", sym: "IEF", qty: 600 }], intents: { R313: { exits: [], entries: [] }, R328: { exits: [], entries: [] }, R180: { want: true } } }), CFG());
  ok("R180 above its target (600 sh > 500): trimmed to the target, never grown past it", sells(g, "R180").length === 1 && sells(g, "R180")[0].qty === 100 && g.after.bySleeve.R180 === 50000);
  const h = K.compose(NIGHT({ cash: 100000, intents: { R313: { exits: [], entries: [{ sym: "SPY" }] }, R328: { exits: [], entries: [] }, R180: { want: true } } }), CFG({ reserveUsd: 2500 }));
  ok("reserveUsd 2,500 is kept back from the offer", h.offer.usd === 100000 - 5000 - 50000 - 2500);
});

section("checker cycle 1: exact fits, priority, rank, stackerYields", () => {
  // exact fits (D1): a room equal to the cost, give or take float noise, FITS
  const x1 = K.compose(NIGHT({ cash: 53563.28, positions: [{ sleeve: "R180", sym: "IEF", qty: 494 }], prices: { ...PX, IEF: 93.12, AAA: 168.44 }, intents: { R313: { exits: [], entries: [{ sym: "AAA" }] }, R328: { exits: [], entries: [] }, R180: { want: true } } }),
    CFG({ exposureCap: 0.5, countExitProceeds: true, sleeves: { R313: { slotUsd: 3982.56 }, R328: { slotUsd: 5000 }, R180: { sym: "IEF", targetUsd: 50000 } } }));
  ok("an exact fit after an R180 yield (the checker's case): the dip IS bought at full size; IEF is not sold and bought back in one plan", buys(x1, "R313").length === 1 && !x1.skipped.length && !(sells(x1, "R180").length && buys(x1, "R180").length), JSON.stringify(x1.orders.map((o) => [o.sleeve, o.sym, o.side, o.qty])));
  const x2 = K.compose(NIGHT({ cash: 32.22, prices: { ...PX, TEN: 10.74 }, intents: { R313: { exits: [], entries: [{ sym: "TEN" }] }, R328: { exits: [], entries: [{ sym: "TEN" }] }, R180: { want: false } } }), CFG({ entryPriority: ["R313", "R328"], sleeves: { R313: { slotUsd: 10.74 }, R328: { slotUsd: 21.48 }, R180: { sym: "IEF", targetUsd: 0 } } }));
  ok("an exact cash fit with no yield (32.22 = 10.74 + 2 x 10.74): every entry is bought, none skipped", buys(x2).length === 2 && !x2.skipped.length && x2.after.cashUsd === 0, JSON.stringify([x2.orders, x2.skipped]));
  // priority (D6): R328 first when configured so
  const tight = { cash: 7000, intents: { R313: { exits: [], entries: [{ sym: "SPY" }] }, R328: { exits: [], entries: [{ sym: "IWM" }] }, R180: { want: false } } };
  const p1 = K.compose(NIGHT(tight), CFG({ entryPriority: ["R328", "R313"] })), p2 = K.compose(NIGHT(tight), CFG({ entryPriority: ["R313", "R328"] }));
  ok("entryPriority decides who gets scarce cash: [R328, R313] buys IWM and skips SPY; [R313, R328] the reverse", buys(p1).map((o) => o.sym).join() === "IWM" && p1.skipped[0].sym === "SPY" && buys(p2).map((o) => o.sym).join() === "SPY" && p2.skipped[0].sym === "IWM");
  const rk = K.compose(NIGHT({ cash: 7000, intents: { R313: { exits: [], entries: [{ sym: "AAA2", rank: 2 }, { sym: "ZZZ", rank: 1 }] }, R328: { exits: [], entries: [] }, R180: { want: false } }, prices: { ...PX, AAA2: 50, ZZZ: 50 } }), CFG());
  ok("rank beats the alphabet: ZZZ (rank 1) gets the scarce cash before AAA2 (rank 2)", buys(rk).map((o) => o.sym).join() === "ZZZ" && rk.skipped[0].sym === "AAA2");
  const sy = K.compose(NIGHT({ cash: 50000, positions: [{ sleeve: "R180", sym: "IEF", qty: 300 }, { sleeve: "stacker", sym: "BIL", qty: 200 }], intents: { R313: { exits: [], entries: twelve.map((sym) => ({ sym })) }, R328: { exits: [], entries: [] }, R180: { want: true } } }), CFG({ countExitProceeds: true, stackerYields: false }));
  ok("stackerYields false: the Stacker is never sold for a dip; R180 yields instead", !sells(sy, "stacker").length && sells(sy, "R180").length >= 1 && buys(sy, "R313").length === 12, JSON.stringify(sells(sy)));
});

section("checker cycle 2: the full month calendar, the Stacker never crowds out R180, an exact fit that needs a yield", () => {
  const oct = []; for (let d = 1; d <= 31; d++) { const t = `2026-10-${String(d).padStart(2, "0")}`, g = new Date(t + "T12:00:00Z").getUTCDay(); if (g && g !== 6) oct.push(t); }
  const refuses = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };
  ok("a 'sessions so far' list ending INSIDE R180's window (10-28, asOf 10-28) is REFUSED — every weekday of the month must be a session or a closed weekday", refuses(() => K.r180Want("2026-10-28", oct.filter((d) => d <= "2026-10-28")), /whole calendar is required/));
  ok("a weekend date, an empty list, a non-date: each REFUSED with a clear reason", refuses(() => K.r180Want("2026-10-30", [...oct, "2026-10-31"]), /weekend/) && refuses(() => K.r180Want("2026-10-30", []), /non-empty/) && refuses(() => K.r180Want("2026-10-30", [...oct, 7]), /not a date/));
  // May 2021: Memorial Day is Monday the 31st -> the last session is Friday the 28th
  const may = []; for (let d = 1; d <= 31; d++) { const t = `2021-05-${String(d).padStart(2, "0")}`, g = new Date(t + "T12:00:00Z").getUTCDay(); if (g && g !== 6 && t !== "2021-05-31") may.push(t); }
  const w = (d) => K.r180Window(d, may, ["2021-05-31"]);
  ok("May 2021 with Memorial Day (05-31) as a closed weekday: sessions -6..-2 are 05-21 .. 05-27: flat after 05-20 (wantNext true), held after 05-21 and 05-27, flat after 05-28 (the last session)", !w("2021-05-20").want && w("2021-05-20").wantNext && w("2021-05-21").want && w("2021-05-27").want && !w("2021-05-28").want && !w("2021-05-28").wantNext);
  ok("the same month without its closed weekday: REFUSED (05-31 is neither a session nor closed)", refuses(() => K.r180Want("2026-05-20".replace("2026", "2021"), may), /2021-05-31/));
  // X1: on the night BEFORE R180's window (session -7), a cash account holds R180's target back from the Stacker's offer
  const n7 = oct[oct.length - 7], pre = K.compose(NIGHT({ asOf: n7, cash: 100000, intents: { R313: { exits: [], entries: [] }, R328: { exits: [], entries: [] }, R180: { monthSessions: oct, closedWeekdays: [] } } }), CFG());
  ok(`the night before R180's window (${n7}, session -7), cash account: $50,000 held back for R180, the offer is the other $50,000`, pre.r180.want === false && pre.r180.wantNext === true && pre.offer.heldBackForR180Usd === 50000 && pre.offer.usd === 50000, JSON.stringify(pre.offer));
  const preP = K.compose(NIGHT({ asOf: n7, cash: 100000, intents: { R313: { exits: [], entries: [] }, R328: { exits: [], entries: [] }, R180: { monthSessions: oct } } }), CFG({ countExitProceeds: true }));
  ok("... with proceeds counting, nothing is held back (the Stacker can yield to R180 tomorrow and pay for it)", preP.offer.heldBackForR180Usd === 0 && preP.offer.usd === 100000);
  const s6 = K.compose(NIGHT({ asOf: oct[oct.length - 6], cash: 0, positions: [{ sleeve: "stacker", sym: "BIL", qty: 1000 }], intents: { R313: { exits: [], entries: [] }, R328: { exits: [], entries: [] }, R180: { monthSessions: oct } } }), CFG({ countExitProceeds: true }));
  ok("R180's window opens with all the money in the Stacker (proceeds count): the Stacker YIELDS to R180, which buys its target; the note no longer blames the dip-buys", sells(s6, "stacker").length === 1 && /R180's window/.test(sells(s6, "stacker")[0].why) && s6.after.bySleeve.R180 === 50000, JSON.stringify(s6.orders.map((o) => [o.sleeve, o.side, o.qty, o.why])));
  const s6c = K.compose(NIGHT({ asOf: oct[oct.length - 6], cash: 0, positions: [{ sleeve: "stacker", sym: "BIL", qty: 1000 }], intents: { R313: { exits: [], entries: [] }, R328: { exits: [], entries: [] }, R180: { monthSessions: oct } } }), CFG());
  ok("... in a cash account the Stacker is not sold for nothing (its sale could not pay tonight); R180 is noted short, naming the unsettled Stacker money", !sells(s6c).length && s6c.notes.some((n) => /in the Stacker and not settled/.test(n)));
  // N14: an exact fit that NEEDS a yield (found by search against a raw comparison)
  const ex = K.compose(NIGHT({ cash: 420.63, positions: [{ sleeve: "R180", sym: "IEF", qty: 1 }], prices: { ...PX, IEF: 52.87, AAA: 18.94 }, intents: { R313: { exits: [], entries: [{ sym: "AAA" }] }, R328: { exits: [], entries: [] }, R180: { want: true } } }),
    CFG({ countExitProceeds: true, sleeves: { R313: { slotUsd: 473.5 }, R328: { slotUsd: 5000 }, R180: { sym: "IEF", targetUsd: 1e9 } } }));
  ok("an exact fit that needs R180 to yield (cash 420.63 + one IEF 52.87 = 473.50, the slot): the yield is made and the dip bought at full size", buys(ex, "R313").length === 1 && buys(ex, "R313")[0].qty === 25 && sells(ex, "R180").length === 1 && !ex.skipped.length, JSON.stringify(ex.orders.map((o) => [o.sleeve, o.side, o.qty])));
});

section("refusals", () => {
  const bad = (n, c, re) => { try { K.compose(n, c); return false; } catch (e) { return re.test(e.message); } };
  ok("exposureCap above 1 (margin): REFUSED", bad(NIGHT(), CFG({ exposureCap: 1.2 }), /margin/));
  ok("negative cash (margin in use): REFUSED", bad(NIGHT({ cash: -10 }), CFG(), /negative cash/));
  ok("an unknown sleeve, a short (qty <= 0), a held name with no price, a duplicate position: each REFUSED", bad(NIGHT({ positions: [{ sleeve: "R999", sym: "SPY", qty: 1 }] }), CFG(), /unknown sleeve/) && bad(NIGHT({ positions: [{ sleeve: "R313", sym: "SPY", qty: -5 }] }), CFG(), /positive integer/) && bad(NIGHT({ positions: [{ sleeve: "R313", sym: "ZZZ", qty: 5 }] }), CFG(), /no price/) && bad(NIGHT({ positions: [{ sleeve: "R313", sym: "SPY", qty: 5 }, { sleeve: "R313", sym: "SPY", qty: 5 }] }), CFG(), /twice/));
  ok("a MISSING R313 or R328 block (its runner did not report), a bare-string entry, a non-numeric rank: each REFUSED (never read as 'nothing to do')", bad(NIGHT({ intents: { R328: { exits: [], entries: [] }, R180: { want: false } } }), CFG(), /intents\.R313/) && bad(NIGHT({ intents: { R313: { exits: [], entries: ["SPY"] }, R328: { exits: [], entries: [] }, R180: { want: false } } }), CFG(), /entries\[0\]/) && bad(NIGHT({ intents: { R313: { exits: [], entries: [{ sym: "SPY", rank: "x" }] }, R328: { exits: [], entries: [] }, R180: { want: false } } }), CFG(), /rank/));
  ok("an exit that is not a symbol (a number): REFUSED", bad(NIGHT({ intents: { R313: { exits: [5], entries: [] }, R328: { exits: [], entries: [] }, R180: { want: false } } }), CFG(), /exits\[0\]/));
  ok("a held R180 position on another instrument (TLT while the config says IEF): REFUSED", bad(NIGHT({ positions: [{ sleeve: "R180", sym: "TLT", qty: 5 }], prices: { ...PX, TLT: 90 } }), CFG(), /R180 position is TLT/));
  ok("R180 monthSessions with a date twice, or only the sessions seen so far: REFUSED", (() => { const oct = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]; try { K.r180Want("2026-10-27", [...oct, "2026-10-27"]); return false; } catch (e) { if (!/twice/.test(e.message)) return false; } try { K.r180Want("2026-10-15", ["2026-10-01", "2026-10-02", "2026-10-15"]); return false; } catch (e) { return /whole calendar is required/.test(e.message); } })());
  ok("a missing slot size, a bad entryPriority, a missing R180 intent: each REFUSED", bad(NIGHT(), CFG({ sleeves: { R313: {}, R328: { slotUsd: 5000 }, R180: { sym: "IEF", targetUsd: 1 } } }), /slotUsd/) && bad(NIGHT(), CFG({ entryPriority: ["R313"] }), /entryPriority/) && bad(NIGHT({ intents: { R313: { exits: [], entries: [] }, R328: { exits: [], entries: [] } } }), CFG(), /intents\.R180/));
});

section("invariants over 3,000 random nights (seeded)", () => {
  let s = 20261016; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }, pick = (a) => a[Math.floor(rnd() * a.length)];
  const names = Object.keys(PX).filter((k) => k !== "IEF" && k !== "BIL"); let broken = [], deterministic = true, n = 0;
  for (let t = 0; t < 3000; t++) {
    const prices = Object.fromEntries(Object.entries(PX).map(([k, v]) => [k, +(v * (0.7 + 0.6 * rnd())).toFixed(2)]));
    const positions = []; const used = new Set();
    for (let k = 0, m = Math.floor(rnd() * 10); k < m; k++) { const sleeve = pick(["R313", "R328", "R180", "stacker"]), sym = sleeve === "R180" ? "IEF" : sleeve === "stacker" ? "BIL" : pick(names); if (used.has(sleeve + sym)) continue; used.add(sleeve + sym); positions.push({ sleeve, sym, qty: 1 + Math.floor(rnd() * 200) }); }
    const held = (sl) => positions.filter((p) => p.sleeve === sl).map((p) => p.sym);
    const night = NIGHT({ cash: Math.floor(rnd() * 120000), positions, prices,
      intents: { R313: { exits: held("R313").filter(() => rnd() < 0.4), entries: names.filter(() => rnd() < 0.15).map((sym) => ({ sym, rank: Math.floor(rnd() * 5) })) },
        R328: { exits: held("R328").filter(() => rnd() < 0.4), entries: names.filter(() => rnd() < 0.15).map((sym) => ({ sym })) }, R180: { want: rnd() < 0.5 } } });
    const cfg = CFG({ exposureCap: pick([0.5, 0.8, 1]), countExitProceeds: rnd() < 0.5, r180YieldsToDips: rnd() < 0.8, stackerYields: rnd() < 0.8, reserveUsd: pick([0, 1000]), sleeves: { R313: { slotUsd: pick([2500, 5000]) }, R328: { slotUsd: pick([2500, 5000]) }, R180: { sym: "IEF", targetUsd: pick([0, 30000, 50000]) } } });
    let p; try { p = K.compose(night, cfg); } catch (e) { broken.push(`night ${t}: threw ${e.message.slice(0, 120)}`); continue; }
    n++;
    const equity = night.cash + positions.reduce((a, x) => a + x.qty * prices[x.sym], 0), cap = cfg.exposureCap * equity;
    const exitsOk = p.orders.filter((o) => o.side === "sell" && (o.sleeve === "R313" || o.sleeve === "R328")).every((o) => night.intents[o.sleeve].exits.includes(o.sym));
    const fullSlot = buys(p).filter((o) => o.sleeve !== "R180").every((o) => o.qty === Math.floor(cfg.sleeves[o.sleeve].slotUsd / prices[o.sym]));
    const offerOk = Math.abs(p.offer.usd - Math.max(0, Math.min(cap - p.after.grossUsd, p.after.cashUsd + (cfg.countExitProceeds ? p.after.unsettledProceedsUsd : 0)) - cfg.reserveUsd)) < 0.02;
    const r180Max = p.after.bySleeve.R180 <= Math.max(cfg.sleeves.R180.targetUsd, positions.filter((x) => x.sleeve === "R180").reduce((a, x) => a + x.qty * prices.IEF, 0)) + 1e-6;
    const notWanted = night.intents.R180.want || p.after.bySleeve.R180 === 0;
    const yieldOnlyWhenEntered = (!p.orders.some((o) => /yields to a dip-buy/.test(o.why)) || buys(p).some((o) => o.sleeve !== "R180")) && (!p.orders.some((o) => /yields to R180's window/.test(o.why)) || (night.intents.R180.want && buys(p, "R180").length > 0));
    const dipHeld = positions.filter((x) => (x.sleeve === "R313" || x.sleeve === "R328") && !night.intents[x.sleeve].exits.includes(x.sym)).reduce((a, x) => a + x.qty * prices[x.sym], 0);
    const capOk = p.after.grossUsd <= Math.max(cap, dipHeld) + 0.01 && (p.after.grossUsd <= cap + 0.01 || !buys(p).length);
    if (!(capOk && p.after.cashUsd >= -0.01 && exitsOk && fullSlot && offerOk && r180Max && notWanted && yieldOnlyWhenEntered)) broken.push(`night ${t}: ${JSON.stringify({ g: p.after.grossUsd, cap, dipHeld, cash: p.after.cashUsd, exitsOk, fullSlot, offerOk, r180Max, notWanted, yieldOnlyWhenEntered })}`);
    if (t % 300 === 0 && JSON.stringify(K.compose(night, cfg)) !== JSON.stringify(p)) deterministic = false;
  }
  ok(`${n} random nights: gross <= cap (or, with held dips alone over it, no buy and nothing above them), cash >= 0 (no margin), dip buys at full slot, dip sells only their own exits, R180 never above max(target, held) and flat when not wanted, a yield only on a night with a dip entry, offer = idle room - reserve`, !broken.length && n === 3000, broken.slice(0, 3).join(" | "));
  ok("the same night and config give the same plan (deterministic)", deterministic);
});

section("the CLI, and no broker / network / order code", () => {
  const nf = path.join(TMP, "night.json"), cf = path.join(TMP, "cfg.json"), out = path.join(TMP, "plan.json");
  fs.writeFileSync(nf, JSON.stringify(NIGHT({ intents: { R313: { exits: [], entries: [{ sym: "SPY" }] }, R328: { exits: [], entries: [] }, R180: { want: true } } }))); fs.writeFileSync(cf, JSON.stringify(CFG()));
  const awBefore = fs.readdirSync(os.tmpdir()).filter((f) => /^aw-/.test(f)).length;
  const logs = [];
  const { writeJsonAtomic } = require(path.join(H, "aw.cjs")).loadAtomicWrite(REPO);
  const rc = K.main(["--input", nf, "--config", cf, "--out", out], { log: (l) => logs.push(l), err: (l) => logs.push(l), writeJson: writeJsonAtomic });
  const plan = JSON.parse(fs.readFileSync(out, "utf8"));
  ok("loading atomic-write through aw.cjs leaves no temp folder behind", fs.readdirSync(os.tmpdir()).filter((f) => /^aw-/.test(f)).length <= awBefore);
  ok("--out writes the plan through backend/lib/atomic-write.js (exit 0), the same as compose()", rc === 0 && /PLAN 2026-10-15: 2 order/.test(logs[0]) && JSON.stringify(plan) === JSON.stringify(K.compose(JSON.parse(fs.readFileSync(nf, "utf8")), CFG())), logs.join(" "));
  const r2 = cp.spawnSync(process.execPath, [SRC, "--input", nf, "--config", cf], { encoding: "utf8" });
  ok("without --out: prints the plan, writes nothing", r2.status === 0 && JSON.parse(r2.stdout).schema === "proven-book-plan-v1");
  ok("bad arguments: exit 2; a refused config: exit 1", cp.spawnSync(process.execPath, [SRC, "--input"], { encoding: "utf8" }).status === 2 && (() => { fs.writeFileSync(cf, JSON.stringify(CFG({ exposureCap: 2 }))); return cp.spawnSync(process.execPath, [SRC, "--input", nf, "--config", cf], { encoding: "utf8" }).status === 1; })());
  const code = fs.readFileSync(SRC, "utf8");
  ok("the composer holds no broker, network or order code (no http/https/net, no fetch(, no alpaca / schwab / tasty, no /v2/orders)", !/require\(["'](https?|net|dns|tls|child_process)["']\)|\bfetch\(|alpaca|schwab|tasty|\/v2\/orders|APCA/i.test(code));
});

section("the package (deploy / rollback / record on a temp repo)", () => {
  const repo = fs.mkdtempSync(path.join(TMP, "repo-")); fs.writeFileSync(path.join(repo, "AGENTS.md"), "x"); fs.mkdirSync(path.join(repo, "backend"));
  const node = (f, ...a) => cp.spawnSync(process.execPath, [path.join(H, f), ...a, "--repo", repo], { encoding: "utf8" });
  const rel = "backend/proven-book/book-composer.cjs", live = path.join(repo, rel);
  const p = node("deploy.cjs", "--plan"), a = node("deploy.cjs", "--apply");
  ok("deploy --plan then --apply: the new file is the staged bytes", p.status === 0 && /would write 1 file/.test(p.stdout) && a.status === 0 && fs.readFileSync(live).equals(fs.readFileSync(SRC)), p.stdout + a.stdout);
  const rb = node("rollback.cjs");
  ok("rollback removes it", rb.status === 0 && !fs.existsSync(live));
  fs.mkdirSync(path.dirname(live), { recursive: true }); fs.writeFileSync(live, "// a different file of the same name at home\n");
  const d = node("deploy.cjs", "--apply");
  ok("a different file already at that path at home: --apply REFUSED, untouched", d.status === 1 && fs.readFileSync(live, "utf8").startsWith("// a different"));
  const own = cp.spawnSync(process.execPath, [path.join(H, "deploy.cjs"), "--plan"], { encoding: "utf8" });
  ok("deploy --plan without --repo (this repository): exit 0", own.status === 0 && /backend\/proven-book\/book-composer\.cjs/.test(own.stdout), own.stdout + own.stderr);
  ok("record --dry: prints, writes nothing", /DRY: nothing written/.test(node("record.cjs", "--dry").stdout));
  ok("node --check of every package file", [...fs.readdirSync(H).filter((f) => f.endsWith(".cjs")).map((f) => path.join(H, f)), SRC].every((f) => cp.spawnSync(process.execPath, ["--check", f]).status === 0));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fail ? quiet(`SELFTEST: ${fail} of ${pass + fail} cases FAILED`) : `ALL ${pass} CASES PASSED (proven-book-composer; fixtures only)`);
process.exitCode = fail ? 1 : 0;
