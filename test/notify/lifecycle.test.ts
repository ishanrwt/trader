import { describe, expect, it } from "vitest";
import { detectStartup, heartbeat } from "../../src/notify/lifecycle.js";
import { openDb } from "../../src/storage/db.js";
import { StateStore } from "../../src/storage/state.js";

describe("detectStartup / heartbeat", () => {
  it("reports a fresh start (not a restart) with no prior heartbeat", () => {
    const store = new StateStore(openDb(":memory:"));
    expect(detectStartup(store, 1000)).toEqual({ isRestart: false, downtimeMs: null });
  });

  it("reports a restart with the downtime gap after a prior heartbeat", () => {
    const store = new StateStore(openDb(":memory:"));
    heartbeat(store, 1000);
    expect(detectStartup(store, 1000 + 90_000)).toEqual({ isRestart: true, downtimeMs: 90_000 });
  });

  it("clamps a negative gap (clock skew) to zero", () => {
    const store = new StateStore(openDb(":memory:"));
    heartbeat(store, 5000);
    expect(detectStartup(store, 1000)).toEqual({ isRestart: true, downtimeMs: 0 });
  });
});
