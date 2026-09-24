import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../../src/logger/index.js";

describe("createMemoryLogger", () => {
  it("redacts secrets from both the message and the meta object", () => {
    const logger = createMemoryLogger(["botTOKEN123", "https://rpc.example.com/?api-key=abc123"]);
    logger.error("Telegram request to https://api.telegram.org/botTOKEN123/sendMessage failed", {
      url: "https://rpc.example.com/?api-key=abc123",
    });

    expect(logger.entries).toHaveLength(1);
    const [entry] = logger.entries;
    expect(entry!.msg).not.toContain("botTOKEN123");
    expect(entry!.meta?.url).toBe("[REDACTED]");
  });

  it("records entries with no meta", () => {
    const logger = createMemoryLogger();
    logger.info("started");
    expect(logger.entries).toEqual([{ level: "info", msg: "started", meta: undefined }]);
  });
});
