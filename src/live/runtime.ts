import type { JupiterClient } from "../clients/jupiter.js";
import type { Config } from "../config/index.js";
import type { LaneLimiter } from "../limiters/laneLimiter.js";
import { SlidingWindowLimiter } from "../limiters/slidingWindow.js";
import type { Logger } from "../logger/index.js";
import type { FeeLossesStore } from "../storage/feeLosses.js";
import type { IntentsStore } from "../storage/intents.js";
import type { PositionsStore } from "../storage/positions.js";
import type { SafetyCacheStore } from "../storage/safetyCache.js";
import { ConfirmationPool } from "./confirm.js";
import { LiveExecutor, type LiveAppHooks } from "./executor.js";
import { loadWallet } from "./keys.js";
import { SendPermit, TxRpc } from "./txRpc.js";

export { walletKeyRedactions } from "./keys.js";
export type { BuyIntentPayload, LiveAppHooks } from "./executor.js";
export type { BuyFill, SellFill } from "./fills.js";

/** Section 16.4: a status that stays empty this long starts the block-height checks. */
export const BLOCK_HEIGHT_CHECK_AFTER_MS = 30_000;

export interface LiveRuntime {
  address: string;
  executor: LiveExecutor;
  rpcCalls: () => number;
}

/**
 * The single entry point src/index.ts loads (dynamically, only when
 * MODE=live). Loads the key (after its redactions were registered), issues
 * the send permit, and wires the live executor. Nothing here runs in paper mode.
 */
export async function createLiveRuntime(deps: {
  config: Config;
  env: Record<string, string | undefined>;
  logger: Logger;
  rpcLanes: LaneLimiter;
  jupiter: JupiterClient;
  intents: IntentsStore;
  positions: PositionsStore;
  feeLosses: FeeLossesStore;
  safetyCache: SafetyCacheStore;
  hooks: LiveAppHooks;
}): Promise<LiveRuntime> {
  const wallet = await loadWallet(deps.env);
  let calls = 0;
  const rpc = new TxRpc({
    url: deps.config.SOLANA_RPC_URL,
    limiter: deps.rpcLanes,
    sendLimiter: new SlidingWindowLimiter(deps.config.RPC_SEND_MAX_RPS, 1_000),
    permit: SendPermit.issue(deps.config.MODE, "live"),
    logger: deps.logger,
    onCall: () => {
      calls++;
    },
  });
  const pollMs = deps.config.TX_CONFIRM_POLL_SECONDS * 1000;
  const pool = new ConfirmationPool({
    rpc: {
      getSignatureStatuses: (s, h) => rpc.getSignatureStatuses(s, h),
      getBlockHeight: () => rpc.getBlockHeight(),
      resend: async (b64) => {
        await rpc.sendTransaction(b64);
      },
    },
    pollMs,
    resendEveryMs: 2 * pollMs,
    blockHeightAfterMs: BLOCK_HEIGHT_CHECK_AFTER_MS,
    onError: (err) => deps.logger.warn("Confirmation poll failed; retrying next poll", { error: String(err) }),
  });
  const executor = new LiveExecutor({
    config: deps.config,
    wallet,
    rpc,
    jupiter: deps.jupiter,
    pool,
    intents: deps.intents,
    positions: deps.positions,
    feeLosses: deps.feeLosses,
    safetyCache: deps.safetyCache,
    hooks: deps.hooks,
    logger: deps.logger,
  });
  return { address: wallet.address, executor, rpcCalls: () => calls };
}
