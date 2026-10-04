import {
  type ChannelMessagesState,
  type SessionFeedState,
  type SessionModel,
  toStatusComponents,
  waitingMessages,
} from "@lilos/client-runtime";
import type {
  AppMessage,
  Ask,
  Conversation,
  ConversationsRewindResult,
  MessageSearchHit,
} from "@lilos/contracts/app";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@lilos/contracts/app";
import type {
  AgentDescriptor,
  ApprovalOutcome,
  ConversationAccess,
  Job,
} from "@lilos/contracts/engine";
import {
  AddFolderDialog,
  choiceFor,
  clearDraftIfSent,
  draftKey,
  EditEmployeeDialog,
  EmployeeHome,
  FocusView,
  NO_WS,
  type PlanAction,
  StatusBanner,
  ThreadView,
  useDraft,
} from "@lilos/ui";
import type {
  AttachedFile,
  BackgroundJob,
  Channel,
  FileMention,
  MessageHit,
  ModelChoice,
  ModelOption,
  ModelPickerExtras,
  Msg,
  Reply,
  Thread,
  WbTab,
  Work,
  WsPick,
} from "@lilos/ui/types";
import {
  Link,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { atom } from "nanostores";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  archiveConversation,
  clearPending,
  hasCapability,
  interruptSession,
  openDmChannel,
  pendingStart,
  refreshModels,
  renameConversation,
  respondToRequest,
  sendDm,
  setConversationAccess,
  setConversationModel,
  setModelVisibility,
} from "../lib/actions";
import {
  attachmentUrls,
  ensureAttachments,
  hydrateAttachments,
  toAttachedFiles,
} from "../lib/attachments";
import { requestConnect } from "../lib/connect";
import { removeEmployee, saveEmployee } from "../lib/employees";
import { parseFocusTab } from "../lib/focus-search";
import {
  addFolder,
  cwdInfo,
  discovered,
  folders,
  fsRows,
  loadDir,
  loadDiscovered,
  refreshFolders,
  sameFolder,
  wsFor,
} from "../lib/folders";
import { useAtom } from "../lib/hooks";
import {
  hostAccessors,
  hostEditors,
  hostOsOpen,
  hostSearch,
  type OsEditor,
} from "../lib/host";
import {
  conversationReplies,
  formatUptime,
  mergeTurns,
  stripPlans,
  threadUsage,
  toFeed,
  toJob,
  toUiEmployee,
} from "../lib/mapping";
import { currentName, humanFor, osFullName, osHome, profile } from "../lib/me";
import {
  asks as asksAtom,
  engine,
  engineDefaultModel,
  engineDefaultProvider,
  engineModels,
  engineProviders,
  modelVisibility,
  navOpen,
  relay,
  sessionFeedAttached,
  sessionModels,
  workbenchRequests,
} from "../lib/runtime";
import { say } from "../lib/toast";
import { defaultAccess } from "../settings/state";

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
  coverageSeq: 0,
  events: [],
  openRequests: [],
});

/* #180 AC-4: Change… prefills the composer with this prefix; a send that
   keeps it answers the open plan request instead of posting a message. */
const PLAN_CHANGE_PREFIX = "Change the plan: ";

/* Resolved-ask labels carry the signed-in human's name — computed per render
   so a settings change lands without a reload (#118). */
const outcomeLabel = (o: ApprovalOutcome, name: string): string => {
  switch (o) {
    case "once":
      return `Allowed once by ${name}`;
    /* #106: "This session" — the grant lives until the conversation's
       session ends; only this thread stopped asking. */
    case "session":
      return `Allowed this session by ${name}`;
    case "always":
      return "Always allowed here";
    case "deny":
      return `Denied by ${name}`;
    case "cancel":
      return "Cancelled";
    case "answer":
      return "Answered";
    /* #180: plan requests resolve to these; labels match the card wording. */
    case "approve":
      return `Approved by ${name}`;
    case "reject":
      return `Rejected by ${name}`;
    case "change":
      return `Change requested by ${name}`;
  }
};

function outcomeFromLabel(v: string): ApprovalOutcome {
  if (v.startsWith("Denied")) return "deny";
  if (v.startsWith("Always")) return "always";
  /* #106: the card's resolved label for the session-scoped grant. */
  if (v.startsWith("Allowed this session")) return "session";
  if (v.startsWith("Cancelled")) return "cancel";
  if (v.startsWith("Answered")) return "answer";
  return "once";
}

/* User messages render as the signed-in human — the same identity the
   sidebar footer shows (issue #80 AC-1, #118: relay-owned). */
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
  /* `/dm/$e/$c/focus` renders the session in Focus instead of the panel
     (#114) — the route carries it, so reload stays in Focus. `?tab=` names
     the Workbench tab it opens on (#319 AC-2). */
  const focusOpen = useRouterState({
    select: (s) => s.location.pathname.endsWith("/focus"),
  });
  const focusTab = useRouterState({
    select: (s) => parseFocusTab(s.location.search),
  });

  const employees = useAtom(relay.employees);
  const channels = useAtom(relay.channels);
  const directoryReady = useAtom(relay.directoryReady);
  // #118: the human's name/avatar re-render live on a settings change.
  useAtom(profile);
  useAtom(osFullName);
  const home = useAtom(osHome);
  const summaries = useAtom(relay.conversationSummaries);
  const models = useAtom(sessionModels);
  const catalog = useAtom(engineModels);
  const defaultModel = useAtom(engineDefaultModel);
  const defaultProvider = useAtom(engineDefaultProvider);
  const providers = useAtom(engineProviders);
  const visibility = useAtom(modelVisibility);
  const description = useAtom(engine.description);
  const allAsks = useAtom(asksAtom);
  const pending = useAtom(pendingStart);
  const engineState = useAtom(engine.state);
  const statusPoll = useAtom(relay.status);
  const fatal = useAtom(relay.fatal);
  const [profileOpen, setProfileOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  /* The picker's pick for a session that doesn't exist yet (#92 AC-5): held
     per employee, stamped on `conversations.open`, cleared once sent. */
  const [draftPick, setDraftPick] = useState<Record<string, ModelChoice>>({});
  /* #106 AC-1/AC-3: the pill's level for a session that doesn't exist yet —
     seeded from Settings' defaultAccess (never the last-used level), stamped
     on `conversations.open`, cleared once sent. */
  const [draftAccess, setDraftAccess] = useState<
    Record<string, ConversationAccess>
  >({});

  /* Picker extras (#92): Edit models rides the relay-persisted visibility
     list; Refresh renders only when the engine's `models` capability
     declares `refreshable` (D-#19 — no control without a handler). */
  const picker = useMemo<ModelPickerExtras | undefined>(() => {
    if (!catalog.length) return undefined;
    const detail = description?.capabilities.find((c) => c.id === "models")
      ?.detail as { refreshable?: boolean } | undefined;
    return {
      providers: providers.length
        ? providers.map((p) => ({ id: p.id, name: p.name ?? p.id }))
        : undefined,
      visibility,
      onVisibility: (v) => void setModelVisibility(v),
      ...(detail?.refreshable === true ? { onRefresh: refreshModels } : {}),
    };
  }, [catalog, providers, visibility, description]);

  /* Folder picking (#113): shared recents from the relay (probed live for
     missing/git) + a per-employee pick (its last session's folder, AC-6).
     Direct mode only — the picker gets no onWorktree (AC-3).
     `git.discoverRepos` stays lazy: it runs when the Add-folder dialog
     opens, never on DM mount. */
  const folderRows = useAtom(folders);
  const fsListing = useAtom(fsRows);
  const discoveredRows = useAtom(discovered);
  const cwdBranches = useAtom(cwdInfo);
  const [wsPicks, setWsPicks] = useState<Record<string, WsPick>>({});
  const [addFolderOpen, setAddFolderOpen] = useState(false);
  useEffect(() => {
    void refreshFolders().catch(() => {});
  }, []);

  /* Image attachments (#112): the composers offer pick/drop/paste only when
     the engine declares `image_prompt` (D-#19); thumbnails resolve lazily
     from the relay store, so subscribe to the resolved-URL cache. */
  const canAttachImages =
    description?.capabilities.some((c) => c.id === "image_prompt") ?? false;
  /* Profile fields the engine lets LilOS write (#123): the `agents`
     capability's `detail.updatable` list — the Edit dialog renders exactly
     these engine fields (D-#19). */
  const updatable = useMemo(() => {
    const u = description?.capabilities.find((c) => c.id === "agents")?.detail
      ?.updatable;
    return Array.isArray(u)
      ? u.filter((x): x is string => typeof x === "string")
      : [];
  }, [description]);
  /* Live `agents.describe` for the employee being edited — the dialog's
     engine fields prefill from it (undefined until fetched, null = engine
     unreachable → record-only edit). */
  const [editAgent, setEditAgent] = useState<
    AgentDescriptor | null | undefined
  >(undefined);
  useAtom(attachmentUrls);

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
  /* #339: the harness's connect row for this employee's profile — absent
     on engines without Connect support (no `connect` on system.status). */
  const employeeRow = employee?.profile
    ? statusPoll.result?.connect?.find((r) => r.profile === employee.profile)
    : undefined;

  /* #193: an employee hired without a DM channel (relay-side
     `employees.create`, pre-fix first-run hires) hung on the session
     skeleton forever — `!channel` read as "still loading". Once the
     directory confirms the channel is really absent the page opens it
     itself (`channels.openDm` is idempotent server-side); the skeleton
     lasts only until the channel lands, and a failed open settles into the
     empty state instead of spinning. */
  const dmOpenTried = useRef<Record<string, true>>({});
  const [dmOpenFailed, setDmOpenFailed] = useState(false);
  useEffect(() => {
    if (!directoryReady || !employee || channel || dmOpenFailed) return;
    if (dmOpenTried.current[employeeId]) return;
    dmOpenTried.current[employeeId] = true;
    openDmChannel(employeeId).catch(() => setDmOpenFailed(true));
  }, [directoryReady, employee, channel, dmOpenFailed, employeeId]);
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

  /* #340 AC-2b: the session's `workbench_open` opens the Workbench — Focus
     carries it, so a spot for another view navigates there first; the
     open-conversation's newest spot feeds the panel itself. */
  const wbSpots = useAtom(workbenchRequests);
  const wbSpot = conversationId ? wbSpots[conversationId] : undefined;
  useEffect(() => {
    if (!wbSpot || !conversationId || focusOpen) return;
    void navigate({
      to: "/dm/$employeeId/$conversationId/focus",
      params: { employeeId, conversationId },
    });
  }, [wbSpot, conversationId, focusOpen, navigate, employeeId]);

  /* #138: full-text message search behind the session filter. Wire hits are
     conversation-scoped; the box groups by the session's root message id, so
     map conversationId → rootMessageId. Archived sessions are searched too —
     their hits carry the marker (AC-4). */
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  const searchMessages = useCallback(
    async (query: string): Promise<MessageHit[]> => {
      if (!channel?.id) return [];
      const res = await relay.request<{ hits: MessageSearchHit[] }>(
        "messages.search",
        { query, channelId: channel.id, includeArchived: true, limit: 50 },
      );
      return res.hits.flatMap((h) => {
        const conv = convs.find((c) => c.id === h.conversationId);
        if (h.conversationId && !conv) return [];
        return [
          {
            rootId: conv?.rootMessageId ?? h.messageId,
            messageId: h.messageId,
            from: h.authorId,
            time: new Date(h.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }),
            snippet: h.snippet,
            archived: conv?.archived,
          },
        ];
      });
    },
    [channel?.id, convs],
  );

  /* Open-in-editor affordance for the session header (issue #110): editors
     the host detected — `null` while unknown or when os.open isn't on this
     host (the badge menu hides entirely then, D-#19); `[]` means os.open
     works but no editor was found (Reveal in Finder only). */
  const openCwd = openConv?.cwd;
  const [editors, setEditors] = useState<OsEditor[] | null>(null);
  useEffect(() => {
    let off = false;
    setEditors(null);
    if (openCwd)
      void hostEditors().then((e) => {
        if (!off) setEditors(e);
      });
    return () => {
      off = true;
    };
  }, [openCwd]);

  /* Unsent drafts live outside the composer: one key per conversation and
     one per employee home (issue #103). Switching sessions or employees — or
     reloading — swaps in the stored text instead of throwing it away. */
  const [homeDraft, setHomeDraft] = useDraft(draftKey.dm(employeeId));
  const [threadDraft, setThreadDraft] = useDraft(
    openConv ? draftKey.thread(openConv.id) : undefined,
  );

  /* #134: rewound message attachments reseeded into the composer (AC-4),
     and the files-only banner after a transport that can't rewind the
     agent's memory (AC-3) — cleared when the open session changes. */
  const [seedFiles, setSeedFiles] = useState<AttachedFile[] | undefined>();
  const [filesOnly, setFilesOnly] = useState<{
    conversationId: string;
    target: AppMessage;
    filesRestored: boolean;
  } | null>(null);
  /* Both clear when the open session changes — the render-time reset keeps
     them from leaking into the next thread. */
  /* Ids of the open conversation's rewound messages — a feed turn prompted
     by one (its `ref`) must not resurrect via mergeTurns' unmatched-append
     (#134). The event's removedIds cover live rewinds; this covers the
     fetched history and the window before the event lands. `texts` holds
     the dropped employee answers for turns the engine never tagged with a
     `ref` (steer-pumped turns on engines that don't echo it). */
  const [localRewoundIds, setLocalRewoundIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [localRewoundTexts, setLocalRewoundTexts] = useState<
    ReadonlySet<string>
  >(new Set());
  const [seedConv, setSeedConv] = useState<string | undefined>();
  /* Only a different open conversation resets — a transient `undefined`
     while summaries refetch (e.g. right after conversation.rewound) must
     not clobber a composer seed that's mid-flight. */
  if (openConv && openConv.id !== seedConv) {
    setSeedConv(openConv.id);
    setSeedFiles(undefined);
    setFilesOnly(null);
    setLocalRewoundIds(new Set());
    setLocalRewoundTexts(new Set());
  }
  /* Latest rewind per conversation — the fetched tail is dropped
     client-side as soon as the relay emits `conversation.rewound`. */
  const rewinds = useAtom(relay.rewinds);
  /* Rewound message ids (+ answer texts) per conversation: the event's
     removedIds cover any rewound conv (feed previews included); the local
     sets cover the open one, where texts are known. */
  const rewoundInfo = useMemo(() => {
    const map = new Map<
      string,
      { refs: ReadonlySet<string>; texts?: ReadonlySet<string> }
    >();
    for (const [convId, r] of Object.entries(rewinds)) {
      map.set(convId, { refs: new Set(r.removedIds) });
    }
    if (openConv && (localRewoundIds.size || localRewoundTexts.size)) {
      const s = new Set(map.get(openConv.id)?.refs ?? []);
      for (const id of localRewoundIds) s.add(id);
      map.set(openConv.id, { refs: s, texts: localRewoundTexts });
    }
    return map;
  }, [rewinds, localRewoundIds, localRewoundTexts, openConv]);

  /* The open thread needs its whole visible history, not just the channel
     window (#28 AC-2): page messages.list scoped to the conversation. */
  const channelId = channel?.id;
  const [threadMsgs, setThreadMsgs] = useState<AppMessage[]>([]);
  useEffect(() => {
    setThreadMsgs([]);
    setLocalRewoundIds(new Set());
    setLocalRewoundTexts(new Set());
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
          includeRewound: true,
          /* #315: parked not-sent rows ride the fetch so the tray survives a
             reload (relay truth, not component state). */
          includeDropped: true,
        });
        all.push(...page.messages);
        if (page.messages.length < 200) break;
      }
      if (dead) return;
      setThreadMsgs(all.filter((m) => !m.rewound));
      const rewound = all.filter((m) => m.rewound);
      setLocalRewoundIds(new Set(rewound.map((m) => m.id)));
      setLocalRewoundTexts(
        new Set(
          rewound
            .filter((m) => m.authorKind === "employee")
            .map((m) => m.text.trim()),
        ),
      );
    })().catch(() => {});
    return () => {
      dead = true;
    };
  }, [conversationId, channelId]);

  /* Fetched history + live arrivals, deduped by id. Everything at/after the
     latest rewind point is dropped — the live atoms already lost it, this
     drops the fetched copy too (#134). */
  const openConvId = openConv?.id;
  const threadPool = useMemo(() => {
    const rewoundFrom = openConvId ? rewinds[openConvId]?.fromSeq : undefined;
    const seen = new Set<string>();
    const out: AppMessage[] = [];
    /* `threadMsgs` is a fetch-time snapshot: a rewind landing between the
       fetch and now leaves its tail rows unmarked — drop them by seq. The
       rewind note and later messages only arrive through `messages` (the
       `conversation.rewound` event already pruned that store), so the seq
       rule must not touch that source or it would hide the note.
       Live rows merge FIRST: a flag flip (`dropped`/`removed`, #315
       `message.changed`) arrives only through `messages`, and the stale
       fetch copy of the same row must never outrank it. */
    for (const m of messages) {
      if (m.conversationId !== openConvId || seen.has(m.id) || m.rewound)
        continue;
      seen.add(m.id);
      out.push(m);
    }
    for (const m of threadMsgs) {
      if (m.conversationId !== openConvId || seen.has(m.id) || m.rewound)
        continue;
      if (rewoundFrom !== undefined && m.seq >= rewoundFrom) continue;
      seen.add(m.id);
      out.push(m);
    }
    return out;
  }, [threadMsgs, messages, openConvId, rewinds]);

  const openFeed = useAtom(
    openConv?.engineRef ? engine.sessionFeed(openConv.engineRef) : EMPTY_FEED,
  );

  /* #179: the Workbench Background tab (D-#19) — `jobs.list` fills the rows
     the event stream can't carry (a job the engine started before a harness
     restart); job.* events keep it live after that. Rendered + Stop only
     when the engine declares `background_jobs`. */
  const jobsCapable = hasCapability("background_jobs");
  const [listedJobs, setListedJobs] = useState<Record<string, Job[]>>({});
  const openSid = openConv?.engineRef;
  useEffect(() => {
    if (!jobsCapable || !openSid || !openFeed.synced) return;
    let dead = false;
    relay
      .request<{ jobs: Job[] }>("jobs.list", { sessionId: openSid })
      .then((r) => {
        if (!dead) setListedJobs((prev) => ({ ...prev, [openSid]: r.jobs }));
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [jobsCapable, openSid, openFeed.synced]);

  /* A running job ticks its uptime every second. */
  const [, setJobsTick] = useState(0);
  const hasRunningJob =
    (openConv?.engineRef ? (models[openConv.engineRef]?.jobs ?? []) : []).some(
      (j) => j.status === "running",
    ) ||
    (openSid ? (listedJobs[openSid] ?? []) : []).some(
      (j) => j.status === "running",
    );
  useEffect(() => {
    if (!hasRunningJob) return;
    const t = setInterval(() => setJobsTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [hasRunningJob]);

  /* Attachment blobs behind every visible ref — channel window, open
     thread, and the summary roots/previews that feed rows render (AC-3). */
  useEffect(() => {
    const refs = [
      ...messages,
      ...threadMsgs,
      ...summaries.flatMap((s) =>
        [s.root, s.firstAnswer, s.last].filter(
          (m): m is AppMessage => m !== undefined,
        ),
      ),
    ].flatMap((m) => m.attachments ?? []);
    ensureAttachments(refs);
  }, [messages, threadMsgs, summaries]);

  const uiEmp = employee ? toUiEmployee(employee, engineDown) : undefined;
  const empFn = (id: string) => {
    const e = employees.find((x) => x.id === id);
    return e ? toUiEmployee(e, engineDown) : undefined;
  };
  /* #179: the engine reports a helper's profile ref; LilOS links speak in
     employee ids — a subagent for an unknown profile keeps the ref (the
     avatar falls back gracefully). */
  const empRefToId = (ref: string) =>
    employees.find((x) => x.profile === ref)?.id ?? ref;

  const summaryOf = (conv: Conversation) =>
    summaries.find((s) => s.conversation.id === conv.id);

  /* #134: the relay rewinds files + conversation to just before the picked
     message; the target's text lands in the composer and its images reseed
     as attachment chips (AC-4). On a transport without `rewind` (ACP) the
     banner offers "Start a new session from here" (AC-3). */
  const rewindTo = (conv: Conversation, messageId: string) => {
    /* Capture the about-to-drop message ids up front — the engine-feed
       turns they prompted would otherwise re-append as rich cards after
       the thread drops the relay rows (mergeTurns). The relay's event
       carries the same ids; this covers the window until it lands. */
    const target = threadPool.find((m) => m.id === messageId);
    const doomed = target
      ? threadPool.filter(
          (m) => m.conversationId === conv.id && m.seq >= target.seq,
        )
      : [];
    const doomedIds = doomed.map((m) => m.id);
    const doomedTexts = doomed
      .filter((m) => m.authorKind === "employee")
      .map((m) => m.text.trim());

    void (async () => {
      try {
        const res = await relay.request<ConversationsRewindResult>(
          "conversations.rewind",
          { conversationId: conv.id, messageId },
        );
        setThreadDraft(res.message.text);
        if (doomedIds.length)
          setLocalRewoundIds((prev) => new Set([...prev, ...doomedIds]));
        if (doomedTexts.length)
          setLocalRewoundTexts((prev) => new Set([...prev, ...doomedTexts]));
        const files = await hydrateAttachments(res.message.attachments);
        if (files.length) setSeedFiles(files);
        setFilesOnly(
          res.engineRewound
            ? null
            : {
                conversationId: conv.id,
                target: res.message,
                filesRestored: res.filesRestored,
              },
        );
      } catch (e) {
        say(`Rewind failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  };

  /* AC-3 follow-up: a fresh session on the same folder, seeded with the
     surviving transcript as quoted context + the rewound message's text
     (the composer's current draft — the user may have edited it). */
  const startFreshFrom = (conv: Conversation, target: AppMessage) => {
    const kept = threadPool.filter((m) => m.seq < target.seq).slice(-20);
    const quote = kept
      .map((m) => {
        const who =
          m.authorKind === "user"
            ? currentName()
            : m.authorKind === "employee"
              ? (employee?.name ?? "Agent")
              : "note";
        return `> ${who}: ${m.text.replaceAll("\n", "\n> ")}`;
      })
      .join("\n");
    const text =
      "Picking up mid-session after a rewind — earlier transcript:\n\n" +
      `${quote}\n\n—\n\n` +
      (threadDraft.trim() || target.text);
    void sendDm(
      employeeId,
      text,
      undefined,
      conv.model
        ? {
            model: conv.model,
            provider: conv.provider,
            effort: conv.effort,
            fast: conv.fast,
          }
        : undefined,
      seedFiles,
      conv.cwd,
    ).then((c) => {
      if (!c) return;
      setFilesOnly(null);
      /* Sessions land on Focus (#149) — the seeded session does too. */
      void navigate({
        to: "/dm/$employeeId/$conversationId/focus",
        params: { employeeId, conversationId: c.id },
      });
    });
  };

  /* Replies for a list row: real messages inside the snapshot window, padded
     to the summary's count with the answer preview on top when it isn't. */
  const repliesOf = (conv: Conversation): Reply[] => {
    const s = summaryOf(conv);
    const want = s ? s.messageCount - 1 : undefined;
    const hidden = waitingFor(conv).hiddenIds;
    const known = conversationReplies(
      (conv.id === conversationId ? threadPool : messages).filter(
        (m) =>
          m.conversationId === conv.id &&
          m.id !== conv.rootMessageId &&
          !hidden.has(m.id),
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

  /* AC-6: pre-select the employee's last session's folder once it and the
     recents are known — but never stomp a pick the user already made. */
  useEffect(() => {
    if (wsPicks[employeeId] !== undefined) return;
    const lastCwd = [...convs].reverse().find((c) => c.cwd)?.cwd;
    const f = folderRows.find((x) => x.path === lastCwd && !x.missing);
    if (!f) return;
    setWsPicks((w) =>
      w[employeeId] !== undefined
        ? w
        : {
            ...w,
            [employeeId]: {
              folder: f.id,
              base: f.branches[0] ?? "",
              mode: "direct",
            },
          },
    );
  }, [employeeId, convs, folderRows, wsPicks]);

  const feedAttached = useAtom(sessionFeedAttached);

  const modelFor = (conv: Conversation): SessionModel | undefined =>
    conv.engineRef ? models[conv.engineRef] : undefined;

  /* #467: an engine-backed conversation can anchor replies only once its
     feed's attach watermark is stamped — before that, engine-post rows would
     paint unanchored below newer user rows for a frame. "pending" holds them
     (and the partial model live frames alone would mint) until the first
     replay lands; a terminal replay error latches attached too so the #28
     degraded thread keeps the raw relay view. Non-engine conversations are
     always bound — there is no feed to wait on. */
  const transcriptBound = (conv: Conversation): boolean =>
    !conv.engineRef || feedAttached[conv.engineRef] === true;
  const boundModel = (
    conv: Conversation,
  ): SessionModel | "pending" | undefined =>
    conv.engineRef && !transcriptBound(conv) ? "pending" : modelFor(conv);

  /* #315: mid-turn sends wait in the tray — relay truth (deliveredSeq + the
     message flags), not component state, so a reload shows the same tray.
     Waiting rows, landed steers and parked/removed rows never render as
     reply bubbles. */
  const waitingFor = (conv: Conversation) =>
    waitingMessages(
      (conv.id === conversationId ? threadPool : messages).filter(
        (m) => m.conversationId === conv.id,
      ),
      conv.deliveredSeq,
      modelFor(conv),
    );

  const convAsks = (conv: Conversation): Ask[] =>
    allAsks.filter((a) => a.conversationId === conv.id);

  /* #419 AC-2: Retry re-sends the user's last delivered message into the
     same session — a new user row the harness prompts as a fresh turn
     under the failed one (not a ghost re-prompt). Messages the engine
     never took (dropped/removed/rewound) can't be the retry text; the
     summary's root covers a conv whose replies fell out of the window. */
  const retryConv = (conv: Conversation) => {
    const last = (
      (conv.id === conversationId ? threadPool : messages).filter(
        (m) =>
          m.conversationId === conv.id &&
          m.authorKind === "user" &&
          !m.dropped &&
          !m.removed &&
          !m.rewound,
      ) as AppMessage[]
    ).reduce<AppMessage | undefined>(
      (a, m) => (!a || m.seq > a.seq ? m : a),
      undefined,
    );
    const text = last?.text ?? summaryOf(conv)?.root?.text;
    if (!text) {
      say("Nothing to retry — the session has no sent message.");
      return;
    }
    void sendDm(employeeId, text, conv.id);
  };

  const feed: Msg[] = convs.flatMap((conv) => {
    const root =
      summaryOf(conv)?.root ??
      messages.find((m) => m.id === conv.rootMessageId);
    if (!root) return [];
    const feedReplies = mergeTurns(
      repliesOf(conv),
      boundModel(conv),
      employeeId,
      convAsks(conv),
      rewoundInfo.get(conv.id),
      empRefToId,
      conv.rootMessageId,
      conv.state,
    );
    /* #320: scope turn keys to the conversation — turnIds are per-session
       counters (two DMs can both hold "t1"); React keys and the collapse
       store are keyed on it, so it must be conv-unique. */
    for (const r of feedReplies)
      if (r.turnId) r.turnId = `${conv.id}:${r.turnId}`;
    return [toFeed(root, conv, feedReplies, wsFor(conv.cwd, cwdBranches))];
  });

  // "submitted" marker clears once the engine turn is actually running.
  const openModel = openConv?.engineRef
    ? models[openConv.engineRef]
    : undefined;
  useEffect(() => {
    if (openConv && openModel?.live) clearPending(openConv.id);
  }, [openConv, openModel]);

  /* `@` mentions (#105): every employee in the Employees section, and — when
     the session has a folder — fs.search over it for the Files section. No
     folder (or a missing one) → no Files section at all (D-#19). */
  const mentionables = useMemo(
    () => employees.map((e) => toUiEmployee(e, engineDown)),
    [employees, engineDown],
  );
  /* Stable searcher identity per folder: the composer's effect keys on the
     function — a fresh lambda each render would refire fs.search in a loop. */
  const fileSearchers = useRef(
    new Map<string, (q: string) => Promise<FileMention[]>>(),
  );

  if (!employee || !uiEmp) {
    /* #189: a settled directory that has no such employee is a not-found
       state, not "Loading…" — stale links across LilOS homes land here. */
    if (directoryReady) {
      return (
        <div
          className="grid min-w-0 flex-1 place-items-center text-sm"
          data-employee-not-found
        >
          <div className="space-y-2 text-center">
            <p className="text-foreground">Employee not found</p>
            <p className="text-muted-foreground">
              This employee doesn’t exist on this LilOS install — the link may
              be stale.
            </p>
            <Link
              to="/"
              className="inline-block text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Back to company
            </Link>
          </div>
        </div>
      );
    }
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

  /* Clicking a session opens the thread panel beside the feed — the quick
     peek (#195 AC-1); the panel's ↗ is the way into Focus. */
  const openThread = (id: string) => {
    const conv = convs.find((c) => c.rootMessageId === id);
    if (conv)
      void navigate({
        to: "/dm/$employeeId/$conversationId",
        params: { employeeId, conversationId: conv.id },
      });
  };

  /* #138 AC-3: click a hit → open the session scrolled to the message. */
  const onOpenHit = (h: MessageHit) => {
    setScrollTo(h.messageId);
    openThread(h.rootId);
  };

  const pick = wsPicks[employeeId] ?? NO_WS;
  const setPick = (p: WsPick) => setWsPicks((w) => ({ ...w, [employeeId]: p }));

  const fileSearch = (folderPath: string | null | undefined) => {
    if (!folderPath) return undefined;
    let f = fileSearchers.current.get(folderPath);
    if (!f) {
      f = (q: string) => hostSearch(folderPath, q).then((r) => r.files);
      fileSearchers.current.set(folderPath, f);
    }
    return f;
  };
  const pickedFolderPath = pick.folder
    ? (folderRows.find((f) => f.id === pick.folder && !f.missing)?.path ?? null)
    : null;

  /* Add folder (#208): LilOS's own dialog on every surface — plain web and
     the packaged desktop app alike; no OS open panel anywhere. */
  const onAddFolder = () => {
    setAddFolderOpen(true);
    void loadDiscovered().catch(() => {});
  };
  const onDialogAdd = (path: string) => {
    void addFolder(path).then((f) => {
      if (f)
        setPick({
          folder: f.id,
          base: f.branches[0] ?? "",
          mode: "direct",
        });
    });
    setAddFolderOpen(false);
  };

  /* The returned promise is the composer's clear signal (AC-5): resolved →
     this DM channel's stored draft is dropped by key (not whatever composer
     is open at resolve time), rejected → the text stays. sendDm resolves
     undefined when nothing was sent (#112: unreadable file or relay error,
     already toasted) — surface it as a rejection so nothing is cleared. */
  const send = (text: string, p?: WsPick, files?: AttachedFile[]) => {
    const folder = p?.folder
      ? folderRows.find((f) => f.id === p.folder && !f.missing)
      : undefined;
    const modelPick = draftPick[employeeId];
    return sendDm(
      employeeId,
      text,
      undefined,
      modelPick,
      files,
      folder?.path,
      draftAccess[employeeId],
    ).then((conv) => {
      if (!conv) throw new Error("send failed");
      clearDraftIfSent(draftKey.dm(employeeId), text);
      setDraftPick(({ [employeeId]: _drop, ...rest }) => rest);
      setDraftAccess(({ [employeeId]: _drop, ...rest }) => rest);
      /* A fresh session still lands in Focus (#195 keeps send-as-today),
         but through the panel URL first — every way back out of Focus
         (Back/Esc/browser back) then lands on the same open peek. */
      return navigate({
        to: "/dm/$employeeId/$conversationId",
        params: { employeeId, conversationId: conv.id },
      }).then(() =>
        navigate({
          to: "/dm/$employeeId/$conversationId/focus",
          params: { employeeId, conversationId: conv.id },
        }),
      );
    });
  };

  /* ↑ recall for the home composer: the last top-level message the user sent
     in this DM is the newest conversation's root message (#104 AC-5). */
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
    /* #134: after a rewind TO the root the relay keeps the (rewound) root on
       the summary for list context — but the open thread must not show a
       message it just dropped. Fall back to the first surviving message
       (the "⚠ Files restored" note) instead. */
    let root = threadPool.find((m) => m.id === conv.rootMessageId);
    if (!root) {
      const listed = summaryOf(conv)?.root;
      root = listed && !listed.rewound ? listed : threadPool[0];
    }
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
        resolved[a.id] = outcomeLabel(a.outcome, currentName());
    }
    const engineRef = conv.engineRef;
    /* AC-6 (D-#19): plan surfaces only exist when the engine declares `plan`. */
    const planCap = hasCapability("plan");
    /* #315: waiting items (and parked/removed rows) leave the reply pool —
       they render in the trays above the composer, not as bubbles. */
    const waiting = waitingFor(conv);
    const notSentMsgs = threadPool.filter((m) => m.dropped);
    let replies = mergeTurns(
      conversationReplies(
        threadPool.filter(
          (m) =>
            m.id !== conv.rootMessageId &&
            m.id !== root?.id &&
            !waiting.hiddenIds.has(m.id),
        ),
        conv.id,
      ),
      boundModel(conv),
      employeeId,
      asksHere,
      rewoundInfo.get(conv.id),
      empRefToId,
      conv.rootMessageId,
      conv.state,
    );
    /* #320: same conv-scoped turn keys as the feed path (see above). */
    for (const r of replies) if (r.turnId) r.turnId = `${conv.id}:${r.turnId}`;
    if (!planCap) replies = stripPlans(replies);
    // An open question ask gets a real answer card (asks.respond).
    const openQuestion = asksHere.find(
      (a) => a.state === "open" && a.request.kind === "question",
    );
    /* #180: a proposed plan opens a `plan` ask on the relay — Approve/Reject
       answer it straight; Change… prefills the composer (AC-3/AC-4). */
    const openPlanAsk = asksHere.find(
      (a) => a.state === "open" && a.request.kind === "plan",
    );
    /* The card can beat `asks.open` by a frame — plan.updated lands in the
       feed before the relay mints the ask — so a fast Approve/Reject waits
       a short window for the ask instead of dropping the click (AC-4). */
    const findOpenPlanAsk = (planId: string): Ask | undefined =>
      asksAtom
        .get()
        .find(
          (x) =>
            x.conversationId === conv.id &&
            x.state === "open" &&
            x.request.kind === "plan" &&
            x.request.planId === planId,
        );
    const awaitPlanAsk = (planId: string) =>
      new Promise<Ask | undefined>((resolve) => {
        let tries = 0;
        const tick = () => {
          const hit = findOpenPlanAsk(planId);
          if (hit || ++tries >= 60) return resolve(hit);
          setTimeout(tick, 50);
        };
        tick();
      });
    const onPlan = (a: PlanAction, planId: string) => {
      if (a === "change") {
        setThreadDraft(PLAN_CHANGE_PREFIX);
        return;
      }
      void awaitPlanAsk(planId).then((ask) => {
        if (ask) void respondToRequest(ask.id, a);
      });
    };
    /* The thread composer send: a send that keeps the "Change the plan: "
       prefix answers the open plan request instead of posting (AC-4). */
    const sendInThread = (text: string, files?: AttachedFile[]) => {
      const t = text.trimStart();
      if (openPlanAsk && t.startsWith(PLAN_CHANGE_PREFIX)) {
        const answer = t.slice(PLAN_CHANGE_PREFIX.length).trim();
        return respondToRequest(openPlanAsk.id, "change", answer).then(() => {
          clearDraftIfSent(draftKey.thread(conv.id), text);
          return conv;
        });
      }
      return sendDm(employeeId, text, conv.id, undefined, files).then((c) => {
        if (!c) throw new Error("send failed");
        clearDraftIfSent(draftKey.thread(conv.id), text);
        return c;
      });
    };
    /* AC-7: the conversation's folder (+ branch for a repo) in the header;
       sessions without one show nothing extra. */
    const convWs = wsFor(conv.cwd, cwdBranches);
    /* The session's real folder for Focus/Workbench (issue #113/114): absent
       when the session was started without one — no Workbench then (D-#19). */
    const work: Work | null = conv.cwd
      ? {
          ticket: "",
          title: conv.title ?? "",
          path: conv.cwd,
          ...(convWs?.branch ? { branch: convWs.branch } : {}),
        }
      : null;

    /* #179: the session's background processes — `jobs.list` rows cover the
       engine-restart window the event stream can't; job.* events then win
       (fresher). The tab renders only when the capability is declared. */
    const jobsNow = Date.now();
    const jobsById = new Map<string, BackgroundJob>();
    if (jobsCapable) {
      for (const j of listedJobs[conv.engineRef ?? ""] ?? []) {
        jobsById.set(j.jobId, {
          id: j.jobId,
          command: j.command,
          status: j.status,
          started: j.startedAt
            ? new Date(j.startedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })
            : "",
          uptime: j.startedAt
            ? formatUptime(((j.endedAt ?? jobsNow) - j.startedAt) / 1000)
            : "0s",
          ...(j.url ? { url: j.url } : {}),
          ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}),
          log: j.tail ?? "",
        });
      }
      for (const j of model?.jobs ?? [])
        jobsById.set(j.jobId, toJob(j, jobsNow));
    }
    /* #309: helpers the session delegated to list on the Background tab
       too — under `subagents`, not `background_jobs`, so they merge
       outside the capability gate. */
    for (const j of model?.subagentJobs ?? [])
      jobsById.set(j.jobId, toJob(j, jobsNow));
    const uiJobs = [...jobsById.values()].sort(
      (a, b) => a.started.localeCompare(b.started) || a.id.localeCompare(b.id),
    );
    /* AC-3: a subagent row for another employee opens their own session in
       their DM (D-#25) — resolve the engine sessionRef to its conversation. */
    const onOpenSession = (empRef: string, sessionRef: string) => {
      const target = summaries.find(
        (s) => s.conversation.engineRef === sessionRef,
      )?.conversation;
      if (target) {
        const ch = channels.find((c) => c.id === target.channelId);
        void navigate({
          to: "/dm/$employeeId/$conversationId",
          params: {
            employeeId: ch?.employeeId ?? empRef,
            conversationId: target.id,
          },
        });
      } else {
        void navigate({
          to: "/dm/$employeeId",
          params: { employeeId: empRef },
        });
      }
    };
    const onStopJob = (jobId: string) => {
      if (!conv.engineRef) return;
      void relay
        .request<{ stopped: boolean }>("jobs.stop", {
          sessionId: conv.engineRef,
          jobId,
        })
        .catch((e) =>
          say(`Stop failed — ${e instanceof Error ? e.message : String(e)}`),
        );
    };

    /* #315 tray actions. The relay owns the row: Remove marks it `removed`
       (the harness's `message.changed` handler drops it from every in-memory
       hold, so the engine never gets it); Send clears `dropped` and the
       harness re-delivers it. `say` carries a failure instead of throwing
       mid-render. */
    const onRemovePending = (i: number) => {
      const target = waiting.waiting[i]?.message;
      if (!target) return;
      void relay
        .request("messages.remove", { messageId: target.id })
        .catch((e) =>
          say(`Remove failed — ${e instanceof Error ? e.message : String(e)}`),
        );
    };
    const onUnqueue = (i: number) => {
      const target = notSentMsgs[i];
      if (!target) return;
      void relay
        .request("messages.remove", { messageId: target.id })
        .catch((e) =>
          say(`Remove failed — ${e instanceof Error ? e.message : String(e)}`),
        );
    };
    const onSendQueued = (i: number) => {
      const target = notSentMsgs[i];
      if (!target) return;
      void relay
        .request("messages.send", { messageId: target.id })
        .catch((e) =>
          say(`Send failed — ${e instanceof Error ? e.message : String(e)}`),
        );
    };
    /* An accepted-but-unlanded steer already reached the engine — its row
       still lists in the tray but Edit/Remove aren't offered (#315 AC-4). */
    const pendingItems = waiting.waiting.map((w) =>
      w.removable ? w.message.text : { text: w.message.text, removable: false },
    );

    const thread: Thread = {
      session: engineRef?.slice(0, 8) ?? conv.id.slice(0, 8),
      title: conv.title || undefined,
      archived: conv.archived,
      replies,
      /* #315: the not-sent tray reads ONLY ■-stopped parked sends. */
      queue: notSentMsgs.map((m) => m.text),
      /* #300: live turn usage first, the persisted conv.usage for sessions
         the engine forgot (legacy engineRefs degrade to an empty replay). */
      usage: threadUsage(model, conv),
      // The session's pick: the pinned conversation fields win; the session
      // snapshot fills what a bare `model` pin (pre-#92 rows) never set.
      model: conv.model ?? model?.model,
      provider: conv.provider ?? model?.provider,
      effort: conv.effort ?? model?.effort,
      fast: conv.fast ?? model?.fast,
      ...(convWs ? { ws: convWs } : {}),
      /* #179 AC-4/AC-5: the Background tab reads this list only when the
         engine declared `background_jobs` (uiJobs is empty otherwise — and
         the tab hides itself when it is). */
      ...(uiJobs.length ? { jobs: uiJobs } : {}),
    };
    const running = !!modelLive || pending[conv.id] === true;
    /* #134 AC-5: another live session on the same folder -> the click asks
       first (its files roll back too); the message names it. */
    const sharer = summaries
      .map((s) => s.conversation)
      .find(
        (c) =>
          c.id !== conv.id &&
          !c.archived &&
          conv.cwd !== undefined &&
          sameFolder(c.cwd, conv.cwd, home),
      );
    const sharerName = sharer
      ? sharer.title ||
        summaryOf(sharer)?.root?.text.slice(0, 60) ||
        "another session"
      : "";
    const rewindWarning = sharer
      ? `This folder is shared with “${sharerName}” — rewinding changes its files too.`
      : undefined;
    /* ↑ recall in the open session: the user's last sent message in it — the
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
          attachments: toAttachedFiles(root.attachments),
          thread,
        }
      : { kind: "msg", id: conv.id, from: "user", time: "", text: "", thread };

    if (focusOpen) {
      /* Focus: the same live conversation the thread panel shows (shared
         AgentTurn/composer/draft/asks — issue #114 AC-2), plus the
         Workbench against the session's real folder (AC-3…5). Esc / the
         back button return to the DM with the panel open on this session
         (#195 AC-2). */
      return (
        <FocusView
          root={rootMsg}
          thread={thread}
          channel={uiChannel}
          lead={uiEmp}
          emp={empFn}
          human={human}
          resolved={resolved}
          setResolved={(r) => {
            const diff = Object.entries(r).find(([k, v]) => resolved[k] !== v);
            if (diff) {
              void respondToRequest(diff[0], outcomeFromLabel(diff[1]));
            }
          }}
          work={work}
          onOpenSession={onOpenSession}
          onStopJob={jobsCapable ? onStopJob : undefined}
          onBack={() =>
            void navigate({
              to: "/dm/$employeeId/$conversationId",
              params: { employeeId, conversationId: conv.id },
            })
          }
          onNav={() => navOpen.set(true)}
          running={running}
          onSend={sendInThread}
          onPlan={planCap ? onPlan : undefined}
          onStop={running ? () => void interruptSession(conv.id) : undefined}
          lastSent={lastSent}
          /* #419: hover Retry on the last turn re-sends the last user
             message into this same session. */
          onRetry={() => retryConv(conv)}
          onRewind={conv.engineRef ? (id) => rewindTo(conv, id) : undefined}
          rewindWarning={rewindWarning}
          seedFiles={seedFiles}
          onSeededFiles={() => setSeedFiles(undefined)}
          onModel={(c) => void setConversationModel(conv.id, c)}
          models={catalog.length ? catalog : undefined}
          /* Focus is a picker surface too — the same Refresh / Edit models…
             extras as the thread panel (#140: the not-in-list row's hint
             runs Refresh). */
          picker={picker}
          defaultModel={defaultModel}
          defaultProvider={defaultProvider}
          access={conv.access}
          onAccess={(a) => void setConversationAccess(conv.id, a)}
          accept={canAttachImages ? "image/*" : undefined}
          maxFileSize={MAX_ATTACHMENT_BYTES}
          onAttachError={say}
          say={say}
          host={conv.cwd ? hostAccessors : undefined}
          transcriptNote={transcriptNote}
          scrollTo={scrollTo ?? undefined}
          onScrolled={() => setScrollTo(null)}
          steer={steer}
          agentWorking={!!modelLive?.agentInitiated}
          /* #319 AC-2: the URL carries the Workbench tab — opening on
             `?tab=` (a panel link's pick) and keeping it on further picks
             means a reload always lands on the tab the URL names. */
          initialTab={focusTab}
          onTab={(t: WbTab) =>
            void navigate({
              to: "/dm/$employeeId/$conversationId/focus",
              params: { employeeId, conversationId: conv.id },
              search: { tab: t },
              replace: true,
            })
          }
          pending={pendingItems}
          onRemovePending={onRemovePending}
          onUnqueue={onUnqueue}
          onSendQueued={onSendQueued}
          draft={threadDraft}
          onDraftChange={setThreadDraft}
          /* Same capability probe as the thread panel (#110): null pins the
             badge to a plain label when os.open isn't on the host. */
          editors={editors ?? undefined}
          onOpenPath={
            openCwd && editors !== null
              ? (path, app, line) => {
                  void hostOsOpen(openCwd, path, app, line).catch((e) =>
                    say(
                      `Open failed — ${e instanceof Error ? e.message : String(e)}`,
                    ),
                  );
                }
              : null
          }
          wbSpot={wbSpot}
        >
          {filesOnly?.conversationId === conv.id && (
            <StatusBanner
              tone="amber"
              action={{
                label: "Start a new session from here",
                onClick: () => startFreshFrom(conv, filesOnly.target),
              }}
            >
              {filesOnly.filesRestored
                ? "Files restored to the earlier checkpoint — but this "
                : "The folder kept its current state (no checkpoint stored) — and this "}
              session's transport can't rewind the agent's memory: it still
              remembers the dropped messages.
            </StatusBanner>
          )}
          {openQuestion && (
            <QuestionCard
              ask={openQuestion}
              onAnswer={(answer) =>
                void respondToRequest(openQuestion.id, "answer", answer)
              }
              onCancel={() => void respondToRequest(openQuestion.id, "cancel")}
            />
          )}
        </FocusView>
      );
    }

    threadEl = (
      <div
        data-thread-panel
        className="flex min-h-0 w-[420px] shrink-0 flex-col border-l xl:w-[460px]"
      >
        {filesOnly?.conversationId === conv.id && (
          <StatusBanner
            tone="amber"
            action={{
              label: "Start a new session from here",
              onClick: () => startFreshFrom(conv, filesOnly.target),
            }}
          >
            {filesOnly.filesRestored
              ? "Files restored to the earlier checkpoint — but this "
              : "The folder kept its current state (no checkpoint stored) — and this "}
            session's transport can't rewind the agent's memory: it still
            remembers the dropped messages.
          </StatusBanner>
        )}
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
          agentWorking={!!modelLive?.agentInitiated}
          onOpenSession={onOpenSession}
          /* #319 AC-1: the turn's "N subagents · Open" / "N files changed"
             lines open Focus straight on that Workbench tab. */
          onOpenTab={(t: WbTab) =>
            void navigate({
              to: "/dm/$employeeId/$conversationId/focus",
              params: { employeeId, conversationId: conv.id },
              search: { tab: t },
            })
          }
          transcriptNote={transcriptNote}
          models={catalog.length ? catalog : undefined}
          onModel={
            catalog.length
              ? (c) => void setConversationModel(conv.id, c)
              : undefined
          }
          picker={picker}
          access={conv.access}
          onAccess={(a) => void setConversationAccess(conv.id, a)}
          defaultModel={defaultModel}
          defaultProvider={defaultProvider}
          onSend={sendInThread}
          onPlan={planCap ? onPlan : undefined}
          pending={pendingItems}
          onRemovePending={onRemovePending}
          onUnqueue={onUnqueue}
          onSendQueued={onSendQueued}
          draft={threadDraft}
          onDraftChange={setThreadDraft}
          accept={canAttachImages ? "image/*" : undefined}
          maxFileSize={MAX_ATTACHMENT_BYTES}
          maxFiles={MAX_ATTACHMENTS_PER_MESSAGE}
          onAttachError={say}
          onStop={running ? () => void interruptSession(conv.id) : undefined}
          lastSent={lastSent}
          /* #419: hover Retry on the last turn re-sends the last user
             message into this same session. */
          onRetry={() => retryConv(conv)}
          /* The peek panel's Focus button jumps to the full view (#114),
             and Esc closes the panel back to the plain DM feed (#195). */
          onFocus={() =>
            void navigate({
              to: "/dm/$employeeId/$conversationId/focus",
              params: { employeeId, conversationId: conv.id },
            })
          }
          onRewind={
            conv.engineRef
              ? (messageId) => rewindTo(conv, messageId)
              : undefined
          }
          rewindWarning={rewindWarning}
          seedFiles={seedFiles}
          onSeededFiles={() => setSeedFiles(undefined)}
          onClose={() =>
            void navigate({
              to: "/dm/$employeeId",
              params: { employeeId },
            })
          }
          mentionables={mentionables}
          onSearchFiles={fileSearch(conv.cwd)}
          scrollTo={scrollTo ?? undefined}
          onScrolled={() => setScrollTo(null)}
          work={null}
          editors={editors ?? undefined}
          onOpenPath={
            openCwd && editors !== null
              ? (path, app, line) => {
                  void hostOsOpen(openCwd, path, app, line).catch((e) =>
                    say(
                      `Open failed — ${e instanceof Error ? e.message : String(e)}`,
                    ),
                  );
                }
              : undefined
          }
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
        draft={homeDraft}
        onDraftChange={setHomeDraft}
        accept={canAttachImages ? "image/*" : undefined}
        maxFileSize={MAX_ATTACHMENT_BYTES}
        maxFiles={MAX_ATTACHMENTS_PER_MESSAGE}
        onAttachError={say}
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
        folders={folderRows}
        pick={pick}
        setPick={setPick}
        onAddFolder={onAddFolder}
        loading={!channel && !dmOpenFailed}
        composerNote={composerNote}
        mentionables={mentionables}
        onSearchFiles={fileSearch(pickedFolderPath)}
        onSearchMessages={searchMessages}
        onOpenHit={onOpenHit}
        /* #339: the employee's connect row off system.status — the notice
           renders only for non-connected states. */
        connection={
          employeeRow
            ? {
                state: employeeRow.state,
                ...(employeeRow.reason ? { reason: employeeRow.reason } : {}),
                onConnect: () => void requestConnect(),
              }
            : undefined
        }
        models={catalog.length ? catalog : undefined}
        access={draftAccess[employeeId] ?? defaultAccess.get()}
        onAccess={(a) => setDraftAccess((d) => ({ ...d, [employeeId]: a }))}
        modelChoice={
          draftPick[employeeId] ??
          choiceFor(
            employee.model || defaultModel || "",
            catalog,
            /* the engine default's provider disambiguates a shared id */
            employee.model ? undefined : defaultProvider,
          )
        }
        onModel={
          catalog.length
            ? (c) => setDraftPick((d) => ({ ...d, [employeeId]: c }))
            : undefined
        }
        picker={picker}
        onRename={(id, title) => {
          const conv = convs.find((c) => c.rootMessageId === id);
          if (conv) void renameConversation(conv.id, title);
        }}
        onArchive={(id, archived) => {
          const conv = convs.find((c) => c.rootMessageId === id);
          if (conv) void archiveConversation(conv.id, archived);
        }}
        /* #419: the session row's failure card retries the whole session —
           same re-send as the turn's hover Retry. */
        onRetrySession={(m) => {
          const conv = convs.find((c) => c.rootMessageId === m.id);
          if (conv) retryConv(conv);
        }}
      />
      {threadEl}
      {addFolderOpen && (
        <AddFolderDialog
          folders={folderRows}
          fs={fsListing}
          discovered={discoveredRows}
          onNeedDir={loadDir}
          onClose={() => setAddFolderOpen(false)}
          onAdd={onDialogAdd}
        />
      )}
      {profileOpen && !editOpen && (
        <EmployeeProfileCard
          name={uiEmp.name}
          profile={uiEmp.profile}
          model={uiEmp.model}
          models={catalog.length ? catalog : undefined}
          instructions={uiEmp.instructions}
          onEdit={() => {
            setEditError(null);
            setEditAgent(undefined);
            // The persona/model live on the engine profile — describe
            // prefills them; a failed describe still opens the record edit.
            void relay
              .describeAgent(employee.profile)
              .then((a) => setEditAgent(a))
              .catch(() => setEditAgent(null))
              .finally(() => setEditOpen(true));
          }}
          onClose={() => setProfileOpen(false)}
        />
      )}
      {editOpen && (
        <EditEmployeeDialog
          e={uiEmp}
          agent={editAgent ?? undefined}
          updatable={updatable}
          models={catalog}
          error={editError ?? undefined}
          onClose={() => setEditOpen(false)}
          onSave={async (edit) => {
            try {
              const r = await saveEmployee(employee.id, edit);
              setEditError(null);
              // A confirmModel reply keeps the dialog open on its own
              // confirm card — the dialog re-sends with confirmModel:true.
              if (!r?.confirmModel) setEditOpen(false);
              return r;
            } catch (e) {
              setEditError(e instanceof Error ? e.message : String(e));
              return;
            }
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
            className="rounded-md bg-primary px-2 py-1 text-primary-foreground"
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
  models,
  instructions,
  onEdit,
  onClose,
}: {
  name: string;
  profile: string;
  model: string;
  models?: ModelOption[];
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
            <dd className="font-mono">
              {models?.find((m) => m.id === model)?.name ??
                (model || "engine default")}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 text-muted-foreground">Soul</dt>
            <dd className="min-w-0 flex-1">{instructions || "—"}</dd>
          </div>
        </dl>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className="flex-1 rounded-md bg-primary px-2 py-1.5 text-primary-foreground text-sm"
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
