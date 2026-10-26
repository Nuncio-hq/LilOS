import { FolderIcon } from "lucide-react";
import { useUiLayerEl } from "../chat/ui-layers";
import { V3Banner } from "./v3-banner";
import { Btn } from "./v3-bits";

/* D-#875: the two macOS folder-access surfaces, one component each. The
   ask step is the in-app half of the OS consent — it says why BEFORE the
   shell's touches raise the real prompts, so "LilOS would like to access
   files in your Desktop folder" lands while the user knows what it is.
   The denied/blocked banner is its remedy: plain words + one button into
   System Settings → Privacy & Security → Files and Folders. */

/** "your Desktop folder" / "your Desktop and Documents folders" /
 *  "your Desktop, Documents and Downloads folders". */
export function foldersPhrase(names: string[]): string {
  const [first, ...rest] = names;
  if (rest.length === 0) return `your ${first} folder`;
  const lead = rest.length > 1 ? `${names.slice(0, -1).join(", ")}` : first;
  return `your ${lead} and ${names[names.length - 1]} folders`;
}

/** The initial ask (a short step, not a nag): names the folders macOS is
 *  about to ask for, one primary action touches them. */
export function FolderAccessStep({
  folders,
  busy,
  onAllow,
  onLater,
}: {
  /** Protected folder names still to ask for ("Desktop", …). */
  folders: string[];
  busy?: boolean;
  onAllow: () => void;
  onLater: () => void;
}) {
  const layerRef = useUiLayerEl<HTMLDivElement>({ onEscape: onLater });
  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-6"
      onClick={onLater}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Folder access"
        ref={layerRef}
        className="w-full max-w-sm rounded-2xl border bg-background p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <FolderIcon className="size-5 shrink-0 text-muted-foreground" />
          <div className="font-semibold text-[15px]">
            Let LilOS read your folders
          </div>
        </div>
        <p className="mt-3 text-[14px] text-muted-foreground leading-relaxed">
          Agents work inside the folders you give them. macOS will ask once for{" "}
          {foldersPhrase(folders)} — allow each prompt so nothing ever waits on
          a prompt you can't see.
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <Btn onClick={onLater}>Not now</Btn>
          <Btn primary onClick={onAllow} disabled={busy}>
            {busy ? "Asking macOS…" : "Allow access"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/** An asked folder still refusing reads (denied, or a prompt never
 *  answered): the plain line above the page + the Settings remedy.
 *  Dismissible — a deliberately denied folder shouldn't nag forever. */
export function FolderAccessBanner({
  folders,
  onSettings,
  onDismiss,
}: {
  folders: string[];
  onSettings: () => void;
  onDismiss?: () => void;
}) {
  return (
    <V3Banner
      status="needs"
      text={`LilOS can't read files in ${foldersPhrase(folders)} — folder access is off.`}
      action={{ label: "Open System Settings", run: onSettings }}
      dismiss={onDismiss}
    />
  );
}
