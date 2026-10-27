import { CircleDotIcon } from "lucide-react";
import { useMemo } from "react";
import { plain } from "../chat/agent-chat";
import { PHASE_LABEL } from "../lib/helpers";
import { idleHint } from "../thread/idle-hint";
import { StartWork, sentTurns, ThreadHeader } from "../thread/thread-header";
import { focusFolder, threadKicker } from "../thread/thread-kicker";
import { workTabs } from "../thread/work-strip";
import type { Reply, WbTab } from "../types";
import { useRenameMenu } from "../v3/v3-thread-menu";
import type { FocusViewProps } from "./focus-props";
import { SessionUsage } from "./session-usage";
import { useFolderMenu } from "./use-folder-menu";

/* The session view's thread header: the shared ThreadHeader fed from the
   session — its kicker, its status note, the context meter, Start work, the
   ⋯ menu, and the work strip while the Workbench is closed. */
export function FocusHeader({
  p,
  model,
  live,
  startCardOpen,
  stripOpen,
  onOpenTab,
}: {
  p: FocusViewProps;
  /** The session's resolved model id (`sessionModelId`). */
  model?: string;
  /** The turn in flight, if any. */
  live?: Reply;
  startCardOpen: boolean;
  /** The strip stands in for the panel while it is closed and there is
      something to open; open, the panel's own tab row takes over (and its
      close hides it again) — the header carries no toggle of its own. */
  stripOpen: boolean;
  onOpenTab: (t: WbTab) => void;
}) {
  const { root, thread, channel, work, running, onStart, threadStatus } = p;
  const isDM = !!channel.dm;
  const { replies, pr, jobs } = thread;
  const prPending = pr?.checks.some((c) => c.status === "pending");
  const stripTabs = useMemo(
    () =>
      workTabs(
        { replies, pr, jobs },
        {
          folder: !!thread.ws || !!work?.path,
          browser: p.browser != null,
          prPending,
        },
      ),
    [replies, pr, jobs, thread.ws, work?.path, p.browser, prPending],
  );
  /* #886: Changes is the header's one named surface (while files changed);
     the other tabs and the context meter are labeled rows inside ⋯. Work
     items list only while the Workbench is closed — open, the panel's own
     tab row is the way in. */
  const changesTab = stripTabs.find((t) => t.id === "changes");
  const menuTabs = stripTabs.filter((t) => t.id !== "changes");
  const { input: titleInput, menu: threadMenu } = useRenameMenu({
    title: thread.title || plain(root.text),
    inputClassName: "h-8 [font-size:20px]",
    archived: thread.archived,
    onRename: p.onRename,
    onArchive: p.onArchive,
    work:
      stripOpen && menuTabs.length
        ? { tabs: menuTabs, onOpen: onOpenTab }
        : undefined,
    meter: thread.usage ? (
      <SessionUsage
        menuRow
        usage={thread.usage}
        model={model}
        models={p.models}
        onCompact={p.onCompact}
        compactDisabled={running}
        onContinue={p.onContinue}
      />
    ) : undefined,
  });
  const folderMenu = useFolderMenu({
    thread,
    host: p.host,
    editors: p.editors,
    onOpenPath: p.onOpenPath,
    say: p.say,
  });
  /* #583 AC-3: background processes still running under this thread. */
  const runningJobs =
    thread.jobs?.filter((j) => j.status === "running").length ?? 0;
  return (
    <ThreadHeader
      session
      title={thread.title || plain(root.text)}
      titleInput={titleInput}
      kicker={threadKicker({
        title: [
          idleHint({ work, pr, isDM, session: true }),
          `Thread ${thread.session}`,
        ]
          .filter(Boolean)
          .join(" · "),
        channel: isDM ? undefined : `#${channel.name}`,
        folder: focusFolder({
          thread,
          work,
          isDM,
          openMenu: folderMenu,
          onAddAsProject: p.onAddAsProject,
        }),
      })}
      status={threadStatus}
      started={root.time}
      turns={sentTurns(root.from, thread, p.human)}
      note={
        <>
          {/* The pill already says working/needs you/failed; the engine's
              finer phase stands in only without one. */}
          {running && !threadStatus && (
            <>
              {" · "}
              <span className="inline-flex items-center gap-1">
                <CircleDotIcon className="size-3 animate-pulse text-work" />
                {live?.phase ? PHASE_LABEL[live.phase] : "working"}
              </span>
            </>
          )}
          {/* #583 AC-3: a live background job says so in the header too. */}
          {runningJobs > 0 && (
            <span data-bg-jobs> · {runningJobs} running in background</span>
          )}
        </>
      }
      changes={
        stripOpen && changesTab?.meta
          ? { n: changesTab.meta, onOpen: () => onOpenTab("changes") }
          : undefined
      }
      start={
        !work && !isDM && onStart ? (
          <StartWork onStart={onStart} yields={startCardOpen} />
        ) : undefined
      }
      menu={threadMenu}
      /* #579: no "Open PR" button — asking the employee IS the way to open
         one. A session that has a PR shows it once, as the ⋯ menu's PR row
         (state in its label), and the panel's own PR tab once open. */
    />
  );
}
