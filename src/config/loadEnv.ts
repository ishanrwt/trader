import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export interface LoadEnvResult {
  env: NodeJS.ProcessEnv;
  /** Keys present in the .env file itself (for unknown-key warnings), not all of process.env. */
  fileKeys: string[];
}

/**
 * Loads `.env` from `cwd` into process.env via dotenv, if the file exists.
 * Shared by every entry point (src/index.ts, src/report/cli.ts) so there's
 * one place that knows how `.env` is found and parsed. A missing `.env` is
 * not an error here — it's valid for a read-only entry point like the report
 * CLI to run with no `.env` at all, as long as it doesn't need any secrets.
 */
export function loadEnv(cwd: string = process.cwd()): LoadEnvResult {
  const envPath = path.join(cwd, ".env");
  let fileKeys: string[] = [];
  if (fs.existsSync(envPath)) {
    const parsed = dotenv.parse(fs.readFileSync(envPath));
    fileKeys = Object.keys(parsed);
    dotenv.config({ path: envPath });
  }
  return { env: process.env, fileKeys };
}
