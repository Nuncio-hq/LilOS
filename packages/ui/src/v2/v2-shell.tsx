import { useState } from "react";
import { useTheme } from "../shell/use-theme";
import { V2Agents, V2CompanyHome } from "./v2-company";
import { V2HireDialog } from "./v2-hire";
import { V2NeedsYou } from "./v2-needs-you";
import { V2Settings } from "./v2-settings";
import { V2Sidebar } from "./v2-sidebar";
import { V2NewThread, V2ThreadView } from "./v2-thread";
import type { V2Activity, V2Agent, V2Project, V2Thread } from "./v2-types";

type View =
  | { kind: "thread"; id: string }
  | { kind: "home" }
  | { kind: "needs" }
  | { kind: "agents" }
  | { kind: "settings" }
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
  activity,
  onToast,
}: {
  company: string;
  projects: V2Project[];
  agents: V2Agent[];
  models: string[];
  initialThreads: V2Thread[];
  /** Absent = open on Company home. */
  initialThreadId?: string;
  activity: V2Activity[];
  onToast?: (text: string) => void;
}) {
  const [threads, setThreads] = useState(initialThreads);
  const [team, setTeam] = useState(agents);
  const [hiring, setHiring] = useState(false);
  const [theme, setTheme] = useTheme();
  const [view, setView] = useState<View>(
    initialThreadId
      ? { kind: "thread", id: initialThreadId }
      : { kind: "home" },
  );
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
    view.kind === "home" ? (
      <V2CompanyHome
        company={company}
        threads={threads}
        agents={team}
        projects={projects}
        activity={activity}
        onOpen={open}
        onNeedsYou={() => setView({ kind: "needs" })}
        onAgents={() => setView({ kind: "agents" })}
      />
    ) : view.kind === "agents" ? (
      <V2Agents
        agents={team}
        threads={threads}
        projects={projects}
        onOpen={open}
        onHire={() => setHiring(true)}
      />
    ) : view.kind === "settings" ? (
      <V2Settings name="Oscar" theme={theme} onTheme={setTheme} />
    ) : view.kind === "needs" ? (
      <V2NeedsYou
        threads={threads}
        agents={team}
        projects={projects}
        onOpen={open}
      />
    ) : view.kind === "new" ? (
      <V2NewThread
        agents={team}
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
        agents={team}
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
        agents={team}
        current={view.kind === "thread" ? view.id : null}
        page={
          view.kind === "home" ||
          view.kind === "needs" ||
          view.kind === "agents" ||
          view.kind === "settings"
            ? view.kind
            : null
        }
        onOpen={open}
        onNew={(projectId) => {
          if (projectId) setDraft((d) => ({ ...d, projectId }));
          setView({ kind: "new" });
        }}
        onPage={(kind) => setView({ kind })}
        onSearch={() => onToast?.("⌘K searches every thread, settled ones too")}
      />
      {main}
      {hiring && (
        <V2HireDialog
          models={models}
          onClose={() => setHiring(false)}
          onHire={(d) => {
            setTeam((ts) => [
              ...ts.filter((a) => !a.soon),
              {
                id: `hired-${Date.now()}`,
                name: d.name.trim(),
                role: d.role,
                runtime: d.runtime,
                model: d.model,
                skills: 0,
              },
              ...ts.filter((a) => a.soon),
            ]);
            setHiring(false);
            setView({ kind: "agents" });
            onToast?.(`${d.name.trim()} joined the team`);
          }}
        />
      )}
    </div>
  );
}
