import type { WbTab } from "@lilos/ui/types";
import { useEffect, useRef, useState } from "react";
import { useAtom } from "../lib/hooks";
import { relay, workbenchRequests } from "../lib/runtime";
import { SessionPane } from "./session-pane";
import { ThreadPane } from "./thread-pane";
import { useConvFolds } from "./use-conv-folds";
import { useThreadWith } from "./use-thread";

/**
 * One conversation, standalone — no router, no URL. Everything it shows is
 * derived from the runtime atoms by `conversationId`; every way out of it is
 * a callback, and an absent callback hides its control (D-#19).
 *
 * Two modes, local state: the thread (header, transcript, composer) and the
 * session view (the same conversation with the Workbench beside it). The
 * header's ↗, a turn's "N files changed" link and a `workbench_open` from
 * the agent enter the session view; Esc / Back return.
 *
 * Not here: `openConversation` (the session watch's scope head AND the read
 * watermark's trigger) — the host sets it from whatever it shows, because
 * the host knows whether this panel is actually on screen.
 */
export function ThreadPanel({
  conversationId,
  onOpenAgent,
  onOpenThread,
  onClose,
  onSession,
}: {
  conversationId: string;
  /** A subagent row names an employee that has no known thread yet. */
  onOpenAgent?: (employeeId: string) => void;
  /** A subagent row, or "Start a new thread from here" after a files-only
      rewind, names another thread. */
  onOpenThread?: (conversationId: string, employeeId: string) => void;
  /** Esc in the thread mode. */
  onClose?: () => void;
  /** The panel entered (true) / left (false) the session view — a host that
      shows it in a narrow box can widen it for the Workbench. */
  onSession?: (open: boolean) => void;
}) {
  /* Keyed: another conversation starts with a fresh mode, tab and composer
     state instead of carrying the last one's over. */
  return (
    <PanelBody
      key={conversationId}
      conversationId={conversationId}
      onOpenAgent={onOpenAgent}
      onOpenThread={onOpenThread}
      onClose={onClose}
      onSession={onSession}
    />
  );
}

function PanelBody({
  conversationId,
  onOpenAgent,
  onOpenThread,
  onClose,
  onSession,
}: {
  conversationId: string;
  onOpenAgent?: (employeeId: string) => void;
  onOpenThread?: (conversationId: string, employeeId: string) => void;
  onClose?: () => void;
  onSession?: (open: boolean) => void;
}) {
  const allConvs = useAtom(relay.conversations);
  const channels = useAtom(relay.channels);
  const directoryReady = useAtom(relay.directoryReady);
  /* D-#645: `relay.conversations` is push-fed — the authority for the
     conversation's existence, so the panel mounts the moment it carries the
     row (the summaries fetch only enriches). */
  const conv = allConvs.find((c) => c.id === conversationId);
  const channel = channels.find((c) => c.id === conv?.channelId);
  const folds = useConvFolds({
    employeeId: channel?.employeeId ?? "",
    channelId: channel?.id,
    conversationId,
    convs: conv ? [conv] : [],
  });
  const d = useThreadWith(conv, folds);

  const [mode, setMode] = useState<"thread" | "session">("thread");
  /* The Workbench tab the session view opens on: a panel link's pick, then
     whatever the user picks there (#319 AC-2). */
  const [tab, setTab] = useState<WbTab | undefined>();
  const enter = (m: "thread" | "session") => {
    setMode(m);
    onSession?.(m === "session");
  };

  /* #340 AC-2b: the session's `workbench_open` brings the Workbench
     forward — a request NEWER than what the panel mounted with (an older
     one would re-open the session view on every visit). */
  const spotAt = d?.wbSpot?.at;
  const seenSpot = useRef(workbenchRequests.get()[conversationId]?.at);
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  useEffect(() => {
    if (spotAt === undefined || spotAt === seenSpot.current) return;
    seenSpot.current = spotAt;
    setMode("session");
    onSessionRef.current?.(true);
  }, [spotAt]);

  if (!d)
    return (
      <div className="grid h-full place-items-center p-6 text-muted-foreground text-sm">
        {directoryReady ? "This thread no longer exists." : "Loading…"}
      </div>
    );
  const nav = { onOpenThread, onOpenAgent };
  /* The box is the host's (the v3 peek paints the surface and scrolls); the
     panes fill it. */
  return (
    <div data-thread-panel className="flex h-full min-h-0 min-w-0 flex-col">
      {mode === "session" ? (
        <SessionPane
          d={d}
          nav={nav}
          onBack={() => enter("thread")}
          tab={tab}
          onTab={setTab}
        />
      ) : (
        <ThreadPane
          d={d}
          nav={nav}
          onClose={onClose}
          onFocus={() => enter("session")}
          onOpenTab={(t) => {
            setTab(t);
            enter("session");
          }}
        />
      )}
    </div>
  );
}
