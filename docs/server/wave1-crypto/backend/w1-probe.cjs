#!/usr/bin/env node
/**
 * W1 PROBE — read-only summary of the W1 units' state on the VPS, one JSON line. 2026-10-07 (server migration M4;
 * docs/server/wave1-crypto). Installed at /home/traids/traids/backend/w1-probe.cjs; home's backend/lib/w1-health.cjs runs it over ssh.
 * It reads, never writes: the ownership map, each unit's last-run stamp (data/w1-run-*.json, written by w1-run.cjs), the newest
 * whales and social snapshots, the funding store's newest period, R323's state and ledger size, and the sha256 of the code files.
 *
 *   node w1-probe.cjs [--tree /home/traids/traids/backend]
 *   node w1-probe.cjs --selftest
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const CODE = ["hyperliquid-whales-record.js", "r323-hl-copy-leaders.js", "funding-carry-v2.js", "social-mentions-record.js", "lib/atomic-write.js", "w1-run.cjs", "own-check.cjs", "w1-probe.cjs"];
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const sha = (f) => { try { return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } catch { return null; } };

function newestDated(dir) {
  let names = []; try { names = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { return { files: 0, newest: null, newestComplete: null }; }
  const pick = (n) => { const j = readJson(path.join(dir, n)); return j ? { day: n.slice(0, 10), recordedAt: j.recordedAt || null, complete: j.complete === true, errors: Array.isArray(j.errors) ? j.errors.length : null } : { day: n.slice(0, 10), unreadable: true }; };
  const newest = names.length ? pick(names[names.length - 1]) : null;
  let newestComplete = null;
  for (let i = names.length - 1; i >= 0 && i >= names.length - 10; i--) { const p = pick(names[i]); if (p.complete) { newestComplete = p; break; } }
  return { files: names.length, newest, newestComplete };
}
/** the paging path every W1 unit's OnFailure= depends on (installed by R309's package, docs/server/phase0-golive, which can remove
 *  it): traids-alert.cjs, the traids-alert@.service template, and backend/.env (-> /etc/traids/traids.env) readable and naming
 *  TELEGRAM_BOT_TOKEN. Booleans only: no value of the env file is ever output. */
function alertPath(tree, unitDir = "/etc/systemd/system") {
  const envF = path.join(tree, ".env"); let env = false, token = false;
  try { fs.accessSync(envF, fs.constants.R_OK); env = true; token = /^[ \t]*TELEGRAM_BOT_TOKEN[ \t]*=[ \t]*[^\s#]/m.test(fs.readFileSync(envF, "utf8")); } catch { /* not readable */ }
  return { script: fs.existsSync(path.join(tree, "traids-alert.cjs")), unit: fs.existsSync(path.join(unitDir, "traids-alert@.service")), env, token };
}
function probe(tree, { unitDir = "/etc/systemd/system" } = {}) {
  const D = (f) => path.join(tree, "data", f);
  const mapTxt = (() => { try { return fs.readFileSync(D("host-ownership.json")); } catch { return null; } })();
  let map = null; try { map = mapTxt ? JSON.parse(mapTxt.toString("utf8")) : null; } catch { map = null; }
  const store = readJson(D("funding-carry-store.json"));
  let periods = 0, newestT = null;
  if (store && store.periods) for (const m of Object.values(store.periods)) for (const k of Object.keys(m || {})) { periods++; const t = Number(k); if (Number.isFinite(t) && (newestT == null || t > newestT)) newestT = t; }
  const st = readJson(D("r323-state.json"));
  let ledgerRows = null; try { ledgerRows = fs.readFileSync(D("r323-ledger.jsonl"), "utf8").split("\n").filter((l) => l.trim()).length; } catch { ledgerRows = null; }
  return {
    probe: "w1-probe-v1", now: Date.now(), host: os.hostname(), tree,
    map: mapTxt ? { sha: crypto.createHash("sha256").update(mapTxt).digest("hex"), units: map && map.units ? map.units : null } : null,
    runs: Object.fromEntries(["whales", "funding", "social"].map((u) => [`w1-${u}`, readJson(D(`w1-run-${u}.json`))])),
    whales: newestDated(D("hyperliquid-whales")),
    social: newestDated(D("social-mentions")),
    funding: store ? { periods, newestT, mtime: (() => { try { return fs.statSync(D("funding-carry-store.json")).mtimeMs; } catch { return null; } })() } : null,
    r323: { state: st ? { updatedAt: st.updatedAt || null, status: st.status || null, dailyFrom: st.cadence ? st.cadence.dailyFrom : null, intervals: st.counts ? st.counts.intervals : null, gaps: st.counts ? st.counts.gaps : null } : null, ledgerRows },
    switches: ["TRAIDS_STOP", "w1-whales-OFF", "w1-funding-OFF", "w1-social-OFF"].filter((f) => fs.existsSync(D(f))),
    code: Object.fromEntries(CODE.map((f) => [f, sha(path.join(tree, ...f.split("/")))])),
    alert: alertPath(tree, unitDir),
  };
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w1-probe-"));
  try {
    const B = path.join(tmp, "backend"), w = (rel, s) => { const f = path.join(B, ...rel.split("/")); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
    w("data/hyperliquid-whales/2026-10-10.json", JSON.stringify({ recordedAt: "2026-10-10T21:31:00Z", complete: true, errors: [] }));
    w("data/hyperliquid-whales/2026-10-11.json", JSON.stringify({ recordedAt: "2026-10-11T21:31:00Z", complete: false, errors: [1, 2, 3, 4, 5, 6] }));
    w("data/funding-carry-store.json", JSON.stringify({ periods: { BTC: { 1791302400000: {}, 1791331200000: {} }, ETH: { 1791302400000: {} } } }));
    w("data/host-ownership.json", JSON.stringify({ schema: "host-ownership-v1", units: { "w1-whales": "server" } }));
    w("data/w1-run-whales.json", JSON.stringify({ ok: true, finishedAt: "2026-10-11T21:40:00Z" }));
    w("data/r323-ledger.jsonl", "{}\n{}\n"); w("w1-run.cjs", "x");
    const before = fs.readdirSync(path.join(B, "data")).sort().join(",");
    const p = probe(B);
    ok("newest and newest COMPLETE whales snapshot told apart", p.whales.newest.day === "2026-10-11" && !p.whales.newest.complete && p.whales.newestComplete.day === "2026-10-10", JSON.stringify(p.whales));
    ok("funding: periods counted, newest period found", p.funding.periods === 3 && p.funding.newestT === 1791331200000);
    ok("map sha + units, run stamps, R323 ledger rows, code shas (null when absent)", /^[0-9a-f]{64}$/.test(p.map.sha) && p.map.units["w1-whales"] === "server" && p.runs["w1-whales"].ok && p.r323.ledgerRows === 2 && /^[0-9a-f]{64}$/.test(p.code["w1-run.cjs"]) && p.code["own-check.cjs"] === null && p.social.files === 0);
    ok("read-only: the data dir is unchanged", fs.readdirSync(path.join(B, "data")).sort().join(",") === before);
    const U = path.join(tmp, "units"); fs.mkdirSync(U);
    ok("alert path: nothing installed -> all false", JSON.stringify(probe(B, { unitDir: U }).alert) === JSON.stringify({ script: false, unit: false, env: false, token: false }));
    w("traids-alert.cjs", "x"); fs.writeFileSync(path.join(U, "traids-alert@.service"), "x"); w(".env", "ALPACA_TV_KEY_ID=k\nTELEGRAM_BOT_TOKEN=secret-value-123\n");
    const pa = probe(B, { unitDir: U }), out = JSON.stringify(pa);
    ok("alert path: script + template unit + a readable .env naming TELEGRAM_BOT_TOKEN -> all true; NO env value in the output", pa.alert.script && pa.alert.unit && pa.alert.env && pa.alert.token && !/secret-value-123|ALPACA_TV_KEY_ID=k/.test(out));
    w(".env", "TELEGRAM_BOT_TOKEN=\nOTHER=x\n");
    ok("alert path: the token key empty (another key on the next line) -> token false", probe(B, { unitDir: U }).alert.token === false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`w1-probe selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a[0] === "--selftest") process.exitCode = selftest() ? 0 : 1;
  else { const i = a.indexOf("--tree"); console.log(JSON.stringify(probe(i >= 0 && a[i + 1] ? a[i + 1] : __dirname))); process.exitCode = 0; }
}
module.exports = { probe, alertPath, CODE };
