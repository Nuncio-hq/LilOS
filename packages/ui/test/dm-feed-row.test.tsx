// @vitest-environment happy-dom
/* Issue #83: the DM session feed put a title/actions line ABOVE the name·time
   line inside the row's content column. `Row` is `grid [avatar | content]` and
   the avatar top-aligns with the content column's first line — so the avatar
   floated a line above the name it belongs to. The Session panel row
   (`thread-view.tsx`) puts the name line first; the feed row must match. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { EmployeeHome } from "../src/employee/employee-home";
import { NO_WS } from "../src/lib/helpers";
import type { Employee, Msg } from "../src/types";

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

const EMP: Employee = {
  id: "emp_default",
  name: "Default",
  role: "Builder",
  status: "online",
  profile: "builder",
  model: "fake-large",
  now: "",
  instructions: "",
  respondTo: "me",
};

const ADA = { name: "Ada", color: "bg-blue-600" };
const emp = (id: string) => (id === EMP.id ? EMP : undefined);
const human = (id: string) => (id === "ada" ? ADA : undefined);

const FEED: Msg[] = [
  {
    kind: "msg",
    id: "m1",
    from: "ada",
    time: "07:20 PM",
    text: "What does the replay contract carry?",
    thread: {
      session: "s-d6ce22",
      replies: [
        {
          id: "r1",
          from: EMP.id,
          time: "07:22 PM",
          text: "A live cursor plus a committed history.",
        },
      ],
    },
  },
];

function home(feed: Msg[] = FEED) {
  return render(
    <EmployeeHome
      e={EMP}
      feed={feed}
      threadId={null}
      emp={emp}
      human={human}
      onNav={() => {}}
      onProfile={() => {}}
      onOpen={() => {}}
      onSend={() => {}}
      panelOpen={false}
      onPanel={() => {}}
      folders={[]}
      pick={NO_WS}
      setPick={() => {}}
      onRename={() => {}}
      onArchive={() => {}}
    />,
  );
}

describe("issue #83", () => {
  test("AC-1 the avatar's content column opens with the name·time line", () => {
    const { container } = home();
    const grid = container.querySelector("[data-session] > .grid");
    // `Row` lays out `grid [avatar | content]` — the avatar-ish child first
    // (HumanAvatar's root, HermesAvatar's wrapper), the content column last.
    expect(
      grid?.firstElementChild?.querySelector("[data-slot='avatar']") ??
        grid?.firstElementChild?.getAttribute("data-slot"),
    ).toBeTruthy();
    // The avatar cell top-aligns with the content column's FIRST line —
    // which must be the name·time header. Any line above it (the old
    // title/actions line) lifts the avatar a line up. The ⋯ menu rides the
    // name line itself.
    const content = grid?.lastElementChild;
    const line1 = content?.firstElementChild;
    expect(line1?.textContent).toContain("Ada");
    expect(line1?.textContent).toContain("07:20 PM");
    expect(line1?.querySelector("[aria-label='Session actions']")).toBeTruthy();
  });

  test("AC-1 a renamed session's title sits under the name line, not above", () => {
    const renamed: Msg[] = [
      {
        kind: "msg",
        id: "m1",
        from: "ada",
        time: "07:20 PM",
        text: "What does the replay contract carry?",
        thread: {
          session: "s-d6ce22",
          title: "Repo summary",
          replies: [
            {
              id: "r1",
              from: EMP.id,
              time: "07:22 PM",
              text: "A live cursor plus a committed history.",
            },
          ],
        },
      },
    ];
    const { container } = home(renamed);
    const content = container.querySelector(
      "[data-session] > .grid",
    )?.lastElementChild;
    const lines = [...(content?.children ?? [])];
    expect(lines[0]?.textContent).toContain("Ada");
    expect(lines[1]?.textContent).toContain("Repo summary");
    expect(lines[2]?.textContent).toContain(
      "What does the replay contract carry?",
    );
  });
});
