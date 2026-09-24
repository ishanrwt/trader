# Solana Trader Bot — Phase 1: Foundation and Discovery

Standalone TypeScript/Node service that discovers new Solana tokens from DexScreener and
tracks them through a pending queue. **Phase 1 makes no trading decisions**: it does not
score, select, buy, sell, or send any transaction. See `SPEC.md` for the full build spec
and `SPEC.md` section 15 for what each phase covers.

Full trading behavior (scoring, paper/live positions, exits) is Phase 2 and Phase 3 and
has not been built yet.

## What Phase 1 does

- Polls DexScreener's latest token profiles every `DISCOVERY_SECONDS` and queues new
  Solana mints.
- Rechecks every pending mint every `PENDING_RECHECK_SECONDS` against entry gate checks
  1-4 (duplicate, pair, liquidity, entry window). Checks 5-8 (momentum, buy pressure,
  mint safety, holders) need positions/trade history/RPC wiring that Phase 2 adds, so a
  mint that clears checks 1-4 simply stays "pending" and ages out normally — it never
  reaches "READY" in this phase.
- Tracks SOL/USD price from DexScreener every 5 minutes.
- Sends a Telegram digest every `DIGEST_INTERVAL_MINUTES` (funnel + health only; the
  READY/entered/score fields explicitly say "not yet implemented (Phase 2)").
- Sends an urgent Telegram message on startup/restart (with the downtime gap on a
  restart) and on a DexScreener outage lasting more than `OUTAGE_ALERT_MINUTES`.
- Responds to `/status`, `/pause`, `/resume` from the configured Telegram chat only.
- All external calls (DexScreener, Solana RPC, Jupiter, Telegram) go through a timeout,
  error handling, and a rate limiter. The Solana RPC and Jupiter clients are built and
  startup-validated in this phase but aren't called yet by any business logic — checks
  5-8, sellability quotes, and position monitoring are Phase 2.
- Every log line has secrets scrubbed out (API keys, the full Solana RPC URL, the full
  Telegram bot token) — even if they appear embedded inside a longer string like a URL
  or an error message.

## Requirements

- Node 24 LTS (Node 22 also works — checked as part of `engines` in `package.json`).
- No native build tools required on Windows or Linux. `better-sqlite3` ships prebuilt
  N-API binaries; `tsx`/`vitest` ship prebuilt `esbuild` binaries. Verified in this repo
  by installing and running on Windows without Visual Studio Build Tools.

## Setup

```sh
npm install
cp .env.example .env
```

Then fill in `.env` yourself (this project never creates `.env` or asks for your keys):

- `SOLANA_RPC_URL` — a keyed RPC provider URL (e.g. Helius's free plan). Read-only calls
  only in this phase.
- `JUPITER_API_KEY` — Jupiter's free API key (1 request/second). Not called yet in Phase
  1, but validated and rate-limited at startup.
- `TRADER_TELEGRAM_BOT_TOKEN` / `TRADER_TELEGRAM_CHAT_ID` — a dedicated bot and chat for
  this project (create a bot via @BotFather; get your chat id by messaging the bot and
  checking `https://api.telegram.org/bot<token>/getUpdates`).
- Leave `WALLET_PRIVATE_KEY` and `LIVE_ACK` empty — `MODE=live` isn't supported until
  Phase 3 and startup refuses to run with a non-empty wallet key in paper mode.

Every other value in `.env.example` already matches `SPEC.md`'s defaults; tune only what
you need to.

## Run

```sh
npm start
```

This runs `src/index.ts` directly via `tsx` (no separate build step). On startup it:

1. Loads and validates `.env` (refuses to start on any invalid value, and warns about
   unknown keys in `.env` that this app doesn't recognize).
2. Opens/migrates `trader.db` (SQLite, gitignored).
3. Sends a Telegram "started" (or "restarted", with the downtime gap) message if
   `URGENT_ALERTS=true`.
4. Starts the discovery loops, SOL price refresh, the digest loop, and the Telegram
   command poller. `Ctrl+C` (SIGINT) or SIGTERM shuts it down cleanly.

Logs go to the console (JSON) and to `logs/trader-*.log` (daily rotation), both with
secrets redacted.

**Phase 1 "done" per `SPEC.md`**: tests pass (below), and a one-hour run against real
APIs with `DIGEST_INTERVAL_MINUTES=10` produces digests with plausible funnel counts and
no crash. That real-API run is on you to do with your own keys — this project doesn't
run it for you.

## Test

```sh
npm test        # vitest run — all tests use mocked network, no real API calls
npm run typecheck
```

Tests cover: config validation (weights sum, the Jupiter budget math including
`AUTO_STRETCH_POLL`, the hard position cap, unknown-key detection), secret redaction (in
both a standalone scrubber and through the logger, including a failed Telegram request
and a failed RPC request logging no secrets), the sliding-window and Jupiter two-lane
rate limiters, SQLite migrations, the DexScreener pair-selection rule (including the
SOL/USD-specific case), entry gate checks 1-4, the discovery/pending-queue orchestration,
and the digest/commands/outage/startup-message builders.

## Project layout

```
src/
  config/      env schema (zod), cross-field validation, HARD_MAX_POSITION_USD
  logger/      pino + daily-rotating file, secret redaction
  storage/     SQLite (better-sqlite3), versioned migrations, state + events tables
  limiters/    sliding-window limiter, the Jupiter exit/entry lane budget
  clients/     DexScreener, Jupiter (quotes only), Solana RPC (read-only), Telegram
  discovery/   profile polling, the pending queue
  gate/        entry gate checks 1-4 (pure function)
  solPrice/    SOL/USD tracker
  notify/      digest, urgent messages, outage tracking, /status /pause /resume
  index.ts     composition root (npm start)
test/          mirrors src/, one file per module
```

## Notes on library choices

- **No Solana SDK yet.** Phase 1-2 only ever make four read-only JSON-RPC calls, so the
  RPC client is a thin `fetch` wrapper rather than `@solana/web3.js` or `@solana/kit`.
  `@solana/kit` (the modern, actively-recommended SDK) is planned for Phase 3 when
  transaction building/signing is needed.
- **`better-sqlite3` over `node:sqlite`**: `node:sqlite` is still a release candidate as
  of Node 24; `better-sqlite3` v13 is N-API-based (portable prebuilt binaries across Node
  versions) and more mature for versioned migrations.
- **No Telegram/Jupiter/Solana SDK dependency**: all four external services are called
  directly over `fetch`, since none of what Phase 1-2 needs justifies an extra
  dependency.
