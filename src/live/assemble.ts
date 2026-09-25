import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type AddressesByLookupTableAddress,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  type Transaction,
  type TransactionSigner,
} from "@solana/kit";
import { findAssociatedTokenPda, getCloseAccountInstruction } from "@solana-program/token";
import type { JupiterApiInstruction, JupiterBuildResponse } from "../clients/jupiter.js";
import { encodeSetComputeUnitLimit, encodeSetComputeUnitPrice, decodeComputeBudget } from "./instructions.js";
import { assertKnownTokenProgram, COMPUTE_BUDGET_PROGRAM } from "./programs.js";
import type { DecodedTransaction } from "./verify.js";

export const CU_LIMIT_MAX = 1_400_000;

/** A Jupiter API instruction (base58 addresses, base64 data) as a kit Instruction. Fails closed on a malformed one. */
export function apiInstruction(ix: JupiterApiInstruction): Instruction {
  if (!ix || typeof ix.programId !== "string" || !Array.isArray(ix.accounts) || typeof ix.data !== "string") {
    throw new Error("Malformed instruction in the Jupiter response");
  }
  return {
    programAddress: address(ix.programId),
    accounts: ix.accounts.map((a) => ({
      address: address(a.pubkey),
      role: a.isSigner ? (a.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
    data: new Uint8Array(Buffer.from(ix.data, "base64")),
  };
}

export function computeBudgetInstructions(cuLimit: number, microLamports: bigint): Instruction[] {
  return [
    { programAddress: address(COMPUTE_BUDGET_PROGRAM), data: encodeSetComputeUnitLimit(cuLimit) },
    { programAddress: address(COMPUTE_BUDGET_PROGRAM), data: encodeSetComputeUnitPrice(microLamports) },
  ];
}

/** Jupiter's own setComputeUnitPrice (SPEC.md section 16.2 step 2). Fails closed if it's missing, duplicated, or anything else is in there. */
export function jupiterCuPrice(build: Pick<JupiterBuildResponse, "computeBudgetInstructions">): bigint {
  const list = build.computeBudgetInstructions;
  if (!Array.isArray(list)) throw new Error("computeBudgetInstructions is missing from the Jupiter response");
  let price: bigint | null = null;
  for (const ix of list) {
    if (ix.programId !== COMPUTE_BUDGET_PROGRAM) throw new Error("computeBudgetInstructions contains a non-compute-budget instruction");
    const d = decodeComputeBudget(new Uint8Array(Buffer.from(ix.data, "base64")));
    if (d.kind !== "price" || price !== null) throw new Error("computeBudgetInstructions must contain exactly one setComputeUnitPrice");
    price = d.microLamports;
  }
  if (price === null) throw new Error("computeBudgetInstructions has no setComputeUnitPrice");
  return price;
}

/**
 * closeAccount for our (now empty) token account, built for the mint's OWN
 * token program (SPEC.md section 16.6, A3): Token and Token-2022 share the
 * instruction layout (discriminator 9; account, destination, owner), so the
 * Token program's builder is used with the program address set explicitly.
 */
export function closeTokenAccountInstruction(account: string, owner: TransactionSigner, tokenProgram: string): Instruction {
  assertKnownTokenProgram(tokenProgram);
  return getCloseAccountInstruction(
    { account: address(account), destination: owner.address, owner },
    { programAddress: address(tokenProgram) },
  ) as Instruction;
}

export async function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): Promise<string> {
  assertKnownTokenProgram(tokenProgram);
  const [pda] = await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: address(tokenProgram) });
  return pda;
}

export function lookupTables(raw: Record<string, string[]> | null | undefined): AddressesByLookupTableAddress {
  if (!raw) return {};
  if (typeof raw !== "object") throw new Error("addressesByLookupTableAddress is malformed");
  return Object.fromEntries(Object.entries(raw).map(([k, list]) => [address(k), list.map((a) => address(a))]));
}

export function blockhashOf(build: Pick<JupiterBuildResponse, "blockhashWithMetadata">): { blockhash: Blockhash; lastValidBlockHeight: bigint } {
  const meta = build.blockhashWithMetadata;
  if (!meta || !Array.isArray(meta.blockhash) || meta.blockhash.length !== 32 || typeof meta.lastValidBlockHeight !== "number") {
    throw new Error("blockhashWithMetadata is missing or malformed");
  }
  return { blockhash: getBase58Decoder().decode(Uint8Array.from(meta.blockhash)) as Blockhash, lastValidBlockHeight: BigInt(meta.lastValidBlockHeight) };
}

/** A v0 transaction: fee payer = our wallet; lookup tables from Jupiter's response (no RPC fetch). */
export function compileV0(
  instructions: readonly Instruction[],
  feePayer: string,
  lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint },
  alts: AddressesByLookupTableAddress,
): Transaction {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => compressTransactionMessageUsingAddressLookupTables(m, alts),
  );
  return compileTransaction(message);
}

export async function signWith(signer: KeyPairSigner, tx: Transaction): Promise<Transaction> {
  return signTransaction([signer.keyPair], tx);
}

export function wireBase64(tx: Transaction): string {
  return getBase64EncodedWireTransaction(tx);
}

export function signatureOf(tx: Transaction): string {
  return getSignatureFromTransaction(tx);
}

/**
 * Decodes the exact bytes that will be sent, resolving lookup-table accounts,
 * into what the verifier checks (SPEC.md section 16.2: "the bytes sent are the
 * bytes verified"). Also returns the full ordered account-key list (static,
 * then lookup writable, then lookup readonly) that the simulation's balance
 * arrays are indexed by, and the writable accounts to request post-state for.
 */
export function decodeForVerification(tx: Transaction, alts: AddressesByLookupTableAddress): { decoded: DecodedTransaction; accountKeys: string[]; writable: string[] } {
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as {
    header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number };
    staticAccounts: string[];
    addressTableLookups?: Array<{ lookupTableAddress: string; writableIndexes: readonly number[]; readonlyIndexes: readonly number[] }>;
    instructions: Array<{ programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }>;
  };
  const { header, staticAccounts } = compiled;
  const loadedWritable: string[] = [];
  const loadedReadonly: string[] = [];
  for (const l of compiled.addressTableLookups ?? []) {
    const table = alts[l.lookupTableAddress as keyof AddressesByLookupTableAddress] as string[] | undefined;
    if (!table) throw new Error(`lookup table ${l.lookupTableAddress} is not in the Jupiter response`);
    for (const i of l.writableIndexes) loadedWritable.push(resolveIndex(table, i));
    for (const i of l.readonlyIndexes) loadedReadonly.push(resolveIndex(table, i));
  }
  const keys = [...staticAccounts, ...loadedWritable, ...loadedReadonly];
  const n = staticAccounts.length;
  const isSigner = (i: number) => i < header.numSignerAccounts;
  const isWritable = (i: number) =>
    i < n
      ? isSigner(i)
        ? i < header.numSignerAccounts - header.numReadonlySignerAccounts
        : i < n - header.numReadonlyNonSignerAccounts
      : i < n + loadedWritable.length;

  const instructions = compiled.instructions.map((ci) => {
    const programId = keys[ci.programAddressIndex];
    if (!programId) throw new Error("compiled instruction references an unknown program index");
    return {
      programId,
      accounts: (ci.accountIndices ?? []).map((i) => {
        const a = keys[i];
        if (!a) throw new Error("compiled instruction references an unknown account index");
        return { address: a, signer: isSigner(i), writable: isWritable(i) };
      }),
      data: new Uint8Array(ci.data ?? new Uint8Array()),
    };
  });
  return {
    decoded: { feePayer: staticAccounts[0]!, signers: staticAccounts.slice(0, header.numSignerAccounts), instructions },
    accountKeys: keys,
    writable: keys.filter((_k, i) => isWritable(i)),
  };
}

function resolveIndex(table: readonly string[], i: number): string {
  const a = table[i];
  if (!a) throw new Error("lookup-table index out of range");
  return a;
}

/** Every instruction a /build response carries, in the documented order (common-instructions page). */
export function jupiterInstructions(build: JupiterBuildResponse): { setup: Instruction[]; swap: Instruction; cleanup: Instruction[]; other: Instruction[] } {
  if (!Array.isArray(build.setupInstructions) || !Array.isArray(build.otherInstructions) || !build.swapInstruction) {
    throw new Error("The Jupiter response is missing instructions");
  }
  return {
    setup: build.setupInstructions.map(apiInstruction),
    swap: apiInstruction(build.swapInstruction),
    cleanup: build.cleanupInstruction ? [apiInstruction(build.cleanupInstruction)] : [],
    other: build.otherInstructions.map(apiInstruction),
  };
}
