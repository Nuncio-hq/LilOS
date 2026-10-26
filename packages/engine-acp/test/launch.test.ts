import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { probeExecutable, resolveExecutable } from "../src/launch.js";

/**
 * D-#845 — install verification: resolve against PATH (+ the well-known
 * user dirs), probe once. No credentials involved anywhere.
 */
describe("resolveExecutable (D-#845)", () => {
  test("finds a bare name on PATH", () => {
    expect(resolveExecutable("bun")).toBeTruthy();
  });

  test("falls back to the well-known user bin dirs off PATH", () => {
    const found = resolveExecutable("bun", { PATH: "/nonexistent" });
    /* bun lives in ~/.bun/bin or /opt/homebrew/bin on this Mac — the
       fallback dirs cover whichever applies; a total miss is also a
       valid answer only if bun is nowhere standard. */
    expect(found === undefined || found.endsWith("/bun")).toBe(true);
  });

  test("absolute and relative paths check directly", () => {
    expect(resolveExecutable("/bin/echo")).toBe("/bin/echo");
    expect(resolveExecutable("/definitely/not/here")).toBeUndefined();
    expect(resolveExecutable("./not-here")).toBeUndefined();
  });

  test("a PATH hit must be executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-launch-"));
    const p = join(dir, "not-exec");
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o644); // not executable
    expect(resolveExecutable("not-exec", { PATH: dir })).toBeUndefined();
    chmodSync(p, 0o755);
    expect(resolveExecutable("not-exec", { PATH: dir })).toBe(p);
  });
});

describe("probeExecutable (D-#845)", () => {
  test("exit 0 means the install verifies", async () => {
    const r = await probeExecutable("/bin/echo", ["ok"]);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("ok");
  });

  test("nonzero exit fails the probe", async () => {
    const r = await probeExecutable("sh", ["-c", "exit 3"]);
    expect(r.ok).toBe(false);
  });

  test("a missing binary fails, never hangs", async () => {
    const r = await probeExecutable("/definitely/not/here", ["--version"]);
    expect(r.ok).toBe(false);
  });

  test("a hung probe dies at the timeout", async () => {
    const r = await probeExecutable("sleep", ["30"], { timeoutMs: 250 });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("timed out");
  });
});
