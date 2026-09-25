import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { base58Encode } from "../../src/encoding/base58.js";
import { secretKeyRedactions } from "../../src/encoding/secretKey.js";
import { createMemoryLogger } from "../../src/logger/index.js";
import { makeTestSecretKey } from "../helpers/keypair.js";

/**
 * SPEC.md section 16.9 / A6: the wallet key never appears in log output, in
 * any encoding, for either the full 64-byte key or its 32-byte private half.
 */
describe("wallet key redaction in log output", () => {
  const { secretKey } = makeTestSecretKey();
  const privateHalf = secretKey.subarray(0, 32);

  function encodings(bytes: Uint8Array): Record<string, string> {
    const buf = Buffer.from(bytes);
    const hex = buf.toString("hex");
    return {
      base58: base58Encode(bytes),
      base64: buf.toString("base64"),
      base64NoPad: buf.toString("base64").replace(/=+$/, ""),
      base64url: buf.toString("base64url"),
      hexLower: hex,
      hexUpper: hex.toUpperCase(),
      hexSpaced: hex.match(/../g)!.join(" "),
      hexColon: hex.match(/../g)!.join(":").toUpperCase(),
      bufferInspect: inspect(Buffer.from(bytes), { maxArrayLength: 1000 }),
      jsonCompact: JSON.stringify([...bytes]),
      jsonPretty: JSON.stringify([...bytes], null, 2),
      jsonSpaced: `[ ${[...bytes].join(", ")} ]`,
      commaList: [...bytes].join(","),
      uint8ToString: new Uint8Array(bytes).toString(),
      spaceList: [...bytes].join(" "),
    };
  }

  // The fragments that must never survive: every full-length encoding of the private half.
  const forbidden = Object.values(encodings(privateHalf)).filter((s) => !s.startsWith("<Buffer"));
  forbidden.push(base58Encode(secretKey));

  function allOutput(logger: ReturnType<typeof createMemoryLogger>): string {
    return logger.entries
      .map((e) => `${e.msg} ${JSON.stringify(e.meta, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v))}`)
      .join("\n");
  }

  for (const [label, bytes] of [
    ["64-byte key", secretKey],
    ["32-byte private half", privateHalf],
  ] as const) {
    for (const [name, text] of Object.entries(encodings(bytes))) {
      it(`${label} as ${name} is scrubbed from messages, metadata, errors and stack traces`, () => {
        const r = secretKeyRedactions(secretKey);
        const logger = createMemoryLogger([], r.patterns);
        logger.addRedactions({ literals: r.literals });

        const err = new Error(`boom: ${text}`);
        err.stack = `Error: boom: ${text}\n    at somewhere (file.ts:1:1)`;
        logger.error(`failed with ${text}`, { detail: text, nested: { list: [text] }, error: err, errorText: String(err) });

        const out = allOutput(logger);
        for (const fragment of forbidden) expect(out).not.toContain(fragment);
      });
    }
  }

  it("never prints raw byte arrays in metadata (Uint8Array or Buffer)", () => {
    const logger = createMemoryLogger();
    logger.info("bytes", { a: new Uint8Array(secretKey), b: Buffer.from(privateHalf) });
    expect(logger.entries[0]!.meta).toEqual({ a: "[bytes]", b: "[bytes]" });
  });

  it("scrubText and scrubValue apply the same redaction (used for Telegram and fatal handlers)", () => {
    const r = secretKeyRedactions(secretKey);
    const logger = createMemoryLogger([], r.patterns);
    logger.addRedactions({ literals: r.literals });
    const b58 = base58Encode(secretKey);
    expect(logger.scrubText(`key=${b58}`)).toBe("key=[REDACTED]");
    expect(JSON.stringify(logger.scrubValue({ k: [...privateHalf].join(",") }))).not.toContain([...privateHalf].join(","));
  });

  it("does not redact unrelated numbers or text", () => {
    const r = secretKeyRedactions(secretKey);
    const logger = createMemoryLogger([], r.patterns);
    logger.info("position 12 closed at 1,234 with 5 retries");
    expect(logger.entries[0]!.msg).toBe("position 12 closed at 1,234 with 5 retries");
  });
});
