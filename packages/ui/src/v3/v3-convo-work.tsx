import { ChevronRightIcon, CloudIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../lib/utils";
import { Diff, Spinner, STEP_VERB, StepIcon, useTick } from "./v3-bits";
import { elapsedAt, OutLine, streamTail } from "./v3-live";
import { StatusDot } from "./v3-marks";
import type { V3Step, V3StepKind, V3Thread, V3Turn } from "./v3-types";

/* The work under a prompt. A finished turn is one quiet line you can open to
   see every step; the turn running now is open, with its output arriving. */

const OUT_LINES = 6;
// One output row: 12px mono at 1.7 line height; the box pads 8px top and bottom.
const ROW_PX = 20.4;
const BOX_PAD_PX = 16;

const ROW =
  "-ml-1.5 flex min-h-7 max-w-full items-center gap-1.5 rounded-md px-1.5 text-[13.5px] text-muted-foreground";

const COUNTS: { kind: V3StepKind; verb: string; one: string; many: string }[] =
  [
    { kind: "read", verb: "read ", one: "file", many: "files" },
    { kind: "search", verb: "", one: "search", many: "searches" },
    { kind: "edit", verb: "edited ", one: "file", many: "files" },
    { kind: "run", verb: "ran ", one: "command", many: "commands" },
    { kind: "web", verb: "browsed ", one: "page", many: "pages" },
    { kind: "delegate", verb: "delegated ", one: "task", many: "tasks" },
  ];

/** "read 3 files, ran 2 commands, 1 failed", for turns that carry no `facts`. */
function countsOf(steps: V3Step[]) {
  const parts = COUNTS.flatMap(({ kind, verb, one, many }) => {
    const n = steps.filter((s) => s.kind === kind).length;
    return n ? [`${verb}${n} ${n === 1 ? one : many}`] : [];
  });
  const failed = steps.filter((s) => s.failed).length;
  if (failed) parts.push(`${failed} failed`);
  return (
    parts.join(", ") ||
    `${steps.length} ${steps.length === 1 ? "step" : "steps"}`
  );
}

/** Counts up from the step's recorded age; the caller remounts it per step. */
function LiveElapsed({ base }: { base: string }) {
  const n = useTick(1000);
  return <>{elapsedAt(base, n)}</>;
}

function StepRow({
  s,
  running,
  elapsed,
}: {
  s: V3Step;
  /** The step the agent is on now; red when the agent is stuck on it. */
  running?: "working" | "stuck";
  /** Stands in for the step's own meta while it runs. */
  elapsed?: ReactNode;
}) {
  if (s.kind === "think") {
    return (
      <div className="flex items-start gap-2.5 py-1 text-[13.5px] text-muted-foreground italic leading-snug">
        <StepIcon kind="think" className="mt-[3px]" />
        <span className="min-w-0 flex-1">{s.target}</span>
      </div>
    );
  }
  const bad = running === "stuck" || (!running && s.failed);
  const tone = bad
    ? "text-red-600 dark:text-red-300"
    : running
      ? "text-sky-700 dark:text-sky-300"
      : "";
  const meta = running && elapsed ? elapsed : s.meta;
  return (
    <div className="flex min-h-[30px] items-center gap-2.5 text-[13.5px]">
      {running ? (
        <Spinner
          className={cn("size-[15px]", bad && "text-red-500 dark:text-red-400")}
        />
      ) : (
        <StepIcon
          kind={s.kind}
          className={s.failed ? "text-red-500 dark:text-red-400" : undefined}
        />
      )}
      <span className={cn("w-[70px] shrink-0 text-muted-foreground", tone)}>
        {running && s.kind === "run" ? "Running" : STEP_VERB[s.kind]}
      </span>
      <span
        title={s.target}
        className={cn("min-w-0 flex-1 truncate font-mono text-[12.5px]", tone)}
      >
        {s.target}
      </span>
      {s.helper && (
        <a
          href={s.helper.url}
          target="_blank"
          rel="noreferrer"
          title={s.helper.label}
          className="shrink-0 whitespace-nowrap text-[12.5px] text-sky-700 hover:underline dark:text-sky-300"
        >
          Open ↗
        </a>
      )}
      {s.where && (
        // Steps that ran off your Mac say where; no chip = your Mac.
        <span className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-[var(--v3-soft)] px-1.5 text-[11.5px] text-muted-foreground">
          <CloudIcon className="size-3" />
          {s.where}
        </span>
      )}
      {s.add !== undefined && s.del !== undefined ? (
        <Diff add={s.add} del={s.del} />
      ) : (
        meta && (
          <span
            className={cn(
              "whitespace-nowrap text-[12.5px] text-muted-foreground/70",
              tone,
            )}
          >
            {meta}
          </span>
        )
      )}
    </div>
  );
}

/** The running command and its output, arriving line by line. */
function LiveOutput({ live }: { live: NonNullable<V3Thread["live"]> }) {
  const n = useTick(500);
  const { cmd, lines } = live;
  // `--repeat-each=N` commands replay their recorded runs until N are done, a
  // line every 2s like a real test run; other output lands about twice a second.
  const repeat = Number(/--repeat-each=(\d+)/.exec(cmd)?.[1] ?? 0);
  const perRun = Math.max(1, lines.filter((l) => l.includes("(run 1)")).length);
  const cap = repeat ? repeat * perRun : lines.length;
  const count = Math.min(
    cap,
    repeat ? Math.min(lines.length, 4) + Math.floor(n / 4) : 1 + n,
  );
  const shown = streamTail(lines, count, OUT_LINES - 1);
  const done = Math.min(repeat, Math.ceil(count / perRun));
  // The box opens at its final height, so arriving lines never push the page.
  const rows = Math.min(lines.length, OUT_LINES - 1) + (repeat ? 1 : 0);
  return (
    <div className="mt-1.5 mb-1.5">
      <div className="break-all font-mono text-[12.5px] text-foreground">
        {cmd}
      </div>
      {lines.length > 0 && (
        <div
          style={{ minHeight: BOX_PAD_PX + rows * ROW_PX }}
          className="mt-1.5 overflow-hidden rounded-[7px] bg-[var(--v3-soft)] px-3 py-2 font-mono text-[12px] text-muted-foreground leading-[1.7]"
        >
          {shown.map((l) => (
            <div key={l.key} className="lilos-v3-line-in truncate">
              <OutLine text={l.text} />
            </div>
          ))}
          {repeat > 0 && (
            <div className="truncate">
              {done < repeat ? `Running ${done} of ${repeat}…` : "Finishing…"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkBlock({
  turn,
  thread,
  newest,
}: {
  turn: V3Turn;
  thread: V3Thread;
  /** This is the thread's newest turn. */
  newest: boolean;
}) {
  const [manual, setManual] = useState<boolean>();
  const steps = turn.steps ?? [];
  // "Ran 5 commands" reads as a fragment after "Worked 6m ·".
  const facts = turn.facts?.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());
  if (steps.length === 0 && !facts) return null;

  // The agent is on its newest turn until the answer starts; then the work
  // folds away and the answer takes the eye.
  const on =
    newest &&
    turn.answer === undefined &&
    (thread.status === "working" || thread.status === "stuck")
      ? thread.status
      : undefined;
  const live = on !== undefined;
  const foldable = steps.length > 0;
  const open = foldable && (manual ?? live);
  const runIdx = live ? steps.map((s) => !!s.running).lastIndexOf(true) : -1;
  const now = thread.now;
  // "just now" and "queued" are not durations ("Worked just now" reads wrong),
  // and a stopped turn's "12m so far" is no longer so far.
  const dur = /\d/.test(turn.took)
    ? ` ${turn.took.replace(/ so far$/, "")}`
    : "";

  const line = (
    <>
      <ChevronRightIcon
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
          open && "rotate-90",
          !foldable && "invisible",
        )}
      />
      {live ? (
        <>
          <StatusDot status={on === "stuck" ? "stuck" : "working"} />
          <span className="font-medium text-foreground">
            {on === "stuck" ? "Stuck" : "Working"}
          </span>
          <span className="min-w-0 truncate text-muted-foreground/70">
            · {turn.took}
          </span>
        </>
      ) : (
        <>
          <span className="whitespace-nowrap">Worked{dur}</span>
          <span className="min-w-0 truncate text-muted-foreground/70">
            · {facts ?? countsOf(steps)}
          </span>
        </>
      )}
    </>
  );

  return (
    <div className="mt-4">
      {foldable ? (
        <button
          type="button"
          onClick={() => setManual(!open)}
          aria-expanded={open}
          className={cn(
            ROW,
            "transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground",
          )}
        >
          {line}
        </button>
      ) : (
        <div className={ROW}>{line}</div>
      )}
      {open && (
        <div className="mt-1 ml-[7px] border-[var(--v3-line)] border-l pl-3.5">
          {steps.map((s, i) => (
            // Steps are an append-only log, so the index is their identity.
            <div key={i}>
              <StepRow
                s={s}
                running={i === runIdx ? on : undefined}
                elapsed={
                  on === "working" && i === runIdx && now ? (
                    <LiveElapsed
                      key={`${now.kind}:${now.text}`}
                      base={now.elapsed}
                    />
                  ) : undefined
                }
              />
              {on === "working" && i === runIdx && thread.live && (
                <LiveOutput key={thread.live.cmd} live={thread.live} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
