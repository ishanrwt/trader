import { describe, expect, it } from "vitest";
import { TOKEN_PROGRAM, USDC_MINT, WSOL_MINT } from "../../src/live/programs.js";
import { reconcile } from "../../src/live/reconcile.js";

const acct = (address: string, mint: string, amountRaw: bigint) => ({ address, mint, amountRaw, program: TOKEN_PROGRAM });

describe("reconcile (SPEC.md section 16.5)", () => {
  it("ignores USDC and wrapped SOL entirely", () => {
    const r = reconcile({ positions: [], tokenAccounts: [acct("U", USDC_MINT, 5n), acct("W", WSOL_MINT, 7n), acct("W0", WSOL_MINT, 0n)], unresolved: [] });
    expect(r).toEqual({ closeReconciled: [], updateAmount: [], unknownTokens: [], emptyAccounts: 0, skippedForIntent: { positionIds: [], mints: [] } });
  });

  it("reports tokens held with no position and no intent as unknown (never traded)", () => {
    const r = reconcile({ positions: [], tokenAccounts: [acct("A1", "X", 100n)], unresolved: [] });
    expect(r.unknownTokens).toEqual([{ mint: "X", amountRaw: 100n, accounts: ["A1"] }]);
  });

  it("closes a position with a zero on-chain balance as reconciled", () => {
    const r = reconcile({ positions: [{ id: 1, mint: "X", tokenAmountRaw: "100" }], tokenAccounts: [acct("A1", "X", 0n)], unresolved: [] });
    expect(r.closeReconciled).toEqual([1]);
    expect(r.emptyAccounts).toBe(1);
  });

  it("closes a position whose token account doesn't exist at all as reconciled", () => {
    expect(reconcile({ positions: [{ id: 1, mint: "X", tokenAmountRaw: "100" }], tokenAccounts: [], unresolved: [] }).closeReconciled).toEqual([1]);
  });

  it("adopts the on-chain amount when it differs from the stored amount", () => {
    const r = reconcile({ positions: [{ id: 1, mint: "X", tokenAmountRaw: "100" }], tokenAccounts: [acct("A1", "X", 90n)], unresolved: [] });
    expect(r.updateAmount).toEqual([{ id: 1, fromRaw: "100", toRaw: "90" }]);
    expect(r.closeReconciled).toEqual([]);
  });

  it("addition B: never closes a position as reconciled while an unresolved intent exists for it", () => {
    const r = reconcile({ positions: [{ id: 1, mint: "X", tokenAmountRaw: "100" }], tokenAccounts: [], unresolved: [{ mint: "X", positionId: 1 }] });
    expect(r.closeReconciled).toEqual([]);
    expect(r.skippedForIntent.positionIds).toEqual([1]);
  });

  it("addition B: never reports tokens as unknown while an unresolved intent exists for that mint (a buy in flight)", () => {
    const r = reconcile({ positions: [], tokenAccounts: [acct("A1", "Y", 500n)], unresolved: [{ mint: "Y", positionId: null }] });
    expect(r.unknownTokens).toEqual([]);
    expect(r.skippedForIntent.mints).toEqual(["Y"]);
  });
});
