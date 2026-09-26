import type { Plugin } from "vite";

/**
 * Dev-only engine endpoint: `POST /api/engine` carries one JSON-RPC 2.0 frame
 * (`{method, params}` in, `result|error` out) to a real `@lilos/engine-fake`
 * instance — the same engine protocol the harness serves. The module is loaded
 * through vite's SSR runner so workspace TS sources resolve; in the real app
 * these calls ride relay -> harness -> engine instead (issue #26/#27).
 */
export function engineApiPlugin(): Plugin {
  return {
    name: "lilos-engine-api",
    configureServer(server) {
      let dispatch: ((frame: string) => Promise<string | null>) | null = null;
      // Warm the SSR graph once, in order: two plugins' first concurrent
      // ssrLoadModule calls (@lilos/host + @lilos/engine-fake share
      // @lilos/contracts) can leave a request hanging forever.
      server.httpServer?.once("listening", () => {
        void server
          .ssrLoadModule("@lilos/host")
          .then(() => server.ssrLoadModule("@lilos/engine-fake"))
          .catch(() => {});
      });
      server.middlewares.use("/api/engine", (req, res) => {
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
          void (async () => {
            if (!dispatch) {
              const m = (await server.ssrLoadModule("@lilos/engine-fake")) as {
                FakeEngine: new () => { dispatch: never };
                handleJsonRpc: (e: never, f: string) => Promise<string | null>;
              };
              const engine = new m.FakeEngine();
              dispatch = (frame) => m.handleJsonRpc(engine, frame);
            }
            res.setHeader("content-type", "application/json");
            res.end((await dispatch(body)) ?? "null");
          })().catch((e: unknown) => {
            res.statusCode = 500;
            res.end(String(e));
          });
        });
      });
    },
  };
}
