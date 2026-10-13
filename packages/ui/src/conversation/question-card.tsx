import {
  CheckIcon,
  MessageCircleQuestionIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "../components/ai-elements/confirmation";
import { ConversationScrollButton } from "../components/ai-elements/conversation";
import { MessageResponse } from "../components/ai-elements/message";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import type { QuestionAsk } from "../types";

/* What the card hands back: options answer with their wire id, free text
   with the typed string; `label` is the human wording the receipt shows. */
export type QuestionAnswer = { value: string; label: string };

/* Question text + option copy render through the same streamdown pass as
   message bodies — `release/0.1` is code, not literal backticks (FIX #515).
   Inside an option <button> a block <p> is invalid nesting, so paragraphs
   degrade to spans there. */
const INLINE_COMPONENTS = {
  p: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
};

/* #420: the engine's `question` ask under a reply — the question text, its
   options as buttons, a free-text field when allowed, and a Skip. While
   open the turn sits in phase "waiting" (amber, "needs you"); answering or
   skipping folds the card to a one-line receipt, the same resolved-map
   pattern the approval card uses (resolved[q.id] carries the wording).
   Props in, callbacks out: `setResolved` writes the receipt text,
   `onAnswer`/`onCancel` let the app continue the turn. */

/* The nearest ancestor that actually scrolls — the thread's
   stick-to-bottom scrollport — or null outside one (the cap then falls
   back to the window). */
const scrollPortOf = (el: HTMLElement | null) => {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowY)) return p;
  }
  return null;
};

/* The list cap in one rule (tested in question-card.test.tsx): the
   options list gets whatever the scrollport leaves after the card's own
   chrome — header, question, actions — minus the arrival-align margins
   (8px head + 16px tail), so a card can never be taller than its port
   (FIX #515 r5). The 80px floor keeps one full option row + a sliver of
   the next even when chrome eats the port — at a port that tight the
   align's tail room yields first, never the head (#649). */
export const questionOptionCap = (
  natural: number,
  others: number,
  portH: number,
) => {
  const cap = Math.max(80, portH - 24 - others);
  return { cap, over: natural > cap + 4 };
};
export function QuestionCard({
  q,
  viewer,
  agent,
  done,
  resolved,
  setResolved,
  onAnswer,
  onCancel,
}: {
  q: QuestionAsk;
  /** Display name of the signed-in human ("you" fallback). */
  viewer: string;
  /** Display name of the asking employee — the Skip button names who
      decides when the viewer passes ("the agent" fallback). */
  agent?: string;
  /** Receipt text once resolved — `Answered "…"` reads accepted, `Cancelled…` rejected. */
  done?: string;
  resolved: Record<string, string>;
  setResolved?: (r: Record<string, string>) => void;
  /** Answer continues the turn. Passed, the handler owns the resolved
      write — the card locks as "Sending…" until resolved[q.id] lands
      (the real app's respond → engine-resolves round-trip). Absent, the
      card writes the receipt itself and stays self-contained. */
  onAnswer?: (q: QuestionAsk, a: QuestionAnswer) => void;
  onCancel?: (q: QuestionAsk) => void;
}) {
  const [draft, setDraft] = useState("");
  /* The answer is on its way to the engine — the controls lock until the
     resolved write flips the card to its receipt. */
  const [pending, setPending] = useState<string | null>(null);
  /* The options cap fades its edges only when the list actually overflows
     — a three-option card never shows a clipped "peek" (FIX #515). */
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  const cancelled = !!done?.startsWith("Cancelled");
  const options = q.options ?? [];
  /* Wire rule (requests.ts): free text beside the options only when
     `freeText`; no options at all → the answer IS free text. */
  const freeText = q.freeText === true || options.length === 0;
  const interactive = !!setResolved && !done;
  const who = agent ?? "the agent";
  const cardRef = useRef<HTMLDivElement>(null);
  /* The options list caps to the SPACE THE SCROLLPORT LEAVES IT, not a
     fixed height (Hermes FIX #515 r3): everything else on the card keeps
     its natural height, the list takes what remains under the floating
     composer, and a "+N more" row counts the options still hidden. */
  const [cap, setCap] = useState<number>();
  const [hidden, setHidden] = useState(0);
  useLayoutEffect(() => {
    const list = listRef.current;
    const card = cardRef.current;
    if (!list || !card) return;
    /* The port is re-resolved on every measure: at mount the scroller's
       overflow style may not apply yet (Focus mounts the whole thread
       tree at once) and a null here would pin the cap to the window's
       height forever — a stale cap lets the card outgrow the port at
       tighter viewports (#649 CI). */
    let port = scrollPortOf(list);
    const ro = new ResizeObserver(() => measure());
    let cancelled = false;
    let raf = 0;
    let lastCap: number | undefined;
    let stable = 0;
    /* A wrong or missing port at mount is only caught if a measure runs
       after the real one settles — but the RO observes what `port` pointed
       at, and a settled card stops resizing, so nothing re-arms it (the
       324px cap in a 341px port on #649 CI). Keep re-measuring on the next
       frames until the cap holds steady twice against a resolved port;
       the deadline bounds an oscillating layout. */
    const settleUntil = performance.now() + 2500;
    const measure = () => {
      if (cancelled) return;
      const p = scrollPortOf(list);
      if (p !== port) {
        if (port) ro.unobserve(port);
        port = p;
        if (port) ro.observe(port);
      }
      const natural = list.scrollHeight;
      /* The list gets the scrollport height minus everything else on the
         card and a margin — the pb-28 scroll slack below the last item
         is the card's own room, not lost space (the mount align lifts
         the card's top into view, so it may occupy it). */
      const others = card.scrollHeight - list.clientHeight;
      const portH = port ? port.clientHeight : window.innerHeight;
      const { cap: capPx, over } = questionOptionCap(natural, others, portH);
      /* Snap the cap to a whole-row boundary plus a peek of the next tile
         (no half-glyph rows), and count what's left hidden — measured
         against the list's own top edge, not an offsetParent. */
      const rows = [...list.children] as HTMLElement[];
      const listTop = list.getBoundingClientRect().top;
      const visible = rows.filter(
        (r) => r.getBoundingClientRect().bottom - listTop <= capPx - 4,
      ).length;
      const lastVisible = rows[visible - 1];
      const snapped = over
        ? Math.min(
            capPx,
            Math.max(
              80,
              lastVisible
                ? lastVisible.getBoundingClientRect().bottom - listTop + 30
                : capPx,
            ),
          )
        : undefined;
      setCap(snapped);
      setScrollable(over);
      setHidden(over ? Math.max(1, rows.length - visible) : 0);
      /* Two identical results against a bound port = settled; a null port
         never counts (the walk can only miss while styles land). */
      stable = port && snapped === lastCap ? stable + 1 : 0;
      lastCap = snapped;
      if (
        stable < 2 &&
        performance.now() < settleUntil &&
        typeof requestAnimationFrame === "function"
      )
        raf = requestAnimationFrame(measure);
    };
    if (port) ro.observe(port);
    /* The card too: `others` is everything non-list — header, question,
       the "+N more" row that only exists once `hidden` lands, and the
       actions row that can mount a commit later. A cap computed while
       chrome is still mounting undershoots it, and chrome growth never
       resizes the port — without this the card stays taller than the
       port forever (the 390px card in a 398px port, #649 CI). The loop
       is self-limiting: a converged setCap changes nothing, so no
       further resize fires. */
    ro.observe(card);
    /* Overflow is a style write, not a resize — the RO never sees the
       scroller gain it, and a mount-null port observes nothing at all.
       Ancestor attribute flips (the library's inline overflow write, tab
       `hidden`, theme classes) are the events that re-resolve the walk. */
    const mo = new MutationObserver(() => measure());
    for (let p = list.parentElement; p; p = p.parentElement)
      mo.observe(p, {
        attributes: true,
        attributeFilter: ["class", "style", "hidden"],
      });
    measure();
    window.addEventListener("resize", measure);
    /* `load` is the first moment every stylesheet is applied — a scroller
       whose overflow-auto rule was still in flight resolves only now. */
    window.addEventListener("load", measure, { once: true });
    /* A late webfont changes every metric at once — re-measure once it
       lands (ready resolves at once when fonts are already in). */
    void document.fonts?.ready.then(() => measure());
    return () => {
      cancelled = true;
      ro.disconnect();
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      window.removeEventListener("load", measure);
    };
  }, [options.length]);

  /* A new question lifts its card until the top edge clears the
     scrollport — the head sits under the session header instead of
     behind it (Hermes FIX #515 r3). Keep-bottom re-pins the port while
     the turn streams, so a one-shot scroll loses the race: re-align on a
     short arrival window (scrolling up only — never drag the card down),
     and stop the moment the user scrolls. `resolved` in deps re-arms
     the window when a sibling ask resolves — the question that becomes
     visible after an answer gets the same lift (FIX r4). The RO
     re-aligns on port resizes AND content growth: a window shrink
     GROWS the max scrollTop (no scroll event fires) and streaming rows
     push the tail under the fold without touching the port's size —
     neither the lock nor the expired arrival ride restores the card
     then, so it can sit clipped under the composer forever (#649). The
     gate keeps the reader in charge: a card scrolled away above the
     port, or more than a viewport below, is left alone. */
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !interactive) return;
    let cancelled = false;
    let raf = 0;
    let tries = 0;
    let teardown: (() => void) | undefined;
    const start = () => {
      if (cancelled || teardown) return;
      const port = scrollPortOf(el);
      /* The scroller's overflow can apply after this effect runs — a null
         here used to skip the align window for good; retry briefly so a
         late port still gets the card parked (#649 CI). */
      if (!port) {
        if (tries++ < 120 && typeof requestAnimationFrame === "function")
          raf = requestAnimationFrame(start);
        return;
      }
      teardown = mount(el, port);
    };
    const mount = (el: HTMLElement, port: HTMLElement) => {
      const align = () => {
        const e = el.getBoundingClientRect();
        const p = port.getBoundingClientRect();
        const over = p.top + 8 - e.top;
        if (over > 1) {
          // head clipped under the sticky header — lift until it clears
          port.scrollTop -= over;
          return;
        }
        if (e.top > p.bottom - 48 && e.top - p.bottom < p.height) {
          // below the fold — a question that arrives after an answer gets
          // the same lift as a fresh arrival (FIX r4), but never a giant
          // jump when the card is deep below
          port.scrollTop += e.top - p.top - 8;
          return;
        }
        const under = e.bottom - (p.bottom - 16);
        if (under > 1) {
          // partially visible with the tail cut — reveal the whole card,
          // or as much as fits before the head would clip again. The tail
          // margin is 16, not the head's 8: where the composer hugs the
          // port edge (Focus has no composer margin) a smaller tail leaves
          // the card's border tucking under the composer (#649).
          const nudge = Math.min(under, e.top - p.top - 8);
          if (Math.abs(nudge) > 1) port.scrollTop += nudge;
        }
      };
      const realign = () => {
        if (cancelled) return;
        const e = el.getBoundingClientRect();
        const p = port.getBoundingClientRect();
        /* Only re-park a tail the layout pushed under the fold — a card
           whose head sits above the port top, or that lives more than a
           viewport below, belongs to the reader's scroll position. */
        if (
          e.top < p.top ||
          e.top - p.bottom > p.height ||
          e.bottom - (p.bottom - 16) <= 1
        )
          return;
        align();
      };
      const kick = setTimeout(align, 450);
      const ride = setInterval(align, 350);
      const end = setTimeout(() => clearInterval(ride), 3500);
      let retry: ReturnType<typeof setInterval> | undefined;
      let retryEnd: ReturnType<typeof setTimeout> | undefined;
      const ro = new ResizeObserver(() => {
        /* Layout writes land a frame after the size change — retry on a
           short ride so a mid-animation read can't gate-skip the fix. */
        realign();
        clearInterval(retry);
        clearTimeout(retryEnd);
        retry = setInterval(realign, 350);
        retryEnd = setTimeout(() => clearInterval(retry), 1400);
      });
      ro.observe(port);
      /* The content's height is where streaming growth shows up — the
         port alone doesn't resize then. */
      if (port.firstElementChild instanceof HTMLElement)
        ro.observe(port.firstElementChild);
      const stop = () => {
        cancelled = true;
        clearInterval(ride);
        clearTimeout(end);
        clearInterval(retry);
        clearTimeout(retryEnd);
        ro.disconnect();
      };
      port.addEventListener("wheel", stop, { passive: true });
      port.addEventListener("touchstart", stop, { passive: true });
      port.addEventListener("keydown", stop);
      return () => {
        clearTimeout(kick);
        stop();
        port.removeEventListener("wheel", stop);
        port.removeEventListener("touchstart", stop);
        port.removeEventListener("keydown", stop);
      };
    };
    start();
    /* A port that only becomes scrollable once stylesheets land still
       gets its align window. */
    window.addEventListener("load", start, { once: true });
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("load", start);
      teardown?.();
    };
  }, [interactive, resolved]);

  const pick = (a: QuestionAnswer) => {
    if (!interactive || pending) return;
    setPending(a.label);
    if (onAnswer) onAnswer(q, a);
    else
      setResolved?.({
        ...resolved,
        [q.id]: `Answered “${a.label}” by ${viewer}`,
      });
  };
  const cancel = () => {
    if (!interactive || pending) return;
    setPending("Cancelled");
    if (onCancel) onCancel(q);
    else setResolved?.({ ...resolved, [q.id]: `Cancelled by ${viewer}` });
  };
  return (
    <Confirmation
      ref={cardRef}
      className={cn(
        "mt-1 scroll-mt-2",
        done
          ? cancelled
            ? "border-red-200"
            : "border-emerald-200"
          : "border-amber-300 bg-amber-50/50",
      )}
      data-ask-id={q.id}
      data-question-card
      data-ask-state={done ? "resolved" : "open"}
      state={done ? "approval-responded" : "approval-requested"}
      approval={
        done ? { id: q.id, approved: !cancelled, reason: done } : { id: q.id }
      }
    >
      <ConfirmationTitle className="flex flex-wrap items-center gap-1.5 pr-2 font-medium text-foreground">
        <ConfirmationRequest>
          <MessageCircleQuestionIcon className="size-3.5 text-primary" />
          {interactive
            ? "Question for you"
            : `Question · only ${viewer} can answer`}
        </ConfirmationRequest>
        <ConfirmationAccepted>
          <CheckIcon className="size-3.5 text-emerald-600" />
          {done}
        </ConfirmationAccepted>
        <ConfirmationRejected>
          <XIcon className="size-3.5 text-red-600" />
          {done}
        </ConfirmationRejected>
      </ConfirmationTitle>
      <ConfirmationRequest>
        <div className="space-y-2.5">
          <MessageResponse className="lilos-prose text-foreground text-sm leading-snug">
            {q.question}
          </MessageResponse>
          {options.length > 0 && (
            /* Many options cap and scroll: whole rows plus a fading peek
               instead of growing the thread; the inner scrollbar stays off
               the tiles (FIX #515). */
            <div
              ref={listRef}
              data-question-options
              style={cap ? { maxHeight: cap } : undefined}
              className={cn(
                "flex flex-col gap-1.5 overflow-y-auto scroll-py-1.5 py-1.5 pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                scrollable &&
                  "[mask-image:linear-gradient(to_bottom,transparent,black_6px,black_calc(100%-30px),rgb(0_0_0/0.15))]",
              )}
            >
              {options.map((o) => (
                <Button
                  key={o.id}
                  variant="outline"
                  size="sm"
                  disabled={!interactive || !!pending}
                  className="h-auto justify-start px-3 py-2 text-left whitespace-normal"
                  onClick={() => pick({ value: o.id, label: o.label })}
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <MessageResponse
                      className="lilos-prose text-sm"
                      components={INLINE_COMPONENTS}
                    >
                      {o.label}
                    </MessageResponse>
                    {o.description && (
                      <MessageResponse
                        className="lilos-prose font-normal text-muted-foreground text-xs"
                        components={INLINE_COMPONENTS}
                      >
                        {o.description}
                      </MessageResponse>
                    )}
                  </span>
                </Button>
              ))}
            </div>
          )}
          {hidden > 0 && (
            /* Options the cap hid — the count tells you the list scrolls
               (Hermes FIX #515 r3). */
            <div className="px-1 text-muted-foreground text-xs">
              +{hidden} more
            </div>
          )}
          {interactive && (
            /* Two rows, one height (h-8): the free-text field rides full
               width with Answer at its end; Skip is a secondary button on
               the row below, right-aligned like the phone (FIX #515 r3).
               data-question-actions: the "input and Skip stay visible"
               anchor the arrival-align is tested against (FIX r5). */
            <div data-question-actions className="flex flex-col gap-2">
              {freeText && (
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = draft.trim();
                    if (text) pick({ value: text, label: text });
                  }}
                >
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    disabled={!!pending}
                    placeholder={
                      options.length ? "Or type your own…" : "Type your answer…"
                    }
                    aria-label="Your answer"
                    className="min-w-0 flex-1"
                  />
                  {/* Field-height (h-8), clearly inert while empty, solid
                      accent once there's text (FIX #515). */}
                  <Button
                    type="submit"
                    variant={draft.trim() ? "default" : "outline"}
                    disabled={!!pending || !draft.trim()}
                    className="shrink-0"
                  >
                    <SendIcon className="size-3.5" />
                    Answer
                  </Button>
                </form>
              )}
              <div className="flex items-center justify-end gap-2">
                {pending && (
                  <span className="text-muted-foreground text-xs">
                    Sending…
                  </span>
                )}
                {/* Skip is secondary — it says what it does: the asking
                    agent decides instead. */}
                <Button
                  variant="secondary"
                  className="shrink-0"
                  disabled={!!pending}
                  title={`Skip — ${who} decides for you`}
                  onClick={cancel}
                >
                  Skip — let {who} decide
                </Button>
              </div>
            </div>
          )}
        </div>
      </ConfirmationRequest>
    </Confirmation>
  );
}

/* The floating ↓ scroll-to-bottom button absolutely positions inside the
   scrollport; while a pending question card fills it, the button sits ON
   the card — on the Skip pill or the next card's head (Hermes FIX #515
   r4: it must never overlap). Whenever an open question card intersects
   the port this guard yields the button entirely; it comes back once the
   card is out of view, so jump-to-bottom survives a scrolled-away ask.
   Renders for the real app unchanged — no `[data-question-card]` ever
   mounts outside the prototype surfaces. */
export const QuestionAwareScrollButton = (
  props: ComponentProps<typeof ConversationScrollButton>,
) => {
  const { scrollRef } = useStickToBottomContext();
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const port = scrollRef?.current;
    if (!port) return;
    const measure = () => {
      const p = port.getBoundingClientRect();
      const overlap = [
        ...port.querySelectorAll<HTMLElement>(
          '[data-question-card][data-ask-state="open"]',
        ),
      ].some((el) => {
        const c = el.getBoundingClientRect();
        return c.bottom > p.top && c.top < p.bottom;
      });
      setBlocked(overlap);
    };
    measure();
    /* The card mounts/grows while the turn streams — watch the tree,
       the port's own scroll and layout. */
    const mo = new MutationObserver(measure);
    mo.observe(port, { childList: true, subtree: true });
    const ro = new ResizeObserver(measure);
    ro.observe(port);
    port.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      mo.disconnect();
      ro.disconnect();
      port.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [scrollRef]);
  if (blocked) return null;
  return <ConversationScrollButton {...props} />;
};
