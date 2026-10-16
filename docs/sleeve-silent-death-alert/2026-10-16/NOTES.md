# Sleeve silent-death alert — staged package, 2026-10-16

This package was built in a cloud session and has not been applied anywhere. It sends nothing, and makes no network or broker call. Its tests use a fake clock, fake ledgers and a fake notify.

## Why

R346's two scheduled tasks reported success for five sessions while the batch they start never ran, and no alert reached the operator. Every alert a sleeve has today runs *inside* that sleeve's own run: R316's `alertOnce`, its after-close gap check, the close-arm runner's alerts. A run that never starts can never report that it did not start.

This script sits outside every sleeve. It:

- reads what each sleeve leaves on disk;
- compares that with the trading-session calendar;
- alerts through `backend/notify.js`, the only operator alert path, for every session a sleeve should have decided and did not.

## What is in this package

| path | what |
|---|---|
| `staged/backend/sleeve-silence-alert.js` | **new** script. Run it as `node backend/sleeve-silence-alert.js [--dry] [--now ISO]`. |
| `base/backend/sleeve-silence-alert.js.absent` | marker that the file is new; rollback removes it |
| `deploy.cjs --plan / --apply`, `rollback.cjs --plan / --rollback` | refuse on drift; refuse on trading weekdays 05:30–16:00 MT |
| `selftest.cjs` | 54 checks: fake clock, fake state files and ledgers, fake notify. Ends `SELFTEST PASSED (54 checks)`. |

There is no `record.cjs`. The script writes no registry row, changes no registered test and mints no test id. Its only output file is its own dedupe state, `backend/data/sleeve-silence-alert.json`, written through `lib/atomic-write.js`.

## How it decides

**The calendar.** Trading sessions are weekdays minus `lib/run-window.js` `MARKET_HOLIDAYS`. Early-close days count as sessions; those sleeves decide earlier, so each sleeve's due time still holds. A session S is *due* once the ET clock passes S at the sleeve's `dueEt`. Each run looks back over the last 10 due sessions.

**The sleeves and their decision records.** Each record shape was read from the sleeve's own code:

| sleeve | shape | decided on session S when | due (ET) | OFF switch |
|---|---|---|---|---|
| R346 | days | `r346-state.json` `days[S].decision === true`, or a `r346-ledger.jsonl` row `{kind:"decision", date:S}` without `quoteError` | 16:30 | `r346-OFF` still decides (entries only) |
| R316 | days | the same, in `r316-state.json` / `r316-ledger.jsonl` (`r316-ibs-forward.js:585-592`) | 16:30 | `r316-OFF` still decides |
| R151 | lastRun | `r151-state.json` `lastRun.closeArm` / `afterClose` / `preOpen` ≥ S, each step checked separately (`r151-rsi2-forward.js:165,185,206`) | 16:30 / 17:30 / 10:00 | `r151-OFF` stops the runner → paused |
| R186, R218, R219 | lastRun | `lastRun.closeArm` ≥ S. It is written every session, including sessions with nothing due. | 16:30 | still writes lastRun |
| R191, R231 | marks | a mark with `d` ≥ S−1 that is not a catch-up mark (the last completed UTC candle), or a catch-up mark with `markedOn` ≥ S (`lib/forward-catchup.js`) | 21:00 | marks continue under the switch |

**Not expected to decide, so no alert:**

- before the sleeve's start, which is the first of `firstLiveDecision`, its first record, or `expectFrom`;
- while `TRAIDS_STOP` exists;
- while the sleeve's OFF switch exists, if that switch stops decisions (R151 only);
- while its HALT file reads `guard-violation`. An `interim-kill` still decides.

A state file that exists but cannot be read **is** an alert. So is a missing state file once the sleeve's `expectFrom` has passed.

**One alert per run, naming every silent sleeve.** Each sleeve × session is alerted once. An entry is written to the dedupe state only after `notify()` returns true, so an undelivered alert is retried on the next run. Entries older than 30 days are pruned.

Exit codes:

- 0: nothing missed
- 3: something missed and the operator was told (now or earlier)
- 4: something missed and **nobody was told**
- 2: bad arguments

Off switch: `backend/data/sleeve-silence-OFF`.

The notify call is `notify(title, body, { priority: "high", tags: "warning", email: false })`, the same call `r316-ibs-forward.js:1213` and `lib/r309-health.cjs:250` make.

## MISSING FROM THE CLOUD COPY — what to confirm at home

These files are not in this copy and were **not reconstructed**:

- **`backend/r346-rsi2-etf-forward.js`**: R346's runner. R346's record shape is **inferred** from R316, which uses the same runner pattern (`docs/server/wave3-sleeves/manifests.cjs` gives both the same stamps). The alert's body says the shape is inferred. Check at home: `r346-state.json` has `days[<date>].decision` and `firstLiveDecision`; the ledger is `r346-ledger.jsonl` with `kind:"decision"` rows; `r346-OFF` and `r346-HALT.json` behave as R316's do. If any of these names differ, edit R346's row in `SLEEVES`.
- **`expectFrom: "2026-10-08"` for R346 is an inference.** It is the first session after the 2026-10-07 decision ("paper r328"). Five sessions run from 10-08 to 10-14, which matches the incident. If the batch never ran, no state file exists, and without `expectFrom` the alert would read R346 as "not started" and stay silent. That is exactly the failure being fixed. **Confirm or correct the date at home.**
- **`backend/notify.js`**: called exactly as its existing callers call it. Its source was not seen.
- **`backend/r295-orb-forward.js`, `r236`, `r283`, `r160`, `r260` and `r328`**: their scripts are not in this copy, so those sleeves are **not covered**. Add a row for each at home once its record shape has been read. The row formats above cover the three shapes known so far.
- **`docs/server/wave3-sleeves/cell.cjs`**: the W3 unit table with its switches and calendars.
- **`automation/close-chain.cjs` and `close-arm-runner.cjs`**: so nothing is scheduled by this package.

**Host ownership.** `backend/data/host-ownership.json` decides whether home or the VPS runs a unit. For a unit the VPS runs, home sees the sleeve's state only after the chain pulls it. The alert names the host in its body. If pulls lag behind the 21:00 ET check, move the scheduled run after the pull step.

## Operator steps at home

1. Confirm the R346 shape and `expectFrom` above, and add rows for the sleeves not covered.
2. Run `deploy.cjs --plan`, then `deploy.cjs --apply` (after 16:00 MT, or on a non-trading day).
3. Rehearse: `node backend/sleeve-silence-alert.js --dry`. It prints each sleeve's status and the alert it would send, and writes nothing.
4. **Schedule it outside the sleeves' own tasks**, so the same failure cannot silence both. For example, a Task Scheduler task on weekdays at 21:15 ET (19:15 MT) and again at 10:15 ET for R151's pre-open step. Running it as the last close-chain step also works, but a scheduler task of its own is more independent.
5. Watch for exit code 4 in the task's history: it means a silent sleeve was found and the alert did not get through.

## Cloud-only note

The root `package.json` is `"type": "module"`, and this copy has no `backend/package.json`. The selftest therefore loads backend files through `loadcjs.cjs`. At home, `node backend/sleeve-silence-alert.js` runs as CommonJS, as every other backend script does. `npm ci` cannot run here because there is no lockfile, and no npm dependency is needed.

## Checks run here

- `node docs/sleeve-silent-death-alert/2026-10-16/selftest.cjs` → `SELFTEST PASSED (54 checks)`
- `node --check` on every file; `deploy.cjs --plan` reads `base` (new file)
