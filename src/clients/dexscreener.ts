import { SOLANA_CHAIN_ID } from "../constants.js";
import type { SlidingWindowLimiter } from "../limiters/slidingWindow.js";
import type { Logger } from "../logger/index.js";
import type { DexPair, TokenProfile } from "../types.js";
import { fetchJson } from "./http.js";

const DEFAULT_BASE_URL = "https://api.dexscreener.com";
const MAX_ADDRESSES_PER_REQUEST = 30;

/**
 * Pair selection rule (SPEC.md section 3, as clarified): among a mint's pairs
 * with chainId "solana" where baseToken.address equals `mint` and
 * quoteToken.address is in `allowedQuoteMints`, pick the highest liquidity.usd.
 * Used both for gate/holders checks (mint = the candidate token) and for the
 * SOL/USD price (mint = wrapped SOL, allowedQuoteMints = USDC/USDT).
 */
export function selectPair(pairs: readonly DexPair[], mint: string, allowedQuoteMints: readonly string[]): DexPair | null {
  const allowed = new Set(allowedQuoteMints);
  let best: DexPair | null = null;
  for (const pair of pairs) {
    if (pair.chainId !== SOLANA_CHAIN_ID) continue;
    if (pair.baseToken?.address !== mint) continue;
    if (!allowed.has(pair.quoteToken?.address ?? "")) continue;
    const liq = pair.liquidity?.usd ?? 0;
    if (!best || liq > (best.liquidity?.usd ?? 0)) best = pair;
  }
  return best;
}

/** Every valid pair for `mint` under the pair selection rule, not just the highest-liquidity one — used by the holders check (section 5, check 8) to exclude pool-vault balances across all of a mint's pairs. */
export function selectAllValidPairs(pairs: readonly DexPair[], mint: string, allowedQuoteMints: readonly string[]): DexPair[] {
  const allowed = new Set(allowedQuoteMints);
  return pairs.filter(
    (pair) => pair.chainId === SOLANA_CHAIN_ID && pair.baseToken?.address === mint && allowed.has(pair.quoteToken?.address ?? ""),
  );
}

export interface DexScreenerClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  profilesLimiter: SlidingWindowLimiter;
  pairsLimiter: SlidingWindowLimiter;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

interface RawTokenProfile {
  chainId?: string;
  tokenAddress?: string;
  description?: string;
  url?: string;
}

export class DexScreenerClient {
  constructor(private readonly opts: DexScreenerClientOptions) {}

  async getLatestProfiles(): Promise<TokenProfile[]> {
    await this.opts.profilesLimiter.acquire();
    const data = await this.request<RawTokenProfile[]>("/token-profiles/latest/v1", "DexScreener profiles");
    if (!Array.isArray(data)) return [];
    return data
      .filter((p): p is RawTokenProfile & { tokenAddress: string } => typeof p.tokenAddress === "string")
      .map((p) => ({
        chainId: p.chainId ?? "unknown",
        tokenAddress: p.tokenAddress,
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.url !== undefined ? { url: p.url } : {}),
      }));
  }

  /** Batches of up to 30 addresses per SPEC.md section 3. */
  async getPairs(chainId: string, addresses: readonly string[]): Promise<DexPair[]> {
    if (addresses.length === 0) return [];
    if (addresses.length > MAX_ADDRESSES_PER_REQUEST) {
      throw new Error(`getPairs: ${addresses.length} addresses exceeds the max of ${MAX_ADDRESSES_PER_REQUEST}`);
    }
    await this.opts.pairsLimiter.acquire();
    const data = await this.request<DexPair[] | { pairs?: DexPair[] }>(
      `/tokens/v1/${chainId}/${addresses.join(",")}`,
      "DexScreener pairs",
    );
    if (Array.isArray(data)) return data;
    return data?.pairs ?? [];
  }

  private async request<T>(path: string, label: string): Promise<T> {
    const url = `${this.opts.baseUrl ?? DEFAULT_BASE_URL}${path}`;
    return fetchJson<T>(url, {
      headers: { accept: "application/json" },
      timeoutMs: this.opts.timeoutMs ?? 8000,
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      logger: this.opts.logger,
      label,
    });
  }
}
