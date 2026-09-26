import { describe, expect, it } from "vitest";
import { renderHostDoc } from "../scripts/gen-schemas";
import { FsListResult } from "../src/host/fs";
import { GitDiffResult, GitStatusResult } from "../src/host/git";
import { HOST_METHODS } from "../src/host/methods";
import { HOST_API } from "../src/host/protocol";

describe("host api contract", () => {
  it("AC-4 host protocol identifies itself", () => {
    const r = HOST_METHODS["host.describe"].result.parse({
      api: HOST_API,
      methods: Object.keys(HOST_METHODS),
    });
    expect(r.api).toEqual({ name: "lilos-host", version: 1 });
  });

  it("every declared method has params + result schemas", () => {
    for (const [name, m] of Object.entries(HOST_METHODS)) {
      expect(m.params, `${name}.params`).toBeDefined();
      expect(m.result, `${name}.result`).toBeDefined();
      expect(typeof m.doc, `${name}.doc`).toBe("string");
    }
  });

  it("generated schema carries every method", () => {
    const doc = JSON.parse(renderHostDoc());
    expect(doc.protocol).toEqual({ name: "lilos-host", version: 1 });
    expect(Object.keys(doc.methods).sort()).toEqual(
      Object.keys(HOST_METHODS).sort(),
    );
  });

  it("fs.list result validates", () => {
    const r = FsListResult.parse({
      path: "~/repo",
      entries: [
        { name: "src", kind: "dir", repo: { head: "main", remote: "o/r" } },
        { name: "a.txt", kind: "file" },
      ],
    });
    expect(r.entries[0].repo?.head).toBe("main");
  });

  it("git.diff file patch is hunks-only (headers stripped)", () => {
    const r = GitDiffResult.parse({
      root: "/repo",
      base: "HEAD",
      files: [
        {
          path: "a.txt",
          status: "modified",
          add: 1,
          del: 1,
          patch: "@@ -1 +1 @@\n-old\n+new",
        },
      ],
    });
    expect(r.files[0].patch).not.toContain("diff --git");
    expect(r.files[0].patch).not.toMatch(/^---/m);
    expect(r.files[0].patch).not.toMatch(/^\+\+\+/m);
  });

  it("git.status covers untracked files", () => {
    const r = GitStatusResult.parse({
      root: "/repo",
      branch: "main",
      clean: false,
      files: [{ path: "new.txt", status: "untracked" }],
    });
    expect(r.clean).toBe(false);
  });
});
