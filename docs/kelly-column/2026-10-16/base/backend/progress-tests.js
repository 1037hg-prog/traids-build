/**
 * PROGRESS REPORT SECTION — the registry and the machine (2026-09-22, operator: "add the test section to the progress email; lets make it
 * one email per day"). Three things the book scorecards never carried:
 *   READS      what was sealed today, verbatim from data/read-seals.json — the verdict line, not a summary of it
 *   REGISTRY   what is ready to read, and what is accruing with its own clock
 *   THE MACHINE + WAITING ON YOU   last night's chain, ops-health findings, and the short list of things only the operator can move
 * Reads only. It decides nothing, and it never restates a sealed verdict in friendlier words.
 */
const fs = require("fs"), path = require("path");
const D = (f) => path.join(__dirname, "data", f);
const rd = (f) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return null; } };
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function build({ today } = {}) {
  const day = today || new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  const seals = rd("read-seals.json") || { tests: {} }, adj = rd("adjudicator.json") || { rows: [] };
  const sealedToday = Object.entries(seals.tests || {}).filter(([, v]) => v && v.sealedOn === day);
  const rows = adj.rows || [];
  const ready = rows.filter((r) => /READY TO READ/.test(r.verdict || ""));
  const accruing = rows.filter((r) => /ACCRUING|READ-PARTIAL/.test(r.verdict || "")).slice(0, 8);

  // WAITING ON YOU — only things the operator alone can move, each with why it is stuck
  const waiting = [];
  const ares = rd("c2-ares-forward.json");
  if (ares && ares.feed && /STALE|NO INGEST/.test(ares.feed.state)) waiting.push(`<b>R139 (ares) needs a CSV download</b> — ${esc(ares.feed.state)}. Collective2 blocks scripts, so new trades only arrive when you download the trading record. Nothing is lost by waiting; the CSV always carries the full history.`);
  const retire = rd("retire-requests.json");
  const pend = ((retire && retire.requests) || []).filter((r) => !r.appliedAt);
  for (const r of pend) waiting.push(`<b>Retire request ${esc(r.id)}</b> — ${r.ids.length} ticket(s) queued to be tagged as data defects when they settle. ${esc(String(r.scope || "").slice(0, 160))}`);
  if (ready.length) waiting.push(`<b>${ready.length} test(s) ready to read</b> (${ready.map((r) => esc(r.id)).join(", ")}) — a read is one-shot and sealed, so it waits for your word.`);

  const chain = rd("chain-status.json"), ops = rd("ops-health.json");
  const chainLine = chain ? `${(chain.steps || []).length} steps, ${(chain.failed || []).length ? "<b>failed: " + (chain.failed || []).map(esc).join(", ") + "</b>" : "no failures"}${chain.finished ? ` &middot; finished ${esc(String(chain.finished).slice(0, 16).replace("T", " "))}Z` : ""}` : "no chain record";
  const opsFind = (ops && ops.findings) || [];
  const opsLine = ops ? `${opsFind.length ? opsFind.slice(0, 4).map((f) => esc(`${f.kind}: ${f.id}`)).join(" &middot; ") + (opsFind.length > 4 ? ` &middot; +${opsFind.length - 4} more` : "") : "nothing reported"}` : "ops-health has not run";

  const sealRows = sealedToday.length
    ? sealedToday.map(([id, v]) => `<tr><td><b>${esc(id)}</b></td><td>${esc(v.sessions ?? "")} ${esc(v.unit || "")}</td><td>${esc(v.verdict)}</td></tr>`).join("")
    : `<tr><td colspan="3" style="color:var(--ink-2)">No read was sealed today. A read happens once, at its registered bar.</td></tr>`;

  const html = `
  <h2><span>Registry</span>Tests: what was read, what is due, what is stuck</h2>
  <p class="sub">A read is taken once, at a bar fixed before the evidence, and sealed. The verdicts below are quoted from the seal, not re-worded.</p>
  <table><thead><tr><th>Sealed today</th><th>Sample</th><th>Verdict, as sealed</th></tr></thead><tbody>${sealRows}</tbody></table>
  ${ready.length ? `<p class="sub"><b>Ready to read (${ready.length}):</b> ${ready.map((r) => `${esc(r.id)} &mdash; ${esc(String(r.detail || "").slice(0, 150))}`).join("<br>")}</p>` : `<p class="sub">No test is at its bar today.</p>`}
  ${accruing.length ? `<p class="sub"><b>Accruing:</b> ${accruing.map((r) => `${esc(r.id)} (${esc(String(r.detail || "").slice(0, 90))})`).join(" &middot; ")}</p>` : ""}
  <p class="sub"><b>Last night's chain:</b> ${chainLine}. <b>Machine:</b> ${opsLine}.</p>
  ${waiting.length ? `<p class="sub"><b>Waiting on you</b><br>${waiting.join("<br>")}</p>` : `<p class="sub"><b>Nothing is waiting on you.</b></p>`}`;

  const summary = `${sealedToday.length} read(s) sealed today${ready.length ? `, ${ready.length} ready to read` : ""}${waiting.length ? `, ${waiting.length} item(s) waiting on you` : ""}.`;
  return { html, summary, sealedToday: sealedToday.length, ready: ready.length, waiting: waiting.length };
}
module.exports = { build };
