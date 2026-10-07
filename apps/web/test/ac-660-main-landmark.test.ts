import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/* Issue #660: pins the DmPage composition the invariant depends on — the
   page mounts <MainPane> itself and renders the feed (EmployeeHome) and
   Focus (FocusView) `bare` into it, so the <main> element reconciles
   across the swap instead of unmounting under a measured handle. A
   refactor that drops the wrapper or a `bare` prop silently restores the
   detached-node flake; e2e/dm-layout.spec.ts AC-660 only samples the real
   page on CI. */

const DM = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "pages",
  "dm.tsx",
);

describe("issue #660 — DmPage owns the <main> landmark", () => {
  const src = readFileSync(DM, "utf8");

  test("both views render bare inside a page-mounted <MainPane>", () => {
    /* <FocusView/EmployeeHome with `bare` inside a <MainPane> block — the
       prop sits on its own line under Biome formatting. */
    expect(src).toMatch(/<MainPane>[\s\S]*?<FocusView\s+bare[\s\S]*?<\/MainPane>/);
    expect(src).toMatch(/<MainPane>[\s\S]*?<EmployeeHome\s+bare/);
  });

  test("dm.tsx never renders a raw <main> — the landmark comes only from MainPane", () => {
    /* Strip comments first — the fix's own notes name the element. */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code.match(/<main[\s>]/g)).toBeNull();
  });
});
