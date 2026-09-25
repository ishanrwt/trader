import { BASE_FEE_LAMPORTS } from "../config/validate.js";
import { decodeAta, decodeComputeBudget, decodeSystem, decodeToken, priorityFeeLamports } from "./instructions.js";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAMS,
  USDC_MINT,
  WSOL_MINT,
} from "./programs.js";
import type { NormalizedSimulation, TokenAccountState } from "./simulation.js";

/** One instruction of the exact transaction that will be sent, with every account address resolved (lookup tables included). */
export interface DecodedInstruction {
  programId: string;
  accounts: Array<{ address: string; signer: boolean; writable: boolean }>;
  data: Uint8Array;
}

export interface DecodedTransaction {
  feePayer: string;
  /** Addresses whose signatures the message requires. */
  signers: string[];
  instructions: DecodedInstruction[];
}

export interface VerifyParams {
  wallet: string;
  inputMint: string;
  outputMint: string;
  /** The ExactIn amount requested from /build (raw units). */
  requestedInRaw: bigint;
  /** The quote's otherAmountThreshold (raw units). */
  minOutRaw: bigint;
  /** The token being traded (not USDC); for smoke-live, wrapped SOL. */
  tradedMint: string;
  maxPriorityFeeLamports: bigint;
  /** HARD_MAX_POSITION_USD x 10^6. */
  hardMaxUsdcRaw: bigint;
  jupiterProgram: string;
}

export type VerifyCheck = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "shape";

export type VerifyResult =
  | { ok: true; priorityFeeLamports: bigint; cuLimit: number; source: NormalizedSimulation["source"] }
  | { ok: false; check: VerifyCheck; reason: string };

class Refusal extends Error {
  constructor(readonly check: VerifyCheck, reason: string) {
    super(reason);
  }
}

function refuse(check: VerifyCheck, reason: string): never {
  throw new Refusal(check, reason);
}

/** SPEC.md section 16.2 step 1: the /build response must match what was asked for. */
export function checkBuildResponse(
  resp: { inputMint?: unknown; outputMint?: unknown; inAmount?: unknown; otherAmountThreshold?: unknown; tipInstruction?: unknown },
  req: { inputMint: string; outputMint: string; amountRaw: bigint },
  hardMaxUsdcRaw: bigint,
): { ok: true; minOutRaw: bigint } | { ok: false; reason: string } {
  if (resp.inputMint !== req.inputMint || resp.outputMint !== req.outputMint) return { ok: false, reason: "response mints don't match the request" };
  if (typeof resp.inAmount !== "string" || !/^\d+$/.test(resp.inAmount) || BigInt(resp.inAmount) !== req.amountRaw) {
    return { ok: false, reason: "response inAmount doesn't match the requested amount" };
  }
  if (typeof resp.otherAmountThreshold !== "string" || !/^\d+$/.test(resp.otherAmountThreshold)) return { ok: false, reason: "otherAmountThreshold is missing" };
  if (resp.tipInstruction !== undefined && resp.tipInstruction !== null) return { ok: false, reason: "the response contains a tip instruction" };
  if (req.inputMint === USDC_MINT && req.amountRaw > hardMaxUsdcRaw) return { ok: false, reason: "USDC input exceeds HARD_MAX_POSITION_USD" };
  return { ok: true, minOutRaw: BigInt(resp.otherAmountThreshold) };
}

function sumOurs(sim: NormalizedSimulation, wallet: string, side: "pre" | "post"): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const entry of sim.tokens.values()) {
    const s = entry[side];
    if (s && s.owner === wallet) out.set(s.mint, (out.get(s.mint) ?? 0n) + s.amount);
  }
  return out;
}

/**
 * SPEC.md section 16.2 step 5 (checks a-j) and step 6 (fail closed). Pure:
 * takes the exact transaction that would be sent and its normalized
 * simulation, returns ok or the first failed check. It never throws.
 */
export function verifyTransaction(params: VerifyParams, tx: DecodedTransaction, sim: NormalizedSimulation): VerifyResult {
  try {
    return run(params, tx, sim);
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, check: err.check, reason: err.message };
    return { ok: false, check: "shape", reason: `verification could not complete: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function run(p: VerifyParams, tx: DecodedTransaction, sim: NormalizedSimulation): VerifyResult {
  const wallet = p.wallet;

  // ---- a. fee payer and signers ----
  if (tx.feePayer !== wallet) refuse("a", "the fee payer is not our wallet");
  if (tx.signers.length !== 1 || tx.signers[0] !== wallet) refuse("a", "our wallet is not the only required signer");
  for (const ix of tx.instructions) {
    for (const acct of ix.accounts) if (acct.signer && acct.address !== wallet) refuse("a", `instruction for ${ix.programId} requires another signer`);
  }

  // Our token accounts: owned by the wallet on either side of the simulation.
  const ours = new Set<string>();
  for (const [addr, e] of sim.tokens) if (e.pre?.owner === wallet || e.post?.owner === wallet) ours.add(addr);
  const allowedMints = new Set([USDC_MINT, WSOL_MINT, p.tradedMint]);
  // Accounts our own ATA-create instructions create (includes a temporary wSOL account closed within the transaction).
  const createdOurs = new Map<string, string>(); // address -> mint

  // ---- c + h + i: top-level instructions (unknown programs/discriminators are refused) ----
  let cuLimit: number | null = null;
  let cuPrice: bigint | null = null;
  let jupiterCount = 0;
  for (const ix of tx.instructions) {
    const acct = (i: number): string => {
      const a = ix.accounts[i];
      if (!a) refuse("shape", `instruction for ${ix.programId} is missing account #${i}`);
      return a.address;
    };
    if (ix.programId === COMPUTE_BUDGET_PROGRAM) {
      const d = decodeComputeBudget(ix.data);
      if (d.kind === "limit") {
        if (cuLimit !== null) refuse("c", "more than one setComputeUnitLimit");
        cuLimit = d.units;
      } else if (d.kind === "price") {
        if (cuPrice !== null) refuse("c", "more than one setComputeUnitPrice");
        cuPrice = d.microLamports;
      } else refuse("c", "unknown compute budget instruction");
    } else if (ix.programId === ASSOCIATED_TOKEN_PROGRAM) {
      const d = decodeAta(ix.data);
      if (d.kind !== "create") refuse("h", "unknown associated-token instruction");
      const [payer, ata, owner, mint, , tokenProgram] = [acct(0), acct(1), acct(2), acct(3), acct(4), acct(5)];
      if (payer !== wallet || owner !== wallet) refuse("h", "an associated token account is created for, or paid by, someone else");
      if (!allowedMints.has(mint)) refuse("j", `an associated token account is created for unexpected mint ${mint}`);
      if (!TOKEN_PROGRAMS.has(tokenProgram)) refuse("shape", `unknown token program ${tokenProgram}`);
      createdOurs.set(ata, mint);
    } else if (ix.programId === SYSTEM_PROGRAM) {
      const d = decodeSystem(ix.data);
      if (d.kind !== "transfer") refuse("h", `top-level system instruction ${d.kind} is not allowed`);
      const [from, to] = [acct(0), acct(1)];
      if (from !== wallet) refuse("h", "a top-level transfer from another account");
      const target = sim.tokens.get(to)?.post ?? null;
      const isOurWsol = (target?.owner === wallet && target.mint === WSOL_MINT) || createdOurs.get(to) === WSOL_MINT;
      if (!isOurWsol || p.inputMint !== WSOL_MINT) refuse("h", `a SOL transfer from our wallet to ${to} (only wrapping our own input SOL is allowed)`);
    } else if (TOKEN_PROGRAMS.has(ix.programId)) {
      const d = decodeToken(ix.data);
      if (d.kind === "syncNative") {
        const a = acct(0);
        const s = sim.tokens.get(a)?.post ?? sim.tokens.get(a)?.pre ?? null;
        if (!((s?.owner === wallet && s.mint === WSOL_MINT) || createdOurs.get(a) === WSOL_MINT)) refuse("h", "syncNative on an account that isn't our wrapped-SOL account");
      } else if (d.kind === "closeAccount") {
        const [a, dest, owner] = [acct(0), acct(1), acct(2)];
        if (!(ours.has(a) || createdOurs.has(a))) refuse("h", "closeAccount on an account that isn't ours");
        if (dest !== wallet || owner !== wallet) refuse("h", "closeAccount sends the rent somewhere other than our wallet");
      } else refuse("h", `top-level token instruction not allowed (program ${ix.programId})`);
    } else if (ix.programId === p.jupiterProgram) {
      jupiterCount++;
    } else {
      refuse("h", `unknown top-level program ${ix.programId}`);
    }
  }
  if (jupiterCount !== 1) refuse("h", `expected exactly one Jupiter swap instruction, found ${jupiterCount}`);
  if (cuLimit === null || cuPrice === null) refuse("c", "missing setComputeUnitLimit or setComputeUnitPrice");
  const priority = priorityFeeLamports(cuPrice, cuLimit);
  if (priority > p.maxPriorityFeeLamports) refuse("c", `priority fee ${priority} lamports exceeds MAX_PRIORITY_FEE_SOL (${p.maxPriorityFeeLamports})`);
  const fee = BigInt(BASE_FEE_LAMPORTS) + priority;
  if (sim.fee !== fee) refuse("c", `simulated fee ${sim.fee} != base fee + priority fee ${fee}`);

  // ---- h + i: inner instructions (system/token/ATA must be parsed; unknown types are refused) ----
  const isOurs = (addr: unknown): boolean => typeof addr === "string" && (ours.has(addr) || createdOurs.has(addr));
  for (const inner of sim.inner) {
    const known = inner.programId === SYSTEM_PROGRAM || TOKEN_PROGRAMS.has(inner.programId) || inner.programId === ASSOCIATED_TOKEN_PROGRAM;
    if (inner.programId === COMPUTE_BUDGET_PROGRAM) refuse("h", "compute budget instruction inside a CPI");
    if (!known) continue; // other programs (DEXes): their effects are covered by the balance and post-state checks
    if (!inner.parsed) refuse("shape", `an inner ${inner.programId} instruction was not parsed`);
    const { type, info } = inner.parsed;
    if (inner.programId === SYSTEM_PROGRAM) {
      if (type === "transfer") {
        if (info.source === wallet && !isOurs(info.destination)) refuse("h", `inner SOL transfer from our wallet to ${String(info.destination)}`);
      } else if (type === "createAccount") {
        if (info.source === wallet && !isOurs(info.newAccount)) refuse("h", `our wallet funds a new account ${String(info.newAccount)} that isn't ours`);
      } else if (type === "assign" || type === "allocate") {
        if (info.account === wallet) refuse("h", `inner ${type} on our wallet`);
      } else if (type === "transferWithSeed" || type === "createAccountWithSeed" || type === "assignWithSeed" || type === "allocateWithSeed") {
        if (info.source === wallet || info.base === wallet || info.account === wallet || info.from === wallet) refuse("h", `inner ${type} involving our wallet`);
      } else refuse("h", `unknown inner system instruction ${type}`);
    } else if (inner.programId === ASSOCIATED_TOKEN_PROGRAM) {
      if (type !== "create" && type !== "createIdempotent") refuse("h", `unknown inner associated-token instruction ${type}`);
      if (info.source === wallet && info.wallet !== wallet) refuse("h", "our wallet pays for someone else's token account");
      if (info.wallet === wallet && typeof info.mint === "string" && !allowedMints.has(info.mint)) refuse("j", `a token account for unexpected mint ${info.mint}`);
    } else {
      switch (type) {
        case "setAuthority":
          if (isOurs(info.account)) refuse("i", "an authority change on one of our token accounts");
          break;
        case "approve":
        case "approveChecked":
          if (isOurs(info.source)) refuse("i", "a delegate approval on one of our token accounts");
          break;
        case "closeAccount":
          if (isOurs(info.account) && info.destination !== wallet) refuse("h", "one of our token accounts is closed to someone else");
          break;
        case "transfer":
        case "transferChecked":
        case "initializeAccount":
        case "initializeAccount2":
        case "initializeAccount3":
        case "initializeImmutableOwner":
        case "syncNative":
        case "getAccountDataSize":
        case "burn":
        case "burnChecked":
        case "mintTo":
        case "mintToChecked":
        case "revoke":
        case "amountToUiAmount":
        case "uiAmountToAmount":
          break; // effects are covered by the balance and post-state checks
        default:
          refuse("h", `unknown inner token instruction ${type}`);
      }
    }
  }

  // ---- i (first, for a precise reason): an account of ours must not change owner ----
  for (const [addr, e] of sim.tokens) {
    if (e.pre?.owner === wallet && e.post && e.post.owner !== wallet) refuse("i", `token account ${addr} changes owner`);
  }

  // ---- d, e, f: token balances (raw units) ----
  const pre = sumOurs(sim, wallet, "pre");
  const post = sumOurs(sim, wallet, "post");
  const mints = new Set([...pre.keys(), ...post.keys()]);
  const delta = (m: string): bigint => (post.get(m) ?? 0n) - (pre.get(m) ?? 0n);
  if (p.inputMint !== WSOL_MINT) {
    const decrease = -delta(p.inputMint);
    if (decrease > p.requestedInRaw) refuse("d", `input decreases by ${decrease}, more than the requested ${p.requestedInRaw}`);
  }
  if (p.inputMint === USDC_MINT && (p.requestedInRaw > p.hardMaxUsdcRaw || -delta(USDC_MINT) > p.hardMaxUsdcRaw)) {
    refuse("d", "USDC input exceeds HARD_MAX_POSITION_USD in raw units");
  }
  if (p.outputMint !== WSOL_MINT) {
    const increase = delta(p.outputMint);
    if (increase < p.minOutRaw) refuse("e", `output increases by ${increase}, below the minimum ${p.minOutRaw}`);
  }
  for (const m of mints) {
    if (m === p.inputMint || m === p.outputMint) continue;
    if (delta(m) !== 0n) refuse("f", `an unexpected balance change of ${delta(m)} in mint ${m}`);
  }
  // ---- g: SOL ----
  const w = sim.lamports.get(wallet);
  if (!w) refuse("shape", "no lamport balances for the wallet");
  const walletDelta = w.post - w.pre;
  let rentNew = 0n;
  let rentReclaimed = 0n;
  for (const [addr, l] of sim.lamports) {
    const t = sim.tokens.get(addr);
    if (l.pre === 0n && l.post > 0n && t?.post?.owner === wallet) rentNew += l.post;
    if (l.pre > 0n && l.post === 0n && t?.pre?.owner === wallet) rentReclaimed += l.pre;
  }
  const solIn = p.inputMint === WSOL_MINT ? p.requestedInRaw : 0n;
  const minOutSol = p.outputMint === WSOL_MINT ? p.minOutRaw : 0n;
  const floor = minOutSol + rentReclaimed - fee - rentNew - solIn;
  if (walletDelta < floor) {
    refuse("g", `wallet SOL changes by ${walletDelta} lamports, below the allowed ${floor} (fees ${fee}, new rent ${rentNew}, reclaimed ${rentReclaimed}, SOL in ${solIn}, SOL min out ${minOutSol})`);
  }

  // ---- i + j: post-state of our token accounts ----
  for (const [addr, e] of sim.tokens) {
    const s: TokenAccountState | null = e.post;
    if (!s || s.owner !== wallet) continue;
    if (!allowedMints.has(s.mint)) refuse("j", `we would hold a token account for unexpected mint ${s.mint}`);
    const parsed = sim.postTokenAccounts.get(addr);
    if (!parsed) refuse("shape", `no parsed post-state for our token account ${addr}`);
    if (parsed.owner !== wallet) refuse("i", `token account ${addr} is owned by ${parsed.owner} after the transaction`);
    if (parsed.delegate !== null) refuse("i", `token account ${addr} has a delegate after the transaction`);
    if (parsed.closeAuthority !== null) refuse("i", `token account ${addr} has a close authority after the transaction`);
  }

  return { ok: true, priorityFeeLamports: priority, cuLimit, source: sim.source };
}
