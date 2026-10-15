import { CheckIcon, ChevronDownIcon, FolderIcon } from "lucide-react";
import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import { RuntimeIcon } from "./v2-runtime";
import type { V2Agent, V2Project } from "./v2-types";

const triggerCls =
  "flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground aria-expanded:bg-foreground/[0.06]";

/* Who works this thread. A Hermes profile today; other engines sit in the
   same list, greyed until they ship. */
export function AgentPicker({
  agents,
  value,
  onPick,
}: {
  agents: V2Agent[];
  value: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const cur = agents.find((a) => a.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button type="button" aria-label="Agent" className={triggerCls} />
        }
      >
        <HermesAvatar name={cur?.name} className="size-4" />
        <span className="max-w-32 truncate">{cur?.name}</span>
        <ChevronDownIcon className="size-3 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-64 gap-0 p-1.5">
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            disabled={a.soon}
            onClick={() => {
              onPick(a.id);
              setOpen(false);
            }}
            className={cn(
              "flex h-10 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px]",
              a.soon
                ? "cursor-not-allowed opacity-40"
                : "hover:bg-foreground/[0.05]",
            )}
          >
            <span className="relative">
              <HermesAvatar name={a.name} className="size-6" />
              <RuntimeIcon
                runtime={a.runtime}
                className="absolute -right-1 -bottom-1 size-3.5 rounded-[4px]"
              />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">
              {a.name}
            </span>
            {a.soon ? (
              <span className="text-[11px] text-muted-foreground">Soon</span>
            ) : (
              a.id === value && <CheckIcon className="size-3.5 text-primary" />
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/* Where the thread works. Only offered before the first message. */
export function ProjectPicker({
  projects,
  value,
  onPick,
}: {
  projects: V2Project[];
  value: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const cur = projects.find((p) => p.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button type="button" aria-label="Project" className={triggerCls} />
        }
      >
        <FolderIcon className="size-3.5 text-muted-foreground" />
        <span className="max-w-32 truncate">{cur?.name ?? "No project"}</span>
        <ChevronDownIcon className="size-3 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-64 gap-0 p-1.5">
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              onPick(p.id);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-foreground/[0.05]"
          >
            <FolderIcon className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{p.name}</span>
              {p.path && (
                <span className="block truncate text-[11.5px] text-muted-foreground">
                  {p.path}
                </span>
              )}
            </span>
            {p.id === value && <CheckIcon className="size-3.5 text-primary" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
