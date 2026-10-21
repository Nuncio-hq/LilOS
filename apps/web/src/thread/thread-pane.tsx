import type { AppMessage } from "@lilos/contracts/app";
import { ThreadView } from "@lilos/ui";
import type { WbTab } from "@lilos/ui/types";
import { DesktopFindBar } from "../lib/desktop-find";
import { MoveFolderDialog } from "./move-folder-dialog";
import { FilesOnlyBanner, HistoryNotice } from "./thread-banners";
import type { ThreadData } from "./thread-data";
import { sharedViewProps } from "./thread-props";

export interface ThreadNav {
  /** A subagent row / a fresh thread names another thread. */
  onOpenThread?: (conversationId: string, employeeId: string) => void;
  /** A subagent row whose session is no known thread names just its agent. */
  onOpenAgent?: (employeeId: string) => void;
}

/* A subagent row for another employee opens their own session (D-#25):
   absent both targets, the row stays plain text (ThreadView hides the link
   without a handler). */
export function sessionOpener(d: ThreadData, nav: ThreadNav) {
  if (!nav.onOpenThread && !nav.onOpenAgent) return undefined;
  return (empRef: string, sessionRef: string) => {
    const r = d.resolveSession(empRef, sessionRef);
    if (r.conversationId && nav.onOpenThread)
      nav.onOpenThread(r.conversationId, r.employeeId);
    else nav.onOpenAgent?.(r.employeeId);
  };
}

/* #134 AC-3's button: a fresh thread seeded from the surviving transcript,
   opened through the host. Absent `onOpenThread` there is nowhere to open it
   — no button. */
export function startFreshOpener(
  d: ThreadData,
  target: AppMessage,
  nav: ThreadNav,
) {
  const { onOpenThread } = nav;
  if (!onOpenThread) return undefined;
  return () =>
    void d
      .startFresh(target)
      .then((c) => c && onOpenThread(c.id, d.employeeId));
}

/**
 * The thread panel's content — header, transcript, trays and composer — for
 * one conversation (`ThreadView` + the notices and dialog around it).
 * The caller owns the box it sits in and every navigation: Focus, a
 * Workbench-tab link, Esc, and a subagent row are callbacks, absent → the
 * control hides (D-#19).
 */
export function ThreadPane({
  d,
  onOpenTab,
  onClose,
  scrollTo,
  onScrolled,
  nav,
}: {
  d: ThreadData;
  /** The work strip, "N subagents · Open" and "N files changed" — the session view on that tab. */
  onOpenTab?: (t: WbTab) => void;
  /** Esc — close the panel. */
  onClose?: () => void;
  /** A search hit to bring into view; `onScrolled` clears it. */
  scrollTo?: string;
  onScrolled?: () => void;
  nav: ThreadNav;
}) {
  const { conv, filesOnly } = d;
  return (
    <>
      {d.historyFailed && (
        <div className="px-3 pt-2 sm:px-5">
          <HistoryNotice onRetry={d.retryHistory} />
        </div>
      )}
      {filesOnly && (
        <FilesOnlyBanner
          filesRestored={filesOnly.filesRestored}
          /* "Start a new thread from here" lands where a new send does —
             beside the list, not a jump into the session view (#577). */
          onStartFresh={startFreshOpener(d, filesOnly.target, nav)}
        />
      )}
      <ThreadView
        {...sharedViewProps(d)}
        onModel={d.models ? d.onModel : undefined}
        onOpenSession={sessionOpener(d, nav)}
        onOpenTab={onOpenTab}
        browser={window.lilos?.browser != null}
        onClose={onClose}
        /* #581 AC-2: a folder-less (plain chat) thread gets "Add a folder" —
           the pick moves the session there and files it under that folder's
           project (D-#771); same thread, same memory. The panel
           keeps work=null for chats by design, so the gate is the
           conversation's cwd itself. */
        onAddFolder={conv.cwd ? undefined : () => d.setMoveFolderOpen(true)}
        scrollTo={scrollTo}
        onScrolled={onScrolled}
        work={null}
        onOpenPath={d.openPath}
        /* #554: ⌘F over the conversation (desktop bridge; absent on web). */
        findBar={<DesktopFindBar />}
      />
      {d.moveFolderOpen && (
        <MoveFolderDialog
          conversationId={conv.id}
          onClose={() => d.setMoveFolderOpen(false)}
        />
      )}
    </>
  );
}
