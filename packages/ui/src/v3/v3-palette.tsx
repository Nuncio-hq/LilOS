import { CornerDownLeftIcon, SparklesIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { Avatar, Btn, Kbd, Spinner } from "./v3-bits";
import { MessageHitRow, useMessageHits } from "./v3-palette-messages";
import { Footer, PlanView } from "./v3-palette-plan";
import type { V3Actions, V3Data, V3Draft, V3Route } from "./v3-types";

type Plan = Extract<V3Draft, { kind: "plan" }>;
type Jump = { label: string; hint: string; route: V3Route };

const TRY = [
  "Launch QRit Pro on Product Hunt next Tuesday",
  "What is everyone doing?",
  "Add a streak counter to HeardBack",
];

/* ⌘K replaces the chat with the CEO. One line in; a question gets a reply
   right here, work gets a draft plan (tickets, owners, order, time, cost,
   where it will ask you) that only becomes real when you press Start. The
   same box doubles as search: typed text also matches tickets, people,
   threads, goals and projects to jump to (threads after people; six rows),
   and, where the app can search them, what was said in any thread (a
   Messages group under those: pick one and its thread opens at the message). */
export function V3Palette({
  data,
  seed,
  draft,
  onStart,
  onClose,
  go,
  searchMessages,
  onOpenMessage,
}: {
  data: V3Data;
  seed: string;
  /** The CEO behind it; absent, ⌘K only searches and jumps. */
  draft?: (text: string, data: V3Data) => V3Draft;
  onStart: (plan: Plan, text: string) => void;
  onClose: () => void;
  go: (r: V3Route) => void;
  /** The app's message search; absent, there is no Messages group. */
  searchMessages?: V3Actions["searchMessages"];
  /** Opens a thread scrolled to one of its messages. */
  onOpenMessage?: (threadId: string, messageId: string) => void;
}) {
  const [text, setText] = useState(seed);
  const [phase, setPhase] = useState<"input" | "thinking" | "result">("input");
  const [result, setResult] = useState<V3Draft | null>(null);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (phase === "input") input.current?.focus();
  }, [phase]);

  const jumps = useMemo<Jump[]>(() => {
    const q = text.trim().toLowerCase();
    if (!q) {
      const work: Jump[] = data.features.tickets
        ? [{ label: "Work", hint: "every ticket", route: { page: "work" } }]
        : [];
      return [
        {
          label: "Needs you",
          hint: `${data.asks.length} waiting`,
          route: { page: "needs" },
        },
        ...work,
        { label: "Threads", hint: "live sessions", route: { page: "threads" } },
      ];
    }
    const hit = (s: string) => s.toLowerCase().includes(q);
    return [
      ...data.tickets
        .filter((t) => hit(t.id) || hit(t.title))
        .map(
          (t): Jump => ({
            label: `${t.id}  ${t.title}`,
            hint: "ticket",
            route: { page: "ticket", id: t.id },
          }),
        ),
      ...data.agents
        .filter((a) => hit(a.name) || hit(a.role))
        .map(
          (a): Jump => ({
            label: a.name,
            hint: a.role,
            route: { page: "agent", id: a.id },
          }),
        ),
      ...data.threads.flatMap((t): Jump[] => {
        // A thread whose agent is gone is still found by its title.
        const who = data.agents.find((a) => a.id === t.agentId)?.name ?? "";
        if (!hit(t.title) && !hit(who)) return [];
        return [
          {
            label: t.title,
            hint: who ? `${who} · thread` : "thread",
            route: { page: "thread", id: t.id },
          },
        ];
      }),
      ...data.goals
        .filter((g) => hit(g.title))
        .map(
          (g): Jump => ({
            label: g.title,
            hint: "goal",
            route: { page: "goal", id: g.id },
          }),
        ),
      ...data.projects
        .filter((p) => hit(p.name))
        .map(
          (p): Jump => ({
            label: p.name,
            hint: "project",
            route: { page: "project", id: p.id },
          }),
        ),
    ].slice(0, 6);
  }, [text, data]);

  const messages = useMessageHits(text, searchMessages, data);

  /* With a CEO, the first rows ask it (the typed line, or the suggestions
     when nothing is typed); the rest jump, then the messages found. Without
     one, every row jumps. */
  const lead = draft ? (text.trim() ? 1 : TRY.length) : 0;
  const rows = lead + jumps.length + messages.length;

  const submit = (line: string) => {
    if (!line.trim() || !draft) return;
    setText(line);
    setPhase("thinking");
    window.setTimeout(() => {
      setResult(draft(line, data));
      setPhase("result");
    }, 700);
  };

  const pick = (i: number) => {
    if (i < lead) {
      submit(text.trim() ? text : TRY[i]);
      return;
    }
    const jump = jumps[i - lead];
    if (jump) {
      go(jump.route);
      onClose();
      return;
    }
    const found = messages[i - lead - jumps.length];
    if (!found) return;
    if (onOpenMessage) onOpenMessage(found.thread.id, found.hit.messageId);
    else go({ page: "thread", id: found.thread.id });
    onClose();
  };

  const start = () => {
    if (result?.kind !== "plan") return;
    onStart(result, text);
    onClose();
  };

  return (
    // The scrim closes on click; Esc does the same from the keyboard.
    <div
      className="fixed inset-0 z-40 bg-[var(--v3-main)]/60 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={draft ? "Ask the CEO" : "Search"}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (
            phase === "result" &&
            e.key === "Enter" &&
            (e.metaKey || e.ctrlKey)
          )
            start();
        }}
        className="lilos-v3-line-in absolute top-[12vh] left-1/2 w-[min(660px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-[var(--v3-line)] bg-background text-[14px] text-foreground shadow-[0_18px_50px_rgba(15,15,15,.14),0_2px_6px_rgba(15,15,15,.06)]"
      >
        <div className="flex items-center gap-2.5 border-[var(--v3-line)] border-b px-[18px] py-[14px]">
          <SparklesIcon className="size-[18px] shrink-0 text-muted-foreground" />
          <input
            ref={input}
            value={text}
            readOnly={phase !== "input"}
            onChange={(e) => {
              setText(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (phase !== "input") {
                if (e.key === "Enter" && !(e.metaKey || e.ctrlKey))
                  e.preventDefault();
                return;
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(rows - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                pick(sel);
              }
            }}
            placeholder={
              draft
                ? "Ask the CEO anything, or give the company work…"
                : "Search people, threads, projects…"
            }
            className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted-foreground/70"
          />
          <Kbd>{phase === "input" ? "↵" : "esc"}</Kbd>
        </div>

        {phase === "input" && (
          <div className="max-h-[52vh] overflow-y-auto p-2">
            {!draft ? null : text.trim() ? (
              <Row
                on={sel === 0}
                onClick={() => pick(0)}
                onHover={() => setSel(0)}
              >
                <Avatar name="CEO" tone="c" size={18} />
                <span className="min-w-0 flex-1 truncate">
                  Ask the CEO:{" "}
                  <span className="font-medium">“{text.trim()}”</span>
                </span>
                <CornerDownLeftIcon className="size-3.5 text-muted-foreground" />
              </Row>
            ) : (
              <>
                <Group>Try</Group>
                {TRY.map((t, i) => (
                  <Row
                    key={t}
                    on={sel === i}
                    onClick={() => pick(i)}
                    onHover={() => setSel(i)}
                  >
                    <SparklesIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate">{t}</span>
                  </Row>
                ))}
              </>
            )}
            {jumps.length > 0 && <Group>Go to</Group>}
            {jumps.map((j, i) => {
              const idx = lead + i;
              return (
                <Row
                  key={JSON.stringify(j.route)}
                  on={sel === idx}
                  onClick={() => pick(idx)}
                  onHover={() => setSel(idx)}
                >
                  <span className="min-w-0 flex-1 truncate">{j.label}</span>
                  <span className="text-[12.5px] text-muted-foreground/70">
                    {j.hint}
                  </span>
                </Row>
              );
            })}
            {messages.length > 0 && <Group>Messages</Group>}
            {messages.map((found, i) => {
              const idx = lead + jumps.length + i;
              return (
                <MessageHitRow
                  key={found.hit.messageId}
                  found={found}
                  data={data}
                  on={sel === idx}
                  onClick={() => pick(idx)}
                  onHover={() => setSel(idx)}
                />
              );
            })}
          </div>
        )}

        {phase === "thinking" && (
          <div className="flex items-center gap-2.5 px-[18px] py-5 text-[13.5px] text-muted-foreground">
            <Spinner />
            The CEO is reading the company and writing a reply…
          </div>
        )}

        {phase === "result" && result?.kind === "answer" && (
          <>
            <div className="px-[18px] pt-4 pb-3">
              <div className="flex items-center gap-2 font-medium text-[12px] text-muted-foreground/70">
                <Avatar name="CEO" tone="c" size={18} />
                CEO · answered in 1s
              </div>
              <p className="mt-2 mb-1 text-[14.5px] leading-relaxed">
                {result.text}
              </p>
            </div>
            <Footer>
              <Btn onClick={() => submit(`Plan: ${text.replace(/\?$/, "")}`)}>
                Make it work
              </Btn>
              <Btn onClick={() => setPhase("input")}>Ask something else</Btn>
              <span className="ml-auto" />
              <Btn primary onClick={onClose}>
                Done
              </Btn>
            </Footer>
          </>
        )}

        {phase === "result" && result?.kind === "plan" && (
          <PlanView
            plan={result}
            data={data}
            onEdit={() => setPhase("input")}
            onAnswer={() => submit(`${text.replace(/[.?]$/, "")}?`)}
            onStart={start}
          />
        )}
      </div>
    </div>
  );
}

function Row({
  on,
  onClick,
  onHover,
  children,
}: {
  on: boolean;
  onClick: () => void;
  onHover: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseMove={onHover}
      className={cn(
        "flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[14px]",
        on && "bg-[var(--v3-hover)]",
      )}
    >
      {children}
    </button>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pt-2 pb-1 font-medium text-[12px] text-muted-foreground/70">
      {children}
    </div>
  );
}
