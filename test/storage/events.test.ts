import { describe, expect, it } from "vitest";
import { logEvent, recentEvents } from "../../src/storage/events.js";
import { openDb } from "../../src/storage/db.js";

describe("events (the audit trail: outage alerts, restarts, pause/resume, digest sends)", () => {
  it("logs an event and reads it back, with meta round-tripped through JSON", () => {
    const db = openDb(":memory:");
    logEvent(db, 1000, "restart", "Restarted after 5000ms downtime", { downtimeMs: 5000 });

    const events = recentEvents(db, 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ts: 1000, type: "restart", message: "Restarted after 5000ms downtime", meta: { downtimeMs: 5000 } });
  });

  it("logs events with no meta", () => {
    const db = openDb(":memory:");
    logEvent(db, 1000, "digest_sent", "Digest sent");
    expect(recentEvents(db, 0)[0]).toMatchObject({ type: "digest_sent", meta: null });
  });

  it("recentEvents filters by sinceTs and orders newest first", () => {
    const db = openDb(":memory:");
    logEvent(db, 1000, "pause", "Entries paused via /pause");
    logEvent(db, 2000, "resume", "Entries resumed via /resume");
    logEvent(db, 3000, "outage", "DexScreener started");

    const events = recentEvents(db, 2000);
    expect(events.map((e) => e.type)).toEqual(["outage", "resume"]);
  });
});
