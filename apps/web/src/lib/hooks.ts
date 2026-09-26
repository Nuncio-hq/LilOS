import type { ReadableAtom } from "nanostores";
import { useCallback, useSyncExternalStore } from "react";

/** useSyncExternalStore shim for nanostores atoms (no extra dependency). */
export function useAtom<T>(store: ReadableAtom<T>): T {
  const subscribe = useCallback(
    (cb: () => void) => store.subscribe(cb),
    [store],
  );
  return useSyncExternalStore(subscribe, () => store.get());
}
