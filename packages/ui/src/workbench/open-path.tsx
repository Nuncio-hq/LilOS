import { ExternalLinkIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { cn } from "../lib/utils";
import type { OsApp, OsEditor } from "../types";

/* The one "Open in … / Reveal in Finder" menu behind every open affordance
   (session-folder badge, file rows, diff file headers — issue #110).
   Rendered only where the app wires a working onOpen (the host's os.open,
   D-#19); with no editor detected the menu offers Reveal in Finder alone. */
export function OpenPathMenu({
  editors,
  onOpen,
  trigger,
  children,
}: {
  /** Detected editors (os.editors), first = default; [] → Reveal-only. */
  editors: OsEditor[];
  onOpen: (app: OsApp) => void;
  /** Trigger element — a <button>/<Button>; `children` render inside it. */
  trigger: ReactElement;
  children?: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} data-openpath>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {editors.map((e) => (
          <DropdownMenuItem
            key={e.id}
            onClick={() => onOpen(e.id)}
            data-openwith={e.id}
          >
            Open in {e.name}
          </DropdownMenuItem>
        ))}
        {editors.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem
          onClick={() => onOpen("finder")}
          data-openwith="finder"
        >
          Reveal in Finder
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* Icon-button variant for rows (file tree, diff headers). */
export function OpenPathButton({
  editors,
  onOpen,
  label,
  className,
}: {
  editors: OsEditor[];
  onOpen: (app: OsApp) => void;
  label: string;
  className?: string;
}) {
  return (
    <OpenPathMenu
      editors={editors}
      onOpen={onOpen}
      trigger={
        <button
          type="button"
          aria-label={label}
          className={cn(
            "inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground",
            className,
          )}
        />
      }
    >
      <ExternalLinkIcon className="size-3.5" />
    </OpenPathMenu>
  );
}
