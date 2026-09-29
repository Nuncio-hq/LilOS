import { FolderGit2Icon, GitBranchIcon, XIcon } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import type { EmpFn, TicketRow } from "../types";
import { HermesAvatar } from "./avatars";

/* The right-hand panel: Thread / Employee / Tickets tabs. threadPanel is the ready-rendered ThreadView
   (or null) the app passes in; employeeCard likewise. */
export function RightPanel({
  tab,
  onTab,
  onClose,
  threadPanel,
  employeeCard,
  tickets,
  emp,
  dm,
}: {
  tab: "thread" | "employee" | "tickets";
  onTab: (t: "thread" | "employee" | "tickets") => void;
  onClose: () => void;
  threadPanel: React.ReactNode;
  employeeCard: React.ReactNode;
  tickets: TicketRow[];
  emp: EmpFn;
  dm: boolean;
}) {
  return (
    <aside className="lilos-glass flex min-h-0 flex-col border-l bg-background max-xl:fixed max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:w-[min(420px,100vw)] max-xl:shadow-2xl">
      <Tabs
        value={tab}
        onValueChange={(v) => onTab(v as "thread" | "employee" | "tickets")}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="lilos-drag flex h-14 shrink-0 items-center border-b px-3">
          <TabsList>
            <TabsTrigger value="thread">Thread</TabsTrigger>
            <TabsTrigger value="employee">Employee</TabsTrigger>
            <TabsTrigger value="tickets">Tickets</TabsTrigger>
          </TabsList>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
        <TabsContent value="thread" className="flex min-h-0 flex-1 flex-col">
          {threadPanel ?? (
            <p className="p-6 text-center text-muted-foreground">
              {dm ? (
                <>
                  Pick a session on the left,
                  <br />
                  or send a message to start one.
                </>
              ) : (
                <>
                  Open a thread from the channel.
                  <br />
                  Every @mention of an employee starts one.
                </>
              )}
            </p>
          )}
        </TabsContent>
        <TabsContent value="employee" className="min-h-0 flex-1">
          <ScrollArea className="h-full">{employeeCard}</ScrollArea>
        </TabsContent>
        <TabsContent value="tickets" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <TicketsList tickets={tickets} emp={emp} />
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </aside>
  );
}

export function TicketsList({
  tickets,
  emp,
}: {
  tickets: TicketRow[];
  emp: EmpFn;
}) {
  return (
    <div className="space-y-2 p-3">
      <p className="text-muted-foreground text-xs">
        Tickets belong to the project. Each links to the thread where the work
        happened.
      </p>
      {tickets.map((t) => (
        <div key={t.id} className="rounded-lg border bg-background p-2.5">
          <div className="flex items-center gap-2">
            <span className="shrink-0 whitespace-nowrap font-mono text-muted-foreground text-xs">
              {t.id}
            </span>
            <span className="min-w-0 truncate font-medium">{t.title}</span>
            <Badge variant="secondary" className="ml-auto shrink-0">
              {t.status}
            </Badge>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-muted-foreground text-xs">
            <HermesAvatar name={emp(t.who)?.name} className="size-4" />
            {emp(t.who)?.name} · #{t.ch}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-muted-foreground text-xs">
            {t.branch ? (
              <>
                <GitBranchIcon className="size-3.5 shrink-0" />
                <span className="truncate font-mono">{t.branch}</span>
                <span className="ml-auto shrink-0 whitespace-nowrap">
                  .lilos/wt/{t.id.toLowerCase()}
                </span>
              </>
            ) : (
              <>
                <FolderGit2Icon className="size-3.5 shrink-0" />
                no worktree · office work
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
