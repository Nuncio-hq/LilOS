import { agentNameOf, agentOf, type V3DataActions, type V3Data, type V3Thread } from "@lilos/ui"

type SetData = (fn: (d: V3Data) => V3Data) => void;

/* The prototype's engine for the tools around the company (Workbench
   rewind, schedules, the LilOS Browser, phone pairing, settings, first run).
   Each action rewrites the mock records the way the relay would. */
export function toolActions(
  setData: SetData,
  getData: () => V3Data,
  toast: (t: string) => void,
): Pick<
  V3DataActions,
  | "rewind"
  | "renameThread"
  | "archiveThread"
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
  | "checkEngine"
  | "checkUpdates"
> {
  let checking: Promise<void> | undefined
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
    renameThread: (threadId, title) => {
      const next = title.trim();
      if (!next) return;
      // A thread keeps its title wherever it lives: live or archived.
      const rename = (t: V3Thread) => (t.id === threadId ? { ...t, title: next } : t);
      setData((d) => ({
        ...d,
        threads: d.threads.map(rename),
        archivedThreads: d.archivedThreads?.map(rename),
      }));
    },
    archiveThread: (threadId, archived) => {
      setData((d) => {
        const from = archived ? d.threads : (d.archivedThreads ?? []);
        const moved = from.find((t) => t.id === threadId);
        if (!moved) return d;
        const rest = from.filter((t) => t.id !== threadId);
        return archived
          ? { ...d, threads: rest, archivedThreads: [moved, ...(d.archivedThreads ?? [])] }
          : { ...d, threads: [moved, ...d.threads], archivedThreads: rest };
      });
      toast(archived ? "Archived · it moved to Threads → All → Archived" : "Unarchived · it is back in your threads");
    },
    scheduleSave: (s) => {
      setData((d) => ({
        ...d,
        schedules: d.schedules.some((x) => x.id === s.id)
          ? d.schedules.map((x) => (x.id === s.id ? s : x))
          : [...d.schedules, s],
      }));
      toast(
        `Scheduled · ${agentNameOf(getData(), s.agentId)} runs it ${s.next.toLowerCase()}`,
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
      // A run needs someone on the team to run it.
      if (!agent) return;
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
    pairPhone: async () => {
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
      const host = "this-mac.tail4f2a.ts.net";
      const code = Math.random().toString(36).slice(2, 14).toUpperCase().padEnd(12, "7");
      return {
        kind: "ready",
        offer: {
          host,
          code,
          url: `lilos://pair?host=${host}&name=This%20Mac#code=${code}`,
          expiresAt: Date.now() + 300_000,
        },
      };
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
    finishSetup: ({ company, me, agentName, agentModel }) => {
      setData((d) => ({
        ...d,
        company: company || d.company,
        me: me || d.me,
        setUp: true,
        agents: d.agents.map((a) =>
          a.id === d.ceoId
            ? { ...a, name: agentName || a.name, model: agentModel || a.model }
            : a,
        ),
      }));
    },
    /* The mock relay and engine come up one after the other (the way the
       first-run check always looked), then settle on what the data says. */
    checkEngine: () =>
      (checking ??= new Promise<void>((done) => {
        const { relay, engine } = getData().settings
        const put = (r: typeof relay, e: typeof engine) =>
          setData((d) => ({ ...d, settings: { ...d.settings, relay: r, engine: e } }))
        put({ state: "starting" }, { ...engine, state: "starting" })
        window.setTimeout(() => put(relay, { ...engine, state: "starting" }), 600)
        window.setTimeout(() => {
          put(relay, engine)
          checking = undefined
          done()
        }, 1400)
      })),
    checkUpdates: () =>
      new Promise<string>((done) =>
        window.setTimeout(() => done("LilOS is up to date."), 1000),
      ),
  };
}
