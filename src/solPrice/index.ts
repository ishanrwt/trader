import type { DexScreenerClient } from "../clients/dexscreener.js";
import { selectPair } from "../clients/dexscreener.js";
import { SOLANA_CHAIN_ID, WRAPPED_SOL_MINT } from "../constants.js";
import { systemClock, type Clock } from "../limiters/clock.js";
import type { Logger } from "../logger/index.js";

export interface SolPriceState {
  priceUsd: number | null;
  updatedAt: number | null;
}

/**
 * SPEC.md section 3: SOL/USD, refreshed every 5 minutes from DexScreener
 * (never Jupiter), using the pair-selection rule with baseToken = wrapped SOL
 * and quoteToken = USDC or USDT.
 */
export class SolPriceTracker {
  private state: SolPriceState = { priceUsd: null, updatedAt: null };
  private readonly clock: Clock;

  constructor(
    private readonly dexClient: DexScreenerClient,
    /** ALLOWED_QUOTE_MINTS with wrapped SOL removed (SOL can't be its own quote). */
    private readonly quoteMints: readonly string[],
    private readonly logger: Logger,
    clock: Clock = systemClock,
  ) {
    this.clock = clock;
  }

  get(): SolPriceState {
    return this.state;
  }

  /** Never throws — a failed refresh just keeps the last known price. */
  async refresh(): Promise<void> {
    try {
      const pairs = await this.dexClient.getPairs(SOLANA_CHAIN_ID, [WRAPPED_SOL_MINT]);
      const pair = selectPair(pairs, WRAPPED_SOL_MINT, this.quoteMints);
      const priceUsd = pair?.priceUsd !== undefined ? Number(pair.priceUsd) : NaN;
      if (!pair || !Number.isFinite(priceUsd)) {
        this.logger.warn("SOL/USD price refresh found no valid pair");
        return;
      }
      this.state = { priceUsd, updatedAt: this.clock.now() };
    } catch (err) {
      this.logger.warn("SOL/USD price refresh failed", { error: String(err) });
    }
  }
}
