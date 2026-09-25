import { loadConfig } from "../../src/config/index.js";
import { ConfirmationPool } from "../../src/live/confirm.js";
import { LiveExecutor, type LiveAppHooks } from "../../src/live/executor.js";
import { TOKEN_PROGRAM } from "../../src/live/programs.js";
import type { TxRpc } from "../../src/live/txRpc.js";
import { createMemoryLogger } from "../../src/logger/index.js";
import { openDb } from "../../src/storage/db.js";
import { FeeLossesStore } from "../../src/storage/feeLosses.js";
import { IntentsStore } from "../../src/storage/intents.js";
import { PositionsStore, type NewPositionRow } from "../../src/storage/positions.js";
import { SafetyCacheStore } from "../../src/storage/safetyCache.js";
import { FakeChain, RENT } from "./fakeChain.js";
import { makeTestSecretKey } from "./keypair.js";

export const SOL_PRICE = 150;

export function liveConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    SOLANA_RPC_URL: "https://rpc.example.com/?api-key=k",
    JUPITER_API_KEY: "j",
    TRADER_TELEGRAM_BOT_TOKEN: "t",
    TRADER_TELEGRAM_CHAT_ID: "1",
    MODE: "live",
    LIVE_ACK: "I_ACCEPT_REAL_LOSSES",
    WALLET_PRIVATE_KEY: makeTestSecretKey().base58,
    ...overrides,
  });
}

export interface Setup {
  chain: FakeChain;
  executor: LiveExecutor;
  positions: PositionsStore;
  intents: IntentsStore;
  feeLosses: FeeLossesStore;
  alerts: string[];
  buys: Array<Parameters<LiveAppHooks["recordBuy"]>>;
  sells: Array<Parameters<LiveAppHooks["recordSell"]>>;
  reconciled: number[];
  clock: { t: number };
  /** Jupiter lane usage by the executor (section 9.3 / A13). */
  lanes: { entry: number; exit: number };
  db: ReturnType<typeof openDb>;
  newExecutor: (opts?: { neverConfirm?: boolean }) => LiveExecutor;
}

export async function setup(opts: { tokenProgram?: string; config?: Record<string, string>; neverConfirm?: boolean; yieldingSleep?: boolean } = {}): Promise<Setup> {
  const chain = await FakeChain.create(opts.tokenProgram ?? TOKEN_PROGRAM);
  const db = openDb(":memory:");
  const positions = new PositionsStore(db);
  const intents = new IntentsStore(db);
  const feeLosses = new FeeLossesStore(db);
  const safety = new SafetyCacheStore(db);
  safety.set(chain.mint, { passed: true, reason: "ok" }, 1);
  safety.setMintInfo(chain.mint, { tokenProgram: chain.tokenProgram, decimals: 6 });
  const clock = { t: 1_700_000_000_000 };
  const config = liveConfig(opts.config);
  const alerts: string[] = [];
  const buys: Setup["buys"] = [];
  const sells: Setup["sells"] = [];
  const reconciled: number[] = [];
  const lanes = { entry: 0, exit: 0 };
  const hooks: LiveAppHooks = {
    recordBuy: async (payload, fill, info) => {
      buys.push([payload, fill, info]);
      return positions.insert(
        positionRow({
          mint: payload.mint,
          status: "open",
          costBasis: fill.costBasisUsd,
          tokenAmountRaw: fill.tokensRaw.toString(),
          tokenAccount: fill.tokenAccount?.address ?? null,
          tokenProgram: fill.tokenAccount?.program ?? null,
          entrySignature: info.signature,
          entryRentLamports: Number(fill.rentPaidLamports),
          entryTime: info.entryTime,
        }),
      );
    },
    recordSell: async (row, fill, info) => {
      sells.push([row, fill, info]);
      positions.remove(row.id);
    },
    closeReconciled: async (row) => {
      reconciled.push(row.id);
      positions.remove(row.id);
    },
    alert: (t) => void alerts.push(t),
    event: () => undefined,
    solPriceUsd: () => SOL_PRICE,
    acquireEntryLane: async () => {
      lanes.entry++;
      return true;
    },
    recordExitLane: () => {
      lanes.exit++;
    },
  };
  // A fake clock; with yieldingSleep, each sleep also yields to the event loop so concurrent work (e.g. a shutdown waiting on a confirmation) interleaves.
  const fakeSleep = async (ms: number): Promise<void> => {
    if (opts.yieldingSleep) await new Promise((r) => setTimeout(r, 0));
    clock.t += ms;
  };
  const newExecutor = (o: { neverConfirm?: boolean } = {}) => {
    const pool = new ConfirmationPool({
      rpc: {
        getSignatureStatuses: (s, h) => chain.rpc.getSignatureStatuses(s, h),
        getBlockHeight: () => chain.rpc.getBlockHeight(),
        resend: async (b) => void (await chain.rpc.sendTransaction(b)),
      },
      pollMs: 2_000,
      resendEveryMs: 4_000,
      blockHeightAfterMs: 30_000,
      now: () => clock.t,
      sleep: fakeSleep,
    });
    if (o.neverConfirm) (pool as unknown as { track: () => Promise<never> }).track = () => new Promise<never>(() => undefined);
    return new LiveExecutor({
      config,
      wallet: { signer: chain.wallet, address: chain.wallet.address },
      rpc: chain.rpc as unknown as TxRpc,
      jupiter: chain.jupiter,
      pool,
      intents,
      positions,
      feeLosses,
      safetyCache: safety,
      hooks,
      logger: createMemoryLogger(),
      now: () => clock.t,
      sleep: fakeSleep,
    });
  };
  return { chain, executor: newExecutor({ neverConfirm: opts.neverConfirm ?? false }), positions, intents, feeLosses, alerts, buys, sells, reconciled, clock, lanes, db, newExecutor };
}

export function positionRow(o: Partial<NewPositionRow>): NewPositionRow {
  return {
    mode: "live", mint: "M", symbol: "SYM", pairAddress: null, status: "closing", entryTime: 1, sizeUsd: 25, tokenAmount: 1, costBasis: 25.5, entryLiquidityUsd: 20_000,
    entryPairSnapshot: null, score: 0.5, scoreComponents: null, safetyResult: null, holdersResult: null, peakPnl: 0, currentTarget: 30, targetExtensions: 0, timerRestarts: 0,
    lastRestartAt: null, deadline: 2, trailArmed: false, fastStreak: 0, lowLiqStreak: 0, noRouteSince: null, closingSince: 1, pendingExitReason: "target", lastPnlPct: null,
    lastValueUsd: null, lastPolledAt: null, tokenDecimals: 6, entryValuationPnlPct: null, entryQuoteInAmount: null, entryQuoteOutAmount: null, ...o,
  };
}

export function seedSellPosition(s: Setup, o: Partial<NewPositionRow> = {}): number {
  s.chain.tokenAtaExists = true;
  s.chain.tokens = 1_000_000n;
  return s.positions.insert(
    positionRow({ mint: s.chain.mint, tokenAccount: s.chain.tokenAta, tokenProgram: s.chain.tokenProgram, tokenAmountRaw: "1000000", entryRentLamports: Number(RENT), ...o }),
  );
}

