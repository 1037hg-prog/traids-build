# Insider clusters — a Form 4 collector for the server, and a cluster finder over it

**Package** `docs/insider-clusters/2026-10-16` · **built** 2026-10-16 in a cloud build session · **applies** nothing (the operator
runs `--apply` at home) · **registers** nothing.

---

## What this is

Two entry points and four libraries, all **new files**:

| file | what it is |
|---|---|
| `backend/lib/sec-fetch.js` | the one way this desk asks sec.gov for anything: an **injected** fetcher, a **required** declared User-Agent, ten requests a second at most, retries with backoff and `Retry-After`, an SEC-hosts-only allowlist |
| `backend/lib/form4-parse.js` | a filing's text → its officer / director open-market purchases. Pure |
| `backend/lib/insider-buys-lib.js` | the company-day record and the dated JSONL it lives in; merging keyed by accession. Pure |
| `backend/lib/insider-cluster-lib.js` | the trading-day calendar and the cluster rule. Pure |
| `backend/insider-buys-collect.js` | the server's daily run → one dated JSONL per filing day |
| `backend/insider-clusters.js` | three or more distinct insiders inside ten trading days → one dated JSON |

```
SEC_USER_AGENT="<product> (<how to reach the operator>)"        # set at home; there is no contact string in this repository
node backend/insider-buys-collect.js --date 2026-11-17 --dry    # reads sec.gov, writes nothing
node backend/insider-buys-collect.js --date 2026-11-17          # writes backend/data/insider-buys/insider-buys-2026-11-17.jsonl
node backend/insider-clusters.js --dry                          # reads files only
node backend/insider-clusters.js                                # writes backend/data/insider-clusters-<as-of>.json
```

No order, no broker call, no key, no schedule, no restart. The collector reads sec.gov and writes a file; the cluster finder reads
files and writes a file.

---

## The rules, stated so a later reader can disagree with them

**A qualifying purchase.** An **original** Form 4 (not a 4/A), a **non-derivative** transaction, `transactionCode` **P**, acquired
(`A`), shares > 0, price per share > 0, common or ordinary stock (or a Class A/B line of it), and at least one reporting owner who is
an **officer or a director**. A pure 10% holder does not count: the question is what the people who run the company do with their own
money.

**The day is the day they bought.** The record is keyed by the Form 4's `transactionDate`, not the filing date — three insiders buying
on one Tuesday are one Tuesday's cluster however the paperwork lands. But the filing dates are kept on every record and every cluster,
because **for anything that trades on this the public moment is the filing**. Each cluster carries `triggerBuy` (the day the third
insider bought) and `publicOn` (the day the last of its filings appeared). `publicOn` is the only one a reader may act on;
`triggerBuy` is up to two business days earlier and using it is look-ahead. `publicOnKnown` is false when any filing in the cluster
carried no filing date.

**Dollars are summed over accessions; insiders are counted over owners.** A Form 4 with two reporting owners (a trust and its
trustee) reports *one* set of purchases twice over. Giving the filing's dollars to each owner doubles the money. So `usd` is the sum
over distinct accessions and `insiders` is the count of distinct owner CIKs. Each `byInsider[].usd` is **derived** — the sum, over the
filings that insider reported, of that filing's dollars divided by its number of reporting owners — so the per-insider figures always
add back up to the day's `usd`, and nothing is carried as a running total that a second look could double. That even split is the
record's **one** assumption, and `jointFilings` says when it was used.

**Ten trading days, inclusive.** A cluster's first and last buy day are at most nine trading days apart. Trading days come from the
desk's own holiday table (`backend/lib/run-window.js` `MARKET_HOLIDAYS`), **not** from "ten weekdays". The two differ over
Thanksgiving, and the difference decides whether a real cluster is found — the selftest pins exactly that case (see *Known answers*).

**One company-day to at most one cluster.** Scanning day by day, the first day whose ten-trading-day window holds three distinct
insiders is the trigger; the cluster is every company-day in that window, and those days are then spent. Without that rule a run of
five insiders over two weeks reports as four near-identical clusters.

**A calendar that does not cover the dates is a refusal.** `MARKET_HOLIDAYS` is extended by hand each December; it currently covers
2026-09-07 … 2027-12-31. Outside that range a market holiday would silently count as a trading day and every window would come out
too narrow, so `tradingCalendar` **refuses** and names the dates. `--allow-uncovered-calendar` runs anyway and marks the result
`uncovered`, which is carried into the written file.

**A buy dated on a closed day** (a Saturday, a holiday — a few Form 4 dates are keyed by hand and land there) is placed on the **next**
trading day, never the previous one, so a misdated buy can never pull a window earlier than the market allows. The cluster says so
with `offCalendarDays`.

---

## The SEC's two rules, enforced rather than hoped for

The SEC asks every caller to **declare itself in the User-Agent** and to make **no more than ten requests a second**
(`https://www.sec.gov/os/webmaster-faq#developers`).

- `userAgent` is **required**. There is no default and no fallback: a missing, too-short, too-long, line-broken, placeholder
  (`REPLACE_ME`, `<your email>`, `example.com`) or browser (`Mozilla/5.0…`) string refuses the run before anything is written.
  **There is no contact string anywhere in this repository** — the operator sets `SEC_USER_AGENT` at home. An un-set setting must
  never read as a set one, and an anonymous read is what gets the whole desk blocked.
- `perSecond` defaults to 10 and is **capped** at 10. A caller asking for more is refused; asking for less is obeyed. The limiter
  counts a **rolling** second, not a bucket that empties on the clock's second boundary, so ten a second is ten in *any* second —
  never ten at `:00.999` and ten more at `:01.001`. A `Retry-After` hold stops **every** call, not only the one that was refused,
  and the calls already counted stay counted (emptying the window on a short hold is how a hold turns into twenty calls in a second).
- Only `https://www.sec.gov` and `https://data.sec.gov` are read. A filing's own content can never point this desk somewhere else.
- A **403** stops at once naming the User-Agent: on sec.gov that is the UA block, not a transient failure, and retrying it earns a
  longer one. A **404** is an *answer* (`notFound`), not a failure. A **429**, a **5xx**, a timeout, a dropped connection and an
  unreadable body are retried with backoff inside a budget; a call that still fails returns `failed` with its reason and the caller
  decides.

**The fetcher is injected and there is no global-fetch fallback.** `sec-fetch.js` refuses to be built without `fetchFn`. Only the
collector's CLI block hands in `globalThis.fetch`, in one readable place. That is why the selftest can run the whole collector over
saved filings and be *certain* no request left the machine — and why a test that forgets to inject one gets a refusal rather than a
request to the SEC.

---

## What it writes

`backend/data/insider-buys/insider-buys-<filing day>.jsonl`, through `backend/lib/atomic-write.js` `writeTextAtomic` (temp file,
fsync, rename: a kill mid-write leaves the old file whole, never half a day's rows). One line per company per transaction day:

```json
{"spec":"insider-buys-v1","kind":"company-day","cik":"0001000001","sym":"AAAA","issuer":"FIXTURE ALPHA CORP",
 "tradeDate":"2026-11-16","insiders":2,"usd":16000,"shares":1500,
 "roles":{"officer":1,"director":1,"officerAndDirector":0},"roleList":["director","officer"],
 "titles":["CHIEF FINANCIAL OFFICER"],
 "byInsider":[{"ownerCik":"0002000001","role":"officer","titles":["CHIEF FINANCIAL OFFICER"],"usd":10000,"shares":1000,
               "accessions":["0009000001-26-000001"]}, …],
 "accessions":[{"accession":"0009000001-26-000001","filedOn":"2026-11-17","usd":10000,"shares":1000,
                "owners":["0002000001"]}, …],
 "filings":2,"jointFilings":0,"firstFiledOn":"2026-11-17","lastFiledOn":"2026-11-17","filingLagDays":1,
 "collectedOn":"2026-12-01"}
```

plus one `kind:"run"` line per run saying what was asked, what was read, and what was **not**. A reader filters on `kind`.

`accessions` is the record's ledger — every per-insider number is derived from it, so the record can be audited from itself.

**Re-running a day is free and changes nothing.** Every sum is keyed by accession: a second run of the same day leaves every
company-day line byte for byte as it was (the run line is new each run, deliberately — it is the record of *that* run's partial read),
and a later run adds only the filings that are new. That matters because the fourth insider's filing often arrives two days after the
first three.

**Nothing silently shrinks.** A company-day already in the file that this run did not see is kept and counted unchanged. A
company-day in the file that cannot be merged at all (damaged by hand) is set aside **with its reason**, which makes the write a loss —
so the run refuses, leaves the file byte for byte as it is, and exits 3.

---

## What is NOT known, and what is owed

- **Code P is "open market *or private* purchase".** The SEC does not separate them and the filing does not say which, so a privately
  negotiated purchase is included here and cannot be told apart. That is a property of the SEC's own coding, not a choice made here.
- **Amendments are skipped, not reconciled.** A 4/A restates a filing already counted, so summing both doubles the purchase. They are
  counted in the run line (`filings.amendments`) and never summed. A 4/A that *corrects* a price or a date therefore leaves the
  original's number in place. Reconciling them is a separate change.
- **Derivative transactions are not read** — an option exercise or a warrant is not an open-market buy.
- **Share counts and dollars are the filing's own.** No split adjustment and no price check against the tape: if an insider reports
  1,000 shares at $10.00, the record says $10,000.
- **A company-day may be incomplete for a while.** A filing is due two business days after the transaction, and a day's record is only
  as complete as the filings seen so far. The cluster run names every filing day whose own run line said `complete: false`, because
  "three insiders" is a different claim when one of the day's filings was never read.
- **No test is registered and nothing is graded.** This ships a collector and a finder. What they find is not a claim until a test
  over it is registered **at home, before any of this data is read**. `record.cjs`'s row says so in `notGiven`, so a later reader
  cannot mistake "the collector shipped" for "the signal was tested".
- **R137 is untouched.** `backend/r137-insider-signals.js` built a similar signal once, by hand, from the SEC's quarterly bulk files,
  for a single six-month read; its rule differs (30 *calendar* days, a $10,000 floor per insider, one signal per issuer per 180 days,
  keyed by *filing* date). Nothing here reads or changes it. The two are not interchangeable and the differences are listed here
  rather than averaged away.

---

## How it was proven

`node docs/insider-clusters/2026-10-16/selftest.cjs` — **145 checks, all passing**, last line `ALL 145 CHECKS PASSED`.

It writes nothing in the repository (scratch trees in the OS temp folder only), reads no key, places no order, and **makes no network
call of any kind**: `harness/no-net.cjs` is its first require, so every `fetch` and every socket of the process is refused, and the
collector's fetcher is `harness/fixture-fetch.cjs` reading the **saved fixture filings** in `fixtures/`.

The fixtures are real saved submissions in the shape the SEC serves them (the SGML wrapper around the ownership XML), and
`fixtures/build-fixtures.cjs` is how they were made — kept so the whole set is reproducible and reviewable in one place. Check **A4**
holds every saved file to that builder byte for byte, so **a fixture quietly edited to make a test pass fails the selftest instead**.
Everything in them is plainly fake and holds no personal detail: issuers FIXTURE ALPHA CORP … FIXTURE ECHO PLC (AAAA … EEEE), owners
"FIXTURE OWNER ONE" … "FIXTURE OWNER THIRTEEN", never a person. Check **A5** greps the whole package for an email address, a phone
number, an IP address or a key-shaped assignment and fails on any.

### Known answers

The nine company-days and the two clusters are pinned to the dollar and the share (**F1**, **G1**):

| | insiders | dollars | buys | span | public |
|---|---|---|---|---|---|
| **AAAA** | 3 (one of them buying on two days) | $26,700 | 2026-11-16 … 2026-11-30 | **10 trading days** | 2026-12-01 |
| **BBBB** | 3 | $4,200 | 2026-11-21 (a Saturday) … 11-24 | 2 trading days | 2026-11-25 |
| **EEEE** | 3 | — | 2026-11-16 and 2026-12-01 | **11 trading days → no cluster** | — |

**The trading-day check (G3).** AAAA's cluster spans 2026-11-16 to 2026-11-30, which is ten trading days *because* 2026-11-26 is
Thanksgiving. Take Thanksgiving out of the holiday table and it is eleven, and the cluster becomes a different, smaller one: it no
longer reaches back to 11-16, so it starts 11-17 and holds $10,700 of the $26,700. That one holiday is worth $16,000 and two weeks of
history, which is why the calendar refuses a range it cannot cover.

The other known answers: the joint filing's $20,000 counted once with two insiders at $10,000 each (**D7**); the ten-percent-owner-only
filing that counts for nothing (**D3**); a sale, an award and an exercise with no purchase (**D4**); a code-P transaction marked
*disposed*, which is not a purchase whatever the code says (**D14**); a purchase with no price and a purchase of preferred stock, both
excluded with no dollars invented (**D5**); the 4/A that is read, marked and not summed (**D6**); the truncated submission that reads
**unreadable**, never "no purchases" (**D9**); the submission whose EX-24 exhibit comes *first*, where reading the first ownership
document in the file would read the wrong one (**D8**); the limiter's 400 calls peaking at ten in any rolling second and taking the 39
seconds that implies (**B5**); the 429 that holds every call for the time it asks (**C4**); the 404 index that is clean on a Saturday
and a failed read on a trading day (**F8**); a filing answered 503 on every try, which is unresolved and gets no company-day while the
run exits 3 (**F7**).

### Mutation tests

Section **H** builds **31 mutants** of the staged code — each a real weakening someone might make — and requires every one to change
a known answer above. All 31 are caught. Among them: the limiter accepting eleven a second; the rolling second removed; a placeholder
User-Agent accepted; the global-fetch fallback restored; the host allowlist widened; a 403 retried; a 404 turned into a failure; any
transaction code counting; a disposal counting as a purchase; a ten-percent holder counting as an insider; an amendment summed on top
of its original; a no-price purchase counted at $0; preferred counting as common; the exhibit read instead of the Form 4; a joint
filing's dollars given to each owner in full; a filing added twice; the shrink guard silenced; the window widened by a day; the
calendar counting weekdays; insiders counted per buy day instead of per person; a company-day joining two clusters; an off-calendar
date placed backward; an uncovered range running instead of refusing; an unfetched filing passed over in silence; a missing index on a
trading day read as an empty day; the index dedupe removed; an unreadable filing counted as "no purchase"; the incomplete filing days
hidden from the cluster run.

The mutation harness refuses a replacement that does not match its anchor exactly once (`harness/tree.cjs` `mutate`), so a mutant that
silently changed nothing can never read as "the check survived it".

### Tests changed, weakened or removed

**None.** This package registers no test and edits none; nothing existed for it to change. Three selftest expectations were corrected
**upward in strictness** while it was being built, each because the code was right and the first expectation was wrong — and each
correction is now pinned harder than before:

1. **G3** first claimed that removing Thanksgiving makes AAAA's cluster *disappear*. It does not: it makes it a *different, smaller*
   cluster ($10,700 from 11-17). The check now pins the exact smaller cluster, which is a stronger statement than "it is gone".
2. **G8** (`--min-insiders 2`) first expected three clusters; the correct answer is five, because AAAA's 11-16 and 11-17 each reach two
   insiders on their own and 11-30+12-01 reach two more. The check now pins all five with their dollars and trigger days.
3. **F6** first demanded that a re-run leave the dated files byte-identical. The run line is new each run **by design** — it records
   what *that* run asked and read, which is how a partial read is remembered. The check now pins the company-day lines byte for byte
   *and* that all nine are counted unchanged, which is the invariant that actually matters.

Two guards were also made **reachable** rather than left as unreachable belt-and-braces: `lostDaysOf` became its own function so the
shrink guard can be held to a known answer (**E5b**), and a company-day that cannot be merged is now set aside with its reason instead
of taking the run down — which is what makes the collector's refusal path real, testable (**E5c**, **F11**) and mutation-covered.

---

## Deploy, rollback, record

```
node docs/insider-clusters/2026-10-16/deploy.cjs --plan      # read-only: each file's sha256 now / staged, its state, the fences
node docs/insider-clusters/2026-10-16/deploy.cjs --apply     # the operator's command, at home
node docs/insider-clusters/2026-10-16/rollback.cjs --plan    # read-only
node docs/insider-clusters/2026-10-16/rollback.cjs --apply   # removes exactly the six files this package created
node docs/insider-clusters/2026-10-16/record.cjs --dry       # prints the two records; writes nothing
node docs/insider-clusters/2026-10-16/record.cjs             # one change-registry row + one GOVERNANCE ledger line
```

`base/` **holds no bytes**, and that is correct: this package replaces nothing, so every `FILES` entry in `deploy.cjs` carries
`baseSha: null` ("not at home yet") and the three states are **absent** (→ create), **applied**, and **DRIFT** (that path exists
holding *other* bytes → both the apply and the rollback refuse, and the file is never removed). `base/WHY-EMPTY.txt` says the same, and
check **A2** holds every entry to `baseSha: null` so the folder cannot quietly stop being empty.

`--apply` refuses on drift; refuses on a trading weekday between 05:30 and 16:00 MT; refuses while `insider-buys-collect.js` or
`insider-clusters.js` is running; refuses when the process list cannot be read at all (fail-closed); then requires this package's
selftest to end `ALL … CHECKS PASSED`, asks the fences again, and writes each file temp-file-and-rename, reads it back by sha256 and
runs `node --check`. Any failure removes the files that run created. It schedules nothing and restarts nothing.

**A rollback does not undo the data.** The dated files the collector already wrote (`backend/data/insider-buys/*.jsonl`,
`backend/data/insider-clusters-*.json`) stay: they are a record of what the SEC published, and removing the reader is no reason to
destroy the record. Nor does it undo the `record.cjs` rows — a row is never removed; a rollback after a record is said in a *new* row.

`harness/refresh-shas.cjs` is a build-time tool (not part of what ships) that rewrites `deploy.cjs`'s staged sha256s from the bytes on
disk. Check **A1** is what holds them together afterwards.

---

## For the operator, before the first real run

1. Set `SEC_USER_AGENT` at home to a product name and a way to reach you. Nothing in this repository holds one, and the collector
   refuses without it.
2. Run one day with `--dry` first and read the run line: `filings.listed` / `read` / `purchases`, and `unresolved`.
3. An ordinary weekday lists a few hundred original Form 4s, which is about half a minute of requests at ten a second. The per-day
   budget is 15 minutes.
4. Exit **3** means a partial read; the day is named in the run line and **running the same day again is cheap** (the merge is keyed
   by accession, so only the still-missing filings cost anything).
5. Extend `MARKET_HOLIDAYS` in `backend/lib/run-window.js` each December, or the cluster finder will refuse the new year rather than
   measure its windows wrong.

---

## HANDOVER

Stopped on the operator's instruction at the end of build cycle 1, **before** the independent checker subagent had run. The package
is complete and green on its own selftest; what is missing is the second, independent pair of eyes the build-check-loop asks for.

### Done, and verified here

1. **All six staged files written** — `staged/backend/lib/sec-fetch.js`, `form4-parse.js`, `insider-buys-lib.js`,
   `insider-cluster-lib.js`, `staged/backend/insider-buys-collect.js`, `staged/backend/insider-clusters.js`. Every one passes
   `node --check`. All new files; no existing file is touched.
2. **Fixtures saved and reproducible** — 21 files in `fixtures/` (17 Form 4 submissions in the SGML shape the SEC serves, 4 daily
   master indexes), plus `fixtures/build-fixtures.cjs` which built them. Selftest check A4 holds every saved file to that builder
   byte for byte.
3. **Package machinery** — `deploy.cjs --plan|--apply`, `rollback.cjs --plan|--apply`, `record.cjs [--dry]`, `selftest.cjs`,
   `base/WHY-EMPTY.txt`, this `NOTES.md`, and the harnesses (`tree.cjs`, `fixture-fetch.cjs`, `no-net.cjs`, `refresh-shas.cjs`).
4. **`node docs/insider-clusters/2026-10-16/selftest.cjs` → `ALL 145 CHECKS PASSED`** (exit 0). It writes nothing in the repository,
   makes no network call (`no-net.cjs` refuses every fetch and socket; the collector's fetcher reads saved fixtures), reads no key and
   places no order. Sections: A package and repository rules (18), B the limiter and the SEC's two rules (10), C the fetch layer over
   fixtures (10), D the parser filing by filing (14), E the record and its merge (11), F the collector end to end (15), G the cluster
   finder (16), H **31 mutants, all caught**, I deploy and rollback on scratch repos (9), J `record.cjs` (8).
5. **`node docs/insider-clusters/2026-10-16/harness/refresh-shas.cjs` → `6 staged files, 0 stale`** — `deploy.cjs` names the bytes
   that are on disk.
6. **`node docs/insider-clusters/2026-10-16/fixtures/build-fixtures.cjs` → `21 of 21 saved file(s) match this builder`**.
7. **`node docs/insider-clusters/2026-10-16/record.cjs --dry` → exit 0**, prints both records, writes nothing.
8. **No test was weakened, skipped or deleted**, and none existed to change — see *Tests changed, weakened or removed* above for the
   three expectations that were corrected **upward** while building, each now pinned harder than the first version.

### Left to do, in order

1. **Run the independent checker** (a separate subagent, read-only) over this package: `selftest.cjs`, `refresh-shas.cjs`,
   `fixtures/build-fixtures.cjs`, `record.cjs --dry`, `deploy.cjs --plan`, `rollback.cjs --plan`, and `node --check` on every staged
   file — and have it try its own mutants, not only the 31 in section H. This is the one step of the build-check-loop that did not
   happen, so **no check here has been confirmed by anything other than the builder**.
2. **`deploy.cjs --plan` and `rollback.cjs --plan` have not been run in this session.** Their write paths are exercised on scratch
   repos by selftest section I, but the two `--plan` prints themselves are unrun; read them before trusting the output.
3. **Operator review and `--apply` at home** — never from a cloud session. Then `record.cjs --dry`, then `record.cjs`.
4. **Set `SEC_USER_AGENT` at home** before the first real run, and do one day with `--dry` first. Nothing in this repository holds a
   contact string and the collector refuses without one.
5. **Register a test before reading this data for a claim.** This package registers nothing and grades nothing by design; what the
   collector finds is not a claim until a test over it is registered at home, before any of the data is read.
6. **Not built, and known to be missing** (all listed under *What is NOT known, and what is owed*): reconciling 4/A amendments against
   their originals; separating an open-market purchase from a private one (the SEC's code P does not); derivative transactions; any
   split adjustment or price check against the tape; a backfill path over the SEC's quarterly bulk files (this reads the daily index
   only, so history before the first run has to come from somewhere else); and extending `MARKET_HOLIDAYS` past 2027, without which
   the cluster finder will refuse the new year rather than measure its windows wrong.
