# Register window guard: stopped, the file is not in this copy

## Task

`docs/server/wave3-sleeves/register.cjs` wrote change-registry rows at 15:49 MT. That is inside the house no-registry-write window, which runs from 13:50 to 15:50 MT on trading weekdays. The task was to add the same window refusal that the other record scripts use, through a shared helper if one exists.

## Why this task stopped

**`docs/server/wave3-sleeves/register.cjs` does not exist in this clean copy.** The folder holds only these files:

```
docs/server/wave3-sleeves/manifests.cjs
docs/server/wave3-sleeves/rollback.cjs
docs/server/wave3-sleeves/selftest.cjs
docs/server/wave3-sleeves/units.cjs
docs/server/wave3-sleeves/staged/backend/r316-ibs-forward.js
```

`git log --all -- docs/server/wave3-sleeves/register.cjs` returns nothing, so the file was never in this copy's history. The task said to stop in this case, so **no package was built**. Reconstructing the file would violate the house rule.

## What was found, for the edit at home

**There is no shared helper module.** Every record script has its own short copy of the same check:

- **`backend/register-fund-discounts.js:100-106`**, function `mtClock()`:
  - takes the America/Denver wall clock;
  - sets `tradingDay = Mon–Fri && !MARKET_HOLIDAYS[mtDate]`, with `MARKET_HOLIDAYS` from `backend/lib/run-window.js`;
  - sets `inWindow = tradingDay && hm >= 13*60+50 && hm < 15*60+50`;
  - at line 217, refuses a real write when `inWindow` is set: `inside the 13:50-15:50 MT no-write window on a trading day (re-run after 15:50 MT, or use --dry)`.
- **`backend/amend-r352-fee-and-spot-gap.js:25-28`** does the same inline, but treats only weekends as non-trading days. Holidays are not excluded.
- The two other `register.cjs` scripts in this copy, `docs/server/wave-r309fold/register.cjs` and `docs/server/wave2b-schwab/register.cjs`, have **no** window check. They may need the same fix. That is outside this task, and is listed here only so the operator knows.
- The cost-band package on branch `claude/cost-band-refusal` (`docs/cost-band-refusal/2026-10-16/record.cjs`, `mtClock` and `main`) uses the register-fund-discounts form. Its selftest proves the edges: 13:49 is allowed, 13:50 is refused, 15:49 is refused, 15:50 is allowed, and a market holiday is outside the window.

### The edit to make at home in `docs/server/wave3-sleeves/register.cjs`

Use the register-fund-discounts form. It is the only one in this copy that also excludes market holidays.

1. Before any lock is taken or any file is written, on the real-write path only (not on a dry run or a selftest):
   - compute the current MT clock;
   - refuse with exit 2 and the standard message if `tradingDay && 13:50 <= hh:mm < 15:50`.
2. Make the clock injectable so the selftest can pin the edges. The edges to test are 13:49, 13:50, 15:49, 15:50, a Saturday, and a date in `MARKET_HOLIDAYS`.
3. If the script writes after a long wait, such as a lock wait or the end of a long run, check the window again immediately before the write. A run that starts at 13:45 must not write at 13:52.

The 15:49 write in the incident was one minute before the window ends. The test at 15:49 is the one that would have caught it.

## Branch contents

This file only. No live file was changed, and no package was built.
