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

  /**
   * The mint's owning token program and decimals, learned from the same mint
   * account the check-7 safety result came from. Live closes each token account
   * with the mint's own program (SPEC.md section 16.6). Only updates a row that
   * already exists (set() first).
   */
  setMintInfo(mint: string, info: { tokenProgram: string; decimals: number }): void {
    this.db.prepare("UPDATE safety_cache SET token_program = @token_program, decimals = @decimals WHERE mint = @mint").run({
      mint,
      token_program: info.tokenProgram,
      decimals: info.decimals,
    });
  }

  getMintInfo(mint: string): { tokenProgram: string; decimals: number } | undefined {
    const row = this.db.prepare("SELECT token_program, decimals FROM safety_cache WHERE mint = ?").get(mint) as
      | { token_program: string | null; decimals: number | null }
      | undefined;
    if (!row || row.token_program === null || row.decimals === null) return undefined;
    return { tokenProgram: row.token_program, decimals: row.decimals };
  }
}
