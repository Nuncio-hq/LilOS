import { EllipsisIcon } from "lucide-react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { cn } from "../lib/utils";

/* A sidebar project row's ⋯ (D-#854). Its one action is Remove project —
   a two-step confirm inside the same popup (the first pick arms it, the
   second fires), because removal is the owner's call and lives nowhere else.
   The popup is a portal, so it escapes the sidebar's scroll clip. */
export function ProjectMenu({
  name,
  onRemove,
}: {
  name: string;
  /** Fires on the armed confirm. Absent: no menu at all. */
  onRemove?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!onRemove) return null;
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setConfirming(false);
      }}
    >
      <DropdownMenuTrigger
        aria-label={`${name} — project menu`}
        title="Project menu"
        data-project-menu
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded text-muted-foreground/50 transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground data-popup-open:bg-[var(--v3-hover)] data-popup-open:text-foreground",
        )}
      >
        <EllipsisIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 min-w-0">
        {confirming ? (
          <>
            <div
              data-project-confirm
              className="px-1.5 py-1 text-muted-foreground text-xs"
            >
              Threads stay as chats; the folder isn&apos;t touched.
            </div>
            <DropdownMenuItem
              variant="destructive"
              disabled={busy}
              data-project-remove-confirm
              onClick={() => {
                setBusy(true);
                /* A failed remove rejects (its toast already ran) — the
                   menu just settles; only success navigates (#854 r2). */
                void Promise.resolve(onRemove())
                  .catch(() => {})
                  .finally(() => {
                    setBusy(false);
                    setOpen(false);
                    setConfirming(false);
                  });
              }}
            >
              Remove {name}
            </DropdownMenuItem>
            <DropdownMenuItem
              closeOnClick={false}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem
            variant="destructive"
            closeOnClick={false}
            data-project-remove
            onClick={() => setConfirming(true)}
          >
            Remove project…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
