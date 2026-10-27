import type { DescribeResult } from "@lilos/contracts/engine";
import type { EngineConnection } from "../engine/client";
import type { Logger } from "../log";

/**
 * #884 round 1: LilOS's Ask / Full access only works while the engine
 * surfaces every approval — on the engine's own policy scale that mode is
 * `manual`. A user who once set the engine to `off` (or `smart`, which may
 * answer asks itself) would otherwise sit under an "Ask" pill that never
 * produces a card, with Settings no longer able to undo it.
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
  if (cap.detail?.current === "manual") return;
  /* Only engines that can spell `manual` get written — a capability with
     other options is a different machine and is left alone. */
  const options = cap.detail?.options;
  if (Array.isArray(options) && !options.includes("manual")) return;
  try {
    await conn.request("approvals.setPolicy", { policy: "manual" });
    cap.detail = { ...cap.detail, current: "manual" };
  } catch (error) {
    log?.warn("approval policy reset refused", { error: String(error) });
  }
}
