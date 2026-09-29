/* Issue #246 — the real app adopts the approved prototype look. The theme
   now lives once in `packages/ui/src/theme.css` and both apps import it, so
   they cannot drift again (the #230 regression class was drift). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { appFrameClass } from "../src/lib/frame";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const theme = readFileSync(join(ROOT, "packages/ui/src/theme.css"), "utf8");
const webCss = readFileSync(join(ROOT, "apps/web/src/index.css"), "utf8");
const protoCss = readFileSync(
  join(ROOT, "prototype/web/src/index.css"),
  "utf8",
);
const dmPage = readFileSync(join(ROOT, "apps/web/src/pages/dm.tsx"), "utf8");
const preload = readFileSync(
  join(ROOT, "apps/desktop/src/preload.cjs"),
  "utf8",
);

describe("issue #246", () => {
  test("AC-1 apps/web and the prototype share one theme stylesheet carrying the prototype tokens", () => {
    for (const css of [webCss, protoCss]) {
      expect(css).toContain("@lilos/ui/theme.css");
      /* The palette moved out: no :root/.dark token blocks left behind, or
         the copies drift again. */
      expect(css).not.toMatch(/:root\s*\{/);
      expect(css).not.toMatch(/\.dark\s*\{/);
    }
    // Apple system palette: teal is the one brand tint, blue stays "working".
    expect(theme).toContain("--primary: #00857f");
    expect(theme).toContain("--primary: #3cc4bc"); // dark
    expect(theme).toContain("--work: #007aff");
    expect(theme).toContain("--work: #0a84ff"); // dark
    expect(theme).toContain("--tint-soft");
    expect(theme).toContain("--tint-text");
    expect(theme).toContain("--glass");
    // SF Pro first (the mobile app's font), Geist fallback.
    expect(theme).toMatch(/--font-sans:\s*-apple-system/);
    expect(theme).toContain(".dark");
  });

  test("AC-2 the primary tint is teal — never the old near-black — and buttons keep their fills", () => {
    expect(theme).not.toMatch(/--primary:\s*oklch\(0\.2/); // old near-black is gone
    // #230 regression class: the borderless-card sweep must exclude buttons.
    expect(theme).toContain(':not([data-slot="button"])');
    // DM-surface primary buttons use the tint, not a black slab.
    expect(dmPage).not.toMatch(/<button[^>]*\bbg-foreground\b/);
  });

  test("AC-3 the colour field + floating window are browser-only; the frame picks by isDesktop", () => {
    // Wallpaper and the drifting orbs exist only under .lilos-float.
    expect(theme).toMatch(/body:has\(\.lilos-float\)\s*\{[^}]*radial-gradient/);
    expect(theme).toMatch(/body:has\(\.lilos-float\)::before/);
    // The inset margin + rounded window is float-only chrome.
    const win = theme.match(/\.lilos-desktop\.lilos-float\s*\{([^}]*)\}/);
    expect(win?.[1]).toContain("margin: 14px");
    expect(win?.[1]).toContain("border-radius");
    // The Electron preload tells the renderer it is the desktop shell.
    expect(preload).toContain("isDesktop: true");
    // The frame: browser floats, desktop fills the OS window.
    expect(appFrameClass({ desktop: false, focus: false })).toContain(
      "lilos-float",
    );
    expect(appFrameClass({ desktop: true, focus: false })).not.toContain(
      "lilos-float",
    );
    // Focus is one column (sidebar hides) either way.
    expect(appFrameClass({ desktop: false, focus: true })).not.toContain(
      "264px",
    );
  });

  test("AC-4 dialogs and floating panels are near-opaque glass", () => {
    const sheet = theme.match(
      /\[data-slot="dialog-content"\],\s*\[role="alertdialog"\]\s*\{([^}]*)\}/s,
    );
    expect(sheet?.[1]).toMatch(/rgb\(255 255 255 \/ 0\.9[0-9]/);
    expect(sheet?.[1]).toContain("backdrop-filter");
    expect(theme).toContain(".lilos-glass.fixed");
  });

  test("AC-5 prefers-reduced-motion kills the drifting background and the rise animations", () => {
    const rm = theme.match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/,
    );
    expect(rm?.[1]).toContain("::before"); // the drifting colour field
    expect(rm?.[1]).toContain("lilos-rise");
    expect(rm?.[1]).toContain("lilos-orb");
    expect(rm?.[1]).toContain("animation: none");
  });
});
