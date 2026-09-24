import { describe, expect, it, vi } from "vitest";
import type { TelegramUpdate } from "../../src/clients/telegram.js";
import { PAUSED_KEY, pollAndHandleCommands, type CommandsTelegram } from "../../src/notify/commands.js";
import { createMemoryLogger } from "../../src/logger/index.js";
import { openDb } from "../../src/storage/db.js";
import { StateStore } from "../../src/storage/state.js";

function fakeTelegram(updates: TelegramUpdate[]): CommandsTelegram & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    getUpdates: vi.fn().mockResolvedValue(updates),
    isFromConfiguredChat: (update) => update.message?.chat?.id === "chat1",
    sendMessage: vi.fn(async (text: string) => {
      sent.push(text);
    }),
  };
}

describe("pollAndHandleCommands", () => {
  it("responds to /status with the digest", async () => {
    const telegram = fakeTelegram([
      { update_id: 1, message: { message_id: 1, chat: { id: "chat1" }, text: "/status", date: 0 } },
    ]);
    const store = new StateStore(openDb(":memory:"));
    const result = await pollAndHandleCommands({
      telegram,
      stateStore: store,
      offset: 0,
      timeoutSec: 1,
      buildDigest: () => "DIGEST TEXT",
      logger: createMemoryLogger(),
    });
    expect(telegram.sent).toEqual(["DIGEST TEXT"]);
    expect(result.nextOffset).toBe(2);
  });

  it("/pause sets the paused flag and acknowledges", async () => {
    const telegram = fakeTelegram([
      { update_id: 1, message: { message_id: 1, chat: { id: "chat1" }, text: "/pause", date: 0 } },
    ]);
    const store = new StateStore(openDb(":memory:"));
    await pollAndHandleCommands({
      telegram,
      stateStore: store,
      offset: 0,
      timeoutSec: 1,
      buildDigest: () => "",
      logger: createMemoryLogger(),
    });
    expect(store.get(PAUSED_KEY, false)).toBe(true);
    expect(telegram.sent).toEqual(["Entries paused."]);
  });

  it("/resume clears the paused flag and acknowledges", async () => {
    const telegram = fakeTelegram([
      { update_id: 1, message: { message_id: 1, chat: { id: "chat1" }, text: "/resume", date: 0 } },
    ]);
    const store = new StateStore(openDb(":memory:"));
    store.set(PAUSED_KEY, true);
    await pollAndHandleCommands({
      telegram,
      stateStore: store,
      offset: 0,
      timeoutSec: 1,
      buildDigest: () => "",
      logger: createMemoryLogger(),
    });
    expect(store.get(PAUSED_KEY, true)).toBe(false);
    expect(telegram.sent).toEqual(["Entries resumed."]);
  });

  it("ignores commands from a chat other than the configured one", async () => {
    const telegram = fakeTelegram([
      { update_id: 1, message: { message_id: 1, chat: { id: "someone-else" }, text: "/pause", date: 0 } },
    ]);
    const store = new StateStore(openDb(":memory:"));
    await pollAndHandleCommands({
      telegram,
      stateStore: store,
      offset: 0,
      timeoutSec: 1,
      buildDigest: () => "",
      logger: createMemoryLogger(),
    });
    expect(store.get(PAUSED_KEY, false)).toBe(false);
    expect(telegram.sent).toEqual([]);
  });

  it("silently ignores unknown commands", async () => {
    const telegram = fakeTelegram([
      { update_id: 1, message: { message_id: 1, chat: { id: "chat1" }, text: "/bogus", date: 0 } },
    ]);
    const store = new StateStore(openDb(":memory:"));
    await pollAndHandleCommands({
      telegram,
      stateStore: store,
      offset: 0,
      timeoutSec: 1,
      buildDigest: () => "",
      logger: createMemoryLogger(),
    });
    expect(telegram.sent).toEqual([]);
  });

  it("advances the offset past the highest update_id even when nothing matches", async () => {
    const telegram = fakeTelegram([
      { update_id: 5, message: { message_id: 1, chat: { id: "someone-else" }, text: "/pause", date: 0 } },
    ]);
    const store = new StateStore(openDb(":memory:"));
    const result = await pollAndHandleCommands({
      telegram,
      stateStore: store,
      offset: 0,
      timeoutSec: 1,
      buildDigest: () => "",
      logger: createMemoryLogger(),
    });
    expect(result.nextOffset).toBe(6);
  });
});
