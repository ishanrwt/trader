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
export const KILLED_VIA_COMMAND_KEY = "killedViaCommand";
export const CONSECUTIVE_ERRORS_KEY = "consecutiveErrors";

/**
 * SPEC.md section 10: /status, /report, /pause, /resume, /killswitch,
 * restricted to the configured chat. Unknown commands and messages from
 * other chats are ignored silently.
 */
export async function pollAndHandleCommands(ctx: {
  telegram: CommandsTelegram;
  stateStore: StateStore;
  offset: number;
  timeoutSec: number;
  buildDigest: () => string;
  buildReport: () => string;
  logger: Logger;
  /** Audit trail (storage/events.ts) — optional so tests that don't care about it can omit it. */
  recordEvent?: (type: string, message: string) => void;
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
  ctx: {
    telegram: CommandsTelegram;
    stateStore: StateStore;
    buildDigest: () => string;
    buildReport: () => string;
    logger: Logger;
    recordEvent?: (type: string, message: string) => void;
  },
): Promise<void> {
  switch (text) {
    case "/status":
      await ctx.telegram.sendMessage(ctx.buildDigest());
      break;
    case "/report":
      await ctx.telegram.sendMessage(ctx.buildReport());
      break;
    case "/pause":
      ctx.stateStore.set(PAUSED_KEY, true);
      ctx.stateStore.set(PAUSE_REASON_KEY, "manual");
      ctx.logger.info("Entries paused via /pause");
      ctx.recordEvent?.("pause", "Entries paused via /pause");
      await ctx.telegram.sendMessage("Entries paused.");
      break;
    case "/resume":
      // Clears pause, error halts and the kill switch (SPEC.md section 9.2) — but NOT the daily-loss halt (section 9.1).
      ctx.stateStore.set(PAUSED_KEY, false);
      ctx.stateStore.set(PAUSE_REASON_KEY, null);
      ctx.stateStore.set(CONSECUTIVE_ERRORS_KEY, 0);
      ctx.stateStore.set(KILLED_VIA_COMMAND_KEY, false);
      ctx.logger.info("Entries resumed via /resume");
      ctx.recordEvent?.("resume", "Entries resumed via /resume");
      await ctx.telegram.sendMessage("Entries resumed. (If a KILL file is present, delete it too.)");
      break;
    case "/killswitch":
      ctx.stateStore.set(KILLED_VIA_COMMAND_KEY, true);
      ctx.logger.warn("Kill switch activated via /killswitch");
      ctx.recordEvent?.("killswitch", "Kill switch activated via /killswitch");
      await ctx.telegram.sendMessage("Kill switch activated: entries halted, closing all open positions.");
      break;
    default:
      break; // unknown commands are ignored silently
  }
}
