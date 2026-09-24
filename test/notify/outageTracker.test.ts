import { describe, expect, it } from "vitest";
import { OutageTracker } from "../../src/notify/outageTracker.js";

describe("OutageTracker", () => {
  it("does not alert for failures shorter than OUTAGE_ALERT_MINUTES", () => {
    const tracker = new OutageTracker(10);
    expect(tracker.recordResult("dexscreener", false, 0)).toBeNull();
    expect(tracker.recordResult("dexscreener", false, 5 * 60_000)).toBeNull();
  });

  it("alerts exactly once when the outage crosses OUTAGE_ALERT_MINUTES", () => {
    const tracker = new OutageTracker(10);
    tracker.recordResult("dexscreener", false, 0);
    expect(tracker.recordResult("dexscreener", false, 10 * 60_000)).toEqual({
      type: "started",
      service: "dexscreener",
    });
    // still down, already alerted -> no repeat alert
    expect(tracker.recordResult("dexscreener", false, 15 * 60_000)).toBeNull();
  });

  it("alerts recovery once after an alerted outage clears", () => {
    const tracker = new OutageTracker(10);
    tracker.recordResult("dexscreener", false, 0);
    tracker.recordResult("dexscreener", false, 10 * 60_000);
    expect(tracker.recordResult("dexscreener", true, 12 * 60_000)).toEqual({
      type: "recovered",
      service: "dexscreener",
    });
  });

  it("does not alert recovery for a short outage that never crossed the threshold", () => {
    const tracker = new OutageTracker(10);
    tracker.recordResult("dexscreener", false, 0);
    expect(tracker.recordResult("dexscreener", true, 60_000)).toBeNull();
  });

  it("tracks multiple services independently", () => {
    const tracker = new OutageTracker(10);
    tracker.recordResult("dexscreener", false, 0);
    tracker.recordResult("rpc", false, 0);
    expect(tracker.recordResult("dexscreener", false, 10 * 60_000)?.service).toBe("dexscreener");
    expect(tracker.recordResult("rpc", true, 10 * 60_000)).toBeNull(); // rpc recovered before alerting
  });
});
