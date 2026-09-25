# Solana Trader Bot — Phase 3: Live Execution (paper by default)

Standalone TypeScript/Node service that discovers new Solana tokens from DexScreener,
scores and selects candidates, opens and manages positions, and tracks everything for
analysis. See `SPEC.md` for the full build spec; it is the single source of truth.

**The bot runs in paper mode unless you deliberately switch it to live.** `MODE`
defaults to `paper`, and paper mode never loads your key and never loads the live
module at all. Everything that signs or sends a transaction lives under `src/live/`,
which `src/index.ts` only imports (dynamically) when `MODE=live`. The standing test
`test/safety/noSendPath.test.ts` fails the build if signing or sending vocabulary ever
appears outside `src/live/`, or if anything imports `src/live/` statically.

## What Phase 3 adds on top of Phase 2

- Live swaps through Jupiter's Swap API V2 Router path (`GET /swap/v2/build`): the bot
  assembles, simulates, **verifies**, signs and sends every transaction itself through
  your RPC, with the priority fee capped at `MAX_PRIORITY_FEE_SOL` (SPEC.md 16.1-16.2).
- Real fills: cost basis and proceeds come from the confirmed transaction's balance
  changes, never the quote; fees and rent are converted to USD. Fees of transactions
  that fail on-chain are realized losses in daily loss and the report (16.3).
- Write-ahead intents, blockhash-expiry handling, and startup recovery: a buy or sell
  that landed while the bot was down is applied, never lost (16.4-16.5).
- Sell retries with slippage escalation, a stuck state with backoff, and a per-position
  fee budget (`/sellretry` grants more), full sells that close the token account (16.6).
- A SOL reserve for sell fees that entries never spend (16.7).
- `npm run smoke-live` (dry run by default) and graceful shutdown for pm2 on Windows.
- Per-mode accounting: paper and live never affect each other's limits, and the report
  prints them separately.

## Requirements

- Node 24 LTS (Node 22 also works).
- No native build tools required on Windows or Linux. `better-sqlite3` ships prebuilt
  N-API binaries; `tsx`/`vitest` ship prebuilt `esbuild` binaries; `@solana/kit` and
  `@solana-program/token` are pure JavaScript (Ed25519 via Node's WebCrypto).

## Setup

```sh
npm install
cp .env.example .env
```

**A new folder or git worktree has no `.env`** (it's gitignored and never committed).
Create it yourself from `.env.example` in every folder you run the bot from. This project
never creates `.env` and never asks for your keys.

- `SOLANA_RPC_URL` — a keyed RPC provider URL. Defaults assume Helius's free plan (10
  requests/s overall, `sendTransaction` 1/s); set `RPC_MAX_RPS` / `RPC_SEND_MAX_RPS` for
  another provider.
- `JUPITER_API_KEY` — Jupiter's free API key (60 requests/min).
- `TRADER_TELEGRAM_BOT_TOKEN` / `TRADER_TELEGRAM_CHAT_ID` — a dedicated bot and chat.
- Paper mode: leave `WALLET_PRIVATE_KEY` and `LIVE_ACK` empty (startup refuses a key in
  paper mode).

## Run

```sh
npm start
```

`Ctrl+C` (SIGINT), SIGTERM (Linux), or pm2's `shutdown` message (Windows) shut it down
**gracefully**: new entries and sell attempts stop, any in-flight transaction is waited
for until it confirms, fails or its blockhash expires (at most 120 s), state is saved,
then the process exits. Open positions resume on the next start. Logs go to the console
(JSON) and `logs/trader-*.log` (daily rotation), with secrets redacted.

## Going live

Live mode is your decision alone (SPEC.md section 15). It doesn't require the paper
go-live checklist to pass: if the checklist isn't met, live startup logs a warning and
sends a Telegram message, then continues.

1. **Use a fresh wallet with limited funds.** Create a new account in Phantom or
   Solflare just for this bot. Put in only what you're prepared to lose: some USDC for
   positions plus a little SOL for fees (keep SOL above `MIN_SOL_BALANCE`, 0.05 by
   default). Never use a wallet that holds anything else.
2. **Export its private key** (see below) and put it in `.env` yourself as
   `WALLET_PRIVATE_KEY=...`, in the live folder only.
3. Set `MODE=live` and `LIVE_ACK=I_ACCEPT_REAL_LOSSES` exactly. Keep `POSITION_USD`
   small; it can never exceed `HARD_MAX_POSITION_USD` (100, a code constant).
4. **Stop the paper bot first** if it runs from another folder (see smoke-live below),
   then run `npm run smoke-live` (dry run) and read its output.
5. Optionally `npm run smoke-live -- --send` for a real $1 round trip.
6. Start the bot (`npm start`, or pm2 below). Startup logs only the wallet's public
   address.

### The private key format

`WALLET_PRIVATE_KEY` accepts either:

- a **base58 string** of the 64-byte secret key, or
- a **JSON array of 64 numbers**, like the contents of a `solana-keygen` key file.

Anything else refuses to start with a message that never echoes the value. The key is
decoded into a non-extractable signing key, the raw bytes are zeroed, and the variable
is removed from the process environment. Every encoding of the key (base58, JSON array,
comma/space-separated bytes, base64, base64url, hex) is scrubbed from logs, errors,
stack traces and Telegram messages.

**Exporting it:**

- **Phantom:** Settings → select the account → *Show Private Key* (or *Export Private
  Key*) → choose Solana → enter your password → copy. Phantom's own help page didn't
  render when this was written, so **the fact that Phantom exports a base58 string
  comes from third-party sources, not Phantom's documentation.** Either way the bot
  accepts it if it's base58 or a 64-number JSON array.
- **Solflare (mobile, per Solflare's help center):** account switcher on the portfolio
  tab → *Edit* → the three-dots menu on the account → *Export Private Key*. Solflare's
  help doesn't say which format it shows; the bot accepts base58 or a 64-number array.

Paste it into `.env` yourself. Never send it to anyone, and never commit `.env`.

### smoke-live: dry run vs `--send`

`npm run smoke-live` runs only from a folder configured for live (`MODE=live`,
`LIVE_ACK`, a valid key), and touches only USDC and SOL. It never creates positions or
trades.

- **`npm run smoke-live`** (default, **dry run**): builds the $1 USDC → SOL leg and the
  SOL → USDC leg, simulates and verifies both exactly as live trading would, and prints
  the verification result, the balance source (`simulation`, or `fallback` if your RPC
  omits simulation balance fields), and each leg's fee. **Nothing is sent**: the dry
  run has no send permit at all.
- **`npm run smoke-live -- --send`**: prints the public address, amounts and maximum
  fees, then asks you to type `send 1 usdc` in an interactive terminal. It then swaps $1
  USDC → SOL, confirms it, sells exactly the SOL actually received back to USDC, and
  prints the full accounting (USDC in/out, each fee in SOL and USD, net cost).

It refuses if this folder's database heartbeat is less than 2 minutes old (a bot
running from **this** folder). **It can't see a bot running from another folder, so
stop the paper bot first** (`pm2 stop trader`, or `Ctrl+C`), then run smoke-live.

### Switching between paper and live

The bot refuses to start while positions or unresolved transaction intents of the
**other** mode exist, and lists them:

- **Paper → live:** let the paper positions close (or use the kill switch in paper
  mode), then switch.
- **Live → paper:** only after every live position is closed and every intent is
  resolved. A live position must never be left unmanaged.

Paper and live trades share the database but never each other's daily-loss, loss-streak
or trading-day figures, and `npm run report` prints a separate PAPER and LIVE section.

### Live commands

`/sellretry <mint prefix>` (configured chat only): when a position's sell fee budget is
used up, the bot stops sending and only reads its balance. This grants one more
`SELL_FEE_BUDGET_SOL` and resumes attempts on the backoff schedule. The prefix must
match exactly one stuck live position. If you sell it manually instead, the bot sees
the empty balance and closes it as `reconciled` (proceeds recorded as 0 and flagged
`proceeds_unknown`, shown separately in the report and digest).

## Report

```sh
npm run report                                  # PAPER and LIVE sections, never mixed
npm run report -- --mode live --from 2026-01-01 --to 2026-01-31
npm run report -- --trades                      # per-trade detail instead of aggregates
```

`/report` shows the current mode. Totals, breakdowns by exit reason and trading day,
score quintiles, component correlations, skip-reason stats and the go-live checklist
(paper trades, information only). Live sections add fee losses from failed transactions
(in the total and drawdown) and list `proceeds_unknown` trades separately. `--trades`
prints every field section 11.1 stores, including live signatures, raw amounts, fees and
rent.

## Test

```sh
npm test        # vitest run — all tests use mocked network, no real API calls
npm run typecheck
```

Live execution is tested end to end against an in-memory fake chain that decodes the
exact bytes the bot builds (`test/helpers/fakeChain.ts`): buys, sells, verification
refusals for every check, the simulation fallback, expiry, intents and recovery,
reconciliation, the fee budget, token-account closing under Token and Token-2022,
smoke-live, graceful shutdown, and key redaction in every encoding.

## pm2 process management

[pm2](https://pm2.keymetrics.io/) keeps the bot running and restarts it on crash. Phase
3 ships `ecosystem.config.cjs`:

- `shutdown_with_message: true` — on Windows `pm2 stop` delivers no signal, so pm2
  sends a `shutdown` message instead, which the bot handles like `Ctrl+C`.
- `kill_timeout: 150000` — above the bot's 120-second shutdown bound, so pm2 never
  kills it while it waits for a transaction to confirm or expire.

### Switching the running process to the ecosystem file

`pm2 restart` does not pick up `shutdown_with_message` or `kill_timeout` for a process
that was started from the command line, so delete it and start it from the file, from
the bot's folder (e.g. `C:\trends\trader`):

```sh
pm2 delete trader
pm2 start ecosystem.config.cjs
pm2 save
```

`pm2 delete` stops the old process first. The build it's currently running has no
`shutdown` handler, so that one stop is abrupt; in paper mode nothing is lost (open
positions resume on the next start). From then on `pm2 stop trader` / `pm2 restart
trader` shut down gracefully. `pm2 save` keeps `pm2 resurrect` (Task Scheduler, below)
working.

```sh
pm2 logs trader
pm2 stop trader
```

**After editing `.env`, run `pm2 restart trader`** — pm2 does not reload environment
files on its own.

### Linux: start on boot

```sh
pm2 startup            # prints a systemd command to run once, with sudo
pm2 save                # persists the current process list
```

### Windows: pm2's own startup command doesn't work

`pm2 startup` targets Linux init systems and doesn't support Windows. Two working
alternatives:

**Option A — Task Scheduler (no extra dependency):**

1. `pm2 save` after starting the process once, so pm2 remembers it.
2. Open Task Scheduler → Create Task:
   - Trigger: "At log on" (or "At startup" for a service account).
   - Action: run `pm2` (find its path with `where pm2` — usually inside your global
     npm prefix, e.g. `C:\Users\<you>\AppData\Roaming\npm\pm2.cmd`) with argument
     `resurrect`.
   - Under Settings, enable "Run whether user is logged on or not" if you want it to
     survive a logoff.

**Option B — [pm2-windows-startup](https://www.npmjs.com/package/pm2-windows-startup):**

```powershell
npm install -g pm2-windows-startup
pm2-startup install
pm2 save
```

**Both options start the bot at Windows *login*, not at boot.** After an unattended
reboot, `trader` stays stopped until someone logs in. For a real service, run it as a
Windows Service (e.g. via [NSSM](https://nssm.cc/)).

### Before a planned shutdown or restart

`pm2 stop trader` (with the ecosystem file) or `Ctrl+C` now shuts down gracefully:
in-flight transactions are waited for and open positions resume on the next start. If
you'd rather have no open positions across a long downtime: send `/pause`, wait until
`/status` shows none (at most `MAX_TOTAL_HOLD_MINUTES` after the last entry), stop the
bot, and send `/resume` after restarting (`/pause` persists).

## Project layout

```
src/
  config/      env schema (zod), cross-field and live validation, HARD_MAX_POSITION_USD
  encoding/    base58 and wallet-key decoding/redaction variants (no Solana SDK)
  logger/      pino + daily-rotating file, secret redaction (literals, patterns, bytes)
  storage/     SQLite (better-sqlite3), versioned migrations, one store per table
  limiters/    sliding-window limiter, Jupiter lanes, RPC transaction/read lanes
  clients/     DexScreener, Jupiter (quotes + /swap/v2/build), Solana RPC (read-only), Telegram
  discovery/   profile polling, the pending queue, checks 1-8 orchestration
  gate/        entry gate checks 1-8 (pure functions)
  selection/   score (pure) and slot filling
  executor/    the TradeExecutor interface; paper entry/exit fills
  live/        EVERYTHING that signs or sends (loaded only in live mode / smoke-live):
               keys, assemble, verify, simulation + simFallback, pipeline, txRpc,
               confirm, fills, intents resolution, reconcile, sellPolicy, executor,
               runtime, smoke, smokeCli
  monitor/     the exit state machine (pure) and the position poll loop
  risk/        entry blockers, kill switch, per-mode daily loss and streaks (pure)
  startup/     the mode-switch guard
  tracking/    shadow positions, skip tracking, post-exit tracking
  report/      report math (pure) + go-live checklist + CLI
  notify/      digest, urgent messages, outage tracking, Telegram commands
  shutdown.ts  graceful shutdown (SIGINT, SIGTERM, pm2 'shutdown' message)
  index.ts     composition root (npm start)
ecosystem.config.cjs   pm2 process file
test/          mirrors src/; test/helpers has the fake chain and fixtures
```

## Notes on library choices

- **`@solana/kit` 8.3** builds, compiles, signs and decodes v0 transactions;
  **`@solana-program/token` 0.17** builds `closeAccount` (for Token-2022 too, by passing
  the Token-2022 program address; the instruction layout is identical and tested for
  both). All RPC calls go through this project's own client, so they pass through its
  rate limiters and redaction and can be mocked.
- **Jupiter `/swap/v2/build` over `/order` + `/execute`**: `/build` lets the bot verify
  the exact bytes it sends and cap the priority fee, and charges no Jupiter swap fee.
  `/order` lands better but can't be modified, lets Jupiter pick the fee, and charges a
  platform fee (50 bps on tokens under 24 hours old). Quotes stay on `/swap/v1/quote` in
  both modes so paper and live marks are comparable.
- **`better-sqlite3` over `node:sqlite`**: N-API prebuilt binaries, mature for
  versioned migrations.
