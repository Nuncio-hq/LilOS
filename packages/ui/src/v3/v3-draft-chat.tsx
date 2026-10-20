import { CheckIcon, ChevronDownIcon, FolderIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/utils";
import { AgentAvatar, Page, ProjectMark, Title } from "./v3-bits";
import { Composer } from "./v3-composer";
import { agentOf, defaultAgent, projectOf, ticketOf } from "./v3-model";
import type { V3Agent, V3Data, V3PageProps } from "./v3-types";

/* A new chat, opened like any record in the side peek: you already chose who
   (from their page, or the CEO from Threads), so there is no picker, only a
   box to write in. Who, where and which model sit as quiet chips under the
   text and open a tiny menu to change. Sending starts a thread with no ticket
   and takes the draft's place on the trail; "Make it a ticket" comes later.
   The models on offer are the app's (`modelChoices`); where it works is a
   project, or, in a company without projects, one of the app's folders. */

const CHIP =
  "inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground";

/** Where an agent usually works: the project of its most recent thread (a
    chat names its project; a ticket's hand uses the ticket's), else the
    first project. Start times are zero-padded clocks, so text order is time. */
function usualProject(data: V3Data, agentId: string): string {
  let best: { at: string; project: string } | undefined;
  for (const t of data.threads) {
    if (t.agentId !== agentId) continue;
    const project =
      t.projectId ?? (t.ticketId ? ticketOf(data, t.ticketId)?.projectId : "");
    if (!project || !projectOf(data, project)) continue;
    if (!best || t.startedAt > best.at) best = { at: t.startedAt, project };
  }
  return best?.project ?? data.projects[0]?.id ?? "";
}

type Option = { id: string; node: ReactNode };

/** One chip that opens a small menu of choices above it. */
function ChipMenu({
  label,
  title,
  options,
  value,
  onPick,
}: {
  label: ReactNode;
  title: string;
  options: Option[];
  value: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // Opening puts the keyboard on the current choice (or the first).
  useEffect(() => {
    if (!open) return;
    const items = list.current?.querySelectorAll<HTMLElement>("button");
    const on = list.current?.querySelector<HTMLElement>(
      '[aria-checked="true"]',
    );
    (on ?? items?.[0])?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      // Closes the menu, not the peek behind it.
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(list.current?.querySelectorAll("button") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  return (
    <span className="relative min-w-0">
      <button
        ref={trigger}
        type="button"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(CHIP, open && "bg-[var(--v3-hover)] text-foreground")}
      >
        {label}
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
      </button>
      {open && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Close ${title.toLowerCase()} menu`}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            ref={list}
            role="menu"
            aria-label={title}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className="absolute bottom-full left-0 z-20 mb-1 max-h-[min(280px,50dvh)] min-w-[220px] max-w-[min(340px,calc(100vw-48px))] overflow-y-auto rounded-lg border border-[var(--v3-line)] bg-background py-1 text-[13.5px]"
          >
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                role="menuitemradio"
                aria-checked={o.id === value}
                onClick={() => {
                  onPick(o.id);
                  close();
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground outline-none hover:bg-[var(--v3-hover)] focus-visible:bg-[var(--v3-hover)]"
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {o.node}
                </span>
                {o.id === value && (
                  <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

export function V3DraftChat(props: V3PageProps & { id: string }) {
  const fallback = defaultAgent(props.data);
  // Nobody is hired yet: there is no one to start a chat with.
  if (!fallback) {
    return (
      <Page>
        <Title small kicker="New chat">
          No agents yet
        </Title>
        <p className="text-[14.5px] text-muted-foreground">
          A chat needs an agent to talk to.
        </p>
      </Page>
    );
  }
  return <DraftChat {...props} fallback={fallback} />;
}

function DraftChat({
  data,
  go,
  act,
  id,
  fallback,
}: V3PageProps & { id: string; fallback: V3Agent }) {
  const [agentId, setAgent] = useState(
    data.agents.some((a) => a.id === id) ? id : fallback.id,
  );
  // The chosen agent can leave the team while the draft is open (or the id
  // never matched one): the draft then goes to the default, like "nobody
  // chosen".
  const agent = agentOf(data, agentId) ?? fallback;
  // Project and model follow the agent until you choose one yourself.
  const [chosenProject, setProject] = useState<string>();
  const projectId = chosenProject ?? usualProject(data, agent.id);
  const project = projectOf(data, projectId);
  // A company with no projects yet picks among the app's recent folders.
  const folders = data.folders ?? [];
  const [chosenFolder, setFolder] = useState<string>();
  const folder = project
    ? undefined
    : (folders.find((f) => f.path === chosenFolder) ?? folders[0]);
  const [chosenModel, setModel] = useState<string>();
  // An outside worker has no model of its own: no chip, and none sent.
  const outside = agent.kind === "outside";
  const model = outside ? "" : (chosenModel ?? agent.model);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);

  // The Composer empties the box right after onSend, before we know whether
  // the chat started. That clearing is ignored while one is starting, so if
  // the app could not start it (it has said why) the typed text is still
  // there, and a second Send meanwhile cannot start a second chat.
  const edit = (text: string) => {
    if (!(sending.current && text === "")) setDraft(text);
  };
  async function send(text: string) {
    if (sending.current) return;
    sending.current = true;
    try {
      const thread = await act.startChat({
        agentId: agent.id,
        projectId: project?.id,
        folder: folder?.path,
        model,
        text,
      });
      if (thread === undefined) return;
      setDraft("");
      go({ page: "thread", id: thread });
    } finally {
      sending.current = false;
    }
  }

  const chips = (
    <>
      <ChipMenu
        title="Agent"
        value={agent.id}
        onPick={setAgent}
        label={
          <>
            <AgentAvatar data={data} agent={agent} size={16} />
            <span className="truncate">{agent.name}</span>
          </>
        }
        options={data.agents.map((a) => ({
          id: a.id,
          node: (
            <>
              <AgentAvatar data={data} agent={a} size={18} />
              <span className="shrink-0">{a.name}</span>
              <span className="truncate text-[12.5px] text-muted-foreground/70">
                {a.role}
              </span>
            </>
          ),
        }))}
      />
      {project ? (
        <ChipMenu
          title={`Project · ${project.folder}`}
          value={project.id}
          onPick={setProject}
          label={
            <>
              <ProjectMark
                name={project.name}
                tone={project.tone}
                className="size-4 text-[9px]"
              />
              <span className="truncate">{project.name}</span>
            </>
          }
          options={data.projects.map((p) => ({
            id: p.id,
            node: (
              <>
                <ProjectMark name={p.name} tone={p.tone} />
                <span className="shrink-0">{p.name}</span>
                <span className="truncate font-mono text-[12px] text-muted-foreground/70">
                  {p.folder}
                </span>
              </>
            ),
          }))}
        />
      ) : (
        folder && (
          <ChipMenu
            title={`Folder · ${folder.path}`}
            value={folder.path}
            onPick={setFolder}
            label={
              <>
                <FolderIcon className="size-3.5 shrink-0" />
                <span className="truncate">{folder.label}</span>
              </>
            }
            options={folders.map((f) => ({
              id: f.path,
              node: (
                <>
                  <FolderIcon className="size-3.5 shrink-0" />
                  <span className="shrink-0">{f.label}</span>
                  {f.path !== f.label && (
                    <span className="truncate font-mono text-[12px] text-muted-foreground/70">
                      {f.path}
                    </span>
                  )}
                </>
              ),
            }))}
          />
        )
      )}
      {!outside && data.modelChoices.length > 0 && (
        <ChipMenu
          title="Model"
          value={model}
          onPick={setModel}
          label={<span className="truncate">{model}</span>}
          options={data.modelChoices.map((m) => ({
            id: m,
            node: <span>{m}</span>,
          }))}
        />
      )}
    </>
  );

  return (
    <Page>
      <div className="flex items-center gap-3.5">
        <AgentAvatar data={data} agent={agent} size={44} className="mt-5" />
        <div className="min-w-0 flex-1">
          <Title small kicker="New chat">
            {agent.name}
          </Title>
        </div>
      </div>
      <p className="-mt-1.5 text-[13.5px] text-muted-foreground/80">
        {agent.role}
      </p>
      <p className="mt-3 text-[15px] text-muted-foreground">
        Talk to {agent.name} directly.
        {data.features.tickets && " Turn it into a ticket any time."}
      </p>

      {data.starters && data.starters.length > 0 && (
        <div className="mt-8 flex flex-wrap gap-2">
          {data.starters.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                edit(s);
                input.current?.focus();
              }}
              className="h-7 rounded-full border border-[var(--v3-line)] px-3 text-[13px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3">
        <Composer
          data={data}
          agent={agent}
          model={model}
          folder={project?.folder ?? folder?.path}
          value={draft}
          onChange={edit}
          inputRef={input}
          chips={chips}
          onSend={send}
        />
      </div>
    </Page>
  );
}
