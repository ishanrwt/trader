import { describe, expect, it } from "vitest";
import { entryPairFields, formatTradeDetail, tradeRowToDetailRecord } from "../../src/report/index.js";
import { openDb } from "../../src/storage/db.js";
import { TradesStore, type NewTradeRow, type TradeRow } from "../../src/storage/trades.js";

// Trade 21 (GOINU) as stored in trader.db, trimmed to the snapshot fields section 11.1 lists.
const GOINU_SNAPSHOT = {
  chainId: "solana",
  dexId: "pumpswap",
  pairAddress: "FnPXX7ueFaYmkWPQqfTjJUoMzRsreF6WxuWVk7biLZAY",
  txns: { m5: { buys: 1190, sells: 138 }, h1: { buys: 3537, sells: 588 } },
  volume: { h24: 337753.43, h6: 337753.43, h1: 337753.43, m5: 40482.57 },
  priceChange: { m5: 16.9, h1: 141, h6: 141, h24: 141 },
  liquidity: { usd: 40663.34 },
  fdv: 213126,
  pairCreatedAt: 1790292630000,
};
const ENTRY_TIME = 1790293844150;

function goinu(overrides: Partial<NewTradeRow> = {}): NewTradeRow {
  return {
    mode: "paper",
    mint: "GFcaDvCXpgfsMMd9ciMd7YvgdqRsne29nVoj5ThQpump",
    symbol: "GOINU",
    pairAddress: "FnPXX7ueFaYmkWPQqfTjJUoMzRsreF6WxuWVk7biLZAY",
    entryTime: ENTRY_TIME,
    exitTime: 1790293996291,
    sizeUsd: 25,
    costBasis: 25.05,
    proceeds: 18.775195339999996,
    netPnlUsd: -6.2748046600000045,
    netPnlPct: -25.049120399201612,
    exitReason: "stop",
    peakPnl: 4.223716566866265,
    timerRestarts: 1,
    targetExtensions: 2,
    feesUsd: 0.1,
    entryPairSnapshot: GOINU_SNAPSHOT,
    top1Pct: 1.504060762820311,
    top10Pct: 13.866165494397848,
    score: 0.7656150142057461,
    scoreComponents: { buyPressure: 0.8960843373493976, activity: 1, momentum: 0.7895, depth: 0.46824673514038595, holders: 0.6533458626400538, freshness: 0.48122333333333334 },
    animalFlag: null,
    tradingDay: "2026-09-25",
    dexId: "pumpswap",
    tokenAmount: 118971.28809762,
    tokenDecimals: 6,
    entryValuationPnlPct: -7.410159680638727,
    entryQuoteInAmount: "25000000",
    entryQuoteOutAmount: "121399273569",
    exitQuoteInAmount: "118971288098",
    exitQuoteOutAmount: "19209383",
    ...overrides,
  };
}

function storedRow(overrides: Partial<NewTradeRow> = {}): TradeRow {
  const store = new TradesStore(openDb(":memory:"));
  return store.get(store.insert(goinu(overrides)))!;
}

describe("entryPairFields", () => {
  it("reads every section 11.1 snapshot field and derives pair age from pairCreatedAt", () => {
    expect(entryPairFields(GOINU_SNAPSHOT, ENTRY_TIME)).toEqual({
      priceChangeM5: 16.9,
      priceChangeH1: 141,
      priceChangeH24: 141,
      volumeM5: 40482.57,
      volumeH1: 337753.43,
      buysM5: 1190,
      sellsM5: 138,
      liquidityUsd: 40663.34,
      pairAgeMin: (ENTRY_TIME - 1790292630000) / 60_000,
      fdv: 213126,
    });
  });

  it("a field the snapshot lacks is null, never 0; no snapshot at all is null", () => {
    const fields = entryPairFields({ liquidity: { usd: 1000 }, priceChange: { m5: 0 } }, ENTRY_TIME)!;
    expect(fields.liquidityUsd).toBe(1000);
    expect(fields.priceChangeM5).toBe(0); // a real zero stays zero
    expect(fields.priceChangeH1).toBeNull();
    expect(fields.volumeM5).toBeNull();
    expect(fields.buysM5).toBeNull();
    expect(fields.pairAgeMin).toBeNull();
    expect(fields.fdv).toBeNull();
    expect(entryPairFields(null, ENTRY_TIME)).toBeNull();
  });
});

describe("report --trades: every section 11.1 field, from a stored trade row", () => {
  it("prints mode, pair, dex, trading day, restarts, extensions, fees, the full entry pair snapshot, holders, animal flag, and score with all six named components", () => {
    const text = formatTradeDetail([tradeRowToDetailRecord(storedRow(), [])]);
    expect(text).toContain("  mode: paper  pair: FnPXX7ueFaYmkWPQqfTjJUoMzRsreF6WxuWVk7biLZAY  dex: pumpswap  trading day: 2026-09-25");
    expect(text).toContain("  timer restarts: 1  target extensions: 2  fees (total): $0.1000");
    expect(text).toContain(
      "  entry pair: change m5 16.90% h1 141.00% h24 141.00% | volume m5 $40482.57 h1 $337753.43 | m5 buys 1190 sells 138 | liquidity $40663.34 | pair age 20.2m | fdv $213126",
    );
    expect(text).toContain("  holders: top1 1.50%  top10 13.87%  animal flag: n/a");
    expect(text).toContain(
      "  score: 0.7656 (buyPressure 0.8961, activity 1.0000, momentum 0.7895, depth 0.4682, holders 0.6533, freshness 0.4812)",
    );
  });

  it("prints the sellability round-trip loss with when it was checked relative to entry", () => {
    const row = storedRow({ sellabilityLossPct: 3.125, sellabilityCheckedAt: ENTRY_TIME - 12_300 });
    const text = formatTradeDetail([tradeRowToDetailRecord(row, [])]);
    expect(text).toContain(`  sellability round-trip loss: 3.13% (checked ${new Date(ENTRY_TIME - 12_300).toISOString()}, 12.3s before entry)`);
  });

  it("prints the stop's triggering poll pnlPct and the confirmation pnlPct", () => {
    const text = formatTradeDetail([tradeRowToDetailRecord(storedRow({ stopPollPnlPct: -16.4, stopConfirmPnlPct: -17.02 }), [])]);
    expect(text).toContain("  stop confirmation: triggering poll -16.40%, confirmation -17.02%");
  });

  it("a no-route confirmation prints as such, not as a number", () => {
    const text = formatTradeDetail([tradeRowToDetailRecord(storedRow({ stopPollPnlPct: -16.4, stopConfirmPnlPct: null }), [])]);
    expect(text).toContain("  stop confirmation: triggering poll -16.40%, confirmation no route (treated as confirmed)");
  });

  it("a non-stop exit prints stop confirmation as n/a, not 'not recorded'", () => {
    const text = formatTradeDetail([tradeRowToDetailRecord(storedRow({ exitReason: "target" }), [])]);
    expect(text).toContain("  stop confirmation: n/a (not a stop exit)");
  });

  it("an old trade (before migration 0005): only the sellability and stop values say 'not recorded'; dex still prints", () => {
    const text = formatTradeDetail([tradeRowToDetailRecord(storedRow(), [])]); // dexId set (backfilled), the rest never recorded
    expect(text).toContain("  sellability round-trip loss: not recorded");
    expect(text).toContain("  stop confirmation: not recorded");
    expect(text).toContain("dex: pumpswap");
    expect(text.match(/not recorded/g)).toHaveLength(2);
  });

  it("missing holders, score and components print n/a", () => {
    const text = formatTradeDetail([tradeRowToDetailRecord(storedRow({ top1Pct: null, top10Pct: null, score: null, scoreComponents: null, pairAddress: null }), [])]);
    expect(text).toContain("  holders: top1 n/a  top10 n/a  animal flag: n/a");
    expect(text).toContain("  score: n/a (components: n/a)");
    expect(text).toContain("  mode: paper  pair: n/a");
  });
});
