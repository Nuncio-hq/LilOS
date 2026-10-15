import {
  HandIcon,
  KanbanSquareIcon,
  PlusIcon,
  SettingsIcon,
  SparklesIcon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { AddFolderDialog } from "../dialogs/add-folder-dialog";
import { useTheme } from "../shell/use-theme";
import type { FsDir, ModelChoice, WsPick } from "../types";
import { useV2Work } from "./use-v2-work";
import { V2AgentsList } from "./v2-agents";
import { V2AtWork } from "./v2-at-work";
import { V2CeoDock } from "./v2-ceo-dock";
import { V2CompanyHome } from "./v2-company";
import { V2HireForm } from "./v2-hire";
import { V2NeedsYou } from "./v2-needs-you";
import { pickFor, toFolders, type V2ModelKit } from "./v2-pickers";
import { V2Settings, type V2SettingsSection } from "./v2-settings";
import { V2Sheet } from "./v2-sheet";
import { V2Sidebar } from "./v2-sidebar";
import { V2NewThread, V2ThreadView } from "./v2-thread";
import { V2TicketDetail } from "./v2-ticket";
import type { V2Activity, V2Agent, V2Project, V2Thread } from "./v2-types";
import { V2_ATTENTION } from "./v2-types";
import { V2Work } from "./v2-work";
import type { V2Connector, V2Goal, V2Ticket } from "./v2-work-types";
import { V2WorkbenchPanel } from "./v2-workbench";

/** What fills the main column. Only Home, a thread and a new thread do. */
type View =
  | { kind: "thread"; id: string }
  | { kind: "home" }
  | { kind: "work" }
  | { kind: "new" };

/** What slides in from the right over the main column. */
type Sheet =
  | "agents"
  | "hire"
  | "needs"
  | "working"
  | "settings"
  | "connectors"
  | { ticket: string }
  | null;

/* UX v2 prototype shell: sidebar + one main column + right-side sheets.
   Lists you glance at (agents, needs you, at work, settings) slide over the
   page instead of replacing it. Owns only view state and the mock mutations
   the prototype hands it; no wire calls. */
export function V2Shell({
  company,
  me,
  projects: initialProjects,
  agents,
  modelKit,
  fs,
  discovered,
  initialThreads,
  initialThreadId,
  initialSheet,
  activity,
  goals = [],
  tickets: initialTickets = [],
  connectors: initialConnectors = [],
  initialView,
  initialCeo,
  onToast,
}: {
  company: string;
  /** The signed-in person's display name. */
  me: string;
  projects: V2Project[];
  agents: V2Agent[];
  modelKit: V2ModelKit;
  /** The machine's folders, for Add project. */
  fs: Record<string, FsDir>;
  discovered: string[];
  initialThreads: V2Thread[];
  /** Absent = open on Company home. */
  initialThreadId?: string;
  initialSheet?: Exclude<Sheet, null>;
  activity: V2Activity[];
  /** The AI company (#746): goals, tickets and connectors. Empty = no Work row. */
  goals?: V2Goal[];
  tickets?: V2Ticket[];
  connectors?: V2Connector[];
  /** Open on the Work board instead of Home. */
  initialView?: "work";
  /** Open the CEO panel beside the board. */
  initialCeo?: boolean;
  onToast?: (text: string) => void;
}) {
  const [threads, setThreads] = useState(initialThreads);
  const [projects, setProjects] = useState(initialProjects);
  const [team, setTeam] = useState(agents);
  const [sheet, setSheet] = useState<Sheet>(initialSheet ?? null);
  const [adding, setAdding] = useState(false);
  const [wbOpen, setWbOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const [view, setView] = useState<View>(
    initialThreadId
      ? { kind: "thread", id: initialThreadId }
      : initialView === "work"
        ? { kind: "work" }
        : { kind: "home" },
  );
  const [workProject, setWorkProject] = useState<string | null>(null);
  const [workWho, setWorkWho] = useState<string | null>(null);
  const [ceoOpen, setCeoOpen] = useState(!!initialCeo);
  const [ceoSession, setCeoSession] = useState<string | undefined>(undefined);
  const work = useV2Work({
    tickets: initialTickets,
    connectors: initialConnectors,
    agents: team,
    setAgents: setTeam,
    onToast,
  });
  const hasWork = initialTickets.length > 0;
  const openTicket = typeof sheet === "object" && sheet ? sheet.ticket : null;
  const ticket = work.tickets.find((t) => t.id === openTicket);
  /* The CEO's sessions, newest first; the dock shows the picked one, else
     the newest. "" = a new, empty session. */
  const ceoSessions = threads
    .filter((t) => t.agentId === work.ceo?.id && t.state !== "settled")
    .sort((a, b) => a.ago - b.ago);
  const ceoThreadId = ceoSession ?? ceoSessions[0]?.id;
  const openCeo = (threadId?: string) => {
    if (threadId) setCeoSession(threadId);
    setSheet(null);
    setView({ kind: "work" });
    setCeoOpen(true);
  };
  const firstModel = modelKit.models[0]?.id ?? "";
  const [draft, setDraft] = useState<{
    pick: WsPick;
    agentId: string;
    choice: ModelChoice;
  }>({
    pick: pickFor(initialProjects[0]),
    agentId: agents[0]?.id ?? "",
    choice: { model: firstModel },
  });
  const patch = (id: string, p: Partial<V2Thread>) =>
    setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
  const open = (id: string) => {
    setSheet(null);
    setView({ kind: "thread", id });
    const t = threads.find((x) => x.id === id);
    if (t?.state === "unseen") patch(id, { state: "idle" });
  };
  const now = () => new Date().toTimeString().slice(0, 5);
  const current =
    view.kind === "thread" ? threads.find((t) => t.id === view.id) : undefined;
  const needsCount =
    threads.filter((t) => V2_ATTENTION.includes(t.state)).length +
    work.risky.length;
  const workingCount = threads.filter((t) => t.state === "working").length;

  /* ⌘B toggles the Workbench while a thread is open. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b" && current) {
        e.preventDefault();
        setWbOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  const addProject = (path: string, project?: { name: string }) => {
    const id = `p-${Date.now()}`;
    const dir = fs[path];
    const name =
      project?.name || path.split("/").filter(Boolean).pop() || "Project";
    const p: V2Project = {
      id,
      name,
      path,
      branches: dir?.git?.branches ?? [],
      workstreams: [],
    };
    setProjects((ps) => [
      ...ps.filter((x) => x.path),
      p,
      ...ps.filter((x) => !x.path),
    ]);
    setDraft((d) => ({ ...d, pick: pickFor(p) }));
    setAdding(false);
    onToast?.(`${name} added`);
  };

  const main =
    view.kind === "work" ? (
      <V2Work
        goals={goals}
        tickets={work.tickets}
        agents={team}
        connectors={work.connectors}
        projects={projects}
        ceo={work.ceo}
        project={workProject}
        worker={workWho}
        activeTicket={openTicket}
        ceoOpen={ceoOpen}
        onProject={setWorkProject}
        onWorker={setWorkWho}
        onOpenTicket={(id) => setSheet({ ticket: id })}
        onToggleCeo={work.ceo ? () => setCeoOpen((o) => !o) : undefined}
        dock={
          work.ceo && (
            <V2CeoDock
              ceo={work.ceo}
              sessions={ceoSessions}
              sessionId={ceoThreadId}
              ticketIds={work.tickets.map((t) => t.id)}
              onSession={setCeoSession}
              onNewSession={() => setCeoSession("")}
              onTicket={(id) => setSheet({ ticket: id })}
              onExpand={() => ceoThreadId && open(ceoThreadId)}
              onClose={() => setCeoOpen(false)}
              onSend={(text) => {
                const cur = threads.find((t) => t.id === ceoThreadId);
                if (cur) {
                  patch(cur.id, {
                    state: "working",
                    ago: 0,
                    line: "Planning",
                    messages: [
                      ...cur.messages,
                      { from: "you", time: now(), text },
                    ],
                  });
                  return;
                }
                const id = `ceo-${Date.now()}`;
                setThreads((ts) => [
                  {
                    id,
                    title:
                      text.length > 48
                        ? `${text.slice(0, 46).trimEnd()}…`
                        : text,
                    projectId: workProject ?? "none",
                    agentId: work.ceo?.id ?? "",
                    model: work.ceo?.model ?? "",
                    state: "working",
                    ago: 0,
                    line: "Planning",
                    messages: [{ from: "you", time: now(), text }],
                  },
                  ...ts,
                ]);
                setCeoSession(id);
              }}
            />
          )
        }
      />
    ) : view.kind === "home" ? (
      <V2CompanyHome
        company={company}
        threads={threads}
        agents={team}
        projects={projects}
        activity={activity}
        onOpen={open}
        onNeedsYou={() => setSheet("needs")}
        onAgents={() => setSheet("agents")}
        onWorking={() => setSheet("working")}
        ticketAsks={work.risky.length}
      />
    ) : view.kind === "new" ? (
      <V2NewThread
        agents={team}
        projects={projects}
        modelKit={modelKit}
        {...draft}
        onPick={(pick) => setDraft((d) => ({ ...d, pick }))}
        onAgent={(agentId) => setDraft((d) => ({ ...d, agentId }))}
        onModel={(choice) => setDraft((d) => ({ ...d, choice }))}
        onAddProject={() => setAdding(true)}
        onSend={(text) => {
          const id = `new-${Date.now()}`;
          const title =
            text.length > 48 ? `${text.slice(0, 46).trimEnd()}…` : text;
          setThreads((ts) => [
            {
              id,
              title,
              projectId: draft.pick.folder ?? "none",
              agentId: draft.agentId,
              model: draft.choice.model,
              choice: draft.choice,
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
      <div className="flex min-h-0 min-w-0 flex-1">
        <V2ThreadView
          key={current.id}
          t={current}
          agents={team}
          projects={projects}
          modelKit={modelKit}
          wbOpen={wbOpen}
          onWorkbench={() => setWbOpen((o) => !o)}
          onAgent={(agentId) => {
            const a = team.find((x) => x.id === agentId);
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
          onModel={(choice) =>
            patch(current.id, { model: choice.model, choice })
          }
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
              messages: [
                ...current.messages,
                { from: "you", time: now(), text },
              ],
            })
          }
          onSettle={() => {
            const back = current.state === "settled";
            patch(current.id, {
              state: back ? "idle" : "settled",
              pinned: false,
            });
            onToast?.(
              back ? "Back in the list" : "Settled. ⌘K still finds it.",
            );
          }}
          onSnooze={() => {
            patch(current.id, { state: "snoozed", until: "Tomorrow 9:00" });
            onToast?.("Snoozed until tomorrow 9:00");
          }}
          onPin={() => patch(current.id, { pinned: !current.pinned })}
        />
        <V2WorkbenchPanel
          key={`wb-${current.id}`}
          t={current}
          project={projects.find((p) => p.id === current.projectId)}
          agentName={
            team.find((a) => a.id === current.agentId)?.name ?? "Agent"
          }
          me={me}
          open={wbOpen}
          onClose={() => setWbOpen(false)}
          onSend={(text) =>
            patch(current.id, {
              state: "working",
              ago: 0,
              line: "Thinking",
              messages: [
                ...current.messages,
                { from: "you", time: now(), text },
              ],
            })
          }
          say={onToast}
        />
      </div>
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
          sheet === "hire"
            ? "agents"
            : sheet === "working"
              ? "home"
              : sheet === "connectors"
                ? "settings"
                : typeof sheet === "string"
                  ? sheet
                  : view.kind === "home" || view.kind === "work"
                    ? view.kind
                    : null
        }
        onOpen={open}
        onNew={(projectId) => {
          setSheet(null);
          if (projectId)
            setDraft((d) => ({
              ...d,
              pick: pickFor(projects.find((p) => p.id === projectId)),
            }));
          setView({ kind: "new" });
        }}
        onPage={(kind) => {
          if (kind === "home" || kind === "work") {
            setSheet(null);
            setView({ kind });
          } else setSheet((s) => (s === kind ? null : kind));
        }}
        openTickets={hasWork ? work.openTickets : undefined}
        ticketAsks={work.risky.length}
        onSearch={() => onToast?.("⌘K searches every thread, settled ones too")}
        onAddProject={() => setAdding(true)}
      />
      <main className="lilos-v2-main flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {main}
      </main>

      {(sheet === "agents" || sheet === "hire") && (
        <V2Sheet
          key="agents"
          title={sheet === "hire" ? "Hire an agent" : "Agents"}
          icon={<UsersIcon />}
          count={
            sheet === "hire" ? undefined : team.filter((a) => !a.soon).length
          }
          onClose={() => setSheet(null)}
          onBack={sheet === "hire" ? () => setSheet("agents") : undefined}
          actions={
            sheet === "agents" && (
              <button
                type="button"
                onClick={() => setSheet("hire")}
                className="mr-1 flex h-7 items-center gap-1 rounded-full bg-foreground pr-3 pl-2.5 font-medium text-[12px] text-background active:scale-[0.97]"
              >
                <PlusIcon className="size-3.5" />
                Hire
              </button>
            )
          }
        >
          {sheet === "hire" ? (
            <div key="hire" className="lilos-v2-push">
              <V2HireForm
                modelKit={modelKit}
                onCancel={() => setSheet("agents")}
                onHire={(d) => {
                  setTeam((ts) => [
                    ...ts.filter((a) => !a.soon),
                    {
                      id: `hired-${Date.now()}`,
                      name: d.name.trim(),
                      role: d.role,
                      runtime: d.runtime,
                      model: d.model.model,
                      skills: 0,
                    },
                    ...ts.filter((a) => a.soon),
                  ]);
                  setSheet("agents");
                  onToast?.(`${d.name.trim()} joined the team`);
                }}
              />
            </div>
          ) : (
            <div key="list" className="lilos-v2-push">
              <V2AgentsList
                agents={team}
                threads={threads}
                projects={projects}
                connectors={work.connectors}
                onOpen={open}
                onMakeCeo={hasWork ? work.makeCeo : undefined}
              />
            </div>
          )}
        </V2Sheet>
      )}
      {sheet === "needs" && (
        <V2Sheet
          title="Needs you"
          icon={<HandIcon />}
          count={needsCount}
          onClose={() => setSheet(null)}
        >
          <V2NeedsYou
            threads={threads}
            agents={team}
            projects={projects}
            tickets={work.risky}
            connectors={work.connectors}
            onOpen={open}
            onOpenTicket={(id) => setSheet({ ticket: id })}
          />
        </V2Sheet>
      )}
      {sheet === "working" && (
        <V2Sheet
          title="At work"
          icon={<SparklesIcon />}
          count={workingCount}
          onClose={() => setSheet(null)}
        >
          <V2AtWork
            threads={threads}
            agents={team}
            projects={projects}
            onOpen={open}
          />
        </V2Sheet>
      )}
      {(sheet === "settings" || sheet === "connectors") && (
        <V2Sheet
          title="Settings"
          icon={<SettingsIcon />}
          width="w-[min(720px,100vw)]"
          onClose={() => setSheet(null)}
        >
          <V2Settings
            name={me}
            theme={theme}
            onTheme={setTheme}
            connectors={work.connectors}
            agents={team}
            onConnector={work.toggleConnector}
            initialSection={
              sheet === "connectors"
                ? ("connectors" satisfies V2SettingsSection)
                : undefined
            }
          />
        </V2Sheet>
      )}
      {ticket && (
        <V2Sheet
          key={`ticket-${ticket.id}`}
          title={ticket.id}
          inset={
            ceoOpen && view.kind === "work"
              ? "lg:right-[388px] xl:right-[428px]"
              : undefined
          }
          icon={<KanbanSquareIcon />}
          onClose={() => setSheet(null)}
        >
          <V2TicketDetail
            t={ticket}
            goal={goals.find((g) => g.id === ticket.goalId)}
            agents={team}
            connectors={work.connectors}
            projects={projects}
            onApprove={() => work.approve(ticket.id)}
            onDeny={() => work.deny(ticket.id)}
            onAskCeo={work.ceo ? () => openCeo(ticket.threadId) : undefined}
          />
        </V2Sheet>
      )}
      {adding && (
        <AddFolderDialog
          folders={toFolders(projects)}
          fs={fs}
          discovered={discovered}
          onClose={() => setAdding(false)}
          onAdd={addProject}
        />
      )}
    </div>
  );
}
