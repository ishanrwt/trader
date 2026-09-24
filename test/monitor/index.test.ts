import { describe, expect, it, vi } from "vitest";
import { pollOpenPositions, pollPosition, triggerFireAndForget, type PollPositionInput } from "../../src/monitor/index.js";
import { initialExitState, type ExitStateMachineConfig } from "../../src/monitor/stateMachine.js";
import { createMemoryLogger } from "../../src/logger/index.js";

const CFG: ExitStateMachineConfig = {
  stopLossPct: 15,
  extraTargetPct: 10,
  maxTargetExtensions: 1,
  holdMinutes: 15,
  fastGainPct: 15,
  fastWindowMinutes: 5,
  fastMinHistorySec: 60,
  fastConfirmPolls: 2,
  maxTimerRestarts: 3,
  maxTotalHoldMinutes: 60,
  trailPct: 4,
  breakevenTriggerPct: 20,
  breakevenFloorPct: 2,
  flatBandPct: 3,
  liqDropExitPct: 30,
  liqDropConfirmReads: 2,
  noRouteExitSec: 30,
};

function state() {
  return initialExitState({ entryTime: 0, entryLiquidity: 10_000, targetProfitPct: 30, holdMinutes: 15, entryPnlPct: 0 });
}

describe("pollPosition", () => {
  it("re-quotes once on NEED_CONFIRM and resolves against the original state, applying a liquidity reading exactly once", async () => {
    const fetchPnlPct = vi.fn().mockResolvedValueOnce(-16).mockResolvedValueOnce(-5); // stop triggers, confirmation disagrees
    const input: PollPositionInput = { id: 1, state: state(), fetchPnlPct, liquidityUsd: 6000 }; // below entryLiquidity*(1-30%)=7000

    const outcome = await pollPosition(input, 1000, CFG);

    expect(fetchPnlPct).toHaveBeenCalledTimes(2);
    expect(outcome.result.action).not.toBe("SELL");
    expect(outcome.result.newState.lowLiqStreak).toBe(1); // not double-applied across the two step() calls
  });

  it("does not re-quote when there's no stop-loss trigger", async () => {
    const fetchPnlPct = vi.fn().mockResolvedValue(5);
    const outcome = await pollPosition({ id: 1, state: state(), fetchPnlPct }, 1000, CFG);
    expect(fetchPnlPct).toHaveBeenCalledTimes(1);
    expect(outcome.result.action).toBe("HOLD");
  });

  it("a null confirmation quote resolves as a confirmed stop", async () => {
    const fetchPnlPct = vi.fn().mockResolvedValueOnce(-16).mockResolvedValueOnce(null);
    const outcome = await pollPosition({ id: 1, state: state(), fetchPnlPct }, 1000, CFG);
    expect(outcome.result).toMatchObject({ action: "SELL", reason: "stop" });
  });
});

describe("pollOpenPositions", () => {
  it("does not block on a SELL's fill: onSell is fire-and-forget and other positions still get polled and held", async () => {
    let sellFillResolved = false;
    const neverResolvingFill = new Promise<void>(() => {}); // simulates a fill still waiting out PAPER_LATENCY_SEC
    void neverResolvingFill.then(() => {
      sellFillResolved = true;
    });

    const onHold = vi.fn().mockResolvedValue(undefined);
    const onSell = vi.fn(() => {
      // Real callers kick off the paper exit fill here without awaiting it inline.
      void neverResolvingFill;
    });

    const positions: PollPositionInput[] = [
      { id: 1, state: state(), fetchPnlPct: async () => 50 }, // hits target -> SELL
      { id: 2, state: state(), fetchPnlPct: async () => 5 }, // HOLD
    ];

    await pollOpenPositions({ positions, now: 1000, cfg: CFG, onHold, onSell, logger: createMemoryLogger() });

    expect(onSell).toHaveBeenCalledWith(1, "target", expect.anything());
    expect(onHold).toHaveBeenCalledWith(2, expect.anything(), expect.anything());
    expect(sellFillResolved).toBe(false); // pollOpenPositions returned without waiting for the fill
  });

  it("logs and continues when one position's poll throws", async () => {
    const logger = createMemoryLogger();
    const onHold = vi.fn().mockResolvedValue(undefined);
    const positions: PollPositionInput[] = [
      { id: 1, state: state(), fetchPnlPct: async () => { throw new Error("boom"); } },
      { id: 2, state: state(), fetchPnlPct: async () => 5 },
    ];

    await pollOpenPositions({ positions, now: 1000, cfg: CFG, onHold, onSell: vi.fn(), logger });

    expect(onHold).toHaveBeenCalledWith(2, expect.anything(), expect.anything());
    expect(logger.entries.some((e) => e.level === "error")).toBe(true);
  });
});

describe("triggerFireAndForget", () => {
  it("adds the id to inFlight synchronously — the caller sees it in flight without awaiting anything", () => {
    const inFlight = new Set<number>();
    triggerFireAndForget({ id: 1, inFlight, attempt: () => new Promise<void>(() => {}), onError: vi.fn() });
    expect(inFlight.has(1)).toBe(true);
  });

  it("does not double-attempt the same id while one is already in flight", () => {
    const inFlight = new Set<number>();
    const attempt = vi.fn().mockReturnValue(new Promise<void>(() => {})); // never resolves
    triggerFireAndForget({ id: 1, inFlight, attempt, onError: vi.fn() });
    triggerFireAndForget({ id: 1, inFlight, attempt, onError: vi.fn() });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("every rejection is caught and routed to onError, never an unhandled rejection, and inFlight is released", async () => {
    const inFlight = new Set<number>();
    const onError = vi.fn();
    const boom = new Error("fill blew up");
    triggerFireAndForget({ id: 7, inFlight, attempt: () => Promise.reject(boom), onError });

    // Give the microtask queue a turn to run the .catch()/.finally() — if either were
    // missing, this test process would crash from an unhandled rejection before this line runs.
    await new Promise((resolve) => setImmediate(resolve));

    expect(onError).toHaveBeenCalledWith(7, boom);
    expect(inFlight.has(7)).toBe(false);
  });

  it("releases inFlight on success too", async () => {
    const inFlight = new Set<number>();
    triggerFireAndForget({ id: 3, inFlight, attempt: async () => {}, onError: vi.fn() });
    await new Promise((resolve) => setImmediate(resolve));
    expect(inFlight.has(3)).toBe(false);
  });
});

describe("integration: position marked closing before its fire-and-forget fill starts", () => {
  it("onSell persists 'closing' synchronously, then triggerFireAndForget kicks off the fill — a still-pending fill that later rejects never crashes, and the position was already closing throughout", async () => {
    const positionsDb = new Map<number, { status: "open" | "closing" }>([[1, { status: "open" }]]);
    const inFlightExitFills = new Set<number>();
    const onError = vi.fn();
    let statusWhenFillAttemptStarted: string | undefined;
    let rejectFill!: (err: Error) => void;
    const fillLatency = new Promise<void>((_, reject) => {
      rejectFill = reject;
    });

    const onSell = vi.fn((id: number) => {
      positionsDb.set(id, { status: "closing" }); // persisted BEFORE the fill is kicked off, synchronously
      triggerFireAndForget({
        id,
        inFlight: inFlightExitFills,
        attempt: async () => {
          statusWhenFillAttemptStarted = positionsDb.get(id)?.status;
          await fillLatency; // simulates PAPER_LATENCY_SEC: genuinely still pending after onSell returns
        },
        onError: (failedId, err) => onError(failedId, err),
      });
    });

    const positions: PollPositionInput[] = [{ id: 1, state: state(), fetchPnlPct: async () => 50 }]; // hits target -> SELL
    await pollOpenPositions({ positions, now: 1000, cfg: CFG, onHold: vi.fn(), onSell, logger: createMemoryLogger() });

    // pollOpenPositions already returned; the position was closing before onSell even returned,
    // and the fill it kicked off is still genuinely in flight (not awaited).
    expect(positionsDb.get(1)!.status).toBe("closing");
    expect(statusWhenFillAttemptStarted).toBe("closing"); // attempt() itself saw "closing", not "open"
    expect(inFlightExitFills.has(1)).toBe(true);

    const boom = new Error("no route");
    rejectFill(boom);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onError).toHaveBeenCalledWith(1, boom); // the rejection was caught, not left unhandled
    expect(inFlightExitFills.has(1)).toBe(false);
  });
});
