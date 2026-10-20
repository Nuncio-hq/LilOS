import {
  CircleAlertIcon,
  CornerDownLeftIcon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { Avatar, Btn, Kbd, Spinner, TicketId } from "./v3-bits";
import { agentOf, goalOf } from "./v3-model";
import type { V3Data, V3Draft, V3Route } from "./v3-types";

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
   goals and projects to jump to. */
export function V3Palette({
  data,
  seed,
  draft,
  onStart,
  onClose,
  go,
}: {
  data: V3Data;
  seed: string;
  /** The CEO behind it; absent, ⌘K only searches and jumps. */
  draft?: (text: string, data: V3Data) => V3Draft;
  onStart: (plan: Plan, text: string) => void;
  onClose: () => void;
  go: (r: V3Route) => void;
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

  /* With a CEO, the first rows ask it (the typed line, or the suggestions
     when nothing is typed); the rest jump. Without one, every row jumps. */
  const lead = draft ? (text.trim() ? 1 : TRY.length) : 0;
  const rows = lead + jumps.length;

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
    if (!jump) return;
    go(jump.route);
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
                  key={j.label}
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

function PlanView({
  plan,
  data,
  onEdit,
  onAnswer,
  onStart,
}: {
  plan: Plan;
  data: V3Data;
  onEdit: () => void;
  onAnswer: () => void;
  onStart: () => void;
}) {
  const owners = new Set(plan.tickets.map((t) => t.owner)).size;
  const goal = plan.goalId ? goalOf(data, plan.goalId) : undefined;
  return (
    <>
      <div className="px-[18px] pt-3.5 pb-1.5">
        <div className="flex items-center gap-2 font-medium text-[12px] text-muted-foreground/70">
          <Avatar name="CEO" tone="c" size={18} />
          CEO · draft plan{goal ? ` · goal ${goal.title}` : ""}
        </div>
        <p className="mt-2 mb-1 text-[14.5px] leading-relaxed">{plan.lead}</p>
        <div className="mt-2 mb-1.5 flex flex-wrap gap-x-[18px] text-[13px] text-muted-foreground">
          <span>
            <b className="font-semibold text-foreground">
              {plan.tickets.length}
            </b>{" "}
            tickets
          </span>
          <span>
            <b className="font-semibold text-foreground">{owners}</b> agents
          </span>
          <span>
            about <b className="font-semibold text-foreground">{plan.hours}h</b>{" "}
            of agent time
          </span>
          <span>
            about <b className="font-semibold text-foreground">${plan.cost}</b>{" "}
            in model cost
          </span>
        </div>
        <div className="mt-1">
          {plan.tickets.map((t) => {
            const a = agentOf(data, t.owner);
            return (
              <div
                key={t.id}
                className="flex min-h-10 items-center gap-2 border-[var(--v3-line)] border-b text-[13.5px] last:border-b-0"
              >
                <TicketId id={t.id} className="w-12 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {t.title}
                  {t.asksYou && (
                    <span className="ml-2 rounded-full bg-orange-50 px-2 py-px font-medium text-[12px] text-orange-700 dark:bg-orange-400/14 dark:text-orange-300">
                      asks you first
                    </span>
                  )}
                </span>
                <span className="flex w-[108px] shrink-0 items-center gap-2 font-medium">
                  <Avatar name={a.name} tone={a.tone} />
                  {a.name}
                </span>
                <span className="w-[96px] shrink-0 text-[12.5px] text-muted-foreground/70">
                  {t.after ? `after ${t.after}` : "starts now"}
                </span>
                <span className="w-9 shrink-0 text-right text-muted-foreground">
                  {t.est}
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2 pt-2.5 pb-1 text-[13px] text-muted-foreground">
          <CircleAlertIcon className="size-3.5" />
          I’ll ask you before anything goes public or costs money. Everything
          else I decide.
        </div>
      </div>
      <Footer>
        <Btn onClick={onEdit}>Edit request</Btn>
        <Btn onClick={onAnswer}>Just answer, no tickets</Btn>
        <span className="ml-auto" />
        <Btn primary onClick={onStart}>
          Start
          <span className="ml-1 rounded border border-background/30 px-1 text-[11px] text-background/75">
            ⌘↵
          </span>
        </Btn>
      </Footer>
    </>
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

function Footer({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-[var(--v3-line)] border-t bg-[var(--v3-soft)] px-[18px] py-3">
      {children}
    </div>
  );
}
