import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AppMessage,
  Conversation,
  ConversationSummary,
  Employee,
  MessageSearchHit,
  ProfileSettings,
  SystemStatusResult,
  WorkbenchOpenTarget,
} from "@lilos/contracts/app";
import type { ViewerBrowserInputEvent } from "@lilos/contracts/harness";
import type { ForgePrListItem } from "@lilos/contracts/host";
import type {
  AppOps,
  BrowserDriver,
  PtyHandle,
  PtySpawner,
  PtySpawnOptions,
} from "../src/index.js";

export class FakePty implements PtyHandle {
  written: string[] = [];
  cols: number;
  rows: number;
  killed = false;
  constructor(
    opts: PtySpawnOptions,
    private onData: (b: Uint8Array) => void,
    private onExit: (code: number) => void,
    private shellMode = false,
  ) {
    this.cols = opts.cols;
    this.rows = opts.rows;
  }
  write(data: string): void {
    this.written.push(data);
    // shellMode emulates bash: echo the input, then run the marker printf so
    // a pending terminal_run resolves with exit 0 and empty output.
    const m = this.shellMode ? /__LILOS_DONE_(\d+)__/.exec(data) : null;
    if (m) {
      const marker = `__LILOS_DONE_${m[1]}__`;
      queueMicrotask(() => this.emit(`${data}\n${marker}0\n`));
    }
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  kill(): void {
    this.killed = true;
  }
  /** Test helper: push PTY output. */
  emit(text: string) {
    this.onData(new TextEncoder().encode(text));
  }
  /** Test helper: the shell exits (`exit`, SIGHUP, ...). */
  exit(code = 0) {
    this.onExit(code);
  }
}

export class FakePtySpawner {
  instances: FakePty[] = [];
  constructor(private shellMode = false) {}
  readonly spawn: PtySpawner = (opts, onData, onExit) => {
    const p = new FakePty(opts, onData, onExit, this.shellMode);
    this.instances.push(p);
    return p;
  };
  get last(): FakePty {
    const p = this.instances[this.instances.length - 1];
    if (!p) throw new Error("no pty spawned");
    return p;
  }
}

export class FakeBrowser implements BrowserDriver {
  url: string | null = null;
  title = "";
  text = "";
  viewport = { width: 1280, height: 800 };
  casting = false;
  closed = false;
  clicks: string[] = [];
  inputs: ViewerBrowserInputEvent[] = [];
  evals: string[] = [];
  evalResult: unknown = null;
  private frameCbs: ((jpeg: Uint8Array) => void)[] = [];
  private urlCbs: ((url: string) => void)[] = [];

  async open(url: string) {
    this.url = url;
    this.title = `title:${url}`;
    this.text = `text of ${url}`;
    for (const cb of this.urlCbs) cb(url);
    return { url, title: this.title };
  }
  async click(selector: string) {
    this.clicks.push(selector);
  }
  async type(text: string, _selector?: string) {
    this.text += text;
  }
  async read() {
    return {
      url: this.url ?? "about:blank",
      title: this.title,
      text: this.text,
    };
  }
  async scroll(_dy: number) {}
  async evaluate(expression: string) {
    this.evals.push(expression);
    return this.evalResult;
  }
  input(evt: ViewerBrowserInputEvent): void {
    this.inputs.push(evt);
  }
  navigate(url: string): void {
    this.url = url;
    for (const cb of this.urlCbs) cb(url);
  }
  async resize(size: { width: number; height: number }): Promise<void> {
    this.viewport = { ...size };
  }
  setCasting(on: boolean): void {
    this.casting = on;
  }
  onFrame(cb: (jpeg: Uint8Array) => void): void {
    this.frameCbs.push(cb);
  }
  onUrl(cb: (url: string) => void): void {
    this.urlCbs.push(cb);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  pushFrame(bytes: number[] = [0xff, 0xd8]) {
    const jpeg = new Uint8Array(bytes);
    for (const cb of this.frameCbs) cb(jpeg);
  }
}

export function fakeAppOps(
  initial: AppMessage[] = [],
  opts: {
    /** The bound thread's id — the scope's binding.conversationId. */
    conversationId?: string;
    channelId?: string;
    /** Extra threads in this DM (the bound one is always seeded). */
    conversations?: Conversation[];
    employees?: Employee[];
    /** Per-conversation PR rows (`forge.prs` answers). */
    prs?: Record<string, ForgePrListItem[]>;
    /** `"user"` makes `thread_set_title` answer `user_title` (#137). */
    titleSource?: "auto" | "user";
    status?: SystemStatusResult;
    profile?: ProfileSettings;
  } = {},
): AppOps & {
  posted: string[];
  titled: string[];
  opened: WorkbenchOpenTarget[];
} {
  const posted: string[] = [];
  const titled: string[] = [];
  const opened: WorkbenchOpenTarget[] = [];
  const messages = [...initial];
  const convId = opts.conversationId ?? "conv1";
  const channelId = opts.channelId ?? "c1";
  const bound: Conversation = {
    id: convId,
    channelId,
    rootMessageId: "m1",
    engineRef: "eng-fake",
    state: "active",
    title: `Thread ${convId}`,
    titleSource: opts.titleSource ?? "auto",
    archived: false,
    deliveredSeq: 0,
    createdAt: 1,
  };
  const convs: Conversation[] = [bound, ...(opts.conversations ?? [])];
  const employees: Employee[] = opts.employees ?? [
    {
      id: "emp-fake",
      name: "Ada",
      role: "Engineer",
      status: "online",
      profile: "default",
      model: "fake-1",
      now: "DM tools",
      instructions: "",
      respondTo: "me",
      createdAt: 1,
    },
  ];
  const status: SystemStatusResult = opts.status ?? {
    protocolVersion: 1,
    generatedAt: 1,
    components: ["relay", "harness", "engine", "model"].map((id) => ({
      id: id as "relay" | "harness" | "engine" | "model",
      label: id,
      state: "ok" as const,
      reason: "",
    })),
    versions: { relay: "0.0.0-test", relayProtocol: 1 },
  };
  const profile: ProfileSettings = opts.profile ?? { userName: "Oscar" };
  return {
    posted,
    titled,
    opened,
    async postMessage(text: string) {
      posted.push(text);
      const msg = {
        id: `m${messages.length + 1}`,
        channelId,
        conversationId: convId,
        seq: messages.length + 1,
        authorId: "agent",
        authorKind: "employee" as const,
        text,
        rewound: false,
        dropped: false,
        removed: false,
        createdAt: Date.now(),
      } satisfies AppMessage;
      messages.push(msg);
      return msg;
    },
    async readConversation(o?: { conversationId?: string; afterSeq?: number }) {
      return messages.filter(
        (m) =>
          (!o?.conversationId || m.conversationId === o.conversationId) &&
          (o?.afterSeq === undefined || m.seq > o.afterSeq),
      );
    },
    async listThreads() {
      return convs;
    },
    async threadSummaries(): Promise<ConversationSummary[]> {
      return convs.map((conversation) => {
        const inThread = messages.filter(
          (m) => m.conversationId === conversation.id,
        );
        const root: AppMessage = inThread[0] ?? {
          id: `${conversation.id}-root`,
          channelId: conversation.channelId,
          conversationId: conversation.id,
          seq: 1,
          authorId: "user",
          authorKind: "user",
          text: conversation.rootMessageId,
          rewound: false,
          createdAt: conversation.createdAt,
        };
        const last = inThread.at(-1) ?? root;
        return {
          conversation,
          root,
          last,
          messageCount: Math.max(inThread.length, 1),
        };
      });
    },
    async employees() {
      return employees;
    },
    async threadPrs(conversationId: string) {
      return opts.prs?.[conversationId] ?? [];
    },
    async searchMessages(
      query: string,
      limit = 50,
    ): Promise<MessageSearchHit[]> {
      const q = query.toLowerCase();
      return messages
        .filter((m) => m.text.toLowerCase().includes(q))
        .slice(0, limit)
        .map((m) => ({
          messageId: m.id,
          conversationId: m.conversationId,
          channelId: m.channelId,
          authorId: m.authorId,
          snippet: m.text.slice(0, 120),
          createdAt: m.createdAt,
        }));
    },
    async setThreadTitle(title: string) {
      titled.push(title);
      // The relay-side guard (#137): a user-typed title always wins.
      if (bound.titleSource === "user") {
        return { outcome: "user_title" as const, title: bound.title };
      }
      bound.title = title;
      return { outcome: "set" as const, title };
    },
    async status() {
      return status;
    },
    async profile() {
      return profile;
    },
    async openWorkbench(target: WorkbenchOpenTarget) {
      opened.push(target);
    },
  };
}

/**
 * The real agent gateway (gatewayHandler + SessionRegistry) over a node
 * server — what the harness mounts. Each registered session gets its own
 * scope, token and optional engine-session alias. Returns the base URL +
 * the registry for assertions and alias binding.
 */
export async function serveGateway(opts: {
  sessions: Array<{
    scope: import("../src/index.js").ViewerScope;
    token?: string;
    engineSessionId?: string;
  }>;
}) {
  const { SessionRegistry, gatewayHandler } = await import("../src/index.js");
  const registry = new SessionRegistry();
  for (const s of opts.sessions) {
    registry.add(s.scope, {
      token: s.token,
      engineSessionId: s.engineSessionId,
    });
  }
  const handler = gatewayHandler(registry);
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const request = new Request(`http://x${req.url}`, {
      method: req.method,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)]),
      ),
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const out = await handler(request);
    if (!out) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { server, registry, baseUrl: `http://127.0.0.1:${port}` };
}
