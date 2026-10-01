import { useCallback, useState } from "react";

/* #320: turn-block collapse state keyed by conv+turn ("c1:t1.steps" etc).
   The web thread can remount a turn card when its live row claims the
   relay row's id — React state alone then forgets the user's click. A
   keyed store outlives the remount so open/collapse still wins. */
const store = new Map<string, unknown>();
const CAP = 500;

export function useTurnBlockState<T>(
  key: string | undefined,
  initial: T,
): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() =>
    key && store.has(key) ? (store.get(key) as T) : initial,
  );
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const n =
          typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        if (key) {
          store.delete(key); // refresh recency
          store.set(key, n);
          while (store.size > CAP) {
            const oldest = store.keys().next().value;
            if (oldest === undefined) break;
            store.delete(oldest);
          }
        }
        return n;
      });
    },
    [key],
  );
  return [key && store.has(key) ? (store.get(key) as T) : value, set];
}
