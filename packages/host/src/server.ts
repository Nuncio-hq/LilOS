import { HOST_API, HOST_ERRORS, HOST_METHODS } from "@lilos/contracts/host";
import { HostError } from "./errors.js";
import { forgeComment, forgeMerge, forgePr } from "./forge.js";
import { fsComplete, fsList, fsRead, fsTree } from "./fs.js";
import {
  gitBranches,
  gitDiff,
  gitDiscoverRepos,
  gitIsRepo,
  gitStatus,
} from "./git.js";

type Handler = (params: never) => Promise<unknown>;

const HANDLERS: Record<keyof typeof HOST_METHODS, Handler> = {
  "host.describe": async () => ({
    api: HOST_API,
    methods: Object.keys(HOST_METHODS),
  }),
  "fs.list": fsList,
  "fs.complete": fsComplete,
  "fs.tree": fsTree,
  "fs.read": fsRead,
  "git.isRepo": gitIsRepo,
  "git.branches": gitBranches,
  "git.status": gitStatus,
  "git.diff": gitDiff,
  "git.discoverRepos": gitDiscoverRepos,
  "forge.pr": forgePr,
  "forge.comment": forgeComment,
  "forge.merge": forgeMerge,
};

/**
 * Validate + run one host method. Throws HostError with a HOST_ERRORS code;
 * the transport (harness endpoint today, dev middleware in the prototype)
 * turns it into a JSON-RPC error object. Result is schema-checked before it
 * leaves — a bad result is the host's bug, surfaced as INTERNAL_ERROR.
 */
export async function callHost(
  method: string,
  params: unknown,
): Promise<unknown> {
  const contract = HOST_METHODS[method as keyof typeof HOST_METHODS];
  if (!contract) {
    throw new HostError(
      HOST_ERRORS.METHOD_NOT_FOUND,
      `unknown method: ${method}`,
    );
  }
  const parsed = contract.params.safeParse(params ?? {});
  if (!parsed.success) {
    throw new HostError(
      HOST_ERRORS.INVALID_PARAMS,
      `invalid params: ${parsed.error.message}`,
    );
  }
  const handler = HANDLERS[method as keyof typeof HOST_METHODS];
  const result = await handler(parsed.data as never);
  const checked = contract.result.safeParse(result);
  if (!checked.success) {
    throw new HostError(
      HOST_ERRORS.INTERNAL_ERROR,
      `host produced an invalid ${method} result`,
      { issues: checked.error.issues },
    );
  }
  return checked.data;
}

/** One JSON-RPC request frame → one response frame (null for notifications). */
export async function handleHostFrame(frame: string): Promise<string | null> {
  let msg: unknown;
  try {
    msg = JSON.parse(frame);
  } catch {
    return errorText(null, HOST_ERRORS.PARSE_ERROR, "parse error");
  }
  const { id, method, params } = msg as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    return errorText(null, HOST_ERRORS.INVALID_REQUEST, "expected an object");
  }
  if (typeof method !== "string") {
    return errorText(
      typeof id === "string" || typeof id === "number" ? id : null,
      HOST_ERRORS.INVALID_REQUEST,
      "missing method",
    );
  }
  const isNotification = id === undefined;
  try {
    const result = await callHost(method, params);
    return isNotification
      ? null
      : JSON.stringify({ jsonrpc: "2.0", id, result });
  } catch (e) {
    if (isNotification) return null;
    const he =
      e instanceof HostError
        ? e
        : new HostError(HOST_ERRORS.INTERNAL_ERROR, String(e));
    return errorText(id as string | number, he.code, he.message, he.data);
  }
}

function errorText(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): string {
  const error =
    data === undefined ? { code, message } : { code, message, data };
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error });
}
