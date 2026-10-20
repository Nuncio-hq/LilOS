import { Undo2Icon } from "lucide-react";
import { useState } from "react";
import { AttachmentChips } from "../chat/attachment-chips";
import { MessageResponse } from "../components/ai-elements/message";
import { cn } from "../lib/utils";
import type { AttachedFile } from "../types";
import { Btn } from "./v3-bits";
import { Attachments } from "./v3-convo-attach";
import { WorkBlock } from "./v3-convo-work";
import type { V3Data } from "./v3-data-types";
import { AgentAvatar } from "./v3-marks";
import { agentOf, FORMER_AGENT } from "./v3-model";
import type { V3PageProps } from "./v3-page-types";
import type { V3Agent, V3Thread, V3Turn } from "./v3-types";

/* One turn of the conversation: the message that started it, the work it
   caused (folded), the agent's answer with what it attached, and anything you
   queued while it ran. */

// theme.css zeroes `p` and code-block margins with selectors more specific
// than its 0.7em block gap, so paragraphs would sit flush. `!` (important)
// is what beats that unlayered rule; headings and lists keep their own.
const GAP =
  "[&_.lilos-prose>*+p]:mt-[0.7em]! [&_.lilos-prose>*+[data-streamdown]]:mt-[0.7em]!";

// Streamdown draws its own caret with Tailwind classes that live in
// node_modules, which the build does not scan; so the caret is drawn here, on
// the answer's last block, while the text is still arriving.
const CARET =
  "[&_.lilos-prose>:last-child]:after:ml-1 [&_.lilos-prose>:last-child]:after:content-['▋'] [&_.lilos-prose>:last-child]:after:text-foreground/35 [&_.lilos-prose>:last-child]:after:motion-safe:animate-pulse";

const BUBBLE =
  "whitespace-pre-wrap break-words rounded-2xl bg-[var(--v3-soft)] px-4 py-2.5 text-[14.5px] text-foreground leading-[1.55]";

type RewindProps = {
  /** The agent is mid-turn: Rewind waits. */
  working: boolean;
  /** Turns after this one, which go away with it. */
  later: number;
  onRewind: () => void;
};

/** Your words, right-aligned, with a faint line under them. On your own
   messages that line also holds Rewind, which shows on hover and asks right
   there before undoing anything. */
function YouBubble({
  text,
  files,
  note,
  rewind,
}: {
  text: string;
  /** What you attached; a message of files alone has no bubble. */
  files?: AttachedFile[];
  note: string;
  rewind?: RewindProps;
}) {
  const [asking, setAsking] = useState(false);
  // If the agent starts a turn while the question is open, it closes.
  const confirming = asking && !rewind?.working;
  return (
    <div className="group/you flex flex-col items-end">
      {text && <div className={cn(BUBBLE, "max-w-[80%]")}>{text}</div>}
      {!!files?.length && (
        <div className="flex max-w-[80%] justify-end">
          <AttachmentChips files={files} />
        </div>
      )}
      <div className="mt-1 flex items-center gap-3 text-[12px] text-muted-foreground/70">
        {rewind && !confirming && (
          // The wrapper carries the tooltip: a disabled button swallows pointer events.
          <span
            title={rewind.working ? "Wait for the turn to finish" : undefined}
          >
            <button
              type="button"
              data-rewind
              disabled={rewind.working}
              onClick={() => setAsking(true)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1 py-0.5 opacity-0 transition-opacity",
                rewind.working
                  ? "cursor-not-allowed group-hover/you:opacity-50"
                  : "hover:text-foreground focus-visible:opacity-100 group-focus-within/you:opacity-100 group-hover/you:opacity-100",
              )}
            >
              <Undo2Icon className="size-3" />
              Rewind to here
            </button>
          </span>
        )}
        <span>{note}</span>
      </div>
      {rewind && confirming && (
        <div className="mt-2 flex max-w-[80%] flex-wrap items-center justify-end gap-x-3 gap-y-2 text-[13px] text-muted-foreground">
          <span>
            Undo files and conversation back to before this message?{" "}
            {rewind.later > 0
              ? `${rewind.later} later ${rewind.later === 1 ? "message" : "messages"} go away.`
              : "Only this turn goes away."}
          </span>
          <span className="flex gap-2">
            <Btn small onClick={() => setAsking(false)}>
              Cancel
            </Btn>
            <Btn
              small
              primary
              onClick={() => {
                // Close first: the page takes it from here.
                setAsking(false);
                rewind.onRewind();
              }}
            >
              Rewind
            </Btn>
          </span>
        </div>
      )}
    </div>
  );
}

/** A quiet line where the thread was rewound: the messages and files that
   went back to before one of yours. */
export function RewoundLine({
  rewound,
}: {
  rewound: NonNullable<V3Thread["rewound"]>;
}) {
  const { dropped, files } = rewound;
  return (
    <div className="flex items-center gap-3 text-[12.5px] text-muted-foreground/70">
      <span className="h-px flex-1 bg-[var(--v3-line)]" />
      <span className="max-w-[80%] text-center">
        Rewound to before your message — {dropped}{" "}
        {dropped === 1 ? "message" : "messages"} dropped
        {files ? ", files restored" : ""}.
      </span>
      <span className="h-px flex-1 bg-[var(--v3-line)]" />
    </div>
  );
}

function Who({
  data,
  agent,
  note,
}: {
  data: V3Data;
  agent: V3Agent | undefined;
  note?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-[13.5px]">
      <AgentAvatar data={data} agent={agent} size={20} />
      <span className="font-medium text-foreground">
        {agent?.name ?? FORMER_AGENT}
      </span>
      {note && (
        <span className="text-[12px] text-muted-foreground/70">{note}</span>
      )}
    </div>
  );
}

/** What started the turn. Old turns have no prompt, only a "from" line. */
function Prompt({
  turn,
  data,
  rewind,
}: {
  turn: V3Turn;
  data: V3Data;
  rewind?: RewindProps;
}) {
  const p = turn.prompt;
  if (!p) {
    return (
      <div className="text-[12.5px] text-muted-foreground/70 first-letter:uppercase">
        {turn.from}
      </div>
    );
  }
  if (p.by === "you")
    return (
      <YouBubble text={p.text} files={p.files} note={p.at} rewind={rewind} />
    );
  return (
    <div>
      <Who data={data} agent={agentOf(data, p.by)} note={p.at} />
      <div className={cn(BUBBLE, "mt-1.5 w-fit max-w-[88%]")}>{p.text}</div>
    </div>
  );
}

function Answer({
  data,
  agent,
  text,
  streaming,
}: {
  data: V3Data;
  agent: V3Agent | undefined;
  text: string;
  streaming: boolean;
}) {
  return (
    <div className="mt-5">
      <Who data={data} agent={agent} />
      <div className={cn("mt-1.5", GAP, streaming && CARET)}>
        {text ? (
          <MessageResponse className="lilos-prose break-words">
            {text}
          </MessageResponse>
        ) : (
          // Before the first word there is no block to hang the caret on.
          <span
            aria-hidden
            className="inline-block h-[1.1em] w-[7px] translate-y-[3px] bg-foreground/35 motion-safe:animate-pulse"
          />
        )}
      </div>
    </div>
  );
}

export function ConvoTurn({
  turn,
  thread,
  data,
  agent,
  newest,
  go,
  onRewind,
}: {
  turn: V3Turn;
  thread: V3Thread;
  data: V3Data;
  agent: V3Agent | undefined;
  /** This is the thread's newest turn. */
  newest: boolean;
  go: V3PageProps["go"];
  /** Rewind to before this turn's message (yours only); gets its text back
     so the page can return it to the composer. */
  onRewind?: (turn: number, text: string) => void;
}) {
  // Old turns carry one line of summary instead of an answer.
  const text = turn.answer ?? turn.summary ?? "";
  const streaming = !!turn.streaming;
  const prompt = turn.prompt;
  return (
    <section>
      <Prompt
        turn={turn}
        data={data}
        rewind={
          onRewind && prompt?.by === "you"
            ? {
                // A turn in flight cannot be undone; wait for it to end.
                working: thread.status === "working",
                later: thread.turns.filter((u) => u.n > turn.n).length,
                onRewind: () => onRewind(turn.n, prompt.text),
              }
            : undefined
        }
      />
      <WorkBlock turn={turn} thread={thread} newest={newest} />
      {(text || streaming) && (
        <Answer data={data} agent={agent} text={text} streaming={streaming} />
      )}
      {!!turn.attachments?.length && (
        <Attachments
          items={turn.attachments}
          ticketId={thread.ticketId}
          go={go}
        />
      )}
      {turn.queued?.map((q, i) => (
        <div key={i} className="mt-4">
          <YouBubble
            text={q.text}
            note={`Queued · ${agent?.name ?? FORMER_AGENT} reads this after the current step`}
          />
        </div>
      ))}
    </section>
  );
}
