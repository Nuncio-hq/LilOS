import { atom } from "nanostores";

/**
 * One-line notice floating above the composer's area, bottom-center —
 * the same affordance the prototype uses (prototype/web/src/App.tsx
 * `say`). Rendered once by the app shell.
 */
export interface Toast {
  text: string;
  /** Failures carry a destructive accent (#423); absent = a neutral note. */
  error?: boolean;
}

export const toast = atom<Toast | null>(null);

let timer: ReturnType<typeof setTimeout> | undefined;

function show(t: Toast): void {
  toast.set(t);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => toast.set(null), 4_000);
}

/** Show a plain message for a few seconds, replacing any current one. */
export function say(message: string): void {
  show({ text: message });
}

/** Same toast with the destructive accent — a failed action's notice. */
export function sayError(message: string): void {
  show({ text: message, error: true });
}
