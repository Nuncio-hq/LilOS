import { cn } from "../lib/utils";
import { useMenu } from "./v3-keys";
import { Avatar } from "./v3-marks";
import type { V3PageProps } from "./v3-page-types";
import type { V3ConnectorDef } from "./v3-types";

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
  const { open, setOpen, trigger, list, close, onKeyDown } = useMenu();
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
          ref={trigger}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="text-[13px] text-muted-foreground/70 hover:text-foreground"
        >
          + Add
        </button>
        {open && (
          <>
            <div
              ref={list}
              role="menu"
              aria-label="Add a connector"
              tabIndex={-1}
              onKeyDown={onKeyDown}
              className="absolute top-full left-0 z-20 mt-1 w-[230px] rounded-lg border border-[var(--v3-line)] bg-background py-1 text-[13.5px]"
            >
              {off.length === 0 && (
                <p className="px-3 py-1.5 text-muted-foreground">
                  Every connector is on.
                </p>
              )}
              {off.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    toggle(c.id, agentId);
                    close();
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
                role="menuitem"
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
