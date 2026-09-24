import { describe, expect, it } from "vitest";
import { buildOutageRecoveredMessage, buildOutageStartedMessage, buildStartupMessage } from "../../src/notify/urgent.js";

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
