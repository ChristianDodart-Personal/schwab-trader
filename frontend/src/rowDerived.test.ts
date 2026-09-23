import { describe, it, expect } from "vitest";
import { dayPct, lastPosGainPct } from "./rowDerived";
import type { DashboardRow } from "./types";

// Only the fields each derivation reads matter; cast a partial row for the test.
const row = (o: Partial<DashboardRow>): DashboardRow => ({ ...({} as DashboardRow), ...o });

describe("lastPosGainPct", () => {
  it("profit over a positive cost → percent", () => {
    expect(lastPosGainPct(row({ last_pos_profit: 10, last_pos_cost: 200 }))).toBeCloseTo(5);
  });
  it("null when the profit is missing", () => {
    expect(lastPosGainPct(row({ last_pos_profit: null, last_pos_cost: 200 }))).toBeNull();
  });
  it("null when cost is zero or negative (no meaningful percent)", () => {
    expect(lastPosGainPct(row({ last_pos_profit: 10, last_pos_cost: 0 }))).toBeNull();
    expect(lastPosGainPct(row({ last_pos_profit: 10, last_pos_cost: -5 }))).toBeNull();
  });
});

describe("dayPct", () => {
  it("is the change over the start-of-day value", () => {
    expect(dayPct(10, 110)).toBeCloseTo(0.1); // start 100 → +10%
  });
  it("null when either input is missing", () => {
    expect(dayPct(null, 110)).toBeNull();
    expect(dayPct(10, null)).toBeNull();
  });
  it("null when the start-of-day value isn't positive", () => {
    expect(dayPct(10, 10)).toBeNull(); // start 0
    expect(dayPct(20, 10)).toBeNull(); // start -10
  });
});
