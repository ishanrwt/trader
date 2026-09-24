import { describe, expect, it } from "vitest";
import { PendingStore } from "../../src/discovery/pendingStore.js";
import { openDb } from "../../src/storage/db.js";

describe("PendingStore", () => {
  it("tracks seen mints and reports hasSeen correctly", () => {
    const store = new PendingStore(openDb(":memory:"));
    expect(store.hasSeen("A")).toBe(false);
    store.markSeen("A", 1000, 100);
    expect(store.hasSeen("A")).toBe(true);
  });

  it("trims the oldest seen mints beyond the cap", () => {
    const db = openDb(":memory:");
    const store = new PendingStore(db);
    store.markSeen("A", 1000, 2);
    store.markSeen("B", 2000, 2);
    store.markSeen("C", 3000, 2);
    expect(store.hasSeen("A")).toBe(false); // oldest, trimmed
    expect(store.hasSeen("B")).toBe(true);
    expect(store.hasSeen("C")).toBe(true);
  });

  it("adds a pending row and lists it with defaults", () => {
    const store = new PendingStore(openDb(":memory:"));
    store.addPending("MINT1", 1000);
    const rows = store.listPending();
    expect(rows).toEqual([
      {
        mint: "MINT1",
        discoveredAt: 1000,
        firstEligibleAt: null,
        noPairChecks: 0,
        status: "pending",
        lastCheckedAt: null,
        lastGateResult: null,
      },
    ]);
  });

  it("does not duplicate a pending row that already exists", () => {
    const store = new PendingStore(openDb(":memory:"));
    store.addPending("MINT1", 1000);
    store.addPending("MINT1", 2000);
    expect(store.countPending()).toBe(1);
    expect(store.listPending()[0]!.discoveredAt).toBe(1000);
  });

  it("updates only the patched fields on a pending row", () => {
    const store = new PendingStore(openDb(":memory:"));
    store.addPending("MINT1", 1000);
    store.updatePending("MINT1", { firstEligibleAt: 1500, lastGateResult: "passed" });
    const row = store.listPending()[0]!;
    expect(row.firstEligibleAt).toBe(1500);
    expect(row.lastGateResult).toBe("passed");
    expect(row.noPairChecks).toBe(0);
  });

  it("removes a pending row", () => {
    const store = new PendingStore(openDb(":memory:"));
    store.addPending("MINT1", 1000);
    store.removePending("MINT1");
    expect(store.countPending()).toBe(0);
  });
});
