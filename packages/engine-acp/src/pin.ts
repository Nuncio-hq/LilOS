/**
 * D-#764 — the ACP version this seam speaks, pinned in exactly one place.
 *
 * `ACP_SCHEMA_RELEASE` names the upstream stable schema release the code
 * maps to: the v1 line, not the v2 preview (v2 is still alpha upstream —
 * some agents default to it unless asked for v1, so the seam must be
 * explicit). `ACP_SDK_VERSION` pins the `@agentclientprotocol/sdk` release
 * that generates its types from that schema; `ACP_PROTOCOL_VERSION` is the
 * value `initialize.protocolVersion` must negotiate.
 *
 * Bump all three together: a newer schema release without the matching SDK
 * is untested surface, an SDK drift without the release string means the
 * mapping may silently speak an older protocol. `scripts/check-pin.ts`
 * (wired into `schema:check` / `verify:fast`) fails when the installed SDK,
 * the protocol constant, or the schema surface this package relies on
 * drifts from these values.
 */
export const ACP_SCHEMA_RELEASE = "schema-v1.26.0";
export const ACP_SDK_VERSION = "1.9.0";
export const ACP_PROTOCOL_VERSION = 1;

/**
 * The slice of the pinned schema the mapping depends on. `check-pin.ts`
 * greps the SDK's bundled `schema/schema.json` for every entry — a release
 * that drops or renames any of them is the drift the pin exists to catch
 * before the code ships.
 */
export const ACP_REQUIRED_METHODS = [
  "initialize",
  "session/new",
  "session/load",
  "session/prompt",
  "session/cancel",
  "session/close",
  "session/set_mode",
  "session/set_config_option",
  "session/request_permission",
  "session/update",
] as const;

/** `sessionUpdate` kinds the mapper handles (plus anything else ignored). */
export const ACP_UPDATE_KINDS = [
  "agent_message_chunk",
  "agent_thought_chunk",
  "user_message_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "plan_removed",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
  "notice",
  "compaction_update",
  "compaction_summary_chunk",
] as const;
