#!/usr/bin/env node
/**
 * COMPARE W1 — the SHADOW nights (VPS shadow tree) against home's same-night files, field by field. 2026-10-07 (docs/server/wave1-crypto).
 * Read-only on both hosts: one ssh per unit streams the shadow tree's files (/home/traids/w1-shadow/backend/data) as a tar; home's
 * backend/data is read in place. Nothing is written anywhere (the report goes to stdout).
 *
 * What "the same night" means: a shadow file counts when it was RECORDED by the shadow (recordedAt after the seed time in
 * data/w1-shadow-seeded.json on the VPS), and is compared with home's file of the same date (whales: UTC day; social: ET day).
 *   whales   STRUCTURE (must agree): spec, positionsRule, both complete. VALUES (reported; they differ by design — the shadow records at
 *            21:30 UTC, home's chain at ~20:36 UTC): recordedAt gap, accounts on the board, kept, positionsFor, errors, overlap of the
 *            kept accounts and of the position holders (Jaccard).
 *   R323     rows the shadow added after the seed vs home's rows with the same kind|day: rows on one side only, and the field paths
 *            that differ in common rows (E/X and every return move with the snapshot time, so differences are expected; a row KIND or
 *            DAY present on one side only is what to look at). The shadow must have ADDED at least one row (else PENDING: a shadow whose
 *            R323 exits 4 every night proves nothing), and a row home added for a day the shadow has already scored past is DIFFER.
 *   funding  judged on the periods NEWER than the seeded store's newest (w1-shadow-seeded.json fundingNewestT): the shadow must have
 *            added at least one (funding-carry-v2.js exits 0 with "+0 new periods" on any OKX error), every new period home holds up to
 *            the shadow's newest must be on the shadow too, and every period both hold must carry the same funding and basis values
 *            (STRUCTURE); periods on one side only past that are counted (a run an hour apart can see one more period).
 *   social   STRUCTURE: spec, both complete, the same three sources. VALUES: rows per source, ticker overlap (Jaccard), top-10 overlap.
 *   runs     the shadow's w1-run-*.json (exit codes, seconds) beside home's chain-status.json for the same steps.
 *
 *   node docs/server/wave1-crypto/compare-w1.cjs [--json] [--host traids]
 *   node docs/server/wave1-crypto/compare-w1.cjs --selftest
 * Exit 0 every compared night agrees on STRUCTURE and EACH of whales snapshots, R323, funding and social has at least one compared
 * item · 1 a STRUCTURE difference (named) · 2 nothing comparable yet for some unit (no shadow night recorded, no R323 row or funding
 * period added by the shadow) · 3 the VPS could not be read.
 */
"use strict";
const fs = require("fs"), path = require("path");
const PS = require("./pull-server.cjs");

const jac = (a, b) => { const A = new Set(a), B = new Set(b); if (!A.size && !B.size) return 1; let i = 0; for (const x of A) if (B.has(x)) i++; return +(i / (A.size + B.size - i)).toFixed(3); };
const pj = (buf) => { try { return JSON.parse(buf.toString("utf8")); } catch { return null; } };
const rows = (buf) => (buf ? buf.toString("utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return { torn: l.slice(0, 40) }; } }) : []);
function diffPaths(a, b, at = "", out = [], limit = 15) {
  if (out.length >= limit) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) diffPaths(a[k], b[k], at ? `${at}.${k}` : k, out, limit);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${at || "(root)"}: ${JSON.stringify(a === undefined ? null : a).slice(0, 50)} -> ${JSON.stringify(b === undefined ? null : b).slice(0, 50)}`);
  return out;
}
const recordedAfter = (j, seededMs) => j && Number.isFinite(Date.parse(j.recordedAt)) && Date.parse(j.recordedAt) > seededMs;

/** Pure: compare one unit. home / shadow: Map rel -> Buffer. Returns { unit, nights, structureOk, items: [...] } */
function compareWhales(home, shadow, seededMs) {
  const items = [];
  for (const [rel, sb] of [...shadow].filter(([r]) => r.startsWith("hyperliquid-whales/")).sort()) {
    const s = pj(sb); if (!recordedAfter(s, seededMs)) continue;
    const day = rel.slice(-15, -5), hb = home.get(rel), h = hb ? pj(hb) : null;
    if (!h) { items.push({ day, verdict: "PENDING", note: "home has no file for this day yet" }); continue; }
    const structure = [], values = [];
    for (const k of ["spec", "positionsRule"]) if (h[k] !== s[k]) structure.push(`${k}: home ${JSON.stringify(h[k])} · shadow ${JSON.stringify(s[k])}`);
    if (h.complete !== true || s.complete !== true) structure.push(`complete: home ${h.complete} · shadow ${s.complete}`);
    values.push(`recorded ${((Date.parse(s.recordedAt) - Date.parse(h.recordedAt)) / 60000).toFixed(0)} min apart (home ${String(h.recordedAt).slice(11, 16)}Z, shadow ${String(s.recordedAt).slice(11, 16)}Z)`);
    for (const k of ["accountsOnBoard", "kept", "positionsFor"]) values.push(`${k} ${h[k]} · ${s[k]}`);
    values.push(`errors ${(h.errors || []).length} · ${(s.errors || []).length}`);
    values.push(`kept accounts overlap ${jac((h.accounts || []).map((x) => x.a), (s.accounts || []).map((x) => x.a))}`);
    values.push(`position holders overlap ${jac(Object.keys(h.positions || {}), Object.keys(s.positions || {}))}`);
    items.push({ day, verdict: structure.length ? "DIFFER" : "AGREE", structure, values });
  }
  return { unit: "w1-whales (snapshots)", items };
}
function compareR323(home, shadow, seedRowsN) {
  const H = rows(home.get("r323-ledger.jsonl")), S = rows(shadow.get("r323-ledger.jsonl")), key = (r) => `${r.kind}|${r.day}`;
  const added = S.slice(seedRowsN), hm = new Map(H.map((r) => [key(r), r])), items = [];
  if (!added.length) items.push({ day: "ledger", verdict: "PENDING", note: `the shadow has added no R323 row since the seed (${S.length} rows = the ${seedRowsN} seeded) — nothing to compare yet (R323 exit 4 = feed down also adds none)` });
  for (const r of added) {
    const h = hm.get(key(r));
    if (!h) { items.push({ day: key(r), verdict: "DIFFER", structure: [`row ${key(r)} on the shadow only`], values: [] }); continue; }
    const d = diffPaths(h, r).filter((x) => !/^loggedAt:/.test(x));
    items.push({ day: key(r), verdict: "AGREE", structure: [], values: d.length ? [`${d.length >= 15 ? "15+" : d.length} field(s) differ (expected: the snapshot time moves E/X and the returns): ${d.slice(0, 6).join("; ")}`] : ["identical"] });
  }
  const sKeys = new Set(added.map(key)), seedKeys = new Set(S.slice(0, seedRowsN).map(key));
  const shadowPast = added.map((r) => String(r.day)).sort().pop() || null;   // the newest day the shadow has scored
  for (const h of H) {
    if (seedKeys.has(key(h)) || sKeys.has(key(h))) continue;
    if (shadowPast && String(h.day) <= shadowPast) items.push({ day: key(h), verdict: "DIFFER", structure: [`home row ${key(h)} is missing on the shadow, although the shadow has scored up to ${shadowPast}`], values: [] });
    else items.push({ day: key(h), verdict: "INFO", note: "home row the shadow has not written yet (the shadow's own snapshot times decide when an interval can be scored)" });
  }
  const hs = pj(home.get("r323-state.json") || Buffer.from("null")), ss = pj(shadow.get("r323-state.json") || Buffer.from("null"));
  if (hs && ss) items.push({ day: "state", verdict: "INFO", values: [`status home "${hs.status}" · shadow "${ss.status}"`, `dailyFrom home ${hs.cadence && hs.cadence.dailyFrom} · shadow ${ss.cadence && ss.cadence.dailyFrom}`] });
  return { unit: "w1-whales (R323 --score)", items };
}
function compareFunding(home, shadow, seedNewestT) {
  const h = pj(home.get("funding-carry-store.json") || Buffer.from("null")), s = pj(shadow.get("funding-carry-store.json") || Buffer.from("null"));
  if (!h || !s) return { unit: "w1-funding", items: [{ day: "store", verdict: "PENDING", note: `store missing or unparsable (home ${!!h}, shadow ${!!s})` }] };
  if (!Number.isFinite(seedNewestT)) return { unit: "w1-funding", items: [{ day: "store", verdict: "PENDING", note: "the seed marker has no fundingNewestT (seeded by an older deploy.cjs) — the shadow's own periods cannot be told from the seeded ones: re-seed (deploy.cjs --step seeds --reseed-shadow)" }] };
  let both = 0, same = 0, onlyH = 0, onlyS = 0, addedS = 0, newestS = null; const bad = [], missing = [];
  for (const m of Object.values(s.periods || {})) for (const t of Object.keys(m || {})) { const n = Number(t); if (n > seedNewestT) { addedS++; if (newestS == null || n > newestS) newestS = n; } }
  for (const sym of [...new Set([...Object.keys(h.periods || {}), ...Object.keys(s.periods || {})])]) {
    const a = (h.periods || {})[sym] || {}, b = (s.periods || {})[sym] || {};
    for (const t of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const n = Number(t); if (!(n > seedNewestT)) continue;             // the seeded periods are identical by construction: not evidence
      if (t in a && t in b) { both++; if (JSON.stringify(a[t]) === JSON.stringify(b[t])) same++; else if (bad.length < 10) bad.push(`${sym} ${new Date(n).toISOString().slice(0, 13)}Z ${JSON.stringify(a[t])} vs ${JSON.stringify(b[t])}`); }
      else if (t in a) { onlyH++; if (newestS != null && n <= newestS && missing.length < 10) missing.push(`${sym} ${new Date(n).toISOString().slice(0, 13)}Z`); }
      else onlyS++;
    }
  }
  const structure = [];
  if (!addedS) structure.push(`the shadow added NO funding period since the seed (newest seeded ${new Date(seedNewestT).toISOString().slice(0, 13)}Z) — funding-carry-v2.js exits 0 with "+0 new periods" when OKX fails`);
  if (missing.length) structure.push(`${missing.length}${missing.length >= 10 ? "+" : ""} period(s) home recorded after the seed, up to the shadow's own newest, are missing on the shadow: ${missing.join("; ")}`);
  if (same !== both) structure.push(`${both - same} of ${both} common new periods differ: ${bad.join("; ")}`);
  return { unit: "w1-funding", items: [{ day: "store", verdict: structure.length ? "DIFFER" : "AGREE", structure, values: [`since the seed: shadow added ${addedS} period(s) (newest ${newestS ? new Date(newestS).toISOString().slice(0, 13) + "Z" : "none"}) · ${both} new in both (${same} identical) · home only ${onlyH} · shadow only ${onlyS}`] }] };
}
function compareSocial(home, shadow, seededMs) {
  const items = [];
  for (const [rel, sb] of [...shadow].filter(([r]) => r.startsWith("social-mentions/")).sort()) {
    const s = pj(sb); if (!recordedAfter(s, seededMs)) continue;
    const day = rel.slice(-15, -5), hb = home.get(rel), h = hb ? pj(hb) : null;
    if (!h) { items.push({ day, verdict: "PENDING", note: "home has no file for this ET day yet" }); continue; }
    const structure = [], values = [`recorded ${((Date.parse(s.recordedAt) - Date.parse(h.recordedAt)) / 60000).toFixed(1)} min apart`];
    if (h.spec !== s.spec) structure.push(`spec ${h.spec} · ${s.spec}`);
    if (h.complete !== true || s.complete !== true) structure.push(`complete: home ${h.complete} · shadow ${s.complete}`);
    const src = [...new Set([...Object.keys(h.sources || {}), ...Object.keys(s.sources || {})])].sort();
    for (const k of src) {
      const a = (h.sources || {})[k], b = (s.sources || {})[k];
      if (!a || !b) { structure.push(`source ${k}: home ${!!a} · shadow ${!!b}`); continue; }
      const top = (x) => x.filter((r) => r.rank <= 10).map((r) => r.t);
      values.push(`${k}: rows ${a.length} · ${b.length}, tickers overlap ${jac(a.map((r) => r.t), b.map((r) => r.t))}, top-10 overlap ${jac(top(a), top(b))}`);
    }
    items.push({ day, verdict: structure.length ? "DIFFER" : "AGREE", structure, values });
  }
  return { unit: "w1-social", items };
}
function runsReport(shadow, chainStatus) {
  const items = [];
  for (const u of ["whales", "funding", "social"]) {
    const r = pj(shadow.get(`w1-run-${u}.json`) || Buffer.from("null"));
    if (!r) { items.push({ day: `w1-${u}`, verdict: "INFO", note: "no shadow run stamp yet" }); continue; }
    const home = (r.steps || []).map((st) => { const h = chainStatus && (chainStatus.steps || []).find((x) => x.name === st.name); return `${st.name}: shadow exit ${st.exit} ${st.secs}s${h ? ` · home ${h.ok ? "ok" : "FAIL"} ${h.secs}s (${String(chainStatus.started).slice(0, 10)})` : ""}`; });
    items.push({ day: `w1-${u} ${String(r.finishedAt).slice(0, 16)}Z`, verdict: r.ok ? "INFO" : "DIFFER", structure: r.ok ? [] : ["the shadow run FAILED: " + (r.steps || []).filter((x) => !x.ok).map((x) => `${x.name} ${x.why}`).join("; ")], values: home });
  }
  return { unit: "runs", items };
}
function verdictOf(reports) {
  const all = reports.flatMap((r) => r.items), differ = all.filter((i) => i.verdict === "DIFFER");
  const nightly = reports.filter((r) => r.unit !== "runs"), compared = nightly.length >= 4 && nightly.every((r) => r.items.some((i) => i.verdict === "AGREE" || i.verdict === "DIFFER"));
  if (differ.length) return { code: 1, text: `STRUCTURE DIFFERS in ${differ.length} item(s) — read them before the cutover` };
  if (!compared) return { code: 2, text: "nothing comparable yet for every unit (no shadow night recorded, or home's file of that night missing)" };
  return { code: 0, text: "every compared night agrees on STRUCTURE (values differ only as the run times explain)" };
}
function render(reports, v) {
  const out = [];
  for (const r of reports) { out.push(`== ${r.unit}`); for (const i of r.items) { out.push(`  ${i.verdict.padEnd(7)} ${i.day}${i.note ? " — " + i.note : ""}`); for (const s of i.structure || []) out.push(`           STRUCTURE ${s}`); for (const s of i.values || []) out.push(`           ${s}`); } }
  out.push(`COMPARE W1: ${v.text} (exit ${v.code})`);
  return out.join("\n");
}

async function main() {
  const a = process.argv.slice(2), host = (() => { const i = a.indexOf("--host"); return i >= 0 ? a[i + 1] : "traids"; })();
  if (a.includes("--selftest")) { process.exitCode = selftest() ? 0 : 1; return; }
  const M = PS.loadManifest("w1", path.join(__dirname, "manifests")), ssh = PS.sshReal(host), SH = M.shadow.data;
  const shadow = new Map(); let seeded = null;
  try {
    const mk = ssh(`cat ${PS.q(SH + "/w1-shadow-seeded.json")}`);
    if (!mk.ok) throw new Error(`no seed marker in ${SH} (exit ${mk.status}) — has deploy.cjs --step seeds run?`);
    seeded = JSON.parse(mk.out);
    for (const [, def] of Object.entries(M.units)) {
      const f = PS.fetchRemote(ssh, SH, PS.pullEntries(def), { lock: def.lock, lockWait: 30 });
      if (f.busy) throw new Error(`a shadow unit is running (${def.lock}) — try again in a few minutes`);
      for (const [k, v] of f.files) shadow.set(k, v);
    }
  } catch (e) { console.error("compare-w1: the VPS shadow tree could not be read — " + e.message); process.exitCode = 3; return; }
  const home = new Map(); for (const [, def] of Object.entries(M.units)) for (const [k, v] of PS.readLocal(PS.pullEntries(def), PS.HOME_DATA)) home.set(k, v);
  let cs = null; try { cs = JSON.parse(fs.readFileSync(path.join(PS.HOME_DATA, "chain-status.json"), "utf8")); } catch { cs = null; }
  const sMs = Date.parse(seeded.at);
  const reports = [compareWhales(home, shadow, sMs), compareR323(home, shadow, seeded.r323LedgerRows || 0), compareFunding(home, shadow, seeded.fundingNewestT == null ? NaN : Number(seeded.fundingNewestT)), compareSocial(home, shadow, sMs), runsReport(shadow, cs)];
  const v = verdictOf(reports);
  if (a.includes("--json")) console.log(JSON.stringify({ at: new Date().toISOString(), seededAt: seeded.at, verdict: v, reports }, null, 1));
  else console.log(`shadow seeded ${seeded.at} · home ${PS.HOME_DATA}\n` + render(reports, v));
  process.exitCode = v.code;
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };
  const B = (o) => Buffer.from(JSON.stringify(o)), seeded = Date.parse("2026-10-08T17:00:00Z");
  const snap = (rec, o = {}) => ({ spec: "hyperliquid-whales-v1", recordedAt: rec, positionsRule: "r", complete: true, accountsOnBoard: 30000, kept: 530, positionsFor: 133, accounts: [{ a: "0x1" }, { a: "0x2" }], positions: { "0x1": [] }, errors: [], ...o });
  const home = new Map([["hyperliquid-whales/2026-10-08.json", B(snap("2026-10-08T20:36:00Z"))], ["hyperliquid-whales/2026-10-07.json", B(snap("2026-10-07T20:36:00Z"))]]);
  const shadow = new Map([["hyperliquid-whales/2026-10-08.json", B(snap("2026-10-08T21:31:00Z", { accounts: [{ a: "0x1" }, { a: "0x3" }] }))], ["hyperliquid-whales/2026-10-07.json", B(snap("2026-10-07T20:36:00Z"))]]);
  const w = compareWhales(home, shadow, seeded);
  ok("whales: only shadow-RECORDED days compared (the seeded 10-07 copy is not a shadow night); timing and overlap reported", w.items.length === 1 && w.items[0].verdict === "AGREE" && /55 min apart/.test(w.items[0].values.join(" ")) && /kept accounts overlap 0.333/.test(w.items[0].values.join(" ")), JSON.stringify(w));
  shadow.set("hyperliquid-whales/2026-10-09.json", B(snap("2026-10-09T21:31:00Z", { complete: false })));
  home.set("hyperliquid-whales/2026-10-09.json", B(snap("2026-10-09T20:36:00Z")));
  ok("whales: an incomplete shadow snapshot -> STRUCTURE DIFFER, named", compareWhales(home, shadow, seeded).items.find((i) => i.day === "2026-10-09").verdict === "DIFFER");
  const jl = (rs) => Buffer.from(rs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const seedRows = [{ kind: "interval", day: "2026-10-05", copy: { net: 0.01 } }];
  const r = compareR323(new Map([["r323-ledger.jsonl", jl([...seedRows, { kind: "interval", day: "2026-10-06", E: 1, copy: { net: 0.02 } }])]]), new Map([["r323-ledger.jsonl", jl([...seedRows, { kind: "interval", day: "2026-10-06", E: 2, copy: { net: 0.021 } }, { kind: "gap", day: "2026-10-07" }])]]), 1);
  ok("R323: rows the shadow added are matched by kind|day; differing fields listed; a shadow-only row is a STRUCTURE difference", r.items[0].verdict === "AGREE" && /E: 1 -> 2/.test(r.items[0].values[0]) && r.items[1].verdict === "DIFFER" && /gap\|2026-10-07 on the shadow only/.test(r.items[1].structure[0]), JSON.stringify(r));
  const st = (p) => B({ periods: p }), F = (h, s, seedT = 2) => compareFunding(new Map([["funding-carry-store.json", st(h)]]), new Map([["funding-carry-store.json", st(s)]]), seedT);
  const f1 = F({ BTC: { 1: { f: 1, b: 2 }, 2: { f: 3, b: 4 }, 3: { f: 5, b: 6 } } }, { BTC: { 1: { f: 1, b: 2 }, 2: { f: 3, b: 4 }, 3: { f: 5, b: 6 }, 4: { f: 7, b: 8 } } });
  ok("funding: the periods both added since the seed identical -> AGREE; one more period on the shadow counted", f1.items[0].verdict === "AGREE" && /shadow added 2 period\(s\)/.test(f1.items[0].values[0]) && /1 new in both \(1 identical\)/.test(f1.items[0].values[0]) && /shadow only 1/.test(f1.items[0].values[0]), JSON.stringify(f1));
  const f0 = F({ BTC: { 1: { f: 1, b: 2 }, 2: { f: 3, b: 4 }, 3: { f: 5, b: 6 } } }, { BTC: { 1: { f: 1, b: 2 }, 2: { f: 3, b: 4 } } });
  ok("funding: the shadow added NO period since the seed (OKX errors swallowed, exit 0) -> DIFFER — the seeded periods alone never make AGREE", f0.items[0].verdict === "DIFFER" && /added NO funding period since the seed/.test(f0.items[0].structure.join(" ")), JSON.stringify(f0));
  const fm = F({ BTC: { 2: { f: 3, b: 4 }, 3: { f: 5, b: 6 } }, ETH: { 3: { f: 1, b: 1 } } }, { BTC: { 2: { f: 3, b: 4 }, 3: { f: 5, b: 6 }, 4: { f: 7, b: 8 } } });
  ok("funding: a period home added after the seed, up to the shadow's newest, missing on the shadow (a coin lost) -> DIFFER naming it", fm.items[0].verdict === "DIFFER" && /missing on the shadow: ETH/.test(fm.items[0].structure.join(" ")), JSON.stringify(fm));
  const f2 = F({ BTC: { 1: { f: 1, b: 2 }, 3: { f: 1, b: 2 } } }, { BTC: { 1: { f: 1, b: 2 }, 3: { f: 1, b: 9 } } });
  ok("funding: a common new period with different values -> STRUCTURE DIFFER", f2.items[0].verdict === "DIFFER" && /1 of 1 common new periods differ/.test(f2.items[0].structure.join(" ")));
  ok("funding: a seed marker without fundingNewestT -> PENDING (never AGREE on seeded data)", compareFunding(new Map([["funding-carry-store.json", st({ BTC: { 1: {} } })]]), new Map([["funding-carry-store.json", st({ BTC: { 1: {} } })]]), NaN).items[0].verdict === "PENDING");
  const r0 = compareR323(new Map([["r323-ledger.jsonl", jl(seedRows)]]), new Map([["r323-ledger.jsonl", jl(seedRows)]]), 1);
  ok("R323: the shadow added no row since the seed -> PENDING (not comparable), never AGREE", r0.items.length === 1 && r0.items[0].verdict === "PENDING");
  const rm = compareR323(new Map([["r323-ledger.jsonl", jl([...seedRows, { kind: "interval", day: "2026-10-06" }, { kind: "gap", day: "2026-10-07" }, { kind: "interval", day: "2026-10-09" }])]]), new Map([["r323-ledger.jsonl", jl([...seedRows, { kind: "interval", day: "2026-10-06" }, { kind: "interval", day: "2026-10-08" }])]]), 1);
  ok("R323: a home row for a day the shadow has scored past, missing on the shadow -> DIFFER; a home row beyond it -> INFO (not yet)", rm.items.find((i) => i.day === "gap|2026-10-07").verdict === "DIFFER" && rm.items.find((i) => i.day === "interval|2026-10-09").verdict === "INFO", JSON.stringify(rm.items));
  const so = (rec, o = {}) => ({ spec: "social-mentions-v1", recordedAt: rec, complete: true, sources: { "apewisdom:all-stocks": [{ t: "A", rank: 1 }, { t: "B", rank: 2 }], "apewisdom:all-crypto": [{ t: "BTC.X", rank: 1 }], "stocktwits:trending": [{ t: "C", rank: 1 }] }, ...o });
  const s1 = compareSocial(new Map([["social-mentions/2026-10-08.json", B(so("2026-10-08T20:35:10Z"))]]), new Map([["social-mentions/2026-10-08.json", B(so("2026-10-08T20:35:40Z"))]]), seeded);
  ok("social: same ET day, same sources, both complete -> AGREE with per-source overlap", s1.items[0].verdict === "AGREE" && /stocktwits:trending: rows 1 · 1, tickers overlap 1/.test(s1.items[0].values.join(" ")), JSON.stringify(s1));
  const s2 = compareSocial(new Map([["social-mentions/2026-10-08.json", B(so("2026-10-08T20:35:10Z"))]]), new Map([["social-mentions/2026-10-08.json", B(so("2026-10-08T20:35:40Z", { sources: { "apewisdom:all-stocks": [] } }))]]), seeded);
  ok("social: a source missing on the shadow -> STRUCTURE DIFFER", s2.items[0].verdict === "DIFFER");
  const wA = compareWhales(home, new Map([["hyperliquid-whales/2026-10-08.json", B(snap("2026-10-08T21:31:00Z"))]]), seeded), rA = { unit: "w1-whales (R323 --score)", items: [r.items[0]] };
  ok("verdict: DIFFER anywhere -> exit 1; all AGREE with an item for EACH of snapshots, R323, funding, social -> 0; no night yet -> 2", verdictOf([w, f2]).code === 1 && verdictOf([wA, rA, s1, f1]).code === 0 && verdictOf([{ unit: "w1-whales (snapshots)", items: [] }, { unit: "w1-social", items: [] }]).code === 2);
  ok("verdict: whales + social agree but R323 and funding only PENDING (the shadow added nothing) -> exit 2, never 0", verdictOf([wA, r0, s1, compareFunding(new Map(), new Map(), 2)]).code === 2 && verdictOf([wA, rA, s1]).code === 2);
  ok("render prints every item and the verdict line", /COMPARE W1: /.test(render([w], verdictOf([w]))));
  console.log(`compare-w1 selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) main().catch((e) => { console.error("compare-w1 crashed: " + (e && e.message)); process.exitCode = 3; });
module.exports = { compareWhales, compareR323, compareFunding, compareSocial, runsReport, verdictOf, diffPaths };
