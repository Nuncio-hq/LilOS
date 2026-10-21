import { FocusView } from "@lilos/ui";
import type { WbTab } from "@lilos/ui/types";
import { ThreadBrowser } from "../lib/browser";
import { DesktopFindBar } from "../lib/desktop-find";
import { hostAccessors } from "../lib/host";
import { sayNotice } from "../lib/toast";
import { FilesOnlyBanner, HistoryNotice } from "./thread-banners";
import type { ThreadData } from "./thread-data";
import { sessionOpener, startFreshOpener, type ThreadNav } from "./thread-pane";
import { sharedViewProps } from "./thread-props";

/**
 * The session view: the same live conversation as the thread panel (shared
 * AgentTurn/composer/draft/asks — issue #114 AC-2), plus the Workbench
 * against the session's real folder (AC-3…5). Rendered `bare` (#660): the
 * host mounts the pane element (`<main>` or a plain box) so it survives the
 * panel↔session swap. Back, the sidebar button and the Workbench tab are
 * callbacks; absent → the control hides (D-#19).
 */
export function SessionPane({
  d,
  onBack,
  tab,
  onTab,
  scrollTo,
  onScrolled,
  nav,
}: {
  d: ThreadData;
  /** Esc — out of the session view (the peek header's Narrow is the other way). */
  onBack?: () => void;
  /** The Workbench tab to open on (a panel link's pick); `onTab` reports picks. */
  tab?: WbTab;
  onTab?: (t: WbTab) => void;
  scrollTo?: string;
  onScrolled?: () => void;
  nav: ThreadNav;
}) {
  const { conv, filesOnly } = d;
  return (
    <FocusView
      bare
      {...sharedViewProps(d)}
      lead={d.uiEmp}
      work={d.work}
      onOpenSession={sessionOpener(d, nav)}
      onStopJob={d.onStopJob}
      onBack={onBack}
      onModel={d.onModel}
      say={sayNotice}
      /* #543: the Workbench exists for every session — the accessors are
         folder-independent (each call takes the cwd), so `host` rides
         unconditionally; the Workbench gates its folder-bound tabs on
         `work?.path` itself. */
      host={hostAccessors}
      /* LilOS Browser in thread mode — this thread's tab group, desktop only
         (web has no native page host). */
      browser={
        window.lilos?.browser ? (
          <ThreadBrowser conversationId={conv.id} employeeId={d.employeeId} />
        ) : undefined
      }
      scrollTo={scrollTo}
      onScrolled={onScrolled}
      /* #319 AC-2: the host carries the Workbench tab — opening on a panel
         link's pick and keeping it on further picks means a reload (or a
         remount) lands on the tab last picked. */
      initialTab={tab}
      onTab={onTab}
      /* #554: ⌘F over the conversation (desktop bridge; absent on web). */
      findBar={<DesktopFindBar />}
      banner={
        d.historyFailed ? <HistoryNotice onRetry={d.retryHistory} /> : undefined
      }
      onOpenPath={d.openPath ?? null}
      wbSpot={d.wbSpot}
      /* #587 AC-1: the Workbench's engine-owned tabs gate on the declared
         capabilities — the strip's membership is fixed. */
      caps={d.caps}
      onSuggest={d.onSuggest}
      /* #579 AC-1: the probe's live forge read updates the header chip the
         moment it answers (a PR the session just opened). */
      onPr={d.onPr}
    >
      {filesOnly && (
        <FilesOnlyBanner
          filesRestored={filesOnly.filesRestored}
          onStartFresh={startFreshOpener(d, filesOnly.target, nav)}
        />
      )}
    </FocusView>
  );
}
