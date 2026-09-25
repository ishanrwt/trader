import { USDC_MINT, WSOL_MINT } from "./programs.js";

export interface ReconcilePosition {
  id: number;
  mint: string;
  tokenAmountRaw: string | null;
}

export interface WalletTokenAccount {
  address: string;
  mint: string;
  amountRaw: bigint;
  program: string;
}

export interface UnresolvedIntentRef {
  mint: string;
  positionId: number | null;
}

export interface ReconcileResult {
  /** Zero on-chain balance, no landed sell, no unresolved intent: close as `reconciled`, proceeds 0, proceeds_unknown. */
  closeReconciled: number[];
  /** On-chain balance differs from the stored amount: adopt the on-chain amount. */
  updateAmount: Array<{ id: number; fromRaw: string | null; toRaw: string }>;
  /** Held tokens with no position and no intent: reported, never traded. */
  unknownTokens: Array<{ mint: string; amountRaw: bigint; accounts: string[] }>;
  /** Empty token accounts left open (excluding USDC and wrapped SOL). */
  emptyAccounts: number;
  /** Positions and mints skipped because an unresolved intent exists for them (addition B). */
  skippedForIntent: { positionIds: number[]; mints: string[] };
}

const IGNORED = new Set([USDC_MINT, WSOL_MINT]);

/**
 * SPEC.md section 16.5 reconciliation (pure). Runs after intent resolution.
 * USDC, SOL and wrapped SOL are ignored. Addition B: nothing is closed as
 * `reconciled`, and no tokens are reported as unknown, while an unresolved
 * intent exists for that position or mint.
 */
export function reconcile(input: { positions: readonly ReconcilePosition[]; tokenAccounts: readonly WalletTokenAccount[]; unresolved: readonly UnresolvedIntentRef[] }): ReconcileResult {
  const onChain = new Map<string, { amount: bigint; accounts: string[] }>();
  let emptyAccounts = 0;
  for (const a of input.tokenAccounts) {
    if (IGNORED.has(a.mint)) continue;
    if (a.amountRaw === 0n) emptyAccounts++;
    const cur = onChain.get(a.mint) ?? { amount: 0n, accounts: [] };
    onChain.set(a.mint, { amount: cur.amount + a.amountRaw, accounts: [...cur.accounts, a.address] });
  }

  const blockedPositions = new Set(input.unresolved.flatMap((u) => (u.positionId === null ? [] : [u.positionId])));
  const blockedMints = new Set(input.unresolved.map((u) => u.mint));
  const result: ReconcileResult = { closeReconciled: [], updateAmount: [], unknownTokens: [], emptyAccounts, skippedForIntent: { positionIds: [], mints: [] } };

  const positionMints = new Set<string>();
  for (const p of input.positions) {
    positionMints.add(p.mint);
    if (blockedPositions.has(p.id) || blockedMints.has(p.mint)) {
      result.skippedForIntent.positionIds.push(p.id);
      continue;
    }
    const amount = onChain.get(p.mint)?.amount ?? 0n;
    if (amount === 0n) {
      result.closeReconciled.push(p.id);
    } else if (p.tokenAmountRaw === null || BigInt(p.tokenAmountRaw) !== amount) {
      result.updateAmount.push({ id: p.id, fromRaw: p.tokenAmountRaw, toRaw: amount.toString() });
    }
  }

  for (const [mint, v] of onChain) {
    if (v.amount === 0n || positionMints.has(mint)) continue;
    if (blockedMints.has(mint)) {
      result.skippedForIntent.mints.push(mint);
      continue;
    }
    result.unknownTokens.push({ mint, amountRaw: v.amount, accounts: v.accounts });
  }
  return result;
}
