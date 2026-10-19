import { useEffect, useLayoutEffect, useRef } from "react";

/* Keeps a growing conversation in view. The page scroller opens at the newest
   message; whenever `sig` changes it glides down to follow, unless the reader
   has scrolled up past NEAR px (then they are reading, so leave them be). */

const NEAR = 200;

export function useFollowBottom(sig: number) {
  // Growth fires no scroll event, so remember whether the reader was following.
  const pinned = useRef(true);

  useLayoutEffect(() => {
    const el = document.getElementById("v3-main");
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

  useEffect(() => {
    const el = document.getElementById("v3-main");
    if (el && pinned.current)
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [sig]);

  /** The reader just sent a message: follow their own turn from wherever they were. */
  return () => {
    pinned.current = true;
  };
}
