import { describe, expect, it } from "vitest";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT } from "../../src/live/programs.js";
import { buildFallbackSimulation } from "../../src/live/simFallback.js";
import { normalizeSimulation } from "../../src/live/simulation.js";
import { checkBuildResponse, verifyTransaction, type DecodedInstruction, type VerifyParams } from "../../src/live/verify.js";
import {
  ataCreate,
  buyScenario,
  closeAccount,
  cuLimit,
  cuPrice,
  FEE,
  fallbackInputs,
  innerSys,
  innerTok,
  ix,
  jupiterSwap,
  LIMIT,
  MINT,
  POOL_A,
  PRICE,
  RENT,
  sellScenario,
  simValue,
  solToUsdcScenario,
  STRANGER,
  systemTransfer,
  TOKEN_ATA,
  tx,
  USDC_ATA,
  usdcToSolScenario,
  WALLET,
  type AcctSpec,
} from "../helpers/txFixtures.js";
import type { ParsedInnerInstruction } from "../../src/live/simulation.js";

function verifyPrimary(p: VerifyParams, instructions: DecodedInstruction[], accounts: AcctSpec[], inner: ParsedInnerInstruction[], fee = FEE, t = tx(instructions)) {
  const raw = simValue(accounts, fee, inner);
  const sim = normalizeSimulation(raw, accounts.map((a) => a.address), accounts.map((a) => a.address));
  return verifyTransaction(p, t, sim);
}

function verifyFallback(p: VerifyParams, instructions: DecodedInstruction[], accounts: AcctSpec[], inner: ParsedInnerInstruction[], created: string[], fee = FEE) {
  const f = fallbackInputs(accounts, fee, inner);
  const sim = buildFallbackSimulation({ wallet: WALLET, addresses: f.addresses, preAccounts: f.preAccounts, simValue: f.simValue, created });
  return verifyTransaction(p, tx(instructions), sim);
}

describe("verifyTransaction: accepted transactions (SPEC.md section 16.2)", () => {
  it("accepts a USDC -> token buy that creates our token account, from the simulation's own balances", () => {
    const s = buyScenario();
    const r = verifyPrimary(s.params, s.instructions, s.accounts, s.inner);
    expect(r).toEqual({ ok: true, priorityFeeLamports: 180n, cuLimit: LIMIT, source: "simulation" });
  });

  it("accepts the same buy through the fallback (balances derived from pre-read + post-state)", () => {
    const s = buyScenario();
    const r = verifyFallback(s.params, s.instructions, s.accounts, s.inner, [TOKEN_ATA]);
    expect(r).toMatchObject({ ok: true, source: "fallback" });
  });

  it("accepts a full sell that closes our Token-2022 token account and reclaims its rent", () => {
    const s = sellScenario(TOKEN_2022_PROGRAM);
    expect(verifyPrimary(s.params, s.instructions, s.accounts, s.inner)).toMatchObject({ ok: true });
  });

  it("accepts SOL as the output mint (wrap and unwrap in one transaction) without confusing it with fees", () => {
    const s = usdcToSolScenario();
    expect(verifyPrimary(s.params, s.instructions, s.accounts, s.inner)).toMatchObject({ ok: true });
    expect(verifyFallback(s.params, s.instructions, s.accounts, s.inner, ["WsolTemp111111111111111111111111111111111111"])).toMatchObject({ ok: true });
  });

  it("refuses SOL output below the minimum, even when the shortfall is smaller than the fee", () => {
    const s = usdcToSolScenario(5_899_999n); // minOut is 5,900,000
    const r = verifyPrimary(s.params, s.instructions, s.accounts, s.inner);
    expect(r).toMatchObject({ ok: false, check: "g" });
  });

  it("accepts SOL as the input mint (transfer into our own temporary wSOL account + syncNative)", () => {
    const s = solToUsdcScenario();
    expect(verifyPrimary(s.params, s.instructions, s.accounts, s.inner)).toMatchObject({ ok: true });
  });
});

describe("verifyTransaction: refusals (every case in SPEC.md section 16.2 step 5 / A9)", () => {
  it("a: the fee payer is not our wallet", () => {
    const s = buyScenario();
    expect(verifyPrimary(s.params, s.instructions, s.accounts, s.inner, FEE, tx(s.instructions, STRANGER))).toMatchObject({ ok: false, check: "a" });
  });

  it("a: another signer is required", () => {
    const s = buyScenario();
    const instr = [...s.instructions, ix("Other1111111111111111111111111111111111111", [{ address: STRANGER, signer: true }], new Uint8Array())];
    expect(verifyPrimary(s.params, instr, s.accounts, s.inner, FEE, tx(instr, WALLET, [WALLET, STRANGER]))).toMatchObject({ ok: false, check: "a" });
  });

  it("c: a priority fee above MAX_PRIORITY_FEE_SOL", () => {
    const s = buyScenario();
    const instr = [cuLimit(400_000), cuPrice(2_000_000n), ataCreate(TOKEN_ATA, MINT), jupiterSwap()]; // 800,000 lamports > 500,000
    expect(verifyPrimary(s.params, instr, s.accounts, s.inner, 5_000n + 800_000n)).toMatchObject({ ok: false, check: "c" });
  });

  it("c: a simulated fee that doesn't match base + the priority fee from the compute-budget instructions", () => {
    const s = buyScenario();
    expect(verifyPrimary(s.params, s.instructions, s.accounts, s.inner, FEE + 1n)).toMatchObject({ ok: false, check: "c" });
  });

  it("c: two compute-unit limits, or an unknown compute-budget instruction", () => {
    const s = buyScenario();
    expect(verifyPrimary(s.params, [cuLimit(LIMIT), ...s.instructions], s.accounts, s.inner)).toMatchObject({ ok: false, check: "c" });
    const heap = ix("ComputeBudget111111111111111111111111111111", [], new Uint8Array([1, 0, 0, 1, 0]));
    expect(verifyPrimary(s.params, [heap, ...s.instructions], s.accounts, s.inner)).toMatchObject({ ok: false, check: "c" });
  });

  it("d: the input decreases by more than the requested amount", () => {
    const s = buyScenario();
    s.accounts[1]!.postToken!.amount = 74_999_999n; // 25,000,001 spent for 25,000,000 requested
    expect(verifyPrimary(s.params, s.instructions, s.accounts, s.inner)).toMatchObject({ ok: false, check: "d" });
  });

  it("d: USDC input above HARD_MAX_POSITION_USD in raw units, independently of the expected amount (a decimals bug)", () => {
    const s = buyScenario();
    // The requested amount itself is the decimals bug: $25 scaled by 10^9 instead of 10^6.
    const p = { ...s.params, requestedInRaw: 25_000_000_000n };
    s.accounts[1]!.preToken!.amount = 30_000_000_000n;
    s.accounts[1]!.postToken!.amount = 5_000_000_000n;
    expect(verifyPrimary(p, s.instructions, s.accounts, s.inner)).toMatchObject({ ok: false, check: "d", reason: expect.stringContaining("HARD_MAX_POSITION_USD") });
  });

  it("e: the output increases by less than the quote's minimum out", () => {
    const s = buyScenario();
    s.accounts[2]!.postToken!.amount = 899_999n;
    expect(verifyPrimary(s.params, s.instructions, s.accounts, s.inner)).toMatchObject({ ok: false, check: "e" });
  });

  it("f: an unexpected balance change in another of our token accounts", () => {
    const s = buyScenario();
    s.accounts.push({ address: "OtherAta11111111111111111111111111111111111", pre: RENT, post: RENT, preToken: { mint: "Other111111111111111111111111111111111111111", owner: WALLET, amount: 50n }, postToken: { mint: "Other111111111111111111111111111111111111111", owner: WALLET, amount: 0n } });
    expect(verifyPrimary(s.params, s.instructions, s.accounts, s.inner)).toMatchObject({ ok: false, check: "f" });
  });

  it("g: SOL spent beyond the base fee, the priority fee and rent for accounts it creates", () => {
    const s = buyScenario();
    s.accounts[0]!.post -= 10_000_000n; // 0.01 SOL leaves the wallet with no instruction we can see
    expect(verifyPrimary(s.params, s.instructions, s.accounts, s.inner)).toMatchObject({ ok: false, check: "g" });
  });

  it("h: a top-level SOL transfer from our wallet to another account", () => {
    const s = buyScenario();
    const instr = [...s.instructions, systemTransfer(WALLET, STRANGER, 1_000n)];
    expect(verifyPrimary(s.params, instr, s.accounts, s.inner)).toMatchObject({ ok: false, check: "h" });
  });

  it("h: an inner (CPI) SOL transfer from our wallet to another account", () => {
    const s = buyScenario();
    const inner = [...s.inner, innerSys("transfer", { source: WALLET, destination: STRANGER, lamports: 1000 })];
    expect(verifyPrimary(s.params, s.instructions, s.accounts, inner)).toMatchObject({ ok: false, check: "h" });
  });

  it("h: our wallet funds a new account that isn't ours", () => {
    const s = buyScenario();
    const inner = [...s.inner, innerSys("createAccount", { source: WALLET, newAccount: STRANGER, lamports: 1000 })];
    expect(verifyPrimary(s.params, s.instructions, s.accounts, inner)).toMatchObject({ ok: false, check: "h" });
  });

  it("h: our wallet is assigned to another program", () => {
    const s = buyScenario();
    const inner = [...s.inner, innerSys("assign", { account: WALLET, owner: STRANGER })];
    expect(verifyPrimary(s.params, s.instructions, s.accounts, inner)).toMatchObject({ ok: false, check: "h" });
  });

  it("h: a token account created for someone else at our expense", () => {
    const s = buyScenario();
    const instr = [cuLimit(LIMIT), cuPrice(PRICE), ataCreate(TOKEN_ATA, MINT, TOKEN_PROGRAM, STRANGER), jupiterSwap()];
    expect(verifyPrimary(s.params, instr, s.accounts, s.inner)).toMatchObject({ ok: false, check: "h" });
  });

  it("h: our token account closed to someone else", () => {
    const s = sellScenario();
    const instr = [cuLimit(LIMIT), cuPrice(PRICE), jupiterSwap(), closeAccount(TOKEN_ATA, STRANGER)];
    expect(verifyPrimary(s.params, instr, s.accounts, s.inner)).toMatchObject({ ok: false, check: "h" });
  });

  it("i: an authority (owner) change on one of our token accounts, by instruction", () => {
    const s = buyScenario();
    const inner = [...s.inner, innerTok("setAuthority", { account: USDC_ATA, authorityType: "accountOwner", newAuthority: STRANGER })];
    expect(verifyPrimary(s.params, s.instructions, s.accounts, inner)).toMatchObject({ ok: false, check: "i" });
  });

  it("i: a delegate approval on one of our token accounts, by instruction", () => {
    const s = buyScenario();
    const inner = [...s.inner, innerTok("approve", { source: USDC_ATA, delegate: STRANGER, amount: "1" })];
    expect(verifyPrimary(s.params, s.instructions, s.accounts, inner)).toMatchObject({ ok: false, check: "i" });
  });

  it("i: a delegate or close authority present on one of our token accounts after the transaction", () => {
    const s = buyScenario();
    s.accounts[1]!.postDelegate = STRANGER;
    expect(verifyPrimary(s.params, s.instructions, s.accounts, s.inner)).toMatchObject({ ok: false, check: "i" });
    const t = buyScenario();
    t.accounts[2]!.postCloseAuthority = STRANGER;
    expect(verifyPrimary(t.params, t.instructions, t.accounts, t.inner)).toMatchObject({ ok: false, check: "i" });
  });

  it("i: one of our token accounts ends up owned by someone else", () => {
    const s = buyScenario();
    s.accounts[1]!.postToken = { ...s.accounts[1]!.postToken!, owner: STRANGER, amount: 100_000_000n };
    expect(verifyPrimary(s.params, s.instructions, s.accounts, s.inner)).toMatchObject({ ok: false, check: "i" });
  });

  it("j: we'd end up holding a token account for an unexpected mint", () => {
    const s = buyScenario();
    const instr = [cuLimit(LIMIT), cuPrice(PRICE), ataCreate(TOKEN_ATA, "Other111111111111111111111111111111111111111"), jupiterSwap()];
    expect(verifyPrimary(s.params, instr, s.accounts, s.inner)).toMatchObject({ ok: false, check: "j" });
  });
});

describe("verifyTransaction: fail closed on unexpected shapes (addition C)", () => {
  it("refuses an unknown top-level program", () => {
    const s = buyScenario();
    const instr = [...s.instructions, ix("Memo1111111111111111111111111111111111111111", [], new Uint8Array([1]))];
    expect(verifyPrimary(s.params, instr, s.accounts, s.inner)).toMatchObject({ ok: false, check: "h" });
  });

  it("refuses an unknown top-level token instruction and a second Jupiter instruction", () => {
    const s = buyScenario();
    const approve = ix(TOKEN_PROGRAM, [USDC_ATA, STRANGER, WALLET], new Uint8Array([4, 1, 0, 0, 0, 0, 0, 0, 0]));
    expect(verifyPrimary(s.params, [...s.instructions, approve], s.accounts, s.inner)).toMatchObject({ ok: false, check: "h" });
    expect(verifyPrimary(s.params, [...s.instructions, jupiterSwap()], s.accounts, s.inner)).toMatchObject({ ok: false, check: "h" });
  });

  it("refuses an unknown inner token instruction type and an unparsed inner system instruction", () => {
    const s = buyScenario();
    expect(verifyPrimary(s.params, s.instructions, s.accounts, [...s.inner, innerTok("freezeAccount", { account: USDC_ATA })])).toMatchObject({ ok: false, check: "h" });
    expect(verifyPrimary(s.params, s.instructions, s.accounts, [...s.inner, { programId: "11111111111111111111111111111111" }])).toMatchObject({ ok: false, check: "shape" });
  });

  it("refuses when the parsed post-state of one of our token accounts is missing", () => {
    const s = buyScenario();
    const raw = simValue(s.accounts, FEE, s.inner, s.accounts.map((a) => a.address).filter((a) => a !== USDC_ATA));
    const sim = normalizeSimulation(raw, s.accounts.map((a) => a.address), s.accounts.map((a) => a.address).filter((a) => a !== USDC_ATA));
    expect(verifyTransaction(s.params, tx(s.instructions), sim)).toMatchObject({ ok: false, check: "shape" });
  });

  it("refuses a token account created with an unknown token program", () => {
    const s = buyScenario();
    const instr = [cuLimit(LIMIT), cuPrice(PRICE), ataCreate(TOKEN_ATA, MINT, "Fake111111111111111111111111111111111111111"), jupiterSwap()];
    expect(verifyPrimary(s.params, instr, s.accounts, s.inner)).toMatchObject({ ok: false, check: "shape" });
  });
});

describe("checkBuildResponse (SPEC.md section 16.2 step 1)", () => {
  const req = { inputMint: USDC_MINT, outputMint: MINT, amountRaw: 25_000_000n };
  const good = { inputMint: USDC_MINT, outputMint: MINT, inAmount: "25000000", otherAmountThreshold: "900000", tipInstruction: null };

  it("accepts a matching response and returns the minimum out", () => {
    expect(checkBuildResponse(good, req, 100_000_000n)).toEqual({ ok: true, minOutRaw: 900_000n });
  });

  it("refuses mismatched mints or amount, a missing minimum, a tip instruction, and USDC above the hard cap", () => {
    expect(checkBuildResponse({ ...good, outputMint: WSOL_MINT }, req, 100_000_000n).ok).toBe(false);
    expect(checkBuildResponse({ ...good, inAmount: "25000001" }, req, 100_000_000n).ok).toBe(false);
    expect(checkBuildResponse({ ...good, otherAmountThreshold: undefined }, req, 100_000_000n).ok).toBe(false);
    expect(checkBuildResponse({ ...good, tipInstruction: { programId: "x" } }, req, 100_000_000n).ok).toBe(false);
    expect(checkBuildResponse({ ...good, inAmount: "101000000" }, { ...req, amountRaw: 101_000_000n }, 100_000_000n)).toMatchObject({ ok: false, reason: expect.stringContaining("HARD_MAX") });
  });
});

void POOL_A;
