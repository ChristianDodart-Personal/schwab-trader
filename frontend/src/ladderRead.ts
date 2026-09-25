// Plain-language wording for the Ladder read (backend app/ladder_stats.py). One place
// turns the numbers into sentences, so the drill-down panel, the dashboard cells, the
// order ticket and their hover text always say the same thing. Pure: no React, unit-tested.
import type { LadderRead } from "./types";

export type Tone = "good" | "bad" | "warn" | "neutral";
export type ReadLine = { key: "bounce" | "chop" | "dip" | "why" | "decay"; chip: string; title: string; detail: string; tone: Tone };

const p1 = (n: number) => `${(Math.abs(n) * 100).toFixed(1)}%`;
const p0 = (n: number) => `${Math.round(Math.abs(n) * 100)}%`;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${p1(n)}`;
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const usd0 = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const x1 = (n: number) => `${Math.abs(n).toFixed(1)}×`;
const months = (tradingDays: number) => {
  const m = Math.round(tradingDays / 21);
  return m === 1 ? "a month" : `${m} months`;
};
export const shortDate = (iso: string | null | undefined, withYear = false) => {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString("en-US", withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
};

/** Bounce rate vs the base rate (how often ANY day reached the target), and how deep the
 * ladder went. Green only when dips clearly beat a random buy AND none ran into the
 * deepest ($1,500) tier; any dip that reached rung 8+ makes it a caution. */
export function bounceLine(r: LadderRead): ReadLine {
  const b = r.bounce;
  const setup = `After a ${p0(b.dip_pct)} dip (your rung-2 drop)`;
  if (b.rate == null) {
    return {
      key: "bounce", chip: b.dips ? `${b.dips} dip${b.dips === 1 ? "" : "s"}` : "No dips", tone: "neutral",
      title: "Too few dips to judge",
      detail: `${setup}, there ${b.dips === 1 ? "was" : "were"} only ${b.dips} completed dip${b.dips === 1 ? "" : "s"} in ${b.years} years of history, too few for a rate to mean anything.`,
    };
  }
  const beats = b.base_rate != null ? b.rate - b.base_rate : null;
  const tone: Tone = b.deep > 0 ? "warn"
    : b.rate < 0.4 || (beats != null && beats <= -0.1) ? "bad"
    : beats != null && beats >= 0.1 ? "good" : "neutral";
  const vsBase = b.base_rate == null ? ""
    : ` On any day, not just after a dip, the price reached +${p1(b.target_pct)} within ${months(b.window_days)} ${p0(b.base_rate)} of the time, so dips bounced ` +
      (beats! >= 0.1 ? "more often than a random buy." : beats! <= -0.1 ? "less often than a random buy." : "about as often as a random buy.");
  const depth = !b.more_rungs ? " None needed another rung first."
    : ` ${b.more_rungs} of the ${b.dips} fell far enough to trigger more rungs first` +
      (b.worst_rung && b.worst_low_pct != null
        ? `; the deepest fell ${p0(b.worst_low_pct)} below the dip price, reaching rung ${b.worst_rung}` +
          (b.worst_dollars ? ` (about ${usd0(b.worst_dollars)} in across rungs 2–${b.worst_rung})` : "")
        : "") + "." +
      (b.deep > 0 ? ` ${b.deep} reached rung 8 or deeper, where your buys are largest.` : "") +
      (b.past_ten > 0 ? ` ${b.past_ten} went past rung 10, where the ladder keeps adding deepest-size rungs at your last drop.` : "");
  return {
    key: "bounce", chip: `Bounces ${p0(b.rate)}`, tone,
    title: `Bounced back ${b.recovered} of ${b.dips} times` + (b.deep > 0 ? `; ${b.deep} ran to rung 8+` : ""),
    detail: `${setup}, the price reached your sell target (+${p1(b.target_pct)}) within ${months(b.window_days)} ` +
      `${b.recovered} of ${b.dips} times over ${b.years} years` +
      (b.median_days != null ? `, typically in ${b.median_days} trading day${b.median_days === 1 ? "" : "s"}.` : ".") + vsBase + depth,
  };
}

export function chopLine(r: LadderRead): ReadLine | null {
  const c = r.chop;
  if (!c.label) return null;
  const span = months(c.days);
  const rungs = c.net_rungs != null && Math.abs(c.net_rungs) >= 0.5 ? `, about ${Math.abs(c.net_rungs).toFixed(1)} rungs` : "";
  const net = c.net_pct == null ? "" : ` (${signed(c.net_pct)}${rungs})`;
  switch (c.label) {
    case "choppy":
      return { key: "chop", chip: "Choppy", tone: "neutral", title: "Swinging back and forth",
        detail: `Over the last ${span} the price swung up and down without getting far${net}. That's when a ladder earns: each swing can be a round trip.` };
    case "mixed":
      return { key: "chop", chip: "Mixed", tone: "neutral", title: "Some swings, some drift",
        detail: `Over the last ${span} the price swung around but also drifted${net}. Neither clearly back-and-forth nor clearly one-way.` };
    case "trending_up":
      return { key: "chop", chip: "Trending up", tone: "neutral", title: "Rising steadily",
        detail: `Over the last ${span} the price climbed steadily${net}. Dips have been shallow, so rungs trigger rarely.` };
    case "trending_down":
      return { key: "chop", chip: "Trending down", tone: "warn", title: "Falling steadily",
        detail: `Over the last ${span} the price fell steadily${net}. A ladder keeps buying into a move like this, with bigger rungs further down.` };
  }
}

export function dipLine(r: LadderRead): ReadLine | null {
  const d = r.dip;
  const where = d.from === "last_buy" ? "your last buy" : "its 20-day high";
  const at = d.from === "last_buy" ? ` (${usd(d.ref_price)}${d.ref_date ? `, ${shortDate(d.ref_date)}` : ""})` : ` (${usd(d.ref_price)})`;
  if (d.norm == null || d.span_move == null || d.move == null) return null;
  const ago = `${d.days} trading day${d.days === 1 ? "" : "s"}`;
  const next = d.next_rung_price == null || d.next_rung_pct == null ? ""
    : d.next_rung_pct >= 0
      ? ` Price is already past your next rung (${usd(d.next_rung_price)}).`
      : ` Your next rung (${usd(d.next_rung_price)}) is ${p1(d.next_rung_pct)} below` +
        (d.next_rung_moves != null ? `, about ${Math.abs(d.next_rung_moves).toFixed(1)} typical days' moves.` : ".");
  if (d.pct >= 0 || Math.abs(d.norm) < 0.25) {
    const near = d.pct < 0;
    return { key: "dip", chip: d.from === "last_buy" ? (near ? "Near buy" : "Above buy") : "Near high", tone: "neutral",
      title: near ? `Close to ${where}` : `Not below ${where}`,
      detail: `${p1(d.pct)} ${d.pct < 0 ? "below" : "above"} ${where}${at}.${next}` };
  }
  const size = -d.norm;
  const kind = size >= 2 ? "Rare dip" : size >= 1 ? "Big dip" : "Normal dip";
  const verdict = size >= 2 ? "a drop this size over that span is rare for it"
    : size >= 1 ? "larger than usual for it, but not rare" : "an ordinary dip for it";
  return {
    key: "dip", chip: kind, tone: size >= 2 ? "warn" : "neutral",
    title: size >= 2 ? "A rare drop for this stock" : size >= 1 ? "A bigger-than-usual dip" : "A normal dip for this stock",
    detail: `${p1(d.pct)} below ${where}${at}, ${ago} ago. Before this drop the stock moved about ±${p1(d.move)} a day, ` +
      `so over ${ago} a normal move is about ±${p1(d.span_move)}. This drop is ${x1(size)} that: ${verdict}.${next}`,
  };
}

export function whyLine(r: LadderRead): ReadLine | null {
  const w = r.why_down;
  if (!w) return null;
  const since = r.dip.from === "last_buy" ? `since your last buy (${shortDate(w.since)})` : `since its 20-day high (${shortDate(w.since)})`;
  const sp = `The S&P 500 moved ${signed(w.market_pct)} ${since}.`;
  if (w.expected_pct < 0 && w.expected_pct <= w.stock_pct) {
    return { key: "why", chip: "Market drop", tone: "neutral", title: "The market explains all of it",
      detail: `${sp} With this stock's beta of ${w.beta.toFixed(1)}, the market alone would predict about ${signed(w.expected_pct)}, more than its actual ${signed(w.stock_pct)}, so it has held up better than its beta would predict.` };
  }
  const mkt = `${sp} With this stock's beta of ${w.beta.toFixed(1)}, the market accounts for about ${signed(w.expected_pct)} of its ${signed(w.stock_pct)}.`;
  if (w.label === "market") {
    return { key: "why", chip: "Market drop", tone: "neutral", title: "Mostly the market", detail: mkt };
  }
  if (w.label === "stock") {
    return { key: "why", chip: "Stock-specific", tone: "warn", title: "Mostly this stock",
      detail: `${mkt} The rest, ${signed(w.specific_pct)}, is this stock on its own. The market doesn't explain this drop, so it has a cause of its own.` };
  }
  return { key: "why", chip: "Part market", tone: "neutral", title: "Partly the market, partly this stock", detail: mkt };
}

export function decayLine(r: LadderRead): ReadLine | null {
  if (r.decay_month == null || r.leverage == null) return null;
  const lev = `${Math.abs(r.leverage)}×${r.leverage < 0 ? " inverse" : ""}`;
  return {
    key: "decay", chip: `−${p1(r.decay_month)}/mo`, tone: r.decay_month >= 0.03 ? "warn" : "neutral",
    title: "Cost of waiting in a leveraged fund",
    detail: `At its current volatility this ${lev} fund loses about ${p1(r.decay_month)} a month to daily rebalancing, on top of the underlying's own moves. That's what it costs to wait while a ladder sits deep.`,
  };
}

/** Every line that applies, in reading order. */
export function readLines(r: LadderRead | null | undefined): ReadLine[] {
  if (!r) return [];
  return [bounceLine(r), chopLine(r), dipLine(r), whyLine(r), decayLine(r)].filter((l): l is ReadLine => l != null);
}

export const TONE_COLOR: Record<Tone, string> = {
  good: "var(--pos)", bad: "var(--neg)", warn: "var(--warn)", neutral: "var(--text-muted)",
};
/** Tones that carry a warning glyph, so the signal never rests on color alone. */
export const needsIcon = (t: Tone) => t === "warn" || t === "bad";
export const STATUS_TEXT = {
  loading: "Loading 5 years of prices…",
  unavailable: "Price history unavailable, retrying in a few minutes.",
  short: "Not enough price history yet.",
} as const;
