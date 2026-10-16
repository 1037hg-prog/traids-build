"use strict";
// STEP 3 (offline, no request): the SHARE-SPLIT / BAD-PRINT screen. A data-integrity check, not a measurement of any fund's result.
// Yahoo's price series is adjusted backwards for share splits. If the NAV series is not adjusted the same way, the NAV shows a one-day
// step by the split factor that the price does not show (and every earlier row is then in different units from the price).
// This lists, per fund, the DATES where one series steps by a split-sized factor in a day while the other moves less than 15%, the
// size of the step rounded to two decimals (to recognise the split ratio), and whether the step is undone within three rows (a bad
// print) or stays (a unit change).
//
// WHY THE THRESHOLDS ARE WHAT THEY ARE (2026-10-12): the first version of this screen used 30% for both series and printed, besides the
// artifacts, REAL one-day price moves of real funds on two crisis days. That was an outcome seen by accident and is disclosed in
// scout-data.md under "outcomesSeen". This version cannot print a real move: a PRICE step is listed only at 1.9x or more (or 0.53x or
// less), a NAV step that stays is listed only at the same size, and a smaller NAV step (30% to 90%) is listed only when it is undone
// within three rows, which is a wrong print and not a move. Steps both series share are not listed at all.
const fs = require("fs"), path = require("path");
const { CACHE } = require("./scout-lib.cjs");
const U = JSON.parse(fs.readFileSync(path.join(__dirname, "scout-universe.json"), "utf8")).funds;
const cal = JSON.parse(fs.readFileSync(path.join(CACHE, "calendar.json"), "utf8")).days;
const load = (s) => JSON.parse(fs.readFileSync(path.join(CACHE, "series", s + ".json"), "utf8"));
const SPLIT = 1.9, PRINT = 1.3, SMALL = 1.15;
const over = (r, k) => r > k || r < 1 / k, small = (r) => r < SMALL && r > 1 / SMALL;
const out = []; const n = { navUnit: 0, navPrint: 0, pxUnit: 0, pxPrint: 0 };
for (const f of U.filter((x) => x.priceRows && x.navRows)) {
  const P = load(f.ticker), V = load(f.navSymbol), pm = new Map(P.idx.map((i, k) => [i, P.close[k]])), vm = new Map(V.idx.map((i, k) => [i, V.close[k]]));
  const lo = Math.max(P.idx[0], V.idx[0]), hi = Math.min(P.idx[P.idx.length - 1], V.idx[V.idx.length - 1]), ev = [];
  let prevP = null, prevV = null;
  for (let i = lo; i <= hi; i++) {
    const p = pm.get(i), v = vm.get(i); if (p == null || v == null || !(p > 0) || !(v > 0)) continue;
    if (prevP != null) {
      const rp = p / prevP, rv = v / prevV;
      const undone = (get, base) => { let c = 0; for (let j = i + 1; j <= hi && c < 3; j++) { const x = get(j); if (x == null) continue; c++; if (small(x / base)) return true; } return false; };
      if (small(rp) && over(rv, PRINT)) { const u = undone((j) => vm.get(j), prevV);
        if (u) { ev.push(`${cal[i]} NAV x${rv.toFixed(2)} for a day (wrong print)`); n.navPrint++; } else if (over(rv, SPLIT)) { ev.push(`${cal[i]} NAV x${rv.toFixed(2)} and stays (unit change)`); n.navUnit++; } }
      else if (small(rv) && over(rp, SPLIT)) { const u = undone((j) => pm.get(j), prevP);
        if (u) { ev.push(`${cal[i]} PRICE x${rp.toFixed(2)} for a day (wrong print)`); n.pxPrint++; } else { ev.push(`${cal[i]} PRICE x${rp.toFixed(2)} and stays (unit change)`); n.pxUnit++; } }
    }
    prevP = p; prevV = v;
  }
  if (ev.length) out.push({ t: f.ticker, nav: f.navSymbol, ev });
}
console.log(`funds with a split-sized step or a wrong print in one series that the other does not share: ${out.length} of ${U.filter((x) => x.priceRows && x.navRows).length}`);
console.log(`NAV unit changes ${n.navUnit}, NAV wrong prints ${n.navPrint}, price unit changes ${n.pxUnit}, price wrong prints ${n.pxPrint}`);
for (const o of out) console.log(`  ${o.t}/${o.nav}: ${o.ev.slice(0, 10).join("; ")}${o.ev.length > 10 ? `; +${o.ev.length - 10} more` : ""}`);
