import { Undo2Icon } from "lucide-react";
import { AttachmentChips } from "../chat/attachment-chips";
import { MessageResponse } from "../components/ai-elements/message";
import { withFileMentionChips } from "../lib/mentions";
import type { AttachedFile, HumanFn } from "../types";
import { VIEWER_ID } from "../types";

/* Your message, the v3 way: a right-aligned soft bubble with one small line
   under it (time; and on hover, "Rewind to here"). The ONE implementation
   for both frames — the thread panel and the session view — root message
   included.

   #578: rewind is a hover affordance on your own message. One click applies
   the rewind visually and opens a 10 s Undo toast that is the real
   safeguard, so a shared folder (`warning`) only names itself in the
   tooltip, and a running turn still greys the affordance out (#134 AC-5).
   The wrapper span carries the tooltip because a disabled button swallows
   pointer events; it floats left of the time so the line never shifts. */

interface RewindProps {
  running: boolean;
  warning?: string;
  onRewind: () => void;
}

function RewindHover({ running, warning, onRewind }: RewindProps) {
  const title = running
    ? "Stop the running turn first"
    : `Rewind to before this message${warning ? ` — ${warning}` : ""}`;
  return (
    <span
      title={title}
      className="absolute top-1/2 right-full z-10 mr-3 -translate-y-1/2 whitespace-nowrap opacity-0 transition-opacity focus-within:opacity-100 group-hover/you:opacity-100"
    >
      <button
        type="button"
        data-rewind
        disabled={running}
        title={title}
        onClick={onRewind}
        className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 hover:text-foreground focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Undo2Icon className="size-3" />
        Rewind to here
      </button>
    </span>
  );
}

export function UserTurn({
  from,
  time,
  text,
  note,
  human,
  attachments,
  rewind,
}: {
  from: string;
  time: string;
  text: string;
  /** Extra words for the line under the bubble ("Queued · …"). */
  note?: string;
  human: HumanFn;
  attachments?: AttachedFile[];
  rewind?: RewindProps;
}) {
  const name = human(from)?.name ?? from;
  /* Your own name is implied; anyone else in the thread is named. */
  const mine = from === VIEWER_ID;
  return (
    <div
      data-userturn
      className="lilos-rise group/you ml-auto flex max-w-[80%] flex-col items-end"
    >
      {text && (
        <div className="min-w-0 max-w-full break-words rounded-2xl bg-[var(--v3-soft)] px-4 py-2.5 text-[14.5px] text-foreground leading-[1.55]">
          <MessageResponse className="lilos-prose break-words">
            {withFileMentionChips(text)}
          </MessageResponse>
        </div>
      )}
      {!!attachments?.length && (
        <div className="flex max-w-full justify-end">
          <AttachmentChips files={attachments} />
        </div>
      )}
      <div className="relative mt-1 flex items-center text-[12px] text-muted-foreground/70">
        {rewind && <RewindHover {...rewind} />}
        <span>
          {mine ? <span className="sr-only">{name} · </span> : <>{name} · </>}
          {time}
          {note && <> · {note}</>}
        </span>
      </div>
    </div>
  );
}
