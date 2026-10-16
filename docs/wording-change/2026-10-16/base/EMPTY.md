# base/ is empty on purpose

A staged package keeps, in `base/`, a byte-exact copy of every live file the change starts from, so that `deploy.cjs --apply` can
refuse on drift and `rollback.cjs` can put the old bytes back.

This package changes no live file. All three files it ships are new:

- `backend/lib/filing-sections.js`
- `backend/lib/sec-fetch.js`
- `backend/filing-wording-collector.js`

So the base state of each one is **absent**, and there is nothing to copy here.

What takes the place of the usual base copies:

- **drift** — `deploy.cjs --plan` reads a target that already exists with bytes other than the staged ones as `DRIFT` and `--apply`
  refuses the whole package. It only ever creates a file; it never overwrites one.
- **rollback** — `rollback.cjs --apply` removes the three files again, which is exactly the state home was in before, and refuses
  (removing nothing at all) if any of them has been edited since.
