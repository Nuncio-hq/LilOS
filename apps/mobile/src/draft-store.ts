import AsyncStorage from "@react-native-async-storage/async-storage";
import { atom } from "nanostores";

/* #556 AC-2: composer drafts, per conversation and device-local — a
   half-typed reply survives leaving the thread and iOS killing the app.
   `thread:<conversationId>` for thread composers, `dm:<employeeId>` for a
   DM's new-thread box. Plain AsyncStorage like the caches: a draft is not
   a secret. */
const KEY = "lilos.drafts.v1";
const DEBOUNCE_MS = 300;

const $drafts = atom<Map<string, string>>(new Map());
let timer: ReturnType<typeof setTimeout> | undefined;

function persist(immediate: boolean): void {
  if (timer) clearTimeout(timer);
  const write = () =>
    void AsyncStorage.setItem(
      KEY,
      JSON.stringify(Object.fromEntries($drafts.get())),
    ).catch(() => {});
  /* An emptied draft (send) writes now — a kill inside the debounce window
     would otherwise resurrect text the user already sent. */
  if (immediate) write();
  else timer = setTimeout(write, DEBOUNCE_MS);
}

/** Boot hydrate — runs beside `directoryCache.load()` on connect. */
export async function loadDrafts(): Promise<void> {
  const raw = await AsyncStorage.getItem(KEY).catch(() => null);
  if (!raw) return;
  try {
    const obj = JSON.parse(raw) as Record<string, string>;
    if (obj && typeof obj === "object") {
      $drafts.set(new Map(Object.entries(obj)));
    }
  } catch {
    /* A corrupt record reads as empty — drafts are disposable. */
  }
}

export function draftFor(key: string): string | undefined {
  return $drafts.get().get(key);
}

export function setDraft(key: string, text: string): void {
  const next = new Map($drafts.get());
  if (text === "") next.delete(key);
  else next.set(key, text);
  $drafts.set(next);
  persist(text === "");
}

/** Forget / demo exit (resetDmStore): the Mac's threads are gone, so are
    their drafts. */
export function resetDrafts(): void {
  $drafts.set(new Map());
  if (timer) clearTimeout(timer);
  void AsyncStorage.removeItem(KEY).catch(() => {});
}
