#!/usr/bin/env node
/** Registers R270 — the book risk manager, SHADOW, forward (operator 2026-09-26: "build the risk manager"). Rules fixed in
 *  backend/risk-manager.js before its preview was computed; the preview (weightless) is disclosed below. Refuses if R270 exists. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const { nullBar } = require("./lib/null-bar.js");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8"));
if ([...(reg.tests || []), ...(reg.preregistered || [])].some((t) => t.id === "R270")) { console.error("R270 exists — refusing"); process.exit(2); }
const BAR = +nullBar({ variants: 1, n: 12, trials: 20000 }).p95.toFixed(3);
reg.preregistered.push({
  id: "R270", name: "Book risk manager (shadow) — does volatility targeting + a drawdown brake improve the Plan E book's risk-adjusted return forward?",
  registered: "2026-09-26", evidenceStart: "2026-09-28", status: "REGISTERED 2026-09-26 — shadow; writer wired (backend/risk-manager.js in the close chain)", script: "backend/risk-manager.js",
  parent: "Operator 2026-09-26. Plan E book (ZN 4.2x month-end + QQQ/SPY/GLD/EFA 10-month + DBMF + BTC/ETH 50-day + T-bills).",
  multiplicityFamily: "RISK-1 — one rule set, no variants.",
  rule: ["Model book from market prices (see the script header). Would-do scale = min(vol scale, drawdown scale), decided at day t's close, applied to day t+1: vol scale = clamp(0.15 / vol60, 0.5, 1.25); drawdown scale 1 -> 0.75 at <= -8% -> 0.5 at <= -12%, reset to 1 above -4%. Managed return = scale x risky legs + cash leg + (1 - scale) x invested weight x T-bill."],
  statistic: "Monthly (managed minus unmanaged) excess return over the T-bill, divided by the unmanaged book's trailing vol... simplified to: monthly difference in Sharpe-normalised return = managed minus unmanaged monthly return; one-sample t over months. Also required for ADOPTION: forward max drawdown of the managed book at least 20% shallower than unmanaged AND managed CAGR no more than 10% (relative) below unmanaged.",
  bar: { fixedInAdvance: true, unit: "months", minMonths: 12, tRequired: BAR, variants: 1, source: `nullBar({variants:1, n:12, trials:20000}).p95 = ${BAR}` },
  controls: { none: "the unmanaged book is the paired control on identical days" },
  interimKill: "none (shadow)", readCondition: "read once after 12 complete months of forward rows (~2027-10)",
  decisionRule: { pass: "Operator decides whether the manager moves from shadow to acting on the legs.", fail: "Stays a monitor (alerts, risk shares) only; no scaling of live legs." },
  expectation: "LOW-MED: the book's legs already carry trend filters; the weightless preview (2019-06..2026-09) showed managed 25.4%/yr vs unmanaged 27.4%, Sharpe 1.69 vs 1.71, max drawdown -11.4% vs -11.9%; 2022 managed -5.9% vs -3.5%.",
  knownWeaknesses: ["ZN leg is a proxy (3.3x IEF on month-end windows), not the futures fills.", "12 months is short for a risk rule — drawdown events may not occur.", "Preview is in-sample and weightless."],
  ip: "ours", writerExists: true,
});
reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
const cr = JSON.parse(fs.readFileSync(D("change-registry.json"), "utf8"));
cr.push({ date: "2026-09-26", area: "R270 book risk manager (shadow) — built and registered", category: "registration", breaksComparability: false, change: `risk-manager.js nightly: model book, vol/drawdown/risk shares/correlations, would-do scale, alerts; forward rows from 2026-09-28; bar ${BAR} at 12 months`, why: "Operator: build the risk manager.", doesNotEstablish: "Anything until the read; changes no position.", operator: "Josh 2026-09-26" });
writeJsonAtomic(D("change-registry.json"), cr);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant on operator instruction", action: "register", tests: ["R270"], detail: `book risk manager shadow, bar ${BAR}` }) + "\n");
console.log(`R270 registered · bar ${BAR}`);
