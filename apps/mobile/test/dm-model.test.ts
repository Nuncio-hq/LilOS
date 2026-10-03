import type {
  AppMessage,
  Ask,
  Conversation,
  ConversationSummary,
  RecentFolder,
} from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import {
  askApproval,
  conversationState,
  defaultModelPick,
  defaultWorkspacePick,
  folderLeaf,
  headerStatus,
  openConversationParams,
  timeLabel,
  toFolderOptions,
  toModelCatalog,
  toSessionTurns,
} from "../src/dm-model";

/* dm-model maps the relay's ConversationSummary rows (+ open asks, pending
   sends) onto the ui-native DM list: Needs you / Working / Done. Pure module —
   every rule below is pinned by a test. */

const T0 = Date.parse("2026-09-29T12:00:00Z");

const msg = (id: string, over: Partial<AppMessage> = {}): AppMessage => ({
  id,
  channelId: "ch-dm",
  authorId: "user",
  conversationId: null,
  authorKind: "user",
  text: "",
  seq: 1,
  createdAt: T0,
  rewound: false,
  dropped: false,
  removed: false,
  ...over,
});

const conv = (id: string, over: Partial<Conversation> = {}): Conversation => ({
  id,
  channelId: "ch-dm",
  rootMessageId: `${id}-root`,
  engineRef: `sess-${id}`,
  state: "idle",
  title: "",
  titleSource: "auto",
  access: "ask",
  archived: false,
  deliveredSeq: 0,
  createdAt: T0,
  ...over,
});

const summary = (
  id: string,
  over: Partial<Conversation> = {},
  m: Partial<{
    root: Partial<AppMessage>;
    firstAnswer: Partial<AppMessage>;
    last: Partial<AppMessage>;
    messageCount: number;
  }> = {},
): ConversationSummary => {
  const c = conv(id, over);
  return {
    conversation: c,
    root: msg(`${id}-root`, {
      conversationId: id,
      text: "do the thing",
      ...m.root,
    }),
    ...(m.firstAnswer
      ? {
          firstAnswer: msg(`${id}-a1`, {
            conversationId: id,
            authorKind: "employee",
            authorId: "builder",
            text: "on it",
            ...m.firstAnswer,
          }),
        }
      : {}),
    last: msg(`${id}-last`, {
      conversationId: id,
      authorKind: "employee",
      authorId: "builder",
      text: "on it",
      ...m.last,
    }),
    messageCount: m.messageCount ?? 2,
  };
};

const ask = (id: string, over: Partial<Ask> = {}): Ask => ({
  id,
  channelId: "ch-dm",
  conversationId: "c1",
  turnId: "t1",
  requestId: "r1",
  request: { kind: "approval", command: "rm -rf tmp", options: ["once"] },
  state: "open",
  createdAt: T0,
  ...over,
});

const CTX = {
  channelId: "ch-dm",
  employee: { id: "builder", name: "Builder", tone: "blue" as const },
  openAsks: [] as Ask[],
  pending: new Map<string, { conversation: Conversation; root: AppMessage }>(),
  now: T0,
};

describe("AC-1: threads come from conversations.summaries for the DM channel, grouped by state", () => {
  it("AC-1 keeps only the DM channel's conversations, oldest first (the screen reverses per group)", () => {
    const turns = toSessionTurns(
      [
        summary("new", {}, { last: { createdAt: T0 } }),
        summary("other-channel", { channelId: "ch-other" }),
        summary("old", {}, { last: { createdAt: T0 - 3_600_000 } }),
      ],
      CTX,
    );
    expect(turns.map((t) => t.id)).toEqual(["old", "new"]);
  });

  it("AC-1 maps wire state + open asks + pending sends to list groups", () => {
    const open = ask("ask-1", { conversationId: "c-ask" });
    const turns = toSessionTurns(
      [
        summary("c-ask", { state: "active" }),
        summary("c-run", { state: "active" }),
        summary("c-done", { state: "idle" }),
        summary("c-closed", { state: "closed" }),
      ],
      { ...CTX, openAsks: [open] },
    );
    expect(turns.map((t) => [t.id, t.state])).toEqual([
      ["c-ask", "needs-you"],
      ["c-run", "working"],
      ["c-done", "done"],
      ["c-closed", "done"],
    ]);
  });

  it("AC-1 shows a freshly opened conversation as Working before its summary lands", () => {
    const opened = conv("c-new", { engineRef: null });
    const root = msg("c-new-root", {
      conversationId: "c-new",
      text: "hello",
    });
    const turns = toSessionTurns([], {
      ...CTX,
      pending: new Map([["c-new", { conversation: opened, root }]]),
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.id).toBe("c-new");
    expect(turns[0]?.state).toBe("working");
    expect(turns[0]?.title).toBe("hello");
  });

  it("AC-1 carries title, last words, folder and reply count on the row", () => {
    const turns = toSessionTurns(
      [
        summary(
          "c1",
          { title: "Fix the flapper", cwd: "~/Desktop/LilOS" },
          {
            root: { text: "please fix" },
            last: { authorKind: "employee", text: "fixed it" },
            messageCount: 4,
          },
        ),
      ],
      CTX,
    );
    const t = turns[0];
    expect(t?.title).toBe("Fix the flapper");
    expect(t?.prompt).toBe("please fix");
    expect(t?.preview).toBe("fixed it");
    expect(t?.folder).toBe("LilOS");
    expect(t?.replies).toBe(3);
  });
});

describe("AC-2: header status counts threads needing you", () => {
  it('AC-2 reads "N need you", else "Working on N", else "Idle"', () => {
    const st = (state: string) => ({ state });
    expect(headerStatus([])).toBe("Idle");
    expect(headerStatus([st("done"), st("done")])).toBe("Idle");
    expect(headerStatus([st("needs-you")])).toBe("1 needs you");
    expect(headerStatus([st("needs-you"), st("needs-you")])).toBe("2 need you");
    expect(headerStatus([st("working")])).toBe("Working");
    expect(headerStatus([st("working"), st("working")])).toBe("Working on 2");
    // needs-you wins over working
    expect(headerStatus([st("working"), st("needs-you")])).toBe("1 needs you");
  });
});

describe("AC-3: send opens a new conversation with the picked folder + model", () => {
  it("AC-3 stamps cwd + the full model pick on conversations.open params", () => {
    const folders = toFolderOptions([
      { path: "~/Desktop/LilOS", lastUsedAt: 1 },
    ]);
    const params = openConversationParams({
      workspace: { folder: "~/Desktop/LilOS", base: "", mode: "direct" },
      folders,
      model: { model: "fake-large", effort: "high", fast: true },
      models: [
        {
          id: "fake-large",
          name: "Fake Large",
          provider: "fake",
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
          fast: true,
        },
      ],
    });
    expect(params).toEqual({
      cwd: "~/Desktop/LilOS",
      model: "fake-large",
      provider: "fake",
      effort: "high",
      fast: true,
    });
  });

  it("AC-3 sends no cwd for just-chat and omits unset model fields", () => {
    const params = openConversationParams({
      workspace: { folder: null, base: "", mode: "direct" },
      folders: [],
      model: { model: "fake-small" },
      models: [{ id: "fake-small", name: "Fake Small", provider: "fake" }],
    });
    expect(params).toEqual({ model: "fake-small", provider: "fake" });
  });

  it("AC-3 drops a pick whose folder is not in the recents list", () => {
    const params = openConversationParams({
      workspace: { folder: "/gone", base: "", mode: "direct" },
      folders: toFolderOptions([{ path: "/elsewhere", lastUsedAt: 1 }]),
    });
    expect(params.cwd).toBeUndefined();
  });
});

describe("AC-4: folder picker lists real folders + the three workspace modes", () => {
  const recents: RecentFolder[] = [
    { path: "~/Desktop/Work/LilOS", lastUsedAt: 20 },
    { path: "~/Documents/Notes", lastUsedAt: 10 },
  ];
  const repoDetail = {
    path: "~/Desktop/Work/LilOS",
    missing: false,
    isRepo: true,
    root: "~/Desktop/Work/LilOS",
    current: "main",
    branches: ["main", "feat/x", "ws/feat-x"],
    workstreams: [
      {
        branch: "ws/qr-7",
        path: "~/Desktop/Work/LilOS/.lilos/wt/qr-7",
        from: "main",
      },
    ],
  };
  const nonRepoDetail = {
    path: "~/Documents/Notes",
    missing: false,
    isRepo: false,
    branches: [],
    workstreams: [],
  };

  it("AC-4 marks recents probing until folders.detail lands, then fills branches + workstreams", () => {
    // No detail yet: rows render the "Checking git…" state, nothing offered.
    expect(toFolderOptions(recents)).toEqual([
      {
        id: "~/Desktop/Work/LilOS",
        project: "LilOS",
        path: "~/Desktop/Work/LilOS",
        probing: true,
        branches: [],
        workstreams: [],
      },
      {
        id: "~/Documents/Notes",
        project: "Notes",
        path: "~/Documents/Notes",
        probing: true,
        branches: [],
        workstreams: [],
      },
    ]);
    const folders = toFolderOptions(recents, {
      "~/Desktop/Work/LilOS": repoDetail,
      "~/Documents/Notes": nonRepoDetail,
    });
    expect(folders[0]?.probing).toBeUndefined();
    expect(folders[0]?.branches).toEqual(["main", "feat/x", "ws/feat-x"]);
    expect(folders[0]?.workstreams).toEqual([
      {
        branch: "ws/qr-7",
        path: "~/Desktop/Work/LilOS/.lilos/wt/qr-7",
        from: "main",
      },
    ]);
    // A resolved non-repo just offers direct mode (empty lists, no probing).
    expect(folders[1]?.probing).toBeUndefined();
    expect(folders[1]?.branches).toEqual([]);
  });

  it("AC-4 pre-selects the last session's folder once known", () => {
    const folders = toFolderOptions(
      [
        { path: "/a", lastUsedAt: 2 },
        { path: "/b", lastUsedAt: 1 },
      ],
      {
        "/a": { ...nonRepoDetail, path: "/a" },
        "/b": { ...repoDetail, path: "/b" },
      },
    );
    // A repo defaults to a new workstream off its first branch (prototype).
    expect(defaultWorkspacePick(folders, "/b")).toEqual({
      folder: "/b",
      base: "main",
      mode: "new",
    });
    expect(defaultWorkspacePick(folders, "/not-a-recent")).toEqual({
      folder: null,
      base: "",
      mode: "direct",
    });
    expect(defaultWorkspacePick(folders, undefined)).toEqual({
      folder: null,
      base: "",
      mode: "direct",
    });
  });

  it("AC-4 mode new stamps a ws/<slug> branch + .lilos/wt dir from the first message", () => {
    const folders = toFolderOptions(recents, {
      "~/Desktop/Work/LilOS": repoDetail,
    });
    expect(
      openConversationParams({
        workspace: {
          folder: "~/Desktop/Work/LilOS",
          base: "main",
          mode: "new",
        },
        folders,
        text: "Fix the login redirect",
      }),
    ).toEqual({
      cwd: "~/Desktop/Work/LilOS/.lilos/wt/fix-login",
      workspace: {
        mode: "new",
        repoPath: "~/Desktop/Work/LilOS",
        branch: "ws/fix-login",
        base: "main",
      },
    });
  });

  it("AC-4 mode new dedupes the slug against live workstreams and branches", () => {
    const folders = toFolderOptions(recents, {
      "~/Desktop/Work/LilOS": repoDetail,
    });
    // "qr 7" → slug qr-7: the .lilos/wt/qr-7 dir AND the ws/qr-7 branch exist.
    expect(
      openConversationParams({
        workspace: {
          folder: "~/Desktop/Work/LilOS",
          base: "main",
          mode: "new",
        },
        folders,
        text: "qr 7 please",
      }),
    ).toMatchObject({
      cwd: "~/Desktop/Work/LilOS/.lilos/wt/qr-7-1",
      workspace: { mode: "new", branch: "ws/qr-7-1" },
    });
    // A name colliding only with an existing ws/* branch dedupes too.
    expect(
      openConversationParams({
        workspace: {
          folder: "~/Desktop/Work/LilOS",
          base: "main",
          mode: "new",
        },
        folders,
        text: "feat x more",
      }).cwd,
    ).toBe("~/Desktop/Work/LilOS/.lilos/wt/feat-x-1");
  });

  it("AC-4 mode existing starts the thread in the picked worktree", () => {
    const folders = toFolderOptions(recents, {
      "~/Desktop/Work/LilOS": repoDetail,
    });
    expect(
      openConversationParams({
        workspace: {
          folder: "~/Desktop/Work/LilOS",
          base: "main",
          mode: "existing",
          existing: "ws/qr-7",
        },
        folders,
        text: "keep going",
      }),
    ).toEqual({
      cwd: "~/Desktop/Work/LilOS/.lilos/wt/qr-7",
      workspace: {
        mode: "existing",
        repoPath: "~/Desktop/Work/LilOS",
        branch: "ws/qr-7",
      },
    });
  });

  it("AC-4 mode direct lands cwd on the checkout; a stale pick degrades honestly", () => {
    const folders = toFolderOptions(recents, {
      "~/Desktop/Work/LilOS": repoDetail,
    });
    expect(
      openConversationParams({
        workspace: {
          folder: "~/Desktop/Work/LilOS",
          base: "feat/x",
          mode: "direct",
        },
        folders,
      }),
    ).toEqual({ cwd: "~/Desktop/Work/LilOS" });
    // "new" picked while git was still probing (no branches yet) → direct.
    expect(
      openConversationParams({
        workspace: {
          folder: "~/Desktop/Work/LilOS",
          base: "",
          mode: "new",
        },
        folders: toFolderOptions(recents),
        text: "hi",
      }),
    ).toEqual({ cwd: "~/Desktop/Work/LilOS" });
    // "existing" on a workstream that vanished → direct, not a dead path.
    expect(
      openConversationParams({
        workspace: {
          folder: "~/Desktop/Work/LilOS",
          base: "main",
          mode: "existing",
          existing: "ws/gone",
        },
        folders,
      }),
    ).toEqual({ cwd: "~/Desktop/Work/LilOS" });
    // A missing folder can't carry a cwd at all → just chat.
    expect(
      openConversationParams({
        workspace: {
          folder: "~/Documents/Notes",
          base: "",
          mode: "direct",
        },
        folders: toFolderOptions(recents, {
          "~/Documents/Notes": { ...nonRepoDetail, missing: true },
        }),
      }),
    ).toEqual({});
  });

  it("AC-4 a workstream thread row labels the repo + its ws/ branch", () => {
    const turns = toSessionTurns(
      [
        summary("c-ws", {
          cwd: "~/Desktop/Work/LilOS/.lilos/wt/fix-login",
          workspace: {
            mode: "new",
            repoPath: "~/Desktop/Work/LilOS",
            branch: "ws/fix-login",
            base: "main",
          },
        }),
      ],
      CTX,
    );
    expect(turns[0]?.folder).toBe("LilOS");
    expect(turns[0]?.branch).toBe("ws/fix-login");
  });
});

describe("AC-5: an empty DM renders the empty-thread state", () => {
  it("AC-5 yields no rows and an Idle header when the channel has no threads", () => {
    const turns = toSessionTurns([], CTX);
    expect(turns).toEqual([]);
    expect(headerStatus(turns)).toBe("Idle");
  });
});

describe("dm-model helpers", () => {
  it("conversationState prefers an open ask over running work", () => {
    const c = conv("c1", { state: "active" });
    const none = { openAsks: [] as Ask[], pending: new Set<string>() };
    expect(conversationState(c, none)).toBe("working");
    expect(
      conversationState(c, {
        ...none,
        openAsks: [ask("a", { conversationId: "c1" })],
      }),
    ).toBe("needs-you");
    // resolved asks stop counting
    expect(
      conversationState(c, {
        ...none,
        openAsks: [ask("a", { conversationId: "c1", state: "resolved" })],
      }),
    ).toBe("working");
    expect(conversationState(c, { ...none, pending: new Set(["c1"]) })).toBe(
      "working",
    );
    expect(conversationState(conv("c1", { state: "idle" }), none)).toBe("done");
  });

  it("askApproval renders an approval ask as the row's reason", () => {
    const approval = askApproval(ask("a1"), {
      employeeId: "builder",
      employee: "Builder",
      tone: "blue",
      session: "Fix the flapper",
      now: T0,
    });
    expect(approval.reason).toBe("rm -rf tmp");
    expect(approval.command).toBe("rm -rf tmp");
    expect(approval.session).toBe("Fix the flapper");
    expect(approval.employee).toBe("Builder");
  });

  it("askApproval's reason is the command even with a description, and reads questions", () => {
    const a = ask("a1", {
      request: {
        kind: "approval",
        command: "rm -rf tmp",
        description: "terminal wants to run: rm -rf tmp",
        options: ["once"],
      },
    });
    expect(
      askApproval(a, {
        employeeId: "builder",
        employee: "Builder",
        tone: "blue",
        session: "s",
        now: T0,
      }).reason,
    ).toBe("rm -rf tmp");
    const q = ask("a2", {
      request: { kind: "question", question: "Ship it?" },
    });
    expect(
      askApproval(q, {
        employeeId: "builder",
        employee: "Builder",
        tone: "blue",
        session: "s",
        now: T0,
      }).reason,
    ).toBe("Ship it?");
  });

  it("toModelCatalog maps the engine catalog to picker rows", () => {
    const { models, providers } = toModelCatalog({
      models: [
        {
          id: "fake-large",
          name: "Fake Large",
          provider: "fake",
          efforts: ["low", "high"],
          defaultEffort: "low",
          fast: true,
          contextWindow: 262_000,
        },
        { id: "bare" },
      ],
      providers: [{ id: "fake", name: "Fake Engine" }],
    });
    expect(models).toEqual([
      {
        id: "fake-large",
        name: "Fake Large",
        provider: "fake",
        efforts: ["low", "high"],
        defaultEffort: "low",
        fast: true,
        // #294: the engine-reported window reaches the phone's meter too.
        contextWindow: 262_000,
      },
      { id: "bare", name: "bare", provider: "" },
    ]);
    expect(providers).toEqual([
      { id: "fake", name: "Fake Engine", logo: undefined },
    ]);
  });

  it("defaultModelPick prefers the employee's model, then the engine default", () => {
    const models = [
      {
        id: "a",
        name: "A",
        provider: "p",
        efforts: ["low", "high"],
        defaultEffort: "low",
      },
      { id: "b", name: "B", provider: "p" },
    ];
    expect(
      defaultModelPick({ employeeModel: "b", models, defaultModel: "a" }),
    ).toEqual({ model: "b", provider: "p" });
    expect(
      defaultModelPick({ employeeModel: "", models, defaultModel: "a" }),
    ).toEqual({ model: "a", provider: "p", effort: "low" });
    // employee model not in the catalog still sends (engine resolves it)
    expect(defaultModelPick({ employeeModel: "elsewhere", models })).toEqual({
      model: "elsewhere",
    });
    expect(defaultModelPick({ models: [] })).toBeUndefined();
  });

  it("folderLeaf takes the last path segment", () => {
    expect(folderLeaf("~/Desktop/LilOS")).toBe("LilOS");
    expect(folderLeaf("/a/b/c")).toBe("c");
    expect(folderLeaf("/a/b/")).toBe("b");
    expect(folderLeaf("~")).toBe("~");
    expect(folderLeaf("")).toBe("");
  });

  it("timeLabel compacts recency for list rows", () => {
    const at = (msAgo: number) => T0 - msAgo;
    expect(timeLabel(at(5_000), T0)).toBe("now");
    expect(timeLabel(at(4 * 60_000), T0)).toBe("4m");
    expect(timeLabel(at(3 * 3_600_000), T0)).toBe("3h");
    expect(timeLabel(at(3 * 86_400_000), T0)).toBe("Sat");
    expect(timeLabel(at(40 * 86_400_000), T0)).toBe("Aug 20");
    expect(timeLabel(T0 + 60_000, T0)).toBe("now"); // future clamps to now
  });
});
