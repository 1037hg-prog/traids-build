# Worst-day sealed forecast ledger — 2026-10-16

Backlog row 19. A nightly job that writes **tomorrow's** worst-day forecast to an **append-only sealed ledger before the open**, a
**checker** that refuses any row written after 09:30 ET of the day it forecasts, and a **grader** that scores matured rows with a
Brier score and a calibration table. Built in a cloud session; **nothing here was applied, scheduled or run against real data.**

---

## HANDOVER

Read this first. The build was stopped on request part-way through its check loop; everything below is the true state.

### Done, and proven

| # | Thing | State |
|---|---|---|
| 1 | `staged/backend/worst-day/sealed-ledger.js` — row shape, ET seal clock, canonical bytes, hash chain, the only writer | done |
| 2 | `staged/backend/worst-day/sealed-check.js` — the eleven checks, incl. the 09:30 ET refusal; CLI `--file --json --selftest` | done |
| 3 | `staged/backend/worst-day/nightly-model.js` — the forecaster (price-only subset of run.js's inputs), label, two storm flags | done |
| 4 | `staged/backend/worst-day/nightly-forecast.js` — the job, `--plan` / `--write`, fail-closed at every step | done |
| 5 | `staged/backend/worst-day/sealed-grade.js` — Brier, Murphy decomposition, calibration table, storm table; `--dry` | done |
| 6 | `staged/backend/worst-day/sealed-fixtures.js` — the seeded synthetic bars (requires nothing) | done |
| 7 | `staged/backend/worst-day/sealed-selftest.js` — 167 known answers, ships beside the code | done |
| 8 | `deploy.cjs --plan / --apply`, `rollback.cjs --plan / --apply`, `record.cjs --dry`, `lib.cjs`, `base/README.md` | done |
| 9 | `selftest.cjs` (package: sandbox + package checks), `fixtures/` (+ `make-bars.cjs`), `mutants/run.cjs` + `hook.cjs` | done |

### Checks that pass, as of this commit

```
node docs/worst-day-sealed/2026-10-16/selftest.cjs            ALL 207 CHECKS PASSED      (~2 s)
node docs/worst-day-sealed/2026-10-16/mutants/run.cjs --list  MUTATION LIST OK — 36 changes
node docs/worst-day-sealed/2026-10-16/mutants/run.cjs --jobs 4
                                                              ALL 36 MUTANTS CAUGHT      (~13 s)
node docs/worst-day-sealed/2026-10-16/fixtures/make-bars.cjs --check
                                                              matches the generator (21,919 bytes)
node docs/worst-day-sealed/2026-10-16/deploy.cjs --plan        exit 0, 7 files absent, nothing written
node docs/worst-day-sealed/2026-10-16/rollback.cjs --plan      exit 0, nothing to roll back, nothing written
node --check  on each of the 7 staged files                    clean
```

Proven by hand in a throw-away copy of the repository (`deploy --apply` is never run by a build, and the live tree here is
untouched — `git status` shows only `docs/worst-day-sealed/`):

- `deploy.cjs --apply` wrote all 7 files, ran the package selftest (200 at the time) **and** the live `sealed-selftest.js` from the
  written tree (167), and exited 0;
- a second `--apply` read `nothing to apply`; the package selftest still passed with the files live;
- `record.cjs --dry`, then `record.cjs`, wrote one change-registry row and one GOVERNANCE line into a fake `backend/data`, and a
  third run read `ALREADY RECORDED`;
- one stray byte appended to a live file made `deploy --plan` exit 1 and `rollback --apply` **refuse** (exit 2, nothing changed);
- with that byte put back, `rollback --apply` removed exactly the 7 files and left `backend/worst-day/` byte for byte as it was
  (the original 11 files), and a second rollback was a clean no-op.

### Left to do, in order

1. **The independent checker pass was not run.** The build-check-loop pattern in `AGENTS.md` asks for a *separate* checker that
   re-runs every check command read-only and tries its own mutations. I ran the checks and the mutation suite as the builder; no
   second pair of eyes has been over them. **This is the one thing the package is short of.** Start a checker on this branch with:
   run every command in the block above, read `staged/backend/worst-day/*.js` against the claims in this file, and add mutants of
   its own to `mutants/run.cjs` (particularly for `sealed-grade.js`'s decomposition and for `record.cjs`, which has no mutant yet).
2. **Two package tools have no known answer at all**: `record.cjs`'s write path (only `--dry` is exercised) and `rollback.cjs`'s
   removal path. Both were proven by hand (above) but not pinned by a test. Add a sandboxed case for each.
3. **The nightly model has never been run on the real bar series** — there is no data in this clean copy, so it has only ever seen
   340 synthetic bars with a 60-session window. At home, run `node backend/worst-day/nightly-forecast.js --plan` once with the real
   `backend/data/training/worst-day/yahoo-SPY.json` (≈8,000 bars, window 1,260) before scheduling anything, and check the runtime:
   `forecastAsOf` sorts a 1,260-wide window once per bar, which is cheap on 340 bars and was never timed on 8,000.
4. **Nothing is scheduled.** The job is not in any chain and no `.bat` or unit was written. That is deliberate — a cloud session
   schedules nothing — but it means the ledger stays empty until the operator adds the evening call.
5. **The forward test is not registered.** `record.cjs --dry` prints the form it would have to take (`preregistrationOwed`); it is
   not written anywhere and `sealed-grade.js` refuses to call its own output a read until 252 matured rows and 20 worst days are
   in. Decide whether to register it before the ledger has enough rows to tempt a look.

Nothing is half-written: every file listed as done is complete, parses, and is covered by the checks above. The gap is the
**independent** check, not the work.

---

## What the three pieces are

### 1. The ledger — `sealed-ledger.js`

One line of JSON per forecast session, in `backend/data/worst-day/sealed-forecasts.jsonl`, with a tip file beside it. Its honesty
rests on three things and nothing else:

- **the seal** — `createdAt` must be strictly before **09:30 ET of `forDate`**. `SEAL_ET_HH/MM` are turned into an instant through
  `America/New_York`, so the deadline follows daylight saving by itself (known answers pin 14:30 UTC in January, 13:30 UTC in July,
  and both sides of the March and November steps). The writer refuses a late row; the checker refuses a ledger that holds one.
- **the chain** — every row carries `prevHash` (the sha256 of the row before it; the first carries 64 zeros) and `hash` (the sha256
  of its own body, `prevHash` included). Each line is `canonicalJson(row)`: keys sorted, no spaces, so re-hashing a line read back
  from disk needs no guessing about key order or whitespace.
- **the tip** — a small JSON file naming the last row's `seq` and `hash`. The chain proves order and content but cannot see rows
  **deleted from the end**; the tip can.

A row's keys are fixed and exhaustive (`BODY_KEYS` + `hash`): a row carrying any other key is refused, so nothing can sit outside
the hash.

**Honest limit.** The ledger is **tamper-evident, not tamper-proof.** There is no signature and no outside witness. A hand that
edits a row, re-hashes every row after it and rewrites the tip leaves nothing here to find. What the checks catch is a single edit,
a truncation, a reorder, an inserted row, or a late row.

**On the house writer.** `AGENTS.md` says JSON is written through `backend/lib/atomic-write.js`. The **tip file** is, with
`writeJsonAtomic`. The **ledger rows** are not, and must not be: `writeJsonAtomic` replaces a whole file through a rename, which is
right for a canonical store and wrong for an append-only one. Rows are appended with `open(…, "a")` + `write` + **`fsync`** +
`close` (`appendLine`), so a row that `appendRow` returns from is on the disk. This mirrors how the repo already appends
`agent-ledger.jsonl`.

### 2. The checker — `sealed-check.js`

Eleven named checks, each reported pass or refuse; a later check that cannot be computed reports **NOT RUN** and the ledger is still
refused.

`parse · schema · seq · chain · hash · createdAtOrder · forDateOrder · sessionDay · seal · notFuture · tip`

`seal` is the one the ledger exists for. One late row refuses the **whole** ledger, not the row — a ledger that accepts one late row
is a ledger whose other rows cannot be told apart from late ones.

### 3. The forecaster — `nightly-model.js`

- **The label is run.js's, unchanged**: tomorrow is a worst-5% day when its close-to-close total return is at or below the
  nearest-rank 5th percentile of the trailing 1,260 sessions ending at today (`dataset.js` `WIN`/`TAIL`, `verify.js`'s 63rd smallest
  of 1,260). The threshold is computed at the decision close and **written into the row**, so grading never re-derives it and a
  later window can never move an old row's bar.
- **The inputs are the price-only subset** of run.js's fifteen: `lnRv5 lnRv20 lnRv60 ret1 ret5 dist50 dist200`, built exactly as
  `dataset.js` builds them. run.js's other eight need FRED, HYG/LQD, nine sector ETFs and two calendars — four more files, each with
  its own stamp. A nightly row has to be reproducible from **one** file, so this model is deliberately **weaker** than run.js's, and
  every row says so in `model.id` and `model.features`.
- **The fit** is `lib.js`'s ridge logistic at lambda 10, refit on every labelled session known at the decision close (an expanding
  window). run.js refits each January; a nightly job has no reason to wait, and each row states its own `nTrain`.
- **The storm state** is two causal flags, neither tuned here: `flagModel` (the model's own probability at or above the 90th
  percentile of its **training** probabilities — `wf.js`'s causal top-decile rule) and `flagRule` (run.js's rule of thumb (a):
  below the 200-session mean **and** 20-session vol in its own trailing top fifth). Both → `storm`; one → `watch`; neither →
  `calm`. Three states out of two binary flags is the only choice made here, and it was made before anything was graded.
- **Nothing after the decision bar is read.** `lookAheadProof()` scrambles every later bar by at least 40%, alternating up and down,
  **and then runs the same scramble the other way round**, and the forecast must not move by one bit. (One direction can leave a
  label unchanged by luck; the two together cannot — that is what the mutation run showed.)

### 4. The job — `nightly-forecast.js`

`--plan` reads and prints; `--write` appends. It refuses, writing nothing, when: `forDate` is already behind the ET clock (stale
bars), the seal has closed, the ledger does not pass its own checker, `forDate` is not after the ledger's last row, or no forecast
can be made. A late run writes **nothing** — not a late row, not a row for the day after, and not silence: it exits 3 and says the
seal closed.

### 5. The grader — `sealed-grade.js`

It **grades nothing until the checker passes** (exit 3). A row matures when the bar file holds its session and the session before
it. A row whose stated `asOfAdj` no longer matches the bars is **disputed** and set aside, never scored.

- **Brier** = mean (p − y)², beside **always-5%** (the honest null: the target is a 5% event by construction) and **climatology**
  (the realised rate over the matured rows — in-sample, and labelled as such). Skill = 1 − Brier / Brier(always-5%).
- **Murphy's decomposition** through the fixed bins: reliability − resolution + uncertainty, with the within-bin spread reported as
  `withinBinRemainder` rather than hidden. The identity is asserted, not assumed.
- **Calibration table**: six bins fixed before any row was graded — `[0,.02) [.02,.05) [.05,.10) [.10,.20) [.20,.40) [.40,1]`.
  Per bin: rows, mean stated probability, realised rate, gap. Nothing is smoothed, no bin is merged, an empty bin states nothing.
- **Storm table**: rows, mean p and realised rate per state.
- **`enoughToRead` is false** until 252 matured rows and 20 worst days. Below that the numbers are printed so they can be watched
  accumulate, not so they can be believed. `forward-power.js` sized exactly this: at 63 sessions the median window holds 3 worst
  days.

---

## The tests

167 known answers ship **with the code** (`sealed-selftest.js`), so home can run them: `node backend/worst-day/sealed-selftest.js`,
or one suite (`sealed-ledger`, `sealed-check`, `nightly-model`, `nightly-forecast`, `sealed-grade`), or through any of the three
CLIs' `--selftest`. The package selftest adds 40 of its own and runs the rest in a **sandbox**: the seven staged files copied into a
throw-away tree beside byte-exact copies of the five repo files they need (`backend/lib/atomic-write.js`, `backend/lib/run-window.js`,
`backend/worst-day/lib.js`, and the two `package.json` files that make `.js` under `backend/` CommonJS). No repo path is on their
require path at all.

The bars are **synthetic and made here** by a seeded generator: 340 weekdays, calm for 300 and then a forty-session drawdown at four
times the volatility, so both storm states appear. No market data of any kind is read. The test configuration uses a 60-session
threshold window so 340 bars are enough; the production defaults (1,260 / 200 / lambda 10) are themselves pinned known answers.

Several answers are recomputed by a **second, straight-loop code path** rather than by calling the thing under test twice — the
nearest-rank threshold, rule of thumb (a), the maturity split, the Brier scores and the skill — in the style of `verify.js`.

**No registered test's rule, bar, population or read condition was changed, and no test registry entry was written.** Every test
here is new.

### What the mutants found

`mutants/run.cjs` makes 36 deliberate wrong changes, one at a time, in memory as `selftest.cjs` reads the staged file (nothing on
disk changes). Each must make the selftest fail **in the known answer written for that rule**. Three real gaps turned up and were
fixed rather than explained away:

1. **`process.exit()` was truncating the selftest's own output.** With stdout a pipe, a long failing run's summary line was being
   dropped, which showed up as 15 mutants with "no result". Both selftests now set `process.exitCode`.
2. **The look-ahead proof was weaker than it read.** Scrambling later bars one way round left a training label unchanged by luck, so
   a model that trains on tomorrow's label survived. The proof now runs the scramble both ways round, and a direct count of the
   training rows one bar back was added.
3. **`lib.cjs` had no seam for a DRIFT known answer** — the selftest may not write into the live tree, so it could never make a
   drifted file. The three-way state decision was extracted as `stateOf(live, staged)` and pinned directly.

One **equivalent mutant** is recorded in the list rather than deleted: flipping the sign of the *first* pass of `etWallMs` changes
nothing, because the second pass puts it right. The mutant targets the second pass instead, and the comment says why.

Not covered by the list, and said rather than left to be found: the DRIFT branches of `rollback.cjs`, and `record.cjs`'s write path.
Both were proven by hand (see **HANDOVER**, item 2).

---

## What this package does NOT claim

- It is **not** a trading rule and not a signal. No order of any kind, no broker call, no network call, nothing scheduled.
- It is **not** evidence that the forecaster works. It is the instrument that makes a forward read **possible** later.
  `forward-power.js`'s numbers are walk-forward and in-sample and say so; this ledger is the thing that was missing.
- The ledger is **tamper-evident, not tamper-proof** (above).
- The nightly model is **weaker than run.js's** by construction (above).
- A score over a few dozen rows means nothing, and the grader refuses to call it a read.

---

## The order to apply

The operator runs these at home; the build never does.

1. `node docs/worst-day-sealed/2026-10-16/selftest.cjs` — must end `ALL n CHECKS PASSED`
2. `node docs/worst-day-sealed/2026-10-16/deploy.cjs --plan` — seven files, all `absent`, fences clear
3. `node docs/worst-day-sealed/2026-10-16/deploy.cjs --apply` — refused 13:50–15:50 MT on a trading day, and on any DRIFT
4. `node docs/worst-day-sealed/2026-10-16/record.cjs --dry`, then `node docs/worst-day-sealed/2026-10-16/record.cjs`
5. `node backend/worst-day/nightly-forecast.js --plan` — read the row and the timing before anything is written (**HANDOVER** item 3)
6. only then schedule `node backend/worst-day/nightly-forecast.js --write` in the evening chain
7. `node backend/worst-day/sealed-check.js` any time; `node backend/worst-day/sealed-grade.js --dry` once rows mature

**Rollback:** `node docs/worst-day-sealed/2026-10-16/rollback.cjs --plan`, then `--apply`. It removes exactly the seven files and
never touches `backend/data/worst-day/` — a sealed ledger is append-only data, not code. **Unschedule the job before rolling back.**
