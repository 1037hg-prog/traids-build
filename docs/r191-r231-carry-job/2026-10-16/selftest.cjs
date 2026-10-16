#!/usr/bin/env node
/**
 * SELFTEST — the r191-r231-carry package, OFFLINE. 2026-10-16.
 *   node docs/r191-r231-carry-job/2026-10-16/selftest.cjs
 * A FAKE ssh and a FAKE scp (executables written to a temp bin folder put FIRST on PATH) stand in for the VPS: the fake ssh runs the job's
 * script with bash on THIS machine, every "/home/traids/" rewritten into a temp folder; the fake scp copies into the same temp folder. Both
 * refuse to run without that folder set, and log every call. No host is contacted: before any case runs, `ssh` and `scp` on PATH are proven to
 * be the fakes. The last line says "ALL ... PASSED" only when every case passed.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto");
const H = __dirname, JOB = path.join(H, "staged", "deploy", "server", "r191-r231-carry.cjs");
const C = require(JOB);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail ? " — " + String(detail).slice(0, 400) : "")); } };
const quiet = (s) => String(s).replace(/ALL/g, "all");

// ── the fakes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "carry-selftest-")), BIN = path.join(TMP, "bin"), VPS = path.join(TMP, "vps"), LOG = path.join(TMP, "calls.log");
fs.mkdirSync(BIN); fs.mkdirSync(VPS);
const FAKE_SSH = `#!/usr/bin/env node
"use strict";
const fs = require("fs"), cp = require("child_process");
const root = process.env.CARRY_FAKE_ROOT, log = process.env.CARRY_FAKE_LOG;
if (!root || !log) { console.error("fake ssh: CARRY_FAKE_ROOT / CARRY_FAKE_LOG not set — refusing"); process.exit(255); }
const a = process.argv.slice(2); let i = 0; while (i < a.length && a[i].startsWith("-")) i += a[i] === "-o" ? 2 : 1;
const host = a[i], script = a.slice(i + 1).join(" ");
fs.appendFileSync(log, JSON.stringify({ tool: "ssh", host, script }) + "\\n");
if (process.env.CARRY_FAKE_DOWN) { console.error("ssh: connect to host " + host + " port 22: Connection timed out"); process.exit(255); }
const r = cp.spawnSync("bash", ["-c", script.split("/home/traids/").join(root + "/home/traids/")], { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" });
process.stdout.write(String(r.stdout || "").split(root + "/home/traids/").join("/home/traids/"));   // the VPS's own paths back, as a real VPS prints them
process.exitCode = r.status == null ? 255 : r.status;
`;
const FAKE_SCP = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const root = process.env.CARRY_FAKE_ROOT, log = process.env.CARRY_FAKE_LOG;
if (!root || !log) { console.error("fake scp: CARRY_FAKE_ROOT / CARRY_FAKE_LOG not set — refusing"); process.exit(255); }
const a = process.argv.slice(2); let i = 0; while (i < a.length && a[i].startsWith("-")) i += a[i] === "-o" ? 2 : 1;
const local = a[i], dest = a[i + 1], m = /^([^:]+):(\\/.+)$/.exec(dest || "");
fs.appendFileSync(log, JSON.stringify({ tool: "scp", local, dest }) + "\\n");
if (!m) { console.error("fake scp: bad destination"); process.exit(1); }
if (process.env.CARRY_FAKE_DOWN) process.exit(255);
let b = fs.readFileSync(local); if (process.env.CARRY_FAKE_CORRUPT) b = Buffer.concat([b, Buffer.from("x")]);
try { fs.writeFileSync(root + m[2], b); } catch (e) { console.error("scp: " + e.message); process.exit(1); }
`;
fs.writeFileSync(path.join(BIN, "ssh"), FAKE_SSH, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, "scp"), FAKE_SCP, { mode: 0o755 });
process.env.PATH = BIN + path.delimiter + process.env.PATH;
process.env.CARRY_FAKE_ROOT = VPS; process.env.CARRY_FAKE_LOG = LOG;
for (const k of ["CARRY_FAKE_DOWN", "CARRY_FAKE_CORRUPT"]) delete process.env[k];

const realDir = () => VPS + C.REAL, shadowDir = () => VPS + C.SHADOW;
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
function freshVps() { fs.rmSync(path.join(VPS, "home"), { recursive: true, force: true }); fs.mkdirSync(realDir(), { recursive: true }); fs.mkdirSync(shadowDir(), { recursive: true }); fs.rmSync(LOG, { force: true }); }
const map = (r191, r231, w5 = {}) => ({ schema: "host-ownership-v1", units: { "w1-whales": "server", "w3-r191": r191, "w3-r231": r231, ...w5 } });
const STATE191 = JSON.stringify({ spec: "r191-state-v1", coins: { BTC: { qty: 0.1, held: true, pending: null }, ETH: { qty: 0, held: false, pending: null } }, marks: [], orders: [] }, null, 1);
const STATE231 = JSON.stringify({ spec: "r231-state-v1", coins: { BTC: { qty: 0.02, pending: null }, ETH: { qty: 0.5, pending: null } }, marks: [], orders: [] }, null, 1);
const MIR = '{"ts":"2026-10-15T14:00:00Z","ticketId":"t1","cls":"Crypto","sym":"BTC/USD","side":"buy","qty":0.001,"orderId":"o1","live":true}\n';
const MIREX = '{"ts":"2026-10-15T15:00:00Z","ticketId":"t1","final":true}\n';
function home(m, extra = {}) {
  const d = fs.mkdtempSync(path.join(TMP, "home-"));
  fs.writeFileSync(path.join(d, "host-ownership.json"), JSON.stringify(m));
  const files = { "r191-crypto-trend.json": STATE191, "r231-crypto-vote-sized.json": STATE231, "alpaca-mirror.jsonl": MIR, "alpaca-mirror-exits.jsonl": MIREX, "r191-OFF": "", "r231-OFF": "", ...extra };
  for (const [k, v] of Object.entries(files)) if (v != null) fs.writeFileSync(path.join(d, k), v);
  return d;
}
// the repo's own writeJsonAtomic, loaded from a temp copy marked commonjs (this clean copy has no backend/package.json; see NOTES.md)
const AW = path.join(TMP, "aw"); fs.mkdirSync(AW); fs.copyFileSync(path.resolve(H, "..", "..", "..", "backend", "lib", "atomic-write.js"), path.join(AW, "atomic-write.js")); fs.writeFileSync(path.join(AW, "package.json"), '{"type":"commonjs"}');
const { writeJsonAtomic } = require(path.join(AW, "atomic-write.js"));
const go = (d, more = {}) => C.run({ homeData: d, tmpDir: TMP, statusFile: path.join(d, "r191-r231-carry-status.json"), writeJson: writeJsonAtomic, ...more });
const rd = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const leftovers = () => [realDir(), shadowDir()].flatMap((d) => fs.readdirSync(d).filter((f) => f.startsWith(".carry-in-")));
const P = (p) => JSON.stringify({ real: p.real.map((x) => x.file + "<" + x.from), shadow: p.shadow.map((x) => x.file + "<" + x.from) });

console.log("fakes");
{
  const w = cp.spawnSync("bash", ["-c", "command -v ssh; command -v scp"], { encoding: "utf8" }).stdout.trim().split("\n");
  ok("ssh and scp on PATH are the FAKES in the temp bin folder (no host can be contacted)", w[0] === path.join(BIN, "ssh") && w[1] === path.join(BIN, "scp"), w.join(" "));
  const r = cp.spawnSync(path.join(BIN, "ssh"), ["traids", "true"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  ok("the fake ssh refuses to run without its temp folder set", r.status === 255 && /refusing/.test(r.stderr), r.stderr);
}

console.log("planCarry — known answers");
{
  const p = C.planCarry(map("home", "home"));
  ok("both home, board home (no w5-* unit): real tree NOTHING; shadow gets all four from home", P(p) === JSON.stringify({ real: [], shadow: ["r191-crypto-trend.json<home", "r231-crypto-vote-sized.json<home", "alpaca-mirror.jsonl<home", "alpaca-mirror-exits.jsonl<home"] }) && !p.retired, P(p));
  const b = C.planCarry(map("server", "home"));
  ok("R191 on the server, R231 home, board home: real gets R231's state + the board's two files from home (never R191's own state); shadow gets R191's state from the REAL tree, the rest from home",
    P(b) === JSON.stringify({ real: ["r231-crypto-vote-sized.json<home", "alpaca-mirror.jsonl<home", "alpaca-mirror-exits.jsonl<home"], shadow: ["r191-crypto-trend.json<real", "r231-crypto-vote-sized.json<home", "alpaca-mirror.jsonl<home", "alpaca-mirror-exits.jsonl<home"] }) && !b.real.some((x) => x.file === "r191-crypto-trend.json"), P(b));
  const g = C.planCarry(map("home", "server", { "w5-board": "server", "w5-chain": "server" }));
  ok("R191 home, R231 on the server, board on the server: real gets R191's state only; shadow gets R191's state from home, R231's and the board's from the real tree",
    P(g) === JSON.stringify({ real: ["r191-crypto-trend.json<home"], shadow: ["r191-crypto-trend.json<home", "r231-crypto-vote-sized.json<real", "alpaca-mirror.jsonl<real", "alpaca-mirror-exits.jsonl<real"] }), P(g));
  const c = C.planCarry(map("server", "server", { "w5-board": "home" }));
  ok("both on the server, board home: real gets the board's two files; shadow nothing (no home-owned unit runs there)", P(c) === JSON.stringify({ real: ["alpaca-mirror.jsonl<home", "alpaca-mirror-exits.jsonl<home"], shadow: [] }) && !c.retired, P(c));
  const d = C.planCarry(map("server", "server", { "w5-board": "server" }));
  ok("both on the server, board on the server: RETIRED (nothing to carry)", d.retired && !d.real.length && !d.shadow.length && !d.errors.length, P(d));
  const e = C.planCarry(map("server", "home", { "w5-board": "home", "w5-chain": "server" }));
  ok("the board half moved (w5-* units on both sides): REFUSED for the board's files", e.errors.some((x) => /half moved/.test(x)), JSON.stringify(e.errors));
  const f = C.planCarry({ schema: "host-ownership-v1", units: { "w3-r191": "home" } }), h = C.planCarry({ units: {} }), k = C.planCarry(map("home", "moving"));
  ok("a map without w3-r231, a map that is not host-ownership-v1, a side that is not home/server: each REFUSED, nothing planned", f.errors.length && h.errors.length && k.errors.length && [f, h, k].every((x) => !x.real.length && !x.shadow.length), JSON.stringify([f.errors, h.errors, k.errors]));
  const all = [["home", "home"], ["server", "home"], ["home", "server"], ["server", "server"]].flatMap(([a, b2]) => [{}, { "w5-board": "server" }].map((w) => C.planCarry(map(a, b2, w))));
  ok("over every side combination, no file whose owner is server-owned is ever planned into the REAL tree, and no switch or lock is ever planned",
    all.every((p) => p.real.every((x) => x.from === "home")) && all.every((p) => [...p.real, ...p.shadow].every((x) => C.FILES.some((F) => F.file === x.file) && !/OFF|HALT|lock/i.test(x.file))));
}

console.log("invalid — home's bytes validated before anything is sent");
{
  const S = C.FILES[0], J = C.FILES[2];
  ok("a state with a coins table is fine; without one, unparseable, or absent: refused", C.invalid(S, Buffer.from(STATE191)) === null && /coins/.test(C.invalid(S, Buffer.from("{}"))) && /parse/.test(C.invalid(S, Buffer.from("{"))) && /absent/.test(C.invalid(S, null)));
  ok("a jsonl: every line JSON and a final newline is fine (an empty file too); a cut last line or a bad line: refused", C.invalid(J, Buffer.from(MIR + MIREX)) === null && C.invalid(J, Buffer.from("")) === null && /newline/.test(C.invalid(J, Buffer.from(MIR.trim()))) && /line 2/.test(C.invalid(J, Buffer.from(MIR + "nope\n"))));
}

console.log("end to end — fake VPS");
{
  // R191 on the server, R231 home, board home (the first W3 cutover of the two)
  freshVps();
  const VPS191 = STATE191.replace("0.1", "0.2");   // the VPS's own R191 state (its writer is the VPS)
  fs.writeFileSync(path.join(realDir(), "r191-crypto-trend.json"), VPS191);
  const d = home(map("server", "home"));
  const r = go(d);
  const R = (f) => rd(path.join(realDir(), f)), S = (f) => rd(path.join(shadowDir(), f));
  ok("carry: exit 0", r.exit === 0, r.lines.join(" | "));
  ok("REAL tree: R231's state and the board's two files are home's bytes; R191's own state (the VPS's) is untouched", R("r231-crypto-vote-sized.json") === STATE231 && R("alpaca-mirror.jsonl") === MIR && R("alpaca-mirror-exits.jsonl") === MIREX && R("r191-crypto-trend.json") === VPS191);
  ok("SHADOW tree: R191's state is the REAL tree's copy (the writer's), R231's and the board's are home's", S("r191-crypto-trend.json") === VPS191 && S("r231-crypto-vote-sized.json") === STATE231 && S("alpaca-mirror.jsonl") === MIR && S("alpaca-mirror-exits.jsonl") === MIREX);
  ok("no switch (r191-OFF / r231-OFF) reached either tree, no temp file is left, and every carried file is 0644",
    !fs.existsSync(path.join(realDir(), "r191-OFF")) && !fs.existsSync(path.join(shadowDir(), "r231-OFF")) && !leftovers().length && ["alpaca-mirror.jsonl", "r231-crypto-vote-sized.json"].every((f) => (fs.statSync(path.join(realDir(), f)).mode & 0o777) === 0o644), leftovers().join(","));
  const c1 = calls();
  ok("every call went to host 'traids' through the fakes; every script stayed under SCRIPT_MAX; locks w3-r191.flock and w3-r231.flock were taken in each tree",
    c1.length > 0 && c1.every((x) => (x.tool === "ssh" ? x.host === "traids" && x.script.length < C.SCRIPT_MAX : /^traids:\/home\/traids\//.test(x.dest))) && c1.filter((x) => /# carry:move/.test(x.script || "")).every((x) => /flock -w \d+ 8/.test(x.script) && /flock -w \d+ 9/.test(x.script)), JSON.stringify(c1.map((x) => x.tool + ":" + (x.host || x.dest))));
  const st = JSON.parse(rd(path.join(d, "r191-r231-carry-status.json")) || "null");
  ok("the status file records exit 0 and what was carried", st && st.exit === 0 && st.carried.real.length === 3 && st.carried.shadow.length === 4, JSON.stringify(st && st.carried) + " " + r.lines.slice(-4).join(" | "));
  // second run: everything current -> only the read ssh
  fs.rmSync(LOG, { force: true });
  const r2 = go(d), c2 = calls();
  ok("a second run with nothing changed: exit 0, ONE read-only ssh, no scp, nothing moved", r2.exit === 0 && c2.length === 1 && /# carry:read/.test(c2[0].script) && r2.lines.filter((l) => /^ok .*already current$/.test(l)).length === 7, JSON.stringify([r2.exit, c2.length]) + " " + r2.lines.slice(7).join(" | "));
  // home's board file grows -> only it goes, to both trees
  fs.appendFileSync(path.join(d, "alpaca-mirror.jsonl"), MIR.replace("t1", "t2"));
  fs.rmSync(LOG, { force: true });
  const r3 = go(d);
  ok("home's board file grew: it alone is carried to both trees", r3.exit === 0 && R("alpaca-mirror.jsonl") === MIR + MIR.replace("t1", "t2") && S("alpaca-mirror.jsonl") === R("alpaca-mirror.jsonl") && calls().filter((x) => x.tool === "scp").length === 2, r3.lines.join(" | "));
  // the VPS's R191 state changes -> the shadow follows it, the real tree's own copy is never touched
  fs.writeFileSync(path.join(realDir(), "r191-crypto-trend.json"), VPS191.replace("0.2", "0.3"));
  const r4 = go(d);
  ok("the VPS's own R191 state changed: the shadow copy follows the real tree; home's R191 copy is never pushed over it", r4.exit === 0 && S("r191-crypto-trend.json") === VPS191.replace("0.2", "0.3") && R("r191-crypto-trend.json") === VPS191.replace("0.2", "0.3"));
}

console.log("refusals and failures");
{
  // a bad home file is not pushed over the server's copy
  freshVps();
  fs.writeFileSync(path.join(realDir(), "r231-crypto-vote-sized.json"), STATE231);
  const d = home(map("server", "home"), { "r231-crypto-vote-sized.json": '{"spec":"r231-state-v1"}' });
  const r = go(d);
  ok("home's R231 state has no coins table: NOT carried (the server keeps its copy), the rest still goes, exit 1 with the reason last", r.exit === 1 && rd(path.join(realDir(), "r231-crypto-vote-sized.json")) === STATE231 && rd(path.join(realDir(), "alpaca-mirror.jsonl")) === MIR && /FAILED/.test(r.lines[r.lines.length - 1]) && r.lines.some((l) => /REFUSED r231-crypto-vote-sized\.json: has no coins table/.test(l)), r.lines.join(" | "));
  // corrupted on the way
  freshVps();
  process.env.CARRY_FAKE_CORRUPT = "1";
  const d2 = home(map("server", "home")), r2 = go(d2);
  delete process.env.CARRY_FAKE_CORRUPT;
  ok("bytes altered on the way (the fake scp adds one): the sha256 check refuses, NOTHING moved in either tree, no temp left, exit 1",
    r2.exit === 1 && !fs.existsSync(path.join(realDir(), "alpaca-mirror.jsonl")) && !fs.existsSync(path.join(shadowDir(), "alpaca-mirror.jsonl")) && !leftovers().length, r2.lines.join(" | "));
  // ssh down
  freshVps(); process.env.CARRY_FAKE_DOWN = "1";
  const r3 = go(home(map("server", "home")));
  delete process.env.CARRY_FAKE_DOWN;
  ok("ssh down: exit 1, nothing carried, the reason last", r3.exit === 1 && /ssh \(read\)/.test(r3.lines[r3.lines.length - 1]) && fs.readdirSync(realDir()).length === 0, r3.lines.join(" | "));
  // a busy lock in the real tree
  freshVps();
  fs.writeFileSync(path.join(realDir(), "r191-crypto-trend.json"), STATE191);
  const lockF = path.join(shadowDir(), "w3-r231.flock");
  const holder = cp.spawn("flock", [lockF, "sleep", "8"], { stdio: "ignore" });
  const t0 = Date.now(); while (Date.now() - t0 < 3000) { const p = cp.spawnSync("flock", ["-n", lockF, "true"]); if (p.status !== 0) break; }
  const r4 = go(home(map("server", "home")), { lockWait: 1 });
  holder.kill();
  ok("R231's lock busy in the SHADOW tree: nothing moved there (no half set), the real tree still carried, no temp left, exit 3 WARN",
    r4.exit === 3 && !fs.existsSync(path.join(shadowDir(), "alpaca-mirror.jsonl")) && !fs.existsSync(path.join(shadowDir(), "r191-crypto-trend.json")) && rd(path.join(realDir(), "alpaca-mirror.jsonl")) === MIR && !leftovers().length, r4.lines.join(" | "));
  // a busy REAL-tree lock also holds the shadow back when the shadow copies from the real tree (it reads under the real tree's locks)
  freshVps(); fs.writeFileSync(path.join(realDir(), "r191-crypto-trend.json"), STATE191);
  const lockR = path.join(realDir(), "w3-r191.flock"), h2 = cp.spawn("flock", [lockR, "sleep", "8"], { stdio: "ignore" });
  const t1 = Date.now(); while (Date.now() - t1 < 3000) { const p = cp.spawnSync("flock", ["-n", lockR, "true"]); if (p.status !== 0) break; }
  const r4b = go(home(map("server", "home")), { lockWait: 1 });
  h2.kill();
  ok("R191's lock busy in the REAL tree: nothing moved in the real tree, nor in the shadow (it copies R191's state from the real tree under its locks), exit 3",
    r4b.exit === 3 && !fs.existsSync(path.join(realDir(), "alpaca-mirror.jsonl")) && !fs.existsSync(path.join(shadowDir(), "alpaca-mirror.jsonl")) && !leftovers().length, r4b.lines.join(" | "));
  // a torn real-tree jsonl (board on the server, mid-append) is not copied into the shadow
  freshVps();
  fs.writeFileSync(path.join(realDir(), "r231-crypto-vote-sized.json"), STATE231);
  fs.writeFileSync(path.join(realDir(), "alpaca-mirror.jsonl"), MIR + MIR.trim());
  fs.writeFileSync(path.join(realDir(), "alpaca-mirror-exits.jsonl"), MIREX);
  const r5 = go(home(map("home", "server", { "w5-board": "server" })));
  ok("board on the server, its real-tree jsonl caught mid-append: NOT copied into the shadow (WARN, exit 3); the other files are",
    r5.exit === 3 && !fs.existsSync(path.join(shadowDir(), "alpaca-mirror.jsonl")) && rd(path.join(shadowDir(), "alpaca-mirror-exits.jsonl")) === MIREX && rd(path.join(shadowDir(), "r231-crypto-vote-sized.json")) === STATE231 && rd(path.join(realDir(), "r191-crypto-trend.json")) === STATE191 && !leftovers().length, r5.lines.join(" | "));
  // map unreadable
  freshVps();
  const d6 = home(map("server", "home")); fs.writeFileSync(path.join(d6, "host-ownership.json"), "{ torn");
  const r6 = go(d6);
  ok("home's map unreadable: REFUSED, exit 1, no ssh at all", r6.exit === 1 && calls().length === 0, r6.lines.join(" | "));
  const r7 = go(home(map("server", "server", { "w5-board": "server" })));
  ok("everything on the server: RETIRED, exit 0, no ssh at all", r7.exit === 0 && /RETIRED/.test(r7.lines[r7.lines.length - 1]) && calls().length === 0);
  const r8 = go(home(map("server", "home")), { mode: "plan" });
  ok("--plan: the plan printed, exit 0, no ssh at all", r8.exit === 0 && calls().length === 0 && r8.lines.filter((l) => /^plan /.test(l)).length === 7, r8.lines.join(" | "));
  fs.writeFileSync(path.join(realDir(), "r191-crypto-trend.json"), STATE191);
  const r9 = go(home(map("server", "home")), { mode: "dry" }), c9 = calls();
  ok("--dry: ONE read-only ssh, nothing written in either tree, exit 0", r9.exit === 0 && c9.length === 1 && /# carry:read/.test(c9[0].script) && fs.readdirSync(realDir()).join() === "r191-crypto-trend.json" && fs.readdirSync(shadowDir()).length === 0 && r9.lines.filter((l) => /^DRY  /.test(l)).length === 7, r9.lines.join(" | "));
}

console.log("the package (deploy / rollback / record on a temp repo)");
{
  const repo = fs.mkdtempSync(path.join(TMP, "repo-")); fs.writeFileSync(path.join(repo, "AGENTS.md"), "x"); fs.mkdirSync(path.join(repo, "backend"));
  const node = (f, ...a) => cp.spawnSync(process.execPath, [path.join(H, f), ...a, "--repo", repo], { encoding: "utf8" });
  const live = path.join(repo, "deploy", "server", "r191-r231-carry.cjs"), staged = fs.readFileSync(JOB);
  const p = node("deploy.cjs", "--plan");
  ok("deploy --plan: the new file would be written, nothing changed", p.status === 0 && /would write 1 file/.test(p.stdout) && !fs.existsSync(live), p.stdout + p.stderr);
  const a = node("deploy.cjs", "--apply");
  ok("deploy --apply: the file is the staged bytes", a.status === 0 && fs.readFileSync(live).equals(staged), a.stdout + a.stderr);
  const a2 = node("deploy.cjs", "--apply");
  ok("deploy --apply again: already applied, nothing written", a2.status === 0 && /0 written, 1 already applied/.test(a2.stdout), a2.stdout);
  const rb = node("rollback.cjs");
  ok("rollback: the new file is removed (base = absent)", rb.status === 0 && !fs.existsSync(live), rb.stdout + rb.stderr);
  fs.mkdirSync(path.dirname(live), { recursive: true }); fs.writeFileSync(live, "// someone else's file\n");
  const dr = node("deploy.cjs", "--apply");
  ok("deploy --apply over a DIFFERENT file at that path: REFUSED (drift), the file untouched", dr.status === 1 && /REFUSED/.test(dr.stdout) && rd(live) === "// someone else's file\n", dr.stdout);
  const rr = node("rollback.cjs");
  ok("rollback over that file: REFUSED (it is not this package's), the file untouched", rr.status === 1 && rd(live) === "// someone else's file\n", rr.stdout);
  const rec = node("record.cjs", "--dry");
  ok("record --dry prints the record (the staged sha) and writes nothing", rec.status === 0 && rec.stdout.includes(sha(staged).slice(0, 16)) && /DRY: nothing written/.test(rec.stdout), rec.stdout);
  const own = cp.spawnSync(process.execPath, [path.join(H, "deploy.cjs"), "--plan"], { encoding: "utf8" }), ownR = cp.spawnSync(process.execPath, [path.join(H, "rollback.cjs"), "--dry"], { encoding: "utf8" });
  ok("deploy --plan and rollback --dry WITHOUT --repo (the operator's form, on this repository): exit 0, a state line, nothing written", own.status === 0 && ownR.status === 0 && /^(base|applied) +deploy\/server\/r191-r231-carry\.cjs/m.test(own.stdout) && /^(PLAN|DRY):/m.test(ownR.stdout), own.stdout + own.stderr + ownR.stderr);
  const chk = [JOB, ...fs.readdirSync(H).filter((f) => f.endsWith(".cjs")).map((f) => path.join(H, f))].map((f) => cp.spawnSync(process.execPath, ["--check", f]).status);
  ok("node --check of every package file", chk.every((s) => s === 0));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fail ? quiet(`SELFTEST: ${fail} of ${pass + fail} cases FAILED`) : `ALL ${pass} CASES PASSED (r191-r231-carry; fake ssh/scp, no host contacted)`);
process.exitCode = fail ? 1 : 0;
