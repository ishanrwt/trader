import type { Logger } from "../logger/index.js";
import { fetchJson } from "./http.js";

export interface TelegramMessage {
  message_id: number;
  chat: { id: number | string };
  text?: string;
  date: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramClientOptions {
  botToken: string;
  chatId: string;
  timeoutMs?: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/**
 * Hand-rolled Telegram client: sendMessage plus getUpdates long polling, per
 * SPEC.md section 3 ("no inbound server"). Both methods swallow errors after
 * logging — a Telegram outage must never crash the process (section 1).
 */
export class TelegramClient {
  constructor(private readonly opts: TelegramClientOptions) {}

  async sendMessage(text: string): Promise<void> {
    const url = `${this.base()}/bot${this.opts.botToken}/sendMessage`;
    try {
      await fetchJson(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.opts.chatId, text }),
        timeoutMs: this.opts.timeoutMs ?? 8000,
        retries: 1,
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        logger: this.opts.logger,
        label: "Telegram sendMessage",
      });
    } catch (err) {
      // `url` contains the bot token; the logger scrubs every configured secret,
      // including the full token, out of anything logged here.
      this.opts.logger.error("Telegram sendMessage failed", { url, error: String(err) });
    }
  }

  /** Long-polls for up to `timeoutSec`. Returns [] (never throws) on any failure. */
  async getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]> {
    const url = `${this.base()}/bot${this.opts.botToken}/getUpdates?offset=${offset}&timeout=${timeoutSec}`;
    try {
      const data = await fetchJson<{ ok: boolean; result: TelegramUpdate[] }>(url, {
        timeoutMs: (timeoutSec + 5) * 1000,
        retries: 0,
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        logger: this.opts.logger,
        label: "Telegram getUpdates",
      });
      return data.result ?? [];
    } catch (err) {
      this.opts.logger.error("Telegram getUpdates failed", { url, error: String(err) });
      return [];
    }
  }

  /** Only updates from the configured chat, per section 10: "Ignore messages from any other chat." */
  isFromConfiguredChat(update: TelegramUpdate): boolean {
    const chatId = update.message?.chat?.id;
    return chatId !== undefined && String(chatId) === this.opts.chatId;
  }

  private base(): string {
    return this.opts.baseUrl ?? "https://api.telegram.org";
  }
}
