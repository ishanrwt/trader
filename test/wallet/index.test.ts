import { describe, expect, it } from "vitest";
import { VirtualWallet } from "../../src/wallet/index.js";
import { openDb } from "../../src/storage/db.js";
import { StateStore } from "../../src/storage/state.js";

function makeWallet(seed = { usdc: 500, sol: 0.5 }) {
  const db = openDb(":memory:");
  const store = new StateStore(db);
  return { wallet: new VirtualWallet(store, seed), store };
}

describe("VirtualWallet", () => {
  it("seeds from PAPER_STARTING_USDC / PAPER_STARTING_SOL on first use", () => {
    const { wallet } = makeWallet({ usdc: 500, sol: 0.5 });
    expect(wallet.get()).toEqual({ usdc: 500, sol: 0.5 });
  });

  it("debits and credits USDC", () => {
    const { wallet } = makeWallet({ usdc: 500, sol: 0.5 });
    wallet.debit(25.05);
    expect(wallet.get().usdc).toBeCloseTo(474.95);
    wallet.credit(30);
    expect(wallet.get().usdc).toBeCloseTo(504.95);
  });

  it("canAfford reflects the current balance", () => {
    const { wallet } = makeWallet({ usdc: 100, sol: 0 });
    expect(wallet.canAfford(100)).toBe(true);
    expect(wallet.canAfford(100.01)).toBe(false);
    wallet.debit(50);
    expect(wallet.canAfford(51)).toBe(false);
    expect(wallet.canAfford(50)).toBe(true);
  });

  it("persists balances across instances via the same StateStore", () => {
    const db = openDb(":memory:");
    const store = new StateStore(db);
    const wallet1 = new VirtualWallet(store, { usdc: 500, sol: 0.5 });
    wallet1.debit(25);

    const wallet2 = new VirtualWallet(store, { usdc: 500, sol: 0.5 }); // seed ignored, prior state wins
    expect(wallet2.get().usdc).toBe(475);
  });
});
