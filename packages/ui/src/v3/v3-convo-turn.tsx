import { MessageResponse } from "../components/ai-elements/message";
import { cn } from "../lib/utils";
import { AgentAvatar } from "./v3-bits";
import { Attachments } from "./v3-convo-attach";
import { WorkBlock } from "./v3-convo-work";
import { agentOf } from "./v3-model";
import type {
  V3Agent,
  V3Data,
  V3PageProps,
  V3Thread,
  V3Turn,
} from "./v3-types";

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

/** Your words, right-aligned, with a faint line under them. */
function YouBubble({ text, note }: { text: string; note: string }) {
  return (
    <div className="flex flex-col items-end">
      <div className={cn(BUBBLE, "max-w-[80%]")}>{text}</div>
      <span className="mt-1 text-[12px] text-muted-foreground/70">{note}</span>
    </div>
  );
}

function Who({
  data,
  agent,
  note,
}: {
  data: V3Data;
  agent: V3Agent;
  note?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-[13.5px]">
      <AgentAvatar data={data} agent={agent} size={20} />
      <span className="font-medium text-foreground">{agent.name}</span>
      {note && (
        <span className="text-[12px] text-muted-foreground/70">{note}</span>
      )}
    </div>
  );
}

/** What started the turn. Old turns have no prompt, only a "from" line. */
function Prompt({ turn, data }: { turn: V3Turn; data: V3Data }) {
  const p = turn.prompt;
  if (!p) {
    return (
      <div className="text-[12.5px] text-muted-foreground/70 first-letter:uppercase">
        {turn.from}
      </div>
    );
  }
  if (p.by === "you") return <YouBubble text={p.text} note={p.at} />;
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
  agent: V3Agent;
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
}: {
  turn: V3Turn;
  thread: V3Thread;
  data: V3Data;
  agent: V3Agent;
  /** This is the thread's newest turn. */
  newest: boolean;
  go: V3PageProps["go"];
}) {
  // Old turns carry one line of summary instead of an answer.
  const text = turn.answer ?? turn.summary ?? "";
  const streaming = !!turn.streaming;
  return (
    <section>
      <Prompt turn={turn} data={data} />
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
            note={`Queued · ${agent.name} reads this after the current step`}
          />
        </div>
      ))}
    </section>
  );
}
