// R295 v5 — 2026-10-02 (operator: "yes fix it after close"). The 10-01 evidence session double-exited 4 lots (ACN, CTSH, HDB, ALC): right
// after a full fill the OTO stop leg can still read "held", which syncOne did not count as live, so it placed a standalone stop (or a
// through-the-stop market exit) while the leg was about to activate — and both filled. v5: (A) "held" counts as a live leg state;
// (B) a standalone stop or market exit is placed only after the leg is CONFIRMED terminal by a re-read (a leg that filled means the lot is
// already out). Restores the registered execution: exactly one live stop for exactly the filled quantity.
// Usage: node docs/r295/patch-r295-v5.cjs <backend dir> <out file>
const fs = require("fs"), path = require("path");
const BK = process.argv[2], OUTF = process.argv[3]; if (!BK || !OUTF) throw new Error("usage: <backend dir> <out file>");
let s = fs.readFileSync(path.join(BK, "r295-orb-forward.js"), "utf8");
const rep = (a, b, tag) => { const n = s.split(a).length - 1; if (n !== 1) throw new Error(`${tag}: expected 1 match, found ${n}`); s = s.replace(a, () => b); };
rep(`  const LIVE_LEG = ["new", "accepted", "pending_new", "partially_filled", "pending_replace", "replaced"];`,
`  const LIVE_LEG = ["new", "accepted", "pending_new", "partially_filled", "pending_replace", "replaced", "held"];   // v5 A: an OTO leg reads "held" until it activates — it is live`, "A LIVE_LEG");
rep(`      if (leg && LIVE_LEG.includes(leg.status)) await cancel(leg);                      // live at the wrong size: remove it`,
`      if (leg && !["canceled", "expired", "rejected", "filled", "done_for_day"].includes(leg.status)) {   // v5 B: never a second exit while the leg can still fire
        await cancel(leg); const lr = await byId(leg.id); p.legStatus = lr ? lr.status : p.legStatus;
        if (lr && lr.status === "filled") { p.stopQty = 0; p.exit = "stopped (leg)"; return; }        // the leg already took the lot out
        if (!lr || !["canceled", "expired", "rejected", "done_for_day"].includes(lr.status)) { S.notes.push(\`\${p.sym} leg \${lr ? lr.status : "unreadable"} after cancel — no second exit this cycle\`); return; }
      }`, "B leg guard");
rep(` * v4 (2026-10-01, nightly audit of 09-30)`, ` * v5 (2026-10-02): one exit per lot — an OTO leg reading "held" counts as live, and no standalone stop / market exit is placed until the leg
 *   is confirmed cancelled (10-01 double-exited ACN/CTSH/HDB/ALC). See docs/r295/patch-r295-v5.cjs.
 * v4 (2026-10-01, nightly audit of 09-30)`, "header");
fs.writeFileSync(OUTF, s); console.log("written", OUTF, s.length, "bytes");
