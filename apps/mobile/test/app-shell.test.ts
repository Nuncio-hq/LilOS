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
    /* #168: the row still reaches the Mac sheet — unless the demo world is
       up, where there is no real Mac and the sheet's Forget would target a
       real Keychain entry. */
    expect(settings).toContain('nav.navigate("Mac")');
    expect(settings).toContain("demo ? undefined");
  });
});

describe("#247 AC-5 — DM rows keep the needs-you badge + trimmed meta", () => {
  /* Landed with the DM screen itself (#235/#292): pinned here so a later
     ui-native refactor can't quietly regress it. */
  it("StateMark draws needs-you and the meta line is branch-or-folder", () => {
    const dm = read("packages/ui-native/src/employees/dm-screen.tsx");
    const mark = dm.slice(dm.indexOf("function StateMark"));
    expect(mark).toContain('state === "needs-you"');
    expect(mark).toContain("bg-primary-foreground"); // the drawn "!" strokes
    expect(dm).toContain("t.branch ?? t.folder");
  });
});

describe("#594 — Activity Open pushes DM then Thread", () => {
  /* #594 AC-1: a request's **Open** landed on the employee's thread list and
     left the asking thread to hunt for by hand. It now resolves the channel
     via `askThreadTarget` and pushes the DM under the asking thread — the
     same landing a plan's Review already used, and Back returns to the DM. */
  const home = read("apps/mobile/src/screens/home.tsx");
  const activity = home.slice(home.indexOf("export function Activity"));

  it("Open resolves the ask via askThreadTarget and pushes Dm before Thread", () => {
    expect(activity).toContain("askThreadTarget(ask, wire)");
    /* onOpen must not navigate("Dm") alone — it goes through the same
       openAskThread helper Review uses (Dm pushed, then Thread on top). */
    expect(activity).toContain("onOpen={openAskThread}");
    const dm = activity.indexOf('navigate("Dm"');
    const thread = activity.indexOf('navigate("Thread"');
    expect(dm).toBeGreaterThan(-1);
    expect(thread).toBeGreaterThan(dm);
  });

  it("Back returns to the DM — Thread is pushed, never reset or replaced", () => {
    expect(activity).not.toContain("nav.reset");
    expect(activity).not.toContain("nav.replace");
  });
});

describe("#373 — the chat nav bar paints a blur backdrop under itself", () => {
  /* The bleed: `headerTransparent` + only a top scroll edge effect left
     scrolled message text crisp behind ThreadHeaderTitle's second row —
     the edge effect only covers the scroll view's own edge zone, not the
     whole bar. `headerBlurEffect` gives the bar a real material, and the
     docs flag stacking it with an explicit top edge effect as overlapping
     effects, so the top edge stays automatic. */
  const header = app.slice(
    app.indexOf("const CHAT_HEADER"),
    app.indexOf("};", app.indexOf("const CHAT_HEADER")),
  );

  it("CHAT_HEADER is transparent + blurred, with no explicit top edge effect", () => {
    expect(header).toContain("headerTransparent: true");
    expect(header).toContain('headerBlurEffect: "systemMaterial"');
    expect(header).not.toContain("top:");
    /* The bottom edge fade over the floating composer stays. */
    expect(header).toContain('bottom: "soft"');
  });

  it("the prototype's chat header carries the same backdrop (UI source of truth)", () => {
    const proto = read("prototype/mobile/src/App.tsx");
    const protoHeader = proto.slice(
      proto.indexOf("const CHAT_HEADER"),
      proto.indexOf("};", proto.indexOf("const CHAT_HEADER")),
    );
    expect(protoHeader).toContain('headerBlurEffect: "systemMaterial"');
  });
});

describe("#596 — push/deep links stack DM under Thread; loading & gone states", () => {
  const push = read("apps/mobile/src/push.ts");
  const thread = read("apps/mobile/src/screens/thread.tsx");

  it("AC-1 the tap path pushes the DM before the Thread (Back → DM)", () => {
    /* The DM can't stack until the wire names its employee — the tap waits
       on deepThreadTarget, never a bare Thread. */
    expect(push).toContain("deepThreadTarget");
    const dmAt = push.indexOf('navigate("Dm"');
    const threadAt = push.indexOf('navigate("Thread"');
    expect(dmAt).toBeGreaterThan(-1);
    expect(threadAt).toBeGreaterThan(dmAt);
    /* Cold-start pending drains through the same stacking path. */
    expect(push).not.toContain("nav.reset");
    expect(push).not.toContain("nav.replace");
  });

  it("AC-1 a not-yet-known id waits for the directory before it opens", () => {
    /* The gate: resolvable now, or the first sync concluded (a miss opens
       too — 'gone' is an answer), or the link already gave up. */
    expect(push).toContain("directoryReady");
    expect(push).toContain('=== "offline"');
  });

  it("AC-2 the blank body splits: spinner while loading, 'gone' after sync", () => {
    expect(thread).toContain("ActivityIndicator");
    expect(thread).toContain("Loading…");
    expect(thread).toContain("This thread is gone");
    expect(thread).toContain("threadBodyState");
    /* The header can no longer claim Working over an empty body. */
    expect(thread).not.toContain('?? "working"');
  });

  it("AC-2b the gone card carries its own way back — 'Back to <employee>'", () => {
    /* A cold-launch push user stares at the centre of the screen: the
       button lives inside the gone StateBlock, lands on the resolved
       employee's DM (popTo — the push stacked that DM under the Thread),
       and falls back to plain Back when no employee was resolved. */
    expect(thread).toContain("thread-gone-back");
    expect(thread).toContain("Back to");
    expect(thread).toContain("goneEmployee.name");
    expect(thread).toContain('popTo("Dm"');
    expect(thread).toContain("navigation.canGoBack()");
    /* The employee can't resolve off a conversation the directory has
       already forgotten — push/ask flows carry it through the route,
       and the push payload itself names the employee as fallback (the
       only id a gone-by-tap-time thread can still offer). */
    const routes = read("apps/mobile/src/routes.ts");
    expect(routes).toContain("Thread: { conversationId: string; employeeId?");
    expect(push).toContain("target?.employeeId ?? payloadEmployeeId");
    expect(push).toContain("data?.employeeId");
  });

  it("AC-2c a gone thread stops fetching: the directory gates the feed", () => {
    /* The HUD's climbing net count was resyncSessionFeeds re-pulling
       session.events for a conversation the synced directory no longer
       lists. The gate lives in client-runtime's syncSessionFeed — the
       gone id settles synced-and-empty without a round trip, and a
       conversation.updated that arrives later still resyncs it. */
    const client = read("packages/client-runtime/src/client.ts");
    expect(client).toContain("directoryReady.get()");
    const gateAt = client.indexOf("directoryReady.get()");
    expect(client.slice(gateAt, gateAt + 400)).toContain("session.events");
    /* Screen-side too: the PR badge doesn't burn a `not_found` call. */
    expect(thread).toContain("if (!client || gone) return");
  });
});
