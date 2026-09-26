import type { EngineClient } from "../src/index.js";

/** EngineClient driven by a stub: canned replies per `method(params)`. */
export function stubEngine(
  handler: (method: string, params: Record<string, unknown>) => unknown,
): EngineClient & { calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      return handler(method, (params ?? {}) as Record<string, unknown>);
    },
  };
}

export function rpcError(code: number, message: string): Error {
  const e = new Error(message) as Error & { code: number };
  e.code = code;
  return e;
}
