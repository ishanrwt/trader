import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/index.js";

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    SOLANA_RPC_URL: "https://rpc.example.com/?api-key=secret123",
    JUPITER_API_KEY: "jup-key-abc",
    TRADER_TELEGRAM_BOT_TOKEN: "123456:ABC-DEF",
    TRADER_TELEGRAM_CHAT_ID: "-100123456",
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("loads spec defaults when only required secrets are set", () => {
    const config = loadConfig(baseEnv());
    expect(config.MODE).toBe("paper");
    expect(config.TRADING_DAY_TZ).toBe("Asia/Kolkata");
    expect(config.POSITION_USD).toBe(25);
    expect(config.ALLOWED_QUOTE_MINTS).toEqual([
      "So11111111111111111111111111111111111111112",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    ]);
    expect(config.hardMaxPositionUsd).toBe(100);
    expect(config.jupiter).toEqual({ exitReserve: 23, effectivePollSeconds: 10, stretched: false });
  });

  it("collects the RPC URL, Jupiter key and Telegram token as secrets to redact", () => {
    const config = loadConfig(baseEnv());
    expect(config.secrets).toContain("https://rpc.example.com/?api-key=secret123");
    expect(config.secrets).toContain("jup-key-abc");
    expect(config.secrets).toContain("123456:ABC-DEF");
  });

  it("refuses to start when a required secret is missing", () => {
    expect(() => loadConfig(baseEnv({ SOLANA_RPC_URL: undefined }))).toThrow(ConfigError);
  });

  it("refuses to start on an unparseable number", () => {
    expect(() => loadConfig(baseEnv({ POSITION_USD: "not-a-number" }))).toThrow(ConfigError);
  });

  it("refuses to start when weights don't sum to 1.0", () => {
    expect(() => loadConfig(baseEnv({ W_FRESHNESS: "0.5" }))).toThrow(/sum to/);
  });

  it("refuses to start on an over-budget Jupiter config", () => {
    expect(() => loadConfig(baseEnv({ MAX_CONCURRENT: "20", POLL_SECONDS: "5" }))).toThrow(/Jupiter budget exceeded/);
  });

  it("refuses POSITION_USD above the hard cap", () => {
    expect(() => loadConfig(baseEnv({ POSITION_USD: "150" }))).toThrow(/exceeds the hard cap/);
  });

  it("refuses MODE=live (Phase 3 not built)", () => {
    expect(() => loadConfig(baseEnv({ MODE: "live" }))).toThrow(/Phase 3/);
  });

  it("refuses a non-empty WALLET_PRIVATE_KEY in paper mode", () => {
    expect(() => loadConfig(baseEnv({ WALLET_PRIVATE_KEY: "some-key" }))).toThrow(/paper mode/);
  });

  it("stretches POLL_SECONDS when AUTO_STRETCH_POLL is true", () => {
    const config = loadConfig(
      baseEnv({ MAX_CONCURRENT: "10", POLL_SECONDS: "5", AUTO_STRETCH_POLL: "true" }),
    );
    expect(config.jupiter.stretched).toBe(true);
    expect(config.POLL_SECONDS).toBe(5); // raw value unchanged; effective value is derived
    expect(config.jupiter.effectivePollSeconds).toBeGreaterThan(5);
  });
});
