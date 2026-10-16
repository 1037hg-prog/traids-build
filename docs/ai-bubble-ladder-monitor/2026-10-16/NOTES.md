# AI-bubble ladder monitor (2026-10-16)

A **read-only daily reading** of the AI-bubble contingency plan's de-risking ladder — its **B1** and **B2** levels —
computed from stored daily closes. It prints a plain summary saying, for each rung, whether it is **ARMED**, with the
value it read and the threshold that value was judged against, and with `--write` it puts that day's status under its
own date key in one file of its own.

It places **no orders of any kind**. It makes no network call and no broker call: it holds no HTTP client, no URL and
no key, and the selftest proves that from the source. It reads no account and no position. The only thing it ever
writes is `backend/data/ai-bubble-ladder-status.json`, and only when asked with `--write`.

---

## What the code pins, and what it does not

The plan's own write-up — `docs/ai-bubble-contingency-plan-2026-10-07.md` — is a markdown file, so it is **not in this
code-only copy of the repository**. Every rule below is therefore taken from the **code** of the 10-07 measurement
lenses in `docs/ai-bubble-2026-10/`, line by line, and every rung carries the line it comes from in its own `source`
field, printed by `--json` and stored in every written status.

**What the code pins beyond doubt:** the two rules themselves (the daily 200-day ±2% band, the monthly 10-month flip),
their exact arithmetic including which inequality is strict, which series each is measured on, and the dividend-adjusted
close as the input. These are read from the lenses and from the live `backend/book-etf-rebalancer.js`.

**What the code does not pin, and the operator should confirm against the write-up:** the *labels* `B1` and `B2`, and
hence which of the two levels is which. The code shows two levels of the same ladder — a fast daily tripwire and a slow
monthly flip — and this package calls the daily one B1 and the monthly one B2, because that is the order the plan's
arithmetic script works in (`dalio-plan/plan-sizing.cjs:23-24` computes the tripwire; `plan-review/flip-levels.cjs`
computes the month-end flip levels) and because a tripwire that reads every day sits below a rule that reads once a
month. **If the write-up numbers them the other way round, swap the two `level` fields in `LADDER` and nothing else
changes** — no threshold, no arithmetic, no test. `record.cjs` lists that confirmation under `owed`.

Nothing here invents a threshold, a bar or a population. Where the code was silent the monitor reports **NOT READ**
rather than guessing (see *Too little history*).

---

## The ladder

| rung | level | what it reads | ARMED when | from |
|---|---|---|---|---|
| `B1-QQQ` | B1 | QQQ daily adj close vs its 200-day SMA, ±2% band | the band rule reads OUT | `bust/triggers.js:51-57`, `plan-sizing.cjs:24` |
| `B1-SPY` | B1 | SPY, same rule | " | " |
| `B1-SMH` | B1 | SMH, same rule | " | " |
| `B2-QQQ` | B2 | QQQ month-end adj close vs the mean of the last 10 month-ends | that close ≤ the mean | `bust/triggers.js:50`, `flip-levels.cjs:12` |
| `B2-SPY` | B2 | SPY, same rule | " | " |
| `B2-CREDIT` | B2 | the VWEHX/VFITX ratio, same rule | " | `bust/triggers.js:50,83` (`d5`), `flip-levels.cjs:13-15` |

### B1 — the daily 200-day ±2% band

`bust/triggers.js:51-57` `dailyTrend(S, 200, 0.02)`, the signal it lists as `b2 200-day +/-2% band`:

- The **first** reading, at the first session with 200 closes behind it, is the plain test `close > 200-day mean`.
- From then on the band holds the previous reading: held → **out** only when `close < 0.98 × mean`; out → **held** only
  when `close > 1.02 × mean`. In between, the reading carries forward unchanged.

So the reading depends on the run of sessions before it, not on the last close alone, and the monitor rebuilds it from
the first available session every time — it keeps no state file. `plan-review/precedent.cjs:9` prints the same two
levels (`band exit 0.98*sma`, `band re-entry 1.02*sma`); `plan-sizing.cjs:23-24` calls it "the tripwire" and prints the
band exit for QQQ, SPY and SMH, which is where the three B1 rungs come from.

The summary shows the close, the 200-day mean, and **the level the current reading is judged against** — the arm level
`0.98 × mean` while the rung is not armed, the disarm level `1.02 × mean` while it is — so the printed distance is the
distance to the rung actually *changing*. The status also carries both levels, always.

**Equality does not arm it.** `close < 0.98 × mean` is strict; a close exactly on the arm level leaves the rung as it
was. `b1-equal` is the known-answer test for that.

### B2 — the monthly 10-month flip

`bust/triggers.js:45-50` `tenMonth`: judged at **month-ends only** and carried forward over the days between — IN iff
the month-end close is **strictly above** the mean of the last 10 month-end closes **including the current one**. The
same rule, in the same words, is in `plan-review/flip-levels.cjs:1-2`, `dalio-plan/trend-lag.cjs:3-5`,
`dalio-hedge/trend-status.cjs:3-4`, and live in `backend/book-etf-rebalancer.js:64`.

**Equality arms it**, because IN requires *strictly* above. `b2-equal` is the known-answer test for that.

A session is a month-end iff it is not the last session of the series and the next session falls in a different
calendar month (`bust/triggers.js:41` `isME`, `bust/now.js:8` `monthEnds`). **The last session is therefore never a
month-end** — the current month is still forming — so B2 reads the *last completed* month-end, exactly as the lenses
do. Beside it the monitor prints the **provisional** reading (`bust/now.js:15`): the forming month replaced by the
latest close, judged against the **flip level X\***, the mean of the 9 completed month-ends
(`plan-review/flip-levels.cjs:8`). That is the level the next month-end close will be judged against.

---

## The data it reads

Dividend-adjusted daily closes — the `a` field — from a store of one `<SYM>.json` per symbol, rows `{ d, c, a }`:
exactly the cache `docs/ai-bubble-2026-10/bust/fetch.js` writes, which is the default store (`--data <dir>` points it
elsewhere). **The monitor never fetches anything**; that fetcher fills the cache, at home. Symbols needed: `QQQ`,
`SPY`, `SMH`, `VWEHX`, `VFITX`.

- Rows with no finite `a` are dropped, as `bust/now.js:6` drops them. Rows out of order are sorted first. **Two rows
  for one date is refused** — never silently taken twice.
- `--as-of YYYY-MM-DD` is the lenses' `CUT` (`bust/triggers.js:22`): sessions after it are not read.
- **One missing or unreadable series stops the whole run** (exit 1, nothing computed). There is no half ladder.
- The status's **date** is the *oldest* last session over the store, and every series is trimmed to it, so one rung
  never speaks for a later day than another. A series that lags is named on its own line.
- The ratio series is taken only on the dates **both** series have (`flip-levels.cjs:13-14`).

### Too little history

A rung whose series cannot carry its rule — fewer than 200 closes, fewer than 10 completed month-ends — is reported
**NOT READ**, with `armed: null` and a note saying which. It is never reported "not armed": a rung that was not read is
not a rung that is quiet. The run still ends 0.

---

## The files

```
docs/ai-bubble-ladder-monitor/2026-10-16/
  NOTES.md                                        this
  base/NO-BASE-FILES.md                           why base/ is empty (both shipped files are new)
  staged/backend/ai-bubble-ladder.js              the rungs as arithmetic; reads series files, writes nothing
  staged/backend/ai-bubble-ladder-monitor.js      the daily reading; prints, and with --write writes one file
  deploy.cjs   --plan | --apply                   creates the two files (also the shared engine rollback.cjs uses)
  rollback.cjs --plan | --apply                   removes them again (their base is "not there")
  selftest.cjs                                    467 checks on synthetic closes; ends ALL <n> CHECKS PASSED
  mutants.cjs  [<id>...] | --list                 36 deliberate breaks, each against the checks that must catch it
  fixtures/specs.cjs                              the synthetic populations, as specs, with every derivation
  fixtures/make.cjs                               materialises one to a directory, to look at or run by hand
```

`staged/` holds the two files at their repo paths; `base/` is empty because neither exists at home yet (see
`base/NO-BASE-FILES.md`). Nothing in `staged/` reads anything under `fixtures/`, `selftest.cjs` or `mutants.cjs`.

### The commands

```
node backend/ai-bubble-ladder-monitor.js                      the reading. Writes nothing.
node backend/ai-bubble-ladder-monitor.js --write              the same, and the day's status in backend/data/
node backend/ai-bubble-ladder-monitor.js --as-of 2026-10-06   read as if that were the last session
node backend/ai-bubble-ladder-monitor.js --json               the whole status document instead of the summary
node backend/ai-bubble-ladder-monitor.js --data <dir>         read a different store (e.g. a fixture)
```

Exit 0 computed (and written) · 1 a series could not be read, or the write failed · 2 usage.

### The status file

`backend/data/ai-bubble-ladder-status.json`, written only with `--write`, through
`backend/lib/atomic-write.js` `writeJsonAtomic` — never with a shell redirection, a heredoc or a bare `writeFileSync`:

```
{ "spec": "ai-bubble-ladder-status-v1", "updatedAt": "...", "dates": ["2026-10-05", "2026-10-06"],
  "days": { "2026-10-06": { date, computedAt, cut, dataDir, series, behind, rungs: [ ... ], armed, armedCount,
                            available, unavailable, readOnly: true, summary: [ ... ] } } }
```

One key per date. A run **replaces that day's key and keeps every other date byte for byte**; running the same day
twice re-reads it and writes the same reading, with only its three timestamps moved (`updatedAt`, that day's
`computedAt`, and the `computed …` line inside `summary`) — the selftest proves the byte-for-byte form of this with a
frozen clock, which is the only sense in which it is byte-for-byte. A status file that does not parse is **never
replaced**: the run refuses (exit 1) and says so, because an unreadable file may be holding readings nobody has copied
yet.

---

## How it was proven

`node docs/ai-bubble-ladder-monitor/2026-10-16/selftest.cjs` → **ALL 467 CHECKS PASSED**.
`node docs/ai-bubble-ladder-monitor/2026-10-16/mutants.cjs` → **ALL 36 MUTANTS KILLED**.

Both make no network call, no broker call and no real-data read, and write nothing outside a scratch directory they
make and remove. The selftest copies the two staged files into a scratch `backend/` beside a copy of
`backend/lib/atomic-write.js` and a `package.json` with no `"type"` field — which is what `backend/package.json` is, so
they run there exactly as they will at home (the **root** `package.json` says `"type": "module"`, so a `.js` file left
under `docs/` would be read as an ES module, and these two are CommonJS).

### Known answers, two ways

Every rung of every fixture is checked twice over:

1. **Designed numbers.** Each fixture is built so the arithmetic can be done by hand, and the numbers are typed into
   the selftest as literals — never read back out of the code. The derivations are in `fixtures/specs.cjs`; here they
   are again:

   | fixture | the series | the arithmetic | the answer |
   |---|---|---|---|
   | `b1-cross` | QQQ: 199 sessions at 90, then 100s, **last session 97** | mean `(199×100 + 97)/200 = 99.985`; arm level `0.98 × 99.985 = 97.9853` | `97 < 97.9853` → **B1-QQQ ARMS**, and it was *not* armed the day before (window all 100, mean 100, arm level 98). **A crossing day.** |
   | `b1-no-cross` | the same, **last session 98** | mean `99.99`; arm level `97.9902` | `98 > 97.9902` by `0.0098` → **no arm**. **A no-crossing day**, one tick above. |
   | `b1-equal` | QQQ: 199 at 9000, then 9951s, **last 9751** | mean `(199×9951 + 9751)/200 = 9950` exactly; arm level `0.98 × 9950 = 9751` exactly | `9751 < 9751` is false → **no arm**: equality does not arm. |
   | `b2-cross` | QQQ months `100,101,…,122`, **last completed month-end 100** | last 10 month-ends incl. it `= (114+…+122 + 100)/10 = 116.2` | `100 ≤ 116.2` → **B2-QQQ ARMS** at that month-end; the one before did not (`122` vs `(113+…+122)/10 = 117.5`). **A crossing month-end.** |
   | | SPY months `100,…,122`, **last 140** | `(1062 + 140)/10 = 120.2` | `140 > 120.2` → **no arm** on the same month-end: the ladder reads rung by rung. |
   | `b2-no-cross` | QQQ, **last 119** | `(1062 + 119)/10 = 118.1` | `119 > 118.1` by `0.9` → **no arm**. **A no-crossing month-end.** |
   | `b2-equal` | QQQ, **last 118** | `(1062 + 118)/10 = 118.0` exactly | `118 ≤ 118` → **ARMS**: equality arms, because IN needs strictly above. |
   | `short` | 113 sessions over 6 calendar months | neither rule can be read | **every rung NOT READ** — not one reported "not armed". |
   | `lag` | `b1-cross`, but VFITX stops `2026-09-25` | the one day every series reaches is `2026-09-25` | the whole ladder is read as of that day, the lagging series is named, and **B1-QQQ is not armed** — its arming close is past the read window. |
   | `credit-gap` | VFITX missing `2026-05-29` and `2026-06-10` | the ratio is taken only on dates both have | its May month-end is `2026-05-28`; no session is ever divided by a price that is not there. |

   **Why the B1 fixtures start low.** The band's first reading, before it has a state to hold, is the plain
   `close > mean`. On a series flat for ever that is `100 > 100` = false, so such a series reads ARMED from its first
   reading and never leaves — and a "crossing day" built on it would prove nothing, because the rung was already armed
   the day before. Every B1 fixture therefore opens with 199 sessions at a lower level, so the first reading is plainly
   IN, the band holds it there through the flat run, and the last session is the one under test. (That property itself
   is a known-answer check: a flat 200-close series reads ARMED, and a flat run of month-ends sits exactly on its
   10-month mean, which arms B2 — which is why B2-QQQ and B2-SPY read ARMED in the B1 fixtures.)

2. **An independent re-derivation.** `refBand` and `refTenMonth` in the selftest are a second implementation of the two
   rules, written from `bust/triggers.js:41,44-57` and `:45-50` in a different style and sharing no code with the
   staged files. Every rung of every fixture must agree with them, on ARMED, on the value, on the threshold and on the
   flip level.

### What else the selftest proves

- **Read-only by construction.** The staged sources carry no `fetch(`, no `http`/`https`/`net`/`tls` require, no URL,
  no `writeFileSync`/`appendFileSync`/`renameSync`/`unlinkSync`/`mkdirSync`, no `child_process`, no spawn and no exec;
  they require nothing but `fs`, `path` and the one `atomic-write` helper; and the library does not even load that.
  No order-placing surface: no `/v2/orders`, no broker host, no `APCA-API`, no `time_in_force`, no `qty`, no key names.
- **No network.** The monitor runs to completion with `global.fetch` poisoned to throw.
- **It writes nothing unless told.** Every file under the scratch tree is hashed before and after: a run without
  `--write` changes **nothing at all**, and never reaches the write path; a run with `--write` changes **exactly one**
  file, leaves no `.tmp-` behind, and says which file it wrote and that nothing else was.
- **The dated status.** One key per date; the same day twice is idempotent; a second day joins the first and the first
  is kept byte for byte; re-running a day replaces only that day; an unparseable status file is never replaced; a
  failed write ends 1 with nothing written.
- **The summary.** Plain text only — no escape codes, no box drawing. Every rung on its own line, with ARMED or
  "not armed", its value and its threshold; each B2 line also carries the provisional reading and the flip level; the
  count of armed rungs by name; and the two lines saying this is a reading and no order was placed.
- **Bad input.** A missing store, a missing symbol, null closes, duplicate dates, rows out of order, the wrong price
  field, a bad `--as-of`, an unknown argument.
- **The package.** `deploy.cjs` pins the sha256 of each staged file; plan → apply → idempotent second apply →
  rollback → idempotent second rollback; a DRIFT file refuses both write modes and is never deleted; every fence
  (the close-chain window, each busy process, this process not counting, an unrelated process not counting, an
  unreadable process list failing closed); a gate that fails writes nothing; the gate passes only on exit 0 **and**
  `ALL n CHECKS PASSED` as the last line of stdout, never on stderr; a failed write removes every file the run
  created; `record.cjs --dry` has every write behind its `DRY` return.

### The mutation check

`mutants.cjs` serves the selftest 36 deliberately broken copies of the staged files, through the one env override
`AI_BUBBLE_LADDER_SELFTEST_STAGED` (`staged/` is never touched, and `deploy.cjs` **strips that variable from the
gate's child**, so the gate always judges the real bytes). A mutant counts as killed only when the selftest fails
**and** one of the checks named for it is among the failures — a mutant that merely knocks something unrelated over is
reported as *caught by the wrong check*, not as killed. The breaks include: arming on equality and not arming on
equality, in both rules; the band's two levels swapped; the band dropped; the first reading's inequality; a 199-day
mean; a 9-month mean; the current month-end left out of its own mean; the forming month counted as a month-end; the
flip level taken over 10 month-ends; the price close read instead of the adjusted one; `--as-of` ignored; duplicate
dates taken twice; the ratio taken on unaligned dates; a missing series skipped; the status dated the newest day; a
longer series not trimmed; an unread rung reported "not armed"; a write on a read-only run; a failed write reported as
a success; a bare `writeFileSync` in place of `writeJsonAtomic`; and a summary line missing its threshold or its
ARMED word.

Three cycles were run. Cycle 1 left 9 mutants alive or caught by the wrong check; the fixes were **to the selftest and
the fixtures, never to a rule**:

| what cycle 1 found | the fix |
|---|---|
| The first B1 fixtures were flat at 100, so the rung was **already armed** the day before the "crossing day" — the crossing day proved nothing. | The B1 fixtures now open with 199 lower sessions, so the first reading is IN. The flat-series behaviour became a known-answer check of its own. |
| Nothing exercised the first reading sitting *exactly* on its mean. | A check that a flat 200-close series reads ARMED. |
| `tenMonthTrend`'s own inequality was untested: only the rung's separate `armed` test was. | `b2-equal` now asserts `armedSince` is the equality month-end itself, and every rung is checked for `armed` ⇔ exactly one of `armedSince`/`notArmedSince`. |
| Nothing had a **gap** in the denominator series, so unaligned ratio dates never bit. | The `credit-gap` fixture. |
| Two mutants ended the selftest with a **throw**, hiding every check after it. | Every group now runs inside `T()`, which turns a throw into a named FAIL and carries on; the monitor-run helper turns a throw into an answer; the month-end check no longer indexes past the end. |
| One mutant was equivalent (it changed no behaviour). | Replaced with two that do: the B1 and B2 availability guards ignored. |
| Four `kills` regexes named too narrow a check. | Widened to the checks that actually catch each one. |

Cycle 2 (the builder's re-run of both checks after those fixes) found no survivor: **ALL 36 MUTANTS KILLED**,
**ALL 467 CHECKS PASSED**.

**Cycle 3 — the independent checker's run — reported AFTER the handover, with VERDICT: FAIL. Its findings are
recorded below under CHECKER REPORT and NONE of them has been fixed**, because the session was told to hand over and
not to start another cycle. Read that section before applying anything.

A separate read-only checker was started (every check
command, the rules re-read against the cited lines of `docs/ai-bubble-2026-10/`, the hard rules of `AGENTS.md`, its own
fresh mutations and its own crafted stores), but the session was handed over before its report arrived, so **nothing
in this package has been confirmed by anyone but its builder**. See **HANDOVER** below.

### Test edits

**None.** No test's rule, bar, population or read condition was changed to make anything pass, in this package or
anywhere else. Every check and every fixture here is new; the fixture changes above were made to *strengthen* the
population (a flat series that proved nothing was replaced by one that does), each time adding a known answer rather
than removing one. No test was weakened, skipped or deleted, and no registered test is touched: this package adds two
new files and changes none.

---

## Deploying it

```
node docs/ai-bubble-ladder-monitor/2026-10-16/deploy.cjs --plan     read-only: each file's state, and the fences now
node docs/ai-bubble-ladder-monitor/2026-10-16/deploy.cjs --apply    the write mode
```

`--apply` refuses, and writes nothing, if: either file is **DRIFT** (there, and not the staged bytes) or a staged copy
is not the sha256 pinned in `deploy.cjs`; the clock is inside **13:50–15:50 MT on a trading weekday** (the close chain
owns `backend/` then); either file of the unit or `automation/close-chain.cjs` is in the process list; the process list
cannot be read (fail-closed); or the selftest does not end `ALL n CHECKS PASSED` on exit 0. It asks the fences again
after the gate. Each file is written with a temp file and a rename, read back by sha256 and `node --check`ed; any
failure removes every file the run created.

It never requires `automation/close-chain.cjs` (it only looks for it in the process list), never touches
`backend/data`, the registry, the chain file, a switch or the server, and makes no network or broker call. The live
bytes are the whole state: this package keeps no state file.

### After the apply

1. `node backend/ai-bubble-ladder-monitor.js` — the reading, writing nothing. Compare it with
   `node docs/ai-bubble-2026-10/bust/now.js` over the same store: the same rules from the same cache, so the 200-day
   and 10-month lines should agree.
2. `node backend/ai-bubble-ladder-monitor.js --write` — the day's status in `backend/data/`.
3. `node docs/ai-bubble-ladder-monitor/2026-10-16/record.cjs --dry`, then without `--dry`, outside 13:50–15:50 MT on a
   trading weekday.
4. Confirm the `B1`/`B2` labels against the plan's write-up (see *What the code pins*). If they are the other way
   round, swap the two `level` fields in `LADDER` — nothing else changes.

**Nothing to restart, and nothing schedules it.** No running program requires these files and nothing was added to the
close chain: the monitor runs when the operator runs it. If it should run nightly, that is a separate change to the
chain, deliberately not in this package.

### Rolling back

```
node docs/ai-bubble-ladder-monitor/2026-10-16/rollback.cjs --plan | --apply
```

Both files are removed, which is their base. It refuses the whole unit if either is DRIFT, so it never deletes a file
it does not recognise, and it has the same fences. It leaves `backend/data/ai-bubble-ladder-status.json` — the
operator's own readings — where it is. If `record.cjs` has written its registry row, that row stays on record; it is
undone by hand, not by this script.

---

## HANDOVER

Handed over on 2026-10-16 on the operator's word ("stop now and hand over"), mid-loop: the builder finished two
cycles, and the independent checker's run was cut off before it reported. Branch `claude/ai-bubble-ladder-monitor`.
**Nothing here has been applied, scheduled or recorded, and nothing has been confirmed by anyone but the builder.**

### Done

1. **Read the ladder out of the code.** Both levels were taken from `docs/ai-bubble-2026-10/`, line by line, and
   every rung carries its source line in the code and in every written status. B1 = the daily 200-day ±2% band
   (`bust/triggers.js:51-57`, `plan-sizing.cjs:23-24`, `plan-review/precedent.cjs:9`) on QQQ, SPY, SMH. B2 = the
   monthly 10-month flip (`bust/triggers.js:50`, `plan-review/flip-levels.cjs:1-15`) on QQQ, SPY and VWEHX/VFITX.
2. **The monitor.** `staged/backend/ai-bubble-ladder.js` (the arithmetic; writes nothing) and
   `staged/backend/ai-bubble-ladder-monitor.js` (the reading: a plain summary, and with `--write` the dated status
   under its own date key through `writeJsonAtomic`). No order, no network, no broker, no account, no position; one
   file written and only when asked.
3. **The staged package.** `staged/`, an empty `base/` with the note saying why, `deploy.cjs --plan|--apply` with
   sha256 pins and fences, `rollback.cjs --plan|--apply`, `record.cjs --dry`, `selftest.cjs`, `mutants.cjs`,
   `fixtures/specs.cjs` + `make.cjs`, this `NOTES.md`.
4. **Tests on synthetic closes**, including a crossing day and a no-crossing day for *each* rung and both exact
   equality boundaries, with known answers twice over (hand-derived literals and an independent re-derivation of both
   rules). Full table in *Known answers, two ways*.
5. **Two build-check cycles** (cycle 1 found 9 live or wrongly-caught mutants; the fixes were to the selftest and the
   fixtures, never to a rule — see the table in *The mutation check*).
6. **No test edits.** Nothing was weakened, skipped or deleted; no registered test is touched; no test disappeared and
   the count only grew (284 → 430 → 467).

### Checks that pass, as run by the builder

| command | verdict |
|---|---|
| `node docs/ai-bubble-ladder-monitor/2026-10-16/selftest.cjs` | `ALL 467 CHECKS PASSED` (exit 0) |
| `node docs/ai-bubble-ladder-monitor/2026-10-16/mutants.cjs` | `ALL 36 MUTANTS KILLED` (exit 0, ~19 s) |
| `node docs/ai-bubble-ladder-monitor/2026-10-16/deploy.cjs --plan` | exit 0; both files `absent`; fences clear |
| `node docs/ai-bubble-ladder-monitor/2026-10-16/rollback.cjs --plan` | exit 0; nothing to remove |
| `node docs/ai-bubble-ladder-monitor/2026-10-16/record.cjs --dry` | exit 0; "WOULD THE WRITE GO THROUGH? NO" — correct here (this copy holds no `backend/data`) |
| `node --check` on every `.cjs` and both staged `.js` | clean |
| usage paths of `deploy.cjs` / `rollback.cjs` / `record.cjs` with no or bad arguments | exit 2, nothing done |

### Left to do, in order

1. **Re-run the two checks, unchanged, to confirm this branch as pushed:**
   `node docs/ai-bubble-ladder-monitor/2026-10-16/selftest.cjs` must end `ALL 467 CHECKS PASSED`, and
   `node docs/ai-bubble-ladder-monitor/2026-10-16/mutants.cjs` must end `ALL 36 MUTANTS KILLED`.
2. **Have an independent checker do cycle 3** — this is the step that was cut off, and it is the one thing the
   package's own claims rest on that nobody but the builder has tested. It should, read-only: run every check command
   above; re-read the cited lines of `docs/ai-bubble-2026-10/` and `backend/book-etf-rebalancer.js` and say, inequality
   by inequality, whether the staged B1 and B2 arithmetic is the same rule (the band's first reading and both its
   levels; whether the 10-month mean includes the current month-end; which comparisons are strict; whether the last
   session can be a month-end; whether the adjusted close is the input); check the hard rules of `AGENTS.md`; try at
   least ten mutations NOT in `mutants.cjs`'s list (the rounding `r4`/`r6`, `distanceToThresholdPct`, `runStart`,
   `trimSeries` boundaries, the status's `date` choice, `mergeStatus`, the argument parser, `readSeries`' behaviour for
   a row exactly ON the cut date, a zero or negative denominator in the ratio, a one-row series, a month with one
   session, a December-to-January boundary, the exit codes) through
   `AI_BUBBLE_LADDER_SELFTEST_STAGED=<a temp dir>`; and attack it with crafted stores rather than code edits (an empty
   array, a non-array, string closes, a missing `d`, a leap day, a symbol that is a directory). Any mutation the
   selftest does not catch is a hole in the selftest, not a reason to change a rule.
3. **Confirm the `B1`/`B2` labels against the plan's own write-up**,
   `docs/ai-bubble-contingency-plan-2026-10-07.md`, which is markdown and so is **not in this code-only copy**. The
   code pins both rules and all their arithmetic; it does not pin which level is numbered 1 and which 2. If the
   write-up numbers them the other way round, swap the two `level` fields in `LADDER` in
   `staged/backend/ai-bubble-ladder.js` — no threshold, no arithmetic and no test changes, and the selftest's rung-id
   check will need the two ids renamed with them. This is the one open question of substance; it is also listed under
   `owed` in `record.cjs`'s row.
4. **Then, at home and in this order:** `deploy.cjs --plan`, `deploy.cjs --apply`,
   `node backend/ai-bubble-ladder-monitor.js` and compare it against `node docs/ai-bubble-2026-10/bust/now.js` over
   the same store (the same rules from the same cache, so the 200-day and 10-month lines should agree),
   `node backend/ai-bubble-ladder-monitor.js --write`, then `record.cjs --dry` and `record.cjs`.
5. **Not done and deliberately not in this package:** nothing schedules the monitor. If it should run nightly, that is
   a separate change to the close chain, with its own package.

### Known limitations, stated rather than fixed

- The status file grows by one key a day and is never pruned. That is deliberate (a day is a few kB), but if it is to
  be kept for years it wants a retention rule, which this package does not have.
- The default store is the 10-07 research cache `docs/ai-bubble-2026-10/bust/data`, filled by
  `bust/fetch.js`. **The monitor never fetches**, so a daily reading is only as current as the last run of that
  fetcher; the monitor says so by naming its data directory and the day it read, and by naming any series that lags.
  Pointing it at a store the nightly chain refreshes would be a better home for it, and is a separate decision.
- `deploy.cjs` reads the process list with `powershell.exe Get-CimInstance` on win32 and `ps -eo pid=,command=`
  elsewhere. It was exercised on Linux here; at home (Windows) the powershell path has **not** been run, so the first
  `deploy.cjs --plan` at home should be read for a "process list cannot be read" refusal before `--apply` is tried.

---

## CHECKER REPORT (cycle 3) — received after the handover, NOTHING FIXED

An independent read-only checker ran after this session was told to hand over. **VERDICT: FAIL.** It changed nothing
in the repository (it worked in its own temp directory) and **none of its findings has been acted on** — no fix cycle
was started, by instruction. This section is its report, condensed; the numbering is its own.

It confirmed, independently: every check command passes with the verdict lines listed above; the `deploy.cjs` sha256
pins match `staged/`; the selftest and the mutation check write nothing inside the repository; every hard rule of
`AGENTS.md` is clear (no orders, no network or broker call anywhere in the package, no secrets, no personal details,
JSON only through `writeJsonAtomic`, nothing requiring `automation/close-chain.cjs`, no Node-24-only API); and both
rules match the lines they cite, inequality by inequality — the band's first reading and both its 0.98/1.02 levels,
the 10-month mean including its own current month-end, which comparisons are strict, the last session never being a
month-end, and the dividend-adjusted close as the input. It re-derived eight of the known-answer numbers above by hand
and found each one right, including that `b1-equal`'s `0.98 × 9950 = 9751` really is exact in floating point.

It also found that this file, in the commit handed to it, still claimed its own run had found no survivor. That
sentence was false and has been corrected (above).

### What is actually wrong

**1. (Real defect, not fixed.) B2's `armed` is decided on 4-decimal-ROUNDED numbers, so it disagrees with the rule it
cites.** `staged/backend/ai-bubble-ladder.js:258-261` rounds both `value` and `threshold` with `r4` and then compares
them, while `bust/triggers.js:50`, the live `backend/book-etf-rebalancer.js:64` and the selftest's own reference
implementation all compare raw values. On a store whose last month-end is `100.00002` against a mean of `100.000002`,
the source rule reads IN and this monitor prints **ARMED** — a false arm on the slow rung, and it is internally
inconsistent there too (`tenMonthTrend` reads IN while `rung.armed` is true, so `armedSince` names the start of a run
of *not-armed* readings). Values near a 10-month mean at that distance are a live possibility on the VWEHX/VFITX ratio.
**The fix is one line** — compare the raw numbers and keep `r4` for presentation only:
`out.armed = s.values[last] <= mean;` — **plus a fixture whose last month-end sits a hair above its mean**, asserted
against `refTenMonth`. No mutant in `mutants.cjs` covers this; the checker's mutation that restored the source rule
*survived* all 467 checks, which is how it was found.

**2. The provisional arming decision has no test at all.** `armedIfMonthEndedToday`
(`staged/backend/ai-bubble-ladder.js:272`) appears nowhere in `selftest.cjs`. Flipping its `<=` to `<` survives, and
`b1-cross`'s B2-SPY sits exactly on equality, so the mutant silently inverts a printed line in a shipped fixture.
Three checks close it: the latest close above X*, below X*, and exactly on X* (which must read "would ARM", since
`now.js:15`'s IN test is strict).

**3. B2's distance percentages are effectively unchecked.** The only assertion is `=== 0` in `b2-equal`, which is
invariant both to dropping the `× 100` and to using the wrong denominator; both mutations survive. B1's equivalent is
properly checked. Assert `b2-no-cross`'s `+0.762066%` and `b2-cross`'s provisional `−14.122137%` as literals.

**4. Five correct guards ship unproven** (each mutation survived; the checker verified by hand that the real code is
right, so these are selftest holes, not defects): only `ENOENT` counting as "no status file" (`monitor.js:64` — the
guard this file's promise about uncopied readings rests on), the `doc.spec` check and `updatedAt` in `mergeStatus`,
the zero-denominator guard in `ratioSeries`, and the empty-series `armed: null` path.

**5. `--out` and `--data` swallow a following flag.** `monitor.js:54-55`: `--out --write` yields a read-only run with
`out` set to a file literally named `--write`; `--out --json` loses `--json`. `--as-of` is protected only incidentally,
by its date regex. Reject any value matching `/^--/` in all three branches.

**6. `--as-of` accepts impossible dates.** `monitor.js:53` checks shape only, so `--as-of 2026-13-01` is accepted and,
being lexically above every stored date, applies **no cut at all** — the opposite of what was asked — and is stored as
the status's `cut`. `2026-00-15` reads as of 2025-12-31. Validate that the date round-trips.

**7. One negative adjusted close arms B2-CREDIT.** `ai-bubble-ladder.js:179` rejects a zero denominator but not a
negative one, so a single corrupt VFITX bar prints `B2-CREDIT ARMED … -1.2300 vs 10-mo mean 0.9840 (-225.00%)` and
exits 0. This is what `flip-levels.cjs` would do, so it is not a rule divergence — but reject `q <= 0` (and the
numerator) and name the dropped session.

**8. A dropped denominator silently moves the credit rung's month-end.** With VFITX unusable on 2026-09-30, B2-CREDIT's
"last completed month-end" becomes 2026-09-29, judged against a different window, with nothing said beyond the printed
date. Count and print the dropped dates, as `behind` does for lagging series.

**9. Month-end misalignment between the two B2 rungs is not reported.** `behind` compares last *sessions*, so with a
long hole in one series B2-QQQ can read a 2025 month-end while B2-SPY reads 2026-09-30 on the same status, and nothing
fires. The promise above that "one rung never speaks for a later day than another" holds for sessions, not month-ends.

**10. `behind`'s wording is backwards when one series runs AHEAD.** `ai-bubble-ladder.js:297`: with QQQ running 16
months past the rest, the summary names the four *other* symbols as laggards and never prints the one fact that
matters. Name the series that runs past the status date instead.

**11. Disclosure gap, not a defect.** On a month-end day the live `book-etf-rebalancer.js:64` keys by `YYYY-MM` and so
uses *that day's* bar as the current month-end, while this monitor (faithfully following `bust/triggers.js:41`) reads
the month before. On the one day a month the operator would most want to compare them, they read different month-ends.
This file cites that line as "the same rule, in the same words"; it should say so.

Also noted, lower value: `--out` is not absolutised in one path, and there is no fixture crossing a
December-to-January month boundary.

### What this does to the order of work

**Finding 1 comes first and must be fixed before this package is applied** — it is a wrong answer on a shipped rung,
and fixing it is one line plus one fixture. Findings 2, 3 and 4 are selftest holes of the kind the loop exists to
close, and should be closed in the same cycle, since each one is a check that would have caught something. Findings 5
to 10 are robustness and wording; 11 is a line of prose. **None of them is a reason to change a rule**, and the
checker says so explicitly: a mutation the selftest does not catch is a hole in the selftest.

The *Left to do* list above stands, with these inserted ahead of it: fix Finding 1 and add its fixture; close the
holes behind Findings 2-4; re-run both checks (the count must only grow, and `mutants.cjs` should gain the checker's
surviving mutations — at least the restored-source-rule one from Finding 1 and the provisional `<=` from Finding 2);
then have the checker look again. Only then items 3 and 4 of *Left to do* (the B1/B2 label confirmation, and the apply
at home).
