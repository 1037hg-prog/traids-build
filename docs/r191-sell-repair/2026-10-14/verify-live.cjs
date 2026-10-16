#!/usr/bin/env node
"use strict";
/**
 * R191 SELL REPAIR (2026-10-14) — VERIFY, read-only, for AFTER the apply.
 *   node docs/r191-sell-repair/2026-10-14/verify-live.cjs
 * Each numbered line ends PASS, FAIL or UNKNOWN. Exit 0 every line PASS · 1 any FAIL · 3 no FAIL but an UNKNOWN (never read as a pass).
 * It writes nothing in the repo, sends nothing, restarts nothing, makes no ssh call and asks the broker NOTHING. What it runs, all read-only:
 *   1  the live runner IS the staged copy, byte for byte (the base copy: NOT APPLIED, a FAIL; anything else: DRIFT, a FAIL; the checks below
 *      are then skipped)
 *   2  node --check of the live runner
 *   3  THE BTC SELL IT WOULD ASK, on COPIES OF TODAY'S FILES: the LIVE runner's own dry mode (--run without --live) in its own sandbox
 *      (R191_STATE_DIR: a temp folder holding copies of backend/data/r191-crypto-trend.json and .jsonl, r231-crypto-vote-sized.json and the
 *      mirror's two files; every network call refused by the R231 package's harness/no-net.cjs). Two inputs are MADE UP and said so: the
 *      daily closes (R191_BARS_FILE: a falling series that ends yesterday at R191's last recorded close, so the rule's sell is due) and the
 *      account (R191_POSITIONS_FILE: a MODEL — what R191 received for its buys still in a count, plus what R231 and the mirror count; what
 *      R191 received is its count when that count is already net of the fee, else its count less each such buy's fee AS THE BROKER'S OWN
 *      FEE ROWS RECORDED BY THIS PACKAGE SAY (harness/recorded/cfee-rows.json, read as the restate reads them: 0.000291630 for the BTC buy of
 *      2026-09-25), and only for a buy those rows do not cover, 0.25% of it rounded up at 9 decimals; the line says which). The line must be
 *      the sell capped to what the account holds for R191, to the digit, exit 0, nothing on stderr.
 *   4  the same with R231's state missing from the sandbox: no sell of BTC (R231 can hold BTC), the line says why, exit 1, the reason last on
 *      stderr
 *   5  the same with NO account fixture: the sell is the whole count, as before the repair (a sandbox with no account sends nothing and has no
 *      account to read)
 *   6  the sleeve package's table (docs/server/wave3-sleeves/cell.cjs --selftest): its cases about this runner's files and account keys are ok
 *   then, as plain facts (INFO lines, no verdict; printed BEFORE the apply too): R191's book, whether its count is net of the fee, the other
 *   sleeves' files as the runner reads them, the switch, and whether the server holds this runner.
 * When R191 holds no coin today, check 3-5 use the made-up book of harness/fixtures.cjs instead, and say so.
 * `verify({ root, live, dataDir })` is exported: the selftest runs it on temp copies and, whole, on the staged text through the overlay.
 */
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const L = require("./lib.cjs"), RL = L.RL;
const childEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|SECRET|TOKEN|PASSWORD|ALPACA|SCHWAB|TASTY|TELEGRAM|SMTP|ANTHROPIC|R231_|R191_/i.test(k))), ...extra });
const node = (args, o = {}) => cp.spawnSync(process.execPath, args, { cwd: L.REPO, encoding: "utf8", timeout: 600000, windowsHide: true, maxBuffer: 128 << 20, env: childEnv(), ...o });
const CELL_CASES = ["every data file / input / switch the table names for a unit is named in its script (the table invents no file)", "ACCOUNTS VERIFIED: each script names its account's key ids and no other account's (main / TV / book)"];
const NO_NET = path.join(L.REPO, "docs", "r231-sell-repair", "2026-10-12", "harness", "no-net.cjs").replace(/\\/g, "/");
const OTHER_FILES = ["r231-crypto-vote-sized.json", "alpaca-mirror.jsonl", "alpaca-mirror-exits.jsonl"];

/** the broker's own fee rows as this package recorded them (restate.cjs --dry, 2026-10-14 19:50 MT): a list, or null when the file cannot be read */
const RECORDED_ROWS = path.join(__dirname, "harness", "recorded", "cfee-rows.json");
function recordedRows(file = RECORDED_ROWS) { try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(j && j.rows) ? j.rows : null; } catch { return null; } }
/**
 * the model account and the sell the runner must ask, worked out HERE from the files (pure but for the reads of `dir` and of the recorded rows).
 * What R191 received for each of its buys still in a count is read from the BROKER'S OWN FEE ROWS AS RECORDED (`rows`, harness/recorded/
 * cfee-rows.json, through lib.cjs feeFor: the reading the restate makes) when they cover that buy; only a buy they do not cover (one after
 * 2026-10-14) is MODELLED, at 0.25% of its filled quantity rounded up at 9 decimals — and `feeFrom` says which. No broker read here.
 */
function expected(dir, coin = "BTC", rows = recordedRows()) {
  const s = JSON.parse(fs.readFileSync(path.join(dir, "r191-crypto-trend.json"), "utf8")), O = L.readOthers(dir), OB = L.openBuys(s), st = s.coins[coin];
  const per = OB.todo.filter((r) => r.coin === coin).map((r) => { let f = null; try { f = rows && !O.notes.length ? L.feeFor(r.o, coin, s, rows, O) : null; } catch { f = null; } return f && f.feeNano != null ? { cid: r.o.cid, fee: f.feeNano, from: "broker" } : { cid: r.o.cid, fee: Math.ceil(L.nano(r.o.qty) * 0.0025 - 1e-6), from: "model" }; });
  const fee = per.reduce((a, p) => a + p.fee, 0), cnt = L.nano(st.qty), received = cnt - fee, oth = O.n[coin] || 0, acct = received + oth;
  const feeFrom = !per.length ? "net" : per.every((p) => p.from === "broker") ? "broker" : per.every((p) => p.from === "model") ? "model" : "mixed";
  const marks = (s.marks || []).filter((m) => m && m.coin === coin && m.close != null).sort((a, b) => (a.d < b.d ? -1 : 1)), px = marks.length ? marks[marks.length - 1].close : 80000;
  const room = Math.max(0, acct - oth), left = cnt - room, usd = ((left / 1e9) * px).toFixed(2), words = `the account holds ${L.s9(acct)}${oth ? `, of which other sleeves count ${L.s9(oth)} (${O.why[coin].join(", ")})` : ""}`;
  const tail = room >= cnt ? `DRY SELL ${st.qty}` : `DRY SELL ${L.qn(room)} · CLOSE cut to the ${L.s9(room)} the account has for this book, of ${L.s9(cnt)} counted (${words}); the other ${L.s9(left)} ($${usd}) is written off when this fills in full`;
  return { coin, count: st.qty, fee, per, feeFrom, received, others: oth, acct, room, px, tail, net: fee === 0, notes: O.notes };
}
/** how the model account's receipt was worked out, in words (pure) */
const feeWords = (X) => X.feeFrom === "net" ? " — its count is net of the fee already" : X.feeFrom === "broker" ? `, its count less ${L.s9(X.fee)} of fee, as the broker's own fee rows recorded by this package say (harness/recorded/cfee-rows.json)` : X.feeFrom === "model" ? `, its count less ${L.s9(X.fee)} of fee MODELLED at 0.25% rounded up (the recorded broker rows do not cover ${X.per.map((p) => p.cid).join(", ")})` : `, its count less ${L.s9(X.fee)} of fee (${X.per.map((p) => `${p.cid} ${L.s9(p.fee)} ${p.from === "broker" ? "from the broker's recorded rows" : "MODELLED at 0.25%: the recorded rows do not cover it"}`).join("; ")})`;
/** one run of the LIVE runner's own dry mode in its own sandbox, no network: `files` = { name: text | null } copied in beside the state */
function sandboxRun(tmp, n, { files, account, px, lastDay }) {
  const dir = path.join(tmp, "sbx" + n); fs.mkdirSync(dir, { recursive: true });
  for (const [f, t] of Object.entries(files)) if (t != null) fs.writeFileSync(path.join(dir, f), t);
  const FX = require("./harness/fixtures.cjs"), bars = { BTC: FX.series(px.BTC, false, lastDay), ETH: FX.series(px.ETH, false, lastDay) }, fx = path.join(dir, "bars-fixture.json"); fs.writeFileSync(fx, JSON.stringify(bars));
  const env = { R191_STATE_DIR: dir, R191_BARS_FILE: fx };
  if (account) { env.R191_POSITIONS_FILE = path.join(dir, "positions-fixture.json"); fs.writeFileSync(env.R191_POSITIONS_FILE, JSON.stringify(Object.entries(account).filter(([, q]) => q > 0).map(([c, q]) => ({ asset_class: "crypto", symbol: `${c}USD`, qty: L.s9(q), qty_available: L.s9(q) })))); }
  const opts = [process.env.NODE_OPTIONS, `--require "${NO_NET}"`].filter(Boolean).join(" ");
  const r = node([path.join(L.REPO, ...L.R191.split("/")), "--run"], { env: childEnv({ ...env, NODE_OPTIONS: opts }), timeout: 120000 });
  return { status: r.status, out: String(r.stdout || ""), err: String(r.stderr || ""), lines: String(r.stdout || "").split(/\r?\n/), dir };
}
/** THE FACTS LINES (no verdict), read from the files each time. Read-only; `dataDir` and `root` are injectable (the selftest types them). */
function facts(dataDir = path.join(L.REPO, "backend", "data"), root = L.REPO) {
  const out = [], D = (f) => path.join(dataDir, f);
  try {
    const s = JSON.parse(fs.readFileSync(D("r191-crypto-trend.json"), "utf8")), OB = L.openBuys(s), held = L.COINS.filter((c) => s.coins[c] && s.coins[c].qty > 0), pend = L.COINS.filter((c) => s.coins[c] && s.coins[c].pending), short = L.COINS.filter((c) => s.coins[c] && s.coins[c].closeShort);
    out.push(`R191 book now: ${held.length ? held.map((c) => `${c} ${s.coins[c].qty}`).join(", ") : "no coin held"}; ${pend.length ? `order pending: ${pend.join(", ")}` : "no order pending"}${short.length ? `; a close left short and noted: ${short.join(", ")}` : ""}`);
    out.push(`count: ${s.netOfFee ? `restated net of the buy fee at ${s.netOfFee.restatedAt} (change-registry ${s.netOfFee.changeRegistry})` : "NOT restated"}; ${OB.todo.length} buy(s) still in a count at the filled quantity${OB.settled.length ? ` (${OB.settled.length} other buy(s) settled by a later close)` : ""}${OB.todo.length ? ` — see them net, without writing: node ${L.PKG_REL}/restate.cjs --dry` : ""}`);
  } catch (e) { out.push(`R191's state could not be read for the facts lines (${String(e.message).slice(0, 120)})`); }
  { const O = L.readOthers(dataDir); out.push(`the other sleeves' files, as the runner reads them here: ${O.notes.length ? "NOT READABLE — " + O.notes.join("; ") : `readable; they count ${L.COINS.map((c) => `${c} ${L.s9(O.n[c] || 0)}`).join(", ")}${L.COINS.some((c) => O.unsettled[c]) ? `; not settled: ${L.COINS.filter((c) => O.unsettled[c]).join(", ")}` : ""}`}`); }
  out.push(`switch backend/data/r191-OFF: ${fs.existsSync(D("r191-OFF")) ? "SET (buys withheld)" : "not set"}`);
  try { const w3 = JSON.parse(fs.readFileSync(path.join(root, "docs", "server", "wave3-sleeves", "deploy-state.json"), "utf8")), c = (w3.steps || {}).copy || {}, sha = (c.real || {})[L.R191], live = L.sha256(fs.readFileSync(path.join(root, ...L.R191.split("/"))));
    out.push(sha === live ? `the server: the sleeve package's last copy step (${c.at}) sent this very runner (${live.slice(0, 12)})` : `the server: the sleeve package's last copy step (${c.at || "no time on record"}) sent ${sha ? sha.slice(0, 12) : "no copy of this runner"}; the live runner is ${live.slice(0, 12)} — the server's two copies are STALE, and stay so: w3-r191 is held at home and the HARD RULE of work order 4.34 stands (no copy step for any sleeve until R191's and R231's files reach both server data folders; NOTES.md, 'On the server')`);
  } catch (e) { out.push(`the server: the sleeve package's record could not be read (${String(e.message).slice(0, 80)})`); }
  return out;
}

function verify({ root = L.REPO, live = root === L.REPO, dataDir = path.join(L.REPO, "backend", "data") } = {}) {
  const lines = [], say = (status, text) => lines.push({ status, text });
  const done = () => ({ lines, code: lines.some((l) => l.status === "FAIL") ? 1 : lines.some((l) => l.status === "UNKNOWN") ? 3 : 0 });
  const addFacts = () => { for (const text of facts(dataDir, root)) say("INFO", text); };
  // 1
  let U, P; try { U = L.unit(); P = L.plan({ root, U }); } catch (e) { say("FAIL", `1 applied: the package's copies or the live file cannot be read (${String(e.message).slice(0, 160)})`); return done(); }
  if (P.state !== "applied") { say("FAIL", `1 applied: ${P.state === "base" ? `NOT APPLIED — the live runner is the base copy (${U.baseSha.slice(0, 12)})` : `DRIFT — ${P.problem}`}`); say("UNKNOWN", "2-6: skipped — the unit is not applied on this file"); if (live) addFacts(); return done(); }
  say("PASS", `1 applied: the live runner is the staged copy, byte for byte (${U.stagedSha.slice(0, 12)})`);
  // 2
  { const r = cp.spawnSync(process.execPath, ["--check", path.join(root, ...L.R191.split("/"))], { encoding: "utf8", windowsHide: true }); say(r.status === 0 ? "PASS" : "FAIL", `2 parse: ${r.status === 0 ? "node --check passes on the runner" : String(r.stderr).trim().split("\n")[0]}`); }
  if (!live) return done();
  // 3, 4, 5
  { const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r191-verify-"));
    try {
      const real = Object.fromEntries(["r191-crypto-trend.json", "r191-crypto-trend.jsonl", ...OTHER_FILES].map((f) => [f, fs.existsSync(path.join(dataDir, f)) ? fs.readFileSync(path.join(dataDir, f), "utf8") : null]));
      const st = JSON.parse(real["r191-crypto-trend.json"]), FX = require("./harness/fixtures.cjs"), madeUp = !(st.coins && st.coins.BTC && st.coins.BTC.qty > 0);
      const files = madeUp ? { "r191-crypto-trend.json": JSON.stringify(FX.state()), "r191-crypto-trend.jsonl": "", "r231-crypto-vote-sized.json": real["r231-crypto-vote-sized.json"], "alpaca-mirror.jsonl": real["alpaca-mirror.jsonl"], "alpaca-mirror-exits.jsonl": real["alpaca-mirror-exits.jsonl"] } : real;
      const probe = path.join(tmp, "probe"); fs.mkdirSync(probe); for (const [f, t] of Object.entries(files)) if (t != null) fs.writeFileSync(path.join(probe, f), t);
      const X = expected(probe), last = (c) => { const m = ((madeUp ? FX.state() : st).marks || []).filter((x) => x && x.coin === c && x.close != null).sort((a, b) => (a.d < b.d ? -1 : 1)); return m.length ? m[m.length - 1].close : FX.LAST[c]; };
      const px = { BTC: X.px, ETH: last("ETH") }, lastDay = new Date(Date.now() - 864e5).toISOString().slice(0, 10), ETHacct = L.nano(((madeUp ? FX.state() : st).coins.ETH || {}).qty || 0) + (L.readOthers(probe).n.ETH || 0);
      const what = madeUp ? "R191 holds no BTC today: the made-up book (BTC 0.116651415, its buy of 2026-09-25 at the filled quantity) with today's other files" : "copies of today's files";
      if (X.notes.length) say("UNKNOWN", `3 the BTC sell on ${what}: the other sleeves' files cannot be read here (${X.notes.join("; ").slice(0, 200)}) — run this again when they can`);
      else {
        const r = sandboxRun(tmp, 3, { files, account: { BTC: X.acct, ETH: ETHacct }, px, lastDay }), line = r.lines.find((l) => /^ {2}BTC close /.test(l)) || "", stuck = /network refused|sandbox: no broker call/.test(r.err) && r.status !== 0;
        if (r.status === 0 && line.endsWith(` -> OUT (held true) · ${X.tail}`) && !r.err.trim()) say("PASS", `3 THE BTC SELL IT WOULD ASK, the live runner's own dry mode on ${what} (closes made up to turn the rule's sell on; the account a MODEL from the files: R191 received ${L.s9(X.received)}${feeWords(X)}, plus ${L.s9(X.others)} the other sleeves count): it asks ${X.room >= L.nano(X.count) ? `the whole count, ${X.count}, which the account covers` : `${L.s9(X.room)}, what the account holds for R191, of the ${L.s9(L.nano(X.count))} counted`}; exit 0; nothing sent`);
        else if (stuck) say("UNKNOWN", `3 the BTC sell: the run did not get as far as its orders (exit ${r.status}: ${r.err.trim().split("\n")[0].slice(0, 160)})`);
        else say("FAIL", `3 the BTC sell on ${what}: expected a line ending ${JSON.stringify(X.tail.slice(0, 160))}, exit 0 — got exit ${r.status}, ${JSON.stringify(line.slice(0, 260))}${r.err ? " / " + r.err.trim().split("\n").pop().slice(0, 160) : ""}`);
        const f4 = { ...files, "r231-crypto-vote-sized.json": null }, r4 = sandboxRun(tmp, 4, { files: f4, account: { BTC: X.acct, ETH: ETHacct }, px, lastDay }), l4 = r4.lines.find((l) => /^ {2}BTC close /.test(l)) || "", e4 = r4.err.trim().split("\n").pop() || "";
        if (r4.status === 1 && / · NO SELL this run \(the rule asks [0-9.]+\) — data\/r231-crypto-vote-sized\.json cannot be read \(.*\) — what another sleeve counts of BTC is not known$/.test(l4) && /^r191: a sell the rule called for did NOT go.* — BTC: data\/r231-crypto-vote-sized\.json cannot be read/.test(e4)) say("PASS", "4 the same with R231's state file missing: no sell of BTC (a coin R231 can hold) and the line says why; exit 1; the reason is the last line on stderr");
        else say("FAIL", `4 R231's file unreadable: expected no sell of BTC, exit 1 and the reason last on stderr — got exit ${r4.status}, ${JSON.stringify(l4.slice(0, 200))}, last stderr line ${JSON.stringify(e4.slice(0, 160))}`);
        const r5 = sandboxRun(tmp, 5, { files, account: null, px, lastDay }), l5 = r5.lines.find((l) => /^ {2}BTC close /.test(l)) || "";
        if (r5.status === 0 && l5.endsWith(` -> OUT (held true) · DRY SELL ${X.count}`) && !/ACCOUNT ·|NO SELL/.test(r5.out) && !r5.err.trim()) say("PASS", `5 the same with NO account fixture: the sell is the whole count, ${X.count}, as before the repair (a sandbox with no account has none to read and sends nothing); exit 0`);
        else say("FAIL", `5 no account fixture: expected 'DRY SELL ${X.count}' and exit 0 — got exit ${r5.status}, ${JSON.stringify(l5.slice(0, 200))}`);
      }
    } catch (e) { say("UNKNOWN", `3-5 the live runner in its own sandbox: could not be run (${String(e.message).slice(0, 160)})`); }
    finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a temp folder */ } } }
  // 6
  try {
    const r = node([path.join(L.REPO, "docs", "server", "wave3-sleeves", "cell.cjs"), "--selftest"]), c = RL.parseCases(r.status, r.stdout, r.stderr), miss = CELL_CASES.filter((n) => !c.okNames.some((x) => x.startsWith(n)));
    if (!c.ok && !c.fail) say("UNKNOWN", `6 the sleeve package's table: its selftest printed no case (exit ${r.status})`);
    else say(miss.length ? "FAIL" : "PASS", `6 the sleeve package's table (cell.cjs --selftest): ${miss.length ? "not ok — " + miss.map((n) => JSON.stringify(n.slice(0, 70))).join(", ") : `its cases about this runner are ok — the files and the switch the table names for w3-r191 are named in the runner, and it names the main account's keys and no other (the whole selftest: ${c.ok} ok, ${c.fail} failed)`}`);
  } catch (e) { say("UNKNOWN", `6 the sleeve package's table: could not be run (${String(e.message).slice(0, 160)})`); }
  addFacts();
  return done();
}

if (require.main === module) {
  if (process.argv.length > 2) { console.log("usage: node docs/r191-sell-repair/2026-10-14/verify-live.cjs   (read-only; no argument)"); process.exit(2); }
  let v; try { v = verify(); } catch (e) { console.log(`UNKNOWN  verify-live could not run: ${e.message}`); process.exit(3); }
  for (const l of v.lines) console.log(`${l.status.padEnd(8)} ${l.text}`);
  const n = (s) => v.lines.filter((l) => l.status === s).length;
  console.log(v.code === 0 ? `VERIFIED: ${n("PASS")} of ${n("PASS")} checks PASS.` : v.code === 1 ? `NOT VERIFIED: ${n("FAIL")} FAIL, ${n("UNKNOWN")} UNKNOWN, ${n("PASS")} PASS.` : `NOT CONFIRMED: no FAIL, but ${n("UNKNOWN")} UNKNOWN — read the line(s) and run this again.`);
  process.exit(v.code);
}
module.exports = { verify, facts, expected, feeWords, recordedRows, sandboxRun };
