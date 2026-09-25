/** Program and mint addresses the live module relies on (verified against current docs where they publish them). */
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA1knL";
/**
 * Jupiter's v6 aggregator program. The Swap V2 docs say /build's swap
 * instruction uses "V2 routing instructions in the Jupiter Aggregator
 * Program" but don't print its address; smoke-live's dry run confirms it (a
 * mismatch is a verification refusal naming the program, never a send).
 */
export const JUPITER_AGGREGATOR_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

export const TOKEN_PROGRAMS: ReadonlySet<string> = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);

/** Throws (fail closed, SPEC.md section 16.2 step 6) on a token program that is neither Token nor Token-2022. */
export function assertKnownTokenProgram(program: string): void {
  if (!TOKEN_PROGRAMS.has(program)) throw new Error(`Unknown token program ${program}: only Token and Token-2022 are supported.`);
}
