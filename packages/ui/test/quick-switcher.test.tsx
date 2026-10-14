// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SwitcherItem, searchSwitcher } from "../src/lib/switcher";
import { QuickSwitcher } from "../src/shell/quick-switcher";

afterEach(cleanup);

const employee = (id: string, name: string): SwitcherItem => ({
  kind: "employee",
  id,
  title: name,
  subtitle: "engineer",
});
const session = (
  id: string,
  title: string,
  first = "",
  extra: Partial<SwitcherItem> = {},
): SwitcherItem => ({
  kind: "session",
  id,
  title,
  subtitle: first,
  match: first,
  ...extra,
});
const folder = (id: string, name: string): SwitcherItem => ({
  kind: "folder",
  id,
  title: name,
  subtitle: id,
});

describe("searchSwitcher", () => {
  const items: SwitcherItem[] = [
    employee("e1", "Builder"),
    employee("e2", "Reviewer"),
    session("s1", "Relay reconnect plan", "Check the relay reconnect plan"),
    session("s2", "Paywall copy", "Rewrite the paywall pricing copy"),
    folder("~/repo", "repo"),
  ];

  it("empty query keeps the input order, grouped by kind", () => {
    const out = searchSwitcher(items, "");
    expect(out.map((i) => i.id)).toEqual(["e1", "e2", "s1", "s2", "~/repo"]);
  });

  it("matches titles and the first-message match text", () => {
    expect(searchSwitcher(items, "builder").map((i) => i.id)).toEqual(["e1"]);
    /* "pricing" only lives in s2's first message, not its title. */
    expect(searchSwitcher(items, "pricing").map((i) => i.id)).toEqual(["s2"]);
    expect(searchSwitcher(items, "reconnect").map((i) => i.id)).toEqual(["s1"]);
  });

  it("ANDs multiple terms across title and match text", () => {
    expect(searchSwitcher(items, "paywall pricing").map((i) => i.id)).toEqual([
      "s2",
    ]);
    expect(searchSwitcher(items, "paywall relay")).toEqual([]);
  });

  it("ranks a title hit above a match-text hit; archived sinks", () => {
    const list = [
      session("weak", "Notes", "contains relay in the body"),
      session("strong", "Relay reconnect", "unrelated"),
      session("old", "Relay reconnect", "", { archived: true }),
    ];
    /* An open session with a weak match still beats a buried strong one. */
    expect(searchSwitcher(list, "relay").map((i) => i.id)).toEqual([
      "strong",
      "weak",
      "old",
    ]);
  });

  it("per-section caps keep sessions from crowding out employees/folders", () => {
    const many = [
      employee("e1", "relay fan"),
      ...Array.from({ length: 40 }, (_, i) =>
        session(`s${i}`, `relay session ${i}`),
      ),
      folder("~/relay", "relay"),
    ];
    const out = searchSwitcher(many, "relay");
    expect(out.filter((i) => i.kind === "session")).toHaveLength(14);
    expect(out.filter((i) => i.kind === "employee")).toHaveLength(1);
    expect(out.filter((i) => i.kind === "folder")).toHaveLength(1);
  });

  it("searches 1k sessions under 50ms", () => {
    const big: SwitcherItem[] = Array.from({ length: 1000 }, (_, i) =>
      session(
        `s${i}`,
        `Session ${i} about topic ${i % 7}`,
        `First message body ${i} with some words`,
      ),
    );
    // Warm any lazy costs out of the measurement.
    searchSwitcher(big, "topic");
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) searchSwitcher(big, `topic ${i % 8} body`);
    const per = (performance.now() - t0) / 20;
    expect(per).toBeLessThan(50);
  });
});

describe("QuickSwitcher", () => {
  const items: SwitcherItem[] = [
    employee("e1", "Builder"),
    session("s1", "Relay reconnect plan", "Check the relay plan", {
      needsYou: true,
    }),
    session("s2", "Idle thread", "quiet", { running: true }),
    folder("~/LilOS", "LilOS"),
  ];
  const open = (onPick = vi.fn(), onClose = vi.fn()) => ({
    onPick,
    onClose,
    ...render(
      <QuickSwitcher items={items} onPick={onPick} onClose={onClose} />,
    ),
  });

  it("renders grouped sections with running/needs-you badges", () => {
    const { container, getByPlaceholderText } = open();
    const text = container.textContent ?? "";
    expect(text).toContain("Employees");
    expect(text).toContain("Sessions");
    expect(text).toContain("Folders");
    expect(container.querySelector("[data-badge-needsyou]")).not.toBeNull();
    expect(container.querySelector("[data-badge-running]")).not.toBeNull();
    /* Input lands focused — the first chord is typing, no click. */
    expect(document.activeElement).toBe(getByPlaceholderText(/jump to/i));
  });

  it("filters as you type and Enter opens the highlighted pick", async () => {
    const { onPick, getByPlaceholderText } = open();
    const input = getByPlaceholderText(/jump to/i);
    await act(async () =>
      fireEvent.change(input, { target: { value: "reconnect" } }),
    );
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "session", id: "s1" }),
    );
  });

  it("arrow keys move the highlight to a later row", async () => {
    const { onPick, getByPlaceholderText, container } = open();
    const input = getByPlaceholderText(/jump to/i);
    await act(async () => fireEvent.keyDown(input, { key: "ArrowDown" }));
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    const picked = onPick.mock.calls[0]?.[0] as SwitcherItem;
    expect(picked.id).toBe(items[1].id);
    expect(container.querySelector("[data-switcher-item]")).not.toBeNull();
  });

  it("click on the backdrop closes; an empty result says so", async () => {
    const { onClose, getByPlaceholderText, container } = open();
    const input = getByPlaceholderText(/jump to/i);
    await act(async () =>
      fireEvent.change(input, { target: { value: "zzzzz" } }),
    );
    expect(container.textContent).toContain("Nothing matches");
    fireEvent.click(container.querySelector("[data-quick-switcher]")!);
    expect(onClose).toHaveBeenCalled();
  });
});
