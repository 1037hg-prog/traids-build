#!/usr/bin/env node
"use strict";
/**
 * RECONCILE-PACING 2026-10-14 — BUILD THE RECORDED SET: the broker's answers and the inputs of one real night of backend/alpaca-reconcile.js,
 * made from real files, READ-ONLY (no network, no key, no write outside harness/recorded/).
 *
 *   node docs/reconcile-pacing/2026-10-14/harness/build-recorded.cjs      refuses when harness/recorded/ already holds a set (it is the
 *                                                                         package's known answer: remove it by hand to make a new one)
 *
 * WHAT IT READS (never writes): backend/data/alpaca-reconcile.json (the last night's output: its asOf names the night),
 * backend/data/alpaca-mirror.jsonl and alpaca-mirror-exits.jsonl (both append-only: the rows stamped at or before that asOf are the
 * night's input exactly).
 * WHAT IT WRITES, in harness/recorded/ (each file then made read-only):
 *   last-night.json         the night's real output, byte for byte
 *   alpaca-mirror.jsonl     the mirror's order rows of the night (the fields the reconcile reads: ts, ticketId, sym, side, qty,
 *                           ticketEntry, orderId, late)
 *   alpaca-mirror-exits.jsonl  the exit rows with a close order (ts, ticketId, closeOrderId, final, closeQty, closeFill)
 *   trade_log.json          the ledger fields the reconcile read that night, per mirrored ticket (id, exit, pnl, reason), as its rows
 *                           show them (the ledger has moved on since; these are the night's values)
 *   responses.json          the broker's answers, one per call the reconcile made that night: GET /v2/orders/<id>?nested=true for every
 *                           non-late row, GET /v2/orders/<closeOrderId> where the exits row was not final with a close fill — each
 *                           rebuilt from that ticket's row (fill, filled quantity, the exit leg or close order and its fill)
 *   MANIFEST.json           sha256 of each, the sources' sha256 at build time, the counts
 * THE PROOF that the set is the night: the package's BASE copy of backend/alpaca-reconcile.js, run on it in a scratch tree under the fake
 * broker with the clock at the night's asOf, writes the night's alpaca-reconcile.json BYTE FOR BYTE. Otherwise nothing is written.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const T = require("./tree.cjs");
const OUT_DIR = path.join(T.HARNESS, "recorded"), DATA = path.join(T.REPO, "backend", "data");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const MX = "mirror-exit (board closed)";
const jl = (text) => text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };

/** the night's set, in memory, from the three real files -> { files: { name: text }, cfg, counts } */
function buildSet({ dataDir = DATA } = {}) {
  const lastText = fs.readFileSync(path.join(dataDir, "alpaca-reconcile.json"), "utf8"), L = JSON.parse(lastText), asOf = L.asOf;
  if (!asOf || !Array.isArray(L.perTicket)) throw new Error("alpaca-reconcile.json has no asOf or no perTicket list");
  const mirAll = jl(fs.readFileSync(path.join(dataDir, "alpaca-mirror.jsonl"), "utf8")), exAll = jl(fs.readFileSync(path.join(dataDir, "alpaca-mirror-exits.jsonl"), "utf8"));
  const mir = mirAll.filter((r) => r.orderId && String(r.ts || "") <= asOf).map((r) => ({ ...pick(r, ["ts", "ticketId", "sym", "side", "qty", "ticketEntry", "orderId"]), ...(r.late ? { late: true } : {}) }));
  const ex = exAll.filter((x) => x.closeOrderId && String(x.ts || "") <= asOf).map((x) => pick(x, ["ts", "ticketId", "closeOrderId", "final", "closeQty", "closeFill"]));
  const rows = mir.filter((r) => !r.late), exitBy = new Map(ex.map((x) => [x.ticketId, x]));
  if (rows.length !== L.mirrored) throw new Error(`the mirror log holds ${rows.length} non-late order rows at or before ${asOf}, the night's output says ${L.mirrored}`);
  const ptBy = new Map(); for (const p of L.perTicket) { if (ptBy.has(p.ticketId)) throw new Error(`two rows for ${p.ticketId} in the night's output — not rebuilt`); ptBy.set(p.ticketId, p); }
  const responses = {}, ledger = []; let entryCalls = 0, closeCalls = 0;
  // one close order can serve several tickets (the mirror closes a crypto position once for its tickets): the rebuilt answer must agree
  const answerFor = (p, oc) => { if (Object.prototype.hasOwnProperty.call(responses, p) && JSON.stringify(responses[p]) !== JSON.stringify(oc)) throw new Error(`two tickets ask ${p} and their rows rebuild different answers — not rebuilt`); responses[p] = oc; };
  for (const r of rows) {
    const p = ptBy.get(r.ticketId); if (!p) throw new Error(`no row for ${r.ticketId} in the night's output`);
    const ePath = `/v2/orders/${r.orderId}?nested=true`, x = exitBy.get(r.ticketId); entryCalls++;
    if (p.issue === "broker has no record of this order") { responses[ePath] = { status: 404, json: { code: 40410000, message: "order not found" } }; continue; }
    if (p.issue === "never filled") { responses[ePath] = { status: 200, json: { id: r.orderId, ...(Object.prototype.hasOwnProperty.call(p, "brokerStatus") ? { status: p.brokerStatus } : {}), filled_qty: "0", filled_avg_price: null, legs: null } }; continue; }
    if (p.issue) throw new Error(`${r.ticketId}: an issue this builder does not know (${p.issue})`);
    const parts = p.brokerExitReason ? String(p.brokerExitReason).split(" + ") : [], legKinds = parts.filter((k) => k !== MX), viaClose = parts.includes(MX);
    if (legKinds.length + (viaClose ? 1 : 0) > 1) throw new Error(`${r.ticketId}: two kinds of exit (${p.brokerExitReason}) — their split is not in the row; not rebuilt`);
    const exQ = p.brokerExitQty != null ? p.brokerExitQty : p.qty;
    const legs = ["limit", "stop"].map((k) => ({ id: `${r.orderId}-${k}`, order_type: k, status: "canceled", filled_qty: "0", filled_avg_price: null }));
    if (legKinds.length) { let leg = legs.find((l) => l.order_type === legKinds[0]); if (!leg) { leg = { id: `${r.orderId}-${legKinds[0]}`, order_type: legKinds[0] }; legs.push(leg); } Object.assign(leg, { status: "filled", filled_qty: String(exQ), filled_avg_price: String(p.brokerExit) }); }
    responses[ePath] = { status: 200, json: { id: r.orderId, status: "filled", qty: String(r.qty), filled_qty: String(p.qty), filled_avg_price: String(p.brokerFill), legs } };
    const closeFinal = x && x.final && Number(x.closeQty) > 0 && Number(x.closeFill) > 0;
    if (x && !closeFinal) { closeCalls++; answerFor(`/v2/orders/${x.closeOrderId}`, viaClose ? { status: 200, json: { id: x.closeOrderId, status: "filled", filled_qty: String(exQ), filled_avg_price: String(p.brokerExit) } } : { status: 200, json: { id: x.closeOrderId, status: "canceled", filled_qty: "0", filled_avg_price: null } }); }
    else if (viaClose && !closeFinal) throw new Error(`${r.ticketId}: a mirror exit with no close order in the exits log`);
    // the ledger as the row shows it: ourReason absent = the ticket was there with no reason; all three null = not there (either way the same row)
    const has = Object.prototype.hasOwnProperty.call(p, "ourReason");
    if (!has) ledger.push({ id: r.ticketId, ...(p.ourExit != null ? { exit: p.ourExit } : {}), ...(p.ourPnl != null ? { pnl: p.ourPnl } : {}) });
    else if (p.ourExit != null || p.ourPnl != null || p.ourReason != null) ledger.push({ id: r.ticketId, ...(p.ourExit != null ? { exit: p.ourExit } : {}), ...(p.ourPnl != null ? { pnl: p.ourPnl } : {}), reason: p.ourReason });
  }
  const toJl = (a) => a.map((o) => JSON.stringify(o)).join("\n") + (a.length ? "\n" : "");
  const files = { "last-night.json": lastText, "alpaca-mirror.jsonl": toJl(mir), "alpaca-mirror-exits.jsonl": toJl(ex), "trade_log.json": JSON.stringify(ledger, null, 1), "responses.json": JSON.stringify({ nowIso: asOf, responses }, null, 1) };
  return { files, asOf, counts: { mirrorRows: mir.length, nonLate: rows.length, late: mir.length - rows.length, exitsRows: ex.length, ledgerRows: ledger.length, entryCalls, closeCalls, calls: entryCalls + closeCalls } };
}
/** run a reconcile text on a set's files in a scratch tree -> runTree's result */
function runOnSet(scriptText, files, { args = [], responses = null, nowIso = null } = {}) {
  const R = JSON.parse(files["responses.json"]);
  const tree = T.makeTree({ scriptText, data: { "alpaca-mirror.jsonl": files["alpaca-mirror.jsonl"], "alpaca-mirror-exits.jsonl": files["alpaca-mirror-exits.jsonl"], "trade_log.json": files["trade_log.json"] } });
  try { return T.runTree(tree, { cfg: { nowIso: nowIso || R.nowIso, responses: responses || R.responses, fallback: null }, args }); } finally { tree.done(); }
}
/** read the saved set and check it against its manifest -> { files, manifest } or throws naming what differs */
function loadSet(dir = OUT_DIR) {
  const man = JSON.parse(fs.readFileSync(path.join(dir, "MANIFEST.json"), "utf8")), files = {};
  for (const [name, m] of Object.entries(man.files || {})) { const b = fs.readFileSync(path.join(dir, name)); if (sha(b) !== m.sha256) throw new Error(`harness/recorded/${name} is not the file the manifest names (sha256 differs)`); files[name] = b.toString("utf8"); }
  for (const need of ["last-night.json", "alpaca-mirror.jsonl", "alpaca-mirror-exits.jsonl", "trade_log.json", "responses.json"]) if (!(need in files)) throw new Error(`harness/recorded/${need} is not in the manifest`);
  return { files, manifest: man };
}
module.exports = { buildSet, runOnSet, loadSet, OUT_DIR, sha };

if (require.main === module) {
  if (process.argv.length > 2) { console.log("usage: node docs/reconcile-pacing/2026-10-14/harness/build-recorded.cjs   (no arguments)\nNothing was done."); process.exit(2); }
  if (fs.existsSync(path.join(OUT_DIR, "MANIFEST.json"))) { console.log(`REFUSED — ${path.relative(T.REPO, OUT_DIR)} already holds a recorded set (the package's known answer). Remove it by hand to make a new one. Nothing was written.`); process.exit(2); }
  const S = buildSet(), base = fs.readFileSync(path.join(T.PKG, "base", "backend", "alpaca-reconcile.js"), "utf8");
  const r = runOnSet(base, S.files);
  if (r.outText !== S.files["last-night.json"]) {
    const A = r.out ? r.out.perTicket || [] : [], B = JSON.parse(S.files["last-night.json"]).perTicket; let first = null;
    for (let i = 0; i < Math.max(A.length, B.length); i++) if (JSON.stringify(A[i]) !== JSON.stringify(B[i])) { first = { i, base: A[i], night: B[i] }; break; }
    console.log(`REFUSED — the base copy on the rebuilt set does NOT write the night's output byte for byte (exit ${r.status}; ${r.stderr.trim().slice(0, 200)}); first differing row: ${JSON.stringify(first)}. Nothing was written.`); process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const man = { schema: "reconcile-pacing-recorded-v1", builtAt: new Date().toISOString(), builtBy: "docs/reconcile-pacing/2026-10-14/harness/build-recorded.cjs", night: S.asOf,
    sources: Object.fromEntries(["alpaca-reconcile.json", "alpaca-mirror.jsonl", "alpaca-mirror-exits.jsonl"].map((f) => [`backend/data/${f}`, sha(fs.readFileSync(path.join(DATA, f)))])),
    proof: `the package's base/backend/alpaca-reconcile.js (sha256 ${sha(Buffer.from(base))}) on this set, clock at ${S.asOf}, writes last-night.json byte for byte`, counts: S.counts, files: {} };
  for (const [name, text] of Object.entries(S.files)) { const f = path.join(OUT_DIR, name); fs.writeFileSync(f, text); man.files[name] = { sha256: sha(Buffer.from(text)), bytes: Buffer.byteLength(text) }; }
  fs.writeFileSync(path.join(OUT_DIR, "MANIFEST.json"), JSON.stringify(man, null, 1) + "\n");
  for (const name of [...Object.keys(S.files), "MANIFEST.json"]) fs.chmodSync(path.join(OUT_DIR, name), 0o444);
  console.log(`RECORDED SET WRITTEN (read-only) — night ${S.asOf}: ${S.counts.nonLate} order rows (+${S.counts.late} late), ${S.counts.exitsRows} exit rows, ${S.counts.ledgerRows} ledger rows, ${S.counts.calls} broker answers (${S.counts.entryCalls} entry + ${S.counts.closeCalls} close); the base copy reproduces the night's output byte for byte`);
}
