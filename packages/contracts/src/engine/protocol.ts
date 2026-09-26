/**
 * Protocol identity for the LilOS engine wire. Bumped only on breaking changes;
 * additions travel as new capabilities on `describe` instead.
 */
export const ENGINE_PROTOCOL = { name: "lilos-engine", version: 1 } as const;
