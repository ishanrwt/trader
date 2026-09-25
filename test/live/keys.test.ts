import { describe, expect, it } from "vitest";
import { base58Encode } from "../../src/encoding/base58.js";
import { SecretKeyFormatError } from "../../src/encoding/secretKey.js";
import { loadWallet, walletKeyRedactions } from "../../src/live/keys.js";
import { makeTestSecretKey } from "../helpers/keypair.js";

describe("loadWallet", () => {
  it("loads a base58 key, derives the public address, and deletes the variable from the environment", async () => {
    const { base58, address } = makeTestSecretKey();
    const env: Record<string, string | undefined> = { WALLET_PRIVATE_KEY: base58 };
    const wallet = await loadWallet(env);
    expect(wallet.address).toBe(address);
    expect(env.WALLET_PRIVATE_KEY).toBeUndefined();
  });

  it("loads a JSON-array key to the same address", async () => {
    const { json, address } = makeTestSecretKey();
    expect((await loadWallet({ WALLET_PRIVATE_KEY: json })).address).toBe(address);
  });

  it("creates a non-extractable signing key", async () => {
    const { base58 } = makeTestSecretKey();
    const wallet = await loadWallet({ WALLET_PRIVATE_KEY: base58 });
    expect(wallet.signer.keyPair.privateKey.extractable).toBe(false);
  });

  it("refuses a key whose public half doesn't match its private half, without echoing it", async () => {
    const a = makeTestSecretKey();
    const b = makeTestSecretKey();
    const mixed = new Uint8Array(64);
    mixed.set(a.secretKey.subarray(0, 32), 0);
    mixed.set(b.secretKey.subarray(32), 32);
    const raw = base58Encode(mixed);
    await expect(loadWallet({ WALLET_PRIVATE_KEY: raw })).rejects.toBeInstanceOf(SecretKeyFormatError);
    await loadWallet({ WALLET_PRIVATE_KEY: raw }).catch((err: Error) => {
      expect(err.message).not.toContain(raw);
      expect(String(err.stack)).not.toContain(raw);
    });
  });
});

describe("walletKeyRedactions", () => {
  it("includes the raw value and its base58 form, and no bytes are returned", () => {
    const { base58 } = makeTestSecretKey();
    const r = walletKeyRedactions({ WALLET_PRIVATE_KEY: base58 });
    expect(r.literals).toContain(base58);
    expect(r.patterns.length).toBeGreaterThan(0);
  });
});
