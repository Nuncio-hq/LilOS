import {
  openAgent,
  openHire,
  openPeople,
  openProject,
  openTab,
  openThread,
  openTicket,
  whenNavReady,
} from "./nav";
import { pushNext } from "./notify-bridge";
import { focusAsk, resetCompany } from "./store";

/* `lilos://preview?…` jumps the prototype to a state, for screenshots and
   the Maestro walk:
     reset=1                     fresh company
     open=home|needs|work|company|ask   a tab
     open=thread:<id> | agent:<id> | ticket:<id> | project:<id> | ask:<id>
          | people | hire
     push=ask|update             fire the next demo notification now
     ui=v2|v3                    which prototype (root.tsx); a link for v2 is
                                 not this handler's */

/** The query of a preview link, or undefined for any other URL. */
export function previewQuery(url: string | null): string | undefined {
  const m = url ? /^lilos:\/\/preview\/?\?(.*)$/i.exec(url) : null;
  return m ? (m[1] ?? "") : undefined;
}

export function applyPreview(query: string) {
  const q = new URLSearchParams(query);
  // The v2 prototype reads its own links; this one must not act on the v3
  // company because of them.
  if (q.get("ui") === "v2") return;
  if (q.get("reset")) resetCompany();
  const open = q.get("open");
  if (open) {
    whenNavReady(() => {
      if (open === "hire") openHire();
      else if (open === "people") openPeople();
      else if (open.startsWith("project:")) openProject(open.slice(8));
      else if (open.startsWith("thread:")) openThread(open.slice(7));
      else if (open.startsWith("agent:")) openAgent(open.slice(6));
      else if (open.startsWith("ticket:")) openTicket(open.slice(7));
      else if (open.startsWith("ask:")) {
        focusAsk(open.slice(4));
        openTab("Needs");
      } else
        openTab(
          open === "needs"
            ? "Needs"
            : open === "work"
              ? "Work"
              : open === "company"
                ? "Company"
                : open === "ask"
                  ? "AskCeo"
                  : "Home",
        );
    });
  }
  const push = q.get("push");
  if (push === "ask" || push === "update") pushNext(push);
}
