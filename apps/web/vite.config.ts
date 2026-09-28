import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * `@lilos/ui` is linked workspace source excluded from dep-optimization (its
 * own edits should hot-reload), but excluding it also keeps the dep scanner
 * from crawling it — so the bare packages UI imports got discovered lazily
 * on the first navigation, producing an "optimized dependencies changed"
 * full-page reload that aborts an in-flight page.goto (#84). Crawl the UI
 * sources here and include their bare specifiers so the first optimize pass
 * covers everything; the list stays in sync with the imports automatically.
 * The `dep > dep` form resolves them from @lilos/ui's own node_modules —
 * bun doesn't hoist workspace deps, so bare names fail include resolution.
 */
const bareDepsOf = (srcDir: string): string[] => {
  const specRe =
    /(?:import|export)\s+(?!type\b)[^'"]*?\bfrom\s+["']([^"']+)["']|import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  const deps = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.[jt]sx?$/.test(entry.name)) {
        const text = fs.readFileSync(p, "utf8");
        for (const m of text.matchAll(specRe)) {
          const spec = m[1] ?? m[2] ?? m[3];
          if (
            spec &&
            !spec.startsWith(".") &&
            !spec.startsWith("/") &&
            !spec.startsWith("@lilos/")
          )
            deps.add(spec);
        }
      }
    }
  };
  walk(srcDir);
  return [...deps].sort();
};

const uiDeps = bareDepsOf(path.resolve(here, "../../packages/ui/src")).map(
  (d) => `@lilos/ui > ${d}`,
);

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
  // Packaged builds are loaded over file:// — absolute /assets paths would
  // resolve to the filesystem root. LILOS_WEB_BASE=./ keeps them relative.
  base: process.env.LILOS_WEB_BASE ?? "/",
  plugins: [react(), tailwindcss(), lilosConfig()],
  resolve: {
    alias: { "@": path.resolve(here, "src") },
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    include: uiDeps,
    exclude: ["@lilos/ui"],
  },
  server: {
    port: Number(process.env.LILOS_WEB_PORT ?? 5200),
    strictPort: true,
  },
});
