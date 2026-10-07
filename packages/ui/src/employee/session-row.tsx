import {
  ArchiveIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FolderIcon,
  MoonIcon,
  PencilIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { memo } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import { AttachmentChips } from "../conversation/turns";
import { Body, Row, Who } from "../feed/row";
import {
  LIFE_LABEL,
  PHASE_LABEL,
  preview,
  sessionLife,
  threadState,
} from "../lib/helpers";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type { EmpFn, HumanFn, Msg, SessionAlert } from "../types";

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
            aria-label="Thread actions"
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
            Rename thread
          </DropdownMenuItem>
        )}
        {onArchive && (
          <DropdownMenuItem onClick={onArchive}>
            {archived ? <RotateCcwIcon /> : <ArchiveIcon />}
            {archived ? "Unarchive thread" : "Archive thread"}
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

type SessionMsg = Extract<Msg, { kind: "msg" }>;

/* #569: one DM session row, memoized on the app's folded Msg — the fold
   cache rebuilds ONLY the session a delta belongs to, so an unchanged Msg
   plus the caller's stable callbacks let a streamed word re-render just
   the one row it lands in. Scalar props only (editing/draft are the
   host's rename state projected onto this row). */
export const SessionRow = memo(function SessionRow({
  m,
  archived = false,
  active,
  editing,
  draft,
  empName,
  emp,
  human,
  onOpenTask,
  onEditDraft,
  onEditing,
  onRename,
  onArchive,
  onOpen,
  onRetrySession,
}: {
  m: SessionMsg;
  archived?: boolean;
  active: boolean;
  /* Rename-in-place: `editing` = this row holds the Input; `draft` is the
     shared text ("" for rows not being renamed, so they stay memoized). */
  editing: boolean;
  draft: string;
  empName: string;
  emp: EmpFn;
  human: HumanFn;
  /* Scheduled-chip click (#136) — the row renders it when the session
     carries `scheduled` AND the host passed a handler. */
  onOpenTask?: (taskId: string) => void;
  onEditDraft: (v: string) => void;
  onEditing: (id: string | null) => void;
  onRename?: (id: string, title: string) => void;
  onArchive?: (id: string, archived: boolean) => void;
  onOpen: (id: string) => void;
  onRetrySession?: (m: SessionMsg) => void;
}) {
  const t = m.thread;
  if (!t) return null;
  const life = archived ? undefined : sessionLife(t);
  const firstAnswer = t.replies.find((r) => emp(r.from) && r.text);
  /* #583 AC-2: the row says its state in words; #585: system notes don't
     count as replies; #583 AC-3: live background jobs say so. */
  const replyCount = t.replies.filter((r) => !r.system).length;
  const state = archived ? undefined : threadState(t);
  const bgJobs = t.jobs?.filter((j) => j.status === "running").length ?? 0;
  const sched = t.scheduled;
  return (
    <div data-session={m.id} data-archived={archived || undefined}>
      <Row from={m.from} emp={emp} human={human} active={active}>
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <Who id={m.from} time={m.time} emp={emp} human={human} />
          </div>
          <SessionMenu
            archived={archived}
            onRename={
              onRename
                ? () => {
                    onEditDraft(t.title || preview(m.text));
                    onEditing(m.id);
                  }
                : undefined
            }
            onArchive={onArchive ? () => onArchive(m.id, !archived) : undefined}
          />
        </div>
        {editing ? (
          <Input
            aria-label="Thread title"
            value={draft}
            autoFocus
            className="h-7 w-full text-sm"
            onChange={(ev) => onEditDraft(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" && draft.trim()) {
                onRename?.(m.id, draft.trim());
                onEditing(null);
              }
              if (ev.key === "Escape") onEditing(null);
            }}
            onBlur={() => {
              if (draft.trim()) onRename?.(m.id, draft.trim());
              onEditing(null);
            }}
          />
        ) : (
          t.title && (
            <div
              className={cn(
                "truncate font-medium",
                archived && "text-muted-foreground",
              )}
            >
              {t.title}
            </div>
          )
        )}
        {sched && onOpenTask && (
          <button
            type="button"
            data-scheduled-chip={sched.task}
            onClick={() => onOpenTask(sched.task)}
            title="Started by a scheduled task. Open the task."
            className="mb-0.5 flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-muted-foreground text-xs hover:bg-muted hover:text-foreground"
          >
            <CalendarClockIcon className="size-3" />
            Scheduled · {sched.name}
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
          <HermesAvatar name={empName} className="size-5" />
          <span className="font-medium text-tint-text">
            {replyCount} {replyCount === 1 ? "reply" : "replies"}
          </span>
          {t.ws && <FolderIcon className="size-3 text-muted-foreground" />}
          {/* #583 AC-2: every row states itself — needs you / running /
              failed / stopped. Needs-you keeps its "!" badge too: it asks
              the user to act. */}
          {state?.word === "needs you" && (
            <span
              title="Needs you"
              className="grid size-4 place-items-center rounded-full bg-primary font-bold text-[10px] text-primary-foreground"
            >
              <span aria-hidden>!</span>
              <span className="sr-only">{PHASE_LABEL.waiting}</span>
            </span>
          )}
          {state && (
            <span
              data-thread-state={state.word}
              className={cn(
                "font-medium",
                state.word === "needs you" && "text-amber-600",
                state.word === "running" && "text-work",
                state.word === "failed" && "text-red-600",
                state.word === "stopped" &&
                  "text-muted-foreground dark:text-foreground/80",
              )}
            >
              {state.word}
            </span>
          )}
          {bgJobs > 0 && (
            <span
              data-bg-jobs
              className="text-muted-foreground"
              title={`${bgJobs} running in background`}
            >
              {bgJobs} in background
            </span>
          )}
          {life && <span className="sr-only">{LIFE_LABEL[life]}</span>}
          <ChevronRightIcon className="size-3.5 text-muted-foreground" />
        </button>
      </Row>
    </div>
  );
});
