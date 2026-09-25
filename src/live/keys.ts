import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { decodeSecretKey, secretKeyRedactions, SecretKeyFormatError, type Redactions } from "../encoding/secretKey.js";

export const WALLET_KEY_ENV = "WALLET_PRIVATE_KEY";

export interface LoadedWallet {
  signer: KeyPairSigner;
  address: string;
}

/**
 * SPEC.md section 16.9, step 1 of loading the key: compute every encoding the
 * logger must redact, BEFORE anything else can log. Called only in live mode
 * and by smoke-live. Returns data only; the decoded bytes are zeroed here.
 */
export function walletKeyRedactions(env: Record<string, string | undefined>): Redactions {
  const raw = env[WALLET_KEY_ENV] ?? "";
  const bytes = decodeSecretKey(raw);
  try {
    // The raw string exactly as typed (whitespace and all) is also scrubbed.
    const r = secretKeyRedactions(bytes);
    return { literals: [...r.literals, raw, raw.trim()], patterns: r.patterns };
  } finally {
    bytes.fill(0);
  }
}

/**
 * SPEC.md section 16.9, step 2: decode, import into a NON-extractable signing
 * key (kit verifies the public half matches the private half), zero the bytes,
 * and delete the variable from the environment so nothing later can read it.
 * Errors never carry the key.
 */
export async function loadWallet(env: Record<string, string | undefined>): Promise<LoadedWallet> {
  const raw = env[WALLET_KEY_ENV] ?? "";
  delete env[WALLET_KEY_ENV];
  const bytes = decodeSecretKey(raw);
  try {
    const signer = await createKeyPairSignerFromBytes(bytes, false);
    return { signer, address: signer.address };
  } catch (err) {
    if (err instanceof SecretKeyFormatError) throw err;
    // kit's own error could in principle describe the input; never forward it.
    throw new SecretKeyFormatError("its public half doesn't match its private half");
  } finally {
    bytes.fill(0);
  }
}
