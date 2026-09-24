import { sleep as defaultSleep } from "../limiters/clock.js";

export interface PaperFillConfig {
  latencySec: number;
  extraSlippagePct: number;
  feeUsdPerTx: number;
}

export interface BuyQuote {
  tokensOut: number;
}
export interface SellQuote {
  usdcOut: number;
}

/**
 * SPEC.md section 7: paper entry fill. Waits PAPER_LATENCY_SEC, fetches a
 * fresh quote, applies PAPER_EXTRA_SLIPPAGE_PCT, adds PAPER_FEE_USD_PER_TX to
 * cost basis. Returns null if there's no route (caller decides what to do —
 * for an entry this means the candidate is skipped, not written off).
 *
 * Callers MUST NOT await this inline in a loop over other positions/candidates
 * — the latency sleep would block their polling. Fire it and let it resolve
 * independently (see monitor/index.ts's pollOpenPositions for the pattern).
 */
export async function paperEntryFill(
  sizeUsd: number,
  fetchQuote: () => Promise<BuyQuote | null>,
  cfg: PaperFillConfig,
  sleepFn: (ms: number) => Promise<void> = defaultSleep,
): Promise<{ tokens: number; costBasis: number } | null> {
  await sleepFn(cfg.latencySec * 1000);
  const quote = await fetchQuote();
  if (!quote) return null;
  const tokens = quote.tokensOut * (1 - cfg.extraSlippagePct / 100);
  const costBasis = sizeUsd + cfg.feeUsdPerTx;
  return { tokens, costBasis };
}

/** SPEC.md section 7: paper exit fill. Same shape as the entry fill, in the sell direction. */
export async function paperExitFill(
  fetchQuote: () => Promise<SellQuote | null>,
  cfg: PaperFillConfig,
  sleepFn: (ms: number) => Promise<void> = defaultSleep,
): Promise<{ proceeds: number } | null> {
  await sleepFn(cfg.latencySec * 1000);
  const quote = await fetchQuote();
  if (!quote) return null;
  const proceeds = quote.usdcOut * (1 - cfg.extraSlippagePct / 100) - cfg.feeUsdPerTx;
  return { proceeds };
}

/**
 * SPEC.md section 8.4: "Paper mode with no route: keep trying every poll; if
 * there's still no route after STUCK_WRITE_OFF_MIN, close at -100% with
 * reason written_off." This is a separate timer from the state machine's
 * noRouteSince (section 8.3 step 1) — it only starts once a SELL has already
 * been decided and the position has entered `closing`.
 */
export function shouldWriteOff(closingSince: number, now: number, stuckWriteOffMin: number): boolean {
  return now - closingSince >= stuckWriteOffMin * 60_000;
}
