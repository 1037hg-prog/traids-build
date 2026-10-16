#!/usr/bin/env node
/**
 * Builds TRAIDS_Autopilot_Portfolios.html — every Autopilot pilot with makeup (weights),
 * performance, and drawdown, computed from public data. Rerunnable any time; reads the
 * cohort + eval state and prices everything fresh.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const YAHOO = "http://localhost:3002/api/yahoo";
const co = JSON.parse(fs.readFileSync(D("autopilot-cohort.json"), "utf8"));
const ev = JSON.parse(fs.readFileSync(D("autopilot-eval.json"), "utf8"));

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const G = "#34D399", R = "#F87171", A = "#FBBF24", M = "#94A3B8", Dim = "#64748B";
const CLS = { A: "filings-derived (Class A)", B: "theme proxy (Class B)", C: "claims-only (Class C)" };
const CLSCOL = { A: G, B: A, C: R };

async function series(t) {
  try { const r = await fetch(`${YAHOO}/${encodeURIComponent(t)}/history?days=1150&interval=1d`, { signal: AbortSignal.timeout(45000) });
    const b = ((await r.json()).bars || []).filter(x => x.close > 0);
    return b.length > 250 ? b : null; } catch { return null; }
}
function basketStats(bars) {   // bars: map ticker -> array; equal-weight daily NAV
  const tks = Object.keys(bars).filter(t => bars[t]);
  if (!tks.length) return null;
  let dates = bars[tks[0]].map(b => b.date);
  const maps = {}; for (const t of tks) { maps[t] = {}; for (const b of bars[t]) maps[t][b.date] = b.close; }
  dates = dates.filter(d => tks.every(t => maps[t][d]));
  if (dates.length < 250) return null;
  const nav = dates.map(d => tks.reduce((s, t) => s + maps[t][d] / maps[t][dates[0]], 0) / tks.length);
  const yrs = (new Date(dates[dates.length - 1]) - new Date(dates[0])) / (365.25 * 864e5);
  const cagr = Math.pow(nav[nav.length - 1], 1 / yrs) - 1;
  let peak = 0, maxDD = 0; for (const v of nav) { if (v > peak) peak = v; maxDD = Math.max(maxDD, 1 - v / peak); }
  const i1y = dates.findIndex(d => new Date(dates[dates.length - 1]) - new Date(d) <= 366 * 864e5);
  const r1y = i1y > 0 ? nav[nav.length - 1] / nav[i1y] - 1 : null;
  const per = {}; for (const t of tks) { const ds = dates; per[t] = maps[t][ds[ds.length - 1]] / maps[t][ds[0]]; }
  return { from: dates[0], to: dates[dates.length - 1], yrs, cagr, maxDD, r1y, per, n: tks.length };
}

const claims = {}; for (const c of co.claims) claims[c.key] = c;
const evByPilot = {}; for (const f of ev.funds || []) evByPilot[f.pilot] = f;

// per-pilot narrative + which eval fund maps to it
const NARR = {
  pelosi: { evKey: null, what: "Mirrors Nancy Pelosi's Periodic Transaction Reports — public filings the STOCK Act allows up to 45 DAYS late. Her documented book is concentrated mega-cap tech, heavily via long-dated deep-ITM call options, which a share-copier approximates badly.", verdict: "Mega-cap AI beta plus a lag tax, sold as political clairvoyance." },
  ww3: { evKey: null, what: "\"Dr. Lira's AI Finance Labs\" defense/AI theme basket. ZERO holdings, methodology, or fees disclosed. Only publicly known position: CACI International — from a promo tweet that misspelled its own ticker ($CCAI). Three mutually inconsistent public claims: +206.6% all-time, +142.2% one-week, +219% since inception (no dates on any).", verdict: "Unauditable numbers over a secret book in the year's hottest theme. Our basket below is the FREE beta its claims must beat to mean anything." },
  simons: { evKey: "Jim Simons Tracker", what: "Clones RenTec's quarterly 13F. RenTec's real edge (Medallion) is short-horizon with shorts — a 45-day-stale long-book snapshot is structurally unrelated to what made Simons famous.", verdict: "Their +117% all-time claim vs +591% for the free hindsight basket of its own four famous holdings: the product captured ~1/5 of its own poster's beta." },
  point72: { evKey: "Point 72", what: "Clones Point72's 13F longs. Point72 is a market-neutral multi-manager — its shorts and hedges are invisible in 13Fs, so the copy carries completely different risk than the fund.", verdict: "Half a hedge fund is not a hedge — it is unhedged." },
  burry: { evKey: "Burry Tracker", what: "Clones Scion's 13F. Latest filing: FOUR names, 95% of value in OPTIONS — reported as share-equivalents no copier can replicate.", verdict: "The least cloneable famous investor in America, sold as a one-click clone." },
  invcramer: { evKey: null, what: "Shorts/inverts Jim Cramer's TV picks. No public call feed exists. The strategy's one audited real-money incarnation — the SJIM ETF — ran Mar 2023-Feb 2024, lost ~15% while SPY gained ~30%, and liquidated.", verdict: "A meme with $105M in it whose only audited ancestor is dead." },
  calacanis: { evKey: null, what: "Follows Jason Calacanis's picks. No structured public record exists.", verdict: "Unverifiable — claims archived nightly." },
  mullin: { evKey: null, what: "Mirrors Sen. Markwayne Mullin's PTR filings (same 45-day lag as Pelosi).", verdict: "Upgradeable to Class A with a Senate-disclosure collector; low priority at $1.8M." },
  wolff1: { evKey: null, what: "Creator portfolio (Peter Wolff). No public trade record.", verdict: "$175M following a book nobody outside the app can inspect." },
  wolff2: { evKey: null, what: "Creator portfolio (Peter Wolff, concentrated top-15). No public record.", verdict: "Unverifiable — claims archived nightly." },
  aileaders: { evKey: null, what: "Stock picks by Brooker Belcourt (ex-Citadel). Picks undisclosed publicly; the proxy below is the free AI mega-cap beta any picker in this theme must beat to be adding anything.", verdict: "An ex-Citadel resume vs a basket anyone can hold for free - the forward NAV race starts today." },
  whitehouse: { evKey: null, what: "Unusual Whales aggregate tracker of Congressional trading (all members, PTR filings, 45-day lag).", verdict: "Upgradeable to Class A with a congressional-disclosure collector - same machinery as Pelosi." },
  trump: { evKey: null, what: "Tracks Donald Trump's disclosed assets. Presidential disclosures are ANNUAL (OGE Form 278), not 45-day PTRs - a copy can lag the reality by a full year.", verdict: "The stalest disclosure basis of any pilot on the platform." },
  itm: { evKey: null, what: "Creator portfolio (InTheMoney, YouTube). No public record.", verdict: "$158M, unverifiable — claims archived nightly." },
};
const ORDER = ["pelosi", "ww3", "invcramer", "simons", "point72", "burry", "aileaders", "whitehouse", "trump", "itm", "wolff1", "wolff2", "calacanis", "mullin"];
const ONELINE = { aileaders: "undisclosed picks vs free AI-megacap beta", whitehouse: "all-Congress PTRs; upgradeable to Class A", trump: "annual disclosure lag - copies up to a year stale",  pelosi: "mega-cap AI beta + 45-day lag", ww3: "three conflicting claims over a secret book", invcramer: "only audited ancestor (SJIM) died in a year", simons: "captured ~1/5 of its own poster-names' beta", point72: "the hedged fund, minus the hedges", burry: "95% of the real book is uncloneable options", itm: "$158M, no public record", wolff1: "$175M, no public record", wolff2: "no public record", calacanis: "no public record", mullin: "buildable from Senate PTRs; tiny" };

(async () => {
  const spyStats = basketStats({ SPY: await series("SPY") });

  let h = `<meta charset="utf-8"><title>Autopilot — Every Portfolio, With Details</title>
<body style="background:#0B0C10;color:#E2E8F0;font-family:ui-monospace,monospace;padding:28px;max-width:1060px;line-height:1.55">
<h1 style="color:#A78BFA;margin-bottom:4px">Autopilot — every portfolio: makeup, performance, drawdown</h1>
<div style="color:${Dim};font-size:12px">TRAIDS truth cohort A1 · generated ${new Date().toISOString().slice(0, 10)} · claims scraped live ${co.claims[0]?.date} · ~$1.2B subscriber money across the 11 tracked pilots</div>

<div style="background:#1a1420;border:1px solid ${A};border-radius:8px;padding:14px;margin:16px 0;color:#FDE68A">
<b>Three findings that frame everything.</b><br>
1 · Every number on their site is "<b>all time</b>" — no inception date, no benchmark, no drawdown, ever.<br>
2 · The one pilot-style clone that reconstructs cleanly from filings (Berkshire: 8 quarters, 9-10/10 names) <b>lost to SPY by 18.6 points over two years</b> at the only entries a copier can get. That is the measured price of the 45-day lag.<br>
3 · Every reconstructable basket runs <b>~2× SPY's drawdown</b> — and the window below contains no 2022-style bear, where these names historically fell 50-84%.</div>

<h2>The lineup</h2>
<table style="border-collapse:collapse;font-size:12.5px;width:100%">
<tr style="color:${Dim};text-align:left"><th style="padding:5px 10px">pilot</th><th>claimed</th><th>invested</th><th>class</th><th>one-line reality</th></tr>`;
  for (const k of ORDER) {
    const p = co.pilots[k]; const c = claims[k] || {};
    h += `<tr style="border-top:1px solid #1E293B"><td style="padding:5px 10px;font-weight:700">${esc(p?.name || k)}</td><td>${c.claimPct != null ? c.claimPct + "% <span style='color:" + Dim + "'>(" + esc(c.claimPeriod || "?") + ", no date)</span>" : "—"}</td><td>$${c.investedM ?? "?"}M</td><td style="color:${CLSCOL[p?.cls || "C"]}">${p?.cls || "C"}</td><td style="color:${M}">${esc(ONELINE[k])}</td></tr>`;
  }
  h += `</table>`;

  for (const k of ORDER) {
    const p = co.pilots[k]; const n = NARR[k]; const c = claims[k] || {};
    h += `<h2 style="margin-top:30px">${esc(p?.name || k)} <span style="font-size:13px;color:${CLSCOL[p?.cls || "C"]}">${CLS[p?.cls || "C"]}</span></h2>
<div style="color:${M};margin-bottom:8px">${esc(n.what)}</div>
<div style="color:${Dim};font-size:12px;margin-bottom:8px">their claim: <b style="color:#E2E8F0">${c.claimPct != null ? c.claimPct + "% " + esc(c.claimPeriod || "") : "n/a"}</b> · currently invested: <b style="color:#E2E8F0">$${c.investedM ?? "?"}M</b></div>`;

    const book = p?.book?.tickers || [];
    if (book.length) {
      const bars = {}; for (const t of book) bars[t] = await series(t);
      const st = basketStats(bars);
      // makeup weights: 13F value weights where the eval captured them, else equal weight
      const evF = n.evKey ? evByPilot[n.evKey] : null;
      const valW = {};
      if (evF?.current?.top) { const tot = evF.current.top.filter(x => x.ticker).reduce((s, x) => s + x["valUsd$k"], 0); for (const x of evF.current.top) if (x.ticker) valW[x.ticker] = 100 * x["valUsd$k"] / tot; }
      h += `<table style="border-collapse:collapse;font-size:12px;margin-bottom:8px"><tr style="color:${Dim};text-align:left"><th style="padding:3px 10px">makeup</th><th>weight</th><th>3y multiple</th></tr>`;
      for (const t of book) {
        const w = valW[t] != null ? valW[t].toFixed(1) + "% (13F value)" : (100 / book.length).toFixed(1) + "% (equal)";
        const mult = st?.per?.[t] ? st.per[t].toFixed(2) + "×" : "—";
        h += `<tr style="border-top:1px solid #1E293B"><td style="padding:3px 10px;font-weight:700">${t}</td><td>${w}</td><td style="color:${st?.per?.[t] >= 1 ? G : R}">${mult}</td></tr>`;
      }
      if (p.book.unmatched?.length) h += `<tr style="border-top:1px solid #1E293B"><td colspan="3" style="padding:3px 10px;color:${A}">+ ${p.book.unmatched.length} unmatched names (coverage stated, never hidden): ${esc(p.book.unmatched.join(", ").slice(0, 120))}</td></tr>`;
      h += `</table>`;
      if (st) h += `<div style="font-size:12.5px;margin-bottom:6px">basket performance ${st.from} → ${st.to} (${st.yrs.toFixed(1)}y): CAGR <b style="color:${G}">+${(100 * st.cagr).toFixed(1)}%/yr</b> · 1y <b style="color:${st.r1y >= 0 ? G : R}">${st.r1y != null ? (st.r1y >= 0 ? "+" : "") + (100 * st.r1y).toFixed(1) + "%" : "—"}</b> · max drawdown <b style="color:${R}">−${(100 * st.maxDD).toFixed(0)}%</b>${spyStats ? ` · SPY same era: +${(100 * spyStats.cagr).toFixed(1)}%/yr, −${(100 * spyStats.maxDD).toFixed(0)}% DD` : ""}
<div style="color:${Dim};font-size:11px">⚠ survivorship-by-construction: this is TODAY'S known book held backward — an upper bound, not expectancy. Forward proxy NAV baselined 100 on ${co.registered}.</div></div>`;
    } else {
      h += `<div style="color:${R};font-size:12.5px;margin-bottom:6px">No public book exists — makeup, performance and drawdown are UNKNOWABLE from outside the app. The claims archive is the dataset for this pilot.</div>`;
    }
    // lag-adjusted historical clone where the eval produced one
    const evF = n.evKey ? evByPilot[n.evKey] : null;
    if (evF) h += `<div style="font-size:12.5px;color:${M}">lag-adjusted historical clone (bought at first close after each 13F): <b style="color:${evF.cloneRet >= 0 ? G : R}">${evF.cloneRet >= 0 ? "+" : ""}${evF.cloneRet}%</b> vs SPY ${evF.spyRet >= 0 ? "+" : ""}${evF.spyRet}% over ${evF.quarters} quarters — coverage-biased where match rates were low (max ${evF.maxUnmatchedNames}/10 unmatched)${evF.optionShareMaxPct > 20 ? `; options up to ${evF.optionShareMaxPct}% of book excluded` : ""}.</div>`;
    h += `<div style="color:${A};font-weight:700;font-size:12.5px;margin-top:6px">Verdict: ${esc(n.verdict)}</div>`;
  }

  h += `<h2 style="margin-top:30px">What runs from here (nightly, automatic)</h2>
<div style="color:${M}">Forward proxy NAVs (baselined ${co.registered}) · claims re-scraped and archived every close — numbers that drift between surfaces get caught · 13F books auto-refresh each filing season · quarterly lag-adjusted clone re-runs. Not yet catalogued: White House Asset Management (Unusual Whales), AI Leaders, Trump portfolio, Quiver Quantitative and ~10 more — same classes, same treatment, when added.</div>
<div style="color:${Dim};font-size:11px;margin-top:16px">Method: 13F holdings from EDGAR (top-10 longs, first close AFTER filing date); PTR books from congressional disclosures; prices = daily closes; claims scraped from their rendered pages via headless browser (their raw HTML contains no performance numbers — they are assembled client-side, which is itself worth knowing). Nothing here is from Autopilot's marketing except where labeled "their claim."</div></body>`;

  fs.writeFileSync(path.join(__dirname, "..", "TRAIDS_Autopilot_Portfolios.html"), h);
  console.log("written: TRAIDS_Autopilot_Portfolios.html (" + h.length + " bytes)");
})();
