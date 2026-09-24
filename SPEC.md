# Solana Trader Bot: Build Spec v1

Last updated: 2026-09-24. This file is the single source of truth for the trader bot. If anything here is ambiguous, contradicts itself, or doesn't match the current external docs, stop and ask instead of guessing.

## 0. Purpose and scope

A standalone TypeScript/Node program that:

1. discovers new Solana tokens from DexScreener,
2. filters and ranks them,
3. opens small positions (virtual in paper mode, real in live mode),
4. exits them by fixed rules,
5. records everything and sends a Telegram digest every 2 hours.

It is not part of the Cloudflare Worker in `../trends`. Never modify anything in `../trends`.

## 1. Ground rules for the coding agent

- Build one phase at a time (section 15). For each phase: read this spec, read the current external docs (section 3), present a plan, and wait for approval before writing code.
- Don't rely on memory for external APIs. Name the exact endpoints, parameters and libraries in your plan.
- Never ask for, print, log or commit secrets. Redact keys in logs and error messages, including the `api-key` query parameter inside `SOLANA_RPC_URL`.
- No code that signs or sends transactions before Phase 3. Never run live mode yourself.
- TypeScript in strict mode, Node 24 LTS (Node 22 must also work). Use libraries that install on Windows and Linux without native build tools, or confirm prebuilt binaries exist for both.
- The entry gate, the score and the exit state machine are pure functions with unit tests.
- Store timestamps as UTC epoch milliseconds. The "trading day" for daily limits and summaries is the calendar day in `TRADING_DAY_TZ`.
- Every external call has a timeout and error handling, and goes through its rate limiter. One failing token or call must never crash the process.
- Don't commit or push; the user does that.

## 2. Modules

- **config**: loads and validates `.env` (section 13); refuses to start on invalid values; warns on unknown keys.
- **logger**: console plus rotating file at `LOG_LEVEL`, with secret redaction.
- **storage**: SQLite with versioned migrations (section 12).
- **limiters**: DexScreener (profiles and pairs classes), Jupiter (two priority lanes, section 9.3), RPC.
- **clients**: DexScreener, Jupiter, Solana RPC, Telegram.
- **discovery**: profile polling and the pending queue (section 4).
- **gate**: entry checks (section 5).
- **selection**: scoring and slot filling (section 6).
- **wallet**: virtual wallet in paper mode; real wallet in live mode (Phase 3).
- **executor**: paper fills (Phase 2); live swaps (Phase 3).
- **monitor**: polls open positions and runs the exit state machine (section 8).
- **risk**: entry blockers, pauses, kill switch (section 9).
- **tracking**: shadow positions, skipped-token tracking, post-exit tracking (section 11).
- **notify**: digest, urgent alerts, commands (section 10).
- **report**: `npm run report` and `/report` (section 11.4).

## 3. External services

### DexScreener (no key)

- Latest token profiles: `GET https://api.dexscreener.com/token-profiles/latest/v1` (reported limit about 60 requests/min).
- Pair data for up to 30 tokens: `GET https://api.dexscreener.com/tokens/v1/solana/{addr1,addr2,...}` (reported limit about 300 requests/min).
- Verify both against the current docs. The sibling Worker repo (`../trends/src/index.js`) contains working DexScreener code you may read for reference; this spec wins where they differ.
- Our limiter stays under `DEX_PROFILES_MAX_PER_MIN` for profiles and `DEX_PAIRS_MAX_PER_MIN` for pair data (shared by discovery, liquidity checks, shadows and tracking). On a 429 or 5xx, back off with jitter.
- **Pair selection rule** (used everywhere a price or liquidity is needed for a mint): among a mint's pairs with `chainId` "solana" where `baseToken.address` equals that mint and `quoteToken.address` is in `ALLOWED_QUOTE_MINTS`, use the one with the highest `liquidity.usd`. Ignore all other pairs, including ones where the mint appears only as the quote token. DexScreener occasionally misprices pairs quoted against other tokens.

### Jupiter

- Free API key (`JUPITER_API_KEY`); the free plan allows 1 request per second. Read the current docs at developers.jup.ag and choose endpoints that support (a) quotes for arbitrary amounts without executing, and (b) in Phase 3, building or executing swaps.
- In your plan, state which endpoints you chose, which rate-limit buckets they use (some execute/submit endpoints may have separate buckets), and any fees they charge. Those fees must be included in PnL.

### Solana RPC

- `SOLANA_RPC_URL`, a keyed provider URL (for example Helius's free plan). Phases 1-2 only make read calls: `getAccountInfo` (jsonParsed), `getTokenLargestAccounts`, `getTokenSupply`, `getMultipleAccounts`. Limited by `RPC_MAX_RPS`.

### Telegram

- Its own bot and chat (`TRADER_TELEGRAM_BOT_TOKEN`, `TRADER_TELEGRAM_CHAT_ID`). Use `getUpdates` long polling (no inbound server). Ignore messages from any other chat.

### SOL/USD price

- Needed to convert SOL fees into USD. Refresh every 5 minutes from DexScreener, never from Jupiter. Apply the pair selection rule above with the mint fixed to wrapped SOL: `baseToken.address` = wrapped SOL, `quoteToken.address` = USDC or USDT (whichever pair has the highest `liquidity.usd`).

## 4. Discovery

- Every `DISCOVERY_SECONDS`: fetch the latest profiles, keep `chainId` "solana", skip mints already in `seen_mints`, and add new mints to `pending` (with `discoveredAt`) and to `seen_mints`. Cap `seen_mints` at `SEEN_MINTS_CAP`, trimming oldest first.
- Every `PENDING_RECHECK_SECONDS`: fetch pair data for all pending mints in batches of up to 30, run each through the entry gate (section 5), then run slot filling (section 6.2). Slot filling also runs right after every exit.
- A mint leaves `pending` when: it's bought; it fails a permanent gate check or the sellability check; its entry window expires; `MAX_PENDING_AGE_MIN` has passed since `discoveredAt`; or it had no valid pair for `MAX_NO_PAIR_CHECKS` consecutive checks.
- `REQUIRE_ANIMAL_THEME` is documented but not implemented (default false).

## 5. Entry gate

Checks run in this order. The first failure records `skipped: <reason>` silently (no Telegram). A **temporary** failure keeps the mint pending; a **permanent** failure removes it.

1. **Duplicate** (permanent): the mint is held now, or was traded before and `REENTRY_ENABLED=false`.
2. **Pair** (temporary): no valid pair under the pair selection rule. Increments `noPairChecks`.
3. **Liquidity** (temporary): `liquidity.usd < MIN_LIQUIDITY_USD`. The first time this passes, set `firstEligibleAt = now`.
4. **Entry window** (permanent): `now − firstEligibleAt > ENTRY_WINDOW_MIN`.
5. **Momentum** (temporary): `priceChange.m5 > MIN_M5_CHANGE_PCT`, `h1 > MIN_H1_CHANGE_PCT`, `h24 > MIN_H24_CHANGE_PCT`; if `MAX_H1_CHANGE_PCT > 0`, also `h1 ≤ MAX_H1_CHANGE_PCT`. Missing fields fail.
6. **Buy pressure** (temporary): m5 buys + sells ≥ `MIN_M5_TXNS`; buys ≥ `MIN_M5_BUY_SELL_RATIO` × sells; `volume.m5 ≥ MIN_M5_VOLUME_USD`.
7. **Mint safety** (permanent; cached per mint): `getAccountInfo` (jsonParsed). If `REQUIRE_MINT_REVOKED`, `mintAuthority` must be null. If `REQUIRE_FREEZE_REVOKED`, `freezeAuthority` must be null. The owner must be the SPL Token or Token-2022 program. For Token-2022, only these extensions are allowed: `metadataPointer`, `tokenMetadata`, `groupPointer`, `groupMemberPointer`, `tokenGroup`, `tokenGroupMember`. Any other extension fails.
8. **Holders** (temporary; cached `HOLDERS_CACHE_MIN`): `getTokenLargestAccounts` + `getTokenSupply`. Exclude any account whose balance is within 2% of the `liquidity.base` of any of the mint's valid pairs (pool vaults), and known burn/incinerator addresses. Require top-1 share ≤ `MAX_TOP1_PCT` and top-10 share ≤ `MAX_TOP10_PCT`.

A mint whose latest evaluation passed all 8 checks is **READY** (section 6). READY mints stay in the pending loop, so their data and gate result refresh every cycle, and a READY mint that fails a temporary check goes back to plain pending. Slots and entry blockers are checked at selection time, not in the gate.

## 6. Selection

### 6.1 Score (pure function, 0 to 1)

Each component is clipped to 0..1:

- `buyPressure = buys_m5 / (buys_m5 + sells_m5)`
- `activity = min(volume_m5 / liquidity_usd / ACTIVITY_CAP, 1)`
- `momentum = clip((m5 + h1) / 2, 0, MOMENTUM_CAP_PCT) / MOMENTUM_CAP_PCT`
- `depth = (log10(liquidity_usd) − log10(MIN_LIQUIDITY_USD)) / (log10(DEPTH_CAP_USD) − log10(MIN_LIQUIDITY_USD))`
- `holders = (MAX_TOP10_PCT − top10Pct) / MAX_TOP10_PCT`
- `freshness = 1 − minutesSinceEligible / ENTRY_WINDOW_MIN`

`score = W_BUY_PRESSURE·buyPressure + W_ACTIVITY·activity + W_MOMENTUM·momentum + W_DEPTH·depth + W_HOLDERS·holders + W_FRESHNESS·freshness`

The weights must sum to 1.0 (±0.01, validated at startup). Store every component with the candidate, its shadow, and its trade.

### 6.2 Slot filling

While open positions < `MAX_CONCURRENT` and no entry blocker is active (section 9.1):

1. Take the READY mint with the highest score that is ≥ `MIN_SCORE` (tie-break: earlier `firstEligibleAt`). Skip mints with an entry already in flight.
2. **Sellability** (Jupiter entry lane; result cached per mint for 10 minutes): quote USDC→token for the position size, then token→USDC for the quoted token amount. Require the round-trip output ≥ (1 − `MAX_ROUNDTRIP_LOSS_PCT`/100) × input. Failure is permanent (`unsellable`); move to the next mint.
3. **Drift**: get the execution quote. Implied entry price = size / tokensOut. If it exceeds DexScreener `priceUsd` × (1 + `MAX_ENTRY_DRIFT_PCT`/100), skip (`drift`, temporary: the mint stays READY until its window expires).
4. Open the position (section 7).

Never close an open position to make room for a candidate.

## 7. Opening positions and fills

- Size = min(`POSITION_USD`, liquidity_usd × `MAX_POSITION_PCT_OF_LIQ`/100).
- Wallet check: available USDC ≥ size. Paper mode uses a virtual wallet seeded with `PAPER_STARTING_USDC` and `PAPER_STARTING_SOL`; live mode uses real balances (section 16).
- **Paper entry fill**: wait `PAPER_LATENCY_SEC`, fetch a fresh quote, tokens = quoteOut × (1 − `PAPER_EXTRA_SLIPPAGE_PCT`/100). Cost basis = size + `PAPER_FEE_USD_PER_TX`. Debit the virtual wallet.
- **Paper exit fill**: wait `PAPER_LATENCY_SEC`, fetch a fresh sell quote, proceeds = quoteOut × (1 − `PAPER_EXTRA_SLIPPAGE_PCT`/100) − `PAPER_FEE_USD_PER_TX`. Credit the virtual wallet.
- Live fills: section 16.
- Each position stores: mode, mint, symbol, pair address, entry time, size, token amount, cost basis, entry liquidity, the entry pair-data snapshot, score and components, safety and holder results.

## 8. Monitoring and exits

### 8.1 Loops

- Every `POLL_SECONDS` per open position: Jupiter sell quote for the full token amount (exit lane). `valueUsd` = quoteOut − estimated exit fee (`PAPER_FEE_USD_PER_TX` in paper; priority + base fee in USD in live). `pnlPct` = (valueUsd − costBasis) / costBasis × 100. The first history point is recorded at entry.
- Every `LIQ_CHECK_SECONDS`: DexScreener pair data for all held mints (batched); pass the latest `liquidity.usd` into the state machine as a new reading.

### 8.2 Persisted state per position

`entryTime`, `costBasis`, `entryLiquidity`, `peakPnl`, `currentTarget` (starts at `TARGET_PROFIT_PCT`), `targetExtensions` (0), `timerRestarts` (0), `lastRestartAt` (null), `deadline` (entryTime + `HOLD_MINUTES`), `trailArmed` (false), `fastStreak` (0), `lowLiqStreak` (0), `noRouteSince` (null), and a `history` of (t, pnlPct) covering at least `FAST_WINDOW_MINUTES`.

### 8.3 Exit state machine

`step(state, inputs) → { action, reason, newState }`, where inputs are `now`, `pnlPct` (null if there's no quote or route), an optional `confirmPnlPct`, and an optional new `liquidityUsd` reading. Actions: `HOLD`, `SELL(reason)`, `NEED_CONFIRM`.

Evaluate in this order; the first SELL, NEED_CONFIRM or explicit HOLD returns:

1. **No route**: if `pnlPct` is null, set `noRouteSince` if unset; if `now − noRouteSince ≥ NO_ROUTE_EXIT_SEC` → SELL `no_route` (urgent alert); otherwise HOLD. If `pnlPct` is not null, clear `noRouteSince`.
2. **Liquidity pull**: for a new liquidity reading, if it's below `entryLiquidity × (1 − LIQ_DROP_EXIT_PCT/100)`, increment `lowLiqStreak`, otherwise reset it to 0. If `lowLiqStreak ≥ LIQ_DROP_CONFIRM_READS` → SELL `liq_pull`.
3. **Stop-loss**: if `pnlPct ≤ −STOP_LOSS_PCT`: without `confirmPnlPct` → NEED_CONFIRM (the monitor immediately fetches one more quote on the exit lane and calls `step` again). If `confirmPnlPct ≤ −STOP_LOSS_PCT` → SELL `stop`. Otherwise continue, using `confirmPnlPct` as `pnlPct`.
4. **Record**: `peakPnl = max(peakPnl, pnlPct)`; append (now, pnlPct) to history.
5. **Fast**: `old` = the oldest history point with `t ≥ now − FAST_WINDOW_MINUTES`. `rawFast = (now − old.t ≥ FAST_MIN_HISTORY_SEC) and (pnlPct − old.pnl ≥ FAST_GAIN_PCT)`. `fastStreak = rawFast ? fastStreak + 1 : 0`. `isFast = fastStreak ≥ FAST_CONFIRM_POLLS`. Never use the window's minimum: a rebound from a dip must not count as fast.
6. **Timer restart**: if `isFast` and `timerRestarts < MAX_TIMER_RESTARTS` and (`lastRestartAt` is null or `now − lastRestartAt ≥ FAST_WINDOW_MINUTES`): `deadline = now + HOLD_MINUTES`, `timerRestarts += 1`, `lastRestartAt = now`, log `timer_restart`.
7. **Breakeven**: if `BREAKEVEN_TRIGGER_PCT > 0` and `peakPnl ≥ BREAKEVEN_TRIGGER_PCT` and `pnlPct ≤ BREAKEVEN_FLOOR_PCT` → SELL `breakeven`.
8. **Target**: if `pnlPct ≥ currentTarget`: set `trailArmed = true`. If `isFast` and `targetExtensions < MAX_TARGET_EXTENSIONS`: `currentTarget += EXTRA_TARGET_PCT`, `targetExtensions += 1`, log `target_raised`, HOLD. Otherwise SELL `target`.
9. **Trail**: if `trailArmed` and `pnlPct ≤ peakPnl − TRAIL_PCT` → SELL `trail`.
10. **Max hold**: if `now − entryTime ≥ MAX_TOTAL_HOLD_MINUTES` → SELL `max_hold`.
11. **Deadline**: if `now ≥ deadline` → SELL `time_flat` if |pnlPct| ≤ `FLAT_BAND_PCT`, otherwise `time_exit`.
12. Otherwise HOLD.

### 8.4 Selling

- Once a SELL is decided, the position's status becomes `closing` and the state machine no longer runs for it.
- Paper: exit fill (section 7). Live: section 16. Then record the trade (section 11.1), start post-exit tracking, and run slot filling.
- Paper mode with no route: keep trying every poll; if there's still no route after `STUCK_WRITE_OFF_MIN`, close at −100% with reason `written_off`.

### 8.5 Restarts

On startup, reload open positions and resume polling. Times are absolute, so positions past their deadline or max hold sell on the first poll. Log the downtime gap. History older than the fast window is ignored.

## 9. Risk and controls

### 9.1 Entry blockers

Checked before every entry. Open positions are always managed normally, whatever the blockers.

- **Kill switch or pause** active.
- **Daily loss**: realized net PnL for the trading day + Σ min(0, value − costBasis) over open positions ≤ −`MAX_DAILY_LOSS_USD` → halt entries until the next trading day (one urgent alert). `/resume` cannot clear this.
- **Loss streak**: after `CONSECUTIVE_LOSS_PAUSE` losing trades in a row, pause entries for `LOSS_PAUSE_MINUTES` (noted in the digest).
- **Errors**: after `MAX_CONSECUTIVE_ERRORS` consecutive failed entries or unhandled loop errors, halt entries until `/resume` (urgent alert). 429 responses never count as errors.
- **Slots**: open positions < `MAX_CONCURRENT`.

### 9.2 Controls

- **Kill switch**: a file named `KILL` in the working directory, or `/killswitch`. Stops entries and sells all open positions (paper: closes the virtual ones). Persists across restarts.
- `/pause` stops new entries only. `/resume` clears pause, error halts, and the kill switch (the `KILL` file must also be deleted if it was used).

### 9.3 Jupiter budget

- One limiter: at most `JUPITER_MAX_REQ_PER_MIN` in any 60-second sliding window, and at least `JUPITER_MIN_INTERVAL_MS` between requests.
- Track `exitUsed` and `entryUsed` separately over the 60-second window. **Exit lane** (position sell quotes, confirmation quotes, exit fills, live sells and retries) always goes first and is never blocked by entry usage. **Entry lane** (sellability, execution quotes, entry fills) is allowed only if `exitUsed + entryUsed + max(0, exitReserve − exitUsed) < JUPITER_MAX_REQ_PER_MIN`, where `exitReserve = MAX_CONCURRENT × ceil(60 / POLL_SECONDS) + EXIT_RESERVE_EXTRA_PER_MIN`.
- **Startup validation**: `exitReserve + ENTRY_MIN_BUDGET_PER_MIN` must be ≤ `JUPITER_MAX_REQ_PER_MIN`. If not, refuse to start with a clear message, or, if `AUTO_STRETCH_POLL=true`, raise `POLL_SECONDS` until it fits and log it.
- On a 429: back off with jitter; never retry faster than the limiter allows.
- Count entry checks deferred for lack of budget (digest).

## 10. Notifications

- No per-token, per-entry, per-exit or per-skip messages.
- **Digest** every `DIGEST_INTERVAL_MINUTES`, sent even if nothing happened (it doubles as a heartbeat), labeled PAPER or LIVE:
  - uptime and wallet balances (virtual in paper mode)
  - trades closed in the window: symbol, exit reason, net PnL % and USD
  - open positions: symbol, time held, current PnL %, current target, deadline
  - trading day so far: trades, win rate, median and mean net PnL, total, biggest win and loss, exit-reason breakdown
  - funnel: discovered, eligible, READY, entered, top 3 skip reasons, skipped because slots were full, score range of entries
  - risk: pause/halt/kill state, daily loss vs cap, current loss streak
  - health: Jupiter requests/min (average and peak), 429s, deferred entry checks, DexScreener and RPC errors, downtime gaps
- **Urgent** messages go out immediately when `URGENT_ALERTS=true` (otherwise they wait for the next digest): `no_route` or stuck sells, daily loss halt, error halt, kill switch, DexScreener/Jupiter/RPC unreachable for more than `OUTAGE_ALERT_MINUTES` (one message per outage plus one on recovery), and startup after a crash or restart.
- **Commands** (configured chat only): `/status` (digest now), `/report` (section 11.4 summary), `/pause`, `/resume`, `/killswitch`.

## 11. Tracking and reporting

### 11.1 Trades

Every closed trade stores: mode, mint, symbol, pair, entry and exit times, size, cost basis, proceeds, net PnL (USD and %), exit reason, peak PnL, timer restarts, target extensions, all fees, the entry pair snapshot (m5/h1/h24 price change, m5/h1 volume, m5 buys and sells, liquidity, pair age, FDV), top-1 and top-10 share, score and components, and the animal flag (null for now). A win is net PnL USD > 0.

### 11.2 Shadow positions (`SHADOW_ENABLED`)

- Every mint gets a shadow position the first time it becomes READY, whether or not it's later bought. Shadows are marked `selected` when a real or paper position opens for that mint, and `unsellable` if the mint fails the sellability check (excluded from comparisons).
- Shadows use the same size and a constant-product cost estimate. With liquidity L and reserve R = L/2 per side: entry price = priceUsd × (1 + size/R) × (1 + `SHADOW_POOL_FEE_PCT`/100) × (1 + `PAPER_EXTRA_SLIPPAGE_PCT`/100), and `PAPER_FEE_USD_PER_TX` is added to the cost basis. Value at price p and liquidity L' (R' = L'/2), with V = tokens × p: proceeds = V × R'/(R' + V) × (1 − `SHADOW_POOL_FEE_PCT`/100) × (1 − `PAPER_EXTRA_SLIPPAGE_PCT`/100) − `PAPER_FEE_USD_PER_TX`.
- Shadows run the same exit state machine, priced from DexScreener batches every `SHADOW_POLL_SECONDS`, and never call Jupiter. For shadows, `confirmPnlPct` = `pnlPct` (no second quote), and a missing pair counts as no route. At most `SHADOW_MAX_OPEN` are open at once; count the ones skipped beyond that.

### 11.3 Other tracking (DexScreener batches only)

- **Skipped tokens**: when a mint leaves pending without ever becoming READY, record its last skip reason and its price change at +15 and +60 minutes. At most `SKIP_TRACK_MAX_PER_HOUR` new ones per hour.
- **Post-exit** (`POST_EXIT_TRACK`): price at +15, +30 and +60 minutes after each exit.

### 11.4 Report

`npm run report -- [--mode paper|live] [--from YYYY-MM-DD] [--to YYYY-MM-DD]` and `/report`:

- Totals: trades, win rate, median and mean net PnL (% and USD), p10, p90, average win vs average loss, total net PnL, max drawdown of cumulative PnL.
- Breakdowns by exit reason and by trading day.
- Results by entry-feature quantile buckets (m5, h1, buy pressure, liquidity, pair age, top-10 share).
- Score: results by score quintile; correlation of each score component with net PnL.
- Shadows: selected vs unselected (count, win rate, median and mean net PnL, p10); shadow vs actual results for selected mints (how closely the shadow method matches real quotes).
- Exited too early: share of trades whose post-exit price at +15/+60 exceeded the exit price, and by how much.
- Skipped tokens: median +15/+60 price change by skip reason.
- **Go-live checklist** (paper trades only), each PASS or FAIL: closed trades ≥ `GOLIVE_MIN_TRADES`; first-to-last trade span ≥ `GOLIVE_MIN_DAYS` days; median net PnL % > `GOLIVE_MIN_MEDIAN_PNL_PCT`; total net PnL USD > `GOLIVE_MIN_TOTAL_PNL_USD`; p10 net PnL % ≥ `GOLIVE_MIN_P10_PNL_PCT`; no positions currently stuck.

## 12. Storage

SQLite with versioned migrations. Suggested tables: `seen_mints`, `pending`, `positions`, `position_history`, `trades`, `shadows`, `skip_tracks`, `post_exit_tracks`, `safety_cache`, `state` (kill, pause, halts, streaks, virtual wallet), `events`. The database files are gitignored.

## 13. Configuration (.env)

All values are placeholders to tune. Ship this as `.env.example` with the secrets left blank. Comments go on their own lines. Startup validation also checks: the weights sum to 1.0; the Jupiter budget (section 9.3); and `POSITION_USD ≤ HARD_MAX_POSITION_USD` (a code constant, section 16).

```ini
# ---- Mode ----
MODE=paper
# Live mode requires exactly: I_ACCEPT_REAL_LOSSES
LIVE_ACK=
TRADING_DAY_TZ=Asia/Kolkata
LOG_LEVEL=info

# ---- Secrets (never commit, never log) ----
SOLANA_RPC_URL=
JUPITER_API_KEY=
# Phase 3 only; leave empty in paper mode
WALLET_PRIVATE_KEY=
TRADER_TELEGRAM_BOT_TOKEN=
TRADER_TELEGRAM_CHAT_ID=

# ---- Discovery ----
DISCOVERY_SECONDS=20
PENDING_RECHECK_SECONDS=30
MAX_PENDING_AGE_MIN=180
MAX_NO_PAIR_CHECKS=3
SEEN_MINTS_CAP=5000
DEX_PROFILES_MAX_PER_MIN=40
DEX_PAIRS_MAX_PER_MIN=200
# Wrapped SOL, USDC, USDT (verify)
ALLOWED_QUOTE_MINTS=So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
# Documented, not implemented
REQUIRE_ANIMAL_THEME=false

# ---- Entry gate ----
MIN_LIQUIDITY_USD=10000
ENTRY_WINDOW_MIN=15
MIN_M5_CHANGE_PCT=0
MIN_H1_CHANGE_PCT=0
MIN_H24_CHANGE_PCT=0
# 0 = disabled
MAX_H1_CHANGE_PCT=0
MIN_M5_TXNS=10
MIN_M5_BUY_SELL_RATIO=1.0
MIN_M5_VOLUME_USD=1000
REQUIRE_MINT_REVOKED=true
REQUIRE_FREEZE_REVOKED=true
MAX_TOP1_PCT=15
MAX_TOP10_PCT=40
HOLDERS_CACHE_MIN=5
MAX_ROUNDTRIP_LOSS_PCT=8
MAX_ENTRY_DRIFT_PCT=10
REENTRY_ENABLED=false

# ---- Selection ----
W_BUY_PRESSURE=0.25
W_ACTIVITY=0.20
W_MOMENTUM=0.20
W_DEPTH=0.15
W_HOLDERS=0.10
W_FRESHNESS=0.10
ACTIVITY_CAP=0.5
MOMENTUM_CAP_PCT=100
DEPTH_CAP_USD=200000
# Rank only until data shows a useful cutoff
MIN_SCORE=0

# ---- Sizing and risk ----
POSITION_USD=25
MAX_POSITION_PCT_OF_LIQ=1
MAX_CONCURRENT=3
MAX_DAILY_LOSS_USD=30
CONSECUTIVE_LOSS_PAUSE=5
LOSS_PAUSE_MINUTES=60
MAX_CONSECUTIVE_ERRORS=5

# ---- Exits ----
POLL_SECONDS=10
STOP_LOSS_PCT=15
TARGET_PROFIT_PCT=30
EXTRA_TARGET_PCT=10
MAX_TARGET_EXTENSIONS=1
HOLD_MINUTES=15
FAST_GAIN_PCT=15
FAST_WINDOW_MINUTES=5
FAST_MIN_HISTORY_SEC=60
FAST_CONFIRM_POLLS=2
MAX_TIMER_RESTARTS=3
MAX_TOTAL_HOLD_MINUTES=60
TRAIL_PCT=4
# 0 = disabled
BREAKEVEN_TRIGGER_PCT=20
BREAKEVEN_FLOOR_PCT=2
FLAT_BAND_PCT=3
LIQ_DROP_EXIT_PCT=30
LIQ_DROP_CONFIRM_READS=2
LIQ_CHECK_SECONDS=30
NO_ROUTE_EXIT_SEC=30
STUCK_WRITE_OFF_MIN=30

# ---- API budgets (defaults assume Jupiter's free plan: 1 request/second) ----
JUPITER_MAX_REQ_PER_MIN=45
JUPITER_MIN_INTERVAL_MS=1100
EXIT_RESERVE_EXTRA_PER_MIN=5
ENTRY_MIN_BUDGET_PER_MIN=10
AUTO_STRETCH_POLL=false
RPC_MAX_RPS=8

# ---- Paper mode ----
PAPER_STARTING_USDC=500
PAPER_STARTING_SOL=0.5
PAPER_EXTRA_SLIPPAGE_PCT=2
PAPER_LATENCY_SEC=3
PAPER_FEE_USD_PER_TX=0.05

# ---- Tracking ----
SHADOW_ENABLED=true
SHADOW_MAX_OPEN=30
SHADOW_POLL_SECONDS=15
SHADOW_POOL_FEE_PCT=1
SKIP_TRACK_MAX_PER_HOUR=60
POST_EXIT_TRACK=true

# ---- Notifications ----
DIGEST_INTERVAL_MINUTES=120
URGENT_ALERTS=true
OUTAGE_ALERT_MINUTES=10

# ---- Go-live checklist ----
GOLIVE_MIN_TRADES=100
GOLIVE_MIN_DAYS=7
GOLIVE_MIN_MEDIAN_PNL_PCT=0
GOLIVE_MIN_TOTAL_PNL_USD=0
GOLIVE_MIN_P10_PNL_PCT=-20

# ---- Live execution (Phase 3) ----
BUY_SLIPPAGE_BPS=300
SELL_SLIPPAGE_BPS_START=300
SELL_SLIPPAGE_BPS_MAX=2000
MAX_PRIORITY_FEE_SOL=0.0005
MIN_SOL_BALANCE=0.05
CLOSE_EMPTY_ATA=true
SELL_RETRY_SECONDS=10
```

## 14. Tests (mocked network, no real API calls)

### Exit state machine
- Target hit while not fast → SELL `target`.
- Target hit while fast → target raised; reaching the raised target → SELL `target`.
- Target hit while fast, then a drop of `TRAIL_PCT` from the peak → SELL `trail`.
- Fast growth before the target restarts the timer; the restart cap holds; no restart inside the cooldown.
- A rebound from a dip is not fast; fast requires `FAST_CONFIRM_POLLS` consecutive polls; nothing is fast before `FAST_MIN_HISTORY_SEC`.
- Breakeven exit.
- Stop-loss: a single bad quote gives NEED_CONFIRM and no sale if the confirmation disagrees; a confirmed stop gives SELL `stop`.
- `liq_pull` needs `LIQ_DROP_CONFIRM_READS` readings.
- `no_route` after `NO_ROUTE_EXIT_SEC`.
- `max_hold`; deadline `time_flat` vs `time_exit`.
- After a restart past the deadline, the first poll sells.

### Gate
- Pass, and each skip reason, temporary vs permanent.
- Token-2022 allowlist; pool-vault exclusion in the holder share; quote-mint filter; missing priceChange fields.

### Selection
- Ranking and tie-break; the best candidate failing sellability falls through to the next; drift skip; window expiry while waiting; no preemption; weights validation.

### Budget
- The exit lane proceeds when the entry lane is exhausted; startup validation rejects an over-budget config; `AUTO_STRETCH_POLL`.

### Risk and controls
- Daily loss including unrealized losses, which `/resume` can't clear; loss-streak pause; error halt; the kill switch closes positions and persists across restarts; `/pause` and `/resume`; commands from other chats are ignored.

### Paper mode and tracking
- Virtual wallet accounting; latency and extra slippage applied to fills; `written_off`.
- Shadows never call Jupiter; shadow cost math.
- Report math and the go-live checklist on a small hand-checked dataset.

### Safety
- No code path in Phases 1-2 can sign or send a transaction.
- Secrets are redacted in logs, including the RPC URL's `api-key`.

## 15. Build phases

### Phase 1: Foundation and discovery (no trading)
Build: config and validation, logger with redaction, storage and migrations, all limiters, clients (DexScreener; Jupiter quotes only; RPC read-only; Telegram), discovery and the pending queue with gate checks 1-4 (no trading decisions), SOL price, the digest (funnel and health sections), outage alerts, `/status`, `/pause`, `/resume`, `npm start`, `npm test`, README.

Done when: tests pass, and a one-hour run against real APIs with `DIGEST_INTERVAL_MINUTES=10` produces digests with plausible funnel counts and no crash.

### Phase 2: Paper trading
Build: gate checks 5-8, selection and scoring, the virtual wallet, paper fills, the monitor and exit state machine, risk blockers and controls (including `/killswitch`), shadows, skip and post-exit tracking, the full digest, the report with the go-live checklist, `/report`, and pm2 setup for Linux and Windows. pm2's own startup command doesn't support Windows, so document a working alternative there.

Done when: all section 14 tests for Phases 1-2 pass, and a short paper run opens and closes virtual positions, sends a digest, and produces a report.

### Phase 3: Live execution
Build only after the paper go-live checklist passes. See section 16.

Done when: all tests pass, including the paper-mode send-path test, and the README documents `smoke-live` and going live.

## 16. Live execution (Phase 3)

- `MODE=live` starts only if `LIVE_ACK=I_ACCEPT_REAL_LOSSES`, `WALLET_PRIVATE_KEY` is set, and `POSITION_USD ≤ HARD_MAX_POSITION_USD`, which is a constant in code (100), not an env var.
- Load the key from `.env` and never log it. Show only the public address.
- Before each entry: USDC ≥ size and SOL ≥ `MIN_SOL_BALANCE`.
- Swaps go through Jupiter per the current docs. Buys use `BUY_SLIPPAGE_BPS`. Priority fees are capped at `MAX_PRIORITY_FEE_SOL` per transaction.
- **Verify before sending**: simulate every transaction and refuse it (with an urgent alert) unless the fee payer is our wallet and our wallet's only balance changes are the expected input mint decreasing (by no more than the expected amount plus slippage), the expected output mint increasing, and SOL spent on fees and token-account rent.
- Confirm every transaction; on blockhash expiry, rebuild with a fresh quote.
- Use the confirmed transaction's actual amounts for cost basis and proceeds, with all fees converted to USD.
- **Sells**: retry every `SELL_RETRY_SECONDS` with a fresh quote and slippage rising from `SELL_SLIPPAGE_BPS_START` to `SELL_SLIPPAGE_BPS_MAX`. After 3 failures, mark the position `stuck`, send an urgent alert, and keep retrying.
- After a full sell, close the empty token account (`CLOSE_EMPTY_ATA`) and credit the reclaimed rent.
- **Startup reconciliation**: compare database positions with wallet token balances. Tokens held with no database record are reported in the digest and never traded automatically. Database positions with a zero balance close with reason `reconciled`.
- `npm run smoke-live`: after the user types an explicit confirmation in the terminal, swap $1 of USDC → SOL → USDC to test signing, sending, confirmation and accounting. It never touches other tokens.
- Tests: mocked end-to-end buy and sell; slippage escalation; stuck handling; simulation verification rejecting an unexpected balance change; reconciliation; the interlocks; and a test proving paper mode never reaches the send path.