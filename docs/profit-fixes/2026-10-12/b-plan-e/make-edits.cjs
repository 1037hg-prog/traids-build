#!/usr/bin/env node
"use strict";
/**
 * PROFIT FIXES B — (re)stage the edits. READ-ONLY on the repo; writes ONLY edits.json in this folder (writeJsonAtomic).
 *   node docs/profit-fixes/2026-10-12/b-plan-e/make-edits.cjs             stage (refuses when a base line differs from the one already staged)
 *   node docs/profit-fixes/2026-10-12/b-plan-e/make-edits.cjs --restage   stage again on top of a changed base line, after you have READ that change
 * Every edit is cut from TODAY'S live file: the old block is the live line(s) found by a marker that must match exactly once; the new block is
 * that text with a named fragment replaced, or a block from staged/<id>.txt. So an edit made elsewhere in a file by another package does not
 * disturb these, and a change to one of these very lines is refused until someone has read it (then: --restage, selftest, deploy --plan).
 * Refuses when the live files already carry the edits (applied): there is nothing to stage then.
 */
const fs = require("fs"), path = require("path");
const L = require("./lib.cjs");
const RESTAGE = process.argv.includes("--restage");
const die = (m) => { console.error("REFUSED — edits.json not written: " + m); process.exit(2); };
const block = (id) => { const t = fs.readFileSync(path.join(L.PKG, "staged", `${id}.txt`), "utf8").replace(/\r\n/g, "\n"); if (!t.endsWith("\n")) die(`staged/${id}.txt must end with a newline`); return t; };

const RM = "backend/risk-manager.js", SB = "backend/planE-paper-scoreboard.js", AA = "backend/all-activity-per-day.js", PM = "backend/profit-program/planE-model.js";
/**
 * kinds:  lines  { first: marker of the first old line, n }   -> replaced by staged/<id>.txt
 *         before { anchor: the exact whole line }             -> staged/<id>.txt is inserted above it (the anchor line stays)
 *         frag   { line: marker, swap: [[from, to], ...] }    -> one line, each fragment replaced (each must be there exactly once)
 */
const SPECS = [
  // (b) the Coinbase fetch
  { id: "rm-coinbase", file: RM, fix: "b", kind: "lines", first: "async function coinbase(coin, fromIso) { const all = [], stop = Date.parse(fromIso);", n: 3, why: "chunks aligned to 00:00 UTC (no candle dropped at a boundary); a failed, malformed, holed or stale answer throws" },
  { id: "rm-crypto-day", file: RM, fix: "b", kind: "before", anchor: "  // 10-month signal per ETF, decided at each month-end close, applied through the next month", why: "both coins must hold the candle of the last bar's own day (in progress at the nightly run): a feed that stopped inside the last day ends UNKNOWN, never a row with the crypto leg at zero" },
  { id: "rm-unknown", file: RM, fix: "b", kind: "lines", first: "})().catch((e) => { console.error(\"risk-manager FAILED:\", e.stack); process.exit(1); });", n: 1, why: "a run that could not finish prints UNKNOWN, marks the stored snapshot UNKNOWN (last good numbers kept, dated), writes no forward row, exits 1" },
  // (a) the month-end window
  { id: "rm-sessions-fn", file: RM, fix: "a", kind: "before", anchor: "async function buildBook(fromIso) {", why: "sessionsToCome(): the rest of the month from Alpaca's calendar; unreadable -> throws" },
  { id: "rm-window", file: RM, fix: "a", kind: "lines", first: "  // month-end windows: last 5 sessions of each month", n: 2, why: "the window is the last 5 sessions of the CALENDAR month, not the latest 5 sessions so far" },
  // (c) the headline rate
  { id: "rm-stated-fn", file: RM, fix: "c", kind: "before", anchor: "(async () => {", why: "planEStated(): the stated model return read from the model's own output file" },
  { id: "rm-snapshot", file: RM, fix: "c", kind: "frag", line: "  const snapshot = { asOf: last.d, mode:", swap: [["const snapshot = { asOf: last.d, mode:", "const snapshot = { status: \"OK\", asOf: last.d, planE: planEStated(), mode:"]], why: "the snapshot carries its status and the stated return" },
  { id: "rm-preview-basis", file: RM, fix: "c", kind: "frag", line: "    preview: { note: \"WEIGHTLESS preview on history", swap: [["preview: { note: \"WEIGHTLESS preview on history", "preview: { basis: \"this file's IEF-proxy book (ZN leg = ZN_LEV x ZN_BETA x IEF total return, no financing charge): its level is NOT Plan E's stated model return — that is planE.annualReturnPct, read from the model's own output\", note: \"WEIGHTLESS preview on history"]], why: "the stored preview says which book its level belongs to" },
  { id: "rm-console", file: RM, fix: "c", kind: "lines", first: "  console.log(`  preview (weightless): ${JSON.stringify(snapshot.preview[\"2019-06..now\"])}`);", n: 1, why: "the run prints the stated return (computed) and the preview as managed-minus-unmanaged, not the proxy book's level" },
  { id: "sb-header-model", file: SB, fix: "c", kind: "frag", line: " *   50-day crypto with 25 bps per switch, ZN proxied as ZN_LEV x ZN_BETA x IEF on the last 5 sessions of the month", swap: [["ZN proxied as ZN_LEV x ZN_BETA x IEF on the last 5 sessions of the month (4 bps x ZN_LEV round trip),", "ZN proxied as ZN_LEV x ZN_BETA x (IEF - T-bill) on the last 5 sessions of the month (4 bps x ZN_LEV round trip; FINANCED since 2026-10-12),"]], why: "header: the model's ZN proxy is financed" },
  { id: "sb-header-window", file: SB, fix: "a", kind: "frag", line: " *   its window is the current month's latest 5 sessions). Crypto on the same UTC-close alignment as the paper sleeve.", swap: [["its window is the current month's latest 5 sessions).", "its rows from before the 2026-10-12 window fix used the current month's latest 5 sessions)."]], why: "header: the forward file's defect is dated" },
  { id: "sb-model-zn", file: SB, fix: "c", kind: "frag", line: "    if (zn) { const x = rr(\"IEF\"); if (x == null) miss.push(\"IEF adjusted close\");", swap: [["else r += PE.ZN_LEV * PE.ZN_BETA * x - (D === w5[0]", "else r += PE.ZN_LEV * PE.ZN_BETA * (x - rfAnnual(D) / 100 / 252) - (D === w5[0]"], [": 0); }", ": 0); }   // 2026-10-12 (profit fixes B): the proxy is FINANCED. A note future's price return carries no coupon carry and IEF's total return does, so the T-bill is charged on the proxied notional each window day; unfinanced, the model line ran about 3 points a year above Plan E's stated return and showed a paper shortfall that was not there"]], why: "the model line the paper record is graded against: the ZN proxy pays the T-bill on window days" },
  { id: "sb-model-note", file: SB, fix: "c", kind: "before", anchor: "  const ms = modelSyms(PE);", why: "the stored record and the printed tables say the model line is on the financed basis and that every model day is restated (the history rows carry no revision mark for it)" },
  { id: "sb-test-0930a", file: SB, fix: "c", kind: "frag", line: "    near(r.daily[1].modelPct, 100 * (0.3 * (30.5 / 30 - 1) + 0.075 * (104 / 102 - 1)", swap: [["4.2 * 0.79 * (95.95 / 95 - 1) - 0.0004 * 4.2 / 2 + (1 - 0.45) * (0.04 / 252)), \"model 09-30: QQQ OUT (Aug signal), DBMF, crypto, ZN window last day, cash at T-bill\"", "4.2 * 0.79 * (95.95 / 95 - 1 - 0.04 / 252) - 0.0004 * 4.2 / 2 + (1 - 0.45) * (0.04 / 252)), \"model 09-30: QQQ OUT (Aug signal), DBMF, crypto, ZN window last day (the proxy financed at the T-bill), cash at T-bill\""]], why: "in-file selftest: expected model % on a window day now carries the financing term" },
  { id: "sb-test-0930b", file: SB, fix: "c", kind: "frag", line: "      0.3 * (30.5 / 30 - 1) + 0.075 * (104 / 102 - 1) + 0.075 * (11.5 / 11 - 1) + 4.2 * 0.79 * (95.95 / 95 - 1)", swap: [["4.2 * 0.79 * (95.95 / 95 - 1) - 0.0004 * 4.2 / 2 + (1 - 0.45) * rfD,   // 09-30", "4.2 * 0.79 * (95.95 / 95 - 1 - rfD) - 0.0004 * 4.2 / 2 + (1 - 0.45) * rfD,   // 09-30 (a ZN window day: the proxy financed at the T-bill)"]], why: "in-file selftest: the known model day 09-30 (feeds the model cumulative) carries the financing term" },
  { id: "sb-test-1002", file: SB, fix: "c", kind: "frag", line: "    near(r.daily[3].modelPct, 100 * (mK[3] + 4.2 * 0.79 * (96 / 96 - 1)", swap: [["100 * (mK[3] + 4.2 * 0.79 * (96 / 96 - 1) - (0.0004 * 4.2) / 2), \"10-02 = first of the last 5: ZN term (IEF flat) and the 2 bps x ZN_LEV edge cost\"", "100 * (mK[3] + 4.2 * 0.79 * (96 / 96 - 1 - rfD) - (0.0004 * 4.2) / 2), \"10-02 = first of the last 5: ZN term (IEF flat, less the T-bill financing) and the 2 bps x ZN_LEV edge cost\""]], why: "in-file selftest: first window day carries the financing term" },
  { id: "sb-test-1005", file: SB, fix: "c", kind: "frag", line: "    near(r.daily[4].modelPct, 100 * (mK[4] + 4.2 * 0.79 * (96.5 / 96 - 1))", swap: [["100 * (mK[4] + 4.2 * 0.79 * (96.5 / 96 - 1)), \"10-05 = inside the last 5: ZN term, no edge cost\"", "100 * (mK[4] + 4.2 * 0.79 * (96.5 / 96 - 1 - rfD)), \"10-05 = inside the last 5: ZN term less the T-bill financing, no edge cost\""]], why: "in-file selftest: a window day inside the last 5 carries the financing term" },
  { id: "aa-header", file: AA, fix: "c", kind: "frag", line: " * Plan E: the model on $100,000 (24.26% a year; 28.74% with every leg at 1.2x), 252 trading days;", swap: [["Plan E: the model on $100,000 (24.26% a year; 28.74% with every leg at 1.2x), 252 trading days;", "Plan E: the model on $100,000, 252 trading days, its rates READ from the model's own output files (data/profit-program/planE-baseline.json, planE-levers-H.json), never typed;"]], why: "header: the Plan E rates are read, not typed" },
  { id: "aa-rates", file: AA, fix: "c", kind: "lines", first: "const pe = (rate) => 100000 * rate / TD, PE_BASE = 0.2426, PE_MAX = 0.2874, PE_LOW = 0.0908;", n: 1, why: "the three typed rates become values read from the model's output files (UNKNOWN when unreadable)" },
  { id: "aa-rows", file: AA, fix: "c", kind: "lines", first: "row(\"the last seven years repeat (24.26% a year)\", $(pe(PE_BASE)),", n: 3, why: "the three Plan E rows print the read rates and drawdowns" },
  { id: "aa-combined", file: AA, fix: "c", kind: "lines", first: "console.log(\"\\nCOMBINED WITH PLAN E AT ITS MAX (28.74%), per trading day and per year (252 days)\");", n: 2, why: "the combined rows use the read max rate" },
  // keeps the profit program's model library (and with it planE-baseline.js, the writer of the stated return) working on the fixed risk-manager.js
  { id: "pm-window", file: PM, fix: "compat", kind: "lines", first: "  if (opts.fixWindow) swap(\"allDays.forEach((d) => (byMonth[d.slice(0, 7)]\",", n: 1, why: "planE-model.js patches risk-manager.js by text: it must answer sessionsToCome() from its cached calendar, for the old and the fixed file alike" },
];

const live = {}; for (const rel of [...new Set(SPECS.map((s) => s.file))]) live[rel] = L.readText(path.join(L.REPO, rel));
const prev = fs.existsSync(L.EDITS_FILE) ? JSON.parse(fs.readFileSync(L.EDITS_FILE, "utf8")) : null;
if (prev) { try { const P = L.plan(L.loadEdits()); if (P.some((f) => f.state === "applied" || f.state === "mixed")) die(`the live files already carry staged edits (${P.filter((f) => f.state !== "base").map((f) => `${f.rel}: ${f.state}`).join("; ")}) — roll back first, or there is nothing to stage`); } catch (e) { if (!RESTAGE) die(`the existing edits.json does not load (${e.message}) — fix it or pass --restage`); } }
const edits = [], changed = [];
for (const s of SPECS) {
  const lines = live[s.file].text.split("\n"), find = (marker, whole) => { const hit = lines.map((l, i) => [l, i]).filter(([l]) => (whole ? l === marker : l.startsWith(marker))); if (hit.length !== 1) die(`${s.id}: marker found ${hit.length} times in ${s.file} (need exactly 1): ${marker.slice(0, 90)}`); return hit[0][1]; };
  let old, neu;
  if (s.kind === "lines") { const i = find(s.first); old = lines.slice(i, i + s.n).join("\n") + "\n"; neu = block(s.id); }
  else if (s.kind === "before") { const i = find(s.anchor, true); old = lines[i] + "\n"; neu = block(s.id) + old; }
  else if (s.kind === "frag") { const i = find(s.line); old = lines[i] + "\n"; neu = old; for (const [from, to] of s.swap) { if (neu.split(from).length !== 2) die(`${s.id}: fragment found ${neu.split(from).length - 1} times in its line (need exactly 1): ${from.slice(0, 80)}`); neu = neu.replace(from, () => to); } }
  else die(`${s.id}: unknown kind ${s.kind}`);
  const was = prev && (prev.edits || []).find((e) => e.id === s.id); if (was && was.old !== old) changed.push(s.id);
  edits.push({ id: s.id, file: s.file, fix: s.fix, why: s.why, oldSha: L.sha256(old), newSha: L.sha256(neu), old, new: neu });
}
if (changed.length && !RESTAGE) die(`the live base text of ${changed.join(", ")} differs from what is staged — READ the change in the live file, then run make-edits.cjs --restage, selftest.cjs and deploy.cjs --plan`);
const out = { package: L.PKG_NAME, stagedAt: new Date().toISOString(), note: "ANCHORED whole-line replacements. base = old once and new nowhere; applied = new once and old nowhere else; anything else is drift and refused.",
  base: Object.fromEntries(Object.entries(live).map(([rel, v]) => [rel, { sha256: v.sha, bytes: v.buf.length }])), edits };
{   // prove the list on the live text before it is written: every edit base, apply -> all applied and node --check clean, revert -> the live bytes
  let E; try { E = L.validateEdits(JSON.parse(JSON.stringify(out))); } catch (e) { die(e.message); }
  for (const rel of L.filesOf(E)) { const ed = L.editsFor(E, rel), t0 = live[rel].text, st = L.fileState(t0, ed); if (st.state !== "base") die(`${rel}: the new list does not read as base on the live file (${JSON.stringify(st.states.filter((x) => x.state !== "base"))})`);
    const t1 = L.applyText(t0, ed), err = L.nodeCheckText(t1, rel); if (err) die(`${rel}: the staged text fails node --check: ${err}`); if (L.revertText(t1, ed) !== t0) die(`${rel}: revert does not give the live bytes back`); }
}
L.atomic().writeJsonAtomic(L.EDITS_FILE, out);
console.log(`edits.json written: ${edits.length} edits on ${Object.keys(live).length} files${changed.length ? ` (RESTAGED over a changed base: ${changed.join(", ")})` : ""}`);
for (const [rel, v] of Object.entries(live)) console.log(`  ${rel.padEnd(42)} base sha ${v.sha.slice(0, 12)}  ${edits.filter((e) => e.file === rel).map((e) => `${e.id}[${e.fix}]`).join(" ")}`);
