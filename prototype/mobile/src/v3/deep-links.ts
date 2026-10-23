import * as Linking from "expo-linking";
import { useEffect } from "react";
import {
  openAgent,
  openHire,
  openTab,
  openThread,
  openTicket,
  v3Nav,
} from "./nav";
import { pushNext } from "./notify-bridge";
import { focusAsk, resetCompany } from "./store";

/* `lilos://preview?…` jumps the prototype to a state, for screenshots and
   the Maestro walk:
     reset=1                     fresh company
     open=home|needs|work|company|ask   a tab
     open=thread:<id> | agent:<id> | ticket:<id> | ask:<id> | hire
     push=ask|update             fire the next demo notification now */

function apply(query: string) {
  const q = new URLSearchParams(query);
  if (q.get("reset")) resetCompany();
  const open = q.get("open");
  const go = () => {
    if (!open) return;
    if (open === "hire") openHire();
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
  };
  if (open) {
    if (v3Nav.isReady()) go();
    else setTimeout(go, 400);
  }
  const push = q.get("push");
  if (push === "ask" || push === "update") pushNext(push);
}

let launchHandled = false;

/* An event per opened link, not the latest-URL hook: opening the same link
   twice (two `push=ask` in a row) must act twice. */
export function useV3DeepLinks() {
  useEffect(() => {
    const handle = (url: string | null) => {
      const m = url ? /^lilos:\/\/preview\/?\?(.*)$/i.exec(url) : null;
      if (m) apply(m[1] ?? "");
    };
    // The launch link counts once per process: V3App remounts when the
    // owner flips to v2 and back, and must not replay it.
    if (!launchHandled) {
      launchHandled = true;
      void Linking.getInitialURL().then(handle);
    }
    const sub = Linking.addEventListener("url", (e) => handle(e.url));
    return () => sub.remove();
  }, []);
}
