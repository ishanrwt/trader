import { fetchJson } from "../clients/http.js";
import type { RpcLane } from "../limiters/laneLimiter.js";
import type { Logger } from "../logger/index.js";

/**
 * The only way to broadcast a transaction (SPEC.md section 16.8). A permit is
 * issued solely for MODE=live (the bot) or `smoke-live --send`; paper mode
 * never loads this module at all, and even if something did construct a
 * TxRpc without a permit, `sendTransaction` throws.
 */
export class SendPermit {
  private static readonly issued = new WeakSet<SendPermit>();
  private constructor(readonly purpose: "live" | "smoke-send") {}

  static issue(mode: string, purpose: "live" | "smoke-send"): SendPermit {
    if (mode !== "live") throw new Error(`Refusing to issue a send permit in ${mode} mode: only MODE=live may send transactions.`);
    const permit = new SendPermit(purpose);
    SendPermit.issued.add(permit);
    return permit;
  }

  static isValid(p: unknown): p is SendPermit {
    return p instanceof SendPermit && SendPermit.issued.has(p);
  }
}

export class SendNotPermittedError extends Error {
  constructor() {
    super("sendTransaction called without a live send permit (paper mode, or smoke-live without --send). Nothing was sent.");
    this.name = "SendNotPermittedError";
  }
}

export interface LaneAcquirer {
  acquire(lane: RpcLane): Promise<void>;
}

export interface TxRpcOptions {
  url: string;
  limiter: LaneAcquirer;
  /** RPC_SEND_MAX_RPS, applied on top of the shared limiter for sendTransaction only. */
  sendLimiter: { acquire(): Promise<void> };
  permit: SendPermit | null;
  logger: Logger;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onCall?: (method: string) => void;
}

export type SignatureStatus = { confirmationStatus?: string | null; err: unknown; slot?: number } | null;

export class RpcError extends Error {
  constructor(readonly method: string, readonly code: number | null, message: string) {
    super(message);
    this.name = "RpcError";
  }
}

/** Live-mode JSON-RPC calls (SPEC.md section 3, Phase 3 additions). Every call goes through the lane limiter. */
export class TxRpc {
  private id = 0;
  constructor(private readonly opts: TxRpcOptions) {}

  async simulate(base64Tx: string, cfg: { sigVerify: boolean; replaceRecentBlockhash: boolean; accounts?: readonly string[] }): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: cfg.sigVerify,
      replaceRecentBlockhash: cfg.replaceRecentBlockhash,
      innerInstructions: true,
    };
    if (cfg.accounts) params.accounts = { addresses: cfg.accounts, encoding: "jsonParsed" };
    const result = await this.call<{ value: Record<string, unknown> }>("simulateTransaction", [base64Tx, params], "tx");
    if (!result || typeof result.value !== "object" || result.value === null) throw new RpcError("simulateTransaction", null, "simulateTransaction returned no value");
    return result.value;
  }

  /** Broadcasts pre-verified signed bytes. skipPreflight: these exact bytes were just simulated (section 16.4). */
  async sendTransaction(base64Tx: string): Promise<string> {
    if (!SendPermit.isValid(this.opts.permit)) throw new SendNotPermittedError();
    await this.opts.sendLimiter.acquire();
    const sig = await this.call<string>("sendTransaction", [base64Tx, { encoding: "base64", skipPreflight: true, maxRetries: 0 }], "tx", 0);
    if (typeof sig !== "string") throw new RpcError("sendTransaction", null, "sendTransaction returned no signature");
    return sig;
  }

  async getSignatureStatuses(signatures: readonly string[], searchTransactionHistory: boolean): Promise<SignatureStatus[]> {
    const result = await this.call<{ value: SignatureStatus[] }>("getSignatureStatuses", [signatures, { searchTransactionHistory }], "tx");
    if (!result || !Array.isArray(result.value) || result.value.length !== signatures.length) {
      throw new RpcError("getSignatureStatuses", null, "getSignatureStatuses returned an unexpected shape");
    }
    return result.value;
  }

  async getBlockHeight(): Promise<number> {
    const h = await this.call<number>("getBlockHeight", [{ commitment: "confirmed" }], "tx");
    if (typeof h !== "number" || !Number.isInteger(h)) throw new RpcError("getBlockHeight", null, "getBlockHeight returned an unexpected shape");
    return h;
  }

  async getTransaction(signature: string): Promise<Record<string, unknown> | null> {
    return this.call<Record<string, unknown> | null>(
      "getTransaction",
      [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
      "tx",
    );
  }

  /** jsonParsed; `lane` is tx for live balance reads, read for reconciliation. */
  async getMultipleAccounts(addresses: readonly string[], lane: RpcLane = "tx"): Promise<unknown[]> {
    const result = await this.call<{ value: unknown[] }>("getMultipleAccounts", [addresses, { encoding: "jsonParsed", commitment: "confirmed" }], lane);
    if (!result || !Array.isArray(result.value) || result.value.length !== addresses.length) {
      throw new RpcError("getMultipleAccounts", null, "getMultipleAccounts returned an unexpected shape");
    }
    return result.value;
  }

  /** Reconciliation (read lane): every token account the wallet owns under one token program. */
  async getTokenAccountsByOwner(owner: string, programId: string): Promise<Array<{ pubkey: string; account: unknown }>> {
    const result = await this.call<{ value: Array<{ pubkey: string; account: unknown }> }>(
      "getTokenAccountsByOwner",
      [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }],
      "read",
    );
    if (!result || !Array.isArray(result.value)) throw new RpcError("getTokenAccountsByOwner", null, "getTokenAccountsByOwner returned an unexpected shape");
    return result.value;
  }

  private async call<T>(method: string, params: unknown[], lane: RpcLane, retries = 2): Promise<T> {
    await this.opts.limiter.acquire(lane);
    this.opts.onCall?.(method);
    this.id += 1;
    try {
      const data = await fetchJson<{ result?: T; error?: { code: number; message: string } }>(this.opts.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.id, method, params }),
        timeoutMs: this.opts.timeoutMs ?? 10_000,
        // 429/5xx back off with jitter inside fetchJson (section 16.10); a 429 is never counted as an error.
        retries,
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        logger: this.opts.logger,
        label: `Solana RPC ${method}`,
      });
      if (data.error) throw new RpcError(method, data.error.code, `Solana RPC ${method} error ${data.error.code}: ${data.error.message}`);
      return data.result as T;
    } catch (err) {
      this.opts.logger.warn(`Solana RPC ${method} failed`, { url: this.opts.url, error: String(err) });
      throw err;
    }
  }
}
