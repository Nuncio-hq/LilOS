import { useState } from "react";
import { V2NeedsYou } from "./v2-needs-you";
import { V2Sidebar } from "./v2-sidebar";
import { V2NewThread, V2ThreadView } from "./v2-thread";
import type { V2Agent, V2Project, V2Thread } from "./v2-types";

type View =
  | { kind: "thread"; id: string }
  | { kind: "needs" }
  | { kind: "new" };

/* UX v2 prototype shell: sidebar + one main column. Owns only view state
   and the mock mutations the prototype hands it; no wire calls. */
export function V2Shell({
  company,
  projects,
  agents,
  models,
  initialThreads,
  initialThreadId,
  onToast,
}: {
  company: string;
  projects: V2Project[];
  agents: V2Agent[];
  models: string[];
  initialThreads: V2Thread[];
  initialThreadId: string;
  onToast?: (text: string) => void;
}) {
  const [threads, setThreads] = useState(initialThreads);
  const [view, setView] = useState<View>({
    kind: "thread",
    id: initialThreadId,
  });
  const [draft, setDraft] = useState({
    projectId: projects[0]?.id ?? "",
    agentId: agents[0]?.id ?? "",
    model: models[0] ?? "",
  });
  const patch = (id: string, p: Partial<V2Thread>) =>
    setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
  const open = (id: string) => {
    setView({ kind: "thread", id });
    const t = threads.find((x) => x.id === id);
    if (t?.state === "unseen") patch(id, { state: "idle" });
  };
  const now = () => new Date().toTimeString().slice(0, 5);
  const current =
    view.kind === "thread" ? threads.find((t) => t.id === view.id) : undefined;

  const main =
    view.kind === "needs" ? (
      <V2NeedsYou
        threads={threads}
        agents={agents}
        projects={projects}
        onOpen={open}
      />
    ) : view.kind === "new" ? (
      <V2NewThread
        agents={agents}
        projects={projects}
        models={models}
        {...draft}
        onProject={(projectId) => setDraft((d) => ({ ...d, projectId }))}
        onAgent={(agentId) => setDraft((d) => ({ ...d, agentId }))}
        onModel={(model) => setDraft((d) => ({ ...d, model }))}
        onSend={(text) => {
          const id = `new-${Date.now()}`;
          const title =
            text.length > 48 ? `${text.slice(0, 46).trimEnd()}…` : text;
          setThreads((ts) => [
            {
              id,
              title,
              ...draft,
              state: "working",
              ago: 0,
              line: "Reading the project",
              messages: [{ from: "you", time: now(), text }],
            },
            ...ts,
          ]);
          setView({ kind: "thread", id });
        }}
      />
    ) : current ? (
      <V2ThreadView
        key={current.id}
        t={current}
        agents={agents}
        projects={projects}
        models={models}
        onAgent={(agentId) => {
          const a = agents.find((x) => x.id === agentId);
          patch(current.id, {
            agentId,
            messages: [
              ...current.messages,
              {
                from: "agent",
                time: now(),
                text: `Picked up from a recap of this thread. I'm ${a?.name}; carrying on from here.`,
              },
            ],
          });
          onToast?.(`${a?.name} took over with a recap`);
        }}
        onModel={(model) => patch(current.id, { model })}
        onAnswer={(answer) =>
          patch(current.id, {
            state: "working",
            ask: undefined,
            line: "Carrying on",
            messages: [
              ...current.messages,
              { from: "you", time: now(), text: answer },
            ],
          })
        }
        onSend={(text) =>
          patch(current.id, {
            state: "working",
            ago: 0,
            line: "Thinking",
            messages: [...current.messages, { from: "you", time: now(), text }],
          })
        }
        onSettle={() => {
          const back = current.state === "settled";
          patch(current.id, {
            state: back ? "idle" : "settled",
            pinned: false,
          });
          onToast?.(back ? "Back in the list" : "Settled. ⌘K still finds it.");
        }}
        onSnooze={() => {
          patch(current.id, { state: "snoozed", until: "Tomorrow 9:00" });
          onToast?.("Snoozed until tomorrow 9:00");
        }}
        onPin={() => patch(current.id, { pinned: !current.pinned })}
      />
    ) : null;

  return (
    <div className="lilos-v2 flex h-dvh min-h-0 overflow-hidden text-sm">
      <V2Sidebar
        company={company}
        projects={projects}
        threads={threads}
        agents={agents}
        current={view.kind === "thread" ? view.id : null}
        needsYouOpen={view.kind === "needs"}
        onOpen={open}
        onNew={(projectId) => {
          if (projectId) setDraft((d) => ({ ...d, projectId }));
          setView({ kind: "new" });
        }}
        onNeedsYou={() => setView({ kind: "needs" })}
        onSearch={() => onToast?.("⌘K searches every thread, settled ones too")}
        onAgents={() =>
          onToast?.("Agents page: hire, edit, see each agent's threads")
        }
      />
      {main}
    </div>
  );
}
