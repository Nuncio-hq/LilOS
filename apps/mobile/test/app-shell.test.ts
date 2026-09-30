import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/* #247: the real app adopts the prototype's chrome — Home starts under the
   status bar (no nav header, the Mac moved to Settings), the Settings Mac
   row carries the live link and opens the Mac sheet, and DM rows keep the
   "!" needs-you badge + trimmed meta. These are navigator-prop wirings in
   repo files — the same kind of repo-state assertion release.test.ts makes
   for the release path. */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const app = read("apps/mobile/src/App.tsx");
/* The block of one Tab.Screen, from `name="X"` to the next screen. */
const screen = (name: string, next: string) =>
  app.slice(app.indexOf(`name="${name}"`), app.indexOf(`name="${next}"`));

describe("#247 AC-1 — Home has no nav header; the banner opens the Mac sheet", () => {
  it("the Home tab opts out of the header and mounts no header items", () => {
    const home = screen("Home", "Activity");
    expect(home).toContain("headerShown: false");
    expect(home).not.toContain("unstable_headerRightItems");
    /* The Mac laptop button the header used to hold is gone app-wide. */
    expect(app).not.toContain("laptopcomputer");
  });

  it("the offline banner stays Home-only and taps through to the Mac sheet", () => {
    const home = read("apps/mobile/src/screens/home.tsx");
    /* EmployeesHomeScreen renders the banner itself (ui-native, shared with
       the prototype) — the app passes link + where its tap goes. Other tabs
       never mount that component, so the banner can't leak off Home. */
    expect(home).toContain("link={link}");
    expect(home).toContain('onOpenMac={() => nav.navigate("Mac")}');
    expect(home).toContain("<EmployeesHomeScreen");
  });
});

describe("#247 AC-2 — Settings Mac row carries the live link", () => {
  it("mac gets link and a tap handler that opens the Mac sheet", () => {
    const settings = app.slice(
      app.indexOf("function Settings"),
      app.indexOf("function Tabs"),
    );
    /* The row's status dot reads the real $link atom; a tap must reach the
       Mac sheet instead of the old inline Forget row. */
    const macProp = settings.slice(
      settings.indexOf("mac={"),
      settings.indexOf("mac={") + 300,
    );
    expect(macProp).toContain("link,");
    expect(settings).toContain('onOpenMac={() => nav.navigate("Mac")}');
  });
});

describe("#247 AC-5 — DM rows keep the needs-you badge + trimmed meta", () => {
  /* Landed with the DM screen itself (#235/#292): pinned here so a later
     ui-native refactor can't quietly regress it. */
  it("StateMark draws needs-you and the meta line is branch-or-folder", () => {
    const dm = read("packages/ui-native/src/employees/dm-screen.tsx");
    expect(dm).toContain('state === "needs-you"');
    expect(dm).toContain("t.branch ?? t.folder");
  });
});
