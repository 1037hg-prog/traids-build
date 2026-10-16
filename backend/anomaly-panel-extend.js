#!/usr/bin/env node
/**
 * ANOMALY PANEL EXTEND (2026-09-29) — APPEND-ONLY refresh of data/anomaly-cache-v2, the point-in-time panel lib/tv-pit-panel.js reads.
 * Why: the builders (anomaly-data.js -> anomaly-data-v2.js) are one-shot — END is hard-coded to 2026-09-22 and both refuse to rebuild.
 * R281 (earnrank) forms 2027-01 on the LAST SESSION OF 2026-12 and refuses (STARVES) unless pitTopN(2027) ranks from a December-2026
 * refDate; R282 needs the same for its 2027 basket. So the panel must reach the last December session on that session's own close.
 *
 * WHAT IT GUARANTEES (checked before and after the write, not assumed):
 *   1. APPEND-ONLY. Every existing [symbol][day] cell is byte-identical; existing symbols keep their row index. Dates and new symbols
 *      are appended at the end. A study that read the panel before still reads the same numbers for the same dates.
 *   2. SAME ADJUSTMENT BASIS. The panel is Alpaca SIP adjustment=all AS OF ITS BUILD; a split or dividend since then re-bases a fresh
 *      fetch. Each symbol's tail is fetched with an OVERLAP of the panel's last 20 sessions and rescaled onto the panel's basis
 *      (price x median(old/new close), volume x median(old/new volume)). A name whose overlap ratios disagree by more than 2% (a data
 *      revision, not a corporate action) is FROZEN — padded NaN, recorded — never spliced.
 *   3. SAME TRUNCATION RULE as anomaly-data-v2.js: the first one-day close-to-close or open gap move above +300% (measured from the
 *      last trusted bar, across the seam too) ends the name's series — truncatedBefore = that date, NaN after, like a delisting.
 *      A name already truncated stays frozen.
 *   4. DELISTED NAMES STAY. Rows are never dropped; a name with no bar in the overlap window (delisted, dead) is padded NaN.
 *   5. SAME UNIVERSE RULE for names not yet in the panel (IPO'd since, or under 60 bars at build): the builder's ok() filter verbatim,
 *      bars clipped to their listing windows, first-+300%-jump truncation, >= 60 bars. Listings from a fresh Alpha Vantage
 *      LISTING_STATUS pull (saved as data/av-listing-status-{active,delisted}-<date>.csv), falling back to the newest saved pair.
 *   6. PAST UNIVERSES UNCHANGED: pitTopN(y, 1000) for every year the panel already ranked is recomputed after the write and compared.
 *      A difference is printed and recorded in meta.extensions[] (exit 1) — it would mean a sealed read no longer reproduces.
 *   7. NO FORMING BAR: refuses a through-date of today before 16:20 ET, and SPY's SIP calendar must match the panel's own dates on
 *      the overlap.
 *
 *   node backend/anomaly-panel-extend.js --year-end          close chain: no-op except on the last December session (extends through
 *                                                            it, before R281 forms) or in January if that was missed (catch-up)
 *   node backend/anomaly-panel-extend.js --through 2026-12-31 one-shot: extend through a date (a session, already closed)
 *   node backend/anomaly-panel-extend.js --through ... --dry-run   fetch + reconcile + report, write nothing
 *   add --listing-from-files to skip the Alpha Vantage pull and use the newest saved listing CSVs
 * Exit 0 = extended / not due / already current; exit 1 = could not extend (loud: R281 would starve behind it).
 */
"use strict";
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f), V2 = D("anomaly-cache-v2"), START = "2016-01-01", OVERLAP = 20, MIN_BARS = 60, TOL = 0.02;
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const DRY = argv.includes("--dry-run"), FROM_FILES = argv.includes("--listing-from-files");
const H = { "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
const AV_KEY = process.env.ALPHAVANTAGE_KEY || process.env.ALPHA_VANTAGE_KEY;

// ── verbatim from anomaly-data-v2.js (the universe rule must not drift) ────────────────────────────────────────────────────────────
const parse = (f) => { const [h, ...r] = f.trim().split(/\r?\n/); const k = h.split(","); return r.map((x) => { const c = x.split(","); return Object.fromEntries(k.map((kk, i) => [kk, c[i]])); }); };
const bad = /acquisition|capital corp|merger|spac|\bunits?\b|warrant|rights?\b|preferred|depositary|\btrust\b|\bfund\b|etf|etn|notes?\b|%|when issued|test/i;
const ok = (x) => x.assetType === "Stock" && ["NYSE", "NASDAQ", "NYSE MKT"].includes(x.exchange) && !bad.test(x.name || "") && /^[A-Z]{1,5}$/.test(x.symbol) && !/^Z[A-Z]ZZT$|^ZVV$|^ZXIET$/.test(x.symbol);
const jump = (prevC, x) => x.c / prevC - 1 > 3 || x.o / prevC - 1 > 3;
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const et = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, mins: +p.hour * 60 + +p.minute }; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
async function calendar(start, end) { const r = await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${start}&end=${end}`, { headers: H, signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error("calendar HTTP " + r.status); return (await r.json()).map((c) => c.date); }
async function bars(syms, start, end) { for (let k = 0; ; k++) { try { return (await fetchBars(syms, { start, end, feed: "sip", adjustment: "all", requireAll: false, quiet: true })).bars; } catch (e) { if (k === 2) throw e; await new Promise((z) => setTimeout(z, 5000)); } } }
const readMeta = () => JSON.parse(fs.readFileSync(path.join(V2, "meta.json"), "utf8"));

async function listings() {
  const today = et().date;
  if (!FROM_FILES && AV_KEY) {
    try {
      const out = {};
      for (const state of ["active", "delisted"]) {
        const r = await fetch(`https://www.alphavantage.co/query?function=LISTING_STATUS&state=${state}&apikey=${AV_KEY}`, { signal: AbortSignal.timeout(60000) });
        const txt = await r.text(); if (!r.ok || !txt.startsWith("symbol,")) throw new Error(`LISTING_STATUS ${state}: unexpected response (${r.status}, ${txt.length} chars)`);
        out[state] = txt;
      }
      if (!DRY) for (const s of ["active", "delisted"]) fs.writeFileSync(D(`av-listing-status-${s}-${today}.csv`), out[s]);
      return { source: `Alpha Vantage LISTING_STATUS pulled ${today}`, active: out.active, delisted: out.delisted };
    } catch (e) { console.log(`  listing pull failed (${e.message}) — using the newest saved CSVs`); }
  }
  const newest = (s) => fs.readdirSync(D("")).filter((f) => new RegExp(`^av-listing-status-${s}-\\d{4}-\\d{2}-\\d{2}\\.csv$`).test(f)).sort().at(-1);
  const a = newest("active"), d = newest("delisted"); if (!a || !d) throw new Error("no saved LISTING_STATUS CSVs");
  return { source: `saved files ${a} + ${d}`, active: fs.readFileSync(D(a), "utf8"), delisted: fs.readFileSync(D(d), "utf8") };
}

/** pitTopN(y, 1000) for every year the panel already ranks, in a fresh process (the lib caches its panel per process). */
function pastUniverses(lastYear) {
  const r = spawnSync(process.execPath, ["-e", `const {pitTopN}=require(${JSON.stringify(path.join(__dirname, "lib", "tv-pit-panel.js"))});const o={};for(let y=2016;y<=${lastYear};y++){const u=pitTopN(y,1000);o[y]=u.refDate+"|"+u.names.join(",");}process.stdout.write(JSON.stringify(o));`], { encoding: "utf8", maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error("pitTopN check failed: " + String(r.stderr).slice(-300));
  return JSON.parse(r.stdout);
}

async function extend(through, why) {
  const meta = readMeta(), T = meta.dates.length, N = meta.symbols.length, oldLast = meta.dates[T - 1];
  if (through <= oldLast) { console.log(`anomaly-cache-v2 already through ${oldLast} (asked ${through}) — nothing to do`); return 0; }
  const now = et(); if (through > now.date || (through === now.date && now.mins < 16 * 60 + 20)) throw new Error(`refusing: ${through} has not closed yet (ET ${now.date} ${Math.floor(now.mins / 60)}:${String(now.mins % 60).padStart(2, "0")}) — forming bar`);
  const ovStart = meta.dates[T - OVERLAP], endISO = new Date(Math.min(Date.parse(through + "T23:59:00Z"), Date.now() - 16 * 60000)).toISOString();

  // calendar: SPY's SIP sessions must reproduce the panel's own last OVERLAP dates, then supply the new ones
  const spy = (await bars(["SPY"], ovStart, endISO)).SPY || [], sd = spy.map((b) => b.t.slice(0, 10));
  const ovDates = meta.dates.slice(T - OVERLAP); if (sd.slice(0, OVERLAP).join() !== ovDates.join()) throw new Error("SPY SIP sessions disagree with the panel's own last dates on the overlap");
  const newDates = sd.filter((d) => d > oldLast && d <= through); if (!newDates.length) throw new Error(`SIP has no session after ${oldLast} through ${through} yet`);
  if (newDates.at(-1) !== through) console.log(`  note: last SIP session <= ${through} is ${newDates.at(-1)}`);
  const T2 = T + newDates.length, allDates = [...meta.dates, ...newDates], di = new Map(allDates.map((d, i) => [d, i]));

  const L = await listings();
  const recs = [...parse(L.active).filter(ok).map((x) => ({ ...x, state: "active" })), ...parse(L.delisted).filter((x) => ok(x) && x.delistingDate >= "2016-01-01").map((x) => ({ ...x, state: "delisted" }))];
  const bySym = new Map(); for (const r of recs) (bySym.get(r.symbol) || bySym.set(r.symbol, []).get(r.symbol)).push({ ipo: r.ipoDate, del: r.delistingDate && r.delistingDate !== "null" ? r.delistingDate : "9999-12-31", name: r.name, state: r.state });

  const rd = (f) => { const b = fs.readFileSync(path.join(V2, f)); return new Float32Array(b.buffer, b.byteOffset, N * T); };
  const C = rd("close.f32"), O = rd("open.f32"), V = rd("vol.f32");
  const C2 = new Float32Array(N * T2).fill(NaN), O2 = new Float32Array(N * T2).fill(NaN), V2m = new Float32Array(N * T2).fill(NaN);
  for (let i = 0; i < N; i++) { C2.set(C.subarray(i * T, i * T + T), i * T2); O2.set(O.subarray(i * T, i * T + T), i * T2); V2m.set(V.subarray(i * T, i * T + T), i * T2); }

  // 1) existing names: overlap-rescaled tail + truncation across the seam
  const info = meta.info.map((x) => ({ ...x })), rep = { extended: 0, rebased: 0, frozen: { alreadyTruncated: 0, noOverlap: 0, overlapMismatch: [] }, truncatedInTail: [] };
  const live = [];
  for (let i = 0; i < N; i++) {
    if (info[i].truncatedBefore) { rep.frozen.alreadyTruncated++; continue; }
    let has = false; for (let t = T - OVERLAP; t < T; t++) if (C[i * T + t] > 0) { has = true; break; }
    if (has) live.push(i); else rep.frozen.noOverlap++;
  }
  for (let k = 0; k < live.length; k += 50) {
    const idx = live.slice(k, k + 50), got = await bars(idx.map((i) => meta.symbols[i]), ovStart, endISO);
    for (const i of idx) {
      const s = meta.symbols[i], by = new Map((got[s] || []).map((b) => [b.t.slice(0, 10), b])), pc = [], pv = [];
      for (let t = T - OVERLAP; t < T; t++) { const b = by.get(meta.dates[t]), c = C[i * T + t], v = V[i * T + t]; if (b && c > 0 && b.c > 0) pc.push(c / b.c); if (b && v > 0 && b.v > 0) pv.push(v / b.v); }
      if (!pc.length) { rep.frozen.noOverlap++; continue; }
      const pf = median(pc), vf = pv.length ? median(pv) : 1 / pf;
      if (pc.some((r) => Math.abs(r / pf - 1) > TOL)) { rep.frozen.overlapMismatch.push(s); continue; }
      if (Math.abs(pf - 1) > 1e-6) rep.rebased++;
      const win = bySym.get(s) || info[i].listings; let prev = NaN; for (let t = T - 1; t >= 0; t--) if (C[i * T + t] > 0) { prev = C[i * T + t]; break; }
      for (const d of newDates) {
        const b = by.get(d); if (!b || !win.some((w) => d >= w.ipo && d <= w.del)) continue;
        const x = { c: b.c * pf, o: b.o * pf, v: b.v * vf };
        if (jump(prev, x)) { info[i].truncatedBefore = d; rep.truncatedInTail.push(`${s}@${d}`); break; }
        const j = i * T2 + di.get(d); C2[j] = x.c; O2[j] = x.o; V2m[j] = x.v; prev = x.c;
      }
      rep.extended++;
    }
    process.stdout.write(`  extend ${Math.min(k + 50, live.length)}/${live.length}\r`);
  }

  // 2) names not yet in the panel that were listed after the old last date: the builder's rule, full history
  const inPanel = new Set(meta.symbols), todo = [...bySym.keys()].filter((s) => !inPanel.has(s) && bySym.get(s).some((w) => w.del >= newDates[0])).sort();
  const add = { syms: [], info: [], C: [], O: [], V: [] }; let tooShort = 0, addTrunc = 0;
  for (let k = 0; k < todo.length; k += 50) {
    const chunk = todo.slice(k, k + 50), got = await bars(chunk, START, endISO);
    for (const s of chunk) {
      const win = bySym.get(s), kept = (got[s] || []).filter((x) => di.has(x.t.slice(0, 10)) && win.some((w) => x.t.slice(0, 10) >= w.ipo && x.t.slice(0, 10) <= w.del));
      let cut = kept.length, cutDate = null; for (let q = 1; q < kept.length; q++) if (jump(kept[q - 1].c, kept[q])) { cut = q; cutDate = kept[q].t.slice(0, 10); break; }
      const use = kept.slice(0, cut); if (use.length < MIN_BARS) { tooShort++; continue; }
      if (cutDate) addTrunc++;
      const c = new Float32Array(T2).fill(NaN), o = new Float32Array(T2).fill(NaN), v = new Float32Array(T2).fill(NaN);
      for (const x of use) { const j = di.get(x.t.slice(0, 10)); c[j] = x.c; o[j] = x.o; v[j] = x.v; }
      add.syms.push(s); add.info.push({ s, listings: win, truncatedBefore: cutDate, addedBy: `anomaly-panel-extend ${through}` }); add.C.push(c); add.O.push(o); add.V.push(v);
    }
    process.stdout.write(`  new names ${Math.min(k + 50, todo.length)}/${todo.length} · added ${add.syms.length}   \r`);
  }

  // invariant 1, checked on the assembled matrices before anything is written
  for (const [a, b] of [[C, C2], [O, O2], [V, V2m]]) {
    const oa = new Uint32Array(a.buffer, a.byteOffset, N * T), ob = new Uint32Array(b.buffer, b.byteOffset, N * T2);
    for (let i = 0; i < N; i++) for (let t = 0; t < T; t++) if (oa[i * T + t] !== ob[i * T2 + t]) throw new Error(`append-only violated at ${meta.symbols[i]} ${meta.dates[t]}`);
  }
  const N2 = N + add.syms.length;
  const ext = { at: new Date().toISOString(), why, from: oldLast, through: newDates.at(-1), newSessions: newDates.length, listingSource: L.source, overlapSessions: OVERLAP, mismatchTolerance: TOL,
    extended: rep.extended, rebasedToPanelBasis: rep.rebased, frozen: { alreadyTruncated: rep.frozen.alreadyTruncated, noOverlapBar: rep.frozen.noOverlap, overlapMismatch: rep.frozen.overlapMismatch }, truncatedInTail: rep.truncatedInTail,
    newNames: { candidates: todo.length, added: add.syms.length, truncated: addTrunc, tooShort } };
  console.log(`\n${DRY ? "DRY RUN — " : ""}anomaly-cache-v2 ${oldLast} -> ${ext.through} (+${newDates.length} sessions): ${rep.extended} names extended (${rep.rebased} rebased onto the panel's adjustment basis), frozen ${rep.frozen.alreadyTruncated} truncated + ${rep.frozen.noOverlap} no-overlap + ${rep.frozen.overlapMismatch.length} mismatch, ${rep.truncatedInTail.length} truncated in the tail; ${add.syms.length} new names of ${todo.length} candidates (${tooShort} under ${MIN_BARS} bars) · listings: ${L.source}`);
  if (rep.frozen.overlapMismatch.length) console.log(`  overlap mismatch (frozen): ${rep.frozen.overlapMismatch.slice(0, 30).join(" ")}`);
  if (rep.truncatedInTail.length) console.log(`  truncated in tail: ${rep.truncatedInTail.slice(0, 30).join(" ")}`);
  if (DRY) return 0;

  const lastYear = +oldLast.slice(0, 4), before = pastUniverses(lastYear);
  const tmp = (f) => path.join(V2, f + ".tmp"), put = (f, base, extra) => { const buf = Buffer.alloc(N2 * T2 * 4); Buffer.from(base.buffer, base.byteOffset, N * T2 * 4).copy(buf, 0); extra.forEach((a, k) => Buffer.from(a.buffer).copy(buf, (N + k) * T2 * 4)); fs.writeFileSync(tmp(f), buf); };
  put("close.f32", C2, add.C); put("open.f32", O2, add.O); put("vol.f32", V2m, add.V);
  const m2 = { ...meta, dates: allDates, symbols: [...meta.symbols, ...add.syms], info: [...info, ...add.info], counts: { ...meta.counts, total: N2 }, extensions: [...(meta.extensions || []), ext] };
  fs.writeFileSync(tmp("meta.json"), JSON.stringify(m2));
  for (const f of ["close.f32", "open.f32", "vol.f32", "meta.json"]) fs.renameSync(tmp(f), path.join(V2, f));   // meta last: it carries the new N x T

  const after = pastUniverses(lastYear), changed = Object.keys(before).filter((y) => before[y] !== after[y]);
  ext.pastUniversesUnchanged = changed.length === 0; if (changed.length) ext.pastUniversesChanged = changed;
  const m3 = readMeta(); m3.extensions[m3.extensions.length - 1] = ext; fs.writeFileSync(tmp("meta.json"), JSON.stringify(m3)); fs.renameSync(tmp("meta.json"), path.join(V2, "meta.json"));
  const u = pastUniverses(lastYear + 1)[lastYear + 1].split("|")[0];
  console.log(`  written: ${N2} symbols x ${T2} sessions · past pitTopN(y,1000) 2016..${lastYear} ${changed.length ? "CHANGED for " + changed.join(",") : "unchanged"} · pitTopN(${lastYear + 1}) refDate ${u}`);
  return changed.length ? 1 : 0;
}

(async () => {
  let code;
  if (argv.includes("--year-end")) {
    const { date } = et(), y = +date.slice(0, 4), mo = +date.slice(5, 7);
    if (mo !== 12 && mo !== 1) { console.log(`year-end panel refresh: not due (${date}; runs on the last December session, January catch-up)`); process.exit(0); }
    const Y = mo === 12 ? y : y - 1, target = (await calendar(`${Y}-12-01`, `${Y}-12-31`)).at(-1), last = readMeta().dates.at(-1);
    if (last >= target) { console.log(`year-end panel refresh: current (panel through ${last}, target ${target})`); process.exit(0); }
    if (mo === 12 && date !== target) { console.log(`year-end panel refresh: not due until ${target} (panel through ${last})`); process.exit(0); }
    code = await extend(target, mo === 12 ? `year-end: last session of ${Y}-12, before R281 forms ${Y + 1}-01` : `January catch-up: panel missed ${target}`);
  } else {
    const through = arg("--through"); if (!/^\d{4}-\d{2}-\d{2}$/.test(through || "")) { console.log("usage: --year-end | --through YYYY-MM-DD [--dry-run] [--listing-from-files]"); process.exit(2); }
    code = await extend(through, "one-shot --through");
  }
  process.exit(code);
})().catch((e) => { console.error("anomaly-panel-extend FAILED:", e.message); process.exit(1); });
