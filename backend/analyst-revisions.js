#!/usr/bin/env node
/**
 * TEST #65 — ANALYST PRICE-TARGET REVISIONS, GRADED FORWARD.   (registered 2026-08-19)
 *
 * THE CLAIM BEING TESTED. The data vendor publishes 54.3% "success" for 2021 — in-sample, about
 * its own product — and headlines an "88.4% analyst" which is a MAXIMUM over a population of
 * n=26. Two kill reasons were written down before a single row was captured:
 *
 *   · 54.3% may well be WORSE than the base rate. 2021 was a year in which most things went up;
 *     a coin that says "up" every time would have scored well. A hit rate is meaningless until
 *     it is placed beside what the tape did over the identical window.
 *   · a maximum over a population is not a performance. With 26 analysts, someone finishes
 *     first; 88.4% is the order statistic, not an edge, and it is exactly the multiplicity error
 *     this project prices everywhere else.
 *
 * SO THE COMPARATOR IS NOT 50%, AND IT IS NOT 54.3%. Every revision is graded as EXCESS over the
 * same-window move of the broad tape, on the identical dates. A raise that gains 2% in a week
 * the market gained 3% is a miss here, and would have been a "success" in the vendor's framing.
 *
 * ───────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A CAPTURE JOB AND NOT A BACKTEST. The vendor's number is in-sample by
 * construction. Rerunning history would only produce another in-sample number — and the ratings
 * page shows what is CURRENT, so a historical pull would be reconstructing the past from a
 * present-tense source, which is where survivorship and restatement live. So: capture daily,
 * seal at capture, grade later. Slow, and the only version that means anything.
 *
 * SEALING. A capture is written once and never revised. Grading adds fields to a sealed row; it
 * never edits what was captured. The forward record is append-only — a record you can edit is a
 * backtest with extra steps.
 *
 * LEAD vs CLUSTER, tagged AT CAPTURE (never after seeing the outcome): a revision is a LEAD if
 * no other firm revised the same ticker in the trailing 5 sessions on file, otherwise CLUSTER.
 * The interesting question is whether the first mover carries information the herd does not, and
 * that split has to be fixed before the result is known or it is just another free parameter.
 *
 *   node backend/analyst-revisions.js            capture today, then grade whatever has matured
 *   node backend/analyst-revisions.js --grade    grading pass only
 *   node backend/analyst-revisions.js --report   the record so far vs its bar
 *
 * Nothing here trades. Paper validation record, not trading advice.
 */
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "data", "analyst-revisions-forward.json");
const API = process.env.TRAIDS_URL || "http://localhost:3001";
const SRC = "https://www.benzinga.com/analyst-stock-ratings";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const HORIZON = 5;                 // sessions
const CLUSTER_WINDOW = 5;          // sessions of trailing captures that make a revision a CLUSTER
const args = process.argv.slice(2);

const etDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const rd = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const mean = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const dec = (s) => String(s).replace(/&amp;/g, "&").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<!--\s*-->/g, "").trim();

/**
 * Parse the ratings table. Cells carry a `table-cell-<field>` class and a title attribute, and
 * every row emits the same field set in the same order — so a field repeating means a new row
 * has started. That is a structural cue rather than a brittle assumption about column count.
 */
function parseRows(html) {
  const re = /table-cell-([a-z_]+)[^>]*?title="([^"]*)"[^>]*>([\s\S]*?)<\/td>/g;
  const rows = []; let cur = {}; let m;
  while ((m = re.exec(html)) !== null) {
    const [, field, title, inner] = m;
    if (cur[field] !== undefined) { rows.push(cur); cur = {}; }
    cur[field] = { title: dec(title), text: dec(inner.replace(/<[^>]+>/g, "")) };
  }
  if (Object.keys(cur).length) rows.push(cur);
  return rows;
}

/** "$115 → $118" (or an en-dash/arrow variant) → { from: 115, to: 118 }. */
function ptChange(cell) {
  if (!cell) return null;
  const t = cell.text.replace(/[→➔➡>]+/g, "→");
  const m = t.match(/\$?\s*([\d,.]+)\s*→\s*\$?\s*([\d,.]+)/);
  if (!m) return null;
  const from = parseFloat(m[1].replace(/,/g, "")), to = parseFloat(m[2].replace(/,/g, ""));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return null;
  return { from, to };
}

/**
 * Fetched through curl rather than node's fetch. Measured 2026-08-19: the host returns 403 to
 * node's fetch even with a full set of browser headers, and 200 to curl with the same headers —
 * so the block is on the TLS fingerprint, not on anything a header can fix. curl ships with
 * Windows 10+ and every Linux this would run on, so shelling out costs a process and buys a
 * collector that actually works. One request per day, standard UA, no attempt to appear as
 * anything other than what it is.
 */
function fetchPage(url) {
  const { execFileSync } = require("child_process");
  const out = execFileSync("curl", ["-sL", "--compressed", "--max-time", "60", "-A", UA,
    "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "-H", "Accept-Language: en-US,en;q=0.9", "-w", "\n__HTTP__%{http_code}", url],
    { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
  const cut = out.lastIndexOf("\n__HTTP__");
  const code = cut < 0 ? "000" : out.slice(cut + 9).trim();
  if (code !== "200") throw new Error(`ratings page ${code}`);
  return cut < 0 ? out : out.slice(0, cut);
}

async function capture(state) {
  const html = fetchPage(SRC);
  const rows = parseRows(html);
  if (rows.length < 10) throw new Error(`parsed only ${rows.length} rows — the page shape changed; refusing to seal a partial capture`);

  const capturedAt = new Date().toISOString(), captureDay = etDay();
  const seen = new Set(state.captures.map(c => c.key));
  // trailing captures that decide LEAD vs CLUSTER — computed BEFORE today's rows are added
  const recentDays = [...new Set(state.captures.map(c => c.captureDay))].sort().slice(-CLUSTER_WINDOW);
  const recentByTicker = new Map();
  for (const c of state.captures) if (recentDays.includes(c.captureDay)) recentByTicker.set(c.ticker, (recentByTicker.get(c.ticker) || 0) + 1);

  let added = 0, noChange = 0, dupe = 0;
  const todayTickers = new Map();
  for (const row of rows) {
    const ticker = row.ticker?.title || row.ticker?.text;
    const pt = ptChange(row.pt_prior);
    if (!ticker) continue;
    if (!pt || pt.from === pt.to) { noChange++; continue; }        // only CHANGES are the test
    const firm = row.analyst?.title || row.analyst?.text || row.analyst_name?.title || "";
    const key = `${row.date?.text || captureDay}|${ticker}|${firm}|${pt.from}|${pt.to}`;
    if (seen.has(key)) { dupe++; continue; }
    const prior = (recentByTicker.get(ticker) || 0) + (todayTickers.get(ticker) || 0);
    todayTickers.set(ticker, (todayTickers.get(ticker) || 0) + 1);
    state.captures.push({
      key, capturedAt, captureDay, ratingDate: row.date?.text || null, ticker,
      firm, analyst: row.analyst_name?.title || null,
      action: row.action_company?.title || null, ratingCurrent: row.rating_current?.title || null,
      ptFrom: pt.from, ptTo: pt.to, dir: pt.to > pt.from ? 1 : -1,
      priceAtCapture: parseFloat(String(row.current_price?.title ?? row.current_price?.text ?? "").replace(/[^0-9.]/g, "")) || null,
      // tagged AT CAPTURE, before any outcome exists
      lead: prior === 0 ? true : false,
      graded: false,
    });
    added++; seen.add(key);
  }
  console.log(`  capture ${captureDay}: ${rows.length} rows read · +${added} new revision(s) sealed · ${noChange} with no PT change · ${dupe} already on file`);
  return added;
}

// ── grading ────────────────────────────────────────────────────────────────────────────────
async function bars(symbols, days = 90) {
  const r = await fetch(`${API}/api/equities/bars`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols, days }), signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`bars ${r.status}`);
  return (await r.json()).data || {};
}

async function grade(state) {
  const pending = state.captures.filter(c => !c.graded);
  if (!pending.length) { console.log(`  grading: nothing pending`); return 0; }
  const tickers = [...new Set(pending.map(c => c.ticker))];
  const need = [...tickers, "SPY"];
  const data = {};
  for (let i = 0; i < need.length; i += 40) Object.assign(data, await bars(need.slice(i, i + 40)));
  const spy = data.SPY || [];
  const dayIdx = (bs, d) => bs.findIndex(b => (b.date || b.t || b.time) >= d);
  let done = 0;
  for (const c of pending) {
    const bs = data[c.ticker];
    if (!bs || !bs.length || !spy.length) continue;
    // entry is the NEXT close after the capture — the revision was already public when captured
    const i0 = dayIdx(bs, c.captureDay), s0 = dayIdx(spy, c.captureDay);
    if (i0 < 0 || s0 < 0 || i0 + HORIZON >= bs.length || s0 + HORIZON >= spy.length) continue;
    const stock = 100 * (bs[i0 + HORIZON].c / bs[i0].c - 1);
    const tape = 100 * (spy[s0 + HORIZON].c / spy[s0].c - 1);
    c.fwd = +stock.toFixed(4); c.tape = +tape.toFixed(4);
    c.excess = +(stock - tape).toFixed(4);
    // signed by the revision's direction: a cut that underperforms is a HIT
    c.signedExcess = +(c.excess * c.dir).toFixed(4);
    c.hit = c.signedExcess > 0;
    c.graded = true; c.gradedAt = new Date().toISOString();
    done++;
  }
  console.log(`  grading: ${done} revision(s) matured and graded (+${HORIZON} sessions, excess over SPY)`);
  return done;
}

function report(state) {
  const g = state.captures.filter(c => c.graded);
  console.log(`\n  ══ TEST #65 · ANALYST PRICE-TARGET REVISIONS ══`);
  console.log(`  ${state.captures.length} sealed · ${g.length} graded · ${new Set(state.captures.map(c => c.captureDay)).size} capture day(s)`);
  console.log(`  bar: hit rate and mean signed excess must beat the CONTEMPORANEOUS tape, t >= 2.73 (fleet-corrected), at n>=200 over >=60 days\n`);
  if (g.length < 10) { console.log(`  ACCRUING — ${g.length} graded. Nothing is readable yet, and an interim number here would be exactly the in-sample reading this test exists to avoid.\n`); return; }
  const cut = (label, rows) => {
    if (rows.length < 5) return;
    const se = rows.map(r => r.signedExcess);
    const t = sd(se) ? mean(se) / (sd(se) / Math.sqrt(se.length)) : 0;
    console.log(`  ${label.padEnd(16)} n=${String(rows.length).padStart(4)}  hit ${(100 * rows.filter(r => r.hit).length / rows.length).toFixed(1)}%  mean signed excess ${(mean(se) >= 0 ? "+" : "") + mean(se).toFixed(3)}pp  t ${t.toFixed(2)}`);
  };
  cut("ALL", g);
  cut("raises", g.filter(r => r.dir > 0));
  cut("cuts", g.filter(r => r.dir < 0));
  cut("LEAD", g.filter(r => r.lead));
  cut("CLUSTER", g.filter(r => !r.lead));
  console.log(`\n  Reminder: hit rate is measured against the tape over the SAME window, not against 50%`);
  console.log(`  and not against the vendor's 54.3%. Paper validation record, not trading advice.\n`);
}

(async () => {
  const state = rd(OUT, { test: "#65 analyst-pt-revisions", source: SRC, horizon: HORIZON, createdAt: new Date().toISOString(), captures: [] });
  state.captures = state.captures || [];
  console.log(`\n  TEST #65 — analyst price-target revisions · append-only forward capture`);
  try {
    if (!args.includes("--grade") && !args.includes("--report")) await capture(state);
    if (!args.includes("--report")) await grade(state);
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    if (!state.captures.length) { console.error(`  nothing on file and capture failed — writing nothing rather than seeding a placeholder\n`); process.exit(1); }
  }
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(state, null, 1));
  report(state);
})();
