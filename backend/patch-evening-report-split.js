#!/usr/bin/env node
/**
 * 2026-09-21 (operator asked whether the +1.44R vetoed crypto tickets were "in the record as we traded it"). They are not traded: they are
 * shadow rows (ctrl:true, vetoShadow:true). But the evening email pooled them with the random controls under "control", and its "book $"
 * summed signals + random controls + vetoed shadows, so it read like money the book made. Display-only fix: vetoed shadows get their own
 * line, "control" means random controls only, and the dollar line says which figure is money. FD1 (sealed 2026-09-02) is untouched.
 */
const fs = require("fs"), path = require("path"); const f = path.join(__dirname, "evening-report.js"); let s = fs.readFileSync(f, "utf8");
if (s.includes("ctlVeto")) { console.log("already patched"); process.exit(0); }
const rep = (a, b) => { const n = s.split(a).length - 1; if (n !== 1) { console.error(`anchor found ${n}x:`, a.slice(0, 60)); process.exit(2); } s = s.replace(a, () => b); };
fs.copyFileSync(f, f + ".pre-split-2026-09-21.bak");
rep("sig = all.filter((r) => !r.ctrl); ctl = all.filter((r) => r.ctrl);",
    "sig = all.filter((r) => !r.ctrl); ctl = all.filter((r) => r.ctrl && !r.vetoShadow); const ctlVeto = all.filter((r) => r.ctrl && r.vetoShadow);   // 2026-09-21: vetoed real signals are shadows, NOT controls");
rep("control ${sgn(", "random control ${sgn(");
rep("R (n ${ctl.length})", "R (n ${ctl.length})${ctlVeto.length ? `\\nvetoed signals, NOT traded (shadow) ${sgn(mean(ctlVeto.map((r) => r.rMult)))}${mean(ctlVeto.map((r) => r.rMult)).toFixed(4)}R (n ${ctlVeto.length})` : ''}");
rep("GAP ${sgn(g)}", "GAP vs random ${sgn(g)}");
rep("pnlAll = Math.round([...sig, ...ctl].reduce(", "pnlAll = Math.round([...sig, ...ctl, ...ctlVeto].reduce(");
rep("`settled ${sig.length + ctl.length} · signal $${pnlSig} · book $${pnlAll}`", "`settled ${sig.length + ctl.length + ctlVeto.length} · signals traded $${pnlSig} · incl. controls + shadows (not money) $${pnlAll}`");
fs.writeFileSync(f + ".tmp", s); fs.renameSync(f + ".tmp", f); console.log("evening-report.js patched");
