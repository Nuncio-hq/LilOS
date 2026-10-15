import { useCallback, useState } from "react";

/* D-#320: turn-block collapse state is user-owned, keyed by conv+turn+block
   ("c1:t1.steps" etc). Auto-open is only a default while a turn runs. The
   web thread can remount a turn card when its live row claims the relay
   row's id — React state alone then forgets the user's click. A keyed store
   outlives the remount so open/collapse still wins (web row keys use
   `r.turnId`; dm.tsx stamps the conv id in). Not: auto-open as a lock, or
   per-component `useState` only. */
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
