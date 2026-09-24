import { describe, expect, it, vi } from "vitest";
import { TelegramClient } from "../../src/clients/telegram.js";
import { createMemoryLogger } from "../../src/logger/index.js";

const BOT_TOKEN = "123456789:AAExampleTelegramBotToken";
const CHAT_ID = "-1009876543210";

function makeClient(fetchImpl: ReturnType<typeof vi.fn>, logger = createMemoryLogger([BOT_TOKEN])) {
  return {
    client: new TelegramClient({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
    }),
    logger,
  };
}

describe("TelegramClient", () => {
  it("sends a message to the configured chat", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const { client } = makeClient(fetchImpl);
    await client.sendMessage("hello");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: CHAT_ID, text: "hello" });
  });

  it("swallows sendMessage failures instead of throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const { client } = makeClient(fetchImpl);
    await expect(client.sendMessage("hello")).resolves.toBeUndefined();
  });

  it("a failed Telegram sendMessage request logs no secrets, even though the bot token is in the URL", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`fetch failed for https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`));
    const { client, logger } = makeClient(fetchImpl);

    await client.sendMessage("hello");

    expect(logger.entries.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(logger.entries);
    expect(serialized).not.toContain(BOT_TOKEN);
    expect(serialized).toContain("[REDACTED]");
  });

  it("a failed Telegram getUpdates request logs no secrets and returns an empty array", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`timeout on https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`));
    const { client, logger } = makeClient(fetchImpl);

    const updates = await client.getUpdates(0, 1);
    expect(updates).toEqual([]);

    const serialized = JSON.stringify(logger.entries);
    expect(serialized).not.toContain(BOT_TOKEN);
  });

  it("isFromConfiguredChat filters to the configured chat only", () => {
    const { client } = makeClient(vi.fn());
    expect(client.isFromConfiguredChat({ update_id: 1, message: { message_id: 1, chat: { id: CHAT_ID }, date: 0 } })).toBe(
      true,
    );
    expect(
      client.isFromConfiguredChat({ update_id: 2, message: { message_id: 2, chat: { id: "999999" }, date: 0 } }),
    ).toBe(false);
    expect(client.isFromConfiguredChat({ update_id: 3 })).toBe(false);
  });
});
