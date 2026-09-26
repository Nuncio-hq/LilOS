import type { ViewerBrowserInputEvent } from "@lilos/contracts/harness";
import type { BrowserDriver } from "@lilos/surfaces";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright";

/**
 * The harness-owned browser (issue #36, AC-1/AC-4): one headless Chromium
 * page per session surface, driven two ways — Playwright locator APIs for the
 * agent's selector tools, raw CDP `Input.dispatch*` + screencast for viewer
 * takeover (spike #24's recipe, adapted to the BrowserDriver contract).
 */
const VIEWPORT = { width: 1280, height: 800 };
const JPEG_QUALITY = 60;

interface CdpSession {
  send(method: string, params?: unknown): Promise<unknown>;
  on(event: string, fn: (params: never) => void): void;
}

const SPECIAL_KEYS: Record<string, { code: string; vk: number }> = {
  Enter: { code: "Enter", vk: 13 },
  Backspace: { code: "Backspace", vk: 8 },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  Delete: { code: "Delete", vk: 46 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
};

export class ChromiumBrowser implements BrowserDriver {
  readonly viewport = VIEWPORT;
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private cdp?: CdpSession;
  private casting = false;
  private frameCb?: (jpeg: Uint8Array) => void;
  private urlCb?: (url: string) => void;
  private starting?: Promise<void>;

  private async ensure(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    this.starting ??= (async () => {
      this.browser = await chromium.launch({ headless: true });
      this.context = await this.browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
      });
      this.page = await this.context.newPage();
      this.cdp = (await this.context.newCDPSession(
        this.page,
      )) as unknown as CdpSession;
      this.cdp.on(
        "Page.screencastFrame",
        (f: { data: string; sessionId: number }) => {
          this.frameCb?.(Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)));
          this.cdp
            ?.send("Page.screencastFrameAck", { sessionId: f.sessionId })
            .catch(() => {});
        },
      );
      this.page.on("framenavigated", () => this.urlCb?.(this.url ?? ""));
      if (this.casting) await this.startScreencast();
    })().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
    return this.page as Page;
  }

  get url(): string | null {
    const u = this.page?.url();
    return u && u !== "about:blank" ? u : null;
  }

  async open(url: string): Promise<{ url: string; title: string }> {
    const page = await this.ensure();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    return { url: page.url(), title: await page.title() };
  }

  navigate(url: string): void {
    this.open(url).catch(() => {});
  }

  async click(selector: string): Promise<void> {
    await (await this.ensure()).click(selector, { timeout: 8_000 });
  }

  async type(text: string, selector?: string): Promise<void> {
    const page = await this.ensure();
    if (selector) {
      await page.click(selector, { timeout: 8_000 });
      await page.fill(selector, "");
    }
    await page.keyboard.type(text);
  }

  async read(): Promise<{ url: string; title: string; text: string }> {
    const page = await this.ensure();
    const text: string = await page.evaluate(
      "document.body?.innerText?.slice(0, 4000) ?? ''",
    );
    return { url: page.url(), title: await page.title(), text };
  }

  async scroll(dy: number): Promise<void> {
    const page = await this.ensure();
    await page.mouse.wheel(0, dy);
  }

  async evaluate(expression: string): Promise<unknown> {
    const page = await this.ensure();
    return page.evaluate(expression);
  }

  input(evt: ViewerBrowserInputEvent): void {
    const cdp = this.cdp;
    if (!cdp) return;
    switch (evt.kind) {
      case "mouse": {
        const type =
          evt.event === "down"
            ? "mousePressed"
            : evt.event === "up"
              ? "mouseReleased"
              : "mouseMoved";
        cdp
          .send("Input.dispatchMouseEvent", {
            type,
            x: evt.x,
            y: evt.y,
            button: evt.button ?? "left",
            clickCount: evt.event === "move" ? 0 : 1,
          })
          .catch(() => {});
        break;
      }
      case "wheel":
        cdp
          .send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: evt.x,
            y: evt.y,
            deltaX: evt.dx,
            deltaY: evt.dy,
          })
          .catch(() => {});
        break;
      case "key":
        this.dispatchKey(evt).catch(() => {});
        break;
    }
  }

  private async dispatchKey(evt: {
    event: "down" | "up";
    key: string;
    text?: string;
  }): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;
    if (evt.event === "down" && evt.text) {
      await cdp.send("Input.insertText", { text: evt.text });
      return;
    }
    const spec = SPECIAL_KEYS[evt.key];
    if (!spec) return;
    await cdp.send("Input.dispatchKeyEvent", {
      type: evt.event === "down" ? "rawKeyDown" : "keyUp",
      key: evt.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.vk,
    });
  }

  private async startScreencast(): Promise<void> {
    await this.cdp
      ?.send("Page.startScreencast", {
        format: "jpeg",
        quality: JPEG_QUALITY,
        everyNthFrame: 1,
      })
      .catch(() => {});
  }

  setCasting(on: boolean): void {
    if (this.casting === on) return;
    this.casting = on;
    if (!this.cdp) return; // applied when ensure() finishes
    if (on) void this.startScreencast();
    else this.cdp.send("Page.stopScreencast").catch(() => {});
  }

  onFrame(cb: (jpeg: Uint8Array) => void): void {
    this.frameCb = cb;
  }

  onUrl(cb: (url: string) => void): void {
    this.urlCb = cb;
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = this.context = this.page = this.cdp = undefined;
    this.casting = false;
  }
}
