# server-backtest-runner — 2026-10-16

## What changed

Three NEW files. No live file is edited, so `base/` holds no copy:

- **`backend/bt/bt-core.cjs`** — the arithmetic.
  - **Reused verbatim from `backend/r313-ibs-etfs.js`** (the dip-buy family's sealed PASS, 2026-10-03). The selftest compares the source text of 20 functions byte for byte: the rule (`ibsOf`, `mkTrade`, `simulate`), RSI (`sma`, `rmaSeeded`, `rsiWilder`), the statistics (`mean`, `nwT`, `monthlySeries`, `summarise`), the R150 scramble, R313's corrected matched placebo (`placeboPrepC`, `placeboRunC`, `pairedDiffs`) and the drift-floor gate.
  - **New:** bar-file loading and checks, building the signal arrays from the rule JSON, a time-capped simulate, `decideRule` (R313's `decide` with the rule's own trade and month minimums), and `barFor` (R313's `barAtN`, generalised to best-of-V).
  - **The null bar** is `backend/lib/null-bar.js` where present, else the research server's port (`<root>/factory/lib/nullbar.cjs`). The result records which file was used and its sha256.
- **`backend/bt/bt-run.cjs`** — the runner, for the server. **No AI and no network:** the selftest scans for http/https/net/dns/tls/child_process, `fetch(` and model clients.
  - `node backend/bt/bt-run.cjs --rule <rule.json> --bars <dir> --out <result.json> [--exploratory]` runs a rule over the stored daily bars. There is one file per symbol, `<SYM>.json` (`[{t,o,h,l,c,v}]`) or `<SYM>.csv`.
  - `--verify <result.json>` recomputes the seal.
  - **The sealed result** (`bt-result-v1`) contains:
    - the rule, embedded, with its sha256;
    - the sha256 of every bar file and of the whole set, and of the runner's code and the null bar used;
    - every trade, plus the open ones (listed, not counted);
    - the mean and the Newey-West lag-1 t on the **registered clustering unit** (calendar month of entry; the rule must say `"unit": "month"`, nothing else is implemented), both halves, and the 2×-cost mean;
    - the corrected matched placebo (paired t), the drift-kept floor, the leak test (drift-free shuffles, t < 2), the positive control (own winners, t ≥ 3), the bar, the gates and the verdict;
    - `seal.sha256` over the canonical JSON.
  - The file is written once (an existing `--out` is refused) through `backend/lib/atomic-write.js`, then set to 0444.
  - **Governance:** a rule without `registration` runs only with `--exploratory`, and its file and verdict say EXPLORATORY. A registered rule must carry its registered `bar.tRequired` (used as given, never recomputed) and a `window.lastBar` at most 10 days after `window.to`, frozen at registration. The runner never reads or writes the registry.
- **`backend/bt/rules/dip-ibs-country-etfs.json`** — the **first use**, written by `make-rules.cjs` through `writeJsonAtomic`. It is R313's IBS rule, unchanged (entry IBS < 0.1, exit IBS > 0.9, one position per ETF, no stop), on **24 single-country ETFs** that are in none of the family's registered universes: EWZ EWW EWY EWT EWH EWS EWL EWP EWQ EWI EWN EWD EWK EWO EWM EZA ECH TUR THD EIDO EPHE INDA FXI ENZL.
  - Costs are 0.12% round trip (country ETFs are wider than R313's), with stress at 0.24%.
  - Placebo 500 draws (seed 313), floor 60 seeds, leak seeds 1 and 2, gates ≥ 100 trades and ≥ 36 months.
  - **It is a DRAFT:** it has no registration, so it can only run as exploratory until it is registered at home.

## Checks (cloud, 2026-10-16)

`node docs/server-backtest-runner/2026-10-16/selftest.cjs` → `ALL 86 CASES PASSED`, using synthetic bars only. It covers:

- **Verbatim reuse:** 20 functions identical to r313's text.
- **Hand-computed known answer:** two trades at chosen closes, net = gross − 0.06% exactly, the month mean, an open trade not counted, NW t on [1%, 2%, −0.5%, 1.5%] = 3.5777, and the time cap.
- **Planted edge:** +0.8% bounce after IBS < 0.1, 10 symbols × 8 years → **PASS** (t ≈ 16, placebo paired t ≈ 9, floor clears, leak and positive control pass).
- **No edge:** three random-walk universes → **DID NOT PASS** (t ≈ −0.8 to −1.0). A tiny edge on 3 symbols → not PASS. Too few trades → CANNOT MEASURE.
- **Costs:** +0.10% lowers every net by exactly 0.001.
- **Determinism.**
- **Bar-file refusals:** missing, high < low, price ≤ 0 or NaN, duplicate or out-of-order dates, bad date. Weekend rows are dropped and counted. CSV reads the same as JSON.
- **Rule refusals,** and the exploratory and registered-bar rules.
- **CLI end to end** in a temp tree laid out like the server (`<root>/backend/bt`, `<root>/factory/lib/nullbar.cjs`): sealed, 0444, verify INTACT, a second write refused, tampering detected, an unregistered rule refused.
- **The shipped rule file** equals `make-rules.cjs`'s output and passes `checkRule`.
- **deploy / rollback / record.**

## The null bar value (resolved by the checker)

- `barFor(320, 1 variant, seed 313)` reproduces R313's **NW part exactly (1.66)**.
- The null-bar part on the port gives 1.666. R313's registry says 1.658, but that was an **unseeded** `nullBar` call at registration (`register-r310.js` calls it with no rng, so Math.random). Over 40 seeds the port's p95 at n = 320 spans 1.608–1.674, and one of them (seed 23) gives exactly 1.658. "Unseeded" is a strong inference rather than a proven fact: the registry's source names a seed for the NW part and none for the null bar, and `register-r310.js` (R310's registration, the family's precedent) calls nullBar unseeded. No R313 registration script is in this copy. So 1.658 is not a seeded known answer, and the selftest no longer asserts it.
- What the selftest asserts instead: bar = max(NW part, null-bar part). At home, where both exist, it also asserts that **the house `backend/lib/null-bar.js` and the server's port give the same value for the same seeded call**. The port's header claims its own selftest proves this, but `docs/server/wave6-agents/selftest.cjs` has no such check.
- Registered tests are unaffected: their bar is the one in the rule. Only a computed (exploratory) bar uses `barFor`.

## Changes after checker cycle 1

Cycle 1 result: 43/43 passed, but 15 of 33 mutations survived, including every timing gate and the t gate. It also found a selftest case that would FAIL at home (the 1.658 assertion). The fixes:

- **Leak test:** an unmeasured t (null) now **fails**, as in R313 (it used to pass).
- **R313's whole-rule calibration is added.** Each drift-kept scramble gets its own placebo and is judged by the full rule against the floor of the other seeds. If the false-pass rate is over `controls.maxWholeRuleFalsePass` (default 0.05), the verdict is **HELD**, with the rule's own verdict kept beside it. A floor with fewer usable seeds than `controls.floorSeeds` gives **CANNOT MEASURE**.
- **Forming-bar guard and coverage:** `window.lastBar` drops later bars (counted). A symbol whose file ends more than 7 days before `window.to` is refused.
- **Bar rows:** an open or close outside [low, high] is refused, and so is an impossible date (2010-02-30).
- **`reservedForRegistration: true`** on the shipped draft: no exploratory run may read its bars before it is registered. A rule's `registration` is still self-declared; the runner cannot see the registry on the server. The label names the id the rule claims, and the operator confirms it at home.
- **Write-once without a race:** the result is written in full beside its name, then linked to the name. `link()` fails if the name already exists.
- **Smaller fixes:**
  - The seal is described as detecting accidental or naive edits only; it is not a signature.
  - `canon` drops undefined keys, as JSON does.
  - Null percentages stay null.
  - `bar.seed` / `bar.n` use `??` instead of `||`.
  - The CLI refuses a missing value, a duplicate flag, or a value that is itself a flag.
- **New cases** (with the matching mutations now caught):
  - a drift-kept no-edge universe (t ≈ 10 yet DID NOT PASS, on the placebo and floor gates);
  - all 11 gates of `decideRule` flipped one at a time;
  - a registered bar of 99 used as given;
  - open trades not counted;
  - the exact 2×-cost shift;
  - `window.from`;
  - the placebo carrying the same cost;
  - the month unit (two trades, one month);
  - tampering with the trades, the rule and the bar;
  - the race;
  - the calibration HELD path;
  - a leak test with a null t;
  - the new bar refusals, the forming-bar guard, coverage, and the reserved rule.
- **No case was weakened or removed.** The one changed case is the home null-bar assertion, which is replaced by the house-equals-port check (reason above).
- **Note:** the verbatim `simulate` comment "an exit day … can never also be an entry" is untrue for `rsi-dip` with `closeAboveSma`. It is kept byte for byte because it is R313's text. The behaviour is the conservative one: no same-day re-entry.

## Changes after checker cycle 2

Cycle 2 result: no regressions and no blocking defect. All 11 gates were pinned, but 16 of 56 mutants survived. Several fixes worked but no case pinned them. The fixes:

- **Calibration completeness:** every drift-kept seed must give a mean **and** a measurable placebo t (R313's `ok`). Otherwise the result is CANNOT MEASURE, never "calibrated with 0 passes". A one-symbol universe shows this.
- **The limit:** `controls.maxWholeRuleFalsePass` is capped at R313's 0.05. A rule may be stricter, never looser.
- **Registered rules need `window.lastBar`,** so a read never depends on when the bars were fetched.
- **Per-seed record:** the calibration's per-seed verdicts and placebo t's are in the sealed file.
- **Thresholds:** R313's control thresholds are named constants (leak t < 2, positive control t ≥ 3), used through `leakPasses` / `positivePasses`. Cycle 3 pinned them at t = 2.5.
- **Progress:** the CLI prints progress to stderr. A real-size run (24 symbols × 27 years, 60 seeds × 500 draws) takes about 2.5 minutes.
- **New cases:**
  - incomplete calibration;
  - null placebo percentiles;
  - the default and capped limit;
  - per-seed placebo t's;
  - the thresholds;
  - the runner applying `lastBar` and coverage;
  - a registered rule without `lastBar`;
  - an open outside [low, high];
  - the 7-day coverage edge;
  - the first-full-year start.
- **Coverage remains 7 days**, which holds a holiday week. The checker found no false refusal near holidays. A symbol ending a few days early only leaves its last trades open (listed, not counted).
- **The CLI case** now copies the null-bar port (self-contained), so it does not depend on the house file's own requires at home.
- **Test edits, with reasons:**
  - The fixture rule's `floorSeeds` went from 10 to 20, and two expectations follow it (floor seeds 20; "at most 1 pass", i.e. ≤ 5%). Reason: with 10 seeds, one chance pass is 10%, over R313's 5% limit, so the planted edge was correctly HELD; R313 itself registers 60 seeds. The no-edge, drift-kept and HELD cases are unchanged in what they demand.
  - Every fixture window now carries `lastBar`, because registered rules must (above).
  - No case was removed (62 → 72).

## Changes after checker cycle 3

Cycle 3 result: no regressions, no case removed, and the 10 → 20 floor-seed change was judged fair. Its main finding:

- **D1 (medium) — R313's calibration has a structural ceiling.**
  - Every pass needs "mean above the leave-one-out floor's p95". With a nearest-rank p95, at most N − ceil(0.95 (N − 1)) of N seeds can meet that: 1 of 20, 2 of 40, **3 of 60, which is exactly 5%**.
  - So at 20, 40 or 60 seeds the "≤ 5%" calibration **can never hold a read**. **R313's registered design (60 seeds) has the same property.** It cannot be changed here without a registry amendment.
  - The runner now **reports** it: `calibration.ceiling` gives the maximum possible passes, the rate, and whether the calibration can hold at this seed count.
  - The selftest no longer asserts the tautology "at most 1 of 20". Instead it asserts things that can fail:
    - every per-seed PASS clears the t gate and its **own** placebo t, on both the planted edge and the drift-kept universe;
    - a 21-seed run (ceiling 2 of 21, 9.5%) is **HELD** at the default 5% when the bar is −100;
    - the ceiling's known answers.
  - R313's drift-**free** arm is now reported too. As in R313, it decides nothing.
  - **For the operator:** if the calibration is meant to be able to hold a read, the registry must say so: for example, choose a seed count where the ceiling exceeds 5% (21, 41, 61), or set a stricter limit.
- **D2 — `rsi-dip` untested.** `rsi-dip` signals now have known-answer cases (RSI below, close < SMA, the trend filter, close > SMA exit).
- **D3 — unpinned paths.** New cases cover: the time cap honouring the window; the thresholds at 2.5; the positive control being winners only; the data-set sha recomputed; `canon` and undefined keys; open above high, close below low, a price of 0; and the rule bounds (`floorSeeds` 4, `lastBar` before `to` or 9999-12-31, `roundTrip` 0.05, `minMonths` 2).
- **D4 — data gaps.** The largest calendar gap per symbol is reported in the sealed file and refused above `window.maxGapDays` (default 14).
- **D5 — `lastBar` too loose.** `window.lastBar` is limited to 10 days after `window.to`.

Test edits, with reasons:

- **The planted-edge calibration case:** "≤ 1 pass of 20" was replaced by the per-seed gate check plus the ceiling report. Reason: the old assertion could not fail (D1). Mutant Z04, which forces the calibration's placebo and floor-t gates to pass, is now caught.

No case was removed (72 → 86).

## Missing from this clean copy (not reconstructed)

- **`backend/lib/null-bar.js`.** The port in `docs/server/wave6-agents/server/factory/lib/nullbar.cjs` was used (see the finding above).
- **`backend/package.json`.** The root package.json is `"type": "module"`, so `backend/lib/atomic-write.js` cannot be required here. The CLI case runs in a temp tree that adds a commonjs package.json; `aw.cjs` does the same for `make-rules.cjs`.
- **R328's (RSI-2) and R150's registry entries** are redacted. `rsi-dip` is implemented generically (RSI(n) Wilder below x, optional close < SMA and trend SMA, exits by RSI above y, close > SMA(n) or a time cap), but no rule file reproduces R328.
- **Bars.** No country-ETF bars exist on the server or here. Fetching them is a home task: the same source and form as R313's cache (Schwab daily, split-adjusted), written one file per symbol.
- **package-lock.json.** `npm ci` refuses without it. The runner uses only Node built-ins.

## Operator steps at home

1. `node docs/server-backtest-runner/2026-10-16/selftest.cjs`. It must end `ALL … PASSED`. At home the house-equals-port null-bar case is counted (see above).
2. `node docs/server-backtest-runner/2026-10-16/deploy.cjs --plan`, then `--apply`. Then `record.cjs --dry` and record the change.
3. On the server tree, `backend/package.json` must make `backend/lib/*.js` CommonJS (as at home); otherwise the final write fails. Copy `backend/bt/` to the server tree (`/home/traids/traids/backend/bt/`) by the usual deploy path. Check that the server has `backend/lib/atomic-write.js`, and either `backend/lib/null-bar.js` or `factory/lib/nullbar.cjs`.
4. To make the first use a test:
   - Register it at home in `backend/data/test-registry.json`, freezing the rule, universe, costs, unit, bar, gates and read condition **before any bar is read**.
   - Add `registration: { id, registeredOn }` and the registered `bar.tRequired` to the rule file (with `make-rules.cjs`), and redeploy.
   - Until then it runs only with `--exploratory`, and nothing it prints is a read.
5. Put the country-ETF daily bars in one folder on the server (one file per symbol). Then: `node backend/bt/bt-run.cjs --rule backend/bt/rules/dip-ibs-country-etfs.json --bars <dir> --out <new file>`. Check the result with `--verify`.

Rollback: `node docs/server-backtest-runner/2026-10-16/rollback.cjs` removes the three files, but only if they still match the staged bytes.
