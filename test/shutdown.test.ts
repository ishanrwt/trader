import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../src/logger/index.js";
import { ShutdownCoordinator } from "../src/shutdown.js";
import { seedSellPosition, setup } from "./helpers/liveSetup.js";

async function waitUntil(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!cond()) throw new Error("condition never became true");
}

/**
 * SPEC.md section 16.11 (A14): on Ctrl+C (SIGINT) or pm2's `shutdown`
 * message, stop new entries and sell attempts, wait for an in-flight
 * transaction to confirm or fail, persist state, then exit 0.
 */
describe("graceful shutdown with a live transaction in flight", () => {
  for (const [label, fire] of [
    ["SIGINT (Ctrl+C)", (src: EventEmitter) => src.emit("SIGINT")],
    ["the pm2 'shutdown' message (Windows, shutdown_with_message)", (src: EventEmitter) => src.emit("message", "shutdown")],
  ] as const) {
    it(`via ${label}: waits for the in-flight sell to confirm, then persists and exits 0`, async () => {
      const s = await setup({ yieldingSleep: true });
      const id = seedSellPosition(s);
      let landedAfterPolls = 0;
      s.chain.statusFor = () => (++landedAfterPolls >= 3 ? "landed" : "never"); // confirms on the 3rd poll
      const order: string[] = [];
      const source = new EventEmitter();
      const coordinator = new ShutdownCoordinator({
        source,
        logger: createMemoryLogger(),
        boundMs: 120_000,
        stopNew: () => {
          order.push("stopNew");
          s.executor.stopNewTransactions();
        },
        waitForInFlight: (bound) => s.executor.waitIdle(bound),
        finalize: () => {
          order.push(`finalize(sells=${s.sells.length})`);
        },
        exit: (code) => order.push(`exit(${code})`),
      });
      coordinator.install();

      const attempt = s.executor.sellAttempt(s.positions.get(id)!);
      await waitUntil(() => s.chain.sends.length > 0); // the sell is in flight
      expect(s.sells).toHaveLength(0);
      fire(source);
      await waitUntil(() => order.includes("exit(0)"));
      await attempt;

      expect(order).toEqual(["stopNew", "finalize(sells=1)", "exit(0)"]); // finalized only after the transaction resolved
      expect(s.sells).toHaveLength(1);
      // No new transaction was started after the trigger.
      const builds = s.chain.builds.length;
      await s.executor.sellAttempt(s.positions.get(id) ?? (s.sells[0]![0]));
      expect(s.chain.builds.length).toBe(builds);
    });
  }

  it("a second trigger during shutdown only logs; finalize and exit run once", async () => {
    const source = new EventEmitter();
    const logger = createMemoryLogger();
    let release!: () => void;
    const inFlight = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const c = new ShutdownCoordinator({
      source,
      logger,
      boundMs: 120_000,
      stopNew: () => void calls.push("stop"),
      waitForInFlight: async () => {
        await inFlight;
        return true;
      },
      finalize: () => void calls.push("finalize"),
      exit: (code) => void calls.push(`exit(${code})`),
    });
    c.install();
    source.emit("SIGINT");
    source.emit("message", "shutdown");
    source.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual(["stop"]);
    release();
    await waitUntil(() => calls.includes("exit(0)"));
    expect(calls).toEqual(["stop", "finalize", "exit(0)"]);
    expect(logger.entries.filter((e) => /already shutting down/.test(e.msg))).toHaveLength(2);
  });

  it("ignores process messages other than 'shutdown'", async () => {
    const source = new EventEmitter();
    const calls: string[] = [];
    new ShutdownCoordinator({
      source,
      logger: createMemoryLogger(),
      boundMs: 1_000,
      stopNew: () => void calls.push("stop"),
      waitForInFlight: async () => true,
      finalize: () => undefined,
      exit: () => undefined,
    }).install();
    source.emit("message", "hello");
    source.emit("message", { type: "shutdown" });
    expect(calls).toEqual([]);
  });

  it("stops waiting at the bound, still persists and exits (unresolved intents resolve on the next start)", async () => {
    const source = new EventEmitter();
    const logger = createMemoryLogger();
    const calls: string[] = [];
    const c = new ShutdownCoordinator({
      source,
      logger,
      boundMs: 10,
      stopNew: () => undefined,
      waitForInFlight: async () => false,
      finalize: () => void calls.push("finalize"),
      exit: (code) => void calls.push(`exit(${code})`),
    });
    await c.trigger("SIGINT");
    expect(calls).toEqual(["finalize", "exit(0)"]);
    expect(logger.entries.some((e) => /wait bound/.test(e.msg))).toBe(true);
  });
});
