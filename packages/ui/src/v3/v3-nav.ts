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
  // A sent draft becomes its thread in the same place on the trail.
  const top = nav.peek[nav.peek.length - 1];
  if (top?.page === "newchat" && r.page === "thread")
    return { ...nav, peek: [...nav.peek.slice(0, -1), r] };
  // Opening something already on the trail goes back to it instead of
  // growing a loop (thread → ticket → the same thread).
  const at = nav.peek.findIndex((x) => x.page === r.page && x.id === r.id);
  if (at >= 0) return { ...nav, peek: nav.peek.slice(0, at + 1) };
  return { ...nav, peek: [...nav.peek, r] };
}

/** The page a record belongs on when it is opened from a bare link. */
export function homeOf(r: V3RecordRoute): V3PageRoute {
  if (r.page === "ticket") return { page: "work" };
  if (r.page === "thread" || r.page === "newchat") return { page: "threads" };
  if (r.page === "agent") return { page: "people" };
  if (r.page === "goal") return { page: "goals" };
  return { page: "home" };
}

/* Where you are, as URL parameters: the one codec the prototype (query) and
   the real app (hash, `#?page=threads&open=thread:<id>`) share, so any
   screen can be linked, reloaded, or reached with Back/Forward.
   `page=` the page, `view=` its tab, `open=` the trail of records open in the
   side peek (comma-separated `kind:id`), `full=1` the peek widened. A bare
   record link (`page=ticket&id=HB-12`) opens it over the page that lists it.
   Parameters that are not navigation (`theme`, `v3`) are left alone. */
const PAGES = [
  "home",
  "needs",
  "inbox",
  "work",
  "threads",
  "goals",
  "people",
  "hire",
  "guide",
  "settings",
  "welcome",
] as const;
const RECORDS = [
  "ticket",
  "thread",
  "goal",
  "project",
  "agent",
  "newchat",
] as const;
const NAV_KEYS = ["page", "id", "view", "open", "full"] as const;

const isRecordKind = (s: string): s is V3RecordRoute["page"] =>
  (RECORDS as readonly string[]).includes(s);

/** The nav a set of URL parameters names; unknown pages land on Home. */
export function navFromParams(q: URLSearchParams): V3Nav {
  const name = q.get("page") ?? "home";
  const view = q.get("view") ?? undefined;
  const peek: V3RecordRoute[] = [];
  for (const part of (q.get("open") ?? "").split(",")) {
    const at = part.indexOf(":");
    const kind = part.slice(0, at);
    const id = part.slice(at + 1);
    if (at > 0 && id && isRecordKind(kind))
      peek.push({ page: kind, id } as V3RecordRoute);
  }
  const full = q.get("full") === "1";
  const id = q.get("id");
  if (isRecordKind(name) && id) {
    const r = { page: name, id } as V3RecordRoute;
    return { page: homeOf(r), peek: [r], full };
  }
  if (!(PAGES as readonly string[]).includes(name))
    return { page: { page: "home" }, peek };
  return { page: { page: name, view } as V3PageRoute, peek, full };
}

/** `base` with its navigation parameters replaced by `nav`'s. */
export function paramsFromNav(
  nav: V3Nav,
  base: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  const q = new URLSearchParams(base);
  for (const k of NAV_KEYS) q.delete(k);
  const p = nav.page;
  if (p.page !== "home") q.set("page", p.page);
  if ("view" in p && p.view) q.set("view", p.view);
  if (nav.peek.length)
    q.set("open", nav.peek.map((r) => `${r.page}:${r.id}`).join(","));
  if (nav.full && nav.peek.length) q.set("full", "1");
  return q;
}

/** Parameters as text, keeping `:` and `,` readable in the address bar. */
export const paramsText = (q: URLSearchParams): string =>
  q.toString().replaceAll("%3A", ":").replaceAll("%2C", ",");
