# Wings double count — one row per ticket (2026-10-16)

Branch `claude/wings-double-count`. Built in a cloud build session; **nothing here was applied, deployed,
restarted or scheduled.** The operator re-checks it and runs `deploy.cjs --apply` at home.

---

## 1. The defect

`data/trade_log.json` is a list of **rows**, and every reader has always treated a row as a ticket. That
held until a ticket could be closed twice under one id. It can:

> Six R21 weekly wings were closed by the first live fire of the loss cap on **2026-09-14**. That close
> was **voided** (a retire tag, a `retireNote` and `voidForEvidence: true`) and the wings were put back on
> the board **under the same id** (`obs.restoredAfter`). They then expired and settled —
> `backend/options-settle.js:201`, `writeJsonAtomic(TLOG, [...settled, ...tlog])`, a **prepend** that
> never removes the voided close.

So each of those six wings has **two rows carrying one ticket id**, with different `closedAt` and
different `pnl`. Every reader that summed rows counted each wing twice.

The append-only journal did **not**. `data/trade_log.jsonl` is keyed on the ticket id —
`have.set(r.id, r)` in `backend/ledger-journal.js:20`, `have.add(JSON.parse(line).id)` in
`backend/lib/reconcile.js` `journalLag()` — so it holds **one entry per ticket**. `journalLag()` then
compared `have.size` (tickets) against `settled.length` (rows) and the two disagreed by exactly the
number of revoided wings, for ever, while still reporting "journal current". **That disagreement is the
symptom that identifies the defect**: the ledger counted wings as tickets *and* again through the
journal's ticket key, and the two numbers were never the same quantity.

On this package's fixture, which is built to match those rows:

| | per **row** | per **ticket** |
|---|---|---|
| the six wings | **−$3,000** | **−$600** |
| the whole signal book | **−$3,280** | **−$380** |

### Why `retired` did not already handle it

`cleanEraLedger()` excludes a validly-retired row — but only when the row carries a `retireNote` **and**
the tag appears in the append-only `change-registry.json`; a bare flag "excludes nothing and is reported
as ignored" (`reconcile.js`, the guard comment). So the defect's reach depended on a registry entry:

* **tag in the registry** → the canonical read dropped the voided wing rows for the *right reason by
  accident*, and the three reports that read `trade_log.json` **directly** — and have no retire filter at
  all — still counted every wing twice.
* **tag not in the registry** → the canonical read counted every wing twice as well.

The fixture is run **both ways** and the fix gives the same answer under either. A counting rule that
depends on whether someone remembered a registry row is not a counting rule.

---

## 2. What changed — five files, all read-only analysis code

Nothing here sends an order, calls a broker, writes a ledger row, or changes any registered test's rule,
bar, population definition, statistic, universe or read condition.

### `backend/lib/ticket-rows.js` — NEW

The one definition of **which row IS a ticket**, keyed on the ticket id.

* a row with no `id` is not a ticket and passes through untouched;
* a ticket with one row keeps that row, **byte for byte** — on a ledger where no ticket id appears twice
  the function is an **exact no-op**, same array, same object references (asserted, check A1). That is the
  property that makes it safe to put under the canonical read;
* a ticket with several rows keeps exactly one: the row none of its siblings supersedes, where `a`
  supersedes `b` when **(1)** `a` names the row it replaced (`voidedPredecessor` + `restoredAfter` — the
  2026-10-01 settle audit's successor stamp) or **(2)** `b` was voided for evidence and `a` closed later.
  Of what survives, the latest `closedAt`;
* a duplicate **neither rule explains** is reported in `ambiguous` whether or not the latest close happens
  to break it. A tiebreak is not an explanation, so it is said out loud and the ticket still counts once.

It edits, merges and re-sums nothing, and it does not decide whether the surviving row *belongs* in a
population — `retired`, `ctrl`, the clean epoch and the finite-`pnl` rule stay `reconcile.js`'s and are
unchanged.

### `backend/lib/reconcile.js`

`cleanEraLedger()` collapses to one row per ticket **before any filter runs**, and returns what that
collapsed: `tickets`, `duplicateTicketIds`, `supersededRowsDropped`, `unexplainedDuplicateTicketIds`,
`duplicateTickets`, `ticketsLine`. `rowsInFile` keeps its old meaning (rows in the file). The CLI prints
the tickets line. `validRetireTags` is now computed over the collapsed rows, so a superseded row can no
longer make a tag valid.

`journalLag()` counts **tickets on both sides** — the journal is keyed on the ticket id, so the canonical
side must be too, or the two can never agree — and adds `settledRowsInCanon` beside it,
`duplicateTicketIds`, and `journaledUnderSupersededClose`: tickets the journal sealed under a close that
has since been superseded (it seals the row it saw first and a sealed row never moves).

`knownAmbiguities()` gains a third entry, `void-tag-on-surviving-close` — see §4.

### `backend/daily-postmortem.js`

A daily report that reads `trade_log.json` directly and on purpose (it is the day's realized cash and must
see rows the clean-era filters drop). Direct is not the same as per-row: the **epoch cohort scan**, the
**equity curve** and the **sd that decides whether today is unusual** counted a revoided wing twice. It
now collapses first and says what it collapsed on its own second line.

The **target day's realized cash is unchanged** by the fix (it is one day's rows): on the fixture both the
old and the new code report 6 settles and −$600 for 2026-09-18. What moves is the epoch: 4 sessions and a
curve ending −$3,280 become 2 sessions and −$380, because a whole session of voided closes was being
counted as a trading day. Both numbers are asserted.

### `backend/options-news-shadow.js`

It deduplicated by ticket id already — but by **arrival order**: the first row seen for an id won, and the
ledger rows were listed before the board rows. That is right only while the newest close of a ticket
happens to be written first, which is true of `options-settle.js` and `r24-sleeve.js` (both prepend) and
**false** of any appending repair. On the append-order fixture the old code reports the six wings at
−$2,900 and −1.00R — the *voided* closes — against −$480 and −0.17R for the real ones. A **latent** defect,
not an active one, and now keyed on the ticket id so the answer does not depend on the write order.

### `backend/integrity-audit.js`

Sections 1–2 stay **per row** on purpose: an arithmetic audit must re-derive every row in the file,
including a superseded one, or it stops auditing exactly the rows most likely to be wrong. Its existing
`duplicate id+closedAt` impossibility catches a row written twice *unchanged*; it cannot catch one ticket
id at two different `closedAt`, which is the case that mattered.

New **section 2b (ROWS VS TICKETS)** names every duplicate ticket id, the close counted and the closes
superseded. It is **reported, not an impossibility**: those rows legitimately belong in the file — what
was wrong was every reader counting them — so the **verdict is untouched** and the nightly close chain
cannot go red for a defect that is already handled. Section 3 onward (the too-good tripwire, `cleanN`,
win rate, mean, and the options blast-radius count) counts **tickets**.

---

## 3. Every reader this reaches

`lib/reconcile.js` `cleanEraLedger()` is the house's single canonical read, so fixing it there fixes every
reader on it, with no further edit:

* `backend/profit-program/_opt-common.js` → and with it `options-lane-baseline.js`,
  `options-premium-pricing.js`, `options-crossing-gate.js`, `options-defects-audit.js`,
  `options-cost-family.js`, `options-mirror-costs.js`, `skeptic-options-*.js` — i.e. **every printer that
  sums option wing P&L**
* `backend/profit-program/pp-reconcile.js` → `pp-board-legs.js`, `pp-concentration.js`
* `backend/ml-daily.js` (its `cleanEraLedger()` read and its `journalLag()` line; its own ML feature rows
  exclude `cls === "Options"` and are unaffected)
* `backend/pooling-audit.js`, `backend/risk-model-fit.js`, `backend/cluster-pnl-ledger.js`,
  `backend/progress-top10.js`, `backend/r146-wings-vs-trend.js`, `backend/r67-convex-sizing-twin.js`,
  `backend/profit-program/skeptic-sleeves3.js`

Changed directly, because they read `trade_log.json` themselves: `daily-postmortem.js`,
`options-news-shadow.js`, `integrity-audit.js`.

Checked and left alone, with the reason: `options-settle.js` already groups rows by id and has its own
`voidedRestore` test (it is the writer, not a report); `r28-shadow-read.js` reads R28 veto shadows, which
these wings are not; `predictive-pipeline.js` is an ML feature pipeline, not a P&L report;
`reconstruct-lost-week.js` writes `reconstructed: true` rows and never touches `trade_log.json`;
`r24-sleeve.js` is a sleeve writer; `skeptic-sleeves3.js` already compares id **sets**.

### This BREAKS COMPARABILITY

Any figure quoted from these readers **before** this change, over a window containing a duplicate ticket
id, counted those tickets twice and is not comparable with a figure quoted after it. A ticket that had one
row is unchanged. `record.cjs` writes a `change-registry.json` row with `breaksComparability: true` saying
exactly this; `node backend/integrity-audit.js` section 2b lists every duplicate ticket id at home.

**No test-registry amendment is written, and none is invented.** This package changes no test's rule, bar,
population definition, statistic or read condition — it fixes how many times a ticket enters a population.
Whether any registered read whose window contains one of these tickets needs a dated amendment of its own
is the operator's call on the numbers at home.

---

## 4. What this does NOT fix, said plainly

**a. A void tag carried onto the surviving close — reported, not repaired.**
`options-settle.js:155` copies `retired` / `retireNote` / `voidForEvidence` from the **open board
position** onto the settle row it writes. If the board row of a voided-and-restored wing still carried the
void tag, the **expiry settle** — the real close, the one that moved money — inherited it, and the
retired-row rule then excludes it. The ticket goes from counting **twice** to counting **zero** times, and
both are wrong. Which it is depends on bytes in `data/`, not on code, so `reconcile.js`
`knownAmbiguities()` now reports it as `void-tag-on-surviving-close` with the ids, and guesses nothing.
The fixture is run with the tag inherited as well: under a registry that honours the tag the six wings
then contribute **$0** over **3** signals, and all six are named in the ambiguity (asserted). The repair,
if that list is non-empty at home, is a **data** repair with the operator's word on it — clearing the tag
on the surviving close only, with a change-registry entry — and is not a reader's to make. **Do not relax
the retired-row rule to reach them.**

**b. The journal itself.** `data/trade_log.jsonl` is append-only and immutable by design ("a sealed row
never moves"). For these six wings it sealed the **voided** close, and `ledger-journal.js` will never
append the expiry settle for an id it has already seen — so its nightly integrity line reports those
tickets as "journaled rows whose settled fields changed in the JSON" and **exits 1**. That is the journal
correctly refusing to lie about what it sealed. `ledger-journal.js` is **not touched** by this package:
changing an append-only artifact's semantics, or relaxing an integrity check so it stops firing, is not a
cloud session's call. `journalLag()` now **names** the affected tickets
(`journaledUnderSupersededClose`) so the condition is visible and the JSON is read for them instead.
**For the operator:** decide whether the journal gets a superseding-entry convention (an appended entry
that names the entry it replaces) or whether those seven tickets are listed as known exceptions.

**c. `backend/profit-program/pp-paper-legs.js` — THE FILE IS NOT IN THIS REPOSITORY.**
The task asked for its hard-coded `TODAY_SESSION = "2026-10-09"` to be derived from the session calendar.
It cannot be done here and **was not attempted**:

```
$ ls backend/profit-program/pp-paper-legs.js      → No such file or directory
$ grep -rn "TODAY_SESSION" .                      → no match anywhere in the tree
$ ls backend/profit-program/                      → pp-board-legs.js  pp-concentration.js  pp-reconcile.js
```

This is the over-exclusion `README.md` describes ("over-exclusion is the accepted direction of error, so
some ordinary files are missing too"). Writing the file from the name would be inventing live code, and
`AGENTS.md` is explicit that a task needing something this copy does not have is stopped and said here.

**What the fix is, for whoever has the file.** The repository's one definition of a session key is
`backend/lib/session.js`, and it already exports what this needs:

```js
const S = require("../lib/session.js");          // from backend/profit-program/
const TODAY_SESSION = S.todaySession();          // "YYYY-MM-DD" in America/New_York — the market's day
```

`todaySession()` is `sessionOf(Date.now())` in `America/New_York`, which is the key every registered test
and `daily-postmortem.js` use. Two things to get right, and neither can be settled without the file in
hand:

1. If `pp-paper-legs.js` needs the last **trading** session rather than today's calendar date (a weekend
   or holiday run), `lib/session.js` has no calendar helper and there is no shared trading-calendar module
   in this tree — the sibling printers take their sessions from the ledger's own closes
   (`pp-board-legs.js` builds `winSessions` from the rows). Derive it the same way, from the printer's own
   population, rather than adding a calendar dependency.
2. `lib/session.js`'s header is explicit that a **graded** statistic keys on the **open** session and a
   **realized-cash** view on the **close** session, and that the two must never be mixed unlabelled. Which
   one `TODAY_SESSION` is deciding has to be read off the file's own use of it.

Do not hard-code another date. A frozen `TODAY_SESSION` is why the totals froze.

---

## 5. The package

```
docs/wings-double-count/2026-10-16/
  base/      byte-exact copies of the four live files this change starts from (from main)
  staged/    the five changed files at their repo paths
  lib.cjs    the shared manifest (sha256 per file), plan, drift refusal and write unit
  deploy.cjs --plan | --apply
  rollback.cjs --plan | --apply
  selftest.cjs    232 known-answer checks on fixtures
  fixtures.cjs    the fixtures, and every expected number worked out by hand
  mutants.cjs     18 deliberate breaks of the fix; each must be caught
  record.cjs --dry | (write)
  NOTES.md
```

`backend/lib/ticket-rows.js` has **no base copy**: it does not exist at base. A rollback **deletes** it,
which is restoring it byte for byte.

### Run it

```
node docs/wings-double-count/2026-10-16/selftest.cjs        # ends "ALL 232 CHECKS PASSED"
node docs/wings-double-count/2026-10-16/mutants.cjs         # ends "ALL 18 MUTANTS KILLED"
node docs/wings-double-count/2026-10-16/deploy.cjs --plan   # read-only; sha256 now / base / staged per file
node docs/wings-double-count/2026-10-16/rollback.cjs --plan # read-only
node docs/wings-double-count/2026-10-16/record.cjs --dry    # the change-registry row and the ledger line
```

At home, in order: `deploy.cjs --plan`, `deploy.cjs --apply`, then read
`node backend/lib/reconcile.js` (the new tickets line) and `node backend/integrity-audit.js` (section 2b
names every duplicate ticket id at home), then `record.cjs --dry` and `record.cjs`.

`--apply` refuses on **drift** — a file at home whose sha256 is neither the bytes the package was built
against nor the bytes it stages — and gates on the selftest's last line. Each file is written with a temp
file and a rename, read back by sha256 and `node --check`'d; any failure puts every file the run touched
back as it was. No fence on the clock is needed: all five files are read-only analysis code. `record.cjs`
does have one — it refuses 13:50–15:50 MT on a trading day, when the close chain owns those files.

---

## 6. What the tests prove

`selftest.cjs`, **232 checks**, no network, no broker, no real data file — every row is synthesized by
`fixtures.cjs` into a scratch repo under the OS temp directory and torn down after.

* **A — the rule.** A clean ledger is an exact no-op (same array, same references). One ticket id is one
  row, in either write order. The successor stamp wins where the latest-close tiebreak would lose (ticket
  `s1`'s surviving close is the **earlier** one, so only rule (1) can get it right). An unexplained
  duplicate is reported, with equal closes and with different ones. An id-less row passes through.
* **B — the canonical read, base against staged, on the same fixture, under both change registries.**
  Base counts the six wings twice (−$3,000; signal book −$3,280) where the retire rule does not happen to
  cover them; staged counts them once (−$600; −$380) under **either** registry and in **either** write
  order. `journalLag()`: base reports 10 journal entries against 17 "settled in canon" while saying
  "journal current"; staged reports 10 entries against **10 settled tickets** (17 rows said beside it), no
  lag, and names the **7** tickets sealed under a superseded close. With the void tag inherited, the six
  wings contribute **$0** over 3 signals under the registered registry, and all six are named in the new
  ambiguity.
* **C — the reports, run as the operator runs them**, base against staged, their printed numbers compared
  with the hand answers: `daily-postmortem.js` (today's cash unchanged, the epoch curve −$3,280 → −$380,
  4 sessions → 2), `integrity-audit.js` (tripwire n 16 → 9, win rate 31.25% → 55.6%, mean −0.4969R →
  −0.1056R, options blast radius 14 → 7, verdict PASS either way, section 2b printed),
  `options-news-shadow.js` (append order: −$2,900 / −1.00R → −$480 / −0.17R; prepend order: the same
  −$480 both ways — base is right there only by the write order, staged in both).
* **D — the package itself**: every staged file parses, every base copy is present, `base/` holds no
  `ticket-rows.js`, and each changed file genuinely differs from its base.
* **E — the machinery, on a scratch repo**: at base the plan has no refusal and five files to write; a
  failing gate refuses and writes nothing; apply writes all five to their staged sha256 and is idempotent;
  rollback restores the four base files **byte for byte** and deletes the new one and is idempotent; a
  drifted file refuses **both** directions and writes nothing; a changed file missing at home is refused,
  not created; `--plan`, no-mode and `record.cjs --dry` write nothing and exit as documented.

`mutants.cjs`, **18 mutants, all killed.** A passing suite proves nothing about the suite, so each mutant
breaks the staged code on purpose and the selftest must notice; a survivor fails the run. The first run
had **three survivors**, each a real hole, and each is now closed:

| survivor | the hole | what was added |
|---|---|---|
| `pick-earliest-close` | the latest-close tiebreak was never exercised — rule (2) always decided first | check **A4b**: a duplicate no rule explains, with different closes, both orders |
| `drop-void-rule` | dropping rule (2) still gave the right row via the tiebreak, silently | `ambiguous` now means *the rule did not explain this*, so the existing "nothing unexplained" checks catch it |
| `drop-void-tag-ambiguity` | the fixture had no inherited-tag case, so `affects` was 0 either way | the `inheritedTag` fixture variant and the §4a checks |

`ambiguous` was changed from "the closes tie" to "more than one row survived the supersede rules" as part
of closing the second hole. That is a widening of what gets reported, not a narrowing.

### Test edits

**No existing test, bar, rule, population or read condition was changed, weakened, skipped or deleted,
and no test was removed.** Every check in this package is new. The one behavioural change that touches an
existing check's meaning is `integrity-audit.js` section 3 now counting tickets instead of rows — that is
the defect being fixed, its before and after are both asserted, and the audit's **verdict condition is
untouched**. Section 2b was added as a report rather than an impossibility precisely so that it cannot
turn the nightly chain red.

### Still to be looked at by a human

`collapseByTicket` chooses the latest `closedAt` among rows no rule explains, and says so in
`unexplainedDuplicateTicketIds`. If that list is non-empty at home, those ids are a **ledger** question,
not a reader's: read them before quoting anything over a window that contains them.
