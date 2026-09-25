/**
 * Scrubs configured secret values out of anything about to be logged. Secrets
 * are redacted as exact substrings wherever they appear — inside a full URL,
 * an error message, a stack trace — not just when they're the whole string,
 * per SPEC.md section 1: "redact keys in logs and error messages, including
 * the api-key query parameter inside SOLANA_RPC_URL."
 *
 * Phase 3 (section 16.9) adds regex patterns (the wallet key as decimal or hex
 * byte sequences with arbitrary separators) and never prints raw byte arrays.
 * Redactions can be added after creation (`add`), so the wallet key's
 * encodings are registered before the first log line without the logger ever
 * holding the key itself.
 */
export function createScrubber(secrets: readonly string[], initialPatterns: readonly RegExp[] = []) {
  const values = new Set(secrets.filter((s) => s.length > 0));
  const patterns: RegExp[] = [...initialPatterns];
  // Longest first, so a secret that contains another shorter one is removed whole.
  let ordered = [...values].sort((a, b) => b.length - a.length);

  function scrubString(input: string): string {
    let out = input;
    for (const secret of ordered) {
      out = out.split(secret).join("[REDACTED]");
    }
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, "[REDACTED]");
    }
    return out;
  }

  function scrub(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
    if (typeof value === "string") {
      return scrubString(value);
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return "[bytes]";
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

  function add(more: { literals?: readonly string[]; patterns?: readonly RegExp[] }): void {
    for (const s of more.literals ?? []) if (s.length > 0) values.add(s);
    for (const p of more.patterns ?? []) patterns.push(p);
    ordered = [...values].sort((a, b) => b.length - a.length);
  }

  return { scrub, scrubString, add };
}
