import { CheckIcon, ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { useMenu } from "./v3-keys";

/* One chip that opens a small menu of choices: the new chat's who / where /
   which model, and the model on an agent's page while you edit it. */

const CHIP =
  "inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground";

const ITEM =
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground outline-none hover:bg-[var(--v3-hover)] focus-visible:bg-[var(--v3-hover)]";

export type ChipOption = {
  id: string;
  node: ReactNode;
  /** Does something instead of choosing something (a menu item, not a radio:
      "Add a folder…"); it never shows as the current choice. */
  action?: boolean;
};

export function ChipMenu({
  label,
  title,
  options,
  value,
  onPick,
  below,
  ariaLabel,
  className,
}: {
  label: ReactNode;
  title: string;
  options: ChipOption[];
  value: string;
  onPick: (id: string) => void;
  /** Opens downwards (a chip at the top of a page); the default is above,
      for chips that sit under a composer. */
  below?: boolean;
  /** Names the chip when its text is a value, not what it chooses. */
  ariaLabel?: string;
  className?: string;
}) {
  const { open, setOpen, trigger, list, close, onKeyDown } = useMenu();

  return (
    <span className="relative min-w-0">
      <button
        ref={trigger}
        type="button"
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          CHIP,
          open && "bg-[var(--v3-hover)] text-foreground",
          className,
        )}
      >
        {label}
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
      </button>
      {open && (
        <>
          <div
            ref={list}
            role="menu"
            aria-label={title}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className={cn(
              "absolute left-0 z-20 max-h-[min(280px,50dvh)] min-w-[220px] max-w-[min(340px,calc(100vw-48px))] overflow-y-auto rounded-lg border border-[var(--v3-line)] bg-background py-1 text-[13.5px]",
              below ? "top-full mt-1" : "bottom-full mb-1",
            )}
          >
            {options.map((o) =>
              o.action ? (
                <button
                  key={o.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onPick(o.id);
                    close();
                  }}
                  className={ITEM}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    {o.node}
                  </span>
                </button>
              ) : (
                <button
                  key={o.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={o.id === value}
                  onClick={() => {
                    onPick(o.id);
                    close();
                  }}
                  className={ITEM}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    {o.node}
                  </span>
                  {o.id === value && (
                    <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                </button>
              ),
            )}
          </div>
        </>
      )}
    </span>
  );
}
