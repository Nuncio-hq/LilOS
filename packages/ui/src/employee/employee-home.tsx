import {
  ChevronRightIcon,
  CircleDotIcon,
  FolderIcon,
  GitBranchIcon,
  LockIcon,
  MenuIcon,
  MessageSquareIcon,
  PanelRightIcon,
  UserIcon,
} from "lucide-react";
import { Composer } from "../chat/composer";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "../components/ai-elements/conversation";
import { Suggestion, Suggestions } from "../components/ai-elements/suggestion";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { WorkspacePicker, wsHint } from "../dialogs/workspace-picker";
import { Body, Row, Who } from "../feed/row";
import { PHASE_LABEL, preview, RESPOND } from "../lib/helpers";
import { HermesAvatar } from "../shell/avatars";
import type { EmpFn, Employee, Folder, HumanFn, Msg, WsPick } from "../types";

/* Employee screen (DM). Left: the conversation list — each top-level message is ONE Hermes session.
   Right panel: the open session as a thread. Composer at the bottom always starts a NEW session.
   `suggestions` is the app's per-employee suggestion list (mock data stays in the app). */
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
  suggestions,
}: {
  e: Employee;
  feed: Msg[];
  threadId: string | null;
  emp: EmpFn;
  human: HumanFn;
  onNav: () => void;
  onProfile: () => void;
  onOpen: (id: string) => void;
  onSend: (t: string, pick?: WsPick) => void;
  panelOpen: boolean;
  onPanel: () => void;
  folders: Folder[];
  pick: WsPick;
  setPick: (p: WsPick) => void;
  onAddFolder: () => void;
  suggestions: string[];
}) {
  const pickFolder = folders.find((x) => x.id === pick.folder);
  const roots = feed.filter(
    (m): m is Extract<Msg, { kind: "msg" }> => m.kind === "msg" && !!m.thread,
  );
  return (
    <main className="flex min-h-0 min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:gap-3 sm:px-5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          onClick={onNav}
        >
          <MenuIcon />
        </Button>
        <HermesAvatar status={e.status} className="size-8" />
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
            {e.role} · now: {e.now}
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
      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-muted-foreground text-xs sm:px-5">
        <LockIcon className="size-3 shrink-0" />
        <span className="min-w-0 truncate">
          Private to you. Each message you send here opens its own Hermes
          session; {e.name} replies in its thread.
        </span>
      </div>
      <Conversation className="min-h-0">
        <ConversationContent className="min-h-full justify-end gap-0 p-0 py-3">
          {roots.length === 0 ? (
            <ConversationEmptyState
              icon={<HermesAvatar className="size-12" />}
              title={`Start a session with ${e.name}`}
              description="Your first message opens a new Hermes session. Replies stay in its thread."
            />
          ) : (
            roots.map((m) => {
              const t = m.thread!;
              const last = t.replies[t.replies.length - 1];
              const running = t.replies.some((r) => r.live);
              const firstAnswer = t.replies.find((r) => emp(r.from) && r.text);
              return (
                <Row
                  key={m.id}
                  from={m.from}
                  emp={emp}
                  human={human}
                  active={m.id === threadId}
                >
                  <Who id={m.from} time={m.time} emp={emp} human={human} />
                  <Body text={m.text} />
                  {firstAnswer && (
                    <p className="line-clamp-2 border-l-2 pl-2.5 text-[13px] leading-5 text-muted-foreground">
                      {preview(firstAnswer.text)}
                    </p>
                  )}
                  <button
                    onClick={() => onOpen(m.id)}
                    className="mt-1 flex w-fit max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-background px-2 py-1.5 text-left text-xs hover:border-foreground/30 [&>*]:shrink-0 [&>*]:whitespace-nowrap"
                  >
                    <HermesAvatar className="size-5" />
                    <span className="font-medium text-blue-600">
                      {t.replies.length}{" "}
                      {t.replies.length === 1 ? "reply" : "replies"}
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
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <CircleDotIcon className="size-3 animate-pulse text-amber-500" />
                        {last?.phase ? PHASE_LABEL[last.phase] : "working"}
                      </span>
                    ) : (
                      last && (
                        <span className="text-muted-foreground">
                          last {last.time}
                        </span>
                      )
                    )}
                    <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                  </button>
                </Row>
              );
            })
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="shrink-0 px-2 sm:px-3">
        <Suggestions className="items-center py-1">
          <span className="text-muted-foreground text-xs">New session:</span>
          {suggestions.map((s) => (
            <Suggestion
              key={s}
              suggestion={s}
              onClick={(t) => onSend(t, pick)}
              className="h-7 text-xs"
            />
          ))}
        </Suggestions>
      </div>
      <Composer
        placeholder={
          pickFolder
            ? `New session with ${e.name} in ${pickFolder.project}…`
            : `New session with ${e.name}…`
        }
        employees={[]}
        hint={wsHint(pickFolder, pick)}
        onSend={(t) => onSend(t, pick)}
        tools={
          <WorkspacePicker
            folders={folders}
            pick={pick}
            setPick={setPick}
            onAddFolder={onAddFolder}
          />
        }
      />
    </main>
  );
}

/* Profile card in the right panel. */
export function EmployeeCard({ e, onDM }: { e: Employee; onDM: () => void }) {
  return (
    <div className="space-y-3 p-3">
      <div className="rounded-xl border bg-background p-4">
        <div className="flex items-center gap-3">
          <HermesAvatar status={e.status} className="size-12" />
          <div>
            <div className="font-semibold text-base">{e.name}</div>
            <div className="text-muted-foreground text-xs">
              {e.role} · owned by Oscar
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={onDM}
          >
            <MessageSquareIcon />
            Message
          </Button>
        </div>
        <dl className="mt-4 grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-muted-foreground">Engine</dt>
          <dd>Hermes</dd>
          <dt className="text-muted-foreground">Profile</dt>
          <dd className="font-mono text-xs">{e.profile}</dd>
          <dt className="text-muted-foreground">Model</dt>
          <dd>{e.model}</dd>
          <dt className="text-muted-foreground">Responds to</dt>
          <dd>{RESPOND[e.respondTo]}</dd>
          <dt className="text-muted-foreground">Now</dt>
          <dd>{e.now}</dd>
        </dl>
      </div>
      <div className="rounded-xl border bg-background p-4">
        <div className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Instructions (SOUL.md)
        </div>
        <p>{e.instructions}</p>
      </div>
      <p className="text-muted-foreground text-xs">
        Persona, memory and skills live in the Hermes profile. LilOS stores only
        the company record: role, channels, who may direct it.
      </p>
    </div>
  );
}
