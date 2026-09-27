import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildDigest } from "../../src/notify/digest.js";
import { openDb } from "../../src/storage/db.js";
import { PricePathsStore } from "../../src/storage/pricePaths.js";
import { ShadowsStore } from "../../src/storage/shadows.js";
import { StateStore } from "../../src/storage/state.js";
import { createShadowOnReady } from "../../src/tracking/shadowCreation.js";
import {
  capSkipsToday,
  PATH_BATCH_SIZE,
  pathIntervalMs,
  recordCapSkip,
  startPricePath,
  tickPricePaths,
  type PricePathConfig,
} from "../../src/tracking/pricePaths.js";
import type { DexPair } from "../../src/types.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CFG: PricePathConfig = { mode: "paper", maxRecording: 100, fastSeconds: 5, fastWindowMin: 10, slowSeconds: 15, allowedQuoteMints: [USDC] };
const T0 = 1_790_400_000_000;
const MIN = 60_000;

function pair(mint: string, o: { price?: string; liq?: number; quote?: string; buys?: number; sells?: number; vol?: number } = {}): DexPair {
  return {
    chainId: "solana",
    dexId: "pumpswap",
    pairAddress: `${mint}-${o.quote ?? USDC}`,
    baseToken: { address: mint },
    quoteToken: { address: o.quote ?? USDC },
    priceUsd: o.price ?? "0.001",
    liquidity: { usd: o.liq ?? 20_000 },
    txns: { m5: { buys: o.buys ?? 10, sells: o.sells ?? 4 } },
    volume: { m5: o.vol ?? 1500 },
    pairCreatedAt: T0 - 20 * MIN,
  } as DexPair;
}
const snapshot = { holders: { top1Pct: 2.5, top10Pct: 18 }, score: 0.71, components: { buyPressure: 0.8, activity: 1 } };
const echo = (overrides: Record<string, Partial<Parameters<typeof pair>[1]>> = {}) =>
  vi.fn(async (mints: string[]) => mints.map((m) => pair(m, overrides[m])));

function start(store: PricePathsStore, mint: string, now = T0, cfg = CFG) {
  return startPricePath(store, cfg, { mint, pair: pair(mint), snapshot, now });
}

describe("price paths: starting at first READY (SPEC.md section 11.5)", () => {
  it("stores the entry features and the READY pair as the first point", () => {
    const store = new PricePathsStore(openDb(":memory:"));
    expect(start(store, "A")).toBe("started");
    const p = store.getForMint("A", "paper")!;
    expect(p).toMatchObject({
      startedAt: T0, endsAt: T0 + 60 * MIN, status: "recording", dexId: "pumpswap", pairAgeMs: 20 * MIN,
      top1Pct: 2.5, top10Pct: 18, score: 0.71, scoreComponents: { buyPressure: 0.8, activity: 1 }, selected: false, sellabilityLossPct: null,
    });
    expect((p.pairSnapshot as DexPair).pairAddress).toBe(`A-${USDC}`);
    expect(store.listPoints(p.id)).toEqual([{ t: T0, priceUsd: 0.001, liquidityUsd: 20_000, buysM5: 10, sellsM5: 4, volumeM5: 1500, gap: null }]);
  });

  it("a second READY for the same mint doesn't start a second path", () => {
    const store = new PricePathsStore(openDb(":memory:"));
    start(store, "A");
    expect(start(store, "A", T0 + 5 * MIN)).toBe("exists");
    expect(store.listRecording()).toHaveLength(1);
  });

  it("starts even when the shadow cap is full (independent of SHADOW_MAX_OPEN)", () => {
    const db = openDb(":memory:");
    const shadows = new ShadowsStore(db);
    const shadowCfg = { enabled: true, mode: "paper", maxOpen: 0, positionUsd: 25, maxPositionPctOfLiq: 1, targetProfitPct: 30, holdMinutes: 15, cost: { poolFeePct: 1, extraSlippagePct: 2, feeUsdPerTx: 0.05 } };
    expect(createShadowOnReady(shadows, shadowCfg, "A", pair("A"), T0, () => {})).toBe("cap");
    expect(start(new PricePathsStore(db), "A")).toBe("started");
  });

  it("respects PATH_TRACK_MAX: a mint becoming READY at the cap gets no path; once one finishes, the next does", async () => {
    const store = new PricePathsStore(openDb(":memory:"));
    const two = { ...CFG, maxRecording: 2 };
    expect(start(store, "A", T0, two)).toBe("started");
    expect(start(store, "B", T0, two)).toBe("started");
    expect(start(store, "C", T0 + MIN, two)).toBe("cap");
    expect(store.getForMint("C", "paper")).toBeUndefined();
    await tickPricePaths(store, two, T0 + 60 * MIN, echo()); // A and B reach ends_at
    expect(start(store, "D", T0 + 61 * MIN, two)).toBe("started");
  });

  it("counts cap skips per trading day for the digest line", () => {
    const state = new StateStore(openDb(":memory:"));
    const tz = "Asia/Kolkata";
    recordCapSkip(state, "paper", Date.parse("2026-09-27T10:00:00+05:30"), tz);
    recordCapSkip(state, "paper", Date.parse("2026-09-27T11:00:00+05:30"), tz);
    expect(capSkipsToday(state, "paper", Date.parse("2026-09-27T23:00:00+05:30"), tz)).toBe(2);
    expect(capSkipsToday(state, "paper", Date.parse("2026-09-28T00:30:00+05:30"), tz)).toBe(0);
    expect(capSkipsToday(state, "live", Date.parse("2026-09-27T23:00:00+05:30"), tz)).toBe(0);
  });
});

describe("price paths: recording", () => {
  it("keeps recording after the mint's shadow has exited", async () => {
    const db = openDb(":memory:");
    const shadows = new ShadowsStore(db);
    const store = new PricePathsStore(db);
    const shadowCfg = { enabled: true, mode: "paper", maxOpen: 30, positionUsd: 25, maxPositionPctOfLiq: 1, targetProfitPct: 30, holdMinutes: 15, cost: { poolFeePct: 1, extraSlippagePct: 2, feeUsdPerTx: 0.05 } };
    createShadowOnReady(shadows, shadowCfg, "A", pair("A"), T0, () => {});
    start(store, "A");
    shadows.update(shadows.getForMint("A", "paper")!.id, { outcome: "closed", exitTime: T0 + 2 * MIN, exitReason: "stop", netPnlUsd: -5, netPnlPct: -20 });
    await tickPricePaths(store, CFG, T0 + 30 * MIN, echo({ A: { price: "0.0007" } }));
    const pts = store.listPoints(store.getForMint("A", "paper")!.id);
    expect(pts.at(-1)).toMatchObject({ t: T0 + 30 * MIN, priceUsd: 0.0007, gap: null });
  });

  it("two-speed cadence: every PATH_FAST_SECONDS inside the fast window, every SHADOW_POLL_SECONDS after, never at or past ends_at", async () => {
    const store = new PricePathsStore(openDb(":memory:"));
    start(store, "A");
    const getPairs = echo();
    for (let t = T0 + 5_000; t <= T0 + 70 * MIN; t += 5_000) await tickPricePaths(store, CFG, t, getPairs); // the loop runs every PATH_FAST_SECONDS
    const ts = store.listPoints(store.getForMint("A", "paper")!.id).map((p) => p.t - T0);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]!);
    // Each gap belongs to the phase of the point that ends it (the interval is chosen when that point is due).
    const fastWindow = gaps.filter((_, i) => ts[i + 1]! < 10 * MIN);
    const slow = gaps.filter((_, i) => ts[i + 1]! >= 10 * MIN);
    expect(new Set(fastWindow)).toEqual(new Set([5_000]));
    expect(new Set(slow)).toEqual(new Set([15_000]));
    expect(Math.max(...ts)).toBeLessThan(60 * MIN);
    expect(ts).toHaveLength(1 + 119 + 200); // READY point, fast points 0:05..9:55, then every 15 s from 10:10 to 59:55
    expect(ts.at(-1)).toBe(59 * MIN + 55_000);
    expect(store.getForMint("A", "paper")!.status).toBe("done");
    expect(pathIntervalMs({ startedAt: T0 }, T0 + 10 * MIN - 1, CFG)).toBe(5_000);
    expect(pathIntervalMs({ startedAt: T0 }, T0 + 10 * MIN, CFG)).toBe(15_000);
  });

  it("stops at 60 minutes: marked done, no fetch for it, no point at or after ends_at", async () => {
    const store = new PricePathsStore(openDb(":memory:"));
    start(store, "A");
    const getPairs = echo();
    const r = await tickPricePaths(store, CFG, T0 + 60 * MIN, getPairs);
    expect(r).toMatchObject({ done: 1, batches: 0 });
    expect(getPairs).not.toHaveBeenCalled();
    await tickPricePaths(store, CFG, T0 + 61 * MIN, getPairs);
    expect(getPairs).not.toHaveBeenCalled();
    expect(store.listPoints(store.getForMint("A", "paper")!.id).every((p) => p.t < T0 + 60 * MIN)).toBe(true);
  });

  it("stores m5 buys, sells and volume on each point, and nulls on gap rows", async () => {
    const store = new PricePathsStore(openDb(":memory:"));
    start(store, "A");
    start(store, "B");
    await tickPricePaths(store, CFG, T0 + 5_000, async (mints) => mints.filter((m) => m === "A").map((m) => pair(m, { buys: 33, sells: 7, vol: 4200.5, price: "0.0012", liq: 18_500 })));
    const a = store.listPoints(store.getForMint("A", "paper")!.id).at(-1);
    const b = store.listPoints(store.getForMint("B", "paper")!.id).at(-1);
    expect(a).toEqual({ t: T0 + 5_000, priceUsd: 0.0012, liquidityUsd: 18_500, buysM5: 33, sellsM5: 7, volumeM5: 4200.5, gap: null });
    expect(b).toEqual({ t: T0 + 5_000, priceUsd: null, liquidityUsd: null, buysM5: null, sellsM5: null, volumeM5: null, gap: "no_pair" });
  });

  it("a missing pair records a gap for that mint only; a failed fetch records fetch_failed gaps; nothing throws", async () => {
    const store = new PricePathsStore(openDb(":memory:"));
    start(store, "A");
    start(store, "B");
    const r1 = await tickPricePaths(store, CFG, T0 + 5_000, async () => [pair("A")]);
    expect(r1).toMatchObject({ points: 1, gaps: 1 });
    const r2 = await tickPricePaths(store, CFG, T0 + 10_000, async () => {
      throw new Error("DexScreener 503");
    });
    expect(r2).toMatchObject({ points: 0, gaps: 2 });
    expect(store.listPoints(store.getForMint("A", "paper")!.id).at(-1)!.gap).toBe("fetch_failed");
    expect(store.listRecording()).toHaveLength(2);
  });

  it("uses the section 3 pair selection rule (a pair quoted in another token is ignored) and batches at most 30 mints", async () => {
    const store = new PricePathsStore(openDb(":memory:"));
    for (let i = 0; i < 65; i++) start(store, `M${i}`);
    const getPairs = vi.fn(async (mints: string[]) => mints.flatMap((m) => [pair(m, { price: "9", liq: 999_999, quote: "OTHERQUOTE" }), pair(m, { price: "0.002" })]));
    const r = await tickPricePaths(store, CFG, T0 + 5_000, getPairs);
    expect(r.batches).toBe(3);
    expect(getPairs.mock.calls.map((c) => c[0].length)).toEqual([PATH_BATCH_SIZE, PATH_BATCH_SIZE, 5]);
    expect(store.listPoints(store.getForMint("M0", "paper")!.id).at(-1)!.priceUsd).toBe(0.002);
  });

  it("selection and sellability are recorded on the path, even after recording has ended", async () => {
    const store = new PricePathsStore(openDb(":memory:"));
    start(store, "A");
    await tickPricePaths(store, CFG, T0 + 60 * MIN, echo());
    store.setSellability("A", "paper", 3.4, T0 + 61 * MIN);
    store.markSelected("A", "paper");
    expect(store.getForMint("A", "paper")).toMatchObject({ status: "done", selected: true, sellabilityLossPct: 3.4, sellabilityCheckedAt: T0 + 61 * MIN });
  });

  it("after a restart, a path whose ends_at is still ahead keeps recording", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-paths-"));
    const dbPath = path.join(dir, "trader.db");
    try {
      const db1 = openDb(dbPath);
      start(new PricePathsStore(db1), "A");
      db1.close();
      const db2 = openDb(dbPath); // the restarted process
      const store = new PricePathsStore(db2);
      await tickPricePaths(store, CFG, T0 + 20 * MIN, echo());
      expect(store.listPoints(store.getForMint("A", "paper")!.id).map((p) => p.t)).toEqual([T0, T0 + 20 * MIN]); // downtime = missing timestamps
      db2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("digest: price paths line", () => {
  it("shows recording and today's cap skips", () => {
    const text = buildDigest({
      mode: "PAPER", now: 0, startedAt: 0, paused: false, killed: false, dailyLossHalted: false, errorHalted: false, lossStreak: 0, solPriceUsd: null,
      walletUsdc: 0, walletSol: 0, tradesClosed: [], openPositions: [],
      tradingDay: { trades: 0, winRate: 0, medianNetPnlPct: 0, meanNetPnlPct: 0, totalNetPnlUsd: 0, biggestWinUsd: null, biggestLossUsd: null, exitReasonBreakdown: {} },
      funnel: { discovered: 0, eligible: 0, ready: 0, entered: 0, pendingNow: 0, skipReasons: {}, skippedSlotsFullCount: 0, scoreRangeOfEntries: null },
      risk: { dailyLossUsd: 0, dailyLossCapUsd: 60 },
      health: { dexScreenerErrors: 0, rpcErrors: 0, jupiterRequestsPerMinAvg: 0, jupiterRequestsPerMinPeak: 0, jupiter429s: 0, deferredEntryChecks: 0, downtimeGaps: [] },
      pricePaths: { recording: 14, skippedToday: 2 },
    });
    expect(text).toContain("  price paths: 14 recording, 2 skipped at cap (today)");
  });
});
