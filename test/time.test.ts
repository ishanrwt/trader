import { describe, expect, it } from "vitest";
import { formatDurationMs, isSameTradingDay, tradingDayKey } from "../src/time.js";

describe("tradingDayKey", () => {
  it("formats as YYYY-MM-DD in the given timezone", () => {
    // 2026-01-01T00:30:00Z is still 2025-12-31 in Asia/Kolkata? No: IST is UTC+5:30,
    // so 00:30 UTC on Jan 1 is 06:00 IST on Jan 1.
    const ms = Date.parse("2026-01-01T00:30:00Z");
    expect(tradingDayKey(ms, "Asia/Kolkata")).toBe("2026-01-01");
    expect(tradingDayKey(ms, "UTC")).toBe("2026-01-01");
  });

  it("crosses the calendar day boundary differently per timezone", () => {
    // 2026-01-01T19:00:00Z is 2026-01-02T00:30 IST (UTC+5:30) but still Jan 1 in UTC.
    const ms = Date.parse("2026-01-01T19:00:00Z");
    expect(tradingDayKey(ms, "UTC")).toBe("2026-01-01");
    expect(tradingDayKey(ms, "Asia/Kolkata")).toBe("2026-01-02");
  });
});

describe("isSameTradingDay", () => {
  it("is true for timestamps on the same calendar day in the timezone", () => {
    const a = Date.parse("2026-03-05T01:00:00Z");
    const b = Date.parse("2026-03-05T23:00:00Z");
    expect(isSameTradingDay(a, b, "UTC")).toBe(true);
  });

  it("is false across a day boundary in the timezone", () => {
    // 18:00 UTC is 23:30 IST (still Jan 1); 19:00 UTC is 00:30 IST (Jan 2).
    const a = Date.parse("2026-01-01T18:00:00Z");
    const b = Date.parse("2026-01-01T19:00:00Z");
    expect(isSameTradingDay(a, b, "Asia/Kolkata")).toBe(false);
  });
});

describe("formatDurationMs", () => {
  it("formats seconds only for short durations", () => {
    expect(formatDurationMs(45_000)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDurationMs(125_000)).toBe("2m 5s");
  });

  it("formats hours, minutes and seconds", () => {
    expect(formatDurationMs(3 * 3600_000 + 61_000)).toBe("3h 1m 1s");
  });

  it("formats days", () => {
    expect(formatDurationMs(2 * 86_400_000 + 3600_000)).toBe("2d 1h 0m 0s");
  });

  it("clamps negative durations to zero", () => {
    expect(formatDurationMs(-500)).toBe("0s");
  });
});
