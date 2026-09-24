import type { Db } from "../storage/db.js";

export interface PendingRow {
  mint: string;
  discoveredAt: number;
  firstEligibleAt: number | null;
  noPairChecks: number;
  status: string;
  lastCheckedAt: number | null;
  lastGateResult: string | null;
}

interface PendingRowDb {
  mint: string;
  discovered_at: number;
  first_eligible_at: number | null;
  no_pair_checks: number;
  status: string;
  last_checked_at: number | null;
  last_gate_result: string | null;
}

function fromDb(row: PendingRowDb): PendingRow {
  return {
    mint: row.mint,
    discoveredAt: row.discovered_at,
    firstEligibleAt: row.first_eligible_at,
    noPairChecks: row.no_pair_checks,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastGateResult: row.last_gate_result,
  };
}

export type PendingPatch = Partial<
  Pick<PendingRow, "firstEligibleAt" | "noPairChecks" | "lastCheckedAt" | "lastGateResult" | "status">
>;

/** DB access for `seen_mints` and `pending` (SPEC.md section 4). */
export class PendingStore {
  constructor(private readonly db: Db) {}

  hasSeen(mint: string): boolean {
    return this.db.prepare("SELECT 1 FROM seen_mints WHERE mint = ?").get(mint) !== undefined;
  }

  /** Inserts if new, then trims the oldest rows beyond `cap` (SEEN_MINTS_CAP). */
  markSeen(mint: string, now: number, cap: number): void {
    this.db.prepare("INSERT OR IGNORE INTO seen_mints (mint, discovered_at) VALUES (?, ?)").run(mint, now);
    const { c: count } = this.db.prepare("SELECT COUNT(*) as c FROM seen_mints").get() as { c: number };
    if (count > cap) {
      const excess = count - cap;
      this.db
        .prepare("DELETE FROM seen_mints WHERE mint IN (SELECT mint FROM seen_mints ORDER BY discovered_at ASC LIMIT ?)")
        .run(excess);
    }
  }

  addPending(mint: string, now: number): void {
    this.db.prepare("INSERT OR IGNORE INTO pending (mint, discovered_at, status) VALUES (?, ?, 'pending')").run(mint, now);
  }

  listPending(): PendingRow[] {
    const rows = this.db.prepare("SELECT * FROM pending ORDER BY discovered_at ASC").all() as PendingRowDb[];
    return rows.map(fromDb);
  }

  countPending(): number {
    const { c } = this.db.prepare("SELECT COUNT(*) as c FROM pending").get() as { c: number };
    return c;
  }

  updatePending(mint: string, patch: PendingPatch): void {
    const current = this.db.prepare("SELECT * FROM pending WHERE mint = ?").get(mint) as PendingRowDb | undefined;
    if (!current) return;
    const next = { ...fromDb(current), ...patch };
    this.db
      .prepare(
        "UPDATE pending SET first_eligible_at = ?, no_pair_checks = ?, last_checked_at = ?, last_gate_result = ?, status = ? WHERE mint = ?",
      )
      .run(next.firstEligibleAt, next.noPairChecks, next.lastCheckedAt, next.lastGateResult, next.status, mint);
  }

  removePending(mint: string): void {
    this.db.prepare("DELETE FROM pending WHERE mint = ?").run(mint);
  }
}
