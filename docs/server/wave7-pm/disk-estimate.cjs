#!/usr/bin/env node
/**
 * DISK ESTIMATE — how much the R352 recorder writes a day, from MEASURED sizes (docs/server/wave7-pm/probe-2026-10-12.json: the two
 * builder probes, sizes and counts only) and the scout's one measured rate of Kalshi prints. Read-only arithmetic; no network.
 *
 *   node docs/server/wave7-pm/disk-estimate.cjs           the table, per stream: plain bytes a day, the gzip ratio, archived bytes a day
 *   node docs/server/wave7-pm/disk-estimate.cjs --json
 *   node docs/server/wave7-pm/disk-estimate.cjs --pull [days]   what the home pull of this unit costs with that many recorded days (35)
 *
 * HOW EACH LINE IS MADE (nothing is assumed where a measurement exists):
 *   pm5/ws, k15/book, spot/ws   bytes written between the first and the last data row of the probe, per second, x 86,400; the mean of
 *                               the probes. These streams run all day.
 *   pm5/tape                    the bytes of ONE closed 5-minute window's whole tape (each probe paged one to the end) x 288 windows.
 *   k15/tape                    bytes a print (measured) x the scout's prints a second (7,394 in 120 s) x 86,400. The probes read only
 *                               two pages of a Kalshi tape by design, so this line rests on the scout's two minutes.
 *   pm5/ref, k15/ref            the measured bytes of one market-record row x the rows a window gets (Polymarket 3: before, after the
 *                               close, once more if not yet resolved; Kalshi 4) x the windows a day.
 *   gzip                        each stream's own ratio in the probes (level 6, the recorder's setting).
 * WHAT IT IS NOT: a weekday figure. Both probes and the scout ran on a Sunday evening and night, US time. The first full day on the
 * server gives the real one: `node backend/pm-book-recorder.js --status` there prints bytes an hour per stream and the hours left
 * before the disk guard.
 */
"use strict";
const fs = require("fs"), path = require("path");
const GiB = 1024 ** 3, DAY_S = 86400;
const sum = (a) => a.reduce((x, y) => x + y, 0), mean = (a) => sum(a) / a.length;

function estimate(P = JSON.parse(fs.readFileSync(path.join(__dirname, "probe-2026-10-12.json"), "utf8"))) {
  const pr = P.probes, S = (p, s) => p.streams[s], ratio = (s) => sum(pr.map((p) => S(p, s).bytes)) / sum(pr.map((p) => S(p, s).gz6Bytes)), rows = {};
  for (const s of ["pm5/ws", "k15/book", "spot/ws"]) { const per = pr.map((p) => (S(p, s).bytes / (S(p, s).spanMs / 1000)) * DAY_S); rows[s] = { plain: mean(per), perProbe: per, ratio: ratio(s), basis: `${pr.map((p) => `${S(p, s).bytes} B in ${(S(p, s).spanMs / 1000).toFixed(1)} s`).join("; ")} -> a day` }; }
  { const done = pr.filter((p) => p.tapeReads.pm5.length && p.tapeReads.pm5.every((t) => t.done === true)), per = done.map((p) => S(p, "pm5/tape").bytes * 288); rows["pm5/tape"] = { plain: mean(per), perProbe: per, ratio: ratio("pm5/tape"), basis: `one closed window's whole tape (${done.map((p) => `${p.tapeReads.pm5[0].rows} prints, ${S(p, "pm5/tape").bytes} B`).join("; ")}) x 288 windows` }; }
  { const tr = pr.map((p) => S(p, "k15/tape").kinds.tr), bpp = sum(tr.map((x) => x.bytes)) / sum(tr.map((x) => x.rows)), pps = P.scout.k15Prints / P.scout.k15PrintSeconds; rows["k15/tape"] = { plain: bpp * pps * DAY_S, perProbe: [], ratio: ratio("k15/tape"), basis: `${bpp.toFixed(0)} B a print (measured) x ${pps.toFixed(1)} prints a second (the scout: ${P.scout.k15Prints} in ${P.scout.k15PrintSeconds} s) x 86,400` }; }
  { const mk = pr.map((p) => S(p, "pm5/ref").kinds.mk), b = sum(mk.map((x) => x.bytes)) / sum(mk.map((x) => x.rows)); rows["pm5/ref"] = { plain: b * 3 * 288, perProbe: [], ratio: ratio("pm5/ref"), basis: `${b.toFixed(0)} B a market-record row x 3 rows a window x 288` }; }
  { const mk = pr.map((p) => S(p, "k15/ref").kinds.mk), b = sum(mk.map((x) => x.bytes)) / sum(mk.map((x) => x.rows)); rows["k15/ref"] = { plain: b * 4 * 96, perProbe: [], ratio: ratio("k15/ref"), basis: `${b.toFixed(0)} B a market-record row x 4 rows a window x 96` }; }
  for (const r of Object.values(rows)) r.gz = r.plain / r.ratio;
  return { rows, plainPerDay: sum(Object.values(rows).map((r) => r.plain)), gzPerDay: sum(Object.values(rows).map((r) => r.gz)), probes: pr.map((p) => ({ id: p.id, startedUtc: p.startedUtc, seconds: p.seconds })) };
}

/**
 * WHAT THE HOME PULL OF THIS UNIT COSTS, measured here: the standing pull-server.cjs run against the package's fake VPS holding `days`
 * final day-summaries shaped like the recorder's (48 archive entries with both hashes, both venues' coverage with 40 windows listed
 * as not captured), the status file and the live marker. Local work only (the tar, the parse, the checks, the renames) — the one ssh
 * round trip is not in it.
 */
function pullCost(days = 35) {
  const os = require("os"), crypto = require("crypto"), L = require(path.join(__dirname, "w7-lib.cjs")), { PS, OWN } = L;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w7-pullcost-")), V = L.fakeVps();
  try {
    fs.mkdirSync(path.join(tmp, "manifests")); fs.copyFileSync(path.join(__dirname, "manifests", "w7-pm.json"), path.join(tmp, "manifests", "w7-pm.json"));
    const mapFile = path.join(tmp, "host-ownership.json"); OWN.writeMap(mapFile, { schema: "host-ownership-v1", units: { [L.UNIT]: "server" }, updatedAt: "x", history: [] });
    const h = () => crypto.randomBytes(32).toString("hex"), arch = (n) => ({ plainSha256: h(), plainBytes: n, gzSha256: h(), gzBytes: Math.round(n / 9.4) });
    const cov = (n, min) => ({ windows: n, captured: n - 40, minCaptured: min, qualifies: true, pending: 0, final: true, reasons: { "book feed silent for more than 5 s": 25, "spot gap longer than 10 s": 15 }, spot: { tradeQuietWindows: 3, capturedIfTradeQuietCounted: n - 43, tradeIdBreaks: 2, qualifiesIfTradeQuietCounted: true, gateReads: "x".repeat(230) },
      notCaptured: [{ why: "book feed silent for more than 5 s", n: 25, w: Array.from({ length: 25 }, (_, i) => 1791936000 + i * 300).join(",") }, { why: "spot gap longer than 10 s", n: 15, w: Array.from({ length: 15 }, (_, i) => 1791946000 + i * 300).join(",") }] });
    let bytes = 0;
    for (let i = 0; i < days; i++) {
      const date = new Date(Date.parse("2026-10-13T00:00:00Z") + i * 86400000).toISOString().slice(0, 10), archives = {}, streams = {};
      for (let k = 1; k <= 36; k++) archives[`pm5/ws.${String(k).padStart(4, "0")}.jsonl.gz`] = arch(268435612);
      for (const k of ["pm5/tape.0001", "pm5/ref.0001", "k15/book.0001", "k15/ref.0001", "spot/ws.0001", "meta/clock.0001", "k15/tape.0001", "k15/tape.0002", "k15/tape.0003", "k15/tape.0004", "k15/tape.0005", "k15/tape.0006"]) archives[k + ".jsonl.gz"] = arch(95210344);
      for (const k of ["pm5/ws", "pm5/tape", "pm5/ref", "k15/book", "k15/tape", "k15/ref", "spot/ws", "meta/clock"]) streams[k] = { rows: 51234567, gaps: 12, bytes: 9876543210, gzBytes: 1034567890, lastRx: 1791936000000, parts: 36, compressed: 36, torn: 0 };
      const b = Buffer.from(JSON.stringify({ schema: "pm-book-summary-v1", date, generatedAt: date + "T00:52:10.000Z", version: "2026-10-11.1", final: true, closed: true, plainFilesLeft: 0, streams, archives, coverage: { pm5: cov(288, 231), k15: cov(96, 77) }, note: "x".repeat(210) }, null, 1));
      bytes += b.length; V.put(`${L.PM}/summary/${date}.json`, b);
    }
    V.put(L.PM + "/status.json", JSON.stringify({ schema: "pm-book-status-v1", asOf: "2026-11-16T00:00:00.000Z", pad: "x".repeat(2600) })); V.put(L.PM + "/live.json", JSON.stringify({ schema: "pm-book-live-v1", liveAt: "2026-10-12T18:00:25.000Z" }));
    const run = () => { const t = process.hrtime.bigint(), c0 = V.S.calls.length, r = PS.pullWave(L.WAVE, { homeDir: tmp, manifestDir: path.join(tmp, "manifests"), ssh: V.ssh, mapFile, haltFile: mapFile, writeStatusFile: false }); return { ms: Number(process.hrtime.bigint() - t) / 1e6, exit: r.exit, sshCalls: V.S.calls.length - c0 }; };
    const cold = run(), warm = [run(), run(), run()].sort((a, b) => a.ms - b.ms)[1];
    return { days, summaryBytes: bytes, bytesPerDay: Math.round(bytes / days), cold, warm };
  } finally { V.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (require.main === module && process.argv.includes("--pull")) {
  const n = Number(process.argv[process.argv.indexOf("--pull") + 1]) || 35, c = pullCost(n);
  console.log(`the home pull of w7-pm with ${c.days} recorded days on the server: ${c.summaryBytes} bytes of day summaries (${c.bytesPerDay} a day), sent whole as one tar on every pull, plus the status file and the live marker`);
  console.log(`  first pull (home has none):  exit ${c.cold.exit}, ${c.cold.sshCalls} ssh call, ${c.cold.ms.toFixed(0)} ms of work on this PC`);
  console.log(`  every later pull (no change): exit ${c.warm.exit}, ${c.warm.sshCalls} ssh call, ${c.warm.ms.toFixed(0)} ms of work on this PC`);
  console.log("  not in these figures: the ssh round trip itself (one call; the close chain allows the pull step 5 minutes)");
} else if (require.main === module) {
  const E = estimate();
  if (process.argv.includes("--json")) console.log(JSON.stringify(E, null, 1));
  else {
    const g = (b) => (b / GiB).toFixed(b / GiB < 0.1 ? 3 : 2).padStart(7), L = require(path.join(__dirname, "w7-lib.cjs")), D = L.DISK;
    console.log(`R352 recorder — bytes a day, from the probes of ${E.probes.map((p) => `${p.startedUtc.slice(0, 16)}Z (${p.seconds} s)`).join(" and ")}\n`);
    console.log(`  ${"stream".padEnd(10)} ${"plain GiB".padStart(9)} ${"gzip".padStart(6)} ${"archived GiB".padStart(12)}   how`);
    for (const [s, r] of Object.entries(E.rows)) console.log(`  ${s.padEnd(10)} ${g(r.plain).padStart(9)} ${(r.ratio.toFixed(1) + "x").padStart(6)} ${g(r.gz).padStart(12)}   ${r.basis}`);
    console.log(`  ${"TOTAL".padEnd(10)} ${g(E.plainPerDay).padStart(9)} ${((E.plainPerDay / E.gzPerDay).toFixed(1) + "x").padStart(6)} ${g(E.gzPerDay).padStart(12)}   a quiet-hours day; a weekday is not measured yet`);
    console.log(`\n  the deploy's precheck works with ${(D.plainPerDay / GiB).toFixed(1)} GiB plain and ${(D.gzPerDay / GiB).toFixed(1)} GiB archived a day (the measured figures plus ${Math.round((D.plainPerDay / E.plainPerDay - 1) * 100)}% and ${Math.round((D.gzPerDay / E.gzPerDay - 1) * 100)}%):`);
    console.log(`    refuses under ${(D.needBytes(D.floorDays) / GiB).toFixed(1)} GiB free = the 5 GiB guard + 2 plain days + ${D.floorDays} archived days`);
    console.log(`    says so loudly under ${(D.needBytes(D.spanDays) / GiB).toFixed(1)} GiB free = the guard + 2 plain days + ${D.spanDays} archived days (the 30-day span and its lead)`);
    console.log(`    30 archived days alone: ${((30 * E.gzPerDay) / GiB).toFixed(1)} GiB at the measured rate`);
  }
}
module.exports = { estimate, pullCost };
