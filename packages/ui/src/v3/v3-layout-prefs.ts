import { useCallback, useState } from "react";

/* How this device lays the shell out: the sidebar's width, the side peek's
   width, and whether the sidebar is hidden. A layout choice belongs to the
   screen it was made on, so it lives in localStorage (not in the URL, which a
   shared link would carry to someone else's window). */

const SIDEBAR_KEY = "lilos-v3-sidebar-w";
const PEEK_KEY = "lilos-v3-peek-w";
const HIDDEN_KEY = "lilos-v3-sidebar-hidden";

/** Under this window width the sidebar is an overlay only (#886). */
export const NARROW_W = 700;

export const SIDEBAR_W = { def: 236, min: 200, max: 360 } as const;
/** The page never gets narrower than this: the peek gives way first. */
export const PAGE_MIN = 320;
const PEEK_MIN = 360;
/** Below this the peek stops shrinking and the window is simply too small. */
const PEEK_FLOOR = 280;

/** The side peek's limits inside `area` px (the page and the peek together).
    The peek is at least ~360 and at most 70% of the area, but never so wide
    that the page falls under its own minimum — that rule wins when the window
    shrinks, down to a floor where nothing more can give. */
export function peekLimits(area: number): { min: number; max: number } {
  const max = Math.max(PEEK_FLOOR, Math.min(area * 0.7, area - PAGE_MIN));
  return { min: Math.min(PEEK_MIN, max), max: Math.round(max) };
}

/** What the peek measures when nobody has resized it. */
function peekDefault(area: number): number {
  return Math.min(760, area * 0.58);
}

export const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));

export type ShellSizes = {
  /** The sidebar's width now, and the widest the window lets it be. */
  side: { w: number; max: number };
  /** The peek's width now, and the limits of its divider. */
  peek: { w: number; min: number; max: number };
};

/** The widths the shell draws, from what the person chose and the window's
    width (`frameW`, 0 before it is measured: then only the hard limits
    apply). When the window shrinks the peek gives way first, then the
    sidebar: the page keeps its minimum. */
export function shellSizes(
  frameW: number,
  saved: { sidebarW: number; peekW: number | undefined; hidden: boolean },
): ShellSizes {
  const sideMax = frameW
    ? Math.max(SIDEBAR_W.min, Math.min(SIDEBAR_W.max, frameW - PAGE_MIN))
    : SIDEBAR_W.max;
  const sideW = clamp(saved.sidebarW, SIDEBAR_W.min, sideMax);
  const area = frameW - (saved.hidden ? 0 : sideW);
  const lim = area > 0 ? peekLimits(area) : { min: PEEK_MIN, max: 760 };
  const peekW = clamp(
    saved.peekW ?? peekDefault(area > 0 ? area : 1200),
    lim.min,
    lim.max,
  );
  return {
    side: { w: sideW, max: sideMax },
    peek: { w: peekW, min: lim.min, max: lim.max },
  };
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage full or blocked: the layout simply is not remembered.
  }
}

/** A stored width, or undefined for "never resized" (use the default). */
function readWidth(key: string): number | undefined {
  const n = Number(read(key));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export type LayoutPrefs = {
  sidebarW: number;
  setSidebarW: (w: number | undefined) => void;
  /** undefined until the human drags the divider. */
  peekW: number | undefined;
  setPeekW: (w: number | undefined) => void;
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
};

export function useLayoutPrefs(): LayoutPrefs {
  const [sidebarW, setSidebar] = useState(() =>
    clamp(
      readWidth(SIDEBAR_KEY) ?? SIDEBAR_W.def,
      SIDEBAR_W.min,
      SIDEBAR_W.max,
    ),
  );
  const [peekW, setPeek] = useState(() => readWidth(PEEK_KEY));
  const [hidden, setHiddenState] = useState(() => read(HIDDEN_KEY) === "1");

  const setSidebarW = useCallback((w: number | undefined) => {
    const next = clamp(w ?? SIDEBAR_W.def, SIDEBAR_W.min, SIDEBAR_W.max);
    setSidebar(next);
    // The default is stored as nothing: a reset leaves no trace.
    write(SIDEBAR_KEY, w === undefined ? null : String(Math.round(next)));
  }, []);
  const setPeekW = useCallback((w: number | undefined) => {
    setPeek(w);
    write(PEEK_KEY, w === undefined ? null : String(Math.round(w)));
  }, []);
  const setHidden = useCallback((h: boolean) => {
    setHiddenState(h);
    write(HIDDEN_KEY, h ? "1" : null);
  }, []);

  return { sidebarW, setSidebarW, peekW, setPeekW, hidden, setHidden };
}

/* The shelves of the thread list fold on this device only (#862): a fold
   choice belongs to the screen it was made on, so it sits in localStorage
   with the layout widths, not in the relay state that syncs to the phone. */
const FOLDS_KEY = "lilos-v3-folds";
/** A fold's key: the three shelves ("working" | "snoozed" | "settled"); a
    page can scope its own ("project:<id>:working"). */
export type FoldKey = string;

function readFolds(): Partial<Record<FoldKey, boolean>> {
  try {
    const raw = read(FOLDS_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<FoldKey, boolean>>) : {};
  } catch {
    return {};
  }
}

/** Which folds are open on this device: Working, Snoozed and Done all
    start folded, and whatever you open stays open here only. */
export function useFoldPrefs(): {
  folds: Partial<Record<FoldKey, boolean>>;
  setFold: (key: FoldKey, open: boolean) => void;
} {
  const [folds, setFolds] = useState(readFolds);
  const setFold = useCallback((key: FoldKey, open: boolean) => {
    setFolds((f) => {
      const next = { ...f, [key]: open };
      write(FOLDS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return { folds, setFold };
}
