import { z } from "zod";
import { envSchema } from "../config/schema.js";
import { exitConfigFromEnv } from "../monitor/exitConfig.js";
import type { ExitStateMachineConfig } from "../monitor/stateMachine.js";
import type { ShadowCostConfig } from "../tracking/shadows.js";

/**
 * The .env fields a replay reads: the exit state machine, the target, the
 * section 11.2 cost model, sizing, and the section 11.5 point schedule.
 * Picked from the bot's own envSchema so types and defaults can't drift.
 */
const replayEnvSchema = envSchema.pick({
  TRADING_DAY_TZ: true,
  STOP_LOSS_PCT: true,
  TARGET_PROFIT_PCT: true,
  EXTRA_TARGET_PCT: true,
  MAX_TARGET_EXTENSIONS: true,
  HOLD_MINUTES: true,
  FAST_GAIN_PCT: true,
  FAST_WINDOW_MINUTES: true,
  FAST_MIN_HISTORY_SEC: true,
  FAST_CONFIRM_POLLS: true,
  MAX_TIMER_RESTARTS: true,
  MAX_TOTAL_HOLD_MINUTES: true,
  TRAIL_PCT: true,
  BREAKEVEN_TRIGGER_PCT: true,
  BREAKEVEN_FLOOR_PCT: true,
  FLAT_BAND_PCT: true,
  LIQ_DROP_EXIT_PCT: true,
  LIQ_DROP_CONFIRM_READS: true,
  NO_ROUTE_EXIT_SEC: true,
  LIQ_CHECK_SECONDS: true,
  STUCK_WRITE_OFF_MIN: true,
  POSITION_USD: true,
  MAX_POSITION_PCT_OF_LIQ: true,
  PAPER_EXTRA_SLIPPAGE_PCT: true,
  PAPER_LATENCY_SEC: true,
  PAPER_FEE_USD_PER_TX: true,
  SHADOW_POOL_FEE_PCT: true,
  SHADOW_POLL_SECONDS: true,
  PATH_FAST_SECONDS: true,
  PATH_FAST_WINDOW_MIN: true,
});

export type ReplayEnv = z.infer<typeof replayEnvSchema>;
export const OVERRIDABLE_KEYS = new Set(Object.keys(replayEnvSchema.shape).filter((k) => k !== "TRADING_DAY_TZ"));

/** Entry filters over data known at first READY (the path's entry snapshot and mint_features). */
const filtersSchema = z
  .object({
    minPairAgeMin: z.number().optional(),
    maxPairAgeMin: z.number().optional(),
    minM5ChangePct: z.number().optional(),
    maxM5ChangePct: z.number().optional(),
    minH1ChangePct: z.number().optional(),
    maxH1ChangePct: z.number().optional(),
    minScore: z.number().optional(),
    maxTop10Pct: z.number().optional(),
    maxSniperSharePct: z.number().optional(),
    lpStatus: z.array(z.enum(["burned", "withdrawable"])).optional(),
    minHolderCount: z.number().optional(),
    maxCreatorHoldingPct: z.number().optional(),
    requirePumpMigrated: z.boolean().optional(),
    /** Price at READY + N seconds must be >= price at READY; the entry then moves to READY + N. */
    survivalDelaySec: z.number().positive().optional(),
    /** A filter over a null feature rejects the mint ("reject", default) or lets it through ("pass"). */
    nullPolicy: z.enum(["reject", "pass"]).optional(),
  })
  .strict();

export type EntryFilters = z.infer<typeof filtersSchema>;

const overridesSchema = z.record(z.string(), z.union([z.number(), z.string(), z.boolean()]));

const fileSchema = z
  .object({
    baseline: z.object({ overrides: overridesSchema.optional(), filters: filtersSchema.optional() }).strict().optional(),
    variants: z
      .array(z.object({ name: z.string().min(1), exit: overridesSchema.optional(), filters: filtersSchema.optional() }).strict())
      .default([]),
  })
  .strict();

export interface ReplayParams {
  exit: ExitStateMachineConfig;
  targetProfitPct: number;
  cost: ShadowCostConfig;
  positionUsd: number;
  maxPositionPctOfLiq: number;
  latencySec: number;
  liqCheckSeconds: number;
  stuckWriteOffMin: number;
  pathFastSeconds: number;
  pathFastWindowMin: number;
  shadowPollSeconds: number;
}

export interface ReplayVariant {
  name: string;
  params: ReplayParams;
  filters: EntryFilters;
}

export class ReplayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayConfigError";
  }
}

export function paramsFromEnv(e: ReplayEnv): ReplayParams {
  return {
    exit: exitConfigFromEnv(e),
    targetProfitPct: e.TARGET_PROFIT_PCT,
    cost: { poolFeePct: e.SHADOW_POOL_FEE_PCT, extraSlippagePct: e.PAPER_EXTRA_SLIPPAGE_PCT, feeUsdPerTx: e.PAPER_FEE_USD_PER_TX },
    positionUsd: e.POSITION_USD,
    maxPositionPctOfLiq: e.MAX_POSITION_PCT_OF_LIQ,
    latencySec: e.PAPER_LATENCY_SEC,
    liqCheckSeconds: e.LIQ_CHECK_SECONDS,
    stuckWriteOffMin: e.STUCK_WRITE_OFF_MIN,
    pathFastSeconds: e.PATH_FAST_SECONDS,
    pathFastWindowMin: e.PATH_FAST_WINDOW_MIN,
    shadowPollSeconds: e.SHADOW_POLL_SECONDS,
  };
}

function parseEnv(env: Record<string, string | undefined>, overrides: Record<string, unknown>, where: string): ReplayEnv {
  const unknown = Object.keys(overrides).filter((k) => !OVERRIDABLE_KEYS.has(k));
  if (unknown.length > 0) throw new ReplayConfigError(`${where}: unknown or non-overridable key(s): ${unknown.join(", ")}`);
  const merged: Record<string, string | undefined> = { ...env };
  for (const [k, v] of Object.entries(overrides)) merged[k] = String(v);
  const parsed = replayEnvSchema.safeParse(merged);
  if (!parsed.success) throw new ReplayConfigError(`${where}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/**
 * Builds the baseline (the current .env plus any baseline overrides) and
 * each variant (baseline plus its own exit overrides and filters).
 */
export function buildVariants(env: Record<string, string | undefined>, raw: unknown): { baseline: ReplayVariant; variants: ReplayVariant[]; timeZone: string } {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new ReplayConfigError(`config file: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const baseOverrides = parsed.data.baseline?.overrides ?? {};
  const baseEnv = parseEnv(env, baseOverrides, "baseline");
  const baseline: ReplayVariant = { name: "baseline", params: paramsFromEnv(baseEnv), filters: parsed.data.baseline?.filters ?? {} };
  const names = new Set<string>(["baseline"]);
  const variants = parsed.data.variants.map((v) => {
    if (names.has(v.name)) throw new ReplayConfigError(`duplicate variant name: ${v.name}`);
    names.add(v.name);
    const e = parseEnv(env, { ...baseOverrides, ...(v.exit ?? {}) }, `variant ${v.name}`);
    return { name: v.name, params: paramsFromEnv(e), filters: v.filters ?? {} };
  });
  return { baseline, variants, timeZone: baseEnv.TRADING_DAY_TZ };
}
