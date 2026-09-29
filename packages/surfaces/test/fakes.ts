import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppMessage } from "@lilos/contracts/app";
import type { ViewerBrowserInputEvent } from "@lilos/contracts/harness";
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

export function fakeAppOps(initial: AppMessage[] = []): AppOps & {
  posted: string[];
} {
  const posted: string[] = [];
  const messages = [...initial];
  return {
    posted,
    async postMessage(text: string) {
      posted.push(text);
      const msg = {
        id: `m${messages.length + 1}`,
        channelId: "c1",
        conversationId: "conv1",
        seq: messages.length + 1,
        authorId: "agent",
        authorKind: "employee" as const,
        text,
        rewound: false,
        createdAt: Date.now(),
      } satisfies AppMessage;
      messages.push(msg);
      return msg;
    },
    async readConversation(afterSeq?: number) {
      return afterSeq ? messages.filter((m) => m.seq > afterSeq) : messages;
    },
  };
}

/**
 * The real HTTP tool API (toolApiHandler) over a node server — what the
 * harness mounts. Returns the base URL + parts for assertions.
 */
export async function serveToolApi(opts: {
  session: string;
  token: string;
  scope:
    | import("../src/index.js").SurfaceBackend
    | Map<string, import("../src/index.js").SurfaceBackend>;
}) {
  const { SESSION_HEADER, toolApiHandler } = await import("../src/index.js");
  const handler = toolApiHandler(
    {
      scopeFor: (s: string) => {
        if (opts.scope instanceof Map) return opts.scope.get(s) ?? null;
        return s === opts.session || opts.session === "*" ? opts.scope : null;
      },
    },
    {
      scopeFor: (req: Request) =>
        req.headers.get("authorization") === `Bearer ${opts.token}`
          ? req.headers.get(SESSION_HEADER)
          : null,
    },
  );
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
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}
