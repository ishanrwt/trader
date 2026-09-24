export interface DexTokenRef {
  address: string;
  name?: string;
  symbol?: string;
}

export interface DexTxnCounts {
  buys?: number;
  sells?: number;
}

export interface DexPair {
  chainId: string;
  dexId?: string;
  pairAddress: string;
  baseToken: DexTokenRef;
  quoteToken: DexTokenRef;
  priceUsd?: string;
  priceNative?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: { m5?: DexTxnCounts; h1?: DexTxnCounts; h6?: DexTxnCounts; h24?: DexTxnCounts };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

export interface TokenProfile {
  chainId: string;
  tokenAddress: string;
  description?: string;
  url?: string;
}
