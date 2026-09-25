import { generateKeyPairSigner, getSignatureFromTransaction, getTransactionDecoder, type KeyPairSigner } from "@solana/kit";
import type { JupiterBuildParams, JupiterBuildResponse } from "../../src/clients/jupiter.js";
import { associatedTokenAddress, decodeForVerification } from "../../src/live/assemble.js";
import { decodeComputeBudget, encodeSetComputeUnitPrice, priorityFeeLamports } from "../../src/live/instructions.js";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  JUPITER_AGGREGATOR_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_PROGRAMS,
  USDC_MINT,
  WSOL_MINT,
} from "../../src/live/programs.js";
import type { SignatureStatus } from "../../src/live/txRpc.js";

export const RENT = 2_039_280n;
const DEX_LAMPORTS = 5_000_000n;

type Outcome = "landed" | "failed" | "never";
type Side = "buy" | "sell" | "usdcToSol" | "solToUsdc";

interface Effects {
  keys: string[];
  pre: Map<string, bigint>;
  post: Map<string, bigint>;
  preTok: Map<string, { mint: string; amount: bigint; program: string }>;
  postTok: Map<string, { mint: string; amount: bigint; program: string }>;
  fee: bigint;
  closesTokenAta: boolean;
  side: Side;
  tokensDelta: bigint;
  usdcDelta: bigint;
}

/**
 * A tiny in-memory stand-in for the RPC + Jupiter /build, just enough for the
 * live executor's end-to-end tests. It decodes the exact bytes the executor
 * builds, derives the compute-budget fee from them, and produces simulation
 * and confirmed-transaction results whose balance changes match.
 */
export class FakeChain {
  wallet!: KeyPairSigner;
  mint!: string;
  pool!: string;
  usdcAta!: string;
  tokenAta!: string;
  wsolTemp!: string;
  tokenProgram: string = TOKEN_PROGRAM;
  /** smoke-live leg 1: SOL received for 1 USDC; leg 2: USDC received for the SOL. */
  solOut = 6_000_000n;
  usdcBackOut = 990_000n;

  lamports = 1_000_000_000n;
  usdc = 100_000_000n;
  tokens = 0n;
  tokenAtaExists = false;

  /** Buy: tokens actually received (may differ from the quote). Sell: USDC actually received. */
  actualBuyOut = 990_000n;
  quotedBuyOut = 1_000_000n;
  actualSellOut = 30_000_000n;
  /** Script knobs */
  estimateError: unknown = null;
  failWhenClose = false;
  omitBalanceFields = false;
  leakLamports = 0n;
  statusFor: (signature: string) => Outcome = () => "landed";
  buildThrows = false;

  height = 0;
  readonly sends: string[] = [];
  readonly builds: JupiterBuildParams[] = [];
  simulateCalls = 0;
  preReads = 0;
  private readonly bySignature = new Map<string, Effects>();
  private readonly applied = new Set<string>();
  private readonly sent = new Set<string>();
  private trade: { side: Side; amountIn: bigint } | null = null;

  static async create(tokenProgram = TOKEN_PROGRAM): Promise<FakeChain> {
    const c = new FakeChain();
    c.tokenProgram = tokenProgram;
    c.wallet = await generateKeyPairSigner();
    c.mint = (await generateKeyPairSigner()).address;
    c.pool = (await generateKeyPairSigner()).address;
    c.usdcAta = await associatedTokenAddress(c.wallet.address, USDC_MINT, TOKEN_PROGRAM);
    c.tokenAta = await associatedTokenAddress(c.wallet.address, c.mint, tokenProgram);
    c.wsolTemp = await associatedTokenAddress(c.wallet.address, WSOL_MINT, TOKEN_PROGRAM);
    return c;
  }

  // ------------------------------------------------------------------ Jupiter /build

  jupiter = {
    build: async (p: JupiterBuildParams): Promise<JupiterBuildResponse> => {
      this.builds.push(p);
      if (this.buildThrows) throw new Error("400 No routes found");
      const side: Side = p.outputMint === WSOL_MINT ? "usdcToSol" : p.inputMint === WSOL_MINT ? "solToUsdc" : p.inputMint === USDC_MINT ? "buy" : "sell";
      this.trade = { side, amountIn: BigInt(p.amount) };
      const out = side === "buy" ? this.quotedBuyOut : side === "sell" ? this.actualSellOut : side === "usdcToSol" ? this.solOut : this.usdcBackOut;
      if (side === "usdcToSol" || side === "solToUsdc") return this.solLegBuild(p, side, out);
      const acct = (pubkey: string, isSigner = false, isWritable = true) => ({ pubkey, isSigner, isWritable });
      const setup =
        side === "buy"
          ? [{ programId: ASSOCIATED_TOKEN_PROGRAM, accounts: [acct(this.wallet.address, true), acct(this.tokenAta), acct(this.wallet.address, false, false), acct(this.mint, false, false), acct(SYSTEM_PROGRAM, false, false), acct(this.tokenProgram, false, false)], data: Buffer.from([1]).toString("base64") }]
          : [];
      return {
        inputMint: p.inputMint,
        outputMint: p.outputMint,
        inAmount: p.amount,
        outAmount: out.toString(),
        otherAmountThreshold: ((out * 97n) / 100n).toString(),
        computeBudgetInstructions: [{ programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: Buffer.from(encodeSetComputeUnitPrice(1_000n)).toString("base64") }],
        setupInstructions: setup,
        swapInstruction: {
          programId: JUPITER_AGGREGATOR_PROGRAM,
          accounts: [acct(this.wallet.address, true), acct(this.usdcAta), acct(this.tokenAta), acct(this.pool)],
          data: Buffer.from([1, 2, 3]).toString("base64"),
        },
        cleanupInstruction: null,
        otherInstructions: [],
        tipInstruction: null,
        addressesByLookupTableAddress: null,
        blockhashWithMetadata: { blockhash: Array.from({ length: 32 }, (_, i) => i + 7), lastValidBlockHeight: 1_000 },
      };
    },
  };

  private solLegBuild(p: JupiterBuildParams, side: Side, out: bigint): JupiterBuildResponse {
    const acct = (pubkey: string, isSigner = false, isWritable = true) => ({ pubkey, isSigner, isWritable });
    const createTemp = { programId: ASSOCIATED_TOKEN_PROGRAM, accounts: [acct(this.wallet.address, true), acct(this.wsolTemp), acct(this.wallet.address, false, false), acct(WSOL_MINT, false, false), acct(SYSTEM_PROGRAM, false, false), acct(TOKEN_PROGRAM, false, false)], data: Buffer.from([1]).toString("base64") };
    const setup = [createTemp];
    if (side === "solToUsdc") {
      const data = Buffer.alloc(12);
      data.writeUInt32LE(2, 0);
      data.writeBigUInt64LE(BigInt(p.amount), 4);
      setup.push({ programId: SYSTEM_PROGRAM, accounts: [acct(this.wallet.address, true), acct(this.wsolTemp)], data: data.toString("base64") });
      setup.push({ programId: TOKEN_PROGRAM, accounts: [acct(this.wsolTemp)], data: Buffer.from([17]).toString("base64") });
    }
    return {
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      inAmount: p.amount,
      outAmount: out.toString(),
      otherAmountThreshold: ((out * 97n) / 100n).toString(),
      computeBudgetInstructions: [{ programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: Buffer.from(encodeSetComputeUnitPrice(1_000n)).toString("base64") }],
      setupInstructions: setup,
      swapInstruction: { programId: JUPITER_AGGREGATOR_PROGRAM, accounts: [acct(this.wallet.address, true), acct(this.usdcAta), acct(this.wsolTemp), acct(this.pool)], data: Buffer.from([1, 2, 3]).toString("base64") },
      cleanupInstruction: { programId: TOKEN_PROGRAM, accounts: [acct(this.wsolTemp), acct(this.wallet.address), acct(this.wallet.address, true, false)], data: Buffer.from([9]).toString("base64") },
      otherInstructions: [],
      tipInstruction: null,
      addressesByLookupTableAddress: null,
      blockhashWithMetadata: { blockhash: Array.from({ length: 32 }, (_, i) => i + 7), lastValidBlockHeight: 1_000 },
    };
  }

  // ------------------------------------------------------------------ RPC

  private decode(b64: string) {
    const tx = getTransactionDecoder().decode(Buffer.from(b64, "base64"));
    return { tx, ...decodeForVerification(tx, {}) };
  }

  private effectsFor(b64: string): Effects {
    const { decoded, accountKeys } = this.decode(b64);
    let limit = 200_000;
    let price = 0n;
    for (const ix of decoded.instructions) {
      if (ix.programId !== COMPUTE_BUDGET_PROGRAM) continue;
      const d = decodeComputeBudget(ix.data);
      if (d.kind === "limit") limit = d.units;
      if (d.kind === "price") price = d.microLamports;
    }
    const fee = 5_000n + priorityFeeLamports(price, limit);
    const closesTokenAta = decoded.instructions.some((ix) => TOKEN_PROGRAMS.has(ix.programId) && ix.data.length === 1 && ix.data[0] === 9 && ix.accounts[0]?.address === this.tokenAta);
    const side = this.trade!.side;
    const pre = new Map<string, bigint>();
    const post = new Map<string, bigint>();
    for (const k of accountKeys) {
      const base = k === this.wallet.address ? this.lamports : k === this.usdcAta ? RENT : k === this.tokenAta ? (this.tokenAtaExists ? RENT : 0n) : DEX_LAMPORTS;
      pre.set(k, base);
      post.set(k, base);
    }
    const preTok = new Map<string, { mint: string; amount: bigint; program: string }>();
    preTok.set(this.usdcAta, { mint: USDC_MINT, amount: this.usdc, program: TOKEN_PROGRAM });
    if (this.tokenAtaExists) preTok.set(this.tokenAta, { mint: this.mint, amount: this.tokens, program: this.tokenProgram });
    const postTok = new Map(preTok);
    let tokensDelta = 0n;
    let usdcDelta = 0n;
    if (side === "usdcToSol" || side === "solToUsdc") {
      // The temporary wSOL account is created and closed within the transaction: 0 lamports before and after.
      post.set(this.wsolTemp, 0n);
      pre.set(this.wsolTemp, 0n);
      if (side === "usdcToSol") {
        usdcDelta = -this.trade!.amountIn;
        post.set(this.wallet.address, this.lamports - fee + this.solOut - this.leakLamports);
      } else {
        usdcDelta = this.usdcBackOut;
        post.set(this.wallet.address, this.lamports - fee - this.trade!.amountIn - this.leakLamports);
      }
      postTok.set(this.usdcAta, { mint: USDC_MINT, amount: this.usdc + usdcDelta, program: TOKEN_PROGRAM });
    } else if (side === "buy") {
      usdcDelta = -this.trade!.amountIn;
      tokensDelta = this.actualBuyOut;
      const rent = this.tokenAtaExists ? 0n : RENT;
      post.set(this.wallet.address, this.lamports - fee - rent - this.leakLamports);
      post.set(this.tokenAta, RENT);
      postTok.set(this.usdcAta, { mint: USDC_MINT, amount: this.usdc + usdcDelta, program: TOKEN_PROGRAM });
      postTok.set(this.tokenAta, { mint: this.mint, amount: this.tokens + tokensDelta, program: this.tokenProgram });
    } else {
      tokensDelta = -this.trade!.amountIn;
      usdcDelta = this.actualSellOut;
      post.set(this.wallet.address, this.lamports - fee + (closesTokenAta ? RENT : 0n) - this.leakLamports);
      postTok.set(this.usdcAta, { mint: USDC_MINT, amount: this.usdc + usdcDelta, program: TOKEN_PROGRAM });
      if (closesTokenAta) {
        post.set(this.tokenAta, 0n);
        postTok.delete(this.tokenAta);
      } else {
        postTok.set(this.tokenAta, { mint: this.mint, amount: this.tokens + tokensDelta, program: this.tokenProgram });
      }
    }
    return { keys: accountKeys, pre, post, preTok, postTok, fee, closesTokenAta, side, tokensDelta, usdcDelta };
  }

  private parsedAccount(address: string, lamports: bigint, tok: { mint: string; amount: bigint; program: string } | undefined): unknown {
    if (lamports === 0n) return null;
    if (address === this.wallet.address) return { lamports: Number(lamports), owner: SYSTEM_PROGRAM, data: ["", "base64"], executable: false, rentEpoch: 0 };
    if (tok) {
      return {
        lamports: Number(lamports),
        owner: tok.program,
        data: { program: "spl-token", parsed: { type: "account", info: { mint: tok.mint, owner: this.wallet.address, tokenAmount: { amount: tok.amount.toString(), decimals: 6 }, state: "initialized" } }, space: 165 },
        executable: false,
        rentEpoch: 0,
      };
    }
    return { lamports: Number(lamports), owner: "Dex1111111111111111111111111111111111111111", data: ["", "base64"], executable: false, rentEpoch: 0 };
  }

  private tokenBalances(e: Effects, side: "pre" | "post") {
    const map = side === "pre" ? e.preTok : e.postTok;
    return [...map.entries()].flatMap(([addr, t]) => {
      const i = e.keys.indexOf(addr);
      return i < 0 ? [] : [{ accountIndex: i, mint: t.mint, owner: this.wallet.address, programId: t.program, uiTokenAmount: { amount: t.amount.toString(), decimals: 6 } }];
    });
  }

  rpc = {
    simulate: async (b64: string, cfg: { sigVerify: boolean; replaceRecentBlockhash: boolean; accounts?: readonly string[] }): Promise<Record<string, unknown>> => {
      this.simulateCalls++;
      const e = this.effectsFor(b64);
      if (!cfg.sigVerify) {
        const err = this.estimateError ?? (this.failWhenClose && e.closesTokenAta ? { InstructionError: [4, { Custom: 11 }] } : null);
        return { err, unitsConsumed: 150_000, logs: [] };
      }
      const { tx } = this.decode(b64);
      this.bySignature.set(getSignatureFromTransaction(tx), e);
      const value: Record<string, unknown> = {
        err: null,
        fee: Number(e.fee),
        unitsConsumed: 150_000,
        accounts: (cfg.accounts ?? []).map((a) => this.parsedAccount(a, e.post.get(a) ?? 0n, e.postTok.get(a))),
        innerInstructions: [],
      };
      if (!this.omitBalanceFields) {
        value.preBalances = e.keys.map((k) => Number(e.pre.get(k)));
        value.postBalances = e.keys.map((k) => Number(e.post.get(k)));
        value.preTokenBalances = this.tokenBalances(e, "pre");
        value.postTokenBalances = this.tokenBalances(e, "post");
      }
      return value;
    },
    sendTransaction: async (b64: string): Promise<string> => {
      const { tx } = this.decode(b64);
      const sig = getSignatureFromTransaction(tx);
      this.sends.push(sig);
      this.sent.add(sig);
      return sig;
    },
    getSignatureStatuses: async (sigs: readonly string[], _history: boolean): Promise<SignatureStatus[]> =>
      sigs.map((s) => {
        if (!this.sent.has(s)) return null;
        const o = this.statusFor(s);
        if (o === "never") return null;
        this.apply(s, o);
        return { confirmationStatus: "confirmed", err: o === "failed" ? { InstructionError: [2, { Custom: 6001 }] } : null };
      }),
    getBlockHeight: async (): Promise<number> => (this.height += 100),
    getTransaction: async (sig: string): Promise<Record<string, unknown> | null> => {
      const e = this.bySignature.get(sig);
      if (!e || !this.sent.has(sig)) return null;
      const failed = this.statusFor(sig) === "failed";
      const postBal = e.keys.map((k) => Number(failed ? (k === this.wallet.address ? e.pre.get(k)! - e.fee : e.pre.get(k)) : e.post.get(k)));
      return {
        slot: 10,
        blockTime: 1_700_000_000,
        meta: {
          err: failed ? { InstructionError: [2, { Custom: 6001 }] } : null,
          fee: Number(e.fee),
          preBalances: e.keys.map((k) => Number(e.pre.get(k))),
          postBalances: postBal,
          preTokenBalances: this.tokenBalances(e, "pre"),
          postTokenBalances: failed ? this.tokenBalances(e, "pre") : this.tokenBalances(e, "post"),
        },
        transaction: { message: { accountKeys: e.keys.map((k) => ({ pubkey: k })) } },
      };
    },
    getMultipleAccounts: async (addresses: readonly string[]): Promise<unknown[]> => {
      this.preReads++;
      return addresses.map((a) => {
        if (a === this.mint) return { lamports: 1_461_600, owner: this.tokenProgram, data: { program: "spl-token", parsed: { type: "mint", info: { decimals: 6 } } } };
        if (a === this.wallet.address) return this.parsedAccount(a, this.lamports, undefined);
        if (a === this.usdcAta) return this.parsedAccount(a, RENT, { mint: USDC_MINT, amount: this.usdc, program: TOKEN_PROGRAM });
        if (a === this.tokenAta) return this.tokenAtaExists ? this.parsedAccount(a, RENT, { mint: this.mint, amount: this.tokens, program: this.tokenProgram }) : null;
        return this.parsedAccount(a, DEX_LAMPORTS, undefined);
      });
    },
    getTokenAccountsByOwner: async (_owner: string, program: string): Promise<Array<{ pubkey: string; account: unknown }>> => {
      const out: Array<{ pubkey: string; account: unknown }> = [];
      if (program === TOKEN_PROGRAM) out.push({ pubkey: this.usdcAta, account: this.parsedAccount(this.usdcAta, RENT, { mint: USDC_MINT, amount: this.usdc, program: TOKEN_PROGRAM }) });
      if (this.tokenAtaExists && program === this.tokenProgram) out.push({ pubkey: this.tokenAta, account: this.parsedAccount(this.tokenAta, RENT, { mint: this.mint, amount: this.tokens, program: this.tokenProgram }) });
      return out;
    },
  };

  /** Applies a landed or failed transaction's effects to the chain state once. */
  private apply(sig: string, o: Outcome): void {
    if (this.applied.has(sig)) return;
    const e = this.bySignature.get(sig);
    if (!e) return;
    this.applied.add(sig);
    this.lamports -= e.fee;
    if (o !== "landed") return;
    this.lamports = e.post.get(this.wallet.address)!;
    this.usdc += e.usdcDelta;
    this.tokens += e.tokensDelta;
    if (e.side === "buy") this.tokenAtaExists = true;
    if (e.side === "usdcToSol" || e.side === "solToUsdc") this.tokens -= e.tokensDelta; // no token change on SOL legs
    if (e.closesTokenAta) this.tokenAtaExists = false;
  }

  /** Marks a signature as sent without going through sendTransaction (a transaction sent before a crash). */
  markSent(sig: string): void {
    this.sent.add(sig);
  }
}
