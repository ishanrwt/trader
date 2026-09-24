export interface ScoreWeights {
  buyPressure: number;
  activity: number;
  momentum: number;
  depth: number;
  holders: number;
  freshness: number;
}

export interface ScoreConfig {
  weights: ScoreWeights;
  activityCap: number;
  momentumCapPct: number;
  minLiquidityUsd: number;
  depthCapUsd: number;
  maxTop10Pct: number;
  entryWindowMin: number;
}

export interface ScoreInput {
  buysM5: number;
  sellsM5: number;
  volumeM5: number;
  liquidityUsd: number;
  m5ChangePct: number;
  h1ChangePct: number;
  top10Pct: number;
  minutesSinceEligible: number;
}

export interface ScoreComponents {
  buyPressure: number;
  activity: number;
  momentum: number;
  depth: number;
  holders: number;
  freshness: number;
}

export interface ScoreResult {
  score: number;
  components: ScoreComponents;
}

function clip01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** SPEC.md section 6.1: pure score function, 0 to 1, each component clipped to 0..1. */
export function computeScore(input: ScoreInput, cfg: ScoreConfig): ScoreResult {
  const totalTxns = input.buysM5 + input.sellsM5;
  const buyPressure = clip01(totalTxns > 0 ? input.buysM5 / totalTxns : 0);

  const activity = clip01(cfg.activityCap > 0 ? input.volumeM5 / input.liquidityUsd / cfg.activityCap : 0);

  const momentumRaw = (input.m5ChangePct + input.h1ChangePct) / 2;
  const momentumClipped = Math.min(Math.max(momentumRaw, 0), cfg.momentumCapPct);
  const momentum = clip01(cfg.momentumCapPct > 0 ? momentumClipped / cfg.momentumCapPct : 0);

  const depthDenom = Math.log10(cfg.depthCapUsd) - Math.log10(cfg.minLiquidityUsd);
  const depth = clip01(
    depthDenom !== 0 && input.liquidityUsd > 0 && cfg.minLiquidityUsd > 0
      ? (Math.log10(input.liquidityUsd) - Math.log10(cfg.minLiquidityUsd)) / depthDenom
      : 0,
  );

  const holders = clip01(cfg.maxTop10Pct > 0 ? (cfg.maxTop10Pct - input.top10Pct) / cfg.maxTop10Pct : 0);

  const freshness = clip01(cfg.entryWindowMin > 0 ? 1 - input.minutesSinceEligible / cfg.entryWindowMin : 0);

  const components: ScoreComponents = { buyPressure, activity, momentum, depth, holders, freshness };
  const w = cfg.weights;
  const score =
    w.buyPressure * buyPressure +
    w.activity * activity +
    w.momentum * momentum +
    w.depth * depth +
    w.holders * holders +
    w.freshness * freshness;

  return { score, components };
}
