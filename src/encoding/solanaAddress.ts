import { createHash } from "node:crypto";

/**
 * Read-only Solana address helpers for data collection (SPEC.md section 11.6):
 * base58 coding of 32-byte addresses and program-derived address (PDA)
 * derivation. No keys, no signing: this only hashes public inputs. It exists so
 * code outside src/live/ never needs the signing library (SPEC.md section 1;
 * test/safety/noSendPath.test.ts). Tests cross-check it against the live-only library.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode32(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 character in address: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n !== 0n) throw new Error("address is longer than 32 bytes");
  return out;
}

// Ed25519 point decompression, only to tell whether 32 bytes are a curve point.
const P = 2n ** 255n - 19n;
const D = (((-121665n * modInv(121666n)) % P) + P) % P;
const SQRT_M1 = modPow(2n, (P - 1n) / 4n, P);

function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
function modInv(a: bigint): bigint {
  return modPow(((a % P) + P) % P, P - 2n, P);
}

/** True if the 32 bytes decode to a point on the Ed25519 curve (PDAs must not). */
export function isOnCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i]! & 0x7f : bytes[i]!);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const v3 = (v * v * v) % P;
  const v7 = (v3 * v3 * v) % P;
  let x = (u * v3 * modPow((u * v7) % P, (P - 5n) / 8n, P)) % P;
  const vx2 = (v * x * x) % P;
  if (vx2 === u) return true;
  if (vx2 === (P - u) % P) {
    x = (x * SQRT_M1) % P;
    return true;
  }
  return false;
}

/** findProgramAddress: the first bump from 255 down whose hash is off the curve. */
export function findProgramAddress(seeds: readonly Uint8Array[], programId: string): { address: string; bump: number } {
  const program = base58Decode32(programId);
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(program);
    h.update(marker);
    const candidate = new Uint8Array(h.digest());
    if (!isOnCurve(candidate)) return { address: base58Encode(candidate), bump };
  }
  throw new Error("no viable program address bump");
}
