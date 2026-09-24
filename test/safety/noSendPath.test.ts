import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

// SPEC.md section 1: "No code that signs or sends transactions before Phase 3." /
// section 14: "No code path in Phases 1-2 can sign or send a transaction."
// This project has no Solana SDK dependency at all yet (see README), so a plain
// text scan for the vocabulary of signing/sending a transaction is a strong,
// cheap guard against regressions, independent of how any future Phase 3 code
// might be structured.
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

describe("no send/sign path exists in src/ (Phases 1-2)", () => {
  const files = listFiles(SRC_DIR);

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
