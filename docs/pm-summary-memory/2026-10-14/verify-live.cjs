#!/usr/bin/env node
"use strict";
/**
 * PM SUMMARY MEMORY (2026-10-14) — VERIFY LIVE, on the VPS, over ssh (the ssh helper W7 uses: deploy/server/pull-server.cjs sshReal).
 *
 *   node docs/pm-summary-memory/2026-10-14/verify-live.cjs [--date YYYY-MM-DD]           READ-ONLY: judges the LAST run of the nightly unit:
 *        the one systemd recorded (systemctl show: when it began and ended, its Result — no sudo, no journal group needed) and the journal
 *        lines inside that span (read through `sudo -n journalctl` when sudo allows it, else as traids, who sees the node lines of its
 *        User=traids unit but not systemd's own lines without the adm / systemd-journal group). Only when systemd's record cannot be read:
 *        the last run whose 'Starting' line is in the journal of the last 30 hours
 *   node docs/pm-summary-memory/2026-10-14/verify-live.cjs --start [--date YYYY-MM-DD]   the ONE action this script may take: it starts the
 *        nightly unit ONCE — `sudo -n systemctl start traids-pm-nightly.service`, which runs its two steps (--compress closed, then
 *        --summarize recent) and returns when they are done — then judges THAT run. Refused between 00:20 and 01:20 UTC (the unit's own
 *        timer fires at 00:40), while the unit is already active, and while the VPS does not hold the staged recorder (the old code would
 *        only run out of memory again). Every read is fail-closed: an ssh failure is UNKNOWN, never a pass.
 * --date: the day whose summary must have been written (default 2026-10-13, the day of the failed run).
 *
 * ONE LINE EACH, PASS / FAIL / UNKNOWN:
 *   code       the VPS's backend/pm-book-recorder.js is the staged file and backend/lib/pm-feeds.js the (unchanged) base one
 *   run        the nightly run ended well (systemd's own result: systemctl start's answer, or systemctl show's record of the last run;
 *              the journal's Finished / Failed lines when it can see them)
 *   summary    data/pm-book/summary/<date>.json is there, a pm-book-summary-v1 of that day, written by this run: newer than the run's
 *              start AND the run's journal has its 'summary <date>:' line (without that line: UNKNOWN). A summary that was FINAL before the
 *              run began passes, saying NOT EXERCISED by this run (a final summary is never written again)
 *   heap peak  the run's own "summarize memory: peak heap X MiB ... heap limit Y MiB" line: PASS under 256 MiB and under half the limit,
 *              and only from a run that summarized a day (a 'summary <day>:' line): --summarize prints its memory line even when it had
 *              no day to summarize, and then this line is UNKNOWN — so ALL PASS always means the bounded summary ran on a day
 *   no OOM     no "heap out of memory" / "Reached heap limit" / "Allocation failed" / oom-kill in the run's journal
 *   recorder   traids-pm-book.service is the SAME process before and after (pid, start time; read-only mode: it has run since before the
 *              nightly run began) — nothing was restarted
 *   health     the recorder's own --health on the VPS says PASS
 * Exit 0 every line PASS · 1 a line FAILS · 3 no FAIL but a line UNKNOWN · 2 refused or usage.
 * It writes nothing at home and nothing on the VPS but what the nightly unit itself writes when --start starts it.
 */
const path = require("path");
const D = require("./deploy.cjs");
const L = require(path.join(D.REPO, "docs", "server", "wave7-pm", "w7-lib.cjs"));
const NIGHTLY = D.NIGHTLY, SERVICE = L.SERVICE, START_TIMEOUT_MS = (3 * 3600 + 15 * 60) * 1000;
/** the scripts this package sends; each starts "# pmsm:<name>". Only start-nightly changes anything (it starts the nightly unit) */
const SCRIPTS = Object.freeze({
  startNightly: () => `# pmsm:start-nightly\nsudo -n systemctl start ${NIGHTLY}; echo "START rc=$? $(systemctl is-active ${NIGHTLY}) $(systemctl show ${NIGHTLY} -p Result --value)"`,
  // the unit's journal, read-only: as root through `sudo -n journalctl` when sudo allows it (as docs/server/phase0-golive reads unit
  // journals) — systemd's own Starting / Finished / Failed lines are in the SYSTEM journal, which user traids reads only from the adm
  // or systemd-journal group — else as traids (the node lines of a User=traids unit: its own journal). "@@JRC <rc> root|user"
  journal: (sinceSec) => { const j = `journalctl -u ${NIGHTLY} --since @${Math.floor(sinceSec)} --no-pager -o short-unix -n 600`; return `# pmsm:journal\no=$(sudo -n ${j} 2>/dev/null); rc=$?; as=root\nif [ $rc -ne 0 ]; then o=$(${j} 2>&1); rc=$?; as=user; fi\nprintf '%s\\n' "$o"; echo "@@JRC $rc $as"`; },
  // the units' state; for the nightly also systemd's own record of its LAST run — when it began (InactiveExitTimestamp), when it last
  // went inactive or failed (InactiveEnterTimestamp) and its Result — which needs neither sudo nor a journal group (its own line:
  // a systemctl without --timestamp=unix, older than 248, prints nothing there and the ActiveState above still reads)
  show: () => `# pmsm:show\necho "@@BOOK"; systemctl show ${SERVICE} -p MainPID -p ActiveState; echo "@@NIGHTLY"; systemctl show ${NIGHTLY} -p ActiveState -p Result; systemctl show ${NIGHTLY} --timestamp=unix -p InactiveExitTimestamp -p InactiveEnterTimestamp 2>/dev/null; echo "@@END"`,
  summary: (date) => `# pmsm:summary\ncat -- ${L.q(L.PM + "/summary/" + date + ".json")} 2>/dev/null || echo "@@ABSENT"`,
});
const OOM_RE = /JavaScript heap out of memory|Reached heap limit|Allocation failed|oom-kill|Out of memory: Killed/i;
const STARTING_RE = /systemd\[\d+\]: Starting (traids-pm-nightly\.service|TRAIDS W7 pm-book nightly)/;
const MEM_RE = /summarize memory: peak heap ([\d.]+) MiB in use \(sampled every (\d+) ms\), peak resident ([\d.]+) MiB, heap limit ([\d.]+) MiB/;

// ── pure parts (the selftest gives them known answers) ─────────────────────────────────────────────────────────────────────────
/** a journal in short-unix form -> the runs in it, oldest first: [{ startSec, lines: [{ t, text }] }] (lines before the first start go to a run with startSec null) */
function runsOf(text) {
  const runs = []; let cur = null;
  for (const raw of String(text).split("\n")) {
    const m = /^(\d+(?:\.\d+)?) (.*)$/.exec(raw.trim()); if (!m) continue;
    const t = Number(m[1]), body = m[2];
    if (STARTING_RE.test(body)) { cur = { startSec: t, lines: [] }; runs.push(cur); }
    else if (!cur) { cur = { startSec: null, lines: [] }; runs.push(cur); }
    cur.lines.push({ t, text: body });
  }
  return runs;
}
/** one run's facts from its lines */
function judgeRun(run) {
  if (!run) return { found: false };
  const all = run.lines.map((l) => l.text), joined = all.join("\n");
  const mem = all.map((l) => MEM_RE.exec(l)).filter(Boolean).pop() || null;
  const finished = all.some((l) => /systemd\[\d+\]: (Finished (traids-pm-nightly\.service|TRAIDS W7 pm-book nightly)|traids-pm-nightly\.service: Deactivated successfully)/.test(l));
  const failed = all.some((l) => /traids-pm-nightly\.service: (Failed with result|Main process exited, code=(exited, status=[1-9]|killed|dumped))/.test(l)) || all.some((l) => /systemd\[\d+\]: Failed to start (traids-pm-nightly\.service|TRAIDS W7 pm-book nightly)/.test(l));
  return { found: true, startSec: run.startSec, finished, failed, oom: OOM_RE.test(joined), memory: mem ? { heapPeakMiB: Number(mem[1]), everyMs: Number(mem[2]), rssPeakMiB: Number(mem[3]), heapLimitMiB: Number(mem[4]) } : null,
    summaries: all.map((l) => /: (summary \d{4}-\d{2}-\d{2}: .*)$/.exec(l)).filter(Boolean).map((m) => m[1]), consumed: (all.map((l) => /Consumed (.*)$/.exec(l)).filter(Boolean).pop() || [])[1] || null, lines: all.length };
}
/**
 * systemd's own record of the nightly unit's LAST run, from the show script's nightly part -> { startSec, endSec, active, result } or
 * null (never run, or no --timestamp=unix). startSec = InactiveExitTimestamp (the run began: it left inactive); endSec =
 * InactiveEnterTimestamp when that is not before the start and the unit is inactive or failed again (the run ended), else null (a
 * oneshot reads 'activating' for the whole of its run, and InactiveEnterTimestamp is then the END OF THE RUN BEFORE).
 */
function unitRunOf(n) {
  if (!n) return null;
  const at = (v) => { const m = /^@(\d+)$/.exec(String(v == null ? "" : v).trim()); return m ? Number(m[1]) : null; };
  const startSec = at(n.InactiveExitTimestamp), enterSec = at(n.InactiveEnterTimestamp);
  if (startSec == null) return null;
  const ended = enterSec != null && enterSec >= startSec && (n.ActiveState === "inactive" || n.ActiveState === "failed");
  return { startSec, endSec: ended ? enterSec : null, active: n.ActiveState || "?", result: n.Result || null };
}
/** the journal lines of the run systemd recorded (a second's slack before its start, five after its end: the journal's times are finer) */
function linesOfRun(runs, un) { return runs.flatMap((x) => x.lines).filter((l) => l.t >= un.startSec - 1 && (un.endSec == null || l.t <= un.endSec + 5)); }
/** the show script's answer -> { book: { MainPID, ActiveState }, nightly: { ActiveState, Result, InactiveExitTimestamp?, InactiveEnterTimestamp? } } */
function parseShow(out) {
  const o = String(out), part = (a, b) => { const m = new RegExp(`@@${a}\\n([\\s\\S]*?)\\n@@${b}`).exec(o); const r = {}; if (m) for (const l of m[1].split("\n")) { const x = /^([A-Za-z]+)=(.*)$/.exec(l.trim()); if (x) r[x[1]] = x[2]; } return m ? r : null; };
  return { book: part("BOOK", "NIGHTLY"), nightly: part("NIGHTLY", "END") };
}
/** the summary file's text -> what it says, or why it is not one */
function parseSummary(text, date) {
  if (text == null) return { state: "unknown", why: "not read" };
  if (/^@@ABSENT\s*$/.test(String(text))) return { state: "absent" };
  let j; try { j = JSON.parse(String(text)); } catch { return { state: "bad", why: "does not parse" }; }
  if (!j || j.schema !== "pm-book-summary-v1" || j.date !== date) return { state: "bad", why: `not a pm-book-summary-v1 of ${date}` };
  return { state: "ok", generatedAt: j.generatedAt, final: j.final === true, version: j.version, pm5: j.coverage && j.coverage.pm5 ? `${j.coverage.pm5.captured}/${j.coverage.pm5.windows}` : "?", k15: j.coverage && j.coverage.k15 ? `${j.coverage.k15.captured}/${j.coverage.k15.windows}` : "?" };
}
/**
 * The verdict lines from the facts: { code, run, startOut, unit, summary, before, after, health, started } -> [{ name, v, text }].
 * code: { recorder, feeds } shas on the VPS; run: judgeRun(...); startOut: parseStart of the start script (with --start) or null;
 * unit: unitRunOf(...) of the show script (read-only mode: systemd's record of the last run; ignored when startOut is there);
 * before / after: { pid, startedAt, mainPid, active } of the recorder; health: parseHealth(...).
 */
function verdicts(f) {
  const out = [], add = (name, v, text) => out.push({ name, v, text });
  const st = D.FILES.find((x) => x.rel === "backend/pm-book-recorder.js"), lf = D.FILES.find((x) => x.rel === "backend/lib/pm-feeds.js");
  if (!f.code) add("code", "UNKNOWN", "the code on the VPS could not be read");
  else add("code", f.code.recorder === st.stagedSha && f.code.feeds === lf.stagedSha ? "PASS" : "FAIL", `backend/pm-book-recorder.js ${String(f.code.recorder).slice(0, 12)} (${f.code.recorder === st.stagedSha ? "the staged file" : f.code.recorder === st.baseSha ? "the OLD file: deploy.cjs --apply has not reached the VPS" : "neither base nor staged"}), lib/pm-feeds.js ${String(f.code.feeds).slice(0, 12)} (${f.code.feeds === lf.stagedSha ? "unchanged, as built" : "NOT the library this was built against"})`);
  // how the run ended, by its best witness: systemctl start's own answer (--start), else systemd's record of the last run (read-only
  // mode: the show script, no sudo, no journal group needed), else the journal's systemd lines
  const r = f.run || { found: false }, so = f.startOut, un = so ? null : f.unit || null, isoS = (sec) => new Date(sec * 1000).toISOString().slice(0, 19) + "Z";
  const endOk = so ? so.rc === 0 && so.result === "success" : un ? un.endSec != null && un.result === "success" && !r.failed : !!(r.finished && !r.failed);
  const endBad = so ? so.rc !== 0 || !!(so.result && so.result !== "success") : un ? (un.endSec != null && !!un.result && un.result !== "success") || !!r.failed : !!r.failed;
  const endResult = so ? so.result : un ? un.result : null, ranOk = so ? so.rc === 0 : un ? un.endSec != null && un.result === "success" : r.finished;
  if (!r.found && !so && !un) add("run", "UNKNOWN", "no run of the nightly unit in the journal read, and systemd's own record of its last run could not be read");
  else add("run", endOk ? "PASS" : endBad ? "FAIL" : "UNKNOWN", `${so ? `systemctl start returned ${so.rc}, the unit ${so.active}, result ${so.result || "?"}` : un ? `${un.endSec != null ? `systemd: the last run began ${isoS(un.startSec)} and ended ${isoS(un.endSec)}, result ${un.result || "?"}` : `systemd: the last run began ${isoS(un.startSec)} and is ${un.active}: it has not ended`}${r.failed ? "; the journal says it FAILED" : ""}` : r.finished ? "the journal says it finished" : r.failed ? "the journal says it FAILED" : "the journal shows no end of it"}${r.found ? ` · ${r.summaries.length ? r.summaries.join(" | ") : "no 'summary <day>:' line"}${r.consumed ? ` · systemd: ${r.consumed}` : ""}` : ""}`);
  // the summary: written by THIS run only when the file is newer than the run's start AND the run's journal has its 'summary <date>:'
  // line; a summary that was FINAL before the run began passes (a final summary is never written again) but says the run did not exercise it
  const s = f.summary || { state: "unknown" }, startMs = f.runStartMs, dayLine = r.found ? r.summaries.find((x) => x.startsWith(`summary ${f.date}:`)) || null : null;
  if (s.state === "ok") { const fresh = startMs != null && Date.parse(s.generatedAt) >= startMs - 60000;
    add("summary", fresh ? (dayLine ? "PASS" : "UNKNOWN") : s.final ? "PASS" : "FAIL", `summary/${f.date}.json: generated ${s.generatedAt}${fresh ? (dayLine ? " by this run (its journal: '" + dayLine.slice(0, 90) + "')" : ` after this run began, but ${r.found ? `the run's journal has no 'summary ${f.date}:' line` : "the run's journal was not read"}: not shown that this run wrote it`) : s.final ? `${startMs == null ? " (the run's start is not known)" : " — FINAL already before this run began"}: NOT EXERCISED by this run (a final summary is never written again)` : startMs == null ? " (the run's start is not known)" : " — BEFORE this run began: the run did not write it"}; final ${s.final}; pm5 ${s.pm5}, k15 ${s.k15} captured; version ${s.version}`); }
  else add("summary", s.state === "absent" ? (r.found || so ? "FAIL" : "UNKNOWN") : s.state === "bad" ? "FAIL" : "UNKNOWN", `summary/${f.date}.json: ${s.state === "absent" ? "NOT on the VPS" : s.why || s.state}`);
  // the heap peak shows the bounded summary only from a run that summarized a day: --summarize prints its memory line even when it
  // had no day to summarize
  const m = r.memory;
  if (!m) add("heap peak", "UNKNOWN", r.found ? "the run printed no 'summarize memory:' line (the old code prints none; a run that died before its end prints none)" : "no run read");
  else { const within = m.heapPeakMiB < 256 && m.heapPeakMiB < m.heapLimitMiB / 2, words = `peak heap ${m.heapPeakMiB} MiB in use (sampled every ${m.everyMs} ms) of a ${m.heapLimitMiB} MiB limit; peak resident ${m.rssPeakMiB} MiB`;
    add("heap peak", !within ? "FAIL" : r.summaries.length ? "PASS" : "UNKNOWN", within && !r.summaries.length ? `${words} — but the run summarized NO day (no 'summary <day>:' line): this peak does not show the summary on a full day` : words); }
  if (!r.found) add("no OOM", "UNKNOWN", "no run read");
  else add("no OOM", r.oom || endResult === "oom-kill" ? "FAIL" : ranOk ? "PASS" : "UNKNOWN", r.oom ? "the run's journal says it ran out of memory" : endResult === "oom-kill" ? "systemd says the run was killed for memory (result oom-kill)" : `no out-of-memory line in the run's ${r.lines} journal line(s)`);
  const b = f.before, a = f.after;
  if (!a || a.pid == null) add("recorder", "UNKNOWN", "the recorder's status could not be read");
  else if (b) add("recorder", b.pid === a.pid && b.startedAt === a.startedAt && String(b.mainPid) === String(a.mainPid) && a.active === "active" ? "PASS" : "FAIL", `${SERVICE}: pid ${b.pid} -> ${a.pid}, started ${b.startedAt} -> ${a.startedAt}, systemd MainPID ${b.mainPid} -> ${a.mainPid}, ${a.active}`);
  else { const since = Date.parse(a.startedAt), ok = String(a.pid) === String(a.mainPid) && a.active === "active" && startMs != null && since <= startMs; add("recorder", ok ? "PASS" : startMs != null && since > startMs ? "FAIL" : "UNKNOWN", `${SERVICE}: pid ${a.pid} (systemd MainPID ${a.mainPid}, ${a.active}), running since ${a.startedAt}${startMs != null ? (since <= startMs ? " — before the nightly run began: not restarted by it" : " — AFTER the nightly run began: it was restarted") : ""}`); }
  const h = f.health; add("health", !h || !h.verdict ? "UNKNOWN" : h.verdict, h && h.verdict ? `the recorder's --health on the VPS: ${h.verdict}${h.lines && h.lines.length ? " — " + h.lines.join(" | ").slice(0, 300) : ""}` : "no verdict read");
  return out;
}
const exitOf = (vs) => (vs.some((x) => x.v === "FAIL") ? 1 : vs.some((x) => x.v !== "PASS") ? 3 : 0);

// ── the reads and the one action, on an injected ssh (the selftest gives a fake one) ───────────────────────────────────────────
function make(deps = {}) {
  const d = { ssh: null, now: () => Date.now(), log: (s) => console.log(s), ...deps };
  const ssh = (script, o) => { if (!d.ssh) d.ssh = L.PS.sshReal(L.HOST); return d.ssh(script, o); };
  const tryRead = (fn) => { try { return fn(); } catch (e) { return { error: String((e && e.message) || e).slice(0, 300) }; } };
  const readCode = () => { const m = L.shasOf(ssh, L.RB, ["pm-book-recorder.js", "lib/pm-feeds.js"]); return { recorder: m.get("pm-book-recorder.js"), feeds: m.get("lib/pm-feeds.js") }; };
  const readHealth = () => L.parseHealth(L.must(ssh(L.REMOTE.health(), { timeout: 180000 }), "reading the recorder's health"));
  const readShow = () => parseShow(L.must(ssh(SCRIPTS.show(), { timeout: 60000 }), "reading the units' state"));
  const recorderOf = (h, s) => (h && h.status ? { pid: h.status.pid, startedAt: h.status.startedAt, mainPid: s && s.book ? s.book.MainPID : null, active: s && s.book ? s.book.ActiveState : h.active } : null);
  const readJournal = (sinceSec) => { const r = ssh(SCRIPTS.journal(sinceSec), { timeout: 120000 }), o = L.must(r, "reading the nightly unit's journal"), rc = /@@JRC (\d+)/.exec(o); if (!rc || rc[1] !== "0") throw new Error("journalctl failed: " + o.trim().split("\n").slice(-3).join(" | ").slice(0, 200)); return o; };
  const readSummary = (date) => String(L.must(ssh(SCRIPTS.summary(date), { timeout: 60000 }), "reading the summary file"));
  /** start = true: the one action (refused unless every precondition holds); -> { refused } | { verdicts, facts } */
  function verify({ start = false, date = "2026-10-13" } = {}) {
    const facts = { date };
    if (start) {
      const u = D.utcFence(d.now()); if (u) return { refused: [u] };
      let code, show, h0;
      try { code = readCode(); show = readShow(); h0 = readHealth(); } catch (e) { return { refused: [`the VPS could not be read (${String(e.message).slice(0, 200)}) — nothing was started`] }; }
      const st = D.FILES[0];
      if (code.recorder !== st.stagedSha) return { refused: [`the VPS's backend/pm-book-recorder.js is ${code.recorder === st.baseSha ? "the OLD file" : "not the staged file"} (${String(code.recorder).slice(0, 12)}): the run would be the old code — node docs/pm-summary-memory/2026-10-14/deploy.cjs --apply first; nothing was started`] };
      if (!show.nightly || !show.book) return { refused: ["the units' state could not be read — nothing was started"] };
      if (show.nightly.ActiveState !== "inactive" && show.nightly.ActiveState !== "failed") return { refused: [`${NIGHTLY} is ${show.nightly.ActiveState} — nothing was started (judge that run when it ends: run this without --start)`] };
      if (!h0 || h0.nowMs == null || !h0.status) return { refused: ["the recorder's status could not be read — nothing was started"] };
      facts.code = code; facts.before = recorderOf(h0, show); facts.runStartMs = h0.nowMs - 5000;
      d.log(`  starting ${NIGHTLY} on the VPS (the one action; it returns when the nightly's two steps are done) …`);
      const r = ssh(SCRIPTS.startNightly(), { timeout: START_TIMEOUT_MS });
      facts.startOut = L.parseStart(r && r.out) || { rc: r && r.status, active: "?", result: "?" };
      d.log(`  ${String((r && r.out) || "").trim().split("\n").pop() || "(no answer)"}`);
    }
    const h1 = tryRead(readHealth), s1 = tryRead(readShow);
    if (!start) { facts.code = tryRead(readCode); if (facts.code.error) facts.code = null;
      // read-only: the last run is the one systemd recorded (its start, end and result: no sudo, no journal group needed)
      facts.unit = s1 && !s1.error ? unitRunOf(s1.nightly) : null; if (facts.unit) facts.runStartMs = facts.unit.startSec * 1000; }
    const nowSec = (h1 && h1.nowMs ? h1.nowMs : d.now()) / 1000;
    const jt = tryRead(() => readJournal(start ? facts.runStartMs / 1000 : facts.unit ? facts.unit.startSec - 5 : nowSec - 30 * 3600));
    if (typeof jt === "string") {
      const runs = runsOf(jt); facts.journalAs = (/@@JRC \d+ (root|user)\b/.exec(jt) || [])[1] || null;
      // with --start the journal was read from just before the start: everything in it is that run. Without: the lines inside the span
      // systemd recorded for its last run; only when systemd's record cannot be read, the last run whose 'Starting' line is visible
      if (start) facts.run = judgeRun({ startSec: facts.runStartMs / 1000, lines: runs.flatMap((x) => x.lines) });
      else if (facts.unit) facts.run = judgeRun({ startSec: facts.unit.startSec, lines: linesOfRun(runs, facts.unit) });
      else { const started = runs.filter((x) => x.startSec != null), last = started[started.length - 1]; facts.run = judgeRun(last); if (last) facts.runStartMs = last.startSec * 1000; }
    } else facts.journalError = jt.error;
    const sm = tryRead(() => readSummary(date)); facts.summary = typeof sm === "string" ? parseSummary(sm, date) : { state: "unknown", why: sm.error };
    facts.health = h1 && !h1.error ? h1 : null; facts.after = h1 && !h1.error ? recorderOf(h1, s1 && !s1.error ? s1 : null) : null;
    return { verdicts: verdicts(facts), facts };
  }
  return { verify };
}

module.exports = { SCRIPTS, runsOf, judgeRun, unitRunOf, linesOfRun, parseShow, parseSummary, verdicts, exitOf, make, OOM_RE, MEM_RE };

if (require.main === module) {
  const a = process.argv.slice(2); let start = false, date = "2026-10-13", bad = false;
  for (let i = 0; i < a.length; i++) { if (a[i] === "--start") start = true; else if (a[i] === "--date" && /^\d{4}-\d{2}-\d{2}$/.test(a[i + 1] || "")) date = a[++i]; else bad = true; }
  if (bad) { console.log("usage: node docs/pm-summary-memory/2026-10-14/verify-live.cjs [--start] [--date YYYY-MM-DD]\nNothing was done."); process.exit(2); }
  console.log(`VERIFY LIVE — pm summary memory — ${new Date().toISOString().slice(0, 16)}Z (${D.mtWords(Date.now())} MT)${start ? " — WITH --start: the nightly unit is started once" : " — read-only: the last nightly run"}`);
  const r = make().verify({ start, date });
  if (r.refused) { console.error(`REFUSED — nothing was started:\n  - ${r.refused.join("\n  - ")}`); process.exit(2); }
  for (const x of r.verdicts) console.log(`${x.v.padEnd(8)} ${x.name.padEnd(10)} ${x.text}`);
  if (r.facts.journalError) console.log(`note     journal    ${r.facts.journalError}`);
  const code = exitOf(r.verdicts);
  console.log(code === 0 ? "ALL PASS" : code === 1 ? "A LINE FAILED — read it before anything else (rollback: node docs/pm-summary-memory/2026-10-14/rollback.cjs --plan)" : "NO FAIL, BUT NOT EVERY LINE COULD BE SHOWN — read the UNKNOWN lines, then run this again");
  process.exit(code);
}
