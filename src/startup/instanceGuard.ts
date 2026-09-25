import fs from "node:fs";
import Database from "better-sqlite3";
import type { StateStore } from "../storage/state.js";

/** A heartbeat younger than this means a bot is running from this same folder (also smoke-live's check). */
export const HEARTBEAT_FRESH_MS = 2 * 60_000;

/** The heartbeat key written by notify/lifecycle.ts heartbeat() (the same one smoke-live checks). */
const LAST_ALIVE_KEY = "lastAliveAt";
/** Written by a graceful shutdown, right after its final heartbeat. */
const CLEAN_SHUTDOWN_KEY = "cleanShutdownAt";

export const INSTANCE_GUARD_MESSAGE =
  "Refusing to start: this folder's database heartbeat is less than 2 minutes old, so another instance may already be running. Check `pm2 status` (and any terminal running `npm start`) first.";

export interface HeartbeatState {
  lastAliveAt: number | null;
  cleanShutdownAt: number | null;
}

/**
 * Reads the heartbeat straight from the database file, read-only and without
 * running migrations, so a refused start writes nothing. A missing file or a
 * database without a state table means no prior heartbeat.
 */
export function readHeartbeatState(dbPath: string): HeartbeatState {
  if (!fs.existsSync(dbPath)) return { lastAliveAt: null, cleanShutdownAt: null };
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const hasState = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'state'").get();
    if (!hasState) return { lastAliveAt: null, cleanShutdownAt: null };
    const read = (key: string): number | null => {
      const row = db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined;
      if (!row) return null;
      const v: unknown = JSON.parse(row.value);
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    return { lastAliveAt: read(LAST_ALIVE_KEY), cleanShutdownAt: read(CLEAN_SHUTDOWN_KEY) };
  } finally {
    db.close();
  }
}

/**
 * SPEC.md section 16.8: a heartbeat younger than 2 minutes means another
 * instance may be running, unless that heartbeat was written by a graceful
 * shutdown (cleanShutdownAt >= lastAliveAt), which is what makes `pm2 restart`
 * work. Returns the refusal message, or null to proceed.
 */
export function instanceGuardRefusal(hb: HeartbeatState, now: number): string | null {
  if (hb.lastAliveAt === null) return null;
  if (now - hb.lastAliveAt >= HEARTBEAT_FRESH_MS) return null;
  if (hb.cleanShutdownAt !== null && hb.cleanShutdownAt >= hb.lastAliveAt) return null;
  return INSTANCE_GUARD_MESSAGE;
}

/** Called by a graceful shutdown after its final heartbeat. */
export function markCleanShutdown(stateStore: StateStore, now: number): void {
  stateStore.set(CLEAN_SHUTDOWN_KEY, now);
}
