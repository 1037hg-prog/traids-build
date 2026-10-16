#!/usr/bin/env node
/**
 * R179 — RETAIL CHATTER vs SUBSEQUENT MOVEMENT (registered 2026-09-24; rule frozen in data/test-registry.json).
 * Nightly: rebuilds every signal from data/social-mentions/<day>.json, prices the completed horizons from Alpaca SIP daily bars (stocks) and
 * Coinbase daily candles (crypto), and writes data/r179-chatter.json. Nothing trades. --read takes the one registered read (read-once).
 *   node backend/r179-chatter-grade.js          nightly status
 *   node backend/r179-chatter-grade.js --read   the read (refuses before the primary cell has 40 signal days, or if sealed)
 *   node backend/r179-chatter-grade.js --selftest-weekday   known answers for the weekday-files amendment (no network; writes only in os.tmpdir())
 * Amendment weekday-files-2026-10-08 (operator "R179 A"): WEEKDAY snapshot files only — see listDays() below.
 * Dated note holiday-files-note-2026-10-08 (OPEN, the operator's decision before 2026-11-26): weekday files dated an NYSE full closure
 * (lib/run-window.js MARKET_HOLIDAYS) — the home chain never wrote one, the VPS will — are READ exactly as before (no statistic changes);
 * they are reported nightly (weekdayHolidayFiles) and --read refuses while one is present until an amendment with decides "holiday-files".
 */
const fs = require("fs"), path = require("path"), os = require("os");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const { marketHoliday, MARKET_HOLIDAYS } = require("./lib/run-window.js");
const D = (f) => path.join(__dirname, "data", f), SNAP = D("social-mentions");
const READ = process.argv.includes("--read");
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), ENTRY = reg.preregistered.find((t) => t.id === "R179"); const BAR = ENTRY.bar.tRequired;
const HS = { S1: [1, 5, 20], S2: [1, 5, 20], S3: [1, 5] }, PRIMARY = "S1:5", MIN_DAYS = 40, NCTRL = 5;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function nwT(a, L) { const n = a.length; if (n < 3) return null; const m = mean(a), d = a.map((x) => x - m); let v = d.reduce((s, x) => s + x * x, 0) / n; for (let l = 1; l <= Math.min(L, n - 1); l++) { let g = 0; for (let i = l; i < n; i++) g += d[i] * d[i - l]; v += 2 * (1 - l / (L + 1)) * g / n; } return v > 0 ? m / Math.sqrt(v / n) : null; }
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const okTicker = (t) => /^[A-Z]{1,5}$/.test(t || "");
// AMENDMENT weekday-files-2026-10-08 (operator decision "R179 A"): R179 reads WEEKDAY snapshot files only. A file whose date — its own name,
// the ET day of the recorder's run — is a Saturday or Sunday is ignored by every statistic; because the list below is the only place files
// are listed, S2's "previous recorded day" (days[i - 1] in buildSignals) is the previous WEEKDAY file. Weekend files exist from 2026-10-10
// (the VPS recorder runs 7 days a week); none existed when this was amended, so the population is the registered one.
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/, KEY_WEEKDAY = "weekday-files-2026-10-08";
const isWeekendDay = (d) => { const w = new Date(d + "T00:00:00Z").getUTCDay(); return w === 0 || w === 6; };
function listDays(names) { const all = names.filter((f) => DAY_FILE.test(f)).map((f) => f.slice(0, 10)).sort(); return { days: all.filter((d) => !isWeekendDay(d)), weekendIgnored: all.filter(isWeekendDay) }; }
/** the weekday files and their snapshots — main's ONLY file listing and read (tested by --selftest-weekday on a temporary folder) */
function loadSnapshots(dir) {
  const listed = listDays(fs.existsSync(dir) ? fs.readdirSync(dir) : []), days = listed.days;
  return { listed, days, snaps: Object.fromEntries(days.map((d) => [d, JSON.parse(fs.readFileSync(path.join(dir, d + ".json"), "utf8"))])) };
}
// DATED NOTE holiday-files-note-2026-10-08 (OPEN): which weekday files are dated an NYSE full closure, or lie past the holiday list (unknowable)
const HOL_LAST = Object.keys(MARKET_HOLIDAYS).sort().pop();
function holidayAudit(days) { return { holidayFiles: days.filter((d) => !!marketHoliday(d)), pastHolidayList: days.filter((d) => d > HOL_LAST), holidayListEnds: HOL_LAST }; }
const holidayDecision = (entry) => (entry && entry.amendments || []).find((a) => a && a.decides === "holiday-files") || null;
function holidayReadBlock(audit, entry) {
  if (holidayDecision(entry) || (!audit.holidayFiles.length && !audit.pastHolidayList.length)) return null;
  return `weekday file(s) dated an NYSE full closure (${audit.holidayFiles.join(", ") || "none"}) or past the holiday list ending ${audit.holidayListEnds} (${audit.pastHolidayList.join(", ") || "none"}) and no amendment decides "holiday-files" (dated note holiday-files-note-2026-10-08: OPEN, the operator's decision) — refusing the read`;
}
function buildSignals(days, snaps) {
  const sig = [];   // { day, leg, t, pool? }
  days.forEach((d, i) => {
    const s = snaps[d].sources || {}, st = s["apewisdom:all-stocks"] || [], cr = s["apewisdom:all-crypto"] || [];
    const spike = (r, minM) => r.m >= minM && r.m >= 3 * Math.max(r.m24 ?? 0, 3);
    const s1 = st.filter((r) => okTicker(r.t) && r.rank <= 100 && spike(r, 20)).map((r) => r.t), s1set = new Set(s1);
    const pool = st.filter((r) => okTicker(r.t) && !s1set.has(r.t)).map((r) => r.t);
    s1.forEach((t) => sig.push({ day: d, leg: "S1", t, pool }));
    if (i > 0) { const prev = new Set((snaps[days[i - 1]].sources?.["stocktwits:trending"] || []).map((r) => r.t)); (s["stocktwits:trending"] || []).filter((r) => okTicker(r.t) && !prev.has(r.t)).forEach((r) => sig.push({ day: d, leg: "S2", t: r.t, pool })); }
    cr.filter((r) => spike(r, 10) && /\.X$/.test(r.t || "") && r.t !== "BTC.X").forEach((r) => sig.push({ day: d, leg: "S3", t: r.t.replace(/\.X$/, "") }));
  });
  return sig;
}
if (process.argv.includes("--selftest-weekday")) {   // known answers; synthetic snapshots only — no network, no writes
  const res = [], chk = (name, pass, got) => res.push({ name, pass: !!pass, got });
  const L = listDays(["2026-10-12.json", "2026-10-08.json", "2026-10-10.json", "notes.txt", "2026-10-09.json", "2026-10-11.json", "2026-10-09.json.tmp-7"]);
  chk("listDays keeps Thu/Fri/Mon in order", JSON.stringify(L.days) === '["2026-10-08","2026-10-09","2026-10-12"]', L.days);
  chk("listDays ignores Sat/Sun", JSON.stringify(L.weekendIgnored) === '["2026-10-10","2026-10-11"]', L.weekendIgnored);
  chk("calendar (date string, not the host clock)", isWeekendDay("2026-10-10") && isWeekendDay("2026-10-11") && isWeekendDay("2026-10-04") && !isWeekendDay("2026-10-09") && !isWeekendDay("2026-10-12") && !isWeekendDay("2026-09-24"));
  const tw = (ts) => ({ sources: { "stocktwits:trending": ts.map((t) => ({ t })) } });
  const syn = { "2026-10-09": tw(["AAA"]), "2026-10-10": tw(["BBB"]), "2026-10-11": tw(["CCC"]), "2026-10-12": tw(["AAA", "BBB", "CCC", "DDD"]) };
  const monS2 = (days) => buildSignals(days, syn).filter((x) => x.leg === "S2" && x.day === "2026-10-12").map((x) => x.t).sort();
  const a = monS2(listDays(Object.keys(syn).map((d) => d + ".json")).days), all = monS2(Object.keys(syn).sort());
  chk("Monday S2 compares with FRIDAY's list", JSON.stringify(a) === '["BBB","CCC","DDD"]', a);
  chk("teeth: reading every file would compare with Sunday's", JSON.stringify(all) === '["AAA","BBB","DDD"]', all);
  const cx = { sources: { "apewisdom:all-crypto": [{ t: "DOGE.X", rank: 1, m: 50, m24: 5 }] } }, syn3 = { "2026-10-09": cx, "2026-10-10": cx, "2026-10-11": cx, "2026-10-12": cx };
  const s3 = buildSignals(listDays(Object.keys(syn3).map((d) => d + ".json")).days, syn3).filter((x) => x.leg === "S3").map((x) => x.day);
  chk("no weekend S3 (crypto) signal day", JSON.stringify(s3) === '["2026-10-09","2026-10-12"]', s3);
  // main's loader on a temporary folder (main's only listing): weekend files and non-day names are never loaded; Monday's S2 vs Friday
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r179-selftest-"));
  try {
    for (const d of Object.keys(syn)) fs.writeFileSync(path.join(tmp, d + ".json"), JSON.stringify(syn[d]));
    fs.writeFileSync(path.join(tmp, "2026-10-12.json.tmp-1"), "{"); fs.writeFileSync(path.join(tmp, "notes.txt"), "x");
    const LS = loadSnapshots(tmp), sigL = buildSignals(LS.days, LS.snaps).filter((x) => x.leg === "S2" && x.day === "2026-10-12").map((x) => x.t).sort();
    chk("main's loader: weekday files only, Monday S2 vs Friday", JSON.stringify(LS.days) === '["2026-10-09","2026-10-12"]' && JSON.stringify(Object.keys(LS.snaps).sort()) === '["2026-10-09","2026-10-12"]' && JSON.stringify(LS.listed.weekendIgnored) === '["2026-10-10","2026-10-11"]' && JSON.stringify(sigL) === '["BBB","CCC","DDD"]', { days: LS.days, sigL });
    chk("main's loader: a missing folder -> no days", loadSnapshots(path.join(tmp, "absent")).days.length === 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  // dated note holiday-files-note-2026-10-08: holiday files are READ as before, reported, and block the read until decided
  const ha = holidayAudit(["2026-11-25", "2026-11-26", "2026-11-27", "2026-12-25", "2027-12-27", "2028-01-03"]), none = holidayAudit(["2026-11-25", "2026-11-27"]);
  chk("holiday audit: NYSE full closures from lib/run-window.js; dates past the list flagged", JSON.stringify(ha.holidayFiles) === '["2026-11-26","2026-12-25"]' && JSON.stringify(ha.pastHolidayList) === '["2027-12-27","2028-01-03"]' && !none.holidayFiles.length && !none.pastHolidayList.length, ha);
  chk("read interlock: blocks while undecided, lifts on a 'holiday-files' decision, absent without holiday files", !!holidayReadBlock(ha, { amendments: [{ key: KEY_WEEKDAY }] }) && !!holidayReadBlock(holidayAudit(["2028-01-03"]), {}) && holidayReadBlock(ha, { amendments: [{ key: "x", decides: "holiday-files" }] }) === null && holidayReadBlock(none, { amendments: [] }) === null);
  chk("holiday files are still read (no statistic changes until a decision)", JSON.stringify(listDays(["2026-11-25.json", "2026-11-26.json", "2026-11-27.json"]).days) === '["2026-11-25","2026-11-26","2026-11-27"]');
  const real = listDays(fs.existsSync(SNAP) ? fs.readdirSync(SNAP) : []);
  const nPass = res.filter((r) => r.pass).length, ok = nPass === res.length;
  console.log(`R179 selftest-weekday ${ok ? "PASS" : "FAIL"} ${nPass}/${res.length} · folder now: ${real.days.length} weekday file(s), ${real.weekendIgnored.length} weekend file(s) ignored`);
  res.filter((r) => !r.pass).forEach((r) => console.log(`  FAIL ${r.name}: got ${JSON.stringify(r.got)}`));
  process.exit(ok ? 0 : 1);
}

(async () => {
  const { listed, days, snaps } = loadSnapshots(SNAP), hol = holidayAudit(days);   // the ONLY file listing (weekday files only)
  // signals per day
  const sig = buildSignals(days, snaps);
  // stock prices: raw (screen) and split-adjusted (returns)
  const stockSyms = [...new Set(["SPY", ...sig.filter((x) => x.leg !== "S3").flatMap((x) => [x.t, ...x.pool]) ])];
  const start = days[0] || new Date().toISOString().slice(0, 10), end = new Date(Date.now() - 20 * 60000).toISOString();
  let raw = {}, adj = {};
  if (stockSyms.length > 1) {
    raw = (await fetchBars(stockSyms, { start, end, feed: "sip", adjustment: "raw", requireAll: false, requireSymbols: ["SPY"], chunkSize: 100, quiet: true })).bars;
    adj = (await fetchBars(stockSyms, { start, end, feed: "sip", adjustment: "split", requireAll: false, requireSymbols: ["SPY"], chunkSize: 100, quiet: true })).bars;
  }
  const cal = (adj.SPY || []).map((b) => b.t.slice(0, 10));
  const idx = (sym, src) => { const m = new Map(); (src[sym] || []).forEach((b) => m.set(b.t.slice(0, 10), b)); return m; };
  const cacheR = {}, cacheA = {}; const R = (s) => (cacheR[s] = cacheR[s] || idx(s, raw)), A = (s) => (cacheA[s] = cacheA[s] || idx(s, adj));
  const eligible = (s, d) => { const b = R(s).get(d); return b && b.c >= 2; };
  function stockRet(s, d, h) { const i0 = cal.findIndex((x) => x > d); if (i0 < 0 || i0 + h - 1 >= cal.length) return null; const e = A(s).get(cal[i0]), x = A(s).get(cal[i0 + h - 1]); return e && x && e.o > 0 ? x.c / e.o - 1 : NaN; }
  // crypto prices (Coinbase daily, UTC)
  const cb = {};
  async function coin(c) { if (cb[c]) return cb[c]; const m = new Map(); try { const r = await fetch(`https://api.exchange.coinbase.com/products/${c}-USD/candles?granularity=86400&start=${start}T00:00:00Z&end=${new Date().toISOString()}`, { headers: { "User-Agent": "TRAIDS R179" } }); if (r.ok) for (const [t, , , o, c2] of await r.json()) m.set(new Date(t * 1000).toISOString().slice(0, 10), { o, c: c2 }); } catch {} await new Promise((r) => setTimeout(r, 350)); return (cb[c] = m); }
  const utcAdd = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  // grade
  const cells = {};
  for (const x of sig) {
    for (const h of HS[x.leg]) {
      const key = `${x.leg}:${h}`; cells[key] = cells[key] || {};
      let ex = null;
      if (x.leg === "S3") {
        const snapUtc = (snaps[x.day].recordedAt || x.day).slice(0, 10), eD = utcAdd(snapUtc, 1), xD = utcAdd(snapUtc, 1 + h), m = await coin(x.t), b = await coin("BTC");
        const e = m.get(eD), z = m.get(xD), be = b.get(eD), bz = b.get(xD); if (!e || !z || !be || !bz) continue;
        ex = (z.o / e.o - 1) - (bz.o / be.o - 1);
      } else {
        if (!eligible(x.t, x.day)) continue; const r = stockRet(x.t, x.day, h); if (r == null || !Number.isFinite(r)) continue;
        const rng = mulberry(hash(x.day + x.t + x.leg)), cand = x.pool.filter((s) => s !== x.t && eligible(s, x.day)); const ctl = [];
        for (let k = 0; k < cand.length && ctl.length < NCTRL; k++) { const j = k + Math.floor(rng() * (cand.length - k)); [cand[k], cand[j]] = [cand[j], cand[k]]; const cr = stockRet(cand[k], x.day, h); if (cr != null && Number.isFinite(cr)) ctl.push(cr); }
        if (ctl.length < 3) continue; ex = r - mean(ctl);
      }
      (cells[key][x.day] = cells[key][x.day] || []).push(ex);
    }
  }
  const summary = {};
  for (const leg of Object.keys(HS)) for (const h of HS[leg]) { const key = `${leg}:${h}`, byDay = cells[key] || {}, series = Object.keys(byDay).sort().map((d) => mean(byDay[d]));
    summary[key] = { signalDays: series.length, names: Object.values(byDay).reduce((s, a) => s + a.length, 0), meanExcessPct: series.length ? +(100 * mean(series)).toFixed(3) : null, tNW: series.length >= 3 ? +nwT(series, h - 1).toFixed(3) : null }; }
  const primaryDays = summary[PRIMARY].signalDays;
  const hits = Object.entries(summary).filter(([, v]) => v.signalDays >= MIN_DAYS && v.tNW != null && Math.abs(v.tNW) >= BAR);
  const verdict = primaryDays < MIN_DAYS ? `ACCRUING — primary ${PRIMARY} ${primaryDays}/${MIN_DAYS} signal days` : hits.length ? `PASS — ${hits.map(([k, v]) => `${k} ${v.tNW > 0 ? "continuation" : "FADE"} ${v.meanExcessPct}% t ${v.tNW}`).join("; ")} (|t| >= ${BAR})` : `DID NOT PASS — no cell reaches |t| ${BAR}`;
  const holDecided = holidayDecision(ENTRY), holOpen = !holDecided && (hol.holidayFiles.length || hol.pastHolidayList.length);
  const out = { spec: "r179-chatter-v1", test: "R179", asOf: new Date().toISOString(), snapshotDays: days.length, weekendFilesIgnored: listed.weekendIgnored.length,
    weekdayHolidayFiles: hol.holidayFiles, weekdayFilesPastHolidayList: hol.pastHolidayList, holidayFiles: holDecided ? `decided: ${holDecided.key}` : "OPEN — dated note holiday-files-note-2026-10-08 (read as weekday files; --read refuses while one is present)", signalsByLeg: { S1: sig.filter((x) => x.leg === "S1").length, S2: sig.filter((x) => x.leg === "S2").length, S3: sig.filter((x) => x.leg === "S3").length }, cells: summary, bar: BAR, verdict };
  if (READ) {
    const hb = holidayReadBlock(hol, ENTRY); if (hb) { console.error(`R179: ${hb}`); process.exit(2); }
    const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8"));
    if (seals.tests.R179) { console.error("R179 already sealed — refusing"); process.exit(2); }
    if (primaryDays < MIN_DAYS) { console.error(`read condition not met: ${primaryDays}/${MIN_DAYS}`); process.exit(2); }
    seals.tests.R179 = { sealedOn: new Date().toISOString().slice(0, 10), unit: "signal days", verdict }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
    ENTRY.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + verdict; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
    fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: "R179", verdict }) + "\n");
  }
  writeJsonAtomic(D("r179-chatter.json"), out);
  console.log(`R179 — ${verdict} · signals ${JSON.stringify(out.signalsByLeg)} · snapshot days ${days.length}${listed.weekendIgnored.length ? ` · weekend files ignored ${listed.weekendIgnored.length} (amendment weekday-files-2026-10-08)` : ""}${holOpen ? ` · WARN weekday file(s) on an NYSE full closure or past the holiday list read as before (${[...hol.holidayFiles, ...hol.pastHolidayList].join(", ")}) — OPEN, the operator's decision (dated note holiday-files-note-2026-10-08); --read refuses until decided` : ""}`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
