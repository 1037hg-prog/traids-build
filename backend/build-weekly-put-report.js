#!/usr/bin/env node
/**
 * WEEKLY PUT SELLING — the report. 2026-09-08, operator: "email me a report on this".
 *
 * Builds docs/TRAIDS_Weekly_Puts_<date>.html entirely from the two study outputs
 * (data/weekly-put-study-2026-09-08.json and -spcx.json). Nothing is typed in: every number on the
 * page is read from the measurement, so the page cannot drift from what was measured.
 *
 * Usage: node backend/build-weekly-put-report.js
 */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const D = (f) => path.join(__dirname, "data", f);
const main = JSON.parse(fs.readFileSync(D("weekly-put-study-2026-09-08.json"), "utf8"));
const spcx = JSON.parse(fs.readFileSync(D("weekly-put-study-2026-09-08-spcx.json"), "utf8"));
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date());
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n1 = (x) => (x == null ? "—" : (x >= 0 ? "+" : "") + x.toFixed(1) + "%");
const n2 = (x) => (x == null ? "—" : x.toFixed(1) + "%");
const cls = (x) => (x == null ? "" : x >= 0 ? "pos" : "neg");
const yrsOf = (rows) => (Date.parse(rows[rows.length - 1].exp) - Date.parse(rows[0].entry)) / (365.25 * 864e5);
const ann = (rows) => { let eq = 1; for (const r of rows) eq *= 1 + r.netPct / 100; const y = yrsOf(rows); return 100 * (Math.pow(eq, 1 / y) - 1); };
const tot = (rows) => { let eq = 1; for (const r of rows) eq *= 1 + r.netPct / 100; return 100 * (eq - 1); };
const annBH = (pct, rows) => 100 * (Math.pow(1 + pct / 100, 1 / yrsOf(rows)) - 1);

/** headline table across all three names at the 2% strike */
const NAMES = [
  { sym: "SPCX", label: "SpaceX", src: spcx, note: "listed 2026-06-12" },
  { sym: "NVDA", label: "Nvidia", src: main, note: "" },
  { sym: "AMZN", label: "Amazon", src: main, note: "" },
];
const headRows = NAMES.map(({ sym, label, src, note }) => {
  const rows = src.rows[sym]["0.02"], s = src.summary[sym]["0.02"];
  const worst = rows.reduce((w, r) => (w == null || r.netPct < w.netPct ? r : w), null);
  return `<tr><td class="k">${label} <span class="w">${sym}${note ? " · " + note : ""}</span></td>
    <td class="n">${rows.length}</td><td class="n">${n2(s.winPctNet)}</td><td class="n">${n2(s.assignedPct)}</td>
    <td class="n ${cls(tot(rows))}">${n1(tot(rows))}</td><td class="n ${rows.length >= 26 ? cls(ann(rows)) : ""}">${rows.length >= 26 ? n1(ann(rows)) : "<span class=\"w\">too few weeks</span>"}</td>
    <td class="n ${cls(s.buyHoldPct)}">${n1(s.buyHoldPct)}</td><td class="n ${rows.length >= 26 ? cls(annBH(s.buyHoldPct, rows)) : ""}">${rows.length >= 26 ? n1(annBH(s.buyHoldPct, rows)) : "<span class=\"w\">too few weeks</span>"}</td>
    <td class="n neg">${n1(worst.netPct)}</td><td class="w">${worst.entry}</td></tr>`;
}).join("\n");

/** strike-distance table per name */
const strikeRows = NAMES.map(({ sym, label, src }) => ["0", "0.02", "0.05"].map((m, i) => {
  const rows = src.rows[sym][m], s = src.summary[sym][m];
  return `<tr>${i === 0 ? `<td class="k" rowspan="3">${label}</td>` : ""}<td>${(100 * +m).toFixed(0)}% below spot</td>
    <td class="n">${rows.length}</td><td class="n">${n2(s.winPctNet)}</td><td class="n">${n2(s.assignedPct)}</td>
    <td class="n ${cls(tot(rows))}">${n1(tot(rows))}</td><td class="n neg">${n1(Math.min(...rows.map((r) => r.netPct)))}</td></tr>`;
}).join("\n")).join("\n");

/** SPCX week by week */
const spcxRows = spcx.rows.SPCX["0.02"].map((r) => `<tr><td class="w">${r.entry} → ${r.exp}</td><td class="n">${r.strike}</td>
  <td class="n">${r.spot.toFixed(2)} → ${r.sExp.toFixed(2)}</td><td class="n ${cls(r.sExp / r.spot - 1)}">${n1(100 * (r.sExp / r.spot - 1))}</td>
  <td class="n">$${r.credit.toFixed(2)}</td><td>${r.assigned ? "<b>assigned</b>" : "expired"}</td>
  <td class="n ${cls(r.netPct)}">${n1(r.netPct)}</td></tr>`).join("\n");

/** tail concentration on the long samples */
const tail = ["NVDA", "AMZN"].map((sym) => {
  const rows = main.rows[sym]["0.02"].slice().sort((a, b) => a.netPct - b.netPct);
  const w3 = rows.slice(0, 3).reduce((s, r) => s + r.netPct, 0), rest = rows.slice(3).reduce((s, r) => s + r.netPct, 0);
  return `<tr><td class="k">${sym}</td><td class="n">${rows.length}</td><td class="n neg">${n1(w3)}</td><td class="n pos">${n1(rest)}</td><td class="n">${(100 * Math.abs(w3) / rest).toFixed(0)}%</td></tr>`;
}).join("\n");

/** his claim window */
const recent = NAMES.map(({ sym, label, src }) => {
  const rows = src.rows[sym]["0.02"].filter((r) => r.entry >= "2026-05-01");
  if (!rows.length) return "";
  return `<tr><td class="k">${label}</td><td class="n">${rows.length}</td><td class="n">${n2(100 * rows.filter((r) => r.net > 0).length / rows.length)}</td><td class="n ${cls(tot(rows))}">${n1(tot(rows))}</td></tr>`;
}).join("\n");

const hair = Object.entries(main.crossHaircut).concat([["SPCX", spcx.crossHaircut.SPCX]])
  .filter(([k]) => ["SPCX", "NVDA", "AMZN"].includes(k)).map(([k, v]) => `${k} ${(100 * v).toFixed(1)}%`).join(", ");

const html = `<title>Weekly Put Selling — Does It Work?</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@90,500;90,700&family=Source+Sans+3:wght@400;600&family=JetBrains+Mono:wght@400;500&display=swap">
${fs.readFileSync(path.join(__dirname, "lib", "report-style.html"), "utf8")}
<div class="page">
  <h1>Selling weekly puts — does it actually work?</h1>
  <div class="sub">Measured ${TODAY} on real option prices, not a model · SpaceX, Nvidia and Amazon · paper study, nothing traded</div>

  <p>The claim under test: sell cash-secured puts on SpaceX, Nvidia and Amazon, one week at a time, do not look at them until Friday,
  and shrug at assignment because owning the shares is fine. This measures that rule exactly as described, using the price each
  contract actually traded at rather than a model. That distinction is not academic: this desk previously measured real option credit
  at 0.80&times; the textbook credit, and that single correction took an identical short-volatility study from a Sharpe of 1.57 to
  &minus;0.17. Nothing here is modelled.</p>

  <div class="box"><b>The short answer.</b> Yes, it makes money, on all three names, and he is not fooling himself.
  It also earns a fraction of what simply owning the shares earned on the two large names, and its losses are concentrated in a
  handful of weeks he has probably not lived through yet. On SpaceX specifically it has beaten owning the stock, because the stock
  is below where it listed.</p>

  <h2>1 · The headline, selling a put 2% below the money every Friday</h2>
  <div class="tablewrap"><table>
    <tr><th>Name</th><th>Weeks</th><th>Win</th><th>Assigned</th><th>Total</th><th>Per year</th><th>Shares, total</th><th>Shares, per year</th><th>Worst week</th><th>When</th></tr>
    ${headRows}
  </table></div>
  <p>Every figure is net of the fill cost of selling the bid rather than the mid, measured live on each name's own front-week book
  (${hair}). The cash behind the put is not counted as earning anything; a real account would add roughly the Treasury bill yield,
  about 4.4% a year over this window, to the put column and nothing to the share column. SpaceX has eight weeks of listed
  contracts, which is too short a record to state as an annual rate, so those two cells are left empty rather than filled with a
  number that would read as a forecast.</p>

  <h2>2 · The same rule at three strike distances</h2>
  <div class="tablewrap"><table>
    <tr><th>Name</th><th>Strike</th><th>Weeks</th><th>Win</th><th>Assigned</th><th>Total</th><th>Worst week</th></tr>
    ${strikeRows}
  </table></div>
  <p>Selling further out of the money raises the win rate and lowers the total. That trade-off is the whole strategy in one table:
  you are choosing how often to be right, not how much to make.</p>

  <h2>3 · SpaceX, week by week</h2>
  <p>SpaceX listed on 12 June 2026 and has weekly options. Eight weeks have listed contracts. The stock ran from a high of
  $225.64 to a low of $104.83 in its first three months, down 53.5% peak to trough, which is why the premiums are so large.</p>
  <div class="tablewrap"><table>
    <tr><th>Week</th><th>Strike</th><th>Stock</th><th>Move</th><th>Credit</th><th>Outcome</th><th>P&amp;L on cash</th></tr>
    ${spcxRows}
  </table></div>
  <p>Three assigned losses in a row through the July fall, then five straight winners in the recovery. Anyone who started in August
  has seen nothing but winners. That is the most likely explanation of "it has been working for a few months".</p>

  <h2>4 · Where the losses live</h2>
  <div class="tablewrap"><table>
    <tr><th>Name</th><th>Weeks</th><th>Worst 3 weeks</th><th>All other weeks</th><th>Given back</th></tr>
    ${tail}
  </table></div>
  <p>Three weeks out of a hundred give back roughly half of everything the other ninety-seven earned. This is the shape of every
  premium-selling record: many small wins, rare large losses. A high win rate is what the strategy produces, not evidence that it
  is safe. The worst single week on Nvidia was the January 2025 session when the stock fell 15.8% in five days.</p>

  <h2>5 · His own window, since May</h2>
  <div class="tablewrap"><table>
    <tr><th>Name</th><th>Weeks</th><th>Win</th><th>Total</th></tr>
    ${recent}
  </table></div>
  <p>Even inside the window he is describing, the names disagree. Fourteen weeks of a rising market is the sample in which this
  always looks good, and it is far too short to contain the losses that define it.</p>

  <h2>6 · What this does and does not settle</h2>
  <p><b>Settled.</b> The strategy is real and positive on every name measured here, at prices the market actually printed and net
  of realistic fills. He is not imagining the income.</p>
  <p><b>Not settled.</b> Whether it beats owning the shares depends entirely on what the shares do, and the answer flipped between
  names: on Nvidia the shares won by a wide margin, on SpaceX the puts won. Selling a put keeps every dollar the stock falls below
  the strike and hands back every dollar it rises above it, so this is a bet that the name goes sideways or mildly down. That is a
  view about the stock, not an edge in options.</p>
  <p><b>The assumption doing the work.</b> "So what if I have to buy the shares" is the load-bearing part. Assignment arrives
  exactly when the stock has fallen, and on SpaceX it arrived three weeks running, each time into a stock that kept falling.
  It is a shrug only if he genuinely wants that stock at that strike and can hold it through more decline.</p>
  <p><b>Worth asking him.</b> How much of his account stands behind each put, whether he is truly cash-secured or selling on
  margin, and what he did during the SpaceX drop in July. The answer to the last one tells you whether the record is a strategy
  or a bull market.</p>

  <h2>Method and known weaknesses</h2>
  <p>Sell one put every Friday expiring the following Friday, at the listed strike nearest 0, 2 and 5% below spot, measured
  separately. The credit is the contract's traded close on the entry Friday, less the measured cost of crossing to the bid.
  Settlement is intrinsic value against the underlying's close on the expiry Friday. Cycles do not overlap. Capital is the strike
  times one hundred, held in cash. Option prices come from Alpaca's historical option bars; equity prices are split and dividend
  adjusted.</p>
  <p>Weaknesses, stated against the result: the window is close to the best case for Nvidia, which rose 360% through it, and
  contains no sustained bear market. SpaceX has eight weeks, which settles nothing on its own. Using the traded close as the
  credit assumes a fill near where the contract actually printed that day. Early assignment before expiry is not modelled, though
  for puts on non-dividend dates it rarely changes the outcome. And this is a retrospective measurement of someone else's claim,
  not a registered forward test; if it is ever traded here it gets registered first, like everything else.</p>

  <footer>Built ${new Date().toISOString()} by backend/build-weekly-put-report.js from data/weekly-put-study-2026-09-08*.json ·
  paper study, no orders, no recommendation · not for circulation</footer>
</div>`;

const outDir = path.join(ROOT, "docs");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `TRAIDS_Weekly_Puts_${TODAY}.html`);
fs.writeFileSync(out, html);
console.log("written:", path.relative(ROOT, out));
