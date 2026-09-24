# Solana Trader Bot — Phase 2: Paper Trading

Standalone TypeScript/Node service that discovers new Solana tokens from DexScreener,
scores and selects candidates, opens and manages **virtual (paper) positions**, and
tracks everything for analysis. See `SPEC.md` for the full build spec.

**No code in this project signs or sends a transaction.** `MODE=live` is refused at
startup (Phase 3 hasn't been built), and there's a standing test
(`test/safety/noSendPath.test.ts`) that scans `src/` for the vocabulary of
signing/sending a transaction and fails the build if any of it ever shows up before
Phase 3 is deliberately built.

## What Phase 2 adds on top of Phase 1

- Entry gate checks 5-8 (momentum, buy pressure, mint safety via RPC, holder
  concentration via RPC) — a mint that clears all 8 becomes **READY**.
- Scoring (`src/selection/score.ts`) and slot filling (`src/selection/index.ts`):
  ranks READY mints, checks sellability and entry drift through Jupiter's entry lane,
  and opens paper positions.
- The virtual wallet, paper entry/exit fills (latency + slippage + fee, per section 7).
- The exit state machine (`src/monitor/stateMachine.ts`, pure and fully unit-tested)
  and the position monitor that polls it every `POLL_SECONDS` through Jupiter's exit
  lane, concurrently across positions so one position's fill latency never delays
  polling the others.
- Risk blockers (kill switch, daily loss, loss streak, error halt, slots) and controls
  (`KILL` file or `/killswitch`, `/pause`, `/resume`). The kill switch runs on its own
  timer, independent of whether an entry is being attempted, so it still closes
  everything even with every slot full.
- Shadow positions, skip tracking, and post-exit tracking — all DexScreener-only, never
  Jupiter.
- The full digest (trades closed, open positions, trading-day stats, risk, the
  complete funnel), `npm run report` / `/report` with the go-live checklist.

## Requirements

- Node 24 LTS (Node 22 also works — checked as part of `engines` in `package.json`).
- No native build tools required on Windows or Linux. `better-sqlite3` ships prebuilt
  N-API binaries; `tsx`/`vitest` ship prebuilt `esbuild` binaries.

## Setup

```sh
npm install
cp .env.example .env
```

Then fill in `.env` yourself (this project never creates `.env` or asks for your keys):

- `SOLANA_RPC_URL` — a keyed RPC provider URL (e.g. Helius's free plan).
- `JUPITER_API_KEY` — Jupiter's free API key (1 request/second).
- `TRADER_TELEGRAM_BOT_TOKEN` / `TRADER_TELEGRAM_CHAT_ID` — a dedicated bot and chat
  for this project.
- Leave `WALLET_PRIVATE_KEY` and `LIVE_ACK` empty — `MODE=live` isn't supported until
  Phase 3 and startup refuses to run with a non-empty wallet key in paper mode.

Every other value in `.env.example` already matches `SPEC.md`'s defaults; tune only
what you need to.

## Run

```sh
npm start
```

Runs `src/index.ts` directly via `tsx` (no build step). `Ctrl+C` (SIGINT) or SIGTERM
shuts it down cleanly. Logs go to the console (JSON) and to `logs/trader-*.log` (daily
rotation), both with secrets redacted.

**Phase 2 "done" per `SPEC.md`**: `npm test` passes (below), and a short paper run
against real APIs opens and closes at least one virtual position, sends a digest, and
`npm run report` produces output. That real-API run is on you to do with your own
keys.

## Report

```sh
npm run report                                  # everything
npm run report -- --mode paper --from 2026-01-01 --to 2026-01-31
```

Same output as the `/report` Telegram command: totals, breakdowns by exit reason and
trading day, score-quintile and entry-feature results, score-component correlations,
shadow comparisons, "exited too early," skip-reason stats, and the go-live checklist
(paper trades only).

## Test

```sh
npm test        # vitest run — all tests use mocked network, no real API calls
npm run typecheck
```

Tests cover every pure module by hand (the exit state machine's full section-8.3
bullet list including the stop-loss confirm/liquidity-double-count fix, the entry
gate's 8 checks, scoring, the Jupiter two-lane budget, risk blockers including the
kill switch's independence from entry attempts, paper fills, shadow cost math, and
report math including the go-live checklist on hand-checked datasets), plus SQLite
migrations/storage, secret redaction, and the digest/commands/report-formatting
builders.

## pm2 process management

[pm2](https://pm2.keymetrics.io/) keeps the bot running and restarts it on crash.

```sh
npm install -g pm2
pm2 start src/index.ts --name trader --node-args="--import tsx/esm"
pm2 logs trader
pm2 stop trader
```

`pm2 start "npx tsx src/index.ts"` (or passing `npx` as the script) does **not** work on
Windows — pm2 tries to run the `.cmd` shim through Node's module loader and fails with
`SyntaxError: Unexpected token ':'`. The form above runs `node --import tsx/esm
src/index.ts` directly, in one process, which pm2 can track cleanly.

**After editing `.env`, run `pm2 restart trader`** — pm2 does not reload environment
files on its own; the running process keeps whatever values it started with.

### Linux: start on boot

```sh
pm2 startup            # prints a systemd command to run once, with sudo
pm2 save                # persists the current process list
```

After a reboot, systemd restarts pm2, which restarts `trader`.

### Windows: pm2's own startup command doesn't work

`pm2 startup`/`pm2-installer` targets Linux init systems (systemd, upstart) and
doesn't support Windows. Two working alternatives:

**Option A — Task Scheduler (no extra dependency):**

1. `pm2 save` after starting the process once, so pm2 remembers it (`pm2 resurrect`
   will bring it back).
2. Open Task Scheduler → Create Task:
   - Trigger: "At log on" (or "At startup" for a service account).
   - Action: run `pm2` (find its path with `where pm2` — usually inside your global
     npm prefix, e.g. `C:\Users\<you>\AppData\Roaming\npm\pm2.cmd`) with argument
     `resurrect`.
   - Under Settings, enable "Run whether user is logged on or not" if you want it to
     survive a logoff.

**Option B — [pm2-windows-startup](https://www.npmjs.com/package/pm2-windows-startup)**
(a small community package that registers pm2 as a Windows startup item):

```powershell
npm install -g pm2-windows-startup
pm2-startup install
pm2 save
```

Either way, verify it survives a real reboot before relying on it — `pm2 status`
after logging back in should still show `trader` as `online`.

**Both options start the bot at Windows *login*, not at boot.** Neither Task
Scheduler's "At log on" trigger nor `pm2-windows-startup` (a per-user Run-key entry)
runs before someone actually logs in. After a Windows Update reboot on an unattended
machine, `trader` stays stopped until a user logs in — there's no service-level
autostart here. If you need it to survive unattended reboots, run it as a proper
Windows Service (e.g. via [NSSM](https://nssm.cc/)) instead of through a login hook.

### Before a planned shutdown or restart

Don't just kill the process — an open position left mid-flight has no way to close
itself once the bot stops polling it.

1. Send `/pause` in Telegram. This stops new entries but leaves existing positions
   under normal management (SPEC.md section 9.2).
2. Wait until the digest (or `/status`) shows no open positions. Worst case this is
   `MAX_TOTAL_HOLD_MINUTES` (default 60) after the last entry, since every position
   is force-closed by then regardless of PnL.
3. Now it's safe to stop (`pm2 stop trader`) and shut down / reboot.
4. After restarting, send `/resume` — `/pause` is state persisted in `trader.db`, so
   the bot comes back up still paused until you clear it.

## Project layout

```
src/
  config/      env schema (zod), cross-field validation, HARD_MAX_POSITION_USD
  logger/      pino + daily-rotating file, secret redaction
  storage/     SQLite (better-sqlite3), versioned migrations, one store class per table
  limiters/    sliding-window limiter, the Jupiter exit/entry lane budget
  clients/     DexScreener, Jupiter (quotes only), Solana RPC (read-only), Telegram
  discovery/   profile polling, the pending queue, checks 1-8 orchestration
  gate/        entry gate checks 1-8 (pure functions)
  selection/   score (pure) and slot filling
  wallet/      virtual wallet (paper mode)
  executor/    paper entry/exit fills
  monitor/     the exit state machine (pure) and the position poll loop
  risk/        entry blockers, kill switch, loss-streak/daily-loss accounting (pure)
  tracking/    shadow positions, skip tracking, post-exit tracking
  report/      report math (pure) + go-live checklist + CLI
  solPrice/    SOL/USD tracker
  notify/      digest, urgent messages, outage tracking, Telegram commands
  index.ts     composition root (npm start)
test/          mirrors src/, one file per module
```

## Notes on library choices

- **No Solana SDK yet.** Phases 1-2 only ever make four read-only JSON-RPC calls and
  Jupiter quotes (no swap execution), so the RPC and Jupiter clients are thin `fetch`
  wrappers rather than `@solana/web3.js` or `@solana/kit`. `@solana/kit` (the modern,
  actively-recommended SDK) is planned for Phase 3 when transaction building/signing
  is needed.
- **`better-sqlite3` over `node:sqlite`**: `node:sqlite` is still a release candidate
  as of Node 24; `better-sqlite3` v13 is N-API-based (portable prebuilt binaries
  across Node versions) and more mature for versioned migrations.
- **No Telegram/Jupiter/Solana SDK dependency**: all four external services are called
  directly over `fetch`.
