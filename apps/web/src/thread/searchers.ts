import type { FileMention, SlashItem } from "@lilos/ui/types";
import { hasCapability } from "../lib/actions";
import { hostSearch } from "../lib/host";
import { relay } from "../lib/runtime";

/* Stable searcher identity per scope: the composer's effect keys on the
   function — a fresh lambda each render would refire the search in a loop.
   Module-level so every surface that mounts the same scope shares one. */
const fileSearchers = new Map<string, (q: string) => Promise<FileMention[]>>();
const commandSearchers = new Map<string, (q: string) => Promise<SlashItem[]>>();

/** `@` mentions' Files section: fs.search over the session folder. No folder
    (or a missing one) → no Files section at all (D-#19). */
export function fileSearch(folderPath: string | null | undefined) {
  if (!folderPath) return undefined;
  let f = fileSearchers.get(folderPath);
  if (!f) {
    f = (q: string) => hostSearch(folderPath, q).then((r) => r.files);
    fileSearchers.set(folderPath, f);
  }
  return f;
}

/** The `/` menu's provider (issue #109): the engine's own command list,
    session-scoped once a conversation exists (folder-local skills ride the
    session's cwd). Engines without the `commands` capability get no
    provider → no menu (D-#19). */
export function sessionCommands(engineRef: string | null | undefined) {
  if (!engineRef || !hasCapability("commands")) return undefined;
  let f = commandSearchers.get(engineRef);
  if (!f) {
    f = (q: string) =>
      relay.request<SlashItem[]>("commands.list", {
        sessionId: engineRef,
        query: q,
      });
    commandSearchers.set(engineRef, f);
  }
  return f;
}
