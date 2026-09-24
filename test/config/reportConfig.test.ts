import { describe, expect, it } from "vitest";
import { loadReportConfig, ReportConfigError } from "../../src/config/reportConfig.js";

describe("loadReportConfig", () => {
  it("succeeds with a completely empty environment — no secrets required", () => {
    const config = loadReportConfig({});
    expect(config.TRADING_DAY_TZ).toBe("Asia/Kolkata");
    expect(config.GOLIVE_MIN_TRADES).toBe(100);
    expect(config.STUCK_WRITE_OFF_MIN).toBe(30);
  });

  it("still ignores secret keys even when present alongside real report settings", () => {
    const config = loadReportConfig({
      SOLANA_RPC_URL: undefined,
      GOLIVE_MIN_TRADES: "50",
      GOLIVE_MIN_P10_PNL_PCT: "-10",
    });
    expect(config.GOLIVE_MIN_TRADES).toBe(50);
    expect(config.GOLIVE_MIN_P10_PNL_PCT).toBe(-10);
  });

  it("throws a ReportConfigError (not a raw zod error) on an invalid value", () => {
    expect(() => loadReportConfig({ GOLIVE_MIN_TRADES: "not-a-number" })).toThrow(ReportConfigError);
  });
});
