import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { warmDevClient } from "../../../e2e/helpers/stack";

/** A tiny dev server with a static import graph and one 504 that
    recovers — the crawl must follow modules, CSS, and font urls, and
    must wait out Vite's "outdated dep" 504. */
function graphServer(): Promise<{
  server: Server;
  origin: string;
  hits: Map<string, number>;
}> {
  const hits = new Map<string, number>();
  const bump = (url: string) => hits.set(url, (hits.get(url) ?? 0) + 1);
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    bump(url);
    if (url === "/src/b.js" && (hits.get(url) ?? 0) === 1) {
      res.writeHead(504);
      res.end("outdated");
      return;
    }
    const send = (type: string, body: string) => {
      res.writeHead(200, { "content-type": type });
      res.end(body);
    };
    if (url === "/") {
      send(
        "text/html",
        `<!doctype html><script type="module" src="/src/main.tsx"></script>`,
      );
      return;
    }
    if (url === "/src/main.tsx") {
      send(
        "text/javascript",
        'import "/src/a.css";\nimport "./b.js";\nconst sample = "import \\"react\\"";\n',
      );
      return;
    }
    if (url === "/src/a.css") {
      send("text/css", `@import "./c.css";\n.x{background:url(/font.woff2)}\n`);
      return;
    }
    if (url === "/src/c.css") {
      send("text/css", "");
      return;
    }
    if (url === "/src/b.js") {
      send("text/javascript", "export const x = 1;\n");
      return;
    }
    if (url === "/font.woff2") {
      send("font/woff2", "");
      return;
    }
    res.writeHead(404);
    res.end("missing");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, origin: `http://127.0.0.1:${port}`, hits });
    });
  });
}

describe("warmDevClient (#827)", () => {
  it("fetches the static graph, including a dep that 504s once", async () => {
    const { server, origin, hits } = await graphServer();
    try {
      await warmDevClient(origin, 5_000);
      for (const path of [
        "/",
        "/src/main.tsx",
        "/src/a.css",
        "/src/c.css",
        "/src/b.js",
        "/font.woff2",
      ]) {
        expect(hits.get(path) ?? 0, path).toBeGreaterThan(0);
      }
      expect(hits.get("/src/b.js")).toBe(2);
      expect(hits.has("/react")).toBe(false);
      expect(hits.has("/src/react")).toBe(false);
    } finally {
      server.close();
    }
  });
});
