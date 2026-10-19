import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

/* Keeps a growing conversation in view. Its scroller (the page, or the side
   peek it opened in: the nearest [data-v3-scroller] above `anchor`) opens at
   the newest message; whenever `sig` changes it glides down to follow, unless
   the reader has scrolled up past NEAR px (then they are reading, so leave
   them be). */

const NEAR = 200;

export function useFollowBottom(
  sig: number,
): [RefObject<HTMLDivElement | null>, () => void] {
  const anchor = useRef<HTMLDivElement>(null);
  // Growth fires no scroll event, so remember whether the reader was following.
  const pinned = useRef(true);
  const scroller = () =>
    anchor.current?.closest<HTMLElement>("[data-v3-scroller]") ?? null;

  // Runs once per mount: scroller() only reads a ref.
  useLayoutEffect(() => {
    const el = scroller();
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight });
    let last = el.scrollTop;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      // Our own glide only moves down, and a tall new block can leave it far
      // from the bottom for a moment, so only an upward move can unpin.
      if (el.scrollTop < last) pinned.current = gap <= NEAR;
      else if (gap <= NEAR) pinned.current = true;
      last = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // `sig` is the trigger: it changes whenever the conversation grows.
  useEffect(() => {
    const el = scroller();
    if (el && pinned.current)
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [sig]);

  /** The reader just sent a message: follow their own turn from wherever they were. */
  return [
    anchor,
    () => {
      pinned.current = true;
    },
  ];
}
