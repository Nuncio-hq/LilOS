import { relay } from "../lib/runtime";

/* Which runtime an employee record names (D-#761) and whether its engine is
   already up — kept apart from the catalog store so the profile and edit
   code can ask without importing it. */

/** The runtime id `models.list`/`agents.*` route by, or undefined for the
    default engine — the roster's first row is the default (D-#761). */
export const defaultRuntimeId = (): string | undefined =>
  relay.status.get()?.result?.runtimes?.[0]?.id;

/** Absent, the literals "default"/"hermes", or the roster's first row all
    name the default engine (the harness's `normalizeRuntime`, D-#761) —
    the literals hold even before the status roster has loaded. */
export const isDefaultRuntime = (runtime: string | undefined): boolean =>
  !runtime ||
  runtime === "default" ||
  runtime === "hermes" ||
  runtime === defaultRuntimeId();

/** A runtime whose engine is up or already coming up — asking one of ITS
    models or profiles adds nothing to the launch cost. Everything else
    (idle, stopped, failed, never reported) must not be started just to
    read a page (D-#866). */
export const runtimeLive = (runtime: string | undefined): boolean => {
  const row = relay.status
    .get()
    ?.result?.runtimes?.find((r) => r.id === runtime);
  return (
    row?.state === "running" ||
    row?.state === "starting" ||
    row?.state === "restarting"
  );
};
