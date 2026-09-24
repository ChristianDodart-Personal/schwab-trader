import { Fragment } from "react";
import type { Notification } from "../types";
import { dayKey, dayLabel, fmtTime, matchText } from "./format";
import { PS } from "./ui";

// Classify a feed row for its scannable type glyph. Live pushes carry `kind`;
// stored rows don't, so infer: an alert_id ⇒ a price alert; else read the message
// (fills say bought/sold/filled; strategy triggers say dipped/target/trigger).
function inferKind(n: Notification): string {
  if (n.kind) return n.kind;
  if (n.alert_id != null) return "alert";
  const m = (n.message || "").toLowerCase();
  if (/\b(bought|sold|filled|fill)\b/.test(m)) return "fill";
  if (/\b(dip|dipped|target|trigger|rung|position|next buy)\b/.test(m)) return "trigger";
  if (/\b(schwab|connection|re-?auth|reconnect|expire)\b/.test(m)) return "system";
  return "alert";
}

// Emoji-free glyphs (matches the app's ●/▲/▼ language), color-coded per type.
// Exported so the Notifications nav tab can pill each unread category in the same language.
export const KIND_ICON: Record<string, { glyph: string; color: string; label: string }> = {
  alert: { glyph: "!", color: "var(--warn)", label: "Price alert" },
  trigger: { glyph: "▸", color: "var(--accent)", label: "Strategy trigger" },
  fill: { glyph: "✓", color: "var(--pos)", label: "Order fill" },
  system: { glyph: "i", color: "var(--text-dim)", label: "System" },
  notice: { glyph: "※", color: "var(--warn)", label: "App notice" },
};
// A kind the UI doesn't know yet (a newer backend) must render, never throw.
export const KIND_FALLBACK = { glyph: "•", color: "var(--text-dim)", label: "Other" };

function KindIcon({ n }: { n: Notification }) {
  const k = KIND_ICON[inferKind(n)] ?? KIND_FALLBACK;
  return (
    <span title={k.label} aria-label={k.label}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center",
               width: 16, minWidth: 16, height: 16, borderRadius: 4, marginTop: 1,
               fontSize: 11, fontWeight: 700, color: k.color,
               border: `1px solid ${k.color}`, lineHeight: 1 }}>
      {k.glyph}
    </span>
  );
}

/** The notification feed: recent items with day separators + history search.
 * Delivery toggles now live on the tab's Settings sub-tab (unified prefs). */
export function FeedPanel({ notes, unread, q, onQ, desktopPerm, onEnableDesktop, onMarkAllRead }: {
  notes: Notification[];
  unread: number;
  q: string;
  onQ: (q: string) => void;
  desktopPerm: string;
  onEnableDesktop: () => void;
  onMarkAllRead: () => void;
}) {
  const feed = notes.filter((n) => matchText(q, n.message, n.symbol));
  return (
    <div style={PS.body} id="nt-panel-feed" role="tabpanel" aria-labelledby="nt-tab-feed" tabIndex={0}>
      <div style={PS.barRow}>
        <span style={PS.dim}>{notes.length} recent</span>
        <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {desktopPerm === "granted" ? (
            <span style={{ ...PS.dim, color: "var(--pos)" }}>desktop pop-ups on</span>
          ) : desktopPerm === "unsupported" ? null : (
            <button style={PS.linkBtn} onClick={onEnableDesktop}>Enable desktop alerts</button>
          )}
          {unread > 0 && (
            <button style={PS.linkBtn} onClick={onMarkAllRead}>
              Mark all read
            </button>
          )}
        </span>
      </div>
      <input className="field" value={q} onChange={(e) => onQ(e.target.value)}
        placeholder="Filter by symbol or text" aria-label="Filter notifications" style={PS.search} />
      {notes.length === 0 ? (
        <p style={PS.empty}>No notifications yet. Set a price alert →</p>
      ) : feed.length === 0 ? (
        <p style={PS.empty}>No matches for "{q}".</p>
      ) : (
        (() => {
          let lastDay = "";
          return feed.map((n) => {
            const dk = dayKey(n.created_at);
            const sep = dk !== lastDay ? <div style={PS.daySep}>{dayLabel(n.created_at)}</div> : null;
            lastDay = dk;
            return (
              <Fragment key={n.id}>
                {sep}
                <div style={{ ...PS.note, opacity: n.read ? 0.55 : 1 }}>
                  {!n.read && <span style={PS.dot} />}
                  <KindIcon n={n} />
                  <div style={{ flex: 1 }}>
                    <div style={PS.noteMsg}>{n.message}</div>
                    <div style={PS.noteTime}>{fmtTime(n.created_at)}</div>
                  </div>
                </div>
              </Fragment>
            );
          });
        })()
      )}
    </div>
  );
}
