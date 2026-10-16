# Capital model — measured cost (work order 4.13)

Staged package, built 2026-10-16 in a cloud build session, branch `claude/capital-model-measured-cost`.
Nothing here was applied. The operator applies it at home with `deploy.cjs --apply`.

## What it does

Plan E's capital model prices every trade from three **assumed** rates, which is all the repo ever had:

| leg | what pays it | as coded | in the file's unit |
|---|---|---|---|
| equity trend sleeves (QQQ, SPY, GLD, EFA) | `trendMonthly` charges `flipCost` once at each flip, and a flip is **one side** (into cash, or back out) | `0.0005` | `equityBpsPerSide: 5` |
| crypto (BTC, ETH, 50-day rule) | `cryptoDailyPY` charges `switchCost` at **each switch**, which is also one side | `0.0025` a switch | `cryptoBpsPerRoundTrip: 50` |
| ZN month-end window | the cost is **already subtracted** from each stored window (`futures-month-end.json` `rowsOut.tre`, and the month `znWindows()` builds itself, both take `0.0004` off) | `0.0004` a window | `znBpsPerRoundTrip: 4` |

DBMF is held, never flipped, and pays nothing here. Cash pays nothing.

The package adds a **measured-cost mode**:

```
node backend/profit-program/planE-baseline.js                              # unchanged, byte for byte
node backend/profit-program/planE-baseline.js --measured-costs <file>      # new
```

with a small JSON file (`example-measured-costs.json` here shows the shape — its numbers are made up):

```json
{ "spec": "planE-measured-costs-v1", "measuredAt": "2026-10-16", "source": "...",
  "equityBpsPerSide": 3.4, "cryptoBpsPerRoundTrip": 38, "znBpsPerRoundTrip": 6.5 }
```

With the file, one block is printed before the `wrote …` line and one key (`measuredCosts`) is added at the **end** of
`backend/data/profit-program/planE-baseline.json`. The block gives, for plan E and plan D2, **the yearly return, the worst month and
the worst month-end drop** under the assumed rates and under the measured ones, each at **cost ×1, ×1.5 and ×2** — twelve rows.

Two readings make the table safe to quote:

* the **assumed ×1** rows are the script's own PY table, recomputed through the same code path (E 24.24 / D2 28.16 on the real inputs):
  the measured rows differ from the model's headline by the cost and by nothing else;
* a measured file holding **the assumed rates** (5 / 50 / 4) reproduces the assumed rows exactly — which is what fixes the per-side vs
  per-round-trip units, the one place a reader could be off by a factor of two.

## The default is byte-identical

The work order asks the default output to stay byte-identical when no measured-cost file is given, and `selftest.cjs` proves it rather
than asserting it: it builds two trees, one with the package's `base/` files (the live code) and one with the `staged/` files, runs the
real `planE-baseline.js` in each with no argument, and compares **stdout, stderr and the written `planE-baseline.json` byte for byte**.
It then runs the staged script with `--measured-costs`, removes the one printed block, and compares with the default stdout again; and
deletes the one new JSON key and compares with the default JSON again. `py.E.annualReturnPct` — what `backend/risk-manager.js`
`planEStated()` reads — is the same number in both modes.

`node docs/capital-model-measured-cost/2026-10-16/selftest.cjs` → `ALL 55 CHECKS PASSED` (about 12 s, offline).

## What is missing from this clean copy

This repository is a code-only copy (README.md, "What is not here"), so **every data file the model reads is absent**:

* `backend/data/profit-program/planE-inputs.json` — the input cache (bars, the two crypto series, the calendar)
* `backend/data/futures-month-end.json` — the real ZN month-end windows (`rowsOut`)
* `backend/data/futures-daily/ZN.json` — the Schwab ZN daily store, from which `znWindows()` builds the latest month
* `backend/data/training/fred/DTB3.csv` — the 3-month T-bill
* `backend/data/profit-program/planE-baseline.json` — the model's own output
* `backend/data/change-registry.json`, `backend/data/agent-ledger.jsonl` — so `record.cjs --dry` prints both records and then says the
  write would be refused (that is what it does here; at home both files exist)
* `automation/close-chain.cjs` and `docs/profit-fixes/2026-10-12/b-plan-e/fixtures/` — not here either; the deploy's chain fence
  therefore reads `backend/data/chain-status.json` and the process list rather than the chain's own code, and this package builds its
  own fixture instead of reusing profit-fixes B's

**Nothing was added to fill those gaps.** `make-fixture.cjs` builds a **synthetic** tree in a temp directory instead: prices are a seeded
random walk started at 100 (BTC 1000, ETH 100), the T-bill is a seeded saw-tooth, the ZN windows are seeded numbers. It is not market
data and must never be read as any. Two knobs (`alpha` on the note windows, `beta` on the risky drift) were solved once, at build time,
so the fixture satisfies `planE-baseline.js`'s **own** asserts (PY E 24.24 %/yr and D2 28.16 %/yr within 0.05) — otherwise the script
stops at its assert and the two scripts could not be compared end to end. The knobs and the sha256 of every generated file are frozen in
`fixtures/fixture-spec.json`; the generator uses the four arithmetic operations and an integer PRNG only, so the bytes are the same on
every machine, and the selftest checks them.

**Not proven here, and owed at home:** that the real `planE-baseline.js` run on the real inputs is byte-identical before and after. The
selftest proves it on the fixture; the operator should run `planE-baseline.js` once **before** the apply, keep that stdout and that
`planE-baseline.json`, and compare after the apply. The numbers are the same by construction (the default code path is untouched), but
the real data is the only place that can be shown.

## What is assumed

* Every stored ZN month-end window carries **exactly 4 bps** of round-trip cost. `futures-month-end.js` is the file that subtracts it and
  `znWindows()` does the same for the month it builds; the staged `repriceZnRows(rows, bps, carriedBps = 4)` adds that 4 bps back and
  takes the measured one off. If some stored row ever carried a different figure, this is the line to change — it is the one assumption
  the measured mode makes about data it cannot see from here.
* At the carried rate the ZN rows come back with their stored `tre` untouched (not `tre + d - d`), so "measured = assumed" is exact to
  the last bit and not merely to two decimals.
* The **RM proxy family** (`rmRows` / `rmDaily`, the daily table the baseline also prints) is **not** re-priced. Its costs — 25 bps a
  crypto switch, `0.0004 × ZN_LEV / 2` at each window edge — live inside the text of `backend/risk-manager.js`, which the model reads
  verbatim and never edits. Re-pricing it would mean patching that text, which is a different change with a different risk.
* `measuredCosts` is added to `planE-baseline.json` rather than written to a file of its own, so one run holds both readings. Every key
  that was there before keeps its value and its place, and the new key is last.

## The package

| file | what it is |
|---|---|
| `base/backend/profit-program/planE-model.js`, `…/planE-baseline.js` | byte-exact copies of the live files this starts from |
| `staged/…` | the two changed files, at their repo paths |
| `deploy.cjs --plan \| --apply` | the plan (sha256 now / base / staged, state, fences) and the write mode; refuses on DRIFT |
| `rollback.cjs --plan \| --apply` | puts the base copies back, byte for byte |
| `selftest.cjs` | 55 checks on the synthetic fixture; ends `ALL 55 CHECKS PASSED` |
| `mutants.cjs` | 20 deliberate breakages of the staged code; each must be caught by the selftest |
| `make-fixture.cjs`, `fixtures/fixture-spec.json` | the fixture generator and its frozen seeds, knobs, shas and known answers |
| `record.cjs --dry` / `record.cjs` | the change-registry row and the agent-ledger GOVERNANCE line |
| `stamp.cjs --check \| --write` | keeps `deploy.cjs`'s staged sha256s in step with the staged files |
| `example-measured-costs.json` | the shape of a measured-cost file (made-up numbers) |

### The two files change as follows

`backend/profit-program/planE-model.js` — **additive only**. Everything above the new section is untouched; the header gains a paragraph.
New: `ASSUMED_COSTS`, `COST_SPEC`, `COST_KEYS`, `COST_META_KEYS`, `COST_MAX_BPS`, `COST_MULTS`, `parseMeasuredCosts`,
`loadMeasuredCosts`, `scaleCosts`, `costOpts`, `repriceZnRows`, `costScenario`, `costCompare`, `costTableLines`, all exported. No
existing function changed, no existing export removed (the selftest checks both, and checks that the two libraries answer the same for
`pyBuild`, `znWindows` and `tbillByMonth`).

`backend/profit-program/planE-baseline.js` — the header, an argument parser (`--measured-costs <file>`, anything else is refused with the
usage, exit 2), the measured block before the write, and the `measuredCosts` key. With no argument, no new code runs at all.

### Refusals

A measured-cost file is read **before** anything is computed, and the run is refused (exit 2, nothing printed on stdout, nothing written)
when: the file cannot be read; it is not JSON, or not a JSON object; `spec` is not `planE-measured-costs-v1`; a rate is missing,
misspelled (an unknown key is refused rather than silently priced at the assumed rate), negative, not a finite number, or above
1000 bps (a percent written as basis points). Strictness is the point: a half-priced leg that says nothing is the one failure this mode
must not have.

### How it was checked

Build-check loop, as AGENTS.md asks: the builder wrote the package and a separate checker ran every check read-only and tried its own
mutations. Commands, all offline:

```
node docs/capital-model-measured-cost/2026-10-16/deploy.cjs --plan
node docs/capital-model-measured-cost/2026-10-16/rollback.cjs --plan
node docs/capital-model-measured-cost/2026-10-16/selftest.cjs            # ALL 55 CHECKS PASSED
node docs/capital-model-measured-cost/2026-10-16/mutants.cjs             # ALL 20 MUTANTS KILLED  (~3.5 min)
node docs/capital-model-measured-cost/2026-10-16/record.cjs --dry
node docs/capital-model-measured-cost/2026-10-16/stamp.cjs --check
node --check on every .cjs and both staged files
```

No test was weakened, skipped or deleted, and no registered test's rule, bar, population or read condition was touched: this package
edits no existing test. The checks it adds are new.

### After the apply, at home

1. `node backend/profit-program/planE-baseline.js` — it must print what it printed before, to the byte, and rewrite the same
   `planE-baseline.json` (keep the before-copies from step 0 to compare).
2. `node backend/profit-program/planE-baseline.js --measured-costs <your measured file>` — the new block. The example file in this
   package is **not** a measurement; the three rates have to come from fills measured at home before any number from it is quoted.
3. `node docs/capital-model-measured-cost/2026-10-16/record.cjs --dry`, then without `--dry`.

A rollback (`rollback.cjs --apply`) puts both files back byte for byte. A `planE-baseline.json` written by a measured run keeps its
`measuredCosts` key until the baseline is run again; every other key is the same either way.
