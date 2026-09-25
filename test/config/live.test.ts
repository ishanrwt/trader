import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/index.js";
import { makeTestSecretKey } from "../helpers/keypair.js";

const key = makeTestSecretKey();

function liveEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    SOLANA_RPC_URL: "https://rpc.example.com/?api-key=secret123",
    JUPITER_API_KEY: "jup-key-abc",
    TRADER_TELEGRAM_BOT_TOKEN: "123456:ABC-DEF",
    TRADER_TELEGRAM_CHAT_ID: "-100123456",
    MODE: "live",
    LIVE_ACK: "I_ACCEPT_REAL_LOSSES",
    WALLET_PRIVATE_KEY: key.base58,
    ...overrides,
  };
}

function issuesOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).message;
  }
  throw new Error("expected a ConfigError");
}

describe("loadConfig: live interlocks (SPEC.md section 16.8)", () => {
  it("accepts a complete live config", () => {
    const config = loadConfig(liveEnv());
    expect(config.MODE).toBe("live");
    expect(config.walletKeyProvided).toBe(true);
  });

  it("never keeps the wallet key in the config object, its secrets list, or any dump of it", () => {
    const config = loadConfig(liveEnv());
    expect(Object.keys(config)).not.toContain("WALLET_PRIVATE_KEY");
    expect(config.secrets).not.toContain(key.base58);
    expect(JSON.stringify(config)).not.toContain(key.base58);
  });

  it("refuses to start with PAPER_HALTS_OBSERVE_ONLY=true (section 9.1: live halts always block)", () => {
    expect(issuesOf(() => loadConfig(liveEnv({ PAPER_HALTS_OBSERVE_ONLY: "true" })))).toMatch(
      /PAPER_HALTS_OBSERVE_ONLY=true is paper-only: MODE=live refuses to start with it on/,
    );
    expect(loadConfig(liveEnv({ PAPER_HALTS_OBSERVE_ONLY: "false" })).MODE).toBe("live");
  });

  it("PAPER_HALTS_OBSERVE_ONLY=true is accepted in paper mode, and defaults to false", () => {
    const paper = { MODE: "paper", LIVE_ACK: "", WALLET_PRIVATE_KEY: "" };
    expect(loadConfig(liveEnv({ ...paper, PAPER_HALTS_OBSERVE_ONLY: "true" })).PAPER_HALTS_OBSERVE_ONLY).toBe(true);
    expect(loadConfig(liveEnv(paper)).PAPER_HALTS_OBSERVE_ONLY).toBe(false);
  });

  it("refuses without LIVE_ACK exactly I_ACCEPT_REAL_LOSSES", () => {
    expect(issuesOf(() => loadConfig(liveEnv({ LIVE_ACK: "" })))).toMatch(/LIVE_ACK=I_ACCEPT_REAL_LOSSES/);
    expect(issuesOf(() => loadConfig(liveEnv({ LIVE_ACK: "i_accept_real_losses" })))).toMatch(/LIVE_ACK/);
  });

  it("refuses without a wallet key", () => {
    expect(issuesOf(() => loadConfig(liveEnv({ WALLET_PRIVATE_KEY: "" })))).toMatch(/requires WALLET_PRIVATE_KEY/);
  });

  it("refuses a malformed wallet key without echoing it", () => {
    const bad = key.base58.slice(0, 50);
    const msg = issuesOf(() => loadConfig(liveEnv({ WALLET_PRIVATE_KEY: bad })));
    expect(msg).toMatch(/WALLET_PRIVATE_KEY is not a valid key/);
    expect(msg).not.toContain(bad);
  });

  it("refuses POSITION_USD above HARD_MAX_POSITION_USD in live mode too", () => {
    expect(issuesOf(() => loadConfig(liveEnv({ POSITION_USD: "101" })))).toMatch(/exceeds the hard cap of 100/);
  });

  it("derives SELL_FEE_RESERVE_SOL = MAX_CONCURRENT x 3 x (0.000005 + MAX_PRIORITY_FEE_SOL)", () => {
    expect(loadConfig(liveEnv()).sellFeeReserveSol).toBeCloseTo(0.004545, 9);
    expect(loadConfig(liveEnv({ MAX_CONCURRENT: "2", MAX_PRIORITY_FEE_SOL: "0.001" })).sellFeeReserveSol).toBeCloseTo(2 * 3 * 0.001005, 9);
  });

  it("validates the RPC budget (section 16.10)", () => {
    expect(issuesOf(() => loadConfig(liveEnv({ RPC_MAX_RPS: "3" })))).toMatch(/RPC budget too small/);
    expect(issuesOf(() => loadConfig(liveEnv({ RPC_SEND_MAX_RPS: "0" })))).toMatch(/RPC_SEND_MAX_RPS/);
  });

  it("refuses a Jupiter budget that sell retries alone exceed, even with AUTO_STRETCH_POLL", () => {
    const msg = issuesOf(() => loadConfig(liveEnv({ SELL_RETRY_SECONDS: "2", AUTO_STRETCH_POLL: "true" })));
    expect(msg).toMatch(/live sell retries/);
  });

  it("validates slippage, backoff, priority fee and the per-position fee budget", () => {
    expect(issuesOf(() => loadConfig(liveEnv({ SELL_SLIPPAGE_BPS_START: "3000" })))).toMatch(/SELL_SLIPPAGE_BPS_START/);
    expect(issuesOf(() => loadConfig(liveEnv({ STUCK_BACKOFF_SECONDS: "5,60" })))).toMatch(/STUCK_BACKOFF_SECONDS/);
    expect(issuesOf(() => loadConfig(liveEnv({ MAX_PRIORITY_FEE_SOL: "0" })))).toMatch(/MAX_PRIORITY_FEE_SOL must be > 0/);
    expect(issuesOf(() => loadConfig(liveEnv({ SELL_FEE_BUDGET_SOL: "0.001" })))).toMatch(/SELL_FEE_BUDGET_SOL/);
  });

  it("validates PRIORITY_FEE_PERCENTILE in both modes", () => {
    expect(loadConfig(liveEnv({ PRIORITY_FEE_PERCENTILE: "veryHigh" })).priorityFeePercentile).toBe("veryHigh");
    expect(loadConfig(liveEnv({ PRIORITY_FEE_PERCENTILE: "7500" })).priorityFeePercentile).toBe(7500);
    expect(issuesOf(() => loadConfig(liveEnv({ PRIORITY_FEE_PERCENTILE: "extreme" })))).toMatch(/PRIORITY_FEE_PERCENTILE/);
  });

  it("parses STUCK_BACKOFF_SECONDS as a list with the spec default", () => {
    expect(loadConfig(liveEnv()).STUCK_BACKOFF_SECONDS).toEqual([30, 60, 120, 300, 600]);
    expect(loadConfig(liveEnv({ STUCK_BACKOFF_SECONDS: "20, 40" })).STUCK_BACKOFF_SECONDS).toEqual([20, 40]);
  });

  it("paper mode is unaffected by live-only checks (no ACK or key needed)", () => {
    const config = loadConfig(liveEnv({ MODE: "paper", LIVE_ACK: "", WALLET_PRIVATE_KEY: "", RPC_MAX_RPS: "3" }));
    expect(config.MODE).toBe("paper");
    expect(config.walletKeyProvided).toBe(false);
  });
});
