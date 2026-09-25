import { describe, expect, it } from "vitest";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bounceLine, chopLine, decayLine, dipLine, readLines, whyLine } from "./ladderRead";
import { LadderReadPanel, LadderStrip } from "./LadderReadPanel";
import { DASH_COLUMNS, DASH_COLUMN_LIST } from "./columns";
import { GLOSSARY } from "./glossary";
import type { DashboardRow, LadderRead } from "./types";

const base = (): LadderRead => ({
  asof: "2026-09-25",
  bounce: { dips: 17, recovered: 14, rate: 14 / 17, median_days: 9, more_rungs: 6, worst_low_pct: -0.38, open: 1,
    deep: 0, worst_rung: 5, worst_dollars: 3500, base_rate: 0.62, past_ten: 0,
    dip_pct: 0.10, target_pct: 0.05, window_days: 63, years: 5 },
  chop: { er: 0.07, label: "choppy", rank: 0.07, net_pct: 0.02, net_rungs: 0.2, days: 63 },
  typical_move: 0.042,
  dip: { from: "last_buy", ref_price: 20, ref_date: "2026-09-03", pct: -0.081, days: 12, move: 0.042, span_move: 0.1455, norm: -0.56,
    next_rung_price: 17.4, next_rung_pct: -0.05, next_rung_moves: -1.2 },
  why_down: { stock_pct: -0.091, market_pct: -0.04, beta: 1.9, expected_pct: -0.076, specific_pct: -0.015, market_share: 0.835, label: "market", since: "2026-09-03" },
  leverage: 2, decay_month: 0.019,
  events: [
    { date: "2026-09-12", entry: 19.1, outcome: "open", days: null, low_pct: -0.02, extra_rungs: 0, rung_reached: 2, age: 10 },
    { date: "2026-06-02", entry: 18.5, outcome: "recovered", days: 6, low_pct: -0.04, extra_rungs: 0, rung_reached: 2, age: null },
    { date: "2026-03-10", entry: 15.1, outcome: "expired", days: null, low_pct: -0.61, extra_rungs: 7, rung_reached: 9, age: null },
  ],
});
const html = (n: React.ReactNode) => renderToStaticMarkup(createElement(Fragment, null, n));

describe("bounce rate", () => {
  it("states the setup in the user's own rule terms, with depth and a random-buy comparison", () => {
    const l = bounceLine(base());
    expect(l.chip).toBe("Bounces 82%");
    expect(l.detail).toContain("After a 10% dip (your rung-2 drop)");
    expect(l.detail).toContain("sell target (+5.0%) within 3 months 14 of 17 times over 5 years");
    expect(l.detail).toContain("typically in 9 trading days");
    expect(l.detail).toContain("On any day, not just after a dip, the price reached +5.0% within 3 months 62% of the time");
    expect(l.detail).toContain("more often than a random buy");
    expect(l.detail).toContain("the deepest fell 38% below the dip price, reaching rung 5 (about $3,500 in across rungs 2–5)");
  });
  it("is green only when dips clearly beat a random buy", () => {
    expect(bounceLine(base()).tone).toBe("good");                        // 82% vs 62%
    const r = base(); r.bounce = { ...r.bounce, base_rate: 0.80 };
    expect(bounceLine(r).tone).toBe("neutral");                          // 82% vs 80%: no edge
    expect(bounceLine(r).detail).toContain("about as often as a random buy");
  });
  it("any dip that reached rung 8+ makes it a caution, even at a high rate", () => {
    const r = base(); r.bounce = { ...r.bounce, deep: 1, worst_rung: 9, worst_dollars: 9500 };
    const l = bounceLine(r);
    expect(l.tone).toBe("warn");
    expect(l.title).toBe("Bounced back 14 of 17 times; 1 ran to rung 8+");
    expect(l.detail).toContain("1 reached rung 8 or deeper, where your buys are largest");
  });
  it("is bad when dips clearly trail a random buy", () => {
    const r = base(); r.bounce = { ...r.bounce, rate: 0.46, base_rate: 0.69 };
    expect(bounceLine(r).tone).toBe("bad");
    expect(bounceLine(r).detail).toContain("less often than a random buy");
  });
  it("says when a dip went past rung 10", () => {
    const r = base(); r.bounce = { ...r.bounce, deep: 1, past_ten: 1, worst_rung: 12 };
    expect(bounceLine(r).detail).toContain("1 went past rung 10");
  });
  it("is bad below 40%, and says 'too few' instead of a rate", () => {
    const r = base(); r.bounce = { ...r.bounce, rate: 0.3 };
    expect(bounceLine(r).tone).toBe("bad");
    r.bounce = { ...r.bounce, dips: 2, recovered: 2, rate: null };
    expect(bounceLine(r).chip).toBe("2 dips");
    expect(bounceLine(r).detail).toContain("too few");
  });
});

describe("chop", () => {
  it("labels are plain words; choppy is not painted as an outcome", () => {
    const l = chopLine(base())!;
    expect(l.chip).toBe("Choppy");
    expect(l.tone).toBe("neutral");
  });
  it("a steady fall is a caution, sized in rungs, with the tiered-sizing wording", () => {
    const r = base(); r.chop = { ...r.chop, label: "trending_down", net_pct: -0.22, net_rungs: -2.2 };
    const l = chopLine(r)!;
    expect(l.tone).toBe("warn");
    expect(l.detail).toContain("(−22.0%, about 2.2 rungs)");
    expect(l.detail).toContain("with bigger rungs further down");
  });
});

describe("dip size", () => {
  it("compares the drop with a normal move (from before the drop) over the same span", () => {
    const l = dipLine(base())!;
    expect(l.chip).toBe("Normal dip");
    expect(l.detail).toContain("8.1% below your last buy ($20.00, Sep 3), 12 trading days ago");
    expect(l.detail).toContain("Before this drop the stock moved about ±4.2% a day");
    expect(l.detail).toContain("a normal move is about ±14.5%");
    expect(l.detail).toContain("This drop is 0.6× that: an ordinary dip for it");
  });
  it("gives the next rung in %, with typical days as a secondary unit", () => {
    expect(dipLine(base())!.detail).toContain("Your next rung ($17.40) is 5.0% below, about 1.2 typical days' moves");
    const r = base(); r.dip = { ...r.dip, next_rung_pct: 0.02, next_rung_moves: 0.4 };
    expect(dipLine(r)!.detail).toContain("Price is already past your next rung ($17.40)");
  });
  it("big at 1×, rare (and a caution) at 2×", () => {
    const r = base();
    r.dip = { ...r.dip, norm: -1.4 };
    expect(dipLine(r)!.chip).toBe("Big dip");
    r.dip = { ...r.dip, pct: -0.3, norm: -2.1 };
    expect(dipLine(r)!.chip).toBe("Rare dip");
    expect(dipLine(r)!.tone).toBe("warn");
  });
  it("a tiny move reads as near the buy, not as a 0.0× dip", () => {
    const r = base(); r.dip = { ...r.dip, pct: -0.01, norm: -0.1 };
    expect(dipLine(r)!.chip).toBe("Near buy");
    r.dip = { ...r.dip, pct: 0.03, norm: 0.2 };
    expect(dipLine(r)!.chip).toBe("Above buy");
  });
  it("watchlist dips read from the 20-day high", () => {
    const r = base(); r.dip = { from: "recent_high", ref_price: 25, ref_date: "2026-09-10", pct: -0.12, days: 6, move: 0.04, span_move: 0.10, norm: -1.2 };
    expect(dipLine(r)!.detail).toContain("below its 20-day high ($25.00), 6 trading days ago");
  });
});

describe("why down", () => {
  it("explains the market's share", () => {
    const l = whyLine(base())!;
    expect(l.chip).toBe("Market drop");
    expect(l.detail).toContain("beta of 1.9");
  });
  it("when the market predicts more than the actual fall, says so plainly", () => {
    const r = base(); r.why_down = { ...r.why_down!, stock_pct: -0.033, expected_pct: -0.068, market_share: 1 };
    const l = whyLine(r)!;
    expect(l.title).toBe("The market explains all of it");
    expect(l.detail).toContain("would predict about −6.8%, more than its actual −3.3%, so it has held up better than its beta would predict");
  });
  it("a stock-specific drop is a caution with no general claim about what happens next", () => {
    const r = base(); r.why_down = { ...r.why_down!, label: "stock", market_share: 0.1, expected_pct: -0.01, specific_pct: -0.08 };
    const l = whyLine(r)!;
    expect(l.chip).toBe("Stock-specific");
    expect(l.tone).toBe("warn");
    expect(l.detail).toContain("so it has a cause of its own");
    expect(l.detail).not.toMatch(/tend to|news/);
  });
});

describe("decay", () => {
  it("appears only for leveraged funds and names inverse funds", () => {
    expect(decayLine(base())!.chip).toBe("−1.9%/mo");
    const r = base(); r.leverage = -2; r.decay_month = 0.04;
    expect(decayLine(r)!.detail).toContain("2× inverse fund");
    expect(decayLine(r)!.tone).toBe("warn");
    r.decay_month = null; r.leverage = null;
    expect(readLines(r).map((l) => l.key)).toEqual(["bounce", "chop", "dip", "why"]);
  });
});

describe("ladder read UI", () => {
  const row = (ladder: LadderRead | null, ladder_status: DashboardRow["ladder_status"] = "ready") =>
    ({ symbol: "X", is_watch: false, ladder, ladder_status }) as unknown as DashboardRow;
  const IDS = ["bounce_rate", "chop_score", "dip_depth", "why_market_share", "decay_month"];

  it("every column has a glossary term, sits in the Ladder read group, and renders its chip", () => {
    for (const id of IDS) {
      const col = DASH_COLUMNS[id];
      expect(col, id).toBeTruthy();
      expect(col.group).toBe("Ladder read");
      expect(GLOSSARY[col.term!], id).toBeTruthy();
      expect(html(col.render(row(base()))).length, id).toBeGreaterThan(0);
    }
    expect(DASH_COLUMN_LIST.filter((c) => c.group === "Ladder read").map((c) => c.id)).toEqual(IDS);
  });
  it("cells: percent-only bounce chip with depth, dip sub with span, loading and unavailable states", () => {
    const b = html(DASH_COLUMNS.bounce_rate.render(row(base())));
    expect(b).toContain(">82%<");
    expect(b).toContain("14/17 · worst rung 5");
    const r = base(); r.dip = { ...r.dip, norm: -1.4 };
    expect(html(DASH_COLUMNS.dip_depth.render(row(r)))).toContain("1.4× · 12d");
    expect(html(DASH_COLUMNS.chop_score.render(row(null, "loading")))).toContain("…");
    expect(html(DASH_COLUMNS.chop_score.render(row(null, "unavailable")))).toContain("n/a");
    expect(html(DASH_COLUMNS.chop_score.render(row(null, "short")))).toContain("new");
  });
  it("a caution carries a warning glyph, not just a color", () => {
    const r = base(); r.bounce = { ...r.bounce, deep: 1 };
    expect(html(DASH_COLUMNS.bounce_rate.render(row(r)))).toContain("<svg");
    expect(html(DASH_COLUMNS.chop_score.render(row(base())))).not.toContain("<svg");
  });
  it("the strip: one chip per line with its own title, and the right waiting text", () => {
    const strip = html(createElement(LadderStrip, { read: base(), open: false, onOpen: () => {} }));
    for (const c of ["Bounces 82%", "Choppy", "Normal dip", "Market drop", "−1.9%/mo", "Details"]) expect(strip).toContain(c);
    expect(strip).toContain('title="Swinging back and forth"');
    expect(html(createElement(LadderStrip, { read: null, open: false, onOpen: () => {} }))).toContain("Loading 5 years of prices");
    expect(html(createElement(LadderStrip, { read: null, status: "unavailable", open: false, onOpen: () => {} }))).toContain("unavailable");
    expect(html(createElement(LadderStrip, { read: null, status: "short", open: false, onOpen: () => {} }))).toContain("Not enough price history");
    expect(html(createElement(LadderStrip, { read: base(), open: false, onOpen: () => {}, note: "Measured for a rung-2 dip and target" }))).toContain("Measured for a rung-2");
  });
  it("the panel lists each line and the recent dips in ladder terms", () => {
    const out = html(createElement(LadderReadPanel, { read: base() }));
    expect(out).toContain("Bounced back 14 of 17 times");
    expect(out).toContain("Recent 10% dips");
    expect(out).toContain("Would-be buy");
    expect(out).toContain("Now, day 10 of 63");
    expect(out).toContain("Hit target in 6d");
    expect(out).toContain("Missed (3 mo)");
    expect(out).toContain("−61.0%");
    expect(out).toContain("Rung reached");
    expect(out).toContain("Mar 10, 2026");
    expect(out).toContain("Reference only");
  });
});
