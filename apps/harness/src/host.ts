import { handleHostFrame } from "@lilos/host";

/* #606 TEMP — per-probe timing for the ac-544 AC-6 flake hunt: START/OK
   lines (method, params.path, wall ms, result sizes) so a CI run can show
   whether the first Workbench round stalls, answers empty, or never runs.
   Set via the spec's bootStack extraEnv; removed before the PR is ready. */
const probeDebug = () => process.env.LILOS_HOST_PROBE_LOG === "1";

const summarize = (frame: string | null): string => {
  if (!frame) return " notification";
  try {
    const r = JSON.parse(frame) as {
      result?: {
        files?: unknown[];
        commits?: unknown[];
        entries?: unknown[];
      };
      error?: { code?: number; message?: string };
    };
    if (r.error) return ` ERR code=${r.error.code} ${r.error.message}`;
    let out = "";
    if (Array.isArray(r.result?.files))
      out += ` files=${r.result.files.length}`;
    if (Array.isArray(r.result?.commits))
      out += ` commits=${r.result.commits.length}`;
    if (Array.isArray(r.result?.entries))
      out += ` entries=${r.result.entries.length}`;
    return out;
  } catch {
    return " unparseable";
  }
};

/**
 * Host API endpoint (issue #113, AC-1): the harness serves `fs.*`/`git.*`/
 * `forge.*` on its feed port (D-#11), mounted next to `/ws` as `POST /host`.
 * One JSON-RPC frame per request, exactly what `handleHostFrame` speaks.
 *
 * Auth: the per-install relay token as `Authorization: Bearer <token>` — the
 * same credential the app already holds for the relay socket and the `/ws`
 * feed authenticates on upgrade (#564); host calls touch the machine.
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
    const body = await req.text();
    let method: string | undefined;
    let path: unknown;
    const debug = probeDebug();
    if (debug) {
      try {
        const m = JSON.parse(body) as {
          method?: unknown;
          params?: { path?: unknown };
        };
        method = typeof m.method === "string" ? m.method : undefined;
        path = m.params?.path;
      } catch {}
      if (method)
        console.log(
          `[host-probe] START ${method} path=${JSON.stringify(path)}`,
        );
    }
    const t0 = Date.now();
    const frame = await handleHostFrame(body);
    if (debug && method)
      console.log(
        `[host-probe] OK ${method} ${Date.now() - t0}ms${summarize(frame)}`,
      );
    return new Response(frame ?? "null\n", {
      status: 200,
      headers: { "content-type": "application/json", ...cors },
    });
  };
}
