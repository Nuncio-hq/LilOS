import type { V3Nav, V3PageRoute, V3RecordRoute, V3Route } from "./v3-types";

/* One place for how you move around v3 (#767 feedback). You live on a page
   (Threads, Work, People…); everything you open from it (a thread, its
   ticket, the agent behind it) stacks in a side peek next to that page, so
   the place you started never goes away. Not: record pages that replace the
   page you were on, then a trip back through the sidebar to find your place
   (lost context, worst for an ADHD reader). */

/** A route that opens a record (it carries an id), as opposed to a page. */
export const isRecordRoute = (r: V3Route): r is V3RecordRoute => "id" in r;

/** Where `r` leads from where you are. `from` says who asked: the page
   (opening a record starts a fresh trail) or the peek (it extends the trail). */
export function step(nav: V3Nav, r: V3Route, from: "page" | "peek"): V3Nav {
  if (!isRecordRoute(r)) return { page: r, peek: [] };
  if (from === "page") return { ...nav, peek: [r] };
  // Opening something already on the trail goes back to it instead of
  // growing a loop (thread → ticket → the same thread).
  const at = nav.peek.findIndex((x) => x.page === r.page && x.id === r.id);
  if (at >= 0) return { ...nav, peek: nav.peek.slice(0, at + 1) };
  return { ...nav, peek: [...nav.peek, r] };
}

/** The page a record belongs on when it is opened from a bare link. */
export function homeOf(r: V3RecordRoute): V3PageRoute {
  if (r.page === "ticket") return { page: "work" };
  if (r.page === "thread") return { page: "threads" };
  if (r.page === "agent") return { page: "people" };
  if (r.page === "goal") return { page: "goals" };
  return { page: "home" };
}
