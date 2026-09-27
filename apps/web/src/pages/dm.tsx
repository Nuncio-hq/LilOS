import {
  type ChannelMessagesState,
  type SessionFeedState,
  type SessionModel,
  toStatusComponents,
} from "@lilos/client-runtime";
import type { AppMessage, Ask, Conversation } from "@lilos/contracts/app";
import type { ApprovalOutcome } from "@lilos/contracts/engine";
import { EditEmployeeDialog, EmployeeHome, NO_WS, ThreadView } from "@lilos/ui";
import type { Channel, Msg, Reply, Thread } from "@lilos/ui/types";
import { useNavigate, useParams } from "@tanstack/react-router";
import { atom } from "nanostores";
import { useEffect, useMemo, useState } from "react";
import {
  archiveConversation,
  clearPending,
  hasCapability,
  interruptSession,
  pendingStart,
  renameConversation,
  respondToRequest,
  sendDm,
  setConversationModel,
} from "../lib/actions";
import { removeEmployee, saveEmployee } from "../lib/employees";
import { useAtom } from "../lib/hooks";
import {
  conversationReplies,
  mergeTurns,
  toFeed,
  toUiEmployee,
} from "../lib/mapping";
import { humanFor, ME } from "../lib/me";
import {
  asks as asksAtom,
  engine,
  engineModels,
  navOpen,
  relay,
  sessionModels,
} from "../lib/runtime";

const EMPTY_MESSAGES = atom<ChannelMessagesState>({
  channelId: "",
  synced: true,
  lastSeq: 0,
  messages: [],
});

const EMPTY_FEED = atom<SessionFeedState>({
  sessionId: "",
  synced: false,
  latestSeq: 0,
  events: [],
  openRequests: [],
});

const OUTCOME_LABEL: Record<ApprovalOutcome, string> = {
  once: `Allowed once by ${ME.name}`,
  always: "Always allowed here",
  deny: `Denied by ${ME.name}`,
  cancel: "Cancelled",
  answer: "Answered",
};

function outcomeFromLabel(v: string): ApprovalOutcome {
  if (v.startsWith("Denied")) return "deny";
  if (v.startsWith("Always")) return "always";
  if (v.startsWith("Cancelled")) return "cancel";
  if (v.startsWith("Answered")) return "answer";
  return "once";
}

/* User messages render as the signed-in human — the same `ME` the sidebar
   footer shows (issue #80, AC-1). */
const human = humanFor;

/**
 * `/dm/$employeeId(/$conversationId)` — the DM home: session list + composer
 * (EmployeeHome) and, when a session is open, the thread panel (ThreadView).
 * Data: relay messages + conversations; live turn overlay from the engine
 * feed keyed by conversation.engineRef.
 */
export function DmPage() {
  const { employeeId, conversationId } = useParams({ strict: false }) as {
    employeeId: string;
    conversationId?: string;
  };
  const navigate = useNavigate();

  const employees = useAtom(relay.employees);
  const channels = useAtom(relay.channels);
  const summaries = useAtom(relay.conversationSummaries);
  const models = useAtom(sessionModels);
  const catalog = useAtom(engineModels);
  const allAsks = useAtom(asksAtom);
  const pending = useAtom(pendingStart);
  const engineState = useAtom(engine.state);
  const statusPoll = useAtom(relay.status);
  const fatal = useAtom(relay.fatal);
  const [profileOpen, setProfileOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  /* AC-2 (#85): an engine that's down (Hermes missing, crashed out) shows
     its plain reason above the composer — never silently sendable. */
  const engineRow = useMemo(
    () =>
      toStatusComponents({
        result: statusPoll.result,
        connection: "ready",
        fatal,
      }).find((c) => c.id === "engine"),
    [statusPoll, fatal],
  );
  const engineDown = engineRow?.state === "down";
  const composerNote =
    engineDown && engineRow?.reason
      ? engineRow.hint
        ? `${engineRow.reason} ${engineRow.hint}`
        : engineRow.reason
      : undefined;

  const employee = employees.find((e) => e.id === employeeId);
  const channel = channels.find(
    (c) => c.kind === "dm" && c.employeeId === employeeId,
  );
  const msgState = useAtom(
    channel ? relay.channelMessages(channel.id) : EMPTY_MESSAGES,
  );
  const messages: AppMessage[] = msgState.messages;

  /* DM conversations for this employee — backed by the summaries endpoint so
     rows older than the channel snapshot window still list (#28 AC-1). */
  const convs = useMemo(
    () =>
      summaries
        .map((s) => s.conversation)
        .filter((c) => channel && c.channelId === channel.id)
        .sort((a, b) => a.createdAt - b.createdAt),
    [summaries, channel],
  );
  const openConv = convs.find((c) => c.id === conversationId);

  /* The open thread needs its whole visible history, not just the channel
     window (#28 AC-2): page messages.list scoped to the conversation. */
  const channelId = channel?.id;
  const [threadMsgs, setThreadMsgs] = useState<AppMessage[]>([]);
  useEffect(() => {
    setThreadMsgs([]);
    if (!conversationId || !channelId) return;
    let dead = false;
    void (async () => {
      const all: AppMessage[] = [];
      for (;;) {
        const page = await relay.request<{
          messages: AppMessage[];
        }>("messages.list", {
          channelId,
          conversationId,
          afterSeq: all.at(-1)?.seq ?? 0,
          limit: 200,
        });
        all.push(...page.messages);
        if (page.messages.length < 200) break;
      }
      if (!dead) setThreadMsgs(all);
    })().catch(() => {});
    return () => {
      dead = true;
    };
  }, [conversationId, channelId]);

  /* Fetched history + live arrivals, deduped by id. */
  const threadPool = useMemo(() => {
    const seen = new Set<string>();
    const out: AppMessage[] = [];
    for (const m of [...threadMsgs, ...messages]) {
      if (m.conversationId !== openConv?.id || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
    return out;
  }, [threadMsgs, messages, openConv?.id]);

  const openFeed = useAtom(
    openConv?.engineRef ? engine.sessionFeed(openConv.engineRef) : EMPTY_FEED,
  );

  const uiEmp = employee ? toUiEmployee(employee, engineDown) : undefined;
  const empFn = (id: string) => {
    const e = employees.find((x) => x.id === id);
    return e ? toUiEmployee(e, engineDown) : undefined;
  };

  const summaryOf = (conv: Conversation) =>
    summaries.find((s) => s.conversation.id === conv.id);

  /* Replies for a list row: real messages inside the snapshot window, padded
     to the summary's count with the answer preview on top when it isn't. */
  const repliesOf = (conv: Conversation): Reply[] => {
    const s = summaryOf(conv);
    const want = s ? s.messageCount - 1 : undefined;
    const known = conversationReplies(
      (conv.id === conversationId ? threadPool : messages).filter(
        (m) => m.conversationId === conv.id && m.id !== conv.rootMessageId,
      ),
      conv.id,
    );
    if (want === undefined || known.length >= want) return known;
    const out = [...known];
    if (s?.firstAnswer && !out.some((r) => r.id === s.firstAnswer?.id)) {
      const [preview] = conversationReplies([s.firstAnswer], conv.id);
      if (preview) out.unshift(preview);
    }
    while (out.length < want)
      out.push({
        id: `history-${conv.id}-${out.length}`,
        from: "user",
        time: "",
        text: "",
      });
    return out;
  };

  const modelFor = (conv: Conversation): SessionModel | undefined =>
    conv.engineRef ? models[conv.engineRef] : undefined;

  const convAsks = (conv: Conversation): Ask[] =>
    allAsks.filter((a) => a.conversationId === conv.id);

  const feed: Msg[] = convs.flatMap((conv) => {
    const root =
      summaryOf(conv)?.root ??
      messages.find((m) => m.id === conv.rootMessageId);
    if (!root) return [];
    const model = modelFor(conv);
    return [
      toFeed(
        root,
        conv,
        mergeTurns(repliesOf(conv), model, employeeId, convAsks(conv)),
      ),
    ];
  });

  // "submitted" marker clears once the engine turn is actually running.
  const openModel = openConv?.engineRef
    ? models[openConv.engineRef]
    : undefined;
  useEffect(() => {
    if (openConv && openModel?.live) clearPending(openConv.id);
  }, [openConv, openModel]);

  if (!employee || !uiEmp) {
    return (
      <div className="grid min-w-0 flex-1 place-items-center text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  const uiChannel: Channel = {
    id: channel?.id ?? "",
    name: uiEmp.name,
    dm: true,
    employees: [employeeId],
  };

  const openThread = (id: string) => {
    const conv = convs.find((c) => c.rootMessageId === id);
    if (conv)
      void navigate({
        to: "/dm/$employeeId/$conversationId",
        params: { employeeId, conversationId: conv.id },
      });
  };

  const send = (text: string) => {
    void sendDm(employeeId, text).then((conv) =>
      navigate({
        to: "/dm/$employeeId/$conversationId",
        params: { employeeId, conversationId: conv.id },
      }),
    );
  };

  /* ↑ recall for the home composer: the last top-level message Oscar sent in
     this DM is the newest conversation's root message (#104 AC-5). */
  const lastSentTop = [...convs]
    .reverse()
    .map(
      (c) =>
        summaryOf(c)?.root ?? messages.find((m) => m.id === c.rootMessageId),
    )
    .find((m) => m?.authorKind === "user")?.text;

  /* thread panel ---------------------------------------------------------- */

  let threadEl = null;
  if (openConv) {
    const conv = openConv;
    const model = modelFor(conv);
    const root =
      threadPool.find((m) => m.id === conv.rootMessageId) ??
      summaryOf(conv)?.root;
    const modelLive = model?.live;
    const asksHere = convAsks(conv);
    /* Visible messages are the relay's; the working transcript is the engine
       feed's — when it can't replay, say why instead of going silent (#28). */
    const transcriptNote =
      conv.engineRef && (!openFeed.synced || openFeed.error)
        ? `Working transcript unavailable — ${
            openFeed.error ??
            (engineState !== "ready"
              ? "the engine feed is disconnected (harness down or restarting)"
              : "still syncing")
          }`
        : undefined;

    const resolved: Record<string, string> = {};
    for (const a of asksHere) {
      if (a.state === "resolved" && a.outcome)
        resolved[a.id] = OUTCOME_LABEL[a.outcome];
    }
    const engineRef = conv.engineRef;
    const replies = mergeTurns(
      conversationReplies(
        threadPool.filter((m) => m.id !== conv.rootMessageId),
        conv.id,
      ),
      model,
      employeeId,
      asksHere,
    );
    // An open question ask gets a real answer card (asks.respond).
    const openQuestion = asksHere.find(
      (a) => a.state === "open" && a.request.kind === "question",
    );

    const thread: Thread = {
      session: engineRef?.slice(0, 8) ?? conv.id.slice(0, 8),
      title: conv.title ?? undefined,
      archived: conv.archived,
      replies,
      usage: model?.turns.at(-1)?.usage as Thread["usage"],
      model: conv.model ?? model?.model,
    };
    const running = !!modelLive || pending[conv.id] === true;
    /* ↑ recall in the open session: Oscar's last sent message in it — the
       root counts too (#104 AC-5). */
    const lastSent = threadPool.reduce<AppMessage | undefined>(
      (last, m) =>
        m.authorKind === "user" && (!last || m.seq > last.seq) ? m : last,
      undefined,
    )?.text;
    const steer = hasCapability("steer");
    const rootMsg: Msg = root
      ? {
          kind: "msg",
          id: root.id,
          from: root.authorId,
          time: new Date(root.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          text: root.text,
          thread,
        }
      : { kind: "msg", id: conv.id, from: "user", time: "", text: "", thread };

    threadEl = (
      <div className="flex min-h-0 w-[420px] shrink-0 flex-col border-l xl:w-[460px]">
        <ThreadView
          root={rootMsg}
          thread={thread}
          channel={uiChannel}
          emp={empFn}
          human={human}
          resolved={resolved}
          setResolved={(r) => {
            // reply cards report {askId: label}; map label -> outcome
            const diff = Object.entries(r).find(([k, v]) => resolved[k] !== v);
            if (diff) {
              void respondToRequest(diff[0], outcomeFromLabel(diff[1]));
            }
          }}
          running={running}
          steer={steer}
          transcriptNote={transcriptNote}
          models={catalog.length ? catalog : undefined}
          onModel={(c) => void setConversationModel(conv.id, c.model)}
          onSend={(text) => void sendDm(employeeId, text, conv.id)}
          onStop={running ? () => void interruptSession(conv.id) : undefined}
          lastSent={lastSent}
          onFocus={undefined}
          work={null}
        />
        {openQuestion && (
          <QuestionCard
            ask={openQuestion}
            onAnswer={(answer) =>
              void respondToRequest(openQuestion.id, "answer", answer)
            }
            onCancel={() => void respondToRequest(openQuestion.id, "cancel")}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <EmployeeHome
        e={uiEmp}
        feed={feed}
        threadId={openConv?.rootMessageId ?? null}
        emp={empFn}
        human={human}
        onNav={() => navOpen.set(true)}
        onProfile={() => setProfileOpen((v) => !v)}
        onOpen={openThread}
        onSend={send}
        lastSent={lastSentTop}
        panelOpen={!!openConv}
        onPanel={() => {
          const last = convs.at(-1);
          if (last)
            void navigate({
              to: "/dm/$employeeId/$conversationId",
              params: { employeeId, conversationId: last.id },
            });
        }}
        folders={[]}
        pick={NO_WS}
        setPick={() => {}}
        loading={!channel}
        composerNote={composerNote}
        onRename={(id, title) => {
          const conv = convs.find((c) => c.rootMessageId === id);
          if (conv) void renameConversation(conv.id, title);
        }}
        onArchive={(id, archived) => {
          const conv = convs.find((c) => c.rootMessageId === id);
          if (conv) void archiveConversation(conv.id, archived);
        }}
      />
      {threadEl}
      {profileOpen && !editOpen && (
        <EmployeeProfileCard
          name={uiEmp.name}
          profile={uiEmp.profile}
          model={uiEmp.model}
          instructions={uiEmp.instructions}
          onEdit={() => {
            setEditError(null);
            setEditOpen(true);
          }}
          onClose={() => setProfileOpen(false)}
        />
      )}
      {editOpen && (
        <EditEmployeeDialog
          e={uiEmp}
          error={editError ?? undefined}
          onClose={() => setEditOpen(false)}
          onSave={(name, role) => {
            void saveEmployee(employee.id, name, role)
              .then(() => setEditOpen(false))
              .catch((e) =>
                setEditError(e instanceof Error ? e.message : String(e)),
              );
          }}
          onRemove={() => {
            void removeEmployee(employee.id)
              .then(() => {
                setEditOpen(false);
                setProfileOpen(false);
                void navigate({ to: "/" });
              })
              .catch((e) =>
                setEditError(e instanceof Error ? e.message : String(e)),
              );
          }}
        />
      )}
    </div>
  );
}

function QuestionCard({
  ask,
  onAnswer,
  onCancel,
}: {
  ask: Ask;
  onAnswer: (answer: string) => void;
  onCancel: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const q = ask.request;
  if (q.kind !== "question") return null;
  const options = q.options ?? [];
  return (
    <div
      data-question-card
      className="border-t bg-amber-50/60 p-3 text-xs dark:bg-amber-950/20"
    >
      <div className="font-medium text-foreground">{q.question}</div>
      {options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              title={o.description}
              className="rounded-md border px-2 py-1 hover:bg-muted"
              onClick={() => onAnswer(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      {(options.length === 0 || q.freeText) && (
        <input
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && answer.trim()) onAnswer(answer.trim());
          }}
          placeholder="Type an answer…"
          className="mt-2 w-full rounded-md border bg-background px-2 py-1"
        />
      )}
      <div className="mt-2 flex gap-1.5">
        {(options.length === 0 || q.freeText) && (
          <button
            type="button"
            className="rounded-md bg-foreground px-2 py-1 text-background"
            onClick={() => answer.trim() && onAnswer(answer.trim())}
          >
            Answer
          </button>
        )}
        <button
          type="button"
          className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function EmployeeProfileCard({
  name,
  profile,
  model,
  instructions,
  onEdit,
  onClose,
}: {
  name: string;
  profile: string;
  model: string;
  instructions: string;
  onEdit: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/60 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${name} profile`}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        className="w-full max-w-sm rounded-xl border bg-background p-5 shadow-2xl"
      >
        <div className="font-semibold">{name}</div>
        <dl className="mt-3 space-y-1.5 text-xs">
          <div className="flex gap-2">
            <dt className="w-20 text-muted-foreground">Profile</dt>
            <dd className="font-mono">{profile}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 text-muted-foreground">Model</dt>
            <dd className="font-mono">{model || "engine default"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 text-muted-foreground">Soul</dt>
            <dd className="min-w-0 flex-1">{instructions || "—"}</dd>
          </div>
        </dl>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className="flex-1 rounded-md bg-foreground px-2 py-1.5 text-background text-sm"
            onClick={onEdit}
          >
            Edit
          </button>
          <button
            type="button"
            className="flex-1 rounded-md border px-2 py-1.5 text-sm hover:bg-muted"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
