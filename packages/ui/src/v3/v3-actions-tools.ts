import { agentOf } from "./v3-model";
import type { V3Actions, V3Data, V3Route } from "./v3-types";

type SetData = (fn: (d: V3Data) => V3Data) => void;

/* The prototype's engine for the tools around the company (Workbench
   rewind, schedules, the LilOS Browser, phone pairing, settings, first run).
   Each action rewrites the mock records the way the relay would. */
export function toolActions(
  setData: SetData,
  getData: () => V3Data,
  toast: (t: string) => void,
  go: (r: V3Route) => void,
): Pick<
  V3Actions,
  | "rewind"
  | "scheduleSave"
  | "scheduleToggle"
  | "scheduleRunNow"
  | "scheduleDelete"
  | "browserOpen"
  | "browserClose"
  | "browserTakeOver"
  | "pairPhone"
  | "unpairPhone"
  | "saveSettings"
  | "finishSetup"
> {
  return {
    rewind: (threadId, turn) => {
      const th = getData().threads.find((t) => t.id === threadId);
      if (!th) return;
      // Everything from this turn on goes: its message comes back to the
      // composer (the page does that), the files go back to the checkpoint
      // taken just before it.
      const dropped = th.turns.filter((u) => u.n >= turn).length;
      setData((d) => ({
        ...d,
        threads: d.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                turns: t.turns.filter((u) => u.n < turn),
                status: "done",
                rewound: { dropped, files: !!t.workbench },
              }
            : t,
        ),
      }));
      toast("Rewound · files and conversation are back to before that message");
    },
    scheduleSave: (s) => {
      setData((d) => ({
        ...d,
        schedules: d.schedules.some((x) => x.id === s.id)
          ? d.schedules.map((x) => (x.id === s.id ? s : x))
          : [...d.schedules, s],
      }));
      toast(
        `Scheduled · ${agentOf(getData(), s.agentId).name} runs it ${s.next.toLowerCase()}`,
      );
    },
    scheduleToggle: (id) => {
      setData((d) => ({
        ...d,
        schedules: d.schedules.map((x) =>
          x.id === id ? { ...x, paused: !x.paused } : x,
        ),
      }));
    },
    scheduleRunNow: (id) => {
      const s = getData().schedules.find((x) => x.id === id);
      if (!s) return;
      const threadId = `t-run-${id}-${Date.now().toString(36)}`;
      const project = getData().projects.find((p) => p.id === s.projectId);
      const agent = agentOf(getData(), s.agentId);
      setData((d) => ({
        ...d,
        schedules: d.schedules.map((x) =>
          x.id === id
            ? { ...x, last: { at: "Just now", result: "running", threadId } }
            : x,
        ),
        threads: [
          {
            id: threadId,
            projectId: s.projectId,
            agentId: s.agentId,
            title: s.title,
            status: "working",
            startedAt: "12:05",
            minutes: 0,
            step: 1,
            context: 2,
            model: agent.model,
            folder: project?.folder ?? "~",
            now: { kind: "read", text: "Reading the job", elapsed: "0s" },
            changes: [],
            turns: [
              {
                n: 1,
                from: "scheduled · run now",
                took: "0m so far",
                prompt: { by: "you", at: "12:05", text: s.prompt },
                steps: [
                  {
                    kind: "read",
                    target: "the job and the last run",
                    running: true,
                  },
                ],
              },
            ],
          },
          ...d.threads,
        ],
      }));
      toast(`${agent.name} started “${s.title}”`);
    },
    scheduleDelete: (id) => {
      setData((d) => ({
        ...d,
        schedules: d.schedules.filter((x) => x.id !== id),
      }));
      toast("Schedule deleted");
    },
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
      const name = agentOf(getData(), tab.by).name;
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
    pairPhone: () => {
      // The prototype's phone scans the code two seconds later.
      window.setTimeout(() => {
        setData((d) => ({
          ...d,
          devices: [
            ...d.devices,
            {
              id: `d-${Date.now().toString(36)}`,
              name: "iPad",
              model: "iPad Air",
              lastSeen: "Just now",
            },
          ],
        }));
        toast("Paired · notifications go to this device too");
      }, 2000);
    },
    unpairPhone: (deviceId) => {
      setData((d) => ({
        ...d,
        devices: d.devices.filter((x) => x.id !== deviceId),
      }));
      toast("Unpaired · it no longer reaches this Mac");
    },
    saveSettings: (patch) => {
      setData((d) => ({ ...d, settings: { ...d.settings, ...patch } }));
    },
    finishSetup: ({ company, me, ceoName, ceoModel }) => {
      setData((d) => ({
        ...d,
        company: company || d.company,
        me: me || d.me,
        setUp: true,
        agents: d.agents.map((a) =>
          a.id === d.ceoId
            ? { ...a, name: ceoName || a.name, model: ceoModel || a.model }
            : a,
        ),
      }));
      go({ page: "home" });
    },
  };
}
