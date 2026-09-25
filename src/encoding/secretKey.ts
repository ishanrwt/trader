import { base58Decode, base58Encode } from "./base58.js";

export const SECRET_KEY_LENGTH = 64;
export const PRIVATE_HALF_LENGTH = 32;

/** Never carries the input value, in its message or anywhere else (SPEC.md section 16.9). */
export class SecretKeyFormatError extends Error {
  constructor(reason: string) {
    super(`WALLET_PRIVATE_KEY is not a valid key: ${reason}. Expected a base58 string of a 64-byte secret key, or a JSON array of 64 numbers.`);
    this.name = "SecretKeyFormatError";
  }
}

/**
 * Decodes WALLET_PRIVATE_KEY from either accepted format (SPEC.md section
 * 16.9): a base58 string of the 64-byte secret key (Phantom/Solflare export)
 * or a JSON array of 64 numbers (a solana-keygen key file). Checks shape only;
 * whether the public half matches the private half is checked when the signing
 * key is created (src/live/keys.ts). The caller must zero the result.
 */
export function decodeSecretKey(raw: string): Uint8Array {
  const text = raw.trim();
  if (text.length === 0) throw new SecretKeyFormatError("it is empty");

  if (text.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SecretKeyFormatError("it looks like a JSON array but doesn't parse");
    }
    if (!Array.isArray(parsed) || parsed.length !== SECRET_KEY_LENGTH) {
      throw new SecretKeyFormatError("the JSON array doesn't have exactly 64 entries");
    }
    const bytes = new Uint8Array(SECRET_KEY_LENGTH);
    for (let i = 0; i < SECRET_KEY_LENGTH; i++) {
      const v = parsed[i];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255) {
        bytes.fill(0);
        throw new SecretKeyFormatError("the JSON array contains something other than integers 0-255");
      }
      bytes[i] = v;
    }
    return bytes;
  }

  const decoded = base58Decode(text);
  if (decoded === null) throw new SecretKeyFormatError("it contains characters outside the base58 alphabet");
  if (decoded.length !== SECRET_KEY_LENGTH) {
    decoded.fill(0);
    throw new SecretKeyFormatError("it doesn't decode to exactly 64 bytes");
  }
  return decoded;
}

export interface Redactions {
  literals: string[];
  patterns: RegExp[];
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sequencePattern(tokens: string[], separator: string, flags: string): RegExp {
  // Lookarounds keep "12,34" from matching inside "112,345" and similar.
  return new RegExp(`(?<![0-9A-Za-z])${tokens.join(separator)}(?![0-9A-Za-z])`, flags);
}

/**
 * Every encoding of the 64-byte key and its 32-byte private half that could
 * plausibly end up in a log line, an error, a stack trace or a Telegram
 * message (SPEC.md section 16.9): base58, base64, base64url, hex (either case,
 * with or without separators), JSON arrays and comma-separated decimal bytes
 * (with any whitespace). Returned as data so the logger can register it
 * without ever holding the key bytes itself.
 */
export function secretKeyRedactions(secretKey: Uint8Array): Redactions {
  const privateHalf = secretKey.subarray(0, PRIVATE_HALF_LENGTH);
  const literals: string[] = [];
  const patterns: RegExp[] = [];
  for (const part of [secretKey, privateHalf]) {
    const buf = Buffer.from(part);
    literals.push(base58Encode(part));
    literals.push(buf.toString("base64"));
    literals.push(buf.toString("base64").replace(/=+$/, ""));
    literals.push(buf.toString("base64url"));
    const h = hex(part);
    literals.push(h, h.toUpperCase());
    const decimals = [...part].map((b) => String(b));
    patterns.push(sequencePattern(decimals, "(?:\\s*[,;]\\s*|\\s+)", "g"));
    const hexTokens = [...part].map((b) => b.toString(16).padStart(2, "0"));
    patterns.push(sequencePattern(hexTokens, "[\\s:,\\-]*", "gi"));
  }
  return { literals: [...new Set(literals)], patterns };
}
