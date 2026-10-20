import { agentNameOf, type ModelChoice, type V3Data, type V3DataActions, type V3Thread } from "@lilos/ui"
import { nowClock, runTurn } from "./chat-sim"
import { type Engine, threadPatch } from "./context"

/* What a thread's model reads as: the plain menu's label, or what the full
   picker chose (the model's name, its effort, Fast). */
function modelLabel(d: V3Data, label: string, pick?: ModelChoice): string {
  const option = d.modelCatalog?.options.find(
    (o) => o.id === pick?.model && (pick?.provider === undefined || o.provider === pick.provider),
  )
  if (!pick || !option) return label
  const effort = pick.effort ? pick.effort.charAt(0).toUpperCase() + pick.effort.slice(1) : undefined
  return [option.name ?? option.id, effort, pick.fast && "Fast"].filter(Boolean).join(" · ")
}

/* Conversations: what you say in a thread or a new chat, what you did last,
   rewinding a thread, naming it, putting it away. */
export function chatActions({ setData, getData, reply, toast }: Engine): Pick<
  V3DataActions,
  "message" | "startChat" | "markSeen" | "rewind" | "renameThread" | "archiveThread"
> {
  return {
    message: (threadId, text) => {
      const th = getData().threads.find((t) => t.id === threadId);
      if (!th) return;
      if (th.status !== "working") {
        runTurn(setData, getData, reply, th, text);
        return;
      }
      /* Mid-turn: queue on the running turn; the agent reads it after the
         current step (the simulator starts it when the turn ends). */
      const newest = Math.max(...th.turns.map((u) => u.n));
      setData((d) => ({
        ...d,
        threads: d.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                turns: t.turns.map((u) =>
                  u.n === newest
                    ? {
                        ...u,
                        queued: [...(u.queued ?? []), { at: nowClock(), text }],
                      }
                    : u,
                ),
              }
            : t,
        ),
      }));
      toast(
        `Queued · ${agentNameOf(getData(), th.agentId)} reads it after the current step`,
      );
    },
    // The access the chat opens on (Ask / Full access) is the engine's to
    // enforce; the mock agent runs the same script either way.
    startChat: ({ agentId, projectId, folder, model, pick, text, files }) => {
      const project = getData().projects.find((p) => p.id === projectId);
      // A message of files alone is named by them.
      const said = text || (files ?? []).map((f) => f.name).join(", ");
      const chat: V3Thread = {
        id: `t-chat-${Date.now().toString(36)}`,
        projectId,
        agentId,
        title: said.length > 56 ? `${said.slice(0, 54).trimEnd()}…` : said,
        status: "working",
        startedAt: nowClock(),
        minutes: 0,
        step: 0,
        context: 2,
        model: modelLabel(getData(), model, pick),
        folder: project?.folder ?? folder ?? "~",
        changes: [],
        turns: [],
      };
      // The next chat with this agent starts where this one ran, and ↑ in its
      // empty box brings this message back.
      setData((d) => ({
        ...d,
        threads: [chat, ...d.threads],
        agents: d.agents.map((a) =>
          a.id === agentId ? { ...a, lastChat: { folder: project?.folder ?? folder, ...(text ? { opener: text } : {}) } } : a,
        ),
      }));
      runTurn(setData, getData, reply, chat, text, files);
      // The draft that sent it decides where the thread shows (it takes the
      // draft's place on the trail), so this does not navigate.
      return Promise.resolve(chat.id);
    },
    markSeen: (threadId) => {
      setData((d) => ({
        ...d,
        threads: threadPatch(d, (t) => t.id === threadId, { unseen: false }),
      }));
    },
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
  }
}
