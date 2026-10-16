# base/ — empty on purpose

A staged package's `base/` holds byte-exact copies of the live files the change starts from, so that
`deploy.cjs --apply` can refuse on drift and `rollback.cjs --apply` can put the old bytes back.

This package changes **no existing file**. All three files it ships are new:

| path | base state |
| --- | --- |
| `backend/lib/index-changes.js` | absent |
| `backend/lib/index-changes-fetch.js` | absent |
| `backend/index-change-collector.js` | absent |

So there are no base copies to keep, and the base state of each path is its **absence**. `lib.cjs`
records that as `baseSha: null` in its file table, `deploy.cjs --plan` prints `absent — the write mode
would create it`, and `rollback.cjs --apply` restores absence by removing the three paths — but only
when each one is byte for byte the staged copy. A path that exists with other bytes is DRIFT and both
modes refuse it whole: this package never overwrites or deletes someone else's file.

One live file the staged code **requires and does not change**:

| path | why |
| --- | --- |
| `backend/lib/atomic-write.js` | `writeTextAtomic` / `writeJsonAtomic` — the collector writes its JSONL and its provenance sidecar through it, never by shell redirection |

It is not copied here because it is not changed. `deploy.cjs --plan` checks that it is present and
refuses if it is not, and `selftest.cjs` copies it into its scratch tree byte for byte from the
repository, so the checks run against the real one.
