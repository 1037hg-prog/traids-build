# Filing wording collector — backlog row 25

**Package** `docs/wording-change/2026-10-16/` · built 2026-10-16 in a cloud build session · branch `claude/wording-change-collector`
**Status** built and proven on fixtures here. Nothing was applied, registered, started or scheduled. The operator applies it at home.
**Read `HANDOVER` at the foot of this file first** — the session was stopped before the independent checker ran.

## What it is

A collector, for the server, that takes each company's annual and quarterly filing text (10-K and 10-Q), splits it into the
standard sections the form prescribes, and records **per filing, per section, a similarity score against the same section of the
company's previous filing** — the cosine of the two sections' word counts — with the filing date beside it.

A score of 1.000000 means the section was re-filed word for word. A score well below the company's own history means the wording
moved, and the section id says where.

Three new files, nothing existing is changed:

| file | layer | what it does |
|---|---|---|
| `backend/lib/filing-sections.js` | parse | standard sections of a 10-K / 10-Q, word counts, cosine. Pure: no clock, no disk, no network. |
| `backend/lib/sec-fetch.js` | fetch | an **injected** fetcher under SEC's fair-access limit (10 requests a second) with a declared User-Agent. |
| `backend/filing-wording-collector.js` | collector | scores each filing against the previous one of the same form; writes one file per company. |

## The two layers, and why they are apart

**The parse layer takes saved filing text.** `splitSections(text, { form })` is a pure function: the same bytes always give the
same sections and the same numbers. It never reads a file, never reads the clock and never opens a socket, so every score in the
store can be reproduced from the saved text alone — and the fixtures under `fixtures/` are the proof.

**The fetch layer takes an injected fetcher.** `makeSecFetcher({ fetcher, userAgent, … })` throws if no fetcher is passed. Nothing
in either layer reaches for global `fetch`, `http` or `https` on its own — `nodeFetcher()` exists, but only a caller that names it
gets a transport, and the package selftest checks that `globalThis.fetch` appears nowhere else in the file. A test that forgets to
pass a fake therefore fails loudly instead of quietly calling sec.gov. **No test in this package touches the network.**

### SEC's rate limit

SEC's fair-access rule is no more than **10 requests a second** from one source, with a declared User-Agent on every request; going
over blocks the host, not the request. So:

- every call, **retries included**, takes a slot from a sliding one-second window. When the window is full the fetcher waits — it
  never drops a request and never runs ahead. The window's clock and its wait are injected, so the selftest drives 25 requests
  through it on a fake clock and asserts that the clock moved at least two seconds and that no second ever held eleven;
- the User-Agent must be given and must not be a placeholder. **There is no built-in value**: this repository holds no personal
  details, so the operator sets `SEC_USER_AGENT` in the server's environment and the collector passes it through. Without it the
  fetcher refuses to be built, before any request is made;
- **429** and **5xx** are retried, waiting out `Retry-After` when the server sends one and doubling backoff with jitter when it does
  not. **403 is never retried** — on EDGAR it means the User-Agent was refused, and repeating it is what gets a host banned.
  **404** is returned, not retried: a missing document is a fact the collector records;
- only `www.sec.gov`, `sec.gov` and `data.sec.gov` are allowed, and only over https.

## The decisions, and why

**"The previous filing" means the previous filing of the same form.** A 10-K is compared with the 10-K before it and a 10-Q with
the 10-Q before it, ordered by filing date (accession breaking a tie). Comparing a 10-Q with a 10-K would measure the difference
between the two forms, not a change of wording. The selftest proves this directly: the 2025 10-Q is scored against the 2024 10-Q
even though a 10-K was filed in between.

**The first filing of a form has no score at all, not a score of zero.** `prev` is null, every section's cosine is null, and each
one carries the note "no previous filing of this form on record". The same holds for a section one filing has and the other does
not: it is listed in `onlyHere` or `onlyPrev` and scored null. Zero means "these two share no word", which is a finding; null means
"there is nothing to compare", which is not.

**Digits are not words.** The tokens are lower-case letter runs, apostrophes and hyphens kept inside a word. Every filing restates
its dates and its amounts, so counting them would report a wording change for a company that only got a year older. There is no
stop-word list and no stemming: the counts are raw, so the number can be recomputed from the text by anyone.

**A 10-Q section id carries its part.** A 10-K runs Items 1–16 in one sequence, so `item1a` names a section. A 10-Q runs two
sequences, and "Item 1" is Financial Statements in Part I and Legal Proceedings in Part II, so the ids are `p1item1` and `p2item1`.

**Choosing the headings: the table of contents problem.** Every item heading appears at least twice — once in the contents at the
front, once over the section itself — and cross-references ("Item 3. Legal Proceedings are described above") add more. Taking the
first match gives the contents and therefore empty sections; taking the last breaks on cross-references. So all line-start
`Item <n>` matches are candidates and the sections are the chain of them that

1. runs strictly forward through the document **and** strictly forward through the form's item order — a chain can never go back to
   an earlier item, which is what rules a cross-reference out; then, among the chains that tie,
2. holds the most items — a chain cannot mix the contents with the body, because the body's Item 1 comes after the contents'
   last entry, which is backwards;
3. has the most **evidence**: for each heading, the text between it and the *next heading match of any kind, used or not*, capped at
   300 characters. Measuring to the next match rather than to the next chosen section is the point — a contents entry is always
   followed closely by the next contents entry, so its evidence is the few characters of its own line, while a real section's
   evidence is its real text. Without that rule a chain could start at the contents' first entry and let it swallow the rest of the
   contents and the first real section, outscoring the body for covering more ground;
4. agrees most often with the `PART` headings seen on the way (10-Q only), then starts latest.

Rule 4 is also why a 10-Q whose body never repeats "PART I" still parses: an ambiguous "Item 2" is offered as both `p1item2` and
`p2item2` and rule 2 keeps whichever lets the chain hold more items; the part headings only break ties.

**What this does not recover.** A filing whose *body* has lost a heading its contents still lists: the chain with the most items
then has to take that item, and every item before it, from the contents. Those sections come out with almost no words, `warnings`
says which sections have no words, and the collector records no score for them — visible, not silent.

**A section's body excludes the heading's standard title.** The titles are identical in every filing; leaving them in would make
two short sections look alike for no reason. A heading line that carries more than its title keeps the rest.

**`overall`** is the cosine over the sections the two filings *share*, concatenated — one number per filing, from the same text as
the per-section numbers, so a cover page or an exhibit index cannot move it.

## What is written

One file per company, `backend/data/filing-wording/<CIK>.json`, through `backend/lib/atomic-write.js` (`writeJsonAtomic`) — the only
way JSON is written in this repository. Rows are keyed by accession and kept in filing-date order; re-running over the same saved
text gives a byte-identical file (the selftest checks exactly that). A later run moves `updatedAt` and nothing else.

Nothing else is written. **No test registration here**: the collector names no test, writes no registry, no seal and no ledger;
there is no `record.cjs` in this package because there is nothing to record. It places no order, calls no broker, and installs,
starts, restarts or schedules nothing. The package selftest asserts all of that against the staged source.

## Running it

```
node backend/filing-wording-collector.js --from-dir <folder> [--data <root>] [--dry]   the parse layer; no network
node backend/filing-wording-collector.js --fetch <CIK> … [--forms 10-K,10-Q] [--since YYYY-MM-DD] [--limit n] [--dry]
node backend/filing-wording-collector.js --show <CIK>
node backend/filing-wording-collector.js --selftest
```

`--from-dir` reads `<folder>/filings.json`, a list of
`{ cik, symbol, form, filingDate, accession, file }`, and the text files it names. `--fetch` needs `SEC_USER_AGENT` in the
environment and refuses without it.

## Fixtures

`fixtures/` holds five filings for two companies that do not exist — SAMPLE WIDGETS INC (CIK 1, ZZZZ) and SAMPLE GADGETS CORP
(CIK 2, YYYY) — written for this package: four plain-text filings and one saved as HTML, with a table of contents, a cross-reference
and a signature page, so the splitter is exercised on the shapes real filings have. `fixtures/filings.json` is written by
`fixtures/make-fixtures.cjs` through `writeJsonAtomic`, never by hand, and the selftest checks it is current.

Two sections are four words each, chosen so the answer can be worked out by hand rather than recorded from the code:

> Item 1B, 2024: `alpha beta beta gamma` → {alpha 1, beta 2, gamma 1}
> Item 1B, 2025: `beta gamma gamma delta` → {beta 1, gamma 2, delta 1}
> dot = 2·1 + 1·2 = 4 · |a| = |b| = √(1+4+1) = √6 · **4 / 6 = 0.666667**

The other known answers the selftest states as literals, from these fixtures:

| filing | section | score | why |
|---|---|---|---|
| ZZZZ 10-K 2025-02-18 | item1 | 1.000000 | Business re-filed unchanged |
| | item1a | 0.956603 | Risk Factors gained one paragraph |
| | item1b | 0.666667 | the worked example above |
| | item3 | 1.000000 | Legal Proceedings unchanged |
| | item7 | 0.519779 | MD&A rewritten from growth to decline |
| | item7a | null | the 2024 filing had no Item 7A (`onlyHere`) |
| | *overall* | 0.944959 | over the five shared sections |
| ZZZZ 10-Q 2025-05-06 | p1item2 | 0.834814 | the quarter's MD&A rewritten |
| | p2item1a | 0.666667 | the worked example again |
| | *overall* | 0.979577 | |
| YYYY 10-K 2025-03-14 | all | null | the only filing on record |

## How it was proven

```
node docs/wording-change/2026-10-16/selftest.cjs            every check; ends ALL <n> CHECKS PASSED
node docs/wording-change/2026-10-16/deploy.cjs --plan       read-only
node docs/wording-change/2026-10-16/deploy.cjs --selftest
node docs/wording-change/2026-10-16/rollback.cjs --selftest
node docs/wording-change/2026-10-16/fixtures/make-fixtures.cjs --check
```

Each staged file also answers `--selftest` on its own, and the package selftest runs all three as child processes and fails if any
of them stops reporting checks.

**The scratch tree.** The three staged files are CommonJS, because `backend/package.json` has no `"type"` field. Under `docs/` the
root `package.json` applies and it says `"type": "module"`, so a staged `.js` file run where it sits is read as an ES module and
will not load at all. Every check that runs the code therefore copies the staged files into a scratch tree shaped like the repo
(`<tmp>/package.json` with no type, `<tmp>/backend/…`, plus the live `backend/lib/atomic-write.js`) and runs them there. The same
tree is where `deploy.cjs --apply` and `rollback.cjs --apply` are exercised end to end — never against this repository.

## Two bugs this found in its own build

Worth recording, because both are the same trap and both were caught by a check rather than by reading:

1. **`Object.keys` is not insertion order for integer-like keys.** The 10-K item order was first derived from
   `Object.keys(K_TITLES)`, and JavaScript lists `"1","2",…,"16"` first, in numeric order, and only then `"1A","1B","7A"…`. That put
   Item 1A *after* Item 16, so every chain through the items was wrong. The order is now written out, and a check asserts Item 1A is
   second, Item 7A eleventh and Item 16 last.
2. **The same trap in a test helper.** `fixture10K` took an object of item → body and built a fixture whose items were out of the
   form's order. It now takes a list of `[item, body]` pairs and refuses a list that does not rise through the form's order.

A third was found by the selftest rather than by a unit check: a manifest row dated `2025-13-01` passed a shape test. `readManifest`
now checks that the date is a real calendar date, not just four-two-two digits.

## Deploy and rollback

```
node docs/wording-change/2026-10-16/deploy.cjs --plan      read-only: each file's sha256 here and at home, and its state
node docs/wording-change/2026-10-16/deploy.cjs --apply     creates the three files (operator, at home)
node docs/wording-change/2026-10-16/rollback.cjs --plan
node docs/wording-change/2026-10-16/rollback.cjs --apply   removes them again
```

`base/` is empty (`base/EMPTY.md` says why): every file is new, so the base state of each is **absent**. `--apply` refuses the whole
package if any target already exists with other bytes — it only ever creates a file, never overwrites one — and it refuses unless the
package selftest ends `ALL <n> CHECKS PASSED`. Each file is written by temp-file-and-rename, read back by sha256 and `node --check`ed;
a failure removes exactly what that run created. `rollback.cjs --apply` removes the three files and **leaves
`backend/data/filing-wording/` alone**: those records took real reading to make, and removing the code that wrote them is not a
reason to delete them. A file edited since the apply is DRIFT, and the whole rollback is refused rather than part of it done.

`deploy.cjs --restage` recomputes the recorded sha256s after an edit under `staged/`. Run it, then the selftest, before pushing.

## Not in this package, on purpose

- **No test registration**, and so no `record.cjs` — the task says so, and there is nothing to record.
- **No systemd unit, timer or scheduled task.** When the server should run this, and how often, is the operator's call; the
  collector is a command that can be run by hand first.
- **No company list.** `--fetch` takes the CIKs it is given. Nothing here decides which companies matter.
- **No threshold and no signal.** The collector records the number. What counts as a meaningful change of wording — a level, a
  z-score against the company's own history, a cross-sectional rank — is a research question and belongs in whatever reads this,
  not in the thing that measures it.

---

# HANDOVER

The session was stopped by the operator on 2026-10-16 after the builder's own checks went green but **before the independent
checker subagent ran**. Everything below is the state of the branch as pushed.

## Done, and green

The package is complete and every check in it passes. Run from the repo root:

| command | result as pushed |
|---|---|
| `node docs/wording-change/2026-10-16/selftest.cjs` | **ALL 69 CHECKS PASSED** |
| `node docs/wording-change/2026-10-16/deploy.cjs --selftest` | 9 passed, 0 failed — PASSED |
| `node docs/wording-change/2026-10-16/rollback.cjs --selftest` | 8 passed, 0 failed — PASSED |
| `node docs/wording-change/2026-10-16/fixtures/make-fixtures.cjs --check` | PASSED (5 filings, 2 companies) |

The three staged files each answer `--selftest` on their own, run by the package selftest as child processes in the scratch tree
(section 2): `filing-sections.js` **27** checks, `sec-fetch.js` **27**, `filing-wording-collector.js` **34** — 88 in all, and the
package selftest fails if that total drops below 60.

The package selftest's seven sections all pass: 1 package integrity (staged sha256s, `node --check`, fixture manifest current),
2 the three unit selftests, 3 the parse layer on the five saved filings, 4 the collector and the store on those filings with the
scores stated as literals, 5 the fetch layer over a fake EDGAR including the rate limit, a 429 and a missing document, 6 the house
rules, 7 a whole `--apply` and `--apply` rollback in a scratch tree.

Everything the task asked for is built: both layers (the parse layer takes saved filing text and never touches the network; the
fetch layer takes an injected fetcher under SEC's 10-a-second limit), per filing and per section a cosine against the same section
of the company's previous filing of the same form, with the filing date, and **no test registration anywhere**.

## Left to do, in order

1. **Run the independent checker.** This is the one part of the build-check-loop that did not happen. A separate checker should,
   read-only, run all four commands in the table above and confirm the counts (69 / 9 / 8, and 27 + 27 + 34 inside section 2).
2. **Mutation-test the checker's findings.** The checks were written to be mutation-resistant but that was never demonstrated.
   Worth trying, each one reverted after: in `backend/lib/filing-sections.js` change `EVIDENCE_CAP` from 300 to 20000 (the
   table-of-contents checks must fail), reorder one entry of `K_ORDER`, make `cosine` return `0` instead of `null` for an empty
   side, drop the `idx` test in `chooseChain`; in `backend/lib/sec-fetch.js` raise the limiter's window to 100 ms or let a 403
   retry; in `backend/filing-wording-collector.js` compare each filing with the previous filing of ANY form instead of the same
   form, or score a missing section 0 instead of null. Each one must turn a named check red. Any mutation that leaves all 69 green
   marks a check that is not pulling its weight.
3. **Re-read the four house-rule scans in section 6 of `selftest.cjs` with fresh eyes.** Three of them were wrong on the first
   pass in the same way — they scanned text that contained the very words they were looking for, so they failed on their own test
   code — and they were fixed by narrowing what is scanned (`codeOf`, `shipped`, `runnable`). A narrowing that goes one step too
   far would make a scan vacuous. The `ok` that asserts the strip really cut the selftests out (sizes and `function …(` still
   present) is the guard against that; check it is doing its job.
4. **Then the usual package route at home**: `deploy.cjs --plan`, read it, `deploy.cjs --apply`, and run the collector by hand once
   with `--from-dir … --dry` before anything is scheduled.

## Nothing was weakened

No test was removed, skipped, loosened or renamed to make anything pass. The check count only ever rose: 24 → 27 in the parse
layer, 25 → 27 in the fetch layer, 25 → 34 in the collector, and the package selftest ended at 69. Four checks changed, and each
changed because the check itself was wrong, never the rule it was testing:

- the cosine known answer was compared to `2/3` with a tolerance when the recorded value is rounded to six places — it now asserts
  the literal `0.666667` **and** the unrounded cosine;
- the markup example expected one newline where the stripper correctly produces a blank line;
- `item1` of the fixture was asserted at 20 words; the text has 21;
- the manifest check expected the wording of a date error that was then made stricter (shape → real calendar date).

## Bugs found and fixed during the build

Recorded because every one of them was caught by a check rather than by reading, and three are the same trap:

1. `Object.keys` is not insertion order for integer-like keys, so the 10-K item order put Item 1A after Item 16 and every chain
   through the items was wrong. `K_ORDER` is now written out, with a check asserting the order.
2. The same trap in the test helper `fixture10K`, which took an object of item → body. It now takes a list of `[item, body]` pairs
   and refuses a list that does not rise through the form's order.
3. The first chain objective let a table-of-contents entry "swallow" the body and outscore it. Replaced by the evidence measure
   described above — a heading's evidence runs only to the next heading match of any kind, used or not.
4. `header()` could not read a `Retry-After` out of a `Map`, so a 429 that sent its headers that way fell back to the default
   backoff. Fixed and checked both ways.
5. `isDate` called `.toISOString()` on an invalid date and threw `Invalid time value` instead of reporting a bad row.
6. `deploy.cjs --restage` threw "markers were not found" when the recorded hashes were already current, because it inferred
   "not found" from "nothing changed". It now tests for the markers and reports "nothing to rewrite".
7. The `/g` strip regex in the package selftest ate the newline the next match needed, so the collector's selftest was never cut
   out of the house-rule scan. The trailing newline is now a lookahead.
