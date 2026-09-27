import { getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { createMemoryLogger } from "../../src/logger/index.js";
import { formatRugSection, rugCoverage } from "../../src/report/rugReport.js";
import type { TradeRecord } from "../../src/report/index.js";
import { base58Decode32, base58Encode, findProgramAddress } from "../../src/encoding/solanaAddress.js";
import { openDb } from "../../src/storage/db.js";
import { MintFeaturesStore, type MintFeaturesRow } from "../../src/storage/mintFeatures.js";
import { StateStore } from "../../src/storage/state.js";
import {
  bondingCurvePda,
  collectRugFeatures,
  CreditMeter,
  decodeBondingCurve,
  decodePumpSwapPool,
  makeRugCheck,
  makeRugRpc,
  pumpSwapLpSplit,
  PUMP_PROGRAM,
  PUMPSWAP_PROGRAM,
  tokenBuysFromMeta,
  type RugRpc,
} from "../../src/tracking/rugFeatures.js";

const MINT = "BJDfhK6xJhj9Ln7PXCFZL6ZofEXfuDAo9cAmKCFvpump"; // the real mint from the dry run
const POOL = "7aEKLSNcJgjNGvnnYsULYCTxZeUwevbS8qCb9gnKFW7t";
const CURVE = "ALvumsuTgq1HxKPNvJdz28FvsCTpHBg9coY7pGqTnE6M";
const CREATOR = "BfySv5qt7ZMP1BHKqegrLUqzwrGAggiar196XoJm8WJn";
const T2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const key = (s: string) => base58Decode32(s);

function poolBytes(o: { index?: number; lpSupply?: bigint; coinCreator?: string } = {}): Uint8Array {
  const b = new Uint8Array(300);
  b.set([241, 154, 109, 4, 17, 177, 109, 188], 0);
  const dv = new DataView(b.buffer);
  dv.setUint16(9, o.index ?? 0, true);
  b.set(key(CREATOR), 11); // pool creator (migration authority in reality; not used)
  b.set(key(MINT), 43);
  b.set(key("So11111111111111111111111111111111111111112"), 75);
  b.set(key("LPmintLPmintLPmintLPmintLPmintLPmintLPmint1"), 107);
  b.set(key("4nYganvnrZeBrydtgJJycp6VVsfWHmaaUfiRGSYGKvms"), 139);
  dv.setBigUint64(203, o.lpSupply ?? 4_193_388_282_604n, true);
  b.set(o.coinCreator ? key(o.coinCreator) : new Uint8Array(32), 211);
  return b;
}
function curveBytes(o: { complete?: boolean; total?: bigint } = {}): Uint8Array {
  const b = new Uint8Array(150);
  b.set([23, 183, 248, 55, 96, 216, 172, 96], 0);
  new DataView(b.buffer).setBigUint64(40, o.total ?? 1_000_000_000_000_000n, true);
  b[48] = o.complete === false ? 0 : 1;
  b.set(key(CREATOR), 49);
  return b;
}

/** A fake RPC answering like the real mint BJDf… did in the dry run. */
function fakeRpc(over: Partial<RugRpc> = {}): RugRpc & { calls: string[] } {
  const calls: string[] = [];
  const rpc: RugRpc = {
    getAccount: async (pk) => {
      calls.push(`account:${pk}`);
      if (pk === POOL) return { owner: PUMPSWAP_PROGRAM, data: poolBytes() };
      if (pk === CURVE) return { owner: PUMP_PROGRAM, data: curveBytes() };
      return null;
    },
    getTokenSupplyRaw: async (m) => (calls.push(`supply:${m}`), m === MINT ? 1_000_000_000_000_000n : 0n),
    getTokenAccountAmounts: async () => (calls.push("gpa"), [5n, 0n, 7n, 0n, 1n]),
    getSignatures: async () => (
      calls.push("sigs"),
      [
        { signature: "late", slot: 110, failed: false },
        { signature: "migrate", slot: 100, failed: false },
        { signature: "buy3", slot: 100, failed: false },
        { signature: "buy2", slot: 100, failed: false },
        { signature: "launch", slot: 100, failed: false },
        { signature: "failedBuy", slot: 101, failed: true },
      ]
    ),
    getTokenBuys: async (sig) => (
      calls.push(`tx:${sig}`),
      ({ launch: 34_199_203_154_141n, buy2: 582_165_070_021_652n, buy3: 176_735_726_824_207n, migrate: 0n } as Record<string, bigint>)[sig] ?? 0n
    ),
    getOwnerBalance: async () => (calls.push("owner"), 0n),
    ...over,
  };
  return Object.assign(rpc, { calls });
}
const meter = () => new CreditMeter(null, "paper", 1_000_000, "Asia/Kolkata", () => 0);
const INPUT = { mint: MINT, pairAddress: POOL, pairLabels: [] as string[], tokenProgram: T2022 };
const DEPS = { sniperSlots: 3, sniperMaxPages: 5 };

describe("address helpers (read-only, cross-checked against the live-only library)", () => {
  it("base58 round-trips 32-byte addresses exactly like the library", () => {
    for (const a of [MINT, POOL, CURVE, PUMP_PROGRAM, "11111111111111111111111111111111"]) {
      expect(base58Encode(base58Decode32(a))).toBe(a);
      expect(base58Encode(new Uint8Array(getAddressEncoder().encode(address(a))))).toBe(getAddressDecoder().decode(getAddressEncoder().encode(address(a))));
    }
  });

  it("derives the same PDA and bump as the library for many mints", async () => {
    for (let i = 0; i < 40; i++) {
      const bytes = new Uint8Array(32).map((_, j) => (i * 31 + j * 7 + 3) % 256);
      const mint = base58Encode(bytes);
      const mine = findProgramAddress([new TextEncoder().encode("bonding-curve"), bytes], PUMP_PROGRAM);
      const [lib, bump] = await getProgramDerivedAddress({ programAddress: address(PUMP_PROGRAM), seeds: [new TextEncoder().encode("bonding-curve"), getAddressEncoder().encode(address(mint))] });
      expect([mine.address, mine.bump]).toEqual([lib, bump]);
    }
    expect(await bondingCurvePda(MINT)).toBe(CURVE); // the real curve seen on chain
  });
});

describe("decoders (offsets from pump.fun's published IDLs)", () => {
  it("decodes a PumpSwap Pool", () => {
    const p = decodePumpSwapPool(poolBytes({ index: 0, coinCreator: CREATOR }))!;
    expect(p).toMatchObject({ index: 0, baseMint: MINT, lpSupply: 4_193_388_282_604n, coinCreator: CREATOR, poolBaseTokenAccount: "4nYganvnrZeBrydtgJJycp6VVsfWHmaaUfiRGSYGKvms" });
    expect(decodePumpSwapPool(poolBytes())!.coinCreator).toBeNull(); // default pubkey on older pools
    expect(decodePumpSwapPool(new Uint8Array(300))).toBeNull(); // wrong discriminator
    expect(decodePumpSwapPool(poolBytes().subarray(0, 100))).toBeNull(); // too short
  });

  it("decodes a pump.fun BondingCurve", () => {
    expect(decodeBondingCurve(curveBytes({ complete: true }))).toEqual({ tokenTotalSupply: 1_000_000_000_000_000n, complete: true, creator: CREATOR });
    expect(decodeBondingCurve(curveBytes({ complete: false }))!.complete).toBe(false);
    expect(decodeBondingCurve(poolBytes())).toBeNull();
  });

  it("LP split: lp_supply (not reduced by burns) vs the LP mint's current supply; implausible inputs give null", () => {
    expect(pumpSwapLpSplit(4_193_388_282_604n, 0n)).toEqual({ burnedPct: 100, lockedPct: 0, withdrawablePct: 0 });
    expect(pumpSwapLpSplit(1000n, 250n)).toEqual({ burnedPct: 75, lockedPct: 0, withdrawablePct: 25 });
    expect(pumpSwapLpSplit(0n, 0n)).toBeNull();
    expect(pumpSwapLpSplit(1000n, 2000n)).toBeNull();
  });
});

describe("collectRugFeatures (network mocked)", () => {
  it("records every feature for a migrated pump.fun token on PumpSwap, with its credits", async () => {
    const rpc = fakeRpc();
    const f = await collectRugFeatures({ rpc, meter: meter(), ...DEPS }, INPUT);
    expect(f).toMatchObject({
      poolProgram: PUMPSWAP_PROGRAM, poolCanonical: true, pumpMigrated: true, lpStatus: "burned", lpBurnedPct: 100, lpLockedPct: 0,
      lpSupplyPool: "4193388282604", lpMintSupply: "0", holderCount: 3, sniperSlots: 3, sniperTxs: 4, sniperCapped: false,
      creator: CREATOR, creatorHoldingPct: 0, reasons: { rugcheck: "disabled" },
    });
    // Sniper share: buys in the curve's first 3 slots after launch (slots 100-102), failed txs skipped: 793.1M of 1B.
    expect(f.sniperSharePct).toBeCloseTo(79.31, 2);
    expect(rpc.calls).not.toContain("tx:late");
    expect(rpc.calls).not.toContain("tx:failedBuy");
    // pool 1 + curve 1 + LP supply 1 + gPA 10 + 1 signature page + 4 txs + owner balance 1 = 19
    expect(f.creditsUsed).toBe(19);
  });

  it("excludes the curve and the pool as receivers (the migration moves the curve's remainder into the pool's vault)", () => {
    const meta = {
      preTokenBalances: [{ accountIndex: 7, mint: MINT, owner: CURVE, uiTokenAmount: { amount: "206900000000000" } }],
      postTokenBalances: [
        { accountIndex: 4, mint: MINT, owner: POOL, uiTokenAmount: { amount: "206900000000000" } },
        { accountIndex: 7, mint: MINT, owner: CURVE, uiTokenAmount: { amount: "0" } },
        { accountIndex: 9, mint: "OTHER", owner: "x", uiTokenAmount: { amount: "5" } },
      ],
    };
    expect(tokenBuysFromMeta(meta, MINT, [CURVE, POOL])).toBe(0n);
    expect(tokenBuysFromMeta(meta, MINT, [CURVE])).toBe(206_900_000_000_000n); // the old bug: counted as a buy
  });

  it("sniper lookup: too_many_txs when the launch isn't reached within SNIPER_MAX_PAGES pages; capped flag past 40 early txs", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, slot: 500 - i, failed: false }));
    const f1 = await collectRugFeatures({ rpc: fakeRpc({ getSignatures: async () => full }), meter: meter(), sniperSlots: 3, sniperMaxPages: 2 }, INPUT);
    expect(f1.sniperSharePct).toBeNull();
    expect(f1.reasons.sniperShare).toBe("too_many_txs");

    const burst = Array.from({ length: 60 }, (_, i) => ({ signature: `b${i}`, slot: 100, failed: false }));
    const f2 = await collectRugFeatures({ rpc: fakeRpc({ getSignatures: async () => burst, getTokenBuys: async () => 1n }), meter: meter(), ...DEPS }, INPUT);
    expect(f2).toMatchObject({ sniperTxs: 40, sniperCapped: true });
  });

  it("a non-pump.fun token on another DEX: LP layout_unverified or concentrated_or_position, sniper unsupported, no creator", async () => {
    const rpc = fakeRpc({ getAccount: async (pk) => (pk === POOL ? { owner: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", data: new Uint8Array(10) } : null) });
    const cpmm = await collectRugFeatures({ rpc, meter: meter(), ...DEPS }, { ...INPUT, pairLabels: ["CPMM"] });
    expect(cpmm).toMatchObject({ pumpMigrated: false, lpStatus: null, reasons: { lp: "layout_unverified", sniperShare: "unsupported", creatorHolding: "no_creator" } });
    const clmm = await collectRugFeatures({ rpc, meter: meter(), ...DEPS }, { ...INPUT, pairLabels: ["CLMM"] });
    expect(clmm.reasons.lp).toBe("concentrated_or_position");
    const dyn2 = await collectRugFeatures({ rpc, meter: meter(), ...DEPS }, { ...INPUT, pairLabels: ["DYN2"] });
    expect(dyn2.reasons.lp).toBe("concentrated_or_position");
  });

  it("fails safe: every lookup erroring still returns a result with nulls and reason codes, never throws", async () => {
    const boom = async () => {
      throw new Error("503");
    };
    const f = await collectRugFeatures(
      { rpc: { getAccount: boom, getTokenSupplyRaw: boom, getTokenAccountAmounts: boom, getSignatures: boom, getTokenBuys: boom, getOwnerBalance: boom }, meter: meter(), rugcheck: boom, ...DEPS },
      INPUT,
    );
    expect(f).toMatchObject({ poolProgram: null, pumpMigrated: null, lpStatus: null, holderCount: null, sniperSharePct: null, creatorHoldingPct: null, rugcheckScore: null });
    expect(f.reasons).toMatchObject({ pool: "rpc_error", pumpMigrated: "rpc_error", lp: "rpc_error", holderCount: "rpc_error", sniperShare: "rpc_error", creatorHolding: "no_creator", rugcheck: "rpc_error" });
  });

  it("credit guard: once the daily cap is reached the costly lookups record budget; it resets on a new trading day", async () => {
    const state = new StateStore(openDb(":memory:"));
    let now = Date.parse("2026-09-27T10:00:00+05:30");
    const m = () => new CreditMeter(state, "paper", 25, "Asia/Kolkata", () => now);
    const first = await collectRugFeatures({ rpc: fakeRpc(), meter: m(), ...DEPS }, INPUT);
    expect(first.holderCount).toBe(3);
    const second = await collectRugFeatures({ rpc: fakeRpc(), meter: m(), ...DEPS }, INPUT); // 19 of 25 already used today
    expect(second.reasons).toMatchObject({ holderCount: "budget", sniperShare: "budget" });
    now = Date.parse("2026-09-28T09:00:00+05:30");
    expect(m().usedToday()).toBe(0);
  });

  it("RugCheck: off means no call; on stores the summary; a 429 records null with a reason", async () => {
    const off = await collectRugFeatures({ rpc: fakeRpc(), meter: meter(), ...DEPS }, INPUT);
    expect(off.reasons.rugcheck).toBe("disabled");

    const fetchImpl = vi.fn(async (_url: string) => new Response(JSON.stringify({ score: 501, score_normalised: 12, lpLockedPct: 100, risks: [{ name: "Low Liquidity" }] }), { status: 200 }));
    const rugcheck = makeRugCheck({ logger: createMemoryLogger(), fetchImpl: fetchImpl as unknown as typeof fetch });
    const on = await collectRugFeatures({ rpc: fakeRpc(), meter: meter(), rugcheck, ...DEPS }, INPUT);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`https://api.rugcheck.xyz/v1/tokens/${MINT}/report/summary`);
    expect(on).toMatchObject({ rugcheckScore: 501, rugcheckScoreNormalised: 12, rugcheckLpLockedPct: 100, rugcheckRisks: [{ name: "Low Liquidity" }] });
    expect(on.creditsUsed).toBe(19); // no RPC credits for RugCheck

    const limited = makeRugCheck({ logger: createMemoryLogger(), fetchImpl: (async () => new Response("", { status: 429 })) as unknown as typeof fetch });
    const r = await collectRugFeatures({ rpc: fakeRpc(), meter: meter(), rugcheck: limited, ...DEPS }, INPUT);
    expect(r.reasons.rugcheck).toBe("rpc_error");
  });

  it("makeRugRpc sends read-only calls: transaction version 1, and a size filter only for SPL Token accounts", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const client = {
      getTransactionJsonParsed: async (sig: string) => (calls.push(["getTransaction", [sig]]), { meta: null }),
      getProgramAccounts: async (p: string, cfg: unknown) => (calls.push(["getProgramAccounts", [p, cfg]]), []),
    };
    const rpc = makeRugRpc(client as never);
    await rpc.getTokenBuys("sig", MINT, [CURVE]);
    await rpc.getTokenAccountAmounts(T2022, MINT);
    await rpc.getTokenAccountAmounts("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", MINT);
    const [, t2022Cfg] = calls[1]![1] as [string, { filters: unknown[] }];
    const [, splCfg] = calls[2]![1] as [string, { filters: unknown[] }];
    expect(t2022Cfg.filters).toEqual([{ memcmp: { offset: 0, bytes: MINT } }]);
    expect(splCfg.filters).toEqual([{ dataSize: 165 }, { memcmp: { offset: 0, bytes: MINT } }]);
  });
});

describe("mint_features storage and report", () => {
  it("stores one row per mint and mode, with reasons", async () => {
    const store = new MintFeaturesStore(openDb(":memory:"));
    const f = await collectRugFeatures({ rpc: fakeRpc(), meter: meter(), ...DEPS }, INPUT);
    expect(store.insertIfAbsent(MINT, "paper", 1000, f)).toBe(true);
    expect(store.insertIfAbsent(MINT, "paper", 2000, f)).toBe(false);
    expect(store.has(MINT, "paper")).toBe(true);
    expect(store.listAll("paper")[0]).toMatchObject({ mint: MINT, recordedAt: 1000, lpStatus: "burned", pumpMigrated: true, holderCount: 3, reasons: { rugcheck: "disabled" } });
  });

  const row = (mint: string, o: Partial<MintFeaturesRow>): MintFeaturesRow =>
    ({
      mint, mode: "paper", recordedAt: 0, poolProgram: PUMPSWAP_PROGRAM, poolCanonical: true, pumpMigrated: true, lpSupplyPool: "1", lpMintSupply: "0",
      lpStatus: "burned", lpBurnedPct: 100, lpLockedPct: 0, lpWithdrawablePct: 0, holderCount: 100, sniperSharePct: 10, sniperSlots: 3, sniperTxs: 2,
      sniperCapped: false, creator: CREATOR, creatorHoldingPct: 0, rugcheckScore: null, rugcheckScoreNormalised: null, rugcheckLpLockedPct: null,
      rugcheckRisks: null, reasons: { rugcheck: "disabled" }, creditsUsed: 19, ...o,
    }) as MintFeaturesRow;

  it("coverage shows how often each feature is null, by reason code", () => {
    const rows = [
      row("A", {}),
      row("B", { sniperSharePct: null, reasons: { sniperShare: "too_many_txs", rugcheck: "disabled" } }),
      row("C", { sniperSharePct: null, holderCount: null, reasons: { sniperShare: "budget", holderCount: "budget", rugcheck: "disabled" } }),
      row("D", { sniperSharePct: null, reasons: { sniperShare: "too_many_txs", rugcheck: "disabled" } }),
    ];
    const cov = rugCoverage(rows);
    expect(cov.find((c) => c.label === "sniper share")).toEqual({ label: "sniper share", nulls: 3, byReason: { too_many_txs: 2, budget: 1 } });
    expect(cov.find((c) => c.label === "RugCheck")).toEqual({ label: "RugCheck", nulls: 4, byReason: { disabled: 4 } });
    expect(cov.find((c) => c.label === "LP status")!.nulls).toBe(0);
  });

  it("prints coverage, quartiles over trades and breakdowns, joined by mint", () => {
    const rows = ["A", "B", "C", "D"].map((m, i) => row(m, { holderCount: (i + 1) * 100, sniperSharePct: i * 20, pumpMigrated: i < 3 }));
    const trades: TradeRecord[] = ["A", "B", "C", "D", "Z"].map((m, i) => ({
      mode: "paper", mint: m, exitTime: 0, tradingDay: "2026-09-27", exitReason: "stop", netPnlUsd: i % 2 ? 1 : -1, netPnlPct: i % 2 ? 4 : -4,
      m5ChangePct: null, h1ChangePct: null, buyPressurePct: null, liquidityUsd: null, pairAgeMs: (i + 1) * 60_000, top10Pct: null, score: null, scoreComponents: null,
    }));
    const text = formatRugSection(rows, trades).join("\n");
    expect(text).toContain("Rug-risk features (section 11.6): 4 mints recorded; 4 of 5 trades have them");
    expect(text).toContain("    sniper share: 0 of 4 null");
    expect(text).toContain("    RugCheck: 4 of 4 null (disabled 4)");
    expect(text).toContain("    holder count: Q1 [100..100] 1, 0%, -4.0% | Q2 [200..200] 1, 100%, 4.0% | Q3 [300..300] 1, 0%, -4.0% | Q4 [400..400] 1, 100%, 4.0%");
    expect(text).toContain("    RugCheck score: no data; missing 4");
    expect(text).toContain("    pump.fun migrated: no: 1 trades, win rate 100%, median 4.0% | yes: 3 trades, win rate 33%, median -4.0%");
  });
});
