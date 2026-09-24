import { describe, expect, it } from "vitest";
import {
  buildDailyLossHaltMessage,
  buildErrorHaltMessage,
  buildKillSwitchMessage,
  buildOutageRecoveredMessage,
  buildOutageStartedMessage,
  buildStartupMessage,
  buildStuckSellMessage,
} from "../../src/notify/urgent.js";

describe("buildStartupMessage", () => {
  it("announces a fresh start", () => {
    expect(buildStartupMessage({ mode: "PAPER", isRestart: false, downtimeMs: null })).toBe("Trader started (PAPER).");
  });

  it("announces a restart with the downtime gap", () => {
    expect(buildStartupMessage({ mode: "PAPER", isRestart: true, downtimeMs: 90_000 })).toBe(
      "Trader restarted (PAPER). Downtime gap: 1m 30s.",
    );
  });
});

describe("buildOutageStartedMessage / buildOutageRecoveredMessage", () => {
  it("names the service and threshold", () => {
    expect(buildOutageStartedMessage("DexScreener", 10)).toBe("DexScreener has been unreachable for over 10m.");
  });

  it("announces recovery", () => {
    expect(buildOutageRecoveredMessage("DexScreener")).toBe("DexScreener is reachable again.");
  });
});

describe("buildStuckSellMessage", () => {
  it("names the mint/symbol and the reason", () => {
    expect(buildStuckSellMessage({ mint: "Mint1", symbol: "FOO", reason: "no_route" })).toContain("FOO");
    expect(buildStuckSellMessage({ mint: "Mint1", reason: "written_off" })).toContain("Mint1");
    expect(buildStuckSellMessage({ mint: "Mint1", reason: "written_off" })).toContain("-100%");
  });
});

describe("buildDailyLossHaltMessage", () => {
  it("reports the loss and the cap", () => {
    const msg = buildDailyLossHaltMessage({ dailyLossUsd: -35, capUsd: 30 });
    expect(msg).toContain("$35.00");
    expect(msg).toContain("$30.00");
  });
});

describe("buildErrorHaltMessage", () => {
  it("reports the consecutive error count", () => {
    expect(buildErrorHaltMessage({ consecutiveErrors: 5 })).toContain("5");
  });
});

describe("buildKillSwitchMessage", () => {
  it("names the source and how many positions are closing", () => {
    const msg = buildKillSwitchMessage({ source: "file", positionsClosing: 2 });
    expect(msg).toContain("KILL file");
    expect(msg).toContain("2");
  });
});
