# OPTIONS-VANISHED-SETTLES — 2026-10-16

A staged package for ONE live file: `backend/options-settle.js`, the nightly sweep that closes the board's expired option spreads.

```
docs/options-vanished-settles/2026-10-16/
  base/backend/options-settle.js     byte-exact copy of the live file this change starts from
  staged/backend/options-settle.js   the changed file, at its repo path
  deploy.cjs    --plan | --apply     --apply refuses on drift; selftest is its gate
  rollback.cjs  --plan | --apply     restores base/ byte for byte
  selftest.cjs                       known answers on small fixtures; last line "ALL <n> CHECKS PASSED"
  record.cjs    [--dry]              one change-registry row and one agent-ledger GOVERNANCE line
  harness/                           scratch trees, the bars stub, the no-network preload, the fixtures
  NOTES.md                           this file
```

Nothing here was applied. Nothing here placed an order, asked a broker, or touched any data file in the repository.

---

## The defect

The board's options sweep (`backend/options-settle.js`) closes an expired spread only where it holds a rule that can **price** it:

* a **credit vertical** — the R21/R25 wings (the original rule, 2026-08-19); or
* a **verified debit vertical** — fix 4.2 of `docs/profit-fixes/2026-10-12/a-booking`, which needs `optReal === true` and two OCC legs whose
  strikes and side verify against the ticket's own.

Anything else that is past its expiry is printed on the `NOT SETTLING …` line and left on the board — and so is a vertical whose
underlying returned no completed bar (`stuck`, `stuckDebit`).

**Nothing downstream closes those, because an expiry is not a fill.** The broker reports no closing trade for an expired contract: the
position is simply *not reported any more* the next morning. There is no fill for the mirror to follow and no exit for the reconcile to
grade, so the row sits open on the board for good — marked at nothing, in no settled population, and visible only as a line in a log.

The same silence shows in the mirror's own log. An option order the broker accepted and never filled is not cancelled at expiry, it is
dropped; the row keeps whatever status it had when it was written, so it can read `"sent"` for ever.

## What this package adds

### 1. The vanished-legs settle

A board option **past its expiry** that this run did not settle, and that the ledger does not already hold, is settled at its intrinsic
value at the expiry close **when the broker no longer reports its two OCC legs**. The row is written to `trade_log.json` with a tag of
its own:

| field | value |
| --- | --- |
| `reason` | `expiry-vanished` |
| `obs.settleKind` | `vanished-legs` |
| `obs.settleTag` | `vanished-legs-2026-10-16` |
| `obs.settleCloseSource` | which stored close priced it |
| `obs.brokerSnapshotAsOf` | the snapshot that showed the legs gone |
| `obs.brokerLegs` | the two OCC symbols |

Arithmetic, identical to the wings' and written once (`verticalIntrinsic`, which the selftest holds to the wings' own expression on a
2 376-point grid):

```
value       = clamp(call ? S - optAtmLeg : optAtmLeg - S, 0, width)
pnl         = (credit received - value) x 100 x contracts - 0.65 x 2 x contracts     a credit vertical
pnl         = (value - debit paid)      x 100 x contracts - 0.65 x 2 x contracts     a debit vertical
```

Two legs in at \$0.65; the expiry itself is commission-free — the same rule the wings have always used.

Every condition is **fail-closed**, and nothing is ever guessed:

| condition | source | if it is not met |
| --- | --- | --- |
| the two OCC legs verify as one vertical (one expiry, one side, two strikes, `optAtm` on the money side) | the position | **outside the rule** — left exactly as before, reported, not flagged |
| the broker no longer reports either leg | `backend/data/alpaca-options-positions.json`, a **stored** snapshot whose `asOf` is an ET date **strictly after** the expiry | **outside the rule** — left exactly as before. An absent, unreadable, undated or not-late-enough snapshot proves nothing |
| a stored close of the underlying **on the expiry date** exists | the position's own `optExpiryClose`, then `backend/data/underlying-closes.json`, then the completed daily bar the same run already read | **UNKNOWN and flagged** (below) |
| an entry price is recorded (`optEntryNet` / `debit`, greater than 0) | the position | **UNKNOWN and flagged** |

**No broker is asked anywhere in this pass**, in the live code or in the tests. The snapshot is read from disk; it is the options
mirror's to write.

### 2. UNKNOWN, flagged, never guessed

A spread whose legs have vanished but which cannot be priced is **not** settled and **not** estimated. It is marked on the board:

```json
"vanishedUnknown": { "tag": "vanished-legs-2026-10-16", "optExpiry": "2026-09-18",
                     "why": "…, but no stored close of NVDA on 2026-09-18 exists — the settle price is not guessed",
                     "since": "<first raised>", "seen": "<this run>" }
```

said on a `VANISHED, NOT PRICED` line, and the run **exits 2** so the chain surfaces it. The flag keeps the date it was first raised,
and is **lifted** as soon as a run no longer finds that position unknown. The position settles by itself on a later night once the
missing close is stored — no hand-written row, and nothing to undo.

### 3. Mirror orders still shown as "sent"

Each run reads `backend/data/alpaca-options-mirror.jsonl` (read-only; the append-only log is **never** rewritten) and marks every row
whose status is still `"sent"` and whose expiry close has passed as **expired**, in a record of this sweep's own:

```
backend/data/options-mirror-expired.json
  { spec: "options-mirror-expired-v1", asOf, tag, rule, unparsableLogLines,
    marked: [ { key, ticketId, sym, orderId, optExpiry, legs, sentAt, was: "sent", status: "expired", markedAt } ] }
```

Idempotent: a mark keeps the date it was first made. A row's expiry is read from `optExpiry`, from `occAtm`/`occK2`, or from a `legs[]`
list — and a row whose legs disagree on the expiry names none and is left alone. A log line that will not parse is **counted and
reported**, never dropped in silence. If the log is absent the run says so rather than assuming anything.

---

## The standing rule (the operator's to accept)

**No registered test asks for the vanished-legs rule.** It is new, in exactly the sense fix 4.2's debit-vertical rule was new: a
standing rule from the night this file is applied. `record.cjs` therefore writes its change-registry row with
**`breaksComparability: true`** — from that night, spreads that could never settle do settle, and every settled-options population gains
rows it would never have had.

Two things make that reversible:

* every row the rule writes carries `obs.settleTag = "vanished-legs-2026-10-16"`, so any analysis can include or exclude them and so
  they can all be found if the rule is withdrawn;
* a row's `strategy` is the one the position carried and **never** a default. The existing wing rule falls back to `"R21-premium"`; a
  spread this rule settles may come from anywhere on the board, and labelling it `R21-premium` would put rows the premium-harvest
  population never earned into it. Where a position carries no strategy the row carries `null`.

**No registered test's rule, bar, population or read condition was changed, and no test was weakened, skipped or deleted.** No test was
edited at all: this package adds `selftest.cjs` and touches nothing else that tests.

## What does NOT change

Proven by the selftest, not asserted: on each of seven fixture nights the **base** file and the **staged** file are run as separate
processes on the same data, and `trade_log.json`, `board_positions.json` and `board_tombstones.json` are compared byte for byte after
normalising the run's own timestamps.

* the credit-wing rule and fix 4.2's verified-debit rule: same arithmetic, same rows, same order in the ledger (C1, C3);
* the bar calls those rules make — same symbols, same feed, same window (C1);
* the idempotence rule: a row the ledger already holds is never written twice, voided-and-restored wings included (C10, C11, C11b);
* every exit code the file already set;
* a night with nothing past expiry stops exactly where it always stopped (C16).

## The two edits to lines that were already there

Everything else is inserted. For the record, the staged file changes two existing lines:

1. the early return `if (!todo.length) { … Idempotent no-op … }` now also asks whether the vanished-legs pass has a candidate — else a
   night with no wing due would return before the new rule ran;
2. fix 4.7's official-close call is guarded with `!todo.length ? {} :` — with no wing and no debit vertical due, that recording call is
   not made at all rather than made with no symbol and no start date.

and one existing log line gains a third branch so a vanished row prints `entry … value …` rather than `debit … worth …`.

## What this does to the 2026-10-12 package

`docs/profit-fixes/2026-10-12/a-booking` patches this same file with **anchored blocks of lines**, and judges its own state by finding
those blocks intact. This package inserts lines among them, so after `--apply` that package will read **DRIFT** on
`backend/options-settle.js`.

That is expected and nothing operational depends on it: the package is applied and its work is done. `deploy.cjs --plan` prints how it
reads the file **now**, before and after, so the change in that reading is seen rather than discovered. The rule it put in the file is
untouched — the selftest holds seven of its lines, and the original fail-closed lines, byte for byte (check A5).

**If `a-booking` ever has to be reverted, roll THIS package back first** (`rollback.cjs --apply`), which puts its bytes back exactly.

## What a rollback does not undo

Rows the rule has already written (they are tagged; retire them through the normal path with a change-registry tag if the rule is
withdrawn — never by hand), a `vanishedUnknown` flag already on a board position, `backend/data/options-mirror-expired.json`, and a
`record.cjs` row. The head of `rollback.cjs` says the same, and says it again when it runs.

## Tests

```
node docs/options-vanished-settles/2026-10-16/selftest.cjs        ALL 69 CHECKS PASSED
```

* **A** the package: both copies are the bytes `deploy.cjs` names, both parse, the staged file loads as a module and runs nothing
  (`require.main` guard), the lines fixes 4.2/4.7 and the original fail-closed rules depend on are still there byte for byte, and the
  file holds no `/v2/` path, no `fetch(`, and no Alpaca key read.
* **B** the rules as pure functions on known answers: the intrinsic (12 cases plus the grid against the wings' own expression), the leg
  check, the snapshot reader, the vanished test in all six ways it can refuse, the stored-close order, the settle row (five priced
  cases, two refused), and the mirror marks with their idempotence.
* **C** nineteen whole runs as child processes in scratch trees: no regression against the base file, the defect and its fix, UNKNOWN
  flagged and never guessed, the width cap, every way a snapshot can fail to prove the legs are gone, an expired option outside the
  rule, idempotence, the flag lifted and the later self-settle, the mirror marks, an empty board, and a vanished-only night that asks
  for no bar at all.
* **D** deploy and rollback on scratch repos: base → staged → base byte-exact, drift refused both ways, all five fences, a red gate.
* **E** `record.cjs`: `--dry` writes nothing against the real data folder; on scratch data the write, a second run, the no-write window,
  another writer's lock, and home not applied.
* **F** eleven mutants of the staged file, each caught by the check written for it: the snapshot ignored, a snapshot not after the
  expiry accepted, a guessed price, the flag dropped, exit 0 on an unknown, idempotence dropped, the width cap removed, the wrong
  commissions, every mirror row marked, a not-yet-expired row marked, and the rule applied to a position outside it.

**No broker call and no network call of any kind.** Every run is a child process with `harness/no-network.cjs` preloaded, which makes
`fetch`, `http`/`https`, `net.connect` and `dns.lookup` throw *and records the attempt*; check C19 asserts the recorded count across all
runs is **zero**. The bars library is a stub reading a fixture.

## For the operator

```
node docs/options-vanished-settles/2026-10-16/deploy.cjs --plan      read-only; shows drift, the fences, what the rule would find here
node docs/options-vanished-settles/2026-10-16/selftest.cjs           must end ALL <n> CHECKS PASSED
node docs/options-vanished-settles/2026-10-16/deploy.cjs --apply     after 16:00 MT, once tonight's close chain has finished
  … read one live run of the settle step in the chain log …
node docs/options-vanished-settles/2026-10-16/record.cjs --dry       then without --dry, outside 13:50-15:50 MT on a trading day
```

`--plan` is worth reading before the apply: it prints how many board options are past an expiry the ledger does not hold, how many the
rule would settle, how many it would flag, and how many mirror rows still read `"sent"` past expiry — from the data that is at home,
with no broker asked.

### Two file names to confirm at home

This clean copy carries no data and no `backend/alpaca-options-mirror.js` (it did not pass the copy's screens), so two paths this
package reads are named by convention and should be confirmed against the live options mirror before the apply:

* `backend/data/alpaca-options-positions.json` — the stored snapshot of the option legs the broker reports. **If the live mirror writes
  it under another name, or does not write it at all, the vanished-legs rule simply never fires**: `vanishedCheck` answers "there is no
  readable broker snapshot" and every expired spread is left exactly where it is today. The failure mode of a wrong name is the old
  behaviour, not a wrong settle.
* `backend/data/alpaca-options-mirror.jsonl` — the options mirror's order log. If the name is wrong the run says `options mirror log
  absent` and marks nothing.

Expected shapes (both read tolerantly):

```jsonc
// alpaca-options-positions.json
{ "asOf": "2026-09-21T13:05:00Z", "positions": [ { "symbol": "TSLA260918P00400000" }, … ] }
//   also read: a plain list of OCC strings, { legs: [...] }, and entries keyed occ / sym instead of symbol
//   asOf is REQUIRED: without it nothing is ever treated as vanished

// alpaca-options-mirror.jsonl  (one JSON object a line)
{ "ts": "…", "ticketId": "…", "sym": "MSFT", "status": "sent", "orderId": "…",
  "occAtm": "MSFT260918C00500000", "occK2": "MSFT260918C00510000" }
//   also read: "optExpiry": "YYYY-MM-DD", or "legs": [{ "symbol": "…" }, …]
```

`underlying-closes.json` (`{ SYM: { "YYYY-MM-DD": close } }`) is optional: without it the rule prices only from a close recorded on the
position itself or from a bar the same run already read, and flags the rest UNKNOWN rather than guessing.
