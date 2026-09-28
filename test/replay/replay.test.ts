import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildVariants, ReplayConfigError, type ReplayParams, type ReplayVariant } from "../../src/replay/config.js";
import { applyFilters } from "../../src/replay/filters.js";
import { crossCheck, driftWarning, runVariant, splitStats, type RealTrade, type ReplayPath } from "../../src/replay/index.js";
import { pathCompleteness, simulatePath } from "../../src/replay/simulate.js";
import type { MintFeaturesRow } from "../../src/storage/mintFeatures.js";
import type { PricePathPoint, PricePathRow } from "../../src/storage/pricePaths.js";

const T0 = Date.UTC(2026, 8, 28, 0, 0, 0);
const MIN = 60_000;

/** The current .env exit values, with fees off and latency 0 so marks equal the price change (liquidity is huge: no impact). */
const PARAMS: ReplayParams = {
  exit: {
    stopLossPct: 15,
    extraTargetPct: 10,
    maxTargetExtensions: 1,
    holdMinutes: 15,
    fastGainPct: 15,
    fastWindowMinutes: 5,
    fastMinHistorySec: 60,
    fastConfirmPolls: 2,
    maxTimerRestarts: 3,
    maxTotalHoldMinutes: 60,
    trailPct: 4,
    breakevenTriggerPct: 20,
    breakevenFloorPct: 2,
    flatBandPct: 3,
    liqDropExitPct: 30,
    liqDropConfirmReads: 2,
    noRouteExitSec: 30,
  },
  targetProfitPct: 40,
  cost: { poolFeePct: 0, extraSlippagePct: 0, feeUsdPerTx: 0 },
  positionUsd: 25,
  maxPositionPctOfLiq: 1,
  latencySec: 0,
  liqCheckSeconds: 30,
  stuckWriteOffMin: 30,
  pathFastSeconds: 5,
  pathFastWindowMin: 10,
  shadowPollSeconds: 15,
};
const LIQ = 1e15;

/** Section 11.5's schedule for a full 60-minute path: every 5 s for 10 min, then every 15 s. */
function schedule(): number[] {
  const ts: number[] = [];
  for (let t = 0; t < 60 * MIN; t += t < 10 * MIN ? 5000 : 15000) ts.push(T0 + t);
  return ts;
}

function buildPoints(price: (sec: number) => number | "gap", times: number[] = schedule()): PricePathPoint[] {
  return times.map((t) => {
    const p = price((t - T0) / 1000);
    return p === "gap"
      ? { t, priceUsd: null, liquidityUsd: null, buysM5: null, sellsM5: null, volumeM5: null, gap: "no_pair" as const }
      : { t, priceUsd: p, liquidityUsd: LIQ, buysM5: 1, sellsM5: 1, volumeM5: 1, gap: null };
  });
}

function mkPath(id: number, over: Partial<PricePathRow> = {}): PricePathRow {
  return {
    id,
    mint: `mint${id}`,
    mode: "paper",
    startedAt: T0,
    endsAt: T0 + 60 * MIN,
    status: "done",
    pairSnapshot: { priceChange: { m5: 10, h1: 50 } },
    dexId: "pumpswap",
    pairAgeMs: 30 * MIN,
    top1Pct: 5,
    top10Pct: 20,
    score: 0.6,
    scoreComponents: null,
    selected: false,
    sellabilityLossPct: null,
    sellabilityCheckedAt: null,
    lastPointAt: null,
    ...over,
  };
}

function mkFeatures(mint: string, over: Partial<MintFeaturesRow> = {}): MintFeaturesRow {
  return {
    mint,
    mode: "paper",
    recordedAt: T0,
    poolProgram: null,
    poolCanonical: null,
    pumpMigrated: true,
    lpSupplyPool: null,
    lpMintSupply: null,
    lpStatus: "burned",
    lpBurnedPct: 100,
    lpLockedPct: 0,
    lpWithdrawablePct: 0,
    holderCount: 500,
    sniperSharePct: 10,
    sniperSlots: null,
    sniperTxs: null,
    sniperCapped: null,
    creator: null,
    creatorHoldingPct: 1,
    rugcheckScore: null,
    rugcheckScoreNormalised: null,
    rugcheckLpLockedPct: null,
    rugcheckRisks: null,
    reasons: {},
    creditsUsed: 0,
    ...over,
  };
}

const variant = (name: string, params: ReplayParams = PARAMS, filters: ReplayVariant["filters"] = {}): ReplayVariant => ({ name, params, filters });

// Scenarios, price as a function of seconds since READY (entry price 1).
const stopScenario = (s: number) => (s < 30 ? 1 : 0.8);
const targetScenario = (s: number) => (s < 60 ? 1 : 1.5);
// Two fast polls (60 s, 65 s) make the move "fast", so the target at 70 s is raised (and arms the trail) instead of selling.
const trailScenario = (s: number) => (s < 60 ? 1 : s === 60 ? 1.2 : s === 65 ? 1.3 : s === 70 ? 1.45 : 1.4);
const dumpScenario = (s: number) => (s < 30 ? 1 : s < 60 ? 0.88 : 0.5);

describe("replay: baseline reproduces known exits on hand-built paths", () => {
  it("stop: a drop to -20% sells `stop` at that point, at exactly -20%", () => {
    const t = simulatePath(buildPoints(stopScenario), PARAMS, { entryAt: T0 })!;
    expect(t.exitReason).toBe("stop");
    expect(t.exitTime).toBe(T0 + 30_000);
    expect(t.netPnlPct).toBeCloseTo(-20, 6);
  });

  it("target: a jump to +50% sells `target` (one fast poll is not yet fast)", () => {
    const t = simulatePath(buildPoints(targetScenario), PARAMS, { entryAt: T0 })!;
    expect(t.exitReason).toBe("target");
    expect(t.exitTime).toBe(T0 + 60_000);
    expect(t.netPnlPct).toBeCloseTo(50, 6);
  });

  it("trail: a fast move raises the target to 50% and arms the trail; 45% → 40% sells `trail`", () => {
    const t = simulatePath(buildPoints(trailScenario), PARAMS, { entryAt: T0 })!;
    expect(t.exitReason).toBe("trail");
    expect(t.exitTime).toBe(T0 + 75_000);
    expect(t.netPnlPct).toBeCloseTo(40, 6);
    expect(t.peakPnl).toBeCloseTo(45, 6);
  });

  it("entry and exit fill wait PAPER_LATENCY_SEC for the next point", () => {
    const t = simulatePath(buildPoints(stopScenario), { ...PARAMS, latencySec: 3 }, { entryAt: T0 })!;
    expect(t.entryTime).toBe(T0 + 5000);
    expect(t.exitTime).toBe(T0 + 35_000);
  });

  it("gap rows are no route: `no_route` after NO_ROUTE_EXIT_SEC, filled at the next priced point", () => {
    const t = simulatePath(buildPoints((s) => (s >= 30 && s < 95 ? "gap" : s < 30 ? 1 : 0.9)), PARAMS, { entryAt: T0 })!;
    expect(t.exitReason).toBe("no_route");
    expect(t.exitTime).toBe(T0 + 95_000);
    expect(t.netPnlPct).toBeCloseTo(-10, 6);
  });

  it("uses the shadow cost model: fees and impact put a flat position below zero at its deadline", () => {
    const cost = { poolFeePct: 1, extraSlippagePct: 2, feeUsdPerTx: 0.05 };
    const t = simulatePath(buildPoints(() => 1), { ...PARAMS, cost }, { entryAt: T0 })!;
    expect(t.exitReason).toBe("time_exit");
    expect(t.exitTime).toBe(T0 + 15 * MIN);
    expect(t.netPnlPct).toBeLessThan(-5);
  });
});

describe("replay: config changes the outcome", () => {
  it("a tighter stop exits the dump earlier with a smaller loss", () => {
    const points = buildPoints(dumpScenario);
    const base = simulatePath(points, PARAMS, { entryAt: T0 })!;
    const tight = simulatePath(points, { ...PARAMS, exit: { ...PARAMS.exit, stopLossPct: 10 } }, { entryAt: T0 })!;
    expect(base.exitReason).toBe("stop");
    expect(base.exitTime).toBe(T0 + 60_000);
    expect(base.netPnlPct).toBeCloseTo(-50, 6);
    expect(tight.exitReason).toBe("stop");
    expect(tight.exitTime).toBe(T0 + 30_000);
    expect(tight.netPnlPct).toBeCloseTo(-12, 6);
  });

  it("builds the baseline from .env and variants from overrides; rejects unknown keys", () => {
    const env = { STOP_LOSS_PCT: "15", TARGET_PROFIT_PCT: "40" };
    const { baseline, variants } = buildVariants(env, { variants: [{ name: "tight", exit: { STOP_LOSS_PCT: 8, TARGET_PROFIT_PCT: 25 } }] });
    expect(baseline.params.exit.stopLossPct).toBe(15);
    expect(baseline.params.targetProfitPct).toBe(40);
    expect(variants[0]!.params.exit.stopLossPct).toBe(8);
    expect(variants[0]!.params.targetProfitPct).toBe(25);
    expect(() => buildVariants(env, { variants: [{ name: "bad", exit: { WALLET_PRIVATE_KEY: "x" } }] })).toThrow(ReplayConfigError);
    expect(() => buildVariants(env, { variants: [{ name: "bad", filters: { maxSniper: 1 } }] })).toThrow(ReplayConfigError);
  });

  it("paramsFromEnv maps the cost model fields", () => {
    const { baseline } = buildVariants({ SHADOW_POOL_FEE_PCT: "1", PAPER_EXTRA_SLIPPAGE_PCT: "2", PAPER_FEE_USD_PER_TX: "0.05" }, {});
    expect(baseline.params.cost).toEqual({ poolFeePct: 1, extraSlippagePct: 2, feeUsdPerTx: 0.05 });
  });
});

describe("replay: entry filters", () => {
  const points = buildPoints((s) => (s < 60 ? 1 : 1.1));

  it("drops by threshold and by missing feature; nullPolicy pass lets missing through", () => {
    const f = { maxSniperSharePct: 20 };
    expect(applyFilters(f, mkPath(1), mkFeatures("mint1", { sniperSharePct: 10 }), points)).toEqual({ pass: true, entryAt: T0 });
    expect(applyFilters(f, mkPath(2), mkFeatures("mint2", { sniperSharePct: 30 }), points)).toEqual({ pass: false, reason: "maxSniperSharePct" });
    expect(applyFilters(f, mkPath(3), mkFeatures("mint3", { sniperSharePct: null }), points)).toEqual({ pass: false, reason: "null:maxSniperSharePct" });
    expect(applyFilters(f, mkPath(4), undefined, points)).toEqual({ pass: false, reason: "null:maxSniperSharePct" });
    expect(applyFilters({ ...f, nullPolicy: "pass" }, mkPath(3), mkFeatures("mint3", { sniperSharePct: null }), points).pass).toBe(true);
  });

  it("filters over the entry snapshot and features", () => {
    const p = mkPath(1);
    expect(applyFilters({ minPairAgeMin: 60 }, p, mkFeatures("mint1"), points)).toEqual({ pass: false, reason: "minPairAgeMin" });
    expect(applyFilters({ maxH1ChangePct: 40 }, p, mkFeatures("mint1"), points)).toEqual({ pass: false, reason: "maxH1ChangePct" });
    expect(applyFilters({ lpStatus: ["burned"] }, p, mkFeatures("mint1", { lpStatus: "withdrawable" }), points)).toEqual({ pass: false, reason: "lpStatus" });
    expect(applyFilters({ lpStatus: ["burned"], maxH1ChangePct: 60, minHolderCount: 100 }, p, mkFeatures("mint1"), points).pass).toBe(true);
  });

  it("survival delay keeps a mint still at or above its READY price at T+N and moves its entry there", () => {
    expect(applyFilters({ survivalDelaySec: 60 }, mkPath(1), undefined, points)).toEqual({ pass: true, entryAt: T0 + 60_000 });
    const falling = buildPoints((s) => (s < 60 ? 1 : 0.95));
    expect(applyFilters({ survivalDelaySec: 60 }, mkPath(1), undefined, falling)).toEqual({ pass: false, reason: "survivalDelaySec" });
  });

  it("runVariant drops exactly the filtered mints", () => {
    const paths: ReplayPath[] = [10, 30, 15].map((share, i) => ({
      path: mkPath(i + 1),
      points: buildPoints(stopScenario),
      features: mkFeatures(`mint${i + 1}`, { sniperSharePct: share }),
    }));
    const r = runVariant(variant("f", PARAMS, { maxSniperSharePct: 20 }), paths);
    expect(r.trades.map((t) => t.mint)).toEqual(["mint1", "mint3"]);
    expect(r.dropped).toEqual({ maxSniperSharePct: 1 });
  });
});

describe("replay: selected vs unselected split", () => {
  it("splits trades by whether paper opened a position, and counts what a filter changes", () => {
    const paths: ReplayPath[] = [
      { path: mkPath(1, { selected: true }), points: buildPoints(targetScenario), features: mkFeatures("mint1") },
      { path: mkPath(2, { selected: true }), points: buildPoints(stopScenario), features: mkFeatures("mint2", { sniperSharePct: 50 }) },
      { path: mkPath(3, { selected: false }), points: buildPoints(stopScenario), features: mkFeatures("mint3") },
    ];
    const base = runVariant(variant("baseline"), paths);
    const s = splitStats(base.trades);
    expect(s.selected.trades).toBe(2);
    expect(s.unselected.trades).toBe(1);
    expect(s.all.trades).toBe(3);
    expect(s.reasons.selected).toEqual({ target: 1, stop: 1 });
    expect(s.reasons.unselected).toEqual({ stop: 1 });
    expect(s.unselected.medianNetPnlPct).toBeCloseTo(-20, 6);

    const filtered = runVariant(variant("f", PARAMS, { maxSniperSharePct: 20 }), paths);
    expect(filtered.selectedDropped).toBe(1);
    expect(filtered.unselectedKept).toBe(1);
    expect(splitStats(filtered.trades).selected.trades).toBe(1);
  });
});

describe("replay: incomplete paths", () => {
  // The collector was down from +20 to +50 minutes: missing timestamps, not gap rows.
  const downTimes = schedule().filter((t) => t - T0 < 20 * MIN || t - T0 >= 50 * MIN);

  it("full paths are complete (320 expected points); jitter of a missed point or two is fine", () => {
    const pts = buildPoints(() => 1);
    expect(pathCompleteness(mkPath(1), pts, PARAMS)).toMatchObject({ complete: true, expected: 320, points: 320 });
    const jitter = pts.filter((_, i) => i !== 50 && i !== 51);
    expect(pathCompleteness(mkPath(1), jitter, PARAMS).complete).toBe(true);
  });

  it("a stretch with no points, or a truncated path, is incomplete", () => {
    expect(pathCompleteness(mkPath(1), buildPoints(() => 1, downTimes), PARAMS).complete).toBe(false);
    const truncated = schedule().filter((t) => t - T0 < 58 * MIN);
    expect(pathCompleteness(mkPath(1), buildPoints(() => 1, truncated), PARAMS)).toMatchObject({ complete: false, reason: "no points for 135s" });
  });

  it("is excluded by default, and flagged when included", () => {
    const paths: ReplayPath[] = [
      { path: mkPath(1), points: buildPoints(stopScenario), features: mkFeatures("mint1") },
      { path: mkPath(2), points: buildPoints(stopScenario, downTimes), features: mkFeatures("mint2") },
      { path: mkPath(3, { status: "recording" }), points: buildPoints(stopScenario), features: mkFeatures("mint3") },
    ];
    const excluded = runVariant(variant("b"), paths);
    expect(excluded.trades.map((t) => t.mint)).toEqual(["mint1"]);
    expect(excluded.excludedIncomplete).toBe(1);
    expect(excluded.stillRecording).toBe(1);

    const included = runVariant(variant("b"), paths, { includeIncomplete: true });
    expect(included.trades.map((t) => [t.mint, t.incomplete])).toEqual([
      ["mint1", false],
      ["mint2", true],
    ]);
    expect(included.includedIncomplete).toBe(1);
  });
});

describe("replay: cross-check against real trades", () => {
  const paths: ReplayPath[] = [
    { path: mkPath(1), points: buildPoints(stopScenario), features: mkFeatures("mint1") },
    { path: mkPath(2), points: buildPoints(targetScenario), features: mkFeatures("mint2") },
  ];
  const trade = (id: number, mint: string, exitReason: string, netPnlPct: number): RealTrade => ({
    id,
    mint,
    mode: "paper",
    entryTime: T0,
    exitTime: T0 + 60_000,
    sizeUsd: 25,
    costBasis: 25,
    netPnlPct,
    exitReason,
  });

  it("reproduces a matching trade, flags one outside tolerance or with a different reason, and skips uncovered ones", () => {
    const { rows, notCovered } = crossCheck(
      variant("baseline"),
      [trade(1, "mint1", "stop", -21), trade(2, "mint2", "target", 30), trade(3, "mint1", "trail", -20), trade(4, "other", "stop", -20)],
      paths,
      5,
    );
    expect(notCovered).toBe(1);
    expect(rows.map((r) => [r.trade.id, r.flagged])).toEqual([
      [1, false],
      [2, true],
      [3, true],
    ]);
    expect(rows[1]!.deltaPct).toBeCloseTo(20, 6);
  });

  it("warns when the replay's drift is far from the shadow method's", () => {
    const shadow = { meanSignedDiffPct: -1.5, meanAbsDiffPct: 19.4 };
    expect(driftWarning({ pairs: 10, meanSignedDiffPct: 3, meanAbsDiffPct: 16, correlation: 0.5 }, shadow)).toBeNull();
    expect(driftWarning({ pairs: 10, meanSignedDiffPct: 3, meanAbsDiffPct: 60, correlation: 0.5 }, shadow)).toMatch(/WARNING/);
    expect(driftWarning({ pairs: 10, meanSignedDiffPct: 20, meanAbsDiffPct: 20, correlation: 0.5 }, shadow)).toMatch(/WARNING/);
  });
});

describe("replay: offline", () => {
  it("no replay module reaches a network client at runtime, directly or transitively (type-only imports are erased)", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(/^\s*import\s(?!type\s)[^;]*?from\s+"(\.[^"]+)"/gms)) {
        const target = path.resolve(path.dirname(file), m[1]!.replace(/\.js$/, ".ts"));
        walk(target);
      }
    };
    for (const f of fs.readdirSync(path.join(root, "replay"))) walk(path.join(root, "replay", f));
    const clients = [...seen].filter((f) => f.includes(`${path.sep}clients${path.sep}`));
    expect(clients).toEqual([]);
    expect(seen.size).toBeGreaterThan(5);
  });
});
