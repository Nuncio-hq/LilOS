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

  it("gates only the E2E job on the scope, never the fast checks", () => {
    expect(ci).toContain("run: bun run verify:fast");
    expect(ci).toContain("if: needs.scope.outputs.e2e == 'true'");
    const checks = ci.slice(ci.indexOf("  checks:\n"));
    // the checks job block ends at the next 2-space-indent job key
    const job = checks.slice(0, checks.search(/\n {2}\S/));
    expect(job).not.toContain("if:");
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
 * Issue #433: plan A (`workers: 4` on one runner) starved 4 stacks + 4
 * Chromiums of CPU — 11 fails, 27.5 min, worse than the ~23 min baseline
 * (PR #444 run 37138365037). Plan B: the E2E suite shards across 3 matrix
 * legs on separate runners at the default 2 workers each; `verify` stays
 * the required check as an always() aggregate. A skipped e2e job (draft,
 * docs-only) still reports green, a failed scope job never does.
 */
describe("#433 AC-1 E2E shards across 3 matrix legs behind one verify check", () => {
  const ci = read(".github/workflows/ci.yml");

  it("runs the suite as --shard i/3 on separate runners", () => {
    expect(ci).toContain("shard: [1, 2, 3]");
    expect(ci).toContain("fail-fast: false");
    expect(ci).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: an Actions expression
      "run: xvfb-run -a bun run test:e2e --shard ${{ matrix.shard }}/3",
    );
  });

  it("verify needs scope + checks + the shards and reports on every path", () => {
    expect(ci).toMatch(/^ {2}verify:\n {4}needs: \[scope, checks, e2e\]/m);
    expect(ci).toContain("if: always()");
  });

  it("never raises Playwright workers on CI again (the plan-A failure)", () => {
    expect(read("playwright.config.ts")).not.toContain("workers:");
  });
});

describe("#433 AC-2 flakes stay visible under sharding", () => {
  it("keeps CI retries and the github reporter so a pass-on-retry is flagged", () => {
    const config = read("playwright.config.ts");
    expect(config).toContain("retries: process.env.CI ? 1 : 0");
    expect(config).toContain('[["list"], ["github"]]');
  });

  it("keeps the per-worker port blocks shards still rely on", () => {
    expect(read("e2e/ports.ts")).toContain("TEST_WORKER_INDEX");
  });
});
