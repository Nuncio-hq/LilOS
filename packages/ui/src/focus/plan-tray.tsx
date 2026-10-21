import { CheckIcon, CircleDotIcon, ListTodoIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "../components/ai-elements/queue";
import { cn } from "../lib/utils";
import type { Thread } from "../types";
import { planTodos } from "../workbench/plan-panel";

type Todo = NonNullable<Thread["todos"]>[number];

/* The pinned tray carries only the engine's own session todos. An approved
   plan or task list (issue #175) is already a card in its turn and the
   Workbench's Plan tab; a tray repeating it under the chat said the same
   list twice. It opens while the agent works and folds away when the turn
   ends (the user can still toggle). */
export function usePlanTray(thread: Thread, running: boolean) {
  const todos: Todo[] = planTodos(thread).length ? [] : (thread.todos ?? []);
  const [open, setOpen] = useState(running);
  useEffect(() => setOpen(running), [running]);
  return { todos, open, setOpen };
}

export function PlanTray({
  todos,
  open,
  onOpenChange,
}: {
  todos: Todo[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress");
  return (
    <Queue className="mb-2 gap-1 py-1.5 shadow-none">
      <QueueSection open={open} onOpenChange={onOpenChange}>
        <QueueSectionTrigger className="py-1.5 text-xs">
          <QueueSectionLabel
            label={`Plan · ${done}/${todos.length} done`}
            icon={<ListTodoIcon className="size-3.5" />}
          />
          {current && (
            <span className="ml-2 min-w-0 truncate text-amber-700">
              {current.content}
            </span>
          )}
        </QueueSectionTrigger>
        <QueueSectionContent>
          <QueueList className="mt-1">
            {todos.map((t) => {
              const off = t.status === "completed" || t.status === "cancelled";
              return (
                <QueueItem key={t.content} className="py-0.5">
                  <div className="flex items-center gap-2">
                    {t.status === "in_progress" ? (
                      <CircleDotIcon className="size-2.5 shrink-0 animate-pulse text-work" />
                    ) : off ? (
                      <CheckIcon className="size-2.5 shrink-0 text-emerald-600" />
                    ) : (
                      <QueueItemIndicator />
                    )}
                    <QueueItemContent
                      className={cn(
                        "text-xs",
                        off
                          ? "text-muted-foreground line-through decoration-muted-foreground/40"
                          : "text-foreground",
                      )}
                    >
                      {t.content}
                    </QueueItemContent>
                  </div>
                </QueueItem>
              );
            })}
          </QueueList>
        </QueueSectionContent>
      </QueueSection>
    </Queue>
  );
}
