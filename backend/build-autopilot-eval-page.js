#!/usr/bin/env node
/**
 * TRAIDS_Autopilot_Eval.html — rendered from backend/data/autopilot-eval.json.
 *
 * Added 2026-08-19: the page was previously a one-off (stamped 2026-08-01) with no builder, so
 * "update the docs" meant hand-surgery. Now: run backend/autopilot-eval.js (recomputes the
 * lag-adjusted clones from filings + bars), then this script (renders). Voice and structure
 * preserved from the original, including the coverage-bias warning — which the data keeps
 * re-earning: the cleanly-reconstructed pilot trails SPY while the poorly-matched ones "win".
 */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const j = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "autopilot-eval.json"), "utf8"));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const funds = Object.values(j.funds || {});

const g = (v) => `<b style="color:#34D399">${v}</b>`, r = (v) => `<b style="color:#F87171">${v}</b>`;
const pct = (v) => `${v >= 0 ? "+" : ""}${v}%`;
const col = (v) => v >= 0 ? g(pct(v)) : r(pct(v));

let body = "";
for (const f of funds) {
  const optNote = f.optionShareMaxPct > 5 ? ` · <span style="color:#FBBF24">options up to ${f.optionShareMaxPct}% of book — invisible to any copier</span>` : "";
  body += `<h2 style="color:#E2E8F0;margin-top:28px">${esc(f.fund)} <span style="color:#64748B;font-size:14px">(${esc(f.pilot)})</span></h2>
<p>clone ${col(f.cloneRet)} vs SPY <b>${pct(f.spyRet)}</b> → alpha ${col(f.alpha)} over ${f.quarters} quarters (${esc(f.window)})${optNote}</p>
<table style="border-collapse:collapse;font-size:12.5px;width:100%">
<tr style="color:#64748B;text-align:left"><th style="padding:4px 10px">period</th><th>filed</th><th>held</th><th>matched</th><th>clone</th><th>SPY</th><th>alpha</th><th>book (matched tickers / ?unmatched)</th></tr>`;
  for (const l of f.legs || []) {
    const mCol = l.matched >= 8 ? "#34D399" : "#FBBF24";
    body += `<tr style="border-top:1px solid #1E293B"><td style="padding:4px 10px">${l.period}</td><td>${l.filed}</td><td>${l.from} → ${l.to}</td><td style="color:${mCol}">${l.matched}/10</td><td style="color:${l.cloneQPct >= 0 ? "#34D399" : "#F87171"}">${pct(l.cloneQPct)}</td><td>${pct(l.spyQPct)}</td><td style="color:${l.alphaQPct >= 0 ? "#34D399" : "#F87171"}">${pct(l.alphaQPct)}</td><td style="color:#94A3B8;font-size:11px">${esc(l.names)}</td></tr>`;
  }
  body += `</table>`;
  if (f.current) {
    const top = (f.current.top || []).slice(0, 10).map((t) =>
      t.ticker ? `<span style="color:#E2E8F0">${esc(t.ticker)}</span> ${esc(t.name)}` : `<span style="color:#FBBF24">unmatched</span> ${esc(t.name)}`).join(" · ");
    body += `<p style="color:#94A3B8;margin-top:8px">Current book (filed ${f.current.filed}, period ${f.current.period}; ${f.current.totalNames} names, ${f.current.optSharePct}% options):<br>${top}</p>`;
  }
}

// coverage-bias callout, computed from the data rather than remembered
const clean = funds.filter((f) => f.maxUnmatchedNames <= 2).map((f) => `${esc(f.fund.split(" ")[0])} ${f.alpha >= 0 ? "+" : ""}${f.alpha}`).join(", ");
const dirty = funds.filter((f) => f.maxUnmatchedNames >= 5).map((f) => `${esc(f.fund.split(" ")[0])} ${f.alpha >= 0 ? "+" : ""}${f.alpha} (${f.maxUnmatchedNames}/10 unmatched at worst)`).join(", ");

const html = `<meta charset="utf-8"><title>Autopilot Pilots — Lag-Adjusted Evaluation</title>
<body style="background:#0B0C10;color:#E2E8F0;font-family:ui-monospace,monospace;padding:28px;max-width:1000px">
<h1 style="color:#A78BFA">Autopilot pilots — what the copier actually buys</h1>
<p style="color:#94A3B8;line-height:1.6">Method: ${esc(j.method)}. Reconstruction quality is printed per quarter — <b style="color:#FBBF24">a low match rate means the number describes the famous half of the book, not the fund</b>.</p>
<div style="background:#1a1420;border:1px solid #FBBF24;border-radius:8px;padding:14px;margin:14px 0;color:#FDE68A;line-height:1.6">
<b>Read this first — the coverage-bias signature.</b> The cleanly-reconstructed pilot(s) (${clean || "none"}) trail the index; the pilots showing spectacular "alpha" (${dirty || "none"}) are exactly the ones where half the book failed to match — the resolvable names are NVDA/AMZN/AVGO/TSM-class mega-caps, so those "clones" are accidentally AI-megacap baskets wearing a hedge-fund name. The pattern <i>worse reconstruction → better number</i> is the tell that the flattering figures are artifacts, not alpha.</div>
${body}
<h2 style="color:#F87171;margin-top:28px">Unauditable by construction</h2>
<p style="color:#94A3B8;line-height:1.6">Inverse Cramer · AI World War III · AI Leaders · Calacanis — no public trade record exists for any of these. Their landing-page numbers cannot be checked by anyone, which under this project's rules means they do not exist as evidence. Jim Simons Tracker: RenTec's 13F could not be reconstructed here (huge multi-file filings) — and a 45-day-stale snapshot of the highest-turnover book on earth is structurally noise regardless.</p>
<p style="color:#64748B;font-size:11px;margin-top:20px">Generated ${esc(j.generated)} · TRAIDS · lag-adjusted, coverage-flagged, survivorship noted — the number Autopilot does not publish. Regenerate: node backend/autopilot-eval.js && node backend/build-autopilot-eval-page.js</p></body>`;

fs.writeFileSync(path.join(ROOT, "TRAIDS_Autopilot_Eval.html"), html);
console.log("written: TRAIDS_Autopilot_Eval.html ·", funds.length, "pilots ·", funds.reduce((s, f) => s + (f.legs || []).length, 0), "quarter-legs");
