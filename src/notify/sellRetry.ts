import type { StuckState } from "../storage/positions.js";

/**
 * /sellretry target selection (SPEC.md section 16.6): the prefix must match
 * exactly one stuck live position (`stuck` or `budget_exhausted`); zero or
 * several matches change nothing and the reply says why.
 */
export function matchStuckPosition<T extends { mint: string; stuckState: StuckState | null; mode: string }>(
  positions: readonly T[],
  prefix: string,
): { ok: true; position: T } | { ok: false; reason: string } {
  const p = prefix.trim();
  if (p.length === 0) return { ok: false, reason: "Usage: /sellretry <mint prefix>" };
  const matches = positions.filter((x) => x.mode === "live" && x.stuckState !== null && x.mint.startsWith(p));
  if (matches.length === 0) return { ok: false, reason: `No stuck live position's mint starts with "${p}".` };
  if (matches.length > 1) return { ok: false, reason: `"${p}" matches ${matches.length} stuck positions; use a longer prefix.` };
  return { ok: true, position: matches[0]! };
}
