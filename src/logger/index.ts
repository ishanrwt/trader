import path from "node:path";
import pino from "pino";
import { createScrubber } from "./redact.js";

export type LogMeta = Record<string, unknown>;
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface Logger {
  trace(msg: string, meta?: LogMeta): void;
  debug(msg: string, meta?: LogMeta): void;
  info(msg: string, meta?: LogMeta): void;
  warn(msg: string, meta?: LogMeta): void;
  error(msg: string, meta?: LogMeta): void;
  fatal(msg: string, meta?: LogMeta): void;
}

interface RawSink {
  log(level: LogLevel, msg: string, meta?: LogMeta): void;
}

const LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

/**
 * A Logger that also exposes its redaction, so every other path text can leave
 * the process by (Telegram messages, fatal handlers) is scrubbed the same way
 * (SPEC.md section 16.9).
 */
export interface RedactingLogger extends Logger {
  scrubText(text: string): string;
  scrubValue(value: unknown): unknown;
  addRedactions(more: { literals?: readonly string[]; patterns?: readonly RegExp[] }): void;
}

function wrap(secrets: readonly string[], sink: RawSink, patterns: readonly RegExp[] = []): RedactingLogger {
  const { scrub, scrubString, add } = createScrubber(secrets, patterns);
  const logger = {} as RedactingLogger;
  for (const level of LEVELS) {
    logger[level] = (msg: string, meta?: LogMeta) => {
      const safeMsg = scrubString(msg);
      const safeMeta = meta ? (scrub(meta) as LogMeta) : undefined;
      sink.log(level, safeMsg, safeMeta);
    };
  }
  logger.scrubText = scrubString;
  logger.scrubValue = (value) => scrub(value);
  logger.addRedactions = add;
  return logger;
}

export interface CreateLoggerOptions {
  level: LogLevel;
  secrets: readonly string[];
  /** Extra literal redactions and patterns registered before the first line (the wallet key's encodings in live mode). */
  redactions?: { literals?: readonly string[]; patterns?: readonly RegExp[] };
  logDir: string;
}

/** Console + daily-rotating file logger, per SPEC.md section 2's "logger" module. */
export function createLogger(opts: CreateLoggerOptions): RedactingLogger {
  const transport = pino.transport({
    targets: [
      {
        target: "pino-roll",
        level: opts.level,
        options: {
          file: path.join(opts.logDir, "trader"),
          extension: ".log",
          frequency: "daily",
          mkdir: true,
        },
      },
      {
        target: "pino/file",
        level: opts.level,
        options: { destination: 1 }, // stdout
      },
    ],
  });
  const pinoInstance = pino({ level: opts.level }, transport);
  const sink: RawSink = {
    log(level, msg, meta) {
      const obj = meta ?? {};
      switch (level) {
        case "trace":
          pinoInstance.trace(obj, msg);
          break;
        case "debug":
          pinoInstance.debug(obj, msg);
          break;
        case "info":
          pinoInstance.info(obj, msg);
          break;
        case "warn":
          pinoInstance.warn(obj, msg);
          break;
        case "error":
          pinoInstance.error(obj, msg);
          break;
        case "fatal":
          pinoInstance.fatal(obj, msg);
          break;
      }
    },
  };
  const logger = wrap(opts.secrets, sink);
  if (opts.redactions) logger.addRedactions(opts.redactions);
  return logger;
}

export interface MemoryLogEntry {
  level: LogLevel;
  msg: string;
  meta: LogMeta | undefined;
}

/** In-memory logger for tests: applies the same redaction, captures every entry. */
export function createMemoryLogger(secrets: readonly string[] = [], patterns: readonly RegExp[] = []): RedactingLogger & { entries: MemoryLogEntry[] } {
  const entries: MemoryLogEntry[] = [];
  const sink: RawSink = {
    log(level, msg, meta) {
      entries.push({ level, msg, meta });
    },
  };
  const logger = wrap(secrets, sink, patterns) as RedactingLogger & { entries: MemoryLogEntry[] };
  logger.entries = entries;
  return logger;
}
