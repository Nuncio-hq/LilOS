import { useState } from "react";
import { cn } from "../lib/utils";
import { Avatar } from "./v3-bits";
import type { V3ConnectorDef, V3PageProps } from "./v3-types";

/* The Connectors row on an agent's page. The page only draws it when the app
   can turn a connector on or off for an agent, so `toggle` is never absent. */

export const PILL =
  "inline-flex h-[24px] items-center gap-1.5 rounded-md border border-[var(--v3-line)] px-2 text-[13px] text-foreground";

/** A connector's state on a chip: a green dot, or a quiet word when it needs
   you. Colour is for state; the mark carries the connector's own colour. */
function ChipState({ state }: { state: V3ConnectorDef["state"] }) {
  if (state === "ready")
    return (
      <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
    );
  return state === "signed-out" ? (
    <span className="text-[12px] text-amber-700 dark:text-amber-300">
      sign in
    </span>
  ) : (
    <span className="text-[12px] text-muted-foreground/70">not found</span>
  );
}

/** The connectors this agent's sessions get. A chip turns its connector off;
   `+ Add` lists the rest and links to where connectors are managed. */
export function Connectors({
  connectors,
  agentId,
  agentName,
  go,
  toggle,
}: {
  connectors: V3ConnectorDef[];
  agentId: string;
  agentName: string;
  toggle: (connectorId: string, agentId: string) => void;
} & Pick<V3PageProps, "go">) {
  const [open, setOpen] = useState(false);
  const on = connectors.filter((c) => c.agents.includes(agentId));
  const off = connectors.filter((c) => !c.agents.includes(agentId));
  return (
    <>
      {on.map((c) => (
        <button
          key={c.id}
          type="button"
          title={`Turn ${c.label} off for ${agentName}`}
          onClick={() => toggle(c.id, agentId)}
          className={cn(PILL, "transition-colors hover:bg-[var(--v3-hover)]")}
        >
          <Avatar name={c.label} tone="n" size={16} look={c.look} />
          {c.label}
          <ChipState state={c.state} />
        </button>
      ))}
      {on.length === 0 && (
        <span className="text-[13px] text-muted-foreground">None</span>
      )}
      <span className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-[13px] text-muted-foreground/70 hover:text-foreground"
        >
          + Add
        </button>
        {open && (
          <>
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-10 cursor-default"
            />
            <div className="absolute top-full left-0 z-20 mt-1 w-[230px] rounded-lg border border-[var(--v3-line)] bg-background py-1 text-[13.5px]">
              {off.length === 0 && (
                <p className="px-3 py-1.5 text-muted-foreground">
                  Every connector is on.
                </p>
              )}
              {off.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    toggle(c.id, agentId);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground hover:bg-[var(--v3-hover)]"
                >
                  <Avatar name={c.label} tone="n" size={16} look={c.look} />
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.state !== "ready" && <ChipState state={c.state} />}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  go({ page: "settings" });
                }}
                className="mt-1 flex w-full items-center border-[var(--v3-line)] border-t px-3 pt-2 pb-1.5 text-left text-muted-foreground hover:text-foreground"
              >
                Manage connectors…
              </button>
            </div>
          </>
        )}
      </span>
    </>
  );
}
