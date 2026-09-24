export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: readonly number[]): number {
  return percentile(values, 50);
}

/** Linear-interpolation percentile (p in [0,100]), the common convention for p10/p90. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  const weight = rank - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

/** Pearson correlation coefficient; 0 if either series has zero variance or the inputs are empty/mismatched. */
export function pearsonCorrelation(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length || xs.length === 0) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

/** Max drawdown (a positive USD value) of the cumulative sum of `series` taken in order. */
export function maxDrawdown(series: readonly number[]): number {
  let cumulative = 0;
  let peak = 0;
  let worst = 0;
  for (const v of series) {
    cumulative += v;
    peak = Math.max(peak, cumulative);
    worst = Math.max(worst, peak - cumulative);
  }
  return worst;
}

/** Splits `values` (already sorted by the caller's chosen key) into `buckets` equal-size groups, earliest bucket first. */
export function equalSizeBuckets<T>(sortedValues: readonly T[], buckets: number): T[][] {
  if (sortedValues.length === 0 || buckets <= 0) return [];
  const result: T[][] = [];
  const size = Math.ceil(sortedValues.length / buckets);
  for (let i = 0; i < sortedValues.length; i += size) {
    result.push(sortedValues.slice(i, i + size));
  }
  return result;
}
