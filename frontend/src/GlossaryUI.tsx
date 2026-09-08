// The glossary UI: <Term id="..."> renders a term that's tinted at rest and "lights up"
// (brighter + glow) on hover / focus / while Alt is held. Hovering shows its definition;
// clicking pins it. The definition box is a SINGLE interactive popover (portaled to
// <body>) owned by <GlossaryProvider> — so there's only ever one open, z-order is sane,
// and "related" terms drill IN PLACE with a "← back" breadcrumb (a mini-wiki), instead
// of a fragile tower of stacked tooltips. Hold Alt to light up every term on screen at
// once (the Path-of-Exile move). Definitions come from the central registry (glossary.ts).
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GLOSSARY, SOURCE_LABEL, type GlossaryEntry, type GlossaryFigures } from "./glossary";

type Anchor = { x: number; y: number; above: boolean };
type Ctx = {
  hoverOpen: (id: string, el: HTMLElement | null) => void;
  hoverClose: () => void;
  pinOpen: (id: string, el: HTMLElement | null) => void;
  push: (id: string) => void;
  setFigures: (f: GlossaryFigures | null) => void;
};
const GlossaryCtx = createContext<Ctx | null>(null);

/** Feed the selected account's live figures to the glossary (for worked examples). */
export function useGlossaryFigures(): (f: GlossaryFigures | null) => void {
  return useContext(GlossaryCtx)?.setFigures ?? (() => {});
}

const OPEN_DELAY_MS = 380;   // dwell before a hover opens (0 while Alt held — "show me everything")
const CLOSE_GRACE_MS = 140;  // grace to travel from the term into the popover

function anchorFor(el: HTMLElement): Anchor {
  const r = el.getBoundingClientRect();
  const above = r.top > window.innerHeight * 0.6; // flip up when low on screen
  const x = Math.min(Math.max(r.left + r.width / 2, 180), window.innerWidth - 180);
  return { x, y: above ? r.top - 8 : r.bottom + 8, above };
}

export function GlossaryProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [sticky, setSticky] = useState(false);
  const [figures, setFiguresState] = useState<GlossaryFigures | null>(null);
  // Feeds MERGE. The dashboard (App) and the Ledger each supply the figures they own, on
  // their own cadence; a plain replace would let a ~1/s dashboard tick wipe the ledger's
  // figures (or vice versa). Passing null clears everything.
  const setFigures = useCallback((f: GlossaryFigures | null) =>
    setFiguresState((prev) => (f === null ? null : { ...(prev ?? {}), ...f })), []);
  const openT = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closeT = useRef<ReturnType<typeof setTimeout>>(undefined);
  const altRef = useRef(false);

  const clearTimers = () => { clearTimeout(openT.current); clearTimeout(closeT.current); };
  const close = useCallback(() => { clearTimers(); setStack([]); setAnchor(null); setSticky(false); }, []);

  const hoverOpen = useCallback((id: string, el: HTMLElement | null) => {
    if (!el || !GLOSSARY[id]) return;
    clearTimeout(closeT.current);
    clearTimeout(openT.current);
    openT.current = setTimeout(() => {
      setAnchor(anchorFor(el)); setStack([id]); setSticky(false);
    }, altRef.current ? 0 : OPEN_DELAY_MS);
  }, []);

  const hoverClose = useCallback(() => {
    clearTimeout(openT.current);
    // Don't yank a pinned card, and give the pointer time to reach the popover.
    closeT.current = setTimeout(() => { if (!sticky) close(); }, CLOSE_GRACE_MS);
  }, [sticky, close]);

  const pinOpen = useCallback((id: string, el: HTMLElement | null) => {
    if (!el || !GLOSSARY[id]) return;
    clearTimers();
    setAnchor(anchorFor(el)); setStack([id]); setSticky(true);
  }, []);

  const push = useCallback((id: string) => {
    if (!GLOSSARY[id]) return;
    clearTimers();
    setSticky(true); // drilling implies you're reading — keep it open
    setStack((s) => (s[s.length - 1] === id ? s : [...s, id]));
  }, []);

  const goBack = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  // Alt = "light up every term" + open hovers instantly. Prevent the browser/Electron
  // menu-bar focus that Alt normally triggers.
  useEffect(() => {
    const root = document.documentElement;
    const down = (e: KeyboardEvent) => {
      if (e.key === "Alt" && !altRef.current) { altRef.current = true; root.setAttribute("data-gloss-lit", ""); e.preventDefault(); }
      if (e.key === "Escape") close();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Alt") { altRef.current = false; root.removeAttribute("data-gloss-lit"); e.preventDefault(); }
    };
    const blur = () => { altRef.current = false; root.removeAttribute("data-gloss-lit"); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  }, [close]);

  // While open: a pinned card dismisses on outside click; any scroll/resize closes
  // (the fixed popover would otherwise drift from its term).
  useEffect(() => {
    if (!anchor) return;
    const onScroll = () => close();
    const onDown = (e: MouseEvent) => {
      const pop = document.getElementById("gloss-pop");
      if (sticky && pop && !pop.contains(e.target as Node)) close();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [anchor, sticky, close]);

  const ctx: Ctx = { hoverOpen, hoverClose, pinOpen, push, setFigures };
  const id = stack[stack.length - 1];
  const entry = id ? GLOSSARY[id] : null;

  return (
    <GlossaryCtx.Provider value={ctx}>
      {children}
      {entry && anchor && createPortal(
        <div id="gloss-pop" className="gloss-anchor"
          style={{ left: anchor.x, top: anchor.y, transform: anchor.above ? "translate(-50%,-100%)" : "translate(-50%,0)" }}
          onMouseEnter={() => clearTimeout(closeT.current)}
          onMouseLeave={hoverClose}
        >
          <DefinitionCard entry={entry} figures={figures} canBack={stack.length > 1} onBack={goBack} onClose={close}
            onRelated={push} />
        </div>,
        document.body,
      )}
    </GlossaryCtx.Provider>
  );
}

function DefinitionCard({ entry, figures, canBack, onBack, onClose, onRelated }: {
  entry: GlossaryEntry; figures: GlossaryFigures | null; canBack: boolean;
  onBack: () => void; onClose: () => void; onRelated: (id: string) => void;
}) {
  // The formula worked out on the SELECTED account's live numbers, when we have them.
  const worked = entry.example && figures ? entry.example(figures) : null;
  return (
    <div className={`gloss-pop`} role="dialog" aria-label={`${entry.term} definition`}>
      <div className="gloss-head">
        {canBack && (
          <button type="button" className="gloss-back" onClick={onBack} aria-label="Back">←</button>
        )}
        <span className="gloss-term">{entry.term}</span>
        <button type="button" className="gloss-x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <p className="gloss-one">{entry.oneLiner}</p>
      {entry.howItWorks && (
        <div className="gloss-sec"><span className="gloss-lbl">How it works</span><p>{entry.howItWorks}</p></div>
      )}
      {entry.howCalculated && (
        <div className="gloss-sec"><span className="gloss-lbl">How it's calculated</span><p>{entry.howCalculated}</p></div>
      )}
      {worked && (
        <div className="gloss-calc">
          <span className="gloss-lbl">On this account now</span>
          <code>{worked}</code>
        </div>
      )}
      <div className="gloss-source" data-source={entry.source}>{SOURCE_LABEL[entry.source]}</div>
      {entry.related && entry.related.length > 0 && (
        <div className="gloss-related">
          <span className="gloss-lbl">Related</span>
          <div className="gloss-chips">
            {entry.related.filter((r) => GLOSSARY[r]).map((r) => (
              <button key={r} type="button" className="gloss-chip" onClick={() => onRelated(r)}>
                {GLOSSARY[r].term}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// A term: tinted at rest, lit on hover/focus/Alt. Hover shows the definition; click pins.
// An unknown id degrades to its children (never a broken control). Inline by design.
//
// `hoverOnly` is for terms living inside another control (a sortable table header): it
// keeps the tint + hover-to-define but drops the button role, focus, and click-to-pin so
// the click bubbles to the parent (the header still sorts). Everywhere else, prefer the
// full interactive term.
export function Term({ id, children, hoverOnly }: { id: string; children?: React.ReactNode; hoverOnly?: boolean }) {
  const ctx = useContext(GlossaryCtx);
  const ref = useRef<HTMLSpanElement>(null);
  const entry = GLOSSARY[id];
  if (!entry || !ctx) return <>{children ?? entry?.term ?? id}</>;
  const label = children ?? entry.term;
  const open = () => ctx.hoverOpen(id, ref.current);
  if (hoverOnly) {
    return (
      <span ref={ref} className="gloss" onMouseEnter={open} onMouseLeave={ctx.hoverClose}>
        {label}
      </span>
    );
  }
  return (
    <span
      ref={ref}
      className="gloss"
      role="button"
      tabIndex={0}
      aria-label={`${entry.term} — show definition`}
      onMouseEnter={open}
      onMouseLeave={ctx.hoverClose}
      onFocus={open}
      onBlur={ctx.hoverClose}
      onClick={(e) => { e.stopPropagation(); ctx.pinOpen(id, ref.current); }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ctx.pinOpen(id, ref.current); }
      }}
    >
      {label}
    </span>
  );
}
