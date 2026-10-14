import { CheckIcon, ChevronDownIcon, FolderIcon } from "lucide-react";
import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
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
  const engines = Array.from(new Set(agents.map((a) => a.engine)));
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
      <PopoverContent side="top" align="start" className="w-72 gap-0 p-1.5">
        {engines.map((eng) => (
          <div key={eng} className="py-1">
            <div className="px-2 pt-1 pb-1 text-[11px] text-muted-foreground">
              {eng}
            </div>
            {agents
              .filter((a) => a.engine === eng)
              .map((a) => (
                <button
                  key={a.id}
                  type="button"
                  disabled={a.soon}
                  onClick={() => {
                    onPick(a.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px]",
                    a.soon
                      ? "cursor-not-allowed opacity-45"
                      : "hover:bg-foreground/[0.05]",
                  )}
                >
                  <HermesAvatar name={a.name} className="size-6" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{a.name}</span>
                    <span className="block truncate text-[11.5px] text-muted-foreground">
                      {a.soon ? "Coming later" : a.role}
                    </span>
                  </span>
                  {a.id === value && (
                    <CheckIcon className="size-3.5 text-primary" />
                  )}
                </button>
              ))}
          </div>
        ))}
        <p className="border-foreground/[0.06] border-t px-2 pt-2 pb-1 text-[11.5px] text-muted-foreground leading-snug">
          Each agent keeps its own memory and skills across projects.
        </p>
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
