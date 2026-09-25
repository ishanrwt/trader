import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const LIVE_DIR = path.join(SRC_DIR, "live");

// SPEC.md section 1: "No code that signs or sends transactions before Phase 3." /
// section 14: "No code path in Phases 1-2 can sign or send a transaction."
// Phase 3 (section 14 as amended, 16.8): signing and sending vocabulary may
// appear ONLY under src/live/, and src/live/ is only ever loaded through a
// dynamic import in live mode (see the second describe block). Every file
// outside src/live/ is still scanned for the same vocabulary as in Phases 1-2.
const FORBIDDEN_PATTERNS = [
  /sendTransaction/i,
  /sendRawTransaction/i,
  /signTransaction/i,
  /signAndSendTransaction/i,
  /@solana\/web3\.js/,
  /@solana\/kit/,
  /Keypair\.fromSecretKey/,
];

function listFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("no send/sign path exists in src/ outside src/live/ (Phases 1-2 guarantee, kept in Phase 3)", () => {
  const files = listFiles(SRC_DIR).filter((f) => !f.startsWith(LIVE_DIR + path.sep));

  it("finds at least the expected number of source files (sanity check the scan itself runs)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const pattern of FORBIDDEN_PATTERNS) {
    it(`no file references ${pattern}`, () => {
      const offenders = files.filter((f) => pattern.test(fs.readFileSync(f, "utf8")));
      expect(offenders.map((f) => path.relative(SRC_DIR, f))).toEqual([]);
    });
  }
});

describe("src/live/ is never loaded statically (Phase 3: paper mode never loads the live module)", () => {
  const files = listFiles(SRC_DIR).filter((f) => !f.startsWith(LIVE_DIR + path.sep));
  const STATIC_LIVE_IMPORT = /^\s*(import|export)\b[^;]*?from\s+["'][^"']*\/live\/[^"']*["']/m;
  const DYNAMIC_LIVE_IMPORT = /import\(\s*["'][^"']*\/live\/[^"']*["']\s*\)/;

  it("no file outside src/live/ has a static import or re-export from src/live/", () => {
    const offenders = files.filter((f) => STATIC_LIVE_IMPORT.test(fs.readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(SRC_DIR, f))).toEqual([]);
  });

  it("only src/index.ts dynamically imports src/live/, and only behind a MODE === \"live\" check", () => {
    const dynamic = files.filter((f) => DYNAMIC_LIVE_IMPORT.test(fs.readFileSync(f, "utf8")));
    expect(dynamic.map((f) => path.relative(SRC_DIR, f))).toEqual(["index.ts"]);
    const text = fs.readFileSync(path.join(SRC_DIR, "index.ts"), "utf8");
    const importAt = text.search(DYNAMIC_LIVE_IMPORT);
    const guardAt = text.lastIndexOf('config.MODE === "live"', importAt);
    expect(guardAt).toBeGreaterThan(-1);
    expect(importAt - guardAt).toBeLessThan(400);
  });
});
