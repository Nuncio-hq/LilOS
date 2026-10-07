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
  /** A single action the notice offers — "Undo" on a rewind (#578). */
  action?: { label: string; run: () => void };
  /** How long the notice stays — the 10 s Undo window rides this. */
  durationMs?: number;
}

export const toast = atom<Toast | null>(null);

let timer: ReturnType<typeof setTimeout> | undefined;

function show(t: Toast): void {
  toast.set(t);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => toast.set(null), t.durationMs ?? 4_000);
}

/** Show a plain message for a few seconds, replacing any current one. */
export function say(message: string): void {
  show({ text: message });
}

/** Same toast with the destructive accent — a failed action's notice. */
export function sayError(message: string): void {
  show({ text: message, error: true });
}

/** A message with one action for `durationMs` — the Undo toast (#578). */
export function sayAction(
  message: string,
  action: { label: string; run: () => void },
  durationMs: number,
): void {
  show({ text: message, action, durationMs });
}

/** Clear whatever notice is up right now (e.g. a consumed Undo). */
export function clearToast(): void {
  if (timer) clearTimeout(timer);
  toast.set(null);
}

/** The `(text, {error})` shape Focus/Workbench `say` props take: a
    flagged line gets the destructive accent, anything else stays a
    neutral note (#423). */
export function sayNotice(text: string, opts?: { error?: boolean }): void {
  if (opts?.error) sayError(text);
  else say(text);
}
