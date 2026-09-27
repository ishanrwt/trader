# Solana Trader Bot: Build Spec v1

Last updated: 2026-09-25. This file is the single source of truth for the trader bot. If anything here is ambiguous, contradicts itself, or doesn't match the current external docs, stop and ask instead of guessing.

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
- **logger**: console plus rotating file at `LOG_LEVEL`, with secret redaction (section 16.9).
- **storage**: SQLite with versioned migrations (section 12).
- **limiters**: DexScreener (profiles and pairs classes), Jupiter (two priority lanes, section 9.3), RPC (transaction lane ahead of read lane, plus a separate `sendTransaction` limiter; section 16.10).
- **clients**: DexScreener, Jupiter, Solana RPC, Telegram.
- **live** (Phase 3): key loading, transaction building, verification, sending, confirmation, write-ahead intents and reconciliation (section 16). Loaded only in live mode and by `smoke-live`.
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
- Our limiter stays under `DEX_PROFILES_MAX_PER_MIN` for profiles and `DEX_PAIRS_MAX_PER_MIN` for pair data (shared by discovery, liquidity checks, shadows, tracking and price paths). On a 429 or 5xx, back off with jitter.
- **Pair selection rule** (used everywhere a price or liquidity is needed for a mint): among a mint's pairs with `chainId` "solana" where `baseToken.address` equals that mint and `quoteToken.address` is in `ALLOWED_QUOTE_MINTS`, use the one with the highest `liquidity.usd`. Ignore all other pairs, including ones where the mint appears only as the quote token. DexScreener occasionally misprices pairs quoted against other tokens.

### Jupiter

- Free API key (`JUPITER_API_KEY`); the free plan allows 1 request per second (60 per 60-second sliding window, per organisation). Read the current docs at developers.jup.ag and choose endpoints that support (a) quotes for arbitrary amounts without executing, and (b) in Phase 3, building or executing swaps.
- In your plan, state which endpoints you chose, which rate-limit buckets they use (some execute/submit endpoints may have separate buckets), and any fees they charge. Those fees must be included in PnL.
- Chosen (verified 2026-09-25): quotes use `GET /swap/v1/quote` in both modes (section 16.1); live swaps use the Router path `GET /swap/v2/build`, which returns raw instructions that the bot assembles, simulates, signs and sends through its own RPC. Both are in the main rate-limit bucket. `/build` charges no Jupiter swap fee.

### Solana RPC

- `SOLANA_RPC_URL`, a keyed provider URL (for example Helius's free plan: 10 requests/s overall, `sendTransaction` 1/s, `simulateTransaction` shares the overall limit, 1M credits/month). Phases 1-2 only make read calls: `getAccountInfo` (jsonParsed), `getTokenLargestAccounts`, `getTokenSupply`, `getMultipleAccounts`. Limited by `RPC_MAX_RPS`.
- Rug-risk feature collection (section 11.6, both modes, read-only) adds `getAccountInfo` (base64), `getProgramAccounts`, `getSignaturesForAddress`, `getTransaction` (jsonParsed, `maxSupportedTransactionVersion: 1`) and `getTokenAccountsByOwner`, through the same `RPC_MAX_RPS` read lane. Helius credit costs: 1 per standard call, 10 per `getProgramAccounts`.
- Phase 3 adds, in live mode and `smoke-live` only: `simulateTransaction`, `sendTransaction`, `getSignatureStatuses`, `getTransaction`, `getBlockHeight`, `getLatestBlockhash`, `getTokenAccountsByOwner`. Budgets and limits are in section 16.10.

### RugCheck (optional, `RUGCHECK_ENABLED`, default off)

- `GET https://api.rugcheck.xyz/v1/tokens/{mint}/report/summary`: no authentication per RugCheck's published Swagger spec; fields used: `score`, `score_normalised`, `lpLockedPct`, `risks`. The spec lists a 429 "Rate limit exceeded" response but no number, and no API terms were found, so it is off by default. When on: one request per READY mint, no retries, a descriptive User-Agent; any failure records null.

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
2. **Sellability** (Jupiter entry lane; result cached per mint and position size for 10 minutes, so a round-trip loss measured at one size is never reused for another): quote USDC→token for the position size, then token→USDC for the quoted token amount. Require the round-trip output ≥ (1 − `MAX_ROUNDTRIP_LOSS_PCT`/100) × input. Failure is permanent (`unsellable`); move to the next mint.
3. **Drift**: get the execution quote (in live mode, the `/swap/v2/build` response for the actual buy is the execution quote, so no separate quote call is made; section 16.2). Implied entry price = size / tokensOut. If it exceeds DexScreener `priceUsd` × (1 + `MAX_ENTRY_DRIFT_PCT`/100), skip (`drift`, temporary: the mint stays READY until its window expires).
4. Open the position (section 7).

Never close an open position to make room for a candidate.

## 7. Opening positions and fills

- Size = min(`POSITION_USD`, liquidity_usd × `MAX_POSITION_PCT_OF_LIQ`/100).
- Wallet check: available USDC ≥ size. Paper mode uses a virtual wallet seeded with `PAPER_STARTING_USDC` and `PAPER_STARTING_SOL`; live mode uses real on-chain balances and also checks SOL (section 16.7).
- **Paper entry fill**: wait `PAPER_LATENCY_SEC`, fetch a fresh quote, tokens = quoteOut × (1 − `PAPER_EXTRA_SLIPPAGE_PCT`/100). Cost basis = size + `PAPER_FEE_USD_PER_TX`. Debit the virtual wallet.
- **Paper exit fill**: wait `PAPER_LATENCY_SEC`, fetch a fresh sell quote, proceeds = quoteOut × (1 − `PAPER_EXTRA_SLIPPAGE_PCT`/100) − `PAPER_FEE_USD_PER_TX`. Credit the virtual wallet.
- Live fills: section 16.
- Each position stores: mode, mint, symbol, pair address, entry time, size, token amount, cost basis, entry liquidity, the entry pair-data snapshot, score and components, safety and holder results.

## 8. Monitoring and exits

### 8.1 Loops

- Every `POLL_SECONDS` per open position: Jupiter sell quote for the full token amount (exit lane). `valueUsd` = quoteOut − estimated exit fee (`PAPER_FEE_USD_PER_TX` in paper; in live, (base fee + `MAX_PRIORITY_FEE_SOL`) in USD, plus the token account's reclaimable rent in USD when `CLOSE_EMPTY_ATA=true`, since the sell closes that account and the rent was included in the cost basis; section 16.3). In live mode the quoted amount is the token account's raw on-chain balance as last read from the chain (the confirmed entry, then every sell attempt's balance read and reconciliation); monitoring doesn't add a balance read per poll. `pnlPct` = (valueUsd − costBasis) / costBasis × 100. Immediately after the entry fill, one exit-lane quote is fetched the same way and its `pnlPct` becomes the first history point and the initial peak PnL — never assumed to be 0% (round-trip fees, price impact and simulated slippage typically put a just-opened position slightly below zero already). If that quote fails, no history point is fabricated; history starts empty and the first regular poll becomes history's first point.
- Every `LIQ_CHECK_SECONDS`: DexScreener pair data for all held mints (batched); pass the latest `liquidity.usd` into the state machine as a new reading.

### 8.2 Persisted state per position

`entryTime`, `costBasis`, `entryLiquidity`, `peakPnl`, `currentTarget` (starts at `TARGET_PROFIT_PCT`), `targetExtensions` (0), `timerRestarts` (0), `lastRestartAt` (null), `deadline` (entryTime + `HOLD_MINUTES`), `trailArmed` (false), `fastStreak` (0), `lowLiqStreak` (0), `noRouteSince` (null), and a `history` of (t, pnlPct) covering at least `FAST_WINDOW_MINUTES`.

### 8.3 Exit state machine

`step(state, inputs) → { action, reason, newState }`, where inputs are `now`, `pnlPct` (null if there's no quote or route), an optional `confirmPnlPct`, and an optional new `liquidityUsd` reading. Actions: `HOLD`, `SELL(reason)`, `NEED_CONFIRM`.

Evaluate in this order; the first SELL, NEED_CONFIRM or explicit HOLD returns:

1. **No route**: if `pnlPct` is null, set `noRouteSince` if unset; if `now − noRouteSince ≥ NO_ROUTE_EXIT_SEC` → SELL `no_route` (urgent alert); otherwise HOLD. If `pnlPct` is not null, clear `noRouteSince`.
2. **Liquidity pull**: for a new liquidity reading, if it's below `entryLiquidity × (1 − LIQ_DROP_EXIT_PCT/100)`, increment `lowLiqStreak`, otherwise reset it to 0. If `lowLiqStreak ≥ LIQ_DROP_CONFIRM_READS` → SELL `liq_pull`.
3. **Stop-loss**: if `pnlPct ≤ −STOP_LOSS_PCT`: without `confirmPnlPct` → NEED_CONFIRM (the monitor immediately fetches one more quote on the exit lane and calls `step` again). If `confirmPnlPct ≤ −STOP_LOSS_PCT` → SELL `stop`. Otherwise continue, using `confirmPnlPct` as `pnlPct`. Every NEED_CONFIRM is logged as a `stop_confirm` event with the triggering `pnlPct`, the `confirmPnlPct` (null if the confirmation quote had no route), and whether the stop was confirmed. The monitor writes this event after `step` returns; `step` itself stays pure.
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
- Paper: exit fill (section 7). Live: section 16.6. Then record the trade (section 11.1), start post-exit tracking, and run slot filling.
- Paper mode with no route: keep trying every poll; if there's still no route after `STUCK_WRITE_OFF_MIN`, close at −100% with reason `written_off`. Live mode never writes off a position whose tokens are still in the wallet (section 16.6).

### 8.5 Restarts

On startup, reload open positions and resume polling. In live mode, write-ahead intents are resolved and reconciliation runs first (section 16.5). Times are absolute, so positions past their deadline or max hold sell on the first poll. Log the downtime gap. History older than the fast window is ignored.

## 9. Risk and controls

### 9.1 Entry blockers

Checked before every entry. Open positions are always managed normally, whatever the blockers.

**Per-mode accounting**: daily loss, the loss streak and its pause, and the digest's trading-day stats count only trades, positions and fee losses in the current `MODE`. Paper trades never affect live limits, and live trades never affect paper limits. The state keys for the daily-loss halt, loss streak and loss pause are stored per mode.

- **Kill switch or pause** active.
- **Daily loss**: realized net PnL for the trading day + realized fee losses for the trading day (section 16.3; live only) + Σ min(0, value − costBasis) over open positions ≤ −`MAX_DAILY_LOSS_USD` → halt entries until the next trading day (one urgent alert). `/resume` cannot clear this.
- **Loss streak**: after `CONSECUTIVE_LOSS_PAUSE` losing trades in a row, pause entries for `LOSS_PAUSE_MINUTES` (one urgent alert when the pause starts; also shown in the digest). Each further loss while the streak is at or above the threshold restarts the pause from that loss; these extensions don't alert again, but a new pause after an old one has ended does. Only a win resets the streak. Fee losses from failed transactions are not trades and don't count toward the streak.

**When halts are evaluated**: the daily-loss halt is recomputed on every entry check, after every recorded trade, after every position poll, and once at startup, so it (and its alert) can trigger from unrealized losses without waiting for an entry candidate. The streak and pause are updated when each trade is recorded.

**Alerts are idempotent across restarts**: whether a halt's alert has been sent is stored in the `state` table (per mode), keyed by the halt day for the daily-loss halt and by the pause's start time for the loss-streak pause, never by in-memory flags. A restart doesn't re-send an alert already sent for the same halt or pause, and an alert for a halt or pause recorded before the bot stopped is sent at the next startup, marked "sent late" if that halt day or pause has already ended.

**`PAPER_HALTS_OBSERVE_ONLY`** (default `false`; paper only): when `true` and `MODE=paper`, the daily-loss halt and the loss-streak pause are computed, stored and alerted exactly as above, but don't block entries. The kill switch, `/pause`, the error halt and the slot limit stay fully enforced. `MODE=live` refuses to start with it set to `true` (startup validation, section 13; this includes `smoke-live`). Because the halt day and pause time are stored either way, switching `PAPER_HALTS_OBSERVE_ONLY` to `false` mid-day (and restarting) enforces whatever halt or pause is already recorded, immediately, without re-sending its alert. Every position records at entry which halts would have blocked a live bot then (section 11.1), and the report replays the halts over paper trades (section 11.4).
- **Errors**: after `MAX_CONSECUTIVE_ERRORS` consecutive failed entries or unhandled loop errors, halt entries until `/resume` (urgent alert). 429 responses never count as errors.
- **Slots**: open positions < `MAX_CONCURRENT`.

### 9.2 Controls

- **Kill switch**: a file named `KILL` in the working directory, or `/killswitch`. Stops entries and sells all open positions (paper: closes the virtual ones; live: real sells under section 16.6). Persists across restarts.
- `/pause` stops new entries only. `/resume` clears pause, error halts, and the kill switch (the `KILL` file must also be deleted if it was used).

### 9.3 Jupiter budget

- One limiter: at most `JUPITER_MAX_REQ_PER_MIN` in any 60-second sliding window, and at least `JUPITER_MIN_INTERVAL_MS` between requests.
- Track `exitUsed` and `entryUsed` separately over the 60-second window. **Exit lane** (position sell quotes, confirmation quotes, the entry valuation quote, exit fills, live sell `/swap/v2/build` calls and their retries and rebuilds, `smoke-live`) always goes first and is never blocked by entry usage. **Entry lane** (sellability, execution quotes, paper entry fills, live buy `/swap/v2/build` calls) is allowed only if `exitUsed + entryUsed + max(0, exitReserve − exitUsed) < JUPITER_MAX_REQ_PER_MIN`, where `exitReserve = MAX_CONCURRENT × ceil(60 / P) + EXIT_RESERVE_EXTRA_PER_MIN`, with `P = POLL_SECONDS` in paper mode and `P = min(POLL_SECONDS, SELL_RETRY_SECONDS)` in live mode (a closing position retries its sell every `SELL_RETRY_SECONDS` instead of being polled).
- **Startup validation**: `exitReserve + ENTRY_MIN_BUDGET_PER_MIN` must be ≤ `JUPITER_MAX_REQ_PER_MIN`. If not, refuse to start with a clear message, or, if `AUTO_STRETCH_POLL=true`, raise `POLL_SECONDS` until it fits and log it (in live mode, if `SELL_RETRY_SECONDS` is what doesn't fit, refuse to start: sell retries are never stretched automatically). Live mode also validates the RPC budget (section 16.10).
- On a 429: back off with jitter; never retry faster than the limiter allows.
- Count entry checks deferred for lack of budget (digest).

## 10. Notifications

- No per-token, per-entry, per-exit or per-skip messages.
- **Digest** every `DIGEST_INTERVAL_MINUTES`, sent even if nothing happened (it doubles as a heartbeat), labeled PAPER or LIVE. Every trade-based figure counts only the current mode (section 9.1):
  - uptime and wallet balances (virtual in paper mode; on-chain USDC and SOL in live mode, plus `SELL_FEE_RESERVE_SOL`)
  - trades closed in the window: symbol, exit reason, net PnL % and USD
  - open positions: symbol, time held, current PnL %, current target, deadline; in live mode also closing/stuck positions with sell attempts and fees spent
  - trading day so far: trades, win rate, median and mean net PnL, total, biggest win and loss, exit-reason breakdown; in live mode also fee losses from failed transactions (count and USD); in paper mode also how many of today's trades and open positions were taken under a would-be halt (section 11.1 tags, by halt)
  - funnel: discovered, eligible, READY, entered, top 3 skip reasons, skipped because slots were full, score range of entries
  - risk: pause/halt/kill state, daily loss vs cap, current loss streak, and the loss-streak pause end time while one is active; with `PAPER_HALTS_OBSERVE_ONLY` the daily-loss halt and the pause are labelled "observing only, not blocking"
  - health: Jupiter requests/min (average and peak), 429s, deferred entry checks, DexScreener and RPC errors, downtime gaps; in live mode also RPC requests in the window, transactions sent/landed/failed/expired, verification refusals
  - live mode: unknown tokens held with no database record (section 16.5), and empty token accounts left open
- **Urgent** messages go out immediately when `URGENT_ALERTS=true` (otherwise they wait for the next digest): `no_route` or stuck sells, daily loss halt, a loss-streak pause starting (section 9.1), error halt, kill switch, DexScreener/Jupiter/RPC unreachable for more than `OUTAGE_ALERT_MINUTES` (one message per outage plus one on recovery), and startup after a crash or restart. Live mode adds: a transaction refused by verification (section 16.2), a position's sell fee budget used up (section 16.6), SOL below `SELL_FEE_RESERVE_SOL` while positions are open (section 16.7; one message per episode plus one on recovery), a startup in live mode while the go-live checklist isn't met (section 16.8), and unknown tokens or recovered transactions found by reconciliation (section 16.5).
- **Commands** (configured chat only): `/status` (digest now), `/report` (section 11.4 summary), `/windows` (today's per-window stats for the current mode, section 11.4; not part of the recurring digest), `/pause`, `/resume`, `/killswitch`, and in live mode `/sellretry <mint prefix>` (section 16.6).
- `proceeds_unknown` trades (section 16.5) are listed separately in the digest, not mixed into the trading-day stats.
- Halt alert wording (section 9.1): enforcing (live, or paper without `PAPER_HALTS_OBSERVE_ONLY`) — "Daily loss halt: net PnL for the day is -$X, past the -$Y cap. Entries halted until the next trading day." and "Loss-streak pause: N losing trades in a row. Entries paused until HH:MM TZ."; observe mode — "PAPER: daily-loss halt would trigger (day -$X vs -$Y cap). Observing only, trading continues." and "PAPER: loss-streak pause would trigger (streak N, until HH:MM TZ). Observing only, trading continues." Times are wall-clock in `TRADING_DAY_TZ`. An alert sent at startup for a halt day or pause that has already ended adds "(Sent late: …)". Each alert is also written to `events` (`daily_loss_halt`, `loss_streak_pause`), even when `URGENT_ALERTS=false`.

## 11. Tracking and reporting

### 11.1 Trades

Every closed trade stores: mode, mint, symbol, pair, entry and exit times, size, cost basis, proceeds, net PnL (USD and %), exit reason, peak PnL, timer restarts, target extensions, all fees, the entry pair snapshot (m5/h1/h24 price change, m5/h1 volume, m5 buys and sells, liquidity, pair age, FDV), top-1 and top-10 share, score and components, and the animal flag (null for now). A win is net PnL USD > 0.

Also stored: tokens received at entry and the mint's decimals (if ever learned); the entry valuation's `pnlPct` (section 8.1's first exit-lane quote after the fill, null if that quote failed); and the raw, pre-decimal-adjustment Jupiter quote amounts (`inAmount`/`outAmount`, as the large-integer strings the API returns) for both the entry fill and the exit fill, so raw vs. decimal-adjusted amounts can be checked against each other after the fact. Peak PnL is never persisted below the trade's own final net PnL % — a trade can't have a lower peak than the value it closed at.

Also stored: the round-trip loss % measured by the sellability check that admitted the entry (section 6.2; (size − USDC back) / size × 100) and when that check ran; the entry pair's `dexId`; and, for `stop` exits, the `pnlPct` of the poll that triggered the stop and the confirmation quote's `pnlPct` (null for other exits, and null when the confirmation quote had no route).

A trade's `position_history` (section 8.2) is copied into `trade_history` (not deleted) when the position closes, so it survives past the position row's removal.

Every position also records at entry, and its trade keeps, whether a live bot would have been blocked at that moment and by which halt (section 9.1): `none`, `daily_loss`, `loss_streak` or `daily_loss+loss_streak`, from the stored halt day and pause time. Trades recorded before this existed have no value ("not recorded"). The tag reflects the paper bot's real state, which already includes losses a live bot would not have taken; the report's "as if live" view (section 11.4) is the counterfactual.

Live trades also store: the entry and exit transaction signatures; the raw on-chain amounts from the confirmed transactions (USDC spent and tokens received at entry, tokens sold and USDC received at exit, as large-integer strings); network fees in lamports and USD for each side; rent paid at entry and reclaimed at exit, in lamports and USD; the SOL/USD price used for each conversion; the number of sell attempts; the fees of failed sell attempts; and a `proceeds_unknown` flag (true only for `reconciled` closes, section 16.5). The Jupiter quote amounts (`inAmount`/`outAmount`) are still stored for comparison, but cost basis and proceeds come only from the confirmed transactions (section 16.3).

### 11.2 Shadow positions (`SHADOW_ENABLED`)

- Every mint gets exactly one shadow position per mode, the first time it becomes READY with room under `SHADOW_MAX_OPEN`, whether or not it's later bought. Dropping back to pending and becoming READY again never creates another, whatever the first shadow's outcome; a mint that already has its shadow is not counted as skipped for the cap. A unique index on (mint, mode) enforces this, including between two processes.
- A shadow's lifecycle (`outcome`: `open` until the exit state machine closes it, then `closed`) is separate from its classification (`unselected`, `selected`, `unsellable`). Its classification becomes `selected` when a real or paper position opens for that mint in the same mode, and `unsellable` if the mint fails the sellability check (excluded from comparisons; `unsellable` wins over `selected`). Classification applies whatever the lifecycle state: an open shadow keeps being priced until it closes, and a shadow that already closed is still classified. Shadows classified before this was fixed stopped being priced when they were marked; they're closed with `exit_reason` `not_priced` and no PnL, and the report counts them as "no data". The same fix reclassified as `selected` any earlier shadow whose mint had a trade or position in the same mode.
- Shadows created before this was enforced that duplicate an earlier shadow of the same mint and mode are kept, not deleted: the earliest (by entry time, then id) is the mint's shadow, and each later one is marked `duplicate_of` with its id and excluded everywhere (the shadow poll, the `SHADOW_MAX_OPEN` count, selection marking, the report). An `unsellable` or `selected` mark found only on a duplicate was moved to the kept shadow, `unsellable` taking precedence.
- Each shadow records the mode of the run that created it, so the report compares shadows with trades of the same mode.
- Shadows use the same size and a constant-product cost estimate. With liquidity L and reserve R = L/2 per side: entry price = priceUsd × (1 + size/R) × (1 + `SHADOW_POOL_FEE_PCT`/100) × (1 + `PAPER_EXTRA_SLIPPAGE_PCT`/100), and `PAPER_FEE_USD_PER_TX` is added to the cost basis. Value at price p and liquidity L' (R' = L'/2), with V = tokens × p: proceeds = V × R'/(R' + V) × (1 − `SHADOW_POOL_FEE_PCT`/100) × (1 − `PAPER_EXTRA_SLIPPAGE_PCT`/100) − `PAPER_FEE_USD_PER_TX`.
- Shadows run the same exit state machine, priced from DexScreener batches every `SHADOW_POLL_SECONDS`, and never call Jupiter. For shadows, `confirmPnlPct` = `pnlPct` (no second quote), and a missing pair counts as no route. At most `SHADOW_MAX_OPEN` are open at once; count the ones skipped beyond that.

### 11.3 Other tracking (DexScreener batches only)

- **Skipped tokens**: when a mint leaves pending without ever becoming READY, record its last skip reason, its real discovery time, its baseline price (the DexScreener `priceUsd` from the recheck batch that dropped it; none for a `pair` skip, which by definition has no valid pair), and its price at +15 and +60 minutes. At most `SKIP_TRACK_MAX_PER_HOUR` new ones per hour.
- **Post-exit** (`POST_EXIT_TRACK`): the exit price (the DexScreener `priceUsd` fetched once when the trade is recorded; null if that fetch fails or the mint has no valid pair) and the price at +15, +30 and +60 minutes after each exit. Each row records its exit price's source (`dexscreener_at_exit`).
- Rows recorded before these baselines were fixed are kept but not used where their baseline is missing or wrong: skip rows without a baseline price are left out of the skipped-token stats, and post-exit rows whose exit price was the entry snapshot's price (source `entry_snapshot`) are left out of the exited-too-early stats. The report says how many.

### 11.4 Report

`npm run report -- [--mode paper|live] [--from YYYY-MM-DD] [--to YYYY-MM-DD]` and `/report`. Paper and live results are never mixed: without `--mode`, every section below is printed once for paper and once for live (a mode with no trades says so); `/report` shows the current mode. Live sections also report fee losses from failed transactions (count, USD, per trading day), which count toward total net PnL and max drawdown, and list `proceeds_unknown` trades separately (section 16.5).

`npm run report -- --trades [--mode paper|live] [--from YYYY-MM-DD] [--to YYYY-MM-DD]` prints full per-trade detail instead of aggregates: everything section 11.1 stores per trade, including each entry pair snapshot field (pair age as entry time − `pairCreatedAt`) and all score components by name, plus the first 5 `trade_history` points (t, pnlPct).

`npm run report -- --windows [--mode paper|live] [--day YYYY-MM-DD]` and `/windows` print one trading day's (default: today) own stats per window, stacked in order: the day is split into `DIGEST_INTERVAL_MINUTES` windows aligned to local midnight in `TRADING_DAY_TZ` (00:00, then every interval; if the interval doesn't divide 24 hours, the last window is shorter). Each row shows trades, wins and net PnL USD for trades that closed in it, by exit time (a trade exactly on a boundary belongs to the later window); live rows also show fee losses from failed transactions, which count toward net. `proceeds_unknown` trades are counted but excluded from wins and net. Empty windows are listed; today's rows stop at the current window, which is marked. A day total follows (the sum of the rows). Paper and live are never mixed. The windows are derived only from `trades` and `fee_losses`, with no stored window state, and never from digest events: they don't match a particular digest message's window when a restart shifted the digest timer, and a trade that closed while no digest went out (e.g. after a crash) still shows in its window.

**Paper results are shown two ways.** The sections below are "all trades" (everything paper took), headed by how many were taken under a would-be halt (section 11.1 tags). They're followed by an **"as if live"** block: section 9.1's daily-loss halt and loss-streak pause replayed over the whole paper history in entry order, dropping the trades a live bot would have skipped. Only kept trades feed the replayed state: the streak and pause from kept trades' exits (skipping `proceeds_unknown`), and the daily loss from kept trades' realized PnL on their exit's trading day (including `proceeds_unknown`), sticky for the rest of that day. A kept trade counts only once it has exited; an exit at the same instant as an entry is applied first. So a loss paper took during a would-be pause never extends the replayed streak. The block prints, at the top, the limits it used (`MAX_DAILY_LOSS_USD`, `CONSECUTIVE_LOSS_PAUSE`, `LOSS_PAUSE_MINUTES`: the current `.env` values, applied to all history), then kept and dropped counts by reason (`daily_loss`, `loss_streak`, both), totals and a per-trading-day breakdown for the report period, and these approximations: only realized PnL is replayed (live also counts unrealized losses on open positions, so it can halt earlier); slot usage differs (a dropped trade may have freed a slot for a candidate paper never took). **The go-live checklist uses the "as if live" trades**, in the report, `/report`, and the live-startup check (section 16.8). `--windows` and `/windows` rows also show how many trades were taken under a would-be halt.

- Totals: trades, win rate, median and mean net PnL (% and USD), p10, p90, average win vs average loss, total net PnL, max drawdown of cumulative PnL.
- Breakdowns by exit reason and by trading day: for each, trades, win rate, median net PnL % and total net PnL USD.
- Results by entry-feature quartile (Q1 = lowest values; each with its value range, trades, win rate and median net PnL %) for m5 and h1 price change, buy pressure (m5 buys / (buys + sells) × 100 from the entry snapshot), liquidity, pair age (minutes) and top-10 share. Trades missing a feature are counted, not bucketed.
- Score: results by score quintile; correlation of each score component with net PnL.
- Shadows (this mode's, for the report period by the trading day of the shadow's entry; excluding those marked `duplicate_of`, section 11.2): selected vs unselected over closed shadows with PnL (count, win rate, median and mean net PnL in % and USD, p10), then how many are "no data" (closed without PnL), still open, and unsellable (excluded). Shadow vs actual for selected mints: each selected shadow with PnL is paired with its mint's first trade in the same mode that entered at or after the shadow; the report prints the number of pairs, the mean absolute difference in net PnL %, the mean signed difference (shadow − actual; positive means the shadow method is optimistic) and the correlation.
- Exited too early, separately at +15 and at +60 minutes: of the trades with a valid exit price (section 11.3) and a reading at that horizon, the share whose price then exceeded the exit price, and the median % by which it did among those; plus how many trades were left out for lack of a valid exit price.
- Rug-risk features (section 11.6): for each feature, how often it is null among the mints recorded in the period, by reason code; quartiles over the period's trades (LP burned %, holder count, sniper share, creator holding %, RugCheck score, pool age); breakdowns by LP status and by pump.fun migration.
- Skipped tokens: by skip reason, the count, how many have a baseline price, and the median +15/+60 price change from that baseline (rows without one are left out).
- **Go-live checklist** (paper trades, "as if live" view), each PASS or FAIL: closed trades ≥ `GOLIVE_MIN_TRADES`; first-to-last trade span ≥ `GOLIVE_MIN_DAYS` days; median net PnL % > `GOLIVE_MIN_MEDIAN_PNL_PCT`; total net PnL USD > `GOLIVE_MIN_TOTAL_PNL_USD`; p10 net PnL % ≥ `GOLIVE_MIN_P10_PNL_PCT`; no positions currently stuck. The checklist is information only: it never blocks live mode (sections 15 and 16.8).

### 11.5 Price paths (data collection only)

A price path is recorded for every mint that becomes READY, so exit rules and entry filters can later be replayed offline. Nothing here affects entries, exits, selection or shadows, and it never calls Jupiter: pair data comes from DexScreener through the shared `DEX_PAIRS_MAX_PER_MIN` limiter, with the section 3 pair selection rule, in batches of 30.

- **Start**: at the mint's first READY, whether or not a shadow is created (independent of `SHADOW_MAX_OPEN`). One path per mint and mode; becoming READY again never starts another. At most `PATH_TRACK_MAX` paths record at once; a mint that becomes READY while that many are recording gets no path (it isn't started later, since a path must start at first READY), and the digest's health section shows "price paths: n recording, m skipped at cap (today)".
- **Entry features**, stored once at first READY from the READY snapshot: the selected pair (JSON), `dexId`, pair age, top-1 and top-10 share, score and components. Also on the path: whether a position was opened for the mint (`selected`), and the round-trip loss and time of the latest sellability check for it, pass or fail (null if none ran); both are updated whenever they happen, even after recording has ended.
- **Points**: the READY pair is the first point. Then a point every `PATH_FAST_SECONDS` for the first `PATH_FAST_WINDOW_MIN` minutes, and every `SHADOW_POLL_SECONDS` after that, until 60 minutes after first READY (`ends_at`); no point is recorded at or after `ends_at`, and the path is then marked done. The interval in force is the one for the moment a point is due, so the first slow-phase point comes `SHADOW_POLL_SECONDS` after the last fast one. Recording continues whatever happens to the mint's shadow or real position.
- Each point stores t, `priceUsd`, `liquidity.usd`, `txns.m5.buys`, `txns.m5.sells` and `volume.m5` from the same pair. A **gap** row (all values null) is stored instead when the batch had no valid pair for the mint (`no_pair`) or the batch request failed (`fetch_failed`); neither stops the recording or the loop.
- **Restarts**: paths whose `ends_at` is still ahead resume recording; the downtime shows as missing timestamps, not gap rows.
- **Budget**: the recording loop runs every `PATH_FAST_SECONDS` and fetches only the paths that are due, batched together. At the `PATH_TRACK_MAX` cap with every path in its fast window, that's ⌈100/30⌉ = 4 requests per 5 s, 48/min. Together with everything else (pending rechecks, liquidity checks, shadows, skip and post-exit tracking, exit prices, SOL price: about 30/min in the worst case) that stays well under `DEX_PAIRS_MAX_PER_MIN`.

### 11.6 Rug-risk features (data collection only)

Recorded once per mint and mode at its first READY, in `mint_features` (independent of the price-path cap; joins `price_paths` on mint and mode), so entry filters can later be evaluated offline. Nothing here is a gate check or is read by selection, entries or exits. Collection runs in the background after READY, one mint at a time, on the RPC read lane; it never delays the gate. Every lookup is separate and fails safe: a failure stores null plus a reason code (`rpc_error`, `budget`, `too_many_txs`, `unsupported`, `layout_unverified`, `concentrated_or_position`, `not_found`, `implausible`, `no_creator`, `disabled`). Account layouts come from pump.fun's published IDLs (`idl/pump.json`, `idl/pump_amm.json` in pump-public-docs).

- **Pool and pump.fun migration**: the selected pair's address is the pool account; its owner program identifies the pool type. A pump.fun migration is a completed bonding curve (PDA of seeds `"bonding-curve"` + mint under the pump program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, `complete = true`) whose liquidity is in the canonical PumpSwap pool (`index` 0, the index pump.fun's `migrate` uses). Pool age at READY is the price path's pair age (DexScreener `pairCreatedAt`).
- **LP status, PumpSwap** (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`): the pool's `lp_supply` (the LP amount minted; burns don't reduce it) against the LP mint's current supply. Burned % = 1 − current supply ÷ `lp_supply`; no PumpSwap LP locker is documented, so locked = 0; withdrawable = the rest. Status `burned` at ≥ 99% burned, else `withdrawable`. Both raw numbers are stored. `lp_supply` = 0, or more LP circulating than `lp_supply`, records `implausible`. **Raydium and Meteora**: not decoded yet (their account layouts couldn't be verified from their docs): `layout_unverified`, or `concentrated_or_position` for pools without a fungible LP token (CLMM, DLMM, DAMM v2 / `DYN2`).
- **Holder count**: non-zero token accounts for the mint, from `getProgramAccounts` on its token program with a mint filter (and the 165-byte size filter for SPL Token; Token-2022 accounts can be longer), reading only the amount.
- **Sniper share** (pump.fun tokens only): the bonding curve is created when the token launches on pump.fun; the PumpSwap pool only comes later, at migration. The sniper share measures buys in the curve's first `SNIPER_SLOTS` slots after launch: tokens received in successful transactions of those slots by any account other than the curve itself and the PumpSwap pool, as a % of total supply; this includes the creator's own buy in the launch transaction. The curve's signatures are paged back to launch (1000 per page, at most `SNIPER_MAX_PAGES` pages, else `too_many_txs`); at most 40 early transactions are read (`sniper_capped` marks a lower bound). A share over 100% records `implausible`. When a curve sells out within the window, its remainder moving into the pool's vault is not a buy.
- **Creator's current holding**: the PumpSwap pool's `coin_creator` if set, else the bonding curve's `creator`; their balance of the mint as a % of supply. No creator (non-pump.fun tokens) records `no_creator`.
- **Creator history**: not recorded (no free, reliable source).
- **RugCheck** (section 3), only when `RUGCHECK_ENABLED`.
- **Credits**: a typical PumpSwap mint uses about 20 Helius credits (pool 1, curve 1, LP supply 1, holders 10, signature pages 1+, early transactions up to 40, creator 1); about 76k a month at 126 READY mints a day. `RUG_FEATURES_MAX_CREDITS_PER_DAY` caps the collector per mode and trading day: once it can't fit a lookup's worst case, the holder count and sniper share record `budget`.

## 12. Storage

SQLite with versioned migrations. Suggested tables: `seen_mints`, `pending`, `positions`, `position_history`, `trades`, `trade_history` (a closed trade's `position_history`, preserved rather than deleted), `shadows`, `skip_tracks`, `post_exit_tracks`, `safety_cache`, `state` (kill, pause, halts, streaks per mode, virtual wallet), `events`. Phase 3 adds `tx_intents` (write-ahead intents, section 16.5) and `fee_losses` (fees of failed transactions, section 16.3), and extends `positions`, `trades`, `shadows` and `safety_cache` with the live fields sections 11.1, 11.2 and 16 need (signatures, raw amounts, token program, token account, decimals, sell attempts, fees spent, stuck state). Every intent and fee-loss row stores its mode. `positions` also carries the sellability loss, `dexId`, stop poll/confirmation values and the would-be-halt tag (section 11.1) until the trade is recorded. `shadows` has a `duplicate_of` column and a unique index on (mint, mode) over rows where it's null, and a `classification` column separate from the lifecycle `outcome` (section 11.2). `post_exit_tracks` records its exit price's source in `exit_price_source` (section 11.3). Price paths (section 11.5) use `price_paths` (one row per mint and mode: times, status, entry features, `selected`, sellability) and `price_path_points` (t, price, liquidity, m5 buys/sells/volume, gap). Rug-risk features (section 11.6) use `mint_features`: one row per mint and mode with every feature, the raw PumpSwap LP numbers, a JSON map of reason codes for null features, and the credits used. The `state` table also holds, per mode, the daily-loss halt's day and net loss, the loss-streak pause's start (time and streak), and which halt day and pause start were last alerted (section 9.1). The database files are gitignored.

## 13. Configuration (.env)

All values are placeholders to tune. Ship this as `.env.example` with the secrets left blank. Comments go on their own lines. Startup validation also checks: the weights sum to 1.0; the Jupiter budget (section 9.3); and `POSITION_USD ≤ HARD_MAX_POSITION_USD` (a code constant, section 16). In live mode it also checks that `PAPER_HALTS_OBSERVE_ONLY` is not `true` (section 9.1), the live interlocks (section 16.8), the RPC budget (section 16.10), `SELL_SLIPPAGE_BPS_START ≤ SELL_SLIPPAGE_BPS_MAX`, `STUCK_BACKOFF_SECONDS` values ≥ `SELL_RETRY_SECONDS`, `MAX_PRIORITY_FEE_SOL > 0`, and `SELL_FEE_BUDGET_SOL ≥ 3 × (base fee + MAX_PRIORITY_FEE_SOL)` so a position can always reach the stuck point before its budget runs out.

`SELL_FEE_RESERVE_SOL` is **derived, not configured**: `MAX_CONCURRENT × 3 × (0.000005 + MAX_PRIORITY_FEE_SOL)`, i.e. every open position's worst-case fees for three failed on-chain sell attempts (the stuck point, section 16.6) at the priority-fee cap, with a 5,000-lamport base fee for our single signature. With the defaults below it is 0.004545 SOL. It is logged at startup and shown in the digest. Setting it in `.env` is an unknown-key warning.

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
# Live mode and smoke-live only; must be empty in paper mode (startup refuses otherwise).
# Base58 string (Phantom/Solflare "export private key") or a 64-number JSON array (solana-keygen file contents).
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
# All RPC calls, including simulate and send (Helius free plan: 10/s)
RPC_MAX_RPS=8
# sendTransaction only, on top of RPC_MAX_RPS (Helius free plan: 1/s)
RPC_SEND_MAX_RPS=1

# ---- Paper mode ----
PAPER_STARTING_USDC=500
PAPER_STARTING_SOL=0.5
PAPER_EXTRA_SLIPPAGE_PCT=2
PAPER_LATENCY_SEC=3
PAPER_FEE_USD_PER_TX=0.05
# Paper only: daily-loss halt and loss-streak pause are computed, stored and alerted but don't block entries (section 9.1). MODE=live refuses to start with true.
PAPER_HALTS_OBSERVE_ONLY=false

# ---- Tracking ----
SHADOW_ENABLED=true
SHADOW_MAX_OPEN=30
SHADOW_POLL_SECONDS=15
SHADOW_POOL_FEE_PCT=1
SKIP_TRACK_MAX_PER_HOUR=60
POST_EXIT_TRACK=true
# Price paths (section 11.5, data collection only): at most this many recording at once
PATH_TRACK_MAX=100
# Price paths: seconds between points for the first PATH_FAST_WINDOW_MIN minutes after first READY (then SHADOW_POLL_SECONDS)
PATH_FAST_SECONDS=5
PATH_FAST_WINDOW_MIN=10
# Rug-risk features (section 11.6, data collection only; read-only RPC, recorded once per READY mint)
RUG_FEATURES_ENABLED=true
# Helius credits the collector may spend per trading day; costly lookups record "budget" once reached
RUG_FEATURES_MAX_CREDITS_PER_DAY=10000
# Sniper share: buys in the bonding curve's first SNIPER_SLOTS slots after launch
SNIPER_SLOTS=3
# Pages of 1000 curve signatures read to reach the launch; more records too_many_txs
SNIPER_MAX_PAGES=5
# Optional third-party report (api.rugcheck.xyz, undocumented rate limits and terms)
RUGCHECK_ENABLED=false

# ---- Notifications ----
DIGEST_INTERVAL_MINUTES=120
URGENT_ALERTS=true
OUTAGE_ALERT_MINUTES=10

# ---- Go-live checklist (information only; never blocks live mode) ----
GOLIVE_MIN_TRADES=100
GOLIVE_MIN_DAYS=7
GOLIVE_MIN_MEDIAN_PNL_PCT=0
GOLIVE_MIN_TOTAL_PNL_USD=0
GOLIVE_MIN_P10_PNL_PCT=-20

# ---- Live execution (Phase 3) ----
BUY_SLIPPAGE_BPS=300
SELL_SLIPPAGE_BPS_START=300
SELL_SLIPPAGE_BPS_MAX=2000
# Hard cap per transaction: compute-unit price x compute-unit limit, excluding the base fee
MAX_PRIORITY_FEE_SOL=0.0005
# Jupiter computeUnitPricePercentile: medium, high, veryHigh, or 0-10000 (bps). Always clamped to MAX_PRIORITY_FEE_SOL.
PRIORITY_FEE_PERCENTILE=high
MIN_SOL_BALANCE=0.05
CLOSE_EMPTY_ATA=true
SELL_RETRY_SECONDS=10
# Seconds between sell attempts once a position is stuck; the last value repeats
STUCK_BACKOFF_SECONDS=30,60,120,300,600
# Max SOL one position's sell attempts may spend on network fees before sending stops
SELL_FEE_BUDGET_SOL=0.005
TX_CONFIRM_POLL_SECONDS=2
# SELL_FEE_RESERVE_SOL is derived, not set here: MAX_CONCURRENT x 3 x (0.000005 + MAX_PRIORITY_FEE_SOL)
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
- No code path in Phases 1-2 can sign or send a transaction. From Phase 3: signing and sending vocabulary appears only under the live module, paper mode never loads the key and never reaches the send path (the send function throws if called), and the live module is loaded only when `MODE=live` or by `smoke-live`.
- Secrets are redacted in logs, including the RPC URL's `api-key`, and the wallet key in every encoding (section 16.9).
- Live-mode tests: section 16.12.

## 15. Build phases

### Phase 1: Foundation and discovery (no trading)
Build: config and validation, logger with redaction, storage and migrations, all limiters, clients (DexScreener; Jupiter quotes only; RPC read-only; Telegram), discovery and the pending queue with gate checks 1-4 (no trading decisions), SOL price, the digest (funnel and health sections), outage alerts, `/status`, `/pause`, `/resume`, `npm start`, `npm test`, README.

Done when: tests pass, and a one-hour run against real APIs with `DIGEST_INTERVAL_MINUTES=10` produces digests with plausible funnel counts and no crash.

### Phase 2: Paper trading
Build: gate checks 5-8, selection and scoring, the virtual wallet, paper fills, the monitor and exit state machine, risk blockers and controls (including `/killswitch`), shadows, skip and post-exit tracking, the full digest, the report with the go-live checklist, `/report`, and pm2 setup for Linux and Windows. pm2's own startup command doesn't support Windows, so document a working alternative there.

Done when: all section 14 tests for Phases 1-2 pass, and a short paper run opens and closes virtual positions, sends a digest, and produces a report.

### Phase 3: Live execution
Decision (2026-09-25): build Phase 3 now, while the paper go-live checklist is still being collected. The bot stays in paper mode (`MODE` defaults to `paper`). The user alone decides when to switch to live, with a small wallet holding limited funds, and doing so does not require the go-live checklist to pass. The checklist stays in the report as information; in live mode, startup logs a warning and sends a Telegram message if it isn't met, but doesn't block (section 16.8). See section 16.

Done when: `npx tsc --noEmit` is clean and all existing and new tests pass (mocked network), including the paper-mode send-path test and the tests in section 16.12, and the README documents `smoke-live`, the key format, the pm2 configuration and going live.

## 16. Live execution (Phase 3)

Requirements A1-A15 (added 2026-09-25) are folded into the subsections below and tagged. Where they conflicted with this section's earlier text, they won and the earlier text was rewritten.

Constants in code, not env vars: `HARD_MAX_POSITION_USD` = 100; base fee = 5,000 lamports per signature (every bot transaction has exactly one signature, ours); compute-unit limit maximum = 1,400,000; failed attempts before a sell is stuck = 3; shutdown wait bound = 120 seconds; `smoke-live` size = 1 USDC.

### 16.1 Jupiter endpoints (A1)

- Live swaps use Jupiter's Swap API V2 Router path: `GET https://api.jup.ag/swap/v2/build` with `inputMint`, `outputMint`, `amount` (raw units), `taker` (our wallet), `slippageBps`, `computeUnitPricePercentile` = `PRIORITY_FEE_PERCENTILE`, and `wrapAndUnwrapSol=true`, and no `tipAmount`. It returns the quote (`inAmount`, `outAmount`, `otherAmountThreshold`), raw instructions, address lookup tables, and a recent blockhash with its `lastValidBlockHeight`. The bot assembles a v0 transaction from them, simulates it, verifies it (16.2), signs it and sends it through `SOLANA_RPC_URL`. Jupiter charges no swap fee on `/build`; the only costs are Solana network fees (base + priority) and token-account rent. Buys use `BUY_SLIPPAGE_BPS`.
- Not used: the Meta-Aggregator path (`GET /swap/v2/order` + `POST /swap/v2/execute`). It lands transactions better (Jupiter's own landing pipeline, real-time slippage, competing routers including RFQ market makers), but Jupiter assembles the transaction and it can't be modified, RFQ fills are co-signed by the market maker after we sign (so the bytes we simulate are not the bytes that land), Jupiter chooses the priority fee, and it charges a platform fee of 10 bps on most pairs and 50 bps on tokens less than 24 hours old, which is most of what this bot trades. Also not used: `tx.jup.ag` (Jupiter's landing for self-built transactions), which requires a 0.001 SOL tip per transaction, above the default priority-fee cap.
- Tradeoff accepted: landing depends on our RPC and our capped priority fee, so under congestion some transactions expire unlanded. An expired transaction costs nothing; the bot resends the same signed bytes until expiry and then rebuilds (16.4).
- Quote-only calls (sellability, monitoring, stop-loss confirmation, the entry valuation) keep using `GET /swap/v1/quote` in both modes, so paper and live PnL marks stay comparable. Both endpoints use Jupiter's Metis routing. Decision (2026-09-25): keep `/swap/v1/quote` for quotes in both modes. Jupiter's docs describe `/swap/v1` as the source of a migration to `/swap/v2/build`; if it is withdrawn, that needs a new decision (for paper mode too, because `/build` requires a `taker`).

### 16.2 Building, simulating and verifying every transaction (A9)

Every transaction the bot signs (buys, sells, `smoke-live` legs) goes through these steps. A transaction is only ever sent as the exact bytes that passed verification.

1. **Check the Jupiter response**: `inputMint`, `outputMint` and `inAmount` match the request, `otherAmountThreshold` is present, and there is no `tipInstruction`. For USDC input, the requested amount must be ≤ `HARD_MAX_POSITION_USD` × 10^6 raw units, independently of the expected amount (this catches decimal bugs).
2. **Compute budget**: simulate once with a 1,400,000 compute-unit limit (`replaceRecentBlockhash=true`), then set the limit to ceil(1.2 × units consumed), capped at 1,400,000. Take the compute-unit price from Jupiter's `setComputeUnitPrice` instruction and lower it, if needed, so that ceil(price × limit / 10^6) ≤ `MAX_PRIORITY_FEE_SOL` in lamports.
3. **Assemble** the v0 transaction: compute budget, Jupiter's setup instructions, the swap instruction, Jupiter's cleanup and other instructions, then (full sells only) the `closeAccount` instruction (16.6). The fee payer is our wallet.
4. **Sign**, then **simulate the signed bytes** with `sigVerify=true`, `commitment=confirmed`, `innerInstructions=true`, and `accounts` set to our token accounts in the transaction (jsonParsed).
5. **Refuse** unless every check passes (all amounts in raw units; "ours" = owned by our wallet):
   - a. The fee payer is our wallet, and our wallet is the only required signer.
   - b. The simulation has no error, and it returned `fee`, `preBalances`, `postBalances`, `preTokenBalances` and `postTokenBalances`. If the RPC omits any of the four balance fields, the **fallback** (`src/live/simFallback.ts`) supplies them: immediately before simulating, one `getMultipleAccounts` reads the pre-state of every writable account in the transaction (which includes our wallet, our token accounts, and every account the transaction will create); the simulation requests the post-state of the same accounts through `accounts` (jsonParsed); balances are derived from the two. The first time the RPC omits the fields, the transaction is simulated once more right after the pre-read; from then on (per process) the pre-read comes first. The fallback fails closed if any account is missing from either side, if the wallet isn't System-owned on both sides, if an account the transaction creates ends up owned by anything but Token/Token-2022, if a Token/Token-2022-owned account can't be parsed, or if the two sides are inconsistent (different account sets, a token account whose mint or owner changed). Residual race, documented: the pre-state is read one RPC round trip before the simulation runs, and state can change in between. An outgoing change (for example a token balance moving) usually makes a genuine transaction fail verification, which is safe. An incoming transfer to our wallet or token accounts in that window inflates the measured change and could hide an outflow of up to the same amount from the balance checks (d-g); the instruction-level checks (h, i) still catch explicit transfers from our wallet and authority changes, and the primary path (balances from the simulation itself) has no such window. `smoke-live`'s dry run prints which source was used (`simulation` or `fallback`).
   - c. There is exactly one `setComputeUnitLimit` and one `setComputeUnitPrice`, priority fee = ceil(price × limit / 10^6) lamports ≤ `MAX_PRIORITY_FEE_SOL`, and the simulated `fee` equals 5,000 + that priority fee.
   - d. Input: our balance of the input mint decreases by at most the requested amount. Swaps are ExactIn, so slippage applies only to the output. For USDC input, the simulated decrease is also ≤ `HARD_MAX_POSITION_USD` × 10^6.
   - e. Output: our balance of the output mint increases by at least the quote's `otherAmountThreshold` (minimum out).
   - f. No other token balance of ours changes, except the sold token account going to zero and being closed (full sells).
   - g. SOL: our wallet's lamport change ≥ `minOutSol` + `rentReclaimed` − `fee` − `rentNew` − `solIn`, where `fee` is from check c; `rentNew` is the lamports held after the transaction by accounts that had none before and are token accounts we own; `rentReclaimed` is the lamports held before the transaction by our token accounts that it closes; `solIn` is the input amount when SOL is the input mint; and `minOutSol` is `otherAmountThreshold` when SOL is the output mint. A temporary wrapped-SOL account that is created and closed within the transaction counts as neither new nor reclaimed, so SOL received from a swap is never mistaken for fees or rent.
   - h. No instruction, top-level or inner, transfers SOL from our wallet to anything except our own wrapped-SOL token account (wrapping SOL when SOL is the input). No instruction funds a new account other than a token account we own, or assigns our wallet to another program. No tips: `/build` is called without `tipAmount`, and we don't use a landing service that requires one.
   - i. No instruction changes an owner, authority, delegate or close authority on any of our token accounts (`SetAuthority`, `Approve`, `ApproveChecked`), and in the simulated post-state every one of our token accounts has our wallet as owner, no delegate and no close authority.
   - j. Every token account we own in the post-state holds USDC, wrapped SOL or the traded mint.
6. **Fail closed** wherever the Jupiter response, the RPC or the docs give an unexpected shape. Top level allows exactly: the two compute-budget instructions; associated-token-account creation paid by and owned by our wallet, for USDC, wrapped SOL or the traded mint; a system transfer from our wallet only into our own wrapped-SOL account when SOL is the input; Token/Token-2022 `syncNative` on our wrapped-SOL account and `closeAccount` of our account to our wallet; and exactly one instruction of Jupiter's aggregator program (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`; the Swap V2 docs don't print it, so smoke-live's dry run is where a mismatch would first show, as a refusal). Also refused: a missing or mistyped field, an instruction from a program or with a discriminator the verifier doesn't know how to judge (only the programs whose effects on our accounts are checked above are allowed at top level: compute budget, system, associated token, Token, Token-2022, and Jupiter's program for the swap instruction itself; inner instructions from other programs are allowed only because their effects appear in the balance and post-state checks), or a token account whose owner program is neither Token nor Token-2022. Each of these is a refusal.
7. A refused transaction is never sent, costs no fee, and triggers an urgent alert naming the failed check. A refused buy counts as a failed entry (section 9.1 errors). A refused sell counts as a failed sell attempt (16.6). If one DEX keeps producing refused transactions (for example because it creates its own per-user accounts), the fix is to exclude it via `/build`'s `excludeDexes`, never to relax a check.

### 16.3 Real fills, fees and rent (A2)

- Cost basis and proceeds come from the confirmed transaction (`getTransaction`, jsonParsed, `maxSupportedTransactionVersion: 0`), never from the quote: token and USDC amounts from our pre/post token balances, the network fee from `meta.fee`, and rent from our wallet's lamport changes. All SOL amounts are converted to USD at the section 3 SOL/USD price at confirmation time; that price is stored with the trade. Live entries are blocked until a SOL/USD price has been fetched.
- **Buy**: tokens = the increase in our token account; cost basis USD = USDC spent + (network fee + rent paid for the new token account) in USD.
- **Sell**: proceeds USD = USDC received + (rent reclaimed − network fee) in USD. Net PnL = proceeds − cost basis.
- **Fee losses**: a transaction that lands but fails on-chain still pays its network fee. That fee is recorded in `fee_losses` (mode, time, trading day, mint, position, signature, lamports, USD) as a realized loss. It counts in daily loss (section 9.1) and in the report's total net PnL and drawdown (section 11.4), but never in a trade's PnL, so nothing is counted twice. A trade stores the sum of its failed sell fees for information only. A transaction that expires unlanded pays no fee; it is counted in the digest's health section but adds no loss.

### 16.4 Sending, confirmation and blockhash expiry (A8)

- Before sending, persist the intent (16.5). Send with `sendTransaction` (base64, `skipPreflight=true` since the exact bytes were just simulated, `maxRetries=0`), and resend the same signed bytes every 2 × `TX_CONFIRM_POLL_SECONDS` until the transaction is confirmed, failed or expired. Resending identical bytes can't create a second transaction: it has the same signature.
- Confirmation: every `TX_CONFIRM_POLL_SECONDS`, one `getSignatureStatuses` call covers every in-flight signature. `confirmed` or `finalized` with no error = landed; with an error = failed on-chain (fee paid, 16.3).
- Expiry: once a status has stayed empty for 30 seconds, each poll also calls `getBlockHeight`. When the block height passes the intent's `lastValidBlockHeight`, call `getSignatureStatuses` once more with `searchTransactionHistory=true`. Only if the signature is still not found is the intent marked expired. Only then may a new transaction for that position and side be built: a sell's next attempt rebuilds with a fresh `/build`; a buy does not rebuild. The entry attempt ends and the mint stays READY, so any later entry repeats the section 6.2 checks with fresh quotes.
- Never two live transactions for the same position and side (for buys: the same mint) at once. This is enforced by a partial unique index over every unresolved intent status (`pending`: reserved before building; `signed`: built, verified and signed but not yet sent; `sent`: sent, awaiting confirmation; `landed`: confirmed but not yet applied), and checked twice: before building and again before signing. A second attempt for the same position and side is refused while any of those intents exists.

### 16.5 Write-ahead intents and startup reconciliation (A7)

- **Intent**: a `pending` intent row reserves the position and side before anything is built; it becomes `signed` with the signature and signed bytes before anything is sent, then `sent`. A `pending` or `signed` intent that never reached the network (a refusal, an error, a crash) is resolved as `abandoned`: a `signed` one only after its `lastValidBlockHeight` has passed with its signature not found, since it can't be proven unsent before that. Before any transaction is sent, the bot has persisted a `tx_intents` row with: kind (`buy`, `sell`, `smoke`), mode, mint, position id (sells) or entry key (buys), side, signature (computed from the signed transaction), the signed transaction bytes (base64: public once sent, and needed to resend after a restart), `lastValidBlockHeight`, expected amounts (requested input, quoted output, minimum output), status, and timestamps. A buy intent also stores everything needed to build the position: size, liquidity, the entry pair snapshot, score and components, holder and safety results, token program and decimals.
- **Resolution** runs on startup for every unresolved intent, and before any retry or rebuild for that position and side. It calls `getSignatureStatuses` with `searchTransactionHistory=true`:
  - landed: apply it from `getTransaction` (below);
  - failed on-chain: record the fee loss;
  - not found, and block height past `lastValidBlockHeight`: expired;
  - not found, and not yet past it: still in flight, so keep resending and confirming (16.4).
- **Applying a landed buy** that has no position yet creates a normal managed position from the confirmed transaction and the stored snapshot, never an "unknown token". Entry time is the transaction's block time, and the exit state (section 8.2) starts from it, so deadlines stay absolute. An urgent message reports the recovery.
- **Applying a landed sell** whose position is still open or closing closes it with its real proceeds (16.3) and the stored pending exit reason.
- **Reconciliation** runs after intent resolution, at startup and whenever a live sell finds a zero balance. It compares live positions with the wallet's token accounts (`getTokenAccountsByOwner`, once for the Token program and once for Token-2022), ignoring USDC, SOL and wrapped SOL:
  - Tokens held with no position and no intent are "unknown tokens": listed in the digest, one urgent message when first seen, never traded automatically.
  - A position with a zero on-chain balance and no landed sell closes with reason `reconciled` and proceeds 0, and its trade is flagged `proceeds_unknown` (the loss may not be real: for example, the user sold manually). The report and the digest show `proceeds_unknown` trades separately from the other trades and exclude them from win rate, median, mean and percentile stats; they still count in total net PnL, drawdown and daily loss, conservatively.
  - Nothing is closed as `reconciled` or reported as an unknown token while an unresolved intent exists for that position or mint; reconciliation skips it until the intent is resolved.
  - A `reconciled` close does NOT count toward the loss streak (`CONSECUTIVE_LOSS_PAUSE`): it neither extends nor resets it, since it may not be a real loss. It still counts in daily loss (conservative).
  - A position whose on-chain balance differs from the stored amount keeps running with the on-chain amount, and the difference is logged.
  - Empty token accounts left open are counted in the digest.
- Intents are never deleted; resolved ones stay for audit.

### 16.6 Sells, retries, stuck positions and fee budget (A10, A11, A3)

- **Amount (A11)**: every live sell, including kill-switch sells, sells the token account's on-chain balance, read right before `/build`, never the stored amount. A zero balance sends nothing and goes to reconciliation.
- **Attempt n** (n = previous attempts that didn't land successfully, from 0): resolve any open intent for the position, read the balance, call `/build` on the exit lane with slippage min(`SELL_SLIPPAGE_BPS_MAX`, `SELL_SLIPPAGE_BPS_START` × 2^n), verify (16.2), send (16.4).
- **Failed attempts**: no route from Jupiter, a simulation error or a verification refusal (nothing sent, no fee); a transaction that failed on-chain (fee paid and recorded); an expired transaction (no fee).
- **Stuck**: after 3 failed attempts the position becomes `stuck`, with one urgent alert. Retries continue, but on the `STUCK_BACKOFF_SECONDS` schedule (default 30, 60, 120, 300, 600 seconds, then every 600) instead of every `SELL_RETRY_SECONDS`. Failed on-chain sells cost fees, and at 10-second intervals they would drain a small wallet's SOL within hours.
- **Fee budget**: before each send, if the network fees already paid by this position's sell attempts plus this attempt's maximum (base fee + `MAX_PRIORITY_FEE_SOL`) would exceed `SELL_FEE_BUDGET_SOL`, nothing is sent, the position is marked `budget_exhausted`, and one urgent alert says so. After that, the bot only reads the position's on-chain balance on the last backoff interval (no Jupiter calls, no sends), so a manual sale is picked up by reconciliation. `/sellretry <mint prefix>` (configured chat only) grants the position one more `SELL_FEE_BUDGET_SOL` and resumes attempts on the backoff schedule. The prefix must match exactly one stuck live position (`stuck` or `budget_exhausted`); zero or several matches change nothing and the reply says why.
- Live mode never writes off a position (section 8.4's `written_off` is paper-only): its tokens are still in the wallet.
- **Closing the token account (A3)**: when `CLOSE_EMPTY_ATA=true` and the sell is for the full balance, the sell transaction ends with a `closeAccount` instruction for our token account (destination and owner: our wallet), built with the mint's own token program: Token or Token-2022, read from the mint account's owner (cached with the safety result). If simulation fails only because of the close (the account isn't empty after the swap), the attempt rebuilds once without it and the account is left open. The reclaimed rent is part of proceeds (16.3). Section 5 check 7 already rejects Token-2022 mints with transfer fees, so the swap moves exactly the input amount and leaves the account empty.

### 16.7 Wallet checks and the sell fee reserve (A4)

- Before each entry, on-chain balances read right before building: USDC ≥ size, and SOL − worst-case buy cost ≥ max(`MIN_SOL_BALANCE`, `SELL_FEE_RESERVE_SOL`), where worst-case buy cost = base fee + `MAX_PRIORITY_FEE_SOL` + 0.0025 SOL for new token-account rent. Verification (16.2 g) bounds the rent actually spent.
- `SELL_FEE_RESERVE_SOL` (derived, section 13) is never spent on entries.
- While any live position is open, SOL is read at least every 60 seconds and at every live balance read. If it drops below `SELL_FEE_RESERVE_SOL`, one urgent alert goes out per episode, plus one on recovery. Sells continue regardless.

### 16.8 Interlocks, mode switching and smoke-live (A5)

- `MODE=live` starts only if `LIVE_ACK=I_ACCEPT_REAL_LOSSES` exactly, `WALLET_PRIVATE_KEY` parses to a valid 64-byte key pair (16.9), `POSITION_USD ≤ HARD_MAX_POSITION_USD`, and the Jupiter and RPC budgets validate (section 9.3, 16.10). Every live USDC input is also checked against `HARD_MAX_POSITION_USD` at build and at verification (16.2).
- Paper mode refuses to start if `WALLET_PRIVATE_KEY` is non-empty, never loads the key, and never loads the live module. The send function throws if it is ever reached outside live mode or `smoke-live --send`.
- On a live start, if the paper go-live checklist (section 11.4) isn't met, startup logs a warning and sends a Telegram message listing the failed items, then continues. It never blocks.
- **Single instance**: in every mode, and however the bot is launched (pm2, `npm start`, or tsx directly), the very first thing startup does is read this folder's database heartbeat (`lastAliveAt`, the same heartbeat smoke-live checks), read-only and before loading config, writing logs or running migrations. If the heartbeat is less than 2 minutes old, startup refuses with: "Refusing to start: this folder's database heartbeat is less than 2 minutes old, so another instance may already be running. Check `pm2 status` (and any terminal running `npm start`) first." Exception: a graceful shutdown (section 16.11) writes its final heartbeat together with `cleanShutdownAt`; a heartbeat with `cleanShutdownAt ≥ lastAliveAt` doesn't count, so a restart right after a clean stop proceeds. No heartbeat at all, or one 2 minutes old or older, proceeds normally.
- Mode switching: startup refuses, listing the rows, while positions or unresolved intents of the other mode exist. Paper positions are virtual, and a live position must never be left unmanaged.
- `npm run smoke-live`: the same interlocks as live mode, so it runs only from a folder configured for `MODE=live`. It refuses if the heartbeat in this folder's database is less than 2 minutes old (a bot running from this same folder). It can't see a bot running from another folder, so the paper bot must be stopped first (README). It never touches any token except USDC and SOL, and creates no positions or trades. Its transactions are intents of kind `smoke`, and its fees are printed in its output rather than counted in live limits.
  - **Default: dry run.** Builds the $1 USDC → SOL leg (1,000,000 raw USDC) and the SOL → USDC leg for that quote's output, simulates and verifies both (16.2), and prints the verification results, the balance source used (`simulation` or `fallback`), and the fees each leg would pay. It never sends. The second leg is verified only if the wallet already holds that much SOL; otherwise the dry run says so.
  - **`npm run smoke-live -- --send`**: prints the public address, the amounts and the maximum fees, then requires the user to type the confirmation phrase `send 1 usdc` in an interactive terminal (it refuses when stdin isn't a TTY). It then runs leg 1, confirms it, and measures the SOL actually received from the confirmed transaction. Leg 2 sells exactly that amount. It prints the full accounting: USDC in and out, each fee in SOL and USD, and the net cost.

### 16.9 Private key and redaction (A6)

- Accepted formats for `WALLET_PRIVATE_KEY`: a base58 string of the 64-byte secret key (what Phantom and Solflare export) or a JSON array of 64 numbers (the contents of a `solana-keygen` key file). Anything else refuses to start with a message that never echoes the value. The public half must match the key derived from the private half.
- The key is read only in live mode and by `smoke-live`, after the redaction list has been extended with all its encodings. The decoded bytes are imported into a non-extractable signing key and then zeroed. The value is deleted from `process.env` and kept out of the config object, so no config dump can contain it.
- Redaction covers log lines, Telegram messages, error messages and stack traces, the fatal/uncaught-exception handlers, and config errors. It scrubs the 64-byte key and its 32-byte private half in every encoding: base58, JSON array (any whitespace), comma-separated decimal bytes, base64, base64url, and hex (either case, with or without separators). Byte arrays (`Uint8Array`, `Buffer`) in log metadata are never printed.
- Startup logs only the wallet's public address.

### 16.10 Request budgets (A13)

Requests per live trade, with default settings:

| | Jupiter | RPC |
|---|---|---|
| Live buy | 2 sellability quotes (entry lane, cached 10 min per mint) + 1 `/swap/v2/build` (entry lane; it is also the drift check) + 1 valuation quote after the fill (exit lane) | 1 `getMultipleAccounts` (SOL + USDC balances), 2 `simulateTransaction`, 1 `sendTransaction` plus a resend every 4 s until landed, shared `getSignatureStatuses` polls (typically 1-5), `getBlockHeight` only after 30 s unconfirmed, 1 `getTransaction`. Typically about 8 calls. Worst case (expiry after about 90 s): about 100 calls spread over 90 s. |
| Live sell attempt | 1 `/swap/v2/build` (exit lane) per attempt | The same as a buy; its `getMultipleAccounts` reads the token account's on-chain balance (A11) and SOL. |
| Monitoring (both modes) | 1 quote per open position per `POLL_SECONDS` (exit lane), +1 for a stop-loss confirmation | none |

When the simulation fallback (16.2 b) is used, each verification adds one `getMultipleAccounts` call.

- RPC defaults assume the Helius free plan (10 requests/s overall, `sendTransaction` 1/s); `RPC_MAX_RPS=8` leaves a margin under the plan limit. Every rate limit is a config value, never hard-coded.
- Every RPC call goes through `RPC_MAX_RPS`, and `sendTransaction` also through `RPC_SEND_MAX_RPS`. The RPC limiter has two lanes: transaction-lane calls (live balance reads, simulate, send, status, block height, `getTransaction`) are served before read-lane calls (gate checks, reconciliation) whenever both are waiting.
- **Live startup validation**: `RPC_SEND_MAX_RPS ≥ 1`, and `RPC_MAX_RPS ≥ 2 / TX_CONFIRM_POLL_SECONDS + min(RPC_SEND_MAX_RPS, MAX_CONCURRENT / 4) + 2` (status and block-height polls, resends, and headroom for simulations and balance reads). With the defaults that is 3.75 ≤ 8. Otherwise refuse to start with a clear message. The section 9.3 Jupiter validation uses the live `exitReserve`.
- An RPC 429 backs off with jitter and never counts as an error. The digest reports RPC calls per window so they can be checked against the provider's monthly quota (Helius free plan: 1M credits, 1 credit per standard call).

### 16.11 Graceful shutdown (A14)

- Triggers: `SIGINT` (Ctrl+C), `SIGTERM` (Linux), and a process `message` event with the value `shutdown`. On Windows, `pm2 stop` delivers no signal, so pm2 runs with `shutdown_with_message: true` and sends that message instead.
- Sequence: stop new entries and new sell attempts; stop the loops; wait for in-flight transactions to confirm, fail or expire (their `lastValidBlockHeight` passes), still resending and confirming as usual, bounded by 120 seconds; wait for in-flight paper fills too; persist state and the heartbeat; close the database; exit 0. Intents still unresolved at the bound are resolved on the next start. Open, closing and stuck positions resume on the next start.
- A second trigger during shutdown only logs that shutdown is in progress. pm2's `kill_timeout` is the hard bound.
- The pm2 config is an `ecosystem.config.cjs` in the repo with `shutdown_with_message: true` and `kill_timeout: 150000` (above the 120-second bound). The README gives the exact commands to switch the running process to it.

### 16.12 Tests (A15)

Mocked network only; done when `npx tsc --noEmit` is clean and all existing and new tests pass. Required, in addition to section 14:

- Mocked end-to-end live buy and sell, with cost basis and proceeds taken from the confirmed transaction's balance changes, not the quote, and fees and rent converted to USD.
- Slippage escalation; stuck after 3 failures; the backoff schedule; the per-position fee budget stopping sends; simulation failure never sending; fee losses from failed transactions in daily loss and in the report.
- Verification rejecting each case in 16.2 step 5, including an unexpected balance change, an owner or delegate change, SOL beyond fees and rent, a SOL transfer to another account, output below the minimum, a priority fee above the cap, and USDC input above `HARD_MAX_POSITION_USD` in raw units; and accepting SOL as the output mint (wrap and unwrap) without confusing it with fees.
- Intents: an unrecorded landed buy becomes a managed position; an unrecorded landed sell closes with real proceeds; reconciliation ignores USDC and SOL, reports unknown tokens, and closes zero-balance positions as `reconciled`.
- Blockhash expiry: no rebuild if the old signature landed; a rebuild only after confirmed expiry; never two live transactions for the same position and side.
- Closing the token account under Token and under Token-2022.
- The interlocks; paper mode never loading the key and never reaching the send path (the send function throws if called); the key never appearing in log output in any encoding; per-mode daily loss and loss streak.
- Graceful shutdown with a transaction in flight, via `SIGINT` and via the pm2 `shutdown` message.
- The one-transaction guard: an intent persisted but not yet sent (`pending` or `signed`) refuses a second attempt for the same position and side, both before building and before signing.
- Reconciliation never closes a position as `reconciled`, and never reports its tokens as unknown, while an unresolved intent exists for it.
- Fail closed on unexpected shapes: missing simulation fields (primary path and fallback), unknown instructions, unknown token programs; a refused transaction is never sent.
- `/sellretry`: exactly one match required; configured chat only.
- `proceeds_unknown` trades shown separately in the report and digest.
