import { address, generateKeyPairSigner, getBase58Encoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  apiInstruction,
  associatedTokenAddress,
  blockhashOf,
  closeTokenAccountInstruction,
  compileV0,
  computeBudgetInstructions,
  decodeForVerification,
  jupiterCuPrice,
  lookupTables,
  signWith,
  signatureOf,
} from "../../src/live/assemble.js";
import { COMPUTE_BUDGET_PROGRAM, JUPITER_AGGREGATOR_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT } from "../../src/live/programs.js";
import { encodeSetComputeUnitPrice, maxCuPriceFor, priorityFeeLamports } from "../../src/live/instructions.js";

const BLOCKHASH = { blockhash: Array.from({ length: 32 }, (_, i) => i + 1), lastValidBlockHeight: 1_000 };

describe("closing token accounts with the mint's own token program (SPEC.md section 16.6, A3)", () => {
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    it(`builds closeAccount under ${program === TOKEN_PROGRAM ? "Token" : "Token-2022"}: discriminator 9, account/destination writable, owner signer`, async () => {
      const owner = await generateKeyPairSigner();
      const ata = await associatedTokenAddress(owner.address, USDC_MINT, program);
      const ix = closeTokenAccountInstruction(ata, owner, program);
      expect(ix.programAddress).toBe(program);
      expect([...ix.data!]).toEqual([9]);
      expect(ix.accounts!.map((a) => a.address)).toEqual([ata, owner.address, owner.address]);
      // AccountRole: 1 = WRITABLE, 2 = READONLY_SIGNER
      expect(ix.accounts!.map((a) => a.role)).toEqual([1, 1, 2]);
    });
  }

  it("derives different associated token addresses under Token and Token-2022", async () => {
    const owner = await generateKeyPairSigner();
    expect(await associatedTokenAddress(owner.address, USDC_MINT, TOKEN_PROGRAM)).not.toBe(await associatedTokenAddress(owner.address, USDC_MINT, TOKEN_2022_PROGRAM));
  });

  it("refuses an unknown token program (fail closed)", async () => {
    const owner = await generateKeyPairSigner();
    expect(() => closeTokenAccountInstruction(owner.address, owner, "Fake111111111111111111111111111111111111111")).toThrow(/Unknown token program/);
  });
});

describe("priority-fee cap (SPEC.md section 16.2 step 2)", () => {
  it("clamps the compute-unit price so price x limit stays within MAX_PRIORITY_FEE_SOL", () => {
    const cap = maxCuPriceFor(500_000n, 300_000);
    expect(priorityFeeLamports(cap, 300_000)).toBeLessThanOrEqual(500_000n);
    expect(priorityFeeLamports(cap + 1n, 300_000)).toBeGreaterThan(500_000n);
  });

  it("reads Jupiter's setComputeUnitPrice and fails closed on anything else", () => {
    const price = { programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: Buffer.from(encodeSetComputeUnitPrice(1234n)).toString("base64") };
    expect(jupiterCuPrice({ computeBudgetInstructions: [price] })).toBe(1234n);
    expect(() => jupiterCuPrice({ computeBudgetInstructions: [] })).toThrow();
    expect(() => jupiterCuPrice({ computeBudgetInstructions: [price, price] })).toThrow();
    expect(() => jupiterCuPrice({ computeBudgetInstructions: [{ ...price, programId: TOKEN_PROGRAM }] })).toThrow();
  });
});

describe("decodeForVerification: the exact bytes sent are what gets verified", () => {
  it("round-trips a signed v0 transaction with a lookup table: fee payer, signers, accounts, roles, data", async () => {
    const signer = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const lutAddr = (await generateKeyPairSigner()).address;
    const pool = (await generateKeyPairSigner()).address;
    const swap = apiInstruction({
      programId: JUPITER_AGGREGATOR_PROGRAM,
      accounts: [
        { pubkey: signer.address, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: other.address, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([7, 7]).toString("base64"),
    });
    const alts = lookupTables({ [lutAddr]: [pool] });
    const tx = compileV0([...computeBudgetInstructions(200_000, 1_000n), swap], signer.address, blockhashOf({ blockhashWithMetadata: BLOCKHASH }), alts);
    const signed = await signWith(signer, tx);
    expect(signatureOf(signed)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    const { decoded, accountKeys, writable } = decodeForVerification(signed, alts);
    expect(decoded.feePayer).toBe(signer.address);
    expect(decoded.signers).toEqual([signer.address]);
    const jup = decoded.instructions.find((i) => i.programId === JUPITER_AGGREGATOR_PROGRAM)!;
    expect(jup.accounts).toEqual([
      { address: signer.address, signer: true, writable: true },
      { address: pool, signer: false, writable: true },
      { address: other.address, signer: false, writable: false },
    ]);
    expect([...jup.data]).toEqual([7, 7]);
    expect(accountKeys).toContain(pool); // loaded from the lookup table
    expect(writable).toEqual(expect.arrayContaining([signer.address, pool]));
    expect(writable).not.toContain(other.address);
    expect(address(accountKeys[0]!)).toBe(signer.address);
  });

  it("fails closed when the message references a lookup table that isn't in the response", async () => {
    const signer = await generateKeyPairSigner();
    const lutAddr = (await generateKeyPairSigner()).address;
    const pool = (await generateKeyPairSigner()).address;
    const swap = apiInstruction({ programId: JUPITER_AGGREGATOR_PROGRAM, accounts: [{ pubkey: pool, isSigner: false, isWritable: true }], data: "" });
    const tx = compileV0([swap], signer.address, blockhashOf({ blockhashWithMetadata: BLOCKHASH }), lookupTables({ [lutAddr]: [pool] }));
    expect(() => decodeForVerification(tx, {})).toThrow(/lookup table/);
  });

  it("rejects a malformed blockhash from the response", () => {
    expect(() => blockhashOf({ blockhashWithMetadata: { blockhash: [1, 2], lastValidBlockHeight: 5 } })).toThrow();
    void getBase58Encoder;
  });
});
