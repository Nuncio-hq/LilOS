/* Issue #567 — CI & dependency hygiene.
 *
 * AC-1 every workflow declares a top-level permissions: block; ci.yml and
 *     mobile-release.yml grant contents: read and nothing more.
 * AC-2 every `uses:` in a secret-holding workflow is pinned to a full
 *     commit SHA with the resolved version in a trailing comment.
 * AC-3 scripts/ci/audit.sh gates `bun audit --audit-level=high`, is wired
 *     into ci.yml, and documents a reason for every --ignore exception.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../..");
const workflowsDir = join(root, ".github/workflows");
const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml"));
const workflows = Object.fromEntries(
  files.map((f) => [f, readFileSync(join(workflowsDir, f), "utf8")]),
);

/** Entries of a top-level `permissions:` block as {key: level} pairs. */
function permissionsBlock(yml: string): Record<string, string> {
  const match = yml.match(/^permissions:\n((?:[ \t]+.+\n)*)/m);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^\s+([a-z-]+):\s*([a-z-]+)/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

/** Every `uses:` line as {ref, comment}. */
function usesRefs(yml: string): { ref: string; comment: string }[] {
  return [...yml.matchAll(/uses:\s*[^\s@]+@([^\s#]+)\s*(?:#\s*(\S+))?/g)].map(
    (m) => ({ ref: m[1], comment: m[2] ?? "" }),
  );
}

describe("AC-1 least-privilege workflow tokens", () => {
  it.each(files)("AC-1 %s declares top-level permissions:", (file) => {
    expect(permissionsBlock(workflows[file]), file).not.toEqual({});
  });

  it.each(["ci.yml", "mobile-release.yml"])(
    "AC-1 %s grants contents: read and nothing more",
    (file) => {
      expect(permissionsBlock(workflows[file])).toEqual({ contents: "read" });
    },
  );

  it("AC-1 release.yml keeps only the write it needs (contents: write)", () => {
    expect(permissionsBlock(workflows["release.yml"])).toEqual({
      contents: "write",
    });
  });
});

describe("AC-2 pinned actions in secret-holding workflows", () => {
  it.each(["release.yml", "mobile-release.yml"])(
    "AC-2 every uses: in %s is a 40-char SHA with a version comment",
    (file) => {
      const refs = usesRefs(workflows[file]);
      expect(refs.length).toBeGreaterThan(0);
      for (const { ref, comment } of refs) {
        expect(ref, `${file}: ${ref}`).toMatch(/^[0-9a-f]{40}$/);
        expect(comment, `${file}: ${ref} missing version comment`).toMatch(
          /^v\d/,
        );
      }
    },
  );
});

describe("AC-3 bun audit gate", () => {
  const scriptPath = join(root, "scripts/ci/audit.sh");
  let audit = "";
  try {
    audit = readFileSync(scriptPath, "utf8");
  } catch {
    /* red: file missing */
  }

  it("AC-3 audit.sh gates on high+ advisories", () => {
    expect(audit).toContain("bun audit --audit-level=high");
  });

  it("AC-3 every --ignore exception is documented with a reason comment", () => {
    const ignores = [...audit.matchAll(/--ignore\s+(GHSA-[a-z0-9-]+)/g)].map(
      (m) => m[1],
    );
    const comments = audit
      .split("\n")
      .filter((l) => l.trimStart().startsWith("#"));
    for (const id of ignores) {
      expect(
        comments.some((l) => l.includes(id)),
        `${id} is ignored without a documented reason`,
      ).toBe(true);
    }
  });

  it("AC-3 ci.yml runs the audit gate", () => {
    expect(workflows["ci.yml"]).toContain("scripts/ci/audit.sh");
  });
});
