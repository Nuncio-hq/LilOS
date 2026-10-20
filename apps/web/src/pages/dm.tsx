import type { MessageSearchHit } from "@lilos/contracts/app";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@lilos/contracts/app";
import type {
  AgentDescriptor,
  ConversationAccess,
} from "@lilos/contracts/engine";
import {
  AddFolderDialog,
  choiceFor,
  clearDraftIfSent,
  draftKey,
  EditEmployeeDialog,
  EmployeeHome,
  MainPane,
  NO_WS,
  ScheduledTasks,
  TaskDialog,
  type TaskDraft,
  useDraft,
} from "@lilos/ui";
import type {
  EngineProfile,
  MessageHit,
  ModelChoice,
  WbTab,
  WsPick,
} from "@lilos/ui/types";
import {
  Link,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  archiveConversation,
  describeActionError,
  hasCapability,
  openDmChannel,
  renameConversation,
  sendDm,
  toastOnFail,
} from "../lib/actions";
import { ensureAttachments } from "../lib/attachments";
import { requestConnect } from "../lib/connect";
import {
  listHirableProfiles,
  removeEmployee,
  saveEmployee,
} from "../lib/employees";
import { parseFocusTab } from "../lib/focus-search";
import {
  addFolder,
  composerFocus,
  discovered,
  folders,
  foldersLoaded,
  fsRows,
  loadDir,
  loadDiscovered,
  refreshFolders,
  wsPicks,
} from "../lib/folders";
import { useAtom } from "../lib/hooks";
import { clock, toUiEmployee } from "../lib/mapping";
import { currentName, humanFor, osFullName, profile } from "../lib/me";
import { navOpen, relay, workbenchRequests } from "../lib/runtime";
import {
  $scheduledTasks,
  createScheduledTask,
  deleteScheduledTask,
  refreshScheduledTasks,
  runScheduledTaskNow,
  toUiTask,
  updateScheduledTask,
  watchSchedules,
} from "../lib/schedules";
import { sendKeyDoneForSend, sendKeyForSend } from "../lib/send-key";
import { say, sayError } from "../lib/toast";
import { defaultAccess } from "../settings/state";
import { draftCommands, fileSearch } from "../thread/searchers";
import { SessionPane } from "../thread/session-pane";
import {
  compactConversation,
  continueInNewSession,
  retryConversation,
} from "../thread/thread-actions";
import { type ThreadNav, ThreadPane } from "../thread/thread-pane";
import { useConvFolds } from "../thread/use-conv-folds";
import { useEmployeeLookup } from "../thread/use-employee-lookup";
import { useEngineStatus } from "../thread/use-engine-status";
import { useModelCatalog } from "../thread/use-model-catalog";
import { useThreadWith } from "../thread/use-thread";
import { DmProfileCard } from "./dm-profile-card";

/* User messages render as the signed-in human — the same identity the
   sidebar footer shows (issue #80 AC-1, #118: relay-owned). */
const human = humanFor;

/**
 * `/dm/$employeeId(/$conversationId)` — the DM home: session list + composer
 * (EmployeeHome) and, when a session is open, the thread panel. The thread
 * itself lives in `../thread` (the panel and the session view take a
 * conversation id and no router); this page owns the route, the session
 * list, the new-session composer, Scheduled and the employee dialogs, and
 * maps the thread's navigation callbacks onto URLs.
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
  const summaries = useAtom(relay.conversationSummaries);
  const { catalog, defaultModel, defaultProvider, picker, description } =
    useModelCatalog();
  const { statusPoll, engineDown, composerNote } = useEngineStatus();
  const { empFn, mentionables } = useEmployeeLookup(employees, engineDown);
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
  /* `/model` typed in the new-session composer opens ITS model picker. */
  const [draftModelOpen, setDraftModelOpen] = useState(false);

  /* Folder picking (#113): shared recents from the relay (probed live for
     missing/git) + a per-employee pick (its last session's folder, AC-6).
     Direct mode only — the picker gets no onWorktree (AC-3).
     `git.discoverRepos` stays lazy: it runs when the Add-folder dialog
     opens, never on DM mount. */
  const folderRows = useAtom(folders);
  const fsListing = useAtom(fsRows);
  const discoveredRows = useAtom(discovered);
  const picks = useAtom(wsPicks);
  /* ⌘N / a ⌘K folder pick asks for the composer: on the new-session
     surface (no open thread) its textarea takes focus. The nudge stays
     pending until this surface is actually showing — a bump on a thread
     route fires once the navigation back to the DM home lands. */
  const focusNudge = useAtom(composerFocus);
  const nudgeSeen = useRef(focusNudge);
  useEffect(() => {
    if (conversationId) return;
    if (focusNudge === nudgeSeen.current) return;
    nudgeSeen.current = focusNudge;
    /* The composer can lag a first mount (channel still loading) — retry
       briefly before giving up. */
    let tries = 0;
    let timer = 0;
    const tick = () => {
      const el = document.querySelector<HTMLTextAreaElement>(
        "[data-composer] textarea",
      );
      if (el) {
        el.focus();
        return;
      }
      if (++tries < 20) timer = window.setTimeout(tick, 50);
    };
    timer = window.setTimeout(tick, 0);
    return () => window.clearTimeout(timer);
  }, [focusNudge, conversationId]);
  const [addFolderOpen, setAddFolderOpen] = useState(false);
  /* #136: the Scheduled panel — the header button and a session row's
     chip both open it; a thread open replaces it. `taskFlash` is the
     chip's target (scroll + flash). */
  const scheduledTasks = useAtom($scheduledTasks);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [taskFlash, setTaskFlash] = useState<string | null>(null);
  const [taskEdit, setTaskEdit] = useState<{
    task?: (typeof scheduledTasks)[number];
  } | null>(null);
  const openScheduled = (taskId?: string) => {
    setScheduledOpen(true);
    if (taskId) {
      setTaskFlash(taskId);
      setTimeout(() => setTaskFlash((f) => (f === taskId ? null : f)), 2000);
    }
  };
  useEffect(() => {
    toastOnFail("Couldn't load scheduled tasks", refreshScheduledTasks());
    watchSchedules();
  }, []);
  /* Any route naming a conversation closes the panel — covers deep links
     and the feed's own navigation, not only `openThread`. */
  useEffect(() => {
    if (conversationId) setScheduledOpen(false);
  }, [conversationId]);
  useEffect(() => {
    toastOnFail("Couldn't load folders", refreshFolders());
  }, []);

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
  /* D-#645: the open thread must not WAIT on the summaries fetch — it is the
     enrichment layer (root text, previews, counts), and under load it
     landed after the send that opened the conversation (or never, once
     every refresh outlasted the request timeout), so `openConv` resolved
     late or stayed undefined and the thread panel rendered nothing.
     `relay.conversations` is push-fed by `conversation.updated`/
     `conversations.list` — the authority for the conversation's
     existence, and the ONLY source here: a summary fallback would swap
     `openConv`'s identity the moment the row landed, tearing menus
     mounted off the thread (ac-110's Open-in-editor). Summaries still
     qualify the feed's rows (and deliberately drop retired sys-notes);
     the open URL names a real conversation, so mount it the moment the
     push feed carries it. Not: resolving the open conversation from
     summaries — a lagging fetch parked the composer on "working…". */
  const allConvs = useAtom(relay.conversations);
  const openConv = allConvs.find(
    (c) => c.id === conversationId && c.channelId === channel?.id,
  );
  /* Contract rows -> panel rows (#136): the run's `conversationId` becomes
     the DM row's rootId; `folder` is already the path-id the dialog uses. */
  const myTasks = useMemo(
    () =>
      scheduledTasks
        .filter((t) => t.employeeId === employeeId)
        .map((t) => toUiTask(t, convs)),
    [scheduledTasks, employeeId, convs],
  );

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

  /* #427: one fold per conversation — the feed rows and the open thread's
     extras ride the same cache (see thread/use-conv-folds). */
  const folds = useConvFolds({
    employeeId,
    channelId: channel?.id,
    conversationId,
    convs,
  });
  const { messages, feed } = folds;
  /* The open thread's whole per-conversation model (undefined → no thread). */
  const d = useThreadWith(openConv, folds);

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

  /* Unsent drafts live outside the composer: one key per employee home
     (issue #103; the thread's own draft lives with the thread). Switching
     employees — or reloading — swaps in the stored text instead of throwing
     it away. */
  const [homeDraft, setHomeDraft] = useDraft(draftKey.dm(employeeId));

  /* Attachment blobs behind the summary roots/previews that feed rows
     render (AC-3) — the channel window and the open thread's own are
     fetched with the thread. */
  useEffect(() => {
    ensureAttachments(
      summaries
        .flatMap((s) => [s.root, s.firstAnswer, s.last])
        .flatMap((m) => m?.attachments ?? []),
    );
  }, [summaries]);

  /* Row actions on a feed conversation (not the open thread). */
  const retryConv = (conv: (typeof convs)[number]) =>
    retryConversation(
      conv,
      employeeId,
      conv.id === conversationId ? folds.pool : messages,
      folds.summaryOf(conv)?.root?.text,
    );

  /* AC-6 + #581 AC-1: pre-select what the LAST session used — a folder
     pick follows the last session's folder, and a folder-less last
     session means "No folder" follows too (it was silently reselecting
     the repo before). Never stomps a pick the user already made — and
     never stamps "No folder" while the recents probe is still out: a
     folder-bound last session waits for folderRows before its pick
     resolves (the stamp is once-only). */
  const recentsReady = useAtom(foldersLoaded);
  useEffect(() => {
    if (picks[employeeId] !== undefined) return;
    const last = convs.at(-1);
    if (!last) return;
    const pickForLast = (): WsPick | undefined => {
      if (!last.cwd) return NO_WS;
      if (!recentsReady) return undefined;
      const f = folderRows.find((x) => x.path === last.cwd && !x.missing);
      return f
        ? { folder: f.id, base: f.branches[0] ?? "", mode: "direct" }
        : NO_WS;
    };
    const pick = pickForLast();
    if (pick === undefined) return;
    wsPicks.set(
      picks[employeeId] !== undefined
        ? picks
        : { ...picks, [employeeId]: pick },
    );
  }, [employeeId, convs, folderRows, recentsReady, picks]);

  if (!employee) {
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
  const uiEmp = toUiEmployee(employee, engineDown);

  /* The thread's navigation, as URLs: a subagent row (or a fresh thread
     after a files-only rewind) opens another thread — beside the list, not a
     jump into Focus (#577); a row whose session is no known thread opens its
     agent's DM. */
  const threadNav: ThreadNav = {
    onOpenThread: (cid, eid) =>
      void navigate({
        to: "/dm/$employeeId/$conversationId",
        params: { employeeId: eid, conversationId: cid },
      }),
    onOpenAgent: (eid) =>
      void navigate({ to: "/dm/$employeeId", params: { employeeId: eid } }),
  };
  const openFocus = (tab?: WbTab) =>
    conversationId &&
    void navigate({
      to: "/dm/$employeeId/$conversationId/focus",
      params: { employeeId, conversationId },
      ...(tab ? { search: { tab } } : {}),
    });
  const closeToList = () =>
    void navigate({ to: "/dm/$employeeId", params: { employeeId } });

  /* Clicking a session opens the thread panel beside the feed — the quick
     peek (#195 AC-1); the panel's ↗ is the way into Focus. */
  const openThread = (id: string) => {
    /* A thread open always replaces the Scheduled panel (#136). */
    setScheduledOpen(false);
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

  const pick = picks[employeeId] ?? NO_WS;
  const setPick = (p: WsPick) => wsPicks.set({ ...picks, [employeeId]: p });
  const pickedFolderPath = pick.folder
    ? (folderRows.find((f) => f.id === pick.folder && !f.missing)?.path ?? null)
    : null;

  /* Add folder (D-#113, #208): LilOS's own dialog (the prototype's) on
     every surface — plain web and the packaged desktop app alike. Not: the
     macOS open panel. */
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
  const send = (
    text: string,
    p?: WsPick,
    files?: Parameters<typeof sendDm>[4],
  ) => {
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
      /* #577 (decided 2026-10-07): a new send STAYS on the DM list with
         the thread open in the side panel, like the prototype — Focus
         opens only when the user asks for it. */
      return navigate({
        to: "/dm/$employeeId/$conversationId",
        params: { employeeId, conversationId: conv.id },
      });
    });
  };

  /* ↑ recall for the home composer: the last top-level message the user sent
     in this DM is the newest conversation's root message (#104 AC-5). */
  const lastSentTop = [...convs]
    .reverse()
    .map(
      (c) =>
        folds.summaryOf(c)?.root ??
        messages.find((m) => m.id === c.rootMessageId),
    )
    .find((m) => m?.authorKind === "user")?.text;

  if (focusOpen && d) {
    /* Focus: the same live conversation the thread panel shows (shared
       AgentTurn/composer/draft/asks — issue #114 AC-2), plus the
       Workbench against the session's real folder (AC-3…5). Esc / the
       back button return to the DM with the panel open on this session
       (#195 AC-2). */
    return (
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* #660: the page owns the <main> landmark — the feed, panel and
            Focus all render inside the same element, so nothing detaches
            the pane mid-layout. */}
        <MainPane>
          <SessionPane
            d={d}
            nav={threadNav}
            onBack={() =>
              void navigate({
                to: "/dm/$employeeId/$conversationId",
                params: { employeeId, conversationId: d.conv.id },
              })
            }
            onNav={() => navOpen.set(true)}
            /* #319 AC-2: the URL carries the Workbench tab — opening on
               `?tab=` (a panel link's pick) and keeping it on further picks
               means a reload always lands on the tab the URL names. */
            tab={focusTab}
            onTab={(t) =>
              void navigate({
                to: "/dm/$employeeId/$conversationId/focus",
                params: { employeeId, conversationId: d.conv.id },
                search: { tab: t },
                replace: true,
              })
            }
            scrollTo={scrollTo ?? undefined}
            onScrolled={() => setScrollTo(null)}
          />
        </MainPane>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* #660: the page owns the <main> landmark — the feed, panel and Focus
          all render inside the same element, so nothing detaches the pane
          mid-layout. */}
      <MainPane>
        <EmployeeHome
          bare
          e={uiEmp}
          feed={feed}
          threadId={openConv?.rootMessageId ?? null}
          emp={empFn}
          human={human}
          onNav={() => navOpen.set(true)}
          onProfile={() => setProfileOpen((v) => !v)}
          onOpen={openThread}
          scheduled={{
            count: myTasks.length,
            onOpen: () => openScheduled(),
            onOpenTask: openScheduled,
          }}
          onSend={send}
          draft={homeDraft}
          onDraftChange={setHomeDraft}
          accept="*/*"
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
          onPanelClose={closeToList}
          folders={folderRows}
          pick={pick}
          setPick={setPick}
          onAddFolder={onAddFolder}
          loading={!channel && !dmOpenFailed}
          composerNote={composerNote}
          mentionables={mentionables}
          onSearchFiles={fileSearch(pickedFolderPath)}
          /* The `/` menu's provider (issue #109), agent+cwd scoped on the
             draft composer. Engines without the `commands` capability get no
             provider → no menu (D-#19). */
          onSearchCommands={draftCommands(employee.profile, pickedFolderPath)}
          /* The host-owned `/model` opens the picker this surface owns;
             everything else posts and the engine runs it. */
          onCommand={(name) => {
            if (name !== "model" || !catalog.length) return false;
            setDraftModelOpen(true);
            return true;
          }}
          modelOpen={draftModelOpen}
          onModelOpen={setDraftModelOpen}
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
          onCompactSession={(m) => {
            const conv = convs.find((c) => c.rootMessageId === m.id);
            if (conv && hasCapability("compact") && conv.engineRef)
              compactConversation(conv);
          }}
          onContinueSession={(m) => {
            const conv = convs.find((c) => c.rootMessageId === m.id);
            if (conv)
              void continueInNewSession(conv, employeeId, employee.name);
          }}
        />
      </MainPane>
      {scheduledOpen ? (
        <div
          data-scheduled-panel
          className="relative flex min-h-0 w-[420px] shrink-0 flex-col border-l bg-background xl:w-[460px]"
        >
          <button
            type="button"
            aria-label="Close scheduled tasks"
            onClick={() => setScheduledOpen(false)}
            className="absolute top-3 right-3 z-10 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
          <ScheduledTasks
            employeeName={employee.name}
            tasks={myTasks}
            folders={folderRows}
            highlight={taskFlash}
            onNew={() => setTaskEdit({})}
            onEdit={(task) => {
              const row = scheduledTasks.find((t) => t.id === task.id);
              if (row) setTaskEdit({ task: row });
            }}
            onRunNow={(id) =>
              toastOnFail("Couldn't start the run", runScheduledTaskNow(id))
            }
            onPause={(id, paused) =>
              toastOnFail(
                paused ? "Couldn't pause the task" : "Couldn't resume the task",
                updateScheduledTask(id, { paused }),
              )
            }
            onDelete={(id) =>
              toastOnFail("Couldn't delete the task", deleteScheduledTask(id))
            }
            onOpenRun={(rootId) => {
              setScheduledOpen(false);
              openThread(rootId);
            }}
          />
        </div>
      ) : (
        d && (
          /* bg-background is not decorative here: on the desktop app the body
             is transparent and the column would otherwise show the window's
             light vibrancy backing under dark mode — the same surface
             treatment the right panel and Focus thread pane already carry. */
          <div
            data-thread-panel
            className="flex min-h-0 w-[420px] shrink-0 flex-col border-l bg-background xl:w-[460px]"
          >
            <ThreadPane
              d={d}
              nav={threadNav}
              /* The peek panel's Focus button jumps to the full view (#114),
                 and Esc closes the panel back to the plain DM feed (#195). */
              onFocus={() => openFocus()}
              /* #319 AC-1: the turn's "N subagents · Open" / "N files
                 changed" lines open Focus straight on that Workbench tab. */
              onOpenTab={openFocus}
              onClose={closeToList}
              scrollTo={scrollTo ?? undefined}
              onScrolled={() => setScrollTo(null)}
            />
          </div>
        )
      )}
      {taskEdit && (
        <TaskDialog
          task={taskEdit.task ? toUiTask(taskEdit.task, convs) : undefined}
          employeeName={employee.name}
          folders={folderRows}
          defaultFolder={pick.folder ?? folderRows[0]?.id}
          onClose={() => setTaskEdit(null)}
          onSave={(d: TaskDraft) => {
            setTaskEdit(null);
            /* Update sends `folder: null` to CLEAR a folder — create just
               omits it. */
            const input = {
              name: d.name,
              prompt: d.prompt,
              schedule: d.schedule,
              access: d.access,
            };
            toastOnFail(
              "Couldn't save the task",
              taskEdit.task
                ? updateScheduledTask(taskEdit.task.id, {
                    ...input,
                    folder: d.folder ?? null,
                  })
                : createScheduledTask({
                    employeeId,
                    ...input,
                    ...(d.folder !== undefined ? { folder: d.folder } : {}),
                  }),
            );
          }}
        />
      )}
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
          /* #561 AC-3: the mute lives on the relay's employee row, so the
             phone's pushes and this app's banners both honour it. */
          onToggleMute={(muted) =>
            void relay
              .updateEmployee(employee.id, { muted })
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
