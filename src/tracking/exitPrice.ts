import { selectPair } from "../clients/dexscreener.js";
import type { Logger } from "../logger/index.js";
import type { DexPair } from "../types.js";

/**
 * SPEC.md section 11.3: the post-exit baseline is the DexScreener priceUsd at
 * exit, fetched once when the trade is recorded (never Jupiter). Null when the
 * fetch fails, the mint has no valid pair, or the price isn't positive; such
 * rows are left out of the exited-too-early figures.
 */
export async function dexPriceAtExit(
  getPairs: (mints: string[]) => Promise<DexPair[]>,
  mint: string,
  allowedQuoteMints: readonly string[],
  logger: Pick<Logger, "warn">,
): Promise<number | null> {
  try {
    const pair = selectPair(await getPairs([mint]), mint, allowedQuoteMints);
    const price = Number(pair?.priceUsd ?? NaN);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch (err) {
    logger.warn("Exit price fetch failed; post-exit track has no baseline", { mint, error: String(err) });
    return null;
  }
}
