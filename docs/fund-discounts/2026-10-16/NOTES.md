# R354 — closed-end fund discounts: the runner, its engine and the nightly recorder

Package: `docs/fund-discounts/2026-10-16/`. Built in a cloud build session on 2026-10-16, branch `claude/r354-fund-discounts`.
Registered test: `backend/data/test-registry.json`, `preregistered[]` id **R354**, registered 2026-10-12, rule sha256
`82d7586f…ede00c39`, bar **t ≥ 1.727** on the holdout, 177 months, lapse 2027-01-31.

**Nothing in R354's registered rule, bar, population, statistic, controls, decision rule, read condition, evidence start or lapse was
changed, and no series was read.** The runner recomputes the entry's own `ruleSha256` from its rule text and refuses a read if it no
longer matches; its frozen constants are compared field for field with the entry's `parameters{}` (a selftest case and read-condition
item (1c)). This tree holds no cache, so `--read` refuses here whatever is asked of it — which is also what `interimKill` demands
(“`--read` is in the build loop's forbidden list”).

## What ships (three NEW files — `base/` is empty on purpose)

| file | what it is |
| --- | --- |
| `backend/lib/fund-discount.js` | the engine: every number of R354 as pure functions over series handed in. No `fs`, no `fetch`, no clock, no environment variable (a selftest case greps for each). |
| `backend/r354-fund-discounts.js` | the runner: `--selftest`, `--status`, `--controls --span=…`, `--read --span=…`, `--dollar-table --span=…`. 100 known-answer cases on made-up series. |
| `backend/fund-nav-record.js` | the nightly price + published-NAV recorder of `openOperatorItems[0]`. Belongs to no registration, reads no result, places no order. Every fetch goes through an injected fetcher. |

**`base/` is absence.** All three paths are new in the live tree, so there are no “bytes the change starts from”: `deploy.cjs --plan`
prints each file's state as `new`, `applied` or `DRIFT` (home holds something else → the whole package refuses), and
`rollback.cjs --apply` restores base by **removing** exactly the files that hold the staged bytes. A rollback never touches anything
under `backend/data/` (a controls file, a read, the recorder's JSONL): those are records, not code.

## The package

```
node docs/fund-discounts/2026-10-16/deploy.cjs --plan      # read-only: sha256 now / staged, state, what --apply would write
node docs/fund-discounts/2026-10-16/deploy.cjs --apply     # the operator's command at home; gated on this package's selftest
node docs/fund-discounts/2026-10-16/rollback.cjs --plan    # read-only
node docs/fund-discounts/2026-10-16/rollback.cjs --apply   # removes the three files again
node docs/fund-discounts/2026-10-16/selftest.cjs           # 18 checks / 117 selftest cases, on the STAGED copies, no network
node docs/fund-discounts/2026-10-16/record.cjs --dry       # the one dated note, the one change-registry row, the one GOVERNANCE line
```

`selftest.cjs` copies the three staged files into a scratch tree together with the three live files they require and do **not** change
(`backend/lib/atomic-write.js`, `backend/lib/run-window.js`, `backend/package.json` — the root `package.json` says `"type":"module"`,
so the runner needs `backend/`'s own CommonJS one) plus a copy of the registry they read, and runs everything there. So the cases are
on the staged bytes whatever the live tree holds.

## How the statistic is computed (the entry's own words, in code)

* **Rule [1]–[5]** `prepareUniverse` / `prepareFund`: raw closes only (never the adjusted close), the market calendar from `^GSPC`,
  NAV symbols accepted only as `MUTUALFUND` on `NAS` with zero volume and `o=h=l=c`, unit repair [4] by split factor `k = den/num`,
  the suspect-row screen [3] in both of its modes, validity and `d[t]` inside the band 0.5–2.0, `z` over the 252 days strictly before
  `s` with at least 230 valid rows and a sample (n−1) sd.
* **Rule [6]** `eligible` returns the failed clause letters (`a`…`i`), so every clause is testable on its own — including the
  universe-wide FEED-FREEZE share and the bond-holiday calendar (second Monday of October; 11 November, or the 12th when the 11th is a
  Sunday).
* **Rule [7]–[13]** `runBook`: one purchase a half-month counted by the signal day, 24 places of $4,000, the free place counted at the
  entry close from the exits scheduled for it, lowest `z` first with ties on 30-day median dollar volume then ticker, entry at the next
  close (second for a late reporter) within three market days or no trade, exit at the 252nd market day, everything sold on the span's
  last market day. The book keeps the candidate list each signal was chosen from, so [8] is auditable.
* **The statistic** `statistic`: `G(M) = (real gap dollars in M − the real fills' cost in M) − mean over 500 seeded draws of the
  placebo's gap dollars in M`; the mean over **all** the span's months (a month with no position counts) with Newey-West (Bartlett)
  `t` at lag 4; `D`, `BOOK`, `YIELD`, `G21` (S2), `GUS` (S3), `GPEER` (S4) beside it; S5 against 500 month-shifted books.
* **The bar** `barInForce`: the largest of 1.727, the 95th percentile of 20 000 block resamples (blocks of 13 months, mean removed,
  seeded) of that read's own months, and the V10 worlds' 95th percentile. **It can only rise.** A `t` below it by any margin is DID NOT
  PASS (compared unrounded).
* **The gates** `gateV2…gateV16`, the made worlds `noEdgeWorld` / `faultWorld` / `plantedWorld`, the labels `labels` (L1–L12) and the
  decision rule `decideDiscovery` / `decideHoldout` (all eight conditions).

## Readings written down (neither changes a number of the rule)

1. **[3] in decision mode** says a suspect row “is taken out of a window” once its undo row is dated `s` or earlier; measurement mode
   says the wrong print “is removed with the rows between”. The engine removes the **episode** (the suspect row and the rows between it
   and the undo row) in both modes, so a two-row wrong print never leaves its second row in a window.
2. **[7]'s both-ways test**: `d[s] = P/(N·m) − 1` falls as `m` rises, so the binding resolution of the unverified events dated after
   `s` is the smallest multiplier. Both `m = 1` and `m = Π min(k,1)` are tested, and the second is the worst case over every
   combination.
3. **S5 / L12's shifted books** are each measured against the **same** placebo monthly mean as the real book: the shift moves the
   rule's calendar, not the yardstick.
4. **S4's peer yardstick** replaces the asset-value **return** term with the equal-weight mean of the peers' `N[b]/N[a]` over the same
   days (the position's own distributions stay in the price leg, as in `definitions.gapDollars`).
5. **V2's as-of replay** cuts the rows at `s` but keeps the dividend and split **event lists** and the unit resolution of events dated
   after `s` — the entry's `timing[]` announces ex-dates in advance and calls a split ratio “used for unit conversion only”. Everything
   that could carry a **level** from the future (prices, NAVs, volumes, wrong prints) is cut. That is what `navMulOverride` in
   `prepareFund` is for, and nothing else may pass it.
6. **V9** is “counts only; wording, not a gate”, but `readCondition` (5) asks for V1–V15 to be written **and passed**, so a missing
   attrition recording refuses the read rather than passing quietly. Same for V6, V7, V8 and V15: **every gate is fail-closed.**
7. **`nwT`** is the house Bartlett lag-L form (`v = g0 + 2Σ(1−k/(L+1))γk`, each γ over n; `t = mean/√(v/n)`), identical in every
   `backend/hunt/*.js`. `backend/lib/tv-pit-panel.js` is **not in this code-only copy**, so the operator should re-check the engine's
   `nwT` against it at home before a read. A hand-computed lag-0 case pins it.
8. **`lib/null-bar.js` is not in this copy either.** It is not needed: the registered bar (1.727) is fixed in the entry, and the engine
   computes only the two numbers that can **raise** it.

## Read-condition items the runner enforces (it refuses and reads nothing unless all hold)

`(1a)` R354 in `preregistered[]` once · `(1b)` the rule text still hashes to `ruleSha256` · `(1c)` the frozen constants equal
`parameters{}` · `(2)` `backend/data/r354-build.json` says the standard build loop built this exact runner with `--read` forbidden ·
`(3a)` the cache was fetched on or after 2026-10-15 and is frozen · `(3b)` the cache on disk still hashes to its manifest · `(3c)`
**one** dated `hash-note` in `amendments[]` carries the manifest's and the controls file's sha256 · `(4)` the runner's own selftest
passes in process · `(5a)` the controls file holds V1–V15 for that span, all passed, on that cache hash · `(5b)` **the gates were run
at their registered strength** (200 no-edge worlds, 200 fault worlds, 20 planted worlds, 2000 replay pairs — a rehearsal with fewer can
never carry a read) · `(6)` the clock is outside 13:50–15:50 MT on a trading day · `(7)` on or before the lapse · `(8a)` no read of
that span exists · `(8b)` for the holdout, discovery is sealed PROCEED · `(8c)` the holdout lock is not already there (the holdout read
writes it before the first holdout row reaches the book). The runner prints and **never seals**.

## The nightly recorder

`backend/data/fund-nav/<ET date>.jsonl`, append-only through `backend/lib/atomic-write.js` `writeTextAtomic`. Row kinds: `look` (one a
look, with its ET clock time and counts), `price`, `nav` (`rev 0` = the **first** value seen for that date with the clock time; a later
**different** value is appended as `rev 1, 2, …` with `revisionOf`, and the first is never touched), `list` (the list's own row **with
its term date**; its discount, z-score and NAV fields are never stored — a selftest case greps the written file for them), and `gone`
(a fund that was on the list and is not: the survivorship cure). `--dry` creates nothing, not even the folder. Several looks a night
are the point (17:30 / 18:30 / 20:30 ET): the first value for a date is what cannot be recovered later.

---

# HANDOVER

Written at the user's request mid-build. **Everything below is the honest state at the hand-over commit.**

## Done, and checked

1. **`backend/lib/fund-discount.js` — the engine.** Rules [0]–[14], the statistic, `definitions{}` (gap dollars, clean start/end,
   month ends, placebo, price-dollar series, month-end mark), the sign gates S1–S5, the labels L1–L12, the bar in force, the made
   worlds (no-edge, fault, planted) and the validity gates V2–V16. Pure; injectable; no I/O.
2. **`backend/r354-fund-discounts.js` — the runner.** `--selftest` (**100 known-answer cases, ALL 100 PASSED, ~5 s**), `--status`
   (read-only; prints every file and every read-condition item), `--controls --span=…` (writes `r354-controls.json` and
   `r354-units.json`; prints counts only, and for the holdout passes the rows through counting paths alone), `--read --span=…`
   (refuses unless every read-condition item holds; writes the read file; never seals), `--dollar-table --span=…`.
3. **`backend/fund-nav-record.js` — the nightly recorder.** `--selftest` (**17 cases, ALL 17 PASSED**), `--dry`, `--record`,
   `--status`. Injected fetcher; one `await fetch(` in the whole file, inside `httpFetcher`; dated append-only JSONL with revisions
   and `gone` rows.
4. **The staged package** `docs/fund-discounts/2026-10-16/`: `base/` (empty — base is absence), `staged/` (the three files, byte for
   byte, sha256 recorded in `deploy.cjs`), `deploy.cjs --plan|--apply` (drift refusal; selftest gate; temp-file+rename writes read
   back by sha256 then `node --check`; on any failure every file this run wrote is removed again), `rollback.cjs --plan|--apply`,
   `selftest.cjs` (**18 checks / 117 cases, ALL 18 CHECKS PASSED**, including a deploy-then-rollback in a scratch tree and both
   `--read` refusals), `record.cjs --dry`, this `NOTES.md`.

### Checks that pass right now

```
node --check backend/lib/fund-discount.js  backend/r354-fund-discounts.js  backend/fund-nav-record.js   (and the three package .cjs)
node backend/r354-fund-discounts.js --selftest        ->  ALL 100 PASSED
node backend/fund-nav-record.js --selftest            ->  ALL 17 PASSED
node docs/fund-discounts/2026-10-16/selftest.cjs      ->  ALL 18 CHECKS PASSED (117 selftest cases)
node docs/fund-discounts/2026-10-16/deploy.cjs --plan ->  three files, all "new"; nothing written
node docs/fund-discounts/2026-10-16/rollback.cjs --plan -> nothing to remove (the package is not applied in this tree)
node docs/fund-discounts/2026-10-16/record.cjs --dry  ->  the three records; the write would be refused here (no change-registry.json
                                                          in this code-only copy, and the package is not applied)
node backend/r354-fund-discounts.js --read --span=discovery ->  REFUSED (exit 2), "NO SERIES WAS READ"
node backend/r354-fund-discounts.js --read --span=holdout   ->  REFUSED (exit 2), discovery not sealed
```

Measured, not promised: on a 14-fund made-up discovery-sized fixture (3390 market days, 108 months) the book opens 93 positions in
1.0 s, one no-edge world (100 placebo draws + 100 shifted books) takes ~3.3 s, and a 500-draw statistic takes ~90 s. So a real
`--controls` run at home (200 + 200 + 20 worlds, 298 funds) is **hours, not minutes** — it is a one-off historical read and should be
run as such, not under a timeout.

## Left to do, in order

1. **THE INDEPENDENT CHECKER NEVER RAN.** This is the biggest gap: the build-check-loop's second half (a separate checker agent
   running every check read-only, plus mutation tests — flip `<` to `<=` in `[7]`, swap `removedAsOf` for `wrongPrintSet` in `zAt`,
   drop the `z[s-1]` test, lower the bar, remove a sign gate, let `--read` through without item (5b) — and confirm a case fails for
   each) was not started. Until it has run, treat the 117 cases as the builder's own word. `backend/data/r354-build.json`, which
   read-condition item (2) requires, must **not** be written before that: it is the record that the loop ran.
2. **An end-to-end rehearsal on fixtures** (`rehearsal.cjs`, designed but not written): build a fixture cache + manifest + universe +
   the four gate-input files + a `hash-note` in a scratch `backend/data`, run `--controls --span=discovery` at full registered
   strength, then `--read --span=discovery`, and assert (a) that a verdict is produced, (b) that a rehearsal run with fewer worlds is
   **refused** by item (5b). The selftest already proves the refusal path and the (5b) check; what is missing is the positive path —
   that the read condition *can* hold and the read then runs end to end. Budget ~25 min of CPU.
3. **Re-check two things at home that are not in this code-only copy**: the engine's `nwT` against `backend/lib/tv-pit-panel.js nwT`
   (reading 7 above), and that `docs/fund-discounts/2026-10-12/RUNNER-SPEC.md` (screened out of this copy — the entry was the spec
   used here) lists no selftest case this build does not have. `RUNNER-SPEC.md` also owns V1's “the count of cases never falls”
   list; the package's floor is currently runner 100 / recorder 17.
4. **Fill in the gate inputs the runner cannot make up** before any read: `r354-publication-check.json` (V6, three market days of
   timed looks — the nightly recorder can produce them), `r354-second-source.json` (V5/V7), `r354-signal-audit.json` (V8, the 40
   listed signals checked by hand), `r354-attrition.json` (V9), `r354-cost.json` (V12's cost table, or every fund is charged 1.5× its
   class cost), `r354-universe-frozen.json` (the 359-fund list frozen 2026-10-09, sha256 `9a5524e7…b240fee8`) and the cache itself
   with its manifest. Each is fail-closed today.
5. **The three open operator items of the entry** are untouched decisions: the nightly recorder is built but **not scheduled** (no
   cron, no chain edit — this package touches nothing live); the public list's terms of use are still unread (V6's DATE CHECK and
   V7's weekly cross-check need the operator's yes); and the house quote source has not recorded the 15:30 bid/offer tables.
6. **Then** `record.cjs` (without `--dry`) at home, after `deploy.cjs --apply` and a look at `--status`.

## What this build deliberately did not do

No order of any kind. No network call anywhere (the recorder's real fetcher is never exercised by a test). No schedule, no restart, no
registry write. No read of either span. No change to a registered rule, bar, population or read condition — and had one been needed,
AGENTS.md says to stop and say so here instead, which was not needed.
