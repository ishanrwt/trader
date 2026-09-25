import { describe, expect, it } from "vitest";
import { afterFailedAttempt, grantSellBudget, markBudgetExhausted, retryDelayMs, sellAttemptDue, sellSlippageBps, withinFeeBudget, type SellAttemptState, type SellPolicyConfig } from "../../src/live/sellPolicy.js";
import { matchStuckPosition } from "../../src/notify/sellRetry.js";

const cfg: SellPolicyConfig = {
  sellSlippageBpsStart: 300,
  sellSlippageBpsMax: 2000,
  sellRetrySeconds: 10,
  stuckBackoffSeconds: [30, 60, 120, 300, 600],
  maxPriorityFeeLamports: 500_000,
  sellFeeBudgetLamports: 5_000_000,
};

const fresh: SellAttemptState = { sellAttempts: 0, sellFailures: 0, sellFeesLamports: 0, failedSellFeesLamports: 0, sellBudgetLamports: null, stuckState: null, stuckSince: null, nextSellAt: null };

describe("sell slippage escalation (SPEC.md section 16.6)", () => {
  it("rises from SELL_SLIPPAGE_BPS_START by doubling per failed attempt, capped at SELL_SLIPPAGE_BPS_MAX", () => {
    expect([0, 1, 2, 3, 4, 10].map((n) => sellSlippageBps(n, cfg))).toEqual([300, 600, 1200, 2000, 2000, 2000]);
  });
});

describe("stuck handling and the backoff schedule (A10)", () => {
  it("retries every SELL_RETRY_SECONDS until 3 failures, then marks the position stuck exactly once", () => {
    let s = fresh;
    const alerts: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const r = afterFailedAttempt(s, i * 1000, 0, cfg);
      if (r.becameStuck) alerts.push(i);
      s = r.state;
    }
    expect(alerts).toEqual([3]);
    expect(s.stuckState).toBe("stuck");
    expect(s.stuckSince).toBe(3000);
    expect(s.sellFailures).toBe(5);
  });

  it("once stuck, backs off 30, 60, 120, 300, 600 s and then every 600 s", () => {
    expect([1, 2].map((f) => retryDelayMs(f, cfg))).toEqual([10_000, 10_000]);
    expect([3, 4, 5, 6, 7, 8, 20].map((f) => retryDelayMs(f, cfg))).toEqual([30_000, 60_000, 120_000, 300_000, 600_000, 600_000, 600_000]);
    const r = afterFailedAttempt({ ...fresh, sellFailures: 2 }, 1_000, 0, cfg);
    expect(r.state.nextSellAt).toBe(1_000 + 30_000);
    expect(sellAttemptDue(r.state, 30_999)).toBe(false);
    expect(sellAttemptDue(r.state, 31_000)).toBe(true);
  });

  it("accumulates the fees of failed on-chain attempts", () => {
    const r = afterFailedAttempt(fresh, 1, 505_000, cfg);
    expect(r.state.sellFeesLamports).toBe(505_000);
    expect(r.state.failedSellFeesLamports).toBe(505_000);
  });
});

describe("the per-position fee budget (A10)", () => {
  it("allows a send only if fees paid + the worst-case attempt stay within SELL_FEE_BUDGET_SOL", () => {
    expect(withinFeeBudget({ sellFeesLamports: 4_495_000, sellBudgetLamports: null }, cfg)).toBe(true); // 4,495,000 + 505,000 = 5,000,000
    expect(withinFeeBudget({ sellFeesLamports: 4_495_001, sellBudgetLamports: null }, cfg)).toBe(false);
  });

  it("marks budget_exhausted and schedules only the last backoff interval (balance reads only)", () => {
    const s = markBudgetExhausted({ ...fresh, stuckState: "stuck", stuckSince: 5 }, 1_000, cfg);
    expect(s).toMatchObject({ stuckState: "budget_exhausted", stuckSince: 5, nextSellAt: 1_000 + 600_000 });
  });

  it("/sellretry grants one more budget and resumes attempts now", () => {
    const s = grantSellBudget({ ...fresh, stuckState: "budget_exhausted", sellFeesLamports: 5_000_000 }, 9_000, cfg);
    expect(s).toMatchObject({ sellBudgetLamports: 10_000_000, stuckState: "stuck", nextSellAt: 9_000 });
    expect(withinFeeBudget(s, cfg)).toBe(true);
  });
});

describe("/sellretry prefix matching (decision 3)", () => {
  const rows = [
    { mint: "AbcXYZ111", stuckState: "budget_exhausted" as const, mode: "live" },
    { mint: "AbdXYZ222", stuckState: "stuck" as const, mode: "live" },
    { mint: "AbeXYZ333", stuckState: null, mode: "live" },
    { mint: "AbfXYZ444", stuckState: "stuck" as const, mode: "paper" },
  ];
  it("requires exactly one stuck live position", () => {
    expect(matchStuckPosition(rows, "Abc")).toMatchObject({ ok: true, position: { mint: "AbcXYZ111" } });
    expect(matchStuckPosition(rows, "Ab")).toMatchObject({ ok: false, reason: expect.stringContaining("matches 2") });
    expect(matchStuckPosition(rows, "Abe")).toMatchObject({ ok: false }); // not stuck
    expect(matchStuckPosition(rows, "Abf")).toMatchObject({ ok: false }); // not live
    expect(matchStuckPosition(rows, " ")).toMatchObject({ ok: false, reason: expect.stringContaining("Usage") });
  });
});
