import type { AppMessage } from "@lilos/contracts/app";
import type { ViewerBrowserInputEvent } from "@lilos/contracts/harness";
import {
  SurfaceError,
  type ViewerScope,
  type ViewerScopeEvent,
  type ViewerSnapshot,
} from "./backend.js";
import type {
  AppOps,
  BrowserDriver,
  PtyHandle,
  PtySpawner,
  SurfaceScopeOptions,
} from "./drivers.js";
import { PreviewScanner, stripAnsi } from "./previews.js";

/**
 * Runtime-neutral session ownership logic spike #24 proved out; drivers are
 * injected (`./drivers.js`):
 *
 * - PTY bytes append to a bounded scrollback ring and feed the preview scanner.
 * - Screencast runs only while viewerCount > 0 (cast only while watched).
 * - The PTY respawns itself on exit (`exit` must not kill the session).
 */

const MARKER_PREFIX = "__LILOS_DONE_";
const DEFAULT_RUN_TIMEOUT_MS = 30_000;

export class SessionSurfaces implements ViewerScope {
  readonly session: string;

  private readonly spawnPty: PtySpawner;
  private readonly createBrowser?: () => Promise<BrowserDriver>;
  private readonly appOps?: AppOps;
  private readonly cwd: string;
  private readonly cols: number;
  private readonly rows: number;
  private readonly tailCap: number;
  private readonly runTimeout: number;

  private browser?: BrowserDriver;
  private browserPromise?: Promise<BrowserDriver>;
  private pty?: PtyHandle;
  private readonly scanner = new PreviewScanner();
  private readonly listeners = new Set<(e: ViewerScopeEvent) => void>();
  /** Internal taps (terminal_run capture) — do NOT count as viewers. */
  private readonly termTaps = new Set<(b: Uint8Array) => void>();
  private readonly tail: Uint8Array[] = [];
  private tailSize = 0;
  private lastFrame: Uint8Array | null = null;
  private runCounter = 0;
  private closed = false;

  constructor(opts: SurfaceScopeOptions) {
    this.session = opts.session;
    this.cwd = opts.cwd;
    this.spawnPty = opts.spawnPty;
    this.createBrowser = opts.createBrowser;
    this.appOps = opts.appOps;
    this.cols = opts.cols ?? 110;
    this.rows = opts.rows ?? 28;
    this.tailCap = opts.termTailBytes ?? 400 * 1024;
    this.runTimeout = opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.spawnTerm();
  }

  /* ------------------------------ PTY lifecycle ---------------------------- */

  private spawnTerm() {
    this.pty = this.spawnPty(
      { cols: this.cols, rows: this.rows, cwd: this.cwd },
      (chunk) => this.onTermData(chunk),
      () => {
        // Spike finding 5: `exit` kills the shell — respawn so the terminal
        // keeps working instead of wedging the session.
        if (!this.closed) this.spawnTerm();
      },
    );
  }

  private onTermData(chunk: Uint8Array) {
    this.tail.push(chunk);
    this.tailSize += chunk.length;
    while (this.tailSize > this.tailCap && this.tail.length > 0) {
      this.tailSize -= this.tail[0].length;
      this.tail.shift();
    }
    const found = this.scanner.feed(new TextDecoder().decode(chunk));
    if (found) this.emit({ kind: "previews", previews: found });
    for (const t of [...this.termTaps]) t(chunk);
    this.emit({ kind: "term", data: chunk });
  }

  /* ------------------------------ viewers ---------------------------------- */

  get viewerCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: (e: ViewerScopeEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.browser?.setCasting(true);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.browser?.setCasting(false);
    };
  }

  snapshot(): ViewerSnapshot {
    return {
      page: this.browser?.viewport ?? { width: 1280, height: 800 },
      terminal: { cols: this.cols, rows: this.rows },
      url: this.browser?.url ?? null,
      previews: this.scanner.list(),
      lastFrame: this.lastFrame,
      termTail:
        this.tail.length === 0 ? new Uint8Array() : concatTail(this.tail),
    };
  }

  private emit(e: ViewerScopeEvent) {
    for (const l of [...this.listeners]) l(e);
  }

  private activity(
    tool: string,
    status: "started" | "completed" | "failed",
    summary: string,
  ) {
    this.emit({ kind: "activity", tool, status, summary, at: Date.now() });
  }

  private async tracked<T>(
    tool: string,
    summary: string,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    this.activity(tool, "started", summary);
    try {
      const r = await fn();
      this.activity(tool, "completed", summary);
      return r;
    } catch (e) {
      this.activity(tool, "failed", summary);
      throw e;
    }
  }

  /* ------------------------------ browser ops ------------------------------- */

  private async requireBrowser(): Promise<BrowserDriver> {
    if (this.browser) return this.browser;
    if (!this.createBrowser)
      throw new SurfaceError(
        "unavailable",
        "no browser attached to this session's surfaces",
      );
    this.browserPromise ??= this.createBrowser().then((b) => {
      b.onFrame((jpeg) => {
        this.lastFrame = jpeg;
        this.emit({ kind: "frame", jpeg, capturedAt: Date.now() });
      });
      b.onUrl((url) => this.emit({ kind: "url", url }));
      if (this.listeners.size > 0) b.setCasting(true);
      this.browser = b;
      return b;
    });
    this.browserPromise.catch(() => {
      this.browserPromise = undefined;
    });
    return this.browserPromise;
  }

  browserOpen(p: { url: string }) {
    return this.tracked("browser_open", p.url, async () => {
      const b = await this.requireBrowser();
      return b.open(p.url);
    });
  }
  browserClick(p: { selector: string }) {
    return this.tracked("browser_click", p.selector, async () => {
      const b = await this.requireBrowser();
      await b.click(p.selector);
      return { ok: true as const };
    });
  }
  browserType(p: { selector?: string; text: string }) {
    return this.tracked(
      "browser_type",
      p.selector ? `${p.selector} "${p.text}"` : `"${p.text}"`,
      async () => {
        const b = await this.requireBrowser();
        await b.type(p.text, p.selector);
        return { ok: true as const };
      },
    );
  }
  browserRead() {
    return this.tracked("browser_read", "", async () => {
      const b = await this.requireBrowser();
      return b.read();
    });
  }
  browserScroll(p: { dy: number }) {
    return this.tracked("browser_scroll", `dy=${p.dy}`, async () => {
      const b = await this.requireBrowser();
      await b.scroll(p.dy);
      return { ok: true as const };
    });
  }
  browserEval(p: { expression: string }) {
    return this.tracked("browser_eval", p.expression, async () => {
      const b = await this.requireBrowser();
      return { value: await b.evaluate(p.expression) };
    });
  }

  /* ------------------------------ terminal ops ------------------------------ */

  /**
   * Marker capture (spike finding 4): the command line echoes inside the PTY
   * stream, so the marker text appears twice — take the LAST marker and treat
   * everything between the sent line's echo and it as the command's output.
   */
  terminalRun(p: { command: string; timeoutMs?: number }) {
    const id = ++this.runCounter;
    const marker = `${MARKER_PREFIX}${id}__`;
    const timeout = p.timeoutMs ?? this.runTimeout;
    return this.tracked("terminal_run", p.command, () =>
      this.runMarked(
        `${p.command}\nprintf '${marker}%s\\n' "$?"\n`,
        marker,
        timeout,
      ),
    );
  }

  private runMarked(
    sentText: string,
    marker: string,
    timeoutMs: number,
  ): Promise<{ output: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const decoder = new TextDecoder();
      let buf = "";
      const listener = (data: Uint8Array) => {
        buf += decoder.decode(data, { stream: true });
        // last match wins: the sent line echoes the marker literally first
        const idx = buf.lastIndexOf(marker);
        if (idx < 0) return;
        const rest = buf.slice(idx + marker.length);
        const m = /^(-?\d+)/.exec(rest);
        if (!m) return;
        clearTimeout(timer);
        this.termTaps.delete(listener);
        const exitCode = Number.parseInt(m[1], 10);
        // body = echo of the sent text + command output (up to the marker).
        // Strip the echoed send verbatim when it matches; else drop the
        // first line (wrapped echoes lose exact match).
        let body = stripAnsi(buf.slice(0, idx)).replace(/\r\n/g, "\n");
        const sentNorm = sentText.replace(/\r\n/g, "\n").trimEnd();
        if (body.startsWith(sentNorm)) body = body.slice(sentNorm.length);
        else {
          const nl = body.indexOf("\n");
          body = nl >= 0 ? body.slice(nl + 1) : "";
        }
        resolve({ output: body.replace(/^\n+|\n+$/g, ""), exitCode });
      };
      const timer = setTimeout(() => {
        this.termTaps.delete(listener);
        reject(
          new SurfaceError(
            "internal",
            `terminal_run timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.termTaps.add(listener);
      try {
        this.pty?.write(sentText);
      } catch (e) {
        clearTimeout(timer);
        this.termTaps.delete(listener);
        reject(e);
      }
    });
  }

  terminalWrite(p: { data: string }) {
    return this.tracked("terminal_write", "", () => {
      this.pty?.write(p.data);
      return { ok: true as const };
    });
  }
  terminalRead(p: { tailBytes?: number }) {
    return this.tracked("terminal_read", "", () => {
      const tail = concatTail(this.tail);
      const start =
        p.tailBytes && tail.length > p.tailBytes
          ? tail.length - p.tailBytes
          : 0;
      return {
        output: new TextDecoder().decode(tail.slice(start)),
      };
    });
  }

  previewsList() {
    return this.tracked("previews_list", "", () => ({
      previews: this.scanner.list(),
    }));
  }

  /* ------------------------------ app ops ----------------------------------- */

  appPostMessage(p: { text: string }) {
    return this.tracked("app_post_message", p.text.slice(0, 60), async () => {
      if (!this.appOps)
        throw new SurfaceError(
          "unavailable",
          "no conversation is bound to this session",
        );
      return { message: await this.appOps.postMessage(p.text) };
    });
  }
  appReadConversation(p: { afterSeq?: number }) {
    return this.tracked("app_read_conversation", "", async () => {
      if (!this.appOps)
        throw new SurfaceError(
          "unavailable",
          "no conversation is bound to this session",
        );
      return { messages: await this.appOps.readConversation(p.afterSeq) };
    });
  }

  /* ------------------------------ viewer input ------------------------------ */

  terminalInput(data: string) {
    this.pty?.write(data);
  }
  terminalResize(cols: number, rows: number) {
    this.pty?.resize(cols, rows);
  }
  browserInput(evt: ViewerBrowserInputEvent) {
    void this.browser?.input(evt);
  }
  browserNavigate(url: string) {
    void this.requireBrowser().then((b) => b.navigate(url));
  }

  /* ------------------------------ teardown ---------------------------------- */

  async close() {
    this.closed = true;
    this.listeners.clear();
    this.pty?.kill();
    await this.browser?.close();
  }
}

function concatTail(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
