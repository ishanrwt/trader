import { describe, expect, it, vi } from "vitest";
import type { TelegramUpdate } from "../../src/clients/telegram.js";
import {
  CONSECUTIVE_ERRORS_KEY,
  KILLED_VIA_COMMAND_KEY,
  PAUSED_KEY,
  pollAndHandleCommands,
  type CommandsTelegram,
} from "../../src/notify/commands.js";
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
      buildReport: () => "REPORT TEXT",
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
      buildReport: () => "REPORT TEXT",
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
      buildReport: () => "REPORT TEXT",
      logger: createMemoryLogger(),
    });
    expect(store.get(PAUSED_KEY, true)).toBe(false);
    expect(telegram.sent).toEqual(["Entries resumed. (If a KILL file is present, delete it too.)"]);
  });

  it("/resume also clears error halts and the kill switch (but not the daily-loss halt, which has no command)", async () => {
    const telegram = fakeTelegram([
      { update_id: 1, message: { message_id: 1, chat: { id: "chat1" }, text: "/resume", date: 0 } },
    ]);
    const store = new StateStore(openDb(":memory:"));
    store.set(CONSECUTIVE_ERRORS_KEY, 5);
    store.set(KILLED_VIA_COMMAND_KEY, true);
    await pollAndHandleCommands({
      telegram,
      stateStore: store,
      offset: 0,
      timeoutSec: 1,
      buildDigest: () => "",
      buildReport: () => "",
      logger: createMemoryLogger(),
    });
    expect(store.get(CONSECUTIVE_ERRORS_KEY, -1)).toBe(0);
    expect(store.get(KILLED_VIA_COMMAND_KEY, true)).toBe(false);
  });

  it("responds to /report with the report", async () => {
    const telegram = fakeTelegram([
      { update_id: 1, message: { message_id: 1, chat: { id: "chat1" }, text: "/report", date: 0 } },
    ]);
    const store = new StateStore(openDb(":memory:"));
    await pollAndHandleCommands({
      telegram,
      stateStore: store,
      offset: 0,
      timeoutSec: 1,
      buildDigest: () => "",
      buildReport: () => "REPORT TEXT",
      logger: createMemoryLogger(),
    });
    expect(telegram.sent).toEqual(["REPORT TEXT"]);
  });

  it("records pause/resume/killswitch to the audit trail via recordEvent", async () => {
    const recordEvent = vi.fn();
    const store = new StateStore(openDb(":memory:"));
    const baseCtx = {
      stateStore: store,
      offset: 0,
      timeoutSec: 1,
      buildDigest: () => "",
      buildReport: () => "",
      logger: createMemoryLogger(),
      recordEvent,
    };

    await pollAndHandleCommands({
      telegram: fakeTelegram([{ update_id: 1, message: { message_id: 1, chat: { id: "chat1" }, text: "/pause", date: 0 } }]),
      ...baseCtx,
    });
    await pollAndHandleCommands({
      telegram: fakeTelegram([{ update_id: 2, message: { message_id: 2, chat: { id: "chat1" }, text: "/resume", date: 0 } }]),
      ...baseCtx,
    });
    await pollAndHandleCommands({
      telegram: fakeTelegram([{ update_id: 3, message: { message_id: 3, chat: { id: "chat1" }, text: "/killswitch", date: 0 } }]),
      ...baseCtx,
    });

    expect(recordEvent).toHaveBeenCalledWith("pause", expect.any(String));
    expect(recordEvent).toHaveBeenCalledWith("resume", expect.any(String));
    expect(recordEvent).toHaveBeenCalledWith("killswitch", expect.any(String));
  });

  it("/killswitch sets the kill flag and acknowledges", async () => {
    const telegram = fakeTelegram([
      { update_id: 1, message: { message_id: 1, chat: { id: "chat1" }, text: "/killswitch", date: 0 } },
    ]);
    const store = new StateStore(openDb(":memory:"));
    await pollAndHandleCommands({
      telegram,
      stateStore: store,
      offset: 0,
      timeoutSec: 1,
      buildDigest: () => "",
      buildReport: () => "",
      logger: createMemoryLogger(),
    });
    expect(store.get(KILLED_VIA_COMMAND_KEY, false)).toBe(true);
    expect(telegram.sent[0]).toContain("Kill switch activated");
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
      buildReport: () => "REPORT TEXT",
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
      buildReport: () => "REPORT TEXT",
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
      buildReport: () => "REPORT TEXT",
      logger: createMemoryLogger(),
    });
    expect(result.nextOffset).toBe(6);
  });
});
