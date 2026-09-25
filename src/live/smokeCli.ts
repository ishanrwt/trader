import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { DexScreenerClient } from "../clients/dexscreener.js";
import { JupiterClient } from "../clients/jupiter.js";
import { WRAPPED_SOL_MINT } from "../constants.js";
import { SolPriceTracker } from "../solPrice/index.js";
import { ConfigError, loadConfig } from "../config/index.js";
import { loadEnv } from "../config/loadEnv.js";
import { SlidingWindowLimiter } from "../limiters/slidingWindow.js";
import { LaneLimiter } from "../limiters/laneLimiter.js";
import { createLogger, type LogLevel } from "../logger/index.js";
import { openDb } from "../storage/db.js";
import { IntentsStore } from "../storage/intents.js";
import { StateStore } from "../storage/state.js";
import { ConfirmationPool } from "./confirm.js";
import { loadWallet, walletKeyRedactions } from "./keys.js";
import { BLOCK_HEIGHT_CHECK_AFTER_MS } from "./runtime.js";
import { runSmoke } from "./smoke.js";
import { SendPermit, TxRpc } from "./txRpc.js";

/**
 * `npm run smoke-live` / `npm run smoke-live -- --send` (SPEC.md section 16.8).
 * Same interlocks as live mode (MODE=live, LIVE_ACK, a valid key). Dry run by
 * default: the RPC client has no send permit, so nothing can be sent.
 */
async function main(): Promise<number> {
  const send = process.argv.slice(2).includes("--send");
  const { env } = loadEnv();
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
  if (config.MODE !== "live") {
    console.error("smoke-live runs only from a folder configured for MODE=live (with LIVE_ACK and WALLET_PRIVATE_KEY). Nothing was done.");
    return 1;
  }
  const logDir = path.join(process.cwd(), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logger = createLogger({ level: config.LOG_LEVEL as LogLevel, secrets: config.secrets, logDir, redactions: walletKeyRedactions(env) });
  const print = (line: string) => console.log(logger.scrubText(line));

  const db = openDb(path.join(process.cwd(), "trader.db"));
  try {
    const wallet = await loadWallet(env);
    const lanes = new LaneLimiter(config.RPC_MAX_RPS, 1_000);
    const rpc = new TxRpc({
      url: config.SOLANA_RPC_URL,
      limiter: lanes,
      sendLimiter: new SlidingWindowLimiter(config.RPC_SEND_MAX_RPS, 1_000),
      permit: send ? SendPermit.issue(config.MODE, "smoke-send") : null,
      logger,
    });
    const jupiter = new JupiterClient({
      apiKey: config.JUPITER_API_KEY,
      physicalLimiter: new SlidingWindowLimiter(config.JUPITER_MAX_REQ_PER_MIN, 60_000, config.JUPITER_MIN_INTERVAL_MS),
      logger,
    });
    const pollMs = config.TX_CONFIRM_POLL_SECONDS * 1000;
    const pool = new ConfirmationPool({
      rpc: {
        getSignatureStatuses: (s, h) => rpc.getSignatureStatuses(s, h),
        getBlockHeight: () => rpc.getBlockHeight(),
        resend: async (b64) => void (await rpc.sendTransaction(b64)),
      },
      pollMs,
      resendEveryMs: 2 * pollMs,
      blockHeightAfterMs: BLOCK_HEIGHT_CHECK_AFTER_MS,
    });
    // SOL/USD for the fee accounting: DexScreener, never Jupiter (section 3).
    const dex = new DexScreenerClient({
      profilesLimiter: new SlidingWindowLimiter(config.DEX_PROFILES_MAX_PER_MIN, 60_000),
      pairsLimiter: new SlidingWindowLimiter(config.DEX_PAIRS_MAX_PER_MIN, 60_000),
      logger,
    });
    const solPrice = new SolPriceTracker(dex, config.ALLOWED_QUOTE_MINTS.filter((m) => m !== WRAPPED_SOL_MINT), logger);
    await solPrice.refresh();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await runSmoke({
        config,
        signer: wallet.signer,
        rpc,
        jupiter,
        pool,
        intents: new IntentsStore(db),
        lastAliveAt: new StateStore(db).get<number | null>("lastAliveAt", null),
        send,
        isTTY: Boolean(process.stdin.isTTY),
        ask: (q) => rl.question(q),
        print,
        solPriceUsd: solPrice.get().priceUsd,
        now: () => Date.now(),
      });
    } finally {
      rl.close();
    }
  } finally {
    db.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // Never print a raw error: it could in principle carry the key (section 16.9).
    console.error("smoke-live failed:", err instanceof Error ? err.name : "error");
    process.exit(1);
  });
