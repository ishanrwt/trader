import { describe, expect, it } from "vitest";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT } from "../../src/live/programs.js";
import { buyRefKey, sellRefKey } from "../../src/storage/intents.js";
import { RENT } from "../helpers/fakeChain.js";
import { SOL_PRICE, seedSellPosition, setup } from "../helpers/liveSetup.js";

const buyPayload = (mint: string) => ({ mint, sizeUsd: 25, score: 0.7, liquidityUsd: 50_000, snapshot: null });

describe("LiveExecutor: mocked end-to-end buy (SPEC.md sections 16.2-16.5, A2)", () => {
  it("builds, verifies, signs, sends once, confirms, and records cost basis from the confirmed balances, not the quote", async () => {
    const s = await setup();
    const quote = await s.executor.prepareBuy(s.chain.mint, 25);
    expect(quote).toEqual({ tokensOut: 1 }); // the quote said 1,000,000 raw
    const id = await s.executor.executeBuy(buyPayload(s.chain.mint));
    expect(id).not.toBeNull();
    expect(s.chain.sends).toHaveLength(1);
    const [, fill, info] = s.buys[0]!;
    expect(fill.tokensRaw).toBe(990_000n); // actually received, not the quoted 1,000,000
    expect(fill.usdcSpentRaw).toBe(25_000_000n);
    expect(fill.rentPaidLamports).toBe(RENT);
    expect(fill.costBasisUsd).toBeCloseTo(25 + (Number(fill.feeLamports + RENT) / 1e9) * SOL_PRICE, 9);
    expect(fill.tokenAccount?.address).toBe(s.chain.tokenAta);
    expect(info.quoteOutAmount).toBe("1000000");
    const intent = s.intents.listByStatusSince(0).find((i) => i.kind === "buy")!;
    expect(intent.status).toBe("applied");
    expect(s.intents.hasUnresolved(buyRefKey(s.chain.mint), "buy")).toBe(false);
  });

  it("verifies through the fallback when the RPC omits balance fields (one pre-read before the simulation)", async () => {
    const s = await setup();
    s.chain.omitBalanceFields = true;
    await s.executor.prepareBuy(s.chain.mint, 25);
    expect(await s.executor.executeBuy(buyPayload(s.chain.mint))).not.toBeNull();
    expect(s.chain.sends).toHaveLength(1);
  });

  it("a verification refusal never sends, alerts, and counts as a failed entry (throws)", async () => {
    const s = await setup();
    s.chain.leakLamports = 1_000_000n; // SOL leaves the wallet beyond fees and rent
    await s.executor.prepareBuy(s.chain.mint, 25);
    await expect(s.executor.executeBuy(buyPayload(s.chain.mint))).rejects.toThrow(/verification refused/);
    expect(s.chain.sends).toEqual([]);
    expect(s.alerts.join()).toMatch(/Verification refused a live buy .*check g/);
    expect(s.executor.health.refused).toBe(1);
  });

  it("a buy that expires unlanded is not rebuilt; the entry ends and nothing is recorded", async () => {
    const s = await setup();
    s.chain.statusFor = () => "never";
    await s.executor.prepareBuy(s.chain.mint, 25);
    expect(await s.executor.executeBuy(buyPayload(s.chain.mint))).toBeNull();
    expect(s.chain.builds).toHaveLength(1);
    expect(s.buys).toEqual([]);
    expect(s.intents.listByStatusSince(0)[0]!.status).toBe("expired");
  });

  it("skips entries that would spend the sell fee reserve (SOL below max(MIN_SOL_BALANCE, reserve) after the worst case)", async () => {
    const s = await setup();
    s.chain.lamports = 50_000_000n; // 0.05 SOL: after the worst-case buy cost it's below MIN_SOL_BALANCE (0.05)
    await s.executor.prepareBuy(s.chain.mint, 25);
    expect(await s.executor.executeBuy(buyPayload(s.chain.mint))).toBeNull();
    expect(s.chain.sends).toEqual([]);
  });
});

describe("LiveExecutor: mocked end-to-end sell (SPEC.md section 16.6, A3, A11)", () => {
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    it(`sells the on-chain balance, closes the ${program === TOKEN_PROGRAM ? "Token" : "Token-2022"} account in the same transaction, and records real proceeds`, async () => {
      const s = await setup({ tokenProgram: program });
      const id = seedSellPosition(s);
      await s.executor.sellAttempt(s.positions.get(id)!);
      expect(s.chain.sends).toHaveLength(1);
      const [row, fill] = s.sells[0]!;
      expect(row.id).toBe(id);
      expect(fill.usdcReceivedRaw).toBe(30_000_000n);
      expect(fill.rentReclaimedLamports).toBe(RENT);
      expect(fill.proceedsUsd).toBeCloseTo(30 + (Number(RENT - fill.feeLamports) / 1e9) * SOL_PRICE, 9);
      expect(s.chain.tokenAtaExists).toBe(false);
    });
  }

  it("A11: sells the token account's on-chain balance, not the stored amount", async () => {
    const s = await setup();
    const id = seedSellPosition(s, { tokenAmountRaw: "1000000" });
    s.chain.tokens = 900_000n;
    await s.executor.sellAttempt(s.positions.get(id)!);
    expect(s.chain.builds[0]!.amount).toBe("900000");
  });

  it("slippage rises on each failed attempt: 300, 600, 1200 bps", async () => {
    const s = await setup();
    const id = seedSellPosition(s);
    s.chain.estimateError = { InstructionError: [3, { Custom: 6001 }] }; // slippage exceeded in simulation
    for (let i = 0; i < 3; i++) {
      s.clock.t += 60_000;
      await s.executor.sellAttempt(s.positions.get(id)!);
    }
    expect(s.chain.builds.map((b) => b.slippageBps)).toEqual([300, 600, 1200]);
  });

  it("a simulation failure never sends; after 3 failures the position is stuck (one alert) and retries back off", async () => {
    const s = await setup();
    const id = seedSellPosition(s);
    s.chain.estimateError = { InstructionError: [3, { Custom: 6001 }] };
    for (let i = 0; i < 3; i++) {
      s.clock.t += 60_000;
      await s.executor.sellAttempt(s.positions.get(id)!);
    }
    expect(s.chain.sends).toEqual([]);
    const row = s.positions.get(id)!;
    expect(row.stuckState).toBe("stuck");
    expect(row.nextSellAt).toBe(s.clock.t + 30_000);
    expect(s.alerts.filter((a) => /is stuck/.test(a))).toHaveLength(1);
    // Not due yet: nothing happens, not even a build.
    const builds = s.chain.builds.length;
    await s.executor.sellAttempt(s.positions.get(id)!);
    expect(s.chain.builds.length).toBe(builds);
  });

  it("no route from Jupiter is a failed attempt with no fee and no send", async () => {
    const s = await setup();
    const id = seedSellPosition(s);
    s.chain.buildThrows = true;
    await s.executor.sellAttempt(s.positions.get(id)!);
    expect(s.chain.sends).toEqual([]);
    expect(s.positions.get(id)!.sellFailures).toBe(1);
  });

  it("an on-chain failure pays its fee, which is recorded as a fee loss (daily loss) and against the position's budget", async () => {
    const s = await setup();
    const id = seedSellPosition(s);
    s.chain.statusFor = () => "failed";
    await s.executor.sellAttempt(s.positions.get(id)!);
    const row = s.positions.get(id)!;
    expect(row.sellFailures).toBe(1);
    expect(row.sellFeesLamports).toBeGreaterThan(5_000);
    expect(row.failedSellFeesLamports).toBe(row.sellFeesLamports);
    const day = s.feeLosses.listAll({ mode: "live" })[0]!;
    expect(day.lamports).toBe(row.sellFeesLamports);
    expect(s.feeLosses.sumUsdForDay("live", day.tradingDay)).toBeCloseTo((row.sellFeesLamports / 1e9) * SOL_PRICE, 12);
  });

  it("stops sending once the per-position fee budget is used up, with one urgent alert; /sellretry grants more", async () => {
    const s = await setup();
    const id = seedSellPosition(s, { sellFeesLamports: 4_600_000, stuckState: "stuck", sellFailures: 5 });
    await s.executor.sellAttempt(s.positions.get(id)!);
    expect(s.chain.sends).toEqual([]);
    expect(s.chain.builds).toEqual([]);
    expect(s.positions.get(id)!.stuckState).toBe("budget_exhausted");
    expect(s.alerts.join()).toMatch(/fee budget used up/);
    // Budget exhausted: later attempts only read the balance.
    s.clock.t += 700_000;
    await s.executor.sellAttempt(s.positions.get(id)!);
    expect(s.chain.builds).toEqual([]);
    // /sellretry: exactly one match, grants one more budget, attempts resume now.
    expect(s.executor.sellRetry(s.chain.mint.slice(0, 8))).toMatch(/Granted one more/);
    await s.executor.sellAttempt(s.positions.get(id)!);
    expect(s.chain.sends).toHaveLength(1);
  });

  it("if simulation fails only because of the close, rebuilds once without it and leaves the account open", async () => {
    const s = await setup();
    const id = seedSellPosition(s);
    s.chain.failWhenClose = true;
    await s.executor.sellAttempt(s.positions.get(id)!);
    expect(s.chain.sends).toHaveLength(1);
    expect(s.sells).toHaveLength(1);
    expect(s.chain.tokenAtaExists).toBe(true);
    expect(s.sells[0]![1].rentReclaimedLamports).toBe(0n);
  });

  it("an expired sell counts as a failed attempt; the next attempt rebuilds only after expiry was confirmed", async () => {
    const s = await setup();
    const id = seedSellPosition(s);
    s.chain.statusFor = () => "never";
    await s.executor.sellAttempt(s.positions.get(id)!);
    expect(s.intents.listByStatusSince(0).map((i) => i.status)).toEqual(["expired"]);
    expect(s.positions.get(id)!.sellFailures).toBe(1);
    s.chain.statusFor = () => "landed";
    s.clock.t += 60_000;
    await s.executor.sellAttempt(s.positions.get(id)!);
    expect(s.chain.builds).toHaveLength(2);
    expect(s.sells).toHaveLength(1);
  });

  it("a zero on-chain balance sends nothing and closes the position as reconciled", async () => {
    const s = await setup();
    const id = seedSellPosition(s);
    s.chain.tokens = 0n;
    await s.executor.sellAttempt(s.positions.get(id)!);
    expect(s.reconciled).toEqual([id]);
    expect(s.chain.builds).toEqual([]);
  });

  it("alerts once when SOL drops below SELL_FEE_RESERVE_SOL with positions open, and once on recovery", async () => {
    const s = await setup();
    seedSellPosition(s);
    s.executor.checkSolReserve(1_000n);
    s.executor.checkSolReserve(2_000n);
    s.executor.checkSolReserve(1_000_000_000n);
    expect(s.alerts.filter((a) => /below SELL_FEE_RESERVE_SOL/.test(a))).toHaveLength(1);
    expect(s.alerts.filter((a) => /back above/.test(a))).toHaveLength(1);
  });
});

describe("the one-transaction guard at the executor (addition A, SPEC.md section 16.4)", () => {
  it("an intent persisted but not yet sent blocks a second attempt for the same position and side: nothing is built", async () => {
    const s = await setup();
    const id = seedSellPosition(s);
    const first = s.intents.reserve({ kind: "sell", mode: "live", mint: s.chain.mint, positionId: id, refKey: sellRefKey(id), side: "sell", inputMint: s.chain.mint, outputMint: USDC_MINT, now: s.clock.t });
    s.intents.markSigned(first, { signature: "5".repeat(88), signedTxB64: "AA==", lastValidBlockHeight: 1_000_000, expectedInRaw: "1", expectedOutRaw: "1", minOutRaw: "1" }, s.clock.t);
    await s.executor.sellAttempt(s.positions.get(id)!);
    expect(s.chain.builds).toEqual([]); // resolution found it in flight (not expired): no rebuild
    expect(s.chain.sends).toEqual([]);
    expect(s.intents.get(first)!.status).toBe("signed");
  });

  it("a second buy for the same mint is refused while the first is unresolved", async () => {
    const s = await setup();
    s.intents.reserve({ kind: "buy", mode: "live", mint: s.chain.mint, positionId: null, refKey: buyRefKey(s.chain.mint), side: "buy", inputMint: USDC_MINT, outputMint: s.chain.mint, now: 1 });
    expect(await s.executor.prepareBuy(s.chain.mint, 25)).toBeNull();
    expect(s.chain.builds).toEqual([]);
  });
});

describe("startup recovery of unrecorded transactions (SPEC.md section 16.5, A7)", () => {
  it("a buy that landed without being recorded becomes a normal managed position", async () => {
    const s = await setup({ neverConfirm: true });
    await s.executor.prepareBuy(s.chain.mint, 25);
    void s.executor.executeBuy(buyPayload(s.chain.mint)); // "crashes" after sending: confirmation never returns
    for (let i = 0; i < 50 && s.chain.sends.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(s.chain.sends).toHaveLength(1);
    expect(s.intents.listUnresolved("live")[0]!.status).toBe("sent");
    expect(s.buys).toEqual([]);

    const restarted = s.newExecutor();
    await restarted.startup();
    expect(s.buys).toHaveLength(1);
    const pos = s.positions.listAllActive();
    expect(pos).toHaveLength(1);
    expect(pos[0]!.mint).toBe(s.chain.mint);
    expect(pos[0]!.entrySignature).toBe(s.chain.sends[0]);
    expect(s.alerts.join()).toMatch(/Recovered a live buy/);
    expect(restarted.lastReconcile!.unknownTokens).toEqual([]); // never an "unknown token"
  });

  it("a sell that landed without being recorded closes the position with its real proceeds", async () => {
    const s = await setup({ neverConfirm: true });
    const id = seedSellPosition(s);
    void s.executor.sellAttempt(s.positions.get(id)!);
    for (let i = 0; i < 50 && s.chain.sends.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(s.sells).toEqual([]);

    const restarted = s.newExecutor();
    await restarted.startup();
    expect(s.sells).toHaveLength(1);
    expect(s.sells[0]![1].usdcReceivedRaw).toBe(30_000_000n);
    expect(s.positions.get(id)).toBeUndefined();
    expect(s.reconciled).toEqual([]); // closed with real proceeds, not as reconciled
  });

  it("reconciliation never closes a position as reconciled while an unresolved intent exists for it (addition B)", async () => {
    const s = await setup();
    const id = seedSellPosition(s);
    s.chain.tokens = 0n;
    s.chain.tokenAtaExists = false;
    s.intents.reserve({ kind: "sell", mode: "live", mint: s.chain.mint, positionId: id, refKey: sellRefKey(id), side: "sell", inputMint: s.chain.mint, outputMint: USDC_MINT, now: 1 });
    const intentId = s.intents.listUnresolved()[0]!.id;
    s.intents.markSigned(intentId, { signature: "4".repeat(88), signedTxB64: "AA==", lastValidBlockHeight: 1_000_000, expectedInRaw: "1", expectedOutRaw: "1", minOutRaw: "1" }, 1);
    await s.executor.reconcileNow();
    expect(s.reconciled).toEqual([]);
    expect(s.positions.get(id)).toBeDefined();
  });

  it("reports held tokens with no position and no intent as unknown, once", async () => {
    const s = await setup();
    s.chain.tokenAtaExists = true;
    s.chain.tokens = 5n;
    await s.executor.reconcileNow();
    await s.executor.reconcileNow();
    expect(s.executor.lastReconcile!.unknownTokens.map((t) => t.mint)).toEqual([s.chain.mint]);
    expect(s.alerts.filter((a) => /Unknown tokens/.test(a))).toHaveLength(1);
  });
});

describe("graceful shutdown hooks on the executor (SPEC.md section 16.11)", () => {
  it("after stopNewTransactions nothing new is built or sent", async () => {
    const s = await setup();
    const id = seedSellPosition(s);
    s.executor.stopNewTransactions();
    expect(await s.executor.prepareBuy(s.chain.mint, 25)).toBeNull();
    await s.executor.sellAttempt(s.positions.get(id)!);
    expect(s.chain.builds).toEqual([]);
  });
});

describe("Jupiter lanes for live calls (SPEC.md section 9.3, A13)", () => {
  it("a live buy's /build takes the entry lane; a live sell's /build is recorded on the exit lane", async () => {
    const s = await setup();
    await s.executor.prepareBuy(s.chain.mint, 25);
    expect(s.lanes).toEqual({ entry: 1, exit: 0 });
    await s.executor.executeBuy({ mint: s.chain.mint, sizeUsd: 25, score: 0.7, liquidityUsd: 50_000, snapshot: null });
    expect(s.lanes).toEqual({ entry: 1, exit: 0 }); // the buy reuses the prepared /build: no second Jupiter call
    const id = s.positions.listAllActive()[0]!.id;
    s.positions.update(id, { status: "closing", pendingExitReason: "target" });
    await s.executor.sellAttempt(s.positions.get(id)!);
    expect(s.lanes).toEqual({ entry: 1, exit: 1 });
    expect(s.chain.builds).toHaveLength(2);
  });
});
