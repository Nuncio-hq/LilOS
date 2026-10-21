import {
  type MutableRefObject,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useUiLayer } from "../chat/ui-layers";
import type { ConversationPin } from "../components/ai-elements/conversation";
import type { EmpFn, Employee, HumanFn, Reply, Thread } from "../types";
import { VIEWER_ID } from "../types";
import { askKeyDown, pendingAsk } from "./ask-keys";
import { landJump } from "./jump-to-hit";
import type { PlanAction } from "./plan-card";
import { estTurnHeight, openTailStart, TURN_LAZY_AFTER } from "./turn-lazy";
import type { TurnActs } from "./turn-rows";

/* What the thread panel (ThreadView) and the session view (FocusView) do
   identically around the conversation, written once so the two frames can't
   drift: the jump-to-hit landing, the lazy turn window, the keyboard layer
   and the row-handler ref. Each is a hook the frame calls — not a component
   with a mode prop (see the frames' docblock). */

/** The thread's employee: the one the host names, else the first who replied
    (a thread panel is handed none; a rewound-to-nothing thread has no replies
    to read it from, which is why the host can name one). */
export function leadOf(
  lead: Employee | undefined,
  replies: Reply[],
  emp: EmpFn,
): Employee | undefined {
  if (lead) return lead;
  const r = replies.find((x) => emp(x.from));
  return r ? emp(r.from) : undefined;
}

/* #138 AC-3: jump-to-hit — scroll the message into view, flash it, hand back
   control. Waits for the row to render (history may still load).
   #570: `landJump` releases the bottom pin before the native write (an
   in-flight spring would overwrite it before its scroll event lands an
   escape) and keeps the row landed while born-stubs hydrate around it. */
export function useJumpToHit({
  scope,
  scrollTo,
  replies,
  onScrolled,
}: {
  /** The element the `[data-msg]` rows live under. */
  scope: RefObject<HTMLElement | null>;
  scrollTo?: string;
  replies: Reply[];
  onScrolled?: () => void;
}): { pin: MutableRefObject<ConversationPin | null>; flash: string | null } {
  const pin = useRef<ConversationPin | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!scrollTo) {
      flashedRef.current = null;
      return;
    }
    if (flashedRef.current === scrollTo) return;
    const el = scope.current?.querySelector(
      `[data-msg="${CSS.escape(scrollTo)}"]`,
    );
    if (!el) return;
    flashedRef.current = scrollTo;
    landJump(el, pin.current);
    setFlash(scrollTo);
    onScrolled?.();
    // `replies`: the row may not exist yet — retried as they stream in.
  }, [scope, scrollTo, replies, onScrolled]);
  /* The flash window lives in its own effect — the scroll effect's cleanup
     would cancel it when onScrolled clears scrollTo. */
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, [flash]);
  return { pin, flash };
}

/** Which rows of a thread mount real and which hold as stubs, plus the row
    that carries the hover Retry. */
export interface TurnWindow {
  lazyRows: boolean;
  /** Estimated px per row; empty unless the thread is lazy. */
  estHeights: number[];
  /** First row that mounts real on open. */
  tailStart: number;
  lastTurnIdx: number;
}

/* #570: a lazy thread opens on its tail — rows above `tailStart` never mount
   on first paint; they start as estimated-height stubs and the observer
   mounts them at the window edge. #419: the Retry lives on the last TURN —
   system notes (a failed turn's error row) sit below it and don't count. */
export function useTurnWindow({
  frame,
  replies,
  emp,
}: {
  frame: "panel" | "focus";
  replies: Reply[];
  emp: EmpFn;
}): TurnWindow {
  const lazyRows = replies.length > TURN_LAZY_AFTER;
  const estHeights = useMemo(
    () =>
      lazyRows
        ? replies.map((r) => estTurnHeight(r, !!emp(r.from), frame))
        : [],
    [lazyRows, replies, emp, frame],
  );
  const tailStart = openTailStart(estHeights);
  const lastTurnIdx = replies.reduce((a, r, i) => (emp(r.from) ? i : a), -1);
  return { lazyRows, estHeights, tailStart, lastTurnIdx };
}

/* #430: row handlers ride a ref rewritten each render — the memoized TurnRow
   never sees a fresh callback identity, and its reads are always the latest
   closures. */
export function useTurnActs(acts: TurnActs): MutableRefObject<TurnActs> {
  const ref = useRef<TurnActs>({});
  ref.current = acts;
  return ref;
}

/* The frame is one UI layer: Esc leaves it only while it is the top-most
   surface (an open dialog or menu above it keeps Esc, #576 — it never stops
   a turn), and while top-most it owns the surface keys — ⌘. stops a running
   turn, ↵/⌫ answer the newest pending approval/plan card (#558). Returns the
   id the ↵/⌫ hint lives under — approval cards match on ask id, plan cards on
   plan id. */
export function useThreadKeys({
  thread,
  resolved,
  setResolved,
  human,
  onPlan,
  running,
  onStop,
  onEscape,
}: {
  thread: Thread;
  resolved: Record<string, string>;
  setResolved?: (r: Record<string, string>) => void;
  human: HumanFn;
  onPlan?: (a: PlanAction, planId: string) => void;
  running: boolean;
  onStop?: () => void;
  onEscape?: () => void;
}): string | undefined {
  const ask = pendingAsk(thread.replies, resolved, !!onPlan);
  const viewer = human(VIEWER_ID)?.name ?? "you";
  useUiLayer({
    onEscape,
    onKey: (e) =>
      askKeyDown(e, {
        ask,
        viewer,
        resolved,
        setResolved,
        onPlan,
        running,
        onStop,
      }),
  });
  if (!ask) return undefined;
  return ask.kind === "approval" ? ask.reply.approval?.id : ask.reply.plan?.id;
}
