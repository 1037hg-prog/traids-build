#!/usr/bin/env node
"use strict";
/**
 * OFFLINE TEST of backend/schwab-auth.js's 2026-10-05 change (package "alerting"). Never touches the repo's .env, data/ or Schwab.
 *   node tools/test-schwab-auth.cjs [--from staged|live]      (default staged; deploy.cjs runs it with --from live after copying)
 * Builds a throwaway tree in os.tmpdir(): backend/{schwab-auth.js, lib/preflight-checks.js, lib/atomic-write.js, lib/run-window.js}
 * plus a FAKE .env (fake key, fake secret, placeholder token), then runs schwab-auth.js there with stdin = a fake redirect URL and a
 * preload that answers ONLY the token endpoint with a fake refresh token (any other network call, and any child process, throws).
 * Asserts: the token flow is unchanged (.env line replaced, exit 0, the usual lines printed), data/schwab-auth-meta.json is written
 * with the issue time and the fingerprint of the NEW token and holds no token text, and preflight's age check then reads "ok".
 * A second run with an unwritable meta path proves a failed record cannot fail the flow.
 */
const fs = require("fs"), path = require("path"), os = require("os"), { spawnSync } = require("child_process");
const REPO = "C:\\Users\\joshc\\Downloads\\traids (2)\\traids-bundle";
const from = process.argv.includes("--from") ? process.argv[process.argv.indexOf("--from") + 1] : "staged";
const SRC = from === "live" ? path.join(REPO, "backend") : path.join(__dirname, "..", "staged", "backend");
const LIVE_LIB = path.join(REPO, "backend", "lib");
const pick = (rel) => (fs.existsSync(path.join(SRC, rel)) ? path.join(SRC, rel) : path.join(REPO, "backend", rel));
const FAKE_TOKEN = "FAKE-refresh-" + "z".repeat(70);
let pass = 0, fail = 0;
const ok = (label, cond, info = "") => { cond ? pass++ : fail++; console.log(`  ${cond ? "PASS" : "FAIL"} ${label}${!cond && info ? " :: " + info : ""}`); };

function build(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `schwab-auth-test-${tag}-`)), be = path.join(root, "backend");
  fs.mkdirSync(path.join(be, "lib"), { recursive: true }); fs.mkdirSync(path.join(be, "data"));
  fs.copyFileSync(pick("schwab-auth.js"), path.join(be, "schwab-auth.js"));
  fs.copyFileSync(pick("lib/preflight-checks.js"), path.join(be, "lib", "preflight-checks.js"));
  for (const f of ["atomic-write.js", "run-window.js"]) fs.copyFileSync(path.join(LIVE_LIB, f), path.join(be, "lib", f));
  fs.writeFileSync(path.join(be, ".env"), "SCHWAB_APP_KEY=fake-app-key\nSCHWAB_APP_SECRET=fake-app-secret\nSCHWAB_REFRESH_TOKEN=placeholder-25-characters\nOTHER_KEY=untouched\n");
  fs.writeFileSync(path.join(root, "preload.cjs"), `
    const cp = require("child_process");
    for (const n of ["exec","execSync","execFile","execFileSync","spawn","spawnSync","fork"]) cp[n] = () => { throw new Error("test: child process refused"); };
    globalThis.fetch = async (url, opts) => {
      if (String(url) !== "https://api.schwabapi.com/v1/oauth/token") throw new Error("test: network refused: " + url);
      const body = String(opts && opts.body);
      if (!/grant_type=authorization_code/.test(body) || !/code=FAKECODE/.test(body)) return { ok: false, status: 400, json: async () => ({ error: "bad grant" }) };
      return { ok: true, status: 200, json: async () => ({ access_token: "fake-access", refresh_token: ${JSON.stringify(FAKE_TOKEN)}, expires_in: 1800 }) };
    };`);
  return { root, be };
}
const run = (t) => spawnSync(process.execPath, ["--require", path.join(t.root, "preload.cjs"), path.join(t.be, "schwab-auth.js")], { cwd: t.root, input: "https://127.0.0.1/?code=FAKECODE&session=x\n", encoding: "utf8", timeout: 30000, windowsHide: true });

console.log(`schwab-auth.js offline test (source: ${from} — ${SRC})`);
const t0 = Date.now();
{
  const t = build("ok"), r = run(t);
  ok("exit 0", r.status === 0, `status ${r.status} ${r.stderr}`);
  const env = fs.readFileSync(path.join(t.be, ".env"), "utf8");
  ok(".env: the refresh-token line was replaced, other keys untouched", env.includes("SCHWAB_REFRESH_TOKEN=" + FAKE_TOKEN) && env.includes("OTHER_KEY=untouched") && !env.includes("placeholder-25"));
  ok("the usual flow lines still print", /refresh token written to backend\/\.env/.test(r.stdout) && /access token also obtained/.test(r.stdout));
  ok("the record line prints", /issue time recorded/.test(r.stdout), r.stdout.slice(-400));
  let meta = null; try { meta = JSON.parse(fs.readFileSync(path.join(t.be, "data", "schwab-auth-meta.json"), "utf8")); } catch {}
  ok("data/schwab-auth-meta.json written", !!meta);
  if (meta) {
    const issued = Date.parse(meta.refreshTokenIssuedAt);
    ok("issue time is this run", issued >= t0 - 1000 && issued <= Date.now() + 1000, meta.refreshTokenIssuedAt);
    ok("expiry is issue + 7 days", Date.parse(meta.refreshTokenExpiresAt) - issued === 7 * 864e5);
    const PC = require(path.join(t.be, "lib", "preflight-checks.js"));
    ok("fingerprint is the NEW token's", meta.refreshTokenFingerprint === PC.refreshTokenFingerprint(FAKE_TOKEN));
    ok("no token text in the record", !JSON.stringify(meta).includes(FAKE_TOKEN) && !JSON.stringify(meta).includes("fake-app-secret"));
    const age = PC.schwabRefreshAgeCheck({ envPath: path.join(t.be, ".env"), metaPath: path.join(t.be, "data", "schwab-auth-meta.json") });
    ok("preflight age check reads ok right after the flow", age.status === "ok", JSON.stringify(age));
  }
  ok("nothing secret printed", !r.stdout.includes(FAKE_TOKEN) && !r.stderr.includes(FAKE_TOKEN));
  fs.rmSync(t.root, { recursive: true, force: true });
}
{
  const t = build("nometa");
  fs.mkdirSync(path.join(t.be, "data", "schwab-auth-meta.json"));      // a DIRECTORY where the record goes: the write must fail
  const r = run(t);
  ok("record failure: exit 0 anyway", r.status === 0, `status ${r.status} ${r.stderr}`);
  ok("record failure: .env still written", fs.readFileSync(path.join(t.be, ".env"), "utf8").includes("SCHWAB_REFRESH_TOKEN=" + FAKE_TOKEN));
  ok("record failure: says preflight will report UNKNOWN", /NOT recorded/.test(r.stdout + r.stderr), (r.stdout + r.stderr).slice(-300));
  fs.rmSync(t.root, { recursive: true, force: true });
}
console.log(`\nschwab-auth offline test: ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail || pass < 14 ? 1 : 0);   // 14 assertions written: fewer ran = not a pass
