import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations, tableNames } from "../../src/storage/db.js";

describe("openDb / runMigrations", () => {
  it("creates the Phase 1 tables from an empty database", () => {
    const db = openDb(":memory:");
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        "seen_mints",
        "pending",
        "state",
        "events",
        "positions",
        "position_history",
        "trades",
        "shadows",
        "skip_tracks",
        "post_exit_tracks",
        "safety_cache",
        "trade_history",
      ]),
    );
    db.close();
  });

  it("sets PRAGMA user_version to the latest migration number", () => {
    const db = openDb(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(10);
    db.close();
  });

  it("is idempotent: running migrations again does nothing and doesn't throw", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(10);
    db.close();
  });

  it("allows basic reads/writes against the migrated schema", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO seen_mints (mint, discovered_at) VALUES (?, ?)").run("MINT1", 1000);
    const row = db.prepare("SELECT * FROM seen_mints WHERE mint = ?").get("MINT1");
    expect(row).toEqual({ mint: "MINT1", discovered_at: 1000 });
    db.close();
  });
});
