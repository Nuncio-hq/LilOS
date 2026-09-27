import { atom } from "nanostores";

/**
 * One-line notice bottom-center — the same affordance the prototype uses
 * (prototype/web/src/App.tsx `say`). Rendered once by the app shell.
 */
export const toast = atom<string | null>(null);

let timer: ReturnType<typeof setTimeout> | undefined;

/** Show a plain message for a few seconds, replacing any current one. */
export function say(message: string): void {
  toast.set(message);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => toast.set(null), 4_000);
}
