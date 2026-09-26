import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Serves the runtime config the renderer needs — relay URL/token and the
 * engine-protocol endpoint — at GET /lilos-config.json. Dev and preview both
 * get it from env (set by dev/stack.ts); the Electron shell injects the same
 * object via its preload, so this file only exists for the plain-web path.
 */
function lilosConfig() {
  const body = JSON.stringify({
    relayWs: process.env.LILOS_RELAY_WS ?? "ws://127.0.0.1:4577/ws",
    relayToken: process.env.LILOS_RELAY_TOKEN ?? "",
    engineWs: process.env.LILOS_ENGINE_WS ?? "ws://127.0.0.1:4581/ws",
  });
  const handler = (
    _req: unknown,
    res: { setHeader(h: string, v: string): void; end(b: string): void },
  ) => {
    res.setHeader("content-type", "application/json");
    res.end(body);
  };
  return {
    name: "lilos-config",
    configureServer(server: {
      middlewares: { use(p: string, h: typeof handler): void };
    }) {
      server.middlewares.use("/lilos-config.json", handler);
    },
    configurePreviewServer(server: {
      middlewares: { use(p: string, h: typeof handler): void };
    }) {
      server.middlewares.use("/lilos-config.json", handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), lilosConfig()],
  resolve: {
    alias: { "@": path.resolve(here, "src") },
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    exclude: ["@lilos/ui"],
  },
  server: {
    port: Number(process.env.LILOS_WEB_PORT ?? 5200),
    strictPort: true,
  },
});
