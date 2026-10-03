import { CheckIcon, GitBranchIcon, PlayIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import { slugOf, titleSeed } from "../lib/helpers";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type { Channel, EmpFn, Msg, Thread, Work } from "../types";
import { Field } from "./field";

export function StartWorkDialog({
  root,
  thread,
  channel,
  ticket,
  emp,
  me,
  granted,
  onClose,
  onStart,
}: {
  root: Extract<Msg, { kind: "msg" }>;
  thread: Thread;
  channel: Channel;
  ticket: string;
  emp: EmpFn;
  /** The signed-in human's name — the work's `by` (#118). */
  me: string;
  granted: boolean;
  onClose: () => void;
  onStart: (w: Work, lead: string, grant: boolean) => void;
}) {
  const proposed = thread.replies.find((r) => r.startProposal)?.startProposal
    ?.title;
  const [title, setTitle] = useState(proposed ?? titleSeed(root.text));
  const [branch, setBranch] = useState(
    `${ticket.toLowerCase()}-${slugOf(proposed ?? title)}`,
  );
  const [grant, setGrant] = useState(granted);
  const workers = [
    ...new Set(thread.replies.map((r) => r.from).filter((f) => emp(f))),
  ];
  const [lead, setLead] = useState(workers[0] ?? "");
  const dir = `.lilos/wt/${ticket.toLowerCase()}`;
  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-5 py-3">
          <PlayIcon className="size-4" />
          <div className="font-semibold">Start work</div>
          <span className="text-muted-foreground text-xs">
            from a thread in #{channel.name}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-5">
            <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-3">
              <Field label="Ticket title">
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field label="ID">
                <Input
                  value={ticket}
                  readOnly
                  className="bg-muted/40 font-mono"
                />
              </Field>
            </div>
            {channel.repo ? (
              <div className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center gap-1.5 font-medium text-xs">
                  <GitBranchIcon className="size-3.5" />
                  Worktree on {channel.repo}
                </div>
                <Field label="Branch">
                  <Input
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    className="font-mono"
                  />
                </Field>
                <p className="text-muted-foreground text-xs">
                  From <span className="font-mono">main</span> into{" "}
                  <span className="font-mono">{dir}</span>. Removed when the PR
                  merges; the branch stays.
                </p>
              </div>
            ) : (
              <p className="rounded-lg border border-dashed p-3 text-muted-foreground text-xs">
                #{channel.name} has no repo, so this only creates a ticket. No
                worktree.
              </p>
            )}
            {workers.length > 0 && (
              <Field label="Lead employee">
                <div className="flex flex-wrap gap-1.5">
                  {workers.map((w) => (
                    <button
                      key={w}
                      onClick={() => setLead(w)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-full border py-1 pr-3 pl-1 text-xs",
                        lead === w
                          ? "border-foreground bg-muted font-medium"
                          : "hover:border-foreground/30",
                      )}
                    >
                      <HermesAvatar name={emp(w)?.name} className="size-5" />
                      {emp(w)?.name}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-muted-foreground text-xs">
                  Any employee in the channel can still join and edit. Turns run
                  one at a time.
                </p>
              </Field>
            )}
            <div className="space-y-1.5 rounded-lg bg-muted/40 p-3 text-xs">
              <div className="font-medium">Carries over</div>
              <div className="flex gap-1.5 text-muted-foreground">
                <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                This thread ({thread.replies.length} replies). It becomes the
                ticket's thread.
              </div>
              <div className="flex gap-1.5 text-muted-foreground">
                <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                Hermes session{" "}
                <span className="font-mono">{thread.session}</span>. It moves to
                the worktree; no new session, no summary.
              </div>
            </div>
            <label className="flex cursor-pointer items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={grant}
                onChange={(e) => setGrant(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">
                  Let employees in #{channel.name} start work themselves.
                </span>
                <span className="block text-muted-foreground">
                  Off: they ask, you press Start. Change it later in channel
                  settings.
                </span>
              </span>
            </label>
          </div>
        </ScrollArea>
        <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
          <code className="w-full min-w-0 break-all text-muted-foreground text-xs sm:w-auto sm:flex-1">
            {channel.repo
              ? `git worktree add ${dir} -b ${branch} → session.workspace.move`
              : `ticket ${ticket}`}
          </code>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!title.trim()}
            onClick={() =>
              onStart(
                {
                  ticket,
                  title: title.trim(),
                  branch: channel.repo ? branch : undefined,
                  by: me,
                },
                lead,
                grant,
              )
            }
          >
            <PlayIcon />
            Start {ticket}
          </Button>
        </div>
      </div>
    </div>
  );
}
