import { generateKeyPairSync } from "node:crypto";
import { base58Encode } from "../../src/encoding/base58.js";

/** A real Ed25519 key pair as the 64-byte Solana secret key (private half || public half) plus its base58 address. */
export function makeTestSecretKey(): { secretKey: Uint8Array; address: string; base58: string; json: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const priv = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const secretKey = new Uint8Array(64);
  secretKey.set(priv, 0);
  secretKey.set(pub, 32);
  return { secretKey, address: base58Encode(pub), base58: base58Encode(secretKey), json: JSON.stringify([...secretKey]) };
}
