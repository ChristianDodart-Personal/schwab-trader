import { Term } from "./GlossaryUI";
import { IconWarning } from "./Icon";
import { needsIcon, readLines, shortDate, STATUS_TEXT, TONE_COLOR } from "./ladderRead";
import type { LadderRead } from "./types";

// The Ladder read in the drill-down and on the buy ticket: a one-line strip of chips
// (always visible, so the context is there when you decide on a rung) that opens the
// full read, with the recent-dip history when it's available. Reference only.

type Status = "ready" | "loading" | "unavailable" | "short" | undefined;
const waiting = (st: Status) => st === "unavailable" ? STATUS_TEXT.unavailable : st === "short" ? STATUS_TEXT.short : STATUS_TEXT.loading;

export function LadderStrip({ read, status, onOpen, open, note }: {
  read: LadderRead | null | undefined; status?: Status; onOpen: () => void; open: boolean;
  note?: string;   // a short qualifier after the chips (e.g. on a ticket for a deeper rung)
}) {
  if (read === undefined) return null;
  const lines = readLines(read);
  return (
    <div style={S.strip}>
      <span style={S.stripLabel}><Term id="ladder_read">Ladder read</Term></span>
      {read === null ? (
        <span style={S.faint}>{waiting(status)}</span>
      ) : (
        <button type="button" onClick={onOpen} aria-expanded={open} style={S.stripBtn}
          aria-label={`Ladder read: ${lines.map((l) => l.chip).join(", ")}. ${open ? "Hide" : "Show"} details`}>
          {lines.map((l) => (
            <span key={l.key} title={l.title}
              style={{ ...S.chip, color: TONE_COLOR[l.tone], borderColor: l.tone === "neutral" ? "var(--border)" : TONE_COLOR[l.tone] }}>
              {needsIcon(l.tone) && <IconWarning size={11} />}{l.chip}
            </span>
          ))}
          <span style={S.more}>{open ? "Hide" : "Details"}</span>
        </button>
      )}
      {read && note && <span style={S.faint}>{note}</span>}
    </div>
  );
}

function outcome(e: NonNullable<LadderRead["events"]>[number], window: number) {
  if (e.outcome === "recovered") return { text: `Hit target in ${e.days}d`, color: "var(--pos)" };
  if (e.outcome === "expired") return { text: `Missed (${Math.round(window / 21)} mo)`, color: "var(--neg)" };
  return { text: `Now, day ${e.age ?? "?"} of ${window}`, color: "var(--text-dim)" };
}

export function LadderReadPanel({ read, status }: { read: LadderRead | null | undefined; status?: Status }) {
  if (!read) {
    return <p style={{ ...S.faint, margin: "10px 0" }}>
      {status === "unavailable" || status === "short" ? waiting(status) : "The ladder read appears once this stock's 5-year price history has loaded."}
    </p>;
  }
  const lines = readLines(read);
  const events = read.events ?? [];
  const win = read.bounce.window_days;
  return (
    <div style={S.panel} aria-label="Ladder read">
      <ul style={S.list}>
        {lines.map((l) => (
          <li key={l.key} style={S.item}>
            <span style={{ ...S.dot, background: TONE_COLOR[l.tone] }} aria-hidden="true" />
            <div>
              <div style={S.title}>
                <span style={{ color: l.tone === "neutral" ? "var(--text)" : TONE_COLOR[l.tone], display: "inline-flex", alignItems: "center", gap: 4 }}>
                  {needsIcon(l.tone) && <IconWarning size={12} />}{l.title}
                </span>
                <span style={S.term}><Term id={TERM[l.key]}>{LABEL[l.key]}</Term></span>
              </div>
              <div style={S.detail}>{l.detail}</div>
            </div>
          </li>
        ))}
      </ul>

      {events.length > 0 && (
        <>
          <div style={S.subhead}>Recent {Math.round(read.bounce.dip_pct * 100)}% dips</div>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ fontSize: "var(--fs-xs)" }}>
              <thead>
                <tr>
                  <th scope="col" className="left">Dip day</th>
                  <th scope="col" title="The rung-2 buy the dip would have made, at that day's close">Would-be buy</th>
                  <th scope="col" className="left">Outcome</th>
                  <th scope="col" title="Lowest price before it hit the target (or the window ended), vs the would-be buy">Deepest</th>
                  <th scope="col" title="The deepest rung the ladder would have reached (the dip buy is rung 2)">Rung reached</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const o = outcome(e, win);
                  const deep = e.rung_reached >= 8;
                  return (
                    <tr key={e.date}>
                      <td className="left">{shortDate(e.date, true)}</td>
                      <td>{e.entry.toLocaleString("en-US", { style: "currency", currency: "USD" })}</td>
                      <td className="left" style={{ color: o.color }}>{o.text}</td>
                      <td style={{ color: e.low_pct < 0 ? "var(--neg)" : "var(--text-dim)" }}>
                        {e.low_pct < 0 ? `−${(Math.abs(e.low_pct) * 100).toFixed(1)}%` : "—"}
                      </td>
                      <td style={{ color: deep ? "var(--warn)" : undefined }}>
                        {deep && <IconWarning size={11} />} {e.rung_reached}{e.rung_reached > 10 ? " (past 10)" : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p style={{ ...S.faint, marginTop: 8 }}>
        Reference only: from daily prices as of {shortDate(read.asof, true)}, using your rung drops and sell target. It doesn't change BUY/SELL or any order.
      </p>
    </div>
  );
}

const TERM = { bounce: "bounce_rate", chop: "chop", dip: "dip_size", why: "why_down", decay: "rebalance_decay" } as const;
const LABEL = { bounce: "Bounce rate", chop: "Chop", dip: "Dip size", why: "Why down", decay: "Rebalance decay" } as const;

const S: Record<string, React.CSSProperties> = {
  strip: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "4px 0 2px" },
  stripLabel: { fontSize: "var(--fs-2xs)", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)" },
  stripBtn: { display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap", background: "transparent", border: "none", padding: 0, cursor: "pointer" },
  chip: { display: "inline-flex", alignItems: "center", gap: 3, fontSize: "var(--fs-xs)", fontWeight: 600, border: "1px solid", borderRadius: "var(--r-pill)", padding: "1px 8px", whiteSpace: "nowrap" },
  more: { fontSize: "var(--fs-xs)", color: "var(--accent)" },
  faint: { fontSize: "var(--fs-xs)", color: "var(--text-faint)" },
  panel: { marginTop: 8, padding: "12px 14px", border: "1px solid var(--border)", borderRadius: "var(--r-md)", background: "var(--panel-2)" },
  list: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 },
  item: { display: "flex", gap: 10, alignItems: "flex-start" },
  dot: { width: 8, height: 8, borderRadius: "50%", marginTop: 6, flexShrink: 0 },
  title: { fontSize: "var(--fs-sm)", fontWeight: 600, display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" },
  term: { fontSize: "var(--fs-2xs)", fontWeight: 500, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.04em" },
  detail: { fontSize: "var(--fs-sm)", color: "var(--text-muted)", lineHeight: 1.5, marginTop: 2 },
  subhead: { fontSize: "var(--fs-2xs)", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)", margin: "14px 0 6px" },
};
