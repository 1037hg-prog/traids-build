# traids-build

A code-only clean copy of TRAIDS, a paper-trading and research system, made for cloud build sessions.

## What is here

- The JavaScript source files (.js, .cjs, .mjs) of the home repository that passed every screen, plus the root package.json and package-lock.json when they pass the screens too. Without a lockfile, npm install resolves versions from package.json.
- A redacted test registry at backend/data/test-registry.json. Entries that are not ours to share are reduced to their id; entries that failed a screen of this copy are reduced to their id as well.
- The build rules for sessions working here: AGENTS.md.

## What is not here

- No data: no ledgers, no state files, no logs, no recordings.
- No keys, tokens, passwords, webhook addresses or account numbers of any kind.
- No personal details.
- No material that belongs to other people. It is screened out by path and by content, and over-exclusion is the accepted direction of error, so some ordinary files are missing too.

## How it is refreshed

At home, make-clean-copy.cjs rebuilds this tree from scratch from the home repository's tracked files, runs its check over the tree and over every blob in this history, and commits only when the check is clean. The tool itself stays at home. The operator reviews each refresh before it is pushed.

## Tests

Tests that need real trading data, ledgers, broker access or the full registry run at home, not here. Many selftests here will miss their data files or fixtures; that is expected and is not a reason to add data. Work done here goes to a branch named claude/<short-name>; the operator re-checks it and applies it at home.
