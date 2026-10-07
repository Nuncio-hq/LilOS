// @vitest-environment happy-dom
/* Group B red-first tests — #587 (stable tabs, helpers only under
   Subagents, real git authors, path truncation), #579 (one PR path: no
   header "Open PR" button, a "PR #N" chip, errors that name a next step
   instead of a terminal command), #584 (Suggest is a side ask: nothing
   enters the transcript, it survives reloads and works mid-turn). */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FocusView } from "../src/focus/focus-view";
import { setDraft } from "../src/lib/drafts";
import type {
  Channel,
  EmpFn,
  Employee,
  GitCommit,
  HostAccessors,
  HumanFn,
  Msg,
  PullRequest,
  Reply,
  ShipBar,
  Thread,
  Work,
} from "../src/types";
import { CommitBar } from "../src/workbench/commit-bar";
import { PrFailure } from "../src/workbench/pr-failure";
import { Workbench } from "../src/workbench/workbench";

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
if (typeof Element.prototype.getAnimations === "undefined") {
  Element.prototype.getAnimations = () => [];
}
if (typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = () => {};
}
Object.defineProperty(window, "innerWidth", { value: 1400, writable: true });
afterEach(cleanup);
afterEach(() => localStorage.clear());

const BUILDER: Employee = {
  id: "builder",
  name: "Builder",
  role: "Engineer",
  status: "online",
  profile: "p",
  model: "gpt-test-1",
  now: "",
  instructions: "",
  respondTo: "anyone",
};
const emp: EmpFn = (id) => (id === "builder" ? BUILDER : undefined);
const human: HumanFn = (id) =>
  id === "ada" ? { name: "Ada", color: "bg-blue-600" } : undefined;

const DIFF_STEP = {
  tool: "edit",
  input: { path: "src/app.ts" },
  output: "done",
  diff: {
    path: "src/app.ts",
    status: "modified" as const,
    add: 3,
    del: 1,
    patch: "@@ -1,2 +1,2 @@\n-old\n+new",
  },
};
const DIRTY_REPLY: Reply = {
  id: "r-diff",
  from: "builder",
  time: "10:02",
  text: "edited",
  steps: [DIFF_STEP],
};
const THREAD: Thread = { session: "s_groupb", replies: [DIRTY_REPLY] };
const WORK: Work = { ticket: "T-1", title: "Task", path: "/tmp/ac-repo" };
const CHANNEL: Channel = {
  id: "dm-builder",
  name: "Builder",
  employees: ["builder"],
  dm: true,
};
const ROOT: Extract<Msg, { kind: "msg" }> = {
  kind: "msg",
  id: "m1",
  from: "ada",
  time: "10:00",
  text: "@builder fix it",
};

const SHIP: ShipBar = {
  isRepo: true,
  branch: "feat/x",
  files: [{ path: "src/app.ts", checked: true }],
  commits: [],
  message: "",
  busy: null,
  error: null,
};

const wb = (over: Partial<Parameters<typeof Workbench>[0]> = {}) => (
  <Workbench
    thread={THREAD}
    work={WORK}
    isDM
    lead={BUILDER}
    tab="changes"
    setTab={() => {}}
    onClose={() => {}}
    human={human}
    ship={SHIP}
    {...over}
  />
);

const FAST_HOST: HostAccessors = {
  tree: async () => ["src/app.ts"],
  diff: async () => [
    {
      path: "src/app.ts",
      status: "modified",
      add: 3,
      del: 1,
      patch: "@@ -1,2 +1,2 @@\n-old\n+new",
    },
  ],
  read: async () => ({ content: "x", binary: false, truncated: false }),
  pr: async () => ({ pr: null, branch: "feat/x" }),
  status: async () => ({ branch: "feat/x", clean: false }),
  branches: async () => ({
    current: "feat/x",
    branches: ["feat/x"],
    remote: null,
  }),
  log: async () => [],
};

describe("#587 AC-1 the tab strip's membership is fixed; empty tabs grey, never move", () => {
  test("tab order is fixed and empty engine tabs render muted, not absent", () => {
    const c = render(
      wb({ caps: { plan: true, subagents: true, background: true } }),
    );
    const names = [...c.container.querySelectorAll("[data-wb-tab]")].map((e) =>
      e.getAttribute("data-wb-tab"),
    );
    expect(names).toEqual([
      "changes",
      "files",
      "terminal",
      "preview",
      "plan",
      "background",
      "subagents",
      "pr",
    ]);
    for (const t of ["plan", "background", "subagents", "pr"]) {
      const el = c.container.querySelector(`[data-wb-tab="${t}"]`);
      expect(el?.getAttribute("data-wb-empty")).toBe("true");
      expect(el?.className).toContain("opacity-40");
    }
    /* Content tabs stay full-strength. */
    expect(
      c.container.querySelector('[data-wb-tab="changes"]')?.className,
    ).not.toContain("opacity-40");
  });

  test("a capability the engine doesn't declare never joins the strip", () => {
    const c = render(
      wb({
        caps: { plan: true, subagents: false, background: true },
      }),
    );
    const names = [...c.container.querySelectorAll("[data-wb-tab]")].map((e) =>
      e.getAttribute("data-wb-tab"),
    );
    expect(names).toEqual([
      "changes",
      "files",
      "terminal",
      "preview",
      "plan",
      "background",
      "pr",
    ]);
  });

  test("a helper row unmutes Subagents even when the capability read missed", () => {
    const reply: Reply = {
      id: "r1",
      from: "builder",
      time: "10:01",
      text: "delegating",
      subagents: [
        {
          id: "sa1",
          name: "task 1",
          task: "scan",
          status: "running",
          steps: [],
        },
      ],
    };
    const c = render(
      wb({
        thread: { session: "s_groupb", replies: [reply] },
        caps: { plan: true, subagents: false, background: true },
      }),
    );
    const sub = c.container.querySelector('[data-wb-tab="subagents"]');
    expect(sub).not.toBeNull();
    expect(sub?.getAttribute("data-wb-empty")).toBeNull();
    expect(sub?.className).not.toContain("opacity-40");
  });
});

describe("#587 AC-3 commit rows show the real git author", () => {
  const commit = (author?: string): GitCommit => ({
    hash: "abc1234",
    message: "feat: traced the envelope",
    author,
    files: [{ path: "a.ts", status: "modified", add: 1, del: 0 }],
  });

  test("a commit with an author names the author, not the employee", async () => {
    const c = render(
      wb({ ship: { ...SHIP, commits: [commit("Octavia Blake")] } }),
    );
    await waitFor(() =>
      expect(c.container.textContent).toContain("Octavia Blake"),
    );
    const hash = [...c.container.querySelectorAll("*")].findLast(
      (e) => e.textContent === "abc1234",
    );
    expect(hash?.parentElement?.textContent).toContain("Octavia Blake");
    expect(hash?.parentElement?.textContent).not.toContain("Builder");
  });

  test("a commit with no author (mock rows) falls back to the employee", () => {
    const c = render(wb({ ship: { ...SHIP, commits: [commit()] } }));
    expect(c.container.textContent).toContain("Builder");
  });
});

describe("#587 path rows keep the file name visible", () => {
  test("the file-view breadcrumb truncates the dirname, never the basename", async () => {
    const deep =
      "/var/folders/aa/bb/cc/T/tmp-lilos-1234567890/deeply/nested/path/main-page.tsx";
    const host: HostAccessors = { ...FAST_HOST, tree: async () => [deep] };
    /* workbench_open's file deep-link is how an absolute path lands in the
       view (the host's fs.tree rows stay repo-relative; a tool's diff can
       carry an absolute one — the bug this fixes). */
    const c = render(
      wb({ host, tab: "files", spot: { at: 1, target: { file: deep } } }),
    );
    await waitFor(() =>
      expect(c.container.querySelector("[data-fileview]")).not.toBeNull(),
    );
    const view = c.container.querySelector("[data-fileview]")!;
    const crumb = view.querySelector('[title="' + deep + '"]');
    expect(crumb).not.toBeNull();
    /* Basename is its own non-truncating span — the tail is always shown. */
    const base = view.querySelector("span.shrink-0.font-medium");
    expect(base?.textContent).toBe("/main-page.tsx");
    const dir = view.querySelector('span[dir="rtl"]');
    expect(dir?.textContent).toContain("var/folders");
  });

  test("the repo path row truncates the path on the left and keeps the count on one line", async () => {
    const c = render(
      wb({
        host: {
          ...FAST_HOST,
          diff: async () => [
            {
              path: "a.ts",
              status: "modified",
              add: 1,
              del: 0,
              patch: "@@ -1 +1 @@\n-old\n+new",
            },
          ],
        },
        tab: "files",
      }),
    );
    await waitFor(() =>
      expect(c.container.textContent).toContain("1 file changed"),
    );
    const path = c.container.querySelector('span[dir="rtl"]');
    expect(path?.textContent).toBe("/tmp/ac-repo");
    const count = [...c.container.querySelectorAll("span")].find((e) =>
      e.textContent?.includes("1 file changed"),
    );
    expect(count?.className).toContain("whitespace-nowrap");
    expect(count?.className).toContain("shrink-0");
  });
});

describe("#579 one way to a PR", () => {
  const pr: PullRequest = {
    number: 12,
    repo: "acme/lilos",
    title: "Envelope contract",
    body: "…",
    status: "open",
    author: "builder",
    base: "main",
    head: "lil-1",
    opened: "10:00",
    checks: [{ name: "verify", status: "passed" }],
    comments: [],
  };
  const focus = (thread: Thread) => (
    <FocusView
      root={ROOT}
      thread={thread}
      channel={CHANNEL}
      lead={BUILDER}
      emp={emp}
      human={human}
      resolved={{}}
      work={null}
      running={false}
      onSend={() => {}}
    />
  );

  test("AC-1 no header 'Open PR' button; a session with a PR shows a '#N' chip", () => {
    const withPr = render(focus({ ...THREAD, pr }));
    expect(withPr.container.textContent).not.toContain("Open PR");
    const chip = withPr.container.querySelector("[data-prchip]");
    expect(chip?.textContent).toContain("#12");
    withPr.unmount();
    const without = render(focus(THREAD));
    expect(without.container.querySelector("[data-prchip]")).toBeNull();
    expect(without.container.textContent).not.toContain("Open PR");
  });

  test("AC-2 ship errors name a next step the user can take — never a command", () => {
    for (const [reason, want] of [
      ["no-remote", "Ask Default to publish it"],
      ["diverged", "Ask Default to update the branch"],
      ["auth", "Ask Default to fix the sign-in"],
      ["unauthenticated", "Ask Default to sign in"],
      ["missing", "Ask Default to install it"],
      ["conflict", "Ask Default to finish the merge"],
    ] as const) {
      const c = render(
        <CommitBar
          {...SHIP}
          employeeName="Default"
          error={{
            reason,
            text: "fatal: everything is broken",
            detail: "git push origin main\n! rejected",
          }}
        />,
      );
      const err = c.container.querySelector("[data-shiperror] p");
      expect(err?.textContent).toContain(want);
      /* The headline copy contains no terminal command — raw stderr lives
         behind Details only. */
      expect(err?.textContent).not.toMatch(
        /\b(git|gh) (push|pull|remote|auth|add)\b/,
      );
      c.unmount();
    }
  });

  test("AC-2 the PR tab's gh-failure copy asks the employee, never the shell", () => {
    for (const reason of ["missing", "unauthenticated"] as const) {
      const c = render(
        <PrFailure
          error={{ reason, detail: "gh auth login --web" }}
          employeeName="Default"
        />,
      );
      const p = c.container.querySelector("p");
      expect(p?.textContent).toContain("Ask Default");
      expect(p?.textContent).not.toContain("gh ");
      c.unmount();
    }
  });
});

describe("#584 Suggest is a side ask, not a transcript message", () => {
  test("AC-1 clicking Suggest fills the box via onSuggest — onSend never fires", async () => {
    const onSend = vi.fn();
    const onSuggest = vi.fn(async () => "> `feat: app guard`\n\nwhy: …");
    const c = render(wb({ onSend, onSuggest }));
    await waitFor(() =>
      expect(c.container.querySelector("[data-shipsuggest]")).not.toBeNull(),
    );
    fireEvent.click(c.container.querySelector("[data-shipsuggest]")!);
    await waitFor(() =>
      expect(
        c.container.querySelector<HTMLInputElement>("[data-shipmessage]")
          ?.value,
      ).toBe("feat: app guard"),
    );
    expect(onSuggest).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  test("AC-2 Suggest stays enabled while a turn runs, and its answer survives a remount", async () => {
    const onSuggest = vi.fn(async () => "chore: apply pending changes");
    const c = render(wb({ onSuggest, running: true }));
    await waitFor(() =>
      expect(
        c.container.querySelector<HTMLButtonElement>("[data-shipsuggest]")
          ?.disabled,
      ).toBe(false),
    );
    fireEvent.click(c.container.querySelector("[data-shipsuggest]")!);
    await waitFor(() =>
      expect(
        c.container.querySelector<HTMLInputElement>("[data-shipmessage]")
          ?.value,
      ).toBe("chore: apply pending changes"),
    );
    /* The draft persists through localStorage — unmount + remount reads it
       back exactly like a composer draft. */
    c.unmount();
    const again = render(wb({}));
    await waitFor(() =>
      expect(
        again.container.querySelector<HTMLInputElement>("[data-shipmessage]")
          ?.value,
      ).toBe("chore: apply pending changes"),
    );
    setDraft("wb-commit:s_groupb", "");
  });
});
