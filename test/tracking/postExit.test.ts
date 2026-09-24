import { describe, expect, it } from "vitest";
import { dueOffsetMinutes, isPostExitTrackResolved } from "../../src/tracking/postExit.js";

describe("post-exit tracking due offsets", () => {
  it("moves through 15/30/60 minute offsets in order", () => {
    expect(dueOffsetMinutes({ exitTime: 0, price15mUsd: null, price30mUsd: null, price60mUsd: null }, 15 * 60_000)).toBe(15);
    expect(dueOffsetMinutes({ exitTime: 0, price15mUsd: 1, price30mUsd: null, price60mUsd: null }, 30 * 60_000)).toBe(30);
    expect(dueOffsetMinutes({ exitTime: 0, price15mUsd: 1, price30mUsd: 1, price60mUsd: null }, 60 * 60_000)).toBe(60);
  });

  it("is resolved only once all three offsets are captured", () => {
    expect(isPostExitTrackResolved({ exitTime: 0, price15mUsd: 1, price30mUsd: 1, price60mUsd: null })).toBe(false);
    expect(isPostExitTrackResolved({ exitTime: 0, price15mUsd: 1, price30mUsd: 1, price60mUsd: 1 })).toBe(true);
  });
});
