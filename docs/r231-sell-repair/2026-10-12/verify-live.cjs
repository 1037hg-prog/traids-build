#!/usr/bin/env node
"use strict";
/**
 * R231 SELL REPAIR (2026-10-12) — VERIFY, read-only, for AFTER the apply.
 *   node docs/r231-sell-repair/2026-10-12/verify-live.cjs
 * Each numbered line ends PASS, FAIL or UNKNOWN. Exit 0 every line PASS · 1 any FAIL · 3 no FAIL but an UNKNOWN (never read as a pass).
 * It writes nothing in the repo, sends nothing, restarts nothing, makes no ssh call and asks the broker NOTHING. What it runs, all read-only:
 *   1  every staged edit reads APPLIED on the live file (still base, mixed or drifted is a FAIL, and the checks below are skipped)
 *   2  node --check of the runner
 *   3  the unit this one was cut on top of (docs/pause-switches/2026-10-12: R231 sells under a pause) still reads applied on the same file
 *   4  the LIVE runner, run once in its OWN sandbox (R231_STATE_DIR: a temp copy of a made-up book, no broker call; a bars fixture instead
 *      of Coinbase; R231_POSITIONS_FILE: a made-up account; every network call refused by harness/no-net.cjs): the BCH case to the last
 *      digit — the book counts 1.324516485, the account holds 1.321205193, the close asks for 1.321205193 — and an uncut sell prints as before
 *   5  the same, with R191's state file missing from the sandbox: no sell of ETH (a coin R191 can hold), BCH's close still asked, exit 1,
 *      the reason last on stderr
 *   6  the same book with the pause switch set and NO account fixture: the two sells the rule calls for are produced and the two buys are
 *      withheld, line for line as before this unit
 *   7  the sleeve package's table (docs/server/wave3-sleeves/cell.cjs --selftest): its cases about this runner's files and account keys are ok
 *   then, as plain facts (INFO lines, no verdict; printed BEFORE the apply too): whether the counts have been restated, how many buys are
 *   still counted at their filled quantity, whether the other sleeves' three files can be read here, and whether the server holds this runner
 * `verify({ root, live })` is exported: the selftest runs checks 1 and 2 on temp copies (live: false), and the whole of it on the staged text.
 */
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const L = require("./lib.cjs");
/** children never get a credential of this process; NODE_OPTIONS is kept (the selftest rehearses this file on the staged text through it) */
const childEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|SECRET|TOKEN|PASSWORD|ALPACA|SCHWAB|TASTY|TELEGRAM|SMTP|ANTHROPIC|R231_|R191_/i.test(k))), ...extra });
const node = (args, o = {}) => cp.spawnSync(process.execPath, args, { cwd: L.REPO, encoding: "utf8", timeout: 600000, windowsHide: true, maxBuffer: 128 << 20, env: childEnv(), ...o });
const CELL_CASES = ["every data file / input / switch the table names for a unit is named in its script (the table invents no file)", "ACCOUNTS VERIFIED: each script names its account's key ids and no other account's (main / TV / book)"];
const RUNNER = path.join(L.REPO, "backend", "r231-crypto-vote-sized-forward.js");

/** THE FACTS LINES (no verdict), read from the files each time. Read-only. `dataDir` and `root` are injectable: the selftest types the answer on a made-up folder. */
function facts(dataDir = path.join(L.REPO, "backend", "data"), root = L.REPO) {
  const out = [], D = (f) => path.join(dataDir, f);
  try {
    const s = JSON.parse(fs.readFileSync(D("r231-crypto-vote-sized.json"), "utf8")), held = Object.entries(s.coins || {}).filter(([, v]) => v && v.qty > 0), buys = (s.orders || []).filter((o) => o && o.side === "buy"), OB = L.openBuys(s), gross = [...OB.todo, ...OB.unknown.filter((u) => u.open)];   // the buys the restate would still take a fee off for (lib.cjs openBuys)
    const marks = (s.marks || []).filter(Boolean), lastDay = marks.reduce((a, m) => (String(m.d || "") > a ? String(m.d) : a), ""), voteOff = held.map(([k]) => k).filter((k) => marks.some((m) => m.d === lastDay && m.coin === k && m.eligible === false));
    out.push(`R231 book now: ${held.length} coin(s) held, ${Object.values(s.coins || {}).filter((v) => v && v.pending).length} order(s) pending; held with the vote OFF at its last marks (${lastDay || "no marks"}): ${voteOff.join(", ") || "none"}`);
    out.push(`counts: ${s.netOfFee ? `restated net of the buy fee at ${s.netOfFee.restatedAt} (change-registry ${s.netOfFee.changeRegistry})` : "NOT restated — every count on file is still the filled quantity"}; ${gross.length} of ${buys.length} buy(s) are counted at the filled quantity${OB.settled.length ? ` (${OB.settled.length} other buy(s) are of a coin that has since closed flat: settled, nothing of them is left to restate)` : ""}${gross.length ? ` — see them net, without writing: node ${L.PKG_REL}/restate.cjs` : ""}`);
  } catch (e) { out.push(`R231's state could not be read for the facts lines (${String(e.message).slice(0, 120)})`); }
  { const O = L.readOthers(dataDir); out.push(`the other sleeves' files, as the runner reads them here: ${O.notes.length ? "NOT READABLE — " + O.notes.join("; ") : `readable; they count ${Object.entries(O.n).map(([c, n]) => `${c} ${L.s9(n)}`).join(", ") || "no coin"}${Object.keys(O.unsettled).length ? `; not settled: ${Object.keys(O.unsettled).join(", ")}` : ""}`}`); }
  out.push(`switch backend/data/r231-OFF: ${fs.existsSync(D("r231-OFF")) ? "SET (buys withheld; sells under the rule go)" : "not set"}`);
  try { const w3 = JSON.parse(fs.readFileSync(path.join(root, "docs", "server", "wave3-sleeves", "deploy-state.json"), "utf8")), c = (w3.steps || {}).copy || {}, sha = (c.real || {})[L.R231], live = L.sha256(fs.readFileSync(path.join(root, ...L.R231.split("/"))));
    out.push(sha === live ? `the server: the sleeve package's last copy step (${c.at}) sent this very runner (${live.slice(0, 12)})` : `the server: the sleeve package's last copy step (${c.at || "no time on record"}) sent ${sha ? sha.slice(0, 12) : "no copy of this runner"}; the live runner is ${live.slice(0, 12)} — the server's two copies are STALE until   node docs/server/wave3-sleeves/deploy.cjs --step copy   (the operator's command)`);
  } catch (e) { out.push(`the server: the sleeve package's record could not be read (${String(e.message).slice(0, 80)})`); }
  return out;
}

/** one run of the live runner in its own sandbox, no network: `files` = { name: text } put in the sandbox folder beside the state */
function sandboxRun(tmp, n, { state, files = {}, account, off = false, lastDay }) {
  const FX = require("./harness/fixtures.cjs"), dir = path.join(tmp, "sbx" + n); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "r231-crypto-vote-sized.json"), JSON.stringify(state)); for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), t);
  if (off) fs.writeFileSync(path.join(dir, "r231-OFF"), "verify-live: a made-up pause in a temp folder\n");
  const fx = path.join(dir, "bars-fixture.json"); fs.writeFileSync(fx, JSON.stringify(FX.bars(lastDay)));
  const env = { R231_STATE_DIR: dir, R231_BARS_FILE: fx }; if (account) { env.R231_POSITIONS_FILE = path.join(dir, "positions-fixture.json"); fs.writeFileSync(env.R231_POSITIONS_FILE, JSON.stringify(Object.entries(account).map(([c, q]) => ({ asset_class: "crypto", symbol: `${c}USD`, qty: q, qty_available: q })))); }
  const pre = path.join(L.PKG, "harness", "no-net.cjs").replace(/\\/g, "/"), opts = [process.env.NODE_OPTIONS, `--require "${pre}"`].filter(Boolean).join(" ");
  const r = node([RUNNER, "--run"], { env: childEnv({ ...env, NODE_OPTIONS: opts }), timeout: 120000 });
  return { status: r.status, out: String(r.stdout || ""), err: String(r.stderr || ""), lines: String(r.stdout || "").split(/\r?\n/) };
}

function verify({ root = L.REPO, E = L.loadEdits(), live = root === L.REPO } = {}) {
  const lines = [], say = (status, text) => lines.push({ status, text });
  const done = () => ({ lines, code: lines.some((l) => l.status === "FAIL") ? 1 : lines.some((l) => l.status === "UNKNOWN") ? 3 : 0 });
  const addFacts = () => { for (const text of facts()) say("INFO", text); };
  // 1
  const P = L.plan(E, root), notApplied = P.filter((f) => f.state !== "applied");
  if (notApplied.length) { say("FAIL", `1 applied: NOT APPLIED — ${notApplied.map((f) => `${f.rel} ${f.problem || f.state}${f.states && f.state !== "base" ? ` (${f.states.filter((x) => x.state !== "applied").map((x) => `${x.id} ${x.state}`).join(", ")})` : ""}`).join("; ")}`); say("UNKNOWN", "2-7: skipped — the unit is not applied on this file"); if (live) addFacts(); return done(); }
  say("PASS", `1 applied: all ${E.edits.length} edits read applied on ${L.R231}`);
  // 2
  { const r = cp.spawnSync(process.execPath, ["--check", path.join(root, ...L.R231.split("/"))], { encoding: "utf8", windowsHide: true }); say(r.status === 0 ? "PASS" : "FAIL", `2 parse: ${r.status === 0 ? "node --check passes on the runner" : String(r.stderr).trim().split("\n")[0]}`); }
  if (!live) return done();
  // 3
  try { const PS = JSON.parse(fs.readFileSync(path.join(L.REPO, "docs", "pause-switches", "2026-10-12", "edits.json"), "utf8")).edits.filter((e) => e.file === L.R231), text = fs.readFileSync(RUNNER, "utf8"), st = PS.map((e) => L.editState(text, e));
    if (!PS.length) say("UNKNOWN", "3 the pause unit: its edits.json names no edit of this runner");
    else say(st.every((x) => x === "applied") ? "PASS" : "FAIL", `3 the pause unit (docs/pause-switches/2026-10-12): its edit of this runner reads ${st.join(", ")}${st.every((x) => x === "applied") ? " — while data/r231-OFF exists a buy is withheld and a sell the rule calls for goes" : " — this unit was cut on the runner with it applied; read that package's rollback.cjs --plan"}`); }
  catch (e) { say("UNKNOWN", `3 the pause unit: its edits could not be read (${String(e.message).slice(0, 120)})`); }
  // 4, 5, 6
  { const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rsr-verify-"));
    try {
      const FX = require("./harness/fixtures.cjs"), lastDay = FX.addDays(new Date().toISOString().slice(0, 10), -1), M = FX.mirrorFiles(), OTH = { "r191-crypto-trend.json": JSON.stringify(FX.r191State()), "alpaca-mirror.jsonl": M.entries, "alpaca-mirror-exits.jsonl": M.exits }, ACCT = FX.accountExact({ BCH: FX.BCH_HELD });
      const BCH = `  BCH · DRY SELL 1.321205 (target $0) · CLOSE cut to the 1.321205193 the account has for this book, of 1.324516485 counted (the account holds 1.321205193); the other 0.003311292 ($0.99) is written off when this fills in full`, ETH = "  ETH · DRY SELL 20.000000 (target $5000)", DOGE = "  DOGE · DRY SELL 1234.500000 (target $0)";
      const stuck = (r) => /sandbox|network refused/.test(r.err) && r.status !== 0 && !r.out.includes("signal:");
      { const r = sandboxRun(tmp, 4, { state: FX.state(), files: OTH, account: ACCT, lastDay }), miss = [BCH, ETH, DOGE].filter((l) => !r.lines.includes(l));
        if (r.status === 0 && !miss.length && !r.err.trim()) say("PASS", "4 the live runner in its own sandbox, the BCH case: the book counts 1.324516485, the made-up account holds 1.321205193 — the close asks for 1.321205193 and says the other 0.003311292 is written off when it fills; ETH's and DOGE's sells, which the account covers, print as before; exit 0; no broker call");
        else if (stuck(r)) say("UNKNOWN", `4 the live runner in its own sandbox: the run did not get as far as its orders (exit ${r.status}: ${r.err.trim().split("\n")[0].slice(0, 160)})`);
        else say("FAIL", `4 the live runner in its own sandbox, the BCH case: ${miss.length ? "missing " + miss.map((l) => JSON.stringify(l.trim().slice(0, 90))).join(", ") : "it did not end clean"} (exit ${r.status}${r.err ? ": " + r.err.trim().split("\n")[0].slice(0, 160) : ""})`); }
      { const files = { ...OTH }; delete files["r191-crypto-trend.json"];
        const r = sandboxRun(tmp, 5, { state: FX.state(), files, account: ACCT, lastDay }), last = r.err.trim().split("\n").pop() || "", eth = r.lines.find((l) => l.startsWith("  ETH · ")) || "";
        if (r.status === 1 && /^ {2}ETH · NO SELL this run \(the rule asks 20\.000000, target \$5000\) — data\/r191-crypto-trend\.json cannot be read/.test(eth) && r.lines.includes(BCH) && /^r231: a sell the rule called for did NOT go.* — ETH: /.test(last)) say("PASS", "5 the same with R191's state file missing: no sell of ETH (a coin R191 can hold) and the line says why; BCH's close is still asked; exit 1; the reason is the last line on stderr");
        else if (stuck(r)) say("UNKNOWN", `5 another sleeve's file unreadable: the run did not get as far as its orders (exit ${r.status}: ${r.err.trim().split("\n")[0].slice(0, 160)})`);
        else say("FAIL", `5 another sleeve's file unreadable: expected no sell of ETH, BCH's close asked, exit 1 and the reason last on stderr — got exit ${r.status}, ETH line ${JSON.stringify(eth.slice(0, 120))}, last stderr line ${JSON.stringify(last.slice(0, 120))}`); }
      { const r = sandboxRun(tmp, 6, { state: FX.state(), off: true, lastDay }), W = (c, usd) => `  ${c} · PAUSED (r231-OFF) — buy of $${usd} withheld (target $5000); sells under the rule still go`;
        const want = [ETH, DOGE, "  BCH · DRY SELL 1.324516 (target $0)", W("BTC", 2000), W("LINK", 5000)], miss = want.filter((l) => !r.lines.includes(l));
        if (r.status === 0 && !miss.length && !/DRY BUY|NO SELL|ACCOUNT ·/.test(r.out) && !r.err.trim()) say("PASS", "6 the pause, in a sandbox with no account fixture: the three sells the rule calls for are produced as before this unit (a sandbox sends nothing and has no account to read) and both buys are withheld; exit 0");
        else if (stuck(r)) say("UNKNOWN", `6 the pause: the run did not get as far as its orders (exit ${r.status}: ${r.err.trim().split("\n")[0].slice(0, 160)})`);
        else say("FAIL", `6 the pause, in a sandbox with no account fixture: ${miss.length ? "missing " + miss.map((l) => JSON.stringify(l.trim().slice(0, 80))).join(", ") : "a buy went, or a sell was held"} (exit ${r.status}${r.err ? ": " + r.err.trim().split("\n")[0].slice(0, 120) : ""})`); }
    } catch (e) { say("UNKNOWN", `4-6 the live runner in its own sandbox: could not be run (${String(e.message).slice(0, 160)})`); }
    finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a temp folder */ } } }
  // 7
  try {
    const r = node([path.join(L.REPO, "docs", "server", "wave3-sleeves", "cell.cjs"), "--selftest"]), c = L.parseCases(r.status, r.stdout, r.stderr), miss = CELL_CASES.filter((n) => !c.okNames.some((x) => x.startsWith(n)));
    if (!c.ok && !c.fail) say("UNKNOWN", `7 the sleeve package's table: its selftest printed no case (exit ${r.status})`);
    else say(miss.length ? "FAIL" : "PASS", `7 the sleeve package's table (cell.cjs --selftest): ${miss.length ? "not ok — " + miss.map((n) => JSON.stringify(n.slice(0, 70))).join(", ") : `its cases about this runner are ok — the files and the switch the table names for w3-r231 are named in the runner, and the runner names the main account's keys and no other (the whole selftest: ${c.ok} ok, ${c.fail} failed${c.fail ? " — it had failing cases before this unit too, on lines of home's .bat / chain / key files" : ""})`}`);
  } catch (e) { say("UNKNOWN", `7 the sleeve package's table: could not be run (${String(e.message).slice(0, 160)})`); }
  addFacts();
  return done();
}

if (require.main === module) {
  if (process.argv.length > 2) { console.log("usage: node docs/r231-sell-repair/2026-10-12/verify-live.cjs   (read-only; no argument)"); process.exit(2); }
  let v; try { v = verify(); } catch (e) { console.log(`UNKNOWN  verify-live could not run: ${e.message}`); process.exit(3); }
  for (const l of v.lines) console.log(`${l.status.padEnd(8)} ${l.text}`);
  const n = (s) => v.lines.filter((l) => l.status === s).length;
  console.log(v.code === 0 ? `VERIFIED: ${n("PASS")} of ${n("PASS")} checks PASS.` : v.code === 1 ? `NOT VERIFIED: ${n("FAIL")} FAIL, ${n("UNKNOWN")} UNKNOWN, ${n("PASS")} PASS.` : `NOT CONFIRMED: no FAIL, but ${n("UNKNOWN")} UNKNOWN — read the line(s) and run this again.`);
  process.exit(v.code);
}
module.exports = { verify, facts, sandboxRun };
