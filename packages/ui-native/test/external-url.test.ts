/* #598 (review): the phone's Linking.openURL policy — https anywhere,
   http only for loopback; every other scheme is refused so an
   engine-supplied URL can't open local files or app handlers. */
import { describe, expect, test } from "vitest";
import { safeExternalUrl } from "../src/lib/external-url";

describe("safeExternalUrl", () => {
  test("allows https URLs", () => {
    expect(safeExternalUrl("https://github.com/o/r/pull/1")).toBe(
      "https://github.com/o/r/pull/1",
    );
    expect(safeExternalUrl("https://example.com")).toBe("https://example.com");
  });

  test("allows http only for loopback hosts", () => {
    expect(safeExternalUrl("http://localhost:3000/preview")).toBe(
      "http://localhost:3000/preview",
    );
    expect(safeExternalUrl("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080",
    );
    expect(safeExternalUrl("http://[::1]:4577")).toBe("http://[::1]:4577");
    expect(safeExternalUrl("http://x.localhost:3000")).toBe(
      "http://x.localhost:3000",
    );
  });

  test("refuses http to a remote host", () => {
    expect(safeExternalUrl("http://github.com/o/r/pull/1")).toBeUndefined();
    expect(safeExternalUrl("http://169.254.169.254/")).toBeUndefined();
  });

  test("refuses file:, javascript:, tel: and custom app schemes", () => {
    expect(safeExternalUrl("file:///etc/passwd")).toBeUndefined();
    expect(safeExternalUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeExternalUrl("tel:+15551234567")).toBeUndefined();
    expect(safeExternalUrl("lilos://internal/path")).toBeUndefined();
    expect(safeExternalUrl("data:text/html,<h1>x</h1>")).toBeUndefined();
  });

  test("refuses unparseable and empty input", () => {
    expect(safeExternalUrl("not a url")).toBeUndefined();
    expect(safeExternalUrl("")).toBeUndefined();
    expect(safeExternalUrl(undefined)).toBeUndefined();
  });
});
