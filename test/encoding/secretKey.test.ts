import { describe, expect, it } from "vitest";
import { base58Decode, base58Encode } from "../../src/encoding/base58.js";
import { decodeSecretKey, SecretKeyFormatError } from "../../src/encoding/secretKey.js";
import { makeTestSecretKey } from "../helpers/keypair.js";

describe("base58", () => {
  it("round-trips arbitrary bytes, including leading zeros", () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 255, 128, 7]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });

  it("decodes the USDC mint to 32 bytes and re-encodes it identically", () => {
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const bytes = base58Decode(usdc)!;
    expect(bytes).toHaveLength(32);
    expect(base58Encode(bytes)).toBe(usdc);
  });

  it("returns null on a character outside the alphabet", () => {
    expect(base58Decode("0OIl")).toBeNull();
  });
});

describe("decodeSecretKey", () => {
  const { secretKey, base58, json } = makeTestSecretKey();

  it("accepts a base58 64-byte key (Phantom/Solflare export)", () => {
    expect(decodeSecretKey(base58)).toEqual(secretKey);
  });

  it("accepts a JSON array of 64 numbers (solana-keygen file), with any whitespace", () => {
    expect(decodeSecretKey(json)).toEqual(secretKey);
    expect(decodeSecretKey(`  [ ${[...secretKey].join(" ,\n ")} ]  `)).toEqual(secretKey);
  });

  it("rejects wrong lengths and bad values without ever echoing the input", () => {
    const cases = [base58.slice(0, 40), JSON.stringify([...secretKey].slice(0, 63)), JSON.stringify([...secretKey.slice(0, 63), 256]), "[1,2,", "not base58 0OIl"];
    for (const input of cases) {
      let caught: unknown;
      try {
        decodeSecretKey(input);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SecretKeyFormatError);
      expect((caught as Error).message).not.toContain(input);
      expect(String((caught as Error).stack)).not.toContain(input);
    }
  });
});
