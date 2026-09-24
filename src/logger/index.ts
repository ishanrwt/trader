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

function wrap(secrets: readonly string[], sink: RawSink): Logger {
  const { scrub, scrubString } = createScrubber(secrets);
  const logger = {} as Logger;
  for (const level of LEVELS) {
    logger[level] = (msg: string, meta?: LogMeta) => {
      const safeMsg = scrubString(msg);
      const safeMeta = meta ? (scrub(meta) as LogMeta) : undefined;
      sink.log(level, safeMsg, safeMeta);
    };
  }
  return logger;
}

export interface CreateLoggerOptions {
  level: LogLevel;
  secrets: readonly string[];
  logDir: string;
}

/** Console + daily-rotating file logger, per SPEC.md section 2's "logger" module. */
export function createLogger(opts: CreateLoggerOptions): Logger {
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
  return wrap(opts.secrets, sink);
}

export interface MemoryLogEntry {
  level: LogLevel;
  msg: string;
  meta: LogMeta | undefined;
}

/** In-memory logger for tests: applies the same redaction, captures every entry. */
export function createMemoryLogger(secrets: readonly string[] = []): Logger & { entries: MemoryLogEntry[] } {
  const entries: MemoryLogEntry[] = [];
  const sink: RawSink = {
    log(level, msg, meta) {
      entries.push({ level, msg, meta });
    },
  };
  const logger = wrap(secrets, sink) as Logger & { entries: MemoryLogEntry[] };
  logger.entries = entries;
  return logger;
}
