import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #201: the Actions-minutes budget is repo state a later change could
 * undo by accident (full E2E on every push, whole-job reruns for flakes, a
 * macOS build per PR), so it gets repo tests like the rest of the hygiene.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const docsOnly = (paths: string) =>
  spawnSync("sh", [join(ROOT, "scripts/ci/docs-only.sh")], {
    input: paths,
    encoding: "utf8",
  }).status === 0;

describe("AC-1 a newer push cancels the PR's older run; main never cancels", () => {
  const ci = read(".github/workflows/ci.yml");

  it("groups runs by PR number, or by commit on main", () => {
    expect(ci).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: an Actions expression
      "group: ci-${{ github.event.pull_request.number || github.sha }}",
    );
  });

  it("cancels in progress only for pull_request", () => {
    expect(ci).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: an Actions expression
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
  });
});

describe("AC-2/AC-3 drafts skip E2E; ready for review runs it", () => {
  const ci = read(".github/workflows/ci.yml");

  it("re-runs when a draft is marked ready", () => {
    expect(ci).toMatch(/types:\s*\[[^\]]*ready_for_review[^\]]*\]/);
  });

  it("gates only the E2E steps on the scope, never the fast checks", () => {
    expect(ci).toContain("run: bun run verify:fast");
    expect(ci).toContain("if: steps.scope.outputs.e2e == 'true'");
    const fast = ci.slice(ci.indexOf("name: Fast checks"));
    expect(fast.slice(0, fast.indexOf("\n      - "))).not.toContain("if:");
  });
});

describe("AC-4 docs-only diffs skip E2E, anything else runs it", () => {
  it.each([
    "AGENTS.md\n",
    "README.md\n.agents/skills/x/SKILL.md\n",
    "site/index.html\ndocs/DECISIONS.md\n",
    ".github/ISSUE_TEMPLATE/bug.yml\n",
  ])("docs-only: %j", (paths) => {
    expect(docsOnly(paths)).toBe(true);
  });

  it.each([
    "README.md\napps/web/src/a.ts\n",
    ".github/workflows/ci.yml\n",
    "e2e/foo.spec.ts\n",
    "packages/ui/readme.mdx\n",
    "\n", // empty diff or git output lost: when in doubt, E2E runs
  ])("runs E2E: %j", (paths) => {
    expect(docsOnly(paths)).toBe(false);
  });
});

describe("AC-5 the check is always `verify` and always reports", () => {
  it("has no workflow-level path filters", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/^ {2}verify:$/m);
    expect(ci).not.toMatch(/paths(-ignore)?:/);
  });
});

describe("AC-6 a failed E2E test retries once on CI and is flagged flaky", () => {
  it("sets CI-only retries and the github reporter", () => {
    const config = read("playwright.config.ts");
    expect(config).toContain("retries: process.env.CI ? 1 : 0");
    expect(config).toContain(
      'reporter: process.env.CI ? [["list"], ["github"]] : [["list"]]',
    );
  });
});

describe("AC-7 the macOS release build never runs per PR", () => {
  it("release.yml has no pull_request trigger", () => {
    expect(read(".github/workflows/release.yml")).not.toMatch(
      /^\s*pull_request:/m,
    );
  });
});

/**
 * Issue #433: the E2E step ran ~23 min on the 2-worker default (half of the
 * runner's 4 vCPUs). Plan A is `workers: 4` on CI — per-worker port blocks
 * (e2e/ports.ts) keep the extra stacks apart. Plan B, if CI flakes: shard the
 * E2E step across matrix jobs behind an aggregating `verify` job; these tests
 * then pin the shard setup instead.
 */
describe("#433 AC-1 the E2E step's parallelism comes from 4 CI workers", () => {
  it("playwright.config.ts overrides workers to 4 under CI only", () => {
    const config = read("playwright.config.ts");
    expect(config).toContain("workers: process.env.CI ? 4 : undefined");
  });

  it("the single verify job still runs the suite in one E2E step", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/^ {2}verify:$/m);
    expect(ci).toContain("run: xvfb-run -a bun run test:e2e");
    expect(ci).not.toContain("--shard");
  });
});

describe("#433 AC-2 flakes stay visible under the extra parallelism", () => {
  it("keeps CI retries and the github reporter so a pass-on-retry is flagged", () => {
    const config = read("playwright.config.ts");
    expect(config).toContain("retries: process.env.CI ? 1 : 0");
    expect(config).toContain('[["list"], ["github"]]');
  });
});
