# Options mirror to the BOOK account — staged package, 2026-10-16

This package was built in a cloud session and has not been applied anywhere. It sends no orders and makes no broker calls: the selftest runs against a fake broker held in memory. The only environment values it contains are variable **names**. There are no keys and no account numbers in it.

## Task

The board's options mirror copies the board's options tickets to an Alpaca paper account. It moves from the **main** paper account to the **BOOK** paper account. A guard makes sure it can only ever trade the BOOK account, and only options:

- any order that is not an option order is refused;
- if the account the broker reports is not the BOOK account, the guard refuses.

Nothing else moves in this task.

## What is in this package

| path | what |
|---|---|
| `staged/backend/lib/book-options-guard.js` | **new**: `makeBookOptionsGuard({ env, fetchImpl })` returns `{ request(method, path, body), verifyAccount(), describe() }`. Also exports `checkOptionOrder`, `isOptionOrderRecord`, `isOccSymbol` and `GuardRefusal`. |
| `base/backend/lib/book-options-guard.js.absent` | marker: the file does not exist live, so rollback removes it |
| `deploy.cjs --plan / --apply`, `rollback.cjs --plan / --rollback` | refuse when a live file matches neither base nor staged (drift), and refuse on trading weekdays 05:30–16:00 MT |
| `record.cjs --dry` / `--restarted YYYY-MM-DD --apply` | one change-registry row, `breaksComparability: true`, dated to the first session the mirror runs on BOOK. Refuses 13:50–15:50 MT on trading days. |
| `selftest.cjs` | 85 checks on a fake broker. Ends `SELFTEST PASSED (85 checks)`. |

### Environment variable NAMES (the values are set at home only)

- `ALPACA_BOOK_KEY_ID`, `ALPACA_BOOK_SECRET_KEY`: the BOOK keys. These names already exist and are used by `book-etf-rebalancer.js`, `planE-paper-scoreboard.js` and `alpaca-accounts-status.js`.
- `ALPACA_BOOK_ACCOUNT_NUMBER`: **new**. It holds the BOOK paper account's number (it starts with "PA"). The guard compares it with `account_number` from `GET /v2/account` before every write. **Set it in home's `backend/.env` before the wiring edit.** If it is unset, the guard refuses everything.

### What the guard allows

| call | rule |
|---|---|
| keys | BOOK env names only, with no fallback. If the BOOK key id equals `ALPACA_KEY_ID` (main) or `ALPACA_TV_KEY_ID`, the guard refuses. |
| host | `https://paper-api.alpaca.markets` only |
| before every write | `GET /v2/account`. The reported `account_number` must equal `ALPACA_BOOK_ACCOUNT_NUMBER` and start with "PA". If the read fails, the guard refuses (fail closed). |
| paths | Canonical only: `/v2/` followed by plain segments of letters, digits, `.`, `_` or `-`. No `%`, no backslash, no `.` or `..` segment, and a query only on GETs and on position closes (`qty=<whole>`). Every write is sent to a path **rebuilt** from the validated id or OCC symbol, never to the caller's string. |
| bodies | serialized **once**. The checked text is the text sent, so a `toJSON` method, a getter or an inherited field cannot change what goes out. |
| `POST /v2/orders` | Allowed: a single-leg OCC option symbol, or `order_class:"mleg"` whose every leg (1–4) is an OCC symbol; whole contracts. Refused: notional orders, bracket/oco/oto orders, and any stock or ETF symbol. |
| `DELETE` / `PATCH /v2/orders/{id}` | Only after `GET /v2/orders/{id}` shows an option order. The BOOK account also holds Plan E's ETF orders, and the mirror can never cancel or replace them. A PATCH may not change symbol, side, legs, notional or class. |
| `DELETE /v2/positions/{OCC}`, `POST /v2/positions/{OCC}/exercise` and `/do-not-exercise` | option symbols only; no `percentage` close |
| everything else that writes | refused, including cancel-all (`DELETE /v2/orders`) and close-all (`DELETE /v2/positions`) |
| `GET /v2/...` | passes. Reads change nothing. |

Errors name env variables, never key values. The account number appears only as its last four characters.

## MISSING FROM THE CLOUD COPY — the mirror is not wired in

**`backend/alpaca-options-mirror.js` is not in this copy.** It is named in `backend/profit-program/options-mirror-costs.js:4`, along with its `--close-day`, `--nta-sweep` and `BRIDGE_SWEEP_ROOTS`. Following the house rule, it was **not reconstructed**. So the mirror's own account switch, meaning the edit that changes it from `ALPACA_KEY_ID`/`ALPACA_SECRET_KEY` to the BOOK names, has to be done at home.

Until that edit is made, deploying this package installs a module that **nothing calls**. It is inert. The mirror keeps trading the main account.

### The edit owed at home, in `backend/alpaca-options-mirror.js`

1. Remove every place the mirror builds Alpaca headers from `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY`, and every direct `fetch` to Alpaca.
2. Create one guard at start-up and send **every** broker call through it:
   ```js
   const { makeBookOptionsGuard } = require("./lib/book-options-guard.js");
   const broker = makeBookOptionsGuard();                   // throws GuardRefusal if the BOOK names or the pin are missing
   const api = (method, path, body) => broker.request(method, path, body);
   ```
   A `GuardRefusal` (`e.refused === true`, `e.code`) must stop the run and alert through `backend/notify.js`. It must never be retried against another account.
   A broker error that is not a refusal, such as a 403 or 422 on a write, arrives as a plain `Error` with `e.status`. Handle it as the mirror handles broker errors today: log it and alert. Never fall back to another account.
3. Check afterwards: `grep -n "ALPACA_KEY_ID\|ALPACA_SECRET_KEY\|api.alpaca.markets\|fetch(" backend/alpaca-options-mirror.js` should return nothing except market-data reads, if the mirror has any. Market data uses `data.alpaca.markets`, does not trade, and is not covered by this task. If those reads use the main keys, they can stay.

## Operator decisions needed BEFORE the wiring edit

1. **The `--nta-sweep` will be refused.** According to options-mirror-costs.js, after a wing finishes between its strikes and the short leg is assigned, the mirror sweeps the leftover **shares** at the next open with a stock order. The spec says "refuse any non-option order", so the guard refuses that sweep. Assigned shares would then stay in the BOOK account until handled by hand. The options:
   - (a) keep it that way and handle assignments by hand;
   - (b) allow one narrowly defined stock order: a sell, or a buy-to-cover, of exactly the assigned quantity, with a client id prefix that belongs only to the mirror. This would widen the spec, so the operator has to decide;
   - (c) close the wings before expiry, which is what `--close-day` already does for in-the-money wings.

   Under (a) or (c), **switch `--nta-sweep` off in the mirror**. If it still runs through the guard, every sweep becomes a `GuardRefusal`, which stops the run and sends an alert.
2. **The BOOK account is shared with Plan E's ETF book.**
   - `book-etf-rebalancer.js` limits its buys to 0.85 × the account's `buying_power`, so the mirror's option margin reduces Plan E's buying power.
   - `planE-paper-scoreboard.js` already leaves out orders without a `book-` client id, and positions that are not Plan E symbols. Mirror orders must never use a `book-` client id prefix.
   - Assigned shares in a Plan E symbol would sit next to Plan E's holdings in the broker's position for that symbol. SPY is already left out of the mirror.
3. **Comparability.** Mirror fills before the switch are on the main account and fills after it are on BOOK. `alpaca-accounts-status.js` will show the options activity moving from "main (board mirror)" to "BOOK". The change-registry row says this.
4. **The mirror's reads of BOOK include Plan E.** On the BOOK account, `GET /v2/positions`, `/v2/orders` and `/v2/account` (equity and buying power) also show Plan E's ETF book. Any reconciliation, sizing or assigned-share detection in the mirror must filter by OCC symbol, or by the mirror's own client-id prefix. Otherwise it could treat Plan E's shares as its own. Confirm this when making the edit.
5. **Exercise and do-not-exercise are allowed** on option positions. Exercising creates shares in BOOK, and the guard will not let the mirror sell those shares afterwards (decision 1). Decide whether the mirror may exercise at all. Removing those two routes from the guard is a two-line change.
6. **The BOOK account's options trading level** must allow multi-leg spreads (level 3 on Alpaca). Check it on the account page at home before the switch. The guard does not check the level.
7. **Open option positions on the main account at switch time** stay there. The mirror on BOOK will not see them, and the guard will not touch the main account. Either close them before the switch or let them expire. Check with `alpaca-accounts-status.js` at home.

## Order of work at home

1. Set `ALPACA_BOOK_ACCOUNT_NUMBER` in `backend/.env`.
2. Run `deploy.cjs --plan`, then `deploy.cjs --apply` (after 16:00 MT, or on a non-trading day).
3. Make the mirror edit above and run `node --check backend/alpaca-options-mirror.js`.
4. Run the mirror once in its dry or plan mode, if it has one. It must print the guard's `describe()` and make no write.
5. After its first live session on BOOK: run `record.cjs --restarted <that date> --dry`, then the same with `--apply` after 15:50 MT.

## Cloud-only note

The root `package.json` is `"type": "module"` and this copy has no `backend/package.json`, so the scripts load backend files through `loadcjs.cjs`. `npm ci` cannot run here because there is no lockfile. No npm dependency is needed.

## Checks run here

- `node docs/options-to-book-account/2026-10-16/selftest.cjs` → `SELFTEST PASSED (85 checks)`
- `node --check` on every script; `deploy.cjs --plan` reads `base` (new file)
