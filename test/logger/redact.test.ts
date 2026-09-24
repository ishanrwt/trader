import { describe, expect, it } from "vitest";
import { createScrubber } from "../../src/logger/redact.js";

describe("createScrubber", () => {
  const secrets = ["s3cr3t-api-key", "https://rpc.example.com/?api-key=abc123"];
  const { scrub, scrubString } = createScrubber(secrets);

  it("redacts a secret that is the whole string", () => {
    expect(scrubString("s3cr3t-api-key")).toBe("[REDACTED]");
  });

  it("redacts a secret embedded inside a longer string", () => {
    const url = "https://api.telegram.org/bots3cr3t-api-key/sendMessage";
    expect(scrubString(url)).toBe("https://api.telegram.org/bot[REDACTED]/sendMessage");
  });

  it("redacts the full RPC URL, not just the api-key parameter", () => {
    const msg = "RPC request to https://rpc.example.com/?api-key=abc123 failed";
    expect(scrubString(msg)).toBe("RPC request to [REDACTED] failed");
  });

  it("redacts secrets inside nested objects and arrays", () => {
    const out = scrub({
      url: "https://rpc.example.com/?api-key=abc123",
      nested: { list: ["s3cr3t-api-key", "fine"] },
    });
    expect(out).toEqual({
      url: "[REDACTED]",
      nested: { list: ["[REDACTED]", "fine"] },
    });
  });

  it("redacts secrets inside an Error's message and stack", () => {
    const err = new Error("failed calling https://rpc.example.com/?api-key=abc123");
    err.stack = `Error: failed calling https://rpc.example.com/?api-key=abc123\n    at x`;
    const out = scrub(err) as Error;
    expect(out.message).not.toContain("abc123");
    expect(out.stack).not.toContain("abc123");
  });

  it("handles circular objects without throwing", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => scrub(obj)).not.toThrow();
  });

  it("leaves non-secret content untouched", () => {
    expect(scrubString("nothing sensitive here")).toBe("nothing sensitive here");
  });
});
