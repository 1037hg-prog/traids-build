# base/ — empty on purpose

A staged package's `base/` holds byte-exact copies of the live files the change starts from, so a deploy can refuse on drift and a
rollback can put the old bytes back.

**This package changes no live file.** All seven files in `staged/` are NEW at their repo paths:

```
backend/worst-day/sealed-ledger.js
backend/worst-day/sealed-check.js
backend/worst-day/nightly-model.js
backend/worst-day/nightly-forecast.js
backend/worst-day/sealed-grade.js
backend/worst-day/sealed-fixtures.js
backend/worst-day/sealed-selftest.js
```

So each one's base state is **absent**, and there is nothing to copy here. `deploy.cjs` reads that state directly:

| state | what is at the repo path | what `--apply` does |
|---|---|---|
| `absent` | nothing | writes the staged bytes |
| `applied` | the staged copy, byte for byte | nothing |
| `DRIFT` | something else | refuses the whole run; nothing is written |

`rollback.cjs` is the byte-exact inverse of an apply from an absent base: it **removes** those files, and only the ones that are
still byte for byte this package's staged copy. It never touches `backend/data/worst-day/` — a sealed ledger is append-only data,
not code.

`selftest.cjs` checks that this directory holds nothing but this README, so a later edit that quietly adds a base copy without
teaching `deploy.cjs` about it fails the selftest instead of passing unnoticed.
