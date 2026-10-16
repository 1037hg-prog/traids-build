#!/usr/bin/env node
/**
 * SELFTEST — r260-seed-push-fix, OFFLINE. 2026-10-16.
 *   node docs/r260-seed-push-fix/2026-10-16/selftest.cjs
 * A FAKE ssh: a function given to pull-server's own calls that CUTS every script at 8,190 characters (what the link from home did) and runs
 * what is left with bash ON THIS MACHINE, the VPS data folder rewritten into a temp folder, stdin passed through. No host is contacted (no ssh
 * binary is ever spawned: the fake is the only ssh the code under test is given). The last line says "ALL ... PASSED" only when every case passed.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto");
const H = __dirname;
const BASE = require(path.join(H, "base", "docs", "server", "wave1-crypto", "pull-server.cjs"));
const PS = require(path.join(H, "staged", "docs", "server", "wave1-crypto", "pull-server.cjs"));
const MOS = require(path.join(H, "make-own-stage.cjs"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail ? " — " + String(detail).slice(0, 500) : "")); } };
const quiet = (s) => String(s).replace(/ALL/g, "all");
/** one section: a throw inside it is a named FAIL, and the later sections still run (review cycle 1) */
const section = (title, fn) => { console.log(title); try { fn(); } catch (e) { ok(`${title}: the section ran to its end`, false, `threw: ${String(e.stack || e).split("\n").slice(0, 3).join(" ")}`); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "r260-selftest-")), ROOT = path.join(TMP, "vps");
const RD = "/home/traids/traids/backend/data", LOCAL = ROOT + RD;
const CUT = 8190;
/** the fake ssh: cut at CUT characters, then real bash in the temp folder */
function fakeSsh(opt = {}) {
  const S = { calls: [], longest: 0 };
  const fn = (script, { input = null, binary = false } = {}) => {
    script = String(script); S.calls.push(script); S.longest = Math.max(S.longest, script.length);
    if (opt.busyAt && /EOF_MV/.test(script) && S.calls.filter((c) => /EOF_MV/.test(c)).length === opt.busyAt) return { ok: false, status: 75, out: binary ? Buffer.alloc(0) : "", err: "" };
    const sent = script.length > CUT ? script.slice(0, CUT) : script;
    const r = cp.spawnSync("bash", ["-c", sent.split("/home/traids/").join(ROOT + "/home/traids/")], { input: input || undefined, encoding: binary ? undefined : "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (opt.afterPush && /EOF_MV/.test(script)) opt.afterPush(S.calls.filter((c) => /EOF_MV/.test(c)).length);
    return { ok: !r.error && r.status === 0, status: r.status, out: r.stdout == null ? "" : r.stdout, err: String(r.stderr || "") };
  };
  return { fn, S };
}
const fresh = () => { fs.rmSync(path.join(ROOT, "home"), { recursive: true, force: true }); fs.mkdirSync(LOCAL, { recursive: true }); };
// a w3-r260-like seed: many files with realistic names (a dated per-symbol cache and the unit's own records)
const SEED = [
  ...Array.from({ length: 140 }, (_, i) => ({ rel: `r260-cache/SYM${String(i).padStart(3, "0")}-daily-2026-10-15.json`, data: Buffer.from(JSON.stringify({ sym: i, bars: [1, 2, 3] })), mode: "0644" })),
  { rel: "r260-close-arm.json", data: Buffer.from('{"spec":"r260"}'), mode: "0644" }, { rel: "r260-close-arm.jsonl", data: Buffer.from('{"d":"2026-10-15"}\n'), mode: "0644" },
];
const landed = (files) => files.filter((f) => { try { return fs.readFileSync(path.join(LOCAL, f.rel)).equals(f.data); } catch { return false; } }).length;

section("the defect, reproduced on the BASE pull-server (unchanged copy)", () => {
  fresh();
  const one = BASE.remotePushCommand(RD, SEED, { lock: "w3-r260.flock" });
  const lineOf = one.split("\n").findIndex((l) => /<<'EOF_SHA'$/.test(l)) + 1;
  ok(`the seed in ONE push script is ${one.length} characters (over the ${CUT} at which a script arrived cut); its EOF_SHA here-document opens on line ${lineOf}`, one.length > CUT && lineOf === 9, one.length);
  const V = fakeSsh(); let e = null; try { BASE.pushRemote(V.fn, RD, SEED, { lock: "w3-r260.flock" }); } catch (x) { e = x.message; }
  ok("BASE pushRemote with the w3-r260-like seed: FAILS with bash's \"here-document at line 9 delimited by end-of-file (wanted `EOF_SHA')\" — the reported error — and NOTHING landed",
    /here-document at line 9 delimited by end-of-file \(wanted `EOF_SHA'\)/.test(e || "") && landed(SEED) === 0, e);
  fresh();
  const small = SEED.slice(0, 5), V2 = fakeSsh(), r = BASE.pushRemote(V2.fn, RD, small, { lock: "w3-r260.flock" });
  ok("the control: a small seed (5 files) goes in one script and lands — the code is right, its script length is the defect", r.pushed === 5 && landed(small) === 5, JSON.stringify(r));
});

section("the fix — pushChunked / remoteShasChunked (STAGED pull-server)", () => {
  fresh();
  const V = fakeSsh(), r = PS.pushChunked(V.fn, RD, SEED, { lock: "w3-r260.flock" });
  const pushes = V.S.calls.filter((c) => /EOF_MV/.test(c)), reads = V.S.calls.filter((c) => /sha256sum -- "\$f"/.test(c));
  ok(`the same seed goes in ${pushes.length} chunks, every script (pushes and sha reads) under ${PS.SCRIPT_MAX} characters (the longest ${V.S.longest}); all ${SEED.length} files land byte-equal`, r.pushed === SEED.length && r.chunks === pushes.length && pushes.length >= 3 && V.S.longest <= PS.SCRIPT_MAX && landed(SEED) === SEED.length, JSON.stringify(r) + " longest " + V.S.longest);
  ok("every chunk is pushed under the unit's lock (w3-r260.flock) and read back by sha256 BEFORE the next chunk goes", pushes.every((c) => /exec 9>>'w3-r260\.flock' && flock -w 60 9/.test(c)) && V.S.calls.every((c, i) => !/EOF_MV/.test(c) || i === 0 || /sha256sum -- "\$f"/.test(V.S.calls[i - 1]) || V.S.calls.slice(0, i).filter((x) => /EOF_MV/.test(x)).length === 0) && reads.length >= pushes.length);
  const modes = SEED.slice(0, 3).map((f) => (fs.statSync(path.join(LOCAL, f.rel)).mode & 0o777).toString(8));
  ok("modes are set as asked (0644), no staging folder is left in the data dir", modes.every((m) => m === "644") && !fs.readdirSync(LOCAL).some((f) => f.startsWith(".push-stage-")), modes.join());
  // a seed with read-only inputs mixed in keeps each file's own mode
  fresh();
  const mixed = SEED.slice(0, 60).map((f, i) => ({ ...f, mode: i % 2 ? "0444" : "0644" })), r2 = PS.pushChunked(fakeSsh().fn, RD, mixed, { lock: "w3-r260.flock" });
  ok("each file keeps its own mode across chunks (0444 and 0644 mixed)", r2.pushed === 60 && mixed.every((f) => (fs.statSync(path.join(LOCAL, f.rel)).mode & 0o777).toString(8) === f.mode.slice(1)));
  // the lock busy at the 2nd chunk
  fresh();
  const VB = fakeSsh({ busyAt: 2 }), rb = PS.pushChunked(VB.fn, RD, SEED, { lock: "w3-r260.flock" });
  const firstChunk = PS.chunkByScript(SEED, (run) => PS.remotePushCommand(RD, run, { lock: "w3-r260.flock", lockWait: 60 }))[0];
  ok("the unit's lock busy at chunk 2: { busy, partial } returned, the first chunk landed and was verified, NOTHING after chunk 2 was sent", rb.busy === true && rb.partial === true && rb.pushed === firstChunk.length && landed(SEED) === firstChunk.length && VB.S.calls.filter((c) => /EOF_MV/.test(c)).length === 2, JSON.stringify(rb));
  // a chunk that does not land as sent
  fresh();
  const VC = fakeSsh({ afterPush: (k) => { if (k === 2) { const f = path.join(LOCAL, PS.chunkByScript(SEED, (run) => PS.remotePushCommand(RD, run, { lock: "w3-r260.flock", lockWait: 60 }))[1].slice(-1)[0].rel); fs.appendFileSync(f, "// altered on the VPS\n"); } } });
  let ec = null; try { PS.pushChunked(VC.fn, RD, SEED, { lock: "w3-r260.flock" }); } catch (x) { ec = x.message; }
  ok("chunk 2 read back NOT as sent: THROWS naming the file and the chunk; chunk 3 is never sent", /is not what was sent \(chunk 2 of \d+/.test(ec || "") && VC.S.calls.filter((c) => /EOF_MV/.test(c)).length === 2, ec);
  // ssh down
  let ed = null; try { PS.pushChunked(() => ({ ok: false, status: 255, out: "", err: "ssh: connect to host traids port 22: Connection timed out" }), RD, SEED, {}); } catch (x) { ed = x.message; }
  ok("ssh down: THROWS (fail-closed), never a quiet zero", /push to .* failed \(exit 255\)/.test(ed || ""), ed);
  // lockWait passed through (own.cjs passes 120), and the limit itself
  fresh();
  const VW = fakeSsh(), rw = PS.pushChunked(VW.fn, RD, SEED, { lock: "w3-r260.flock", lockWait: 120 }), pw = VW.S.calls.filter((c) => /EOF_MV/.test(c));
  ok("lockWait 120 reaches every chunk's flock (-w 120); SCRIPT_MAX is 5,000 and every script sent is at most that", rw.pushed === SEED.length && pw.every((c) => /flock -w 120 9 \|\| exit 75/.test(c)) && PS.SCRIPT_MAX === 5000 && VW.S.longest <= 5000, VW.S.longest);
  // an ssh failure at chunk 2 says which chunk and how many landed
  fresh();
  let n2 = 0; const VF = fakeSsh(), failAt2 = (script, o) => (/EOF_MV/.test(script) && ++n2 === 2 ? { ok: false, status: 255, out: "", err: "Connection reset" } : VF.fn(script, o));
  let ef = null; try { PS.pushChunked(failAt2, RD, SEED, { lock: "w3-r260.flock" }); } catch (x) { ef = x.message; }
  ok("ssh fails at chunk 2: THROWS naming chunk 2 and the files that landed before it", /chunk 2 of \d+; \d+ file\(s\) landed and were verified before it/.test(ef || "") && !/; 0 file/.test(ef || ""), ef);
  ok("chunkByScript is linear and exact: 2,000 names chunked with build() called O(n) times, every run within the limit", (() => { let calls = 0; const names = Array.from({ length: 2000 }, (_, i) => "n" + i); const b = (r) => { calls++; return PS.remoteShasCommand(RD, r); }; const ch = PS.chunkByScript(names, b); return calls < 3 * names.length && ch.flat().join() === names.join() && ch.every((c) => PS.remoteShasCommand(RD, c).length <= PS.SCRIPT_MAX); })());
  // a read-back that fails over ssh says which chunk and how many landed (review cycle 2)
  fresh();
  let nr = 0; const VG = fakeSsh(), failRead2 = (script, o) => (/sha256sum -- "\$f"/.test(script) && ++nr === 2 ? { ok: false, status: 255, out: "", err: "Connection reset" } : VG.fn(script, o));
  let eg = null; try { PS.pushChunked(failRead2, RD, SEED, { lock: "w3-r260.flock" }); } catch (x) { eg = x.message; }
  ok("the read-back of chunk 2 fails over ssh: THROWS naming chunk 2 and the files verified before it", /reading back chunk 2 of \d+; \d+ file\(s\) landed/.test(eg || "") && !/; 0 file/.test(eg || ""), eg);
  ok("sha-read chunks are filled close to the limit (each but the last over 4,000 of 5,000 characters): no needless ssh calls", (() => { const names = Array.from({ length: 600 }, (_, i) => `r260-cache/SYM${String(i).padStart(3, "0")}-daily-2026-10-15.json`), ch = PS.chunkByScript(names, (r) => PS.remoteShasCommand(RD, r)); return ch.slice(0, -1).every((c) => PS.remoteShasCommand(RD, c).length > 4000 && PS.remoteShasCommand(RD, c).length <= 5000); })());
  // empty and small lists
  const VE = fakeSsh(), re = PS.pushChunked(VE.fn, RD, [], {});
  ok("an empty list: { pushed: 0 }, no ssh at all", re.pushed === 0 && VE.S.calls.length === 0);
  fresh();
  const VS = fakeSsh(), small = SEED.slice(0, 4), rs = PS.pushChunked(VS.fn, RD, small, { lock: "w3-r260.flock" });
  ok("a small list: ONE push script, byte-identical to what pushRemote sends, then one sha read", rs.pushed === 4 && rs.chunks === 1 && VS.S.calls[0] === PS.remotePushCommand(RD, small, { lock: "w3-r260.flock", lockWait: 60 }) && VS.S.calls.length === 2);
  // the chunked sha read
  fresh(); PS.pushChunked(fakeSsh().fn, RD, SEED, {});
  const names = [...SEED.map((f) => f.rel), ...Array.from({ length: 300 }, (_, i) => `r260-cache/absent-${i}.json`)], VR = fakeSsh(), m = PS.remoteShasChunked(VR.fn, RD, names);
  ok(`remoteShasChunked: ${names.length} names in ${VR.S.calls.length} scripts, each under ${PS.SCRIPT_MAX}: every present file's sha, every absent one null`, m.size === names.length && SEED.every((f) => m.get(f.rel) === sha(f.data)) && m.get("r260-cache/absent-7.json") === null && VR.S.calls.length >= 3 && VR.S.longest <= PS.SCRIPT_MAX, VR.S.calls.length);
  const unc = (() => { try { BASE.remoteShas(fakeSsh().fn, RD, names); return null; } catch (x) { return x.message; } })();
  ok("the control: the SAME names through ONE remoteShas script are cut on the way and fail (or answer short) — so the chunked read is needed", unc !== null, unc);
  ok("chunkByScript: empty -> no chunk; one item over the limit still goes alone (never dropped); order kept", PS.chunkByScript([], () => "", 10).length === 0 && PS.chunkByScript(["x"], () => "y".repeat(99999), 10).length === 1 && PS.chunkByScript([1, 2, 3, 4, 5], (r) => "z".repeat(r.length * 2000), 4000).map((c) => c.join("")).join("|") === "12|34|5");
});

section("nothing else changed in pull-server", () => {
  const strip = (t) => t.replace(/\/\/ ── CHUNKED push[\s\S]*?(?=\/\/ ── home lock)/, "").replace(/^const remoteShasCommand = .*\n/m, "").replace("const r = ssh(remoteShasCommand(remoteData, rels));", "const r = ssh(`cd ${q(remoteData)} || exit 7; for f in ${rels.map(q).join(\" \")}; do if [ -f \"$f\" ]; then sha256sum -- \"$f\"; else echo \"ABSENT  $f\"; fi; done`);").replace("module.exports = { SCRIPT_MAX, chunkByScript, remoteShasCommand, remoteShasChunked, pushChunked, loadManifest,", "module.exports = { loadManifest,");
  const b = fs.readFileSync(path.join(H, "base", "docs", "server", "wave1-crypto", "pull-server.cjs"), "utf8"), s = fs.readFileSync(path.join(H, "staged", "docs", "server", "wave1-crypto", "pull-server.cjs"), "utf8");
  ok("the staged pull-server, with the added block, the extracted sha command and the export line taken out, is the base byte for byte", strip(s) === b);
  ok("both staged twins are byte-equal, and both base twins are byte-equal", fs.readFileSync(path.join(H, "staged", "deploy", "server", "pull-server.cjs")).equals(Buffer.from(s)) && fs.readFileSync(path.join(H, "base", "deploy", "server", "pull-server.cjs")).equals(Buffer.from(b)));
  const fs2 = SEED.slice(0, 7), V1 = fakeSsh(), V2 = fakeSsh(); fresh(); BASE.pushRemote(V1.fn, RD, fs2, { lock: "l.flock" }); BASE.remoteShas(V1.fn, RD, ["a", "b"]); fresh(); PS.pushRemote(V2.fn, RD, fs2, { lock: "l.flock" }); PS.remoteShas(V2.fn, RD, ["a", "b"]);
  ok("pushRemote and remoteShas send byte-identical scripts before and after (their other callers and the W7 / W2b controls are unaffected)", V1.S.calls.length === 2 && V1.S.calls.every((c, i) => c === V2.S.calls[i]));
});

// the package's own files, COPIED to a temp folder for the cases below, without any own.cjs stage make-own-stage may have put here at home:
// so these cases read the same before and after the home step (review cycle 1)
const PKGC = path.join(TMP, "pkgcopy");
fs.cpSync(H, PKGC, { recursive: true });
for (const d of ["base", "staged"]) for (const t of MOS.TWINS) fs.rmSync(path.join(PKGC, d, t), { force: true });
const FIX = ["// FIXTURE — not own.cjs: three call shapes the tool must find", "const PS = require(\"./pull-server.cjs\");", "function seed(ssh, d, files, def) {",
  "  const r = PS.pushRemote(ssh, d, files, { lock: def.lock, lockWait: 120 }); if (r.busy) return { abort: \"seed: its lock on the VPS is held\" };",
  "  const after = PS.remoteShas(ssh, d, files.map((f) => f.rel));", "  return after;", "}", "function map(ssh, d) { return PS.pushRemote(ssh, d, [], {}); }", ""].join("\n");
const mkRepo = (name, { own = FIX, ownTwin = null } = {}) => {
  const repo = fs.mkdtempSync(path.join(TMP, name)); fs.writeFileSync(path.join(repo, "AGENTS.md"), "x"); fs.mkdirSync(path.join(repo, "backend"));
  const B = fs.readFileSync(path.join(H, "base", "docs", "server", "wave1-crypto", "pull-server.cjs"));
  for (const t of ["docs/server/wave1-crypto/pull-server.cjs", "deploy/server/pull-server.cjs"]) { fs.mkdirSync(path.dirname(path.join(repo, t)), { recursive: true }); fs.writeFileSync(path.join(repo, t), B); }
  if (own != null) MOS.TWINS.forEach((t, i) => { fs.mkdirSync(path.dirname(path.join(repo, t)), { recursive: true }); fs.writeFileSync(path.join(repo, t), i === 1 && ownTwin != null ? ownTwin : own); });
  return repo;
};
const node = (f, args, repo) => cp.spawnSync(process.execPath, [path.join(PKGC, f), ...args, "--repo", repo], { encoding: "utf8" });

section("make-own-stage (own.cjs is not in this copy: a FIXTURE stands in, plainly not own.cjs)", () => {
  const repo = mkRepo("mos-");
  const out = []; const plan = MOS.main(["--plan", "--repo", repo], (l) => out.push(l));
  ok("--plan lists every PS.pushRemote( / PS.remoteShas( line with its number (4, 5, 8) and writes nothing", plan === 0 && out.filter((l) => /^line \d+:/.test(l)).map((l) => /^line (\d+)/.exec(l)[1]).join() === "4,5,8" && !fs.existsSync(path.join(PKGC, "base", "deploy", "server", "own.cjs")), out.join("\n"));
  const sw = MOS.swapLines(FIX, [4, 5]), L = sw.text.split("\n");
  ok("swapLines on the seed's lines 4 and 5: exactly those become PS.pushChunked( / PS.remoteShasChunked(; line 8 (another push) is untouched", /PS\.pushChunked\(ssh, d, files, \{ lock: def\.lock, lockWait: 120 \}\)/.test(L[3]) && /PS\.remoteShasChunked\(ssh, d,/.test(L[4]) && /PS\.pushRemote\(ssh, d, \[\], \{\}\)/.test(L[7]) && sw.text.split("\n").filter((l, i) => l !== FIX.split("\n")[i]).length === 2);
  let e1 = null; try { MOS.swapLines(FIX, [6]); } catch (x) { e1 = x.message; }
  ok("a named line that calls neither: REFUSED", /calls neither/.test(e1 || ""), e1);
  const rd2 = mkRepo("mos2-", { ownTwin: FIX + "// differs\n" }), o2 = [];
  ok("the twins differ: REFUSED (W1's home patch judges them byte for byte)", MOS.main(["--plan", "--repo", rd2], (l) => o2.push(l)) === 1 && /differ/.test(o2.join(" ")));
  ok("--write without --lines: usage (exit 2), nothing written", MOS.main(["--write", "--repo", repo], () => {}) === 2);
  // --write, run from the package COPY: base = home's bytes, staged = the named lines changed, BOTH twins; files.cjs then carries all four files
  const w = node("make-own-stage.cjs", ["--write", "--lines", "4,5"], repo);
  const b0 = fs.readFileSync(path.join(PKGC, "base", MOS.TWINS[0]), "utf8"), b1 = fs.readFileSync(path.join(PKGC, "base", MOS.TWINS[1]), "utf8"), s0 = fs.readFileSync(path.join(PKGC, "staged", MOS.TWINS[0]), "utf8"), s1 = fs.readFileSync(path.join(PKGC, "staged", MOS.TWINS[1]), "utf8");
  ok("--write --lines 4,5: base/ holds home's own.cjs for BOTH twins, staged/ the two lines changed for BOTH twins, nothing else differs", w.status === 0 && b0 === FIX && b1 === FIX && s0 === MOS.swapLines(FIX, [4, 5]).text && s1 === s0 && s0 !== FIX, w.stdout + w.stderr);
  const F = cp.spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(require(process.argv[1]).FILES.map((f) => f.rel)))", path.join(PKGC, "files.cjs")], { encoding: "utf8" });
  ok("files.cjs now lists the own.cjs twins beside the pull-server twins (4 files)", F.stdout.trim() === JSON.stringify(["docs/server/wave1-crypto/pull-server.cjs", "deploy/server/pull-server.cjs", "deploy/server/own.cjs", "docs/server/wave1-crypto/own.cjs"]), F.stdout + F.stderr);
  const pa = node("deploy.cjs", ["--plan"], repo), ap = node("deploy.cjs", ["--apply"], repo);
  ok("deploy --plan then --apply over the four files: own.cjs twins become the staged text, pull-server twins the staged pull-server", pa.status === 0 && /would write 4 file/.test(pa.stdout) && ap.status === 0 && MOS.TWINS.every((t) => fs.readFileSync(path.join(repo, t), "utf8") === s0) && fs.readFileSync(path.join(repo, "deploy/server/pull-server.cjs")).equals(fs.readFileSync(path.join(H, "staged", "deploy", "server", "pull-server.cjs"))), pa.stdout + ap.stdout + ap.stderr);
  const rb = node("rollback.cjs", [], repo);
  ok("rollback over the four files: own.cjs twins are home's bytes again", rb.status === 0 && MOS.TWINS.every((t) => fs.readFileSync(path.join(repo, t), "utf8") === FIX), rb.stdout);
  // home's own.cjs changed after the stage was made: --write again is refused
  const rch = mkRepo("mos3-", { own: FIX + "// changed at home since\n" }), w2 = node("make-own-stage.cjs", ["--write", "--lines", "4"], rch);
  ok("home's own.cjs changed since the stage was made: --write REFUSED, the stage left as it was", w2.status === 1 && /holds a different own\.cjs/.test(w2.stdout) && fs.readFileSync(path.join(PKGC, "base", MOS.TWINS[0]), "utf8") === FIX, w2.stdout);
  // a staged pull-server without pushChunked: --write refused
  const sp = path.join(PKGC, "staged", "docs", "server", "wave1-crypto", "pull-server.cjs"), keep = fs.readFileSync(sp);
  for (const d of ["base", "staged"]) for (const t of MOS.TWINS) fs.rmSync(path.join(PKGC, d, t), { force: true });
  fs.writeFileSync(sp, keep.toString("utf8").replace("function pushChunked(", "function pushChunkedGone("));
  const w3 = node("make-own-stage.cjs", ["--write", "--lines", "4"], repo); fs.writeFileSync(sp, keep);
  ok("the staged pull-server has no pushChunked: --write REFUSED, nothing written", w3.status === 1 && /no pushChunked/.test(w3.stdout) && !fs.existsSync(path.join(PKGC, "base", MOS.TWINS[0])), w3.stdout);
});

section("the package (deploy / rollback / record on a temp repo holding the base twins)", () => {
  for (const d of ["base", "staged"]) for (const t of MOS.TWINS) fs.rmSync(path.join(PKGC, d, t), { force: true });
  const repo = mkRepo("pkg-", { own: null });
  const B = fs.readFileSync(path.join(H, "base", "docs", "server", "wave1-crypto", "pull-server.cjs")), S = fs.readFileSync(path.join(H, "staged", "docs", "server", "wave1-crypto", "pull-server.cjs"));
  const twins = ["docs/server/wave1-crypto/pull-server.cjs", "deploy/server/pull-server.cjs"];
  const p = node("deploy.cjs", ["--plan"], repo);
  ok("deploy --plan: both twins at base, would write 2, nothing changed", p.status === 0 && /would write 2 file/.test(p.stdout) && twins.every((t) => fs.readFileSync(path.join(repo, t)).equals(B)), p.stdout);
  const a = node("deploy.cjs", ["--apply"], repo);
  ok("deploy --apply: both twins are the staged bytes", a.status === 0 && twins.every((t) => fs.readFileSync(path.join(repo, t)).equals(S)), a.stdout + a.stderr);
  fs.appendFileSync(path.join(repo, twins[0]), "// edited after the deploy\n");
  const rr = node("rollback.cjs", [], repo);
  ok("a twin edited after the deploy: rollback REFUSED, nothing rolled back", rr.status === 1 && /REFUSED/.test(rr.stdout) && fs.readFileSync(path.join(repo, twins[1])).equals(S), rr.stdout);
  fs.writeFileSync(path.join(repo, twins[0]), S);
  const rb = node("rollback.cjs", [], repo);
  ok("rollback: both twins are base again, byte for byte", rb.status === 0 && twins.every((t) => fs.readFileSync(path.join(repo, t)).equals(B)), rb.stdout);
  fs.appendFileSync(path.join(repo, twins[1]), "// edited at home since\n");
  const d = node("deploy.cjs", ["--apply"], repo);
  ok("home's installed copy differs from base (drift): --apply REFUSED, neither twin touched", d.status === 1 && /REFUSED/.test(d.stdout) && fs.readFileSync(path.join(repo, twins[0])).equals(B), d.stdout);
  const rec = node("record.cjs", ["--dry"], repo);
  ok("record --dry prints the record and writes nothing", rec.status === 0 && rec.stdout.includes(sha(S).slice(0, 16)) && /DRY: nothing written/.test(rec.stdout), rec.stdout.slice(0, 300));
  const files = [...fs.readdirSync(H).filter((f) => f.endsWith(".cjs")).map((f) => path.join(H, f)), path.join(H, "staged", "docs", "server", "wave1-crypto", "pull-server.cjs"), path.join(H, "staged", "deploy", "server", "pull-server.cjs")];
  ok("node --check of every package file", files.every((f) => cp.spawnSync(process.execPath, ["--check", f]).status === 0));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fail ? quiet(`SELFTEST: ${fail} of ${pass + fail} cases FAILED`) : `ALL ${pass} CASES PASSED (r260-seed-push-fix; fake ssh cutting at ${CUT}, no host contacted)`);
process.exitCode = fail ? 1 : 0;
