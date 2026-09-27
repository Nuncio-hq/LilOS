import {
  AlertTriangleIcon,
  ArchiveIcon,
  ChevronRightIcon,
  CircleDotIcon,
  EllipsisIcon,
  FolderIcon,
  GitBranchIcon,
  LockIcon,
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
import { type ReactNode, useState } from "react";
import { Composer } from "../chat/composer";
import { choiceFor, ModelPicker } from "../chat/model-picker";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "../components/ai-elements/conversation";
import { Badge } from "../components/ui/badge";
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
import { AttachmentChips } from "../conversation/turns";
import { WorkspacePicker, wsHint } from "../dialogs/workspace-picker";
import { Body, Row, Who } from "../feed/row";
import { PHASE_LABEL, preview } from "../lib/helpers";
import { InlineCodeText } from "../lib/inline-code";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type {
  AttachedFile,
  EmpFn,
  Employee,
  EngineProfile,
  Folder,
  HumanFn,
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
      <DropdownMenuContent align="end" className="w-44">
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
  panelOpen,
  onPanel,
  folders,
  pick,
  setPick,
  onAddFolder,
  loading,
  onRename,
  onArchive,
  onRetrySession,
  accept,
  maxFileSize,
  onAttachError,
  models,
  modelChoice,
  onModel,
  picker,
  composerNote,
}: {
  e: Employee;
  feed: Msg[];
  threadId: string | null;
  emp: EmpFn;
  human: HumanFn;
  onNav: () => void;
  onProfile: () => void;
  onOpen: (id: string) => void;
  onSend: (t: string, pick?: WsPick, files?: AttachedFile[]) => void;
  panelOpen: boolean;
  onPanel: () => void;
  folders: Folder[];
  pick: WsPick;
  setPick: (p: WsPick) => void;
  /* Folder picking lands with the workspace slice (#11) — omit to hide it. */
  onAddFolder?: () => void;
  loading?: boolean;
  onRename?: (id: string, title: string) => void;
  onArchive?: (id: string, archived: boolean) => void;
  onRetrySession?: (root: Extract<Msg, { kind: "msg" }>) => void;
  /* Composer attachment types the host accepts; absent = no attach UI. */
  accept?: string;
  /* Attachment byte cap + where rejections surface (issue #31). */
  maxFileSize?: number;
  onAttachError?: (message: string) => void;
  /* Model for the NEW session: starts at the employee's default (never the last
     session's pick). No onModel → no picker (D-#19). */
  models?: ModelOption[];
  modelChoice?: ModelChoice;
  onModel?: (c: ModelChoice) => void;
  picker?: ModelPickerExtras;
  /* Plain reason the engine is unavailable ("Hermes not found at …", #85);
     renders above the composer so a dead engine never looks sendable. */
  composerNote?: ReactNode;
}) {
  const pickFolder = folders.find((x) => x.id === pick.folder);
  const [filter, setFilter] = useState("");
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
  const archived = sessions.filter((m) => m.thread!.archived && matches(m));

  const sessionRow = (m: Extract<Msg, { kind: "msg" }>, isArchived = false) => {
    const t = m.thread!;
    const last = t.replies[t.replies.length - 1];
    const running = t.replies.some((r) => r.live);
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
            className="mt-1 flex w-fit max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-background px-2 py-1.5 text-left text-xs hover:border-foreground/30 [&>*]:shrink-0 [&>*]:whitespace-nowrap"
          >
            <HermesAvatar name={e.name} className="size-5" />
            <span className="font-medium text-blue-600">
              {t.replies.length} {t.replies.length === 1 ? "reply" : "replies"}
            </span>
            <code className="rounded bg-muted px-1 text-muted-foreground">
              {t.session}
            </code>
            {t.ws && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <FolderIcon className="size-3" />
                {t.ws.project}
                <GitBranchIcon className="size-3" />
                <span className="font-mono text-emerald-700">
                  {t.ws.branch}
                </span>
              </span>
            )}
            {running ? (
              <span
                className={cn(
                  "flex items-center gap-1",
                  last?.phase === "waiting"
                    ? "font-medium text-amber-600"
                    : "text-muted-foreground",
                )}
              >
                <CircleDotIcon className="size-3 animate-pulse text-amber-500" />
                {last?.phase ? PHASE_LABEL[last.phase] : "working"}
              </span>
            ) : (
              last && (
                <span className="text-muted-foreground">last {last.time}</span>
              )
            )}
            <ChevronRightIcon className="size-3.5 text-muted-foreground" />
          </button>
        </Row>
      </div>
    );
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:gap-3 sm:px-5">
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
          <div className="flex items-center gap-1.5 font-semibold text-base">
            <span className="truncate">{e.name}</span>
            <Badge
              variant="secondary"
              className="h-4 shrink-0 px-1.5 text-[10px]"
            >
              EMPLOYEE
            </Badge>
          </div>
          <div className="truncate text-muted-foreground text-xs">
            {e.role}
            {e.now ? ` · now: ${e.now}` : ""}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 gap-1">
          <Button variant="outline" size="sm" onClick={onProfile}>
            <UserIcon />
            <span className="hidden sm:inline">Profile</span>
          </Button>
          {!panelOpen && (
            <Button variant="ghost" size="icon-sm" onClick={onPanel}>
              <PanelRightIcon />
            </Button>
          )}
        </div>
      </header>
      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-3 py-1.5 sm:px-5">
        <LockIcon className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          Private to you. Each message you send here opens its own engine
          session; {e.name} replies in its thread.
        </span>
        {sessions.length > 0 && (
          <div className="relative w-44 shrink-0 sm:w-56">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(ev) => setFilter(ev.target.value)}
              placeholder="Filter sessions"
              className="h-7 pl-7 text-xs"
            />
          </div>
        )}
      </div>
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
          ) : roots.length === 0 && archived.length === 0 ? (
            <ConversationEmptyState
              icon={<HermesAvatar name={e.name} className="size-12" />}
              title={
                q
                  ? `No sessions match “${filter}”`
                  : `Start a session with ${e.name}`
              }
              description={
                q
                  ? "Titles and first messages are searched. Clear the filter to see everything."
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
            </>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <Composer
        placeholder={
          pickFolder
            ? `New session with ${e.name} in ${pickFolder.project}…`
            : `New session with ${e.name}…`
        }
        employees={[]}
        hint={wsHint(pickFolder, pick)}
        onSend={(t, files) => onSend(t, pick, files)}
        accept={accept}
        maxFileSize={maxFileSize}
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
  onDM,
  onEdit,
  onSwitchProfile,
}: {
  e: Employee;
  profiles: EngineProfile[];
  /** The engine's own name (`engine-fake`, `hermes`, ...) for the Engine row. */
  engineName?: string;
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
              {e.role} · owned by Oscar
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
          <dd>{e.model}</dd>
          <dt className="text-muted-foreground">Now</dt>
          <dd>{e.now}</dd>
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
        <p>{e.instructions}</p>
      </div>
      <p className="text-muted-foreground text-xs">
        Persona, memory and skills live in the engine profile. LilOS stores only
        the company record: role and channels.
      </p>
    </div>
  );
}
