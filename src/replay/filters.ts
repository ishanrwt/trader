import type { MintFeaturesRow } from "../storage/mintFeatures.js";
import type { PricePathPoint, PricePathRow } from "../storage/pricePaths.js";
import type { EntryFilters } from "./config.js";

export type FilterOutcome =
  | { pass: true; entryAt: number }
  /** `null:<filter>` when the feature was missing, `<filter>` when it failed the threshold. */
  | { pass: false; reason: string };

function priceChange(snapshot: unknown, key: "m5" | "h1"): number | null {
  const v = (snapshot as { priceChange?: Record<string, unknown> } | null)?.priceChange?.[key];
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Applies a variant's entry filters to one path. Uses only what was known
 * at first READY, except the survival delay, which moves the entry to
 * READY + N seconds so it never looks ahead of its own entry.
 */
export function applyFilters(
  f: EntryFilters,
  path: PricePathRow,
  features: MintFeaturesRow | undefined,
  points: readonly PricePathPoint[],
): FilterOutcome {
  const passNull = f.nullPolicy === "pass";
  const checks: Array<[string, unknown, number | null | undefined | string | boolean, (v: never) => boolean]> = [];
  const add = <T>(name: string, threshold: unknown, value: T | null | undefined, ok: (v: T) => boolean) => {
    if (threshold !== undefined) checks.push([name, threshold, value as never, ok as (v: never) => boolean]);
  };
  const ageMin = path.pairAgeMs === null ? null : path.pairAgeMs / 60_000;
  add("minPairAgeMin", f.minPairAgeMin, ageMin, (v: number) => v >= f.minPairAgeMin!);
  add("maxPairAgeMin", f.maxPairAgeMin, ageMin, (v: number) => v <= f.maxPairAgeMin!);
  add("minM5ChangePct", f.minM5ChangePct, priceChange(path.pairSnapshot, "m5"), (v: number) => v >= f.minM5ChangePct!);
  add("maxM5ChangePct", f.maxM5ChangePct, priceChange(path.pairSnapshot, "m5"), (v: number) => v <= f.maxM5ChangePct!);
  add("minH1ChangePct", f.minH1ChangePct, priceChange(path.pairSnapshot, "h1"), (v: number) => v >= f.minH1ChangePct!);
  add("maxH1ChangePct", f.maxH1ChangePct, priceChange(path.pairSnapshot, "h1"), (v: number) => v <= f.maxH1ChangePct!);
  add("minScore", f.minScore, path.score, (v: number) => v >= f.minScore!);
  add("maxTop10Pct", f.maxTop10Pct, path.top10Pct, (v: number) => v <= f.maxTop10Pct!);
  add("maxSniperSharePct", f.maxSniperSharePct, features?.sniperSharePct, (v: number) => v <= f.maxSniperSharePct!);
  add("lpStatus", f.lpStatus, features?.lpStatus, (v: string) => f.lpStatus!.includes(v as "burned" | "withdrawable"));
  add("minHolderCount", f.minHolderCount, features?.holderCount, (v: number) => v >= f.minHolderCount!);
  add("maxCreatorHoldingPct", f.maxCreatorHoldingPct, features?.creatorHoldingPct, (v: number) => v <= f.maxCreatorHoldingPct!);
  if (f.requirePumpMigrated) add("requirePumpMigrated", true, features?.pumpMigrated, (v: boolean) => v === true);

  for (const [name, , value, ok] of checks) {
    if (value === null || value === undefined) {
      if (!passNull) return { pass: false, reason: `null:${name}` };
      continue;
    }
    if (!ok(value as never)) return { pass: false, reason: name };
  }

  if (f.survivalDelaySec !== undefined) {
    const ready = points[0];
    const at = path.startedAt + f.survivalDelaySec * 1000;
    const later = points.find((p) => p.t >= at && p.gap === null && p.priceUsd !== null);
    if (!ready || ready.priceUsd === null || !later) return { pass: false, reason: "null:survivalDelaySec" };
    if (later.priceUsd! < ready.priceUsd) return { pass: false, reason: "survivalDelaySec" };
    return { pass: true, entryAt: later.t };
  }
  return { pass: true, entryAt: path.startedAt };
}
