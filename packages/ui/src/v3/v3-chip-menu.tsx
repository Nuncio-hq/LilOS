import { CheckIcon, ChevronDownIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/utils";

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
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // Opening puts the keyboard on the current choice (or the first).
  useEffect(() => {
    if (!open) return;
    const items = list.current?.querySelectorAll<HTMLElement>("button");
    const on = list.current?.querySelector<HTMLElement>(
      '[aria-checked="true"]',
    );
    (on ?? items?.[0])?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      // Closes the menu, not the peek behind it.
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(list.current?.querySelectorAll("button") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

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
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Close ${title.toLowerCase()} menu`}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
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
