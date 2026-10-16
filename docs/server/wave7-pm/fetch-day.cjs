#!/usr/bin/env node
/**
 * FETCH DAY — bring ONE recorded UTC day's archives home from the VPS, on demand. 2026-10-11 (docs/server/wave7-pm).
 * The standing pull carries only the small per-day summary (manifests.cjs says why); the archives stay on the server until someone
 * needs them — the scorer's build, a second copy before a server change, an audit of one day. Read-only on the VPS: one `cat` per file.
 *
 *   node docs/server/wave7-pm/fetch-day.cjs <UTC date> --to <folder> [--dry]
 *   node docs/server/wave7-pm/fetch-day.cjs --selftest          a fake VPS and temp folders; no ssh
 *
 * WHAT IT TRUSTS: home's pulled summary backend/data/pm-book/summary/<date>.json (it came through the checked pull). It lists every
 * archive of the day with the sha256 of the .gz and of the plain file it was made from (the server verified each when it made it).
 * A file is ACCEPTED only when (1) the bytes received hash to the summary's gzSha256, and (2) they unpack to exactly plainBytes bytes
 * whose sha256 is the summary's plainSha256. Then it is written to a temp name, flushed and renamed into
 *     <folder>/<venue>/<date>/<stream>.<part>.jsonl.gz      (the recorder's own layout: its readers and --coverage read it as it is)
 * A file already there with the right sha256 is not fetched again, so a run that stopped half way is simply run again.
 * REFUSED: no summary at home for the day (pull first: node deploy/server/pull-server.cjs --wave w7-pm); a day that is not closed or
 * still holds plain files on the server (the nightly run archives it at 00:40 UTC); an archive name that is not a plain part name; a
 * destination INSIDE the git repo that git does not ignore — the nightly git snapshot would commit about 1.1 GiB a day (NOTES.md,
 * "Fetching a day": either fetch outside the repo, or add the four .gitignore lines first).
 * It never deletes anything, on either machine, and never touches the registry.
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), zlib = require("zlib"), crypto = require("crypto"), cp = require("child_process");
const HERE = __dirname;
const L = require(path.join(HERE, "w7-lib.cjs"));
const { PS, PM, REMOTE } = L;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const ARCHIVE = /^(pm5|k15|spot|meta)\/([a-z]+\.\d{4}\.jsonl\.gz)$/;
const mib = (b) => (b / 1048576).toFixed(1) + " MiB";

function parseArgs(argv) {
  const out = { mode: "fetch", date: null, to: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--selftest") out.mode = "selftest";
    else if (x === "--dry") out.dry = true;
    else if (x === "--to") { out.to = argv[++i]; if (out.to == null || /^--/.test(out.to)) throw new Error("--to needs a folder"); }
    else if (!/^--/.test(x) && out.date == null) out.date = x;
    else throw new Error(`unknown argument ${JSON.stringify(x)} — nothing was done. fetch-day.cjs takes: <UTC date> --to <folder> [--dry] · --selftest`);
  }
  if (out.mode === "selftest") { if (argv.length !== 1) throw new Error("--selftest goes alone"); return out; }
  if (!isDate(out.date)) throw new Error(`give a UTC date YYYY-MM-DD (got ${JSON.stringify(out.date)}) — nothing was done`);
  if (!out.to) throw new Error("give --to <folder> (where the day's archives go) — nothing was done");
  return out;
}
/** is `dest` inside the repo, and if so does git ignore it? -> null when it may be written, else the refusal */
function destRefusal(dest, { repo = L.REPO, ignored = gitIgnores } = {}) {
  const rel = path.relative(path.resolve(repo), path.resolve(dest));
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    const ig = ignored(repo, path.resolve(dest));
    if (ig !== true) return `${dest} is inside the git repo and git ${ig === false ? "does NOT ignore it" : "could not be asked whether it ignores it"}: the nightly git snapshot would commit the archives (about 1.1 GiB a recorded day). Fetch to a folder outside the repo, or add the .gitignore lines of NOTES.md ("Fetching a day") first — REFUSED, nothing fetched`;
  }
  return null;
}
/** true = git ignores the path, false = it does not, null = git could not be asked */
function gitIgnores(repo, abs) {
  const r = cp.spawnSync("git", ["-C", repo, "check-ignore", "-q", path.join(abs, "pm5", "probe.jsonl.gz")], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  if (r.error || r.status == null) return null;
  return r.status === 0 ? true : r.status === 1 ? false : null;
}
/** the day's archive list from home's pulled summary, or a refusal -> [{ key, venue, name, remote, gzSha256, gzBytes, plainSha256, plainBytes }] */
function planOf(homePm, date) {
  const f = path.join(homePm, "summary", date + ".json"); let s;
  try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { throw new Error(`home holds no readable summary for ${date} (${e.code || "it does not parse"}) — the pull brings it after the server's nightly run: node deploy/server/pull-server.cjs --wave ${L.WAVE} — REFUSED, nothing fetched`); }
  if (!s || s.schema !== "pm-book-summary-v1" || s.date !== date) throw new Error(`${f} is not the recorder's summary of ${date} — REFUSED, nothing fetched`);
  if (s.closed !== true || s.plainFilesLeft !== 0) throw new Error(`${date} is not fully archived on the server yet (${s.closed !== true ? "the UTC day was still running when its summary was written" : s.plainFilesLeft + " plain file(s) left"}) — the nightly run at 00:40 UTC archives it; pull again after it — REFUSED, nothing fetched`);
  const keys = Object.keys(s.archives || {}).sort(); if (!keys.length) throw new Error(`the summary of ${date} lists no archive (nothing was recorded that day) — nothing to fetch`);
  return keys.map((key) => {
    const m = ARCHIVE.exec(key), a = s.archives[key];
    if (!m) throw new Error(`the summary of ${date} names ${JSON.stringify(key)}, which is not a part name of the recorder — REFUSED, nothing fetched`);
    if (!a || !/^[0-9a-f]{64}$/.test(String(a.gzSha256)) || !/^[0-9a-f]{64}$/.test(String(a.plainSha256)) || !Number.isInteger(a.plainBytes) || !Number.isInteger(a.gzBytes)) throw new Error(`the summary of ${date} holds no usable hashes for ${key} — REFUSED, nothing fetched`);
    return { key, venue: m[1], name: m[2], remote: `${PM}/${m[1]}/${date}/${m[2]}`, gzSha256: a.gzSha256, gzBytes: a.gzBytes, plainSha256: a.plainSha256, plainBytes: a.plainBytes };
  });
}
function fetchDay({ date, to, dry = false, ssh = null, homePm = path.join(PS.HOME_DATA, "pm-book"), repo = L.REPO, ignored = gitIgnores, log = (s) => console.log(s) }) {
  if (!isDate(date)) throw new Error(`not a UTC date: ${JSON.stringify(date)}`);
  const no = destRefusal(to, { repo, ignored }); if (no) throw new Error(no);
  const plan = planOf(homePm, date), have = [], todo = [];
  for (const a of plan) { const f = path.join(to, a.venue, date, a.name); let ok = false; try { ok = sha(fs.readFileSync(f)) === a.gzSha256; } catch { ok = false; } (ok ? have : todo).push({ ...a, file: f }); }
  log(`${date}: ${plan.length} archive(s) in the summary, ${mib(plan.reduce((x, a) => x + a.gzBytes, 0))} (${mib(plan.reduce((x, a) => x + a.plainBytes, 0))} plain); ${have.length} already at ${to} with the right sha256, ${todo.length} to fetch (${mib(todo.reduce((x, a) => x + a.gzBytes, 0))})`);
  if (dry) { for (const a of todo) log(`  would fetch ${a.key} (${mib(a.gzBytes)})`); log("DRY — nothing fetched, no ssh call made"); return { fetched: 0, have: have.length, todo: todo.length, bytes: 0 }; }
  const S = ssh || PS.sshReal(L.HOST); let n = 0, bytes = 0;
  for (const a of todo) {
    const r = S(REMOTE.cat(a.remote), { binary: true, timeout: 1800000 });
    if (!r.ok) throw new Error(`${a.key}: reading it on the VPS failed (ssh exit ${r.status}): ${String(r.err || "").trim().slice(0, 200)} — ${n} file(s) were fetched and verified before it and are kept; run the same command again`);
    const buf = Buffer.isBuffer(r.out) ? r.out : Buffer.from(r.out);
    if (sha(buf) !== a.gzSha256) throw new Error(`${a.key}: the ${buf.length} bytes received do NOT hash to the summary's sha256 (${a.gzSha256.slice(0, 12)}…; got ${sha(buf).slice(0, 12)}…) — NOT written. ${n} file(s) before it are kept. The archive on the VPS is not the one its summary describes: investigate there (ARCHIVES.json beside it)`);
    let plain; try { plain = zlib.gunzipSync(buf); } catch (e) { throw new Error(`${a.key}: the archive does not unpack (${e.message}) — NOT written`); }
    if (plain.length !== a.plainBytes || sha(plain) !== a.plainSha256) throw new Error(`${a.key}: the archive does NOT unpack to the plain file its summary describes (${plain.length} bytes against ${a.plainBytes}; sha256 ${sha(plain).slice(0, 12)}… against ${a.plainSha256.slice(0, 12)}…) — NOT written`);
    plain = null;
    fs.mkdirSync(path.dirname(a.file), { recursive: true });
    const tmp = a.file + ".tmp-" + process.pid, fd = fs.openSync(tmp, "w");
    try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, a.file);
    if (sha(fs.readFileSync(a.file)) !== a.gzSha256) throw new Error(`${a.key}: written, but the file on disk does not read back with the summary's sha256`);
    n++; bytes += buf.length; log(`  fetched ${a.key} (${mib(buf.length)}; sha256 of the archive and of what it unpacks to both match the summary)`);
  }
  log(`${date}: ${n} fetched and verified (${mib(bytes)}), ${have.length} were already there — the whole day is at ${path.join(to, "<venue>", date)}`);
  return { fetched: n, have: have.length, todo: todo.length, bytes };
}

// ── selftest: the recorder's own files (written, archived and summarised by the recorder's code), a fake VPS, temp folders ───
async function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, det) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (det !== undefined ? " — " + String(typeof det === "string" ? det : JSON.stringify(det)).slice(0, 700) : "")); } };
  const err = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const P = (s) => { try { return parseArgs(s.split(" ").filter(Boolean)); } catch (e) { return { err: e.message }; } };
  const REC = require(path.join(L.REPO, "backend", "pm-book-recorder.js")), F = require(path.join(L.REPO, "backend", "lib", "pm-feeds.js"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w7-fetch-")), day = "2026-10-14", d0 = Date.parse(day + "T00:00:00Z"), late = d0 + 2 * 86400000;
  const V = L.fakeVps();
  try {
    ok("args: a UTC date and --to are required; a bad date, a missing folder, an unknown flag are refused before anything runs", /give a UTC date/.test(P("--to x").err || "") && /give a UTC date/.test(P("2026-13-40 --to x").err || "") && /give --to/.test(P("2026-10-14").err || "") && /--to needs a folder/.test(P("2026-10-14 --to").err || "") && /unknown argument/.test(P("2026-10-14 --to x --force").err || "") && P("2026-10-14 --to x --dry").dry === true && P("--selftest").mode === "selftest");
    // a recorded day made by the recorder's own code: rows -> archives (verified) -> summary
    const srv = path.join(tmp, "server"), clock = { now: () => d0 + 3600000, mono: () => 0, setTimeout: () => null, clearTimeout: () => {} };
    const S = new REC.Store({ root: srv, clock, cfg: REC.mergeConfig({ partMaxBytes: 1048576 }), statfs: () => ({ bavail: 1e9, bsize: 4096 }), sid: "fetch-selftest" });
    for (let i = 0; i < 12000; i++) { const rx = d0 + 3600000 + i * 100; S.put("spot", "ws", "m", null, { id: i, p: "83000." + (i % 97), z: "0.01", sd: i % 2 ? "buy" : "sell", t: new Date(rx).toISOString(), sq: i }, rx); if (i % 10 === 0) S.put("k15", "book", "ob", "KXBTC15M-26OCT140115-15", { d: 40, y: [["0.4000", "5.00"]], no: [["0.5900", "7.00"]], ny: 1, nn: 1, u: "d" }, rx); }
    S.put("pm5", "ref", "win", d0 / 1000, { slug: "btc-updown-5m-" + d0 / 1000, cid: "0xc" }, d0 + 3600000); S.closeAll("stop");
    for (const v of Object.keys(F.STREAMS)) for (const st of F.STREAMS[v]) for (const p of F.partsOf(srv, v, day, st)) fs.utimesSync(p.file, new Date(d0), new Date(d0));
    const cz = await REC.compressDay(srv, day, { nowMs: late }), sum = await REC.summarizeDay(srv, day, { nowMs: late });
    const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f, out); else out.push(f); } return out; };
    for (const f of walk(srv)) V.put(PM + "/" + path.relative(srv, f).split(path.sep).join("/"), fs.readFileSync(f));
    const home = path.join(tmp, "home-pm"); fs.mkdirSync(path.join(home, "summary"), { recursive: true }); fs.copyFileSync(path.join(srv, "summary", day + ".json"), path.join(home, "summary", day + ".json"));
    const keys = Object.keys(sum.archives).sort(), lines = [], opt = (o = {}) => ({ date: day, to: path.join(tmp, "out"), ssh: V.ssh, homePm: home, repo: path.join(tmp, "a-repo"), ignored: () => false, log: (s) => lines.push(s), ...o });
    ok(`the day under test was written, archived and summarised by the recorder's own code: ${keys.length} archives (every one verified when made), a closed day with no plain file left`, cz.ok && keys.length >= 4 && sum.closed === true && sum.plainFilesLeft === 0 && keys.includes("spot/ws.0002.jsonl.gz") && keys.every((k) => ARCHIVE.test(k)), { keys, cz: cz.errors });

    const c0 = V.S.calls.length, dry = fetchDay(opt({ dry: true }));
    ok("--dry lists what would be fetched and makes NO ssh call and writes nothing", dry.fetched === 0 && dry.todo === keys.length && V.S.calls.length === c0 && !fs.existsSync(path.join(tmp, "out")) && /DRY — nothing fetched, no ssh call made/.test(lines.join("\n")));
    const r1 = fetchDay(opt()), outFiles = walk(path.join(tmp, "out")).map((f) => path.relative(path.join(tmp, "out"), f).split(path.sep).join("/")).sort();
    ok(`the fetch: all ${keys.length} archives land in the recorder's own layout <venue>/<date>/<part>.jsonl.gz, byte-identical to the server's, one ssh call each (a read-only cat), nothing else written`, r1.fetched === keys.length && r1.have === 0 && V.S.calls.slice(c0).length === keys.length && V.S.calls.slice(c0).every((s) => /^# w7:cat\ncat -- '\/home\/traids\/traids\/backend\/data\/pm-book\/(pm5|k15|spot|meta)\/2026-10-14\/[a-z]+\.\d{4}\.jsonl\.gz'$/.test(s)) && JSON.stringify(outFiles) === JSON.stringify(keys.map((k) => k.replace("/", `/${day}/`)).sort()) && outFiles.every((f) => fs.readFileSync(path.join(tmp, "out", f)).equals(V.get(PM + "/" + f))), outFiles);
    const scan = await REC.scanDay(path.join(tmp, "out"), day), cover = await F.coverDay({ root: path.join(tmp, "out"), venue: "k15", date: day, nowMs: late });
    ok("the fetched copy reads exactly as the server's did, with the recorder's own readers: the same rows per stream as the summary counted, and the same coverage count", Object.keys(sum.streams).every((k) => scan[k] && scan[k].rows === sum.streams[k].rows) && scan["spot/ws"].rows === 12000 + 4 && scan["k15/book"].rows === 1200 + 2 && cover.captured === sum.coverage.k15.captured && cover.windows === 96, { scan: Object.fromEntries(Object.entries(scan).map(([k, x]) => [k, x.rows])) });
    const c1 = V.S.calls.length, r2 = fetchDay(opt());
    ok("run again: every file is already there with the right sha256 — nothing is fetched, no ssh call is made", r2.fetched === 0 && r2.have === keys.length && V.S.calls.length === c1);
    // a file at home that is not the right bytes is fetched again and replaced
    const victim = path.join(tmp, "out", "spot", day, "ws.0001.jsonl.gz"); fs.writeFileSync(victim, "half a file"); const r3 = fetchDay(opt());
    ok("a file at the destination with the WRONG bytes (a fetch that died half way) is fetched again and replaced; the others are left alone", r3.fetched === 1 && r3.have === keys.length - 1 && fs.readFileSync(victim).equals(V.get(`${PM}/spot/${day}/ws.0001.jsonl.gz`)));
    // an archive on the server that is not the one its summary describes
    const key = "spot/ws.0002.jsonl.gz", remote = `${PM}/spot/${day}/ws.0002.jsonl.gz`, good = V.get(remote), flipped = Buffer.from(good); flipped[flipped.length - 9] ^= 1;
    V.put(remote, flipped); const e1 = err(() => fetchDay(opt({ to: path.join(tmp, "out2") })));
    ok("an archive whose bytes do not hash to the summary's sha256 (one flipped bit on the server) is REFUSED and NOT written; the files fetched before it are kept, and no temp file is left", /spot\/ws\.0002\.jsonl\.gz: the \d+ bytes received do NOT hash to the summary's sha256 .* — NOT written/.test(e1 || "") && !fs.existsSync(path.join(tmp, "out2", "spot", day, "ws.0002.jsonl.gz")) && walk(path.join(tmp, "out2")).length >= 1 && walk(path.join(tmp, "out2")).every((f) => !/\.tmp-/.test(f)), e1);
    V.put(remote, good); const r4 = fetchDay(opt({ to: path.join(tmp, "out2") }));
    ok("once the server's file is right again, the same command finishes the day: only what was missing is fetched", r4.fetched + r4.have === keys.length && r4.have >= 1 && r4.fetched >= 1 && fs.readFileSync(path.join(tmp, "out2", "spot", day, "ws.0002.jsonl.gz")).equals(good));
    // a summary whose plain hash does not match what the archive unpacks to
    const home2 = path.join(tmp, "home2"); fs.mkdirSync(path.join(home2, "summary"), { recursive: true });
    const tamper = (mut) => { const s = JSON.parse(JSON.stringify(sum)); mut(s); require(path.join(L.REPO, "backend", "lib", "atomic-write.js")).writeJsonAtomic(path.join(home2, "summary", day + ".json"), s); };
    tamper((s) => { s.archives[key].plainSha256 = "0".repeat(64); }); const e2 = err(() => fetchDay(opt({ homePm: home2, to: path.join(tmp, "out3") })));
    ok("an archive that hashes right but does NOT unpack to the plain file the summary describes is REFUSED and not written (both hashes are checked, not one)", /does NOT unpack to the plain file its summary describes/.test(e2 || "") && !fs.existsSync(path.join(tmp, "out3", "spot", day, "ws.0002.jsonl.gz")), e2);
    const c2 = V.S.calls.length, Rf = (name, mut, re, o = {}) => { tamper(mut); const e = err(() => fetchDay(opt({ homePm: home2, to: path.join(tmp, "out4"), ...o }))); ok(name, re.test(e || "") && V.S.calls.length === c2 && !fs.existsSync(path.join(tmp, "out4")), e); };
    Rf("REFUSED before any ssh: a day whose summary says plain files are still left on the server (the nightly run has not archived it)", (s) => { s.plainFilesLeft = 2; }, /is not fully archived on the server yet \(2 plain file\(s\) left\)/);
    Rf("REFUSED before any ssh: a day that was still running when its summary was written", (s) => { s.closed = false; }, /is not fully archived on the server yet \(the UTC day was still running/);
    Rf("REFUSED before any ssh: an archive name that is not a part name of the recorder (a path that climbs out of the folder is never written)", (s) => { s.archives["../../etc/passwd.gz"] = s.archives[key]; }, /is not a part name of the recorder — REFUSED/);
    Rf("REFUSED before any ssh: a summary of another day, or not the recorder's summary", (s) => { s.date = "2026-10-15"; }, /is not the recorder's summary of 2026-10-14/);
    const e3 = err(() => fetchDay(opt({ homePm: path.join(tmp, "nowhere"), to: path.join(tmp, "out4") })));
    ok("REFUSED before any ssh: no summary at home for the day — it names the pull command that brings it", /home holds no readable summary for 2026-10-14 .* node deploy\/server\/pull-server\.cjs --wave w7-pm — REFUSED/.test(e3 || "") && V.S.calls.length === c2, e3);
    // the destination and git
    const repo = path.join(tmp, "a-repo"), inside = path.join(repo, "backend", "data", "pm-book");
    const e4 = err(() => fetchDay(opt({ to: inside, ignored: () => false }))), e5 = err(() => fetchDay(opt({ to: inside, ignored: () => null })));
    ok("a destination INSIDE the git repo that git does not ignore is REFUSED before any ssh (the nightly snapshot would commit the archives); the same when git cannot be asked", /is inside the git repo and git does NOT ignore it/.test(e4 || "") && /could not be asked whether it ignores it/.test(e5 || "") && V.S.calls.length === c2 && !fs.existsSync(inside), [e4, e5]);
    const r5 = fetchDay(opt({ to: inside, ignored: () => true })), r6 = fetchDay(opt({ to: path.join(tmp, "elsewhere"), ignored: () => { throw new Error("git must not be asked about a folder outside the repo"); } }));
    ok("inside the repo AND git-ignored -> fetched; a folder outside the repo -> fetched without asking git at all", r5.fetched === keys.length && r6.fetched === keys.length && destRefusal(path.join(tmp, "a-repo-sibling"), { repo, ignored: () => false }) === null && /inside the git repo/.test(destRefusal(repo, { repo, ignored: () => false }) || ""));
    // the VPS goes away half way
    let n = 0; const flaky = (s, o) => { n++; return n === 3 ? { ok: false, status: 255, out: Buffer.alloc(0), err: "ssh: connection reset" } : V.ssh(s, o); }, e6 = err(() => fetchDay(opt({ to: path.join(tmp, "out5"), ssh: flaky }))), kept = walk(path.join(tmp, "out5")).length, r7 = fetchDay(opt({ to: path.join(tmp, "out5") }));
    ok("the VPS going away on the 3rd file: the command fails saying 2 files are kept; the same command then fetches only the rest", /reading it on the VPS failed \(ssh exit 255\).* — 2 file\(s\) were fetched and verified before it and are kept/.test(e6 || "") && kept === 2 && r7.have === 2 && r7.fetched === keys.length - 2, e6);
    const src = fs.readFileSync(__filename, "utf8").split("\n// ── selftest:")[0];
    ok("the script's code deletes nothing on either machine, sends nothing to the VPS but a read-only cat, and never names the registry", !/unlinkSync|rmSync|rmdirSync|\brm -/.test(src) && (src.match(/REMOTE\.[a-zA-Z]+\(/g) || []).every((x) => x === "REMOTE.cat(") && !/test-registry|read-seals|change-registry|agent-ledger/.test(src));
  } finally { V.cleanup(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a scanner may hold a file */ } }
  console.log(`fetch-day selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  let A; try { A = parseArgs(process.argv.slice(2)); } catch (e) { console.error("fetch-day: " + e.message); process.exitCode = 2; }
  if (A && A.mode === "selftest") selftest().then((okAll) => { process.exitCode = okAll ? 0 : 1; }, (e) => { console.error(e && e.stack || e); process.exitCode = 1; });
  else if (A) { try { fetchDay({ date: A.date, to: path.resolve(A.to), dry: A.dry }); process.exitCode = 0; } catch (e) { console.error("fetch-day: " + e.message); process.exitCode = 1; } }
}
module.exports = { fetchDay, planOf, destRefusal, gitIgnores, parseArgs, ARCHIVE };
