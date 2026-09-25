import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../src/storage/db.js";
import { ShadowsStore } from "../../src/storage/shadows.js";
import { createShadowOnReady, markShadowSelected, markShadowUnsellable, type ShadowCreationConfig } from "../../src/tracking/shadowCreation.js";
import type { DexPair } from "../../src/types.js";

const MIGRATIONS = fileURLToPath(new URL("../../src/storage/migrations", import.meta.url));
const CFG: ShadowCreationConfig = {
  enabled: true, mode: "paper", maxOpen: 30, positionUsd: 25, maxPositionPctOfLiq: 1, targetProfitPct: 30, holdMinutes: 15,
  cost: { poolFeePct: 1, extraSlippagePct: 2, feeUsdPerTx: 0.05 },
};
const pair = (mint: string) => ({ chainId: "solana", pairAddress: `${mint}-p`, baseToken: { address: mint }, quoteToken: { address: "Q" }, priceUsd: "0.001", liquidity: { usd: 20_000 } }) as DexPair;

describe("shadow lifecycle vs classification (SPEC.md section 11.2)", () => {
  it("new shadows start open and unselected", () => {
    const store = new ShadowsStore(openDb(":memory:"));
    createShadowOnReady(store, CFG, "A", pair("A"), 1000, () => {});
    expect(store.getForMint("A", "paper")).toMatchObject({ outcome: "open", classification: "unselected" });
  });

  it("a selected shadow is still polled (listOpen) and priced to its exit", () => {
    const store = new ShadowsStore(openDb(":memory:"));
    createShadowOnReady(store, CFG, "A", pair("A"), 1000, () => {});
    markShadowSelected(store, "A", "paper");
    const s = store.listOpen()[0]!; // the shadow poll reads exactly this
    expect(s).toMatchObject({ mint: "A", classification: "selected", outcome: "open" });
    store.update(s.id, { outcome: "closed", exitTime: 9000, exitReason: "target", proceeds: 33, netPnlUsd: 7.95, netPnlPct: 31.7 });
    expect(store.getForMint("A", "paper")).toMatchObject({ outcome: "closed", classification: "selected", netPnlUsd: 7.95 });
  });

  it("a mint bought after its shadow already closed is still marked selected", () => {
    const store = new ShadowsStore(openDb(":memory:"));
    createShadowOnReady(store, CFG, "A", pair("A"), 1000, () => {});
    store.update(store.getForMint("A", "paper")!.id, { outcome: "closed", exitReason: "stop", netPnlUsd: -5, netPnlPct: -20 });
    markShadowSelected(store, "A", "paper");
    expect(store.getForMint("A", "paper")).toMatchObject({ outcome: "closed", classification: "selected", netPnlUsd: -5 });
  });

  it("unsellable wins over selected, and marking never crosses modes", () => {
    const store = new ShadowsStore(openDb(":memory:"));
    createShadowOnReady(store, CFG, "A", pair("A"), 1000, () => {});
    createShadowOnReady(store, { ...CFG, mode: "live" }, "A", pair("A"), 1000, () => {});
    markShadowUnsellable(store, "A", "paper");
    markShadowSelected(store, "A", "paper");
    expect(store.getForMint("A", "paper")!.classification).toBe("unsellable");
    expect(store.getForMint("A", "live")!.classification).toBe("unselected");
  });
});

describe("migration 0008_shadow_classification", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-mig8-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("moves selected/unsellable into classification, repairs missed selections within the same mode only, and closes unpriced legacy rows", () => {
    for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f < "0008")) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
    const db = new Database(":memory:");
    runMigrations(db, dir);
    expect(db.pragma("user_version", { simple: true })).toBe(7);

    const shadow = db.prepare(
      `INSERT INTO shadows (id, mint, mode, outcome, entry_time, cost_basis, token_amount, entry_liquidity_usd, entry_price_usd, current_target, deadline,
         exit_reason, net_pnl_usd, net_pnl_pct, duplicate_of)
       VALUES (?, ?, ?, ?, ?, 25.05, 1000, 20000, 0.001, 30, 999999, ?, ?, ?, ?)`,
    );
    shadow.run(1, "SEL", "paper", "selected", 100, null, null, null, null); //       legacy selected, never priced
    shadow.run(2, "UNS", "paper", "unsellable", 110, null, null, null, null); //     legacy unsellable, never priced
    shadow.run(3, "MISSED", "paper", "closed", 120, "stop", -5, -20, null); //       has a paper trade: repaired to selected
    shadow.run(4, "PAPERONLY", "live", "closed", 130, "stop", -1, -4, null); //      only a PAPER trade: must stay unselected
    shadow.run(5, "LIVEONLY", "paper", "closed", 140, "target", 2, 8, null); //      only a LIVE trade: must stay unselected
    shadow.run(6, "OPENPOS", "paper", "open", 150, null, null, null, null); //       open paper position: selected, still open
    shadow.run(7, "MISSED", "paper", "closed", 160, "stop", -6, -24, 3); //          duplicate of 3: not repaired
    shadow.run(8, "NOTRADE", "paper", "closed", 170, "time_flat", 0.1, 0.4, null); // nothing bought: unselected

    const trade = db.prepare(
      `INSERT INTO trades (mode, mint, entry_time, exit_time, size_usd, cost_basis, proceeds, net_pnl_usd, net_pnl_pct, exit_reason,
         peak_pnl, timer_restarts, target_extensions, fees_usd, trading_day)
       VALUES (?, ?, 200, 300, 25, 25.05, 20, -5.05, -20, 'stop', 0, 0, 0, 0.1, '2026-09-25')`,
    );
    trade.run("paper", "MISSED");
    trade.run("paper", "PAPERONLY");
    trade.run("live", "LIVEONLY");
    db.prepare(
      `INSERT INTO positions (mode, mint, entry_time, size_usd, token_amount, cost_basis, entry_liquidity_usd, current_target, deadline)
       VALUES ('paper', 'OPENPOS', 200, 25, 1000, 25.05, 20000, 30, 999999)`,
    ).run();

    runMigrations(db, MIGRATIONS); // applies 0008
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(8);

    const rows = db.prepare("SELECT id, outcome, classification, exit_reason, net_pnl_usd FROM shadows ORDER BY id").all();
    expect(rows).toEqual([
      { id: 1, outcome: "closed", classification: "selected", exit_reason: "not_priced", net_pnl_usd: null },
      { id: 2, outcome: "closed", classification: "unsellable", exit_reason: "not_priced", net_pnl_usd: null },
      { id: 3, outcome: "closed", classification: "selected", exit_reason: "stop", net_pnl_usd: -5 },
      { id: 4, outcome: "closed", classification: "unselected", exit_reason: "stop", net_pnl_usd: -1 },
      { id: 5, outcome: "closed", classification: "unselected", exit_reason: "target", net_pnl_usd: 2 },
      { id: 6, outcome: "open", classification: "selected", exit_reason: null, net_pnl_usd: null },
      { id: 7, outcome: "closed", classification: "unselected", exit_reason: "stop", net_pnl_usd: -6 },
      { id: 8, outcome: "closed", classification: "unselected", exit_reason: "time_flat", net_pnl_usd: 0.1 },
    ]);
    expect(() => db.prepare("UPDATE shadows SET classification = 'bogus' WHERE id = 8").run()).toThrow(/CHECK constraint failed/);
    db.close();
  });
});
