import {
  AlertTriangleIcon,
  ArchiveIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FolderIcon,
  MenuIcon,
  MessageSquareIcon,
  MoonIcon,
  PanelRightIcon,
  PencilIcon,
  RotateCcwIcon,
  SearchIcon,
  TriangleAlertIcon,
  UserIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AccessPill } from "../chat/access-pill";
import { Composer } from "../chat/composer";
import { choiceFor, ModelPicker } from "../chat/model-picker";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "../components/ai-elements/conversation";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { NotConnectedNotice } from "../connect/not-connected-notice";
import { AttachmentChips } from "../conversation/turns";
import { WorkspacePicker, wsHint } from "../dialogs/workspace-picker";
import { Body, Row, Who } from "../feed/row";
import {
  folderLabel,
  LIFE_LABEL,
  PHASE_LABEL,
  preview,
  sessionLife,
} from "../lib/helpers";
import { InlineCodeText } from "../lib/inline-code";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type {
  AttachedFile,
  ConnectionState,
  ConversationAccess,
  EmpFn,
  Employee,
  EngineProfile,
  FileMention,
  Folder,
  HumanFn,
  MessageHit,
  ModelChoice,
  ModelOption,
  ModelPickerExtras,
  Msg,
  SessionAlert,
  WsPick,
} from "../types";

/* The ⋯ menu on a DM session row: rename / archive (or unarchive). Each item renders
   only when its handler is passed; with neither there is no menu at all. */
function SessionMenu({
  archived,
  onRename,
  onArchive,
}: {
  archived?: boolean;
  onRename?: () => void;
  onArchive?: () => void;
}) {
  if (!onRename && !onArchive) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Session actions"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          />
        }
      >
        <EllipsisIcon className="size-4" />
      </DropdownMenuTrigger>
      {/* sticky: the session list scroll-settles (use-stick-to-bottom) right
          as the menu opens; without it, floating-ui's limitShift caps the
          clamp at the clipped anchor's edge and the popup parks offscreen.
          sticky removes the limiter so the popup stays inside the
          scrollport. (#492) */}
      <DropdownMenuContent align="end" sticky className="w-44">
        {onRename && (
          <DropdownMenuItem onClick={onRename}>
            <PencilIcon />
            Rename session
          </DropdownMenuItem>
        )}
        {onArchive && (
          <DropdownMenuItem onClick={onArchive}>
            {archived ? <RotateCcwIcon /> : <ArchiveIcon />}
            {archived ? "Unarchive session" : "Archive session"}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* A designed failure state on one session in the list (model error, sleep interrupt). */
function SessionAlertRow({
  alert,
  onRetry,
}: {
  alert: SessionAlert;
  onRetry?: () => void;
}) {
  const warm = alert.kind === "sleep";
  return (
    <div
      data-session-alert
      className={cn(
        "mt-1 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs",
        warm
          ? "border-amber-200 bg-amber-50 text-amber-900"
          : "border-red-200 bg-red-50 text-red-900",
      )}
    >
      {warm ? (
        <MoonIcon className="size-3.5 shrink-0" />
      ) : (
        <TriangleAlertIcon className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1">{alert.text}</span>
      {alert.retry && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 font-medium text-white",
            warm
              ? "bg-amber-600 hover:bg-amber-700"
              : "bg-red-600 hover:bg-red-700",
          )}
        >
          <RotateCcwIcon className="size-3" />
          Retry
        </button>
      )}
    </div>
  );
}

/* `<mark>`-tagged search excerpt → elements (parsed, never set as HTML —
   the relay's snippet() doesn't entity-escape, so only the mark tags are
   structural). */
function Marks({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let rest = text;
  for (let k = 0; ; k++) {
    const open = rest.indexOf("<mark>");
    const close = open < 0 ? -1 : rest.indexOf("</mark>", open + 6);
    if (open < 0 || close < 0) {
      out.push(rest);
      break;
    }
    if (open) out.push(rest.slice(0, open));
    out.push(
      <mark
        key={k}
        className="rounded-sm bg-amber-200/70 px-0.5 dark:bg-amber-800/60"
      >
        {rest.slice(open + 6, close)}
      </mark>,
    );
    rest = rest.slice(close + 7);
  }
  return out;
}

/* Employee screen (DM). Left: the conversation list — each top-level message is ONE engine session,
   with rename / archive / filter and designed failure states (alert card + Retry). Right panel: the
   open session as a thread. Composer at the bottom always starts a NEW session. */
export function EmployeeHome({
  e,
  feed,
  threadId,
  emp,
  human,
  onNav,
  onProfile,
  onOpen,
  onSend,
  lastSent,
  panelOpen,
  onPanel,
  folders,
  pick,
  setPick,
  onAddFolder,
  onWorktree,
  loading,
  onRename,
  onArchive,
  onRetrySession,
  accept,
  maxFileSize,
  maxFiles,
  onAttachError,
  models,
  modelChoice,
  onModel,
  picker,
  composerNote,
  mentionables,
  onSearchFiles,
  onSearchMessages,
  onOpenHit,
  connection,
  access,
  onAccess,
  draft: composerDraft,
  onDraftChange,
  scheduled,
}: {
  e: Employee;
  feed: Msg[];
  threadId: string | null;
  emp: EmpFn;
  human: HumanFn;
  onNav: () => void;
  onProfile: () => void;
  onOpen: (id: string) => void;
  /* Return a promise to delay clearing the composer draft until it resolves;
     a rejected send keeps the text (issue #103, AC-5). */
  onSend: (
    t: string,
    pick?: WsPick,
    files?: AttachedFile[],
  ) => void | Promise<unknown>;
  /* Host-held composer draft for this DM channel (issue #103); omitted, the
     composer keeps its own state. */
  draft?: string;
  onDraftChange?: (v: string) => void;
  /* ↑ recall for the new-session composer: the last top-level message sent in
     this DM (issue #104 AC-5). */
  lastSent?: string;
  panelOpen: boolean;
  onPanel: () => void;
  folders: Folder[];
  pick: WsPick;
  setPick: (p: WsPick) => void;
  /* Folder picking lands with the workspace slice (#11) — omit to hide it. */
  onAddFolder?: () => void;
  /* Workstream picks (#10) — render only when passed (D-#19, #113). */
  onWorktree?: (p: WsPick) => void;
  loading?: boolean;
  onRename?: (id: string, title: string) => void;
  onArchive?: (id: string, archived: boolean) => void;
  onRetrySession?: (root: Extract<Msg, { kind: "msg" }>) => void;
  /* Composer attachment types the host accepts; absent = no attach UI. */
  accept?: string;
  /* Attachment byte cap + count cap + where rejections surface (issue #31). */
  maxFileSize?: number;
  maxFiles?: number;
  onAttachError?: (message: string) => void;
  /* Model for the NEW session: starts at the employee's default (never the last
     session's pick). No onModel → no picker (D-#19). */
  models?: ModelOption[];
  modelChoice?: ModelChoice;
  onModel?: (c: ModelChoice) => void;
  picker?: ModelPickerExtras;
  /* #106: the access level the new conversation opens with — the pill on
     the composer defaults to Settings' default; a switch applies to the
     session being composed, not the setting (both or neither, D-#19). */
  access?: ConversationAccess;
  onAccess?: (a: ConversationAccess) => void;
  /* Plain reason the engine is unavailable ("Hermes not found at …", #85);
     renders above the composer so a dead engine never looks sendable. */
  composerNote?: ReactNode;
  /* `@` menu sections (#105): employees listed for mention, and — only when
     the picked folder is searchable — a file/dir search for the Files
     section. Both omitted → bare composer like before. */
  mentionables?: Employee[];
  onSearchFiles?: (query: string) => Promise<FileMention[]>;
  /* Full-text message search behind the same session filter (issue #138):
     omit → the box matches titles and first messages only. */
  onSearchMessages?: (query: string) => Promise<MessageHit[]>;
  /* Opens a hit's session scrolled to that message (AC-3); omitted → onOpen. */
  onOpenHit?: (hit: MessageHit) => void;
  /* LilOS connection of this employee's engine profile (issue #338 AC-3):
     a slim notice under the header for any state but "connected" — omitted
     or connected renders nothing. Connect action needs onConnect (D-#19). */
  connection?: {
    state: ConnectionState;
    reason?: string;
    onConnect?: () => void;
  };
  /* Scheduled tasks (#136): the header's Scheduled button (with the count)
     and the chip on sessions a task started. Omitted → neither renders. */
  scheduled?: {
    count: number;
    onOpen: () => void;
    onOpenTask: (taskId: string) => void;
  };
}) {
  const pickedFolder = folders.find((x) => x.id === pick.folder);
  const [filter, setFilter] = useState("");
  const [hits, setHits] = useState<MessageHit[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const sessions = feed.filter(
    (m): m is Extract<Msg, { kind: "msg" }> => m.kind === "msg" && !!m.thread,
  );
  // Filter matches the session title (renamed) or the first message.
  const q = filter.trim().toLowerCase();
  const matches = (m: Extract<Msg, { kind: "msg" }>) =>
    !q || `${m.thread?.title ?? ""}\n${m.text}`.toLowerCase().includes(q);
  const roots = sessions.filter((m) => !m.thread!.archived && matches(m));
  /* Debounced message-level search behind the same box (AC-2); ref keeps the
     latest callback so the effect re-fires only on the query. */
  const searchRef = useRef(onSearchMessages);
  searchRef.current = onSearchMessages;
  useEffect(() => {
    if (!q || !searchRef.current) {
      setHits([]);
      return;
    }
    let dead = false;
    const t = setTimeout(() => {
      void searchRef
        .current?.(q)
        .then((h) => {
          if (!dead) setHits(h);
        })
        .catch(() => {});
    }, 120);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [q]);
  const hitGroups = useMemo(() => {
    const map = new Map<string, MessageHit[]>();
    for (const h of hits) {
      const g = map.get(h.rootId) ?? [];
      g.push(h);
      map.set(h.rootId, g);
    }
    return [...map.entries()];
  }, [hits]);
  const archived = sessions.filter((m) => m.thread!.archived && matches(m));

  const sessionRow = (m: Extract<Msg, { kind: "msg" }>, isArchived = false) => {
    const t = m.thread!;
    const last = t.replies[t.replies.length - 1];
    const running = t.replies.some((r) => r.live);
    const life = isArchived ? undefined : sessionLife(t);
    const firstAnswer = t.replies.find((r) => emp(r.from) && r.text);
    return (
      <div
        key={m.id}
        data-session={m.id}
        data-archived={isArchived || undefined}
      >
        <Row from={m.from} emp={emp} human={human} active={m.id === threadId}>
          <div className="flex items-start gap-1">
            <div className="min-w-0 flex-1">
              <Who id={m.from} time={m.time} emp={emp} human={human} />
            </div>
            <SessionMenu
              archived={isArchived}
              onRename={
                onRename
                  ? () => {
                      setDraft(t.title || preview(m.text));
                      setEditing(m.id);
                    }
                  : undefined
              }
              onArchive={
                onArchive ? () => onArchive(m.id, !isArchived) : undefined
              }
            />
          </div>
          {editing === m.id ? (
            <Input
              aria-label="Session title"
              value={draft}
              autoFocus
              className="h-7 w-full text-sm"
              onChange={(ev) => setDraft(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && draft.trim()) {
                  onRename?.(m.id, draft.trim());
                  setEditing(null);
                }
                if (ev.key === "Escape") setEditing(null);
              }}
              onBlur={() => {
                if (draft.trim()) onRename?.(m.id, draft.trim());
                setEditing(null);
              }}
            />
          ) : (
            t.title && (
              <div
                className={cn(
                  "truncate font-medium",
                  isArchived && "text-muted-foreground",
                )}
              >
                {t.title}
              </div>
            )
          )}
          {t.scheduled && scheduled && (
            <button
              type="button"
              data-scheduled-chip={t.scheduled.task}
              onClick={() => scheduled.onOpenTask(t.scheduled!.task)}
              title="Started by a scheduled task. Open the task."
              className="mb-0.5 flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-muted-foreground text-xs hover:bg-muted hover:text-foreground"
            >
              <CalendarClockIcon className="size-3" />
              Scheduled · {t.scheduled.name}
            </button>
          )}
          <Body text={m.text} />
          {m.attachments && <AttachmentChips files={m.attachments} />}
          {firstAnswer && (
            <p className="line-clamp-2 border-l-2 pl-2.5 text-[13px] leading-5 text-muted-foreground">
              {preview(firstAnswer.text)}
            </p>
          )}
          {t.alert && (
            <SessionAlertRow
              alert={t.alert}
              onRetry={onRetrySession ? () => onRetrySession(m) : undefined}
            />
          )}
          <button
            onClick={() => onOpen(m.id)}
            title={[t.session, t.ws?.project, t.ws?.branch]
              .filter(Boolean)
              .join(" · ")}
            data-life={life}
            className={cn(
              "lilos-lift relative mt-1 flex w-fit max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-full bg-accent px-2.5 py-1 text-left text-xs hover:bg-foreground/10 [&>*]:shrink-0 [&>*]:whitespace-nowrap",
              life && life !== "closed" && "lilos-life",
              life === "running" && "lilos-life-run",
            )}
          >
            <HermesAvatar name={e.name} className="size-5" />
            <span className="font-medium text-tint-text">
              {t.replies.length} {t.replies.length === 1 ? "reply" : "replies"}
            </span>
            {t.ws && <FolderIcon className="size-3 text-muted-foreground" />}
            {/* #344: no "working" label — the ring around this pill says it.
                Needs-you keeps its badge: it asks the user to act. */}
            {running && last?.phase === "waiting" && (
              <span
                title="Needs you"
                className="grid size-4 place-items-center rounded-full bg-primary font-bold text-[10px] text-primary-foreground"
              >
                <span aria-hidden>!</span>
                <span className="sr-only">{PHASE_LABEL.waiting}</span>
              </span>
            )}
            {life && <span className="sr-only">{LIFE_LABEL[life]}</span>}
            <ChevronRightIcon className="size-3.5 text-muted-foreground" />
          </button>
        </Row>
      </div>
    );
  };

  return (
    <main className="lilos-glass flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="lilos-drag flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:gap-3 sm:px-5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          onClick={onNav}
        >
          <MenuIcon />
        </Button>
        <HermesAvatar name={e.name} status={e.status} className="size-8" />
        <div className="min-w-0">
          <div className="truncate font-semibold text-[17px] tracking-tight">
            {e.name}
          </div>
          <div
            className="flex min-w-0 items-center text-muted-foreground text-xs"
            data-nowline
            onPointerEnter={(ev) => {
              const el = ev.currentTarget;
              const cut = Array.from(el.children).some(
                (c) => c.scrollWidth > c.clientWidth,
              );
              el.title = cut
                ? `${e.role}${e.now ? ` · now: ${e.now}` : ""}`
                : "";
            }}
          >
            {/* #422: the live "now:" half of the line wins outright — while
                a turn runs the role collapses to a 1px sliver so the step
                text reads in full and truncates only against the header
                itself (the role comes back at idle). 1px, not 0: the
                collapse keeps a non-empty box so presence checks on the
                role (ac-29) still see it, while pixels show only "now:".
                Both spans stay mounted while `now` streams in and out: the
                #301 drag-region watcher flips the OS region map on ELEMENT
                childList mutations inside .lilos-drag (text edits don't
                count), so an element that mounts/unmounts mid-turn would
                keep the header's buttons unclickable while it runs. */}
            <span
              className={cn(
                "truncate",
                e.now ? "w-px flex-none overflow-hidden" : "min-w-0 flex-1",
              )}
            >
              {e.role}
            </span>
            <span
              className={cn(
                "truncate",
                e.now ? "min-w-0 flex-1" : "w-px flex-none overflow-hidden",
              )}
            >
              {e.now ? `now: ${e.now}` : ""}
            </span>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {sessions.length > 0 && (
            <div className="relative mr-1 w-36 sm:w-44">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(ev) => setFilter(ev.target.value)}
                placeholder="Filter sessions"
                title={`Private to you. Each message opens its own session; ${e.name} replies in its thread.`}
                className="h-7 rounded-full border-transparent bg-foreground/[0.06] pl-7 text-xs shadow-none dark:bg-white/[0.08]"
              />
            </div>
          )}
          {scheduled && (
            <Button
              variant="ghost"
              size="sm"
              onClick={scheduled.onOpen}
              title="Scheduled tasks"
              data-scheduled-button
              className="gap-1 px-2"
            >
              <CalendarClockIcon />
              <span className="max-sm:sr-only">Scheduled</span>
              {scheduled.count > 0 && (
                <span className="rounded-full bg-foreground/10 px-1.5 text-[11px] tabular-nums">
                  {scheduled.count}
                </span>
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onProfile}
            title="Profile"
            aria-label="Profile"
          >
            <UserIcon />
          </Button>
          {!panelOpen && (
            <Button variant="ghost" size="icon-sm" onClick={onPanel}>
              <PanelRightIcon />
            </Button>
          )}
        </div>
      </header>
      {connection && connection.state !== "connected" && (
        <NotConnectedNotice
          state={connection.state}
          reason={connection.reason}
          onConnect={connection.onConnect}
        />
      )}
      <Conversation className="min-h-0">
        <ConversationContent className="min-h-full justify-end gap-0 p-0 py-3">
          {loading ? (
            <div data-loading-sessions>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  data-session-skeleton
                  className="grid grid-cols-[36px_minmax(0,1fr)] gap-3 px-3 py-2 sm:px-5"
                >
                  <div className="size-9 animate-pulse rounded-full bg-muted" />
                  <div className="space-y-2">
                    <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                    <div className="h-6 w-44 animate-pulse rounded-lg bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          ) : roots.length === 0 &&
            archived.length === 0 &&
            hits.length === 0 ? (
            <ConversationEmptyState
              className="flex-1"
              icon={<HermesAvatar name={e.name} className="size-12" />}
              title={
                q
                  ? `No sessions match “${filter}”`
                  : `Start a session with ${e.name}`
              }
              description={
                q
                  ? onSearchMessages
                    ? "Titles and messages are searched. Clear the filter to see everything."
                    : "Titles and first messages are searched. Clear the filter to see everything."
                  : "Your first message opens a new engine session. Replies stay in its thread."
              }
            />
          ) : (
            <>
              {roots.map((m) => sessionRow(m))}
              {archived.length > 0 && (
                <div className="px-3 sm:px-5">
                  <button
                    onClick={() => setShowArchived(!showArchived)}
                    className="flex items-center gap-1.5 rounded-md py-1 text-muted-foreground text-xs hover:text-foreground"
                  >
                    <ChevronRightIcon
                      className={cn(
                        "size-3.5 transition-transform",
                        showArchived && "rotate-90",
                      )}
                    />
                    <ArchiveIcon className="size-3.5" />
                    Archived ({archived.length})
                  </button>
                  {showArchived && archived.map((m) => sessionRow(m, true))}
                </div>
              )}
              {q && hitGroups.length > 0 && (
                <div className="px-3 sm:px-5" data-message-hits>
                  <div className="flex items-center gap-1.5 py-1 text-muted-foreground text-xs">
                    <SearchIcon className="size-3.5" />
                    Messages
                  </div>
                  {hitGroups.map(([rootId, group]) => {
                    const m = sessions.find((s) => s.id === rootId);
                    const isArchived =
                      group.some((h) => h.archived) || m?.thread?.archived;
                    return (
                      <div key={rootId}>
                        <div className="flex items-center gap-1.5 px-2 pt-1 pb-0.5 text-muted-foreground text-xs">
                          <span className="truncate font-medium text-foreground/80">
                            {m?.thread?.title || m?.text || "Session"}
                          </span>
                          {isArchived && (
                            <span
                              className="flex shrink-0 items-center gap-0.5"
                              data-archived-hit
                            >
                              <ArchiveIcon className="size-3" /> archived
                            </span>
                          )}
                        </div>
                        {group.map((h) => (
                          <button
                            key={h.messageId}
                            type="button"
                            data-message-hit={h.messageId}
                            onClick={() =>
                              onOpenHit ? onOpenHit(h) : onOpen(h.rootId)
                            }
                            className="block w-full rounded-md py-1.5 pr-2 pl-6 text-left text-xs hover:bg-accent/50"
                          >
                            <span className="text-muted-foreground">
                              {emp(h.from)?.name ?? human(h.from)?.name}
                            </span>
                            <span className="mx-1.5 text-muted-foreground">
                              ·
                            </span>
                            <span className="text-muted-foreground">
                              {h.time}
                            </span>
                            <div className="line-clamp-2 break-words text-foreground/90">
                              <Marks text={h.snippet} />
                            </div>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                  {hits.length >= 50 && (
                    <div className="px-2 py-1 text-muted-foreground text-xs">
                      More matches exist — refine the search.
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <Composer
        placeholder={
          pickedFolder
            ? `New session with ${e.name} in ${folderLabel(pickedFolder, folders)}…`
            : `New session with ${e.name}…`
        }
        employees={mentionables ?? []}
        onSearchFiles={onSearchFiles}
        hint={wsHint(pickedFolder, pick, !onWorktree)}
        onSend={(t, files) => onSend(t, pick, files)}
        draft={composerDraft}
        onDraftChange={onDraftChange}
        lastSent={lastSent}
        accept={accept}
        maxFileSize={maxFileSize}
        maxFiles={maxFiles}
        onAttachError={onAttachError}
        queued={
          composerNote ? (
            <div
              data-composer-note
              className="mb-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-50/60 px-3 py-2 text-amber-900 text-xs dark:bg-amber-950/20 dark:text-amber-200"
            >
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {typeof composerNote === "string" ? (
                  <InlineCodeText text={composerNote} />
                ) : (
                  composerNote
                )}
              </span>
            </div>
          ) : undefined
        }
        tools={
          <>
            {folders.length || onAddFolder ? (
              <WorkspacePicker
                folders={folders}
                pick={pick}
                setPick={setPick}
                onAddFolder={onAddFolder}
                onWorktree={onWorktree}
              />
            ) : null}
            {onModel && models?.length ? (
              <ModelPicker
                value={modelChoice ?? choiceFor(e.model, models)}
                models={models}
                onChoice={onModel}
                {...picker}
              />
            ) : null}
            {access !== undefined && onAccess ? (
              <AccessPill access={access} onAccess={onAccess} />
            ) : null}
          </>
        }
      />
    </main>
  );
}

/* Profile card in the right panel. Edit/remove are app actions passed in; when the linked
   engine profile is not on the engine the card shows the missing state + Switch profile. */
export function EmployeeCard({
  e,
  profiles,
  engineName,
  ownerName,
  models,
  onDM,
  onEdit,
  onSwitchProfile,
}: {
  e: Employee;
  profiles: EngineProfile[];
  /** The engine's own name (`engine-fake`, `hermes`, ...) for the Engine row. */
  engineName?: string;
  /** The signed-in human's name for the "owned by …" line (#118). */
  ownerName: string;
  /** Catalog to resolve the model's display name; falls back to the id (#194). */
  models?: ModelOption[];
  onDM: () => void;
  onEdit?: () => void;
  onSwitchProfile?: (profileId: string) => void;
}) {
  const missing = !profiles.some((p) => p.id === e.profile);
  return (
    <div className="space-y-3 p-3">
      <div className="rounded-xl border bg-background p-4">
        <div className="flex items-center gap-3">
          <HermesAvatar name={e.name} status={e.status} className="size-12" />
          <div>
            <div className="font-semibold text-base">{e.name}</div>
            <div className="text-muted-foreground text-xs">
              {e.role} · owned by {ownerName}
            </div>
          </div>
          <div className="ml-auto flex gap-1">
            {onEdit && (
              <Button size="sm" variant="ghost" onClick={onEdit}>
                <PencilIcon />
                Edit
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={onDM}>
              <MessageSquareIcon />
              Message
            </Button>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-muted-foreground">Engine</dt>
          <dd>{engineName ?? "engine"}</dd>
          <dt className="text-muted-foreground">Profile</dt>
          <dd className="font-mono text-xs">{e.profile}</dd>
          <dt className="text-muted-foreground">Model</dt>
          <dd>{models?.find((m) => m.id === e.model)?.name ?? e.model}</dd>
          <dt className="text-muted-foreground">Now</dt>
          <dd>
            {e.now ? (
              e.now
            ) : (
              /* #504: an empty row reads broken — say it in muted text,
                 reusing #422's "Idle" wording. */
              <span className="text-muted-foreground">Idle</span>
            )}
          </dd>
        </dl>
        {missing && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 text-xs">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertTriangleIcon className="size-3.5 shrink-0" />
              Profile missing
            </div>
            <p className="mt-1">
              Profile <code>{e.profile}</code> isn't on the engine. The employee
              can't run until you point it at a profile that exists — its memory
              and skills come along unchanged.
            </p>
            {onSwitchProfile && (
              <Select onValueChange={(v) => onSwitchProfile(String(v))}>
                <SelectTrigger size="sm" className="mt-2 w-full">
                  <SelectValue placeholder="Switch profile…" />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.id} · {p.skills} skills
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}
      </div>
      <div className="rounded-xl border bg-background p-4">
        <div className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Instructions (SOUL.md)
        </div>
        {e.instructions ? (
          <p>{e.instructions}</p>
        ) : (
          /* #504: a profile with no SOUL.md gets an empty state instead of
             a lone heading; the Edit link renders only with its handler
             (D-#19). */
          <p className="text-muted-foreground">
            No instructions yet.
            {onEdit && (
              <>
                {" "}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={onEdit}
                >
                  Edit
                </button>
              </>
            )}
          </p>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        Persona, memory and skills live in the engine profile. LilOS stores only
        the company record: role and channels.
      </p>
    </div>
  );
}
