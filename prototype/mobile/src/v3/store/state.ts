import type { V3Data, V3Thread } from "@lilos/ui/v3-data";
import { atom } from "nanostores";
import { seed } from "./seed";

/** The whole fake company. Every screen derives its counts from this. */
export const $data = atom<V3Data>(seed());

/** The ask the Needs card stack shows first (a notification tap sets it). */
export const $focusAsk = atom<string | undefined>(undefined);

export function focusAsk(id: string | undefined): void {
  $focusAsk.set(id);
}

export function patchThread(id: string, fn: (t: V3Thread) => V3Thread): void {
  const d = $data.get();
  $data.set({ ...d, threads: d.threads.map((t) => (t.id === id ? fn(t) : t)) });
}

export function markSeen(threadId: string): void {
  const d = $data.get();
  if (!d.threads.some((t) => t.id === threadId && t.unseen)) return;
  $data.set({
    ...d,
    threads: d.threads.map((t) =>
      t.id === threadId ? { ...t, unseen: false } : t,
    ),
  });
}
