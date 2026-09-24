import type { GateCheckId } from "../gate/index.js";
import { formatDurationMs } from "../time.js";

export interface Phase1DigestInput {
  mode: "PAPER" | "LIVE";
  now: number;
  startedAt: number;
  paused: boolean;
  pauseReason?: string;
  solPriceUsd: number | null;
  funnel: {
    /** Since the previous digest. */
    discovered: number;
    pendingNow: number;
    skipReasons: Partial<Record<GateCheckId, number>>;
  };
  health: {
    dexScreenerErrors: number;
    rpcErrors: number;
    jupiterRequestsPerMinAvg: number;
    jupiterRequestsPerMinPeak: number;
    jupiter429s: number;
    deferredEntryChecks: number;
    downtimeGaps: Array<{ from: number; to: number }>;
  };
}

function topSkipReasons(skipReasons: Partial<Record<GateCheckId, number>>, limit = 3): string {
  const entries = Object.entries(skipReasons).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  if (entries.length === 0) return "none";
  return entries
    .slice(0, limit)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");
}

/**
 * SPEC.md section 10's digest, narrowed to what Phase 1 actually has: no
 * READY/entered/score data exists yet (checks 5-8 and selection are Phase 2),
 * so those fields say so explicitly rather than showing zero.
 */
export function buildDigest(input: Phase1DigestInput): string {
  const lines: string[] = [];

  lines.push(`=== Trader digest (${input.mode}) ===`);
  lines.push(`Uptime: ${formatDurationMs(input.now - input.startedAt)}`);
  if (input.solPriceUsd !== null) lines.push(`SOL/USD: $${input.solPriceUsd.toFixed(2)}`);
  lines.push("");

  lines.push("Funnel:");
  lines.push(`  discovered: ${input.funnel.discovered}`);
  lines.push(`  pending now: ${input.funnel.pendingNow}`);
  lines.push(`  top skip reasons: ${topSkipReasons(input.funnel.skipReasons)}`);
  lines.push("  READY / entered / score range: not yet implemented (Phase 2)");
  lines.push("");

  lines.push("Risk:");
  lines.push(`  paused: ${input.paused}${input.pauseReason ? ` (${input.pauseReason})` : ""}`);
  lines.push("");

  lines.push("Health:");
  lines.push(`  DexScreener errors: ${input.health.dexScreenerErrors}`);
  lines.push(`  RPC errors: ${input.health.rpcErrors}`);
  lines.push(
    `  Jupiter req/min: avg ${input.health.jupiterRequestsPerMinAvg.toFixed(1)}, ` +
      `peak ${input.health.jupiterRequestsPerMinPeak}, 429s: ${input.health.jupiter429s}`,
  );
  lines.push(`  Deferred entry checks: ${input.health.deferredEntryChecks}`);
  if (input.health.downtimeGaps.length > 0) {
    const gaps = input.health.downtimeGaps.map((g) => formatDurationMs(g.to - g.from)).join(", ");
    lines.push(`  Downtime gaps this period: ${gaps}`);
  }

  return lines.join("\n");
}
