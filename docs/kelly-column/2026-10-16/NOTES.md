# Kelly column — 2026-10-16 (backlog row 23)

A staged package. Built in a cloud build session; the operator re-checks it and runs `--apply` at home. Nothing here deploys,
restarts or schedules anything, places an order, calls a broker, reaches the network or reads a key.

## What it ships

Two files.

| file | state | what it is |
| --- | --- | --- |
| `backend/lib/kelly.js` | **new** | `kellyLine(returns per clustering unit)` and `clusterReturnsOf(obj)`. Pure, no I/O, never throws. |
| `backend/progress-tests.js` | changed | the shared read printer. The sealed-read table gets **one extra column** and nothing else. |

`base/` holds the byte-exact copy of `backend/progress-tests.js` this change starts from
(sha256 `00aac7f6409e6890e3e318531ff8fe8feb902229ee783b9c2492386302e250e4`). `backend/lib/kelly.js` has no `base/` copy because it
does not exist at home yet: its `baseSha` is `null`, the deploy refuses if a file of that name is already there, and the rollback
removes it again.

## The library

`kellyLine(returns, { conf = 0.80, round = 3 })`, where `returns` is the read's returns **per clustering unit** — the same
per-unit numbers its own t is computed from (sessions, months, auctions, meetings, event-days). Not per-ticket returns: tickets
inside a unit are not independent, and the caller owns the unit here as everywhere else in this repository.

- `full` = mean / variance, **capped at 1.0 and floored at 0**. `rawFull` is the same before the cap and the floor.
- `half` = `full / 2` — half of the **capped** fraction, so it is always in `[0, 0.5]`.
- `shrunkFull` = the same arithmetic on the **lower end of the mean's two-sided 80% confidence interval**,
  `meanLo = mean - z · sd / sqrt(n)` with `z = probit(0.90)`, then capped and floored the same way. `shrunkHalf = shrunkFull / 2`.
- The **variance is not shrunk**: only the mean is uncertain here, and shrinking the variance would *raise* the fraction.
- `variance` is the **sample** variance (`n - 1`), as `lib/progress-score.js ci95` and `lib/selection-luck.js sd` use.
- `z` comes from `lib/selection-luck.js probit` (Acklam's inverse normal): `probit(0.90) = 1.2815515641…` against the textbook
  `1.2815515655446…`, an absolute error of 1.4e-9. That is 1.4e-9 of one standard error on the mean — far below anything the
  third decimal of a printed fraction can show.
- `text` is the printed line: `full 0.250 / half 0.125 · shrunk 0.036 / 0.018 · n 9`.
- The `lib/selection-luck.js` contract, which this follows: **never throws on bad input**. A call that cannot answer returns the
  result shape with `null` values and a `reason` string; on success `reason` is `null`. A printer must never be the reason an
  email fails to build.

`clusterReturnsOf(obj)` finds a read's per-unit returns **by name, never by shape**: the keys `clusterReturns`, `clusterMeans`,
`unitMeans`, `sessionMeans`, `dayMeans`, `weekMeans`, `monthMeans`, at the top level, then inside `latest`, `primary`, `result`,
`summary`. Both lists are closed and ordered; a new name is added there on purpose.

## The printer

`backend/progress-tests.js` is where sealed reads print their table — the READS section of the daily progress email, built from
`backend/data/read-seals.json`. The change is four edits:

1. `const K = require("./lib/kelly.js");`
2. two helpers: `rdOutput(rel)` (a read's own output file, **only** when the seal names a path under `backend/data`) and
   `kellyCell(v)` (the cell text, or an em dash);
3. `<th>Kelly (descriptive)</th>` appended to the header row;
4. `<td>${kellyCell(v)}</td>` appended to each seal row, and the empty-day row's `colspan="3"` becomes `colspan="4"`.

Where the returns come from, in order: the seal's own (`v.clusterReturns`, or any other `CLUSTER_KEYS` name), then the read's
output file as the seal names it (`v.output`, e.g. `data/r311-read.json`). A path that is not a `.json` under `data/`, or that
climbs out of it, is refused and never opened. A read with no per-unit returns, a corrupt or missing output file, one clustering
unit, a non-finite number, or no variance at all shows `—`.

**It is descriptive and nothing else.** No verdict, bar, sample or statistic is computed from it or changed by it; nothing sizes
from it; no registered rule, population or read condition reads it. It is capped, floored, shown beside its shrunk twin and
headed "Kelly (descriptive)" because a fraction printed next to a verdict can still be read as advice.

## What is proven, and how

`node docs/kelly-column/2026-10-16/selftest.cjs` — scratch trees in the OS temp folder, no repo write, no network, no key. It
ends `ALL <n> CHECKS PASSED`.

- **A — the package.** The base copy is the bytes the deploy was built against; home reads base; `backend/lib/kelly.js` is absent
  at home; every staged sha in `deploy.cjs` matches disk (`sync-shas.cjs --check`); every file parses; the staged printer removes
  exactly three lines and keeps every other line of the base printer in order; nothing added is a comparison or a threshold;
  neither staged file touches the network, a key, a broker or `process.env`; `lib/kelly.js` does no I/O at all.
- **B — known answers by hand.** `[5, -3, 1 ×7]` is n 9, mean 1, SS 32, sample variance 4, sd 2, se 2/3 — every one of those by
  hand, then full 0.25, half 0.125, `meanLo = 1 − z·(2/3)`, shrunk 0.0364. A second hand case (mean 2, variance 16). The **cap**
  (`[0.01, 0.02, 0.03, 0.04]`: raw 150, full 1.000, half 0.500 — half of the capped fraction, not 75). The **floor** (`[-1,-2,-3]`:
  raw −2, full 0). `z`, `conf 0.95`, `shrunk ≤ full` over 200 random samples, the `n−1` denominator shown to differ from `n`,
  every bad input answered with a reason and never a throw, `clusterReturnsOf`'s key order and refusals, and B18 below.
- **C — the byte-identity proof.** The **base** printer and the **staged** printer are run over the **same** fixtures: thirteen
  sealed reads covering every shape (returns on the seal, returns in the output file, both at once, no returns, zero variance,
  one unit, a non-finite number, a missing output file, a corrupt one, a path that climbs out of `data/`, an absolute path, a
  verdict full of `& < > "`), plus the empty-table day, plus the READY / ACCRUING / chain / ops / WAITING-ON-YOU sections. Then:
  - the staged HTML with the new column **mechanically removed** — one `<th>`, the last `<td>` of each row, `colspan` 4 → 3 — is
    the base HTML **byte for byte**, and the removals are counted (1 header, 13 cells, 0 colspans; 1 / 0 / 1 on the empty day);
  - every row has three cells before and four after, and the first three are **equal cell by cell**;
  - `summary`, `sealedToday`, `ready`, `waiting` and the returned object's key order are unchanged;
  - the column is **not vacuous**: the five reads that carry returns print the hand-computed line, the other eight an em dash;
  - changing one read's returns changes its Kelly cell **and nothing else** in the document.
- **D — deploy and rollback** on scratch repos: new + base → staged → back byte-exact (and the new file removed again); a second
  apply and a second rollback write nothing; drift refused on the changed file and on the new one; a missing live file; a red
  gate; the clock, chain and process fences, including failing closed when the process list cannot be read; a tampered staged
  copy refuses an apply but does not stop a rollback; a tampered base copy stops the rollback.
- **E — mutation.** Thirteen mutants of `lib/kelly.js` (cap removed, floor removed, both removed, population variance, the upper
  end of the interval, half of the uncapped fraction, the shrunk fraction over the sd, the se without `sqrt(n)`, a zero variance
  let through, one unit let through, a 90% interval, `clusterReturnsOf` taking a single value, its key order swapped) and eight
  of the printer (the Kelly line folded into the verdict cell, the colspan left at 3, the header dropped, a reason in place of the
  em dash, the seal's own series no longer beating its output file, the output-path guard removed, a 99% interval at the call
  site, the sample cell fed from Kelly). Each one is re-run through the **same** checks of B and C, and the check that catches it
  is named in the output. A control re-runs the unmutated files through both sets, so a mutation test that could not pass proves
  nothing.

  **One mutant was tried and dropped, on purpose:** removing `esc()` from the Kelly cell changes no byte of any output, because
  the line is drawn from a closed character set — digits, `.`, `/`, `·`, spaces and the words `full`, `half`, `shrunk`, `n` —
  that `esc()` never touches. That is a property, not a hole, so it is checked directly instead (**B18**: over 500 random
  samples and every extreme — `1e308`, `1e-308`, `round` 0 and 12, `conf` 0.5 and 0.999 — the line matches a fixed shape and
  contains no `&`, `<` or `>`). The `esc()` call stays anyway: the printer should not depend on a library keeping its character
  set.
- **F — record.cjs**: `--dry` writes nothing; the write adds one row and one GOVERNANCE line, each read back; a second run is
  "already recorded"; the 13:50–15:50 MT window, another writer's lock (never removed), home not applied, half a record already
  there. Plus `--dry` against this tree, which refuses because there is no data here.

## Tests

No registered test's rule, bar, population or read condition is touched, and no test was weakened, skipped or deleted. No
existing test file was edited at all. What is added: `docs/kelly-column/2026-10-16/selftest.cjs`.

Baselines in this clean copy, before and after this change (unchanged by it — they fail for want of data, which README.md says is
expected here, not for anything this package does):

| command | before | after |
| --- | --- | --- |
| `node backend/test/stats.test.js` | passes | passes |
| `node backend/test/evalue.test.js` | passes | passes |
| `node backend/test/atomic.test.js` | passes | passes |
| `node backend/test/pipeline.test.js` | passes | passes |
| `node backend/lib/selection-luck.test.js` | passes | passes |
| `node backend/test/run.js` | crashes in `verify.test.js`: `backend/test/fixtures/nq-1m-2026-09-21.json` is not in the clean copy | the same |
| `node docs/procedures/lint.cjs` | `PROCEDURES FAIL (6 problems)`: `docs/procedures/sources.json` and `automation/close-chain.cjs` are not in the clean copy | the same |

## Running it

```
node docs/kelly-column/2026-10-16/selftest.cjs        # everything above; ends "ALL <n> CHECKS PASSED"
node docs/kelly-column/2026-10-16/deploy.cjs --plan   # read-only: each file's sha256 now / base / staged, its state, the fences
node docs/kelly-column/2026-10-16/deploy.cjs --apply  # the operator's command at home (selftest-gated, fenced, drift-refusing)
node docs/kelly-column/2026-10-16/record.cjs --dry    # the two records it would write
node docs/kelly-column/2026-10-16/record.cjs          # write them, after the apply
node docs/kelly-column/2026-10-16/rollback.cjs --plan # read-only
node docs/kelly-column/2026-10-16/rollback.cjs --apply
node docs/kelly-column/2026-10-16/sync-shas.cjs --check   # build-time: the staged shas in deploy.cjs against disk
```

`--apply` is refused on a trading weekday between 05:30 and 16:00 MT, while tonight's close chain is due or running, while the
close chain or the progress email is running, when the process list cannot be read, on drift, and when the selftest does not end
`ALL … CHECKS PASSED`. Any failure mid-write puts every file back to the bytes it had (a file that did not exist is removed
again).

## What a rollback does not undo

An email already sent with the column in it — it was descriptive, and no verdict, bar, sample or statistic in it came from the
column — and the `record.cjs` rows, which are never removed: a rollback after a record is said in a **new** change-registry row.

## Known limits

- **Nothing writes `clusterReturns` yet.** No read seals its per-unit series today, so on the real
  `backend/data/read-seals.json` the column fills only for reads whose `output` file already carries one of the `CLUSTER_KEYS`
  names; the rest show `—`. Having a read seal its own series is a change to that read, not to the printer, and is not in this
  package.
- **The seal's `unit` is not checked against the series.** The column prints what it is given; if a read ever stored per-ticket
  returns under one of those key names, the fraction would be as overstated as a per-ticket t. The key list is closed for exactly
  that reason.
- **Kelly assumes a repeated bet with these returns as its distribution.** A per-unit mean over a few dozen units is a thin basis
  for that, which is why the shrunk pair is printed beside the point estimate and why the cap is 1.0.

## HANDOVER

Written 2026-10-16, when the session was told to stop. **The build-check loop was stopped after ONE builder pass; the
independent checker's first cycle had been started and had NOT reported when this was written.** Nothing here has been checked by
anyone but the builder. Read the "left to do" list before trusting any of it.

### Done

1. `staged/backend/lib/kelly.js` — new library. `kellyLine(returns, { conf = 0.80, round = 3 })` and `clusterReturnsOf(obj)`.
   Full and half Kelly (mean over the sample variance, capped at 1.0, floored at 0; half is half of the **capped** value) and the
   shrunk pair on the lower end of the mean's **two-sided** 80% CI (`mean − probit(0.90)·sd/√n`; the variance is not shrunk).
   Pure, no I/O, never throws: bad input returns nulls and a `reason`.
2. `staged/backend/progress-tests.js` — the shared read printer, with **one extra column** in the sealed-read table and nothing
   else. Four edits: the `require`, two helpers (`rdOutput`, `kellyCell`), `<th>Kelly (descriptive)</th>`, and
   `<td>${kellyCell(v)}</td>` plus `colspan` 3 → 4 on the empty-day row. `base/backend/progress-tests.js` is the byte-exact live
   file it starts from.
3. `deploy.cjs --plan | --apply` — drift refusal on both files (including DRIFT on the NEW file when home already has one),
   clock / chain / process fences, the selftest as a gate, temp-file-and-rename writes read back by sha256, `node --check` after
   each write, and full restore of every file on any failure. `rollback.cjs --plan | --apply` — the printer back from `base/`
   byte for byte and `backend/lib/kelly.js` removed again. `record.cjs --dry` and the write. `sync-shas.cjs --check`.
4. `selftest.cjs` — 96 checks on fixtures it builds in the OS temp folder. No network, no keys, no broker, no orders, no repo
   write, and it cleans up after itself. Sections A–F as described above; section C is the byte-identity proof and section E the
   mutation pass.
5. `NOTES.md` — this file.

### Checks that pass (builder's run, 2026-10-16, Node 22.22.0)

| command | result |
| --- | --- |
| `node docs/kelly-column/2026-10-16/selftest.cjs` | **ALL 96 CHECKS PASSED**, exit 0 |
| `node docs/kelly-column/2026-10-16/sync-shas.cjs --check` | every staged sha matches disk, exit 0 |
| `node docs/kelly-column/2026-10-16/deploy.cjs --plan` | exit 0; `kelly.js` new, `progress-tests.js` base; the only fence firing is the 05:30–16:00 MT clock, which is correct for the hour it was run |
| `node docs/kelly-column/2026-10-16/rollback.cjs --plan` | exit 0; nothing to put back |
| `node docs/kelly-column/2026-10-16/deploy.cjs` (no args) | usage, exit 2 |
| `node --check` on every file in the package | passes |
| `node backend/test/stats.test.js`, `evalue.test.js`, `atomic.test.js`, `pipeline.test.js` | pass, exit 0 |
| `node backend/lib/selection-luck.test.js` | passes |
| `git status --porcelain` after running everything | only this package; no repo file written |

Unchanged from baseline, and failing for want of data this clean copy does not carry (README.md says that is expected):
`node backend/test/run.js` crashes in `verify.test.js` on the missing `backend/test/fixtures/nq-1m-2026-09-21.json`;
`node docs/procedures/lint.cjs` reports `PROCEDURES FAIL (6 problems)` for the missing `docs/procedures/sources.json` and
`automation/close-chain.cjs`. Neither is touched by this package.

Two defects were found by the builder's own mutation pass and fixed before this commit: `record.cjs --dry` exits 2 in a clean
copy (correct — `change-registry.json` cannot be read — the check was wrong, not the code), and the mutant that removes `esc()`
from the Kelly cell is **undetectable**, so it was replaced by B18, which proves directly that the line needs no escaping.

### Left to do, in order

1. **Run the independent check cycle.** It was started and never reported. A second pair of eyes must run every command above,
   re-derive the byte-identity claim with fixtures of its own (not this selftest's), and try its own mutants. Until then this
   package has had one builder pass and no check pass, which is not what the house build-check loop requires.
2. **Specifically ask the checker to attack these**, which the builder did not prove:
   - fixture shapes the byte-identity proof has not met: a verdict containing the literal `</td></tr>`, `<td>`, `&mdash;` or
     `colspan="4"`; a seal id or `unit` with HTML in it; a `verdict` that is `null`, a number or an object; a `read-seals.json`
     whose `tests` is an array or `null`; a seal key of `__proto__` or `constructor`;
   - whether `stripKellyColumn` in the selftest could **mask** a real difference rather than reveal one — construct a staged
     printer that alters a verdict cell and confirm section C fails;
   - the `rdOutput` guard against paths such as `data/x.json/../../y.json`, backslashes, percent-encoding and unicode;
   - `clusterReturnsOf` against an inherited property rather than an own one.
3. **Decide the one-sided / two-sided reading.** "the lower end of the mean's 80% confidence interval" is implemented as the
   lower end of a **two-sided** 80% interval, `z = probit(0.90) = 1.2816`. If the operator meant a one-sided 80% bound, `z` is
   `probit(0.80) = 0.8416` and every shrunk number here is too conservative. One line in `kelly.js` (`Z80`) and the B3/B4/B5/B8
   expected values change. **This is a spec question, not a bug — ask before changing it.**
4. **Re-run `sync-shas.cjs` and the selftest** after any change to a staged file, and re-stamp `deploy.cjs`.
5. **Nothing is applied.** `deploy.cjs --apply` has never been run against a real tree, only against scratch repos in the
   selftest. The operator applies at home, outside 05:30–16:00 MT and after the close chain, then `record.cjs --dry`, then
   `record.cjs`.
6. **Optional, not in this package:** have one or two reads seal their own per-unit series under `clusterReturns`, so the column
   fills for more than the handful of reads whose output file already carries a recognised key. That is a change to those reads.
