import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/index.js";
import { SendNotPermittedError, SendPermit, TxRpc } from "../../src/live/txRpc.js";
import { createMemoryLogger } from "../../src/logger/index.js";

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const base = { SOLANA_RPC_URL: "https://rpc.example.com/?api-key=k", JUPITER_API_KEY: "j", TRADER_TELEGRAM_BOT_TOKEN: "t", TRADER_TELEGRAM_CHAT_ID: "1" };

/**
 * SPEC.md section 16.8 / A6: in paper mode the key is never loaded, and
 * paper mode never reaches the send path (the send function throws if called).
 */
describe("paper mode never loads the key and never reaches the send path", () => {
  it("a non-empty key in paper mode is refused before it is ever decoded (a malformed key gets the paper-mode refusal, not a decode error)", () => {
    let message = "";
    try {
      loadConfig({ ...base, MODE: "paper", WALLET_PRIVATE_KEY: "not-a-real-key-0OIl" });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toMatch(/must be left empty in paper mode/);
    expect(message).not.toMatch(/is not a valid key/);
    expect(message).not.toContain("not-a-real-key-0OIl");
  });

  it("the only code that reads WALLET_PRIVATE_KEY from the environment for use is src/live/keys.ts (loaded only in live mode)", () => {
    const readers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".ts") && /\benv\s*\[\s*WALLET_KEY_ENV\s*\]|decodeSecretKey\(|createKeyPairSignerFromBytes/.test(fs.readFileSync(full, "utf8"))) {
          readers.push(path.relative(SRC_DIR, full).split(path.sep).join("/"));
        }
      }
    };
    walk(SRC_DIR);
    // config/index.ts validates the key's FORMAT in live mode only (and zeroes the bytes); encoding/ defines the decoder.
    expect(readers.sort()).toEqual(["config/index.ts", "encoding/secretKey.ts", "live/keys.ts"]);
    const configText = fs.readFileSync(path.join(SRC_DIR, "config/index.ts"), "utf8");
    const decodeAt = configText.indexOf("decodeSecretKey(walletKey)");
    expect(configText.lastIndexOf("function liveIssues(", decodeAt)).toBeGreaterThan(-1); // only inside the live-only checks
  });

  it("src/index.ts decodes nothing itself: the key's redactions and the wallet come only from the dynamically loaded live module", () => {
    const text = fs.readFileSync(path.join(SRC_DIR, "index.ts"), "utf8");
    expect(text).not.toMatch(/WALLET_PRIVATE_KEY/);
    expect(text).toMatch(/const liveModule = config\.MODE === "live" \? await import\("\.\/live\/runtime\.js"\) : null;/);
    expect(text).toMatch(/const redactions = liveModule \? liveModule\.walletKeyRedactions\(env\) : undefined;/);
  });

  it("the send function throws if it is ever called without a live permit; a permit can't be issued in paper mode", async () => {
    const rpc = new TxRpc({ url: "https://x.example", limiter: { acquire: async () => undefined }, sendLimiter: { acquire: async () => undefined }, permit: null, logger: createMemoryLogger() });
    await expect(rpc.sendTransaction("AAAA")).rejects.toBeInstanceOf(SendNotPermittedError);
    expect(() => SendPermit.issue("paper", "live")).toThrow();
  });
});
