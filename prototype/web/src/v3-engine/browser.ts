import { agentNameOf, type V3DataActions } from "@lilos/ui"
import type { Engine } from "./context"

/* The LilOS Browser's tabs: opening one in a thread, closing it, taking it
   from its agent (or handing it back). */
export function browserActions({ setData, getData, toast }: Engine): Pick<
  V3DataActions,
  "browserOpen" | "browserClose" | "browserTakeOver"
> {
  return {
    browserOpen: (url, threadId) => {
      const host = url.replace(/^https?:\/\//, "").split("/")[0];
      setData((d) => ({
        ...d,
        browser: {
          ...d.browser,
          tabs: [
            ...d.browser.tabs,
            {
              id: `b-${Date.now().toString(36)}`,
              title: host,
              url,
              by: "you",
              // Yours, but in this session: its agent can see it too.
              threadId,
              page: [host, url],
            },
          ],
        },
      }));
    },
    browserClose: (tabId) => {
      setData((d) => ({
        ...d,
        browser: {
          ...d.browser,
          tabs: d.browser.tabs.filter((t) => t.id !== tabId),
        },
      }));
    },
    browserTakeOver: (tabId) => {
      const tab = getData().browser.tabs.find((t) => t.id === tabId);
      if (!tab || tab.by === "you") return;
      const name = agentNameOf(getData(), tab.by);
      setData((d) => ({
        ...d,
        browser: {
          ...d.browser,
          tabs: d.browser.tabs.map((t) =>
            t.id === tabId ? { ...t, takenOver: !t.takenOver } : t,
          ),
        },
      }));
      toast(
        tab.takenOver
          ? `Handed back · ${name} carries on`
          : `You have the tab · ${name} waits`,
      );
    },
  }
}
