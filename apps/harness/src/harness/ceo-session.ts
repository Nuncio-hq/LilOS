import type { RelayClient } from "@lilos/client-runtime";
import { CEO_SETTING_KEY } from "@lilos/contracts/app";
import type { Logger } from "../log";

/**
 * Did this employee hold the CEO position when we asked (D-#778)?
 * Read once, immediately before `session.start`, and stamped on the
 * gateway session. A lookup failure starts the thread without the
 * position's tools — the next thread can pick them up — rather than
 * refusing to open a chat.
 */
export async function employeeHoldsCeo(
  relay: RelayClient,
  employeeId: string | undefined,
  log: Logger,
): Promise<boolean> {
  if (!employeeId) return false;
  try {
    const r = await relay.request<{ value: unknown }>("settings.get", {
      key: CEO_SETTING_KEY,
    });
    return r.value === employeeId;
  } catch (error) {
    log.warn("ceo lookup failed", { error: String(error) });
    return false;
  }
}
