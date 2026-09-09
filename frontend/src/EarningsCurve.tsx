import { useEffect, useRef } from "react";
import { createChart, ColorType, type IChartApi } from "lightweight-charts";
import { useChartColors, withAlpha } from "./chartTheme";

export type GainRow = { period: string; cap_gains: number; trade_count: number };

// Bucket key -> a chart date. Month keys are "YYYY-MM" (plot at the 1st); week keys are
// already the Monday's ISO date.
const toDay = (period: string) => (period.length === 7 ? `${period}-01` : period);

// Realized earnings over time. The area line is the RUNNING TOTAL of closed-trade profit
// (money green: it's an outcome, unlike the blue account-value reference line), and the
// bars underneath are each period's own gain (green/red) so a bad month reads as a dip in
// the bars and a flattening of the line. Rows must be ascending by period; any YTD/scope
// filtering is the caller's job, so the running total restarts at the first shown period.
export function EarningsCurve({ rows }: { rows: GainRow[] }) {
  const container = useRef<HTMLDivElement>(null);
  const c = useChartColors();
  // Re-create only when the data actually changes (the caller derives `rows` per render).
  const sig = rows.map((r) => `${r.period}:${r.cap_gains}`).join("|");

  useEffect(() => {
    if (!container.current || rows.length < 2) return;
    const chart: IChartApi = createChart(container.current, {
      height: 200,
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" }, // canvas can't read var()
        textColor: c.text,
        fontFamily: "system-ui, sans-serif",
      },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      timeScale: { borderColor: c.border },
      rightPriceScale: { borderColor: c.border },
      leftPriceScale: { visible: false },
      crosshair: { mode: 0 },
    });
    // Per-period bars on a hidden left scale squeezed into the bottom 40%, so they read
    // as texture under the line rather than competing with it.
    const bars = chart.addHistogramSeries({
      priceScaleId: "left",
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    chart.priceScale("left").applyOptions({ scaleMargins: { top: 0.6, bottom: 0 } });
    bars.setData(rows.map((r) => ({
      time: toDay(r.period), value: r.cap_gains,
      color: withAlpha(r.cap_gains >= 0 ? c.pos : c.neg, 0.55),
    })));
    const area = chart.addAreaSeries({
      lineColor: c.pos,
      topColor: withAlpha(c.pos, 0.25),
      bottomColor: withAlpha(c.pos, 0.02),
      lineWidth: 2,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    let run = 0;
    area.setData(rows.map((r) => { run += r.cap_gains; return { time: toDay(r.period), value: Math.round(run * 100) / 100 }; }));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [sig, c]); // eslint-disable-line react-hooks/exhaustive-deps

  if (rows.length < 2) {
    return <p style={{ color: "var(--text-faint)", fontSize: "var(--fs-sm)", margin: "0 0 8px" }}>
      The earnings line needs at least two periods.
    </p>;
  }
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 16, fontSize: "var(--fs-xs)", color: "var(--text-dim)", marginBottom: 6 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, borderTop: `2px solid ${c.pos}` }} /> Running total of realized gains
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, background: withAlpha(c.pos, 0.55), borderRadius: 2 }} /> Each period's gain
        </span>
      </div>
      <div ref={container} style={{ width: "100%" }} />
    </div>
  );
}
