import type * as LilosHost from "@lilos/host";
import type { Plugin } from "vite";

/**
 * Dev-only host API endpoint, standing in for the harness: `POST /api/host`
 * carries one JSON-RPC 2.0 frame (`{method, params}` in, `result|error` out).
 * The module is loaded through vite's SSR runner so the workspace's TS sources
 * resolve; the real wiring lands in apps/harness (#26) + app wiring (#27).
 */
export function hostApiPlugin(): Plugin {
  return {
    name: "lilos-host-api",
    configureServer(server) {
      server.middlewares.use("/api/host", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          void server
            .ssrLoadModule("@lilos/host")
            .then((m) => (m as typeof LilosHost).handleHostFrame(body))
            .then((text: string | null) => {
              res.setHeader("content-type", "application/json");
              res.end(text ?? "null");
            })
            .catch((e: unknown) => {
              res.statusCode = 500;
              res.end(String(e));
            });
        });
      });
    },
  };
}
