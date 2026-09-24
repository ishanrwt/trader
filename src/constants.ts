export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;
export const SOLANA_CHAIN_ID = "solana";

// Well-known Solana program IDs (verify against current SPL docs, same caveat
// as SPEC.md section 13's ALLOWED_QUOTE_MINTS comment).
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SPL_TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Known burn/incinerator addresses excluded from holder-share math (section 5, check 8). Verify/extend as needed. */
export const KNOWN_BURN_ADDRESSES: readonly string[] = [
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111111111111",
];
