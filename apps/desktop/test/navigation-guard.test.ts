import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appDocumentUrl,
  canOpenExternal,
  guardWindow,
  isAppNavigation,
} from "../src/navigation-guard";

/**
 * Issue #565 — Electron link/navigation lock-down. Each acceptance criterion
 * maps to named tests; AC-3's "the app still runs" leg lives in
 * e2e/ac-565-link-nav.spec.ts.
 */

const APP_FILE =
  "/Applications/LilOS.app/Contents/Resources/app/web/index.html";

describe("AC-1 openExternal is restricted to web-safe schemes", () => {
  it("allows https:, http: and mailto:", () => {
    expect(canOpenExternal("https://example.com/path?q=1")).toBe(true);
    expect(canOpenExternal("http://example.com")).toBe(true);
    expect(canOpenExternal("mailto:user@example.com?subject=hi")).toBe(true);
    // URL parsing normalizes the scheme — case can't sneak past.
    expect(canOpenExternal("HTTPS://EXAMPLE.COM")).toBe(true);
  });

  it("refuses file:, smb:, data:, javascript:, app handlers and junk", () => {
    for (const url of [
      "file:///etc/passwd",
      "file:///Users/oscar/.ssh/id_rsa",
      "smb://server/share",
      "data:text/html,<script>alert(1)</script>",
      "javascript:alert(1)",
      "vscode://file/etc/passwd",
      "lilos://internal",
      "about:blank",
      "not a url",
      "",
      "/relative/path",
      "#fragment",
    ]) {
      expect(canOpenExternal(url), url).toBe(false);
    }
  });
});

describe("AC-2 navigation stays on the app's own origin", () => {
  const httpApp = "http://localhost:5200";
  const fileApp = appDocumentUrl({ file: APP_FILE });

  it("file targets resolve to a file:// document URL", () => {
    expect(fileApp).toBe(`file://${APP_FILE}`);
    expect(appDocumentUrl({ url: httpApp })).toBe(httpApp);
  });

  it("same-origin http(s) navigation is in-app", () => {
    expect(isAppNavigation(httpApp, "http://localhost:5200/")).toBe(true);
    expect(isAppNavigation(httpApp, "http://localhost:5200/dm/abc")).toBe(true);
    // Reloads carry the hash route; still the same document.
    expect(isAppNavigation(httpApp, "http://localhost:5200/?x=1#/dm/abc")).toBe(
      true,
    );
  });

  it("file: navigation is only the loaded document (the app hash-routes)", () => {
    expect(isAppNavigation(fileApp, `file://${APP_FILE}`)).toBe(true);
    expect(isAppNavigation(fileApp, `file://${APP_FILE}#/dm/abc`)).toBe(true);
    expect(isAppNavigation(fileApp, "file:///etc/passwd")).toBe(false);
    expect(
      isAppNavigation(fileApp, "file:///Applications/LilOS.app/Contents/x"),
    ).toBe(false);
  });

  it("foreign origins and scheme switches are not app navigation", () => {
    expect(isAppNavigation(httpApp, "https://localhost:5200")).toBe(false);
    expect(isAppNavigation(httpApp, "http://127.0.0.1:5200")).toBe(false);
    expect(isAppNavigation(httpApp, "https://evil.example")).toBe(false);
    expect(isAppNavigation(httpApp, "file:///etc/hosts")).toBe(false);
    expect(isAppNavigation(fileApp, "https://evil.example")).toBe(false);
    expect(isAppNavigation(httpApp, "data:text/html,x")).toBe(false);
    expect(isAppNavigation(httpApp, "not a url")).toBe(false);
  });
});

describe("AC-2 the wired window guard", () => {
  /** A webContents-shaped fake: records handlers, replays events. */
  function fakeContents() {
    let openHandler: ((d: { url: string }) => { action: "deny" }) | undefined;
    const navHandlers = new Map<
      string,
      (e: { preventDefault(): void }, url: string) => void
    >();
    return {
      setWindowOpenHandler(h: typeof openHandler) {
        openHandler = h;
      },
      on(
        event: string,
        cb: (e: { preventDefault(): void }, url: string) => void,
      ) {
        navHandlers.set(event, cb);
      },
      windowOpen(url: string) {
        return openHandler?.({ url });
      },
      navigate(event: "will-navigate" | "will-redirect", url: string) {
        const e = {
          prevented: false,
          preventDefault() {
            this.prevented = true;
          },
        };
        navHandlers.get(event)?.(e, url);
        return e.prevented;
      },
    };
  }

  it("denies every new window; web-safe links open in the browser", () => {
    const contents = fakeContents();
    const opened: string[] = [];
    guardWindow(contents, "http://localhost:5200", (u) => opened.push(u));
    expect(contents.windowOpen("https://example.com")?.action).toBe("deny");
    expect(opened).toEqual(["https://example.com"]);
    expect(contents.windowOpen("mailto:a@b.c")?.action).toBe("deny");
    expect(opened).toEqual(["https://example.com", "mailto:a@b.c"]);
    // Unsafe schemes never reach the browser.
    expect(contents.windowOpen("file:///etc/passwd")?.action).toBe("deny");
    expect(contents.windowOpen("smb://x")?.action).toBe("deny");
    expect(opened).toHaveLength(2);
  });

  it("will-navigate denies foreign URLs and sends web links to the browser", () => {
    const contents = fakeContents();
    const opened: string[] = [];
    guardWindow(contents, "http://localhost:5200", (u) => opened.push(u));
    expect(contents.navigate("will-navigate", "https://evil.example")).toBe(
      true,
    );
    expect(opened).toEqual(["https://evil.example"]);
    // Denied but never opened: schemes the browser shouldn't see either.
    expect(contents.navigate("will-navigate", "file:///etc/passwd")).toBe(true);
    expect(opened).toHaveLength(1);
  });

  it("will-navigate lets same-origin navigations through untouched", () => {
    const contents = fakeContents();
    const opened: string[] = [];
    guardWindow(contents, "http://localhost:5200", (u) => opened.push(u));
    expect(
      contents.navigate("will-navigate", "http://localhost:5200/dm/x"),
    ).toBe(false);
    expect(opened).toHaveLength(0);
  });

  it("will-redirect is guarded by the same rule", () => {
    const contents = fakeContents();
    const opened: string[] = [];
    guardWindow(contents, "http://localhost:5200", (u) => opened.push(u));
    expect(contents.navigate("will-redirect", "https://evil.example")).toBe(
      true,
    );
    expect(opened).toEqual(["https://evil.example"]);
    expect(
      contents.navigate("will-redirect", "http://localhost:5200/login"),
    ).toBe(false);
  });
});

describe("AC-3 the app pages carry a CSP", () => {
  const cspOf = (path: string): string => {
    const html = readFileSync(path, "utf8");
    const meta = html.match(
      /<meta[^>]+http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/i,
    );
    expect(meta, `${path} has no CSP meta`).not.toBeNull();
    return meta?.[1] ?? "";
  };
  const directive = (csp: string, name: string): string =>
    csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `) || d === name) ?? "";

  it("apps/web: self + loopback relay/harness endpoints, no remote scripts", () => {
    const csp = cspOf(join(__dirname, "../../web/index.html"));
    // No remote script hosts: 'self' plus dev/wasm carve-outs only.
    expect(directive(csp, "script-src")).toBe(
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    );
    const connect = directive(csp, "connect-src");
    for (const src of [
      "'self'",
      "ws://127.0.0.1:*",
      "ws://localhost:*",
      "http://127.0.0.1:*",
      "http://localhost:*",
    ]) {
      expect(connect, `connect-src missing ${src}`).toContain(src);
    }
    // Attachments are data: URLs; remote images are click-to-load (#566).
    expect(directive(csp, "img-src")).toContain("data:");
    expect(directive(csp, "img-src")).toContain("https:");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
  });

  it("the desktop status page does no network at all", () => {
    const csp = cspOf(join(__dirname, "../src/index.html"));
    expect(directive(csp, "default-src")).toBe("default-src 'none'");
    expect(directive(csp, "script-src")).toContain("script-src");
  });
});
