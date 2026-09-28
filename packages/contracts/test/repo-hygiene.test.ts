import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #172 repo-hygiene ACs: the license, notices, contributor docs, the
 * moved-in site, its Pages workflow, and the pre-publication scrub are all
 * repo state — so they get repo tests, run by `bun run verify` like any other.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const has = (p: string) => existsSync(join(ROOT, p));

const trackedFiles = () =>
  execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

const workspacePackageJsons = () =>
  trackedFiles().filter(
    (f) =>
      f.endsWith("package.json") &&
      !f.includes("node_modules") &&
      !f.startsWith("e2e/"),
  );

describe("AC-1 Elastic License 2.0", () => {
  it("LICENSE.md holds the ELv2 text with Nuncio as licensor", () => {
    expect(has("LICENSE.md")).toBe(true);
    const text = read("LICENSE.md");
    expect(text).toContain("Elastic License 2.0");
    // Canonical ELv2 limitation clauses (verbatim terms; unwrap line breaks
    // before matching since the canonical text wraps at ~80 chars).
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain("hosted or managed service");
    expect(flat).toContain("license key");
    expect(text).toContain("## Patents");
    expect(text).toContain("## No Liability");
    expect(/nuncio/i.test(text)).toBe(true);
  });

  it('every workspace package.json declares "license": "Elastic-2.0"', () => {
    for (const file of workspacePackageJsons()) {
      const pkg = JSON.parse(read(file));
      expect(pkg.license, `${file} is missing the SPDX license id`).toBe(
        "Elastic-2.0",
      );
    }
    expect(workspacePackageJsons().length).toBeGreaterThan(5);
  });

  it("docs/DECISIONS.md records D-#172", () => {
    expect(read("docs/DECISIONS.md")).toContain("D-#172");
  });
});

describe("AC-2 third-party notices", () => {
  it("THIRD_PARTY_NOTICES.md lists ports, vendored UI, assets and logo terms", () => {
    expect(has("THIRD_PARTY_NOTICES.md")).toBe(true);
    const text = read("THIRD_PARTY_NOTICES.md");
    for (const needle of [
      "T3",
      "Synara",
      "Hermes",
      "shadcn",
      "AI Elements",
      "Geist",
      "lucide",
      "models.dev",
      "trademark",
    ]) {
      expect(text, `missing ${needle}`).toContain(needle);
    }
  });
});

describe("AC-3 README", () => {
  it("README.md says source-available ELv2, how to run, trademark note", () => {
    expect(has("README.md")).toBe(true);
    const text = read("README.md");
    expect(text).toContain("Elastic License 2.0");
    expect(/source-available/i.test(text)).toBe(true);
    expect(text).toContain("bun install");
    expect(/trademark/i.test(text)).toBe(true);
  });
});

describe("AC-4 contribution terms and security", () => {
  it("CONTRIBUTING.md documents DCO sign-off and the inbound grant", () => {
    expect(has("CONTRIBUTING.md")).toBe(true);
    const text = read("CONTRIBUTING.md");
    expect(text).toContain("Signed-off-by");
    expect(/commit -s|signoff|sign-off/i.test(text)).toBe(true);
    expect(/relicense/i.test(text)).toBe(true);
  });

  it("a DCO workflow enforces sign-off on PRs", () => {
    expect(has(".github/workflows/dco.yml")).toBe(true);
    const text = read(".github/workflows/dco.yml");
    expect(text).toContain("pull_request");
    expect(text).toContain("actions-dco");
  });

  it("SECURITY.md points at private reporting; issue templates exist", () => {
    expect(has("SECURITY.md")).toBe(true);
    expect(/security\/advisories/i.test(read("SECURITY.md"))).toBe(true);
    expect(has(".github/ISSUE_TEMPLATE/bug_report.md")).toBe(true);
    expect(has(".github/ISSUE_TEMPLATE/feature_request.md")).toBe(true);
  });
});

describe("AC-5 site moves in", () => {
  it("site/ holds the landing page, privacy page and .nojekyll", () => {
    for (const p of [
      "site/index.html",
      "site/privacy/index.html",
      "site/.nojekyll",
    ]) {
      expect(has(p), `${p} missing`).toBe(true);
    }
  });

  it("privacy page contact links to the LilOS issue tracker", () => {
    const privacy = read("site/privacy/index.html");
    expect(privacy).toContain("github.com/Nuncio-hq/LilOS/issues");
  });

  it("pages.yml publishes site/ and skips while the repo is private", () => {
    expect(has(".github/workflows/pages.yml")).toBe(true);
    const text = read(".github/workflows/pages.yml");
    expect(text).toContain("site/**");
    expect(text).toContain("actions/deploy-pages");
    expect(text).toContain("github.event.repository.private == false");
    expect(text).toContain("workflow_dispatch");
  });
});

describe("AC-6 pre-publication scrub", () => {
  it("no private hostnames, tailnet ids or local usernames in tracked files", () => {
    const banned = ["oscars" + "-macbook-pro", "tail" + "1a2b", "a1241" + "968"];
    const self = "packages/contracts/test/repo-hygiene.test.ts";
    for (const file of trackedFiles()) {
      if (file === self || file === "bun.lock") continue;
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const needle of banned) {
        expect(text, `${file} still contains ${needle}`).not.toContain(needle);
      }
    }
  });

  it("no workflow runs on pull_request_target", () => {
    for (const file of trackedFiles()) {
      if (!file.startsWith(".github/workflows/")) continue;
      expect(read(file), `${file} uses pull_request_target`).not.toContain(
        "pull_request_target",
      );
    }
  });
});
