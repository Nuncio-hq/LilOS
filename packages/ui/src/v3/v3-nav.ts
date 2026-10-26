import type { V3Data } from "./v3-data-types";
import { goalOf, threadOf, threadProjectId, ticketOf } from "./v3-model";
import type {
  V3Nav,
  V3PageRoute,
  V3RecordRoute,
  V3Route,
} from "./v3-page-types";

/* One place for how you move around v3 (#767 feedback, split by #863).
   The split view is only for related things: the sidebar and ⌘K NAVIGATE —
   the target becomes the page, full width, and any peek closes — while an
   item ON the page that belongs to it (a thread row on its project, a
   helper on its parent thread) opens in the side PEEK beside it, so the
   list you started from never goes away. A link inside the peek extends
   its trail; the peek's Back walks it. Not: every click beside whatever
   page is showing (a project on the left, an unrelated agent on the
   right), nor record links that replace the list you were reading. */

/** A route that opens a record (it carries an id), as opposed to a page. */
export const isRecordRoute = (r: V3Route): r is V3RecordRoute => "id" in r;

/** Who asked for a move: `nav` the sidebar or ⌘K (always navigates),
   `page` an item on the current page (peeks only when it belongs there),
   `peek` a link inside the side peek (it extends the trail). */
export type V3StepFrom = "nav" | "page" | "peek";

/** Whether the current page lists this record — so opening it beside keeps
   the list (D-#769). A record the page does not own is a place you go to:
   the click navigates instead. Projects are places themselves (the
   sidebar's entries), never items on another page. */
export function belongsTo(d: V3Data, page: V3Route, r: V3RecordRoute): boolean {
  const on = (...pages: V3Route["page"][]) => pages.includes(page.page);
  switch (r.page) {
    case "newchat":
      // A chat draft sits wherever its agent's threads would: Home's box,
      // the Threads starter, that agent's own page.
      return (
        on("home", "threads") || (page.page === "agent" && page.id === r.id)
      );
    case "thread": {
      if (on("home", "needs", "threads", "work", "inbox")) return true;
      const t = threadOf(d, r.id);
      if (!t) return false;
      switch (page.page) {
        case "project":
          return threadProjectId(d, t) === page.id;
        case "agent":
          return t.agentId === page.id;
        // A helper on its parent thread's page; the parent is the helper's
        // context, not its item — opening it from a helper navigates.
        case "thread":
          return t.parentId === page.id;
        case "ticket":
          return t.ticketId === page.id;
        default:
          return false;
      }
    }
    case "ticket": {
      if (on("work", "home", "needs", "inbox")) return true;
      const k = ticketOf(d, r.id);
      if (!k) return false;
      switch (page.page) {
        case "project":
          return k.projectId === page.id;
        case "goal":
          return k.goalId === page.id;
        case "agent":
          return k.owner === page.id;
        default:
          return false;
      }
    }
    case "goal": {
      if (on("goals", "home", "inbox")) return true;
      const g = goalOf(d, r.id);
      return page.page === "project" && g?.projectId === page.id;
    }
    case "agent":
      return on("people", "hire", "home");
    case "project":
      return false;
  }
}

/** Where `r` leads from where you are (D-#769): `nav` always becomes the
   page; `page` opens the record beside when the page lists it, else it
   navigates too; `peek` extends the trail. Changing page always starts at
   the page's top and closes the peek. */
export function step(
  nav: V3Nav,
  r: V3Route,
  from: V3StepFrom,
  d: V3Data,
): V3Nav {
  if (from === "nav" || !isRecordRoute(r)) return { page: r, peek: [] };
  if (from === "page")
    return belongsTo(d, nav.page, r)
      ? { ...nav, peek: [r] }
      : { page: r, peek: [] };
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

/* Where you are, as URL parameters: the one codec the prototype (query) and
   the real app (hash, `#?page=threads&open=thread:<id>`) share, so any
   screen can be linked, reloaded, or reached with Back/Forward.
   `page=` the page — a page name, or a record kind with `id=` (a project,
   an agent, a thread as the page itself) — `view=` its tab, `open=` the
   trail of records open in the side peek (comma-separated `kind:id`),
   `full=1` the peek widened or the page's thread a session. Parameters
   that are not navigation (`theme`, `v3`) are left alone. */
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
  if (isRecordKind(name) && id)
    return { page: { page: name, id } as V3RecordRoute, peek, full };
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
  if (isRecordRoute(p)) {
    q.set("page", p.page);
    q.set("id", p.id);
  } else {
    if (p.page !== "home") q.set("page", p.page);
    if ("view" in p && p.view) q.set("view", p.view);
  }
  if (nav.peek.length)
    q.set("open", nav.peek.map((r) => `${r.page}:${r.id}`).join(","));
  if (nav.full) q.set("full", "1");
  return q;
}

/** Parameters as text, keeping `:` and `,` readable in the address bar. */
export const paramsText = (q: URLSearchParams): string =>
  q.toString().replaceAll("%3A", ":").replaceAll("%2C", ",");
