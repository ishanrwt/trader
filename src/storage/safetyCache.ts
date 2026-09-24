import type { Db } from "./db.js";
import type { MintSafetyResult } from "../gate/index.js";

/** DB access for `safety_cache` (SPEC.md section 5, check 7: permanent, cached forever per mint). */
export class SafetyCacheStore {
  constructor(private readonly db: Db) {}

  get(mint: string): MintSafetyResult | undefined {
    const row = this.db.prepare("SELECT passed, reason FROM safety_cache WHERE mint = ?").get(mint) as
      | { passed: number; reason: string | null }
      | undefined;
    if (!row) return undefined;
    return { passed: row.passed === 1, reason: row.reason ?? "" };
  }

  set(mint: string, result: MintSafetyResult, now: number): void {
    this.db
      .prepare(
        "INSERT INTO safety_cache (mint, passed, reason, checked_at) VALUES (@mint, @passed, @reason, @checked_at) ON CONFLICT(mint) DO UPDATE SET passed = excluded.passed, reason = excluded.reason, checked_at = excluded.checked_at",
      )
      .run({ mint, passed: result.passed ? 1 : 0, reason: result.reason, checked_at: now });
  }
}
