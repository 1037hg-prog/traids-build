#!/usr/bin/env node
/**
 * COMPARE — the dry period: the shadow's files (VPS, /home/traids/w1c2a-shadow/backend/data, written by traids-spread-shadow /
 * traids-fills-shadow while home owns the units) against home's same period. Read-only on both hosts (one ssh `cat` each). 2026-10-08
 * (docs/server/wave1c-2a). Run it before each cutover (NOTES.md).
 *
 *   node docs/server/wave1c-2a/compare.cjs w1c [--since <ISO>]   SPREAD: cadence + rows parity since the shadow's first run
 *   node docs/server/wave1c-2a/compare.cjs w2a [YYYY-MM-DD]      FILLS: home's ET day (default: the last weekday whose 18:30 ET has passed)
 *   node docs/server/wave1c-2a/compare.cjs --selftest
 *
 * w1c  CADENCE: the shadow runs every 15 min — any gap over 20 min (a missed run) or under 10 (a double run), or a last run over 20 min
 *      ago, is DIFFER. ROWS: each home run (every 30 min, weekdays 07:40-14:40 MT) is paired with the nearest shadow run within 8 min;
 *      on the symbols both lists hold, the pair's row count and its alpaca / coinbase split must agree within 2 (a book can be fresh on
 *      one host and stale on the other a minute later); the row keys per venue must be identical; a symbol home quoted in at least half of
 *      its runs must be quoted by the shadow too. Spreads differ by design (minutes apart): their median |difference| is reported only.
 * w2a  the window both hosts recorded: from home's stream start that day (automation\alpaca-fills-stream.log "recording" line; else
 *      06:00 ET) to 18:30 ET. Every event (account, order id, event, filled qty, status) home recorded must be in the shadow and vice
 *      versa — counts per account printed (home recorded 621 on 2026-10-06). The shadow's TV events outside the window are its 24/7
 *      extension (reported); a main / book event outside the window is DIFFER (the flag leaked).
 * Exit 0 SAME · 1 DIFFER (each named) · 2 NOT YET comparable, or a file unreadable.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", "..");
const SBD = "/home/traids/w1c2a-shadow/backend/data";
const MIN = 60000;

const jsonl = (txt) => String(txt || "").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const etOf = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, wd: p.weekday }; };
/** the UTC ms of hh:mm New York time on an ET day (EDT or EST, whichever reads back) */
function etMs(day, hm) { for (const off of [4, 5]) { const t = Date.parse(`${day}T${hm}:00Z`) + off * 3600000, e = etOf(t); if (e.day === day && e.hm === hm) return t; } return NaN; }
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ── w1c ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function compareSpread(homeRows, shadowRows, { from, to, shadowSymbols = null } = {}) {
  const diffs = [], info = [];
  const inWin = (r) => { const t = Date.parse(r.runAt); return Number.isFinite(t) && t >= from && t <= to; };
  const runs = (rows) => { const m = new Map(); for (const r of rows.filter(inWin)) { if (!m.has(r.runAt)) m.set(r.runAt, []); m.get(r.runAt).push(r); } return [...m.entries()].map(([at, rs]) => ({ t: Date.parse(at), at, rs })).sort((a, b) => a.t - b.t); };
  const S = runs(shadowRows), H = runs(homeRows);
  if (S.length < 2) return { verdict: "NOT YET", lines: [`the shadow has ${S.length} run(s) since ${new Date(from).toISOString()} — not comparable yet`] };
  const gaps = S.slice(1).map((r, i) => (r.t - S[i].t) / MIN), missed = gaps.filter((g) => g > 20), dbl = gaps.filter((g) => g < 10), lastAgo = (to - S[S.length - 1].t) / MIN;
  info.push(`cadence: ${S.length} shadow runs, median gap ${median(gaps).toFixed(1)} min, largest ${Math.max(...gaps).toFixed(1)} min, last ${lastAgo.toFixed(0)} min ago`);
  if (missed.length) diffs.push(`cadence: ${missed.length} gap(s) over 20 min (missed runs), largest ${Math.max(...missed).toFixed(1)} min`);
  if (dbl.length) diffs.push(`cadence: ${dbl.length} gap(s) under 10 min (double runs)`);
  if (lastAgo > 20) diffs.push(`cadence: the shadow's last run was ${lastAgo.toFixed(0)} min ago (it stopped?)`);
  if (!H.length) return { verdict: "NOT YET", lines: [...info, ...diffs.map((d) => "DIFFER " + d), "home has no run in the window (home snapshots weekdays 07:40-14:40 MT only) — rows not comparable yet"] };
  const both = shadowSymbols ? new Set(shadowSymbols) : null, keep = (rs) => (both ? rs.filter((r) => both.has(r.sym)) : rs);
  const keysOf = (rows, v) => [...new Set(rows.filter((r) => r.venue === v).flatMap((r) => Object.keys(r)))].sort().join(",");
  const hAll = H.flatMap((r) => keep(r.rs)), sAll = S.flatMap((r) => keep(r.rs));
  for (const v of ["alpaca", "coinbase"]) { const a = keysOf(hAll, v), b = keysOf(sAll, v); if (a && b && a !== b) diffs.push(`row keys (${v}): home ${a} · shadow ${b}`); }
  let pairs = 0; const dBps = [];
  for (const h of H) {
    const s = S.reduce((best, x) => (Math.abs(x.t - h.t) < Math.abs(best.t - h.t) ? x : best), S[0]);
    if (Math.abs(s.t - h.t) > 8 * MIN) { diffs.push(`home run ${h.at}: no shadow run within 8 min (nearest ${((s.t - h.t) / MIN).toFixed(1)} min)`); continue; }
    pairs++;
    const hr = keep(h.rs), sr = keep(s.rs), cnt = (rs, v) => rs.filter((r) => r.venue === v).length;
    if (Math.abs(hr.length - sr.length) > 2) diffs.push(`run ${h.at}: home ${hr.length} rows, shadow ${sr.length} (${s.at})`);
    else if (Math.abs(cnt(hr, "alpaca") - cnt(sr, "alpaca")) > 2 || Math.abs(cnt(hr, "coinbase") - cnt(sr, "coinbase")) > 2) diffs.push(`run ${h.at}: venues home alpaca ${cnt(hr, "alpaca")} / coinbase ${cnt(hr, "coinbase")}, shadow ${cnt(sr, "alpaca")} / ${cnt(sr, "coinbase")}`);
    for (const r of hr) { const x = sr.find((y) => y.sym === r.sym); if (x && Number.isFinite(r.rtBps) && Number.isFinite(x.rtBps)) dBps.push(Math.abs(r.rtBps - x.rtBps)); }
  }
  const hCount = {}; for (const h of H) for (const r of keep(h.rs)) hCount[r.sym] = (hCount[r.sym] || 0) + 1;
  const sSyms = new Set(sAll.map((r) => r.sym)), lost = Object.entries(hCount).filter(([sym, n]) => n >= H.length / 2 && !sSyms.has(sym)).map(([sym]) => sym);
  if (lost.length) diffs.push(`symbol(s) home quoted in at least half its runs that the shadow never quoted: ${lost.slice(0, 8).join(", ")}`);
  if (both) { const outside = [...new Set(H.flatMap((h) => h.rs).map((r) => r.sym))].filter((s) => !both.has(s)); if (outside.length) info.push(`home quoted ${outside.length} symbol(s) outside the shadow's list (the list was built at deploy; the nightly build tracks home): ${outside.slice(0, 6).join(", ")}`); }
  info.push(`rows: ${pairs} of ${H.length} home runs paired with a shadow run; median |rtBps home - shadow| ${dBps.length ? median(dBps).toFixed(2) : "n/a"} bps (minutes apart: values differ by design)`);
  return { verdict: diffs.length ? "DIFFER" : pairs ? "SAME" : "NOT YET", lines: [...info, ...diffs.map((d) => "DIFFER " + d)] };
}

// ── w2a ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** home's stream start on an ET day from its log ("<ISO 19>Z [fills] recording ..."), or null */
function homeStartOf(logText, day) {
  for (const l of String(logText || "").split(/\r?\n/)) { const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})Z \[fills\] recording /.exec(l); if (m) { const t = Date.parse(m[1] + "Z"); if (etOf(t).day === day) return t; } }
  return null;
}
function compareFills(homeRows, shadowRows, day, { nowMs = Date.now(), homeStart = null } = {}) {
  const end = etMs(day, "18:30"), start = Math.max(etMs(day, "06:00"), homeStart || 0), wd = etOf(etMs(day, "12:00")).wd;
  if (!Number.isFinite(end)) return { verdict: "NOT YET", lines: [`bad day ${day}`] };
  if (["Sat", "Sun"].includes(wd)) return { verdict: "NOT YET", lines: [`${day} is a ${wd}: home does not record on weekends — compare a weekday`] };
  if (nowMs < end) return { verdict: "NOT YET", lines: [`${day}'s window ends at 18:30 ET (${new Date(end).toISOString()}) — compare after it`] };
  if (!shadowRows.length) return { verdict: "NOT YET", lines: ["the shadow has recorded no event yet (or its file is absent)"] };
  const ofDay = (r) => etOf(Date.parse(r.at)).day === day, inWin = (r) => { const t = Date.parse(r.at); return t >= start && t < end; };
  const key = (r) => [r.account, r.order_id, r.event, r.filled_qty, r.status].join("|");
  const H = homeRows.filter((r) => ofDay(r) && inWin(r)), Sw = shadowRows.filter((r) => ofDay(r) && inWin(r)), Sout = shadowRows.filter((r) => ofDay(r) && !inWin(r));
  const bag = (rows) => { const m = new Map(); for (const r of rows) m.set(key(r), (m.get(key(r)) || 0) + 1); return m; };
  const hb = bag(H), sb = bag(Sw), missing = [], extra = [];
  for (const [k, n] of hb) for (let i = 0; i < n - (sb.get(k) || 0); i++) missing.push(k);
  for (const [k, n] of sb) for (let i = 0; i < n - (hb.get(k) || 0); i++) extra.push(k);
  const byAcct = (rows) => { const c = {}; for (const r of rows) c[r.account] = (c[r.account] || 0) + 1; return Object.entries(c).sort().map(([a, n]) => `${a} ${n}`).join(", ") || "none"; };
  const lines = [`${day}, window ${etOf(start).hm}-18:30 ET (${homeStart ? "from home's stream start" : "home's start not found in its log: 06:00 ET"}): home ${H.length} events (${byAcct(H)}) · shadow ${Sw.length} (${byAcct(Sw)})`];
  const leak = Sout.filter((r) => { const hm = etOf(Date.parse(r.at)).hm; return r.account !== "tv" && (hm < "06:00" || hm >= "18:30"); });
  lines.push(`the shadow's events outside the window that day: ${Sout.length} (${byAcct(Sout)}) — TV's are the 24/7 extension`);
  const diffs = [];
  if (missing.length) diffs.push(`${missing.length} event(s) home recorded that the shadow lacks: ${missing.slice(0, 5).join(" ; ")}`);
  if (extra.length) diffs.push(`${extra.length} event(s) the shadow recorded that home lacks: ${extra.slice(0, 5).join(" ; ")}`);
  if (leak.length) diffs.push(`${leak.length} main / book event(s) outside 06:00-18:30 ET in the shadow — the 24/7 flag must open the TV account only`);
  if (!H.length && !Sw.length) return { verdict: "NOT YET", lines: [...lines, "neither host recorded an event in the window — nothing to compare (a quiet day?)"] };
  return { verdict: diffs.length ? "DIFFER" : "SAME", lines: [...lines, ...diffs.map((d) => "DIFFER " + d)] };
}
/** the last weekday (ET) whose 18:30 ET has passed */
function defaultDay(nowMs) { for (let i = 0; i < 10; i++) { const d = etOf(nowMs - i * 86400000).day; if (!["Sat", "Sun"].includes(etOf(etMs(d, "12:00")).wd) && etMs(d, "18:30") <= nowMs) return d; } return null; }

// ── run ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function readShadow(ssh, rel) {
  const r = ssh(`cat '${SBD}/${rel}' 2>/dev/null || echo @@ABSENT`, { timeout: 120000 });
  if (!r.ok) throw new Error(`reading the shadow's ${rel} failed (ssh exit ${r.status})`);
  const t = String(r.out); return t.trim() === "@@ABSENT" ? null : t;
}
function main(argv, { ssh = null, homeData = path.join(REPO, "backend", "data"), logDir = path.join(REPO, "automation"), nowMs = Date.now(), log = console.log } = {}) {
  const wave = argv[0];
  if (!["w1c", "w2a"].includes(wave)) { log("usage: compare.cjs w1c [--since <ISO>] · w2a [YYYY-MM-DD] · --selftest"); return 2; }
  const S = ssh || require(path.join(REPO, "deploy", "server", "pull-server.cjs")).sshReal("traids");
  let res;
  try {
    if (wave === "w1c") {
      if (argv.length > 1 && !(argv.length === 3 && argv[1] === "--since" && Number.isFinite(Date.parse(argv[2])))) { log("usage: compare.cjs w1c [--since <ISO>]"); return 2; }
      const sh = readShadow(S, "crypto-spread-log.jsonl"), sym = readShadow(S, "crypto-symbols.json");
      if (sh == null) { log("NOT YET — the shadow has no crypto-spread-log.jsonl yet"); return 2; }
      const sRows = jsonl(sh), first = sRows.length ? Math.min(...sRows.map((r) => Date.parse(r.runAt)).filter(Number.isFinite)) : nowMs;
      const from = argv[1] === "--since" ? Date.parse(argv[2]) : first;
      let syms = null; try { syms = JSON.parse(sym).symbols; } catch { syms = null; }
      res = compareSpread(jsonl(fs.readFileSync(path.join(homeData, "crypto-spread-log.jsonl"), "utf8")), sRows, { from, to: nowMs, shadowSymbols: syms });
    } else {
      if (argv.length > 2 || (argv[1] && !/^\d{4}-\d{2}-\d{2}$/.test(argv[1]))) { log("usage: compare.cjs w2a [YYYY-MM-DD]"); return 2; }
      const day = argv[1] || defaultDay(nowMs), sh = readShadow(S, "alpaca-trade-updates.jsonl");
      let lg = ""; try { lg = fs.readFileSync(path.join(logDir, "alpaca-fills-stream.log"), "utf8"); } catch { lg = ""; }
      res = compareFills(jsonl(fs.readFileSync(path.join(homeData, "alpaca-trade-updates.jsonl"), "utf8")), jsonl(sh || ""), day, { nowMs, homeStart: homeStartOf(lg, day) });
    }
  } catch (e) { log("NOT YET — " + e.message); return 2; }
  for (const l of res.lines) log("  " + l);
  log(`${wave}: ${res.verdict}`);
  return res.verdict === "SAME" ? 0 : res.verdict === "DIFFER" ? 1 : 2;
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };
  // w1c: a shadow every 15 min from Mon 10-12 00:00 UTC; home every 30 min 13:40-20:40 UTC; 3 symbols
  const T0 = Date.parse("2026-10-12T00:00:00Z"), iso = (t) => new Date(t).toISOString();
  const row = (t, sym, venue = "alpaca", bps = 5) => ({ sym, venue, ...(venue === "coinbase" ? { product: sym.replace("/", "-") } : {}), runAt: iso(t), quoteAt: iso(t - 2000), quoteAgeS: 2, ap: 1.01, bp: 1, as: 1, bs: 1, mid: 1.005, rtBps: bps });
  const run = (t, syms = [["BTC/USD"], ["ETH/USD"], ["SOL/USD"], ["ADA/USD"], ["XTZ/USD", "coinbase"], ["KAS/USD", "coinbase"]]) => syms.map(([s, v]) => row(t, s, v || "alpaca"));
  const shadow = []; for (let t = T0; t <= T0 + 21 * 3600000; t += 15 * MIN) shadow.push(...run(t + 20000));
  const home = []; for (let t = T0 + 13 * 3600000 + 40 * MIN; t <= T0 + 20 * 3600000 + 40 * MIN; t += 30 * MIN) home.push(...run(t + 70000));
  const NOW = T0 + 21 * 3600000 + 5 * MIN, W = { from: T0, to: NOW, shadowSymbols: ["ADA/USD", "BTC/USD", "ETH/USD", "KAS/USD", "SOL/USD", "XTZ/USD"] };
  const s1 = compareSpread(home, shadow, W);
  ok("w1c SAME: 85 shadow runs at 15 min, every home run paired within 8 min, same counts / venues / keys", s1.verdict === "SAME" && /85 shadow runs, median gap 15\.0 min/.test(s1.lines.join("\n")) && /15 of 15 home runs paired/.test(s1.lines.join("\n")), s1.lines.join(" | "));
  const gap = shadow.filter((r) => { const t = Date.parse(r.runAt); return !(t > T0 + 5 * 3600000 && t < T0 + 5 * 3600000 + 40 * MIN); });
  ok("w1c cadence: two missed runs (a 45-min gap) -> DIFFER naming it", /gap\(s\) over 20 min/.test(compareSpread(home, gap, W).lines.join("\n")) && compareSpread(home, gap, W).verdict === "DIFFER");
  ok("w1c cadence: the shadow stopped 2 h before now -> DIFFER", /last run was \d+ min ago/.test(compareSpread(home, shadow, { ...W, to: NOW + 2 * 3600000 }).lines.join("\n")));
  const dbl = compareSpread(home, [...shadow, ...run(T0 + 10 * 3600000 + 20000 + 5 * MIN)], W);
  ok("w1c cadence: an extra shadow run 5 min after one of its runs (a double run, e.g. two timers enabled) -> DIFFER naming it", dbl.verdict === "DIFFER" && /cadence: 1 gap\(s\) under 10 min \(double runs\)/.test(dbl.lines.join("\n")) && dbl.lines.filter((l) => /^DIFFER/.test(l)).length === 1, dbl.lines.join(" | "));
  const fewer = shadow.filter((r) => !(["BTC/USD", "ETH/USD", "SOL/USD"].includes(r.sym) && Date.parse(r.runAt) > T0 + 14 * 3600000));
  const f1 = compareSpread(home, fewer, W);
  ok("w1c rows: the shadow stops quoting three of the six symbols home quotes -> DIFFER (row counts)", f1.verdict === "DIFFER" && /home 6 rows, shadow 3/.test(f1.lines.join("\n")), f1.lines.join(" | "));
  const two = shadow.filter((r) => !(["BTC/USD", "ETH/USD"].includes(r.sym) && Date.parse(r.runAt) > T0 + 14 * 3600000));
  ok("w1c rows: two fewer rows in a run is inside the tolerance (a book fresh on one host, stale on the other a minute later) -> SAME", compareSpread(home, two, W).verdict === "SAME");
  const neverEth = shadow.filter((r) => r.sym !== "ETH/USD"), ne = compareSpread(home, neverEth, W);
  ok("w1c rows: a symbol home quotes in every run that the shadow NEVER quotes -> DIFFER, named (even though one row per run is inside the count tolerance)", ne.verdict === "DIFFER" && /never quoted: ETH\/USD/.test(ne.lines.join("\n")), ne.lines.join(" | "));
  const venue = shadow.map((r) => (r.sym === "XTZ/USD" ? { ...r, venue: "alpaca" } : r)), v1 = compareSpread(home, venue, W);
  ok("w1c rows: a different row schema for a venue (coinbase rows relabelled alpaca, keeping 'product') -> DIFFER on the alpaca row keys", v1.verdict === "DIFFER" && /row keys \(alpaca\)/.test(v1.lines.join("\n")), v1.lines.join(" | "));
  ok("w1c: home quoted a symbol outside the shadow's list -> reported, not DIFFER (the list was built at deploy)", (() => { const h2 = [...home, ...[row(T0 + 13 * 3600000 + 40 * MIN + 70000, "NEW/USD")]]; const r = compareSpread(h2, shadow, W); return r.verdict === "SAME" && /outside the shadow's list[^]*NEW\/USD/.test(r.lines.join("\n")); })());
  ok("w1c NOT YET: one shadow run; or no home run in the window (a weekend)", compareSpread(home, shadow.slice(0, 3), W).verdict === "NOT YET" && compareSpread(home, shadow, { ...W, to: T0 + 12 * 3600000 }).verdict === "NOT YET");
  // w2a
  const DAY = "2026-10-12", at = (hm, s = 0) => new Date(etMs(DAY, hm) + s * 1000).toISOString();
  const ev = (a, id, hm, event = "fill", extra = {}) => ({ at: at(hm), account: a, event, order_id: id, symbol: "X", side: "buy", type: "market", qty: "1", filled_qty: event === "fill" ? "1" : "0", filled_avg_price: null, status: event === "fill" ? "filled" : "new", legs: [], ...extra });
  const H = [ev("main", "o1", "09:30", "new"), ev("main", "o1", "09:30"), ev("book", "o2", "10:00"), ev("tv", "o3", "13:00")];
  const Sh = [...H.map((r) => ({ ...r, at: new Date(Date.parse(r.at) + 300).toISOString() })), ev("tv", "o9", "03:00"), ev("tv", "o8", "21:00")];
  const END = etMs(DAY, "18:30") + 60000, START = Date.parse(at("08:00"));
  const w0 = compareFills(H, Sh, DAY, { nowMs: END, homeStart: START });
  ok("w2a SAME: every in-window event on both hosts (counts per account printed); the shadow's TV events at 03:00 / 21:00 ET are the 24/7 extension", w0.verdict === "SAME" && /home 4 events \(book 1, main 2, tv 1\) · shadow 4/.test(w0.lines.join("\n")) && /outside the window that day: 2 \(tv 2\)/.test(w0.lines.join("\n")), w0.lines.join(" | "));
  const w1 = compareFills(H, Sh.filter((r) => r.order_id !== "o2"), DAY, { nowMs: END, homeStart: START });
  ok("w2a: an event home recorded that the shadow lacks -> DIFFER naming it", w1.verdict === "DIFFER" && /1 event\(s\) home recorded that the shadow lacks: book\|o2\|fill/.test(w1.lines.join("\n")));
  const w2 = compareFills(H, [...Sh, ev("main", "o7", "11:00")], DAY, { nowMs: END, homeStart: START });
  ok("w2a: an extra shadow event inside the window -> DIFFER", w2.verdict === "DIFFER" && /the shadow recorded that home lacks: main\|o7/.test(w2.lines.join("\n")));
  const w3 = compareFills(H, [...Sh, ev("book", "o6", "20:00")], DAY, { nowMs: END, homeStart: START });
  ok("w2a: a BOOK event at 20:00 ET in the shadow -> DIFFER (the 24/7 flag leaked beyond TV)", w3.verdict === "DIFFER" && /main \/ book event\(s\) outside/.test(w3.lines.join("\n")));
  const early = [...Sh, ev("tv", "o5", "07:00")];
  ok("w2a: a TV event before home's stream started (07:00 ET, home from 08:00) is outside the compared window -> still SAME", compareFills(H, early, DAY, { nowMs: END, homeStart: START }).verdict === "SAME");
  ok("w2a NOT YET: before 18:30 ET; a weekend day; an empty shadow", compareFills(H, Sh, DAY, { nowMs: END - 2 * 3600000 }).verdict === "NOT YET" && compareFills(H, Sh, "2026-10-10", { nowMs: END }).verdict === "NOT YET" && compareFills(H, [], DAY, { nowMs: END }).verdict === "NOT YET");
  ok("w2a: home's start read from its log; the default day is the last weekday past 18:30 ET", homeStartOf(`${new Date(START).toISOString().slice(0, 19)}Z [fills] recording main, tv, book -> data\\alpaca-trade-updates.jsonl\n`, DAY) === START && defaultDay(Date.parse("2026-10-13T15:00:00Z")) === "2026-10-12" && defaultDay(Date.parse("2026-10-11T15:00:00Z")) === "2026-10-09" && etMs("2026-11-03", "18:30") === Date.parse("2026-11-03T23:30:00Z"));
  // main() with a fake ssh and temp home files: exit codes
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w1c2a-compare-"));
  try {
    fs.writeFileSync(path.join(tmp, "alpaca-trade-updates.jsonl"), H.map((r) => JSON.stringify(r)).join("\n") + "\n"); fs.writeFileSync(path.join(tmp, "crypto-spread-log.jsonl"), home.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.writeFileSync(path.join(tmp, "alpaca-fills-stream.log"), `${new Date(START).toISOString().slice(0, 19)}Z [fills] recording main, tv, book -> x\n`);
    const files = { "alpaca-trade-updates.jsonl": Sh.map((r) => JSON.stringify(r)).join("\n") + "\n", "crypto-spread-log.jsonl": shadow.map((r) => JSON.stringify(r)).join("\n") + "\n", "crypto-symbols.json": JSON.stringify({ schema: "crypto-symbols-v1", symbols: W.shadowSymbols }) };
    const cmds = [], fake = (s) => { cmds.push(s); const f = /cat '[^']*\/([^'/]+)'/.exec(s); return { ok: true, status: 0, out: f && files[f[1]] != null ? files[f[1]] : "@@ABSENT\n", err: "" }; };
    const quiet = () => {};
    const e1 = main(["w2a", DAY], { ssh: fake, homeData: tmp, logDir: tmp, nowMs: END, log: quiet }), e2 = main(["w1c"], { ssh: fake, homeData: tmp, nowMs: NOW, log: quiet });
    delete files["alpaca-trade-updates.jsonl"]; const e3 = main(["w2a", DAY], { ssh: fake, homeData: tmp, logDir: tmp, nowMs: END, log: quiet });
    const e4 = main(["w2a", DAY], { ssh: () => ({ ok: false, status: 255, out: "", err: "down" }), homeData: tmp, logDir: tmp, nowMs: END, log: quiet });
    ok("main: SAME -> exit 0 (both waves); shadow file absent -> 2; ssh down -> 2 (never read as 'nothing there'); bad args -> 2", e1 === 0 && e2 === 0 && e3 === 2 && e4 === 2 && main(["w2a", "10-12"], { ssh: fake, log: quiet }) === 2 && main(["w3"], { ssh: fake, log: quiet }) === 2);
    ok("read-only: compare only ever runs `cat` over ssh", cmds.every((c) => /^cat '\/home\/traids\/w1c2a-shadow\/backend\/data\/[a-z.-]+' 2>\/dev\/null \|\| echo @@ABSENT$/.test(c)));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`compare selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  if (process.argv[2] === "--selftest" && process.argv.length === 3) process.exitCode = selftest() ? 0 : 1;
  else process.exitCode = main(process.argv.slice(2));
}
module.exports = { compareSpread, compareFills, homeStartOf, defaultDay, etMs, main };
