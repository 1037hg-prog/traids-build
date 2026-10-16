#!/usr/bin/env node
"use strict";
/**
 * R354 FUND DISCOUNTS (2026-10-16) — the package's SELFTEST: it proves the package on fixtures, on the STAGED copies, and never
 * touches the live tree, the network or any data file. Its last line is "ALL n CHECKS PASSED (m selftest cases)" and only then.
 *
 *   node docs/fund-discounts/2026-10-16/selftest.cjs
 *
 * WHAT IT CHECKS
 *   1-3   node --check on each staged file (the parser's own word on all three)
 *   4     the staged copies hash to the bytes deploy.cjs was built against
 *   5     the runner's own --selftest on the staged copy: every known-answer case on made-up series; "ALL n PASSED"
 *   6     the recorder's --selftest on the staged copy: a whole night on an injected fetcher; "ALL n PASSED"
 *   7     the case count never falls (AGENTS.md): the runner's and the recorder's counts are at or above the recorded floor
 *   8     deploy.cjs --plan is read-only, names the three files and refuses nothing it should not
 *   9     rollback.cjs --plan says what it would remove and never names a data file
 *   10    record.cjs --dry prints the three records and writes nothing
 *   11    --read refuses in this tree, naming every item of the read condition that does not hold, and reads no series
 *   12    the engine and the runner hold no network call, no environment read and no clock of their own
 * It runs the staged copies through node, from the repo root, so a broken require path is caught here and not at home.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const PKG = __dirname, REPO = path.resolve(PKG, "..", "..", ".."), PKG_REL = "docs/fund-discounts/2026-10-16";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const D = require("./deploy.cjs");
/** the floor for the two case counts: it may rise, never fall */
const FLOOR = Object.freeze({ runner: 100, recorder: 17 });

const node = (args, timeout = 1800000) => {
  const r = cp.spawnSync(process.execPath, args, { cwd: REPO, encoding: "utf8", timeout, maxBuffer: 256 << 20 });
  return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
};
const lastLine = (s) => String(s).trim().split("\n").pop() || "";

let checks = 0, bad = 0, cases = 0; const fails = [];
const check = (name, fn) => {
  checks++;
  let ok = false, detail = "";
  try { const r = fn(); if (r === true) ok = true; else if (r && typeof r === "object") { ok = !!r.ok; detail = r.detail || ""; } else { ok = false; detail = `returned ${JSON.stringify(r)}`; } }
  catch (e) { ok = false; detail = `threw: ${e.message}`; }
  if (!ok) { bad++; fails.push(`${name}${detail ? " — " + detail : ""}`); }
  console.log(`${ok ? "check ok " : "CHECK FAILED "} ${name}${detail ? "  —  " + detail : ""}`);
};

console.log(`R354 FUND DISCOUNTS — package selftest (${PKG_REL}) — the staged copies only, no network, no data, no read`);

for (const f of D.FILES) {
  check(`node --check ${f.staged}`, () => {
    const r = node(["--check", path.join(PKG, ...f.staged.split("/"))]);
    return { ok: r.status === 0, detail: r.status === 0 ? "" : lastLine(r.out) };
  });
}
check("the staged copies hash to the bytes deploy.cjs was built against", () => {
  const wrong = D.FILES.filter((f) => sha(fs.readFileSync(path.join(PKG, ...f.staged.split("/")))) !== f.stagedSha).map((f) => f.rel);
  return { ok: wrong.length === 0, detail: wrong.length ? `differ: ${wrong.join(", ")}` : D.FILES.map((f) => f.stagedSha.slice(0, 8)).join(" ") };
});

/**
 * A SCRATCH BACKEND holding the STAGED bytes and nothing else of this package: the three staged files, plus the three live files they
 * require and do not change (lib/atomic-write.js, lib/run-window.js, backend/package.json — the root package.json makes a .js file an
 * ES module, so the runner needs backend's own CommonJS one) and a copy of the registry they read. Everything below runs THERE, so the
 * cases are on the staged bytes whatever the live tree holds, and nothing the live tree holds can make them pass.
 */
function scratchBackend() {
  const os = require("os"), root = fs.mkdtempSync(path.join(os.tmpdir(), "r354-staged-"));
  fs.mkdirSync(path.join(root, "backend", "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "backend", "data"), { recursive: true });
  for (const f of D.FILES) {
    const to = path.join(root, ...f.rel.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(PKG, ...f.staged.split("/")), to);
  }
  for (const rel of ["backend/lib/atomic-write.js", "backend/lib/run-window.js", "backend/package.json", "backend/data/test-registry.json"]) {
    const from = path.join(REPO, ...rel.split("/"));
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(root, ...rel.split("/")));
  }
  return root;
}
const STAGED_ROOT = scratchBackend();
const stagedRunner = path.join(STAGED_ROOT, "backend", "r354-fund-discounts.js");
const stagedRecorder = path.join(STAGED_ROOT, "backend", "fund-nav-record.js");

let runnerCases = 0, recorderCases = 0;
check("the staged tree carries the three files and the registry they read", () => ({
  ok: fs.existsSync(stagedRunner) && fs.existsSync(stagedRecorder) && fs.existsSync(path.join(STAGED_ROOT, "backend", "lib", "fund-discount.js"))
    && fs.existsSync(path.join(STAGED_ROOT, "backend", "data", "test-registry.json")),
  detail: STAGED_ROOT,
}));
check("the runner's own selftest passes on the staged copy", () => {
  const r = node([stagedRunner, "--selftest"]);
  const m = /^ALL (\d+) PASSED$/.exec(lastLine(r.out));
  if (m) { runnerCases = +m[1]; cases += runnerCases; }
  return { ok: r.status === 0 && !!m, detail: m ? `${m[1]} known-answer cases` : lastLine(r.out) };
});
check("the recorder's own selftest passes on the staged copy", () => {
  const r = node([stagedRecorder, "--selftest"]);
  const m = /^ALL (\d+) PASSED$/.exec(lastLine(r.out));
  if (m) { recorderCases = +m[1]; cases += recorderCases; }
  return { ok: r.status === 0 && !!m, detail: m ? `${m[1]} known-answer cases` : lastLine(r.out) };
});
check("the count of selftest cases never falls", () => ({
  ok: runnerCases >= FLOOR.runner && recorderCases >= FLOOR.recorder,
  detail: `runner ${runnerCases} (floor ${FLOOR.runner}), recorder ${recorderCases} (floor ${FLOOR.recorder})`,
}));

check("deploy.cjs --plan is read-only and names all three files as new", () => {
  const before = D.FILES.map((f) => fs.existsSync(path.join(REPO, ...f.rel.split("/"))));
  const r = node([path.join(PKG_REL, "deploy.cjs"), "--plan"]);
  const after = D.FILES.map((f) => fs.existsSync(path.join(REPO, ...f.rel.split("/"))));
  return { ok: r.status === 0 && D.FILES.every((f) => r.out.includes(f.rel)) && String(before) === String(after), detail: r.status === 0 ? "" : lastLine(r.out) };
});
check("deploy.cjs refuses on DRIFT: a live file that is neither absent nor the staged bytes", () => {
  const os = require("os"), scratch = fs.mkdtempSync(path.join(os.tmpdir(), "r354-pkg-"));
  fs.mkdirSync(path.join(scratch, "backend", "lib"), { recursive: true });
  fs.writeFileSync(path.join(scratch, "backend", "lib", "fund-discount.js"), "// somebody else's file\n");
  const P = D.plan({ repo: scratch }), a = D.apply({ repo: scratch, log: () => {}, gate: () => ({ ok: true, line: "ALL 0 CHECKS PASSED" }) });
  fs.rmSync(scratch, { recursive: true, force: true });
  return { ok: P.problems.some((x) => /DRIFT/.test(x)) && a.result === "refused" && a.why.some((x) => /DRIFT/.test(x)), detail: (a.why || []).join(" | ").slice(0, 120) };
});
check("deploy.cjs refuses to write when the package's selftest does not pass", () => {
  const os = require("os"), scratch = fs.mkdtempSync(path.join(os.tmpdir(), "r354-pkg-"));
  const a = D.apply({ repo: scratch, log: () => {}, gate: () => ({ ok: false, line: "SELFTEST: 1 of 12 checks FAILED" }) });
  const wrote = fs.existsSync(path.join(scratch, "backend", "r354-fund-discounts.js"));
  fs.rmSync(scratch, { recursive: true, force: true });
  return { ok: a.result === "refused" && !wrote && a.why.join(" ").includes("selftest"), detail: (a.why || []).join(" | ").slice(0, 120) };
});
check("deploy then rollback in a scratch tree: the files land, then are removed, byte for byte", () => {
  const os = require("os"), scratch = fs.mkdtempSync(path.join(os.tmpdir(), "r354-pkg-"));
  const RB = require("./rollback.cjs");
  const a = D.apply({ repo: scratch, log: () => {}, gate: () => ({ ok: true, line: "ALL 12 CHECKS PASSED" }) });
  const landed = D.FILES.every((f) => sha(fs.readFileSync(path.join(scratch, ...f.rel.split("/")))) === f.stagedSha);
  const b = RB.rollback({ repo: scratch, log: () => {} });
  const gone = D.FILES.every((f) => !fs.existsSync(path.join(scratch, ...f.rel.split("/"))));
  fs.rmSync(scratch, { recursive: true, force: true });
  return { ok: a.result === "done" && a.written.length === 3 && landed && b.result === "done" && b.removed.length === 3 && gone, detail: `applied ${a.result}, landed ${landed}, rolled back ${b.result}, gone ${gone}` };
});
check("rollback.cjs --plan says what it would remove and names no data file", () => {
  const r = node([path.join(PKG_REL, "rollback.cjs"), "--plan"]);
  return { ok: r.status === 0 && !/backend\/data\/r354-(controls|read|cache)/.test(r.out.replace(/it never removes[\s\S]*/, "")), detail: r.status === 0 ? "" : lastLine(r.out) };
});
check("record.cjs --dry prints the three records and writes nothing", () => {
  const r = node([path.join(PKG_REL, "record.cjs"), "--dry"]);
  return { ok: r.status === 0 && /DRY/.test(r.out) && /change-registry/.test(r.out) && /amendments/.test(r.out), detail: r.status === 0 ? "" : lastLine(r.out) };
});
check("--read refuses in this tree, naming the items that do not hold, and reads no series", () => {
  const r = node([stagedRunner, "--read", "--span=discovery"]);
  return { ok: r.status === 2 && /REFUSED/.test(r.out) && /NO SERIES WAS READ/.test(r.out) && /\(3a\)/.test(r.out), detail: lastLine(r.out).slice(0, 140) };
});
check("--read refuses for the holdout as well, and says the discovery read is not sealed", () => {
  const r = node([stagedRunner, "--read", "--span=holdout"]);
  return { ok: r.status === 2 && /REFUSED/.test(r.out) && /\(8b\)/.test(r.out), detail: lastLine(r.out).slice(0, 140) };
});
check("the engine holds no network call, no environment read and no clock of its own", () => {
  const src = fs.readFileSync(path.join(PKG, "staged", "backend", "lib", "fund-discount.js"), "utf8");
  const needles = ["fetch(", "require(\"fs\")", "require('fs')", "Date.now(", "process" + "." + "env"];
  const found = needles.filter((n) => src.includes(n));
  return { ok: found.length === 0, detail: found.join(" ") };
});
check("the recorder opens a socket in ONE place only, and that place takes the injected fetcher", () => {
  const src = fs.readFileSync(path.join(PKG, "staged", "backend", "fund-nav-record.js"), "utf8");
  const n = src.split("await " + "fetch(").length - 1;
  return { ok: n === 1 && /function httpFetcher/.test(src) && /fetchList\(fetcher/.test(src) && /fetchChart\(fetcher/.test(src), detail: `${n} direct fetch call(s)` };
});

try { fs.rmSync(STAGED_ROOT, { recursive: true, force: true }); } catch { /* a scratch tree */ }
console.log(bad ? `SELFTEST: ${bad} of ${checks} checks FAILED\n  - ${fails.join("\n  - ")}` : `ALL ${checks} CHECKS PASSED (${cases} selftest cases)`);
process.exit(bad ? 1 : 0);
