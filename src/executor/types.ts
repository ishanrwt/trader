import type { PositionRow } from "../storage/positions.js";
import type { ReadyCandidate } from "../selection/index.js";

/**
 * The mode-specific half of trading (SPEC.md sections 7, 8.4, 16): how an
 * entry is quoted and filled, how a closing position's exit is attempted,
 * how an open position is valued, and what the wallet holds. src/index.ts
 * drives both modes through this one interface: the paper implementation is
 * the Phase 2 code unchanged; the live one delegates to src/live/ (loaded
 * only when MODE=live).
 */
export interface TradeExecutor {
  readonly mode: "paper" | "live";
  /** Section 6.2 step 3: the execution quote for the drift check (live: the /build for the actual buy). */
  getExecutionQuote(mint: string, sizeUsd: number): Promise<{ tokensOut: number } | null>;
  canAfford(usdcAmount: number): boolean;
  /** Fills the entry and records the position. Not awaited inline by slot filling. Throws on a failure that counts as a failed entry. */
  open(candidate: ReadyCandidate, execution: { tokens: number; sizeUsd: number }): Promise<void>;
  /** One exit attempt for a closing position. Fire-and-forget safe. */
  exitAttempt(row: PositionRow): Promise<void>;
  /** The raw token amount to quote when valuing the position (paper: stored amount x decimals; live: the on-chain amount). */
  exitQuoteAmountRaw(row: PositionRow): string;
  /** valueUsd = quoteOut − this (paper: PAPER_FEE_USD_PER_TX; live: worst-case exit fee minus reclaimable rent). */
  exitCostUsd(row: PositionRow): number;
  walletBalances(): { usdc: number; sol: number };
}
