# R275 + R192 forward shadows — 2026-10-16

Backlog row 11/27. **R275** (the release-day filter on the option sleeves) and **R192** (month-end bond funds) both
passed on history and were sealed, and nothing ran them forward. From the day each sealed it has produced no new
evidence at all. This package adds two forward **shadows**: each session they record what the rule *would have done*,
to their own JSONL, and nothing else.

**No orders of any kind.** Neither runner holds a position, calls a broker, requires a broker module or writes any
board, ledger, seal or registry file. Neither is a second read of its test: R275 and R192 are both spent, their bars
are printed for comparison only, and the registry's own audit note on R192 — that it is not independent of R180 —
stands untouched.

## What it ships

Three **new** files (nothing that already exists is changed, so `base/` holds no bytes; see `base/README.md`):

| file | what it is |
|---|---|
| `backend/lib/shadow-ledger.js` | the append-only record both shadows write through: one row per `kind`+`key`, never rewritten, a gap row where a number could not be read |
| `backend/r275-release-shadow.js` | R275's release-day filter, forward → `data/r275-release-shadow.jsonl` (+ `.json` read-out) |
| `backend/r192-month-end-shadow.js` | R192's month-end rule, forward → `data/r192-month-end-shadow.jsonl` (+ `.json` read-out) |

## The one thing to check first

**R275's registry entry is redacted in this clean copy** — `backend/data/test-registry.json` holds
`{"id":"R275","screenRedacted":true}` and nothing else, and `register-r275.js` is not in this tree either. The rule
text in the shadow therefore comes from the **sealed read itself**, `backend/r275-release-filter.js`, whose own header
says *"registered 2026-09-28 in register-r275.js; the registry wins"*.

Before the forward record is believed, read R275's full registry entry at home against these two expressions, which
are the whole of the rule the shadow applies (and which the selftest holds to the sealed read's text, character for
character, in both files):

```js
const anyRelease = (EV, d, types) => types.some((k) => EV[k].has(d));
const exposedTo  = (EV, r, types) => { for (const k of types) for (const d of EV[k]) { if ((d > r.d || (k === "FOMC" && d === r.d)) && d <= r.expiry) return true; } return false; };
```

If the registry says anything different, **stop**: the shadow is then recording a rule that is not the registered one.
Nothing here may be adjusted to make a number come out — AGENTS.md, "A registered test's rule, bar, population or read
condition is never changed." Rebuild the shadow from the registry instead, or say in the branch's notes that it cannot
be built as registered.

R192's entry is **not** redacted; the shadow reads its bar (`bar.tRequired`, 2.356) out of the registry at run time, so
nothing in the file can drift from it.

## The rules, exactly as registered

### R275 — the release-day filter (sealed: one-sided bar t ≤ −2.006, best-of-2)

* event dates from `data/macro-calendar.json`, read exactly as the sealed read reads them (a string, or `.date`, or `.d`)
  for CPI, NFP and FOMC;
* **V1, the 0DTE sleeve**: per session, the **mean R** of that session's tickets; **Welch t** of the release sessions'
  means against the other sessions' means. The filter's decision for a day is *skip it if it is a release session*;
* **V2, the weekly wings**: a wing is **exposed** when a release falls after its entry (an **FOMC on the entry day counts**,
  a CPI or NFP on the entry day does not) and on or before its expiry. Per **entry session**, mean R of the exposed wings
  minus mean R of the unexposed wings; plain one-sample **t** over the sessions that have both. The filter's decision for
  a wing is *decline it if it is exposed*.

**The one forward adaptation, stated rather than buried.** The sealed read measured archives — `r116-zero-dte-replay-wings.json`
and `r21-archive-replay-wings.jsonl`. Forward there are no replays, so the population is the live sleeves those archives
replay: the board's own tickets, `strategy: "R25-0dte"` (V1) and `"R21-premium"` (V2), read the way
`backend/options-news-shadow.js` already reads them (`trade_log.json` + `board_positions.json`, closed row wins on a
duplicate id, control twins `ctrl`/`ctrlRand` excluded — a control twin is not a trade). A ticket's R is the ledger's
`rMult`, which for these sleeves is `pnl / riskDollars`, net P&L over the defined max loss
(`backend/options-settle.js`) — the same quantity the replays computed as `pnl / maxLoss`. **Nothing else about the
rule changes.**

### R192 — month-end index extension beyond Treasuries (sealed: PASS, bar t ≥ 2.356)

Registry text: *"Exactly R180's rule and statistic (last 5 trading days' total return minus 5 × the month's other-day
mean, 2 bps a side) on AGG, LQD and MUB (Alpaca SIP daily, adjustment=all). Primary: the equal-weight average of the
three per month. Reported: each alone, and HYG as a contrast."* Statistic: *"Per month, the pooled window excess; t over
months. Placebo as R180 (random 5-day windows, 200 draws)."*

Carried over character for character from the sealed read `backend/r192-bond-month-end.js`, and held to it by the
selftest:

```js
const excessAt  = (a, start) => { const w = a.slice(start, start + 5), o = [...a.slice(0, start), ...a.slice(start + 5)]; return w.reduce((p, x) => p * (1 + x), 1) - 1 - 5 * mean(o) - COST; };
const lastStart = (a) => a.length - 5;          // COST = 0.0004 (2 bps a side); a month needs >= 15 returns in every primary fund
```

plus `mulberry`, the placebo's 200 draws seeded `192000 + k`, its window draw `Math.floor(rng() * (a.length - 4))` and
its `p95 = draws[Math.floor(0.95 * draws.length)]` — all compared bit for bit against the sealed read.

## Forward, and only forward

Each record opens with a `start` row on the night the runner first fires, and **never backfills**. R275 records only
sessions on or after that date; R192 scores a month only when the month's **first session** is on or after it. No part
of either sealed sample can leak into the forward sample, and months held back for that reason are named in the
read-out. The start row also carries the sha256 of the rule's source file at build time, so the record says which rule
text produced it.

## What a row means

Both JSONLs are append-only, one row per `kind`+`key`, never rewritten; re-running a runner adds nothing it has already
written. A number that could not be read is a **gap row** (`{ gap: true, why }`), never a guess.

**`r275-release-shadow.jsonl`** — `start` · `run` (one per run: the run's ET date and what it wrote — the proof it
fired) · `session` (the release classification, the 0DTE cell with `wouldSkip`, the wings **opened** that session with
`wouldDecline` and the releases that expose each, and the wings that **settled** that session) · `wing-cell` (one per
entry session, once every wing entered that session has settled: mean exposed R, mean unexposed R, the difference).

**`r192-month-end-shadow.jsonl`** — `start` · `run` (the run's ET date, the bar window actually served, what it wrote)
· `session` (each fund's return that day, and whether the rule **would have been long** — decided from the exchange's
published session calendar, the only way the answer is knowable on the day; when the calendar cannot be read the row
says `plan.from: "unavailable"` rather than pretending the day was decidable) · `month` (the registered statistic from
the month's **realized** sessions, each fund alone, HYG as the contrast, whether the calendar's window agreed with the
realized one, and the month's own daily returns kept in the row so the read-out and the placebo can be re-derived from
the record alone).

**Lag, by design.** R275 records a session on the first run strictly *after* it ends, so the night's settles are already
in the ledger. A 0DTE ticket still unsettled then holds its session back for at most 7 days; after that the row is
written with what settled and the unsettled ids named in it (`v1.unsettledIds`), so the record never stalls and never
quietly drops a ticket. R192 takes its sessions from the funds' own completed daily bars, so it needs no clock rule at
all; `lib/sip-fetch.js` walks the end date back when the plan will not serve one that recent, and the run row records
the window actually served.

## Wiring — the one step this package does **not** do

`automation/close-chain.cjs` is not in this clean copy and nothing here edits it. After `deploy.cjs --apply`, add the
two runners to the nightly chain by hand, after the step that settles options (so the night's fills are in the ledger
before R275 reads it):

```
node backend/r275-release-shadow.js
node backend/r192-month-end-shadow.js
```

`deploy.cjs --plan` reports whether the chain already names them (it reads that file **as text**, never `require`s it —
AGENTS.md). Until the edit is made the three files sit there doing nothing, which is the safe state. `rollback.cjs`
refuses while either runner is still named in the chain, so the files cannot be pulled out from under tonight's run.

## How it was proven

`node docs/r275-r192-shadows/2026-10-16/selftest.cjs` → **ALL 52 CHECKS PASSED** (fixtures only; no network, no broker,
no clock of its own — every run is given a fixed `now`; nothing outside its own scratch directory).

* **A, the record (8)** — append-only, one row per kind+key, a second run adds nothing, a row without a kind or key is
  refused, a holed record **throws** rather than becoming a smaller sample, ET session dates on both sides of the
  November DST change.
* **B, the rules (14)** — each rule is held to its sealed read **two independent ways**: the decision expressions must
  appear verbatim in *both* files, **and** the sealed text is evaluated straight out of `r275-release-filter.js` /
  `r192-bond-month-end.js` and run against this package's functions — 15,500+ exposure/release cases, 2,000 random
  months of `excessAt`, and `mulberry`'s stream bit for bit. Editing either copy of either rule fails the selftest.
  Plus hand-computed answers: the FOMC-on-the-entry-day asymmetry (an FOMC on the entry day exposes a wing, a CPI does
  not), three exact window-excess cases, Welch on means (−1, −3) vs (1, 3) = −2.828, one-sample t of (−1, −2, −3) = −3.464.
* **C, the shadows (19)** — both runners end to end on a month of fixtures: the rows they write, the hand-computed
  forward statistics, the gap rows, the 7-day grace, idempotency, "no calendar" behaviour, the registry-read bar — and,
  structurally, that **a run touches no file but its own two** (the ledger, the board and the calendar are byte-identical
  after a run), that any network call **throws**, that the only URL in the three files' code is the exchange's read-only
  session calendar, and that every write call in them targets the runner's own record.
* **D, the package (11)** — deploy/rollback on scratch trees: create the three files byte-exact and `node --check` them,
  refuse DRIFT, refuse a tampered staged copy, refuse when the selftest gate fails, the fences (trading-day clock,
  running close chain, unreadable process list = fail-closed), rollback removes exactly what was added and **keeps the
  records**, rollback refuses while the chain still names a runner, and `record.cjs --dry` writes nothing.

**Test edits: none.** No existing test, bar, rule, population or read condition was changed, weakened, skipped or
removed. No file outside this package was touched.

## What this does not give

* It is **not evidence yet**. It is a recorder. R275's V1 needs release sessions to accumulate and V2 needs entry
  sessions with wings on both sides; R192 needs months. Both read-outs print the sealed bar purely so the forward
  number can be put beside the historical one — neither clears anything, and neither test may be re-read on this record
  without a new registration.
* It does not re-seal, re-read, amend or grade R275 or R192, and it does not act on them: no order, no position, no
  sleeve is filtered. Acting on either filter would be a separate, registered change.
* R275's V1 and V2 both inherit whatever the live sleeves do. If the 0DTE or wings sleeve stops trading, the record
  simply stops gaining sessions; the `run` rows still show the shadow fired.
* R192's forward months are few by construction (one a month), so its t will be noisy for a long time. The registry's
  audit note still applies: a pass here would confirm R180's robustness, not add an independent edge.

## HANDOVER

Handed over on 2026-10-16 at the operator's instruction, mid-loop. **The package is complete, its selftest passes,
and one independent check completed — but NO fix cycle was run against its findings.** The builder was stopped
before acting on them. Everything below is stated as it actually stands.

### Done

1. `staged/backend/lib/shadow-ledger.js` — the append-only record both shadows write through.
2. `staged/backend/r275-release-shadow.js` — R275's release-day filter, forward, over the two live short-premium
   sleeves. Rule text taken from the sealed read (R275's registry entry is redacted here — see
   "The one thing to check first" above).
3. `staged/backend/r192-month-end-shadow.js` — R192's month-end rule, forward, on AGG/LQD/MUB with HYG as the
   contrast; bar read from the registry at run time.
4. `deploy.cjs --plan|--apply` (all three files new, `base` = absent, DRIFT refused, selftest gate, clock and
   close-chain fences), `rollback.cjs --plan|--apply` (removes the three files, keeps the records, refuses while the
   chain still names a runner), `record.cjs --dry` (one change-registry row + one GOVERNANCE line), `NOTES.md`,
   `base/README.md`.
5. Committed and pushed to `claude/r275-r192-shadows` (and `claude/r275-r192-shadows-uv1k97`).

### Checks that pass, as run in this session

* `node docs/r275-r192-shadows/2026-10-16/selftest.cjs` → **ALL 52 CHECKS PASSED**, exit 0. Fixtures only: no
  network (a `fetch` during a run throws), no broker, no clock of its own, nothing written outside its own scratch
  directory. Breakdown in "How it was proven" above.
* `node --check` clean on all seven .cjs/.js files of the package.
* `deploy.cjs --plan`, `rollback.cjs --plan` — read-only, correct output; both report the write mode would be
  REFUSED right now by the 05:30–16:00 MT trading-day clock fence, which is the intended behaviour.
* `record.cjs --dry` — refuses in this clean copy because `backend/data/change-registry.json` is not here (no data
  in this tree). That is expected; it must be re-run at home.
* **No existing test, rule, bar, population or read condition was changed, weakened, skipped or removed, and no
  test disappeared.** No file outside this package was touched.

### The independent check — completed, NOT acted on

A checker ran every check read-only against this code (commit `6ae8cf4`; the code files are byte-identical at
`f6a9392`, which differs only in this NOTES.md). Its verdict: **pass, fixes recommended before apply, no blockers.**
It re-ran all four check groups clean (`node --check` 7/7; selftest `ALL 52 CHECKS PASSED` twice, deterministic, no
scratch left behind; the three read-only commands left the tree clean; `--apply` correctly refused on the clock
fence, and under a Saturday clock with the real selftest gate it wrote all three files byte-exact, re-applied as a
no-op, and rolled back keeping the records). It confirmed the AGENTS.md audit (no orders, no network in tests, no
secrets, no personal details, JSON only through `writeJsonAtomic`, the chain never required, no registered rule,
bar, population or read condition changed) and judged both rules faithful to their sealed reads and, for R192, to
the registry entry.

It ran **36 mutations and 30 were caught** — including every governance mutation it could construct (writing the
registry, hardcoding the bar, injecting an order POST, writing outside the record, rewriting the record in place,
and changing the cost, seed, window and population constants). **Six slipped through.** In each case the shipped
code is correct; nothing in the selftest would notice if a later edit made it wrong:

| missed | what was not caught | the gap |
|---|---|---|
| F1 | deleting a selftest check → `ALL 51 CHECKS PASSED`, exit 0, and the apply gate (`/^ALL \d+ CHECKS PASSED/`) still wrote the files | the count is derived, not pinned — AGENTS.md's "stop if the number of tests shrinks" is unenforced |
| F2 | dropping R275's `d >= evidenceStart` (backfill), and `d < runDate` → `<=` (the lag rule) | no fixture ticket before `evidenceStart` or on the run date |
| F3 | `PRIMARY = ["AGG","LQD"]` — dropping MUB | the registered three-fund population is checked neither by text nor by value, and the fixture funds are identical |
| F4 | weakening the equal-weight primary's `prim.length === PRIMARY.length` guard | no fixture month is missing a primary fund |
| F9 | dropping the `Number.isFinite(rMult/pnl)` settled guards, and the r192 read-out's `usable()` guard | one fixture each would cover both |

It also raised two judgement calls worth deciding before apply: **F5** — a V2 wing whose `expiry` is `null` is
silently classified *unexposed* instead of gapped (the sealed read guards this at `r275-release-filter.js:33`), and
**F6** — V2 has no settle grace, so one wing that never settles holds its entry session's `wing-cell` forever, which
makes the "the record never stalls" claim above true of V1 only. Plus nits: the ledger appends the whole batch in
one call while its header argues for one short line (F7); HYG is not gated by `MIN_RETURNS`, giving a null contrast
with no `why` (F8); `selftestGate` builds its path from the module constant rather than the injected `pkg` (F10);
`writeExact` can leave a `.tmp-shadows-*` behind on failure (F11); a second run on the same ET date writes rows with
no `run` row documenting them (F12); `record.cjs --dry` refuses before printing the records when
`change-registry.json` is absent (F13); the start row's sha is taken at first run, not build time, and can be a
silent `null` (F14); the shadow drops the sealed read's `LO`/`HI` event-date window, correct forward but undisclosed
(F15); the bar fetch start and the per-month calendar calls grow without bound (F16); the sealed read's placebo p95
index is one off R180's registered `ceil` convention — inherited, not introduced (F17); and `vetoShadow` rows are
excluded only incidentally, via the `ctrl` flag they are conventionally written with (F18).

**None of this was fixed. No fix cycle was run.** These are the checker's findings as reported; the builder did not
independently verify them before being stopped.

### Left to do, in order

1. **Close the six coverage gaps and decide F5 and F6** — the checker asked for F1, F2, F3, F4 (a pinned check count
   plus four small fixtures) and a decision on F5 and F6 before the operator applies. All of them are selftest or
   runner work in this package; none touches a registered rule, bar, population or read condition.
2. **Verify R275's rule against the full registry entry at home** — "The one thing to check first" above. If the
   registry differs from `backend/r275-release-filter.js`, the shadow is recording the wrong rule: rebuild it from
   the registry, and change nothing to make a number come out.
3. `node docs/r275-r192-shadows/2026-10-16/selftest.cjs` at home (it needs only this repo's own files).
4. `deploy.cjs --plan`, then `deploy.cjs --apply` — after 16:00 MT, once the close chain has finished.
5. **Wire the two runners into the nightly chain by hand** — see "Wiring" above. Until then the three files sit
   there doing nothing and neither record gains a row.
6. After the first night, confirm both JSONLs opened a `start` row and a `run` row, and that
   `backend/r192-month-end-shadow.js --status` shows the session calendar was read (otherwise every session is
   recorded as undecided, which is honest but useless).
7. `record.cjs --dry`, then `record.cjs`.

### Known gaps, stated rather than left to be found

* The forward records are empty by construction until the runners are wired and start firing; nothing here is
  evidence yet.
* R275's `rMult`-as-R mapping and its `R25-0dte` / `R21-premium` population are the one forward adaptation of the
  sealed read's archive population. It is argued in "The one forward adaptation" above and is worth a second
  opinion at home, where the live sleeves can be inspected.
* `record.cjs` has only ever been exercised in `--dry` against a scratch directory (check D10) and against this
  data-free tree; its write path has not run anywhere.

## Commands

```
node docs/r275-r192-shadows/2026-10-16/selftest.cjs            # fixtures only; ends "ALL 52 CHECKS PASSED"
node docs/r275-r192-shadows/2026-10-16/deploy.cjs --plan       # read-only: shas, states, fences, wiring
node docs/r275-r192-shadows/2026-10-16/deploy.cjs --apply      # the write mode (operator, at home)
node backend/r275-release-shadow.js --status                   # read-only: the record as it stands
node backend/r192-month-end-shadow.js --status                 # read-only: the record as it stands
node docs/r275-r192-shadows/2026-10-16/record.cjs --dry        # the two records it would write
node docs/r275-r192-shadows/2026-10-16/rollback.cjs --plan     # what a rollback would remove
```
