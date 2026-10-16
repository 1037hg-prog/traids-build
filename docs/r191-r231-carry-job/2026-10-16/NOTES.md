# r191-r231-carry-job — 2026-10-16

## What changed

One NEW home file: `deploy/server/r191-r231-carry.cjs` (staged at `staged/deploy/server/r191-r231-carry.cjs`). No live file is edited, so `base/` holds no copy (see `base/README.txt`). `deploy.cjs` refuses if a different file already sits at that path.

## Why

Since the sell repairs (R231 on 2026-10-12, R191 on 2026-10-14), R191 and R231 each read the other sleeves' own files from their own `backend/data` folder before any sell (`otherSleeves()` in both runners):

| file | written by | read by |
|---|---|---|
| `r191-crypto-trend.json` | R191 (unit `w3-r191`) | R231 |
| `r231-crypto-vote-sized.json` | R231 (unit `w3-r231`) | R191 |
| `alpaca-mirror.jsonl`, `alpaca-mirror-exits.jsonl` | the board's mirror (`alpaca-mirror.js`, home until W5) | both |
| `r191-crypto-trend.jsonl`, `r231-crypto-vote-sized.jsonl` | each runner (its own ledger: the client ids it has used) | itself only — carried into the shadow tree while that unit is home-owned |

If a runner cannot read one of these files, it treats it as unreadable: it makes no sell of that coin that run (R191 makes no sell of any coin) and exits 1. W3 moves `w3-r191` and `w3-r231` to the VPS one unit at a time (`docs/server/wave3-sleeves/manifests.cjs`). The board keeps writing its files at home. The W3 manifests do not carry any of these files, because each manifest names only its own unit's files and json inputs. `KNOWN_INPUTS` lists none for these two units, and the board's files are jsonl, which pull-server cannot treat as inputs. So without this job:

- **Real tree** (`/home/traids/traids/backend/data`): a server-owned R191 or R231 finds no board files, and no state file for a sleeve that is still home-owned. It can never sell.
- **Shadow tree** (`/home/traids/w3-shadow/backend/data`, never pulled): the dry runs of the home-owned units read stale or missing files.

## What the job does

The plan is a pure function of home's `backend/data/host-ownership.json` (`planCarry`):

- **Real tree:** a file is carried from home when its owner is home-owned and at least one of its readers is server-owned. A file whose owner is server-owned is never written into the real tree.
- **Shadow tree:** a file is carried when a home-owned unit's shadow run reads it, including that unit's own state. The source is home when the owner is home-owned. Otherwise the file is copied on the VPS from the real tree, under the real tree's locks. A jsonl caught mid-append is dropped for that run (exit 3).
- **Board owner:** taken from the map's `w5-*` units. If none is named, the board is home. If all are on one side, it is that side. If they are mixed, only the board's two files are refused (exit 1); the state files are still carried.
- **Retired:** when both units and the board are server-owned, the job prints `RETIRED` and makes no ssh.

How each run works:

1. Home files are checked first. A state file must parse and have a coins table. A jsonl must have JSON on every line and end in a newline. A bad file is never pushed over the server's copy.
2. One read-only ssh fetches the sha256 of every target. Only files that differ are sent.
3. scp uploads them to temp names inside the target folder.
4. One ssh per tree, holding that tree's `w3-r191.flock` and `w3-r231.flock`, checks each temp's sha256, sets mode 0644 and renames it into place. Any leftover temp is removed.
5. If a lock is busy, nothing moves in that tree that run (exit 3). If a lock file cannot be opened, that is a fault (exit 1).
6. Just before each tree's upload, home's map is read again. If it changed since the plan (a cutover ran meanwhile), nothing moves in that tree (exit 1).

Each script stays under 5,000 characters. Switches (`r191-OFF`, `r231-OFF`, `*-HALT`) and locks are never carried. Every carry run, an early refusal included, writes its result to `backend/data/r191-r231-carry-status.json` (via `writeJsonAtomic`). scp is run from the temp file's own folder with the bare file name, so a Windows path is never read as `host:path`.

**Known limit:** when the board is server-owned, its jsonl files are copied into the shadow under the W3 units' locks, which the board does not take. A copy caught mid-append is dropped (no final newline), but a copy is not checked line by line. This is shadow-only and the next run corrects it.

## Checks (cloud, 2026-10-16)

- `node docs/r191-r231-carry-job/2026-10-16/selftest.cjs` → `ALL 48 CASES PASSED`. The job is handed a fake `ssh` and `scp` as functions (`node fake-ssh.cjs`), never through PATH. The fakes run the job's real bash scripts against a temp folder and contact no host. **Linux only:** on Windows it refuses before running anything (a PATH fake would be skipped there and the real ssh.exe found).
- Independent checker, cycle 1: 40/40 passed, 24 of 30 mutations caught, 10 defects (one critical: the PATH fakes on Windows). Every defect is fixed or documented below. The 8 missed or new mutations (chmod, move status, scp failure, home-side sha check, map re-check, SCRIPT_MAX, lock fault, ledgers) are now each caught.
- `node deploy.cjs --plan`, `node rollback.cjs --dry` and `node record.cjs --dry` on the real tree: the file shows as `base` (absent), nothing changes.

## What is missing from this clean copy (not reconstructed)

- `docs/server/wave3-sleeves/cell.cjs`, `deploy.cjs`, `home-patch.cjs`, `compare.cjs`, `register.cjs`, `vps/w3-run.cjs`, `vps/close-arm-runner-vps.cjs` and `deploy-server/w3-sync.cjs`. Two things below come from these missing files:
  - The lock file names `w3-r191.flock` and `w3-r231.flock` and the tree paths are taken from the headers of `manifests.cjs` and `units.cjs`. The real `C.lockOf()` and `C.TREE` are in the missing `cell.cjs`.
  - **Check at home:** whether `w3-sync.cjs` already carries any of these four files. If it does, drop that file from `FILES` here, or the two jobs will race.
- `docs/server/wave5-board/manifests.cjs`, which defines `MF.WAVE_UNITS`. The board's owner is therefore read from every `w5-*` unit in the map. Confirm at home that this matches W5's unit list.
- If `backend/package.json` is missing at home too, the status file cannot be written (a "note" line says so; the carry itself still runs).
- `backend/package.json`. The root package.json says `"type": "module"`, so `require("backend/lib/atomic-write.js")` fails in this copy. The selftest loads a temp copy of `atomic-write.js` marked commonjs. At home the real `backend/package.json` is assumed to make it loadable.
- `package-lock.json`. `npm ci --ignore-scripts` refuses without it. This package uses only Node built-ins.

## Operator steps at home

1. Do **not** run the selftest on the Windows home PC; it refuses there by design. It has been run in the cloud copy. It can be re-run on any Linux box with Node 22+ (a scratch copy of this folder plus `backend/lib/atomic-write.js`); no network is needed.
2. `node docs/r191-r231-carry-job/2026-10-16/deploy.cjs --plan`, then `--apply`.
3. `node docs/r191-r231-carry-job/2026-10-16/record.cjs --dry` and enter the record with the home recorder.
4. `node deploy/server/r191-r231-carry.cjs --plan` (no ssh), then `--dry` (one read-only ssh).
5. Schedule `node deploy/server/r191-r231-carry.cjs` as a home task (same principal as TRAIDS Market Close, which can already reach `traids`). It must run:
   - after home's R191 and R231 runs and the board mirror's last fire of the evening,
   - before the VPS's `traids-w3-after` and `traids-w3s-after` timers. Their times are in `cell.cjs` `SERVICES.after.calendar`, which is missing here.
   Running it again just before those timers is harmless: unchanged files are not sent.
6. Exit 3 is a WARN: a lock was busy or a shadow copy was dropped, and the files are carried on the next run. Exit 1 needs a look, with the reason last on stderr.
7. Once the map gives `w3-r191`, `w3-r231` and every `w5-*` unit to the server, the job prints `RETIRED`. Remove its schedule then.

Rollback: `node docs/r191-r231-carry-job/2026-10-16/rollback.cjs` removes the file, but only if it still has the staged bytes. Also remove the schedule. Files already carried to the VPS stay there; they are inputs only, and nothing on the VPS writes them while their owner is home-owned.
