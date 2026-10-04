import { useSyncExternalStore } from "react";

/**
 * #512: a held (stubbed) turn row carries no text nodes (#430), so browser
 * find-in-page can't match inside it. A find chord — Cmd/Ctrl+F,
 * Cmd/Ctrl+G (find next/prev) or F3 — opens a ~10 s window in which every
 * held row mounts its real content so find lands; each chord re-arms the
 * window and rows re-stub when it lapses. The chord is only observed,
 * never consumed: the browser's own find bar must still open.
 *
 * apps/desktop has no app-level find (Electron's editMenu role carries no
 * Find item, nothing calls `webContents.findInPage`), so this window-level
 * keydown path is the only one to hook — and it rides in packages/ui so
 * the prototype and apps/web share it.
 */

export const FIND_UNSTUB_MS = 10_000;

/* e2e/dev knob — `?findUnstubMs=` shortens the window (same pattern as
   `?statusPollMs=` in apps/web/src/lib/config.ts) so a spec can prove the
   DOM re-bounds without a real 10 s wait. Read once at module load. */
const windowMs = (() => {
  if (typeof window === "undefined") return FIND_UNSTUB_MS;
  const v = Number(
    new URLSearchParams(window.location.search).get("findUnstubMs"),
  );
  return Number.isFinite(v) && v > 0 ? v : FIND_UNSTUB_MS;
})();

const listeners = new Set<() => void>();
let active = false;
let timer: ReturnType<typeof setTimeout> | undefined;

const emit = () => {
  for (const l of listeners) l();
};

/** A find chord landed: open the un-stub window, or re-arm it. */
function noteFindChord() {
  const was = active;
  active = true;
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    active = false;
    emit();
  }, windowMs);
  if (!was) emit();
}

const isFindChord = (e: KeyboardEvent) => {
  if (e.key === "F3") return true;
  if (!e.metaKey && !e.ctrlKey) return false;
  const k = e.key.toLowerCase();
  return k === "f" || k === "g";
};

const onKeyDown = (e: KeyboardEvent) => {
  if (isFindChord(e)) noteFindChord();
};

/* Subscribing mounts the one shared listener — capture phase so a field's
   own keydown handler can't shadow the chord; the last unsubscribe drops
   it again. Only lazy threads subscribe (LazyShell gates on `lazy`), so
   short threads never pay for this. */
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1 && typeof window !== "undefined")
    window.addEventListener("keydown", onKeyDown, true);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      if (typeof window !== "undefined")
        window.removeEventListener("keydown", onKeyDown, true);
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      active = false;
    }
  };
}

const noopSubscribe = () => () => {};

/** True while the find window is open — LazyShell reads it to keep every
    row mounted. A row in a short thread (`engaged` false) never subscribes
    and never mounts the keydown listener. */
export function useFindUnstub(engaged: boolean): boolean {
  return useSyncExternalStore(
    engaged ? subscribe : noopSubscribe,
    () => active,
    () => false,
  );
}
