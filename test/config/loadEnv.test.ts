import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/loadEnv.js";

describe("loadEnv", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-loadenv-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("returns an empty fileKeys list and does not throw when .env is missing", () => {
    const dir = tmpDir();
    const result = loadEnv(dir);
    expect(result.fileKeys).toEqual([]);
    expect(result.env).toBe(process.env);
  });

  it("parses .env into process.env and reports its keys", () => {
    const dir = tmpDir();
    const marker = `TRADER_LOADENV_TEST_${Date.now()}`;
    fs.writeFileSync(path.join(dir, ".env"), `${marker}=hello\n`);
    try {
      const result = loadEnv(dir);
      expect(result.fileKeys).toContain(marker);
      expect(process.env[marker]).toBe("hello");
    } finally {
      delete process.env[marker];
    }
  });
});
