# base/ — deliberately empty

`base/` holds byte-exact copies of the live files a staged package starts from, and is what `rollback.cjs` restores.

This package ships **two files that do not exist at home**:

- `backend/ai-bubble-ladder.js`
- `backend/ai-bubble-ladder-monitor.js`

So the bytes they start from are *"the file is not there"*, and there is nothing to copy here. `deploy.cjs --plan`
prints each file's state as `absent` (it would be created), `applied` (it holds the staged bytes), or `DRIFT` (it is
there and is **not** the staged bytes — both write modes then refuse and change nothing). `rollback.cjs --apply`
restores that base by removing the two files, and refuses the whole unit if either one is `DRIFT`, so it never deletes
a file it does not recognise.

Nothing else is restored, because nothing else was ever written: `backend/data/ai-bubble-ladder-status.json` — the
dated readings the monitor itself writes with `--write` — is the operator's own record and is left where it is.
