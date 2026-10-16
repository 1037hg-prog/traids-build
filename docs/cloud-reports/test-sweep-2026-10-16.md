# Test sweep 2026-10-16

Cloud sweep of every self-test in traids-build, Node v22.22.0 (home runs Node 24).

## Summary

| Status | Count |
|---|---|
| PASS | 48 |
| FAIL | 0 |
| NEEDS-HOME-DATA | 57 |
| NODE-VERSION | 0 |
| TIMEOUT | 0 |
| **Total tests run** | 105 |

There are **no real FAILs** and no Node-version or timeout results. Every non-pass is a missing file or credential in this clean copy (backend/lib/*, backend/data/*, fixtures, redacted registry entries, broker keys).

## Findings the operator should know

1. **Root `package.json` has `"type": "module"`.** In this copy that makes every CommonJS `.js` self-test die immediately with `require is not defined in ES module scope` (71 of the tests below, shown as PASS only after the key was removed in a throwaway copy). The `.cjs` files are unaffected. Not a Node-version issue (same on 22 and 24). If the home repo has no such key, the clean copy's package.json differs from home; if it does, these fail at home too.
2. **No package-lock.json in this copy**, so `npm ci` fails (EUSAGE). I used `npm install --ignore-scripts --no-package-lock` instead. `dotenv` is required by several backend scripts but is not in package.json; I supplied it from the registry outside the repo (NODE_PATH) so those tests could be evaluated.
3. **Network:** every test ran under `unshare -n` (no network). Two `--selftest` runs still tried a fetch and got "fetch failed": backend/r157-aist-oos.js and backend/r280-oil-timing.js. A `--selftest` that fetches is against the no-network rule; flagged as NEEDS-HOME-DATA, not FAIL.
4. **Disclosure:** my first pass picked files by "mentions --selftest" and also ran deploy/rollback/register/verify-live-style scripts with `--selftest`. That pass ran in a throwaway copy of the repo under `unshare -n`; the real checkout was not touched (`git status` clean, diff against the original identical). Those scripts are **excluded** from the results below as non-tests (37 files). A few more non-test helpers (pull-*, fetch-day, compare, w6, swap, run-harness, limit) were also dropped.
5. Tests were run via a flag-detection heuristic; backend/test/build-fixtures.js is a fixture builder, not a test, and was not run. docs/**/selftest-child.cjs is a helper of chainfix/selftest.cjs.

## Results (one row per test)

| # | Command | Exit | Status | Note |
|---|---|---|---|---|
| 1 | `node automation/claude-bin.cjs --selftest` | 0 | PASS | 26 passed, 0 failed |
| 2 | `node automation/seat-wave.pending-server.cjs --selftest` | 0 | PASS | pass mode |
| 3 | `node backend/ensemble/read-ensemble-1.js --selftest` | 0 | PASS | PASS {"selectsThePlantedMechanismBackedReproducedEdges":true; passes only with root "type":"module" removed |
| 4 | `node backend/execution-engine.js --selftest` | 1 | NEEDS-HOME-DATA | gate checks need broker credentials/backend/.env (absent): environment gate blocks; ⊘ REFUSED — broker unreachable (Alpaca credentials absent) — a check that cannot run has not passed |
| 5 | `node backend/hunt/ETF_TSMOM.js --selftest` | 0 | PASS | PASS  known-answer signs (+1 uptrend, -1 downtrend); passes only with root "type":"module" removed |
| 6 | `node backend/hunt/FOMC_DAYS.js --selftest` | 0 | PASS | PASS  windows: 39 discovery / 38 holdout statement days, dis; passes only with root "type":"module" removed |
| 7 | `node backend/hunt/INTRADAY_MOM.js --selftest` | 0 | PASS | PASS  nwT known answer — t 5.5549 vs 5.5549; passes only with root "type":"module" removed |
| 8 | `node backend/hunt/OVN_INTRA_FREQ.js --selftest` | 0 | PASS | PASS  A signal known answer — hits 7/20 (expected 7/20); passes only with root "type":"module" removed |
| 9 | `node backend/hunt/PENSION_REBAL.js --selftest` | 0 | PASS | PASS  A1 no December signal (no previous-month reference in ; passes only with root "type":"module" removed |
| 10 | `node backend/hunt/SALIENCE.js --selftest` | 0 | PASS | PASS  ST equals Cov(omega, r) brute force (200 random window; passes only with root "type":"module" removed |
| 11 | `node backend/hunt/TURN_OF_MONTH.js --selftest` | 0 | PASS | PASS  exact TOM indexing + cost (60 units, gross 10bps, net ; passes only with root "type":"module" removed |
| 12 | `node backend/lib/r309-health.cjs --selftest` | 0 | PASS | PASS awaiting; flipped 3 h ago and still none -> FAIL |
| 13 | `node backend/lib/tasty-broker.js --selftest` | 0 | PASS | PASS (119 checks); passes only with root "type":"module" removed |
| 14 | `node backend/lib/w1-health.cjs --selftest` | 0 | PASS | PASS |
| 15 | `node backend/operator-reminders.js --selftest` | 0 | PASS | PASS (7/7) {"parse":true,"notYet":true,"aDue":true,"once":tr; passes only with root "type":"module" removed |
| 16 | `node backend/planE-paper-scoreboard.js --selftest` | 1 | NEEDS-HOME-DATA | FAIL selftest threw: Error: Cannot find module './planE-tasty.js' |
| 17 | `node backend/r147-earnings-momentum.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/alpaca-bars.js' |
| 18 | `node backend/r148-exhaustion-gap.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/alpaca-bars.js' |
| 19 | `node backend/r149-tv-family.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/alpaca-bars.js' |
| 20 | `node backend/r150-classics.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/alpaca-bars.js' |
| 21 | `node backend/r151-rsi2-forward.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/alpaca-bars.js' |
| 22 | `node backend/r151-rsi2-forward.pending-auctionfix.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/alpaca-bars.js' |
| 23 | `node backend/r156-qqe-ssl-wae-oos.js --selftest` | 1 | NEEDS-HOME-DATA | R156 FAILED: ENOENT: no such file or directory, open 'backend/data/r153-btc-coinbase-hourly.json' |
| 24 | `node backend/r157-aist-oos.js --selftest` | 1 | NEEDS-HOME-DATA | R157 FAILED: fetch failed |
| 25 | `node backend/r158-ipo-reversal.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/alpaca-bars.js' |
| 26 | `node backend/r179-chatter-grade.js --selftest-weekday` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/alpaca-bars.js' |
| 27 | `node backend/r181-dividend-days.js --selftest` | 0 | PASS | pass=false, Q4 t 0.29, heavy days 382/1920; passes only with root "type":"module" removed |
| 28 | `node backend/r183-late-earnings.js --selftest` | 1 | NEEDS-HOME-DATA | r183 FAILED: ENOENT: no such file or directory, open 'backend/data/anomaly-cache-v2/meta.json' |
| 29 | `node backend/r188-ai-persistence.js --selftest` | 0 | PASS | 24 passed, 0 failed; passes only with root "type":"module" removed |
| 30 | `node backend/r197-sp500-changes.js --selftest` | 0 | PASS | pass=false, E resolution {"byVolumeE1":250,"byVolumeE0":0,"d; passes only with root "type":"module" removed |
| 31 | `node backend/r202-one-candle.js --selftest` | 0 | PASS | PASS {"fillAtStopPrice":true,"targetTwoR":true,"costInR":tru; passes only with root "type":"module" removed |
| 32 | `node backend/r207-cross-retest-hold.js --selftest` | 0 | PASS | PASS {"crossRetestHoldDetected":true,"entryAtOpenOfRPlus1":t; passes only with root "type":"module" removed |
| 33 | `node backend/r211-luck-filter.js --selftest` | 0 | PASS | 22 passed, 0 failed; passes only with root "type":"module" removed |
| 34 | `node backend/r219-zn-month-end.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/schwab.js' |
| 35 | `node backend/r235-book-1.js --selftest` | 1 | NEEDS-HOME-DATA | reads backend/data/test-registry.json entry, which is redacted in this copy (e.bar/e.rule undefined) |
| 36 | `node backend/r273-gayed-rotations.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/alpaca-bars.js' |
| 37 | `node backend/r276-large-tick-trend.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/alpaca-bars.js' |
| 38 | `node backend/r277-ng-storage-day.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/alpaca-bars.js' |
| 39 | `node backend/r279-tax-loss-reversal.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/tv-pit-panel.js' |
| 40 | `node backend/r280-oil-timing.js --selftest` | 1 | NEEDS-HOME-DATA | R280 FAILED: fetch failed |
| 41 | `node backend/r281-earnrank-forward.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/earnrank.js' |
| 42 | `node backend/r284-eod-xsec-loser-reversal.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/alpaca-bars.js' |
| 43 | `node backend/r285-pre-tra-duration-drift.js --selftest` | 1 | NEEDS-HOME-DATA | R285 FAILED: ENOENT: no such file or directory, open 'backend/data/training/tra-dates.json' |
| 44 | `node backend/r287-sip-orb5-relvol-top20.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/alpaca-bars.js' |
| 45 | `node backend/r288-spx-0dte-breakeven-iron-condor.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/equity-bars-1m.js' |
| 46 | `node backend/r291-vix-backwardation-spx-timing.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/null-bar.js' |
| 47 | `node backend/r292-closing-auction-deviation-fade.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/alpaca-bars.js' |
| 48 | `node backend/r294-composite-vp-value-area.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/equity-bars-1m.js' |
| 49 | `node backend/r296-delta-divergence.js --selftest` | 0 | PASS | PASSED; passes only with root "type":"module" removed |
| 50 | `node backend/r301-ipo-lockup.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/clustered.js' |
| 51 | `node backend/r302-crypto-listing-fade.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/clustered.js' |
| 52 | `node backend/r303-youtube-fade.js --selftest` | 0 | PASS | pass; passes only with root "type":"module" removed |
| 53 | `node backend/r304-breaker-enforce.js --selftest` | 0 | PASS | passed; passes only with root "type":"module" removed |
| 54 | `node backend/r305-opex-wing-twin.js --selftest` | 0 | PASS | passed; passes only with root "type":"module" removed |
| 55 | `node backend/r307-ride-the-wave.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/clustered.js' |
| 56 | `node backend/r308-crest-predictor.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/clustered.js' |
| 57 | `node backend/r310-qs-rsi5.js --selftest` | 0 | PASS | PASS {"a_rsiMatchesIndependentTo1e9":true,"a_rsiIs100OnAllUp; passes only with root "type":"module" removed |
| 58 | `node backend/r312-europe-carry.js --selftest` | 0 | PASS | PASS {"cipKnownAnswer":true,"cipUsd":true,"dexszusInverted":; passes only with root "type":"module" removed |
| 59 | `node backend/r313-ibs-etfs.js --selftest` | 0 | PASS | PASS {"a_ibsExactAndUndefinedWhenFlat":true,"a_strictThresho; passes only with root "type":"module" removed |
| 60 | `node backend/r314-btc-funding-extremes.js --selftest` | 0 | PASS | PASS {"a_intervalParse":true,"b_dailyFundingCompleteness":tr; passes only with root "type":"module" removed |
| 61 | `node backend/r316-ibs-forward.js --selftest` | 1 | NEEDS-HOME-DATA | reads backend/data/test-registry.json entry, which is redacted in this copy (e.bar/e.rule undefined) |
| 62 | `node backend/r319-btc-nyse-hours.js --selftest` | 1 | NEEDS-HOME-DATA | R319 selftest FAIL {} |
| 63 | `node backend/r322-spreading-pressure.js --selftest` | 0 | PASS | PASS {"a_federalHolidays":true,"b_releaseSchedule":true,"b_c; passes only with root "type":"module" removed |
| 64 | `node backend/r324-country-momentum.js --selftest` | 0 | PASS | PASS {"a_monthEndsFromDailyBars":true,"b_momentum12minus1Ski; passes only with root "type":"module" removed |
| 65 | `node backend/r325-gold-overnight-forward.js --selftest` | 0 | PASS | PASS {"evidenceStartRespected":true,"nightArithmetic":true,"; passes only with root "type":"module" removed |
| 66 | `node backend/r343-yield-spike-bonds.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/null-bar.js' |
| 67 | `node backend/sector-momentum.js --selftest` | 0 | PASS | PASS {"normalPathUnchanged":true,"endedNameCashedOutAtLastCl; passes only with root "type":"module" removed |
| 68 | `node backend/selection-model.js --selftest` | 0 | PASS | passes only with root "type":"module" removed |
| 69 | `node backend/w5-probe.cjs --selftest` | 0 | PASS | 4 passed, 0 failed |
| 70 | `node docs/audit-fixes/2026-09-30/settle/selftest-r5-intraday.cjs` | 2 | NEEDS-HOME-DATA | SELFTEST UNKNOWN — ENOENT: no such file or directory, open 'backend/board-discipline.pending-0930.js' |
| 71 | `node docs/health-fixes/2026-10-05/chainfix/selftest.cjs` | 1 | NEEDS-HOME-DATA | child selftest requires a module not in this copy (MODULE_NOT_FOUND) |
| 72 | `node docs/health-fixes/2026-10-05/ops/selftest.cjs --selftest` | 1 | NEEDS-HOME-DATA | Error: ENOENT: no such file or directory, open 'docs/health-fixes/2026-10-05/ops/manifest.json' |
| 73 | `node docs/health-fixes/2026-10-05/testmachinery/staged/backend/r147-earnings-momentum.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/atomic-write.js' |
| 74 | `node docs/health-fixes/2026-10-05/testmachinery/staged/backend/sector-momentum.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/atomic-write.js' |
| 75 | `node docs/procedures/lint.cjs --selftest` | 0 | PASS | pass |
| 76 | `node docs/r316/r316-ibs-forward.pre-killbar.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/atomic-write.js' |
| 77 | `node docs/reconcile-pacing/2026-10-14/selftest.cjs` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './harness/tree.cjs' |
| 78 | `node docs/server/phase0-golive/backend/r307-ride-the-wave.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/clustered.js' |
| 79 | `node docs/server/phase0-golive/invariance.cjs --selftest` | 1 | NEEDS-HOME-DATA | invariance crashed: Error: Cannot find module 'backend/r309-surge-hold48.js' |
| 80 | `node docs/server/phase0-golive/r309-health.cjs --selftest` | 0 | PASS | PASS awaiting; flipped 3 h ago and still none -> FAIL |
| 81 | `node docs/server/phase0-golive/selftest.cjs --selftest` | 1 | NEEDS-HOME-DATA | FAIL  r309 --selftest (staged r309-v2)     0 ok, 0 failed, exit 1 |
| 82 | `node docs/server/research-stage01/fable-trial.cjs --selftest` | 0 | PASS | 6 passed, 0 failed |
| 83 | `node docs/server/research-stage01/selftest.cjs --selftest` | 1 | NEEDS-HOME-DATA | FAIL  registry-view (staged home lib)                0 ok, 0 failed, exit null |
| 84 | `node docs/server/research-stage01/server/factory/lib/budget.cjs --selftest` | 0 | PASS | 12 passed, 0 failed |
| 85 | `node docs/server/wave-r309fold/fixtures.cjs --selftest` | 1 | NEEDS-HOME-DATA | FAIL fixtures/index.json readable — ENOENT: no such file or directory, open 'docs/server/wave-r309fold/fixtures/index.js |
| 86 | `node docs/server/wave-r309fold/selftest.cjs --selftest` | 1 | NEEDS-HOME-DATA | FAIL  fixtures --selftest      0 ok, 1 failed, exit 1 |
| 87 | `node docs/server/wave1-crypto/backend/own-check.cjs --selftest` | 0 | PASS | 12 passed, 0 failed |
| 88 | `node docs/server/wave1-crypto/backend/w1-probe.cjs --selftest` | 0 | PASS | 7 passed, 0 failed |
| 89 | `node docs/server/wave1-crypto/backend/w1-run.cjs --selftest` | 0 | PASS | 20 passed, 0 failed |
| 90 | `node docs/server/wave1-crypto/compare-w1.cjs --selftest` | 0 | PASS | 15 passed, 0 failed |
| 91 | `node docs/server/wave1-crypto/selftest.cjs --selftest` | 1 | NEEDS-HOME-DATA | FAIL  manifests.cjs --check      0 ok, 2 failed, exit 1 |
| 92 | `node docs/server/wave1-crypto/w1-health.cjs --selftest` | 0 | PASS | PASS |
| 93 | `node docs/server/wave1c-2a/selftest.cjs --selftest` | 1 | NEEDS-HOME-DATA | FAIL  manifests.cjs --check    0 ok, 2 failed, exit 1 |
| 94 | `node docs/server/wave2b-schwab/md-guard.cjs --selftest` | 0 | PASS | pass; the optional callback passes; passes only with root "type":"module" removed |
| 95 | `node docs/server/wave2b-schwab/schwab-auth.cjs --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module 'deploy/server/pull-server.cjs' |
| 96 | `node docs/server/wave2b-schwab/selftest.cjs --selftest` | 1 | NEEDS-HOME-DATA | FAIL  units.cjs --check          0 ok, 0 failed, exit 1 |
| 97 | `node docs/server/wave3-sleeves/selftest.cjs --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module 'docs/server/wave3-sleeves/home-patch.cjs' |
| 98 | `node docs/server/wave3-sleeves/staged/backend/r316-ibs-forward.js --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module './lib/atomic-write.js' |
| 99 | `node docs/server/wave5-board/backend/w5-probe.cjs --selftest` | 0 | PASS | 4 passed, 0 failed |
| 100 | `node docs/server/wave6-agents/selftest.cjs --selftest` | 1 | NEEDS-HOME-DATA | FAIL  w6 table --selftest        0 ok, 0 failed, exit 1 |
| 101 | `node docs/server/wave6-agents/server/factory/lib/fstate.cjs --selftest` | 0 | PASS | 8 passed, 0 failed |
| 102 | `node docs/server/wave6-agents/server/w6/bin/w6-agent-run.cjs --selftest` | 0 | PASS | passes; yesterday's, one without the kind, one whose chain f |
| 103 | `node docs/server/wave6-agents/server/w6/bin/w6-outbox.cjs --selftest` | 0 | PASS | pass; a row that skips one, or an edited row, fails |
| 104 | `node docs/server/wave7-pm/selftest.cjs --selftest` | 1 | NEEDS-HOME-DATA | Error: Cannot find module 'deploy/server/own-check.cjs' |
| 105 | `node backend/test/run.js` | 1 | NEEDS-HOME-DATA | 74 passed, 0 failed over atomic/evalue/pipeline/stats; verify.test.js needs backend/test/fixtures/*.json (absent) |

## Last 5 lines of each non-PASS (for the record)

<details><summary>backend/execution-engine.js — NEEDS-HOME-DATA</summary>

```
✗  well-formed order, unvalidated strategy    NOT refused on provenance
armed: no (dry run) · audit: backend/data/execution-audit.jsonl
✗ 5 gate(s) did not refuse — DO NOT ARM
◇ injected env (0) from backend/.env
◇ injected env (0) from backend/.env
```
</details>

<details><summary>backend/planE-paper-scoreboard.js — NEEDS-HOME-DATA</summary>

```
at require (node:internal/modules/helpers:147:16)
at selftest (backend/planE-paper-scoreboard.js:1168:16)
at main (backend/planE-paper-scoreboard.js:785:37)
planE-paper-scoreboard selftest: 237 passed, 1 failed
◇ injected env (0) from backend/.env
```
</details>

<details><summary>backend/r147-earnings-momentum.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r147-earnings-momentum.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r148-exhaustion-gap.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r148-exhaustion-gap.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r149-tv-family.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r149-tv-family.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r150-classics.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r150-classics.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r151-rsi2-forward.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r151-rsi2-forward.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r151-rsi2-forward.pending-auctionfix.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r151-rsi2-forward.pending-auctionfix.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r156-qqe-ssl-wae-oos.js — NEEDS-HOME-DATA</summary>

```
R156 FAILED: ENOENT: no such file or directory, open 'backend/data/r153-btc-coinbase-hourly.json'
```
</details>

<details><summary>backend/r157-aist-oos.js — NEEDS-HOME-DATA</summary>

```
R157 FAILED: fetch failed
```
</details>

<details><summary>backend/r158-ipo-reversal.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r158-ipo-reversal.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r179-chatter-grade.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r179-chatter-grade.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r183-late-earnings.js — NEEDS-HOME-DATA</summary>

```
selftest injected 0 bp: late t -2.67 (1353 ev/92 mo), placebo t -4.48 met=true, peek t 94.2 met=true, pass=false
selftest injected -200 bp: late t 6.60 (1420 ev/92 mo), placebo t -4.68 met=true, peek t 104.1 met=true, pass=true
◇ injected env (0) from backend/.env
r183 FAILED: ENOENT: no such file or directory, open 'backend/data/anomaly-cache-v2/meta.json'
```
</details>

<details><summary>backend/r219-zn-month-end.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r219-zn-month-end.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r235-book-1.js — NEEDS-HOME-DATA</summary>

```
r235 FAILED: Cannot read properties of undefined (reading 'tRequired')
```
</details>

<details><summary>backend/r273-gayed-rotations.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r273-gayed-rotations.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r276-large-tick-trend.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r276-large-tick-trend.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r277-ng-storage-day.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r277-ng-storage-day.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r279-tax-loss-reversal.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r279-tax-loss-reversal.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r280-oil-timing.js — NEEDS-HOME-DATA</summary>

```
R280 FAILED: fetch failed
```
</details>

<details><summary>backend/r281-earnrank-forward.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r281-earnrank-forward.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r284-eod-xsec-loser-reversal.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r284-eod-xsec-loser-reversal.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r285-pre-tra-duration-drift.js — NEEDS-HOME-DATA</summary>

```
R285 FAILED: ENOENT: no such file or directory, open 'backend/data/training/tra-dates.json'
```
</details>

<details><summary>backend/r287-sip-orb5-relvol-top20.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r287-sip-orb5-relvol-top20.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r288-spx-0dte-breakeven-iron-condor.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r288-spx-0dte-breakeven-iron-condor.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r291-vix-backwardation-spx-timing.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r291-vix-backwardation-spx-timing.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r292-closing-auction-deviation-fade.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r292-closing-auction-deviation-fade.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r294-composite-vp-value-area.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r294-composite-vp-value-area.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r301-ipo-lockup.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r301-ipo-lockup.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r302-crypto-listing-fade.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r302-crypto-listing-fade.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r307-ride-the-wave.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r307-ride-the-wave.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r308-crest-predictor.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r308-crest-predictor.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/r316-ibs-forward.js — NEEDS-HOME-DATA</summary>

```
R316 selftest FAIL {"a_ibsEdgeCases":true,"a_strictThresholds":true,"a_ibsOfAgrees":true,"b_sendWindow":true,"b_decideWindow":true,"b_clockCheck":true,"b_cidFormat":true,"c_clusterT":true,"c_shortfallArithmetic":true,"c_interimKill":true,"d_oneLotPerEtf":true,"d_skipHeldByOther":true,"d_owedExit":true,"d_offBlocksEntriesNotExits":true,"d_exitsPlannedFirst":true,"e_placeboUnrestricted":true,"f_day1Decide":true,"f_backupSendsNothing":true,"f_afterClose1":true,"f_day2":true,"f_roundTripSpy":true,"f_owedExitAndXlkRoundTrip":true,"f_gapLogged":true,"f_gapDaySignalsAreNoDecision":true,"f_noDuplicateRows":true,"f_status":true,"f_reportingFields":true,"f_noGuardViolation":true,"g_crashThenBackup":true,"h_adoption":true,"i_hardGuard":true,"i_realBrokerRefusesWithoutKeys":true,"j_guardAuditHalts":true,"k_quoteFailure":true,"k_traidsStop":true,"threw":false,"z_realFilesUntouched":true}
detail {"e":{"trades":14,"slotsWithSignalDays":14},"f":{"nightly":{"roundTrips":2,"execution":{"n":2,"entryDays":1,"meanShortfallPct":1.5916,"shortfallCrT":null,"dayMeanShortfallPct":1.5916,"lateLegRoundTrips":0,"meanShortfallOnTimePct":1.5916,"meanFillToFillPct":1.9496,"fillToFillCrT":null,"fillToFillCrTRaw":null,"fillToFillDayMeanT":null,"meanShadowPct":3.5412,"winRateFillToFillPct":100},"shadow":{"closed":2,"open":2,"meanGrossPctPerTrade":1.2811,"meanNetPctPerTrade":1.2211,"meanNetPctPerMonth":1.2211,"months":1,"costPct":0.06,"placebo":{"form":"R313 corrected matched placebo, UNRESTRICTED start days (2026-10-02 audit fix)","draws":500,"seed":313,"slots":2,"droppedPerDraw":0,"widenedPerDraw":0,"pairedMonths":1,"pairedExcessPctPerMonth":1.5167,"pairedT":null}},"agreement":{"days":5,"entrySignal":{"both":2,"missed":1,"extra":1,"noDecision":1},"exitSignal":{"both":2,"missed":1,"extra":0,"noDecision":0},"entryAction":{"both":1,"missed":3,"extra":1},"exitAction":{"both":1,"missed":1,"extra":1}},"unpairedAllIn":{"shadowOwnGrossPctPerTrade":1.2811,"shadowOwnClosed":2,"actualPctPerTrade":1.9496,"actualRoundTrips":2,"note":"R313's own forward trades (official closes) vs the live arm's fill-to-fill trades — different trade sets; includes the 15:55 selection effect the paired shortfall excludes; reported only"},"interimKill":{"at":40,"bar":-3.13,"roundTrips":2,"applies":false,"t":null,"triggered":false,"schedule":"one look at the first after-close with >= 40 round trips","looked":null,"diagnostic":{"calendarNwT":0.092,"lag":10,"sessions":5,"gated":false,"note":"calendar-time Newey-West t of the arm's daily book P&L (open lots marked to the official close); reported only — the registered kill statistic is the entry-day CR1 t"}}}},"threw":"TypeError: Cannot read properties of undefined (reading 'match')\n    at selftest (backend/r316-ibs-forward.js:1088:32)\n    at async backend/r316-ibs-forward.js:1216:45"}
```
</details>

<details><summary>backend/r319-btc-nyse-hours.js — NEEDS-HOME-DATA</summary>

```
R319 selftest FAIL {}
detail {"threw":"Error: Cannot find module './lib/null-bar.js'\nRequire stack:\n- backend/r319-btc-nyse-hours.js\n    at Function._resolveFilename (node:internal/modules/cjs/loader:1383:15)\n    at defaultResolveImpl (node:internal/modules/cjs/loader:1025:19)\n    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1030:22)\n    at Function._load (node:internal/modules/cjs/loader:1192:37)\n    at TracingChannel.traceSync (node:diagnostics_channel:328:14)\n    at wrapModuleLoad (node:internal/modules/cjs/loader:237:24)\n    at Module.require (node:internal/modules/cjs/loader:1463:12)\n    at require (node:internal/modules/helpers:147:16)\n    at computeRead (backend/r319-btc-nyse-hours.js:724:37)\n    at selftest (backend/r319-btc-nyse-hours.js:571:16)"}
```
</details>

<details><summary>backend/r343-yield-spike-bonds.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'backend/r343-yield-spike-bonds.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>docs/audit-fixes/2026-09-30/settle/selftest-r5-intraday.cjs — NEEDS-HOME-DATA</summary>

```
SELFTEST UNKNOWN — ENOENT: no such file or directory, open 'backend/board-discipline.pending-0930.js'
```
</details>

<details><summary>docs/health-fixes/2026-10-05/chainfix/selftest.cjs — NEEDS-HOME-DATA</summary>

```
'docs/health-fixes/2026-10-05/chainfix/selftest-child.cjs'
]
}
Node.js v22.22.0
SELFTEST FAIL
```
</details>

<details><summary>docs/health-fixes/2026-10-05/ops/selftest.cjs — NEEDS-HOME-DATA</summary>

```
code: 'ENOENT',
syscall: 'open',
path: 'docs/health-fixes/2026-10-05/ops/manifest.json'
}
Node.js v22.22.0
```
</details>

<details><summary>docs/health-fixes/2026-10-05/testmachinery/staged/backend/r147-earnings-momentum.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'docs/health-fixes/2026-10-05/testmachinery/staged/backend/r147-earnings-momentum.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>docs/health-fixes/2026-10-05/testmachinery/staged/backend/sector-momentum.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'docs/health-fixes/2026-10-05/testmachinery/staged/backend/sector-momentum.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>docs/r316/r316-ibs-forward.pre-killbar.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'docs/r316/r316-ibs-forward.pre-killbar.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>docs/reconcile-pacing/2026-10-14/selftest.cjs — NEEDS-HOME-DATA</summary>

```
requireStack: [
'docs/reconcile-pacing/2026-10-14/selftest.cjs'
]
}
Node.js v22.22.0
```
</details>

<details><summary>docs/server/phase0-golive/backend/r307-ride-the-wave.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'docs/server/phase0-golive/backend/r307-ride-the-wave.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>docs/server/phase0-golive/invariance.cjs — NEEDS-HOME-DATA</summary>

```
at wrapModuleLoad (node:internal/modules/cjs/loader:237:24)
at Module.require (node:internal/modules/cjs/loader:1463:12)
at require (node:internal/modules/helpers:147:16)
at docs/server/phase0-golive/invariance.cjs:63:13
at Object.<anonymous> (docs/server/phase0-golive/invariance.cjs:122:3)
```
</details>

<details><summary>docs/server/phase0-golive/selftest.cjs — NEEDS-HOME-DATA</summary>

```
Error: repo root not found
FAIL  make-pull-task --selftest            0 ok, 0 failed, exit 1
const REPO = (() => { for (let d = HERE; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, "backend", "data")) && fs.existsSync(path.join(d, "deploy"))) return d; if (path.dirname(d) === d) throw new Error("repo root not found above " + HERE); } })();
Error: repo root not found above docs/server/phase0-golive
SELFTEST: 10 of 11 FAILED
```
</details>

<details><summary>docs/server/research-stage01/selftest.cjs — NEEDS-HOME-DATA</summary>

```
Error: Cannot find module 'docs/server/research-stage01/install-server.cjs'
PASS  fable-trial                                    6 ok, 0 failed, exit 0
PASS  deploy                                        10 ok, 0 failed, exit 0
FAIL  rollback                                       1 ok, 0 failed, exit 1
SELFTEST: 12 of 15 FAILED
```
</details>

<details><summary>docs/server/wave-r309fold/fixtures.cjs — NEEDS-HOME-DATA</summary>

```
FAIL fixtures/index.json readable — ENOENT: no such file or directory, open 'docs/server/wave-r309fold/fixtures/index.json'
fixtures selftest: 0 passed, 1 failed
```
</details>

<details><summary>docs/server/wave-r309fold/selftest.cjs — NEEDS-HOME-DATA</summary>

```
FAIL  register --selftest      0 ok, 0 failed, exit 1
Error: Cannot find module 'docs/server/wave-r309fold/home-patch.cjs'
PASS  parse (every file)       7 files — node --check / JSON.parse
PASS  repo untouched           20 watched paths identical before and after
SELFTEST: 7 of 9 checks FAILED
```
</details>

<details><summary>docs/server/wave1-crypto/selftest.cjs — NEEDS-HOME-DATA</summary>

```
Error: Cannot find module 'docs/server/wave1-crypto/own.cjs'
FAIL  rollback --selftest        0 ok, 0 failed, exit 1
Error: Cannot find module 'docs/server/wave1-crypto/own.cjs'
PASS  repo untouched             12 watched paths identical before and after
SELFTEST: 8 of 14 FAILED
```
</details>

<details><summary>docs/server/wave1c-2a/selftest.cjs — NEEDS-HOME-DATA</summary>

```
FAIL  rollback --selftest      0 ok, 0 failed, exit 1
Error: Cannot find module 'deploy/server/pull-server.cjs'
PASS  parse (every file)       9 files — node --check / JSON.parse
PASS  repo untouched           18 watched paths identical before and after
SELFTEST: 8 of 11 checks FAILED
```
</details>

<details><summary>docs/server/wave2b-schwab/schwab-auth.cjs — NEEDS-HOME-DATA</summary>

```
requireStack: [
'docs/server/wave2b-schwab/schwab-auth.cjs'
]
}
Node.js v22.22.0
```
</details>

<details><summary>docs/server/wave2b-schwab/selftest.cjs — NEEDS-HOME-DATA</summary>

```
FAIL  rollback --selftest        0 ok, 0 failed, exit 1
Error: Cannot find module 'docs/server/wave2b-schwab/rollback.cjs'
PASS  parse (every file)         10 files — node --check / JSON.parse
PASS  repo untouched             24 watched paths identical before and after; <home>/.traids absent before and after (no selftest wrote under the user's home folder)
SELFTEST: 9 of 12 checks FAILED
```
</details>

<details><summary>docs/server/wave3-sleeves/selftest.cjs — NEEDS-HOME-DATA</summary>

```
requireStack: [
'docs/server/wave3-sleeves/selftest.cjs'
]
}
Node.js v22.22.0
```
</details>

<details><summary>docs/server/wave3-sleeves/staged/backend/r316-ibs-forward.js — NEEDS-HOME-DATA</summary>

```
requireStack: [
'docs/server/wave3-sleeves/staged/backend/r316-ibs-forward.js'
]
}
Node.js v22.22.0
```
</details>

<details><summary>docs/server/wave6-agents/selftest.cjs — NEEDS-HOME-DATA</summary>

```
FAIL  last line (both forms)     3 ok, 1 failed
FAIL the build loop reads the same case count from the red line as from the green one
PASS  parse (every file)         16 files — node --check / JSON.parse
PASS  repo untouched             31 watched paths identical before and after (no log line, no job output, no map / registry / manifest / launcher change)
SELFTEST: 11 of 13 checks FAILED (4 selftest cases)
```
</details>

<details><summary>docs/server/wave7-pm/selftest.cjs — NEEDS-HOME-DATA</summary>

```
'docs/server/wave7-pm/w7-lib.cjs',
'docs/server/wave7-pm/selftest.cjs'
]
}
Node.js v22.22.0
```
</details>

<details><summary>backend/test/run.js — NEEDS-HOME-DATA</summary>

```
code: 'ENOENT',
syscall: 'open',
path: 'backend/test/fixtures/nq-1m-2026-09-21.json'
}
Node.js v22.22.0
```
</details>

## Excluded as not-a-test (not reported above)

- backend/r312-forward-record.js
- docs/health-fixes/2026-10-05/alerting/verify-live.cjs
- docs/health-fixes/2026-10-05/r295/deploy.cjs
- docs/health-fixes/2026-10-05/r295/harness/run-harness.cjs
- docs/health-fixes/2026-10-05/r295/rollback.cjs
- docs/profit-fixes/2026-10-12/b-plan-e/verify-live.cjs
- docs/r191-sell-repair/2026-10-14/verify-live.cjs
- docs/r231-sell-repair/2026-10-12/verify-live.cjs
- docs/r295/patch-r295-v2.cjs
- docs/r295/swap-r295-v5.cjs
- docs/server/phase0-golive/make-pull-task.cjs
- docs/server/phase0-golive/pull-r309.cjs
- docs/server/phase0-golive/register-evidence-start.cjs
- docs/server/phase0-golive/rollback.cjs
- docs/server/research-stage01/deploy.cjs
- docs/server/research-stage01/rollback.cjs
- docs/server/research-stage01/server/factory/lib/limit.cjs
- docs/server/wave-r309fold/deploy-server/r309-fold.cjs
- docs/server/wave-r309fold/register.cjs
- docs/server/wave-r309fold/rollback.cjs
- docs/server/wave1-crypto/deploy.cjs
- docs/server/wave1-crypto/home-patch.cjs
- docs/server/wave1-crypto/pull-server.cjs
- docs/server/wave1-crypto/register-w1.cjs
- docs/server/wave1-crypto/rollback.cjs
- docs/server/wave1c-2a/compare.cjs
- docs/server/wave1c-2a/deploy-server/home-gate.cjs
- docs/server/wave1c-2a/deploy-server/w1c-symbols.cjs
- docs/server/wave1c-2a/rollback.cjs
- docs/server/wave2b-schwab/compare.cjs
- docs/server/wave2b-schwab/deploy-server/w2b-manifest.cjs
- docs/server/wave2b-schwab/register.cjs
- docs/server/wave3-sleeves/rollback.cjs
- docs/server/wave5-board/rollback.cjs
- docs/server/wave6-agents/w6.cjs
- docs/server/wave7-pm/fetch-day.cjs
- docs/server/wave7-pm/rollback.cjs
