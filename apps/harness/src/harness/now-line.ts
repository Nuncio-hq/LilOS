import type { Employee } from "@lilos/contracts/app";
import type { EngineRequest } from "@lilos/contracts/engine";
import type { HarnessCtx, SessionBinding } from "./ctx";

/**
 * The employee "now:" line (#422): per-binding wait/step
 * lines, employee fan-out, and the register-time sweep (was the
 * `employee "now:" line` section of `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

/** What an open request says while it waits on the user (prototype voice). */
export function waitLine(request: EngineRequest): string {
  switch (request.kind) {
    case "approval":
      return "waiting on your approval";
    case "question":
      return "waiting on your answer";
    default:
      return "waiting on you";
  }
}

/** This session's line right now — an open wait outranks the step. */
export function bindingNow(this: HarnessCtx, binding: SessionBinding): string {
  return binding.nowWaits.values().next().value ?? binding.nowStep ?? "";
}

/** Recompute the employee's line after a state change on this binding. */
export function noteNow(this: HarnessCtx, binding: SessionBinding) {
  binding.nowAt = ++this.nowClock;
  const employeeId = this.employeeIdFor(
    this.conversationFromAtom(binding.conversationId),
  );
  if (employeeId) this.pushEmployeeNow(employeeId);
}

/** The freshest non-empty line across the employee's sessions, else "". */
export function employeeNowLine(this: HarnessCtx, employeeId: string): string {
  let line = "";
  let at = -1;
  for (const binding of this.bindings.values()) {
    if (
      this.employeeIdFor(this.conversationFromAtom(binding.conversationId)) !==
      employeeId
    )
      continue;
    const current = this.bindingNow(binding);
    if (current && binding.nowAt > at) {
      at = binding.nowAt;
      line = current;
    }
  }
  return line;
}

export function pushEmployeeNow(this: HarnessCtx, employeeId: string) {
  const line = this.employeeNowLine(employeeId);
  if (this.nowWritten.get(employeeId) === line) return;
  this.nowWritten.set(employeeId, line);
  this.relayWrite(`now ${employeeId}`, () =>
    this.opts.relay.request("employees.update", {
      id: employeeId,
      now: line,
    }),
  );
}

/** On every (re)register the derived truth wins: a `now` a dead harness
    left behind clears, and a live binding's line re-pushes if the wire
    drifted while the socket was down. */
export async function sweepNow(this: HarnessCtx): Promise<void> {
  try {
    const { employees } = await this.opts.relay.request<{
      employees: Employee[];
    }>("employees.list", {});
    for (const employee of employees) {
      const want = this.employeeNowLine(employee.id);
      if (employee.now === want) continue;
      this.nowWritten.set(employee.id, want);
      this.relayWrite(`now sweep ${employee.id}`, () =>
        this.opts.relay.request("employees.update", {
          id: employee.id,
          now: want,
        }),
      );
    }
  } catch (error) {
    this.opts.log.warn("now sweep failed", { error: String(error) });
  }
}
