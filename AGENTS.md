# Working in this repository (cloud build sessions)

This is a code-only clean copy of TRAIDS. Read README.md for what is and is not here. These rules bind every session and every model.

## What a session may do

- Read and change code, write tests, and run tests that need no data, no network and no keys.
- Finish by committing to a branch named `claude/<short-name>` and pushing that branch only. Never commit to `main` and never push `main`.
- The operator re-checks every change and applies it at home. Nothing done here deploys, restarts or schedules anything.

## Hard rules

- No orders of any kind, on any account, paper included. No broker calls and no order tools.
- Tests make no broker calls and no network calls of any kind: use fixtures and fakes.
- No secrets exist here and none may be added: no keys, tokens, passwords, webhook addresses or account numbers, real or temporary. Tests use fake values that are plainly fake.
- No personal details: no names of people, email addresses, phone numbers or host addresses.
- JSON data is written only from a node script through `backend/lib/atomic-write.js` (`writeJsonAtomic`). Never edit JSON with shell redirection, heredocs, PowerShell or sed.
- Never run `node -e` with backslashes in the script: the shell mangles them. Write a small script file instead.
- Never `require()` `automation/close-chain.cjs`: it runs the nightly chain. Check it with `node --check` only.
- Node 22 is what the cloud has; home runs Node 24. Avoid APIs that only Node 24 has.
- A registered test's rule, bar, population or read condition is never changed to make something pass. If a task needs that, stop and say so in the branch's notes.

## How a build is done

- Every build follows the build-check-loop pattern: a builder implements the spec, and a separate checker runs every check command, read-only. At most 5 fix cycles. Stop at once on a regression (a check that passed earlier now fails), or if any test disappears or the number of tests shrinks.
- Never weaken, skip or delete a test to make it pass. List every test edit with its reason.
- Write real known-answer tests for what you build. A selftest ends with a line saying it passed.
- A change to live code ships as a staged package in its own folder under docs/:
  - `base/` holds byte-exact copies of the live files the change starts from; `staged/` holds the changed files at their repo paths;
  - `deploy.cjs --plan` shows what would change and `--apply` applies it, refusing on drift (a live file that no longer matches `base/`);
  - rollback restores `base/` byte for byte;
  - `selftest.cjs` proves the package on fixtures;
  - `record.cjs --dry` shows the record it would write.
- The operator runs `--apply` at home. A cloud session builds and tests the package; it never applies it.
