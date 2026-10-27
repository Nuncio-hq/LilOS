import type { DescribeResult } from "@lilos/contracts/engine";
import type { EngineConnection } from "../engine/client";
import type { Logger } from "../log";

/**
 * #884 round 1: LilOS's "Ask before risky commands" maps to the engine's
 * `smart` — its ask-for-the-risky-ones mode. A user who once set the
 * engine to `off` would otherwise sit under an "Ask" pill that never
 * produces a card, with Settings no longer able to undo it, so `off` is
 * the only value corrected — `smart` already asks and `manual` is a
 * deliberate choice the engine side may keep (pinning to manual would
 * gate every `ls`, a change Oscar never asked for).
 *
 * Called on every describe — engine attach AND the status probe, which
 * re-describes each heartbeat — so a drifted value is re-applied, not
 * migrated once. A refused write is logged and left: the next probe tries
 * again. The passed `desc` is patched in place so whatever caches it
 * reports the enforced truth, not the stale read.
 */
export async function enforceApprovalPolicy(
  conn: EngineConnection,
  desc: DescribeResult,
  log?: Logger,
): Promise<void> {
  const cap = desc.capabilities.find((c) => c.id === "approval_policy");
  if (!cap) return;
  if (cap.detail?.current !== "off") return;
  /* Only engines that can spell `smart` get written — a capability with
     other options is a different machine and is left alone. */
  const options = cap.detail?.options;
  if (Array.isArray(options) && !options.includes("smart")) return;
  try {
    await conn.request("approvals.setPolicy", { policy: "smart" });
    cap.detail = { ...cap.detail, current: "smart" };
  } catch (error) {
    log?.warn("approval policy reset refused", { error: String(error) });
  }
}
