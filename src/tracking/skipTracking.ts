export interface SkipTrackRow {
  skippedAt: number;
  price15mUsd: number | null;
  price60mUsd: number | null;
}

/** SPEC.md section 11.3: which offset snapshot (if any) is due for this skip-tracked mint. */
export function dueOffsetMinutes(row: SkipTrackRow, now: number): 15 | 60 | null {
  if (row.price15mUsd === null && now - row.skippedAt >= 15 * 60_000) return 15;
  if (row.price60mUsd === null && now - row.skippedAt >= 60 * 60_000) return 60;
  return null;
}

export function isSkipTrackResolved(row: SkipTrackRow): boolean {
  return row.price15mUsd !== null && row.price60mUsd !== null;
}
