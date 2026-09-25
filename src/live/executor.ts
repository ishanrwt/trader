import type { JupiterBuildParams, JupiterBuildResponse } from "../clients/jupiter.js";
import type { Config } from "../config/index.js";
import { BASE_FEE_LAMPORTS, LAMPORTS_PER_SOL } from "../config/validate.js";
import type { Logger } from "../logger/index.js";
import { matchStuckPosition } from "../notify/sellRetry.js";
import type { FeeLossesStore } from "../storage/feeLosses.js";
import { buyRefKey, DuplicateIntentError, sellRefKey, type IntentRow, type IntentsStore } from "../storage/intents.js";
import type { PositionRow, PositionsStore } from "../storage/positions.js";
import type { SafetyCacheStore } from "../storage/safetyCache.js";
import { tradingDayKey } from "../time.js";
import { associatedTokenAddress, closeTokenAccountInstruction } from "./assemble.js";
import type { ConfirmationPool, TxOutcome } from "./confirm.js";
import { buyFillFromEffects, extractConfirmedEffects, lamportsToUsd, sellFillFromEffects, type BuyFill, type SellFill } from "./fills.js";
import { resolveIntent } from "./intentResolution.js";
import type { LoadedWallet } from "./keys.js";
import { buildVerifySign, type PipelineDeps, type PipelineResult } from "./pipeline.js";
import { JUPITER_AGGREGATOR_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, TOKEN_PROGRAMS, USDC_MINT } from "./programs.js";
import { reconcile, type ReconcileResult } from "./reconcile.js";
import {
  afterFailedAttempt,
  grantSellBudget,
  markBudgetExhausted,
  sellAttemptDue,
  sellSlippageBps,
  withinFeeBudget,
  type SellAttemptState,
  type SellPolicyConfig,
} from "./sellPolicy.js";
import { parseAccount } from "./simulation.js";
import type { TxRpc } from "./txRpc.js";

/** Rent allowance for a new token account in the pre-entry SOL check (SPEC.md section 16.7); verification bounds the real amount. */
export const NEW_TOKEN_ACCOUNT_RENT_ALLOWANCE_LAMPORTS = 2_500_000;
/** A prepared /build is only used while its blockhash is comfortably fresh. */
const PREPARED_BUY_MAX_AGE_MS = 20_000;

/** Everything a landed buy needs to become a normal managed position (stored in the buy intent, SPEC.md section 16.5). */
export interface BuyIntentPayload {
  mint: string;
  sizeUsd: number;
  score: number;
  liquidityUsd: number;
  tokenProgram: string;
  decimals: number;
  /** The pending row's snapshot JSON (pair, holders, score, components) at decision time. */
  snapshot: unknown;
  /** The sellability check that admitted this entry (section 11.1). Optional: intents written before it existed lack it. */
  sellability?: { roundTripLossPct: number | null; checkedAt: number };
}

/** The app side (src/index.ts) of the live executor: anything that touches positions, trades, alerts or lanes. */
export interface LiveAppHooks {
  /** Inserts a managed position from a confirmed buy. Must be idempotent on the entry signature. Returns the position id. */
  recordBuy(
    payload: BuyIntentPayload,
    fill: BuyFill,
    info: { entryTime: number; signature: string; solPriceUsd: number; quoteInAmount: string | null; quoteOutAmount: string | null },
  ): Promise<number>;
  /** Closes the position with the confirmed sell's real proceeds. */
  recordSell(
    row: PositionRow,
    fill: SellFill,
    info: { signature: string; solPriceUsd: number; sellAttempts: number; quoteInAmount: string | null; quoteOutAmount: string | null },
  ): Promise<void>;
  /** Closes as `reconciled`, proceeds 0, proceeds_unknown (SPEC.md section 16.5). */
  closeReconciled(row: PositionRow): Promise<void>;
  alert(text: string): void;
  event(type: string, message: string, meta?: unknown): void;
  solPriceUsd(): number | null;
  /** Entry lane for buy builds; false = deferred for lack of budget. */
  acquireEntryLane(): Promise<boolean>;
  /** Exit lane for sell builds (never blocked). */
  recordExitLane(): void;
}

export interface LiveExecutorDeps {
  config: Config;
  wallet: LoadedWallet;
  rpc: TxRpc;
  jupiter: { build(p: JupiterBuildParams): Promise<JupiterBuildResponse> };
  pool: ConfirmationPool;
  intents: IntentsStore;
  positions: PositionsStore;
  feeLosses: FeeLossesStore;
  safetyCache: SafetyCacheStore;
  hooks: LiveAppHooks;
  logger: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface LiveHealth {
  sent: number;
  landed: number;
  failed: number;
  expired: number;
  refused: number;
}

interface PreparedBuy {
  build: JupiterBuildResponse;
  amountRaw: bigint;
  tokenProgram: string;
  decimals: number;
  at: number;
}

export class LiveExecutor {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly prepared = new Map<string, PreparedBuy>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly pipelineDeps: PipelineDeps;
  private shuttingDown = false;
  private solBelowReserve = false;
  private lastBalances: { usdc: number; sol: number } = { usdc: 0, sol: 0 };
  readonly health: LiveHealth = { sent: 0, landed: 0, failed: 0, expired: 0, refused: 0 };
  lastReconcile: ReconcileResult | null = null;

  constructor(private readonly d: LiveExecutorDeps) {
    this.now = d.now ?? (() => Date.now());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pipelineDeps = {
      rpc: d.rpc,
      signer: d.wallet.signer,
      intents: d.intents,
      jupiterProgram: JUPITER_AGGREGATOR_PROGRAM,
      maxPriorityFeeLamports: BigInt(d.config.maxPriorityFeeLamports),
      hardMaxUsdcRaw: BigInt(d.config.hardMaxPositionUsd) * 1_000_000n,
      balanceFields: { missing: false },
    };
  }

  get address(): string {
    return this.d.wallet.address;
  }

  balances(): { usdc: number; sol: number } {
    return { ...this.lastBalances };
  }

  /** Graceful shutdown (SPEC.md section 16.11): no new buys or sell attempts from now on. */
  stopNewTransactions(): void {
    this.shuttingDown = true;
  }

  /** Resolves when every in-flight operation (including its confirmation) has finished, or after `boundMs`. */
  async waitIdle(boundMs: number): Promise<boolean> {
    const deadline = this.now() + boundMs;
    while (this.active.size > 0 || this.d.pool.inFlight() > 0) {
      if (this.now() >= deadline) return false;
      await Promise.race([Promise.allSettled([...this.active]), this.sleep(250)]);
    }
    return true;
  }

  inFlight(): number {
    return this.active.size;
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.active.add(p);
    void p.finally(() => this.active.delete(p)).catch(() => undefined);
    return p;
  }

  private sellPolicy(): SellPolicyConfig {
    const c = this.d.config;
    return {
      sellSlippageBpsStart: c.SELL_SLIPPAGE_BPS_START,
      sellSlippageBpsMax: c.SELL_SLIPPAGE_BPS_MAX,
      sellRetrySeconds: c.SELL_RETRY_SECONDS,
      stuckBackoffSeconds: c.STUCK_BACKOFF_SECONDS,
      maxPriorityFeeLamports: c.maxPriorityFeeLamports,
      sellFeeBudgetLamports: c.sellFeeBudgetLamports,
    };
  }

  // ---------------------------------------------------------------- buys

  /** The mint's token program and decimals: from the safety cache, else one getMultipleAccounts. Null (fail closed) if not a Token/Token-2022 mint. */
  async mintInfo(mint: string): Promise<{ tokenProgram: string; decimals: number } | null> {
    const cached = this.d.safetyCache.getMintInfo(mint);
    if (cached) return TOKEN_PROGRAMS.has(cached.tokenProgram) ? cached : null;
    const [acct] = await this.d.rpc.getMultipleAccounts([mint], "tx");
    const o = acct as { owner?: unknown; data?: { parsed?: { type?: unknown; info?: { decimals?: unknown } } } } | null;
    if (!o || typeof o.owner !== "string" || !TOKEN_PROGRAMS.has(o.owner)) return null;
    const decimals = o.data?.parsed?.type === "mint" ? o.data.parsed.info?.decimals : undefined;
    if (typeof decimals !== "number" || !Number.isInteger(decimals)) return null;
    const info = { tokenProgram: o.owner, decimals };
    this.d.safetyCache.setMintInfo(mint, info);
    return info;
  }

  /**
   * SPEC.md section 6.2 step 3 in live mode: the /build for the actual buy is
   * the execution quote (entry lane). The response is kept for executeBuy.
   */
  async prepareBuy(mint: string, sizeUsd: number): Promise<{ tokensOut: number } | null> {
    if (this.shuttingDown) return null;
    if (this.d.intents.hasUnresolved(buyRefKey(mint), "buy")) return null;
    const info = await this.mintInfo(mint).catch(() => null);
    if (!info) {
      this.d.logger.warn("Live buy skipped: mint program/decimals unknown or not a Token/Token-2022 mint", { mint });
      return null;
    }
    const amountRaw = BigInt(Math.round(sizeUsd * 1_000_000));
    if (amountRaw > this.pipelineDeps.hardMaxUsdcRaw) {
      this.d.logger.error("Live buy refused: size exceeds HARD_MAX_POSITION_USD", { mint, sizeUsd });
      return null;
    }
    if (!(await this.d.hooks.acquireEntryLane())) return null;
    let build: JupiterBuildResponse;
    try {
      build = await this.d.jupiter.build({
        inputMint: USDC_MINT,
        outputMint: mint,
        amount: amountRaw.toString(),
        taker: this.address,
        slippageBps: this.d.config.BUY_SLIPPAGE_BPS,
        computeUnitPricePercentile: this.d.config.priorityFeePercentile,
      });
    } catch {
      return null;
    }
    if (typeof build?.outAmount !== "string" || !/^\d+$/.test(build.outAmount)) return null;
    this.prepared.set(mint, { build, amountRaw, tokenProgram: info.tokenProgram, decimals: info.decimals, at: this.now() });
    return { tokensOut: Number(build.outAmount) / 10 ** info.decimals };
  }

  /** Reads SOL and USDC on-chain (transaction lane). */
  async readWalletBalances(): Promise<{ lamports: bigint; usdcRaw: bigint }> {
    const usdcAta = await associatedTokenAddress(this.address, USDC_MINT, TOKEN_PROGRAM);
    const [w, u] = await this.d.rpc.getMultipleAccounts([this.address, usdcAta], "tx");
    const wallet = parseAccount(w ?? null, "wallet");
    const usdc = parseAccount(u ?? null, "usdc account");
    const lamports = wallet?.lamports ?? 0n;
    const usdcRaw = usdc?.token && usdc.token.owner === this.address && usdc.token.mint === USDC_MINT ? usdc.token.amount : 0n;
    this.lastBalances = { usdc: Number(usdcRaw) / 1e6, sol: Number(lamports) / LAMPORTS_PER_SOL };
    this.checkSolReserve(lamports);
    return { lamports, usdcRaw };
  }

  /** SPEC.md section 16.7: one urgent alert per episode below SELL_FEE_RESERVE_SOL while positions are open, one on recovery. */
  checkSolReserve(lamports: bigint): void {
    const reserve = BigInt(Math.ceil(this.d.config.sellFeeReserveSol * LAMPORTS_PER_SOL));
    const positionsOpen = this.d.positions.listAllActive().some((p) => p.mode === "live");
    const below = positionsOpen && lamports < reserve;
    if (below && !this.solBelowReserve) {
      this.d.hooks.alert(`SOL balance ${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)} is below SELL_FEE_RESERVE_SOL (${this.d.config.sellFeeReserveSol.toFixed(6)}) with live positions open. Top up SOL so sells can pay their fees.`);
    } else if (!below && this.solBelowReserve) {
      this.d.hooks.alert("SOL balance is back above SELL_FEE_RESERVE_SOL.");
    }
    this.solBelowReserve = below;
  }

  /**
   * Executes a buy prepared by prepareBuy (SPEC.md sections 16.2-16.5, 16.7).
   * Returns the new position id, or null if nothing landed. Throws on a
   * verification refusal (it counts as a failed entry, section 9.1).
   */
  executeBuy(payload: Omit<BuyIntentPayload, "tokenProgram" | "decimals">): Promise<number | null> {
    return this.track(this.executeBuyInner(payload));
  }

  private async executeBuyInner(base: Omit<BuyIntentPayload, "tokenProgram" | "decimals">): Promise<number | null> {
    const prep = this.prepared.get(base.mint);
    this.prepared.delete(base.mint);
    if (this.shuttingDown || !prep || this.now() - prep.at > PREPARED_BUY_MAX_AGE_MS) return null;
    const solPrice = this.d.hooks.solPriceUsd();
    if (solPrice === null) {
      this.d.logger.warn("Live buy skipped: no SOL/USD price yet (section 16.3)", { mint: base.mint });
      return null;
    }
    const { lamports, usdcRaw } = await this.readWalletBalances();
    if (usdcRaw < prep.amountRaw) {
      this.d.logger.warn("Live buy skipped: USDC below size", { mint: base.mint });
      return null;
    }
    const worstCase = BigInt(BASE_FEE_LAMPORTS + this.d.config.maxPriorityFeeLamports + NEW_TOKEN_ACCOUNT_RENT_ALLOWANCE_LAMPORTS);
    const floorSol = Math.max(this.d.config.MIN_SOL_BALANCE, this.d.config.sellFeeReserveSol);
    if (lamports - worstCase < BigInt(Math.ceil(floorSol * LAMPORTS_PER_SOL))) {
      this.d.logger.warn("Live buy skipped: SOL after worst-case buy cost would be below max(MIN_SOL_BALANCE, SELL_FEE_RESERVE_SOL)", { mint: base.mint });
      return null;
    }

    const payload: BuyIntentPayload = { ...base, tokenProgram: prep.tokenProgram, decimals: prep.decimals };
    let intentId: number;
    try {
      intentId = this.d.intents.reserve({
        kind: "buy",
        mode: "live",
        mint: base.mint,
        positionId: null,
        refKey: buyRefKey(base.mint),
        side: "buy",
        inputMint: USDC_MINT,
        outputMint: base.mint,
        payload,
        now: this.now(),
      });
    } catch (err) {
      if (err instanceof DuplicateIntentError) return null;
      throw err;
    }

    const result = await buildVerifySign(this.pipelineDeps, {
      intentId,
      build: prep.build,
      request: { inputMint: USDC_MINT, outputMint: base.mint, amountRaw: prep.amountRaw },
      tradedMint: base.mint,
      after: [],
    }).catch((err: unknown) => ({ ok: false as const, stage: "simulation" as const, reason: String(err) }));
    if (!result.ok) {
      this.d.intents.resolve(intentId, "abandoned", this.now(), { error: `${result.stage}: ${result.reason}` });
      if (result.stage === "refused") {
        this.health.refused++;
        this.d.hooks.alert(`Verification refused a live buy of ${base.mint} (check ${result.check ?? "?"}): ${result.reason}. Nothing was sent.`);
        throw new Error(`verification refused the buy: ${result.reason}`);
      }
      this.d.logger.warn("Live buy not sent", { mint: base.mint, stage: result.stage, reason: result.reason });
      return null;
    }

    const outcome = await this.sendAndConfirm(intentId, result, prep.amountRaw);
    const intent = this.d.intents.get(intentId)!;
    return this.applyBuyOutcome(intent, outcome, result.signature, solPrice);
  }

  private async applyBuyOutcome(intent: IntentRow, outcome: TxOutcome, signature: string, solPrice: number): Promise<number | null> {
    if (outcome === "expired") {
      this.d.intents.resolve(intent.id, "expired", this.now());
      this.d.logger.info("Live buy expired unlanded; the mint stays READY (no rebuild, section 16.4)", { mint: intent.mint });
      return null;
    }
    const tx = await this.fetchTransaction(signature);
    if (!tx) {
      this.d.logger.warn("Live buy confirmed but its transaction isn't queryable yet; startup/next resolution will apply it", { signature });
      return null;
    }
    if (outcome === "failed") {
      this.recordFeeLoss(intent, tx, "buy", solPrice, null);
      return null;
    }
    this.d.intents.markLanded(intent.id, this.now());
    return this.applyLandedBuy(intent, tx, solPrice);
  }

  private async applyLandedBuy(intent: IntentRow, tx: Record<string, unknown>, solPrice: number): Promise<number> {
    const payload = intent.payload as BuyIntentPayload;
    const effects = extractConfirmedEffects(tx, this.address);
    const fill = buyFillFromEffects(effects, intent.mint, solPrice);
    const entryTime = effects.blockTime !== null ? effects.blockTime * 1000 : this.now();
    const id = await this.d.hooks.recordBuy(payload, fill, {
      entryTime,
      signature: intent.signature!,
      solPriceUsd: solPrice,
      quoteInAmount: intent.expectedInRaw,
      quoteOutAmount: intent.expectedOutRaw,
    });
    this.d.intents.resolve(intent.id, "applied", this.now(), { feeLamports: Number(effects.feeLamports) });
    return id;
  }

  // ---------------------------------------------------------------- sends

  private async sendAndConfirm(intentId: number, r: Extract<PipelineResult, { ok: true }>, expectedInRaw: bigint): Promise<TxOutcome> {
    // Write-ahead (SPEC.md section 16.5): signature, bytes, expiry and expected amounts are persisted BEFORE sending.
    this.d.intents.markSigned(
      intentId,
      { signature: r.signature, signedTxB64: r.base64, lastValidBlockHeight: r.lastValidBlockHeight, expectedInRaw: expectedInRaw.toString(), expectedOutRaw: r.outAmountRaw.toString(), minOutRaw: r.minOutRaw.toString() },
      this.now(),
    );
    try {
      await this.d.rpc.sendTransaction(r.base64);
      this.d.intents.markSent(intentId, this.now());
      this.health.sent++;
    } catch (err) {
      // It may still have reached the network: keep confirming until it lands or expires.
      this.d.logger.warn("sendTransaction failed; confirming anyway until expiry", { intentId, error: String(err) });
    }
    const outcome = await this.d.pool.track({ signature: r.signature, signedTxB64: r.base64, lastValidBlockHeight: r.lastValidBlockHeight });
    this.health[outcome]++;
    return outcome;
  }

  private async fetchTransaction(signature: string): Promise<Record<string, unknown> | null> {
    for (let i = 0; i < 5; i++) {
      const tx = await this.d.rpc.getTransaction(signature).catch(() => null);
      if (tx) return tx;
      await this.sleep(1_000);
    }
    return null;
  }

  private recordFeeLoss(intent: IntentRow, tx: Record<string, unknown>, kind: string, solPrice: number, positionId: number | null): number {
    const effects = extractConfirmedEffects(tx, this.address);
    const lamports = Number(effects.feeLamports);
    const now = this.now();
    if (intent.kind !== "smoke") {
      this.d.feeLosses.insert({
        mode: "live",
        ts: now,
        tradingDay: tradingDayKey(now, this.d.config.TRADING_DAY_TZ),
        mint: intent.mint,
        positionId,
        intentId: intent.id,
        signature: intent.signature,
        kind,
        lamports,
        usd: lamportsToUsd(effects.feeLamports, solPrice),
        solPriceUsd: solPrice,
      });
    }
    this.d.intents.resolve(intent.id, "failed", now, { feeLamports: lamports });
    this.d.hooks.event("tx_failed", `${kind} transaction failed on-chain`, { mint: intent.mint, signature: intent.signature, feeLamports: lamports });
    return lamports;
  }

  // ---------------------------------------------------------------- sells

  /** One sell attempt for a closing live position, if due (SPEC.md section 16.6). Fire-and-forget safe. */
  sellAttempt(row: PositionRow): Promise<void> {
    return this.track(this.sellAttemptInner(row));
  }

  private stateOf(row: PositionRow): SellAttemptState {
    return {
      sellAttempts: row.sellAttempts,
      sellFailures: row.sellFailures,
      sellFeesLamports: row.sellFeesLamports,
      failedSellFeesLamports: row.failedSellFeesLamports,
      sellBudgetLamports: row.sellBudgetLamports,
      stuckState: row.stuckState,
      stuckSince: row.stuckSince,
      nextSellAt: row.nextSellAt,
    };
  }

  private saveState(id: number, s: SellAttemptState): void {
    this.d.positions.updateLive(id, s);
  }

  private failAttempt(row: PositionRow, feeLamports: number, why: string): void {
    const fresh = this.d.positions.get(row.id) ?? row;
    const { state, becameStuck } = afterFailedAttempt(this.stateOf(fresh), this.now(), feeLamports, this.sellPolicy());
    this.saveState(row.id, state);
    this.d.logger.warn("Live sell attempt failed", { positionId: row.id, mint: row.mint, why, failures: state.sellFailures });
    if (becameStuck) {
      this.d.hooks.alert(`Position ${row.symbol ?? row.mint} is stuck after ${state.sellFailures} failed sell attempts (${why}). Retries continue on the backoff schedule.`);
    }
  }

  private async tokenAccountOf(row: PositionRow): Promise<{ address: string; program: string }> {
    const program = row.tokenProgram ?? (await this.mintInfo(row.mint))?.tokenProgram;
    if (!program || !TOKEN_PROGRAMS.has(program)) throw new Error(`unknown token program for ${row.mint}`);
    return { address: row.tokenAccount ?? (await associatedTokenAddress(this.address, row.mint, program)), program };
  }

  /** The token account's current on-chain balance (A11) and the wallet's SOL, in one call. null account = 0. */
  private async readSellBalances(row: PositionRow, tokenAccount: string): Promise<bigint> {
    const [t, w] = await this.d.rpc.getMultipleAccounts([tokenAccount, this.address], "tx");
    const wallet = parseAccount(w ?? null, "wallet");
    if (wallet) this.checkSolReserve(wallet.lamports);
    const acct = parseAccount(t ?? null, "token account");
    if (!acct) return 0n;
    if (!acct.token || acct.token.owner !== this.address || acct.token.mint !== row.mint) throw new Error("the token account is not ours or not for this mint");
    return acct.token.amount;
  }

  private async sellAttemptInner(row0: PositionRow): Promise<void> {
    if (this.shuttingDown) return;
    const row = this.d.positions.get(row0.id);
    if (!row || row.status !== "closing" || row.mode !== "live") return;
    const now = this.now();
    if (!sellAttemptDue(row, now)) return;

    // Resolve any intent left for this position first (never two transactions per position and side).
    for (const intent of this.d.intents.listUnresolved("live").filter((i) => i.refKey === sellRefKey(row.id))) {
      const done = await this.resolveOne(intent);
      if (done === "in_flight" || done === "closed") return;
    }

    const { address: tokenAccount, program } = await this.tokenAccountOf(row);
    const balance = await this.readSellBalances(row, tokenAccount);
    if (balance === 0n) {
      await this.d.hooks.closeReconciled(row);
      return;
    }
    if (row.tokenAmountRaw !== balance.toString()) this.d.positions.updateLive(row.id, { tokenAmountRaw: balance.toString(), tokenAccount, tokenProgram: program });

    if (row.stuckState === "budget_exhausted") {
      // Budget used up: balance reads only (no Jupiter calls, no sends), so a manual sale is picked up.
      this.saveState(row.id, markBudgetExhausted(this.stateOf(row), now, this.sellPolicy()));
      return;
    }
    if (!withinFeeBudget(this.stateOf(row), this.sellPolicy())) {
      this.saveState(row.id, markBudgetExhausted(this.stateOf(row), now, this.sellPolicy()));
      this.d.hooks.alert(`Position ${row.symbol ?? row.mint}: sell fee budget used up; no more sends. Sell it manually, or send /sellretry ${row.mint.slice(0, 6)} to grant one more SELL_FEE_BUDGET_SOL.`);
      return;
    }

    let intentId: number;
    try {
      intentId = this.d.intents.reserve({ kind: "sell", mode: "live", mint: row.mint, positionId: row.id, refKey: sellRefKey(row.id), side: "sell", inputMint: row.mint, outputMint: USDC_MINT, now });
    } catch (err) {
      if (err instanceof DuplicateIntentError) return;
      throw err;
    }

    const solPrice = this.d.hooks.solPriceUsd() ?? row.entrySolPriceUsd ?? 0;
    const slippage = sellSlippageBps(row.sellFailures, this.sellPolicy());
    this.d.hooks.recordExitLane();
    let build: JupiterBuildResponse;
    try {
      build = await this.d.jupiter.build({
        inputMint: row.mint,
        outputMint: USDC_MINT,
        amount: balance.toString(),
        taker: this.address,
        slippageBps: slippage,
        computeUnitPricePercentile: this.d.config.priorityFeePercentile,
      });
    } catch (err) {
      this.d.intents.resolve(intentId, "abandoned", this.now(), { error: `no route: ${String(err)}` });
      this.failAttempt(row, 0, "no route");
      return;
    }

    const request = { inputMint: row.mint, outputMint: USDC_MINT, amountRaw: balance };
    const withClose = this.d.config.CLOSE_EMPTY_ATA && row.closeAta;
    const run = (close: boolean) =>
      buildVerifySign(this.pipelineDeps, {
        intentId,
        build,
        request,
        tradedMint: row.mint,
        after: close ? [closeTokenAccountInstruction(tokenAccount, this.d.wallet.signer, program)] : [],
      }).catch((err: unknown) => ({ ok: false as const, stage: "simulation" as const, reason: String(err) }));
    let result = await run(withClose);
    if (!result.ok && withClose && result.stage === "simulation") {
      const without = await run(false);
      if (without.ok) {
        // The close alone made it fail (the account isn't empty after the swap): rebuild once without it, leave the account open.
        this.d.positions.updateLive(row.id, { closeAta: false });
        this.d.logger.warn("Sell simulated only without closeAccount; the token account will be left open", { positionId: row.id });
      }
      result = without;
    }
    if (!result.ok) {
      this.d.intents.resolve(intentId, "abandoned", this.now(), { error: `${result.stage}: ${result.reason}` });
      if (result.stage === "refused") {
        this.health.refused++;
        this.d.hooks.alert(`Verification refused a live sell of ${row.symbol ?? row.mint} (check ${result.check ?? "?"}): ${result.reason}. Nothing was sent.`);
      }
      if (result.stage !== "guard") this.failAttempt(row, 0, `${result.stage}: ${result.reason}`);
      return;
    }

    const outcome = await this.sendAndConfirm(intentId, result, balance);
    const intent = this.d.intents.get(intentId)!;
    if (outcome === "expired") {
      this.d.intents.resolve(intentId, "expired", this.now());
      this.failAttempt(row, 0, "expired unlanded");
      return;
    }
    const tx = await this.fetchTransaction(result.signature);
    if (!tx) return; // confirmed, body not queryable yet: resolved on the next attempt
    if (outcome === "failed") {
      const fee = this.recordFeeLoss(intent, tx, "sell", solPrice, row.id);
      this.failAttempt(row, fee, "failed on-chain");
      return;
    }
    this.d.intents.markLanded(intentId, this.now());
    await this.applyLandedSell(intent, tx, solPrice);
  }

  private async applyLandedSell(intent: IntentRow, tx: Record<string, unknown>, solPrice: number): Promise<void> {
    const row = intent.positionId !== null ? this.d.positions.get(intent.positionId) : undefined;
    const effects = extractConfirmedEffects(tx, this.address);
    if (row) {
      const fill = sellFillFromEffects(effects, intent.mint, solPrice);
      await this.d.hooks.recordSell(row, fill, {
        signature: intent.signature!,
        solPriceUsd: solPrice,
        sellAttempts: row.sellAttempts + 1,
        quoteInAmount: intent.expectedInRaw,
        quoteOutAmount: intent.expectedOutRaw,
      });
    }
    this.d.intents.resolve(intent.id, "applied", this.now(), { feeLamports: Number(effects.feeLamports) });
  }

  /**
   * Resolves one unresolved intent (startup, or before a retry). Returns
   * "closed" if it closed the position, "in_flight" if it must be waited for,
   * otherwise "resolved".
   */
  async resolveOne(intent: IntentRow): Promise<"closed" | "in_flight" | "resolved"> {
    const res = await resolveIntent(intent, this.d.rpc);
    const solPrice = this.d.hooks.solPriceUsd() ?? 0;
    const position = intent.positionId !== null ? this.d.positions.get(intent.positionId) : undefined;
    switch (res.kind) {
      case "in_flight":
        if (intent.signature && intent.signedTxB64 && intent.lastValidBlockHeight !== null) {
          // Resume confirming (and resending) it; once its outcome is known, resolve it again to apply it.
          const resumed = this.d.pool
            .track({ signature: intent.signature, signedTxB64: intent.signedTxB64, lastValidBlockHeight: intent.lastValidBlockHeight })
            .then(async () => {
              const fresh = this.d.intents.get(intent.id);
              if (fresh && ["pending", "signed", "sent", "landed"].includes(fresh.status)) await this.resolveOne(fresh);
            })
            .catch((err: unknown) => this.d.logger.error("Resumed intent resolution failed", { intentId: intent.id, error: String(err) }));
          this.track(resumed);
        }
        return "in_flight";
      case "abandoned":
        this.d.intents.resolve(intent.id, "abandoned", this.now(), { error: res.reason });
        if (intent.kind === "sell" && position) this.failAttempt(position, 0, res.reason);
        return "resolved";
      case "expired":
        this.d.intents.resolve(intent.id, "expired", this.now());
        if (intent.kind === "sell" && position) this.failAttempt(position, 0, "expired unlanded");
        return "resolved";
      case "failed": {
        const fee = this.recordFeeLoss(intent, res.tx, intent.kind, solPrice, intent.positionId);
        if (intent.kind === "sell" && position) this.failAttempt(position, fee, "failed on-chain");
        return "resolved";
      }
      case "landed":
        this.d.intents.markLanded(intent.id, this.now());
        if (intent.kind === "buy") {
          await this.applyLandedBuy(intent, res.tx, solPrice);
          this.d.hooks.alert(`Recovered a live buy of ${intent.mint} that landed without being recorded; it is now a managed position.`);
          return "resolved";
        }
        if (intent.kind === "sell") {
          await this.applyLandedSell(intent, res.tx, solPrice);
          if (position) this.d.hooks.alert(`Recovered a live sell of ${intent.mint} that landed without being recorded; the position is closed with its real proceeds.`);
          return "closed";
        }
        this.d.intents.resolve(intent.id, "applied", this.now());
        return "resolved";
    }
  }

  /** Startup (SPEC.md sections 8.5, 16.5): resolve every unresolved live intent, then reconcile. */
  async startup(): Promise<void> {
    for (const intent of this.d.intents.listUnresolved("live")) {
      try {
        await this.resolveOne(intent);
      } catch (err) {
        this.d.logger.error("Intent resolution failed at startup; it will be retried", { intentId: intent.id, error: String(err) });
      }
    }
    await this.reconcileNow();
  }

  /** SPEC.md section 16.5 reconciliation (read lane). */
  async reconcileNow(): Promise<ReconcileResult> {
    const accounts: Array<{ address: string; mint: string; amountRaw: bigint; program: string }> = [];
    for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      for (const { pubkey, account } of await this.d.rpc.getTokenAccountsByOwner(this.address, program)) {
        const parsed = parseAccount(account, `token account ${pubkey}`);
        if (!parsed?.token) continue;
        accounts.push({ address: pubkey, mint: parsed.token.mint, amountRaw: parsed.token.amount, program: parsed.token.program });
      }
    }
    const live = this.d.positions.listAllActive().filter((p) => p.mode === "live");
    const unresolved = this.d.intents.listUnresolved("live").map((i) => ({ mint: i.mint, positionId: i.positionId }));
    const result = reconcile({ positions: live.map((p) => ({ id: p.id, mint: p.mint, tokenAmountRaw: p.tokenAmountRaw })), tokenAccounts: accounts, unresolved });

    for (const id of result.closeReconciled) {
      const row = this.d.positions.get(id);
      if (row) await this.d.hooks.closeReconciled(row);
    }
    for (const u of result.updateAmount) {
      const row = this.d.positions.get(u.id);
      const decimals = row?.tokenDecimals ?? 0;
      this.d.positions.updateLive(u.id, { tokenAmountRaw: u.toRaw, tokenAmount: Number(u.toRaw) / 10 ** decimals });
      this.d.logger.warn("Reconciliation adopted the on-chain token amount", { positionId: u.id, from: u.fromRaw, to: u.toRaw });
    }
    const previouslyUnknown = new Set((this.lastReconcile?.unknownTokens ?? []).map((t) => t.mint));
    const newlyUnknown = result.unknownTokens.filter((t) => !previouslyUnknown.has(t.mint));
    if (newlyUnknown.length > 0) {
      this.d.hooks.alert(`Unknown tokens in the wallet (no position, no intent; never traded automatically): ${newlyUnknown.map((t) => t.mint).join(", ")}`);
    }
    this.lastReconcile = result;
    return result;
  }

  /** /sellretry <mint prefix> (SPEC.md section 16.6). */
  sellRetry(prefix: string): string {
    const candidates = this.d.positions.listClosing().filter((p) => p.mode === "live");
    const match = matchStuckPosition(candidates, prefix);
    if (!match.ok) return match.reason;
    const row = match.position;
    this.saveState(row.id, grantSellBudget(this.stateOf(row), this.now(), this.sellPolicy()));
    this.d.hooks.event("sellretry", `Granted one more sell fee budget to position ${row.id}`, { positionId: row.id });
    return `Granted one more SELL_FEE_BUDGET_SOL to ${row.symbol ?? row.mint}; sell attempts resume on the backoff schedule.`;
  }

  /** Worst-case exit fee estimate for valuation (SPEC.md section 8.1): (base fee + MAX_PRIORITY_FEE_SOL) in USD, minus reclaimable rent. */
  exitCostUsd(row: PositionRow, solPriceUsd: number): number {
    const fee = lamportsToUsd(BigInt(BASE_FEE_LAMPORTS + this.d.config.maxPriorityFeeLamports), solPriceUsd);
    const rent = this.d.config.CLOSE_EMPTY_ATA && row.closeAta && row.entryRentLamports ? lamportsToUsd(BigInt(row.entryRentLamports), solPriceUsd) : 0;
    return fee - rent;
  }
}

