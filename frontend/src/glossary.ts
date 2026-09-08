// The GLOSSARY — one canonical definition per concept, referenced everywhere by id.
//
// This is the single source of truth behind the hover/click "definition" affordance
// (see Glossary.tsx / <Term>). A term appears the same and links the same wherever it
// shows up, so there's exactly one place to edit a definition. It also absorbs the old
// "ƒ = app-calculated" provenance mark: every entry carries a `source` (straight from
// Schwab / the app calculates it / a mix), shown as a line in the definition box, so
// numbers no longer need a separate glyph.
//
// Definition shape is deliberately uniform: a one-line plain-English `oneLiner`, then
// optional `howItWorks` (mechanics) and `howCalculated` (the formula, only when the app
// computes it), then `source`, then `related` cross-links (which are themselves terms
// you can drill into).

import { usd } from "./format";

export type TermSource = "schwab" | "computed" | "hybrid";

// A snapshot of the SELECTED account's live figures, fed to the glossary so a
// definition can show its formula worked out on real numbers ("on your account now").
// All optional/nullable — an example() returns null when the pieces it needs aren't in.
export interface GlossaryFigures {
  accountValue?: number | null;
  cash?: number | null;
  invested?: number | null;        // open-lot cost basis
  marketValue?: number | null;     // open-lot market value
  unrealized?: number | null;
  longMarketValue?: number | null;
  equity?: number | null;
  deployedPct?: number | null;
  leverage?: number | null;
  marginDebt?: number | null;
  maintenance?: number | null;
  maintCushion?: number | null;
  tradableFunds?: number | null;
  harvestable?: number | null;
  dayChange?: number | null;
  // returns / ledger (fed by the Ledger's Historic tab)
  peakCapital?: number | null;
  capitalAtWork?: number | null;
  depositedAllTime?: number | null;
  withdrawnAllTime?: number | null;   // negative
  principalReturned?: number | null;
  profitWithdrawn?: number | null;
  totalProfit?: number | null;
  gainOnCapitalAtWork?: number | null;
  roiPct?: number | null;
  thisYear?: number | null;
  realizedYtd?: number | null;
  taxReserve?: number | null;
  afterTaxRealized?: number | null;
}

export interface GlossaryEntry {
  term: string; // canonical display label
  oneLiner: string; // plain-English, one sentence
  howItWorks?: string;
  howCalculated?: string; // present when source involves app computation
  // A live worked example on the selected account, e.g. "$5,048 ÷ $4,678 × 100 = 108%".
  // Return null when the needed figures aren't available (never throw).
  example?: (f: GlossaryFigures) => string | null;
  source: TermSource;
  related?: string[]; // other term ids
}

// helpers for example() strings
const has = (...xs: (number | null | undefined)[]) => xs.every((x) => typeof x === "number" && isFinite(x));
const signed = (n: number) => (n >= 0 ? "+" : "") + usd(n);

export const SOURCE_LABEL: Record<TermSource, string> = {
  schwab: "Straight from Schwab",
  computed: "The app calculates this",
  hybrid: "Schwab data, combined by the app",
};

export const GLOSSARY: Record<string, GlossaryEntry> = {
  // ---- account value / cash ----
  account_value: {
    term: "Account value",
    oneLiner: "What the account is worth right now if everything were sold.",
    howItWorks: "Schwab's liquidation value — the market value of your positions plus cash, minus any margin loan. It moves every second the market is open.",
    source: "schwab",
    related: ["cash", "invested", "margin_debt"],
  },
  cash: {
    term: "Cash",
    oneLiner: "Settled cash sitting in the account.",
    howItWorks: "The conservative 'free money' figure — it excludes anything you'd have to borrow on margin. Can be negative on a margin account when you're carrying a loan.",
    source: "schwab",
    related: ["available_to_trade", "margin_debt"],
  },
  available_to_trade: {
    term: "Available to trade",
    oneLiner: "What you can actually put into an order right now.",
    howItWorks: "Settled cash plus borrowing against fully-paid stock — Schwab's 'Settled Funds' / 'Funds Available to Withdraw'. This is the real limit: orders above it get rejected.",
    source: "schwab",
    related: ["cash"],
  },

  // ---- position value / P&L ----
  invested: {
    term: "Invested",
    oneLiner: "What you paid for the shares you currently hold.",
    howItWorks: "The cost basis of every open position — excludes cash. Compare it to market value to see the paper gain.",
    howCalculated: "Sum over open lots of shares × buy price.",
    source: "computed",
    related: ["market_value", "unrealized_pl", "cost_basis"],
  },
  market_value: {
    term: "Market value",
    oneLiner: "What your open positions are worth at the current price.",
    howCalculated: "Sum over open lots of shares × the latest quote (= cost basis + unrealized P/L).",
    example: (f) => has(f.invested, f.unrealized, f.marketValue)
      ? `${usd(f.invested)} cost ${signed(f.unrealized!)} = ${usd(f.marketValue)}` : null,
    source: "hybrid",
    related: ["invested", "unrealized_pl"],
  },
  unrealized_pl: {
    term: "Unrealized P/L",
    oneLiner: "The paper gain or loss on positions you still hold.",
    howItWorks: "Not locked in until you sell — it moves with the price.",
    howCalculated: "Market value − cost basis, across everything you hold.",
    example: (f) => has(f.marketValue, f.invested, f.unrealized)
      ? `${usd(f.marketValue)} − ${usd(f.invested)} = ${signed(f.unrealized!)}` : null,
    source: "computed",
    related: ["invested", "market_value", "realized_pl"],
  },
  realized_pl: {
    term: "Realized P/L",
    oneLiner: "Profit or loss you've actually locked in by selling.",
    howItWorks: "Every closed round-trip (a buy later sold) contributes its gain or loss. Scoped by the period selector on the Ledger.",
    howCalculated: "For each sell, proceeds − the cost of the specific lots it closed (the app matches sells to lots LIFO, per the ladder).",
    source: "computed",
    related: ["cost_basis", "day_trade", "last_position"],
  },
  day_change: {
    term: "Day change",
    oneLiner: "How much total account value moved since yesterday's close.",
    howItWorks: "Matches Schwab's 'Total day change'. Includes trading AND any deposits/withdrawals, so moving cash in shows up here too.",
    source: "schwab",
    related: ["account_value", "unrealized_pl"],
  },
  harvestable: {
    term: "Harvestable",
    oneLiner: "Profit you could lock in right now by selling every profitable last position.",
    howItWorks: "Equals what the 'Sell profitable' bulk action would realize — it only counts positions currently in the green.",
    howCalculated: "Sum over profitable last positions of (current price − last-buy price) × shares.",
    source: "computed",
    related: ["last_position", "realized_pl"],
  },

  // ---- margin ----
  margin_debt: {
    term: "Margin debt",
    oneLiner: "Money you've borrowed against your positions.",
    howItWorks: "Interest accrues on it daily. Shown as 'Debt on Owned' — a negative margin balance at Schwab.",
    source: "schwab",
    related: ["leverage", "maintenance_cushion"],
  },
  leverage: {
    term: "Leverage",
    oneLiner: "How far your market exposure exceeds your own money.",
    howItWorks: "1.0× means unlevered (all your own cash); above 1.0× means you're using margin to hold more than you funded.",
    howCalculated: "Long market value ÷ equity (your own money).",
    example: (f) => has(f.longMarketValue, f.equity, f.leverage) && f.equity
      ? `${usd(f.longMarketValue)} ÷ ${usd(f.equity)} = ${f.leverage!.toFixed(2)}×` : null,
    source: "computed",
    related: ["margin_debt", "deployed_pct"],
  },
  deployed_pct: {
    term: "Deployed %",
    oneLiner: "How much of your own capital is currently in the market.",
    howItWorks: "Measured against your equity, NOT counting margin — so fully invested reads ~100%, and using margin to buy more pushes it OVER 100%. It's the 'am I stretched?' signal.",
    howCalculated: "Long market value ÷ equity × 100.",
    example: (f) => has(f.longMarketValue, f.equity, f.deployedPct) && f.equity
      ? `${usd(f.longMarketValue)} ÷ ${usd(f.equity)} × 100 = ${f.deployedPct!.toFixed(1)}%` : null,
    source: "computed",
    related: ["leverage", "margin_debt"],
  },
  maintenance_cushion: {
    term: "Maintenance cushion",
    oneLiner: "How much your equity sits above the margin-call floor.",
    howItWorks: "If it hits zero you'd face a maintenance call. The bigger the cushion, the more room prices have to fall before that happens.",
    howCalculated: "Equity − Schwab's maintenance requirement.",
    example: (f) => has(f.equity, f.maintenance, f.maintCushion)
      ? `${usd(f.equity)} − ${usd(f.maintenance)} = ${usd(f.maintCushion)}` : null,
    source: "computed",
    related: ["margin_debt", "leverage"],
  },

  // ---- returns / ledger ----
  // Three different questions hide inside "how am I doing", and one number can't answer
  // all of them: (1) what base is my money measured against (peak_capital), (2) how many
  // dollars have I made (total_profit, split into gain_on_capital_at_work + profit_withdrawn),
  // (3) what rate did it earn (roi). A separate axis answers "what is actually mine to take
  // out": realized_ytd → tax_reserve → after_tax_realized. Each definition says what it
  // measures AND why it exists, since the why is what makes the number readable.
  peak_capital: {
    term: "Peak capital",
    oneLiner: "The most of your own money that was ever in the account at once. The base every return percentage is measured against.",
    howItWorks: "Why not total deposits: if you put in $1,900, pulled it all back out, then put in $9,500, you only ever had $9,500 at risk at one time, not $11,400. Counting the recycled money would make your return look smaller than it was. Why not net deposits: a withdrawal that included profit would shrink the base below what you actually risked. Peak capital avoids both.",
    howCalculated: "Walk every deposit and withdrawal in date order, tracking your principal. Deposits add to it. A withdrawal returns principal first; anything beyond that is profit taken out and is not subtracted. Peak capital is the highest that running principal ever reached.",
    example: (f) => has(f.peakCapital, f.depositedAllTime)
      ? `${usd(f.peakCapital)} at the high point (${usd(f.depositedAllTime)} deposited over time)` : null,
    source: "computed",
    related: ["capital_at_work", "total_profit", "roi", "profit_withdrawn", "net_deposits"],
  },
  capital_at_work: {
    term: "Capital at work",
    oneLiner: "Your own money currently in the account: everything deposited, minus the principal you have taken back out.",
    howItWorks: "This is what your holdings and cash are built on right now. Profit you withdrew is not subtracted, because it was never your principal. Compare account value to this to see how the money currently in is doing.",
    howCalculated: "Deposits − principal returned. A withdrawal counts here only up to the principal that was in the account at the time.",
    example: (f) => has(f.depositedAllTime, f.principalReturned, f.capitalAtWork)
      ? `${usd(f.depositedAllTime)} − ${usd(f.principalReturned)} = ${usd(f.capitalAtWork)}` : null,
    source: "computed",
    related: ["peak_capital", "gain_on_capital_at_work", "principal_returned"],
  },
  total_profit: {
    term: "Total profit",
    oneLiner: "Every dollar this account has made you, all time, whether it is still in the account or already withdrawn.",
    howItWorks: "The 'am I making money' number. It needs no capital base and it counts profit you already cashed out, so taking gains out never makes it drop. It splits into the gain on capital at work (the current run) plus profit already withdrawn (banked).",
    howCalculated: "Account value + everything withdrawn − everything deposited.",
    example: (f) => has(f.accountValue, f.withdrawnAllTime, f.depositedAllTime, f.totalProfit)
      ? `${usd(f.accountValue)} + ${usd(-f.withdrawnAllTime!)} − ${usd(f.depositedAllTime)} = ${signed(f.totalProfit!)}` : null,
    source: "computed",
    related: ["gain_on_capital_at_work", "profit_withdrawn", "roi", "realized_pl", "unrealized_pl"],
  },
  roi: {
    term: "Return on peak capital",
    oneLiner: "Total profit as a percentage of the most money you ever had at risk. The 'how well did my money do' number.",
    howItWorks: "Deposits and withdrawals are not performance: adding money is not a gain and taking it out is not a loss. Dividing by peak capital keeps your own transfers from inflating or deflating the figure. It is timing-blind, so a dollar in for a week counts the same as one in for a year; a time-weighted return would be the stricter scorecard of skill.",
    howCalculated: "Total profit ÷ peak capital × 100.",
    example: (f) => has(f.totalProfit, f.peakCapital, f.roiPct) && f.peakCapital
      ? `${signed(f.totalProfit!)} ÷ ${usd(f.peakCapital)} × 100 = ${f.roiPct! > 0 ? "+" : ""}${f.roiPct}%` : null,
    source: "computed",
    related: ["total_profit", "peak_capital", "net_deposits"],
  },
  gain_on_capital_at_work: {
    term: "Gain on capital at work",
    oneLiner: "How the money currently in the account is doing: what it is worth now versus the principal you have in.",
    howItWorks: "The gain on your current run only. It leaves out profit you already withdrew, which has its own line, so the two together equal total profit.",
    howCalculated: "Account value − capital at work.",
    example: (f) => has(f.accountValue, f.capitalAtWork, f.gainOnCapitalAtWork)
      ? `${usd(f.accountValue)} − ${usd(f.capitalAtWork)} = ${signed(f.gainOnCapitalAtWork!)}` : null,
    source: "computed",
    related: ["capital_at_work", "total_profit", "profit_withdrawn"],
  },
  profit_withdrawn: {
    term: "Profit withdrawn",
    oneLiner: "Gains you have already taken out of the account as cash.",
    howItWorks: "When a withdrawal is larger than the principal you had in at that moment, the extra is profit, not your own money coming back. It is banked: it counts toward total profit and it never reduces peak capital or capital at work. It was realized, so it was taxable in the year those trades closed.",
    howCalculated: "For each withdrawal, the amount beyond the principal in the account at the time, summed.",
    example: (f) => has(f.withdrawnAllTime, f.principalReturned, f.profitWithdrawn) && f.withdrawnAllTime! < 0
      ? `${usd(-f.withdrawnAllTime!)} withdrawn = ${usd(f.principalReturned)} principal back + ${usd(f.profitWithdrawn)} profit` : null,
    source: "computed",
    related: ["principal_returned", "total_profit", "peak_capital", "realized_pl"],
  },
  principal_returned: {
    term: "Principal returned",
    oneLiner: "The part of your withdrawals that was your own money coming back, not profit.",
    howItWorks: "Taking your own deposit back out is not income and is not taxed. It lowers capital at work but leaves total profit untouched.",
    howCalculated: "For each withdrawal, the amount up to the principal in the account at the time, summed.",
    example: (f) => has(f.withdrawnAllTime, f.principalReturned, f.profitWithdrawn) && f.withdrawnAllTime! < 0
      ? `${usd(-f.withdrawnAllTime!)} withdrawn = ${usd(f.principalReturned)} principal back + ${usd(f.profitWithdrawn)} profit` : null,
    source: "computed",
    related: ["profit_withdrawn", "capital_at_work", "net_deposits"],
  },
  net_deposits: {
    term: "Net deposits",
    oneLiner: "Money in minus money out, as a plain running total. Sound as a cash cross-check, misleading as a capital base.",
    howItWorks: "A withdrawal that included profit subtracts that profit too, so net deposits can land below the principal you actually have in. For 'how much of my money is in' read capital at work; for a return base read peak capital.",
    howCalculated: "Sum of all deposits − sum of all withdrawals. Transfers, wires and cash journals only, never trades or dividends.",
    example: (f) => has(f.depositedAllTime, f.withdrawnAllTime)
      ? `${usd(f.depositedAllTime)} − ${usd(-f.withdrawnAllTime!)} = ${usd(f.depositedAllTime! + f.withdrawnAllTime!)}` : null,
    source: "hybrid",
    related: ["peak_capital", "capital_at_work", "cash_identity"],
  },
  realized_ytd: {
    term: "Realized this year",
    oneLiner: "Profit locked in by selling during the current calendar year. The number tax is owed on.",
    howItWorks: "Only closed trades count; positions you still hold are paper gains and are not taxed until sold. The ladder holds under a year, so this is short-term gain, taxed as ordinary income on top of your salary. It is fixed to the calendar year and does not move with the period selector.",
    howCalculated: "Sum of profit on trades closed since January 1 of this year.",
    example: (f) => has(f.realizedYtd, f.thisYear)
      ? `${signed(f.realizedYtd!)} locked in so far in ${f.thisYear}` : null,
    source: "computed",
    related: ["realized_pl", "tax_reserve", "after_tax_realized", "unrealized_pl"],
  },
  tax_reserve: {
    term: "Tax reserve",
    oneLiner: "An estimate of the tax this year's realized gains will add to your bill: the amount to hold back.",
    howItWorks: "Short-term gains stack on top of your other income, so the app computes the extra federal tax the gains cause at your real marginal bracket, plus a flat state rate. A planning estimate, not tax advice; the true figure depends on your full return. Salary and state rate are set under Settings → Taxes.",
    howCalculated: "federal tax(salary + realized) − federal tax(salary), plus realized × state rate. A net loss reserves $0.",
    example: (f) => has(f.realizedYtd, f.taxReserve)
      ? `${usd(f.realizedYtd)} realized → hold back about ${usd(f.taxReserve)}` : null,
    source: "computed",
    related: ["realized_ytd", "after_tax_realized", "progressive_tax"],
  },
  after_tax_realized: {
    term: "After tax, this year",
    oneLiner: "This year's locked-in profit with the estimated tax set aside: the part that is actually yours to keep.",
    howItWorks: "The practical 'what could I take out' figure. Withdrawing more than this means pulling out principal, or counting on paper gains that can still reverse. It does not subtract profit you already withdrew this year, so read that line alongside it.",
    howCalculated: "Realized this year − tax reserve.",
    example: (f) => has(f.realizedYtd, f.taxReserve, f.afterTaxRealized)
      ? `${usd(f.realizedYtd)} − ${usd(f.taxReserve)} = ${signed(f.afterTaxRealized!)}` : null,
    source: "computed",
    related: ["realized_ytd", "tax_reserve", "profit_withdrawn", "unrealized_pl"],
  },
  cash_identity: {
    term: "Cash cross-check",
    oneLiner: "A proof that the app's money history reconciles with Schwab's actual cash.",
    howItWorks: "If deposits + trading + income + fees don't add up to the real cash balance, something's missing — the check surfaces the gap instead of hiding it.",
    howCalculated: "net deposits + trading + income + other cash − margin debt, compared to Schwab's actual cash.",
    source: "computed",
    related: ["net_deposits", "margin_debt"],
  },

  // ---- ladder / strategy ----
  last_position: {
    term: "Last position",
    oneLiner: "Your most recent buy in a symbol — the bottom rung of its ladder.",
    howItWorks: "The strategy adds to a position in rungs; the 'last position' is the newest, deepest one. Its price sets where the next sell target and buy-dip are measured from.",
    source: "computed",
    related: ["ladder_rung", "sell_target", "buy_dip", "harvestable"],
  },
  ladder_rung: {
    term: "Ladder rung",
    oneLiner: "One step in a staged position — a single buy at a progressively lower price.",
    howItWorks: "Rather than buying all at once, the strategy ladders in: each dip adds a rung, and sells peel rungs back off (newest first, LIFO).",
    source: "computed",
    related: ["last_position", "buy_dip", "sell_target"],
  },
  buy_dip: {
    term: "Buy dip",
    oneLiner: "How far a price must fall below your last position before the app suggests adding.",
    howCalculated: "Last-position price × (1 − your dip %). Configurable per account and per symbol.",
    source: "computed",
    related: ["last_position", "ladder_rung", "sell_target"],
  },
  sell_target: {
    term: "Sell target",
    oneLiner: "The price at which the app suggests selling a position for profit.",
    howCalculated: "Last-position price × (1 + your sell-target %). Configurable per account and per symbol.",
    source: "computed",
    related: ["last_position", "sell_min_gain", "harvestable"],
  },
  sell_min_gain: {
    term: "Minimum gain",
    oneLiner: "The smallest profit a position must show before it's eligible to sell.",
    howItWorks: "Keeps the bulk 'sell profitable' action from dumping barely-green positions — anything below this floor is left alone.",
    source: "computed",
    related: ["sell_target", "harvestable"],
  },
  simple_view: {
    term: "Simple view",
    oneLiner: "A pared-down dashboard showing only the essentials.",
    howItWorks: "Hides the denser columns and marks so the table reads at a glance. Toggle it from the view pills.",
    source: "computed",
  },

  // ---- trades / tax ----
  cost_basis: {
    term: "Cost basis",
    oneLiner: "What you paid for the shares — the number gains are measured from.",
    howItWorks: "For shares bought within the API/CSV history it's the exact fill price. For older shares it may be Schwab's average cost (see Backfilled lot).",
    source: "hybrid",
    related: ["invested", "realized_pl", "backfilled_lot"],
  },
  day_trade: {
    term: "Day trade",
    oneLiner: "A position bought and fully sold on the same day.",
    howItWorks: "Flagged in the trade journal. Purely informational here — the pattern-day-trade rule was repealed, so nothing blocks them.",
    source: "computed",
    related: ["realized_pl", "hold_days"],
  },
  hold_days: {
    term: "Hold days",
    oneLiner: "How long you held a position from first buy to final sell.",
    howItWorks: "Drives the short- vs long-term tax split (365+ days = long-term).",
    howCalculated: "Calendar days between the opening buy and the closing sell.",
    source: "computed",
    related: ["day_trade", "progressive_tax"],
  },
  progressive_tax: {
    term: "Progressive tax estimate",
    oneLiner: "Estimated tax on your gains, stacked on top of your other income.",
    howItWorks: "Gains are taxed at your marginal bracket, so the app stacks them ON your salary rather than taxing them in isolation. An estimate, not tax advice.",
    howCalculated: "federal tax(salary + gains) − federal tax(salary), plus a flat state rate. Salary is an editable field used only to place the bracket.",
    source: "computed",
    related: ["realized_pl", "hold_days"],
  },
  backfilled_lot: {
    term: "Backfilled lot",
    oneLiner: "A holding the app couldn't reconstruct from history, priced at Schwab's average.",
    howItWorks: "Happens when shares were bought before the account's API history begins and no CSV covers them. The share count is right; the cost is Schwab's average rather than the exact fills. Import a Transactions CSV covering those buys to make it exact.",
    source: "hybrid",
    related: ["cost_basis", "invested"],
  },
  "52wk_high_pct": {
    term: "% of 52-week high",
    oneLiner: "Where the price sits relative to its highest point in the last year.",
    howCalculated: "Current price ÷ 52-week high × 100. For leveraged/inverse ETFs a 13-week " +
      "(one-quarter) high is used instead — their value bleeds via daily rebalancing, so a " +
      "year-old high they may never revisit would make every reading look falsely cheap. A " +
      "faint \"13w\" tag marks those rows.",
    source: "hybrid",
    related: ["52wk_low_pct"],
  },
  "52wk_low_pct": {
    term: "% above 52-week low",
    oneLiner: "How far above its lowest point in the last year the price is trading. 0% = sitting on the low.",
    howCalculated: "(Current price ÷ 52-week low − 1) × 100 — normalized so the low reads 0%, not " +
      "100% (the price can never be below its own 52-week low). E.g. 20% means it trades 20% above " +
      "the year's low. For leveraged/inverse ETFs a 13-week (one-quarter) low is used instead " +
      "(daily-rebalancing decay makes a year-old low stale); a faint \"13w\" tag marks those rows.",
    source: "hybrid",
    related: ["52wk_high_pct"],
  },
};

/** All defined term ids (handy for tests + Alt-reveal). */
export const TERM_IDS = Object.keys(GLOSSARY);
