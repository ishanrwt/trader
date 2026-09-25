import { describe, expect, it, vi } from "vitest";
import { ConfirmationPool, classifyStatus, type ConfirmRpc } from "../../src/live/confirm.js";
import { buyFillFromEffects, extractConfirmedEffects, sellFillFromEffects, solReceivedFromEffects } from "../../src/live/fills.js";
import { resolveIntent, type ResolutionRpc } from "../../src/live/intentResolution.js";
import { TOKEN_2022_PROGRAM, USDC_MINT } from "../../src/live/programs.js";
import { SimulationShapeError } from "../../src/live/simulation.js";
import type { IntentRow } from "../../src/storage/intents.js";
import type { SignatureStatus } from "../../src/live/txRpc.js";
import { buyScenario, confirmedTx, FEE, MINT, RENT, sellScenario, TOKEN_ATA, usdcToSolScenario, WALLET } from "../helpers/txFixtures.js";

const LANDED: SignatureStatus = { confirmationStatus: "confirmed", err: null };
const FAILED: SignatureStatus = { confirmationStatus: "confirmed", err: { InstructionError: [2, { Custom: 6001 }] } };

describe("classifyStatus", () => {
  it("maps statuses per section 16.4", () => {
    expect(classifyStatus(null)).toBe("unknown");
    expect(classifyStatus({ confirmationStatus: "processed", err: null })).toBe("pending");
    expect(classifyStatus(LANDED)).toBe("landed");
    expect(classifyStatus({ confirmationStatus: "finalized", err: null })).toBe("landed");
    expect(classifyStatus(FAILED)).toBe("failed");
  });
});

function fakeRpc(script: { statuses: (sigs: readonly string[], history: boolean) => SignatureStatus[]; height: () => number }) {
  const calls = { statuses: [] as Array<{ sigs: string[]; history: boolean }>, heights: 0, resends: 0 };
  const rpc: ConfirmRpc = {
    getSignatureStatuses: async (sigs, history) => {
      calls.statuses.push({ sigs: [...sigs], history });
      return script.statuses(sigs, history);
    },
    getBlockHeight: async () => {
      calls.heights++;
      return script.height();
    },
    resend: async () => {
      calls.resends++;
    },
  };
  return { rpc, calls };
}

function pool(rpc: ConfirmRpc, clock: { t: number }) {
  return new ConfirmationPool({
    rpc,
    pollMs: 2_000,
    resendEveryMs: 4_000,
    blockHeightAfterMs: 30_000,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
  });
}

describe("ConfirmationPool (SPEC.md section 16.4, A8)", () => {
  it("covers every in-flight signature with ONE getSignatureStatuses call per poll", async () => {
    const clock = { t: 0 };
    let polls = 0;
    const { rpc, calls } = fakeRpc({ statuses: (sigs) => { polls++; return sigs.map(() => (polls >= 2 ? LANDED : null)); }, height: () => 0 });
    const p = pool(rpc, clock);
    const a = p.track({ signature: "A", signedTxB64: "AA==", lastValidBlockHeight: 100 });
    const b = p.track({ signature: "B", signedTxB64: "AA==", lastValidBlockHeight: 100 });
    expect(await Promise.all([a, b])).toEqual(["landed", "landed"]);
    expect(calls.statuses.every((c) => c.sigs.length === 2)).toBe(true);
    expect(calls.statuses).toHaveLength(2);
  });

  it("resends the same signed bytes every 2 polls until the outcome is known", async () => {
    const clock = { t: 0 };
    let polls = 0;
    const { rpc, calls } = fakeRpc({ statuses: (s) => { polls++; return s.map(() => (polls >= 5 ? LANDED : null)); }, height: () => 0 });
    expect(await pool(rpc, clock).track({ signature: "A", signedTxB64: "AA==", lastValidBlockHeight: 100 })).toBe("landed");
    expect(calls.resends).toBe(2); // at 4 s and 8 s; landed at the 10 s poll
  });

  it("reports an on-chain failure as failed", async () => {
    const { rpc } = fakeRpc({ statuses: (s) => s.map(() => FAILED), height: () => 0 });
    expect(await pool(rpc, { t: 0 }).track({ signature: "A", signedTxB64: "AA==", lastValidBlockHeight: 100 })).toBe("failed");
  });

  it("marks a transaction expired only after the block height passes lastValidBlockHeight AND a history lookup can't find it", async () => {
    const clock = { t: 0 };
    let height = 90;
    const { rpc, calls } = fakeRpc({ statuses: (s) => s.map(() => null), height: () => (height += 1) });
    expect(await pool(rpc, clock).track({ signature: "A", signedTxB64: "AA==", lastValidBlockHeight: 100 })).toBe("expired");
    expect(calls.heights).toBeGreaterThan(0);
    expect(clock.t).toBeGreaterThanOrEqual(30_000); // no block-height checks before 30 s
    expect(calls.statuses.at(-1)).toEqual({ sigs: ["A"], history: true });
  });

  it("never reports expired (so never allows a rebuild) if the old signature landed: found by the final history lookup", async () => {
    const clock = { t: 0 };
    const { rpc } = fakeRpc({ statuses: (s, history) => s.map(() => (history ? LANDED : null)), height: () => 1_000 });
    expect(await pool(rpc, clock).track({ signature: "A", signedTxB64: "AA==", lastValidBlockHeight: 100 })).toBe("landed");
  });
});

function intent(overrides: Partial<IntentRow> = {}): IntentRow {
  return {
    id: 1, kind: "sell", mode: "live", mint: MINT, positionId: 7, refKey: "pos:7", side: "sell", status: "sent", signature: "SIG", signedTxB64: "AA==",
    lastValidBlockHeight: 100, inputMint: MINT, outputMint: USDC_MINT, expectedInRaw: "1", expectedOutRaw: "2", minOutRaw: "1", payload: null,
    feeLamports: null, error: null, createdAt: 1, updatedAt: 1, sentAt: 1, resolvedAt: null, ...overrides,
  };
}

function resolutionRpc(status: SignatureStatus, height: number, tx: Record<string, unknown> | null = { meta: {} }): ResolutionRpc & { getTransaction: ReturnType<typeof vi.fn> } {
  return { getSignatureStatuses: async () => [status], getBlockHeight: async () => height, getTransaction: vi.fn(async () => tx) };
}

describe("resolveIntent (SPEC.md section 16.5)", () => {
  it("a reserved-but-unsigned intent is abandoned without any RPC call", async () => {
    const rpc = resolutionRpc(null, 0);
    expect(await resolveIntent(intent({ status: "pending", signature: null }), rpc)).toMatchObject({ kind: "abandoned" });
    expect(rpc.getTransaction).not.toHaveBeenCalled();
  });

  it("a landed signature resolves to landed with its confirmed transaction", async () => {
    expect(await resolveIntent(intent(), resolutionRpc(LANDED, 0, { ok: 1 }))).toEqual({ kind: "landed", tx: { ok: 1 } });
  });

  it("a failed signature resolves to failed with its transaction (for the fee)", async () => {
    expect(await resolveIntent(intent(), resolutionRpc(FAILED, 0, { ok: 2 }))).toEqual({ kind: "failed", tx: { ok: 2 } });
  });

  it("not found and past lastValidBlockHeight: expired if it was sent, abandoned if only signed", async () => {
    expect(await resolveIntent(intent({ status: "sent" }), resolutionRpc(null, 101))).toEqual({ kind: "expired" });
    expect(await resolveIntent(intent({ status: "signed" }), resolutionRpc(null, 101))).toMatchObject({ kind: "abandoned" });
  });

  it("not found and not yet past lastValidBlockHeight: still in flight (no rebuild allowed)", async () => {
    expect(await resolveIntent(intent({ status: "sent" }), resolutionRpc(null, 100))).toEqual({ kind: "in_flight" });
    expect(await resolveIntent(intent({ status: "signed" }), resolutionRpc(null, 50))).toEqual({ kind: "in_flight" });
  });

  it("confirmed but the transaction body isn't available yet: in flight, try again later", async () => {
    expect(await resolveIntent(intent(), resolutionRpc(LANDED, 0, null))).toEqual({ kind: "in_flight" });
  });
});

describe("real fills from the confirmed transaction (SPEC.md section 16.3, A2)", () => {
  it("buy: cost basis = USDC actually spent + (fee + rent) in USD, not the quote", () => {
    const s = buyScenario(TOKEN_2022_PROGRAM);
    const effects = extractConfirmedEffects(confirmedTx(s.accounts, FEE), WALLET);
    const fill = buyFillFromEffects(effects, MINT, 200);
    expect(fill.tokensRaw).toBe(1_000_000n);
    expect(fill.usdcSpentRaw).toBe(25_000_000n);
    expect(fill.feeLamports).toBe(FEE);
    expect(fill.rentPaidLamports).toBe(RENT);
    expect(fill.feeUsd).toBeCloseTo((5_180 / 1e9) * 200, 12);
    expect(fill.rentUsd).toBeCloseTo((2_039_280 / 1e9) * 200, 12);
    expect(fill.costBasisUsd).toBeCloseTo(25 + fill.feeUsd + fill.rentUsd, 12);
    expect(fill.tokenAccount).toEqual({ address: TOKEN_ATA, program: TOKEN_2022_PROGRAM });
  });

  it("sell: proceeds = USDC actually received + (rent reclaimed − fee) in USD", () => {
    const s = sellScenario();
    const fill = sellFillFromEffects(extractConfirmedEffects(confirmedTx(s.accounts, FEE), WALLET), MINT, 150);
    expect(fill.tokensSoldRaw).toBe(1_000_000n);
    expect(fill.usdcReceivedRaw).toBe(30_000_000n);
    expect(fill.rentReclaimedLamports).toBe(RENT);
    expect(fill.proceedsUsd).toBeCloseTo(30 + ((2_039_280 - 5_180) / 1e9) * 150, 12);
  });

  it("smoke-live leg 1: SOL received is measured from the confirmed balances, not the fee-adjusted lamport change", () => {
    const s = usdcToSolScenario(6_000_000n);
    expect(solReceivedFromEffects(extractConfirmedEffects(confirmedTx(s.accounts, FEE), WALLET))).toBe(6_000_000n);
  });

  it("fails closed on a missing fee, missing balances, or an unknown token program", () => {
    const s = buyScenario();
    const a = confirmedTx(s.accounts, FEE) as { meta: Record<string, unknown> };
    delete a.meta.fee;
    expect(() => extractConfirmedEffects(a, WALLET)).toThrow(SimulationShapeError);
    const b = confirmedTx(s.accounts, FEE) as { meta: Record<string, unknown> };
    b.meta.postBalances = [1];
    expect(() => extractConfirmedEffects(b, WALLET)).toThrow(SimulationShapeError);
    const c = confirmedTx(s.accounts, FEE) as { meta: { postTokenBalances: Array<Record<string, unknown>> } };
    c.meta.postTokenBalances[0]!.programId = "Fake111111111111111111111111111111111111111";
    expect(() => extractConfirmedEffects(c, WALLET)).toThrow(SimulationShapeError);
  });
});
