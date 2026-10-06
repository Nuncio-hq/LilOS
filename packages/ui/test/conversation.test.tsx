// @vitest-environment happy-dom
/* AC tests for issue #19: ONE conversation implementation shared by the channel thread panel,
   DM session panel and Focus — plus the "a control renders only when its handler is passed" rule. */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { FocusView } from "../src/focus/focus-view";
import { ThreadView } from "../src/thread/thread-view";
import type {
  Channel,
  EmpFn,
  HumanFn,
  Msg,
  PullRequest,
  Reply,
  Thread,
  Workspace,
} from "../src/types";

/* happy-dom does not implement every browser API the vendored components touch. */
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
// The workbench opens at >=1024px; force it so the PR tab actually mounts.
Object.defineProperty(window, "innerWidth", { value: 1400, writable: true });
afterEach(cleanup);

const BUILDER = {
  id: "builder",
  name: "Builder",
  role: "Engineer",
  status: "online" as const,
  profile: "p",
  model: "gpt-test-1",
  now: "",
  instructions: "",
  respondTo: "anyone" as const,
};
const emp: EmpFn = (id) => (id === "builder" ? BUILDER : undefined);
const human: HumanFn = (id) =>
  id === "ada" || id === "user"
    ? { name: "Ada", color: "bg-blue-600" }
    : undefined;

const root: Extract<Msg, { kind: "msg" }> = {
  kind: "msg",
  id: "m1",
  from: "ada",
  time: "10:00",
  text: "@builder walk me through the envelope contract",
};

/* A finished agent turn: reasoning + 3 tool steps + text + duration. No `diff` step, so the
   turn is byte-identical across frames (the files-changed affordance opens the workbench,
   which exists only in Focus). */
const stepTurn: Reply = {
  id: "r1",
  from: "builder",
  time: "10:04",
  reasoning: "Let me trace the envelope path.",
  thought: 4,
  steps: [
    {
      tool: "read",
      input: { path: "packages/contracts/envelope.ts" },
      output: "…",
    },
    { tool: "terminal", input: { command: "bun test" }, output: "ok" },
    { tool: "edit", input: { path: "envelope.ts" }, output: "done" },
  ],
  text: "Typecheck is clean across 4 packages.",
  phase: "done",
  dur: 21,
};
const humanTurn: Reply = {
  id: "r2",
  from: "ada",
  time: "10:05",
  text: "and the PR?",
};
/* Last reply carries both cards: an approval request and an asks-to-start-work card. */
const cardTurn: Reply = {
  id: "r3",
  from: "builder",
  time: "10:06",
  text: "",
  approval: { id: "a1", command: "bun publish", note: "Needs a network write" },
  startProposal: { title: "Cut release 0.1" },
};
const thread: Thread = {
  session: "s_abc123",
  replies: [stepTurn, humanTurn, cardTurn],
  queue: ["looks good, ship it"],
};
const channel: Channel = {
  id: "eng",
  name: "engineering",
  employees: ["builder"],
  repo: "Nuncio-hq/LilOS",
};
const dmChannel: Channel = {
  id: "dm-builder",
  name: "Builder",
  employees: ["builder"],
  dm: true,
};
const pr: PullRequest = {
  number: 12,
  repo: "Nuncio-hq/LilOS",
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

const panelProps = {
  root,
  thread,
  emp,
  human,
  running: false,
  work: null,
  resolved: {},
  repo: channel.repo,
  onSend: () => {},
} as const;
const focusProps = {
  root,
  thread,
  channel,
  emp,
  human,
  running: false,
  work: null,
  resolved: {},
  onSend: () => {},
} as const;

/* Generated ids (aria-controls etc.) differ per mount; structure/text/classes must not. */
const canon = (el: Element) =>
  el.innerHTML
    .replace(
      /\s(id|aria-controls|aria-labelledby|aria-describedby|for)="[^"]*"/g,
      "",
    )
    .trim();
const agentTurns = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("[data-agentturn]"));

/* All tool steps of a turn collapse into ONE block with a single trigger; expanding it reveals
   every step's tool card. */
function expectTaskBlock(turn: Element, steps: number) {
  const blocks = turn.querySelectorAll("[data-tasksteps]");
  expect(blocks.length).toBe(1);
  const block = blocks[0];
  const trigger = block.querySelector(
    ":scope > [data-slot='collapsible-trigger']",
  );
  if (!trigger) throw new Error("collapsible trigger missing");
  expect(trigger.textContent).toContain(`${steps} steps`);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const tools = block.querySelectorAll(
    "[data-slot='collapsible-content'] [data-slot='collapsible']",
  );
  expect(tools.length).toBe(steps);
  const stepList = stepTurn.steps;
  if (!stepList) throw new Error("stepTurn.steps missing");
  for (const s of stepList) expect(block.textContent).toContain(s.tool);
}

describe("issue #19 — one conversation from shared pieces", () => {
  test("AC-1 channel thread, DM thread and Focus render the same reply with the same AgentTurn component", () => {
    const panel = render(<ThreadView {...panelProps} channel={channel} />);
    const dm = render(<ThreadView {...panelProps} channel={dmChannel} />);
    const focus = render(<FocusView {...focusProps} />);
    const counts = [panel.container, dm.container, focus.container].map(
      (c) => agentTurns(c).length,
    );
    // stepTurn + cardTurn come from the employee → two agent turns per frame
    expect(counts).toEqual([2, 2, 2]);
    const [panelTurn] = agentTurns(panel.container);
    const [dmTurn] = agentTurns(dm.container);
    const [focusTurn] = agentTurns(focus.container);
    expect(canon(panelTurn)).toBe(canon(focusTurn));
    expect(canon(dmTurn)).toBe(canon(focusTurn));
  });

  test("AC-2 tool steps render as one collapsible Task block in both frames", () => {
    const panel = render(<ThreadView {...panelProps} channel={channel} />);
    const dm = render(<ThreadView {...panelProps} channel={dmChannel} />);
    const focus = render(<FocusView {...focusProps} />);
    for (const c of [panel.container, dm.container, focus.container]) {
      const turn = agentTurns(c)[0];
      expect(turn).toBeTruthy();
      if (!stepTurn.steps) throw new Error("stepTurn.steps missing");
      expectTaskBlock(turn, stepTurn.steps.length);
    }
  });

  test("AC-3 DM detection has one source (channel.dm); the name prefix is gone", () => {
    // A channel merely NAMED like a DM is a channel thread.
    const notDm = render(
      <ThreadView
        {...panelProps}
        channel={{ id: "x", name: "DM tooling", employees: [], repo: "r" }}
      />,
    );
    expect(within(notDm.container).getByText("Thread")).toBeTruthy();
    expect(within(notDm.container).getByText(/#DM tooling/)).toBeTruthy();
    cleanup();
    // dm:true → Session frame, DM label, no Start work affordance.
    const dm = render(<ThreadView {...panelProps} channel={dmChannel} />);
    expect(within(dm.container).getByText("Session")).toBeTruthy();
    expect(within(dm.container).getByText(/DM · Builder/)).toBeTruthy();
    expect(
      within(dm.container).queryByRole("button", { name: /Start work/ }),
    ).toBeNull();
  });

  test("AC-4 optional controls render only when their handler is passed", async () => {
    /* No optional handlers anywhere: only required props. The conversation still renders
       (turns, card titles, step block) but none of the optional controls exist. */
    const quietPanel = render(<ThreadView {...panelProps} channel={channel} />);
    const qp = within(quietPanel.container);
    for (const name of [
      /Start work/,
      /^Focus$/,
      /^Retry$/,
      /Review & start/,
      /Not yet/,
      /^Once$/,
      /^Always$/,
      /Deny/,
    ])
      expect(qp.queryByRole("button", { name })).toBeNull();
    // the cards still render their information — only the actions are gone
    expect(qp.getByText("Approval needed · only Ada can answer")).toBeTruthy();
    expect(qp.getByText(/Builder asks to start work/)).toBeTruthy();
    // not-sent tray lists items but its Send/Remove actions need handlers
    expect(quietPanel.container.querySelector("[data-notsent]")).toBeTruthy();
    expect(
      quietPanel.container.querySelector("[data-notsent-send]"),
    ).toBeNull();
    expect(
      quietPanel.container.querySelector("[data-notsent-remove]"),
    ).toBeNull();

    const quietFocus = render(
      <FocusView
        {...focusProps}
        thread={{ ...thread, pr }}
        work={{ ticket: "LIL-9", branch: "lil-9-x", title: "x" }}
      />,
    );
    const qf = within(quietFocus.container);
    for (const name of [
      /Start work/,
      /Squash and merge/,
      /gpt-test-1/, // model picker trigger shows the model name
      /Review & start/,
      /^Once$/,
      /* #578: the affordance is the row's hover "Rewind" button now. */
      /^Rewind$/,
    ])
      expect(qf.queryByRole("button", { name })).toBeNull();
    expect(qf.queryByText(/Add a comment/)).toBeNull();
    // icon buttons whose only accessible handle is the title
    expect(
      quietFocus.container.querySelector('[title="Exit focus"]'),
    ).toBeNull();
    expect(
      quietFocus.container.querySelector('[title="Workspace"]'),
    ).toBeNull();

    // Same frames WITH the handlers → the controls exist (the gates are real, not deletion).
    const wiredPanel = render(
      <ThreadView
        {...panelProps}
        channel={channel}
        onFocus={() => {}}
        onStart={() => {}}
        onStop={() => {}}
        onRetry={() => {}}
        onUnqueue={() => {}}
        onSendQueued={() => {}}
        setResolved={() => {}}
      />,
    );
    const wp = within(wiredPanel.container);
    expect(wp.getByRole("button", { name: /Start work/ })).toBeTruthy();
    expect(wp.getByRole("button", { name: "Focus" })).toBeTruthy();
    expect(wp.getByRole("button", { name: /^Once$/ })).toBeTruthy();
    expect(wp.getByRole("button", { name: /Not yet/ })).toBeTruthy();
    expect(
      wiredPanel.container.querySelector("[data-notsent-send]"),
    ).toBeTruthy();
    // Retry renders on the last agent turn when onRetry is passed.
    const threadRetryLast: Thread = {
      ...thread,
      replies: [cardTurn, humanTurn, stepTurn],
      queue: [],
    };
    const wiredRetry = render(
      <ThreadView
        {...panelProps}
        thread={threadRetryLast}
        channel={channel}
        onRetry={() => {}}
      />,
    );
    const turns = agentTurns(wiredRetry.container);
    expect(
      within(turns[turns.length - 1] as HTMLElement).getByRole("button", {
        name: "Retry",
      }),
    ).toBeTruthy();

    const wiredFocus = render(
      <FocusView
        {...focusProps}
        thread={{ ...thread, pr }}
        /* Live wiring (#114): the Workbench shows only with a host + folder. */
        work={{ ticket: "", title: "Envelope contract", path: "/tmp/repo-x" }}
        host={{
          tree: async () => ["a.txt"],
          diff: async () => [],
          read: async () => null,
          pr: async () => ({ pr, branch: "lil-1" }),
        }}
        onBack={() => {}}
        onNav={() => {}}
        onStart={() => {}}
        onStop={() => {}}
        onRetry={() => {}}
        onRewind={() => {}}
        onModel={() => {}}
        onUnqueue={() => {}}
        onSendQueued={() => {}}
        setResolved={() => {}}
        say={() => {}}
        models={[
          { id: "gpt-test-1", provider: "openai" },
          { id: "claude-test-2", provider: "anthropic" },
        ]}
        repoFiles={["README.md"]}
        onPrComment={() => {}}
        onPrMerge={() => {}}
      />,
    );
    const wf = within(wiredFocus.container);
    /* One "Rewind" hover trigger per user message (#134, moved to the row
       by #578) — the fixture thread has several, so any-of proves it. */
    expect(
      wf.getAllByRole("button", { name: /^Rewind$/ }).length,
    ).toBeGreaterThan(0);
    expect(wf.getByRole("button", { name: /gpt-test-1/ })).toBeTruthy();
    /* PR tab resolves async off the host probe, then its merge control shows. */
    const prTab = await wf.findByRole("tab", { name: /PR #12/ });
    fireEvent.click(prTab);
    await wf.findByRole("button", { name: /Squash and merge/ });
    expect(
      wiredFocus.container.querySelector('[title="Exit focus"]'),
    ).toBeTruthy();
  });
});

describe("issue #31 — images sent with the message show in the thread panel", () => {
  test("AC-1 the thread root's attachments render as chips (with a thumbnail) in the panel", () => {
    const withImage = {
      ...root,
      attachments: [
        {
          name: "shot.png",
          mediaType: "image/png",
          url: "data:image/png;base64,iVBORw0KGgo=",
        },
      ],
    };
    const { container } = render(
      <ThreadView {...panelProps} root={withImage} channel={dmChannel} />,
    );
    const chips = container.querySelector("[data-attachments]");
    expect(chips).toBeTruthy();
    expect(chips?.textContent).toContain("shot.png");
    expect(chips?.querySelector("img")?.getAttribute("alt")).toBe("shot.png");
  });
});

describe("issue #196 — a folder-less DM session is a plain chat", () => {
  /* The real DM page passes work={null} and no repo to the panel. */
  const dmPanelProps = { ...panelProps, repo: undefined } as const;
  const wsFolder: Workspace = {
    folder: "/repo",
    project: "repo",
    mode: "direct",
    base: "main",
    branch: "main",
    cwd: "/repo",
  };

  test("AC-2 Focus: no folder means no chip at all and a neutral hint", () => {
    const focus = render(
      <FocusView {...focusProps} channel={dmChannel} lead={BUILDER} />,
    );
    expect(focus.container.querySelector("[data-wsbadge]")).toBeNull();
    expect(focus.container.textContent).not.toMatch(/read-only/i);
    expect(focus.container.textContent).not.toContain("no git repo");
    expect(within(focus.container).getByText("Reply to Builder…")).toBeTruthy();
  });

  test("AC-2 Focus keeps today's folder surfaces: ws badge, branch chip, no-git-repo chip", () => {
    const ws = render(
      <FocusView
        {...focusProps}
        channel={dmChannel}
        thread={{ ...thread, ws: wsFolder }}
      />,
    );
    expect(ws.container.querySelector("[data-wsbadge]")).toBeTruthy();
    expect(ws.container.textContent).toContain("main");
    cleanup();
    const branch = render(
      <FocusView
        {...focusProps}
        channel={dmChannel}
        work={{ ticket: "", title: "t", path: "/repo", branch: "main" }}
      />,
    );
    expect(within(branch.container).getByText("main")).toBeTruthy();
    expect(
      within(branch.container).getByText("Edits go to ⎇ main"),
    ).toBeTruthy();
    cleanup();
    const plain = render(
      <FocusView
        {...focusProps}
        channel={dmChannel}
        work={{ ticket: "", title: "t", path: "/plain" }}
      />,
    );
    expect(within(plain.container).getByText("no git repo")).toBeTruthy();
  });

  test("AC-2 panel: no 'discussion' chip and a neutral hint for a no-folder session", () => {
    const dm = render(<ThreadView {...dmPanelProps} channel={dmChannel} />);
    expect(dm.container.querySelector("[data-wsbadge]")).toBeNull();
    expect(dm.container.textContent).not.toContain("discussion");
    expect(dm.container.textContent).not.toMatch(/read-only/i);
    expect(within(dm.container).getByText("Reply to Builder…")).toBeTruthy();
  });

  test("AC-2 a channel thread keeps the read-only chip and main hint", () => {
    const focus = render(<FocusView {...focusProps} />);
    expect(within(focus.container).getByText("read-only")).toBeTruthy();
    expect(within(focus.container).getByText("Read-only on main")).toBeTruthy();
    cleanup();
    const panel = render(<ThreadView {...panelProps} channel={channel} />);
    expect(within(panel.container).getByText(/main · read-only/)).toBeTruthy();
    expect(
      within(panel.container).getByText(
        "Read-only on main. Start work to edit code.",
      ),
    ).toBeTruthy();
  });
});
