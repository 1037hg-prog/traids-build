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
  - **Governance:** a rule without `registration` runs only with `--exploratory`, and its file and verdict say EXPLORATORY. A registered rule must carry its registered `bar.tRequired`, which is used as given and never recomputed. The runner never reads or writes the registry.
- **`backend/bt/rules/dip-ibs-country-etfs.json`** — the **first use**, written by `make-rules.cjs` through `writeJsonAtomic`. It is R313's IBS rule, unchanged (entry IBS < 0.1, exit IBS > 0.9, one position per ETF, no stop), on **24 single-country ETFs** that are in none of the family's registered universes: EWZ EWW EWY EWT EWH EWS EWL EWP EWQ EWI EWN EWD EWK EWO EWM EZA ECH TUR THD EIDO EPHE INDA FXI ENZL.
  - Costs are 0.12% round trip (country ETFs are wider than R313's), with stress at 0.24%.
  - Placebo 500 draws (seed 313), floor 60 seeds, leak seeds 1 and 2, gates ≥ 100 trades and ≥ 36 months.
  - **It is a DRAFT:** it has no registration, so it can only run as exploratory until it is registered at home.

## Checks (cloud, 2026-10-16)

`node docs/server-backtest-runner/2026-10-16/selftest.cjs` → `ALL 43 CASES PASSED`, using synthetic bars only. It covers:

- **Verbatim reuse:** 20 functions identical to r313's text.
- **Hand-computed known answer:** two trades at chosen closes, net = gross − 0.06% exactly, the month mean, an open trade not counted, NW t on [1%, 2%, −0.5%, 1.5%] = 3.5777, and the time cap.
- **Planted edge:** +0.8% bounce after IBS < 0.1, 10 symbols × 8 years → **PASS** (t ≈ 16, placebo paired t ≈ 8.5, floor clears, leak and positive control pass).
- **No edge:** three random-walk universes → **DID NOT PASS** (t ≈ −0.8 to −1.0). A tiny edge on 3 symbols → not PASS. Too few trades → CANNOT MEASURE.
- **Costs:** +0.10% lowers every net by exactly 0.001.
- **Determinism.**
- **Bar-file refusals:** missing, high < low, price ≤ 0 or NaN, duplicate or out-of-order dates, bad date. Weekend rows are dropped and counted. CSV reads the same as JSON.
- **Rule refusals,** and the exploratory and registered-bar rules.
- **CLI end to end** in a temp tree laid out like the server (`<root>/backend/bt`, `<root>/factory/lib/nullbar.cjs`): sealed, 0444, verify INTACT, a second write refused, tampering detected, an unregistered rule refused.
- **The shipped rule file** equals `make-rules.cjs`'s output and passes `checkRule`.
- **deploy / rollback / record.**

## Finding to check at home: the null bar value

- `barFor(320, 1 variant, seed 313)` reproduces R313's **NW part exactly (1.66)**.
- The null-bar part, run on the **port** (the only null bar in this copy), gives **1.666**. R313's registry entry says **1.658**, from `backend/lib/null-bar.js`.
- Either the port is not arithmetically identical to the house file for this call (its header claims it is), or R313's 1.658 came from a different call.
- At home the selftest loads the house file. There this becomes a counted case that demands 1.658.
- Registered tests are unaffected: their bar is taken from the rule as registered. Only a computed (exploratory) bar uses `barFor`.

## Missing from this clean copy (not reconstructed)

- **`backend/lib/null-bar.js`.** The port in `docs/server/wave6-agents/server/factory/lib/nullbar.cjs` was used (see the finding above).
- **`backend/package.json`.** The root package.json is `"type": "module"`, so `backend/lib/atomic-write.js` cannot be required here. The CLI case runs in a temp tree that adds a commonjs package.json; `aw.cjs` does the same for `make-rules.cjs`.
- **R328's (RSI-2) and R150's registry entries** are redacted. `rsi-dip` is implemented generically (RSI(n) Wilder below x, optional close < SMA and trend SMA, exits by RSI above y, close > SMA(n) or a time cap), but no rule file reproduces R328.
- **Bars.** No country-ETF bars exist on the server or here. Fetching them is a home task: the same source and form as R313's cache (Schwab daily, split-adjusted), written one file per symbol.
- **package-lock.json.** `npm ci` refuses without it. The runner uses only Node built-ins.

## Operator steps at home

1. `node docs/server-backtest-runner/2026-10-16/selftest.cjs`. It must end `ALL … PASSED`, with the null-bar case counted at 1.658 (see the finding).
2. `node docs/server-backtest-runner/2026-10-16/deploy.cjs --plan`, then `--apply`. Then `record.cjs --dry` and record the change.
3. Copy `backend/bt/` to the server tree (`/home/traids/traids/backend/bt/`) by the usual deploy path. Check that the server has `backend/lib/atomic-write.js`, and either `backend/lib/null-bar.js` or `factory/lib/nullbar.cjs`.
4. To make the first use a test:
   - Register it at home in `backend/data/test-registry.json`, freezing the rule, universe, costs, unit, bar, gates and read condition **before any bar is read**.
   - Add `registration: { id, registeredOn }` and the registered `bar.tRequired` to the rule file (with `make-rules.cjs`), and redeploy.
   - Until then it runs only with `--exploratory`, and nothing it prints is a read.
5. Put the country-ETF daily bars in one folder on the server (one file per symbol). Then: `node backend/bt/bt-run.cjs --rule backend/bt/rules/dip-ibs-country-etfs.json --bars <dir> --out <new file>`. Check the result with `--verify`.

Rollback: `node docs/server-backtest-runner/2026-10-16/rollback.cjs` removes the three files, but only if they still match the staged bytes.
