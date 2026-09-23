import { useState } from "react";
import type { NotifChannels, NotifPrefs } from "../types";
import { PhoneNotify } from "../settings/PhoneNotify";
import { PS } from "./ui";
import { IconClose, IconPlay } from "../Icon";
import { useToast } from "../Toast";
import { playNotifSound } from "./sound";

// The Settings sub-tab of the Notifications tab: one clear place to decide what
// interrupts you. A category × channel grid, a global mute, per-symbol mutes, and
// the phone connection. Muting never loses history — a muted item still lands in the
// feed, it just doesn't badge, pop, or text you. Each category has a Preview button
// that demonstrates exactly what it looks + sounds like.

const CATS: { key: "alert" | "trigger" | "fill"; label: string; desc: string; sample: string }[] = [
  { key: "alert", label: "Price alerts", desc: "Your set price thresholds", sample: "AAPL crossed above 200 (now 200.14)" },
  { key: "trigger", label: "Strategy triggers", desc: "A position dipped in, or a lot hit its sell target", sample: "NVDA dipped to a buy rung — position 3 suggested" },
  { key: "fill", label: "Order fills", desc: "A resting order executed", sample: "Filled: bought 10 MSFT @ 415.20" },
];
const CHANS: { key: keyof NotifChannels; label: string }[] = [
  { key: "bell", label: "In-app" },
  { key: "desktop", label: "Desktop" },
  { key: "phone", label: "Phone" },
  { key: "sound", label: "Sound" },
];

export function PrefsPanel({ prefs, savePrefs, desktopPerm, onEnableDesktop }: {
  prefs: NotifPrefs;
  savePrefs: (patch: Partial<NotifPrefs>) => void;
  desktopPerm: string;
  onEnableDesktop: () => void;
}) {
  const [sym, setSym] = useState("");
  const toast = useToast();

  const setCell = (cat: "alert" | "trigger" | "fill", chan: keyof NotifChannels, v: boolean) =>
    savePrefs({ categories: { ...prefs.categories, [cat]: { ...prefs.categories[cat], [chan]: v } } });

  // Show + play exactly what a notification of this category is like — the in-app
  // toast, a sample desktop pop-up (if permitted), and the category's chime.
  const preview = (cat: typeof CATS[number]) => {
    playNotifSound(cat.key);
    toast(`${cat.label} — ${cat.sample}`, "info");
    if (desktopPerm === "granted") {
      try { new Notification("Schwab Trader", { body: `${cat.label} — ${cat.sample}` }); } catch { /* ignore */ }
    }
  };

  const addMute = () => {
    const s = sym.trim().toUpperCase();
    if (!s || prefs.muted_symbols.includes(s)) { setSym(""); return; }
    savePrefs({ muted_symbols: [...prefs.muted_symbols, s] });
    setSym("");
  };
  const rmMute = (s: string) => savePrefs({ muted_symbols: prefs.muted_symbols.filter((x) => x !== s) });

  return (
    <div style={{ ...PS.body, maxHeight: "none" }} id="nt-panel-settings" role="tabpanel" aria-labelledby="nt-tab-settings" tabIndex={0}>
      {/* Global mute */}
      <label style={G.muteRow}>
        <input type="checkbox" checked={prefs.muted} onChange={(e) => savePrefs({ muted: e.target.checked })} />
        <span>
          <b>Mute all notifications</b>
          <div style={G.dim}>Nothing pops, badges, or texts you, except reminders to reconnect Schwab (the app stops working without them). Everything is still recorded in the feed below.</div>
        </span>
      </label>

      {/* Category × channel grid */}
      <div style={{ ...G.dim, margin: "14px 0 6px" }}>
        What to deliver, and where — <b>for the account you're on now</b>. Switch accounts to set another's.
      </div>
      <div style={G.grid} role="table" aria-label="Notification delivery by category and channel">
        <div style={G.gridHead} role="row">
          <span role="columnheader" />
          {CHANS.map((c) => <span key={c.key} role="columnheader" style={G.colHead}>{c.label}</span>)}
        </div>
        {CATS.map((cat) => (
          <div key={cat.key} role="row" style={{ ...G.gridRow, opacity: prefs.muted ? 0.45 : 1 }}>
            <span role="rowheader" style={G.rowHead}>
              <div style={G.rowTitle}>
                <b>{cat.label}</b>
                <button type="button" style={G.preview} onClick={() => preview(cat)}
                  title={`Preview a ${cat.label} notification (see + hear it)`} aria-label={`Preview ${cat.label}`}>
                  <IconPlay /> Preview
                </button>
              </div>
              <div style={G.dim}>{cat.desc}</div>
            </span>
            {CHANS.map((ch) => (
              <label key={ch.key} style={G.cell} title={`${cat.label} → ${ch.label}`}>
                <input type="checkbox" disabled={prefs.muted}
                  checked={prefs.categories[cat.key][ch.key]}
                  onChange={(e) => setCell(cat.key, ch.key, e.target.checked)}
                  aria-label={`${cat.label} ${ch.label}`} />
              </label>
            ))}
          </div>
        ))}
      </div>
      {desktopPerm !== "granted" && desktopPerm !== "unsupported" && (
        <p style={G.hint}>
          Desktop pop-ups need permission — <button style={PS.linkBtn} onClick={onEnableDesktop}>enable them</button>.
        </p>
      )}

      {/* Per-symbol mute */}
      <div style={{ ...G.dim, margin: "16px 0 6px" }}>Mute specific tickers</div>
      <div style={G.muteAdd}>
        <input className="field" value={sym} onChange={(e) => setSym(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && addMute()} placeholder="Ticker" aria-label="Mute a ticker"
          style={{ width: 110, height: 30 }} />
        <button className="btn btn-secondary btn-sm" onClick={addMute}>Mute</button>
      </div>
      {prefs.muted_symbols.length > 0 && (
        <div style={G.chips}>
          {prefs.muted_symbols.map((s) => (
            <span key={s} style={G.chip}>
              {s}
              <button style={G.chipX} aria-label={`Unmute ${s}`} onClick={() => rmMute(s)}><IconClose /></button>
            </span>
          ))}
        </div>
      )}

      {/* Phone connection */}
      <div style={{ ...G.dim, margin: "18px 0 6px" }}>Phone</div>
      <p style={{ ...G.hint, marginTop: 0 }}>
        Optional. ntfy.sh needs no account — pick a hard-to-guess topic and subscribe in the free ntfy app; or use
        email via SMTP (an app password, not your login). The <b>Phone</b> column above chooses what reaches it.
      </p>
      <PhoneNotify />
    </div>
  );
}

const G: Record<string, React.CSSProperties> = {
  muteRow: { display: "flex", gap: 10, alignItems: "flex-start", padding: "4px 0", cursor: "pointer", fontSize: "var(--fs-sm)" },
  dim: { fontSize: "var(--fs-2xs)", color: "var(--text-dim)", lineHeight: 1.4 },
  grid: { border: "1px solid var(--border)", borderRadius: "var(--r-md)", overflow: "hidden" },
  gridHead: { display: "grid", gridTemplateColumns: "1fr 52px 52px 52px 52px", alignItems: "center",
    background: "var(--panel-2)", padding: "6px 10px" },
  colHead: { textAlign: "center", fontSize: "var(--fs-2xs)", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)" },
  gridRow: { display: "grid", gridTemplateColumns: "1fr 52px 52px 52px 52px", alignItems: "center",
    padding: "8px 10px", borderTop: "1px solid var(--border-hairline)" },
  rowHead: { fontSize: "var(--fs-sm)" },
  rowTitle: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  preview: { display: "inline-flex", alignItems: "center", gap: 4, background: "transparent",
    border: "1px solid var(--border)", borderRadius: "var(--r-pill)", color: "var(--accent)",
    cursor: "pointer", fontSize: "var(--fs-2xs)", fontWeight: 600, padding: "2px 9px" },
  cell: { display: "flex", justifyContent: "center", cursor: "pointer" },
  hint: { fontSize: "var(--fs-xs)", color: "var(--text-dim)", marginTop: 8, lineHeight: 1.45 },
  muteAdd: { display: "flex", gap: 6, alignItems: "center" },
  chips: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 },
  chip: { display: "inline-flex", alignItems: "center", gap: 4, background: "var(--panel-2)",
    border: "1px solid var(--border)", borderRadius: "var(--r-pill)", padding: "2px 6px 2px 10px",
    fontSize: "var(--fs-xs)", fontWeight: 600 },
  chipX: { background: "transparent", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: "var(--fs-md)", lineHeight: 1, padding: 0 },
};
