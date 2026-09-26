// @vitest-environment happy-dom
/* AC tests for issue #29: HireDialog lists/creates engine profiles with no
   who-can-direct picker, EmployeeCard renders the profile-missing state, and
   EditEmployeeDialog edits name+role and removes with a keep-profile note. */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { HireDialog } from "../src/dialogs/hire-dialog";
import { EditEmployeeDialog } from "../src/employee/employee-edit";
import { EmployeeCard } from "../src/employee/employee-home";
import type { Employee, EngineProfile, HireDraft } from "../src/types";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element.prototype.scrollTo === "undefined") {
  Element.prototype.scrollTo = () => {};
}
if (typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = () => {};
}
afterEach(cleanup);

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

const EMPLOYEE: Employee = {
  id: "emp_ada",
  name: "Ada",
  role: "Engineer",
  status: "online",
  profile: "reviewer",
  model: "fake-small",
  now: "",
  instructions: "",
  respondTo: "anyone",
};

const DRAFT: HireDraft = { name: "", role: "", instructions: "", model: "" };

const dialogProps = {
  initial: DRAFT,
  templates: [] as HireDraft[],
  profiles: PROFILES,
  models: ["fake-small", "fake-large"],
  allChannels: [{ id: "engineering", label: "#engineering" }],
  onClose: () => {},
};

describe("AC-1/AC-6 HireDialog", () => {
  test("AC-1 lists engine profiles; hired ones are disabled", () => {
    const { getByRole, getByText } = render(
      <HireDialog
        {...dialogProps}
        usedProfiles={["builder"]}
        onHire={() => {}}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Use profile" }));
    const builder = getByText("builder").closest("button");
    const reviewer = getByText("reviewer").closest("button");
    expect(builder?.disabled).toBe(true);
    expect(reviewer?.disabled).toBe(false);
    expect(within(reviewer!).getByText(/6 skills/)).toBeTruthy();

    // Picking one shows the read-only engine facts (model, persona).
    fireEvent.click(reviewer!);
    expect(getByText("fake-small")).toBeTruthy();
    expect(getByText(/You are Reviewer/)).toBeTruthy();
  });

  test("AC-6 no who-can-direct picker anywhere in the dialog", () => {
    const { queryByText, getByRole } = render(
      <HireDialog {...dialogProps} usedProfiles={[]} onHire={() => {}} />,
    );
    expect(queryByText(/who can direct/i)).toBeNull();
    fireEvent.click(getByRole("button", { name: "New profile" }));
    expect(queryByText(/who can direct/i)).toBeNull();
  });

  test("AC-1/AC-2 hire reports the picked profile id, or null for a new one", () => {
    const hired: (string | null)[] = [];
    const first = render(
      <HireDialog
        {...dialogProps}
        usedProfiles={[]}
        onHire={(_d, profile) => hired.push(profile)}
      />,
    );
    fireEvent.click(first.getByRole("button", { name: "Use profile" }));
    fireEvent.click(first.getByText("reviewer").closest("button")!);
    fireEvent.click(first.getByRole("button", { name: /Hire Reviewer/ }));
    expect(hired).toEqual(["reviewer"]);
    first.unmount();

    hired.length = 0;
    const second = render(
      <HireDialog
        {...dialogProps}
        initial={{ ...DRAFT }}
        usedProfiles={[]}
        onHire={(_d, profile) => hired.push(profile)}
      />,
    );
    fireEvent.click(second.getByRole("button", { name: "New profile" }));
    fireEvent.change(second.getByPlaceholderText("Tester"), {
      target: { value: "Ada Lovelace" },
    });
    fireEvent.click(second.getByRole("button", { name: /Hire Ada Lovelace/ }));
    expect(hired).toEqual([null]);
  });
});

describe("AC-5 EmployeeCard profile-missing state", () => {
  test("shows 'Profile missing' + Switch profile when the profile is gone", () => {
    const switches: string[] = [];
    const { getByText } = render(
      <EmployeeCard
        e={{ ...EMPLOYEE, profile: "ghost" }}
        profiles={PROFILES}
        onDM={() => {}}
        onEdit={() => {}}
        onSwitchProfile={(id) => switches.push(id)}
      />,
    );
    expect(getByText(/Profile missing/i)).toBeTruthy();
    expect(getByText(/Switch profile/i)).toBeTruthy();
    fireEvent.click(getByText(/Switch profile/i));
    const option = within(document.body).getByText(/builder · 9 skills/);
    fireEvent.click(option);
    expect(switches).toEqual(["builder"]);
  });

  test("no switcher without onSwitchProfile (a control needs its handler)", () => {
    const { queryByText } = render(
      <EmployeeCard
        e={{ ...EMPLOYEE, profile: "ghost" }}
        profiles={PROFILES}
        onDM={() => {}}
      />,
    );
    expect(queryByText(/Switch profile/i)).toBeNull();
  });
});

describe("AC-3/AC-4 EditEmployeeDialog", () => {
  test("edits display name + role; removal keeps the engine profile", () => {
    const saves: [string, string][] = [];
    let removed = 0;
    const { getByLabelText, getAllByRole, getByText } = render(
      <EditEmployeeDialog
        e={EMPLOYEE}
        onClose={() => {}}
        onSave={(name, role) => saves.push([name, role])}
        onRemove={() => removed++}
      />,
    );
    fireEvent.change(getByLabelText(/display name/i), {
      target: { value: "Ada Lovelace" },
    });
    fireEvent.change(getByLabelText(/^role/i), {
      target: { value: "Principal" },
    });
    fireEvent.click(getAllByRole("button", { name: /^save$/i })[0]!);
    expect(saves).toEqual([["Ada Lovelace", "Principal"]]);

    fireEvent.click(
      getAllByRole("button", { name: /remove from company/i })[0]!,
    );
    // The confirm copy promises the engine profile is kept.
    getByText(/its sessions, memory, and skills/i);
    const confirm = getAllByRole("button", { name: /remove from company/i });
    fireEvent.click(confirm[confirm.length - 1]!);
    expect(removed).toBe(1);
  });
});

describe("issue #64 remove confirmation", () => {
  const openConfirm = (onRemove = () => {}) =>
    render(
      <EditEmployeeDialog
        e={EMPLOYEE}
        onClose={() => {}}
        onSave={() => {}}
        onRemove={onRemove}
      />,
    );

  test("AC-1 the profile id renders as code, with no literal backticks", () => {
    const { getByRole } = openConfirm();
    fireEvent.click(getByRole("button", { name: /remove from company/i }));
    const alert = getByRole("alert");
    expect(alert.textContent).not.toContain("`");
    expect(within(alert).getByText("reviewer").tagName).toBe("CODE");
  });

  test("AC-2 the confirmation says what goes and what stays", () => {
    const { getByRole } = openConfirm();
    fireEvent.click(getByRole("button", { name: /remove from company/i }));
    const text = getByRole("alert").textContent ?? "";
    for (const gone of ["company record", "channel memberships", "DMs"]) {
      expect(text).toMatch(new RegExp(gone, "i"));
    }
    for (const stay of ["engine profile", "sessions", "memory", "skills"]) {
      expect(text).toMatch(new RegExp(stay, "i"));
    }
  });

  test("AC-3 exactly one Cancel while pending; Save disabled; Cancel backs out", () => {
    let removed = 0;
    const { getByRole, getAllByRole } = openConfirm(() => removed++);
    fireEvent.click(getByRole("button", { name: /remove from company/i }));
    const cancels = getAllByRole("button", { name: /^cancel$/i });
    expect(cancels).toHaveLength(1);
    expect(
      (getByRole("button", { name: /^save$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // The single Cancel returns to the edit form; nothing is removed.
    fireEvent.click(cancels[0]!);
    expect(removed).toBe(0);
    expect(
      getByRole("button", { name: /remove from company/i }),
    ).toBeTruthy();
    expect(
      (getByRole("button", { name: /^save$/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
