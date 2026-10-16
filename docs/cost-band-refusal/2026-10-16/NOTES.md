# Cost-band refusal — staged package, 2026-10-16

This package was built in a cloud session and has not been applied anywhere. It places no orders and makes no broker or network calls. It mints no test id: this is a cost control, not a registered test.

## Operator decision (2026-10-15)

New board stock tickets whose predicted round-trip cost (the stamped spread `obs.spreadBps`) is **30 to 100 bps** are refused at the entry POST. The refusal is a separate gate that sits beside R49; R49 already refuses anything above 100 bps. Each refused ticket is kept as a **shadow record**: the ticket's own shape, marked as refused by the cost band. Off switch: `backend/data/cost-band-OFF`. If the file is absent, the gate is on. The gate takes effect at the next board restart.

## What is in this package

| path | what |
|---|---|
| `staged/backend/lib/cost-band-gate.js` | **new** gate module. Exports `evaluate(ticket, opts)`, which returns `null` or `{test:"COSTBAND", veto, why}`. Also exports `toShadow(ticket, verdict, nowMs)`, `isOn`, `inScope`, `inBand`, and the constants. |
| `base/backend/lib/cost-band-gate.js.absent` | marker: the file does not exist live, so rollback removes it |
| `deploy.cjs --plan / --apply` | writes staged over base. Refuses if anything has drifted (a live file matches neither base nor staged). Also refuses on a trading weekday between 05:30 and 16:00 MT. |
| `rollback.cjs --plan / --rollback` | puts base back byte for byte, which here means removing the new file. Same refusals as deploy. |
| `record.cjs --dry` / `--restarted YYYY-MM-DD --apply` | one change-registry row, `breaksComparability: true`, dated at the restart. Refuses between 13:50 and 15:50 MT on trading days, and when the registry lock is held. Never adds the same row twice. |
| `selftest.cjs` | 60 checks on temp fixtures. Ends `SELFTEST PASSED (60 checks)`. |
| `pkg.cjs`, `files.cjs`, `loadcjs.cjs` | shared machinery for the scripts above |

### Rules the gate applies

- **Band:** 30 ≤ spreadBps ≤ 100, inclusive at both ends. At 100.01 the ticket is R49's to refuse, not this gate's.
- **In scope:** `cls === "Equity"` only. Controls (`ctrl`, `ctrlRand`), existing veto shadows and sleeve tickets (`sleeve` set) are out of scope.
  - Sleeve tickets are excluded on purpose, so that no sleeve's registered population moves. The operator's words were "board stock tickets". If sleeve stock tickets should be refused too, say so and this becomes a one-line change.
- **No usable stamp:** the ticket passes this gate. The STAMP gate owns that case.
- **Shadow:** `{...ticket, ctrl:true, vetoShadow:true, veto:"COSTBAND spread 30-100bps", vetoWhy, vetoAt, costBand:{loBps:30, hiBps:100, spreadBps}}`.
  - The veto string matches none of `/R49/`, `/R53/`, `/R28/` or STAMP. No registered reader counts it as its own shadow.
  - `alpaca-mirror.js` filters out `ctrl` and `vetoShadow`, so a shadow is never mirrored.
- **Off switch:** the file is checked on every call. Creating `backend/data/cost-band-OFF` turns the gate off from the next ticket, with no restart. Deleting it turns the gate back on.

## MISSING FROM THE CLOUD COPY — the gate is not wired in

These files do not exist in this copy, so they were **not reconstructed**:

- `backend/lib/enforcement-gates.js`: holds `evaluateGates()`, which runs the R49, R53 and STAMP gates, plus `STAMP_VETO`, `spreadStamp` and `groupTokens`.
- `backend/traids-server-v2.js`: the board server, where the `POST /api/board-positions` entry handler turns a gate veto into a shadow row.
- `backend/lib/risk-policy.js` and `backend/lib/cost-size.js`, which the handler uses.

Until the two wiring edits below are made at home, deploying this package installs a module that **nothing calls**. It is inert.

### The two wiring edits owed at home

1. **In `lib/enforcement-gates.js` `evaluateGates(ticket, live, now)`:** after every registered gate (R49, R53, STAMP) has returned no veto for the ticket, and only then, return the cost-band verdict:
   ```js
   const CB = require("./cost-band-gate.js");          // top of file
   // ... at the end of evaluateGates, where it would return null:
   return CB.evaluate(ticket);                          // null, or { test:"COSTBAND", veto, why }
   ```
   This order keeps every R49, R53 and STAMP refusal exactly as it is today.
2. **In the board POST handler:** a `COSTBAND` verdict must be turned into a shadow in the same way the handler already turns R49's verdict into one: same ledger, same `vetoAt`, same era and scanner stamp. If the handler turns vetoes into shadows generically by `veto` and `why`, nothing else is needed. If it does not, use `CB.toShadow(ticket, verdict, now)`. The dry-run path (`?dryRun=1`, `gateVetoes`) should list it as `test:"COSTBAND"`.

Order of work at home: make the two edits, then run `node --check` on both files, then `deploy.cjs --plan`, then `deploy.cjs --apply`. Restart the board server outside 06:45–14:15 MT. Then run `record.cjs --restarted <restart date> --dry`, and the same command with `--apply` after 15:50 MT.

## Registered tests — operator decision needed BEFORE --apply

The gate does not edit any registered test's rule, bar, population or read date. **But it changes what flows into them.** From the restart onward, board equity tickets at 30–100 bps become control rows (`ctrl:true`) instead of signal rows. Every reader of the board's non-control equity book loses that tail. In particular:

- **R49's KEPT arm** is "non-ctrl equity, spreadBps ≤ 100" (`backend/r49-spread-gate.js`). It would hold only tickets under 30 bps, and the 30–100 bps shadows sit in neither KEPT nor REFUSED. R49's cost difference D, which is UNGATED minus KEPT, is then computed on a different population from the restart on. R49 is still accruing (bar: 20 entry days and 150 tickets).
- Other registered tests whose text mentions board equity signals, spreads or veto shadows: R10, R18, R54 (sealed), R64, R67, R85, R86, R87, R107, R109, R172, R174, R177 (read), R304 (frozen) and R325. Many entries are redacted in this copy, so this list is a floor, not a full audit. Any test that twins or reads board equity signals sees fewer of them.

So the population change is real even though no test's code changes. The house rule says a registered test's population is never changed to make something pass. This change is not made to make anything pass, but it does move R49's measured population. **This is the operator's call.** Possible answers:

- (a) Accept it, record the change-registry row (`breaksComparability: true`), and note it at R49's read.
- (b) Exempt R49's window by waiting for R49's read before applying.
- (c) Something else.

The package records the row but does not decide the question.

## Cloud-only note

The root `package.json` here is `"type": "module"` and there is no `backend/package.json`, so `require()` of any backend `.js` fails in this copy. The home tree presumably has the CommonJS marker. The package scripts load backend files through `loadcjs.cjs`, which works in both trees. `npm ci` cannot run here because `package-lock.json` is not in the copy. Nothing in this package needs an npm dependency.

## Checks run here

- `node docs/cost-band-refusal/2026-10-16/selftest.cjs` → `SELFTEST PASSED (60 checks)`
- `node --check` on every script in the package
- `deploy.cjs --plan` → `base backend/lib/cost-band-gate.js (new file; base is absent)`
