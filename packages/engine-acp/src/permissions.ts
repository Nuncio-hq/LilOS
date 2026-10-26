import type * as acp from "@agentclientprotocol/sdk";
import type {
  ApprovalOption,
  ApprovalOutcome,
  EngineRequest,
} from "@lilos/contracts/engine";

/**
 * D-#764 — ACP `session/request_permission` -> LilOS `request.opened`
 * approval ask, shared by every ACP runtime.
 *
 * The grant optionId — not the kind — carries the real answer: agents reuse
 * kind `allow_always` for two different grants (`allow_session` dies with
 * the session, `allow_always` persists the grant), so kind alone cannot map
 * an answer back — a "always" pick by kind silently became the
 * session-scoped option (issue #133). The optionId is trusted first; kind
 * is only the fallback for ids we do not recognize.
 *
 * #106 added the session grant to the protocol: `allow_session` maps to the
 * `session` outcome by optionId (kind can't tell it from `allow_always`).
 */

/** Minimal shape of a `session/request_permission` option (acp.PermissionOption). */
export interface AcpPermissionOptionLike {
  optionId: string;
  kind?: string | null;
}

/** Known option ids -> the grant each carries (kind `allow_always` is
    overloaded, so `allow_session` resolves by id only). */
const OPTION_ID_OUTCOMES: Record<string, ApprovalOption | undefined> = {
  allow_once: "once",
  allow_session: "session",
  allow_always: "always",
  deny: "deny",
  deny_always: "deny",
  reject_once: "deny",
  reject_always: "deny",
};

/** Kind -> outcome, used only when the optionId is not a known id. */
const KIND_OUTCOMES: Record<string, ApprovalOption> = {
  allow_once: "once",
  allow_always: "always",
  reject_once: "deny",
  reject_always: "deny",
};

/** Canonical optionIds tried first per outcome, before any fallback. */
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
export function acpPermissionOutcome(
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
 * The optionId answering `outcome`: the canonical id first, then the
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

/** The `command` line a permission card shows — tool title/name or its input. */
export function acpPermissionCommand(
  toolCall: acp.RequestPermissionRequest["toolCall"] | undefined,
): string {
  return (
    (typeof toolCall?.title === "string" && toolCall.title) ||
    (typeof toolCall?.name === "string" && toolCall.name) ||
    JSON.stringify(toolCall?.rawInput ?? {})
  );
}

/** The approval EngineRequest one permission request opens. */
export function acpApprovalRequest(
  params: acp.RequestPermissionRequest,
): EngineRequest {
  return {
    kind: "approval",
    command: acpPermissionCommand(params.toolCall),
    options: acpOfferedOutcomes(params.options ?? []),
  };
}

/**
 * The answer a chosen outcome sends back on the wire, plus the outcome that
 * was actually granted (for the `request.resolved` echo — #133 AC-3: a
 * downgrade surfaces instead of silently sticking). An unanswerable outcome
 * falls back to deny; with no deny option there is no safe pick — answering
 * options[0] would be the same silent upgrade #133 was — so we cancel.
 */
export function acpPermissionAnswer(
  params: acp.RequestPermissionRequest,
  outcome: ApprovalOutcome,
): { response: acp.RequestPermissionResponse; granted: ApprovalOutcome } {
  const options = params.options ?? [];
  if (outcome === "cancel")
    return {
      response: { outcome: { outcome: "cancelled" } },
      granted: "cancel",
    };
  const optionId =
    acpPickOptionId(options, outcome) ?? acpPickOptionId(options, "deny");
  if (!optionId)
    return {
      response: { outcome: { outcome: "cancelled" } },
      granted: "cancel",
    };
  const granted = acpPermissionOutcome({ optionId }) ?? outcome;
  return {
    response: { outcome: { outcome: "selected", optionId } },
    granted,
  };
}
