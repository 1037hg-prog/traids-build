#!/usr/bin/env node
/**
 * chainfix selftest — ONE check per process (spawned by selftest.cjs). Never run against live state in a
 * way that writes it: every write the code under test would make is redirected to a temp dir, network is
 * stubbed, and a file is only loaded if its sha256 equals the packaged staged sha (so the OLD live
 * runners — e.g. the pre-fix ats-cache-warm.js, which runs on load — can never be executed by mistake).
 *
 * usage: node selftest-child.cjs <grep|rn|cache|warm|crypto|calendar> <staged|live>
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto"), Module = require("module");
const ROOT = "C:/Users/joshc/Downloads/traids (2)/traids-bundle";
const PKG = path.join(ROOT, "docs/health-fixes/2026-10-05/chainfix");
const { FILES } = require(path.join(PKG, "manifest.cjs"));
const [mode, target = "staged"] = process.argv.slice(2);
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail === undefined ? undefined : detail }); };
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "chainfix-selftest-"));

/** compile `rel` (target copy) as if it lived at its live path; refuse unless its bytes are the packaged ones */
function loadAt(rel) {
  const f = FILES.find((x) => x.rel === rel); if (!f) throw new Error("not in manifest: " + rel);
  const src = target === "live" ? path.join(ROOT, rel) : path.join(PKG, "staged", rel);
  const buf = fs.readFileSync(src);
  if (sha(buf) !== f.stagedSha) throw new Error(`REFUSED to load ${rel} (${target}): sha ${sha(buf).slice(0, 12)} is not the packaged ${f.stagedSha.slice(0, 12)}`);
  const live = path.join(ROOT, rel);
  if (require.cache[live]) return require.cache[live].exports;
  const m = new Module(live, null); m.filename = live; m.paths = Module._nodeModulePaths(path.dirname(live));
  require.cache[live] = m;
  m._compile(buf.toString("utf8"), live); m.loaded = true;
  return m.exports;
}
// a NEW lib (not live yet when target=staged) resolves to its live path, where loadAt registered it
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  try { return origResolve.call(this, req, parent, ...rest); }
  catch (e) {
    const p = parent && parent.filename ? path.resolve(path.dirname(parent.filename), req) : null;
    if (p && require.cache[p]) return p;
    throw e;
  }
};
function stubAtomicWrite(redirect) {   // the repo's writer, swapped for one that writes only into TMP
  const aw = path.join(ROOT, "backend/lib/atomic-write.js");
  const m = new Module(aw, null); m.filename = aw; m.loaded = true;
  m.exports = { writeJsonAtomic: (file, obj) => { redirect.push(file); fs.writeFileSync(path.join(TMP, "out-" + path.basename(file)), JSON.stringify(obj, null, 1)); },
    writeTextAtomic: () => { throw new Error("selftest: unexpected writeTextAtomic"); } };
  require.cache[aw] = m;
}
const gitList = (args) => { const r = cp.spawnSync("git", args, { cwd: ROOT, maxBuffer: 1 << 30, windowsHide: true });
  if (r.status === 1) return []; if (r.status !== 0) throw new Error("git exit " + r.status + " " + String(r.stderr).slice(0, 200));
  return r.stdout.toString("utf8").split("\0").filter(Boolean).sort(); };

async function run() {
  if (mode === "grep") {
    const { filesMentioning } = loadAt("backend/lib/git-grep-batch.js");
    // heavy (old call overflowed execSync's 1 MB), ordinary, a BRE '.' pattern, and a name nobody uses
    const pats = ["market-news-cycle", "candle-divergence", "backup.cjs", "zz-no-such-script-9q"];
    const spec = ["backend", "src", "automation"];
    let mism = null;
    for (let attempt = 0; attempt < 2; attempt++) {   // the tree is live (recorders write); one re-try absorbs a write landing between passes
      const t0 = Date.now(); const got = filesMentioning(ROOT, pats, spec); const secs = (Date.now() - t0) / 1000;
      mism = [];
      for (const p of pats) { const want = gitList(["grep", "-l", "-z", "-e", p, "--", ...spec]); const have = [...got.get(p)].sort();
        if (want.join("\n") !== have.join("\n")) mism.push({ p, want: want.length, have: have.length }); }
      if (!mism.length) { check("batched reader search == one git grep per name (4 names incl. a 24k-file one and a BRE '.' one)", true, { batchSecs: secs, counts: Object.fromEntries(pats.map((p) => [p, got.get(p).length])) }); break; }
    }
    if (mism.length) check("batched reader search == one git grep per name", false, mism);
    let threw = null; try { filesMentioning(TMP, ["anything"], ["."]); } catch (e) { threw = e.message; }
    check("a git failure THROWS (never reads as 'no readers')", !!threw, threw && threw.slice(0, 120));
  }

  else if (mode === "rn") {
    loadAt("backend/lib/git-grep-batch.js");
    const redirect = []; stubAtomicWrite(redirect);
    const t0 = Date.now(); process.exitCode = 0;
    loadAt("backend/routine-necessity.js");    // runs the review; its one write lands in TMP
    const secs = (Date.now() - t0) / 1000;
    const out = JSON.parse(fs.readFileSync(path.join(TMP, "out-routine-necessity.json"), "utf8"));
    check("routine-necessity completes well inside its 10-min chain budget", secs < 300, { secs });
    check("its only write was routine-necessity.json, redirected to temp", redirect.length === 1 && /routine-necessity\.json$/.test(redirect[0]), redirect);
    check("reader search succeeded (no readerSearchError, no readersUnknown)", !out.readerSearchError && !out.findings.readersUnknown, out.readerSearchError);
    check("batched history used (no per-path fallback)", !out.historyBatchNote, out.historyBatchNote);
    check("same output shape as routine-necessity-v1", out.spec === "routine-necessity-v1" && ["producesNothing", "outgrowingBudget", "servesNobody", "unknownOutput"].every((k) => Array.isArray(out.findings[k])), Object.keys(out.findings));
    check("exit code 0", (process.exitCode || 0) === 0, process.exitCode);
    process.exitCode = 0;
  }

  else if (mode === "cache") {
    const { saveMergedJson, mergeNewerByAt } = loadAt("backend/lib/cache-save.js");
    const f = path.join(TMP, "ats-cache.json");
    // merge rule
    const mm = mergeNewerByAt({ A: { at: 5, v: "disk" }, B: { at: 9, v: "disk" }, C: { at: 1, v: "diskonly" } }, { A: { at: 7, v: "mine" }, B: { at: 3, v: "mine" } });
    check("merge: newer `at` wins per key, disk-only keys kept", mm.A.v === "mine" && mm.B.v === "disk" && mm.C.v === "diskonly", mm);
    // compact format, same bytes the old JSON.stringify(cache) wrote
    const obj = { AAA: { at: 1, day: "2026-10-05", week: null, shares: null, weekVol: null, atsPct: null } };
    await saveMergedJson(f, obj, { log: () => {} });
    check("writes compact JSON byte-identical to the old JSON.stringify(cache)", fs.readFileSync(f, "utf8") === JSON.stringify(obj));
    // retried sharing violation: rename fails twice (EBUSY, then UNKNOWN as -4094 surfaces), then succeeds
    const realRename = fs.renameSync; let fails = 0;
    fs.renameSync = function (a, b) { if (b === f && fails < 2) { fails++; const e = new Error("simulated"); e.code = fails === 1 ? "EBUSY" : "UNKNOWN"; throw e; } return realRename.apply(fs, arguments); };
    const logs = [];
    try { await saveMergedJson(f, { ...obj, BBB: { at: 2 } }, { baseMs: 10, log: (s) => logs.push(s) }); } finally { fs.renameSync = realRename; }
    check("EBUSY + UNKNOWN on rename are retried and the write lands", fails === 2 && JSON.parse(fs.readFileSync(f, "utf8")).BBB && logs.length === 1, { fails, logs });
    // a concurrent writer's newer entry survives our save
    fs.writeFileSync(f, JSON.stringify({ AAA: { at: 99, v: "server" }, ZZZ: { at: 50 } }));
    const merged = await saveMergedJson(f, { AAA: { at: 1 }, CCC: { at: 3 } }, { log: () => {} });
    const disk = JSON.parse(fs.readFileSync(f, "utf8"));
    check("an entry the server wrote meanwhile (newer) is kept, not clobbered", disk.AAA.v === "server" && disk.ZZZ && disk.CCC && merged.AAA.v === "server", disk);
    // persistent EPERM: gives up after `tries`, throws WITH the code, leaves no temp file behind
    fs.renameSync = function (a, b) { if (b === f) { const e = new Error("simulated"); e.code = "EPERM"; throw e; } return realRename.apply(fs, arguments); };
    let err = null; try { await saveMergedJson(f, { X: { at: 1 } }, { tries: 3, baseMs: 5, log: () => {} }); } catch (e) { err = e; } finally { fs.renameSync = realRename; }
    check("persistent EPERM throws with its code after the retries", err && err.code === "EPERM", err && err.message);
    check("no stray temp file after giving up", !fs.existsSync(path.join(path.dirname(f), path.basename(f) + ".tmp-" + process.pid)));
    // the on-disk copy caught mid-write (server's in-place write) is retried, then merged — not dropped
    fs.writeFileSync(f, '{"SRV":{"at":7');                                   // half-written
    const realRead = fs.readFileSync; let reads = 0;
    fs.readFileSync = function (p, ...rest) { if (p === f && ++reads === 2) fs.writeFileSync(f, JSON.stringify({ SRV: { at: 7 } })); return realRead.call(fs, p, ...rest); };   // the writer finishes before our 2nd read
    const logs2 = [];
    try { await saveMergedJson(f, { MINE: { at: 1 } }, { baseMs: 5, log: (s) => logs2.push(s) }); } finally { fs.readFileSync = realRead; }
    const d2 = JSON.parse(fs.readFileSync(f, "utf8"));
    check("a half-written on-disk copy is retried and then MERGED (server entry kept)", d2.SRV && d2.MINE && /attempt/.test(logs2.join(" ")), { keys: Object.keys(d2), logs2 });
    // a permanently corrupt copy does not block the save forever: the last attempt overwrites it, and says so
    fs.writeFileSync(f, "{corrupt");
    const logs3 = [];
    await saveMergedJson(f, { MINE: { at: 2 } }, { tries: 3, baseMs: 5, log: (s) => logs3.push(s) });
    check("a permanently corrupt copy is overwritten on the last attempt, logged WITHOUT merge", JSON.parse(fs.readFileSync(f, "utf8")).MINE && /WITHOUT merge/.test(logs3.join(" ")), logs3);
    // a non-sharing error is not retried
    let t0 = Date.now(), err2 = null; try { await saveMergedJson(path.join(TMP, "no-such-dir", "x.json"), { a: 1 }, { baseMs: 1000, log: () => {} }); } catch (e) { err2 = e; }
    check("ENOENT (not a sharing violation) is thrown at once, not retried", err2 && err2.code === "ENOENT" && Date.now() - t0 < 900, err2 && err2.code);
  }

  else if (mode === "warm") {   // the runner itself is NOT loaded (it starts fetching on load); its source is checked
    const f = FILES.find((x) => x.rel === "backend/ats-cache-warm.js");
    const src = fs.readFileSync(target === "live" ? path.join(ROOT, f.rel) : path.join(PKG, "staged", f.rel));
    check("ats-cache-warm.js is the packaged version", sha(src) === f.stagedSha);
    const s = src.toString("utf8");
    check("no bare writeFileSync on the cache remains", !/writeFileSync\(\s*CACHE/.test(s));
    check("both saves go through saveMergedJson", (s.match(/await saveMergedJson\(CACHE, cache/g) || []).length === 2);
    check("final-save failure sets exitCode 1 (loud)", /final save[\s\S]{0,400}process\.exitCode = 1/.test(s));
    const r = cp.spawnSync(process.execPath, ["-c", target === "live" ? path.join(ROOT, f.rel) : path.join(PKG, "staged", f.rel)], { encoding: "utf8" });
    check("node -c", r.status === 0, r.stderr && r.stderr.slice(0, 200));
  }

  else if (mode === "crypto") {
    process.env.ALPACA_KEY_ID = "selftest-dummy"; process.env.ALPACA_SECRET_KEY = "selftest-dummy";   // set first: dotenv never overrides
    const realAppend = fs.appendFileSync;
    fs.appendFileSync = () => { throw new Error("selftest: the recorder tried to APPEND"); };
    const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url).replace(/symbols=[^&]*/, "symbols=..."));
      const J = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
      if (/data\.alpaca\.markets/.test(url)) return J(200, { quotes: {
        "AAA/USD": { ap: 10.01, bp: 10.0, as: 1, bs: 1, t: iso(now - 5000) },            // live Alpaca book
        "CCC/USD": { ap: 0, bp: 0, t: iso(now - 400 * 86400000) },                       // dead (delisted) book -> Coinbase
        "EEE/USD": { ap: 2.01, bp: 2.0, t: iso(now - 600000) },                          // listed but 10 min stale -> dropped, NOT routed
      } });
      const prod = (String(url).match(/products\/([A-Z0-9-]+)\/book/) || [])[1];
      if (prod === "BBB-USD") return J(200, { bids: [["5.00", "3", 1]], asks: [["5.01", "2", 1]], time: iso(Date.now() - 1000), auction_mode: false });
      if (prod === "DDD-USD") return J(200, { bids: [["1.00", "1", 1]], asks: [["1.01", "1", 1]], time: iso(Date.now()), auction_mode: true });
      if (prod === "FFF-USD") return J(200, { bids: [["1.00", "1", 1]], asks: [["1.01", "1", 1]], time: iso(Date.now() - 3600000), auction_mode: false });
      return J(404, { message: "NotFound" });                                            // CCC-USD and anything else
    };
    const mod = loadAt("backend/crypto-spread-snapshot.js");
    const syms = ["AAA/USD", "BBB/USD", "CCC/USD", "DDD/USD", "EEE/USD", "FFF/USD"];
    const r = await mod.collect(syms);
    fs.appendFileSync = realAppend;
    const bySym = Object.fromEntries(r.rows.map((x) => [x.sym, x])), why = Object.fromEntries(r.dropped.map((d) => [d[0], d[1]]));
    check("every symbol attempted and accounted for exactly once", r.attempted === 6 && r.rows.length + r.dropped.length === 6 && syms.every((s) => (s in bySym) !== (s in why)), { rows: Object.keys(bySym), dropped: why });
    check("Alpaca-listed live book stays on Alpaca, venue tagged", bySym["AAA/USD"] && bySym["AAA/USD"].venue === "alpaca");
    check("a name Alpaca returns no quote for is measured on Coinbase, venue + product tagged", bySym["BBB/USD"] && bySym["BBB/USD"].venue === "coinbase" && bySym["BBB/USD"].product === "BBB-USD" && bySym["BBB/USD"].rtBps > 0);
    check("a dead Alpaca book routes to Coinbase; Coinbase 404 gives a two-venue reason", /alpaca: dead book.*coinbase: no CCC-USD product \(404\)/.test(why["CCC/USD"] || ""), why["CCC/USD"]);
    check("Coinbase auction book is dropped with a reason", /auction mode/.test(why["DDD/USD"] || ""), why["DDD/USD"]);
    check("a momentarily stale Alpaca quote is dropped (not venue-hopped)", /^stale \d+s$/.test(why["EEE/USD"] || ""), why["EEE/USD"]);
    check("a stale Coinbase book is dropped (same 300 s gate)", /coinbase: stale \d+s/.test(why["FFF/USD"] || ""), why["FFF/USD"]);
    check("Alpaca was called once, batched", calls.filter((c) => /alpaca/.test(c)).length === 1, calls.length);
    const uni = mod.cryptoUniverse();
    check("live universe readable from the ledger (read-only)", Array.isArray(uni) && uni.length > 0, uni.length);
  }

  else if (mode === "calendar") {
    const f = FILES.find((x) => x.rel === "backend/data/macro-calendar.json");
    const file = target === "live" ? path.join(ROOT, f.rel) : path.join(PKG, "staged", f.rel);
    const buf = fs.readFileSync(file);
    check("macro-calendar.json is the packaged version", sha(buf) === f.stagedSha);
    const txt = buf.toString("utf8"), cal = JSON.parse(txt);
    check("format unchanged: writeJsonAtomic indent 1, LF, no BOM, no trailing newline", JSON.stringify(cal, null, 1) === txt && !/\r/.test(txt) && buf[0] !== 0xef);
    const PCE = ["2026-10-29", "2026-11-25", "2026-12-23"];
    check("PCE = the three remaining 2026 BEA releases, nothing invented for 2027", JSON.stringify(cal.PCE) === JSON.stringify(PCE), cal.PCE);
    // base = the pre-change file (backup after a deploy, else git HEAD) — everything except the PCE additions is unchanged
    const bk = path.join(ROOT, "docs/health-fixes/2026-10-05/backups", f.rel.replace(/[\\/]/g, "__") + ".pre-chainfix");
    let baseTxt = fs.existsSync(bk) ? fs.readFileSync(bk, "utf8") : null;
    if (!baseTxt) { const r = cp.spawnSync("git", ["show", "HEAD:" + f.rel], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 24 }); baseTxt = r.status === 0 ? r.stdout : null; }
    if (baseTxt) {
      const base = JSON.parse(baseTxt);
      const same = ["spec", "CPI", "NFP", "FOMC"].every((k) => JSON.stringify(base[k]) === JSON.stringify(cal[k]))
        && JSON.stringify({ ...base.sources, PCE: null }) === JSON.stringify({ ...cal.sources, PCE: null })
        && JSON.stringify(base.notes) === JSON.stringify(cal.notes.slice(0, base.notes.length)) && cal.notes.length === base.notes.length + 1
        && cal.collectedAt.startsWith(base.collectedAt) && Array.isArray(base.PCE) && base.PCE.length === 0;
      check("CPI/NFP/FOMC, spec, existing notes and sources byte-for-byte unchanged; one dated note added", same);
    } else check("base calendar available for comparison", false, "no backup and git show failed");
    // event-watch's own status rule, applied to today (ET)
    const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const status = Object.fromEntries(["CPI", "NFP", "FOMC", "PCE"].map((k) => { const d = (cal[k] || []).filter((x) => typeof x === "string"); const fut = d.filter((x) => x >= TODAY);
      return [k, !d.length ? "BLIND — no dates at all" : !fut.length ? "BLIND — calendar has run out" : "ok"]; }));
    check("event-watch would report PCE ok (not BLIND) today", status.PCE === "ok", status);
  }
  else throw new Error("unknown mode " + mode);
}

run().then(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.stdout.write("\n@@RESULT " + JSON.stringify({ mode, target, ok: checks.length > 0 && checks.every((c) => c.ok), checks }) + "\n");
}).catch((e) => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.stdout.write("\n@@RESULT " + JSON.stringify({ mode, target, ok: false, error: String(e && e.stack || e).slice(0, 600), checks }) + "\n");
});
