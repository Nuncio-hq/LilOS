import {
  navFromParams,
  paramsFromNav,
  paramsText,
  type V3Nav,
} from "@lilos/ui";
import { atom } from "nanostores";

/* Where you are in v3 lives in the URL hash (`#?page=threads&open=thread:<id>`)
   because the packaged Mac app loads from `file:`, where only the fragment can
   change. The codec is the one the prototype shares (`@lilos/ui`); this adds
   the history wiring: every move is an entry, Back/Forward read it back, and
   non-React code (notifications, shortcuts) reads and moves the same atom. */

const fromHash = (): V3Nav =>
  navFromParams(new URLSearchParams(location.hash.replace(/^#\??/, "")));

const hashOf = (nav: V3Nav): string => {
  const text = paramsText(paramsFromNav(nav));
  return text ? `#?${text}` : "";
};

export const v3Nav = atom<V3Nav>(fromHash());

/** Apply a move (updates arrive as functions so two moves in one click both land). */
export function moveNav(update: (nav: V3Nav) => V3Nav): void {
  const next = update(v3Nav.get());
  v3Nav.set(next);
  const hash = hashOf(next);
  if (hash !== location.hash)
    history.pushState(
      null,
      "",
      `${location.pathname}${location.search}${hash}`,
    );
}

window.addEventListener("popstate", () => v3Nav.set(fromHash()));

/** A conversation opens beside Threads, whatever page you were on: what a
    notification click or any other link to a thread means. */
export const openThread = (conversationId: string): void =>
  moveNav(() => ({
    page: { page: "threads" },
    peek: [{ page: "thread", id: conversationId }],
  }));

/** The conversation the side peek shows, if its top record is a thread. */
export function openThreadId(nav: V3Nav): string | undefined {
  const top = nav.peek[nav.peek.length - 1];
  return top?.page === "thread" ? top.id : undefined;
}
