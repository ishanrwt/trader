import type { SlidingWindowLimiter } from "../limiters/slidingWindow.js";
import type { Logger } from "../logger/index.js";
import { fetchJson } from "./http.js";

const DEFAULT_BASE_URL = "https://api.jup.ag";

export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  /** Raw atomic-unit amount, as a string to avoid precision loss on large values. */
  amount: string;
  slippageBps: number;
}

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold?: string;
  priceImpactPct?: string;
  [key: string]: unknown;
}

export interface JupiterClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** The single physical limiter from SPEC.md section 9.3: JUPITER_MAX_REQ_PER_MIN + JUPITER_MIN_INTERVAL_MS. */
  physicalLimiter: SlidingWindowLimiter;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

/**
 * Quotes only in Phase 1-2 (SPEC.md section 15). Swap-build/execute endpoints
 * are added in Phase 3. Callers decide entry vs. exit lane admission via
 * JupiterLaneBudget before calling this; this client only makes the call.
 */
export class JupiterClient {
  constructor(private readonly opts: JupiterClientOptions) {}

  async getQuote(params: JupiterQuoteParams): Promise<JupiterQuoteResponse> {
    await this.opts.physicalLimiter.acquire();
    const url = new URL(`${this.opts.baseUrl ?? DEFAULT_BASE_URL}/swap/v1/quote`);
    url.searchParams.set("inputMint", params.inputMint);
    url.searchParams.set("outputMint", params.outputMint);
    url.searchParams.set("amount", params.amount);
    url.searchParams.set("slippageBps", String(params.slippageBps));

    try {
      return await fetchJson<JupiterQuoteResponse>(url.toString(), {
        headers: { "x-api-key": this.opts.apiKey, accept: "application/json" },
        timeoutMs: this.opts.timeoutMs ?? 8000,
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        logger: this.opts.logger,
        label: "Jupiter quote",
      });
    } catch (err) {
      this.opts.logger.error("Jupiter quote failed", {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        error: String(err),
      });
      throw err;
    }
  }
}
