import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { Diff } from "./v3-bits";
import type { V3PageProps, V3Thread, V3Workbench } from "./v3-types";
import {
  CARD,
  DiffLines,
  diffTotals,
  FIELD,
  Panel,
  Quiet,
  WbBtn,
  type WbPanelProps,
  type WbTab,
} from "./v3-workbench-bits";
import { FilesTab } from "./v3-workbench-files";
import { BackgroundTab, PreviewTab, PrTab } from "./v3-workbench-tabs";
import { TerminalTab } from "./v3-workbench-terminal";

/* A thread's Workbench: the folder the agent works in, seen from the side as
   tabs on the thread record. Everything here is the agent's work made
   visible; changes go back to the agent through the conversation. */

/** The Workbench tabs a thread offers, in order. Preview, PR and Background
   appear only once there is something in them. */
export function workbenchTabs(wb: V3Workbench): { id: WbTab; label: string }[] {
  const n = wb.diffs.length;
  const tabs: { id: WbTab; label: string }[] = [
    { id: "changes", label: n ? `Changes ${n}` : "Changes" },
    { id: "files", label: "Files" },
    { id: "terminal", label: "Terminal" },
  ];
  if (wb.preview) tabs.push({ id: "preview", label: "Preview" });
  if (wb.pr) tabs.push({ id: "pr", label: "PR" });
  if (wb.jobs.length)
    tabs.push({ id: "background", label: `Background ${wb.jobs.length}` });
  return tabs;
}

export function WorkbenchTab({
  thread,
  tab,
  data,
  go,
  act,
  onTab,
  onAsk,
}: V3PageProps & {
  thread: V3Thread;
  tab: WbTab;
  /** Jump to another Workbench tab. */
  onTab: (tab: WbTab) => void;
  /** Back to Chat with the composer focused. */
  onAsk: () => void;
}) {
  const wb = thread.workbench;
  if (!wb) return null;
  const p: WbPanelProps = { thread, wb, data, go, act, onTab, onAsk };
  switch (tab) {
    case "changes":
      return <ChangesTab {...p} />;
    case "files":
      return <FilesTab {...p} />;
    case "terminal":
      return <TerminalTab {...p} />;
    case "preview":
      return <PreviewTab {...p} />;
    case "pr":
      return <PrTab {...p} />;
    case "background":
      return <BackgroundTab {...p} />;
  }
}

function DiffCard({
  d,
  open,
  onToggle,
}: {
  d: V3Workbench["diffs"][number];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={cn(CARD, "overflow-hidden")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-2 px-3.5 py-2 text-left transition-colors hover:bg-[var(--v3-hover)]",
          open && "border-[var(--v3-line)] border-b",
        )}
      >
        <ChevronRightIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span
          title={d.path}
          className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground"
        >
          {d.path}
        </span>
        <Diff add={d.add} del={d.del} />
      </button>
      {open && <DiffLines lines={d.lines} />}
    </div>
  );
}

/* Commit and open a PR from the thread's changes. The agent does the git
   work, so each button tells it what to do; the bar shows that it was asked. */
function ShipBar({ thread, wb, act, onTab, onAsk }: WbPanelProps) {
  const [msg, setMsg] = useState(thread.title);
  const [committed, setCommitted] = useState(false);
  const [prOpened, setPrOpened] = useState(false);
  const text = msg.trim();
  const commit = () => {
    if (!text || wb.diffs.length === 0 || committed) return;
    act.message(thread.id, `Commit the changes: ${text}`);
    setCommitted(true);
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={msg}
          onChange={(e) => {
            setMsg(e.target.value);
            setCommitted(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) commit();
          }}
          placeholder="Commit message"
          aria-label="Commit message"
          className={cn(FIELD, "flex-1 basis-[220px]")}
        />
        <WbBtn
          disabled={!text || wb.diffs.length === 0 || committed}
          title={wb.diffs.length === 0 ? "Nothing to commit" : undefined}
          onClick={commit}
        >
          {committed && <CheckIcon className="size-3.5" />}
          {committed ? "Committed" : "Commit"}
        </WbBtn>
        {wb.pr ? (
          <WbBtn primary onClick={() => onTab("pr")}>
            View PR #{wb.pr.num}
          </WbBtn>
        ) : (
          <WbBtn
            primary={!prOpened}
            disabled={!text || prOpened}
            onClick={() => {
              act.message(thread.id, `Open a PR: ${text}`);
              setPrOpened(true);
            }}
          >
            {prOpened && <CheckIcon className="size-3.5" />}
            {prOpened ? "PR opened" : "Open PR"}
          </WbBtn>
        )}
      </div>
      <button
        type="button"
        onClick={onAsk}
        className="text-[12.5px] text-muted-foreground hover:text-foreground"
      >
        Ask the agent to change…
      </button>
    </div>
  );
}

function ChangesTab(p: WbPanelProps) {
  const { diffs } = p.wb;
  // Cards start open; the set holds the ones you folded.
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const { add, del } = diffTotals(p.wb);
  const allFolded = diffs.length > 0 && folded.size === diffs.length;
  const toggle = (path: string) =>
    setFolded((s) => {
      const next = new Set(s);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  return (
    <Panel bar={<ShipBar {...p} />}>
      {diffs.length === 0 ? (
        <Quiet>Nothing has changed in this folder yet.</Quiet>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2.5 text-[13px] text-muted-foreground">
            <span>
              {diffs.length} {diffs.length === 1 ? "file" : "files"} changed
            </span>
            <Diff add={add} del={del} />
            <button
              type="button"
              onClick={() =>
                setFolded(
                  allFolded ? new Set() : new Set(diffs.map((d) => d.path)),
                )
              }
              className="ml-auto hover:text-foreground"
            >
              {allFolded ? "Expand all" : "Collapse all"}
            </button>
          </div>
          <div className="space-y-3">
            {diffs.map((d) => (
              <DiffCard
                key={d.path}
                d={d}
                open={!folded.has(d.path)}
                onToggle={() => toggle(d.path)}
              />
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}
