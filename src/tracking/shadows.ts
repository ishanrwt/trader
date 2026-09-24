import { step, type ExitState, type ExitStateMachineConfig, type ExitStepResult } from "../monitor/stateMachine.js";

export interface ShadowCostConfig {
  poolFeePct: number;
  extraSlippagePct: number;
  feeUsdPerTx: number;
}

export interface ShadowEntry {
  tokens: number;
  costBasis: number;
  entryPrice: number;
}

/**
 * SPEC.md section 11.2: constant-product cost estimate for a shadow entry.
 * With liquidity L and reserve R = L/2 per side, entryPrice = priceUsd *
 * (1 + size/R) * (1 + SHADOW_POOL_FEE_PCT/100) * (1 + PAPER_EXTRA_SLIPPAGE_PCT/100).
 * No network client of any kind is imported by this file — it's pure math
 * over already-fetched inputs (see SPEC.md section 11.2: shadows are priced
 * from DexScreener batches only and must never reach the other quote provider).
 */
export function shadowEntry(sizeUsd: number, priceUsd: number, liquidityUsd: number, cfg: ShadowCostConfig): ShadowEntry {
  const reserve = liquidityUsd / 2;
  const entryPrice = priceUsd * (1 + sizeUsd / reserve) * (1 + cfg.poolFeePct / 100) * (1 + cfg.extraSlippagePct / 100);
  const tokens = sizeUsd / entryPrice;
  const costBasis = sizeUsd + cfg.feeUsdPerTx;
  return { tokens, costBasis, entryPrice };
}

/**
 * SPEC.md section 11.2: value at price p and liquidity L' (R' = L'/2), with
 * V = tokens * p: proceeds = V * R'/(R'+V) * (1 - SHADOW_POOL_FEE_PCT/100) *
 * (1 - PAPER_EXTRA_SLIPPAGE_PCT/100) - PAPER_FEE_USD_PER_TX.
 */
export function shadowValue(tokens: number, priceUsd: number, liquidityUsd: number, cfg: ShadowCostConfig): number {
  const reserve = liquidityUsd / 2;
  const v = tokens * priceUsd;
  const grossProceeds = (v * reserve) / (reserve + v);
  return grossProceeds * (1 - cfg.poolFeePct / 100) * (1 - cfg.extraSlippagePct / 100) - cfg.feeUsdPerTx;
}

/**
 * SPEC.md section 11.2: shadows run the same exit state machine, but with
 * confirmPnlPct = pnlPct (no second quote) — so a stop-loss reading never
 * produces NEED_CONFIRM for a shadow, it resolves in this single call.
 */
export function shadowStep(
  state: ExitState,
  inputs: { now: number; pnlPct: number | null; liquidityUsd?: number },
  cfg: ExitStateMachineConfig,
): Exclude<ExitStepResult, { action: "NEED_CONFIRM" }> {
  const result = step(
    state,
    {
      now: inputs.now,
      pnlPct: inputs.pnlPct,
      ...(inputs.pnlPct !== null ? { confirmPnlPct: inputs.pnlPct } : {}),
      ...(inputs.liquidityUsd !== undefined ? { liquidityUsd: inputs.liquidityUsd } : {}),
    },
    cfg,
  );
  // Unreachable in practice: confirmPnlPct is always supplied whenever pnlPct isn't null,
  // so step 3 never has cause to ask for a confirmation.
  if (result.action === "NEED_CONFIRM") {
    throw new Error("shadowStep: unexpected NEED_CONFIRM despite confirmPnlPct being pre-supplied");
  }
  return result;
}
