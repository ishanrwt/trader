import type { StateStore } from "../storage/state.js";

const WALLET_KEY = "virtualWallet";

export interface WalletBalances {
  usdc: number;
  sol: number;
}

/** Virtual wallet for paper mode (SPEC.md section 7), persisted in the `state` table. */
export class VirtualWallet {
  private balances: WalletBalances;

  constructor(
    private readonly store: StateStore,
    seed: WalletBalances,
  ) {
    this.balances = this.store.get<WalletBalances>(WALLET_KEY, seed);
  }

  get(): WalletBalances {
    return { ...this.balances };
  }

  canAfford(usdcAmount: number): boolean {
    return this.balances.usdc >= usdcAmount;
  }

  debit(usdcAmount: number): void {
    this.balances = { ...this.balances, usdc: this.balances.usdc - usdcAmount };
    this.store.set(WALLET_KEY, this.balances);
  }

  credit(usdcAmount: number): void {
    this.balances = { ...this.balances, usdc: this.balances.usdc + usdcAmount };
    this.store.set(WALLET_KEY, this.balances);
  }
}
