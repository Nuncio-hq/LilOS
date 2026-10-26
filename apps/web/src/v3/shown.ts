import { isRecordRoute, type V3Data, type V3Nav } from "@lilos/ui";

/* What the shell draws, as opposed to what the URL says. The hash can name a
   gated page or record, and first run owns the whole window (no page, no
   peek). Everything that follows "what is on screen" (the thread's engine
   feed, the read watermark, notifications, ⌘N, a click's next step) asks
   here, so none of it acts on a thread or a page the human cannot see. Pure
   on purpose: no DOM, no stores. */

/** Work and Goals wait for tickets (M2). Inbox also waits for an update:
    an empty inbox is not a page, the same as the sidebar hiding it. A link
    to a gated page lands on Home. A project is not gated: it is a folder
    the company works in (D-#771), with its threads, tickets or not.
    `hasUpdates` defaults to true so a caller that has not loaded the inbox
    does not hide a page it cannot judge. */
export function visibleNav(
  nav: V3Nav,
  tickets: boolean,
  hasUpdates = true,
): V3Nav {
  if (!tickets) {
    const gated = ["work", "inbox", "goals"].includes(nav.page.page);
    /* A record can sit in `page` now (D-#769): a gated ticket or goal in
       that slot is not opened either, so the shown nav lands on Home the
       same way a gated page does. */
    const gatedRecord =
      isRecordRoute(nav.page) &&
      (nav.page.page === "ticket" || nav.page.page === "goal");
    const peek = nav.peek.filter(
      (r) => r.page !== "ticket" && r.page !== "goal",
    );
    if (!gated && !gatedRecord && peek.length === nav.peek.length) return nav;
    return {
      ...nav,
      page: gated || gatedRecord ? { page: "home" } : nav.page,
      peek,
    };
  }
  if (hasUpdates || nav.page.page !== "inbox") return nav;
  return { ...nav, page: { page: "home" } };
}

/** The conversation on screen, if any: the side peek's top thread, or the
    thread that IS the page now that a record can be the page (D-#769). A
    widened peek covers the page, so a non-thread top hides whatever thread
    the page holds. First run (V3Shell: not set up, or the Welcome page)
    draws no record, so nothing is open then: marking a thread read or
    silencing its notifications while the human is on Welcome would be a
    lie. */
export function threadOnScreen(
  nav: V3Nav,
  data: Pick<V3Data, "setUp" | "features"> & {
    updates?: V3Data["updates"];
  },
): string | undefined {
  const shown = visibleNav(
    nav,
    data.features.tickets,
    !data.updates || data.updates.length > 0,
  );
  if (!data.setUp || shown.page.page === "welcome") return undefined;
  const top = shown.peek[shown.peek.length - 1];
  if (top?.page === "thread") return top.id;
  if (top != null && shown.full) return undefined;
  return shown.page.page === "thread" ? shown.page.id : undefined;
}
