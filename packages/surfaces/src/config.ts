/**
 * Env wiring the harness sets on the MCP server / an operator sets for the
 * CLI (AC-3's spawn contract): one base URL + token + session id binds every
 * tool call to that session's surfaces.
 */
export interface SurfacesEnv {
  baseUrl: string;
  token: string;
  session: string;
}

export const SURFACES_ENV = {
  baseUrl: "LILOS_SURFACES_URL",
  token: "LILOS_TOKEN",
  session: "LILOS_SESSION",
} as const;

export function surfacesEnv(
  env: Record<string, string | undefined>,
): SurfacesEnv | { error: string } {
  const baseUrl = env[SURFACES_ENV.baseUrl];
  const token = env[SURFACES_ENV.token];
  const session = env[SURFACES_ENV.session];
  if (!baseUrl || !token || !session) {
    return {
      error:
        `missing env: need ${SURFACES_ENV.baseUrl}, ${SURFACES_ENV.token}, ` +
        `${SURFACES_ENV.session} (the harness sets all three on the MCP server it spawns)`,
    };
  }
  return { baseUrl, token, session };
}
