import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heartbeat } from "../../src/notify/lifecycle.js";
import { openDb } from "../../src/storage/db.js";
import { StateStore } from "../../src/storage/state.js";
import {
  HEARTBEAT_FRESH_MS,
  INSTANCE_GUARD_MESSAGE,
  instanceGuardRefusal,
  markCleanShutdown,
  readHeartbeatState,
} from "../../src/startup/instanceGuard.js";

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-guard-"));
  dbPath = path.join(dir, "trader.db");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** What a running first instance leaves in the database: its heartbeat, as src/index.ts writes it. */
function firstInstanceHeartbeat(at: number, opts: { cleanShutdown?: boolean } = {}): void {
  const db = openDb(dbPath);
  const state = new StateStore(db);
  heartbeat(state, at);
  if (opts.cleanShutdown) markCleanShutdown(state, at);
  db.close();
}

function secondStartup(now: number): string | null {
  return instanceGuardRefusal(readHeartbeatState(dbPath), now);
}

describe("instance guard (SPEC.md section 16.8)", () => {
  const T = 1_790_335_491_707;

  it("uses the same 2-minute window as smoke-live", () => {
    expect(HEARTBEAT_FRESH_MS).toBe(2 * 60_000);
  });

  it("refuses a second startup within 2 minutes of a running instance's heartbeat, telling you to check pm2 status", () => {
    firstInstanceHeartbeat(T);
    expect(secondStartup(T + 30_000)).toBe(INSTANCE_GUARD_MESSAGE);
    expect(secondStartup(T + HEARTBEAT_FRESH_MS - 1)).toBe(INSTANCE_GUARD_MESSAGE);
    expect(INSTANCE_GUARD_MESSAGE).toContain("another instance may already be running");
    expect(INSTANCE_GUARD_MESSAGE).toContain("pm2 status");
  });

  it("proceeds once the heartbeat is 2 minutes old or older", () => {
    firstInstanceHeartbeat(T);
    expect(secondStartup(T + HEARTBEAT_FRESH_MS)).toBeNull();
    expect(secondStartup(T + 10 * 60_000)).toBeNull();
  });

  it("proceeds with no prior heartbeat: no database file at all, or a database that never recorded one", () => {
    expect(secondStartup(T)).toBeNull();
    openDb(dbPath).close();
    expect(secondStartup(T)).toBeNull();
  });

  it("proceeds right after a graceful shutdown (pm2 restart), whose final heartbeat is marked clean", () => {
    firstInstanceHeartbeat(T, { cleanShutdown: true });
    expect(secondStartup(T + 5_000)).toBeNull();
  });

  it("refuses again once a newer heartbeat follows the clean-shutdown mark (an instance started and is running)", () => {
    firstInstanceHeartbeat(T, { cleanShutdown: true });
    firstInstanceHeartbeat(T + 10_000);
    expect(secondStartup(T + 20_000)).toBe(INSTANCE_GUARD_MESSAGE);
  });

  it("a refused check writes nothing: it reads the file read-only and never runs migrations", () => {
    const raw = new Database(dbPath);
    raw.exec("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    raw.prepare("INSERT INTO state (key, value) VALUES ('lastAliveAt', ?)").run(JSON.stringify(T));
    raw.close();
    const before = fs.readFileSync(dbPath);
    expect(secondStartup(T + 1_000)).toBe(INSTANCE_GUARD_MESSAGE);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    const check = new Database(dbPath, { readonly: true });
    expect(check.pragma("user_version", { simple: true })).toBe(0);
    check.close();
  });
});
