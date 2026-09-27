import type { SlidingWindowLimiter } from "../limiters/slidingWindow.js";
import type { Logger } from "../logger/index.js";
import { fetchJson } from "./http.js";

interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: number;
  result: T;
}
interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string };
}
type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

export interface RpcClientOptions {
  /** SOLANA_RPC_URL — a secret; never log it directly (the logger redacts it too, but don't rely on that alone). */
  url: string;
  /** Any `{ acquire() }` limiter: the RPC lane limiter's read lane in production (section 16.10). */
  limiter: Pick<SlidingWindowLimiter, "acquire">;
  timeoutMs?: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

/**
 * Read-only Solana JSON-RPC 2.0 client. Phases 1-2 only ever call the four
 * methods below (SPEC.md section 3) — no signing, no sending.
 */
export class SolanaRpcClient {
  private idCounter = 0;

  constructor(private readonly opts: RpcClientOptions) {}

  async getAccountInfo(pubkey: string): Promise<unknown> {
    return this.call("getAccountInfo", [pubkey, { encoding: "jsonParsed" }]);
  }

  async getTokenLargestAccounts(mint: string): Promise<unknown> {
    return this.call("getTokenLargestAccounts", [mint]);
  }

  async getTokenSupply(mint: string): Promise<unknown> {
    return this.call("getTokenSupply", [mint]);
  }

  async getMultipleAccounts(pubkeys: string[]): Promise<unknown> {
    return this.call("getMultipleAccounts", [pubkeys, { encoding: "jsonParsed" }]);
  }

  // ---- Section 11.6 rug-risk features (read-only, data collection only) ----

  /** Raw account bytes (base64), for decoding program accounts such as PumpSwap pools. 1 credit. */
  async getAccountInfoBase64(pubkey: string): Promise<unknown> {
    return this.call("getAccountInfo", [pubkey, { encoding: "base64" }]);
  }

  /** 10 credits on Helius. */
  async getProgramAccounts(programId: string, config: Record<string, unknown>): Promise<unknown> {
    return this.call("getProgramAccounts", [programId, config]);
  }

  /** Newest first; up to `limit` (max 1000) signatures older than `before`. 1 credit. */
  async getSignaturesForAddress(address: string, opts: { limit: number; before?: string }): Promise<unknown> {
    return this.call("getSignaturesForAddress", [address, opts]);
  }

  /** 1 credit. Version 1 is required: newer transactions are rejected with version 0 (-32015). */
  async getTransactionJsonParsed(signature: string): Promise<unknown> {
    return this.call("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);
  }

  /** 1 credit. */
  async getTokenAccountsByOwnerForMint(owner: string, mint: string): Promise<unknown> {
    return this.call("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    await this.opts.limiter.acquire();
    this.idCounter += 1;
    const body = JSON.stringify({ jsonrpc: "2.0", id: this.idCounter, method, params });

    try {
      const data = await fetchJson<JsonRpcResponse<T>>(this.opts.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        timeoutMs: this.opts.timeoutMs ?? 8000,
        // A failed RPC call is retried naturally on the next gate/holders cycle,
        // so a single attempt here is enough (RPC_MAX_RPS already limits how
        // fast we can retry anyway).
        retries: 0,
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        logger: this.opts.logger,
        label: `Solana RPC ${method}`,
      });
      if ("error" in data) {
        throw new Error(`Solana RPC ${method} error ${data.error.code}: ${data.error.message}`);
      }
      return data.result;
    } catch (err) {
      // `url` is a secret (contains an api-key); the logger scrubs every configured
      // secret out of log output, so logging it here does not leak it.
      this.opts.logger.error(`Solana RPC ${method} failed`, { url: this.opts.url, error: String(err) });
      throw err;
    }
  }
}
