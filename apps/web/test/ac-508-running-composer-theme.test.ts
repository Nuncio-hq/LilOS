/* Issue #508 — the Focus composer's capsule went light-gray in dark shots:
   `transition-colors` fades `background-color` across the theme flip
   (~150ms), so anything captured right after `.dark` lands sees a mid-fade
   light fill (~rgb 197 over the dark field) and the chip label, hint and
   placeholder sit on it at ~1.3:1. The v3 message box has no fill of its own
   (the page shows through it), so there is nothing left to fade; this pins
   that: the box stays fill-less in both themes, and no stylesheet rule dresses
   it as glass again. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const theme = readFileSync(join(ROOT, "packages/ui/src/theme.css"), "utf8");
const composer = readFileSync(
  join(ROOT, "packages/ui/src/chat/composer.tsx"),
  "utf8",
);
const promptInput = readFileSync(
  join(ROOT, "packages/ui/src/components/ai-elements/prompt-input.tsx"),
  "utf8",
);

describe("issue #508", () => {
  test("AC-1 the running composer's box paints no fill in either theme, and the stylesheet never re-dresses it", () => {
    // The running/steer composer is the one Composer (the Focus view renders
    // it too), inside the message box:
    // Composer → PromptInput → InputGroup (data-slot="composer-box").
    expect(composer).toContain("<PromptInput");
    const box = /<InputGroup[\s\S]*?\{children\}/.exec(promptInput)?.[0] ?? "";
    expect(box).toContain('data-slot="composer-box"');

    /* No fill to fade: transparent at rest, when disabled, and under .dark —
       the states that would otherwise pick up the input-group's own
       `dark:bg-input/30` / `has-disabled:bg-input/50`. */
    expect(box).toContain("bg-transparent");
    expect(box).toContain("has-disabled:bg-transparent");
    expect(box).toContain("dark:bg-transparent");
    expect(box).toContain("dark:has-disabled:bg-transparent");

    /* Nothing in theme.css paints a glass fill over the box or repaints it
       per window frame: the old capsule rules keyed off the input-group slot
       and a `.lilos-desktop` override. */
    expect(theme).not.toMatch(/\[data-slot="(input-group|composer-box)"\]/);
    expect(theme).not.toMatch(/\.lilos-desktop/);
  });
});
