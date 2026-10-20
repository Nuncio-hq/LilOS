import type { Employee } from "@lilos/contracts/app";
import { useCallback, useMemo } from "react";
import { toUiEmployee } from "../lib/mapping";

/* #430: `empFn` is stable across renders — the memoized turn rows compare
   `emp` by identity, so a fresh closure each render would defeat the memo. */
export function useEmployeeLookup(employees: Employee[], engineDown: boolean) {
  const empFn = useCallback(
    (id: string) => {
      const e = employees.find((x) => x.id === id);
      return e ? toUiEmployee(e, engineDown) : undefined;
    },
    [employees, engineDown],
  );
  /* `@` mentions (#105): every employee in the Employees section. */
  const mentionables = useMemo(
    () => employees.map((e) => toUiEmployee(e, engineDown)),
    [employees, engineDown],
  );
  return { empFn, mentionables };
}
