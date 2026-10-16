#!/usr/bin/env node
/**
 * ONE-TIME: RETIRE THE 13 LEGACY MODEL-PRICED OPTION SPREADS (D37).
 *
 * These positions were constructed on the modeled chain — Black-Scholes debits at a hardcoded
 * 28% vol, strikes nobody verified as listed — so no future mark of them can ever be a market
 * number. Letting them run another month would feed 13 more unverifiable settles into the
 * ledger. They are settled TODAY at one final model mark (the same ruler that has marked them
 * all along, flat 8%/side friction), and:
 *
 *   · tagged  ctrl:true + d37Retire:true + reason:"d37-retire"  — ctrl keeps them out of every
 *     signal statistic that exists, with zero changes anywhere else; d37Retire lets any audit
 *     find them; the reason string says why in the row itself.
 *   · tombstoned — ids appended to board_tombstones.json so the client/server position sync
 *     can never resurrect them (the exact zombie class task #16 was about).
 *   · backed up — both files copied before a byte changes.
 *
 * Their P&L is recorded but EXCLUDED from adjudication, like the 6 model-marked settles before
 * them. The options class restarts from zero on real chains only.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const POS = D("board_positions.json"), LOG = D("trade_log.json"), TOMB = D("board_tombstones.json");

// Black-Scholes — the same pricing these positions have always been marked with.
const ncdf = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const bs = (S, K, T, r, sg, type) => { const d1 = (Math.log(S / K) + (r + sg * sg / 2) * T) / (sg * Math.sqrt(T)); const d2 = d1 - sg * Math.sqrt(T);
  return type === "call" ? S * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2) : K * Math.exp(-r * T) * ncdf(-d2) - S * ncdf(-d1); };
const FRICTION = 0.08;

(async () => {
  console.log(`\n  D37 RETIRE — settling the legacy model-priced option book\n`);
  const positions = JSON.parse(fs.readFileSync(POS, "utf8"));
  const arr = Array.isArray(positions) ? positions : positions.positions || [];
  const opts = arr.filter(p => p && p.cls === "Options" && !p.optReal);
  if (!opts.length) { console.log("  nothing to retire — no legacy option positions found\n"); return; }

  // live underlyings for the final mark
  const syms = [...new Set(opts.map(p => p.sym))];
  const sr = await fetch(`http://localhost:3001/api/equities/snapshot?symbols=${syms.join(",")}`, { signal: AbortSignal.timeout(60000) });
  const sj = await sr.json(); const PX = sj.data || sj;

  // backups first, before a byte changes
  const stamp = new Date().toISOString().slice(0, 10);
  fs.copyFileSync(POS, D(`board_positions.pre-d37-retire-${stamp}.json`));
  fs.copyFileSync(LOG, D(`trade_log.pre-d37-retire-${stamp}.json`));

  const log = JSON.parse(fs.readFileSync(LOG, "utf8"));
  const tombs = JSON.parse(fs.readFileSync(TOMB, "utf8"));
  const now = Date.now();
  let totalPnl = 0;

  for (const p of opts) {
    const under = PX[p.sym]?.price;
    let exitNet = 0, note = "no live underlying — expired worthless at the model's floor";
    if (under > 0) {
      const daysHeld = (now - p.addedAt) / 864e5;
      const T = Math.max(0.5 / 365, (p.optDte - daysHeld) / 365);
      const type = p.optCall ? "call" : "put";
      let v = Math.max(0, bs(under, p.optAtm, T, 0.045, p.optSigma, type) - bs(under, p.optK2, T, 0.045, p.optSigma, type));
      exitNet = +(v * (1 - FRICTION)).toFixed(2);
      note = "final model mark (BS σ=" + p.optSigma + ", 8%/side friction) — the ruler it always had";
    }
    const entryNet = +(p.debit * (1 + FRICTION)).toFixed(2);
    const pnl = +(((exitNet - entryNet) * 100 * (p.contracts || 1))).toFixed(2);
    const risk = p.riskDollars || Math.abs(entryNet * 100 * (p.contracts || 1)) || 1;
    totalPnl += pnl;
    log.push({
      id: p.id, sym: p.sym, cls: "Options", dir: p.dir, entry: p.debit, exit: exitNet,
      stopDist: Math.max(0.01, p.debit), rMult: +(pnl / risk).toFixed(3), pnl,
      reason: "d37-retire", d37Retire: true, ctrl: true,
      retireNote: note, openedAt: p.addedAt, closedAt: now,
      conf: p.conf ?? null, strategy: p.strategy || "Options", obs: p.obs || null,
      units: p.contracts || 1, dollarPerPoint: 100 * (p.contracts || 1),
    });
    tombs.push({ id: p.id, ts: now });
    console.log(`  retired ${String(p.sym).padEnd(6)} ${p.optCall ? "CALL" : "PUT "} spread · debit $${(+p.debit).toFixed(2)} → mark $${exitNet} · P&L ${pnl >= 0 ? "+" : ""}$${pnl}`);
  }

  const remaining = arr.filter(p => !(p && p.cls === "Options" && !p.optReal));
  fs.writeFileSync(POS, JSON.stringify(Array.isArray(positions) ? remaining : { ...positions, positions: remaining }, null, 1));
  fs.writeFileSync(LOG, JSON.stringify(log));
  fs.writeFileSync(TOMB, JSON.stringify(tombs));
  console.log(`\n  ${opts.length} spreads settled · book P&L ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(0)} (model-marked, ctrl-tagged, EXCLUDED from adjudication)`);
  console.log(`  positions store: ${arr.length} → ${remaining.length} · tombstones: +${opts.length}`);
  console.log(`  backups: board_positions.pre-d37-retire-${stamp}.json · trade_log.pre-d37-retire-${stamp}.json\n`);
})();
