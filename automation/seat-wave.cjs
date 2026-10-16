#!/usr/bin/env node
/**
 * SEAT WAVE — the escrowed seats run themselves every session. 2026-09-01.
 *
 * Operator's decision ("1 2 3"): automate the seats. Until today the ONLY way a seat produced its
 * daily output was a human invoking it by hand inside a Claude Code session. The synthesis seat
 * (head-trader, HT1) needs 20 memo-days to read and had 2 after four days of the seats existing.
 * An architecture with 27 seats and no clock accrues nothing.
 *
 * WHAT RUNS. The bundled Claude Code binary, headless (-p), one seat at a time, in a fixed order:
 * the brake first, construction second, the three book seats, and the synthesis seat LAST so it
 * reads what the others wrote tonight. Sequential on purpose — head-trader's inputs are the other
 * seats' outputs, and parallel runs would race on the ledgers.
 *
 * WHAT EVERY SEAT MUST DO BEFORE IT STOPS — enforced by the charge and VERIFIED here:
 *   1. seal exactly one NAMED / SIZED / DATED / FALSIFIABLE claim via backend/seal-claim.js
 *   2. record its intervention via backend/agent-ledger.js
 * A seat that ran and sealed nothing gets ONE follow-up turn (--continue) telling it so. If it
 * still has not sealed, that is recorded as a failure — seat-seal-accrual.js will fail the chain
 * on it tomorrow, which is the correct outcome. The wave never seals on a seat's behalf: a claim
 * the seat did not make is not the seat's record.
 *
 * WHAT IT NEVER DOES. Places no orders. Every seat's permission surface is the agent definition's
 * own tool list; lib/agent-book.js throws on any write aimed at the measurement book. Runs only on
 * a day the close chain actually finished (so: no Saturday, no holiday), and never twice a day.
 *
 * COST. Six runs a session, five on sonnet and one (head-trader) on opus, each capped by
 * --max-budget-usd and a wall-clock timeout. The whole wave is capped too, so it cannot run into
 * the evening: the operator's 5pm MT job stop stands.
 *
 * Output: data/seat-wave-status.json (latest) · data/seat-wave-history.jsonl (append) ·
 *         automation/seat-wave.log
 * Usage:  node automation/seat-wave.cjs [--only <seat>] [--dry] [--force]
 */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const D = (f) => path.join(ROOT, "backend", "data", f);
const LOG = path.join(__dirname, "seat-wave.log");
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : null; };
const DRY = argv.includes("--dry"), FORCE = argv.includes("--force"), ONLY = arg("only");

const log = (s) => { const line = `[${new Date().toISOString()}] ${s}`; console.log(line); try { fs.appendFileSync(LOG, line + "\n"); } catch {} };
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return d; } };
const etDay = (v = Date.now()) => new Date(typeof v === "number" ? v : Date.parse(v)).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const TODAY = etDay();

// ── the binary: bundled with the desktop app, version-pinned directory, so resolve the newest ──
/**
 * RESOLVE OR REFUSE (2026-09-09). The first LIVE wave — 2026-09-09, after the dry-run bug was fixed —
 * logged `exe claude` and every seat came back `EXIT null` in eight milliseconds. The old fallback
 * returned the bare string "claude" whenever the versioned directory did not resolve, and the PATH
 * entry on this machine is claude.ps1, which spawnSync cannot execute without a shell. So the wave
 * spawned nothing six times and called it a run.
 *
 * It was not silent — the exit code was 1 and ops-health.js caught it the same night — but "EXIT null"
 * is not a diagnosis, and a resolver that answers with a guess when it does not know is the same
 * fail-open shape as a check that reports "warn" when it could not run. It now searches every place
 * the executable actually lives and THROWS if none of them holds a real file.
 */
function claudeExe() {
  // 2026-09-10: under the scheduled task the user profile is not loaded, so APPDATA/LOCALAPPDATA are EMPTY and both roots were
  // filtered out — the wave threw "cannot find claude.exe" nightly while the exe sat in %APPDATA%Claudeclaude-code. os.homedir()
  // resolves without a profile, so the same folders are tried from it, plus the ~/.local/bin install.
  const home = require("os").homedir();
  const roots = [path.join(process.env.APPDATA || "", "Claude", "claude-code"),
                 path.join(process.env.LOCALAPPDATA || "", "Claude", "claude-code"),
                 path.join(home, "AppData", "Roaming", "Claude", "claude-code"),
                 path.join(home, "AppData", "Local", "Claude", "claude-code")].filter((p) => p && !p.startsWith(path.sep));
  const tried = [];
  for (const dir of roots) {
    tried.push(dir);
    try {
      const vers = fs.readdirSync(dir).filter((v) => fs.existsSync(path.join(dir, v, "claude.exe")))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      if (vers.length) return path.join(dir, vers[0], "claude.exe");
    } catch { /* next root */ }
  }
  for (const p of [path.join(process.env.APPDATA || "", "npm", "claude.exe"), path.join(process.env.LOCALAPPDATA || "", "Programs", "claude", "claude.exe"),
                   path.join(home, ".local", "bin", "claude.exe"), path.join(home, "AppData", "Roaming", "npm", "claude.exe")]) {
    tried.push(p);
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error("cannot find claude.exe — refusing to run the wave rather than spawning a guess. Looked in: " + tried.join(" | "));
}

// ── the seats, in order. head-trader LAST. ──
const SEATS = [
  { seat: "risk-governor", minutes: 12, budget: 2.0,
    charge: "Answer your one question for the NEXT session: may the book open another ticket tomorrow? Read data/portfolio-risk.jsonl, data/circuit-breaker.json, data/risk-policy.json and data/pooling-audit.json. Update data/risk-governor.json. Your sealed claim is kind 'halt' with direction 'allow' or 'halt' for tomorrow's session, falsifier stated in session P&L terms, window closes at tomorrow's 16:05 ET (--closes sessions:1)." },
  { seat: "portfolio-constructor", minutes: 12, budget: 2.0,
    charge: "Propose tomorrow's construction for the paper book: weights by class and factor group, concentration you would cap, and the real risk versus stated risk. Read data/portfolio-risk.jsonl, the cluster ledger and data/pooling-audit.json. Your sealed claim is kind 'construction' with a magnitude (your proposed gross risk as a fraction of capital) and a falsifier in realised risk-adjusted terms, window --closes sessions:5." },
  { seat: "news-trader", minutes: 12, budget: 2.0,
    charge: "Read today's news stamps (data/news-stamp.json, data/news-fetch.json) and R85's state (data/news-gate.json if present). You remain ESCROWED: no live news-conditioned trade. Your sealed claim is kind 'news' naming ONE instrument and direction for tomorrow's session that your conditioning would take, with the falsifier stated in R, window --closes sessions:1." },
  { seat: "stop-manager", minutes: 12, budget: 2.0,
    charge: "Read today's exits from the canonical ledger via backend/lib/reconcile.js and the R54 twin state (data/r54-stop-twin.json). You remain ESCROWED HARDEST. Your sealed claim is kind 'exit' naming ONE open ticket by id and the exit variant you would apply, with the falsifier stated in R versus the board's own stop, window --closes sessions:3." },
  { seat: "portfolio-manager", minutes: 15, budget: 2.5,
    charge: "Write tomorrow's allocation order-of-operations for the agent book and act on it through backend/lib/agent-book.js where your charter allows (attribution agent 'portfolio-manager'; the mechanical factor-cap arm runs separately and is NOT yours to duplicate). Append your plan to data/portfolio-manager-plans.jsonl. Your sealed claim is kind 'allocation' naming the first ticket you would open tomorrow with direction and a magnitude in risk dollars, falsifier in R, window --closes sessions:3." },
  { seat: "head-trader", minutes: 18, budget: 4.0, model: "opus",
    charge: "Write tonight's desk memo for session " + TODAY + " exactly per your definition, reading every seat's output written tonight (data/risk-governor.json, data/seat-claims.jsonl, data/portfolio-manager-plans.jsonl, data/agent-book.json, the gate reads, data/pooling-audit.json FIRST). Write data/ht-memo-seal.json (backend/ht-memo-archive.js banks it). Your sealed claim is the WOULD-DO: kind 'would-do', ONE named instrument, direction, magnitude in risk dollars, falsifier = D_d fails the HT1 bar, window --closes sessions:1." },
];

const COMMON = (seat) => `
It is the post-close seat wave for session ${TODAY}. You are running headless with no operator present.

BEFORE YOU STOP you MUST do both of these, in this order, from the repo root:
  1. Seal exactly ONE claim:
       node backend/seal-claim.js --seat ${seat} --kind <kind> --subject "<named subject>" --direction <dir> [--magnitude <n>] --falsifier "<what would prove you wrong>" --closes sessions:N --links <ids>
     The sealer REFUSES hedged wording (consider/monitor/watch/may/might), missing size, or a window already closed. If refused, restate and retry. Do not stop until it prints "sealed".
  2. Record your intervention:
       node backend/agent-ledger.js --record --agent ${seat} --kind MEASUREMENT --target "<file or test>" --what "<one line>"
     Use --kind TRADING only if you opened or closed an agent-book ticket.

STANDING RULES. Paper only; place no orders. Never write to board_positions.json or trade_log.json. All JSON writes through node scripts, never PowerShell or heredocs. Ledger figures only via backend/lib/reconcile.js. Effective N is sessions or episodes, never tickets. Every number you quote is read from its file tonight. Keep the run short: read what you need, write your outputs, seal, record, stop.
`;

// ── guards ──
const chain = rd("chain-status.json", null);
const chainDay = chain && chain.finished ? etDay(chain.finished) : null;
if (!FORCE && chainDay !== TODAY) { log(`SKIP — close chain has not finished today (last finished ${chain ? chain.finished : "never"}); no session to run seats on.`); process.exit(0); }
const prior = rd("seat-wave-status.json", null);
if (!FORCE && !ONLY && prior && prior.session === TODAY && prior.completed) { log(`SKIP — wave already completed for ${TODAY}.`); process.exit(0); }

const SEALS_BEFORE = () => { try { return fs.readFileSync(D("seat-claims.jsonl"), "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const sealedToday = (seat) => SEALS_BEFORE().filter((r) => r.seat === seat && r.session === TODAY).length;

const EXE = claudeExe();
const WAVE_CAP_MS = 85 * 60 * 1000;
const t0 = Date.now();
log(`SEAT WAVE ${TODAY} — exe ${EXE} · ${DRY ? "DRY RUN" : "live"} · ${ONLY ? "only " + ONLY : SEATS.length + " seats"}`);

function runSeat(s, extraArgs, prompt, minutes) {
  const args = ["-p", prompt, "--agent", s.seat, "--permission-mode", "bypassPermissions", "--output-format", "json",
    "--max-turns", "60", "--max-budget-usd", String(s.budget), ...(s.model ? ["--model", s.model] : []), ...extraArgs];
  if (DRY) { log(`  dry: ${s.seat} would run ${minutes}m budget $${s.budget}`); return { ok: true, dry: true }; }
  const r = spawnSync(EXE, args, { cwd: ROOT, encoding: "utf8", timeout: minutes * 60 * 1000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  // A SPAWN failure and a seat that ran and exited non-zero are different facts; "EXIT null" conflated
  // them on 2026-09-09 and cost an hour of reading. Name the spawn error where it happens.
  if (r.error && !/ETIMEDOUT/.test(String(r.error.code || r.error))) log(`  ${s.seat} — SPAWN FAILED (${r.error.code || r.error.message}) using exe ${EXE}`);
  return { ok: r.status === 0, status: r.status, spawnError: r.error ? String(r.error.code || r.error.message) : null,
    timedOut: !!r.error && /ETIMEDOUT/.test(String(r.error.code || r.error)), cost: j ? j.total_cost_usd : null,
    turns: j ? j.num_turns : null, sessionId: j ? j.session_id : null, stderr: (r.stderr || "").slice(-600), result: j ? String(j.result || "").slice(0, 400) : (r.stdout || "").slice(-400) };
}

const results = [];
for (const s of SEATS) {
  if (ONLY && s.seat !== ONLY) continue;
  if (Date.now() - t0 > WAVE_CAP_MS) { log(`  WAVE CAP — ${s.seat} not run, 85 minutes elapsed`); results.push({ seat: s.seat, skipped: "wave cap" }); continue; }
  // SEAT-SDK TRIAL (work order 4.31, through 2026-11-14; docs/seat-sdk-trial/2026-10-12/NOTES.md). backend/data/seat-provider.json says
  // which launcher runs this seat. No such file: these lines do nothing and the wave is exactly what it was. A seat the file puts on "sdk"
  // is run, checked and recorded by automation/seat-sdk/wave-hook.cjs (the same charge, cap, minutes and model; its row carries launcher
  // "sdk"); every other seat goes on below, on the command line. An SDK seat that fails ends UNKNOWN with its reason in its row: it is
  // never run again on the command line. A hook that cannot be used ends the seat UNKNOWN too: nothing runs on a path nobody chose.
  if (fs.existsSync(D("seat-provider.json"))) {
    let viaSdk;
    try { viaSdk = require("./seat-sdk/wave-hook.cjs").seat({ s, prompt: s.charge + "\n" + COMMON(s.seat), session: TODAY, root: ROOT, dry: DRY, log, sealedToday }); }
    catch (e) { viaSdk = { seat: s.seat, ok: false, sealed: 0, retried: false, secs: 0, cost: null, turns: null, timedOut: false, exit: null, launcher: "unknown", outcome: "UNKNOWN", reason: "automation/seat-sdk/wave-hook.cjs could not be used: " + String(e && e.message).slice(0, 200) }; log(`  ${s.seat} — UNKNOWN · ${viaSdk.reason}`); }
    if (viaSdk) { results.push(viaSdk); continue; }
  }
  const before = sealedToday(s.seat);
  log(`  ${s.seat} — start (sealed today before: ${before})`);
  const st = Date.now();
  let r = runSeat(s, [], s.charge + "\n" + COMMON(s.seat), s.minutes);
  let sealed = sealedToday(s.seat) - before;
  let retried = false;
  if (!DRY && sealed < 1 && r.sessionId) {
    retried = true;
    log(`  ${s.seat} — ran but sealed nothing; one follow-up turn`);
    const r2 = runSeat(s, ["--resume", r.sessionId], `You did not seal a claim. Seal exactly ONE now with node backend/seal-claim.js --seat ${s.seat} ... (NAMED, SIZED, DATED, FALSIFIABLE, --closes sessions:N), then record with backend/agent-ledger.js, then stop.`, 6);
    r.cost = (r.cost || 0) + (r2.cost || 0);
    sealed = sealedToday(s.seat) - before;
  }
  const secs = Math.round((Date.now() - st) / 1000);
  const row = { seat: s.seat, ok: r.ok, sealed, retried, secs, cost: r.cost, turns: r.turns, timedOut: r.timedOut || false, exit: r.status, note: r.result, stderr: r.ok ? undefined : r.stderr };
  results.push(row);
  log(`  ${s.seat} — ${r.ok ? "ok" : "EXIT " + r.status}${r.timedOut ? " TIMEOUT" : ""} · sealed ${sealed} · ${secs}s · $${r.cost == null ? "?" : r.cost.toFixed(2)}`);
}

const out = { spec: "seat-wave-v1", session: TODAY, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString(), exe: EXE, dry: DRY,
  completed: !ONLY, seats: results, sealedSeats: results.filter((r) => r.sealed >= 1).length, ranSeats: results.filter((r) => !r.skipped).length,
  totalCost: +results.reduce((s, r) => s + (r.cost || 0), 0).toFixed(2), totalMinutes: +((Date.now() - t0) / 60000).toFixed(1),
  verifiedBy: "backend/seat-seal-accrual.js fails the close chain on any seat that acted without sealing; this file reports, that file enforces." };
if (!DRY) {
  fs.writeFileSync(D("seat-wave-status.json"), JSON.stringify(out, null, 1));
  fs.appendFileSync(D("seat-wave-history.jsonl"), JSON.stringify(out) + "\n");
}
log(`WAVE DONE — ${out.sealedSeats}/${out.ranSeats} seats sealed · $${out.totalCost} · ${out.totalMinutes} min`);
process.exit(out.ranSeats && out.sealedSeats < out.ranSeats ? 1 : 0);
