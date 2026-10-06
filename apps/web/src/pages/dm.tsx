import {
  type ChannelMessagesState,
  type SessionFeedState,
  type SessionModel,
  sendKeyDone,
  sendKeyFor,
  toStatusComponents,
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
  EngineProfile,
  FileMention,
  MessageHit,
  ModelChoice,
  ModelPickerExtras,
  Msg,
  PullRequest,
  Thread,
  TranscriptNote,
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
  describeActionError,
  hasCapability,
  interruptSession,
  loadThreadHistory,
  openDmChannel,
  pendingStart,
  refreshModels,
  renameConversation,
  respondToRequest,
  sendDm,
  setConversationAccess,
  setConversationModel,
  setModelVisibility,
  toastOnFail,
} from "../lib/actions";
import {
  attachmentUrls,
  ensureAttachments,
  hydrateAttachments,
  toAttachedFiles,
} from "../lib/attachments";
import { requestConnect } from "../lib/connect";
import { FoldCache, type FoldInputs } from "../lib/conv-fold";
import {
  listHirableProfiles,
  removeEmployee,
  saveEmployee,
} from "../lib/employees";
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
  clock,
  formatUptime,
  sessionLabel,
  threadUsage,
  toJob,
  toUiEmployee,
} from "../lib/mapping";
import { currentName, humanFor, osFullName, osHome, profile } from "../lib/me";
import { $prs, refreshConversationPrs, watchPrs } from "../lib/prs";
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
import { sendKeyDoneForSend, sendKeyForSend } from "../lib/send-key";
import { say, sayError, sayNotice } from "../lib/toast";
import { defaultAccess } from "../settings/state";
import { DmProfileCard } from "./dm-profile-card";

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

/* #427: shared empties for the fold's per-conv slices — a missing row must
   keep one stable reference or every render would look like new input. */
const NO_MSGS: AppMessage[] = [];
const NO_ASKS: Ask[] = [];

/* #180 AC-4: Change… prefills the composer with this prefix; a send that
   keeps it answers the open plan request instead of posting a message. */
const PLAN_CHANGE_PREFIX = "Change the plan: ";

/* Resolved-ask labels carry the signed-in human's name — computed per render
   so a settings change lands without a reload (#118). */
const outcomeLabel = (o: ApprovalOutcome, name: string): string => {
  switch (o) {
    case "once":
      return `Allowed once by ${name}`;
    /* #106: "This thread" — the grant lives until the thread's engine
       session ends; only this thread stopped asking. */
    case "session":
      return `Allowed this thread by ${name}`;
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
  /* #106: the card's resolved label for the thread-scoped grant — reads
     both the current wording and pre-#582 stored rows. */
  if (v.startsWith("Allowed this ")) return "session";
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
  /* #421: the header card lists the engine's profiles for the
     missing-profile switch — fetched per open so a profile created
     elsewhere shows; stays undefined until first load (an empty list
     would paint a false "Profile missing"). */
  const [cardProfiles, setCardProfiles] = useState<EngineProfile[] | null>(
    null,
  );
  const [editOpen, setEditOpen] = useState(false);
  useEffect(() => {
    if (!profileOpen) return;
    let dead = false;
    void listHirableProfiles()
      .then((list) => {
        if (!dead) setCardProfiles(list);
      })
      .catch(() => {
        /* No profiles → no Switch: renders like a profile-less card, still
           matching the "missing" copy row (D-#19). */
        if (!dead) setCardProfiles((prev) => prev ?? []);
      });
    return () => {
      dead = true;
    };
  }, [profileOpen]);
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
      onVisibility: (v) =>
        toastOnFail("Couldn't update the model list", setModelVisibility(v)),
      ...(detail?.refreshable === true
        ? {
            /* Toast AND rethrow — the picker must still see the failure so
               its "refreshed" marker stays honest (#423 AC-1). */
            onRefresh: () =>
              refreshModels().catch((e) => {
                sayError(
                  describeActionError("Couldn't refresh the model list", e),
                );
                throw e;
              }),
          }
        : {}),
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
    toastOnFail("Couldn't load folders", refreshFolders());
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
      try {
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
              /* #585 AC-3: system notes label "LilOS" in search, not the user —
                 stored notes can carry the relay's "user" authorId default. */
              from: h.authorKind === "system" ? "system" : h.authorId,
              time: clock(h.createdAt),
              snippet: h.snippet,
              archived: conv?.archived,
            },
          ];
        });
      } catch (e) {
        /* The feed swallows the rejection — the toast is the only signal
           the search failed rather than finding nothing (#423). */
        sayError(describeActionError("Couldn't search messages", e));
        throw e;
      }
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
      void hostEditors()
        .then((e) => {
          if (!off) setEditors(e);
        })
        /* A failed probe only hides the badge's editor menu (D-#19) — no
           toast: nothing the user asked for failed. */
        .catch(() => {});
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

  /* The open thread needs its whole visible history, not just the channel
     window (#28 AC-2): page messages.list scoped to the conversation. A
     failed fetch used to swallow silently and the thread just looked
     shorter — #423 AC-2 surfaces a retryable notice instead. */
  const channelId = channel?.id;
  const [threadMsgs, setThreadMsgs] = useState<AppMessage[]>([]);
  const [historyFailed, setHistoryFailed] = useState(false);
  /* Retry bumps this counter — the effect re-runs the same fetch. */
  const [historyAttempt, setHistoryAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: historyAttempt re-runs the fetch on Retry (#423 AC-2).
  useEffect(() => {
    setThreadMsgs([]);
    setLocalRewoundIds(new Set());
    setLocalRewoundTexts(new Set());
    setHistoryFailed(false);
    if (!conversationId || !channelId) return;
    let dead = false;
    void loadThreadHistory(
      (method, params) => relay.request(method, params),
      channelId,
      conversationId,
    )
      .then((r) => {
        if (dead) return;
        setThreadMsgs(r.messages);
        setLocalRewoundIds(r.rewoundIds);
        setLocalRewoundTexts(r.rewoundTexts);
      })
      .catch(() => {
        if (!dead) setHistoryFailed(true);
      });
    return () => {
      dead = true;
    };
  }, [conversationId, channelId, historyAttempt]);

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
      /* #423 AC-1: a failed list used to leave the Background tab quietly
         empty — the rows the event stream can't carry just vanished. */
      .catch((e) =>
        sayError(describeActionError("Couldn't load background jobs", e)),
      );
    return () => {
      dead = true;
    };
  }, [jobsCapable, openSid, openFeed.synced]);

  /* #579 AC-1: the open conversation's PRs — one fetch on open +
     `turn.completed` (watchPrs); the Workbench probe's read then wins via
     `probePr` (undefined = it hasn't answered, list fills in). */
  const prsByConv = useAtom($prs);
  const listedPr = openConvId ? prsByConv[openConvId]?.[0] : undefined;
  const [probePr, setProbePr] = useState<PullRequest | null | undefined>(
    undefined,
  );
  useEffect(() => {
    setProbePr(undefined);
    if (!openConvId) return;
    watchPrs();
    void refreshConversationPrs(openConvId);
  }, [openConvId]);

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
  /* #430: stable across renders — the memoized turn rows compare `emp` by
     identity, so a fresh closure each render would defeat the memo. */
  const empFn = useCallback(
    (id: string) => {
      const e = employees.find((x) => x.id === id);
      return e ? toUiEmployee(e, engineDown) : undefined;
    },
    [employees, engineDown],
  );
  const summaryOf = (conv: Conversation) => summaryByConv.get(conv.id);

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
        sayError(describeActionError("Couldn't rewind the turn", e));
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
      "Picking up mid-thread after a rewind — earlier transcript:\n\n" +
      `${quote}\n\n—\n\n` +
      (threadDraft.trim() || target.text);
    const key = sendKeyFor(`sfresh:${conv.id}`, text);
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
      key,
      conv.cwd,
    ).then((c) => {
      if (!c) return;
      sendKeyDone(`sfresh:${conv.id}`, text);
      setFilesOnly(null);
      /* Sessions land on Focus (#149) — the seeded session does too. */
      void navigate({
        to: "/dm/$employeeId/$conversationId/focus",
        params: { employeeId, conversationId: c.id },
      });
    });
  };

  /* #427: the fold's inputs, sliced per conversation once per render. The
     slices keep element identity — relay rows are replaced immutably — so
     the cache below re-folds only the conversation a change belongs to. */
  const summaryByConv = useMemo(
    () => new Map(summaries.map((s) => [s.conversation.id, s])),
    [summaries],
  );
  const msgById = useMemo(
    () => new Map(messages.map((m) => [m.id, m])),
    [messages],
  );
  const asksByConv = useMemo(() => {
    const m = new Map<string, Ask[]>();
    for (const a of allAsks) {
      const arr = m.get(a.conversationId);
      if (arr) arr.push(a);
      else m.set(a.conversationId, [a]);
    }
    return m;
  }, [allAsks]);
  const msgsByConv = useMemo(() => {
    const m = new Map<string, AppMessage[]>();
    for (const msg of messages) {
      if (!msg.conversationId) continue;
      const arr = m.get(msg.conversationId);
      if (arr) arr.push(msg);
      else m.set(msg.conversationId, [msg]);
    }
    /* The open thread's fold reads the full fetched pool, not the channel
       window — same rule the per-conv slices used to apply inline. */
    if (openConvId) m.set(openConvId, threadPool);
    return m;
  }, [messages, threadPool, openConvId]);

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

  const convAsks = (conv: Conversation): Ask[] =>
    asksByConv.get(conv.id) ?? NO_ASKS;

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
      say("Nothing to retry — the thread has no sent message.");
      return;
    }
    /* #552: one key per (conv, retried text) — a second click after the
       first attempt's answer died with the socket repeats it, so the
       stored retry dedupes instead of posting again. The binding frees
       on resolve, so retrying a landed turn is still a real retry. */
    const key = sendKeyFor(`retry:${conv.id}`, text);
    void sendDm(employeeId, text, conv.id, undefined, undefined, key).then(
      (c) => {
        if (c) sendKeyDone(`retry:${conv.id}`, text);
      },
    );
  };

  /* #427: one fold per conversation (waiting rows, feed replies, thread
     extras) cached on its inputs — a word streaming into one session
     recomputes only that conversation instead of re-running
     waitingMessages/conversationReplies/mergeTurns for all of them. */
  const folds = useMemo(() => new FoldCache(), []);
  const foldInputs = (conv: Conversation): FoldInputs => {
    const summary = summaryByConv.get(conv.id);
    return {
      conv,
      model: modelFor(conv),
      /* #467: the fold keys on the BOUND model too — without it the cache
         would keep serving the "pending" fold after the feed attaches and
         the held-back engine replies would never appear. */
      bound: boundModel(conv),
      msgs: msgsByConv.get(conv.id) ?? NO_MSGS,
      asks: convAsks(conv),
      rewoundEvent: rewinds[conv.id],
      /* The open conv's local rewound ids/texts (#134) join the event's
         removedIds inside the fold — the same merged view rewoundInfo
         used to hand mergeTurns. */
      localRewound:
        conv.id === conversationId
          ? { ids: localRewoundIds, texts: localRewoundTexts }
          : undefined,
      summary,
      root: summary?.root ?? msgById.get(conv.rootMessageId),
      employees,
      cwdInfo: cwdBranches,
      employeeId,
    };
  };

  folds.reset();
  const feed: Msg[] = [];
  for (const conv of convs) {
    const f = folds.for(foldInputs(conv));
    if (f.msg) feed.push(f.msg);
  }
  folds.sweep();

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
    toastOnFail("Couldn't scan for repos", loadDiscovered());
  };
  const onDialogAdd = (path: string) => {
    toastOnFail(
      "Couldn't add the folder",
      addFolder(path).then((f) => {
        if (f)
          setPick({
            folder: f.id,
            base: f.branches[0] ?? "",
            mode: "direct",
          });
      }),
    );
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
      /* #552 AC-1: the draft's own key — a failed send keeps the draft,
         so the resend repeats the key and dedupes on the relay. */
      sendKeyForSend(`dm:${employeeId}`, draftKey.dm(employeeId), text, files),
      folder?.path,
      draftAccess[employeeId],
    ).then((conv) => {
      if (!conv) throw new Error("send failed");
      sendKeyDoneForSend(`dm:${employeeId}`, text, files);
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
       feed's. Notes carry a kind so the views pick the slot (#532):
       "unavailable" (#28) tails the transcript — the live tail can't
       replay; "trimmed" (#431) heads it — the missing history sits above
       the first entry. */
    const transcriptNote: TranscriptNote | undefined =
      conv.engineRef && (!openFeed.synced || openFeed.error)
        ? {
            kind: "unavailable",
            text: `Working transcript unavailable — ${
              openFeed.error ??
              (engineState !== "ready"
                ? "the engine feed is disconnected (harness down or restarting)"
                : "still syncing")
            }`,
          }
        : /* #431: a capped engine log means the transcript's retained tail
             is all that exists — say so rather than letting the missing
             head read as a render gap. */
          conv.engineRef && openFeed.historyTrimmed
          ? {
              kind: "trimmed",
              text: "Earlier history was trimmed — this thread's event log is capped.",
            }
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
       they render in the trays above the composer, not as bubbles. #427:
       the fold rides the same per-conv cache as the feed — the open
       thread's entry was already folded above, this only adds its extras. */
    const folded = folds.thread(foldInputs(conv), {
      rootId: root?.id,
      planCap,
    });
    const waiting = folded.feed.waiting;
    const notSentMsgs = folded.thread.notSent;
    const replies = folded.thread.replies;
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
        /* respondToRequest toasts its own failure line — the catch only
           keeps the rethrow from going unhandled. */
        if (ask) void respondToRequest(ask.id, a).catch(() => {});
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
      return sendDm(
        employeeId,
        text,
        conv.id,
        undefined,
        files,
        /* #552 AC-1: the draft's own key when the draft itself goes out —
           a Workbench/programmatic send rides a session binding instead,
           so it can't borrow the key a stored draft send is waiting on. */
        sendKeyForSend(
          `conv:${conv.id}`,
          draftKey.thread(conv.id),
          text,
          files,
        ),
      ).then((c) => {
        if (!c) throw new Error("send failed");
        sendKeyDoneForSend(`conv:${conv.id}`, text, files);
        clearDraftIfSent(draftKey.thread(conv.id), text);
        return c;
      });
    };
    /* AC-7: the conversation's folder (+ branch for a repo) in the header;
       sessions without one show nothing extra. */
    const convWs = folded.feed.ws;
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
          started: j.startedAt ? clock(j.startedAt) : "",
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
    /* #587 AC-2: helpers list ONLY on the Subagents tab — no merge into
       the Background jobs rows. */
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
          sayError(describeActionError("Couldn't stop the job", e)),
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
          sayError(describeActionError("Couldn't remove the message", e)),
        );
    };
    const onUnqueue = (i: number) => {
      const target = notSentMsgs[i];
      if (!target) return;
      void relay
        .request("messages.remove", { messageId: target.id })
        .catch((e) =>
          sayError(describeActionError("Couldn't remove the message", e)),
        );
    };
    const onSendQueued = (i: number) => {
      const target = notSentMsgs[i];
      if (!target) return;
      void relay
        .request("messages.send", { messageId: target.id })
        .catch((e) =>
          sayError(describeActionError("Couldn't send the message", e)),
        );
    };
    const pendingItems = folded.thread.pendingItems;

    const thread: Thread = {
      /* #586: the tag is display-only (onOpenSession resolves on the full
         engineRef) — the TAIL is the unique part of a Hermes ref. */
      session: sessionLabel(engineRef ?? conv.id),
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
      /* #579 AC-1: the header's "PR #N" chip — the Workbench probe's live
         read wins once it reports; the conversations.prs list fills in
         before it does (undefined probe = not answered yet). */
      ...(probePr !== undefined
        ? probePr
          ? { pr: probePr }
          : {}
        : listedPr
          ? { pr: listedPr }
          : {}),
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
        "another thread"
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
    /* #423 AC-2: a failed history fetch says so with a retry instead of
       silently showing a shorter thread — the red band #419 introduced,
       inline so it sits in the message column with Retry right after the
       text in both the panel and Focus. */
    const historyNotice = historyFailed ? (
      <StatusBanner
        tone="red"
        inline
        action={{
          label: "Retry",
          onClick: () => setHistoryAttempt((n) => n + 1),
        }}
      >
        Couldn't load this thread's history — earlier messages may be missing.
      </StatusBanner>
    ) : undefined;
    const rootMsg: Msg = root
      ? {
          kind: "msg",
          id: root.id,
          from: root.authorId,
          time: clock(root.createdAt),
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
              void respondToRequest(diff[0], outcomeFromLabel(diff[1])).catch(
                () => {},
              );
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
          onStop={
            running
              ? () =>
                  toastOnFail(
                    "Couldn't stop the turn",
                    interruptSession(conv.id),
                  )
              : undefined
          }
          lastSent={lastSent}
          /* #419: hover Retry on the last turn re-sends the last user
             message into this same session. */
          onRetry={() => retryConv(conv)}
          onRewind={conv.engineRef ? (id) => rewindTo(conv, id) : undefined}
          rewindWarning={rewindWarning}
          seedFiles={seedFiles}
          onSeededFiles={() => setSeedFiles(undefined)}
          onModel={(c) =>
            toastOnFail(
              "Couldn't switch the model",
              setConversationModel(conv.id, c),
            )
          }
          banner={historyNotice}
          models={catalog.length ? catalog : undefined}
          /* Focus is a picker surface too — the same Refresh / Edit models…
             extras as the thread panel (#140: the not-in-list row's hint
             runs Refresh). */
          picker={picker}
          defaultModel={defaultModel}
          defaultProvider={defaultProvider}
          access={conv.access}
          onAccess={(a) =>
            toastOnFail(
              "Couldn't change the access level",
              setConversationAccess(conv.id, a),
            )
          }
          accept={canAttachImages ? "image/*" : undefined}
          maxFileSize={MAX_ATTACHMENT_BYTES}
          onAttachError={sayError}
          say={sayNotice}
          /* #543: the Workbench exists for every session — the accessors
             are folder-independent (each call takes the cwd), so `host`
             rides unconditionally; the Workbench gates its folder-bound
             tabs on `work?.path` itself. */
          host={hostAccessors}
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
                    sayError(describeActionError("Couldn't open the file", e)),
                  );
                }
              : null
          }
          wbSpot={wbSpot}
          /* #587 AC-1: the Workbench's engine-owned tabs gate on the
             declared capabilities — the strip's membership is fixed. */
          caps={{
            plan: planCap,
            subagents: hasCapability("subagents"),
            background: jobsCapable,
          }}
          /* #584: Suggest rides `session.ask` — a side request that adds
             nothing to the transcript. Only where the engine declares it. */
          onSuggest={
            hasCapability("side_prompt") && conv.engineRef
              ? (files) =>
                  relay
                    .request<{ answer: string }>("session.ask", {
                      sessionId: conv.engineRef,
                      text: `Write a one-line git commit message for these changed files: ${
                        files.join(", ") || "the listed files"
                      }`,
                    })
                    .then((r) => r.answer)
              : undefined
          }
          /* #579 AC-1: the probe's live forge read updates the header
             chip the moment it answers (a PR the session just opened). */
          onPr={setProbePr}
        >
          {filesOnly?.conversationId === conv.id && (
            <StatusBanner
              tone="amber"
              action={{
                label: "Start a new thread from here",
                onClick: () => startFreshFrom(conv, filesOnly.target),
              }}
            >
              {filesOnly.filesRestored
                ? "Files restored to the earlier checkpoint — but this "
                : "The folder kept its current state (no checkpoint stored) — and this "}
              thread's transport can't rewind the agent's memory: it still
              remembers the dropped messages.
            </StatusBanner>
          )}
          {openQuestion && (
            <QuestionCard
              ask={openQuestion}
              onAnswer={(answer) =>
                void respondToRequest(openQuestion.id, "answer", answer).catch(
                  () => {},
                )
              }
              onCancel={() =>
                void respondToRequest(openQuestion.id, "cancel").catch(() => {})
              }
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
        {historyNotice && (
          <div className="px-3 pt-2 sm:px-5">{historyNotice}</div>
        )}
        {filesOnly?.conversationId === conv.id && (
          <StatusBanner
            tone="amber"
            action={{
              label: "Start a new thread from here",
              onClick: () => startFreshFrom(conv, filesOnly.target),
            }}
          >
            {filesOnly.filesRestored
              ? "Files restored to the earlier checkpoint — but this "
              : "The folder kept its current state (no checkpoint stored) — and this "}
            thread's transport can't rewind the agent's memory: it still
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
              void respondToRequest(diff[0], outcomeFromLabel(diff[1])).catch(
                () => {},
              );
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
              ? (c) =>
                  toastOnFail(
                    "Couldn't switch the model",
                    setConversationModel(conv.id, c),
                  )
              : undefined
          }
          picker={picker}
          access={conv.access}
          onAccess={(a) =>
            toastOnFail(
              "Couldn't change the access level",
              setConversationAccess(conv.id, a),
            )
          }
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
          onAttachError={sayError}
          onStop={
            running
              ? () =>
                  toastOnFail(
                    "Couldn't stop the turn",
                    interruptSession(conv.id),
                  )
              : undefined
          }
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
                    sayError(describeActionError("Couldn't open the file", e)),
                  );
                }
              : undefined
          }
        />
        {openQuestion && (
          <QuestionCard
            ask={openQuestion}
            onAnswer={(answer) =>
              void respondToRequest(openQuestion.id, "answer", answer).catch(
                () => {},
              )
            }
            onCancel={() =>
              void respondToRequest(openQuestion.id, "cancel").catch(() => {})
            }
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
        onAttachError={sayError}
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
                onConnect: () =>
                  toastOnFail("Couldn't turn on Connect", requestConnect()),
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
          if (conv)
            toastOnFail(
              "Couldn't rename the thread",
              renameConversation(conv.id, title),
            );
        }}
        onArchive={(id, archived) => {
          const conv = convs.find((c) => c.rootMessageId === id);
          if (conv)
            toastOnFail(
              archived
                ? "Couldn't archive the thread"
                : "Couldn't unarchive the thread",
              archiveConversation(conv.id, archived),
            );
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
        <DmProfileCard
          /* A record with no pinned model shows the engine default, same as
             the picker's effective model — never a blank Model row. */
          e={{ ...uiEmp, model: uiEmp.model || defaultModel || "" }}
          profiles={cardProfiles ?? undefined}
          engineName={statusPoll.result?.engine?.name}
          ownerName={currentName()}
          models={catalog.length ? catalog : undefined}
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
          /* #421 AC-2: the switch works end to end — employees.update
             re-points the record and the harness resolves the new
             profile on the next session.start, so it renders (D-#19). */
          onSwitchProfile={(p) =>
            void relay
              .updateEmployee(employee.id, { profile: p })
              .catch((err) =>
                say(err instanceof Error ? err.message : String(err)),
              )
          }
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
