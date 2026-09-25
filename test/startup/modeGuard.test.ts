import { describe, expect, it } from "vitest";
import { modeSwitchRefusal } from "../../src/startup/modeGuard.js";

describe("mode switching (SPEC.md section 16.8, decision 5)", () => {
  it("allows a start when every position and unresolved intent is of the same mode", () => {
    expect(modeSwitchRefusal("live", [{ id: 1, mode: "live", mint: "M", status: "open" }], [{ id: 1, mode: "live", mint: "M", kind: "sell", status: "sent" }])).toBeNull();
    expect(modeSwitchRefusal("paper", [], [])).toBeNull();
  });

  it("refuses a live start while paper positions exist, listing them", () => {
    const msg = modeSwitchRefusal("live", [{ id: 3, mode: "paper", mint: "PAPERMINT", status: "open" }], []);
    expect(msg).toMatch(/Refusing to start in live mode/);
    expect(msg).toContain("position 3 (paper, open): PAPERMINT");
  });

  it("refuses a paper start while live positions or unresolved live intents exist", () => {
    expect(modeSwitchRefusal("paper", [{ id: 4, mode: "live", mint: "LIVEMINT", status: "closing" }], [])).toMatch(/never be left unmanaged/);
    expect(modeSwitchRefusal("paper", [], [{ id: 9, mode: "live", mint: "X", kind: "buy", status: "signed" }])).toContain("intent 9 (live buy, signed): X");
  });
});
