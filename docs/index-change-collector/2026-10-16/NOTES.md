# Index change collector — backlog row 14, the first forced-flow collector

**2026-10-16. Built and tested in a cloud session; nothing here was applied.** The operator runs
`deploy.cjs --apply` at home.

## What it does

Records **announced additions and deletions** for the **S&P 500**, **S&P MidCap 400**, **S&P SmallCap
600** and the **Nasdaq-100**, each with the date it was **announced** and the date it becomes
**effective**, from public announcement pages, to a dated JSONL:

```
backend/data/index-changes/index-changes-<collection date>.jsonl        one JSON row per line
backend/data/index-changes/index-changes-<collection date>.pages.json   the provenance of the run
```

It collects. It scores nothing, trades nothing, sends no order, and **registers no test** — backlog row
14 is collection, and there is no rule, bar, population or read condition here to pre-register.
`record.cjs` writes one change-registry row and one agent-ledger line and does not touch
`test-registry.json`.

## The two dates, and why they are two

`backend/index-recon-test.js` (#53) reads a maintained list of **effective** dates and then assumes, in a
comment, that "announcements precede them by roughly a week". That assumption is the whole trade: the
concession in an index change is paid between the announcement and the effective date, so a window
anchored on the wrong date either misses the move or trades on information nobody had yet. A collector
that writes one `date` field hands the next reader that mistake for free.

So every row carries two separate blocks and no scalar date field at all:

```json
"announced": { "iso": "2026-09-04", "time": null, "timezone": null, "basis": "dateline", "raw": "NEW YORK, September 4, 2026:" },
"effective": { "iso": "2026-09-22", "time": null, "timing": "prior-to-open", "qualifier": null, "raw": "09/22/2026 (timing from the release: …)" },
"knownAt":   { "iso": "2026-09-04", "time": null, "timezone": null, "basis": "announced" }
```

Five mechanics hold the separation, each with a known-answer case in `selftest.cjs`:

1. **No scalar date key.** There is no `date`, `announcedDate`, `effectiveDate`, `ts` or `timestamp` on a
   row, so `row.date` is `undefined` rather than a guess. `auditSeparation()` **fails** a row that grows
   one, and `index-change-collector.js --audit` runs it over a file already written.
2. **No announcement date, no row.** A page whose only dates are effective dates produces **nothing**,
   counted as `no-announcement-date`. Such a row was knowable at no stated time, and the effective date
   must never stand in for it. `fixtures/refused/spdji-effective-only-no-dateline.txt` is that page; the
   selftest asserts zero rows.
3. **A closed list of announcement bases.** `ANNOUNCED_BASES` is `dateline`, `explicit-field`,
   `supplied` — none of which reads the effective date — and `makeRow()` **throws** on anything else.
4. **`visibleAsOf()` is the point-in-time reader** and looks only at `announced`. Its same-day default is
   `exclude`: a row announced on the day a reader asks about is treated as **not yet known**, because the
   announcement may have come after the close. `sameDay: "include"` and `sameDay: "time"` (which compares
   the announcement clock, e.g. 5:15 PM ET) are the caller's explicit choice.
5. **`effectiveOn()` refuses to run without an explicit `asOf`.** A forced-flow date cannot be selected
   without saying what was known when.

Two further traps the parse layer is built against, both with fixtures:

- **A weekday is not a dateline.** `…effective prior to the open of trading on Tuesday, September 22,
  2026:` at the start of a line looks exactly like a press-release dateline. A "city" that is a weekday
  or a month name is refused.
- **"announced on …" in prose points backwards.** A postponement notice says *"the addition of Zeta
  Example Corp …, announced on September 4, 2026, will now take place effective …"*. Reading that phrase
  would date the page to the announcement it supersedes, so only a **labelled field at the start of a
  line** (`Announcement Date: …`) is read as one.

## Two identities, because a postponement is not a second change

| key | what it is | what it is for |
| --- | --- | --- |
| `eventKey` | `index\|action\|symbol\|effective` | "everything that happens on 2026-09-22" — what a flow study selects on. A moved effective date is a new eventKey, which is right: the flow happens on a different day. |
| `changeKey` | `index\|action\|symbol` | "what is the announced plan for ZETA" — `latestByChange()` / `planKnownAsOf()` give the plan as last announced. |

In the fixtures, ZETA's addition is announced on 2026-09-04 effective 2026-09-22, then postponed on
2026-09-10 to 2026-09-29. `planKnownAsOf(rows, "2026-09-08")` says the 22nd; `planKnownAsOf(rows,
"2026-09-12")` says the 29th; `latestKnownAsOf` keeps both, because both days are selectable flows.

## The three layers, and why they are three

| file | what it is | what it cannot do |
| --- | --- | --- |
| `backend/lib/index-changes.js` | **parse**: saved page text → rows | no `fs`, no network, no clock — the selftest checks the source for all three |
| `backend/lib/index-changes-fetch.js` | **fetch**: text → rows with provenance, through an **injected** fetcher | holds no network client; `collect()` **throws** without a fetcher |
| `backend/index-change-collector.js` | **wiring**: builds a fetcher, writes the dated JSONL, prints the plan | the only file with a `fetch(` in it, used only under `--network` |

A test of the collection logic reaches no network because there is nothing in the two library layers to
reach it with (AGENTS.md: tests make no network calls of any kind). The selftest asserts there is
**exactly one** `fetch(` in the whole change, in the collector's `networkFetcher`.

## The parse rules

| rule | shape |
| --- | --- |
| `table` | a self-describing table: Effective Date / Index Name / Action / Company / Ticker columns. **Column order is read from the header**, never assumed. An Announcement Date column, when present, wins over the page's dateline for those rows. |
| `sections` | `The following securities will be added to the Nasdaq-100 Index effective …:` followed by a Company Name / Ticker list. The header sets index, action and effective date for the rows under it. |
| `replace-sentence` | `A (NYSE: AAA) will replace B (Nasdaq: BBB) in the S&P 500 effective …` → two rows, each carrying the other as `counterparty`. |
| `one-sided` | `A (NYSE: AAA) will be added to the S&P MidCap 400 effective …` → one row. |

A page usually feeds more than one rule and says the same thing twice (a sentence and the table under
it). Duplicates are folded by a fingerprint that is **not** a function of the fetch time or the page's
sha256, so re-collecting the same page tomorrow writes nothing new; the row from the more specific rule
is kept and anything only the other rule knew (the company name, the deletion reason, the name on the
other side) is filled in from it rather than thrown away.

Wrapped prose is put back on one line first (`dewrap`), because an effective date is routinely wrapped
away from the sentence that owns it. Tables, lists and blank lines are left exactly where they were.

## What it refuses rather than guesses — all counted, never silent

| reason | example |
| --- | --- |
| `unknown-index` | the same release carries S&P 500 ESG and S&P Composite 1500 rows; folding them in would poison the population |
| `no-announcement-date` | mechanic 2 above |
| `unparsed-row` | a table row whose cell count does not match its header (a company name with a single space before its ticker). The rows **around** it are still read. |
| `no-ticker` | a cell holding any lower-case letter is not a ticker — otherwise a short prose word in the last column becomes a constituent |
| ambiguous dates | `22/09/2026` is refused, not read as 22 September; `February 30, 2026` is refused |

A dead page, an empty page and a fetcher that throws are each recorded as a **problem**, never as "zero
changes". One bad source never loses the others.

## The deletion reason, and #53's survivorship trap

A name leaves an index because it was **acquired** (the price ends near a bid, the series stops) or
because it **fell out** (the series continues). #53's header calls that trap live in exactly this test,
and this project has been caught by that class of bias three times. `reason` (one of `acquisition`,
`merger`, `spin-off`, `bankruptcy`, `delisting`, `migration`, `market-cap`) is read **at collection
time**, from the page that still says which it was, with `reasonRaw` keeping the words — instead of
leaving a later reader to infer it from whether a price series happens to exist.

## What this package ships

Three **new** files and no change to any existing one:

```
backend/lib/index-changes.js
backend/lib/index-changes-fetch.js
backend/index-change-collector.js
```

So `base/` holds no file copies — the base state of each path is its **absence**, and that is what
`rollback.cjs` restores. `base/README.md` says so. One live file is **required and not changed**:
`backend/lib/atomic-write.js` (`writeTextAtomic` / `writeJsonAtomic`); `deploy.cjs --plan` refuses if it
is missing, and the selftest copies it into its scratch tree byte for byte from the repository.

### Commands

```
node docs/index-change-collector/2026-10-16/selftest.cjs            115 checks on the staged bytes, in a scratch tree
node docs/index-change-collector/2026-10-16/deploy.cjs --plan       read-only: each path's sha256 now and staged, its state
node docs/index-change-collector/2026-10-16/deploy.cjs --apply      the operator's command: the selftest gate, then the three files
node docs/index-change-collector/2026-10-16/rollback.cjs --plan     read-only: what would be removed
node docs/index-change-collector/2026-10-16/rollback.cjs --apply    removes the three paths (only when each is the staged copy)
node docs/index-change-collector/2026-10-16/record.cjs --dry        the change-registry row it would write; registers no test
```

**No fence, and none is pretended.** Nothing at home reads these paths yet: no existing file requires
them, no scheduler entry runs them, and the collector runs only when a person types it. There is no
window in which an apply could land under a running process and nothing to restart. `rollback.cjs`
checks the repository for anything that `require`s these files and refuses if it finds one, so that stops
being true the moment something calls it.

`deploy.cjs --apply` refuses on **drift**: a path that exists with other bytes is never overwritten.
`rollback.cjs --apply` refuses the same way, and removes a path only when it is byte for byte the staged
copy — it never deletes bytes it did not write.

### After the apply

Nothing runs by itself. The collector is a command:

```
node backend/index-change-collector.js --dir <saved pages> --dry   read-only, no network, prints every row it would write
node backend/index-change-collector.js --network --dry             fetches the public pages, writes nothing
node backend/index-change-collector.js --network                   writes backend/data/index-changes/index-changes-<today>.jsonl
node backend/index-change-collector.js --audit                     the separation guard over what was written
node backend/index-change-collector.js --selftest                  known answers, in-process
```

`--network` is never the default: with no mode the command refuses and says so, so it cannot reach the
network by accident. The two source pages it would fetch are in `DEFAULT_SOURCES`
(`backend/lib/index-changes-fetch.js`) — the S&P Dow Jones Indices announcement listing and Nasdaq's
index news. **The operator should look at a saved copy of each of those two pages before the first
`--network` run** and point `--dir` at it: a page's layout is the one thing a fixture cannot promise,
and `--dir … --dry` says exactly what the collector would make of it, including every row it refused.

## The fixtures

`fixtures/pages/` (six well-formed pages, exit 0, no problems) and `fixtures/refused/` (two pages that
must be refused or partly refused). Every page is **fictional**: invented companies (Zeta Example Corp,
Alpha Example Holdings), invented tickers (ZETA, ALEX, NUEX), `example.invalid` URLs, and no real index
membership is asserted anywhere. The expected answers in `selftest.cjs` were written by hand from those
pages, not generated from the code. The whole set is 23 rows and 2 refusals; the fixture dates are all
in the past so the collector's "collected before it was announced" check can run with the real clock.

## Checked

| check | result |
| --- | --- |
| `selftest.cjs` (staged bytes, scratch tree, no network, no data) | **ALL 115 CHECKS PASSED** |
| `backend/index-change-collector.js --selftest` (in-process known answers) | **ALL 23 CHECKS PASSED** |
| `node --check` on all three staged files and all four package scripts | clean |
| `deploy.cjs --plan` / `rollback.cjs --plan` / `record.cjs --dry` in this repository | exit 0, nothing written |
| deploy → rollback round trip against a scratch repository, drift refused both ways | in `selftest.cjs` section G |

No test was edited, weakened, skipped or deleted; none exists for this code yet, and none was registered.

## What this does not do, stated rather than left to be discovered

- **It does not fetch anything by itself.** No scheduler entry, no close-chain step, no retry loop. If
  the operator wants a daily collection, that is a separate change with its own notes.
- **It does not reconcile against index membership.** A deletion row is what a page announced, not proof
  that the name left; nothing here reads a constituent list or a price series.
- **It does not handle every announcement shape.** A replace sentence with no ticker in parentheses
  produces no row (and no refusal count, because the rule never matched it) — `fixtures/pages/` has one
  such sentence, in the trailing paragraph of the S&P table page, and the table above it carries the
  same two names, which is how these releases are written. The honest check on a real page is
  `--dir … --dry` and reading the refusals.
- **It does not interpret `effective.timing` beyond what the page says.** `prior-to-open`, `at-open`,
  `after-close`, `intraday` or `null` — it never assumes one.
- **It writes no JSON by shell.** Both files go through `backend/lib/atomic-write.js`, as AGENTS.md
  requires.

## HANDOVER

Handed over mid-loop on operator instruction, 2026-10-16. **The builder finished; the independent check
cycle did not.** Everything below is on branch `claude/index-change-collector`.

### Done

1. **The parse layer** — `staged/backend/lib/index-changes.js`. Saved page text in, rows out; no `fs`,
   no network, no clock. Four rules (`table`, `sections`, `replace-sentence`, `one-sided`),
   normalisation of index / action / ticker / company / date / effective phrase / deletion reason,
   `dewrap` for wrapped prose, duplicate folding across rules, and the whole separation apparatus
   (`announced` / `effective` / `knownAt`, `eventKey` / `changeKey`, `visibleAsOf`, `latestByKey`,
   `latestByChange`, `latestKnownAsOf`, `planKnownAsOf`, `effectiveOn`, `auditSeparation`, `mergeRows`).
2. **The fetch layer** — `staged/backend/lib/index-changes-fetch.js`. Injected fetcher only; `collect()`
   throws without one; per-page provenance (sha256, byte length, fetch time); one bad source never loses
   the others.
3. **The wiring** — `staged/backend/index-change-collector.js`. `--dir` (saved pages), `--network`
   (the only socket in the change, never the default), `--dry`, `--audit`, `--selftest`, `--date`,
   `--out`, `--indexes`; `htmlToText`; the dated JSONL and the `.pages.json` sidecar, both through
   `backend/lib/atomic-write.js`; append-only (a row already on file is not written twice).
4. **Fixtures** — `fixtures/pages/` (6 well-formed, fictional pages → 23 rows, 2 refusals, no problems)
   and `fixtures/refused/` (the effective-dates-only leak trap → 0 rows; the misaligned table → 2 rows
   read, 2 rows counted as `unparsed-row`).
5. **The package** — `lib.cjs` (file table with the staged sha256s, plan, write unit, selftest gate),
   `deploy.cjs --plan|--apply`, `rollback.cjs --plan|--apply`, `record.cjs [--dry]`, `base/README.md`,
   `selftest.cjs`, this file.

### Checks that pass, as of the handover

| command | result |
| --- | --- |
| `node docs/index-change-collector/2026-10-16/selftest.cjs` | **ALL 115 CHECKS PASSED** (exit 0) |
| `node backend/index-change-collector.js --selftest` (from a scratch tree) | **ALL 23 CHECKS PASSED** (exit 0) |
| `node --check` on all 3 staged files and all 5 package scripts | clean |
| `deploy.cjs --plan` | exit 0, all three paths `absent`, nothing written |
| `rollback.cjs --plan` | exit 0, nothing to roll back, nothing written |
| `record.cjs --dry` | exit 0, prints the row, `test-registry.json` untouched |
| `--dir fixtures/pages --dry` | 23 rows, 2 refusals, **0 problems** |
| `--dir fixtures/refused --dry` | 2 rows, 3 refusals, the 2 expected problems (exit 1, as a page with a problem should) |
| deploy → rollback round trip + drift refused both ways, against a scratch repository | `selftest.cjs` section G |

115 is the floor: **a later cycle must not report fewer checks than 115**, and no check may be removed.
No test was edited, weakened, skipped or deleted (none existed for this code), and no test was
registered.

### The independent check: ONE cycle ran, and NOTHING it found was fixed

A separate checker ran every command above read-only, verified AGENTS.md compliance, and ran 22
mutation tests against its own copy of the package. **Its report arrived after the handover order, so
not one of its findings has been acted on.** What it confirmed, and what it found, in its own order:

**Confirmed.** All 10 commands at the documented exit codes; 115 `ok` and 0 `FAIL` counted
independently; the three staged sha256 constants match the staged bytes; `base/` holds only its README;
`index-changes.js` has **zero** `require(` calls and no clock or fs reference at all; the fetch layer
requires only `crypto`; the single `fetch(` is `index-change-collector.js:146` inside `networkFetcher`;
no secrets, no emails, no phone numbers, no real people, no hosts but `example.invalid` and the two
public provider pages; JSON only through `atomic-write.js`; `test-registry.json` never read or written;
nothing applied and the working tree clean. 13 of the 14 prescribed mutations were caught, several by
many checks at once.

**The finding that matters most — the suite cannot fail on its own thesis.** Making `findAnnounced()`
fall back to the release's effective phrase passes **115/115**, and produces rows with
`announced == effective == knownAt`. That is precisely the leak this collector exists to prevent, named
in the task, in the header of `index-changes.js` and three times in this file. The reason the one
fixture misses it: `fixtures/refused/spdji-effective-only-no-dateline.txt` carries its effective dates
only in **table cells**, and its one prose sentence has no date in it, so `findReleaseEffective()`
returns `{iso: null}` and the fallback never fires. Mechanic 2 is presented above as proven. It is
proven only against a page that cannot exercise the leak path.

### Left to do, in order

1. **The missing fixture for the leak.** A page stating an effective date **in prose**, with no dateline
   and no labelled field, plus a check asserting `findAnnounced()` is `null`, `rows.length === 0` and
   `skipped[0].reason === "no-announcement-date"`. Then re-run the mutation and confirm it now fails.
2. **Two guards that fire zero times on the fixtures**, each removable without any check noticing: the
   weekday/month-as-city guard (`index-changes.js:376` — removing it reads
   `"Tuesday, September 22, 2026: …"` as a dateline, the same leak) and `not-requested-index`
   (`:294` — `collectRun` narrows whole sources upstream, so the row-level refusal is never exercised).
   The claim above that both datelines traps have fixtures is **false** for the weekday one; fix the
   fixture, not the sentence.
3. **The write-path guard is untested.** Deleting `if (!run.audit.ok) … return 2`
   (`index-change-collector.js:405`) passes 115/115: every section-F check is `--dry` or calls
   `collectRun` directly. Same for `auditSeparation`'s `announced.basis` check (`:789`).
4. **`selftest.cjs` dies instead of naming the failing check** in three mutation classes — `:188`
   (`phix.knownAt.iso` when `knownAt` is null), `:196` (`E.skipped[0]` when empty), `:310-312` (reads a
   file a refused `writeUnit` never wrote). The deploy gate still holds, but the `checks` array prints
   at `:349`, after the throw, so the operator gets a stack trace and no diagnosis. Worst case: the
   "this package was edited since review" check at `:299` is computed and never shown.
5. **`parse.line` is wrong on every row.** `parsePage` dewraps first and the line-based rules number the
   *dewrapped* lines (`index-changes.js:654-655`, used at `:477`, `:538`, `:569`, `:593`); on the S&P
   table fixture dewrap collapses 27 lines to 21, so every row is off by two and LMEX's `parse.line`
   points at the header row. This is the field that tells the operator where a row came from, and
   step 7 below asks them to check exactly that by hand. The one check that touches it
   (`selftest.cjs:131`) bakes the wrong numbering in.
6. **An ambiguous or impossible date in an Effective Date column is dropped silently** and mislabelled:
   `22/09/2026` and `February 30, 2026` give `effective.iso: null`, `qualifier: "no-date-in-text"`, no
   `skipped` entry, no problem, exit 0 (`index-changes.js:214-223`, `:466-467`). The qualifier asserts
   the cell held no date, which is false, and "all counted, never silent" above is false for this case.
   A source switching to d/m/Y would produce 100 % undated rows and exit 0. Count it, or delete the
   claim.
7. **A real saved copy of each of the two `DEFAULT_SOURCES` pages** through `--dir <copy> --dry`, reading
   the refusals. Still the biggest open risk, and now with a measured hazard: **`dewrap` is O(n²)** —
   23 s on an 860 KB saved page, 2.5 s on 280 KB (`index-changes.js:624-634` re-runs `prose(prev)` over
   the growing accumulated line). A large provider listing will look like a hang. No regex backtracking
   cliff was found; the bounded lazy quantifiers hold.
8. **Pin `fingerprint()`'s components with a check** — dropping `announced` from it passes 115/115
   (`index-changes.js:266-269`), which would fold two announcements of the same event into one row and
   destroy the "last announced" semantics `latestByKey` and `planKnownAsOf` are built on.
9. **Dead vocabulary, dead code, and documentation that disagrees with itself.** `"no-company"`
   (`:81`) is never produced; `"other"` (`:80`) is never returned and is missing from the reason list
   above; `EFFECTIVE_TIMINGS`, `SKIP_REASONS` and `RULES` are exported but validate nothing;
   `run.pagesPath ||` (`index-change-collector.js:408`) is permanently `undefined`; "Four mechanics"
   (`index-changes.js:28`) vs "Five mechanics" above; "four package scripts" vs "5 package scripts"
   above — there are five; `--plan` exits 1 for what `--apply` calls exit 2 in both `deploy.cjs` and
   `rollback.cjs`, against their own documented codes; a zero-byte JSONL can be written and then
   audited clean (`:407`); and `--dir` outside the repo prints a `../../../..` path.
10. **Only then** `deploy.cjs --apply` at home, then `record.cjs --dry`, then `record.cjs`.
11. Not in scope here and not started: any scheduled collection, any reconciliation against constituent
    lists or price series, and any registered test that reads these rows.

Every item above is a check to **ADD** or a defect to fix. None of them is a reason to loosen the code
to match a test, and no existing check may be removed or weakened: the floor stays **115** for
`selftest.cjs` and **23** for the collector's `--selftest`.

### The two gaps that were deliberate, and remain open

A replace sentence with no ticker in parentheses produces no row *and no refusal count*, because the
rule never matched it. A section that inherits the release's effective date is flagged
(`effective-from-release-default`) but not otherwise questioned. Whether either needs a rule depends on
step 7.
