import type { Db } from "./db.js";

/** Generic key/value store backing the `state` table (pause flag, health counters, etc). */
export class StateStore {
  constructor(private readonly db: Db) {}

  get<T>(key: string, defaultValue: T): T {
    const row = this.db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return defaultValue;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return defaultValue;
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO state (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run({ key, value: JSON.stringify(value) });
  }
}
