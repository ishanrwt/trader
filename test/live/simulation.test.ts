import { describe, expect, it } from "vitest";
import { buildFallbackSimulation } from "../../src/live/simFallback.js";
import { hasBalanceFields, normalizeSimulation, SimulationShapeError } from "../../src/live/simulation.js";
import { buyScenario, fallbackInputs, FEE, simValue, TOKEN_ATA, USDC_ATA, WALLET } from "../helpers/txFixtures.js";

describe("normalizeSimulation (primary path) fails closed on unexpected shapes", () => {
  const s = buyScenario();
  const keys = s.accounts.map((a) => a.address);

  it("normalizes a well-formed result", () => {
    const sim = normalizeSimulation(simValue(s.accounts, FEE, s.inner), keys, keys);
    expect(sim.source).toBe("simulation");
    expect(sim.fee).toBe(FEE);
    expect(sim.tokens.get(TOKEN_ATA)).toMatchObject({ pre: null, post: { owner: WALLET, amount: 1_000_000n } });
  });

  it("detects missing balance fields (so the caller uses the fallback)", () => {
    const raw = simValue(s.accounts, FEE, s.inner);
    delete raw.postTokenBalances;
    expect(hasBalanceFields(raw)).toBe(false);
    expect(() => normalizeSimulation(raw, keys, keys)).toThrow(SimulationShapeError);
  });

  for (const [name, mutate] of [
    ["a simulation error", (r: Record<string, unknown>) => (r.err = { InstructionError: [2, { Custom: 6001 }] })],
    ["a missing fee", (r: Record<string, unknown>) => delete r.fee],
    ["balance arrays that don't match the account keys", (r: Record<string, unknown>) => (r.preBalances = [1, 2])],
    ["a token balance with an unknown token program", (r: Record<string, unknown>) => ((r.postTokenBalances as Array<Record<string, unknown>>)[0]!.programId = "Fake111111111111111111111111111111111111111")],
    ["a token balance with no owner", (r: Record<string, unknown>) => delete (r.preTokenBalances as Array<Record<string, unknown>>)[0]!.owner],
    ["a non-numeric token amount", (r: Record<string, unknown>) => ((r.preTokenBalances as Array<Record<string, { amount: string }>>)[0]!.uiTokenAmount!.amount = "1.5")],
    ["missing post-state accounts", (r: Record<string, unknown>) => delete r.accounts],
    ["missing inner instructions", (r: Record<string, unknown>) => delete r.innerInstructions],
    ["a token account that isn't jsonParsed", (r: Record<string, unknown>) => ((r.accounts as Array<Record<string, unknown>>)[1]!.data = ["AAAA", "base64"])],
  ] as const) {
    it(`refuses ${name}`, () => {
      const raw = simValue(s.accounts, FEE, s.inner);
      mutate(raw);
      expect(() => normalizeSimulation(raw, keys, keys)).toThrow(SimulationShapeError);
    });
  }
});

describe("buildFallbackSimulation (src/live/simFallback.ts) fails closed on missing or inconsistent data", () => {
  const s = buyScenario();

  function build(mutate?: (f: ReturnType<typeof fallbackInputs>) => void, created = [TOKEN_ATA]) {
    const f = fallbackInputs(s.accounts, FEE, s.inner);
    mutate?.(f);
    return buildFallbackSimulation({ wallet: WALLET, addresses: f.addresses, preAccounts: f.preAccounts, simValue: f.simValue, created });
  }

  it("derives the same balances as the primary path", () => {
    const sim = build();
    expect(sim.source).toBe("fallback");
    const wallet = sim.lamports.get(WALLET)!;
    expect(wallet.post - wallet.pre).toBe(-(FEE + 2_039_280n));
    expect(sim.tokens.get(USDC_ATA)).toMatchObject({ pre: { amount: 100_000_000n }, post: { amount: 75_000_000n } });
    expect(sim.tokens.get(TOKEN_ATA)).toMatchObject({ pre: null, post: { amount: 1_000_000n } });
  });

  it("refuses when the pre-read or the post-state doesn't cover every account", () => {
    expect(() => build((f) => (f.preAccounts = f.preAccounts.slice(1)))).toThrow(SimulationShapeError);
    expect(() => build((f) => ((f.simValue as Record<string, unknown>).accounts = []))).toThrow(SimulationShapeError);
  });

  it("refuses when the simulation's fee or inner instructions are missing", () => {
    expect(() => build((f) => delete (f.simValue as Record<string, unknown>).fee)).toThrow(SimulationShapeError);
    expect(() => build((f) => delete (f.simValue as Record<string, unknown>).innerInstructions)).toThrow(SimulationShapeError);
  });

  it("refuses when the wallet isn't System-owned or isn't among the accounts", () => {
    expect(() => build((f) => ((f.preAccounts[0] as Record<string, unknown>).owner = "Fake111111111111111111111111111111111111111"))).toThrow(SimulationShapeError);
    expect(() => build((f) => (f.addresses = f.addresses.map((a) => (a === WALLET ? "X111111111111111111111111111111111111111111" : a))))).toThrow(SimulationShapeError);
  });

  it("refuses when an account the transaction creates ends up owned by an unknown program", () => {
    expect(() =>
      build((f) => {
        const post = (f.simValue as { accounts: Array<Record<string, unknown>> }).accounts[2]!;
        post.owner = "Fake111111111111111111111111111111111111111";
        post.data = ["", "base64"];
      }),
    ).toThrow(SimulationShapeError);
  });

  it("refuses when a token account's mint or owner differs between the pre-read and the simulation", () => {
    expect(() =>
      build((f) => {
        const pre = f.preAccounts[1] as { data: { parsed: { info: { mint: string } } } };
        pre.data.parsed.info.mint = "Other111111111111111111111111111111111111111";
      }),
    ).toThrow(SimulationShapeError);
  });

  it("refuses a token-program account whose data isn't jsonParsed", () => {
    expect(() => build((f) => ((f.preAccounts[1] as Record<string, unknown>).data = ["AAAA", "base64"]))).toThrow(SimulationShapeError);
  });

  it("refuses a simulation error", () => {
    expect(() => build((f) => ((f.simValue as Record<string, unknown>).err = "BlockhashNotFound"))).toThrow(SimulationShapeError);
  });
});
