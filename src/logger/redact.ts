/**
 * Scrubs configured secret values out of anything about to be logged. Secrets
 * are redacted as exact substrings wherever they appear — inside a full URL,
 * an error message, a stack trace — not just when they're the whole string,
 * per SPEC.md section 1: "redact keys in logs and error messages, including
 * the api-key query parameter inside SOLANA_RPC_URL."
 */
export function createScrubber(secrets: readonly string[]) {
  const values = [...new Set(secrets.filter((s) => s.length > 0))];

  function scrubString(input: string): string {
    let out = input;
    for (const secret of values) {
      out = out.split(secret).join("[REDACTED]");
    }
    return out;
  }

  function scrub(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
    if (typeof value === "string") {
      return scrubString(value);
    }
    if (value instanceof Error) {
      const scrubbed = new Error(scrubString(value.message));
      scrubbed.name = value.name;
      if (value.stack) scrubbed.stack = scrubString(value.stack);
      return scrubbed;
    }
    if (Array.isArray(value)) {
      return value.map((item) => scrub(item, seen));
    }
    if (value && typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        out[key] = scrub(val, seen);
      }
      return out;
    }
    return value;
  }

  return { scrub, scrubString };
}
