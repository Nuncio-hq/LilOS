import {
  ArrowUpIcon,
  CheckCheckIcon,
  FolderIcon,
  GitBranchIcon,
  MoonIcon,
  PanelRightIcon,
  PinIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useState } from "react";
import { Shimmer } from "../components/ai-elements/shimmer";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type { ModelChoice, WsPick } from "../types";
import { AgentPicker } from "./v2-agent-picker";
import { STATE_WORD, StateDot } from "./v2-bits";
import {
  type V2ModelKit,
  V2ModelPicker,
  V2WorkspacePicker,
} from "./v2-pickers";
import type { V2Agent, V2Project, V2Thread } from "./v2-types";
import { ProjectChip } from "./v2-viz";
import { ChangesCard, LiveStep, WorkLog } from "./v2-worklog";

const iconBtn =
  "grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground aria-pressed:bg-foreground/[0.07] aria-pressed:text-foreground [&_svg]:size-4";

/* What is waiting on you, in the conversation's own column, right above the
   composer. One card at a time, one obvious action. */
function AskCard({
  t,
  agent,
  onAnswer,
}: {
  t: V2Thread;
  agent?: V2Agent;
  onAnswer: (answer: string) => void;
}) {
  if (!t.ask) return null;
  const a = t.ask;
  return (
    <div className="lilos-rise mx-auto mb-3 w-full max-w-[44rem] rounded-2xl bg-amber-500/[0.08] p-4 ring-1 ring-amber-500/25">
      <div className="flex items-center gap-2 text-[12px] text-amber-800 dark:text-amber-300">
        <StateDot state="needs" />
        {agent?.name} {a.kind === "approval" ? "asks to" : "asks"}
      </div>
      <p className="mt-1.5 font-medium text-[15px] leading-snug">{a.text}</p>
      {a.detail && (
        <code className="mt-2 block truncate rounded-lg bg-background/70 px-2.5 py-1.5 font-mono text-[12px] text-foreground/80">
          {a.detail}
        </code>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {a.kind === "approval" ? (
          <>
            <button
              type="button"
              onClick={() => onAnswer("Allowed once")}
              className="h-8 rounded-full bg-foreground px-4 font-medium text-[13px] text-background transition-transform active:scale-[0.97]"
            >
              Allow once
            </button>
            <button
              type="button"
              onClick={() => onAnswer("Allowed for this thread")}
              className="h-8 rounded-full px-3 text-[13px] text-foreground/80 ring-1 ring-foreground/15 hover:bg-foreground/[0.05]"
            >
              This thread
            </button>
            <button
              type="button"
              onClick={() => onAnswer("Denied")}
              className="h-8 rounded-full px-3 text-[13px] text-foreground/80 hover:bg-foreground/[0.05]"
            >
              Deny
            </button>
          </>
        ) : (
          (a.options ?? []).map((o, i) => (
            <button
              key={o}
              type="button"
              onClick={() => onAnswer(o)}
              className={cn(
                "h-8 rounded-full px-4 text-[13px] transition-transform active:scale-[0.97]",
                i === 0
                  ? "bg-foreground font-medium text-background"
                  : "text-foreground/80 ring-1 ring-foreground/15 hover:bg-foreground/[0.05]",
              )}
            >
              {o}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/* The open thread. Header carries the place (project) and the actions that
   end a thread's life in the list: Settle, Snooze, Pin. */
export function V2ThreadView({
  t,
  agents,
  projects,
  modelKit,
  wbOpen,
  onWorkbench,
  onAgent,
  onModel,
  onAnswer,
  onSend,
  onSettle,
  onSnooze,
  onPin,
}: {
  t: V2Thread;
  agents: V2Agent[];
  projects: V2Project[];
  modelKit: V2ModelKit;
  /** The Workbench panel is open beside the thread. */
  wbOpen: boolean;
  onWorkbench: () => void;
  onAgent: (id: string) => void;
  onModel: (c: ModelChoice) => void;
  onAnswer: (answer: string) => void;
  onSend: (text: string) => void;
  onSettle: () => void;
  onSnooze: () => void;
  onPin: () => void;
}) {
  const agent = agents.find((a) => a.id === t.agentId);
  const pIndex = projects.findIndex((p) => p.id === t.projectId);
  const project = projects[pIndex];
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="lilos-drag flex h-[52px] shrink-0 items-center gap-2.5 pr-2 pl-5">
        <ProjectChip
          name={project?.path ? project.name : "No project"}
          index={project?.path ? pIndex : -1}
        />
        <h1 className="min-w-0 truncate font-semibold text-[14px]">
          {t.title}
        </h1>
        {t.state !== "idle" && (
          <span title={STATE_WORD[t.state]} className="flex shrink-0">
            <StateDot state={t.state} />
          </span>
        )}
        {project?.path && (
          <span
            title={project.path}
            className="hidden min-w-0 shrink items-center gap-1 font-mono text-[11.5px] text-muted-foreground xl:flex"
          >
            <GitBranchIcon className="size-3 shrink-0" />
            <span className="truncate">lilos/{t.id}</span>
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center">
          <button
            type="button"
            onClick={onPin}
            aria-pressed={!!t.pinned}
            aria-label={t.pinned ? "Unpin" : "Pin"}
            title={t.pinned ? "Unpin" : "Pin"}
            className={iconBtn}
          >
            <PinIcon className={cn(t.pinned && "fill-current")} />
          </button>
          <button
            type="button"
            onClick={onSnooze}
            aria-label="Snooze"
            title="Snooze until tomorrow"
            className={iconBtn}
          >
            <MoonIcon />
          </button>
          <button
            type="button"
            onClick={onSettle}
            aria-label={t.state === "settled" ? "Bring back" : "Settle"}
            title={t.state === "settled" ? "Bring back" : "Settle"}
            className={iconBtn}
          >
            {t.state === "settled" ? <RotateCcwIcon /> : <CheckCheckIcon />}
          </button>
          <span className="mx-1 h-4 w-px bg-foreground/10" />
          <button
            type="button"
            onClick={onWorkbench}
            aria-pressed={wbOpen}
            aria-label="Workbench"
            title="Workbench  ⌘B"
            data-v2-wb-toggle
            className={iconBtn}
          >
            <PanelRightIcon />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,#000_20px)]">
        <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-7 px-6 pt-8 pb-6">
          {t.messages.map((m, i) =>
            m.from === "you" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] rounded-[20px] bg-foreground/[0.06] px-4 py-2.5 text-[14.5px] leading-relaxed">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={i} className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-[12.5px]">
                  <HermesAvatar name={agent?.name} className="size-5" />
                  <span className="font-medium">{agent?.name}</span>
                  <span className="text-muted-foreground">{m.time}</span>
                </div>
                {m.work && <WorkLog steps={m.work} />}
                <p className="text-[14.5px] text-foreground/90 leading-[1.65]">
                  {m.text}
                </p>
                <ChangesCard msg={m} />
              </div>
            ),
          )}
          {t.state === "working" && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[12.5px]">
                <HermesAvatar
                  name={agent?.name}
                  status="busy"
                  className="size-5"
                />
                <span className="font-medium">{agent?.name}</span>
                <Shimmer as="span" duration={1.4} className="text-[12.5px]">
                  {t.line ?? "Working…"}
                </Shimmer>
              </div>
              {t.live && <LiveStep live={t.live} />}
            </div>
          )}
        </div>
      </div>

      {t.state === "needs" && (
        <div className="px-6">
          <AskCard t={t} agent={agent} onAnswer={onAnswer} />
        </div>
      )}
      <Composer
        placeholder={`Message ${agent?.name ?? "the agent"}`}
        onSend={onSend}
        tools={
          <>
            <AgentPicker agents={agents} value={t.agentId} onPick={onAgent} />
            <V2ModelPicker
              kit={modelKit}
              value={t.choice ?? { model: t.model }}
              onChoice={onModel}
            />
          </>
        }
      />
    </main>
  );
}

/* A calm composer: one rounded surface, the pickers inside it, a round send
   button that only lights up when there is something to send. */
export function Composer({
  placeholder,
  onSend,
  tools,
  autoFocus,
}: {
  placeholder: string;
  onSend: (text: string) => void;
  tools?: React.ReactNode;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const send = () => {
    const v = text.trim();
    if (!v) return;
    onSend(v);
    setText("");
  };
  return (
    <div className="shrink-0 px-6 pb-5">
      <div className="mx-auto w-full max-w-[44rem] rounded-[22px] bg-background/80 p-2 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(20_30_60/0.18)] ring-1 ring-foreground/[0.08] transition-shadow focus-within:ring-foreground/20 dark:bg-white/[0.04]">
        <textarea
          // biome-ignore lint/a11y/noAutofocus: the new-thread view exists to type into
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder={placeholder}
          className="block w-full resize-none bg-transparent px-2.5 pt-1.5 text-[14.5px] leading-relaxed outline-none placeholder:text-muted-foreground/80"
        />
        <div className="flex items-center gap-1">
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            {tools}
          </div>
          <button
            type="button"
            onClick={send}
            disabled={!text.trim()}
            aria-label="Send"
            className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background transition-all active:scale-95 disabled:bg-foreground/10 disabled:text-foreground/40"
          >
            <ArrowUpIcon className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* A new thread: the same column, empty, with the three pickers. */
export function V2NewThread({
  agents,
  projects,
  modelKit,
  pick,
  agentId,
  choice,
  onPick,
  onAgent,
  onModel,
  onAddProject,
  onSend,
}: {
  agents: V2Agent[];
  projects: V2Project[];
  modelKit: V2ModelKit;
  pick: WsPick;
  agentId: string;
  choice: ModelChoice;
  onPick: (p: WsPick) => void;
  onAgent: (id: string) => void;
  onModel: (c: ModelChoice) => void;
  onAddProject: () => void;
  onSend: (text: string) => void;
}) {
  const agent = agents.find((a) => a.id === agentId);
  const project = projects.find((p) => p.id === pick.folder);
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="lilos-drag h-[52px] shrink-0" />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-10">
        <HermesAvatar name={agent?.name} className="size-12" />
        <h1 className="mt-4 text-balance text-center font-semibold text-[22px] tracking-tight">
          What should {agent?.name} work on?
        </h1>
        {project?.path && (
          <p className="mt-1.5 flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground">
            <FolderIcon className="size-3.5" />
            {project.path}
          </p>
        )}
      </div>
      <Composer
        placeholder="Describe the task"
        onSend={onSend}
        autoFocus
        tools={
          <>
            <V2WorkspacePicker
              projects={projects}
              pick={pick}
              setPick={onPick}
              onAddProject={onAddProject}
            />
            <AgentPicker agents={agents} value={agentId} onPick={onAgent} />
            <V2ModelPicker kit={modelKit} value={choice} onChoice={onModel} />
          </>
        }
      />
    </main>
  );
}
