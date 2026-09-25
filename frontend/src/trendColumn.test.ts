import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DASH_COLUMNS } from "./columns";
import { GLOSSARY } from "./glossary";
import { createElement, Fragment } from "react";
import type { DashboardRow } from "./types";

const row = (over: Partial<DashboardRow>) => ({ symbol: "X", is_watch: false, ...over }) as DashboardRow;
const cell = (r: DashboardRow) => renderToStaticMarkup(createElement(Fragment, null, DASH_COLUMNS.trend_score.render(r)));

describe("Trend column", () => {
  it("draws one arrow per horizon and the net score", () => {
    const html = cell(row({ trend: { "1M": 0.05, "3M": -0.1, "6M": -0.2, "12M": null }, trend_score: -1, trend_n: 3 }));
    expect(html).toContain("▲");
    expect((html.match(/▼/g) ?? []).length).toBe(2);
    expect(html).toContain("·");             // 12M not available yet
    expect(html).toContain(">-1<");
    expect(html).toContain("12M n/a");
  });
  it("shows a plus sign for a positive score and a dash with no data", () => {
    expect(cell(row({ trend: { "1M": 0.1, "3M": 0.1, "6M": 0.1, "12M": 0.1 }, trend_score: 4, trend_n: 4 }))).toContain(">+4<");
    expect(cell(row({ trend: null, trend_score: null }))).not.toContain("▲");
  });
  it("has a glossary definition", () => {
    expect(GLOSSARY[DASH_COLUMNS.trend_score.term!]).toBeTruthy();
  });
});
