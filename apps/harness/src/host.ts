import { handleHostFrame } from "@lilos/host";

/**
 * Host API endpoint (issue #113, AC-1): the harness serves `fs.*`/`git.*`/
 * `forge.*` on its feed port (D-#11), mounted next to `/ws` as `POST /host`.
 * One JSON-RPC frame per request, exactly what `handleHostFrame` speaks.
 *
 * Auth: the per-install relay token as `Authorization: Bearer <token>` — the
 * same credential the app already holds for the relay socket (the read-only
 * `/ws` feed stays unauthenticated by design; host calls touch the machine).
 */
export function createHostHandler(opts: { token: string }) {
  // The app origin (localhost dev / Electron window) differs from the
  // loopback feed port, so answer CORS preflight too. Loopback + Bearer.
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-allow-methods": "POST,OPTIONS",
  };
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed\n", { status: 405 });
    }
    if (req.headers.get("authorization") !== `Bearer ${opts.token}`) {
      return new Response("unauthorized\n", { status: 401 });
    }
    const frame = await handleHostFrame(await req.text());
    return new Response(frame ?? "null\n", {
      status: 200,
      headers: { "content-type": "application/json", ...cors },
    });
  };
}
