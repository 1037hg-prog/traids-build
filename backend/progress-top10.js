/**
 * TOP TEN IN THE NIGHTLY REPORT. (2026-09-11, operator: "add the top ten to the progress report")
 *
 * Two rankings on the clean-era paper book, net of the measured per-class cost (cost-model.json perClass.costR; options are
 * charged nothing extra because their cost is embedded per ticket): the ten most profitable SYMBOLS and every SLEEVE ranked.
 * Same arithmetic as the whole-book frame above it, from lib/reconcile.js — never a second ledger source.
 *
 * WHY THE CAVEATS TRAVEL WITH THE TABLE. On 2026-09-11 the ten best symbols summed to more than the entire book made, seven
 * of them were crypto, and the crypto class's profit was the weekend artifact already measured (no edge vs a matched control
 * over 289 weeks). Breakout's lead was 36 tickets on 8 sessions — R44 asks whether that was two rally days. A top-ten list
 * is where a reader goes looking for a strategy, so the list says on its face how concentrated it is: sessions beside
 * tickets, the weekend-held crypto dollars, and the share of the book's gross the top ten represent. Nothing here has
 * cleared a bar; the section names the registered reads that will decide the two sleeves worth watching.
 */
const fs = require("fs"), path = require("path");
const rd = (f) => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "data", f), "utf8")); } catch { return null; } };
const n0 = (x) => (Number.isFinite(x) ? (x >= 0 ? "+$" : "-$") + Math.abs(Math.round(x)).toLocaleString() : "—");
const n3 = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(3) : "—");
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const red = "#8c2b22", grn = "#1f6f3a";

function build({ L }) {
  const cm = rd("cost-model.json") || {};
  const S = (L.signals || []).filter((t) => Number.isFinite(t.pnl) && Number.isFinite(t.rMult));
  if (!S.length) return { html: "", line: null };
  const costR = (t) => (cm.perClass && cm.perClass[t.cls] && Number.isFinite(cm.perClass[t.cls].costR)) ? cm.perClass[t.cls].costR : 0;
  const risk = (t) => Math.abs(t.pnl / (t.rMult || 1));
  const net = (t) => t.pnl - (t.cls === "Options" ? 0 : costR(t) * risk(t));
  const day = (t) => new Date(t.openedAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const agg = (key) => { const m = {}; for (const t of S) { const k = key(t); if (!k) continue; const a = (m[k] ||= { n: 0, net: 0, r: 0, w: 0, days: new Set() }); a.n++; a.net += net(t); a.r += t.rMult; if (t.pnl > 0) a.w++; a.days.add(day(t)); }
    return Object.entries(m).map(([k, a]) => ({ k, n: a.n, net: a.net, rPer: a.r / a.n, win: a.w / a.n, days: a.days.size })).sort((x, y) => y.net - x.net); };
  const bySym = agg((t) => String(t.sym)), bySleeve = agg((t) => t.strategy || (t.obs && t.obs.sleeve) || "board");
  const top = bySym.slice(0, 10);
  const bookNet = S.reduce((s, t) => s + net(t), 0), bookGross = S.reduce((s, t) => s + t.pnl, 0);
  const topNet = top.reduce((s, r) => s + r.net, 0);
  const cryptoTop = top.filter((r) => /\/USD$/.test(r.k)).length;
  const wk = (t) => { const o = new Date(t.openedAt).getUTCDay(), c = Number.isFinite(t.closedAt) ? new Date(t.closedAt).getUTCDay() : o; return t.cls === "Crypto" && ([5, 6, 0].includes(o) || (o === 5 && c === 1)); };
  const wkRows = S.filter(wk), wkNet = wkRows.reduce((s, t) => s + net(t), 0);
  const thin = top.filter((r) => r.n <= 3).map((r) => r.k);
  const row = (r) => `<tr><td class="k">${esc(r.k)}</td><td class="n" style="color:${r.net >= 0 ? grn : red}">${n0(r.net)} · ${n3(r.rPer)}R</td><td class="note">${r.n} tickets over ${r.days} session${r.days === 1 ? "" : "s"} · ${(100 * r.win).toFixed(0)}% won</td></tr>`;
  const html = `
  <h2><span>Top ten</span>Most profitable, net of cost</h2>
  <p class="sub">The ten best symbols and every sleeve on the clean-era paper book, cost-charged at the measured per-class rates. Read the
  session count beside the ticket count: a name that made its money in one to three sessions is a good day, not a list.</p>
  <div class="tablewrap"><table>
    <tr><td class="k">Symbol</td><td class="n">Net · R per ticket</td><td class="note">tickets · sessions · win rate</td></tr>
    ${top.map(row).join("")}
  </table></div>
  <div class="tablewrap"><table>
    <tr><td class="k">Sleeve</td><td class="n">Net · R per ticket</td><td class="note">tickets · sessions · win rate</td></tr>
    ${bySleeve.map(row).join("")}
  </table></div>
  <p class="sub"><b>Concentration, on its face.</b> The ten symbols sum to ${n0(topNet)} against a whole-book net of ${n0(bookNet)} (gross ${n0(bookGross)}) —
  ${topNet > bookNet ? "more than the entire book made" : "a share of what the book made"}. ${cryptoTop} of the ten are crypto, and crypto held into or over a weekend
  nets ${n0(wkNet)} on ${wkRows.length} tickets, a pattern the 289-week weekend study found no edge in against a matched control.${thin.length ? ` ${thin.join(", ")} ${thin.length === 1 ? "is" : "are"} three tickets or fewer.` : ""}
  Nothing in either table has cleared a registered bar. The sleeves with a read coming are R25 0DTE under R66 and Breakout under R44.</p>`;
  const line = `Top ten: ${top.slice(0, 3).map((r) => `${r.k} ${n0(r.net)}`).join(", ")}; top-10 sum ${n0(topNet)} vs book ${n0(bookNet)}; ${cryptoTop}/10 crypto.`;
  return { html, line };
}
module.exports = { build };
if (require.main === module) { const r = build({ L: require("./lib/reconcile.js").cleanEraLedger() }); console.log(r.line || "no rows"); }
