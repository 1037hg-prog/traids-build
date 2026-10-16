# base/ is empty on purpose: for this package, base is ABSENCE

`base/` holds byte-exact copies of the live files a change starts from. This package adds **three new files** and changes none:

- `backend/lib/fund-discount.js`
- `backend/r354-fund-discounts.js`
- `backend/fund-nav-record.js`

None of them exists in the live tree, so there are no starting bytes to copy. The state each path starts from is **absence**, and that
is what a rollback restores:

- `deploy.cjs --plan` prints each path as `new` (would be written), `applied` (home already holds the staged bytes) or **`DRIFT`** —
  home holds something that is neither, which refuses the whole package until a human has read that file.
- `rollback.cjs --apply` **removes** each path that holds the staged bytes, byte for byte, and refuses on DRIFT. A path that is already
  absent is left alone.

A rollback never removes anything under `backend/data/` — a `--controls` file, a read, the nightly recorder's JSONL. Those are records,
not code. See `../NOTES.md`.
