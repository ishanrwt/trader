/**
 * Minimal, fail-closed decoders for the instructions a /build swap is allowed
 * to contain at top level (SPEC.md section 16.2 step 6), and encoders for the
 * compute-budget instructions the bot sets itself. Anything a decoder doesn't
 * recognise comes back as `unknown`, which the verifier refuses.
 */

export type ComputeBudgetIx = { kind: "limit"; units: number } | { kind: "price"; microLamports: bigint } | { kind: "unknown" };

export function decodeComputeBudget(data: Uint8Array): ComputeBudgetIx {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length === 5 && data[0] === 2) return { kind: "limit", units: view.getUint32(1, true) };
  if (data.length === 9 && data[0] === 3) return { kind: "price", microLamports: view.getBigUint64(1, true) };
  return { kind: "unknown" };
}

export function encodeSetComputeUnitLimit(units: number): Uint8Array {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return data;
}

export function encodeSetComputeUnitPrice(microLamports: bigint): Uint8Array {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return data;
}

/** priority fee (lamports) = ceil(price (micro-lamports per CU) x limit / 10^6), per Solana's fee structure. */
export function priorityFeeLamports(microLamportsPerCu: bigint, cuLimit: number): bigint {
  const total = microLamportsPerCu * BigInt(cuLimit);
  return (total + 999_999n) / 1_000_000n;
}

/** The highest CU price such that the priority fee stays within `maxLamports` at `cuLimit`. */
export function maxCuPriceFor(maxLamports: bigint, cuLimit: number): bigint {
  if (cuLimit <= 0) return 0n;
  return (maxLamports * 1_000_000n) / BigInt(cuLimit);
}

export type SystemIx =
  | { kind: "transfer"; lamports: bigint }
  | { kind: "createAccount"; lamports: bigint }
  | { kind: "assign" }
  | { kind: "allocate" }
  | { kind: "unknown" };

export function decodeSystem(data: Uint8Array): SystemIx {
  if (data.length < 4) return { kind: "unknown" };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = view.getUint32(0, true);
  if (tag === 2 && data.length === 12) return { kind: "transfer", lamports: view.getBigUint64(4, true) };
  if (tag === 0 && data.length === 52) return { kind: "createAccount", lamports: view.getBigUint64(4, true) };
  if (tag === 1 && data.length === 36) return { kind: "assign" };
  if (tag === 8 && data.length === 12) return { kind: "allocate" };
  return { kind: "unknown" };
}

export type TokenIx = { kind: "syncNative" } | { kind: "closeAccount" } | { kind: "unknown" };

/** Same layout under Token and Token-2022 for the two instructions a swap may use at top level. */
export function decodeToken(data: Uint8Array): TokenIx {
  if (data.length === 1 && data[0] === 17) return { kind: "syncNative" };
  if (data.length === 1 && data[0] === 9) return { kind: "closeAccount" };
  return { kind: "unknown" };
}

export type AtaIx = { kind: "create"; idempotent: boolean } | { kind: "unknown" };

export function decodeAta(data: Uint8Array): AtaIx {
  if (data.length === 0 || (data.length === 1 && data[0] === 0)) return { kind: "create", idempotent: false };
  if (data.length === 1 && data[0] === 1) return { kind: "create", idempotent: true };
  return { kind: "unknown" };
}
