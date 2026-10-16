#!/usr/bin/env node
/**
 * THE DICE BOOK — the operator's high-risk sleeve, graded like everything else.
 *
 * Origin (2026-08-01, operator: "agreed wire it"): the 10% roll-the-dice sleeve gets logged
 * in TRAIDS as its own tagged cohort. The deal: EVERY position enters with a written thesis
 * and an exit rule, or the entry is REFUSED — the discipline is the product. TRAIDS marks the
 * book nightly, flags breached exit rules, and grades the record (total, hit rate, skew,
 * per-bucket) so that two years from now the operator owns the one document almost no
 * investor has: the measured expectancy of their own risk appetite.
 *
 * TRAIDS grades this book; it never trades it. Closes are the operator's acts, logged here.
 *
 * Usage:
 *   node backend/dice-book.js add <SYM> <qty> <entryPrice> --bucket r11turn|leaps|domain|eventvol|btc
 *        --thesis "..." --exit "..." [--occ OCC1,OCC2]     (options positions: give OCC legs for auto-marks)
 *   node backend/dice-book.js close <id> <exitPrice> [--note "..."]
 *   node backend/dice-book.js list
 *   node backend/dice-book.js mark          (nightly: marks, exit-rule flags, grade — wired into close chain)
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const STATE = D("dice-book.json");
const YAHOO = "http://localhost:3002/api/yahoo";
const BUCKETS = ["r11turn", "leaps", "domain", "eventvol", "btc"];

const load = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return { spec: "dice-v1", positions: [], closed: [] }; } };
const save = (st) => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
const arg = (name) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : null; };

async function lastClose(sym) {
  try { const r = await fetch(`${YAHOO}/${encodeURIComponent(sym)}/history?days=8&interval=1d`, { signal: AbortSignal.timeout(30000) });
    const b = ((await r.json()).bars || []).filter(x => x.close > 0); return b.length ? b[b.length - 1].close : null; } catch { return null; }
}
async function ma200(sym) {
  try { const r = await fetch(`${YAHOO}/${encodeURIComponent(sym)}/history?days=320&interval=1d`, { signal: AbortSignal.timeout(45000) });
    const b = ((await r.json()).bars || []).filter(x => x.close > 0);
    return b.length >= 200 ? b.slice(-200).reduce((s, x) => s + x.close, 0) / 200 : null; } catch { return null; }
}

(async () => {
  const cmd = process.argv[2];
  const st = load();
  const today = new Date().toISOString().slice(0, 10);

  if (cmd === "add") {
    const [sym, qty, entry] = [process.argv[3], Number(process.argv[4]), Number(process.argv[5])];
    const bucket = arg("bucket"), thesis = arg("thesis"), exitRule = arg("exit"), occ = arg("occ");
    // THE GATE: no thesis or no exit rule → no entry. This is the entire point of the book.
    const missing = [];
    if (!sym || !(qty > 0) || !(entry > 0)) missing.push("sym/qty/entryPrice");
    if (!BUCKETS.includes(bucket)) missing.push(`--bucket (one of ${BUCKETS.join("|")})`);
    if (!thesis || thesis.length < 15) missing.push("--thesis (a real sentence, ≥15 chars — 'it looks good' is not a thesis)");
    if (!exitRule || exitRule.length < 8) missing.push("--exit (a rule you can be held to)");
    if (missing.length) { console.error(`  ENTRY REFUSED — missing/invalid: ${missing.join(" · ")}\n  The dice book takes positions with paperwork or it takes nothing.`); process.exit(1); }
    const id = `${Date.now().toString(36)}-${sym}`;
    st.positions.push({ id, sym: sym.toUpperCase(), qty, entry, entryDate: today, bucket, thesis, exitRule,
      occ: occ ? occ.split(",").map(s => s.trim().toUpperCase()) : null, flags: [] });
    save(st);
    console.log(`  ★ DICE ENTRY ${id}: ${qty} ${sym.toUpperCase()} @ $${entry} [${bucket}]\n    thesis: ${thesis}\n    exit:   ${exitRule}\n  On the record. The ledger is watching.`);
    return;
  }

  if (cmd === "close") {
    const id = process.argv[3], exitPx = Number(process.argv[4]);
    const i = st.positions.findIndex(p => p.id === id || p.sym === String(id).toUpperCase());
    if (i < 0 || !(exitPx > 0)) { console.error("  close <id|SYM> <exitPrice> — position not found or bad price"); process.exit(1); }
    const p = st.positions.splice(i, 1)[0];
    const pnl = +((exitPx - p.entry) * p.qty).toFixed(2);
    st.closed.push({ ...p, exit: exitPx, exitDate: today, pnl, retPct: +((exitPx / p.entry - 1) * 100).toFixed(1), note: arg("note") || null });
    save(st);
    console.log(`  DICE CLOSE ${p.sym}: $${p.entry} → $${exitPx} = ${pnl >= 0 ? "+" : ""}$${pnl} (${((exitPx / p.entry - 1) * 100).toFixed(1)}%) — recorded against the thesis: "${p.thesis.slice(0, 60)}"`);
    return;
  }

  if (cmd === "list" || cmd === "mark" || !cmd) {
    console.log(`\n  THE DICE BOOK · ${today} — the operator's risk appetite, measured\n`);
    let openVal = 0, openCost = 0;
    for (const p of st.positions) {
      const isOpt = !!p.occ;
      let mark = null;
      if (!isOpt) mark = await lastClose(p.sym === "BTC" ? "BTC-USD" : p.sym);
      else {
        try { const q = await (await fetch(`http://localhost:3001/api/option-quotes?symbols=${p.occ.join(",")}`, { signal: AbortSignal.timeout(30000) })).json();
          const legs = p.occ.map(o => (q.data || {})[o]).filter(Boolean);
          if (legs.length === p.occ.length) mark = legs.reduce((s, l) => s + (l.bid ?? l.bp ?? 0), 0); } catch { }
      }
      const val = mark != null ? mark * p.qty : null;
      openCost += p.entry * p.qty; if (val != null) openVal += val;
      // exit-rule mechanics: a rule mentioning "200d" gets checked by the machine; others are the operator's honor
      p.flags = [];
      if (cmd === "mark" && /200d|200-day/i.test(p.exitRule) && !isOpt) {
        const m = await ma200(p.sym === "BTC" ? "BTC-USD" : p.sym);
        if (m && mark != null && mark < m) p.flags.push(`⚠ EXIT RULE BREACHED: close $${mark.toFixed(2)} < 200d $${m.toFixed(2)} — the rule you wrote says out`);
      }
      console.log(`  ${p.id.padEnd(16)} ${p.sym.padEnd(6)} [${p.bucket}] ${p.qty} @ $${p.entry} → ${mark == null ? "— (no live mark" + (isOpt ? "; legs not quoting" : "") + ")" : "$" + mark.toFixed(2) + " (" + ((mark / p.entry - 1) * 100).toFixed(1) + "%)"}`);
      for (const f of p.flags) console.log(`      ${f}`);
      console.log(`      exit: ${p.exitRule}`);
    }
    if (!st.positions.length) console.log("  no open positions — the book takes entries only with a thesis and an exit rule attached.");
    // grade — total, hit rate, skew, per-bucket
    const rets = st.closed.map(c => c.retPct);
    if (st.closed.length) {
      const tot = st.closed.reduce((s, c) => s + c.pnl, 0);
      const byB = {}; for (const c of st.closed) (byB[c.bucket] ||= []).push(c.pnl);
      console.log(`\n  RECORD: ${st.closed.length} closed · net ${tot >= 0 ? "+" : ""}$${tot.toFixed(0)} · hits ${rets.filter(r => r > 0).length}/${rets.length} · best ${Math.max(...rets)}% · worst ${Math.min(...rets)}%`);
      for (const [b, arr] of Object.entries(byB)) console.log(`    ${b.padEnd(9)} n=${arr.length} net ${arr.reduce((s, v) => s + v, 0) >= 0 ? "+" : ""}$${arr.reduce((s, v) => s + v, 0).toFixed(0)}`);
      console.log(`  (a low hit rate with a fat 'best' is the convex design working — judge the skew, not the win rate)`);
    }
    if (st.positions.length && openVal > 0) console.log(`\n  open book: cost $${openCost.toFixed(0)} · marked $${openVal.toFixed(0)} (${((openVal / openCost - 1) * 100).toFixed(1)}%)`);
    if (cmd === "mark") save(st);
    return;
  }

  console.error("  commands: add · close · list · mark  (see header for usage)");
})().catch(e => { console.error("  dice-book failed:", e.message); process.exit(1); });
