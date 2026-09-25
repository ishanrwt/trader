import { SYSTEM_PROGRAM, TOKEN_PROGRAMS } from "./programs.js";
import {
  asArray,
  asObject,
  asU64,
  parseAccount,
  parseInner,
  SimulationShapeError,
  type NormalizedSimulation,
  type PostTokenAccountState,
  type TokenAccountState,
} from "./simulation.js";

/**
 * SPEC.md section 16.2 check b, fallback: used when simulateTransaction omits
 * any of pre/postBalances or pre/postTokenBalances.
 *
 * Immediately before simulating, the caller reads the pre-state of `addresses`
 * with ONE getMultipleAccounts (jsonParsed): our wallet, every writable
 * account in the transaction (which includes our token accounts), and every
 * account the transaction will create. The simulation is asked for the
 * post-state of the SAME list via its `accounts` option. This module derives
 * the normalized balances from the two.
 *
 * It fails closed (throws SimulationShapeError) if:
 * - either side doesn't have exactly one entry per address;
 * - the wallet isn't a System-owned account on both sides;
 * - an account the transaction creates ends up owned by anything other than
 *   Token/Token-2022 (a program we can't judge);
 * - a token account exists on both sides with a different mint or owner;
 * - a token-program-owned account isn't parseable as a token account, mint or multisig;
 * - the simulation's `fee` or `innerInstructions` is missing.
 *
 * Residual race (documented in SPEC.md 16.2 b): the pre-read happens one RPC
 * round trip before the simulation. An incoming transfer in that window
 * inflates the measured change and could hide an equal outflow from the
 * balance checks; the instruction-level checks still catch explicit transfers
 * from our wallet and authority changes.
 */
export function buildFallbackSimulation(input: {
  wallet: string;
  addresses: readonly string[];
  /** getMultipleAccounts(addresses, jsonParsed).value */
  preAccounts: unknown;
  /** the simulation result value (with `accounts` requested for the same addresses) */
  simValue: unknown;
  /** addresses the transaction will create (from its ATA-create instructions) */
  created: readonly string[];
}): NormalizedSimulation {
  const value = asObject(input.simValue, "simulation value");
  if (value.err !== null) throw new SimulationShapeError(`simulation returned an error: ${JSON.stringify(value.err)}`);
  const fee = asU64(value.fee, "fee");
  const preList = asArray(input.preAccounts, "pre-state (getMultipleAccounts value)");
  const postList = asArray(value.accounts, "post-state (simulation accounts)");
  if (preList.length !== input.addresses.length || postList.length !== input.addresses.length) {
    throw new SimulationShapeError(`pre (${preList.length}) and post (${postList.length}) don't both cover the ${input.addresses.length} requested accounts`);
  }
  if (!input.addresses.includes(input.wallet)) throw new SimulationShapeError("the wallet is not among the fallback accounts");
  for (const c of input.created) if (!input.addresses.includes(c)) throw new SimulationShapeError(`created account ${c} is not among the fallback accounts`);

  const lamports = new Map<string, { pre: bigint; post: bigint }>();
  const tokens = new Map<string, { pre: TokenAccountState | null; post: TokenAccountState | null }>();
  const postTokenAccounts = new Map<string, PostTokenAccountState>();
  const created = new Set(input.created);

  input.addresses.forEach((addr, i) => {
    const pre = parseAccount(preList[i], `pre[${i}]`);
    const post = parseAccount(postList[i], `post[${i}]`);
    lamports.set(addr, { pre: pre?.lamports ?? 0n, post: post?.lamports ?? 0n });

    if (addr === input.wallet && (pre?.owner !== SYSTEM_PROGRAM || post?.owner !== SYSTEM_PROGRAM)) {
      throw new SimulationShapeError("the wallet is not a System-owned account on both sides");
    }
    if (created.has(addr) && post !== null && !TOKEN_PROGRAMS.has(post.owner)) {
      throw new SimulationShapeError(`created account ${addr} is owned by ${post.owner}, not a token program`);
    }
    if (pre?.token && post?.token && (pre.token.mint !== post.token.mint || pre.token.owner !== post.token.owner)) {
      throw new SimulationShapeError(`token account ${addr} changed mint or owner between the pre-read and the simulation`);
    }
    if (pre?.token || post?.token) {
      tokens.set(addr, {
        pre: pre?.token ? { mint: pre.token.mint, owner: pre.token.owner, program: pre.token.program, amount: pre.token.amount } : null,
        post: post?.token ? { mint: post.token.mint, owner: post.token.owner, program: post.token.program, amount: post.token.amount } : null,
      });
    }
    if (post?.token) postTokenAccounts.set(addr, post.token);
  });

  return {
    source: "fallback",
    fee,
    unitsConsumed: value.unitsConsumed === null || value.unitsConsumed === undefined ? null : asU64(value.unitsConsumed, "unitsConsumed"),
    lamports,
    tokens,
    postTokenAccounts,
    inner: parseInner(value.innerInstructions),
  };
}
