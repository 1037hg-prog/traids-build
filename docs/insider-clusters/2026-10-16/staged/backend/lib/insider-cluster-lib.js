"use strict";
/**
 * INSIDER CLUSTERS — three or more distinct insiders buying at one company inside TEN TRADING DAYS. Pure: no clock, no disk, no
 * network. 2026-10-16.
 *
 * TEN TRADING DAYS, COUNTED EXACTLY. The window is ten trading days INCLUSIVE: the first and the last buy day of a cluster are at
 * most nine trading days apart, so a buy on trading day 5 and a buy on trading day 14 are inside it and a buy on trading day 15 is
 * not. Trading days come from the desk's own holiday table (backend/lib/run-window.js MARKET_HOLIDAYS), not from "ten weekdays":
 * over US Thanksgiving the two differ, and the difference decides whether a real cluster is found. The package's selftest pins
 * exactly that case (a buy on 2026-11-16 and a buy on 2026-11-30 are ten trading days apart BECAUSE Thanksgiving is closed; count
 * weekdays instead and they are eleven and the cluster disappears).
 *
 * A CALENDAR THAT DOES NOT COVER THE DATES IS A REFUSAL, NOT A GUESS. MARKET_HOLIDAYS is extended by hand each December. Outside the
 * range it covers, a market holiday would silently count as a trading day and every window would be measured too narrow — so
 * tradingCalendar REFUSES a range it cannot cover, and names the dates. `allowUncovered` is there for a deliberate run over older
 * dates, and then `uncovered` is set on the calendar and carried into the result, so nothing reads as calendar-clean when it is not.
 *
 * A BUY DATED ON A CLOSED DAY. Form 4 transaction dates are keyed by hand and a few land on a Saturday or a holiday, where no open
 * market purchase can have happened. Such a date is placed on the NEXT trading day (the earliest day the purchase could be real) and
 * flagged `offCalendar` on the cluster — forward, never back, so a misdated buy can never pull a cluster's window earlier than the
 * market allows.
 *
 * ONE COMPANY-DAY BELONGS TO AT MOST ONE CLUSTER. Scanning day by day, the first day at which the window reaching back ten trading
 * days holds `minInsiders` distinct insiders is the TRIGGER; the cluster is every company-day in that window, and those days are
 * then spent. Without that rule a run of five insiders over two weeks reports as four near-identical clusters. The next cluster at
 * the same company is built from days after the trigger only.
 *
 * WHEN THE CLUSTER WAS PUBLIC. `triggerBuy` is the day the third insider BOUGHT; `publicOn` is the latest filing date among the
 * cluster's own filings — the first day a reader outside the company could have known all of it. Anything that trades on this must
 * use `publicOn`; `triggerBuy` is in the past by up to two business days and using it is look-ahead. Both are on every cluster, and
 * `publicOnKnown` is false when any filing in the cluster carried no filing date.
 */

const SPEC = "insider-clusters-v1";
const WINDOW_TRADING_DAYS = 10, MIN_INSIDERS = 3;
const isoDay = (v) => { const s = String(v || "").trim().slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + "T12:00:00Z")) ? s : null; };
const addDays = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const dowOf = (iso) => new Date(Date.parse(iso + "T12:00:00Z")).getUTCDay();
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * The trading-day calendar for [from, to]: Monday to Friday, less the holiday table.
 * Returns { days, index: Map day -> i, from, to, coveredFrom, coveredTo, uncovered, holidaysUsed, place(date) }.
 * `place(date)` -> { day, index, offCalendar } for a trading day or the next trading day after a closed one, or null when the date
 * is outside the calendar's range (a caller must widen the range rather than read a null as "no cluster").
 * THROWS when the range is not covered by the holiday table, unless allowUncovered is set.
 */
function tradingCalendar({ from, to, holidays = {}, allowUncovered = false } = {}) {
  const a = isoDay(from), b = isoDay(to);
  if (!a || !b) throw new Error(`insider clusters: tradingCalendar needs two ISO days, got ${JSON.stringify(from)} and ${JSON.stringify(to)}`);
  if (a > b) throw new Error(`insider clusters: tradingCalendar range runs backwards (${a} .. ${b})`);
  const keys = Object.keys(holidays).filter(isoDay).sort();
  if (!keys.length) throw new Error("insider clusters: the holiday table is empty — refused (every window would be measured as weekdays, which is wrong over any holiday)");
  const coveredFrom = keys[0], coveredTo = `${keys[keys.length - 1].slice(0, 4)}-12-31`;
  const uncovered = a < coveredFrom || b > coveredTo;
  if (uncovered && !allowUncovered) {
    throw new Error(`insider clusters: the holiday table covers ${coveredFrom} .. ${coveredTo}, and this run needs ${a} .. ${b}. Outside it a market holiday would count as a trading day and every ten-day window would be too narrow. Extend MARKET_HOLIDAYS in backend/lib/run-window.js, or pass --allow-uncovered-calendar deliberately (the result is then marked uncovered).`);
  }
  const days = [], index = new Map();
  for (let d = a; d <= b; d = addDays(d, 1)) {
    const dow = dowOf(d);
    if (dow === 0 || dow === 6 || holidays[d]) continue;
    index.set(d, days.length);
    days.push(d);
  }
  const cal = {
    days, index, from: a, to: b, coveredFrom, coveredTo, uncovered,
    holidaysUsed: keys.filter((k) => k >= a && k <= b),
    place(date) {
      const d0 = isoDay(date);
      if (!d0 || d0 < a || d0 > b) return null;
      if (index.has(d0)) return { day: d0, index: index.get(d0), offCalendar: false };
      for (let d = addDays(d0, 1); d <= b; d = addDays(d, 1)) if (index.has(d)) return { day: d, index: index.get(d), offCalendar: true, dated: d0 };
      return null;                                    // a closed date with no trading day after it inside the range
    },
  };
  return cal;
}

/** the calendar a set of company-day records needs: their own span, with room after the last one for a closed last date */
function calendarFor(records, { holidays = {}, allowUncovered = false, pad = 21 } = {}) {
  const dates = records.map((r) => isoDay(r.tradeDate)).filter(Boolean).sort();
  if (!dates.length) throw new Error("insider clusters: no readable tradeDate in these records — nothing to build a calendar for");
  return tradingCalendar({ from: dates[0], to: addDays(dates[dates.length - 1], pad), holidays, allowUncovered });
}

/**
 * findClusters(records, opts) -> { clusters, summary, skipped }
 *
 * records  company-day records (insider-buys-lib shape), already merged: one per (cik, tradeDate).
 * opts     calendar (required), windowTradingDays = 10, minInsiders = 3, minUsdPerInsider = 0 (an insider whose dollars for that day
 *          are under it does not count toward the cluster), minUsdTotal = 0 (the cluster's own floor).
 *
 * Every cluster carries the days, the insiders, the filings and the two dates that matter (`triggerBuy`, `publicOn`).
 */
function findClusters(records, {
  calendar, windowTradingDays = WINDOW_TRADING_DAYS, minInsiders = MIN_INSIDERS, minUsdPerInsider = 0, minUsdTotal = 0,
} = {}) {
  if (!calendar || typeof calendar.place !== "function") throw new Error("insider clusters: findClusters needs a trading calendar (tradingCalendar / calendarFor)");
  if (!Number.isInteger(windowTradingDays) || windowTradingDays < 1) throw new Error(`insider clusters: windowTradingDays must be a whole number of days, not ${windowTradingDays}`);
  if (!Number.isInteger(minInsiders) || minInsiders < 2) throw new Error(`insider clusters: minInsiders must be 2 or more, not ${minInsiders}`);

  const skipped = [], byIssuer = new Map();
  for (const r of records) {
    const placed = calendar.place(r.tradeDate);
    if (!placed) { skipped.push({ cik: r.cik, tradeDate: r.tradeDate, why: `outside the calendar ${calendar.from} .. ${calendar.to}` }); continue; }
    const insiders = (r.byInsider || []).filter((i) => (Number(i.usd) || 0) >= minUsdPerInsider);
    if (!insiders.length) { skipped.push({ cik: r.cik, tradeDate: r.tradeDate, why: `no insider at or above $${minUsdPerInsider}` }); continue; }
    const list = byIssuer.get(r.cik) || [];
    list.push({ rec: r, idx: placed.index, day: placed.day, offCalendar: Boolean(placed.offCalendar), insiders });
    byIssuer.set(r.cik, list);
  }

  const clusters = [];
  for (const [cik, all] of byIssuer) {
    all.sort((x, y) => x.idx - y.idx || byKey(x.rec.tradeDate, y.rec.tradeDate));
    let fromPos = 0;
    for (let j = fromPos; j < all.length; j++) {
      const windowStartIdx = all[j].idx - (windowTradingDays - 1);
      const inWindow = [];
      for (let i = fromPos; i <= j; i++) if (all[i].idx >= windowStartIdx) inWindow.push(all[i]);
      const owners = new Set();
      for (const w of inWindow) for (const i of w.insiders) owners.add(i.ownerCik);
      if (owners.size < minInsiders) continue;
      const usd = round2(inWindow.reduce((s, w) => s + (Number(w.rec.usd) || 0), 0));
      if (usd < minUsdTotal) continue;
      clusters.push(buildCluster({ cik, inWindow, trigger: all[j], windowTradingDays, calendar }));
      fromPos = j + 1;                                 // a spent company-day never joins a second cluster
    }
  }
  clusters.sort((a, b) => byKey(a.triggerBuy, b.triggerBuy) || byKey(a.cik, b.cik));

  const owners = new Set();
  for (const list of byIssuer.values()) for (const w of list) for (const i of w.insiders) owners.add(`${w.rec.cik}|${i.ownerCik}`);
  return {
    clusters,
    skipped,
    summary: {
      spec: SPEC, windowTradingDays, minInsiders, minUsdPerInsider, minUsdTotal,
      issuers: byIssuer.size, companyDays: [...byIssuer.values()].reduce((s, l) => s + l.length, 0),
      insiderCompanyPairs: owners.size,
      clusters: clusters.length,
      issuersWithCluster: new Set(clusters.map((c) => c.cik)).size,
      calendar: { from: calendar.from, to: calendar.to, tradingDays: calendar.days.length, coveredFrom: calendar.coveredFrom, coveredTo: calendar.coveredTo, uncovered: Boolean(calendar.uncovered), holidaysInRange: calendar.holidaysUsed.length },
      skippedDays: skipped.length,
    },
  };
}

/** one window's company-days -> the cluster record */
function buildCluster({ cik, inWindow, trigger, windowTradingDays, calendar }) {
  const days = inWindow.map((w) => ({ tradeDate: w.rec.tradeDate, placedOn: w.day, offCalendar: w.offCalendar, insiders: w.insiders.length, usd: round2(Number(w.rec.usd) || 0), filings: (w.rec.accessions || []).length }));
  // one insider across the window's days: the dollars add up, and the role is the UNION of what the days said (a director in one
  // filing and an officer in another is one officer-and-director, not a coin toss between the two)
  const ins = new Map();
  for (const w of inWindow) for (const i of w.insiders) {
    const cur = ins.get(i.ownerCik) || { ownerCik: i.ownerCik, isOfficer: false, isDirector: false, titles: [], usd: 0, shares: 0, days: [] };
    cur.usd += Number(i.usd) || 0; cur.shares += Number(i.shares) || 0;
    cur.days.push(w.rec.tradeDate);
    cur.titles = [...new Set([...cur.titles, ...(i.titles || [])])].sort();
    if (i.role === "officer" || i.role === "officer-and-director") cur.isOfficer = true;
    if (i.role === "director" || i.role === "officer-and-director") cur.isDirector = true;
    ins.set(i.ownerCik, cur);
  }
  const insiderList = [...ins.values()].sort((a, b) => b.usd - a.usd || byKey(a.ownerCik, b.ownerCik))
    .map(({ isOfficer, isDirector, ...i }) => ({
      ownerCik: i.ownerCik,
      role: isOfficer && isDirector ? "officer-and-director" : isOfficer ? "officer" : "director",
      titles: i.titles, usd: round2(i.usd), shares: Math.round(i.shares * 1e6) / 1e6, days: [...new Set(i.days)].sort(),
    }));
  const roles = { officer: 0, director: 0, officerAndDirector: 0 };
  for (const i of insiderList) roles[i.role === "officer-and-director" ? "officerAndDirector" : i.role]++;
  const accessions = [...new Set(inWindow.flatMap((w) => (w.rec.accessions || []).map((a) => a.accession)))].sort();
  const filedDays = inWindow.flatMap((w) => (w.rec.accessions || []).map((a) => a.filedOn));
  const known = filedDays.filter(Boolean).sort();
  const publicOnKnown = known.length === filedDays.length && known.length > 0;
  const publicOn = publicOnKnown ? known[known.length - 1] : null;
  const first = inWindow[0], last = inWindow[inWindow.length - 1];
  const publicPlaced = publicOn ? calendar.place(publicOn) : null;
  return {
    spec: SPEC,
    cik, sym: first.rec.sym || null, issuer: first.rec.issuer || null,
    firstBuy: first.rec.tradeDate, triggerBuy: trigger.rec.tradeDate, lastBuy: last.rec.tradeDate,
    spanTradingDays: last.idx - first.idx + 1,
    windowTradingDays,
    insiders: insiderList.length,
    usd: round2(inWindow.reduce((s, w) => s + (Number(w.rec.usd) || 0), 0)),
    shares: Math.round(inWindow.reduce((s, w) => s + (Number(w.rec.shares) || 0), 0) * 1e6) / 1e6,
    roles,
    roleList: Object.entries(roles).filter(([, n]) => n > 0).map(([k]) => (k === "officerAndDirector" ? "officer-and-director" : k)).sort(),
    titles: [...new Set(insiderList.flatMap((i) => i.titles))].sort(),
    buyDays: days.length,
    days,
    insiderList,
    filings: accessions.length,
    accessions,
    publicOn, publicOnKnown,
    publicLagTradingDays: publicPlaced && trigger.idx !== undefined ? publicPlaced.index - trigger.idx : null,
    offCalendarDays: days.filter((d) => d.offCalendar).length,
    calendarUncovered: Boolean(calendar.uncovered),
  };
}

module.exports = { SPEC, WINDOW_TRADING_DAYS, MIN_INSIDERS, tradingCalendar, calendarFor, findClusters, buildCluster, isoDay, addDays, dowOf };
