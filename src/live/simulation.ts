import { TOKEN_PROGRAMS } from "./programs.js";

/**
 * The shape verification works on (SPEC.md section 16.2), produced either from
 * the simulation's own balance fields (primary) or by src/live/simFallback.ts.
 * Every constructor here fails closed: a missing or mistyped field throws
 * SimulationShapeError, which the caller turns into a refusal (never a send).
 */

export class SimulationShapeError extends Error {
  constructor(message: string) {
    super(`Unexpected simulation shape: ${message}`);
    this.name = "SimulationShapeError";
  }
}

export interface TokenAccountState {
  mint: string;
  owner: string;
  program: string;
  amount: bigint;
}

export interface PostTokenAccountState {
  mint: string;
  owner: string;
  program: string;
  delegate: string | null;
  closeAuthority: string | null;
}

export interface ParsedInnerInstruction {
  programId: string;
  /** Present when the RPC could parse it (jsonParsed); absent means "partially decoded". */
  parsed?: { type: string; info: Record<string, unknown> };
}

export interface NormalizedSimulation {
  source: "simulation" | "fallback";
  fee: bigint;
  unitsConsumed: bigint | null;
  /** Lamports before/after for every account the verifier may need (the wallet and every writable account). */
  lamports: Map<string, { pre: bigint; post: bigint }>;
  /** Token accounts on either side, keyed by token-account address. null = didn't exist on that side. */
  tokens: Map<string, { pre: TokenAccountState | null; post: TokenAccountState | null }>;
  /** Parsed post-state of the requested accounts that are token accounts (owner/delegate/close authority). */
  postTokenAccounts: Map<string, PostTokenAccountState>;
  inner: ParsedInnerInstruction[];
}

export function asObject(v: unknown, what: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new SimulationShapeError(`${what} is not an object`);
  return v as Record<string, unknown>;
}

export function asArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new SimulationShapeError(`${what} is missing or not an array`);
  return v;
}

export function asString(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) throw new SimulationShapeError(`${what} is missing or not a string`);
  return v;
}

export function asU64(v: unknown, what: string): bigint {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "bigint" && v >= 0n) return v;
  throw new SimulationShapeError(`${what} is missing or not a non-negative integer`);
}

function tokenBalanceEntry(v: unknown, accountKeys: readonly string[], what: string): { address: string; state: TokenAccountState } {
  const o = asObject(v, what);
  const index = o.accountIndex;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= accountKeys.length) {
    throw new SimulationShapeError(`${what}.accountIndex is out of range`);
  }
  const program = asString(o.programId, `${what}.programId`);
  if (!TOKEN_PROGRAMS.has(program)) throw new SimulationShapeError(`${what} has unknown token program ${program}`);
  const ui = asObject(o.uiTokenAmount, `${what}.uiTokenAmount`);
  return {
    address: accountKeys[index]!,
    state: { mint: asString(o.mint, `${what}.mint`), owner: asString(o.owner, `${what}.owner`), program, amount: asU64(ui.amount, `${what}.uiTokenAmount.amount`) },
  };
}

/** Parses one jsonParsed account (getMultipleAccounts value entry or simulation `accounts` entry). null = account doesn't exist. */
export function parseAccount(v: unknown, what: string): { lamports: bigint; owner: string; token: (TokenAccountState & PostTokenAccountState) | null } | null {
  if (v === null) return null;
  const o = asObject(v, what);
  const lamports = asU64(o.lamports, `${what}.lamports`);
  const owner = asString(o.owner, `${what}.owner`);
  if (!TOKEN_PROGRAMS.has(owner)) return { lamports, owner, token: null };
  const data = asObject(o.data, `${what}.data (token account must be jsonParsed)`);
  const parsed = asObject(data.parsed, `${what}.data.parsed`);
  if (parsed.type !== "account") {
    // A mint or multisig owned by a token program: not a token account, lamports only.
    if (parsed.type === "mint" || parsed.type === "multisig") return { lamports, owner, token: null };
    throw new SimulationShapeError(`${what} has unknown token account type ${String(parsed.type)}`);
  }
  const info = asObject(parsed.info, `${what}.data.parsed.info`);
  const tokenAmount = asObject(info.tokenAmount, `${what}.tokenAmount`);
  const delegate = info.delegate === undefined || info.delegate === null ? null : asString(info.delegate, `${what}.delegate`);
  const closeAuthority = info.closeAuthority === undefined || info.closeAuthority === null ? null : asString(info.closeAuthority, `${what}.closeAuthority`);
  return {
    lamports,
    owner,
    token: {
      mint: asString(info.mint, `${what}.mint`),
      owner: asString(info.owner, `${what}.owner`),
      program: owner,
      amount: asU64(tokenAmount.amount, `${what}.tokenAmount.amount`),
      delegate,
      closeAuthority,
    },
  };
}

export function parseInner(v: unknown): ParsedInnerInstruction[] {
  const groups = asArray(v, "innerInstructions");
  const out: ParsedInnerInstruction[] = [];
  for (const [gi, g] of groups.entries()) {
    const group = asObject(g, `innerInstructions[${gi}]`);
    for (const [ii, ix] of asArray(group.instructions, `innerInstructions[${gi}].instructions`).entries()) {
      const o = asObject(ix, `innerInstructions[${gi}].instructions[${ii}]`);
      const programId = asString(o.programId, `innerInstructions[${gi}].instructions[${ii}].programId`);
      if (o.parsed !== undefined && o.parsed !== null && typeof o.parsed === "object") {
        const p = o.parsed as Record<string, unknown>;
        out.push({ programId, parsed: { type: asString(p.type, "parsed.type"), info: asObject(p.info, "parsed.info") } });
      } else {
        out.push({ programId });
      }
    }
  }
  return out;
}

/** True when the RPC returned all four balance fields (the primary path is usable). */
export function hasBalanceFields(value: Record<string, unknown>): boolean {
  return ["preBalances", "postBalances", "preTokenBalances", "postTokenBalances"].every((k) => Array.isArray(value[k]));
}

/**
 * Primary path: builds the normalized form from the simulation's own
 * `pre/postBalances` and `pre/postTokenBalances` (indexed by the transaction's
 * full account-key list: static keys, then lookup-table writable, then
 * readonly) and the requested `accounts` post-state.
 */
export function normalizeSimulation(raw: unknown, accountKeys: readonly string[], requested: readonly string[]): NormalizedSimulation {
  const value = asObject(raw, "simulation value");
  if (value.err !== null) throw new SimulationShapeError(`simulation returned an error: ${JSON.stringify(value.err)}`);
  if (!hasBalanceFields(value)) throw new SimulationShapeError("balance fields are missing (use the fallback)");
  const fee = asU64(value.fee, "fee");
  const pre = asArray(value.preBalances, "preBalances");
  const post = asArray(value.postBalances, "postBalances");
  if (pre.length !== accountKeys.length || post.length !== accountKeys.length) {
    throw new SimulationShapeError(`balance arrays (${pre.length}/${post.length}) don't match the ${accountKeys.length} account keys`);
  }
  const lamports = new Map<string, { pre: bigint; post: bigint }>();
  accountKeys.forEach((key, i) => lamports.set(key, { pre: asU64(pre[i], `preBalances[${i}]`), post: asU64(post[i], `postBalances[${i}]`) }));

  const tokens = new Map<string, { pre: TokenAccountState | null; post: TokenAccountState | null }>();
  for (const [i, e] of asArray(value.preTokenBalances, "preTokenBalances").entries()) {
    const { address, state } = tokenBalanceEntry(e, accountKeys, `preTokenBalances[${i}]`);
    tokens.set(address, { pre: state, post: tokens.get(address)?.post ?? null });
  }
  for (const [i, e] of asArray(value.postTokenBalances, "postTokenBalances").entries()) {
    const { address, state } = tokenBalanceEntry(e, accountKeys, `postTokenBalances[${i}]`);
    tokens.set(address, { pre: tokens.get(address)?.pre ?? null, post: state });
  }

  const accounts = asArray(value.accounts, "accounts (post-state of requested accounts)");
  if (accounts.length !== requested.length) throw new SimulationShapeError(`accounts has ${accounts.length} entries for ${requested.length} requested`);
  const postTokenAccounts = new Map<string, PostTokenAccountState>();
  requested.forEach((addr, i) => {
    const acct = parseAccount(accounts[i], `accounts[${i}]`);
    if (acct?.token) postTokenAccounts.set(addr, acct.token);
  });

  return {
    source: "simulation",
    fee,
    unitsConsumed: value.unitsConsumed === null || value.unitsConsumed === undefined ? null : asU64(value.unitsConsumed, "unitsConsumed"),
    lamports,
    tokens,
    postTokenAccounts,
    inner: parseInner(value.innerInstructions),
  };
}
