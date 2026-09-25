import { encodeSetComputeUnitLimit, encodeSetComputeUnitPrice } from "../../src/live/instructions.js";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  JUPITER_AGGREGATOR_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
} from "../../src/live/programs.js";
import type { ParsedInnerInstruction } from "../../src/live/simulation.js";
import type { DecodedInstruction, DecodedTransaction, VerifyParams } from "../../src/live/verify.js";

export const WALLET = "Wa11et1111111111111111111111111111111111111";
export const STRANGER = "Stranger11111111111111111111111111111111111";
export const MINT = "Mint111111111111111111111111111111111111111";
export const USDC_ATA = "UsdcAta1111111111111111111111111111111111111";
export const TOKEN_ATA = "TokenAta111111111111111111111111111111111111";
export const WSOL_TEMP = "WsolTemp111111111111111111111111111111111111";
export const POOL_A = "PoolA11111111111111111111111111111111111111";
export const POOL_B = "PoolB11111111111111111111111111111111111111";
export const RENT = 2_039_280n;

export interface TokenSpec {
  mint: string;
  owner: string;
  program?: string;
  amount: bigint;
}

export interface AcctSpec {
  address: string;
  pre: bigint;
  post: bigint;
  owner?: string; // owning program (default: system for the wallet, token program for token accounts, a DEX otherwise)
  preToken?: TokenSpec;
  postToken?: TokenSpec;
  postDelegate?: string;
  postCloseAuthority?: string;
}

export function ix(programId: string, accounts: Array<string | { address: string; signer?: boolean; writable?: boolean }>, data: Uint8Array): DecodedInstruction {
  return {
    programId,
    accounts: accounts.map((a) => (typeof a === "string" ? { address: a, signer: a === WALLET, writable: true } : { address: a.address, signer: a.signer ?? false, writable: a.writable ?? true })),
    data,
  };
}

export const cuLimit = (units: number) => ix(COMPUTE_BUDGET_PROGRAM, [], encodeSetComputeUnitLimit(units));
export const cuPrice = (micro: bigint) => ix(COMPUTE_BUDGET_PROGRAM, [], encodeSetComputeUnitPrice(micro));
export const ataCreate = (ata: string, mint: string, program = TOKEN_PROGRAM, owner = WALLET, payer = WALLET) =>
  ix(ASSOCIATED_TOKEN_PROGRAM, [payer, ata, owner, mint, SYSTEM_PROGRAM, program], new Uint8Array([1]));
export const jupiterSwap = () => ix(JUPITER_AGGREGATOR_PROGRAM, [WALLET, POOL_A, POOL_B], new Uint8Array([1, 2, 3]));
export const closeAccount = (account: string, dest = WALLET, program = TOKEN_PROGRAM) => ix(program, [account, dest, WALLET], new Uint8Array([9]));
export const syncNative = (account: string) => ix(TOKEN_PROGRAM, [account], new Uint8Array([17]));
export function systemTransfer(from: string, to: string, lamports: bigint): DecodedInstruction {
  const data = new Uint8Array(12);
  const v = new DataView(data.buffer);
  v.setUint32(0, 2, true);
  v.setBigUint64(4, lamports, true);
  return ix(SYSTEM_PROGRAM, [from, to], data);
}

export function tx(instructions: DecodedInstruction[], feePayer = WALLET, signers = [WALLET]): DecodedTransaction {
  return { feePayer, signers, instructions };
}

export function params(overrides: Partial<VerifyParams> = {}): VerifyParams {
  return {
    wallet: WALLET,
    inputMint: USDC_MINT,
    outputMint: MINT,
    requestedInRaw: 25_000_000n,
    minOutRaw: 900_000n,
    tradedMint: MINT,
    maxPriorityFeeLamports: 500_000n,
    hardMaxUsdcRaw: 100_000_000n,
    jupiterProgram: JUPITER_AGGREGATOR_PROGRAM,
    ...overrides,
  };
}

function jsonParsedAccount(lamports: bigint, ownerProgram: string, token: TokenSpec | undefined, delegate?: string, closeAuthority?: string): unknown {
  if (!token) return { lamports: Number(lamports), owner: ownerProgram, data: ["", "base64"], executable: false, rentEpoch: 0 };
  const info: Record<string, unknown> = { mint: token.mint, owner: token.owner, tokenAmount: { amount: token.amount.toString(), decimals: 6 }, state: "initialized", isNative: false };
  if (delegate) info.delegate = delegate;
  if (closeAuthority) info.closeAuthority = closeAuthority;
  return { lamports: Number(lamports), owner: token.program ?? ownerProgram, data: { program: "spl-token", parsed: { type: "account", info }, space: 165 }, executable: false, rentEpoch: 0 };
}

function ownerOf(a: AcctSpec): string {
  if (a.owner) return a.owner;
  if (a.address === WALLET) return SYSTEM_PROGRAM;
  const t = a.postToken ?? a.preToken;
  return t ? (t.program ?? TOKEN_PROGRAM) : "Dex1111111111111111111111111111111111111111";
}

/** The simulateTransaction result value the RPC would return (primary path: all balance fields present). */
export function simValue(accounts: AcctSpec[], fee: bigint, inner: ParsedInnerInstruction[] = [], requested = accounts.map((a) => a.address)): Record<string, unknown> {
  const keys = accounts.map((a) => a.address);
  const tb = (side: "preToken" | "postToken") =>
    accounts.flatMap((a, i) => {
      const t = a[side];
      return t ? [{ accountIndex: i, mint: t.mint, owner: t.owner, programId: t.program ?? TOKEN_PROGRAM, uiTokenAmount: { amount: t.amount.toString(), decimals: 6 } }] : [];
    });
  const byAddr = new Map(accounts.map((a) => [a.address, a]));
  return {
    err: null,
    fee: Number(fee),
    unitsConsumed: 150_000,
    preBalances: accounts.map((a) => Number(a.pre)),
    postBalances: accounts.map((a) => Number(a.post)),
    preTokenBalances: tb("preToken"),
    postTokenBalances: tb("postToken"),
    accounts: requested.map((addr) => {
      const a = byAddr.get(addr);
      if (!a || a.post === 0n) return null;
      return jsonParsedAccount(a.post, ownerOf(a), a.postToken, a.postDelegate, a.postCloseAuthority);
    }),
    innerInstructions: [{ index: 0, instructions: inner }],
    loadedAddresses: { writable: [], readonly: [] },
    keys,
  };
}

/** The fallback's inputs: getMultipleAccounts pre-state and a simulation value WITHOUT balance fields. */
export function fallbackInputs(accounts: AcctSpec[], fee: bigint, inner: ParsedInnerInstruction[] = []) {
  const addresses = accounts.map((a) => a.address);
  const preAccounts = accounts.map((a) => (a.pre === 0n ? null : jsonParsedAccount(a.pre, ownerOf(a), a.preToken)));
  const full = simValue(accounts, fee, inner);
  const { preBalances: _a, postBalances: _b, preTokenBalances: _c, postTokenBalances: _d, ...rest } = full;
  return { addresses, preAccounts, simValue: rest };
}

/** A getTransaction (jsonParsed, maxSupportedTransactionVersion 0) result for a confirmed transaction with these balance changes. */
export function confirmedTx(accounts: AcctSpec[], fee: bigint, opts: { err?: unknown; blockTime?: number; slot?: number } = {}): Record<string, unknown> {
  const tb = (side: "preToken" | "postToken") =>
    accounts.flatMap((a, i) => {
      const t = a[side];
      return t ? [{ accountIndex: i, mint: t.mint, owner: t.owner, programId: t.program ?? TOKEN_PROGRAM, uiTokenAmount: { amount: t.amount.toString(), decimals: 6 } }] : [];
    });
  return {
    slot: opts.slot ?? 1,
    blockTime: opts.blockTime ?? 1_700_000_000,
    meta: {
      err: opts.err ?? null,
      fee: Number(fee),
      preBalances: accounts.map((a) => Number(a.pre)),
      postBalances: accounts.map((a) => Number(a.post)),
      preTokenBalances: tb("preToken"),
      postTokenBalances: tb("postToken"),
    },
    transaction: { message: { accountKeys: accounts.map((a, i) => ({ pubkey: a.address, signer: i === 0, writable: true, source: "transaction" })) }, signatures: ["SIG"] },
  };
}

export const innerSys =(type: string, info: Record<string, unknown>): ParsedInnerInstruction => ({ programId: SYSTEM_PROGRAM, parsed: { type, info } });
export const innerTok = (type: string, info: Record<string, unknown>, program = TOKEN_PROGRAM): ParsedInnerInstruction => ({ programId: program, parsed: { type, info } });

// ---- Canonical scenarios ----
export const PRICE = 1_000n; // micro-lamports per CU
export const LIMIT = 180_000;
export const PRIORITY = 180n; // ceil(1000 * 180000 / 1e6)
export const FEE = 5_000n + PRIORITY;

/** A $25 USDC -> MINT buy that creates the token account (rent) and receives 1,000,000 raw tokens. */
export function buyScenario(program = TOKEN_PROGRAM) {
  const accounts: AcctSpec[] = [
    { address: WALLET, pre: 1_000_000_000n, post: 1_000_000_000n - FEE - RENT },
    { address: USDC_ATA, pre: RENT, post: RENT, preToken: { mint: USDC_MINT, owner: WALLET, amount: 100_000_000n }, postToken: { mint: USDC_MINT, owner: WALLET, amount: 75_000_000n } },
    { address: TOKEN_ATA, pre: 0n, post: RENT, postToken: { mint: MINT, owner: WALLET, program, amount: 1_000_000n } },
    { address: POOL_A, pre: 5_000_000n, post: 5_000_000n, preToken: { mint: USDC_MINT, owner: POOL_B, amount: 1n }, postToken: { mint: USDC_MINT, owner: POOL_B, amount: 25_000_001n } },
  ];
  const inner = [
    innerSys("createAccount", { source: WALLET, newAccount: TOKEN_ATA, lamports: Number(RENT) }),
    innerTok("initializeImmutableOwner", { account: TOKEN_ATA }, program),
    innerTok("initializeAccount3", { account: TOKEN_ATA, mint: MINT, owner: WALLET }, program),
    innerTok("transferChecked", { source: USDC_ATA, destination: POOL_A, authority: WALLET, tokenAmount: { amount: "25000000" } }),
  ];
  const instructions = [cuLimit(LIMIT), cuPrice(PRICE), ataCreate(TOKEN_ATA, MINT, program), jupiterSwap()];
  return { accounts, inner, instructions, params: params() };
}

/** A full sell of 1,000,000 raw MINT -> 30 USDC that closes our token account (rent reclaimed). */
export function sellScenario(program = TOKEN_PROGRAM) {
  const accounts: AcctSpec[] = [
    { address: WALLET, pre: 1_000_000_000n, post: 1_000_000_000n - FEE + RENT },
    { address: USDC_ATA, pre: RENT, post: RENT, preToken: { mint: USDC_MINT, owner: WALLET, amount: 75_000_000n }, postToken: { mint: USDC_MINT, owner: WALLET, amount: 105_000_000n } },
    { address: TOKEN_ATA, pre: RENT, post: 0n, preToken: { mint: MINT, owner: WALLET, program, amount: 1_000_000n } },
  ];
  const inner = [innerTok("transferChecked", { source: TOKEN_ATA, destination: POOL_A, authority: WALLET }, program)];
  const instructions = [cuLimit(LIMIT), cuPrice(PRICE), jupiterSwap(), closeAccount(TOKEN_ATA, WALLET, program)];
  return {
    accounts,
    inner,
    instructions,
    params: params({ inputMint: MINT, outputMint: USDC_MINT, requestedInRaw: 1_000_000n, minOutRaw: 29_000_000n }),
  };
}

/** smoke-live leg 1: 1 USDC -> SOL. Jupiter wraps into a temporary wSOL account and unwraps it in the same transaction. */
export function usdcToSolScenario(solOut = 6_000_000n) {
  const accounts: AcctSpec[] = [
    { address: WALLET, pre: 1_000_000_000n, post: 1_000_000_000n + solOut - FEE },
    { address: USDC_ATA, pre: RENT, post: RENT, preToken: { mint: USDC_MINT, owner: WALLET, amount: 10_000_000n }, postToken: { mint: USDC_MINT, owner: WALLET, amount: 9_000_000n } },
    { address: WSOL_TEMP, pre: 0n, post: 0n },
  ];
  const inner = [
    innerSys("createAccount", { source: WALLET, newAccount: WSOL_TEMP, lamports: Number(RENT) }),
    innerTok("initializeAccount3", { account: WSOL_TEMP, mint: WSOL_MINT, owner: WALLET }),
    innerTok("transferChecked", { source: USDC_ATA, destination: POOL_A, authority: WALLET }),
    innerTok("closeAccount", { account: WSOL_TEMP, destination: WALLET, owner: WALLET }),
  ];
  const instructions = [cuLimit(LIMIT), cuPrice(PRICE), ataCreate(WSOL_TEMP, WSOL_MINT), jupiterSwap(), closeAccount(WSOL_TEMP)];
  return {
    accounts,
    inner,
    instructions,
    params: params({ inputMint: USDC_MINT, outputMint: WSOL_MINT, requestedInRaw: 1_000_000n, minOutRaw: 5_900_000n, tradedMint: WSOL_MINT }),
  };
}

/** smoke-live leg 2: SOL -> USDC. Jupiter wraps our SOL into a temporary wSOL account (transfer + syncNative). */
export function solToUsdcScenario(solIn = 6_000_000n) {
  const accounts: AcctSpec[] = [
    { address: WALLET, pre: 1_000_000_000n, post: 1_000_000_000n - solIn - FEE },
    { address: USDC_ATA, pre: RENT, post: RENT, preToken: { mint: USDC_MINT, owner: WALLET, amount: 9_000_000n }, postToken: { mint: USDC_MINT, owner: WALLET, amount: 9_990_000n } },
    { address: WSOL_TEMP, pre: 0n, post: 0n },
  ];
  const inner = [
    innerSys("createAccount", { source: WALLET, newAccount: WSOL_TEMP, lamports: Number(RENT) }),
    innerTok("initializeAccount3", { account: WSOL_TEMP, mint: WSOL_MINT, owner: WALLET }),
    innerTok("transferChecked", { source: WSOL_TEMP, destination: POOL_A, authority: WALLET }),
  ];
  const instructions = [
    cuLimit(LIMIT),
    cuPrice(PRICE),
    ataCreate(WSOL_TEMP, WSOL_MINT),
    systemTransfer(WALLET, WSOL_TEMP, solIn),
    syncNative(WSOL_TEMP),
    jupiterSwap(),
    closeAccount(WSOL_TEMP),
  ];
  return {
    accounts,
    inner,
    instructions,
    params: params({ inputMint: WSOL_MINT, outputMint: USDC_MINT, requestedInRaw: solIn, minOutRaw: 980_000n, tradedMint: WSOL_MINT }),
  };
}
