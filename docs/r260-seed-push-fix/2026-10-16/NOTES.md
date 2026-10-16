# r260-seed-push-fix — 2026-10-16

## The defect (found from the code)

The w3-r260 seed push is done by `own.cjs w3-r260 server`, through pull-server's `pushRemote` → `remotePushCommand` (`docs/server/wave1-crypto/pull-server.cjs`, installed at home as `deploy/server/pull-server.cjs`).

`remotePushCommand` puts **every file twice into the script** it sends over ssh:

- one sha256 line inside the `<<'EOF_SHA'` here-document,
- one mode line inside `<<'EOF_MV'`.

So the script grows with the number of files. A script over about 8,190 characters arrives **cut** on the VPS. This was seen on 2026-10-10 by w3-sync.cjs and is recorded as `SCRIPT_MAX` in `docs/server/wave7-pm/w7-lib.cjs`. When the script is cut:

1. bash reads to the end of what arrived, still inside the EOF_SHA here-document.
2. It prints `here-document at line 9 delimited by end-of-file (wanted 'EOF_SHA')`. Line 9 is exactly where `remotePushCommand` opens EOF_SHA.
3. It never reaches EOF_MV, moves nothing, prints no `PUSHED n`, and the push fails.

The w3-r260 seed is many files in one call, so its script was far over the cut. `selftest.cjs` reproduces it on the **unchanged** base pull-server: a 142-file w3-r260-like seed makes a single script over 8,190 characters, and a fake ssh that cuts at 8,190 then produces bash's exact message (`bash: line 85: warning: here-document at line 9 delimited by end-of-file (wanted 'EOF_SHA')`).

## The fix

1. **`pull-server.cjs`** (both twins, same bytes) gains:
   - `pushChunked(ssh, dir, files, { lock, lockWait })`: sends the files in chunks. Each chunk's script is measured exactly (it is the real `remotePushCommand` text) and stays ≤ 5,000 characters. Every chunk goes under the same lock, and is read back by sha256 before the next one is sent.
     - If a chunk does not come back as sent, it throws and nothing more is sent.
     - If the lock is busy at chunk k, it returns `{ busy: true, pushed, partial }`.
   - `remoteShasChunked`: the same chunking for sha reads over long lists.
   - `chunkByScript`, `remoteShasCommand` and `SCRIPT_MAX`.
   `pushRemote` and `remoteShas` are **unchanged**: they send byte-identical scripts (proved in the selftest). Their callers that already chunk (W7's `pushVerified`, W2b's `pushInputs`, w3-sync) and the W7/W2b selftest controls rely on `pushRemote` staying one script.
2. **`own.cjs`** must call `PS.pushChunked(` instead of `PS.pushRemote(` for its seed push. `own.cjs` is not in this clean copy (see below), so `make-own-stage.cjs` makes that change **at home, from home's own bytes**, only on the lines the operator names. It writes `base/` and `staged/` for both twins (`deploy/server/own.cjs` and `docs/server/wave1-crypto/own.cjs`), and `files.cjs` then includes them in deploy and rollback.

## Checks (cloud, 2026-10-16)

- `node docs/r260-seed-push-fix/2026-10-16/selftest.cjs` → `ALL 41 CASES PASSED`. It uses a fake ssh function that cuts at 8,190 and runs the rest with real bash in a temp folder; no host is contacted. It covers:
  - the defect reproduced on base, plus a small-seed control;
  - the chunked push landing all files with every script ≤ 5,000;
  - per-file modes;
  - a busy lock at chunk 2;
  - a corrupted chunk 2 (throws, chunk 3 never sent);
  - ssh down;
  - an empty list;
  - a small list sending a script identical to `pushRemote`'s;
  - a chunked sha read of 442 names;
  - "nothing else changed" in pull-server;
  - make-own-stage on a plainly-labelled fixture;
  - deploy / rollback / drift / record on a temp repo;
  - (added after checker cycle 1) `make-own-stage --write` run end to end on a temp copy of the package: both twins staged, files.cjs then lists 4 files, deploy and rollback over all 4, refusal when home's own.cjs changed after staging, refusal when the staged pull-server lacks `pushChunked`; lockWait 120 reaching every chunk; the 5,000 limit itself; an ssh failure at chunk 2 naming the chunk; chunking linear in the number of files; rollback refusing an edited twin. Each section reports a named FAIL if it throws. The package cases run on a temp copy of the package, so they read the same before and after the home step.
- Independent checker, cycle 1: diagnosis confirmed. With real bash, any cut between line 9 and the EOF_SHA terminator gives exactly that message; CRLF, dash, odd file names and Windows quoting give other errors. 29/29 passed and the core mutations were caught, but the home-only `--write` path, files.cjs's own.cjs entries, lockWait and rollback drift were untested (8 mutations missed). All 8 are now caught.
- Independent checker, cycle 2: PASS. No regressions; 32 of 33 mutations killed; a 2,100-case fuzz of chunkByScript found no dropped, reordered or over-limit run; the home step (make-own-stage `--write`, then the package selftest from that copy) was simulated and passed. Its four low findings are fixed: the corrupt-chunk case now corrupts the chunk's last file, a read-back ssh failure names its chunk, sha-read chunks are filled to the limit, and the guard-line risk is in this NOTES.
- `deploy.cjs --plan` on this clean copy reports **drift** for `deploy/server/pull-server.cjs`, because `deploy/server/` does not exist here. That is the correct refusal. At home it must read `base` for both twins.

## Missing from this clean copy (not reconstructed)

- **`deploy/server/own.cjs` and `docs/server/wave1-crypto/own.cjs`.** This is the file with the failing seed call. The exact line cannot be shown here; `make-own-stage.cjs --plan` lists every `PS.pushRemote(` / `PS.remoteShas(` line at home.
- `deploy/server/pull-server.cjs`, the installed twin. `base/deploy/server/pull-server.cjs` is a copy of the clean copy's `docs/server/wave1-crypto/pull-server.cjs`. If home's installed copy differs, `deploy.cjs` refuses. Then re-base this package at home.
- `docs/server/wave1-crypto/manifests/*.json` (no JSON in this copy). `pull-server.cjs --selftest` therefore cannot run here: it stops at copying `manifests/r309.json`. **Run it at home** on the staged file (below).
- `docs/server/wave3-sleeves/cell.cjs`, which defines the w3-r260 files. The real seed size was not measured; the selftest uses a 142-file seed with realistic names.

## Not changed, and worth knowing

- `pushChunked` takes and releases the unit's lock once per chunk. The old single push held it for the whole seed. This is safe only if own.cjs seeds **before** it flips the map to the server, so that the VPS unit cannot run between chunks. **Check this at home** in own.cjs (the cutover's order). A lock busy at chunk k returns `{ busy: true, partial: true, pushed }`. own.cjs's existing `if (r.busy)` abort still fires; the chunks that landed are equal to home's files, so the next cutover's seed check accepts them.
- own.cjs's ownership-guard read (`srv = PS.remoteShas(ssh, remoteData, names)`) is unchunked. If its `names` list is the seed list, it too would be cut once the list passes about 170 names of about 45 characters. **Measure it at home**; today's seed (the 70+ files that broke the push) is under that.
- Do **not** name own.cjs's ownership-guard line (`srv = PS.remoteShas(ssh, remoteData, names)`, the anchor of docs/pause-aware's mutants) in make-own-stage. Any package that pins own.cjs's current bytes will read drift after this deploy.
- If own.cjs's own selftest pins the exact ssh call sequence of the seed, the extra sha read per chunk will show there. Expect to update that test's expected sequence. It must not be weakened: the seed must still be verified.
- Measure the real w3-r260 seed at home (`make-own-stage --plan`, and the w3-r260 manifest's entries). For the cut to fall inside the EOF_SHA block it needs roughly 70 or more files with names of about 45 characters.

- `pushInputs` still pushes a unit's inputs in one script. w3-r260 has one input (`r259-universe.json`), which is far under the cut. A wave with many inputs would need the same change.
- `remoteTarCommand` (the pull, and the seed-mode read of the server's copy) lists every non-directory entry in its script. A unit with more than about 200 file entries would hit the same cut on a pull. Directory entries are one line each.

## Operator steps at home

1. `node docs/r260-seed-push-fix/2026-10-16/selftest.cjs`. It must end `ALL … PASSED`.
2. `node docs/r260-seed-push-fix/2026-10-16/make-own-stage.cjs --plan`. Read the listed lines and pick the **seed push** line(s): the `PS.pushRemote(` call that sends a unit's seed files at a cutover. Also pick any `PS.remoteShas(` that reads back that same seed list. Leave the map push and other short pushes alone.
3. `node docs/r260-seed-push-fix/2026-10-16/make-own-stage.cjs --write --lines <n>[,<n>]`. It prints each changed line.
4. `node docs/r260-seed-push-fix/2026-10-16/deploy.cjs --plan`. All four files (two pull-server twins, two own.cjs twins) must read `base`. Then run `--apply`.
5. `node deploy/server/pull-server.cjs --selftest` and `node deploy/server/own.cjs --selftest`. Both must pass with the same case counts as before plus none lost. Also run `node docs/server/wave7-pm/deploy.cjs --selftest`: its "CHUNKING" and control cases must still pass.
6. `node docs/r260-seed-push-fix/2026-10-16/record.cjs --dry`, and record the change with the home recorder.
7. Retry the cutover: `node deploy/server/own.cjs w3-r260 server --dry`, then for real. The seed now goes in chunks; each chunk is printed through own.cjs's own lines.

Rollback: `node docs/r260-seed-push-fix/2026-10-16/rollback.cjs` restores every file from `base/` byte for byte. That covers the own.cjs twins too once they are staged.
