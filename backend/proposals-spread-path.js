/**
 * PROPOSALS SPREAD PATH (2026-09-15, operator: "i don't trust what you say the spreads are").
 *
 * The spread stamped on every proposal-sleeve ticket is Schwab's NBBO at the 07:40 MT booking — 09:40 ET, ten minutes after the
 * open, when quotes are widest. That is the honest cost of trading AT the booking, and it is also the least representative number
 * of the day. This sampler re-quotes every OPEN proposal ticket on each Intraday fire during RTH and appends the bid, ask and spread
 * to an append-only path (data/proposals-spread-path.jsonl), then writes a per-name table (data/proposals-spread-path.json): the
 * booking spread, the day's median, the day's tightest, and the last quote — so the 09:40 figure can be judged against the rest of
 * the session instead of taken on faith. Quotes outside 09:45-15:55 ET are refused (an empty book is not a price).
 *
 * Fail closed: a symbol without a two-sided quote is skipped and counted. Nothing here changes a ticket, a gate or a fill.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const schwab = require("./lib/schwab.js");
const D = (f) => path.join(__dirname, "data", f);
const PATH = D("proposals-spread-path.jsonl"), OUT = D("proposals-spread-path.json");
const dry = process.argv.includes("--dry"), force = process.argv.includes("--force");
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const etHM = () => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
const dow = () => new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

(async () => {
  const today = etDay(Date.now()), hm = etHM();
  const live = /Mon|Tue|Wed|Thu|Fri/.test(dow()) && hm >= "09:45" && hm <= "15:55";
  if (!live && !force) { console.log(`PROPOSALS SPREAD PATH — ${today} ${hm} ET outside RTH; no quote taken`); return; }
  const st = JSON.parse(fs.readFileSync(D("proposals-sleeve.json"), "utf8"));
  const open = Object.entries(st.sessions || {}).flatMap(([d, s]) => (s.tickets || []).filter((t) => t.status === "open").map((t) => ({ ...t, session: d })));
  if (!open.length) { console.log(`PROPOSALS SPREAD PATH — ${today} ${hm} ET: no open proposal tickets`); return; }
  const syms = [...new Set(open.map((t) => t.sym))];
  let q = {}; try { q = await schwab.quotesBySymbol(syms); } catch (e) { console.error(`PROPOSALS SPREAD PATH — schwab quotes failed: ${e.message}`); process.exit(1); }
  const at = new Date().toISOString(), rows = []; let skipped = 0;
  for (const t of open) {
    const v = q[t.sym] || {}; const bid = Number(v.bid ?? v.bidPrice), ask = Number(v.ask ?? v.askPrice);
    if (!(bid > 0 && ask > 0 && ask >= bid)) { skipped++; continue; }
    rows.push({ at, etHM: hm, session: t.session, sym: t.sym, bid, ask, spreadBps: +((ask - bid) / ((ask + bid) / 2) * 1e4).toFixed(2), bookingSpreadBps: t.spreadBps ?? null, r49Refused: !!t.r49Refused });
  }
  if (!dry && rows.length) fs.appendFileSync(PATH, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // ---- per-name table for today: booking spread vs the day's path ------------------------------------------------------------
  let all = []; try { all = fs.readFileSync(PATH, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  if (dry) all = all.concat(rows);
  const todayRows = all.filter((r) => etDay(Date.parse(r.at)) === today); const byName = {};
  for (const r of todayRows) { const b = (byName[r.sym] ||= { sym: r.sym, session: r.session, bookingSpreadBps: r.bookingSpreadBps, r49Refused: r.r49Refused, samples: [], last: null }); b.samples.push(r.spreadBps); b.last = { etHM: r.etHM, bid: r.bid, ask: r.ask, spreadBps: r.spreadBps }; }
  const table = Object.values(byName).map((b) => ({ ...b, n: b.samples.length, medianBps: median(b.samples), tightestBps: Math.min(...b.samples), widestBps: Math.max(...b.samples), bookingVsMedian: b.bookingSpreadBps != null && median(b.samples) != null ? +(b.bookingSpreadBps / Math.max(1e-9, median(b.samples))).toFixed(2) : null, samples: undefined })).sort((a, b) => (b.bookingSpreadBps || 0) - (a.bookingSpreadBps || 0));
  const ratios = table.map((x) => x.bookingVsMedian).filter(Number.isFinite);
  const out = { spec: "proposals-spread-path-v1", asOf: at, date: today, samplesToday: todayRows.length, names: table.length, skippedNoQuote: skipped,
    reading: ratios.length ? `booking (09:40 ET) spread is ${median(ratios)}x the day's median spread across ${ratios.length} names (median ratio)` : "no intraday samples yet",
    table, note: "Schwab NBBO, RTH only. The booking spread is what the ticket paid at 09:40 ET; the path shows what the same name quoted later. Nothing here changes a fill or a gate." };
  if (!dry) writeJsonAtomic(OUT, out);
  console.log(`PROPOSALS SPREAD PATH — ${today} ${hm} ET · ${rows.length} quoted, ${skipped} without a two-sided quote · ${out.reading}${dry ? " (DRY)" : ""}`);
  for (const x of table.slice(0, 8)) console.log(`   ${x.sym.padEnd(5)} booking ${String(x.bookingSpreadBps).padStart(7)} bps · today median ${String(x.medianBps).padStart(7)} · tightest ${String(x.tightestBps).padStart(7)} · last ${x.last.etHM} ${x.last.bid}/${x.last.ask}${x.r49Refused ? " · REFUSED" : ""}`);
})().catch((e) => { console.error(`PROPOSALS SPREAD PATH — failed: ${e.message}`); process.exit(1); });
