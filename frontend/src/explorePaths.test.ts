import { describe, expect, it } from "vitest";
import { flattenPaths } from "./explorePaths";

describe("flattenPaths", () => {
  it("collapses array items into one [] path with counts and samples", () => {
    const d = { securitiesAccount: { positions: [
      { instrument: { symbol: "RCAX" }, longQuantity: 145 },
      { instrument: { symbol: "RKLB" }, longQuantity: 1 },
    ] } };
    const rows = flattenPaths(d);
    const sym = rows.find((r) => r.path === "securitiesAccount.positions[].instrument.symbol")!;
    expect(sym.count).toBe(2);
    expect(sym.samples).toEqual(["RCAX", "RKLB"]);
    expect(rows.find((r) => r.path === "securitiesAccount.positions")!.type).toBe("array");
  });

  it("folds symbol-keyed maps (quotes) into {key}", () => {
    const q = (p: number) => ({ quote: { lastPrice: p }, symbol: "x" });
    const rows = flattenPaths({ AAPL: q(1), MSFT: q(2), NVDA: q(3), RKLB: q(4) });
    expect(rows.map((r) => r.path)).toContain("{key}.quote.lastPrice");
    expect(rows.some((r) => r.path.startsWith("AAPL"))).toBe(false);
  });

  it("keeps real field names when an object is small or mixed", () => {
    const rows = flattenPaths({ type: "RECEIVE_AND_DELIVER", netAmount: 0, transferItems: [] });
    expect(rows.map((r) => r.path).sort()).toEqual(["netAmount", "transferItems", "type"]);
  });

  it("records mixed types and a bare scalar", () => {
    expect(flattenPaths([{ a: 1 }, { a: null }]).find((r) => r.path === "[].a")!.type).toBe("number | null");
    expect(flattenPaths(42)).toEqual([{ path: "(value)", type: "number", count: 1, samples: ["42"] }]);
  });
});
