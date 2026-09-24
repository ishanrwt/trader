import type { Db } from "./db.js";

export function logEvent(db: Db, now: number, type: string, message: string, meta?: unknown): void {
  db.prepare("INSERT INTO events (ts, type, message, meta) VALUES (@ts, @type, @message, @meta)").run({
    ts: now,
    type,
    message,
    meta: meta !== undefined ? JSON.stringify(meta) : null,
  });
}

export interface EventRow {
  id: number;
  ts: number;
  type: string;
  message: string;
  meta: unknown;
}

export function recentEvents(db: Db, sinceTs: number, limit = 200): EventRow[] {
  const rows = db
    .prepare("SELECT id, ts, type, message, meta FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?")
    .all(sinceTs, limit) as Array<{ id: number; ts: number; type: string; message: string; meta: string | null }>;
  return rows.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
}
