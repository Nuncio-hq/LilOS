import { useEffect, useMemo, useRef, useState } from "react";
import { AccessPill } from "../chat/access-pill";
import { clearDraftIfSent, draftKey, useDraft } from "../lib/drafts";
import type { AttachedFile, ConversationAccess, ModelChoice } from "../types";
import { readStaged, useAttach } from "./v3-attach";
import { Page, Title } from "./v3-bits";
import { ChipMenu } from "./v3-chip-menu";
import { Composer } from "./v3-composer";
import type { V3Data } from "./v3-data-types";
import { ModelChip, NO_PROJECT, ProjectChip } from "./v3-draft-chips";
import { AgentAvatar, CeoMark } from "./v3-marks";
import { agentOf, defaultAgent, projectOf, ticketOf } from "./v3-model";
import type { V3PageProps } from "./v3-page-types";
import type { V3Agent } from "./v3-types";

/* A new chat, opened like any record in the side peek: you already chose who
   (from their page, or the CEO from Threads), so there is no picker, only a
   box to write in. Who, where and which model sit as quiet chips under the
   text and open a tiny menu to change. Sending starts a thread with no ticket
   and takes the draft's place on the trail; "Make it a ticket" comes later.
   The models on offer are the app's (`modelChoices`); where it works is a
   project (D-#771), or no project at all (a chat that only talks), and a
   folder the company has no project for yet becomes one from the same menu.
   This box is the first-message composer, so it keeps what the old home
   composer had, each only where the app can do it: files on the first message
   (paste, drop, paperclip), the draft kept per agent across reloads, ↑ for
   your last opener, `@` for people and files of the folder, `/` for the
   engine's commands, the full model picker and the Ask / Full access pill. */

/** Where this agent's chats usually go. Where its last one ran: a plain chat
    counts, since "No project" is a choice that must not slide back to a
    project on its own. With no chat yet, the project of its most recent thread
    (a chat names its project; a ticket's hand uses the ticket's), else the
    first project. Start times are zero-padded clocks, so text order is time. */
function usualProject(data: V3Data, agent: V3Agent): string {
  if (agent.lastChat) {
    const last = agent.lastChat.projectId;
    return last && projectOf(data, last) ? last : NO_PROJECT;
  }
  let best: { at: string; project: string } | undefined;
  for (const t of data.threads) {
    if (t.agentId !== agent.id) continue;
    const project =
      t.projectId ?? (t.ticketId ? ticketOf(data, t.ticketId)?.projectId : "");
    if (!project || !projectOf(data, project)) continue;
    if (!best || t.startedAt > best.at) best = { at: t.startedAt, project };
  }
  return best?.project ?? data.projects[0]?.id ?? NO_PROJECT;
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
  const projectId = chosenProject ?? usualProject(data, agent);
  const project = projectOf(data, projectId);
  const [chosenModel, setModel] = useState<string>();
  // An outside worker has no model of its own: no chip, and none sent.
  const outside = agent.kind === "outside";
  const model = outside ? "" : (chosenModel ?? agent.model);
  /* What the full picker chose (model, effort, Fast) and the access pill's
     level, each held per agent as the old home composer held them: they are
     for the chat being written, not settings, and switching the agent chip
     must not carry one agent's over to another. Unset = the agent's own model
     on its default effort, and Settings' default access. */
  const [picks, setPicks] = useState<Record<string, ModelChoice>>({});
  const pick = picks[agent.id];
  const [pickOpen, setPickOpen] = useState(false);
  const [accesses, setAccesses] = useState<Record<string, ConversationAccess>>(
    {},
  );
  const access = accesses[agent.id] ?? data.settings.approvals;
  /* The text is kept per agent, in the same store the thread composers use,
     so a reload or a trip to another page leaves it where it was. */
  const [draft, setDraft] = useDraft(draftKey.dm(agent.id));
  const input = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  // Absent where the app sends no files: no paperclip, nothing to paste into.
  const attach = useAttach(data.attachLimits);

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
  /* `@` and `/` read the folder the chat will run in (its project's); without
     one there are no files to offer. Stable identities: the menus search when
     they change. */
  const searchFiles = act.searchFiles;
  const searchCommands = act.searchCommands;
  const folderPathNow = project?.folder;
  const onSearchFiles = useMemo(
    () =>
      searchFiles && folderPathNow
        ? (q: string) => searchFiles(folderPathNow, q)
        : undefined,
    [searchFiles, folderPathNow],
  );
  const onSearchCommands = useMemo(
    () =>
      searchCommands
        ? (q: string) =>
            searchCommands(
              {
                agentId: agent.id,
                ...(folderPathNow ? { folder: folderPathNow } : {}),
              },
              q,
            )
        : undefined,
    [searchCommands, agent.id, folderPathNow],
  );
  async function send(text: string) {
    if (sending.current) return;
    sending.current = true;
    try {
      // The chips stay until the chat has started: a refused send keeps them.
      let files: AttachedFile[] = [];
      try {
        files = await readStaged(attach?.files ?? []);
      } catch {
        attach?.warn(
          "A file couldn't be read — nothing was sent. Re-attach it.",
        );
        return;
      }
      const thread = await act.startChat({
        agentId: agent.id,
        // The relay files the thread from the folder it is sent (D-#771);
        // a plain chat sends none.
        projectId: project?.id,
        folder: project?.folder,
        model,
        ...(pick && !outside ? { pick } : {}),
        ...(data.chatAccess ? { access } : {}),
        text,
        ...(files.length ? { files } : {}),
      });
      if (thread === undefined) return;
      clearDraftIfSent(draftKey.dm(agent.id), text);
      setDraft("");
      attach?.clear();
      go({ page: "thread", id: thread });
    } finally {
      sending.current = false;
    }
  }

  /* The commands the app owns: `/model` opens the picker this box already
     has (and is only claimed when it has one). Everything else posts and the
     engine runs it. */
  const onCommand = (name: string) => {
    if (name !== "model" || !data.modelCatalog || outside) return false;
    setPickOpen(true);
    return true;
  };

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
            {agent.id === data.ceoId && <CeoMark />}
          </>
        }
        options={data.agents.map((a) => ({
          id: a.id,
          node: (
            <>
              <AgentAvatar data={data} agent={a} size={18} />
              <span className="shrink-0">{a.name}</span>
              {a.id === data.ceoId && <CeoMark />}
              <span className="truncate text-[12.5px] text-muted-foreground/70">
                {a.role}
              </span>
            </>
          ),
        }))}
      />
      <ProjectChip
        projects={data.projects}
        project={project}
        folder={project && data.folders?.find((f) => f.path === project.folder)}
        onPick={setProject}
        onNew={act.newProject && (() => act.newProject?.(setProject))}
      />
      {!outside && (
        <ModelChip
          data={data}
          act={act}
          agentModelId={agent.modelId}
          pick={pick}
          onPick={(c) => setPicks((p) => ({ ...p, [agent.id]: c }))}
          label={model}
          onLabel={setModel}
          open={pickOpen}
          onOpen={setPickOpen}
        />
      )}
      {data.chatAccess && (
        <AccessPill
          access={access}
          onAccess={(a) => setAccesses((m) => ({ ...m, [agent.id]: a }))}
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
            {agent.id === data.ceoId && (
              <CeoMark className="ml-2.5 align-middle" />
            )}
          </Title>
        </div>
      </div>
      <p className="-mt-1.5 text-[13.5px] text-muted-foreground/80">
        {agent.role}
      </p>
      <p className="mt-3 text-[15px] text-muted-foreground">
        Talk to {agent.name} directly.
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
          folder={project?.folder}
          value={draft}
          onChange={edit}
          inputRef={input}
          chips={chips}
          attach={attach}
          lastSent={agent.lastChat?.opener}
          people={data.agents}
          onSearchFiles={onSearchFiles}
          onSearchCommands={onSearchCommands}
          onCommand={onCommand}
          onSend={send}
        />
      </div>
    </Page>
  );
}
