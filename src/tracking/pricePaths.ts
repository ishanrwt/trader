import { selectPair } from "../clients/dexscreener.js";
import type { PricePathPoint, PricePathRow, PricePathsStore } from "../storage/pricePaths.js";
import type { StateStore } from "../storage/state.js";
import { tradingDayKey } from "../time.js";
import type { DexPair } from "../types.js";

/**
 * SPEC.md section 11.5: price paths for offline replay. Data collection only:
 * nothing here affects entries, exits, selection or shadows, and it only ever
 * gets pair data through the `getPairs` function it's given (DexScreener,
 * through the shared pairs limiter); it has no way to reach Jupiter.
 */

export const PATH_WINDOW_MIN = 60;
export const PATH_BATCH_SIZE = 30;
/** A loop tick that lands slightly early still counts as due. */
const DUE_TOLERANCE_MS = 250;

export interface PricePathConfig {
  mode: string;
  /** PATH_TRACK_MAX: paths recording at once. */
  maxRecording: number;
  /** PATH_FAST_SECONDS, for the first PATH_FAST_WINDOW_MIN minutes after first READY. */
  fastSeconds: number;
  fastWindowMin: number;
  /** SHADOW_POLL_SECONDS, from then until ends_at. */
  slowSeconds: number;
  allowedQuoteMints: readonly string[];
}

/** The READY snapshot discovery stored on the pending row: { pair, holders, score, components }. */
export interface ReadySnapshot {
  holders?: { top1Pct?: number; top10Pct?: number } | null;
  score?: number | null;
  components?: unknown;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** A point from a pair response, or a gap row (all values null). */
export function pointFromPair(pair: DexPair | null, t: number, gapIfMissing: "no_pair" | "fetch_failed" = "no_pair"): PricePathPoint {
  if (!pair) return { t, priceUsd: null, liquidityUsd: null, buysM5: null, sellsM5: null, volumeM5: null, gap: gapIfMissing };
  const p = pair as DexPair & { txns?: { m5?: { buys?: unknown; sells?: unknown } }; volume?: { m5?: unknown } };
  return {
    t,
    priceUsd: num(p.priceUsd),
    liquidityUsd: num(p.liquidity?.usd),
    buysM5: num(p.txns?.m5?.buys),
    sellsM5: num(p.txns?.m5?.sells),
    volumeM5: num(p.volume?.m5),
    gap: null,
  };
}

/**
 * Starts the mint's path at its first READY, with the READY pair as its first
 * point. Independent of shadows and SHADOW_MAX_OPEN; one path per mint and
 * mode (a second READY is "exists"); none when PATH_TRACK_MAX paths are
 * already recording ("cap"; it isn't started later, since it must start at
 * first READY).
 */
export function startPricePath(
  store: PricePathsStore,
  cfg: PricePathConfig,
  input: { mint: string; pair: DexPair; snapshot: ReadySnapshot | null; now: number },
): "started" | "exists" | "cap" {
  if (store.getForMint(input.mint, cfg.mode)) return "exists";
  if (store.countRecording() >= cfg.maxRecording) return "cap";
  const created = num(input.pair.pairCreatedAt);
  const id = store.insertIfAbsent({
    mint: input.mint,
    mode: cfg.mode,
    startedAt: input.now,
    endsAt: input.now + PATH_WINDOW_MIN * 60_000,
    pairSnapshot: input.pair,
    dexId: input.pair.dexId ?? null,
    pairAgeMs: created === null ? null : input.now - created,
    top1Pct: num(input.snapshot?.holders?.top1Pct),
    top10Pct: num(input.snapshot?.holders?.top10Pct),
    score: num(input.snapshot?.score),
    scoreComponents: input.snapshot?.components ?? null,
  });
  if (id === null) return "exists";
  store.addPoint(id, pointFromPair(input.pair, input.now));
  return "started";
}

/** Fast interval inside the first PATH_FAST_WINDOW_MIN minutes, slow after. */
export function pathIntervalMs(path: Pick<PricePathRow, "startedAt">, now: number, cfg: PricePathConfig): number {
  return now - path.startedAt < cfg.fastWindowMin * 60_000 ? cfg.fastSeconds * 1000 : cfg.slowSeconds * 1000;
}

export function isPathDue(path: Pick<PricePathRow, "startedAt" | "endsAt" | "lastPointAt">, now: number, cfg: PricePathConfig): boolean {
  if (now >= path.endsAt) return false;
  return path.lastPointAt === null || now - path.lastPointAt >= pathIntervalMs(path, now, cfg) - DUE_TOLERANCE_MS;
}

/**
 * One recording pass (the loop runs every PATH_FAST_SECONDS): paths past
 * ends_at are marked done without a fetch; due paths are fetched in batches
 * of 30 and get a point each, or a gap row: `no_pair` when the batch had no
 * valid pair for the mint (section 3 selection rule), `fetch_failed` when the
 * batch request failed. Never throws for a missing pair or a failed fetch.
 */
export async function tickPricePaths(
  store: PricePathsStore,
  cfg: PricePathConfig,
  now: number,
  getPairs: (mints: string[]) => Promise<DexPair[]>,
): Promise<{ batches: number; points: number; gaps: number; done: number }> {
  const result = { batches: 0, points: 0, gaps: 0, done: 0 };
  const due: PricePathRow[] = [];
  for (const path of store.listRecording()) {
    if (now >= path.endsAt) {
      store.markDone(path.id);
      result.done++;
    } else if (isPathDue(path, now, cfg)) {
      due.push(path);
    }
  }
  for (let i = 0; i < due.length; i += PATH_BATCH_SIZE) {
    const batch = due.slice(i, i + PATH_BATCH_SIZE);
    result.batches++;
    let pairs: DexPair[] | null = null;
    try {
      pairs = await getPairs(batch.map((p) => p.mint));
    } catch {
      pairs = null;
    }
    for (const path of batch) {
      const point = pairs === null ? pointFromPair(null, now, "fetch_failed") : pointFromPair(selectPair(pairs, path.mint, cfg.allowedQuoteMints), now);
      store.addPoint(path.id, point);
      if (point.gap) result.gaps++;
      else result.points++;
    }
  }
  return result;
}

/** "price paths: n recording, m skipped at cap (today)": the skip count is stored per mode and trading day. */
export function recordCapSkip(state: StateStore, mode: string, now: number, tz: string): void {
  const key = `pricePathsSkipped:${mode}`;
  const day = tradingDayKey(now, tz);
  const cur = state.get<{ day: string; n: number } | null>(key, null);
  state.set(key, { day, n: cur && cur.day === day ? cur.n + 1 : 1 });
}

export function capSkipsToday(state: StateStore, mode: string, now: number, tz: string): number {
  const cur = state.get<{ day: string; n: number } | null>(`pricePathsSkipped:${mode}`, null);
  return cur && cur.day === tradingDayKey(now, tz) ? cur.n : 0;
}
