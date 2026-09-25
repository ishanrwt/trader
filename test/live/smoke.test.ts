import { describe, expect, it } from "vitest";
import { ConfirmationPool } from "../../src/live/confirm.js";
import { runSmoke, SMOKE_CONFIRM_PHRASE, type SmokeDeps } from "../../src/live/smoke.js";
import { SendNotPermittedError, type TxRpc } from "../../src/live/txRpc.js";
import { openDb } from "../../src/storage/db.js";
import { IntentsStore } from "../../src/storage/intents.js";
import { FakeChain } from "../helpers/fakeChain.js";
import { liveConfig } from "../helpers/liveSetup.js";

async function harness(opts: { send: boolean; isTTY?: boolean; answer?: string; omitBalanceFields?: boolean; lastAliveAt?: number | null; sendThrows?: boolean }) {
  const chain = await FakeChain.create();
  chain.omitBalanceFields = opts.omitBalanceFields ?? false;
  const db = openDb(":memory:");
  const intents = new IntentsStore(db);
  const clock = { t: 1_700_000_000_000 };
  const lines: string[] = [];
  const asked: string[] = [];
  const rpc = { ...chain.rpc } as unknown as TxRpc;
  if (opts.sendThrows) (rpc as unknown as { sendTransaction: () => never }).sendTransaction = () => { throw new SendNotPermittedError(); };
  const pool = new ConfirmationPool({
    rpc: { getSignatureStatuses: (s, h) => chain.rpc.getSignatureStatuses(s, h), getBlockHeight: () => chain.rpc.getBlockHeight(), resend: async () => undefined },
    pollMs: 2_000,
    resendEveryMs: 4_000,
    blockHeightAfterMs: 30_000,
    now: () => clock.t,
    sleep: async (ms) => void (clock.t += ms),
  });
  const deps: SmokeDeps = {
    config: liveConfig(),
    signer: chain.wallet,
    rpc,
    jupiter: chain.jupiter,
    pool,
    intents,
    lastAliveAt: opts.lastAliveAt ?? null,
    send: opts.send,
    isTTY: opts.isTTY ?? true,
    ask: async (q) => {
      asked.push(q);
      return opts.answer ?? "";
    },
    print: (l) => void lines.push(l),
    solPriceUsd: 150,
    now: () => clock.t,
  };
  return { chain, deps, lines, asked, intents };
}

describe("npm run smoke-live (SPEC.md section 16.8, A5)", () => {
  it("dry run by default: builds, simulates and verifies both legs, prints the balance source, never sends", async () => {
    const h = await harness({ send: false, sendThrows: true });
    expect(await runSmoke(h.deps)).toBe(0);
    expect(h.chain.sends).toEqual([]);
    expect(h.asked).toEqual([]); // no confirmation needed for a dry run
    expect(h.chain.builds.map((b) => [b.inputMint.slice(0, 4), b.outputMint.slice(0, 4), b.amount])).toEqual([
      ["EPjF", "So11", "1000000"],
      ["So11", "EPjF", "6000000"],
    ]);
    const out = h.lines.join("\n");
    expect(out).toMatch(/leg1: verification PASSED \(balance source: simulation\)/);
    expect(out).toMatch(/leg2: verification PASSED \(balance source: simulation\)/);
    expect(out).toMatch(/Dry run complete\. Nothing was sent\./);
    expect(out).toContain(h.chain.wallet.address); // only the public address
    expect(h.intents.listUnresolved()).toEqual([]);
  });

  it("the dry run prints 'fallback' when the RPC omits the simulation balance fields", async () => {
    const h = await harness({ send: false, omitBalanceFields: true });
    expect(await runSmoke(h.deps)).toBe(0);
    expect(h.lines.join("\n")).toMatch(/leg1: verification PASSED \(balance source: fallback\)/);
  });

  it("the dry run says so when the wallet doesn't hold enough SOL to verify leg 2", async () => {
    const h = await harness({ send: false });
    h.chain.lamports = 1_000_000n;
    expect(await runSmoke(h.deps)).toBe(0);
    expect(h.lines.join("\n")).toMatch(/Leg 2 not verified/);
    expect(h.chain.builds).toHaveLength(1);
  });

  it("--send refuses without an interactive terminal, and without the exact confirmation phrase", async () => {
    const noTty = await harness({ send: true, isTTY: false, answer: SMOKE_CONFIRM_PHRASE });
    expect(await runSmoke(noTty.deps)).toBe(1);
    expect(noTty.chain.builds).toEqual([]);
    const wrong = await harness({ send: true, answer: "yes" });
    expect(await runSmoke(wrong.deps)).toBe(1);
    expect(wrong.chain.sends).toEqual([]);
    expect(wrong.chain.builds).toEqual([]);
  });

  it("--send with the typed confirmation: $1 USDC -> SOL, then exactly the SOL received -> USDC, with the accounting", async () => {
    const h = await harness({ send: true, answer: ` ${SMOKE_CONFIRM_PHRASE} ` });
    expect(await runSmoke(h.deps)).toBe(0);
    expect(h.asked[0]).toContain(SMOKE_CONFIRM_PHRASE);
    expect(h.chain.sends).toHaveLength(2);
    expect(h.chain.builds[1]!.amount).toBe("6000000"); // the SOL actually received in leg 1
    const out = h.lines.join("\n");
    expect(out).toMatch(/Leg 1 landed/);
    expect(out).toMatch(/Leg 2 landed/);
    expect(out).toMatch(/USDC in 1, USDC out 0\.99/);
    expect(out).toMatch(/fees: leg 1 \d+ \+ leg 2 \d+ = \d+ lamports \(\$\d+\.\d{4} at \$150\.00\/SOL\)/);
    expect(out).toMatch(/net cost: \$0\.01/);
  });

  it("refuses if this folder's heartbeat is fresh (a bot running from this folder)", async () => {
    const h = await harness({ send: false, lastAliveAt: 1_700_000_000_000 - 30_000 });
    expect(await runSmoke(h.deps)).toBe(1);
    expect(h.chain.builds).toEqual([]);
    expect(h.lines.join("\n")).toMatch(/can't see a bot running from another folder/);
  });
});
