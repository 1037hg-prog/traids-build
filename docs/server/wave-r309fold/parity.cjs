#!/usr/bin/env node
/**
 * PARITY — the installed deploy/server/pull-r309.cjs (the hourly task's rules) against the installed deploy/server/pull-server.cjs with
 * deploy/server/manifests/r309.json (the same rules as data), and the fold (deploy-server/r309-fold.cjs: pull-server's pullWave with
 * pull-r309.cjs's validate() as a runtime guard), on RECORDED fixtures. 2026-10-09 (docs/server/wave-r309fold). Offline: temp dirs and
 * a fake ssh that serves a tar; no network, no repo data file.
 *
 * Every scenario runs three times, each on its own fresh temp home (r309-HALT, r309-OFF and an unrelated file present):
 *   old   pull-r309.cjs applyPull(tar, home)
 *   new   pull-server.cjs applyUnit(manifests/r309.json's unit, tar, home)          (what pullWave applies after the fetch)
 *   fold  r309-fold.cjs pullR309({ ssh: <serves the tar> })                         (the whole path: map, lock, fetch, guard, apply)
 * and the proof asserts, scenario by scenario:
 *   AGREE        old and new decide the same (both accept, or both refuse; a missing home r309-HALT is exit 4 for both)
 *   SAME BYTES   when they accept, the four run files at home are byte-identical after each
 *   UNION        the fold accepts exactly when BOTH accept (it is never looser than either), and then writes the same bytes
 *   NOTHING      a refusal writes nothing (the four files as before); r309-HALT, r309-OFF and the unrelated file are never touched
 * Families: (A) the recorded transitions 10-07 / 10-08 / 10-09 in every order; (B) the recorded files mutated row by row, byte cut by
 * byte cut, field by field, and at the tar level; (C) the lot lifecycle (runner row shape, recorded signal values): every ordered pair
 * of its 11 ledger states and every immutable / once-set field of every row. Then (D) the six inputs where the two rule sets
 * DIFFER, each pinned as a known answer — none of them is a row the R309 runner writes, and in each the fold refuses.
 *
 *   node docs/server/wave-r309fold/parity.cjs              the proof, as a summary
 *   node docs/server/wave-r309fold/parity.cjs --selftest   the same as ok / FAIL lines (selftest.cjs runs this)
 *   node docs/server/wave-r309fold/parity.cjs --list       also print every scenario's decision
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const HERE = __dirname, REPO = path.resolve(HERE, "..", "..", ".."), DS = path.join(REPO, "deploy", "server");
const PR_FILE = path.join(DS, "pull-r309.cjs"), MDIR = path.join(DS, "manifests");
const PR = require(PR_FILE), PS = require(path.join(DS, "pull-server.cjs"));
const RF = require(path.join(HERE, "deploy-server", "r309-fold.cjs")), FXM = require(path.join(HERE, "fixtures.cjs"));
const DEF = PS.loadManifest("r309", MDIR).units.r309;
const FOUR = ["r309-cycles.jsonl", "r309-ledger.jsonl", "r309-surge-hold48.json", "r309-interim.json"];
const TAR_CMD = /tar --format=ustar -cf - --null --no-recursion -T -/;
const MAP = JSON.stringify({ schema: "host-ownership-v1", units: { r309: "server" } });
const B = (x) => (Buffer.isBuffer(x) ? x : Buffer.from(String(x)));
const tarOf = (files) => PS.tarOf(Object.entries(files).filter(([, d]) => d != null).map(([name, data]) => ({ name, data: B(data) })));

// ── the harness ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
let ROOT = null, N = 0;
const OTHERS = { "r309-HALT": "home backstop\n", "r309-OFF": "home off\n", "seat-claims.jsonl": "untouched\n" };
function mkHome(files, { halt = true } = {}) {
  const d = path.join(ROOT, "h" + ++N); fs.mkdirSync(d);
  for (const [n, s] of Object.entries(OTHERS)) if (halt || n !== "r309-HALT") fs.writeFileSync(path.join(d, n), s);
  for (const [n, b] of Object.entries(files || {})) if (b != null) fs.writeFileSync(path.join(d, n), B(b));
  return d;
}
const readFour = (d) => Object.fromEntries(FOUR.map((n) => { const f = path.join(d, n); return [n, fs.existsSync(f) ? fs.readFileSync(f).toString("base64") : null]; }));
const readOthers = (d) => Object.fromEntries(Object.keys(OTHERS).map((n) => { const f = path.join(d, n); return [n, fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null]; }));
const serve = (tar) => (script, o = {}) => (TAR_CMD.test(String(script)) ? { ok: true, status: 0, out: tar, err: "" } : { ok: false, status: 1, out: o.binary ? Buffer.alloc(0) : "", err: "unexpected ssh call" });
/** one scenario through old / new / fold -> { old, new, fold } each { ok, code, why, four, others }, plus the home's initial four */
function run(sc) {
  const tar = sc.tar || tarOf(sc.server), out = {};
  const init = (() => { const d = mkHome(sc.home, sc); const f = readFour(d); fs.rmSync(d, { recursive: true, force: true }); return f; })();
  for (const k of ["old", "new", "fold"]) {
    const d = mkHome(sc.home, sc); let r;
    try {
      if (k === "old") r = PR.applyPull(tar, d);
      else if (k === "new") r = PS.applyUnit(DEF, tar, d);
      else { fs.writeFileSync(path.join(d, "host-ownership.json"), MAP); const p = RF.pullR309({ homeDir: d, manifestDir: MDIR, ssh: serve(tar), guardFile: PR_FILE }); r = { ok: p.exit === 0, code: p.exit, why: p.why, kind: p.kind }; }
    } catch (e) { r = { ok: false, code: "threw", why: "THREW: " + e.message }; }
    out[k] = { ok: !!r.ok, code: r.code, why: r.why || null, kind: r.kind || null, four: readFour(d), others: readOthers(d) };
    fs.rmSync(d, { recursive: true, force: true });
  }
  out.init = init;
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const OTHERS_OK = (x) => same(x.others, Object.fromEntries(Object.entries(OTHERS).map(([n, s]) => [n, n === "r309-HALT" && x.haltMissing ? null : s])));
/** the four properties for one scenario result; -> null (holds) or why not */
function judge(sc, r) {
  const hm = sc.halt === false;
  for (const k of ["old", "new", "fold"]) { const o = { ...r[k], haltMissing: hm }; if (!OTHERS_OK(o)) return `${k} touched r309-HALT / r309-OFF / an unrelated file`; if (!r[k].ok && !same(r[k].four, r.init)) return `${k} refused but changed a run file`; }
  if (hm) return r.old.code === 4 && r.new.code === 4 && r.fold.code === 4 ? null : `home r309-HALT missing: want exit 4 from all three, got ${r.old.code}/${r.new.code}/${r.fold.code}`;
  if (r.old.ok !== r.new.ok) return `DISAGREE: old ${r.old.ok ? "accepts" : "refuses (" + r.old.why + ")"} · new ${r.new.ok ? "accepts" : "refuses (" + r.new.why + ")"}`;
  if (r.old.ok && !same(r.old.four, r.new.four)) return "both accept but the bytes at home differ";
  if (r.fold.ok !== (r.old.ok && r.new.ok)) return `UNION broken: fold ${r.fold.ok ? "accepts" : "refuses"} while old ${r.old.ok} / new ${r.new.ok}`;
  if (r.fold.ok && !same(r.fold.four, r.old.four)) return "the fold accepts but writes other bytes than the old pull";
  return null;
}

// ── the scenario families ────────────────────────────────────────────────────────────────────────────────────────────────────
const jl = (rows) => rows.map((x) => JSON.stringify(x)).join("\n") + (rows.length ? "\n" : "");
const lines = (b) => B(b).toString("utf8").split("\n").filter((l) => l.length);
const setPath = (o, p, v) => { const ks = p.split("."); let x = o; for (let i = 0; i < ks.length - 1; i++) { if (x[ks[i]] == null || typeof x[ks[i]] !== "object") x[ks[i]] = {}; x = x[ks[i]]; } x[ks[ks.length - 1]] = v; return o; };
const getPath = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
const bump = (v) => (typeof v === "number" ? v + 1 : typeof v === "string" ? v + "x" : v == null ? "set" : Array.isArray(v) ? [...v, 1] : typeof v === "object" ? { ...v, x: 1 } : !v);
function families() {
  const D = Object.fromEntries(FXM.RECORDED.map((R) => [R.day, Object.fromEntries(FXM.readDay(R.day))]));
  const d7 = D["2026-10-07"], d8 = D["2026-10-08"], d9 = D["2026-10-09"], days = { "10-07": d7, "10-08": d8, "10-09": d9 };
  const A = [], Bm = [], C = [];
  // (A) recorded transitions, every ordered pair incl. the empty home
  for (const [hk, h] of [["(empty)", {}], ...Object.entries(days)]) for (const [sk, s] of Object.entries(days)) A.push({ fam: "A", name: `recorded: home ${hk} -> server ${sk}`, home: h, server: s, expect: hk === "(empty)" || hk <= sk ? "accept" : "refuse" });
  // (B) mutations of the recorded files (home = 10-08, server = 10-09 unless named)
  const c8 = d8["r309-cycles.jsonl"], c9 = d9["r309-cycles.jsonl"], L9 = lines(c9), n8 = lines(c8).length;
  for (let i = 0; i < L9.length; i++) { const rows = L9.slice(); const o = JSON.parse(rows[i]); o.pid = (o.pid || 0) + 1; rows[i] = JSON.stringify(o); Bm.push({ fam: "B", name: `cycles row ${i + 1} of ${L9.length} edited on the server (pid+1)`, home: d8, server: { ...d9, "r309-cycles.jsonl": rows.join("\n") + "\n" }, expect: i < n8 ? "refuse" : "accept" }); }
  const lb = (k) => B(L9.slice(0, k).join("\n") + "\n").length;
  for (const k of [n8, n8 + 1, Math.floor((n8 + L9.length) / 2), L9.length]) Bm.push({ fam: "B", name: `cycles cut at the end of row ${k} (a shorter extension)`, home: d8, server: { ...d9, "r309-cycles.jsonl": c9.subarray(0, lb(k)) }, expect: "accept" });
  for (const off of [lb(n8) + 7, lb(n8 + 3) - 2, c9.length - 1, lb(n8) - 1, 100]) Bm.push({ fam: "B", name: `cycles cut mid-row at byte ${off} (a row caught mid-append, or a shorter log)`, home: d8, server: { ...d9, "r309-cycles.jsonl": c9.subarray(0, off) }, expect: "refuse" });
  { const rows = L9.slice(); rows.splice(10, 1); Bm.push({ fam: "B", name: "cycles: a recorded row removed inside home's prefix", home: d8, server: { ...d9, "r309-cycles.jsonl": rows.join("\n") + "\n" }, expect: "refuse" }); }
  { const rows = L9.slice(); rows.splice(5, 0, rows[5]); Bm.push({ fam: "B", name: "cycles: a recorded row duplicated inside home's prefix", home: d8, server: { ...d9, "r309-cycles.jsonl": rows.join("\n") + "\n" }, expect: "refuse" }); }
  Bm.push({ fam: "B", name: "cycles: CRLF line ends on the server", home: d8, server: { ...d9, "r309-cycles.jsonl": c9.toString("utf8").replace(/\n/g, "\r\n") }, expect: "refuse" });
  Bm.push({ fam: "B", name: "cycles: a non-JSON row appended", home: d8, server: { ...d9, "r309-cycles.jsonl": Buffer.concat([c9, B("not json\n")]) }, expect: "refuse" });
  const S8 = JSON.parse(d8["r309-surge-hold48.json"].toString("utf8")), S9 = JSON.parse(d9["r309-surge-hold48.json"].toString("utf8")), sj = (o) => JSON.stringify(o, null, 1);
  for (const [nm, v] of [["null", null], ["'2026-10-09'", "2026-10-09"], ["'2026-10-07'", "2026-10-07"], ["'' (empty)", ""]]) Bm.push({ fam: "B", name: `config.evidenceStart '2026-10-08' at home -> ${nm} on the server`, home: d8, server: { ...d9, "r309-surge-hold48.json": sj(setPath(JSON.parse(sj(S9)), "config.evidenceStart", v)) }, expect: "refuse" });
  Bm.push({ fam: "B", name: "config removed on the server (evidenceStart gone)", home: d8, server: { ...d9, "r309-surge-hold48.json": sj({ ...S9, config: undefined }) }, expect: "refuse" });
  Bm.push({ fam: "B", name: "config.evidenceStart unchanged, other fields changed (asOf, interim) -> the status file moves on", home: d8, server: { ...d9, "r309-surge-hold48.json": sj({ ...S9, asOf: "2026-10-09T23:59:59Z", interim: { note: "x" } }) }, expect: "accept" });
  Bm.push({ fam: "B", name: "evidenceStart null at home (10-07) -> set on the server (10-09) -> accepted (set once)", home: d7, server: d9, expect: "accept" });
  const READ = { at: "2026-11-30T12:00:00Z", verdict: "DID NOT PASS", seal: "a".repeat(64) }, S8r = sj({ ...S8, read: READ });
  Bm.push({ fam: "B", name: "a sealed read at home, the same on the server", home: { ...d8, "r309-surge-hold48.json": S8r }, server: { ...d9, "r309-surge-hold48.json": sj({ ...S9, read: READ }) }, expect: "accept" });
  Bm.push({ fam: "B", name: "a sealed read at home, changed on the server", home: { ...d8, "r309-surge-hold48.json": S8r }, server: { ...d9, "r309-surge-hold48.json": sj({ ...S9, read: { ...READ, verdict: "PASS" } }) }, expect: "refuse" });
  Bm.push({ fam: "B", name: "a sealed read at home, null on the server", home: { ...d8, "r309-surge-hold48.json": S8r }, server: d9, expect: "refuse" });
  Bm.push({ fam: "B", name: "r309-surge-hold48.json torn on the server", home: d8, server: { ...d9, "r309-surge-hold48.json": d9["r309-surge-hold48.json"].subarray(0, 900) }, expect: "refuse" });
  Bm.push({ fam: "B", name: "r309-surge-hold48.json absent on the server while home has it (a json not yet written is skipped)", home: d8, server: { "r309-cycles.jsonl": c9, "r309-ledger.jsonl": d9["r309-ledger.jsonl"] }, expect: "accept" });
  Bm.push({ fam: "B", name: "r309-interim.json appears on the server (valid)", home: d8, server: { ...d9, "r309-interim.json": sj({ at: "2026-11-01T12:00:00Z", days: 20 }) }, expect: "accept" });
  Bm.push({ fam: "B", name: "r309-interim.json on the server is torn", home: d8, server: { ...d9, "r309-interim.json": "{ \"at\": " }, expect: "refuse" });
  Bm.push({ fam: "B", name: "r309-cycles.jsonl absent on the server while home has it", home: d8, server: { "r309-ledger.jsonl": d9["r309-ledger.jsonl"], "r309-surge-hold48.json": d9["r309-surge-hold48.json"] }, expect: "refuse" });
  Bm.push({ fam: "B", name: "r309-ledger.jsonl absent on the server while home has it (home's is recorded EMPTY: still a file)", home: d8, server: { "r309-cycles.jsonl": c9, "r309-surge-hold48.json": d9["r309-surge-hold48.json"] }, expect: "refuse" });
  for (const extra of ["r309-HALT", "r309-OFF", "r309.lock", "r309.flock", "r309-health-alert.json", "data/r309-cycles.jsonl", "TRAIDS_STOP", ".env"]) Bm.push({ fam: "B", name: `tar: an extra entry ${extra}`, home: d8, server: { ...d9, [extra]: "x\n" }, expect: "refuse" });
  { const t = PS.tarOf([{ name: "r309-cycles.jsonl", data: c9 }, { name: "r309-cycles.jsonl", data: c9 }]); Bm.push({ fam: "B", name: "tar: the cycles file twice", home: d8, tar: t, expect: "refuse" }); }
  for (const ty of ["2", "5", "1"]) Bm.push({ fam: "B", name: `tar: the cycles entry of type ${ty} (${{ 2: "symlink", 5: "directory", 1: "hard link" }[ty]})`, home: d8, tar: PS.tarOf([{ name: "r309-cycles.jsonl", data: "", type: ty }]), expect: "refuse" });
  { const t = Buffer.from(tarOf(d9)); t[5] ^= 1; Bm.push({ fam: "B", name: "tar: a header byte corrupted (checksum)", home: d8, tar: t, expect: "refuse" }); }
  { const t = tarOf(d9); Bm.push({ fam: "B", name: "tar: truncated inside the cycles data", home: d8, tar: t.subarray(0, 512 + 4000), expect: "refuse" }); }
  Bm.push({ fam: "B", name: "home r309-HALT missing", home: d8, server: d9, halt: false, expect: "halt" });
  // (C) the lifecycle: every ordered pair of ledger states (with the recorded 10-09 cycles and config on both sides), then field mutations
  const LC = JSON.parse(fs.readFileSync(path.join(FXM.FX, "lifecycle.json"), "utf8")), ST = [{ label: "(empty ledger)", rows: [] }, ...LC.states];
  const withLedger = (rows) => ({ ...d9, "r309-ledger.jsonl": jl(rows) });
  for (let i = 0; i < ST.length; i++) for (let j = 0; j < ST.length; j++) C.push({ fam: "C", name: `lifecycle: home "${ST[i].label}" -> server "${ST[j].label}"`, home: withLedger(ST[i].rows), server: withLedger(ST[j].rows), pair: [i, j] });
  const R = DEF.entries.find((e) => e.path === "r309-ledger.jsonl").rules;
  for (const si of [3, 6, 8, 10]) {   // states with every kind of row: open / submit-error / missed; exiting / unfilled / not-sent; error; all closed
    const base = ST[si].rows;
    base.forEach((row, ri) => {
      const mut = (label, fn, expect) => { const rows = JSON.parse(JSON.stringify(base)); fn(rows[ri]); C.push({ fam: "C", name: `lifecycle "${ST[si].label}", ${row.kind} ${row.id} (${row.status || "-"}): ${label}`, home: withLedger(base), server: withLedger(rows), expect }); };
      if (row.kind !== "lot") { mut("reason edited", (r) => { r.reason += " (edited)"; }, "refuse"); mut("a field added", (r) => { r.extra = 1; }, "refuse"); return; }
      for (const p of R.immutable) mut(`immutable ${p} changed`, (r) => setPath(r, p, bump(getPath(r, p))), "refuse");
      for (const w of R.onceWhenStatus) for (const p of w.fields) mut(`${w.what} field ${p} changed`, (r) => setPath(r, p, bump(getPath(r, p))), w.statuses.includes(row.status) ? "refuse" : "accept");
      mut("twin.net changed", (r) => setPath(r, "twin.net", r.twin.net == null ? -0.002 : r.twin.net + 0.001), row.twin && row.twin.net != null ? "refuse" : "accept");
      mut("a note appended", (r) => { r.notes = [...(r.notes || []), "x"]; }, "accept");
      mut("fees changed", (r) => { r.fees = { ...(r.fees || {}), exit: { usd: 1 } }; }, "accept");
    });
    C.push({ fam: "C", name: `lifecycle "${ST[si].label}": a row removed on the server`, home: withLedger(base), server: withLedger(base.slice(1)), expect: "refuse" });
    C.push({ fam: "C", name: `lifecycle "${ST[si].label}": a row duplicated on the server`, home: withLedger(base), server: withLedger([...base, base[0]]), expect: "refuse" });
    C.push({ fam: "C", name: `lifecycle "${ST[si].label}": a new lot appended on the server`, home: withLedger(base), server: withLedger([...base, { ...JSON.parse(JSON.stringify(base[0])), id: base[0].id + "-n" }]), expect: "accept" });
    C.push({ fam: "C", name: `lifecycle "${ST[si].label}": a torn ledger line on the server`, home: withLedger(base), server: { ...withLedger(base), "r309-ledger.jsonl": jl(base) + "{\"kind\":\"lot\"\n" }, expect: "refuse" });
  }
  return { A, B: Bm, C, ST };
}
/** (D) where the two rule sets DIFFER — pinned known answers (old / new decisions as measured 2026-10-09), each refused by the fold */
function divergences() {
  const cyc = jl([{ ts: "2026-10-09T19:02:05Z", live: true }]), surge = (v, read) => JSON.stringify({ config: { evidenceStart: v }, ...(read === undefined ? {} : { read }) });
  return [
    { id: "D1a", name: "a server ledger row whose id is \"\"", home: {}, server: { "r309-cycles.jsonl": cyc, "r309-ledger.jsonl": jl([{ kind: "missed", id: "", day: "2026-10-09" }]) }, old: "refuse", neu: "accept", why: "pull-r309 refuses a falsy id; pull-server only a missing (null) one" },
    { id: "D1b", name: "a server ledger row whose id is 0", home: {}, server: { "r309-cycles.jsonl": cyc, "r309-ledger.jsonl": jl([{ kind: "missed", id: 0, day: "2026-10-09" }]) }, old: "refuse", neu: "accept", why: "as D1a" },
    { id: "D1c", name: "a server ledger row whose id is false", home: {}, server: { "r309-cycles.jsonl": cyc, "r309-ledger.jsonl": jl([{ kind: "missed", id: false, day: "2026-10-09" }]) }, old: "refuse", neu: "accept", why: "as D1a" },
    { id: "D2", name: "a tar entry named ./r309-cycles.jsonl", home: {}, tar: PS.tarOf([{ name: "./r309-cycles.jsonl", data: cyc }]), old: "refuse", neu: "accept", why: "pull-server strips a leading ./ from tar names; pull-r309 takes names as given (neither remote command emits ./)" },
    { id: "D3", name: "config.evidenceStart 0 at home, a date on the server", home: { "r309-surge-hold48.json": surge(0) }, server: { "r309-cycles.jsonl": cyc, "r309-surge-hold48.json": surge("2026-10-08") }, old: "accept", neu: "refuse", why: "pull-r309 freezes a truthy evidenceStart; pull-server anything but null / false / \"\"" },
    { id: "D4", name: "config.evidenceStart an object, JSON-equal on both sides", home: { "r309-surge-hold48.json": surge({ d: "2026-10-08" }) }, server: { "r309-cycles.jsonl": cyc, "r309-surge-hold48.json": surge({ d: "2026-10-08" }) }, old: "refuse", neu: "accept", why: "pull-r309 compares with !== (two objects always differ); pull-server by JSON" },
    { id: "D5", name: "read 0 at home, 1 on the server", home: { "r309-surge-hold48.json": surge(null, 0) }, server: { "r309-cycles.jsonl": cyc, "r309-surge-hold48.json": surge(null, 1) }, old: "accept", neu: "refuse", why: "as D3, for read" },
    { id: "D6", name: "a lot's twin.net settled at 0, the server's twin replaced by the number 0", home: { "r309-cycles.jsonl": cyc, "r309-ledger.jsonl": jl([{ kind: "lot", id: "r309-BTC-x", status: "open", twin: { net: 0 } }]) }, server: { "r309-cycles.jsonl": cyc, "r309-ledger.jsonl": jl([{ kind: "lot", id: "r309-BTC-x", status: "open", twin: 0 }]) }, old: "accept", neu: "refuse", why: "pull-r309 reads s.twin && s.twin.net (0 && ... = 0, equal to 0); pull-server reads the path (undefined)" },
  ];
}

// ── the proof ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function prove({ list = false } = {}) {
  const res = []; const ok = (n, c, d) => res.push({ n, c: !!c, d });
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "r309fold-parity-"));
  try {
    ok("the parity subjects are the installed files: deploy/server/pull-r309.cjs, deploy/server/pull-server.cjs + manifests/r309.json (four entries, rules present)", typeof PR.applyPull === "function" && typeof PS.applyUnit === "function" && DEF.entries.length === 4 && !!DEF.entries.find((e) => e.kind === "jsonl-rewritten").rules.next);
    const F = families(), tally = {};
    for (const fam of ["A", "B", "C"]) {
      const scs = F[fam], bad = [], t = { n: scs.length, accept: 0, refuse: 0, halt: 0, expectMiss: [] };
      for (const sc of scs) {
        const r = run(sc), why = judge(sc, r), dec = sc.halt === false ? "halt" : r.old.ok ? "accept" : "refuse";
        if (why) bad.push(`${sc.name}: ${why}`);
        t[dec]++;
        if (sc.expect && sc.expect !== dec) t.expectMiss.push(`${sc.name}: expected ${sc.expect}, both ${dec}${r.old.why ? " (" + r.old.why.slice(0, 100) + ")" : ""}`);
        sc.dec = dec; sc.oldWhy = r.old.why;
        if (list) console.log(`  [${fam}] ${dec.padEnd(6)} ${sc.name}${r.old.why ? " — " + r.old.why.slice(0, 110) : ""}`);
      }
      tally[fam] = t;
      const label = { A: "(A) recorded transitions (10-07 / 10-08 / 10-09, every order, from an empty home too)", B: "(B) the recorded files mutated (cycle rows, byte cuts, config / read / interim, missing files, tar level, HALT)", C: "(C) the lot lifecycle in the runner's row shape (every ordered pair of 11 ledger states + every immutable / once-set field)" }[fam];
      ok(`${label}: ${t.n} scenarios — old and new AGREE on all, the SAME BYTES whenever they accept, the fold = both (UNION), refusals write NOTHING, HALT / OFF never touched (${t.accept} accepted, ${t.refuse} refused${t.halt ? `, ${t.halt} HALT exit 4` : ""})`, bad.length === 0, bad.slice(0, 4).join(" | "));
      if (fam !== "C") ok(`${label.split(":")[0].split(" (")[0]} known answers: every scenario decided as written beside it`, t.expectMiss.length === 0, t.expectMiss.slice(0, 4).join(" | "));
    }
    const C = F.C, pairs = C.filter((s) => s.pair), mut = C.filter((s) => !s.pair);
    const fwdRefused = pairs.filter((s) => s.pair[0] < s.pair[1] && s.dec === "refuse"), back = pairs.filter((s) => s.pair[0] > s.pair[1]), diag = pairs.filter((s) => s.pair[0] === s.pair[1]);
    ok("(C) known answers: every field mutation decided as written beside it (immutable -> refused; a fill / close field -> refused once the lot reached that status, accepted before; twin.net -> refused once settled; notes / fees -> accepted)", mut.every((s) => s.dec === s.expect), mut.filter((s) => s.dec !== s.expect).slice(0, 3).map((s) => `${s.name}: ${s.dec}`).join(" | "));
    const backOk = back.filter((s) => s.dec === "accept").map((s) => `${s.pair[0]}->${s.pair[1]}`).join(",");
    ok(`(C) the ledger states: the same state on both sides is accepted (${diag.filter((s) => s.dec === "accept").length}/${diag.length}); every backward pair is refused (${back.filter((s) => s.dec === "refuse").length}/${back.length}) except exactly 9->8 — "D exiting" at home, "D error" on the server: exiting -> error is a legal move (error and exiting may alternate, runner N13)`, diag.every((s) => s.dec === "accept") && backOk === "9->8", backOk);
    // the pre-existing rule both sides share: a lot seen at home before its fill cannot be pulled once it has moved past "open" (NEXT is not
    // transitive). Pinned so a change to either rule set shows here.
    const fr = fwdRefused.map((s) => `${s.pair[0]}->${s.pair[1]}`).join(",");
    ok(`(C) forward jumps BOTH rule sets refuse (pull-r309.cjs's NEXT table is not transitive — e.g. submitted -> closed; unchanged here, NOTES "found"): exactly ${fwdRefused.length} of ${pairs.filter((s) => s.pair[0] < s.pair[1]).length} forward pairs (${fr})`, fwdRefused.length === FWD_REFUSED.length && fr === FWD_REFUSED.join(","), fr);
    // (D) the divergences, pinned
    const DV = divergences(), dres = DV.map((d) => { const r = run(d); return { d, r }; });
    for (const { d, r } of dres) ok(`(D) ${d.id} ${d.name}: old ${d.old}s, new ${d.neu}s (${d.why}) — the FOLD REFUSES; nothing written by any refusal; HALT / OFF untouched`, (r.old.ok ? "accept" : "refuse") === d.old && (r.new.ok ? "accept" : "refuse") === d.neu && !r.fold.ok && r.fold.code === 1 && ["old", "new", "fold"].every((k) => r[k].ok || same(r[k].four, r.init)) && ["old", "new", "fold"].every((k) => OTHERS_OK(r[k])), JSON.stringify({ old: r.old.why, new: r.new.why, fold: r.fold.why }));
    ok("(D) the fold names who refused: 'guard' where only pull-r309.cjs's rules refuse (D1, D2, D4), pull-server's message where pull-server refuses (D3, D5, D6)", dres.every(({ d, r }) => (d.old === "refuse" ? r.fold.kind === "guard" : r.fold.kind === "refused")), dres.map(({ d, r }) => `${d.id}:${r.fold.kind}`).join(","));
    const recordedRows = Object.values(F.ST).flatMap((s) => s.rows), recIds = recordedRows.filter((r) => r.kind).map((r) => r.id);
    ok("(D) none of the divergence inputs is something the runner writes: every lifecycle id is a non-empty 'r309-<COIN>-<YYYYMMDDHH>' string, every recorded evidenceStart null or a date, every read null", recIds.every((x) => typeof x === "string" && /^r309-(BTC|ETH)-\d{10}$/.test(x)) && ["2026-10-07", "2026-10-08", "2026-10-09"].every((dy) => { const j = JSON.parse(FXM.readDay(dy).get("r309-surge-hold48.json").toString("utf8")); return (j.config.evidenceStart === null || /^\d{4}-\d\d-\d\d$/.test(j.config.evidenceStart)) && j.read == null; }), recIds.slice(0, 4).join(","));
    const total = F.A.length + F.B.length + F.C.length + DV.length;
    res.summary = { total, A: tally.A, B: tally.B, C: tally.C, D: DV.length, forwardRefused: fwdRefused.map((s) => `${s.pair[0]}->${s.pair[1]}`) };
  } finally { fs.rmSync(ROOT, { recursive: true, force: true }); ROOT = null; }
  return res;
}
/** the forward pairs (home state -> server state, indexes into "(empty ledger)" + lifecycle.json's 10 states) that BOTH rule sets refuse:
 *  a lot home last saw before "open" (submitting / submitted) that the VPS has since moved to exiting / error / closed (the NEXT table
 *  lists only one step from an entry state). Measured 2026-10-09 on the installed files; a change of either rule set changes this list. */
const FWD_REFUSED = ["1->5", "1->6", "1->7", "1->8", "1->9", "1->10", "2->5", "2->6", "2->7", "2->8", "2->9", "2->10", "6->8", "6->9", "6->10"];

if (require.main === module) {
  const a = process.argv.slice(2);
  if (!(a.length === 0 || (a.length === 1 && ["--selftest", "--list"].includes(a[0])))) { console.log("usage: node parity.cjs [--selftest | --list]"); process.exitCode = 2; }
  else {
    const res = prove({ list: a[0] === "--list" });
    for (const x of res) console.log(`  ${x.c ? "ok  " : "FAIL"} ${x.n}${!x.c && x.d ? " — " + String(x.d).slice(0, 600) : ""}`);
    const bad = res.filter((x) => !x.c).length;
    if (res.summary) console.log(`parity: ${res.summary.total} scenarios (A ${res.summary.A.n}, B ${res.summary.B.n}, C ${res.summary.C.n}, D ${res.summary.D})`);
    console.log(`parity selftest: ${res.length - bad} passed, ${bad} failed`);
    process.exitCode = bad ? 1 : 0;
  }
}
module.exports = { prove, run, judge, families, divergences, FWD_REFUSED };
