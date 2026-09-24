import { describe, expect, it } from "vitest";
import { dueOffsetMinutes, isSkipTrackResolved } from "../../src/tracking/skipTracking.js";

describe("skip tracking due offsets", () => {
  it("nothing is due before 15 minutes", () => {
    expect(dueOffsetMinutes({ skippedAt: 0, price15mUsd: null, price60mUsd: null }, 14 * 60_000)).toBeNull();
  });

  it("15m is due at 15 minutes, then 60m at 60 minutes", () => {
    expect(dueOffsetMinutes({ skippedAt: 0, price15mUsd: null, price60mUsd: null }, 15 * 60_000)).toBe(15);
    expect(dueOffsetMinutes({ skippedAt: 0, price15mUsd: 1, price60mUsd: null }, 60 * 60_000)).toBe(60);
  });

  it("is resolved only once both offsets are captured", () => {
    expect(isSkipTrackResolved({ skippedAt: 0, price15mUsd: 1, price60mUsd: null })).toBe(false);
    expect(isSkipTrackResolved({ skippedAt: 0, price15mUsd: 1, price60mUsd: 2 })).toBe(true);
  });
});
