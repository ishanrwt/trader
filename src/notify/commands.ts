import type { TelegramUpdate } from "../clients/telegram.js";
import type { Logger } from "../logger/index.js";
import type { StateStore } from "../storage/state.js";

export interface CommandsTelegram {
  getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]>;
  isFromConfiguredChat(update: TelegramUpdate): boolean;
  sendMessage(text: string): Promise<void>;
}

export const PAUSED_KEY = "paused";
export const PAUSE_REASON_KEY = "pauseReason";

/**
 * SPEC.md section 10: /status, /pause, /resume, restricted to the configured
 * chat. Unknown commands and messages from other chats are ignored silently.
 */
export async function pollAndHandleCommands(ctx: {
  telegram: CommandsTelegram;
  stateStore: StateStore;
  offset: number;
  timeoutSec: number;
  buildDigest: () => string;
  logger: Logger;
}): Promise<{ nextOffset: number }> {
  const updates = await ctx.telegram.getUpdates(ctx.offset, ctx.timeoutSec);
  let nextOffset = ctx.offset;

  for (const update of updates) {
    nextOffset = Math.max(nextOffset, update.update_id + 1);

    if (!ctx.telegram.isFromConfiguredChat(update)) continue;
    const text = update.message?.text?.trim();
    if (!text) continue;

    await handleCommand(text, ctx);
  }

  return { nextOffset };
}

async function handleCommand(
  text: string,
  ctx: { telegram: CommandsTelegram; stateStore: StateStore; buildDigest: () => string; logger: Logger },
): Promise<void> {
  switch (text) {
    case "/status":
      await ctx.telegram.sendMessage(ctx.buildDigest());
      break;
    case "/pause":
      ctx.stateStore.set(PAUSED_KEY, true);
      ctx.stateStore.set(PAUSE_REASON_KEY, "manual");
      ctx.logger.info("Entries paused via /pause");
      await ctx.telegram.sendMessage("Entries paused.");
      break;
    case "/resume":
      ctx.stateStore.set(PAUSED_KEY, false);
      ctx.stateStore.set(PAUSE_REASON_KEY, null);
      ctx.logger.info("Entries resumed via /resume");
      await ctx.telegram.sendMessage("Entries resumed.");
      break;
    default:
      break; // unknown commands are ignored silently
  }
}
