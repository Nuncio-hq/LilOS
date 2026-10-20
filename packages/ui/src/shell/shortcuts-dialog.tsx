import { KeyboardIcon, XIcon } from "lucide-react";
import { useUiLayerEl } from "../chat/ui-layers";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";

/* ⌘/ — the shortcut list. One static table so every chord the app binds
   is discoverable in-app; rows flagged `desktop` are the chords a browser
   reserves, so they render (and are labelled) only inside the Electron
   shell where the menu owns them. */

export interface ShortcutRow {
  keys: string;
  action: string;
  /** True = desktop app only — the browser reserves the chord. */
  desktop?: boolean;
}

export const SHORTCUTS: ShortcutRow[] = [
  {
    keys: "⌘K",
    action: "Search — jump to a person, a thread or a page",
  },
  {
    keys: "⌘N",
    action: "New chat with the agent on screen",
    desktop: true,
  },
  {
    keys: "⌘1–⌘9",
    action: "Open the Nth agent",
    desktop: true,
  },
  { keys: "⌘[", action: "Back" },
  { keys: "⌘]", action: "Forward" },
  { keys: "⌘/", action: "This list" },
  { keys: "⌘,", action: "Settings" },
  { keys: "⌘F", action: "Find in the open thread", desktop: true },
  { keys: "⌘.", action: "Stop the running turn" },
  { keys: "↑", action: "Recall the last sent message (empty composer)" },
  { keys: "Esc", action: "Close the top layer" },
];

export function ShortcutsDialog({
  desktop,
  onClose,
}: {
  /** Inside the Electron shell — shows the desktop-only rows. */
  desktop?: boolean;
  onClose: () => void;
}) {
  const layerRef = useUiLayerEl<HTMLDivElement>({ onEscape: onClose });
  const rows = SHORTCUTS.filter((r) => desktop || !r.desktop);
  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-6"
      onClick={onClose}
      data-shortcuts-dialog
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        ref={layerRef}
        className="w-full max-w-md overflow-hidden rounded-2xl border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b p-4">
          <KeyboardIcon className="size-5 text-muted-foreground" />
          <div className="flex-1 font-semibold">Keyboard shortcuts</div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
        <ScrollArea className="max-h-[60dvh]">
          <table className="w-full text-sm">
            <tbody>
              {rows.map((r) => (
                <tr key={r.keys} className="border-b last:border-0">
                  <td className="w-24 px-4 py-2 whitespace-nowrap">
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {r.keys}
                    </kbd>
                  </td>
                  <td className="px-4 py-2 text-foreground/90">{r.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
      </div>
    </div>
  );
}
