# proven-book-composer — 2026-10-16

## What changed

One NEW home file: `backend/proven-book/book-composer.cjs`. No live file is edited, so `base/` holds no copy. `deploy.cjs` refuses if a different file with that name already exists at home.

It is the **composer only**. It never decides a sleeve's rule, never registers anything, and never sends an order: it reads tonight's input and writes a plan. The selftest scans it for broker, network and order code.

## What the composer does (the task's spec, made exact)

- **Sleeves.** R180 is month-end Treasuries (IEF). R313 is IBS on 20 ETFs and R328 is RSI-2 on 20 ETFs. Each sleeve's own runner decides its exits and entries. R180's wanted state can be given directly (`want`) or computed by `r180Want()` from the month's sessions. That follows R180's registered rule N3: hold IEF after the closes of sessions −6..−2, flat after the last session's close. It is known-answer tested on October 2026.
- **One capital, no margin.**
  - After the plan, gross ≤ `exposureCap` × equity. `exposureCap` above 1 is refused, and so is negative cash.
  - Buys are paid from cash on hand. Tonight's sale proceeds count only with `countExitProceeds: true`. The default is false: a cash account does not spend unsettled money.
  - The cap follows **equity**, so after a loss it shrinks.
- **Dip-buys at full size.** Every R313/R328 entry is its sleeve's `slotUsd` in whole shares, or it is **skipped, never shrunk**.
  - Order: `entryPriority`, then each sleeve's rank, then symbol.
  - Held dip positions are never cut by the composer; only their own exits sell them.
  - One position per name per sleeve.
- **R180 takes what is left**, up to `targetUsd`, and is never grown past it.
  - When a dip entry needs room, R180 **yields**: it is trimmed by whole shares (`r180YieldsToDips`, default true).
  - A yield is made only if the entry then fits at full size.
- **Idle cash is offered to the second layer** (the Stacker): offer = min(cap room, cash) − `reserveUsd`, never below 0.
  - The Stacker's positions come back as sleeve `stacker` the next night. They count against the cap, and they yield **first** when a dip needs room (`stackerYields`, default true). The second layer never crowds out the first.
- **Over the cap before any buy** (held positions grew, or equity fell): the Stacker, then R180, are cut back toward the cap. Held dips are never cut, and nothing is bought while they alone are over the cap.

## Checks (cloud, 2026-10-16)

`node docs/proven-book-composer/2026-10-16/selftest.cjs` → `ALL 45 CASES PASSED`. The sizes in it are FIXTURE values, plainly not R353's. It covers:

- R180's window (known answer, October 2026) and R180 via monthSessions.
- Known plans: empty book, full-slot entries in priority order, whole shares, exits, ignored exits, unsettled proceeds.
- Skips: no price, one share dearer than the slot, a duplicate name.
- Cap pressure in both cash modes, with R180 yielding and the Stacker yielding first.
- The `r180YieldsToDips` switch, exposureCap 0.5, the cap after a loss, trimming to target, the reserve, over-cap trimming, and held dips alone over the cap.
- Refusals.
- **3,000 seeded random nights**, checking: gross ≤ cap (or, with held dips alone over it, no buy), cash ≥ 0, dip buys at full slot, dip sells only their own exits, R180 within bounds and flat when not wanted, yields only on nights with a dip entry, the offer equal to idle room minus the reserve, and the same plan every time for the same input.
- The CLI (written through `atomic-write.js`), and deploy / rollback / record.

## Changes after checker cycle 1

Cycle 1 result: 37/37 passed and 27 of 31 mutations were caught. No-margin, the cap and the dip protections held in about 390,000 checked plans. Its findings, all fixed:

- **D1 (medium) — exact fits.** Money was compared in raw floating point, so an exact fit could read as one ulp short. A dip was then skipped, and R180 was sold and bought back in the same plan; the checker found this in about 3% of cent-exact boundary cases. All money comparisons now use a 1/100-cent tolerance. Two known-answer cases (the checker's own) fail on the old code and pass now.
- **D2 — a missing intent block.** A missing R313 or R328 block is now refused; it used to be read as "no exits, no entries".
- **D3 — wrong R180 instrument.** A held R180 position on another instrument is refused.
- **D4 — `r180Want` input.** A date given twice, or a month list that is only "the sessions so far", is refused. The list must be the whole month from the calendar.
- **D5 — bad entries.** A bare-string entry or a non-numeric rank is refused.
- **D6 — untested ordering.** Entry priority, rank-before-alphabet and `stackerYields: false` now each have a known-answer case.
- **D7 — temp folders.** The temp folder `aw.cjs` makes is removed.
- **D8 (open question) — when the plan fills.** The plan assumes every order fills at `asOf`'s close (all the rules are close-to-close). **Confirm at home** that the proven book executes it at that close. If it runs a session later, every sleeve shifts by one session, R180's window included.

No case was removed or weakened (37 → 45). The equivalent mutant M24 (`r180YieldsToDips` ignored while the Stacker covers the need) stays uncatchable by design.

## Missing from this clean copy (not reconstructed)

- **`backend/proven-book/`** (the whole folder). The proven book's own files, its input formats, and how it is run nightly are unknown here. The composer therefore takes an explicit input (`proven-book-nightly-v1`) and config (`proven-book-composer-v1`). **At home:** map the proven book's nightly outputs (each sleeve's exits and entries, the positions, cash and closes) onto that input, or adapt the reader.
- **R353's registry entry** (redacted: `screenRedacted`), so the composition's registered sizes are unknown. **At home, fill the config from R353:** `capitalUsd` (100,000), `exposureCap`, `sleeves.R313.slotUsd`, `sleeves.R328.slotUsd`, `sleeves.R180.targetUsd`, `entryPriority`, `reserveUsd`, `countExitProceeds`. No config file is shipped, so no size is invented here.
- **R328's registry entry** (redacted: `ipRedacted`) and its runner `backend/r328-qs-rsi2-etfs.js`. Its universe and rule were not read. The composer takes R328's intents as given.
- **`backend/short-leg/short-leg.js`**, whose engine has `longR313` / `longR328` and a book with STAKE. It was not available to cross-check sizing.
- **`backend/package.json`.** The CLI case writes through a temp commonjs copy of `atomic-write.js` (`aw.cjs`).

## Operator steps at home

1. `node docs/proven-book-composer/2026-10-16/selftest.cjs`. It must end `ALL … PASSED`.
2. `node docs/proven-book-composer/2026-10-16/deploy.cjs --plan`, then `--apply`. Then `record.cjs --dry`, and record the change.
3. Write the config from R353 (step above) with a node script through `writeJsonAtomic`.
4. Feed it one real night as a dry run, and check the plan by hand: `node backend/proven-book/book-composer.cjs --input <nightly.json> --config <config.json>`.
5. The Stacker's own rule (what it buys with the offer) is registered at home before it uses any of it. The composer only states the offer.

Rollback: `node docs/proven-book-composer/2026-10-16/rollback.cjs` removes the file, but only if it still has the staged bytes.
