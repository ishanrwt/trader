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

/** One instruction as /swap/v2/build returns it (SPEC.md section 16.1). */
export interface JupiterApiInstruction {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  /** base64 */
  data: string;
}

export interface JupiterBuildParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker: string;
  slippageBps: number;
  computeUnitPricePercentile: string | number;
}

/** GET /swap/v2/build response, per the Swap API V2 OpenAPI spec (verified 2026-09-25). Validated by the live module before use. */
export interface JupiterBuildResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps?: number;
  computeBudgetInstructions: JupiterApiInstruction[];
  setupInstructions: JupiterApiInstruction[];
  swapInstruction: JupiterApiInstruction;
  cleanupInstruction: JupiterApiInstruction | null;
  otherInstructions: JupiterApiInstruction[];
  tipInstruction?: JupiterApiInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
  blockhashWithMetadata: { blockhash: number[]; lastValidBlockHeight: number };
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

  /**
   * Phase 3, live mode only: GET /swap/v2/build (the Router path, SPEC.md
   * section 16.1). Returns the quote plus raw instructions; this client never
   * signs or broadcasts anything. No tipAmount is ever sent. The caller decides
   * the Jupiter lane (entry for buys, exit for sells) before calling.
   */
  async build(params: JupiterBuildParams): Promise<JupiterBuildResponse> {
    await this.opts.physicalLimiter.acquire();
    const url = new URL(`${this.opts.baseUrl ?? DEFAULT_BASE_URL}/swap/v2/build`);
    url.searchParams.set("inputMint", params.inputMint);
    url.searchParams.set("outputMint", params.outputMint);
    url.searchParams.set("amount", params.amount);
    url.searchParams.set("taker", params.taker);
    url.searchParams.set("slippageBps", String(params.slippageBps));
    url.searchParams.set("computeUnitPricePercentile", String(params.computeUnitPricePercentile));
    url.searchParams.set("wrapAndUnwrapSol", "true");
    try {
      return await fetchJson<JupiterBuildResponse>(url.toString(), {
        headers: { "x-api-key": this.opts.apiKey, accept: "application/json" },
        timeoutMs: this.opts.timeoutMs ?? 8000,
        // A build is fresh-quote-sensitive: one retry on 429/5xx at most; the sell policy retries later anyway.
        retries: 1,
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        logger: this.opts.logger,
        label: "Jupiter build",
      });
    } catch (err) {
      this.opts.logger.error("Jupiter build failed", { inputMint: params.inputMint, outputMint: params.outputMint, error: String(err) });
      throw err;
    }
  }
}
