#!/usr/bin/env node
/**
 * TRAIDS — FULL SYSTEM AUDIT
 *
 * Everything that can be checked mechanically, in one pass: endpoints, data freshness,
 * automation wiring, registry integrity, defect state, frozen-spec fingerprints, and the
 * cross-file consistency that has produced most of this project's defects.
 *
 * WHY THIS SHAPE. The 2026-07-28 audits found that the failures were never in the RESULTS —
 * they were in the plumbing around them: a registry pointing at a file that did not exist
 * (D23), a hand-typed count that said 6 when the log held 18, a window printed from a constant
 * instead of the response (D28), a screen that flagged 7 observers as 25 (D16). Every one was
 * mechanically detectable and none was caught by looking at a number and asking if it seemed
 * right.
 *
 * Usage: node backend/full-audit.js
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const rd = (f, fb) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return fb; } };
const ok = [], warn = [], fail = [];
const P = (c, m) => (c === 0 ? ok : c === 1 ? warn : fail).push(m);
const age = (ms) => { const d = (Date.now() - ms) / 864e5; return d < 1 ? (d * 24).toFixed(1) + "h" : d.toFixed(1) + "d"; };

(async () => {
  console.log(`\n  TRAIDS — FULL SYSTEM AUDIT · ${new Date().toISOString().slice(0, 16).replace("T", " ")}\n`);

  // ── 1. endpoints ──────────────────────────────────────────────────────────
  console.log("  1. ENDPOINTS");
  for (const [label, url] of [["intelligence (:3001)", "http://localhost:3001/api/intelligence"], ["yahoo proxy (:3002)", "http://localhost:3002/api/yahoo/SPY/history?days=5&interval=1d"]]) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      const ms = Date.now() - t0;
      console.log(`     ${r.ok ? "OK  " : "FAIL"} ${label.padEnd(22)} ${r.status} in ${(ms / 1000).toFixed(1)}s`);
      P(r.ok ? 0 : 2, `${label} ${r.status}`);
    } catch (e) { console.log(`     FAIL ${label.padEnd(22)} ${e.message.slice(0, 40)}`); P(2, `${label} unreachable`); }
  }

  // ── 2. data freshness ─────────────────────────────────────────────────────
  console.log("\n  2. DATA FRESHNESS");
  const files = [
    ["trade_log.json", 2, "the ledger"], ["market-tape.json", 2, "market record"],
    ["test-registry.json", 30, "test registry"], ["defect-log.json", 30, "defect log"],
    ["structural-forward.json", 3, "#52 forward collector"], ["funding-carry-store.json", 3, "P2 collector"],
    ["merger-forward.json", 3, "merger-arb watcher"], ["learning-history.json", 3, "learning tracker"],
  ];
  for (const [f, maxDays, label] of files) {
    const p = D(f);
    if (!fs.existsSync(p)) { console.log(`     MISS ${label.padEnd(24)} ${f} not found`); P(2, `${f} missing`); continue; }
    const st = fs.statSync(p), a = (Date.now() - st.mtimeMs) / 864e5;
    const flag = a > maxDays ? 1 : 0;
    console.log(`     ${flag ? "WARN" : "OK  "} ${label.padEnd(24)} ${age(st.mtimeMs).padStart(6)} old · ${(st.size / 1024).toFixed(0)}kb`);
    P(flag, `${label} ${age(st.mtimeMs)} old`);
  }

  // ── 3. registry integrity ─────────────────────────────────────────────────
  console.log("\n  3. REGISTRY INTEGRITY");
  const reg = rd("test-registry.json", { tests: [], green: [], defended: [] });
  const nums = reg.tests.map(t => t.n).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => nums[i + 1] === n);
  const gaps = []; for (let i = 1; i <= Math.max(...nums); i++) if (!nums.includes(i)) gaps.push(i);
  console.log(`     ${reg.tests.length} tests · numbering 1-${Math.max(...nums)} · ${dupes.length} duplicates · ${gaps.length} gaps${gaps.length ? " (" + gaps.join(",") + ")" : ""}`);
  P(dupes.length ? 2 : 0, dupes.length ? `duplicate test numbers: ${dupes}` : "no duplicate test numbers");
  P(reg.tally?.tested === reg.tests.length ? 0 : 1, `tally.tested ${reg.tally?.tested} vs actual ${reg.tests.length}`);
  // every script referenced must exist — this is D23's class
  let missingScripts = 0;
  for (const section of [["tests", reg.tests], ["green", reg.green], ["defended", reg.defended || []]]) {
    for (const t of section[1]) {
      if (!t.script) continue;
      for (const f of String(t.script).split(/[·;,]/).map(s => s.trim()).filter(Boolean)) {
        const rel = f.startsWith("backend/") ? f : "backend/" + f;
        if (!fs.existsSync(path.join(__dirname, "..", rel))) { console.log(`     MISS ${section[0]} "${(t.name || "").slice(0, 32)}" -> ${f}`); missingScripts++; }
      }
    }
  }
  P(missingScripts ? 2 : 0, missingScripts ? `${missingScripts} referenced scripts missing` : "every referenced script exists (all sections)");
  if (!missingScripts) console.log(`     OK   every referenced script exists — tests, green AND defended`);

  // ── 4. defect state ───────────────────────────────────────────────────────
  console.log("\n  4. DEFECT LOG");
  const dl = rd("defect-log.json", { audits: [] });
  const all = (dl.audits || []).flatMap(a => a.defects || []);
  const flat = all.filter(x => x.direction === "flattering"), open = all.filter(x => !x.fixed);
  console.log(`     ${all.length} defects · ${flat.length} flattering · ${open.length} open: ${open.map(x => x.id).join(", ") || "none"}`);
  const openFlat = open.filter(x => x.direction === "flattering");
  console.log(`     ${openFlat.length} OPEN AND FLATTERING — these inflate current numbers: ${openFlat.map(x => x.id).join(", ") || "none"}`);
  P(openFlat.length > 3 ? 1 : 0, `${openFlat.length} open flattering defects`);
  // cross-check: does the registry's hand-written count match?
  const defLine = (reg.defended || []).find(x => /accounting error|accounting bug/i.test(x.what || ""));
  if (defLine) {
    const claimed = parseInt(String(defLine.what).match(/(\d+)/)?.[1] || "0");
    const match = claimed === flat.length;
    console.log(`     ${match ? "OK  " : "WARN"} registry claims ${claimed} flattering, log holds ${flat.length}`);
    P(match ? 0 : 1, `registry defect count ${match ? "matches" : "STALE"}`);
  }

  // ── 5. frozen specs ───────────────────────────────────────────────────────
  console.log("\n  5. FROZEN SPECS & TAMPER GUARDS");
  const crypto = require("crypto");
  const spec = rd("structural-spec-frozen.json", null);
  if (spec) {
    const fp = crypto.createHash("sha256").update(JSON.stringify({ w: spec.weights, b: spec.intercept, mu: spec.mu, sg: spec.sg })).digest("hex").slice(0, 16);
    const good = fp === spec.fingerprint;
    console.log(`     ${good ? "OK  " : "FAIL"} #52 model spec  declared ${spec.fingerprint} · recomputed ${fp}`);
    P(good ? 0 : 2, `#52 frozen spec ${good ? "intact" : "ALTERED"}`);
  }
  const lock = rd("checkpoint-2026-08-10.lock.json", null);
  if (lock) {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "App.jsx"), "utf8");
    const drift = Object.keys(lock.frozen || {}).filter(k => { const m = src.match(new RegExp("const " + k + "\\s*=\\s*([^;]+);")); return (m ? m[1].trim() : "(NOT FOUND)") !== lock.frozen[k]; });
    console.log(`     ${drift.length ? "WARN" : "OK  "} checkpoint machinery  ${drift.length ? drift.length + " constant(s) changed: " + drift.join(", ") : "all " + Object.keys(lock.frozen).length + " unchanged"}`);
    P(drift.length ? 1 : 0, drift.length ? `checkpoint VOID — ${drift.join(", ")} changed` : "checkpoint machinery intact");
  }

  // ── 6. automation wiring ──────────────────────────────────────────────────
  console.log("\n  6. AUTOMATION WIRING");
  const close = (() => { try { return fs.readFileSync(path.join(__dirname, "..", "automation", "daily-close.bat"), "utf8"); } catch { return ""; } })();
  for (const [label, needle] of [["learning tracker", "learning-tracker"], ["#52 forward collector", "structural-forward"], ["market tape", "market-tape"], ["daily cycle", "daily-run"]]) {
    const wired = close.includes(needle);
    console.log(`     ${wired ? "OK  " : "WARN"} ${label.padEnd(24)} ${wired ? "in daily-close.bat" : "NOT WIRED"}`);
    P(wired ? 0 : 1, `${label} ${wired ? "wired" : "not wired"}`);
  }

  // ── 7. the ledger's own integrity ─────────────────────────────────────────
  console.log("\n  7. LEDGER INTEGRITY");
  const log = rd("trade_log.json", []);
  const CLEAN = new Date("2026-07-20T00:00:00-06:00").getTime();
  const clean = log.filter(t => t && t.closedAt >= CLEAN && Number.isFinite(t.rMult));
  const manual = clean.filter(t => t.reason === "manual" || t.reason === "time");
  const absurd = clean.filter(t => Math.abs(t.rMult) >= 10);
  const noReason = clean.filter(t => !t.reason);
  console.log(`     ${clean.length} clean-epoch settles · ${absurd.length} with |R|>=10 · ${noReason.length} with no exit reason`);
  console.log(`     ${manual.length} DISCRETIONARY exits (${(100 * manual.length / clean.length).toFixed(0)}%) — a machine cannot reproduce these`);
  P(absurd.length ? 1 : 0, `${absurd.length} absurd R-multiples`);
  P(manual.length / clean.length > 0.05 ? 1 : 0, `${(100 * manual.length / clean.length).toFixed(0)}% discretionary exits inflate the headline`);

  // ── summary ───────────────────────────────────────────────────────────────
  console.log(`\n  ${"".padEnd(66, "═")}`);
  console.log(`  ${ok.length} OK · ${warn.length} WARN · ${fail.length} FAIL`);
  if (fail.length) { console.log(`\n  FAILURES:`); fail.forEach(f => console.log(`    · ${f}`)); }
  if (warn.length) { console.log(`\n  WARNINGS:`); warn.forEach(w => console.log(`    · ${w}`)); }
  console.log("");
})();
