import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.join(dirname, "migrations");

export type Db = Database.Database;

/** Opens (creating if needed) the SQLite file at `filePath` and applies pending migrations. */
export function openDb(filePath: string): Db {
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

/**
 * Applies every migration file whose leading number is greater than the
 * database's current `PRAGMA user_version`, in order, each inside its own
 * transaction. SPEC.md section 12: "SQLite with versioned migrations."
 */
export function runMigrations(db: Db, migrationsDir: string = DEFAULT_MIGRATIONS_DIR): void {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const currentVersion = db.pragma("user_version", { simple: true }) as number;

  for (const file of files) {
    const match = /^(\d+)_/.exec(file);
    if (!match) continue;
    const version = Number(match[1]);
    if (version <= currentVersion) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    });
    applyMigration();
  }
}

export function tableNames(db: Db): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name);
}
