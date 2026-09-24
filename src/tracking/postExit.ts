export interface PostExitTrackRow {
  exitTime: number;
  price15mUsd: number | null;
  price30mUsd: number | null;
  price60mUsd: number | null;
}

/** SPEC.md section 11.3: which offset snapshot (if any) is due for this post-exit-tracked trade. */
export function dueOffsetMinutes(row: PostExitTrackRow, now: number): 15 | 30 | 60 | null {
  if (row.price15mUsd === null && now - row.exitTime >= 15 * 60_000) return 15;
  if (row.price30mUsd === null && now - row.exitTime >= 30 * 60_000) return 30;
  if (row.price60mUsd === null && now - row.exitTime >= 60 * 60_000) return 60;
  return null;
}

export function isPostExitTrackResolved(row: PostExitTrackRow): boolean {
  return row.price15mUsd !== null && row.price30mUsd !== null && row.price60mUsd !== null;
}
