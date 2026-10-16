#!/usr/bin/env node
/**
 * NOTE 2026-09-24: the dollar leg is kept only as a check — the R212/R216 dollar result was a scoring artifact (see R216 defectNote).
 * FUTURES MONTH-END STUDY (2026-09-24, operator: "yes test the futures version"). EXPLORATORY implementation study of two already-sealed
 * rules on futures, with leverage and T-bill collateral. Seals nothing; no bar (the rules' evidence is R180/R216/R217).
 *   Treasury leg (R180/R186 rule): long 10-year note futures (ZN) from the close of the month's 6th-to-last session to the close of its last.
 *   Dollar leg (R216 variant B): the six CME currency futures (6E 6J 6B 6A 6C 6S, all quoted in dollars per foreign unit). Signal =
 *     equal-weight dollar month-to-date move at the close of session L-4; hold the basket AGAINST it to the close of the last session.
 * DATA: Yahoo continuous front-month futures via the :3002 proxy (not back-adjusted). ROLL GUARD: every window day is checked against a
 *   cash proxy (ZN vs IEF; each currency future vs its Yahoo spot pair); a day whose residual exceeds 6 robust sd is treated as a roll
 *   jump, replaced by the proxy's move (ZN: beta x IEF), and charged an extra 2 bps. Counts are reported.
 * COSTS: 4 bps of notional per round trip per leg (commission + a tick of slippage each side on ZN / micro FX futures).
 * COLLATERAL: the whole account earns the 3-month T-bill (FRED DTB3, month-average yield / 12); futures P&L is added on leverage L.
 *   node backend/futures-month-end.js
 */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const CACHE = path.join(__dirname, "data", "training", "fred");
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const yahoo = async (sym) => { const j = await (await fetch(`http://localhost:3002/api/yahoo/${encodeURIComponent(sym)}/history?days=9000&interval=1d`, { signal: AbortSignal.timeout(60000) })).json(); return new Map((j.bars || []).filter((b) => b.close > 0 && b.date <= "2026-08-31").map((b) => [b.date, sym === "IEF" ? b.adjClose || b.close : b.close])); };
async function dtb3() { fs.mkdirSync(CACHE, { recursive: true }); const f = path.join(CACHE, "DTB3.csv"); if (!fs.existsSync(f)) { const r = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3", { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error("DTB3 HTTP " + r.status); fs.writeFileSync(f, await r.text()); }
  const M = {}; for (const l of fs.readFileSync(f, "utf8").trim().split(/\r?\n/).slice(1)) { const [d, v] = l.split(","); if (v && v !== "." && /^\d{4}/.test(d)) (M[d.slice(0, 7)] = M[d.slice(0, 7)] || []).push(+v); } return Object.fromEntries(Object.entries(M).map(([m, a]) => [m, mean(a) / 100 / 12])); }
const FX = [["6E=F", "EURUSD=X", 1], ["6J=F", "JPY=X", -1], ["6B=F", "GBPUSD=X", 1], ["6A=F", "AUDUSD=X", 1], ["6C=F", "CAD=X", -1], ["6S=F", "CHF=X", -1]];   // spot sign: +1 if spot is dollars per foreign unit (same as the future)
(async () => {
  const zn = await yahoo("ZN=F"), ief = await yahoo("IEF"), fut = {}, spot = {};
  for (const [f, s] of FX) { fut[f] = await yahoo(f); spot[f] = await yahoo(s); }
  const tb = await dtb3();
  const dates = [...zn.keys()].filter((d) => d >= "2003-01-01" && ief.has(d) && FX.every(([f]) => fut[f].has(d))).sort();
  const ret = (m, i) => Math.log(m.get(dates[i]) / m.get(dates[i - 1]));
  // ---- roll guards ----
  const znR = [], iefR = []; for (let i = 1; i < dates.length; i++) { znR.push(ret(zn, i)); iefR.push(ret(ief, i)); }
  const beta = (() => { const mx = mean(iefR), my = mean(znR); let c = 0, v = 0; iefR.forEach((x, i) => { c += (x - mx) * (znR[i] - my); v += (x - mx) ** 2; }); return c / v; })();
  const znRes = znR.map((y, i) => y - beta * iefR[i]), znS = 1.4826 * med(znRes.map((x) => Math.abs(x - med(znRes))));
  const guard = { ZN: 0 }; const Z = [null]; for (let i = 1; i < dates.length; i++) { const r = znR[i - 1]; if (Math.abs(znRes[i - 1]) > 6 * znS) { guard.ZN++; Z.push({ r: beta * iefR[i - 1], roll: true }); } else Z.push({ r, roll: false }); }
  const F = {}; for (const [f, , sg] of FX) { guard[f] = 0; F[f] = [null]; const res = []; const raw = [];
    for (let i = 1; i < dates.length; i++) { const fr = ret(fut[f], i), sp = spot[f].has(dates[i]) && spot[f].has(dates[i - 1]) ? sg * ret(spot[f], i) : null; raw.push([fr, sp]); if (sp != null) res.push(fr - sp); }
    const s = 1.4826 * med(res.map((x) => Math.abs(x - med(res))));
    for (const [fr, sp] of raw) { if (sp != null && Math.abs(fr - sp) > 6 * s) { guard[f]++; F[f].push({ r: sp, roll: true }); } else F[f].push({ r: fr, roll: false }); } }
  // ---- monthly legs ----
  const M = {}; dates.forEach((d, i) => { if (i > 0) (M[d.slice(0, 7)] = M[d.slice(0, 7)] || []).push(i); });
  const rows = [];
  for (const m of Object.keys(M).sort()) { const ix = M[m]; if (ix.length < 15 || m > "2026-08") continue; const L = ix.length;
    // Treasury: close of L-6 -> close of L-1  => returns of sessions L-5..L-1
    const tw = ix.slice(L - 5); const tRolls = tw.filter((i) => Z[i].roll).length; const tre = Math.exp(tw.reduce((s, i) => s + Z[i].r, 0)) - 1 - 0.0004 - 0.0002 * tRolls;
    // Dollar: signal = month-to-date through session L-4 (dollar up = foreign futures down, so dollar change = -mean(futures log change))
    const upTo = ix.slice(0, L - 3), win = ix.slice(L - 3); let fRolls = 0;
    const dollarMTD = -mean(FX.map(([f]) => upTo.reduce((s, i) => s + F[f][i].r, 0))); if (dollarMTD === 0) continue;
    const pos = dollarMTD > 0 ? 1 : -1;   // dollar rose -> LONG the foreign-currency futures basket
    const legRets = FX.map(([f]) => { fRolls += win.filter((i) => F[f][i].roll).length; return Math.exp(win.reduce((s, i) => s + F[f][i].r, 0)) - 1; });
    const usd = pos * mean(legRets) - 0.0004 - 0.0002 * fRolls / FX.length;
    rows.push({ m, tb: tb[m] ?? 0, tre, usd }); }
  // ---- portfolios ----
  function book(Lt, Lu, lo = "0000", hi = "9999") { const R = rows.filter((r) => r.m >= lo && r.m <= hi); const monthly = R.map((r) => r.tb + Lt * r.tre + Lu * r.usd), cash = R.map((r) => r.tb);
    const yrs = R.length / 12, w = monthly.reduce((p, x) => p * (1 + x), 1), wc = cash.reduce((p, x) => p * (1 + x), 1); let pk = 1, v = 1, dd = 0; for (const x of monthly) { v *= 1 + x; pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); }
    const byYear = {}; R.forEach((r, i) => { byYear[r.m.slice(0, 4)] = (byYear[r.m.slice(0, 4)] || 1) * (1 + monthly[i]); });
    const yr = Object.values(byYear).map((x) => x - 1), ex = monthly.map((x, i) => x - cash[i]);
    return { cagrPct: +(100 * (w ** (1 / yrs) - 1)).toFixed(2), tbillOnlyPct: +(100 * (wc ** (1 / yrs) - 1)).toFixed(2), sharpe: +((mean(ex) / sd(ex)) * Math.sqrt(12)).toFixed(2), maxDDPct: +(100 * dd).toFixed(1), worstYearPct: +(100 * Math.min(...yr)).toFixed(1), losingYears: `${yr.filter((x) => x < 0).length}/${yr.length}`, worstMonthPct: +(100 * Math.min(...monthly)).toFixed(2) }; }
  const corr = (() => { const a = rows.map((r) => r.tre), b = rows.map((r) => r.usd), ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0; a.forEach((v, i) => { c += (v - ma) * (b[i] - mb); va += (v - ma) ** 2; vb += (b[i] - mb) ** 2; }); return +(c / Math.sqrt(va * vb)).toFixed(2); })();
  const tOf = (a) => mean(a) / (sd(a) / Math.sqrt(a.length));
  const out = { window: `${rows[0].m}..${rows[rows.length - 1].m}`, months: rows.length, rollGuardDays: guard, znBetaOnIEF: +beta.toFixed(2), corrTreasuryVsDollar: corr,
    perTrade: { treasury: { meanBps: +(1e4 * mean(rows.map((r) => r.tre))).toFixed(1), t: +tOf(rows.map((r) => r.tre)).toFixed(2), t2003_15: +tOf(rows.filter((r) => r.m < "2016").map((r) => r.tre)).toFixed(2), t2016_26: +tOf(rows.filter((r) => r.m >= "2016").map((r) => r.tre)).toFixed(2) },
                dollarBasket: { meanBps: +(1e4 * mean(rows.map((r) => r.usd))).toFixed(1), t: +tOf(rows.map((r) => r.usd)).toFixed(2), t2003_15: +tOf(rows.filter((r) => r.m < "2016").map((r) => r.usd)).toFixed(2), t2016_26: +tOf(rows.filter((r) => r.m >= "2016").map((r) => r.usd)).toFixed(2) } },
    books: {} };
  for (const [name, Lt, Lu] of [["T-bills only", 0, 0], ["Treasury 2x", 2, 0], ["Treasury 3x", 3, 0], ["Treasury 4x", 4, 0], ["Treasury 5x", 5, 0], ["Treasury 7x", 7, 0], ["Dollar 5x only (artifact check)", 0, 5]]) out.books[name] = { all: book(Lt, Lu), "2016-2026": book(Lt, Lu, "2016-01") };
  writeJsonAtomic(path.join(__dirname, "data", "futures-month-end.json"), { ranAt: new Date().toISOString(), exploratory: true, out, rowsOut: rows.map((r) => ({ m: r.m, tb: r.tb, tre: r.tre })) });
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error("FAILED:", e.stack); process.exit(1); });
