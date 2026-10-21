import { agentNameOf, agentOf, type V3DataActions } from "@lilos/ui"
import type { Engine } from "./context"

/* Scheduled jobs: saved, paused, run now, deleted. */
export function scheduleActions({ setData, getData, toast }: Engine): Pick<
  V3DataActions,
  "scheduleSave" | "scheduleToggle" | "scheduleRunNow" | "scheduleDelete"
> {
  return {
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
  }
}
