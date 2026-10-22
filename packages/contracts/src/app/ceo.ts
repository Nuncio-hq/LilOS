/**
 * The CEO is a position, not an employee type (D-#778). The holder’s id
 * lives in the settings KV under this key so it shares the company with
 * every other surface and needs no new table. It moves only through
 * `company.setCeo`: that one write also re-points `reportsTo`, so a bare
 * `settings.set` of this key is rejected.
 */
export const CEO_SETTING_KEY = "ceoId";

/** The standing CEO thread (D-#777). The host writes it. It is not the
    position: clearing the seat clears this too, so the next holder does
    not inherit the previous thread. */
export const CEO_THREAD_KEY = "ceoThreadId";

/** A `reportsTo` rewrite would loop. The relay maps it to invalid_params. */
export class CeoGraphError extends Error {
  constructor(message = "reportsTo would cycle") {
    super(message);
    this.name = "CeoGraphError";
  }
}

/**
 * Who points where after `employeeId` takes the position (D-#778).
 * The new CEO reports to the owner. Everyone who reported to the previous
 * CEO, or to the owner, now reports to the new CEO. A person who already
 * reports to someone else keeps that link — this is not a flatten.
 * `reportsTo: null` clears the link (the owner).
 */
export function reportsToAfterCeo(
  employees: readonly { id: string; reportsTo?: string }[],
  oldCeoId: string | undefined,
  newCeoId: string,
): { id: string; reportsTo: string | null }[] {
  const patches: { id: string; reportsTo: string | null }[] = [];
  for (const e of employees) {
    if (e.id === newCeoId) {
      if (e.reportsTo) patches.push({ id: e.id, reportsTo: null });
      continue;
    }
    const toOwner = e.reportsTo === undefined;
    const toOld = oldCeoId !== undefined && e.reportsTo === oldCeoId;
    if (toOwner || toOld) patches.push({ id: e.id, reportsTo: newCeoId });
  }
  return patches;
}

/** The roster after `patches` (`null` drops the link). */
export function withReportsTo<T extends { id: string; reportsTo?: string }>(
  employees: readonly T[],
  patches: readonly { id: string; reportsTo: string | null }[],
): T[] {
  const byId = new Map(patches.map((p) => [p.id, p.reportsTo]));
  return employees.map((e) => {
    if (!byId.has(e.id)) return e;
    const next = byId.get(e.id);
    if (!next) {
      const { reportsTo: _drop, ...rest } = e;
      return rest as T;
    }
    return { ...e, reportsTo: next };
  });
}

/** Walk every chain. A repeated id is a cycle — the write must not land. */
export function assertReportsAcyclic(
  employees: readonly { id: string; reportsTo?: string }[],
): void {
  const mgr = new Map(employees.map((e) => [e.id, e.reportsTo]));
  for (const e of employees) {
    const seen = new Set<string>([e.id]);
    let cur = e.reportsTo;
    while (cur) {
      if (seen.has(cur)) throw new CeoGraphError();
      seen.add(cur);
      cur = mgr.get(cur);
    }
  }
}
