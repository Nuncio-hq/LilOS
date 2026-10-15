import { PlugIcon, PlusIcon, TerminalSquareIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type { V2Agent } from "./v2-types";
import type { V2Connector } from "./v2-work-types";

const STATE: Record<V2Connector["state"], { label: string; cls: string }> = {
  ready: { label: "Ready", cls: "bg-emerald-500" },
  "signed-out": { label: "Signed out", cls: "bg-amber-500" },
  missing: { label: "Not found", cls: "bg-red-500" },
};

/* Settings → Connectors: outside services an agent can use through their own
   CLI or MCP server. Zero or many; LilOS knows only the command it runs and
   which agents use it. Each row: kind icon, name + command, the agents it is
   on for, and its state. */
export function V2Connectors({
  connectors,
  agents,
  onToggle,
  onAdd,
}: {
  connectors: V2Connector[];
  agents: V2Agent[];
  onToggle: (connectorId: string, agentId: string) => void;
  onAdd?: () => void;
}) {
  const live = agents.filter((a) => !a.soon);
  return (
    <div className="flex flex-col gap-3">
      <div className="divide-y divide-foreground/[0.06] overflow-hidden rounded-2xl ring-1 ring-foreground/[0.07]">
        {connectors.length === 0 && (
          <div className="px-4 py-6 text-center text-[13px] text-muted-foreground">
            No connectors. Agents still work; they just can't reach outside
            services.
          </div>
        )}
        {connectors.map((c) => {
          const Kind = c.kind === "mcp" ? PlugIcon : TerminalSquareIcon;
          return (
            <div key={c.id} className="flex flex-col gap-2.5 px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground/[0.05] text-muted-foreground">
                  <Kind className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-[13.5px]">{c.name}</span>
                    <span className="rounded bg-foreground/[0.06] px-1 font-mono text-[10.5px] text-muted-foreground uppercase">
                      {c.kind}
                    </span>
                  </div>
                  <div className="truncate text-[12px] text-muted-foreground">
                    {c.about}
                  </div>
                </div>
                <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
                  <span
                    className={cn("size-1.5 rounded-full", STATE[c.state].cls)}
                  />
                  {STATE[c.state].label}
                </span>
              </div>
              <code className="truncate rounded-md bg-foreground/[0.035] px-2 py-1 font-mono text-[11.5px] text-foreground/75">
                {c.command}
              </code>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[11.5px] text-muted-foreground">
                  On for
                </span>
                {live.map((a) => {
                  const on = c.agentIds.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => onToggle(c.id, a.id)}
                      title={`${on ? "Turn off" : "Turn on"} for ${a.name}`}
                      className={cn(
                        "flex h-7 items-center gap-1.5 rounded-full pr-2.5 pl-1 text-[12px] transition-colors",
                        on
                          ? "bg-foreground/[0.08] text-foreground"
                          : "text-muted-foreground opacity-60 ring-1 ring-foreground/10 hover:opacity-100",
                      )}
                    >
                      <HermesAvatar name={a.name} className="size-5" />
                      {a.name}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          className="flex h-10 items-center justify-center gap-2 rounded-xl border border-foreground/15 border-dashed text-[13px] text-muted-foreground hover:text-foreground"
        >
          <PlusIcon className="size-4" />
          Add a CLI or MCP server
        </button>
      )}
    </div>
  );
}
