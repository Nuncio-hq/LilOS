// @vitest-environment happy-dom
/* Issue #421: the DM header's profile card is the prototype's shared
   EmployeeCard — the app-local EmployeeProfileCard modal is deleted. The
   component legs pin the card rows + the close paths (Esc, backdrop,
   Message); the source legs pin the wiring in dm.tsx (shared card mounted,
   local modal gone). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Employee, EngineProfile } from "@lilos/ui/types";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { DmProfileCard } from "../src/pages/dm-profile-card";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(cleanup);

const DM = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "pages",
  "dm.tsx",
);

const PROFILES: EngineProfile[] = [
  {
    id: "builder",
    name: "Builder",
    model: "fake-large",
    soul: "You are Builder.",
    skills: 9,
  },
  {
    id: "reviewer",
    name: "Reviewer",
    model: "fake-small",
    soul: "You are Reviewer.",
    skills: 6,
  },
];

const DEFAULT: Employee = {
  id: "emp_default",
  name: "Default",
  role: "Assistant",
  status: "online",
  profile: "default",
  model: "fake-small",
  now: "",
  instructions: "",
  respondTo: "anyone",
};

const cardProps = {
  e: DEFAULT,
  profiles: PROFILES,
  engineName: "engine-fake",
  // Owner name stays generic — ac-118's no-hardcoded-identity scan flags
  // the shipping name anywhere under apps/.
  ownerName: "Wren",
  models: undefined,
  onEdit: () => {},
  onClose: () => {},
};

describe("AC-1 DmProfileCard hosts the shared EmployeeCard", () => {
  test("dialog shows the card rows: engine, owner, profile, model, now", () => {
    const { getByRole } = render(<DmProfileCard {...cardProps} />);
    const card = getByRole("dialog", { name: /default profile/i });
    expect(within(card).getByText("engine-fake")).toBeTruthy();
    expect(within(card).getByText(/owned by Wren/i)).toBeTruthy();
    // Profile + model rows from the shared card (not the old modal's
    // Profile/Model/Soul list).
    expect(within(card).getByText(/^Profile$/)).toBeTruthy();
    expect(within(card).getByText(/^Model$/)).toBeTruthy();
    expect(within(card).getByText("default", { selector: "dd" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: /message/i })).toBeTruthy();
    expect(within(card).getByRole("button", { name: /edit/i })).toBeTruthy();
  });

  test("profiles still loading renders a placeholder, not a missing state", () => {
    const { queryByText, getByRole } = render(
      <DmProfileCard {...cardProps} profiles={undefined} />,
    );
    expect(getByRole("dialog", { name: /default profile/i })).toBeTruthy();
    expect(queryByText(/profile missing/i)).toBeNull();
    expect(within(document.body).getByText(/loading/i)).toBeTruthy();
  });

  test("AC-2 missing profile + handler → switch; no handler → none (D-#19)", () => {
    const ghost = { ...DEFAULT, profile: "ghost" };
    const switches: string[] = [];
    const { getByText, unmount } = render(
      <DmProfileCard
        {...cardProps}
        e={ghost}
        onSwitchProfile={(p) => switches.push(p)}
      />,
    );
    expect(getByText(/profile missing/i)).toBeTruthy();
    fireEvent.click(getByText(/switch profile/i));
    fireEvent.click(within(document.body).getByText(/builder · 9 skills/i));
    expect(switches).toEqual(["builder"]);
    unmount();

    const silent = render(<DmProfileCard {...cardProps} e={ghost} />);
    expect(silent.getByText(/profile missing/i)).toBeTruthy();
    expect(silent.queryByText(/switch profile/i)).toBeNull();
  });

  test("Message, backdrop, and Escape all close the card", () => {
    let closes = 0;
    const onClose = () => closes++;
    const { getByRole, unmount } = render(
      <DmProfileCard {...cardProps} onClose={onClose} />,
    );
    fireEvent.click(getByRole("button", { name: /message/i }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(getByRole("button", { name: /close/i }));
    unmount();
    expect(closes).toBe(3);
  });
});

describe("AC-1 dm.tsx wiring", () => {
  const src = readFileSync(DM, "utf8");

  test("the DM header opens DmProfileCard; the app-local modal is gone", () => {
    // EmployeeHome's onProfile is what flips the card open.
    expect(src).toMatch(/onProfile=\{[^}]*setProfileOpen/);
    expect(src).toMatch(/profileOpen && !editOpen && \(\s*<DmProfileCard/);
    // The old app-local modal: neither defined nor rendered anymore.
    expect(src).not.toMatch(/function EmployeeProfileCard/);
    expect(src).not.toMatch(/<EmployeeProfileCard/);
  });

  test("AC-2 the switch ships a live handler — employees.update with the profile", () => {
    expect(src).toMatch(/onSwitchProfile=\{[^}]*updateEmployee/);
    expect(src).toMatch(/updateEmployee\([^,]+,\s*\{\s*profile/);
  });
});
