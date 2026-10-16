#!/usr/bin/env node
/**
 * levers.cjs — READ-ONLY inventory of TRAIDS's automatic risk levers as of now (Dalio "plan" lens, 2026-10-07).
 * Reads local files under backend/ plus one GET to the local :3001 server. Writes nothing. Prints every input it uses.
 *   node levers.cjs
 */
const fs = require("fs"), path = require("path");
const B = "C:/Users/joshc/Downloads/traids (2)/traids-bundle/backend";
const D = (f) => path.join(B, "data", f);
const rd = (f) => JSON.parse(fs.readFileSync(D(f), "utf8"));
const mt = (f) => { try { return fs.statSync(D(f)).mtime.toISOString(); } catch { return null; } };
const et = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const TODAY = et(Date.now());
const line = (s = "") => console.log(s);

(async () => {
  line(`LEVERS INVENTORY — run ${new Date().toISOString()} (ET date ${TODAY})`);

  // 1. switch files
  line(`\n[1] SWITCH FILES in backend/data (presence = set)`);
  const SW = ["alpaca-mirror-OFF", "book-etf-OFF", "r191-OFF", "r231-OFF", "r24-mirror-OFF", "r309-OFF", "r309-HALT", "tasty-zn-OFF", "tasty-zn-LIVE-ARMED", "r219-OFF", "r186-OFF", "r218-OFF", "r160-OFF", "r283-OFF", "r295-OFF", "r316-OFF", "r316-HALT", "r151-OFF", "r236-OFF", "payne-picks-OFF", "entry-ml-OFF", "alpaca-mark-bridge-OFF", "mnq-quote-paper-OFF"];
  for (const s of SW) { const m = mt(s); line(`  ${s.padEnd(24)} ${m ? "SET since " + m : "absent"}${m && fs.statSync(D(s)).size ? "  text: " + fs.readFileSync(D(s), "utf8").trim().slice(0, 110) : ""}`); }

  // 2. risk policy (file) vs running server
  const { RISK_POLICY: P, aggregate } = require(path.join(B, "lib/risk-policy.js"));
  line(`\n[2] RISK POLICY file backend/lib/risk-policy.js`);
  line(`  version ${P.version} · breakerMode ${P.breakerMode} · dailyLossHaltDollars ${P.dailyLossHaltDollars} · worstCaseOpenCapPct ${P.worstCaseOpenCapPct} (ceiling $${P.account * P.worstCaseOpenCapPct / 100}) · capR ${P.capR} · baseRiskPct ${P.baseRiskPct}`);
  line(`  boardClassesOff ${JSON.stringify(P.boardClassesOff)} · boardStrategiesOff ${JSON.stringify(P.boardStrategiesOff)} · haltsAlterExits ${P.haltsAlterExits} · r21ShadowAll ${P.optionsSleeves.r21ShadowAll} · r51 shadowAll ${P.r51Sleeve.shadowAll}`);
  try {
    const r = await fetch("http://localhost:3001/api/risk-policy", { signal: AbortSignal.timeout(8000) }); const j = await r.json(); const p = j.policy || j;
    line(`  RUNNING :3001 reports version ${p.version} · breakerMode ${p.breakerMode} · boardClassesOff ${JSON.stringify(p.boardClassesOff)} · boardStrategiesOff ${JSON.stringify(p.boardStrategiesOff)} · breakerBasis ${p.breakerBasis ? "present" : "absent"}`);
  } catch (e) { line(`  RUNNING :3001 — unreachable (${e.message})`); }

  // 3. circuit breaker
  const cb = rd("circuit-breaker.json");
  line(`\n[3] CIRCUIT BREAKER data/circuit-breaker.json (mtime ${mt("circuit-breaker.json")})`);
  line(`  date ${cb.date} · mode ${cb.mode} · halted ${cb.halted} · refusedToday ${cb.refusedToday} · wouldRefuseToday ${cb.wouldRefuseToday}`);
  const ev = cb.events || []; const wh = ev.filter((e) => e.type === "WOULD-HALT"); const realHalt = ev.filter((e) => e.type === "HALT");
  const byMonth = {}; for (const e of wh) { const m = e.at.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1; }
  line(`  events ${ev.length} (first ${ev[0] && ev[0].at.slice(0, 10)}): WOULD-HALT ${wh.length} by month ${JSON.stringify(byMonth)}; enforced HALT rows ${realHalt.length} (all ${realHalt.map((e) => e.at.slice(0, 10)).join(",")})`);
  const byReason = { exposure: wh.filter((e) => /exposure/.test(e.reason)).length, realized: wh.filter((e) => /realized day/.test(e.reason)).length };
  line(`  WOULD-HALT by reason: exposure-ceiling ${byReason.exposure} · realized-loss ${byReason.realized}`);
  for (const d of cb.days || []) line(`  day ${d.date}: halted ${d.halted} · reason ${d.reason || "-"} · refused ${d.refused} · wouldRefuse ${d.wouldRefuse}`);

  // 4. today's board: what the automatic entry gates did
  const pos = rd("board_positions.json"); const today = pos.filter((p) => p && p.addedAt && et(p.addedAt) === TODAY);
  const veto = today.filter((p) => p.vetoShadow), ctrl = today.filter((p) => p.ctrl && !p.vetoShadow), sig = today.filter((p) => !p.ctrl && !p.vetoShadow);
  const vc = {}; for (const p of veto) { const k = String(p.veto || "?").split(/\s/)[0]; vc[k] = (vc[k] || 0) + 1; }
  line(`\n[4] BOARD ${TODAY} (data/board_positions.json, ${pos.length} open rows): added today ${today.length} = signals ${sig.length} · controls ${ctrl.length} · veto shadows ${veto.length}`);
  line(`  veto shadows by first token: ${JSON.stringify(vc)}`);
  const r35 = veto.find((p) => /^R35/.test(p.veto || "")); if (r35) line(`  example R35: "${r35.veto}"`);
  const sDir = (d) => sig.filter((p) => p.dir === d); const sum = (a) => Math.round(a.reduce((s, p) => s + (Number(p.riskDollars) || 0), 0));
  line(`  today's live signal tickets: long ${sDir(1).length} ($${sum(sDir(1))} 1R) · short ${sDir(-1).length} ($${sum(sDir(-1))} 1R)`);
  const tl = rd("trade_log.json");
  const agg = aggregate(pos, Array.isArray(tl) ? tl : [], Date.now(), { basis: "signals" });
  line(`  aggregate(signals basis) now: open ${agg.openTickets} · worst-case open (current epoch) $${agg.worstCaseOpenCurrentEpoch} vs ceiling $${agg.exposureCeiling} · realized today $${agg.realizedToday} vs halt -$${P.dailyLossHaltDollars} · net directional $${agg.netDirectional} (long $${agg.long$} / short $${agg.short$}) · would-halt ${agg.breaker.halted}${agg.breaker.reason ? " (" + agg.breaker.reason + ")" : ""}`);

  // 5. regime model + the client gates keyed on it
  const rm = rd("regime-model.json"), t = rm.today, th = t.thresholds;
  line(`\n[5] REGIME MODEL data/regime-model.json (mtime ${mt("regime-model.json")}): ${t.date} regime ${t.regimeId} "${t.label}"`);
  line(`  breadth50 ${t.features.breadth50} vs R35 threshold P25 ${th.breadth50P25} -> R35 (no equity longs) ${t.features.breadth50 < th.breadth50P25 ? "ACTIVE" : "inactive"}`);
  line(`  rv20 ${t.features.rv20} vs R38 threshold P90 ${th.rv20P90} -> R38 (no entries at all) ${t.features.rv20 > th.rv20P90 ? "ACTIVE" : "inactive"} · rv20 needs +${(th.rv20P90 - t.features.rv20).toFixed(2)} vol pts to trip`);
  line(`  window ${rm.window.from}..${rm.window.to} (${rm.window.sessions} sessions) — thresholds are percentiles of THIS window (refit nightly)`);

  // 6. bear gauge
  const bg = rd("bear-gauge.json"), bgl = rd("bear-gauge-live.json");
  line(`\n[6] BEAR GAUGE nightly data/bear-gauge.json ${bg.asOf}: score ${bg.score} ${JSON.stringify(bg.components)} · policy "${bg.policy}"`);
  line(`  live (forming bar) ${bgl.asOf} ${bgl.etTime} ET: score ${bgl.score} ${JSON.stringify(bgl.components)} · inputs vix ${bgl.inputs.vix} breadthSpread ${bgl.inputs.breadthSpread} creditSpread20 ${bgl.inputs.creditSpread20}`);
  line(`  backtest (score -> SPX next 63 sessions, its own table): ${Object.entries(bg.backtest).map(([k, v]) => `${k}: n ${v.n} median ${v.medianFwd3mo}% mean ${v.meanFwd3mo}%`).join(" | ")}`);

  // 7. risk manager (shadow)
  const rmg = rd("risk-manager.json");
  line(`\n[7] RISK MANAGER data/risk-manager.json ${rmg.asOf} mode "${rmg.mode}"`);
  line(`  today ${JSON.stringify(rmg.today)}`);
  line(`  rules dd1 ${rmg.rules.dd1} -> x${rmg.rules.dd1s}; dd2 ${rmg.rules.dd2} -> x${rmg.rules.dd2s}; reset above ${rmg.rules.ddReset}; volTarget ${rmg.rules.volTarget} clamp [${rmg.rules.volMin}, ${rmg.rules.volMax}]`);
  line(`  risk share 60d ${JSON.stringify(rmg.riskShare60d)} · alerts ${JSON.stringify(rmg.alerts)}`);
  const fw = fs.readFileSync(D("risk-manager-forward.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
  line(`  forward rows ${fw.length} (${fw[0].d}..${fw[fw.length - 1].d}); rows with wouldDo < 1: ${fw.filter((r) => r.wouldDo < 0.999).length}`);

  // 8. Plan E ETF book (paper, BOOK account)
  const bk = rd("book-etf-state.json"); const nav = bk.navHistory[bk.navHistory.length - 1];
  line(`\n[8] PLAN E ETF BOOK data/book-etf-state.json: signals as of ${bk.signalsAsOf} · NAV $${nav.nav} (${nav.date}) · pending ${bk.pending.length}`);
  for (const [k, v] of Object.entries(bk.signals)) if (v.close) line(`  ${k.padEnd(5)} ${v.on ? "IN " : "OUT"} month-end close ${v.close} vs 10-mo avg ${v.avg ?? v.avg10} -> ${(100 * (v.close / (v.avg ?? v.avg10) - 1)).toFixed(1)}%`);
  const lastRuns = Object.entries(bk.runs).slice(-3).map(([d, r]) => `${d} orders ${r.orders.length} off ${r.off}`); line(`  last runs: ${lastRuns.join(" · ")}`);

  // 9. crypto sleeves state (R191 / R231) — signal lines only
  for (const f of ["r191-crypto-trend.json", "r231-crypto-vote-sized.json"]) {
    try { const s = rd(f); line(`\n[9] ${f} (mtime ${mt(f)}) keys ${Object.keys(s).slice(0, 12).join(",")}`);
      const st = s.state || s.positions || s.holdings || null; if (st) line(`  state ${JSON.stringify(st).slice(0, 300)}`);
      if (s.lastDecision || s.last) line(`  last ${JSON.stringify(s.lastDecision || s.last).slice(0, 300)}`);
    } catch (e) { line(`\n[9] ${f}: ${e.message}`); }
  }

  // 10. live-money lane: tasty ZN
  const tz = rd("tasty-zn-state.json"), r219 = rd("r219-zn-month-end.json");
  line(`\n[10] TASTY ZN data/tasty-zn-state.json: production windows ${Object.keys(tz.envs.production.windows).length} · sandbox windows ${Object.keys(tz.envs.sandbox.windows).length} · asOf ${tz.asOf}`);
  line(`  R219 next window ${JSON.stringify(r219.windows[Object.keys(r219.windows).sort().pop()])}`);
  line(`  LIVE-ARMED ${fs.existsSync(D("tasty-zn-LIVE-ARMED")) ? "SET" : "absent"} · OFF ${fs.existsSync(D("tasty-zn-OFF")) ? "SET" : "absent"}`);
})().catch((e) => { console.error("levers FAILED:", e.stack); process.exit(1); });
