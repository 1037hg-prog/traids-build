# base/ — empty on purpose

A staged package keeps, in `base/`, byte-exact copies of the live files its change starts from, so `rollback.cjs` can
put them back byte for byte.

**This package changes no live file.** It adds three new ones:

```
backend/lib/shadow-ledger.js
backend/r275-release-shadow.js
backend/r192-month-end-shadow.js
```

So `base` for each of them is **ABSENT**, which is why there are no bytes to keep here. `deploy.cjs` carries
`baseSha: null` for all three and reads each file's state as:

| state | meaning |
|---|---|
| `absent` | base — `--apply` would create it from `staged/` |
| `applied` | home already holds the staged bytes |
| `DRIFT` | something is already there that is **not** the staged bytes — refused, nothing written: read what is there first |

`rollback.cjs --apply` restores `base` by **removing** the three files, and refuses on DRIFT for the same reason. It
never removes the records the shadows wrote (`backend/data/r275-release-shadow.jsonl`,
`backend/data/r192-month-end-shadow.jsonl` and the two JSON read-outs beside them) — those are evidence; they simply
stop growing.

The staged bytes are pinned by sha256 in `deploy.cjs` (`FILES[].stagedSha`), and `--plan` prints them beside the ones
on disk, so a staged copy that was edited after review refuses too.
