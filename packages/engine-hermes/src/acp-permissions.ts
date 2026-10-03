import type { ApprovalOption, ApprovalOutcome } from "@lilos/contracts/engine";

/**
 * ACP permission option -> LilOS approval mapping (issue #133).
 *
 * Hermes' `acp_adapter/permissions.py` reuses kind `allow_always` for two
 * different grants: `allow_session` (dies with the session) and
 * `allow_always` (persists to the profile allowlist). Kind alone therefore
 * cannot map an answer back — a "always" pick by kind silently became the
 * session-scoped option. The optionId carries the real grant; kind is only
 * trusted for ids we do not recognize.
 *
 * #106 added the session grant to the protocol: `allow_session` maps to the
 * `session` outcome by optionId (kind can't tell it from `allow_always`).
 */

/** Minimal shape of a `session/request_permission` option (acp.PermissionOption). */
export interface AcpPermissionOptionLike {
  optionId: string;
  kind?: string | null;
}

/**
 * Known Hermes option ids -> the grant each carries. `allow_session` maps
 * by optionId only — its kind (`allow_always`) alone would pick the wrong
 * grant (issue #133).
 */
const OPTION_ID_OUTCOMES: Record<string, ApprovalOption | undefined> = {
  allow_once: "once",
  allow_session: "session",
  allow_always: "always",
  deny: "deny",
  deny_always: "deny",
  reject_once: "deny",
  reject_always: "deny",
};

/** Kind -> outcome, used only when the optionId is not a known Hermes id. */
const KIND_OUTCOMES: Record<string, ApprovalOption> = {
  allow_once: "once",
  allow_always: "always",
  reject_once: "deny",
  reject_always: "deny",
};

/** Canonical Hermes optionIds tried first per outcome, before any fallback. */
const PREFERRED_IDS: Record<ApprovalOption, readonly string[]> = {
  once: ["allow_once"],
  session: ["allow_session"],
  always: ["allow_always"],
  deny: ["deny", "reject_once", "reject_always", "deny_always"],
};

/**
 * The outcome one option grants; `undefined` when it grants none of ours
 * (`allow_session`) or is unrecognized. Exact optionId wins over kind.
 */
function acpPermissionOutcome(
  o: AcpPermissionOptionLike,
): ApprovalOption | undefined {
  if (o.optionId in OPTION_ID_OUTCOMES) return OPTION_ID_OUTCOMES[o.optionId];
  return KIND_OUTCOMES[o.kind ?? ""];
}

/** Offered LilOS outcomes in option-list order; `["deny"]` when nothing maps. */
export function acpOfferedOutcomes(
  options: readonly AcpPermissionOptionLike[],
): ApprovalOption[] {
  const out: ApprovalOption[] = [];
  for (const o of options) {
    const oc = acpPermissionOutcome(o);
    if (oc && !out.includes(oc)) out.push(oc);
  }
  return out.length ? out : ["deny"];
}

/**
 * The optionId answering `outcome`: the canonical Hermes id first, then the
 * first option that resolves to the outcome (kind fallback for unknown ids).
 * `undefined` when the outcome is not offerable — never a different grant.
 */
export function acpPickOptionId(
  options: readonly AcpPermissionOptionLike[],
  outcome: ApprovalOutcome,
): string | undefined {
  for (const id of PREFERRED_IDS[outcome as ApprovalOption] ?? []) {
    if (options.some((o) => o.optionId === id)) return id;
  }
  return options.find((o) => acpPermissionOutcome(o) === outcome)?.optionId;
}
