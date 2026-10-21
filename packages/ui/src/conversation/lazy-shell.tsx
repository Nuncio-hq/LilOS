import {
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ConversationPin } from "../components/ai-elements/conversation";
import { findAnchorActive, useFindUnstub } from "./find-unstub";

/* How far outside the viewport a row goes before it is held as a stub. */
const LAZY_MARGIN = "1600px";

/* e2e/dev knob — `?stubHydrateMs=<ms>` defers a born-stub's un-hold that
   long after its observer intersects: the CI-slow first hydration, where
   the mounts land in a quiet port long after the open pin ran and every
   estimate→real delta is a standalone scroll event (#570's slow-box
   reproducer). Read once at module load, like `?stickDropMs=`. */
const STUB_HYDRATE_MS = (() => {
  if (typeof window === "undefined") return 0;
  const v = Number(
    new URLSearchParams(window.location.search).get("stubHydrateMs"),
  );
  return Number.isFinite(v) && v > 0 ? v : 0;
})();

/* The `data-msg` wrapper + the held/off-screen stub. The outer div ALWAYS
   stays mounted — it's the scroll/flash anchor (#138) — only the row
   content swaps out. `data-remount` marks a row that has been re-mounted
   after a hold; theme.css uses it to skip the rise animation replay. */
export function LazyShell({
  msgId,
  className,
  lazy,
  keep,
  startHeld = false,
  estHeight,
  kind,
  settled,
  children,
}: {
  msgId?: string;
  className?: string;
  lazy: boolean;
  /** Rows that must never unmount: live/streaming turns and the scrollTo
      target (its content has to exist the moment it lands, #138). */
  keep: boolean;
  /** #570: mount directly as a height-estimated stub — rows above the
      open tail never pay their mount cost on thread open. `keep` wins:
      live turns and the scroll target still mount real. */
  startHeld?: boolean;
  /** The first stub's px height — the never-measured estimate; once the
      row mounts and re-holds, the stub keeps its real height (#537). */
  estHeight?: number;
  kind: "agent" | "user" | "note";
  settled: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const initialHeld = lazy && !keep && startHeld && (estHeight ?? 0) > 0;
  const heightRef = useRef(initialHeld && estHeight ? estHeight : 0);
  /* Mounting out of a stub is a remount — `data-remount` skips the rise
     replay — and a born-held row counts as held from the start. */
  const wasHeldRef = useRef(initialHeld);
  const [held, setHeld] = useState(initialHeld);
  const [remounted, setRemounted] = useState(false);
  /* #570: the port's pin — a stub→real commit swaps the estimate for the
     real height, moving the bottom the pin sits on. `wasStub` tracks the
     held→real edge for the layout effect below. */
  const pin = useContext(ConversationPin);
  const wasStub = useRef(initialHeld);
  /* First-commit materialization stamps the pin's hydration wake — the
     mount wave's clamp noise is quarantined the same way a swap's is. */
  const mountedRef = useRef(false);
  /* First hydration only: ?stubHydrateMs= models the CI-slow mount a
     born-stub pays once; measured re-mounts stay instant. */
  const hydratedRef = useRef(false);
  const hydrateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  /* #512: while a find chord's ~10 s window runs, every held row mounts so
     browser find-in-page can match its text; the window lapsing re-arms
     the observer path and off-screen rows re-stub. */
  const findOpen = useFindUnstub(lazy);
  const lazyOn = lazy && !findOpen;

  useEffect(() => {
    const unhold = () => {
      hydratedRef.current = true;
      if (wasHeldRef.current) {
        wasHeldRef.current = false;
        setRemounted(true);
      }
      setHeld(false);
    };
    if (!lazyOn || keep || typeof IntersectionObserver === "undefined") {
      unhold();
      return;
    }
    const el = ref.current;
    if (!el) return;
    /* #554: notifications already in flight when the find session flips
       lazyOn off can still land after disconnect and re-stub a row — find
       would then miss text inside it for the whole session. */
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (cancelled) return;
        for (const en of entries) {
          if (en.isIntersecting) {
            /* ?stubHydrateMs= defers a born-stub's FIRST un-hold — the
               CI-slow hydration the pin fix is proved against. */
            if (STUB_HYDRATE_MS > 0 && initialHeld && !hydratedRef.current) {
              if (hydrateTimer.current === undefined)
                hydrateTimer.current = setTimeout(() => {
                  hydrateTimer.current = undefined;
                  unhold();
                }, STUB_HYDRATE_MS);
            } else {
              unhold();
            }
          } else {
            if (hydrateTimer.current !== undefined) {
              clearTimeout(hydrateTimer.current);
              hydrateTimer.current = undefined;
            }
            /* Only a laid-out row may hold — a 0-height stub would let the
               scroll extent collapse. #537: keep the stub's height EXACT —
               offsetHeight rounds to whole pixels while real rows land
               fractionally (~±0.3 px each); across ~120 rows the rounding
               sums to a real scrollHeight delta whose resize re-arms
               stick-to-bottom's bottom pin and slides the reader's place
               by ~a row when the find window lapses. */
            const h = el.getBoundingClientRect().height;
            if (h) {
              heightRef.current = h;
              wasHeldRef.current = true;
              setHeld(true);
            }
          }
        }
      },
      /* #570: the pre-mount band only reaches through the clip that
         produces it. With the implicit viewport root the margin expands
         the window's bounds while the scroller's own clip applies raw,
         so a row just below the port edge never intersects and never
         mounts (ac-570's scroll-to-top left the early turns held). Root
         the observer at the nearest scrollable ancestor — the port
         itself, which sits INSIDE the role="log" wrapper — and the
         ±LAZY_MARGIN band works as tuned. */
      {
        root: (() => {
          for (let a = el.parentElement; a; a = a.parentElement) {
            const oy = getComputedStyle(a).overflowY;
            if (oy === "auto" || oy === "scroll") return a;
          }
          return null;
        })(),
        rootMargin: `${LAZY_MARGIN} 0px`,
      },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
      if (hydrateTimer.current !== undefined) {
        clearTimeout(hydrateTimer.current);
        hydrateTimer.current = undefined;
      }
    };
  }, [lazyOn, keep]);

  /* #570: a stub→real commit swaps the estimate for the measured height —
   * the bottom edge the pin is glued to just moved. Mark the hydration
   * wake on the pin (the escape guard quarantines its scroll noise) and,
   * while the reader hasn't escaped, re-pin to the MEASURED bottom in
   * this commit (before paint): the library's smooth chase crawls frames
   * behind a hydration wave, and a mid-chase layout-clamp scroll event
   * can kill the library pin outright on a slow box, stranding the port
   * above the real bottom (CI: ac-570's open pin). `escaped` is the
   * guard's own reader-intent flag — a clamp-tripped `escapedFromLock`
   * gets cleared here so the lock keeps tracking the measured bottom. */
  useLayoutEffect(() => {
    const swapped = wasStub.current && !held;
    /* A row's first commit is materialization too — the mount wave's
       clamp noise is the same noise the hydration wake exists to
       quarantine, and the open pin's measured-bottom re-pin rides the
       same commits. */
    const firstCommit = !mountedRef.current;
    mountedRef.current = true;
    wasStub.current = held;
    if ((!swapped && !firstCommit) || !pin) return;
    /* Record this commit's wake: the hydration clock (un-attributed
       up-scrolls are quarantined while it runs), the new layout max
       (the next clamp event's landing is fingerprinted against it),
       and the guard's re-pin chain. */
    pin.hydratedAt.v = performance.now();
    pin.noteMax?.();
    pin.armReinstate?.();
    /* The reader (guard-escaped) or a find window (top-edge hold owns
       the port) stands down the re-pin. A pin the clamp already killed
       is revived only when the port still sits on a clamp landing —
       a real scroll position is never touched. */
    if (pin.escaped.v || findAnchorActive(pin.state)) return;
    if (pin.state.isAtBottom || pin.isClampTop?.()) pin.repin();
  });

  return (
    <div
      ref={ref}
      data-msg={msgId}
      className={className}
      data-remount={remounted || undefined}
      data-lazy={(lazy && !keep) || undefined}
    >
      {held ? (
        <div style={{ height: heightRef.current }} aria-hidden data-held-stub>
          {kind === "agent" ? (
            <div data-agentturn>{settled && <div data-turnsettled />}</div>
          ) : kind === "note" ? (
            <div data-sysnote />
          ) : (
            <div data-userturn />
          )}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
