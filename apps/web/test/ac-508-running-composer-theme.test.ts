/* Issue #508 — the Focus composer's capsule went light-gray in dark shots:
   `transition-colors` fades `background-color` across the theme flip
   (~150ms), so anything captured right after `.dark` lands sees a mid-fade
   light fill (~rgb 197 over the dark field) and the chip label, hint and
   placeholder sit on it at ~1.3:1. The dark token existed all along — the
   fix is the fill snapping to it instead of fading there. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const theme = readFileSync(join(ROOT, "packages/ui/src/theme.css"), "utf8");
const focusComposer = readFileSync(
  join(ROOT, "packages/ui/src/chat/focus-composer.tsx"),
  "utf8",
);
const promptInput = readFileSync(
  join(ROOT, "packages/ui/src/components/ai-elements/prompt-input.tsx"),
  "utf8",
);
const inputGroup = readFileSync(
  join(ROOT, "packages/ui/src/components/ui/input-group.tsx"),
  "utf8",
);

/* The body of a `selector { … }` rule in theme.css. */
const rule = (sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = theme.match(new RegExp(`${esc}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`no rule for ${sel} in theme.css`);
  return m[1];
};

const CAPSULE = '[data-slot="input-group"]:has(textarea)';

describe("issue #508", () => {
  test("AC-1 the running composer's capsule is the input-group and its fill snaps to the dark token", () => {
    // The Focus running/steer composer renders inside the themed capsule:
    // FocusComposer → PromptInput → InputGroup (data-slot="input-group").
    expect(focusComposer).toContain("<PromptInput");
    expect(promptInput).toContain("<InputGroup");
    expect(inputGroup).toContain('data-slot="input-group"');

    // The capsule's fills are the theme tokens, dark pinned under .dark.
    expect(rule(`.lilos-desktop ${CAPSULE}`)).toContain(
      "rgb(255 255 255 / 0.75)",
    );
    expect(rule(`.dark .lilos-desktop ${CAPSULE}`)).toContain(
      "rgb(255 255 255 / 0.06)",
    );

    /* The fill must reach the token instantly, not fade to it: a
       background-color transition paints the near-opaque light glass for
       ~150ms after every flip to dark — the light capsule in the issue's
       screenshots. transition-colors stays for the rest; the fill snaps. */
    const body = rule(CAPSULE);
    const props = /transition-property\s*:\s*([^;]+)/.exec(body)?.[1];
    const shorthand = /(?<!-)transition\s*:\s*([^;]+)/.exec(body)?.[1];
    const snaps =
      (props !== undefined &&
        !/\b(background|background-color|all)\b/.test(props)) ||
      (shorthand !== undefined && /\bnone\b/.test(shorthand));
    expect(
      snaps,
      "the composer capsule must not transition its background — " +
        "the fade paints the light glass mid-flip (#508)",
    ).toBe(true);
  });
});
