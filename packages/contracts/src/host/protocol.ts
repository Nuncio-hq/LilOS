/**
 * Protocol identity for the LilOS host API. The host answers questions about
 * the machine a session runs on (its filesystem, git checkouts and forge);
 * it is implemented by the harness (apps/harness, #26), never by an engine.
 */
export const HOST_API = { name: "lilos-host", version: 1 } as const;

/**
 * Wire framing is JSON-RPC 2.0 (same convention as the engine and app
 * protocols): standard -326xx codes plus host-domain codes in -321xx.
 */
export const HOST_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Path does not exist on the host machine. */
  PATH_NOT_FOUND: -32101,
  /** Path exists but is not inside a git work tree. */
  NOT_A_REPO: -32102,
  /** No pull request exists for the checkout's branch / requested number. */
  PR_NOT_FOUND: -32103,
  /** `gh` CLI failed: missing, unauthenticated, or the forge rejected the op
      (stderr is carried in error data `detail`). */
  GH_FAILED: -32104,
  /** `os.open` path resolves outside the given session root. */
  OUTSIDE_ROOT: -32105,
  /** `os.open` asked for an app that isn't detected on this host. */
  APP_NOT_FOUND: -32106,
  /** `os.open` launch failed (argv exec error; detail in error data). */
  OPEN_FAILED: -32107,
} as const;
export type HostErrorCode = (typeof HOST_ERRORS)[keyof typeof HOST_ERRORS];
