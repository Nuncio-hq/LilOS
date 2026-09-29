import {
  type ChannelMessagesState,
  type SessionFeedState,
  type SessionModel,
  toStatusComponents,
} from "@lilos/client-runtime";
import type {
  AppMessage,
  Ask,
  Conversation,
  MessageSearchHit,
} from "@lilos/contracts/app";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@lilos/contracts/app";
import type {
  AgentDescriptor,
  ApprovalOutcome,
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
  setConversationModel,
  setModelVisibility,
} from "../lib/actions";
import {
  attachmentUrls,
  ensureAttachments,
  toAttachedFiles,
} from "../lib/attachments";
import { removeEmployee, saveEmployee } from "../lib/employees";
import {
  addFolder,
  cwdInfo,
  discovered,
  folders,
  fsRows,
  loadDir,
  loadDiscovered,
  refreshFolders,
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
  toFeed,
  toJob,
  toUiEmployee,
} from "../lib/mapping";
import { currentName, humanFor, osFullName, profile } from "../lib/me";
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
  sessionModels,
} from "../lib/runtime";
import { say } from "../lib/toast";

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

/* Resolved-ask labels carry the signed-in human's name — computed per render
   so a settings change lands without a reload (#118). */
const outcomeLabel = (o: ApprovalOutcome, name: string): string => {
  switch (o) {
    case "once":
      return `Allowed once by ${name}`;
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
     (#114) — the route carries it, so reload stays in Focus. */
  const focusOpen = useRouterState({
    select: (s) => s.location.pathname.endsWith("/focus"),
  });

  const employees = useAtom(relay.employees);
  const channels = useAtom(relay.channels);
  const directoryReady = useAtom(relay.directoryReady);
  // #118: the human's name/avatar re-render live on a settings change.
  useAtom(profile);
  useAtom(osFullName);
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
        mergeTurns(
          repliesOf(conv),
          model,
          employeeId,
          convAsks(conv),
          empRefToId,
        ),
        wsFor(conv.cwd, cwdBranches),
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
    ).then((conv) => {
      if (!conv) throw new Error("send failed");
      clearDraftIfSent(draftKey.dm(employeeId), text);
      setDraftPick(({ [employeeId]: _drop, ...rest }) => rest);
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
        resolved[a.id] = outcomeLabel(a.outcome, currentName());
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
      empRefToId,
    );
    // An open question ask gets a real answer card (asks.respond).
    const openQuestion = asksHere.find(
      (a) => a.state === "open" && a.request.kind === "question",
    );
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
            ? formatUptime((jobsNow - j.startedAt) / 1000)
            : "0s",
          ...(j.url ? { url: j.url } : {}),
          ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}),
          log: j.tail ?? "",
        });
      }
      for (const j of model?.jobs ?? [])
        jobsById.set(j.jobId, toJob(j, jobsNow));
    }
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

    const thread: Thread = {
      session: engineRef?.slice(0, 8) ?? conv.id.slice(0, 8),
      title: conv.title || undefined,
      archived: conv.archived,
      replies,
      usage: model?.turns.at(-1)?.usage as Thread["usage"],
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
          onSend={(text, files) =>
            sendDm(employeeId, text, conv.id, undefined, files).then((c) => {
              if (!c) throw new Error("send failed");
              clearDraftIfSent(draftKey.thread(conv.id), text);
              return c;
            })
          }
          onStop={running ? () => void interruptSession(conv.id) : undefined}
          lastSent={lastSent}
          onModel={(c) => void setConversationModel(conv.id, c)}
          models={catalog.length ? catalog : undefined}
          /* Focus is a picker surface too — the same Refresh / Edit models…
             extras as the thread panel (#140: the not-in-list row's hint
             runs Refresh). */
          picker={picker}
          defaultModel={defaultModel}
          defaultProvider={defaultProvider}
          accept={canAttachImages ? "image/*" : undefined}
          maxFileSize={MAX_ATTACHMENT_BYTES}
          onAttachError={say}
          say={say}
          host={conv.cwd ? hostAccessors : undefined}
          transcriptNote={transcriptNote}
          scrollTo={scrollTo ?? undefined}
          onScrolled={() => setScrollTo(null)}
          steer={steer}
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
        >
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
          onOpenSession={onOpenSession}
          transcriptNote={transcriptNote}
          models={catalog.length ? catalog : undefined}
          onModel={
            catalog.length
              ? (c) => void setConversationModel(conv.id, c)
              : undefined
          }
          picker={picker}
          defaultModel={defaultModel}
          defaultProvider={defaultProvider}
          onSend={(text, files) =>
            sendDm(employeeId, text, conv.id, undefined, files).then((c) => {
              if (!c) throw new Error("send failed");
              clearDraftIfSent(draftKey.thread(conv.id), text);
              return c;
            })
          }
          draft={threadDraft}
          onDraftChange={setThreadDraft}
          accept={canAttachImages ? "image/*" : undefined}
          maxFileSize={MAX_ATTACHMENT_BYTES}
          maxFiles={MAX_ATTACHMENTS_PER_MESSAGE}
          onAttachError={say}
          onStop={running ? () => void interruptSession(conv.id) : undefined}
          lastSent={lastSent}
          /* The peek panel's Focus button jumps to the full view (#114),
             and Esc closes the panel back to the plain DM feed (#195). */
          onFocus={() =>
            void navigate({
              to: "/dm/$employeeId/$conversationId/focus",
              params: { employeeId, conversationId: conv.id },
            })
          }
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
        models={catalog.length ? catalog : undefined}
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
